'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../../src/main/tools/reaktion-logic');
const mod = require('../../src/main/modules/tools/reaktion');

const LIB = path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'lib', 'reaktion-logic.mjs');
const lib = () => import(LIB);

function fakeCtx(initial) {
  const store = new Map();
  if (initial) store.set('tool-reaktion', JSON.stringify(initial));
  return {
    store,
    ctx: {
      core: {
        readState: async (name, fb) => (store.has(name) ? JSON.parse(store.get(name)) : fb),
        writeState: async (name, obj) => { store.set(name, JSON.stringify(obj)); },
      },
    },
  };
}

/** Kleiner, vorhersagbarer Zufall für Tests. */
function seeded(seed = 7) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// ---------------------------------------------------------------- Reaktionstest

test('reaktion: Wartezeit liegt immer zwischen 1,5 und 4 Sekunden', async () => {
  const m = await lib();
  assert.equal(m.randomDelay(() => 0), 1500);
  assert.equal(m.randomDelay(() => 0.999999) < 4000, true);
  const r = seeded();
  for (let i = 0; i < 500; i++) {
    const d = m.randomDelay(r);
    assert.ok(d >= 1500 && d < 4000, String(d));
  }
});

test('reaktion: unter 100 ms ist geraten (Fehlstart), Auswertung und Einordnung', async () => {
  const m = await lib();
  assert.equal(m.classifyPress(99), 'early');
  assert.equal(m.classifyPress(0), 'early');
  assert.equal(m.classifyPress(NaN), 'early');
  assert.equal(m.classifyPress(100), 'ok');
  assert.deepEqual(m.evaluateReaction([210.4, 190.2, 250, 230, 220]), { avgMs: 220, bestMs: 190, worstMs: 250 });
  assert.equal(m.evaluateReaction([]), null);
  assert.equal(m.rateReaction(185).label, 'Sehr schnell');
  assert.equal(m.rateReaction(240).label, 'Schnell');
  assert.equal(m.rateReaction(280).label, 'Gut');
  assert.equal(m.rateReaction(330).label, 'Okay');
  assert.equal(m.rateReaction(420).label, 'Langsam');
  for (const ms of [150, 220, 280, 330, 500]) assert.ok(m.rateReaction(ms).text.length > 5, 'jede Einordnung hat einen erklärenden Satz');
});

// ---------------------------------------------------------------- Tasten

test('reaktion: Standard-Tasten sind in Oberfläche und Hauptprozess gleich', async () => {
  const m = await lib();
  assert.deepEqual(m.defaultBinds(), L.defaultBinds());
  assert.deepEqual(m.ACTION_IDS, L.ACTION_IDS);
  assert.deepEqual(m.ACTIONS.map((a) => a.label), L.ACTIONS.map((a) => a.label));
  assert.equal(m.RESERVED.source, L.RESERVED.source);
  const d = m.defaultBinds();
  assert.deepEqual(m.activeActions(d), ['wall', 'floor', 'stairs', 'roof', 'edit'], 'Waffen sind erst einmal aus');
  assert.equal(d.edit.code, 'KeyG');
});

test('reaktion: Tasten aus Ereignissen (Tastatur, Maustasten, Mausrad), Esc und Windows-Taste sind gesperrt', async () => {
  const m = await lib();
  assert.deepEqual(m.bindFromEvent({ type: 'keydown', code: 'KeyQ', key: 'q' }), { code: 'KeyQ', label: 'Q' });
  assert.deepEqual(m.bindFromEvent({ type: 'keydown', code: 'KeyY', key: 'z' }), { code: 'KeyY', label: 'Z' }, 'deutsches Layout: Beschriftung der Taste');
  assert.deepEqual(m.bindFromEvent({ type: 'keydown', code: 'ShiftLeft', key: 'Shift' }), { code: 'ShiftLeft', label: 'Umschalt' });
  assert.deepEqual(m.bindFromEvent({ type: 'keydown', code: 'Space', key: ' ' }), { code: 'Space', label: 'Leertaste' });
  assert.equal(m.bindFromEvent({ type: 'keydown', code: 'Escape', key: 'Escape' }), null);
  assert.equal(m.bindFromEvent({ type: 'keydown', code: 'MetaLeft', key: 'Meta' }), null);
  assert.equal(m.bindFromEvent({ type: 'keydown', code: 'KeyQ', key: 'q', repeat: true }), null, 'gedrückt halten zählt nicht');
  assert.deepEqual(m.bindFromEvent({ type: 'mousedown', button: 4 }), { code: 'Mouse4', label: 'Maus 5' });
  assert.deepEqual(m.bindFromEvent({ type: 'mousedown', button: 3 }), { code: 'Mouse3', label: 'Maus 4' });
  assert.equal(m.bindFromEvent({ type: 'mousedown', button: 0 }), null, 'Linksklick bleibt zum Bedienen frei');
  assert.deepEqual(m.bindFromEvent({ type: 'wheel', deltaY: -120 }), { code: 'WheelUp', label: 'Mausrad hoch' });
  assert.deepEqual(m.bindFromEvent({ type: 'wheel', deltaY: 53 }), { code: 'WheelDown', label: 'Mausrad runter' });
  assert.equal(m.bindFromEvent({ type: 'wheel', deltaY: 0 }), null);
  assert.equal(m.codeLabel('Numpad3'), 'Num 3');
  assert.equal(m.codeLabel('Digit7'), '7');
});

