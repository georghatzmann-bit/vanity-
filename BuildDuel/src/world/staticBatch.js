// =============================================================================
// Feste Karten-Teile "in einem Stück" zeichnen (Häuser, Mauern, Möbel, Brücken)
// =============================================================================
// mapBuilder.addBox legt pro Kiste ein eigenes Mesh an – für hunderte Wände einer
// Stadt wären das hunderte Zeichen-Aufrufe ("draw calls") und das Spiel würde
// ruckeln. Dieser Baukasten sammelt stattdessen alle Kisten und Schrägen und
// macht daraus EIN Mesh (Farben stecken in den Ecken, "vertex colors").
// Die Kollision ist trotzdem pro Kiste da (game.world.addBox).
//
//   const batch = createStaticBatch(game, builder);
//   batch.addBox(min, max, { color, data, collide })
//   batch.addSlope(spec, { color, data })
//   batch.finish()   – einmal am Ende: baut das Mesh
//
// Die Collider landen in builder.colliders → builder.dispose() räumt alles ab.
// Ohne Bildschirm (headless) wird nur die Kollision angelegt.
// =============================================================================
import * as THREE from 'three';
import { createSlopeGeometry } from './mapBuilder.js';

const _color = new THREE.Color();

/**
 * @param {object} game
 * @param {object} builder  Karte aus createMapBuilder (root, colliders)
 * @param {object} [options] { name, castShadow, texture (Kachel-Bild, optional), selfLight (0..1, Eigenlicht) }
 */
export function createStaticBatch(game, builder, options = {}) {
  const visual = !game.headless && typeof document !== 'undefined';
  // gesammelte Ecken (nur mit Bildschirm)
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  let vertexCount = 0;
  let boxCount = 0;
  let finished = false;
  let mesh = null;

  function pushColor(color, count) {
    _color.set(color);
    for (let i = 0; i < count; i++) colors.push(_color.r, _color.g, _color.b);
  }

  // Eine Kiste als 6 Flächen (je 4 Ecken), Bild-Kacheln 1 x 1 m
  function pushBox(minX, minY, minZ, maxX, maxY, maxZ, color) {
    const faces = [
      // Normale, 4 Ecken (gegen den Uhrzeigersinn von außen), Kachel-Größe (u, v)
      [1, 0, 0, [[maxX, minY, maxZ], [maxX, minY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ]], 'zy'],
      [-1, 0, 0, [[minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, maxZ], [minX, maxY, minZ]], 'zy'],
      [0, 1, 0, [[minX, maxY, maxZ], [maxX, maxY, maxZ], [maxX, maxY, minZ], [minX, maxY, minZ]], 'xz'],
      [0, -1, 0, [[minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ]], 'xz'],
      [0, 0, 1, [[minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ]], 'xy'],
      [0, 0, -1, [[maxX, minY, minZ], [minX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ]], 'xy'],
    ];
    for (const [nx, ny, nz, corners, plane] of faces) {
      for (const [x, y, z] of corners) {
        positions.push(x, y, z);
        normals.push(nx, ny, nz);
        if (plane === 'zy') uvs.push(z, y);
        else if (plane === 'xz') uvs.push(x, z);
        else uvs.push(x, y);
      }
      indices.push(vertexCount, vertexCount + 1, vertexCount + 2, vertexCount, vertexCount + 2, vertexCount + 3);
      vertexCount += 4;
    }
    pushColor(color, 24);
  }

  function pushGeometry(geometry, color) {
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) indices.push(vertexCount + geometry.index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(vertexCount + i);
    }
    pushColor(color, pos.count);
    vertexCount += pos.count;
  }

  const batch = {
    /**
     * Kiste mit Kollision. options = { color, data, kind, collide (Standard true), visible (Standard true) }
     * @returns {object|null} collider
     */
    addBox(min, max, opts = {}) {
      if (finished) throw new Error('staticBatch: schon fertig (finish)');
      let collider = null;
      if (opts.collide !== false) {
        collider = game.world.addBox(min, max, opts.data ?? { kind: opts.kind ?? 'static' });
        builder.colliders.push(collider);
      }
      if (visual && opts.visible !== false) {
        pushBox(
          Math.min(min.x, max.x), Math.min(min.y, max.y), Math.min(min.z, max.z),
          Math.max(min.x, max.x), Math.max(min.y, max.y), Math.max(min.z, max.z),
          opts.color ?? '#C9D3E0',
        );
      }
      boxCount++;
      return collider;
    },

    /** Schräge (Rampe, Dach) mit Kollision. spec wie world.addSlope. */
    addSlope(spec, opts = {}) {
      if (finished) throw new Error('staticBatch: schon fertig (finish)');
      const collider = game.world.addSlope(spec, opts.data ?? { kind: opts.kind ?? 'static' });
      builder.colliders.push(collider);
      if (visual && opts.visible !== false) {
        const geometry = createSlopeGeometry(collider);
        pushGeometry(geometry, opts.color ?? '#D9A066');
        geometry.dispose();
      }
      return collider;
    },

    /** Nur Grafik (ohne Kollision): eine fertige Form in Welt-Koordinaten. */
    addGeometry(geometry, color) {
      if (visual) pushGeometry(geometry, color);
    },

    /** Baut das Mesh (einmal am Ende). */
    finish() {
      if (finished) return mesh;
      finished = true;
      if (!visual || vertexCount === 0) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(vertexCount > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
      geometry.computeBoundingSphere();
      const material = new THREE.MeshLambertMaterial({ vertexColors: true, map: options.texture ?? null });
      // "Eigenlicht": ein Teil der eigenen Farbe leuchtet immer – wie weiches Streulicht. So
      // wirken Innenräume und Schattenseiten warm und hell statt grau-bläulich (Comic-Look).
      const selfLight = options.selfLight ?? 0.22;
      if (selfLight > 0) {
        material.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * ${selfLight.toFixed(3)};`,
          );
        };
        material.customProgramCacheKey = () => `staticBatchSelfLight${selfLight}`;
      }
      mesh = new THREE.Mesh(geometry, material);
      mesh.name = options.name ?? 'Karten-Teile';
      mesh.castShadow = options.castShadow ?? true;
      mesh.receiveShadow = true;
      builder.root.add(mesh);
      // Speicher freigeben
      positions.length = 0;
      normals.length = 0;
      uvs.length = 0;
      colors.length = 0;
      indices.length = 0;
      return mesh;
    },

    get boxCount() {
      return boxCount;
    },
    get mesh() {
      return mesh;
    },
  };
  return batch;
}

/**
 * Helle Kachel mit feinem Rand (1 x 1 m), wird mit der Ecken-Farbe eingefärbt –
 * so sieht man an Häusern und Mauern, wie groß sie sind.
 */
export function createBatchTileTexture() {
  const px = 64;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
  ctx.fillRect(px / 2, 0, px / 2, px / 2);
  ctx.fillRect(0, px / 2, px / 2, px / 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.fillRect(0, 0, px, 2);
  ctx.fillRect(0, 0, 2, px);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}
