// =============================================================================
// Arena-Karte
// =============================================================================
// Phase 1: nur der Boden (Gras mit feinem 4-m-Bauraster).
// Phase 8: kommt die Duell-Arena dazu (80 x 80 m, Felsen, Bäume).
// =============================================================================
import * as THREE from 'three';
import { createRng } from '../util/random.js';

/**
 * Legt den Boden in die Szene.
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer  (für die Textur-Schärfe)
 * @param {object} config  CONFIG aus config.js
 * @returns {{ ground: THREE.Mesh }}
 */
export function createArena(scene, renderer, config) {
  const size = config.world.groundSize;
  const cell = config.world.gridCellSize;

  const texture = createGrassTexture(config);
  // Eine Textur-Kachel = genau eine Bau-Zelle (4 x 4 m)
  texture.repeat.set(size / cell, size / cell);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2); // flach hinlegen (Y zeigt nach oben)

  const material = new THREE.MeshLambertMaterial({ map: texture });
  const ground = new THREE.Mesh(geometry, material);
  ground.name = 'Boden';
  ground.receiveShadow = true;
  scene.add(ground);

  return { ground };
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
