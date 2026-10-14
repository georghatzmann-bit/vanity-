import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings } from "../defaults";
import { mergeHistory } from "./history";
import { mergeIspLog } from "./isplog";
import { mergeLag } from "./lag";
import { mergeSonar } from "./sonar";

describe("Einstellungen der Netzwerk-Funktionen", () => {
  it("Standardwerte laut Vertrag", () => {
    const s = mergeSettings(null);
    expect(s.lag).toEqual({ snapshots: true });
    expect(s.sonar).toEqual({ volume: 0.5, pitch: true, alertInGame: false, alertVolume: 0.15 });
    expect(s.ispLog).toEqual({ slowMs: 100, contractDownMbps: null, contractUpMbps: null, contractDownNormalMbps: null, contractDownMinMbps: null });
    expect(s.history).toEqual({ record: true });
    expect(defaultSettings().sonar).toEqual(s.sonar);
  });
  it("ergänzt fehlende Felder und kappt Bereiche", () => {
    expect(mergeSonar({ volume: 3, alertVolume: 0.9 })).toEqual({ volume: 1, pitch: true, alertInGame: false, alertVolume: 0.3 });
    expect(mergeSonar({ volume: -1, alertVolume: 0.01, pitch: "ja" })).toEqual({ volume: 0, pitch: true, alertInGame: false, alertVolume: 0.05 });
    expect(mergeIspLog({ slowMs: 5, contractDownMbps: 500, contractUpMbps: 0, contractDownNormalMbps: 20_000, contractDownMinMbps: "abc" })).toEqual({
      slowMs: 30,
      contractDownMbps: 500,
      contractUpMbps: null,
      contractDownNormalMbps: 10_000,
      contractDownMinMbps: null,
    });
    expect(mergeIspLog({ slowMs: 5000 }).slowMs).toBe(1000);
    expect(mergeLag({ snapshots: false })).toEqual({ snapshots: false });
    expect(mergeLag("kaputt")).toEqual({ snapshots: true });
    expect(mergeHistory({ record: false })).toEqual({ record: false });
    expect(mergeHistory([])).toEqual({ record: true });
  });
  it("gespeicherte Teil-Einstellungen bleiben, der Rest wird ergänzt", () => {
    const s = mergeSettings({ ispLog: { contractDownMbps: 500 } } as never);
    expect(s.ispLog?.contractDownMbps).toBe(500);
    expect(s.ispLog?.slowMs).toBe(100);
    expect(s.sonar?.volume).toBe(0.5);
  });
});
