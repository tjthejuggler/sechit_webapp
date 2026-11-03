// Shared client glue: Socket.IO connection helpers + QR canvas rendering.
// Both pages (board + phone) import this first.

// --------------------------------------------------------------- socket glue

export function connectBoard() {
  const socket = io('/board', { auth: { client: 'board' } });
  return socket;
}

export function connectPlay({ token = null } = {}) {
  const socket = io('/play', { auth: { token, client: 'play' } });
  return socket;
}

// Fire a player action; resolves { ok, result, you } or throws { code, message }.
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
// Rendering is server-side (`qrcode` npm lib): /api/qr.png?t=<payload> returns
// a PNG. This keeps every client dependency-free; jsQR (scanning) is the only
// camera-side library.

export function qrImageUrl(text) {
  return `/api/qr.png?t=${encodeURIComponent(text)}`;
}

// Render a QR into `el` (any element) as an <img>. Returns the created img.
export function renderQr(el, text, { size = 256, alt = 'QR code' } = {}) {
  const img = document.createElement('img');
  img.className = 'qr-img';
  img.alt = alt;
  img.width = size;
  img.height = size;
  img.src = qrImageUrl(text);
  el.replaceChildren(img);
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

// Session token persistence (localStorage) for reconnect.
const TOKEN_KEY = 'sechit.session.token';

export function loadToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
