/**
 * Leck-Check (P7.5): Passwort-Prüfung mit k-Anonymität und E-Mail-Prüfung mit eigenem
 * HIBP-Schlüssel. Der SHA-1-Wert entsteht hier im WebView; an die App (und weiter an HIBP)
 * gehen nur die ersten fünf Zeichen. Verglichen wird hier.
 */

export interface RangeEntry {
  readonly suffix: string;
  readonly count: number;
}

export interface Breach {
  readonly name: string;
  readonly title: string;
  readonly domain: string;
  readonly breachDate: string;
  readonly dataClasses: readonly string[];
  readonly verified: boolean;
}

export type EmailResult =
  | { readonly status: 'found'; readonly breaches: readonly Breach[] }
  | { readonly status: 'not_found' }
  | { readonly status: 'error'; readonly code: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const text = (v: unknown, max = 120): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** SHA-1 als Hex in Großbuchstaben (WebCrypto). */
export async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function parseRange(raw: unknown): RangeEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.slice(0, 4096).flatMap((e): RangeEntry[] => {
    if (!isObj(e) || typeof e.suffix !== 'string' || typeof e.count !== 'number') {
      return [];
    }
    return /^[0-9A-F]{35}$/.test(e.suffix) && e.count > 0
      ? [{ suffix: e.suffix, count: e.count }]
      : [];
  });
}

/**
 * Wie oft kam das Passwort in Lecks vor? `fetchRange` bekommt nur das Präfix.
 */
export async function pwnedCount(
  password: string,
  fetchRange: (prefix: string) => Promise<readonly RangeEntry[]>,
): Promise<number> {
  const hash = await sha1Hex(password);
  const entries = await fetchRange(hash.slice(0, 5));
  const suffix = hash.slice(5);
  return entries.find((e) => e.suffix === suffix)?.count ?? 0;
}

function breach(v: unknown): Breach | null {
  if (!isObj(v) || typeof v.name !== 'string') {
    return null;
  }
  return {
    name: text(v.name),
    title: text(v.title) || text(v.name),
    domain: text(v.domain),
    breachDate: text(v.breach_date, 10),
    dataClasses: Array.isArray(v.data_classes)
      ? v.data_classes
          .slice(0, 30)
          .map((d) => text(d, 60))
          .filter((d) => d !== '')
      : [],
    verified: v.verified === true,
  };
}

export function parseEmailResult(raw: unknown): EmailResult {
  if (!isObj(raw)) {
    return { status: 'error', code: 'bad_response' };
  }
  if (raw.status === 'found' && Array.isArray(raw.breaches)) {
    return {
      status: 'found',
      breaches: raw.breaches
        .slice(0, 500)
        .map(breach)
        .filter((b): b is Breach => b !== null),
    };
  }
  if (raw.status === 'not_found') {
    return { status: 'not_found' };
  }
  return { status: 'error', code: text(raw.code, 40) || 'bad_response' };
}

/** Fehlertext eines App-Befehls in eine bekannte Kennung übersetzen. */
export function leakErrorCode(error: unknown): string {
  const code = typeof error === 'string' ? error : '';
  return ['invalid_input', 'windows_only', 'unavailable', 'invalid_key', 'rate_limited'].includes(
    code,
  )
    ? code
    : 'unavailable';
}
