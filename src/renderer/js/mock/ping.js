// Simulator für den Ping-Tester (nur Browser-Vorschau): ein Spieler in Deutschland mit Glasfaser.

const REGIONS = [
  { id: 'EU', label: 'Europa', game: 'Europa', subs: [['de', 'Deutschland', true], ['gb', 'Großbritannien', true], ['fr', 'Frankreich', true]] },
  { id: 'NA', label: 'Nordamerika', game: 'Nordamerika (NA)', subs: [['va', 'Virginia', true], ['oh', 'Ohio', true], ['ia', 'Iowa', false], ['tx', 'Texas', false, 'central'], ['mx', 'Mexiko', true], ['ncal', 'Nordkalifornien', true, 'west'], ['or', 'Oregon', true, 'west']] },
  { id: 'ME', label: 'Naher Osten', game: 'Naher Osten', subs: [['bah', 'Bahrain', true], ['mum', 'Mumbai', true], ['il', 'Israel', true]] },
  { id: 'BR', label: 'Brasilien', game: 'Brasilien', subs: [['sao', 'São Paulo', true]] },
  { id: 'ASIA', label: 'Asien', game: 'Asien', subs: [['tok', 'Tokio', true]] },
  { id: 'OCE', label: 'Ozeanien', game: 'Ozeanien', subs: [['syd', 'Sydney', true]] },
].map((g) => ({
  id: g.id, label: g.label, game: g.game,
  subs: g.subs.map(([id, name, tcp, comp]) => ({ id, name, host: `ping-${id}.ds.on.epicgames.com`, tcp, tcpEstimate: id === 'bah', comp: comp || null })),
}));
const FLAT = REGIONS.flatMap((g) => g.subs.map((s) => ({ ...s, region: g.label, regionId: g.id })));

// typische Werte aus Süddeutschland (Median in ms)
const BASE = { de: 17, fr: 24, gb: 26, il: 63, bah: 118, mum: 128, va: 96, oh: 104, ia: 117, tx: 128, mx: 148, ncal: 158, or: 162, sao: 201, tok: 238, syd: 289 };

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function sample(id) {
  const base = BASE[id];
  if (rnd() < (id === 'mum' ? 0.12 : 0.015)) return null; // gelegentlich verloren
  return Math.round(base + rnd() * Math.max(2, base * 0.06) + (rnd() < 0.1 ? base * 0.15 : 0));
}

const r1 = (x) => Math.round(x * 10) / 10;
function stats(values) {
  const ok = values.filter((v) => typeof v === 'number');
  const sorted = [...ok].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  let jitter = null;
  if (ok.length > 1) { let s = 0; for (let i = 1; i < ok.length; i++) s += Math.abs(ok[i] - ok[i - 1]); jitter = r1(s / (ok.length - 1)); }
  return {
    sent: values.length, received: ok.length,
    minMs: ok.length ? sorted[0] : null,
    medianMs: ok.length ? r1(sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) : null,
    avgMs: ok.length ? r1(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
    maxMs: ok.length ? sorted[sorted.length - 1] : null,
    jitterMs: jitter,
    lossPct: values.length ? r1(((values.length - ok.length) / values.length) * 100) : null,
  };
}

function buildReport(valuesById, at, method = 'icmp') {
  const results = FLAT.map((t) => {
    const values = valuesById[t.id] || [];
    const s = stats(values);
    return { id: t.id, name: t.name, region: t.region, regionId: t.regionId, host: t.host, method, estimate: false, noFallback: false, unreachable: s.received === 0, samples: values, ...s };
  });
  const cand = results.filter((r) => r.medianMs != null && r.lossPct <= 20).sort((a, b) => a.medianMs - b.medianMs);
  const b = cand[0];
  return {
    at, method, requested: 'auto', samples: 8, cancelled: false, results,
    best: b ? { id: b.id, name: b.name, region: b.region, ms: b.medianMs } : null,
    proxy: { suspect: false, ids: [], pairs: [], message: null },
  };
}

function fakeRun(n) {
  const v = {};
  for (const t of FLAT) v[t.id] = Array.from({ length: n }, () => sample(t.id));
  return v;
}

function entry(rep) {
  return {
    at: rep.at, method: rep.method, best: rep.best,
    results: rep.results.map((r) => ({ id: r.id, name: r.name, region: r.region, host: r.host, minMs: r.minMs, medianMs: r.medianMs, jitterMs: r.jitterMs, lossPct: r.lossPct })),
  };
}

const H = 3600 * 1000;
const now = Date.now();
const state = { settings: { method: 'auto', samples: 8 }, history: [], last: null };
[[-50, 4], [-26, 2], [-5, -1]].forEach(([h, delta], i) => {
  const vals = fakeRun(8);
  vals.de = vals.de.map((x) => (x == null ? x : x + delta));
  if (i === 1) vals.de = vals.de.map((x) => (x == null ? x : x + 9)); // abends langsamer
  const rep = buildReport(vals, now + h * H);
  state.history.push(entry(rep));
  state.last = rep;
});

let running = null;

export default {
  async summary() {
    const l = state.history[state.history.length - 1];
    return { text: l?.best ? `Bester Server: ${l.best.name}, ${Math.round(l.best.ms)} ms` : 'Noch nicht gemessen – findet deinen schnellsten Server' };
  },
  async info() {
    return { platform: { icmp: true, tcp: true }, regions: REGIONS, settings: state.settings, last: state.last, history: state.history.slice(-10), running: !!running };
  },
  async measure(args, mctx) {
    if (running) { const e = new Error('Es läuft schon eine Messung. Bitte kurz warten.'); e.code = 'BUSY'; throw e; }
    const n = Math.min(20, Math.max(3, Number(args.samples) || 8));
    const method = args.method === 'tcp' ? 'tcp' : 'icmp';
    running = { cancelled: false };
    const targets = method === 'tcp' ? FLAT.filter((t) => t.tcp) : FLAT;
    const vals = {};
    for (const t of targets) vals[t.id] = [];
    const total = targets.length * n;
    let done = 0;
    try {
      for (let r = 0; r < n && !running.cancelled; r++) {
        for (let b = 0; b < targets.length && !running.cancelled; b += 8) {
          await mctx.wait(160);
          for (const t of targets.slice(b, b + 8)) {
            const ms = sample(t.id);
            vals[t.id].push(ms);
            done++;
            mctx.emit('ping.progress', { phase: method, done, total, id: t.id, name: t.name, ms, skipped: false });
          }
        }
      }
      const rep = buildReport(vals, Date.now(), method);
      rep.samples = n;
      rep.requested = args.method || 'auto';
      if (method === 'tcp') {
        for (const r of rep.results) {
          const t = FLAT.find((x) => x.id === r.id);
          if (!t.tcp) Object.assign(r, { method: null, noFallback: true });
          if (t.tcpEstimate) r.estimate = true;
          if (t.tcp) r.host = r.host.replace(/^ping-(\w+)\.ds\.on\.epicgames\.com$/, 'dynamodb.region.amazonaws.com');
        }
      }
      rep.cancelled = running.cancelled;
      if (!rep.cancelled) {
        state.history.push(entry(rep));
        state.history = state.history.slice(-10);
        state.last = rep;
        state.settings = { method: args.method || 'auto', samples: n };
      }
      mctx.emit('ping.done', rep);
      return rep;
    } finally {
      running = null;
    }
  },
  async cancel() {
    if (!running) return { cancelled: false };
    running.cancelled = true;
    return { cancelled: true };
  },
  async clearHistory() {
    state.history = [];
    state.last = null;
    return { cleared: true };
  },
};
