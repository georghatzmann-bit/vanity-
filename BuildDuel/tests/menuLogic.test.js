// Tests für die Menü-Logik (src/ui/menuLogic.js): Zustände, Pause-Knöpfe, Tasten-Konflikte,
// Neu-Belegen, Browser-Ereignis → Tasten-Code, Pfeil-Navigation
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import {
  MENU_STATES, canTransition, overlayButtons, settingsActions, findKeyConflicts, rebind, eventToCode, pickNeighbor,
} from '../src/ui/menuLogic.js';

// Kopie der Standard-Tasten (CONFIG ist eingefroren)
function keyboard() {
  return Object.fromEntries(Object.entries(CONFIG.controls.keyboard).map(([a, codes]) => [a, [...codes]]));
}

describe('Menü: Zustände (Lobby → Spielen → Pause → Lobby)', () => {
  it('der normale Weg ist erlaubt', () => {
    const path = ['loading', 'lobby', 'start', 'playing', 'paused', 'playing', 'paused', 'lobby', 'start'];
    for (let i = 1; i < path.length; i++) assert.ok(canTransition(path[i - 1], path[i]), `${path[i - 1]} → ${path[i]}`);
  });

  it('Schnellstart (?mode=…) geht vom Laden direkt ins Spiel', () => {
    assert.ok(canTransition('loading', 'start'));
  });

  it('verbotene Sprünge', () => {
    assert.ok(!canTransition('lobby', 'playing'), 'aus der Lobby nur über den Start (Maus-Sperre)');
    assert.ok(!canTransition('lobby', 'paused'));
    assert.ok(!canTransition('loading', 'playing'));
    assert.ok(!canTransition('playing', 'loading'));
    assert.ok(!canTransition('unbekannt', 'lobby'));
  });

  it('jeder Zustand ist erreichbar und kommt zurück in die Lobby', () => {
    for (const s of MENU_STATES) {
      if (s === 'loading' || s === 'lobby') continue;
      assert.ok(canTransition(s, 'lobby'), `${s} → lobby`);
      assert.ok(MENU_STATES.some((from) => canTransition(from, s)), `${s} erreichbar`);
    }
  });

  it('Pause-Knöpfe: "Alles löschen" nur im Kreativ-Modus', () => {
    assert.deepEqual(overlayButtons('paused', 'creative'), ['resume', 'settings', 'clearBuilds', 'lobby']);
    assert.deepEqual(overlayButtons('paused', 'practice'), ['resume', 'settings', 'lobby']);
    assert.deepEqual(overlayButtons('playing', 'creative'), [], 'beim Spielen kein Fenster');
    assert.deepEqual(overlayButtons('lobby', 'creative'), []);
  });
});

describe('Menü: Tasten neu belegen und Konflikte', () => {
  it('Standard-Belegung hat keine Konflikte (auch mit Ducken auf Strg)', () => {
    assert.equal(findKeyConflicts(keyboard()).size, 0);
    assert.equal(findKeyConflicts(keyboard(), { crouchOnCtrl: true }).size, 0);
  });

  it('doppelte Taste wird gefunden', () => {
    const kb = keyboard();
    rebind(kb, 'jump', 0, 'KeyW');
    const c = findKeyConflicts(kb);
    assert.ok(c.has('KeyW'));
    assert.ok(c.get('KeyW').includes('jump') && c.get('KeyW').includes('moveForward'));
    assert.equal(c.size, 1);
  });

  it('Ducken auf Strg: Strg ist dann Ducken – Konflikt mit anderer Strg-Belegung', () => {
    const kb = keyboard();
    rebind(kb, 'emote', 0, 'ControlLeft');
    const c = findKeyConflicts(kb, { crouchOnCtrl: true });
    assert.ok(c.has('ControlLeft'), 'Strg = Ducken + Emote');
    assert.ok(!findKeyConflicts(kb).has('ControlLeft'), 'ohne Strg-Ducken ist Strg frei');
  });

  it('rebind: ersetzt, hängt an, löscht, keine Doppelten in einer Aktion, höchstens 4', () => {
    const kb = { jump: ['Space'] };
    assert.deepEqual(rebind(kb, 'jump', 0, 'KeyK'), ['KeyK']);
    assert.deepEqual(rebind(kb, 'jump', 1, 'Mouse4'), ['KeyK', 'Mouse4']);
    assert.deepEqual(rebind(kb, 'jump', 1, 'KeyK'), ['KeyK'], 'gleiche Taste nur einmal');
    assert.deepEqual(rebind(kb, 'jump', 0, null), [], 'löschen');
    for (const code of ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE']) rebind(kb, 'jump', 9, code);
    assert.equal(kb.jump.length, 4);
    assert.deepEqual(rebind(kb, 'neu', 0, 'KeyN'), ['KeyN'], 'neue Aktion');
  });

  it('Browser-Ereignis → Tasten-Code (Taste, Maustasten, Mausrad)', () => {
    assert.equal(eventToCode({ type: 'keydown', code: 'KeyQ' }), 'KeyQ');
    assert.equal(eventToCode({ type: 'mousedown', button: 0 }), 'Mouse0');
    assert.equal(eventToCode({ type: 'pointerdown', button: 4 }), 'Mouse4');
    assert.equal(eventToCode({ type: 'wheel', deltaY: -120 }), 'WheelUp');
    assert.equal(eventToCode({ type: 'wheel', deltaY: 53 }), 'WheelDown');
    assert.equal(eventToCode({ type: 'wheel', deltaY: 0 }), null);
    assert.equal(eventToCode(null), null);
  });

  it('Einstellungs-Liste enthält jede Aktion aus config.js genau einmal', () => {
    const listed = settingsActions().flatMap(([, rows]) => rows.map(([a]) => a));
    const all = Object.keys(CONFIG.controls.keyboard);
    assert.equal(listed.length, all.length);
    for (const a of all) assert.ok(listed.includes(a), a);
    assert.ok(listed.includes('clearBuilds'), 'Alles löschen (Kreativ)');
  });
});

describe('Menü: Pfeil-Navigation', () => {
  const rect = (x, y, w = 100, h = 50) => ({ x, y, width: w, height: h });
  it('wählt den nächsten Knopf in Pfeil-Richtung', () => {
    const play = rect(500, 500);
    const others = [rect(500, 400), rect(300, 500), rect(800, 100), rect(500, 600)];
    assert.equal(pickNeighbor(play, others, 'up'), 0);
    assert.equal(pickNeighbor(play, others, 'left'), 1);
    assert.equal(pickNeighbor(play, others, 'down'), 3);
    assert.equal(pickNeighbor(play, others, 'right'), 2, 'schräg rechts oben, wenn sonst nichts');
  });

  it('nichts in der Richtung → -1', () => {
    assert.equal(pickNeighbor(rect(0, 0), [rect(0, 300)], 'up'), -1);
  });
});
