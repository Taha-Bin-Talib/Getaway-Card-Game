'use strict';
// BLUFF — 3–10 players. All cards are dealt; the holder of A♠ opens.
// A round: the opener puts 1–4 cards face-down and names a rank ("2 Aces"). Then, one player at a time, the next
// player may CALL BLUFF on the last play, ADD 1 or 2 more face-down cards to the pile (the claim grows, same rank),
// or PASS. If everybody else passes, the player who made the last play gets another go (they can't call themselves):
// they may ADD more, which starts the passing round again, or PASS. Only when they pass too (N-1 passes + their own)
// is the pile thrown away and they open a new round.
// A called play is revealed: if it was a lie the player who played it picks up the pile, otherwise the caller does.
// The one who picks up the pile opens the next round. A player who empties their hand without being caught is SAFE
// (out of the game); play goes on until only one player still holds cards — that player loses.
const crypto = require('crypto');
const { later, setEvent, num } = require('../net');
const { rank, sortHand, newDeck, rankName, rankWord } = require('../cards');
const bots = require('../bots');

const cfg = {
  TURN_MS: num(process.env.TURN_MS, 60000),
  REVEAL_MS: num(process.env.REVEAL_MS, 3500),
  BOT_MS: Math.max(1, num(process.env.BOT_MS, 4000)),
  MAX_OPEN: 4, MAX_ADD: 2,
};
const byId = (room, id) => room.players.find(p => p.id === id);
const holders = room => room.players.filter(p => p.hand.length > 0);
function markOut(room, p) { if (!p.out && p.hand.length === 0) { p.out = true; p.place = ++room.g.outCounter; } }
/* the game is over as soon as at most one player still holds cards */
function checkEnd(room) {
  const h = holders(room);
  if (h.length > 1) return false;
  endGame(room, h[0] || null);
  return true;
}

/* next player clockwise after `p` who still has cards (and isn't `skip`) */
function nextAfter(room, p, skip) {
  const n = room.players.length, s = room.players.indexOf(p);
  for (let i = 1; i <= n; i++) {
    const q = room.players[(s + i) % n];
    if (q.hand.length && q !== skip) return q;
  }
  return null;
}

function decksFor(room) {
  const d = room.settings.decks;
  if (d === '2') return 2;
  if (d === '1') return 1;
  return room.players.length >= 6 ? 2 : 1;
}

function start(room) {
  clearTimeout(room.timer); room.timer = null; room.gen++;
  room.phase = 'playing';
  const copies = decksFor(room);
  room.g = { stage: 'open', turn: null, seq: 0, event: null, pile: [], claim: null, last: null, passes: 0, reveal: null,
    winnerId: null, loserId: null, outCounter: 0, turnUntil: 0, decks: copies, fx: 0, gone: 0, known: {} };
  room.players.forEach(p => { p.hand = []; p.out = false; p.place = 0; });
  newDeck(copies).forEach((c, i) => room.players[i % room.players.length].hand.push(c));
  room.players.forEach(p => sortHand(p.hand));
  const starter = room.players.find(p => p.hand.includes('14S')) || room.players[0];
  setEvent(room, 'start', `${starter.name} opens — choose a rank`);
  setOpen(room, starter);
}

function setOpen(room, p) {
  const g = room.g;
  g.stage = 'open'; g.turn = p.id; g.claim = null; g.pile = []; g.passes = 0; g.own = false; g.reveal = null;
  g.turnUntil = Date.now() + cfg.TURN_MS;
  scheduleTurn(room);
}

function giveTurnToResponder(room, from, adder) {
  const g = room.g;
  const nxt = nextAfter(room, from, adder);
  if (!nxt) return roundEnd(room);
  g.stage = 'respond'; g.turn = nxt.id;
  g.turnUntil = Date.now() + cfg.TURN_MS;
  scheduleTurn(room);
}

function putCards(room, p, cards, text) {
  const g = room.g;
  const knew = (g.known[p.id] || []).slice();                // cards everybody saw this player pick up (used by computer seats)
  g.known[p.id] = knew.filter(c => !cards.includes(c));
  for (const c of cards) p.hand.splice(p.hand.indexOf(c), 1);
  g.pile.push(...cards);
  g.last = { id: ++g.fx, pid: p.id, cards: cards.slice(), n: cards.length, knew };
  g.passes = 0; g.own = false;
  setEvent(room, 'claim', text);
}

function open(room, p, r, cards) {
  const g = room.g;
  putCards(room, p, cards, `${p.name}: ${rankWord(r, cards.length)}`);
  g.claim = { rank: r, count: cards.length, by: p.id };
  giveTurnToResponder(room, p, p);
}

