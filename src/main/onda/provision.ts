/*
 * Onda Player - provisioning e sincronizzazione con Onda (AGPLv3, come il progetto originale).
 *
 * Il player non configurato si presenta a Onda (POST <onda>/api/player/hello) con la sua chiave
 * hardware e un segreto generato al primo avvio, e mostra il codice di 6 caratteri ricevuto.
 * Quando in Onda qualcuno inserisce il codice, la risposta contiene indirizzo e chiave del motore,
 * nome, monitor, schermata di attesa e hash del PIN. Poi il player continua a presentarsi ogni
 * pochi minuti e applica le modifiche fatte dal pannello.
 *
 * File nella cartella dati del player:
 *   onda.json            impostazioni (onda_url, display, splash, pin_hash): le scrive anche l'installer
 *   onda/identity.json   segreto del dispositivo (non si copia su altri dispositivi)
 *   onda/splash.<ext>    logo del cliente per la schermata di attesa
 */
import { app, BrowserWindow, ipcMain, powerMonitor, screen } from 'electron';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { dataDir, orderedDisplays } from './onda';

type OndaSettings = {
  onda_url?: string; display?: string | number; splash?: 'onda' | 'client' | 'black'; pin_hash?: string;
  tenant?: string;
};

let hardwareKey = '';
let lastStatus: any = { status: 'unknown' };
let syncTimer: NodeJS.Timeout | null = null;
let allowQuit = false;
let onDisplayChange: (() => void) | null = null;

const settingsFile = () => join(dataDir(), 'onda.json');
const identityFile = () => join(dataDir(), 'onda', 'identity.json');

export function readSettings(): OndaSettings {
  try {
    return existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), 'utf-8')) : {};
  } catch {
    return {};
  }
}

function writeSettings(patch: OndaSettings) {
  const merged = { ...readSettings(), ...patch };
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(merged, null, 2));
}

function secret(): string {
  try {
    if (existsSync(identityFile())) {
      const s = JSON.parse(readFileSync(identityFile(), 'utf-8')).secret;
      if (typeof s === 'string' && s.length >= 32) {
        return s;
      }
    }
  } catch { /* rigenerato sotto */ }
  const s = randomBytes(32).toString('hex');
  mkdirSync(join(dataDir(), 'onda'), { recursive: true });
  writeFileSync(identityFile(), JSON.stringify({ secret: s }), { mode: 0o600 });
  return s;
}

export function ondaUrl(): string {
  return (process.env.ONDA_URL || readSettings().onda_url || '').replace(/\/+$/, '');
}

export function splashMode(): string {
  return readSettings().splash || 'onda';
}

/** Con il player configurato da Onda il layout predefinito del motore (logo Xibo) non va mai in onda. */
export function managedByOnda(): boolean {
  return !!ondaUrl();
}

export function pinRequired(): boolean {
  return !!readSettings().pin_hash;
}

