/*
 * Onda Player - webhook locale degli eventi (AGPLv3, come il progetto originale).
 *
 * Spento di default: si accende dalla scheda dello schermo in Onda (Onda Player › Webhook locale), che manda
 * porta e stato nel pacchetto regole (local_webhook). Acceso, ascolta sulla rete della sede e accetta
 *   POST /api/events/v1/<id della fonte>   con   Authorization: Bearer <token della fonte>
 * con lo stesso corpo del webhook di Onda ({"id", "type", "occurred_at"?, "target"?, "data"?}). Esegue subito la
 * reazione con le regole in memoria (anche senza Internet) e poi la riferisce a Onda per il registro.
 *
 * Controlli, nell'ordine: 404 percorso · 413 corpo oltre 4 KB · 429 troppe richieste · 401 fonte sconosciuta o
 * token errato · 403 fonte revocata, con firma HMAC (il player conosce solo l'impronta del token), indirizzo non
 * ammesso dalla fonte, tipo non ammesso, altro schermo · 400 JSON o dati non validi · 200 doppione · 202 accettato.
 * Il server interno del player (porta 9696, POST /trigger) resta solo su localhost.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { BlockList, isIP } from 'net';
import { currentPackage, executeLocal } from './events';

const MAX_BODY = 4096;
const PER_IP_PER_MINUTE = 300;
const PER_SOURCE_PER_MINUTE = 120;
const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const TYPE_RE = /^(presence\.detected|presence\.ended|button\.pressed|barcode\.scanned|touch\.zone|schedule\.tick|custom\.[a-z][a-z0-9_]{0,39})$/;
const UUID_RE = /^[0-9a-f-]{36}$/;

let server: Server | null = null;
let current = { enabled: false, port: 0 };
const hits = new Map<string, number[]>();
const seen: string[] = [];                 // ultimi id ricevuti (fonte:id), contro i doppioni

function limited(key: string, perMinute: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) {
    hits.clear();
  }
  return list.length > perMinute;
}

function reply(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clientIp(req: IncomingMessage): string {
  const ip = req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** L'indirizzo è tra quelli ammessi dalla fonte (IP singoli o reti CIDR)? Lista vuota: nessuno. */
export function ipAllowed(ip: string, allowed: string[]): boolean {
  const kind = isIP(ip);
  if (!kind || !allowed?.length) {
    return false;
  }
  const list = new BlockList();
  for (const a of allowed) {
    const [addr, prefix] = `${a}`.split('/');
    const k = isIP(addr);
    if (!k) {
      continue;
    }
    if (prefix !== undefined) {
      list.addSubnet(addr, Number(prefix), k === 6 ? 'ipv6' : 'ipv4');
    } else {
      list.addAddress(addr, k === 6 ? 'ipv6' : 'ipv4');
    }
  }
  return list.check(ip, kind === 6 ? 'ipv6' : 'ipv4');
}

function tokenOk(auth: string, sha256: string): boolean {
  if (!auth.toLowerCase().startsWith('bearer ') || !/^[0-9a-f]{64}$/.test(sha256 || '')) {
    return false;
  }
  const got = createHash('sha256').update(auth.slice(7).trim()).digest();
  return timingSafeEqual(got, Buffer.from(sha256, 'hex'));
}

/** Solo testo breve, numeri e sì/no, come in Onda (che poi ricontrolla e scarta il resto). */
function cleanData(data: any): Record<string, any> | null {
  if (data === undefined || data === null) {
    return {};
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) {
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else if (typeof v === 'string') {
      if (/https?:\/\/|<[a-z!/]/i.test(v)) {
        return null;                       // mai indirizzi o HTML
      }
      out[k] = v.slice(0, 200);
    }
  }
  return out;
}

function handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const ip = clientIp(req);
  const m = /^\/api\/events\/v1\/([0-9a-f-]{36})\/?$/.exec((req.url || '').split('?')[0]);
  if (req.method !== 'POST' || !m) {
    return reply(res, 404, { error: 'Percorso sconosciuto: usa POST /api/events/v1/<id della fonte>' });
  }
  if (limited(`ip:${ip}`, PER_IP_PER_MINUTE)) {
    return reply(res, 429, { error: 'Troppe richieste da questo indirizzo: riprova tra un minuto.' });
  }
  const pkg = currentPackage();
  const sourceId = m[1];
  const src = (pkg?.sources || []).find((x: any) => x.id === sourceId);
  if (!pkg || (!src && !(pkg.revoked_sources || []).includes(sourceId))) {
    return reply(res, 401, { error: 'Fonte sconosciuta o credenziali non valide.' });
  }
  if (!src) {
    return reply(res, 403, { error: 'Fonte revocata: riattivala in Onda › Eventi › Fonti.' });
  }
  if (limited(`src:${sourceId}`, PER_SOURCE_PER_MINUTE)) {
    return reply(res, 429, { error: `Troppe richieste per questa fonte (massimo ${PER_SOURCE_PER_MINUTE} al minuto).` });
  }
  if (src.signed) {
    return reply(res, 403, { error: 'Questa fonte usa la firma HMAC: sul webhook locale serve una fonte con il solo token.' });
  }
  if (!tokenOk(`${req.headers.authorization || ''}`, src.token_sha256)) {
    return reply(res, 401, { error: 'Fonte sconosciuta o credenziali non valide.' });
  }
  if (!ipAllowed(ip, src.allowed_ips)) {
    return reply(res, 403, { error: `Indirizzo ${ip} non ammesso per questa fonte (Onda › Eventi › Fonti › Indirizzi ammessi).` });
  }
  let raw: any;
  try {
    raw = JSON.parse(body.toString('utf-8') || 'null');
  } catch {
    return reply(res, 400, { error: 'Il corpo non è JSON valido.' });
  }
  if (!raw || typeof raw !== 'object' || !ID_RE.test(`${raw.id ?? ''}`)) {
    return reply(res, 400, { error: 'Campo id obbligatorio: fino a 80 caratteri tra lettere, cifre e . _ : -' });
  }
  if (!TYPE_RE.test(`${raw.type ?? ''}`)) {
    return reply(res, 400, { error: 'Tipo di evento non valido: usa un tipo standard o custom.<nome> in minuscolo.' });
  }
  if (src.types?.length && !src.types.includes(raw.type)) {
    return reply(res, 403, { error: `Questa fonte non può inviare eventi di tipo ${raw.type}.` });
  }
  const target = raw.target?.screen;
  if (target !== undefined && target !== null && (!UUID_RE.test(`${target}`) || target !== pkg.screen?.id)) {
    return reply(res, 403, { error: 'target.screen indica un altro schermo: questo player è ' + (pkg.screen?.name || '') });
  }
  const data = cleanData(raw.data);
  if (data === null) {
    return reply(res, 400, { error: 'Dati non validi: solo testo breve, numeri e sì/no, mai indirizzi o HTML.' });
  }
  const key = `${sourceId}:${raw.id}`;
  if (seen.includes(key)) {
    return reply(res, 200, { status: 'duplicate' });
  }
  seen.push(key);
  if (seen.length > 1000) {
    seen.shift();
  }
  const event: any = { id: `${raw.id}`, type: raw.type, data };
  if (raw.occurred_at) {
    event.occurred_at = `${raw.occurred_at}`.slice(0, 40);
  }
  const d = executeLocal(sourceId, ip, event);
  console.log(`[ONDA] Webhook locale: ${raw.type} da ${ip} → ${d.result}`);
  return reply(res, 202, { status: 'accepted', result: d.result, detail: d.detail || '' });
}

/** Accende, spegne o sposta il server secondo il pacchetto regole. */
export function applyLocalWebhook(cfg: any) {
  const want = { enabled: !!cfg?.enabled, port: Number(cfg?.port) || 0 };
  if (want.enabled === current.enabled && want.port === current.port) {
    return;
  }
  if (server) {
    server.close();
    server = null;
    console.log('[ONDA] Webhook locale spento');
  }
  current = want;
  if (!want.enabled || !(want.port >= 1024 && want.port <= 65535) || want.port === 9696) {
    return;
  }
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (tooBig) {
        return reply(res, 413, { error: `Corpo troppo grande: massimo ${MAX_BODY} byte.` });
      }
      try {
        handle(req, res, Buffer.concat(chunks));
      } catch (e: any) {
        console.warn('[ONDA] Webhook locale: errore', e?.message || e);
        reply(res, 500, { error: 'Errore interno del player.' });
      }
    });
  });
  srv.requestTimeout = 10000;
  srv.on('error', (e: any) => {
    console.warn(`[ONDA] Webhook locale non avviato sulla porta ${want.port}: ${e?.code || e?.message || e}`);
    if (server === srv) {
      server = null;
      current = { enabled: false, port: 0 };   // riprova al prossimo pacchetto regole
    }
  });
  srv.listen(want.port, () => console.log(`[ONDA] Webhook locale in ascolto sulla porta ${want.port}`));
  server = srv;
}
