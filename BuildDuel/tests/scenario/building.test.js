// Szenario-Tests: Bau-System im Übungsplatz (ohne Bildschirm)
// Die Figur wird NUR über Befehle gesteuert (wie ein Bot): Bauteil wählen, klicken,
// drehen, springen … – genau wie ein Spieler mit Tastatur und Maus.
import { describe, it, assert } from '../runner.js';
import { CONFIG } from '../../src/config.js';
import { Game } from '../../src/core/game.js';
import { createTestGame, collect } from './helpers.js';
import { driveByCommands, tap, buildOnce, lookAt, runUntil } from './buildHelpers.js';

const B = CONFIG.building;
const M = CONFIG.materials;
const S = CONFIG.world.gridCellSize;
const H = CONFIG.world.wallHeight;

// Übungsplatz, Spieler bei (x, 0, z) mit Befehls-Gehirn
function practice(x = 2, z = 30, yaw = 0, options = {}) {
  const game = createTestGame(options);
  game.startMode('practice');
  const p = game.player;
  p.spawnAt({ x, y: 0, z }, yaw, 0);
  const f = driveByCommands(p, yaw, 0);
  return { game, p, f };
}

// Strahl-Test: trifft er ein Bauteil?
function hitsPiece(game, from, to) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const len = Math.hypot(d.x, d.y, d.z);
  d.x /= len; d.y /= len; d.z /= len;
  const hit = game.world.raycast(from, d, len, { skipTerrain: true });
  return hit && hit.collider?.data?.kind === 'piece' ? hit.collider.data.ref : null;
}

