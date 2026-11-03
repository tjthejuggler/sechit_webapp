# Secret Hitler — LAN & Online Web App

A self-hosted digital replacement for the physical **Secret Hitler** game. A
**central board page** shows the table on a big screen, and every player uses
their **phone** as their private hand. Two modes, same code and same feel:

- **LAN mode** — a local Node.js server is the authoritative host over your
  WiFi (no internet required), or
- **Online mode** — a fully static deployment (GitHub Pages) where the board
  page itself becomes the game host and phones connect **peer-to-peer** via
  PeerJS/WebRTC. Anyone can start their own independent game instance; each
  game gets a unique code, join URL, QR code and share button.

```
Big screen (computer)             Phones (same WiFi)
┌─────────────────────┐           ┌───────────────┐
│  /board  (public)   │ ◀─ LAN ── │ /play (priv.) │  × 5–10 players
│  server on :3000    │           └───────────────┘
└─────────────────────┘
```

## Quick start

```bash
./scripts/start.sh
```

The launcher installs dependencies if missing, starts the server (port `3000`
by default, override with `PORT=...`), opens the board in your default
browser, and prints the phone join URL plus a scannable QR code in the
terminal.

Manual alternative:

```bash
npm install
npm run build:vendor  # one-time: vendor peerjs/qrcode/jsQR bundles
npm start             # serves on PORT 3000 by default
# then open http://localhost:3000/board
```

## Online mode — GitHub Pages + PeerJS (2026-11-03)

The same app also runs as a **fully static site** with no backend at all:

- **The site root IS the game (`/`)** — exactly like the LAN server, `/`
  opens the board lobby straight away with a fresh 6-char game code
  (Crockford-style base32, no confusing chars) and its join QR. A
  **New code** button under the QR re-mints the code + QR on demand.
  `join/` holds the optional start/join landing page (join by code →
  `play/?g=<code>`).
- **Browser-host architecture** — the board page imports the same isomorphic
  engine (`server/engine/*`, `server/session.js`, `server/room.js`) directly,
  instantiates `GameSession` + `GameRoom` locally, and acts as the
  authoritative host. Phones connect **P2P via PeerJS** (WebRTC
  DataChannels; the board claims the peer id `sechit-webapp-v1-<code>`).
  WebRTC ICE host candidates mean **same-WiFi peers connect directly over
  the LAN** — as fast and responsive as the Node server mode; remote players
  connect P2P over the internet.
- **Mode auto-detection** — clients probe `/socket.io/socket.io.js`: if it
  answers, they use the LAN server; on GitHub Pages it 404s and they switch
  to PeerJS. One deployment serves both.
- **Share & rejoin** — each game has a unique join URL (`play/?g=<code>`)
  rendered as a QR code **client-side** (no server QR endpoint), plus Copy
  Link and Share buttons. Player tokens live in `localStorage` per game code
  (`sechit.session.token.<CODE>`), so refreshing or reopening the tab
  re-attaches to the same seat; the board's rejoin picker lets a player who
  lost their token reclaim their seat by name.
- **Host resume** — the browser host persists a full `GameSession.snapshot()`
  to `localStorage` on every state change (`sechit.host.<code>`); a reload
  rebuilds the exact game via `GameSession.fromSnapshot()` — including
  mid-vote ballots, enacted boards and seat tokens
  (`tests/host-resume.test.js` guarantees the roundtrip).
- **Independent instances** — every game has its own code, peer id, token
  namespace and snapshot key, so any number of games run in parallel.

Deployment (GitHub Pages project page):

1. **Settings → Pages → Build and deployment → Source: “GitHub Actions”** —
   do this FIRST. If Pages is left on “Deploy from a branch”, the raw repo is
   served instead and Jekyll renders this README as the homepage (the exact
   symptom: visiting the site shows documentation text instead of the game).
2. Push to `main`; `.github/workflows/deploy.yml` runs `npm ci` +
   `npm run build:vendor`, assembles a `site/` artifact (`public/` +
   `server/` engine sources + `.nojekyll`), and publishes it.
