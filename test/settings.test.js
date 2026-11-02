'use strict';
const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/main/settings/displays');
const prefs = require('../src/main/settings/prefs');
const { normalize } = require('../src/main/profile/profile');

const modes = (w, h, rates) => rates.map((hz) => `${w},${h},${hz},0`).concat(['1920,1080,60,0', '1280,720,60,0']).join(';');
const RAW = {
  rows: [
    { device: '\\\\.\\DISPLAY1', iface: '\\\\?\\DISPLAY#AOC2402#5&1a2b3c&0&UID4353#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}', width: 1080, height: 1920, hz: 60, orient: 1, x: 0, y: 0, primary: true, modes: modes(1920, 1080, [60, 144, 165]) },
    { device: '\\\\.\\DISPLAY2', iface: '\\\\?\\DISPLAY#GSM5B7F#5&1a2b3c&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}', width: 2560, height: 1440, hz: 60, orient: 0, x: 1080, y: 0, primary: false, modes: modes(2560, 1440, [60, 120, 144]) },
  ],
  wmi: [{ instance: 'DISPLAY\\GSM5B7F\\5&1a2b3c&0&UID4352_0', name: 'LG ULTRAGEAR' }],
};

test('monitor interface name -> model id and instance', () => {
  const r = d.parseInterface('\\\\?\\DISPLAY#GSM5B7F#5&1a2b3c&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}');
  assert.deepStrictEqual(r, { monitorId: 'GSM5B7F', instance: 'DISPLAY\\GSM5B7F\\5&1A2B3C&0&UID4352' });
  assert.deepStrictEqual(d.parseInterface(''), { monitorId: '', instance: '' });
});

test('current displays are landscape-normalized and named', () => {
  const cur = d.normalizeCurrent(RAW);
  assert.strictEqual(cur.length, 2);
  assert.deepStrictEqual([cur[0].width, cur[0].height, cur[0].rotation], [1920, 1080, 90]);
  assert.strictEqual(cur[1].name, 'LG ULTRAGEAR');
  assert.strictEqual(cur[0].name, 'Monitor AOC2402');
  assert.deepStrictEqual(cur[1].modes[0], { w: 2560, h: 1440, hz: 144 });
});

test('backup restores main monitor, Hz and rotation on the matching monitors', () => {
  const cur = d.normalizeCurrent(RAW);
  const saved = [
    { monitorId: 'GSM5B7F', instance: 'DISPLAY\\GSM5B7F\\OLD', width: 2560, height: 1440, hz: 144, rotation: 0, x: 0, y: 0, primary: true },
    { monitorId: 'AOC2402', instance: 'DISPLAY\\AOC2402\\OLD', width: 1920, height: 1080, hz: 165, rotation: 0, x: 2560, y: 0, primary: false },
  ];
  const entries = d.suggest(cur, { saved });
  const lg = entries.find((e) => e.monitorId === 'GSM5B7F');
  const aoc = entries.find((e) => e.monitorId === 'AOC2402');
  assert.deepStrictEqual([lg.hz, lg.primary, lg.fromBackup], [144, true, true]);
  assert.deepStrictEqual([aoc.hz, aoc.rotation, aoc.primary], [165, 0, false]);
  const cmds = d.plan(entries, cur);
  const lgCmd = cmds.find((c) => c.device === '\\\\.\\DISPLAY2');
  const aocCmd = cmds.find((c) => c.device === '\\\\.\\DISPLAY1');
  assert.deepStrictEqual([lgCmd.x, lgCmd.y, lgCmd.primary, lgCmd.hz], [0, 0, true, 144]);
  assert.deepStrictEqual([aocCmd.x, aocCmd.w, aocCmd.h, aocCmd.orient], [2560, 1920, 1080, 0]);
});

