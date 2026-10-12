import type { Game, GameKind, PlayStats, PlayStatus, SortKey } from "./types";

/** Für Vergleiche: Kleinbuchstaben, ohne Akzente, ohne Sonderzeichen */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Unscharfe Suche: Treffer-Wert (höher = besser), 0 = kein Treffer.
 * Berücksichtigt Anfang, Wortanfänge, Abkürzungen ("bg3" -> "Baldur's Gate 3") und Buchstabenfolgen.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = normalizeName(query);
  if (!q) return 1;
  const tnorm = normalizeName(text);
  if (!tnorm) return 0;
  if (tnorm === q) return 1000;
  if (tnorm.startsWith(q)) return 800 - tnorm.length;
  const words = tnorm.split(" ");
  if (words.some((w) => w.startsWith(q))) return 600 - tnorm.length;
  const initials = words.map((w) => (/^\d+$/.test(w) ? w : w[0])).join("");
  if (initials.startsWith(q.replace(/ /g, ""))) return 500;
  const idx = tnorm.indexOf(q);
  if (idx >= 0) return 400 - idx;
  // Buchstabenfolge (alle Zeichen in Reihenfolge)
  const compact = q.replace(/ /g, "");
  let ti = 0;
  let gaps = 0;
  for (const ch of compact) {
    const found = tnorm.indexOf(ch, ti);
    if (found < 0) return 0;
    gaps += found - ti;
    ti = found + 1;
  }
  return Math.max(1, 200 - gaps * 4);
}

export interface LibraryFilter {
  query: string;
  kind: GameKind | "all";
  favoritesOnly: boolean;
  status: PlayStatus | "all";
  source: Game["source"] | "all";
  tag: string | null;
  collectionId: string | null;
  showHidden: boolean;
}

export const emptyFilter = (): LibraryFilter => ({
  query: "",
  kind: "all",
  favoritesOnly: false,
  status: "all",
  source: "all",
  tag: null,
  collectionId: null,
  showHidden: false,
});

export function filterGames(games: Game[], f: LibraryFilter): Game[] {
  return games.filter((g) => {
    if (!f.showHidden && g.hidden) return false;
    if (f.kind !== "all" && g.kind !== f.kind) return false;
    if (f.favoritesOnly && !g.favorite) return false;
    if (f.status !== "all" && g.status !== f.status) return false;
    if (f.source !== "all" && g.source !== f.source) return false;
    if (f.tag && !g.tags.includes(f.tag)) return false;
    if (f.collectionId && !g.collectionIds.includes(f.collectionId)) return false;
    if (f.query) {
      const s = Math.max(fuzzyScore(f.query, g.name), g.genre ? fuzzyScore(f.query, g.genre) * 0.5 : 0, ...g.tags.map((tg) => fuzzyScore(f.query, tg) * 0.5));
      if (s <= 0) return false;
    }
    return true;
  });
}

export function sortGames(games: Game[], key: SortKey, desc: boolean, stats: Map<string, PlayStats>, query = ""): Game[] {
  const dir = desc ? -1 : 1;
  const list = [...games];
  if (query.trim()) {
    // Bei aktiver Suche zuerst nach Relevanz
    return list.sort((a, b) => fuzzyScore(query, b.name) - fuzzyScore(query, a.name) || a.name.localeCompare(b.name));
  }
  const byName = (a: Game, b: Game) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  list.sort((a, b) => {
    let v = 0;
    switch (key) {
      case "name":
        v = byName(a, b);
        return desc ? -v : v;
      case "playtime":
        v = (stats.get(a.id)?.totalSeconds ?? 0) - (stats.get(b.id)?.totalSeconds ?? 0);
        break;
      case "lastPlayed":
        v = (stats.get(a.id)?.lastPlayedAt ?? 0) - (stats.get(b.id)?.lastPlayedAt ?? 0);
        break;
      case "rating":
        v = a.rating - b.rating;
        break;
      case "added":
        v = a.addedAt - b.addedAt;
        break;
    }
    return v !== 0 ? v * dir : byName(a, b);
  });
  return list;
}

export function allTags(games: Game[]): string[] {
  const set = new Map<string, number>();
  for (const g of games) for (const t of g.tags) set.set(t, (set.get(t) ?? 0) + 1);
  return [...set.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}
