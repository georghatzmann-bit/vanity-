// =============================================================================
// Fliegen im Kreativ-Modus (wie in Fortnite Kreativ)
// =============================================================================
// - 2× schnell Springen (innerhalb CONFIG.modes.creative.fly.doubleTapTime) schaltet
//   das Fliegen an – nochmal 2× Springen schaltet es aus (man fällt normal).
// - Beim Fliegen: keine Schwerkraft, WASD waagerecht in Blickrichtung,
//   Springen gehalten = hoch, Ducken gehalten = runter, Sprinten = schneller.
// - Wer beim Hinunterfliegen den Boden berührt, landet (Fliegen aus).
// - Bauen, Editieren und Schießen gehen auch im Flug.
// Eigene Bewegungs-Art 'fly' über registerMoveStateHandler (player.js) – läuft
// ohne Bildschirm (Tests).
// =============================================================================
import { CONFIG } from '../config.js';
import { registerMoveStateHandler, landCharacter, bodyFits, findSupport } from '../player.js';

const P = CONFIG.player;

/** Fliegt die Figur gerade? */
export function isFlying(ch) {
  return ch.moveState === 'fly';
}

/** Fliegen anschalten (Tests und Doppel-Sprung). */
export function startFlying(ch) {
  if (!ch.alive || ch.moveState === 'fly') return;
  ch.moveState = 'fly';
  ch.grounded = false;
  ch.velocity.y = 0;
  // Sprung-Puffer leeren – sonst springt man nach dem Landen von selbst
  ch.jumpBuffer = 0;
  ch.coyoteTimer = 0;
  ch.airPeakY = ch.position.y;
  if (ch.crouching) {
    ch.crouching = false;
    ch.height = P.hitbox.height;
  }
  ch.game?.events?.emit('fly', { character: ch, flying: true });
}

/** Fliegen ausschalten: man fällt ganz normal weiter (in der Luft). */
export function stopFlying(ch) {
  if (ch.moveState !== 'fly') return;
  ch.moveState = 'air';
  ch.grounded = false;
  ch.velocity.y = Math.min(0, ch.velocity.y);
  ch.airPeakY = ch.position.y;
  ch.game?.events?.emit('fly', { character: ch, flying: false });
}

/**
 * Doppel-Sprung erkennen (nach der Bewegung im Tick aufrufen, z. B. in mode.update).
 * Merkt sich die Zeit des letzten Sprung-Drucks in ch.flyTapTime.
 * @returns {boolean} true, wenn das Fliegen gerade an- oder ausgeschaltet wurde
 */
export function updateFlyToggle(ch, command, time) {
  if (!ch.alive || !command?.jumpPressed) return false;
  const last = ch.flyTapTime ?? -Infinity;
  if (time - last <= CONFIG.modes.creative.fly.doubleTapTime) {
    ch.flyTapTime = -Infinity; // ein dritter Druck zählt wieder als "erster"
    if (isFlying(ch)) stopFlying(ch);
    else startFlying(ch);
    return true;
  }
  ch.flyTapTime = time;
  return false;
}

// Tempo sanft an das Ziel angleichen (höchstens accel · dt)
function approach(current, target, maxStep) {
  const d = target - current;
  return Math.abs(d) <= maxStep ? target : current + Math.sign(d) * maxStep;
}

/** Bewegung im Flug (Handler für moveState 'fly'). */
function flyHandler(ch, cmd, dt, world) {
  const F = CONFIG.modes.creative.fly;
  ch.grounded = false;
  if (ch.crouching) {
    ch.crouching = false; // Ducken heißt im Flug "runter" – die Figur bleibt aufrecht
    ch.height = P.hitbox.height;
  }
  // --- gewünschtes Tempo ----------------------------------------------------------
  let mx = cmd.moveX || 0;
  let mz = cmd.moveZ || 0;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  ch.sprinting = !!cmd.sprint && len > 0.1;
  const speed = ch.sprinting ? F.sprintSpeed : F.speed;
  const sin = Math.sin(ch.yaw);
  const cos = Math.cos(ch.yaw);
  // vorwärts = (−sin, 0, −cos), rechts = (cos, 0, −sin)  (ARCHITECTURE.md §2)
  const wishX = (cos * mx - sin * mz) * speed;
  const wishZ = (-sin * mx - cos * mz) * speed;
  const vertical = (cmd.jump ? 1 : 0) - (cmd.crouch ? 1 : 0);
  const wishY = vertical * (ch.sprinting ? F.sprintVerticalSpeed : F.verticalSpeed);
  const step = F.acceleration * dt;
  ch.velocity.x = approach(ch.velocity.x, wishX, step);
  ch.velocity.z = approach(ch.velocity.z, wishZ, step);
  ch.velocity.y = approach(ch.velocity.y, wishY, step);

  // --- bewegen (in Teilschritten, damit man nicht durch dünne Wände fliegt) ---------
  const p = ch.position;
  const r = ch.radius;
  const h = ch.height;
  const dx = ch.velocity.x * dt;
  const dy = ch.velocity.y * dt;
  const dz = ch.velocity.z * dt;
  const steps = Math.min(P.maxSubsteps, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / P.maxSubstepDistance)));
  for (let i = 0; i < steps; i++) {
    const nx = p.x + dx / steps;
    if (bodyFits(world, nx, p.y, p.z, r, h)) p.x = nx;
    else ch.velocity.x = 0;
    const nz = p.z + dz / steps;
    if (bodyFits(world, p.x, p.y, nz, r, h)) p.z = nz;
    else ch.velocity.z = 0;
    const sy = dy / steps;
    if (sy < 0) {
      // runter: Boden darunter? → landen (Fliegen aus)
      const support = findSupport(world, p.x, p.y, p.z, r, p.y + sy);
      if (support > -Infinity) {
        p.y = support;
        ch.velocity.set(ch.velocity.x * 0.3, 0, ch.velocity.z * 0.3);
        ch.airPeakY = p.y;
        landCharacter(ch, { noDamage: true });
        ch.game?.events?.emit('fly', { character: ch, flying: false });
        return;
      }
      p.y += sy;
    } else if (sy > 0) {
      const ny = Math.min(p.y + sy, F.maxHeight);
      if (bodyFits(world, p.x, ny, p.z, r, h)) p.y = ny;
      else ch.velocity.y = 0;
    }
  }
  ch.airPeakY = p.y; // im Flug zählt keine Fallhöhe
}

let installed = false;
/** Meldet die Bewegungs-Art 'fly' an (einmal; passiert beim Laden dieser Datei). */
export function installCreativeFly() {
  if (installed) return;
  installed = true;
  registerMoveStateHandler('fly', flyHandler);
}

installCreativeFly();
