import { hash } from "./gencover";
import type { Game, PlayStats } from "./types";

export type Mood = "any" | "chill" | "action" | "story" | "social" | "brain";
export type Duration = "any" | "short" | "mid" | "long";

const MOOD_WORDS: Record<Exclude<Mood, "any">, string[]> = {
  chill: ["entspannt", "relax", "chill", "cozy", "simulation", "farm", "puzzle", "kartenspiel", "card", "sandbox", "aufbau"],
  action: ["action", "shooter", "rennspiel", "racing", "sport", "fighting", "roguelike", "souls", "hack", "plattformer", "platformer"],
  story: ["story", "rpg", "adventure", "abenteuer", "narrative", "horror", "visual novel"],
  social: ["freunde", "friends", "koop", "co-op", "coop", "multiplayer", "party", "online"],
  brain: ["knobeln", "puzzle", "strategie", "strategy", "taktik", "factory", "logik"],
};

const DURATION_WORDS: Record<Exclude<Duration, "any">, string[]> = {
  short: ["kurz", "short", "roguelike", "kartenspiel", "card", "puzzle", "arcade", "sport", "rennspiel", "racing"],
  mid: [],
  long: ["rpg", "open world", "strategie", "strategy", "simulation", "story", "survival"],
};

function text(g: Game) {
  return [g.genre ?? "", ...g.tags].join(" ").toLowerCase();
}

export interface Pick {
  game: Game;
  reason: string;
  matched: boolean;
}

/**
 * Wählt ein Spiel gewichtet aus: bevorzugt Backlog, angefangene und lange nicht gespielte Spiele,
 * passend zu Stimmung und verfügbarer Zeit.
 */
export function pickGame(games: Game[], stats: Map<string, PlayStats>, opts: { mood?: Mood; duration?: Duration } = {}, seed = 0, now = Date.now()): Pick | null {
  const pool = games.filter((g) => g.kind === "game" && !g.hidden && g.status !== "done");
  const base = pool.length ? pool : games.filter((g) => g.kind === "game" && !g.hidden);
  if (!base.length) return null;
  const mood = opts.mood ?? "any";
  const dur = opts.duration ?? "any";
  const matches = (g: Game) => {
    const tx = text(g);
    const moodOk = mood === "any" || MOOD_WORDS[mood].some((w) => tx.includes(w));
    const durOk = dur === "any" || dur === "mid" || DURATION_WORDS[dur].some((w) => tx.includes(w));
    return moodOk && durOk;
  };
  const filtered = base.filter(matches);
  const candidates = filtered.length ? filtered : base;
  const scored = candidates.map((g) => {
    const st = stats.get(g.id);
    const days = st?.lastPlayedAt ? (now - st.lastPlayedAt) / 86400000 : 999;
    let w = 1;
    let reason = "dice.reasonForgotten";
    if (g.status === "want") {
      w += 2.2;
      reason = "dice.reasonBacklog";
    } else if (g.status === "playing") {
      w += 1.6;
      reason = "dice.reasonPlaying";
    } else if (!st) {
      w += 1.2;
      reason = "dice.reasonNew";
    } else if (g.favorite) {
      w += 0.8;
      reason = "dice.reasonFavorite";
    }
    if (days < 1) w *= 0.35;
    else if (days > 14) w *= 1.3;
    w *= 0.7 + g.rating / 10;
    return { g, w, reason };
  });
  const total = scored.reduce((a, s) => a + s.w, 0);
  // deterministisch pro Seed (damit die Anzeige beim Neu-Rendern stabil bleibt)
  let r = ((hash(`${seed}:${candidates.length}:${Math.floor(now / 3600000)}`) % 100000) / 100000) * total;
  for (const s of scored) {
    r -= s.w;
    if (r <= 0) return { game: s.g, reason: s.reason, matched: filtered.length > 0 };
  }
  const last = scored[scored.length - 1];
  return { game: last.g, reason: last.reason, matched: filtered.length > 0 };
}
