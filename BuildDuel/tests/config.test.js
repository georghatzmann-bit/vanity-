// Tests für die Spielwerte (src/config.js)
// Sie prüfen, ob die Zahlen zusammenpassen – z. B. nach einer Änderung von Hand.
import { describe, it, assert } from './runner.js';
import { CONFIG, getQualityPreset } from '../src/config.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const GUNS = ['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher'];

describe('Spielwerte: Grundlagen', () => {
  it('sind eingefroren (das Spiel kann sie nicht aus Versehen ändern)', () => {
    assert.ok(Object.isFrozen(CONFIG), 'CONFIG');
    assert.ok(Object.isFrozen(CONFIG.weapons.ar), 'CONFIG.weapons.ar');
    assert.ok(Object.isFrozen(CONFIG.controls.keyboard.buildWall), 'Tasten-Listen');
  });

  it('Spiel-Uhr: Schritt-Grenze und Pausen-Grenze passen zusammen', () => {
    const { tickRate, maxFrameTime, maxStepsPerFrame } = CONFIG.loop;
    assert.ok(tickRate > 0 && maxStepsPerFrame >= 2);
    // Sonst hätte maxFrameTime keine Wirkung (die Schritt-Grenze würde vorher greifen)
    assert.ok(maxStepsPerFrame / tickRate >= maxFrameTime - 1e-9,
      `${maxStepsPerFrame} Schritte = ${(maxStepsPerFrame / tickRate).toFixed(3)} s < maxFrameTime ${maxFrameTime} s`);
  });
});

describe('Spielwerte: Spieler und Welt', () => {
  it('Tempo: geduckt < gehen < sprinten', () => {
    const p = CONFIG.player;
    assert.ok(p.crouchSpeed < p.walkSpeed && p.walkSpeed < p.sprintSpeed);
  });

  it('Leben und Schild sind größer als 0', () => {
    assert.ok(CONFIG.player.maxHealth > 0);
    assert.ok(CONFIG.player.maxShield > 0);
  });

  it('Hitbox: Kopf-Zone ist kleiner als die Figur, geduckt kleiner als stehend', () => {
    const h = CONFIG.player.hitbox;
    assert.ok(h.headZone > 0 && h.headZone < h.height);
    assert.ok(h.crouchHeight < h.height);
    assert.ok(h.radius * 2 < h.height);
  });

  it('Rampen (45°) sind begehbar', () => {
    assert.ok(CONFIG.player.maxWalkableSlope > CONFIG.building.rampSlopeDeg);
  });

  it('Boden-Fläche besteht aus ganzen Bau-Zellen (sonst sitzt das Raster schief)', () => {
    assert.equal((CONFIG.world.groundSize / 2) % CONFIG.world.gridCellSize, 0, 'Boden-Hälfte / Zelle');
  });

  it('Boden ist größer als die Sichtweite (kein sichtbarer Rand)', () => {
    for (const [name, preset] of Object.entries(CONFIG.graphics.presets)) {
      assert.ok(CONFIG.world.groundSize / 2 > preset.viewDistance, name);
    }
  });

  it('Kamera: Sniper-Sicht < Ziel-Sicht < normale Sicht', () => {
    const c = CONFIG.camera;
    assert.ok(c.sniperFov < c.aimFov && c.aimFov < c.fov);
    assert.ok(c.aimDistance < c.distance);
  });
});

