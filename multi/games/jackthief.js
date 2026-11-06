'use strict';
// JACK THIEF (Old-Maid style) — 2–10 players. One random Jack is removed and all 51 cards are dealt.
// SORT phase: every player throws away their own pairs (same rank) face-up, so everyone can see what is out,
// then taps Done. Then players take turns drawing one hidden card from the next player. The drawn card goes into
// the drawer's hand (only they see which card it is) and THEY throw the new pair away themselves, then tap Done.
// Whoever is left holding the unpaired Jack is the Jack Thief.
const crypto = require('crypto');
const { later, setEvent, num } = require('../net');
const { rank, newDeck, shuffle, label } = require('../cards');

const cfg = {
  SORT_MS: num(process.env.SORT_MS, 90000),
  TURN_MS: num(process.env.TURN_MS, 60000),
  SETTLE_MS: num(process.env.SETTLE_MS, 1600),
  BOT_MS: Math.max(1, num(process.env.BOT_MS, 3000)),
};
const byId = (room, id) => room.players.find(p => p.id === id);

function nextHolder(room, p) {
  const n = room.players.length, dir = room.settings.direction === 'ccw' ? -1 : 1;
  const s = room.players.indexOf(p);
  for (let i = 1; i < n; i++) {
    const q = room.players[(s + dir * i + n * 2) % n];
    if (q.hand.length) return q;
  }
  return null;
}

const hasPair = hand => { const seen = new Set(); return hand.some(c => seen.has(rank(c)) || !seen.add(rank(c))); };

/* helper for bots / timeouts: throw every pair a hand still holds */
function dropPairs(hand) {
  const by = {};
  for (const c of hand) (by[rank(c)] = by[rank(c)] || []).push(c);
  const keep = [], dropped = [];
  for (const r in by) { const cs = by[r]; if (cs.length % 2) keep.push(cs.pop()); dropped.push(...cs); }
  return { keep, dropped };
}

function start(room) {
  clearTimeout(room.timer); room.timer = null; room.gen++;
  room.phase = 'playing';
  room.g = { stage: 'sort', turn: null, seq: 0, event: null, thrown: [], pick: null, turnUntil: 0, sortUntil: 0, thiefId: null, last: null, fx: 0, ready: [] };
  const g = room.g;
  const deck = newDeck();
  const jacks = deck.filter(c => rank(c) === 11);
  deck.splice(deck.indexOf(jacks[crypto.randomInt(jacks.length)]), 1);   // one random Jack removed
  room.players.forEach(p => { p.hand = []; p.out = false; p.place = 0; });
  deck.forEach((c, i) => room.players[i % room.players.length].hand.push(c));   // ALL cards dealt, nothing thrown yet
  room.players.forEach(p => { p.hand = shuffle(p.hand); });
  g.sortUntil = Date.now() + cfg.SORT_MS;
  setEvent(room, 'start', 'Cards dealt — throw away your pairs, then tap Done');
  for (const p of room.players) if (!p.connected) autoSort(room, p);
  if (room.players.every(q => g.ready.includes(q.id))) return beginPlay(room);
  later(room, cfg.SORT_MS, () => { room.players.forEach(p => autoSort(room, p)); beginPlay(room); });
}

function autoSort(room, p) {
  const g = room.g;
  if (g.ready.includes(p.id)) return;
  const { keep, dropped } = dropPairs(p.hand);
  p.hand = shuffle(keep); g.thrown.push(...dropped);
  g.ready.push(p.id);
}

function throwPair(room, p, a, b) {
  const g = room.g;
  const resolving = g.stage === 'resolve' && g.turn === p.id;
  if (g.stage !== 'sort' && !resolving) return 'You can only throw pairs at the start or after drawing.';
  if (g.stage === 'sort' && g.ready.includes(p.id)) return 'You already tapped Done.';
  if (typeof a !== 'string' || typeof b !== 'string' || a === b || !p.hand.includes(a) || !p.hand.includes(b)) return 'Pick two cards from your hand.';
  if (rank(a) !== rank(b)) return 'Those two cards are not a pair.';
  p.hand.splice(p.hand.indexOf(a), 1); p.hand.splice(p.hand.indexOf(b), 1);
  g.thrown.push(a, b);
  if (resolving) setEvent(room, 'draw', `${p.name} threw away a pair of ${label(a).replace(/[♠♥♦♣]/g, '')}s`);
  return null;
}

