// =============================================================================
// Figuren-Grafik: runde Comic-Figur aus einfachen Formen
// =============================================================================
// Kapsel-Körper, Kugel-Kopf mit großen Augen, Arme und Beine aus Kapseln
// (mit Knie und Ellbogen), Rucksack, Schuhe und ein Hut je nach "Skin".
// Farben kommen aus character.skin (Farbsets in config.js → skins).
//
// Animation per Code (keine Dateien):
//   - Laufen: Arme und Beine schwingen, je schneller desto weiter
//   - Springen/Fallen: Beine angezogen, Arme hoch
//   - Ducken: Knie gebeugt, Oberkörper nach vorn
//   - Stehen: leichtes "Atmen"
//   - Zielen/Waffe: Arme nach vorn (Waffe kommt an die rechte Hand: attach())
//   - Arm-Schwung (Bauen/Schlagen): character.triggerAction('build')
//   - Tanz (Taste B): character.emoteUntil
//
// update(alpha, dt) setzt die Figur weich zwischen zwei Logik-Schritten
// (prevPosition → position). Die Figur schaut nach −Z (wie yaw = 0).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { lerpAngle } from '../camera.js';

const P = CONFIG.player;
const HALF_PI = Math.PI / 2;

// --- Maße (Meter, ab den Füßen) -------------------------------------------------
const HIP_Y = 0.85;
const THIGH = 0.42;
const SHIN = 0.38;
const SHOULDER_Y = 0.5; // über der Hüfte
const SHOULDER_X = 0.35;
const UPPER_ARM = 0.3;
// Kopf: genau die Treffer-Kugel aus CONFIG.player.hitbox (Oberkante = Kapsel-Oberkante 1,8 m)
const HEAD_R = P.hitbox.headRadius;
const HEAD_Y = P.hitbox.height - HEAD_R - HIP_Y; // Kopf-Mitte über der Hüfte (= 1,53 m über den Füßen)
// Ducken: Oberkörper neigt sich vor und die Hüfte sinkt so weit, dass die Kopf-Kugel genau dort
// sitzt, wo die Treffer-Prüfung sie erwartet (Oberkante = geduckte Kapsel 1,3 m, crouchHeadForward vor)
const CROUCH_LEAN = Math.asin(Math.min(0.9, P.hitbox.crouchHeadForward / HEAD_Y));
const CROUCH_DROP = HIP_Y - (P.hitbox.crouchHeight - HEAD_R - HEAD_Y * Math.cos(CROUCH_LEAN));
const FOOT_DROP = HIP_Y - THIGH - SHIN; // Schuh unter dem Knöchel
const CROUCH_FOOT_FORWARD = 0.12; // geduckt steht der Fuß etwas vor der Hüfte
// Bein-Winkel dafür (zwei Glieder: Oberschenkel, Unterschenkel – Kosinus-Satz)
const [CROUCH_THIGH, CROUCH_KNEE] = (() => {
  const down = HIP_Y - CROUCH_DROP - FOOT_DROP;
  const dist = Math.min(THIGH + SHIN - 1e-3, Math.hypot(CROUCH_FOOT_FORWARD, down));
  const toFoot = Math.atan2(CROUCH_FOOT_FORWARD, down);
  const atHip = Math.acos((THIGH * THIGH + dist * dist - SHIN * SHIN) / (2 * THIGH * dist));
  const atKnee = Math.acos((THIGH * THIGH + SHIN * SHIN - dist * dist) / (2 * THIGH * SHIN));
  return [toFoot + atHip, -(Math.PI - atKnee)];
})();
const STRIDE = 1.7; // Meter pro Schritt-Zyklus (zwei Schritte)

