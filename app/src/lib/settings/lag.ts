/** Einstellungen `lag` (Lag-Detektiv): Standardwerte und Ergänzung in `mergeSettings`. */
import type { LagSettings } from "../types";
import { bool, obj } from "./clamp";

export const defaultLag = (): LagSettings => ({ snapshots: true });

export function mergeLag(stored: unknown): LagSettings {
  const s = obj(stored);
  const d = defaultLag();
  return { snapshots: bool(s.snapshots, d.snapshots) };
}
