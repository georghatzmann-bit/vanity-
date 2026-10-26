/*
 * "Bosses & NPCs" (living world) – texts, the 1–100 rule and the status chip text.
 *
 * Rust has the same rule (launcher/core/src/livingworld.rs). With the switch on, the launcher sends
 * `bLivingWorld` and `LivingWorldMaxAI` before the map loads; the server answers with the event
 * "server:livingWorld". Still being built on the server: spawning comes season by season, and until a
 * season has it the server answers "unavailable" with the reason.
 */
import type { LivingWorldEvent } from "./api";

export const LIVING_WORLD_MAX_MIN = 1;
export const LIVING_WORLD_MAX_MAX = 100;
export const LIVING_WORLD_MAX_DEFAULT = 40;

export const livingWorldText = {
  section: "Bosses & NPCs",
  badge: "Experimental",
  switchLabel: "Bosses & NPCs",
  hint: "Bosses, guards and creatures of this season walk around, like back then. Still being built: not every season has them yet.",
  maxLabel: "Max. bosses & NPCs",
  /** Profile tag while it is on. */
  tag: "Bosses & NPCs",
  /** Toast title when the server says it can't do it this match. */
  unavailableTitle: "Bosses & NPCs aren't available this match",
} as const;

export function clampLivingWorldMax(n: number): number {
  if (!Number.isFinite(n)) return LIVING_WORLD_MAX_DEFAULT;
  return Math.min(LIVING_WORLD_MAX_MAX, Math.max(LIVING_WORLD_MAX_MIN, Math.round(n)));
}

export type LivingWorldTone = "success" | "warning" | "muted";

/**
 * Text and colour of the status chip: "Active · 12 spawned" ("Active" while none are there yet, e.g. right
 * at "Start match"), "Not available: <reason>" or "Off" (the store never keeps an "off" answer, so the chip
 * isn't shown then).
 */
export function livingWorldStatus(ev: LivingWorldEvent): { text: string; tone: LivingWorldTone } {
  if (ev.state === "active") return { text: ev.spawned > 0 ? `Active · ${ev.spawned} spawned` : "Active", tone: "success" };
  if (ev.state === "unavailable") return { text: ev.reason ? `Not available: ${ev.reason}` : "Not available", tone: "warning" };
  return { text: "Off", tone: "muted" };
}