describe('Spielwerte: Bewegung, Kamera, Figuren (Phase 2)', () => {
  it('Augenhöhe liegt in der Figur (stehend und geduckt)', () => {
    const p = CONFIG.player;
    assert.ok(p.eyeHeight > p.crouchEyeHeight && p.eyeHeight < p.hitbox.height);
    assert.ok(p.crouchEyeHeight < p.hitbox.crouchHeight);
  });

  it('Kamera: geduckt tiefer als stehend, Wand-Abstand größer als die Bild-Nahgrenze', () => {
    const c = CONFIG.camera;
    assert.ok(c.crouchHeight < c.height);
    assert.ok(c.collisionPadding > c.near);
    assert.ok(c.hideCharacterDistance < c.aimDistance);
  });

  it('Stufen: 0,3-m-Kiste geht, 1-m-Kiste nicht (Übungsplatz)', () => {
    const steps = CONFIG.modes.practice.stepHeights;
    assert.ok(CONFIG.player.stepHeight >= steps[0], 'kleinste Kiste ersteigbar');
    assert.ok(CONFIG.player.stepHeight < steps[1], 'zweite Kiste nicht');
  });

  it('Teilschritte sind kürzer als Figur + dünnster Boden (kein Durchfallen)', () => {
    const p = CONFIG.player;
    assert.ok(p.maxSubstepDistance < CONFIG.building.pieceThickness + p.hitbox.radius * 2);
    assert.ok(p.maxSubsteps >= 10);
    // bei Höchsttempo reichen die Teilschritte
    assert.ok(p.maxFallSpeed / CONFIG.loop.tickRate <= p.maxSubstepDistance * p.maxSubsteps);
  });

  it('Bergab "kleben" reicht für 45°-Rampen beim Sprinten', () => {
    const p = CONFIG.player;
    const perTick = p.sprintSpeed / CONFIG.loop.tickRate;
    assert.ok(p.groundSnapDistance >= perTick + p.hitbox.radius * Math.tan(CONFIG.building.rampSlopeDeg * Math.PI / 180) - 1e-9);
  });

  it('Übungsplatz: Decke zwischen geduckt und stehend, Turm hoch genug für Fallschaden', () => {
    const pr = CONFIG.modes.practice;
    const h = CONFIG.player.hitbox;
    assert.ok(pr.lowCeiling > h.crouchHeight && pr.lowCeiling < h.height);
    assert.ok(pr.towerHeight > CONFIG.player.fallDamage.safeHeight);
    assert.ok(pr.bridgeRampHeight - CONFIG.building.pieceThickness * Math.SQRT2 > h.height, 'unter der Rampe ist Platz');
    assert.ok(pr.idleBots <= CONFIG.bots.names.length);
  });

  it('Farbsets: gültige Farben, bekannte Hut-Formen, eindeutige ids, Standard vorhanden', () => {
    const skins = CONFIG.skins;
    const ids = new Set();
    for (const s of skins.list) {
      for (const key of ['body', 'accent', 'skinTone', 'hatColor']) assert.ok(HEX_COLOR.test(s[key]), `${s.id}.${key}`);
      assert.ok(skins.hatShapes.includes(s.hat), `${s.id}: Hut ${s.hat}`);
      assert.ok(!ids.has(s.id), `doppelt: ${s.id}`);
      ids.add(s.id);
    }
    assert.ok(skins.list.length >= 8);
    assert.ok(ids.has(skins.defaultId));
  });
});

describe('Spielwerte: Waffen', () => {
  it('jede Schusswaffe hat Magazin, Nachladezeit und Schuss-Tempo', () => {
    for (const id of GUNS) {
      const w = CONFIG.weapons[id];
      assert.ok(w, `Waffe ${id} fehlt`);
      assert.ok(w.magazine > 0, `${id}: Magazin`);
      assert.ok(w.reloadTime > 0, `${id}: Nachladezeit`);
      assert.ok(w.fireRate > 0 || w.fireInterval > 0, `${id}: fireRate oder fireInterval`);
      assert.ok(w.structureDamage > 0, `${id}: Schaden an Bauteilen`);
      assert.ok(['hitscan', 'projectile'].includes(w.kind), `${id}: Art`);
    }
  });

  it('Schadens-Abfall ist sinnvoll (voll bis X, dann weniger, nie unter 0)', () => {
    for (const id of GUNS) {
      const f = CONFIG.weapons[id].falloff;
      if (!f) continue;
      assert.ok(f.fullUntil < f.minAt, `${id}: fullUntil < minAt`);
      assert.ok(f.minFactor > 0 && f.minFactor <= 1, `${id}: minFactor`);
    }
  });

  it('Kopfschuss-Faktor ist mindestens 1', () => {
    for (const id of GUNS) {
      const m = CONFIG.weapons[id].headMultiplier;
      if (m !== undefined) assert.ok(m >= 1, `${id}: ${m}`);
    }
  });

  it('Schrotflinte: Nachladen Schuss für Schuss passt zur Gesamtzeit', () => {
    const s = CONFIG.weapons.shotgun;
    assert.close(s.reloadTimePerShell * s.magazine, s.reloadTime, 1e-9);
  });
});

