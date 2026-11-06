'use strict';
// Room layer: lobby, host controls, reconnects. Game rules live in games/*.js.
const crypto = require('crypto');
const { send, roomView, broadcast } = require('./net');
const games = require('./games');

const ROOM_MAX = 10;
const REACTIONS = ['😂', '😢', '😉', '😡', '😮', '👏', '🔥', '👍'];
const chatLimited = p => { const n = Date.now(); if (p.lastChat && n - p.lastChat < 600) return true; p.lastChat = n; return false; };
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const newId = () => crypto.randomBytes(4).toString('hex');
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14);

function err(ws, m) { send(ws, { t: 'error', m }); }

function setEngine(room, id) {
  const engine = games.get(id);
  room.game = engine.id; room.engine = engine;
  room.settings = engine.defaults();
}

function createRoom(ws, m) {
  const name = cleanName(m.name);
  if (!name) return err(ws, 'Enter your name.');
  const engine = games.get(m.game);
  if (!engine) return err(ws, 'Pick a game.');
  const room = { code: newCode(), players: [], phase: 'lobby', timer: null, gen: 0, g: null, lastActive: Date.now(), hostId: null, chat: [] };
  setEngine(room, engine.id);
  rooms.set(room.code, room);
  addPlayer(ws, room, name);
}

function addPlayer(ws, room, name) {
  const p = { id: newId(), token: crypto.randomBytes(12).toString('hex'), name, ws, connected: true, ready: false, hand: [], out: false, place: 0 };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  ws.room = room; ws.pid = p.id;
  send(ws, { t: 'joined', token: p.token, code: room.code, id: p.id, catalog: games.catalog() });
  send(ws, { t: 'chatlog', log: room.chat });
  broadcast(room);
}

function joinRoom(ws, m) {
  const name = cleanName(m.name);
  const room = rooms.get(String(m.code || '').toUpperCase().trim());
  if (!name) return err(ws, 'Enter your name.');
  if (!room) return err(ws, 'No room with that code.');
  if (room.phase !== 'lobby') return err(ws, 'That game has already started.');
  if (room.players.length >= Math.min(ROOM_MAX, room.engine.max)) return err(ws, 'The room is full.');
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return err(ws, 'That name is taken in this room.');
  addPlayer(ws, room, name);
}

function rejoin(ws, m) {
  const room = rooms.get(String(m.code || '').toUpperCase());
  const p = room && room.players.find(q => q.token === m.token);
  if (!p) return send(ws, { t: 'gone' });
  if (p.ws && p.ws !== ws) { p.ws.room = null; try { p.ws.close(); } catch (e) { /* ignore */ } }
  p.ws = ws; p.connected = true; ws.room = room; ws.pid = p.id;
  send(ws, { t: 'joined', token: p.token, code: room.code, id: p.id, catalog: games.catalog() });
  send(ws, { t: 'chatlog', log: room.chat });
  if (room.phase === 'playing') room.engine.onPresence && room.engine.onPresence(room, p);
  broadcast(room);
}

function reassignHost(room) {
  const cur = room.players.find(p => p.id === room.hostId);
  if (cur && cur.connected) return;
  const next = room.players.find(p => p.connected);
  if (next) room.hostId = next.id;
}

function removePlayer(room, p) {
  room.players = room.players.filter(q => q !== p);
  if (p.ws) { p.ws.room = null; }
  if (!room.players.length) return destroy(room);
  reassignHost(room);
  broadcast(room);
}

function destroy(room) {
  clearTimeout(room.timer); room.gen++;
  rooms.delete(room.code);
}

function disconnect(ws) {
  const room = ws.room;
  if (!room) return;
  const p = room.players.find(q => q.id === ws.pid);
  if (!p || p.ws !== ws) return;
  p.ws = null; p.connected = false;
  if (room.phase === 'lobby') {
    // keep a short grace so a flaky connection can rejoin, then drop
    setTimeout(() => {
      if (!p.connected && room.phase === 'lobby' && room.players.includes(p)) removePlayer(room, p);
    }, 20000).unref();
  }
  reassignHost(room);
  if (room.phase === 'playing' && room.engine.onPresence) room.engine.onPresence(room, p);
  if (room.players.every(q => !q.connected) && room.phase !== 'playing') return;
  broadcast(room);
}

