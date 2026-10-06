// =============================================================================
// Bauteile: Form, Kollision und Aussehen
// =============================================================================
// Für jedes Bauteil (Wand, Boden, Rampe, Dach) steht hier:
//   - pieceColliderSpecs(): aus welchen Kollisions-Teilen es besteht – je nach
//     Edit (entfernte Felder). Wand: Boxen (zusammengefasst), Tür: zusätzlich ein
//     Tür-Blatt (nur wenn zu). Boden: Boxen. Rampe/Dach: zugeschnittene Schrägen
//     (halbe Rampe, Eck-Rampe, Dach-Viertel …).
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
    else addRamp(pos, uv, s.spec, origin, cell, rampDir);
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

// Höhe einer (Rampen-)Schräge: a·x + b·z + c
function rampPlane(spec) {
  const slope = spec.rise / S;
  const d = spec.dir;
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
  const vT = RAMP_V_THICKNESS;
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

/** Form eines Bauteils im aktuellen Edit-Zustand (ohne Tür-Blatt), relativ zu pieceOrigin. */
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
 * Malt die Textur eines Materials auf eine Leinwand (1 Bild = 4 x 4 m).
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
  // Rand (Kante des Bauteils) etwas dunkler – Teile heben sich voneinander ab
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.lineWidth = px / 64;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, px - ctx.lineWidth, px - ctx.lineWidth);
  if (cracked) drawCracks(ctx, px, seededRandom(71));
  return canvas;
}

function drawWood(ctx, px, rng) {
  const planks = 8;
  const ph = px / planks;
  for (let p = 0; p < planks; p++) {
    const y = p * ph;
    // jedes Brett etwas heller/dunkler
    const tone = (rng() - 0.5) * 0.16;
    ctx.fillStyle = tone > 0 ? `rgba(255, 240, 210, ${tone})` : `rgba(80, 40, 10, ${-tone})`;
    ctx.fillRect(0, y, px, ph);
    // Maserung
    ctx.strokeStyle = 'rgba(120, 70, 30, 0.18)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      const gy = y + ph * (0.25 + rng() * 0.5);
      ctx.beginPath();
      ctx.moveTo(0, gy);
      for (let x = 0; x <= px; x += px / 8) ctx.lineTo(x, gy + Math.sin(x * 0.05 + rng() * 3) * 1.5);
      ctx.stroke();
    }
    // Fuge zwischen den Brettern
    ctx.fillStyle = 'rgba(70, 35, 10, 0.55)';
    ctx.fillRect(0, y, px, Math.max(2, px / 128));
    // Stoß-Fuge (versetzt) + Nägel
    const joint = ((p % 2) * 0.5 + 0.25 + (rng() - 0.5) * 0.1) * px;
    ctx.fillRect(joint, y, Math.max(2, px / 128), ph);
    ctx.fillStyle = 'rgba(60, 50, 40, 0.6)';
    for (const nx of [joint - px / 40, joint + px / 40]) {
      ctx.beginPath();
      ctx.arc(nx, y + ph / 2, px / 160, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawStone(ctx, px, rng) {
  const rows = 4;
  const rh = px / rows;
  const mortar = Math.max(3, px / 64);
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    const offset = (r % 2) * 0.5;
    const blocks = 2;
    for (let b = -1; b <= blocks; b++) {
      const x = ((b + offset) / blocks) * px;
      const w = px / blocks;
      const tone = (rng() - 0.5) * 0.2;
      ctx.fillStyle = tone > 0 ? `rgba(255, 255, 255, ${tone})` : `rgba(0, 0, 0, ${-tone})`;
      ctx.fillRect(x, y, w, rh);
      // Sprenkel
      for (let s = 0; s < 40; s++) {
        ctx.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
        ctx.fillRect(x + rng() * w, y + rng() * rh, 2 + rng() * 3, 2 + rng() * 3);
      }
      // Fuge links
      ctx.fillStyle = 'rgba(60, 60, 60, 0.55)';
      ctx.fillRect(x - mortar / 2, y, mortar, rh);
      // Licht oben, Schatten unten am Block
      ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.fillRect(x + mortar / 2, y + mortar / 2, w - mortar, mortar);
    }
    ctx.fillStyle = 'rgba(60, 60, 60, 0.55)';
    ctx.fillRect(0, y - mortar / 2, px, mortar);
  }
}

function drawMetal(ctx, px, rng) {
  const panels = 2;
  const pw = px / panels;
  // feine Streifen (gebürstet)
  for (let y = 0; y < px; y += 3) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.02 + rng() * 0.04})`;
    ctx.fillRect(0, y, px, 1);
  }
  for (let a = 0; a < panels; a++) {
    for (let b = 0; b < panels; b++) {
      const x = a * pw;
      const y = b * pw;
      const inset = px / 40;
      // Platte mit Rand
      ctx.strokeStyle = 'rgba(30, 40, 55, 0.55)';
      ctx.lineWidth = Math.max(2, px / 96);
      ctx.strokeRect(x + inset, y + inset, pw - 2 * inset, pw - 2 * inset);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.strokeRect(x + inset + 2, y + inset + 2, pw - 2 * inset - 4, pw - 2 * inset - 4);
      // Nieten an den Ecken und Kanten-Mitten
      const r = px / 90;
      for (const fx of [0.12, 0.5, 0.88]) {
        for (const fy of [0.12, 0.5, 0.88]) {
          if (fx === 0.5 && fy === 0.5) continue;
          const cx = x + fx * pw;
          const cy = y + fy * pw;
          ctx.fillStyle = 'rgba(20, 28, 40, 0.55)';
          ctx.beginPath();
          ctx.arc(cx + 1, cy + 1, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(235, 242, 250, 0.75)';
          ctx.beginPath();
          ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
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
