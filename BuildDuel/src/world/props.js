// =============================================================================
// Sammel-Objekte der Karten: Bäume, Felsen, Autos, Metallzäune
// =============================================================================
// - Kollision pro Objekt (Boxen) mit collider.data = { kind, harvest, ref, blocksBullets }
//   → die Spitzhacke sammelt davon Material (Baum = Holz, Fels = Stein, Auto/Zaun = Metall).
// - Jedes Objekt hat Leben (CONFIG.maps.props). Schläge und Schüsse ziehen Leben ab
//   (ref.applyDamage); bei 0 ist es weg (Kollision raus, Bild ausgeblendet) und das
//   Ereignis 'propDestroyed' { prop, by } kommt.
// - Grafik: ALLE Bäume einer Art sind EIN InstancedMesh (wenige Zeichen-Aufrufe),
//   ebenso Felsen, Autos und Zaun-Stücke.
//
//   const props = createPropSet(game, builder);
//   props.addTree(x, y, z, { kind: 'round'|'pine', scale })
//   props.addRock(x, y, z, { scale, yaw })
//   props.addCar(x, y, z, { yaw (0 oder π/2 …), color })
//   props.addFence(x0, z0, x1, z1, y)   – waagerecht oder senkrecht (entlang X oder Z)
//   props.finish()                     – Grafik bauen (einmal am Ende)
//
// Ohne Bildschirm (headless) gibt es nur Kollision + Leben.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// Maße (m) – fest, damit Bild und Kollision zusammenpassen
const TREE = { trunkRadius: 0.32, trunkHeight: 3.2, colliderHalf: 0.38 };
const CAR = { length: 4.0, width: 1.8, bodyHeight: 1.05, cabinLength: 2.1, cabinWidth: 1.6, cabinHeight: 0.7 };
const FENCE = { height: 1.3, thickness: 0.12, postEvery: 2 };

/**
 * @param {object} game
 * @param {object} builder  Karte (createMapBuilder): root, colliders
 */
