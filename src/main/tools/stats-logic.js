'use strict';
// Session-Statistik: reine Rechenfunktionen (keine Dateien, keine Uhr – "now" kommt immer von außen).
// Eingaben sind die gespeicherten Zustände: 'sessions' (Spielzeit-Zähler), 'tool-sensi', 'tool-reaktion', 'tool-ping'.
// Alle Funktionen sind vorsichtig: fehlende, leere oder halbe Daten führen nie zu einem Fehler.

const RANGES = [7, 30, 90];
const MAX_AIM_POINTS = 60;
const MAX_MINI_POINTS = 30;
const RECENT = 8;

// ---------------------------------------------------------------- kleine Helfer

/** Zahl oder null (auch "12.5" als Text wird akzeptiert). */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 0) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const text = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Zeitraum in Tagen: 7, 30 oder 90 (andere Werte werden auf 7–90 begrenzt). */
function normDays(d) {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return 30;
  return clamp(n, 7, 90);
}

// ---------------------------------------------------------------- Datum (lokale Zeit)

const pad = (n) => String(n).padStart(2, '0');

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Tage addieren über den Kalender (Sommer-/Winterzeit-sicher). */
function addDays(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/** Montag 00:00 der Woche, in der ts liegt. */
function startOfWeek(ts) {
  const d = new Date(ts);
  const wd = (d.getDay() + 6) % 7; // Mo = 0 … So = 6
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd).getTime();
}

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "6 Std. 20 Min.", "20 Min.", "45 Sek.", "0 Min." */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(num(sec) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (hh) return mm ? `${hh} Std. ${mm} Min.` : `${hh} Std.`;
  if (mm) return `${mm} Min.`;
  return s ? `${s} Sek.` : '0 Min.';
}

// ---------------------------------------------------------------- Sitzungen

/**
 * Macht aus dem gespeicherten Zähler-Zustand ({list, current}) eine saubere, sortierte Liste.
 * names: {profileId: aktueller Name} – so erscheinen umbenannte Profile mit ihrem neuen Namen.
 * Die laufende Sitzung (current) endet rechnerisch "jetzt" und bekommt live: true.
 */
function normalizeSessions(raw, { now = Date.now(), names = {} } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.list) ? src.list : [];
  const out = [];
  const push = (x, live) => {
    if (!x || typeof x !== 'object') return;
    const start = num(x.start);
    let end = live ? now : num(x.end);
    if (start == null || end == null || start <= 0) return;
    if (end > now) end = now; // Uhr wurde verstellt: nichts in der Zukunft zählen
    if (end <= start) return;
    const profileId = text(x.profileId, 200);
    const profileName = (profileId && text(names[profileId])) || text(x.profileName) || (profileId ? 'Gelöschtes Profil' : 'Ohne Profil');
    out.push({
      start,
      end,
      seconds: Math.round((end - start) / 1000),
      profileId,
      profileName,
      live: !!live,
      recovered: !!x.recovered,
    });
  };
  for (const x of list) push(x, false);
  if (src.current) push(src.current, true);
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Notlösung, falls der Zähler-Zustand nicht lesbar ist: die "recent"-Liste aus ctx.sessions.summary(). */
function sessionsFromSummary(summary) {
  const recent = Array.isArray(summary?.recent) ? summary.recent : [];
  const list = recent.filter((x) => x && !x.live).map((x) => ({ start: x.start, end: x.end, profileId: x.profileId || null, profileName: x.profileName || null }));
  const live = recent.find((x) => x && x.live);
  const current = summary?.running && (summary.current || live)
    ? { start: (summary.current || live).start, profileId: summary.current?.profileId || null, profileName: (summary.current || live).profileName || null }
    : null;
  return { list, current };
}

/** Sekunden der Sitzung, die im Zeitfenster [from, to) liegen. */
function overlapSeconds(s, from, to) {
  return Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)) / 1000;
}

/**
 * Prozent-Anteile, die zusammen genau 100 ergeben (Methode der größten Reste).
 * values: Zahlen >= 0. Rückgabe: ganze Prozent in gleicher Reihenfolge.
 */