// Gemeinsame Formen (einmal angelegt, von allen Figuren benutzt, nie entsorgt)
let shared = null;
function sharedGeometries() {
  if (shared) return shared;
  const g = (geometry) => {
    geometry.userData.shared = true;
    return geometry;
  };
  shared = {
    torso: g(new THREE.CapsuleGeometry(0.28, 0.18, 6, 16)),
    belt: g(new THREE.TorusGeometry(0.275, 0.045, 6, 20)),
    backpack: g(new THREE.CapsuleGeometry(0.17, 0.14, 6, 14)),
    backpackPocket: g(new THREE.SphereGeometry(0.11, 12, 8)),
    head: g(new THREE.SphereGeometry(HEAD_R, 20, 14)),
    eye: g(new THREE.SphereGeometry(0.065, 10, 8)),
    pupil: g(new THREE.SphereGeometry(0.034, 8, 6)),
    mouth: g(new THREE.TorusGeometry(0.06, 0.014, 4, 10, Math.PI)),
    thigh: g(new THREE.CapsuleGeometry(0.1, THIGH - 0.2, 4, 10)),
    shin: g(new THREE.CapsuleGeometry(0.088, SHIN - 0.17, 4, 10)),
    shoe: g(new THREE.CapsuleGeometry(0.075, 0.14, 4, 8)),
    upperArm: g(new THREE.CapsuleGeometry(0.08, UPPER_ARM - 0.16, 4, 10)),
    forearm: g(new THREE.CapsuleGeometry(0.072, 0.15, 4, 10)),
    hand: g(new THREE.SphereGeometry(0.09, 10, 8)),
    // Hüte
    dome: g(new THREE.SphereGeometry(0.29, 18, 10, 0, Math.PI * 2, 0, HALF_PI)),
    // halbe Scheibe nach vorn (−Z): Winkel π/2 … 3π/2
    brim: g(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 16, 1, false, HALF_PI, Math.PI)),
    pompom: g(new THREE.SphereGeometry(0.07, 10, 8)),
    band: g(new THREE.TorusGeometry(0.28, 0.045, 6, 20)),
    cone: g(new THREE.ConeGeometry(0.17, 0.42, 16)),
    topHat: g(new THREE.CylinderGeometry(0.18, 0.19, 0.32, 18)),
    topBrim: g(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 20)),
    topBand: g(new THREE.CylinderGeometry(0.192, 0.192, 0.06, 18, 1, true)),
    crownRing: g(new THREE.CylinderGeometry(0.2, 0.21, 0.13, 18, 1, true)),
    crownSpike: g(new THREE.ConeGeometry(0.05, 0.13, 6)),
    helmet: g(new THREE.SphereGeometry(0.31, 18, 10, 0, Math.PI * 2, 0, HALF_PI * 1.05)),
    helmetStripe: g(new THREE.TorusGeometry(0.312, 0.035, 6, 20, Math.PI)),
    headband: g(new THREE.TorusGeometry(0.275, 0.04, 6, 22)),
    tail: g(new THREE.BoxGeometry(0.05, 0.16, 0.03)),
  };
  return shared;
}

/**
 * Baut die Grafik für eine Figur und hängt sie in die Szene.
 * @param {Character} character
 * @param {THREE.Object3D} scene  (oder eine Gruppe in der Szene)
 */
