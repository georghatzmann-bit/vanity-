// =============================================================================
// Bauteile: Form, Kollision und Aussehen
// =============================================================================
// Für jedes Bauteil (Wand, Boden, Rampe, Dach) steht hier:
//   - pieceColliderSpecs(): aus welchen Kollisions-Teilen es besteht – je nach Edit
//     (wie in Fortnite):
//       Wand  – gewählte Felder fallen weg (Boxen, zusammengefasst). Tür (Felder 4+7):
//               zusätzlich ein Tür-Blatt. Besondere Formen: Dreieck (L aus 3 Feldern in
//               einer Ecke weg), Bogen (untere zwei Reihen weg), halber Bogen (2x2 Felder
//               unten in einer Ecke weg) – Bild = echte Form, Kollision = schmale Boxen.
//       Boden – gewählte Felder fallen weg (Boxen).
//       Rampe – der gezogene WEG bleibt als Treppe (piece.editPath, Reihenfolge zählt):
//               2 Felder = halbe Rampe, 3 Felder (L) = L-Treppe, 4 Felder (U) = U-Treppe.
//       Dach  – gewählte Ecken werden HOCHGEZOGEN (auf Spitzen-Höhe), die Mitte bleibt
//               oben: 4 Dreiecke (siehe physics.js, spec.raise).
//   - Formen (BufferGeometry) aus denselben Teilen → Bild = Kollision (besondere Wände:
//     Bild = echte Form, Kollision nähert sie an).
//   - Bilder (Texturen) per Canvas: Holz (Bretter), Stein (Fugen), Metall (Nieten),
//     dazu je eine Version mit Rissen (beschädigt). Jedes Bild ist ein "Atlas" mit drei
//     Bereichen (Wand S x H, Fläche S x S, Rampe S x Schräg-Länge) – so ist nichts verzerrt,
//     obwohl die Wand (5,12 x 3,84 m) nicht quadratisch ist.
//   - Edit-Felder: Kacheln zum Anzeigen und pickTile() (welches Feld liegt unter
//     dem Fadenkreuz?).
// Die Rechnungen (Kollision, Feld-Wahl) laufen auch ohne Bildschirm. Nur die
// Funktionen mit "Geometry", "Texture" oder "Material" brauchen Three.js-Grafik.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { pyramidFacePlane } from '../physics.js';
import {
  CELL_SIZE as S, LEVEL_HEIGHT as H, THICKNESS as T, RAMP_V_THICKNESS, ROOF_V_THICKNESS,
  rampSpec, roofSpec, presentRects, isDoorMask, tilesToMask,
} from './grid.js';

const B = CONFIG.building;
const DOOR_MASK = tilesToMask(B.wallDoorCells);

// -----------------------------------------------------------------------------
// Bild-Atlas: Lage der drei Bereiche im Bild (von oben nach unten, in Metern gerechnet)
// -----------------------------------------------------------------------------
//   Wand   – S breit, H hoch (senkrechte Flächen: Wände, Seiten)
//   Fläche – S x S (waagerechte Flächen: Boden, Dach von oben)
//   Rampe  – S breit, so hoch wie die schräge Länge der Rampe (Bretter quer = Stufen)
// Dazwischen ein schmaler Rand (gegen "Durchbluten" der Nachbar-Bereiche).
const RAMP_LENGTH = Math.hypot(S, H);
const ATLAS_PAD = S * 0.04;
const ATLAS_TOTAL = H + S + RAMP_LENGTH + 2 * ATLAS_PAD;
/** Bereiche des Atlas: top = Anfang (Anteil der Bild-Höhe von oben), size = Höhe (Anteil), meters = Höhe in m */
export const ATLAS = Object.freeze({
  total: ATLAS_TOTAL,
  side: Object.freeze({ top: 0, size: H / ATLAS_TOTAL, meters: H }),
  flat: Object.freeze({ top: (H + ATLAS_PAD) / ATLAS_TOTAL, size: S / ATLAS_TOTAL, meters: S }),
  ramp: Object.freeze({ top: (H + S + 2 * ATLAS_PAD) / ATLAS_TOTAL, size: RAMP_LENGTH / ATLAS_TOTAL, meters: RAMP_LENGTH }),
});
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Bild-Koordinate v (0 = unten im Bild, 1 = oben – wie three.js) für eine Stelle im Bereich;
// local 0 = Unterkante des Bereichs, 1 = Oberkante
function atlasV(region, local) {
  return 1 - region.top - region.size + clamp01(local) * region.size;
}
/** senkrechte Fläche: Höhe y über der Zellen-Unterkante (m) → v */
export function sideV(y) {
  return atlasV(ATLAS.side, y / H);
}
/** waagerechte Fläche: Anteil 0..1 der Zelle → v */
export function flatV(f) {
  return atlasV(ATLAS.flat, f);
}
/** Rampen-Fläche: Anteil 0..1 entlang des Anstiegs → v */
export function rampV(f) {
  return atlasV(ATLAS.ramp, f);
}

// -----------------------------------------------------------------------------
// Kollisions-Teile je Edit
// -----------------------------------------------------------------------------

/**
 * Kollisions-Teile eines Bauteils im aktuellen Zustand.
 * piece = { type, kind, i, j, k, dir, editMask, editPath? (Rampe) }
 * Ergebnis: Liste von { type: 'box', min: {x,y,z}, max: {x,y,z}, door?: true }
 *                  und { type: 'slope', spec }
 * Bei einer Tür ist das Tür-Blatt dabei (door: true) – offen = ausgeschaltet.
 */
export function pieceColliderSpecs(piece) {
  const out = [];
  const mask = piece.editMask | 0;
  const { kind, i, j, k } = piece;
  if (piece.type === 'wall') {
    const shape = wallShapeOf(mask);
    if (shape) {
      // Dreieck / Bogen: schmale Boxen (Annäherung an Schräge und Rundung)
      for (const r of shape.boxes) out.push(wallBox(kind, i, j, k, r.u0, r.u1, r.v0, r.v1, T / 2));
      return out;
    }
    const third = S / 3;
    const rowH = H / 3;
    for (const r of presentRects(3, 3, mask)) {
      const u0 = r.col0 * third;
      const u1 = (r.col0 + r.cols) * third;
      const v1 = (3 - r.row0) * rowH;
      const v0 = (3 - r.row0 - r.rows) * rowH;
      out.push(wallBox(kind, i, j, k, u0, u1, v0, v1, T / 2));
    }
    if (isDoorMask('wall', mask)) {
      // Tür-Blatt: immer dabei, das Bau-System schaltet es aus, wenn die Tür offen ist
      const door = doorRect();
      const box = wallBox(kind, i, j, k, door.u0, door.u1, door.v0, door.v1, T / 2);
      box.door = true;
      out.push(box);
    }
    return out;
  }
  if (piece.type === 'floor') {
    const half = S / 2;
    for (const r of presentRects(2, 2, mask)) {
      out.push({
        type: 'box',
        min: { x: i * S + r.col0 * half, y: j * H - T / 2, z: k * S + r.row0 * half },
        max: { x: i * S + (r.col0 + r.cols) * half, y: j * H + T / 2, z: k * S + (r.row0 + r.rows) * half },
      });
    }
    return out;
  }
  if (piece.type === 'ramp') {
    const path = rampPathOf(piece);
    if (path) rampPathSpecs(piece, path, out);
    else out.push({ type: 'slope', spec: rampSpec(i, j, k, piece.dir) });
    return out;
  }
  // Dach: gewählte Ecken hochgezogen (alle 4 gibt es nicht)
  const spec = roofSpec(i, j, k);
  const raise = mask & 15;
  if (raise && raise !== 15) spec.raise = raise;
  out.push({ type: 'slope', spec });
  return out;
}

/** Schlüssel der Edit-Form (für geteilte Formen in der Grafik): 0 = unbearbeitet. */
export function pieceEditKey(piece) {
  if (piece.type === 'ramp') {
    const path = rampPathOf(piece);
    return path ? `p${path.join('')}` : 0;
  }
  return piece.editMask | 0;
}

/** Ist das Teil editiert (Löcher, besondere Form, Treppe, hochgezogene Ecken)? */
export function isPieceEdited(piece) {
  return pieceEditKey(piece) !== 0;
}

// -----------------------------------------------------------------------------
// Besondere Wand-Formen (Fortnite): Dreieck, Bogen, halber Bogen
// -----------------------------------------------------------------------------
// Felder der Wand: Nummer = Reihe·3 + Spalte, Reihe 0 = oben. u = entlang der Wand
// (0..S), v = Höhe (0..H). Ergebnis von wallShapeOf(mask):
//   { name, poly: [[u, v], …] (Umriss gegen den Uhrzeigersinn), boxes: [{ u0, u1, v0, v1 }] }

const _wallShapes = new Map();

/** Besondere Wand-Form zu den entfernten Feldern – oder null (dann normale Löcher). */
export function wallShapeOf(mask) {
  mask |= 0;
  if (_wallShapes.has(mask)) return _wallShapes.get(mask);
  const shape = makeWallShape(mask);
  _wallShapes.set(mask, shape);
  return shape;
}

