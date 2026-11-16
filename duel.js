'use strict';
/* Final-duel solver (two players left, both holding cards, real hands known).
   Builds the game graph of the duel (every legal card by either player, every blind pick) and answers:
     * which results are reachable at all           -> solve().mask
     * can one player FORCE the other to lose        -> solve().doomed  (the player who can no longer win
       against correct play; blind picks count as lucky for the doomed player, so "doomed" is never a gamble).
   Rules mirror server.js: follow suit if you can; a follower with no card of the lead suit causes a Thulla
   (leader picks both cards up); higher lead-suit card wins the trick; if a player's LAST card wins the trick
   they must blindly take a card from the other player and lead it; a player with no cards is out. */
const rank = c => parseInt(c, 10);
const suit = c => c.slice(-1);
const without = (h, c) => { const i = h.indexOf(c); return h.slice(0, i).concat(h.slice(i + 1)); };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const A = 1, B = 2, DRAW = 4;                          // outcome bits: A is the Bhabhi / B is the Bhabhi / nobody

const T = v => ({ k: 'T', v });                        // terminal: v = 0|1 (that player is the Bhabhi) or 'D'
const key = n => n.k === 'T' ? 'T' + n.v : n.k + n.l + '|' + n.h[0].join(',') + '|' + n.h[1].join(',') + (n.c ? '|' + n.c : '');
const L = (h0, h1, l) => ({ k: 'L', h: [h0, h1], l });
const P = (h0, h1, l) => ({ k: 'P', h: [h0, h1], l });
const mk = (kind, l, mine, theirs) => kind(l === 0 ? mine : theirs, l === 0 ? theirs : mine, l);   // hands given as (leader's, other's)

/* successors of a node: array of [label, node] */
function succ(n) {
  const H = n.h, l = n.l, f = 1 - l, out = [];
  if (n.k === 'L') { for (const c of H[l]) out.push([c, { k: 'F', h: H, l, c }]); return out; }
  if (n.k === 'P') {                                    // blind pick by l from f
    const other = H[f];
    for (const card of other) {
      if (other.length === 1) { out.push([card, T(l)]); continue; }        // took their last card: they are safe, the picker is stuck
      out.push([card, mk(L, l, [card], without(other, card))]);
    }
    return out;
  }
  const c = n.c, lr = without(H[l], c), same = H[f].filter(d => suit(d) === suit(c));   // follower chooses a card
  if (!same.length) {                                    // THULLA: the leader takes both cards
    for (const d of H[f]) {
      const nf = without(H[f], d);
      if (nf.length === 0) out.push([d, T(l)]);          // follower threw their last card: they are out
      else out.push([d, mk(L, l, lr.concat([c, d]).sort(cmp), nf)]);
    }
    return out;
  }
  for (const d of same) {                                // trick discarded; higher lead-suit card wins
    const nf = without(H[f], d), w = rank(c) > rank(d) ? l : f;
    const wh = w === l ? lr : nf, oh = w === l ? nf : lr;
    if (!wh.length && !oh.length) out.push([d, T('D')]);
    else if (!wh.length) out.push([d, mk(P, w, wh, oh)]);          // winner's last card won -> blind pick
    else if (!oh.length) out.push([d, T(w)]);                      // the other player's last card lost: they are safe
    else out.push([d, mk(L, w, wh, oh)]);
  }
  return out;
}
const owner = n => n.k === 'L' ? n.l : n.k === 'F' ? 1 - n.l : null;      // null = chance (blind pick)

/* hands: [handA, handB]; leader: 0|1; pick: leader has no cards and must blindly pick. */
function solve(hands, leader, pick = false, budget = 12000) {
  const h0 = hands[0].slice().sort(cmp), h1 = hands[1].slice().sort(cmp);
  const root = pick ? P(h0, h1, leader) : L(h0, h1, leader);
  const nodes = new Map(), edges = new Map();
  const stack = [root]; nodes.set(key(root), root);
  let mask = 0;
  while (stack.length) {
    if (nodes.size > budget) return { mask: 0, doomed: null };
    const n = stack.pop(), kids = succ(n).map(([lab, m]) => [lab, key(m), m]);
    edges.set(key(n), kids);
    for (const [, kk, m] of kids) {
      if (m.k === 'T') { mask |= m.v === 'D' ? DRAW : m.v === 0 ? A : B; continue; }
      if (!nodes.has(kk)) { nodes.set(kk, m); stack.push(m); }
    }
  }
  // who can be forced to lose? least fixed point: node is won for E if E has a move into the set,
  // or every move (of D, or any blind pick) leads into the set
  const forced = [null, null];
  for (const D of [0, 1]) {
    const E = 1 - D, win = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (const [k, n] of nodes) {
        if (win.has(k)) continue;
        const kids = edges.get(k), isWin = ([, kk, m]) => m.k === 'T' ? m.v === D : win.has(kk);
        const o = owner(n), good = o === E ? kids.some(isWin) : kids.every(isWin);
        if (good) { win.add(k); changed = true; }
      }
    }
    forced[D] = win;
  }
  const rk = key(root);
  const doomed = forced[0].has(rk) ? 0 : forced[1].has(rk) ? 1 : null;
  return { mask, doomed, forced, nodes, edges, root };
}
module.exports = { solve, succ, key, owner, A, B, DRAW };
