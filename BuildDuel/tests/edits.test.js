// Einheiten-Tests: Edit-Formen wie in Fortnite (pieces.js, physics.js)
//   Wand: Dreieck, Bogen, halber Bogen · Rampe: halbe Rampe, L-, U-Treppe (Weg)
//   Dach: hochgezogene Ecken (1/4-Pyramide, Rampen-Pyramide, halb/viertel umgekehrt)
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import { CollisionWorld, slopeRangeOverRect, slopeSurfaceY } from '../src/physics.js';
import { tilesToMask, ROOF_V_THICKNESS } from '../src/building/grid.js';
import {
  pieceColliderSpecs, pickTile, wallShapeOf, isRampPath, rampPathOf, pathMask, pieceEditKey, isPieceEdited,
  roofSurfaceY, tileDirection,
} from '../src/building/pieces.js';

const S = CONFIG.world.gridCellSize;
const H = CONFIG.world.wallHeight;
const T = CONFIG.building.pieceThickness;
const R = CONFIG.building.roofHeight;

// Kollisions-Welt aus den Teilen eines Bauteils
function worldOf(piece) {
  const world = new CollisionWorld(CONFIG);
  for (const s of pieceColliderSpecs(piece)) {
    if (s.type === 'box') world.addBox(s.min, s.max);
    else world.addSlope(s.spec);
  }
  return world;
}

// Wand wx:0:0:0 (bei z = 0): trifft ein Strahl quer durch die Wand bei (u, v)?
function wallBlocks(world, u, v) {
  return !!world.raycast({ x: u, y: v, z: 2 }, { x: 0, y: 0, z: -1 }, 4, { skipTerrain: true });
}

// alle gültigen Rampen-Wege (2–4 Felder)
function allPaths() {
  const out = [];
  const grow = (path) => {
    if (path.length >= 2) out.push([...path]);
    if (path.length === 4) return;
    for (let t = 0; t < 4; t++) {
      if (!path.includes(t) && tileDirection(path[path.length - 1], t) >= 0) grow([...path, t]);
    }
  };
  for (let t = 0; t < 4; t++) grow([t]);
  return out;
}

