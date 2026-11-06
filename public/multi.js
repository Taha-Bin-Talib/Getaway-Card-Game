/* Client for the Bluff + Jack Thief rooms (server socket: /ws/games). One file, one page per game (body[data-game]). */
(function () {
'use strict';
const GAME = document.body.dataset.game;                 // 'bluff' | 'jackthief'
const SLUG = { bluff: 'bluff', jackthief: 'jack-thief' };
const TITLE = { bluff: 'Bluff', jackthief: 'Jack Thief' };
const RN = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }, SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RNAME = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const rank = c => parseInt(c, 10), suit = c => /[SHDC]/.exec(c)[0];
const rlabel = r => RN[r] || String(r);
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }, del: k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } } };
const SKEY = 'multi_session';
let pickRank = null, ws = null, S = null, me = null, catalog = [], session = null, sel = [], tick = null, wantRoom = new URLSearchParams(location.search).get('room'), pendingMsg = null, chatOpen = false, unread = 0, lastEventSeq = -1;

/* ---------- helpers ---------- */
function toast(t) { const e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { e.style.display = 'none'; }, 2600); }
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); document.body.classList.toggle('ingame', id !== 'home'); if (show.cur !== id) window.scrollTo(0, 0); show.cur = id; $('chatBtn').classList.toggle('on', id !== 'home'); if (id !== 'game') $('over').classList.remove('on');
  if (id === 'home') { $('chat').classList.remove('on'); chatOpen = false; } }
const nameOf = id => { const p = S && S.players.find(q => q.id === id); return p ? p.name : '?'; };
function cardEl(c, opts = {}) {
  const r = rank(c), s = suit(c), e = el(opts.tag || 'div', 'card' + (s === 'H' || s === 'D' ? ' red' : '') + (opts.mini ? ' mini' : '') + (opts.sel ? ' sel' : '') + (opts.dim ? ' dim' : ''));
  const tl = el('div', 'tl', rlabel(r)); tl.appendChild(el('small', null, SYM[s])); e.appendChild(tl); e.appendChild(el('div', 'mid', SYM[s]));
  const br = el('div', 'br', rlabel(r)); br.appendChild(el('small', null, SYM[s])); e.appendChild(br);
  e.setAttribute('aria-label', `${RNAME[r]} of ${{ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[s]}`);
  return e;
}
const backEl = (mini) => { const e = el('div', 'card back' + (mini ? ' mini' : '')); e.setAttribute('aria-label', 'face-down card'); return e; };
function timerBar(ms) { const b = el('div', 'bar'); const i = el('i'); i.style.animationDuration = Math.max(1, ms) + 'ms'; b.appendChild(i); return b; }

/* ---------- connection ---------- */
function connect(cb) {
  if (ws && ws.readyState === 1) return cb && cb();
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws/games');
  ws.onopen = () => { $('conn').style.display = 'none'; if (session && !S) send({ t: 'rejoin', code: session.code, token: session.token }); if (cb) cb(); };
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m); };
  ws.onclose = () => { $('conn').style.display = 'block'; setTimeout(() => connect(), 1500); };
  ws.onerror = () => {};
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
const act = (a, extra) => send(Object.assign({ t: 'act', a }, extra || {}));
setInterval(() => send({ t: 'ping' }), 25000);

function onMsg(m) {
  switch (m.t) {
    case 'joined': session = { code: m.code, token: m.token }; store.set(SKEY, JSON.stringify(session)); me = m.id; catalog = m.catalog || []; break;
    case 'state': if (!session) return; S = m.s; me = S.you.id; if (S.game !== GAME) { location.replace('/play/' + SLUG[S.game] + '?room=' + S.code); return; } render(); break;
    case 'error': toast(m.m); $('homeErr').textContent = m.m; break;
    case 'gone': session = null; store.del(SKEY); S = null; show('home'); break;
    case 'kicked': toast('You were removed from the room.'); reset(); break;
    case 'left': reset(); break;
    case 'chatlog': $('chatLog').textContent = ''; (m.log || []).forEach(addChat); break;
    case 'chat': addChat(m.m); if (!chatOpen) { unread++; $('chatBadge').textContent = unread; $('chatBadge').style.display = 'block'; } break;
    case 'react': floater(m); break;
  }
}
function reset() { S = null; session = null; store.del(SKEY); sel = []; show('home'); history.replaceState(null, '', location.pathname); }

