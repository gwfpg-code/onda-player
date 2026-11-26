/*
 * Onda Player - controllo remoto dalla console di Onda (AGPLv3, come il progetto originale).
 *
 * Su richiesta di Onda (messaggio {"type": "remote", "action": "start"} sul collegamento degli eventi, oppure campo
 * "remote" nella risposta all'hello) il player:
 * 1. avvia un server VNC che ascolta **solo su 127.0.0.1**, su una porta libera, con la password della sessione:
 *    - Windows: TightVNC (tvnserver.exe -run, in resources/vnc, GPLv2), impostazioni in HKCU\Software\TightVNC\Server;
 *    - Linux (X11): x11vnc (pacchetto di sistema, dipendenza del .deb), -localhost, password in un file che x11vnc
 *      cancella appena letto;
 * 2. apre lui un collegamento verso Onda (<onda>/api/player/remote/<sessione>, WebSocket) e si presenta con chiave
 *    hardware, segreto e gettone della sessione: nella sede non va aperta nessuna porta;
 * 3. quando la console arriva (Onda manda {"type": "open"}) si collega al server VNC locale e porta i byte nei due
 *    sensi; Onda li porta alla pagina della console (noVNC);
 * 4. a fine sessione (la console chiude, Onda manda "stop", durata massima) chiude tutto e ferma il server VNC.
 *
 * Il server VNC gira solo durante una sessione. Registro del player: righe "[ONDA] Controllo remoto: …".
 */
import { app } from 'electron';
import { spawn, execFile, ChildProcess } from 'child_process';
import { existsSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'fs';
import { createServer, connect as tcpConnect, Socket } from 'net';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import { deviceIdentity, ondaUrl } from './provision';

type Request = { session: string; token: string; password: string; password_vnc: string; view_only: boolean;
  ws_path: string; max_minutes?: number };

type Session = { id: string; server: ChildProcess | null; ws: any; tcp: Socket | null; timer: NodeJS.Timeout | null;
  cleanup: Array<() => void>; ended: boolean };

const START_WAIT_MS = 15 * 1000;     // il server VNC deve accettare collegamenti entro tanto
let current: Session | null = null;

// --------------------------------------------------------------------------
// Server VNC disponibile su questo sistema?
// --------------------------------------------------------------------------
function tightvnc(): string {
  return join(process.resourcesPath || '', 'vnc', 'tvnserver.exe');
}

function which(cmd: string): string {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const p = join(dir, cmd);
    if (dir && existsSync(p)) {
      return p;
    }
  }
  for (const p of [`/usr/bin/${cmd}`, process.env.SNAP ? join(process.env.SNAP, 'usr', 'bin', cmd) : '']) {
    if (p && existsSync(p)) {
      return p;
    }
  }
  return '';
}

/** Il controllo remoto è possibile qui? (lo dice a Onda con la capacità "remote") */
export function remoteAvailable(): boolean {
  if (process.platform === 'win32') {
    return existsSync(tightvnc());
  }
  // x11vnc legge lo schermo X11 (anche XWayland, ma lì vede solo le finestre X11, come il player)
  return process.platform === 'linux' && !!process.env.DISPLAY && !!which('x11vnc');
}

// --------------------------------------------------------------------------
// Messaggi da Onda
// --------------------------------------------------------------------------
export function handleRemote(msg: any) {
  if (!msg || typeof msg !== 'object') {
    return;
  }
  if (msg.action === 'stop') {
    if (current && (!msg.session || msg.session === current.id)) {
      end(current, 'chiusa da Onda');
    }
    return;
  }
  if (msg.action !== 'start' || typeof msg.session !== 'string' || typeof msg.ws_path !== 'string') {
    return;
  }
  if (current && current.id === msg.session && !current.ended) {
    return;                            // la stessa richiesta arriva anche con l'hello successivo
  }
  if (current) {
    end(current, 'sostituita da una nuova sessione');
  }
  void start(msg as Request);
}

