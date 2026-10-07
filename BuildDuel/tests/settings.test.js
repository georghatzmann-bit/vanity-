// Tests für die Einstellungen (src/core/settings.js)
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import {
  defaultSettings, loadSettings, saveSettings, resetSettings, mergeSettings, resolveGraphics, SETTINGS_KEY, SENSITIVITY_SCALE,
} from '../src/core/settings.js';

// Speicher-Ersatz für Tests (wie localStorage, nur im Speicher)
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.hasOwn(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('Einstellungen', () => {
  it('Standardwerte kommen aus config.js (alle Bereiche aus ARCHITECTURE.md §11)', () => {
    const s = defaultSettings();
    for (const key of ['controls', 'sensitivity', 'graphics', 'audio', 'game']) assert.ok(s[key], key);
    assert.deepEqual(s.controls.keyboard.jump, [...CONFIG.controls.keyboard.jump]);
    assert.equal(s.controls.crouchOnCtrl, CONFIG.controls.crouchOnCtrl);
    assert.equal(s.controls.aimAssist, CONFIG.controls.gamepad.aimAssist.enabled);
    assert.equal(s.sensitivity.targeting, CONFIG.sensitivity.targeting);
    assert.equal(s.graphics.quality, CONFIG.graphics.quality);
    assert.equal(s.audio.master, CONFIG.audio.master);
    assert.equal(s.game.botDifficulty, CONFIG.bots.defaultDifficulty);
    for (const key of ['editOnRelease', 'autoConfirmEdits', 'resetConfirms', 'resetEditAfterConfirm', 'turboBuilding', 'resetBuildingChoice', 'crouchToggle']) assert.ok(key in s.controls, key);
    for (const key of ['x', 'y', 'targeting', 'scope', 'build', 'edit', 'invertY']) assert.ok(key in s.sensitivity, key);
    for (const key of ['resolutionScale', 'viewDistance', 'showFps']) assert.ok(key in s.graphics, key);
    for (const key of ['playerName', 'damageNumbers']) assert.ok(key in s.game, key);
  });

  it('jedes Mal ein neues Objekt (Änderungen wirken nicht auf die Standardwerte)', () => {
    const a = defaultSettings();
    a.controls.keyboard.jump.push('KeyJ');
    a.sensitivity.x = 5;
    const b = defaultSettings();
    assert.deepEqual(b.controls.keyboard.jump, [...CONFIG.controls.keyboard.jump]);
    assert.equal(b.sensitivity.x, CONFIG.sensitivity.x);
  });

  it('speichern und laden ergibt dasselbe', () => {
    const storage = memoryStorage();
    const s = defaultSettings();
    s.sensitivity.x = 1.7;
    s.sensitivity.invertY = true;
    s.controls.crouchOnCtrl = true;
    s.controls.keyboard.jump = ['KeyJ'];
    s.graphics.quality = 'niedrig';
    s.graphics.resolutionScale = 0.6;
    s.game.playerName = 'Georg';
    assert.ok(saveSettings(s, storage));
    const loaded = loadSettings(storage);
    assert.deepEqual(loaded, s);
  });

  it('kaputtes JSON → Standardwerte (kein Absturz)', () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: '{ das ist kein json' });
    assert.deepEqual(loadSettings(storage), defaultSettings());
  });

  it('gespeicherte Werte werden über die Standardwerte gelegt (fehlende bleiben Standard)', () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ sensitivity: { scale: SENSITIVITY_SCALE, y: 2 }, audio: { music: 0 } }) });
    const s = loadSettings(storage);
    assert.equal(s.sensitivity.y, 2);
    assert.equal(s.sensitivity.x, CONFIG.sensitivity.x, 'nicht gespeichert → Standard');
    assert.equal(s.audio.music, 0);
    assert.equal(s.audio.master, CONFIG.audio.master);
    assert.deepEqual(s.controls.keyboard.moveForward, [...CONFIG.controls.keyboard.moveForward]);
  });

  it('falsche Typen und unbekannte Felder werden ignoriert', () => {
    const stored = {
      sensitivity: { scale: SENSITIVITY_SCALE, x: 'schnell', y: null, targeting: 50 },
      controls: { keyboard: { jump: 'Space', crouch: [1, 2], unbekannt: ['KeyQ'], pickaxe: ['KeyH'] }, crouchToggle: 'ja' },
      neuesFeld: { a: 1 },
      graphics: { viewDistance: 300, resolutionScale: 'voll' },
    };
    const s = loadSettings(memoryStorage({ [SETTINGS_KEY]: JSON.stringify(stored) }));
    assert.equal(s.sensitivity.x, CONFIG.sensitivity.x);
    assert.equal(s.sensitivity.y, CONFIG.sensitivity.y);
    assert.equal(s.sensitivity.targeting, 50);
    assert.deepEqual(s.controls.keyboard.jump, [...CONFIG.controls.keyboard.jump], 'Text statt Liste');
    assert.deepEqual(s.controls.keyboard.crouch, [...CONFIG.controls.keyboard.crouch], 'Zahlen statt Texte');
    assert.deepEqual(s.controls.keyboard.pickaxe, ['KeyH']);
    assert.ok(!('unbekannt' in s.controls.keyboard));
    assert.equal(s.controls.crouchToggle, CONFIG.controls.crouchToggle);
    assert.ok(!('neuesFeld' in s));
    assert.equal(s.graphics.viewDistance, 300);
    assert.equal(s.graphics.resolutionScale, null);
  });

  it('Werte außerhalb der Grenzen werden begrenzt', () => {
    const stored = { sensitivity: { scale: SENSITIVITY_SCALE, x: 999 }, controls: { autoConfirmEdits: 'immer' }, audio: { master: 7 }, graphics: { quality: 'ultra', resolutionScale: 0.1 }, game: { botDifficulty: 'gott' } };
    const s = loadSettings(memoryStorage({ [SETTINGS_KEY]: JSON.stringify(stored) }));
    assert.equal(s.sensitivity.x, 100);
    assert.equal(s.controls.autoConfirmEdits, CONFIG.controls.autoConfirmEdits);
    assert.equal(s.audio.master, 1);
    assert.equal(s.graphics.quality, CONFIG.graphics.quality);
    assert.equal(s.graphics.resolutionScale, 0.5);
    assert.equal(s.game.botDifficulty, CONFIG.bots.defaultDifficulty);
  });

  it('alte Speicherung (Faktoren, Q = Material): Empfindlichkeit auf Fortnite-Standard, Q wird Baumodus', () => {
    const stored = {
      sensitivity: { x: 1.2, y: 1, aim: 0.7, build: 1 },
      controls: { keyboard: { switchMaterial: ['KeyQ', 'Mouse1'], jump: ['KeyJ'] } },
    };
    const s = loadSettings(memoryStorage({ [SETTINGS_KEY]: JSON.stringify(stored) }));
    assert.equal(s.sensitivity.x, CONFIG.sensitivity.x, '1,2 wird nicht zu 1,2 %');
    assert.equal(s.sensitivity.build, 100);
    assert.equal(s.sensitivity.scale, SENSITIVITY_SCALE);
    assert.deepEqual(s.controls.keyboard.switchMaterial, [...CONFIG.controls.keyboard.switchMaterial]);
    assert.deepEqual(s.controls.keyboard.toggleBuild, ['KeyQ']);
    assert.deepEqual(s.controls.keyboard.jump, ['KeyJ'], 'andere eigene Tasten bleiben');
  });

  it('gesperrter Speicher (wirft Fehler) → Standardwerte, speichern meldet false', () => {
    const broken = {
      getItem() { throw new Error('gesperrt'); },
      setItem() { throw new Error('voll'); },
      removeItem() { throw new Error('gesperrt'); },
    };
    assert.deepEqual(loadSettings(broken), defaultSettings());
    assert.equal(saveSettings(defaultSettings(), broken), false);
    assert.deepEqual(resetSettings(broken), defaultSettings());
    assert.deepEqual(loadSettings(null), defaultSettings());
  });

  it('resetSettings löscht die Speicherung', () => {
    const storage = memoryStorage();
    const s = defaultSettings();
    s.sensitivity.x = 3;
    saveSettings(s, storage);
    const reset = resetSettings(storage);
    assert.equal(reset.sensitivity.x, CONFIG.sensitivity.x);
    assert.equal(storage.getItem(SETTINGS_KEY), null);
  });

  it('mergeSettings: Liste und Objekt nicht verwechseln', () => {
    const merged = mergeSettings({ a: { b: 1 }, list: ['x'] }, { a: ['nein'], list: { nein: 1 } });
    assert.deepEqual(merged, { a: { b: 1 }, list: ['x'] });
  });

  it('resolveGraphics: eigene Werte überschreiben die Qualitäts-Stufe', () => {
    const s = defaultSettings();
    s.graphics.quality = 'mittel';
    let g = resolveGraphics(s);
    assert.equal(g.name, 'mittel');
    assert.equal(g.viewDistance, CONFIG.graphics.presets.mittel.viewDistance);
    s.graphics.viewDistance = 333;
    s.graphics.resolutionScale = 0.8;
    s.graphics.showFps = false;
    g = resolveGraphics(s);
    assert.equal(g.viewDistance, 333);
    assert.equal(g.resolutionScale, 0.8);
    assert.equal(g.showFps, false);
  });
});
