'use strict';
// PURE: Windows settings Phoenix can save and restore (no tweaks: only what the Settings app or
// Explorer options would change). Each definition says which registry values it reads and how a
// value turns back into registry writes or a "special" action done by settings/apply.

const ADV = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const PERS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const SEARCH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search';
const MOUSE = 'HKCU:\\Control Panel\\Mouse';
const STICKY = 'HKCU:\\Control Panel\\Accessibility\\StickyKeys';
const GAMEBAR = 'HKCU:\\Software\\Microsoft\\GameBar';
const GDVR = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR';
const GCS = 'HKCU:\\System\\GameConfigStore';

const dw = (path, name, value) => ({ path, name, type: 'DWord', value });
const sz = (path, name, value) => ({ path, name, type: 'String', value: String(value) });
const int = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Math.trunc(Number(v)));
const bool01 = (v) => (int(v) === 1 ? true : int(v) === 0 ? false : undefined);

const POWER_GUIDS = {
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',
  high: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  ultimate: 'e9a42b02-d5df-448d-aa00-03f14749eb61',
};

/**
 * kind: 'choice' (choices: [value, label][]), 'bool', 'range' (min/max)
 * read: registry values [path, name] the capture script fetches; from(rawValues) -> value | undefined
 * writes(value) -> registry writes; special(value) -> object for the apply script
 */
const DEFS = [
  {
    id: 'theme', group: 'Aussehen', label: 'Farbmodus', kind: 'choice', choices: [['dark', 'Dunkel'], ['light', 'Hell']],
    read: [[PERS, 'AppsUseLightTheme']],
    from: ([a]) => (int(a) === 0 ? 'dark' : int(a) === 1 ? 'light' : undefined),
    writes: (v) => [dw(PERS, 'AppsUseLightTheme', v === 'light' ? 1 : 0), dw(PERS, 'SystemUsesLightTheme', v === 'light' ? 1 : 0)],
  },
  {
    id: 'taskbarAlign', group: 'Taskleiste', label: 'Taskleisten-Symbole', kind: 'choice', choices: [['left', 'Links'], ['center', 'Mitte']],
    read: [[ADV, 'TaskbarAl']],
    from: ([a]) => (int(a) === 0 ? 'left' : int(a) === 1 ? 'center' : undefined),
    writes: (v) => [dw(ADV, 'TaskbarAl', v === 'left' ? 0 : 1)],
  },
  {
    id: 'taskbarSearch', group: 'Taskleiste', label: 'Suche in der Taskleiste', kind: 'choice',
    choices: [['hidden', 'Aus'], ['icon', 'Nur Symbol'], ['box', 'Suchfeld']],
    read: [[SEARCH, 'SearchboxTaskbarMode']],
    from: ([a]) => ({ 0: 'hidden', 1: 'icon', 2: 'box', 3: 'icon' })[int(a)],
    writes: (v) => [dw(SEARCH, 'SearchboxTaskbarMode', { hidden: 0, icon: 1, box: 2 }[v] ?? 1)],
  },
  {
    id: 'taskView', group: 'Taskleiste', label: 'Taskansicht-Schaltfläche', kind: 'bool',
    read: [[ADV, 'ShowTaskViewButton']], from: ([a]) => bool01(a), writes: (v) => [dw(ADV, 'ShowTaskViewButton', v ? 1 : 0)],
  },
  {
    id: 'widgets', group: 'Taskleiste', label: 'Widgets-Schaltfläche', kind: 'bool',
    read: [[ADV, 'TaskbarDa']], from: ([a]) => bool01(a), writes: (v) => [dw(ADV, 'TaskbarDa', v ? 1 : 0)],
  },
  {
    id: 'fileExt', group: 'Explorer', label: 'Dateiendungen anzeigen', kind: 'bool',
    read: [[ADV, 'HideFileExt']], from: ([a]) => (int(a) === 0 ? true : int(a) === 1 ? false : undefined),
    writes: (v) => [dw(ADV, 'HideFileExt', v ? 0 : 1)],
  },
  {
    id: 'hiddenFiles', group: 'Explorer', label: 'Versteckte Dateien anzeigen', kind: 'bool',
    read: [[ADV, 'Hidden']], from: ([a]) => (int(a) === 1 ? true : int(a) === 2 ? false : undefined),
    writes: (v) => [dw(ADV, 'Hidden', v ? 1 : 2)],
  },
  {
    id: 'openThisPc', group: 'Explorer', label: 'Explorer startet bei „Dieser PC“', kind: 'bool',
    read: [[ADV, 'LaunchTo']], from: ([a]) => (int(a) === 1 ? true : int(a) === 2 || int(a) === 3 ? false : undefined),
    writes: (v) => [dw(ADV, 'LaunchTo', v ? 1 : 2)],
  },
  {
    id: 'mouseAccel', group: 'Maus & Tastatur', label: 'Zeigerbeschleunigung („Zeigerpräzision verbessern“)', kind: 'bool',
    read: [[MOUSE, 'MouseSpeed']], from: ([a]) => (int(a) === 0 ? false : int(a) >= 1 ? true : undefined),
    special: (v) => ({ mouseAccel: !!v }),
  },
  {
    id: 'mouseSpeed', group: 'Maus & Tastatur', label: 'Zeigergeschwindigkeit', kind: 'range', min: 1, max: 20,
    read: [[MOUSE, 'MouseSensitivity']], from: ([a]) => (int(a) >= 1 && int(a) <= 20 ? int(a) : undefined),
    special: (v) => ({ mouseSpeed: Math.min(20, Math.max(1, int(v) || 10)) }),
  },
  {
    id: 'stickyKeys', group: 'Maus & Tastatur', label: 'Einrastfunktion bei 5× Umschalt', kind: 'bool',
    read: [[STICKY, 'Flags']], from: ([a]) => (int(a) === undefined ? undefined : (int(a) & 4) !== 0),
    writes: (v) => [sz(STICKY, 'Flags', v ? 510 : 506)],
  },
  {
    id: 'gameMode', group: 'Gaming', label: 'Spielmodus', kind: 'bool',
    read: [[GAMEBAR, 'AutoGameModeEnabled']], from: ([a]) => bool01(a), writes: (v) => [dw(GAMEBAR, 'AutoGameModeEnabled', v ? 1 : 0)],
  },
  {
    id: 'gameDvr', group: 'Gaming', label: 'Hintergrundaufnahme (Xbox Game Bar)', kind: 'bool',
    read: [[GDVR, 'AppCaptureEnabled']], from: ([a]) => bool01(a),
    writes: (v) => [dw(GDVR, 'AppCaptureEnabled', v ? 1 : 0), dw(GCS, 'GameDVR_Enabled', v ? 1 : 0)],
  },
  {
    id: 'power', group: 'System', label: 'Energiesparplan', kind: 'choice',
    choices: [['balanced', 'Ausbalanciert'], ['high', 'Höchstleistung'], ['ultimate', 'Ultimative Leistung']],
    read: [], special: (v) => ({ power: v }),
  },
  { id: 'timezone', group: 'System', label: 'Zeitzone', kind: 'text', read: [], special: (v) => ({ timezone: v }) },
];

