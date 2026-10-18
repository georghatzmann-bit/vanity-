'use strict';
// Maus-Check: reine Logik ohne Windows-Aufrufe (Parser, Bewertung, PowerShell-Skript, Prüfungen).
// Quelle der Fakten: Recherche "windows-gaming" Abschnitt 1 (HKCU\Control Panel\Mouse, SystemParametersInfo).
//
//   MouseSensitivity  Zeigergeschwindigkeit 1–20, Standard 10 (= Stufe 6 von 11, Faktor 1,0)
//   MouseSpeed / MouseThreshold1 / MouseThreshold2
//                     „Zeigerbeschleunigung verbessern“: an = 1/6/10, aus = 0/0/0 (REG_SZ)
//   SPI_SETMOUSE (0x0004) erwartet int[3] = {Threshold1, Threshold2, Beschleunigung} – andere Reihenfolge als die Registry!
//   SPI_SETMOUSESPEED (0x0071) bekommt den Wert selbst (nicht als Zeiger), 1–20.
//   Flags SPIF_UPDATEINIFILE | SPIF_SENDCHANGE = 3: sofort wirksam, ohne Administrator.

const MOUSE_KEY = 'HKCU\\Control Panel\\Mouse';
const NAMES = ['MouseSensitivity', 'MouseSpeed', 'MouseThreshold1', 'MouseThreshold2'];
const WIN_DEFAULTS = { MouseSensitivity: 10, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 };
const RECOMMENDED_SPEED = 10;
const ACCEL_OFF = { MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 };
const SPI = { GETMOUSE: 0x0003, SETMOUSE: 0x0004, GETMOUSESPEED: 0x0070, SETMOUSESPEED: 0x0071, FLAGS: 3 };

// Ungefährer Faktor je Wert bei ausgeschalteter Beschleunigung (6/11 = 1,0 ist sicher, die hohen Stufen sind nicht bestätigt).
const SPEED_FACTOR = [null, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5];

const RANGES = { MouseSensitivity: [1, 20], MouseSpeed: [0, 2], MouseThreshold1: [0, 100], MouseThreshold2: [0, 100] };

const FORTNITE = {
  file: 'GameUserSettings.ini',
  section: '/Script/FortniteGame.FortGameUserSettings',
  key: 'bDisableMouseAcceleration',
};

function toInt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

/** Werte aus readKey() ({name:{type,value}}) -> {MouseSensitivity: 10, ...}; fehlende oder kaputte Werte = null. */
function parseMouseValues(reg) {
  const out = {};
  for (const n of NAMES) {
    const entry = reg && Object.prototype.hasOwnProperty.call(reg, n) ? reg[n] : null;
    out[n] = toInt(entry && typeof entry === 'object' ? entry.value : entry);
  }
  return out;
}

/** Fehlende Werte mit dem Windows-Standard auffüllen (so verhält sich Windows auch). */
function withDefaults(values) {
  const out = {};
  for (const n of NAMES) out[n] = values && Number.isInteger(values[n]) ? values[n] : WIN_DEFAULTS[n];
  return out;
}

/** Stufe im Windows-Schieberegler (11 Stufen). 1 -> 1/11, 2 -> 2/11, 4 -> 3/11 … 10 -> 6/11 … 20 -> 11/11. */
function notchInfo(sens) {
  if (!Number.isInteger(sens) || sens < 1 || sens > 20) return { notch: null, exact: false, label: 'unbekannt' };
  if (sens === 1) return { notch: 1, exact: true, label: '1/11' };
  if (sens % 2 === 0) {
    const n = sens / 2 + 1;
    return { notch: n, exact: true, label: `${n}/11` };
  }
  const lo = (sens - 1) / 2 + 1;
  return { notch: lo + 0.5, exact: false, label: `zwischen ${lo}/11 und ${lo + 1}/11` };
}

function speedFactor(sens) {
  return Number.isInteger(sens) && sens >= 1 && sens <= 20 ? SPEED_FACTOR[sens] : null;
}

function accelOn(values) {
  const v = withDefaults(values);
  return v.MouseSpeed > 0;
}

/** Bewertet die Windows-Werte. */
function evaluate(values) {
  const raw = values || {};
  const v = withDefaults(raw);
  const n = notchInfo(v.MouseSensitivity);
  const on = accelOn(raw);
  const speed = {
    value: v.MouseSensitivity,
    missing: raw.MouseSensitivity == null,
    ...n,
    factor: speedFactor(v.MouseSensitivity),
    ok: v.MouseSensitivity === RECOMMENDED_SPEED,
  };
  const accel = {
    on,
    mouseSpeed: v.MouseSpeed,
    threshold1: v.MouseThreshold1,
    threshold2: v.MouseThreshold2,
    ok: !on,
  };
  return { values: v, speed, accel, allOk: speed.ok && accel.ok };
}