// Dreiecke: L aus 3 Feldern in einer Ecke weg → das Dreieck auf der anderen Seite der Diagonale
const TRIANGLES = [
  { tiles: [1, 2, 5], poly: [[0, 0], [1, 0], [0, 1]] }, // oben rechts weg
  { tiles: [0, 1, 3], poly: [[0, 0], [1, 0], [1, 1]] }, // oben links weg
  { tiles: [5, 7, 8], poly: [[0, 0], [1, 1], [0, 1]] }, // unten rechts weg (hängt oben)
  { tiles: [3, 6, 7], poly: [[1, 0], [1, 1], [0, 1]] }, // unten links weg (hängt oben)
];

function makeWallShape(mask) {
  for (const t of TRIANGLES) {
    if (mask !== tilesToMask(t.tiles)) continue;
    const poly = t.poly.map(([u, v]) => [u * S, v * H]);
    // Kollision: senkrechte Streifen, Höhe in der Mitte jedes Streifens
    const n = Math.max(2, B.wallCollisionSlices | 0);
    const boxes = [];
    for (let s = 0; s < n; s++) {
      const u0 = (s / n) * S;
      const u1 = ((s + 1) / n) * S;
      const range = polyVerticalRange(poly, (u0 + u1) / 2);
      if (range) boxes.push({ u0, u1, v0: range[0], v1: range[1] });
    }
    return { name: 'triangle', poly, boxes };
  }
  const V0 = (2 * H) / 3; // Unterkante der oberen Reihe
  if (mask === tilesToMask([3, 4, 5, 6, 7, 8])) {
    // Bogen: obere Reihe + dünne Beine, Rundung zwischen Bein und oberer Reihe
    const L = B.wallArchLegWidth;
    const poly = [[0, 0], [L, 0]];
    arcPoints(poly, L, V0, 1);
    arcPoints(poly, S - L, V0, -1);
    poly.push([S - L, 0], [S, 0], [S, H], [0, H]);
    const boxes = [
      { u0: 0, u1: L, v0: 0, v1: V0 },
      { u0: S - L, u1: S, v0: 0, v1: V0 },
      { u0: 0, u1: S, v0: V0, v1: H },
    ];
    cornerBoxes(boxes, L, V0, 1);
    cornerBoxes(boxes, S - L, V0, -1);
    return { name: 'arch', poly, boxes };
  }
  for (const side of [1, -1]) {
    // halber Bogen: 2x2 Felder unten rechts (side 1) bzw. unten links (−1) weg
    const tiles = side === 1 ? [4, 5, 7, 8] : [3, 4, 6, 7];
    if (mask !== tilesToMask(tiles)) continue;
    const C = side === 1 ? S / 3 : (2 * S) / 3; // Innenkante der stehenden Spalte
    let poly;
    if (side === 1) {
      poly = [[0, 0], [C, 0]];
      arcPoints(poly, C, V0, 1);
      poly.push([S, V0], [S, H], [0, H]);
    } else {
      poly = [[0, V0]];
      arcPoints(poly, C, V0, -1);
      poly.push([C, 0], [S, 0], [S, H], [0, H]);
    }
    const boxes = [
      side === 1 ? { u0: 0, u1: C, v0: 0, v1: V0 } : { u0: C, u1: S, v0: 0, v1: V0 },
      { u0: 0, u1: S, v0: V0, v1: H },
    ];
    cornerBoxes(boxes, C, V0, side);
    return { name: 'halfArch', poly, boxes };
  }
  return null;
}

// Punkte der Viertel-Ellipse an der Ecke (Bein-Innenkante c, Unterkante V0). side 1 = Rundung
// rechts vom Bein (linke Ecke der Öffnung), −1 = links vom Bein. Reihenfolge: entlang des
// Umrisses gegen den Uhrzeigersinn.
function arcPoints(poly, c, V0, side) {
  const ru = B.wallArchCornerU;
  const rv = B.wallArchCornerV;
  const n = Math.max(2, B.wallCurveSegments | 0);
  const cu = c + side * ru;
  const cv = V0 - rv;
  for (let s = 0; s <= n; s++) {
    // side 1: vom Bein (unten) zur Decke; side −1: von der Decke zum Bein (unten)
    const f = side === 1 ? s / n : 1 - s / n;
    const angle = (f * Math.PI) / 2; // 0 = am Bein, 90° = an der Decke
    poly.push([cu - side * ru * Math.cos(angle), cv + rv * Math.sin(angle)]);
  }
}

// Kollision der Rundung: schmale Streifen von der Rundung bis zur Decke
function cornerBoxes(boxes, c, V0, side) {
  const ru = B.wallArchCornerU;
  const rv = B.wallArchCornerV;
  const n = Math.max(1, B.wallCurveSlices | 0);
  for (let s = 0; s < n; s++) {
    const a = c + side * (s / n) * ru;
    const b = c + side * ((s + 1) / n) * ru;
    const mid = Math.abs((a + b) / 2 - (c + side * ru)) / ru; // 0..1 Abstand zur Ellipsen-Mitte
    const v0 = V0 - rv + rv * Math.sqrt(Math.max(0, 1 - mid * mid));
    boxes.push({ u0: Math.min(a, b), u1: Math.max(a, b), v0, v1: V0 });
  }
}

// Senkrechter Schnitt eines konvexen Umrisses bei u → [vMin, vMax] oder null
function polyVerticalRange(poly, u) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let n = 0; n < poly.length; n++) {
    const [ua, va] = poly[n];
    const [ub, vb] = poly[(n + 1) % poly.length];
    if ((u < Math.min(ua, ub)) || (u > Math.max(ua, ub)) || ua === ub) continue;
    const v = va + ((u - ua) / (ub - ua)) * (vb - va);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi > lo ? [lo, hi] : null;
}

// -----------------------------------------------------------------------------
// Rampen-Edit wie in Fortnite: der gezogene Weg bleibt als Treppe
// -----------------------------------------------------------------------------
// Felder 0..3: Spalte = t % 2 (entlang x), Reihe = floor(t / 2) (entlang z).
// Der Weg (piece.editPath) ist die Reihenfolge, in der die Felder gezogen wurden – jedes
// Feld liegt neben dem vorigen. Alle Treppen sind so steil wie die ganze Rampe.
//   2 Felder (P0, P1)     → HALBE RAMPE: halbe Breite, ganze Länge und Höhe, steigt von P0 zu P1.
//   3 Felder (L)          → L-TREPPE: Lauf P0→P1 bis zur halben Höhe, Podest auf P1,
//                           Lauf P1→P2 ganz hinauf.
//   4 Felder (U)          → U-TREPPE: Lauf P0→P1 bis zur halben Höhe, Podest über P1 und P2,
//                           Lauf P2→P3 ganz hinauf.
// 0 oder 1 Feld ändert nichts. editMask = die Felder, die NICHT auf dem Weg liegen.

/** Richtung (0 = +X, 1 = +Z, 2 = −X, 3 = −Z) von Feld p zum Nachbar-Feld q, sonst −1. */
export function tileDirection(p, q) {
  const dx = (q % 2) - (p % 2);
  const dz = Math.floor(q / 2) - Math.floor(p / 2);
  if (dx === 1 && dz === 0) return 0;
  if (dx === 0 && dz === 1) return 1;
  if (dx === -1 && dz === 0) return 2;
  if (dx === 0 && dz === -1) return 3;
  return -1;
}

/** Rechteck eines Rampen-Felds in der Welt. */
function rampTileRect(i, k, t) {
  const half = S / 2;
  const x0 = i * S + (t % 2) * half;
  const z0 = k * S + Math.floor(t / 2) * half;
  return { minX: x0, maxX: x0 + half, minZ: z0, maxZ: z0 + half };
}

// Wie hoch lag Feld t bei der ganzen Rampe (Richtung d)? 0 = untere Hälfte, 1 = obere
function rampTileRank(d, t) {
  const col = t % 2;
  const row = Math.floor(t / 2);
  if (d === 0) return col;
  if (d === 2) return 1 - col;
  if (d === 1) return row;
  return 1 - row;
}

/** Ist das ein gültiger Rampen-Weg (2–4 verschiedene Felder, jedes neben dem vorigen)? */
export function isRampPath(path) {
  if (!Array.isArray(path) || path.length < 2 || path.length > 4) return false;
  for (let n = 0; n < path.length; n++) {
    const t = path[n];
    if (!Number.isInteger(t) || t < 0 || t > 3 || path.indexOf(t) !== n) return false;
    if (n > 0 && tileDirection(path[n - 1], t) < 0) return false;
  }
  return true;
}

/**
 * Weg aus den entfernten Feldern (für alte Angaben wie placePiece(…, { edit: [0, 2] })):
 * 2 Felder in einer Reihe → halbe Rampe (steigt wie die ganze, quer dazu 90° weiter gedreht),
 * 3 Felder (L) → L-Treppe, die unten beginnt, wo die ganze Rampe unten war. Sonst null.
 */