/* ---------- chat ---------- */
function addChat(c) { const d = el('div'); d.appendChild(el('b', null, c.name + ': ')); d.appendChild(document.createTextNode(c.text)); const l = $('chatLog'); l.appendChild(d); l.scrollTop = l.scrollHeight; }
function floater(m) { const f = el('div', 'floater', m.e); f.appendChild(el('span', null, m.name)); f.style.left = (10 + Math.random() * 75) + '%'; $('floaters').appendChild(f); setTimeout(() => f.remove(), 2300); }

/* ---------- home / lobby ---------- */
function getName() { const n = $('name').value.trim(); store.set('multiName', n); return n; }
function render() {
  if (!S) return;
  if (S.phase === 'lobby') return renderLobby();
  show('game'); $('over').classList.toggle('on', S.phase === 'over');
  renderSeats(); renderTimer();
  (GAME === 'bluff' ? renderBluff : renderJack)();
  if (S.phase === 'over') renderOver();
}
function renderLobby() {
  show('lobby'); sel = [];
  $('lobbyTitle').textContent = TITLE[GAME] + ' — waiting room';
  $('lobbyCode').textContent = S.code;
  const host = S.hostId === me, eng = catalog.find(c => c.id === GAME) || { min: 2, max: 10, settings: [] };
  const ul = $('plist'); ul.textContent = '';
  S.players.forEach(p => {
    const li = el('li'); li.appendChild(el('span', 'grow', p.name + (p.id === me ? ' (you)' : '')));
    if (p.id === S.hostId) li.appendChild(el('span', 'tag', 'host'));
    if (!p.connected) li.appendChild(el('span', 'tag off', 'offline'));
    if (host && p.id !== me) { const k = el('button', 'btn ghost', 'Remove'); k.style.padding = '4px 10px'; k.onclick = () => send({ t: 'kick', id: p.id }); li.appendChild(k); }
    ul.appendChild(li);
  });
  const st = $('settings'); st.textContent = '';
  (eng.settings || []).forEach(sp => {
    const wrap = el('div'); wrap.appendChild(el('label', 'small', sp.label));
    const sel_ = el('select'); sel_.disabled = !host;
    sp.options.forEach(o => { const op = el('option', null, o.label); op.value = o.value; if (S.settings[sp.key] === o.value) op.selected = true; sel_.appendChild(op); });
    sel_.onchange = () => send({ t: 'settings', key: sp.key, value: sel_.value });
    wrap.appendChild(sel_); st.appendChild(wrap);
  });
  const start = $('start'); start.style.display = host ? '' : 'none'; start.disabled = S.players.length < eng.min;
  $('lobbyHint').textContent = S.players.length < eng.min ? `${TITLE[GAME]} needs at least ${eng.min} players — share the code or invite link.` : (host ? 'Everyone here? Press Start.' : 'Waiting for the host to start…');
}

