// =============================================================================
// Kollisions-Welt ("CollisionWorld")
// =============================================================================
// Hier steht alles, woran man anstoßen oder worauf man stehen kann:
//   - Boxen (Kisten, Wände, Böden, Plattformen) als achsen-parallele Quader
//   - Schrägen: Rampen (dir 0..3) und Pyramiden-Dächer ('pyramid'), jeweils als
//     dünne Platte mit einer Dicke
//   - Gelände (terrain): Höhe des Bodens an jeder Stelle (Standard: flach bei 0)
//
// Damit Abfragen auch bei 3000 Bauteilen schnell bleiben, liegen alle Collider
// zusätzlich in einem "Raumgitter" (spatial hash): Die Welt ist in Würfel mit
// der Kantenlänge einer Bau-Zelle (5,12 m) geteilt. Eine Abfrage schaut nur in die Würfel in der Nähe.
// Strahlen (raycast) wandern Würfel für Würfel durch das Gitter ("3D-DDA") und
// hören auf, sobald der nächste Treffer sicher gefunden ist.
//
// Leistung: Die Funktionen legen bei einem Aufruf KEINE neuen Objekte an.
//   - queryBox(min, max, out): füllt das Array "out" (wird vorher geleert).
//     Ohne "out" wird ein internes Array benutzt – gültig bis zur nächsten Abfrage.
//   - raycast(origin, dir, maxDist, options, out): füllt "out".
//     Ohne "out" wird ein internes Ergebnis-Objekt benutzt – gültig bis zum
//     nächsten raycast-Aufruf. Wer das Ergebnis länger braucht, gibt "out" mit.
//     "dir" muss die Länge 1 haben.
//
// Koordinaten: Y zeigt nach oben, 1 Einheit = 1 Meter (siehe ARCHITECTURE.md).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';

const EPS = 1e-6;
const OVERLAP_EPS = 1e-5; // "berühren" zählt nicht als "stecken in"

// Raster-Schlüssel: Zellen-Nummern von -2048 bis 2047 je Achse (= ±10 km bei 5,12 m)
const GRID_OFFSET = 2048;
const GRID_SIZE = 4096;

/** Flaches Gelände (Standard). */
export function createFlatTerrain(height = 0) {
  return {
    isFlat: true,
    height,
    maxHeight: height,
    heightAt() {
      return this.height;
    },
  };
}

/** Ein leeres Treffer-Objekt (zum Wiederverwenden als "out"). */
export function createRayHit() {
  return {
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    collider: null,
    character: null,
    part: null, // 'head' | 'body' bei Figuren
    terrain: false,
  };
}

export class CollisionWorld {
  /** @param {object} [config]  CONFIG (für Raster-Größe und Figuren-Maße) */
  constructor(config = CONFIG) {
    this.config = config;
    this.cellSize = config.world.gridCellSize;
    this.invCell = 1 / this.cellSize;
    this.terrain = createFlatTerrain(0);
    this.bigCellLimit = config.physics?.bigColliderCells ?? 256;

    this.colliders = []; // alle Collider (auch ausgeschaltete)
    this._cells = new Map(); // Schlüssel → Array von Collidern
    this._big = []; // sehr große Collider (über viele Zellen) – werden immer geprüft
    this._nextId = 1;
    this._stamp = 1; // gegen doppeltes Prüfen eines Colliders in mehreren Zellen
    this._resetBounds();

    // wiederverwendete Hilfs-Objekte
    this._queryOut = [];
    this._hit = createRayHit();
    this._tmpHit = createRayHit();
    this._headHit = createRayHit();
    this._range = { min: 0, max: 0 };
  }

  // ---------------------------------------------------------------------------
  // Collider anlegen / entfernen
  // ---------------------------------------------------------------------------

  /**
   * Fügt eine Box hinzu.
   * @param {THREE.Vector3|{x,y,z}} min  untere Ecke
   * @param {THREE.Vector3|{x,y,z}} max  obere Ecke
   * @param {object} [data]  frei (siehe ARCHITECTURE.md: kind, ref, harvest, owner, blocksBullets)
   */
  addBox(min, max, data = null) {
    const collider = {
      id: this._nextId++,
      type: 'box',
      min: new THREE.Vector3(Math.min(min.x, max.x), Math.min(min.y, max.y), Math.min(min.z, max.z)),
      max: new THREE.Vector3(Math.max(min.x, max.x), Math.max(min.y, max.y), Math.max(min.z, max.z)),
      data: data ?? { kind: 'static' },
      enabled: true,
      _stamp: 0,
      _index: -1,
      _cells: null,
    };
    this._insert(collider);
    return collider;
  }

  /**
   * Fügt eine Schräge hinzu: Rampe oder Pyramiden-Dach.
   * spec = { minX, maxX, minZ, maxZ, baseY, rise, dir, thickness, clip? }
   *   dir 0..3: Rampe steigt Richtung +X, +Z, −X, −Z (von baseY auf baseY + rise)
   *   dir 'pyramid': Dach, Spitze in der Mitte (baseY + rise), Ränder bei baseY
   *   raise (nur Pyramide, optional): Bitmaske der hochgezogenen Ecken (Edit wie in
   *     Fortnite): Bit t = Ecke t (t = Reihe·2 + Spalte, Spalte entlang x, Reihe entlang z,
   *     0 = kleines x/z). Eine hochgezogene Ecke liegt auf Spitzen-Höhe (baseY + rise).
   *     Die Fläche besteht immer aus 4 Dreiecken (Kanten-Ecken + Mitte).
   *   thickness: Dicke der Platte (senkrecht zur Fläche gemessen)
   *   clip (Welle 2a, optional): { minX, maxX, minZ, maxZ } – nur dieses Stück der
   *     Schräge ist da (editierte Rampen/Dächer: halbe Rampe, Dach-Viertel). Form und
   *     Höhe bleiben wie bei der ganzen Schräge, nur der Umriss wird kleiner.
   */
  addSlope(spec, data = null) {
    const collider = {
      id: this._nextId++,
      type: 'slope',
      spec: { ...spec },
      min: new THREE.Vector3(),
      max: new THREE.Vector3(),
      data: data ?? { kind: 'static' },
      enabled: true,
      // werden in _prepareSlope berechnet:
      kind: 'ramp', // 'ramp' | 'pyramid'
      minX: 0, maxX: 0, minZ: 0, maxZ: 0, baseY: 0, rise: 0,
      a: 0, b: 0, c: 0, // Rampe: Höhe = a·x + b·z + c
      cx: 0, cz: 0, hx: 1, hz: 1, // Pyramide: Mitte und halbe Kantenlängen
      raised: 0, h0: 0, h1: 0, h2: 0, h3: 0, // Pyramide: hochgezogene Ecken (Bitmaske) und Höhen der 4 Ecken
      vThickness: 0, // Dicke senkrecht (in Y) gemessen
      planes: null, // Float64Array: je Ebene nx, ny, nz, d (Innen: n·p − d ≤ 0)
      parts: null, // Array von [Start, Anzahl] – konvexe Teilstücke
      _stamp: 0,
      _index: -1,
      _cells: null,
    };
    prepareSlope(collider);
    this._insert(collider);
    return collider;
  }

