'use strict';
// Windows-Gaming-Check: reine Funktionen ohne Windows-Aufrufe (Parser, Bewertung, Texte, Rückgängig).
//
// Gelesen wird über reg.exe (HKCU und HKLM), powercfg und fs.statfs. Geschrieben wird nur:
//   - HKCU-Werte (Spielmodus, Aufnahme im Hintergrund) – mit gespeicherten alten Werten zum Rückgängigmachen
//   - der aktive Energieplan über powercfg /setactive
// Alles, was Administrator-Rechte braucht (z. B. GPU-Planung unter HKLM), wird nur erklärt und verlinkt.

const KEYS = {
  gameBar: 'HKCU\\Software\\Microsoft\\GameBar',
  gameConfig: 'HKCU\\System\\GameConfigStore',
  gameDvr: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR',
  graphics: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers',
  mouse: 'HKCU\\Control Panel\\Mouse',
  ntVersion: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
};

/** Was Windows annimmt, wenn ein Wert fehlt (wird auch beim Rückgängigmachen geschrieben). */
const DEFAULTS = {
  AutoGameModeEnabled: 1,
  AllowAutoGameMode: 1,
  GameDVR_Enabled: 1,
  AppCaptureEnabled: 1,
  HistoricalCaptureEnabled: 0,
};

const HIGH_PERFORMANCE = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const PLANS = {
  'a1841308-3541-4fab-bc81-f71556f20b4a': { kind: 'saver', name: 'Energiesparmodus' },
  '381b4222-f694-41f0-9685-ff5bb260df2e': { kind: 'balanced', name: 'Ausbalanciert' },
  [HIGH_PERFORMANCE]: { kind: 'high', name: 'Höchstleistung' },
  'e9a42b02-d5df-448d-aa00-03f14749eb61': { kind: 'ultimate', name: 'Ultimative Leistung' },
};

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const GB = 1024 ** 3;

const GROUPS = [
  { id: 'leistung', title: 'Leistung beim Spielen', hint: 'Diese Einstellungen wirken direkt auf FPS und Ruckler.' },
  { id: 'system', title: 'System', hint: 'Genug Platz für Updates und eine aktuelle Windows-Version.' },
  { id: 'ruhe', title: 'Ruhe und Komfort', hint: 'Weniger Ablenkung beim Spielen und eine gleichmäßige Maus.' },
];

const SAFE_FIXES = ['gamemode', 'gamedvr'];
const FIX_IDS = ['gamemode', 'gamedvr', 'power'];

const isGuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isHkcu = (key) => /^HKCU\\|^HKEY_CURRENT_USER\\/i.test(String(key || ''));

// ---------------------------------------------------------------- Ausgabe von Konsolenprogrammen

// Codepage 850 (deutsche Konsole), Bytes 0x80–0xFF
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';

function decodeCp850(buf) {
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : CP850[b - 0x80];
  return s;
}

/**
 * powercfg schreibt in der Codepage der Konsole (meist 850, manchmal 1252), nicht in UTF-8.
 * Gibt den Text zurück, der am ehesten nach deutschen Wörtern aussieht.
 */
function decodeConsole(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  const buf = Buffer.from(out);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  const score = (s) => (s.match(/[äöüÄÖÜßéèáàô]/g) || []).length - 2 * (s.match(/[░▒▓│┤╣║╗╝┐└┴┬├─┼╚╔╩╦╠═╬┘┌█▄▀■÷×ƒ¤¦]/g) || []).length;
  const a = decodeCp850(buf);
  const b = buf.toString('latin1');
  return score(b) > score(a) ? b : a;
}

// ---------------------------------------------------------------- powercfg

/** "Power Scheme GUID: 381b…  (Balanced)" bzw. "GUID des Energieschemas: 381b…  (Ausbalanciert)" */
function parsePowercfgActive(text) {
  const t = String(text ?? '');
  const m = GUID_RE.exec(t);
  if (!m) return null;
  const rest = t.slice(m.index + m[0].length).split(/\r?\n/)[0];
  const nm = /\(([^)]*)\)/.exec(rest);
  return { guid: m[0].toLowerCase(), name: nm ? nm[1].trim() || null : null };
}

