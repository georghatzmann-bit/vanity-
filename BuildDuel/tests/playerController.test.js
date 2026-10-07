// Tests für die Spieler-Steuerung (src/playerController.js)
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createPlayerController, wrapAngle, RADIANS_PER_COUNT_PER_PERCENT } from '../src/playerController.js';
import { Character } from '../src/player.js';
import { Input } from '../src/input.js';
import { defaultSettings } from '../src/core/settings.js';
import { CollisionWorld } from '../src/physics.js';
import { ThirdPersonCamera } from '../src/camera.js';

const DEG = Math.PI / 180;
// Drehung pro Maus-Count bei der Standard-Empfindlichkeit (Fortnite: 0,5555° × X %)
const BASE = RADIANS_PER_COUNT_PER_PERCENT * CONFIG.sensitivity.x;

function setup(settings = defaultSettings()) {
  const world = new CollisionWorld();
  const game = { time: 0, tick: 0, world, characters: [], events: { emit() {} }, building: { canEdit: () => false } };
  const player = new Character(game, { isPlayer: true, team: 1, position: { x: 0, y: 0, z: 0 } });
  game.characters.push(player);
  const input = new Input(settings, { getGamepads: () => [], now: () => 0 });
  const controller = createPlayerController();
  const rig = new ThirdPersonCamera(null);
  const step = () => {
    const cmd = controller.buildCommand(input.sample(1 / 60), player, rig, settings, game);
    player.applySelection(cmd);
    player.yaw = cmd.yaw;
    player.pitch = cmd.pitch;
    return cmd;
  };
  return { world, game, player, input, controller, rig, settings, step };
}

describe('Spieler-Steuerung: Blick', () => {
  it('Maus nach rechts → yaw kleiner, Empfindlichkeit X wirkt', () => {
    const t = setup();
    t.input.addLook(100, 0);
    t.step();
    assert.close(t.player.yaw, -100 * BASE, 1e-9);
    t.settings.sensitivity.x = 2 * CONFIG.sensitivity.x;
    t.input.addLook(100, 0);
    t.step();
    assert.close(t.player.yaw, -300 * BASE, 1e-9);
  });

  it('Maus nach unten → Blick nach unten; Y umkehren dreht das um', () => {
    const t = setup();
    t.input.addLook(0, 50);
    t.step();
    assert.close(t.player.pitch, -50 * BASE, 1e-9);
    t.settings.sensitivity.invertY = true;
    t.input.addLook(0, 50);
    t.step();
    assert.close(t.player.pitch, 0, 1e-9);
  });

  it('Neigung wird begrenzt (±80°)', () => {
    const t = setup();
    t.input.addLook(0, -100000);
    t.step();
    assert.close(t.player.pitch, CONFIG.camera.maxPitch * DEG, 1e-9);
    t.input.addLook(0, 100000);
    t.step();
    assert.close(t.player.pitch, CONFIG.camera.minPitch * DEG, 1e-9);
  });

  it('Empfindlichkeit je Modus: Zielen, Zielfernrohr, Bauen, Editieren', () => {
    const cases = [
      ['targeting', (p) => { p.aiming = true; }],
      ['scope', (p) => { p.aiming = true; p.scopeFov = 20; }],
      ['build', (p) => { p.mode = 'build'; }],
      ['edit', (p) => { p.mode = 'edit'; }],
    ];
    for (const [key, prepare] of cases) {
      const t = setup();
      t.settings.sensitivity[key] = 50; // 50 %
      prepare(t.player);
      const cmd = t.controller.buildCommand((t.input.addLook(100, 0), t.input.sample(1 / 60)), t.player, null, t.settings, t.game);
      assert.close(cmd.yaw, -100 * BASE * 0.5, 1e-9, key);
    }
  });

  it('Fortnite-Umrechnung: 10 % = 0,05555° pro Count; 6,4 % bei 800 DPI ≈ 32 cm pro Drehung', () => {
    const t = setup();
    t.settings.sensitivity.x = 10;
    t.input.addLook(1000, 0);
    t.step();
    assert.close(-t.player.yaw / DEG, 1000 * 0.05555, 1e-6);
    const counts = 360 / (CONFIG.sensitivity.degreesPerCount * 6.4 / 100);
    assert.close((counts / 800) * 2.54, 32.1, 0.2);
  });

  it('Bauen/Edit 100 % = gleiche Drehung wie normal (Fortnite-Standard)', () => {
    const t = setup();
    assert.equal(t.settings.sensitivity.build, 100);
    assert.equal(t.settings.sensitivity.edit, 100);
    t.player.mode = 'build';
    const cmd = t.controller.buildCommand((t.input.addLook(100, 0), t.input.sample(1 / 60)), t.player, null, t.settings, t.game);
    assert.close(cmd.yaw, -100 * BASE, 1e-9);
  });

  it('yaw bleibt im Bereich −π … π', () => {
    const t = setup();
    for (let i = 0; i < 20; i++) {
      t.input.addLook(2000, 0);
      t.step();
      assert.ok(t.player.yaw >= -Math.PI && t.player.yaw <= Math.PI);
    }
    assert.close(wrapAngle(3 * Math.PI), Math.PI, 1e-9);
  });
});

