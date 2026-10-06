// =============================================================================
// Bau-Raster (reine Mathematik, ohne Grafik)
// =============================================================================
// Die Welt ist für das Bauen in Zellen geteilt: 4 x 4 m groß, 4 m hoch
// (CONFIG.world.gridCellSize / wallHeight). Zelle (i, j, k) umfasst
//   x ∈ [i·S, (i+1)·S], y ∈ [j·H, (j+1)·H], z ∈ [k·S, (k+1)·S].
//
// Jedes Bauteil hat einen festen "Platz" (Slot) mit einem Schlüssel
// (ARCHITECTURE.md §3):
//   f:i:j:k   Boden  – waagerechte Platte, Mitte bei y = j·H
//   wx:i:j:k  Wand   – in der Ebene z = k·S, von x = i·S bis (i+1)·S
//   wz:i:j:k  Wand   – in der Ebene x = i·S, von z = k·S bis (k+1)·S
//   r:i:j:k   Rampe  – in der Zelle, steigt in Richtung dir von j·H auf (j+1)·H
//   c:i:j:k   Dach   – Pyramide, Grundfläche bei y = j·H
// Nachbar-Zellen teilen sich Wände.
//
// Außerdem steht hier die ZIELWAHL ("wohin kommt das Bauteil?"):
// selectTarget() bekommt Figur, Blick-Strahl und Welt und liefert den Platz
// für Wand, Boden, Rampe oder Dach – so, dass "90er" (Wand, Rampe, drehen,
// springen …) und "Ramp Rush" (laufen, Rampe + Wand davor) funktionieren.
// =============================================================================
import { CONFIG } from '../config.js';
import { slopeSurfaceY, slopeRangeOverRect } from '../physics.js';

const S = CONFIG.world.gridCellSize;
const H = CONFIG.world.wallHeight;
const B = CONFIG.building;
const T = B.pieceThickness;
const DEG = Math.PI / 180;

export const CELL_SIZE = S;
export const LEVEL_HEIGHT = H;
export const THICKNESS = T;
/** Dicke der Rampen-Platte senkrecht (in Y) gemessen */
export const RAMP_V_THICKNESS = T * Math.sqrt(1 + (H / S) ** 2);
/** Dicke der Dach-Platte senkrecht gemessen */
export const ROOF_V_THICKNESS = T * Math.sqrt(1 + (B.roofHeight / (S / 2)) ** 2);

// Himmelsrichtungen für "dir": 0 = +X, 1 = +Z, 2 = −X, 3 = −Z (ARCHITECTURE.md §2)
export const DIRS = Object.freeze([
  Object.freeze({ x: 1, z: 0 }),
  Object.freeze({ x: 0, z: 1 }),
  Object.freeze({ x: -1, z: 0 }),
  Object.freeze({ x: 0, z: -1 }),
]);

// Slot-Arten
export const KINDS = Object.freeze(['f', 'wx', 'wz', 'r', 'c']);
const KIND_INDEX = { f: 0, wx: 1, wz: 2, r: 3, c: 4 };
const TYPE_OF_KIND = { f: 'floor', wx: 'wall', wz: 'wall', r: 'ramp', c: 'roof' };

/** 'f' → 'floor', 'wx'/'wz' → 'wall', 'r' → 'ramp', 'c' → 'roof' */
export function typeOfKind(kind) {
  return TYPE_OF_KIND[kind] ?? null;
}

/** Zellen-Nummer für eine waagerechte Koordinate (x oder z). */
export function cellIndex(v) {
  return Math.floor(v / S);
}

/** Ebene (Stockwerk) für eine Höhe y; eps schiebt die Grenze etwas nach unten. */
export function levelIndex(y, eps = 0) {
  return Math.floor((y + eps) / H);
}

/** Welt → Zelle. Schreibt in out { i, j, k }. */
export function worldToCell(x, y, z, out = {}) {
  out.i = Math.floor(x / S);
  out.j = Math.floor(y / H);
  out.k = Math.floor(z / S);
  return out;
}

