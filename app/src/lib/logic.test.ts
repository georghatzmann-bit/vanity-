import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyFilter, filterGames, fuzzyScore, normalizeName, sortGames } from "./search";
import { findDuplicateGroups, markDuplicates } from "./dedupe";
import { defaultSettings, guessServerGame, mergeSettings, normalizeGame } from "./defaults";
import { genCoverSpec, initials } from "./gencover";
import { bufferbloatGrade, compressTimeline, countSpikes, gradeValue, pingColor, pingGrade, signalLabel, summarize } from "./grade";
import { de } from "../locales/de";
import { en } from "../locales/en";
import type { Game, PingSample, PlayStats } from "./types";

const g = (id: string, name: string, extra: Partial<Game> = {}): Game => normalizeGame({ id, name, ...extra });
const stats = (gameId: string, totalSeconds: number, lastPlayedAt: number | null = null): PlayStats => ({ gameId, totalSeconds, sessions: 1, lastPlayedAt, lastSessionSeconds: null, firstPlayedAt: null });
const sample = (t: number, rtt: number | null): PingSample => ({ targetId: "x", t, rtt });

describe("Verbindungsnote", () => {
  it("vergibt Noten nach Ping, Schwankung und Verlust", () => {
    expect(pingGrade(null, null, 0)).toBeNull();
    expect(pingGrade(12, 1, 0)).toBe("A+");
    expect(pingGrade(25, 2, 0)).toBe("A");
    expect(pingGrade(12, 1, 0.001)).toBe("A");
    expect(pingGrade(40, 2, 0)).toBe("B");
    expect(pingGrade(12, 8, 0)).toBe("B");
    expect(pingGrade(70, 2, 0)).toBe("C");
    expect(pingGrade(12, 1, 0.02)).toBe("C");
    expect(pingGrade(120, 2, 0)).toBe("D");
    expect(pingGrade(12, 30, 0)).toBe("D");
    expect(pingGrade(200, 2, 0)).toBe("F");
    expect(pingGrade(12, 1, 0.1)).toBe("F");
  });
  it("Noten haben eine Reihenfolge und Farben", () => {
    expect(gradeValue("A+")).toBeGreaterThan(gradeValue("A"));
    expect(gradeValue("A")).toBeGreaterThan(gradeValue("F"));
    expect(gradeValue(null)).toBe(gradeValue("F"));
    expect(pingColor(null)).toContain("danger");
    expect(pingColor(20)).toContain("success");
    expect(pingColor(150)).toContain("danger");
  });
  it("Bufferbloat-Note aus dem Anstieg unter Last", () => {
    expect(bufferbloatGrade(2)).toBe("A+");
    expect(bufferbloatGrade(20)).toBe("A");
    expect(bufferbloatGrade(45)).toBe("B");
    expect(bufferbloatGrade(150)).toBe("C");
    expect(bufferbloatGrade(300)).toBe("D");
    expect(bufferbloatGrade(900)).toBe("F");
  });
  it("Signalstärke in Worte", () => {
    expect(signalLabel(95)).toBe("excellent");
    expect(signalLabel(65)).toBe("good");
    expect(signalLabel(45)).toBe("fair");
    expect(signalLabel(10)).toBe("weak");
  });
});