  /** Entfernt einen Collider. */
  remove(collider) {
    if (!collider || collider._index < 0) return;
    this._unhash(collider);
    const last = this.colliders.pop();
    if (last !== collider) {
      this.colliders[collider._index] = last;
      last._index = collider._index;
    }
    collider._index = -1;
  }

  /** Nach einer Änderung der Maße (min/max bzw. spec) aufrufen. */
  updateCollider(collider) {
    if (!collider || collider._index < 0) return;
    this._unhash(collider);
    if (collider.type === 'slope') prepareSlope(collider);
    this._hash(collider);
  }

  /** Alles entfernen. */
  clear() {
    for (const c of this.colliders) c._index = -1;
    this.colliders.length = 0;
    this._cells.clear();
    this._big.length = 0;
    this._resetBounds();
  }

  /** Gelände austauschen. terrain = { heightAt(x, z), isFlat?, height?, maxHeight? } */
  setTerrain(terrain) {
    this.terrain = terrain ?? createFlatTerrain(0);
  }

  // ---------------------------------------------------------------------------
  // Abfragen
  // ---------------------------------------------------------------------------

  /**
   * Alle eingeschalteten Collider, die die Box berühren.
   * @param {{x,y,z}} min
   * @param {{x,y,z}} max
   * @param {Array} [out]  wird geleert und gefüllt
   * @returns {Array}
   */
  queryBox(min, max, out = this._queryOut) {
    out.length = 0;
    if (this.colliders.length === 0) return out;
    const stamp = this._nextStamp();
    const inv = this.invCell;
    const ix0 = Math.max(this._cellMinX, Math.floor(min.x * inv));
    const iy0 = Math.max(this._cellMinY, Math.floor(min.y * inv));
    const iz0 = Math.max(this._cellMinZ, Math.floor(min.z * inv));
    const ix1 = Math.min(this._cellMaxX, Math.floor(max.x * inv));
    const iy1 = Math.min(this._cellMaxY, Math.floor(max.y * inv));
    const iz1 = Math.min(this._cellMaxZ, Math.floor(max.z * inv));
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const list = this._cells.get(cellKey(ix, iy, iz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const c = list[i];
            if (c._stamp === stamp) continue;
            c._stamp = stamp;
            if (c.enabled && touches(c, min, max)) out.push(c);
          }
        }
      }
    }
    for (let i = 0; i < this._big.length; i++) {
      const c = this._big[i];
      if (c._stamp === stamp) continue;
      c._stamp = stamp;
      if (c.enabled && touches(c, min, max)) out.push(c);
    }
    return out;
  }

  /**
   * Steckt etwas in der Box? (nur Collider, nicht das Gelände)
   * Schrägen zählen mit ihrer echten Form (Platte), nicht mit ihrem Umriss.
   * @param {(collider) => boolean} [ignore]
   */
  boxBlocked(min, max, ignore = null) {
    const list = this.queryBox(min, max);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (ignore && ignore(c)) continue;
      if (c.type === 'box') {
        if (overlapsStrict(c, min, max)) return true;
      } else if (slopeIntersectsBox(c, min.x, min.y, min.z, max.x, max.y, max.z, this._range)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Höchste begehbare Fläche an der Stelle (x, z), die nicht höher als maxY ist:
   * Gelände, Oberkanten von Boxen und Schrägen. Ohne Treffer: -Infinity.
   */
  surfaceHeight(x, z, maxY = Infinity) {
    let best = -Infinity;
    const t = this.terrain.heightAt(x, z);
    if (t <= maxY + EPS) best = t;
    if (this.colliders.length === 0) return best;
    const stamp = this._nextStamp();
    const inv = this.invCell;
    const ix = Math.floor(x * inv);
    const iz = Math.floor(z * inv);
    if (ix < this._cellMinX || ix > this._cellMaxX || iz < this._cellMinZ || iz > this._cellMaxZ) {
      return this._surfaceBig(x, z, maxY, best, stamp);
    }
    const top = Math.min(this._cellMaxY, Math.floor(Math.min(maxY, 1e6) * inv));
    for (let iy = this._cellMinY; iy <= top; iy++) {
      const list = this._cells.get(cellKey(ix, iy, iz));
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c._stamp === stamp) continue;
        c._stamp = stamp;
        best = surfaceOf(c, x, z, maxY, best);
      }
    }
    return this._surfaceBig(x, z, maxY, best, stamp);
  }

  _surfaceBig(x, z, maxY, best, stamp) {
    for (let i = 0; i < this._big.length; i++) {
      const c = this._big[i];
      if (c._stamp === stamp) continue;
      c._stamp = stamp;
      best = surfaceOf(c, x, z, maxY, best);
    }
    return best;
  }

  /**
   * Strahl-Test: Was trifft ein Strahl von origin in Richtung dir zuerst?
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir      Länge 1!
   * @param {number} maxDist
   * @param {object} [options]       { ignore(collider) → bool, characters: Character[] | null,
   *                                   ignoreCharacter, skipTerrain }
   * @param {object} [out]           Treffer-Objekt (siehe createRayHit)
   * @returns {object|null}          Treffer oder null
   */
  raycast(origin, dir, maxDist, options = null, out = this._hit) {
    const ignore = options?.ignore ?? null;
    let best = maxDist;
    let found = false;
    const tmp = this._tmpHit;

    // --- 1. Collider im Raumgitter ------------------------------------------
    if (this.colliders.length > 0) {
      const stamp = this._nextStamp();
      // nur den Teil des Strahls betrachten, der im belegten Bereich liegt
      const cs = this.cellSize;
      const range = clipRayToBox(origin, dir, 0, maxDist,
        this._cellMinX * cs, this._cellMinY * cs, this._cellMinZ * cs,
        (this._cellMaxX + 1) * cs, (this._cellMaxY + 1) * cs, (this._cellMaxZ + 1) * cs, this._range);
      if (range) {
        const tStart = range.min;
        const tEnd = range.max;
        const inv = this.invCell;
        const px = origin.x + dir.x * tStart;
        const py = origin.y + dir.y * tStart;
        const pz = origin.z + dir.z * tStart;
        let ix = clampInt(Math.floor(px * inv), this._cellMinX, this._cellMaxX);
        let iy = clampInt(Math.floor(py * inv), this._cellMinY, this._cellMaxY);
        let iz = clampInt(Math.floor(pz * inv), this._cellMinZ, this._cellMaxZ);
        const stepX = dir.x > 0 ? 1 : -1;
        const stepY = dir.y > 0 ? 1 : -1;
        const stepZ = dir.z > 0 ? 1 : -1;
        const tDeltaX = Math.abs(dir.x) > EPS ? cs / Math.abs(dir.x) : Infinity;
        const tDeltaY = Math.abs(dir.y) > EPS ? cs / Math.abs(dir.y) : Infinity;
        const tDeltaZ = Math.abs(dir.z) > EPS ? cs / Math.abs(dir.z) : Infinity;
        let tMaxX = Math.abs(dir.x) > EPS ? ((ix + (stepX > 0 ? 1 : 0)) * cs - origin.x) / dir.x : Infinity;
        let tMaxY = Math.abs(dir.y) > EPS ? ((iy + (stepY > 0 ? 1 : 0)) * cs - origin.y) / dir.y : Infinity;
        let tMaxZ = Math.abs(dir.z) > EPS ? ((iz + (stepZ > 0 ? 1 : 0)) * cs - origin.z) / dir.z : Infinity;

        for (let guard = 0; guard < 100000; guard++) {
          const list = this._cells.get(cellKey(ix, iy, iz));
          if (list) {
            for (let i = 0; i < list.length; i++) {
              const c = list[i];
              if (c._stamp === stamp) continue;
              c._stamp = stamp;
              if (!c.enabled || (ignore && ignore(c))) continue;
              if (rayCollider(c, origin, dir, best, tmp)) {
                best = tmp.distance;
                copyHit(out, tmp);
                out.collider = c;
                found = true;
              }
            }
          }
          const tNext = Math.min(tMaxX, tMaxY, tMaxZ);
          if (best <= tNext || tNext > tEnd) break;
          if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
            ix += stepX;
            tMaxX += tDeltaX;
            if (ix < this._cellMinX || ix > this._cellMaxX) break;
          } else if (tMaxY <= tMaxZ) {
            iy += stepY;
            tMaxY += tDeltaY;
            if (iy < this._cellMinY || iy > this._cellMaxY) break;
          } else {
            iz += stepZ;
            tMaxZ += tDeltaZ;
            if (iz < this._cellMinZ || iz > this._cellMaxZ) break;
          }
        }
      }
      // sehr große Collider
      for (let i = 0; i < this._big.length; i++) {
        const c = this._big[i];
        if (c._stamp === stamp) continue;
        c._stamp = stamp;
        if (!c.enabled || (ignore && ignore(c))) continue;
        if (rayCollider(c, origin, dir, best, tmp)) {
          best = tmp.distance;
          copyHit(out, tmp);
          out.collider = c;
          found = true;
        }
      }
    }

    // --- 2. Gelände ------------------------------------------------------------
    if (!options?.skipTerrain && this._rayTerrain(origin, dir, best, tmp)) {
      best = tmp.distance;
      copyHit(out, tmp);
      out.collider = null;
      out.terrain = true;
      found = true;
    }

    // --- 3. Figuren (Kapsel + sichtbare Kopf-Kugel) ------------------------------
    // Kopf = die obersten headZone Meter der Kapsel ODER der Strahl trifft die Kopf-Kugel
    // (Oberkante = Kapsel-Oberkante, geduckt etwas nach vorn – wie die Figur im Bild).
    const characters = options?.characters;
    if (characters) {
      const skip = options.ignoreCharacter ?? null;
      const hitbox = this.config.player.hitbox;
      const headHit = this._headHit;
      for (let i = 0; i < characters.length; i++) {
        const ch = characters[i];
        if (!ch || ch === skip || ch.alive === false) continue;
        const height = ch.height ?? hitbox.height;
        const radius = ch.radius ?? hitbox.radius;
        const p = ch.position;
        const capsule = rayCapsule(origin, dir, p.x, p.y, p.z, radius, height, best, tmp);
        headCenter(ch, hitbox, height, _headCenter);
        const head = raySphere(origin, dir, _headCenter.x, _headCenter.y, _headCenter.z, hitbox.headRadius ?? 0, best, headHit);
        if (!capsule && !head) continue;
        // Kopf-Kugel kurz hinter dem Eintritt in die Kapsel getroffen (nicht erst nach dem Körper)?
        const isHead = (head && (!capsule || headHit.distance <= tmp.distance + radius)) ||
          (capsule && tmp.point.y >= p.y + height - hitbox.headZone);
        const use = capsule && (!head || tmp.distance <= headHit.distance) ? tmp : headHit;
        best = use.distance;
        copyHit(out, use);
        out.collider = null;
        out.character = ch;
        out.part = isHead ? 'head' : 'body';
        found = true;
      }
    }

    return found ? out : null;
  }

  // Strahl gegen Gelände: flach = Ebene, sonst schrittweise + Halbieren
  _rayTerrain(origin, dir, maxDist, out) {
    const terrain = this.terrain;
    if (terrain.isFlat) {
      const h = terrain.height ?? 0;
      if (dir.y >= -EPS || origin.y < h) return false;
      const t = (h - origin.y) / dir.y;
      if (t < 0 || t > maxDist) return false;
      setHit(out, origin, dir, t, 0, 1, 0);
      return true;
    }
    const maxHeight = terrain.maxHeight ?? Infinity;
    const step = this.config.physics?.terrainRayStep ?? 1;
    const bisect = this.config.physics?.terrainBisectSteps ?? 12;
    // Nie endlos suchen (z. B. maxDist = Infinity und ein waagerechter Strahl über dem Meer)
    const limit = Math.min(maxDist, this.config.physics?.terrainRayMaxDistance ?? 2000);
    let prevT = 0;
    let prevF = origin.y - terrain.heightAt(origin.x, origin.z);
    if (prevF < 0) return false; // Start unter dem Gelände
    for (let t = Math.min(step, limit); ; t = Math.min(t + step, limit)) {
      const y = origin.y + dir.y * t;
      if (y > maxHeight && dir.y >= 0) return false; // steigt über alle Hügel
      const f = y - terrain.heightAt(origin.x + dir.x * t, origin.z + dir.z * t);
      if (f <= 0) {
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < bisect; i++) {
          const mid = (lo + hi) * 0.5;
          const fm = origin.y + dir.y * mid - terrain.heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid);
          if (fm > 0) lo = mid;
          else hi = mid;
        }
        const x = origin.x + dir.x * hi;
        const z = origin.z + dir.z * hi;
        const e = 0.05;
        const nx = terrain.heightAt(x - e, z) - terrain.heightAt(x + e, z);
        const nz = terrain.heightAt(x, z - e) - terrain.heightAt(x, z + e);
        const len = Math.hypot(nx, 2 * e, nz);
        setHit(out, origin, dir, hi, nx / len, (2 * e) / len, nz / len);
        return true;
      }
      prevT = t;
      prevF = f;
      if (t >= limit) return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Raumgitter (intern)
  // ---------------------------------------------------------------------------

  _nextStamp() {
    this._stamp = (this._stamp + 1) | 0;
    if (this._stamp === 0) this._stamp = 1;
    return this._stamp;
  }

  _resetBounds() {
    this._cellMinX = Infinity;
    this._cellMinY = Infinity;
    this._cellMinZ = Infinity;
    this._cellMaxX = -Infinity;
    this._cellMaxY = -Infinity;
    this._cellMaxZ = -Infinity;
  }

  _insert(collider) {
    collider._index = this.colliders.length;
    this.colliders.push(collider);
    this._hash(collider);
  }

  _cellRange(c) {
    const inv = this.invCell;
    const ix0 = clampInt(Math.floor(c.min.x * inv), -GRID_OFFSET, GRID_OFFSET - 1);
    const iy0 = clampInt(Math.floor(c.min.y * inv), -GRID_OFFSET, GRID_OFFSET - 1);
    const iz0 = clampInt(Math.floor(c.min.z * inv), -GRID_OFFSET, GRID_OFFSET - 1);
    const ix1 = clampInt(Math.max(ix0, Math.floor(c.max.x * inv)), -GRID_OFFSET, GRID_OFFSET - 1);
    const iy1 = clampInt(Math.max(iy0, Math.floor(c.max.y * inv)), -GRID_OFFSET, GRID_OFFSET - 1);
    const iz1 = clampInt(Math.max(iz0, Math.floor(c.max.z * inv)), -GRID_OFFSET, GRID_OFFSET - 1);
    return [ix0, iy0, iz0, ix1, iy1, iz1];
  }

  _hash(c) {
    const r = this._cellRange(c);
    c._cells = r;
    const count = (r[3] - r[0] + 1) * (r[4] - r[1] + 1) * (r[5] - r[2] + 1);
    // Grenzen des belegten Bereichs wachsen mit (für Strahlen)
    if (r[0] < this._cellMinX) this._cellMinX = r[0];
    if (r[1] < this._cellMinY) this._cellMinY = r[1];
    if (r[2] < this._cellMinZ) this._cellMinZ = r[2];
    if (r[3] > this._cellMaxX) this._cellMaxX = r[3];
    if (r[4] > this._cellMaxY) this._cellMaxY = r[4];
    if (r[5] > this._cellMaxZ) this._cellMaxZ = r[5];
    if (count > this.bigCellLimit) {
      c._big = true;
      this._big.push(c);
      return;
    }
    c._big = false;
    for (let ix = r[0]; ix <= r[3]; ix++) {
      for (let iy = r[1]; iy <= r[4]; iy++) {
        for (let iz = r[2]; iz <= r[5]; iz++) {
          const key = cellKey(ix, iy, iz);
          let list = this._cells.get(key);
          if (!list) {
            list = [];
            this._cells.set(key, list);
          }
          list.push(c);
        }
      }
    }
  }

  _unhash(c) {
    if (c._big) {
      const i = this._big.indexOf(c);
      if (i >= 0) {
        this._big[i] = this._big[this._big.length - 1];
        this._big.pop();
      }
      c._big = false;
      return;
    }
    const r = c._cells;
    if (!r) return;
    for (let ix = r[0]; ix <= r[3]; ix++) {
      for (let iy = r[1]; iy <= r[4]; iy++) {
        for (let iz = r[2]; iz <= r[5]; iz++) {
          const key = cellKey(ix, iy, iz);
          const list = this._cells.get(key);
          if (!list) continue;
          const i = list.indexOf(c);
          if (i < 0) continue;
          list[i] = list[list.length - 1];
          list.pop();
          if (list.length === 0) this._cells.delete(key);
        }
      }
    }
    c._cells = null;
    // Die Grenzen schrumpfen nicht mit – das ist nur etwas Rechenzeit, kein Fehler.
  }
}

