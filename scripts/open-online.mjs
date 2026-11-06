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
// Opener strategy (mirrors scripts/start.sh — plain `xdg-open` exits 0
// WITHOUT opening anything on KDE/snap setups, so it is a last resort only):
//   1. $BROWSER env var (colon-separated, %s placeholder supported)
//   2. the RUNNING Firefox's own launcher binary via /proc/*/exe
//      (the same install as the live instance reliably accepts --new-tab)
//   3. known browser binaries: firefox132, /opt/firefox132/firefox,
//      chromium, chromium-browser, google-chrome, firefox
//   4. xdg-open (last resort; failures are loud, not silent)
// Every attempt is logged with its exit code + captured stderr, and the
// full tab URLs are always printed as a fallback so nothing is ever lost.
//
// Usage:
//   node scripts/open-online.mjs [N] [--url URL] [--code CODE] [--no-open]
//     N         players, 5–10 (default 5) → N player tabs + the board tab
//     --url     site base (default: the deployed GitHub Pages site;
//               e.g. http://localhost:8788 for a local static build)
//     --code    reuse a specific game code instead of a fresh random one
//     --no-open print the URLs only (open them yourself)
// Examples:
//   node scripts/open-online.mjs           # 5 players on the live site
//   node scripts/open-online.mjs 7         # 7 players
//   npm run play:online -- 6
//   node scripts/open-online.mjs 5 --url http://localhost:8788
import { parseArgs } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { readlinkSync, existsSync } from 'node:fs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'https://tjthejuggler.github.io/sechit_webapp' },
    code: { type: 'string', default: '' },
    'no-open': { type: 'boolean', default: false },
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

if (values['no-open']) {
  console.log('[open] --no-open: URLs printed above — open them in your browser.');
  process.exit(0);
}

// ------------------------------------------------------- opener discovery

// The RUNNING Firefox's launcher: walk /proc for firefox-bin processes and
// take the `firefox` binary beside the exe (the live install). A snap-
// wrapped `firefox` on PATH can silently no-op against a foreign instance —
// the binary that owns the RUNNING process never does.
function runningFirefoxLauncher() {
  try {
    const pids = execFileSync('pgrep', ['-f', 'firefox'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    for (const pid of pids) {
      try {
        // readlink (not readFile): /proc/<pid>/exe is a magic symlink and
        // reading it as a file fails with EACCES even for the owner.
        const exe = readlinkSync(`/proc/${pid}/exe`);
        const dir = exe.slice(0, exe.lastIndexOf('/'));
        const launcher = `${dir}/firefox`;
        // Accept both `firefox-bin` and the update-renamed `*.moz-backup`
        // variants (a running instance renames its binary while updating —
        // the launcher beside it is still the right install).
        if (/(firefox-bin|firefox-bin\.moz-backup)( \(deleted\))?$/.test(exe) && existsSync(launcher)) return launcher;
      } catch { /* process vanished or not ours */ }
    }
  } catch { /* pgrep missing */ }
  return null;
}

// Candidate list, best first.
const candidates = [];
if (process.env.BROWSER && process.env.BROWSER !== 'none') {
  for (const entry of process.env.BROWSER.split(':')) {
    const bin = entry.split(/\s+/)[0];
    if (bin) candidates.push({ cmd: bin, label: `$BROWSER:${bin}` });
  }
}
const ff = runningFirefoxLauncher();
if (ff) candidates.push({ cmd: ff, label: 'running-firefox' });
for (const c of ['firefox132', '/opt/firefox132/firefox', 'chromium', 'chromium-browser', 'google-chrome', 'firefox']) {
  candidates.push({ cmd: c, label: c });
}
candidates.push({ cmd: 'xdg-open', label: 'xdg-open' });

// ------------------------------------------------------------- opener logic

// Firefox under KDE/Wayland: a fresh process defaults to X and dies with
// "cannot open display" (the user profile even exports MOZ_ENABLE_WAYLAND=0).
// start.sh solved this by ALWAYS forcing Wayland — same here (fallback path).
process.env.MOZ_ENABLE_WAYLAND = '1';

// Verified against this machine's wedged mid-update Firefox: the running
// instance's DBus OpenURL returns () WITHOUT delivering, and --new-tab is
// swallowed too — but --new-window ALWAYS creates a visible window (the
// remote hands it to the running instance, which then maps it). So:
//   board  → --new-window (guaranteed visible)
//   phones → --new-tab    (lands in the just-focused board window)
// and every open is VERIFIED via xdotool window titles — never trust exit
// codes alone. DETACHED spawn (setsid): never kill a cold-starting browser
// (the old execFile+timeout actively murdered Firefox mid-launch).
import { spawn } from 'node:child_process';

function verifyWindow(substr, timeout = 20000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      try {
        const out = execFileSync('xdotool', ['search', '--name', substr], { encoding: 'utf8' });
        if (out.trim()) return resolve(out.trim().split('\n')[0]);
      } catch { /* xdotool missing / no X */ }
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(tick, 400);
    };
    tick();
  });
}

