// Cross-checks the final-duel solver against the real engine.
//  1) soundness of reachability: every result the engine produces under random play is predicted reachable;
//  2) soundness of "doomed": when the solver says player D can be forced to lose, the other player playing the
//     solver's strategy beats a D who plays randomly, every single time.
process.env.SETTLE_MS = '0';
const g = require('./server.js');
const { solve, succ, key, A, B, DRAW } = require('./duel');
const SUITS = ['S', 'H', 'D', 'C'], deck = [];
for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push(r + s);
const rnd = n => Math.floor(Math.random() * n);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MAXN = +process.env.MAXN || 3;
let positions = 0, doomedCases = 0, bad = 0, strategyGames = 0;

function newRoom(h0, h1, leader) {
  const room = g.makeRoom();
  room.noForfeit = true;
  room.players = [0, 1].map(i => ({ id: 'p' + i, name: 'P' + i, hand: (i ? h1 : h0).slice(), out: false, place: 0, connected: true, ws: null, reveal: null }));
  room.phase = 'playing';
  g.newTrick(room, room.players[leader], false);
  return room;
}
const hands = room => room.players.map(p => p.hand.slice().sort(cmp));
function play(room, chooser) {
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 300) {
    clearTimeout(room.timer);
    if (room.stage === 'pick') { g.doPick(room, room.players.find(p => p.id === room.pick.pid), rnd(room.pick.perm.length)); continue; }
    if (room.stage !== 'turn') break;
    const idx = room.players.findIndex(q => q.id === room.turn), p = room.players[idx], legal = g.view(room, p).you.legal;
    if (!legal.length) break;
    g.playCard(room, p, chooser(room, idx, legal));
  }
  clearTimeout(room.timer);
  return room.phase === 'over' ? (room.loserId === 'p0' ? A : room.loserId === 'p1' ? B : DRAW) : null;
}

for (let it = 0; it < 400; it++) {
  const n0 = 1 + rnd(MAXN), n1 = 1 + rnd(MAXN), d = deck.slice().sort(() => Math.random() - .5);
  const h0 = d.slice(0, n0), h1 = d.slice(n0, n0 + n1), leader = rnd(2);
  const pred = solve([h0, h1], leader, false);
  if (pred.mask === 0) continue;                 // too big to solve: the server then simply plays on
  positions++;
  let obs = 0;
  for (let run = 0; run < 120; run++) {
    const r = play(newRoom(h0, h1, leader), (room, idx, legal) => legal[rnd(legal.length)]);
    if (r === null) { bad++; console.log('stuck', h0, h1); break; }
    obs |= r;
  }
  if (obs & ~pred.mask) { bad++; console.log('ENGINE REACHED UNPREDICTED RESULT', h0, h1, leader, 'solver', pred.mask, 'engine', obs); }
  if (pred.doomed !== null) {
    doomedCases++;
    const D = pred.doomed, E = 1 - D, W = pred.forced[D];
    for (let run = 0; run < 60; run++) {
      strategyGames++;
      const room = newRoom(h0, h1, leader);
      const r = play(room, (rm, idx, legal) => {
        if (idx === D) return legal[rnd(legal.length)];                       // the doomed player may do anything
        const hs = rm.trick.plays.length === 0 ? { k: 'L', h: hands(rm), l: idx } : (() => { const h = hands(rm), c = rm.trick.plays[0].card; h[1 - idx] = h[1 - idx].concat(c).sort(cmp); return { k: 'F', h, l: 1 - idx, c }; })();
        const good = succ(hs).filter(([lab, m]) => legal.includes(lab) && (m.k === 'T' ? m.v === D : W.has(key(m))));
        if (!good.length) { bad++; console.log('NO WINNING MOVE FOR E', h0, h1, leader, key(hs)); return legal[0]; }
        return good[rnd(good.length)][0];
      });
      if (r !== (D === 0 ? A : B)) { bad++; console.log('DOOMED PLAYER ESCAPED', h0, h1, leader, 'D', D, 'result', r); break; }
    }
  }
}
console.log(`positions=${positions} doomed=${doomedCases} strategyGames=${strategyGames} problems=${bad}`);
process.exit(bad ? 1 : 0);