export function createCharacterView(character, scene) {
  const G = sharedGeometries();
  const skin = character.skin ?? CONFIG.skins.list[0];
  const materials = [];
  const mat = (color) => {
    const m = new THREE.MeshLambertMaterial({ color });
    materials.push(m);
    return m;
  };
  const mBody = mat(skin.body);
  const mAccent = mat(skin.accent);
  const mSkin = mat(skin.skinTone ?? '#F2C9A0');
  const mShoe = mat('#2D2F3A');
  const mHat = mat(skin.hatColor ?? skin.accent);
  const mWhite = mat('#FFFFFF');
  const mBlack = mat('#1B1B24');

  const mesh = (geometry, material, parent, x = 0, y = 0, z = 0, shadow = true) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = shadow;
    parent.add(m);
    return m;
  };
  const group = (parent, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  // --- Aufbau ---------------------------------------------------------------------
  const root = new THREE.Group();
  root.name = `Figur ${character.name}`;
  const fall = group(root); // kippt beim Besiegtwerden um
  const hips = group(fall, 0, HIP_Y, 0);
  const upper = group(hips); // Oberkörper (dreht/neigt sich)

  const torso = mesh(G.torso, mBody, upper, 0, 0.23, 0);
  mesh(G.belt, mAccent, upper, 0, 0.02, 0).rotation.x = HALF_PI;
  // Rucksack: rund, mit Tasche in der Hut-Farbe (sieht man von hinten am meisten)
  const pack = mesh(G.backpack, mAccent, upper, 0, 0.3, 0.25);
  pack.scale.set(1.25, 1, 0.62);
  pack.rotation.x = -0.08;
  mesh(G.backpackPocket, mHat, upper, 0, 0.22, 0.36).scale.set(1.1, 0.8, 0.45);

  const head = group(upper, 0, HEAD_Y, 0);
  mesh(G.head, mSkin, head);
  for (const side of [-1, 1]) {
    const eye = mesh(G.eye, mWhite, head, side * 0.095, 0.05, -0.225, false);
    eye.scale.set(1, 1.15, 0.7);
    mesh(G.pupil, mBlack, head, side * 0.095, 0.05, -0.27, false);
  }
  const mouth = mesh(G.mouth, mBlack, head, 0, -0.08, -0.255, false);
  mouth.rotation.set(0, 0, Math.PI); // Bogen nach unten = Lächeln
  addHat(head, skin.hat, mHat, mAccent, mWhite, mesh);

  // Beine (Hüfte → Knie → Fuß)
  const legs = [];
  for (const side of [-1, 1]) {
    const thighPivot = group(hips, side * 0.13, 0, 0);
    mesh(G.thigh, mAccent, thighPivot, 0, -THIGH / 2, 0);
    const knee = group(thighPivot, 0, -THIGH, 0);
    mesh(G.shin, mAccent, knee, 0, -SHIN / 2 + 0.02, 0);
    const shoe = mesh(G.shoe, mShoe, knee, 0, -SHIN + 0.035, -0.05);
    shoe.rotation.x = HALF_PI;
    legs.push({ thigh: thighPivot, knee });
  }

  // Arme (Schulter → Ellbogen → Hand)
  const arms = [];
  let rightHand = null;
  for (const side of [-1, 1]) {
    const shoulder = group(upper, side * SHOULDER_X, SHOULDER_Y, 0);
    mesh(G.upperArm, mBody, shoulder, 0, -UPPER_ARM / 2, 0);
    const elbow = group(shoulder, 0, -UPPER_ARM, 0);
    mesh(G.forearm, mSkin, elbow, 0, -0.13, 0);
    mesh(G.hand, mSkin, elbow, 0, -0.28, 0);
    if (side === 1) {
      rightHand = group(elbow, 0, -0.3, -0.02);
      rightHand.name = 'rechte Hand';
    }
    arms.push({ shoulder, elbow });
  }

  scene.add(root);

  // --- Zustand der Animation ---------------------------------------------------------
  const anim = {
    time: 0,
    walkPhase: 0,
    move: 0, // 0 = steht, 1 = läuft normal
    crouch: 0,
    air: 0,
    hold: 0, // Arme nach vorn (Waffe/Zielen)
    death: 0,
    hidden: false,
  };
  const attachments = new Map();

  const view = {
    root,
    rightHand,
    character,

    /** Gegenstand (z. B. Waffe) an die rechte Hand hängen. Gleicher Name ersetzt. */
    attach(name, object) {
      view.detach(name);
      attachments.set(name, object);
      rightHand.add(object);
      return object;
    },

    /** Gegenstand von der Hand nehmen (wird nicht entsorgt). */
    detach(name) {
      const old = attachments.get(name);
      if (old) {
        rightHand.remove(old);
        attachments.delete(name);
      }
      return old ?? null;
    },

    /** Ausblenden, z. B. wenn die Kamera zu nah an der eigenen Figur ist. */
    setHidden(hidden) {
      anim.hidden = !!hidden;
    },

    /**
     * Jedes Bild aufrufen.
     * @param {number} alpha  0..1 zwischen zwei Logik-Schritten
     * @param {number} dt     Zeit seit dem letzten Bild (s)
     * @param {number} [yawOverride]  Blickrichtung (für den Spieler: die der Kamera)
     */
    update(alpha, dt, yawOverride) {
      const c = character;
      anim.time += dt;
      const t = anim.time;
      const gameTime = c.time;

      // Lage zwischen zwei Logik-Schritten
      const a = c.prevPosition;
      const b = c.position;
      root.position.set(
        a.x + (b.x - a.x) * alpha,
        a.y + (b.y - a.y) * alpha + c.prevStepOffset + (c.stepOffset - c.prevStepOffset) * alpha,
        a.z + (b.z - a.z) * alpha,
      );
      root.rotation.y = yawOverride ?? lerpAngle(c.prevYaw, c.yaw, alpha);

      // Besiegt: umkippen, nach 2,5 s verschwinden
      anim.death = approach(anim.death, c.alive ? 0 : 1, dt * 3);
      const deadFor = gameTime - c.deathTime;
      root.visible = !anim.hidden && (c.alive || deadFor < 2.5);
      if (!root.visible) return;
      fall.rotation.x = easeOut(anim.death) * HALF_PI;
      fall.position.y = easeOut(anim.death) * 0.25;

      // Zustände weich überblenden
      const speed = Math.hypot(c.velocity.x, c.velocity.z);
      anim.move = approach(anim.move, Math.min(1.3, speed / P.walkSpeed), dt * 8);
      anim.crouch = approach(anim.crouch, c.crouching ? 1 : 0, dt * 10);
      anim.air = approach(anim.air, c.grounded || !c.alive ? 0 : 1, dt * 8);
      const holding = c.aiming || (c.mode === 'weapon' && !!c.slots[c.selectedSlot]);
      anim.hold = approach(anim.hold, holding ? 1 : c.mode === 'build' ? 0.5 : 0, dt * 10);
      if (c.grounded) anim.walkPhase += (speed / STRIDE) * Math.PI * 2 * dt;

      const move = anim.move * (1 - anim.air);
      const swing = Math.sin(anim.walkPhase) * 0.8 * Math.min(1, move);
      const crouch = anim.crouch;
      const air = anim.air;
      const dancing = c.alive && gameTime < c.emoteUntil;

      // --- Beine ------------------------------------------------------------------
      const legL = legs[0];
      const legR = legs[1];
      const crouchThigh = CROUCH_THIGH * crouch;
      const crouchKnee = CROUCH_KNEE * crouch;
      legL.thigh.rotation.set(swing + crouchThigh + air * 0.9, 0, 0);
      legR.thigh.rotation.set(-swing + crouchThigh - air * 0.25, 0, 0);
      // Knie beugen sich, wenn das Bein nach hinten schwingt
      legL.knee.rotation.x = Math.min(0, -Math.max(0, -Math.sin(anim.walkPhase)) * 1.1 * Math.min(1, move)) + crouchKnee - air * 1.2;
      legR.knee.rotation.x = Math.min(0, -Math.max(0, Math.sin(anim.walkPhase)) * 1.1 * Math.min(1, move)) + crouchKnee - air * 0.5;

      // Hüfte: tiefer beim Ducken, wippt beim Laufen, "atmet" im Stehen
      const bob = Math.abs(Math.cos(anim.walkPhase)) * 0.05 * Math.min(1, move);
      hips.position.y = HIP_Y - CROUCH_DROP * crouch + bob - 0.06 * air;
      upper.rotation.set(-0.1 * Math.min(1, move) - CROUCH_LEAN * crouch, 0, 0);
      torso.scale.set(1, 1 + Math.sin(t * 2.2) * 0.015 * (1 - Math.min(1, move)), 1);
      head.rotation.set(clamp(c.pitch, -0.7, 0.7) * 0.55, 0, 0);

      // --- Arme ---------------------------------------------------------------------
      const armL = arms[0];
      const armR = arms[1];
      const pitch = clamp(c.pitch, -1.2, 1.2);
      const hold = anim.hold;
      // Grundhaltung: hängen leicht nach außen, schwingen gegen die Beine
      let lx = -swing * 0.9 * (1 - hold);
      let rx = swing * 0.9 * (1 - hold);
      let lz = -0.12 - air * 0.8;
      let rz = 0.12 + air * 0.8;
      let le = 0.25 + 0.35 * Math.min(1, move);
      let re = le;
      // Waffe halten / Zielen: Arme nach vorn, folgen dem Blick
      lx += hold * (1.25 + pitch);
      rx += hold * (1.45 + pitch);
      lz += hold * 0.55;
      le += hold * 0.5;
      re -= hold * 0.15;

      // Arm-Schwung (Bauen/Schlagen)
      const actionAge = gameTime - c.actionTime;
      if (actionAge >= 0 && actionAge < 0.3) {
        const p = actionAge / 0.3;
        rx = 2.4 - p * 2.6 + pitch * 0.5;
        re = 0.3;
      }

      // Tanz
      if (dancing) {
        const beat = t * 7;
        upper.rotation.y = Math.sin(beat * 0.5) * 0.45;
        hips.position.y += Math.abs(Math.sin(beat)) * 0.07;
        lz = -2.5 - Math.sin(beat) * 0.4;
        rz = 2.5 + Math.cos(beat) * 0.4;
        lx = 0.2;
        rx = 0.2;
        le = 0.4 + Math.sin(beat) * 0.3;
        re = 0.4 - Math.sin(beat) * 0.3;
        legL.thigh.rotation.x = Math.max(0, Math.sin(beat)) * 0.7;
        legR.thigh.rotation.x = Math.max(0, -Math.sin(beat)) * 0.7;
        legL.knee.rotation.x = -legL.thigh.rotation.x * 1.3;
        legR.knee.rotation.x = -legR.thigh.rotation.x * 1.3;
        head.rotation.z = Math.sin(beat * 0.5) * 0.2;
      } else {
        head.rotation.z = 0;
      }

      armL.shoulder.rotation.set(lx, 0, lz);
      armR.shoulder.rotation.set(rx, 0, rz);
      armL.elbow.rotation.x = le;
      armR.elbow.rotation.x = re;
    },

    /** Grafik entfernen (Materialien entsorgen; gemeinsame Formen bleiben). */
    dispose() {
      root.parent?.remove(root);
      for (const m of materials) m.dispose();
      attachments.clear();
    },
  };
  return view;
}

