// Tests für das HUD (src/ui/hud.js, killfeed.js, minimap.js): Text-Formate, Tasten-Namen,
// Fadenkreuz-Größe, Treffer-Richtung, Kill-Feed-Warteschlange, Minimap-Umrechnung,
// dazu die Spielwerte der Abschnitte hud/audio/effects in config.js.
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import {
  formatTime, formatAmmo, formatCount, formatSeconds, keyLabel, keysLabel, crosshairGapPx,
  damageAngle, stormZoneText, normalizeTopCenter, createHud, INFINITY,
} from '../src/ui/hud.js';
import { KillFeedQueue, killFeedEntry, weaponShortName } from '../src/ui/killfeed.js';
import { worldToMinimap, arrowAngle, mapBoundsOf, minimapRange } from '../src/ui/minimap.js';

describe('HUD: Text-Formate', () => {
  it('Zeit: 45 s → "0:45", 75 s → "1:15", aufgerundet, nie negativ', () => {
    assert.equal(formatTime(45), '0:45');
    assert.equal(formatTime(44.2), '0:45');
    assert.equal(formatTime(75), '1:15');
    assert.equal(formatTime(600), '10:00');
    assert.equal(formatTime(9), '0:09');
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(-3), '0:00');
    assert.equal(formatTime(NaN), '0:00');
  });

  it('Munition "Magazin / Reserve", unendlich = ∞', () => {
    assert.equal(formatAmmo(30, 120, false), '30 / 120');
    assert.equal(formatAmmo(5, 0, true), `5 / ${INFINITY}`);
    assert.equal(formatAmmo(0, 0, false), '0 / 0');
    assert.equal(INFINITY, '∞');
  });

  it('Anzahl (Material, Heil-Items) und Sekunden', () => {
    assert.equal(formatCount(15, false), '15');
    assert.equal(formatCount(999.6, false), '999');
    assert.equal(formatCount(3, true), INFINITY);
    assert.equal(formatSeconds(1.44), '1,4 s');
    assert.equal(formatSeconds(0), '0,0 s');
  });

  it('Zonen-Text aus dem Sturm', () => {
    assert.equal(stormZoneText({ radius: 100, timeLeft: 45, state: 'wait' }), 'Zone schrumpft in 0:45');
    assert.equal(stormZoneText({ radius: 100, timeLeft: 11.5, state: 'shrink' }), 'Zone schrumpft: 0:12');
    assert.equal(stormZoneText({ radius: Infinity, timeLeft: 0, state: 'wait' }), null, 'Attrappe (unendlich groß)');
    assert.equal(stormZoneText(null), null);
  });

  it('Oben Mitte: Text oder Stand mit Namen', () => {
    assert.deepEqual(normalizeTopCenter('Übungsplatz'), { title: 'Übungsplatz' });
    const s = normalizeTopCenter({ leftName: 'Du', leftScore: 3, rightName: 'Bot_1', rightScore: 2 });
    assert.equal(s.leftScore, 3);
    assert.equal(s.rightName, 'Bot_1');
    assert.equal(normalizeTopCenter(null), null);
    assert.equal(normalizeTopCenter(''), null);
  });
});

describe('HUD: Tasten-Namen (deine Tastatur)', () => {
  const qwertz = new Map([['KeyZ', 'y'], ['KeyY', 'z'], ['KeyX', 'x'], ['Digit1', '1'], ['Backquote', '^']]);

  it('ohne Tastatur-Belegung: Buchstabe aus dem Tasten-Code', () => {
    assert.equal(keyLabel('KeyZ'), 'Z');
    assert.equal(keyLabel('Digit1'), '1');
    assert.equal(keyLabel('KeyG'), 'G');
  });

  it('deutsche QWERTZ-Tastatur: KeyZ heißt "Y", KeyY heißt "Z"', () => {
    assert.equal(keyLabel('KeyZ', qwertz), 'Y');
    assert.equal(keyLabel('KeyY', qwertz), 'Z');
    assert.equal(keyLabel('Backquote', qwertz), '^');
    assert.equal(keysLabel(['KeyZ', 'KeyY'], qwertz), 'Y / Z');
  });

  it('Maus und Sondertasten auf Deutsch, kurz und lang', () => {
    assert.equal(keyLabel('Mouse0'), 'Linksklick');
    assert.equal(keyLabel('Mouse0', null, true), 'LMT');
    assert.equal(keyLabel('Mouse2'), 'Rechtsklick');
    assert.equal(keyLabel('Space'), 'Leertaste');
    assert.equal(keyLabel('ControlLeft'), 'Strg');
    assert.equal(keyLabel('WheelDown'), 'Mausrad runter');
    assert.equal(keysLabel(['ShiftLeft', 'ShiftRight']), 'Shift', 'beide Shift-Tasten nur einmal');
    assert.equal(keyLabel(''), '');
  });

  it('Standard-Bau-Tasten ergeben Z X C V, Hilfe ist H', () => {
    const kb = CONFIG.controls.keyboard;
    assert.deepEqual(['buildWall', 'buildFloor', 'buildRamp', 'buildRoof'].map((a) => keyLabel(kb[a][0])), ['Z', 'X', 'C', 'V']);
    assert.deepEqual([...kb.help], ['KeyH']);
  });
});

