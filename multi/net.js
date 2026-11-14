'use strict';
// Shared plumbing used by the room layer and every game engine.

const SEATS = 8, MAX_SPECTATORS = 2;
const seatCap = room => Math.min(SEATS, room.engine.max);

/* what a spectator's "Join table" button may do right now */
function joinMode(room, sp) {
  if (room.phase === 'lobby') return room.players.length < seatCap(room) ? 'now' : 'full';
  if (room.phase === 'over') return sp.queued ? 'queued' : 'queue';
  return 'wait';
}
const everyone = room => [...room.players, ...(room.spectators || [])];

function send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

/* what one player is allowed to see: room info + the game's own per-player view */
function roomView(room, p) {
  return {
    code: room.code, game: room.game, gameName: room.engine.name,
    hostId: room.hostId, settings: room.settings, phase: room.phase,
    players: room.players.map(q => ({ id: q.id, name: q.name, connected: q.connected, ready: !!q.ready })),
    spectators: (room.spectators || []).map(q => ({ id: q.id, name: q.name })),
    you: { id: p.id, spectator: !!p.spectator, join: p.spectator ? joinMode(room, p) : null },
    g: room.phase === 'lobby' ? null : room.engine.view(room, p),
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of everyone(room)) if (p.ws) send(p.ws, { t: 'state', s: roomView(room, p) });
}

/* Run fn after ms (or right now when ms <= 0). One pending timer per room; it is tied to the
   current game (gen) so a stale timer can never fire into a new game. */
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

function setEvent(room, type, text) {
  const g = room.g;
  g.event = { seq: ++g.seq, type, text };
}

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);

module.exports = { send, roomView, broadcast, later, setEvent, num, SEATS, MAX_SPECTATORS, seatCap, joinMode, everyone };