describe('Spielwerte: Bauen und Material', () => {
  it('jedes Bauteil hat Leben für jedes Material: Holz < Stein < Metall', () => {
    for (const piece of CONFIG.building.pieceTypes) {
      const hp = CONFIG.building.maxHealth[piece];
      assert.ok(hp, `Bauteil ${piece} fehlt`);
      assert.ok(hp.wood < hp.stone && hp.stone < hp.metal, `${piece}: ${JSON.stringify(hp)}`);
    }
  });

  it('Aufbau-Zeit: Holz am schnellsten, Metall am langsamsten', () => {
    const t = CONFIG.materials.buildTime;
    assert.ok(t.wood < t.stone && t.stone < t.metal);
    const f = CONFIG.materials.startHealthFraction;
    assert.ok(f > 0 && f < 1);
  });

  it('kein Modus startet mit mehr Material als erlaubt', () => {
    for (const [id, mode] of Object.entries(CONFIG.modes)) {
      if (!mode.startMaterials) continue;
      for (const amount of Object.values(mode.startMaterials)) {
        assert.ok(amount >= 0 && amount <= CONFIG.materials.maxPerType, `${id}: ${amount}`);
      }
    }
  });

  it('Edit-Raster: Wand 3x3, Boden/Dach/Rampe 2x2, Tür liegt in der Wand', () => {
    const g = CONFIG.building.editGrid;
    assert.deepEqual([g.wall.cols, g.wall.rows], [3, 3]);
    for (const p of ['floor', 'roof', 'ramp']) assert.deepEqual([g[p].cols, g[p].rows], [2, 2]);
    for (const cell of CONFIG.building.wallDoorCells) assert.ok(cell >= 0 && cell < 9);
  });
});

describe('Spielwerte: Modi und Zone', () => {
  it('Battle Royale: 5 Zonen-Phasen, jede kleiner als die davor, am Ende 0', () => {
    const storm = CONFIG.modes.battleRoyale.storm;
    assert.equal(storm.phases.length, 5);
    let radius = storm.initialRadius;
    let dps = 0;
    for (const [i, phase] of storm.phases.entries()) {
      assert.ok(phase.endRadius < radius, `Phase ${i + 1}: Radius`);
      assert.ok(phase.dps >= dps, `Phase ${i + 1}: Schaden soll nicht sinken`);
      assert.ok(phase.wait > 0 && phase.shrink > 0, `Phase ${i + 1}: Zeiten`);
      radius = phase.endRadius;
      dps = phase.dps;
    }
    assert.equal(radius, 0);
  });

  it('Battle Royale: Zone deckt am Anfang die ganze Insel ab', () => {
    const br = CONFIG.modes.battleRoyale;
    const halfDiagonal = (br.islandSize / 2) * Math.SQRT2;
    assert.ok(br.storm.initialRadius >= halfDiagonal);
  });

  it('Battle Royale: Spielerzahl liegt zwischen Minimum und Maximum', () => {
    const br = CONFIG.modes.battleRoyale;
    assert.ok(br.minPlayers <= br.totalPlayers && br.totalPlayers <= br.maxPlayers);
    assert.ok(CONFIG.bots.names.length >= br.maxPlayers - 1, 'genug Bot-Namen');
  });

  it('Duell: Startpunkte liegen in der Arena', () => {
    const d = CONFIG.modes.duel;
    assert.ok(d.spawnDistance < d.arenaSize);
    assert.ok(d.roundsToWin >= 1);
  });

  it('Lade-Ausrüstung enthält nur Waffen, die es gibt', () => {
    for (const [id, mode] of Object.entries(CONFIG.modes)) {
      for (const weapon of mode.loadout ?? []) {
        assert.ok(CONFIG.weapons[weapon], `${id}: Waffe "${weapon}" gibt es nicht`);
      }
    }
  });

  it('Heil-Items heilen nie über das Maximum', () => {
    for (const id of ['bandage', 'medkit', 'smallShield', 'bigShield']) {
      const item = CONFIG.healing[id];
      const max = item.heals === 'health' ? CONFIG.player.maxHealth : CONFIG.player.maxShield;
      assert.ok(item.maxTo <= max, `${id}: ${item.maxTo} > ${max}`);
      assert.ok(item.useTime > 0, `${id}: Benutz-Zeit`);
    }
  });

  it('Bots: schwerer = schneller und genauer', () => {
    const { easy, medium, hard } = CONFIG.bots.difficulties;
    assert.ok(easy.reactionMs > medium.reactionMs && medium.reactionMs > hard.reactionMs);
    assert.ok(easy.aimErrorDeg > medium.aimErrorDeg && medium.aimErrorDeg > hard.aimErrorDeg);
    assert.ok(easy.buildsPerSecond < medium.buildsPerSecond && medium.buildsPerSecond < hard.buildsPerSecond);
  });
});