/** Untere Ecke einer Zelle (Welt-Koordinaten). */
export function cellOrigin(i, j, k, out = {}) {
  out.x = i * S;
  out.y = j * H;
  out.z = k * S;
  return out;
}

/** Slot-Schlüssel als Text, z. B. "wx:0:1:-2". */
export function slotKey(kind, i, j, k) {
  return `${kind}:${i}:${j}:${k}`;
}

/** Slot-Schlüssel als Zahl (schnell, ohne Text) – für interne Tabellen. */
export function numericSlotKey(kind, i, j, k) {
  return ((KIND_INDEX[kind] * 4096 + (i + 2048)) * 4096 + (j + 2048)) * 4096 + (k + 2048);
}

/**
 * Text-Schlüssel zerlegen. Ungültig → null.
 * @returns {{kind: string, type: string, i: number, j: number, k: number}|null}
 */
export function parseSlotKey(key, out = {}) {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length !== 4 || !(parts[0] in KIND_INDEX)) return null;
  const i = Number(parts[1]);
  const j = Number(parts[2]);
  const k = Number(parts[3]);
  if (!Number.isInteger(i) || !Number.isInteger(j) || !Number.isInteger(k)) return null;
  out.kind = parts[0];
  out.type = TYPE_OF_KIND[parts[0]];
  out.i = i;
  out.j = j;
  out.k = k;
  return out;
}

/**
 * Die Wand an einer Seite der Zelle (i, j, k). dir 0 = Ost (+X), 1 = Süd (+Z),
 * 2 = West (−X), 3 = Nord (−Z). Schreibt in out { kind, i, j, k }.
 */
export function wallSlotForSide(i, j, k, dir, out = {}) {
  out.j = j;
  if (dir === 0) { out.kind = 'wz'; out.i = i + 1; out.k = k; }
  else if (dir === 1) { out.kind = 'wx'; out.i = i; out.k = k + 1; }
  else if (dir === 2) { out.kind = 'wz'; out.i = i; out.k = k; }
  else { out.kind = 'wx'; out.i = i; out.k = k; }
  return out;
}

/** Hauptrichtung (0..3) eines Blicks (yaw, siehe ARCHITECTURE.md §2). */
export function dirFromYaw(yaw) {
  return dirFromVector(-Math.sin(yaw), -Math.cos(yaw));
}

/** Hauptrichtung (0..3) eines waagerechten Vektors (x, z). */
export function dirFromVector(x, z) {
  if (Math.abs(x) > Math.abs(z)) return x > 0 ? 0 : 2;
  return z > 0 ? 1 : 3;
}

/** Schräge (spec für world.addSlope) einer Rampe in Zelle (i, j, k). */
export function rampSpec(i, j, k, dir, out = {}) {
  out.minX = i * S;
  out.maxX = (i + 1) * S;
  out.minZ = k * S;
  out.maxZ = (k + 1) * S;
  out.baseY = j * H;
  out.rise = H;
  out.dir = ((dir % 4) + 4) % 4;
  out.thickness = T;
  return out;
}

/** Schräge (spec für world.addSlope) eines Dachs in Zelle (i, j, k). */
export function roofSpec(i, j, k, out = {}) {
  out.minX = i * S;
  out.maxX = (i + 1) * S;
  out.minZ = k * S;
  out.maxZ = (k + 1) * S;
  out.baseY = j * H;
  out.rise = B.roofHeight;
  out.dir = 'pyramid';
  out.thickness = T;
  return out;
}

/**
 * Umriss (achsen-parallele Box) eines Slots – das ganze, unbearbeitete Bauteil.
 * Schreibt in out { minX, minY, minZ, maxX, maxY, maxZ }.
 */
