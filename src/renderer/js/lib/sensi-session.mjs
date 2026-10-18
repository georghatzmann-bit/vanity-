// Sensi-Kalibrierung: Ablauf eines ganzen Aim-Tests als reine Logik (ohne DOM, ohne Uhr).
// Die Arena (Canvas) gibt nur Zeit, Mausbewegung und Klicks hinein und zeichnet, was hier steht.
//
// Zeit T = aktive Testzeit in ms (Pausen zählen nicht). Jede Runde rechnet mit ihrer eigenen Zeit ab Rundenbeginn.

import {
  applyMovement, aggregateBlock, recommend, recommendDpi, buildHistoryEntry,
  LEAD_IN_MS, INTERLUDE_MS,
} from './sensi-math.mjs';
import { createRound } from './sensi-rounds.mjs';

/** Kurze Namen und Aufgaben der Runden (für Ansage und Ergebnis). */
export const ROUND_INFO = {
  flick: { name: 'Flicks', task: 'Triff jedes Ziel so schnell wie möglich.' },
  tracking: { name: 'Tracking', task: 'Halte das Fadenkreuz auf dem Ziel, während es sich bewegt.' },
  moving: { name: 'Bewegte Ziele', task: 'Die Ziele wandern. Klick sie an, bevor sie verschwinden.' },
};

export class TestSession {
  /**
   * plan: Ergebnis von buildPlan(). rawInput: lief die Maus mit Rohdaten (ohne Windows-Beschleunigung)?
   */
  constructor(plan, { rng = Math.random, leadInMs = LEAD_IN_MS, interludeMs = INTERLUDE_MS, rawInput = true } = {}) {
    if (!plan || !Array.isArray(plan.blocks) || !plan.blocks.length) throw new Error('Kein Testablauf.');
    this.plan = plan;
    this.rng = rng;
    this.leadInMs = leadInMs;
    this.interludeMs = interludeMs;
    this.rawInput = !!rawInput;
    this.queue = plan.warmup ? [plan.warmup, ...plan.blocks] : plan.blocks.slice();
    this.qi = 0;
    this.ri = 0;
    this.cam = { yaw: 0, pitch: 0 };
    this.phase = 'ready'; // ready | round | interlude | switch | done
    this.round = null;
    this.roundStart = 0;
    this.interludeEnd = 0;
    this.blockStats = [];
    this.results = [];
    this.switched = new Set();
    this.mouseDpi = plan.baseDpi; // worauf die Maus gerade steht (zuletzt bestätigt), am Anfang die eigene DPI
    this.events = [];
    this.doneMs = 0; // fertig gespielte Zeit (für den Gesamt-Fortschritt)
    this.totalMs = this.queue.reduce((n, b) => n + b.rounds.reduce((m, r) => m + r.durationMs + this.leadInMs, 0), 0);
    this.T = 0;
  }

  get block() { return this.queue[this.qi] || null; }
  /** Gerade simulierte Sensi in % (bleibt für den Spieler verdeckt). */
  get sens() { return this.block ? this.block.sens : this.plan.baseSens; }
  get dpi() { return this.block ? this.block.dpi : this.plan.baseDpi; }
  get warmup() { return !!this.block?.warmup; }
  get blockNo() { return this.block && !this.block.warmup ? this.block.index + 1 : 0; }
  get blockCount() { return this.plan.blocks.length; }
  get roundType() { return this.round ? this.round.type : null; }
  get finished() { return this.phase === 'done'; }

  emit(ev) { this.events.push(ev); }
  drain() { const e = this.events; this.events = []; return e; }

  start(T = 0) {
    if (this.phase !== 'ready') return this.drain();
    this.T = T;
    this.enterBlock(T);
    return this.drain();
  }

  enterBlock(T) {
    const b = this.block;
    if (b.needsSwitch && !this.switched.has(this.qi)) {
      this.phase = 'switch';
      this.round = null;
      this.emit({ type: 'switch', dpi: b.dpi });
      return;
    }
    this.mouseDpi = b.dpi;
    this.ri = 0;
    this.blockStats = [];
    this.emit({ type: 'block', warmup: !!b.warmup, blockNo: this.blockNo });
    this.startRound(T);
  }

  /** Der Spieler hat die DPI an der Maus umgestellt und klickt auf "weiter". */
  confirmSwitch(T = this.T) {
    if (this.phase !== 'switch') return this.drain();
    this.switched.add(this.qi);
    this.enterBlock(T);
    return this.drain();
  }

  startRound(T) {
    const spec = this.block.rounds[this.ri];
    this.cam = { yaw: 0, pitch: 0 }; // jede Runde beginnt mit Blick zur Mitte
    this.round = createRound(spec.type, { durationMs: spec.durationMs, leadInMs: this.leadInMs, rng: this.rng });
    this.roundStart = T;
    this.round.begin(this.cam, 0);
    this.phase = 'round';
    this.emit({ type: 'round', round: spec.type, index: this.ri, count: this.block.rounds.length });
  }

  local(T) { return Math.max(0, T - this.roundStart); }

  /** Rohe Maus-Counts. Wirkt auch in der Ansage und zwischen den Durchgängen (nur Umschauen). */
  move(dx, dy, T = this.T) {
    if (this.phase !== 'round' && this.phase !== 'interlude') return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.cam = applyMovement(this.cam, dx, dy, this.sens);
    if (this.phase === 'round') this.round.move(this.cam, this.local(T));
  }

