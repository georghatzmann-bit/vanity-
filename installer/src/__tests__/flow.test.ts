import { describe, expect, it } from "vitest";
import type { SetupInfo } from "../api";
import { advancePhaseClock, emptyPhaseClock, errorBackTarget, nextStepAfterIntro, phaseIndexOf, TIP_INTERVAL_MS, uninstallIndexOf, withPulsarSuffix } from "../flow/logic";

const base: SetupInfo = { mode: "install", setupVersion: "1.0.0", appName: "Pulsar", defaultDir: "C:\\Users\\a\\AppData\\Local\\Programs\\Pulsar", elevated: false, systemLang: "de", manifestUrl: "" };
const preset = { dir: "D:\\Spiele\\Pulsar", desktopShortcut: false, startMenu: true, autostart: true, launchAfter: false };

describe("nextStepAfterIntro (D.8)", () => {
  it("uninstall → un-confirm", () => {
    expect(nextStepAfterIntro({ ...base, mode: "uninstall" })).toEqual({ step: "un-confirm" });
  });

  it("update → sofort Installation im installierten Ordner", () => {
    const r = nextStepAfterIntro({ ...base, mode: "update", installed: { dir: "E:\\Pulsar", version: "0.9.0" } });
    expect(r.step).toBe("install");
    expect(r.start).toEqual({ dir: "E:\\Pulsar", desktopShortcut: true, startMenu: true, autostart: false, launchAfter: true });
  });

  it("update ohne installierten Ordner → Vorschlag", () => {
    expect(nextStepAfterIntro({ ...base, mode: "update" }).start?.dir).toBe(base.defaultDir);
  });

  it("Preset → Installation mit dem Preset", () => {
    expect(nextStepAfterIntro({ ...base, preset })).toEqual({ step: "install", start: preset });
  });

  it("maintenance → maintenance", () => {
    expect(nextStepAfterIntro({ ...base, mode: "maintenance", installed: { dir: "E:\\Pulsar", version: "0.9.0" } })).toEqual({ step: "maintenance" });
  });

  it("sonst welcome", () => {
    expect(nextStepAfterIntro(base)).toEqual({ step: "welcome" });
  });
});

describe("errorBackTarget", () => {
  it("disk/permission → folder, sonst options", () => {
    expect(errorBackTarget("disk")).toBe("folder");
    expect(errorBackTarget("permission")).toBe("folder");
    for (const c of ["network", "checksum", "manifest", "running", "cancelled", "unknown"] as const) expect(errorBackTarget(c)).toBe("options");
  });
});

describe("Hilfen des Ablaufs", () => {
  it("Tipps wechseln alle 8000 ms", () => {
    expect(TIP_INTERVAL_MS).toBe(8000);
  });

  it("Phasendauern im Client gemessen (Zeit zwischen Phasenwechseln)", () => {
    let c = emptyPhaseClock();
    c = advancePhaseClock(c, "connect", 1000);
    c = advancePhaseClock(c, "connect", 1200);
    expect(c.durations).toEqual({});
    c = advancePhaseClock(c, "download", 1400);
    expect(c.durations.connect).toBe(400);
    c = advancePhaseClock(c, "verify", 9400);
    c = advancePhaseClock(c, "done", 9900);
    expect(c.durations).toEqual({ connect: 400, download: 8000, verify: 500 });
    expect(advancePhaseClock(c, "done", 12000)).toBe(c);
  });

  it("Phasen- und Schrittindex", () => {
    expect(phaseIndexOf(null)).toBe(0);
    expect(phaseIndexOf({ phase: "verify", percent: 90, downloaded: 0, total: 0, speed: 0, eta: 0 })).toBe(2);
    expect(phaseIndexOf({ phase: "done", percent: 100, downloaded: 0, total: 0, speed: 0, eta: 0 })).toBe(6);
    expect(uninstallIndexOf(null)).toBe(-1);
    expect(uninstallIndexOf({ step: "files", percent: 60 })).toBe(3);
    expect(uninstallIndexOf({ step: "done", percent: 100 })).toBe(5);
  });

  it("Ordner aus dem Dialog bekommt \\Pulsar (wie bisher)", () => {
    expect(withPulsarSuffix("D:\\Games\\")).toBe("D:\\Games\\Pulsar");
    expect(withPulsarSuffix("D:\\Tools\\pulsar")).toBe("D:\\Tools\\pulsar");
  });
});