describe('Edit-Formen: Wand (Dreieck, Bogen, halber Bogen)', () => {
  it('Dreieck: L aus 3 Feldern in einer Ecke weg → Dreieck auf der anderen Seite der Diagonale (alle 4 Ecken)', () => {
    // [entfernte Felder, liegt (u, v) im bleibenden Dreieck?]
    const cases = [
      [[1, 2, 5], (u, v) => v / H < 1 - u / S], // oben rechts weg: Ecken unten links, unten rechts, oben links
      [[0, 1, 3], (u, v) => v / H < u / S], // oben links weg
      [[5, 7, 8], (u, v) => v / H > u / S], // unten rechts weg (hängt oben)
      [[3, 6, 7], (u, v) => v / H > 1 - u / S], // unten links weg (hängt oben)
    ];
    for (const [tiles, inside] of cases) {
      const mask = tilesToMask(tiles);
      assert.equal(wallShapeOf(mask)?.name, 'triangle', `Felder ${tiles}`);
      const world = worldOf({ type: 'wall', kind: 'wx', i: 0, j: 0, k: 0, dir: 0, editMask: mask });
      // deutlich (> 0,4 m) neben der Diagonale: Kollision = Bild
      for (let a = 0.05; a < 1; a += 0.1) {
        for (let b = 0.05; b < 1; b += 0.1) {
          const u = a * S;
          const v = b * H;
          const dist = Math.min(Math.abs(b - (1 - a)), Math.abs(b - a)) * H;
          if (dist < 0.45) continue;
          assert.equal(wallBlocks(world, u, v), inside(u, v), `Felder ${tiles}: u ${u.toFixed(2)}, v ${v.toFixed(2)}`);
        }
      }
    }
  });

  it('Bogen: untere zwei Reihen weg → obere Reihe, dünne Beine, gerundete Ecken; Öffnung begehbar', () => {
    const mask = tilesToMask([3, 4, 5, 6, 7, 8]);
    assert.equal(wallShapeOf(mask).name, 'arch');
    const world = worldOf({ type: 'wall', kind: 'wx', i: 0, j: 0, k: 0, dir: 0, editMask: mask });
    const L = CONFIG.building.wallArchLegWidth;
    const V0 = (2 * H) / 3;
    assert.ok(L < S / 3 / 2, 'Beine dünner als ein halbes Feld');
    assert.ok(wallBlocks(world, L / 2, 0.5), 'linkes Bein');
    assert.ok(wallBlocks(world, S - L / 2, 1.5), 'rechtes Bein');
    assert.ok(wallBlocks(world, S / 2, (V0 + H) / 2), 'obere Reihe');
    assert.ok(!wallBlocks(world, S / 2, 1.2), 'Öffnung in der Mitte frei');
    assert.ok(!wallBlocks(world, L + 0.2, 0.5), 'gleich neben dem Bein frei (unten)');
    // gerundete Ecke: dicht an der Ecke zwischen Bein und oberer Reihe ist Wand
    assert.ok(wallBlocks(world, L + 0.1, V0 - 0.1), 'Rundung links');
    assert.ok(wallBlocks(world, S - L - 0.1, V0 - 0.1), 'Rundung rechts');
    // Figur passt durch: frei von 0 bis 2 m Höhe über 2,5 m Breite
    for (let u = S / 2 - 1.25; u <= S / 2 + 1.25; u += 0.25) {
      for (let v = 0.05; v < 2.05; v += 0.25) assert.ok(!wallBlocks(world, u, v), `frei bei u ${u.toFixed(2)}, v ${v.toFixed(2)}`);
    }
  });

  it('halber Bogen: 2x2 Felder unten in einer Ecke weg → Loch mit gerundeter Innen-Ecke', () => {
    for (const [tiles, side] of [[[4, 5, 7, 8], 1], [[3, 4, 6, 7], -1]]) {
      const mask = tilesToMask(tiles);
      assert.equal(wallShapeOf(mask).name, 'halfArch');
      const world = worldOf({ type: 'wall', kind: 'wx', i: 0, j: 0, k: 0, dir: 0, editMask: mask });
      const mirror = (u) => (side === 1 ? u : S - u);
      const V0 = (2 * H) / 3;
      assert.ok(wallBlocks(world, mirror(S / 6), 1), 'stehende Spalte');
      assert.ok(wallBlocks(world, mirror(S / 2), (V0 + H) / 2), 'obere Reihe');
      assert.ok(!wallBlocks(world, mirror((2 * S) / 3), 1), 'Loch');
      assert.ok(!wallBlocks(world, mirror(S - 0.2), V0 - 0.2), 'Loch bis an den Rand (keine zweite Rundung)');
      assert.ok(wallBlocks(world, mirror(S / 3 + 0.1), V0 - 0.1), 'gerundete Innen-Ecke');
      assert.ok(!wallBlocks(world, mirror(S / 3 + 0.1), 0.5), 'unten neben der Spalte frei');
    }
  });

  it('andere Masken bleiben normale Löcher (Tür, Fenster, halbe Wand)', () => {
    for (const tiles of [[4, 7], [4], [0, 1, 2], [3, 4, 5], [1, 2]]) assert.equal(wallShapeOf(tilesToMask(tiles)), null, `${tiles}`);
    const door = pieceColliderSpecs({ type: 'wall', kind: 'wx', i: 0, j: 0, k: 0, dir: 0, editMask: tilesToMask([4, 7]) });
    assert.equal(door.filter((s) => s.door).length, 1);
  });
});

