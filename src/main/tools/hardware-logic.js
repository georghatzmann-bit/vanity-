'use strict';
// Hardware-Überblick: reine Funktionen ohne Windows-Aufrufe (für Tests austauschbar).
// - Zerlegt die JSON-Zeilen des Mess-Skripts (CIM-Leistungsdaten, nvidia-smi, Get-Process)
// - rechnet Prozessor-Last aus os.cpus()-Zeiten (Ersatz für alle Systeme)
// - fasst eine Fortnite-Runde zu Durchschnitt und Höchstwerten zusammen
//
// Alles ist nur lesend. Es wird nichts im Spiel gelesen oder verändert.

const HISTORY_MAX = 60; // 2 Minuten bei einer Messung alle 2 Sekunden
const SESSIONS_MAX = 100;
const SESSION_MIN_SEC = 60;
const SESSION_MIN_SAMPLES = 10;
const PS_FRESH_MS = 6000;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ---------------------------------------------------------------- Prozessor (Node, alle Systeme)

/** Summe der Zeiten aller Kerne aus os.cpus(). */
function cpuTimes(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of toArray(cpus)) {
    const t = c && c.times;
    if (!t) continue;
    const sum = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    idle += t.idle || 0;
    total += sum;
  }
  return total > 0 ? { idle, total, count: toArray(cpus).length } : null;
}

/** Prozessor-Last in % zwischen zwei Messungen von cpuTimes(). */
function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (!(dt > 0) || di < 0) return null;
  return round1(clamp(100 * (1 - di / dt), 0, 100));
}

// ---------------------------------------------------------------- Grafikkarte

/**
 * Zerlegt die Ausgabe von
 *   nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.gr --format=csv,noheader,nounits
 * Eine Zeile pro Grafikkarte. "[N/A]" / "[Not Supported]" werden zu null.
 */
function parseNvidiaSmi(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    const cols = line.split(',').map((s) => s.trim());
    if (cols.length < 6) continue; // z. B. Fehlermeldung von nvidia-smi
    const val = (s) => (/^\[|^n\/a$|not supported|unknown|err/i.test(s) ? null : num(s));
    const [tempC, utilPct, memUsedMiB, memTotalMiB, powerW, clockMHz] = cols.slice(0, 6).map(val);
    if ([tempC, utilPct, memUsedMiB, memTotalMiB].every((v) => v == null)) continue;
    out.push({
      tempC: tempC != null && tempC > 0 && tempC < 130 ? tempC : null,
      utilPct: utilPct != null ? clamp(utilPct, 0, 100) : null,
      memUsedMiB,
      memTotalMiB,
      powerW: powerW != null ? round1(powerW) : null,
      clockMHz,
    });
  }
  return out;
}

