// Deterministic rule tests (no server needed): hand requests with consent + the two-player final duel.
process.env.SETTLE_MS = '0';           // resolve tricks instantly
const assert = require('assert');
const T = require('./server');

const fakeWs = () => ({ readyState: 1, send() {} });
function table(names, hands, { mode = 'elimination', trick = 5 } = {}) {
  const room = T.makeRoom();
  room.settings.requestMode = mode;
  names.forEach(n => T.addPlayer(room, fakeWs(), n));
  room.players.forEach((p, i) => { p.hand = hands[i].slice(); T.sortHand(p.hand); p.out = false; p.place = 0; });
  room.phase = 'playing'; room.stage = 'turn'; room.trickNo = trick;
  return room;
}
const P = (room, n) => room.players.find(p => p.name === n);
const lead = (room, n) => { T.newTrick(room, P(room, n), false); };
const play = (room, n, c) => T.playCard(room, P(room, n), c);
const total = room => room.players.reduce((a, p) => a + p.hand.length, 0) + room.discarded + (room.trick ? room.trick.plays.length : 0);
let n = 0; const pending = []; const ok = (name, fn) => { const v = fn(); n++; if (v && v.then) pending.push(v); console.log('  ✓', name); };

console.log('Final duel');
ok('last card SMALLER than the opponent’s -> game ends, that player is safe', () => {
  const r = table(['A', 'B'], [['3H'], ['9H', '5S']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'A', '3H');
  assert.equal(r.phase, 'over');
  assert.equal(r.loserId, P(r, 'B').id);
  assert(P(r, 'A').out);
});

ok('last card BIGGER -> must blind-pick a card from the opponent and lead it', () => {
  const r = table(['A', 'B'], [['13H'], ['9H', '5S', '2C']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'A', '13H');
  assert.equal(r.phase, 'playing');
  assert.equal(r.stage, 'pick');
  assert.equal(r.pick.pid, P(r, 'A').id);
  assert.equal(r.pick.perm.length, 2);
  const v = T.view(r, P(r, 'A')); assert(v.you.mustPick); assert.equal(v.pick.n, 2);
  assert(!T.view(r, P(r, 'B')).you.mustPick);
  assert.equal(r.turn, P(r, 'A').id);
  // can't pick out of turn / bad index
  assert(T.doPick(r, P(r, 'B'), 0));
  assert(T.doPick(r, P(r, 'A'), 5));
  assert.equal(T.doPick(r, P(r, 'A'), 0), null);
  // A's picked card was dealt (led); B has 1 card left and must answer
  assert.equal(r.trick.plays.length, 1);
  assert.equal(P(r, 'A').hand.length, 0);
  assert.equal(P(r, 'B').hand.length, 1);
  assert.equal(total(r), 4);                                 // no card lost: A 0 + B 1 + table 1 + discarded 2
});

ok('duel: picked card is LOSING (opponent answers bigger) -> picker is safe, opponent is the Bhabhi', () => {
  const r = table(['A', 'B'], [['14H'], ['9H', '8H', '4H', '2H']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'A', '14H');    // A's last card is bigger -> A must pick
  assert.equal(r.stage, 'pick');
  r.pick.perm = [0, 1, 2];                                    // make the "random" pick predictable
  T.doPick(r, P(r, 'A'), 1);                                  // A picks B's 4H and leads it
  assert.equal(r.trick.plays[0].card, '4H');
  play(r, 'B', '8H');                                         // 8H beats 4H: A's last card lost
  assert.equal(r.phase, 'over'); assert.equal(r.loserId, P(r, 'B').id);
  assert(P(r, 'A').out); assert.equal(P(r, 'B').hand.length, 1);
});

ok('duel: picked card WINS again -> pick again, until someone’s last card loses', () => {
  const r = table(['A', 'B'], [['14H'], ['9H', '8H', '4H', '2H']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'A', '14H');
  r.pick.perm = [0, 1, 2];
  T.doPick(r, P(r, 'A'), 1);                                  // A leads 4H
  play(r, 'B', '2H');                                         // 2H is smaller: A's card bigger -> pick again
  assert.equal(r.phase, 'playing'); assert.equal(r.stage, 'pick');
  assert.equal(r.pick.pid, P(r, 'A').id); assert.equal(r.pick.perm.length, 1);
  T.doPick(r, P(r, 'A'), 0);                                  // takes B's only card (8H): B is out
  assert.equal(r.phase, 'over'); assert.equal(r.loserId, P(r, 'A').id);
  assert(P(r, 'B').out); assert.equal(P(r, 'A').hand.length, 1);
});

ok('picking the opponent’s only card: opponent is out, picker keeps it and is the Bhabhi', () => {
  const r = table(['A', 'B'], [['13H'], ['9H', '5S']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'A', '13H');
  assert.equal(r.stage, 'pick');
  T.doPick(r, P(r, 'A'), 0);                                 // B has 1 card left, A takes+leads it
  // B had 5S left (1 card) -> A leads 5S, B has 0 cards -> B out already
  assert.equal(r.phase, 'over'); assert.equal(r.loserId, P(r, 'A').id);
  assert.equal(P(r, 'A').hand.length, 1);
});

ok('both players dump their last card together -> draw', () => {
  const r = table(['A', 'B'], [['3H'], ['9H']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'A', '3H');
  assert.equal(r.phase, 'over'); assert.equal(r.loserId, null);
});

ok('Thulla still works in the duel (no suit -> highest of led suit picks everything up)', () => {
  const r = table(['A', 'B'], [['3C', '4C'], ['9H', '5S']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'A', '3C');
  assert.equal(P(r, 'B').hand.length, 3);                    // B picked up 9H + 3C
  assert.equal(r.phase, 'playing');
});

console.log('Normal rules (3+ players) unchanged');
ok('3 players: last card bigger -> just safe, no pick', () => {
  const r = table(['A', 'B', 'C'], [['13H'], ['9H', '5S'], ['2H', '6D']]);
  lead(r, 'B'); play(r, 'B', '9H'); play(r, 'C', '2H'); play(r, 'A', '13H');
  assert.equal(r.phase, 'playing'); assert.notEqual(r.stage, 'pick');
  assert(P(r, 'A').out);
});

console.log('Hand request: before your card, and the asked player decides');
process.env.CONSENT_MS = '60000';
delete require.cache[require.resolve('./server')];
const T2 = require('./server');
function table2(mode) {
  const r = T2.makeRoom(); r.settings.requestMode = mode;
  ['A', 'B', 'C'].forEach(x => T2.addPlayer(r, fakeWs(), x));
  const h = [['9H', '3D', '4D'], ['2H', '5S', '6S'], ['10H', '7C', '8C']];
  r.players.forEach((p, i) => { p.hand = h[i]; });
  r.phase = 'playing'; r.stage = 'turn'; r.trickNo = 4;
  T2.newTrick(r, r.players[0], false);
  return r;
}
ok('on your turn, BEFORE playing, you can request the next player (and only you)', () => {
  const r = table2('elimination');
  const v = T2.view(r, r.players[0]);
  assert(v.you.canRequest); assert.equal(v.you.requestTarget, 'B');
  assert(!T2.view(r, r.players[1]).you.canRequest);
  assert(T2.doRequest(r, r.players[1]));              // not B's turn -> error string
});
ok('requesting does not move any card yet: the asked player is prompted', () => {
  const r = table2('elimination');
  assert.equal(T2.doRequest(r, r.players[0]), null);
  assert.equal(r.stage, 'consent');
  assert.equal(r.players[1].hand.length, 3);
  const vb = T2.view(r, r.players[1]), va = T2.view(r, r.players[0]);
  assert(vb.you.mustAnswer); assert(!va.you.mustAnswer);
  assert.equal(vb.consent.pid, r.players[0].id);
  assert(T2.doRespond(r, r.players[0], true));         // only the asked player can answer
  assert(T2.doRespond(r, r.players[2], true));
});
ok('asked player ACCEPTS: all cards move, they are out, requester still has to play', () => {
  const r = table2('elimination');
  T2.doRequest(r, r.players[0]);
  assert.equal(T2.doRespond(r, r.players[1], true), null);
  assert.equal(r.players[0].hand.length, 3 + 3);
  assert.equal(r.players[1].hand.length, 0); assert(r.players[1].out);
  assert.equal(r.stage, 'turn'); assert.equal(r.turn, r.players[0].id);
  assert.equal(r.trick.plays.length, 0);               // nothing was dealt by the request
  T2.playCard(r, r.players[0], '9H');
  assert.equal(r.turn, r.players[2].id);               // B was skipped, C is next
});
ok('asked player REFUSES: nothing moves and the requester just plays', () => {
  const r = table2('elimination');
  T2.doRequest(r, r.players[0]);
  assert.equal(T2.doRespond(r, r.players[1], false), null);
  assert.equal(r.players[1].hand.length, 3); assert(!r.players[1].out);
  assert.equal(r.stage, 'turn'); assert.equal(r.turn, r.players[0].id);
});
ok('only one request per turn', () => {
  const r = table2('elimination');
  T2.doRequest(r, r.players[0]); T2.doRespond(r, r.players[1], false);
  assert(!T2.view(r, r.players[0]).you.canRequest);
  assert(T2.doRequest(r, r.players[0]));
});
ok('cannot request after you have dealt your card', () => {
  const r = table2('elimination');
  T2.playCard(r, r.players[0], '9H');
  assert(T2.doRequest(r, r.players[0]));
  assert(!T2.view(r, r.players[0]).you.canRequest);
});
ok('no answer in time counts as a refusal', () => {
  process.env.CONSENT_MS = '40';
  delete require.cache[require.resolve('./server')];
  const T3 = require('./server');
  const r = T3.makeRoom(); ['A', 'B', 'C'].forEach(x => T3.addPlayer(r, fakeWs(), x));
  [['9H', '3D'], ['2H', '5S'], ['10H', '7C']].forEach((h, i) => { r.players[i].hand = h; });
  r.phase = 'playing'; r.stage = 'turn'; r.trickNo = 4; T3.newTrick(r, r.players[0], false);
  T3.doRequest(r, r.players[0]);
  assert.equal(r.stage, 'consent');
  return new Promise(res => setTimeout(() => { assert.equal(r.stage, 'turn'); assert.equal(r.players[1].hand.length, 2); res(); }, 120));
});
ok('reveal mode: asked player agrees to show -> peek only, cards stay', () => {
  const r = table2('reveal');
  T2.doRequest(r, r.players[0]);
  T2.doRespond(r, r.players[1], true);
  assert.equal(r.players[1].hand.length, 3);
  assert.equal(r.players[0].reveal.hand.length, 3);
});
ok('off mode: no request possible', () => {
  const r = table2('off');
  assert(!T2.view(r, r.players[0]).you.canRequest);
  assert(T2.doRequest(r, r.players[0]));
});
ok('first trick and final duel: no requests', () => {
  const r = table2('elimination'); r.trick.first = true;
  assert(!T2.view(r, r.players[0]).you.canRequest);
  const d = T2.makeRoom(); ['A', 'B'].forEach(x => T2.addPlayer(d, fakeWs(), x));
  d.players[0].hand = ['9H', '3D']; d.players[1].hand = ['2H', '5S'];
  d.phase = 'playing'; d.stage = 'turn'; d.trickNo = 4; T2.newTrick(d, d.players[0], false);
  assert(!T2.view(d, d.players[0]).you.canRequest);
});

Promise.all(pending).then(() => { console.log(`\n${n} rule checks passed`); process.exit(0); }, e => { console.error(e); process.exit(1); });
