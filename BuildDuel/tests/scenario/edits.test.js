// Szenario-Tests: Edits wie in Fortnite (ohne Bildschirm)
// Figuren laufen nur über Befehle (wie ein Spieler mit Tastatur und Maus): G, Klicken,
// Ziehen, Loslassen – und danach zu Fuß über die neuen Formen (ohne zu springen).
import { describe, it, assert } from '../runner.js';
import { CONFIG } from '../../src/config.js';
import { Game } from '../../src/core/game.js';
import { slopeRangeOverRect } from '../../src/physics.js';
import { tilesToMask } from '../../src/building/grid.js';
import { roofSurfaceY, wallShapeOf } from '../../src/building/pieces.js';
import { driveByCommands, tap, lookAt, runUntil } from './buildHelpers.js';

const B = CONFIG.building;
const S = CONFIG.world.gridCellSize;
const H = CONFIG.world.wallHeight;
const T = B.pieceThickness;
const R = B.roofHeight;

// Spiel ohne Bildschirm mit einer Figur, die nur Befehle bekommt
function scene(x, z, yaw = 0) {
  const game = new Game({ headless: true, seed: 1 });
  const p = game.addCharacter({ name: 'Edit', isPlayer: false, position: { x, y: 0, z }, yaw, brain: null });
  const f = driveByCommands(p, yaw, 0);
  return { game, p, f, b: game.building };
}

// Laufen in Blickrichtung yaw, bis cond() stimmt; zählt, wie oft die Figur hängen bleibt
function walk(game, p, f, yaw, cond, seconds = 4) {
  f.yaw = yaw;
  f.pitch = 0;
  f.moveZ = 1;
  let stuck = 0;
  let worst = 0;
  const last = p.position.clone();
  const ok = runUntil(game, () => {
    const moved = p.position.distanceTo(last);
    last.copy(p.position);
    stuck = moved < 1e-4 ? stuck + 1 : 0;
    worst = Math.max(worst, stuck);
    return cond();
  }, seconds);
  f.moveZ = 0;
  return { ok, worst };
}
const pos = (p) => p.position.toArray().map((v) => v.toFixed(2)).join(', ');
// Blickrichtungen (vorwärts = (−sin yaw, −cos yaw))
const PLUS_X = -Math.PI / 2;
const MINUS_X = Math.PI / 2;
const PLUS_Z = Math.PI;
const MINUS_Z = 0;

