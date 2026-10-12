import type { Game, PlayStats } from "./types";

export interface SmartCollection {
  id: string;
  icon: string;
  color: string;
  nameKey: string;
  filter: (g: Game, s: PlayStats | undefined, now: number) => boolean;
}

const DAY = 86400000;

/** Sammlungen, die sich selbst füllen */
export const SMART: SmartCollection[] = [
  { id: "smart-backlog", icon: "Bookmark", color: "#8b5cf6", nameKey: "collections.smartBacklog", filter: (g) => g.kind === "game" && g.status === "want" },
  { id: "smart-unplayed", icon: "Sparkles", color: "#60a5fa", nameKey: "collections.smartUnplayed", filter: (g, s) => g.kind === "game" && !s },
  { id: "smart-forgotten", icon: "Ghost", color: "#a78bfa", nameKey: "collections.smartForgotten", filter: (g, s, now) => g.kind === "game" && !!s?.lastPlayedAt && now - s.lastPlayedAt > 60 * DAY && g.status !== "done" },
  { id: "smart-short", icon: "Zap", color: "#fbbf24", nameKey: "collections.smartShort", filter: (g, s) => g.kind === "game" && !!s && s.sessions >= 2 && s.totalSeconds / s.sessions < 45 * 60 },
  { id: "smart-marathon", icon: "Flame", color: "#ff4f8b", nameKey: "collections.smartMarathon", filter: (g, s) => g.kind === "game" && (s?.totalSeconds ?? 0) >= 30 * 3600 },
  { id: "smart-top", icon: "Star", color: "#f59e0b", nameKey: "collections.smartTopRated", filter: (g) => g.rating >= 4.5 },
  { id: "smart-done", icon: "Trophy", color: "#34d399", nameKey: "collections.smartDone", filter: (g) => g.status === "done" },
];