export function rampPathFromMask(dir, removedMask) {
  const d = ((dir % 4) + 4) % 4;
  const kept = [];
  for (let t = 0; t < 4; t++) if (!(removedMask & (1 << t))) kept.push(t);
  if (kept.length === 2) {
    const [a, b] = kept;
    const ab = tileDirection(a, b);
    if (ab < 0) return null;
    const alongX = ab % 2 === 0;
    const want = (d % 2 === 0) === alongX ? d : (d + 1) % 4;
    return ab === want ? [a, b] : [b, a];
  }
  if (kept.length === 3) {
    const corner = kept.find((t) => kept.every((o) => o === t || tileDirection(t, o) >= 0));
    if (corner === undefined) return null;
    const ends = kept.filter((t) => t !== corner);
    const low = rampTileRank(d, ends[0]) <= rampTileRank(d, ends[1]) ? ends[0] : ends[1];
    return [low, corner, low === ends[0] ? ends[1] : ends[0]];
  }
  return null;
}

/** Weg einer Rampe (piece.editPath, sonst aus der Maske) oder null = ganze Rampe. */
export function rampPathOf(piece) {
  if (isRampPath(piece.editPath)) return piece.editPath;
  const mask = piece.editMask | 0;
  return mask ? rampPathFromMask(piece.dir, mask) : null;
}

/** Felder eines Wegs als Bitmaske. */
export function pathMask(path) {
  let mask = 0;
  for (const t of path) mask |= 1 << t;
  return mask;
}

/** Kollisions-Teile einer Rampe mit Weg (halbe Rampe, L-Treppe, U-Treppe). */
export function rampPathSpecs(piece, path, out = []) {
  const { i, j, k } = piece;
  const baseY = j * H;
  if (path.length === 2) {
    const a = rampTileRect(i, k, path[0]);
    const b = rampTileRect(i, k, path[1]);
    out.push({
      type: 'slope',
      spec: {
        minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
        minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
        baseY, rise: H, dir: tileDirection(path[0], path[1]), thickness: T,
      },
      stair: 'half',
    });
    return out;
  }
  // unterer Lauf: auf dem ersten Feld bis zur halben Höhe
  out.push({ type: 'slope', spec: { ...rampTileRect(i, k, path[0]), baseY, rise: H / 2, dir: tileDirection(path[0], path[1]), thickness: T }, stair: 'low' });
  // Podest: L = Feld P1, U = Felder P1 und P2
  const l0 = rampTileRect(i, k, path[1]);
  const l1 = path.length === 4 ? rampTileRect(i, k, path[2]) : l0;
  out.push({
    type: 'box',
    min: { x: Math.min(l0.minX, l1.minX), y: baseY + H / 2 - T, z: Math.min(l0.minZ, l1.minZ) },
    max: { x: Math.max(l0.maxX, l1.maxX), y: baseY + H / 2, z: Math.max(l0.maxZ, l1.maxZ) },
    stair: 'landing',
  });
  // oberer Lauf: auf dem letzten Feld ganz hinauf
  const n = path.length;
  out.push({ type: 'slope', spec: { ...rampTileRect(i, k, path[n - 1]), baseY: baseY + H / 2, rise: H / 2, dir: tileDirection(path[n - 2], path[n - 1]), thickness: T }, stair: 'high' });
  return out;
}

/** Lage der Tür in der Wand (u entlang der Wand, v von unten), in Metern. */
export function doorRect() {
  // Tür-Felder 4 und 7 = mittlere Spalte, Reihe 1 und 2 (unten)
  return { u0: S / 3, u1: (2 * S) / 3, v0: 0, v1: (2 * H) / 3 };
}

/** Ist das Bauteil gerade eine Tür? */
export function isDoorPiece(piece) {
  return piece.type === 'wall' && (piece.editMask | 0) === DOOR_MASK;
}

// Box eines Wand-Stücks: u = entlang der Wand, v = Höhe über j·H, halbe Dicke d
function wallBox(kind, i, j, k, u0, u1, v0, v1, d) {
  if (kind === 'wx') {
    return { type: 'box', min: { x: i * S + u0, y: j * H + v0, z: k * S - d }, max: { x: i * S + u1, y: j * H + v1, z: k * S + d } };
  }
  return { type: 'box', min: { x: i * S - d, y: j * H + v0, z: k * S + u0 }, max: { x: i * S + d, y: j * H + v1, z: k * S + u1 } };
}

/**
 * Mittelpunkt ("Ursprung") eines Bauteils für die Grafik: Boden/Rampe/Dach = Mitte
 * der Zelle auf Höhe j·H, Wand = Mitte der Wand-Unterkante.
 */
export function pieceOrigin(piece, out = new THREE.Vector3()) {
  const { kind, i, j, k } = piece;
  if (kind === 'wx') return out.set(i * S + S / 2, j * H, k * S);
  if (kind === 'wz') return out.set(i * S, j * H, k * S + S / 2);
  return out.set(i * S + S / 2, j * H, k * S + S / 2);
}

/**
 * Mitte des ganzen Bauteils (z. B. für Splitter-Effekte und Töne).
 * out = THREE.Vector3 oder { x, y, z }
 */