describe('Szenario: Bauen – Material, Plätze, Halt', () => {
  it('kostet 10 Material pro Teil, ohne Material geht nichts (auch nicht mit anderem Material)', () => {
    const { game, p, f } = practice();
    p.infiniteMaterials = false;
    p.materials = { wood: 25, stone: 0, metal: 0 };
    assert.ok(buildOnce(game, p, f, 'wall'), 'Wand gesetzt');
    assert.equal(p.materials.wood, 25 - M.costPerPiece);
    assert.ok(buildOnce(game, p, f, 'floor'), 'Boden gesetzt');
    assert.equal(p.materials.wood, 5);
    assert.equal(buildOnce(game, p, f, 'ramp'), null, 'zu wenig Holz');
    assert.equal(game.building.getTarget(p, 'ramp').reason, 'material');
    tap(game, f, { switchMaterial: true }); // Q → Stein (auch leer)
    assert.equal(p.currentMaterial, 'stone');
    assert.equal(buildOnce(game, p, f, 'ramp'), null);
    assert.equal(p.stats.piecesBuilt, 2);
    // unendlich (Übungsplatz/Freies Bauen): nichts wird abgezogen
    p.infiniteMaterials = true;
    assert.ok(buildOnce(game, p, f, 'ramp'));
    assert.equal(p.materials.stone, 0);
    assert.equal(game.building.countFor(p), 3);
    game.dispose();
  });

  it('kein doppeltes Bauteil auf einem Platz', () => {
    const { game, p, f } = practice();
    const wall = buildOnce(game, p, f, 'wall');
    assert.ok(wall);
    assert.equal(buildOnce(game, p, f, 'wall'), null);
    assert.equal(game.building.getTarget(p, 'wall').reason, 'occupied');
    assert.equal(game.building.placePiece('wall', wall.slotKey, p, 'stone', { force: true }), null);
    assert.equal(game.building.pieces.size, 1);
    assert.equal(game.building.getPieceAt(wall.slotKey), wall);
    game.dispose();
  });

  it('Boden nicht durch eine Figur hindurch; Boden unter den Füßen hebt an', () => {
    const { game, p, f } = practice();
    // Übungs-Figur steht auf einer 2,6-m-Kiste – ein Boden auf 4 m ginge durch ihren Körper.
    // Halt hätte er (Wand darunter).
    game.map.addBox({ x: 8, y: 0, z: 29 }, { x: 12, y: 2.6, z: 32 }, { color: '#999999' });
    assert.ok(game.building.placePiece('wall', 'wx:2:0:7', null, 'wood', { instant: true }));
    const dummy = game.addCharacter({ name: 'Puppe', isBot: true, brain: null, position: { x: 10, y: 2.6, z: 30.5 } });
    assert.equal(game.building.checkPlacement('floor', 'f', 2, 1, 7, 0, null), 'blocked');
    assert.equal(game.building.placePiece('floor', 'f:2:1:7', p, 'wood', { charge: true }), null);
    dummy.alive = false; // ohne Figur geht es
    assert.equal(game.building.checkPlacement('floor', 'f', 2, 1, 7, 0, null), null);
    // eigener Boden direkt unter den Füßen: erlaubt, Figur steht danach darauf
    f.pitch = -70 * Math.PI / 180;
    const floor = buildOnce(game, p, f, 'floor');
    assert.ok(floor && floor.slotKey === 'f:0:0:7', floor?.slotKey);
    assert.close(p.position.y, B.pieceThickness / 2, 1e-6, 'auf den Boden gehoben');
    game.dispose();
  });

  it('kein Bauteil frei in der Luft (braucht Boden oder Nachbar-Teil)', () => {
    const { game, p, f } = practice();
    assert.equal(game.building.checkPlacement('floor', 'f', 5, 2, 5, 0, p), 'unsupported');
    assert.equal(game.building.placePiece('floor', 'f:5:2:5', p, 'wood', { charge: true }), null);
    // nach oben schauen: Wand eine Ebene höher – ohne Wand darunter kein Halt
    f.pitch = 55 * Math.PI / 180;
    tap(game, f); // Blick übernehmen
    const t = game.building.getTarget(p, 'wall');
    assert.equal(t.j, 1);
    assert.equal(t.reason, 'unsupported');
    // mit Wand darunter geht es
    f.pitch = 0;
    assert.ok(buildOnce(game, p, f, 'wall'));
    f.pitch = 55 * Math.PI / 180;
    tap(game, f);
    assert.ok(game.building.getTarget(p, 'wall').valid);
    game.dispose();
  });

  it('Turm aus Rampen stürzt ein, wenn die unterste Rampe zerstört wird', () => {
    const { game, p } = practice(30, 30);
    const ramps = [];
    for (let n = 0; n < 6; n++) {
      const r = game.building.placePiece('ramp', `r:6:${n}:${8 - n}`, p, 'wood', { dir: 3 });
      assert.ok(r, `Rampe ${n}`);
      ramps.push(r);
    }
    assert.ok(ramps[0].grounded && !ramps[1].grounded, 'nur die unterste steht auf dem Boden');
    const destroyed = collect(game, 'pieceDestroyed');
    ramps[0].applyDamage(1e6, { attacker: p });
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].collapsed, false);
    assert.ok(ramps[1].collapsing && !ramps[1].removed, 'fällt gleich');
    assert.ok(hitsPiece(game, { x: 26, y: 30, z: 26 }, { x: 26, y: 0, z: 26 }), 'blockt noch kurz');
    game.simulate(B.collapseDelay + 2 / 60);
    assert.equal(game.building.pieces.size, 0, 'alle weg');
    assert.equal(destroyed.length, 6);
    assert.ok(destroyed.slice(1).every((e) => e.collapsed && e.by === p));
    assert.equal(game.world.colliders.filter((c) => c.data?.kind === 'piece').length, 0);
    game.dispose();
  });

  it('Halt über Nachbarn: Boden auf Wänden fällt, wenn die letzte Wand weg ist', () => {
    const { game, p } = practice(30, 30);
    const b = game.building;
    const w1 = b.placePiece('wall', 'wx:5:0:5', p);
    const w2 = b.placePiece('wall', 'wx:5:0:6', p);
    const floor = b.placePiece('floor', 'f:5:1:5', p);
    const roof = b.placePiece('roof', 'c:5:1:5', p);
    assert.ok(w1 && w2 && floor && roof);
    w1.applyDamage(1e6);
    game.simulate(0.3);
    assert.ok(!floor.removed && !roof.removed, 'die andere Wand hält noch');
    w2.applyDamage(1e6);
    assert.ok(floor.collapsing && roof.collapsing);
    game.simulate(0.3);
    assert.equal(b.pieces.size, 0);
    game.dispose();
  });
});

