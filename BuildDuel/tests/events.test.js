// Tests für den Ereignis-Bus (src/core/events.js)
import { describe, it, assert } from './runner.js';
import { EventBus } from '../src/core/events.js';

describe('Ereignis-Bus', () => {
  it('on + emit: Zuhörer bekommt den Inhalt', () => {
    const bus = new EventBus();
    let got = null;
    bus.on('jump', (p) => { got = p; });
    const count = bus.emit('jump', { character: 'A' });
    assert.deepEqual(got, { character: 'A' });
    assert.equal(count, 1);
  });

  it('off und die Abmelde-Funktion von on() entfernen den Zuhörer', () => {
    const bus = new EventBus();
    let calls = 0;
    const fn = () => calls++;
    const off = bus.on('x', fn);
    bus.emit('x');
    off();
    bus.emit('x');
    assert.equal(calls, 1);
    bus.on('x', fn);
    bus.off('x', fn);
    bus.emit('x');
    assert.equal(calls, 1);
    assert.equal(bus.listenerCount('x'), 0);
  });

  it('once: nur beim ersten Mal', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.once('land', () => calls++);
    bus.emit('land');
    bus.emit('land');
    assert.equal(calls, 1);
  });

  it('Abmelden während des Sendens stört die anderen Zuhörer nicht', () => {
    const bus = new EventBus();
    const order = [];
    let offB = null;
    bus.on('e', () => { order.push('a'); offB(); });
    offB = bus.on('e', () => order.push('b'));
    bus.on('e', () => order.push('c'));
    bus.emit('e');
    assert.deepEqual(order, ['a', 'b', 'c'], 'diesmal laufen noch alle');
    bus.emit('e');
    assert.deepEqual(order, ['a', 'b', 'c', 'a', 'c'], 'danach ist b weg');
  });

  it('Fehler in einem Zuhörer: die anderen laufen trotzdem, der Fehler wird danach geworfen', () => {
    const bus = new EventBus();
    let second = false;
    bus.on('e', () => { throw new Error('kaputt'); });
    bus.on('e', () => { second = true; });
    assert.throws(() => bus.emit('e'));
    assert.ok(second, 'zweiter Zuhörer lief');
  });

  it('emit ohne Zuhörer und clear()', () => {
    const bus = new EventBus();
    assert.equal(bus.emit('nichts'), 0);
    bus.on('a', () => {});
    bus.clear();
    assert.equal(bus.listenerCount('a'), 0);
  });

  it('on() mit etwas anderem als einer Funktion ist ein Fehler', () => {
    const bus = new EventBus();
    assert.throws(() => bus.on('a', 42));
  });
});