describe('Edit-Formen: Rampe (Weg = was bleibt)', () => {
  it('Wege: 2–4 Felder, jedes neben dem vorigen; Maske = Felder neben dem Weg', () => {
    assert.ok(isRampPath([0, 1]) && isRampPath([0, 2, 3]) && isRampPath([0, 2, 3, 1]));
    assert.ok(!isRampPath([0]) && !isRampPath([0, 3]) && !isRampPath([0, 1, 0]) && !isRampPath([0, 1, 3, 2, 0]));
    assert.equal(allPaths().length, 4 * 2 + 4 * 2 + 4 * 2, '8 halbe Rampen, 8 L, 8 U');
    const ramp = { type: 'ramp', kind: 'r', i: 0, j: 0, k: 0, dir: 0, editMask: 0b1100, editPath: [1, 0] };
    assert.deepEqual(rampPathOf(ramp), [1, 0]);
    assert.equal(pathMask([1, 0]), 0b0011);
    assert.equal(pieceEditKey(ramp), 'p10');
    // U-Treppe: alle 4 Felder bleiben (Maske 0) – trotzdem editiert
    const u = { ...ramp, editMask: 0, editPath: [0, 2, 3, 1] };
    assert.ok(isPieceEdited(u));
    assert.ok(!isPieceEdited({ ...ramp, editMask: 0, editPath: null }));
  });

  it('jeder Weg: lückenlos von unten (Feld 1) bis eine Ebene hoch (letztes Feld), gleich steil wie die ganze Rampe', () => {
    const y0 = H; // Ebene 1
    const center = (t) => ({ x: ((t % 2) + 0.5) * (S / 2), z: (Math.floor(t / 2) + 0.5) * (S / 2) });
    for (const path of allPaths()) {
      const what = `Weg ${path.join('→')}`;
      for (const dir of [0, 1]) {
        const piece = { type: 'ramp', kind: 'r', i: 0, j: 1, k: 0, dir, editMask: 15 & ~pathMask(path), editPath: path };
        const specs = pieceColliderSpecs(piece);
        const world = worldOf(piece);
        const top = (p) => world.surfaceHeight(p.x, p.z, y0 + H + 1);
        // Steigung jedes Laufs = H / S (36,87°)
        for (const s of specs.filter((x) => x.type === 'slope')) {
          const run = s.spec.dir % 2 === 0 ? s.spec.maxX - s.spec.minX : s.spec.maxZ - s.spec.minZ;
          assert.close(s.spec.rise / run, H / S, 1e-9, `${what}: Steigung`);
        }
        // Höhen in den Feld-Mitten
        const n = path.length;
        const expected = path.map((t, idx) => {
          if (n === 2) return y0 + (idx === 0 ? H / 4 : (3 * H) / 4);
          if (idx === 0) return y0 + H / 4;
          if (idx === n - 1) return y0 + (3 * H) / 4;
          return y0 + H / 2; // Podest
        });
        path.forEach((t, idx) => assert.close(top(center(t)), expected[idx], 1e-6, `${what}: Feld ${t}`));
        for (let t = 0; t < 4; t++) if (!path.includes(t)) assert.ok(top(center(t)) < y0 - 1, `${what}: Feld ${t} frei`);
        // lückenlos: an jeder Kante zwischen zwei Weg-Feldern dieselbe Höhe (von beiden Seiten)
        for (let idx = 1; idx < n; idx++) {
          const a = center(path[idx - 1]);
          const b = center(path[idx]);
          const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
          const near = (p, f) => top({ x: mid.x + (p.x - mid.x) * f, z: mid.z + (p.z - mid.z) * f });
          assert.close(near(a, 0.02), near(b, 0.02), 0.08, `${what}: Kante ${path[idx - 1]}|${path[idx]}`);
        }
        // Anfang unten (Ebene), Ende oben (eine Ebene höher) – an den äußeren Kanten
        const first = center(path[0]);
        const second = center(path[1]);
        const start = { x: first.x - (second.x - first.x) * 0.49, z: first.z - (second.z - first.z) * 0.49 };
        assert.close(top(start), y0, 0.08, `${what}: unten`);
        const last = center(path[n - 1]);
        const prev = center(path[n - 2]);
        const end = { x: last.x + (last.x - prev.x) * 0.49, z: last.z + (last.z - prev.z) * 0.49 };
        assert.close(top(end), y0 + H, 0.08, `${what}: oben`);
      }
    }
  });

  it('Formen: 2 Felder = 1 Schräge, L = Lauf + Podest (1 Feld) + Lauf, U = Lauf + Podest (2 Felder) + Lauf', () => {
    const specs = (path) => pieceColliderSpecs({ type: 'ramp', kind: 'r', i: 0, j: 0, k: 0, dir: 0, editMask: 15 & ~pathMask(path), editPath: path });
    assert.deepEqual(specs([0, 2]).map((s) => s.stair), ['half']);
    assert.deepEqual(specs([0, 2, 3]).map((s) => s.stair), ['low', 'landing', 'high']);
    const u = specs([0, 2, 3, 1]);
    assert.deepEqual(u.map((s) => s.stair), ['low', 'landing', 'high']);
    assert.close(u[1].max.x - u[1].min.x, S, 1e-9, 'Podest über zwei Felder');
    assert.equal(u[0].spec.dir, 1, 'erster Lauf: 0 → 2 = +Z');
    assert.equal(u[2].spec.dir, 3, 'zweiter Lauf: 3 → 1 = −Z (Kehre)');
  });
});

