/*
 * Bubble Builds: the see-through "bubble wrap" build look.
 * Chapter 2: it only shows up when the game runs in Performance Mode (ES3.1 renderer) on Fortnite
 * 15.40 – 16.00. Epic removed it in 16.10; it came back briefly in 16.20 – 16.40 and was fixed in 16.50.
 * Chapter 3 Season 1 (19.x): Performance Mode with Fortnite's "Meshes" setting on Low gives a similar
 * look while builds go up ("lowMeshes", experimental).
 *
 * The real rules live in Rust (launcher/core/src/launchargs.rs, VersionRules). This file mirrors them
 * for the browser preview and holds the exact English wording the UI shows. The F9 menu has a third
 * copy (BubbleLook.h, LevelFor).
 */

export type BubbleLevel = "supported" | "experimental" | "lowMeshes" | "unavailable";

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
  /** 19.x (Chapter 3 Season 1). */
  lowMeshesHint:
    "Chapter 3 version: starts the game in Performance Mode with Meshes set to Low. Builds look whiter and more see-through while they go up, like 'bubble wrap' builds. The whole game has lower graphics. Applies on next launch.",
  /** What happens to Fortnite's own settings file (GameUserSettings.ini) around the game. */
  settingsNoteMeshes: "For the game, Rift sets Fortnite's Meshes setting to Low. Your Fortnite settings are put back when the game closes.",
  settingsNotePerformance: "If Fortnite saves Performance Mode as your default, Rift puts it back when the game closes.",
  /** Second half of the "not available" note: where Bubble Builds work instead. */
  unavailableWhere:
    "Bubble Builds work on 15.40 – 16.00, and as an experiment on Chapter 3 Season 1 (19.x). On other versions, try Bubble look in the F9 menu.",
  /** Shown next to the switch: the game must be restarted for a change. */
  restartHint: "Can't be changed while playing.",
  /** Short status words, e.g. for a badge on a Library card. */
  levelLabel: {
    supported: "Bubble Builds",
    experimental: "Bubble Builds · Experimental",
    lowMeshes: "Bubble Builds · Experimental",
    unavailable: "No Bubble Builds",
  } satisfies Record<BubbleLevel, string>,
} as const;

/** "Not available for 12.41. Bubble Builds work on …" – same text as `bubble_note_unavailable` in Rust. */
export function unavailableHint(version: string | null | undefined): string {
  const which = version?.trim() || "this version";
  return `Not available for ${which}. ${bubbleText.unavailableWhere}`;
}

/** Shown with an "Experimental" badge: 15.30, 16.10 – 16.40 and 19.x. */
export function isExperimentalLevel(level: BubbleLevel | null | undefined): boolean {
  return level === "experimental" || level === "lowMeshes";
}

/** The look also needs Fortnite's Meshes on Low (Rift sets it for the game): 15.40 – 16.00 and 19.x. */
export function needsLowMeshes(level: BubbleLevel | null | undefined): boolean {
  return level === "supported" || level === "lowMeshes";
}

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
  if (cmp(v, [19, 0]) >= 0 && cmp(v, [20, 0]) < 0) return "lowMeshes";
  return "unavailable";
}

/** Level + note for a version, without asking Rust (browser preview, instant UI). */
export function bubbleInfoFor(version: string): BubbleBuildsInfo {
  const level = bubbleLevelFor(version);
  const note =
    level === "supported"
      ? bubbleText.hint
      : level === "experimental"
        ? bubbleText.experimentalHint
        : level === "lowMeshes"
          ? bubbleText.lowMeshesHint
          : unavailableHint(version);
  return { level, note };
}
