'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

/* ---------- card helpers ---------- */
const SUITS = ['S', 'H', 'D', 'C'];
const MIN_PLAYERS = 3, MAX_PLAYERS = 8;
const rank = c => parseInt(c, 10);
const suit = c => c.slice(-1);
const RN = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const label = c => (RN[rank(c)] || rank(c)) + SYM[suit(c)];
const sortHand = h => h.sort((a, b) => SUITS.indexOf(suit(a)) - SUITS.indexOf(suit(b)) || rank(b) - rank(a));

function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/* ---------- rooms ---------- */
const rooms = new Map();
const uid = () => crypto.randomBytes(8).toString('hex');
function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
const byId = (room, id) => room.players.find(p => p.id === id);
const seatOf = (room, p) => room.players.indexOf(p);

function activeFrom(room, startSeat) {
  const n = room.players.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = room.players[(startSeat + i) % n];
    if (p.hand.length > 0) out.push(p);
  }
  return out;
}
function nextActiveAfter(room, p) {
  const n = room.players.length, s = seatOf(room, p);
  for (let i = 1; i < n; i++) {
    const q = room.players[(s + i) % n];
    if (q.hand.length > 0) return q;
  }
  return null;
}
function log(room, text) { room.log.push(text); if (room.log.length > 80) room.log.shift(); }
function setEvent(room, type, text) { room.event = { seq: ++room.seq, type, text }; }

/* ---------- game flow ---------- */
function startGame(room) {
  room.phase = 'playing';
  room.log = []; room.loserId = null; room.discarded = 0; room.trickNo = 0; room.outCounter = 0;
  room.players.forEach(p => { p.hand = []; p.out = false; p.place = 0; p.reveal = null; p.requestedThisTurn = false; });
  const deck = newDeck();
  deck.forEach((c, i) => room.players[i % room.players.length].hand.push(c));
  room.players.forEach(p => sortHand(p.hand));
  const leader = room.players.find(p => p.hand.includes('14S'));
  log(room, `Cards dealt (${room.players.length} players). ${leader.name} holds A♠ and opens.`);
  setEvent(room, 'start', `${leader.name} opens with A♠`);
  newTrick(room, leader, true);
  playCard(room, leader, '14S');
}

function newTrick(room, leader, first = false) {
  room.trickNo++;
  const order = activeFrom(room, seatOf(room, leader)).map(p => p.id);
  room.trick = { first, leadSuit: null, plays: [], order, pos: 0 };
  setTurn(room, order[0]);
}

function setTurn(room, pid) {
  room.turn = pid;
  const p = byId(room, pid);
  if (p) p.requestedThisTurn = false;
  scheduleBot(room);
}

function legalCards(room, p) {
  if (room.phase !== 'playing' || room.turn !== p.id) return [];
  const t = room.trick;
  if (t.plays.length === 0) return t.first ? p.hand.filter(c => c === '14S') : p.hand.slice();
  const same = p.hand.filter(c => suit(c) === t.leadSuit);
  if (same.length) return same;
  return t.first ? [] : p.hand.slice();
}

function playCard(room, p, cardId) {
  const t = room.trick;
  p.hand.splice(p.hand.indexOf(cardId), 1);
  p.reveal = null;
  const isLead = t.plays.length === 0;
  const off = !isLead && suit(cardId) !== t.leadSuit;
  if (isLead) t.leadSuit = suit(cardId);
  t.plays.push({ pid: p.id, card: cardId });
  if (isLead) log(room, `${p.name} leads ${label(cardId)}.`);
  else if (!off) log(room, `${p.name} plays ${label(cardId)}.`);
  if (off) return resolveThulla(room, p, cardId);
  advance(room);
}

function advance(room) {
  const t = room.trick;
  t.pos++;
  while (t.pos < t.order.length && t.first) {
    const q = byId(room, t.order[t.pos]);
    if (q.hand.some(c => suit(c) === t.leadSuit)) break;
    log(room, `${q.name} has no ${SYM[t.leadSuit]} and passes (first-round protection).`);
    t.pos++;
  }
  if (t.pos >= t.order.length) return resolveNormal(room);
  setTurn(room, t.order[t.pos]);
}

function highest(room) {
  const t = room.trick;
  let best = null;
  for (const pl of t.plays) if (suit(pl.card) === t.leadSuit && (!best || rank(pl.card) > rank(best.card))) best = pl;
  return best;
}

function resolveThulla(room, thrower, card) {
  const t = room.trick;
  const best = highest(room);
  const taker = byId(room, best.pid);
  const cards = t.plays.map(x => x.card);
  taker.hand.push(...cards);
  sortHand(taker.hand);
  log(room, `${thrower.name} has no ${SYM[t.leadSuit]} and plays ${label(card)} — THULLA! ${taker.name} (${label(best.card)}) picks up ${cards.length} cards.`);
  setEvent(room, 'thulla', `THULLA! ${taker.name} picks up ${cards.length} cards`);
  finishTrick(room, taker);
}