/* ---------- table pieces ---------- */
function renderSeats() {
  const g = S.g, box = $('seats'), ring = $('ring'); box.textContent = ''; ring.textContent = '';
  $('gsub').textContent = 'Room ' + S.code;
  const n = S.players.length, mi = Math.max(0, S.players.findIndex(p => p.id === me));
  const order = S.players.map((p, i) => S.players[(mi + i) % n]);          // me first
  S.players.forEach(p => {
    const sd = g.seats.find(x => x.id === p.id) || {};
    const turn = g.turn === p.id || (g.pick && g.pick.pid === p.id);
    const done = sd.out || (sd.count === 0 && S.phase !== 'lobby' && GAME === 'bluff');
    const sub = sd.count === 0 ? (GAME === 'bluff' ? 'safe ✓' : 'out ✓') : (GAME === 'jackthief' && g.stage === 'sort' && sd.ready ? '✓ done' : String(sd.count));
    const c = el('div', 'chip' + (turn ? ' turn' : '') + (done ? ' out' : ''));
    c.appendChild(el('b', null, p.id === me ? 'You' : p.name)); c.appendChild(el('span', null, (!p.connected ? 'offline' : sub)));
    box.appendChild(c);
  });
  order.forEach((p, i) => {
    const sd = g.seats.find(x => x.id === p.id) || {};
    const turn = g.turn === p.id || (g.pick && g.pick.pid === p.id);
    const done = sd.out || (sd.count === 0 && GAME === 'bluff');
    const ang = Math.PI / 2 + (i * 2 * Math.PI) / n;                        // me at bottom, clockwise
    const rx = 43, ry = 39 + (n > 6 ? 2 : 0);
    const d = el('div', 'seatp' + (turn ? ' turn' : '') + (done ? ' out' : '') + (p.id === me ? ' me' : ''));
    d.style.left = (50 + rx * Math.cos(ang)) + '%'; d.style.top = (50 + ry * Math.sin(ang)) + '%';
    if (p.id !== me && sd.count > 0) { const mf = el('div', 'mf'); const k = Math.min(4, sd.count); for (let j = 0; j < k; j++) { const b = backEl(); b.style.setProperty('--r', ((j - (k - 1) / 2) * 9) + 'deg'); mf.appendChild(b); } d.appendChild(mf); }
    d.appendChild(el('div', 'av', (p.id === me ? 'T' : p.name[0] || '?').toUpperCase()));
    const np = el('div', 'np'); np.appendChild(el('b', null, p.id === me ? 'You' : p.name));
    np.appendChild(el('span', null, sd.count === 0 ? (GAME === 'bluff' ? 'safe ✓' : 'out ✓') : (sd.count + ' cards')));
    d.appendChild(np);
    if (turn && g.timer && g.timer.pid === p.id) d.appendChild(timerBar(g.timer.ms));
    ring.appendChild(d);
  });
}
function renderTimer() { clearInterval(tick); const g = S.g; if (GAME === 'jackthief' && g.stage === 'sort') { let ms = g.sortMs; const t = $('sortTimer'); const f = () => { t.textContent = 'sorting: ' + Math.ceil(Math.max(0, ms) / 1000) + 's'; ms -= 1000; }; f(); tick = setInterval(f, 1000); } }
function toggleSel(c, max) {
  const i = sel.indexOf(c);
  if (i >= 0) sel.splice(i, 1); else if (sel.length < max) sel.push(c); else toast(`You can pick at most ${max} card${max === 1 ? '' : 's'}.`);
  render();
}
function drawHand(box, hand, max, opts = {}) {
  const fresh = !box.children.length && hand.length > 3 && S.phase === 'playing';
  box.textContent = ''; sel = sel.filter(c => hand.includes(c)); box.classList.toggle('deal', fresh);
  hand.forEach(c => { const e = cardEl(c, { sel: sel.includes(c), tag: 'button' }); e.onclick = () => (opts.onTap ? opts.onTap(c) : toggleSel(c, max)); e.style.setProperty('--i', box.children.length); box.appendChild(e); });
}

