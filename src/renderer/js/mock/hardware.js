// Simulator für den Hardware-Überblick (nur Browser-Vorschau).
// ?hw=amd zeigt eine AMD-Karte ohne Temperatur, ?hw=linux die Grundwerte ohne Windows.

const GB = 1024 ** 3;
const H = 3600 * 1000;
const mode = new URLSearchParams(location.search).get('hw') || 'nvidia';

const st = {
  timer: null,
  history: [],
  settings: { background: false },
  t: 0,
  sessions: [
    mkSession(26 * H, 34 * 60, { cpu: [41, 63], gpu: [91, 99], gpuTemp: [67, 74], board: 49, fnRam: 4.6 }),
    mkSession(5 * H, 52 * 60, { cpu: [44, 71], gpu: [93, 99], gpuTemp: [69, 77], board: 51, fnRam: 4.9 }),
    mkSession(1.5 * H, 21 * 60, { cpu: [39, 58], gpu: [88, 98], gpuTemp: [66, 72], board: 48, fnRam: 4.3 }),
  ],
};

function mkSession(ago, sec, v) {
  const startedAt = Date.now() - ago;
  return {
    startedAt, endedAt: startedAt + sec * 1000, durationSec: sec, samples: Math.round(sec / 2),
    cpu: { avg: v.cpu[0], max: v.cpu[1] }, gpu: { avg: v.gpu[0], max: v.gpu[1] },
    gpuTemp: mode === 'nvidia' ? { avg: v.gpuTemp[0], max: v.gpuTemp[1] } : null,
    boardTemp: { avg: v.board - 3, max: v.board }, ram: { avg: 68, max: 74 }, vram: { avg: 72, max: 81 },
    fnCpu: { avg: 21, max: 34 }, fnRamMax: Math.round(v.fnRam * GB),
  };
}

const caps = () => ({
  windows: mode !== 'linux',
  nvidiaSmi: mode === 'nvidia',
  vendor: mode === 'amd' ? 'amd' : mode === 'nvidia' ? 'nvidia' : null,
  gpuNames: mode === 'amd' ? ['AMD Radeon RX 7700 XT'] : mode === 'nvidia' ? ['NVIDIA GeForce RTX 4060 Ti'] : [],
  gpuLoad: mode !== 'linux',
  gpuMemory: mode !== 'linux',
  thermal: mode !== 'linux',
});

const noise = (a) => (Math.random() - 0.5) * 2 * a;
const r1 = (v) => Math.round(v * 10) / 10;

function sample(at, playing) {
  st.t += 1;
  const wave = Math.sin(st.t / 7);
  const base = {
    at, psFresh: mode !== 'linux', stream: mode === 'linux' ? 'unsupported' : 'ok',
    cpuPct: r1(Math.max(1, playing ? 46 + wave * 8 + noise(6) : 9 + noise(4))), cpuSource: mode === 'linux' ? 'node' : 'windows',
    ramTotal: 16 * GB, ramUsed: (playing ? 11.6 : 7.8) * GB + noise(0.15) * GB,
    gpuPct: null, gpuSource: null, gpuTemp: null, vramUsed: null, vramTotal: null, gpuPower: null, gpuClock: null,
    boardTemp: null, zones: [], fnRunning: mode === 'linux' ? null : playing, fnRam: null, fnCpuPct: null,
  };
  if (mode === 'linux') return base;
  base.gpuPct = r1(Math.min(100, Math.max(0, playing ? 93 + noise(5) : 4 + noise(3))));
  base.gpuSource = mode === 'nvidia' ? 'nvidia' : 'windows';
  base.vramTotal = (mode === 'amd' ? 12 : 8) * GB;
  base.vramUsed = (playing ? 6.1 : 1.1) * GB + noise(0.05) * GB;
  base.boardTemp = r1((playing ? 50 : 42) + wave * 1.5);
  base.zones = [{ name: '_TZ.TZ00', tempC: base.boardTemp }];
  if (mode === 'nvidia') {
    base.gpuTemp = Math.round((playing ? 68 : 41) + wave * 2 + noise(0.6));
    base.gpuPower = playing ? r1(158 + noise(8)) : r1(18 + noise(2));
    base.gpuClock = playing ? Math.round(2610 + noise(30)) : 210;
  }
  if (playing) {
    base.fnRam = 4.4 * GB + noise(0.08) * GB;
    base.fnCpuPct = r1(22 + wave * 4 + noise(2));
  }
  return base;
}

function fill(mctx) {
  const playing = !!mctx.db.fortnite.running;
  const now = Date.now();
  st.history = [];
  for (let i = 59; i >= 0; i--) st.history.push(sample(now - i * 2000, playing));
}

function status(mctx) {
  return {
    unsupported: mode === 'linux', windows: mode !== 'linux', running: !!st.timer,
    stream: mode === 'linux' ? 'unsupported' : 'ok', intervalMs: 2000, caps: caps(),
    settings: st.settings, recording: !!(st.settings.background && mctx.db.fortnite.running), history: st.history.slice(),
  };
}

export default {
  async status(_a, mctx) { return status(mctx); },
  async start(_a, mctx) {
    await mctx.wait(200);
    if (!st.history.length) fill(mctx);
    if (!st.timer) {
      st.timer = setInterval(() => {
        const s = sample(Date.now(), !!mctx.db.fortnite.running);
        st.history.push(s);
        while (st.history.length > 60) st.history.shift();
        mctx.emit('hardware.sample', { ...s, caps: caps() });
      }, 2000);
    }
    return status(mctx);
  },
  async ping() { return { running: !!st.timer, stream: 'ok' }; },
  async stop() {
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    return { running: false };
  },
  async setBackground(a, mctx) {
    await mctx.wait(150);
    st.settings = { background: !!a.on };
    return { settings: st.settings, recording: !!(a.on && mctx.db.fortnite.running) };
  },
  async sessions() {
    return { sessions: st.sessions.slice().reverse(), recording: false, settings: st.settings };
  },
  async clearSessions() {
    const n = st.sessions.length;
    st.sessions = [];
    return { cleared: n };
  },
  async summary() {
    return mode === 'nvidia' ? { text: 'Grafikkarte zuletzt 68 °C' } : null;
  },
};
