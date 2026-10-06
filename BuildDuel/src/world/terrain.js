// =============================================================================
// Gelände: Höhen-Raster ("Heightfield") + Rauschen für sanfte Hügel
// =============================================================================
// Ein Gelände ist ein Raster aus Höhen-Punkten (z. B. alle 4 m). Zwischen den
// Punkten liegen Dreiecke – GENAU wie im gemalten Gelände-Mesh. Darum steht die
// Figur immer exakt auf der Fläche, die man sieht (heightAt = Bild).
//
// Jedes Raster-Viereck wird an der Diagonalen von (x0, z1) nach (x1, z0) geteilt:
//   Dreieck A: (x0,z0) (x0,z1) (x1,z0)   – wenn u + v ≤ 1
//   Dreieck B: (x0,z1) (x1,z1) (x1,z0)   – sonst
// (u, v = Lage im Viereck von 0 bis 1). buildTerrainGeometry teilt genauso.
//
// Außerdem: createNoise(seed) – weiches "Werte-Rauschen" mit Startwert (gleicher
// Startwert = gleiche Hügel) und fbm() = mehrere Rausch-Lagen übereinander.
// =============================================================================
import * as THREE from 'three';
import { createRng } from '../util/random.js';

/**
 * Weiches Rauschen (Werte-Rauschen auf einem Gitter, weich interpoliert).
 * @param {number} seed
 * @returns {{ noise(x, z) → -1..1, fbm(x, z, octaves) → etwa -1..1 }}
 */
export function createNoise(seed) {
  const rng = createRng(seed);
  const size = 256;
  const values = new Float32Array(size);
  const perm = new Uint8Array(size * 2);
  for (let i = 0; i < size; i++) {
    values[i] = rng() * 2 - 1;
    perm[i] = i;
  }
  // mischen (gleicher Startwert = gleiche Reihenfolge)
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < size; i++) perm[size + i] = perm[i];

  const value = (ix, iz) => values[perm[(perm[ix & 255] + iz) & 255]];
  const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  function noise(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const u = smooth(fx);
    const v = smooth(fz);
    const a = value(ix, iz);
    const b = value(ix + 1, iz);
    const c = value(ix, iz + 1);
    const d = value(ix + 1, iz + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function fbm(x, z, octaves = 4) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq + o * 17.3, z * freq - o * 9.1) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  return { noise, fbm };
}

/**
 * Höhen-Raster. Punkte (ix, iz) liegen bei x = minX + ix · cell, z = minZ + iz · cell.
 * @param {object} spec  { minX, minZ, cell, countX, countZ, heights (Float32Array countX·countZ, Index iz·countX + ix),
 *                         outsideHeight (Höhe außerhalb des Rasters; Standard: Rand-Wert) }
 * @returns {object} Gelände für world.setTerrain: { heightAt(x, z), isFlat: false, maxHeight, minHeight, … }
 */
export function createHeightfield(spec) {
  const { minX, minZ, cell, countX, countZ, heights } = spec;
  const inv = 1 / cell;
  const maxX = minX + (countX - 1) * cell;
  const maxZ = minZ + (countZ - 1) * cell;
  let maxHeight = -Infinity;
  let minHeight = Infinity;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] > maxHeight) maxHeight = heights[i];
    if (heights[i] < minHeight) minHeight = heights[i];
  }
  const outside = spec.outsideHeight;
  if (outside !== undefined) {
    maxHeight = Math.max(maxHeight, outside);
    minHeight = Math.min(minHeight, outside);
  }

  const field = {
    isFlat: false,
    minX,
    minZ,
    maxX,
    maxZ,
    cell,
    countX,
    countZ,
    heights,
    maxHeight,
    minHeight,
    /** Höhe an einem Raster-Punkt (wird an den Rand geschoben). */
    sample(ix, iz) {
      if (ix < 0) ix = 0;
      else if (ix > countX - 1) ix = countX - 1;
      if (iz < 0) iz = 0;
      else if (iz > countZ - 1) iz = countZ - 1;
      return heights[iz * countX + ix];
    },
    /** Höhe des Geländes an (x, z) – genau wie die gemalten Dreiecke. */
    heightAt(x, z) {
      if (outside !== undefined && (x < minX || x > maxX || z < minZ || z > maxZ)) return outside;
      let gx = (x - minX) * inv;
      let gz = (z - minZ) * inv;
      if (gx < 0) gx = 0;
      else if (gx > countX - 1) gx = countX - 1;
      if (gz < 0) gz = 0;
      else if (gz > countZ - 1) gz = countZ - 1;
      let ix = Math.floor(gx);
      let iz = Math.floor(gz);
      if (ix >= countX - 1) ix = countX - 2;
      if (iz >= countZ - 1) iz = countZ - 2;
      const u = gx - ix;
      const v = gz - iz;
      const i00 = iz * countX + ix;
      const h00 = heights[i00];
      const h10 = heights[i00 + 1];
      const h01 = heights[i00 + countX];
      if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
      const h11 = heights[i00 + countX + 1];
      return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    },
    /** Steigung (Länge des Gefälles, m pro m) an (x, z). */
    slopeAt(x, z) {
      const e = cell * 0.25;
      const dx = (field.heightAt(x + e, z) - field.heightAt(x - e, z)) / (2 * e);
      const dz = (field.heightAt(x, z + e) - field.heightAt(x, z - e)) / (2 * e);
      return Math.hypot(dx, dz);
    },
  };
  return field;
}

