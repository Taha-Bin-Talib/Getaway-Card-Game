'use strict';
// Bluff and Jack Thief, played through the multi-game room layer (multi/rooms.js). Thulla keeps its own server code in ../server.js.
const list = [require('./bluff'), require('./jackthief')];
const map = new Map(list.map(g => [g.id, g]));

module.exports = {
  get: id => map.get(id),
  all: () => list,
  catalog: () => list.map(g => ({ id: g.id, name: g.name, min: g.min, max: g.max, settings: g.settings })),
};
