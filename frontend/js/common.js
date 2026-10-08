// Shared helpers for the player app, big screen and admin page.
import { io } from './vendor/socket.io.esm.min.js';
import { API_URL } from './config.js';

const TOKEN_KEY = 'bni_games_token';
const MUTE_KEY = 'bni_games_muted';

const storage = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
  remove(k) {
    try { localStorage.removeItem(k); } catch { /* private mode */ }
  },
};

export const getToken = () => storage.get(TOKEN_KEY);
export const setToken = (t) => storage.set(TOKEN_KEY, t);
export const clearToken = () => storage.remove(TOKEN_KEY);

/** Full address of a backend path such as '/api/qr.svg'. */
export const apiUrl = (path) => API_URL.replace(/\/+$/, '') + path;

/** Live-update connection to the backend. */
export const connectSocket = (auth) => (API_URL ? io(API_URL, { auth }) : io({ auth }));

export async function api(path, { method = 'GET', body, adminKey, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (adminKey) headers['x-admin-key'] = adminKey;
  let res;
  try {
    res = await fetch(apiUrl(path), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const e = new Error('Connection problem — check your internet');
    e.network = true;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    e.code = data.code;
    throw e;
  }
  return data;
}

/** Retry only on network failures (server errors and 4xx are final). */
export async function withRetry(fn, signal, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.network || i >= tries - 1 || signal?.aborted) throw err;
      await sleep(700 * (i + 1), signal);
    }
  }
}

export const abortError = () => new DOMException('Quit', 'AbortError');

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

/** setTimeout bookkeeping so a game can cancel everything it scheduled in one call. */
export function timers() {
  const live = new Set();
  return {
    after(fn, ms) {
      const id = setTimeout(() => { live.delete(id); fn(); }, ms);
      live.add(id);
      return id;
    },
    cancel(id) {
      clearTimeout(id);
      live.delete(id);
    },
    clear() {
      live.forEach(clearTimeout);
      live.clear();
    },
  };
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

export function vibrate(ms) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

/** Animate a number in an element from → to. */
export function countUp(el, to, ms = 900, from = Number(el.dataset.value ?? 0)) {
  el.dataset.value = to;
  if (from === to) {
    el.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    if (el.dataset.value !== String(to)) return; // superseded by a newer count
    const p = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let toastTimer;
export function toast(msg, ms = 3200) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ sound

let audio = null;
let muted = storage.get(MUTE_KEY) === '1';

function tone(freq, { dur = 0.09, type = 'sine', vol = 0.12, to = null, delay = 0 } = {}) {
  if (muted || !audio) return;
  const t = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  /** Must be called from a tap/click (browsers block audio until then). */
  unlock() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch { /* no audio */ }
  },
  get muted() { return muted; },
  set muted(v) {
    muted = Boolean(v);
    storage.set(MUTE_KEY, muted ? '1' : '0');
  },
  tick: () => tone(660, { dur: 0.08, type: 'square', vol: 0.05 }),
  go: () => tone(990, { dur: 0.18, type: 'square', vol: 0.06 }),
  good: () => tone(880, { dur: 0.08, type: 'triangle', to: 1320 }),
  bonus: () => { tone(988, { dur: 0.08, type: 'triangle' }); tone(1480, { dur: 0.14, type: 'triangle', delay: 0.07 }); },
  bad: () => tone(220, { dur: 0.2, type: 'sawtooth', vol: 0.06, to: 110 }),
  flip: () => tone(520, { dur: 0.05, type: 'triangle', vol: 0.06 }),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, { dur: 0.22, type: 'triangle', delay: i * 0.11 })),
  drum: () => { for (let i = 0; i < 14; i++) tone(90 + Math.random() * 30, { dur: 0.07, type: 'triangle', vol: 0.15, delay: i * 0.07 }); },
  /** A plain note (Handshake Sequence pads). */
  note: (f, dur = 0.3) => tone(f, { dur, type: 'sine', vol: 0.12 }),
  /** Rising pitch with the streak count — the longer the streak, the higher it climbs. */
  combo: (n) => { const f = 440 * Math.pow(1.06, Math.min(n, 24)); tone(f, { dur: 0.1, type: 'triangle', vol: 0.1, to: f * 1.5 }); },
  /** Final-seconds warning. */
  alarm: () => { tone(880, { dur: 0.09, type: 'square', vol: 0.05 }); tone(880, { dur: 0.09, type: 'square', vol: 0.05, delay: 0.14 }); },
};

// ------------------------------------------------------------------ confetti

export function confetti({ duration = 3000, count = 160 } = {}) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const colors = ['#f7c548', '#e3263a', '#ffffff', '#22c55e', '#3b82f6', '#f472b6'];
  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.6,
    vx: (Math.random() - 0.5) * 3 * dpr,
    vy: (2 + Math.random() * 4) * dpr,
    size: (5 + Math.random() * 7) * dpr,
    angle: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const end = performance.now() + duration;
  function frame(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04 * dpr;
      p.angle += p.spin;
      if (now < end && p.y > canvas.height) {
        p.y = -20;
        p.vy = (2 + Math.random() * 3) * dpr;
      }
      if (p.y < canvas.height + 30) alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (alive) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}
