/*
 * Onda Player - accensione e spegnimento del monitor (AGPLv3, come il progetto originale).
 *
 * Windows: SC_MONITORPOWER via PostMessage a tutte le finestre (PostMessage non si blocca se una finestra
 *          non risponde, SendMessage sì). Per riaccendere: SC_MONITORPOWER -1 più un piccolo movimento
 *          del mouse, perché sui Windows recenti il solo messaggio spesso non basta.
 * Linux:   X11 con `xset dpms force off|on` (nello snap: pacchetto x11-xserver-utils). Wayland non ha un
 *          metodo standard: lo spegnimento non viene offerto e Onda usa lo schermo nero.
 * Il monitor in standby si riaccende quando torna il segnale solo se il modello lo fa: va provato su
 * ogni monitor. Lo schermo nero pubblicato da Onda fuori orario resta comunque come rete di sicurezza.
 */
import { powerSaveBlocker } from 'electron';
import { execFile } from 'child_process';

export type PowerResult = { ok: boolean; method: string; error?: string };

let blockerId: number | null = null;

/** Impedisce (true) o permette (false) che il sistema spenga lo schermo o avvii il salvaschermo. */
export function keepDisplayAwake(on: boolean) {
  if (on && (blockerId === null || !powerSaveBlocker.isStarted(blockerId))) {
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!on && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
    }
    blockerId = null;
  }
}

function linuxX11(): boolean {
  return process.platform === 'linux' && !!process.env.DISPLAY;
}

/** Il player sa spegnere il monitor su questo sistema? (lo comunica a Onda: "monitor spento" o "schermo nero") */
export function supported(): boolean {
  return process.platform === 'win32' || linuxX11();
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, _out, stderr) => {
      if (err) {
        reject(new Error(`${cmd}: ${`${stderr || ''}`.trim() || err.message}`.slice(0, 300)));
      } else {
        resolve();
      }
    });
  });
}

const WIN_API = "Add-Type -Namespace Onda -Name Mon -MemberDefinition '" +
  '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);' +
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, System.UIntPtr e);' +
  "';";
// HWND_BROADCAST = 0xFFFF, WM_SYSCOMMAND = 0x0112, SC_MONITORPOWER = 0xF170; lParam 2 = spento, -1 = acceso
const WIN_OFF = WIN_API + '[void][Onda.Mon]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2)';
const WIN_ON = WIN_API + '[void][Onda.Mon]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr](-1));' +
  '[Onda.Mon]::mouse_event(1, 0, 1, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100;' +
  '[Onda.Mon]::mouse_event(1, 0, -1, 0, [UIntPtr]::Zero)';

/** Script codificato (UTF-16LE base64): niente problemi di virgolette sulla riga di comando di Windows. */
function powershell(script: string): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
}

export async function monitorOff(): Promise<PowerResult> {
  keepDisplayAwake(false);
  try {
    if (process.platform === 'win32') {
      await powershell(WIN_OFF);
      return { ok: true, method: 'windows' };
    }
    if (linuxX11()) {
      await run('xset', ['+dpms']);
      await run('xset', ['dpms', 'force', 'off']);
      return { ok: true, method: 'x11' };
    }
    return { ok: false, method: 'none', error: 'sistema senza un metodo per spegnere il monitor (Wayland?)' };
  } catch (e: any) {
    return { ok: false, method: process.platform === 'win32' ? 'windows' : 'x11', error: `${e?.message || e}` };
  }
}

export async function monitorOn(): Promise<PowerResult> {
  keepDisplayAwake(true);
  try {
    if (process.platform === 'win32') {
      await powershell(WIN_ON);
      return { ok: true, method: 'windows' };
    }
    if (linuxX11()) {
      await run('xset', ['dpms', 'force', 'on']);
      await run('xset', ['s', 'reset']);
      return { ok: true, method: 'x11' };
    }
    return { ok: true, method: 'none' };
  } catch (e: any) {
    return { ok: false, method: process.platform === 'win32' ? 'windows' : 'x11', error: `${e?.message || e}` };
  }
}
