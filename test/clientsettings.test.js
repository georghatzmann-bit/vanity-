'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');

const cs = require('../src/main/core/clientsettings');
const { CoreService } = require('../src/main/core/service');
const { makeLocalAppData, tmpDir, fakeExec } = require('./helpers');

// ---- kleine Nachbildung des Unreal-Formats (Name, Typ, Größe/Index/Flags, Wert) ----

function fstr(s) {
  const b = Buffer.alloc(4 + s.length + 1);
  b.writeInt32LE(s.length + 1, 0);
  b.write(s, 4, 'latin1');
  return b;
}
function int32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }

// UE4: Größe(int32) + Index(int32) + GUID-Flag(1 Byte)
function floatProp4(name, v) {
  const val = Buffer.alloc(4); val.writeFloatLE(v, 0);
  return Buffer.concat([fstr(name), fstr('FloatProperty'), int32(4), int32(0), Buffer.from([0]), val]);
}
function nameProp4(name, v) {
  const val = fstr(v);
  return Buffer.concat([fstr(name), fstr('NameProperty'), int32(val.length), int32(0), Buffer.from([0]), val]);
}
// UE5.4+: Anzahl innerer Typen(int32) + Größe(int32) + Flags(1 Byte)
function floatProp5(name, v) {
  const val = Buffer.alloc(4); val.writeFloatLE(v, 0);
  return Buffer.concat([fstr(name), fstr('FloatProperty'), int32(0), int32(4), Buffer.from([0]), val]);
}
function nameProp5(name, v) {
  const val = fstr(v);
  return Buffer.concat([fstr(name), fstr('NameProperty'), int32(0), int32(val.length), Buffer.from([0]), val]);
}

function mapping(nameProp, action, keys) {
  return Buffer.concat([nameProp('ActionName', action), ...keys.map((k) => nameProp('KeyName', k))]);
}

function sav({ sensX = 0.065, target = 0.45, wall = 'Q', fire = 'LeftMouseButton', v5 = false, hud = 1 } = {}) {
  const fp = v5 ? floatProp5 : floatProp4;
  const np = v5 ? nameProp5 : nameProp4;
  const body = Buffer.concat([
    Buffer.alloc(0x16, 1), fstr('++Fortnite+Release-31.00'), int32(7),
    fp('MouseSensitivityX', sensX), fp('MouseSensitivityY', sensX), fp('TargetingMultiplier', target), fp('HUDScale', hud),
    mapping(np, 'Wall', [wall]),
    mapping(np, 'Fire', [fire]),
    mapping(np, 'Jump', ['SpaceBar']),
    fstr('None'),
  ]);
  return Buffer.concat([Buffer.from('ECFD'), Buffer.alloc(12, 0), zlib.deflateSync(body)]);
}

test('ClientSettings: liest Sensi und Tasten (altes Unreal-Format, ECFD + zlib)', () => {
  const x = cs.extract(sav());
  assert.equal(x.ok, true);
  assert.ok(Math.abs(x.numbers.MouseSensitivityX - 0.065) < 1e-6);
  assert.ok(Math.abs(x.numbers.TargetingMultiplier - 0.45) < 1e-6);
  assert.deepEqual(x.binds.find((b) => b.action === 'Wall').keys, ['Q']);
  assert.deepEqual(x.binds.find((b) => b.action === 'Fire').keys, ['LeftMouseButton']);
  const v = cs.view(x);
  assert.equal(v.sens.find((s) => s.name === 'MouseSensitivityX').value, '6,5 %');
  assert.equal(v.binds.find((b) => b.action === 'Wall').label, 'Wand');
  assert.deepEqual(v.binds.find((b) => b.action === 'Jump').keys, ['Leertaste']);
});

test('ClientSettings: liest auch das neue Unreal-5-Format', () => {
  const x = cs.extract(sav({ v5: true, wall: 'ThumbMouseButton' }));
  assert.equal(x.ok, true);
  assert.ok(Math.abs(x.numbers.MouseSensitivityX - 0.065) < 1e-6);
  assert.equal(cs.view(x).binds.find((b) => b.action === 'Wall').keys[0], 'Maustaste 4');
});

test('ClientSettings: Unterschiede zeigen nur, was im Spiel anders ist', () => {
  const now = cs.extract(sav());
  const want = cs.extract(sav({ sensX: 0.072, wall: 'ThumbMouseButton', hud: 0.85 }));
  const d = cs.diff(now, want);
  assert.equal(d.binds.length, 1);
  assert.deepEqual(d.binds[0], { action: 'Wall', label: 'Wand', from: ['Q'], to: ['Maustaste 4'] });
  assert.deepEqual(d.sens.map((s) => [s.label, s.from, s.to]), [['Maus-Sensi X', '6,5 %', '7,2 %'], ['Maus-Sensi Y', '6,5 %', '7,2 %']]);
  assert.deepEqual(d.other.map((s) => [s.label, s.from, s.to]), [['HUD-Größe', '100 %', '85 %']]);
  assert.equal(cs.diff(now, cs.extract(sav())).count, 0);
});

test('ClientSettings: unlesbare Datei -> ok:false statt Absturz', () => {
  assert.equal(cs.extract(Buffer.from('ECFD-kaputt-1234567890')).ok, false);
  assert.equal(cs.extract(Buffer.alloc(0)).ok, false);
  assert.equal(cs.extract(Buffer.from([0x45, 0x43, 0x46, 0x44, 0, 1, 2, 255, 0x78, 0x9c, 1, 2, 3])).ok, false);
  assert.equal(cs.diff(cs.extract(Buffer.alloc(0)), cs.extract(sav())), null);
  assert.deepEqual(cs.view(null), { ok: false, sens: [], binds: [], other: [] });
});

test('ClientSettings: Aktionsnamen werden lesbar', () => {
  assert.equal(cs.actionLabel('IA_EditMode'), 'Bearbeiten Modus');
  assert.equal(cs.actionLabel('PlaceWall'), 'Setzen Wand');
  assert.equal(cs.keyLabel('NumPadThree'), 'Num 3');
  assert.equal(cs.keyLabel('F5'), 'F5');
});

test('Profile: Tasten & Sensi – Profil gegen aktuelle Kopie vergleichen', async () => {
  const fx = makeLocalAppData({ clientSettings: sav({ wall: 'ThumbMouseButton', sensX: 0.072 }) });
  const c = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: fx.local }, exec: fakeExec() });
  const p = await c.createProfile({ name: 'Main' });
  // Fortnite holt später die Cloud-Version: lokale Kopie ist wieder anders
  fs.writeFileSync(fx.cs, sav());
  const r = await c.controls(p.id);
  assert.equal(r.available, true);
  assert.equal(r.profile.ok, true);
  assert.equal(r.profile.binds.find((b) => b.action === 'Wall').keys[0], 'Maustaste 4');
  assert.equal(r.current.ok, true);
  assert.equal(r.diff.binds[0].label, 'Wand');
  assert.deepEqual(r.diff.binds[0].from, ['Q']);
  assert.equal(r.diff.sens.length, 2);
});

test('Profile: Tasten & Sensi – alte Testdatei ohne lesbare Werte', async () => {
  const fx = makeLocalAppData();
  const c = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: fx.local }, exec: fakeExec() });
  const p = await c.createProfile({ name: 'Main' });
  const r = await c.controls(p.id);
  assert.equal(r.available, true);
  assert.equal(r.profile.ok, false);
  assert.equal(r.diff, null);
});