export function slotBounds(kind, i, j, k, out = {}) {
  const half = T / 2;
  if (kind === 'f') {
    out.minX = i * S; out.maxX = (i + 1) * S;
    out.minY = j * H - half; out.maxY = j * H + half;
    out.minZ = k * S; out.maxZ = (k + 1) * S;
  } else if (kind === 'wx') {
    out.minX = i * S; out.maxX = (i + 1) * S;
    out.minY = j * H; out.maxY = (j + 1) * H;
    out.minZ = k * S - half; out.maxZ = k * S + half;
  } else if (kind === 'wz') {
    out.minX = i * S - half; out.maxX = i * S + half;
    out.minY = j * H; out.maxY = (j + 1) * H;
    out.minZ = k * S; out.maxZ = (k + 1) * S;
  } else if (kind === 'r') {
    out.minX = i * S; out.maxX = (i + 1) * S;
    out.minY = j * H - RAMP_V_THICKNESS; out.maxY = (j + 1) * H;
    out.minZ = k * S; out.maxZ = (k + 1) * S;
  } else {
    out.minX = i * S; out.maxX = (i + 1) * S;
    out.minY = j * H - ROOF_V_THICKNESS; out.maxY = j * H + B.roofHeight;
    out.minZ = k * S; out.maxZ = (k + 1) * S;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Formen (für Berührung und Halt) – das ganze Bauteil, ohne Edit
// -----------------------------------------------------------------------------
// Box:     { type: 'box', minX, minY, minZ, maxX, maxY, maxZ }
// Schräge: { type: 'slope', kind: 'ramp'|'pyramid', minX, maxX, minZ, maxZ, minY, maxY,
//            baseY, rise, vThickness, a, b, c (Rampe), cx, cz, hx, hz (Pyramide) }
// Die Felder der Schräge heißen wie bei den Collidern in physics.js – darum
// funktionieren slopeSurfaceY/slopeRangeOverRect auch mit diesen Formen.

/** Leere Form zum Wiederverwenden. */
export function createShape() {
  return {
    type: 'box', kind: null,
    minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
    baseY: 0, rise: 0, vThickness: 0, a: 0, b: 0, c: 0, cx: 0, cz: 0, hx: 1, hz: 1,
  };
}

/** Form eines Slots (ganzes Bauteil). dir nur für Rampen. */
export function slotShape(kind, i, j, k, dir, out = createShape()) {
  slotBounds(kind, i, j, k, out);
  if (kind !== 'r' && kind !== 'c') {
    out.type = 'box';
    out.kind = null;
    return out;
  }
  out.type = 'slope';
  out.baseY = j * H;
  if (kind === 'c') {
    out.kind = 'pyramid';
    out.rise = B.roofHeight;
    out.vThickness = ROOF_V_THICKNESS;
    out.cx = (i + 0.5) * S;
    out.cz = (k + 0.5) * S;
    out.hx = S / 2;
    out.hz = S / 2;
    return out;
  }
  out.kind = 'ramp';
  out.rise = H;
  out.vThickness = RAMP_V_THICKNESS;
  const d = ((dir % 4) + 4) % 4;
  const slope = H / S;
  out.a = d === 0 ? slope : d === 2 ? -slope : 0;
  out.b = d === 1 ? slope : d === 3 ? -slope : 0;
  // Höhe = a·x + b·z + c, unten (baseY) an der Seite, von der die Rampe aufsteigt
  if (d === 0) out.c = out.baseY - out.a * out.minX;
  else if (d === 2) out.c = out.baseY - out.a * out.maxX;
  else if (d === 1) out.c = out.baseY - out.b * out.minZ;
  else out.c = out.baseY - out.b * out.maxZ;
  return out;
}

/** Collider (aus physics.js) als Form lesen (ohne neue Objekte). */
export function colliderToShape(c, out = createShape()) {
  if (c.type === 'box') {
    out.type = 'box';
    out.minX = c.min.x; out.minY = c.min.y; out.minZ = c.min.z;
    out.maxX = c.max.x; out.maxY = c.max.y; out.maxZ = c.max.z;
    return out;
  }
  out.type = 'slope';
  out.kind = c.kind;
  out.minX = c.minX; out.maxX = c.maxX; out.minZ = c.minZ; out.maxZ = c.maxZ;
  out.minY = c.min.y; out.maxY = c.max.y;
  out.baseY = c.baseY; out.rise = c.rise; out.vThickness = c.vThickness;
  out.a = c.a; out.b = c.b; out.c = c.c; out.cx = c.cx; out.cz = c.cz; out.hx = c.hx; out.hz = c.hz;
  return out;
}

const _rangeA = { min: 0, max: 0 };
const _rangeB = { min: 0, max: 0 };

/**
 * Berühren sich zwei Formen (mit Spielraum tol)? Für Boxen genau, für Schrägen
 * vorsichtig über die Höhen auf dem gemeinsamen Streifen.
 */
export function shapesTouch(a, b, tol = B.supportTolerance) {
  if (a.minX - tol > b.maxX || b.minX - tol > a.maxX) return false;
  if (a.minY - tol > b.maxY || b.minY - tol > a.maxY) return false;
  if (a.minZ - tol > b.maxZ || b.minZ - tol > a.maxZ) return false;
  if (a.type === 'box' && b.type === 'box') return true;
  if (a.type === 'box') return boxTouchesSlope(a, b, tol);
  if (b.type === 'box') return boxTouchesSlope(b, a, tol);
  // Schräge an Schräge: Höhen auf dem gemeinsamen Streifen vergleichen
  const x0 = Math.max(a.minX, b.minX) - tol;
  const x1 = Math.min(a.maxX, b.maxX) + tol;
  const z0 = Math.max(a.minZ, b.minZ) - tol;
  const z1 = Math.min(a.maxZ, b.maxZ) + tol;
  if (!slopeRangeOverRect(a, x0, x1, z0, z1, _rangeA)) return false;
  if (!slopeRangeOverRect(b, x0, x1, z0, z1, _rangeB)) return false;
  return _rangeA.min - a.vThickness - tol <= _rangeB.max && _rangeB.min - b.vThickness - tol <= _rangeA.max;
}

function boxTouchesSlope(box, s, tol) {
  const x0 = box.minX - tol;
  const x1 = box.maxX + tol;
  const z0 = box.minZ - tol;
  const z1 = box.maxZ + tol;
  if (!slopeRangeOverRect(s, x0, x1, z0, z1, _rangeA)) return false;
  return box.minY - tol <= _rangeA.max && box.maxY + tol >= _rangeA.min - s.vThickness;
}

/** Unterkante einer Form an der Stelle (x, z). */
export function shapeBottomAt(shape, x, z) {
  if (shape.type === 'box') return shape.minY;
  return slopeSurfaceY(shape, x, z) - shape.vThickness;
}

/** Oberkante einer Form an der Stelle (x, z). */
export function shapeTopAt(shape, x, z) {
  if (shape.type === 'box') return shape.maxY;
  return slopeSurfaceY(shape, x, z);
}

/**
 * Höchste Oberkante der Form über einem Rechteck (z. B. Fuß-Fläche einer Figur).
 * -Infinity, wenn die Form das Rechteck nicht berührt.
 */
export function shapeTopOverRect(shape, x0, x1, z0, z1) {
  if (x1 <= shape.minX || x0 >= shape.maxX || z1 <= shape.minZ || z0 >= shape.maxZ) return -Infinity;
  if (shape.type === 'box') return shape.maxY;
  slopeRangeOverRect(shape, x0, x1, z0, z1, _rangeA);
  return _rangeA.max;
}

/**
 * Steckt die Form wirklich in der Box (bloßes Berühren zählt nicht)?
 * Schrägen werden vorsichtig über ihren Höhen-Bereich auf dem Rechteck geprüft.
 */
export function shapeOverlapsBox(shape, minX, minY, minZ, maxX, maxY, maxZ) {
  const e = 1e-4;
  if (shape.minX >= maxX - e || shape.maxX <= minX + e) return false;
  if (shape.minZ >= maxZ - e || shape.maxZ <= minZ + e) return false;
  if (shape.type === 'box') return shape.minY < maxY - e && shape.maxY > minY + e;
  if (!slopeRangeOverRect(shape, minX, maxX, minZ, maxZ, _rangeA)) return false;
  return minY < _rangeA.max - e && maxY > _rangeA.min - shape.vThickness + e;
}

/**
 * Ruft fn(kind, i, j, k) für alle Slots auf, die einen Slot berühren KÖNNTEN
 * (Zellen ±1 in jede Richtung). Wer wirklich berührt, prüft shapesTouch.
 */
export function forEachNearbySlot(kind, i, j, k, fn) {
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let dk = -1; dk <= 1; dk++) {
        for (let n = 0; n < KINDS.length; n++) {
          const other = KINDS[n];
          if (di === 0 && dj === 0 && dk === 0 && other === kind) continue;
          fn(other, i + di, j + dj, k + dk);
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Edit-Felder (Kacheln)
// -----------------------------------------------------------------------------
// Wand: 3 x 3 Felder, Nummer = Reihe·3 + Spalte, Reihe 0 = oben, Spalte 0 = Anfang
//       der Wand (kleinstes x bei wx, kleinstes z bei wz).
// Boden, Rampe, Dach: 2 x 2 Felder, Nummer = Reihe·2 + Spalte, Spalte entlang x
//       (0 = kleines x), Reihe entlang z (0 = kleines z).

/** Spalten/Reihen des Edit-Rasters für einen Bauteil-Typ. */
export function editGridOf(type) {
  return B.editGrid[type];
}

/** Anzahl Felder eines Typs (Wand 9, sonst 4). */
export function tileCount(type) {
  const g = B.editGrid[type];
  return g.cols * g.rows;
}

/** Bitmaske "alle Felder". */
export function fullTileMask(type) {
  return (1 << tileCount(type)) - 1;
}

/** Feld-Liste (Set oder Array) → Bitmaske. */
export function tilesToMask(tiles) {
  let mask = 0;
  if (!tiles) return 0;
  for (const t of tiles) if (Number.isInteger(t) && t >= 0 && t < 30) mask |= 1 << t;
  return mask;
}

/** Bitmaske → sortierte Feld-Liste. */
export function maskToTiles(mask) {
  const out = [];
  for (let t = 0; t < 30; t++) if (mask & (1 << t)) out.push(t);
  return out;
}

/** Ist diese Auswahl (entfernte Felder) eine Tür? (genau die Tür-Felder) */
export function isDoorMask(type, mask) {
  return type === 'wall' && mask === tilesToMask(B.wallDoorCells);
}

/**
 * Zerlegt die VORHANDENEN Felder in möglichst wenige Rechtecke (gierig:
 * erst nach rechts, dann nach unten). Ergebnis: Liste von
 * { col0, row0, cols, rows } (Spalten/Reihen in Feld-Einheiten).
 */
export function presentRects(cols, rows, removedMask) {
  const used = new Array(cols * rows).fill(false);
  const rects = [];
  const present = (c, r) => !(removedMask & (1 << (r * cols + c)));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (used[idx] || !present(c, r)) continue;
      let w = 1;
      while (c + w < cols && present(c + w, r) && !used[r * cols + c + w]) w++;
      let h = 1;
      outer: while (r + h < rows) {
        for (let x = c; x < c + w; x++) {
          if (!present(x, r + h) || used[(r + h) * cols + x]) break outer;
        }
        h++;
      }
      for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) used[y * cols + x] = true;
      rects.push({ col0: c, row0: r, cols: w, rows: h });
    }
  }
  return rects;
}

// -----------------------------------------------------------------------------
// Zielwahl: wohin kommt das Bauteil?
// -----------------------------------------------------------------------------
// Grundidee (wie im Original/Fortnite, vereinfacht):
//   1. "Blick-Anker": ein Punkt auf dem Blick-Strahl (von den Augen der Figur),
//      targetReach[typ] Meter entfernt. Trifft der Strahl vorher einen Boden
//      (Gelände, Bodenplatte, Rampe – nicht Wände), liegt der Anker dort.
//      Die Zelle des Ankers (höchstens maxPlaceCells von der eigenen Zelle) ist
//      die Ziel-Zelle für Boden, Rampe und Dach.
//   2. Ebene (Stockwerk): aus der Höhe der Füße. Steht man auf einer Rampe, zählt
//      ihre Ebene; für die Zelle VOR einer Rampe zählt die Höhe, an der man die
//      Zelle betritt (oben an der Rampe = eine Ebene höher → Ramp Rush).
//      In der Luft (Sprung) zählt die Fuß-Höhe (+ levelEpsilon) → 90er.
//      Hochschauen (über lookUpPitch) = eine Ebene höher. Schaut man über eine
//      Kante nach unten (Anker deutlich unter der eigenen Ebene) = eine tiefer.
//   3. Wand: an der Kante der eigenen Zelle in Blickrichtung (in der Nachbar-Spalte nur,
//      wenn der Anker deutlich dort liegt – wallColumnMargin). Steht in der Zelle
//      davor eine Rampe, die von dir weg ansteigt, kommt die Wand an ihr OBERES
//      Ende (sonst wäre der Weg die Rampe hinauf zu). Schaust du auf den Boden
//      in der hinteren Hälfte der Zelle davor, kommt die Wand an deren Ende.
//   4. Rampe: steigt in Blickrichtung (+ Drehung mit R). Beim Blick über eine
//      Kante nach unten zeigt sie zu dir hin (eine Treppe nach unten). Steht
//      direkt vor dir eine Wand, kommt die Rampe in deine Zelle (zur Wand hin) –
//      das Bau-System hebt dich dann auf die Rampe.
//   5. Dach: über dir (bzw. über der Zelle, auf die du schaust).

/** Leeres Ziel-Objekt (wiederverwenden). */
export function createTarget() {
  return {
    type: 'wall',
    kind: 'wx',
    i: 0,
    j: 0,
    k: 0,
    dir: 0,
    numKey: -1,
    slotKey: '',
    valid: false,
    reason: null, // 'limit' | 'outside' | 'occupied' | 'material' | 'blocked' | 'unsupported' | null
    anchorX: 0,
    anchorY: 0,
    anchorZ: 0,
  };
}

const _hitExcluded = new Set();
const _wall = {};
const _rayOptions = { ignore: null, characters: null, skipTerrain: false };
const _origin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: -1 };
const _supportList = [];
const _qMin = { x: 0, y: 0, z: 0 };
const _qMax = { x: 0, y: 0, z: 0 };

