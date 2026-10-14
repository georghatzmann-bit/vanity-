/** Einstellungen `history` (Messverlauf): „Messverlauf dauerhaft speichern“. */
import type { HistorySettings } from "../types";
import { bool, obj } from "./clamp";

export const defaultHistory = (): HistorySettings => ({ record: true });

export function mergeHistory(stored: unknown): HistorySettings {
  const s = obj(stored);
  return { record: bool(s.record, defaultHistory().record) };
}
