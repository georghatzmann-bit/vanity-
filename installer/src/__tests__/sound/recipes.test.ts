import { describe, expect, it } from "vitest";
import { F_STAR, TIMBRES, dbToGain, progressBuffer } from "@shared/sound/dsp";
import {
  RECIPES,
  SOUND_NAMES,
  bufferPitches,
  eventEnd,
  eventPeakDb,
  recipeEnd,
  renderRecipe,
  type PartialEvent,
  type Recipe,
  type RecipeEvent,
  type RecipeTarget,
  type SoundName,
} from "@shared/sound/recipes";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ALL: SoundName[] = [
  "startup", "click", "hover", "switch", "success", "error", "launch", "achievement", "toggleOn", "toggleOff",
  "open", "close", "tick", "notify", "whoosh", "progress", "jingle", "farewell", "dice",
];

const recipe = (n: SoundName): Recipe => RECIPES[n];

/** Tonhöhen eines Ereignisses (Resonatoren der Puffer, Teiltöne); ausgenommen sweep, noise, rfi, spin. */
function pitches(e: RecipeEvent): number[] {
  switch (e.kind) {
    case "buffer":
      return bufferPitches(e.buffer);
    case "pulse":
      return TIMBRES[e.timbre].branches.filter((b) => b.type === "bandpass").map((b) => b.f);
    case "progress":
      return [0, 0.34, 0.67, 1].flatMap((v) => bufferPitches(progressBuffer(v)));
    case "partial":
      return [e.n * F_STAR];
    default:
      return [];
  }
}

