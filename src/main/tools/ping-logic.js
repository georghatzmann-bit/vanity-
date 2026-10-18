'use strict';
// Ping-Tester: reine Logik ohne Netzwerk (Server-Liste, Statistik, Proxy-Erkennung, Bestwahl,
// Ablauf einer Messung mit austauschbaren Mess-Funktionen). Wird vom Modul und von den Tests benutzt.
//
// Server: die Ping-Adressen, die Epic seit v42.20 je Unterregion veröffentlicht (*.ds.on.epicgames.com).
// Ausweich-Ziele für TCP (Port 443): regionale AWS-Endpunkte im selben Rechenzentrum (dynamodb.<region>.amazonaws.com).
// Iowa (Google Cloud) und Texas (AWS Local Zone) haben kein passendes TCP-Ziel – dort nur Ping (ICMP).
// Competitive (comp): NA-Central ist nur Texas (ping-nac = ping-tx), NA-West ist Nordkalifornien + Oregon.
// Bahrain läuft inzwischen bei Google in Doha; AWS Bahrain ist nur eine Schätzung.
// Fortnites eigener UDP-Test (Port 22222) wird bewusst NICHT nachgeahmt.

const REGIONS = [
  {
    id: 'EU', label: 'Europa', game: 'Europa',
    subs: [
      { id: 'de', name: 'Deutschland', host: 'ping-de.ds.on.epicgames.com', tcp: 'dynamodb.eu-central-1.amazonaws.com', lat: 50.11, lon: 8.68 },
      { id: 'gb', name: 'Großbritannien', host: 'ping-gb.ds.on.epicgames.com', tcp: 'dynamodb.eu-west-2.amazonaws.com', lat: 51.51, lon: -0.13 },
      { id: 'fr', name: 'Frankreich', host: 'ping-fr.ds.on.epicgames.com', tcp: 'dynamodb.eu-west-3.amazonaws.com', lat: 48.86, lon: 2.35 },
    ],
  },
  {
    id: 'NA', label: 'Nordamerika', game: 'Nordamerika (NA)',
    subs: [
      { id: 'va', name: 'Virginia', host: 'ping-va.ds.on.epicgames.com', tcp: 'dynamodb.us-east-1.amazonaws.com', lat: 39.04, lon: -77.49 },
      { id: 'oh', name: 'Ohio', host: 'ping-oh.ds.on.epicgames.com', tcp: 'dynamodb.us-east-2.amazonaws.com', lat: 39.96, lon: -83.0 },
      { id: 'ia', name: 'Iowa', host: 'ping-ia.ds.on.epicgames.com', tcp: null, lat: 41.26, lon: -95.86 },
      { id: 'tx', name: 'Texas', host: 'ping-tx.ds.on.epicgames.com', tcp: null, lat: 32.78, lon: -96.8, comp: 'central' },
      { id: 'mx', name: 'Mexiko', host: 'ping-mx.ds.on.epicgames.com', tcp: 'dynamodb.mx-central-1.amazonaws.com', lat: 20.59, lon: -100.39 },
      { id: 'ncal', name: 'Nordkalifornien', host: 'ping-ncal.ds.on.epicgames.com', tcp: 'dynamodb.us-west-1.amazonaws.com', lat: 37.34, lon: -121.89, comp: 'west' },
      { id: 'or', name: 'Oregon', host: 'ping-or.ds.on.epicgames.com', tcp: 'dynamodb.us-west-2.amazonaws.com', lat: 45.84, lon: -119.7, comp: 'west' },
    ],
  },
  {
    id: 'ME', label: 'Naher Osten', game: 'Naher Osten',
    subs: [
      { id: 'bah', name: 'Bahrain', host: 'ping-bah.ds.on.epicgames.com', tcp: 'dynamodb.me-south-1.amazonaws.com', tcpEstimate: true, lat: 25.29, lon: 51.53 },
      { id: 'mum', name: 'Mumbai', host: 'ping-mum.ds.on.epicgames.com', tcp: 'dynamodb.ap-south-1.amazonaws.com', lat: 19.08, lon: 72.88 },
      { id: 'il', name: 'Israel', host: 'ping-il.ds.on.epicgames.com', tcp: 'dynamodb.il-central-1.amazonaws.com', lat: 32.09, lon: 34.78 },
    ],
  },
  { id: 'BR', label: 'Brasilien', game: 'Brasilien', subs: [{ id: 'sao', name: 'São Paulo', host: 'ping-sao.ds.on.epicgames.com', tcp: 'dynamodb.sa-east-1.amazonaws.com', lat: -23.55, lon: -46.63 }] },
  { id: 'ASIA', label: 'Asien', game: 'Asien', subs: [{ id: 'tok', name: 'Tokio', host: 'ping-tok.ds.on.epicgames.com', tcp: 'dynamodb.ap-northeast-1.amazonaws.com', lat: 35.68, lon: 139.69 }] },
  { id: 'OCE', label: 'Ozeanien', game: 'Ozeanien', subs: [{ id: 'syd', name: 'Sydney', host: 'ping-syd.ds.on.epicgames.com', tcp: 'dynamodb.ap-southeast-2.amazonaws.com', lat: -33.87, lon: 151.21 }] },
];

