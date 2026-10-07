// =============================================================================
// Aussehen aus dem Spind: Spitzhacken-Farben und Emote-Bewegungen
// =============================================================================
// Bewusst OHNE Änderungen an characterModel.js / weapons/models.js:
//   - stylePickaxe(): färbt ein fertiges Spitzhacken-Modell um. Welche Teile Kopf
//     (Metall), Stiel (Holz) und Band sind, wird an der Farbe erkannt – so klappt es
//     auch, wenn das Modell später anders gebaut wird.
//   - applyEmoteMotion(): bewegt die ganze Figur (root) zusätzlich zum Grund-Tanz
//     (hüpfen, drehen, wippen) – nach view.update().
//   - createPickaxeMount(id): Spitzhacke für Lobby/Spind – nutzt CONFIG.pickaxes.list (Formen),
//     falls es sie gibt, sonst die Farb-Varianten aus CONFIG.cosmetics.pickaxes
//   - createCosmeticsSystem(game): System für game.systems; wendet beides im Spiel auf
//     Figuren mit character.cosmetics = { pickaxe: {head, handle, band}, emote: 'hop' … } an.
// Werte: CONFIG.cosmetics (Spitzhacken-Farben, Emotes), Dauer: CONFIG.player.emoteDuration.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { pickaxeForms } from '../core/progress.js';
import { createWeaponModel, createHandMount } from '../weapons/models.js';

const _hsl = { h: 0, s: 0, l: 0 };

/** Welche Rolle hat diese Farbe in der Spitzhacke? 'head' | 'headDark' | 'handle' | 'band' */
export function pickaxeRole(color) {
  color.getHSL(_hsl);
  if (_hsl.s < 0.18) return _hsl.l > 0.42 ? 'head' : 'headDark'; // grau = Metall
  if (_hsl.h > 0.03 && _hsl.h < 0.14 && _hsl.l < 0.6) return 'handle'; // braun = Holz
  return 'band';
}

/**
 * Färbt ein Spitzhacken-Modell (oder seinen Halter) um. Materialien werden kopiert
 * (geteilte Materialien anderer Modelle bleiben unverändert) und beim Neu-Färben entsorgt.
 * @param {THREE.Object3D} root
 * @param {{ id?, head, handle, band }} style
 */
export function stylePickaxe(root, style) {
  if (!root || !style) return;
  const tmp = new THREE.Color();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material || Array.isArray(obj.material)) return;
    const original = obj.userData.cosmeticOriginal ?? obj.material;
    if (!obj.userData.cosmeticOriginal) obj.userData.cosmeticOriginal = original;
    if (!original.color) return;
    const role = pickaxeRole(original.color);
    const target = role === 'handle' ? style.handle : role === 'band' ? style.band : style.head;
    if (!target) return;
    if (obj.material !== original) obj.material.dispose(); // alte Kopie weg
    const material = original.clone();
    tmp.set(target);
    if (role === 'headDark') tmp.multiplyScalar(0.62);
    material.color.copy(tmp);
    obj.material = material;
  });
  root.userData.pickaxeStyle = style.id ?? 'eigen';
}

/** Zurück zu den Original-Farben (Kopien entsorgen). */
export function unstylePickaxe(root) {
  root?.traverse((obj) => {
    const original = obj.userData?.cosmeticOriginal;
    if (!original) return;
    if (obj.material !== original) obj.material.dispose();
    obj.material = original;
  });
  if (root) delete root.userData.pickaxeStyle;
}

/**
 * Zusatz-Bewegung beim Emote (nach view.update aufrufen).
 * @param {THREE.Object3D} root  view.root
 * @param {string} motion  'dance' | 'sway' | 'hop' | 'spin' | 'rocket'
 * @param {number} age     Sekunden seit Emote-Beginn (< 0 = kein Emote → alles zurück)
 */