async function start(req: Request) {
  const s: Session = { id: req.session, server: null, ws: null, tcp: null, timer: null, cleanup: [], ended: false };
  current = s;
  console.log(`[ONDA] Controllo remoto: richiesta dalla console (sessione ${req.session.slice(0, 8)}` +
    `${req.view_only ? ', solo visione' : ''})`);
  s.timer = setTimeout(() => end(s, 'durata massima'), ((req.max_minutes || 60) + 1) * 60 * 1000);
  let port = 0;
  try {
    if (!remoteAvailable()) {
      throw new Error(process.platform === 'win32' ? 'server VNC non installato con il player'
        : 'x11vnc non installato o sessione grafica non X11');
    }
    port = await freePort();
    s.server = process.platform === 'win32' ? await startTightVnc(s, req, port) : startX11vnc(s, req, port);
    await waitPort(port, s);
  } catch (e: any) {
    console.warn('[ONDA] Controllo remoto: server VNC non avviato:', e?.message || e);
    await openTunnel(s, req, 0, `server VNC non avviato: ${e?.message || e}`);
    return;
  }
  await openTunnel(s, req, port, '');
}

// --------------------------------------------------------------------------
// Collegamento con Onda
// --------------------------------------------------------------------------
function wsUrl(base: string, path: string): string {
  return base.replace(/^http/, 'ws').replace(/\/+$/, '') + path;
}

async function openTunnel(s: Session, req: Request, port: number, error: string) {
  const Ws = (globalThis as any).WebSocket;
  const base = ondaUrl();
  if (!Ws || !base || s.ended) {
    end(s, 'Onda non raggiungibile');
    return;
  }
  const sock = new Ws(wsUrl(base, req.ws_path));
  sock.binaryType = 'arraybuffer';
  s.ws = sock;
  sock.onopen = () => {
    const id = deviceIdentity();
    sock.send(JSON.stringify({ type: 'hello', hardware_key: id.hardwareKey, secret: id.secret, token: req.token,
      version: app.getVersion() }));
  };
  sock.onmessage = (m: any) => {
    if (typeof m.data !== 'string') {
      if (s.tcp && !s.tcp.destroyed) {
        s.tcp.write(Buffer.from(m.data));
      }
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (msg.type === 'open') {
      if (error) {                     // la console è arrivata ma il server VNC non c'è: lo dico a Onda
        sock.send(JSON.stringify({ type: 'error', message: error }));
        setTimeout(() => end(s, error), 500);
        return;
      }
      console.log('[ONDA] Controllo remoto: console collegata');
      const tcp = tcpConnect(port, '127.0.0.1');
      s.tcp = tcp;
      tcp.on('data', (d: Buffer) => {
        if (sock.readyState === 1) {
          sock.send(d);
        }
      });
      tcp.on('close', () => end(s, 'server VNC chiuso'));
      tcp.on('error', (e) => {
        try { sock.send(JSON.stringify({ type: 'error', message: `server VNC: ${e.message}` })); } catch { /* chiuso */ }
        end(s, `server VNC: ${e.message}`);
      });
    }
  };
  sock.onclose = (e: any) => end(s, e?.reason || 'collegamento con Onda chiuso');
  sock.onerror = () => { /* segue onclose */ };
}

function end(s: Session, reason: string) {
  if (s.ended) {
    return;
  }
  s.ended = true;
  if (current === s) {
    current = null;
  }
  if (s.timer) {
    clearTimeout(s.timer);
  }
  try { s.tcp?.destroy(); } catch { /* già chiuso */ }
  try { if (s.ws && s.ws.readyState <= 1) { s.ws.close(1000); } } catch { /* già chiuso */ }
  if (s.server && s.server.exitCode === null) {
    try { s.server.kill(); } catch { /* già uscito */ }
  }
  for (const fn of s.cleanup) {
    try { fn(); } catch { /* niente */ }
  }
  console.log(`[ONDA] Controllo remoto: sessione chiusa (${reason})`);
}

// --------------------------------------------------------------------------
// Server VNC
// --------------------------------------------------------------------------
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
  });
}

