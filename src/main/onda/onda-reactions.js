/*
 * Onda – esecutore delle reazioni agli eventi (pacchetto regole onda-rules-1).
 *
 * Un solo codice per l'anteprima simulata del pannello e per Onda Player: decide in locale, senza rete,
 * quale reazione parte, per quanto, con quale pausa e priorità. Nessuna dipendenza, ES5 senza moduli:
 * nel browser espone window.OndaReactions, in Node module.exports.
 *
 * Uso:
 *   var ex = OndaReactions.createExecutor(pkg, {hasMedia: function (id) { return true; }});
 *   var d = ex.handle({type: "custom.prova", source: "<id fonte>", data: {}}, Date.now(), {mandatory: false});
 *   // d.result: executed | cooldown | ignored | waiting | no_rule | discarded
 *   // d.start: reazione da mostrare {rule_id, name, kind, items, ends_at}; d.closed: id della regola chiusa
 *   var t = ex.tick(Date.now(), {mandatory: false});   // ogni ~250 ms: {ended} o {start} o null
 *
 * Le regole di corrispondenza (tipo, fonte, condizioni, giorni e orari) sono le stesse di
 * app/events/rules.py: i casi di prova comuni sono in tests/data/reactions/.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); } else { root.OndaReactions = factory(); }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA = "onda-rules-1";
  var PENDING_MAX_MS = 5 * 60 * 1000;      // una reazione in attesa del contenuto obbligatorio scade dopo 5 minuti
  var DAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  // ------------------------------------------------------------------ ora locale dello schermo
  function localParts(ms, tz) {
    var f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "Europe/Rome", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    var p = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return { weekday: DAYS[p.weekday], date: p.year + "-" + p.month + "-" + p.day,
             time: (p.hour === "24" ? "00" : p.hour) + ":" + p.minute };
  }

  // stessa logica di loops.window_active (Python)
  function windowActive(w, parts) {
    w = w || {};
    if (w.start && parts.date < w.start) { return false; }
    if (w.end && parts.date > w.end) { return false; }
    if (w.weekdays && w.weekdays.length && w.weekdays.indexOf(parts.weekday) < 0) { return false; }
    if (w.from && w.to && w.from !== w.to) {
      if (w.from < w.to) { return w.from <= parts.time && parts.time < w.to; }
      return parts.time >= w.from || parts.time < w.to;
    }
    return true;
  }

  // ------------------------------------------------------------------ condizioni sui dati
  function num(v) {
    if (typeof v === "boolean" || v === null || v === undefined) { return null; }
    if (typeof v === "number") { return isFinite(v) ? v : null; }
    var s = String(v).trim();
    if (s === "") { return null; }
    var n = Number(s);
    return isNaN(n) ? null : n;
  }

  function text(v) {
    if (v === null || v === undefined) { return ""; }
    if (typeof v === "boolean") { return v ? "true" : "false"; }
    return String(v);
  }

  function conditionOk(c, data) {
    data = data || {};
    var field = c.field || "", op = c.op || "eq", value = c.value;
    var has = Object.prototype.hasOwnProperty.call(data, field);
    var present = has && data[field] !== null && data[field] !== undefined && data[field] !== "";
    if (op === "exists") { return present; }
    if (!present) { return op === "ne"; }
    var actual = data[field];
    if (op === "gt" || op === "lt") {
      var a = num(actual), b = num(value);
      if (a === null || b === null) { return false; }
      return op === "gt" ? a > b : a < b;
    }
    var av = text(actual).trim().toLowerCase();
    if (op === "in") {
      return text(value).split(",").map(function (x) { return x.trim().toLowerCase(); })
        .filter(function (x) { return x !== ""; }).indexOf(av) >= 0;
    }
    var bv = text(value).trim().toLowerCase();
    if (op === "prefix") { return av.indexOf(bv) === 0; }
    if (op === "ne") { return av !== bv; }
    return av === bv;
  }

  function ruleMatches(rule, event, parts) {
    if (rule.type !== event.type) { return false; }
    if (rule.source && rule.source !== event.source) { return false; }
    var when = rule.when || [];
    for (var i = 0; i < when.length; i++) {
      if (!conditionOk(when[i], event.data)) { return false; }
    }
    return windowActive(rule.window, parts);
  }

  // ------------------------------------------------------------------ esecutore
  function createExecutor(pkg, opts) {
    if (!pkg || pkg.schema !== SCHEMA) { throw new Error("Pacchetto regole non supportato: serve " + SCHEMA); }
    opts = opts || {};
    var hasMedia = opts.hasMedia || function () { return true; };
    var rules = (pkg.rules || []).slice().sort(function (a, b) {        // prima le prioritarie, poi in ordine
      return (b.reaction.priority === "high") - (a.reaction.priority === "high");
    });
    var active = null, pending = null, lastEnd = {};

    function view(a) {
      return a && { rule_id: a.rule.id, name: a.rule.name, kind: a.rule.reaction.kind, priority: a.rule.reaction.priority,
                    items: a.items, started: a.started, ends_at: a.endsAt };
    }

    function plannedEnd(rule, items, start) {
      var d = rule.reaction.duration || {};
      var maxMs = (d.max_seconds || 300) * 1000;
      if (d.mode === "until_event" || d.mode === "next_event") { return start + maxMs; }
      if (d.mode === "content") {
        var total = items.reduce(function (s, it) { return s + (it.duration || 0); }, 0);
        return start + Math.max(1, total) * 1000;
      }
      return start + Math.max(1, d.seconds || 10) * 1000;
    }

    function finish(now) {
      if (!active) { return null; }
      var id = active.rule.id;
      lastEnd[id] = now;
      active = null;
      return id;
    }

    function begin(rule, event, items, now) {
      active = { rule: rule, event: event, items: items, started: now, endsAt: plannedEnd(rule, items, now) };
      return view(active);
    }

    function cooldownLeft(rule, now) {
      var cd = (rule.reaction.cooldown_seconds || 0) * 1000;
      if (!cd || lastEnd[rule.id] === undefined) { return 0; }
      return Math.max(0, lastEnd[rule.id] + cd - now);
    }

    function decide(result, rule, detail, extra) {
      var d = { result: result, rule_id: rule ? rule.id : null, rule_name: rule ? rule.name : null, detail: detail || "" };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { d[k] = extra[k]; } } }
      return d;
    }

    function handle(event, now, ctx) {
      ctx = ctx || {};
      var parts = localParts(now, pkg.timezone), closed = null;
      // 1. l'evento chiude la reazione in corso? (evento di chiusura, o prossimo evento della stessa fonte)
      if (active) {
        var d = active.rule.reaction.duration || {};
        var sameSource = !active.rule.source || active.rule.source === event.source;
        if (d.mode === "until_event" && d.end_type === event.type && sameSource) {
          closed = finish(now);
        } else if (d.mode === "next_event" && active.event.source === event.source) {
          closed = finish(now);
        }
      }
      // 2. regole che valgono per questo evento
      var rule = null;
      for (var i = 0; i < rules.length; i++) {
        if (ruleMatches(rules[i], event, parts)) { rule = rules[i]; break; }
      }
      var extra = closed ? { closed: closed } : null;
      if (!rule) {
        return closed ? decide("executed", null, "Reazione chiusa dall'evento", extra)
          : decide("no_rule", null, "Nessuna regola valida adesso per " + event.type + " (controlla tipo, fonte, condizioni, giorni e orari)");
      }
      var kind = rule.reaction.kind;
      if (kind === "cancel") {
        if (active) { extra = { closed: finish(now) }; }
        return extra ? decide("executed", rule, "Reazione in corso chiusa: si torna al loop", extra)
          : decide("ignored", rule, "Nessuna reazione in corso da chiudere");
      }
      // 3. stessa regola già in corso: ignora, ricomincia o prolunga
      if (active && active.rule.id === rule.id) {
        var rep = rule.reaction.on_repeat || "ignore";
        if (rep === "restart") {
          active.started = now;
          active.endsAt = plannedEnd(rule, active.items, now);
          return decide("executed", rule, "Reazione ricominciata", { start: view(active) });
        }
        if (rep === "extend") {
          // si aggiunge un'altra durata, fino al massimo di sicurezza dall'inizio (nei modi "fino all'evento"
          // la fine dipende dall'evento: non cambia)
          var dd = rule.reaction.duration || {};
          if (dd.mode !== "until_event" && dd.mode !== "next_event") {
            var limit = active.started + (dd.max_seconds || 300) * 1000;
            var more = plannedEnd(rule, active.items, 0);
            active.endsAt = Math.max(active.endsAt, Math.min(active.endsAt + more, limit));
          }
          return decide("executed", rule, "Reazione prolungata", { start: view(active) });
        }
        return decide("ignored", rule, "La stessa reazione è già in corso");
      }
      // 4. pausa tra reazioni
      var left = cooldownLeft(rule, now);
      if (left > 0) {
        return decide("cooldown", rule, "Pausa: la regola può ripartire tra " + Math.ceil(left / 1000) + " s", extra);
      }
      // 5. priorità: una reazione normale non interrompe una prioritaria
      if (active && active.rule.reaction.priority === "high" && rule.reaction.priority !== "high") {
        return decide("ignored", rule, "È in corso una reazione prioritaria", extra);
      }
      if (kind === "output") {
        lastEnd[rule.id] = now;
        return decide("executed", rule, "Solo uscita: lo schermo non cambia", extra);
      }
      // 6. contenuti già sul dispositivo
      var items = (rule.reaction.items || []).filter(function (it) { return hasMedia(it.media); });
      if (!items.length) {
        return decide("discarded", rule, "Contenuti della reazione non presenti sul dispositivo", extra);
      }
      // 7. contenuto obbligatorio della Direzione in onda: si aspetta la fine (salvo eccezione della regola)
      if (ctx.mandatory && !rule.reaction.interrupt_mandatory) {
        pending = { rule: rule, event: event, items: items, at: now };
        return decide("waiting", rule, "In attesa della fine del contenuto obbligatorio della Direzione", extra);
      }
      var replaced = active ? finish(now) : null;
      var started = begin(rule, event, items, now);
      var out = { start: started };
      if (closed || replaced) { out.closed = closed || replaced; }
      return decide("executed", rule, replaced ? "Sostituisce la reazione in corso" : "Reazione avviata", out);
    }

    function tick(now, ctx) {
      ctx = ctx || {};
      if (active && now >= active.endsAt) {
        return { ended: finish(now) };
      }
      if (!active && pending) {
        if (now - pending.at > PENDING_MAX_MS) { pending = null; return { expired: true }; }
        if (!ctx.mandatory) {
          var p = pending;
          pending = null;
          return { start: begin(p.rule, p.event, p.items, now) };
        }
      }
      return null;
    }

    return {
      handle: handle,
      tick: tick,
      current: function () { return view(active); },
      cancel: function (now) { pending = null; return finish(now); },
      version: pkg.version
    };
  }

  return { SCHEMA: SCHEMA, createExecutor: createExecutor, ruleMatches: ruleMatches, conditionOk: conditionOk,
           windowActive: windowActive, localParts: localParts };
}));