const BY_ID = new Map(DEFS.map((d) => [d.id, d]));
const TZ_RE = /^[A-Za-z0-9 ()+.,'\-]{1,64}$/;
const DPI_KEY_RE = /^[A-Za-z0-9_^&#.\-]{1,200}$/;

/** Definitions for the UI (no functions). */
function publicDefs() {
  return DEFS.filter((d) => d.kind !== 'text').map(({ id, group, label, kind, choices, min, max }) => ({ id, group, label, kind, choices, min, max }));
}

/** Registry values the capture script must read: [{key, path, name}]. */
function readList() {
  const out = [];
  for (const d of DEFS) for (const [path, name] of d.read) out.push({ key: `${path}|${name}`, path, name });
  return out;
}

/** Power plan from `powercfg /getactivescheme` facts. */
function powerFrom(guid, name) {
  const g = String(guid || '').toLowerCase();
  for (const [k, v] of Object.entries(POWER_GUIDS)) if (g === v) return k;
  if (/ultimat/i.test(name || '')) return 'ultimate';
  if (/high performance|chstleistung/i.test(name || '')) return 'high';
  return undefined;
}

/** Turns the capture script's raw output into { prefs, dpi }. */
function fromRaw(raw) {
  const values = (raw && raw.values) || {};
  const prefs = {};
  for (const d of DEFS) {
    if (!d.from) continue;
    const v = d.from(d.read.map(([p, n]) => values[`${p}|${n}`]));
    if (v !== undefined) prefs[d.id] = v;
  }
  const power = powerFrom(raw && raw.powerGuid, raw && raw.powerName);
  if (power) prefs.power = power;
  if (raw && typeof raw.timezone === 'string' && TZ_RE.test(raw.timezone)) prefs.timezone = raw.timezone;
  return { prefs: normalizePrefs(prefs), dpi: normalizeDpi(raw && raw.dpi) };
}

/** Drops unknown ids and invalid values (profiles are files the user may have edited). */
function normalizePrefs(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [id, v] of Object.entries(input)) {
    const d = BY_ID.get(id);
    if (!d) continue;
    if (d.kind === 'bool' && typeof v === 'boolean') out[id] = v;
    else if (d.kind === 'choice' && d.choices.some(([c]) => c === v)) out[id] = v;
    else if (d.kind === 'range' && int(v) >= d.min && int(v) <= d.max) out[id] = int(v);
    else if (d.kind === 'text' && typeof v === 'string' && TZ_RE.test(v)) out[id] = v;
  }
  return out;
}

function normalizeDpi(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 32)
    .map((e) => ({ key: String((e && e.key) || ''), value: int(e && e.value) }))
    .map((e) => ({ ...e, value: e.value > 0x7fffffff ? e.value - 0x100000000 : e.value }))
    .filter((e) => DPI_KEY_RE.test(e.key) && Number.isInteger(e.value) && e.value >= -10 && e.value <= 20);
}

/** Apply groups for the apply script: [{ id, writes, special }]. */
function toGroups(prefs, dpi) {
  const clean = normalizePrefs(prefs);
  const groups = [];
  for (const [id, v] of Object.entries(clean)) {
    const d = BY_ID.get(id);
    groups.push({ id, writes: d.writes ? d.writes(v) : [], special: d.special ? d.special(v) : null });
  }
  const dpiClean = normalizeDpi(dpi);
  if (dpiClean.length) groups.push({ id: 'dpi', writes: [], special: { dpi: dpiClean } });
  return groups;
}

module.exports = { DEFS, POWER_GUIDS, publicDefs, readList, fromRaw, normalizePrefs, normalizeDpi, toGroups, powerFrom };