// =============================================================================
// Hilfsfunktionen (auch von player.js benutzt)
// =============================================================================

function cellKey(ix, iy, iz) {
  return ((ix + GRID_OFFSET) * GRID_SIZE + (iy + GRID_OFFSET)) * GRID_SIZE + (iz + GRID_OFFSET);
}

function clampInt(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// Box berührt Box (Rand zählt mit)
function touches(c, min, max) {
  return c.min.x <= max.x && c.max.x >= min.x &&
    c.min.y <= max.y && c.max.y >= min.y &&
    c.min.z <= max.z && c.max.z >= min.z;
}

// Box steckt wirklich in Box (bloßes Berühren zählt nicht)
function overlapsStrict(c, min, max) {
  return c.min.x < max.x - OVERLAP_EPS && c.max.x > min.x + OVERLAP_EPS &&
    c.min.y < max.y - OVERLAP_EPS && c.max.y > min.y + OVERLAP_EPS &&
    c.min.z < max.z - OVERLAP_EPS && c.max.z > min.z + OVERLAP_EPS;
}

/** Steckt die Box (Achsen-Grenzen) wirklich in der Box c? */
export function boxOverlapsStrict(c, minX, minY, minZ, maxX, maxY, maxZ) {
  return c.min.x < maxX - OVERLAP_EPS && c.max.x > minX + OVERLAP_EPS &&
    c.min.y < maxY - OVERLAP_EPS && c.max.y > minY + OVERLAP_EPS &&
    c.min.z < maxZ - OVERLAP_EPS && c.max.z > minZ + OVERLAP_EPS;
}

function surfaceOf(c, x, z, maxY, best) {
  if (!c.enabled) return best;
  if (c.type === 'box') {
    if (x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z) {
      const top = c.max.y;
      if (top <= maxY + EPS && top > best) return top;
    }
    return best;
  }
  if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) {
    const s = slopeSurfaceY(c, x, z);
    if (s <= maxY + EPS && s > best) return s;
  }
  return best;
}

