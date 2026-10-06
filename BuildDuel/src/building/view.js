// =============================================================================
// Bauteile zeichnen (nur mit Bildschirm)
// =============================================================================
// - Fertige, unbearbeitete Teile: InstancedMesh je (Typ, Material, Risse ja/nein)
//   → 3000 Teile kosten nur ein paar Zeichen-Aufrufe. Schaden macht sie dunkler
//   (Farbe pro Teil), unter 50 % Leben zeigt das Bild Risse.
// - Teile im Aufbau (leicht durchsichtig, werden fester) und editierte Teile
//   (eigene Form mit Löchern) sind einzelne Meshes.
// - Einsturz: das Teil sackt kurz ab und verblasst (danach weg).
// - Tür: Tür-Blatt, das auf- und zuschwingt.
// - Vorschau ("Geist", blau = geht, rot = geht nicht) und Edit-Kacheln – nur für
//   den Spieler.
// Ohne Bildschirm (headless) wird diese Datei gar nicht benutzt.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import {
  createSharedGeometry, createPieceGeometry, createDoorGeometry, createTileGeometries, createMaterialTexture,
  pieceOrigin, pieceRotationY, doorRect, isDoorPiece,
} from './pieces.js';
import { CELL_SIZE as S, LEVEL_HEIGHT as H } from './grid.js';

const B = CONFIG.building;
const TYPES = B.pieceTypes;
const OPACITY_LEVELS = 8;
const DARK_LEVELS = 4;

/**
 * @param {object} game  braucht game.root (THREE.Group), game.renderer (optional)
 */
