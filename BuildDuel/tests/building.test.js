// Einheiten-Tests für das Bau-Raster (grid.js), die Bauteil-Formen (pieces.js)
// und die zugeschnittenen Schrägen (physics.js, spec.clip)
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import { CollisionWorld, slopeSurfaceY } from '../src/physics.js';
import {
  slotKey, parseSlotKey, numericSlotKey, wallSlotForSide, slotBounds, slotShape, shapesTouch, dirFromYaw,
  presentRects, isDoorMask, tilesToMask, maskToTiles, fullTileMask, selectTarget, createTarget, rampSpec, roofSpec,
  RAMP_V_THICKNESS, ROOF_V_THICKNESS, levelIndex, cellIndex,
} from '../src/building/grid.js';
import { pieceColliderSpecs, pickTile, isDoorPiece, halfRampDirection } from '../src/building/pieces.js';

const S = CONFIG.world.gridCellSize;
const H = CONFIG.world.wallHeight;
const T = CONFIG.building.pieceThickness;
const DEG = Math.PI / 180;

// Test-Figur (nur die Felder, die die Zielwahl braucht)
function figure(x, y, z, yaw = 0, pitch = 0, extra = {}) {
  return { position: { x, y, z }, yaw, pitch, crouching: false, grounded: true, buildRotation: 0, radius: 0.4, ...extra };
}
// Blick-Richtung aus yaw/pitch
function aim(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
// Ziel mit leerer Welt (flacher Boden) und ohne Bauteile
function target(c, type, world = new CollisionWorld(CONFIG), getPiece = null) {
  return selectTarget(c, type, aim(c.yaw, c.pitch), world, getPiece, createTarget());
}
const key = (t) => slotKey(t.kind, t.i, t.j, t.k);

describe('Spielwerte: Bauen (Welle 2a) passen zusammen', () => {
  const B = CONFIG.building;
  it('Zielwahl: Reichweiten, Ebenen-Grenzen, Blick nach oben erreichbar', () => {
    for (const type of B.pieceTypes) {
      const r = B.targetReach[type];
      assert.ok(r > 0 && r < (B.maxPlaceCells + 1) * S, `${type}: ${r}`);
    }
    assert.ok(B.targetReach.roof < S / 2, 'Dach: aus der Zellen-Mitte geradeaus = über dir');
    assert.ok(B.targetReach.ramp > S / 2, 'Rampe: aus der Zellen-Mitte geradeaus = Zelle davor');
    assert.ok(B.levelEpsilon > 0 && B.levelEpsilon < H / 4);
    const jump = CONFIG.player.jumpVelocity ** 2 / (2 * CONFIG.world.gravity);
    assert.ok(jump > B.levelEpsilon + 0.6, '90er: im Sprung erreicht man die nächste Ebene');
    assert.ok(B.lookUpPitch > 0 && B.lookUpPitch < CONFIG.camera.maxPitch);
    assert.equal(B.rotationSteps, 4);
    assert.ok(B.placeCooldown >= 1 / CONFIG.loop.tickRate - 1e-9, 'mindestens ein Logik-Schritt');
  });

  it('Edit/Tür: Tür ist höher als die Figur, Reichweiten sinnvoll', () => {
    const doorHeight = (2 * H) / 3;
    assert.ok(doorHeight > CONFIG.player.hitbox.height + 0.3, `Tür ${doorHeight} m`);
    assert.ok(S / 3 > CONFIG.player.hitbox.radius * 2 + 0.2, 'Tür breiter als die Figur');
    assert.ok(B.editReach > S && B.editMaxDistance >= B.editReach);
    assert.ok(B.doorNearDistance < S && B.useReach > B.doorNearDistance);
    assert.ok(B.doorOpenTime > 0 && B.doorOpenAngle > 45);
  });

  it('Aussehen: Risse unter 50 %, Aufbau wird fester, Einsturz-Animation', () => {
    assert.equal(B.crackThreshold, 0.5);
    assert.ok(B.damageDarkening >= 0 && B.damageDarkening <= 1);
    assert.ok(B.constructionOpacity.start > 0 && B.constructionOpacity.start < B.constructionOpacity.end && B.constructionOpacity.end <= 1);
    assert.ok(B.collapseAnimTime > 0 && B.collapseDelay >= 0);
    assert.equal(B.maxPieces, 3000);
    assert.ok(B.textureSize >= 64 && (B.textureSize & (B.textureSize - 1)) === 0, 'Zweierpotenz');
  });
});

describe('Bau-Raster: Plätze (Slots)', () => {
  it('Schlüssel hin und zurück, ungültige Schlüssel → null', () => {
    for (const k of ['f:0:0:0', 'wx:-3:2:5', 'wz:7:0:-1', 'r:1:1:1', 'c:-2:3:4']) {
      const p = parseSlotKey(k);
      assert.ok(p, k);
      assert.equal(slotKey(p.kind, p.i, p.j, p.k), k);
    }
    assert.equal(parseSlotKey('wx:1:2'), null);
    assert.equal(parseSlotKey('q:1:2:3'), null);
    assert.equal(parseSlotKey('f:1.5:0:0'), null);
    assert.equal(parseSlotKey(null), null);
    assert.equal(parseSlotKey('wx:1:2:3').type, 'wall');
    assert.equal(parseSlotKey('c:1:2:3').type, 'roof');
  });

  it('Zahl-Schlüssel sind eindeutig', () => {
    const seen = new Set();
    for (const kind of ['f', 'wx', 'wz', 'r', 'c']) {
      for (let i = -2; i <= 2; i++) for (let j = -1; j <= 2; j++) for (let k = -2; k <= 2; k++) seen.add(numericSlotKey(kind, i, j, k));
    }
    assert.equal(seen.size, 5 * 5 * 4 * 5);
  });

  it('Nachbar-Zellen teilen sich Wände', () => {
    for (const [i, j, k] of [[0, 0, 0], [-3, 2, 5]]) {
      assert.deepEqual(wallSlotForSide(i, j, k, 0), wallSlotForSide(i + 1, j, k, 2), 'Ost = West der Nachbar-Zelle');
      assert.deepEqual(wallSlotForSide(i, j, k, 1), wallSlotForSide(i, j, k + 1, 3), 'Süd = Nord der Nachbar-Zelle');
    }
    // eine Zelle hat 4 verschiedene Wände (ARCHITECTURE.md §3)
    const keys = [0, 1, 2, 3].map((d) => { const w = wallSlotForSide(2, 1, 3, d); return slotKey(w.kind, w.i, w.j, w.k); });
    assert.deepEqual(keys.sort(), ['wx:2:1:3', 'wx:2:1:4', 'wz:2:1:3', 'wz:3:1:3'].sort());
  });

  it('Maße der Plätze: Boden, Wand, Rampe, Dach', () => {
    const f = slotBounds('f', 1, 2, -1);
    assert.deepEqual([f.minX, f.maxX, f.minZ, f.maxZ], [4, 8, -4, 0]);
    assert.close(f.minY, 2 * H - T / 2, 1e-9);
    assert.close(f.maxY, 2 * H + T / 2, 1e-9);
    const wx = slotBounds('wx', 0, 1, 2);
    assert.deepEqual([wx.minX, wx.maxX, wx.minY, wx.maxY], [0, 4, 4, 8]);
    assert.close(wx.maxZ - wx.minZ, T, 1e-9);
    assert.close((wx.maxZ + wx.minZ) / 2, 2 * S, 1e-9);
    const wz = slotBounds('wz', 3, 0, 1);
    assert.close((wz.minX + wz.maxX) / 2, 3 * S, 1e-9);
    assert.deepEqual([wz.minZ, wz.maxZ], [4, 8]);
    const r = slotBounds('r', 0, 1, 0);
    assert.close(r.maxY, 2 * H, 1e-9);
    assert.close(r.minY, H - RAMP_V_THICKNESS, 1e-9);
    const c = slotBounds('c', 0, 1, 0);
    assert.close(c.maxY, H + CONFIG.building.roofHeight, 1e-9);
  });

  it('Rampen-Form steigt in Richtung dir um eine Ebene (gleich wie der Collider)', () => {
    const world = new CollisionWorld(CONFIG);
    for (let dir = 0; dir < 4; dir++) {
      const shape = slotShape('r', 1, 0, -2, dir);
      const collider = world.addSlope(rampSpec(1, 0, -2, dir));
      for (const [x, z] of [[4.2, -7.5], [5, -6], [7.9, -4.1], [6, -5]]) {
        assert.close(slopeSurfaceY(shape, x, z), slopeSurfaceY(collider, x, z), 1e-9, `dir ${dir} bei ${x},${z}`);
      }
      // unten an der Start-Seite, oben an der Gegenseite
      const d = [[1, 0], [0, 1], [-1, 0], [0, -1]][dir];
      const low = slopeSurfaceY(shape, 6 - d[0] * 2, -6 - d[1] * 2);
      const high = slopeSurfaceY(shape, 6 + d[0] * 2, -6 + d[1] * 2);
      assert.close(low, 0, 1e-9);
      assert.close(high, H, 1e-9);
    }
  });

  it('Ebene und Zelle aus Koordinaten', () => {
    assert.equal(cellIndex(-0.1), -1);
    assert.equal(cellIndex(3.99), 0);
    assert.equal(levelIndex(3.8, 0.3), 1);
    assert.equal(levelIndex(3.6, 0.3), 0);
    assert.equal(dirFromYaw(0), 3, 'yaw 0 = Blick nach −Z');
    assert.equal(dirFromYaw(Math.PI / 2), 2, 'links drehen = −X');
    assert.equal(dirFromYaw(-Math.PI / 2), 0);
    assert.equal(dirFromYaw(Math.PI), 1);
  });
});

describe('Bau-Raster: Berührung (Halt)', () => {
  const touch = (a, b) => shapesTouch(slotShape(...a), slotShape(...b));
  it('Böden nebeneinander, Wand auf Boden, Wand auf Wand', () => {
    assert.ok(touch(['f', 0, 1, 0, 0], ['f', 1, 1, 0, 0]));
    assert.ok(!touch(['f', 0, 1, 0, 0], ['f', 2, 1, 0, 0]), 'zwei Zellen weg');
    assert.ok(touch(['wx', 0, 1, 0, 0], ['f', 0, 1, 0, 0]));
    assert.ok(touch(['wx', 0, 1, 0, 0], ['wx', 0, 0, 0, 0]), 'Wand auf Wand');
    assert.ok(touch(['wx', 0, 0, 0, 0], ['wz', 0, 0, 0, 0]), 'Ecke');
    assert.ok(!touch(['wx', 0, 2, 0, 0], ['wx', 0, 0, 0, 0]), 'Lücke dazwischen');
  });

  it('Rampen-Kette berührt sich, Dach sitzt auf den Wänden', () => {
    assert.ok(touch(['r', 0, 0, 0, 3], ['r', 0, 1, -1, 3]), 'oben an unten');
    assert.ok(!touch(['r', 0, 0, 0, 3], ['r', 0, 1, 1, 3]), 'falsche Seite');
    assert.ok(touch(['c', 0, 1, 0, 0], ['wx', 0, 0, 0, 0]), 'Dach auf Wand');
    assert.ok(touch(['r', 0, 0, 0, 3], ['wx', 0, 0, 0, 0]), 'Wand am oberen Ende');
    // Wand eine Ebene höher über dem UNTEREN Ende der Rampe berührt sie nicht
    assert.ok(!touch(['r', 0, 0, 0, 3], ['wx', 0, 1, 1, 0]));
  });
});

describe('Bau-Raster: Edit-Felder', () => {
  it('Felder ↔ Bitmaske, Tür erkennen', () => {
    assert.equal(tilesToMask([4, 7]), (1 << 4) | (1 << 7));
    assert.deepEqual(maskToTiles(tilesToMask(new Set([0, 8, 3]))), [0, 3, 8]);
    assert.equal(fullTileMask('wall'), 511);
    assert.equal(fullTileMask('floor'), 15);
    assert.ok(isDoorMask('wall', tilesToMask(CONFIG.building.wallDoorCells)));
    assert.ok(!isDoorMask('wall', tilesToMask([4])));
    assert.ok(!isDoorMask('floor', tilesToMask([4, 7])));
  });

  it('vorhandene Felder → wenige Rechtecke, Fläche stimmt', () => {
    assert.deepEqual(presentRects(3, 3, 0), [{ col0: 0, row0: 0, cols: 3, rows: 3 }]);
    const door = presentRects(3, 3, tilesToMask([4, 7]));
    assert.equal(door.length, 3);
    assert.equal(door.reduce((a, r) => a + r.cols * r.rows, 0), 7);
    for (let mask = 0; mask < 16; mask++) {
      const rects = presentRects(2, 2, mask);
      const area = rects.reduce((a, r) => a + r.cols * r.rows, 0);
      assert.equal(area, 4 - maskToTiles(mask).length, `Maske ${mask}`);
    }
  });

  it('Kollision je Edit: Tür = 3 Wand-Stücke + Tür-Blatt, Boden-Ecke weg = 2 Boxen', () => {
    const wall = { type: 'wall', kind: 'wx', i: 0, j: 0, k: 0, dir: 0, editMask: tilesToMask([4, 7]) };
    const specs = pieceColliderSpecs(wall);
    assert.equal(specs.length, 4);
    assert.equal(specs.filter((s) => s.door).length, 1);
    assert.ok(isDoorPiece(wall));
    const door = specs.find((s) => s.door);
    assert.close(door.max.y - door.min.y, (2 * H) / 3, 1e-9, 'Tür ist 2 Felder hoch');
    const floor = { type: 'floor', kind: 'f', i: 0, j: 1, k: 0, dir: 0, editMask: tilesToMask([3]) };
    assert.equal(pieceColliderSpecs(floor).length, 2);
    const ramp = { type: 'ramp', kind: 'r', i: 0, j: 0, k: 0, dir: 3, editMask: tilesToMask([0, 2]) };
    const rs = pieceColliderSpecs(ramp);
    assert.equal(rs.length, 1, 'halbe Rampe');
    assert.deepEqual([rs[0].spec.minX, rs[0].spec.maxX, rs[0].spec.minZ, rs[0].spec.maxZ], [S / 2, S, 0, S]);
    assert.deepEqual([rs[0].spec.dir, rs[0].spec.rise], [3, H], 'gleiche Richtung, ganze Höhe');
    const roof = { type: 'roof', kind: 'c', i: 0, j: 1, k: 0, dir: 0, editMask: tilesToMask([1]) };
    assert.equal(pieceColliderSpecs(roof).length, 2, 'Dach ohne ein Viertel');
  });

  it('Rampen-Edit: 1 Feld weg = Ecktreppe (Rampe – Podest – Rampe), lückenlos eine Ebene hoch', () => {
    // für jede Richtung und jedes entfernte Feld: Höhen über die Kollision prüfen
    for (let dir = 0; dir < 4; dir++) {
      for (let removed = 0; removed < 4; removed++) {
        const ramp = { type: 'ramp', kind: 'r', i: 2, j: 1, k: -1, dir, editMask: 1 << removed };
        const specs = pieceColliderSpecs(ramp);
        const what = `Richtung ${dir}, Feld ${removed} weg`;
        assert.deepEqual(specs.map((s) => s.stair), ['low', 'landing', 'high'], what);
        const world = new CollisionWorld(CONFIG);
        for (const s of specs) {
          if (s.type === 'box') world.addBox(s.min, s.max);
          else world.addSlope(s.spec);
        }
        const x0 = 2 * S;
        const z0 = -1 * S;
        const y0 = 1 * H;
        const center = (t) => ({ x: x0 + ((t % 2) + 0.5) * (S / 2), z: z0 + (Math.floor(t / 2) + 0.5) * (S / 2) });
        const corner = 3 - removed;
        const top = (p) => world.surfaceHeight(p.x, p.z, y0 + H + 1);
        // Podest im Eck-Feld auf halber Höhe, das entfernte Feld frei
        assert.close(top(center(corner)), y0 + H / 2, 1e-6, `${what}: Podest`);
        assert.ok(top(center(removed)) < y0 - 1, `${what}: Loch`);
        // die beiden Ende-Felder: eins steigt von y0 zum Podest, das andere vom Podest auf y0 + H
        const ends = [corner ^ 1, corner ^ 2].map((t) => ({ t, h: top(center(t)) }));
        ends.sort((a, b) => a.h - b.h);
        assert.close(ends[0].h, y0 + H / 4, 1e-6, `${what}: untere Treppe (Mitte)`);
        assert.close(ends[1].h, y0 + (3 * H) / 4, 1e-6, `${what}: obere Treppe (Mitte)`);
        // lückenlos: an den Kanten zum Podest genau halbe Höhe
        for (const e of ends) {
          const a = center(e.t);
          const c = center(corner);
          const edge = { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 };
          assert.close(top({ x: edge.x + (a.x - c.x) * 0.02, z: edge.z + (a.z - c.z) * 0.02 }), y0 + H / 2, 0.06, `${what}: Kante Feld ${e.t}`);
        }
        // 45°: wie die ganze Rampe
        for (const s of specs.filter((x) => x.type === 'slope')) assert.close(s.spec.rise, H / 2, 1e-9);
        // unteres Ende = das Feld, das bei der ganzen Rampe tiefer lag
        const full = new CollisionWorld(CONFIG);
        full.addSlope(rampSpec(2, 1, -1, dir));
        const fullTop = (t) => full.surfaceHeight(center(t).x, center(t).z, y0 + H + 1);
        assert.ok(fullTop(ends[0].t) < fullTop(ends[1].t), `${what}: unten bleibt unten`);
      }
    }
  });

  it('Rampen-Edit: 2 Felder in einer Reihe weg = halbe Rampe; Richtung = Wahl-Reihenfolge (editDir), sonst gedreht', () => {
    const half = (dir, removed, editDir = null) => {
      const specs = pieceColliderSpecs({ type: 'ramp', kind: 'r', i: 0, j: 0, k: 0, dir, editMask: tilesToMask(removed), editDir });
      assert.equal(specs.length, 1);
      return specs[0].spec;
    };
    // Streifen entlang der alten Richtung: bleibt (oder umgedreht, wenn so gewählt)
    assert.equal(half(0, [0, 1]).dir, 0);
    assert.equal(half(0, [0, 1], 2).dir, 2, 'von rechts nach links gewählt → steigt nach −X');
    assert.equal(half(0, [0, 1], 1).dir, 0, 'Richtung quer zum Streifen zählt nicht');
    // Streifen quer zur alten Richtung: steigt entlang des Streifens
    const across = half(0, [1, 3]);
    assert.deepEqual([across.minX, across.maxX, across.minZ, across.maxZ], [0, S / 2, 0, S]);
    assert.equal(across.dir, 1, 'ohne Wahl: 90° weiter gedreht');
    assert.equal(half(0, [1, 3], 3).dir, 3);
    assert.equal(halfRampDirection(2, null, false), 3);
    // Diagonale bleibt die alte Form (zwei Stücke der ganzen Rampe)
    assert.equal(pieceColliderSpecs({ type: 'ramp', kind: 'r', i: 0, j: 0, k: 0, dir: 0, editMask: tilesToMask([0, 3]) }).length, 2);
  });

  it('pickTile: Feld unter dem Fadenkreuz (Wand, Boden, Rampe, Dach)', () => {
    const wall = { type: 'wall', kind: 'wx', i: 0, j: 0, k: 0 };
    // von z = +3 auf die Wand bei z = 0 schauen
    assert.equal(pickTile(wall, { x: 0.5, y: 3.5, z: 3 }, { x: 0, y: 0, z: -1 }), 0, 'oben links');
    assert.equal(pickTile(wall, { x: 2, y: 2, z: 3 }, { x: 0, y: 0, z: -1 }), 4, 'Mitte');
    assert.equal(pickTile(wall, { x: 2, y: 0.4, z: 3 }, { x: 0, y: 0, z: -1 }), 7, 'unten Mitte');
    assert.equal(pickTile(wall, { x: 3.5, y: 0.4, z: -3 }, { x: 0, y: 0, z: 1 }), 8, 'von hinten');
    assert.equal(pickTile(wall, { x: 5, y: 2, z: 3 }, { x: 0, y: 0, z: -1 }), -1, 'daneben');
    const floor = { type: 'floor', kind: 'f', i: 0, j: 1, k: 0 };
    assert.equal(pickTile(floor, { x: 3, y: 6, z: 1 }, { x: 0, y: -1, z: 0 }), 1);
    const ramp = { type: 'ramp', kind: 'r', i: 0, j: 0, k: 0, dir: 0 };
    assert.equal(pickTile(ramp, { x: 3, y: 9, z: 3 }, { x: 0, y: -1, z: 0 }), 3);
    const roof = { type: 'roof', kind: 'c', i: 0, j: 1, k: 0 };
    assert.equal(pickTile(roof, { x: 1, y: 9, z: 3 }, { x: 0, y: -1, z: 0 }), 2);
  });

  it('pickTile Dach: trifft die Pyramiden-Flächen (Viertel-Mitte und 0,4 m vom Rand, von oben und von unten)', () => {
    const i = 1;
    const j = 1;
    const k = -2;
    const roof = { type: 'roof', kind: 'c', i, j, k };
    const cx = (i + 0.5) * S;
    const cz = (k + 0.5) * S;
    const h = S / 2;
    const rise = CONFIG.building.roofHeight;
    const top = (x, z) => j * H + rise * (1 - Math.max(Math.abs(x - cx), Math.abs(z - cz)) / h);
    const dirTo = (o, p) => {
      const d = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
      const len = Math.hypot(d.x, d.y, d.z);
      return { x: d.x / len, y: d.y / len, z: d.z / len, len };
    };
    let checked = 0;
    for (let tile = 0; tile < 4; tile++) {
      const sx = tile % 2 ? 1 : -1; // Spalte 1 = großes x
      const sz = tile >= 2 ? 1 : -1; // Reihe 1 = großes z
      for (const ox of [0.4, 1, h - 0.4]) {
        for (const oz of [0.4, 1, h - 0.4]) {
          // Punkt im Viertel, ox/oz Meter vom äußeren Rand der Zelle
          const x = cx + sx * (h - ox);
          const z = cz + sz * (h - oz);
          // von oben (schräg von außen)
          const upPoint = { x, y: top(x, z), z };
          const above = { x: x + sx * 2, y: upPoint.y + 4, z: z + sz * 2 };
          const d1 = dirTo(above, upPoint);
          const out = { distance: 0 };
          assert.equal(pickTile(roof, above, d1, 50, out), tile, `oben ${tile} (${ox}, ${oz})`);
          assert.close(out.distance, d1.len, 1e-6, 'Abstand bis zur Oberseite');
          // von unten (aus der Box darunter, Augenhöhe, verschiedene Standorte)
          const downPoint = { x, y: top(x, z) - ROOF_V_THICKNESS, z };
          for (const eye of [{ x: cx, y: j * H - 2.4, z: cz }, { x: cx - 1.4, y: j * H - 2.6, z: cz + 1.3 }, { x: x - sx * 0.3, y: j * H - 2.4, z: z - sz * 0.2 }]) {
            const d2 = dirTo(eye, downPoint);
            assert.equal(pickTile(roof, eye, d2, 50, out), tile, `unten ${tile} (${ox}, ${oz}) von ${eye.x},${eye.z}`);
            assert.close(out.distance, d2.len, 1e-6, 'Abstand bis zur Unterseite');
            checked++;
          }
        }
      }
    }
    assert.equal(checked, 4 * 9 * 3);
    // daneben (über der Nachbar-Zelle) und waagerecht unter dem Dach vorbei: kein Feld
    assert.equal(pickTile(roof, { x: cx + 3, y: 9, z: cz }, { x: 0, y: -1, z: 0 }), -1);
    assert.equal(pickTile(roof, { x: cx - 5, y: j * H - 0.5, z: cz }, { x: 1, y: 0, z: 0 }), -1);
  });
});

describe('Physik: zugeschnittene Schrägen (Edit)', () => {
  it('halbe Rampe: gleiche Höhe, kleiner Umriss, Strahl daneben trifft nicht', () => {
    const world = new CollisionWorld(CONFIG);
    const full = rampSpec(0, 0, 0, 0);
    const half = world.addSlope({ ...full, clip: { minX: 0, maxX: 4, minZ: 2, maxZ: 4 } });
    assert.deepEqual([half.minZ, half.maxZ], [2, 4]);
    assert.close(slopeSurfaceY(half, 3, 3), 3, 1e-9);
    const down = { x: 0, y: -1, z: 0 };
    assert.ok(world.raycast({ x: 3, y: 10, z: 3 }, down, 20, { skipTerrain: true }), 'auf dem Stück');
    assert.equal(world.raycast({ x: 3, y: 10, z: 1 }, down, 20, { skipTerrain: true }), null, 'im Loch');
    assert.close(world.surfaceHeight(3, 1, 10), 0, 1e-9, 'im Loch: nur der Boden');
  });

  it('Dach-Viertel: Spitze in der Ecke, Höhe wie beim ganzen Dach', () => {
    const world = new CollisionWorld(CONFIG);
    const spec = roofSpec(0, 1, 0);
    const quarter = world.addSlope({ ...spec, clip: { minX: 2, maxX: 4, minZ: 0, maxZ: 2 } });
    const whole = new CollisionWorld(CONFIG).addSlope(spec);
    for (const [x, z] of [[2.1, 1.9], [3, 1], [3.9, 0.1], [2.5, 0.5]]) {
      assert.close(slopeSurfaceY(quarter, x, z), slopeSurfaceY(whole, x, z), 1e-9);
    }
    const hit = world.raycast({ x: 3, y: 10, z: 1 }, { x: 0, y: -1, z: 0 }, 20, { skipTerrain: true });
    assert.ok(hit && Math.abs(hit.point.y - slopeSurfaceY(whole, 3, 1)) < 1e-6);
    assert.equal(world.raycast({ x: 1, y: 10, z: 1 }, { x: 0, y: -1, z: 0 }, 20, { skipTerrain: true }), null);
  });
});

describe('Bau-Raster: Zielwahl', () => {
  // Figur in der Mitte der Zelle (0, 0, 5): x 0..4, z 20..24
  const cx = 2;
  const cz = 22;

  it('Wand: an der Kante der eigenen Zelle in Blickrichtung (alle 4 Richtungen)', () => {
    const expect = { 0: 'wx:0:0:5', [Math.PI / 2]: 'wz:0:0:5', [Math.PI]: 'wx:0:0:6', [-Math.PI / 2]: 'wz:1:0:5' };
    for (const [yaw, k] of Object.entries(expect)) {
      assert.equal(key(target(figure(cx, 0, cz, Number(yaw)), 'wall')), k, `yaw ${yaw}`);
    }
    // auch knapp vor der Kante und leicht nach unten schauend: dieselbe Wand
    assert.equal(key(target(figure(cx, 0, 20.9, 0, -15 * DEG), 'wall')), 'wx:0:0:5');
    // nach oben schauen = eine Ebene höher
    assert.equal(key(target(figure(cx, 0, cz, 0, 55 * DEG), 'wall')), 'wx:0:1:5');
  });

  it('Boden: vor dir, nach unten schauen = unter dir, hoch = eine Ebene höher', () => {
    assert.equal(key(target(figure(cx, 0, cz), 'floor')), 'f:0:0:4');
    assert.equal(key(target(figure(cx, 0, cz, 0, -70 * DEG), 'floor')), 'f:0:0:5');
    assert.equal(key(target(figure(cx, 0, cz, 0, 60 * DEG), 'floor')), 'f:0:1:5');
  });

  it('Rampe: Zelle vor dir, steigt in Blickrichtung, R dreht', () => {
    const t = target(figure(cx, 0, cz), 'ramp');
    assert.equal(key(t), 'r:0:0:4');
    assert.equal(t.dir, 3);
    assert.equal(target(figure(cx, 0, cz, Math.PI / 2), 'ramp').dir, 2);
    const turned = target(figure(cx, 0, cz, 0, 0, { buildRotation: 1 }), 'ramp');
    assert.equal(turned.dir, 0, 'R: 90° weiter');
  });

  it('Dach: über dir (auf den Wänden der eigenen Zelle)', () => {
    assert.equal(key(target(figure(cx, 0, cz), 'roof')), 'c:0:1:5');
    assert.equal(key(target(figure(cx, 0, cz, Math.PI / 2, 30 * DEG), 'roof')), 'c:0:1:5');
  });

  it('nie weiter als maxPlaceCells Zellen weg', () => {
    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.3) {
      for (const pitch of [-0.6, 0, 0.4, 1.2]) {
        for (const type of ['wall', 'floor', 'ramp', 'roof']) {
          const t = target(figure(3.9, 0, 23.9, yaw, pitch), type);
          assert.ok(Math.abs(t.i - 0) <= 2 && Math.abs(t.k - 5) <= 2 && Math.abs(t.j) <= 2, `${type} ${key(t)}`);
          if (type !== 'wall') assert.ok(Math.abs(t.i) <= 1 && Math.abs(t.k - 5) <= 1, `${type} ${key(t)}`);
        }
      }
    }
  });

  it('Rampe davor: Wand kommt an ihr oberes Ende (Ramp Rush)', () => {
    const ramp = { dir: 3, collapsing: false };
    const getPiece = (kind, i, j, k) => (kind === 'r' && i === 0 && j === 0 && k === 4 ? ramp : null);
    assert.equal(key(target(figure(cx, 0, cz), 'wall', undefined, getPiece)), 'wx:0:0:4');
    // Rampe steigt quer → Wand bleibt vorn
    ramp.dir = 0;
    assert.equal(key(target(figure(cx, 0, cz), 'wall', undefined, getPiece)), 'wx:0:0:5');
  });

  it('Wand vor dir: Rampe kommt in deine Zelle (Wand + Rampe)', () => {
    const wall = { collapsing: false };
    const getPiece = (kind, i, j, k) => (kind === 'wx' && i === 0 && j === 0 && k === 5 ? wall : null);
    const t = target(figure(cx, 0, cz), 'ramp', undefined, getPiece);
    assert.equal(key(t), 'r:0:0:5');
    assert.equal(t.dir, 3);
  });

  it('auf einer Rampe: nächste Rampe eine Ebene höher (Ramp Rush), Wand auf Höhe der Rampe', () => {
    const world = new CollisionWorld(CONFIG);
    world.addSlope(rampSpec(0, 0, 5, 3)); // steigt nach −Z: z = 24 unten, z = 20 oben (4 m)
    const c = figure(cx, 1.5, 22.5); // auf der Rampe (Höhe 1,5 m bei z = 22,5)
    assert.equal(key(target(c, 'ramp', world)), 'r:0:1:4');
    assert.equal(key(target(c, 'wall', world)), 'wx:0:0:5', 'Wand am oberen Ende der eigenen Rampe');
    const top = figure(cx, 3.5, 20.5);
    assert.equal(key(target(top, 'ramp', world)), 'r:0:1:4');
  });

  it('im Sprung (90er): knapp unter der nächsten Ebene zählt schon die nächste', () => {
    const air = figure(cx, 3.75, cz, Math.PI / 2, 0, { grounded: false });
    assert.equal(key(target(air, 'ramp')), 'r:-1:1:5');
    const low = figure(cx, 3.5, cz, Math.PI / 2, 0, { grounded: false });
    assert.equal(target(low, 'ramp').j, 0);
  });

  it('über eine Kante nach unten schauen: Wand und Treppe eine Ebene tiefer', () => {
    const world = new CollisionWorld(CONFIG);
    world.addBox({ x: 0, y: 0, z: 20 }, { x: 4, y: 4, z: 24 }); // Plattform 4 m hoch (Karte)
    const c = figure(cx, 4, 20.6, 0, -55 * DEG);
    assert.equal(key(target(c, 'wall', world)), 'wx:0:0:5');
    const r = target(c, 'ramp', world);
    assert.equal(key(r), 'r:0:0:4');
    assert.equal(r.dir, 1, 'steigt zur Figur hin');
    // auf der Plattform nach unten auf die eigene Fläche schauen: keine Änderung
    assert.equal(key(target(figure(cx, 4, cz, 0, -55 * DEG), 'wall', world)), 'wx:0:1:5');
  });
});
