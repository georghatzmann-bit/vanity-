import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/zones.json";
import type { HopZone } from "./types";
import { isCgnat, isPrivate, reZone } from "./zones";

interface ZoneCase {
  name: string;
  gateway: string | null;
  hops: (string | null)[];
  target: number | null;
  zones: (HopZone | null)[];
  cgnat: boolean[];
}

describe("Zonenregel der Teilroute (gleiche Prüfdaten wie das Backend)", () => {
  it.each((fixtures.cases as ZoneCase[]).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    // Eingang wie aus der Routen-Analyse: alte Zonen sind egal, nur das Ziel bleibt Ziel
    const hops = c.hops.map((address, i) => ({ address, zone: (i === c.target ? "target" : "internet") as HopZone, ttl: i + 1 }));
    const out = reZone(hops, c.gateway);
    expect(out.map((h) => h.zone)).toEqual(c.zones);
    expect(out.map((h) => h.cgnat)).toEqual(c.cgnat);
    expect(out.map((h) => h.ttl)).toEqual(hops.map((h) => h.ttl));
  });

  it("Prüfdaten enthalten die Pflichtfälle", () => {
    const names = fixtures.cases.map((c) => c.name).join(" | ");
    for (const must of ["normal", "CGNAT bei TTL 2", "doppeltes NAT", "stumme TTL 1"]) expect(names).toContain(must);
  });

  it("Adressbereiche", () => {
    for (const p of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.178.1", "169.254.1.1", "127.0.0.1", "fe80::1", "fd00::1", "::1"]) expect(isPrivate(p)).toBe(true);
    for (const p of ["100.64.0.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "kein.name", "", "1.2.3"]) expect(isPrivate(p)).toBe(false);
    expect(isCgnat("100.64.0.1") && isCgnat("100.127.255.255")).toBe(true);
    expect(isCgnat("100.128.0.1") || isCgnat("100.63.255.255") || isCgnat(null)).toBe(false);
  });

  it("ungültige Adresse gilt als stumm", () => {
    expect(reZone([{ address: "x.y", zone: "lan" }], null)).toEqual([{ address: "x.y", zone: null, cgnat: false }]);
  });
});
