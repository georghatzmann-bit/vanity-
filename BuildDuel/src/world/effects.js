// =============================================================================
// Partikel-Effekte: Splitter, Staub, Funken, Trümmer, Material-Späne, Schild-Scherben
// =============================================================================
// Hört auf Ereignisse des Spiels und malt kleine Teilchen:
//   'hit' an Bauteilen       → Splitter in Material-Farbe
//   'pieceDestroyed'         → Trümmer + Staub-Wolke (auch beim Einsturz)
//   'impact'                 → Funken (Gelände, Objekte, Bauteile) + etwas Staub am Boden
//   'explosion'              → Trümmer, Rauch, Glut (der Feuerball kommt von den Waffen)
//   'harvest'                → Späne (Holz/Stein/Metall) beim Sammeln mit der Spitzhacke
//   'shieldBroken'           → blaue Scherben
//   'land' (harter Sturz)    → Staub-Ring an den Füßen
//   'footstep' beim Sprinten → kleiner Staub
//
// Leistung: drei feste Vorräte ("Pools") – nichts wird beim Spielen neu angelegt:
//   Staub  = Punkte mit weichem Rand (normale Mischung)
//   Glühen = Punkte, die leuchten (additiv): Funken, Glut, Scherben-Glitzern
//   Stücke = InstancedMesh aus kleinen Klötzchen (beleuchtet): Splitter, Trümmer, Späne
// Ist ein Vorrat voll, wird das älteste Teilchen wiederverwendet. Bei Grafik "niedrig"
// gibt es weniger Teilchen (CONFIG.effects.qualityFactor). Ohne Bildschirm: Attrappe.
// Werte: CONFIG.effects.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { resolveGraphics } from '../core/settings.js';

const E = CONFIG.effects;
const COLORS = CONFIG.visuals.colors;
const S = CONFIG.world.gridCellSize;
const H = CONFIG.world.wallHeight;

// =============================================================================
// Vorrat an Teilchen (reine Zahlen in festen Feldern – ohne Bildschirm testbar)
// =============================================================================
export class ParticlePool {
  constructor(capacity) {
    const n = Math.max(1, capacity | 0);
    this.capacity = n;
    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.size = f(); this.grow = f();
    this.r = f(); this.g = f(); this.b = f(); this.alpha = f();
    this.gravity = f(); this.drag = f(); this.floor = f();
    this.rx = f(); this.ry = f(); this.rz = f();
    this.sx = f(); this.sy = f(); this.sz = f();
    this.alive = new Uint8Array(n);
    this.next = 0;
    this.active = 0;
  }

  /** Neues Teilchen → Index. Voll? Dann wird das nächste (älteste) überschrieben. */
  spawn(x, y, z, vx, vy, vz, life, size) {
    const i = this.next;
    this.next = (i + 1) % this.capacity;
    if (!this.alive[i]) this.active++;
    this.alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, life);
    this.size[i] = size;
    this.grow[i] = 0;
    this.r[i] = 1; this.g[i] = 1; this.b[i] = 1; this.alpha[i] = 1;
    this.gravity[i] = 0; this.drag[i] = 0; this.floor[i] = -Infinity;
    this.rx[i] = 0; this.ry[i] = 0; this.rz[i] = 0;
    this.sx[i] = 0; this.sy[i] = 0; this.sz[i] = 0;
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.active--;
  }

  /** Alle Teilchen bewegen (Schwerkraft, Luftwiderstand, Boden). @returns {number} lebende */
  update(dt) {
    if (this.active === 0) return 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        this.kill(i);
        continue;
      }
      this.age[i] = age;
      this.vy[i] -= this.gravity[i] * dt;
      const keep = this.drag[i] > 0 ? Math.max(0, 1 - this.drag[i] * dt) : 1;
      this.vx[i] *= keep;
      this.vy[i] *= keep;
      this.vz[i] *= keep;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < this.floor[i]) {
        // aufprallen: etwas hüpfen, über den Boden rutschen, Drehung bremsen
        this.py[i] = this.floor[i];
        this.vy[i] = this.vy[i] < -1 ? -this.vy[i] * 0.3 : 0;
        this.vx[i] *= 0.55;
        this.vz[i] *= 0.55;
        this.sx[i] *= 0.5;
        this.sy[i] *= 0.5;
        this.sz[i] *= 0.5;
      }
      this.rx[i] += this.sx[i] * dt;
      this.ry[i] += this.sy[i] * dt;
      this.rz[i] += this.sz[i] * dt;
    }
    return this.active;
  }

  clear() {
    this.alive.fill(0);
    this.active = 0;
  }
}

