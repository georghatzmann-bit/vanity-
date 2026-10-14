import { describe, expect, it } from "vitest";
import type { SetupInfo } from "../api";
import { advancePhaseClock, emptyPhaseClock, errorBackTarget, nextStepAfterIntro, phaseIndexOf, TIP_INTERVAL_MS, uninstallIndexOf, withPulsarSuffix } from "../flow/logic";
import { acceptResumeProgress, ANNOUNCE_MIN_GAP_MS, emptyAnnounce, installLog, invalidDisk, isAlreadyRunning, nextAnnouncement } from "../flow/logic";
import { emptyTally, isDownloadRestart, pausePhaseClock, tallyDownload, tallyRunStart, tallyTransferred, UNDONE_DELAY_MS } from "../flow/logic";
import { PULSE_LEAD_S, UNINSTALL_TIMING } from "../hooks/useObservatory";

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

  it("Nach Fehler + Fortsetzen addieren sich die Dauern, die Wartezeit zählt nicht", () => {
    let c = emptyPhaseClock();
    c = advancePhaseClock(c, "connect", 0);
    c = advancePhaseClock(c, "download", 500);
    c = pausePhaseClock(c, 4500); // Fehler: 4 s Download
    c = advancePhaseClock(c, "download", 60_000); // „Erneut versuchen“ eine Minute später
    c = advancePhaseClock(c, "verify", 63_000);
    expect(c.durations).toEqual({ connect: 500, download: 7000 });
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

describe("Fortsetzen ohne Rücksprung (40 → 0 → 40 %)", () => {
  it("nur connect wird verworfen; ein Neustart bei 0 wird übernommen (kein Einfrieren)", () => {
    expect(acceptResumeProgress({ phase: "connect" })).toBe(false);
    expect(acceptResumeProgress({ phase: "download" })).toBe(true);
    expect(acceptResumeProgress({ phase: "verify" })).toBe(true);
  });
  it("Neustart des Servers = deutlich unter dem letzten Stand; kleine Rücksprünge = Fortsetzen", () => {
    expect(isDownloadRestart(5_000_000, 300_000)).toBe(true);
    expect(isDownloadRestart(5_000_000, 4_900_000)).toBe(false);
    expect(isDownloadRestart(0, 0)).toBe(false);
  });
  it("„läuft bereits“ des Backends ist kein Fehler", () => {
    expect(isAlreadyRunning("Die Installation läuft bereits.")).toBe(true);
    expect(isAlreadyRunning("The installation is already running.")).toBe(true);
    expect(isAlreadyRunning("Zugriff verweigert")).toBe(false);
  });
  it("gescheiterte Platzabfrage = ungültig (sperrt „Weiter“)", () => {
    const d = invalidDisk("x", "kaputt");
    expect(d.valid).toBe(false);
    expect(d.message).toBe("kaputt");
  });
});

describe("Ansagen (H): Phasenwechsel und 25-%-Schritte, mindestens 5 s Abstand", () => {
  it("nicht jede 10 %, nicht schneller als alle 5 s", () => {
    let st = emptyAnnounce();
    const a = nextAnnouncement(st, { phase: "download", percent: 3 }, 0);
    expect(a).not.toBeNull();
    st = a!;
    expect(nextAnnouncement(st, { phase: "download", percent: 20 }, 6000)).toBeNull(); // gleiches Viertel
    expect(nextAnnouncement(st, { phase: "download", percent: 26 }, 1000)).toBeNull(); // zu früh
    expect(nextAnnouncement(st, { phase: "download", percent: 26 }, ANNOUNCE_MIN_GAP_MS)).not.toBeNull();
    expect(nextAnnouncement(st, { phase: "done", percent: 100 }, 99999)).toBeNull();
  });
});

describe("Protokoll auf „Fertig“", () => {
  it("Gesamtdauer = Summe der Phasen, Rate = Bytes / Downloaddauer", () => {
    const log = installLog({ connect: 500, download: 10_000, verify: 400, install: 450 }, 11_800_000, 11_800_000);
    expect(log.resumed).toBe(false);
    expect(log.totalMs).toBe(11_350);
    expect(log.bytes).toBe(11_800_000);
    expect(log.rate).toBeCloseTo(1_180_000, 0);
  });
  it("ohne Messung keine erfundenen Werte", () => {
    expect(installLog({}, 0)).toEqual({ totalMs: null, bytes: null, rate: null, resumed: false });
  });
  it("nach dem Fortsetzen: übertragen = wirklich geladene Bytes (nicht die Dateigröße), Rate daraus", () => {
    const total = 11_800_000;
    let t = tallyRunStart(emptyTally(), true);
    for (const d of [300_000, 2_000_000, 5_000_000]) t = tallyDownload(t, d); // Lauf 1 bis Fehler
    t = tallyRunStart(t, false); // „Erneut versuchen“
    for (const d of [5_000_000, 8_000_000, total]) t = tallyDownload(t, d); // Fortsetzen ab 5 MB
    expect(tallyTransferred(t)).toBe(total); // ganzer Download über beide Läufe
    // Nur der zweite Lauf zählt, wenn der erste in einer früheren Sitzung lief:
    let u = tallyRunStart({ ...emptyTally(), fresh: false, last: 5_000_000 }, false);
    for (const d of [5_000_000, 9_000_000, total]) u = tallyDownload(u, d);
    const moved = tallyTransferred(u)!;
    expect(moved).toBe(total - 5_000_000);
    const log = installLog({ download: 4000 }, moved, total);
    expect(log.bytes).not.toBe(total);
    expect(log.bytes).toBe(6_800_000);
    expect(log.rate).toBeCloseTo(1_700_000, 0);
    expect(log.resumed).toBe(true);
  });
  it("Neustart des Servers nach dem Fortsetzen: beide Läufe zählen", () => {
    let t = tallyRunStart(emptyTally(), true);
    t = tallyDownload(t, 4_000_000);
    t = tallyRunStart(t, false);
    t = tallyDownload(t, 200_000); // Server beginnt bei 0
    t = tallyDownload(t, 11_800_000);
    expect(tallyTransferred(t)).toBe(4_000_000 + 11_800_000);
  });
});

describe("Deinstallation fertig", () => {
  it("„Signal verloren.“ erscheint erst nach dem Zerfall im Schirm", () => {
    expect(UNDONE_DELAY_MS).toBeGreaterThanOrEqual(UNINSTALL_TIMING.decayToMs + PULSE_LEAD_S * 1000);
  });
});
