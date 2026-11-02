'use strict';
// Mock monitors + Windows settings (PHOENIX_MOCK=1): the reset state the user knows – the second
// monitor became the main one, portrait, 60 Hz.
const displays = require('../settings/displays');
const prefs = require('../settings/prefs');

const modes = (w, h, rates) => rates.map((hz) => `${w},${h},${hz},0`).concat([`1920,1080,60,0`, `1280,720,60,0`]).join(';');
let state = [
  { device: '\\\\.\\DISPLAY1', iface: '\\\\?\\DISPLAY#AOC2402#5&1a2b3c&0&UID4353#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}', width: 1080, height: 1920, hz: 60, orient: 1, x: 0, y: 0, primary: true, modes: modes(1920, 1080, [60, 75, 120, 144, 165]) },
  { device: '\\\\.\\DISPLAY2', iface: '\\\\?\\DISPLAY#GSM5B7F#5&1a2b3c&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}', width: 2560, height: 1440, hz: 60, orient: 0, x: 1080, y: 0, primary: false, modes: modes(2560, 1440, [60, 120, 144]) },
];
const wmi = [
  { instance: 'DISPLAY\\AOC2402\\5&1a2b3c&0&UID4353_0', name: '24G2W1G4' },
  { instance: 'DISPLAY\\GSM5B7F\\5&1a2b3c&0&UID4352_0', name: 'LG ULTRAGEAR' },
];
const current = () => displays.normalizeCurrent({ rows: state, wmi });
let values = { theme: 'light', taskbarAlign: 'center', taskbarSearch: 'box', fileExt: false, mouseAccel: true, mouseSpeed: 10, gameMode: true, gameDvr: true, power: 'balanced', timezone: 'W. Europe Standard Time' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  captureSettings: async () => {
    await wait(400);
    return { displays: current().map(displays.toEntry), prefs: { ...values }, dpi: [{ key: 'GSM5B7F0_01_07E6_A1^9F1D0E6C', value: 0 }] };
  },
  settingsDefs: async () => prefs.publicDefs(),
  applyPrefs: async (v) => {
    await wait(700);
    const clean = prefs.normalizePrefs(v);
    values = { ...values, ...clean };
    return { results: Object.keys(clean).map((id) => ({ id, ok: id !== 'widgets', error: id === 'widgets' ? 'Zugriff verweigert' : '' })) };
  },
  suggestDisplays: async (opts = {}) => ({ entries: displays.suggest(current(), { saved: opts.saved, maximize: !!opts.maximize }) }),
  applyDisplays: async (entries) => {
    await wait(900);
    const cur = current();
    const previous = cur.map((d) => ({ device: d.device, width: d.width, height: d.height, hz: d.hz, rotation: d.rotation, x: d.x, y: d.y, primary: d.primary }));
    const cmds = displays.plan(entries, cur);
    state = state.map((r) => {
      const c = cmds.find((x) => x.device === r.device);
      return c ? { ...r, width: c.w, height: c.h, hz: c.hz, orient: c.orient, x: c.x, y: c.y, primary: c.primary } : r;
    });
    return { ok: true, restart: false, previous };
  },
  listExtras: async () => [{ id: 'velox', name: 'VELOX Tweaker', version: '1.3.0', desc: 'Dein PC-Tweaker mit Presets, KI-Analyse und Sicherung jeder Änderung', available: true }],
  installExtra: async () => {
    await wait(1500);
    return { ok: true };
  },
};
