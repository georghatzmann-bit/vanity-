// =============================================================================
// Absprung: freier Fall, Gleiter, Mitfahren im Absprung-Fahrzeug
// =============================================================================
// Drei eigene Bewegungs-Arten (player.js: registerMoveStateHandler):
//   'vehicle'  – steht im Absprung-Fahrzeug (jumpVehicle.js) und fährt mit.
//                Leertaste = abspringen (wenn das Fahrzeug über der Insel ist).
//   'freefall' – freier Fall: CONFIG.modes.battleRoyale.freefallSpeed, lenken mit
//                WASD (freefallMoveSpeed). Blick nach unten + W = Sturzflug (schneller,
//                bis CONFIG.skydive.diveSpeed). Der Gleiter öffnet sich von selbst
//                gliderDeployHeight über dem Boden – oder früher mit der Leertaste.
//   'glide'    – Gleiter: langsames Sinken (gliderFallSpeed), lenken (gliderMoveSpeed).
// Landen: landCharacter(c, { noDamage: true }) – nie Fallschaden.
// In diesen Zuständen wird nicht geschossen, gebaut oder geheilt (Befehl wird geleert).
//
// Grafik (createSkydiveView, nur mit Bildschirm): Gleiter-Schirm über der Figur
// (klappt auf), Figur liegt im freien Fall waagerecht, Fahrtwind-Striche um die
// Kamera beim Spieler.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { registerMoveStateHandler, landCharacter, bodyFits, findSupport } from '../player.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Logik
// ---------------------------------------------------------------------------

// Im Absprung keine Aktionen (schießen, bauen, heilen, zielen, Edit, E)
function clearActions(ch, cmd) {
  cmd.primary = false;
  cmd.primaryPressed = false;
  cmd.secondary = false;
  cmd.secondaryPressed = false;
  cmd.reloadOrRotate = false;
  cmd.editPressed = false;
  cmd.usePressed = false;
  cmd.emotePressed = false;
  ch.aiming = false;
  if (ch.mode === 'build' || ch.mode === 'edit') ch.mode = ch.lastCombatMode === 'pickaxe' ? 'pickaxe' : 'weapon';
  ch.crouching = false;
  ch.height = CONFIG.player.hitbox.height;
}

/** Höhe der Füße über dem Boden darunter (Gelände, Dächer, Bauteile). */
export function heightAboveGround(ch, world) {
  const below = world.surfaceHeight(ch.position.x, ch.position.z, ch.position.y + 0.01);
  return Number.isFinite(below) ? ch.position.y - below : Infinity;
}

function steer(ch, cmd, dt, speed, accel, fallSpeed) {
  let mx = cmd.moveX || 0;
  let mz = cmd.moveZ || 0;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  const sin = Math.sin(ch.yaw);
  const cos = Math.cos(ch.yaw);
  const wishX = (cos * mx - sin * mz) * speed;
  const wishZ = (-sin * mx - cos * mz) * speed;
  const maxDv = accel * dt;
  let ddx = wishX - ch.velocity.x;
  let ddz = wishZ - ch.velocity.z;
  const dl = Math.hypot(ddx, ddz);
  if (dl > maxDv) {
    ddx *= maxDv / dl;
    ddz *= maxDv / dl;
  }
  ch.velocity.x += ddx;
  ch.velocity.z += ddz;
  const targetY = -fallSpeed;
  const dvy = targetY - ch.velocity.y;
  ch.velocity.y += Math.sign(dvy) * Math.min(Math.abs(dvy), accel * 1.5 * dt);
}

// Bewegen mit einfacher Kollision: waagerecht nur, wo der Körper hinpasst; senkrecht landen
function moveAndLand(ch, dt, world) {
  const r = ch.radius;
  const h = ch.height;
  const p = ch.position;
  // waagerecht (getrennt nach Achsen, damit man an Wänden entlang rutscht)
  const nx = p.x + ch.velocity.x * dt;
  if (bodyFits(world, nx, p.y, p.z, r, h)) p.x = nx;
  else ch.velocity.x = 0;
  const nz = p.z + ch.velocity.z * dt;
  if (bodyFits(world, p.x, p.y, nz, r, h)) p.z = nz;
  else ch.velocity.z = 0;
  // Spielfeld-Grenze (unsichtbare Wand) der Karte
  const bounds = ch.game?.map?.playBounds;
  if (bounds) {
    p.x = Math.min(bounds.maxX - r, Math.max(bounds.minX + r, p.x));
    p.z = Math.min(bounds.maxZ - r, Math.max(bounds.minZ + r, p.z));
  }
  // senkrecht
  const ny = p.y + ch.velocity.y * dt;
  const support = findSupport(world, p.x, p.y, p.z, r, ny);
  if (support > -Infinity && ny <= support + 1e-4) {
    p.y = support;
    ch.airPeakY = support; // kein Fallschaden
    ch.velocity.x *= 0.3;
    ch.velocity.z *= 0.3;
    landCharacter(ch, { noDamage: true });
    return true;
  }
  p.y = ny;
  ch.airPeakY = p.y;
  return false;
}

