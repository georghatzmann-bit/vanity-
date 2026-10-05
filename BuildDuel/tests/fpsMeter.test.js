// Tests für die FPS-Rechnung (src/ui/fpsMeter.js)
import { describe, it, assert } from './runner.js';
import { FpsCounter, rateFps } from '../src/ui/fpsMeter.js';

describe('FPS-Anzeige', () => {
  it('rechnet bei 60 Bildern pro Sekunde 60 FPS und 16,7 ms', () => {
    const counter = new FpsCounter(0.5);
    let updated = false;
    for (let i = 0; i < 30; i++) updated = counter.frame(1 / 60, 1) || updated;
    assert.ok(updated, 'nach 0,5 s sollte es neue Werte geben');
    assert.close(counter.fps, 60, 0.01);
    assert.close(counter.frameMs, 16.667, 0.01);
    assert.close(counter.ticksPerSecond, 60, 0.01);
  });

  it('merkt sich das langsamste Bild (Ruckler)', () => {
    const counter = new FpsCounter(0.5);
    for (let i = 0; i < 20; i++) counter.frame(1 / 60, 1);
    counter.frame(0.1, 6); // ein Ruckler mit 100 ms
    for (let i = 0; i < 20; i++) counter.frame(1 / 60, 1);
    assert.ok(counter.hasData);
    assert.close(counter.worstFrameMs, 100, 0.01);
  });

  it('sehr lange Pausen (über 1 s) verfälschen die Messung nicht', () => {
    const counter = new FpsCounter(0.5);
    assert.equal(counter.frame(5, 8), false);
    assert.equal(counter.hasData, false);
  });

  it('ungültige Zeiten werden ignoriert', () => {
    const counter = new FpsCounter(0.5);
    assert.equal(counter.frame(0), false);
    assert.equal(counter.frame(-1), false);
    assert.equal(counter.frame(NaN), false);
  });

  it('Bewertung: ab 55 gut, ab 30 mittel, darunter schlecht', () => {
    assert.equal(rateFps(60), 'gut');
    assert.equal(rateFps(55), 'gut');
    assert.equal(rateFps(54.9), 'mittel');
    assert.equal(rateFps(30), 'mittel');
    assert.equal(rateFps(29), 'schlecht');
  });
});
