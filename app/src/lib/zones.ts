/**
 * Zonenregel der Teilroute (gleiche Regel wie `quickhops::zones` im Backend, Prüfdaten
 * ./fixtures/zones.json): ordnet Stationen in TTL-Reihenfolge neu ein – mit CGNAT und doppeltem NAT.
 * Vertrag: docs/API.md, „Lag-Detektiv“ („Zonenregel der Teilroute“).
 *
 * - Gateway-Adresse oder TTL 1 mit privater Adresse → `lan`
 * - `100.64.0.0/10` → `isp` (CGNAT)
 * - private Adresse nach der ersten öffentlichen oder CGNAT-Station → `isp` (CGNAT)
 * - private Adresse davor (doppeltes NAT, Mesh) → `lan`
 * - die ersten 3 öffentlichen Stationen → `isp`, danach `internet`
 * - eine Station, die schon `target` ist, bleibt das Ziel; stumme Station → `null`
 */
import type { HopZone } from "./types";

/** Station mit Adresse (null = stumm) und bisheriger Zone */
export interface ZoneInputHop {
  address: string | null;
  zone: HopZone | null;
}

/** So viele öffentliche Stationen gehören noch zum Anbieter */
export const ISP_PUBLIC_HOPS = 3;

type Parsed = { v: 4; o: number[] } | { v: 6; s: number[] };

/** IPv4 bzw. IPv6 lesen (null = keine gültige Adresse) */
function parseIp(text: string | null): Parsed | null {
  if (!text) return null;
  const t = text.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  if (v4) {
    const o = v4.slice(1).map(Number);
    return o.every((x) => x <= 255) ? { v: 4, o } : null;
  }
  if (!t.includes(":")) return null;
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const part = (p: string | undefined) => (p ? p.split(":").map((x) => (/^[0-9a-f]{1,4}$/i.test(x) ? parseInt(x, 16) : Number.NaN)) : []);
  const head = part(halves[0]);
  const tail = part(halves[1]);
  if ([...head, ...tail].some((x) => !Number.isFinite(x))) return null;
  const compressed = halves.length === 2;
  const fill = compressed ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (!compressed && head.length !== 8)) return null;
  return { v: 6, s: [...head, ...Array<number>(fill).fill(0), ...tail] };
}

/** Carrier-NAT (`100.64.0.0/10`) */
export function isCgnat(address: string | null): boolean {
  const ip = parseIp(address);
  return ip?.v === 4 && ip.o[0] === 100 && ip.o[1] >= 64 && ip.o[1] <= 127;
}

/** Privat im Sinne der Zonenregel (RFC 1918, Link-Local, Loopback, IPv6 ULA/Link-Local) – ohne CGNAT */
export function isPrivate(address: string | null): boolean {
  const ip = parseIp(address);
  if (!ip) return false;
  if (ip.v === 4) {
    const [a, b] = ip.o;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254);
  }
  const s0 = ip.s[0];
  const loopback = ip.s.slice(0, 7).every((x) => x === 0) && ip.s[7] === 1;
  return loopback || (s0 & 0xfe00) === 0xfc00 || (s0 & 0xffc0) === 0xfe80;
}

/** Zonen der Stationen neu bestimmen; `gateway` = IPv4 des Standard-Gateways (null = unbekannt) */
export function reZone<T extends ZoneInputHop>(hops: T[], gateway: string | null): (T & { zone: HopZone | null; cgnat: boolean })[] {
  let beyondHome = false;
  let publicSeen = 0;
  return hops.map((h, i) => {
    if (h.zone === "target") return { ...h, zone: "target" as const, cgnat: false };
    const address = h.address?.trim() ?? null;
    const ip = parseIp(address);
    if (!ip || !address) return { ...h, zone: null, cgnat: false };
    let zone: HopZone;
    const isGateway = ip.v === 4 && gateway !== null && address === gateway.trim();
    if (isGateway || (i === 0 && isPrivate(address))) zone = "lan";
    else if (isCgnat(address)) {
      beyondHome = true;
      zone = "isp";
    } else if (isPrivate(address)) zone = beyondHome ? "isp" : "lan";
    else {
      beyondHome = true;
      publicSeen += 1;
      zone = publicSeen <= ISP_PUBLIC_HOPS ? "isp" : "internet";
    }
    const cgnat = zone === "isp" && (isCgnat(address) || isPrivate(address));
    return { ...h, zone, cgnat };
  });
}
