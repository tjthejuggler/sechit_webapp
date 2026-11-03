#!/usr/bin/env bash
# Secret Hitler launcher.
#
# Usage: ./scripts/start.sh [N] [--invest]   (N = 5..10, optional DEV players)
#
#  --invest  house rule: in 5–6 player games the FIRST fascist power becomes
#            an INVESTIGATION instead of the normal "peek at the top 3 cards".
#            The board looks the same; the app just grants the president the
#            investigation power for that slot. Without the flag: normal rules.
#
#  - installs dependencies if node_modules is missing
#  - frees the port if a stale instance of THIS project's server holds it
#  - starts the server (PORT env, default 3000); if an unrelated process
#    occupies the port, auto-falls back to the next free port with a notice
#  - waits until the server actually answers (hard gate: a dead or slow
#    server aborts the launcher instead of opening tabs at a dead URL)
#  - opens the central board in the default browser — ALWAYS, also without
#    the dev argument
#  - with N: DEV testing mode — the server auto-seats N dev players (P1..PN)
#    and the launcher opens ONE BROWSER TAB PER DEV PLAYER (each bound to that
#    player's session via /play?p=<token> from /api/dev-players), so a single
#    computer can play all seats. Real phones can still join on top (up to 10
#    total). Board tab opens first, then one tab per player, in seat order.
#  - prints the LAN join URL for phones + a terminal QR fallback
#    (always reflecting the ACTUAL port the server ended up on)
#  - Ctrl+C stops the server cleanly: node runs as a direct background child
#    (no exec indirection), so SERVER_PID is exactly the server process and
#    the EXIT/INT/TERM trap can always kill precisely what it started.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${PORT:-3000}"

# ------------------------------------------------------- dev players argument
DEV_PLAYERS="${DEV_PLAYERS:-0}"
INVESTIGATE_FIRST_POWER="${INVESTIGATE_FIRST_POWER:-0}"
for arg in "$@"; do
  case "$arg" in
    --invest)
      INVESTIGATE_FIRST_POWER=1
      ;;
    ''|*[!0-9]*)
      echo "[start] ERROR: argument must be a number 5–10 (dev player count) or --invest, got: $arg" >&2
      exit 1
      ;;
    *)
      if [ "$arg" -lt 5 ] || [ "$arg" -gt 10 ]; then
        echo "[start] ERROR: dev player count must be 5–10, got: $arg" >&2
        exit 1
      fi
      DEV_PLAYERS="$arg"
      ;;
  esac
done
if [ "$INVESTIGATE_FIRST_POWER" = "1" ]; then
  echo "[start] House rule active: first fascist power in 5–6p games is INVESTIGATE (not policy peek)."
fi

# ------------------------------------------------------------ port utilities

# True when we can bind the port (i.e. it is free right now).
port_is_free() {
  node -e '
    const net = require("net");
    const srv = net.createServer();
    srv.once("error", () => process.exit(1));
    srv.listen(Number(process.argv[1]), "0.0.0.0", () => srv.close(() => process.exit(0)));
  ' "$1" 2>/dev/null
}

# PIDs listening on the given port (best effort; empty if ss is unavailable
# or cannot attribute the socket to a process).
pids_on_port() {
  ss -ltnp "sport = :$1" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | sort -u || true
}

# True when a pid is a `node server/app.js` process of THIS project.
is_our_server_pid() {
  local pid="$1" cmd cwd
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cmd" == *server/app.js* && "$cwd" == "$ROOT_DIR" ]]
}

# Kill stale instances of THIS project's server that still hold the port.
reclaim_port() {
  local port="$1" pid killed=0
  for pid in $(pids_on_port "$port"); do
    if is_our_server_pid "$pid"; then
      echo "[start] Stale server detected (pid ${pid}) on port ${port} — killing it."
      kill "$pid" 2>/dev/null || true
      killed=1
    fi
  done
  if [ "$killed" -eq 1 ]; then
    # Give it up to ~3 s to release the port, then force-kill leftovers.
    for _ in $(seq 1 30); do
      port_is_free "$port" && break
      sleep 0.1
    done
    for pid in $(pids_on_port "$port"); do
      if is_our_server_pid "$pid"; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
    sleep 0.2
  fi
}

