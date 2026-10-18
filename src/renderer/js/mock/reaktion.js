// Simulator für das Reaktions-Labor (nur Browser-Vorschau).

const now = Date.now();
const D = 24 * 3600 * 1000;

const DEFAULTS = {
  wall: { code: 'F1', label: 'F1', on: true },
  floor: { code: 'F2', label: 'F2', on: true },
  stairs: { code: 'F3', label: 'F3', on: true },
  roof: { code: 'F4', label: 'F4', on: true },
  edit: { code: 'KeyG', label: 'G', on: true },
  weapon1: { code: 'Digit2', label: '2', on: false },
  weapon2: { code: 'Digit3', label: '3', on: false },
  weapon3: { code: 'Digit4', label: '4', on: false },
  weapon4: { code: 'Digit5', label: '5', on: false },
  weapon5: { code: 'Digit6', label: '6', on: false },
};

const db = {
  reaction: [262, 248, 251, 239, 244, 231, 236, 228, 224].map((avg, i, a) => ({
    at: now - (a.length - i) * 1.3 * D, avgMs: avg, bestMs: avg - 22 - (i % 3) * 6, rounds: 5, falseStarts: i % 4 === 0 ? 1 : 0,
  })),
  keys: [{ a: 612, acc: 80 }, { a: 571, acc: 85 }, { a: 548, acc: 90 }, { a: 517, acc: 95 }].map((x, i, a) => ({
    at: now - (a.length - i) * 2 * D, avgMs: x.a, accuracy: x.acc, count: 20,
  })),
  binds: {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    wall: { code: 'KeyQ', label: 'Q', on: true },
    floor: { code: 'Mouse4', label: 'Maus 5', on: true },
    stairs: { code: 'KeyE', label: 'E', on: true },
    roof: { code: 'ShiftLeft', label: 'Umschalt', on: true },
    edit: { code: 'KeyF', label: 'F', on: true },
  },
};

const avg = (l, f) => (l.length ? Math.round(l.reduce((n, e) => n + f(e), 0) / l.length) : null);
function stats() {
  const r = db.reaction;
  const k = db.keys.filter((e) => e.avgMs !== null);
  return {
    reaction: {
      count: r.length,
      bestMs: r.length ? Math.min(...r.map((e) => e.bestMs)) : null,
      bestAvgMs: r.length ? Math.min(...r.map((e) => e.avgMs)) : null,
      last5AvgMs: avg(r.slice(-5), (e) => e.avgMs),
    },
    keys: {
      count: db.keys.length,
      bestAvgMs: k.length ? Math.min(...k.map((e) => e.avgMs)) : null,
      last5AvgMs: avg(k.slice(-5), (e) => e.avgMs),
      last5Accuracy: db.keys.length ? Math.round(db.keys.slice(-5).reduce((n, e) => n + e.accuracy, 0) / Math.min(5, db.keys.length)) : null,
    },
  };
}
const state = () => ({ reaction: db.reaction, keys: db.keys, binds: db.binds, defaults: DEFAULTS, stats: stats() });

export default {
  async getState(_a, mctx) { await mctx.wait(200); return state(); },
  async saveReaction(a, mctx) {
    await mctx.wait(120);
    const entry = { at: Date.now(), avgMs: Math.round(a.avgMs), bestMs: Math.round(a.bestMs), rounds: a.rounds, falseStarts: a.falseStarts };
    db.reaction.push(entry);
    return { entry, state: state() };
  },
  async saveKeys(a, mctx) {
    await mctx.wait(120);
    const entry = { at: Date.now(), avgMs: a.avgMs === null ? null : Math.round(a.avgMs), accuracy: a.accuracy, count: a.count };
    db.keys.push(entry);
    return { entry, state: state() };
  },
  async saveBinds(a, mctx) {
    await mctx.wait(80);
    db.binds = { ...DEFAULTS, ...a.binds };
    return { binds: db.binds };
  },
  async clearHistory(a, mctx) {
    await mctx.wait(120);
    if (a.which === 'reaction' || a.which === 'all') db.reaction = [];
    if (a.which === 'keys' || a.which === 'all') db.keys = [];
    return state();
  },
  async summary() {
    const r = db.reaction[db.reaction.length - 1];
    const k = db.keys[db.keys.length - 1];
    if (r && k) return { text: `Reaktion Ø ${r.avgMs} ms · Tasten Ø ${k.avgMs} ms` };
    if (r) return { text: `Reaktion Ø ${r.avgMs} ms · Bestwert ${r.bestMs} ms` };
    return null;
  },
};