// --- Schrägen ----------------------------------------------------------------

function prepareSlope(c) {
  const s = c.spec;
  c.minX = Math.min(s.minX, s.maxX);
  c.maxX = Math.max(s.minX, s.maxX);
  c.minZ = Math.min(s.minZ, s.maxZ);
  c.maxZ = Math.max(s.minZ, s.maxZ);
  c.baseY = s.baseY ?? 0;
  c.rise = s.rise ?? (c.maxX - c.minX);
  const thickness = s.thickness ?? 0.2;
  const sizeX = Math.max(EPS, c.maxX - c.minX);
  const sizeZ = Math.max(EPS, c.maxZ - c.minZ);

  if (s.dir === 'pyramid') {
    c.kind = 'pyramid';
    c.cx = (c.minX + c.maxX) / 2;
    c.cz = (c.minZ + c.maxZ) / 2;
    c.hx = sizeX / 2;
    c.hz = sizeZ / 2;
    const slope = c.rise / Math.min(c.hx, c.hz);
    c.vThickness = thickness * Math.sqrt(1 + slope * slope);
    const top = c.baseY + c.rise;
    // Ecken: unten (baseY) oder hochgezogen (Spitzen-Höhe)
    const raise = (s.raise | 0) & 15;
    c.raised = raise;
    c.h0 = raise & 1 ? top : c.baseY;
    c.h1 = raise & 2 ? top : c.baseY;
    c.h2 = raise & 4 ? top : c.baseY;
    c.h3 = raise & 8 ? top : c.baseY;
    // 4 Dach-Flächen (Dreiecke Mitte – Ecke – Ecke), jede ein konvexes Stück mit 5 Ebenen
    c.planes = new Float64Array(4 * 5 * 4);
    c.parts = [];
    let p = 0;
    for (let face = 0; face < 4; face++) {
      const start = p / 4;
      const fx = FACE_X[face];
      const fz = FACE_Z[face];
      pyramidFacePlane(c, face, _plane);
      p = writePlane(c.planes, p, -_plane.a, 1, -_plane.b, _plane.c); // unter der Oberseite
      p = writePlane(c.planes, p, _plane.a, -1, _plane.b, -(_plane.c - c.vThickness)); // über der Unterseite
      if (fx !== 0) {
        // äußere Kante: fx·x ≤ fx·Rand
        p = writePlane(c.planes, p, fx, 0, 0, fx > 0 ? c.maxX : -c.minX);
        // Diagonalen: ±(z−cz)/hz − fx·(x−cx)/hx ≤ 0
        p = writePlane(c.planes, p, -fx / c.hx, 0, 1 / c.hz, -fx * c.cx / c.hx + c.cz / c.hz);
        p = writePlane(c.planes, p, -fx / c.hx, 0, -1 / c.hz, -fx * c.cx / c.hx - c.cz / c.hz);
      } else {
        p = writePlane(c.planes, p, 0, 0, fz, fz > 0 ? c.maxZ : -c.minZ);
        p = writePlane(c.planes, p, 1 / c.hx, 0, -fz / c.hz, c.cx / c.hx - fz * c.cz / c.hz);
        p = writePlane(c.planes, p, -1 / c.hx, 0, -fz / c.hz, -c.cx / c.hx - fz * c.cz / c.hz);
      }
      c.parts.push([start, 5]);
    }
    c.min.set(c.minX, c.baseY - c.vThickness, c.minZ);
    c.max.set(c.maxX, top, c.maxZ);
    applySlopeClip(c);
    return;
  }

  // Rampe
  c.kind = 'ramp';
  const dir = ((Number(s.dir) % 4) + 4) % 4;
  c.spec.dir = dir;
  let a = 0;
  let b = 0;
  let cc = c.baseY;
  let run = sizeX;
  if (dir === 0) { a = c.rise / sizeX; cc = c.baseY - a * c.minX; run = sizeX; }
  if (dir === 2) { a = -c.rise / sizeX; cc = c.baseY - a * c.maxX; run = sizeX; }
  if (dir === 1) { b = c.rise / sizeZ; cc = c.baseY - b * c.minZ; run = sizeZ; }
  if (dir === 3) { b = -c.rise / sizeZ; cc = c.baseY - b * c.maxZ; run = sizeZ; }
  c.a = a;
  c.b = b;
  c.c = cc;
  const slope = c.rise / run;
  c.vThickness = thickness * Math.sqrt(1 + slope * slope);
  c.planes = new Float64Array(6 * 4);
  let p = 0;
  p = writePlane(c.planes, p, -a, 1, -b, cc); // y ≤ a·x + b·z + c
  p = writePlane(c.planes, p, a, -1, b, -(cc - c.vThickness)); // y ≥ a·x + b·z + c − Dicke
  p = writePlane(c.planes, p, -1, 0, 0, -c.minX);
  p = writePlane(c.planes, p, 1, 0, 0, c.maxX);
  p = writePlane(c.planes, p, 0, 0, -1, -c.minZ);
  writePlane(c.planes, p, 0, 0, 1, c.maxZ);
  c.parts = [[0, 6]];
  c.min.set(c.minX, c.baseY - c.vThickness, c.minZ);
  c.max.set(c.maxX, c.baseY + c.rise, c.maxZ);
  applySlopeClip(c);
}