function resolveNormal(room) {
  const t = room.trick;
  const best = highest(room);
  const winner = byId(room, best.pid);
  room.discarded += t.plays.length;
  log(room, `${winner.name} wins the trick with ${label(best.card)}. Cards discarded.`);
  if (t.first) setEvent(room, 'info', `First round safe — cards discarded`);
  const leader = winner.hand.length > 0 ? winner : nextActiveAfter(room, winner);
  finishTrick(room, leader);
}

function markOuts(room) {
  for (const p of room.players) {
    if (p.hand.length === 0 && !p.out) {
      p.out = true; p.place = ++room.outCounter;
      log(room, `${p.name} is out — safe!`);
    }
  }
}

function finishTrick(room, leader) {
  markOuts(room);
  const active = room.players.filter(p => p.hand.length > 0);
  if (active.length <= 1 || !leader || leader.hand.length === 0) return endGame(room, active[0] || null);
  newTrick(room, leader, false);
}

function endGame(room, loser) {
  room.phase = 'over';
  room.loserId = loser ? loser.id : null;
  clearTimeout(room.botTimer);
  if (loser) { log(room, `${loser.name} is the BHABHI!`); setEvent(room, 'over', `${loser.name} is the Bhabhi!`); }
  else { log(room, 'Everyone got out — no Bhabhi this time.'); setEvent(room, 'over', 'Nobody is the Bhabhi — draw!'); }
}

function canRequest(room, p) {
  if (room.phase !== 'playing' || room.settings.requestMode === 'off') return null;
  const t = room.trick;
  if (t.first || room.turn !== p.id || p.requestedThisTurn || p.hand.length === 0) return null;
  const target = nextActiveAfter(room, p);
  if (!target) return null;
  const ti = t.order.indexOf(target.id);
  if (ti <= t.pos) return null; // target already played this trick
  return target;
}

function doRequest(room, p) {
  const target = canRequest(room, p);
  if (!target) return 'You cannot request a hand right now.';
  const t = room.trick;
  p.requestedThisTurn = true;
  if (room.settings.requestMode === 'reveal') {
    p.reveal = { name: target.name, hand: sortHand(target.hand.slice()) };
    log(room, `${p.name} requested ${target.name}'s hand and looked at it (reveal only).`);
    setEvent(room, 'request', `${p.name} peeked at ${target.name}'s hand`);
    return null;
  }
  const n = target.hand.length;
  p.hand.push(...target.hand);
  sortHand(p.hand);
  target.hand = [];
  t.order.splice(t.order.indexOf(target.id), 1);
  log(room, `${p.name} requested ${target.name}'s hand and took all ${n} cards. ${target.name} is out!`);
  setEvent(room, 'request', `${p.name} took ${n} cards from ${target.name}!`);
  markOuts(room);
  const active = room.players.filter(x => x.hand.length > 0);
  if (active.length <= 1) endGame(room, active[0] || null);
  return null;
}

/* auto-play for disconnected players so the table never stalls */
function scheduleBot(room) {
  clearTimeout(room.botTimer);
  if (room.phase !== 'playing') return;
  const p = byId(room, room.turn);
  if (!p || p.connected) return;
  const turn = room.turn, tn = room.trickNo, pl = room.trick.plays.length;
  room.botTimer = setTimeout(() => {
    if (room.phase !== 'playing' || room.turn !== turn || room.trickNo !== tn || room.trick.plays.length !== pl || p.connected) return;
    const legal = legalCards(room, p);
    if (legal.length) {
      playCard(room, p, legal[crypto.randomInt(legal.length)]);
      broadcast(room);
    }
  }, 4000);
}

/* ---------- views ---------- */
function view(room, p) {
  const t = room.trick;
  const playing = room.phase === 'playing';
  const target = playing ? canRequest(room, p) : null;
  return {
    code: room.code, phase: room.phase, hostId: room.hostId, settings: room.settings,
    turn: playing ? room.turn : null, trickNo: room.trickNo, discarded: room.discarded,
    leadSuit: playing && t ? t.leadSuit : null, firstTrick: playing && t ? t.first : false,
    plays: playing && t ? t.plays : [], loserId: room.loserId,
    event: room.event, log: room.log.slice(-30),
    players: room.players.map(q => ({ id: q.id, name: q.name, count: q.hand.length, connected: q.connected, out: !!q.out, place: q.place || 0 })),
    you: {
      id: p.id, hand: p.hand, legal: legalCards(room, p), reveal: p.reveal,
      canRequest: !!target, requestTarget: target ? target.name : null,
    },
  };
}
function send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) if (p.ws) send(p.ws, { t: 'state', s: view(room, p) });
}

