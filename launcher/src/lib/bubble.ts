/*
 * Bubble Builds: the see-through "bubble wrap" build look of Chapter 2 Seasons 5–6.
 * It only shows up when the game runs in Performance Mode (ES3.1 renderer) on Fortnite 15.40 – 16.00.
 * Epic removed it in 16.10; it came back briefly in 16.20 – 16.40 and was fixed in 16.50.
 *
 * The real rules live in Rust (launcher/core/src/launchargs.rs, VersionRules). This file mirrors them
 * for the browser preview and holds the exact English wording the UI shows.
 */

export type BubbleLevel = "supported" | "experimental" | "unavailable";

export interface BubbleBuildsInfo {
  level: BubbleLevel;
  /** One plain English sentence that explains the level. */
  note: string;
}

/** All texts for the Bubble Builds option (Settings, Library, In-game Menu page). */
export const bubbleText = {
  label: "Bubble Builds",
  hint: "The see-through 'bubble wrap' build look from Chapter 2 Seasons 5–6. Starts the game in Performance Mode (lower graphics). Applies on next launch.",
  experimentalBadge: "Experimental",
  experimentalHint: "Epic changed how builds look around this version. Your builds may look normal even with this on.",
  unavailableHint: "Only on Fortnite 15.40 – 16.00 (Chapter 2, Seasons 5–6). Try Mobile Builds in the F9 menu.",
  /** Shown next to the switch: the game must be restarted for a change. */
  restartHint: "Can't be changed while playing.",
  /** Question after Fortnite saved Performance Mode as its default (event "bubble:ini-changed"). */
  iniTitle: "Performance Mode is now saved",
  iniQuestion: "Fortnite saved Performance Mode as your default. This also affects your other builds. Reset it?",
  iniReset: "Reset",
  iniKeep: "Keep",
  /** Short status words, e.g. for a badge on a Library card. */
  levelLabel: {
    supported: "Bubble Builds",
    experimental: "Bubble Builds · Experimental",
    unavailable: "No Bubble Builds",
  } satisfies Record<BubbleLevel, string>,
} as const;

/**
 * Fortnite version as [major, minor] the way Fortnite means it: "15.4" → [15, 40], "19.1" → [19, 10].
 * Old versions stay as written ("4.5" → [4, 5]). Same as `parse_version_number` in core/src/version.rs.
 */
export function parseVersionNumber(version: string): [number, number] | null {
  const parts = version.trim().split(".");
  if (!/^\d+$/.test(parts[0] ?? "")) return null;
  const major = Number(parts[0]);
  const minorText = parts[1] ?? "";
  const minor = /^\d+$/.test(minorText) ? Number(minorText) : 0;
  if (major >= 5 && /^\d$/.test(minorText)) return [major, minor * 10];
  return [major, minor];
}

function cmp(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** Same gate as `VersionRules::for_version(..).bubble_builds` in Rust. */
export function bubbleLevelFor(version: string): BubbleLevel {
  const v = parseVersionNumber(version) ?? [0, 0];
  if (cmp(v, [15, 40]) >= 0 && cmp(v, [16, 10]) < 0) return "supported";
  if (cmp(v, [15, 30]) === 0 || (cmp(v, [16, 10]) >= 0 && cmp(v, [16, 50]) < 0)) return "experimental";
  return "unavailable";
}

/** Level + note for a version, without asking Rust (browser preview, instant UI). */
export function bubbleInfoFor(version: string): BubbleBuildsInfo {
  const level = bubbleLevelFor(version);
  const note =
    level === "supported" ? bubbleText.hint : level === "experimental" ? bubbleText.experimentalHint : bubbleText.unavailableHint;
  return { level, note };
}
