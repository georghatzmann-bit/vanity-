/*
 * Trickshot parkours from src/data/parkours.json.
 * The same file is built into the launcher (Rust, include_str!) and written at start to
 * %LOCALAPPDATA%\Rift\server\parkours.json – the server and the F9 menu read it there.
 */
import raw from "@/data/parkours.json";

/** [forward, right, up] in metres, seen from the start point. */
export type Vec3 = [number, number, number];
/** [width, depth] in floor tiles of 5.12 m each. [0, 0] = no tile. */
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
  /** Metres above you; 0 = on the ground */
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

/** Size of one floor tile in metres. */
export const TILE_METERS = 5.12;

export function kindLabel(kind: string): string {
  return parkourFile.kinds[kind]?.label ?? kind;
}

/** "easy", "medium" or "hard". */
export function levelWord(level: number): string {
  return level <= 1 ? "easy" : level === 2 ? "medium" : "hard";
}
