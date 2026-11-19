/*
 * Onda Player - stato del server interno dei contenuti (AGPLv3, come il progetto originale).
 *
 * Layout, video e pagine arrivano al renderer da http://localhost:9696. Se un altro programma tiene occupata la
 * porta (per esempio WSL, che inoltra a Windows le porte aperte dentro Linux), il player riprova ogni 10 secondi ma
 * intanto lo schermo resta grigio, perché il renderer chiede i file a quell'altro programma. Qui teniamo lo stato e
 * cerchiamo chi occupa la porta, così Onda lo può dire nella scheda dello schermo (hello › file_server).
 */
import { execFile } from 'child_process';

export type FileServerStatus = {
  ok: boolean; port: number; error?: string; owner?: string; ipv6?: string; since?: string;
};

let v4: 'pending' | 'ok' | string = 'pending';     // 'ok' o il codice d'errore (EADDRINUSE, …)
let v6: 'pending' | 'ok' | string = 'pending';
let owner = '';
let since = '';
let looking = false;
let current: FileServerStatus = { ok: true, port: 9696 };
const listeners: Array<() => void> = [];

/** Avvisami quando lo stato cambia (il provisioning manda subito un hello a Onda). */
export function onFileServerChange(fn: () => void) {
  listeners.push(fn);
}

export function fileServerStatus(): FileServerStatus {
  return current;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (_err, out) => resolve(`${out || ''}`));
  });
}

/** Nome e PID del programma in ascolto sulla porta, se il sistema ce lo dice. */
export async function findOwner(port: number): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const pids = new Set<string>();
      for (const line of (await run('netstat', ['-ano', '-p', 'TCP'])).split(/\r?\n/)
        .concat((await run('netstat', ['-ano', '-p', 'TCPv6'])).split(/\r?\n/))) {
        const f = line.trim().split(/\s+/);
        // TCP  127.0.0.1:9696  0.0.0.0:0  LISTENING  24180  (lo stato è tradotto nella lingua di Windows)
        if (f.length >= 5 && f[0].toUpperCase() === 'TCP' && f[1].endsWith(`:${port}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(f[2])) {
          pids.add(f[f.length - 1]);
        }
      }
      const pid = [...pids].find((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
      if (!pid) {
        return '';
      }
      const csv = (await run('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'])).trim();
      const name = csv.startsWith('"') ? csv.split('","')[0].replace(/^"/, '') : '';
      return name ? `${name} (PID ${pid})` : `PID ${pid}`;
    }
    if (process.platform === 'linux') {
      // users:(("node",pid=1234,fd=20)) — il nome lo vediamo solo per i processi dello stesso utente
      const out = await run('ss', ['-ltnpH', `sport = :${port}`]);
      for (const m of out.matchAll(/users:\(\("([^"]+)",pid=(\d+)/g)) {
        if (Number(m[2]) !== process.pid) {
          return `${m[1]} (PID ${m[2]})`;
        }
      }
      return out.trim() ? 'un altro programma (di un altro utente)' : '';
    }
  } catch {
    // diagnosi facoltativa: senza nome il messaggio resta comunque utile
  }
  return '';
}

function update(port: number) {
  // senza IPv6 (EADDRNOTAVAIL, EAFNOSUPPORT) basta IPv4; con ::1 occupato invece "localhost" può finire nell'altro programma
  const v6Bad = v6 === 'EADDRINUSE' || v6 === 'EACCES';
  const bad = (v4 !== 'ok' && v4 !== 'pending') || v6Bad;
  const next: FileServerStatus = bad
    ? { ok: false, port, error: v4 !== 'ok' && v4 !== 'pending' ? v4 : `IPv6 ${v6}`, owner: owner || undefined,
        ipv6: v6Bad ? v6 : undefined, since }
    : { ok: true, port };
  if (bad && !since) {
    next.since = since = new Date().toISOString();
  } else if (!bad) {
    since = '';
    owner = '';
  }
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  if (bad && !owner && !looking) {
    looking = true;
    void findOwner(port).then((o) => {
      looking = false;
      if (o && current.ok === false) {
        owner = o;
        current = { ...current, owner: o };
        listeners.forEach((fn) => fn());
      }
    });
  }
  if (changed) {
    listeners.forEach((fn) => fn());
  }
}

/** Esito di un tentativo di ascolto: family 4 (127.0.0.1) o 6 (::1), code = 'ok' o il codice d'errore. */
export function reportListen(port: number, family: 4 | 6, code: string) {
  const before = family === 4 ? v4 : v6;
  if (family === 4) {
    v4 = code;
  } else {
    v6 = code;
  }
  if (before !== code) {
    update(port);
  }
}