function sharePercents(values) {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (!total) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, v) / total) * 100);
  const base = raw.map(Math.floor);
  let rest = 100 - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    base[i]++;
    rest--;
  }
  return base;
}

/**
 * Alle Spielzeit-Werte für den Zeitraum der letzten `days` Tage (heute eingeschlossen).
 * Sitzungen über Mitternacht werden auf beide Tage aufgeteilt.
 */
function aggregateSessions(sessions, { days = 30, now = Date.now() } = {}) {
  const d = normDays(days);
  const list = Array.isArray(sessions) ? sessions : [];
  const today = startOfDay(now);
  const from = addDays(today, -(d - 1));
  const to = now;

  const daily = [];
  for (let i = 0; i < d; i++) {
    const ds = addDays(from, i);
    daily.push({ day: dayKey(ds), start: ds, end: addDays(from, i + 1), seconds: 0, sessions: 0 });
  }

  const inRange = [];
  for (const s of list) {
    const sec = overlapSeconds(s, from, to);
    if (sec <= 0) continue;
    inRange.push({ s, sec });
    const countAt = Math.max(s.start, from);
    for (const day of daily) {
      if (day.end <= s.start || day.start >= s.end) continue;
      day.seconds += overlapSeconds(s, day.start, day.end);
      if (countAt >= day.start && countAt < day.end) day.sessions++;
    }
  }
  for (const day of daily) day.seconds = Math.round(day.seconds);

  const totalSeconds = Math.round(inRange.reduce((n, x) => n + x.sec, 0));
  const sessionCount = inRange.length;

  // pro Profil
  const map = new Map();
  for (const { s, sec } of inRange) {
    const key = s.profileId || '__ohne__';
    const p = map.get(key) || { profileId: s.profileId, name: s.profileName, seconds: 0, sessions: 0, lastPlayed: 0 };
    p.seconds += sec;
    p.sessions++;
    if (s.end > p.lastPlayed) {
      p.lastPlayed = s.end;
      p.name = s.profileName; // neuester Name gewinnt
    }
    map.set(key, p);
  }
  const perProfile = [...map.values()]
    .map((p) => ({ ...p, seconds: Math.round(p.seconds) }))
    .sort((a, b) => b.seconds - a.seconds || b.sessions - a.sessions || String(a.name).localeCompare(String(b.name)));
  const shares = sharePercents(perProfile.map((p) => p.seconds));
  perProfile.forEach((p, i) => { p.sharePct = shares[i]; });
  const favourite = perProfile.find((p) => p.profileId) || null;

  // längste Sitzung (ganze Länge, auch wenn sie vor dem Zeitraum begann)
  let longest = null;
  for (const { s } of inRange) {
    if (!longest || s.seconds > longest.seconds) longest = s;
  }

  // Woche: Mo–jetzt im Vergleich zur Vorwoche (ganz und bis zum gleichen Zeitpunkt)
  const weekStart = startOfWeek(now);
  const lastWeekStart = addDays(weekStart, -7);
  const sameTimeLastWeek = lastWeekStart + (now - weekStart);
  let thisSeconds = 0;
  let lastSeconds = 0;
  let lastSameTimeSeconds = 0;
  for (const s of list) {
    thisSeconds += overlapSeconds(s, weekStart, now);
    lastSeconds += overlapSeconds(s, lastWeekStart, weekStart);
    lastSameTimeSeconds += overlapSeconds(s, lastWeekStart, Math.min(sameTimeLastWeek, weekStart));
  }
  thisSeconds = Math.round(thisSeconds);
  lastSeconds = Math.round(lastSeconds);
  lastSameTimeSeconds = Math.round(lastSameTimeSeconds);
  const deltaSeconds = thisSeconds - lastSameTimeSeconds;
  // "gleich" bei weniger als 10 Minuten oder 10 % Unterschied
  const tolerance = Math.max(600, lastSameTimeSeconds * 0.1);
  const weekTrend = Math.abs(deltaSeconds) < tolerance ? 'gleich' : deltaSeconds > 0 ? 'mehr' : 'weniger';

  const activeDays = daily.filter((x) => x.seconds > 0).length;
  let bestDay = null;
  for (const x of daily) if (x.seconds > 0 && (!bestDay || x.seconds > bestDay.seconds)) bestDay = x;

  const live = list.find((s) => s.live) || null;
  const pub = (s) => (s ? { start: s.start, end: s.end, seconds: s.seconds, profileName: s.profileName, live: s.live, recovered: s.recovered } : null);

  return {
    days: d,
    from,
    to,
    totalSeconds,
    allTimeSeconds: Math.round(list.reduce((n, s) => n + s.seconds, 0)),
    allTimeSessions: list.length,
    sessionCount,
    avgSessionSeconds: sessionCount ? Math.round(totalSeconds / sessionCount) : 0,
    activeDays,
    avgActiveDaySeconds: activeDays ? Math.round(totalSeconds / activeDays) : 0,
    bestDay: bestDay ? { day: bestDay.day, start: bestDay.start, seconds: bestDay.seconds } : null,
    longest: pub(longest),
    week: {
      start: weekStart,
      thisSeconds,
      lastSeconds,
      lastSameTimeSeconds,
      deltaSeconds,
      trend: weekTrend,
      weekdayName: WEEKDAYS[new Date(now).getDay()],
    },
    perProfile: perProfile.map(({ lastPlayed, ...p }) => p),
    favourite: favourite ? { profileId: favourite.profileId, name: favourite.name, seconds: favourite.seconds, sessions: favourite.sessions, sharePct: favourite.sharePct } : null,
    daily: daily.map(({ day, start, seconds, sessions }) => ({ day, start, seconds, sessions })),
    recent: list.slice(-RECENT).reverse().map(pub),
    running: !!live,
    current: live ? { start: live.start, seconds: live.seconds, profileName: live.profileName } : null,
  };
}