describe('Spieler-Steuerung: Befehl', () => {
  it('WASD → Laufrichtung, schräg auf Länge 1 begrenzt', () => {
    const t = setup();
    t.input.setVirtual('moveForward', true);
    t.input.setVirtual('moveRight', true);
    const cmd = t.step();
    assert.close(Math.hypot(cmd.moveX, cmd.moveZ), 1, 1e-9);
    assert.ok(cmd.moveX > 0 && cmd.moveZ > 0);
  });

  it('Ducken halten (Standard) und umschalten (Einstellung)', () => {
    const t = setup();
    t.input.setVirtual('crouch', true);
    assert.ok(t.step().crouch);
    t.input.setVirtual('crouch', false);
    assert.ok(!t.step().crouch);
    t.settings.controls.crouchToggle = true;
    t.input.setVirtual('crouch', true);
    assert.ok(t.step().crouch);
    t.input.setVirtual('crouch', false);
    assert.ok(t.step().crouch, 'bleibt geduckt nach dem Loslassen');
    t.input.setVirtual('crouch', true);
    assert.ok(!t.step().crouch, 'zweites Drücken: aufstehen');
    t.input.setVirtual('crouch', false);
    t.step();
    t.input.setVirtual('crouch', true);
    t.step();
    t.input.setVirtual('crouch', false);
    t.input.setVirtual('jump', true);
    assert.ok(!t.step().crouch, 'Springen beendet das Ducken');
  });

  it('Sprinten nur, wenn Ducken auf Strg liegt', () => {
    const t = setup();
    t.input.setVirtual('sprint', true);
    assert.ok(!t.step().sprint);
    t.settings.controls.crouchOnCtrl = true;
    assert.ok(t.step().sprint);
  });

  it('einmal-Aktionen: Bauteil, Waffe, Spitzhacke, Edit, Benutzen, Tanz, Rad', () => {
    const t = setup();
    // Der Befehl wird wiederverwendet – darum Kopien vergleichen
    const pressOnce = (action) => {
      t.input.setVirtual(action, true);
      const cmd = { ...t.step() };
      t.input.setVirtual(action, false);
      const after = { ...t.step() };
      return { cmd, after };
    };
    let r = pressOnce('buildRamp');
    assert.equal(r.cmd.selectBuild, 'ramp');
    assert.equal(r.after.selectBuild, null, 'nur im Tick des Drückens');
    assert.equal(t.player.mode, 'build');
    r = pressOnce('slot3');
    assert.equal(r.cmd.selectSlot, 3);
    assert.equal(t.player.mode, 'weapon');
    assert.ok(pressOnce('pickaxe').cmd.selectPickaxe);
    r = pressOnce('edit');
    assert.ok(r.cmd.editPressed && r.cmd.edit);
    assert.ok(r.after.editReleased);
    assert.ok(pressOnce('use').cmd.usePressed);
    assert.ok(pressOnce('emote').cmd.emotePressed);
    assert.ok(pressOnce('reloadOrRotate').cmd.reloadOrRotate);
    assert.ok(pressOnce('switchMaterial').cmd.switchMaterial);
    assert.ok(pressOnce('nextItem').cmd.nextItem);
    r = pressOnce('primary');
    assert.ok(r.cmd.primary && r.cmd.primaryPressed && r.after.primaryReleased);
  });

  it('Ziel-Strahl: Richtung = Blick, Start auf Höhe der Augen (nicht hinter der Figur)', () => {
    const t = setup();
    t.input.addLook(-200, -60);
    const cmd = t.step();
    const dir = new THREE.Vector3();
    t.player.aimDirection(dir);
    assert.close(cmd.aimDir.distanceTo(dir), 0, 1e-9, 'Richtung');
    const eye = t.player.eyePosition(new THREE.Vector3());
    const offset = eye.clone().sub(cmd.aimOrigin);
    assert.close(offset.dot(cmd.aimDir), 0, 1e-6, 'Start liegt auf Augen-Tiefe');
    assert.ok(offset.length() <= CONFIG.camera.shoulderOffset + 0.05, 'nah an den Augen');
    // gleiche Lage → gleicher Strahl (unabhängig vom Bild)
    const again = t.rig.computeAimRay(t.player, t.world, new THREE.Vector3(), new THREE.Vector3());
    assert.close(again.distanceTo(cmd.aimOrigin), 0, 1e-9);
  });

  it('besiegt: keine Bewegung, aber umschauen geht', () => {
    const t = setup();
    t.player.alive = false;
    t.input.setVirtual('moveForward', true);
    t.input.addLook(100, 0);
    const cmd = t.step();
    assert.equal(cmd.moveZ, 0);
    assert.ok(cmd.yaw < 0);
  });
});