describe("Ping-Statistik", () => {
  it("rechnet Mittelwert, Schwankung und Verlust wie das Backend", () => {
    const s = summarize("x", [sample(0, 20), sample(1, 30), sample(2, null), sample(3, 25)]);
    expect(s.avg).toBe(25);
    expect(s.min).toBe(20);
    expect(s.max).toBe(30);
    expect(s.jitter).toBeCloseTo(7.5);
    expect(s.loss).toBeCloseTo(0.25);
    expect(s.samples).toBe(4);
    expect(s.last).toBe(25);
  });
  it("kommt mit leeren Messungen klar", () => {
    const s = summarize("x", []);
    expect(s.avg).toBeNull();
    expect(s.jitter).toBeNull();
    expect(s.loss).toBe(0);
    expect(summarize("x", [sample(0, null)]).loss).toBe(1);
  });
  it("zählt Spitzen deutlich über dem Median", () => {
    expect(countSpikes([20, 21, 22, 20, 95, 21, 300, null])).toBe(2);
    expect(countSpikes([20, 20, 20])).toBe(0);
    expect(countSpikes([null, null])).toBe(0);
  });
  it("verdichtet lange Zeitreihen, Verlust bleibt sichtbar", () => {
    const points: [number, number | null][] = Array.from({ length: 1200 }, (_, i) => [i, i < 600 ? 20 : null]);
    const out = compressTimeline(points, 100);
    expect(out).toHaveLength(100);
    expect(out[0][1]).toBe(20);
    expect(out[99][1]).toBeNull();
    expect(compressTimeline(points.slice(0, 50), 100)).toHaveLength(50);
  });
});

