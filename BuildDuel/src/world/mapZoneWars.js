// =============================================================================
// Zone-Wars-Karte: klein (160 x 160 m) und hügelig
// =============================================================================
// - Gelände mit Hügeln (Rauschen), am Rand steigen die Hügel an (dazu eine
//   unsichtbare Wand – niemand verlässt die Karte)
// - Felsen, Bäume und kleine Stein-Mauern als Deckung
// - spawnPoints(count): weit verteilte Startpunkte (nicht in Objekten)
// Gleiche Form wie die anderen Karten (mapBuilder + Gelände wie die Insel).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRng } from '../util/random.js';
import { createMapBuilder } from './mapBuilder.js';
import { createStaticBatch, createBatchTileTexture } from './staticBatch.js';
import { createPropSet } from './props.js';
import { addBarrierRing } from './mapArena.js';
import { findSpawnPoints } from './spawnPoints.js';
import {
  createNoise, createHeightfield, sampleHeights, limitSlopes, buildTerrainGeometry,
  createGroundDetailTexture, smoothstep,
} from './terrain.js';

/**
 * @param {object} game
 * @param {object} [spec] { seed, size }
 */
export function createZoneWarsMap(game, spec = {}) {
  const cfg = CONFIG.maps.zoneWars;
  const size = spec.size ?? CONFIG.modes.zoneWars.mapSize;
  const half = size / 2;
  const seed = spec.seed ?? cfg.seed;
  const rng = createRng(seed * 7919 + 3);
  const noise = createNoise(seed);
  const visual = !game.headless && typeof document !== 'undefined';
  const builder = createMapBuilder(game, 'Zone Wars');

  // --- Gelände ------------------------------------------------------------------------------
  const cell = CONFIG.maps.zoneWars.terrainCell;
  const extent = Math.ceil((half + 60) / cell) * cell;
  const rimStart = half - 12;
  const rimTop = cfg.rimHeight + cfg.hillHeight * 0.6;
  const heightFn = (x, z) => {
    const hills = cfg.hillHeight * (noise.fbm(x / cfg.hillScale, z / cfg.hillScale, 3) * 0.5 + 0.5);
    const s = Math.max(Math.abs(x), Math.abs(z));
    const rim = smoothstep(rimStart, half + 28, s);
    return hills * (1 - rim) + rimTop * rim;
  };
  const count = Math.round((2 * extent) / cell) + 1;
  const heights = sampleHeights(-extent, -extent, cell, count, count, heightFn);
  limitSlopes(heights, count, count, cell * Math.tan((cfg.maxSlopeDeg * Math.PI) / 180), 6);
  const terrain = createHeightfield({ minX: -extent, minZ: -extent, cell, countX: count, countZ: count, heights, outsideHeight: rimTop });
  game.world.setTerrain(terrain);
  const heightAt = (x, z) => terrain.heightAt(x, z);

  // --- Deckung, Felsen, Bäume -----------------------------------------------------------------
  const occupied = [];
  const free = (x, z, r) => occupied.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r);
  const inside = (x, z, m) => Math.abs(x) < half - m && Math.abs(z) < half - m;
  const tileTexture = visual ? createBatchTileTexture() : null;
  const batch = createStaticBatch(game, builder, { name: 'Deckung', texture: tileTexture });
  const coverColors = ['#B8BEC8', '#C9B79C', '#A9B4A0'];
  let covers = 0;
  for (let t = 0; t < 400 && covers < cfg.covers; t++) {
    const x = (rng() * 2 - 1) * (half - 14);
    const z = (rng() * 2 - 1) * (half - 14);
    if (!free(x, z, 4) || terrain.slopeAt(x, z) > 0.35) continue;
    const alongX = rng() < 0.5;
    const len = 4 + Math.floor(rng() * 2) * 2;
    const hgt = 1.4 + rng() * 0.8;
    const y = Math.min(heightAt(x - 2, z - 2), heightAt(x + 2, z + 2), heightAt(x, z)) - 0.4;
    const top = Math.max(heightAt(x - 2, z - 2), heightAt(x + 2, z + 2), heightAt(x, z)) + hgt;
    const hx = alongX ? len / 2 : 0.3;
    const hz = alongX ? 0.3 : len / 2;
    batch.addBox({ x: x - hx, y, z: z - hz }, { x: x + hx, y: top, z: z + hz }, { color: coverColors[covers % coverColors.length], data: { kind: 'static' } });
    occupied.push({ x, z, r: len / 2 + 1.5 });
    covers++;
  }
  const props = createPropSet(game, builder);
  let rocks = 0;
  for (let t = 0; t < 600 && rocks < cfg.rocks; t++) {
    const x = (rng() * 2 - 1) * (half - 8);
    const z = (rng() * 2 - 1) * (half - 8);
    if (!free(x, z, 2.5)) continue;
    const scale = 0.9 + rng() * 0.9;
    props.addRock(x, heightAt(x, z) - 0.15, z, { scale, yaw: rng() * 6.28, stretch: { x: 1.2 + rng() * 0.4, y: 0.75 + rng() * 0.35, z: 1 + rng() * 0.3 } });
    occupied.push({ x, z, r: 1.6 * scale });
    rocks++;
  }
  let trees = 0;
  for (let t = 0; t < 600 && trees < cfg.trees; t++) {
    const x = (rng() * 2 - 1) * (half - 6);
    const z = (rng() * 2 - 1) * (half - 6);
    if (!free(x, z, 2.2) || !inside(x, z, 4)) continue;
    props.addTree(x, heightAt(x, z), z, { kind: rng() < 0.5 ? 'pine' : 'round', scale: 0.85 + rng() * 0.45, yaw: rng() * 6.28, colorIndex: Math.floor(rng() * 4) });
    occupied.push({ x, z, r: 1.5 });
    trees++;
  }
  props.finish();
  batch.finish();

  // Unsichtbare Wand am Rand
  addBarrierRing(game, builder, half, 2, -20, cfg.barrierHeight, -20);

  // --- Grafik ---------------------------------------------------------------------------------
  if (visual) {
    const grass = new THREE.Color(CONFIG.visuals.colors.grass);
    const light = new THREE.Color('#7BD062');
    const dark = new THREE.Color('#4AA043');
    const dirt = new THREE.Color('#B7A06A');
    const colorFn = (x, z, h, out) => {
      const n = noise.noise(x / 11 + 9, z / 11 - 3);
      out.copy(grass).lerp(n > 0 ? light : dark, Math.abs(n) * 0.5);
      const s = Math.max(Math.abs(x), Math.abs(z));
      if (s > half) out.lerp(dark, 0.35);
      const slope = terrain.slopeAt(x, z);
      if (slope > 0.4) out.lerp(dirt, Math.min(0.7, (slope - 0.4) * 2));
    };
    const ground = new THREE.Mesh(
      buildTerrainGeometry(terrain, colorFn),
      new THREE.MeshLambertMaterial({ vertexColors: true, map: createGroundDetailTexture(CONFIG, game.renderer, 99) }),
    );
    ground.name = 'Gelände';
    ground.receiveShadow = true;
    builder.addObject(ground);
    // weite Wiese außen (Rand verschwindet im Nebel): 4 Streifen rund um das Gelände-Mesh,
    // genau auf der Rand-Höhe (in der Mitte kein Deckel über der Karte)
    const far = 2000;
    const strips = [
      [-far, -far, far, -extent], [-far, extent, far, far], [-far, -extent, -extent, extent], [extent, -extent, far, extent],
    ];
    const positions = [];
    for (const [x0, z0, x1, z1] of strips) {
      positions.push(x0, rimTop, z0, x0, rimTop, z1, x1, rimTop, z0, x0, rimTop, z1, x1, rimTop, z1, x1, rimTop, z0);
    }
    const outerGeo = new THREE.BufferGeometry();
    outerGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    outerGeo.computeVertexNormals();
    const outer = new THREE.Mesh(outerGeo, new THREE.MeshLambertMaterial({ color: dark.clone().lerp(grass, 0.5) }));
    outer.receiveShadow = true;
    outer.name = 'Wiese außen';
    builder.addObject(outer);
  }

  const map = {
    ...builder,
    id: 'zoneWars',
    size,
    center: { x: 0, z: 0 },
    terrain,
    props,
    heightAt,
    buildBounds: { minX: -half, maxX: half, minZ: -half, maxZ: half, maxLevel: cfg.maxBuildLevel },
    playBounds: { minX: -half + 1, maxX: half - 1, minZ: -half + 1, maxZ: half - 1 },
    contains(x, z, margin = 0) {
      return Math.abs(x) <= half - margin && Math.abs(z) <= half - margin;
    },
    isLand(x, z) {
      return map.contains(x, z, 4);
    },
    areaAt() {
      return null;
    },
    /** Weit verteilte Startpunkte (mit Blick zur Mitte). */
    spawnPoints(count, options = {}) {
      const points = findSpawnPoints(game, count, {
        rng: options.rng ?? game.rng,
        bounds: { minX: -half + 10, maxX: half - 10, minZ: -half + 10, maxZ: half - 10 },
        minDistance: options.minDistance ?? cfg.spawnMinDistance,
        ...options,
      });
      return points.map((p) => ({ ...p, yaw: Math.atan2(p.x, p.z) }));
    },
    dispose() {
      props.dispose();
      tileTexture?.dispose();
      builder.dispose();
      game.world.setTerrain(null);
    },
  };
  return map;
}
