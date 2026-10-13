import { describe, expect, it } from "vitest";
import { fuzzyScore, filterGames, sortGames, emptyFilter, normalizeName } from "./search";
import { markDuplicates, findDuplicateGroups } from "./dedupe";
import { perDay, streaks, topGames, yearReview, backlogEstimate, perHour } from "./stats";
import { pickGame } from "./dice";
import { evaluate, emptyCounters, ACHIEVEMENTS } from "./achievements";
import { normalizeGame, mergeSettings } from "./defaults";
import { genCoverSpec, initials } from "./gencover";
import { de } from "../locales/de";
import { en } from "../locales/en";
import type { Game, PlayStats, Session } from "./types";

const DAY = 86400000;
const g = (id: string, name: string, extra: Partial<Game> = {}): Game => normalizeGame({ id, name, ...extra });

describe("Suche", () => {
  it("findet Abkürzungen und Wortanfänge", () => {
    expect(fuzzyScore("bg3", "Baldur's Gate 3")).toBeGreaterThan(0);
    expect(fuzzyScore("gate", "Baldur's Gate 3")).toBeGreaterThan(fuzzyScore("ate", "Baldur's Gate 3"));
    expect(fuzzyScore("xyz", "Elden Ring")).toBe(0);
    expect(fuzzyScore("eldn", "Elden Ring")).toBeGreaterThan(0);
  });
  it("ignoriert Akzente und Markenzeichen", () => {
    expect(normalizeName("Pokémon™ Légendes")).toBe("pokemon legendes");
  });
  it("filtert nach Art, Favorit und Tag", () => {
    const games = [g("a", "Hades", { favorite: true, tags: ["Roguelike"] }), g("b", "Discord", { kind: "app" }), g("c", "Celeste", { hidden: true })];
    expect(filterGames(games, { ...emptyFilter(), kind: "game" }).map((x) => x.id)).toEqual(["a"]);
    expect(filterGames(games, { ...emptyFilter(), favoritesOnly: true }).map((x) => x.id)).toEqual(["a"]);
    expect(filterGames(games, { ...emptyFilter(), tag: "Roguelike" }).map((x) => x.id)).toEqual(["a"]);
    expect(filterGames(games, { ...emptyFilter(), showHidden: true })).toHaveLength(3);
  });
  it("sortiert nach Spielzeit und Name", () => {
    const games = [g("a", "Beta"), g("b", "Alpha"), g("c", "Gamma")];
    const stats = new Map<string, PlayStats>([["c", { gameId: "c", totalSeconds: 500, sessions: 1 }], ["a", { gameId: "a", totalSeconds: 100, sessions: 1 }]]);
    expect(sortGames(games, "playtime", true, stats).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(sortGames(games, "name", false, stats).map((x) => x.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

describe("Doppelte erkennen", () => {
  it("erkennt Steam-ID, Exe-Pfad und Namen", () => {
    const lib = [g("1", "Elden Ring", { source: "steam", sourceId: "1245620", launch: { type: "url", target: "steam://rungameid/1245620" } }), g("2", "Tool", { exePath: "C:\\Tools\\tool.exe" })];
    const res = markDuplicates(
      [
        { name: "ELDEN RING", kind: "game", source: "steam", sourceId: "1245620", launch: { type: "url", target: "steam://rungameid/1245620" } },
        { name: "Tool Neu", kind: "app", source: "manual", exePath: "c:/tools/tool.exe", launch: { type: "exe", target: "c:/tools/tool.exe" } },
        { name: "Neu", kind: "game", source: "manual", launch: { type: "exe", target: "D:\\neu.exe" } },
        { name: "Neu", kind: "game", source: "manual", launch: { type: "exe", target: "D:\\neu.exe" } },
      ],
      lib,
    );
    expect(res.map((r) => r.duplicate)).toEqual([true, true, false, true]);
  });
  it("gruppiert Doppelte in der Bibliothek", () => {
    const groups = findDuplicateGroups([g("1", "Portal 2"), g("2", "Portal 2"), g("3", "Hades")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((x) => x.id).sort()).toEqual(["1", "2"]);
  });
});

describe("Statistik", () => {
  const now = new Date(2026, 9, 12, 20, 0).getTime();
  const s = (id: number, daysAgo: number, seconds: number, hour = 20): Session => {
    const d = new Date(now - daysAgo * DAY);
    d.setHours(hour, 0, 0, 0);
    return { id, gameId: id % 2 ? "a" : "b", start: d.getTime(), end: d.getTime() + seconds * 1000, seconds };
  };
  const sessions = [s(1, 0, 3600), s(2, 1, 1800), s(3, 2, 600), s(4, 5, 7200, 2)];
  it("summiert pro Tag", () => {
    const days = perDay(sessions, 7, now);
    expect(days).toHaveLength(7);
    expect(days[6].seconds).toBe(3600);
    expect(days[5].seconds).toBe(1800);
  });
  it("berechnet Serien", () => {
    expect(streaks(sessions, now)).toEqual({ current: 3, best: 3 });
  });
  it("Lieblingsspiele und Jahresrückblick", () => {
    expect(topGames(sessions)[0]).toEqual({ gameId: "b", seconds: 1800 + 7200 });
    const yr = yearReview(sessions, 2026);
    expect(yr.sessions).toBe(4);
    expect(yr.longestSession).toBe(7200);
  });
  it("verteilt Sitzungen auf Stunden", () => {
    const h = perHour([s(9, 0, 5400, 21)]);
    expect(Math.round(h[21])).toBe(3600);
    expect(Math.round(h[22])).toBe(1800);
  });
  it("Backlog-Rechner", () => {
    const games = [g("a", "A", { status: "want" }), g("b", "B", { status: "done" })];
    const est = backlogEstimate(games, new Map([["b", { gameId: "b", totalSeconds: 20 * 3600, sessions: 10 }]]), sessions, now);
    expect(est.count).toBe(1);
    expect(est.weeks).toBeGreaterThan(0);
  });
});

describe("Würfel", () => {
  it("wählt nur Spiele und respektiert die Stimmung", () => {
    const games = [g("a", "Rennen", { genre: "Rennspiel" }), g("b", "Discord", { kind: "app" }), g("c", "Saga", { genre: "RPG", tags: ["Story"] })];
    for (let i = 0; i < 20; i++) {
      const p = pickGame(games, new Map(), { mood: "story" }, i);
      expect(p?.game.id).toBe("c");
    }
    expect(pickGame([g("x", "App", { kind: "app" })], new Map())).toBeNull();
  });
});

describe("Erfolge", () => {
  it("schaltet Erfolge anhand der Daten frei", () => {
    const games = Array.from({ length: 12 }, (_, i) => g(String(i), `Spiel ${i}`));
    const stats = new Map<string, PlayStats>([["0", { gameId: "0", totalSeconds: 11 * 3600, sessions: 3 }]]);
    const done = evaluate({ games, stats, sessions: [], collections: [], wishlist: [], counters: emptyCounters() });
    expect(done.has("library_10")).toBe(true);
    expect(done.has("hours_10")).toBe(true);
    expect(done.has("hours_100")).toBe(false);
  });
  it("jeder Erfolg hat deutsche und englische Texte", () => {
    for (const a of ACHIEVEMENTS) {
      expect((de.achievements as Record<string, unknown>)[a.id]).toBeTruthy();
      expect((en.achievements as Record<string, unknown>)[a.id]).toBeTruthy();
    }
  });
});

describe("Robustheit", () => {
  it("normalisiert kaputte Spieldaten ohne Absturz", () => {
    const n = normalizeGame({ id: "x", name: "", rating: 99, tags: "kaputt" as unknown as string[] } as Game);
    expect(n.name).toBe("Unbenannt");
    expect(n.rating).toBe(5);
    expect(n.tags).toEqual([]);
    expect(n.links.tools).toEqual([]);
  });
  it("ergänzt fehlende Einstellungen", () => {
    const s = mergeSettings({ theme: "neon", scan: { steam: false } as never });
    expect(s.theme).toBe("neon");
    expect(s.scan.steam).toBe(false);
    expect(s.scan.epic).toBe(true);
    expect(mergeSettings(null).theme).toBe("nova");
  });
  it("generierte Cover sind stabil", () => {
    expect(genCoverSpec("Elden Ring")).toEqual(genCoverSpec("Elden Ring"));
    expect(initials("Baldur's Gate 3")).toBe("BG3");
  });
});

describe("Übersetzungen", () => {
  it("Englisch hat alle deutschen Schlüssel", () => {
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(en).sort()).toEqual(keys(de).sort());
  });
});
