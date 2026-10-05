// Tests für die Eingabe (src/input.js) – mit nachgespielten Tasten-Ereignissen
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import { Input, buildBindings } from '../src/input.js';
import { defaultSettings } from '../src/core/settings.js';

function key(code, extra = {}) {
  return { code, repeat: false, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
}
function mouse(button) {
  return { button, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}
function makeInput(settings = defaultSettings(), pads = []) {
  return new Input(settings, { getGamepads: () => pads, now: () => 0 });
}

describe('Eingabe: Tasten-Belegung', () => {
  it('Standard: Z und Y bauen eine Wand, Shift duckt, Mausrad wechselt', () => {
    const b = buildBindings(defaultSettings());
    assert.deepEqual(b.get('KeyZ'), ['buildWall']);
    assert.deepEqual(b.get('KeyY'), ['buildWall']);
    assert.deepEqual(b.get('ShiftLeft'), ['crouch']);
    assert.deepEqual(b.get('WheelDown'), ['nextItem']);
    assert.deepEqual(b.get('Mouse0'), ['primary']);
  });

  it('Ducken auf Strg: Strg duckt, Shift sprintet', () => {
    const s = defaultSettings();
    s.controls.crouchOnCtrl = true;
    const b = buildBindings(s);
    assert.deepEqual(b.get(CONFIG.controls.crouchCtrlKey), ['crouch']);
    assert.deepEqual(b.get('ShiftLeft'), ['sprint']);
  });

  it('eigene Belegung aus den Einstellungen', () => {
    const s = defaultSettings();
    s.controls.keyboard.jump = ['KeyJ'];
    const input = makeInput(s);
    input.handleKeyDown(key('Space'));
    input.handleKeyDown(key('KeyJ'));
    const st = input.sample();
    assert.ok(st.held.jump && st.pressed.jump);
    input.handleKeyUp(key('KeyJ'));
    input.handleKeyUp(key('Space'));
    assert.ok(!input.sample().held.jump);
  });
});

describe('Eingabe: Drücken und Loslassen', () => {
  it('pressed nur einmal, held solange gedrückt, released beim Loslassen', () => {
    const input = makeInput();
    input.handleKeyDown(key('KeyW'));
    let s = input.sample();
    assert.ok(s.held.moveForward && s.pressed.moveForward && !s.released.moveForward);
    input.handleKeyDown(key('KeyW', { repeat: true })); // Tasten-Wiederholung des Systems
    s = input.sample();
    assert.ok(s.held.moveForward && !s.pressed.moveForward, 'kein zweites pressed');
    input.handleKeyUp(key('KeyW'));
    s = input.sample();
    assert.ok(!s.held.moveForward && s.released.moveForward);
    s = input.sample();
    assert.ok(!s.released.moveForward, 'released nur einmal');
  });

  it('ganz kurzes Tippen zwischen zwei Ticks geht nicht verloren', () => {
    const input = makeInput();
    input.handleKeyDown(key('Space'));
    input.handleKeyUp(key('Space'));
    const s = input.sample();
    assert.ok(s.pressed.jump && s.released.jump && !s.held.jump);
  });

  it('zwei Tasten für dieselbe Aktion: erst wenn beide los sind, ist sie los', () => {
    const input = makeInput();
    input.handleKeyDown(key('KeyZ'));
    input.handleKeyDown(key('KeyY'));
    let s = input.sample();
    assert.ok(s.pressed.buildWall);
    input.handleKeyUp(key('KeyZ'));
    s = input.sample();
    assert.ok(s.held.buildWall && !s.released.buildWall);
    input.handleKeyUp(key('KeyY'));
    s = input.sample();
    assert.ok(!s.held.buildWall && s.released.buildWall);
  });

  it('Maus-Tasten zählen nur mit Maus-Sperre (Klick zum Sperren schießt nicht)', () => {
    const input = makeInput();
    input.handleMouseDown(mouse(0));
    assert.ok(!input.sample().pressed.primary);
    input.handleMouseUp(mouse(0));
    input.locked = true;
    input.handleMouseDown(mouse(2));
    const s = input.sample();
    assert.ok(s.pressed.secondary && s.held.secondary);
    input.handleMouseUp(mouse(2));
    assert.ok(input.sample().released.secondary);
  });

  it('Mausrad: eine Raste = einmal nextItem (pressed und released im selben Tick)', () => {
    const input = makeInput();
    input.playing = true;
    const e = { deltaY: 100, deltaMode: 0, preventDefault() { this.prevented = true; } };
    input.handleWheel(e);
    const s = input.sample();
    assert.ok(e.prevented, 'Seite scrollt nicht');
    assert.ok(s.pressed.nextItem && s.released.nextItem && !s.held.nextItem);
    assert.equal(s.wheel, 1);
    input.handleWheel({ deltaY: -3, deltaMode: 1, preventDefault() {} }); // Firefox: Zeilen
    assert.ok(input.sample().pressed.prevItem);
  });

  it('Mausrad im Menü (nicht spielend) wird nicht abgefangen', () => {
    const input = makeInput();
    const e = { deltaY: 100, deltaMode: 0, prevented: false, preventDefault() { this.prevented = true; } };
    input.handleWheel(e);
    assert.ok(!e.prevented && !input.sample().pressed.nextItem);
  });

  it('Maus-Bewegung zählt nur mit Sperre und wird pro Tick abgeholt', () => {
    const input = makeInput();
    input.handleMouseMove({ movementX: 10, movementY: 5 });
    assert.equal(input.sample().lookDX, 0);
    input.locked = true;
    input._lockTime = -10000;
    input.handleMouseMove({ movementX: 10, movementY: 5 });
    input.handleMouseMove({ movementX: 3, movementY: -1 });
    const s = input.sample();
    assert.equal(s.lookDX, 13);
    assert.equal(s.lookDY, 4);
    assert.equal(input.sample().lookDX, 0);
  });

  it('riesiger Sprung direkt nach dem Sperren wird ignoriert', () => {
    let now = 1000;
    const input = new Input(defaultSettings(), { getGamepads: () => [], now: () => now });
    input.locked = true;
    input._lockTime = 1000;
    input.handleMouseMove({ movementX: 2500, movementY: 0 });
    assert.equal(input.sample().lookDX, 0);
    now = 2000;
    input.handleMouseMove({ movementX: 2500, movementY: 0 });
    assert.equal(input.sample().lookDX, 2500, 'später ist ein schneller Schwenk erlaubt');
  });

  it('Spiel-Tasten werden beim Spielen blockiert, F5/F11/F12 nie', () => {
    const input = makeInput();
    const tab = key('Tab');
    input.handleKeyDown(tab);
    assert.ok(!tab.defaultPrevented, 'nicht spielend → nichts blockieren');
    input.playing = true;
    for (const code of ['Tab', 'Space', 'ArrowUp', 'KeyW', 'KeyQ']) {
      const e = key(code);
      input.handleKeyDown(e);
      assert.ok(e.defaultPrevented, code);
    }
    for (const code of ['F5', 'F11', 'F12']) {
      const e = key(code);
      input.handleKeyDown(e);
      assert.ok(!e.defaultPrevented, code);
    }
    const free = key('KeyP');
    input.handleKeyDown(free);
    assert.ok(!free.defaultPrevented, 'unbelegte Taste bleibt frei');
  });

  it('Tippen in ein Textfeld löst keine Aktion aus', () => {
    const input = makeInput();
    input.handleKeyDown(key('KeyW', { target: { tagName: 'INPUT' } }));
    assert.ok(!input.sample().held.moveForward);
  });

  it('releaseAll (Fenster verliert Fokus): alles los, released wird gemeldet', () => {
    const input = makeInput();
    input.handleKeyDown(key('KeyW'));
    input.setVirtual('jump', true);
    input.sample();
    input.releaseAll();
    const s = input.sample();
    assert.ok(!s.held.moveForward && s.released.moveForward);
    assert.ok(!s.held.jump && s.released.jump);
  });

  it('applySettings: neue Belegung, gedrückte Tasten werden losgelassen', () => {
    const input = makeInput();
    input.handleKeyDown(key('ShiftLeft'));
    assert.ok(input.sample().held.crouch);
    const s = defaultSettings();
    s.controls.crouchOnCtrl = true;
    input.applySettings(s);
    assert.ok(!input.sample().held.crouch);
    input.handleKeyDown(key('ShiftLeft'));
    input.handleKeyDown(key('ControlLeft'));
    const st = input.sample();
    assert.ok(st.held.sprint && st.held.crouch);
  });
});

describe('Eingabe: virtuell (Touch und Tests)', () => {
  it('setVirtual, addLook, setMoveAxis', () => {
    const input = makeInput();
    input.setVirtual('crouch', true);
    input.addLook(30, -10);
    input.setMoveAxis(0.5, 1);
    let s = input.sample();
    assert.ok(s.held.crouch && s.pressed.crouch);
    assert.equal(s.lookDX, 30);
    assert.equal(s.lookDY, -10);
    const len = Math.hypot(s.moveAxisX, s.moveAxisZ);
    assert.close(len, 1, 1e-9, 'Stick zusammen höchstens Länge 1');
    input.setVirtual('crouch', false);
    s = input.sample();
    assert.ok(s.released.crouch);
    assert.throws(() => input.setVirtual('gibtsnicht', true));
  });
});

describe('Eingabe: Controller', () => {
  function pad(buttons = {}, axes = [0, 0, 0, 0]) {
    const list = [];
    for (let i = 0; i < 17; i++) list.push({ pressed: !!buttons[i], value: buttons[i] ? 1 : 0 });
    return { connected: true, mapping: 'standard', axes, buttons: list };
  }

  it('Sticks mit Totzone: kleine Ausschläge = 0, voll = 1', () => {
    const pads = [pad({}, [0.1, 0.05, 0, 0])];
    const input = makeInput(defaultSettings(), pads);
    let s = input.sample();
    assert.equal(s.moveAxisX, 0);
    assert.equal(s.moveAxisZ, 0);
    pads[0] = pad({}, [0, -1, 1, 0]);
    s = input.sample();
    assert.close(s.moveAxisZ, 1, 1e-9, 'Stick nach oben = vorwärts');
    assert.close(s.lookAxisX, 1, 1e-9);
    assert.equal(s.device, 'gamepad');
  });

  it('Knöpfe: A springt, R2 schießt; im Baumodus baut R2 eine Wand', () => {
    const g = CONFIG.controls.gamepad;
    const pads = [pad({ [g.jump]: true, [g.fire]: true })];
    const input = makeInput(defaultSettings(), pads);
    let s = input.sample();
    assert.ok(s.pressed.jump && s.held.primary && !s.pressed.buildWall);
    pads[0] = pad({});
    input.sample();
    input.gamepadBuildMode = true;
    pads[0] = pad({ [g.buildMode.wall]: true });
    s = input.sample();
    assert.ok(s.pressed.buildWall && s.held.primary, 'R2 im Baumodus');
    pads[0] = pad({ [g.buildMode.ramp]: true });
    s = input.sample();
    assert.ok(s.pressed.buildRamp && s.released.buildWall);
  });

  it('B schaltet den Baumodus (toggleBuild), R3 duckt', () => {
    const g = CONFIG.controls.gamepad;
    const pads = [pad({ [g.toggleBuildMode]: true, [g.crouchOrRotate]: true })];
    const input = makeInput(defaultSettings(), pads);
    const s = input.sample();
    assert.ok(s.pressed.toggleBuild && s.held.crouch);
  });
});