export function pieceCenter(piece, out = new THREE.Vector3()) {
  const { kind, i, j, k } = piece;
  const y = kind === 'f' ? j * H : kind === 'c' ? j * H + B.roofHeight / 2 : j * H + H / 2;
  const x = kind === 'wz' ? i * S : i * S + S / 2;
  const z = kind === 'wx' ? k * S : k * S + S / 2;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * Höchstes Leben, das ein Teil JETZT haben kann: im Aufbau wächst es von
 * startHealthFraction auf 100 % (structure.js), danach maxHealth.
 */
export function pieceHealthCap(piece) {
  if (!(piece.buildProgress < 1)) return piece.maxHealth;
  const f = CONFIG.materials.startHealthFraction;
  return piece.maxHealth * (f + (1 - f) * Math.max(0, piece.buildProgress));
}

/**
 * Leben als Anteil 0..1 – im Aufbau gemessen am jetzt möglichen Höchstwert. So ist
 * ein frisch gesetztes, unbeschädigtes Teil "heil" (keine Risse, nicht dunkel);
 * Treffer während des Aufbaus zeigen sich trotzdem.
 */
export function pieceHealthFraction(piece) {
  const cap = pieceHealthCap(piece);
  return cap > 0 ? Math.max(0, Math.min(1, piece.health / cap)) : 0;
}

/** Drehung (um die Hochachse) für die gemeinsame Form eines Typs. */
export function pieceRotationY(piece) {
  if (piece.kind === 'wz') return -Math.PI / 2;
  if (piece.type === 'ramp') return RAMP_ROTATION[((piece.dir % 4) + 4) % 4];
  return 0;
}
// gemeinsame Rampen-Form steigt Richtung +X; so wird sie für dir 0..3 gedreht
const RAMP_ROTATION = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

// -----------------------------------------------------------------------------
// Edit-Felder: welches Feld liegt unter dem Fadenkreuz?
// -----------------------------------------------------------------------------

/**
 * Welches Edit-Feld trifft der Strahl? -1 = keins.
 * Gerechnet wird mit der GANZEN Fläche (auch über Löchern), damit man entfernte
 * Felder wieder anklicken kann.
 */
export function pickTile(piece, origin, dir, maxDist = Infinity, out = null) {
  const { kind, i, j, k } = piece;
  let t;
  if (kind === 'wx' || kind === 'wz') {
    const plane = kind === 'wx' ? k * S : i * S;
    const o = kind === 'wx' ? origin.z : origin.x;
    const d = kind === 'wx' ? dir.z : dir.x;
    if (Math.abs(d) < 1e-6) return -1;
    t = (plane - o) / d;
    if (t < 0 || t > maxDist) return -1;
    const along = kind === 'wx' ? origin.x + dir.x * t - i * S : origin.z + dir.z * t - k * S;
    const up = origin.y + dir.y * t - j * H;
    if (along < 0 || along > S || up < 0 || up > H) return -1;
    const col = Math.min(2, Math.floor(along / (S / 3)));
    const row = 2 - Math.min(2, Math.floor(up / (H / 3)));
    if (out) out.distance = t;
    return row * 3 + col;
  }
  if (piece.type === 'floor') {
    if (Math.abs(dir.y) < 1e-6) return -1;
    t = (j * H - origin.y) / dir.y;
  } else if (piece.type === 'ramp') {
    const s = rampSpec(i, j, k, piece.dir, _spec);
    const slope = H / S;
    const a = s.dir === 0 ? slope : s.dir === 2 ? -slope : 0;
    const b = s.dir === 1 ? slope : s.dir === 3 ? -slope : 0;
    let c = s.baseY;
    if (s.dir === 0) c -= a * s.minX;
    else if (s.dir === 2) c -= a * s.maxX;
    else if (s.dir === 1) c -= b * s.minZ;
    else c -= b * s.maxZ;
    const denom = dir.y - a * dir.x - b * dir.z;
    if (Math.abs(denom) < 1e-6) return -1;
    t = (a * origin.x + b * origin.z + c - origin.y) / denom;
  } else {
    // Dach: die echten Dreiecks-Flächen (oben und unten, mit hochgezogenen Ecken) – genau
    // das, was man sieht und was das Fadenkreuz trifft
    t = roofHitDistance(i, j, k, origin, dir, maxDist, piece.editMask | 0);
    if (t === Infinity) return -1;
  }
  if (t < 0 || t > maxDist) return -1;
  const x = origin.x + dir.x * t - i * S;
  const z = origin.z + dir.z * t - k * S;
  if (x < 0 || x > S || z < 0 || z > S) return -1;
  const col = Math.min(1, Math.floor(x / (S / 2)));
  const row = Math.min(1, Math.floor(z / (S / 2)));
  if (out) out.distance = t;
  return row * 2 + col;
}
const _spec = {};

/**
 * Abstand, in dem der Strahl das Dach (Pyramide in Zelle i, j, k) trifft – Oberseite
 * oder Unterseite (= Oberseite − Dicke), je nachdem was näher ist. Infinity = gar nicht.
 * raise = hochgezogene Ecken (Bitmaske, wie piece.editMask beim Dach).
 * Jede der 4 Flächen ist ein Dreieck (Mitte – Ecke – Ecke) auf einer Ebene; sie gilt dort,
 * wo der Abstand von der Mitte in Richtung der Fläche ≥ |Abstand quer| ist (Grat = Diagonale).
 */
export function roofHitDistance(i, j, k, origin, dir, maxDist = Infinity, raise = 0) {
  const c = coneShape(i, j, k, raise);
  const h = S / 2;
  let best = Infinity;
  for (let face = 0; face < 4; face++) {
    // Fläche 0 = +X, 1 = −X, 2 = +Z, 3 = −Z (wie physics.js)
    const ax = face === 0 ? 1 : face === 1 ? -1 : 0;
    const az = face === 2 ? 1 : face === 3 ? -1 : 0;
    const plane = pyramidFacePlane(c, face, _facePlane);
    const denom = dir.y - plane.a * dir.x - plane.b * dir.z;
    if (Math.abs(denom) < 1e-9) continue;
    for (let side = 0; side < 2; side++) {
      const cc = plane.c - (side === 0 ? 0 : ROOF_V_THICKNESS);
      const t = (plane.a * origin.x + plane.b * origin.z + cc - origin.y) / denom;
      if (!(t >= 0 && t <= maxDist && t < best)) continue;
      const x = origin.x + dir.x * t - c.cx;
      const z = origin.z + dir.z * t - c.cz;
      const along = ax * x + az * z;
      const across = ax !== 0 ? Math.abs(z) : Math.abs(x);
      if (along < -1e-6 || along > h + 1e-6 || across > along + 1e-6) continue;
      best = t;
    }
  }
  return best;
}
const _facePlane = { a: 0, b: 0, c: 0 };
const _cone = { baseY: 0, rise: 0, cx: 0, cz: 0, hx: 1, hz: 1, h0: 0, h1: 0, h2: 0, h3: 0 };

// Dach in Zelle (i, j, k) mit hochgezogenen Ecken als Rechen-Form (wie der Collider in physics.js)
function coneShape(i, j, k, raise, out = _cone) {
  out.baseY = j * H;
  out.rise = B.roofHeight;
  out.cx = i * S + S / 2;
  out.cz = k * S + S / 2;
  out.hx = S / 2;
  out.hz = S / 2;
  const top = out.baseY + out.rise;
  out.h0 = raise & 1 ? top : out.baseY;
  out.h1 = raise & 2 ? top : out.baseY;
  out.h2 = raise & 4 ? top : out.baseY;
  out.h3 = raise & 8 ? top : out.baseY;
  return out;
}

/** Höhe der Dach-Oberseite (Zelle i, j, k, hochgezogene Ecken raise) an der Stelle (x, z). */
export function roofSurfaceY(i, j, k, raise, x, z) {
  const c = coneShape(i, j, k, raise);
  const u = Math.max(-1, Math.min(1, (x - c.cx) / c.hx));
  const w = Math.max(-1, Math.min(1, (z - c.cz) / c.hz));
  const top = c.baseY + c.rise;
  let s;
  let t;
  let ha;
  let hb;
  if (Math.abs(u) >= Math.abs(w)) {
    s = Math.abs(u);
    t = w;
    if (u >= 0) { ha = c.h1; hb = c.h3; } else { ha = c.h0; hb = c.h2; }
  } else {
    s = Math.abs(w);
    t = u;
    if (w >= 0) { ha = c.h2; hb = c.h3; } else { ha = c.h0; hb = c.h1; }
  }
  return top + s * ((ha + hb) / 2 - top) + (t * (hb - ha)) / 2;
}

// =============================================================================
// Grafik (nur mit Bildschirm)
// =============================================================================

// --- Formen aus Kollisions-Teilen ------------------------------------------------

/**
 * Form (BufferGeometry) aus Kollisions-Teilen, relativ zu "origin".
 * Bild-Koordinaten (UV) in Metern / Zellgröße, gemessen ab der Zellen-Ecke
 * (cellX, cellY, cellZ) – so passen Bretter/Fugen bei Edits genau zum ganzen Teil.
 * rampDir: für die Ausrichtung der Bretter auf Rampen.
 */
export function buildGeometryFromSpecs(specs, origin, cell, rampDir = 0) {
  const pos = [];
  const uv = [];
  for (const s of specs) {
    if (s.type === 'box') addBox(pos, uv, s.min, s.max, origin, cell);
    else if (s.spec.dir === 'pyramid') addPyramid(pos, uv, s.spec, origin, cell);
    else addRamp(pos, uv, s.spec, origin, cell, Number.isInteger(s.spec.dir) ? s.spec.dir : rampDir); // Bretter quer zur eigenen Richtung
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// Ein Viereck (2 Dreiecke) in fester Reihenfolge a-b-c-d (gegen den Uhrzeigersinn von außen)
function quad(pos, uv, a, b, c, d, ua, ub, uc, ud) {
  pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  uv.push(ua[0], ua[1], uc[0], uc[1], ud[0], ud[1]);
}

function addBox(pos, uv, min, max, o, cell) {
  const x0 = min.x - o.x;
  const x1 = max.x - o.x;
  const y0 = min.y - o.y;
  const y1 = max.y - o.y;
  const z0 = min.z - o.z;
  const z1 = max.z - o.z;
  // UV: Meter ab der Zellen-Ecke / Zellgröße; senkrechte Flächen im Wand-Bereich des
  // Atlas (Höhe / H), waagerechte im Flächen-Bereich
  const ux = (x) => (x + o.x - cell.x) / S;
  const uy = (y) => sideV(y + o.y - cell.y);
  const uz = (z) => (z + o.z - cell.z) / S;
  const fz = (z) => flatV(uz(z));
  // +X
  quad(pos, uv, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1],
    [1 - uz(z1), uy(y0)], [1 - uz(z0), uy(y0)], [1 - uz(z0), uy(y1)], [1 - uz(z1), uy(y1)]);
  // −X
  quad(pos, uv, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0],
    [uz(z0), uy(y0)], [uz(z1), uy(y0)], [uz(z1), uy(y1)], [uz(z0), uy(y1)]);
  // +Y
  quad(pos, uv, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0],
    [ux(x0), flatV(1 - uz(z1))], [ux(x1), flatV(1 - uz(z1))], [ux(x1), flatV(1 - uz(z0))], [ux(x0), flatV(1 - uz(z0))]);
  // −Y
  quad(pos, uv, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [ux(x0), fz(z0)], [ux(x1), fz(z0)], [ux(x1), fz(z1)], [ux(x0), fz(z1)]);
  // +Z
  quad(pos, uv, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    [ux(x0), uy(y0)], [ux(x1), uy(y0)], [ux(x1), uy(y1)], [ux(x0), uy(y1)]);
  // −Z
  quad(pos, uv, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [1 - ux(x1), uy(y0)], [1 - ux(x0), uy(y0)], [1 - ux(x0), uy(y1)], [1 - ux(x1), uy(y1)]);
}

// Höhe einer (Rampen-)Schräge: a·x + b·z + c (Steigung über die Länge der Schräge selbst –
// Teil-Rampen der Ecktreppe sind nur 2 m lang)
function rampPlane(spec) {
  const d = spec.dir;
  const run = d === 0 || d === 2 ? spec.maxX - spec.minX : spec.maxZ - spec.minZ;
  const slope = spec.rise / (run > 0 ? run : S);
  const a = d === 0 ? slope : d === 2 ? -slope : 0;
  const b = d === 1 ? slope : d === 3 ? -slope : 0;
  let c = spec.baseY;
  if (d === 0) c -= a * spec.minX;
  else if (d === 2) c -= a * spec.maxX;
  else if (d === 1) c -= b * spec.minZ;
  else c -= b * spec.maxZ;
  return { a, b, c };
}

