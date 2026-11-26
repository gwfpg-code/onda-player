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
 * Fine della reazione (durata, "Annulla", sostituzione): se il contenuto è ancora in corso il player attiva
 * STOP_CODE, un contenuto vuoto di 1 s nel cassetto che XLR mette al posto di quello in corso (layout pubblicati da
 * Onda 0.18.0; con quelli precedenti il codice non trova l'azione e il contenuto arriva alla sua fine).
 * Contenuto obbligatorio della Direzione: Onda manda nel pacchetto i widget del loop (loop.mandatory_widgets); il
 * renderer segnala ogni widgetStart/widgetEnd (IPC onda-widget) e l'esecutore fa aspettare le reazioni che non
 * possono interromperlo (interrupt_mandatory), come nell'anteprima del pannello.
 *
 * Misura dei tempi: per ogni reazione partita da un evento il player riferisce a Onda (messaggio "timing") quanto è
 * passato dalla ricezione dell'evento all'attivazione del codice trigger e alla partenza del contenuto sullo schermo
 * (widgetStart del widget del cassetto, da loop.reaction_widgets del pacchetto attuale o del precedente: a ogni
 * pubblicazione i widget cambiano numero), più l'ultimo andata e ritorno del ping. Se il contenuto non parte entro
 * 15 secondi, o la reazione finisce prima, lo riferisce come non visibile. Onda compone il totale (events/timing.py).
 */
import { app, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import reactionsSource from './onda-reactions.js?raw';
import { applyLocalWebhook } from './localwebhook';
import { dataDir } from './onda';
import { deviceIdentity, hello, managedByOnda, ondaUrl } from './provision';
import { notePlay } from './playback';
import { handleRemote } from './remote';

type Trigger = (code: string) => Promise<void>;
type Item = { media: string; kind: string; name: string; duration: number; trigger?: string };
type View = { rule_id: string; name: string; kind: string; items: Item[]; started: number; ends_at: number };
/** Riferimento all'evento nei messaggi a Onda: {event_id} (dal webhook di Onda) o {local_source, local_id} (locale). */
type Ref = Record<string, any>;

const TICK_MS = 250;
const PING_MS = 30 * 1000;
const SILENCE_MS = 75 * 1000;              // nessun messaggio (nemmeno pong) per tanto: collegamento perso
const RETRY_MIN_MS = 2 * 1000;
const RETRY_MAX_MS = 60 * 1000;
const STOP_CODE = 'onda-stop';             // REACTION_STOP_CODE di Onda (backend/app/engine/base.py)
const STOP_GAP_MS = 300;                   // tra lo stop e il primo contenuto quando una reazione ricomincia
const QUEUE_MAX = 500;                     // messaggi per Onda tenuti mentre il collegamento è perso
const MEASURE_MAX_MS = 15 * 1000;          // contenuto della reazione non partito entro tanto: "non visibile"

let OndaReactions: any = null;
let fire: Trigger | null = null;
let ws: any = null;
let retryMs = RETRY_MIN_MS;
let retryTimer: NodeJS.Timeout | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let lastMessageAt = 0;
let pkg: any = null;
let executor: any = null;
type Playing = { ruleId: string; ref: Ref; timer: NodeJS.Timeout | null; itemEndsAt: number; stop: string };
let welcomed = false;
const outbox: any[] = [];
let hold: any[] | null = null;              // messaggi trattenuti finché l'evento locale non è annunciato
// contenuto obbligatorio della Direzione in onda: i widget arrivano col pacchetto (loop.mandatory_widgets); tengo
// anche quelli del pacchetto precedente, perché il player passa al layout nuovo un po' dopo che Onda l'ha pubblicato
let mandatoryIds = new Set<number>();
let loopIds = new Set<number>();
let mandatoryOn = false;
let pendingRef: Ref | null = null;          // evento della reazione in attesa della fine del contenuto obbligatorio
let rttMs: number | null = null;            // ultimo andata e ritorno ping/pong con Onda
type Measure = { ref: Ref; ruleId: string; recvAt: number; fireAt: number; widgets: Set<number>; timer: NodeJS.Timeout };
let measure: Measure | null = null;
// cassetto del loop precedente: dopo una ripubblicazione il renderer può suonare ancora il layout vecchio (o già il
// nuovo mentre il pacchetto è quello vecchio), e i widget del cassetto cambiano numero a ogni pubblicazione
let prevReactionWidgets: Record<string, number> = {};

function ctx() {
  return { mandatory: mandatoryOn };
}

/** Lo stato cambia solo quando parte un contenuto del loop: tra due contenuti obbligatori di fila la reazione
 * continua ad aspettare (partirebbe sopra il secondo), e parte quando arriva un contenuto non obbligatorio. */
function onWidget(phase: string, widgetId: number) {
  if (phase === 'start') {
    notePlay();
    // contenuto della reazione sullo schermo: il widget del cassetto del codice attivato (o, con un loop pubblicato
    // prima di Onda 0.26.0, il primo widget fuori dal loop)
    if (measure && measure.fireAt && (measure.widgets.size ? measure.widgets.has(widgetId) : !loopIds.has(widgetId))) {
      reportTiming(true);
    }
  }
  if (phase === 'start' && loopIds.has(widgetId)) {
    const on = mandatoryIds.has(widgetId);
    if (on !== mandatoryOn) {
      console.log(`[ONDA] Eventi: contenuto obbligatorio della Direzione ${on ? 'in onda' : 'finito'}`);
    }
    mandatoryOn = on;
  }
}
let playing: Playing | null = null;
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

/** Messaggio per Onda; senza collegamento resta in coda (gli eventi locali si eseguono comunque). */
function send(msg: any) {
  if (hold) {
    hold.push(msg);
    return;
  }
  if (ws && ws.readyState === 1 && welcomed) {
    ws.send(JSON.stringify(msg));
  } else if (msg.type !== 'ping') {
    outbox.push(msg);
    if (outbox.length > QUEUE_MAX) {
      outbox.shift();
    }
  }
}

function flush() {
  while (outbox.length && ws && ws.readyState === 1) {
    ws.send(JSON.stringify(outbox.shift()));
  }
}

const rulesFile = () => join(dataDir(), 'onda', 'rules.json');

function wsUrl(base: string): string {
  return base.replace(/^http/i, 'ws') + '/api/player/ws';
}

// --------------------------------------------------------------------------
// Misura dei tempi
// --------------------------------------------------------------------------
function startMeasure(ref: Ref, ruleId: string, recvAt: number) {
  stopMeasure();
  const m: Measure = { ref, ruleId, recvAt, fireAt: 0, widgets: new Set<number>(),
    timer: setTimeout(() => { if (measure === m) { reportTiming(false); } }, MEASURE_MAX_MS) };
  measure = m;
}

function stopMeasure() {
  if (measure) {
    clearTimeout(measure.timer);
  }
  measure = null;
}

function noteFire(ruleId: string, code: string) {
  if (measure && measure.ruleId === ruleId && !measure.fireAt) {
    measure.fireAt = Date.now();
    for (const v of [pkg?.loop?.reaction_widgets?.[code], prevReactionWidgets[code]]) {
      const w = Number(v);
      if (Number.isFinite(w) && w > 0) {
        measure.widgets.add(w);
      }
    }
  }
}

function reportTiming(visible: boolean) {
  const m = measure;
  if (!m) {
    return;
  }
  stopMeasure();
  const now = Date.now();
  const msg = { type: 'timing', ...m.ref, rule_id: m.ruleId, fire_ms: m.fireAt ? m.fireAt - m.recvAt : null,
    visible_ms: visible ? now - m.recvAt : null, rtt_ms: rttMs, visible };
  if (visible) {
    console.log(`[ONDA] Reazione visibile dopo ${now - m.recvAt} ms dalla ricezione dell'evento`);
  } else {
    console.warn('[ONDA] Contenuto della reazione non partito entro 15 secondi');
  }
  send(msg);
}

// --------------------------------------------------------------------------
// Riproduzione: i codici trigger dei contenuti, uno dopo l'altro, fino alla fine prevista
// --------------------------------------------------------------------------
/** Ferma la sequenza; con cutContent toglie anche il contenuto ancora sullo schermo (STOP_CODE). */
function stopPlayback(cutContent = false) {
  if (playing?.timer) {
    clearTimeout(playing.timer);
  }
  if (cutContent && playing && Date.now() < playing.itemEndsAt - STOP_GAP_MS && fire) {
    console.log(`[ONDA] Reazione finita: tolgo il contenuto ancora in corso (${playing.stop})`);
    fire(playing.stop).catch((e) => console.warn('[ONDA] Stop non eseguito', e));
  }
  playing = null;
}

function play(view: View, ref: Ref, delayMs = 0) {
  stopPlayback();
  const items = (view.items || []).filter((it) => it.trigger);
  if (!items.length || !fire) {
    return;
  }
  const state: Playing = { ruleId: view.rule_id, ref, timer: null, itemEndsAt: 0, stop: stopCode(view.rule_id) };
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
    noteFire(view.rule_id, it.trigger!);
    fire!(it.trigger!).catch((e) => console.warn('[ONDA] Trigger non eseguito', it.trigger, e));
    const ms = Math.max(1, it.duration || 10) * 1000;
    state.itemEndsAt = Date.now() + ms;
    state.timer = setTimeout(next, ms);
  };
  if (delayMs > 0) {
    state.timer = setTimeout(next, delayMs);
  } else {
    next();
  }
}

// --------------------------------------------------------------------------
// Decisioni dell'esecutore
// --------------------------------------------------------------------------
/** Codice che toglie il contenuto dalla zona della regola (tutto schermo o la posizione del PIP). */
function stopCode(ruleId: string | null): string {
  const r = (pkg?.rules || []).find((x: any) => x.id === ruleId);
  return r?.reaction?.stop_trigger || STOP_CODE;
}

function ruleKind(ruleId: string | null): string {
  const r = (pkg?.rules || []).find((x: any) => x.id === ruleId);
  return r?.reaction?.kind || '';
}

function startReaction(view: View, ref: Ref, recvAt?: number) {
  if (recvAt !== undefined) {
    startMeasure(ref, view.rule_id, recvAt);   // solo se parte subito: un'attesa voluta non è un ritardo
  }
  play(view, ref);
  send({ type: 'reaction', phase: 'started', rule_id: view.rule_id, ...ref });
}

function endReaction(ruleId: string, cutContent = true, natural = false) {
  const ref = playing && playing.ruleId === ruleId ? playing.ref : {};
  if (measure && measure.ruleId === ruleId) {
    if (natural && measure.fireAt) {
      reportTiming(false);                  // arrivata alla fine senza che il contenuto partisse: va detto a Onda
    } else {
      stopMeasure();                        // annullata o sostituita prima di comparire: non è un ritardo
    }
  }
  stopPlayback(cutContent);
  send({ type: 'reaction', phase: 'ended', rule_id: ruleId, ...ref });
}

/** Decide ed esegue; ritorna la decisione di onda-reactions.js (null se la regola è "solo uscita"). */
export function execute(event: any, ref: Ref, recvAt: number = Date.now()): any {
  if (!executor) {
    return { result: 'discarded', rule_id: null, detail: 'Pacchetto regole non ancora ricevuto' };
  }
  const t0 = Date.now();
  const before = executor.current();
  const d = executor.handle(event, t0, ctx());
  d.latency_ms = Date.now() - t0;
  if (d.result === 'waiting') {
    pendingRef = ref;
  }
  if (d.rule_id && ruleKind(d.rule_id) === 'output') {
    return null;                           // "solo uscita": la esegue Onda, non lo schermo
  }
  if (d.closed) {
    // se ne parte un'altra nella stessa zona, il suo contenuto prende il posto di quello in corso
    endReaction(d.closed, !d.start || stopCode(d.closed) !== stopCode(d.start.rule_id));
  }
  if (d.start) {
    const same = before && before.rule_id === d.start.rule_id && !d.closed;
    if (!same) {
      startReaction(d.start, ref, recvAt);
    } else if (d.detail === 'Reazione ricominciata') {
      // XLR ignora un contenuto del cassetto già in coda: prima lo stop, poi di nuovo il primo contenuto
      const keep = playing?.ref ?? ref;
      stopPlayback(true);
      play(d.start, keep, STOP_GAP_MS);
    }                                      // prolungata: la sequenza continua fino alla nuova fine
  }
  return d;
}

function onEvent(eventId: number, event: any, recvAt: number) {
  const d = execute(event, { event_id: eventId }, recvAt);
  if (d) {
    send({ type: 'outcome', event_id: eventId, rule_id: d.rule_id, result: d.result, detail: d.detail,
      latency_ms: d.latency_ms });
  }
}

/** Evento dal webhook locale, già controllato: esegue subito e lo riferisce a Onda (anche più tardi). */
export function executeLocal(sourceId: string, ip: string, event: any): any {
  const recvAt = Date.now();
  hold = [];
  let d: any;
  try {
    d = execute({ type: event.type, source: sourceId, data: event.data || {} },
      { local_source: sourceId, local_id: event.id }, recvAt);
  } finally {
    const held = hold;
    hold = null;
    const outcome = d ? { rule_id: d.rule_id, result: d.result, detail: d.detail, latency_ms: d.latency_ms } : {};
    send({ type: 'local_event', source: sourceId, ip, event, outcome });   // prima l'evento, poi le sue reaction
    held.forEach(send);
  }
  return d || { result: 'executed', detail: 'Solo uscita: la esegue Onda' };
}

export function currentPackage(): any {
  return pkg;
}

function tick() {
  if (!executor) {
    return;
  }
  const r = executor.tick(Date.now(), ctx());
  if (r?.ended) {
    endReaction(r.ended, true, true);
  } else if (r?.start) {
    const ref = pendingRef || {};
    pendingRef = null;
    startReaction(r.start, ref);
    send({ type: 'outcome', ...ref, rule_id: r.start.rule_id, result: 'executed',
      detail: 'Partita alla fine del contenuto obbligatorio della Direzione' });
  } else if (r?.expired) {
    const ref = pendingRef || {};
    pendingRef = null;
    send({ type: 'outcome', ...ref, result: 'discarded', detail: 'Attesa scaduta: il contenuto obbligatorio è durato oltre 5 minuti' });
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
    const prev = pkg?.loop;
    pkg = next;
    prevReactionWidgets = { ...(prev?.reaction_widgets || {}) };
    executor = ex;
    mandatoryIds = new Set([...(next.loop?.mandatory_widgets || []), ...(prev?.mandatory_widgets || [])]);
    loopIds = new Set([...(next.loop?.widgets || []), ...(prev?.widgets || [])]);
    applyLocalWebhook(next.local_webhook);
    try {
      mkdirSync(join(dataDir(), 'onda'), { recursive: true });
      writeFileSync(rulesFile(), JSON.stringify(next));      // per il webhook locale anche senza rete all'avvio
    } catch (e) {
      console.warn('[ONDA] Eventi: pacchetto regole non salvato', e);
    }
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
    const recvAt = Date.now();
    lastMessageAt = recvAt;
    let msg: any;
    try {
      msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf-8'));
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      retryMs = RETRY_MIN_MS;
      welcomed = true;
      flush();
      status = { ...status, connected: true, screen: msg.screen?.name, error: undefined };
      console.log(`[ONDA] Eventi: collegato a Onda come "${msg.screen?.name}"`);
    } else if (msg.type === 'rules') {
      onRules(msg.pkg);
    } else if (msg.type === 'event') {
      onEvent(msg.event_id, msg.event || {}, recvAt);
    } else if (msg.type === 'pong') {
      if (typeof msg.t === 'number' && recvAt >= msg.t) {
        rttMs = recvAt - msg.t;                 // Onda >= 0.26.0 ripete t
      }
    } else if (msg.type === 'remote') {
      handleRemote(msg);                       // controllo remoto dalla console di Onda
    } else if (msg.type === 'config') {
      // impostazioni cambiate nel pannello di Onda: le rileggo subito invece di aspettare il controllo periodico
      console.log('[ONDA] Impostazioni cambiate in Onda: le rileggo');
      void hello();
    }
  };
  sock.onclose = (e: any) => {
    if (ws === sock) {
      ws = null;
      welcomed = false;
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
  // ultimo pacchetto ricevuto: regole e webhook locale valgono anche se all'avvio Onda non è raggiungibile
  try {
    if (managedByOnda() && existsSync(rulesFile())) {
      onRules(JSON.parse(readFileSync(rulesFile(), 'utf-8')));
    }
  } catch (e) {
    console.warn('[ONDA] Eventi: pacchetto regole salvato non leggibile', e);
  }
  tickTimer = setInterval(tick, TICK_MS);
  ipcMain.on('onda-widget', (_e, phase: string, widgetId: number) => onWidget(phase, Number(widgetId)));
  setInterval(() => {
    if (ws && ws.readyState === 1) {
      if (Date.now() - lastMessageAt > SILENCE_MS) {
        console.log('[ONDA] Eventi: nessuna risposta da Onda, mi ricollego');
        try { ws.close(); } catch { /* già chiuso */ }
        return;
      }
      send({ type: 'ping', t: Date.now() });
    }
  }, PING_MS);
  connect();
}

export function eventsStatus() {
  return status;
}
