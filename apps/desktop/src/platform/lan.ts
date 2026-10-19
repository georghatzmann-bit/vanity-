/**
 * Heimnetz-Scanner (P7.4): Typen und Parser für das Ergebnis von `home_network_scan`.
 * Der Scan läuft in der App (Rust) nur im eigenen privaten Subnetz und verändert nichts.
 */

export interface LanDevice {
  readonly ip: string;
  readonly mac: string | null;
  readonly privateMac: boolean;
  readonly gateway: boolean;
  readonly thisDevice: boolean;
  readonly rttMs: number | null;
  readonly openPorts: readonly number[];
}

export interface WifiInfo {
  readonly ssid: string;
  readonly security: string;
  readonly tkip: boolean;
}

export type LanSeverity = 'info' | 'warn' | 'danger';

export interface LanHint {
  readonly id: string;
  readonly severity: LanSeverity;
  readonly target: string | null;
}

export interface LanReport {
  readonly available: boolean;
  readonly reason: string | null;
  readonly network: string | null;
  readonly address: string | null;
  readonly gateway: string | null;
  readonly scanned: number;
  readonly limited: boolean;
  readonly devices: readonly LanDevice[];
  readonly wifi: readonly WifiInfo[];
  readonly upnp: boolean | null;
  readonly hints: readonly LanHint[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' ? v.slice(0, max) : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const list = <T>(v: unknown, f: (x: unknown) => T | null, max: number): T[] =>
  Array.isArray(v)
    ? v
        .slice(0, max)
        .map(f)
        .filter((x): x is T => x !== null)
    : [];

function device(v: unknown): LanDevice | null {
  if (!isObj(v)) {
    return null;
  }
  const ip = str(v.ip, 15);
  if (ip === null) {
    return null;
  }
  return {
    ip,
    mac: str(v.mac, 17),
    privateMac: v.private_mac === true,
    gateway: v.gateway === true,
    thisDevice: v.this_device === true,
    rttMs: num(v.rtt_ms),
    openPorts: list(
      v.open_ports,
      (p) => (num(p) !== null && Number(p) <= 65535 ? Number(p) : null),
      32,
    ),
  };
}

function wifi(v: unknown): WifiInfo | null {
  if (!isObj(v)) {
    return null;
  }
  const ssid = str(v.ssid, 32);
  const security = str(v.security, 20);
  return ssid === null || security === null ? null : { ssid, security, tkip: v.tkip === true };
}

function hint(v: unknown): LanHint | null {
  if (!isObj(v)) {
    return null;
  }
  const id = str(v.id, 40);
  const severity = v.severity;
  if (id === null || (severity !== 'info' && severity !== 'warn' && severity !== 'danger')) {
    return null;
  }
  return { id, severity, target: str(v.target, 64) };
}

/** Liest das Ergebnis tolerant; Unbrauchbares wird verworfen. */
export function parseLanReport(raw: unknown): LanReport {
  const o = isObj(raw) ? raw : {};
  return {
    available: o.available === true,
    reason: str(o.reason, 40),
    network: str(o.network, 20),
    address: str(o.address, 15),
    gateway: str(o.gateway, 15),
    scanned: num(o.scanned) ?? 0,
    limited: o.limited === true,
    devices: list(o.devices, device, 1024),
    wifi: list(o.wifi, wifi, 8),
    upnp: typeof o.upnp === 'boolean' ? o.upnp : null,
    hints: list(o.hints, hint, 200),
  };
}

/** Schlüssel eines Geräts für „neu seit dem letzten Scan“ (MAC, sonst Adresse). */
export function deviceKey(d: LanDevice): string {
  return d.mac ?? d.ip;
}

const KNOWN_KEY = 'aegis.lan.known';

/** Bekannte Geräte (nur auf diesem PC, im WebView-Speicher). */
export function loadKnownDevices(storage: Pick<Storage, 'getItem'> | null): Set<string> | null {
  try {
    const raw = storage?.getItem(KNOWN_KEY);
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return new Set(list(parsed, (x) => str(x, 17), 2048));
  } catch {
    return null;
  }
}

export function saveKnownDevices(
  storage: Pick<Storage, 'setItem'> | null,
  keys: Iterable<string>,
): void {
  try {
    storage?.setItem(KNOWN_KEY, JSON.stringify([...keys].slice(0, 2048)));
  } catch {
    // Kein Speicher (privat/voll): „neu“ wird dann nur nicht gemerkt.
  }
}