function addRamp(pos, uv, spec, o, cell, rampDir) {
  const clip = spec.clip ?? spec;
  const { a, b, c } = rampPlane(spec);
  const vT = (spec.thickness ?? T) * Math.sqrt(1 + a * a + b * b); // Dicke senkrecht (wie physics.js)
  const x0 = clip.minX;
  const x1 = clip.maxX;
  const z0 = clip.minZ;
  const z1 = clip.maxZ;
  const h = (x, z) => a * x + b * z + c;
  // Bretter quer zur Rampe: u = quer, v = entlang des Anstiegs (ab der unteren Kante)
  const d = ((rampDir % 4) + 4) % 4;
  // v liegt im Rampen-Bereich des Atlas (so hoch wie die schräge Länge → nicht gestreckt)
  const tex = (x, z) => {
    const lx = x - cell.x;
    const lz = z - cell.z;
    if (d === 0) return [lz / S, rampV(lx / S)];
    if (d === 2) return [1 - lz / S, rampV(1 - lx / S)];
    if (d === 1) return [1 - lx / S, rampV(lz / S)];
    return [lx / S, rampV(1 - lz / S)];
  };
  const P = (x, y, z) => [x - o.x, y - o.y, z - o.z];
  const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const top = corners.map(([x, z]) => P(x, h(x, z), z));
  const bot = corners.map(([x, z]) => P(x, h(x, z) - vT, z));
  const tuv = corners.map(([x, z]) => tex(x, z));
  // oben (von oben gesehen gegen den Uhrzeigersinn: x0z1, x1z1, x1z0, x0z0)
  quad(pos, uv, top[3], top[2], top[1], top[0], tuv[3], tuv[2], tuv[1], tuv[0]);
  // unten
  quad(pos, uv, bot[0], bot[1], bot[2], bot[3], tuv[0], tuv[1], tuv[2], tuv[3]);
  // Seiten
  sideQuad(pos, uv, top, bot, 0, 1, cell, o); // z0 (−Z)
  sideQuad(pos, uv, top, bot, 1, 2, cell, o); // x1 (+X)
  sideQuad(pos, uv, top, bot, 2, 3, cell, o); // z1 (+Z)
  sideQuad(pos, uv, top, bot, 3, 0, cell, o); // x0 (−X)
}

// senkrechte Seite zwischen Ecke m und n (Ecken im Uhrzeigersinn von oben → außen)
function sideQuad(pos, uv, top, bot, m, n, cell, o) {
  const along = (p) => (Math.abs(top[n][0] - top[m][0]) > Math.abs(top[n][2] - top[m][2])
    ? (p[0] + o.x - cell.x) / S : (p[2] + o.z - cell.z) / S);
  const v = (p) => sideV(p[1] + o.y - cell.y);
  quad(pos, uv, bot[n], bot[m], top[m], top[n],
    [along(bot[n]), v(bot[n])], [along(bot[m]), v(bot[m])], [along(top[m]), v(top[m])], [along(top[n]), v(top[n])]);
}

function addPyramid(pos, uv, spec, o, cell) {
  const clip = spec.clip ?? spec;
  const cx = (spec.minX + spec.maxX) / 2;
  const cz = (spec.minZ + spec.maxZ) / 2;
  const hx = (spec.maxX - spec.minX) / 2;
  const hz = (spec.maxZ - spec.minZ) / 2;
  const vT = ROOF_V_THICKNESS;
  const height = pyramidHeightFn(spec, cx, cz, hx, hz);
  const x0 = clip.minX;
  const x1 = clip.maxX;
  const z0 = clip.minZ;
  const z1 = clip.maxZ;
  // Rand des Stücks gegen den Uhrzeigersinn (von oben gesehen, −Z = oben), mit
  // Zwischenpunkten dort, wo die Dach-Grate (Diagonalen) und die Mittellinien den Rand treffen
  const ring = [];
  const pushPoint = (x, z) => {
    const last = ring[ring.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - z) < 1e-9) return;
    ring.push([x, z]);
  };
  const edge = (ax, az, bx, bz) => {
    pushPoint(ax, az);
    // Mittellinien (x = cx bzw. z = cz) schneiden die Kante?
    if (az === bz && (ax - cx) * (bx - cx) < 0) pushPoint(cx, az);
    if (ax === bx && (az - cz) * (bz - cz) < 0) pushPoint(ax, cz);
  };
  edge(x0, z1, x1, z1);
  edge(x1, z1, x1, z0);
  edge(x1, z0, x0, z0);
  edge(x0, z0, x0, z1);
  const apexInside = cx >= x0 - 1e-9 && cx <= x1 + 1e-9 && cz >= z0 - 1e-9 && cz <= z1 + 1e-9;
  const apex = [cx, cz];
  const P = (x, y, z) => [x - o.x, y - o.y, z - o.z];
  const U = (x, z) => [(x - cell.x) / S, flatV(1 - (z - cell.z) / S)];
  const n = ring.length;
  for (let m = 0; m < n; m++) {
    const p = ring[m];
    const q = ring[(m + 1) % n];
    // Dreieck Spitze-p-q (oben) und darunter (unten), wenn es nicht entartet ist
    const cross = (p[0] - apex[0]) * (q[1] - apex[1]) - (p[1] - apex[1]) * (q[0] - apex[0]);
    if (apexInside && Math.abs(cross) > 1e-9) {
      const ap = P(apex[0], height(apex[0], apex[1]), apex[1]);
      const pp = P(p[0], height(p[0], p[1]), p[1]);
      const qp = P(q[0], height(q[0], q[1]), q[1]);
      const ua = U(apex[0], apex[1]);
      const up = U(p[0], p[1]);
      const uq = U(q[0], q[1]);
      // gegen den Uhrzeigersinn von oben: Spitze, q, p ergibt eine nach oben zeigende Fläche
      if (cross < 0) {
        pos.push(...ap, ...pp, ...qp);
        uv.push(...ua, ...up, ...uq);
      } else {
        pos.push(...ap, ...qp, ...pp);
        uv.push(...ua, ...uq, ...up);
      }
      const ab = P(apex[0], height(apex[0], apex[1]) - vT, apex[1]);
      const pb = P(p[0], height(p[0], p[1]) - vT, p[1]);
      const qb = P(q[0], height(q[0], q[1]) - vT, q[1]);
      if (cross < 0) {
        pos.push(...ab, ...qb, ...pb);
        uv.push(...ua, ...uq, ...up);
      } else {
        pos.push(...ab, ...pb, ...qb);
        uv.push(...ua, ...up, ...uq);
      }
    }
    // Seite unter der Kante p-q
    const pt = P(p[0], height(p[0], p[1]), p[1]);
    const qt = P(q[0], height(q[0], q[1]), q[1]);
    const pbm = P(p[0], height(p[0], p[1]) - vT, p[1]);
    const qbm = P(q[0], height(q[0], q[1]) - vT, q[1]);
    const alongX = Math.abs(q[0] - p[0]) > Math.abs(q[1] - p[1]);
    const ua = (pt2) => (alongX ? (pt2[0] + o.x - cell.x) / S : (pt2[2] + o.z - cell.z) / S);
    const va = (pt2) => sideV(pt2[1] + o.y - cell.y);
    // Außen-Richtung: Ring läuft (von oben, −Z oben) gegen den Uhrzeigersinn
    quad(pos, uv, pbm, qbm, qt, pt, [ua(pbm), va(pbm)], [ua(qbm), va(qbm)], [ua(qt), va(qt)], [ua(pt), va(pt)]);
  }
}

// Höhe der Pyramiden-Oberseite (mit hochgezogenen Ecken spec.raise) – wie physics.js
function pyramidHeightFn(spec, cx, cz, hx, hz) {
  const raise = (spec.raise | 0) & 15;
  const top = spec.baseY + spec.rise;
  const corner = (t) => (raise & (1 << t) ? top : spec.baseY);
  return (x, z) => {
    const u = Math.max(-1, Math.min(1, (x - cx) / hx));
    const w = Math.max(-1, Math.min(1, (z - cz) / hz));
    let s;
    let t;
    let ha;
    let hb;
    if (Math.abs(u) >= Math.abs(w)) {
      s = Math.abs(u);
      t = w;
      if (u >= 0) { ha = corner(1); hb = corner(3); } else { ha = corner(0); hb = corner(2); }
    } else {
      s = Math.abs(w);
      t = u;
      if (w >= 0) { ha = corner(2); hb = corner(3); } else { ha = corner(0); hb = corner(1); }
    }
    return top + s * ((ha + hb) / 2 - top) + (t * (hb - ha)) / 2;
  };
}

// --- besondere Wände (Dreieck, Bogen): Umriss als dicke Platte ----------------------

/**
 * Wand-Form aus einem Umriss (u, v in Metern, gegen den Uhrzeigersinn): Vorder- und
 * Rückseite (Dreiecke) und die Seiten entlang des Umrisses, Dicke T.
 */
