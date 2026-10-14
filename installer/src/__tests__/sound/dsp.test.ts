import { describe, expect, it } from "vitest";
import {
  F_STAR,
  TIMBRES,
  BUFFER_SPECS,
  biquadCoeffs,
  biquadMagnitude,
  crossfade,
  dispersionAt,
  dispersionCurve,
  excitationEnergy,
  filterSignal,
  harmonic,
  heardAs,
  makeExcitation,
  makeExcitations,
  mulberry32,
  noiseShare,
  peakOf,
  progressBuffer,
  Q_BUTTER,
  rfiPeak,
  sawtooth,
  sawtoothAdditive,
  pulseAmp,
  renderClickTrain,
  renderHarmonicTone,
  renderResponse,
  rmsOf,
  smootherCutoff,
  timbreSpec,
  toneGain,
  triangular,
} from "@shared/sound/dsp";

const SR = 48000;
const db = (x: number) => 20 * Math.log10(x);

describe("Grundton und Harmonische", () => {
  it("F_STAR = 173,7016 Hz", () => {
    expect(Math.abs(F_STAR - 173.7016)).toBeLessThan(1e-3);
  });
  it("harmonic(6) = 1042,21 Hz", () => {
    expect(Math.abs(harmonic(6) - 1042.21)).toBeLessThan(0.01);
  });
  it("alle Resonatoren der Klangfarben und Puffer liegen auf Harmonischen", () => {
    const freqs = [
      ...Object.values(TIMBRES).flatMap((t) => t.branches.filter((b) => b.type === "bandpass").map((b) => b.f)),
      ...Object.values(BUFFER_SPECS).flatMap((b) => b.spec.branches.filter((x) => x.type === "bandpass").map((x) => x.f)),
    ];
    for (const f of freqs) {
      const n = Math.round(f / F_STAR);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(18);
      expect(Math.abs(f - n * F_STAR)).toBeLessThan(0.05);
    }
  });
});

