// =============================================================================
// Arena-Karte
// =============================================================================
// createArenaMap(game, spec) baut eine flache Arena:
//   - Gras-Boden mit feinem 4-m-Bauraster (reicht bis zum Horizont)
//   - eine niedrige Mauer rundherum (spec.size x spec.size Meter)
// Die zurückgegebene Karte hat die Baukasten-Methoden aus mapBuilder.js
// (addBox, addSlope, addLabel, dispose), damit Modi weitere Dinge hineinsetzen
// können (Übungsplatz: Kisten, Rampen, Turm …).
//
// Phase 8 (Duell): kommen Felsen und Bäume dazu.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRng } from '../util/random.js';
import { createMapBuilder } from './mapBuilder.js';

/**
 * @param {object} game
 * @param {object} [spec]  { size (m), borderHeight (m), borderThickness (m), borderColor,
 *                           buildBounds (Bau-Bereich, Standard = innerhalb der Mauer), maxBuildLevel }
 * @returns {object} Karte (mit size, ground, addBox, addSlope, addLabel, dispose …)
 */
export function createArenaMap(game, spec = {}) {
  const config = game.config ?? CONFIG;
  const size = spec.size ?? 80;
  const half = size / 2;
  const builder = createMapBuilder(game, 'Arena');
  let ground = null;

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

  return {
    ...builder,
    id: 'arena',
    size,
    ground,
    // Bauen nur innerhalb der Mauer (Wände direkt auf der Mauer-Linie gehen); Höhe: CONFIG.building.maxLevel
    buildBounds: spec.buildBounds ?? { minX: -half, maxX: half, minZ: -half, maxZ: half, maxLevel: spec.maxBuildLevel },
    /** Liegt der Punkt in der Arena (innerhalb der Mauer)? */
    contains(x, z, margin = 0) {
      return Math.abs(x) <= half - margin && Math.abs(z) <= half - margin;
    },
  };
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
function createGrassTexture(config) {
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