export function createPropSet(game, builder) {
  const visual = !game.headless && typeof document !== 'undefined';
  const cfg = CONFIG.maps.props;
  const list = []; // alle Objekte
  const trees = [];
  const rocks = [];
  const cars = [];
  const fences = [];
  const meshes = []; // InstancedMesh-Liste (zum Aufräumen)
  let finished = false;
  const destroyEvent = { prop: null, by: null };

  function makeProp(kind, harvest, health) {
    const prop = {
      kind,
      harvest,
      health,
      maxHealth: health,
      destroyed: false,
      colliders: [],
      instances: [], // [{ mesh, index, matrix }]
      position: new THREE.Vector3(),
      /** Schaden (Schüsse, Spitzhacke). Rückgabe: { amount, destroyed } */
      applyDamage(amount, info = {}) {
        if (prop.destroyed || !(amount > 0)) return { amount: 0, destroyed: false };
        const done = Math.min(prop.health, amount);
        prop.health -= done;
        if (prop.health <= 1e-6) destroyProp(prop, info.attacker ?? null);
        return { amount: done, destroyed: prop.destroyed };
      },
    };
    list.push(prop);
    return prop;
  }

  function addCollider(prop, minX, minY, minZ, maxX, maxY, maxZ) {
    const data = { kind: prop.kind, harvest: prop.harvest, ref: prop, blocksBullets: true };
    const collider = game.world.addBox({ x: minX, y: minY, z: minZ }, { x: maxX, y: maxY, z: maxZ }, data);
    builder.colliders.push(collider);
    prop.colliders.push(collider);
    return collider;
  }

  function destroyProp(prop, by) {
    if (prop.destroyed) return;
    prop.destroyed = true;
    prop.health = 0;
    for (const c of prop.colliders) {
      game.world.remove(c);
      const i = builder.colliders.indexOf(c);
      if (i >= 0) builder.colliders.splice(i, 1);
    }
    for (const inst of prop.instances) {
      if (!inst.mesh) continue;
      inst.mesh.setMatrixAt(inst.index, ZERO);
      inst.mesh.instanceMatrix.needsUpdate = true;
    }
    destroyEvent.prop = prop;
    destroyEvent.by = by;
    game.events?.emit('propDestroyed', destroyEvent);
  }

  const set = {
    list,
    trees,
    rocks,
    cars,
    fences,

    /** Baum. kind 'round' (Laubbaum) oder 'pine' (Tanne). */
    addTree(x, y, z, options = {}) {
      const scale = options.scale ?? 1;
      const prop = makeProp('tree', CONFIG.materials.harvestSources.tree, cfg.tree.health);
      prop.position.set(x, y, z);
      prop.treeKind = options.kind ?? 'round';
      prop.scale = scale;
      prop.yaw = options.yaw ?? 0;
      prop.colorIndex = options.colorIndex ?? 0;
      const h = TREE.colliderHalf * scale;
      addCollider(prop, x - h, y - 0.5, z - h, x + h, y + TREE.trunkHeight * scale, z + h);
      trees.push(prop);
      return prop;
    },

    /** Fels (Kollision als Box, Bild als kantiger Stein). */
    addRock(x, y, z, options = {}) {
      const scale = options.scale ?? 1;
      const prop = makeProp('rock', CONFIG.materials.harvestSources.rock, cfg.rock.health);
      prop.position.set(x, y, z);
      prop.scale = scale;
      prop.stretch = options.stretch ?? { x: 1.2, y: 0.8, z: 1 };
      prop.yaw = options.yaw ?? 0;
      const sx = prop.stretch.x * scale;
      const sy = prop.stretch.y * scale;
      const sz = prop.stretch.z * scale;
      // Der Stein dreht sich – die Box nimmt die größere Seite (etwas kleiner als das Bild)
      const half = Math.max(sx, sz) * 0.82;
      addCollider(prop, x - half, y - 0.5, z - half, x + half, y + sy * 0.95, z + half);
      rocks.push(prop);
      return prop;
    },

    /** Auto (Metall). yaw 0 = längs der X-Achse, π/2 = längs Z. */
    addCar(x, y, z, options = {}) {
      const along = Math.abs(Math.sin(options.yaw ?? 0)) > 0.5 ? 'z' : 'x';
      const prop = makeProp('car', CONFIG.materials.harvestSources.car, cfg.car.health);
      prop.position.set(x, y, z);
      prop.yaw = along === 'x' ? 0 : Math.PI / 2;
      prop.color = options.color ?? cfg.colors.cars[0];
      const hl = CAR.length / 2;
      const hw = CAR.width / 2;
      const cl = CAR.cabinLength / 2;
      const cw = CAR.cabinWidth / 2;
      if (along === 'x') {
        addCollider(prop, x - hl, y, z - hw, x + hl, y + CAR.bodyHeight, z + hw);
        addCollider(prop, x - cl, y + CAR.bodyHeight, z - cw, x + cl + 0.1, y + CAR.bodyHeight + CAR.cabinHeight, z + cw);
      } else {
        addCollider(prop, x - hw, y, z - hl, x + hw, y + CAR.bodyHeight, z + hl);
        addCollider(prop, x - cw, y + CAR.bodyHeight, z - cl - 0.1, x + cw, y + CAR.bodyHeight + CAR.cabinHeight, z + cl);
      }
      cars.push(prop);
      return prop;
    },

    /** Metallzaun von (x0, z0) nach (x1, z1) auf Höhe y – entlang X oder Z, je 4 m ein eigenes Stück. */
    addFence(x0, z0, x1, z1, y = 0, options = {}) {
      const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
      const length = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
      const pieces = Math.max(1, Math.round(length / 4));
      const step = length / pieces;
      const made = [];
      for (let i = 0; i < pieces; i++) {
        const prop = makeProp('fence', CONFIG.materials.harvestSources.metalFence, cfg.fence.health);
        const t = FENCE.thickness / 2;
        const yy = typeof options.heightAt === 'function'
          ? options.heightAt(alongX ? Math.min(x0, x1) + (i + 0.5) * step : x0, alongX ? z0 : Math.min(z0, z1) + (i + 0.5) * step)
          : y;
        if (alongX) {
          const a = Math.min(x0, x1) + i * step;
          prop.position.set(a + step / 2, yy, z0);
          addCollider(prop, a, yy - 0.3, z0 - t, a + step, yy + FENCE.height, z0 + t);
        } else {
          const a = Math.min(z0, z1) + i * step;
          prop.position.set(x0, yy, a + step / 2);
          addCollider(prop, x0 - t, yy - 0.3, a, x0 + t, yy + FENCE.height, a + step);
        }
        prop.alongX = alongX;
        prop.length = step;
        fences.push(prop);
        made.push(prop);
      }
      return made;
    },

    /** Grafik bauen (einmal, nachdem alle Objekte hinzugefügt sind). */
    finish() {
      if (finished) return;
      finished = true;
      if (!visual) return;
      buildTreeMeshes();
      buildRockMesh();
      buildCarMeshes();
      buildFenceMesh();
    },

    /** Zerstört ein Objekt sofort (z. B. für Tests). */
    destroy(prop, by = null) {
      destroyProp(prop, by);
    },

    /** Objekte in der Nähe (für Bots): nicht zerstört, Art passt. */
    near(x, z, radius, kind = null) {
      const out = [];
      const r2 = radius * radius;
      for (const p of list) {
        if (p.destroyed || (kind && p.kind !== kind)) continue;
        const dx = p.position.x - x;
        const dz = p.position.z - z;
        if (dx * dx + dz * dz <= r2) out.push(p);
      }
      return out;
    },

    dispose() {
      for (const m of meshes) {
        m.parent?.remove(m);
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) mat.dispose();
        m.dispose?.();
      }
      meshes.length = 0;
    },
  };

  // --- Grafik ------------------------------------------------------------------------------
  function instanced(geometry, material, count, name, castShadow = true) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.count = count;
    builder.root.add(mesh);
    meshes.push(mesh);
    return mesh;
  }

  function place(prop, mesh, index, matrix, color) {
    mesh.setMatrixAt(index, matrix);
    if (color !== undefined && color !== null) mesh.setColorAt(index, _c.set(color));
    prop.instances.push({ mesh, index });
  }

  function finalize(mesh) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  function buildTreeMeshes() {
    if (trees.length === 0) return;
    const colors = cfg.colors;
    // Stamm (alle Bäume)
    const trunkGeo = new THREE.CylinderGeometry(TREE.trunkRadius * 0.8, TREE.trunkRadius, TREE.trunkHeight, 7);
    trunkGeo.translate(0, TREE.trunkHeight / 2, 0);
    const trunk = instanced(trunkGeo, new THREE.MeshLambertMaterial({ color: colors.trunk }), trees.length, 'Baumstämme');
    // Laub: Laubbaum = zwei Kugeln, Tanne = drei Kegel (je als EINE Form)
    const roundGeo = mergeSimple([
      [new THREE.IcosahedronGeometry(1.75, 1), 0, 4.4, 0, 1, 1, 1],
      [new THREE.IcosahedronGeometry(1.25, 1), 0.55, 5.25, -0.35, 1, 1, 1],
      [new THREE.IcosahedronGeometry(1.05, 1), -0.6, 4.9, 0.45, 1, 1, 1],
    ]);
    const pineGeo = mergeSimple([
      [new THREE.ConeGeometry(2.0, 2.6, 8), 0, 3.3, 0, 1, 1, 1],
      [new THREE.ConeGeometry(1.6, 2.3, 8), 0, 4.6, 0, 1, 1, 1],
      [new THREE.ConeGeometry(1.1, 2.0, 8), 0, 5.8, 0, 1, 1, 1],
    ]);
    const roundTrees = trees.filter((t) => t.treeKind !== 'pine');
    const pineTrees = trees.filter((t) => t.treeKind === 'pine');
    const leafMat = new THREE.MeshLambertMaterial({ color: '#FFFFFF', flatShading: true });
    const round = instanced(roundGeo, leafMat, roundTrees.length, 'Laubbäume');
    const pine = instanced(pineGeo, leafMat.clone(), pineTrees.length, 'Tannen');
    let ti = 0;
    let ri = 0;
    let pi = 0;
    for (const t of trees) {
      _e.set(0, t.yaw, 0);
      _q.setFromEuler(_e);
      _p.copy(t.position);
      _s.setScalar(t.scale);
      _m.compose(_p, _q, _s);
      place(t, trunk, ti++, _m);
      if (t.treeKind === 'pine') {
        place(t, pine, pi++, _m, colors.pine[t.colorIndex % colors.pine.length]);
      } else {
        place(t, round, ri++, _m, colors.leaves[t.colorIndex % colors.leaves.length]);
      }
    }
    for (const m of [trunk, round, pine]) finalize(m);
  }

  function buildRockMesh() {
    if (rocks.length === 0) return;
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mesh = instanced(geo, new THREE.MeshLambertMaterial({ color: '#FFFFFF', flatShading: true }), rocks.length, 'Felsen');
    rocks.forEach((r, i) => {
      _e.set(0.15 * Math.sin(i * 1.7), r.yaw, 0.1 * Math.cos(i * 2.3));
      _q.setFromEuler(_e);
      _p.set(r.position.x, r.position.y + r.stretch.y * r.scale * 0.55, r.position.z);
      _s.set(r.stretch.x * r.scale, r.stretch.y * r.scale, r.stretch.z * r.scale);
      _m.compose(_p, _q, _s);
      // leicht verschiedene Grautöne
      const shade = 0.88 + 0.12 * Math.sin(i * 12.9898);
      _c.set(cfg.colors.rock).multiplyScalar(shade);
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, _c);
      r.instances.push({ mesh, index: i });
    });
    finalize(mesh);
  }

  function buildCarMeshes() {
    if (cars.length === 0) return;
    // Karosserie (eingefärbt) – längs X gebaut
    const bodyGeo = mergeSimple([
      [new THREE.BoxGeometry(CAR.length, CAR.bodyHeight - 0.35, CAR.width), 0, 0.35 + (CAR.bodyHeight - 0.35) / 2, 0, 1, 1, 1],
      [new THREE.BoxGeometry(CAR.cabinLength, CAR.cabinHeight, CAR.cabinWidth), 0.05, CAR.bodyHeight + CAR.cabinHeight / 2, 0, 1, 1, 1],
    ]);
    // Teile, die nicht eingefärbt werden: Räder, Scheiben, Lampen (Farbe in den Ecken)
    const wheel = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12);
    wheel.rotateX(Math.PI / 2);
    const parts = [];
    for (const dx of [-1.3, 1.3]) for (const dz of [-0.85, 0.85]) parts.push([wheel.clone(), dx, 0.42, dz, 1, 1, 1, '#23252B']);
    const side = new THREE.BoxGeometry(1.75, 0.45, 0.04);
    parts.push([side.clone(), 0.05, CAR.bodyHeight + 0.37, -CAR.cabinWidth / 2 - 0.01, 1, 1, 1, '#7CC3E8']);
    parts.push([side.clone(), 0.05, CAR.bodyHeight + 0.37, CAR.cabinWidth / 2 + 0.01, 1, 1, 1, '#7CC3E8']);
    const front = new THREE.BoxGeometry(0.04, 0.45, 1.4);
    parts.push([front.clone(), -CAR.cabinLength / 2 + 0.03, CAR.bodyHeight + 0.37, 0, 1, 1, 1, '#7CC3E8']);
    parts.push([front.clone(), CAR.cabinLength / 2 + 0.07, CAR.bodyHeight + 0.37, 0, 1, 1, 1, '#7CC3E8']);
    const lamp = new THREE.BoxGeometry(0.05, 0.16, 0.36);
    for (const dz of [-0.55, 0.55]) parts.push([lamp.clone(), -CAR.length / 2 - 0.01, 0.75, dz, 1, 1, 1, '#FFF4B8']);
    const bumper = new THREE.BoxGeometry(0.12, 0.2, CAR.width);
    parts.push([bumper.clone(), -CAR.length / 2 - 0.04, 0.45, 0, 1, 1, 1, '#3A3D44']);
    parts.push([bumper.clone(), CAR.length / 2 + 0.04, 0.45, 0, 1, 1, 1, '#3A3D44']);
    const detailGeo = mergeSimple(parts, true);
    wheel.dispose();
    side.dispose();
    front.dispose();
    lamp.dispose();
    bumper.dispose();
    const body = instanced(bodyGeo, new THREE.MeshLambertMaterial({ color: '#FFFFFF' }), cars.length, 'Autos');
    const detail = instanced(detailGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), cars.length, 'Auto-Teile');
    cars.forEach((car, i) => {
      _e.set(0, car.yaw, 0);
      _q.setFromEuler(_e);
      _m.compose(car.position, _q, _s.setScalar(1));
      place(car, body, i, _m, car.color);
      place(car, detail, i, _m);
    });
    finalize(body);
    finalize(detail);
  }

  function buildFenceMesh() {
    if (fences.length === 0) return;
    // ein 4-m-Stück entlang X: Pfosten + zwei Querstangen + Gitter
    const parts = [];
    for (const px of [-2, 0, 2]) parts.push([new THREE.BoxGeometry(0.1, FENCE.height, 0.1), px, FENCE.height / 2, 0, 1, 1, 1]);
    parts.push([new THREE.BoxGeometry(4, 0.08, 0.06), 0, FENCE.height - 0.1, 0, 1, 1, 1]);
    parts.push([new THREE.BoxGeometry(4, 0.08, 0.06), 0, 0.25, 0, 1, 1, 1]);
    for (let i = 0; i < 9; i++) parts.push([new THREE.BoxGeometry(0.035, FENCE.height - 0.3, 0.035), -1.8 + i * 0.45, FENCE.height / 2, 0, 1, 1, 1]);
    const geo = mergeSimple(parts);
    const mesh = instanced(geo, new THREE.MeshLambertMaterial({ color: cfg.colors.fence }), fences.length, 'Zäune');
    fences.forEach((f, i) => {
      _e.set(0, f.alongX ? 0 : Math.PI / 2, 0);
      _q.setFromEuler(_e);
      _s.set(f.length / 4, 1, 1);
      _m.compose(f.position, _q, _s);
      place(f, mesh, i, _m);
    });
    finalize(mesh);
  }

  return set;
}

/**
 * Fügt einfache Formen zu EINER zusammen.
 * parts: [geometry, x, y, z, sx, sy, sz, color?] – mit withColors bekommen die Ecken die Farbe.
 * Die Einzel-Formen werden danach entsorgt.
 */
export function mergeSimple(parts, withColors = false) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let offset = 0;
  const color = new THREE.Color();
  for (const [geometry, x, y, z, sx = 1, sy = 1, sz = 1, c] of parts) {
    const g = geometry.index ? geometry : geometry;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    if (withColors) color.set(c ?? '#FFFFFF');
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i) * sx + x, pos.getY(i) * sy + y, pos.getZ(i) * sz + z);
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      if (withColors) colors.push(color.r, color.g, color.b);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(offset + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(offset + i);
    offset += pos.count;
    geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (withColors) merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  merged.setIndex(indices);
  merged.computeBoundingSphere();
  return merged;
}
