// Tests für die Partikel-Effekte (src/world/effects.js): fester Vorrat (wächst nie),
// Bewegung, Boden, Grafik-Stufen, Attrappe ohne Bildschirm.
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import { ParticlePool, pieceExtents, qualityFactorOf, scaledCount, createEffects } from '../src/world/effects.js';

describe('Effekte: Teilchen-Vorrat', () => {
  it('mehr Teilchen als Platz: der Vorrat wächst nicht, die ältesten werden ersetzt', () => {
    const pool = new ParticlePool(16);
    const arrays = [pool.px, pool.vy, pool.alive];
    for (let i = 0; i < 100; i++) pool.spawn(i, 0, 0, 0, 0, 0, 5, 0.1);
    assert.equal(pool.active, 16);
    assert.equal(pool.capacity, 16);
    assert.equal(pool.px.length, 16);
    assert.ok(arrays[0] === pool.px && arrays[1] === pool.vy && arrays[2] === pool.alive, 'dieselben Felder');
    // die letzten 16 (84..99) sind übrig
    const xs = [...pool.px].sort((a, b) => a - b);
    assert.equal(xs[0], 84);
    assert.equal(xs[15], 99);
  });

  it('Teilchen verschwinden nach ihrer Lebenszeit', () => {
    const pool = new ParticlePool(8);
    pool.spawn(0, 0, 0, 0, 0, 0, 0.5, 0.1);
    pool.spawn(0, 0, 0, 0, 0, 0, 1.5, 0.1);
    assert.equal(pool.update(0.6), 1);
    assert.equal(pool.update(1.0), 0);
    assert.equal(pool.active, 0);
  });

  it('Schwerkraft und Boden: fällt, bleibt nicht unter dem Boden', () => {
    const pool = new ParticlePool(4);
    const i = pool.spawn(0, 2, 0, 1, 0, 0, 10, 0.1);
    pool.gravity[i] = CONFIG.effects.gravity;
    pool.floor[i] = 0;
    for (let k = 0; k < 120; k++) pool.update(1 / 60);
    assert.ok(pool.py[i] >= 0, `y = ${pool.py[i]}`);
    assert.ok(pool.py[i] < 0.2, 'liegt am Boden');
    assert.ok(pool.px[i] > 0, 'ist seitlich geflogen');
  });

  it('clear() leert alles', () => {
    const pool = new ParticlePool(4);
    pool.spawn(0, 0, 0, 0, 0, 0, 1, 1);
    pool.clear();
    assert.equal(pool.active, 0);
    assert.equal(pool.update(0.1), 0);
  });
});

describe('Effekte: Hilfen', () => {
  it('Ausdehnung der Bauteile: Wand dünn in ihrer Ebene, Boden flach', () => {
    const t = CONFIG.building.pieceThickness / 2;
    assert.close(pieceExtents('wx').z, t, 1e-9);
    assert.close(pieceExtents('wz').x, t, 1e-9);
    assert.close(pieceExtents('f').y, t, 1e-9);
    assert.close(pieceExtents('r').y, CONFIG.world.wallHeight / 2, 1e-9);
    assert.close(pieceExtents('c').y, CONFIG.building.roofHeight / 2, 1e-9);
  });

  it('Grafik-Stufe: "niedrig" weniger Teilchen, mindestens 1', () => {
    assert.ok(qualityFactorOf('niedrig') < qualityFactorOf('hoch'));
    assert.equal(qualityFactorOf('unbekannt'), 1);
    assert.equal(scaledCount(18, 1), 18);
    assert.equal(scaledCount(18, 0.35), 6);
    assert.equal(scaledCount(1, 0.1), 1);
    assert.equal(scaledCount(0, 1), 0);
  });

  it('ohne Bildschirm: Attrappe mit allen Methoden', () => {
    const fx = createEffects({ headless: true });
    fx.frameUpdate(1 / 60);
    fx.spawn('sparks', { x: 0, y: 0, z: 0 });
    fx.setPaused(true);
    fx.clear();
    assert.equal(fx.stats().dust, 0);
    fx.dispose();
  });
});
