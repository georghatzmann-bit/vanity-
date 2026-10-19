/** Zeitpunkt als Date, Epoch-Millisekunden oder RFC-3339-Text (wie aus `aegis-core`). */
export type TimeInput = Date | number | string;

/** Größter darstellbarer Zeitpunkt eines `Date` (±100 Mio. Tage um 1970, ECMAScript). */
export const MAX_DATE_MS = 8.64e15;

/**
 * Wandelt einen Zeitpunkt in Epoch-Millisekunden; ungültige Angaben ergeben `NaN` – auch
 * endliche Zahlen außerhalb des Date-Bereichs (sonst würfe z. B. `toISOString()` beim
 * Anzeigen). `±Infinity` bleibt erhalten (offene Grenze, z. B. „keine Frist“).
 */
export function toEpochMs(value: TimeInput): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) > MAX_DATE_MS ? Number.NaN : value;
  }
  if (typeof value === 'string') {
    return Date.parse(value);
  }
  return value.getTime();
}

/** Aktuelle Zeit (Modul-Funktion, damit Komponenten sie als lazy Initialisierer nutzen). */
export function readNow(): number {
  return Date.now();
}

/**
 * Restzeit als Uhr: `9:41`, `0:05`, `1:02:03`. Negative Werte ergeben `0:00`; es wird auf
 * ganze Sekunden aufgerundet, damit `0:00` erst beim Ablauf erscheint.
 */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** Restzeit in Sekunden mit einer Nachkommastelle, z. B. `1,5 s` (deutsch). */
export function formatSecondsShort(ms: number, locale = 'de-DE'): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 100) / 10) : 0;
  return `${seconds.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** Größte Verzögerung, die setTimeout zuverlässig verarbeitet (≈ 24,8 Tage). */
export const MAX_TIMEOUT_MS = 2_147_483_647;
