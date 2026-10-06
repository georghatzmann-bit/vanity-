// =============================================================================
// Absprung-Fahrzeug: bunter Heißluftballon mit großer Holz-Plattform
// =============================================================================
// Fliegt in gerader Linie über die Insel (map.jumpPath) in der Höhe und mit dem
// Tempo aus CONFIG.modes.battleRoyale (jumpVehicleHeight, jumpVehicleSpeed).
// Alle Figuren stehen auf der Plattform (moveState 'vehicle', skydive.js) und
// fahren mit; die Kamera folgt ganz normal. Leertaste = abspringen – erst, wenn
// die Plattform über der Insel ist (canDrop). Wer am Ende noch drauf ist, wird
// über dem Inselrand abgesetzt (dropAll).
//
//   const vehicle = createJumpVehicle(game, { path: map.jumpPath(game.rng) });
//   game.systems.push(vehicle);           // update + frameUpdate
//   for (const c of game.characters) vehicle.board(c);
//   vehicle.scheduleBotDrops(game.rng);   // Bots springen verteilt ab (optional)
// Das System bleibt bis zum Ende des Modus in game.systems (es zeichnet auch die
// Gleiter, solange jemand in der Luft ist) und wird mit dispose() abgeräumt.
// Ereignisse: 'vehicleDrop' { character, vehicle } beim Abspringen.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { startFreefall, createSkydiveView } from './skydive.js';

const _v = new THREE.Vector3();

/**
 * @param {object} game
 * @param {object} spec  { path: { start, end } (THREE.Vector3), speed?, dropZone?(x, z) → bool }
 */
