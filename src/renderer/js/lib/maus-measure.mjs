// Maus-Check: reine Mess- und Bewertungsfunktionen (ohne DOM).
// Wird von der Ansicht und den Unit-Tests benutzt.
//
// Abfragerate: Zeitstempel aus pointerrawupdate + getCoalescedEvents(). Nur Zeiten mit echter Bewegung zählen.
// Pausen (Abstand > GAP_MS) trennen die Bewegung in Abschnitte; gezählt wird nur die Zeit in Bewegung.
//   Hz = Summe(Abschnitt-Proben - 1) / Summe(Abschnitt-Dauer)
// Über ~1000 Hz misst ein Browser nicht zuverlässig (Recherche "sensitivity-math" 5.2).
//
// DPI: Mit Zeigersperre (unadjustedMovement) liefert movementX/Y ungefilterte Maus-Schritte ("Counts").
//   DPI = Counts / (Strecke in cm / 2,54)  ->  bei 10 cm: Counts / 3,937

export const GAP_MS = 50;
export const NEED_MOVE_MS = 3000;
export const RULER_CM = 10;
export const CARD_CM = 8.56; // Breite einer Bank- oder Ausweiskarte (ISO/IEC 7810 ID-1)
export const CM_PER_INCH = 2.54;
export const COMMON_DPI = [400, 800, 1000, 1200, 1600, 2000, 2400, 3200, 4000, 6400];
export const RUNS = 3;

const round = (v, d = 0) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