/**
 * Plant die Korrektur. parts: {speed, accel} (beide Standard true).
 * Gibt Zielwerte (alle vier) und nur die tatsächlich geänderten Einträge zurück.
 */
function planFix(values, { speed = true, accel = true } = {}) {
  const cur = withDefaults(values);
  const target = { ...cur };
  if (speed) target.MouseSensitivity = RECOMMENDED_SPEED;
  if (accel) Object.assign(target, ACCEL_OFF);
  const changes = NAMES
    .filter((n) => target[n] !== (values ? values[n] : null))
    .filter((n) => (speed && n === 'MouseSensitivity') || (accel && n !== 'MouseSensitivity'))
    .map((n) => ({ name: n, from: values ? values[n] ?? null : null, to: target[n] }));
  return { target, changes };
}

/**
 * Rückgängig-Eintrag für eine neue Korrektur.
 * Steht noch eine frühere HELIX-Änderung unverändert da (z. B. erst Geschwindigkeit, dann Beschleunigung),
 * bleibt der ursprüngliche Vorher-Stand erhalten – „Rückgängig“ führt dann ganz zum Zustand vor HELIX zurück.
 */
function nextUndo(prev, current, plan, at) {
  const chained = prev && validValues(prev.before) && Array.isArray(prev.changes) && prev.changes.length
    && prev.changes.every((c) => NAMES.includes(c.name) && current[c.name] === c.to);
  if (!chained) return { at, before: { ...current }, changes: plan.changes };
  const byName = new Map(prev.changes.map((c) => [c.name, { ...c }]));
  for (const c of plan.changes) {
    const old = byName.get(c.name);
    byName.set(c.name, { name: c.name, from: old ? old.from : prev.before[c.name] ?? null, to: c.to });
  }
  const changes = NAMES.filter((n) => byName.has(n)).map((n) => byName.get(n)).filter((c) => c.from !== c.to);
  return { at, before: { ...prev.before }, changes };
}

function validValues(v) {
  if (!v || typeof v !== 'object') return false;
  return NAMES.every((n) => {
    const x = v[n];
    if (x === null || x === undefined) return true;
    const [a, b] = RANGES[n];
    return Number.isInteger(x) && x >= a && x <= b;
  });
}

function assertValues(v) {
  for (const n of NAMES) {
    const x = v[n];
    const [a, b] = RANGES[n];
    if (!Number.isInteger(x) || x < a || x > b) throw new RangeError(`${n} ungültig: ${x}`);
  }
}

/**
 * PowerShell-Skript, das die Werte sofort wirksam macht (SystemParametersInfo, user32).
 * Es enthält nur geprüfte ganze Zahlen – keine Texte von außen.
 * Ausgabe: eine JSON-Zeile mit Erfolg und den danach gelesenen Werten.
 */
function spiScript(target) {
  const v = {};
  for (const n of NAMES) v[n] = target && target[n] != null ? target[n] : WIN_DEFAULTS[n];
  assertValues(v); // nur ganze Zahlen im erlaubten Bereich, sonst RangeError
  const hex = (n) => `0x${n.toString(16).padStart(4, '0')}`;
  return [
    '',
    "Add-Type -Namespace HelixMaus -Name Spi -MemberDefinition @'",
    '[DllImport("user32.dll", SetLastError=true)]',
    'public static extern bool SystemParametersInfo(uint a, uint u, int[] p, uint f);',
    '[DllImport("user32.dll", SetLastError=true, EntryPoint="SystemParametersInfo")]',
    'public static extern bool SystemParametersInfoPtr(uint a, uint u, IntPtr p, uint f);',
    '[DllImport("user32.dll", SetLastError=true, EntryPoint="SystemParametersInfo")]',
    'public static extern bool SystemParametersInfoRef(uint a, uint u, ref int p, uint f);',
    "'@",
    `$F = ${SPI.FLAGS}`,
    // Reihenfolge für SPI_SETMOUSE: {Threshold1, Threshold2, Beschleunigung}
    `$a = [HelixMaus.Spi]::SystemParametersInfo(${hex(SPI.SETMOUSE)}, 0, [int[]](${v.MouseThreshold1},${v.MouseThreshold2},${v.MouseSpeed}), $F)`,
    `$b = [HelixMaus.Spi]::SystemParametersInfoPtr(${hex(SPI.SETMOUSESPEED)}, 0, [IntPtr]${v.MouseSensitivity}, $F)`,
    '$m = New-Object int[] 3',
    `[void][HelixMaus.Spi]::SystemParametersInfo(${hex(SPI.GETMOUSE)}, 0, $m, 0)`,
    '$s = 0',
    `[void][HelixMaus.Spi]::SystemParametersInfoRef(${hex(SPI.GETMOUSESPEED)}, 0, [ref]$s, 0)`,
    '[pscustomobject]@{ setMouse = [bool]$a; setSpeed = [bool]$b; threshold1 = [int]$m[0]; threshold2 = [int]$m[1]; accel = [int]$m[2]; speed = [int]$s } | ConvertTo-Json -Compress',
    '',
  ].join('\r\n');
}

