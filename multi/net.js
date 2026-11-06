'use strict';
// Shared plumbing used by the room layer and every game engine.

function send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

/* what one player is allowed to see: room info + the game's own per-player view */
function roomView(room, p) {
  return {
    code: room.code, game: room.game, gameName: room.engine.name,
    hostId: room.hostId, settings: room.settings, phase: room.phase,
    players: room.players.map(q => ({ id: q.id, name: q.name, connected: q.connected, ready: !!q.ready })),
    you: { id: p.id },
    g: room.phase === 'lobby' ? null : room.engine.view(room, p),
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) if (p.ws) send(p.ws, { t: 'state', s: roomView(room, p) });
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

module.exports = { send, roomView, broadcast, later, setEvent, num };
