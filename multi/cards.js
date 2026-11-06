'use strict';
// Card ids look like "12H" (rank 12 = Queen, suit Hearts). A second copy of the same card (two-deck
// Bluff) carries a suffix: "12H:1". Aces are 14.
const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C'];
const rank = c => parseInt(c, 10);
const suit = c => /[SHDC]/.exec(c)[0];
const sortHand = h => h.sort((a, b) => SUITS.indexOf(suit(a)) - SUITS.indexOf(suit(b)) || rank(b) - rank(a) || (a < b ? -1 : 1));

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newDeck(copies = 1) {
  const d = [];
  for (let k = 0; k < copies; k++) {
    for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(r + s + (k ? ':' + k : ''));
  }
  return shuffle(d);
}

const RANK_NAME = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const rankName = r => RANK_NAME[r];
const rankWord = (r, n) => `${n} ${RANK_NAME[r]}${n === 1 ? '' : (RANK_NAME[r].endsWith('x') ? 'es' : 's')}`;
const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RN = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const label = c => (RN[rank(c)] || rank(c)) + SYM[suit(c)];

module.exports = { SUITS, rank, suit, sortHand, shuffle, newDeck, rankName, rankWord, label, SYM };
