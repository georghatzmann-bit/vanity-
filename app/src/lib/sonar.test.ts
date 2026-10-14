import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings } from "./defaults";
import { isLiveSpike, PING_GRADE_LIMITS } from "./grade";
import fixtures from "./fixtures/spikes.json";
import {
  SONAR_ACCENT,
  SONAR_ALERT_GAP_MS,
  alertDecision,
  emptyAlertMemo,
  sonarAlertLevel,
  sonarGain,
  sonarJitter,
  sonarParams,
  sonarPreviewSeries,
  sonarStep,
  SONAR_PREVIEWS,
} from "./sonar";
import type { Settings } from "./types";

const base = (): Settings => defaultSettings();
const steady = (n: number, v = 24) => Array.from({ length: n }, (_, i) => v + (i % 3));

describe("Tonstufen (gleiche Grenzen wie pingGrade)", () => {
  it("an allen Grenzen", () => {
    expect(PING_GRADE_LIMITS).toEqual([20, 35, 60, 100, 180]);
    const cases: [number, number][] = [
      [0, 5],
      [19.9, 5],
      [20, 4],
      [34.9, 4],
      [35, 3],
      [59.9, 3],
      [60, 2],
      [99.9, 2],
      [100, 1],
      [179.9, 1],
      [180, 0],
      [900, 0],
    ];
    for (const [rtt, step] of cases) expect(sonarStep(rtt), `${rtt} ms`).toBe(step);
    // jede Grenze: knapp darunter eine Stufe heller als genau darauf
    PING_GRADE_LIMITS.forEach((limit) => expect(sonarStep(limit - 0.1)).toBe(sonarStep(limit) + 1));
  });

  it("Tonhöhe aus → keine Stufe", () => {
    const s = { ...base(), sonar: { ...base().sonar!, pitch: false } };
    expect(sonarParams({ rtt: 12 }, [12], null, s).step).toBeNull();
    expect(sonarParams({ rtt: 12 }, [12], null, base()).step).toBe(5);
  });
});

describe("Zittern", () => {
  it("Kappung 0 / 15 → 0,5 / ≥ 30 → 1", () => {
    expect(sonarJitter(0)).toBe(0);
    expect(sonarJitter(15)).toBe(0.5);
    expect(sonarJitter(30)).toBe(1);
    expect(sonarJitter(120)).toBe(1);
    expect(sonarJitter(-3)).toBe(0);
    expect(sonarJitter(null)).toBe(0);
    expect(sonarJitter(Number.NaN)).toBe(0);
    expect(sonarParams({ rtt: 30 }, [30], { jitter: 15 }, base()).jitter).toBe(0.5);
  });
});

describe("Takt, Verlust, Ausreißer", () => {
  it("Periode = Messabstand (250–10 000 ms)", () => {
    expect(sonarParams({ rtt: 30 }, [30], null, { ...base(), pingIntervalMs: 1000 }).periodMs).toBe(1000);
    expect(sonarParams({ rtt: 30 }, [30], null, { ...base(), pingIntervalMs: 100 }).periodMs).toBe(250);
    expect(sonarParams({ rtt: 30 }, [30], null, { ...base(), pingIntervalMs: 60_000 }).periodMs).toBe(10_000);
  });

  it("Verlust → Aussetzer, ohne Betonung und ohne Stufe", () => {
    const window = [...steady(30), null];
    const p = sonarParams({ rtt: null }, window, { jitter: 2 }, base());
    expect(p.drop).toBe(true);
    expect(p.accent).toBe(false);
    expect(p.step).toBeNull();
  });

  it("Ausreißer über isLiveSpike → Betonung (Faktor 1,5)", () => {
    expect(SONAR_ACCENT).toBe(1.5);
    const window = [...steady(30), 160];
    expect(isLiveSpike(window)).toBe(true);
    const p = sonarParams({ rtt: 160 }, window, { jitter: 4 }, base());
    expect(p.accent).toBe(true);
    expect(p.drop).toBe(false);
    // normaler Wert: keine Betonung
    expect(sonarParams({ rtt: 25 }, [...steady(30), 25], null, base()).accent).toBe(false);
    // unter 10 Antworten: nie bewertet
    expect(sonarParams({ rtt: 160 }, [...steady(5), 160], null, base()).accent).toBe(false);
  });

  it.each(fixtures.live.map((c) => [c.name, c] as const))("gleiche Prüfdaten wie das Backend: %s", (_n, c) => {
    const last = c.window[c.window.length - 1] ?? null;
    expect(sonarParams({ rtt: last }, c.window, null, base()).accent).toBe(c.spike);
  });
});

