// =============================================================================
// Spieler-Steuerung: Eingabe → Befehl (CharacterCommand)
// =============================================================================
// Einmal pro Logik-Schritt wird aus dem Eingabe-Zustand (input.sample()) und
// der Kamera ein Befehl für die Spieler-Figur gemacht:
//   - Maus/Stick drehen den Blick (Empfindlichkeit aus den Einstellungen,
//     beim Zielen/Bauen/Editieren mit eigenem Faktor, Y-Achse umkehrbar)
//   - WASD/Stick → Laufrichtung
//   - Ducken halten oder umschalten (Einstellung), Sprinten (nur wenn Ducken auf Strg)
//   - alle "einmal gedrückt"-Aktionen (Bauteil wählen, Waffe wählen, Edit …)
//   - Ziel-Strahl aus der Kamera (aimOrigin/aimDir) – genau aus dem Zustand der
//     Figur berechnet, NICHT aus der gemalten Kamera. So treffen Schüsse und
//     Bauteile immer gleich, egal wie viele Bilder pro Sekunde der PC schafft.
//
// Aim-Assist (nur Controller, abschaltbar): Ist ein Gegner nah am Fadenkreuz,
// dreht die Kamera etwas langsamer ("Klebe-Effekt"). Sie dreht sich NIE von
// selbst zum Gegner.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { resetCommand } from './player.js';

const DEG = Math.PI / 180;
const MIN_PITCH = CONFIG.camera.minPitch * DEG;
const MAX_PITCH = CONFIG.camera.maxPitch * DEG;
const TWO_PI = Math.PI * 2;

const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();

/** Hält einen Winkel im Bereich −π … π (verhindert riesige Zahlen nach vielen Drehungen). */
export function wrapAngle(a) {
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a < -Math.PI) a += TWO_PI;
  return a;
}

/** Neigung auf die erlaubten Grenzen beschränken. */
export function clampPitch(p) {
  return p < MIN_PITCH ? MIN_PITCH : p > MAX_PITCH ? MAX_PITCH : p;
}

/**
 * Multiplikator je nach Modus (wie in Fortnite, alle Werte in %):
 * Edit, Bauen, Zielen (Targeting), Zielfernrohr (Scope); sonst 1.
 * @returns {number}
 */
export function modeSensitivity(character, sensitivity) {
  if (character.mode === 'edit') return sensitivity.edit / 100;
  if (character.mode === 'build') return sensitivity.build / 100;
  if (character.aiming) return (character.scopeFov ? sensitivity.scope : sensitivity.targeting) / 100;
  return 1;
}

/** Drehung (Radiant) pro Maus-Count bei 1 % Empfindlichkeit – Fortnite: 0,5555° bei 100 %. */
export const RADIANS_PER_COUNT_PER_PERCENT = (CONFIG.sensitivity.degreesPerCount * DEG) / 100;

/**
 * Drehung durch Maus-Counts (dx, dy) – gleiche Rechnung wie im Logik-Schritt.
 * Die Kamera benutzt das, um noch nicht verrechnete Maus-Bewegung sofort zu zeigen.
 * Schreibt in out { yaw, pitch }.
 */
export function applyMouseLook(character, settings, dx, dy, yaw, pitch, out) {
  const s = settings.sensitivity;
  const factor = RADIANS_PER_COUNT_PER_PERCENT * modeSensitivity(character, s);
  // Maus nach rechts → yaw wird kleiner; Maus nach unten → Blick nach unten
  out.yaw = yaw - dx * factor * s.x;
  out.pitch = clampPitch(pitch - dy * factor * s.y * (s.invertY ? -1 : 1));
  return out;
}

/**
 * Ist ein Gegner nah am Fadenkreuz? (für den Aim-Assist)
 * @returns {boolean}
 */
export function enemyNearCrosshair(character, game, yaw, pitch) {
  const assist = CONFIG.controls.gamepad.aimAssist;
  const list = game?.characters;
  if (!list) return false;
  character.eyePosition(_eye);
  const cp = Math.cos(pitch);
  _dir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  const cosLimit = Math.cos(assist.radiusDeg * DEG);
  for (let i = 0; i < list.length; i++) {
    const other = list[i];
    if (other === character || !other.alive || other.team === character.team) continue;
    _to.set(other.position.x, other.position.y + other.height * 0.6, other.position.z).sub(_eye);
    const dist = _to.length();
    if (dist < 0.5 || dist > assist.maxDistance) continue;
    if (_to.dot(_dir) / dist >= cosLimit) return true;
  }
  return false;
}

/**
 * Erzeugt die Spieler-Steuerung. Sie merkt sich nur wenig (Ducken-Umschalter).
 * @returns {{ buildCommand: Function, reset: Function, crouchLatched: boolean, aimAssistActive: boolean }}
 */
