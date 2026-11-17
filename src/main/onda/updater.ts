/*
 * Onda Player - aggiornamento automatico (AGPLv3, come il progetto originale).
 *
 * Il player non ha i permessi per installare: scarica l'aggiornamento che Onda gli propone nell'hello (config.update,
 * firmato da Onda) e lo lascia nella cartella di attesa, dove lo prende l'aggiornatore che gira come amministratore
 * (resources/updater/: attività pianificata di SYSTEM su Windows, unità systemd di root su Linux), creato
 * dall'installer scaricato da Onda insieme alla chiave pubblica. L'aggiornatore verifica firma e impronta, installa e
 * scrive status.json; il player riferisce l'esito a Onda nell'hello successivo.
 *   Windows: %ProgramData%\Onda Player\update — l'aggiornatore chiude il player e lo riavvia nella sessione dell'utente.
 *   Linux:   /var/lib/onda-player/update      — il player resta acceso e si riavvia da solo a installazione finita.
 */
import { app } from 'electron';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export type UpdateOffer = { version: string; kind: 'msi' | 'deb'; size: number; sha256: string; manifest: string; signature: string };
type Report = { version: string; state: string; detail?: string };

let working: string | null = null;            // versione in download o in attesa
let report: Report | null = null;             // esito del player (download), finché l'aggiornatore non scrive il suo
let linuxWatch: NodeJS.Timeout | null = null;
let hasUpdaterCache: boolean | null = null;

export function stageDir(): string {
  return process.platform === 'win32'
    ? join(process.env.ProgramData || 'C:\\ProgramData', 'Onda Player', 'update')
    : '/var/lib/onda-player/update';
}

/** L'installer di Onda ha messo la chiave pubblica (e quindi l'aggiornatore)? Solo allora il player lo dice a Onda. */
export function hasUpdater(): boolean {
  if (hasUpdaterCache !== null) {
    return hasUpdaterCache;
  }
  let ok = false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Onda\\Onda Player', '/v', 'UpdateKey'],
        { encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      ok = /UpdateKey\s+REG_SZ\s+<RSAKeyValue>/.test(out);
    } else if (process.platform === 'linux') {
      ok = existsSync('/etc/onda-player/update.pem') && existsSync(stageDir());
    }
  } catch {
    ok = false;
  }
  hasUpdaterCache = ok;
  return ok;
}

function readStatus(): Report | null {
  try {
    const s = JSON.parse(readFileSync(join(stageDir(), 'status.json'), 'utf-8'));
    return s && typeof s.state === 'string' ? { version: `${s.version || ''}`, state: s.state, detail: `${s.detail || ''}` } : null;
  } catch {
    return null;
  }
}

/** Esito da riferire a Onda nell'hello: quello dell'aggiornatore se riguarda la versione in corso, se no il mio. */
export function updateReport(): Report | undefined {
  const st = readStatus();
  if (st && (!report || st.version === report.version)) {
    return st;
  }
  return report || st || undefined;
}

function staged(version: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(stageDir(), 'manifest.json'), 'utf-8'));
    return m.version === version;
  } catch {
    return false;
  }
}

/** Aggiornamento proposto da Onda: lo scarico, lo controllo e lo lascio all'aggiornatore. */
export async function handleOffer(base: string, headers: Record<string, string>, offer: UpdateOffer | undefined) {
  if (!offer || !hasUpdater() || working === offer.version) {
    return;
  }
  const ext = process.platform === 'win32' ? 'msi' : 'deb';
  if (offer.kind !== ext || !/^[0-9a-f]{64}$/.test(offer.sha256) || !offer.manifest || !offer.signature) {
    return;
  }
  const st = readStatus();
  if (staged(offer.version) || (st && st.version === offer.version && st.state === 'installing')) {
    working = offer.version;
    return;
  }
  working = offer.version;
  report = { version: offer.version, state: 'downloading' };
  const dir = stageDir();
  const part = join(dir, `package.${ext}.part`);
  try {
    mkdirSync(dir, { recursive: true });
    console.log(`[ONDA] Aggiornamento ${offer.version}: scarico ${Math.round(offer.size / 1048576)} MB`);
    const res = await fetch(`${base}/api/player/update/file`, { headers, signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok || !res.body) {
      throw new Error(`Onda ha risposto ${res.status}`);
    }
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(part));
    const h = createHash('sha256');
    await pipeline((await import('fs')).createReadStream(part), h);
    if (statSync(part).size !== offer.size || h.digest('hex') !== offer.sha256) {
      throw new Error('file scaricato diverso da quello annunciato');
    }
    // l'aggiornatore parte quando c'è manifest.json: lo scrivo per ultimo
    for (const f of ['manifest.json', 'status.json']) {
      try { unlinkSync(join(dir, f)); } catch { /* non c'era */ }
    }
    renameSync(part, join(dir, `package.${ext}`));
    writeFileSync(join(dir, 'manifest.sig'), offer.signature);
    writeFileSync(join(dir, 'manifest.json.tmp'), offer.manifest);
    renameSync(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
    report = { version: offer.version, state: 'staged' };
    console.log(`[ONDA] Aggiornamento ${offer.version} pronto: lo installa l'aggiornatore`);
    if (process.platform === 'linux') {
      watchLinux(offer.version);
    }
  } catch (e: any) {
    try { unlinkSync(part); } catch { /* già tolto */ }
    report = { version: offer.version, state: 'failed', detail: `download: ${e?.message || e}`.slice(0, 200) };
    working = null;
    console.warn(`[ONDA] Aggiornamento ${offer.version} non scaricato: ${e?.message || e}`);
  }
}

/** Linux: l'installazione non chiude il player, che si riavvia da solo (nella nuova versione) quando è finita. */
function watchLinux(version: string) {
  if (linuxWatch) {
    clearInterval(linuxWatch);
  }
  const started = Date.now();
  linuxWatch = setInterval(() => {
    const st = readStatus();
    if (st && st.version === version && (st.state === 'installed' || st.state === 'failed')) {
      clearInterval(linuxWatch!);
      linuxWatch = null;
      working = null;
      if (st.state === 'installed') {
        console.log(`[ONDA] Aggiornamento ${version} installato: riavvio il player`);
        app.relaunch();
        app.exit(0);
      }
    } else if (Date.now() - started > 60 * 60 * 1000) {
      clearInterval(linuxWatch!);
      linuxWatch = null;
      working = null;
    }
  }, 10000);
}
