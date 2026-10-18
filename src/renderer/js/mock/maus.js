// Simulator für den Maus-Check (nur Browser-Vorschau).
// Startzustand wie bei vielen Windows-PCs: Stufe 6/11, aber „Zeigerbeschleunigung verbessern“ an.

const now = Date.now();
const H = 3600 * 1000;

const NAMES = ['MouseSensitivity', 'MouseSpeed', 'MouseThreshold1', 'MouseThreshold2'];
const FACTOR = [null, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5];

const db = {
  values: { MouseSensitivity: 10, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 },
  undo: null,
  fortnite: 'False',
  tests: {
    polling: [{ at: now - 26 * H, hz: 498, medianMs: 2.001, samples: 1512, durationMs: 3036, cls: '500', stable: true }],
    dpi: [],
  },
};

function notch(sens) {
  if (sens === 1) return { notch: 1, exact: true, label: '1/11' };
  if (sens % 2 === 0) return { notch: sens / 2 + 1, exact: true, label: `${sens / 2 + 1}/11` };
  const lo = (sens - 1) / 2 + 1;
  return { notch: lo + 0.5, exact: false, label: `zwischen ${lo}/11 und ${lo + 1}/11` };
}

function evaluate(v) {
  const on = v.MouseSpeed > 0;
  const speed = { value: v.MouseSensitivity, missing: false, ...notch(v.MouseSensitivity), factor: FACTOR[v.MouseSensitivity], ok: v.MouseSensitivity === 10 };
  const accel = { on, mouseSpeed: v.MouseSpeed, threshold1: v.MouseThreshold1, threshold2: v.MouseThreshold2, ok: !on };
  return { values: { ...v }, speed, accel, allOk: speed.ok && accel.ok, raw: { ...v }, missingKey: false };
}

const last = (l) => (l.length ? l[l.length - 1] : null);
function tests() {
  return { polling: last(db.tests.polling), dpi: last(db.tests.dpi), pollingHistory: db.tests.polling.slice(-5), dpiHistory: db.tests.dpi.slice(-5) };
}
function status() {
  return { unsupported: false, windows: evaluate(db.values), undo: db.undo ? { at: db.undo.at, changes: db.undo.changes } : null, tests: tests() };
}
function fortnite(running) {
  return {
    found: true, rel: 'WindowsClient/GameUserSettings.ini', readOnly: false, value: db.fortnite,
    disabled: db.fortnite === 'True', ok: db.fortnite === 'True', fortniteRunning: !!running,
  };
}
const err = (code, message) => { const e = new Error(message); e.code = code; throw e; };

export default {
  async status(_a, mctx) {
    await mctx.wait(250);
    return status();
  },
  async fix(a, mctx) {
    await mctx.wait(700);
    const target = { ...db.values };
    if (a.speed !== false) target.MouseSensitivity = 10;
    if (a.accel !== false) Object.assign(target, { MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 });
    const changes = NAMES.filter((n) => target[n] !== db.values[n]).map((n) => ({ name: n, from: db.values[n], to: target[n] }));
    if (!changes.length) return { changed: [], live: true, alreadyOk: true, status: status() };
    if (!db.undo) db.undo = { at: Date.now(), before: { ...db.values }, changes };
    db.values = target;
    return { changed: changes, live: true, status: status() };
  },
  async undo(_a, mctx) {
    await mctx.wait(600);
    if (!db.undo) err('NO_UNDO', 'Es gibt keine Änderung, die man rückgängig machen kann.');
    db.values = { ...db.undo.before };
    db.undo = null;
    return { restored: NAMES.map((n) => ({ name: n, to: db.values[n] })), live: true, status: status() };
  },
  async fortniteAccel(_a, mctx) {
    await mctx.wait(200);
    return fortnite(mctx.db?.fortnite?.running);
  },
  async fixFortniteAccel(a, mctx) {
    await mctx.wait(600);
    if (mctx.db?.fortnite?.running) err('FORTNITE_RUNNING', 'Fortnite läuft noch. Schließe Fortnite zuerst – HELIX kann das für dich übernehmen.');
    const before = db.fortnite;
    db.fortnite = a.disable === false ? 'False' : 'True';
    const applied = before === db.fortnite ? [] : [{ section: '/Script/FortniteGame.FortGameUserSettings', key: 'bDisableMouseAcceleration', from: before, to: db.fortnite }];
    return { applied, backupId: `mock-${Date.now()}`, ...fortnite(false) };
  },
  async saveTest(a, mctx) {
    await mctx.wait(150);
    const kind = a.kind === 'dpi' ? 'dpi' : 'polling';
    const entry = { at: Date.now(), ...a.result };
    db.tests[kind].push(entry);
    return { saved: entry, tests: tests() };
  },
  async summary() {
    const ev = evaluate(db.values);
    const p = last(db.tests.polling);
    const poll = p ? ` · ${p.cls === '2000+' ? 'über 1000' : p.cls} Hz` : '';
    if (ev.allOk) return { text: `Maus passt: Zeiger ${ev.speed.label}, Beschleunigung aus${poll}` };
    if (!ev.accel.ok) return { text: `Zeigerbeschleunigung ist an – empfohlen: aus${poll}` };
    return { text: `Zeiger ${ev.speed.label} – empfohlen: 6/11${poll}` };
  },
};
