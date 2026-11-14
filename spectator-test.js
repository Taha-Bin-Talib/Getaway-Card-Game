// Spectator rules for all three games. Run with a server on PORT (default 3111): `PORT=3111 SETTLE_MS=0 node server.js` then `node spectator-test.js`.
const WebSocket = require('ws');
const PORT = process.env.PORT || 3111;
const assert = require('assert');
function client(path) {
  const ws = new WebSocket(`ws://localhost:${PORT}${path}`); const c = { ws, last: null, msgs: [], me: null, spec: null };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'state') c.last = m.s; if (m.t === 'joined') { c.token = m.token; c.spec = !!m.spectator; c.me = m.id; c.code = m.code; } });
  c.open = new Promise(r => ws.on('open', r));
  c.send = o => ws.send(JSON.stringify(o));
  c.until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout: ' + JSON.stringify(c.msgs.slice(-3))); };
  c.err = () => (c.msgs.filter(m => m.t === 'error').pop() || {}).m;
  return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function run(name, path, game) {
  const mk = async () => { const c = client(path); await c.open; return c; };
  const host = await mk(); host.send({ t: 'create', name: 'Host', game }); await host.until(() => host.code);
  const code = host.code;
  const players = [host];
  for (let i = 1; i < 8; i++) { const c = await mk(); c.send({ t: 'join', code, name: 'P' + i }); await c.until(() => c.code); assert(!c.spec, 'seat ' + (i + 1) + ' is a player'); players.push(c); }
  // 9th person: table full in the lobby -> spectator
  const s1 = await mk(); s1.send({ t: 'join', code, name: 'Watcher1' }); await s1.until(() => s1.code); assert(s1.spec, name + ': 9th is a spectator');
  const s2 = await mk(); s2.send({ t: 'join', code, name: 'Watcher2' }); await s2.until(() => s2.code); assert(s2.spec);
  const s3 = await mk(); s3.send({ t: 'join', code, name: 'Watcher3' }); await wait(200); assert(!s3.code && /spectator seats are taken/.test(s3.err()), name + ': third spectator refused: ' + s3.err());
  await host.until(() => host.last && host.last.spectators && host.last.spectators.length === 2);
  assert(s1.last.you.spectator && s1.last.you.join === 'full', 'lobby full -> cannot join: ' + s1.last.you.join);
  s1.send({ t: 'joinTable' }); await wait(150); assert(s1.err() === 'The table is full.');
  // a spectator cannot start or change anything
  s1.send({ t: 'start' }); await wait(100); assert(host.last.phase === 'lobby');
  // seat frees up -> spectator may join
  players[7].send({ t: 'leave' }); await s1.until(() => s1.last.you.join === 'now');
  s1.send({ t: 'joinTable' }); await s1.until(() => s1.last && !s1.last.you.spectator, 3000);
  assert(s1.spec === false || s1.token, 'got a fresh player token');
  await host.until(() => (host.last.spectators || []).length === 1);
  // start the game (7 players + promoted = 8 again)
  host.send({ t: 'start' }); await host.until(() => host.last.phase === 'playing');
  await s2.until(() => s2.last.phase === 'playing');
  const v = s2.last.g || s2.last, mine = v.you.hand;
  assert(Array.isArray(mine) && mine.length === 0, name + ': spectator sees no cards in hand');
  const leak = JSON.stringify(v);
  const playerHand = (host.last.g || host.last).you.hand;
  assert(playerHand.length > 0);
  for (const c of playerHand) assert(!leak.includes('"' + c + '"') || (v.plays && JSON.stringify(v.plays).includes(c)) || (v.thrown || []).includes(c), name + ': card ' + c + ' leaked to spectator');
  // a latecomer during play: both spectator seats -> s2 + new one, then refused
  const s4 = await mk(); s4.send({ t: 'join', code, name: 'Late1' }); await s4.until(() => s4.code); assert(s4.spec, 'mid-game joiner spectates');
  const s5 = await mk(); s5.send({ t: 'join', code, name: 'Late2' }); await wait(200); assert(!s5.code && /in progress/.test(s5.err()), 'third refused mid-game: ' + s5.err());
  assert(s2.last.you.join === 'wait');
  s2.send({ t: 'joinTable' }); await wait(150); assert(/ends/.test(s2.err()));
  // spectators can chat
  s2.send({ t: 'chat', text: 'hello' }); await host.until(() => host.msgs.some(m => m.t === 'chat' && m.m.text === 'hello'));
  // spectator leaves -> count drops
  s4.send({ t: 'leave' }); await host.until(() => host.last.spectators.length === 1);
  for (const c of [...players, s1, s2, s4, s5, s3]) try { c.ws.close(); } catch (e) { /* */ }
  console.log('ok', name);
}
(async () => {
  await run('thulla', '/', undefined);
  await run('bluff', '/ws/games', 'bluff');
  await run('jackthief', '/ws/games', 'jackthief');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
