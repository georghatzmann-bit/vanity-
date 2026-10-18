'use strict';
// Spiel-Booster: reine Logik ohne Windows-Aufrufe (Schutzliste, Namen, Prozess-Auswertung,
// Befehlszeilen, Energiepläne). Wird vom Modul und von den Tests benutzt.

const path = require('node:path');

const REASONS = {
  system: 'Teil von Windows – ohne dieses Programm läuft der PC nicht richtig.',
  security: 'Virenschutz und Sicherheit von Windows – bleibt immer an.',
  anticheat: 'Anti-Cheat (Schutz gegen Schummler) – HELIX fasst Anti-Cheat nie an.',
  fortnite: 'Gehört zu Fortnite – der Booster schließt Fortnite nie.',
  epic: 'Epic Games Launcher – Schließen kann deine laufende Fortnite-Sitzung stören.',
  helix: 'Das ist HELIX selbst.',
  helper: 'Dieses Windows-Werkzeug braucht HELIX selbst zum Arbeiten.',
  input: 'Teil der Maus-, Tastatur- oder Eingabe-Steuerung von Windows.',
  graphics: 'Hilfsprogramm des Grafiktreibers. Schließen geht, aber Treiber-Funktionen wie Aufnahme oder Farbeinstellungen können dann fehlen.',
  inputsw: 'Software für Maus, Tastatur oder Headset. Ohne sie können DPI (Mausempfindlichkeit), Tastenbelegung oder Beleuchtung anders sein.',
  audio: 'Hilfsprogramm des Soundtreibers. Ohne es kann der Ton anders klingen oder ganz fehlen.',
};

// [art, Muster, Stufe]  Muster: 'name' = genau, 'name*' = beginnt mit, '*name' = endet mit, '*name*' = enthält
const RULES = [
  ['system', ['system', 'idle', 'system idle process', 'registry', 'memory compression', 'secure system', 'smss', 'csrss', 'wininit', 'winlogon',
    'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'explorer', 'sihost', 'fontdrvhost', 'audiodg', 'conhost', 'runtimebroker', 'searchhost',
    'searchapp', 'searchui', 'searchindexer', 'searchprotocolhost', 'startmenuexperiencehost', 'shellexperiencehost', 'shellhost',
    'applicationframehost', 'lockapp', 'logonui', 'userinit', 'taskhostw', 'dllhost', 'dashost', 'spoolsv', 'consent', 'wlanext',
    'systemsettingsbroker', 'backgroundtaskhost', 'smartscreen'], 'block'],
  ['security', ['msmpeng', 'nissrv', 'mpdefendercoreservice', 'mpcmdrun', 'securityhealth*', 'msseces'], 'block'],
  ['input', ['ctfmon', 'wudfhost', 'textinputhost', 'tabtip', 'inputapp'], 'block'],
  ['anticheat', ['easyanticheat*', 'battleye*', 'beservice*', '*_be', '*_eac', '*_eac_eos', '*anticheat*', '*anti-cheat*', 'vgc', 'vgtray', 'faceit*', 'pnkbstra', 'pnkbstrb'], 'block'],
  ['fortnite', ['fortnite*'], 'block'],
  ['epic', ['epicgameslauncher', 'epicwebhelper', 'epiconlineservices*', 'eosoverlayrenderer*', 'unrealcefsubprocess', 'crashreportclient'], 'block'],
  ['helper', ['powershell', 'pwsh', 'taskkill', 'tasklist', 'reg', 'powercfg', 'wmiprvse'], 'block'],
  ['graphics', ['nvcontainer', 'nvdisplay.container', 'nvsphelper64', 'atiesrxx', 'atieclxx', 'radeonsoftware', 'amdrsserv', 'amdrssrcext', 'igfxem', 'igfxcui', 'igfxhk', 'igfxtray'], 'warn'],
  ['inputsw', ['lghub*', 'logioptionsplus*', 'razer*', 'rzsdk*', 'rzchroma*', 'steelseries*', 'icue', 'corsair*', 'wootility*', 'ngenuity*', 'hyperx*', 'roccat*'], 'warn'],
  ['audio', ['rtkaud*', 'nahimic*', 'a-volute*', 'voicemeeter*'], 'warn'],
];

/** Programmname vereinheitlichen: ohne Ordner, ohne ".exe", klein geschrieben. */
function normalizeName(n) {
  let s = String(n ?? '').trim().replace(/^"+|"+$/g, '');
  s = s.split(/[\\/]/).pop() || '';
  s = s.trim().replace(/\s+/g, ' ').toLowerCase();
  if (s.endsWith('.exe')) s = s.slice(0, -4).trim();
  return s;
}

