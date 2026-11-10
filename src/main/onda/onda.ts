/*
 * Onda Player - personalizzazioni rispetto a Xibo Player (AGPLv3, come il progetto originale).
 *
 * 1. Monitor: su quale schermo collegato va il player. Si sceglie con
 *      - l'opzione da riga di comando  --display=2  (oppure --display="HDMI-1")
 *      - la variabile d'ambiente       ONDA_DISPLAY=2
 *      - il file                        <dati del player>/onda.json  {"display": 2}
 *    Il numero parte da 1 nell'ordine da sinistra a destra (poi dall'alto); il testo cerca
 *    nell'etichetta o nell'id del monitor. Senza indicazioni vale il monitor principale.
 *    Le impostazioni di dimensione/posizione del profilo del display restano valide e sono
 *    relative al monitor scelto.
 * 2. Schermata di attesa: <dati del player>/onda/splash.png (o .jpg/.webp) sostituisce il logo
 *    Onda incluso nell'applicazione. La può copiare l'agente o l'installer di ogni cliente.
 */
import { app, Display, screen } from 'electron';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPlayerDataDir } from '../common/paths';

export type OndaConfig = { display?: number | string };

export function dataDir(): string {
  return getPlayerDataDir(app.getPath('userData'));
}

export function readOndaConfig(): OndaConfig {
  const out: OndaConfig = {};
  try {
    const file = join(dataDir(), 'onda.json');
    if (existsSync(file)) {
      Object.assign(out, JSON.parse(readFileSync(file, 'utf-8')));
    }
  } catch (e) {
    console.error('[ONDA] onda.json non leggibile', e);
  }
  if (process.env.ONDA_DISPLAY) {
    out.display = process.env.ONDA_DISPLAY;
  }
  const arg = process.argv.find((a) => a.startsWith('--display='));
  if (arg) {
    out.display = arg.slice('--display='.length);
  }
  return out;
}

/** Monitor ordinati come li vede chi li guarda: da sinistra a destra, poi dall'alto. */
export function orderedDisplays(): Display[] {
  return [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

export function targetDisplay(): Display {
  const wanted = readOndaConfig().display;
  const all = orderedDisplays();
  if (wanted !== undefined && wanted !== null && `${wanted}`.trim() !== '') {
    const text = `${wanted}`.trim();
    if (/^\d+$/.test(text)) {
      const found = all[Number(text) - 1];
      if (found) {
        return found;
      }
    } else {
      const low = text.toLowerCase();
      const found = all.find((d) => `${(d as any).label || ''}`.toLowerCase().includes(low) || `${d.id}` === text);
      if (found) {
        return found;
      }
    }
    console.warn(`[ONDA] Monitor "${text}" non trovato tra ${all.length}: uso il principale`);
  }
  return screen.getPrimaryDisplay();
}

/** Descrizione dei monitor per il registro e per l'agente (es. "1: HDMI-1 1920x1080 @0,0"). */
export function describeDisplays(): string[] {
  return orderedDisplays().map((d, i) => `${i + 1}: ${(d as any).label || d.id} ${d.size.width}x${d.size.height} @${d.bounds.x},${d.bounds.y}`);
}

/** Immagine della schermata di attesa: quella del cliente se presente, altrimenti quella inclusa. */
export function splashFile(): string {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const custom = join(dataDir(), 'onda', `splash.${ext}`);
    if (existsSync(custom)) {
      return custom;
    }
  }
  return join(app.getAppPath(), 'resources', 'onda-splash.png');
}