// ---------------------------------------------------------------- Trend

/**
 * Vergleicht den Schnitt der ersten k mit dem der letzten k Werte (k = 5, bei wenigen Werten weniger,
 * damit sich die Gruppen nicht überschneiden). lowerIsBetter für Millisekunden.
 */
function trendOf(values, { k = 5, threshold = 2, lowerIsBetter = false } = {}) {
  const v = (values || []).map(num).filter((x) => x != null);
  if (v.length < 2) return null;
  const g = Math.max(1, Math.min(k, Math.floor(v.length / 2)));
  const first = avg(v.slice(0, g));
  const last = avg(v.slice(-g));
  const delta = last - first;
  let direction = 'gleich';
  if (Math.abs(delta) >= threshold) {
    const up = delta > 0;
    direction = up !== lowerIsBetter ? 'besser' : 'schlechter';
  }
  return { first: round(first, 1), last: round(last, 1), delta: round(delta, 1), groupSize: g, count: v.length, direction };
}

// ---------------------------------------------------------------- Aim-Tests ('tool-sensi')

function normalizeAim(state) {
  const hist = Array.isArray(state?.history) ? state.history : [];
  const out = [];
  for (const e of hist) {
    if (!e || typeof e !== 'object') continue;
    const at = num(e.at);
    if (!at || at <= 0) continue;
    const score = num(e.score);
    const accuracy = num(e.accuracy);
    if (score == null && accuracy == null) continue;
    const dpi = num(e.dpi);
    const recDpi = num(e.recommendedDpi);
    out.push({
      at,
      score: score == null ? null : round(clamp(score, 0, 100), 1),
      accuracy: accuracy == null ? null : round(clamp(accuracy, 0, 100), 1),
      recommendedSens: num(e.recommendedSens),
      sens: num(e.sens),
      dpi,
      // Beim DPI-Vergleich gilt die empfohlene Sensi für eine andere DPI als beim Test (eDPI und cm360 auch).
      recommendedDpi: recDpi != null && recDpi > 0 ? recDpi : dpi,
      edpi: num(e.edpi),
      cm360: num(e.cm360),
      hits: num(e.hits),
      misses: num(e.misses),
      trackingPct: num(e.trackingPct),
      avgTtkMs: num(e.avgTtkMs),
      rounds: Array.isArray(e.rounds) ? e.rounds.length : 0,
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

function bestBy(list, key, lowerIsBetter = false) {
  let best = null;
  for (const e of list) {
    const v = e[key];
    if (v == null) continue;
    if (!best || (lowerIsBetter ? v < best[key] : v > best[key])) best = e;
  }
  return best;
}

/**
 * Aim-Verlauf für den Zeitraum. Gibt es im Zeitraum keinen Test, aber ältere, werden die älteren
 * gezeigt (outOfRange: true), damit das Diagramm nicht leer bleibt.
 */
function aimSummary(list, { days = 30, now = Date.now() } = {}) {
  const all = Array.isArray(list) ? list : [];
  const from = addDays(startOfDay(now), -(normDays(days) - 1));
  const inRange = all.filter((e) => e.at >= from && e.at <= now + 60000);
  const shown = inRange.length ? inRange : all;
  return {
    total: all.length,
    inRange: inRange.length,
    outOfRange: !inRange.length && all.length > 0,
    points: shown.slice(-MAX_AIM_POINTS),
    trend: trendOf(shown.map((e) => e.score), { threshold: 2 }),
    accuracyTrend: trendOf(shown.map((e) => e.accuracy), { threshold: 2 }),
    bestAccuracy: bestBy(shown, 'accuracy'),
    bestScore: bestBy(shown, 'score'),
    latest: all.length ? all[all.length - 1] : null,
  };
}

// ---------------------------------------------------------------- Reaktions-Labor ('tool-reaktion')

function normalizeReaction(state) {
  const reaction = [];
  for (const e of Array.isArray(state?.reaction) ? state.reaction : []) {
    const at = num(e?.at);
    const avgMs = num(e?.avgMs);
    if (!at || avgMs == null || avgMs <= 0 || avgMs > 5000) continue;
    const bestMs = num(e.bestMs);
    reaction.push({ at, avgMs: Math.round(avgMs), bestMs: bestMs != null && bestMs > 0 ? Math.round(bestMs) : null, rounds: num(e.rounds), falseStarts: num(e.falseStarts) });
  }
  const keys = [];
  for (const e of Array.isArray(state?.keys) ? state.keys : []) {
    const at = num(e?.at);
    if (!at) continue;
    const avgMs = num(e.avgMs);
    const accuracy = num(e.accuracy);
    // avgMs null mit 0 % heißt: diesmal keine richtige Taste (so speichert es das Reaktions-Labor). Der Lauf zählt trotzdem.
    const noHit = e.avgMs === null && accuracy === 0;
    if (!noHit && (avgMs == null || avgMs <= 0 || avgMs > 10000)) continue;
    keys.push({ at, avgMs: noHit ? null : Math.round(avgMs), accuracy: accuracy == null ? null : round(clamp(accuracy, 0, 100), 1), count: num(e.count) });
  }
  reaction.sort((a, b) => a.at - b.at);
  keys.sort((a, b) => a.at - b.at);
  return { reaction, keys };
}

function reactionSummary(state) {
  const { reaction, keys } = normalizeReaction(state);
  const bestSingle = reaction.reduce((m, e) => (e.bestMs != null && (m == null || e.bestMs < m) ? e.bestMs : m), null);
  return {
    count: reaction.length,
    points: reaction.slice(-MAX_MINI_POINTS),
    latest: reaction.length ? reaction[reaction.length - 1] : null,
    best: bestBy(reaction, 'avgMs', true),
    bestSingleMs: bestSingle,
    trend: trendOf(reaction.map((e) => e.avgMs), { threshold: 10, lowerIsBetter: true }),
    keys: {
      count: keys.length,
      latest: keys.length ? keys[keys.length - 1] : null,
      best: bestBy(keys, 'avgMs', true),
      points: keys.slice(-MAX_MINI_POINTS),
    },
  };
}

// ---------------------------------------------------------------- Ping ('tool-ping')

function normalizePing(state) {
  const out = [];
  for (const e of Array.isArray(state?.history) ? state.history : []) {
    const at = num(e?.at);
    const ms = num(e?.best?.ms);
    if (!at || ms == null || ms < 0 || ms > 10000) continue;
    out.push({ at, ms: Math.round(ms), name: text(e.best.name) || text(e.best.region) || 'Server', region: text(e.best.region, 20), method: text(e.method, 20) });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

function pingSummary(state) {
  const list = normalizePing(state);
  return {
    count: list.length,
    points: list.slice(-MAX_MINI_POINTS),
    latest: list.length ? list[list.length - 1] : null,
    best: bestBy(list, 'ms', true),
    trend: trendOf(list.map((e) => e.ms), { threshold: 5, lowerIsBetter: true }),
  };
}

// ---------------------------------------------------------------- Gesamtansicht & Cockpit-Zeile

/** Kurze Zeile fürs Cockpit, z. B. "Diese Woche 6 Std. 20 Min. gespielt". null, wenn es nichts zu sagen gibt. */
function summaryLine({ sessions = [], aim = [], now = Date.now() } = {}) {
  const weekStart = startOfWeek(now);
  const week = Math.round(sessions.reduce((n, s) => n + overlapSeconds(s, weekStart, now), 0));
  if (week >= 60) return { text: `Diese Woche ${fmtDuration(week)} gespielt` };
  if (sessions.length) return { text: 'Diese Woche noch nicht gespielt' };
  const last = aim.length ? aim[aim.length - 1] : null;
  if (last && last.score != null) return { text: `Letzter Aim-Test: ${round(last.score)} Punkte` };
  return null;
}

/**
 * Gibt es etwas, das in der CSV-Tabelle landet? Dieselbe Bedingung gilt für den Speichern-Knopf
 * (buildOverview -> hasAnyData) und für exportCsv. Erwartet die Anzahlen der Einträge.
 */
function hasExportData({ sessions = 0, aim = 0, reaction = 0, keys = 0, ping = 0 } = {}) {
  return [sessions, aim, reaction, keys, ping].some((n) => Number(n) > 0);
}

function buildOverview({ sessionsRaw, names = {}, sensi, reaktion, ping, days = 30, now = Date.now(), trackingSupported = true } = {}) {
  const d = normDays(days);
  const sessions = normalizeSessions(sessionsRaw, { now, names });
  const aimList = normalizeAim(sensi);
  const reaction = reactionSummary(reaktion);
  const pingS = pingSummary(ping);
  return {
    generatedAt: now,
    days: d,
    trackingSupported: !!trackingSupported,
    hasSessions: sessions.length > 0,
    hasAnyData: hasExportData({ sessions: sessions.length, aim: aimList.length, reaction: reaction.count, keys: reaction.keys.count, ping: pingS.count }),
    play: aggregateSessions(sessions, { days: d, now }),
    aim: aimSummary(aimList, { days: d, now }),
    reaction,
    ping: pingS,
    summary: summaryLine({ sessions, aim: aimList, now }),
  };
}

// ---------------------------------------------------------------- CSV (für deutsches Excel)

/** Zelle für CSV mit Semikolon. Texte, die mit = + - @ beginnen, bekommen ein ' davor (keine Formeln). */
function csvCell(v, { isText = false } = {}) {
  if (v == null) return '';
  let s = String(v);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Zahl mit Komma statt Punkt ("6,5"); leer, wenn keine Zahl. */
function deNum(v, decimals = 1) {
  const n = num(v);
  if (n == null) return '';
  return String(round(n, decimals)).replace('.', ',');
}

const csvRow = (cells) => cells.join(';');

/**
 * Baut die CSV-Datei: UTF-8 mit BOM (damit Excel Umlaute richtig zeigt), Semikolon, Windows-Zeilenenden.
 * Inhalt: alle Sitzungen, alle Aim-Tests und – falls vorhanden – Reaktionstests, Tasten-Trainer und Ping-Messungen.
 */
function buildCsv({ sessions = [], aim = [], reaction = [], keys = [], ping = [], now = Date.now() } = {}) {
  const lines = [];
  const t = (v) => csvCell(v, { isText: true });
  lines.push(csvRow([t('HELIX Session-Statistik'), t(`erstellt am ${fmtDateTime(now)}`)]));
  lines.push('');
  lines.push(t('Spielzeiten'));
  lines.push(csvRow(['Beginn', 'Ende', 'Dauer (Minuten)', 'Dauer', 'Profil', 'Hinweis']));
  if (!sessions.length) lines.push(t('Noch keine Sitzungen gezählt'));
  for (const s of sessions) {
    lines.push(csvRow([
      fmtDateTime(s.start),
      fmtDateTime(s.end),
      deNum(s.seconds / 60, 0),
      t(fmtDuration(s.seconds)),
      t(s.profileName),
      t(s.live ? 'läuft noch' : s.recovered ? 'Ende geschätzt (HELIX wurde geschlossen, während Fortnite noch lief)' : ''),
    ]));
  }
  lines.push('');
  lines.push(t('Aim-Tests'));
  lines.push(csvRow([
    'Datum', 'Punkte (0-100)', 'Trefferquote (%)', 'Treffer', 'Fehlschüsse', 'Tracking (%)', 'Zeit bis Treffer (ms)',
    'Getestete Sensi', 'DPI beim Test', 'Empfohlene Sensi', 'Empfohlene DPI', 'eDPI (Empfehlung)', 'cm pro 360° (Empfehlung)',
  ]));
  if (!aim.length) lines.push(t('Noch keine Aim-Tests'));
  for (const e of aim) {
    lines.push(csvRow([
      fmtDateTime(e.at), deNum(e.score, 1), deNum(e.accuracy, 1), deNum(e.hits, 0), deNum(e.misses, 0),
      deNum(e.trackingPct, 1), deNum(e.avgTtkMs, 0), deNum(e.sens, 2), deNum(e.dpi, 0),
      deNum(e.recommendedSens, 2), deNum(e.recommendedDpi ?? e.dpi, 0), deNum(e.edpi, 1), deNum(e.cm360, 1),
    ]));
  }
  if (reaction.length) {
    lines.push('');
    lines.push(t('Reaktionstests'));
    lines.push(csvRow(['Datum', 'Durchschnitt (ms)', 'Bester Wert (ms)', 'Runden', 'Frühstarts']));
    for (const e of reaction) {
      lines.push(csvRow([fmtDateTime(e.at), deNum(e.avgMs, 0), deNum(e.bestMs, 0), deNum(e.rounds, 0), deNum(e.falseStarts, 0)]));
    }
  }
  if (keys.length) {
    lines.push('');
    lines.push(t('Tasten-Trainer'));
    lines.push(csvRow(['Datum', 'Durchschnitt (ms)', 'Richtig (%)', 'Befehle', 'Hinweis']));
    for (const e of keys) {
      lines.push(csvRow([fmtDateTime(e.at), deNum(e.avgMs, 0), deNum(e.accuracy, 1), deNum(e.count, 0), t(e.avgMs == null ? 'keine richtige Taste' : '')]));
    }
  }
  if (ping.length) {
    lines.push('');
    lines.push(t('Ping-Messungen'));
    lines.push(csvRow(['Datum', 'Bester Server', 'Region', 'Ping (ms)']));
    for (const e of ping) {
      lines.push(csvRow([fmtDateTime(e.at), t(e.name), t(e.region), deNum(e.ms, 0)]));
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Dateiname-Vorschlag: HELIX-Statistik-2026-10-18.csv */
function csvFileName(now = Date.now()) {
  return `HELIX-Statistik-${dayKey(now)}.csv`;
}

module.exports = {
  RANGES,
  num,
  normDays,
  dayKey,
  startOfDay,
  addDays,
  startOfWeek,
  fmtDateTime,
  fmtDuration,
  normalizeSessions,
  sessionsFromSummary,
  overlapSeconds,
  sharePercents,
  aggregateSessions,
  trendOf,
  normalizeAim,
  aimSummary,
  normalizeReaction,
  reactionSummary,
  normalizePing,
  pingSummary,
  summaryLine,
  hasExportData,
  buildOverview,
  csvCell,
  deNum,
  buildCsv,
  csvFileName,
};