function add(room, p, cards) {
  const g = room.g;
  const prev = byId(room, g.last.pid);
  if (prev && prev !== p && prev.hand.length === 0) {       // nobody called their last cards: they are safe
    markOut(room, prev);
    setEvent(room, 'info', `${prev.name} got rid of all their cards — safe!`);
  }
  g.claim.count += cards.length;
  g.claim.by = p.id;
  putCards(room, p, cards, `${p.name} adds ${cards.length} — now ${rankWord(g.claim.rank, g.claim.count)}`);
  giveTurnToResponder(room, p, p);
}

function pass(room, p) {
  const g = room.g;
  setEvent(room, 'info', `${p.name} passes`);
  const adder = byId(room, g.last.pid);
  if (g.own) return roundEnd(room);                         // the player who made the last play passes on their extra turn: pile goes
  g.passes++;
  const others = room.players.filter(q => q !== adder && q.hand.length).length;
  if (g.passes >= others) {
    if (!adder.hand.length) return roundEnd(room);          // nothing left to add
    g.stage = 'respond'; g.turn = adder.id; g.own = true;   // everyone else passed: the adder may add again
    g.turnUntil = Date.now() + cfg.TURN_MS;
    setEvent(room, 'info', `Everyone passed — ${adder.name} may add more or pass`);
    return scheduleTurn(room);
  }
  giveTurnToResponder(room, p, adder);
}

/* everybody passed: the pile is thrown away, the last player to add opens a new round (or wins) */
function roundEnd(room) {
  const g = room.g;
  clearTimeout(room.timer); room.timer = null;
  const adder = byId(room, g.last.pid);
  g.gone += g.pile.length; g.pile = [];
  markOut(room, adder);                                    // their (last) play stood: safe if hand is empty
  if (checkEnd(room)) return;
  const opener = adder.hand.length ? adder : nextAfter(room, adder, null);
  setEvent(room, 'info', `Everyone passed — pile thrown away. ${opener.name} opens`);
  setOpen(room, opener);
}

function call(room, caller) {
  const g = room.g, L = g.last;
  const adder = byId(room, L.pid);
  clearTimeout(room.timer); room.timer = null;
  const truthful = L.cards.every(c => rank(c) === g.claim.rank);
  const loser = truthful ? caller : adder;
  const taken = g.pile.length;
  g.stage = 'reveal'; g.turn = null;
  g.reveal = { callerId: caller.id, playerId: adder.id, cards: L.cards.slice(), truthful, loserId: loser.id, rank: g.claim.rank, taken };
  setEvent(room, 'call', truthful
    ? `${caller.name} called — ${adder.name} told the truth! ${caller.name} takes ${taken} cards`
    : `${caller.name} called — ${adder.name} was bluffing! ${adder.name} takes ${taken} cards`);
  later(room, cfg.REVEAL_MS, () => {
    g.known[loser.id] = (g.known[loser.id] || []).concat(L.cards);   // the revealed cards are now public knowledge: the loser holds them
    loser.hand.push(...g.pile); sortHand(loser.hand);
    g.pile = []; g.reveal = null;
    markOut(room, adder);                                  // told the truth with their last cards: safe
    if (checkEnd(room)) return;
    setOpen(room, loser);
  });
}

function endGame(room, loser) {
  const g = room.g;
  clearTimeout(room.timer); room.timer = null;
  for (const q of room.players) markOut(room, q);          // anybody still unmarked with an empty hand
  room.phase = 'over'; g.stage = 'over'; g.turn = null;
  g.loserId = loser ? loser.id : null;
  const first = room.players.find(q => q.place === 1);
  g.winnerId = first ? first.id : null;
  setEvent(room, 'over', loser ? `${loser.name} is left holding the cards — game over!` : 'Game over!');
}

function bestRank(hand) {
  const by = {};
  for (const c of hand) (by[rank(c)] = by[rank(c)] || []).push(c);
  const max = Math.max(...Object.values(by).map(a => a.length));
  const best = Object.keys(by).filter(r => by[r].length === max);
  const r = +best[crypto.randomInt(best.length)];
  return { r, cards: by[r].slice(0, cfg.MAX_OPEN) };
}

