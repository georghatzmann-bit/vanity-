// =============================================================================
// Waffen-System: Waffen, Heil-Items und Spitzhacke
// =============================================================================
// createWeaponSystem(game) → siehe ARCHITECTURE.md Abschnitt 9.
//
// Pro Figur und Logik-Schritt (updateCharacter):
//   - Waffe wechseln: 0,25 s bis man schießen kann (CONFIG.weapons.switchTime).
//     Jede Waffe hat ihre EIGENE Wartezeit zwischen zwei Schüssen – darum ist
//     "Schrotflinte schießen → sofort auf Sturmgewehr wechseln" schneller als
//     auf die Schrotflinte zu warten.
//   - Gleiche Platz-Taste nochmal: andere Waffe/anderes Heil-Item in diesem Platz
//     (nur wenn der Platz mehrere hat, z. B. Übungsplatz: 4 = MP → Pistole → Granatwerfer).
//   - Schießen: automatisch (gedrückt halten) oder halb-automatisch (pro Klick),
//     Magazin und Reserve, Nachladen (R; leer + Abzug; leer → von selbst),
//     Schrotflinte lädt Schuss für Schuss und Schießen unterbricht das Nachladen.
//   - Zielen (rechte Maustaste): character.aiming; Sniper setzt character.scopeFov.
//   - Streuung laut config.js (ganzer Kegel-Winkel; laufen ×, zielen ×).
//   - Spitzhacke (F): Schlag alle 0,5 s, 2 m weit, 20 an Figuren / 50 an Bauteilen,
//     sammelt Material (collider.data.harvest).
//   - Heil-Items (Platz 5): Linksklick benutzt, dauert useTime, langsamer laufen
//     (character.speedFactor), Waffenwechsel bricht ab.
//
// Treffer prüfen: hitscan.js (Strahl + Mündungs-Prüfung), Geschosse: projectiles.js,
// Schaden anwenden: combat.js, Rechnung: core/damage.js, Grafik: visuals.js.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { weaponDamage } from '../core/damage.js';
import { createHitscan, createTraceResult, spreadDirection } from './hitscan.js';
import { createCombat, isDamageable, isPiece } from './combat.js';
import { createWeaponVisuals } from './visuals.js';

const W = CONFIG.weapons;
const H = CONFIG.healing;
const P = CONFIG.player;
const EPS = 1e-6;
const PICKAXE = 'pickaxe';

/** Alle Schusswaffen (Schlüssel in CONFIG.weapons). */
export const WEAPON_IDS = Object.freeze(['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher']);
/** Alle Heil-Items (Schlüssel in CONFIG.healing). */
export const HEAL_IDS = Object.freeze(['bandage', 'medkit', 'smallShield', 'bigShield']);

export function isWeaponId(id) {
  return WEAPON_IDS.includes(id);
}

export function isHealId(id) {
  return HEAL_IDS.includes(id);
}

/** Zeit zwischen zwei Schüssen (s): fireInterval oder 1 / fireRate. */
export function fireIntervalOf(def) {
  if (def.fireInterval > 0) return def.fireInterval;
  if (def.fireRate > 0) return 1 / def.fireRate;
  return 1;
}

/**
 * Streuung (GANZER Kegel-Winkel in Grad) einer Waffe.
 *   Schrotflinte: fester Kegel spreadDeg
 *   Sniper: aus der Hüfte hipDeg, mit Zielfernrohr aimedDeg (0)
 *   sonst: baseDeg × movingMultiplier (beim Laufen/in der Luft) × aimMultiplier (beim Zielen)
 */
export function spreadFor(def, moving, aiming) {
  if (def.spreadDeg !== undefined) return def.spreadDeg;
  const s = def.spread;
  if (!s) return 0;
  if (s.hipDeg !== undefined) return aiming ? s.aimedDeg ?? 0 : s.hipDeg;
  let value = s.baseDeg ?? 0;
  if (moving) value *= s.movingMultiplier ?? 1;
  if (aiming) value *= s.aimMultiplier ?? 1;
  return value;
}

/** Auf welchen Platz (1–5) gehört ein Gegenstand? */
export function preferredSlot(id) {
  if (isHealId(id)) return W.healSlot;
  return W[id]?.slot ?? 1;
}

/**
 * Erzeugt einen Gegenstand für einen Platz.
 * Waffe: { id, kind: 'weapon', name, rarity, ammo, magazine, reserve, infiniteReserve, readyAt }
 * Heil-Item: { id, kind: 'heal', name, rarity, count, stack, infinite }
 * @param {string} id
 * @param {string} [rarity]  'common' … 'legendary'
 * @param {object} [options] { ammo, reserve, infiniteReserve, count, infinite }
 */