function waitPort(port: number, s: Session): Promise<void> {
  const until = Date.now() + START_WAIT_MS;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (s.ended) {
        reject(new Error('sessione chiusa'));
        return;
      }
      if (s.server && s.server.exitCode !== null) {
        reject(new Error(`il server VNC si è fermato (codice ${s.server.exitCode})`));
        return;
      }
      const c = tcpConnect(port, '127.0.0.1');
      c.once('connect', () => { c.destroy(); resolve(); });
      c.once('error', () => {
        c.destroy();
        if (Date.now() > until) {
          reject(new Error('il server VNC non risponde'));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
    };
    tryOnce();
  });
}

/** Linux: x11vnc sullo schermo del player, solo 127.0.0.1, un solo collegamento, poi esce. */
function startX11vnc(s: Session, req: Request, port: number): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), 'onda-vnc-'));
  const pw = join(dir, 'pw');
  writeFileSync(pw, `${req.password}\n`, { mode: 0o600 });
  chmodSync(pw, 0o600);
  s.cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const args = ['-display', process.env.DISPLAY || ':0', '-localhost', '-rfbport', String(port),
    '-passwdfile', `rm:${pw}`,         // x11vnc cancella il file appena letto
    '-once', '-timeout', '120', '-noxdamage', '-nolookup', '-quiet', '-norc'];
  if (req.view_only) {
    args.push('-viewonly');
  }
  const child = spawn(which('x11vnc'), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let errText = '';
  child.stderr?.on('data', (d) => { errText = (errText + d.toString()).slice(-2000); });
  child.on('exit', (code) => {
    if (code && !s.ended) {
      console.warn(`[ONDA] Controllo remoto: x11vnc uscito con codice ${code}: ${errText.split('\n').slice(-3).join(' ')}`);
    }
  });
  return child;
}

function reg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 10000 }, (err) => (err ? reject(err) : resolve()));
  });
}

const TVN_KEY = 'HKCU\\Software\\TightVNC\\Server';

/** Windows: TightVNC in modalità applicazione (non servizio, niente amministratore), impostazioni nel registro
 *  dell'utente: solo 127.0.0.1, porta e password della sessione, niente pagina web, niente icona. */
async function startTightVnc(s: Session, req: Request, port: number): Promise<ChildProcess> {
  if (!/^[0-9a-f]{16}$/.test(req.password_vnc || '')) {
    throw new Error('password della sessione non valida');
  }
  const dword = (name: string, v: number) => reg(['add', TVN_KEY, '/v', name, '/t', 'REG_DWORD', '/d', String(v), '/f']);
  await dword('RfbPort', port);
  await dword('AcceptRfbConnections', 1);
  await dword('AcceptHttpConnections', 0);
  await dword('LoopbackOnly', 1);
  await dword('AllowLoopback', 1);
  await dword('UseVncAuthentication', 1);
  await dword('RunControlInterface', 0);
  await dword('QueryConnect', 0);
  await dword('RemoveWallpaper', 0);
  await dword('EnableFileTransfers', 0);
  await dword('AlwaysShared', 1);
  await dword('BlockRemoteInput', req.view_only ? 1 : 0);
  await reg(['add', TVN_KEY, '/v', 'Password', '/t', 'REG_BINARY', '/d', req.password_vnc, '/f']);
  // a fine sessione la password non resta nel registro
  s.cleanup.push(() => { void reg(['delete', TVN_KEY, '/v', 'Password', '/f']).catch(() => undefined); });
  const child = spawn(tightvnc(), ['-run'], { stdio: 'ignore', windowsHide: true });
  child.on('exit', (code) => {
    if (code && !s.ended) {
      console.warn(`[ONDA] Controllo remoto: TightVNC uscito con codice ${code}`);
    }
  });
  return child;
}

/** Alla chiusura del player non resta un server VNC acceso. */
export function stopRemote() {
  if (current) {
    end(current, 'player chiuso');
  }
}