/**
 * Füllt ein Höhen-Raster mit einer Funktion heightFn(x, z).
 * @returns {Float32Array}
 */
export function sampleHeights(minX, minZ, cell, countX, countZ, heightFn) {
  const heights = new Float32Array(countX * countZ);
  for (let iz = 0; iz < countZ; iz++) {
    const z = minZ + iz * cell;
    for (let ix = 0; ix < countX; ix++) heights[iz * countX + ix] = heightFn(minX + ix * cell, z);
  }
  return heights;
}

/**
 * Macht zu steile Stellen flacher: Kein Nachbar-Punkt darf mehr als maxRise höher sein
 * (mehrere Durchgänge, senkt nur ab). So bleiben alle Hänge begehbar.
 * fixed(ix, iz) → true: Punkt nicht verändern (z. B. flache Stadt).
 */
export function limitSlopes(heights, countX, countZ, maxRise, passes = 6, fixed = null) {
  const diag = maxRise * Math.SQRT2;
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (let iz = 0; iz < countZ; iz++) {
      for (let ix = 0; ix < countX; ix++) {
        const i = iz * countX + ix;
        if (fixed && fixed(ix, iz)) continue;
        let limit = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          const jz = iz + dz;
          if (jz < 0 || jz >= countZ) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const jx = ix + dx;
            if (jx < 0 || jx >= countX) continue;
            const allowed = heights[jz * countX + jx] + (dx !== 0 && dz !== 0 ? diag : maxRise);
            if (allowed < limit) limit = allowed;
          }
        }
        if (heights[i] > limit + 1e-4) {
          heights[i] = limit;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return heights;
}

/**
 * Gelände-Mesh (nur Grafik), Dreiecke genau wie heightAt.
 * @param {object} field  aus createHeightfield
 * @param {(x, z, h, out: THREE.Color) => void} colorFn  Farbe pro Punkt
 * @param {object} [options] { uvScale (Bild-Kacheln pro Meter, Standard 1/4 = eine Kachel pro Bau-Zelle) }
 * @returns {THREE.BufferGeometry}
 */
export function buildTerrainGeometry(field, colorFn, options = {}) {
  const { minX, minZ, cell, countX, countZ, heights } = field;
  const uvScale = options.uvScale ?? 0.25;
  const count = countX * countZ;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const normals = new Float32Array(count * 3);
  const color = new THREE.Color();
  for (let iz = 0; iz < countZ; iz++) {
    for (let ix = 0; ix < countX; ix++) {
      const i = iz * countX + ix;
      const x = minX + ix * cell;
      const z = minZ + iz * cell;
      const h = heights[i];
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x * uvScale;
      uvs[i * 2 + 1] = -z * uvScale;
      colorFn(x, z, h, color);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      // Normale aus den Nachbar-Höhen (weich)
      const hl = field.sample(ix - 1, iz);
      const hr = field.sample(ix + 1, iz);
      const hd = field.sample(ix, iz - 1);
      const hu = field.sample(ix, iz + 1);
      const nx = hl - hr;
      const nz = hd - hu;
      const ny = 2 * cell;
      const len = Math.hypot(nx, ny, nz);
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    }
  }
  const quads = (countX - 1) * (countZ - 1);
  const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
  const index = new IndexArray(quads * 6);
  let p = 0;
  for (let iz = 0; iz < countZ - 1; iz++) {
    for (let ix = 0; ix < countX - 1; ix++) {
      const a = iz * countX + ix; // (x0, z0)
      const b = a + 1; // (x1, z0)
      const c = a + countX; // (x0, z1)
      const d = c + 1; // (x1, z1)
      // Vorderseite nach oben (gegen den Uhrzeigersinn von oben gesehen)
      index[p++] = a;
      index[p++] = c;
      index[p++] = b;
      index[p++] = c;
      index[p++] = d;
      index[p++] = b;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Helle Boden-Kachel (wird mit der Punkt-Farbe eingefärbt): feine Flecken und
 * eine zarte Linie im 4-m-Bauraster (wie in der Arena).
 */
export function createGroundDetailTexture(config, renderer, seed = 4242) {
  const px = 128;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, px, px);
  const rng = createRng(seed);
  for (let i = 0; i < 160; i++) {
    const light = rng() < 0.5;
    ctx.fillStyle = light ? 'rgba(255, 255, 230, 0.10)' : 'rgba(0, 30, 0, 0.07)';
    ctx.fillRect(rng() * px, rng() * px, 1 + rng() * 6, 1 + rng() * 6);
  }
  if (config.visuals.groundGridLines) {
    ctx.fillStyle = `rgba(0, 30, 0, ${config.visuals.groundGridOpacity})`;
    ctx.fillRect(0, 0, px, 1);
    ctx.fillRect(0, 0, 1, px);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  return texture;
}

/** Weicher Übergang 0 → 1 zwischen edge0 und edge1. */
export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