export function createItem(id, rarity = 'common', options = {}) {
  const r = CONFIG.rarities[rarity] ? rarity : 'common';
  if (isWeaponId(id)) {
    const def = W[id];
    return {
      id,
      kind: 'weapon',
      name: def.name,
      rarity: r,
      ammo: options.ammo ?? def.magazine,
      magazine: def.magazine,
      reserve: options.reserve ?? W.defaultReserveAmmo[id] ?? 0,
      infiniteReserve: !!options.infiniteReserve,
      readyAt: 0, // Spielzeit, ab der diese Waffe wieder schießen darf
    };
  }
  if (isHealId(id)) {
    const def = H[id];
    return {
      id,
      kind: 'heal',
      name: def.name,
      rarity: r,
      count: Math.max(1, Math.min(def.stack, options.count ?? 1)),
      stack: def.stack,
      infinite: !!options.infinite,
    };
  }
  return null;
}

// Zustand pro Figur (character.weaponState)
function createState() {
  return {
    alive: true,
    equipped: undefined, // was gerade in der Hand ist (Gegenstand, 'pickaxe' oder null)
    equipReadyAt: 0, // ab dieser Spielzeit darf die neue Waffe schießen (Wechsel-Zeit)
    prevMode: null,
    prevSlot: -1,
    fireBuffer: 0, // gemerkter Klick (halb-automatische Waffen)
    moving: false,
    reloadItem: null, // Waffe, die gerade nachlädt
    reloadTimer: 0,
    reloadStep: 0, // Dauer des aktuellen Schritts (ganzes Nachladen bzw. eine Patrone)
    healItem: null,
    healTimer: 0,
    healSlowed: false,
    healInfo: { itemId: null, name: '', kind: 'health', duration: 0, progress: 0, timeLeft: 0 },
    pickaxeReadyAt: 0,
    variants: [null, null, null, null, null], // pro Platz: mehrere Gegenstände (gleiche Taste wechselt)
  };
}

/**
 * @param {object} game
 */