/** Alle Messziele als flache Liste. */
const TARGETS = REGIONS.flatMap((r) => r.subs.map((s) => ({
  ...s, tcp: s.tcp || null, tcpEstimate: !!s.tcpEstimate, region: r.label, regionId: r.id, game: r.game,
})));
const TARGET_BY_ID = new Map(TARGETS.map((t) => [t.id, t]));

// Nur diese Ziele dürfen je angesprochen werden (auch als Schutz gegen veränderte Daten).
const HOST_RE = /^ping-[a-z]+\.ds\.on\.epicgames\.com$/;
const TCP_RE = /^dynamodb\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com$/;

const LIMITS = { samples: [3, 20], defaultSamples: 8, icmpTimeoutMs: 1000, tcpTimeoutMs: 1500, icmpBatch: 8, tcpParallel: 6 };
const METHODS = ['auto', 'icmp', 'tcp'];
const HISTORY_MAX = 10;
const PROXY_TEXT = 'Proxy/VPN erkannt, Werte nicht aussagekräftig';

const round1 = (x) => Math.round(x * 10) / 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function clampSamples(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return LIMITS.defaultSamples;
  return Math.min(LIMITS.samples[1], Math.max(LIMITS.samples[0], v));
}

function normMethod(m) {
  return METHODS.includes(m) ? m : 'auto';
}

/** Liste für die Oberfläche (ohne Koordinaten). */
function catalog() {
  return REGIONS.map((r) => ({
    id: r.id, label: r.label, game: r.game,
    subs: r.subs.map((s) => ({ id: s.id, name: s.name, host: s.host, tcp: !!s.tcp, tcpEstimate: !!s.tcpEstimate, comp: s.comp || null })),
  }));
}

/**
 * Statistik aus den Einzelwerten in Messreihenfolge. null = keine Antwort.
 * Schwankung (Jitter) = mittlerer Abstand aufeinanderfolgender Antworten.
 */
function computeStats(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const sent = list.length;
  const ok = list.filter(isNum);
  const received = ok.length;
  if (!sent) return { sent: 0, received: 0, minMs: null, medianMs: null, avgMs: null, maxMs: null, jitterMs: null, lossPct: null };
  const lossPct = round1(((sent - received) / sent) * 100);
  if (!received) return { sent, received, minMs: null, medianMs: null, avgMs: null, maxMs: null, jitterMs: null, lossPct };
  const sorted = [...ok].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let jitter = null;
  if (ok.length >= 2) {
    let s = 0;
    for (let i = 1; i < ok.length; i++) s += Math.abs(ok[i] - ok[i - 1]);
    jitter = round1(s / (ok.length - 1));
  }
  return {
    sent,
    received,
    minMs: round1(sorted[0]),
    medianMs: round1(median),
    avgMs: round1(ok.reduce((a, b) => a + b, 0) / ok.length),
    maxMs: round1(sorted[sorted.length - 1]),
    jitterMs: jitter,
    lossPct,
  };
}