export function createBuildingView(game) {
  const root = new THREE.Group();
  root.name = 'Bauteile';
  game.root.add(root);

  const geometries = {};
  for (const type of TYPES) geometries[type] = createSharedGeometry(type);
  const doorGeometry = createDoorGeometry();

  // --- Bilder und Materialien ----------------------------------------------------
  const textures = new Map(); // "wood|0" → Textur
  function texture(material, cracked) {
    const key = `${material}|${cracked ? 1 : 0}`;
    let t = textures.get(key);
    if (!t) {
      t = createMaterialTexture(material, cracked, game.renderer);
      textures.set(key, t);
    }
    return t;
  }
  const materials = new Map();
  /** Material für ein Teil: cracked, dark 0..DARK_LEVELS, opacity 0..OPACITY_LEVELS (= ganz fest) */
  function materialFor(material, cracked, dark = 0, opacity = OPACITY_LEVELS, instanced = false) {
    const key = `${material}|${cracked ? 1 : 0}|${dark}|${opacity}|${instanced ? 1 : 0}`;
    let m = materials.get(key);
    if (!m) {
      const shade = instanced ? 1 : 1 - B.damageDarkening * (dark / DARK_LEVELS);
      m = new THREE.MeshLambertMaterial({
        map: texture(material, cracked),
        color: new THREE.Color(shade, shade, shade),
        transparent: opacity < OPACITY_LEVELS,
        opacity: opacity / OPACITY_LEVELS,
      });
      m.userData.shared = true;
      materials.set(key, m);
    }
    return m;
  }

  // --- InstancedMesh-Gruppen ---------------------------------------------------------
  const groups = new Map(); // "wall|wood|0" → { mesh, list, type, material, cracked, dirty }
  const _matrix = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _axisY = new THREE.Vector3(0, 1, 0);
  const _color = new THREE.Color();

  function groupFor(type, material, cracked) {
    const key = `${type}|${material}|${cracked ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, type, material, cracked, mesh: null, list: [], capacity: 0 };
      groups.set(key, g);
      growGroup(g, 32);
    }
    return g;
  }

  function growGroup(g, capacity) {
    capacity = Math.min(Math.max(capacity, 1), B.maxPieces);
    const mesh = new THREE.InstancedMesh(geometries[g.type], materialFor(g.material, g.cracked, 0, OPACITY_LEVELS, true), capacity);
    mesh.name = `Bauteile ${g.key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // Teile liegen überall – immer zeichnen (sicher und billig)
    mesh.count = 0;
    if (!g.mesh) {
      mesh.setColorAt(0, _color.setRGB(1, 1, 1)); // legt die Farb-Liste an
    } else {
      for (let i = 0; i < g.list.length; i++) {
        g.mesh.getMatrixAt(i, _matrix);
        mesh.setMatrixAt(i, _matrix);
        g.mesh.getColorAt(i, _color);
        mesh.setColorAt(i, _color);
      }
      mesh.count = g.list.length;
      root.remove(g.mesh);
      g.mesh.dispose();
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    g.mesh = mesh;
    g.capacity = capacity;
    root.add(mesh);
  }

  function shadeOf(piece) {
    const frac = Math.max(0, Math.min(1, piece.health / piece.maxHealth));
    return 1 - B.damageDarkening * (1 - frac);
  }

  function writeInstance(g, index, piece) {
    pieceOrigin(piece, _pos);
    _quat.setFromAxisAngle(_axisY, pieceRotationY(piece));
    _matrix.compose(_pos, _quat, _scale);
    g.mesh.setMatrixAt(index, _matrix);
    const shade = shadeOf(piece);
    g.mesh.setColorAt(index, _color.setRGB(shade, shade, shade));
    g.mesh.instanceMatrix.needsUpdate = true;
    if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
  }

  function addInstance(piece, g) {
    if (g.list.length >= g.capacity) growGroup(g, g.capacity * 2);
    const index = g.list.length;
    g.list.push(piece);
    g.mesh.count = g.list.length;
    piece.view.group = g;
    piece.view.index = index;
    writeInstance(g, index, piece);
  }

  function removeInstance(piece) {
    const v = piece.view;
    const g = v.group;
    if (!g) return;
    const index = v.index;
    const last = g.list.length - 1;
    if (index !== last) {
      const moved = g.list[last];
      g.list[index] = moved;
      moved.view.index = index;
      g.mesh.getMatrixAt(last, _matrix);
      g.mesh.setMatrixAt(index, _matrix);
      g.mesh.getColorAt(last, _color);
      g.mesh.setColorAt(index, _color);
    }
    g.list.pop();
    g.mesh.count = g.list.length;
    g.mesh.instanceMatrix.needsUpdate = true;
    if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
    v.group = null;
    v.index = -1;
  }

  // --- einzelne Meshes (Aufbau, Edit) ------------------------------------------------
  function removeSingle(piece) {
    const v = piece.view;
    if (!v.mesh) return;
    root.remove(v.mesh);
    v.mesh = null;
  }

  function disposeCustomGeometry(v) {
    if (v.customGeometry) {
      v.customGeometry.dispose();
      v.customGeometry = null;
    }
  }

  function ensureDoor(piece) {
    const v = piece.view;
    const door = isDoorPiece(piece);
    if (door && !v.door) {
      const d = doorRect();
      const pivot = new THREE.Group();
      pivot.name = 'Tür';
      // Angel unten an der Seite u0 der Tür
      if (piece.kind === 'wx') {
        pivot.position.set(piece.i * S + d.u0, piece.j * H, piece.k * S);
      } else {
        pivot.position.set(piece.i * S, piece.j * H, piece.k * S + d.u0);
        pivot.rotation.y = -Math.PI / 2;
      }
      const mesh = new THREE.Mesh(doorGeometry, materialFor(piece.material, false));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pivot.add(mesh);
      root.add(pivot);
      v.door = { pivot, mesh, baseYaw: pivot.rotation.y };
    } else if (!door && v.door) {
      root.remove(v.door.pivot);
      v.door = null;
    }
  }

  // Bauteil so zeigen, wie es gerade ist (InstancedMesh oder einzeln)
  function refresh(piece) {
    const v = piece.view;
    if (!v) return;
    const constructing = piece.buildProgress < 1;
    const edited = (piece.editMask | 0) !== 0;
    const frac = Math.max(0, Math.min(1, piece.health / piece.maxHealth));
    const cracked = frac < B.crackThreshold;
    v.cracked = cracked;
    if (!constructing && !edited) {
      removeSingle(piece);
      disposeCustomGeometry(v);
      const g = groupFor(piece.type, piece.material, cracked);
      if (v.group !== g) {
        removeInstance(piece);
        addInstance(piece, g);
      } else {
        writeInstance(g, v.index, piece);
      }
    } else {
      removeInstance(piece);
      if (edited && (!v.customGeometry || v.editMask !== piece.editMask)) {
        disposeCustomGeometry(v);
        v.customGeometry = createPieceGeometry(piece);
        v.editMask = piece.editMask;
      }
      if (!edited) disposeCustomGeometry(v);
      const geometry = v.customGeometry ?? geometries[piece.type];
      const dark = Math.round((1 - frac) * DARK_LEVELS);
      const opacity = constructing ? opacityLevel(piece.buildProgress) : OPACITY_LEVELS;
      const material = materialFor(piece.material, cracked, dark, opacity);
      if (!v.mesh) {
        v.mesh = new THREE.Mesh(geometry, material);
        v.mesh.castShadow = true;
        v.mesh.receiveShadow = true;
        root.add(v.mesh);
      }
      v.mesh.geometry = geometry;
      v.mesh.material = material;
      pieceOrigin(piece, v.mesh.position);
      v.mesh.rotation.set(0, v.customGeometry ? 0 : pieceRotationY(piece), 0);
      v.opacity = opacity;
      v.dark = dark;
    }
    ensureDoor(piece);
  }

  function opacityLevel(progress) {
    const c = B.constructionOpacity;
    const o = c.start + (c.end - c.start) * Math.max(0, Math.min(1, progress));
    return Math.max(1, Math.min(OPACITY_LEVELS - 1, Math.round(o * OPACITY_LEVELS)));
  }

  // --- Einsturz-Trümmer ----------------------------------------------------------------
  const debris = [];

  function spawnDebris(piece, time) {
    const v = piece.view;
    const geometry = v.customGeometry ?? geometries[piece.type];
    const mesh = new THREE.Mesh(geometry, materialFor(piece.material, v.cracked, 0, OPACITY_LEVELS - 1));
    pieceOrigin(piece, mesh.position);
    mesh.rotation.set(0, v.customGeometry ? 0 : pieceRotationY(piece), 0);
    root.add(mesh);
    const seed = (piece.id * 9301 + 49297) % 233280;
    debris.push({
      mesh,
      start: time,
      baseY: mesh.position.y,
      custom: v.customGeometry, // gehört jetzt den Trümmern (wird danach entsorgt)
      material: piece.material,
      cracked: v.cracked,
      tiltX: ((seed % 100) / 100 - 0.5) * 0.5,
      tiltZ: (((seed / 100) % 100) / 100 - 0.5) * 0.5,
      baseRotX: mesh.rotation.x,
      baseRotZ: mesh.rotation.z,
    });
    v.customGeometry = null;
  }

  function updateDebris(time) {
    for (let n = debris.length - 1; n >= 0; n--) {
      const d = debris[n];
      const t = (time - d.start) / B.collapseAnimTime;
      if (t >= 1 || t < -1) {
        root.remove(d.mesh);
        d.custom?.dispose();
        debris[n] = debris[debris.length - 1];
        debris.pop();
        continue;
      }
      const k = Math.max(0, t);
      d.mesh.position.y = d.baseY - B.collapseSink * k * k;
      d.mesh.rotation.x = d.baseRotX + d.tiltX * k;
      d.mesh.rotation.z = d.baseRotZ + d.tiltZ * k;
      const op = Math.max(1, Math.min(OPACITY_LEVELS - 1, Math.round((1 - k) * OPACITY_LEVELS)));
      d.mesh.material = materialFor(d.material, d.cracked, 0, op);
    }
  }

  // --- Vorschau (Geist) -------------------------------------------------------------
  const previewOk = new THREE.MeshBasicMaterial({
    color: B.previewColorOk, transparent: true, opacity: B.previewOpacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const previewBad = previewOk.clone();
  previewBad.color.set(B.previewColorBlocked);
  const edgeOk = new THREE.LineBasicMaterial({ color: B.previewColorOk, transparent: true, opacity: 0.95, depthWrite: false });
  const edgeBad = new THREE.LineBasicMaterial({ color: B.previewColorBlocked, transparent: true, opacity: 0.95, depthWrite: false });
  for (const m of [previewOk, previewBad, edgeOk, edgeBad]) m.userData.shared = true;
  const ghosts = {};
  for (const type of TYPES) {
    const mesh = new THREE.Mesh(geometries[type], previewOk);
    mesh.name = `Vorschau ${type}`;
    mesh.renderOrder = 5;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometries[type], 20), edgeOk);
    edges.renderOrder = 6;
    mesh.add(edges);
    mesh.visible = false;
    root.add(mesh);
    ghosts[type] = { mesh, edges };
  }
  const _ghostPiece = { type: 'wall', kind: 'wx', i: 0, j: 0, k: 0, dir: 0 };

  function setPreview(target) {
    for (const type of TYPES) {
      const g = ghosts[type];
      const show = !!target && target.type === type;
      g.mesh.visible = show;
      if (!show) continue;
      _ghostPiece.type = target.type;
      _ghostPiece.kind = target.kind;
      _ghostPiece.i = target.i;
      _ghostPiece.j = target.j;
      _ghostPiece.k = target.k;
      _ghostPiece.dir = target.dir;
      pieceOrigin(_ghostPiece, g.mesh.position);
      g.mesh.rotation.set(0, pieceRotationY(_ghostPiece), 0);
      g.mesh.scale.setScalar(1.004);
      g.mesh.material = target.valid ? previewOk : previewBad;
      g.edges.material = target.valid ? edgeOk : edgeBad;
    }
  }

  // --- Edit-Kacheln ------------------------------------------------------------------
  const tileMaterial = (color, opacity) => {
    const m = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    m.userData.shared = true;
    return m;
  };
  const tileNormal = tileMaterial(B.editTileColor, B.editTileOpacity);
  const tileHover = tileMaterial(B.editTileHoverColor, Math.min(1, B.editTileOpacity + 0.2));
  const tileSelected = tileMaterial(B.editTileSelectedColor, Math.min(1, B.editTileOpacity + 0.25));
  const tileSelectedHover = tileMaterial('#FF8A8A', Math.min(1, B.editTileOpacity + 0.35));
  let overlay = null; // { piece, group, meshes[] }

  function setEditOverlay(session) {
    if (overlay && (!session || overlay.piece !== session.piece)) {
      root.remove(overlay.group);
      for (const m of overlay.meshes) m.geometry.dispose();
      overlay = null;
    }
    if (!session) return;
    if (!overlay) {
      const group = new THREE.Group();
      group.name = 'Edit-Kacheln';
      pieceOrigin(session.piece, group.position);
      const meshes = createTileGeometries(session.piece).map((geometry) => {
        const mesh = new THREE.Mesh(geometry, tileNormal);
        mesh.renderOrder = 7;
        group.add(mesh);
        return mesh;
      });
      root.add(group);
      overlay = { piece: session.piece, group, meshes };
    }
    for (let t = 0; t < overlay.meshes.length; t++) {
      const selected = (session.selection & (1 << t)) !== 0;
      const hover = session.hover === t;
      overlay.meshes[t].material = selected ? (hover ? tileSelectedHover : tileSelected) : hover ? tileHover : tileNormal;
    }
  }

  // --- Schnittstelle ----------------------------------------------------------------
  return {
    root,
    /** Neues Bauteil zeigen. */
    add(piece) {
      piece.view = { group: null, index: -1, mesh: null, customGeometry: null, editMask: 0, door: null, cracked: false, opacity: OPACITY_LEVELS, dark: 0 };
      refresh(piece);
    },
    /** Zustand geändert (Schaden, Edit, Aufbau fertig, Tür). */
    refresh,
    /** Nur Schaden geändert: billig, wenn nur die Farbe anders wird. */
    damaged(piece) {
      const v = piece.view;
      if (!v) return;
      const frac = Math.max(0, Math.min(1, piece.health / piece.maxHealth));
      const cracked = frac < B.crackThreshold;
      if (v.group && cracked === v.cracked) writeInstance(v.group, v.index, piece);
      else refresh(piece);
    },
    /** Bauteil entfernen; collapsed = mit Einsturz-Animation. */
    remove(piece, collapsed, time) {
      const v = piece.view;
      if (!v) return;
      if (collapsed) spawnDebris(piece, time);
      removeInstance(piece);
      removeSingle(piece);
      disposeCustomGeometry(v);
      if (v.door) {
        root.remove(v.door.pivot);
        v.door = null;
      }
      piece.view = null;
    },
    /**
     * Jedes Bild. time = Spielzeit für Animationen; constructing = Teile im Aufbau.
     */
    frameUpdate(time, constructing, doors) {
      for (const piece of constructing) {
        const v = piece.view;
        if (!v || !v.mesh) continue;
        const level = opacityLevel(piece.buildProgress);
        if (level !== v.opacity) refresh(piece);
      }
      for (const piece of doors) {
        const d = piece.view?.door;
        if (!d) continue;
        const t = Math.max(0, Math.min(1, (time - (piece.doorChangedAt ?? -10)) / B.doorOpenTime));
        const open = piece.doorOpen ? t : 1 - t;
        const ease = open * open * (3 - 2 * open);
        d.pivot.rotation.y = d.baseYaw + ease * B.doorOpenAngle * (Math.PI / 180);
      }
      updateDebris(time);
    },
    setPreview,
    setEditOverlay,
    /** Für Tests: wie viele Teile stecken in InstancedMeshes, wie viele einzeln? */
    stats() {
      let instanced = 0;
      let drawCalls = 0;
      for (const g of groups.values()) {
        instanced += g.list.length;
        if (g.list.length) drawCalls++;
      }
      let singles = 0;
      root.traverse((o) => {
        if (o.isMesh && !o.isInstancedMesh && o.visible && !o.name.startsWith('Vorschau')) singles++;
      });
      return { instanced, groups: groups.size, drawCalls, singles, debris: debris.length };
    },
    /** Alles weg (Runde neu). */
    clear() {
      for (const g of groups.values()) {
        g.list.length = 0;
        g.mesh.count = 0;
      }
      for (const d of debris) {
        root.remove(d.mesh);
        d.custom?.dispose();
      }
      debris.length = 0;
      setPreview(null);
      setEditOverlay(null);
      for (const child of [...root.children]) {
        if (child.isInstancedMesh || child.name.startsWith('Vorschau')) continue;
        root.remove(child);
      }
    },
    dispose() {
      this.clear();
      for (const g of groups.values()) g.mesh.dispose();
      groups.clear();
      for (const g of Object.values(geometries)) g.dispose();
      doorGeometry.dispose();
      for (const type of TYPES) ghosts[type].edges.geometry.dispose();
      for (const m of materials.values()) m.dispose();
      materials.clear();
      for (const t of textures.values()) t.dispose();
      textures.clear();
      for (const m of [previewOk, previewBad, edgeOk, edgeBad, tileNormal, tileHover, tileSelected, tileSelectedHover]) m.dispose();
      root.parent?.remove(root);
    },
  };
}