export function createWeaponSystem(game) {
  const hitscan = createHitscan(game);
  const combat = createCombat(game);
  const trace = createTraceResult();

  // wiederverwendete Hilfs-Objekte
  const eye = new THREE.Vector3();
  const aimOrigin = new THREE.Vector3();
  const aimDir = new THREE.Vector3();
  const pelletDir = new THREE.Vector3();
  const shotOrigin = new THREE.Vector3();
  const shotEnd = new THREE.Vector3();
  const target = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const visualMuzzle = new THREE.Vector3();
  // Sammeln der Kugel-Treffer eines Schusses (Schrotflinte: 10 Kugeln → eine Zahl pro Ziel)
  const hitChars = [];
  const hitCharAmount = [];
  const hitCharHead = [];
  const hitCharPoint = [];
  const hitRefs = [];
  const hitRefCollider = [];
  const hitRefAmount = [];
  const hitRefPoint = [];
  for (let i = 0; i < 16; i++) {
    hitCharPoint.push(new THREE.Vector3());
    hitRefPoint.push(new THREE.Vector3());
  }
  // Einschläge eines Schusses: erst gesammelt, dann NACH 'shot' gemeldet (shot → impact* → hit*)
  const impacts = [];
  for (let i = 0; i < 16; i++) impacts.push({ point: new THREE.Vector3(), normal: new THREE.Vector3(), kind: 'static' });
  let impactCount = 0;

  // Ereignis-Objekte werden wiederverwendet (wer etwas behalten will, kopiert es)
  const shotEvent = { shooter: null, weaponId: null, origin: new THREE.Vector3(), dir: new THREE.Vector3(), end: new THREE.Vector3(), pellets: 1, kind: 'hitscan' };
  const reloadEvent = { character: null, weaponId: null, interrupted: false };
  const switchEvent = { character: null, slot: 0 };
  const harvestEvent = { character: null, material: null, amount: 0, rolled: 0, point: new THREE.Vector3() };
  const impactEvent = { shooter: null, weaponId: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), kind: 'static' };
  const swingEvent = { character: null };
  const healStartEvent = { character: null, itemId: null, duration: 0 };
  const healCancelEvent = { character: null, itemId: null };
  const crosshair = { type: 'cross', spread: 0 };
  const ammo = { mag: 0, reserve: 0, infinite: false, magazine: 0, reloading: false, reloadProgress: 0, heal: false };

  let visuals = null;

  function stateOf(c) {
    if (!c.weaponState) c.weaponState = createState();
    return c.weaponState;
  }

  function currentItem(c) {
    return c.mode === 'weapon' ? c.slots[c.selectedSlot] ?? null : null;
  }

  function isMoving(c) {
    return !c.grounded || Math.hypot(c.velocity.x, c.velocity.z) > W.movingSpeed;
  }

  // Abstand für gleichmäßiges Dauerfeuer: Schießt man ohne Pause weiter, zählt die
  // Wartezeit ab dem geplanten Zeitpunkt (sonst würde 1/60-s-Raster das Tempo senken).
  function nextReady(readyAt, time, dt, interval) {
    const late = time - readyAt;
    return late >= -EPS && late < dt + EPS ? readyAt + interval : time + interval;
  }

  // Ziel-Strahl aus dem Befehl (Spieler: Kamera-Mitte; Bot: Augen → Ziel).
  // Unbrauchbar (nie gesetzt, weit weg)? Dann Augen + Blickrichtung.
  function resolveAim(c, cmd) {
    c.eyePosition(eye);
    const len = cmd.aimDir.length();
    if (len > 0.5 && cmd.aimOrigin.distanceToSquared(eye) < 1.44) {
      aimOrigin.copy(cmd.aimOrigin);
      aimDir.copy(cmd.aimDir).multiplyScalar(1 / len);
    } else {
      aimOrigin.copy(eye);
      c.aimDirection(aimDir);
    }
  }

  function emitSwitched(c, slot) {
    switchEvent.character = c;
    switchEvent.slot = slot;
    game.events.emit('weaponSwitched', switchEvent);
  }

  // --- Nachladen ---------------------------------------------------------------------
  function hasReserve(item) {
    return item.infiniteReserve || item.reserve > 0;
  }

  function takeReserve(item, amount) {
    if (!item.infiniteReserve) item.reserve = Math.max(0, item.reserve - amount);
  }

  function startReload(c, st, item) {
    if (!item || item.kind !== 'weapon' || st.reloadItem) return false;
    const def = W[item.id];
    if (item.ammo >= def.magazine || !hasReserve(item)) return false;
    st.reloadItem = item;
    st.reloadStep = def.reloadMode === 'perShell' ? def.reloadTimePerShell : def.reloadTime;
    st.reloadTimer = st.reloadStep;
    reloadEvent.character = c;
    reloadEvent.weaponId = item.id;
    reloadEvent.interrupted = false;
    game.events.emit('reloadStart', reloadEvent);
    return true;
  }

  function endReload(c, st, interrupted) {
    const item = st.reloadItem;
    if (!item) return;
    st.reloadItem = null;
    st.reloadTimer = 0;
    reloadEvent.character = c;
    reloadEvent.weaponId = item.id;
    reloadEvent.interrupted = !!interrupted;
    game.events.emit('reloadEnd', reloadEvent);
  }

  function progressReload(c, st, item, dt) {
    const def = W[item.id];
    st.reloadTimer -= dt;
    if (def.reloadMode === 'perShell') {
      // Schuss für Schuss: jede Patrone dauert reloadTimePerShell
      while (st.reloadItem && st.reloadTimer <= EPS) {
        if (item.ammo < def.magazine && hasReserve(item)) {
          item.ammo++;
          takeReserve(item, 1);
        }
        if (item.ammo >= def.magazine || !hasReserve(item)) endReload(c, st, false);
        else st.reloadTimer += def.reloadTimePerShell;
      }
    } else if (st.reloadTimer <= EPS) {
      const missing = def.magazine - item.ammo;
      const take = item.infiniteReserve ? missing : Math.min(missing, item.reserve);
      item.ammo += take;
      takeReserve(item, take);
      endReload(c, st, false);
    }
  }

  // --- Heilen ---------------------------------------------------------------------------
  function canHeal(c, def) {
    if (def.heals === 'shield') return c.shield < Math.min(def.maxTo, P.maxShield) - EPS;
    return c.health < Math.min(def.maxTo, P.maxHealth) - EPS;
  }

  function hasCount(item) {
    return item.infinite || item.count > 0;
  }

  function stopHeal(c, st, cancelled) {
    const item = st.healItem;
    if (!item) return;
    st.healItem = null;
    st.healTimer = 0;
    if (c.healing === st.healInfo) c.healing = null;
    if (st.healSlowed) {
      c.speedFactor = 1;
      st.healSlowed = false;
    }
    if (cancelled) {
      healCancelEvent.character = c;
      healCancelEvent.itemId = item.id;
      game.events.emit('healCancel', healCancelEvent);
    }
  }

  // Heil-Item aufgebraucht: anderes Item im selben Platz, sonst andere Waffe / Spitzhacke
  function removeEmptyHeal(c, st, item) {
    const slot = c.slots.indexOf(item);
    if (slot < 0) return;
    const list = st.variants[slot];
    if (list) {
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
      const next = list.find((it) => it.kind !== 'heal' || hasCount(it));
      if (next) {
        c.slots[slot] = next;
        emitSwitched(c, slot);
        return;
      }
      st.variants[slot] = null;
    }
    c.slots[slot] = null;
    if (c.selectedSlot !== slot) return;
    const other = c.slots.findIndex(Boolean);
    if (other >= 0) {
      c.selectedSlot = other;
      emitSwitched(c, other);
    } else {
      c.setMode('pickaxe');
    }
  }

  function updateHeal(c, st, item, cmd, dt, time) {
    const def = H[item.id];
    if (st.healItem) {
      st.healTimer -= dt;
      const info = st.healInfo;
      info.timeLeft = Math.max(0, st.healTimer);
      info.progress = Math.min(1, 1 - st.healTimer / def.useTime);
      if (st.healTimer > EPS) return;
      // fertig: heilen und ein Stück verbrauchen
      c.heal(def.heals, def.amount, def.maxTo);
      if (!item.infinite) item.count = Math.max(0, item.count - 1);
      stopHeal(c, st, false);
      if (!hasCount(item)) removeEmptyHeal(c, st, item);
      return;
    }
    const wants = cmd.primaryPressed || cmd.primary;
    if (!wants || time < st.equipReadyAt - EPS || !hasCount(item) || !canHeal(c, def)) return;
    st.healItem = item;
    st.healTimer = def.useTime;
    const info = st.healInfo;
    info.itemId = item.id;
    info.name = def.name;
    info.kind = def.heals;
    info.duration = def.useTime;
    info.progress = 0;
    info.timeLeft = def.useTime;
    c.healing = info;
    c.speedFactor = H.moveSpeedFactor;
    st.healSlowed = true;
    healStartEvent.character = c;
    healStartEvent.itemId = item.id;
    healStartEvent.duration = def.useTime;
    game.events.emit('healStart', healStartEvent);
  }

  // --- Schießen ---------------------------------------------------------------------------
  function resetHits() {
    hitChars.length = 0;
    hitCharAmount.length = 0;
    hitCharHead.length = 0;
    hitRefs.length = 0;
    hitRefCollider.length = 0;
    hitRefAmount.length = 0;
  }

  function addCharHit(character, amount, head, point) {
    let i = hitChars.indexOf(character);
    if (i < 0) {
      if (hitChars.length >= hitCharPoint.length) return;
      i = hitChars.length;
      hitChars.push(character);
      hitCharAmount.push(0);
      hitCharHead.push(false);
      hitCharPoint[i].copy(point);
    }
    hitCharAmount[i] += amount;
    if (head) hitCharHead[i] = true;
  }

  function addRefHit(collider, amount, point) {
    const ref = collider.data.ref;
    let i = hitRefs.indexOf(ref);
    if (i < 0) {
      if (hitRefs.length >= hitRefPoint.length) return;
      i = hitRefs.length;
      hitRefs.push(ref);
      hitRefCollider.push(collider);
      hitRefAmount.push(0);
      hitRefPoint[i].copy(point);
    }
    hitRefAmount[i] += amount;
  }

  function impactKind(t) {
    return t.character ? 'character' : t.collider ? (isPiece(t.collider) ? 'piece' : isDamageable(t.collider) ? 'object' : 'static') : t.terrain ? 'terrain' : 'static';
  }

  function emitImpact(c, weaponId, t) {
    impactEvent.shooter = c;
    impactEvent.weaponId = weaponId;
    impactEvent.point.copy(t.point);
    impactEvent.normal.copy(t.normal);
    impactEvent.kind = impactKind(t);
    game.events.emit('impact', impactEvent);
  }

  // Einschlag einer Kugel merken (gemeldet wird er erst nach 'shot')
  function recordImpact(t) {
    if (impactCount >= impacts.length) return;
    const r = impacts[impactCount++];
    r.point.copy(t.point);
    r.normal.copy(t.normal);
    r.kind = impactKind(t);
  }

  function emitRecordedImpacts(c, weaponId) {
    for (let i = 0; i < impactCount; i++) {
      const r = impacts[i];
      impactEvent.shooter = c;
      impactEvent.weaponId = weaponId;
      impactEvent.point.copy(r.point);
      impactEvent.normal.copy(r.normal);
      impactEvent.kind = r.kind;
      game.events.emit('impact', impactEvent);
    }
    impactCount = 0;
  }

  // Treffer eines Schusses anwenden (eine Zahl pro Ziel), Zähler für Genauigkeit
  function applyHits(c, weaponId) {
    let hitSomeone = false;
    let headshot = false;
    for (let i = 0; i < hitChars.length; i++) {
      const done = combat.damageCharacter(c, hitChars[i], hitCharAmount[i], hitCharHead[i], hitCharPoint[i], weaponId, 'bullet');
      if (done > 0) {
        hitSomeone = true;
        if (hitCharHead[i]) headshot = true;
      }
    }
    for (let i = 0; i < hitRefs.length; i++) {
      combat.damageObject(c, hitRefCollider[i], hitRefAmount[i], hitRefPoint[i], weaponId, 'bullet');
    }
    if (hitSomeone) c.stats.shotsHit++;
    if (headshot) c.stats.headshots++;
    resetHits();
  }

  // Alle Kugeln eines Strahl-Schusses verfolgen; Treffer und Einschläge nur SAMMELN
  // (fire() meldet erst 'shot', dann die Einschläge, dann wendet es den Schaden an)
  function traceHitscan(c, item, def, cone) {
    const pellets = def.pellets ?? 1;
    const rarity = game.useRarity ? item.rarity : null;
    resetHits();
    impactCount = 0;
    for (let i = 0; i < pellets; i++) {
      spreadDirection(aimDir, cone, game.rng, pelletDir);
      hitscan.trace(c, aimOrigin, pelletDir, def.maxRange ?? 300, trace);
      if (i === 0) shotEnd.copy(trace.point);
      if (!trace.hit) continue;
      if (trace.character) {
        const head = trace.part === 'head';
        addCharHit(trace.character, weaponDamage(def, { distance: trace.distance, head, rarity }), head, trace.point);
      } else if (trace.collider && isDamageable(trace.collider)) {
        const amount = isPiece(trace.collider) ? def.structureDamage / pellets : weaponDamage(def, { distance: trace.distance, rarity });
        addRefHit(trace.collider, amount, trace.point);
      }
      recordImpact(trace);
    }
  }

  function fireProjectile(c, item, def, cone) {
    spreadDirection(aimDir, cone, game.rng, pelletDir);
    hitscan.aimPoint(c, aimOrigin, pelletDir, W.projectileAimRange, target);
    shotEnd.copy(target);
    // Start an den Augen (so fliegt nichts um Ecken), Richtung = Fadenkreuz-Punkt
    c.eyePosition(tmp);
    velocity.subVectors(target, tmp);
    const len = velocity.length();
    if (len > 0.05) velocity.multiplyScalar(1 / len);
    else velocity.copy(pelletDir);
    velocity.multiplyScalar(def.projectileSpeed);
    const grenade = def.explosionRadius > 0;
    // Bild: Geschoss startet an der Mündung der Waffe in der Hand. Ist die eigene Figur
    // ausgeblendet (Kamera dicht am Kopf, Zielfernrohr), ein Stück vor den Augen –
    // sonst zieht der Leuchtstreifen direkt an der Kamera vorbei.
    let visualFrom = null;
    if (visuals) {
      if (visuals.muzzleWorld(c, visualMuzzle)) visualFrom = visualMuzzle;
      else visualFrom = visualMuzzle.copy(velocity).normalize().multiplyScalar(CONFIG.weaponVisuals.hiddenShotStartDistance).add(tmp);
    }
    game.projectiles?.spawn({
      type: grenade ? 'grenade' : 'bullet',
      owner: c,
      weaponId: item.id,
      rarity: item.rarity,
      position: tmp,
      velocity,
      gravity: def.projectileGravity ?? 0,
      lifetime: grenade ? def.fuseTime : def.projectileMaxLifetime,
      visualFrom,
    });
  }

  function fire(c, st, item, def, cmd, time, dt) {
    resolveAim(c, cmd);
    const cone = spreadFor(def, st.moving, c.aiming);
    item.ammo--;
    item.readyAt = nextReady(item.readyAt, time, dt, fireIntervalOf(def));
    c.stats.shotsFired++;
    if (c.emoteUntil > 0) c.emoteUntil = 0;
    const projectile = def.kind === 'projectile';
    if (projectile) fireProjectile(c, item, def, cone);
    else traceHitscan(c, item, def, cone);
    // Reihenfolge der Ereignisse: 'shot' → 'impact' (jede Kugel) → 'hit' (je Ziel)
    hitscan.muzzlePosition(c, shotOrigin);
    shotEvent.shooter = c;
    shotEvent.weaponId = item.id;
    shotEvent.origin.copy(shotOrigin);
    shotEvent.dir.copy(aimDir);
    shotEvent.end.copy(shotEnd);
    shotEvent.pellets = def.pellets ?? 1;
    shotEvent.kind = def.kind;
    game.events.emit('shot', shotEvent);
    if (!projectile) {
      emitRecordedImpacts(c, item.id);
      applyHits(c, item.id);
    }
  }

  function updateGun(c, st, item, cmd, dt, time) {
    const def = W[item.id];
    if (cmd.reloadOrRotate) startReload(c, st, item);
    const equipping = time < st.equipReadyAt - EPS;
    // Abzug: automatisch = gedrückt halten, sonst ein Klick. Ein Klick kurz vor Ende der
    // Wartezeit wird gemerkt (fireBufferTime) – auch beim Antippen automatischer Waffen.
    // Während des Waffen-Wechsels läuft der Merker nicht ab: "1 drücken + klicken" (Wand →
    // Schrotflinte) schießt, sobald die Waffe bereit ist.
    if (cmd.primaryPressed) st.fireBuffer = W.fireBufferTime;
    else if (st.fireBuffer > 0 && !equipping) st.fireBuffer = Math.max(0, st.fireBuffer - dt);
    const trigger = st.fireBuffer > 0 || (def.automatic && !!cmd.primary);
    // Schrotflinte: Schießen unterbricht das Nachladen (wenn schon Patronen drin sind)
    if (trigger && st.reloadItem === item && def.reloadMode === 'perShell' && item.ammo > 0) endReload(c, st, true);
    if (st.reloadItem === item) progressReload(c, st, item, dt);
    // Leer in der Hand (z. B. zurück aus dem Baumodus, das Nachladen wurde abgebrochen):
    // lädt von selbst nach, sobald die Waffe bereit ist
    if (W.autoReloadWhenEmpty && item.ammo <= 0 && !st.reloadItem && !equipping) startReload(c, st, item);
    if (trigger && item.ammo <= 0 && !st.reloadItem) startReload(c, st, item);
    const ready = time >= st.equipReadyAt - EPS && time >= item.readyAt - EPS;
    if (trigger && !st.reloadItem && item.ammo > 0 && ready) {
      fire(c, st, item, def, cmd, time, dt);
      st.fireBuffer = 0;
      if (item.ammo <= 0 && W.autoReloadWhenEmpty) startReload(c, st, item);
    }
  }

  // --- Spitzhacke ----------------------------------------------------------------------------
  function harvest(c, material, point) {
    const range = CONFIG.materials.harvestPerHit;
    const rolled = range.min + Math.floor(game.rng() * (range.max - range.min + 1));
    const before = c.materials[material] ?? 0;
    const added = Math.max(0, Math.min(rolled, CONFIG.materials.maxPerType - before));
    c.materials[material] = before + added;
    harvestEvent.character = c;
    harvestEvent.material = material;
    harvestEvent.amount = added;
    harvestEvent.rolled = rolled;
    harvestEvent.point.copy(point);
    game.events.emit('harvest', harvestEvent);
  }

  function updatePickaxe(c, st, cmd, dt, time) {
    const def = W.pickaxe;
    if (!cmd.primary || time < st.equipReadyAt - EPS || time < st.pickaxeReadyAt - EPS) return;
    st.pickaxeReadyAt = nextReady(st.pickaxeReadyAt, time, dt, def.swingInterval);
    c.triggerAction('pickaxe');
    if (c.emoteUntil > 0) c.emoteUntil = 0;
    swingEvent.character = c;
    game.events.emit('swing', swingEvent);
    resolveAim(c, cmd);
    hitscan.trace(c, aimOrigin, aimDir, def.range, trace);
    if (!trace.hit) return;
    // Reihenfolge wie beim Schuss: 'swing' → 'impact' → 'hit' / 'harvest'
    emitImpact(c, PICKAXE, trace);
    if (trace.character) {
      combat.damageCharacter(c, trace.character, def.playerDamage, false, trace.point, PICKAXE, 'melee');
    } else if (trace.collider) {
      const collider = trace.collider; // trace kann sich in Ereignis-Empfängern ändern
      const material = collider.data?.harvest;
      if (isDamageable(collider)) combat.damageObject(c, collider, def.structureDamage, trace.point, PICKAXE, 'melee');
      if (material && CONFIG.materials.order.includes(material)) harvest(c, material, trace.point);
    }
  }

  // --- Wechseln --------------------------------------------------------------------------------
  function onEquip(c, st, equipped, time) {
    if (st.reloadItem) endReload(c, st, true);
    if (st.healItem && (H.cancelOnWeaponSwitch || equipped !== st.healItem)) stopHeal(c, st, true);
    st.equipped = equipped;
    st.equipReadyAt = equipped ? time + W.switchTime : time;
    st.fireBuffer = 0;
  }

  function cycleVariant(c, st, slot) {
    const list = st.variants[slot];
    if (!list || list.length < 2) return;
    const current = c.slots[slot];
    const start = Math.max(0, list.indexOf(current));
    for (let k = 1; k < list.length; k++) {
      const candidate = list[(start + k) % list.length];
      if (candidate.kind === 'heal' && !hasCount(candidate)) continue;
      c.slots[slot] = candidate;
      emitSwitched(c, slot);
      return;
    }
  }

  // =============================================================================================
  const system = {
    game,
    hitscan,

    /** Pro Figur und Logik-Schritt (Schritt 5 im Spiel-Tick). */
    updateCharacter(c, cmd, dt) {
      const st = stateOf(c);
      const time = game.time;
      if (!c.alive) {
        if (st.alive) {
          if (st.reloadItem) endReload(c, st, true);
          if (st.healItem) stopHeal(c, st, true);
        }
        st.alive = false;
        st.equipped = undefined;
        c.scopeFov = null;
        c.aiming = false;
        return;
      }
      st.alive = true;

      // Gleiche Platz-Taste nochmal → anderer Gegenstand in diesem Platz
      if (cmd.selectSlot > 0 && !cmd.selectBuild && c.mode === 'weapon' && st.prevMode === 'weapon' &&
        cmd.selectSlot - 1 === c.selectedSlot && st.prevSlot === c.selectedSlot) {
        cycleVariant(c, st, c.selectedSlot);
      }

      const item = currentItem(c);
      const equipped = c.mode === 'pickaxe' ? PICKAXE : item;
      if (equipped !== st.equipped) onEquip(c, st, equipped, time);

      const gun = item && item.kind === 'weapon' ? item : null;
      // Zielen: mit Waffe (oder leerer Hand), nicht mit Heil-Item, Spitzhacke oder beim Bauen
      c.aiming = !!cmd.secondary && c.mode === 'weapon' && (!item || !!gun);
      st.moving = isMoving(c);

      if (gun) updateGun(c, st, gun, cmd, dt, time);
      else if (item && item.kind === 'heal') updateHeal(c, st, item, cmd, dt, time);
      else if (c.mode === 'pickaxe') updatePickaxe(c, st, cmd, dt, time);

      // Zielfernrohr (Sniper): Kamera zoomt, HUD zeigt das Zielfernrohr-Bild
      const def = gun ? W[gun.id] : null;
      c.scopeFov = def && def.scopeOverlay && c.aiming && !st.reloadItem && time >= st.equipReadyAt - EPS
        ? CONFIG.camera.sniperFov : null;
      st.prevMode = c.mode;
      st.prevSlot = c.selectedSlot;
    },

    /**
     * Gibt einer Figur Gegenstände. ids: Liste von Namen ('shotgun', 'bandage' …); ein
     * Eintrag als Liste (['smg', 'pistol']) = mehrere Gegenstände in einem Platz.
     * Jeder Gegenstand kommt auf seinen Platz aus config.js (sonst den nächsten freien).
     * options = { rarity (Name oder { id: Name }), infiniteReserve, reserve (Zahl oder { id: Zahl }),
     *             infiniteHeals, healCount (Standard: voller Stapel) }
     * @returns {Array} character.slots
     */
    giveLoadout(c, ids, options = {}) {
      const st = stateOf(c);
      if (st.reloadItem) endReload(c, st, true);
      if (st.healItem) stopHeal(c, st, true);
      for (let i = 0; i < c.slots.length; i++) {
        c.slots[i] = null;
        st.variants[i] = null;
      }
      const rarityOf = (id) => (typeof options.rarity === 'object' && options.rarity ? options.rarity[id] : options.rarity) ?? 'common';
      const reserveOf = (id) => (typeof options.reserve === 'object' && options.reserve ? options.reserve[id] : options.reserve);
      for (const entry of ids ?? []) {
        const group = Array.isArray(entry) ? entry : [entry];
        const items = [];
        for (const id of group) {
          const heal = isHealId(id);
          const item = createItem(id, rarityOf(id), {
            infiniteReserve: !!options.infiniteReserve,
            reserve: reserveOf(id),
            count: heal ? options.healCount ?? H[id].stack : undefined,
            infinite: !!options.infiniteHeals,
          });
          if (item) items.push(item);
        }
        if (items.length === 0) continue;
        let slot = preferredSlot(items[0].id) - 1;
        if (slot < 0 || slot >= c.slots.length || c.slots[slot]) slot = c.slots.indexOf(null);
        if (slot < 0) continue; // alle Plätze voll
        c.slots[slot] = items[0];
        if (items.length > 1) st.variants[slot] = items;
      }
      const first = c.slots.findIndex(Boolean);
      if (first >= 0) {
        c.selectedSlot = first;
        if (c.mode !== 'build' && c.mode !== 'edit') c.setMode('weapon');
      }
      st.equipped = undefined; // nächster Schritt: neu in die Hand nehmen (Wechsel-Zeit)
      return c.slots;
    },

    /** Erzeugt einen Gegenstand (siehe createItem). */
    createItem(id, rarity, options) {
      return createItem(id, rarity, options);
    },

    /** Darf die Figur zielen? Nicht mit einem Heil-Item in der Hand (player.js prüft dazu den Modus). */
    canAim(c) {
      const item = currentItem(c);
      return !item || item.kind === 'weapon';
    },

    /** Fadenkreuz für das HUD: { type: 'cross'|'circle'|'dot', spread (Grad, ganzer Kegel) }. */
    getCrosshair(c) {
      const item = c ? currentItem(c) : null;
      if (item && item.kind === 'weapon') {
        const def = W[item.id];
        crosshair.type = def.crosshair ?? 'cross';
        crosshair.spread = spreadFor(def, isMoving(c), c.aiming);
      } else {
        crosshair.type = c?.mode === 'pickaxe' ? 'dot' : 'cross';
        crosshair.spread = 0;
      }
      return crosshair;
    },

    /**
     * Munition für das HUD (wiederverwendetes Objekt) oder null (Spitzhacke, Bauen, leere Hand).
     * Waffe: { mag, reserve, infinite, magazine, reloading, reloadProgress (0..1), heal: false }
     * Heil-Item: { mag: Anzahl, reserve: 0, infinite, heal: true, reloading: false, … }
     */
    getAmmo(c) {
      const item = c ? currentItem(c) : null;
      if (!item) return null;
      const st = stateOf(c);
      if (item.kind === 'heal') {
        ammo.mag = item.count;
        ammo.reserve = 0;
        ammo.infinite = !!item.infinite;
        ammo.magazine = item.stack;
        ammo.reloading = false;
        ammo.reloadProgress = st.healItem === item ? st.healInfo.progress : 0;
        ammo.heal = true;
        return ammo;
      }
      ammo.mag = item.ammo;
      ammo.reserve = item.reserve;
      ammo.infinite = !!item.infiniteReserve;
      ammo.magazine = W[item.id].magazine;
      ammo.reloading = st.reloadItem === item;
      ammo.reloadProgress = ammo.reloading ? Math.min(1, Math.max(0, 1 - st.reloadTimer / st.reloadStep)) : 0;
      ammo.heal = false;
      return ammo;
    },

    /** Lädt die Figur gerade nach? */
    isReloading(c) {
      return !!c?.weaponState?.reloadItem;
    },

    /** Zustand nach einer neuen Runde: Nachladen/Heilen abbrechen, alle Magazine voll. */
    resetCharacter(c) {
      const st = stateOf(c);
      if (st.reloadItem) endReload(c, st, true);
      if (st.healItem) stopHeal(c, st, true);
      st.equipped = undefined;
      st.fireBuffer = 0;
      const refill = (item) => {
        if (item && item.kind === 'weapon') {
          item.ammo = W[item.id].magazine;
          item.readyAt = 0;
        }
      };
      c.slots.forEach(refill);
      for (const list of st.variants) list?.forEach(refill);
      c.scopeFov = null;
    },

    /** Grafik: Waffen in der Hand, Mündungsblitz, Leuchtspur, Schadenszahlen, Geschosse. */
    frameUpdate(alpha = 1) {
      visuals?.frameUpdate(alpha);
      game.projectiles?.frameUpdate?.(alpha);
    },

    /** Effekte anhalten (nur für Screenshots in Tests). */
    setEffectsPaused(paused) {
      visuals?.setPaused(paused);
    },

    /** Alle Waffen-Effekte (Blitze, Spuren, Zahlen, Feuerbälle) sofort entfernen. */
    clearEffects() {
      visuals?.clear();
    },

    get visuals() {
      return visuals;
    },

    dispose() {
      visuals?.dispose();
      visuals = null;
    },
  };

  if (!game.headless && game.root && typeof document !== 'undefined') visuals = createWeaponVisuals(game, system);
  return system;
}
