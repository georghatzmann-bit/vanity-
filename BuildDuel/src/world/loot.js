// =============================================================================
// Loot: Kisten, Gegenstände am Boden, Aufheben (E), Fallenlassen
// =============================================================================
// createLootSystem(game, spec) – ein System pro Spiel (game.loot), spec z. B.:
//   { rarityWeights, chest: { materialAmount, ammoMagazines, healItemChance }, dropOnDeath }
//   (Standard: Werte aus CONFIG.modes.battleRoyale, Optik/Reichweiten aus CONFIG.loot)
//
// Kisten (goldener Würfel, leuchtet): E in der Nähe öffnet sie. Heraus springen
//   1 Waffe (Seltenheit nach rarityWeights) + Munition dafür + Material
//   (+ mit healItemChance ein Heil-Item). Die Kiste verschwindet.
// Boden-Gegenstände ("floor items"): { id, kind: 'weapon'|'heal'|'ammo'|'material', item (Waffe/Heil-Item
//   wie weapons.createItem), weaponId (Munition für …), material, amount, rarity, name, position, … }
//   - Waffen und Heil-Items: E aufheben. Freier Platz: Waffe auf ihren Platz (1–4) bzw.
//     Heil-Item auf Platz 5, sonst der nächste freie. Alles voll → Tausch mit dem gewählten
//     Platz (der alte Gegenstand fällt auf den Boden). Gleiche Heil-Items werden gestapelt.
//   - Munition und Material: im Vorbeilaufen automatisch (wenn Platz ist). Munition geht in
//     die Reserve einer passenden Waffe (ohne passende Waffe bleibt sie liegen).
// dropAll(character): beim Besiegtwerden fällt alles verstreut auf den Boden (Waffen,
//   Heil-Items, Material) – automatisch, solange spec.dropOnDeath nicht false ist.
// Verschwinden: Fallen gelassenes nach CONFIG.loot.droppedDespawnTime; höchstens
//   CONFIG.loot.maxFloorItems gleichzeitig (die ältesten fallen gelassenen gehen zuerst).
//
// HUD-Vertrag: game.interactionPrompt = { text, action: 'use', kind: 'chest'|'item', target, rarity, swap }
//   oder null – was E für den Spieler gerade tun würde (jeden Tick neu).
// Bots: findNearestLoot(pos, filter) und interact(character, target) – dieselben Regeln.
// Ereignisse: 'pickup' { character, item (Boden-Gegenstand), amount }, 'chestOpened' { chest, character },
//   'lootDropped' { character, items } (dropAll).
// Grafik: lootView.js (nur mit Bildschirm).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createItem, preferredSlot, WEAPON_IDS, HEAL_IDS } from '../weapons/weapons.js';
import { createLootView } from './lootView.js';

const L = CONFIG.loot;
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _qMin = new THREE.Vector3();
const _qMax = new THREE.Vector3();
const _rayOptions = { ignore: null, characters: null, skipTerrain: false };
const ignoreLootColliders = (c) => c.data?.kind === 'chest' || c.data?.blocksBullets === false;

let nextLootId = 1;

/** Würfelt aus Gewichten { name: Gewicht } einen Namen. */
export function weightedPick(weights, rng = Math.random) {
  let total = 0;
  for (const key in weights) total += Math.max(0, weights[key]);
  if (!(total > 0)) return Object.keys(weights)[0] ?? null;
  let r = rng() * total;
  for (const key in weights) {
    r -= Math.max(0, weights[key]);
    if (r < 0) return key;
  }
  return Object.keys(weights).pop();
}

/** Anzeige-Name eines Boden-Gegenstands (deutsch). */
export function lootName(fi) {
  if (fi.kind === 'weapon' || fi.kind === 'heal') return fi.item?.name ?? fi.id;
  if (fi.kind === 'ammo') return L.ammoNames[fi.weaponId] ?? 'Munition';
  if (fi.kind === 'material') return CONFIG.materials.names[fi.material] ?? fi.material;
  return '?';
}

