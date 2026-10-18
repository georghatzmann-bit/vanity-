'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const logic = require('../../src/main/tools/stats-logic');
const mod = require('../../src/main/modules/tools/stats');

const ROOT = path.join(__dirname, '..', '..');
const chartLib = () => import(pathToFileURL(path.join(ROOT, 'src/renderer/js/lib/stats-chart.mjs')).href);

/** Lokale Zeit (Monat 1–12), damit die Tests in jeder Zeitzone gleich rechnen. */
const T = (mo, d, hh = 0, mm = 0) => new Date(2026, mo - 1, d, hh, mm).getTime();
const NOW = T(10, 18, 20, 0); // Sonntag, 18.10.2026, 20:00 – die Woche begann am Montag, 12.10.
const HOUR = 3600;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'helix-stats-'));
}

// ---------------------------------------------------------------- Sitzungen

test('Sitzungen: kaputte Einträge fallen weg, laufende Sitzung zählt bis jetzt, Namen sind aktuell', () => {
  const raw = {
    list: [
      { start: T(10, 17, 18), end: T(10, 17, 19, 30), profileId: 'p1', profileName: 'Alt' },
      { start: 'kaputt', end: 5 },
      null,
      42,
      { start: T(10, 16, 10), end: T(10, 16, 9) }, // Ende vor Beginn
      { start: T(10, 18, 21), end: T(10, 18, 23) }, // liegt in der Zukunft
      { start: T(10, 15, 20), end: T(10, 15, 21), profileId: 'geloescht' },
      { start: T(10, 14, 20), end: T(10, 14, 21), recovered: true },
    ],
    current: { start: T(10, 18, 19), lastSeen: T(10, 18, 19, 59), profileId: 'p1', profileName: 'Alt' },
  };
  const list = logic.normalizeSessions(raw, { now: NOW, names: { p1: 'Main' } });
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((s) => s.profileName), ['Ohne Profil', 'Gelöschtes Profil', 'Main', 'Main']);
  assert.equal(list[0].recovered, true);
  const live = list[3];
  assert.equal(live.live, true);
  assert.equal(live.end, NOW);
  assert.equal(live.seconds, HOUR);
  assert.equal(list[2].seconds, 1.5 * HOUR);
});

test('Sitzungen: leere oder falsche Zustände ergeben eine leere Liste', () => {
  for (const raw of [null, undefined, 'x', 5, {}, { list: 'nein' }, { list: [], current: { start: 'x' } }]) {
    assert.deepEqual(logic.normalizeSessions(raw, { now: NOW }), []);
  }
});

test('Sitzungen: Notlösung aus ctx.sessions.summary() übernimmt "recent" und die laufende Sitzung', () => {
  const raw = logic.sessionsFromSummary({
    running: true,
    current: { start: T(10, 18, 19), profileId: 'p1', profileName: 'Main' },
    recent: [
      { start: T(10, 18, 19), end: NOW, profileName: 'Main', live: true },
      { start: T(10, 17, 18), end: T(10, 17, 19), profileName: 'Turnier' },
    ],
  });
  assert.equal(raw.list.length, 1);
  assert.equal(raw.current.start, T(10, 18, 19));
  const list = logic.normalizeSessions(raw, { now: NOW });
  assert.equal(list.length, 2);
  assert.equal(list[1].live, true);
  assert.deepEqual(logic.sessionsFromSummary(null), { list: [], current: null });
});

test('Spielzeit: Sitzungen über Mitternacht werden auf beide Tage verteilt', () => {
  const sessions = logic.normalizeSessions({ list: [{ start: T(10, 16, 23), end: T(10, 17, 1), profileId: 'p1', profileName: 'Main' }] }, { now: NOW });
  const agg = logic.aggregateSessions(sessions, { days: 7, now: NOW });
  const byDay = Object.fromEntries(agg.daily.map((d) => [d.day, d]));
  assert.equal(agg.daily.length, 7);
  assert.equal(agg.daily[0].day, '2026-10-12');
  assert.equal(agg.daily[6].day, '2026-10-18');
  assert.equal(byDay['2026-10-16'].seconds, HOUR);
  assert.equal(byDay['2026-10-17'].seconds, HOUR);
  assert.equal(byDay['2026-10-16'].sessions, 1);
  assert.equal(byDay['2026-10-17'].sessions, 0, 'eine Sitzung wird nur am Starttag gezählt');
  assert.equal(agg.totalSeconds, 2 * HOUR);
  assert.equal(agg.sessionCount, 1);
});

test('Spielzeit: am Rand des Zeitraums zählt nur der Teil im Zeitraum, die längste Sitzung zählt ganz', () => {
  const sessions = logic.normalizeSessions({
    list: [
      { start: T(10, 11, 23, 30), end: T(10, 12, 0, 30), profileName: 'X' }, // halb vor dem 7-Tage-Zeitraum
      { start: T(10, 1, 18), end: T(10, 1, 22) }, // ganz außerhalb
    ],
  }, { now: NOW });
  const agg = logic.aggregateSessions(sessions, { days: 7, now: NOW });
  assert.equal(agg.totalSeconds, 1800);
  assert.equal(agg.sessionCount, 1);
  assert.equal(agg.daily[0].sessions, 1);
  assert.equal(agg.longest.seconds, HOUR);
  assert.equal(agg.allTimeSeconds, 5 * HOUR);
  assert.equal(agg.allTimeSessions, 2);
});

