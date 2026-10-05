// VELOX API client (docs/ARCHITECTURE.md section 7).
// - token: read once from ?t=, kept in sessionStorage, removed from the address bar
// - every call sends X-Velox-Token
// - heartbeat every 3 s, shutdown beacon on pagehide - but only from the LAST open VELOX window:
//   windows see each other over a BroadcastChannel, so closing a second window (Ctrl-click on a
//   sidebar link opens one) never ends the backend under the first one
// - every window has a random session id, sent with heartbeat and beacon (?s=) for the backend
// - after repeated network failures the app is told the backend is gone

const TOKEN_KEY = 'velox.token';
let token = '';
let failures = 0;
const listeners = { lost: new Set(), unauthorized: new Set(), ok: new Set() };
let lostFired = false;
const SESSION = (() => {
  try { const a = new Uint8Array(8); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); }
  catch { return String(Math.random()).slice(2, 18); }
})();
export function sessionId() { return SESSION; }

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function initToken() {
  const params = new URLSearchParams(location.search);
  let t = params.get('t');
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else t = sessionStorage.getItem(TOKEN_KEY);
  } catch { /* storage blocked: keep it in memory only */ }
  if (params.has('t')) {
    params.delete('t');
    const q = params.toString();
    history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  token = t || '';
  return token;
}

export function hasToken() { return !!token; }

/** After "lost": keep probing quietly; resolves when the backend answers again. */
export function waitForBackend(interval = 4000) {
  return new Promise((resolve) => {
    const probe = async () => {
      try { await request('POST', '/api/heartbeat', undefined, { timeout: 3000, quietNetwork: true }); resolve(); }
      catch { setTimeout(probe, interval); }
    };
    setTimeout(probe, interval);
  });
}

export function on(event, fn) { listeners[event].add(fn); return () => listeners[event].delete(fn); }

function networkFailed() {
  failures++;
  // three consecutive failures (heartbeat retries quickly after a miss) = the backend is gone
  if (failures >= 3 && !lostFired) {
    lostFired = true;
    for (const fn of listeners.lost) fn();
  }
}
function networkOk() {
  if (failures) failures = 0;
}

/** Low-level JSON request. Throws ApiError (status 0 = no connection). */
export async function request(method, path, body, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  const headers = { 'X-Velox-Token': token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method, headers, cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    clearTimeout(timer);
    if (!opts.quietNetwork) networkFailed();
    throw new ApiError('Keine Verbindung zu VELOX.', 0, null);
  }
  clearTimeout(timer);
  networkOk();
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401) for (const fn of listeners.unauthorized) fn();
    const msg = data && typeof data.error === 'string' && data.error !== 'busy' ? data.error : res.status === 409 ? 'VELOX ist gerade beschäftigt.' : 'Anfrage fehlgeschlagen (' + res.status + ').';
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),
  state: () => request('GET', '/api/state'),
  settings: (partial) => request('POST', '/api/settings', partial),
  setClaudeKey: (key) => request('POST', '/api/claude/key', { key }),
  deleteClaudeKey: () => request('DELETE', '/api/claude/key'),
  backups: () => request('GET', '/api/backups'),
  backup: (id) => request('GET', '/api/backups/' + encodeURIComponent(id)),
  open: (target) => request('POST', '/api/open', { target }),
  heartbeat: () => request('POST', '/api/heartbeat?s=' + SESSION, undefined, { timeout: 4000 }),
  startJob: (type, params) => request('POST', '/api/jobs', { type, params: params || {} }),
  job: (id, since) => request('GET', '/api/jobs/' + encodeURIComponent(id) + '?since=' + (since || 0)),
  cancelJob: (id) => request('POST', '/api/jobs/' + encodeURIComponent(id) + '/cancel')
};

/**
 * Polls a job until it is finished. onUpdate(job) receives the job with the FULL log so far
 * (the API only sends lines since n; we merge by line index i).
 */
export function pollJob(jobId, onUpdate, interval = 250) {
  let since = 0;
  const lines = new Map();
  let stopped = false;
  const promise = new Promise((resolve, reject) => {
    const tick = async () => {
      if (stopped) return;
      let job;
      try {
        job = await api.job(jobId, since);
      } catch (e) {
        if (e.status === 0 && !lostFired) { setTimeout(tick, interval * 2); return; }
        reject(e);
        return;
      }
      for (const l of job.log || []) {
        const i = typeof l.i === 'number' ? l.i : lines.size;
        lines.set(i, l);
        if (i + 1 > since) since = i + 1;
      }
      const full = Object.assign({}, job, { log: Array.from(lines.values()).sort((a, b) => a.i - b.i) });
      try { onUpdate && onUpdate(full); } catch (e) { console.warn(e); }
      if (job.status === 'running') setTimeout(tick, interval);
      else resolve(full);
    };
    tick();
  });
  promise.stop = () => { stopped = true; };
  return promise;
}

let hbTimer = null;
const HB_MS = 3000;
export function startHeartbeat(onBusy) {
  if (hbTimer) return;
  let beatNow = null;
  const beat = async () => {
    clearTimeout(hbTimer);
    hbTimer = null;
    let ok = false;
    try {
      const r = await api.heartbeat();
      ok = true;
      if (onBusy) onBusy(r && r.busy);
    } catch { /* counted in request() */ }
    // regular beat; after a miss retry soon so a dead backend is noticed within a few seconds
    if (!lostFired && !hbTimer) hbTimer = setTimeout(beat, ok ? HB_MS : 1500);
  };
  beatNow = beat;
  hbTimer = setTimeout(beat, HB_MS);

  // Other VELOX windows of this backend: hello every beat, bye on close.
  const peers = new Map(); // session -> last seen (ms)
  let chan = null;
  try {
    chan = new BroadcastChannel('velox:' + location.port);
    chan.onmessage = (e) => {
      const m = e.data || {};
      if (!m.s || m.s === SESSION) return;
      if (m.t === 'bye') { peers.delete(m.s); beatNow(); return; } // a window closes: prove we are still here
      peers.set(m.s, Date.now());
      if (m.t === 'hello?') chan.postMessage({ t: 'hello', s: SESSION });
    };
    chan.postMessage({ t: 'hello?', s: SESSION });
    setInterval(() => { try { chan.postMessage({ t: 'hello', s: SESSION }); } catch { /* closed */ } }, HB_MS);
  } catch { chan = null; }
  const othersAlive = () => { const now = Date.now(); for (const t of peers.values()) if (now - t < HB_MS * 2 + 1000) return true; return false; };

  window.addEventListener('pagehide', (e) => {
    try { if (chan) chan.postMessage({ t: 'bye', s: SESSION }); } catch { /* ignore */ }
    // Going into the back/forward cache is not a close. Another open window keeps VELOX alive.
    if (e.persisted || othersAlive()) return;
    try { navigator.sendBeacon('/api/shutdown?t=' + encodeURIComponent(token) + '&s=' + SESSION); } catch { /* ignore */ }
  });
  // Coming back from bfcache: one heartbeat loop only, and say hello again.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    clearTimeout(hbTimer); hbTimer = null;
    try { if (chan) chan.postMessage({ t: 'hello?', s: SESSION }); } catch { /* ignore */ }
    beat();
  });
}
