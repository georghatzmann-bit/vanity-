// =============================================================================
// Karten-Baukasten: feste Hindernisse mit Kollision UND Grafik
// =============================================================================
// Jede Karte (Arena, Übungsplatz, später Insel) benutzt diese Helfer:
//   addBox(min, max, options)   – Kiste/Wand/Plattform
//   addSlope(spec, options)     – Rampe oder Pyramiden-Dach (spec wie world.addSlope)
//   addLabel(text, position)    – Schild mit Text (nur Grafik); weit weg wird es
//                                 größer, damit man es noch lesen kann
//   frameUpdate()               – jedes Bild (Schilder an den Abstand anpassen)
//   dispose()                   – alles wieder entfernen (Kollision + Grafik)
//
// Ohne Bildschirm (game.headless) wird nur die Kollision angelegt.
// =============================================================================
import * as THREE from 'three';

const _size = new THREE.Vector2();

/**
 * @param {object} game
 * @param {string} name  Name der Gruppe in der Szene (zum Nachschauen)
 */
export function createMapBuilder(game, name = 'Karte') {
  const visual = !game.headless && typeof document !== 'undefined';
  const root = new THREE.Group();
  root.name = name;
  game.root?.add(root);
  const colliders = [];
  const materials = new Map(); // Farbe → Material (gleiche Farbe = gleiches Material)
  const labels = []; // { sprite, width, height } – Grundgröße der Schilder (m)
  let tileTexture = null;

  function material(color) {
    const key = String(color);
    let m = materials.get(key);
    if (!m) {
      if (!tileTexture) tileTexture = createTileTexture();
      m = new THREE.MeshLambertMaterial({ color, map: tileTexture });
      materials.set(key, m);
    }
    return m;
  }

  const builder = {
    root,
    colliders,

    /**
     * Box mit Kollision. options = { color, data, kind, castShadow }
     * @returns {object} collider
     */
    addBox(min, max, options = {}) {
      const collider = game.world.addBox(min, max, options.data ?? { kind: options.kind ?? 'static' });
      colliders.push(collider);
      if (visual) {
        const sx = collider.max.x - collider.min.x;
        const sy = collider.max.y - collider.min.y;
        const sz = collider.max.z - collider.min.z;
        const mesh = new THREE.Mesh(createTiledBoxGeometry(sx, sy, sz), material(options.color ?? '#B8C4D6'));
        mesh.position.set((collider.min.x + collider.max.x) / 2, (collider.min.y + collider.max.y) / 2, (collider.min.z + collider.max.z) / 2);
        mesh.castShadow = options.castShadow ?? true;
        mesh.receiveShadow = true;
        root.add(mesh);
        collider.mesh = mesh;
      }
      return collider;
    },

    /**
     * Rampe/Dach mit Kollision. spec wie world.addSlope. options = { color, data, kind }
     * @returns {object} collider
     */
    addSlope(spec, options = {}) {
      const collider = game.world.addSlope(spec, options.data ?? { kind: options.kind ?? 'static' });
      colliders.push(collider);
      if (visual) {
        const mesh = new THREE.Mesh(createSlopeGeometry(collider), material(options.color ?? '#D9A066'));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        root.add(mesh);
        collider.mesh = mesh;
      }
      return collider;
    },

    /** Schild mit Text, das immer zur Kamera schaut (nur Grafik). */
    addLabel(text, position, options = {}) {
      if (!visual) return null;
      const sprite = createLabelSprite(text, options);
      sprite.position.set(position.x, position.y, position.z);
      root.add(sprite);
      labels.push({ sprite, width: sprite.scale.x, height: sprite.scale.y });
      return sprite;
    },

    /**
     * Jedes Bild: Schilder in der Ferne so weit vergrößern, dass sie auf dem
     * Bildschirm mindestens visuals.labelMinScreenHeight Pixel hoch sind.
     */
    frameUpdate() {
      if (!visual || labels.length === 0) return;
      const camera = game.camera;
      const renderer = game.renderer;
      if (!camera || !renderer) return;
      const screenHeight = renderer.getSize(_size).y;
      if (!(screenHeight > 0)) return;
      const visuals = game.config?.visuals ?? {};
      const minPixels = visuals.labelMinScreenHeight ?? 22;
      const maxGrow = visuals.labelMaxGrow ?? 4;
      // so viel Welt-Höhe (m) ist ein Pixel in 1 m Abstand
      const metersPerPixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / screenHeight;
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        const distance = l.sprite.position.distanceTo(camera.position);
        const grow = Math.min(maxGrow, Math.max(1, (minPixels * metersPerPixel * distance) / l.height));
        l.sprite.scale.set(l.width * grow, l.height * grow, 1);
      }
    },

    /** Grafik-Objekt hinzufügen (z. B. Boden). */
    addObject(object) {
      root.add(object);
      return object;
    },

    /** Alles entfernen: Kollision und Grafik. */
    dispose() {
      for (const c of colliders) game.world.remove(c);
      colliders.length = 0;
      labels.length = 0;
      disposeObject(root);
      root.parent?.remove(root);
      for (const m of materials.values()) m.dispose();
      materials.clear();
      tileTexture?.dispose();
      tileTexture = null;
    },
  };
  return builder;
}