describe('Szenario: Bauen – Box, Aufbau, Spam, Material wechseln', () => {
  it('Box (4 Wände + Dach + Boden) schützt: Strahlen von außen treffen die Wände', () => {
    const { game, p, f } = practice(2, 30);
    for (let side = 0; side < 4; side++) {
      f.yaw = (side * Math.PI) / 2;
      tap(game, f);
      assert.ok(buildOnce(game, p, f, 'wall'), `Wand ${side}`);
    }
    assert.ok(buildOnce(game, p, f, 'roof'), 'Dach');
    f.pitch = -70 * Math.PI / 180;
    assert.ok(buildOnce(game, p, f, 'floor'), 'Boden');
    for (const k of ['wx:0:0:7', 'wx:0:0:8', 'wz:0:0:7', 'wz:1:0:7', 'c:0:1:7', 'f:0:0:7']) {
      assert.ok(game.building.getPieceAt(k), `${k} fehlt`);
    }
    const head = { x: 2, y: 1.7, z: 30 };
    for (const from of [{ x: 2, y: 1.7, z: 22 }, { x: 2, y: 1.7, z: 38 }, { x: -6, y: 1.7, z: 30 }, { x: 10, y: 1.7, z: 30 },
      { x: 9, y: 2.5, z: 23 }, { x: 2, y: 20, z: 30 }]) {
      assert.ok(hitsPiece(game, from, head), `von ${JSON.stringify(from)}`);
    }
    game.dispose();
  });

  it('Box an der Zell-Kante: die neue Wand schiebt den Bauenden hinaus (nie "blockiert" durch den eigenen Körper)', () => {
    const T = B.pieceThickness;
    for (const [x, z] of [[0.45, 21.8], [0.3, 23.7], [3.6, 20.2], [3.95, 23.95]]) {
      const { game, p, f } = practice(x, z);
      f.pitch = -0.1;
      for (let side = 0; side < 4; side++) {
        f.yaw = (side * Math.PI) / 2;
        tap(game, f);
        assert.ok(buildOnce(game, p, f, 'wall'), `Wand ${side} bei (${x}, ${z}): ${game.building.getTarget(p, 'wall').reason}`);
      }
      for (const k of ['wx:0:0:5', 'wx:0:0:6', 'wz:0:0:5', 'wz:1:0:5']) assert.ok(game.building.getPieceAt(k), `${k} fehlt bei (${x}, ${z})`);
      // Figur steht jetzt ganz in der Box (kein Stück steckt in einer Wand)
      const r = p.radius;
      const pos = p.position;
      assert.ok(pos.x >= T / 2 + r - 1e-6 && pos.x <= S - T / 2 - r + 1e-6, `x ${pos.x.toFixed(3)}`);
      assert.ok(pos.z >= 5 * S + T / 2 + r - 1e-6 && pos.z <= 6 * S - T / 2 - r + 1e-6, `z ${pos.z.toFixed(3)}`);
      f.pitch = 0.5;
      tap(game, f);
      assert.ok(buildOnce(game, p, f, 'roof'), 'Dach');
      game.simulate(0.3);
      assert.ok(Math.abs(p.position.y) < 1e-3 && p.grounded, 'steht ruhig am Boden');
      game.dispose();
    }
  });

  it('Wand schiebt auch andere Figuren zur Seite ihrer Mitte; Boden im Kopf bleibt "blocked"', () => {
    const { game, p, f } = practice(2, 21);
    const other = game.addCharacter({ name: 'Gegner', position: { x: 2.5, y: 0, z: 20.15 }, brain: null });
    const wall = buildOnce(game, p, f, 'wall'); // wx:0:0:5 bei z = 20
    assert.ok(wall, 'Wand gesetzt, obwohl der Gegner drin steht');
    assert.close(other.position.z, 20 + B.pieceThickness / 2 + other.radius + B.wallPushGap, 1e-6, 'nach +Z hinaus');
    assert.close(other.position.x, 2.5, 1e-9, 'nur quer zur Wand');
    // Boden: Figur in der Luft, der Boden (y = 4) steckt im Kopf → rot
    p.position.y = 3;
    assert.equal(game.building.checkPlacement('floor', 'f', 0, 1, 5, 0, p), 'blocked');
    game.dispose();
  });

  it('Aufbau: Holz nach 1 s voll, Stein nach 2 s, Metall nach 3 s – blockt aber sofort', () => {
    const { game, p, f } = practice();
    const damaged = collect(game, 'pieceDamaged');
    const wall = buildOnce(game, p, f, 'wall');
    assert.close(wall.health, B.maxHealth.wall.wood * M.startHealthFraction, 5, 'startet mit 10 %');
    assert.ok(hitsPiece(game, { x: 2, y: 1.6, z: 31 }, { x: 2, y: 1.6, z: 20 }) === wall, 'blockt sofort');
    game.simulate(0.5);
    assert.ok(wall.health > 60 && wall.health < 150);
    wall.applyDamage(20, { attacker: null });
    assert.equal(damaged.length, 1);
    game.simulate(0.6);
    assert.close(wall.health, 150 - 20, 1e-6, 'voll minus Schaden');
    assert.equal(wall.buildProgress, 1);
    // Metall
    f.yaw = Math.PI / 2;
    tap(game, f, { selectBuild: 'wall' });
    tap(game, f, { switchMaterial: true });
    tap(game, f, { switchMaterial: true });
    assert.equal(p.currentMaterial, 'metal');
    const metal = buildOnce(game, p, f, 'wall');
    assert.equal(metal.material, 'metal');
    game.simulate(1);
    assert.ok(metal.health < B.maxHealth.wall.metal * 0.5, `nach 1 s erst ${metal.health.toFixed(0)}`);
    game.simulate(2);
    assert.close(metal.health, B.maxHealth.wall.metal, 1e-6);
    game.dispose();
  });

  it('Maus gedrückt halten: setzt weiter, sobald sich der Platz ändert (nicht schneller als 0,05 s)', () => {
    const { game, p, f } = practice(2, 30);
    tap(game, f, { selectBuild: 'wall' });
    f.primary = true;
    tap(game, f, { primaryPressed: true });
    for (let n = 1; n < 4; n++) {
      f.yaw = (n * Math.PI) / 2;
      for (let t = 0; t < 4; t++) tap(game, f); // kurz in jede Richtung schauen
    }
    game.simulate(0.2);
    assert.equal(game.building.pieces.size, 4, 'vier Wände rundherum');
    const times = [...game.building.pieces.values()].map((w) => w.placedAt).sort((a, b) => a - b);
    for (let n = 1; n < times.length; n++) assert.ok(times[n] - times[n - 1] >= B.placeCooldown - 1e-9);
    f.primary = false;
    game.dispose();
  });

  it('R dreht die Rampe, Q wechselt das Material', () => {
    const { game, p, f } = practice();
    tap(game, f, { selectBuild: 'ramp' });
    tap(game, f, { reloadOrRotate: true });
    assert.equal(p.buildRotation, 1);
    assert.equal(game.building.getTarget(p, 'ramp').dir, 0, 'Blick −Z (3) + 1 Drehung = +X (0)');
    tap(game, f, { switchMaterial: true });
    const ramp = buildOnce(game, p, f, 'ramp');
    assert.equal(ramp.material, 'stone');
    assert.equal(ramp.maxHealth, B.maxHealth.ramp.stone);
    assert.equal(ramp.dir, 0);
    game.dispose();
  });

  it('Rampe hochlaufen (gebaut) und clearAll räumt alles ab', () => {
    const { game, p, f } = practice();
    const mapColliders = game.world.colliders.length;
    assert.ok(buildOnce(game, p, f, 'ramp'));
    game.simulate(1);
    f.moveZ = 1;
    runUntil(game, () => p.position.y > 3.5, 2);
    assert.ok(p.position.y > 3.5, `oben: ${p.position.y.toFixed(2)}`);
    f.moveZ = 0;
    game.building.clearAll();
    assert.equal(game.building.pieces.size, 0);
    assert.equal(game.world.colliders.length, mapColliders);
    game.dispose();
  });
});

