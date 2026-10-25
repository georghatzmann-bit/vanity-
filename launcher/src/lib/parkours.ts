/*
 * Trickshot-Parkours aus src/data/parkours.json.
 * Dieselbe Datei steckt im Launcher (Rust, include_str!) und wird beim Start nach
 * %LOCALAPPDATA%\Vanity\server\parkours.json geschrieben – dort lesen Server und F9-Menü.
 */
import raw from "@/data/parkours.json";

/** [vorne, rechts, oben] in Metern, vom Startpunkt aus gesehen. */
export type Vec3 = [number, number, number];
/** [breite, tiefe] in Boden-Platten zu je 5,12 m. [0, 0] = keine Platte. */
export type Tiles = [number, number];

export interface ParkourKind {
  label: string;
  summon: string[];
}

export interface ParkourElement {
  kind: string;
  at: Vec3;
  platform?: Tiles;
}

export interface ParkourBot {
  at: Vec3;
  hp: number;
  platform?: Tiles;
}

export interface Parkour {
  id: string;
  name: string;
  level: number;
  description: string;
  /** Meter über dir; 0 = am Boden */
  height: number;
  platform: Tiles;
  elements: ParkourElement[];
  bots: ParkourBot[];
}

export interface ParkourFile {
  version: number;
  kinds: Record<string, ParkourKind>;
  snipers: string[];
  parkours: Parkour[];
}

export const parkourFile = raw as unknown as ParkourFile;
export const parkours: Parkour[] = parkourFile.parkours;

/** Größe einer Boden-Platte in Metern. */
export const TILE_METERS = 5.12;

export function kindLabel(kind: string): string {
  return parkourFile.kinds[kind]?.label ?? kind;
}

export function levelWord(level: number): string {
  return level <= 1 ? "leicht" : level === 2 ? "mittel" : "schwer";
}