describe('Spielwerte: Tasten', () => {
  it('jede Aktion hat mindestens eine Taste', () => {
    for (const [action, keys] of Object.entries(CONFIG.controls.keyboard)) {
      assert.ok(Array.isArray(keys) && keys.length > 0, `${action}`);
      for (const key of keys) assert.ok(typeof key === 'string' && key.length > 0, `${action}: ${key}`);
    }
  });

  it('keine Taste ist aus Versehen doppelt belegt', () => {
    const used = new Map();
    const allowed = new Set(CONFIG.controls.allowedSharedKeys);
    for (const [action, keys] of Object.entries(CONFIG.controls.keyboard)) {
      for (const key of keys) {
        if (used.has(key) && !allowed.has(key)) {
          throw new Error(`Taste ${key} ist doppelt belegt: ${used.get(key)} und ${action}`);
        }
        used.set(key, action);
      }
    }
  });

  it('Controller: Bau-Tasten sind verschieden und gültige Knopf-Nummern', () => {
    const b = CONFIG.controls.gamepad.buildMode;
    const buttons = [b.wall, b.ramp, b.floor, b.roof];
    assert.equal(new Set(buttons).size, 4);
    for (const n of buttons) assert.ok(Number.isInteger(n) && n >= 0 && n <= 16);
  });
});

describe('Spielwerte: Optik und Grafik', () => {
  it('alle Farben sind gültige Farbcodes (#RRGGBB)', () => {
    for (const [name, color] of Object.entries(CONFIG.visuals.colors)) {
      assert.ok(HEX_COLOR.test(color), `${name}: ${color}`);
    }
    for (const id of CONFIG.rarities.order) {
      assert.ok(HEX_COLOR.test(CONFIG.rarities[id].color), `Seltenheit ${id}`);
    }
  });

  it('Seltenheiten: Schadens-Bonus steigt von Gewöhnlich bis Legendär', () => {
    let last = 0;
    for (const id of CONFIG.rarities.order) {
      const m = CONFIG.rarities[id].damageMultiplier;
      assert.ok(m > last, `${id}: ${m}`);
      last = m;
    }
  });

  it('Grafik-Stufe aus config.js gibt es wirklich (Groß-/Kleinschreibung egal)', () => {
    const key = String(CONFIG.graphics.quality).trim().toLowerCase();
    assert.ok(Object.hasOwn(CONFIG.graphics.presets, key), `Stufe "${CONFIG.graphics.quality}"`);
  });

  it('Grafik-Stufe: Groß-/Kleinschreibung egal, Unbekanntes wird "mittel"', () => {
    assert.equal(getQualityPreset('Hoch').name, 'hoch');
    assert.equal(getQualityPreset(' NIEDRIG ').name, 'niedrig');
    // Der Hinweis in der Konsole ist hier erwartet – abfangen, damit die Test-Seite sauber bleibt
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      assert.equal(getQualityPreset('gibtsnicht').name, 'mittel');
      assert.equal(getQualityPreset('gibtsnicht').viewDistance, CONFIG.graphics.presets.mittel.viewDistance);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 2, 'Hinweis in der Konsole');
  });

  it('Nebel: beginnt vor dem Ende, endet vor der Sichtweite', () => {
    const v = CONFIG.visuals;
    assert.ok(v.fogStartFraction >= 0 && v.fogStartFraction < v.fogEndFraction && v.fogEndFraction <= 1);
  });

  it('Sichtweite: niedrig < mittel < hoch', () => {
    const p = CONFIG.graphics.presets;
    assert.ok(p.niedrig.viewDistance < p.mittel.viewDistance && p.mittel.viewDistance < p.hoch.viewDistance);
  });
});