/** "pid_1234_luid_0x00000000_0x0000D1A3_phys_0_eng_0_engtype_3D" -> "0x00000000_0x0000d1a3" */
function luidOf(name) {
  const m = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Auslastung der 3D-Einheit: Summe aller "engtype_3D"-Einträge je Grafikkarte (LUID),
 * die am stärksten belastete Karte zählt (wie im Task-Manager), höchstens 100 %.
 * entries = null -> Windows liefert diese Daten nicht.
 */
function gpuEngineLoad(entries) {
  if (entries == null) return null;
  const per = new Map();
  for (const e of toArray(entries)) {
    if (!e || !/engtype_3D$/i.test(String(e.n || e.Name || ''))) continue;
    const u = num(e.u ?? e.UtilizationPercentage);
    if (u == null || u < 0) continue;
    const key = luidOf(e.n || e.Name) || 'gpu';
    per.set(key, (per.get(key) || 0) + u);
  }
  let best = null;
  for (const [luid, sum] of per) {
    if (!best || sum > best.pct) best = { luid, pct: sum };
  }
  if (!best) return { luid: null, pct: 0 };
  return { luid: best.luid, pct: round1(clamp(best.pct, 0, 100)) };
}

/** Belegter Grafikspeicher: Grafikkarte mit der größten "DedicatedUsage". */
function adapterMemory(entries) {
  if (entries == null) return null;
  let best = null;
  for (const e of toArray(entries)) {
    const d = num(e && (e.d ?? e.DedicatedUsage));
    if (d == null || d < 0) continue;
    if (!best || d > best.usedBytes) best = { luid: luidOf(e.n || e.Name), usedBytes: d };
  }
  return best;
}

/** Kelvin-Werte der Windows-Wärmezonen (ACPI) in °C. Unplausible Werte fallen weg. */
function thermalZones(entries) {
  if (entries == null) return null;
  const out = [];
  for (const e of toArray(entries)) {
    if (!e) continue;
    const hp = num(e.hp ?? e.HighPrecisionTemperature);
    const t = num(e.t ?? e.Temperature);
    let c = null;
    if (hp != null && hp > 0) c = hp / 10 - 273.15;
    else if (t != null && t > 0) c = t - 273.15;
    if (c == null || c < 1 || c > 125) continue;
    const name = String(e.n || e.Name || '').replace(/^\\+/, '') || 'Zone';
    out.push({ name, tempC: round1(c) });
  }
  return out;
}

/** Hersteller der (stärksten) Grafikkarte aus den Namen von Win32_VideoController. */
function detectVendor(names) {
  const list = toArray(names).map((n) => String(n || ''));
  const has = (re) => list.some((n) => re.test(n));
  if (has(/nvidia|geforce|quadro|\brtx\b|\bgtx\b/i)) return 'nvidia';
  if (has(/\bamd\b|radeon|\bati\b/i)) return 'amd';
  if (has(/intel|\barc\b|iris|uhd graphics|hd graphics/i)) return 'intel';
  return list.length ? 'other' : null;
}

// ---------------------------------------------------------------- Eine Messung bauen

/**
 * Baut aus der letzten Skript-Zeile (ps, darf fehlen) und den Node-Werten eine Messung.
 * state: { prevCpu, prevFn } wird fortgeschrieben (für Prozent-Werte zwischen zwei Messungen).
 */
function buildSample({ ps, node, now, state, logical }) {
  const st = state || {};
  const cpuNow = node ? cpuTimes(node.cpus) : null;
  const nodeCpu = cpuPercent(st.prevCpu, cpuNow);
  if (cpuNow) st.prevCpu = cpuNow;

  const s = {
    at: now,
    psFresh: !!ps,
    cpuPct: null,
    cpuSource: null,
    ramUsed: null,
    ramTotal: null,
    gpuPct: null,
    gpuSource: null,
    gpuTemp: null,
    vramUsed: null,
    vramTotal: null,
    gpuPower: null,
    gpuClock: null,
    boardTemp: null,
    zones: [],
    fnRunning: null,
    fnRam: null,
    fnCpuPct: null,
  };

  // Prozessor: Windows-Leistungsdaten, sonst Node
  const psCpu = ps ? num(ps.cpu) : null;
  if (psCpu != null) { s.cpuPct = round1(clamp(psCpu, 0, 100)); s.cpuSource = 'windows'; } else if (nodeCpu != null) { s.cpuPct = nodeCpu; s.cpuSource = 'node'; }

  // Arbeitsspeicher (Node, überall)
  const total = node ? num(node.totalmem) : null;
  const free = node ? num(node.freemem) : null;
  if (total && free != null) { s.ramTotal = total; s.ramUsed = Math.max(0, total - free); }

  if (ps) {
    const nv = parseNvidiaSmi(toArray(ps.nv))[0] || null;
    const eng = gpuEngineLoad(ps.eng);
    const mem = adapterMemory(ps.mem);
    const vt = toArray(ps.vt).map(num).filter((v) => v && v > 0);
    if (nv && nv.utilPct != null) { s.gpuPct = nv.utilPct; s.gpuSource = 'nvidia'; } else if (eng) { s.gpuPct = eng.pct; s.gpuSource = 'windows'; }
    if (nv && nv.tempC != null) s.gpuTemp = nv.tempC;
    if (nv && nv.memUsedMiB != null && nv.memTotalMiB) {
      s.vramUsed = nv.memUsedMiB * 1024 * 1024;
      s.vramTotal = nv.memTotalMiB * 1024 * 1024;
    } else if (mem) {
      s.vramUsed = mem.usedBytes;
      s.vramTotal = vt.length ? Math.max(...vt) : null;
    }
    if (nv) { s.gpuPower = nv.powerW; s.gpuClock = nv.clockMHz; }
    const zones = thermalZones(ps.tz);
    if (zones && zones.length) {
      s.zones = zones;
      s.boardTemp = Math.max(...zones.map((z) => z.tempC));
    }
    // Fortnite: nur Prozess-Statistik (wie im Task-Manager), nichts aus dem Spiel
    if (ps.fn == null) {
      s.fnRunning = false;
      st.prevFn = null;
    } else {
      s.fnRunning = true;
      s.fnRam = num(ps.fn.ws);
      const cpuSec = num(ps.fn.cpu);
      const lp = logical || (cpuNow && cpuNow.count) || 1;
      if (cpuSec != null && cpuSec >= 0 && st.prevFn && now > st.prevFn.at) {
        const d = cpuSec - st.prevFn.cpuSec;
        if (d >= 0) s.fnCpuPct = round1(clamp((d / ((now - st.prevFn.at) / 1000) / lp) * 100, 0, 100));
      }
      st.prevFn = cpuSec != null && cpuSec >= 0 ? { cpuSec, at: now } : null;
    }
  }
  return s;
}

/** Fähigkeiten aus einer Skript-Zeile ablesen (für "nicht verfügbar"-Erklärungen). */
function capsFromPs(ps, prev = {}) {
  if (!ps) return prev;
  return {
    ...prev,
    nvidiaSmi: !!ps.nvp,
    gpuNames: toArray(ps.gpus).map(String).slice(0, 4),
    vendor: detectVendor(ps.gpus),
    gpuLoad: ps.eng != null,
    gpuMemory: ps.mem != null,
    thermal: ps.tz != null && (thermalZones(ps.tz) || []).length > 0,
  };
}

function pushHistory(list, sample, max = HISTORY_MAX) {
  list.push(sample);
  while (list.length > max) list.shift();
  return list;
}

// ---------------------------------------------------------------- Zusammenfassung pro Runde

const AGG_KEYS = ['cpuPct', 'gpuPct', 'gpuTemp', 'boardTemp', 'ramPct', 'vramPct', 'fnCpuPct', 'fnRam'];

function newAggregate(startedAt) {
  const acc = {};
  for (const k of AGG_KEYS) acc[k] = { sum: 0, n: 0, max: null };
  return { startedAt, lastAt: startedAt, samples: 0, acc };
}

/** Nimmt eine Messung in die laufende Zusammenfassung auf (nur vorhandene Werte zählen). */
function addToAggregate(agg, s) {
  if (!agg || !s) return agg;
  const vals = {
    cpuPct: s.cpuPct,
    gpuPct: s.gpuPct,
    gpuTemp: s.gpuTemp,
    boardTemp: s.boardTemp,
    ramPct: s.ramTotal ? (100 * s.ramUsed) / s.ramTotal : null,
    vramPct: s.vramTotal && s.vramUsed != null ? (100 * s.vramUsed) / s.vramTotal : null,
    fnCpuPct: s.fnCpuPct,
    fnRam: s.fnRam,
  };
  for (const k of AGG_KEYS) {
    const v = num(vals[k]);
    if (v == null) continue;
    const a = agg.acc[k] || (agg.acc[k] = { sum: 0, n: 0, max: null });
    a.sum += v;
    a.n += 1;
    a.max = a.max == null ? v : Math.max(a.max, v);
  }
  agg.samples += 1;
  if (num(s.at) != null) agg.lastAt = s.at;
  return agg;
}

/** Schließt die Zusammenfassung ab. Zu kurze Runden (unter 1 Minute) ergeben null. */
function finishAggregate(agg, endedAt) {
  if (!agg) return null;
  const end = num(endedAt) ?? agg.lastAt;
  const durationSec = Math.round((end - agg.startedAt) / 1000);
  if (durationSec < SESSION_MIN_SEC || agg.samples < SESSION_MIN_SAMPLES) return null;
  const pick = (k, digits = 1) => {
    const a = agg.acc[k];
    if (!a || !a.n) return null;
    const f = 10 ** digits;
    return { avg: Math.round((a.sum / a.n) * f) / f, max: Math.round(a.max * f) / f };
  };
  const fnRam = agg.acc.fnRam && agg.acc.fnRam.n ? Math.round(agg.acc.fnRam.max) : null;
  return {
    startedAt: agg.startedAt,
    endedAt: end,
    durationSec,
    samples: agg.samples,
    cpu: pick('cpuPct'),
    gpu: pick('gpuPct'),
    gpuTemp: pick('gpuTemp'),
    boardTemp: pick('boardTemp'),
    ram: pick('ramPct'),
    vram: pick('vramPct'),
    fnCpu: pick('fnCpuPct'),
    fnRamMax: fnRam,
  };
}

function pushSession(list, session, max = SESSIONS_MAX) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (session) out.push(session);
  while (out.length > max) out.shift();
  return out;
}

/** Zeile fürs Cockpit: letzte bekannte Grafikkarten-Temperatur. */
function summaryText(last) {
  const c = last && num(last.gpuTemp);
  if (c == null) return null;
  return `Grafikkarte zuletzt ${Math.round(c)} °C`;
}

function isFresh(at, now, ms = PS_FRESH_MS) {
  return num(at) != null && now - at <= ms;
}

module.exports = {
  HISTORY_MAX,
  SESSIONS_MAX,
  SESSION_MIN_SEC,
  PS_FRESH_MS,
  cpuTimes,
  cpuPercent,
  parseNvidiaSmi,
  luidOf,
  gpuEngineLoad,
  adapterMemory,
  thermalZones,
  detectVendor,
  buildSample,
  capsFromPs,
  pushHistory,
  newAggregate,
  addToAggregate,
  finishAggregate,
  pushSession,
  summaryText,
  isFresh,
};