describe('HUD: Fadenkreuz und Treffer-Richtung', () => {
  it('keine Streuung → Lücke 0; Streuung = Sichtfeld → halbe Bild-Höhe', () => {
    assert.equal(crosshairGapPx(0, 70, 720), 0);
    assert.close(crosshairGapPx(70, 70, 720), 360, 1e-6);
  });

  it('Schrotflinte 6° bei 70° Sichtfeld und 720 Pixeln ≈ 27 Pixel Radius', () => {
    const r = crosshairGapPx(6, 70, 720);
    assert.close(r, (Math.tan((3 * Math.PI) / 180) / Math.tan((35 * Math.PI) / 180)) * 360, 1e-9);
    assert.ok(r > 26 && r < 28, `${r}`);
    assert.ok(crosshairGapPx(6, 55, 720) > r, 'beim Zielen (enger) wird der Kreis größer');
  });

  it('Treffer-Richtung: vorne 0, rechts +90°, hinten 180°, links −90°', () => {
    assert.close(damageAngle(0, -10, 0), 0, 1e-9); // vorwärts = −Z
    assert.close(damageAngle(10, 0, 0), Math.PI / 2, 1e-9); // rechts = +X
    assert.close(Math.abs(damageAngle(0, 10, 0)), Math.PI, 1e-9);
    assert.close(damageAngle(-10, 0, 0), -Math.PI / 2, 1e-9);
  });

  it('Treffer-Richtung dreht mit der Kamera', () => {
    // Blick nach −X (yaw +90°): Angreifer bei −X ist vorne, bei −Z rechts
    assert.close(damageAngle(-10, 0, Math.PI / 2), 0, 1e-9);
    assert.close(damageAngle(0, -10, Math.PI / 2), Math.PI / 2, 1e-9);
  });
});

describe('Kill-Feed', () => {
  it('höchstens 5 Meldungen, die älteste fliegt raus', () => {
    const q = new KillFeedQueue(5, 5);
    for (let i = 0; i < 7; i++) q.push({ killer: 'A', weapon: 'AR', victim: `Bot_${i}` }, i * 0.1);
    assert.equal(q.entries.length, 5);
    assert.equal(q.entries[0].victim, 'Bot_2');
    assert.equal(q.entries[4].victim, 'Bot_6');
  });

  it('nach 5 Sekunden verschwunden, kurz davor ausgeblendet', () => {
    const q = new KillFeedQueue(5, 5);
    const e = q.push({ killer: 'Du', weapon: 'AR', victim: 'Bot_3' }, 10);
    const v = q.version;
    assert.equal(q.prune(14.9), false);
    assert.equal(q.entries.length, 1);
    assert.equal(q.opacity(e, 12, 0.5), 1);
    assert.close(q.opacity(e, 14.75, 0.5), 0.5, 1e-9);
    assert.equal(q.prune(15), true);
    assert.equal(q.entries.length, 0);
    assert.ok(q.version > v, 'Änderung gezählt');
  });

  it('Meldung "Du [AR] Bot_3", eigene Kills markiert', () => {
    const player = { name: 'Spieler' };
    const bot = { name: 'Bot_3' };
    const e = killFeedEntry({ victim: bot, killer: player, weaponId: 'ar' }, player, true);
    assert.deepEqual([e.killer, e.weapon, e.victim, e.head, e.mine, e.died], ['Du', 'AR', 'Bot_3', true, true, false]);
    const d = killFeedEntry({ victim: player, killer: bot, weaponId: 'shotgun' }, player);
    assert.deepEqual([d.killer, d.weapon, d.victim, d.mine, d.died], ['Bot_3', 'Schrot', 'Du', false, true]);
    const f = killFeedEntry({ victim: bot, killer: null, weaponId: 'fall' }, player);
    assert.deepEqual([f.killer, f.weapon, f.victim], ['', 'Sturz', 'Bot_3']);
  });

  it('Kurz-Namen für alle Waffen', () => {
    for (const id of ['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher', 'pickaxe']) {
      const name = weaponShortName(id);
      assert.ok(name && name.length <= 8, `${id}: ${name}`);
    }
    assert.equal(weaponShortName('unbekannt'), 'unbekannt');
    assert.equal(weaponShortName(null), '');
  });
});