export function applyEmoteMotion(root, motion, age) {
  if (!root) return;
  if (!(age >= 0) || !motion || motion === 'dance') {
    root.rotation.z = 0;
    return;
  }
  const beat = age * 7;
  switch (motion) {
    case 'sway':
      root.rotation.z = Math.sin(beat * 0.5) * 0.16;
      break;
    case 'hop':
      root.rotation.z = 0;
      root.position.y += Math.abs(Math.sin(beat * 0.5)) * 0.45;
      break;
    case 'spin':
      root.rotation.z = 0;
      root.rotation.y += age * 7;
      break;
    case 'rocket': {
      root.rotation.z = 0;
      // hoch – kurz schweben – zurück (über die ganze Emote-Dauer)
      const d = CONFIG.player.emoteDuration ?? 3;
      const p = Math.min(1, age / d);
      root.position.y += Math.sin(p * Math.PI) * 1.6 + Math.abs(Math.sin(beat)) * 0.08;
      root.rotation.y += age * 10;
      break;
    }
    default:
      root.rotation.z = 0;
  }
}

/** Bewegung eines Emotes aus CONFIG.cosmetics.emotes (unbekannt → 'dance'). */
export function emoteMotion(emoteId) {
  return CONFIG.cosmetics.emotes.find((e) => e.id === emoteId)?.motion ?? 'dance';
}

/**
 * Farben einer Spitzhacke aus CONFIG.cosmetics.pickaxes (unbekannt → null).
 * Gibt es eigene Spitzhacken-Formen (CONFIG.pickaxes.list), baut models.js sie schon
 * richtig – dann wird nichts umgefärbt (null).
 */
export function pickaxeStyle(pickaxeId) {
  if (pickaxeForms()) return null;
  return CONFIG.cosmetics.pickaxes.find((p) => p.id === pickaxeId) ?? null;
}

/**
 * Spitzhacke für die Hand (Lobby, Spind-Bilder): mit Formen-Liste die passende Form,
 * sonst die Standard-Hacke in den Farben der Variante.
 * @param {string} pickaxeId
 * @returns {THREE.Group}  Halter (an die Hand hängen)
 */
export function createPickaxeMount(pickaxeId) {
  if (pickaxeForms()) {
    // createWeaponModel('pickaxe', id): das 2. Feld ist bei der Spitzhacke ihre id (CONFIG.pickaxes)
    const mount = createHandMount('pickaxe', createWeaponModel('pickaxe', pickaxeId));
    mount.userData.pickaxeStyle = pickaxeId;
    return mount;
  }
  const mount = createHandMount('pickaxe', createWeaponModel('pickaxe'));
  stylePickaxe(mount, pickaxeStyle(pickaxeId) ?? CONFIG.cosmetics.pickaxes[0]);
  return mount;
}

/**
 * System für game.systems (nur Bild, keine Logik): Spitzhacken-Farben und Emote-Bewegung
 * für alle Figuren mit character.cosmetics.
 */
export function createCosmeticsSystem(game) {
  const duration = CONFIG.player.emoteDuration ?? 3;
  return {
    update() {},
    frameUpdate() {
      const list = game.characters;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const cos = c.cosmetics;
        if (!cos || !c.view) continue;
        // Spitzhacke in der Hand? (Halter-Name aus weapons/models.js: "Halter pickaxe")
        if (cos.pickaxe) {
          const hand = c.view.rightHand;
          for (let k = 0; k < hand.children.length; k++) {
            const mount = hand.children[k];
            if (/pickaxe/i.test(mount.name) && mount.userData.pickaxeStyle !== cos.pickaxe.id) stylePickaxe(mount, cos.pickaxe);
          }
        }
        if (cos.emote && cos.emote !== 'dance') {
          const dancing = c.alive && c.time < c.emoteUntil;
          applyEmoteMotion(c.view.root, cos.emote, dancing ? c.time - (c.emoteUntil - duration) : -1);
        }
      }
    },
    dispose() {},
  };
}
