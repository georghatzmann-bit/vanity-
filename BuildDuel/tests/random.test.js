// Tests für den Zufall mit Startwert (src/util/random.js)
import { describe, it, assert } from './runner.js';
import { createRng, randomRange } from '../src/util/random.js';

describe('Zufall mit Startwert', () => {
  it('gleicher Startwert → gleiche Zahlen', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) assert.equal(a(), b());
  });

  it('anderer Startwert → andere Zahlen', () => {
    const a = createRng(1);
    const b = createRng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a() === b()) same++;
    assert.ok(same < 3, `zu viele gleiche Zahlen: ${same}`);
  });

  it('Zahlen liegen zwischen 0 und unter 1 und sind gleichmäßig verteilt', () => {
    const rng = createRng(7);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1, `Wert ${v}`);
      sum += v;
    }
    assert.close(sum / n, 0.5, 0.02, 'Durchschnitt');
  });

  it('randomRange bleibt im Bereich', () => {
    const rng = createRng(3);
    for (let i = 0; i < 1000; i++) {
      const v = randomRange(rng, 5, 10);
      assert.ok(v >= 5 && v < 10, `Wert ${v}`);
    }
  });
});