/** Erlaubt sind normale Dateinamen (keine Pfadzeichen, keine Steuerzeichen). */
function validName(n) {
  const s = normalizeName(n);
  return !!s && s.length <= 100 && s !== '.' && s !== '..' && !/[\\/:*?"<>|\x00-\x1f]/.test(s);
}

function matches(pattern, name) {
  const starts = pattern.startsWith('*');
  const ends = pattern.endsWith('*');
  const core = pattern.replace(/^\*|\*$/g, '');
  if (starts && ends) return name.includes(core);
  if (ends) return name.startsWith(core);
  if (starts) return name.endsWith(core);
  return name === core;
}

/** Name von HELIX selbst (im Test "node", fertig gebaut "helix", in der Entwicklung "electron"). */
function selfNames(execPath = process.execPath) {
  return [...new Set(['helix', 'electron', normalizeName(path.basename(String(execPath || '')))].filter(Boolean))];
}

/**
 * Schutzprüfung. Rückgabe null (darf geschlossen werden) oder { level:'block'|'warn', kind, reason }.
 * Groß-/Kleinschreibung egal, mit oder ohne ".exe", auch mit Pfad.
 */
function classify(name, { self = selfNames() } = {}) {
  const n = normalizeName(name);
  if (!n) return { level: 'block', kind: 'system', reason: REASONS.system };
  if (self.includes(n)) return { level: 'block', kind: 'helix', reason: REASONS.helix };
  for (const [kind, patterns, level] of RULES) {
    if (patterns.some((p) => matches(p, n))) return { level, kind, reason: REASONS[kind] };
  }
  return null;
}

const isBlocked = (name, o) => classify(name, o)?.level === 'block';

/** Anzeigename aufräumen. */
function cleanDisplay(s, fallback) {
  const t = String(s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.exe$/i, '');
  return (t || String(fallback || '')).slice(0, 60);
}

/** Absoluter Windows-Pfad zu einer .exe? */
function validExePath(p) {
  const s = String(p ?? '');
  return s.length > 4 && s.length < 600 && /^[a-zA-Z]:\\/.test(s) && /\.exe$/i.test(s) && !/[\r\n"<>|*?]/.test(s);
}

/** JSON aus PowerShell: null -> [], Einzelobjekt -> [obj]. */
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Laufende Programme (Get-Process) zusammenfassen: ein Eintrag je Programmname.
 * Windows-Interna (system/security/input/helper) werden nicht angeboten.
 */
function groupRunning(raw, { listNames = [], self = selfNames() } = {}) {
  const list = new Set(listNames.map(normalizeName));
  const map = new Map();
  for (const p of asArray(raw)) {
    const name = normalizeName(p?.Name);
    if (!name) continue;
    const pid = Number(p.Id);
    if (!Number.isInteger(pid) || pid <= 4) continue;
    let g = map.get(name);
    if (!g) {
      g = { name, display: cleanDisplay(p.Name, name), description: '', company: '', path: null, count: 0, pids: [], memMb: 0, hasWindow: false };
      map.set(name, g);
    }
    g.count++;
    g.pids.push(pid);
    g.memMb += Math.max(0, Number(p.WorkingSet) || 0) / (1024 * 1024);
    if (!g.path && validExePath(p.Path)) g.path = String(p.Path);
    if (!g.description && p.Description) g.description = cleanDisplay(p.Description, '');
    if (!g.company && p.Company) g.company = cleanDisplay(p.Company, '');
    if (p.MainWindowTitle && String(p.MainWindowTitle).trim()) g.hasWindow = true;
  }
  const out = [];
  for (const g of map.values()) {
    const protect = classify(g.name, { self });
    if (protect && ['system', 'security', 'input', 'helper'].includes(protect.kind)) continue;
    if (!g.path && !g.hasWindow && !protect) continue; // nicht lesbar, wahrscheinlich ein Dienst
    out.push({ ...g, memMb: Math.round(g.memMb), protect, inList: list.has(g.name) });
  }
  out.sort((a, b) => (a.protect?.level === 'block') - (b.protect?.level === 'block') || (b.hasWindow - a.hasWindow) || b.memMb - a.memMb || a.name.localeCompare(b.name));
  return out;
}

/** Argumente aus einer Befehlszeile (ohne das Programm selbst). */
function argsFromCommandLine(cmd, exePath) {
  const s = String(cmd ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  const p = String(exePath ?? '').toLowerCase();
  if (p) {
    if (lower.startsWith(`"${p}"`)) return s.slice(p.length + 2).trim();
    if (lower.startsWith(p) && (lower.length === p.length || lower[p.length] === ' ')) return s.slice(p.length).trim();
  }
  if (s[0] === '"') {
    const end = s.indexOf('"', 1);
    return end < 0 ? '' : s.slice(end + 1).trim();
  }
  return s.replace(/^\S+/, '').trim();
}

/**
 * Welche Prozesse eines Programms muss man neu starten? Nur die "Haupt"-Prozesse:
 * Eltern-Prozess heißt anders, und keine Chromium/Electron-Hilfsprozesse (--type=...).
 * procs: [{ Name, Id, ParentId, Path, CommandLine }] eines Programmnamens.
 */
function pickRoots(procs) {
  const list = asArray(procs).filter((p) => p && Number.isInteger(Number(p.Id)));
  const pids = new Set(list.map((p) => Number(p.Id)));
  let roots = list.filter((p) => !pids.has(Number(p.ParentId)) && !/\s--type=/i.test(String(p.CommandLine || '')));
  if (!roots.length) {
    roots = list.filter((p) => !/\s--type=/i.test(String(p.CommandLine || '')));
  }
  if (!roots.length) roots = list.slice(0, 1);
  const seen = new Set();
  const out = [];
  for (const p of roots) {
    if (!validExePath(p.Path)) continue;
    const args = argsFromCommandLine(p.CommandLine, p.Path).slice(0, 4000).replace(/[\r\n]/g, ' ');
    const key = `${String(p.Path).toLowerCase()}|${args}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: String(p.Path), args, cwd: path.win32.dirname(String(p.Path)) });
  }
  return out.slice(0, 5);
}

// ---------- Energiepläne ----------

const PLAN = {
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',
  high: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  saver: 'a1841308-3541-4fab-bc81-f71556f20b4a',
  ultimate: 'e9a42b02-d5df-448d-aa00-03f14749eb61',
};
const KNOWN_PLANS = {
  [PLAN.balanced]: 'Ausbalanciert',
  [PLAN.high]: 'Höchstleistung',
  [PLAN.saver]: 'Energiesparmodus',
  [PLAN.ultimate]: 'Ultimative Leistung',
};
const GUID_RE = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i;
const validGuid = (g) => typeof g === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(g);

/** `powercfg /list` (sprachunabhängig: nur GUID, Name in Klammern, Stern = aktiv). */
function parsePowercfgList(text) {
  const plans = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(GUID_RE);
    if (!m) continue;
    const guid = m[0].toLowerCase();
    const after = line.slice(line.indexOf(m[0]) + m[0].length);
    const nm = after.match(/\(([^)]*)\)/);
    plans.push({ guid, name: nm ? nm[1].trim() : '', active: /\*\s*$/.test(line) });
  }
  return plans;
}

function parseActiveScheme(text) {
  const m = String(text ?? '').match(GUID_RE);
  return m ? m[0].toLowerCase() : null;
}

function planLabel(plan) {
  if (!plan) return 'unbekannt';
  return KNOWN_PLANS[plan.guid] || plan.name || 'Eigener Energieplan';
}

/** Ziel-Plan "Höchstleistung": Standard-GUID, sonst ein Plan mit passendem Namen. */
function chooseHighPlan(plans) {
  const list = plans || [];
  return list.find((p) => p.guid === PLAN.high)
    || list.find((p) => /höchstleistung|hochleistung|high performance|ultimative leistung|ultimate performance/i.test(p.name || ''))
    || null;
}

// Codepage 850 (deutsche Konsole) – für Ausgaben, die nicht als UTF-8 kommen.
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';

function decodeConsole(buf) {
  if (typeof buf === 'string') return buf;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const utf8 = b.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  let s = '';
  for (const byte of b) s += byte < 0x80 ? String.fromCharCode(byte) : CP850[byte - 0x80];
  return s;
}

// ---------- Texte ----------

function summaryText(state) {
  const st = state || {};
  if (st.active) {
    const n = (st.active.apps || []).filter((a) => a.status === 'closed' || a.status === 'forced').length;
    return n ? `Boost aktiv – ${n} ${n === 1 ? 'Programm' : 'Programme'} geschlossen` : 'Boost aktiv';
  }
  const n = Array.isArray(st.list) ? st.list.length : 0;
  if (!n) return 'Noch keine Programme in der Liste';
  return `${n} ${n === 1 ? 'Programm' : 'Programme'} in der Liste`;
}

module.exports = {
  REASONS, RULES, PLAN, KNOWN_PLANS,
  normalizeName, validName, classify, isBlocked, selfNames, cleanDisplay, validExePath, asArray,
  groupRunning, argsFromCommandLine, pickRoots,
  parsePowercfgList, parseActiveScheme, planLabel, chooseHighPlan, validGuid, decodeConsole, summaryText,
};