export function createPlayerController() {
  const look = { yaw: 0, pitch: 0 };

  const controller = {
    crouchLatched: false, // Ducken (Umschalt-Modus) gerade an?
    aimAssistActive: false, // für Tests/Anzeige: wurde in diesem Tick gebremst?

    reset() {
      controller.crouchLatched = false;
      controller.aimAssistActive = false;
    },

    /**
     * Füllt character.command aus dem Eingabe-Zustand und gibt ihn zurück.
     * @param {object} sample     input.sample()
     * @param {Character} character
     * @param {object} cameraRig  ThirdPersonCamera (für den Ziel-Strahl) oder null
     * @param {object} settings
     * @param {object} game
     */
    buildCommand(sample, character, cameraRig, settings, game) {
      const cmd = character.command;
      const held = sample.held;
      const pressed = sample.pressed;
      const released = sample.released;
      const s = settings.sensitivity;
      const dt = sample.dt || 1 / CONFIG.loop.tickRate;

      // --- Blick ------------------------------------------------------------------
      applyMouseLook(character, settings, sample.lookDX, sample.lookDY, character.yaw, character.pitch, look);
      let yaw = look.yaw;
      let pitch = look.pitch;
      controller.aimAssistActive = false;
      if (sample.lookAxisX !== 0 || sample.lookAxisY !== 0) {
        const sens = CONFIG.sensitivity;
        const modeFactor = modeSensitivity(character, s);
        let assist = 1;
        if (sample.device === 'gamepad' && settings.controls.aimAssist && CONFIG.controls.gamepad.aimAssist.enabled &&
          enemyNearCrosshair(character, game, yaw, pitch)) {
          assist = CONFIG.controls.gamepad.aimAssist.slowdownFactor;
          controller.aimAssistActive = true;
        }
        const speed = sens.gamepadLookSpeed * dt * modeFactor * assist;
        const ax = Math.sign(sample.lookAxisX) * Math.abs(sample.lookAxisX) ** sens.gamepadLookExponent;
        const ay = Math.sign(sample.lookAxisY) * Math.abs(sample.lookAxisY) ** sens.gamepadLookExponent;
        yaw -= ax * speed * s.x;
        // Stick nach oben (negativ) = nach oben schauen
        pitch = clampPitch(pitch - ay * speed * s.y * (s.invertY ? -1 : 1));
      }
      cmd.yaw = wrapAngle(yaw);
      cmd.pitch = pitch;

      if (!character.alive) {
        resetCommand(cmd, cmd.yaw, cmd.pitch);
        controller.crouchLatched = false;
        return cmd;
      }

      // --- Laufen -------------------------------------------------------------------
      let mx = (held.moveRight ? 1 : 0) - (held.moveLeft ? 1 : 0) + sample.moveAxisX;
      let mz = (held.moveForward ? 1 : 0) - (held.moveBack ? 1 : 0) + sample.moveAxisZ;
      const len = Math.hypot(mx, mz);
      if (len > 1) {
        mx /= len;
        mz /= len;
      }
      cmd.moveX = mx;
      cmd.moveZ = mz;

      // --- Springen, Ducken, Sprinten ------------------------------------------------
      cmd.jump = held.jump || pressed.jump;
      cmd.jumpPressed = pressed.jump;
      if (settings.controls.crouchToggle) {
        if (pressed.crouch) controller.crouchLatched = !controller.crouchLatched;
        // Springen oder Sprinten beendet das Ducken (wie gewohnt in solchen Spielen)
        if (pressed.jump || (held.sprint && settings.controls.crouchOnCtrl)) controller.crouchLatched = false;
        cmd.crouch = controller.crouchLatched;
      } else {
        controller.crouchLatched = false;
        cmd.crouch = held.crouch || pressed.crouch;
      }
      cmd.sprint = !!settings.controls.crouchOnCtrl && held.sprint;

      // --- Schießen / Bauen / Zielen ---------------------------------------------------
      cmd.primary = held.primary || pressed.primary;
      cmd.primaryPressed = pressed.primary;
      cmd.primaryReleased = released.primary;
      cmd.secondary = held.secondary || pressed.secondary;
      cmd.secondaryPressed = pressed.secondary;
      cmd.secondaryReleased = released.secondary;

      // --- Auswahl (einmal gedrückt) -----------------------------------------------------
      cmd.selectSlot = pressed.slot1 ? 1 : pressed.slot2 ? 2 : pressed.slot3 ? 3 : pressed.slot4 ? 4 : pressed.slot5 ? 5 : 0;
      cmd.selectPickaxe = pressed.pickaxe;
      cmd.selectBuild = pressed.buildWall ? 'wall' : pressed.buildFloor ? 'floor'
        : pressed.buildRamp ? 'ramp' : pressed.buildRoof ? 'roof' : null;
      cmd.toggleBuild = pressed.toggleBuild;
      cmd.reloadOrRotate = pressed.reloadOrRotate;
      cmd.edit = held.edit;
      cmd.editPressed = pressed.edit;
      cmd.editReleased = released.edit;
      cmd.usePressed = pressed.use;
      cmd.emotePressed = pressed.emote;
      cmd.switchMaterial = pressed.switchMaterial;
      cmd.nextItem = pressed.nextItem;
      cmd.prevItem = pressed.prevItem;

      // --- Ziel-Strahl aus der Kamera ------------------------------------------------------
      if (cameraRig) {
        cameraRig.computeAimRay(character, game?.world ?? null, cmd.aimOrigin, cmd.aimDir, cmd.yaw, cmd.pitch);
      } else {
        character.eyePosition(cmd.aimOrigin);
        const cp = Math.cos(cmd.pitch);
        cmd.aimDir.set(-Math.sin(cmd.yaw) * cp, Math.sin(cmd.pitch), -Math.cos(cmd.yaw) * cp);
      }
      return cmd;
    },
  };
  return controller;
}