// -----------------------------------------------------------------------------
// Diese Tests prüfen Werte, die genau so in deinem Plan stehen. Änderst du einen
// davon ABSICHTLICH in config.js, wird hier der passende Test rot – das ist dann
// in Ordnung und kein Fehler im Spiel.
// -----------------------------------------------------------------------------
describe('Vorgaben aus deinem Plan (dürfen rot werden, wenn du sie absichtlich änderst)', () => {
  it('Spielname ist der Platzhalter "BuildDuel"', () => {
    assert.equal(CONFIG.game.name, 'BuildDuel');
  });

  it('Logik: 60 Schritte pro Sekunde', () => {
    assert.equal(CONFIG.loop.tickRate, 60);
  });

  it('Sprunghöhe ca. 1,4 m (aus Sprung-Tempo und Schwerkraft)', () => {
    const { jumpVelocity } = CONFIG.player;
    const height = (jumpVelocity * jumpVelocity) / (2 * CONFIG.world.gravity);
    assert.close(height, 1.4, 0.05, 'Sprunghöhe in m');
  });

  it('Leben 100, Schild höchstens 100', () => {
    assert.equal(CONFIG.player.maxHealth, 100);
    assert.ok(CONFIG.player.maxShield <= 100);
  });

  it('Bau-Raster: 4 m Zellen, 4 m Wandhöhe', () => {
    assert.equal(CONFIG.world.gridCellSize, 4);
    assert.equal(CONFIG.world.wallHeight, 4);
  });

  it('Schrotflinte macht maximal 90 Schaden (10 Kugeln x 9)', () => {
    const s = CONFIG.weapons.shotgun;
    assert.equal(s.pellets * s.damagePerPellet, 90);
  });

  it('Material: 10 pro Bauteil, höchstens 999', () => {
    assert.equal(CONFIG.materials.costPerPiece, 10);
    assert.equal(CONFIG.materials.maxPerType, 999);
  });

  it('Bau-Tasten: Z (und Y) Wand, X Boden, C Rampe, V Dach', () => {
    assert.deepEqual([...CONFIG.controls.keyboard.buildWall], ['KeyZ', 'KeyY']);
    assert.deepEqual([...CONFIG.controls.keyboard.buildFloor], ['KeyX']);
    assert.deepEqual([...CONFIG.controls.keyboard.buildRamp], ['KeyC']);
    assert.deepEqual([...CONFIG.controls.keyboard.buildRoof], ['KeyV']);
  });

  it('Fallschaden: ab 7 m, 10 pro Meter (12 m → 50)', () => {
    const fd = CONFIG.player.fallDamage;
    assert.equal(fd.safeHeight, 7);
    assert.equal((12 - fd.safeHeight) * fd.damagePerMeter, 50);
  });

  it('Kamera: 3,2 m dahinter, 0,6 m rechts, 1,6 m hoch, beim Zielen 1,8 m und 55°', () => {
    const c = CONFIG.camera;
    assert.deepEqual([c.distance, c.shoulderOffset, c.height, c.aimDistance, c.fov, c.aimFov], [3.2, 0.6, 1.6, 1.8, 70, 55]);
  });

  it('Battle Royale: Zonen-Zeiten und Schaden wie im Plan', () => {
    const phases = CONFIG.modes.battleRoyale.storm.phases.map((p) => [p.wait, p.shrink, p.dps]);
    assert.deepEqual(phases, [[60, 45, 1], [45, 40, 2], [40, 35, 5], [30, 30, 8], [20, 30, 10]]);
  });
});
