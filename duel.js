'use strict';
/* Final-duel solver (two players left, both still holding cards).
   With the real hands known, it explores EVERY line of play (any legal card by either player, any blind pick)
   and reports which final results are reachable. If only one player can ever be the Bhabhi, that player
   cannot win any more and the game can be ended at once.
   Mirrors the rules in server.js: follow suit if you can; a follower with no card of the lead suit causes a
   Thulla (leader picks both cards up); higher lead-suit card wins the trick; if one player's LAST card wins the
   trick they must blindly take a card from the other player and lead it. */
const rank = c => parseInt(c, 10);
const suit = c => c.slice(-1);
const without = (h, c) => { const i = h.indexOf(c); return h.slice(0, i).concat(h.slice(i + 1)); };
const A = 1, B = 2, DRAW = 4;                       // outcome bits: A is the Bhabhi / B is the Bhabhi / nobody

/* hands: [handA, handB]; leader: 0 or 1; pick: true when `leader` has no cards and must blindly pick from the other.
   Returns { mask, doomed } where doomed is 0 or 1 (the player who cannot win) or null (undecided / too big). */
function solve(hands, leader, pick = false, budget = 15000) {
  const key = (h0, h1, l, pk) => (pk ? 'P' : 'L') + l + '|' + h0.join(',') + '|' + h1.join(',');
  const seen = new Set(), stack = [];
  let mask = 0;
  const push = (h0, h1, l, pk) => { const k = key(h0, h1, l, pk); if (!seen.has(k)) { seen.add(k); stack.push([h0, h1, l, pk]); } };
  push(hands[0].slice().sort(), hands[1].slice().sort(), leader, pick);
  const loser = i => (i === 0 ? A : B);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  while (stack.length) {
    if (seen.size > budget) return { mask: 0, doomed: null };
    const [h0, h1, l, pk] = stack.pop();
    const H = [h0, h1], f = 1 - l;
    if (pk) {                                                    // blind pick: any card of the other player is possible
      const other = H[f];
      for (const card of other) {
        if (other.length === 1) { mask |= loser(l); continue; } // took their last card: they are safe, the picker is stuck
        const nl = [card], nf = without(other, card);
        const n0 = l === 0 ? nl : nf, n1 = l === 0 ? nf : nl;
        push(n0, n1, l, false);
      }
      continue;
    }
    for (const c of H[l]) {                                      // leader plays any card
      const followers = H[f].filter(d => suit(d) === suit(c));
      const lr = without(H[l], c);
      if (!followers.length) {                                    // THULLA: leader takes both cards
        for (const d of H[f]) {
          const nf = without(H[f], d);
          if (nf.length === 0) { mask |= loser(l); continue; }    // follower threw their last card: they are out
          const nl = lr.concat([c, d]).sort(cmp);
          push(l === 0 ? nl : nf, l === 0 ? nf : nl, l, false);
        }
        continue;
      }
      for (const d of followers) {                                // trick is discarded
        const nf = without(H[f], d), winner = rank(c) > rank(d) ? l : f;
        const wh = winner === l ? lr : nf, oh = winner === l ? nf : lr;
        if (wh.length === 0 && oh.length === 0) { mask |= DRAW; continue; }
        if (wh.length === 0) {                                    // winner's last card won -> blind pick from the other player
          push(winner === 0 ? wh : oh, winner === 0 ? oh : wh, winner, true); continue;
        }
        if (oh.length === 0) { mask |= loser(winner); continue; } // the other player's last card lost: they are safe
        push(winner === 0 ? wh : oh, winner === 0 ? oh : wh, winner, false);
      }
    }
  }
  const doomed = mask === A ? 0 : mask === B ? 1 : null;
  return { mask, doomed };
}
module.exports = { solve, A, B, DRAW };
