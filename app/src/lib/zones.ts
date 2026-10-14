/**
 * Zonenregel der Teilroute (gleiche Regel wie `quickhops::zones` im Backend, Prüfdaten
 * ./fixtures/zones.json): ordnet Stationen in TTL-Reihenfolge neu ein – mit CGNAT und doppeltem NAT.
 * Vertrag: docs/API.md, „Lag-Detektiv“ („Zonenregel der Teilroute“).
 *
 * Gerüst: Die Regel liefert F1. Bis dahin bleibt die Zone jeder Station unverändert (`cgnat = false`).
 */
import type { HopZone } from "./types";

/** Station mit Adresse (null = stumm) und bisheriger Zone */
export interface ZoneInputHop {
  address: string | null;
  zone: HopZone | null;
}

/** Zonen der Stationen neu bestimmen; `gateway` = IPv4 des Standard-Gateways (null = unbekannt) */
export function reZone<T extends ZoneInputHop>(hops: T[], gateway: string | null): (T & { zone: HopZone | null; cgnat: boolean })[] {
  void gateway;
  return hops.map((h) => ({ ...h, cgnat: false }));
}