// Hut nach Form (siehe CONFIG.skins.hatShapes)
function addHat(head, shape, mHat, mAccent, mWhite, mesh) {
  const G = sharedGeometries();
  switch (shape) {
    case 'cap': {
      mesh(G.dome, mHat, head, 0, 0.03, 0);
      const brim = mesh(G.brim, mHat, head, 0, 0.09, -0.08);
      brim.scale.set(1.05, 1, 1.35);
      brim.rotation.x = 0.12; // Schirm leicht nach unten
      break;
    }
    case 'beanie': {
      mesh(G.dome, mHat, head, 0, 0.02, 0).scale.set(1, 1.2, 1);
      mesh(G.band, mHat, head, 0, 0.05, 0).rotation.x = HALF_PI;
      mesh(G.pompom, mWhite, head, 0, 0.38, 0);
      break;
    }
    case 'cone': {
      const cone = mesh(G.cone, mHat, head, 0.03, 0.4, 0);
      cone.rotation.z = -0.15;
      mesh(G.pompom, mWhite, head, 0.06, 0.62, 0);
      break;
    }
    case 'tophat': {
      mesh(G.topBrim, mHat, head, 0, 0.22, 0);
      mesh(G.topHat, mHat, head, 0, 0.39, 0);
      mesh(G.topBand, mAccent, head, 0, 0.27, 0);
      break;
    }
    case 'crown': {
      mesh(G.crownRing, mHat, head, 0, 0.27, 0);
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        mesh(G.crownSpike, mHat, head, Math.sin(angle) * 0.18, 0.39, Math.cos(angle) * 0.18);
      }
      break;
    }
    case 'helmet': {
      mesh(G.helmet, mHat, head, 0, 0.0, 0);
      // Streifen von vorn über den Kopf nach hinten
      mesh(G.helmetStripe, mAccent, head, 0, 0.0, 0).rotation.y = Math.PI / 2;
      break;
    }
    case 'headband': {
      mesh(G.headband, mHat, head, 0, 0.1, 0).rotation.x = HALF_PI;
      for (const side of [-1, 1]) {
        const tail = mesh(G.tail, mHat, head, side * 0.05, 0.02, 0.29);
        tail.rotation.z = side * 0.4;
      }
      break;
    }
    default:
      break; // 'none'
  }
}

function approach(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

function easeOut(x) {
  return 1 - (1 - x) * (1 - x);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
