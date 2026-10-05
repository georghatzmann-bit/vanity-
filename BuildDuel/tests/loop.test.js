// Tests für die feste Spiel-Uhr (src/loop.js)
import { describe, it, assert } from './runner.js';
import { FixedStepClock } from '../src/loop.js';

function makeClock() {
  return new FixedStepClock({ tickRate: 60, maxFrameTime: 0.2, maxStepsPerFrame: 12 });
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

  it('60-Hz-Bildschirm mit echter Browser-Messung (auf 0,1 ms gerundet): fast immer genau 1 Schritt', () => {
    const clock = makeClock();
    let last = 0;
    let single = 0;
    const frames = 3600; // 1 Minute
    for (let i = 1; i <= frames; i++) {
      const now = Math.round((i * 1000) / 60 * 10) / 10; // Zeitstempel in ms, gerundet wie im Browser
      if (clock.advance((now - last) / 1000).steps === 1) single++;
      last = now;
    }
    assert.ok(single / frames >= 0.99, `nur ${single} von ${frames} Bildern mit genau 1 Schritt`);
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
    assert.equal(steps, 12, 'höchstens 12 Schritte in einem Bild');
    assert.ok(clock.accumulator < clock.step, 'Rest muss kleiner als ein Schritt sein');
    assert.close(clock.droppedTime, 5 - 12 / 60, 1e-6, 'verworfene Zeit');
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

  it('reset() setzt die gesammelte Zeit auf einen halben Schritt zurück', () => {
    const clock = makeClock();
    clock.advance(0.011);
    assert.ok(clock.accumulator !== clock.step / 2);
    clock.reset();
    assert.equal(clock.accumulator, clock.step / 2);
  });

  it('nichts geht verloren: Spielzeit + verworfene Zeit = echte Zeit', () => {
    const clock = makeClock();
    let real = 0;
    const times = [0.016, 0.017, 0.5, 0.004, 0.033, 3, 0.0167, 0.12, 0.25, 0.007];
    for (let round = 0; round < 30; round++) {
      for (const t of times) { clock.advance(t); real += t; }
    }
    const simulated = clock.totalSteps * clock.step;
    const start = clock.step / 2;
    assert.close(simulated + clock.droppedTime + clock.accumulator, real + start, 1e-6);
  });

  it('tickRate 0 ist ein Fehler', () => {
    assert.throws(() => new FixedStepClock({ tickRate: 0, maxFrameTime: 0.25, maxStepsPerFrame: 8 }));
  });
});
