// Session-Statistik: reine Hilfsfunktionen für Diagramme und Texte (ohne DOM).
// Wird von der Ansicht und von den Unit-Tests benutzt.

const pad = (n) => String(n).padStart(2, '0');
const WD_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WD_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** Zahl mit deutschem Komma: 6.5 -> "6,5". decimals = feste Nachkommastellen (0 = ganze Zahl). */
export function fmtNum(v, decimals = 1, { trim = true } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  let s = v.toFixed(decimals);
  if (trim && decimals > 0) s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s.replace('.', ',');
}

/** Sensi mit mindestens einer Nachkommastelle wie in Fortnite: 7 -> "7,0", 6.25 -> "6,25". */
export function fmtSens(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  let s = v.toFixed(2);
  if (s.endsWith('0')) s = s.slice(0, -1);
  return s.replace('.', ',');
}

/** "6 Std. 20 Min.", "20 Min.", "45 Sek.", "0 Min." */
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (hh) return mm ? `${hh} Std. ${mm} Min.` : `${hh} Std.`;
  if (mm) return `${mm} Min.`;
  return s ? `${s} Sek.` : '0 Min.';
}

/** Wie fmtDur, aber ohne Zeilenumbruch mitten in der Zeitangabe (geschützte Leerzeichen). */
export function fmtDurNb(sec) {
  return fmtDur(sec).replace(/ /g, '\u00a0');
}

/** Kurz für Achsen: "0", "30 Min.", "1 Std.", "1,5 Std." */
export function fmtAxisDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '0';
  if (s < 3600) return `${Math.round(s / 60)} Min.`;
  return `${fmtNum(s / 3600, 1)} Std.`;
}

const STEPS = [300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200, 86400];

/**
 * Schöne Achsen-Einteilung für Zeiten (Sekunden). Rückgabe: { step, max, ticks: [0, step, …, max] }.
 * Ohne Werte geht die Achse bis 1 Std., damit ein leeres Diagramm trotzdem sinnvoll aussieht.
 */
export function niceDurationTicks(maxSeconds, maxTicks = 4) {
  const m = Math.max(0, Number(maxSeconds) || 0);
  if (!m) return { step: 1800, max: 3600, ticks: [0, 1800, 3600] };
  let step = STEPS[STEPS.length - 1];
  for (const s of STEPS) {
    if (Math.ceil(m / s) <= maxTicks) { step = s; break; }
  }
  const count = Math.max(1, Math.ceil(m / step));
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(i * step);
  return { step, max: count * step, ticks };
}

/**
 * Schöner Wertebereich für kleine Diagramme (z. B. Millisekunden).
 * Rundet nach außen auf `unit` und lässt etwas Luft, damit die Linie nicht am Rand klebt.
 */
export function valueRange(values, { unit = 10, minSpan = 20, floor = 0 } = {}) {
  const v = (values || []).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { min: floor, max: floor + minSpan };
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  const padding = Math.max((hi - lo) * 0.15, minSpan / 4);
  lo -= padding;
  hi += padding;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  lo = Math.max(floor, Math.floor(lo / unit) * unit);
  hi = Math.ceil(hi / unit) * unit;
  if (hi <= lo) hi = lo + unit;
  return { min: lo, max: hi };
}