/** Alle Pläne aus "powercfg /list"; der aktive ist mit * markiert. Namen sind übersetzt – verglichen wird nur die GUID. */
function parsePowercfgList(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = GUID_RE.exec(line);
    if (!m) continue;
    const rest = line.slice(m.index + m[0].length);
    const nm = /\(([^)]*)\)/.exec(rest);
    out.push({ guid: m[0].toLowerCase(), name: nm ? nm[1].trim() || null : null, active: /\*\s*$/.test(rest) });
  }
  return out;
}

/** Art und deutscher Name eines Plans. Kopien von "Ultimative Leistung" haben eine eigene GUID – dort hilft nur der Name. */
function planInfo(guid, name) {
  const known = PLANS[String(guid || '').toLowerCase()];
  if (known) return { ...known };
  if (/ultimat/i.test(name || '')) return { kind: 'ultimate', name: name || 'Ultimative Leistung' };
  return { kind: 'custom', name: name || 'Eigener Plan' };
}

// ---------------------------------------------------------------- Registrierung

function regNum(values, name) {
  const v = values && values[name];
  if (!v) return null;
  const n = typeof v.value === 'number' ? v.value : Number.parseInt(String(v.value).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function regStr(values, name) {
  const v = values && values[name];
  return v && v.value != null ? String(v.value).trim() : null;
}

/** Wert oder Windows-Standard, wenn er fehlt. */
function effective(values, name) {
  const n = regNum(values, name);
  return n == null ? DEFAULTS[name] : n;
}

// ---------------------------------------------------------------- Epic: Installationsort (nur lesen)

/** Fortnite-Ordner aus LauncherInstalled.dat (JSON, InstallationList[].InstallLocation). */
function parseLauncherInstalled(text) {
  try {
    const j = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
    const list = Array.isArray(j && j.InstallationList) ? j.InstallationList : [];
    const hit = list.find((e) => e && /^fortnite$/i.test(String(e.AppName || ''))) ||
      list.find((e) => e && /[\\/]fortnite[\\/]?$/i.test(String(e.InstallLocation || '')));
    return hit && hit.InstallLocation ? String(hit.InstallLocation) : null;
  } catch {
    return null;
  }
}

function driveOf(p) {
  const m = /^([a-z]):/i.exec(String(p || ''));
  return m ? `${m[1].toUpperCase()}:` : null;
}

// ---------------------------------------------------------------- Windows-Version

const EDITIONS = {
  core: 'Home', coren: 'Home', coresinglelanguage: 'Home', corecountryspecific: 'Home',
  professional: 'Pro', professionaln: 'Pro', professionalworkstation: 'Pro for Workstations', professionaleducation: 'Pro Education',
  education: 'Education', enterprise: 'Enterprise', enterprisen: 'Enterprise', iotenterprise: 'IoT Enterprise',
};

function windowsInfo(nt, release) {
  const fromRel = Number.parseInt(String(release || '').split('.')[2], 10);
  const build = Number.parseInt(regStr(nt, 'CurrentBuildNumber') || regStr(nt, 'CurrentBuild') || '', 10) || (Number.isFinite(fromRel) ? fromRel : null);
  if (!build) return null;
  const win11 = build >= 22000;
  const ed = regStr(nt, 'EditionID');
  const edition = ed ? EDITIONS[ed.toLowerCase()] || ed : null;
  const version = regStr(nt, 'DisplayVersion') || regStr(nt, 'ReleaseId');
  const ubr = regNum(nt, 'UBR');
  const name = `Windows ${win11 ? '11' : '10'}${edition ? ` ${edition}` : ''}`;
  return { build, ubr, win11, edition, version, name, label: [name, version, `Build ${build}${ubr != null ? `.${ubr}` : ''}`].filter(Boolean).join(' · ') };
}

// ---------------------------------------------------------------- Bewertung

const fmtGB = (bytes) => Math.round(bytes / GB).toLocaleString('de-DE');
const settingsLink = (uri, label) => ({ kind: 'settings', uri, label });
const toolLink = (id, label) => ({ kind: 'tool', id, label });

function item(id, group, title, status, value, text, extra = {}) {
  return { id, group, title, status, value, text, fix: null, links: [], note: null, ...extra };
}

function evalGameMode(gameBar) {
  const on = effective(gameBar, 'AutoGameModeEnabled') !== 0;
  const links = [settingsLink('ms-settings:gaming-gamemode', 'Windows-Einstellung')];
  if (on) return item('gamemode', 'leistung', 'Spielmodus', 'good', 'An', 'Windows gibt Fortnite Vorrang und hält Updates und Neustart-Hinweise beim Spielen zurück.', { links });
  return item('gamemode', 'leistung', 'Spielmodus', 'change', 'Aus',
    'Ohne Spielmodus können Updates und andere Aufgaben im Hintergrund das Spiel stören. Einschalten wird empfohlen.',
    { links, fix: { label: 'Einschalten', safe: true } });
}

function evalGameDvr(gameConfig, gameDvr) {
  const historical = effective(gameDvr, 'HistoricalCaptureEnabled') !== 0;
  const capture = effective(gameDvr, 'AppCaptureEnabled') !== 0 || effective(gameConfig, 'GameDVR_Enabled') !== 0;
  const links = [settingsLink('ms-settings:gaming-gamedvr', 'Windows-Einstellung')];
  const fix = { label: 'Ausschalten', safe: true, note: 'Danach gehen Clips mit der Xbox Game Bar nicht mehr. Mit „Rückgängig“ holst du sie zurück.' };
  if (historical) {
    return item('gamedvr', 'leistung', 'Aufnahme im Hintergrund', 'change', 'Nimmt dauernd auf',
      'Windows filmt ständig die letzten Minuten mit („Aufzeichnen, was passiert ist“). Das kostet FPS. Ausschalten wird empfohlen.', { links, fix });
  }
  if (capture) {
    return item('gamedvr', 'leistung', 'Aufnahme im Hintergrund', 'hint', 'Bereit, nimmt nicht auf',
      'Clips mit der Xbox Game Bar (Win + Alt + R) sind möglich, eine Daueraufnahme läuft nicht. Ausschalten nur, wenn du damit keine Clips machst.', { links, fix });
  }
  return item('gamedvr', 'leistung', 'Aufnahme im Hintergrund', 'good', 'Aus', 'Windows nimmt im Hintergrund nichts auf.', { links });
}

function evalHags(graphics) {
  const mode = regNum(graphics, 'HwSchMode');
  const links = [settingsLink('ms-settings:display-advancedgraphics', 'Grafikeinstellungen öffnen')];
  const note = 'HELIX ändert das nicht selbst, weil es Administrator-Rechte braucht.';
  const title = 'Hardwarebeschleunigte GPU-Planung';
  if (mode === 2) return item('hags', 'leistung', title, 'good', 'An', 'Die Grafikkarte verteilt ihre Arbeit selbst. Das kann Verzögerungen etwas senken.', { links });
  if (mode === 1) {
    return item('hags', 'leistung', title, 'hint', 'Aus',
      'Bei neueren Grafikkarten kann es helfen, wenn die Grafikkarte ihre Arbeit selbst verteilt. Umschalten geht in den Windows-Einstellungen und braucht einen Neustart.', { links, note });
  }
  return item('hags', 'leistung', title, 'hint', 'Nicht festgelegt',
    'Windows entscheidet selbst – oder deine Grafikkarte kann das nicht. In den Grafikeinstellungen siehst du, ob es den Schalter gibt.', { links, note });
}

function evalPower(power, battery) {
  const links = [settingsLink('ms-settings:powersleep', 'Energie-Einstellungen')];
  const title = 'Energieplan';
  if (!power || !power.active) {
    return item('power', 'leistung', title, 'hint', 'Unbekannt', 'Windows hat den aktiven Energieplan nicht verraten.', { links });
  }
  const info = planInfo(power.active.guid, power.active.name);
  const list = Array.isArray(power.list) ? power.list : [];
  const hasHigh = list.some((p) => p.guid === HIGH_PERFORMANCE);
  const confirm = `Windows nutzt dann den Plan „Höchstleistung“. Der Prozessor bleibt immer auf Tempo und braucht mehr Strom.${battery ? ' Am Akku hält der Laptop damit kürzer durch.' : ''} Mit „Rückgängig“ kommt „${info.name}“ zurück.`;
  const fix = hasHigh ? { label: 'Höchstleistung einschalten', safe: false, confirm } : null;
  const noHigh = hasHigh ? null : 'Den Plan „Höchstleistung“ gibt es auf diesem PC nicht (typisch für neuere Laptops). Stelle stattdessen in den Windows-Einstellungen den Energiemodus auf „Beste Leistung“.';
  if (info.kind === 'high' || info.kind === 'ultimate') {
    return item('power', 'leistung', title, 'good', info.name, 'Der Prozessor darf immer volle Leistung geben.', { links });
  }
  if (info.kind === 'saver') {
    return item('power', 'leistung', title, 'change', info.name,
      'Der Energiesparmodus bremst den Prozessor – Fortnite läuft dann langsamer. Mindestens „Ausbalanciert“ wird empfohlen.', { links, fix, note: noHigh });
  }
  if (info.kind === 'balanced') {
    return item('power', 'leistung', title, 'hint', info.name,
      'Für die meisten PCs gut. „Höchstleistung“ hält den Prozessor immer auf Tempo – das kann ein paar FPS bringen, braucht aber mehr Strom.', { links, fix, note: noHigh });
  }
  return item('power', 'leistung', title, 'hint', info.name,
    'Ein eigener Plan, oft vom PC-Hersteller. HELIX kennt ihn nicht genau – meistens passt das.', { links, fix, note: noHigh });
}

function evalDisk(d) {
  const who = d.windows && d.fortnite ? 'Windows und Fortnite' : d.fortnite ? 'Fortnite' : 'Windows';
  const title = `Freier Speicher (${d.drive}, ${who})`;
  const links = [settingsLink('ms-settings:storagesense', 'Speicher-Einstellungen'), toolLink('cache', 'Zum Cache-Cleaner')];
  const id = `disk-${d.drive.replace(':', '').toLowerCase()}`;
  if (!Number.isFinite(d.free) || !Number.isFinite(d.total) || d.total <= 0) {
    return item(id, 'system', title, 'hint', 'Unbekannt', 'Der freie Platz konnte nicht gelesen werden.', { links });
  }
  const value = `${fmtGB(d.free)} GB frei von ${fmtGB(d.total)} GB`;
  const gb = d.free / GB;
  if (gb < 15) {
    return item(id, 'system', title, 'change', value,
      'Sehr wenig Platz. Fortnite-Updates können scheitern und Windows wird langsamer. Lösche alte Programme oder leere Zwischenspeicher.', { links });
  }
  if (gb < 40) return item(id, 'system', title, 'hint', value, 'Es wird eng. Für große Fortnite-Updates sind 40 GB oder mehr frei gut.', { links });
  return item(id, 'system', title, 'good', value, 'Genug Platz für Updates.', { links });
}

function evalWindows(win) {
  const links = [settingsLink('ms-settings:windowsupdate', 'Windows Update öffnen')];
  if (!win) return item('windows', 'system', 'Windows-Version', 'hint', 'Unbekannt', 'Die Windows-Version konnte nicht gelesen werden.', { links });
  if (!win.win11) {
    return item('windows', 'system', 'Windows-Version', 'hint', win.label,
      'Windows 10 bekommt keine normalen Sicherheits-Updates mehr. Fortnite läuft noch – ein Wechsel auf Windows 11 ist aber sicherer.', { links });
  }
  if (win.build < 26100) {
    return item('windows', 'system', 'Windows-Version', 'hint', win.label,
      'Eine ältere Windows-11-Version. Windows Update bringt dich auf den neuesten Stand – mit aktuellen Verbesserungen für Spiele und Sicherheit.', { links });
  }
  return item('windows', 'system', 'Windows-Version', 'good', win.label, 'Eine aktuelle Windows-11-Version.', { links });
}

function evalMouse(mouse) {
  const v = regStr(mouse, 'MouseSpeed');
  const on = v == null ? true : v !== '0';
  const links = [toolLink('maus', 'Zum Maus-Check')];
  if (!on) return item('mouse', 'ruhe', 'Zeigerbeschleunigung', 'good', 'Aus', 'Die Maus bewegt sich immer gleich weit – gut fürs Muskelgedächtnis.', { links });
  return item('mouse', 'ruhe', 'Zeigerbeschleunigung', 'hint', 'An',
    'Zeigerbeschleunigung (schnelle Bewegungen schieben den Zeiger weiter) wirkt vor allem im Menü und auf dem Desktop. Beim Zielen liest Fortnite die Maus direkt. Ausschalten kannst du im Maus-Check.', { links });
}

function tipNotifications(win11) {
  if (win11 === false) {
    return item('notifications', 'ruhe', 'Fokus-Assistent beim Spielen', 'tip', null,
      'Der Fokus-Assistent blendet Meldungen aus. Unter „Automatische Regeln“ die Regel „Wenn ich ein Spiel spiele“ einschalten.',
      { links: [settingsLink('ms-settings:quiethours', 'Fokus-Assistent öffnen')] });
  }
  return item('notifications', 'ruhe', 'Nicht stören beim Spielen', 'tip', null,
    '„Nicht stören“ blendet Meldungen aus. Unter „Benachrichtigungen“ kannst du es beim Spielen automatisch einschalten lassen.',
    { links: [settingsLink('ms-settings:notifications', 'Benachrichtigungen öffnen')] });
}

function tipVisualEffects(win11) {
  return item('visual', 'ruhe', 'Visuelle Effekte', 'tip', null,
    'Durchsichtige Fenster und Animationen kosten auf schwachen PCs etwas Leistung. Ausschalten macht Windows schlichter – in Fortnite selbst ändert sich kaum etwas.',
    { links: [settingsLink(win11 === false ? 'ms-settings:easeofaccess-display' : 'ms-settings:easeofaccess-visualeffects', 'Visuelle Effekte öffnen')] });
}

/**
 * Bewertet alle Rohdaten. raw:
 * { gameBar, gameConfig, gameDvr, graphics, mouse, nt (reg-Werte oder null), release,
 *   power: { active, list } | null, battery: Zahl | null, disks: [{ drive, free, total, windows, fortnite }] }
 */
function evaluate(raw = {}) {
  const win = windowsInfo(raw.nt, raw.release);
  const items = [
    evalGameMode(raw.gameBar),
    evalGameDvr(raw.gameConfig, raw.gameDvr),
    evalPower(raw.power, raw.battery),
    evalHags(raw.graphics),
    ...(raw.disks || []).map(evalDisk),
    evalWindows(win),
    evalMouse(raw.mouse),
    tipNotifications(win ? win.win11 : null),
    tipVisualEffects(win ? win.win11 : null),
  ];
  return items;
}

function summarize(items) {
  const counts = { good: 0, hint: 0, change: 0, tip: 0 };
  for (const i of items || []) if (i.status in counts) counts[i.status] += 1;
  return { ...counts, open: counts.change, text: summaryText(counts.change) };
}

function summaryText(open) {
  if (!open) return 'Alles bestens';
  return open === 1 ? '1 Empfehlung offen' : `${open} Empfehlungen offen`;
}

/** Punkte, die "Alles Empfohlene anwenden" ändern darf: nur HKCU und nur, wenn "ändern empfohlen". */
function safeFixIds(items) {
  return (items || []).filter((i) => i.status === 'change' && i.fix && i.fix.safe && SAFE_FIXES.includes(i.id)).map((i) => i.id);
}

// ---------------------------------------------------------------- Ändern und Rückgängig

/** Welche HKCU-Werte ein Fix schreibt. Leere Liste = schon erledigt. */
function fixWrites(id, raw = {}) {
  const w = [];
  const need = (values, key, name, want) => {
    if (effective(values, name) !== want) w.push({ key, name, type: 'REG_DWORD', value: want });
  };
  if (id === 'gamemode') {
    need(raw.gameBar, KEYS.gameBar, 'AutoGameModeEnabled', 1);
    // älterer Wert: nur anpassen, wenn er vorhanden und aus ist
    if (regNum(raw.gameBar, 'AllowAutoGameMode') === 0) w.push({ key: KEYS.gameBar, name: 'AllowAutoGameMode', type: 'REG_DWORD', value: 1 });
  } else if (id === 'gamedvr') {
    need(raw.gameDvr, KEYS.gameDvr, 'HistoricalCaptureEnabled', 0);
    need(raw.gameDvr, KEYS.gameDvr, 'AppCaptureEnabled', 0);
    need(raw.gameConfig, KEYS.gameConfig, 'GameDVR_Enabled', 0);
  }
  return w.filter((x) => isHkcu(x.key));
}

function valuesFor(raw, key) {
  if (key === KEYS.gameBar) return raw.gameBar;
  if (key === KEYS.gameDvr) return raw.gameDvr;
  if (key === KEYS.gameConfig) return raw.gameConfig;
  return null;
}

/** Merkt sich die alten Werte vor dem Schreiben. */
function buildUndo(writes, raw = {}) {
  return writes.map((w) => {
    const prev = valuesFor(raw, w.key)?.[w.name];
    return prev
      ? { key: w.key, name: w.name, existed: true, type: prev.type, value: prev.value }
      : { key: w.key, name: w.name, existed: false, type: 'REG_DWORD', value: null };
  });
}

/** Schreibvorgänge zum Rückgängigmachen. Fehlte ein Wert vorher, wird der Windows-Standard geschrieben. */
function undoWrites(values) {
  const out = [];
  for (const u of values || []) {
    if (!u || !isHkcu(u.key) || !(u.name in DEFAULTS)) continue;
    if (u.existed && (u.type === 'REG_DWORD' || u.type === 'REG_SZ') && u.value != null) out.push({ key: u.key, name: u.name, type: u.type, value: u.value });
    else out.push({ key: u.key, name: u.name, type: 'REG_DWORD', value: DEFAULTS[u.name] });
  }
  return out;
}

const FIX_MESSAGES = {
  gamemode: 'Spielmodus ist an. Er wirkt ab dem nächsten Fortnite-Start.',
  gamedvr: 'Aufnahme im Hintergrund ist aus. Das wirkt ab dem nächsten Fortnite-Start.',
  power: 'Energieplan „Höchstleistung“ ist jetzt aktiv.',
};
const UNDO_MESSAGES = {
  gamemode: 'Spielmodus ist wieder wie vorher.',
  gamedvr: 'Die Aufnahme-Einstellungen sind wieder wie vorher.',
  power: 'Der vorherige Energieplan ist wieder aktiv.',
};
const UNDO_LABELS = {
  gamemode: 'Von HELIX eingeschaltet',
  gamedvr: 'Von HELIX ausgeschaltet',
  power: 'Von HELIX umgestellt',
};

module.exports = {
  KEYS,
  DEFAULTS,
  PLANS,
  HIGH_PERFORMANCE,
  GROUPS,
  SAFE_FIXES,
  FIX_IDS,
  FIX_MESSAGES,
  UNDO_MESSAGES,
  UNDO_LABELS,
  isGuid,
  isHkcu,
  decodeConsole,
  parsePowercfgActive,
  parsePowercfgList,
  planInfo,
  regNum,
  regStr,
  effective,
  parseLauncherInstalled,
  driveOf,
  windowsInfo,
  evaluate,
  summarize,
  summaryText,
  safeFixIds,
  fixWrites,
  buildUndo,
  undoWrites,
};