test('reaktion: doppelte Tasten blockieren das Training, zu wenige Aktionen auch', async () => {
  const m = await lib();
  const b = m.defaultBinds();
  assert.equal(m.trainingBlocker(b), null);
  b.floor = { code: 'F1', label: 'F1', on: true };
  const d = m.findDuplicates(b);
  assert.deepEqual([...d.get('F1')], ['wall', 'floor']);
  assert.match(m.trainingBlocker(b), /F1 ist doppelt belegt \(Wand und Boden\)/);
  b.floor.on = false; // ausgeschaltet zählt nicht als doppelt
  assert.equal(m.trainingBlocker(b), null);
  const few = m.defaultBinds();
  for (const id of ['floor', 'stairs', 'roof', 'edit']) few[id].on = false;
  assert.match(m.trainingBlocker(few), /mindestens zwei/);
  assert.equal(m.actionForCode(m.defaultBinds(), 'F3'), 'stairs');
  assert.equal(m.actionForCode(m.defaultBinds(), 'Digit2'), null, 'Waffe ist aus');
});

test('reaktion: Befehlsfolge – 20 Befehle, nie zweimal hintereinander, gleichmäßig verteilt', async () => {
  const m = await lib();
  const ids = ['wall', 'floor', 'stairs', 'roof', 'edit'];
  for (let seed = 1; seed < 40; seed++) {
    const seq = m.makeSequence(ids, 20, seeded(seed));
    assert.equal(seq.length, 20);
    for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `Wiederholung bei seed ${seed}`);
    for (const id of ids) assert.equal(seq.filter((x) => x === id).length, 4);
  }
  assert.deepEqual(m.makeSequence([], 5), []);
  assert.deepEqual(m.makeSequence(['wall'], 3), ['wall', 'wall', 'wall']);
});

test('reaktion: Auswertung Tasten-Trainer (nur richtige Tasten zählen für die Zeit)', async () => {
  const m = await lib();
  const res = [
    { id: 'wall', kind: 'hit', ms: 300 },
    { id: 'floor', kind: 'hit', ms: 500 },
    { id: 'wall', kind: 'wrong', ms: 250 },
    { id: 'stairs', kind: 'timeout', ms: 2500 },
    { id: 'floor', kind: 'hit', ms: 400 },
  ];
  const ev = m.evaluateKeys(res);
  assert.equal(ev.count, 5);
  assert.equal(ev.hits, 3);
  assert.equal(ev.wrong, 1);
  assert.equal(ev.timeouts, 1);
  assert.equal(ev.accuracy, 60);
  assert.equal(ev.avgMs, 400);
  assert.deepEqual(ev.perAction.map((p) => [p.id, p.hits, p.misses, p.avgMs]), [['wall', 1, 1, 300], ['floor', 2, 0, 450], ['stairs', 0, 1, null]]);
  assert.equal(ev.slowest.id, 'floor');
  assert.equal(m.rateKeys(ev).label, 'Genauigkeit üben');
  assert.equal(m.rateKeys({ avgMs: 350, accuracy: 100 }).label, 'Sehr gut');
  assert.equal(m.rateKeys({ avgMs: 450, accuracy: 90 }).label, 'Gut');
  assert.equal(m.rateKeys({ avgMs: 700, accuracy: 90 }).label, 'Weiter üben');
  assert.match(m.keysTip(ev), /Am langsamsten: Boden/);
  const none = m.evaluateKeys([{ id: 'wall', kind: 'timeout', ms: 2500 }]);
  assert.equal(none.avgMs, null);
  assert.equal(none.accuracy, 0);
});

