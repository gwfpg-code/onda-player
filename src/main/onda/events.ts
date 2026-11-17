/*
 * Onda Player - esecutore delle reazioni agli eventi (AGPLv3, come il progetto originale).
 *
 * Il player apre una WebSocket verso Onda (<onda>/api/player/ws, protocollo onda-ws-1 descritto in
 * onda/backend/app/events/devices.py): nessuna porta aperta sul dispositivo. Onda manda il pacchetto regole
 * (onda-rules-1) e gli eventi di questo schermo; la decisione (regola, pausa, priorità, durata, ripetizione)
 * la prende onda-reactions.js, lo stesso file dell'anteprima del pannello, copiato identico da Onda.
 *
 * Reazione "tutto schermo": il layout del loop pubblicato da Onda ha una zona trasparente sopra il loop, il
 * cassetto con i contenuti e un'azione per contenuto con il codice trigger (campo "trigger" del pacchetto).
 * L'esecutore attiva quei codici in sequenza come farebbe POST /trigger, ma dall'interno: il contenuto compare
 * sopra il loop, che intanto continua sotto. Esiti, inizio e fine tornano a Onda per il registro e per
 * reaction.started / reaction.ended.
 *
 * Limiti di questa versione: un contenuto già partito arriva alla sua fine (una durata fissa più corta, o
 * "Annulla", non lo tagliano); il contenuto obbligatorio della Direzione non è ancora riconosciuto.
 */
import { app } from 'electron';
import reactionsSource from './onda-reactions.js?raw';
import { deviceIdentity, managedByOnda, ondaUrl } from './provision';

type Trigger = (code: string) => Promise<void>;
type Item = { media: string; kind: string; name: string; duration: number; trigger?: string };
type View = { rule_id: string; name: string; kind: string; items: Item[]; started: number; ends_at: number };

const TICK_MS = 250;
const PING_MS = 30 * 1000;
const SILENCE_MS = 75 * 1000;              // nessun messaggio (nemmeno pong) per tanto: collegamento perso
const RETRY_MIN_MS = 2 * 1000;
const RETRY_MAX_MS = 60 * 1000;

let OndaReactions: any = null;
let fire: Trigger | null = null;
let ws: any = null;
let retryMs = RETRY_MIN_MS;
let retryTimer: NodeJS.Timeout | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let lastMessageAt = 0;
let pkg: any = null;
let executor: any = null;
let playing: { ruleId: string; eventId: number | null; timer: NodeJS.Timeout | null } | null = null;
let status: { connected: boolean; screen?: string; rules?: number; version?: string; error?: string } = { connected: false };

/** onda-reactions.js è UMD (module.exports in Node): lo valuto dal testo, senza toccare il file. */
function reactions(): any {
  if (!OndaReactions) {
    const m: any = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', reactionsSource)(m, m.exports);
    OndaReactions = m.exports;
  }
  return OndaReactions;
}

function send(msg: any) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function wsUrl(base: string): string {
  return base.replace(/^http/i, 'ws') + '/api/player/ws';
}

// --------------------------------------------------------------------------
// Riproduzione: i codici trigger dei contenuti, uno dopo l'altro, fino alla fine prevista
// --------------------------------------------------------------------------
function stopPlayback() {
  if (playing?.timer) {
    clearTimeout(playing.timer);
  }
  playing = null;
}

function play(view: View, eventId: number | null) {
  stopPlayback();
  const items = (view.items || []).filter((it) => it.trigger);
  if (!items.length || !fire) {
    return;
  }
  const state = { ruleId: view.rule_id, eventId, timer: null as NodeJS.Timeout | null };
  playing = state;
  let i = 0;
  const next = () => {
    if (playing !== state) {
      return;
    }
    const current = executor?.current();
    if (!current || current.rule_id !== view.rule_id || Date.now() >= current.ends_at - 500) {
      return;                              // reazione finita (o sostituita): il contenuto in corso arriva alla sua fine
    }
    const it = items[i % items.length];
    i += 1;
    console.log(`[ONDA] Reazione "${view.name}": contenuto ${it.name} (${it.trigger})`);
    fire!(it.trigger!).catch((e) => console.warn('[ONDA] Trigger non eseguito', it.trigger, e));
    state.timer = setTimeout(next, Math.max(1, it.duration || 10) * 1000);
  };
  next();
}

// --------------------------------------------------------------------------
// Decisioni dell'esecutore
// --------------------------------------------------------------------------
function ruleKind(ruleId: string | null): string {
  const r = (pkg?.rules || []).find((x: any) => x.id === ruleId);
  return r?.reaction?.kind || '';
}

function startReaction(view: View, eventId: number | null) {
  play(view, eventId);
  send({ type: 'reaction', phase: 'started', rule_id: view.rule_id, event_id: eventId });
}