/** Halbe Ausdehnung eines Bauteils je Art (für Trümmer über die ganze Fläche). */
export function pieceExtents(kind, out = { x: 0, y: 0, z: 0 }) {
  const t = CONFIG.building.pieceThickness / 2;
  out.x = S / 2;
  out.y = H / 2;
  out.z = S / 2;
  if (kind === 'wx') out.z = t;
  else if (kind === 'wz') out.x = t;
  else if (kind === 'f') out.y = t;
  else if (kind === 'c') out.y = CONFIG.building.roofHeight / 2;
  return out;
}

/** Wie viele Teilchen bei einer Grafik-Stufe ('niedrig' | 'mittel' | 'hoch'). */
export function qualityFactorOf(name) {
  return E.qualityFactor[name] ?? 1;
}

/** Anzahl Teilchen für einen Effekt (mindestens 1, wenn base > 0). */
export function scaledCount(base, factor) {
  if (!(base > 0)) return 0;
  return Math.max(1, Math.round(base * factor));
}

// =============================================================================
// Attrappe (ohne Bildschirm)
// =============================================================================
function createHeadlessEffects(game) {
  return {
    game,
    frameUpdate() {},
    spawn() {},
    setPaused() {},
    clear() {},
    stats() {
      return { dust: 0, glow: 0, chunks: 0, capacity: { dust: 0, glow: 0, chunks: 0 } };
    },
    dispose() {},
  };
}

// =============================================================================
// Grafik
// =============================================================================
const POINT_VERTEX = /* glsl */ `
  attribute vec4 aColor;
  attribute float aSize;
  uniform float uScale;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize > 0.0 ? min(256.0, aSize * uScale / max(0.1, -mv.z)) : 0.0;
    if (aSize <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const POINT_FRAGMENT = /* glsl */ `
  uniform float uSoft;
  varying vec4 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float a = vColor.a * (1.0 - smoothstep(uSoft, 1.0, d));
    gl_FragColor = vec4(vColor.rgb, a);
    #include <colorspace_fragment>
  }