# ------------------------------------------------------------- dependencies
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[start] node_modules missing — running npm install..."
  (cd "$ROOT_DIR" && npm install)
fi

# Vendor bundles (peerjs/qrcode/jsQR in public/vendor) — the LAN board page
# loads them for client-side QR rendering; build once, rebuild if missing.
if [ ! -f "$ROOT_DIR/public/vendor/peerjs.min.js" ] \
  || [ ! -f "$ROOT_DIR/public/vendor/qrcode.min.js" ] \
  || [ ! -f "$ROOT_DIR/public/vendor/jsQR.js" ]; then
  echo "[start] Vendor bundles missing — running npm run build:vendor..."
  (cd "$ROOT_DIR" && npm run build:vendor)
fi

# ----------------------------------------------------------- port selection
reclaim_port "$PORT"

if ! port_is_free "$PORT"; then
  original_port="$PORT"
  for _ in $(seq 1 20); do
    PORT=$((PORT + 1))
    if port_is_free "$PORT"; then
      echo "[start] NOTICE: port ${original_port} is held by an unrelated process — using port ${PORT} instead."
      break
    fi
  done
  if ! port_is_free "$PORT"; then
    echo "[start] ERROR: no free port found in ${original_port}..$((original_port + 20)). Free the port or run with an explicit PORT, e.g. PORT=3001 ./scripts/start.sh" >&2
    exit 1
  fi
fi

# ------------------------------------------- LAN IPv4 (same logic as lan.js)
LAN_IP="$(node -e "import(process.argv[1]).then(m => console.log(m.detectLanIp()))" \
  "$ROOT_DIR/server/lan.js")"
BOARD_URL="http://localhost:${PORT}/board"
JOIN_URL="http://${LAN_IP}:${PORT}/play"

# --------------------------------------------------------------- URL helpers

# HTTP readiness probe: exit 0 iff the path answers with 200.
probe() {
  node -e "require('http').get(process.argv[1], r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" "$1" 2>/dev/null
}

# Fetch the per-dev-player /play URLs (dev mode only). Prints one URL per
# line; exits non-zero on any HTTP/parse failure so the caller can retry.
fetch_dev_urls() {
  node -e '
    const http = require("http");
    http.get(process.argv[1], (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) process.exit(1);
        try {
          const data = JSON.parse(body);
          for (const p of data.players ?? []) console.log(p.url);
        } catch {
          process.exit(1);
        }
      });
    }).on("error", () => process.exit(1));
  ' "http://localhost:${PORT}/api/dev-players" 2>/dev/null
}

# Resolve the launcher script of the ALREADY-RUNNING firefox instance by
# walking /proc: exe is .../firefox-bin, the launcher is .../firefox in the
# same directory. Prints nothing when no firefox is running.
running_firefox_bin() {
  local pid exe dir
  for pid in $(pgrep -f 'firefox-bin' 2>/dev/null || true); do
    exe="$(readlink -f "/proc/${pid}/exe" 2>/dev/null || true)"
    case "$exe" in
      */firefox-bin)
        dir="$(dirname "$exe")"
        [ -x "$dir/firefox" ] && { echo "$dir/firefox"; return 0; }
        ;;
    esac
  done
  return 1
}