function freefallHandler(ch, cmd, dt, world) {
  const br = CONFIG.modes.battleRoyale;
  const sd = CONFIG.skydive;
  clearActions(ch, cmd);
  ch.grounded = false;
  // Sturzflug: nach unten schauen und W
  const forward = Math.max(0, cmd.moveZ || 0);
  const dive = Math.min(1, Math.max(0, -ch.pitch / (sd.diveFullPitch * DEG))) * forward;
  const fall = br.freefallSpeed + (sd.diveSpeed - br.freefallSpeed) * dive;
  steer(ch, cmd, dt, br.freefallMoveSpeed * (1 - 0.55 * dive), sd.freefallAcceleration, fall);
  if (moveAndLand(ch, dt, world)) return;
  // Gleiter: von selbst ab gliderDeployHeight über dem Boden, sonst mit Leertaste
  if (cmd.jumpPressed || heightAboveGround(ch, world) <= br.gliderDeployHeight) deployGlider(ch);
}

function glideHandler(ch, cmd, dt, world) {
  const br = CONFIG.modes.battleRoyale;
  clearActions(ch, cmd);
  ch.grounded = false;
  steer(ch, cmd, dt, br.gliderMoveSpeed, CONFIG.skydive.gliderAcceleration, br.gliderFallSpeed);
  moveAndLand(ch, dt, world);
}

function vehicleHandler(ch, cmd, dt) {
  clearActions(ch, cmd);
  const vehicle = ch.ridingVehicle;
  if (!vehicle || vehicle.disposed) {
    startFreefall(ch);
    return;
  }
  vehicle.stepOnce(); // Fahrzeug einmal pro Tick weiter (vor den Mitfahrern)
  vehicle.seatPosition(ch, ch.position);
  ch.velocity.copy(vehicle.velocity);
  ch.grounded = true; // steht auf der Plattform (Grafik: kein "Fallen")
  ch.airPeakY = ch.position.y;
  if (cmd.jumpPressed && vehicle.canDrop()) vehicle.drop(ch);
}

/** Figur in den freien Fall schicken (z. B. aus dem Fahrzeug oder in Tests). */
export function startFreefall(ch, velocity = null) {
  ch.moveState = 'freefall';
  ch.grounded = false;
  ch.ridingVehicle = null;
  ch.gliderTime = -1;
  ch.airPeakY = ch.position.y;
  if (velocity) ch.velocity.copy(velocity);
  ch.game?.events?.emit('skydive', { character: ch, state: 'freefall' });
}

/** Gleiter öffnen. */
export function deployGlider(ch) {
  if (ch.moveState !== 'freefall') return;
  ch.moveState = 'glide';
  ch.gliderTime = ch.time;
  ch.game?.events?.emit('skydive', { character: ch, state: 'glide' });
}

let installed = false;
/** Meldet die Bewegungs-Arten an (einmal; passiert beim Laden dieser Datei). */
export function installSkydive() {
  if (installed) return;
  installed = true;
  registerMoveStateHandler('freefall', freefallHandler);
  registerMoveStateHandler('glide', glideHandler);
  registerMoveStateHandler('vehicle', vehicleHandler);
}
installSkydive();

// ---------------------------------------------------------------------------
// Grafik
// ---------------------------------------------------------------------------

/**
 * Gleiter-Schirme, Freifall-Haltung, Fahrtwind. frameUpdate nach den Figuren aufrufen
 * (game.systems[i].frameUpdate läuft nach den Figuren).
 * @returns {{ frameUpdate(dt), dispose() }}
 */