test('reaktion: Verlauf – Trend und Balken', async () => {
  const m = await lib();
  const list = [250, 240, 230, 220, 210, 200].map((v, i) => ({ at: i, avgMs: v }));
  assert.deepEqual(m.trend(list), { last: 200, prevAvg: 230, diff: -30 });
  assert.equal(m.trend(list.slice(0, 1)), null);
  const b = m.bars(list, 'avgMs', 3);
  assert.equal(b.length, 3);
  assert.equal(b[0].h, 1);
  assert.ok(Math.abs(b[2].h - 200 / 220) < 1e-9);
});

// ---------------------------------------------------------------- Prüfen im Hauptprozess

test('reaktion: Ergebnisse werden geprüft, Unsinn wird abgelehnt', () => {
  assert.deepEqual(L.sanitizeReaction({ avgMs: 231.6, bestMs: 199.2, rounds: 5, falseStarts: 1, evil: '<x>' }), { avgMs: 232, bestMs: 199, rounds: 5, falseStarts: 1 });
  assert.equal(L.sanitizeReaction({ avgMs: 20, bestMs: 20, rounds: 5, falseStarts: 0 }), null, 'zu schnell, um echt zu sein');
  assert.equal(L.sanitizeReaction({ avgMs: 200, bestMs: 250, rounds: 5, falseStarts: 0 }), null, 'Bestwert kann nicht schlechter als der Schnitt sein');
  assert.equal(L.sanitizeReaction({ avgMs: 200, bestMs: 190, rounds: 0, falseStarts: 0 }), null);
  assert.equal(L.sanitizeReaction({ avgMs: '200', bestMs: 190, rounds: 5, falseStarts: 0 }), null);
  assert.deepEqual(L.sanitizeKeys({ avgMs: 412.4, accuracy: 95, count: 20 }), { avgMs: 412, accuracy: 95, count: 20 });
  assert.deepEqual(L.sanitizeKeys({ avgMs: null, accuracy: 0, count: 20 }), { avgMs: null, accuracy: 0, count: 20 });
  assert.equal(L.sanitizeKeys({ avgMs: null, accuracy: 50, count: 20 }), null);
  assert.equal(L.sanitizeKeys({ avgMs: 400, accuracy: 120, count: 20 }), null);
  assert.equal(L.sanitizeKeys({ avgMs: 400, accuracy: 90, count: 0 }), null);
});

test('reaktion: Tastenbelegung – nur bekannte Aktionen, gültige Codes, kurze Namen ohne HTML', () => {
  const b = L.sanitizeBinds({
    wall: { code: 'KeyQ', label: 'Q', on: true },
    floor: { code: 'Escape', label: 'Esc', on: true },
    stairs: { code: 'Key Q; rm', label: 'x', on: true },
    roof: { code: 'Mouse4', label: '<img src=x onerror=alert(1)>Maus 5 und noch viel mehr Text', on: true },
    weapon1: { code: 'Digit1', label: '1', on: true },
    hacker: { code: 'KeyH', label: 'H', on: true },
  });
  assert.deepEqual(b.wall, { code: 'KeyQ', label: 'Q', on: true });
  assert.deepEqual(b.floor, { code: 'F2', label: 'F2', on: true }, 'Esc ist reserviert -> Standard');
  assert.equal(b.stairs.code, 'F3');
  assert.doesNotMatch(b.roof.label, /[<>]/);
  assert.ok(b.roof.label.length <= 14);
  assert.equal(b.weapon1.on, true);
  assert.equal(b.hacker, undefined);
  assert.deepEqual(Object.keys(b), L.ACTION_IDS);
});

test('reaktion: Zustand hat genau die vereinbarte Form', () => {
  const s = L.normalizeState({
    reaction: [{ at: 1, avgMs: 220, bestMs: 200, rounds: 5, falseStarts: 0, extra: 1 }, { at: 2, avgMs: 'x' }],
    keys: [{ at: 3, avgMs: 400, accuracy: 90, count: 20 }],
    binds: null,
    other: 'weg',
  });
  assert.deepEqual(Object.keys(s), ['reaction', 'keys', 'binds']);
  assert.deepEqual(s.reaction, [{ at: 1, avgMs: 220, bestMs: 200, rounds: 5, falseStarts: 0 }]);
  assert.deepEqual(Object.keys(s.keys[0]), ['at', 'avgMs', 'accuracy', 'count']);
  assert.deepEqual(s.binds, L.defaultBinds());
});

// ---------------------------------------------------------------- Handler