function addWallPolygon(pos, uv, piece, poly, o, cell) {
  const { kind, i, j, k } = piece;
  const d = T / 2;
  // Punkt (u, v) auf Seite side (−1 / +1) → relativ zum Ursprung
  const P = (u, v, side) => (kind === 'wx'
    ? [i * S + u - o.x, j * H + v - o.y, k * S + side * d - o.z]
    : [i * S + side * d - o.x, j * H + v - o.y, k * S + u - o.z]);
  // Außen-Richtung der Vorderseite (side +1)
  const n = kind === 'wx' ? [0, 0, 1] : [1, 0, 0];
  const contour = poly.map(([u, v]) => new THREE.Vector2(u, v));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const uvOf = (u, v, side) => [side > 0 ? u / S : 1 - u / S, sideV(v)];
  for (const side of [1, -1]) {
    for (const [a, b, c] of tris) {
      const pa = P(poly[a][0], poly[a][1], side);
      const pb = P(poly[b][0], poly[b][1], side);
      const pc = P(poly[c][0], poly[c][1], side);
      pushTri(pos, uv, pa, pb, pc, uvOf(...poly[a], side), uvOf(...poly[b], side), uvOf(...poly[c], side),
        n[0] * side, n[1] * side, n[2] * side);
    }
  }
  // Seiten: entlang jeder Kante des Umrisses
  for (let m = 0; m < poly.length; m++) {
    const [ua, va] = poly[m];
    const [ub, vb] = poly[(m + 1) % poly.length];
    // Außen-Normale der Kante (Umriss gegen den Uhrzeigersinn → rechts von der Laufrichtung)
    const eu = vb - va;
    const ev = -(ub - ua);
    const len = Math.hypot(eu, ev) || 1;
    const nu = eu / len;
    const nv = ev / len;
    const nx = kind === 'wx' ? nu : 0;
    const nz = kind === 'wx' ? 0 : nu;
    const a0 = P(ua, va, -1);
    const a1 = P(ua, va, 1);
    const b0 = P(ub, vb, -1);
    const b1 = P(ub, vb, 1);
    const along = Math.abs(ub - ua) >= Math.abs(vb - va);
    const tu = (u, v, side) => [along ? u / S : (side + 1) * 0.02, sideV(v)];
    pushTri(pos, uv, a0, b0, b1, tu(ua, va, -1), tu(ub, vb, -1), tu(ub, vb, 1), nx, nv, nz);
    pushTri(pos, uv, a0, b1, a1, tu(ua, va, -1), tu(ub, vb, 1), tu(ua, va, 1), nx, nv, nz);
  }
}

// Dreieck mit der Vorderseite in Richtung (nx, ny, nz) (vertauscht b/c, falls nötig)
function pushTri(pos, uv, a, b, c, ua, ub, uc, nx, ny, nz) {
  const cx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  const cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cx * nx + cy * ny + cz * nz < 0) {
    pos.push(...a, ...c, ...b);
    uv.push(...ua, ...uc, ...ub);
  } else {
    pos.push(...a, ...b, ...c);
    uv.push(...ua, ...ub, ...uc);
  }
}

/** Gemeinsame Form eines Typs (ohne Edit), relativ zu pieceOrigin, ungedreht. */
export function createSharedGeometry(type) {
  const fake = { type, kind: type === 'wall' ? 'wx' : type === 'floor' ? 'f' : type === 'ramp' ? 'r' : 'c', i: 0, j: 0, k: 0, dir: 0, editMask: 0, doorOpen: false };
  const origin = pieceOrigin(fake);
  const geometry = buildGeometryFromSpecs(pieceColliderSpecs(fake), origin, cellCorner(fake), 0);
  geometry.userData.shared = true;
  return geometry;
}

/** Form eines Bauteils im aktuellen Edit-Zustand (ohne Tür-Blatt), relativ zu pieceOrigin.
 *  piece braucht type, kind, i, j, k, dir, editMask (Rampe: editPath). */
export function createPieceGeometry(piece) {
  const origin = pieceOrigin(piece);
  const shape = piece.type === 'wall' ? wallShapeOf(piece.editMask | 0) : null;
  if (shape) {
    // Dreieck / Bogen: echte Form im Bild (die Kollision nähert sie mit Boxen an)
    const pos = [];
    const uv = [];
    addWallPolygon(pos, uv, piece, shape.poly, origin, cellCorner(piece));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
  const specs = pieceColliderSpecs(piece).filter((s) => !s.door);
  return buildGeometryFromSpecs(specs, origin, cellCorner(piece), piece.dir);
}

// Ecke der Zelle, ab der die Bild-Koordinaten zählen (Wand: Anfang der Wand)
function cellCorner(piece) {
  const { kind, i, j, k } = piece;
  if (kind === 'wx') return { x: i * S, y: j * H, z: k * S - S / 2 };
  if (kind === 'wz') return { x: i * S - S / 2, y: j * H, z: k * S };
  return { x: i * S, y: j * H, z: k * S };
}

/** Tür-Blatt: Form relativ zur Angel (Scharnier unten an der Seite u0). */
export function createDoorGeometry() {
  const d = doorRect();
  const w = d.u1 - d.u0;
  const h = d.v1 - d.v0;
  const thick = T * 0.55;
  const geometry = buildGeometryFromSpecs(
    [{ type: 'box', min: { x: 0.02, y: 0, z: -thick / 2 }, max: { x: w - 0.02, y: h - 0.02, z: thick / 2 } }],
    { x: 0, y: 0, z: 0 }, { x: -d.u0, y: 0, z: -S / 2 }, 0,
  );
  geometry.userData.shared = true;
  return geometry;
}

// --- Edit-Kacheln (wie in Fortnite) -------------------------------------------------

/**
 * Formen der Edit-Kacheln eines Bauteils, relativ zu pieceOrigin. Je Feld:
 *   { fill, frame, cross } – Fläche, weißer Rahmen und Kreuz (für "fällt weg").
 * Die Kacheln liegen auf beiden Seiten knapp vor der Oberfläche des GANZEN Bauteils
 * (Wand, Boden, ganze Rampe) – im Edit sieht man nur dieses Raster, das Bauteil selbst
 * ist ausgeblendet. Beim Dach liegen sie auf der echten Fläche (mit hochgezogenen Ecken),
 * genau dort, wo pickTile() trifft.
 */
export function createTileGeometries(piece) {
  const origin = pieceOrigin(piece);
  const gap = B.editTileGap ?? 0.06;
  const frame = B.editTileFrame ?? 0.07;
  const lift = 0.03;
  const list = [];
  const { kind, i, j, k } = piece;
  if (piece.type === 'wall') {
    const third = S / 3;
    const rowH = H / 3;
    // Punkt (u, v) der Wand auf Seite side (−1 / +1)
    const P = (u, v, side) => (kind === 'wx'
      ? [i * S + u - origin.x, j * H + v - origin.y, k * S + side * (T / 2 + lift) - origin.z]
      : [i * S + side * (T / 2 + lift) - origin.x, j * H + v - origin.y, k * S + u - origin.z]);
    for (let t = 0; t < 9; t++) {
      const row = Math.floor(t / 3);
      const col = t % 3;
      list.push(tileShapes(P, col * third + gap, (col + 1) * third - gap, (2 - row) * rowH + gap, (3 - row) * rowH - gap, frame, true));
    }
    return list;
  }
  const half = S / 2;
  const height = tileHeightFn(piece);
  // Oberseite: knapp darüber; Unterseite: knapp unter der Platte
  const below = piece.type === 'floor' ? T / 2 : piece.type === 'ramp' ? RAMP_V_THICKNESS : ROOF_V_THICKNESS;
  const above = piece.type === 'floor' ? T / 2 : 0;
  const P = (x, z, side) => [x - origin.x, height(x, z) + (side > 0 ? above + lift : -(below + lift)) - origin.y, z - origin.z];
  for (let t = 0; t < 4; t++) {
    const row = Math.floor(t / 2);
    const col = t % 2;
    const x0 = i * S + col * half + gap;
    const x1 = i * S + (col + 1) * half - gap;
    const z0 = k * S + row * half + gap;
    const z1 = k * S + (row + 1) * half - gap;
    // Dach: jedes Viertel hat einen Grat von der Ecke zur Mitte – die Dreiecke der Fläche
    // werden entlang dieser Diagonale geteilt (so liegt die Kachel genau auf dem Dach)
    list.push(tileShapes(P, x0, x1, z0, z1, frame, col === row));
  }
  return list;
}

// Fläche, Rahmen und Kreuz einer Kachel über dem Rechteck [a0, a1] x [b0, b1]
// (Kachel-Koordinaten); P(a, b, side) liefert den Punkt auf der Oberfläche.
// mainDiagonal: kleine Vierecke entlang a = b teilen (sonst entlang der anderen Diagonale).
function tileShapes(P, a0, a1, b0, b1, frame, mainDiagonal) {
  const N = 4; // Unterteilung (folgt gebogenen Flächen wie dem Dach)
  const fill = [];
  const border = [];
  const cross = [];
  for (const side of [1, -1]) {
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const ua = a0 + ((a1 - a0) * m) / N;
        const ub = a0 + ((a1 - a0) * (m + 1)) / N;
        const va = b0 + ((b1 - b0) * n) / N;
        const vb = b0 + ((b1 - b0) * (n + 1)) / N;
        const p00 = P(ua, va, side);
        const p10 = P(ub, va, side);
        const p11 = P(ub, vb, side);
        const p01 = P(ua, vb, side);
        if (mainDiagonal) fill.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
        else fill.push(...p10, ...p11, ...p01, ...p10, ...p01, ...p00);
      }
    }
    // Rahmen: 4 Streifen am Rand (nach innen)
    strip(border, P, side, a0, b0 + frame / 2, a1, b0 + frame / 2, frame);
    strip(border, P, side, a0, b1 - frame / 2, a1, b1 - frame / 2, frame);
    strip(border, P, side, a0 + frame / 2, b0 + frame, a0 + frame / 2, b1 - frame, frame);
    strip(border, P, side, a1 - frame / 2, b0 + frame, a1 - frame / 2, b1 - frame, frame);
    // Kreuz: beide Diagonalen
    strip(cross, P, side, a0 + frame, b0 + frame, a1 - frame, b1 - frame, frame * 0.8);
    strip(cross, P, side, a0 + frame, b1 - frame, a1 - frame, b0 + frame, frame * 0.8);
  }
  return { fill: tileGeometry(fill), frame: tileGeometry(border), cross: tileGeometry(cross) };
}

