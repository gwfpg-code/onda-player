/*
 * Copyright (c) 2026 Xibo Signage Ltd
 *
 * Xibo - Digital Signage - https://xibosignage.com
 *
 * This file is part of Xibo.
 *
 * Xibo is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.
 *
 * Xibo is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Xibo.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Replacement for the legacy 1.8 player's external watchdog process
 * (`xibo-linux/player/watchdog/ProcessWatcher.cpp`), which restarted the player binary
 * whenever it exited. Devices refreshing from that snap would otherwise lose
 * restart-on-crash, so this restores equivalent behaviour in-process.
 */
import { app, BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';

import { getPlayerDataDir, isSnap } from './paths';

/** Give up relaunching if we exceed this many restarts inside the window below. */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

/** How long an unresponsive renderer has to recover before the player is restarted. */
const UNRESPONSIVE_GRACE_MS = 30 * 1000;

const RESTART_LOG_FILE = 'watchdog-restarts.json';

// Onda: se i riavvii del player non bastano, riavvio del computer (se l'impostazione lo consente), al massimo una
// volta all'ora. L'ora dell'ultimo riavvio sta in watchdog-reboot.json.
const REBOOT_LOG_FILE = 'watchdog-reboot.json';
const REBOOT_MIN_INTERVAL_MS = 60 * 60 * 1000;
let rebootAllowed: () => boolean = () => false;

export function setRebootPolicy(fn: () => boolean): void {
  rebootAllowed = fn;
}

function rebootLogPath(): string {
  return join(getPlayerDataDir(app.getPath('userData')), REBOOT_LOG_FILE);
}

/** Ora (ISO) dell'ultimo riavvio del computer chiesto dal player, o ''. */
export function lastReboot(): string {
  try {
    return `${JSON.parse(readFileSync(rebootLogPath(), 'utf-8')).at || ''}`;
  } catch {
    return '';
  }
}

/** Riavvii del player negli ultimi 10 minuti (per la scheda dello schermo in Onda). */
export function recentRestarts(): number {
  return readRecentRestarts().length;
}

function rebootComputer(reason: string): boolean {
  const last = Date.parse(lastReboot() || '');
  if (!rebootAllowed() || (!isNaN(last) && Date.now() - last < REBOOT_MIN_INTERVAL_MS)) {
    return false;
  }
  try {
    writeFileSync(rebootLogPath(), JSON.stringify({ at: new Date().toISOString(), reason }));
  } catch (err) {
    console.error('[Watchdog] Failed to record reboot:', err);
  }
  console.error(`[Watchdog] ${reason}: i riavvii del player non bastano, riavvio il computer`);
  const [cmd, args] = process.platform === 'win32'
    ? ['shutdown', ['/r', '/t', '30', '/c', 'Onda Player: riavvio dopo blocchi ripetuti']]
    : ['systemctl', ['reboot']];
  execFile(cmd as string, args as string[], (err) => {
    if (err) {
      console.error(`[Watchdog] Riavvio del computer non riuscito (${cmd}): ${err.message}`);
    }
  });
  return true;
}

const AUTOSTART_ENTRY = `[Desktop Entry]
Type=Application
Name=Onda Player
Comment=Onda Digital Signage Player
Exec=onda-player
Terminal=false
X-GNOME-Autostart-enabled=true
`;

function restartLogPath(): string {
  return join(getPlayerDataDir(app.getPath('userData')), RESTART_LOG_FILE);
}

/** Recent restart timestamps, pruned to the rolling window. */
function readRecentRestarts(): number[] {
  try {
    const raw = readFileSync(restartLogPath(), 'utf-8');
    const cutoff = Date.now() - RESTART_WINDOW_MS;
    return (JSON.parse(raw) as number[]).filter((ts) => ts > cutoff);
  } catch {
    return [];
  }
}

function recordRestart(timestamps: number[]): void {
  try {
    writeFileSync(restartLogPath(), JSON.stringify([...timestamps, Date.now()]));
  } catch (err) {
    console.error('[Watchdog] Failed to record restart:', err);
  }
}

// A relaunch waiting for the restart limit to clear, if any.
let delayedRelaunch: ReturnType<typeof setTimeout> | null = null;

/**
 * Restart the whole player process, mirroring what the legacy watchdog did.
 *
 * A renderer crash leaves the main process holding stale playback state, so a clean
 * relaunch is more predictable than reloading the renderer in place (and avoids
 * re-registering the IPC handlers that `init()` sets up once per process).
 */
export function relaunchPlayer(reason: string): void {
  const recent = readRecentRestarts();

  if (recent.length >= MAX_RESTARTS) {
    // Onda: prima di aspettare, il riavvio del computer (se consentito e non già fatto nell'ultima ora)
    if (rebootComputer(reason)) {
      return;
    }
    // Stopping for good would leave the screen blank until someone restarts the player, so
    // wait until the oldest restart leaves the window and try again then.
    if (delayedRelaunch !== null) {
      return;
    }

    const delay = Math.max(Math.min(...recent) + RESTART_WINDOW_MS - Date.now(), 0) + 1000;

    console.error(
      `[Watchdog] ${reason}, but ${recent.length} restarts already occurred in the last ` +
      `${RESTART_WINDOW_MS / 60000} minutes. Restarting again in ${Math.round(delay / 1000)} seconds.`,
    );

    delayedRelaunch = setTimeout(() => {
      delayedRelaunch = null;
      relaunchPlayer(reason);
    }, delay);
    return;
  }

  console.error(`[Watchdog] ${reason}. Restarting player (restart ${recent.length + 1}/${MAX_RESTARTS}).`);

  recordRestart(recent);
  app.relaunch();
  app.exit(0);
}

let childProcessHandlerAttached = false;

/**
 * Watch the given window for renderer failures and restart the player when one occurs.
 *
 * Safe to call for each window created — the app-level listener is only attached once.
 */
export function installCrashRecovery(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    relaunchPlayer(`Renderer process gone (reason: ${details.reason}, exitCode: ${details.exitCode})`);
  });

  // A renderer can stall for a while (a large layout loading, for example) and recover on its
  // own, so only restart if it is still unresponsive after a grace period.
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;

  win.on('unresponsive', () => {
    if (unresponsiveTimer !== null) {
      return;
    }

    console.warn(`[Watchdog] Renderer became unresponsive, restarting in ${UNRESPONSIVE_GRACE_MS / 1000} seconds unless it recovers`);
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      relaunchPlayer(`Renderer stayed unresponsive for ${UNRESPONSIVE_GRACE_MS / 1000} seconds`);
    }, UNRESPONSIVE_GRACE_MS);
  });

  win.on('responsive', () => {
    if (unresponsiveTimer !== null) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
      console.warn('[Watchdog] Renderer recovered, not restarting');
    }
  });

  if (childProcessHandlerAttached) return;
  childProcessHandlerAttached = true;

  app.on('child-process-gone', (_event, details) => {
    // GPU/utility processes are restarted by Chromium on its own; only a lost renderer
    // actually stops playback.
    if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
    console.warn(`[Watchdog] GPU process gone (reason: ${details.reason}); Chromium will recover it.`);
  });
}