test('reaktion: speichern, Verlauf, Tasten, löschen, Cockpit-Text', async () => {
  const { ctx, store } = fakeCtx();
  assert.equal(await mod.handlers.summary({}, ctx), null);
  const st0 = await mod.handlers.getState({}, ctx);
  assert.deepEqual(st0.reaction, []);
  assert.deepEqual(st0.binds, L.defaultBinds());
  await assert.rejects(() => mod.handlers.saveReaction({ avgMs: 5 }, ctx), (e) => e.code === 'BAD_ARG');
  const r = await mod.handlers.saveReaction({ avgMs: 182.4, bestMs: 161, rounds: 5, falseStarts: 2 }, ctx);
  assert.equal(r.entry.avgMs, 182);
  assert.ok(r.entry.at > 0);
  assert.deepEqual(await mod.handlers.summary({}, ctx), { text: 'Reaktion Ø 182 ms · Bestwert 161 ms' });
  await mod.handlers.saveKeys({ avgMs: 433, accuracy: 95, count: 20 }, ctx);
  assert.deepEqual(await mod.handlers.summary({}, ctx), { text: 'Reaktion Ø 182 ms · Tasten Ø 433 ms' });
  const saved = JSON.parse(store.get('tool-reaktion'));
  assert.deepEqual(Object.keys(saved).sort(), ['binds', 'keys', 'reaction']);
  assert.deepEqual(Object.keys(saved.reaction[0]), ['at', 'avgMs', 'bestMs', 'rounds', 'falseStarts']);
  const b = await mod.handlers.saveBinds({ binds: { ...L.defaultBinds(), wall: { code: 'KeyQ', label: 'Q', on: true } } }, ctx);
  assert.equal(b.binds.wall.code, 'KeyQ');
  await assert.rejects(() => mod.handlers.saveBinds({}, ctx), (e) => e.code === 'BAD_ARG');
  const cleared = await mod.handlers.clearHistory({ which: 'reaction' }, ctx);
  assert.deepEqual(cleared.reaction, []);
  assert.equal(cleared.keys.length, 1);
  assert.equal(cleared.binds.wall.code, 'KeyQ', 'Tasten bleiben beim Löschen erhalten');
  assert.deepEqual(await mod.handlers.summary({}, ctx), { text: 'Tasten-Trainer Ø 433 ms, 95 % richtig' });
  await assert.rejects(() => mod.handlers.clearHistory({ which: 'alles' }, ctx), (e) => e.code === 'BAD_ARG');
  const all = await mod.handlers.clearHistory({ which: 'all' }, ctx);
  assert.deepEqual([all.reaction.length, all.keys.length], [0, 0]);
});

test('reaktion: höchstens 200 Einträge, gleichzeitiges Speichern verliert nichts', async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ at: i + 1, avgMs: 250, bestMs: 230, rounds: 5, falseStarts: 0 }));
  const { ctx, store } = fakeCtx({ reaction: many, keys: [], binds: {} });
  await Promise.all([
    mod.handlers.saveReaction({ avgMs: 201, bestMs: 190, rounds: 5, falseStarts: 0 }, ctx),
    mod.handlers.saveReaction({ avgMs: 202, bestMs: 190, rounds: 5, falseStarts: 0 }, ctx),
    mod.handlers.saveKeys({ avgMs: 400, accuracy: 100, count: 20 }, ctx),
  ]);
  const s = JSON.parse(store.get('tool-reaktion'));
  assert.equal(s.reaction.length, 200);
  assert.deepEqual(s.reaction.slice(-2).map((e) => e.avgMs), [201, 202], 'neueste zuletzt');
  assert.equal(s.reaction[0].at, 3, 'älteste fliegen raus');
  assert.equal(s.keys.length, 1);
});

test('reaktion: Sicherheitsregeln (nur im HELIX-Fenster, keine globalen Hooks, nichts am Spiel)', () => {
  const root = path.join(__dirname, '..', '..', 'src');
  const files = ['main/modules/tools/reaktion.js', 'main/tools/reaktion-logic.js', 'renderer/js/views/reaktion.js', 'renderer/js/lib/reaktion-logic.mjs'];
  const src = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /globalShortcut|SetWindowsHookEx|uiohook|iohook|GetAsyncKeyState|keyboardLock/i);
  assert.doesNotMatch(src, /ctx\.exec|powershell|registry|child_process/i);
  assert.doesNotMatch(src, /innerHTML/);
  assert.doesNotMatch(src, /EasyAntiCheat|BattlEye|FortniteClient/i);
  assert.equal(mod.id, 'reaktion');
  for (const h of ['saveReaction', 'saveKeys', 'getState', 'saveBinds', 'clearHistory', 'summary']) assert.equal(typeof mod.handlers[h], 'function', h);
});
