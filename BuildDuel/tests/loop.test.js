// Tests für die feste Spiel-Uhr (src/loop.js)
import { describe, it, assert } from './runner.js';
import { FixedStepClock } from '../src/loop.js';

function makeClock() {
  return new FixedStepClock({ tickRate: 60, maxFrameTime: 0.25, maxStepsPerFrame: 8 });
}

describe('Spiel-Uhr (60 Logik-Schritte pro Sekunde)', () => {
  it('60-Hz-Bildschirm: pro Bild genau 1 Schritt, nach 1 Sekunde genau 60', () => {
    const clock = makeClock();
    for (let i = 0; i < 60; i++) {
      const { steps } = clock.advance(1 / 60);
      assert.equal(steps, 1, `Bild ${i + 1}`);
    }
    assert.equal(clock.totalSteps, 60);
  });

  it('144-Hz-Bildschirm: nach 1 Sekunde trotzdem 60 Schritte', () => {
    const clock = makeClock();
    for (let i = 0; i < 144; i++) clock.advance(1 / 144);
    assert.ok(clock.totalSteps === 60 || clock.totalSteps === 59, `Schritte: ${clock.totalSteps}`);
    for (let i = 0; i < 144 * 9; i++) clock.advance(1 / 144);
    assert.close(clock.totalSteps, 600, 1, 'nach 10 Sekunden');
  });

  it('30-Hz-Bildschirm: pro Bild 2 Schritte', () => {
    const clock = makeClock();
    for (let i = 0; i < 30; i++) assert.equal(clock.advance(1 / 30).steps, 2);
    assert.equal(clock.totalSteps, 60);
  });

  it('lange Pause (Tab im Hintergrund) wird gekürzt – kein "Nachrennen"', () => {
    const clock = makeClock();
    const { steps } = clock.advance(5);
    assert.equal(steps, 8, 'höchstens 8 Schritte in einem Bild');
    assert.ok(clock.accumulator < clock.step, 'Rest muss kleiner als ein Schritt sein');
    assert.close(clock.droppedTime, 5 - 8 / 60, 1e-6, 'verworfene Zeit');
    // Danach läuft alles normal weiter
    assert.equal(clock.advance(1 / 60).steps, 1);
  });

  it('ungültige Zeiten (negativ, NaN, unendlich) zählen als 0', () => {
    const clock = makeClock();
    assert.equal(clock.advance(-1).steps, 0);
    assert.equal(clock.advance(NaN).steps, 0);
    assert.equal(clock.advance(Infinity).steps, 0);
    assert.equal(clock.totalSteps, 0);
  });

  it('alpha (Zwischenstand) liegt immer zwischen 0 und unter 1', () => {
    const clock = makeClock();
    const times = [0.003, 0.0167, 0.021, 0.5, 0.0001, 0.033, 0.01, 0.07];
    for (let round = 0; round < 50; round++) {
      for (const t of times) {
        const { alpha } = clock.advance(t);
        assert.ok(alpha >= 0 && alpha < 1, `alpha = ${alpha}`);
      }
    }
  });

  it('reset() löscht die gesammelte Zeit', () => {
    const clock = makeClock();
    clock.advance(0.01);
    assert.ok(clock.accumulator > 0);
    clock.reset();
    assert.equal(clock.accumulator, 0);
  });

  it('tickRate 0 ist ein Fehler', () => {
    assert.throws(() => new FixedStepClock({ tickRate: 0, maxFrameTime: 0.25, maxStepsPerFrame: 8 }));
  });
});
