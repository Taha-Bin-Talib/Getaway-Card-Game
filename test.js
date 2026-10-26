// Bot test: plays full games over WebSockets with random legal moves and checks invariants.
// Start the server with fast timers first:  PORT=3111 SETTLE_MS=0 POST_MS=120 node server.js &
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 3111);
const rnd = n => Math.floor(Math.random() * n);

function runGame(n, mode) {
  return new Promise((resolve, reject) => {
    const bots = [];
    let code = null, started = false, done = false, violations = [], moves = 0, requests = 0, thullas = 0, picks = 0, windows = 0;
    const timer = setTimeout(() => { if (!done) { done = true; bots.forEach(b => b.ws.close()); reject(new Error('timeout n=' + n + ' mode=' + mode)); } }, 40000);
    const tx = (b, o) => b.ws.send(JSON.stringify(o));

    function mk(i) {
      const ws = new WebSocket(URL);
      const b = { ws, i, S: null };
      bots.push(b);
      ws.on('open', () => {
        if (i === 0) ws.send(JSON.stringify({ t: 'create', name: 'Bot' + i }));
        else ws.send(JSON.stringify({ t: 'join', code, name: 'Bot' + i }));
      });
      ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'error') return;
        if (m.t === 'joined' && i === 0) {
          code = m.code;
          for (let k = 1; k < n; k++) mk(k);
        }
        if (m.t !== 'state') return;
        const S = b.S = m.s;
        if (S.phase === 'lobby' && i === 0 && !started && S.players.length === n) {
          started = true;
          ws.send(JSON.stringify({ t: 'settings', requestMode: mode }));
          ws.send(JSON.stringify({ t: 'start' }));
        }
        if (S.phase === 'playing') {
          if (i === 0) {
            const total = S.players.reduce((a, p) => a + p.count, 0) + S.discarded + S.plays.length;
            if (total !== 52) violations.push('card count ' + total + ' stage ' + S.stage);
            if (S.event && S.event.type === 'thulla' && S.event.seq > (b.lastThulla || 0)) { b.lastThulla = S.event.seq; thullas++; }
            if (S.log) violations.push('server still sends a card log');
          }
          // you may only request a hand in the post-move window, never on your own turn before playing
          if (S.turn === S.you.id && S.you.canRequest) violations.push('request offered before the move');
          if (S.stage === 'post' && S.post.pid === S.you.id) {
            windows++;
            if (!S.you.canRequest) violations.push('post window without canRequest');
            if (mode === 'off') violations.push('post window while requests are off');
            if (Math.random() < 0.3) { requests++; tx(b, { t: 'request' }); } else tx(b, { t: 'endturn' });
          } else if (S.stage === 'pick' && S.pick.pid === S.you.id) {
            picks++;
            if (!S.duel) violations.push('pick outside the final duel');
            tx(b, { t: 'pick', i: rnd(S.pick.n) });
          } else if (S.turn === S.you.id && S.you.legal.length) {
            moves++;
            tx(b, { t: 'play', card: S.you.legal[rnd(S.you.legal.length)] });
          }
        }
        if (S.phase === 'over' && i === 0 && !done) {
          done = true; clearTimeout(timer);
          const sum = S.players.reduce((a, p) => a + p.count, 0);
          if (sum + S.discarded !== 52) violations.push('end card count ' + (sum + S.discarded));
          const res = { n, mode, loser: S.players.find(p => p.id === S.loserId)?.name || null, outs: S.players.filter(p => p.out).length, moves, requests, windows, thullas, picks, violations, counts: S.players.map(p => p.count) };
          bots.forEach(x => x.ws.close());
          resolve(res);
        }
      });
    }
    mk(0);
  });
}

(async () => {
  let bad = 0, draws = 0, total = 0, picks = 0, reqs = 0;
  for (let g = 0; g < 60; g++) {
    const n = 3 + (g % 6), mode = ['elimination', 'reveal', 'off'][g % 3];
    const r = await runGame(n, mode);
    total++; picks += r.picks; reqs += r.requests;
    const ok = r.violations.length === 0 && (r.loser ? r.outs === n - 1 : r.outs === n);
    if (!r.loser) draws++;
    if (!ok) { bad++; console.log('PROBLEM', JSON.stringify(r)); }
  }
  console.log(`games=${total} problems=${bad} draws=${draws} duelPicks=${picks} handRequests=${reqs}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
