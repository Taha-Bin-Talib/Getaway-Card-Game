'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const num = (v, d) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);
const SETTLE_MS = num(process.env.SETTLE_MS, 1800);        // how long a finished trick stays on the table
const THULLA_MS = num(process.env.SETTLE_MS, 2600);        // ...and a Thulla (pick-up) trick
const CONSENT_MS = num(process.env.CONSENT_MS, 15000);     // how long the asked player has to answer a hand request
const TURN_MS = num(process.env.TURN_MS, 60000);           // time to make your move before the server plays for you
const REQUEST_MAX_CARDS = 5;                                // a hand can only be requested from a player holding FEWER than this many cards
const BOT_MS = Math.max(1, num(process.env.BOT_MS, 4000)); // auto-play delay for disconnected players
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

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(r + s);
  return shuffle(d);
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
function makeRoom() {
  return {
    code: roomCode(), players: [], hostId: null, settings: { requestMode: 'elimination' },
    phase: 'lobby', stage: 'lobby', trick: null, trickNo: 0, discarded: 0, loserId: null,
    seq: 0, event: null, outCounter: 0, lastActive: Date.now(),
    turn: null, consent: null, pick: null, settle: null, lastTrick: null, fxSeq: 0,
    timer: null, gen: 0, duelSeen: false, turnUntil: 0,
  };
}
const byId = (room, id) => room.players.find(p => p.id === id);
const seatOf = (room, p) => room.players.indexOf(p);
const nonOut = room => room.players.filter(p => !p.out);

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
function setEvent(room, type, text) { room.event = { seq: ++room.seq, type, text }; }

/* Run fn after ms (or right now when ms <= 0). Only one pending timer per room;
   the timer is tied to the current game so a stale one can never fire in a new game. */
function later(room, ms, fn) {
  clearTimeout(room.timer); room.timer = null;
  if (ms <= 0) return fn();
  const gen = room.gen;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.gen !== gen || room.phase !== 'playing') return;
    try { fn(); } catch (e) { console.error(e); }
    broadcast(room);
  }, ms);
}

/* ---------- game flow ---------- */
function startGame(room) {
  clearTimeout(room.timer); room.timer = null; room.gen++;
  room.phase = 'playing'; room.stage = 'turn';
  room.loserId = null; room.discarded = 0; room.trickNo = 0; room.outCounter = 0;
  room.consent = null; room.pick = null; room.settle = null; room.lastTrick = null; room.fxSeq = 0; room.duelSeen = false;
  room.players.forEach(p => { p.hand = []; p.out = false; p.place = 0; p.reveal = null; p.requestedThisTurn = false; });
  const deck = newDeck();
  deck.forEach((c, i) => room.players[i % room.players.length].hand.push(c));
  room.players.forEach(p => sortHand(p.hand));
  const leader = room.players.find(p => p.hand.includes('14S'));
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
  room.stage = 'turn';
  room.turn = pid;
  room.consent = null; room.pick = null; room.settle = null;
  const p = byId(room, pid);
  if (p) p.requestedThisTurn = false;          // one hand request per turn
  room.turnUntil = Date.now() + TURN_MS;       // 1-minute move timer
  scheduleBot(room);
}

function legalCards(room, p) {
  if (room.phase !== 'playing' || room.stage !== 'turn' || room.turn !== p.id) return [];
  const t = room.trick;
  if (t.plays.length === 0) return t.first ? p.hand.filter(c => c === '14S') : p.hand.slice();
  const same = p.hand.filter(c => suit(c) === t.leadSuit);
  if (same.length) return same;
  return t.first ? p.hand.filter(c => rank(c) < 10) : p.hand.slice();   // first round, no spade: any card below 10
}

function playCard(room, p, cardId) {
  const t = room.trick;
  p.hand.splice(p.hand.indexOf(cardId), 1);
  p.reveal = null;
  const isLead = t.plays.length === 0;
  const off = !isLead && suit(cardId) !== t.leadSuit;
  if (isLead) t.leadSuit = suit(cardId);
  t.plays.push({ pid: p.id, card: cardId });
  room.turn = null;
  if (off && !t.first) return resolveThulla(room, p, cardId);   // the first round can never be a Thulla
  advance(room, p);
}