# Fire an opener with stdout+stderr captured, bounded by timeout, and log a
# per-tab evidence line: rc and any non-Gtk-noise stderr. A MISMATCHED
# firefox install (PATH `firefox` = snap wrapper while the desktop runs
# /opt/firefox132) can exit 0 SILENTLY without opening any tab — rc/stderr
# logging is the only honest signal we have.
launch_and_log() {
  local label="$1" url="$2"; shift 2
  local log; log="$(mktemp /tmp/sechit-tab.XXXXXX)"
  timeout 10 "$@" --new-tab "$url" >"$log" 2>&1 </dev/null &
  local pid=$!
  wait "$pid"; local rc=$?
  local err
  err="$(grep -v 'Gtk-Message' "$log" 2>/dev/null | tr '\n' ' ' | sed -e 's/^ *//' -e 's/ *$//' | head -c 300)"
  rm -f "$log"
  echo "[start] tab(${label}) $* -> rc=${rc} err=${err:-<none>}"
  [ "$rc" -eq 0 ] && [ -z "$err" ]
}

# Open one browser tab. The invocation is LOGGED explicitly (command
# construction is auditable) and spawned with std streams captured.
#
# OPENER CHAIN (in order, first hit wins; the fired method + rc + stderr are
# logged):
#   1. $BROWSER env var (colon-separated candidates, "%s" URL placeholder ok)
#   2. the RUNNING firefox's own launcher binary (from /proc/*/exe) — the
#      binary that matches the live instance reliably hands it a --new-tab
#      remote command (verified: /opt/firefox132/firefox)
#   3. firefox132 / /opt/firefox132/firefox  (this machine's real install)
#   4. chromium / chromium-browser / google-chrome, then plain `firefox`
#      (snap wrapper — SILENTLY no-ops against a foreign running instance,
#      so it is deliberately LAST among browsers)
#   5. python3 -m webbrowser
#   6. xdg-open                (last resort — exits 0 WITHOUT opening a tab
#                              when the default browser is a snap/userapp-*.desktop)
# Firefox under KDE/Wayland: a fresh process defaults to X and dies with
# "cannot open display" — force Wayland when the session is Wayland.
open_tab() {
  local url="$1" label="$2" cmd_bin cmd_args
  # UNCONDITIONAL override (verbatim TailCue mechanism): the user's shell
  # profile exports MOZ_ENABLE_WAYLAND=0, which made every firefox spawn
  # fall back to X and die with "cannot open display" — a :-default would
  # silently keep the inherited 0. Always force Wayland on this session.
  export MOZ_ENABLE_WAYLAND=1

  # 1) $BROWSER: may be "bin" or "bin %s" or "bin1:bin2" (xdg spec).
  if [ -n "${BROWSER:-}" ]; then
    local IFS_browser="$BROWSER" entry cand rest
    rest="$BROWSER"
    while [ -n "$rest" ]; do
      entry="${rest%%:*}"
      rest="${rest#*:}"; [ "$rest" = "$BROWSER" ] && rest=""
      cmd_bin="${entry%%[[:space:]]*}"
      case "$entry" in
        *'%s'*) cmd_args="${entry//%s/$url}" ;;
        *)      cmd_args="$url" ;;
      esac
      if command -v "$cmd_bin" >/dev/null 2>&1; then
        echo "[start] tab(${label}): \$BROWSER -> ${cmd_bin} ${cmd_args}"
        "$cmd_bin" $cmd_args >/dev/null 2>&1 </dev/null &
        return 0
      fi
    done
  fi

  # 2) The RUNNING firefox's own launcher — same install as the live
  #    instance, so the remote --new-tab command actually reaches it.
  # 3)+4) Known browser binaries, direct --new-tab.
  local candidates=() c
  c="$(running_firefox_bin || true)"
  [ -n "$c" ] && candidates+=("$c")
  for c in firefox132 /opt/firefox132/firefox chromium chromium-browser google-chrome firefox; do
    command -v "$c" >/dev/null 2>&1 && candidates+=("$(command -v "$c")")
  done
  for c in "${candidates[@]}"; do
    if launch_and_log "$label" "$url" "$c"; then
      return 0
    fi
  done

  # 5) python3 webbrowser module (knows about desktop registrations).
  if command -v python3 >/dev/null 2>&1; then
    echo "[start] tab(${label}): python3 -m webbrowser ${url}"
    python3 -c 'import sys,webbrowser; webbrowser.open(sys.argv[1])' "$url" \
      >/dev/null 2>&1 </dev/null &
    return 0
  fi

  # 6) xdg-open — last resort (silently no-ops for snap browsers on KDE).
  if command -v xdg-open >/dev/null 2>&1; then
    echo "[start] tab(${label}): xdg-open ${url}"
    xdg-open "$url" >/dev/null 2>&1 </dev/null &
    return 0
  fi

  echo "[start] no browser opener found — open ${url} manually." >&2
  return 1
}