/**
 * @param {object} game
 * @param {object} [spec]
 */
export function createLootSystem(game, spec = {}) {
  const br = CONFIG.modes.battleRoyale;
  const rarityWeights = spec.rarityWeights ?? br.rarityWeights;
  const chestSpec = { ...br.chest, ...(spec.chest ?? {}) };
  const rng = () => (typeof game.rng === 'function' ? game.rng() : Math.random());
  const chests = [];
  const items = [];
  const pendingDrops = [];
  const prompt = { text: '', action: 'use', kind: null, target: null, rarity: null, swap: false };
  let promptCount = -1; // Stückzahl beim letzten Text (Heil-Items: "×3")
  const pickupEvent = { character: null, item: null, amount: 0 };
  let view = null;

  // ---------------------------------------------------------------------------
  // Würfeln
  // ---------------------------------------------------------------------------
  function rollRarity(r = rng) {
    return weightedPick(rarityWeights, r);
  }
  function rollWeapon(r = rng) {
    return weightedPick(L.weaponWeights, r);
  }
  function rollHeal(r = rng) {
    return weightedPick(L.healWeights, r);
  }
  function ammoAmount(weaponId, magazines) {
    const def = CONFIG.weapons[weaponId];
    return Math.max(1, Math.round((def?.magazine ?? 10) * magazines));
  }

  /** Inhalt einer Kiste (Liste von Boden-Gegenstand-Beschreibungen). */
  function chestContents(r = rng) {
    const weaponId = rollWeapon(r);
    const list = [
      { kind: 'weapon', id: weaponId, rarity: rollRarity(r) },
      { kind: 'ammo', weaponId, amount: ammoAmount(weaponId, chestSpec.ammoMagazines) },
      { kind: 'material', material: CONFIG.materials.order[Math.floor(r() * CONFIG.materials.order.length)], amount: chestSpec.materialAmount },
    ];
    if (r() < chestSpec.healItemChance) {
      const healId = rollHeal(r);
      list.push({ kind: 'heal', id: healId, count: L.healCounts[healId] ?? 1 });
    }
    return list;
  }

  /** Zufälliger Boden-Loot (Waffe kommt mit Munition daneben). */
  function randomFloorLoot(r = rng) {
    const kind = weightedPick(L.floorKindWeights, r);
    if (kind === 'weapon') {
      const id = rollWeapon(r);
      return [
        { kind: 'weapon', id, rarity: rollRarity(r) },
        { kind: 'ammo', weaponId: id, amount: ammoAmount(id, L.ammoMagazines) },
      ];
    }
    if (kind === 'ammo') {
      const weaponId = rollWeapon(r);
      return [{ kind: 'ammo', weaponId, amount: ammoAmount(weaponId, L.ammoMagazines) }];
    }
    if (kind === 'heal') {
      const id = rollHeal(r);
      return [{ kind: 'heal', id, count: L.healCounts[id] ?? 1 }];
    }
    return [{ kind: 'material', material: CONFIG.materials.order[Math.floor(r() * CONFIG.materials.order.length)], amount: L.floorMaterialAmount }];
  }

  // ---------------------------------------------------------------------------
  // Anlegen / Entfernen
  // ---------------------------------------------------------------------------
  /**
   * Neuer Gegenstand am Boden.
   * desc = { kind, id?, rarity?, item? (fertiger Gegenstand), weaponId?, material?, amount?, count?,
   *          position {x,y,z}, from? {x,y,z} (springt von dort heraus), fromMap? (verschwindet nie) }
   */
  function spawnFloorItem(desc) {
    let item = desc.item ?? null;
    if (!item && (desc.kind === 'weapon' || desc.kind === 'heal')) {
      item = createItem(desc.id, desc.rarity ?? 'common', desc.kind === 'weapon' ? { reserve: 0 } : { count: desc.count ?? 1 });
      if (!item) return null;
    }
    const fi = {
      id: nextLootId++,
      kind: desc.kind,
      item,
      weaponId: desc.weaponId ?? null,
      material: desc.material ?? null,
      amount: desc.amount ?? (item?.count ?? 1),
      rarity: item?.rarity ?? desc.rarity ?? null,
      name: '',
      position: new THREE.Vector3(desc.position.x, desc.position.y, desc.position.z),
      spawnTime: game.time ?? 0,
      fromMap: !!desc.fromMap,
      removed: false,
      pop: desc.from ? { x: desc.from.x, y: desc.from.y, z: desc.from.z, start: game.time ?? 0, duration: L.popTime } : null,
      // Bewegung für die Grafik (Drehung pro Gegenstand verschieden)
      phase: rng() * Math.PI * 2,
    };
    fi.name = lootName(fi);
    items.push(fi);
    enforceLimit();
    return fi;
  }

  function removeItem(fi) {
    if (!fi || fi.removed) return;
    fi.removed = true;
    const i = items.indexOf(fi);
    if (i >= 0) items.splice(i, 1);
  }

  function enforceLimit() {
    if (items.length <= L.maxFloorItems) return;
    // älteste fallen gelassene zuerst, dann älteste überhaupt
    let over = items.length - L.maxFloorItems;
    for (let i = 0; i < items.length && over > 0;) {
      if (!items[i].fromMap) {
        items[i].removed = true;
        items.splice(i, 1);
        over--;
      } else i++;
    }
    while (over-- > 0 && items.length) items.shift().removed = true;
  }

  /** Kiste an einen Platz stellen. pos = { x, y, z } (Boden), options = { yaw } */
  function spawnChest(pos, options = {}) {
    const size = L.chest.size;
    const chest = {
      id: nextLootId++,
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      yaw: options.yaw ?? pos.yaw ?? 0,
      opened: false,
      openedBy: null,
      openTime: -1,
      collider: null,
      area: pos.area ?? null,
    };
    if (game.world) {
      // Kollision: man kann draufstehen, Schüsse halten an ihr an
      const h = Math.max(size.x, size.z) / 2;
      chest.collider = game.world.addBox(
        { x: pos.x - h * 0.9, y: pos.y, z: pos.z - h * 0.9 },
        { x: pos.x + h * 0.9, y: pos.y + size.y, z: pos.z + h * 0.9 },
        { kind: 'chest', ref: null, blocksBullets: true },
      );
    }
    chests.push(chest);
    view?.chestsChanged();
    return chest;
  }

  /** Kiste öffnen: Inhalt springt heraus (Richtung Öffnender). → Liste der Boden-Gegenstände */
  function openChest(chest, character = null) {
    if (!chest || chest.opened) return [];
    chest.opened = true;
    chest.openedBy = character;
    chest.openTime = game.time ?? 0;
    if (chest.collider) {
      game.world.remove(chest.collider);
      chest.collider = null;
    }
    const contents = chestContents();
    const from = { x: chest.position.x, y: chest.position.y + L.chest.size.y, z: chest.position.z };
    // Richtung zum Öffnenden (sonst die Blickrichtung der Kiste)
    let baseAngle = Math.atan2(-Math.cos(chest.yaw), -Math.sin(chest.yaw)); // Blickrichtung der Kiste
    if (character) baseAngle = Math.atan2(character.position.z - chest.position.z, character.position.x - chest.position.x);
    const out = [];
    contents.forEach((desc, i) => {
      const angle = baseAngle + (i - (contents.length - 1) / 2) * 0.75;
      const dist = 1.1 + 0.25 * (i % 2);
      const spot = restingSpot(chest.position.x + Math.cos(angle) * dist, chest.position.z + Math.sin(angle) * dist, chest.position.y + 0.8, chest.position);
      const fi = spawnFloorItem({ ...desc, position: spot, from, fromMap: true });
      if (fi) out.push(fi);
    });
    game.events?.emit('chestOpened', { chest, character });
    view?.chestsChanged();
    return out;
  }

  // Stelle am Boden unter (x, z) – nicht in einer Wand, nicht hinter einer Wand (Sicht von "from")
  function restingSpot(x, z, maxY, from) {
    const world = game.world;
    if (!world) return { x, y: from?.y ?? 0, z };
    if (from) {
      // nicht durch Wände fallen lassen: Strahl von der Mitte zur Stelle
      _eye.set(from.x, Math.min(maxY, from.y + 0.6), from.z);
      _dir.set(x - from.x, 0, z - from.z);
      const len = _dir.length();
      if (len > 1e-4) {
        _dir.multiplyScalar(1 / len);
        _rayOptions.ignore = ignoreLootColliders;
        const hit = world.raycast(_eye, _dir, len + 0.35, _rayOptions);
        _rayOptions.ignore = null;
        if (hit && !hit.terrain) {
          const d = Math.max(0, hit.distance - 0.45);
          x = from.x + _dir.x * d;
          z = from.z + _dir.z * d;
        }
      }
    }
    let y = world.surfaceHeight(x, z, maxY);
    if (!Number.isFinite(y)) y = from?.y ?? 0;
    // steckt die Stelle in etwas? → an der Ausgangs-Stelle ablegen
    _qMin.set(x - 0.2, y + 0.05, z - 0.2);
    _qMax.set(x + 0.2, y + 0.5, z + 0.2);
    if (from && world.boxBlocked(_qMin, _qMax, ignoreLootColliders)) {
      x = from.x;
      z = from.z;
      y = world.surfaceHeight(x, z, maxY);
      if (!Number.isFinite(y)) y = from.y;
    }
    return { x, y, z };
  }

  // ---------------------------------------------------------------------------
  // Aufheben
  // ---------------------------------------------------------------------------
  function setSlot(c, index, item) {
    c.slots[index] = item;
    // mehrere Gegenstände in einem Platz (Übungsplatz) gibt es dann dort nicht mehr
    const variants = c.weaponState?.variants;
    if (variants) variants[index] = null;
  }

  function maxReserve(weaponId) {
    return (CONFIG.weapons[weaponId]?.magazine ?? 10) * L.maxReserveMagazines;
  }

  /** Wohin käme der Gegenstand? → { slot, swap } oder null (Heil-Item: auch Stapeln). */
  function slotFor(c, fi) {
    const heal = fi.kind === 'heal';
    const healIndex = CONFIG.weapons.healSlot - 1;
    if (heal) {
      for (let i = 0; i < c.slots.length; i++) {
        const s = c.slots[i];
        if (s && s.kind === 'heal' && s.id === fi.item.id && !s.infinite && s.count < s.stack) return { slot: i, stack: true, swap: false };
      }
      if (!c.slots[healIndex]) return { slot: healIndex, swap: false };
    } else {
      const preferred = preferredSlot(fi.item.id) - 1;
      if (preferred >= 0 && preferred < c.slots.length && preferred !== healIndex && !c.slots[preferred]) return { slot: preferred, swap: false };
      for (let i = 0; i < c.slots.length; i++) if (i !== healIndex && !c.slots[i]) return { slot: i, swap: false };
    }
    const free = c.slots.indexOf(null);
    if (free >= 0) return { slot: free, swap: false };
    // alles voll: Tausch mit dem gewählten Platz
    return { slot: c.selectedSlot, swap: true };
  }

  /** Waffe/Heil-Item aufheben (E). Alles voll → Tausch. @returns {boolean} */
  function pickUp(c, fi) {
    if (!c?.alive || !fi || fi.removed) return false;
    if (fi.kind === 'ammo' || fi.kind === 'material') return collect(c, fi) > 0;
    const target = slotFor(c, fi);
    if (!target) return false;
    if (target.stack) {
      const s = c.slots[target.slot];
      const add = Math.min(fi.item.count, s.stack - s.count);
      s.count += add;
      fi.item.count -= add;
      fi.amount = fi.item.count;
      emitPickup(c, fi, add);
      if (fi.item.count <= 0) removeItem(fi);
      return add > 0;
    }
    const hadNothing = !c.slots[c.selectedSlot];
    if (target.swap) {
      const old = c.slots[target.slot];
      if (old) dropSlotItem(c, old, 0.6);
    }
    setSlot(c, target.slot, fi.item);
    removeItem(fi);
    emitPickup(c, fi, fi.kind === 'heal' ? fi.item.count : 1);
    // Leere Hand (oder Spitzhacke ohne Waffen): gleich in die Hand nehmen
    if ((hadNothing || target.swap) && c.mode !== 'build' && c.mode !== 'edit') {
      if (c.selectedSlot !== target.slot) {
        c.selectedSlot = target.slot;
        game.events?.emit('weaponSwitched', { character: c, slot: target.slot });
      }
      c.setMode?.('weapon');
    }
    return true;
  }

  /** Munition/Material einsammeln. @returns {number} wie viel genommen wurde */
  function collect(c, fi) {
    if (fi.kind === 'material') {
      if (c.infiniteMaterials) return 0;
      const have = c.materials[fi.material] ?? 0;
      const add = Math.max(0, Math.min(fi.amount, CONFIG.materials.maxPerType - have));
      if (add <= 0) return 0;
      c.materials[fi.material] = have + add;
      fi.amount -= add;
      emitPickup(c, fi, add);
      if (fi.amount <= 0) removeItem(fi);
      return add;
    }
    if (fi.kind === 'ammo') {
      let taken = 0;
      for (const s of c.slots) {
        if (!s || s.kind !== 'weapon' || s.id !== fi.weaponId || s.infiniteReserve) continue;
        const add = Math.max(0, Math.min(fi.amount - taken, maxReserve(s.id) - s.reserve));
        s.reserve += add;
        taken += add;
        if (taken >= fi.amount) break;
      }
      if (taken <= 0) return 0;
      fi.amount -= taken;
      emitPickup(c, fi, taken);
      if (fi.amount <= 0) removeItem(fi);
      return taken;
    }
    return 0;
  }

  function emitPickup(c, fi, amount) {
    pickupEvent.character = c;
    pickupEvent.item = fi;
    pickupEvent.amount = amount;
    game.events?.emit('pickup', pickupEvent);
  }

  // Einen Gegenstand aus dem Inventar fallen lassen (vor die Figur)
  function dropSlotItem(c, item, forward = 1) {
    const angle = Math.atan2(-Math.cos(c.yaw), -Math.sin(c.yaw)); // Blickrichtung als Winkel in x/z
    const x = c.position.x + Math.cos(angle) * forward;
    const z = c.position.z + Math.sin(angle) * forward;
    const center = { x: c.position.x, y: c.position.y, z: c.position.z };
    const spot = restingSpot(x, z, c.position.y + 1, center);
    return spawnFloorItem({ kind: item.kind === 'heal' ? 'heal' : 'weapon', item, position: spot, from: { x: c.position.x, y: c.position.y + 1.2, z: c.position.z } });
  }

  /** Alles fallen lassen (verstreut). @returns {Array} Boden-Gegenstände */
  function dropAll(c) {
    if (!c) return [];
    const list = [];
    const variants = c.weaponState?.variants ?? [];
    for (let i = 0; i < c.slots.length; i++) {
      const group = variants[i] && variants[i].length ? variants[i] : c.slots[i] ? [c.slots[i]] : [];
      for (const item of group) {
        if (item.kind === 'heal' && !item.infinite && item.count <= 0) continue;
        list.push({ kind: item.kind === 'heal' ? 'heal' : 'weapon', item });
      }
    }
    if (!c.infiniteMaterials) {
      for (const m of CONFIG.materials.order) {
        const amount = Math.floor(c.materials[m] ?? 0);
        if (amount > 0) list.push({ kind: 'material', material: m, amount });
        c.materials[m] = 0;
      }
    }
    // Inventar leeren (bricht Nachladen/Heilen sauber ab)
    if (game.weapons?.giveLoadout) game.weapons.giveLoadout(c, []);
    else for (let i = 0; i < c.slots.length; i++) c.slots[i] = null;

    const out = [];
    const center = { x: c.position.x, y: c.position.y, z: c.position.z };
    const from = { x: c.position.x, y: c.position.y + 1.0, z: c.position.z };
    const start = rng() * Math.PI * 2;
    list.forEach((desc, i) => {
      const angle = start + (i / Math.max(1, list.length)) * Math.PI * 2;
      const r = L.scatterRadius.min + (L.scatterRadius.max - L.scatterRadius.min) * rng();
      const spot = restingSpot(c.position.x + Math.cos(angle) * r, c.position.z + Math.sin(angle) * r, c.position.y + 1, center);
      const fi = spawnFloorItem({ ...desc, position: spot, from });
      if (fi) out.push(fi);
    });
    game.events?.emit('lootDropped', { character: c, items: out });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Suchen (E, Bots)
  // ---------------------------------------------------------------------------
  function horizontalDistance(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  function reachable(c, targetPos, reach) {
    const dy = targetPos.y - c.position.y;
    return dy > -1.2 && dy < 2.2 && horizontalDistance(c.position, targetPos) <= reach;
  }

  // Ist zwischen Augen und Ziel eine Wand?
  function visible(c, targetPos, lift) {
    if (!game.world) return true;
    c.eyePosition(_eye);
    _to.set(targetPos.x, targetPos.y + lift, targetPos.z);
    _dir.subVectors(_to, _eye);
    const len = _dir.length();
    if (len < 0.05) return true;
    _dir.multiplyScalar(1 / len);
    _rayOptions.ignore = ignoreLootColliders;
    const hit = game.world.raycast(_eye, _dir, len - 0.15, _rayOptions);
    _rayOptions.ignore = null;
    return !hit;
  }

  // Suche des Fokus (focusFor): Zwischenstand ohne neue Objekte pro Tick
  const lookCone = Math.cos((L.lookConeDeg * Math.PI) / 180);
  const focus = { c: null, aimX: 0, aimY: 0, aimZ: 0, best: null, bestScore: Infinity };

  function considerFocus(target, pos, lift, reach) {
    const c = focus.c;
    if (!reachable(c, pos, reach)) return;
    const dx = pos.x - _eye.x;
    const dy = pos.y + lift - _eye.y;
    const dz = pos.z - _eye.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dot = (dx * focus.aimX + dy * focus.aimY + dz * focus.aimZ) / len;
    // im Blick-Kegel: nach Winkel; sonst nach Abstand (mit Aufschlag)
    const score = dot >= lookCone ? (1 - dot) * 10 + len * 0.05 : 10 + horizontalDistance(c.position, pos);
    if (score >= focus.bestScore) return;
    if (!visible(c, pos, lift)) return; // (visible überschreibt _dir – die Blick-Richtung steht in focus)
    focus.best = target;
    focus.bestScore = score;
  }

  /**
   * Was würde E bei dieser Figur gerade tun? → Kiste oder Boden-Gegenstand (oder null).
   * Bevorzugt, was nahe am Fadenkreuz liegt; nur in Reichweite und ohne Wand dazwischen.
   */
  function focusFor(c) {
    if (!c?.alive || c.moveState === 'freefall' || c.moveState === 'glide' || c.moveState === 'vehicle') return null;
    // Blick: Ziel-Strahl des Befehls (Fadenkreuz) – wie bei den Waffen nur, wenn er an den Augen beginnt
    const cmd = c.command;
    c.eyePosition(_eye);
    const useCmd = cmd && cmd.aimDir && cmd.aimDir.lengthSq() > 0.5 && cmd.aimOrigin && cmd.aimOrigin.distanceToSquared(_eye) < 1.44;
    if (useCmd) _dir.copy(cmd.aimDir);
    else c.aimDirection(_dir);
    focus.c = c;
    focus.aimX = _dir.x;
    focus.aimY = _dir.y;
    focus.aimZ = _dir.z;
    focus.best = null;
    focus.bestScore = Infinity;
    for (let i = 0; i < chests.length; i++) {
      const chest = chests[i];
      if (!chest.opened) considerFocus(chest, chest.position, L.chest.size.y * 0.5, L.chestReach);
    }
    for (let i = 0; i < items.length; i++) {
      const fi = items[i];
      if (fi.kind === 'weapon' || fi.kind === 'heal') considerFocus(fi, fi.position, L.floatHeight, L.pickupReach);
    }
    const best = focus.best;
    focus.c = null;
    focus.best = null;
    return best;
  }

  /** E: Kiste öffnen oder Gegenstand aufheben (Spieler und Bots). target = Kiste/Boden-Gegenstand. */
  function interact(c, target) {
    if (!c?.alive || !target) return false;
    if (chests.includes(target)) {
      if (target.opened || !reachable(c, target.position, L.chestReach + 0.3)) return false;
      openChest(target, c);
      return true;
    }
    if (target.removed || !reachable(c, target.position, L.pickupReach + 0.3)) return false;
    return pickUp(c, target);
  }

  /**
   * Nächster Loot zu einer Stelle (für Bots).
   * filter: Funktion (target) → bool oder { kinds: ['chest','weapon','heal','ammo','material'], maxDistance, rarityAtLeast }
   * @returns {object|null} Kiste oder Boden-Gegenstand (target.position)
   */
  function findNearestLoot(pos, filter = null) {
    const fn = typeof filter === 'function' ? filter : null;
    const kinds = !fn && filter?.kinds ? filter.kinds : null;
    const maxDistance = !fn && filter?.maxDistance !== undefined ? filter.maxDistance : Infinity;
    const minRarity = !fn && filter?.rarityAtLeast ? CONFIG.rarities.order.indexOf(filter.rarityAtLeast) : -1;
    let best = null;
    let bestD = maxDistance;
    const check = (target, kind) => {
      if (kinds && !kinds.includes(kind)) return;
      if (fn && !fn(target)) return;
      if (minRarity >= 0 && kind === 'weapon' && CONFIG.rarities.order.indexOf(target.rarity) < minRarity) return;
      const d = Math.hypot(target.position.x - pos.x, (target.position.y - pos.y) * 0.5, target.position.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = target;
      }
    };
    for (const chest of chests) if (!chest.opened) check(chest, 'chest');
    for (const fi of items) check(fi, fi.kind);
    return best;
  }

  // ---------------------------------------------------------------------------
  // Karte füllen
  // ---------------------------------------------------------------------------
  /** Kisten und Boden-Loot auf die Plätze der Karte (map.chestSpots, map.floorLootSpots). */
  function populate(map, options = {}) {
    const chestChance = options.chestChance ?? L.chestSpawnChance;
    const floorChance = options.floorChance ?? L.floorSpawnChance;
    const r = options.rng ?? rng;
    for (const s of map?.chestSpots ?? []) if (r() < chestChance) spawnChest(s, { yaw: s.yaw });
    for (const s of map?.floorLootSpots ?? []) {
      if (r() >= floorChance) continue;
      const list = randomFloorLoot(r);
      list.forEach((desc, i) => {
        const offset = i === 0 ? 0 : 0.9;
        const a = (s.yaw ?? 0) + i * 1.3;
        spawnFloorItem({ ...desc, position: { x: s.x + Math.cos(a) * offset, y: s.y, z: s.z + Math.sin(a) * offset }, fromMap: true });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Logik pro Tick
  // ---------------------------------------------------------------------------
  function update(/* dt */) {
    // Besiegte lassen alles fallen (gesammelt aus dem Ereignis, hier sicher abgearbeitet)
    while (pendingDrops.length) dropAll(pendingDrops.shift());
    // Verschwinden
    const time = game.time ?? 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const fi = items[i];
      if (!fi.fromMap && time - fi.spawnTime > L.droppedDespawnTime) {
        fi.removed = true;
        items.splice(i, 1);
      }
    }
    const characters = game.characters ?? [];
    for (let k = 0; k < characters.length; k++) {
      const c = characters[k];
      if (!c.alive || c.moveState === 'freefall' || c.moveState === 'glide' || c.moveState === 'vehicle') continue;
      // Munition/Material im Vorbeilaufen
      for (let i = items.length - 1; i >= 0; i--) {
        const fi = items[i];
        if (fi.kind !== 'ammo' && fi.kind !== 'material') continue;
        if (fi.pop && time - fi.pop.start < fi.pop.duration) continue;
        if (!reachable(c, fi.position, L.autoPickupRadius)) continue;
        collect(c, fi);
      }
      // E
      if (c.command?.usePressed) {
        const target = focusFor(c);
        if (target) interact(c, target);
      }
    }
    updatePrompt();
  }

  function updatePrompt() {
    const p = game.player;
    const target = p ? focusFor(p) : null;
    if (!target) {
      game.interactionPrompt = null;
      prompt.target = null;
      return;
    }
    const isChest = chests.includes(target);
    const swap = isChest ? false : !!slotFor(p, target)?.swap;
    const count = isChest ? 0 : target.item?.count ?? 0;
    // Text nur neu bauen, wenn sich etwas geändert hat (sonst jeden Tick ein neuer Text)
    if (prompt.target !== target || prompt.swap !== swap || promptCount !== count) {
      prompt.target = target;
      prompt.swap = swap;
      promptCount = count;
      if (isChest) {
        prompt.kind = 'chest';
        prompt.text = 'Kiste öffnen';
        prompt.rarity = null;
      } else {
        prompt.kind = 'item';
        prompt.rarity = target.rarity;
        const rarityName = target.kind === 'weapon' ? ` (${CONFIG.rarities[target.rarity]?.name ?? ''})` : target.kind === 'heal' && count > 1 ? ` ×${count}` : '';
        prompt.text = `${swap ? 'Tauschen' : 'Aufheben'}: ${target.name}${rarityName}`;
      }
    }
    game.interactionPrompt = prompt;
  }

  // Besiegt → alles fallen lassen (nach dem Tick, nicht mitten im Schuss)
  const offKilled = spec.dropOnDeath === false ? null : game.events?.on?.('characterKilled', ({ victim }) => {
    if (victim && !pendingDrops.includes(victim)) pendingDrops.push(victim);
  });

  const system = {
    game,
    spec,
    chests,
    items,
    update,
    frameUpdate(dt, alpha) {
      view?.frameUpdate(dt, alpha);
    },
    spawnChest,
    openChest,
    spawnFloorItem,
    removeItem,
    populate,
    pickUp,
    collect,
    dropAll,
    dropSlotItem,
    interact,
    focusFor,
    findNearestLoot,
    slotFor,
    chestContents,
    randomFloorLoot,
    rollRarity,
    rollWeapon,
    get prompt() {
      return game.interactionPrompt;
    },
    dispose() {
      offKilled?.();
      for (const chest of chests) if (chest.collider) game.world?.remove(chest.collider);
      chests.length = 0;
      items.length = 0;
      pendingDrops.length = 0;
      if (game.interactionPrompt === prompt) game.interactionPrompt = null;
      view?.dispose();
      view = null;
    },
  };

  if (!game.headless && game.root && typeof document !== 'undefined') view = createLootView(game, system);
  return system;
}

export { WEAPON_IDS, HEAL_IDS };