/** Wertet die JSON-Antwort von spiScript() aus und prüft, ob Windows die Zielwerte übernommen hat. */
function parseSpiResult(obj, target) {
  if (!obj || typeof obj !== 'object') return { live: false, reason: 'keine Antwort' };
  const v = withDefaults(target);
  const read = {
    MouseSensitivity: toInt(obj.speed),
    MouseSpeed: toInt(obj.accel),
    MouseThreshold1: toInt(obj.threshold1),
    MouseThreshold2: toInt(obj.threshold2),
  };
  const calls = obj.setMouse === true && obj.setSpeed === true;
  const matches = NAMES.every((n) => read[n] === v[n]);
  return { live: calls && matches, calls, matches, read };
}

// ---------------------------------------------------------------- Fortnite

/** Fortnite-Wert lesen ('True'/'False'/fehlt). */
function fortniteAccelInfo(raw) {
  if (raw == null || String(raw).trim() === '') return { value: null, disabled: null, ok: null };
  const s = String(raw).trim();
  const disabled = /^true$/i.test(s) ? true : /^false$/i.test(s) ? false : null;
  return { value: s, disabled, ok: disabled === null ? null : disabled };
}

function fortniteChange(disable = true) {
  return [{ section: FORTNITE.section, key: FORTNITE.key, value: disable ? 'True' : 'False' }];
}

// ---------------------------------------------------------------- Messergebnisse

const POLL_CLASSES = ['low', '125', '250', '500', '1000', '2000+'];

function num(v, a, b) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= a && n <= b ? n : null;
}

/** Prüft ein Testergebnis aus der Oberfläche. Gibt ein sauberes Objekt zurück oder null. */
function sanitizeTest(kind, d) {
  if (!d || typeof d !== 'object') return null;
  if (kind === 'polling') {
    const hz = num(d.hz, 1, 20000);
    const medianMs = num(d.medianMs, 0, 1000);
    const samples = num(d.samples, 10, 1e7);
    const durationMs = num(d.durationMs, 500, 600000);
    const cls = POLL_CLASSES.includes(d.cls) ? d.cls : null;
    if (hz === null || medianMs === null || samples === null || durationMs === null || !cls) return null;
    return { hz: Math.round(hz), medianMs: Math.round(medianMs * 1000) / 1000, samples: Math.round(samples), durationMs: Math.round(durationMs), cls, stable: d.stable !== false };
  }
  if (kind === 'dpi') {
    const dpi = num(d.dpi, 50, 64000);
    const cm = num(d.cm, 1, 50);
    const runs = Array.isArray(d.runs) ? d.runs.map((x) => num(x, 1, 1e7)) : [];
    if (dpi === null || cm === null || !runs.length || runs.length > 10 || runs.some((x) => x === null)) return null;
    const nearest = num(d.nearest, 50, 64000);
    return { dpi: Math.round(dpi), cm: Math.round(cm * 100) / 100, runs: runs.map((x) => Math.round(x)), nearest: nearest === null ? null : Math.round(nearest), raw: d.raw !== false };
  }
  return null;
}

function pushCapped(list, item, max = 50) {
  const out = Array.isArray(list) ? list.slice() : [];
  out.push(item);
  return out.length > max ? out.slice(out.length - max) : out;
}

const POLL_LABEL = { low: 'unter 125 Hz', 125: '125 Hz', 250: '250 Hz', 500: '500 Hz', 1000: '1000 Hz', '2000+': 'über 1000 Hz' };

/** Kurzer Text fürs Cockpit. ev = evaluate(...) oder null; lastPoll = letztes Abfrageraten-Ergebnis oder null. */
function summaryText(ev, lastPoll) {
  const poll = lastPoll && POLL_LABEL[lastPoll.cls] ? POLL_LABEL[lastPoll.cls] : null;
  if (!ev) return poll ? `Abfragerate: ${poll}` : null;
  let t;
  if (ev.allOk) t = `Maus passt: Zeiger ${ev.speed.label}, Beschleunigung aus`;
  else if (!ev.accel.ok) t = 'Zeigerbeschleunigung ist an – empfohlen: aus';
  else t = `Zeiger ${ev.speed.label} – empfohlen: 6/11`;
  return poll ? `${t} · ${poll}` : t;
}

module.exports = {
  MOUSE_KEY, NAMES, WIN_DEFAULTS, RECOMMENDED_SPEED, ACCEL_OFF, SPI, FORTNITE, POLL_CLASSES,
  toInt, parseMouseValues, withDefaults, notchInfo, speedFactor, accelOn, evaluate, planFix, nextUndo,
  validValues, spiScript, parseSpiResult, fortniteAccelInfo, fortniteChange, sanitizeTest, pushCapped, summaryText,
};