test('Spielzeit: diese Woche gegen Vorwoche (ganz und bis zum gleichen Zeitpunkt)', () => {
  const sessions = logic.normalizeSessions({
    list: [
      { start: T(10, 5, 18), end: T(10, 5, 20) }, // Mo Vorwoche, 2 Std.
      { start: T(10, 11, 21), end: T(10, 11, 23) }, // So Vorwoche nach 20 Uhr, 2 Std.
      { start: T(10, 13, 18), end: T(10, 13, 21) }, // Di diese Woche, 3 Std.
    ],
  }, { now: NOW });
  const { week } = logic.aggregateSessions(sessions, { days: 30, now: NOW });
  assert.equal(week.start, T(10, 12));
  assert.equal(week.thisSeconds, 3 * HOUR);
  assert.equal(week.lastSeconds, 4 * HOUR);
  assert.equal(week.lastSameTimeSeconds, 2 * HOUR);
  assert.equal(week.deltaSeconds, HOUR);
  assert.equal(week.trend, 'mehr');
  assert.equal(week.weekdayName, 'Sonntag');

  const same = logic.aggregateSessions(logic.normalizeSessions({
    list: [{ start: T(10, 6, 18), end: T(10, 6, 20) }, { start: T(10, 13, 18), end: T(10, 13, 20, 5) }],
  }, { now: NOW }), { days: 30, now: NOW });
  assert.equal(same.week.trend, 'gleich', '5 Minuten Unterschied sind "gleich"');
});

test('Spielzeit: pro Profil mit Anteilen (zusammen 100 %), Lieblingsprofil ohne "Ohne Profil"', () => {
  const sessions = logic.normalizeSessions({
    list: [
      { start: T(10, 13, 18), end: T(10, 13, 21), profileId: null }, // 3 Std. ohne Profil
      { start: T(10, 14, 18), end: T(10, 14, 20), profileId: 'p1', profileName: 'Main' },
      { start: T(10, 15, 18), end: T(10, 15, 19), profileId: 'p2', profileName: 'Turnier' },
      { start: T(10, 16, 18), end: T(10, 16, 18, 30), profileId: 'p1', profileName: 'Main' },
    ],
  }, { now: NOW, names: { p1: 'Main neu' } });
  const agg = logic.aggregateSessions(sessions, { days: 7, now: NOW });
  assert.deepEqual(agg.perProfile.map((p) => p.name), ['Ohne Profil', 'Main neu', 'Turnier']);
  assert.equal(agg.perProfile.reduce((n, p) => n + p.sharePct, 0), 100);
  assert.deepEqual(agg.perProfile.map((p) => p.sharePct), [46, 39, 15], '46,15 / 38,46 / 15,38 -> der größte Rest bekommt den fehlenden Punkt');
  assert.equal(agg.favourite.name, 'Main neu');
  assert.equal(agg.favourite.sessions, 2);
  assert.equal(agg.longest.seconds, 3 * HOUR);
  assert.equal(agg.activeDays, 4);
  assert.equal(agg.bestDay.day, '2026-10-13');
  assert.equal(agg.avgSessionSeconds, Math.round(6.5 * HOUR / 4));

  const onlyNone = logic.aggregateSessions(logic.normalizeSessions({ list: [{ start: T(10, 13, 18), end: T(10, 13, 19) }] }, { now: NOW }), { days: 7, now: NOW });
  assert.equal(onlyNone.favourite, null);
});

test('Spielzeit: neueste Sitzungen zuerst, höchstens 8, laufende markiert', () => {
  const list = [];
  for (let d = 1; d <= 12; d++) list.push({ start: T(10, d, 18), end: T(10, d, 19), profileName: `P${d}` });
  const sessions = logic.normalizeSessions({ list, current: { start: T(10, 18, 19, 30), profileName: 'Live' } }, { now: NOW });
  const agg = logic.aggregateSessions(sessions, { days: 7, now: NOW });
  assert.equal(agg.recent.length, 8);
  assert.equal(agg.recent[0].profileName, 'Live');
  assert.equal(agg.recent[0].live, true);
  assert.equal(agg.recent[1].profileName, 'P12');
  assert.equal(agg.running, true);
  assert.equal(agg.current.seconds, 1800);
});

