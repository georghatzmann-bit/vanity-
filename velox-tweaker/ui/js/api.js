// VELOX API client (docs/ARCHITECTURE.md section 7).
// - token: read once from ?t=, kept in sessionStorage, removed from the address bar
// - every call sends X-Velox-Token
// - heartbeat every 5 s, shutdown beacon on pagehide
// - after repeated network failures the app is told the backend is gone

const TOKEN_KEY = 'velox.token';
let token = '';
let failures = 0;
const listeners = { lost: new Set(), unauthorized: new Set(), ok: new Set() };
let lostFired = false;

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

export function on(event, fn) { listeners[event].add(fn); return () => listeners[event].delete(fn); }

function networkFailed() {
  failures++;
  if (failures >= 2 && !lostFired) {
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
  } catch (e) {
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
  heartbeat: () => request('POST', '/api/heartbeat', undefined, { timeout: 4000 }),
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
export function startHeartbeat(onBusy) {
  if (hbTimer) return;
  const beat = async () => {
    try {
      const r = await api.heartbeat();
      if (onBusy) onBusy(r && r.busy);
    } catch { /* counted in request() */ }
  };
  hbTimer = setInterval(beat, 5000);
  window.addEventListener('pagehide', () => {
    try { navigator.sendBeacon('/api/shutdown?t=' + encodeURIComponent(token)); } catch { /* ignore */ }
  });
  // Coming back from bfcache: tell the backend we are still here.
  window.addEventListener('pageshow', (e) => { if (e.persisted) beat(); });
}