describe("Lautstärke", () => {
  it("sonar.volume, stumm bei sound = false oder Gesamtlautstärke 0", () => {
    expect(sonarGain(base())).toBe(0.5);
    expect(sonarParams({ rtt: 20 }, [20], null, base()).gain).toBe(0.5);
    expect(sonarGain({ ...base(), sound: false })).toBe(0);
    expect(sonarParams({ rtt: 20 }, [20], null, { ...base(), sound: false }).gain).toBe(0);
    expect(sonarGain({ ...base(), volume: 0 })).toBe(0);
    expect(sonarGain({ ...base(), sonar: { ...base().sonar!, volume: 0.8 } })).toBe(0.8);
    // fehlende/fehlerhafte Einstellungen → Standard bzw. gekappt
    expect(sonarGain({ ...base(), sonar: undefined })).toBe(0.5);
    expect(sonarGain({ ...base(), sonar: { ...base().sonar!, volume: 7 } })).toBe(1);
  });
});

describe("Warnton im Spiel", () => {
  const ev = (at: number) => ({ targetId: "aws-eu-central-1", at });
  const on = { ...base(), sonar: { ...base().sonar!, alertInGame: true } };

  it("standardmäßig aus", () => {
    expect(base().sonar?.alertInGame).toBe(false);
    expect(alertDecision(ev(1), emptyAlertMemo(), { settings: base(), gameRunning: true, now: 1000 }).play).toBe(false);
  });

  it("nur mit laufendem Spiel", () => {
    expect(alertDecision(ev(1), emptyAlertMemo(), { settings: on, gameRunning: false, now: 1000 }).play).toBe(false);
    expect(alertDecision(ev(1), emptyAlertMemo(), { settings: on, gameRunning: true, now: 1000 }).play).toBe(true);
  });

  it("höchstens alle 10 s", () => {
    expect(SONAR_ALERT_GAP_MS).toBe(10_000);
    let memo = emptyAlertMemo();
    let r = alertDecision(ev(1), memo, { settings: on, gameRunning: true, now: 100_000 });
    expect(r.play).toBe(true);
    memo = r.memo;
    r = alertDecision(ev(2), memo, { settings: on, gameRunning: true, now: 109_999 });
    expect(r.play).toBe(false);
    memo = r.memo;
    r = alertDecision(ev(3), memo, { settings: on, gameRunning: true, now: 110_000 });
    expect(r.play).toBe(true);
  });

  it("nicht bei der count-Aktualisierung (gleiches at + targetId)", () => {
    const first = alertDecision(ev(5), emptyAlertMemo(), { settings: on, gameRunning: true, now: 1000 });
    expect(first.play).toBe(true);
    const update = alertDecision(ev(5), first.memo, { settings: on, gameRunning: true, now: 50_000 });
    expect(update.play).toBe(false);
    // auch wenn die erste Meldung still blieb (kein Spiel), spielt die Aktualisierung nicht nach
    const quiet = alertDecision(ev(9), emptyAlertMemo(), { settings: on, gameRunning: false, now: 1000 });
    expect(alertDecision(ev(9), quiet.memo, { settings: on, gameRunning: true, now: 20_000 }).play).toBe(false);
    // anderes Ziel, gleiche Zeit → eigener Ausreißer
    expect(alertDecision({ targetId: "x", at: 5 }, first.memo, { settings: on, gameRunning: true, now: 50_000 }).play).toBe(true);
  });

  it("Pegelgrenzen 0,05–0,3", () => {
    expect(sonarAlertLevel(base())).toBe(0.15);
    expect(sonarAlertLevel({ sonar: { ...base().sonar!, alertVolume: 0.01 } })).toBe(0.05);
    expect(sonarAlertLevel({ sonar: { ...base().sonar!, alertVolume: 0.9 } })).toBe(0.3);
    expect(sonarAlertLevel({ sonar: undefined })).toBe(0.15);
  });
});

describe("Einstellungen und Probe", () => {
  it("mergeSettings ergänzt/kappt sonar", () => {
    expect(mergeSettings({}).sonar).toEqual({ volume: 0.5, pitch: true, alertInGame: false, alertVolume: 0.15 });
    expect(mergeSettings({ sonar: { volume: 2, pitch: false, alertInGame: true, alertVolume: 0 } } as never).sonar).toEqual({ volume: 1, pitch: false, alertInGame: true, alertVolume: 0.05 });
  });

  it("Probe-Werte: 8 Messungen, Verlust mit Lücken, Schwankung stolpert, Warnton mit Ausreißer", () => {
    for (const k of SONAR_PREVIEWS) expect(sonarPreviewSeries(k).rtts.length).toBe(8);
    expect(sonarPreviewSeries("stable").rtts.every((v) => v !== null)).toBe(true);
    expect(sonarJitter(sonarPreviewSeries("stable").jitterMs)).toBeLessThan(0.05);
    expect(sonarJitter(sonarPreviewSeries("unstable").jitterMs)).toBeGreaterThan(0.7);
    expect(sonarPreviewSeries("loss").rtts.filter((v) => v === null).length).toBeGreaterThanOrEqual(2);
    const a = sonarPreviewSeries("alert");
    const i = a.rtts.findIndex((v) => v !== null && v > 100);
    expect(isLiveSpike([...a.history, ...a.rtts.slice(0, i + 1)])).toBe(true);
  });
});