`;

function createPointLayer(pool, additive, soft, name) {
  const n = pool.capacity;
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const color = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
  const size = new THREE.BufferAttribute(new Float32Array(n), 1);
  position.setUsage(THREE.DynamicDrawUsage);
  color.setUsage(THREE.DynamicDrawUsage);
  size.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aSize', size);
  const material = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 }, uSoft: { value: soft } },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = name;
  points.frustumCulled = false;
  points.renderOrder = additive ? 22 : 21;
  let wasActive = false;
  return {
    object: points,
    material,
    update() {
      if (pool.active === 0 && !wasActive) return;
      wasActive = pool.active > 0;
      const p = position.array;
      const c = color.array;
      const s = size.array;
      for (let i = 0; i < n; i++) {
        if (!pool.alive[i]) {
          s[i] = 0;
          continue;
        }
        const t = pool.age[i] / pool.life[i];
        p[i * 3] = pool.px[i];
        p[i * 3 + 1] = pool.py[i];
        p[i * 3 + 2] = pool.pz[i];
        c[i * 4] = pool.r[i];
        c[i * 4 + 1] = pool.g[i];
        c[i * 4 + 2] = pool.b[i];
        // schnell einblenden, langsam ausblenden
        c[i * 4 + 3] = pool.alpha[i] * Math.min(1, t * 8) * (1 - t) * (1 - t);
        s[i] = pool.size[i] * (1 + pool.grow[i] * t);
      }
      position.needsUpdate = true;
      color.needsUpdate = true;
      size.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createChunkLayer(pool) {
  const n = pool.capacity;
  const geometry = new THREE.BoxGeometry(1, 0.42, 0.7);
  const material = new THREE.MeshLambertMaterial({ color: '#FFFFFF' });
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  mesh.name = 'Splitter';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < n; i++) {
    mesh.setMatrixAt(i, zero);
    mesh.setColorAt(i, white);
  }
  const shown = new Uint8Array(n);
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const col = new THREE.Color();
  let colorsDirty = false;
  let wasActive = false;
  return {
    object: mesh,
    /** Farbe eines neuen Stücks setzen (sofort, nicht pro Bild). */
    setColor(i, r, g, b) {
      col.setRGB(r, g, b);
      mesh.setColorAt(i, col);
      colorsDirty = true;
    },
    update() {
      if (colorsDirty) {
        mesh.instanceColor.needsUpdate = true;
        colorsDirty = false;
      }
      if (pool.active === 0 && !wasActive) return;
      wasActive = pool.active > 0;
      for (let i = 0; i < n; i++) {
        if (!pool.alive[i]) {
          if (shown[i]) {
            shown[i] = 0;
            mesh.setMatrixAt(i, zero);
          }
          continue;
        }
        shown[i] = 1;
        const t = pool.age[i] / pool.life[i];
        const sz = pool.size[i] * (t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1);
        pos.set(pool.px[i], pool.py[i], pool.pz[i]);
        quat.setFromEuler(euler.set(pool.rx[i], pool.ry[i], pool.rz[i]));
        scale.set(sz, sz, sz);
        m.compose(pos, quat, scale);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

/**
 * @param {object} game
 */
export function createEffects(game) {
  if (game.headless || !game.root) return createHeadlessEffects(game);
  const quality = resolveGraphics(game.settings);
  const q = qualityFactorOf(quality.name);
  const poolSize = (base) => Math.max(24, Math.round(base * q));
  const dust = new ParticlePool(poolSize(E.pools.dust));
  const glow = new ParticlePool(poolSize(E.pools.glow));
  const chunks = new ParticlePool(poolSize(E.pools.chunks));

  const root = new THREE.Group();
  root.name = 'Partikel';
  game.root.add(root);
  const dustLayer = createPointLayer(dust, false, 0.25, 'Staub');
  const glowLayer = createPointLayer(glow, true, 0.15, 'Funken');
  const chunkLayer = createChunkLayer(chunks);
  root.add(dustLayer.object, glowLayer.object, chunkLayer.object);

  const tmpColor = new THREE.Color();
  const center = new THREE.Vector3();
  const ext = { x: 0, y: 0, z: 0 };
  const rng = Math.random;
  let paused = false;
  let disposed = false;

  const materialColor = {
    wood: new THREE.Color(COLORS.wood),
    stone: new THREE.Color(COLORS.stone),
    metal: new THREE.Color(COLORS.metal),
  };
  const sparkColor = new THREE.Color(E.sparks.color);
  const dustColor = new THREE.Color(E.dust.color);
  const groundDust = new THREE.Color('#B9A57E');
  const debrisColor = new THREE.Color(E.explosion.debrisColor);
  const smokeColor = new THREE.Color(E.explosion.smokeColor);
  const emberColor = new THREE.Color(E.explosion.emberColor);
  const shardColor = new THREE.Color(E.shieldShards.color);

  function groundAt(x, z) {
    const t = game.world?.terrain;
    const hgt = t && typeof t.heightAt === 'function' ? t.heightAt(x, z) : 0;
    return Number.isFinite(hgt) ? hgt : 0;
  }

  // --- Bausteine ----------------------------------------------------------------------
  function chunk(x, y, z, vx, vy, vz, life, size, color, floorY, shade = 0.15) {
    const i = chunks.spawn(x, y, z, vx, vy, vz, life, size);
    chunks.gravity[i] = E.gravity;
    chunks.drag[i] = 0.4;
    chunks.floor[i] = floorY + size * 0.2;
    chunks.rx[i] = rng() * 6.28;
    chunks.ry[i] = rng() * 6.28;
    chunks.rz[i] = rng() * 6.28;
    chunks.sx[i] = (rng() - 0.5) * 18;
    chunks.sy[i] = (rng() - 0.5) * 18;
    chunks.sz[i] = (rng() - 0.5) * 18;
    const k = 1 - shade + rng() * shade * 2;
    chunkLayer.setColor(i, color.r * k, color.g * k, color.b * k);
    return i;
  }

  function puff(x, y, z, vx, vy, vz, life, size, color, alpha, grow) {
    const i = dust.spawn(x, y, z, vx, vy, vz, life, size);
    dust.r[i] = color.r;
    dust.g[i] = color.g;
    dust.b[i] = color.b;
    dust.alpha[i] = alpha;
    dust.grow[i] = grow;
    dust.drag[i] = 2.2;
    dust.gravity[i] = -0.4; // steigt ganz leicht
    return i;
  }

  function spark(x, y, z, vx, vy, vz, life, size, color, gravity = 9) {
    const i = glow.spawn(x, y, z, vx, vy, vz, life, size);
    glow.r[i] = color.r;
    glow.g[i] = color.g;
    glow.b[i] = color.b;
    glow.alpha[i] = 1;
    glow.gravity[i] = gravity;
    glow.drag[i] = 1.5;
    return i;
  }

  // zufällige Richtung um eine Normale (n), Stärke speed
  function burst(nx, ny, nz, spread, speed, out) {
    let x = nx + (rng() * 2 - 1) * spread;
    let y = ny + (rng() * 2 - 1) * spread;
    let z = nz + (rng() * 2 - 1) * spread;
    const len = Math.hypot(x, y, z) || 1;
    const s = speed * (0.45 + rng() * 0.55);
    x = (x / len) * s;
    y = (y / len) * s;
    z = (z / len) * s;
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  const dir = { x: 0, y: 0, z: 0 };

  // --- Effekte --------------------------------------------------------------------------
  function sparksAt(p, n, count, color = sparkColor) {
    for (let k = 0; k < count; k++) {
      burst(n?.x ?? 0, n?.y ?? 1, n?.z ?? 0, 0.9, E.sparks.speed, dir);
      spark(p.x, p.y, p.z, dir.x, dir.y + 1, dir.z, E.sparks.life * (0.6 + rng() * 0.8), E.sparks.size, color);
    }
  }

  function splintersAt(p, n, material, count, speed = 4) {
    const color = materialColor[material] ?? materialColor.wood;
    const floorY = groundAt(p.x, p.z);
    for (let k = 0; k < count; k++) {
      burst(n?.x ?? 0, (n?.y ?? 0) + 0.4, n?.z ?? 0, 0.8, speed, dir);
      chunk(p.x, p.y, p.z, dir.x, dir.y + 1.2, dir.z, E.splinters.life * (0.6 + rng() * 0.6),
        E.splinters.size * (0.6 + rng() * 0.8), color, floorY);
    }
  }

  function dustAt(x, y, z, count, size, life, color = dustColor, alpha = 0.5, spread = 1.2) {
    for (let k = 0; k < count; k++) {
      const a = rng() * Math.PI * 2;
      const s = spread * (0.4 + rng() * 0.6);
      puff(x + Math.cos(a) * 0.2, y, z + Math.sin(a) * 0.2, Math.cos(a) * s, 0.3 + rng() * 0.5, Math.sin(a) * s,
        life * (0.7 + rng() * 0.5), size * (0.7 + rng() * 0.6), color, alpha, 1.4);
    }
  }

  function pieceBurst(piece, collapsed) {
    if (!game.building?.pieceCenter) return;
    game.building.pieceCenter(piece, center);
    pieceExtents(piece.kind, ext);
    const color = materialColor[piece.material] ?? materialColor.wood;
    const count = scaledCount(E.splinters.perDestroy * (collapsed ? 0.5 : 1), q);
    const floorY = groundAt(center.x, center.z);
    for (let k = 0; k < count; k++) {
      const x = center.x + (rng() * 2 - 1) * ext.x;
      const y = center.y + (rng() * 2 - 1) * ext.y;
      const z = center.z + (rng() * 2 - 1) * ext.z;
      chunk(x, y, z, (rng() - 0.5) * 4, 1 + rng() * 3, (rng() - 0.5) * 4, 0.9 + rng() * 0.6,
        E.splinters.size * (1 + rng() * 1.4), color, floorY);
    }
    const puffs = scaledCount(E.dust.count * (collapsed ? 0.7 : 1), q);
    for (let k = 0; k < puffs; k++) {
      const x = center.x + (rng() * 2 - 1) * ext.x * 0.8;
      const y = center.y + (rng() * 2 - 1) * ext.y * 0.8;
      const z = center.z + (rng() * 2 - 1) * ext.z * 0.8;
      puff(x, y, z, (rng() - 0.5) * 1.5, 0.2 + rng() * 0.6, (rng() - 0.5) * 1.5, E.dust.life * (0.8 + rng() * 0.6),
        E.dust.size * (0.8 + rng() * 0.8), dustColor, 0.55, 1.6);
    }
  }

  function explosionAt(p, radius = 4) {
    const floorY = groundAt(p.x, p.z);
    const X = E.explosion;
    const s = Math.max(0.5, radius / 4);
    for (let k = 0, n = scaledCount(X.debris, q); k < n; k++) {
      burst(0, 1, 0, 1.2, 9 * s, dir);
      chunk(p.x, p.y + 0.2, p.z, dir.x, Math.abs(dir.y) + 2, dir.z, 1 + rng() * 0.6, 0.12 + rng() * 0.16, debrisColor, floorY, 0.3);
    }
    for (let k = 0, n = scaledCount(X.smoke, q); k < n; k++) {
      const a = rng() * Math.PI * 2;
      const r = rng() * radius * 0.5;
      puff(p.x + Math.cos(a) * r, p.y + rng() * 1.2, p.z + Math.sin(a) * r, Math.cos(a) * 1.5, 0.8 + rng(), Math.sin(a) * 1.5,
        1.4 + rng() * 0.8, (1.4 + rng() * 1.2) * s, smokeColor, 0.55, 1.8);
    }
    for (let k = 0, n = scaledCount(X.embers, q); k < n; k++) {
      burst(0, 1, 0, 1.1, 10 * s, dir);
      spark(p.x, p.y + 0.3, p.z, dir.x, Math.abs(dir.y) + 1, dir.z, 0.5 + rng() * 0.6, 0.12, emberColor, 12);
    }
  }

  function shardsAt(c) {
    const x = c.position.x;
    const y = c.position.y + (c.height ?? 1.8) * 0.6;
    const z = c.position.z;
    const floorY = c.position.y;
    const n = scaledCount(E.shieldShards.count, q);
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const vx = Math.cos(a) * (2 + rng() * 3);
      const vz = Math.sin(a) * (2 + rng() * 3);
      if (k % 2 === 0) chunk(x + Math.cos(a) * 0.4, y + (rng() - 0.5) * 0.6, z + Math.sin(a) * 0.4, vx, 1 + rng() * 2, vz, 0.7 + rng() * 0.4, 0.07 + rng() * 0.06, shardColor, floorY, 0.1);
      else spark(x + Math.cos(a) * 0.4, y + (rng() - 0.5) * 0.6, z + Math.sin(a) * 0.4, vx, 1 + rng() * 2, vz, 0.45 + rng() * 0.3, 0.1, shardColor, 6);
    }
  }

  function nearCamera(p, limit) {
    const cam = game.camera;
    if (!cam) return true;
    const dx = p.x - cam.position.x;
    const dy = p.y - cam.position.y;
    const dz = p.z - cam.position.z;
    return dx * dx + dy * dy + dz * dz < limit * limit;
  }

  // --- Ereignisse ------------------------------------------------------------------------
  const offs = [];
  const on = (name, fn) => offs.push(game.events.on(name, fn));

  on('impact', (e) => {
    if (e.kind === 'character' || !nearCamera(e.point, 120)) return;
    const pellets = e.weaponId === 'shotgun' ? 3 : 1;
    if (e.kind === 'terrain') {
      if (rng() < 0.6 / pellets) dustAt(e.point.x, e.point.y, e.point.z, 1, 0.45, 0.6, groundDust, 0.55, 0.6);
      sparksAt(e.point, e.normal, Math.max(1, Math.round(scaledCount(E.sparks.count, q) / (2 * pellets))));
    } else if (e.weaponId !== 'pickaxe') {
      sparksAt(e.point, e.normal, Math.max(1, Math.round(scaledCount(E.sparks.count, q) / pellets)));
    } else if (e.kind === 'static') {
      dustAt(e.point.x, e.point.y, e.point.z, 2, 0.4, 0.5, dustColor, 0.45, 0.6);
    }
  });

  on('hit', (e) => {
    if (e.kind !== 'piece' || !e.target || !nearCamera(e.point, 120)) return;
    const n = scaledCount(E.splinters.perHit * Math.min(2, Math.max(0.5, (e.nominal ?? 25) / 25)), q);
    splintersAt(e.point, null, e.target.material, n);
  });

  on('pieceDestroyed', (e) => {
    if (e.piece) pieceBurst(e.piece, !!e.collapsed);
  });

  on('explosion', (e) => explosionAt(e.position, e.radius));

  on('harvest', (e) => {
    if (!e.point) return;
    const n = scaledCount(E.harvest.chips, q);
    splintersAt(e.point, null, e.material, n, 3);
    if (e.material === 'metal') sparksAt(e.point, null, Math.max(1, Math.round(n / 2)));
  });

  on('shieldBroken', (e) => {
    if (e.character) shardsAt(e.character);
  });

  on('land', (e) => {
    const c = e.character;
    if (!c || (e.fallHeight ?? 0) < E.hardLanding || !nearCamera(c.position, 60)) return;
    const n = scaledCount(8, q);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng() * 0.3;
      puff(c.position.x + Math.cos(a) * 0.3, c.position.y + 0.05, c.position.z + Math.sin(a) * 0.3,
        Math.cos(a) * 2.6, 0.2 + rng() * 0.3, Math.sin(a) * 2.6, 0.7 + rng() * 0.3, 0.7 + rng() * 0.4, dustColor, 0.5, 1.5);
    }
  });

  on('footstep', (e) => {
    const c = e.character;
    if (!c || !c.grounded) return;
    const fast = c.sprinting || Math.hypot(c.velocity.x, c.velocity.z) > CONFIG.player.walkSpeed * 1.08;
    if (!fast || !nearCamera(c.position, 40)) return;
    const n = q < 0.5 ? 1 : 2;
    for (let k = 0; k < n; k++) {
      puff(c.position.x + (rng() - 0.5) * 0.4, c.position.y + 0.05, c.position.z + (rng() - 0.5) * 0.4,
        -c.velocity.x * 0.1, 0.3, -c.velocity.z * 0.1, E.footDust.life, E.footDust.size, groundDust, 0.4, 1.2);
    }
  });

  return {
    game,

    /** Pro Bild: Teilchen bewegen und malen. dt = echte Bild-Zeit (s). */
    frameUpdate(dt = 0) {
      if (disposed) return;
      const step = paused ? 0 : Math.min(0.1, Math.max(0, dt || 0));
      dust.update(step);
      glow.update(step);
      chunks.update(step);
      // Punkt-Größe passend zu Sichtfeld und Bild-Höhe (Teilchen-Größe in Metern)
      const cam = game.camera;
      const height = game.renderer?.domElement?.height || 720;
      const scale = cam ? height / (2 * Math.tan((cam.fov * Math.PI) / 360)) : 400;
      dustLayer.material.uniforms.uScale.value = scale;
      glowLayer.material.uniforms.uScale.value = scale;
      dustLayer.update();
      glowLayer.update();
      chunkLayer.update();
    },

    /**
     * Effekt von außen auslösen (Modi, Tests): kind 'sparks' | 'splinters' | 'dust' | 'explosion' | 'shards'.
     * position = {x,y,z}, options = { material, count, normal, character }
     */
    spawn(kind, position, options = {}) {
      if (disposed || !position) return;
      if (kind === 'sparks') sparksAt(position, options.normal ?? null, options.count ?? scaledCount(E.sparks.count, q));
      else if (kind === 'splinters') splintersAt(position, options.normal ?? null, options.material ?? 'wood', options.count ?? scaledCount(E.splinters.perHit, q));
      else if (kind === 'dust') dustAt(position.x, position.y, position.z, options.count ?? scaledCount(E.dust.count, q), E.dust.size, E.dust.life);
      else if (kind === 'explosion') explosionAt(position, options.radius ?? 4);
      else if (kind === 'shards' && options.character) shardsAt(options.character);
    },

    /** Teilchen anhalten (Screenshots in Tests). */
    setPaused(on) {
      paused = !!on;
    },

    /** Alle Teilchen sofort weg. */
    clear() {
      dust.clear();
      glow.clear();
      chunks.clear();
      dustLayer.update();
      glowLayer.update();
      chunkLayer.update();
    },

    /** Für Tests: lebende Teilchen und Vorrats-Größen. */
    stats() {
      return {
        dust: dust.active,
        glow: glow.active,
        chunks: chunks.active,
        capacity: { dust: dust.capacity, glow: glow.capacity, chunks: chunks.capacity },
        quality: quality.name,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      offs.length = 0;
      root.parent?.remove(root);
      dustLayer.dispose();
      glowLayer.dispose();
      chunkLayer.dispose();
    },
  };
}