describe('Edit-Formen: Dach (Ecken hochziehen)', () => {
  const cases = [
    [[], 'Pyramide'], [[0], '1/4-Pyramide'], [[0, 1], 'Rampen-Pyramide'], [[1, 2], 'halbe umgekehrte Pyramide'],
    [[0, 1, 2], '1/4 umgekehrte Pyramide'],
  ];

  it('Ecken auf Spitzen-Höhe, Mitte immer oben, dazwischen eben (4 Dreiecke)', () => {
    for (const [tiles, name] of cases) {
      const raise = tilesToMask(tiles);
      const world = worldOf({ type: 'roof', kind: 'c', i: 0, j: 1, k: 0, dir: 0, editMask: raise });
      const top = (x, z) => world.surfaceHeight(x, z, 20);
      const corners = [[0, 0], [S, 0], [0, S], [S, S]];
      corners.forEach(([x, z], t) => {
        const want = H + (raise & (1 << t) ? R : 0);
        assert.close(top(x + (x ? -1e-3 : 1e-3), z + (z ? -1e-3 : 1e-3)), want, 2e-3, `${name}: Ecke ${t}`);
      });
      assert.close(top(S / 2, S / 2), H + R, 1e-6, `${name}: Mitte oben`);
      // Mitte jeder Kante = Mittelwert der beiden Ecken
      const h = (t) => H + (raise & (1 << t) ? R : 0);
      assert.close(top(S / 2, 1e-3), (h(0) + h(1)) / 2, 2e-3, `${name}: Kante −Z`);
      assert.close(top(S - 1e-3, S / 2), (h(1) + h(3)) / 2, 2e-3, `${name}: Kante +X`);
      // gleiche Höhe wie roofSurfaceY (Bild und Kacheln)
      for (const [x, z] of [[0.3 * S, 0.2 * S], [0.8 * S, 0.6 * S], [0.1 * S, 0.9 * S]]) {
        assert.close(top(x, z), roofSurfaceY(0, 1, 0, raise, x, z), 1e-9, `${name}: Fläche bei ${x.toFixed(1)}, ${z.toFixed(1)}`);
      }
    }
    // alle 4 Ecken hoch gibt es nicht (wäre ein Boden)
    assert.equal(pieceColliderSpecs({ type: 'roof', kind: 'c', i: 0, j: 0, k: 0, dir: 0, editMask: 15 })[0].spec.raise, undefined);
  });

  it('Höhen-Bereich über Rechtecken = echte Fläche (stichprobenweise nachgerechnet)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [tiles] of cases) {
      const world = new CollisionWorld(CONFIG);
      const spec = pieceColliderSpecs({ type: 'roof', kind: 'c', i: 0, j: 0, k: 0, dir: 0, editMask: tilesToMask(tiles) })[0].spec;
      const c = world.addSlope(spec);
      const out = { min: 0, max: 0 };
      for (let n = 0; n < 40; n++) {
        const x0 = rnd() * S;
        const x1 = x0 + rnd() * (S - x0);
        const z0 = rnd() * S;
        const z1 = z0 + rnd() * (S - z0);
        slopeRangeOverRect(c, x0, x1, z0, z1, out);
        let lo = Infinity;
        let hi = -Infinity;
        for (let a = 0; a <= 20; a++) {
          for (let b = 0; b <= 20; b++) {
            const y = slopeSurfaceY(c, x0 + ((x1 - x0) * a) / 20, z0 + ((z1 - z0) * b) / 20);
            lo = Math.min(lo, y);
            hi = Math.max(hi, y);
          }
        }
        assert.ok(out.min <= lo + 1e-9 && out.max >= hi - 1e-9, `${tiles}: Bereich enthält die Fläche`);
        assert.ok(out.min >= lo - 0.15 && out.max <= hi + 0.15, `${tiles}: Bereich eng (${out.min.toFixed(2)}..${out.max.toFixed(2)} / ${lo.toFixed(2)}..${hi.toFixed(2)})`);
      }
    }
  });

  it('Strahlen: von oben auf die Fläche, von unten an die Unterseite (Dicke wie beim ganzen Dach)', () => {
    for (const [tiles, name] of cases) {
      const raise = tilesToMask(tiles);
      const world = worldOf({ type: 'roof', kind: 'c', i: 0, j: 1, k: 0, dir: 0, editMask: raise });
      for (const [x, z] of [[0.2 * S, 0.3 * S], [0.7 * S, 0.15 * S], [0.6 * S, 0.8 * S], [0.1 * S, 0.85 * S]]) {
        const surface = roofSurfaceY(0, 1, 0, raise, x, z);
        const down = world.raycast({ x, y: 20, z }, { x: 0, y: -1, z: 0 }, 30, { skipTerrain: true });
        assert.close(down.point.y, surface, 1e-6, `${name}: von oben`);
        const up = world.raycast({ x, y: 0.5, z }, { x: 0, y: 1, z: 0 }, 30, { skipTerrain: true });
        assert.close(up.point.y, surface - ROOF_V_THICKNESS, 1e-6, `${name}: von unten`);
      }
    }
  });

  it('pickTile trifft die echte Fläche (hochgezogene Ecke), nicht das ganze Dach', () => {
    const raised = { type: 'roof', kind: 'c', i: 0, j: 0, k: 0, dir: 0, editMask: tilesToMask([0]) };
    const plain = { ...raised, editMask: 0 };
    // waagerecht knapp unter der Spitze von außen auf Ecke 0 zu: nur die hochgezogene Ecke ist dort
    const origin = { x: -3, y: R - 0.3, z: 0.15 * S };
    const dir = { x: 1, y: 0, z: 0 };
    assert.equal(pickTile(raised, origin, dir, 20), 0);
    assert.equal(pickTile(plain, origin, dir, 20), -1, 'ohne Edit: Dach-Rand ist unten');
    // von oben: Feld = Viertel unter dem Treffpunkt
    assert.equal(pickTile(raised, { x: 0.8 * S, y: 10, z: 0.7 * S }, { x: 0, y: -1, z: 0 }, 20), 3);
    assert.equal(T > 0, true);
  });
});