function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'create') return createRoom(ws, m);
  if (m.t === 'join') return joinRoom(ws, m);
  if (m.t === 'rejoin') return rejoin(ws, m);
  if (m.t === 'ping') return send(ws, { t: 'pong' });
  const room = ws.room;
  const p = room && room.players.find(q => q.id === ws.pid);
  if (!room || !p) return err(ws, 'You are not in a room.');
  const host = room.hostId === p.id;
  switch (m.t) {
    case 'chat': {
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
      if (!text || chatLimited(p)) return;
      const msg = { id: p.id, name: p.name, text, ts: Date.now() };
      room.chat.push(msg); if (room.chat.length > 60) room.chat.shift();
      room.lastActive = Date.now();
      for (const q of room.players) if (q.ws) send(q.ws, { t: 'chat', m: msg });
      return;
    }
    case 'react': {
      if (!REACTIONS.includes(m.e) || chatLimited(p)) return;
      for (const q of room.players) if (q.ws) send(q.ws, { t: 'react', pid: p.id, name: p.name, e: m.e });
      return;
    }
    case 'ready': {                       // lobby only: a player marks themselves ready / not ready
      if (room.phase !== 'lobby') return;
      p.ready = !!m.on;
      return broadcast(room);
    }
    case 'setGame': {
      if (!host || room.phase !== 'lobby') return err(ws, 'Only the host can change the game in the lobby.');
      const e = games.get(m.game);
      if (!e) return err(ws, 'Unknown game.');
      if (room.players.length > e.max) return err(ws, `${e.name} allows up to ${e.max} players.`);
      setEngine(room, e.id);
      return broadcast(room);
    }
    case 'settings': {
      if (!host || room.phase !== 'lobby') return err(ws, 'Only the host can change settings.');
      const spec = room.engine.settings.find(s => s.key === m.key);
      if (!spec || !spec.options.some(o => o.value === m.value)) return err(ws, 'Invalid setting.');
      room.settings[m.key] = m.value;
      return broadcast(room);
    }
    case 'kick': {
      if (!host || room.phase !== 'lobby') return err(ws, 'Only the host can remove players in the lobby.');
      const t = room.players.find(q => q.id === m.id);
      if (!t || t === p) return;
      if (t.ws) { send(t.ws, { t: 'kicked' }); }
      return removePlayer(room, t);
    }
    case 'start': {
      if (!host) return err(ws, 'Only the host can start the game.');
      if (room.phase !== 'lobby') return;
      const e = room.engine;
      const live = room.players.filter(q => q.connected);
      if (live.length !== room.players.length) return err(ws, 'Wait for everyone to be online.');
      if (room.players.length < e.min) return err(ws, `${e.name} needs at least ${e.min} players.`);
      if (room.players.length > e.max) return err(ws, `${e.name} allows up to ${e.max} players.`);
      e.start(room);
      return broadcast(room);
    }
    case 'act': {
      if (room.phase !== 'playing') return err(ws, 'No game in progress.');
      const e = m.a && typeof m.a === 'string' ? room.engine.action(room, p, m) : 'Bad action.';
      if (e) err(ws, e);
      return broadcast(room);
    }
    case 'rematch': {
      if (!host) return err(ws, 'Only the host can start a new game.');
      if (room.phase !== 'over') return;
      room.engine.reset(room);
      room.phase = 'lobby'; room.g = null;
      room.players = room.players.filter(q => q.connected);
      room.players.forEach(q => { q.ready = false; });
      return broadcast(room);
    }
    case 'leave': {
      send(ws, { t: 'left' });
      ws.room = null;
      if (room.phase === 'playing') {          // seat stays and is auto-played; token is voided
        p.ws = null; p.connected = false; p.token = crypto.randomBytes(12).toString('hex');
        reassignHost(room);
        if (room.engine.onPresence) room.engine.onPresence(room, p);
        if (room.players.every(q => !q.connected)) return destroy(room);
        return broadcast(room);
      }
      return removePlayer(room, p);
    }
  }
}

/* drop rooms nobody has touched for a while */
function sweep(maxIdleMs = 2 * 3600 * 1000) {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.players.every(p => !p.connected) && now - room.lastActive > 10 * 60 * 1000) destroy(room);
    else if (now - room.lastActive > maxIdleMs) destroy(room);
  }
}

module.exports = { handle, disconnect, sweep, rooms };