describe('Szenario: Edits wie in Fortnite – Rampen-Weg, Dach-Ecken, Wand-Formen', () => {
  it('halbe Rampe (Weg 0 → 1) zu Fuß hinauf, ohne Sprung, oben auf den Boden', () => {
    const { game, p, f, b } = scene(-1, S / 4, PLUS_X);
    b.placePiece('ramp', 'r:0:0:0', p, 'wood', { dir: 0, editPath: [0, 1], instant: true, force: true });
    b.placePiece('floor', 'f:1:1:0', p, 'wood', { instant: true, force: true });
    const r = walk(game, p, f, PLUS_X, () => p.position.x >= 1.3 * S);
    game.simulate(0.2);
    assert.ok(r.ok && r.worst < 3, `oben angekommen: ${pos(p)}`);
    assert.close(p.position.y, H + T / 2, 0.02, 'auf dem Boden eine Ebene höher');
    assert.ok(p.grounded);
    game.dispose();
  });

  it('U-Treppe (Weg 0 → 2 → 3 → 1): Lauf hinauf, Kehre auf dem Podest, zweiter Lauf hinauf', () => {
    const { game, p, f, b } = scene(S / 4, -1.2, PLUS_Z);
    const ramp = b.placePiece('ramp', 'r:0:0:0', p, 'wood', { dir: 0, editPath: [0, 2, 3, 1], instant: true, force: true });
    assert.equal(ramp.colliders.length, 3);
    b.placePiece('floor', 'f:0:1:-1', p, 'wood', { instant: true, force: true }); // oben am Ende (z < 0)
    let r = walk(game, p, f, PLUS_Z, () => p.position.z >= 0.75 * S);
    assert.ok(r.ok && r.worst < 3, `auf dem Podest: ${pos(p)}`);
    assert.close(p.position.y, H / 2, 0.05, 'Podest auf halber Höhe');
    r = walk(game, p, f, PLUS_X, () => p.position.x >= 0.75 * S);
    assert.ok(r.ok && Math.abs(p.position.y - H / 2) < 0.05, `über das Podest: ${pos(p)}`);
    r = walk(game, p, f, MINUS_Z, () => p.position.z <= -1);
    game.simulate(0.2);
    assert.ok(r.ok && r.worst < 3, `oben angekommen: ${pos(p)}`);
    assert.close(p.position.y, H + T / 2, 0.02, 'eine Ebene hoch');
    game.dispose();
  });

  it('Rampen-Weg mit G ziehen: zurück aufs vorige Feld nimmt den Schritt zurück; 1 Feld ändert nichts', () => {
    // von der unteren Seite die Rampe hinauf schauen (steigt nach +X)
    const { game, p, f, b } = scene(-1.5, S / 2, PLUS_X);
    const ramp = b.placePiece('ramp', 'r:0:0:0', p, 'wood', { dir: 0, instant: true, force: true });
    const tile = (t) => ({ x: ((t % 2) + 0.5) * (S / 2), y: ((t % 2) + 0.5) * (H / 2), z: (Math.floor(t / 2) + 0.5) * (S / 2) });
    tap(game, f, { selectBuild: 'ramp' });
    lookAt(p, f, tile(2));
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'edit');
    f.primary = true;
    tap(game, f, { primaryPressed: true });
    for (const t of [0, 1, 0]) {
      lookAt(p, f, tile(t));
      tap(game, f);
    }
    assert.deepEqual(b.editSession(p).path, [2, 0], '0 → 1 → zurück auf 0: Schritt zurückgenommen');
    f.primary = false;
    tap(game, f, { primaryReleased: true });
    tap(game, f, { editPressed: true });
    assert.deepEqual(ramp.editPath, [2, 0], 'halbe Rampe');
    assert.equal(ramp.colliders.length, 1);
    assert.ok(ramp.colliders[0].b < 0, 'steigt von Feld 2 zu Feld 0 (−Z)');
    // nur 1 Feld anklicken → keine Änderung
    lookAt(p, f, tile(0));
    tap(game, f, { editPressed: true });
    tap(game, f, { primaryPressed: true });
    tap(game, f, { editPressed: true });
    assert.deepEqual(ramp.editPath, [2, 0], '1 Feld: unverändert');
    // Rechtsklick (Auto-Reset): ganze Rampe in der alten Richtung
    tap(game, f, { editPressed: true });
    tap(game, f, { secondaryPressed: true });
    assert.equal(ramp.editPath, null);
    assert.equal(ramp.editMask, 0);
    assert.ok(ramp.colliders[0].a > 0, 'wieder die ganze Rampe nach +X');
    game.dispose();
  });

  it('Dach: Ecken anklicken = hochziehen (Rampen-Pyramide), alle 4 geht nicht', () => {
    // von oben schauen: Figur auf einem Boden eine Ebene höher, neben dem Dach
    const { game, p, f, b } = scene(0.5 * S, 1.06 * S, MINUS_Z); // dicht an der Kante (Blick nicht auf den Boden)
    b.placePiece('floor', 'f:0:1:1', p, 'wood', { instant: true, force: true });
    p.position.y = H + T / 2;
    game.simulate(0.2);
    const roof = b.placePiece('roof', 'c:0:0:0', p, 'wood', { instant: true, force: true });
    const corner = (t) => {
      const x = ((t % 2) + 0.5) * (S / 2);
      const z = (Math.floor(t / 2) + 0.5) * (S / 2);
      return { x, y: roofSurfaceY(0, 0, 0, roof.editMask, x, z), z };
    };
    tap(game, f, { selectBuild: 'roof' });
    lookAt(p, f, corner(2));
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'edit');
    for (const t of [0, 1]) {
      lookAt(p, f, corner(t));
      tap(game, f);
      assert.equal(b.editSession(p).hover, t, `Feld ${t} unter dem Fadenkreuz`);
      tap(game, f, { primaryPressed: true });
    }
    tap(game, f, { editPressed: true });
    assert.equal(roof.editMask, 0b0011, 'Ecken 0 und 1 hochgezogen');
    assert.close(game.world.surfaceHeight(0.5 * S, 0.02, 10), R, 1e-3, 'hintere Kante oben');
    // alle 4 Ecken: geht nicht (bleibt wie es ist)
    lookAt(p, f, { x: 0.75 * S, y: R * 0.6, z: 0.75 * S });
    tap(game, f, { editPressed: true });
    for (const t of [2, 3]) {
      lookAt(p, f, corner(t));
      tap(game, f);
      tap(game, f, { primaryPressed: true });
    }
    tap(game, f, { editPressed: true });
    assert.equal(roof.editMask, 0b0011, 'alle 4 Ecken hoch gibt es nicht');
    game.dispose();
  });

  it('auf jeder Dach-Form stehen (Kollision = Fläche) und von unten mit dem Kopf anstoßen', () => {
    for (const tiles of [[], [0], [0, 1], [0, 3], [0, 1, 2]]) {
      const raise = tilesToMask(tiles);
      const game = new Game({ headless: true, seed: 1 });
      const b = game.building;
      const roof = b.placePiece('roof', 'c:0:0:0', null, 'wood', { edit: tiles, instant: true, force: true });
      assert.equal(roof.editMask, raise);
      for (const [fx, fz] of [[0.25, 0.25], [0.75, 0.3], [0.3, 0.8], [0.7, 0.7], [0.5, 0.5]]) {
        const x = fx * S;
        const z = fz * S;
        const surface = roofSurfaceY(0, 0, 0, raise, x, z);
        const c = game.addCharacter({ name: 'Stehen', position: { x, y: surface + 0.6, z }, brain: null });
        game.simulate(0.6);
        assert.close(c.position.y, surface, 0.03, `Dach ${tiles}: steht bei ${fx}, ${fz}`);
        assert.ok(c.grounded, 'steht fest');
        game.removeCharacter(c);
      }
      game.dispose();
    }
    // von unten: Dach eine Ebene hoch, Figur springt von einem Sockel
    for (const tiles of [[], [0], [0, 3]]) {
      const raise = tilesToMask(tiles);
      const game = new Game({ headless: true, seed: 1 });
      const roof = game.building.placePiece('roof', 'c:0:1:0', null, 'wood', { edit: tiles, instant: true, force: true });
      const x = 0.3 * S;
      const z = 0.3 * S;
      const collider = roof.colliders[0];
      const range = { min: 0, max: 0 };
      const r = CONFIG.player.radius ?? 0.4;
      const c0 = game.addCharacter({ name: 'Kopf', position: { x, y: 0, z }, brain: null });
      slopeRangeOverRect(collider, x - c0.radius, x + c0.radius, z - c0.radius, z + c0.radius, range);
      const ceiling = range.min - collider.vThickness;
      const pedestal = Math.max(0, ceiling - c0.height - 0.8); // ohne Dach ginge der Sprung 0,6 m höher
      game.world.addBox({ x: x - 1, y: 0, z: z - 1 }, { x: x + 1, y: pedestal, z: z + 1 });
      c0.position.set(x, pedestal, z);
      const f = driveByCommands(c0, 0, 0);
      game.simulate(0.2);
      f.jump = true;
      tap(game, f, { jumpPressed: true });
      f.jump = false;
      let top = c0.position.y;
      runUntil(game, () => {
        top = Math.max(top, c0.position.y);
        return false;
      }, 1);
      assert.ok(top + c0.height <= ceiling + 0.02, `Dach ${tiles}: Kopf an der Unterseite (${(top + c0.height).toFixed(2)} ≤ ${ceiling.toFixed(2)}, r ${r})`);
      assert.ok(top + c0.height >= ceiling - 0.05, `Dach ${tiles}: bis an die Unterseite gesprungen (${(top + c0.height).toFixed(2)})`);
      game.dispose();
    }
  });

  it('Bogen: durch die Öffnung laufen, das Bein blockiert', () => {
    const { game, p, f, b } = scene(S / 2, 2, MINUS_Z);
    const wall = b.placePiece('wall', 'wx:0:0:0', p, 'wood', { edit: [3, 4, 5, 6, 7, 8], instant: true, force: true });
    assert.equal(wallShapeOf(wall.editMask).name, 'arch');
    let r = walk(game, p, f, MINUS_Z, () => p.position.z <= -2);
    assert.ok(r.ok, `durch den Bogen: ${pos(p)}`);
    // am linken Bein (u = 0,15 m) anlaufen
    p.position.set(0.15, 0, 2);
    r = walk(game, p, f, MINUS_Z, () => p.position.z <= -2, 1.5);
    assert.ok(!r.ok && p.position.z > T / 2, `Bein blockiert: ${pos(p)}`);
    game.dispose();
  });

  it('Dreieck (hängt oben): wo es fehlt, kommt man durch; wo es ist, nicht', () => {
    const { game, p, f, b } = scene(0.15 * S, 2, MINUS_Z);
    const wall = b.placePiece('wall', 'wx:0:0:0', p, 'wood', { edit: [3, 6, 7], instant: true, force: true });
    assert.equal(wallShapeOf(wall.editMask).name, 'triangle');
    let r = walk(game, p, f, MINUS_Z, () => p.position.z <= -2);
    assert.ok(r.ok, `links unter dem Dreieck durch: ${pos(p)}`);
    p.position.set(0.85 * S, 0, 2);
    r = walk(game, p, f, MINUS_Z, () => p.position.z <= -2, 1.5);
    assert.ok(!r.ok && p.position.z > T / 2, `rechts blockiert: ${pos(p)}`);
    game.dispose();
  });

  it('Wand-Dreieck mit G ziehen (Felder 1 → 2 → 5), Bogen mit G ziehen (untere zwei Reihen)', () => {
    const { game, p, f, b } = scene(0.5 * S, 0.55 * S, MINUS_Z);
    const wall = b.placePiece('wall', 'wx:0:0:0', p, 'wood', { instant: true, force: true });
    const tile = (t) => ({ x: ((t % 3) + 0.5) * (S / 3), y: H - (Math.floor(t / 3) + 0.5) * (H / 3), z: 0 });
    const drag = (tiles) => {
      lookAt(p, f, tile(tiles[0]));
      tap(game, f, { editPressed: true });
      f.primary = true;
      tap(game, f, { primaryPressed: true });
      for (const t of tiles.slice(1)) {
        lookAt(p, f, tile(t));
        tap(game, f);
      }
      f.primary = false;
      tap(game, f, { primaryReleased: true });
      tap(game, f, { editPressed: true });
    };
    tap(game, f, { selectBuild: 'wall' });
    drag([1, 2, 5]);
    assert.equal(wall.editMask, tilesToMask([1, 2, 5]));
    assert.equal(wallShapeOf(wall.editMask).name, 'triangle');
    assert.equal(wall.colliders.length, B.wallCollisionSlices, 'Kollision aus Streifen');
    // zurücksetzen und Bogen
    tap(game, f, { editPressed: true });
    tap(game, f, { secondaryPressed: true });
    assert.equal(wall.editMask, 0);
    drag([3, 4, 5, 8, 7, 6]);
    assert.equal(wallShapeOf(wall.editMask)?.name, 'arch');
    game.dispose();
  });

  it('schneller Edit: linke Maustaste schon gedrückt, G tippen → Feld sofort gewählt, Loslassen bestätigt', () => {
    const game = new Game({ headless: true, seed: 1 });
    game.startMode('practice');
    const p = game.player;
    const z0 = 6 * S; // freie Stelle im Übungsplatz
    p.spawnAt({ x: 0.5 * S, y: 0, z: z0 + 0.55 * S }, 0, 0);
    const f = driveByCommands(p, 0, 0);
    game.settings.controls.editOnRelease = true;
    const b = game.building;
    const wall = b.placePiece('wall', 'wx:0:0:6', p, 'wood', { instant: true, force: true });
    const floor = b.placePiece('floor', 'f:0:0:6', p, 'wood', { instant: true, force: true });
    game.simulate(0.2);
    tap(game, f, { selectSlot: 1 });
    // Wand: Maus halten (schießt), dann G → Feld 4 sofort gewählt; Loslassen bestätigt
    lookAt(p, f, { x: S / 2, y: H / 2, z: z0 });
    f.primary = true;
    tap(game, f, { primaryPressed: true });
    tap(game, f);
    tap(game, f, { editPressed: true });
    assert.equal(p.mode, 'edit');
    assert.equal(b.editSession(p).selection, 1 << 4, 'Feld sofort gewählt');
    f.primary = false;
    tap(game, f, { primaryReleased: true });
    assert.equal(wall.editMask, 1 << 4, 'Loslassen bestätigt');
    assert.equal(p.mode, 'weapon', 'zurück zur Waffe');
    // gleich danach der Boden (Doppel-Edit)
    lookAt(p, f, { x: 0.25 * S, y: T / 2, z: z0 + 0.75 * S });
    f.primary = true;
    tap(game, f, { primaryPressed: true });
    tap(game, f, { editPressed: true });
    f.primary = false;
    tap(game, f, { primaryReleased: true });
    assert.equal(floor.editMask, 1 << 2, '2. Edit fertig');
    game.dispose();
  });
});