function ignoreExcluded(c) {
  return _hitExcluded.has(c);
}

/**
 * Schräge unter den Füßen (Rampe, Dach, Karten-Rampe) oder null.
 * Nur sinnvoll, wenn die Figur am Boden steht.
 */
export function slopeUnderFeet(world, character) {
  if (!world || !character.grounded) return null;
  const p = character.position;
  const r = (character.radius ?? CONFIG.player.hitbox.radius) * 0.5;
  _qMin.x = p.x - r; _qMin.y = p.y - 0.25; _qMin.z = p.z - r;
  _qMax.x = p.x + r; _qMax.y = p.y + 0.05; _qMax.z = p.z + r;
  const list = world.queryBox(_qMin, _qMax, _supportList);
  let best = null;
  let bestY = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.type !== 'slope') continue;
    if (p.x < c.minX || p.x > c.maxX || p.z < c.minZ || p.z > c.maxZ) continue;
    const s = slopeSurfaceY(c, p.x, p.z);
    if (Math.abs(s - p.y) <= 0.15 && s > bestY) {
      best = c;
      bestY = s;
    }
  }
  return best;
}

/**
 * Wählt den Platz für ein Bauteil.
 * @param {object} character   Figur (position, yaw, crouching, grounded, buildRotation)
 * @param {string} type        'wall' | 'floor' | 'ramp' | 'roof'
 * @param {{x,y,z}} aimDir     Blick-Richtung (Länge 1); null = aus yaw/pitch der Figur
 * @param {object} world       CollisionWorld (für Boden-Treffer und Rampen unter den Füßen) oder null
 * @param {(kind, i, j, k) => object|null} getPiece  liefert das Bauteil auf einem Platz (oder null)
 * @param {object} out         Ziel-Objekt (createTarget)
 */
