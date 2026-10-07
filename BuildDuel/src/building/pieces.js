// =============================================================================
// Bauteile: Form, Kollision und Aussehen
// =============================================================================
// Für jedes Bauteil (Wand, Boden, Rampe, Dach) steht hier:
//   - pieceColliderSpecs(): aus welchen Kollisions-Teilen es besteht – je nach
//     Edit (entfernte Felder). Wand: Boxen (zusammengefasst), Tür: zusätzlich ein
//     Tür-Blatt (nur wenn zu). Boden: Boxen. Dach: zugeschnittene Schrägen
//     (Dach-Viertel). Rampe: eigene Formen (siehe rampEditSpecs): 1 Feld weg =
//     Ecktreppe, 2 Felder in einer Reihe weg = halbe Rampe (Richtung frei wählbar).
//   - Formen (BufferGeometry) GENAU aus denselben Teilen → Bild = Kollision.
//   - Bilder (Texturen) per Canvas: Holz (Bretter), Stein (Fugen), Metall (Nieten),
//     dazu je eine Version mit Rissen (beschädigt).
//   - Edit-Felder: Kacheln zum Anzeigen und pickTile() (welches Feld liegt unter
//     dem Fadenkreuz?).
// Die Rechnungen (Kollision, Feld-Wahl) laufen auch ohne Bildschirm. Nur die
// Funktionen mit "Geometry", "Texture" oder "Material" brauchen Three.js-Grafik.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import {
  CELL_SIZE as S, LEVEL_HEIGHT as H, THICKNESS as T, RAMP_V_THICKNESS, ROOF_V_THICKNESS,
  rampSpec, roofSpec, presentRects, isDoorMask, tilesToMask,
} from './grid.js';

const B = CONFIG.building;
const DOOR_MASK = tilesToMask(B.wallDoorCells);

// -----------------------------------------------------------------------------
// Kollisions-Teile je Edit
// -----------------------------------------------------------------------------

/**
 * Kollisions-Teile eines Bauteils im aktuellen Zustand.
 * piece = { type, kind, i, j, k, dir, editMask }
 * Ergebnis: Liste von { type: 'box', min: {x,y,z}, max: {x,y,z}, door?: true }
 *                  und { type: 'slope', spec }
 * Bei einer Tür ist das Tür-Blatt dabei (door: true) – offen = ausgeschaltet.
 */
