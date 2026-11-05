#!/usr/bin/env node
// Online gameplay simulator — the static-host equivalent of
// `./scripts/start.sh N` + bot tests: launches the REAL board page
// (board/?bots=N&games=G) in headless Chrome, where the page's own
// GameSession + GameRoom host N in-page virtual phones through the exact
// handlePlay protocol real PeerJS phones trigger. When the run finishes,
// every game's PUBLIC EVENT LOG is re-verified offline by the same strict
// verifier the wire-level bot tests use (tests/bots/driver.js):
//   - exactly one legal GAME_OVER per game (winner + reason valid),
//   - vote completeness per election, dead players never vote,
//   - full legislative chain per government (form → draw → discard →
//     receive → enact / veto), and
//   - 17-tile policy conservation across every reshuffle.
//
// Usage:
//   node scripts/simulate-online.mjs [N] [--games G] [--url URL] [--headful]
//     N        players per game, 5–10 (default 7)
//     --games  how many complete games to play (default 1)
//     --url    board page base (default http://localhost:8788/board/ —
//              a static server of this repo is started automatically;
//              pass your GitHub Pages URL to test the deployed site)
// Examples:
//   node scripts/simulate-online.mjs 7
//   node scripts/simulate-online.mjs 5 --games 3
//   node scripts/simulate-online.mjs 9 --url https://<user>.github.io/<repo>/board/
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    games: { type: 'string', default: '1' },
    url: { type: 'string', default: '' },
    headful: { type: 'boolean', default: false },
  },
});
const n = Math.min(10, Math.max(5, parseInt(positionals[0], 10) || 7));
const games = Math.max(1, parseInt(values.games, 10) || 1);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- static srv
// Serve the repo root exactly like GitHub Pages does (the sim only needs this
// when no --url is given).
let server = null;
let baseUrl = values.url;
if (!baseUrl) {
  const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.png': 'image/png', '.json': 'application/json',
  };
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, p);
    if (existsSync(file)) {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/board/`;
}

const pageUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}bots=${n}&games=${games}`;
console.log(`[sim] players=${n} games=${games}`);
console.log(`[sim] page: ${pageUrl}`);

// ------------------------------------------------------------------- browser
const browser = await puppeteer.launch({
  headless: values.headful ? false : 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/node:module|socket\.io|ERR_FAILED|404/.test(t)) consoleErrors.push(t);
});

await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });

// Wait for the sim hook to appear, then poll progress until done/failed.
const OVERALL_TIMEOUT = 10 * 60 * 1000; // 10 min for large game counts
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < OVERALL_TIMEOUT) {
  const st = await page.evaluate(() => {
    const s = window.__sim;
    return s ? {
      done: s.done, error: s.error, progress: s.progress, total: s.total,
      phase: s.phase, results: s.done ? s.results : null,
    } : null;
  }).catch(() => null);

  if (!st) {
    console.error('[sim] the simulator hook never started (no window.__sim) — is ?bots= wired?');
    process.exitCode = 1;
    break;
  }
  const line = `[sim] ${st.progress}/${st.total} games · ${st.phase}`;
  if (line !== last) { console.log(line); last = line; }

  if (st.error) {
    console.error(`[sim] FAILED: ${st.error}`);
    if (consoleErrors.length) console.error(`[sim] console errors:\n${consoleErrors.slice(0, 10).join('\n')}`);
    process.exitCode = 1;
    break;
  }
  if (st.done) {
    // Pull the full results (logs included) out of the page for verification.
    const results = await page.evaluate(() => window.__sim.results);
    await verifyAll(results, n);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}

await browser.close();
server?.close();

// ---------------------------------------------------------------- verification
async function verifyAll(results, playerCount) {
  // Import the strict verifier + engine constants from the repo (plain ES
  // modules — they run in Node exactly like the offline bot tests).
  const { verifyLogHistory } = await import(join(ROOT, 'tests', 'bots', 'driver.js'));
  const WIN_REASONS = {
    liberal: ['liberalPoliciesEnacted', 'hitlerExecuted'],
    fascist: ['fascistPoliciesEnacted', 'hitlerElectedChancellor'],
  };

  let failures = 0;
  for (const r of results) {
    const tag = `game ${r.game} (${r.playerCount}p, ${r.steps} steps, ${r.events} events, ${r.ms}ms)`;
    try {
      if (r.playerCount !== playerCount) throw new Error(`player count mismatch: ${r.playerCount} != ${playerCount}`);
      if (r.winner !== 'liberal' && r.winner !== 'fascist') throw new Error(`illegal winner ${r.winner}`);
      if (!WIN_REASONS[r.winner].includes(r.winReason)) throw new Error(`illegal win reason ${r.winReason}`);
      // The same log walk the offline bot tests enforce.
      verifyLogHistory({
        phase: 'GAME_OVER',
        players: r.players,
        liberalCount: r.liberalCount,
        fascistCount: r.fascistCount,
        log: r.log,
      }, { requireGameOver: true });
      console.log(`[verify] OK  ${tag} → ${r.winner} wins (${r.winReason})`);
    } catch (err) {
      failures += 1;
      console.error(`[verify] FAIL ${tag}: ${err.message}`);
    }
  }
  if (failures) {
    console.error(`[sim] ${failures}/${results.length} games failed verification`);
    process.exitCode = 1;
  } else {
    console.log(`[sim] ALL ${results.length} game(s) verified — online gameplay works end to end.`);
  }
  if (consoleErrors.length) {
    console.log(`[sim] (page console errors: ${consoleErrors.length} — first few:)`);
    console.log(consoleErrors.slice(0, 5).join('\n'));
  }
}