export function selectTarget(character, type, aimDir, world, getPiece, out = createTarget()) {
  const p = character.position;
  const eyeHeight = character.crouching ? CONFIG.player.crouchEyeHeight : CONFIG.player.eyeHeight;
  _origin.x = p.x;
  _origin.y = p.y + eyeHeight;
  _origin.z = p.z;
  if (aimDir && Number.isFinite(aimDir.x + aimDir.y + aimDir.z) && aimDir.x * aimDir.x + aimDir.y * aimDir.y + aimDir.z * aimDir.z > 0.25) {
    const len = Math.hypot(aimDir.x, aimDir.y, aimDir.z);
    _dir.x = aimDir.x / len;
    _dir.y = aimDir.y / len;
    _dir.z = aimDir.z / len;
  } else {
    const cp = Math.cos(character.pitch ?? 0);
    _dir.x = -Math.sin(character.yaw ?? 0) * cp;
    _dir.y = Math.sin(character.pitch ?? 0);
    _dir.z = -Math.cos(character.yaw ?? 0) * cp;
  }
  const pitch = Math.asin(Math.max(-1, Math.min(1, _dir.y)));
  const horizontal = Math.hypot(_dir.x, _dir.z);
  const facing = horizontal > 1e-3 ? dirFromVector(_dir.x, _dir.z) : dirFromYaw(character.yaw ?? 0);

  // --- eigene Zelle und Ebene -----------------------------------------------------
  const ci = Math.floor(p.x / S);
  const ck = Math.floor(p.z / S);
  const slope = slopeUnderFeet(world, character);
  const baseLevel = slope ? Math.floor((slope.baseY + 0.01) / H) : Math.floor((p.y + B.levelEpsilon) / H);

  // --- Blick-Anker ------------------------------------------------------------------
  const reach = B.targetReach[type] ?? B.targetReach.wall;
  let dist = reach;
  let floorHit = false;
  if (world) {
    _hitExcluded.clear();
    _rayOptions.ignore = ignoreExcluded;
    for (let n = 0; n < 4; n++) {
      const hit = world.raycast(_origin, _dir, reach, _rayOptions);
      if (!hit) break;
      // Boden = Gelände oder waagerechte Fläche. Eine Rampe zählt nur, wenn man auf sie
      // HINUNTER schaut (nicht die Rampe vor einem, die vor den Augen ansteigt).
      const slopeAhead = hit.collider?.type === 'slope' && hit.point.y > p.y + 0.6;
      if (hit.terrain || (hit.normal.y > 0.5 && !slopeAhead)) {
        dist = Math.max(0, hit.distance - 0.02);
        floorHit = true;
        break;
      }
      // senkrechte Fläche (Wand, Kisten-Seite): für den Anker nicht beachten
      if (!hit.collider) break;
      _hitExcluded.add(hit.collider);
    }
    _hitExcluded.clear();
    _rayOptions.ignore = null;
  }
  const ax = _origin.x + _dir.x * dist;
  const ay = _origin.y + _dir.y * dist;
  const az = _origin.z + _dir.z * dist;
  out.anchorX = ax;
  out.anchorY = ay;
  out.anchorZ = az;
  const maxCells = B.maxPlaceCells;
  const ai = clampInt(Math.floor(ax / S), ci - maxCells, ci + maxCells);
  const ak = clampInt(Math.floor(az / S), ck - maxCells, ck + maxCells);
  const lookUp = pitch > B.lookUpPitch * DEG;
  const overEdge = ay < baseLevel * H - B.lookDownDrop;
  const own = ai === ci && ak === ck;
  const entry = own ? baseLevel : entryLevel(slope, p, ci, ck, ai, ak, baseLevel);

  out.type = type;
  out.dir = 0;
  if (type === 'floor') {
    out.kind = 'f';
    out.i = ai;
    out.k = ak;
    out.j = entry + (lookUp ? 1 : 0);
  } else if (type === 'ramp') {
    out.kind = 'r';
    out.i = ai;
    out.k = ak;
    const rotation = (character.buildRotation ?? 0) % 4;
    let dir = (facing + rotation) % 4;
    let j = entry;
    if (lookUp) j++;
    else if (overEdge && !own) {
      // Über die Kante nach unten: Treppe eine Ebene tiefer, steigt zu dir hin
      j--;
      dir = (dir + 2) % 4;
    } else if (!own && rotation === 0 && getPiece && ai === ci + DIRS[facing].x && ak === ck + DIRS[facing].z) {
      // Steht schon eine Wand vor dir (zwischen dir und der Ziel-Zelle)? Dann kommt
      // die Rampe in DEINE Zelle und steigt zur Wand hin ("Wand + Rampe" – du wirst
      // auf die Rampe gehoben).
      wallSlotForSide(ci, j, ck, facing, _wall);
      const wall = getPiece(_wall.kind, _wall.i, _wall.j, _wall.k);
      if (wall && !wall.collapsing) {
        out.i = ci;
        out.k = ck;
        j = baseLevel;
      }
    }
    out.j = j;
    out.dir = dir;
  } else if (type === 'roof') {
    out.kind = 'c';
    out.i = ai;
    out.k = ak;
    out.j = entry + (overEdge ? 0 : 1);
  } else {
    // Wand
    let j = baseLevel;
    if (lookUp) j++;
    else if (overEdge) j--;
    const alongX = facing === 0 || facing === 2;
    const sign = facing === 0 || facing === 1 ? 1 : -1;
    const ownLine = alongX ? (sign > 0 ? ci + 1 : ci) : (sign > 0 ? ck + 1 : ck);
    // Spalte (entlang der Wand): die eigene – außer der Anker liegt DEUTLICH
    // (wallColumnMargin) in der Nachbar-Spalte. Sonst käme die Wand beim Drehen um die
    // Diagonale schon an die Kante der Nachbar-Zelle (360° = 8 Wände statt einer Box).
    const ownColumn = alongX ? ck : ci;
    const along = alongX ? az : ax;
    let column = ownColumn;
    if (along > (ownColumn + 1) * S + B.wallColumnMargin) column = ownColumn + 1;
    else if (along < ownColumn * S - B.wallColumnMargin) column = ownColumn - 1;
    column = clampInt(column, ownColumn - maxCells, ownColumn + maxCells);
    const frontI = alongX ? ci + sign : column;
    const frontK = alongX ? column : ck + sign;
    let far = false;
    // Rampe davor, die von dir weg ansteigt → Wand an ihr oberes Ende
    const ramp = getPiece ? getPiece('r', frontI, j, frontK) : null;
    if (ramp && !ramp.collapsing && ramp.dir === facing) far = true;
    // Blick auf den Boden in der hinteren Hälfte der Zelle davor
    if (!far && floorHit && (alongX ? ai === frontI : ak === frontK)) {
      const a = alongX ? ax : az;
      const cellStart = (alongX ? frontI : frontK) * S;
      const into = sign > 0 ? a - cellStart : cellStart + S - a;
      if (into > S / 2) far = true;
    }
    const line = far ? ownLine + sign : ownLine;
    out.kind = alongX ? 'wz' : 'wx';
    out.i = alongX ? line : column;
    out.k = alongX ? column : line;
    out.j = j;
    out.dir = facing;
  }
  out.numKey = numericSlotKey(out.kind, out.i, out.j, out.k);
  return out;
}

// Ebene, auf der man die Nachbar-Zelle (ti, tk) betritt
function entryLevel(slope, p, ci, ck, ti, tk, baseLevel) {
  if (!slope) return baseLevel;
  // Punkt auf dem Rand der eigenen Zelle in Richtung der Ziel-Zelle
  const bx = ti > ci ? (ci + 1) * S : ti < ci ? ci * S : p.x;
  const bz = tk > ck ? (ck + 1) * S : tk < ck ? ck * S : p.z;
  const h = slopeSurfaceY(slope, bx, bz);
  return Math.floor((h + B.levelEpsilon) / H);
}

function clampInt(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