describe('Szenario: Edit und Türen', () => {
  function wallInFront() {
    const ctx = practice(2, 26);
    const wall = buildOnce(ctx.game, ctx.p, ctx.f, 'wall'); // wx:0:0:6 bei z = 24
    ctx.game.simulate(1);
    return { ...ctx, wall };
  }
  // Mitte eines Wand-Feldes (wx bei z = 24)
  const tileCenter = (t) => ({ x: (t % 3 + 0.5) * (S / 3), y: H - (Math.floor(t / 3) + 0.5) * (H / 3), z: 24 });

  it('Wand → Tür (Klicken + Ziehen), E öffnet/schließt, Zurücksetzen stellt sie wieder her', () => {
    const { game, p, f, wall } = wallInFront();
    const edited = collect(game, 'pieceEdited');
    const toggled = collect(game, 'doorToggled');
    lookAt(p, f, tileCenter(4));
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'edit', 'G öffnet den Edit');
    tap(game, f);
    assert.equal(p.mode, 'edit', 'das öffnende G bestätigt nicht');
    const session = game.building.editSession(p);
    assert.ok(session && session.piece === wall && session.hover === 4);
    // Feld 4 anklicken und mit gedrückter Maus nach unten auf Feld 7 ziehen
    f.primary = true;
    tap(game, f, { primaryPressed: true });
    lookAt(p, f, tileCenter(7));
    tap(game, f);
    f.primary = false;
    tap(game, f);
    assert.equal(session.selection, (1 << 4) | (1 << 7));
    assert.equal(wall.editMask, 0, 'erst nach dem Bestätigen');
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'build', 'zurück im Baumodus');
    assert.ok(wall.isDoor && wall.edit.has(4) && wall.edit.has(7) && wall.edit.size === 2);
    assert.equal(edited.length, 1);
    assert.equal(wall.colliders.length, 4, '3 Wand-Stücke + Tür-Blatt');
    // Tür zu: Strahl durch die Tür trifft das Tür-Blatt
    const before = { x: 2, y: 1.2, z: 25 };
    const behind = { x: 2, y: 1.2, z: 22 };
    assert.equal(hitsPiece(game, before, behind), wall);
    tap(game, f, { usePressed: true });
    assert.ok(wall.doorOpen && toggled.length === 1 && toggled[0].open);
    assert.equal(hitsPiece(game, before, behind), null, 'offen: Durchgang frei');
    // durch die offene Tür laufen und zurück
    f.yaw = 0; f.pitch = 0;
    f.moveZ = 1;
    runUntil(game, () => p.position.z < 22.5, 2);
    assert.ok(p.position.z < 22.5, `durch die Tür: z = ${p.position.z.toFixed(2)}`);
    f.moveZ = -1;
    runUntil(game, () => p.position.z > 25.5, 2);
    f.moveZ = 0;
    tap(game, f, { usePressed: true });
    assert.ok(!wall.doorOpen && toggled.length === 2);
    assert.equal(hitsPiece(game, before, behind), wall);
    // Zurücksetzen: G, Rechtsklick, G
    lookAt(p, f, tileCenter(4));
    tap(game, f, { editPressed: true });
    tap(game, f, { secondaryPressed: true });
    assert.equal(game.building.editSession(p).selection, 0);
    tap(game, f, { editPressed: true });
    assert.equal(wall.editMask, 0);
    assert.ok(!wall.isDoor);
    assert.equal(wall.colliders.length, 1);
    assert.equal(edited.length, 2);
    game.dispose();
  });

  it('Fenster: einzelnes Feld entfernen, Strahl geht durch das Loch; Edit beim Loslassen', () => {
    const { game, p, f, wall } = wallInFront();
    game.settings.controls.editOnRelease = true;
    lookAt(p, f, tileCenter(1));
    f.edit = true;
    tap(game, f, { editPressed: true });
    tap(game, f, { primaryPressed: true });
    tap(game, f);
    assert.equal(p.mode, 'edit');
    f.edit = false;
    tap(game, f, { editReleased: true });
    assert.equal(p.mode, 'build', 'Loslassen bestätigt');
    assert.deepEqual([...wall.edit], [1]);
    const c = tileCenter(1);
    assert.equal(hitsPiece(game, { x: c.x, y: c.y, z: 25 }, { x: c.x, y: c.y, z: 22 }), null, 'durch das Fenster');
    assert.equal(hitsPiece(game, { x: 0.5, y: c.y, z: 25 }, { x: 0.5, y: c.y, z: 22 }), wall, 'daneben Wand');
    // offenes Loch wieder anklicken (Edit-Ziel findet auch Löcher)
    game.settings.controls.editOnRelease = false;
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'edit');
    tap(game, f, { primaryPressed: true });
    tap(game, f, { editPressed: true });
    assert.equal(wall.editMask, 0, 'Loch wieder zu');
    game.dispose();
  });

  it('fremde Wand: kein Edit, kurzer Hinweis; Waffe wählen verlässt den Edit', () => {
    const { game, p, f } = practice(2, 26);
    const other = game.characters.find((c) => c !== p);
    const foreign = game.building.placePiece('wall', 'wx:0:0:6', other, 'wood', { instant: true });
    const messages = collect(game, 'message');
    tap(game, f, { selectBuild: 'wall' });
    lookAt(p, f, { x: 2, y: 2, z: 24 });
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'build');
    assert.equal(game.building.canEdit(p), false);
    assert.ok(messages.length >= 1 && messages[0].kind === 'info', 'Hinweis');
    // eigene Wand daneben (links): Edit auf, dann Spitzhacke → Edit zu
    f.yaw = Math.PI / 2; f.pitch = 0;
    tap(game, f);
    assert.ok(buildOnce(game, p, f, 'wall'));
    lookAt(p, f, { x: 0, y: 2, z: 26 });
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'edit');
    tap(game, f, { selectPickaxe: true });
    assert.equal(p.mode, 'pickaxe');
    assert.equal(game.building.editSession(p), null);
    assert.ok(foreign && !foreign.removed);
    game.dispose();
  });

  it('Teil wird im Edit zerstört → Edit zu', () => {
    const { game, p, f, wall } = wallInFront();
    lookAt(p, f, tileCenter(4));
    tap(game, f, { editPressed: true });
    tap(game, f);
    assert.equal(p.mode, 'edit');
    wall.applyDamage(1e6);
    tap(game, f);
    assert.equal(p.mode, 'build');
    game.dispose();
  });
});