// Welle 2a: Schräge auf ein Rechteck zuschneiden (spec.clip). Die Fläche bleibt
// dieselbe (gleiche Höhe an jeder Stelle), nur der Umriss wird kleiner: Jedes
// konvexe Teilstück bekommt 4 zusätzliche Grenz-Ebenen, und minX..maxZ (für
// Höhe, Abfragen und das Raumgitter) werden auf das Rechteck gesetzt.
function applySlopeClip(c) {
  const clip = c.spec.clip;
  if (!clip) return;
  const minX = Math.max(c.minX, Math.min(clip.minX, clip.maxX));
  const maxX = Math.min(c.maxX, Math.max(clip.minX, clip.maxX));
  const minZ = Math.max(c.minZ, Math.min(clip.minZ, clip.maxZ));
  const maxZ = Math.min(c.maxZ, Math.max(clip.minZ, clip.maxZ));
  if (!(maxX > minX && maxZ > minZ)) return; // leeres Rechteck: ungeschnitten lassen
  const old = c.planes;
  const parts = c.parts;
  const planes = new Float64Array(old.length + parts.length * 4 * 4);
  const newParts = [];
  let p = 0;
  for (const [start, count] of parts) {
    const first = p / 4;
    for (let i = 0; i < count * 4; i++) planes[p++] = old[start * 4 + i];
    p = writePlane(planes, p, -1, 0, 0, -minX);
    p = writePlane(planes, p, 1, 0, 0, maxX);
    p = writePlane(planes, p, 0, 0, -1, -minZ);
    p = writePlane(planes, p, 0, 0, 1, maxZ);
    newParts.push([first, count + 4]);
  }
  c.planes = planes;
  c.parts = newParts;
  c.minX = minX;
  c.maxX = maxX;
  c.minZ = minZ;
  c.maxZ = maxZ;
  // Höhen-Bereich des Stücks (für das Raumgitter und schnelle Vortests)
  const range = { min: 0, max: 0 };
  slopeRangeOverRect(c, minX, maxX, minZ, maxZ, range);
  c.min.set(minX, range.min - c.vThickness, minZ);
  c.max.set(maxX, range.max, maxZ);
}