/* ---------- BLUFF ---------- */
function bestRank(hand) { const n = {}; hand.forEach(c => { n[rank(c)] = (n[rank(c)] || 0) + 1; }); return +Object.keys(n).sort((a, b) => n[b] - n[a] || b - a)[0] || 14; }
function renderBluff() {
  const g = S.g, y = g.you, my = g.turn === me, ct = $('bluffCtrl'), tb = $('claim'); ct.textContent = '';
  const pile = $('pile'), prev = +pile.dataset.n || 0; pile.textContent = '';
  const k = Math.min(5, g.pile);
  for (let i = 0; i < k; i++) { const b = backEl(); b.style.setProperty('--r', ((i - (k - 1) / 2) * 7) + 'deg'); b.style.setProperty('--x', ((i - (k - 1) / 2) * 3) + 'px'); pile.appendChild(b); }
  if (g.pile) pile.appendChild(el('div', 'badge', g.pile));
  if (g.pile !== prev) { pile.classList.remove('pop'); void pile.offsetWidth; if (g.pile > prev) pile.classList.add('pop'); } pile.dataset.n = g.pile;
  tb.style.display = ''; tb.textContent = '';
  if (g.claim) tb.textContent = `“${g.claim.count} ${g.claim.name}${g.claim.count === 1 ? '' : 's'}”`;
  else if (!g.pile) { tb.className = 'emptytag'; tb.textContent = 'Pile is empty'; }
  tb.className = g.claim ? 'claimtag' : 'emptytag';
  const evt = g.event ? g.event.text : ''; $('ev').textContent = evt;
  const rv = $('reveal'); rv.textContent = ''; rv.style.display = g.reveal ? 'block' : 'none';
  if (g.reveal) {
    const r = g.reveal; rv.appendChild(el('div', 'v', `${nameOf(r.callerId)} called ${nameOf(r.playerId)}'s play of ${RNAME[r.rank]}s — ` + (r.truthful ? 'it was TRUE!' : 'it was a LIE!')));
    const row = el('div', 'thrown'); row.style.setProperty('--cw', '34px'); r.cards.forEach(c => row.appendChild(cardEl(c, { mini: true }))); rv.appendChild(row);
    rv.appendChild(el('div', 'small', `${nameOf(r.loserId)} picks up the pile${r.taken ? ' (' + r.taken + ' card' + (r.taken === 1 ? '' : 's') + ')' : ''}.`));
  }
  const open = g.stage === 'open' && my, resp = g.stage === 'respond' && my;
  const max = open ? y.maxOpen : resp ? y.maxAdd : 0;
  drawHand($('hand'), y.hand.slice().sort((a, b) => rank(a) - rank(b)), max);
  let pt = '', hint = '';
  if (open) { pt = 'Your turn to open'; hint = 'Pick 1–4 cards, name a rank, and play them face down. They don’t have to match what you say.'; }
  else if (resp) { pt = g.claim ? `${nameOf(g.claim.by)} says: ${g.claim.count} ${g.claim.name}${g.claim.count === 1 ? '' : 's'}` : 'Your turn'; hint = y.own ? 'Everyone passed — add 1–2 more cards of the same rank, or pass to throw the pile away.' : 'Call their bluff, add 1–2 more cards to the pile, or pass.'; }
  else if (g.stage === 'reveal') { pt = 'Revealing…'; }
  else if (g.turn) { pt = `${nameOf(g.turn)} is thinking…`; }
  $('pt').textContent = pt; $('hint').textContent = hint;
  $('panel').style.display = pt || hint ? '' : 'none';
  if (open) {
    const s = el('select'); for (let r = 14; r >= 2; r--) { const o = el('option', null, RNAME[r] + 's'); o.value = r; s.appendChild(o); }
    s.value = pickRank || bestRank(y.hand); s.onchange = () => { pickRank = +s.value; }; s.id = 'rankSel'; s.setAttribute('aria-label', 'Rank to call');
    const b = el('button', 'btn', sel.length ? `Play ${sel.length}` : 'Select cards'); b.disabled = !sel.length;
    b.onclick = () => { act('open', { rank: +s.value, cards: sel.slice() }); sel = []; pickRank = null; };
    ct.appendChild(s); ct.appendChild(b);
  } else if (resp) {
    if (!y.own) { const c = el('button', 'btn red', 'Call bluff'); c.disabled = !y.canCall; c.onclick = () => act('call'); ct.appendChild(c); }
    const a = el('button', 'btn dark', sel.length ? `Add ${sel.length}` : 'Add 1–2'); a.disabled = !sel.length;
    a.onclick = () => { act('add', { cards: sel.slice() }); sel = []; };
    const p = el('button', 'btn green', 'Pass'); p.onclick = () => act('pass');
    ct.appendChild(a); ct.appendChild(p);
  }
}