// Streifen von (a0, b0) nach (a1, b1), Breite w, in 4 Stücken (folgt der Oberfläche)
function strip(out, P, side, a0, b0, a1, b1, w) {
  const len = Math.hypot(a1 - a0, b1 - b0) || 1;
  const na = (-(b1 - b0) / len) * (w / 2);
  const nb = ((a1 - a0) / len) * (w / 2);
  const N = 4;
  for (let m = 0; m < N; m++) {
    const fa = m / N;
    const fb = (m + 1) / N;
    const ax = a0 + (a1 - a0) * fa;
    const ay = b0 + (b1 - b0) * fa;
    const bx = a0 + (a1 - a0) * fb;
    const by = b0 + (b1 - b0) * fb;
    const p0 = P(ax - na, ay - nb, side);
    const p1 = P(bx - na, by - nb, side);
    const p2 = P(bx + na, by + nb, side);
    const p3 = P(ax + na, ay + nb, side);
    out.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  }
}

// Höhe der Kachel-Fläche: Boden eben, Rampe = GANZE Rampe (Original-Richtung), Dach = echte Fläche
function tileHeightFn(piece) {
  const { i, j, k } = piece;
  if (piece.type === 'floor') return () => j * H;
  if (piece.type === 'ramp') {
    const { a, b, c } = rampPlane(rampSpec(i, j, k, piece.dir));
    return (x, z) => a * x + b * z + c;
  }
  const raise = piece.editMask | 0;
  return (x, z) => roofSurfaceY(i, j, k, raise, x, z);
}

function tileGeometry(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  return g;
}

// --- Bilder (Texturen) -------------------------------------------------------------

// Pixel-Zeilen der drei Atlas-Bereiche für ein Bild der Breite px (Breite = eine Zelle)
function atlasRows(px) {
  const height = Math.round(px * ATLAS.total / S);
  const rows = (region) => {
    const y0 = Math.round(region.top * height);
    return { y0, h: Math.round((region.top + region.size) * height) - y0, meters: region.meters };
  };
  return { height, regions: [rows(ATLAS.side), rows(ATLAS.flat), rows(ATLAS.ramp)] };
}

/**
 * Malt die Textur eines Materials auf eine Leinwand. Das Bild ist eine Zelle breit und
 * enthält drei Bereiche (ATLAS): Wand (S x H), Fläche (S x S) und Rampe (S x Schräg-Länge).
 * Jeder Bereich hat seinen eigenen Rahmen – so sieht eine Wand wie eine Wand aus (nicht
 * gestaucht) und ein Boden wie ein Boden.
 * Aussehen wie im Original-Stil: HOLZ = helle warme Bretter in einem dunkleren Holz-Rahmen,
 * STEIN = graue Blöcke mit Fugen und Stein-Rahmen, METALL = blaugraues Wellblech mit Rahmen und Nieten.
 * Die Bretter/Reihen laufen waagerecht – auf Rampen also quer (wie Stufen).
 * cracked = mit Rissen (beschädigt).
 */
export function drawMaterialCanvas(material, cracked = false) {
  const px = B.textureSize;
  const atlas = atlasRows(px);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = atlas.height;
  const ctx = canvas.getContext('2d');
  const color = CONFIG.visuals.colors[material] ?? '#CCCCCC';
  // Rand zwischen den Bereichen in Rahmen-Farbe (blutet beim Verkleinern nicht hell durch)
  ctx.fillStyle = FRAME_COLORS[material] ?? color;
  ctx.fillRect(0, 0, px, atlas.height);
  atlas.regions.forEach((r, index) => {
    const rng = seededRandom((material === 'wood' ? 11 : material === 'stone' ? 23 : 37) + index * 101);
    ctx.save();
    ctx.translate(0, r.y0);
    ctx.beginPath();
    ctx.rect(0, 0, px, r.h);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, px, r.h);
    if (material === 'wood') drawWood(ctx, px, r.h, rng);
    else if (material === 'stone') drawStone(ctx, px, r.h, rng);
    else drawMetal(ctx, px, r.h, rng);
    if (cracked) drawCracks(ctx, px, r.h, seededRandom(71 + index));
    ctx.restore();
  });
  return canvas;
}

const FRAME_COLORS = { wood: '#9C6431', stone: '#85888D', metal: '#6A7F98' };

// Rahmen um einen Bereich (w x h): Breite f, Farbe, mit heller Kante innen oben/links und Schatten
function drawFrame(ctx, w, h, f, color, light, dark) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, f);
  ctx.fillRect(0, h - f, w, f);
  ctx.fillRect(0, 0, f, h);
  ctx.fillRect(w - f, 0, f, h);
  const e = Math.max(2, Math.round(f * 0.14));
  // Kanten: außen hell (Licht), innen dunkel (Schatten auf die Füllung)
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, e);
  ctx.fillRect(0, 0, e, h);
  ctx.fillRect(w - f, f, e, h - 2 * f);
  ctx.fillRect(f, h - f, w - 2 * f, e);
  ctx.fillStyle = dark;
  ctx.fillRect(0, h - e, w, e);
  ctx.fillRect(w - e, 0, e, h);
  ctx.fillRect(f - e, f, e, h - 2 * f);
  ctx.fillRect(f, f - e, w - 2 * f, e);
}

