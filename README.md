# Bhabhi Thulla Online

Real-time multiplayer Thulla for 3–8 players. Node.js + WebSockets, no database, no build step.

## Run locally
```
npm install
npm start          # http://localhost:3000
```
Open it in several browser tabs/devices, create a room, share the 4-letter code (or the invite link).

## Put it online (free options)
Any host that runs Node and supports WebSockets works (Render, Railway, Fly.io, a VPS).

**Render:** push this folder to GitHub → New → Web Service → Build command `npm install` → Start command `npm start`. Done; you get an https URL.
The app uses the `PORT` environment variable automatically and serves its own `wss://` over https.

Health check URL: `/healthz`. (Note: Vercel/Netlify static/serverless hosting will NOT work — they don't keep WebSocket servers running.)

## Rules implemented
- 52 cards, shuffled with a crypto RNG, dealt round-robin (unequal hands allowed). Aces high.
- Everyone sits round an oval table (you at the bottom, play runs **clockwise**). Played cards are dealt onto the table in front of each seat; a finished trick sweeps into the discard pile, or to the player who picks it up after a Thulla.
- A♠ holder opens. Must follow suit; no suit = Thulla; highest card of the led suit picks up the whole pile and leads.
- First-round protection: opening trick can't be Thulla'd. Players with no spades pass, cards are discarded.
- Normal tricks: highest card of the led suit wins, cards are discarded, winner leads (next player if the winner is out).
- Players are out once their hand is empty after a trick resolves. Last player with cards is the Bhabhi. If everyone gets out together it's a draw.
- **Hand request (host picks the mode in the lobby) — BEFORE you deal your card, and the other player must agree:**
  - On your turn, before you play a card, you may request the next player's hand (once per turn).
  - The asked player gets a prompt: **give it away / keep it** (no answer in 15 s = keep it). If they refuse, you just play your turn.
  - *Elimination & transfer*: if they agree, they hand over every card and are out.
  - *Reveal only*: if they agree, you privately see their hand; it stays with them.
  - *Off*: no requests.
  - Limits: not in the opening trick, only the next player (who hasn't played yet this trick), and not in the final duel.
- **Final duel (exactly two players left):** a player's *last card* decides things.
  - Last card **smaller** than the opponent's (loses the trick) → that player is safe and the game ends; the other is the Bhabhi.
  - Last card **bigger** (wins the trick) → they are not safe: they blindly pick one card from the opponent's hand and must play it (lead it). This repeats until someone's last card loses, or someone is emptied by a pick.
  - Picking the opponent's very last card puts the opponent out and leaves the picker holding it (picker is the Bhabhi). If both players dump their last card in the same trick it's a draw. Thulla (no suit) works as normal in the duel.
- No card log: the table, the status line and short pop-up messages show what happened.
- Disconnected players are auto-played by the server after 4 s (including duel picks) and can rejoin by reopening the page.

## Timing (env vars, mostly for tests)
`SETTLE_MS` (finished trick stays on the table, default 1800 / 2600 for a Thulla), `CONSENT_MS` (time the asked player has to answer a hand request, default 15000), `BOT_MS` (auto-play delay, default 4000).

## Test
- `npm run test:rules` — deterministic rule checks (hand requests and consent, final duel branches). No server needed.
- `PORT=3111 SETTLE_MS=0 node server.js &` then `PORT=3111 npm test` — 60 bot games across all player counts and modes.