/**
 * Start the player automatically when the desktop session logs in, replacing the autostart
 * the legacy snap got from its `xibo-player.desktop` entry.
 *
 * Under snap confinement the real ~/.config is not writable, so the entry goes in
 * SNAP_USER_DATA, which snapd's user session agent scans for autostart entries.
 */
function linuxAutostartPath(): string {
  const base = isSnap() ? (process.env.SNAP_USER_DATA as string) : homedir();
  return join(base, '.config', 'autostart', 'onda-player.desktop');
}

function ensureLinuxAutostartEntry(enabled: boolean): void {
  try {
    const entryPath = linuxAutostartPath();
    const autostartDir = join(entryPath, '..');

    if (!enabled) {
      if (existsSync(entryPath)) {
        unlinkSync(entryPath);
        console.log(`[Watchdog] Removed autostart entry ${entryPath}`);
      }
      return;
    }
    if (existsSync(entryPath)) return;

    mkdirSync(autostartDir, { recursive: true });
    writeFileSync(entryPath, AUTOSTART_ENTRY);

    console.log(`[Watchdog] Wrote autostart entry to ${entryPath}`);
  } catch (err) {
    console.error('[Watchdog] Failed to write autostart entry:', err);
  }
}

/**
 * Start the player automatically when the user logs in, replacing whatever autostart mechanism
 * (Startup shortcut, Run key, or a legacy watchdog service) the legacy Windows player used.
 *
 * `setLoginItemSettings` is Electron's cross-platform wrapper for the `HKCU\...\Run` registry
 * key on Windows — no manual registry or shortcut handling needed.
 */
function ensureWindowsAutostartEntry(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
    console.log(`[Watchdog] Login item for autostart ${enabled ? 'configured' : 'removed'}`);
  } catch (err) {
    console.error('[Watchdog] Failed to configure autostart:', err);
  }
}

/**
 * Start the player automatically when the desktop session logs in. Dispatches to the
 * platform-appropriate mechanism — Windows and Linux have no autostart primitive in common.
 */
export function ensureAutostartEntry(enabled = true): void {
  if (process.platform === 'win32') {
    ensureWindowsAutostartEntry(enabled);
    return;
  }

  ensureLinuxAutostartEntry(enabled);
}

/** Il sistema avvierà davvero il player all'accesso? (Windows: anche se disattivato in "App di avvio") */
export function autostartRegistered(): boolean {
  try {
    if (process.platform === 'win32') {
      const st: any = app.getLoginItemSettings();
      return !!(st.executableWillLaunchAtLogin ?? st.openAtLogin);
    }
    return existsSync(linuxAutostartPath());
  } catch {
    return false;
  }
}