/* ---------- JACK THIEF ---------- */
function renderJack() {
  const g = S.g, y = g.you; $('ev').textContent = g.event ? g.event.text : '';
  $('panel').style.display = '';
  $('thrownCount').textContent = g.thrown.length; $('thrownLbl').textContent = g.thrown.length === 1 ? 'card thrown away' : 'cards thrown away';
  $('sortTimer').style.display = g.stage === 'sort' ? 'block' : 'none';
  const fan = $('fan'); fan.textContent = ''; const ct = $('jackCtrl'); ct.textContent = '';
  const pairMode = (g.stage === 'sort' && !y.done) || y.resolving;
  const hand = $('hand');
  drawHand(hand, y.hand, 2, { onTap: c => {
    if (!pairMode) return;
    if (sel.includes(c)) sel = sel.filter(x => x !== c);
    else if (sel.length && rank(sel[0]) !== rank(c)) sel = [c];
    else sel.push(c);
    if (sel.length === 2) { act('throw', { cards: sel.slice() }); sel = []; }
    render();
  } });
  if (y.resolving && y.drawn) { const hl = [...hand.children][y.hand.indexOf(y.drawn)]; if (hl) hl.classList.add('pick'); }
  let hint = '';
  if (g.stage === 'sort') { hint = y.done ? 'Waiting for the others to finish sorting…' : 'Tap two cards of the same rank to throw the pair away. When none are left, press Done.'; }
  else if (y.mustDraw) { hint = `Your turn: take one card from ${nameOf(g.pick.fromId)}’s hand.`; for (let i = 0; i < g.pick.n; i++) { const b = backEl(); b.setAttribute('role', 'button'); b.tabIndex = 0; const go = () => act('draw', { i }); b.onclick = go; b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') go(); }; fan.appendChild(b); } }
  else if (y.resolving) { hint = `You drew ${rlabel(rank(y.drawn))}${SYM[suit(y.drawn)]}. Throw any new pair, then press Done.`; }
  else if (g.pick) { hint = `${nameOf(g.pick.pid)} is drawing from ${nameOf(g.pick.fromId)}…`; }
  else if (g.stage === 'settle' || g.stage === 'resolve') { hint = g.turn ? `${nameOf(g.turn)} is throwing pairs…` : ''; }
  $('hint').textContent = hint; $('panel').style.display = hint || pairMode ? '' : 'none';
  if (pairMode) { const d = el('button', 'btn green', 'Done'); d.disabled = y.pairs; d.title = y.pairs ? 'Throw your pairs first' : ''; d.onclick = () => act('done'); ct.appendChild(d); if (y.pairs) ct.appendChild(el('span', 'small', 'You still hold a pair')); }
}

/* ---------- game over ---------- */
function renderOver() {
  const g = S.g, host = S.hostId === me; let t = '', sub = '';
  if (GAME === 'bluff') { t = g.loserId === me ? 'You lost this one' : `${nameOf(g.loserId)} is the Bluff loser`; sub = g.loserId === me ? 'You were left holding cards. Better luck next time!' : (g.winnerId === me ? 'You got out first — well played!' : 'You got out safely.'); }
  else { t = g.thiefId ? (g.thiefId === me ? 'You are the Jack Thief!' : `${nameOf(g.thiefId)} is the Jack Thief!`) : 'Nobody holds the Jack — a draw!'; sub = g.thiefId === me ? 'You were left holding the unpaired Jack.' : 'You got rid of all your cards.'; }
  $('overTitle').textContent = t; $('overSub').textContent = sub;
  $('again').style.display = host ? '' : 'none'; $('overWait').style.display = host ? 'none' : 'block';
}

/* ---------- wire up ---------- */
$('create').onclick = () => { const n = getName(); if (!n) { $('homeErr').textContent = 'Enter your name first.'; return; } $('homeErr').textContent = ''; connect(() => send({ t: 'create', name: n, game: GAME })); };
$('join').onclick = () => { const n = getName(), c = $('code').value.trim().toUpperCase(); if (!n) { $('homeErr').textContent = 'Enter your name first.'; return; } if (c.length !== 4) { $('homeErr').textContent = 'Enter the 4-letter room code.'; return; } $('homeErr').textContent = ''; connect(() => send({ t: 'join', name: n, code: c })); };
$('start').onclick = () => send({ t: 'start' });
$('copyLink').onclick = () => { const link = location.origin + location.pathname + '?room=' + S.code; (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied'), () => toast(link)); };
document.querySelectorAll('[data-leave]').forEach(b => { b.onclick = () => { if (S && S.phase === 'playing' && !confirm('Leave the game? The computer will play your cards.')) return; send({ t: 'leave' }); reset(); }; });
$('again').onclick = () => send({ t: 'rematch' });
$('chatBtn').onclick = () => { chatOpen = !chatOpen; $('chat').classList.toggle('on', chatOpen); if (chatOpen) { unread = 0; $('chatBadge').style.display = 'none'; $('chatIn').focus(); } };
$('chatForm').onsubmit = e => { e.preventDefault(); const t = $('chatIn').value.trim(); if (t) send({ t: 'chat', text: t }); $('chatIn').value = ''; };
document.querySelectorAll('#emojis button').forEach(b => { b.onclick = () => send({ t: 'react', e: b.textContent }); });
$('name').value = store.get('multiName') || '';
if (wantRoom) $('code').value = wantRoom.toUpperCase().slice(0, 4);
try { session = JSON.parse(store.get(SKEY) || 'null'); } catch (e) { session = null; }
if (session) connect();
})();