export function median(list) {
  const a = list.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Teilt Zeitstempel (ms, aufsteigend) an Pausen in Abschnitte. */
export function segmentTimes(ts, gap = GAP_MS) {
  const segs = [];
  let cur = [];
  let last = -Infinity;
  for (const t of ts) {
    if (!Number.isFinite(t)) continue;
    if (t < last) continue; // rückwärts laufende Zeit ignorieren
    if (cur.length && t - last > gap) {
      segs.push(cur);
      cur = [];
    }
    cur.push(t);
    last = t;
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/** Zeit in Bewegung (ms) und Anzahl der Abstände – für den Fortschritt während der Messung. */
export function movingTime(ts, gap = GAP_MS) {
  let ms = 0;
  let intervals = 0;
  for (const s of segmentTimes(ts, gap)) {
    if (s.length < 2) continue;
    ms += s[s.length - 1] - s[0];
    intervals += s.length - 1;
  }
  return { ms, intervals };
}

/**
 * Ordnet einen Messwert einer üblichen Abfragerate zu (Grenzen = geometrische Mitte zweier Stufen).
 * reliable=false heißt: der Browser kann so hohe Raten nicht sicher messen.
 */
export function classifyRate(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return { cls: 'low', label: 'nicht messbar', nominal: null, reliable: false };
  if (hz < 90) return { cls: 'low', label: 'unter 125 Hz', nominal: null, reliable: true };
  if (hz < 177) return { cls: '125', label: '125 Hz', nominal: 125, reliable: true };
  if (hz < 354) return { cls: '250', label: '250 Hz', nominal: 250, reliable: true };
  if (hz < 707) return { cls: '500', label: '500 Hz', nominal: 500, reliable: true };
  if (hz < 1414) return { cls: '1000', label: '1000 Hz', nominal: 1000, reliable: true };
  return { cls: '2000+', label: 'über 1000 Hz', nominal: 2000, reliable: false };
}

/**
 * Wertet die gesammelten Zeitstempel aus.
 * Rückgabe: { samples, durationMs, hz, medianMs, hzFromMedian, stable, cls, label, nominal, reliable, enough }
 */
export function analyzePolling(ts, { gap = GAP_MS, needMs = NEED_MOVE_MS } = {}) {
  const segs = segmentTimes(ts, gap).filter((s) => s.length >= 2);
  let intervals = 0;
  let durationMs = 0;
  let samples = 0;
  const gaps = [];
  for (const s of segs) {
    samples += s.length;
    intervals += s.length - 1;
    durationMs += s[s.length - 1] - s[0];
    for (let i = 1; i < s.length; i++) gaps.push(s[i] - s[i - 1]);
  }
  const hz = durationMs > 0 ? (intervals * 1000) / durationMs : 0;
  const med = median(gaps);
  const hzFromMedian = med && med > 0 ? 1000 / med : null;
  // stabil, wenn Mittelwert und Median zur gleichen Stufe passen (nicht mehr als 25 % auseinander)
  const stable = hzFromMedian ? Math.abs(hzFromMedian - hz) / Math.max(hz, 1) <= 0.25 : false;
  const c = classifyRate(hz);
  return {
    samples,
    durationMs: round(durationMs, 1),
    hz: round(hz),
    medianMs: med === null ? null : round(med, 3),
    hzFromMedian: hzFromMedian === null ? null : round(hzFromMedian),
    stable,
    ...c,
    enough: durationMs >= needMs && samples >= 20,
  };
}

/** Kurze, einfache Erklärung zum Ergebnis der Abfragerate. */
export function pollingAdvice(r) {
  if (!r || r.cls === 'low') {
    return { tone: 'warn', text: 'Es kamen zu wenige Bewegungen an. Bewege die Maus schneller und ohne Pause im Kreis und miss noch einmal.' };
  }
  if (r.cls === '2000+') {
    return { tone: 'ok', text: 'Deine Maus meldet sich öfter als 1000-mal pro Sekunde. Ein Browser kann so hohe Werte nicht genau messen – die echte Rate steht in der Software deiner Maus.' };
  }
  if (r.cls === '1000') return { tone: 'ok', text: '1000 Hz ist ideal für Fortnite: Die Maus meldet ihre Position etwa jede Millisekunde.' };
  if (r.cls === '500') return { tone: 'warn', text: '500 Hz ist okay. Wenn deine Maus 1000 Hz kann, stell es in der Software des Herstellers ein (oft „Polling Rate“ oder „Report Rate“).' };
  return { tone: 'warn', text: `${classifyLabel(r.cls)} ist wenig. Stell in der Software deiner Maus 1000 Hz ein, falls sie das kann („Polling Rate“). Bei sehr einfachen Mäusen geht das nicht.` };
}

// ---------------------------------------------------------------- DPI

export function countsToDpi(counts, cm = RULER_CM) {
  if (!Number.isFinite(counts) || counts <= 0 || !Number.isFinite(cm) || cm <= 0) return null;
  return counts / (cm / CM_PER_INCH);
}

/** Länge einer Bewegung aus der Summe von movementX und movementY (schräg ziehen zählt mit). */
export function moveLength(dx, dy) {
  return Math.hypot(dx || 0, dy || 0);
}

export function nearestCommonDpi(dpi, tolerance = 0.12) {
  if (!Number.isFinite(dpi) || dpi <= 0) return null;
  let best = null;
  for (const v of COMMON_DPI) {
    const diff = Math.abs(dpi - v) / v;
    if (!best || diff < best.diffPct) best = { value: v, diffPct: diff };
  }
  return best && best.diffPct <= tolerance ? { value: best.value, diffPct: round(best.diffPct * 100, 1) } : null;
}

/**
 * Wertet mehrere Messungen aus. runs = Counts je Messung.
 * Rückgabe: { dpi, perRun, spreadPct, consistent, plausible, nearest }
 */
export function evaluateDpi(runs, cm = RULER_CM) {
  const perRun = runs.map((c) => countsToDpi(c, cm)).filter((x) => x !== null);
  if (!perRun.length) return null;
  const avg = perRun.reduce((a, b) => a + b, 0) / perRun.length;
  const spread = perRun.length > 1 ? (Math.max(...perRun) - Math.min(...perRun)) / avg : 0;
  return {
    dpi: round(avg),
    perRun: perRun.map((x) => round(x)),
    spreadPct: round(spread * 100, 1),
    consistent: spread <= 0.15,
    plausible: avg >= 200 && avg <= 32000,
    nearest: nearestCommonDpi(avg),
  };
}

// ---------------------------------------------------------------- Empfehlungen

/**
 * Checkliste für die Übersicht. Eingaben dürfen fehlen (null) – dann ist der Punkt „noch offen“.
 *   windows: Ergebnis von maus.status().windows
 *   fortnite: Ergebnis von maus.fortniteAccel()
 *   polling: letztes Abfrageraten-Ergebnis (analyzePolling oder gespeichert)
 * state: 'ok' | 'warn' | 'open'
 */
export function buildChecklist({ windows = null, fortnite = null, polling = null, unsupported = false } = {}) {
  const items = [];
  if (windows) {
    items.push({
      id: 'speed',
      title: 'Windows-Zeigergeschwindigkeit 6/11',
      state: windows.speed.ok ? 'ok' : 'warn',
      now: `jetzt: ${windows.speed.label}`,
      text: 'Bei Stufe 6 von 11 setzt Windows jede Mausbewegung 1:1 um. Andere Stufen rechnen hoch oder lassen Schritte aus.',
    });
    items.push({
      id: 'accel',
      title: 'Zeigerbeschleunigung aus',
      state: windows.accel.ok ? 'ok' : 'warn',
      now: windows.accel.on ? 'jetzt: an' : 'jetzt: aus',
      text: 'Beschleunigung heißt: schnelle Bewegungen gehen weiter als langsame. Aus ist besser, damit gleiche Handbewegung immer gleich weit geht.',
    });
  } else {
    items.push({
      id: 'windows',
      title: 'Windows-Mauseinstellungen',
      state: 'open',
      now: unsupported ? 'nur unter Windows prüfbar' : 'noch nicht gelesen',
      text: 'Empfohlen: Zeigergeschwindigkeit 6/11 und „Zeigerbeschleunigung verbessern“ aus.',
    });
  }
  if (fortnite && fortnite.found && fortnite.disabled !== null && fortnite.disabled !== undefined) {
    items.push({
      id: 'fortnite',
      title: 'Mausbeschleunigung in Fortnite aus',
      state: fortnite.disabled ? 'ok' : 'warn',
      now: fortnite.disabled ? 'jetzt: aus' : 'jetzt: an',
      text: 'Steht in der Fortnite-Datei GameUserSettings.ini (bDisableMouseAcceleration). Aus ist besser für gleichmäßiges Zielen.',
    });
  } else {
    items.push({
      id: 'fortnite',
      title: 'Mausbeschleunigung in Fortnite aus',
      state: 'open',
      now: fortnite && fortnite.found ? 'Wert fehlt in der Datei' : 'Fortnite-Datei nicht gefunden',
      text: 'HELIX liest das aus der Fortnite-Datei GameUserSettings.ini, sobald sie da ist.',
    });
  }
  if (polling && polling.cls) {
    const good = polling.cls === '1000' || polling.cls === '2000+';
    items.push({
      id: 'polling',
      title: 'Abfragerate 1000 Hz',
      state: good ? 'ok' : 'warn',
      now: `gemessen: ${classifyLabel(polling.cls)}`,
      text: 'Die Abfragerate sagt, wie oft die Maus pro Sekunde ihre Position meldet. 1000 Hz ist ideal, wenn deine Maus das kann.',
    });
  } else {
    items.push({
      id: 'polling',
      title: 'Abfragerate 1000 Hz',
      state: 'open',
      now: 'noch nicht gemessen',
      text: 'Miss sie im Reiter „Abfragerate“. Das dauert nur ein paar Sekunden.',
    });
  }
  const done = items.filter((i) => i.state === 'ok').length;
  return { items, done, total: items.length };
}

export function classifyLabel(cls) {
  return { low: 'unter 125 Hz', 125: '125 Hz', 250: '250 Hz', 500: '500 Hz', 1000: '1000 Hz', '2000+': 'über 1000 Hz' }[cls] || 'unbekannt';
}

/** Ganze Zahl mit deutschem Tausenderpunkt. */
export function fmtInt(n) {
  if (!Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('de-DE');
}

/** Dezimalzahl mit Komma. */
export function fmtDec(n, d = 1) {
  if (!Number.isFinite(n)) return '–';
  return round(n, d).toFixed(d).replace('.', ',');
}
