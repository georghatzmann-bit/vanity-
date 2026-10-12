import { streaks } from "./stats";
import type { Collection, Game, PlayStats, Session, WishItem } from "./types";

export type Tier = "bronze" | "silver" | "gold" | "nova";

export interface AchievementCtx {
  games: Game[];
  stats: Map<string, PlayStats>;
  sessions: Session[];
  collections: Collection[];
  wishlist: WishItem[];
  counters: Counters;
}

export interface Counters {
  launches: number;
  diceRolls: number;
  paletteUses: number;
  bigPicture: number;
  saveBackups: number;
  galleryOpened: number;
}

export const emptyCounters = (): Counters => ({ launches: 0, diceRolls: 0, paletteUses: 0, bigPicture: 0, saveBackups: 0, galleryOpened: 0 });

export interface AchievementDef {
  id: string;
  icon: string;
  tier: Tier;
  /** Fortschritt [aktuell, Ziel] */
  progress: (c: AchievementCtx) => [number, number];
}

const totalHours = (c: AchievementCtx) => [...c.stats.values()].reduce((a, s) => a + s.totalSeconds, 0) / 3600;
const libSize = (c: AchievementCtx) => c.games.length;
const hourHit = (c: AchievementCtx, test: (h: number) => boolean) => (c.sessions.some((s) => s.seconds >= 300 && test(new Date(s.start).getHours())) ? 1 : 0);

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "first_launch", icon: "Rocket", tier: "bronze", progress: (c) => [Math.min(1, c.counters.launches + (c.sessions.length ? 1 : 0)), 1] },
  { id: "library_10", icon: "Library", tier: "bronze", progress: (c) => [libSize(c), 10] },
  { id: "library_50", icon: "Library", tier: "silver", progress: (c) => [libSize(c), 50] },
  { id: "library_100", icon: "Orbit", tier: "gold", progress: (c) => [libSize(c), 100] },
  { id: "hours_1", icon: "Clock", tier: "bronze", progress: (c) => [totalHours(c), 1] },
  { id: "hours_10", icon: "Clock", tier: "bronze", progress: (c) => [totalHours(c), 10] },
  { id: "hours_100", icon: "Hourglass", tier: "silver", progress: (c) => [totalHours(c), 100] },
  { id: "hours_500", icon: "Crown", tier: "gold", progress: (c) => [totalHours(c), 500] },
  { id: "hours_1000", icon: "Sparkles", tier: "nova", progress: (c) => [totalHours(c), 1000] },
  { id: "session_3h", icon: "Flame", tier: "silver", progress: (c) => [c.sessions.some((s) => s.seconds >= 3 * 3600) ? 1 : 0, 1] },
  { id: "night_owl", icon: "Moon", tier: "bronze", progress: (c) => [hourHit(c, (h) => h < 4), 1] },
  { id: "early_bird", icon: "Sunrise", tier: "bronze", progress: (c) => [hourHit(c, (h) => h >= 4 && h < 7), 1] },
  { id: "streak_7", icon: "CalendarCheck", tier: "silver", progress: (c) => [streaks(c.sessions).best, 7] },
  { id: "streak_30", icon: "CalendarHeart", tier: "gold", progress: (c) => [streaks(c.sessions).best, 30] },
  { id: "variety_10", icon: "Shapes", tier: "silver", progress: (c) => [new Set(c.sessions.map((s) => s.gameId)).size, 10] },
  { id: "finisher_1", icon: "Flag", tier: "bronze", progress: (c) => [c.games.filter((g) => g.status === "done").length, 1] },
  { id: "finisher_10", icon: "Trophy", tier: "gold", progress: (c) => [c.games.filter((g) => g.status === "done").length, 10] },
  { id: "critic", icon: "Star", tier: "silver", progress: (c) => [c.games.filter((g) => g.rating > 0).length, 10] },
  { id: "curator", icon: "FolderHeart", tier: "bronze", progress: (c) => [c.collections.length, 3] },
  { id: "dice_roller", icon: "Dices", tier: "bronze", progress: (c) => [c.counters.diceRolls, 5] },
  { id: "wishful", icon: "Gift", tier: "bronze", progress: (c) => [c.wishlist.length, 5] },
  { id: "big_picture", icon: "Tv", tier: "bronze", progress: (c) => [Math.min(1, c.counters.bigPicture), 1] },
  { id: "keyboard_hero", icon: "Keyboard", tier: "silver", progress: (c) => [c.counters.paletteUses, 10] },
  { id: "backup_safe", icon: "ShieldCheck", tier: "bronze", progress: (c) => [Math.min(1, c.counters.saveBackups), 1] },
  { id: "photographer", icon: "Camera", tier: "bronze", progress: (c) => [Math.min(1, c.counters.galleryOpened), 1] },
];

export const TIER_COLORS: Record<Tier, [string, string]> = {
  bronze: ["#e7a46b", "#9a5b2c"],
  silver: ["#e3e8f3", "#8b93a8"],
  gold: ["#ffd76a", "#c48a12"],
  nova: ["#ff8a4c", "#8b5cf6"],
};

/** Liefert die IDs aller Erfolge, deren Ziel erreicht ist */
export function evaluate(ctx: AchievementCtx): Set<string> {
  const done = new Set<string>();
  for (const a of ACHIEVEMENTS) {
    try {
      const [cur, max] = a.progress(ctx);
      if (cur >= max) done.add(a.id);
    } catch {
      /* ein fehlerhafter Erfolg darf nichts kaputt machen */
    }
  }
  return done;
}