// Pyramiden-Flächen: 0 = +X, 1 = −X, 2 = +Z, 3 = −Z (Richtung von der Mitte nach außen)
const FACE_X = [1, -1, 0, 0];
const FACE_Z = [0, 0, 1, -1];
const _plane = { a: 0, b: 0, c: 0 };

/**
 * Ebene einer Pyramiden-Fläche (Dreieck Mitte – Ecke – Ecke): Höhe = a·x + b·z + c.
 * Mitte immer auf Spitzen-Höhe, die Ecken auf ihrer Höhe (h0..h3, hochgezogen oder unten).
 * face: 0 = +X, 1 = −X, 2 = +Z, 3 = −Z. Schreibt in out { a, b, c }.
 */
export function pyramidFacePlane(c, face, out) {
  const top = c.baseY + c.rise;
  const fx = FACE_X[face];
  const fz = FACE_Z[face];
  // Ecken der Fläche: ha bei "quer" = −1, hb bei +1 (quer = z bei X-Flächen, x bei Z-Flächen)
  let ha;
  let hb;
  if (fx > 0) { ha = c.h1; hb = c.h3; } else if (fx < 0) { ha = c.h0; hb = c.h2; } else if (fz > 0) { ha = c.h2; hb = c.h3; } else { ha = c.h0; hb = c.h1; }
  const k = (ha + hb) / 2 - top; // Änderung von der Mitte zur Kante
  const l = (hb - ha) / 2; // Änderung quer
  if (fx !== 0) {
    out.a = (fx * k) / c.hx;
    out.b = l / c.hz;
    out.c = top - (fx * k * c.cx) / c.hx - (l * c.cz) / c.hz;
  } else {
    out.a = l / c.hx;
    out.b = (fz * k) / c.hz;
    out.c = top - (l * c.cx) / c.hx - (fz * k * c.cz) / c.hz;
  }
  return out;
}

function writePlane(planes, p, nx, ny, nz, d) {
  planes[p] = nx;
  planes[p + 1] = ny;
  planes[p + 2] = nz;
  planes[p + 3] = d;
  return p + 4;
}

/**
 * Höhe der Oberseite einer Schräge an (x, z). Punkte außerhalb des Umrisses
 * werden an den Rand geschoben.
 */
export function slopeSurfaceY(c, x, z) {
  if (x < c.minX) x = c.minX;
  else if (x > c.maxX) x = c.maxX;
  if (z < c.minZ) z = c.minZ;
  else if (z > c.maxZ) z = c.maxZ;
  if (c.kind === 'pyramid') {
    const u = (x - c.cx) / c.hx;
    const w = (z - c.cz) / c.hz;
    const au = Math.abs(u);
    const aw = Math.abs(w);
    if (!c.raised) return c.baseY + c.rise * (1 - Math.min(1, au > aw ? au : aw));
    // hochgezogene Ecken: Dreieck Mitte – Ecke – Ecke der Fläche, in der (x, z) liegt
    const top = c.baseY + c.rise;
    let s;
    let t;
    let ha;
    let hb;
    if (au >= aw) {
      s = au;
      t = w;
      if (u >= 0) { ha = c.h1; hb = c.h3; } else { ha = c.h0; hb = c.h2; }
    } else {
      s = aw;
      t = u;
      if (w >= 0) { ha = c.h2; hb = c.h3; } else { ha = c.h0; hb = c.h1; }
    }
    if (s > 1) s = 1;
    return top + s * ((ha + hb) / 2 - top) + (t * (hb - ha)) / 2;
  }
  return c.a * x + c.b * z + c.c;
}

