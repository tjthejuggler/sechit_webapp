#!/usr/bin/env node
// Manual online playtesting launcher — the GitHub Pages equivalent of
// `./scripts/start.sh N`'s tab-opening behavior:
//
//   1. opens the LIVE board page in a tab with a fresh game code
//      (?host=<code> — the QR + join code + share buttons are live there),
//   2. opens ONE TAB PER PLAYER on the same game (?g=<code>&name=P<n> —
//      each tab's join form comes prefilled; you still tap "Take a Seat"),
//   3. prints the game code + every tab URL so you can also open seats on
//      real phones by scanning the board's QR / typing the code.
//
// YOU then perform every action by hand in each tab — this script only sets
// the table. Board tab must stay open: it IS the game host (P2P).
//
// Usage:
//   node scripts/open-online.mjs [N] [--url URL] [--code CODE]
//     N       players, 5–10 (default 5) → N player tabs + the board tab
//     --url   site base (default: the deployed GitHub Pages site;
//             e.g. http://localhost:8788 for a local static build)
//     --code  reuse a specific game code instead of a fresh random one
// Examples:
//   node scripts/open-online.mjs           # 5 players on the live site
//   node scripts/open-online.mjs 7         # 7 players
//   npm run play:online -- 6
//   node scripts/open-online.mjs 5 --url http://localhost:8788
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'https://tjthejuggler.github.io/sechit_webapp' },
    code: { type: 'string', default: '' },
  },
});
const n = Math.min(10, Math.max(5, parseInt(positionals[0], 10) || 5));

// Fresh 6-char game code (same alphabet as shared/net.js generateGameCode).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const code = (values.code || Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')).toUpperCase();

const base = values.url.replace(/\/$/, '');
const boardUrl = `${base}/board/?host=${code}`;
const playerUrls = Array.from({ length: n }, (_, i) => `${base}/play/?g=${code}&name=P${i + 1}`);

console.log(`[open] site   : ${base}`);
console.log(`[open] code   : ${code}`);
console.log(`[open] board  : ${boardUrl}`);
playerUrls.forEach((u, i) => console.log(`[open] player ${i + 1}: ${u}`));

// Tab opener per platform — works against the user's real default browser.
function openTab(url) {
  const os = platform();
  const cmd = os === 'darwin' ? 'open' : os === 'win32' ? 'cmd' : 'xdg-open';
  const args = os === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(!err));
  });
}

(async () => {
  console.log(`[open] opening the board tab (game host) — keep it open!`);
  await openTab(boardUrl);
  await new Promise((r) => setTimeout(r, 2500)); // let the host claim its peer id first
  for (let i = 0; i < n; i++) {
    console.log(`[open] opening player ${i + 1}/${n} tab (name prefilled — tap "Take a Seat")`);
    await openTab(playerUrls[i]);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('');
  console.log('  All tabs are open. In each PLAYER tab tap "Take a Seat" (the name');
  console.log('  is prefilled), then play every seat by hand from the board tab.');
  console.log(`  Real phones can join too: scan the board QR or open`);
  console.log(`  ${base}/play/?g=${code}`);
  console.log('  Keep the BOARD tab open — it is the game host.');
})();
