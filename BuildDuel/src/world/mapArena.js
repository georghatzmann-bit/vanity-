// =============================================================================
// Arena-Karte (Übungsplatz und Duell 1v1)
// =============================================================================
// createArenaMap(game, spec) baut eine flache Arena:
//   - Gras-Boden mit feinem 4-m-Bauraster (reicht bis zum Horizont)
//   - eine niedrige Mauer rundherum (spec.size x spec.size Meter)
//   - darüber eine UNSICHTBARE hohe Wand (CONFIG.maps.arena.barrierHeight): Niemand
//     verlässt die Arena – auch nicht, indem er über eine Rampe über die Mauer läuft.
//     Schüsse fliegen hindurch (blocksBullets: false).
//   - Duell (spec.props: true): ein paar Felsen und Bäume (Spitzhacke: Stein/Holz),
//     punkt-symmetrisch verteilt (fair für beide Seiten), mit Platz um die Startpunkte.
// Die zurückgegebene Karte hat die Baukasten-Methoden aus mapBuilder.js
// (addBox, addSlope, addLabel, dispose), damit Modi weitere Dinge hineinsetzen
// können (Übungsplatz: Kisten, Rampen, Turm …).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRng } from '../util/random.js';
import { createMapBuilder } from './mapBuilder.js';
import { createPropSet } from './props.js';
import { findSpawnPoints } from './spawnPoints.js';

/**
 * @param {object} game
 * @param {object} [spec]  { size (m), borderHeight (m), borderThickness (m), borderColor,
 *                           buildBounds (Bau-Bereich, Standard = innerhalb der Mauer), maxBuildLevel,
 *                           props (Duell: Felsen + Bäume), seed, spawnDistance, barrier (Standard true) }
 * @returns {object} Karte (mit size, ground, addBox, addSlope, addLabel, dispose, spawnPoints …)
 */
export function createArenaMap(game, spec = {}) {
  const config = game.config ?? CONFIG;
  const arenaCfg = CONFIG.maps.arena;
  const size = spec.size ?? 80;
  const half = size / 2;
  const builder = createMapBuilder(game, 'Arena');
  let ground = null;
  let props = null;

  // Gelände: flach bei 0 (Standard der Kollisions-Welt)
  game.world.setTerrain(null);

  if (!game.headless && typeof document !== 'undefined') {
    ground = createGround(config, game.renderer);
    builder.addObject(ground);
  }

  // Rand-Mauer (4 Seiten)
  const h = spec.borderHeight ?? 3;
  const t = spec.borderThickness ?? 1;
  const color = spec.borderColor ?? '#9AA7B8';
  builder.addBox({ x: -half - t, y: 0, z: -half - t }, { x: half + t, y: h, z: -half }, { color });
  builder.addBox({ x: -half - t, y: 0, z: half }, { x: half + t, y: h, z: half + t }, { color });
  builder.addBox({ x: -half - t, y: 0, z: -half }, { x: -half, y: h, z: half }, { color });
  builder.addBox({ x: half, y: 0, z: -half }, { x: half + t, y: h, z: half }, { color });

  // Unsichtbare hohe Wand auf der Mauer (nur Kollision, Schüsse fliegen durch)
  if (spec.barrier !== false) addBarrierRing(game, builder, half, t, h, arenaCfg.barrierHeight);

  // Duell-Startpunkte: 40 m auseinander auf der Nord-Süd-Achse, Blick zueinander
  const spawnDistance = spec.spawnDistance ?? CONFIG.modes.duel.spawnDistance;
  const duelSpawns = [
    { x: 0, y: 0, z: spawnDistance / 2, yaw: 0 }, // schaut nach −Z (Norden)
    { x: 0, y: 0, z: -spawnDistance / 2, yaw: Math.PI }, // schaut nach +Z
  ];

  if (spec.props) {
    props = createPropSet(game, builder);
    placeDuelProps(props, half, duelSpawns, createRng((spec.seed ?? game.seed ?? 1) * 7919 + 13));
    props.finish();
  }

  const map = {
    ...builder,
    id: 'arena',
    size,
    ground,
    props,
    center: { x: 0, z: 0 },
    // Bauen nur innerhalb der Mauer (Wände direkt auf der Mauer-Linie gehen); Höhe: CONFIG.building.maxLevel
    buildBounds: spec.buildBounds ?? { minX: -half, maxX: half, minZ: -half, maxZ: half, maxLevel: spec.maxBuildLevel },
    /** Liegt der Punkt in der Arena (innerhalb der Mauer)? */
    contains(x, z, margin = 0) {
      return Math.abs(x) <= half - margin && Math.abs(z) <= half - margin;
    },
    /** Überall Land (für die Sturm-Zone). */
    isLand(x, z) {
      return map.contains(x, z);
    },
    /** Name der Gegend (für das HUD). */
    areaAt() {
      return null;
    },
    /**
     * Startpunkte: 2 Figuren → die festen Duell-Punkte (40 m auseinander, Blick zueinander),
     * mehr → zufällig verteilt (mit Abstand). Jeder Punkt hat yaw (Blick zur Mitte).
     */
    spawnPoints(count, options = {}) {
      if (count <= 2 && !options.random) return duelSpawns.slice(0, count).map((p) => ({ ...p }));
      const margin = arenaCfg.propEdgeMargin;
      const points = findSpawnPoints(game, count, {
        rng: options.rng ?? game.rng,
        bounds: { minX: -half + margin, maxX: half - margin, minZ: -half + margin, maxZ: half - margin },
        minDistance: options.minDistance ?? size / Math.max(2, Math.sqrt(count) + 1),
      });
      return points.map((p) => ({ ...p, yaw: Math.atan2(p.x, p.z) }));
    },
    dispose() {
      props?.dispose();
      builder.dispose();
    },
  };
  return map;
}

