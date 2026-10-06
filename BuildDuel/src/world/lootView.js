// =============================================================================
// Grafik für Loot (nur mit Bildschirm): Kisten, Gegenstände am Boden, Schild
// =============================================================================
// - Kisten: goldener Würfel mit Beschlägen, pulsierendes Leuchten + Leucht-Fleck.
//   Geöffnet: schrumpft kurz und verschwindet.
// - Gegenstände: Waffen-Modelle (weapons/models.js) in Seltenheits-Farbe, schweben,
//   wippen und drehen sich; darunter ein Leucht-Fleck, darüber eine Lichtsäule in
//   Seltenheits-Farbe (gut zu sehen, auch im grünen Gras). Munition = Kiste in der
//   Munitions-Farbe, Material = kleiner Stapel (Bretter, Steine, Metall-Platten).
// - Aus der Kiste/beim Fallenlassen springen Gegenstände im Bogen an ihren Platz.
// - Schild über dem Gegenstand, den der Spieler mit E nehmen würde (Name in
//   Seltenheits-Farbe + Taste).
// Leistung: Pro Modell-Art EIN InstancedMesh (alle Sturmgewehre = 1 Zeichen-Aufruf),
// dazu je 1 für Lichtsäulen, Leucht-Flecken, Kisten → wenige Zeichen-Aufrufe.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createWeaponModel, rarityColor } from '../weapons/models.js';
import { mergeSimple } from './props.js';

const L = CONFIG.loot;
const MODEL_IDS = ['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher', 'bandage', 'medkit', 'smallShield', 'bigShield'];
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _size = new THREE.Vector2();

/**
 * @param {object} game
 * @param {object} loot  das Loot-System (chests, items)
 */