describe('Spieler-Steuerung: Aim-Assist (nur Controller)', () => {
  function pad(rightX) {
    const buttons = [];
    for (let i = 0; i < 17; i++) buttons.push({ pressed: false, value: 0 });
    return { connected: true, mapping: 'standard', axes: [0, 0, rightX, 0], buttons };
  }
  function turnWith(enemyInFront, aimAssistOn = true) {
    const settings = defaultSettings();
    settings.controls.aimAssist = aimAssistOn;
    const pads = [pad(0.8)];
    const t = setup(settings);
    t.input.getGamepads = () => pads;
    if (enemyInFront) {
      const enemy = new Character(t.game, { team: 2, position: { x: 0, y: 0, z: -15 } });
      t.game.characters.push(enemy);
    }
    t.step();
    return { yaw: t.player.yaw, active: t.controller.aimAssistActive };
  }

  it('Gegner am Fadenkreuz → Drehung um 30 % langsamer, nie automatisches Zielen', () => {
    const free = turnWith(false);
    const slowed = turnWith(true);
    assert.ok(slowed.active && !free.active);
    assert.close(slowed.yaw / free.yaw, CONFIG.controls.gamepad.aimAssist.slowdownFactor, 1e-9);
  });

  it('abgeschaltet → keine Bremse', () => {
    const r = turnWith(true, false);
    assert.ok(!r.active);
  });

  it('Maus bekommt keinen Aim-Assist', () => {
    const t = setup();
    const enemy = new Character(t.game, { team: 2, position: { x: 0, y: 0, z: -15 } });
    t.game.characters.push(enemy);
    t.input.addLook(100, 0);
    t.step();
    assert.ok(!t.controller.aimAssistActive);
    assert.close(t.player.yaw, -100 * BASE, 1e-9);
  });
});
