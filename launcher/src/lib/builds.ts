/* Small helpers for showing a build the same way on every page. */
import { parseVersionNumber } from "./bubble";

/** Each chapter gets its own slant of the anodised-niobium colours (Tailwind gradient stops). */
export function coverGradient(version: string): string {
  const major = parseVersionNumber(version)?.[0] ?? 0;
  if (major <= 10) return "from-brand-blue/55 via-[#2a2f8f]/45 to-brand-violet/20"; // Chapter 1
  if (major <= 18) return "from-brand-violet/55 via-[#3a2390]/45 to-brand-blue/25"; // Chapter 2
  if (major <= 22) return "from-[#4b3cff]/55 via-brand-violet/40 to-[#1d2a7a]/30"; // Chapter 3
  if (major <= 27) return "from-brand-violet/50 via-[#5a2aa8]/40 to-gold/15"; // Chapter 4 + OG
  return "from-brand-blue/50 via-brand-violet/45 to-gold/20"; // Chapter 5
}

/** Last part of the build folder, e.g. "windows-19.10" – tells two builds of one version apart. */
export function buildFolderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