/**
 * Unsichtbare Wände auf einem Quadrat (halbe Kantenlänge half, Dicke t) von Höhe y0 bis y1.
 * Nur Kollision; Schüsse und Granaten fliegen hindurch.
 */
export function addBarrierRing(game, builder, half, t, y0, y1, minY = y0) {
  const data = { kind: 'barrier', blocksBullets: false };
  const add = (min, max) => builder.colliders.push(game.world.addBox(min, max, data));
  add({ x: -half - t, y: minY, z: -half - t }, { x: half + t, y: y1, z: -half });
  add({ x: -half - t, y: minY, z: half }, { x: half + t, y: y1, z: half + t });
  add({ x: -half - t, y: minY, z: -half }, { x: -half, y: y1, z: half });
  add({ x: half, y: minY, z: -half }, { x: half + t, y: y1, z: half });
}

// Felsen und Bäume für das Duell: auf einer Hälfte würfeln, auf die andere spiegeln
function placeDuelProps(props, half, spawns, rng) {
  const cfg = CONFIG.maps.arena;
  const margin = cfg.propEdgeMargin;
  const placed = [];
  const ok = (x, z) => {
    if (Math.abs(x) > half - margin || Math.abs(z) > half - margin) return false;
    for (const s of spawns) if (Math.hypot(s.x - x, s.z - z) < cfg.propSpawnClearance) return false;
    // nicht genau auf der Linie zwischen den Startpunkten (freie Sicht am Anfang)
    if (Math.abs(x) < 3) return false;
    for (const p of placed) if (Math.hypot(p.x - x, p.z - z) < cfg.propMinSpacing) return false;
    // gespiegelter Partner darf nicht zu nah sein
    if (Math.hypot(2 * x, 2 * z) < cfg.propMinSpacing) return false;
    return true;
  };
  const want = [
    ...Array(Math.ceil(cfg.duelTrees / 2)).fill('tree'),
    ...Array(Math.ceil(cfg.duelRocks / 2)).fill('rock'),
  ];
  for (const kind of want) {
    for (let tries = 0; tries < 200; tries++) {
      const x = (rng() * 2 - 1) * (half - margin);
      const z = (rng() * 2 - 1) * (half - margin);
      if (!ok(x, z)) continue;
      const scale = kind === 'tree' ? 0.9 + rng() * 0.35 : 0.9 + rng() * 0.6;
      const yaw = rng() * Math.PI * 2;
      const treeKind = rng() < 0.4 ? 'pine' : 'round';
      const colorIndex = Math.floor(rng() * 4);
      for (const sign of [1, -1]) {
        const px = x * sign;
        const pz = z * sign;
        placed.push({ x: px, z: pz });
        if (kind === 'tree') props.addTree(px, 0, pz, { scale, yaw, kind: treeKind, colorIndex });
        else props.addRock(px, 0, pz, { scale, yaw, stretch: { x: 1.3, y: 0.85, z: 1.05 } });
      }
      break;
    }
  }
}

/** Gras-Boden (nur Grafik). */
function createGround(config, renderer) {
  const size = config.world.groundSize;
  const cell = config.world.gridCellSize;
  const texture = createGrassTexture(config);
  // Eine Textur-Kachel = genau eine Bau-Zelle (4 x 4 m)
  texture.repeat.set(size / cell, size / cell);
  texture.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;

  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2); // flach hinlegen (Y zeigt nach oben)
  const material = new THREE.MeshLambertMaterial({ map: texture });
  const ground = new THREE.Mesh(geometry, material);
  ground.name = 'Boden';
  ground.receiveShadow = true;
  return ground;
}

/**
 * Malt eine kleine Gras-Kachel auf eine Leinwand (Canvas):
 * Grundfarbe, ein paar hellere/dunklere Flecken und eine feine Rasterlinie.
 */
export function createGrassTexture(config) {
  const px = 256;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');

  // Grundfarbe
  ctx.fillStyle = config.visuals.colors.grass;
  ctx.fillRect(0, 0, px, px);

  // Flecken – immer gleich dank festem Startwert
  const rng = createRng(1337);
  for (let i = 0; i < 260; i++) {
    const light = rng() < 0.5;
    ctx.fillStyle = light ? 'rgba(255, 255, 210, 0.07)' : 'rgba(20, 70, 20, 0.08)';
    const w = 2 + rng() * 10;
    const h = 2 + rng() * 10;
    ctx.fillRect(rng() * px, rng() * px, w, h);
  }

  // Feine Rasterlinie am oberen und linken Rand jeder Kachel → ergibt das 4-m-Raster
  if (config.visuals.groundGridLines) {
    ctx.fillStyle = `rgba(0, 40, 0, ${config.visuals.groundGridOpacity})`;
    ctx.fillRect(0, 0, px, 2);
    ctx.fillRect(0, 0, 2, px);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
