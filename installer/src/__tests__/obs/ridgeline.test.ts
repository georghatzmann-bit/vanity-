import { describe, expect, it } from "vitest";
import { MARK_GEOMETRY, rayAngle, rayDir } from "@shared/ui/PulsarMark";
import { FOLD_FLATTEN, foldMean, foldRowPoint, foldSegment, INTRO_MARK_CENTER, INTRO_MARK_SIZE, makeRows, noiseRow, plotX, probeGain, rayTarget, ROWS, rowBaseY, rowRay, rowStartSegment, rowTargetSegment, rowToRay, SAMPLES, sampleMs, sumToRing } from "../../obs/ridgeline";

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
      // Strahl 0: j = 0 innen; Strahl 1 umgekehrt (j = 0 außen), damit beide Bündel gleichsinnig drehen
      const a = rayTarget(i, b === 0 ? 0 : 160);
      const e = rayTarget(i, b === 0 ? 160 : 0);
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

describe("Faltung zweistufig (D.4): glätten, dann starres Segment", () => {
  it("jede Zeile dreht sich um weniger als 90°", () => {
    for (let i = 1; i <= ROWS; i++) {
      const A = rowStartSegment(i);
      const B = rowTargetSegment(i);
      const d = Math.abs(Math.atan2(Math.sin(B.angle - A.angle), Math.cos(B.angle - A.angle)));
      expect(d, `Zeile ${i}`).toBeLessThan(Math.PI / 2);
    }
  });

  it("keine Überkreuzung benachbarter Haarstrahlen bei e = 0,5", () => {
    const e = 0.5;
    const u = (e - FOLD_FLATTEN) / (1 - FOLD_FLATTEN);
    const ends = (i: number) => {
      const g = foldSegment(i, u);
      const h = g.len / 2;
      return [
        [g.cx - h * Math.cos(g.angle), g.cy - h * Math.sin(g.angle)],
        [g.cx + h * Math.cos(g.angle), g.cy + h * Math.sin(g.angle)],
      ] as const;
    };
    const cr = (o: readonly number[], a: readonly number[], b: readonly number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    for (let i = 1; i < ROWS; i++) {
      const [p1, p2] = ends(i);
      const [q1, q2] = ends(i + 1);
      const cross = cr(p1, p2, q1) * cr(p1, p2, q2) < 0 && cr(q1, q2, p1) * cr(q1, q2, p2) < 0;
      expect(cross, `Zeilen ${i}/${i + 1}`).toBe(false);
    }
  });

  it("bis e = 0,35 nur Amplitude → 0 an Ort und Stelle; e = 1 auf dem Haarstrahl; Punkte gleichmäßig", () => {
    expect(foldRowPoint(5, 40, 0.8, 0)).toEqual([plotX(40), rowBaseY(5) - 34 * 0.8]);
    const flat = foldRowPoint(5, 40, 0.8, FOLD_FLATTEN - 1e-9);
    expect(flat[1]).toBeCloseTo(rowBaseY(5), 3);
    for (const i of [1, 9, 16])
      for (const j of [0, 80, 160]) {
        const p = foldRowPoint(i, j, 0.5, 1);
        const t = rayTarget(i, j);
        expect(p[0]).toBeCloseTo(t[0], 6);
        expect(p[1]).toBeCloseTo(t[1], 6);
      }
    const a = foldRowPoint(3, 0, 0, 0.6);
    const b = foldRowPoint(3, 80, 0, 0.6);
    const c = foldRowPoint(3, 160, 0, 0.6);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(Math.hypot(c[0] - b[0], c[1] - b[1]), 6);
  });
});