function done(room, p) {
  const g = room.g;
  if (g.stage === 'resolve') {
    if (g.turn !== p.id) return 'It is not your turn.';
    if (hasPair(p.hand)) return 'You still hold a pair — throw it away first.';
    endResolve(room, p);
    return null;
  }
  if (g.stage !== 'sort') return null;
  if (hasPair(p.hand)) return 'You still hold a pair — throw it away first.';
  if (!g.ready.includes(p.id)) g.ready.push(p.id);
  if (room.players.every(q => g.ready.includes(q.id))) beginPlay(room);
  return null;
}

function beginPlay(room) {
  const g = room.g;
  clearTimeout(room.timer); room.timer = null;
  const holders = room.players.filter(p => p.hand.length);
  if (holders.length <= 1) return finish(room);
  const first = holders[crypto.randomInt(holders.length)];
  setEvent(room, 'start', `Everyone is ready. ${first.name} draws first`);
  setTurn(room, first);
}

function setTurn(room, p) {
  const g = room.g;
  const victim = nextHolder(room, p);
  g.stage = 'turn'; g.turn = p.id;
  g.pick = { pid: p.id, fromId: victim.id, n: victim.hand.length, perm: shuffle(victim.hand.map((_, i) => i)) };
  g.turnUntil = Date.now() + cfg.TURN_MS;
  scheduleBot(room);
}

function draw(room, p, i) {
  const g = room.g, pk = g.pick;
  const victim = byId(room, pk.fromId);
  clearTimeout(room.timer); room.timer = null;
  const card = victim.hand.splice(pk.perm[i], 1)[0];
  p.hand.push(card); p.hand = shuffle(p.hand);
  g.last = { id: ++g.fx, pid: p.id, fromId: victim.id, card };
  g.stage = 'resolve'; g.pick = null; g.turn = p.id; g.from = victim.id;
  g.turnUntil = Date.now() + cfg.TURN_MS;
  setEvent(room, 'draw', `${p.name} drew a card from ${victim.name}`);
  scheduleBot(room);
}

/* the drawer has thrown any new pair and tapped Done (or ran out of time): pass the turn on */
function endResolve(room, p) {
  const g = room.g;
  clearTimeout(room.timer); room.timer = null;
  const victim = byId(room, g.from);
  g.stage = 'settle'; g.turn = null;
  const holders = room.players.filter(q => q.hand.length);
  if (holders.length <= 1) return later(room, cfg.SETTLE_MS, () => finish(room));
  later(room, cfg.SETTLE_MS, () => {
    // the victim plays next (or, if they just ran out, the next holder in turn order)
    const nxt = victim.hand.length ? victim : (p.hand.length ? nextHolder(room, victim) || p : nextHolder(room, p));
    const who = nxt && nxt.hand.length ? nxt : room.players.find(q => q.hand.length);
    setTurn(room, who);
  });
}

function finish(room) {
  const g = room.g;
  clearTimeout(room.timer); room.timer = null;
  const thief = room.players.find(p => p.hand.length) || null;
  room.phase = 'over'; g.stage = 'over'; g.turn = null; g.pick = null;
  g.thiefId = thief ? thief.id : null;
  setEvent(room, 'over', thief ? `${thief.name} is the Jack Thief!` : 'Nobody holds the Jack — draw!');
}

