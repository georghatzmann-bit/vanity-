import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { F_STAR } from "@shared/sound/dsp";
import { sceneFor, driveFromFreq } from "../../components/StarCanvas";
import { driveLabelKey, heardLine, cameraParts } from "../../components/Schirm";
import { needleX } from "../../components/LogScale";
import { decayBeamAlpha, relockCurve, voiceModes, UNINSTALL_TIMING, DONE_TIMING } from "../../hooks/useObservatory";
import { judgeWindow, p95, qualityConfig, reportFrame, getQuality, _resetQualityForTests, WINDOW_FRAMES } from "../../hooks/useQuality";
import { LOGO_PHASE, markMorph, MARK_PARAMS, STAR_PARAMS } from "../../obs/star";
import { setLang, t } from "../../i18n";

describe("sceneFor – Belichtungskamera (F.3)", () => {
  it("Leerlauf B1919: 1/60 s, scharfer Strahl, Blitzen erlaubt", () => {
    const s = sceneFor("idle", 0, 3.2, 0.748, false);
    expect(s.width).toBeCloseTo(0.748 / 60, 6);
    expect(s.sharp).toBe(3.2);
    expect(s.disc).toBe("flash");
    expect(s.camera).toBe("exposure");
    expect(s.expAlpha).toBeCloseTo(0.16, 2);
  });
  it("ab 2,5 Hz Sanduhr (2 Umdrehungen), ruhige Scheibe statt Blitz", () => {
    const s = sceneFor("installing", 0, 10.3, 11.19, false);
    expect(s.width).toBe(2);
    expect(s.sharp).toBeNull();
    expect(s.disc).toBe("steady");
    expect(s.blur).toBeCloseTo(0.2, 6);
  });
  it("Fehler: gestrichelt, 0,4, Belichtung × 0,3, keine Kappen, keine Scheibe", () => {
    const ok = sceneFor("installing", 0, 1, 0.748, false);
    const s = sceneFor("error", 0, 1, 0.748, false);
    expect(s.dashed).toBe(true);
    expect(s.beamAlpha).toBe(0.4);
    expect(s.expAlpha).toBeCloseTo(ok.expAlpha * 0.3, 6);
    expect(s.fieldMul).toBeCloseTo(0.3, 6);
    expect(s.caps).toBe(false);
    expect(s.disc).toBe("none");
  });
  it("Angehalten: Strahlen 0,5", () => {
    expect(sceneFor("halted", 0, 1, 0.8, false).beamAlpha).toBe(0.5);
  });
  it("reduzierte Bewegung: Logo-Phase, Standbild, kein Blitz", () => {
    const s = sceneFor("installing", 0, 7.83, 30, true);
    expect(s.phi).toBe(7 + LOGO_PHASE);
    expect(s.width).toBe(0);
    expect(s.disc).toBe("none");
    expect(s.camera).toBe("still");
  });
  it("Stroboskop: Fenster um ⌊φ⌋ + 0,5 schrumpft in 800 ms von 2 auf 0, danach markMorph", () => {
    const a = sceneFor("strobe", 0, 42.13, F_STAR, false);
    expect(a.width).toBeCloseTo(2, 6);
    expect((a.from + a.to) / 2).toBeCloseTo(42.5, 9);
    expect(a.camera).toBe("strobe");
    const b = sceneFor("strobe", DONE_TIMING.strobeMs, 42.9, F_STAR, false);
    expect(b.width).toBeCloseTo(0, 9);
    expect(b.sharp).toBe(42.5);
    const c = sceneFor("strobe", DONE_TIMING.morphEndMs, 43.4, F_STAR, false);
    expect(c.morph?.raySplit).toBeCloseTo(1, 6);
  });
  it("Zeichen (installiert) = markMorph(1); Deinstallieren rückwärts 1 → 0, dann Stroboskop öffnet", () => {
    expect(sceneFor("installed", 0, 0, F_STAR, false).morph).toEqual(markMorph(1));
    expect(sceneFor("release", 0, 5, F_STAR, false).morph?.raySplit).toBeCloseTo(MARK_PARAMS.raySplit, 6);
    expect(sceneFor("release", UNINSTALL_TIMING.morphMs - 1e-6, 5, F_STAR, false).morph?.ringR).toBeCloseTo(STAR_PARAMS.ringR, 3);
    const open = sceneFor("release", UNINSTALL_TIMING.morphMs + UNINSTALL_TIMING.strobeOpenMs, 5, F_STAR, false);
    expect(open.morph).toBeNull();
    expect(open.width).toBeCloseTo(2, 6);
  });
  it("Zerfall: Strahlen 1 → 0,6 → 0,3 → 0, Bayer ab t_d + 500 bis + 2000; Verlust = nur Rauschen", () => {
    expect(decayBeamAlpha(-1)).toBe(1);
    expect(decayBeamAlpha(10)).toBe(0.6);
    expect(decayBeamAlpha(1400)).toBe(0.3);
    expect(decayBeamAlpha(2700)).toBe(0);
    expect(sceneFor("decay", 400, 1, 0.5, false).bayer).toBe(-1);
    expect(sceneFor("decay", 1250, 1, 0.5, false).bayer).toBe(8);
    expect(sceneFor("decay", 2000, 1, 0.5, false).bayer).toBe(16);
    expect(sceneFor("lost", 0, 1, 0.5, false).noiseOnly).toBe(true);
    expect(sceneFor("decay", 0, 1, 0.5, true).noiseOnly).toBe(true);
  });
  it("Feldlinien beim Deinstallieren × (0,4 + 0,6·x)", () => {
    expect(driveFromFreq(F_STAR)).toBeCloseTo(1, 6);
    expect(driveFromFreq(1 / 1.3373)).toBeCloseTo(0, 6);
    expect(sceneFor("uninstalling", 0, 0, 1 / 1.3373, false).fieldMul).toBeCloseTo(0.4, 6);
    expect(sceneFor("uninstalling", 0, 0, F_STAR, false).fieldMul).toBeCloseTo(1, 6);
  });
  it("Blitzschutz: über 2,5 Hz blitzt nichts", () => {
    for (const f of [2.6, 5, 11.19, 29.67, F_STAR]) expect(sceneFor("installing", 0, 0, f, false).disc).not.toBe("flash");
  });
});

