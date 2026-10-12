import {
  Camera, CalendarCheck, CalendarHeart, Clock, Crown, Dices, Flag, Flame, Folder, FolderHeart, Gamepad2, Ghost, Gift, Heart, Hourglass,
  Keyboard, Library, Moon, Music, Orbit, Rocket, Shapes, ShieldCheck, Sparkles, Star, Sunrise, Swords, Trophy, Tv, Users, Zap, Car,
  Brain, Coffee, Crosshair, Mountain, Puzzle, Skull, Sword, Wand2, Bookmark, Leaf, type LucideIcon,
} from "lucide-react";

/** Kuratierte Icon-Auswahl für Sammlungen und Erfolge (hält das Programm schlank) */
export const ICONS: Record<string, LucideIcon> = {
  Camera, CalendarCheck, CalendarHeart, Clock, Crown, Dices, Flag, Flame, Folder, FolderHeart, Gamepad2, Ghost, Gift, Heart, Hourglass,
  Keyboard, Library, Moon, Music, Orbit, Rocket, Shapes, ShieldCheck, Sparkles, Star, Sunrise, Swords, Trophy, Tv, Users, Zap, Car,
  Brain, Coffee, Crosshair, Mountain, Puzzle, Skull, Sword, Wand2, Bookmark, Leaf,
};

export const COLLECTION_ICONS = ["Folder", "Heart", "Users", "Flag", "Car", "Swords", "Ghost", "Brain", "Puzzle", "Coffee", "Trophy", "Star", "Flame", "Rocket", "Mountain", "Music", "Gamepad2", "Leaf", "Skull", "Wand2", "Crosshair", "Bookmark"];

export function Icon({ name, className, strokeWidth }: { name: string; className?: string; strokeWidth?: number }) {
  const C = ICONS[name] ?? Folder;
  return <C className={className} strokeWidth={strokeWidth} />;
}
