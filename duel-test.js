// Cross-checks the final-duel solver against the real engine: for random two-player positions, every result the
// engine produces under random play must be one the solver says is reachable, and every reachable result must occur.
process.env.SETTLE_MS = '0';
const g = require('./server.js');
const { solve, A, B, DRAW } = require('./duel');
const SUITS = ['S', 'H', 'D', 'C'], deck = [];
for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push(r + s);
const rnd = n => Math.floor(Math.random() * n);
let positions = 0, doomedCases = 0, bad = 0;
for (let it = 0; it < 400; it++) {
  const n0 = 1 + rnd(3), n1 = 1 + rnd(3), d = deck.slice().sort(() => Math.random() - .5);
  const h0 = d.slice(0, n0), h1 = d.slice(n0, n0 + n1), leader = rnd(2);
  const pred = solve([h0, h1], leader, false);
  if (pred.mask === 0) continue;                 // too big to solve: the server then simply plays on
  const seen = new Set();
  for (let run = 0; run < 150; run++) {
    const room = g.makeRoom();
    room.noForfeit = true;
    room.players = [0, 1].map(i => ({ id: 'p' + i, name: 'P' + i, hand: (i ? h1 : h0).slice(), out: false, place: 0, connected: true, ws: null, reveal: null }));
    room.phase = 'playing';
    g.newTrick(room, room.players[leader], false);
    let guard = 0;
    while (room.phase === 'playing' && guard++ < 200) {
      clearTimeout(room.timer);
      if (room.stage === 'pick') { g.doPick(room, room.players.find(p => p.id === room.pick.pid), rnd(room.pick.perm.length)); continue; }
      if (room.stage !== 'turn') break;
      const p = room.players.find(q => q.id === room.turn), legal = g.view(room, p).you.legal;
      if (!legal.length) break;
      g.playCard(room, p, legal[rnd(legal.length)]);
    }
    clearTimeout(room.timer);
    if (room.phase !== 'over') { if (guard >= 200) continue; bad++; console.log('stuck', h0, h1, room.stage); break; }
    seen.add(room.loserId === 'p0' ? A : room.loserId === 'p1' ? B : DRAW);
  }
  positions++;
  let obs = 0; seen.forEach(b => obs |= b);
  if (obs & ~pred.mask) { bad++; console.log('ENGINE REACHED UNPREDICTED RESULT', h0, h1, leader, 'solver', pred.mask, 'engine', obs); }
  if (pred.doomed !== null) doomedCases++;
}
console.log(`positions=${positions} doomed=${doomedCases} problems=${bad}`);
process.exit(bad ? 1 : 0);