describe('Minimap', () => {
  it('eigene Figur in der Mitte, Norden (−Z) oben, Osten (+X) rechts', () => {
    const out = { x: 0, y: 0 };
    worldToMinimap(10, 20, 10, 20, 0.5, 80, out);
    assert.deepEqual(out, { x: 80, y: 80 });
    worldToMinimap(10, 0, 10, 20, 0.5, 80, out); // 20 m nach Norden
    assert.deepEqual(out, { x: 80, y: 70 });
    worldToMinimap(30, 20, 10, 20, 0.5, 80, out); // 20 m nach Osten
    assert.deepEqual(out, { x: 90, y: 80 });
  });

  it('Pfeil: yaw 0 zeigt nach oben, Blick nach Westen (−X) nach links', () => {
    assert.equal(arrowAngle(0), -0);
    assert.close(arrowAngle(Math.PI / 2), -Math.PI / 2, 1e-12);
  });

  it('Karten-Grenzen: bounds, sonst size, sonst Bau-Bereich', () => {
    assert.deepEqual(mapBoundsOf({ size: 80 }), { minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
    const b = { minX: 0, maxX: 600, minZ: 0, maxZ: 600 };
    assert.equal(mapBoundsOf({ bounds: b, size: 80 }), b);
    assert.equal(mapBoundsOf({ buildBounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 } }).maxX, 1);
    assert.equal(mapBoundsOf(null), null);
    assert.equal(mapBoundsOf({}), null);
  });

  it('Umkreis: kleine Karten ganz, große höchstens CONFIG.hud.minimap.range', () => {
    assert.close(minimapRange({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 }), 44, 1e-9);
    assert.equal(minimapRange({ minX: -300, maxX: 300, minZ: -300, maxZ: 300 }), CONFIG.hud.minimap.range);
    assert.equal(minimapRange(null), CONFIG.hud.minimap.range);
  });
});

describe('HUD ohne Bildschirm', () => {
  it('createHud ohne HTML-Ebene liefert eine Attrappe mit allen Methoden', () => {
    const hud = createHud({ headless: true }, null);
    assert.equal(hud.headless, true);
    hud.frameUpdate(1 / 60);
    hud.setPrompt('Tür öffnen');
    const off = hud.addPromptProvider(() => null);
    assert.equal(typeof off, 'function');
    off();
    hud.applySettings({});
    hud.toggleHelp();
    assert.equal(hud.debugState(), null);
    hud.dispose();
  });
});

describe('Spielwerte: HUD, Ton, Effekte', () => {
  it('HUD: Kill-Feed 5 Meldungen / 5 s, Zeiten positiv', () => {
    const h = CONFIG.hud;
    assert.equal(h.killFeed.max, 5);
    assert.equal(h.killFeed.lifetime, 5);
    assert.ok(h.killFeed.fadeTime > 0 && h.killFeed.fadeTime < h.killFeed.lifetime);
    assert.ok(h.hitMarker.time > 0 && h.hitMarker.killTime >= h.hitMarker.time);
    assert.ok(h.lowHealth > 0 && h.lowHealth < CONFIG.player.maxHealth);
    assert.ok(h.crosshair.minGap >= 0 && h.crosshair.maxGap > h.crosshair.minGap);
    assert.ok(h.minimap.range > 0 && h.infoInterval > 0 && h.promptInterval > 0);
  });

  it('Ton: Begrenzung pro Art nie größer als die Gesamtzahl, Entfernungen sinnvoll', () => {
    const a = CONFIG.audio;
    assert.ok(a.maxVoices >= 8);
    for (const [type, cap] of Object.entries(a.voicesPerType)) assert.ok(cap >= 1 && cap <= a.maxVoices, `${type}: ${cap}`);
    assert.ok(a.refDistance > 0 && a.maxDistance > a.refDistance && a.rolloff > 0);
    assert.ok(a.musicLevel > 0 && a.musicLevel <= 1);
  });

  it('Effekte: Vorräte > 0, weniger Teilchen bei schwächerer Grafik', () => {
    const e = CONFIG.effects;
    for (const n of Object.values(e.pools)) assert.ok(n > 0);
    const f = e.qualityFactor;
    assert.ok(f.niedrig < f.mittel && f.mittel <= f.hoch && f.hoch <= 1);
    for (const name of Object.keys(CONFIG.graphics.presets)) assert.ok(Number.isFinite(f[name]), name);
  });
});