/**
 * Kleinste und größte Höhe der Oberseite über dem Rechteck (geschnitten mit dem
 * Umriss der Schräge). Schreibt in out { min, max }. false = kein Überlapp.
 */
export function slopeRangeOverRect(c, x0, x1, z0, z1, out) {
  const ax = Math.max(x0, c.minX);
  const bx = Math.min(x1, c.maxX);
  const az = Math.max(z0, c.minZ);
  const bz = Math.min(z1, c.maxZ);
  if (ax > bx || az > bz) return false;
  if (c.kind === 'pyramid' && c.raised) {
    // stückweise eben (4 Dreiecke): Extremwerte an den Ecken des Rechtecks, in der Mitte
    // und dort, wo die Grate (Diagonalen) den Rand des Rechtecks schneiden
    out.min = Infinity;
    out.max = -Infinity;
    rangePoint(c, ax, az, out);
    rangePoint(c, bx, az, out);
    rangePoint(c, ax, bz, out);
    rangePoint(c, bx, bz, out);
    if (c.cx >= ax && c.cx <= bx && c.cz >= az && c.cz <= bz) rangePoint(c, c.cx, c.cz, out);
    const q = c.hx / c.hz;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      // Diagonale x − cx = sgn·(z − cz)·hx/hz
      let x = c.cx + sgn * (az - c.cz) * q;
      if (x > ax && x < bx) rangePoint(c, x, az, out);
      x = c.cx + sgn * (bz - c.cz) * q;
      if (x > ax && x < bx) rangePoint(c, x, bz, out);
      let z = c.cz + (sgn * (ax - c.cx)) / q;
      if (z > az && z < bz) rangePoint(c, ax, z, out);
      z = c.cz + (sgn * (bx - c.cx)) / q;
      if (z > az && z < bz) rangePoint(c, bx, z, out);
    }
    return true;
  }
  if (c.kind === 'pyramid') {
    // höchster Punkt: dem Mittelpunkt am nächsten; tiefster: an einer Ecke
    const px = c.cx < ax ? ax : c.cx > bx ? bx : c.cx;
    const pz = c.cz < az ? az : c.cz > bz ? bz : c.cz;
    out.max = slopeSurfaceY(c, px, pz);
    const fx = Math.max(Math.abs(ax - c.cx), Math.abs(bx - c.cx)) / c.hx;
    const fz = Math.max(Math.abs(az - c.cz), Math.abs(bz - c.cz)) / c.hz;
    out.min = c.baseY + c.rise * (1 - Math.min(1, Math.max(fx, fz)));
    return true;
  }
  // Rampe: Ebene → Extremwerte an den Ecken
  const h00 = c.a * ax + c.b * az + c.c;
  const h11 = c.a * bx + c.b * bz + c.c;
  const h01 = c.a * ax + c.b * bz + c.c;
  const h10 = c.a * bx + c.b * az + c.c;
  out.min = Math.min(h00, h11, h01, h10);
  out.max = Math.max(h00, h11, h01, h10);
  return true;
}

// Höhe an (x, z) in den Bereich out { min, max } aufnehmen
function rangePoint(c, x, z, out) {
  const h = slopeSurfaceY(c, x, z);
  if (h < out.min) out.min = h;
  if (h > out.max) out.max = h;
}

/** Schneidet die Box die Platte der Schräge? (vorsichtige Prüfung über den Umriss) */
export function slopeIntersectsBox(c, minX, minY, minZ, maxX, maxY, maxZ, range) {
  if (maxX <= c.minX + OVERLAP_EPS || minX >= c.maxX - OVERLAP_EPS) return false;
  if (maxZ <= c.minZ + OVERLAP_EPS || minZ >= c.maxZ - OVERLAP_EPS) return false;
  if (!slopeRangeOverRect(c, minX, maxX, minZ, maxZ, range)) return false;
  return minY < range.max - OVERLAP_EPS && maxY > range.min - c.vThickness + OVERLAP_EPS;
}

// --- Strahl-Tests ------------------------------------------------------------

function setHit(out, origin, dir, t, nx, ny, nz) {
  out.distance = t;
  out.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
  out.normal.set(nx, ny, nz);
  out.collider = null;
  out.character = null;
  out.part = null;
  out.terrain = false;
}

function copyHit(out, src) {
  out.distance = src.distance;
  out.point.copy(src.point);
  out.normal.copy(src.normal);
  out.collider = null;
  out.character = null;
  out.part = null;
  out.terrain = false;
}

function rayCollider(c, origin, dir, maxDist, out) {
  if (c.type === 'box') return rayBox(origin, dir, c.min, c.max, maxDist, out);
  // schneller Vortest gegen den Umriss
  if (!rayHitsAabb(origin, dir, c.min, c.max, maxDist)) return false;
  let hit = false;
  let best = maxDist;
  for (let i = 0; i < c.parts.length; i++) {
    const part = c.parts[i];
    if (rayConvex(c.planes, part[0], part[1], origin, dir, best, out)) {
      best = out.distance;
      hit = true;
    }
  }
  return hit;
}

// Strahl gegen achsen-parallele Box ("Slab"-Methode). Startet der Strahl IN der
// Box, zählt das nicht als Treffer (er kommt dann ja aus ihr heraus).
function rayBox(origin, dir, min, max, maxDist, out) {
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = -1;
  let sign = 0;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
    const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
    const lo = a === 0 ? min.x : a === 1 ? min.y : min.z;
    const hi = a === 0 ? max.x : a === 1 ? max.y : max.z;
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tNear) {
      tNear = t1;
      axis = a;
      sign = s;
    }
    if (t2 < tFar) tFar = t2;
    if (tNear > tFar) return false;
  }
  if (tNear < 0 || tNear > maxDist || axis < 0) return false;
  setHit(out, origin, dir, tNear, axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
  return true;
}