describe("Suche", () => {
  it("findet Abkürzungen und Wortanfänge", () => {
    expect(fuzzyScore("cs2", "Counter-Strike 2")).toBeGreaterThan(0);
    expect(fuzzyScore("gate", "Baldur's Gate 3")).toBeGreaterThan(fuzzyScore("ate", "Baldur's Gate 3"));
    expect(fuzzyScore("xyz", "Elden Ring")).toBe(0);
    expect(fuzzyScore("eldn", "Elden Ring")).toBeGreaterThan(0);
  });
  it("ignoriert Akzente und Markenzeichen", () => {
    expect(normalizeName("Pokémon™ Légendes")).toBe("pokemon legendes");
  });
  it("filtert nach Art, Favorit, Quelle und Ausgeblendet", () => {
    const games = [g("a", "Hades", { favorite: true, source: "steam" }), g("b", "Discord", { kind: "app" }), g("c", "Celeste", { hidden: true })];
    expect(filterGames(games, { ...emptyFilter(), kind: "game" }).map((x) => x.id)).toEqual(["a"]);
    expect(filterGames(games, { ...emptyFilter(), favoritesOnly: true }).map((x) => x.id)).toEqual(["a"]);
    expect(filterGames(games, { ...emptyFilter(), source: "steam" }).map((x) => x.id)).toEqual(["a"]);
    expect(filterGames(games, { ...emptyFilter(), showHidden: true })).toHaveLength(3);
    expect(filterGames(games, { ...emptyFilter(), query: "had" }).map((x) => x.id)).toEqual(["a"]);
  });
  it("sortiert nach Spielzeit und Name", () => {
    const games = [g("a", "Beta"), g("b", "Alpha"), g("c", "Gamma")];
    const st = new Map<string, PlayStats>([
      ["c", stats("c", 500)],
      ["a", stats("a", 100)],
    ]);
    expect(sortGames(games, "playtime", true, st).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(sortGames(games, "name", false, st).map((x) => x.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

describe("Doppelte erkennen", () => {
  it("erkennt Steam-ID, Exe-Pfad und Namen", () => {
    const lib = [g("a", "Hades", { source: "steam", sourceId: "1145360", exePath: "C:\\Games\\Hades\\Hades.exe" })];
    const found = markDuplicates(
      [
        { name: "Hades", kind: "game", source: "steam", sourceId: "1145360", launch: { type: "url", target: "steam://rungameid/1145360" } },
        { name: "HADES", kind: "game", source: "folder", exePath: "c:/games/hades/hades.exe", launch: { type: "exe", target: "c:/games/hades/hades.exe" } },
        { name: "Celeste", kind: "game", source: "folder", launch: { type: "exe", target: "C:\\Celeste.exe" } },
      ],
      lib,
    );
    expect(found.map((f) => f.duplicate)).toEqual([true, true, false]);
  });
  it("gruppiert Doppelte in der Bibliothek", () => {
    const groups = findDuplicateGroups([g("a", "Hades", { source: "steam", sourceId: "1" }), g("b", "Hades", { source: "epic" }), g("c", "Celeste")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
});

describe("Robustheit", () => {
  it("normalisiert kaputte Spieldaten ohne Absturz", () => {
    const game = normalizeGame({ id: "x", name: "Test", images: undefined as unknown as Game["images"], favorite: "ja" as unknown as boolean });
    expect(game.images).toEqual({});
    expect(typeof game.favorite).toBe("boolean");
    expect(game.kind).toBe("game");
    expect(game.launch.type).toBeDefined();
  });
  it("ergänzt fehlende Einstellungen und verwirft Unsinn", () => {
    const s = mergeSettings({ theme: "neon" as never, volume: 7, pingIntervalMs: 5, overlayItems: ["ping", "quatsch" as never] });
    expect(["pulsar", "ember", "toxic", "frost"]).toContain(s.theme);
    expect(s.volume).toBeLessThanOrEqual(1);
    expect(s.pingIntervalMs).toBeGreaterThanOrEqual(250);
    expect(s.overlayItems).toEqual(["ping"]);
    expect(s.boostProfile.gamePriority).toBeDefined();
    expect(mergeSettings(null)).toEqual(defaultSettings());
  });
  it("erkennt Spiele mit echten Servern", () => {
    expect(guessServerGame({ name: "Counter-Strike 2", source: "steam", sourceId: "730" })).toBe("cs2");
    expect(guessServerGame({ name: "Dota 2", source: "steam", sourceId: "570" })).toBe("dota2");
    expect(guessServerGame({ name: "Deadlock", source: "steam", sourceId: "1422450" })).toBe("deadlock");
    expect(guessServerGame({ name: "League of Legends", source: "manual" })).toBe("lol");
    expect(guessServerGame({ name: "Stardew Valley", source: "steam", sourceId: "413150" })).toBeUndefined();
  });
  it("generierte Cover sind stabil", () => {
    expect(genCoverSpec("Hades")).toEqual(genCoverSpec("Hades"));
    expect(genCoverSpec("Hades").palette.primary).not.toBe(genCoverSpec("Celeste").palette.primary);
    expect(initials("Counter-Strike 2")).toBe("CS2");
    expect(initials("Hades")).toBe("HA");
  });
});

describe("Übersetzungen", () => {
  const keys = (o: Record<string, unknown>, prefix = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
  it("Englisch hat alle deutschen Schlüssel und umgekehrt", () => {
    const d = keys(de).sort();
    const e = keys(en).sort();
    expect(e.filter((k) => !d.includes(k))).toEqual([]);
    expect(d.filter((k) => !e.includes(k))).toEqual([]);
  });
  it("Platzhalter stimmen überein", () => {
    const flat = (o: Record<string, unknown>, prefix = ""): [string, string][] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)] as [string, string]]));
    const dm = new Map(flat(de));
    for (const [k, v] of flat(en)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(v), k).toEqual(ph(dm.get(k) ?? ""));
    }
  });
  it("jeder im Code benutzte Text existiert (sonst sieht man z. B. „scan.foundTitle“ statt Text)", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const has = (k: string) => {
      let cur: unknown = de;
      for (const p of k.split(".")) {
        if (cur && typeof cur === "object" && p in (cur as object)) cur = (cur as Record<string, unknown>)[p];
        else return false;
      }
      return typeof cur === "string";
    };
    const missing: string[] = [];
    for (const f of globSync("**/*.{ts,tsx}", { cwd: src })) {
      if (f.includes("locales") || f.endsWith(".test.ts")) continue;
      for (const m of readFileSync(join(src, f), "utf8").matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) if (!has(m[1])) missing.push(`${m[1]} (${f})`);
    }
    expect(missing).toEqual([]);
  });
});