function advance(room, mover) {
  const t = room.trick;
  t.pos++;
  // first round: no-spade players throw a card below 10 (or pass if they have none)
  while (t.pos < t.order.length && t.first) {
    const q = byId(room, t.order[t.pos]);
    if (q.hand.some(c => suit(c) === t.leadSuit || rank(c) < 10)) break;   // can follow with a spade, or throw a card below 10
    t.pos++;                                                                // otherwise passes
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

/* ---- trick resolution (the finished trick stays on the table for a moment) ---- */
function resolveThulla(room, thrower, card) {
  const t = room.trick;
  const best = highest(room);
  const taker = byId(room, best.pid);
  const plays = t.plays.slice();
  const text = `THULLA! ${taker.name} picks up ${plays.length} cards`;
  room.stage = 'settle'; room.turn = null; room.consent = null;
  room.settle = { kind: 'thulla', toId: taker.id, bestPid: taker.id, text };
  setEvent(room, 'thulla', text);
  later(room, THULLA_MS, () => {
    taker.hand.push(...plays.map(x => x.card));
    sortHand(taker.hand);
    room.lastTrick = { id: ++room.fxSeq, kind: 'thulla', toId: taker.id, plays };
    room.settle = null;
    finishTrick(room, taker);
  });
}

function resolveNormal(room) {
  const t = room.trick;
  const best = highest(room);
  const winner = byId(room, best.pid);
  const plays = t.plays.slice();
  room.stage = 'settle'; room.turn = null; room.consent = null;
  room.settle = { kind: 'discard', toId: null, bestPid: winner.id, text: `${winner.name} wins the trick` };
  if (t.first) setEvent(room, 'info', 'First round safe — cards discarded');
  later(room, SETTLE_MS, () => {
    room.discarded += plays.length;
    room.lastTrick = { id: ++room.fxSeq, kind: 'discard', toId: null, plays };
    room.settle = null;
    afterDiscard(room, winner);
  });
}

/* The winner of a discarded trick normally leads next.
   FINAL DUEL (exactly two players still in the game): if a player's LAST card wins the trick,
   they are not safe — they must blindly pick one card from the other player's hand and lead it.
   If their last card LOSES the trick, they are out/safe and the game ends. */
function afterDiscard(room, winner) {
  const live = nonOut(room);
  if (live.length === 2) {
    const empty = live.filter(p => p.hand.length === 0);
    if (empty.length === 1 && empty[0] === winner) {
      return startPick(room, winner, live.find(p => p !== winner));
    }
  }
  const leader = winner.hand.length > 0 ? winner : nextActiveAfter(room, winner);
  finishTrick(room, leader);
}

function startPick(room, picker, other) {
  room.trickNo++;
  room.trick = { first: false, leadSuit: null, plays: [], order: [picker.id, other.id], pos: 0 };
  room.stage = 'pick'; room.turn = picker.id; room.consent = null;
  room.pick = { pid: picker.id, fromId: other.id, perm: shuffle(other.hand.map((_, i) => i)) };
  room.turnUntil = Date.now() + TURN_MS;
  setEvent(room, 'duel', `⚔ ${picker.name}'s last card won — picks a card from ${other.name}`);
  scheduleBot(room);
}

function doPick(room, p, i) {
  const pk = room.pick;
  if (room.phase !== 'playing' || room.stage !== 'pick' || !pk || pk.pid !== p.id) return 'You can’t pick a card right now.';
  if (!Number.isInteger(i) || i < 0 || i >= pk.perm.length) return 'Pick one of the cards.';
  const other = byId(room, pk.fromId);
  clearTimeout(room.timer); room.timer = null;
  const card = other.hand.splice(pk.perm[i], 1)[0];   // blind pick (random permutation hides hand order)
  p.hand.push(card);
  room.pick = null;
  setEvent(room, 'pick', `${p.name} picked a card from ${other.name}`);
  if (other.hand.length === 0) {                       // took their very last card: they are safe, picker is stuck with it
    markOuts(room);
    return endGame(room, p);
  }
  room.stage = 'turn';
  playCard(room, p, card);                             // ...and deals it straight away
  return null;
}

function markOut(room, p) { if (!p.out) { p.out = true; p.place = ++room.outCounter; } }
function markOuts(room) { for (const p of room.players) if (p.hand.length === 0) markOut(room, p); }

function finishTrick(room, leader) {
  markOuts(room);
  const active = room.players.filter(p => p.hand.length > 0);
  if (active.length <= 1 || !leader || leader.hand.length === 0) return endGame(room, active[0] || null);
  if (!room.duelSeen && nonOut(room).length === 2) {
    room.duelSeen = true;
    setEvent(room, 'duel', '⚔ Final duel — two players left!');
  }
  newTrick(room, leader, false);
}

function endGame(room, loser) {
  room.phase = 'over'; room.stage = 'over';
  room.turn = null; room.consent = null; room.pick = null; room.settle = null;
  room.loserId = loser ? loser.id : null;
  clearTimeout(room.timer); room.timer = null;
  if (loser) setEvent(room, 'over', `${loser.name} is the Bhabhi!`);
  else setEvent(room, 'over', 'Nobody is the Bhabhi — draw!');
}

/* ---- hand requests: BEFORE you deal your card, and the asked player must agree ---- */
function canRequest(room, p) {
  if (room.phase !== 'playing' || room.stage !== 'turn' || room.turn !== p.id) return null;
  if (p.requestedThisTurn || room.settings.requestMode === 'off') return null;
  const t = room.trick;
  if (t.first || p.hand.length === 0 || nonOut(room).length <= 2) return null;   // not in the opening trick / final duel
  const target = byId(room, t.order[t.pos + 1]);                                   // next player, who hasn't played yet
  if (!target || target === p || target.hand.length === 0) return null;
  if (target.hand.length >= REQUEST_MAX_CARDS) return null;                        // only players with fewer than 5 cards can be asked
  return target;
}

function doRequest(room, p) {
  const target = canRequest(room, p);
  if (!target) return 'You cannot request a hand right now.';
  p.requestedThisTurn = true;
  if (!target.connected) {
    setEvent(room, 'request', `${target.name} is away — request declined`);
    return null;                                          // still your turn, just play
  }
  room.stage = 'consent'; room.turn = null;
  room.consent = { pid: p.id, targetId: target.id, until: Date.now() + CONSENT_MS };
  setEvent(room, 'request', `${p.name} asks ${target.name} for their hand…`);
  later(room, CONSENT_MS, () => resolveConsent(room, false));   // no answer = no
  return null;
}

function doRespond(room, p, accept) {
  if (room.phase !== 'playing' || room.stage !== 'consent' || !room.consent || room.consent.targetId !== p.id) {
    return 'Nobody is asking for your hand right now.';
  }
  resolveConsent(room, !!accept);
  return null;
}

function resolveConsent(room, accept) {
  clearTimeout(room.timer); room.timer = null;
  if (room.stage !== 'consent' || !room.consent) return;
  const p = byId(room, room.consent.pid), target = byId(room, room.consent.targetId), t = room.trick;
  room.consent = null;
  if (!accept) {
    setEvent(room, 'request', `${target.name} refused ${p.name}'s request`);
  } else if (room.settings.requestMode === 'reveal') {
    p.reveal = { name: target.name, hand: sortHand(target.hand.slice()) };
    setEvent(room, 'request', `${target.name} showed their hand to ${p.name}`);
  } else {
    const n = target.hand.length;
    p.hand.push(...target.hand);
    sortHand(p.hand);
    target.hand = [];
    t.order.splice(t.order.indexOf(target.id), 1);
    markOut(room, target);
    setEvent(room, 'request', `${target.name} gave ${n} cards to ${p.name}!`);
  }
  room.stage = 'turn'; room.turn = p.id;                  // back to the requester: now they must play a card
  scheduleBot(room);
}

/* Move timer: a connected player who doesn't move within TURN_MS gets their HIGHEST legal card played
   (highest card of the suit being followed; highest card overall when leading). Disconnected players are
   auto-played quickly (random legal card) so the table never stalls. Duel picks time out randomly. */
function scheduleBot(room) {
  if (room.phase !== 'playing') return;
  if (room.stage !== 'turn' && room.stage !== 'pick') return;   // other stages already run on their own timer
  clearTimeout(room.timer); room.timer = null;
  const p = byId(room, room.turn);
  if (!p) return;
  const stage = room.stage, turn = room.turn, gen = room.gen;
  const remaining = Math.max(0, room.turnUntil - Date.now());
  const wait = p.connected ? remaining : Math.min(remaining, BOT_MS);
  later(room, Math.max(1, wait), () => {
    if (room.gen !== gen || room.stage !== stage || room.turn !== turn) return;
    const due = Date.now() >= room.turnUntil - 5;
    if (p.connected && !due) return scheduleBot(room);          // player is back / not due yet
    if (stage === 'pick') {
      if (p.connected) setEvent(room, 'info', `${p.name} ran out of time — a card was picked for them`);
      return void doPick(room, p, crypto.randomInt(room.pick.perm.length));
    }
    const legal = legalCards(room, p);
    if (!legal.length) return;
    if (p.connected) {
      const card = legal.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      setEvent(room, 'info', `${p.name} ran out of time — highest card played`);
      playCard(room, p, card);
    } else {
      playCard(room, p, legal[crypto.randomInt(legal.length)]);
    }
  });
}

/* ---------- views ---------- */
function view(room, p) {
  const t = room.trick;
  const playing = room.phase === 'playing';
  const consent = playing && room.stage === 'consent' ? room.consent : null;
  const pick = playing && room.stage === 'pick' ? room.pick : null;
  const target = canRequest(room, p);
  return {
    code: room.code, phase: room.phase, stage: room.stage, hostId: room.hostId, settings: room.settings,
    turn: playing && room.stage === 'turn' ? room.turn : null, trickNo: room.trickNo, discarded: room.discarded,
    leadSuit: playing && t ? t.leadSuit : null, firstTrick: playing && t ? t.first : false,
    plays: playing && t ? t.plays : [], loserId: room.loserId,
    settle: playing ? room.settle : null,
    consent: consent ? { pid: consent.pid, targetId: consent.targetId, ms: Math.max(0, consent.until - Date.now()) } : null,
    pick: pick ? { pid: pick.pid, fromId: pick.fromId, n: pick.perm.length } : null,
    timer: playing && (room.stage === 'turn' || room.stage === 'pick') && room.turn ? { pid: room.turn, ms: Math.max(0, room.turnUntil - Date.now()) } : null,
    duel: playing && nonOut(room).length === 2,
    lastTrick: room.lastTrick,
    event: room.event,
    players: room.players.map(q => ({ id: q.id, name: q.name, count: q.hand.length, connected: q.connected, out: !!q.out, place: q.place || 0 })),
    you: {
      id: p.id, hand: p.hand, legal: legalCards(room, p), reveal: p.reveal,
      canRequest: !!target, requestTarget: target ? target.name : null,
      mustPick: !!(pick && pick.pid === p.id),
      mustAnswer: !!(consent && consent.targetId === p.id),
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

function reassignHost(room) {                       // keep a connected host so "Play again" always works
  const h = byId(room, room.hostId);
  if (h && h.connected) return;
  const next = room.players.find(q => q.connected);
  if (next) room.hostId = next.id;
}

function removeFromLobby(room, p) {
  room.players = room.players.filter(q => q !== p);
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players[0].id;
}

function handle(ws, m) {
  if (m.t === 'create') {
    const room = makeRoom();
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
      if (room.phase !== 'playing' || room.stage !== 'turn' || room.turn !== p.id) return;
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
    case 'respond': {                                   // asked player: give the hand away (true) or keep it
      const err = doRespond(room, p, m.accept === true);
      if (err) return send(ws, { t: 'error', m: err });
      return broadcast(room);
    }
    case 'pick': {
      const err = doPick(room, p, m.i);
      if (err) return send(ws, { t: 'error', m: err });
      return broadcast(room);
    }
    case 'rematch':
      if (!isHost || room.phase !== 'over') return;
      clearTimeout(room.timer); room.timer = null; room.gen++;
      room.phase = 'lobby'; room.stage = 'lobby'; room.trick = null; room.event = null; room.lastTrick = null;
      room.players = room.players.filter(q => q.connected);
      room.players.forEach(q => { q.hand = []; q.out = false; q.place = 0; q.reveal = null; });
      if (!room.players.some(q => q.id === room.hostId)) room.hostId = room.players[0].id;
      return broadcast(room);
    case 'leave': {
      ws.ctx = null;
      if (room.phase === 'lobby') { removeFromLobby(room, p); if (rooms.has(room.code)) broadcast(room); }
      else { p.connected = false; p.ws = null; reassignHost(room); scheduleBot(room); broadcast(room); }
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
    else { reassignHost(room); scheduleBot(room); broadcast(room); }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.players.some(p => p.connected) && now - room.lastActive > 30 * 60 * 1000) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Thulla server running on http://localhost:${PORT}`));
} else {
  // loaded by the rule tests: expose internals, don't open a port
  module.exports = { makeRoom, addPlayer, startGame, newTrick, playCard, doRequest, doRespond, doPick, view, rooms, sortHand };
}