test('unavailable saved refresh rate falls back to the closest lower one', () => {
  const m = d.parseModes('2560,1440,60,0;2560,1440,120,0');
  assert.deepStrictEqual(d.bestMode(m, 2560, 1440, 144), { w: 2560, h: 1440, hz: 120 });
  assert.deepStrictEqual(d.bestMode(m, 3840, 2160, 144), { w: 2560, h: 1440, hz: 120 });
});

test('maximize picks native resolution at the highest Hz; portrait swaps DEVMODE size', () => {
  const cur = d.normalizeCurrent(RAW);
  const entries = d.suggest(cur, { maximize: true });
  assert.deepStrictEqual(entries.map((e) => e.hz), [165, 144]);
  const cmds = d.plan(entries, cur);
  const portrait = cmds.find((c) => c.device === '\\\\.\\DISPLAY1');
  assert.deepStrictEqual([portrait.w, portrait.h, portrait.orient, portrait.primary], [1080, 1920, 1, true]);
  const other = cmds.find((c) => c.device === '\\\\.\\DISPLAY2');
  assert.deepStrictEqual([other.x, other.y], [1080, 0]);
});

test('overlapping positions fall back to side by side with the main monitor at 0,0', () => {
  const out = d.layout([
    { device: 'a', width: 1920, height: 1080, rotation: 0, x: 0, y: 0, primary: false },
    { device: 'b', width: 1920, height: 1080, rotation: 0, x: 100, y: 0, primary: true },
  ]);
  assert.deepStrictEqual(out.map((e) => [e.x, e.y, e.primary]), [[-1920, 0, false], [0, 0, true]]);
});

test('settings raw values -> prefs -> registry writes', () => {
  const values = {};
  const put = (path, name, v) => (values[`${path}|${name}`] = v);
  for (const r of prefs.readList()) {
    if (r.name === 'AppsUseLightTheme') put(r.path, r.name, 0);
    if (r.name === 'TaskbarAl') put(r.path, r.name, 0);
    if (r.name === 'MouseSpeed') put(r.path, r.name, '0');
    if (r.name === 'HideFileExt') put(r.path, r.name, 0);
  }
  const { prefs: p, dpi } = prefs.fromRaw({ values, powerGuid: 'E9A42B02-D5DF-448D-AA00-03F14749EB61', timezone: 'W. Europe Standard Time', dpi: [{ key: 'GSM5B7F0_01^ABC', value: 4294967295 }, { key: 'bad key!', value: 1 }] });
  assert.deepStrictEqual(p, { theme: 'dark', taskbarAlign: 'left', fileExt: true, mouseAccel: false, power: 'ultimate', timezone: 'W. Europe Standard Time' });
  assert.deepStrictEqual(dpi, [{ key: 'GSM5B7F0_01^ABC', value: -1 }]);
  const groups = prefs.toGroups({ ...p, bogus: 1, theme: 'neon' }, dpi);
  assert.ok(!groups.some((g) => g.id === 'bogus' || g.id === 'theme'));
  assert.deepStrictEqual(groups.find((g) => g.id === 'taskbarAlign').writes[0].value, 0);
  assert.deepStrictEqual(groups.find((g) => g.id === 'mouseAccel').special, { mouseAccel: false });
  assert.deepStrictEqual(groups.find((g) => g.id === 'dpi').special.dpi.length, 1);
});

test('profiles keep a cleaned settings block, package and extras', () => {
  const p = normalize({
    apps: [],
    package: 'gaming',
    extras: ['velox', 'evil'],
    settings: { displays: [{ monitorId: 'GSM5B7F', width: 2560, height: 1440, hz: 144, rotation: 45, primary: true }], prefs: { theme: 'dark', power: 'x' }, dpi: [] },
  });
  assert.strictEqual(p.package, 'gaming');
  assert.deepStrictEqual(p.extras, ['velox']);
  assert.strictEqual(p.settings.displays[0].rotation, 0);
  assert.deepStrictEqual(p.settings.prefs, { theme: 'dark' });
  assert.strictEqual(normalize({ apps: [], settings: { prefs: {} } }).settings, undefined);
});