export function createSkydiveView(game) {
  const sd = CONFIG.skydive;
  const gliderGeometry = createGliderGeometry(sd);
  const gliderMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const gliders = new Map(); // Figur → Mesh

  // Fahrtwind: Striche um die Kamera (nur Spieler im freien Fall)
  const streakCount = sd.windStreaks;
  const streakPositions = new Float32Array(streakCount * 6);
  const streakGeometry = new THREE.BufferGeometry();
  streakGeometry.setAttribute('position', new THREE.BufferAttribute(streakPositions, 3));
  const streakMaterial = new THREE.LineBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0.55, depthWrite: false, fog: false });
  const streaks = new THREE.LineSegments(streakGeometry, streakMaterial);
  streaks.name = 'Fahrtwind';
  streaks.frustumCulled = false;
  streaks.visible = false;
  game.root.add(streaks);
  const streakSeeds = [];
  for (let i = 0; i < streakCount; i++) streakSeeds.push({ a: (i / streakCount) * Math.PI * 2 + i * 0.7, r: 1.2 + (i % 3) * 0.6, o: (i * 0.37) % 1 });
  let time = 0;
  const _cam = new THREE.Vector3();

  function gliderFor(c) {
    let mesh = gliders.get(c);
    if (!mesh) {
      mesh = new THREE.Mesh(gliderGeometry, gliderMaterial);
      mesh.name = 'Gleiter';
      mesh.castShadow = true;
      gliders.set(c, mesh);
    }
    return mesh;
  }

  return {
    frameUpdate(dt) {
      time += dt;
      for (const c of game.characters) {
        const view = c.view;
        const state = c.alive ? c.moveState : 'ground';
        const glider = gliders.get(c);
        if (!view) continue;
        const body = view.root.children[0]; // "fall"-Gruppe der Figur (kippt)
        if (state === 'glide') {
          const g = gliderFor(c);
          if (g.parent !== view.root) view.root.add(g);
          const open = Math.min(1, Math.max(0.05, (c.time - (c.gliderTime ?? 0)) / sd.gliderDeployTime));
          g.scale.set(open, 0.4 + 0.6 * open, open);
          g.position.set(0, 1.45 + 1.75 * (0.4 + 0.6 * open), 0);
          g.rotation.z = Math.sin(time * 1.7) * 0.04;
          if (body) {
            body.rotation.x = -0.15;
            body.position.z = 0;
          }
        } else {
          if (glider && glider.parent) glider.parent.remove(glider);
          if (state === 'freefall' && body) {
            // waagerecht, Kopf voraus (um die Körpermitte gedreht)
            const tilt = -1.25 + Math.sin(time * 3) * 0.05;
            body.rotation.x = tilt;
            body.position.set(0, 0.9 - 0.9 * Math.cos(tilt), -0.9 * Math.sin(tilt));
          } else if (body && body.position.z !== 0) {
            body.position.z = 0; // nach dem Landen wieder normal (y setzt die Figur selbst)
          }
        }
      }
      // Fahrtwind beim Spieler
      const p = game.player;
      const camera = game.camera;
      const show = !!(p && camera && p.alive && p.moveState === 'freefall');
      streaks.visible = show;
      if (show) {
        camera.getWorldPosition(_cam);
        const speed = Math.max(10, -p.velocity.y);
        for (let i = 0; i < streakCount; i++) {
          const s = streakSeeds[i];
          const phase = (s.o + time * speed * 0.06) % 1;
          const x = _cam.x + Math.cos(s.a + time * 0.3) * s.r;
          const z = _cam.z + Math.sin(s.a + time * 0.3) * s.r;
          const y = _cam.y - 4 + phase * 8;
          const k = i * 6;
          streakPositions[k] = x;
          streakPositions[k + 1] = y;
          streakPositions[k + 2] = z;
          streakPositions[k + 3] = x;
          streakPositions[k + 4] = y + 1.6;
          streakPositions[k + 5] = z;
        }
        streakGeometry.attributes.position.needsUpdate = true;
      }
    },
    dispose() {
      for (const g of gliders.values()) g.parent?.remove(g);
      gliders.clear();
      gliderGeometry.dispose();
      gliderMaterial.dispose();
      streaks.parent?.remove(streaks);
      streakGeometry.dispose();
      streakMaterial.dispose();
    },
  };
}

// Gleiter: gewölbter Schirm (Teil eines Zylinders, Achse von vorn nach hinten) mit
// Streifen + zwei Leinen zu den Schultern. Ursprung = Scheitel des Schirms.
function createGliderGeometry(sd) {
  const width = sd.gliderWidth;
  const radius = width * 0.6;
  const half = Math.PI * 0.32;
  const canopy = new THREE.CylinderGeometry(radius, radius, 1.2, 18, 1, true, -half, half * 2);
  canopy.rotateX(-Math.PI / 2); // Bogen oben, Achse entlang Z
  canopy.translate(0, -radius, 0); // Scheitel bei y = 0
  const colors = sd.gliderColors.map((c) => new THREE.Color(c));
  const nonIndexed = canopy.toNonIndexed();
  canopy.dispose();
  const pos = nonIndexed.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const span = radius * Math.sin(half);
  for (let i = 0; i < pos.count; i += 3) {
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const stripe = Math.min(5, Math.max(0, Math.floor(((x / span) * 0.5 + 0.5) * 6))) % colors.length;
    const c = colors[stripe];
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
  }
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Leinen: vom Schirm-Ende zur Schulter (Schulter 1,75 m unter dem Scheitel)
  const endX = span;
  const endY = -radius * (1 - Math.cos(half));
  const parts = [nonIndexed];
  for (const side of [-1, 1]) {
    const ax = side * endX * 0.92;
    const bx = side * 0.28;
    const by = -1.75;
    const len = Math.hypot(ax - bx, endY - by);
    const angle = Math.atan2(ax - bx, endY - by);
    const line = new THREE.BoxGeometry(0.035, len, 0.035).toNonIndexed();
    line.rotateZ(-angle);
    line.translate((ax + bx) / 2, (endY + by) / 2, 0);
    const lc = new Float32Array(line.attributes.position.count * 3).fill(0.25);
    line.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    parts.push(line);
  }
  const merged = mergeNonIndexed(parts);
  for (const p of parts) p.dispose();
  return merged;
}

function mergeNonIndexed(list) {
  let count = 0;
  for (const g of list) count += g.attributes.position.count;
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  let offset = 0;
  for (const g of list) {
    position.set(g.attributes.position.array, offset * 3);
    color.set(g.attributes.color.array, offset * 3);
    offset += g.attributes.position.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.computeVertexNormals();
  return geometry;
}