/** Entsorgt Formen, Materialien und Bilder unter einem Objekt (gemeinsame Formen bleiben). */
export function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry && !child.geometry.userData?.shared) child.geometry.dispose();
    const mats = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    for (const m of mats) {
      if (m.userData?.shared) continue;
      m.map?.dispose();
      m.dispose();
    }
  });
}

/**
 * Box, deren Bild-Kacheln immer 1 x 1 m groß sind (egal wie groß die Box ist).
 * So sieht man sofort, wie hoch/breit etwas ist.
 */
export function createTiledBoxGeometry(sx, sy, sz) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  const uv = geometry.attributes.uv;
  // Reihenfolge der Seiten: +x, −x, +y, −y, +z, −z (je 4 Ecken)
  const sizes = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let face = 0; face < 6; face++) {
    const [u, v] = sizes[face];
    for (let i = face * 4; i < face * 4 + 4; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  }
  return geometry;
}

/** Form einer Schräge (Rampe oder Pyramiden-Dach) genau passend zum Collider. */
export function createSlopeGeometry(c) {
  const positions = [];
  const uvs = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  // Dreieck so drehen, dass seine Vorderseite in Richtung "expected" zeigt
  function tri(p0, p1, p2, expected, horizontalUv) {
    a.subVectors(p1, p0);
    b.subVectors(p2, p0);
    n.crossVectors(a, b);
    if (n.dot(expected) < 0) {
      const tmp = p1;
      p1 = p2;
      p2 = tmp;
    }
    for (const p of [p0, p1, p2]) {
      positions.push(p.x, p.y, p.z);
      if (horizontalUv) uvs.push(p.x, p.z);
      else uvs.push(p.x + p.z, p.y);
    }
  }
  const quad = (p0, p1, p2, p3, expected, horizontalUv) => {
    tri(p0, p1, p2, expected, horizontalUv);
    tri(p0, p2, p3, expected, horizontalUv);
  };
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const corners = [[c.minX, c.minZ], [c.maxX, c.minZ], [c.maxX, c.maxZ], [c.minX, c.maxZ]];
  const t = c.vThickness;
  const surface = (x, z) => (c.kind === 'pyramid' ? c.baseY : c.a * x + c.b * z + c.c);
  const top = corners.map(([x, z]) => v(x, surface(x, z), z));
  const bottom = corners.map(([x, z]) => v(x, surface(x, z) - t, z));
  const cx = (c.minX + c.maxX) / 2;
  const cz = (c.minZ + c.maxZ) / 2;

  if (c.kind === 'pyramid') {
    const apex = v(cx, c.baseY + c.rise, cz);
    const apexBottom = v(cx, c.baseY + c.rise - t, cz);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const mid = v((top[i].x + top[j].x) / 2 - cx, 0, (top[i].z + top[j].z) / 2 - cz).normalize();
      const up = v(mid.x, 1, mid.z);
      tri(top[i], top[j], apex, up, true);
      tri(bottom[i], bottom[j], apexBottom, up.clone().negate(), true);
      quad(top[i], top[j], bottom[j], bottom[i], mid, false);
    }
  } else {
    const up = v(-c.a, 1, -c.b);
    quad(top[0], top[1], top[2], top[3], up, true);
    quad(bottom[0], bottom[1], bottom[2], bottom[3], up.clone().negate(), true);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const out = v((top[i].x + top[j].x) / 2 - cx, 0, (top[i].z + top[j].z) / 2 - cz).normalize();
      quad(top[i], top[j], bottom[j], bottom[i], out, false);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

// Helle Kachel mit feinem Rand (wird mit der Material-Farbe eingefärbt)
function createTileTexture() {
  const px = 128;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.035)';
  ctx.fillRect(px / 2, 0, px / 2, px / 2);
  ctx.fillRect(0, px / 2, px / 2, px / 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  ctx.fillRect(0, 0, px, 3);
  ctx.fillRect(0, 0, 3, px);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

// Schild: Text auf einem abgerundeten Kasten, als "Sprite" (schaut immer zur Kamera)
function createLabelSprite(text, options) {
  const scale = 2; // schärfere Schrift
  const fontSize = 30 * scale;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `700 ${fontSize}px "Segoe UI", system-ui, Arial, sans-serif`;
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 36 * scale;
  const height = fontSize + 24 * scale;
  canvas.width = width;
  canvas.height = height;
  ctx.font = font;
  ctx.fillStyle = options.background ?? 'rgba(15, 17, 21, 0.72)';
  const r = 14 * scale;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(width, 0, width, height, r);
  ctx.arcTo(width, height, 0, height, r);
  ctx.arcTo(0, height, 0, 0, r);
  ctx.arcTo(0, 0, width, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = options.color ?? '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + 2 * scale);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const worldHeight = options.size ?? 0.6;
  sprite.scale.set((worldHeight * width) / height, worldHeight, 1);
  sprite.renderOrder = 10;
  return sprite;
}
