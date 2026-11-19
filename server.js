// Royal Run — vositachi (relay) server. O'yin (host) xona yaratadi, telefonlar 4 harfli kod bilan kiradi; server faqat xabarlarni
// uzatadi (o'yin mantiqi Unity'da). HTTPS/WSS'ni hosting (Render) beradi — bu yerda oddiy HTTP + ws.
//
//   GET /            — bosh sahifa: katta "Xona kodi" maydoni va "Kirish" (3 tilda)
//   GET /ABCD        — bosh sahifa, kod o'zi to'ldirilgan (QR shu manzilga olib keladi)
//   GET /play/ABCD   — telefon sahifasi (ism → qahramon → TAYYOR → svayp → natija)
//   GET /api/room/ABCD — {exists, full}
//   GET /health      — {ok, rooms, phones, uptime}
//   WS  /ws?role=host[&code=ABCD&key=...]   — o'yin (kod va kalit bilan — qayta ulanish, xona saqlanadi)
//   WS  /ws?role=phone&room=ABCD            — telefon
//
// Host → server: {"to":id,"d":"matn"} (to=0 — hammaga), {"kick":id}
// Server → host: {"t":"room","code","key"}, {"t":"join","id"}, {"t":"leave","id"}, {"t":"msg","id","d"}
// Telefon <-> server: oddiy matn (LAN rejimidagi bilan bir xil protokol).
//
// Himoya: xonada maks 3 telefon, xabar hajmi (telefon 2 KB, host 64 KB) va tezligi cheklangan, host 10 daqiqa yo'q bo'lsa
// xona o'chadi, xonalar soni cheklangan, hech qanday shaxsiy ma'lumot (ism, IP) saqlanmaydi va log'ga yozilmaydi.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const MAX_PHONES = 3;
const MAX_ROOMS = 1000;
const ROOM_TTL_MS = 10 * 60 * 1000;
const PHONE_MAX_BYTES = 2048, HOST_MAX_BYTES = 65536;
const PHONE_RATE = 40, HOST_RATE = 400;      // xabar/soniya (token bucket)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // O, 0, I, 1, L yo'q — chalkashmaydi
const started = Date.now();

const rooms = new Map(); // code → {code, key, host, hostGoneAt, phones: Map<id, ws>, nextId}

function newCode() {
  for (let n = 0; n < 200; n++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function bucket(rate) { return { tokens: rate, rate, last: Date.now(), strikes: 0 }; }
function allow(b) {
  const now = Date.now();
  b.tokens = Math.min(b.rate, b.tokens + (now - b.last) / 1000 * b.rate);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  b.strikes++;
  return false;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

// ---------- HTTP ----------

const cache = {};
function file(name) {
  if (!cache[name] || process.env.RELAY_DEV) cache[name] = fs.readFileSync(path.join(PUB, name), 'utf8');
  return cache[name];
}

function pickLang(req, url) {
  const q = (url.searchParams.get('lang') || '').toLowerCase();
  if (q === 'uz' || q === 'ru' || q === 'en') return q;
  const al = (req.headers['accept-language'] || '').toLowerCase();
  if (al.startsWith('ru')) return 'ru';
  if (al.startsWith('en')) return 'en';
  return 'uz';
}

function respond(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': type.startsWith('text/html') || type.startsWith('application/json') ? 'no-store' : 'public, max-age=86400',
    ...extra,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return respond(res, 400, 'text/plain', 'bad request'); }
  const p = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, 'text/plain', 'method not allowed');

  if (p === '/health') {
    let phones = 0;
    for (const r of rooms.values()) phones += r.phones.size;
    return respond(res, 200, 'application/json', JSON.stringify({ ok: true, rooms: rooms.size, phones, uptime: Math.round((Date.now() - started) / 1000) }),
      { 'Access-Control-Allow-Origin': '*' });
  }
  const api = p.match(/^\/api\/room\/([A-Za-z]{4})$/);
  if (api) {
    const r = rooms.get(api[1].toUpperCase());
    return respond(res, 200, 'application/json', JSON.stringify({ exists: !!r, full: !!r && r.phones.size >= MAX_PHONES }));
  }
  const play = p.match(/^\/play\/([A-Za-z]{4})$/);
  if (play) {
    const code = play[1].toUpperCase();
    const html = file('phone.html').replace('__LANG__', pickLang(req, url))
      .replace('<script>', `<script>window.RR_ROOM=${JSON.stringify(code)};</script><script>`);
    return respond(res, 200, 'text/html; charset=utf-8', html);
  }
  const pic = p.match(/^\/p\/([a-z0-9_]+)\.png$/);
  if (pic) {
    const f = path.join(PUB, 'p', pic[1] + '.png');
    if (fs.existsSync(f)) return respond(res, 200, 'image/png', fs.readFileSync(f));
    return respond(res, 404, 'text/plain', 'not found');
  }
  const code = p.match(/^\/([A-Za-z]{4})\/?$/);
  if (p === '/' || code) {
    const html = file('landing.html').replace('__LANG__', pickLang(req, url)).replace('__CODE__', code ? code[1].toUpperCase() : '');
    return respond(res, 200, 'text/html; charset=utf-8', html);
  }
  if (p === '/favicon.ico') return respond(res, 204, 'text/plain', '');
  if (p === '/robots.txt') return respond(res, 200, 'text/plain', 'User-agent: *\nDisallow: /\n');
  respond(res, 404, 'text/plain; charset=utf-8', '404');
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: HOST_MAX_BYTES, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const role = url.searchParams.get('role');
    if (role === 'host') onHost(ws, url);
    else if (role === 'phone') onPhone(ws, (url.searchParams.get('room') || '').toUpperCase(), (url.searchParams.get('pid') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40));
    else ws.close(1008, 'role');
  });
});

