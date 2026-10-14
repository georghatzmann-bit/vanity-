/** Einstellungen `ispLog` (Anbieter-Protokoll): slowMs 30–1000, Vertragswerte 1–10 000 Mbit/s oder null. */
import type { IspLogSettings } from "../types";
import { num, numOrNull, obj } from "./clamp";

export const defaultIspLog = (): IspLogSettings => ({ slowMs: 100, contractDownMbps: null, contractUpMbps: null, contractDownNormalMbps: null, contractDownMinMbps: null });

export function mergeIspLog(stored: unknown): IspLogSettings {
  const s = obj(stored);
  const d = defaultIspLog();
  const mbps = (v: unknown) => numOrNull(v, 1, 10_000);
  return {
    slowMs: Math.round(num(s.slowMs, d.slowMs, 30, 1000)),
    contractDownMbps: mbps(s.contractDownMbps),
    contractUpMbps: mbps(s.contractUpMbps),
    contractDownNormalMbps: mbps(s.contractDownNormalMbps),
    contractDownMinMbps: mbps(s.contractDownMinMbps),
  };
}
