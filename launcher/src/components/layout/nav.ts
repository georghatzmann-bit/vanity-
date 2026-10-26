import {
  Bug,
  Gamepad2,
  Info,
  Library,
  type LucideIcon,
  PanelsTopLeft,
  ScrollText,
  Settings,
  Swords,
  UserRound,
  Users,
} from "lucide-react";
import type { PageId } from "@/lib/store";

export interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
}

/** Sidebar groups (page ids stay the same, labels are what the user sees). */
export const navGroups: { title: string; items: NavItem[] }[] = [
  {
    title: "Play",
    items: [
      { id: "start", label: "Home", icon: Gamepad2 },
      { id: "library", label: "Library", icon: Library },
      { id: "servers", label: "Servers & Friends", icon: Users },
    ],
  },
  {
    title: "Host",
    items: [{ id: "match", label: "Match Control", icon: Swords }],
  },
  {
    title: "Customize",
    items: [
      { id: "ingame", label: "In-game Menu", icon: PanelsTopLeft },
      { id: "profiles", label: "Profiles", icon: UserRound },
    ],
  },
  {
    title: "Help",
    items: [
      { id: "logs", label: "Live Log", icon: ScrollText },
      { id: "crashes", label: "Crash Analysis", icon: Bug },
    ],
  },
];

export const navFooter: NavItem[] = [
  { id: "settings", label: "Settings", icon: Settings },
  { id: "about", label: "About & Credits", icon: Info },
];

const all = [...navGroups.flatMap((g) => g.items), ...navFooter];

/** Label of a page, e.g. "Match Control". */
export function pageLabel(id: PageId): string {
  return all.find((n) => n.id === id)?.label ?? "";
}

/** Sidebar group of a page ("Play", "Host" …) – handy as an eyebrow above the page title. */
export function pageGroup(id: PageId): string {
  return navGroups.find((g) => g.items.some((i) => i.id === id))?.title ?? "";
}