/** Entfernung zweier Punkte auf der Erde (Großkreis) in km. */
function distanceKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Kürzeste physikalisch mögliche Antwortzeit zwischen zwei Rechenzentren (Licht in Glasfaser ≈ 200 km/ms). */
function minRttBetweenMs(a, b) {
  return (2 * distanceKm(a, b)) / 200;
}

/**
 * Erkennt unmögliche Werte: Wer zu zwei weit entfernten Rechenzentren zusammen weniger Zeit braucht,
 * als das Licht zwischen ihnen braucht, misst nicht den echten Weg – meist steckt ein Proxy oder VPN dazwischen.
 * (Beispiel: 1 ms nach Deutschland UND 1 ms nach Virginia.) Werte unter 2 ms zu fernen Regionen fallen so immer auf.
 */
function detectProxy(results, { factor = 0.8 } = {}) {
  const valid = (results || [])
    .filter((r) => r && isNum(r.minMs) && TARGET_BY_ID.has(r.id))
    .map((r) => ({ id: r.id, ms: r.minMs, t: TARGET_BY_ID.get(r.id) }));
  const ids = new Set();
  const pairs = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];
      const need = minRttBetweenMs(a.t, b.t) * factor;
      if (need >= 2 && a.ms + b.ms < need) {
        pairs.push([a.id, b.id]);
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return { suspect: pairs.length > 0, ids: [...ids], pairs: pairs.slice(0, 20), message: pairs.length ? PROXY_TEXT : null };
}

/** Bester Server: kleinster Median; Server mit mehr als 20 % Verlust nur, wenn es nichts Besseres gibt. */
function pickBest(results) {
  const cand = (results || []).filter((r) => r && isNum(r.medianMs));
  if (!cand.length) return null;
  const good = cand.filter((r) => (r.lossPct ?? 0) <= 20);
  const pool = good.length ? good : cand;
  return [...pool].sort((a, b) => a.medianMs - b.medianMs
    || (a.lossPct ?? 0) - (b.lossPct ?? 0)
    || (a.jitterMs ?? 0) - (b.jitterMs ?? 0)
    || (a.estimate ? 1 : 0) - (b.estimate ? 1 : 0))[0];
}

/** Führt Aufgaben mit höchstens n gleichzeitig aus. */
async function runPool(items, n, worker) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * TCP-Messung eines Ziels: erst den Namen auflösen (zählt nicht mit), dann nur den Verbindungsaufbau stoppen.
 * deps.lookup(host,{family:4}) -> {address}; deps.connect(address, port, timeoutMs) -> ms | null
 * Nach 3 Fehlversuchen ohne jede Antwort wird abgebrochen (spart Zeit).
 */
async function tcpTarget(target, { samples, timeoutMs = LIMITS.tcpTimeoutMs, gapMs = 60 }, deps, onSample, signal = {}) {
  const host = target.tcp;
  const values = [];
  if (!host || !TCP_RE.test(host)) return { host: null, values, error: 'NO_TCP' };
  let address;
  try {
    ({ address } = await deps.lookup(host, { family: 4 }));
  } catch {
    onSample(target.id, null, { skipped: samples });
    return { host, values: new Array(samples).fill(null), error: 'DNS' };
  }
  for (let i = 0; i < samples; i++) {
    if (signal.cancelled) break;
    if (i === 3 && !values.some(isNum)) {
      const rest = samples - i;
      for (let k = 0; k < rest; k++) values.push(null);
      onSample(target.id, null, { skipped: rest });
      break;
    }
    let ms = null;
    try { ms = await deps.connect(address, 443, timeoutMs); } catch { ms = null; }
    ms = isNum(ms) ? ms : null;
    values.push(ms);
    onSample(target.id, ms, {});
    if (gapMs && i < samples - 1) await sleep(gapMs);
  }
  return { host, values };
}