describe("Rezepte (E.12)", () => {
  it("genau die 19 SoundNames", () => {
    expect(SOUND_NAMES.sort()).toEqual([...ALL].sort());
  });

  it("Regel A: jede Tonhöhe ist n·F_STAR, 1 ≤ n ≤ 18 (±0,05 Hz)", () => {
    for (const name of ALL) {
      for (const e of recipe(name).events) {
        for (const f of pitches(e)) {
          const n = Math.round(f / F_STAR);
          expect(n, `${name}: ${f} Hz`).toBeGreaterThanOrEqual(1);
          expect(n, `${name}: ${f} Hz`).toBeLessThanOrEqual(18);
          expect(Math.abs(f - n * F_STAR), `${name}: ${f} Hz`).toBeLessThanOrEqual(0.05);
        }
        if (e.kind === "partial") expect(Number.isInteger(e.n)).toBe(true);
      }
    }
  });

  it("Regel B (keine Melodie): Teiltöne mit Einsätzen > 5 ms auseinander haben gleiche Frequenz", () => {
    for (const name of ALL) {
      const ps = recipe(name).events.filter((e): e is PartialEvent => e.kind === "partial");
      for (const a of ps)
        for (const b of ps) if (Math.abs(a.at - b.at) > 0.005) expect(a.n, `${name}: Teiltöne ${a.n}/${b.n} nacheinander`).toBe(b.n);
    }
  });

  it("Regel C: jeder Sweep fällt (fHi > fLo)", () => {
    let sweeps = 0;
    for (const name of ALL)
      for (const e of recipe(name).events)
        if (e.kind === "sweep") {
          sweeps++;
          expect(e.fHi, name).toBeGreaterThan(e.fLo);
        }
    expect(sweeps).toBeGreaterThanOrEqual(3);
  });

  it("Regel D: Ereignis-Spitze ≤ −14 dBFS, kohärente Summe gleichzeitiger Teiltöne ≤ −12 dBFS", () => {
    for (const name of ALL) {
      const r = recipe(name);
      for (const e of r.events) expect(eventPeakDb(e), `${name} ${e.kind}`).toBeLessThanOrEqual(-14);
      const ps = r.events.filter((e): e is PartialEvent => e.kind === "partial");
      for (const a of ps) {
        const overlapping = ps.filter((b) => b.at < eventEnd(a) && a.at < eventEnd(b));
        const sum = overlapping.reduce((s, b) => s + dbToGain(b.gainDb), 0);
        expect(20 * Math.log10(sum), name).toBeLessThanOrEqual(-12);
      }
    }
  });

  it("Regel E: Dauern laut E.12", () => {
    const table: Partial<Record<SoundName, number>> = {
      hover: 0.01, click: 0.03, tick: 0.01, switch: 0.18, whoosh: 0.32, open: 0.16, close: 0.12, success: 0.9,
      error: 0.26, startup: 2.2, launch: 2.4, achievement: 3.3, jingle: 4, farewell: 2.5, dice: 2.3,
    };
    for (const [name, d] of Object.entries(table) as [SoundName, number][]) {
      expect(recipe(name).durS, name).toBe(d);
    }
    for (const name of ALL) {
      const r = recipe(name);
      const end = recipeEnd(r);
      expect(end / r.durS, `${name}: Ende ${end.toFixed(3)} s statt ${r.durS} s`).toBeGreaterThanOrEqual(0.7);
      expect(end / r.durS, `${name}: Ende ${end.toFixed(3)} s statt ${r.durS} s`).toBeLessThanOrEqual(1.2);
      for (const e of r.events) expect(e.at).toBeLessThan(r.durS);
    }
  });

  it("Sperren laut E.12", () => {
    expect(recipe("hover").lockMs).toBe(50);
    expect(recipe("click").lockMs).toBe(30);
    expect(recipe("tick").lockMs).toBe(18);
    expect(recipe("switch").lockMs).toBe(60);
    expect(recipe("progress").lockMs).toBe(90);
  });

  it("startup: Pulsabstand 1337,3 ms, passt ins 2,3-s-Intro", () => {
    const ps = recipe("startup").events.filter((e) => e.kind === "pulse");
    expect(ps.length).toBe(2);
    expect(Math.abs((ps[1].at - ps[0].at) * 1000 - 1337.3)).toBeLessThan(0.01);
    expect(recipeEnd(recipe("startup"))).toBeLessThanOrEqual(2.3);
  });

  it("farewell: Puls 4 und 6 fallen aus, Pegel −24 → −30", () => {
    const ps = recipe("farewell").events.filter((e) => e.kind === "pulse");
    expect(ps.length).toBe(4);
    expect(ps[0].gainDb).toBe(-24);
    expect(ps[ps.length - 1].gainDb).toBeCloseTo(-28.8, 6); // Puls 5 von 6
  });

  it("Akkord-Teiltöne: n ∈ {1, 2, 3, 4, 5, 6, 8}, gleichzeitig, ohne 7.", () => {
    for (const name of ["jingle", "achievement"] as SoundName[]) {
      const ps = recipe(name).events.filter((e): e is PartialEvent => e.kind === "partial");
      expect(ps.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6, 8]);
      expect(new Set(ps.map((p) => p.at)).size).toBe(1);
    }
  });

  it("renderRecipe ruft für jedes Ereignis den passenden Baustein (gain-Faktor wirkt)", () => {
    for (const name of ALL) {
      const calls: string[] = [];
      let maxGain = 0;
      const t: RecipeTarget = {
        buffer: (_n, _a, g) => {
          calls.push("buffer");
          maxGain = Math.max(maxGain, g);
        },
        partial: (o) => {
          calls.push("partial");
          maxGain = Math.max(maxGain, o.gain);
        },
        sweep: (o) => {
          calls.push("sweep");
          expect(o.fHi).toBeGreaterThan(o.fLo);
        },
        noise: () => calls.push("noise"),
        rfi: () => calls.push("rfi"),
        spin: () => calls.push("spin"),
      };
      renderRecipe(t, name, 100, { gain: 0.5, value: 0.3 }, () => 0.5);
      expect(calls.length, name).toBe(recipe(name).events.length);
      expect(maxGain).toBeLessThanOrEqual(0.5 * dbToGain(-14) + 1e-12);
    }
  });

  it("keine Pentatonik-Reste in shared/sound", () => {
    const dir = resolve(import.meta.dirname, "../../../../shared/sound");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(resolve(dir, f), "utf8");
      expect(/pentatonic|PENTA/.test(src), f).toBe(false);
    }
  });
});
