import { describe, expect, it } from "vitest";
import { causeSummary } from "./lagtext";
import { de } from "../locales/de";
import { en } from "../locales/en";
import { LAG_CAUSES } from "./types";

const tr = (dict: unknown) => (key: string, vars?: Record<string, string | number>) => {
  let cur: unknown = dict;
  for (const p of key.split(".")) cur = (cur as Record<string, unknown>)?.[p];
  if (typeof cur !== "string") throw new Error(`Text fehlt: ${key}`);
  return cur.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));
};
const deT = tr(de);
const enT = tr(en);

describe("causeSummary", () => {
  it("Gesamtzahl, „vermutlich“, sortiert nach Anzahl, „unklar“ am Ende", () => {
    expect(causeSummary({ wifi: 3, isp: 1, unknown: 1 }, deT)).toBe("5 Ausreißer untersucht – vermutlich: 3× WLAN, 1× Anschluss/Anbieter; 1× unklar");
    expect(causeSummary({ isp: 2, router: 2, unknown: 0 }, deT)).toBe("4 Ausreißer untersucht – vermutlich: 2× Heimnetz/Router, 2× Anschluss/Anbieter; 0× unklar");
  });
  it("„unklar“ steht immer da – auch ohne bekannte Ursache", () => {
    expect(causeSummary({ unknown: 2 }, deT)).toBe("2 Ausreißer untersucht – 2× unklar");
    expect(causeSummary({ localTraffic: 1 }, deT)).toBe("1 Ausreißer untersucht – vermutlich: 1× Datenverkehr auf diesem PC; 0× unklar");
  });
  it("nichts untersucht und kaputte Werte", () => {
    expect(causeSummary({}, deT)).toBe("Keine Ausreißer untersucht");
    expect(causeSummary({ wifi: -3, isp: Number.NaN }, deT)).toBe("Keine Ausreißer untersucht");
  });
  it("Englisch", () => {
    expect(causeSummary({ internet: 2, unknown: 1 }, enT)).toBe("3 spikes examined – likely: 2× Internet (beyond your provider); 1× unclear");
    expect(causeSummary({ unknown: 1 }, enT)).toBe("1 spike examined – 1× unclear");
  });
  it("jede Ursache hat einen Namen in de und en", () => {
    for (const c of LAG_CAUSES) {
      expect(deT(`lag.cause.${c}`)).toBeTruthy();
      expect(enT(`lag.cause.${c}`)).toBeTruthy();
    }
  });
});