export function createJumpVehicle(game, spec) {
  const br = CONFIG.modes.battleRoyale;
  const sd = CONFIG.skydive;
  const speed = spec.speed ?? br.jumpVehicleSpeed;
  const start = new THREE.Vector3().copy(spec.path.start);
  const end = new THREE.Vector3().copy(spec.path.end);
  const length = start.distanceTo(end);
  const dir = new THREE.Vector3().subVectors(end, start).normalize();
  const riders = [];
  const seats = new Map(); // Figur → Platz-Nummer
  const dropTimes = new Map(); // Figur → Spielzeit (geplanter Absprung für Bots)
  const map = game.map;
  const dropZone = spec.dropZone ?? ((x, z) => (map?.contains ? map.contains(x, z, sd.dropMargin + (CONFIG.maps.island.barrierMargin ?? 0)) : true));
  let lastStepTick = -1;
  let entered = false; // war schon über der Insel
  let view = null;

  const vehicle = {
    position: start.clone(),
    prevPosition: start.clone(),
    velocity: dir.clone().multiplyScalar(speed),
    dir,
    distance: 0, // geflogene Strecke (m)
    length,
    riders,
    finished: false, // Ende der Flug-Linie erreicht
    disposed: false,

    /** Anteil der Strecke 0..1 */
    get progress() {
      return length > 0 ? vehicle.distance / length : 1;
    },

    /** Figur einsteigen lassen (steht dann auf der Plattform). */
    board(c) {
      if (riders.includes(c) || !c.alive) return;
      riders.push(c);
      seats.set(c, seats.size);
      c.ridingVehicle = vehicle;
      c.moveState = 'vehicle';
      c.grounded = true;
      c.velocity.copy(vehicle.velocity);
      vehicle.seatPosition(c, c.position);
      c.prevPosition.copy(c.position);
      c.yaw = c.prevYaw = Math.atan2(-dir.x, -dir.z); // Blick in Flug-Richtung
      if (c.command) c.command.yaw = c.yaw;
      c.airPeakY = c.position.y;
    },

    /** Platz auf der Plattform (Raster, Mitte = Fahrzeug). */
    seatPosition(c, out = new THREE.Vector3()) {
      const index = seats.get(c) ?? 0;
      const cols = Math.max(1, Math.floor(sd.deckSize / sd.riderSpacing) - 1);
      const col = index % cols;
      const row = Math.floor(index / cols);
      const ox = (col - (cols - 1) / 2) * sd.riderSpacing;
      const oz = (row - (cols - 1) / 2) * sd.riderSpacing;
      return out.set(vehicle.position.x + ox, vehicle.position.y, vehicle.position.z + oz);
    },

    /** Darf man gerade abspringen? (Plattform über der Insel) */
    canDrop() {
      return dropZone(vehicle.position.x, vehicle.position.z);
    },

    /** Abspringen: Figur fällt frei (mit etwas Tempo des Fahrzeugs). */
    drop(c) {
      const i = riders.indexOf(c);
      if (i < 0) return false;
      riders.splice(i, 1);
      dropTimes.delete(c);
      c.ridingVehicle = null;
      // unter der Plattform starten (nicht im Holz)
      c.position.y = vehicle.position.y - 1.2;
      c.prevPosition.copy(c.position);
      startFreefall(c, _v.copy(vehicle.velocity).multiplyScalar(sd.exitSpeedFactor));
      game.events?.emit('vehicleDrop', { character: c, vehicle });
      return true;
    },

    /** Alle absetzen (Ende der Strecke). */
    dropAll() {
      for (const c of [...riders]) vehicle.drop(c);
    },

    /** Bots springen zu zufälligen Zeiten über der Insel ab. */
    scheduleBotDrops(rng = game.rng ?? Math.random) {
      // Zeit-Fenster: wann ist die Plattform über der Insel?
      let first = -1;
      let last = -1;
      for (let d = 0; d <= length; d += 5) {
        _v.copy(start).addScaledVector(dir, d);
        if (dropZone(_v.x, _v.z)) {
          if (first < 0) first = d;
          last = d;
        }
      }
      if (first < 0) return;
      for (const c of riders) {
        if (!c.isBot) continue;
        const d = first + (last - first) * (0.05 + 0.9 * rng());
        dropTimes.set(c, (game.time ?? 0) + (d - vehicle.distance) / speed);
      }
    },

    /** Einmal pro Tick weiter fliegen (Mitfahrer rufen das in ihrer Bewegung auf). */
    stepOnce() {
      const tick = game.tick ?? 0;
      if (tick === lastStepTick) return;
      lastStepTick = tick;
      advance(1 / CONFIG.loop.tickRate);
    },

    update() {
      vehicle.stepOnce();
      // geplante Absprünge der Bots (rückwärts: drop() nimmt die Figur aus der Liste)
      const time = game.time ?? 0;
      if (dropTimes.size > 0 && vehicle.canDrop()) {
        for (let i = riders.length - 1; i >= 0; i--) {
          const c = riders[i];
          const at = dropTimes.get(c);
          if (at !== undefined && time >= at) vehicle.drop(c);
        }
      }
      // Besiegte/entfernte Mitfahrer los lassen
      for (let i = riders.length - 1; i >= 0; i--) {
        const c = riders[i];
        if (!c.alive || !game.characters?.includes(c)) {
          riders.splice(i, 1);
          dropTimes.delete(c);
          c.ridingVehicle = null;
        }
      }
    },

    frameUpdate(dt, alpha = 1) {
      view?.frameUpdate(dt, alpha);
    },

    dispose() {
      vehicle.disposed = true;
      for (const c of riders) c.ridingVehicle = null;
      riders.length = 0;
      view?.dispose();
      view = null;
    },
  };

  function advance(dt) {
    vehicle.prevPosition.copy(vehicle.position);
    if (vehicle.finished) return;
    vehicle.distance = Math.min(length, vehicle.distance + speed * dt);
    vehicle.position.copy(start).addScaledVector(dir, vehicle.distance);
    const over = vehicle.canDrop();
    if (over) entered = true;
    // nach der Insel (oder am Ende der Strecke): alle absetzen
    if ((entered && !over) || vehicle.distance >= length) {
      // einen Schritt zurück: noch über der Insel absetzen
      if (entered && !over) vehicle.position.addScaledVector(dir, -speed * dt);
      vehicle.dropAll();
      if (vehicle.distance >= length) vehicle.finished = true;
    }
  }

  if (!game.headless && game.root && typeof document !== 'undefined') view = createVehicleView(game, vehicle);
  return vehicle;
}