function scheduleTurn(room) {
  const g = room.g;
  if (room.phase !== 'playing' || (g.stage !== 'open' && g.stage !== 'respond')) return;
  clearTimeout(room.timer); room.timer = null;
  const p = byId(room, g.turn);
  if (!p) return;
  const turn = g.turn, stage = g.stage, gen = room.gen;
  const remaining = Math.max(0, g.turnUntil - Date.now());
  const wait = p.connected ? remaining : Math.min(remaining, cfg.BOT_MS);
  later(room, Math.max(1, wait), () => {
    if (room.gen !== gen || g.stage !== stage || g.turn !== turn) return;
    if (p.connected && Date.now() < g.turnUntil - 5) return scheduleTurn(room);
    if (stage === 'open') {
      if (p.connected) {
        const { r, cards } = bestRank(p.hand);
        setEvent(room, 'info', `${p.name} ran out of time — cards played for them`);
        return open(room, p, r, cards);
      }
      const { r, cards } = bots.bluffOpen(p, cfg.MAX_OPEN);
      return open(room, p, r, cards);
    }
    if (p.connected) { setEvent(room, 'info', `${p.name} ran out of time — passed`); return pass(room, p); }
    const mv = bots.bluffRespond(room, p, Math.min(cfg.MAX_ADD, p.hand.length));      // a computer seat thinks: call, add or pass
    if (mv.do === 'call' && !g.own) return call(room, p);
    if (mv.do === 'add') return add(room, p, mv.cards);
    pass(room, p);
  });
}

function validCards(p, cards, max) {
  return Array.isArray(cards) && cards.length >= 1 && cards.length <= max &&
    new Set(cards).size === cards.length && cards.every(c => typeof c === 'string' && p.hand.includes(c));
}

function action(room, p, m) {
  const g = room.g;
  switch (m.a) {
    case 'open': {
      if (g.stage !== 'open' || g.turn !== p.id) return 'It is not your turn.';
      const r = Number(m.rank), cards = Array.isArray(m.cards) ? m.cards.map(String) : [];
      if (!Number.isInteger(r) || r < 2 || r > 14) return 'Choose a rank to call.';
      if (!validCards(p, cards, cfg.MAX_OPEN)) return `Play between 1 and ${cfg.MAX_OPEN} cards from your hand.`;
      clearTimeout(room.timer); room.timer = null;
      open(room, p, r, cards);
      return null;
    }
    case 'add': {
      if (g.stage !== 'respond' || g.turn !== p.id) return 'It is not your turn.';
      const cards = Array.isArray(m.cards) ? m.cards.map(String) : [];
      if (!room.players.some(q => q !== p && q.hand.length)) return 'Nobody is left to bluff — call or pass.';
      if (!validCards(p, cards, cfg.MAX_ADD)) return `Add 1 or ${cfg.MAX_ADD} cards from your hand.`;
      clearTimeout(room.timer); room.timer = null;
      add(room, p, cards);
      return null;
    }
    case 'call': {
      if (g.stage !== 'respond' || g.turn !== p.id) return 'It is not your turn.';
      if (!g.pile.length) return 'Nothing to call.';
      if (g.own) return 'You cannot call your own play — add more cards or pass.';
      call(room, p);
      return null;
    }
    case 'pass': {
      if (g.stage !== 'respond' || g.turn !== p.id) return 'It is not your turn.';
      clearTimeout(room.timer); room.timer = null;
      pass(room, p);
      return null;
    }
  }
  return 'Unknown action.';
}

function view(room, p) {
  const g = room.g;
  const playing = room.phase === 'playing';
  const myTurn = playing && g.turn === p.id;
  return {
    phase: room.phase, stage: g.stage, turn: playing && (g.stage === 'open' || g.stage === 'respond') ? g.turn : null,
    claim: g.claim ? { rank: g.claim.rank, name: rankName(g.claim.rank), count: g.claim.count, by: g.claim.by } : null,
    pile: g.pile.length, decks: g.decks,
    last: g.last ? { id: g.last.id, pid: g.last.pid, n: g.last.n } : null,
    reveal: g.reveal,
    timer: playing && g.turn && (g.stage === 'open' || g.stage === 'respond') ? { pid: g.turn, ms: Math.max(0, g.turnUntil - Date.now()) } : null,
    winnerId: g.winnerId, loserId: g.loserId, event: g.event,
    seats: room.players.map(q => ({ id: q.id, count: q.hand.length, out: !!q.out, place: q.place || 0 })),
    you: { hand: p.hand, canCall: myTurn && g.stage === 'respond' && g.pile.length > 0 && !g.own, own: myTurn && !!g.own, maxAdd: Math.min(cfg.MAX_ADD, p.hand.length), maxOpen: Math.min(cfg.MAX_OPEN, p.hand.length) },
  };
}

function onPresence(room) { if (room.phase === 'playing') scheduleTurn(room); }
function reset(room) { clearTimeout(room.timer); room.timer = null; room.gen++; room.g = null; room.players.forEach(p => { p.hand = []; }); }

module.exports = {
  id: 'bluff', name: 'Bluff', min: 3, max: 10,
  defaults: () => ({ decks: 'auto' }),
  settings: [{ key: 'decks', label: 'Decks', options: [
    { value: 'auto', label: 'Auto' }, { value: '1', label: '1 deck' }, { value: '2', label: '2 decks' } ] }],
  start, action, view, onPresence, reset, cfg,
};