export function pieceColliderSpecs(piece) {
  const out = [];
  const mask = piece.editMask | 0;
  const { kind, i, j, k } = piece;
  if (piece.type === 'wall') {
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
  // Rampe und Dach: Schräge, bei Edit auf die vorhandenen Felder zugeschnitten
  const base = piece.type === 'ramp' ? rampSpec(i, j, k, piece.dir) : roofSpec(i, j, k);
  if (mask === 0) {
    out.push({ type: 'slope', spec: base });
    return out;
  }
  if (piece.type === 'ramp' && rampEditSpecs(piece, mask, out)) return out;
  const half = S / 2;
  for (const r of presentRects(2, 2, mask)) {
    out.push({
      type: 'slope',
      spec: {
        ...base,
        clip: {
          minX: i * S + r.col0 * half,
          maxX: i * S + (r.col0 + r.cols) * half,
          minZ: k * S + r.row0 * half,
          maxZ: k * S + (r.row0 + r.rows) * half,
        },
      },
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Rampen-Edit: Ecktreppe und halbe Rampe
// -----------------------------------------------------------------------------
// Felder 0..3: Spalte = t % 2 (entlang x), Reihe = floor(t / 2) (entlang z).
// - 1 Feld entfernt (3 Felder als "L") → ECKTREPPE: vom unteren Ende-Feld eine kurze
//   Rampe (45°) hinauf auf ein flaches Podest im Eck-Feld (halbe Höhe), dort 90° drehen
//   und mit der zweiten kurzen Rampe ganz hinauf (eine Ebene, wie die ganze Rampe).
//   Unteres Ende = das Ende-Feld, das bei der ganzen Rampe tiefer lag.
// - 2 Felder nebeneinander entfernt (2 Felder in einer Reihe bleiben) → HALBE RAMPE
//   (2 m breit, 4 m lang, 45°). Richtung: piece.editDir (Reihenfolge, in der die zwei
//   Felder gewählt wurden: vom ersten zum zweiten = "hinauf"), sonst die alte Richtung,
//   wenn sie entlang des Streifens liegt, sonst 90° weiter gedreht.
// - sonst (1 Feld übrig, 2 Felder über Eck): Stücke der ganzen Rampe (alte Form).

/** Spalte/Reihe eines Rampen-Felds → Richtung (0 = +X, 1 = +Z, 2 = −X, 3 = −Z) von p nach q. */
function tileDirection(p, q) {
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

/**
 * Richtung einer editierten Rampe, deren Rest-Streifen (zwei Felder) entlang der Achse
 * "alongX" liegt: gewählte Richtung (editDir), sonst die alte, sonst 90° gedreht.
 */
export function halfRampDirection(dir, editDir, alongX) {
  const fits = (d) => d !== null && d !== undefined && d >= 0 && (d % 2 === 0) === alongX;
  if (fits(editDir)) return editDir;
  if (fits(dir)) return dir;
  return (dir + 1) % 4;
}

/**
 * Kollisions-Teile einer editierten Rampe (Ecktreppe, halbe Rampe). false = keine
 * eigene Form (dann die alte: Stücke der ganzen Rampe).
 */
export function rampEditSpecs(piece, mask, out) {
  const { i, j, k } = piece;
  const d = ((piece.dir % 4) + 4) % 4;
  const present = ~mask & 15;
  const tiles = [];
  for (let t = 0; t < 4; t++) if (present & (1 << t)) tiles.push(t);
  if (tiles.length === 3) {
    // Ecktreppe: Eck-Feld = gegenüber vom entfernten Feld
    const removed = [0, 1, 2, 3].find((t) => !(present & (1 << t)));
    const corner = 3 - removed;
    const ends = [corner ^ 1, corner ^ 2];
    const low = rampTileRank(d, ends[0]) <= rampTileRank(d, ends[1]) ? ends[0] : ends[1];
    const high = low === ends[0] ? ends[1] : ends[0];
    const baseY = j * H;
    out.push({ type: 'slope', spec: { ...rampTileRect(i, k, low), baseY, rise: H / 2, dir: tileDirection(low, corner), thickness: T }, stair: 'low' });
    const c = rampTileRect(i, k, corner);
    out.push({ type: 'box', min: { x: c.minX, y: baseY + H / 2 - T, z: c.minZ }, max: { x: c.maxX, y: baseY + H / 2, z: c.maxZ }, stair: 'landing' });
    out.push({ type: 'slope', spec: { ...rampTileRect(i, k, high), baseY: baseY + H / 2, rise: H / 2, dir: tileDirection(corner, high), thickness: T }, stair: 'high' });
    return true;
  }
  if (tiles.length === 2 && tileDirection(tiles[0], tiles[1]) >= 0) {
    // halbe Rampe über den Streifen der zwei Felder
    const alongX = tileDirection(tiles[0], tiles[1]) === 0;
    const dir = halfRampDirection(d, piece.editDir, alongX);
    const a = rampTileRect(i, k, tiles[0]);
    const b = rampTileRect(i, k, tiles[1]);
    out.push({
      type: 'slope',
      spec: {
        minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
        minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
        baseY: j * H, rise: H, dir, thickness: T,
      },
    });
    return true;
  }
  return false;
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
    // Dach: die echten Dreiecks-Flächen der Pyramide (oben und unten) – genau das,
    // was man sieht und was das Fadenkreuz trifft
    t = roofHitDistance(i, j, k, origin, dir, maxDist);
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
 * Jede der 4 Flächen ist eine Ebene y = Grund + Höhe·(1 − s / h), s = Abstand von der
 * Mitte in Richtung der Fläche; sie gilt dort, wo s ≥ |Abstand quer| (Grat = Diagonale).
 */
export function roofHitDistance(i, j, k, origin, dir, maxDist = Infinity) {
  const h = S / 2;
  const cx = i * S + h;
  const cz = k * S + h;
  const rise = B.roofHeight;
  const g = rise / h; // Steigung der Flächen
  let best = Infinity;
  for (let face = 0; face < 4; face++) {
    // Fläche 0 = +X, 1 = +Z, 2 = −X, 3 = −Z
    const ax = face === 0 ? 1 : face === 2 ? -1 : 0;
    const az = face === 1 ? 1 : face === 3 ? -1 : 0;
    // y = a·x + b·z + c
    const a = -g * ax;
    const b = -g * az;
    const denom = dir.y - a * dir.x - b * dir.z;
    if (Math.abs(denom) < 1e-9) continue;
    for (let side = 0; side < 2; side++) {
      const c = j * H + rise + g * (ax * cx + az * cz) - (side === 0 ? 0 : ROOF_V_THICKNESS);
      const t = (a * origin.x + b * origin.z + c - origin.y) / denom;
      if (!(t >= 0 && t <= maxDist && t < best)) continue;
      const x = origin.x + dir.x * t - cx;
      const z = origin.z + dir.z * t - cz;
      const along = ax * x + az * z;
      const across = ax !== 0 ? Math.abs(z) : Math.abs(x);
      if (along < -1e-6 || along > h + 1e-6 || across > along + 1e-6) continue;
      best = t;
    }
  }
  return best;
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
  // UV: Meter ab der Zellen-Ecke / Zellgröße
  const ux = (x) => (x + o.x - cell.x) / S;
  const uy = (y) => (y + o.y - cell.y) / S;
  const uz = (z) => (z + o.z - cell.z) / S;
  // +X
  quad(pos, uv, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1],
    [1 - uz(z1), uy(y0)], [1 - uz(z0), uy(y0)], [1 - uz(z0), uy(y1)], [1 - uz(z1), uy(y1)]);
  // −X
  quad(pos, uv, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0],
    [uz(z0), uy(y0)], [uz(z1), uy(y0)], [uz(z1), uy(y1)], [uz(z0), uy(y1)]);
  // +Y
  quad(pos, uv, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0],
    [ux(x0), 1 - uz(z1)], [ux(x1), 1 - uz(z1)], [ux(x1), 1 - uz(z0)], [ux(x0), 1 - uz(z0)]);
  // −Y
  quad(pos, uv, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [ux(x0), uz(z0)], [ux(x1), uz(z0)], [ux(x1), uz(z1)], [ux(x0), uz(z1)]);
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
  const tex = (x, z) => {
    const lx = x - cell.x;
    const lz = z - cell.z;
    if (d === 0) return [lz / S, lx / S];
    if (d === 2) return [1 - lz / S, 1 - lx / S];
    if (d === 1) return [1 - lx / S, lz / S];
    return [lx / S, 1 - lz / S];
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
  const v = (p) => (p[1] + o.y - cell.y) / S;
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
  const height = (x, z) => spec.baseY + spec.rise * (1 - Math.min(1, Math.max(Math.abs(x - cx) / hx, Math.abs(z - cz) / hz)));
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
  const U = (x, z) => [(x - cell.x) / S, 1 - (z - cell.z) / S];
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
    const va = (pt2) => (pt2[1] + o.y - cell.y) / S;
    // Außen-Richtung: Ring läuft (von oben, −Z oben) gegen den Uhrzeigersinn
    quad(pos, uv, pbm, qbm, qt, pt, [ua(pbm), va(pbm)], [ua(qbm), va(qbm)], [ua(qt), va(qt)], [ua(pt), va(pt)]);
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
 *  piece braucht type, kind, i, j, k, dir, editMask (Rampe: editDir). */
export function createPieceGeometry(piece) {
  const specs = pieceColliderSpecs(piece).filter((s) => !s.door);
  const origin = pieceOrigin(piece);
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

// --- Edit-Kacheln (leuchtende Felder) ---------------------------------------------

/**
 * Formen der Edit-Kacheln eines Bauteils (eine Form pro Feld, beide Seiten),
 * relativ zu pieceOrigin. Die Kacheln sind etwas kleiner als die Felder (Lücken
 * = Gitter-Linien) und liegen knapp vor der Oberfläche.
 */
export function createTileGeometries(piece) {
  const origin = pieceOrigin(piece);
  const gap = 0.07;
  const lift = 0.025;
  const list = [];
  const { kind, i, j, k } = piece;
  if (piece.type === 'wall') {
    const third = S / 3;
    const rowH = H / 3;
    for (let t = 0; t < 9; t++) {
      const row = Math.floor(t / 3);
      const col = t % 3;
      const u0 = col * third + gap;
      const u1 = (col + 1) * third - gap;
      const v0 = (2 - row) * rowH + gap;
      const v1 = (3 - row) * rowH - gap;
      const pos = [];
      const d = T / 2 + lift;
      for (const side of [-1, 1]) {
        const pts = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => (kind === 'wx'
          ? [i * S + u - origin.x, j * H + v - origin.y, k * S + side * d - origin.z]
          : [i * S + side * d - origin.x, j * H + v - origin.y, k * S + u - origin.z]));
        pushQuad(pos, pts);
      }
      list.push(tileGeometry(pos));
    }
    return list;
  }
  const half = S / 2;
  const height = tileHeightFn(piece);
  for (let t = 0; t < 4; t++) {
    const row = Math.floor(t / 2);
    const col = t % 2;
    const x0 = i * S + col * half + gap;
    const x1 = i * S + (col + 1) * half - gap;
    const z0 = k * S + row * half + gap;
    const z1 = k * S + (row + 1) * half - gap;
    const pos = [];
    if (piece.type === 'roof') {
      // Dach-Viertel: zwei Dreiecke (Spitze – Ecken), leicht angehoben
      const cx = i * S + half;
      const cz = k * S + half;
      const outerX = col === 0 ? x0 : x1;
      const outerZ = row === 0 ? z0 : z1;
      const innerX = col === 0 ? cx - gap : cx + gap;
      const innerZ = row === 0 ? cz - gap : cz + gap;
      const P = (x, z) => [x - origin.x, height(x, z) + lift - origin.y, z - origin.z];
      pushQuad(pos, [P(innerX, innerZ), P(outerX, innerZ), P(outerX, outerZ), P(innerX, outerZ)]);
    } else {
      const P = (x, z, dy) => [x - origin.x, height(x, z) + dy - origin.y, z - origin.z];
      const top = piece.type === 'floor' ? T / 2 + lift : lift;
      const bottom = piece.type === 'floor' ? -(T / 2 + lift) : -(RAMP_V_THICKNESS + lift);
      pushQuad(pos, [P(x0, z0, top), P(x1, z0, top), P(x1, z1, top), P(x0, z1, top)]);
      pushQuad(pos, [P(x0, z0, bottom), P(x1, z0, bottom), P(x1, z1, bottom), P(x0, z1, bottom)]);
    }
    list.push(tileGeometry(pos));
  }
  return list;
}

function tileHeightFn(piece) {
  const { i, j, k } = piece;
  if (piece.type === 'floor') return () => j * H;
  if (piece.type === 'ramp') {
    const { a, b, c } = rampPlane(rampSpec(i, j, k, piece.dir));
    return (x, z) => a * x + b * z + c;
  }
  const cx = i * S + S / 2;
  const cz = k * S + S / 2;
  return (x, z) => j * H + B.roofHeight * (1 - Math.min(1, Math.max(Math.abs(x - cx), Math.abs(z - cz)) / (S / 2)));
}

function pushQuad(pos, p) {
  pos.push(...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]);
}

function tileGeometry(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  return g;
}

// --- Bilder (Texturen) -------------------------------------------------------------

/**
 * Malt die Textur eines Materials auf eine Leinwand (1 Bild = 4 x 4 m = eine Wand/ein Boden).
 * Aussehen wie im Original-Stil: HOLZ = helle warme Bretter in einem dunkleren Holz-Rahmen,
 * STEIN = graue Blöcke mit Fugen und Stein-Rahmen, METALL = blaugraues Wellblech mit Rahmen und Nieten.
 * Die Bretter/Reihen laufen waagerecht – auf Rampen also quer (wie Stufen).
 * cracked = mit Rissen (beschädigt).
 */
export function drawMaterialCanvas(material, cracked = false) {
  const px = B.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  const rng = seededRandom(material === 'wood' ? 11 : material === 'stone' ? 23 : 37);
  const color = CONFIG.visuals.colors[material] ?? '#CCCCCC';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, px, px);
  if (material === 'wood') drawWood(ctx, px, rng);
  else if (material === 'stone') drawStone(ctx, px, rng);
  else drawMetal(ctx, px, rng);
  if (cracked) drawCracks(ctx, px, seededRandom(71));
  return canvas;
}

// Rahmen um das ganze Bild: Breite w, Farbe, mit heller Kante innen oben/links und Schatten
function drawFrame(ctx, px, w, color, light, dark) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, px, w);
  ctx.fillRect(0, px - w, px, w);
  ctx.fillRect(0, 0, w, px);
  ctx.fillRect(px - w, 0, w, px);
  const e = Math.max(2, Math.round(w * 0.14));
  // Kanten: außen hell (Licht), innen dunkel (Schatten auf die Füllung)
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, e);
  ctx.fillRect(0, 0, e, px);
  ctx.fillRect(px - w, w, e, px - 2 * w);
  ctx.fillRect(w, px - w, px - 2 * w, e);
  ctx.fillStyle = dark;
  ctx.fillRect(0, px - e, px, e);
  ctx.fillRect(px - e, 0, e, px);
  ctx.fillRect(w - e, w, e, px - 2 * w);
  ctx.fillRect(w, w - e, px - 2 * w, e);
}

function drawWood(ctx, px, rng) {
  const frame = Math.round(px * 0.06);
  const planks = 8;
  const ph = (px - 2 * frame) / planks;
  const seam = Math.max(2, Math.round(px / 170));
  for (let p = 0; p < planks; p++) {
    const y = frame + p * ph;
    // jedes Brett etwas heller/dunkler (warm)
    const tone = (rng() - 0.5) * 0.22;
    ctx.fillStyle = tone > 0 ? `rgba(255, 236, 200, ${tone})` : `rgba(110, 55, 15, ${-tone})`;
    ctx.fillRect(frame, y, px - 2 * frame, ph);
    // Licht oben am Brett, Schatten unten (wirkt plastisch)
    ctx.fillStyle = 'rgba(255, 240, 210, 0.22)';
    ctx.fillRect(frame, y + seam, px - 2 * frame, Math.max(2, ph * 0.08));
    ctx.fillStyle = 'rgba(90, 45, 10, 0.18)';
    ctx.fillRect(frame, y + ph - Math.max(2, ph * 0.12), px - 2 * frame, Math.max(2, ph * 0.12));
    // Maserung
    ctx.strokeStyle = 'rgba(130, 75, 30, 0.22)';
    ctx.lineWidth = Math.max(1, px / 400);
    for (let g = 0; g < 3; g++) {
      const gy = y + ph * (0.25 + rng() * 0.5);
      const phase = rng() * 6;
      ctx.beginPath();
      ctx.moveTo(frame, gy);
      for (let x = frame; x <= px - frame; x += px / 32) ctx.lineTo(x, gy + Math.sin(x * 0.03 + phase) * ph * 0.06);
      ctx.stroke();
    }
    // Ast-Loch ab und zu
    if (rng() < 0.4) {
      const kx = frame + rng() * (px - 2 * frame);
      ctx.fillStyle = 'rgba(110, 60, 20, 0.35)';
      ctx.beginPath();
      ctx.ellipse(kx, y + ph / 2, ph * 0.18, ph * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Fuge zwischen den Brettern
    ctx.fillStyle = 'rgba(70, 35, 10, 0.75)';
    ctx.fillRect(frame, y, px - 2 * frame, seam);
    // Stoß-Fuge (versetzt) + Nägel
    const joint = frame + ((p % 2) * 0.5 + 0.25 + (rng() - 0.5) * 0.08) * (px - 2 * frame);
    ctx.fillRect(joint, y, seam, ph);
    ctx.fillStyle = 'rgba(55, 45, 40, 0.7)';
    for (const nx of [joint - px / 45, joint + px / 45, frame + px / 40, px - frame - px / 40]) {
      ctx.beginPath();
      ctx.arc(nx, y + ph / 2, px / 200, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // dunklerer Holz-Rahmen (Balken) mit Maserung
  drawFrame(ctx, px, frame, '#9C6431', 'rgba(255, 220, 170, 0.45)', 'rgba(60, 28, 5, 0.55)');
  ctx.strokeStyle = 'rgba(80, 40, 10, 0.35)';
  ctx.lineWidth = Math.max(1, px / 300);
  for (const t of [0.35, 0.65]) {
    ctx.beginPath();
    ctx.moveTo(frame * 1.2, frame * t);
    ctx.lineTo(px - frame * 1.2, frame * t);
    ctx.moveTo(frame * 1.2, px - frame * t);
    ctx.lineTo(px - frame * 1.2, px - frame * t);
    ctx.moveTo(frame * t, frame * 1.2);
    ctx.lineTo(frame * t, px - frame * 1.2);
    ctx.moveTo(px - frame * t, frame * 1.2);
    ctx.lineTo(px - frame * t, px - frame * 1.2);
    ctx.stroke();
  }
  // Ecken: Schrauben
  ctx.fillStyle = 'rgba(60, 50, 45, 0.85)';
  for (const [x, y] of [[frame / 2, frame / 2], [px - frame / 2, frame / 2], [frame / 2, px - frame / 2], [px - frame / 2, px - frame / 2]]) {
    ctx.beginPath();
    ctx.arc(x, y, frame * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStone(ctx, px, rng) {
  const frame = Math.round(px * 0.055);
  const inner = px - 2 * frame;
  const rows = 5;
  const rh = inner / rows;
  const mortar = Math.max(3, Math.round(px / 100));
  // Fugen-Farbe als Grund
  ctx.fillStyle = '#6E7176';
  ctx.fillRect(frame, frame, inner, inner);
  for (let r = 0; r < rows; r++) {
    const y = frame + r * rh;
    const blocks = 3;
    const bw = inner / blocks;
    const offset = (r % 2) * 0.5;
    for (let b = -1; b <= blocks; b++) {
      let x0 = frame + (b + offset) * bw;
      let x1 = x0 + bw;
      x0 = Math.max(frame, x0) + mortar / 2;
      x1 = Math.min(px - frame, x1) - mortar / 2;
      if (x1 - x0 < 4) continue;
      const y0 = y + mortar / 2;
      const h = rh - mortar;
      const tone = (rng() - 0.5) * 0.24;
      ctx.fillStyle = CONFIG.visuals.colors.stone;
      ctx.fillRect(x0, y0, x1 - x0, h);
      ctx.fillStyle = tone > 0 ? `rgba(255, 255, 255, ${tone})` : `rgba(0, 0, 0, ${-tone})`;
      ctx.fillRect(x0, y0, x1 - x0, h);
      // Sprenkel
      for (let s = 0; s < 28; s++) {
        ctx.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
        const sz = px / 260 + rng() * px / 130;
        ctx.fillRect(x0 + rng() * (x1 - x0 - sz), y0 + rng() * (h - sz), sz, sz);
      }
      // Kante: oben/links hell, unten/rechts dunkel (behauener Block)
      const e = Math.max(2, Math.round(px / 120));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(x0, y0, x1 - x0, e);
      ctx.fillRect(x0, y0, e, h);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(x0, y0 + h - e, x1 - x0, e);
      ctx.fillRect(x1 - e, y0, e, h);
    }
  }
  drawFrame(ctx, px, frame, '#85888D', 'rgba(255, 255, 255, 0.35)', 'rgba(0, 0, 0, 0.4)');
  // Rahmen aus einzelnen Steinen: Fugen quer im Rahmen
  ctx.fillStyle = 'rgba(40, 42, 46, 0.45)';
  for (let t = 1; t < 6; t++) {
    const s = (t / 6) * px;
    ctx.fillRect(s, 0, mortar * 0.7, frame);
    ctx.fillRect(s, px - frame, mortar * 0.7, frame);
    ctx.fillRect(0, s, frame, mortar * 0.7);
    ctx.fillRect(px - frame, s, frame, mortar * 0.7);
  }
}

function drawMetal(ctx, px, rng) {
  const frame = Math.round(px * 0.06);
  const inner = px - 2 * frame;
  // Wellblech: senkrechte Rillen mit Licht und Schatten
  const period = px / 16;
  for (let x = frame; x < px - frame; x++) {
    const s = Math.sin(((x - frame) / period) * Math.PI * 2);
    const a = s * 0.12;
    ctx.fillStyle = a > 0 ? `rgba(235, 245, 255, ${a})` : `rgba(10, 20, 40, ${-a})`;
    ctx.fillRect(x, frame, 1, inner);
  }
  // leichte Kratzer/Flecken
  for (let n = 0; n < 40; n++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.03 + rng() * 0.05})`;
    ctx.fillRect(frame + rng() * inner, frame + rng() * inner, px / 60 + rng() * px / 25, Math.max(1, px / 400));
  }
  // Querstrebe in der Mitte
  const bar = Math.round(frame * 0.7);
  ctx.fillStyle = '#7086A0';
  ctx.fillRect(frame, px / 2 - bar / 2, inner, bar);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.fillRect(frame, px / 2 - bar / 2, inner, Math.max(2, bar * 0.15));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fillRect(frame, px / 2 + bar / 2 - Math.max(2, bar * 0.15), inner, Math.max(2, bar * 0.15));
  drawFrame(ctx, px, frame, '#6A7F98', 'rgba(225, 238, 255, 0.5)', 'rgba(5, 12, 25, 0.45)');
  // Nieten im Rahmen und auf der Strebe
  const rivet = (x, y) => {
    const r = px / 110;
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
    const s = frame / 2 + (t / steps) * (px - frame);
    rivet(s, frame / 2);
    rivet(s, px - frame / 2);
    rivet(frame / 2, s);
    rivet(px - frame / 2, s);
    if (t > 0 && t < steps) rivet(s, px / 2);
  }
}

function drawCracks(ctx, px, rng) {
  ctx.lineCap = 'round';
  for (let c = 0; c < 5; c++) {
    let x = px * (0.2 + rng() * 0.6);
    let y = px * (0.2 + rng() * 0.6);
    let angle = rng() * Math.PI * 2;
    const steps = 6 + Math.floor(rng() * 5);
    for (let s = 0; s < steps; s++) {
      const len = px * (0.03 + rng() * 0.05);
      const nx = x + Math.cos(angle) * len;
      const ny = y + Math.sin(angle) * len;
      ctx.strokeStyle = 'rgba(25, 18, 12, 0.85)';
      ctx.lineWidth = Math.max(1.5, (px / 110) * (1 - s / steps) + 1);
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
 * Bild für die Bau-Vorschau ("Geist"): weiß, durchsichtig, mit hellem Gitter (1 m) und Rand.
 * Die Farbe (blau = geht, rot = geht nicht) kommt vom Material.
 */
export function createGhostTexture() {
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  const line = 3;
  for (let t = 1; t < 4; t++) {
    const s = (t / 4) * px;
    ctx.fillRect(s - line / 2, 0, line, px);
    ctx.fillRect(0, s - line / 2, px, line);
  }
  const border = 8;
  ctx.fillRect(0, 0, px, border);
  ctx.fillRect(0, px - border, px, border);
  ctx.fillRect(0, 0, border, px);
  ctx.fillRect(px - border, 0, border, px);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Textur (CanvasTexture) für ein Material. */
export function createMaterialTexture(material, cracked, renderer = null) {
  const texture = new THREE.CanvasTexture(drawMaterialCanvas(material, cracked));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
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