function onHost(ws, url) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const wantCode = (url.searchParams.get('code') || '').toUpperCase();
  const wantKey = url.searchParams.get('key') || '';
  let room = rooms.get(wantCode);
  if (room && room.key === wantKey && wantKey.length > 0) {
    // Qayta ulanish: xona va undagi telefonlar saqlanadi
    if (room.host && room.host !== ws) try { room.host.close(4000, 'replaced'); } catch {}
  } else {
    if (rooms.size >= MAX_ROOMS) { send(ws, { t: 'error', e: 'busy' }); ws.close(1013, 'busy'); return; }
    const code = newCode();
    if (!code) { ws.close(1013, 'busy'); return; }
    room = { code, key: crypto.randomBytes(12).toString('hex'), host: null, hostGoneAt: 0, phones: new Map(), nextId: 1 };
    rooms.set(code, room);
  }
  room.host = ws;
  room.hostGoneAt = 0;
  send(ws, { t: 'room', code: room.code, key: room.key, max: MAX_PHONES });
  for (const id of room.phones.keys()) send(ws, { t: 'join', id });

  const rate = bucket(HOST_RATE);
  ws.on('message', (data, isBinary) => {
    if (isBinary || !allow(rate)) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (typeof m.kick === 'number') {
      const p = room.phones.get(m.kick);
      if (p) try { p.close(4001, 'kicked'); } catch {}
      return;
    }
    if (typeof m.d !== 'string') return;
    if (m.to === 0) { for (const p of room.phones.values()) send(p, m.d); }
    else { const p = room.phones.get(m.to); if (p) send(p, m.d); }
  });
  ws.on('close', () => {
    if (room.host === ws) { room.host = null; room.hostGoneAt = Date.now(); }
  });
  ws.on('error', () => {});
}

function onPhone(ws, code, pid) {
  const room = rooms.get(code);
  if (!room) { send(ws, { t: 'noroom' }); ws.close(4004, 'noroom'); return; }
  // Qayta ulanish: o'sha telefon (pid) eski ulanishi hali "osilib" turgan bo'lsa (proksi yopilishni kech bildiradi) — eskisini uzamiz
  if (pid) {
    for (const [oldId, old] of room.phones) {
      if (old.pid !== pid) continue;
      room.phones.delete(oldId);
      send(room.host, { t: 'leave', id: oldId });
      try { old.terminate(); } catch {}
    }
  }
  if (room.phones.size >= MAX_PHONES) { send(ws, { t: 'full' }); ws.close(4003, 'full'); return; }
  ws.pid = pid;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const id = room.nextId++;
  room.phones.set(id, ws);
  send(room.host, { t: 'join', id });
  const rate = bucket(PHONE_RATE);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (data.length > PHONE_MAX_BYTES) { ws.close(1009, 'too big'); return; }
    if (!allow(rate)) { if (rate.strikes > 200) ws.close(1008, 'rate'); return; }
    send(room.host, { t: 'msg', id, d: data.toString() });
  });
  ws.on('close', () => {
    if (room.phones.get(id) === ws) {
      room.phones.delete(id);
      send(room.host, { t: 'leave', id });
    }
  });
  ws.on('error', () => {});
}

// Yurak urishi (o'lik ulanishlarni tez aniqlash) va bo'sh xonalarni tozalash
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (!r.host && r.hostGoneAt && now - r.hostGoneAt > ROOM_TTL_MS) {
      for (const p of r.phones.values()) try { p.close(4004, 'room closed'); } catch {}
      rooms.delete(code);
    }
  }
}, 15000);

server.listen(PORT, () => console.log(`Royal Run relay: http://localhost:${PORT}  (health: /health)`));