# -------------------------------------------------------------------- server
# Launch node as a DIRECT background child of this script (no npm/sh hop and
# no subshell-exec indirection): SERVER_PID is exactly the server process, so
# the cleanup trap's signals are deterministic. The cwd stays ROOT_DIR so
# port-reclaim attribution (is_our_server_pid) and bare-import QR rendering
# resolve against this project.
echo "[start] Starting server on port ${PORT}${DEV_PLAYERS:+ with ${DEV_PLAYERS} dev players}..."
cd "$ROOT_DIR"
PORT="$PORT" DEV_PLAYERS="$DEV_PLAYERS" INVESTIGATE_FIRST_POWER="$INVESTIGATE_FIRST_POWER" node server/app.js &
SERVER_PID=$!

cleanup() {
  trap - INT TERM EXIT
  [ -n "${SERVER_PID:-}" ] || return 0
  kill -0 "$SERVER_PID" 2>/dev/null || return 0
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$SERVER_PID" 2>/dev/null || true
  pkill -KILL -P "$SERVER_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# ------------------------------------------------ readiness (hard gate)
# Wait (max ~20 s) until the server answers. Bail out early if the server
# process dies (e.g. EADDRINUSE) or if it never becomes ready — opening
# browser tabs against a dead port is exactly the bug this prevents.
SERVER_READY=0
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[start] ERROR: server exited during startup (see its message above)." >&2
    exit 1
  fi
  if probe "http://localhost:${PORT}/api/lan-url"; then
    SERVER_READY=1
    break
  fi
  sleep 0.2
done
if [ "$SERVER_READY" -ne 1 ]; then
  echo "[start] ERROR: server did not answer within 20 s — not opening browser tabs." >&2
  exit 1
fi

echo
echo "  Board (this computer): ${BOARD_URL}"
echo "  Join on phones (LAN) : ${JOIN_URL}"
echo

# Terminal QR fallback for the phone join URL.
node -e "import('qrcode').then(q => q.default.toString(process.argv[1], { type: 'terminal', small: true })).then(s => console.log(s))" \
  "$JOIN_URL" || echo "[start] (terminal QR unavailable — open ${JOIN_URL} on phones)"

# ------------------------------------------------------------- browser tabs
# 1) Board tab: ALWAYS opened, dev mode or not.
open_tab "$BOARD_URL" board || true

# 2) DEV testing mode: one desktop tab PER dev player, each bound to that
#    player's session (per-seat token from /api/dev-players). Real phones can
#    still join on top — dev seats are ordinary lobby members.
if [ "$DEV_PLAYERS" -gt 0 ]; then
  DEV_URLS=""
  # Retry briefly: seats exist as soon as the server listens, but be lenient.
  for _ in $(seq 1 25); do
    if DEV_URLS="$(fetch_dev_urls)" && [ -n "$DEV_URLS" ]; then
      break
    fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.2
  done
  if [ -n "$DEV_URLS" ]; then
    echo "[start] Opening ${DEV_PLAYERS} dev player tabs..."
    n=0
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      n=$((n + 1))
      open_tab "$url" "dev-player-${n}/${DEV_PLAYERS}" || true
      sleep 0.4   # give the browser a beat between tab spawns
    done <<< "$DEV_URLS"
  else
    echo "[start] NOTICE: could not fetch dev player URLs — open http://localhost:${PORT}/api/dev-players manually." >&2
  fi
fi

echo "[start] Press Ctrl+C to stop the server."
wait "$SERVER_PID"
