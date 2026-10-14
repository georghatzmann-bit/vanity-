/** Kleine Helfer für die Einstellungs-Teile (fehlend oder falscher Typ → Standardwert). */
export const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
export const num = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
/** Zahl im Bereich oder null (null, leer, ≤ 0 oder ungültig → null) */
export const numOrNull = (v: unknown, min: number, max: number): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, Math.max(min, n));
};
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
