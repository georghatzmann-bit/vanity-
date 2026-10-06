// Hilfen für Waffen-Tests: Schütze mit einfachem "Gehirn" (Abzug, Zielen, Waffe wählen)
// und Ziel-Figuren ohne KI.
import * as THREE from 'three';
import { resetCommand } from '../../src/player.js';
import { createTestGame } from './helpers.js';

export { createTestGame };

/**
 * Schütze: Das Gehirn zielt jeden Tick von den Augen auf ctl.aimAt (falls gesetzt).
 * ctl.primary = gedrückt halten, ctl.click() = einmal klicken (ein Tick),
 * ctl.select(n) = Platz n wählen, ctl.reload() = R, ctl.pickaxe() = F.
 * ctl.aimOriginOffset (Vector3) verschiebt den Start des Ziel-Strahls (z. B. wie die Schulter-Kamera).
 */
export function addShooter(game, options = {}) {
  const c = game.addCharacter({ name: 'Schütze', team: 1, shield: 0, position: { x: 0, y: 0, z: 0 }, ...options, brain: null });
  const ctl = {
    primary: false,
    secondary: false,
    moveZ: 0,
    aimAt: null,
    aimOriginOffset: null,
    _press: false,
    _slot: 0,
    _reload: false,
    _pickaxe: false,
    _build: null,
    click() {
      this._press = true;
    },
    select(slot) {
      this._slot = slot;
    },
    reload() {
      this._reload = true;
    },
    pickaxe() {
      this._pickaxe = true;
    },
    build(piece) {
      this._build = piece;
    },
  };
  const eye = new THREE.Vector3();
  c.brain = {
    ctl,
    think() {
      const cmd = c.command;
      resetCommand(cmd, c.yaw, c.pitch);
      if (ctl.aimAt) {
        c.eyePosition(eye);
        const dx = ctl.aimAt.x - eye.x;
        const dy = ctl.aimAt.y - eye.y;
        const dz = ctl.aimAt.z - eye.z;
        cmd.yaw = Math.atan2(-dx, -dz);
        cmd.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        cmd.aimOrigin.copy(eye);
        if (ctl.aimOriginOffset) cmd.aimOrigin.add(ctl.aimOriginOffset);
        cmd.aimDir.set(ctl.aimAt.x, ctl.aimAt.y, ctl.aimAt.z).sub(cmd.aimOrigin).normalize();
      }
      cmd.moveZ = ctl.moveZ;
      cmd.primary = ctl.primary || ctl._press;
      cmd.primaryPressed = ctl._press;
      cmd.secondary = ctl.secondary;
      cmd.selectSlot = ctl._slot;
      cmd.selectPickaxe = ctl._pickaxe;
      cmd.selectBuild = ctl._build;
      cmd.reloadOrRotate = ctl._reload;
      ctl._press = false;
      ctl._slot = 0;
      ctl._reload = false;
      ctl._pickaxe = false;
      ctl._build = null;
      return cmd;
    },
  };
  return { c, ctl };
}

/** Ziel-Figur ohne KI (steht still). */
export function addTarget(game, position, options = {}) {
  return game.addCharacter({ name: 'Ziel', team: 2, health: 100, shield: 0, position, yaw: 0, ...options, brain: null });
}

/** Körpermitte bzw. Kopf einer Figur als Ziel-Punkt. */
export function bodyPoint(c) {
  return new THREE.Vector3(c.position.x, c.position.y + 1.0, c.position.z);
}

export function headPoint(c) {
  return new THREE.Vector3(c.position.x, c.position.y + c.height - 0.12, c.position.z);
}

/** Bauteil-Attrappe: Box-Collider mit data.kind 'piece' und ref.applyDamage (wie das Bau-System). */
export function addFakePiece(game, min, max, health = 150) {
  const ref = {
    health,
    taken: 0,
    hits: 0,
    lastInfo: null,
    applyDamage(amount, info) {
      this.taken += amount;
      this.health -= amount;
      this.hits++;
      this.lastInfo = info;
      return amount;
    },
  };
  const collider = game.world.addBox(min, max, { kind: 'piece', ref, blocksBullets: true });
  ref.collider = collider;
  return ref;
}

/** Simuliert, bis die Bedingung stimmt (höchstens maxSeconds). Liefert die vergangene Zeit oder -1. */
export function simulateUntil(game, predicate, maxSeconds = 5) {
  const start = game.time;
  const steps = Math.round(maxSeconds * 60);
  for (let i = 0; i < steps; i++) {
    game.fixedUpdate(1 / 60);
    if (predicate()) return game.time - start;
  }
  return -1;
}