  shoot(T = this.T) {
    if (this.phase !== 'round') return { result: 'ignored' };
    return this.round.shoot(this.cam, this.local(T));
  }

  update(T) {
    if (!Number.isFinite(T)) return this.drain();
    this.T = Math.max(this.T, T);
    if (this.phase === 'round') {
      this.round.update(this.cam, this.local(this.T));
      if (this.round.done) this.finishRound(this.T);
    } else if (this.phase === 'interlude' && this.T >= this.interludeEnd) {
      this.qi++;
      this.enterBlock(this.T);
    }
    return this.drain();
  }

  finishRound(T) {
    const r = this.round;
    this.blockStats.push(r.stats());
    this.doneMs += r.leadInMs + r.durationMs;
    this.ri++;
    if (this.ri < this.block.rounds.length) { this.startRound(T); return; }
    const b = this.block;
    if (!b.warmup) {
      const agg = aggregateBlock(this.blockStats);
      this.results.push({ block: { index: b.index, mult: b.mult, dpi: b.dpi, sens: b.sens }, agg, stats: this.blockStats });
    }
    this.emit({ type: 'blockDone', warmup: !!b.warmup, blockNo: this.blockNo, last: this.qi >= this.queue.length - 1 });
    this.round = null;
    if (this.qi >= this.queue.length - 1) {
      this.phase = 'done';
      this.emit({ type: 'done' });
      return;
    }
    this.phase = 'interlude';
    this.interludeEnd = T + this.interludeMs;
  }

  /** 0..1 über den ganzen Test. */
  get totalProgress() {
    const cur = this.round ? Math.min(this.round.t, this.round.leadInMs + this.round.durationMs) : 0;
    return this.totalMs ? Math.min(1, (this.doneMs + cur) / this.totalMs) : 0;
  }

  /** Alles, was die Arena für Anzeige und Bild braucht. */
  view() {
    const r = this.round;
    let live = null;
    if (r) {
      if (r.type === 'tracking') live = { trackingPct: Math.round(r.trackingPct), hot: !!r.hot };
      else {
        const shots = r.hits + r.misses;
        live = { hits: r.hits, misses: r.misses, accuracy: shots ? Math.round((100 * r.hits) / shots) : null };
      }
    }
    return {
      phase: this.phase,
      warmup: this.warmup,
      blockNo: this.blockNo,
      blockCount: this.blockCount,
      roundType: r ? r.type : null,
      roundIndex: this.ri,
      roundCount: this.block ? this.block.rounds.length : 0,
      inLeadIn: r ? r.inLeadIn : false,
      leadInLeftMs: r ? Math.max(0, r.leadInMs - r.t) : 0,
      roundProgress: r ? r.progress : 0,
      totalProgress: this.totalProgress,
      switchDpi: this.phase === 'switch' ? this.block.dpi : null,
      targets: r ? r.targets() : [],
      cam: this.cam,
      live,
    };
  }

  /** Ergebnis: Empfehlung, Verlaufseintrag (Form siehe 'tool-sensi') und worauf die Maus am Ende steht. */
  outcome(at = Date.now()) {
    const p = this.plan;
    const blocks = this.results.map((x) => ({
      mult: x.block.mult, sens: x.block.sens, dpi: x.block.dpi,
      score: x.agg.score, overshoot: x.agg.overshoot, undershoot: x.agg.undershoot,
    }));
    const rec = p.mode === 'dpi'
      ? recommendDpi({ blocks, baseDpi: p.baseDpi, baseSens: p.baseSens, rawInput: this.rawInput })
      : recommend({ blocks, baseSens: p.baseSens, dpi: p.baseDpi, rawInput: this.rawInput });
    const entry = buildHistoryEntry({ plan: p, blockResults: this.results, rec, rawInput: this.rawInput, at });
    return { rec, entry, blockResults: this.results, mouseDpi: this.mouseDpi };
  }
}

/**
 * Filter gegen einzelne Riesen-Sprünge, die Chromium im normalen Mausfang manchmal meldet
 * (z. B. wenn der unsichtbare Zeiger an den Fensterrand stößt).
 * Gerechnet wird in Zoll Mausweg pro Ereignis (Counts / DPI), damit Mäuse mit hoher DPI nicht stören.
 * Echte schnelle Flicks bleiben drin, weil sie über mehrere Ereignisse hinweg anwachsen.
 *   absurdIn: mehr als so viele Zoll in einem einzigen Ereignis ist unmöglich -> weg
 *   jumpIn/factor: ab jumpIn Zoll muss das vorige Ereignis mindestens 1/factor so groß gewesen sein
 */
export function createSpikeFilter({ dpi = 800, absurdIn = 6, jumpIn = 1.2, factor = 6 } = {}) {
  let perInch = dpi > 0 ? dpi : 800;
  let prev = 0;
  let dropped = 0;
  return {
    accept(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) { dropped++; return false; }
      const m = Math.max(Math.abs(dx), Math.abs(dy)) / perInch;
      if (m > absurdIn || (m > jumpIn && m > prev * factor)) { dropped++; return false; }
      prev = m;
      return true;
    },
    setDpi(v) { if (v > 0) perInch = v; prev = 0; },
    get dropped() { return dropped; },
    reset() { prev = 0; },
  };
}