describe("Schirm-Texte (C.2)", () => {
  // setLang schreibt <html lang>; in node reicht ein Platzhalter
  beforeEach(() => vi.stubGlobal("document", { documentElement: {} }));
  afterEach(() => {
    setLang("de");
    vi.unstubAllGlobals();
  });
  it("rechte Referenzseite je Zustand", () => {
    expect(driveLabelKey("idle")).toBe("obs.idle");
    expect(driveLabelKey("installing")).toBe("obs.drive");
    expect(driveLabelKey("uninstalling")).toBe("obs.driveDown");
    expect(driveLabelKey("installed")).toBe("obs.installed");
    expect(driveLabelKey("lost")).toBe("obs.lost");
  });
  it("Hörbar als / lautlos / Ton aus", () => {
    setLang("de");
    expect(heardLine(t, "installing", "rattle", false)).toBe("Hörbar als · Knattern");
    expect(heardLine(t, "idle", null, false)).toBe("Leerlauf · lautlos");
    expect(heardLine(t, "installed", null, true)).toBe("Hörbar als · lautlos · Ton aus");
    expect(heardLine(t, "strobe", "chord", false)).toBe("Hörbar als · Akkord");
  });
  it("Kamera-Label: Einheit getrennt (nicht versal)", () => {
    setLang("de");
    expect(cameraParts(t, "exposure", 0.748, "de")).toEqual(["Belichtung ", "1/60 s", ""]);
    expect(cameraParts(t, "exposure", 11.19, "de")[1]).toBe("2 · P");
    expect(cameraParts(t, "strobe", F_STAR, "de")).toEqual(["Strobo ", "173,7 Hz", " · Phase 180°"]);
    expect(cameraParts(t, "still", 1, "de")[0]).toBe("Standbild");
    setLang("en");
    expect(cameraParts(t, "strobe", F_STAR, "en")).toEqual(["Strobe ", "173.7 Hz", " · phase 180°"]);
  });
  it("Log-Skala: Nadel x(P) = 24 + 93·log10(P/1 ms), begrenzt", () => {
    expect(needleX(1.3373)).toBeCloseTo(314.7, 1);
    expect(needleX(0.005757)).toBeCloseTo(94.7, 1);
    expect(needleX(50)).toBe(396);
    expect(needleX(0.0001)).toBe(24);
    expect(needleX(Infinity)).toBe(396);
  });
});

describe("Observatorium (rein)", () => {
  it("Fortsetzen: Rauschbett-Kurve 1800 → 1042,21 Hz, fallend", () => {
    const c = relockCurve();
    expect(c[0]).toBeCloseTo(1800, 3);
    expect(c[c.length - 1]).toBeCloseTo(1042.21, 1);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeLessThan(c[i - 1]);
  });
  it("Stimme nur in Installation, Fortsetzen, Abbruch-Ausklang und Deinstallation", () => {
    expect(voiceModes("installing")).toBe(true);
    expect(voiceModes("uninstalling")).toBe(true);
    expect(voiceModes("idle")).toBe(false);
    expect(voiceModes("installed")).toBe(false);
    expect(voiceModes("lost")).toBe(false);
  });
});

describe("Qualitätsstufen (H)", () => {
  afterEach(() => _resetQualityForTests());
  it("Tabelle L2/L1/L0", () => {
    expect(qualityConfig(2, 3)).toMatchObject({ fps: 60, dprSchirm: 2, dprIntro: 1.25, samples: 60, fieldLines: 12, gridPoints: 48 });
    expect(qualityConfig(1, 3)).toMatchObject({ fps: 30, dprSchirm: 1.5, dprIntro: 1, samples: 30, fieldLines: 6, gridPoints: 24 });
    expect(qualityConfig(0, 3)).toMatchObject({ fps: 15, dprSchirm: 1, samples: 12, fieldFrontOnly: true, meridians: false, noiseTiles: false });
    expect(qualityConfig(2, 1).dprSchirm).toBe(1);
  });
  it("p95 und Urteil: nur herunter, nie herauf", () => {
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    const ok = Array(60).fill(4);
    expect(judgeWindow(2, ok, Array(60).fill(16.7))).toBe(2);
    expect(judgeWindow(2, Array(60).fill(9), Array(60).fill(16.7))).toBe(1);
    expect(judgeWindow(1, ok, Array(60).fill(40))).toBe(0);
    expect(judgeWindow(0, Array(60).fill(99), Array(60).fill(99))).toBe(0);
  });
  it("reportFrame stuft nach vollem Fenster ab; erzwungene Stufe bleibt", () => {
    _resetQualityForTests(2, true);
    for (let i = 0; i < WINDOW_FRAMES; i++) reportFrame(12, 16.7);
    expect(getQuality()).toBe(1);
    _resetQualityForTests(2, false);
    for (let i = 0; i < WINDOW_FRAMES; i++) reportFrame(12, 16.7);
    expect(getQuality()).toBe(2);
  });
});