function scheduleBot(room) {
  const g = room.g;
  if (room.phase !== 'playing' || (g.stage !== 'turn' && g.stage !== 'resolve')) return;
  clearTimeout(room.timer); room.timer = null;
  const p = byId(room, g.turn);
  if (!p) return;
  const turn = g.turn, stage = g.stage, gen = room.gen;
  const remaining = Math.max(0, g.turnUntil - Date.now());
  const wait = p.connected ? remaining : Math.min(remaining, cfg.BOT_MS);
  later(room, Math.max(1, wait), () => {
    if (room.gen !== gen || g.stage !== stage || g.turn !== turn) return;
    if (p.connected && Date.now() < g.turnUntil - 5) return scheduleBot(room);
    if (stage === 'resolve') {
      if (p.connected) setEvent(room, 'info', `${p.name} ran out of time — pairs were thrown for them`);
      const { keep, dropped } = dropPairs(p.hand);
      p.hand = shuffle(keep); g.thrown.push(...dropped);
      return endResolve(room, p);
    }
    if (p.connected) setEvent(room, 'info', `${p.name} ran out of time — a card was drawn for them`);
    draw(room, p, crypto.randomInt(g.pick.perm.length));
  });
}

function action(room, p, m) {
  const g = room.g;
  switch (m.a) {
    case 'throw': return throwPair(room, p, m.cards && m.cards[0], m.cards && m.cards[1]);
    case 'done': return done(room, p);
    case 'draw': {
      if (g.stage !== 'turn' || g.turn !== p.id || !g.pick) return 'It is not your turn.';
      if (!Number.isInteger(m.i) || m.i < 0 || m.i >= g.pick.perm.length) return 'Pick one of the cards.';
      draw(room, p, m.i);
      return null;
    }
  }
  return 'Unknown action.';
}

function view(room, p) {
  const g = room.g;
  const playing = room.phase === 'playing';
  const over = room.phase === 'over';
  return {
    phase: room.phase, stage: g.stage, turn: playing && (g.stage === 'turn' || g.stage === 'resolve') ? g.turn : null,
    pick: playing && g.pick ? { pid: g.pick.pid, fromId: g.pick.fromId, n: g.pick.n } : null,
    last: g.last ? { id: g.last.id, pid: g.last.pid, fromId: g.last.fromId,
      card: g.last.pid === p.id || over ? g.last.card : null } : null,
    thrown: g.thrown, ready: g.ready, sortMs: g.stage === 'sort' ? Math.max(0, g.sortUntil - Date.now()) : 0,
    thiefId: g.thiefId, event: g.event,
    timer: playing && (g.stage === 'turn' || g.stage === 'resolve') && g.turn ? { pid: g.turn, ms: Math.max(0, g.turnUntil - Date.now()) } : null,
    direction: room.settings.direction,
    seats: room.players.map(q => ({ id: q.id, count: q.hand.length, ready: g.ready.includes(q.id) })),
    you: { hand: p.hand, mustDraw: playing && g.stage === 'turn' && g.turn === p.id, resolving: playing && g.stage === 'resolve' && g.turn === p.id,
      drawn: playing && g.stage === 'resolve' && g.turn === p.id && g.last ? g.last.card : null, done: g.ready.includes(p.id), pairs: hasPair(p.hand) },
  };
}

function onPresence(room, p) {
  if (room.phase !== 'playing') return;
  const g = room.g;
  if (g.stage === 'sort') {
    if (p && !p.connected) { autoSort(room, p); if (room.players.every(q => g.ready.includes(q.id))) beginPlay(room); }
    return;
  }
  scheduleBot(room);
}
function reset(room) { clearTimeout(room.timer); room.timer = null; room.gen++; room.g = null; room.players.forEach(p => { p.hand = []; }); }

module.exports = {
  id: 'jackthief', name: 'Jack Thief', min: 2, max: 10,
  defaults: () => ({ direction: 'cw' }),
  settings: [{ key: 'direction', label: 'Draw direction', options: [
    { value: 'cw', label: 'Clockwise' }, { value: 'ccw', label: 'Anti-clockwise' } ] }],
  start, action, view, onPresence, reset, cfg,
};
