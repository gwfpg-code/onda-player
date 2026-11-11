/*
 * Onda Player - orari di accensione (AGPLv3, come il progetto originale).
 *
 * Stesse regole di Onda (backend/app/hours.py), così player e pannello decidono allo stesso modo:
 *   week[0..6], lunedì = 0; null = giorno di chiusura; {on, off} = fascia "HH:MM".
 *   on == off              -> acceso tutto il giorno
 *   off < on (18:00-02:00) -> la fascia prosegue oltre la mezzanotte: la coda appartiene al giorno
 *                             in cui comincia, anche se il giorno dopo è chiuso.
 * Gli orari sono nel fuso della sede (timezone IANA, es. "Europe/Rome").
 * Modulo puro (niente Electron): si prova con node.
 */

export type Day = { on: string; off: string } | null;
export type Hours = { timezone: string; week: Day[] };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function minutes(hm: string): number {
  const [h, m] = hm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Orari validi oppure null (orari assenti o rovinati: il player resta sempre acceso). */
export function normalize(raw: any): Hours | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.week) || raw.week.length !== 7) {
    return null;
  }
  const week: Day[] = [];
  for (const d of raw.week) {
    if (d === null) {
      week.push(null);
    } else if (d && TIME.test(`${d.on}`) && TIME.test(`${d.off}`)) {
      week.push({ on: d.on, off: d.off });
    } else {
      return null;
    }
  }
  const timezone = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'Europe/Rome';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return null;
  }
  return { timezone, week };
}

/** Giorno della settimana (lunedì = 0) e minuti dalla mezzanotte, nell'ora locale di `timezone`. */
export function localTime(now: Date, timezone: string): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return { weekday: WEEKDAYS.indexOf(get('weekday')), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Acceso adesso? Con orari assenti: sempre acceso. */
export function isOn(hours: Hours | null, now: Date = new Date()): boolean {
  if (!hours) {
    return true;
  }
  const { weekday, minute } = localTime(now, hours.timezone);
  if (weekday < 0) {
    return true;
  }
  const today = hours.week[weekday];
  if (today) {
    const on = minutes(today.on);
    const off = minutes(today.off);
    if (on === off) {
      return true;
    }
    if (on < off ? (minute >= on && minute < off) : minute >= on) {
      return true;
    }
  }
  const yesterday = hours.week[(weekday + 6) % 7];
  if (yesterday) {
    const on = minutes(yesterday.on);
    const off = minutes(yesterday.off);
    if (off < on && minute < off) {        // coda della fascia di ieri, oltre la mezzanotte
      return true;
    }
  }
  return false;
}