export function createLootView(game, loot) {
  const root = new THREE.Group();
  root.name = 'Loot';
  game.root.add(root);
  const capacity = L.maxFloorItems + 8;
  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };

  // --- Modelle der Gegenstände (je Art ein InstancedMesh) -------------------------------------
  const modelMeshes = new Map(); // Schlüssel → { mesh, n }
  const modelMaterial = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
  for (const id of MODEL_IDS) addModelMesh(id, buildModelGeometry(id));
  addModelMesh('ammo', buildAmmoGeometry());
  for (const m of CONFIG.materials.order) addModelMesh(`m:${m}`, buildMaterialGeometry(m));

  function addModelMesh(key, geometry) {
    keep(geometry);
    const mesh = new THREE.InstancedMesh(geometry, modelMaterial, capacity);
    mesh.name = `Loot ${key}`;
    mesh.castShadow = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.setColorAt(0, _c.set('#FFFFFF'));
    root.add(mesh);
    modelMeshes.set(key, { mesh, n: 0 });
  }

  // --- Lichtsäulen und Leucht-Flecken ----------------------------------------------------------
  const beamTexture = keep(createBeamTexture());
  const beamGeometry = keep(new THREE.CylinderGeometry(L.beamRadius * 0.35, L.beamRadius, L.beamHeight, 10, 1, true));
  beamGeometry.translate(0, L.beamHeight / 2, 0);
  const beamMaterial = keep(new THREE.MeshBasicMaterial({
    map: beamTexture, transparent: true, opacity: L.beamOpacity, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  const beams = new THREE.InstancedMesh(beamGeometry, beamMaterial, capacity);
  beams.name = 'Loot-Lichtsäulen';
  beams.frustumCulled = false;
  beams.count = 0;
  beams.renderOrder = 3;
  beams.setColorAt(0, _c.set('#FFFFFF'));
  root.add(beams);

  const glowTexture = keep(createGlowTexture());
  const glowGeometry = keep(new THREE.PlaneGeometry(1, 1));
  glowGeometry.rotateX(-Math.PI / 2);
  const glowMaterial = keep(new THREE.MeshBasicMaterial({
    map: glowTexture, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  const glows = new THREE.InstancedMesh(glowGeometry, glowMaterial, capacity + 64);
  glows.name = 'Loot-Leuchten';
  glows.frustumCulled = false;
  glows.count = 0;
  glows.renderOrder = 2;
  glows.setColorAt(0, _c.set('#FFFFFF'));
  root.add(glows);

  // --- Kisten ----------------------------------------------------------------------------------
  const chestCfg = L.chest;
  const cs = chestCfg.size;
  const chestBodyGeometry = keep(mergeSimple([
    [new THREE.BoxGeometry(cs.x, cs.y * 0.62, cs.z), 0, cs.y * 0.31, 0],
    [new THREE.BoxGeometry(cs.x * 1.02, cs.y * 0.34, cs.z * 1.02), 0, cs.y * 0.62 + cs.y * 0.17, 0], // Deckel
  ]));
  const chestTrimGeometry = keep(mergeSimple([
    [new THREE.BoxGeometry(cs.x * 1.04, 0.07, cs.z * 1.04), 0, cs.y * 0.62, 0],
    [new THREE.BoxGeometry(0.09, cs.y * 1.0, cs.z * 1.05), -cs.x * 0.33, cs.y * 0.5, 0],
    [new THREE.BoxGeometry(0.09, cs.y * 1.0, cs.z * 1.05), cs.x * 0.33, cs.y * 0.5, 0],
    [new THREE.BoxGeometry(0.16, 0.2, 0.06), 0, cs.y * 0.58, -cs.z * 0.53], // Schloss
  ]));
  const chestMaterial = keep(new THREE.MeshLambertMaterial({ color: chestCfg.color, emissive: new THREE.Color(chestCfg.color), emissiveIntensity: chestCfg.emissiveMin }));
  const trimMaterial = keep(new THREE.MeshLambertMaterial({ color: chestCfg.trimColor }));
  let chestCapacity = 0;
  let chestBody = null;
  let chestTrim = null;
  ensureChestCapacity(Math.max(48, loot.chests.length));

  function ensureChestCapacity(n) {
    if (n <= chestCapacity) return;
    chestCapacity = Math.max(n, chestCapacity * 2);
    for (const old of [chestBody, chestTrim]) {
      if (!old) continue;
      root.remove(old);
      old.dispose();
    }
    chestBody = new THREE.InstancedMesh(chestBodyGeometry, chestMaterial, chestCapacity);
    chestTrim = new THREE.InstancedMesh(chestTrimGeometry, trimMaterial, chestCapacity);
    for (const m of [chestBody, chestTrim]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      root.add(m);
    }
    chestBody.name = 'Kisten';
    chestTrim.name = 'Kisten-Beschläge';
  }

  // --- Schild über dem Gegenstand im Fokus ------------------------------------------------------
  const labelCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  labelCanvas.width = 512;
  labelCanvas.height = 140;
  const labelTexture = keep(new THREE.CanvasTexture(labelCanvas));
  labelTexture.colorSpace = THREE.SRGBColorSpace;
  const labelMaterial = keep(new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false, depthWrite: false }));
  const label = new THREE.Sprite(labelMaterial);
  label.name = 'Loot-Schild';
  label.renderOrder = 20;
  label.visible = false;
  root.add(label);
  let labelKey = '';

  function drawLabel(prompt) {
    const ctx = labelCanvas.getContext('2d');
    const w = labelCanvas.width;
    const h = labelCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = L.labelBackground;
    roundRect(ctx, 6, 6, w - 12, h - 12, 22);
    ctx.fill();
    const target = prompt.target;
    const isChest = prompt.kind === 'chest';
    const color = isChest ? chestCfg.color : target.kind === 'weapon' ? rarityColor(target.rarity) : '#FFFFFF';
    ctx.fillStyle = color;
    ctx.fillRect(6, 6, 14, h - 12);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 46px "Segoe UI", system-ui, Arial, sans-serif';
    const title = isChest ? 'Kiste' : target.name + (target.kind === 'heal' && target.item.count > 1 ? ` ×${target.item.count}` : '');
    ctx.fillStyle = color;
    ctx.fillText(title, w / 2 + 6, 50);
    ctx.font = '600 32px "Segoe UI", system-ui, Arial, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    const key = useKeyName(game);
    const action = isChest ? 'Öffnen' : prompt.swap ? 'Tauschen' : 'Aufheben';
    const rarity = !isChest && target.kind === 'weapon' ? ` · ${CONFIG.rarities[target.rarity]?.name ?? ''}` : '';
    ctx.fillText(`[${key}] ${action}${rarity}`, w / 2 + 6, 102);
    labelTexture.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------------
  let time = 0;
  let glowCount = 0;

  function addGlow(x, y, z, size, color, intensity = 1) {
    if (glowCount >= glows.instanceMatrix.count) return;
    _p.set(x, y + 0.04, z);
    _s.set(size, 1, size);
    _q.identity();
    _m.compose(_p, _q, _s);
    glows.setMatrixAt(glowCount, _m);
    glows.setColorAt(glowCount, _c.set(color).multiplyScalar(intensity));
    glowCount++;
  }

  function frameUpdate(dt) {
    time += dt;
    const camera = game.camera;
    if (camera) camera.getWorldPosition(_cam);
    const maxD2 = L.showDistance * L.showDistance;
    const gameTime = game.time ?? 0;
    const pulse = 0.5 + 0.5 * Math.sin(time * chestCfg.pulseSpeed);
    chestMaterial.emissiveIntensity = chestCfg.emissiveMin + (chestCfg.emissiveMax - chestCfg.emissiveMin) * pulse;
    glowCount = 0;

    // Kisten
    ensureChestCapacity(loot.chests.length);
    let nc = 0;
    for (const chest of loot.chests) {
      let scale = 1;
      if (chest.opened) {
        const age = gameTime - chest.openTime;
        if (age > 0.35) continue;
        scale = Math.max(0.001, 1 - age / 0.35);
      }
      const p = chest.position;
      _e.set(0, chest.yaw, 0);
      _q.setFromEuler(_e);
      _p.set(p.x, p.y, p.z);
      _s.set(scale, scale * (chest.opened ? 1 + (1 - scale) * 0.4 : 1), scale);
      _m.compose(_p, _q, _s);
      chestBody.setMatrixAt(nc, _m);
      chestTrim.setMatrixAt(nc, _m);
      nc++;
      if (!chest.opened) addGlow(p.x, p.y, p.z, chestCfg.glowSize * (0.9 + 0.15 * pulse), chestCfg.glowColor, 0.55 + 0.35 * pulse);
    }
    chestBody.count = nc;
    chestTrim.count = nc;
    chestBody.visible = chestTrim.visible = nc > 0;
    chestBody.instanceMatrix.needsUpdate = true;
    chestTrim.instanceMatrix.needsUpdate = true;

    // Gegenstände
    for (const entry of modelMeshes.values()) entry.n = 0;
    let nb = 0;
    for (const fi of loot.items) {
      const rest = fi.position;
      const dx = rest.x - _cam.x;
      const dz = rest.z - _cam.z;
      if (camera && dx * dx + dz * dz > maxD2) continue;
      const key = fi.kind === 'ammo' ? 'ammo' : fi.kind === 'material' ? `m:${fi.material}` : fi.item?.id;
      const entry = modelMeshes.get(key);
      if (!entry || entry.n >= capacity) continue;
      // Lage: im Bogen heraus springen, dann schweben und wippen
      let x = rest.x;
      let y = rest.y + L.floatHeight + Math.sin(time * 2.2 + fi.phase) * L.bobHeight;
      let z = rest.z;
      if (fi.pop) {
        const t = Math.min(1, (gameTime - fi.pop.start) / fi.pop.duration);
        if (t < 1) {
          x = fi.pop.x + (rest.x - fi.pop.x) * t;
          z = fi.pop.z + (rest.z - fi.pop.z) * t;
          y = fi.pop.y + (rest.y + L.floatHeight - fi.pop.y) * t + L.popHeight * 4 * t * (1 - t);
        }
      }
      const isModel = fi.kind === 'weapon' || fi.kind === 'heal';
      const scale = isModel ? L.itemScale * (fi.kind === 'heal' ? 1.5 : 1) : 1;
      _e.set(fi.kind === 'weapon' ? 0.12 : 0, fi.phase + time * L.spinSpeed, 0);
      _q.setFromEuler(_e);
      _p.set(x, y, z);
      _s.setScalar(scale);
      _m.compose(_p, _q, _s);
      entry.mesh.setMatrixAt(entry.n, _m);
      if (fi.kind === 'weapon') entry.mesh.setColorAt(entry.n, _c.set(rarityColor(fi.rarity)));
      else if (fi.kind === 'ammo') entry.mesh.setColorAt(entry.n, _c.set(L.ammoColors[fi.weaponId] ?? '#CCCCCC'));
      else entry.mesh.setColorAt(entry.n, _c.set('#FFFFFF'));
      entry.n++;
      // Lichtsäule + Leucht-Fleck
      const color = fi.kind === 'weapon' ? rarityColor(fi.rarity) : fi.kind === 'heal' ? '#9FF5E0' : fi.kind === 'ammo' ? (L.ammoColors[fi.weaponId] ?? '#FFFFFF') : '#FFF3D6';
      if (isModel && nb < capacity) {
        _p.set(rest.x, rest.y, rest.z);
        _q.identity();
        _s.setScalar(fi.kind === 'weapon' ? 1 : 0.75);
        _m.compose(_p, _q, _s);
        beams.setMatrixAt(nb, _m);
        beams.setColorAt(nb, _c.set(color));
        nb++;
      }
      addGlow(rest.x, rest.y, rest.z, L.groundGlowRadius * 2 * (isModel ? 1 : 0.7), color, isModel ? 0.8 : 0.45);
    }
    for (const entry of modelMeshes.values()) {
      const m = entry.mesh;
      m.count = entry.n;
      m.visible = entry.n > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    beams.count = nb;
    beams.visible = nb > 0;
    beams.instanceMatrix.needsUpdate = true;
    if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
    glows.count = glowCount;
    glows.visible = glowCount > 0;
    glows.instanceMatrix.needsUpdate = true;
    if (glows.instanceColor) glows.instanceColor.needsUpdate = true;

    updateLabel();
  }

  function updateLabel() {
    const prompt = game.interactionPrompt;
    const target = prompt?.target;
    const camera = game.camera;
    if (!target || !camera || !game.renderer || (target.removed ?? false)) {
      label.visible = false;
      return;
    }
    const key = `${prompt.kind}:${target.id}:${prompt.swap}:${target.item?.count ?? ''}`;
    if (key !== labelKey) {
      labelKey = key;
      drawLabel(prompt);
    }
    const isChest = prompt.kind === 'chest';
    label.position.set(target.position.x, target.position.y + (isChest ? chestCfg.size.y + 0.75 : L.floatHeight + 0.95), target.position.z);
    // immer etwa gleich groß auf dem Bildschirm
    const screenHeight = game.renderer.getSize(_size).y || 720;
    camera.getWorldDirection(_fwd);
    const depth = Math.max(0.3, _fwd.dot(_p.subVectors(label.position, _cam)));
    const metersPerPixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / screenHeight;
    const hgt = 46 * metersPerPixel * depth;
    label.scale.set(hgt * (labelCanvas.width / labelCanvas.height), hgt, 1);
    label.visible = true;
  }

  return {
    root,
    chestsChanged() {
      ensureChestCapacity(loot.chests.length);
    },
    frameUpdate,
    /** Für Tests: wie viele Gegenstände/Kisten gerade gezeichnet werden. */
    stats() {
      let models = 0;
      for (const e of modelMeshes.values()) models += e.n;
      return { models, chests: chestBody?.count ?? 0, beams: beams.count, glows: glows.count, label: label.visible };
    },
    dispose() {
      root.parent?.remove(root);
      for (const e of modelMeshes.values()) e.mesh.dispose();
      modelMeshes.clear();
      beams.dispose();
      glows.dispose();
      chestBody?.dispose();
      chestTrim?.dispose();
      for (const d of disposables) d.dispose?.();
      disposables.length = 0;
    },
  };
}

// --- Formen ---------------------------------------------------------------------------------------

/**
 * Waffen-/Heil-Modell als EINE Form mit Ecken-Farben. Teile in Seltenheits-Farbe werden weiß
 * (die Instanz-Farbe färbt sie dann ein), alle anderen behalten ihre Farbe.
 */
function buildModelGeometry(id) {
  const a = createWeaponModel(id, 'common');
  const b = createWeaponModel(id, 'legendary');
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);
  const meshesA = [];
  const meshesB = [];
  a.traverse((o) => o.isMesh && meshesA.push(o));
  b.traverse((o) => o.isMesh && meshesB.push(o));
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const color = new THREE.Color();
  let offset = 0;
  meshesA.forEach((mesh, i) => {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    const ca = mesh.material.color;
    const cb = meshesB[i]?.material.color;
    const isRarity = cb && !ca.equals(cb);
    if (isRarity) color.set('#FFFFFF');
    else {
      color.copy(ca);
      if (mesh.material.emissive) color.add(mesh.material.emissive);
    }
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
      n.fromBufferAttribute(nor, k).applyMatrix3(normalMatrix).normalize();
      positions.push(v.x, v.y, v.z);
      normals.push(n.x, n.y, n.z);
      colors.push(color.r, color.g, color.b);
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) indices.push(offset + g.index.getX(k));
    else for (let k = 0; k < pos.count; k++) indices.push(offset + k);
    offset += pos.count;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  // Mitte in den Ursprung (dreht sich um die eigene Mitte)
  geometry.computeBoundingBox();
  const c = geometry.boundingBox.getCenter(new THREE.Vector3());
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.computeBoundingSphere();
  return geometry;
}

function buildAmmoGeometry() {
  return mergeSimple([
    [new THREE.BoxGeometry(0.46, 0.26, 0.32), 0, 0, 0, 1, 1, 1, '#FFFFFF'],
    [new THREE.BoxGeometry(0.48, 0.06, 0.34), 0, 0.1, 0, 1, 1, 1, '#2B2F38'],
    [new THREE.BoxGeometry(0.2, 0.12, 0.335), 0, -0.02, 0, 1, 1, 1, '#F5F5F5'],
  ], true);
}

function buildMaterialGeometry(material) {
  const base = CONFIG.visuals.colors[material] ?? '#CCCCCC';
  if (material === 'wood') {
    return mergeSimple([
      [new THREE.BoxGeometry(0.9, 0.11, 0.24), 0, -0.1, -0.14, 1, 1, 1, base],
      [new THREE.BoxGeometry(0.9, 0.11, 0.24), 0, -0.1, 0.14, 1, 1, 1, '#C98F57'],
      [new THREE.BoxGeometry(0.24, 0.11, 0.9), -0.2, 0.01, 0, 1, 1, 1, '#E3B07A'],
      [new THREE.BoxGeometry(0.24, 0.11, 0.9), 0.2, 0.01, 0, 1, 1, 1, base],
      [new THREE.BoxGeometry(0.9, 0.11, 0.24), 0, 0.12, 0, 1, 1, 1, '#C98F57'],
    ], true);
  }
  if (material === 'stone') {
    return mergeSimple([
      [new THREE.DodecahedronGeometry(0.22, 0), -0.18, -0.06, 0.05, 1.2, 0.8, 1, base],
      [new THREE.DodecahedronGeometry(0.2, 0), 0.18, -0.07, -0.06, 1, 0.8, 1.2, '#B3B3B3'],
      [new THREE.DodecahedronGeometry(0.19, 0), 0.02, 0.13, 0, 1.1, 0.9, 1.1, '#878787'],
    ], true);
  }
  return mergeSimple([
    [new THREE.BoxGeometry(0.8, 0.06, 0.5), 0, -0.1, 0, 1, 1, 1, base],
    [new THREE.BoxGeometry(0.75, 0.06, 0.46), 0.03, -0.03, 0.02, 1, 1, 1, '#9AAABB'],
    [new THREE.BoxGeometry(0.7, 0.1, 0.1), 0, 0.06, 0, 1, 1, 1, '#5F6E80'],
  ], true);
}

// Lichtsäule: unten hell, nach oben durchsichtig
function createBeamTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 64, 0, 0); // unten (v = 0) → oben
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Runder, weicher Leucht-Fleck
function createGlowTexture() {
  const px = 64;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Taste für "use" (E) aus den Einstellungen, als kurzer Name
function useKeyName(game) {
  const code = game.settings?.controls?.keyboard?.use?.[0] ?? 'KeyE';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}