3. Open the Pages URL — it lands directly on the board lobby with a fresh
   game code and join QR.

`npm run build:vendor` (`scripts/build-vendor.mjs`) copies `peerjs.min.js`
and `jsQR.js` from `node_modules` and bundles the CommonJS `qrcode` browser
entry into an IIFE (`public/vendor/qrcode.min.js`) with esbuild. The LAN
launcher runs it automatically when `public/vendor/` is missing.

## How players join

1. Computer and all phones must be on the **same WiFi network**.
2. The board lobby shows a **QR code** — players scan it, or open manually
   `http://<LAN-IP>:3000/play` (the launcher prints this URL).
3. Each player enters a name and appears as a seat on the board.
4. Phones pair to their seat via a token in `localStorage` — refreshing or
   reconnecting re-attaches to the same player automatically.

## Rules summary

Full rules: free official PDF at [secrethitler.com](https://www.secrethitler.com/).

- **5–10 players.** Roles: 5–6p → 1 Fascist + Hitler (Hitler knows the
  Fascist); 7–8p → 2 Fascists + Hitler; 9–10p → 3 Fascists + Hitler
  (Fascists see only Hitler; Hitler sees no one).
- **Deck:** 6 Liberal / 11 Fascist policies. The draw pile auto-reshuffles
  with the discard pile when fewer than 3 cards remain (unused tiles are
  never revealed).
- **Election:** the President nominates a Chancellor (term limits: last
  elected President & Chancellor ineligible; with ≤5 players only the last
  Chancellor). Majority **Ja** elects; a tie or majority **Nein** moves the
  election tracker up one and passes the presidency. Tracker at 3 →
  **chaos**: the top policy is enacted, its power ignored, tracker and term
  limits reset.
- **Legislative session:** President draws 3, discards 1, passes 2 to the
  Chancellor; the Chancellor discards 1 and enacts the last.
- **Fascist board powers** (unlocked as fascist policies are enacted):

  | Players | #1           | #2           | #3               | #4         | #5                   |
  |---------|--------------|--------------|------------------|------------|----------------------|
  | 5–6     | —            | —            | Policy Peek      | Execution  | Execution (+Veto)    |
  | 7–8     | —            | Investigate  | Special Election | Execution  | Execution (+Veto)    |
  | 9–10    | Investigate  | Investigate  | Special Election | Execution  | Execution (+Veto)    |

- **Veto:** after 5 fascist policies the Chancellor may request a veto; if
  the President agrees, all 3 policies are discarded and the election tracker
  moves up one.
- **Powers:** Investigate Loyalty (party membership only; no player
  investigated twice), Call Special Election (nomination rotation resumes
  after), Policy Peek (top 3, order preserved), Execution (executed players
  cannot speak, vote, or run; executing Hitler wins for Liberals).
- **Winning:** Liberals win with **5 liberal policies** or by executing
  Hitler. Fascists win with **6 fascist policies** or by electing Hitler as
  Chancellor after ≥3 fascist policies are enacted.

## Language toggle (EN | TR) — 2026-10-30

Both clients carry a compact **EN | TR** pill toggle — in the board header
(next to Start/New Game) and in the phone top bar. Each user chooses
independently; the preference persists per device in `localStorage`
(`sechit.lang`), defaults to EN, and switching re-renders everything **live**
(no page reload).

- **Strings** — every user-visible string in both clients lives in one
  dictionary in `public/shared/i18n.js` (~270 keys × 2 languages): phase
  banners, lobby, role reveal & hold-to-reveal labels, voting (the authentic
  PnP **Ja!/Nein!** ballot words stay German in both languages — surrounding
  text is translated), legislative prompts, veto flow, all executive powers,
  win splashes for all four win conditions, board labels (counts, tracker,
  seat markers like term-limited/investigated), toasts, and the license
  credit. Turkish uses natural game terminology (Başkan, Şansölye, Tetkik
  Et, Özel Seçim, Yokla, İdam Et, Veto).
- **Server texts** — the server already emits machine-readable codes only:
  engine errors carry `code` (`server/engine/errors.js`), log lines are
  typed events (`voteResolved`, `policyEnacted`, …). Clients translate codes
  → friendly localized strings via `errorText()` / `logText()`; no server
  refactor was needed and no test guarantees were touched.
- **Localized art** — Turkish board art (`assets/tr/` in the read-only
  sibling assets project) is published as `<name>_tr.png` next to the EN
  files by `scripts/build_assets.py`, which also records a per-asset `lang`
  map in `public/assets/manifest.json`. The toggle swaps the liberal board,
  the three fascist track+summary half pairs and the header/lobby logo
  (`data-localizable` images via `localizedAssetPath()`); the TR liberal art
  is resampled onto the exact EN 4266×1515 canvas and the TR fascist halves
  get identical seam trims, so **all overlay geometry stays valid** —
  per-language overlay constants (`BOARD_GEO` in `public/board/board.js`)
  absorb the ≤8 px content shifts measured by template matching. Plaques,
  role/party cards, ballots, seals and pile art have no TR variant (the
  source art is language-neutral or missing) and are shown unchanged in both
  languages; TR executive-action icons are byte-identical pictograms.
- **Guarantees** — `tests/i18n.test.js` enforces: identical EN/TR key sets
  (a missing translation fails CI), non-empty values, every `ASSET_LANG`
  entry mirrored in the manifest, and byte-exact board-art dimensions
  between languages.

## Board controls (big screen)

- **Start Game** — locks the lobby and deals secret roles to the phones.
- **President plaque** — drag it onto any seat to manually assign the
  presidency (e.g. after a disconnect).
- **Reset** — returns everything to the lobby (old phone sessions are
  invalidated).
- Prominent lobby **join QR**, live vote reveal with per-player Ja/Nein and
  tally, official board art with policy tiles filling the printed slots, draw
  /discard pile art with live counts, election tracker marks on the printed
  fail circles, president/chancellor plaque art on the seating ring, the
  deck-draw QR overlay during legislative sessions, public event log, and the
  license credit. Everything a table needs is on this one page.

## Phone capabilities (`/play`)

- Secret **role card + party membership card** using the official card art —
  **hold-to-reveal**: the card is shown only while you press it
  (pointerdown → reveal; release/leave/cancel → hide). A persistent
  **Hold: My Role** button in the top bar reopens the same hold-to-reveal
  overlay in *every* phase of the game, dead players included.
  **Nothing leaks before the hold**: card fronts are generic ("Top Secret" /
  "Party Membership" — no seal, no team colour, no party imagery) and the
  full-screen overlay stays empty until the button is actually pressed
  (art is injected at pointerdown and wiped on release).
- **Voting** — Ja!/Nein rendered with the official ballot art.
- **Chancellor nomination** picker (president only).
- **Draw 3** — ONE TAP on the president's phone; the 3 cards appear only
  there. (The board's deck QR remains as an alternative: scanning it with
  the phone's native camera opens `/play?d=<token>` and triggers the draw.)
- **Pass 2** — president discards 1 on their phone; the 2 cards are
  delivered to the chancellor's phone instantly, where the chancellor taps
  **Confirm Receipt**, discards 1, and enacts the last.
- **No QR codes on player phones** — targeting is pick-from-list:
  - *Investigate Loyalty*: the president taps a name; their phone then
    privately shows the target's actual party membership card art.
  - *Special Election*: the tapped player becomes the next presidential
    candidate.
  - *Execution*: two-tap guard — the first tap selects the target, a
    **Confirm Execution** screen applies the irreversible kill.
- **Veto** — request/agree screens after 5 fascist policies.

## Playtesting fixes (2026-10-30)

- **Hold-to-reveal leak fixed** — the persistent **Hold: My Role** button and
  the role screen are now completely neutral before a hold: the fascist seal
  was removed from the card fronts, team-tinted shells were dropped, and the
  full-screen reveal overlay is EMPTY until pressed (role art is injected at
  pointerdown and wiped on release — nothing role/team related is in the DOM
  or visible pre-hold).
- **Board seam fixed** — the official print-and-play halves carry their own
  sheet margin + frame line on every edge; at a display junction those stack
  into a white band splitting the word "LIBERAL". `scripts/build_assets.py`
  now excises the junction bands (35 px liberal / 35+29 px fascist) and the
  board page lays the halves out with `gap: 0` at exact art proportions
  (liberal 4266×1515, fascist track 2133×1499, summary 2139×1499) — the two
  halves join seamlessly with zero visible seam. Policy-tile/tracker overlay
  fractions in `public/board/board.js` were re-measured on the trimmed art.
- **Dev testing mode** — one computer, many players:
  ```bash
  ./scripts/start.sh 7      # 5–10, default off
  ```
  The server auto-seats N dev players (P1..PN) in the lobby at startup
  (ordinary seats — phones may still join on top up to 10) and the launcher
  opens ONE BROWSER TAB PER DEV PLAYER, each bound to its seat via
  `/play?p=<per-player-token>`. `GET /api/dev-players` returns the
  name+url list (404 `DEV_MODE_INACTIVE` unless dev mode is active). A board
  reset re-creates the dev seats with fresh tokens. `DEV_PLAYERS=N` env also
  works for `npm start`.
- **2026-10-30 (launcher tab-opening fix)** — the port-handling rewrite of
  `scripts/start.sh` had left the browser-tab step fragile: the server was
  started via subshell-`exec` indirection (so `$!` was not exactly node), the
  readiness loop only *preferred* a ready server instead of *requiring* one,
  and every `xdg-open` was double-detached with `nohup … & disown` (failures
  invisible). Restructured: node now runs as a DIRECT background child
  (deterministic `SERVER_PID`, cleanup trap intact), the launcher hard-gates
  on a 200 from `/api/lan-url` (bails out if the server dies or never
  answers), each tab open is logged (`[start] tab(board): xdg-open …`), the
  board tab ALWAYS opens (also without the dev argument), and dev-player URLs
  are fetched with a retry before the P1..PN tabs open in seat order after
  the board tab.

## Assets (`public/assets/`)

- **2026-10-30** — Curated canonical game assets from the official print-and-play
  PDF (300dpi renders in `../sechit_webapp_assets`, read-only): role cards
  (Liberal/Fascist/Hitler), party membership cards, Ja!/Nein ballots, party
  seals, draw/discard pile markers, president/chancellor plaques, the joined
  liberal board (4336×1515), and the three fascist board track+summary halves.
  22 PNGs total; `public/assets/manifest.json` maps canonical name →
  {file, width, height, kind} and lists known gaps (no policy tiles or card
  backs exist in the PDF — render those with CSS). Regenerate/validate with
  `python3 scripts/build_assets.py` (python3 + Pillow).
- **2026-10-30 (Turkish variants)** — 8 localized PNGs added
  (`board_liberal_tr`, 3× `board_fascist_*_tr`, 3× `board_fascist_summary_*_tr`,
  `logo_transparent_tr`); every localized board matches its EN twin's pixel
  dimensions exactly and manifest entries carry per-asset `lang` maps (see
  the Language toggle section). 30 PNGs total.
- **2026-10-30 (UI integration)** — The board page now composes the official
  art directly: the liberal board strip (draw pile | 5-slot track | discard
  pile) plus the fascist track + summary halves matching the player count
  (`board_fascist_5-6/7-8/9-10` + `board_fascist_summary_*`). Policy tiles are
  clean CSS tiles (blue liberal / red fascist) positioned on the printed
  slots (slot geometry measured from the art), pile art carries live counts,
  tracker marks land on the printed election-tracker circles, and the header
  uses the logo. Phones use the role/party/ballot art as described above.

## Stale-server / port handling (2026-10-30)

Running `./scripts/start.sh` twice (or after a crashed session) used to fail
with a raw `EADDRINUSE` stack trace because a stale `node server/app.js` from
a previous run still held port 3000. Fixed on both layers:

- **`scripts/start.sh`** — before starting, checks whether `$PORT` (default
  3000) is in use. If the holder is a server of *this* project
  (`node server/app.js` with this repo as cwd), it is killed and the launcher
  restarts cleanly with a printed notice. If an unrelated process holds the
  port, the launcher auto-falls back to the next free port with a printed
  notice — the board/join URLs and the terminal QR always reflect the
  **actual** port the server bound. The server is launched directly (`node
  server/app.js`, no npm/`sh` hop) so the cleanup trap always knows exactly
  which process to terminate — Ctrl+C or exit reliably leaves the port free.
- **`server/app.js`** — a listen `error` handler turns `EADDRINUSE` into a
  one-line message (`Port 3000 is already in use — stop the other process or
  run: PORT=3001 ./scripts/start.sh`) and exits with status 1 instead of
  dumping a stack trace.

## QR bug fix (2026-10-30)

The board page at `http://localhost:3000/board` showed **no QR code**: the
page is served at `/board` (no trailing slash), so the HTML's *relative*
asset links (`board.css`, `board.js`) resolved against the root —
`/board.css` and `/board.js` — which both returned **404**. Without
`board.js` nothing ever set the join-QR `<img src>` (and the socket never
connected). Fix: all page assets now use **absolute paths**
(`/board/board.css`, `/board/board.js`, `/play/play.js`, …) so both `/board`
and `/board/` work; the lobby QR additionally has a socket-independent
fallback that fetches `/api/join-url` and renders `/api/qr.png` directly.

## Testing

```bash
npm test            # unit + bot tests (180 tests, incl. i18n + host-resume)
npm run test:unit   # engine unit tests (node:test)
npm run test:bots   # socket.io bots playing complete random games, 5–10p
npm run test:full   # bots with BOT_GAMES_PER_COUNT=10
```

Bot coverage includes the policy-peek wire scenario
(`tests/bots/scenarios.test.js`): the peek ack AND the president's subsequent
private broadcast must carry the 3 peeked cards after the phase has already
advanced (the phone renders its dismissible peek screen from that broadcast),
plus privacy (no other seat ever sees them) and round continuation.

### Dev-mode terminal game log (2026-10-31)

When the server runs with `DEV_PLAYERS=N` (`./scripts/start.sh N`), it prints a
timestamped one-line-per-event summary of the whole game to its terminal —
elections with each player's Ja/Nein, the legislative chain with actual card
identities (drew `[FLF]`, president discarded `L`, chancellor discarded `F`,
ENACTED `F`, board counts, deck/discard sizes incl. reshuffles), powers (peek
cards, investigation party, special-election/execution targets, Hitler's
death), veto traffic, chaos and the win condition (`server/devlog.js`). This is
strictly dev-gated on `DEV_PLAYERS` — production runs print nothing extra —
and wrapped in try/catch so logging can never break the game loop.

Bot coverage includes the QR security scenarios (wrong-player / replayed /
misused tokens rejected; transfer gate before enact) and the scan-target
flows (`tests/bots/scanflows.test.js`): investigate-by-scan with private
result delivery, special-election-by-scan, execution-by-scan with confirm
gate + wrong-confirmer rejection + Hitler-execution win, identity-QR
presence/rotation checks, and non-entitled scans rejected.

## License & attribution

Secret Hitler © Mike Boxleiter, Tommy Maranges, Mac Schubert, released under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see
[secrethitler.com](https://www.secrethitler.com/) for the free official
rules PDF and physical game.

This repository is a **non-commercial fan-made digital replacement** of the
game, licensed under the same **Creative Commons Attribution-NonCommercial-
ShareAlike 4.0** terms: attribution required, no commercial use, and
adaptations must be shared under the same license.
