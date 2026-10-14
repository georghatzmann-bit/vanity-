import { describe, expect, it } from "vitest";
import {
  angleToSight, arcWeight, basis, BEAM_LEN, beamFillAlpha, beamHull, beamQuad, blurWeight, capDot, capEllipse, coneDir, dipolePoints, exposureTurns, FIELD_CHI_DEG, FIELD_L, fieldLoopWeight,
  flashAllowed, lambdaForPhase, LOGO_PHASE, magneticAxis, MARK_PARAMS, markMorph, projectedAngle, psiForPhase, pulseDisc, signedArea, silhouetteLambdas, STAR_CENTER, STAR_PARAMS, STAR_R, zoneAlpha, zoneQuads,
  strobeVisFreq, strobeWindow, type Vec3,
} from "../../obs/star";

const deg = Math.PI / 180;
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

describe("Neutronenstern: Geometrie (F.3)", () => {
  it("Basis nach R_z(−35°) wie nachgerechnet", () => {
    const b = basis();
    const close = (v: Vec3, w: number[]) => v.forEach((x, i) => expect(x).toBeCloseTo(w[i], 4));
    close(b.omega, [0.43939, 0.62751, 0.64279]);
    close(b.e1, [-0.81915, 0.57358, 0]);
    close(b.e2, [-0.36869, -0.52654, 0.76604]);
  });

  it("psiForPhase: φ 0 → 90°, φ 0,5 → 270°", () => {
    expect(psiForPhase(0) / deg).toBeCloseTo(90, 9);
    expect(psiForPhase(0.5) / deg).toBeCloseTo(270, 9);
    expect(LOGO_PHASE).toBe(0.5);
  });

  it("Puls: m(ψ = 90°) liegt 5,0° von der Sichtlinie", () => {
    expect(Math.abs(angleToSight(magneticAxis(90 * deg)) - 5)).toBeLessThan(0.05);
  });

  it("Gegenstrahl kommt der Sichtlinie nie näher als 84,9°", () => {
    for (let i = 0; i < 720; i++) {
      const m = magneticAxis((i / 720) * 2 * Math.PI);
      expect(angleToSight([-m[0], -m[1], -m[2]])).toBeGreaterThanOrEqual(84.9);
    }
  });

  it("Logo-Phase: m(270°) projiziert 35,0°, z = −0,087", () => {
    const m = magneticAxis(270 * deg);
    expect(Math.abs(projectedAngle(m) - 35)).toBeLessThan(0.1);
    expect(Math.abs(m[2] - -0.087)).toBeLessThan(0.002);
    expect(len(m)).toBeCloseTo(1, 12);
  });

  it("Dipol-Feldlinie r = L·sin²θ, Endpunkte auf der Oberfläche", () => {
    const m = magneticAxis(psiForPhase(0.2));
    for (const L of FIELD_L)
      for (const chi of FIELD_CHI_DEG) {
        const pts = dipolePoints(L, chi, m, 40);
        expect(pts).toHaveLength(40);
        expect(pts[0].r).toBeCloseTo(1, 9);
        expect(pts[39].r).toBeCloseTo(1, 9);
        // Scheitel (θ = 90°) liegt bei r ≈ L
        expect(Math.max(...pts.map((p) => p.r))).toBeGreaterThan(L * 0.99);
        for (const p of pts) expect(p.r).toBeLessThanOrEqual(L + 1e-9);
      }
  });

  it("Strahl: Viereck (offener Keil) von R★ bis BEAM_LEN = 2,0 R★", () => {
    expect(BEAM_LEN).toBe(2);
    const q = beamQuad(magneticAxis(90 * deg));
    expect(q.quad).toHaveLength(4);
    expect(2 * q.end.rx).toBeCloseTo(2 * BEAM_LEN * Math.tan(9 * deg) * STAR_R, 6);
  });

  it("Ringzone: 1°-Vierecke im Uhrzeigersinn, Ausdehnung ≤ 120 px, frei vom Kamera-Label (x < 210, y > 362)", () => {
    for (const sgn of [1, -1] as const) {
      const qs = zoneQuads(0, 2 * Math.PI, sgn);
      expect(qs).toHaveLength(360);
      for (const q of qs) {
        expect(signedArea(q.pts)).toBeGreaterThan(0);
        for (const p of q.pts) {
          expect(Math.hypot(p.x - STAR_CENTER[0], p.y - STAR_CENTER[1])).toBeLessThanOrEqual(120);
          expect(p.x < 210 && p.y > 362).toBe(false);
        }
      }
    }
    // Bogen: letztes Viereck endet genau bei lambdaTo; Teilbogen hat ⌈Δλ/1°⌉ Vierecke
    expect(zoneQuads(0, 10.5 * deg, 1)).toHaveLength(11);
    expect(zoneQuads(1, 1, 1)).toHaveLength(0);
    // Ringzone liegt um den Strahl: Mitte des Vierecks bei λ(φ) nahe BEAM_LEN·m
    const phi = 0.3;
    const q = zoneQuads(lambdaForPhase(phi, 1), lambdaForPhase(phi, 1) + deg, 1)[0];
    const m = magneticAxis(psiForPhase(phi));
    const cx = (q.pts[0].x + q.pts[1].x + q.pts[2].x + q.pts[3].x) / 4;
    const cy = (q.pts[0].y + q.pts[1].y + q.pts[2].y + q.pts[3].y) / 4;
    expect(Math.hypot(cx - (STAR_CENTER[0] + STAR_R * BEAM_LEN * m[0]), cy - (STAR_CENTER[1] - STAR_R * BEAM_LEN * m[1]))).toBeLessThan(2);
  });

  it("Ringzone: Deckkraft 0,07 + 0,05·u, Bogen blendet über n ein (kein Fleck im Leerlauf)", () => {
    expect(zoneAlpha(2.5)).toBeCloseTo(0.07, 9);
    expect(zoneAlpha(173.7)).toBeCloseTo(0.12, 9);
    expect(arcWeight(0.748 / 60)).toBe(0);
    expect(arcWeight(0.15)).toBe(1);
  });

  it("Strahl-Hülle: konvex, im Uhrzeigersinn, enthält Basis- und Endkreis, keine Überlänge", () => {
    for (let i = 0; i < 36; i++) {
      const m = magneticAxis((i / 36) * 2 * Math.PI);
      for (const s of [1, -1]) {
        const ax: Vec3 = [m[0] * s, m[1] * s, m[2] * s];
        const h = beamHull(ax);
        expect(h.length).toBeGreaterThanOrEqual(3);
        expect(signedArea(h)).toBeGreaterThan(0);
        // konvex: alle Kreuzprodukte gleiches Vorzeichen
        for (let k = 0; k < h.length; k++) {
          const a = h[k];
          const b = h[(k + 1) % h.length];
          const c = h[(k + 2) % h.length];
          expect((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)).toBeGreaterThanOrEqual(-1e-6);
        }
        // nichts ragt über BEAM_LEN (+ Radius des Endkreises) hinaus
        const lim = STAR_R * (BEAM_LEN / Math.cos((9 * Math.PI) / 180)) + 0.01;
        for (const p of h) expect(Math.hypot(p.x - STAR_CENTER[0], p.y - STAR_CENTER[1])).toBeLessThanOrEqual(lim);
      }
    }
  });

  it("Einzelstrahl-Füllung verschwindet zur Erde hin, hinten × 0,6", () => {
    expect(beamFillAlpha([0, 0, 1])).toBe(0);
    expect(beamFillAlpha([1, 0, 0])).toBeCloseTo(0.16, 9);
    expect(beamFillAlpha([0.8, 0, -0.6])).toBeCloseTo(0.6 * 0.16, 9);
  });

  it("Feldlinien: max. 2,1 R★, Schleifen in der Ebene von Ω̂ und m, Kanten-Ansicht blendet aus", () => {
    expect([...FIELD_L]).toEqual([1.6, 2.1]);
    expect(Math.max(...FIELD_L)).toBeLessThanOrEqual(BEAM_LEN + 0.1);
    expect([...FIELD_CHI_DEG]).toEqual([90, 270]);
    let minW = 1;
    let maxW = 0;
    for (let i = 0; i < 360; i++) {
      const w = fieldLoopWeight(90, magneticAxis((i / 360) * 2 * Math.PI));
      minW = Math.min(minW, w);
      maxW = Math.max(maxW, w);
    }
    expect(maxW).toBeGreaterThan(0.5);
    expect(minW).toBeLessThan(0.05);
  });

  it("Silhouetten-Erzeugende: äußere Kegel (54°/126°) haben keine – die Sichtlinie liegt in ihnen", () => {
    for (const th of [54, 126]) expect(silhouetteLambdas((th * Math.PI) / 180)).toHaveLength(0);
  });

  it("Silhouetten-Erzeugende: zwei Lösungen je innerem Kegel, Normale senkrecht zur Sichtlinie", () => {
    for (const th of [36, 144]) {
      const ls = silhouetteLambdas((th * Math.PI) / 180);
      expect(ls).toHaveLength(2);
      const b = basis();
      for (const l of ls) {
        const d = coneDir((th * Math.PI) / 180, l);
        expect(len(d)).toBeCloseTo(1, 9);
        const t = (th * Math.PI) / 180;
        const nz = -Math.sin(t) * b.omega[2] + Math.cos(t) * (Math.cos(l) * b.e1[2] + Math.sin(l) * b.e2[2]);
        expect(Math.abs(nz)).toBeLessThan(1e-9);
      }
    }
  });

  it("Polkappen: Deckkraft 0,7·max(0, ±m_z); als Punkt 0,9·max(0, m_z) im Kappenmittelpunkt", () => {
    const m = magneticAxis(90 * deg);
    const d = capDot(m);
    expect(d.visible).toBe(true);
    expect(d.alpha).toBeCloseTo(0.9 * m[2], 9);
    expect(d.x).toBeCloseTo(STAR_CENTER[0] + STAR_R * m[0], 9);
    expect(capDot([-m[0], -m[1], -m[2]]).visible).toBe(false);
    expect(capEllipse(m, 1).alpha).toBeCloseTo(0.7 * m[2], 9);
    expect(capEllipse(m, -1).alpha).toBe(0);
    expect(capEllipse(m, -1).visible).toBe(false);
  });
});