async function runTcp(targets, opts, deps, onSample, signal) {
  const res = await runPool(targets, opts.parallel || LIMITS.tcpParallel, (t) => tcpTarget(t, opts, deps, onSample, signal));
  const map = {};
  targets.forEach((t, i) => { map[t.id] = res[i]; });
  return map;
}

function baseResult(t) {
  return {
    id: t.id, name: t.name, region: t.region, regionId: t.regionId, host: t.host,
    method: null, estimate: false, noFallback: false, unreachable: true, samples: [],
    ...computeStats([]),
  };
}

function withStats(r, samples) {
  const s = computeStats(samples);
  return { ...r, ...s, samples: samples.map((v) => (isNum(v) ? round1(v) : null)), unreachable: s.received === 0 };
}

/**
 * Ablauf einer Messung.
 * o.method: 'auto' | 'icmp' | 'tcp'; o.canIcmp: Windows ja/nein
 * o.icmp(targets, {samples, timeoutMs, batch}, onSample, signal) -> { [id]: (ms|null)[] }
 * o.tcpDeps: { lookup, connect } für die TCP-Messung
 * o.onProgress({ phase, done, total, id, name, ms })
 */
async function measureAll(o) {
  const method = normMethod(o.method);
  const samples = clampSamples(o.samples);
  const signal = o.signal || {};
  const targets = (o.targets || TARGETS).filter((t) => HOST_RE.test(t.host));
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const results = new Map(targets.map((t) => [t.id, baseResult(t)]));
  const useIcmp = method === 'icmp' || (method === 'auto' && o.canIcmp);
  let usedIcmp = false;
  let usedTcp = false;

  const tracker = (phase, total) => {
    let done = 0;
    return (id, ms, extra = {}) => {
      done = Math.min(total, done + (extra.skipped || 1));
      const t = TARGET_BY_ID.get(id);
      onProgress({ phase, done, total, id, name: t ? t.name : id, ms: isNum(ms) ? round1(ms) : null, skipped: !!extra.skipped });
    };
  };

  if (useIcmp) {
    if (!o.canIcmp) {
      const e = new Error('Ping (ICMP) misst HELIX nur unter Windows. Wähle „Automatisch“ oder „TCP-Verbindung“.');
      e.code = 'NOT_WINDOWS';
      throw e;
    }
    let map = {};
    try {
      map = await o.icmp(targets, { samples, timeoutMs: LIMITS.icmpTimeoutMs, batch: LIMITS.icmpBatch }, tracker('icmp', targets.length * samples), signal);
      usedIcmp = true;
    } catch (e) {
      // "Automatisch": klappt der Ping gar nicht (z. B. PowerShell gesperrt), misst TCP alles
      if (method === 'icmp') throw e;
      map = {};
    }
    for (const t of targets) {
      const vals = Array.isArray(map?.[t.id]) ? map[t.id] : [];
      const r = withStats({ ...results.get(t.id), method: usedIcmp ? 'icmp' : null, host: t.host }, vals);
      results.set(t.id, r);
    }
  }

  if (!signal.cancelled && method !== 'icmp') {
    // TCP: bei "tcp" für alle, bei "auto" nur für Ziele ohne jede Ping-Antwort
    const need = targets.filter((t) => (useIcmp ? results.get(t.id).received === 0 : true));
    const withTcp = need.filter((t) => t.tcp);
    // "nur mit Ping messbar" nur, wenn gar kein Ping gesendet wurde. Kam der Ping nicht zurück,
    // bleibt es bei "keine Antwort" (method 'icmp', 100 % Verlust).
    if (!usedIcmp) {
      for (const t of need.filter((x) => !x.tcp)) {
        const r = results.get(t.id);
        results.set(t.id, { ...r, noFallback: true, method: r.method || null });
      }
    }
    if (withTcp.length) {
      const map = await runTcp(withTcp, { samples, timeoutMs: LIMITS.tcpTimeoutMs, gapMs: o.gapMs ?? 60 }, o.tcpDeps, tracker('tcp', withTcp.length * samples), signal);
      usedTcp = true;
      for (const t of withTcp) {
        const m = map[t.id] || { values: [] };
        const r = withStats({ ...results.get(t.id), method: 'tcp', host: m.host || t.tcp, estimate: !!t.tcpEstimate, noFallback: false }, m.values || []);
        results.set(t.id, r);
      }
    }
  }

  const list = targets.map((t) => results.get(t.id));
  const proxy = detectProxy(list);
  const best = pickBest(list);
  return {
    at: Date.now(),
    method: usedIcmp && usedTcp ? 'mixed' : usedTcp ? 'tcp' : 'icmp',
    requested: method,
    samples,
    cancelled: !!signal.cancelled,
    results: list,
    best: best ? { id: best.id, name: best.name, region: best.region, ms: best.medianMs } : null,
    proxy,
  };
}

