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
- A♠ holder opens and play goes clockwise. Must follow suit; no suit = Thulla; highest card of the led suit picks up the whole pile and leads.
- First-round protection: opening trick can't be Thulla'd. Players with no spades pass, cards are discarded.
- Normal tricks: highest card of the led suit wins, cards are discarded, winner leads (next player if the winner is out).
- Players are out once their hand is empty after a trick resolves (a played last card that gets picked up doesn't count).
- Last player with cards is the Bhabhi. If everyone gets out together it's a draw.
- **Hand request (host picks the mode in the lobby):**
  - *Elimination & transfer*: on your turn, from trick 2, request the next player's hand; they hand over every card and are out.
  - *Reveal only*: you privately see their hand; it stays with them.
  - *Off*.
  - Limits: once per turn, not in the opening trick, and not if the next player has already played in the current trick.
- Disconnected players are auto-played by the server after 4 s and can rejoin by reopening the page.

## Test
`PORT=3111 node server.js &` then `PORT=3111 npm test` (48 bot games across all player counts and modes).
