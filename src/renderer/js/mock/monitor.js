// Simulator für den Monitor-Tuner (nur Browser-Vorschau).

const H = 3600 * 1000;
const state = {
  wizard: { step: 0, checks: { mode: true, dcr: true }, vendor: null, completedAt: null },
  stormTests: [{ at: Date.now() - 50 * H, seen: 5, total: 8 }],
};

function fmtDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export default {
  async state(_a, mctx) { await mctx.wait(120); return JSON.parse(JSON.stringify(state)); },
  async saveWizard(a, mctx) {
    await mctx.wait(80);
    state.wizard = { ...state.wizard, checks: { ...(a.checks || {}) }, step: a.step ?? 0, vendor: a.vendor ?? state.wizard.vendor, updatedAt: Date.now() };
    if (a.done) state.wizard.completedAt = Date.now();
    return state.wizard;
  },
  async saveStormTest(a, mctx) {
    await mctx.wait(80);
    state.stormTests.push({ at: Date.now(), seen: a.seen, total: a.total });
    return { saved: true, count: state.stormTests.length };
  },
  async openCalibration(_a, mctx) { await mctx.wait(300); return { started: true }; },
  async openHdrStore(_a, mctx) { await mctx.wait(200); return { opened: true }; },
  async detectGpu(_a, mctx) { await mctx.wait(700); return { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', adapters: ['Intel(R) UHD Graphics 770', 'NVIDIA GeForce RTX 4070 SUPER'] }; },
  async summary() {
    const parts = [];
    if (state.wizard.completedAt) parts.push(`Monitor eingerichtet am ${fmtDay(state.wizard.completedAt)}`);
    const last = state.stormTests[state.stormTests.length - 1];
    if (last) parts.push(`Sturm-Test ${last.seen} von ${last.total}`);
    return parts.length ? { text: parts.join(' · ') } : null;
  },
};
