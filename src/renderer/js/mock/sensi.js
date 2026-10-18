// Simulator für die Sensi-Kalibrierung (nur Browser-Vorschau).
// ?sensi=leer in der Adresse zeigt den Zustand ohne gespeicherte Werte und ohne Verlauf.

import * as SM from '../lib/sensi-math.mjs';

const DAY = 24 * 3600 * 1000;
const empty = typeof location !== 'undefined' && new URLSearchParams(location.search).get('sensi') === 'leer';

/** Baut einen glaubwürdigen Verlaufseintrag: Bestwert bei peakMult, Überziehen bei höheren Werten. */
function sample(at, { sens = 6.5, dpi = 800, peakMult = 1.05, level = 82, seed = 1, length = 'short' }) {
  const rng = SM.mulberry32(seed);
  const plan = SM.buildPlan({ mode: 'sens', settings: { dpi, sens, targeting: 45, scope: 45 }, length, rng });
  const blockResults = plan.blocks.map((b) => {
    const d = b.mult - peakMult;
    const score = SM.clamp(level - 380 * d * d + (rng() - 0.5) * 4, 20, 99);
    const hits = Math.round(16 + score / 8 + rng() * 3);
    const misses = Math.round(Math.max(0, (100 - score) / 9 + rng() * 2));
    const over = SM.clamp(0.15 + d * 2.4 + (rng() - 0.5) * 0.1, 0, 1);
    const under = SM.clamp(0.15 - d * 2.4 + (rng() - 0.5) * 0.1, 0, 1);
    const agg = {
      hits, misses, accuracy: SM.roundTo((100 * hits) / (hits + misses), 1),
      avgTtkMs: Math.round(560 + 900 * d * d * 10 + rng() * 60), ttkSum: 0, ttkCount: 0,
      trackingPct: SM.roundTo(SM.clamp(score - 22 + (rng() - 0.5) * 6, 5, 95), 1),
      overshoot: SM.roundTo(over, 3), undershoot: SM.roundTo(under, 3), score: SM.roundTo(score, 1),
    };
    agg.ttkSum = agg.avgTtkMs * hits; agg.ttkCount = hits;
    return { block: b, agg };
  });
  const rec = SM.recommend({ blocks: blockResults.map((r) => ({ mult: r.block.mult, score: r.agg.score, overshoot: r.agg.overshoot, undershoot: r.agg.undershoot })), baseSens: sens, dpi });
  return SM.buildHistoryEntry({ plan, blockResults, rec, rawInput: true, at });
}

function seedHistory() {
  const now = Date.now();
  return [
    sample(now - 19 * DAY, { sens: 6.0, peakMult: 1.12, level: 74, seed: 11 }),
    sample(now - 12 * DAY, { sens: 6.7, peakMult: 1.02, level: 78, seed: 12, length: 'normal' }),
    sample(now - 6 * DAY, { sens: 6.8, peakMult: 0.97, level: 81, seed: 13 }),
    sample(now - 2 * DAY, { sens: 6.6, peakMult: 1.01, level: 84, seed: 14 }),
    sample(now - 5 * 3600 * 1000, { sens: 6.5, peakMult: 1.05, level: 86, seed: 15, length: 'normal' }),
  ];
}

const db = {
  settings: { dpi: 800, sens: 6.5, targeting: 45, scope: 45 },
  saved: !empty,
  history: empty ? [] : seedHistory(),
};

const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
const copy = (v) => JSON.parse(JSON.stringify(v));

export default {
  async state(_a, mctx) {
    await mctx.wait(150);
    return copy({ settings: db.settings, saved: db.saved, history: db.history });
  },
  async getSettings() {
    return copy({ settings: db.settings, saved: db.saved });
  },
  async saveSettings(a, mctx) {
    await mctx.wait(120);
    const v = SM.validateSettings(a.settings || {});
    if (!v.ok) fail('BAD_ARG', Object.values(v.errors)[0]);
    db.settings = v.values;
    db.saved = true;
    return copy({ settings: db.settings, saved: true });
  },
  async saveResult(a, mctx) {
    await mctx.wait(200);
    const e = a.entry;
    if (!e || !Array.isArray(e.rounds) || !e.rounds.length) fail('BAD_ARG', 'Das Ergebnis enthält keine Durchgänge.');
    const entry = { ...copy(e), recommendedSens: SM.roundTo(e.recommendedSens, 1) };
    db.history = [...db.history.filter((x) => x.at !== entry.at), entry].sort((x, y) => x.at - y.at).slice(-200);
    mctx.emit('sensi.history', { count: db.history.length });
    return { entry: copy(entry), count: db.history.length };
  },
  async history(a) {
    const limit = Math.min(200, Math.max(1, Number(a.limit) || 200));
    return copy(db.history.slice(-limit));
  },
  async removeResult(a) {
    const before = db.history.length;
    db.history = db.history.filter((x) => x.at !== a.at);
    return { removed: before !== db.history.length, count: db.history.length };
  },
  async clearHistory(_a, mctx) {
    await mctx.wait(150);
    const cleared = db.history.length;
    db.history = [];
    return { cleared };
  },
  async summary() {
    const last = db.history[db.history.length - 1];
    if (last) return { text: `Empfohlen: ${SM.fmtSens(last.recommendedSens)} % (eDPI ${SM.fmtNum(last.edpi, 0)})` };
    if (db.saved) return { text: `Deine Sensi: ${SM.fmtSens(db.settings.sens)} % (eDPI ${SM.fmtNum(SM.edpi(db.settings.dpi, db.settings.sens), 0)}) – noch kein Aim-Test` };
    return null;
  },
};