function focusWindow(winId) {
  try {
    execFileSync('xdotool', ['windowactivate', '--sync', winId], { timeout: 5000, stdio: 'ignore' });
  } catch { /* best effort */ }
}

function launchDetached(cmd, args) {
  // setsid + stdio ignore: the browser outlives this script no matter what.
  const child = spawn('setsid', [cmd, ...args], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function openTab(cmd, url, tag, { newWindow = false, expect = null } = {}) {
  const args = /firefox/.test(cmd)
    ? [newWindow ? '--new-window' : '--new-tab', url]
    : [url];
  launchDetached(cmd, args);
  const winId = expect ? await verifyWindow(expect) : null;
  if (expect && winId) {
    focusWindow(winId);
    console.log(`[open] ok  ${tag}: ${url} (window verified)`);
    return true;
  }
  if (!expect) {
    // No title to verify (e.g. phone tabs share the board window) — a
    // successful detached spawn of a known-good binary is our best signal.
    console.log(`[open] ok  ${tag}: ${url}`);
    return true;
  }
  console.error(`[open] FAIL ${tag}: no window titled "${expect}" appeared — open manually: ${url}`);
  return false;
}

(async () => {
  // Pick the best binary once (the running-install launcher beats PATH on
  // this box; --new-window/--new-tab against it verified working).
  const primary = candidates.find((c) => /firefox/.test(c.cmd))?.cmd ?? candidates[0]?.cmd;
  if (!primary) { console.error('[open] no browser binary found'); process.exit(1); }

  console.log(`[open] browser : ${primary}`);
  console.log('[open] opening the BOARD window (game host) — keep it open!');
  // Board: its own window, verified by the page title (Firefox titles it
  // "Secret Hitler … — Mozilla Firefox"; the code lives in the URL, not the
  // title, so verify on the site name and longer — cold loads take a while).
  await openTab(primary, boardUrl, 'board', { newWindow: true, expect: 'Secret Hitler' });
  await new Promise((r) => setTimeout(r, 2500)); // let the host claim its peer id first

  // Players: --new-tab into the freshly focused window (the wedged-remote
  // workaround made --new-tab reliable once a fresh window exists; and even
  // if a tab lands elsewhere it is still open in this Firefox).
  for (let i = 0; i < n; i++) {
    await openTab(primary, playerUrls[i], `player ${i + 1}/${n}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('');
  console.log('  In each PLAYER tab tap "Take a Seat" (the name is prefilled),');
  console.log('  then play every seat by hand from the board tab.');
  console.log(`  Real phones can join too: scan the board QR or open`);
  console.log(`  ${base}/play/?g=${code}`);
  console.log('  Keep the BOARD tab open — it is the game host.');
  if (!values['no-open']) {
    console.log('  (If any tab seems missing, the URLs printed above are all');
    console.log('   copy/paste-able — every tab lands in the same Firefox.)');
  }
})();