function rayHitsAabb(origin, dir, min, max, maxDist) {
  let tNear = 0;
  let tFar = maxDist;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
    const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
    const lo = a === 0 ? min.x : a === 1 ? min.y : min.z;
    const hi = a === 0 ? max.x : a === 1 ? max.y : max.z;
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tNear) tNear = t1;
    if (t2 < tFar) tFar = t2;
    if (tNear > tFar) return false;
  }
  return true;
}

// Strahl gegen konvexen Körper aus Ebenen (n·p − d ≤ 0 = innen)
function rayConvex(planes, start, count, origin, dir, maxDist, out) {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let enter = -1;
  for (let i = 0; i < count; i++) {
    const p = (start + i) * 4;
    const nx = planes[p];
    const ny = planes[p + 1];
    const nz = planes[p + 2];
    const d = planes[p + 3];
    const denom = nx * dir.x + ny * dir.y + nz * dir.z;
    const dist = nx * origin.x + ny * origin.y + nz * origin.z - d;
    if (Math.abs(denom) < 1e-12) {
      if (dist > 0) return false;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      if (t > tEnter) {
        tEnter = t;
        enter = p;
      }
    } else if (t < tExit) {
      tExit = t;
    }
    if (tEnter > tExit) return false;
  }
  if (enter < 0 || tEnter < 0 || tEnter > maxDist) return false;
  const nx = planes[enter];
  const ny = planes[enter + 1];
  const nz = planes[enter + 2];
  const len = Math.hypot(nx, ny, nz) || 1;
  setHit(out, origin, dir, tEnter, nx / len, ny / len, nz / len);
  return true;
}

// Strahl gegen senkrechte Kapsel (Füße bei y, Höhe h, Radius r)
const _headCenter = { x: 0, y: 0, z: 0 };

/**
 * Mitte der Kopf-Kugel einer Figur (Welt). Oberkante = Kapsel-Oberkante; geduckt (Kapsel
 * kleiner) rückt der Kopf um bis zu crouchHeadForward in Blickrichtung (yaw) vor.
 */
export function headCenter(ch, hitbox, height = ch.height ?? hitbox.height, out = {}) {
  const r = hitbox.headRadius ?? 0;
  const range = hitbox.height - hitbox.crouchHeight;
  const crouch = range > 0 ? Math.max(0, Math.min(1, (hitbox.height - height) / range)) : 0;
  const forward = (hitbox.crouchHeadForward ?? 0) * crouch;
  const yaw = ch.yaw ?? 0;
  out.x = ch.position.x - Math.sin(yaw) * forward;
  out.y = ch.position.y + height - r;
  out.z = ch.position.z - Math.cos(yaw) * forward;
  return out;
}

// Strahl gegen eine Kugel (Start in der Kugel = Treffer bei 0)
function raySphere(origin, dir, cx, cy, cz, r, maxDist, out) {
  if (!(r > 0)) return false;
  const ox = origin.x - cx;
  const oy = origin.y - cy;
  const oz = origin.z - cz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  if (c <= 0) {
    setHit(out, origin, dir, 0, -dir.x, -dir.y, -dir.z);
    return true;
  }
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const disc = b * b - c;
  if (disc < 0) return false;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxDist) return false;
  setHit(out, origin, dir, t, (ox + dir.x * t) / r, (oy + dir.y * t) / r, (oz + dir.z * t) / r);
  return true;
}

function rayCapsule(origin, dir, x, y, z, r, h, maxDist, out) {
  const y0 = y + r; // Mitte der unteren Halbkugel
  const y1 = y + Math.max(r, h - r); // Mitte der oberen Halbkugel
  const ox = origin.x - x;
  const oz = origin.z - z;
  // Start IN der Kapsel (Figuren stehen ineinander, Schuss aus nächster Nähe):
  // sofort getroffen, an der Startstelle
  const cy = origin.y < y0 ? y0 : origin.y > y1 ? y1 : origin.y;
  const oyc = origin.y - cy;
  if (ox * ox + oyc * oyc + oz * oz <= r * r) {
    setHit(out, origin, dir, 0, -dir.x, -dir.y, -dir.z);
    return true;
  }
  let best = Infinity;
  let hx = 0;
  let hy = 0;
  let hz = 0;
  // Zylinder-Teil (nur waagerechte Richtung zählt)
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a > 1e-12) {
    const b = ox * dir.x + oz * dir.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const py = origin.y + dir.y * t;
      if (t >= 0 && t < best && py >= y0 && py <= y1) {
        best = t;
        hx = (ox + dir.x * t) / r;
        hy = 0;
        hz = (oz + dir.z * t) / r;
      }
    }
  }
  // die beiden Halbkugeln
  for (let k = 0; k < 2; k++) {
    const cy = k === 0 ? y0 : y1;
    const oy = origin.y - cy;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t < best) {
      const py = origin.y + dir.y * t;
      // nur der äußere Teil der Halbkugel (sonst liegt der Punkt im Zylinder)
      if ((k === 0 && py <= y0 + EPS) || (k === 1 && py >= y1 - EPS)) {
        best = t;
        hx = (ox + dir.x * t) / r;
        hy = (oy + dir.y * t) / r;
        hz = (oz + dir.z * t) / r;
      }
    }
  }
  if (best > maxDist || best === Infinity) return false;
  setHit(out, origin, dir, best, hx, hy, hz);
  return true;
}

// Schneidet den Strahl-Abschnitt [t0, t1] mit einer Box. Ergebnis in out { min, max } oder null.
function clipRayToBox(origin, dir, t0, t1, minX, minY, minZ, maxX, maxY, maxZ, out) {
  let tNear = t0;
  let tFar = t1;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
    const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
    const lo = a === 0 ? minX : a === 1 ? minY : minZ;
    const hi = a === 0 ? maxX : a === 1 ? maxY : maxZ;
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > tNear) tNear = ta;
    if (tb < tFar) tFar = tb;
    if (tNear > tFar) return null;
  }
  out.min = tNear;
  out.max = tFar;
  return out;
}