describe("Neutronenstern: Kamera, Blitzschutz, Wandlung", () => {
  it("Belichtete Umdrehungen n(f)", () => {
    expect(exposureTurns(0.748)).toBeCloseTo(0.0125, 3);
    expect(exposureTurns(2.5)).toBe(2);
    expect(exposureTurns(11.19)).toBe(2);
    expect(exposureTurns(1.0)).toBeCloseTo(0.026, 3);
    expect(exposureTurns(1.37)).toBeCloseTo(0.159, 3);
    expect(exposureTurns(2.0)).toBeCloseTo(1.26, 2);
  });

  it("Strobo-Alias-Drehzahl und Verwischung", () => {
    expect(strobeVisFreq(2.5)).toBeCloseTo(0.2, 9);
    expect(strobeVisFreq(173.7)).toBeCloseTo(0.8, 9);
    expect(blurWeight(0)).toBe(1);
    expect(blurWeight(2)).toBeCloseTo(0.2, 9);
  });

  it("flashAllowed: 2,5 Hz ja, 2,6 Hz nein (≤ 3 Blitze pro Sekunde)", () => {
    expect(flashAllowed(2.5)).toBe(true);
    expect(flashAllowed(2.6)).toBe(false);
    // über 2,5 Hz keine Lichtscheibe (auch keine „ruhige“), darunter an der Kappe 0,6·exp(−(γ/6°)²)
    expect(pulseDisc(magneticAxis(90 * deg), 173.7).visible).toBe(false);
    expect(pulseDisc(magneticAxis(90 * deg), 173.7).alpha).toBe(0);
    const d = pulseDisc(magneticAxis(90 * deg), 0.748);
    expect(d.alpha).toBeCloseTo(0.6 * Math.exp(-((5 / 6) ** 2)), 6);
    // Gelb als Fläche: nur der Kappen-Punkt, wächst höchstens auf r 4 px (keine Ellipse)
    expect(d.r).toBeGreaterThan(2);
    expect(d.r).toBeLessThanOrEqual(4);
  });

  it("Stroboskop: Fenster um ⌊φ⌋ + 0,5, Breite 2 → 0 in 800 ms", () => {
    const a = strobeWindow(17.3, 0);
    expect(a.center).toBe(17.5);
    expect(a.width).toBeCloseTo(2, 9);
    expect(strobeWindow(17.3, 800).width).toBeCloseTo(0, 9);
    expect(strobeWindow(17.3, 400).width).toBeLessThan(1);
  });

  it("markMorph(0) = Stern, markMorph(1) = Zeichen", () => {
    expect(markMorph(0)).toEqual(STAR_PARAMS);
    const end = markMorph(1);
    for (const k of Object.keys(MARK_PARAMS) as (keyof typeof MARK_PARAMS)[]) expect(end[k]).toBeCloseTo(MARK_PARAMS[k], 9);
    expect(STAR_PARAMS.ringR).toBe(58);
    expect(MARK_PARAMS.ringR).toBeCloseTo(72.2, 1);
    expect(MARK_PARAMS.ringWidth).toBeCloseTo(2.5, 1); // PulsarMark: Ringstrich 2,5 px bei 220 px
    expect(MARK_PARAMS.coreR).toBeCloseTo(6.9, 1); // Kern Ø ≈ 14 px (kein „Spiegelei“/keine Zielscheibe)
  });
});