// --- Techniken: 90er und Ramp Rush ------------------------------------------------

// 90er: Rampe, Wand, dann immer: zur oberen linken Ecke laufen, 90° nach links drehen,
// Wand, springen, Rampe (in der Luft), Wand davor, landen. Nur Befehle!
function nineties(game, p, f, cycles) {
  const heights = [];
  buildOnce(game, p, f, 'ramp');
  buildOnce(game, p, f, 'wall');
  let yaw = f.yaw;
  for (let cycle = 0; cycle < cycles; cycle++) {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const lx = -Math.sin(yaw + Math.PI / 2);
    const lz = -Math.cos(yaw + Math.PI / 2);
    const startY = p.position.y;
    const edge = (ax, az) => {
      const cx = Math.floor(p.position.x / S) * S;
      const cz = Math.floor(p.position.z / S) * S;
      return ax > 0.5 ? cx + S - p.position.x : ax < -0.5 ? p.position.x - cx : az > 0.5 ? cz + S - p.position.z : p.position.z - cz;
    };
    // vorwärts + links (diagonal) bis knapp vor die vordere linke Ecke der Rampe
    const reached = runUntil(game, () => {
      const front = edge(fx, fz);
      const left = edge(lx, lz);
      const high = p.position.y > startY + 2;
      f.moveZ = front > 1.0 || !high ? 1 : 0;
      f.moveX = left > 0.95 ? -1 : 0;
      return p.grounded && high && front < 1.05 && left < 1.0 && Math.hypot(p.velocity.x, p.velocity.z) < 0.5;
    }, 4);
    f.moveZ = 0;
    f.moveX = 0;
    heights.push(p.position.y);
    if (!reached) break;
    yaw += Math.PI / 2; // 90° nach links
    f.yaw = yaw;
    tap(game, f);
    buildOnce(game, p, f, 'wall'); // Wand an der Seite (unter der nächsten Rampe)
    tap(game, f, { selectBuild: 'ramp' });
    const level = Math.floor((p.position.y + 0.01) / H);
    f.moveZ = 1;
    tap(game, f, { jumpPressed: true });
    // in der Luft: sobald die Vorschau eine Ebene höher steht, Rampe setzen
    runUntil(game, () => {
      const t = game.building.getTarget(p, 'ramp');
      return t.j === level + 1 && t.valid;
    }, 1);
    f.primary = true;
    tap(game, f, { primaryPressed: true });
    f.primary = false;
    tap(game, f);
    buildOnce(game, p, f, 'wall'); // Wand vor der neuen Rampe (an ihrem oberen Ende)
    runUntil(game, () => p.grounded, 2);
  }
  return heights;
}