function endReaction(ruleId: string) {
  const eventId = playing && playing.ruleId === ruleId ? playing.eventId : null;
  stopPlayback();
  send({ type: 'reaction', phase: 'ended', rule_id: ruleId, event_id: eventId });
}

function onEvent(eventId: number, event: any) {
  if (!executor) {
    send({ type: 'outcome', event_id: eventId, result: 'discarded', detail: 'Pacchetto regole non ancora ricevuto' });
    return;
  }
  const t0 = Date.now();
  const before = executor.current();
  const d = executor.handle(event, t0, { mandatory: false });
  if (d.rule_id && ruleKind(d.rule_id) === 'output') {
    return;                                // "solo uscita": la esegue Onda, non lo schermo
  }
  if (d.closed) {
    endReaction(d.closed);
  }
  if (d.start) {
    const same = before && before.rule_id === d.start.rule_id && !d.closed;
    if (!same) {
      startReaction(d.start, eventId);
    } else if (d.detail === 'Reazione ricominciata') {
      play(d.start, eventId);              // ricomincia dal primo contenuto
    }                                      // prolungata: la sequenza continua fino alla nuova fine
  }
  send({ type: 'outcome', event_id: eventId, rule_id: d.rule_id, result: d.result, detail: d.detail,
    latency_ms: Date.now() - t0 });
}

function tick() {
  if (!executor) {
    return;
  }
  const r = executor.tick(Date.now(), { mandatory: false });
  if (r?.ended) {
    endReaction(r.ended);
  } else if (r?.start) {
    startReaction(r.start, null);
  }
}

function onRules(next: any) {
  if (!next || next.version === pkg?.version) {
    return;
  }
  try {
    const ex = reactions().createExecutor(next, { hasMedia: (id: string) =>
      (next.rules || []).some((r: any) => (r.reaction.items || []).some((it: Item) => it.media === id && it.trigger)) });
    if (executor?.current()) {
      endReaction(executor.current().rule_id);
    }
    pkg = next;
    executor = ex;
    status = { ...status, rules: (next.rules || []).length, version: next.version };
    console.log(`[ONDA] Eventi: pacchetto regole ${next.version} (${(next.rules || []).length} regole)`);
  } catch (e: any) {
    console.warn('[ONDA] Eventi: pacchetto regole non valido', e?.message || e);
  }
}

// --------------------------------------------------------------------------
// Collegamento con Onda
// --------------------------------------------------------------------------
function scheduleRetry() {
  if (retryTimer) {
    return;
  }
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
  retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
}

function connect() {
  const base = ondaUrl();
  const Ws = (globalThis as any).WebSocket;
  if (!base || !managedByOnda() || !Ws) {
    scheduleRetry();
    return;
  }
  let sock: any;
  try {
    sock = new Ws(wsUrl(base));
  } catch (e: any) {
    status = { connected: false, error: e?.message || `${e}` };
    scheduleRetry();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    const id = deviceIdentity();
    const v = app.getVersion();
    sock.send(JSON.stringify({ type: 'hello', hardware_key: id.hardwareKey, secret: id.secret,
      version: v.includes('onda') ? v : `${v}-onda` }));
    lastMessageAt = Date.now();
  };
  sock.onmessage = (m: any) => {
    lastMessageAt = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf-8'));
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      retryMs = RETRY_MIN_MS;
      status = { ...status, connected: true, screen: msg.screen?.name, error: undefined };
      console.log(`[ONDA] Eventi: collegato a Onda come "${msg.screen?.name}"`);
    } else if (msg.type === 'rules') {
      onRules(msg.pkg);
    } else if (msg.type === 'event') {
      onEvent(msg.event_id, msg.event || {});
    }
  };
  sock.onclose = (e: any) => {
    if (ws === sock) {
      ws = null;
    }
    status = { ...status, connected: false, error: e?.reason || undefined };
    if (e?.code === 4401 || e?.code === 4403) {
      console.log(`[ONDA] Eventi: Onda ha chiuso il collegamento (${e.code} ${e.reason || ''}): riprovo più tardi`);
      retryMs = RETRY_MAX_MS;
    }
    scheduleRetry();
  };
  sock.onerror = () => { /* segue onclose */ };
}

/** Avvia il collegamento eventi: fire attiva un codice trigger come POST /trigger. */
export function initEvents(trigger: Trigger) {
  fire = trigger;
  if (tickTimer) {
    return;
  }
  tickTimer = setInterval(tick, TICK_MS);
  setInterval(() => {
    if (ws && ws.readyState === 1) {
      if (Date.now() - lastMessageAt > SILENCE_MS) {
        console.log('[ONDA] Eventi: nessuna risposta da Onda, mi ricollego');
        try { ws.close(); } catch { /* già chiuso */ }
        return;
      }
      send({ type: 'ping' });
    }
  }, PING_MS);
  connect();
}

export function eventsStatus() {
  return status;
}