/** Lineare Abbildung d0..d1 -> r0..r1. */
export function scaleLinear(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** SVG-Pfad durch Punkte [{x,y}] ("M x y L x y …"); Lücken (null) beginnen eine neue Linie. */
export function linePath(points) {
  let d = '';
  let pen = false;
  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${round2(p.x)} ${round2(p.y)} `;
    pen = true;
  }
  return d.trim();
}

const round2 = (v) => Math.round(v * 100) / 100;

/** Jede wievielte Beschriftung passt, wenn Elemente `slotPx` breit sind und Texte `minGapPx` brauchen. */
export function labelStep(count, slotPx, minGapPx = 44) {
  if (!count || !(slotPx > 0)) return 1;
  return Math.max(1, Math.ceil(minGapPx / slotPx));
}

/** Indizes mit Beschriftung: vom letzten Element rückwärts jede `step`-te (der neueste Tag hat immer eine). */
export function labelIndices(count, step) {
  const out = [];
  for (let i = count - 1; i >= 0; i -= Math.max(1, step)) out.unshift(i);
  return out;
}

/**
 * Welche Punkte bekommen eine Sensi-Beschriftung?
 * Der erste Punkt, jeder Wechsel des Werts und der letzte Punkt – aber nur mit mindestens `minGap` Pixel Abstand.
 * Ist der letzte Punkt zu nah an der vorherigen Beschriftung und hat einen anderen Wert, ersetzt er sie.
 */
export function pickLabelIndices(values, xs, minGap = 30) {
  const out = [];
  const n = Math.min(values?.length || 0, xs?.length || 0);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    const isLast = i === n - 1;
    if (prev < 0) { out.push(i); prev = i; continue; }
    const far = xs[i] - xs[prev] >= minGap;
    const changed = v !== values[prev];
    if (far && (changed || isLast)) { out.push(i); prev = i; continue; }
    if (isLast && changed && !far) {
      out[out.length - 1] = i;
      prev = i;
    }
  }
  return out;
}

/** Datum aus "2026-10-18" (lokale Zeit) oder Zeitstempel. */
export function toDate(dayOrTs) {
  if (typeof dayOrTs === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayOrTs)) {
    const [y, m, d] = dayOrTs.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(dayOrTs);
}

/**
 * Datumstexte: 'short' "18.10.", 'weekday' "Sa 18.10.", 'long' "Samstag, 18.10.2026",
 * 'date' "18.10.2026", 'time' "14:05".
 */
export function fmtDay(dayOrTs, mode = 'short') {
  const d = toDate(dayOrTs);
  if (Number.isNaN(d.getTime())) return '–';
  const dm = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
  if (mode === 'weekday') return `${WD_SHORT[d.getDay()]} ${dm}`;
  if (mode === 'long') return `${WD_LONG[d.getDay()]}, ${dm}${d.getFullYear()}`;
  if (mode === 'date') return `${dm}${d.getFullYear()}`;
  if (mode === 'time') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return dm;
}

/** "Sa 18.10. · 14:05–16:10" */
export function fmtSpan(start, end) {
  return `${fmtDay(start, 'weekday')} · ${fmtDay(start, 'time')}–${fmtDay(end, 'time')}`;
}

/** Text zum Wochenvergleich, z. B. { text: '1 Std. 10 Min. mehr', type: 'accent' }. */
export function weekBadge(week) {
  if (!week) return null;
  if (week.trend === 'mehr') return { text: `${fmtDur(week.deltaSeconds)} mehr`, type: 'accent' };
  if (week.trend === 'weniger') return { text: `${fmtDur(-week.deltaSeconds)} weniger`, type: '' };
  return { text: 'etwa gleich viel', type: '' };
}

/** Plakette für einen Trend (besser/schlechter/gleich). unit z. B. 'Punkte' oder 'ms'. */
export function trendBadge(trend, { betterText = 'besser', worseText = 'schlechter', sameText = 'gleich' } = {}) {
  if (!trend) return null;
  if (trend.direction === 'besser') return { text: betterText, type: 'ok' };
  if (trend.direction === 'schlechter') return { text: worseText, type: 'warn' };
  return { text: sameText, type: '' };
}

/** "+8 Punkte", "−3 Punkte", "±0 Punkte" */
export function signed(v, unit = '', decimals = 0) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  const r = Number(v.toFixed(decimals));
  const body = fmtNum(Math.abs(r), decimals);
  const sign = r > 0 ? '+' : r < 0 ? '−' : '±';
  return `${sign}${body}${unit ? ` ${unit}` : ''}`;
}

/** Dateiname aus einem Windows- oder Linux-Pfad. */
export function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// ---------------------------------------------------------------- Texte für die Ansicht

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** DPI, für die die empfohlene Sensi gilt. Beim DPI-Vergleich ist das oft eine andere als beim Test. */
export function recDpi(e) {
  if (isNum(e?.recommendedDpi) && e.recommendedDpi > 0) return e.recommendedDpi;
  return isNum(e?.dpi) ? e.dpi : null;
}

/** Empfohlene Sensi: "6,5" – oder "3,3 bei 1600 DPI", wenn die Empfehlung für eine andere DPI gilt als beim Test. */
export function recSensText(e) {
  const d = recDpi(e);
  const other = d != null && isNum(e?.dpi) && d !== e.dpi;
  return `${fmtSens(e?.recommendedSens)}${other ? ` bei ${fmtNum(d, 0)} DPI` : ''}`;
}

/** Hinweis zur aktuellen Empfehlung: DPI, eDPI und Mausweg – alles für die empfohlene Einstellung. */
export function recHint(e) {
  if (!e) return '';
  const bits = [];
  const d = recDpi(e);
  if (d != null) bits.push(isNum(e.dpi) && d !== e.dpi ? `bei ${fmtNum(d, 0)} DPI (statt bisher ${fmtNum(e.dpi, 0)} DPI)` : `bei ${fmtNum(d, 0)} DPI`);
  if (isNum(e.edpi)) bits.push(`eDPI ${fmtNum(e.edpi, 1)}`);
  if (isNum(e.cm360)) bits.push(`${fmtNum(e.cm360, 1)} cm pro Drehung`);
  return bits.join(' · ') || `Test vom ${fmtDay(e.at, 'date')}`;
}

/**
 * Kachel "Fortschritt" aus dem Trend der Aim-Punkte: { value: "+4 Punkte", text: "Erster Test: 60 Punkte · …" }.
 * Der Unterschied kommt aus den gerundeten Werten, damit Kachel und Hinweis zusammenpassen (60 -> 64 ist +4).
 */
export function progressInfo(tr) {
  if (!tr || !isNum(tr.first) || !isNum(tr.last)) return null;
  const first = Math.round(tr.first);
  const last = Math.round(tr.last);
  const diff = last - first;
  const text = tr.groupSize === 1
    ? `Erster Test: ${fmtNum(first, 0)} · neuester: ${fmtNum(last, 0)}`
    : `Erste ${tr.groupSize} Tests: ${fmtNum(first, 0)} · letzte ${tr.groupSize}: ${fmtNum(last, 0)}`;
  return { value: signed(diff, Math.abs(diff) === 1 ? 'Punkt' : 'Punkte'), text };
}

/** Zeile zum letzten Lauf im Tasten-Trainer. Ohne richtige Taste gibt es keine Zeit (avgMs null). */
export function keysText(k) {
  if (!k) return '';
  const acc = isNum(k.accuracy) ? `${fmtNum(k.accuracy, 0)} % richtig` : '';
  if (!isNum(k.avgMs)) return `Tasten-Trainer: zuletzt keine richtige Taste${acc ? ` (${acc})` : ''}.`;
  return `Tasten-Trainer: zuletzt im Schnitt ${k.avgMs} ms${acc ? `, ${acc}` : ''}.`;
}

/** Was in der gespeicherten Tabelle steht, z. B. "3 Sitzungen, 1 Aim-Test, 2 Ping-Messungen". Leere Teile fallen weg. */
export function exportParts(r) {
  const count = (v) => (isNum(v) && v > 0 ? v : 0);
  return [
    [count(r?.sessions), 'Sitzung', 'Sitzungen'],
    [count(r?.aimTests), 'Aim-Test', 'Aim-Tests'],
    [count(r?.reactionTests), 'Reaktionstest', 'Reaktionstests'],
    [count(r?.keyTests), 'Tasten-Training', 'Tasten-Trainings'],
    [count(r?.pingTests), 'Ping-Messung', 'Ping-Messungen'],
  ].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(', ');
}