describe('Szenario: Techniken (nur mit Befehlen)', () => {
  it('90er: jede Runde höher, über 12 m, ohne Fallschaden', () => {
    const { game, p, f } = practice(2, 34);
    const heights = nineties(game, p, f, 5);
    assert.ok(heights.length >= 4, `Runden: ${heights.length}`);
    for (let n = 1; n < heights.length; n++) {
      assert.ok(heights[n] > heights[n - 1] + 3, `Runde ${n}: ${heights.map((h) => h.toFixed(1)).join(' → ')}`);
    }
    assert.ok(Math.max(...heights) >= 12, `höchster Punkt ${Math.max(...heights).toFixed(1)} m`);
    assert.equal(p.health, CONFIG.modes.practice.startHealth);
    assert.equal(p.shield, CONFIG.modes.practice.startShield);
    // Spirale: Rampen in 4 verschiedenen Richtungen
    const dirs = new Set([...game.building.pieces.values()].filter((x) => x.type === 'ramp').map((x) => x.dir));
    assert.equal(dirs.size, 4);
    game.dispose();
  });

  it('Ramp Rush: vorwärts laufen, Rampe + Wand davor – mindestens 3 Ebenen hoch', () => {
    const { game, p, f } = practice(2, 34);
    f.moveZ = 1;
    f.primary = true; // Maus gedrückt halten, Bauteile abwechselnd wählen
    let maxY = 0;
    for (let t = 0; t < 60 * 3; t++) {
      if (t % 4 === 0) f.selectBuild = (t / 4) % 2 === 0 ? 'ramp' : 'wall';
      game.fixedUpdate(1 / 60);
      maxY = Math.max(maxY, p.position.y);
    }
    assert.ok(maxY >= 3 * H, `höchster Punkt ${maxY.toFixed(1)} m`);
    const ramps = [...game.building.pieces.values()].filter((x) => x.type === 'ramp');
    const walls = [...game.building.pieces.values()].filter((x) => x.type === 'wall');
    assert.ok(ramps.length >= 3 && walls.length >= 3, `${ramps.length} Rampen, ${walls.length} Wände`);
    // jede Wand steht am oberen Ende einer Rampe (blockt den Weg nicht)
    for (const w of walls) {
      assert.ok(ramps.some((r) => r.j === w.j && r.i === w.i && r.k === w.k), `Wand ${w.slotKey} vor einer Rampe`);
    }
    assert.equal(p.health, CONFIG.modes.practice.startHealth);
    game.dispose();
  });
});