/** Eintrag für den Verlauf (Form ist mit anderen Tools abgestimmt – nicht ändern). */
function historyEntry(rep) {
  return {
    at: rep.at,
    method: rep.method,
    best: rep.best ? { id: rep.best.id, name: rep.best.name, region: rep.best.region, ms: rep.best.ms } : null,
    results: rep.results.map((r) => ({
      id: r.id, name: r.name, region: r.region, host: r.host,
      minMs: r.minMs, medianMs: r.medianMs, jitterMs: r.jitterMs, lossPct: r.lossPct,
    })),
  };
}

function appendHistory(state, rep, max = HISTORY_MAX) {
  const st = state && typeof state === 'object' ? state : {};
  const history = Array.isArray(st.history) ? st.history.slice() : [];
  history.push(historyEntry(rep));
  return { ...st, history: history.slice(-max) };
}

function fmtMsText(ms) {
  if (!isNum(ms)) return '–';
  return ms < 10 ? `${String(round1(ms)).replace('.', ',')} ms` : `${Math.round(ms)} ms`;
}

/** Kurzzeile fürs Cockpit. */
function summaryText(state) {
  const h = Array.isArray(state?.history) ? state.history : [];
  const last = h[h.length - 1];
  if (!last) return 'Noch nicht gemessen – findet deinen schnellsten Server';
  if (!last.best) return 'Letzte Messung: kein Server erreichbar';
  const unsure = state?.lastProxyAt && state.lastProxyAt === last.at;
  return `Bester Server: ${last.best.name}, ${fmtMsText(last.best.ms)}${unsure ? ' (unsicher: Proxy/VPN)' : ''}`;
}

/** Werte aus einer JSON-Zeile des PowerShell-Pings. */
function parseIcmpLine(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'done') return { type: 'done' };
  if (obj.type === 'skip' && typeof obj.id === 'string') return { type: 'skip', id: obj.id, count: Math.max(0, Math.round(Number(obj.count) || 0)) };
  if (obj.type === 'sample' && typeof obj.id === 'string') {
    const ms = obj.ms === null || obj.ms === undefined ? null : Number(obj.ms);
    return { type: 'sample', id: obj.id, ms: isNum(ms) ? ms : null, status: String(obj.status || '') };
  }
  return null;
}

module.exports = {
  REGIONS, TARGETS, TARGET_BY_ID, HOST_RE, TCP_RE, LIMITS, METHODS, HISTORY_MAX, PROXY_TEXT,
  clampSamples, normMethod, catalog, computeStats, distanceKm, minRttBetweenMs, detectProxy, pickBest,
  runPool, tcpTarget, runTcp, measureAll, historyEntry, appendHistory, summaryText, parseIcmpLine, fmtMsText,
};
