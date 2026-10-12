import { normalizeName } from "./search";
import type { Game, ScannedEntry } from "./types";

const normPath = (p?: string) => (p ? p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : "");

/** Schlüssel, an denen man denselben Eintrag erkennt */
export function identityKeys(e: Pick<Game, "name" | "kind" | "source" | "sourceId" | "exePath" | "launch">): string[] {
  const keys: string[] = [];
  if (e.sourceId && e.source !== "manual" && e.source !== "folder" && e.source !== "startmenu") keys.push(`src:${e.source}:${e.sourceId.toLowerCase()}`);
  const exe = normPath(e.exePath);
  if (exe) keys.push(`exe:${exe}`);
  if (e.launch?.target) keys.push(`target:${normPath(e.launch.target)}`);
  // Steam-Link und Steam-ID sind derselbe Eintrag
  const m = e.launch?.target?.match(/steam:\/\/rungameid\/(\d+)/i);
  if (m) keys.push(`src:steam:${m[1]}`);
  return keys;
}

export function nameKey(e: { name: string; kind: string }): string {
  return `name:${e.kind}:${normalizeName(e.name)}`;
}

/** Markiert Scan-Ergebnisse, die schon in der Bibliothek sind (oder doppelt im Ergebnis) */
export function markDuplicates(found: ScannedEntry[], library: Game[]): { entry: ScannedEntry; duplicate: boolean }[] {
  const known = new Set<string>();
  for (const g of library) {
    identityKeys(g).forEach((k) => known.add(k));
    known.add(nameKey(g));
  }
  return found.map((entry) => {
    const keys = [...identityKeys(entry), nameKey(entry)];
    const duplicate = keys.some((k) => known.has(k));
    keys.forEach((k) => known.add(k));
    return { entry, duplicate };
  });
}

/** Gruppen möglicher Doppelter innerhalb der Bibliothek */
export function findDuplicateGroups(games: Game[]): Game[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const owner = new Map<string, string>();
  for (const g of games) {
    parent.set(g.id, g.id);
    for (const k of [...identityKeys(g), nameKey(g)]) {
      const o = owner.get(k);
      if (o) union(g.id, o);
      else owner.set(k, g.id);
    }
  }
  const groups = new Map<string, Game[]>();
  for (const g of games) {
    const r = find(g.id);
    groups.set(r, [...(groups.get(r) ?? []), g]);
  }
  return [...groups.values()].filter((grp) => grp.length > 1);
}