test('Spielzeit: Anteile nach der Methode der größten Reste', () => {
  assert.deepEqual(logic.sharePercents([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(logic.sharePercents([2, 1]), [67, 33]);
  assert.deepEqual(logic.sharePercents([0, 0]), [0, 0]);
  assert.deepEqual(logic.sharePercents([]), []);
  for (const v of [[5, 7, 11, 13], [1, 2, 3, 4, 5, 6, 7], [999, 1]]) {
    assert.equal(logic.sharePercents(v).reduce((a, b) => a + b, 0), 100);
  }
});

test('Zeitraum: nur 7 bis 90 Tage', () => {
  assert.equal(logic.normDays(7), 7);
  assert.equal(logic.normDays(90), 90);
  assert.equal(logic.normDays(1000), 90);
  assert.equal(logic.normDays(1), 7);
  assert.equal(logic.normDays('abc'), 30);
  assert.equal(logic.normDays(undefined), 30);
});

// ---------------------------------------------------------------- Trend & Aim-Tests

test('Trend: Schnitt der ersten 5 gegen die letzten 5 Tests', () => {
  const t = logic.trendOf([40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62]);
  assert.equal(t.groupSize, 5);
  assert.equal(t.first, 44);
  assert.equal(t.last, 58);
  assert.equal(t.delta, 14);
  assert.equal(t.direction, 'besser');
  assert.equal(logic.trendOf([50]), null);
  assert.equal(logic.trendOf([]), null);
  assert.equal(logic.trendOf(null), null);
  assert.equal(logic.trendOf([60, 50]).groupSize, 1, 'bei wenigen Tests kleinere Gruppen ohne Überschneidung');
  assert.equal(logic.trendOf([60, 50]).direction, 'schlechter');
  assert.equal(logic.trendOf([50, 51]).direction, 'gleich');
  assert.equal(logic.trendOf([300, 250], { threshold: 10, lowerIsBetter: true }).direction, 'besser', 'weniger ms ist besser');
  assert.equal(logic.trendOf([250, 300], { threshold: 10, lowerIsBetter: true }).direction, 'schlechter');
  assert.equal(logic.trendOf([50, null, 'x', 60]).count, 2, 'ungültige Werte werden übersprungen');
});

function aimEntry(at, score, accuracy, rec = 6.5) {
  return { at, dpi: 800, sens: 7, recommendedSens: rec, edpi: 52, cm360: 31.7, score, accuracy, hits: 50, misses: 20, trackingPct: 55, avgTtkMs: 600, rounds: [{}, {}, {}] };
}

test('Aim-Tests: ungültige Einträge fallen weg, Werte werden begrenzt und sortiert', () => {
  const list = logic.normalizeAim({
    history: [
      aimEntry(T(10, 10), 60, 140),
      { score: 50 },
      { at: T(10, 9) },
      null,
      aimEntry(T(10, 8), '55.5', 70),
    ],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].at, T(10, 8));
  assert.equal(list[0].score, 55.5);
  assert.equal(list[1].accuracy, 100);
  assert.equal(list[1].rounds, 3);
  assert.deepEqual(logic.normalizeAim(null), []);
  assert.deepEqual(logic.normalizeAim({ history: 'x' }), []);
});

test('Aim-Tests: Zeitraum, Bestwerte, Fortschritt und Rückfall auf ältere Tests', () => {
  const hist = [];
  for (let i = 0; i < 12; i++) hist.push(aimEntry(T(10, 1 + i), 40 + i * 2, 50 + i, i < 6 ? 7 : 6.5));
  const list = logic.normalizeAim({ history: hist });
  const a30 = logic.aimSummary(list, { days: 30, now: NOW });
  assert.equal(a30.total, 12);
  assert.equal(a30.inRange, 12);
  assert.equal(a30.outOfRange, false);
  assert.equal(a30.trend.direction, 'besser');
  assert.equal(a30.bestAccuracy.accuracy, 61);
  assert.equal(a30.latest.recommendedSens, 6.5);

  const a7 = logic.aimSummary(list, { days: 7, now: NOW });
  assert.equal(a7.inRange, 1, 'letzter Test am 12.10. um 0 Uhr – genau dort beginnt der 7-Tage-Zeitraum');
  assert.equal(a7.outOfRange, false);
  assert.equal(a7.points.length, 1);
  assert.equal(a7.trend, null, 'ein Test allein hat keinen Trend');

  const old = logic.aimSummary(logic.normalizeAim({ history: [aimEntry(T(8, 1), 50, 60)] }), { days: 7, now: NOW });
  assert.equal(old.outOfRange, true);
  assert.equal(old.points.length, 1);
  assert.equal(old.trend, null);

  const none = logic.aimSummary([], { days: 30, now: NOW });
  assert.equal(none.total, 0);
  assert.equal(none.outOfRange, false);
  assert.equal(none.latest, null);
  assert.equal(none.bestAccuracy, null);
});

test('Aim-Tests: höchstens 60 Punkte im Diagramm (die neuesten)', () => {
  const hist = [];
  for (let i = 0; i < 80; i++) hist.push(aimEntry(NOW - (80 - i) * 3600000, 50, 60));
  const a = logic.aimSummary(logic.normalizeAim({ history: hist }), { days: 30, now: NOW });
  assert.equal(a.points.length, 60);
  assert.equal(a.points[59].at, NOW - 3600000);
});

// ---------------------------------------------------------------- Reaktion & Ping

test('Reaktions-Labor: vorsichtig bei fehlenden Daten, Bestwerte und Trend (weniger ms = besser)', () => {
  const empty = logic.reactionSummary(null);
  assert.equal(empty.count, 0);
  assert.equal(empty.latest, null);
  assert.equal(empty.keys.count, 0);
  assert.equal(logic.reactionSummary({ reaction: 'x', keys: {} }).count, 0);

  const r = logic.reactionSummary({
    reaction: [
      { at: T(10, 3), avgMs: 260, bestMs: 230, rounds: 5, falseStarts: 1 },
      { at: T(10, 1), avgMs: 280, bestMs: 240, rounds: 5, falseStarts: 0 },
      { at: T(10, 5), avgMs: 230, bestMs: 205, rounds: 5, falseStarts: 0 },
      { at: T(10, 6), avgMs: -5 },
      { at: T(10, 7) },
      { avgMs: 200 },
    ],
    keys: [{ at: T(10, 4), avgMs: 400, accuracy: 92, count: 30 }, { at: T(10, 2), avgMs: 'x' }],
  });
  assert.equal(r.count, 3);
  assert.equal(r.latest.avgMs, 230);
  assert.equal(r.best.avgMs, 230);
  assert.equal(r.bestSingleMs, 205);
  assert.equal(r.trend.direction, 'besser');
  assert.equal(r.keys.count, 1);
  assert.equal(r.keys.latest.accuracy, 92);
});

test('Ping-Tester: nur Einträge mit bestem Server zählen', () => {
  const p = logic.pingSummary({
    history: [
      { at: T(10, 2), method: 'icmp', best: { id: 'eu', name: 'Europa', region: 'EU', ms: 21 }, results: [] },
      { at: T(10, 1), method: 'icmp', best: { id: 'eu', name: 'Europa', region: 'EU', ms: 18 } },
      { at: T(10, 3), best: null },
      { at: T(10, 4), best: { name: 'X' } },
      { at: T(10, 5), best: { region: 'NAE', ms: 95.4 } },
    ],
  });
  assert.equal(p.count, 3);
  assert.equal(p.latest.ms, 95);
  assert.equal(p.latest.name, 'NAE', 'ohne Namen wird die Region gezeigt');
  assert.equal(p.best.ms, 18);
  assert.equal(logic.pingSummary(undefined).count, 0);
  assert.equal(logic.pingSummary({ history: null }).latest, null);
});

// ---------------------------------------------------------------- Cockpit-Zeile & Gesamtansicht

test('Cockpit-Zeile: Spielzeit dieser Woche, sonst Aim-Test, sonst nichts', () => {
  const s = logic.normalizeSessions({ list: [{ start: T(10, 13, 18), end: T(10, 13, 18) + (6 * HOUR + 20 * 60) * 1000 }] }, { now: NOW });
  assert.deepEqual(logic.summaryLine({ sessions: s, now: NOW }), { text: 'Diese Woche 6 Std. 20 Min. gespielt' });
  const old = logic.normalizeSessions({ list: [{ start: T(10, 1, 18), end: T(10, 1, 19) }] }, { now: NOW });
  assert.deepEqual(logic.summaryLine({ sessions: old, now: NOW }), { text: 'Diese Woche noch nicht gespielt' });
  const aim = logic.normalizeAim({ history: [aimEntry(T(10, 1), 61.6, 70)] });
  assert.deepEqual(logic.summaryLine({ sessions: [], aim, now: NOW }), { text: 'Letzter Aim-Test: 62 Punkte' });
  assert.equal(logic.summaryLine({ sessions: [], aim: [], now: NOW }), null);
  assert.equal(logic.summaryLine(), null);
});

test('Gesamtansicht: komplett leere Zustände führen zu keinem Fehler', () => {
  const o = logic.buildOverview({ sessionsRaw: null, sensi: null, reaktion: undefined, ping: 'kaputt', days: 30, now: NOW });
  assert.equal(o.days, 30);
  assert.equal(o.hasSessions, false);
  assert.equal(o.hasAnyData, false);
  assert.equal(o.play.daily.length, 30);
  assert.equal(o.play.totalSeconds, 0);
  assert.equal(o.play.longest, null);
  assert.equal(o.play.favourite, null);
  assert.equal(o.aim.total, 0);
  assert.equal(o.reaction.count, 0);
  assert.equal(o.ping.count, 0);
  assert.equal(o.summary, null);
  assert.doesNotThrow(() => JSON.stringify(o));
  assert.equal(logic.buildOverview({ days: 999, now: NOW }).play.daily.length, 90);
});

test('Format: Dauer und Datum auf Deutsch', () => {
  assert.equal(logic.fmtDuration(6 * HOUR + 20 * 60), '6 Std. 20 Min.');
  assert.equal(logic.fmtDuration(2 * HOUR), '2 Std.');
  assert.equal(logic.fmtDuration(20 * 60 + 30), '20 Min.');
  assert.equal(logic.fmtDuration(45), '45 Sek.');
  assert.equal(logic.fmtDuration(0), '0 Min.');
  assert.equal(logic.fmtDuration(-5), '0 Min.');
  assert.equal(logic.fmtDateTime(T(10, 7, 9, 5)), '07.10.2026 09:05');
  assert.equal(logic.csvFileName(NOW), 'HELIX-Statistik-2026-10-18.csv');
});

// ---------------------------------------------------------------- CSV

test('CSV: deutsches Excel – BOM, Semikolon, Komma, Windows-Zeilenenden, deutsche Überschriften', () => {
  const sessions = logic.normalizeSessions({
    list: [
      { start: T(10, 17, 18), end: T(10, 17, 20, 5), profileId: 'p1', profileName: 'Main; "Pro"' },
      { start: T(10, 16, 18), end: T(10, 16, 19), profileName: '=HYPERLINK("http://x")', recovered: true },
    ],
  }, { now: NOW });
  const aim = logic.normalizeAim({ history: [aimEntry(T(10, 15, 17, 30), 62.25, 71.5, 6.5)] });
  const reaction = logic.normalizeReaction({ reaction: [{ at: T(10, 14, 12), avgMs: 231, bestMs: 205, rounds: 5, falseStarts: 1 }] }).reaction;
  const csv = logic.buildCsv({ sessions, aim, reaction, now: NOW });
  assert.equal(csv.charCodeAt(0), 0xfeff, 'UTF-8-BOM für Umlaute in Excel');
  assert.ok(csv.endsWith('\r\n'));
  assert.doesNotMatch(csv.replace(/\r\n/g, ''), /\n/, 'nur Windows-Zeilenenden');
  const lines = csv.slice(1).split('\r\n');
  assert.ok(lines.includes('Beginn;Ende;Dauer (Minuten);Dauer;Profil;Hinweis'));
  assert.ok(lines.includes('Datum;Punkte (0-100);Trefferquote (%);Treffer;Fehlschüsse;Tracking (%);Zeit bis Treffer (ms);Getestete Sensi;Empfohlene Sensi;DPI;eDPI;cm pro 360°'));
  assert.ok(lines.includes('Datum;Durchschnitt (ms);Bester Wert (ms);Runden;Frühstarts'));
  assert.ok(lines.includes('16.10.2026 18:00;16.10.2026 19:00;60;1 Std.;"\'=HYPERLINK(""http://x"")";Ende geschätzt (HELIX wurde unerwartet beendet)'),
    'Formeln werden entschärft und Anführungszeichen verdoppelt');
  assert.ok(lines.includes('17.10.2026 18:00;17.10.2026 20:05;125;2 Std. 5 Min.;"Main; ""Pro""";'));
  assert.ok(lines.includes('15.10.2026 17:30;62,3;71,5;50;20;55;600;7;6,5;800;52;31,7'), 'Dezimalkomma');
  assert.ok(lines.includes('14.10.2026 12:00;231;205;5;1'));
  assert.ok(lines.indexOf('Spielzeiten') < lines.indexOf('Aim-Tests'));
});

test('CSV: ohne Werte gibt es verständliche Platzhalter, ohne Reaktionstests keinen Block dafür', () => {
  const csv = logic.buildCsv({ now: NOW });
  assert.match(csv, /Noch keine Sitzungen gezählt/);
  assert.match(csv, /Noch keine Aim-Tests/);
  assert.doesNotMatch(csv, /Reaktionstests/);
  assert.equal(logic.csvCell(null), '');
  assert.equal(logic.csvCell('-5'), '-5', 'Zahlenspalten bleiben Zahlen');
  assert.equal(logic.csvCell('-5', { isText: true }), "'-5");
  assert.equal(logic.csvCell('@x', { isText: true }), "'@x");
  assert.equal(logic.deNum(6.456, 2), '6,46');
  assert.equal(logic.deNum(null), '');
  assert.equal(logic.deNum('abc'), '');
});

// ---------------------------------------------------------------- Modul (mit nachgemachtem ctx)

function fakeCtx({ states = {}, profiles = [], dialogResult = { canceled: true }, failRead = null, isWin = true, docs } = {}) {
  const reads = [];
  const dialogCalls = [];
  const forbidden = (what) => () => { throw new Error(`verboten: ${what}`); };
  const ctx = {
    env: { USERPROFILE: docs || os.tmpdir() },
    log: () => {},
    core: {
      readState: async (name, fb) => {
        reads.push(name);
        if (failRead === name) throw Object.assign(new Error('kaputt'), { code: 'EIO' });
        return Object.prototype.hasOwnProperty.call(states, name) ? states[name] : fb;
      },
      writeState: forbidden('writeState'),
      applyIniChanges: forbidden('applyIniChanges'),
      previewIniChanges: forbidden('previewIniChanges'),
      ensureFortniteClosed: forbidden('ensureFortniteClosed'),
      listProfiles: async () => profiles,
    },
    sessions: { summary: async () => ({ running: false, recent: [{ start: T(10, 17, 18), end: T(10, 17, 19), profileName: 'Aus Zähler' }] }) },
    exec: { IS_WIN: isWin, run: forbidden('run'), powershell: forbidden('powershell') },
    registry: { writeValue: forbidden('registry') },
    processes: { closeByName: forbidden('closeByName'), closeByPid: forbidden('closeByPid') },
    electron: {
      app: { getPath: (n) => { assert.equal(n, 'documents'); return docs || os.tmpdir(); } },
      dialog: { showSaveDialog: async (...a) => { dialogCalls.push(a); return dialogResult; } },
      getWindow: () => null,
    },
  };
  return { ctx, reads, dialogCalls };
}

const STATES = {
  sessions: { list: [{ start: T(10, 17, 18), end: T(10, 17, 20), profileId: 'p1', profileName: 'Alt' }], current: null },
  'tool-sensi': { settings: { dpi: 800, sens: 6.5 }, history: [aimEntry(T(10, 15, 17), 60, 70)] },
  'tool-reaktion': { reaction: [{ at: T(10, 14), avgMs: 240, bestMs: 210, rounds: 5, falseStarts: 0 }], keys: [], binds: {} },
  'tool-ping': { history: [{ at: T(10, 14), method: 'icmp', best: { id: 'eu', name: 'Europa', region: 'EU', ms: 19 }, results: [] }] },
};

test('Modul: id und Handler', () => {
  assert.equal(mod.id, 'stats');
  assert.deepEqual(Object.keys(mod.handlers).sort(), ['exportCsv', 'overview', 'summary']);
  for (const name of Object.keys(mod.handlers)) assert.match(`${mod.id}.${name}`, /^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/);
});

test('Modul: overview liest nur die erlaubten Zustände und schreibt nichts', async () => {
  const { ctx, reads } = fakeCtx({ states: STATES, profiles: [{ id: 'p1', name: 'Main' }] });
  const o = await mod._test.overview({ days: 7 }, ctx, NOW);
  assert.deepEqual([...reads].sort(), ['sessions', 'tool-ping', 'tool-reaktion', 'tool-sensi']);
  assert.equal(o.days, 7);
  assert.equal(o.play.totalSeconds, 2 * HOUR);
  assert.equal(o.play.favourite.name, 'Main', 'aktueller Profilname');
  assert.equal(o.aim.total, 1);
  assert.equal(o.reaction.count, 1);
  assert.equal(o.ping.latest.name, 'Europa');
  assert.equal(o.trackingSupported, true);
  const viaRouter = await mod.handlers.overview({ days: 30 }, ctx);
  assert.equal(viaRouter.days, 30);
});

test('Modul: ein kaputter Zustand eines anderen Tools stört die Übersicht nicht', async () => {
  const { ctx } = fakeCtx({ states: STATES, failRead: 'tool-sensi' });
  const o = await mod._test.overview({ days: 30 }, ctx, NOW);
  assert.equal(o.aim.total, 0);
  assert.equal(o.play.sessionCount, 1);
  const { ctx: c2 } = fakeCtx({ states: { 'tool-sensi': { history: [{ at: 'x' }, 5, null] }, 'tool-ping': { history: [{}] } } });
  const o2 = await mod._test.overview({ days: 'x' }, c2, NOW);
  assert.equal(o2.days, 30);
  assert.equal(o2.aim.total, 0);
});

test('Modul: ohne gespeicherten Zählerstand wird ctx.sessions.summary() benutzt; Nicht-Windows wird gemeldet', async () => {
  const { ctx } = fakeCtx({ states: {}, isWin: false });
  const o = await mod._test.overview({ days: 7 }, ctx, NOW);
  assert.equal(o.play.sessionCount, 1);
  assert.equal(o.play.recent[0].profileName, 'Aus Zähler');
  assert.equal(o.trackingSupported, false);
});

test('Modul: summary liefert die Cockpit-Zeile oder null', async () => {
  const { ctx } = fakeCtx({ states: { sessions: { list: [{ start: T(10, 13, 18), end: T(10, 13, 18) + (6 * HOUR + 20 * 60) * 1000 }] } } });
  assert.deepEqual(await mod._test.summary({}, ctx, NOW), { text: 'Diese Woche 6 Std. 20 Min. gespielt' });
  const { ctx: empty } = fakeCtx({ states: { sessions: { list: [] } } });
  assert.equal(await mod._test.summary({}, empty, NOW), null);
});

test('Modul: exportCsv speichert die Tabelle dort, wo der Nutzer es im Dialog wählt', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'meine-statistik');
  const { ctx, dialogCalls } = fakeCtx({ states: STATES, profiles: [{ id: 'p1', name: 'Main' }], docs: dir, dialogResult: { canceled: false, filePath: target } });
  const r = await mod._test.exportCsv({}, ctx, NOW);
  assert.equal(r.canceled, false);
  assert.equal(r.file, `${target}.csv`, '.csv wird ergänzt');
  assert.equal(r.fileName, 'meine-statistik.csv');
  assert.equal(r.sessions, 1);
  assert.equal(r.aimTests, 1);
  assert.equal(r.reactionTests, 1);
  const text = fs.readFileSync(r.file, 'utf8');
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.match(text, /17\.10\.2026 18:00;17\.10\.2026 20:00;120;2 Std\.;Main;/);
  assert.equal(dialogCalls.length, 1);
  const opts = dialogCalls[0][0];
  assert.equal(opts.defaultPath, path.join(dir, 'HELIX-Statistik-2026-10-18.csv'));
  assert.deepEqual(opts.filters[0].extensions, ['csv']);
  assert.deepEqual(fs.readdirSync(dir), ['meine-statistik.csv'], 'keine weiteren Dateien');
});

test('Modul: exportCsv – Abbrechen, keine Daten, Schreibfehler', async () => {
  const dir = tmpDir();
  const { ctx } = fakeCtx({ states: STATES, docs: dir, dialogResult: { canceled: true } });
  assert.deepEqual(await mod._test.exportCsv({}, ctx, NOW), { canceled: true });
  assert.deepEqual(fs.readdirSync(dir), []);

  const { ctx: none, dialogCalls } = fakeCtx({ states: { sessions: { list: [] } }, docs: dir });
  await assert.rejects(mod._test.exportCsv({}, none, NOW), (e) => e.code === 'NO_DATA' && /Aim-Test/.test(e.message));
  assert.equal(dialogCalls.length, 0, 'ohne Daten kein Dialog');

  const { ctx: bad } = fakeCtx({ states: STATES, docs: dir, dialogResult: { canceled: false, filePath: path.join(dir, 'fehlt', 'x.csv') } });
  await assert.rejects(mod._test.exportCsv({}, bad, NOW), (e) => e.code === 'WRITE_FAILED');
});

test('Sicherheit: die Statistik schreibt nur die gewählte CSV-Datei und fasst nichts anderes an', () => {
  const src = ['src/main/modules/tools/stats.js', 'src/main/tools/stats-logic.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '')).join('\n');
  for (const bad of [/writeState/, /applyIniChanges/, /registry\./, /exec\.(run|powershell)/, /closeBy/, /Engine\.ini/, /EasyAntiCheat|BattlEye|_EAC/, /[\\/]Logs/, /innerHTML/]) {
    assert.doesNotMatch(src, bad, String(bad));
  }
  const view = fs.readFileSync(path.join(ROOT, 'src/renderer/js/views/stats.js'), 'utf8');
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|outerHTML/);
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/css/tools/stats.css'), 'utf8');
  for (const line of css.split('\n')) {
    const sel = line.trim();
    if (!sel || sel.startsWith('/*') || sel.startsWith('}') || sel.startsWith('@media') || !sel.includes('{')) continue;
    for (const part of sel.split('{')[0].split(',')) assert.ok(part.trim().startsWith('[data-tool="stats"]'), `CSS-Regel ohne Tool-Präfix: ${part}`);
  }
});

// ---------------------------------------------------------------- Diagramm-Helfer (Oberfläche)

test('Diagramm: Achsen-Einteilung für Spielzeiten', async () => {
  const c = await chartLib();
  assert.deepEqual(c.niceDurationTicks(0), { step: 1800, max: 3600, ticks: [0, 1800, 3600] });
  const a = c.niceDurationTicks(5000);
  assert.equal(a.step, 1800);
  assert.equal(a.max, 5400);
  assert.deepEqual(a.ticks, [0, 1800, 3600, 5400]);
  const b = c.niceDurationTicks(3 * HOUR + 100);
  assert.equal(b.step, 3600);
  assert.equal(b.max, 4 * HOUR);
  for (const m of [1, 59, 600, 7000, 20000, 50000, 90000]) {
    const t = c.niceDurationTicks(m);
    assert.ok(t.max >= m, `max >= ${m}`);
    assert.ok(t.ticks.length <= 5, `höchstens 5 Linien bei ${m}`);
  }
  assert.equal(c.fmtAxisDuration(0), '0');
  assert.equal(c.fmtAxisDuration(1800), '30 Min.');
  assert.equal(c.fmtAxisDuration(3600), '1 Std.');
  assert.equal(c.fmtAxisDuration(5400), '1,5 Std.');
});

test('Diagramm: Zahlen, Dauer und Datum auf Deutsch', async () => {
  const c = await chartLib();
  assert.equal(c.fmtNum(6.5, 1), '6,5');
  assert.equal(c.fmtNum(6.5, 2), '6,5');
  assert.equal(c.fmtNum(52, 1), '52');
  assert.equal(c.fmtNum(31.66, 1), '31,7');
  assert.equal(c.fmtNum(-0.04, 1), '0');
  assert.equal(c.fmtNum(NaN), '–');
  assert.equal(c.fmtNum(null), '–');
  assert.equal(c.fmtDur(6 * HOUR + 20 * 60), '6 Std. 20 Min.');
  assert.equal(c.fmtDur(0), '0 Min.');
  assert.equal(c.fmtDurNb(2 * HOUR + 60), '2\u00a0Std.\u00a01\u00a0Min.', 'kein Umbruch mitten in der Zeit');
  assert.equal(c.fmtSens(7), '7,0');
  assert.equal(c.fmtSens(6.5), '6,5');
  assert.equal(c.fmtSens(6.25), '6,25');
  assert.equal(c.fmtSens(null), '–');
  assert.equal(c.fmtDay('2026-10-18', 'weekday'), 'So 18.10.');
  assert.equal(c.fmtDay('2026-10-18', 'long'), 'Sonntag, 18.10.2026');
  assert.equal(c.fmtDay(T(10, 5, 9, 7), 'time'), '09:07');
  assert.equal(c.fmtDay('kaputt', 'short'), '–');
  assert.equal(c.fmtSpan(T(10, 17, 23, 10), T(10, 18, 1, 5)), 'Sa 17.10. · 23:10–01:05');
  assert.equal(c.signed(8, 'Punkte'), '+8 Punkte');
  assert.equal(c.signed(-3.2, 'Punkte'), '−3 Punkte');
  assert.equal(c.signed(0.2, 'Punkte'), '±0 Punkte');
  assert.equal(c.baseName('C:\\Users\\Spieler\\Documents\\a.csv'), 'a.csv');
  assert.equal(c.baseName('/home/x/b.csv'), 'b.csv');
});

test('Diagramm: Beschriftungen überlappen nicht, der neueste Tag ist immer beschriftet', async () => {
  const c = await chartLib();
  assert.equal(c.labelStep(90, 9.5, 46), 5);
  assert.equal(c.labelStep(7, 120, 62), 1);
  assert.equal(c.labelStep(0, 10), 1);
  assert.deepEqual(c.labelIndices(10, 3), [0, 3, 6, 9]);
  assert.deepEqual(c.labelIndices(5, 1), [0, 1, 2, 3, 4]);
  for (const n of [7, 30, 90]) {
    const idx = c.labelIndices(n, c.labelStep(n, 800 / n, 46));
    assert.equal(idx[idx.length - 1], n - 1);
    for (let i = 1; i < idx.length; i++) assert.ok((idx[i] - idx[i - 1]) * (800 / n) >= 46);
  }
});

test('Diagramm: Sensi-Beschriftung bei Wechsel und am Ende, mit Mindestabstand', async () => {
  const c = await chartLib();
  assert.deepEqual(c.pickLabelIndices([6.5, 6.5, 6.5, 6.3, 6.3], [0, 40, 80, 120, 160], 34), [0, 3, 4]);
  assert.deepEqual(c.pickLabelIndices([7, 7, 6.8, 6.8, 6.5], [0, 10, 20, 30, 40], 34), [0, 4]);
  assert.deepEqual(c.pickLabelIndices([7, 7, 6.8, 6.8, 6.5], [0, 8, 16, 24, 32], 34), [4], 'zu eng: nur der neueste Wert');
  assert.deepEqual(c.pickLabelIndices([null, 6.5, 6.5], [0, 50, 100], 34), [1, 2]);
  assert.deepEqual(c.pickLabelIndices([], [], 34), []);
  assert.deepEqual(c.pickLabelIndices([6.5], [10], 34), [0]);
});

test('Diagramm: Wertebereich und Linienpfad', async () => {
  const c = await chartLib();
  const r = c.valueRange([200, 210, 220], { unit: 10, minSpan: 40 });
  assert.ok(r.min <= 200 && r.max >= 220);
  assert.equal(r.min % 10, 0);
  assert.equal(r.max % 10, 0);
  assert.ok(r.max - r.min >= 40);
  assert.deepEqual(c.valueRange([], { minSpan: 20 }), { min: 0, max: 20 });
  assert.ok(c.valueRange([3, 4], { unit: 5, minSpan: 10 }).min >= 0, 'nie unter 0');
  assert.equal(c.linePath([{ x: 0, y: 0 }, { x: 1.234, y: 2 }]), 'M0 0 L1.23 2');
  assert.equal(c.linePath([{ x: 0, y: 0 }, null, { x: 2, y: 2 }, { x: 3, y: NaN }]), 'M0 0 M2 2');
  assert.equal(c.linePath([]), '');
  const sc = c.scaleLinear(0, 100, 200, 0);
  assert.equal(sc(0), 200);
  assert.equal(sc(50), 100);
  assert.equal(c.scaleLinear(5, 5, 0, 10)(5), 0, 'keine Division durch 0');
});

test('Diagramm: Plaketten für Wochenvergleich und Trend', async () => {
  const c = await chartLib();
  assert.deepEqual(c.weekBadge({ trend: 'mehr', deltaSeconds: 3600 }), { text: '1 Std. mehr', type: 'accent' });
  assert.deepEqual(c.weekBadge({ trend: 'weniger', deltaSeconds: -1800 }), { text: '30 Min. weniger', type: '' });
  assert.deepEqual(c.weekBadge({ trend: 'gleich', deltaSeconds: 60 }), { text: 'etwa gleich viel', type: '' });
  assert.equal(c.weekBadge(null), null);
  assert.deepEqual(c.trendBadge({ direction: 'besser' }), { text: 'besser', type: 'ok' });
  assert.deepEqual(c.trendBadge({ direction: 'schlechter' }, { worseText: 'langsamer' }), { text: 'langsamer', type: 'warn' });
  assert.equal(c.trendBadge(null), null);
});

// ---------------------------------------------------------------- Simulator hat dieselbe Form

function shape(o, depth = 0) {
  if (o == null || typeof o !== 'object' || depth > 3) return typeof o === 'object' ? 'obj' : 'val';
  if (Array.isArray(o)) return o.length ? [shape(o[0], depth + 1)] : [];
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = shape(o[k], depth + 1);
  return out;
}

test('Simulator: liefert dieselbe Datenform wie der Hauptprozess', async () => {
  const prev = globalThis.location;
  globalThis.location = { search: '' };
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/mock/stats.js'), 'utf8');
    const mock = (await import(`data:text/javascript,${encodeURIComponent(src)}`)).default;
    const mctx = { wait: async () => {}, db: { fortnite: { running: true } } };
    const m = await mock.overview({ days: 30 }, mctx);

    // reichhaltige echte Daten, damit alle Felder belegt sind
    const now = Date.now();
    const list = [];
    for (let i = 1; i < 20; i++) list.push({ start: now - i * 86400000, end: now - i * 86400000 + 3600000, profileId: i % 3 ? 'p1' : null, profileName: 'Main', recovered: i === 3 });
    const hist = [];
    for (let i = 0; i < 12; i++) hist.push(aimEntry(now - (12 - i) * 86400000, 50 + i, 60 + i));
    const real = logic.buildOverview({
      sessionsRaw: { list, current: { start: now - 600000, profileId: 'p1', profileName: 'Main' } },
      sensi: { history: hist },
      reaktion: { reaction: [{ at: now - 86400000, avgMs: 240, bestMs: 210, rounds: 5, falseStarts: 0 }, { at: now - 3600000, avgMs: 230, bestMs: 200, rounds: 5, falseStarts: 1 }], keys: [{ at: now - 3600000, avgMs: 380, accuracy: 93, count: 30 }] },
      ping: { history: [{ at: now - 86400000, method: 'icmp', best: { id: 'eu', name: 'Europa', region: 'EU', ms: 20 } }, { at: now - 3600000, method: 'icmp', best: { id: 'eu', name: 'Europa', region: 'EU', ms: 18 } }] },
      days: 30,
      now,
    });
    assert.deepEqual(shape(m), shape(real));

    const exp = await mock.exportCsv({}, mctx);
    assert.equal(exp.canceled, false);
    assert.match(exp.fileName, /^HELIX-Statistik-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.match((await mock.summary({}, mctx)).text, /^Diese Woche /);

    globalThis.location = { search: '?statsEmpty' };
    const e = await mock.overview({ days: 7 }, mctx);
    assert.equal(e.hasAnyData, false);
    assert.equal(e.play.daily.length, 7);
    assert.deepEqual(Object.keys(e.play).sort(), Object.keys(real.play).sort());
  } finally {
    globalThis.location = prev;
  }
});