export function checkPin(pin: string): boolean {
  const stored = readSettings().pin_hash || '';
  const [algo, salt, hex] = stored.split('$');
  if (algo !== 'sha256' || !salt || !hex) {
    return true;            // nessun PIN impostato
  }
  const got = createHash('sha256').update(salt + `${pin}`).digest();
  const want = Buffer.from(hex, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

async function downloadSplash(base: string) {
  const target = join(dataDir(), 'onda', 'splash.png');
  try {
    const res = await fetch(`${base}/api/player/splash?hk=${encodeURIComponent(hardwareKey)}&secret=${encodeURIComponent(secret())}`);
    if (!res.ok) {
      if (res.status === 404 && existsSync(target)) {
        unlinkSync(target);
      }
      return;
    }
    mkdirSync(join(dataDir(), 'onda'), { recursive: true });
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.warn('[ONDA] Logo del cliente non scaricato', e);
  }
}

/** Un contatto con Onda. Ritorna lo stato per la schermata del player. */
export async function hello(): Promise<any> {
  const base = ondaUrl();
  if (!base) {
    lastStatus = { status: 'no-url' };
    return lastStatus;
  }
  const displays = orderedDisplays().map((d, i) => ({
    index: i + 1, label: `${(d as any).label || d.id}`, width: d.size.width, height: d.size.height,
  }));
  try {
    const res = await fetch(`${base}/api/player/hello`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hardware_key: hardwareKey, secret: secret(), platform: process.platform,
        version: `${app.getVersion()}-onda`, hostname: hostname(), displays,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastStatus = { status: 'error', error: body.error || `Onda ha risposto ${res.status}`, url: base };
      return lastStatus;
    }
    lastStatus = { ...body, url: base };
    if (body.status === 'configured' && body.config) {
      const before = readSettings();
      const c = body.config;
      writeSettings({ display: c.display || '', splash: c.splash || 'onda', pin_hash: c.pin_hash || '', tenant: c.tenant || '' });
      if (c.splash === 'client') {
        await downloadSplash(base);
      }
      if (`${before.display || ''}` !== `${c.display || ''}` && onDisplayChange) {
        onDisplayChange();
      }
    }
    return lastStatus;
  } catch (e: any) {
    lastStatus = { status: 'error', error: `Onda non raggiungibile (${base}): ${e?.message || e}`, url: base };
    return lastStatus;
  }
}

/** Sincronizzazione periodica delle impostazioni dopo la configurazione. */
function scheduleSync(seconds: number) {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(async () => {
    const r = await hello();
    scheduleSync(r?.poll_seconds || 300);
  }, Math.max(10, seconds) * 1000);
}

/** Numero grande su ogni monitor per riconoscerli. */
function identify() {
  orderedDisplays().forEach((d, i) => {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false,
      transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true,
      webPreferences: { sandbox: true },
    });
    const html = `<html><body style="margin:0;display:grid;place-items:center;height:100vh;background:rgba(23,22,27,.75);
      font:700 30vmin system-ui;color:#C8A15A">${i + 1}</body></html>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    setTimeout(() => !w.isDestroyed() && w.close(), 5000);
  });
}

export function initOnda(opts: { hardwareKey: string; configured: boolean; reapplyDisplay: () => void }) {
  hardwareKey = opts.hardwareKey;
  onDisplayChange = opts.reapplyDisplay;
  if (opts.configured && ondaUrl()) {
    scheduleSync(20);
  }
  ipcMain.handle('onda-status', () => ({ ...lastStatus, url: ondaUrl(), pin: pinRequired(),
    displays: orderedDisplays().length, hardwareKey }));
  ipcMain.handle('onda-hello', async () => {
    const r = await hello();
    if (r.status === 'configured') {
      scheduleSync(r.poll_seconds || 300);
    }
    return r;
  });
  ipcMain.handle('onda-set-url', (_e, url: string) => {
    const clean = `${url || ''}`.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(clean)) {
      return { ok: false, error: "Scrivi l'indirizzo completo, per esempio http://192.168.1.10:8080" };
    }
    writeSettings({ onda_url: clean });
    return { ok: true };
  });
  ipcMain.handle('onda-check-pin', (_e, pin: string) => checkPin(pin));
  ipcMain.handle('onda-pin-required', () => pinRequired());
  ipcMain.handle('onda-identify', () => identify());
  ipcMain.handle('onda-quit', (_e, pin: string) => {
    if (!checkPin(pin)) {
      return false;
    }
    allowQuit = true;
    app.quit();
    return true;
  });
  // spegnimento del sistema: il player si chiude senza PIN
  powerMonitor.on('shutdown', () => { allowQuit = true; });
  app.on('before-quit', () => { /* app.quit() chiamato da noi o dal sistema */ });
  screen.on('display-added', () => { void hello(); });
}

/** Da chiamare sulla finestra principale: con un PIN impostato non si chiude con Alt+F4. */
export function guardWindow(win: BrowserWindow) {
  win.on('close', (e) => {
    if (pinRequired() && !allowQuit) {
      console.log('[ONDA] Chiusura bloccata: serve il PIN (pannello di configurazione › Chiudi il player)');
      e.preventDefault();
    }
  });
  (win as any).on('session-end', () => { allowQuit = true; });     // Windows: disconnessione o spegnimento
}