describe('Szenario: 3000 Bauteile (Leistung)', () => {
  it('bis zur Grenze bauen, das 3001. geht nicht; Strahlen und Bild bleiben schnell', () => {
    const game = new Game({ headless: true, seed: 1 });
    const b = game.building;
    const owner = game.addCharacter({ name: 'Bauer', isBot: true, brain: null, position: { x: 500, y: 0, z: 500 } });
    let t0 = performance.now();
    let placed = 0;
    for (let i = -30; i < 30 && placed < B.maxPieces; i++) {
      for (let k = -25; k < 25 && placed < B.maxPieces; k++) {
        if (b.placePiece('floor', `f:${i}:0:${k}`, owner, 'wood')) placed++;
      }
    }
    const placeMs = performance.now() - t0;
    assert.equal(placed, B.maxPieces);
    assert.equal(b.pieces.size, B.maxPieces);
    assert.equal(b.countFor(owner), B.maxPieces);
    assert.equal(b.placePiece('wall', 'wx:40:0:40', owner, 'wood'), null, 'das 3001. Teil geht nicht');
    assert.equal(b.checkPlacement('wall', 'wx', 40, 0, 40, 0, owner), 'limit');
    // Strahlen
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    t0 = performance.now();
    let hits = 0;
    for (let n = 0; n < 1000; n++) {
      const o = { x: (rnd() - 0.5) * 200, y: 1 + rnd() * 20, z: (rnd() - 0.5) * 180 };
      const d = { x: rnd() - 0.5, y: -rnd(), z: rnd() - 0.5 };
      const len = Math.hypot(d.x, d.y, d.z);
      d.x /= len; d.y /= len; d.z /= len;
      if (game.world.raycast(o, d, 200, { skipTerrain: true })) hits++;
    }
    const rayMs = performance.now() - t0;
    assert.ok(hits > 200, `${hits} Treffer`);
    // Logik-Schritt und Bild (ohne Bildschirm) mit 3000 Teilen
    t0 = performance.now();
    game.simulate(1);
    const tickMs = (performance.now() - t0) / 60;
    t0 = performance.now();
    for (let n = 0; n < 60; n++) game.frameUpdate(1 / 60, 1);
    const frameMs = (performance.now() - t0) / 60;
    assert.ok(placeMs < 6000, `3000 Teile setzen: ${placeMs.toFixed(0)} ms`);
    assert.ok(rayMs < 400, `1000 Strahlen: ${rayMs.toFixed(0)} ms`);
    assert.ok(tickMs < 8, `Logik-Schritt: ${tickMs.toFixed(2)} ms`);
    assert.ok(frameMs < 8, `Bild: ${frameMs.toFixed(2)} ms`);
    // Einsturz-Suche über 3000 Teile bleibt schnell
    t0 = performance.now();
    b.removePiece(b.getPieceAt('f:0:0:0'));
    const removeMs = performance.now() - t0;
    assert.ok(removeMs < 100, `Entfernen + Halt-Suche: ${removeMs.toFixed(1)} ms`);
    game.dispose();
  });

  it('mit Bildschirm (nur im Browser): fertige Teile in InstancedMeshes, Aufbau/Edit einzeln, Vorschau', () => {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return; // Node: übersprungen
    const game = new Game({ headless: false, seed: 1 });
    game.startMode('practice');
    const p = game.player;
    p.spawnAt({ x: 2, y: 0, z: 30 }, 0, 0);
    const f = driveByCommands(p, 0, 0);
    const b = game.building;
    for (let n = 0; n < 200; n++) b.placePiece('floor', `f:${-20 + (n % 20)}:0:${-5 + Math.floor(n / 20)}`, p, 'stone', { instant: true });
    const wall = buildOnce(game, p, f, 'wall');
    game.frameUpdate(1 / 60, 1);
    let stats = b.view.stats();
    assert.equal(stats.instanced, 200, 'fertige Böden als Instanzen');
    assert.ok(stats.drawCalls <= 2, `Zeichen-Aufrufe: ${stats.drawCalls}`);
    assert.ok(stats.singles >= 1, 'Wand im Aufbau einzeln');
    assert.ok(b.view.root.getObjectByName('Vorschau wall').visible, 'Vorschau sichtbar');
    game.simulate(1.1);
    game.frameUpdate(1 / 60, 1);
    stats = b.view.stats();
    assert.equal(stats.instanced, 201, 'nach dem Aufbau in der InstancedMesh');
    b.setEdit(wall, (1 << 4) | (1 << 7));
    game.frameUpdate(1 / 60, 1);
    assert.equal(b.view.stats().instanced, 200, 'editiert = eigene Form');
    // 3000 Teile: Bild-Vorbereitung bleibt schnell
    for (let n = 200; n < B.maxPieces - 1; n++) b.placePiece('floor', `f:${-30 + (n % 60)}:0:${10 + Math.floor(n / 60)}`, p, 'wood', { instant: true, force: true });
    const t0 = performance.now();
    for (let n = 0; n < 30; n++) game.frameUpdate(1 / 60, 1);
    const ms = (performance.now() - t0) / 30;
    assert.ok(ms < 10, `frameUpdate mit 3000 Teilen: ${ms.toFixed(2)} ms`);
    game.dispose();
  });
});
