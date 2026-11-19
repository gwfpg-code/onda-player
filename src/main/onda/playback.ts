/*
 * Onda Player - cosa sta andando in onda (AGPLv3, come il progetto originale).
 *
 * Il renderer segnala l'inizio di ogni contenuto (widgetStart, IPC onda-widget) e di ogni layout (layoutStart).
 * Teniamo l'ora dell'ultimo inizio e la diamo a Onda nell'hello (playback): se lo schermo è acceso e collegato ma
 * da molti minuti non parte nessun contenuto (layout che non si caricano, schermo grigio), il monitoraggio di Onda
 * apre un problema "Nessuna riproduzione".
 */
const startedAt = new Date().toISOString();
let lastPlay = '';
let lastLayout = 0;

export function notePlay(layoutId?: number) {
  lastPlay = new Date().toISOString();
  if (layoutId) {
    lastLayout = layoutId;
  }
}

export function playbackReport() {
  return { started_at: startedAt, last_play_at: lastPlay || null, layout: lastLayout || null };
}
