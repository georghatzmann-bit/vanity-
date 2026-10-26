/*
 * AI player bots ("Play with AI bots") – texts and the version rule.
 *
 * The real rule lives in Rust (launcher/core/src/bots.rs, `bots_support`). This file mirrors it for
 * the browser preview and for an instant first answer; the Rust answer always wins.
 */
import type { BotSkill, BotsSupport } from "./api";
import { parseVersionNumber } from "./bubble";

/** The one build the bot port was made for. */
export const BOTS_VERSION = "19.10";
export const BOTS_CHANGELIST = 18675304;

export const BOT_COUNT_MIN = 1;
export const BOT_COUNT_MAX = 99;
export const BOT_COUNT_DEFAULT = 30;

export const botsText = {
  section: "AI bots",
  badge: "Experimental · 19.10 only",
  switchLabel: "Play with AI bots",
  switchHint: "Real AI players drop in with you and play the match.",
  countLabel: "Number of bots",
  skillLabel: "Bot skill",
  /** Same texts as Rust (BOTS_NOTE_*). */
  noteExperimental: "Experimental, 19.10 only. Bots may not loot, fight or build well yet.",
  noteNotInGame: "AI bots don't exist in this Fortnite version.",
  noteNotYet: "AI bots aren't available for this version yet.",
  /** Toast title when the server says bots can't run in this match (event "server:playerBots"). */
  unavailableTitle: "AI bots are off for this match",
} as const;

export const botSkills: { id: BotSkill; label: string; hint: string }[] = [
  { id: "easy", label: "Easy", hint: "Good for a relaxed match" },
  { id: "normal", label: "Normal", hint: "Like an average player" },
  { id: "hard", label: "Hard", hint: "They fight back" },
];

export function botSkillLabel(skill: BotSkill | string | undefined): string {
  return botSkills.find((s) => s.id === skill)?.label ?? "Easy";
}

/** Same as `bots_support` in Rust: only 19.10-CL-18675304 is "experimental". */
export function botsSupportFor(version: string, cl: number | null | undefined): BotsSupport {
  const v = parseVersionNumber(version);
  if (v && v[0] === 19 && v[1] === 10 && cl === BOTS_CHANGELIST) {
    return { level: "experimental", note: botsText.noteExperimental };
  }
  // Fortnite's own AI players came with 11.00
  const old = v !== null && v[0] < 11;
  return { level: "unavailable", note: old ? botsText.noteNotInGame : botsText.noteNotYet };
}

export function clampBotCount(n: number): number {
  if (!Number.isFinite(n)) return BOT_COUNT_DEFAULT;
  return Math.min(BOT_COUNT_MAX, Math.max(BOT_COUNT_MIN, Math.round(n)));
}
