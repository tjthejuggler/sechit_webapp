// Shared client glue: connection helpers, QR rendering and token persistence.
// Both pages (board + phone) import this first.
//
// Transport lives in net.js: Socket.IO against the Node server (LAN mode) or
// PeerJS peer-to-peer to the host's board tab (online/static mode). The
// helpers below keep the exact call shapes the pages have always used.

export { connectPlay, detectMode, MODE, generateGameCode } from './net.js';

// Fire a player action; resolves { ok, result, you } or throws { code, message }.
// Works on both transports (NetSocket mimics the socket.io ack protocol).
export function sendAction(socket, type, args = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit('action', { type, ...args }, (err, res) => {
      if (err) return reject({ code: 'TIMEOUT', message: 'Server did not respond.' });
      if (!res || !res.ok) {
        return reject({ code: res?.code ?? 'SERVER_ERROR', message: res?.message ?? 'Action failed.' });
      }
      resolve(res);
    });
  });
}

export function socketEmit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) return reject({ code: 'TIMEOUT', message: 'Server did not respond.' });
      if (res && res.ok === false) return reject(res);
      resolve(res);
    });
  });
}

// ------------------------------------------------------------------ QR codes
// Rendering is fully client-side (public/vendor/qrcode.min.js — the qrcode
// npm package bundled for the browser) so the static site needs no server.
// The Node server still offers /api/qr.png for compatibility, but clients no
// longer call it.

// Resolve a QR payload to a data-URL PNG. No-op (returns null) if the vendored
// lib failed to load.
export function qrDataUrl(text, { width = 512, margin = 2 } = {}) {
  return new Promise((resolve) => {
    if (typeof window.QRCode?.toDataURL !== 'function') return resolve(null);
    window.QRCode.toDataURL(String(text), { width, margin, errorCorrectionLevel: 'M' }, (err, url) => {
      resolve(err ? null : url);
    });
  });
}

// Point an existing <img> at a freshly rendered QR (async, keeps prior src on
// failure). Deduplicates concurrent updates per element.
export async function setQrImg(img, text) {
  if (!img) return;
  if (img.dataset.qrFor === text && img.src) return;
  img.dataset.qrFor = text;
  const url = await qrDataUrl(text);
  if (url && img.dataset.qrFor === text) img.src = url;
}

// Render a QR into `el` (any element) as an <img>. Returns the created img.
export async function renderQr(el, text, { size = 256, alt = 'QR code' } = {}) {
  const img = document.createElement('img');
  img.className = 'qr-img';
  img.alt = alt;
  img.width = size;
  img.height = size;
  el.replaceChildren(img);
  await setQrImg(img, text);
  return img;
}

// -------------------------------------------------------------- QR scanning
// jsQR via getUserMedia camera scan, used on phones to scan the board's draw
// QR and the president's transfer QR. Single-use: stop() releases the camera.

export async function scanQr({ onResult, onError = console.warn, continuous = false } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  const video = document.createElement('video');
  video.setAttribute('playsinline', 'true');
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stopped = false;
  let rafId = null;

  function stop() {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    for (const track of stream.getTracks()) track.stop();
  }

  function tick() {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (canvas.width > 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          onResult(code.data);
          if (!continuous) {
            stop();
            return;
          }
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  video.addEventListener('loadeddata', () => {
    rafId = requestAnimationFrame(tick);
  });
  window.addEventListener('pagehide', stop, { once: true });

  return { stop, video };
}

// Read a scanned URL's query params: g (game id), d (draw token), t (transfer token).
export function parseScanPayload(text) {
  try {
    const url = new URL(text);
    return {
      isUrl: true,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams.entries()),
    };
  } catch {
    // Raw token (not a URL) — assume draw token if it looks like an id.
    return { isUrl: false, params: { d: text } };
  }
}

// ------------------------------------------------------------------- misc UI

export function showToast(message, { error = false, ms = 3200 } = {}) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

// Session token persistence (localStorage) for reconnect. Tokens are stored
// PER GAME CODE so one device can play in multiple games without collisions;
// the original global key is kept as the LAN fallback (single game server).
const TOKEN_KEY = 'sechit.session.token';

function tokenKey(gameId) {
  return gameId ? `${TOKEN_KEY}.${String(gameId).toUpperCase()}` : TOKEN_KEY;
}

export function loadToken(gameId = null) {
  return localStorage.getItem(tokenKey(gameId));
}

export function saveToken(token, gameId = null) {
  if (token) localStorage.setItem(tokenKey(gameId), token);
}

export function clearToken(gameId = null) {
  localStorage.removeItem(tokenKey(gameId));
}

// Current game code from the URL (?g=), normalized uppercase; null on the
// LAN server (single game) or when absent.
export function urlGameCode() {
  const g = new URLSearchParams(location.search).get('g');
  return g ? g.trim().toUpperCase() : null;
}