/* ---------- connection handling ---------- */
const cleanName = (n, room) => {
  let base = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';
  let name = base, i = 2;
  while (room && room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) name = `${base} ${i++}`;
  return name;
};

function addPlayer(room, ws, name) {
  const p = { id: uid(), token: uid() + uid(), name: cleanName(name, room), ws, connected: true, hand: [], out: false, place: 0, reveal: null, requestedThisTurn: false };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  ws.ctx = { room, p };
  send(ws, { t: 'joined', code: room.code, token: p.token });
  return p;
}

function removeFromLobby(room, p) {
  room.players = room.players.filter(q => q !== p);
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players[0].id;
}

function handle(ws, m) {
  if (m.t === 'create') {
    const room = { code: roomCode(), players: [], hostId: null, settings: { requestMode: 'elimination' }, phase: 'lobby', trick: null, trickNo: 0, log: [], discarded: 0, loserId: null, seq: 0, event: null, outCounter: 0, lastActive: Date.now() };
    rooms.set(room.code, room);
    addPlayer(room, ws, m.name);
    return broadcast(room);
  }
  if (m.t === 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', m: 'Room not found. Check the code.' });
    if (room.phase !== 'lobby') return send(ws, { t: 'error', m: 'That game has already started.' });
    if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', m: 'Room is full (8 players max).' });
    addPlayer(room, ws, m.name);
    return broadcast(room);
  }
  if (m.t === 'rejoin') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && room.players.find(q => q.token === m.token);
    if (!p) return send(ws, { t: 'rejoinFail' });
    if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch (e) {} }
    p.ws = ws; p.connected = true; ws.ctx = { room, p };
    send(ws, { t: 'joined', code: room.code, token: p.token });
    return broadcast(room);
  }
  if (!ws.ctx) return;
  const { room, p } = ws.ctx;
  const isHost = room.hostId === p.id;

  switch (m.t) {
    case 'settings':
      if (!isHost || room.phase !== 'lobby') return;
      if (['off', 'elimination', 'reveal'].includes(m.requestMode)) room.settings.requestMode = m.requestMode;
      return broadcast(room);
    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return;
      const q = byId(room, m.id);
      if (!q || q === p) return;
      if (q.ws) { send(q.ws, { t: 'kicked' }); q.ws.ctx = null; }
      removeFromLobby(room, q);
      return broadcast(room);
    }
    case 'start':
      if (!isHost || room.phase !== 'lobby') return;
      if (room.players.length < MIN_PLAYERS) return send(ws, { t: 'error', m: `Need at least ${MIN_PLAYERS} players.` });
      startGame(room);
      return broadcast(room);
    case 'play': {
      if (room.phase !== 'playing' || room.turn !== p.id) return;
      const card = String(m.card);
      if (!legalCards(room, p).includes(card)) return send(ws, { t: 'error', m: 'You can’t play that card.' });
      playCard(room, p, card);
      return broadcast(room);
    }
    case 'request': {
      const err = doRequest(room, p);
      if (err) return send(ws, { t: 'error', m: err });
      return broadcast(room);
    }
    case 'rematch':
      if (!isHost || room.phase !== 'over') return;
      room.phase = 'lobby'; room.trick = null; room.event = null;
      room.players = room.players.filter(q => q.connected);
      room.players.forEach(q => { q.hand = []; q.out = false; q.place = 0; q.reveal = null; });
      if (!room.players.some(q => q.id === room.hostId)) room.hostId = room.players[0].id;
      return broadcast(room);
    case 'leave': {
      ws.ctx = null;
      if (room.phase === 'lobby') { removeFromLobby(room, p); if (rooms.has(room.code)) broadcast(room); }
      else { p.connected = false; p.ws = null; scheduleBot(room); broadcast(room); }
      return;
    }
  }
}

/* ---------- http + ws ---------- */
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUB, u));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  ws.isAlive = true; ws.ctx = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); send(ws, { t: 'error', m: 'Server error.' }); }
  });
  ws.on('close', () => {
    const c = ws.ctx; if (!c) return;
    const { room, p } = c;
    if (p.ws !== ws) return;
    p.ws = null; p.connected = false;
    if (room.phase === 'lobby') { removeFromLobby(room, p); if (rooms.has(room.code)) broadcast(room); }
    else { scheduleBot(room); broadcast(room); }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.players.some(p => p.connected) && now - room.lastActive > 30 * 60 * 1000) { clearTimeout(room.botTimer); rooms.delete(code); }
  }
}, 30000);

server.listen(PORT, () => console.log(`Thulla server running on http://localhost:${PORT}`));
