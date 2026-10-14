import { describe, expect, it } from "vitest";
import { MARK_GEOMETRY, rayAngle, rayDir } from "@shared/ui/PulsarMark";
import { foldMean, INTRO_MARK_CENTER, INTRO_MARK_SIZE, makeRows, noiseRow, probeGain, rayTarget, ROWS, rowRay, rowToRay, SAMPLES, sampleMs, sumToRing } from "../../obs/ridgeline";

const s = INTRO_MARK_SIZE / MARK_GEOMETRY.VIEWBOX;
const [cx, cy] = INTRO_MARK_CENTER;

function std(a: number[]) {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
}

describe("Ridgeline (D.3)", () => {
  it("Seed deterministisch, 16 Zeilen à 161 Punkte", () => {
    const a = makeRows(1919);
    const b = makeRows(1919);
    expect(a).toHaveLength(ROWS);
    for (let k = 0; k < ROWS; k++) {
      expect(a[k].y).toHaveLength(SAMPLES);
      expect(Array.from(a[k].y)).toEqual(Array.from(b[k].y));
    }
    expect(Array.from(makeRows(7)[0].y)).not.toEqual(Array.from(a[0].y));
    expect(Array.from(noiseRow(3, 5))).toEqual(Array.from(noiseRow(3, 5)));
  });

  it("Profil normiert (max s ≤ 1), A_k ∈ [0,6; 1], c_k driftet in [−6; 6)", () => {
    for (const r of makeRows()) {
      expect(Math.max(...r.signal)).toBeLessThanOrEqual(1 + 1e-12);
      expect(r.A).toBeGreaterThanOrEqual(0.6);
      expect(r.A).toBeLessThanOrEqual(1);
      expect(r.c).toBeCloseTo(-6 + (((r.k - 1) * 3.7) % 12), 12);
    }
  });

  it("Peak jeder Zeile innerhalb ±6 ms", () => {
    for (const r of makeRows()) {
      let jm = 0;
      for (let j = 1; j < SAMPLES; j++) if (r.y[j] > r.y[jm]) jm = j;
      expect(Math.abs(sampleMs(jm)), `Zeile ${r.k}`).toBeLessThanOrEqual(6);
      expect(Math.abs(sampleMs(jm) - r.c), `Zeile ${r.k}`).toBeLessThanOrEqual(6);
    }
  });

  it("Σ₁₆ außerhalb ±30 ms: σ ≤ σ_Zeile/3", () => {
    const rows = makeRows();
    const sum = foldMean(rows, 16);
    const outside = (a: ArrayLike<number>) => Array.from({ length: SAMPLES }, (_, j) => j).filter((j) => Math.abs(sampleMs(j)) > 30).map((j) => a[j]);
    const sigmaSum = std(outside(sum));
    const sigmaRow = rows.map((r) => std(outside(r.y))).reduce((x, y) => x + y, 0) / rows.length;
    expect(sigmaSum).toBeLessThanOrEqual(sigmaRow / 3);
  });

  it("foldMean(k) ist das Mittel der ersten k Zeilen", () => {
    const rows = makeRows();
    const f2 = foldMean(rows, 2);
    expect(f2[80]).toBeCloseTo((rows[0].y[80] + rows[1].y[80]) / 2, 12);
    expect(Array.from(foldMean(rows, 0)).every((v) => v === 0)).toBe(true);
  });

  it("Probefaltung c(f) = 1 bei f₀, klein daneben", () => {
    expect(probeGain(0.7478)).toBeCloseTo(1, 12);
    expect(probeGain(0.9)).toBeLessThan(0.01);
  });
});

describe("Faltung zum Zeichen (D.4)", () => {
  it("rowToRay(t = 1) liegt auf dem Haarstrahl, Endpunkte RAY_IN / RAY_OUT(k)", () => {
    for (let i = 1; i <= 16; i++) {
      const { b, k } = rowRay(i);
      expect(b).toBe(i <= 8 ? 0 : 1);
      const [dx, dy] = rayDir(rayAngle(b, k));
      for (const j of [0, 40, 80, 160]) {
        const p = rowToRay(i, j, 1, [0, 0]);
        // Abstand des Punkts von der Strahlgeraden durch die Mitte
        const vx = p[0] - cx;
        const vy = p[1] - cy;
        expect(Math.abs(vx * dy - vy * dx)).toBeLessThan(1e-6);
        expect(vx * dx + vy * dy).toBeGreaterThan(0);
      }
      const a = rayTarget(i, 0);
      const e = rayTarget(i, 160);
      expect(Math.hypot(a[0] - cx, a[1] - cy)).toBeCloseTo(s * MARK_GEOMETRY.RAY_IN, 6);
      expect(Math.hypot(e[0] - cx, e[1] - cy)).toBeCloseTo(s * MARK_GEOMETRY.RAY_OUT(k), 6);
    }
  });

  it("rowToRay(t = 0) bleibt am Startpunkt", () => {
    expect(rowToRay(3, 10, 0, [123, 45])).toEqual([123, 45]);
  });

  it("sumToRing(t = 1) liegt auf RING_R·s", () => {
    for (let j = 0; j <= 160; j += 8) {
      const p = sumToRing(j, 1, [0, 0]);
      expect(Math.hypot(p[0] - cx, p[1] - cy)).toBeCloseTo(MARK_GEOMETRY.RING_R * s, 6);
    }
    // ψ_0 = 0: oben senkrecht über der Mitte
    const top = sumToRing(0, 1, [0, 0]);
    expect(top[0]).toBeCloseTo(cx, 9);
    expect(top[1]).toBeLessThan(cy);
  });
});