// =============================================================================
// Grafik
// =============================================================================
function createVehicleView(game, vehicle) {
  const sd = CONFIG.skydive;
  const group = new THREE.Group();
  group.name = 'Absprung-Ballon';
  game.root.add(group);
  const skydiveView = createSkydiveView(game);

  // Ballon: Tropfen-Form (Drehkörper) mit bunten Längs-Streifen
  const R = sd.balloonRadius;
  const profile = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16; // 0 unten → 1 oben
    const a = -Math.PI / 2 + t * Math.PI; // -90° … +90°
    const bulge = Math.cos(a);
    // unten spitz zulaufend (Tropfen), oben rund
    const r = t < 0.5 ? R * (0.22 + 0.78 * Math.pow(Math.sin(t * Math.PI), 1.25)) : R * bulge;
    profile.push(new THREE.Vector2(Math.max(0.01, r), R * 1.1 * Math.sin(a) + R * 1.1));
  }
  const lathe = new THREE.LatheGeometry(profile, 24);
  const balloon = lathe.toNonIndexed();
  lathe.dispose();
  const colors = sd.balloonColors.map((c) => new THREE.Color(c));
  const pos = balloon.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const segment = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 12) % colors.length;
    const c = colors[segment];
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
  }
  balloon.setAttribute('color', new THREE.BufferAttribute(col, 3));
  balloon.computeVertexNormals();
  const balloonLift = 9; // Unterkante des Ballons über der Plattform (m)
  balloon.translate(0, balloonLift, 0);
  const balloonMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const balloonMesh = new THREE.Mesh(balloon, balloonMaterial);
  balloonMesh.castShadow = false; // sonst liegt die Plattform im dunklen Schatten
  group.add(balloonMesh);

  // Plattform + Geländer + Seile + Brenner (ein Mesh mit Ecken-Farben)
  const parts = [];
  const half = sd.deckSize / 2;
  const deck = sd.deckColor;
  const add = (w, h, d, x, y, z, color, rx = 0, rz = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    const ni = g.toNonIndexed();
    g.dispose();
    const c = new THREE.Color(color);
    const arr = new Float32Array(ni.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
    ni.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(ni);
  };
  add(sd.deckSize, 0.35, sd.deckSize, 0, -0.175, 0, deck);
  add(sd.deckSize * 0.92, 0.5, sd.deckSize * 0.92, 0, -0.6, 0, '#8E5B33');
  for (const s of [-1, 1]) {
    add(sd.deckSize, 0.12, 0.12, 0, 1.0, s * half, '#7A4A28');
    add(0.12, 0.12, sd.deckSize, s * half, 1.0, 0, '#7A4A28');
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(0.14, 1.0, 0.14, sx * half, 0.5, sz * half, '#7A4A28');
      // Seil von der Ecke zum Ballon-Hals
      const topX = sx * R * 0.2;
      const topZ = sz * R * 0.2;
      const len = Math.hypot(half - Math.abs(topX), balloonLift - 1, half - Math.abs(topZ));
      const g = new THREE.CylinderGeometry(0.04, 0.04, len, 5);
      const from = new THREE.Vector3(sx * half, 1, sz * half);
      const to = new THREE.Vector3(topX, balloonLift + 0.6, topZ);
      const mid = from.clone().add(to).multiplyScalar(0.5);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      g.applyQuaternion(q);
      g.translate(mid.x, mid.y, mid.z);
      const ni = g.toNonIndexed();
      g.dispose();
      const arr = new Float32Array(ni.attributes.position.count * 3).fill(0.85);
      ni.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(ni);
    }
  }
  add(1.0, 0.5, 1.0, 0, balloonLift - 0.2, 0, '#55606E'); // Brenner
  // Fähnchen an den Ecken
  sd.balloonColors.slice(0, 4).forEach((c, i) => {
    const sx = i % 2 ? 1 : -1;
    const sz = i < 2 ? 1 : -1;
    add(0.05, 1.4, 0.05, sx * half, 1.7, sz * half, '#EEEEEE');
    add(0.03, 0.4, 0.6, sx * half, 2.2, sz * half + 0.3 * sz, c);
  });
  const deckGeometry = mergeColored(parts);
  for (const p of parts) p.dispose();
  const deckMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const deckMesh = new THREE.Mesh(deckGeometry, deckMaterial);
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  // Flamme (flackert)
  const flameMaterial = new THREE.MeshBasicMaterial({ color: '#FFB347', transparent: true, opacity: 0.9 });
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.4, 8), flameMaterial);
  flame.position.set(0, balloonLift + 0.6, 0);
  group.add(flame);

  let time = 0;
  return {
    frameUpdate(dt, alpha) {
      time += dt;
      const a = vehicle.prevPosition;
      const b = vehicle.position;
      group.position.set(a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha, a.z + (b.z - a.z) * alpha);
      group.rotation.y = Math.atan2(-vehicle.dir.x, -vehicle.dir.z);
      balloonMesh.rotation.y = time * 0.05;
      flame.scale.set(1, 0.8 + 0.4 * Math.abs(Math.sin(time * 9)), 1);
      // weit weg (am Ende) ausblenden
      group.visible = !vehicle.finished || vehicle.riders.length > 0;
      skydiveView.frameUpdate(dt, alpha);
    },
    dispose() {
      group.parent?.remove(group);
      balloon.dispose();
      balloonMaterial.dispose();
      deckGeometry.dispose();
      deckMaterial.dispose();
      flame.geometry.dispose();
      flameMaterial.dispose();
      skydiveView.dispose();
    },
  };
}

function mergeColored(list) {
  let count = 0;
  for (const g of list) count += g.attributes.position.count;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  let offset = 0;
  for (const g of list) {
    position.set(g.attributes.position.array, offset * 3);
    normal.set(g.attributes.normal.array, offset * 3);
    color.set(g.attributes.color.array, offset * 3);
    offset += g.attributes.position.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