describe("Dispersions-Sweep", () => {
  const c = dispersionCurve(3200, 400, 0.22, 64);
  it("Endpunkte", () => {
    expect(c.length).toBe(64);
    expect(c[0]).toBeCloseTo(3200, 3);
    expect(c[63]).toBeCloseTo(400, 3);
  });
  it("streng fallend", () => {
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeLessThan(c[i - 1]);
  });
  it("Stichproben laut E.7", () => {
    expect(dispersionAt(3200, 400, 0.22, 0.02) / 1234).toBeGreaterThan(0.99);
    expect(dispersionAt(3200, 400, 0.22, 0.02) / 1234).toBeLessThan(1.01);
    const pts: [number, number][] = [
      [0.005, 2052],
      [0.05, 818],
      [0.1, 588],
    ];
    for (const [t, f] of pts) expect(Math.abs(dispersionAt(3200, 400, 0.22, t) / f - 1)).toBeLessThan(0.01);
    expect(Math.abs(dispersionAt(1800, 300, 0.16, 0.02) / 776 - 1)).toBeLessThan(0.01);
    expect(Math.abs(dispersionAt(1800, 300, 0.16, 0.08) / 419 - 1)).toBeLessThan(0.01);
    expect(Math.abs(dispersionAt(2400, 700, 0.18, 0.09) / 950 - 1)).toBeLessThan(0.01);
  });
  it("1/f² ist linear in t (R² > 0,9999)", () => {
    const xs = Array.from(c, (_, i) => (i / 63) * 0.22);
    const ys = Array.from(c, (f) => f ** -2);
    const mx = xs.reduce((a, b) => a + b) / xs.length;
    const my = ys.reduce((a, b) => a + b) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    xs.forEach((x, i) => {
      sxy += (x - mx) * (ys[i] - my);
      sxx += (x - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    });
    expect((sxy * sxy) / (sxx * syy)).toBeGreaterThan(0.9999);
  });
  it("RangeError bei fHi ≤ fLo", () => {
    expect(() => dispersionCurve(400, 400, 0.2)).toThrow(RangeError);
    expect(() => dispersionCurve(300, 400, 0.2)).toThrow(RangeError);
    expect(() => dispersionAt(300, 400, 0.2, 0.1)).toThrow(RangeError);
  });
});

describe("Pegelgesetz und Überblendung", () => {
  it("pulseAmp", () => {
    expect(pulseAmp(0.748)).toBe(1);
    expect(pulseAmp(4)).toBe(1);
    expect(Math.abs(pulseAmp(11.19) - 0.598)).toBeLessThan(0.002);
    expect(Math.abs(pulseAmp(173.7) - 0.1518)).toBeLessThan(0.001);
    for (const f of [4, 7.3, 29.67, 99, 173.7, 400]) expect(f * pulseAmp(f) ** 2).toBeCloseTo(4, 9);
  });
  it("crossfade gleiche Leistung", () => {
    for (let f = 10; f < 80; f += 0.7) {
      const { wc, wt } = crossfade(f);
      expect(wc * wc + wt * wt).toBeCloseTo(1, 12);
    }
    expect(crossfade(24).wc).toBeCloseTo(1, 12);
    expect(crossfade(24).wt).toBeCloseTo(0, 12);
    expect(crossfade(48).wc).toBeCloseTo(0, 12);
    expect(crossfade(48).wt).toBeCloseTo(1, 12);
    expect(crossfade(33.94).wc).toBeCloseTo(0.707, 3);
    expect(crossfade(33.94).wt).toBeCloseTo(0.707, 3);
  });
  it("heardAs an den Grenzen", () => {
    expect(heardAs(7.99)).toBe("clicks");
    expect(heardAs(8)).toBe("rattle");
    expect(heardAs(19.99)).toBe("rattle");
    expect(heardAs(20)).toBe("buzz");
    expect(heardAs(39.99)).toBe("buzz");
    expect(heardAs(40)).toBe("tone");
  });
  it("smootherCutoff", () => {
    expect(smootherCutoff(20)).toBeCloseTo(6000, 6);
    expect(smootherCutoff(174)).toBeCloseTo(2200, 6);
    expect(smootherCutoff(5)).toBe(6000);
    let prev = Infinity;
    for (let f = 1; f < 300; f += 1.3) {
      const c = smootherCutoff(f);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });
  it("noiseShare 0,30 → 0,05, log dazwischen", () => {
    expect(noiseShare(5)).toBeCloseTo(0.3, 9);
    expect(noiseShare(150)).toBeCloseTo(0.05, 9);
    expect(noiseShare(Math.sqrt(1000))).toBeCloseTo(Math.sqrt(0.3 * 0.05), 9);
  });
});

describe("Biquads (Web-Audio-Formeln)", () => {
  it("Bandpass-Spitze bei f₀ = 0 dB ±0,05", () => {
    for (const [f, q] of [
      [harmonic(6), 7],
      [harmonic(2), 2.8],
      [harmonic(16), 12],
    ]) {
      const c = biquadCoeffs("bandpass", f, q, SR);
      expect(Math.abs(db(biquadMagnitude(c, f, SR)))).toBeLessThan(0.05);
    }
  });
  it("Tiefpass Q −3,01 dB = Butterworth (−3 dB an der Grenze)", () => {
    const c = biquadCoeffs("lowpass", 1000, -3.01, SR);
    expect(db(biquadMagnitude(c, 1000, SR))).toBeCloseTo(-3.01, 1);
    expect(db(biquadMagnitude(c, 50, SR))).toBeCloseTo(0, 2);
  });
});

describe("Anregung und Vorrendern", () => {
  it("makeExcitation: 4 ms, e[0] = 1, abklingendes Rauschen", () => {
    const e = makeExcitation(SR, 0.3, mulberry32(1));
    expect(e.length).toBe(192);
    expect(e[0]).toBe(1);
    expect(rmsOf(e, 150, 192)).toBeLessThan(0.01);
    expect(excitationEnergy(e)).toBeGreaterThan(1);
    expect(excitationEnergy(e)).toBeLessThan(1.6);
  });
  it("renderResponse: Spitze 1, ≤ 2048 Samples", () => {
    const ex = makeExcitations(SR);
    for (const s of Object.values(BUFFER_SPECS)) {
      const y = renderResponse(ex[s.exc], s.spec, SR);
      expect(y.length).toBeLessThanOrEqual(2048);
      expect(peakOf(y)).toBeCloseTo(1, 6);
    }
  });
  it("progressBuffer wählt den nächsten Kern-Q", () => {
    expect(progressBuffer(0)).toBe("progress-q3");
    expect(progressBuffer(0.34)).toBe("progress-q6");
    expect(progressBuffer(0.66)).toBe("progress-q9");
    expect(progressBuffer(1)).toBe("progress-q12");
    expect(progressBuffer(Number.NaN)).toBe("progress-q3");
  });
});

describe("Tonschicht-Gain g_t", () => {
  it("Klickzug gegen Harmonischen-Summe bei 36 Hz durch BP 1042,21 Q 7: RMS ±1 dB", () => {
    const f = 36;
    const len = Math.round(0.25 * SR);
    const exc = makeExcitations(SR)["0.15"];
    const ke = excitationEnergy(exc);
    const a = pulseAmp(f);
    const clicks = renderClickTrain(f, SR, len, exc, a);
    // g_t ohne Überblendung (w_t herausgerechnet)
    const g = toneGain(f, SR, ke) / crossfade(f).wt;
    expect(g).toBeCloseTo(2 * a * (f / SR) * ke, 12);
    const tone = renderHarmonicTone(f, SR, len, g, 256);
    const bp = biquadCoeffs("bandpass", harmonic(6), 7, SR);
    const skip = Math.round(0.05 * SR);
    const rc = rmsOf(filterSignal(clicks, bp), skip);
    const rt = rmsOf(filterSignal(tone, bp), skip);
    expect(Math.abs(db(rt / rc))).toBeLessThan(1);
  });
  it("auch hinter dem ganzen radio-Resonator", () => {
    const f = 36;
    const len = Math.round(0.25 * SR);
    const exc = makeExcitations(SR)["0.15"];
    const ke = excitationEnergy(exc);
    const spec = timbreSpec("radio", { smootherHz: smootherCutoff(f) });
    const run = (x: Float32Array) => {
      const sum = new Float32Array(len);
      for (const b of spec.branches) {
        const y = filterSignal(x, biquadCoeffs(b.type, b.f, b.q, SR));
        const k = 10 ** (b.gainDb / 20);
        for (let i = 0; i < len; i++) sum[i] += k * y[i];
      }
      let out: Float32Array = sum;
      for (const p of spec.post) out = filterSignal(out, biquadCoeffs(p.type, p.f, p.q, SR));
      return out;
    };
    const rc = rmsOf(run(renderClickTrain(f, SR, len, exc, pulseAmp(f))), 2400);
    const rt = rmsOf(run(renderHarmonicTone(f, SR, len, toneGain(f, SR, ke) / crossfade(f).wt)), 2400);
    expect(Math.abs(db(rt / rc))).toBeLessThan(1);
  });
});

describe("Zufall", () => {
  it("mulberry32 deterministisch", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it("triangular ∈ [−1, 1], Mittel ≈ 0", () => {
    const r = mulberry32(7);
    let s = 0;
    for (let i = 0; i < 20000; i++) {
      const x = triangular(r);
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(1);
      s += x;
    }
    expect(Math.abs(s / 20000)).toBeLessThan(0.02);
  });
});

describe("RFI-Kalibrierung (Fehlerklang)", () => {
  it("PolyBLEP-Sägezahn: rfiPeak innerhalb von 5 % des additiven Werts, und schnell", () => {
    const sr = SR;
    let y = sawtoothAdditive(50, sr, Math.round(0.2 * sr));
    y = filterSignal(y, biquadCoeffs("bandpass", 300, 1.2, sr));
    y = filterSignal(y, biquadCoeffs("lowpass", 900, Q_BUTTER, sr));
    const ref = peakOf(y.subarray(Math.round(0.05 * sr)));
    const t0 = performance.now();
    const p = rfiPeak(sr);
    const ms = performance.now() - t0;
    expect(Math.abs(p / ref - 1)).toBeLessThan(0.05);
    expect(ms).toBeLessThan(20);
  });
  it("Sägezahn beginnt bei 0 und steigt (Phase wie Web Audio)", () => {
    const y = sawtooth(50, SR, 10);
    expect(Math.abs(y[0])).toBeLessThan(1e-6);
    expect(y[5]).toBeGreaterThan(y[1]);
  });
});