// Holz: Bretter etwa 1/8 Zelle hoch (auf jedem Bereich gleich breit → nicht verzerrt)
function drawWood(ctx, w, h, rng) {
  const frame = Math.round(w * 0.06);
  const planks = Math.max(3, Math.round(8 * h / w));
  const ph = (h - 2 * frame) / planks;
  const seam = Math.max(2, Math.round(w / 170));
  for (let p = 0; p < planks; p++) {
    const y = frame + p * ph;
    // jedes Brett etwas heller/dunkler (warm)
    const tone = (rng() - 0.5) * 0.22;
    ctx.fillStyle = tone > 0 ? `rgba(255, 236, 200, ${tone})` : `rgba(110, 55, 15, ${-tone})`;
    ctx.fillRect(frame, y, w - 2 * frame, ph);
    // Licht oben am Brett, Schatten unten (wirkt plastisch)
    ctx.fillStyle = 'rgba(255, 240, 210, 0.22)';
    ctx.fillRect(frame, y + seam, w - 2 * frame, Math.max(2, ph * 0.08));
    ctx.fillStyle = 'rgba(90, 45, 10, 0.18)';
    ctx.fillRect(frame, y + ph - Math.max(2, ph * 0.12), w - 2 * frame, Math.max(2, ph * 0.12));
    // Maserung
    ctx.strokeStyle = 'rgba(130, 75, 30, 0.22)';
    ctx.lineWidth = Math.max(1, w / 400);
    for (let g = 0; g < 3; g++) {
      const gy = y + ph * (0.25 + rng() * 0.5);
      const phase = rng() * 6;
      ctx.beginPath();
      ctx.moveTo(frame, gy);
      for (let x = frame; x <= w - frame; x += w / 32) ctx.lineTo(x, gy + Math.sin(x * 0.03 + phase) * ph * 0.06);
      ctx.stroke();
    }
    // Ast-Loch ab und zu
    if (rng() < 0.4) {
      const kx = frame + rng() * (w - 2 * frame);
      ctx.fillStyle = 'rgba(110, 60, 20, 0.35)';
      ctx.beginPath();
      ctx.ellipse(kx, y + ph / 2, ph * 0.18, ph * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Fuge zwischen den Brettern
    ctx.fillStyle = 'rgba(70, 35, 10, 0.75)';
    ctx.fillRect(frame, y, w - 2 * frame, seam);
    // Stoß-Fuge (versetzt) + Nägel
    const joint = frame + ((p % 2) * 0.5 + 0.25 + (rng() - 0.5) * 0.08) * (w - 2 * frame);
    ctx.fillRect(joint, y, seam, ph);
    ctx.fillStyle = 'rgba(55, 45, 40, 0.7)';
    for (const nx of [joint - w / 45, joint + w / 45, frame + w / 40, w - frame - w / 40]) {
      ctx.beginPath();
      ctx.arc(nx, y + ph / 2, w / 200, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // dunklerer Holz-Rahmen (Balken) mit Maserung
  drawFrame(ctx, w, h, frame, FRAME_COLORS.wood, 'rgba(255, 220, 170, 0.45)', 'rgba(60, 28, 5, 0.55)');
  ctx.strokeStyle = 'rgba(80, 40, 10, 0.35)';
  ctx.lineWidth = Math.max(1, w / 300);
  for (const t of [0.35, 0.65]) {
    ctx.beginPath();
    ctx.moveTo(frame * 1.2, frame * t);
    ctx.lineTo(w - frame * 1.2, frame * t);
    ctx.moveTo(frame * 1.2, h - frame * t);
    ctx.lineTo(w - frame * 1.2, h - frame * t);
    ctx.moveTo(frame * t, frame * 1.2);
    ctx.lineTo(frame * t, h - frame * 1.2);
    ctx.moveTo(w - frame * t, frame * 1.2);
    ctx.lineTo(w - frame * t, h - frame * 1.2);
    ctx.stroke();
  }
  // Ecken: Schrauben
  ctx.fillStyle = 'rgba(60, 50, 45, 0.85)';
  for (const [x, y] of [[frame / 2, frame / 2], [w - frame / 2, frame / 2], [frame / 2, h - frame / 2], [w - frame / 2, h - frame / 2]]) {
    ctx.beginPath();
    ctx.arc(x, y, frame * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Stein: Reihen etwa 1/5 Zelle hoch, 3 Blöcke je Reihe (versetzt)
function drawStone(ctx, w, h, rng) {
  const frame = Math.round(w * 0.055);
  const innerW = w - 2 * frame;
  const innerH = h - 2 * frame;
  const rows = Math.max(2, Math.round(5 * h / w));
  const rh = innerH / rows;
  const mortar = Math.max(3, Math.round(w / 100));
  // Fugen-Farbe als Grund
  ctx.fillStyle = '#6E7176';
  ctx.fillRect(frame, frame, innerW, innerH);
  for (let r = 0; r < rows; r++) {
    const y = frame + r * rh;
    const blocks = 3;
    const bw = innerW / blocks;
    const offset = (r % 2) * 0.5;
    for (let b = -1; b <= blocks; b++) {
      let x0 = frame + (b + offset) * bw;
      let x1 = x0 + bw;
      x0 = Math.max(frame, x0) + mortar / 2;
      x1 = Math.min(w - frame, x1) - mortar / 2;
      if (x1 - x0 < 4) continue;
      const y0 = y + mortar / 2;
      const bh = rh - mortar;
      const tone = (rng() - 0.5) * 0.24;
      ctx.fillStyle = CONFIG.visuals.colors.stone;
      ctx.fillRect(x0, y0, x1 - x0, bh);
      ctx.fillStyle = tone > 0 ? `rgba(255, 255, 255, ${tone})` : `rgba(0, 0, 0, ${-tone})`;
      ctx.fillRect(x0, y0, x1 - x0, bh);
      // Sprenkel
      for (let n = 0; n < 28; n++) {
        ctx.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
        const sz = w / 260 + rng() * w / 130;
        ctx.fillRect(x0 + rng() * (x1 - x0 - sz), y0 + rng() * (bh - sz), sz, sz);
      }
      // Kante: oben/links hell, unten/rechts dunkel (behauener Block)
      const e = Math.max(2, Math.round(w / 120));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(x0, y0, x1 - x0, e);
      ctx.fillRect(x0, y0, e, bh);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(x0, y0 + bh - e, x1 - x0, e);
      ctx.fillRect(x1 - e, y0, e, bh);
    }
  }
  drawFrame(ctx, w, h, frame, FRAME_COLORS.stone, 'rgba(255, 255, 255, 0.35)', 'rgba(0, 0, 0, 0.4)');
  // Rahmen aus einzelnen Steinen: Fugen quer im Rahmen (gleicher Abstand waagerecht und senkrecht)
  ctx.fillStyle = 'rgba(40, 42, 46, 0.45)';
  const step = w / 6;
  for (let t = 1; t < 6; t++) {
    ctx.fillRect(t * step, 0, mortar * 0.7, frame);
    ctx.fillRect(t * step, h - frame, mortar * 0.7, frame);
  }
  const vSteps = Math.max(2, Math.round(h / step));
  for (let t = 1; t < vSteps; t++) {
    const yy = (t / vSteps) * h;
    ctx.fillRect(0, yy, frame, mortar * 0.7);
    ctx.fillRect(w - frame, yy, frame, mortar * 0.7);
  }
}

// Metall: senkrechte Rillen (Wellblech), Querstrebe in der Mitte, Nieten im Rahmen
function drawMetal(ctx, w, h, rng) {
  const frame = Math.round(w * 0.06);
  const innerW = w - 2 * frame;
  const innerH = h - 2 * frame;
  const period = w / 16;
  for (let x = frame; x < w - frame; x++) {
    const sv = Math.sin(((x - frame) / period) * Math.PI * 2);
    const a = sv * 0.12;
    ctx.fillStyle = a > 0 ? `rgba(235, 245, 255, ${a})` : `rgba(10, 20, 40, ${-a})`;
    ctx.fillRect(x, frame, 1, innerH);
  }
  // leichte Kratzer/Flecken
  const scratches = Math.round(40 * h / w);
  for (let n = 0; n < scratches; n++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.03 + rng() * 0.05})`;
    ctx.fillRect(frame + rng() * innerW, frame + rng() * innerH, w / 60 + rng() * w / 25, Math.max(1, w / 400));
  }
  // Querstrebe in der Mitte
  const bar = Math.round(frame * 0.7);
  ctx.fillStyle = '#7086A0';
  ctx.fillRect(frame, h / 2 - bar / 2, innerW, bar);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.fillRect(frame, h / 2 - bar / 2, innerW, Math.max(2, bar * 0.15));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fillRect(frame, h / 2 + bar / 2 - Math.max(2, bar * 0.15), innerW, Math.max(2, bar * 0.15));
  drawFrame(ctx, w, h, frame, FRAME_COLORS.metal, 'rgba(225, 238, 255, 0.5)', 'rgba(5, 12, 25, 0.45)');
  // Nieten im Rahmen und auf der Strebe (gleicher Abstand waagerecht und senkrecht)
  const rivet = (x, y) => {
    const r = w / 110;
    ctx.fillStyle = 'rgba(15, 22, 35, 0.6)';
    ctx.beginPath();
    ctx.arc(x + r * 0.3, y + r * 0.3, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#B9C6D4';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
  };
  const steps = 8;
  for (let t = 0; t <= steps; t++) {
    const sx = frame / 2 + (t / steps) * (w - frame);
    rivet(sx, frame / 2);
    rivet(sx, h - frame / 2);
    if (t > 0 && t < steps) rivet(sx, h / 2);
  }
  const vSteps = Math.max(2, Math.round(steps * (h - frame) / (w - frame)));
  for (let t = 0; t <= vSteps; t++) {
    const sy = frame / 2 + (t / vSteps) * (h - frame);
    rivet(frame / 2, sy);
    rivet(w - frame / 2, sy);
  }
}

function drawCracks(ctx, w, h, rng) {
  ctx.lineCap = 'round';
  const count = Math.max(3, Math.round(5 * h / w));
  for (let c = 0; c < count; c++) {
    let x = w * (0.2 + rng() * 0.6);
    let y = h * (0.2 + rng() * 0.6);
    let angle = rng() * Math.PI * 2;
    const steps = 6 + Math.floor(rng() * 5);
    for (let n = 0; n < steps; n++) {
      const len = w * (0.03 + rng() * 0.05);
      const nx = x + Math.cos(angle) * len;
      const ny = y + Math.sin(angle) * len;
      ctx.strokeStyle = 'rgba(25, 18, 12, 0.85)';
      ctx.lineWidth = Math.max(1.5, (w / 110) * (1 - n / steps) + 1);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      // heller Rand neben dem Riss (wirkt wie eine Bruchkante)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 1.5, y + 1.5);
      ctx.lineTo(nx + 1.5, ny + 1.5);
      ctx.stroke();
      // Verzweigung
      if (rng() < 0.3) {
        const ba = angle + (rng() < 0.5 ? 0.9 : -0.9);
        ctx.strokeStyle = 'rgba(25, 18, 12, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.lineTo(nx + Math.cos(ba) * len * 0.7, ny + Math.sin(ba) * len * 0.7);
        ctx.stroke();
      }
      x = nx;
      y = ny;
      angle += (rng() - 0.5) * 1.2;
    }
  }
}

/**
 * Bild für die Bau-Vorschau ("Geist"): weiß, durchsichtig, mit hellem Gitter und Rand –
 * derselbe Atlas wie die Material-Bilder. Gitter = Viertel einer Zelle (1,28 m) in jede
 * Richtung, also quadratisch auf Wand (4 x 3), Boden (4 x 4) und Rampe (4 x 5).
 * Die Farbe (blau = geht, rot = geht nicht) kommt vom Material.
 */
export function createGhostTexture() {
  const px = 256;
  const atlas = atlasRows(px);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = atlas.height;
  const ctx = canvas.getContext('2d');
  const line = 3;
  const border = 8;
  for (const r of atlas.regions) {
    ctx.save();
    ctx.translate(0, r.y0);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.fillRect(0, 0, px, r.h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (let t = 1; t < 4; t++) ctx.fillRect((t / 4) * px - line / 2, 0, line, r.h);
    const rows = Math.max(1, Math.round(r.meters / (S / 4)));
    for (let t = 1; t < rows; t++) ctx.fillRect(0, (t / rows) * r.h - line / 2, px, line);
    ctx.fillRect(0, 0, px, border);
    ctx.fillRect(0, r.h - border, px, border);
    ctx.fillRect(0, 0, border, r.h);
    ctx.fillRect(px - border, 0, border, r.h);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Textur (CanvasTexture) für ein Material (Atlas: waagerecht wiederholt, senkrecht nicht). */
export function createMaterialTexture(material, cracked, renderer = null) {
  const texture = new THREE.CanvasTexture(drawMaterialCanvas(material, cracked));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  return texture;
}

// Zufall mit festem Startwert (immer gleiches Muster)
function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
