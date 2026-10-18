// Simulator für die Session-Statistik (nur Browser-Vorschau).
// Erzeugt feste, realistische Beispieldaten (immer gleich, relativ zu "jetzt") und rechnet daraus
// dieselbe Antwort-Form wie der Hauptprozess (src/main/tools/stats-logic.js -> buildOverview).
// ?statsEmpty in der Adresse zeigt die leeren Zustände.

const DAY = 86400000;
const MIN = 60000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOfDay = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const addDays = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const startOfWeek = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime(); };
const overlap = (s, a, b) => Math.max(0, Math.min(s.end, b) - Math.max(s.start, a)) / 1000;
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const empty = () => new URLSearchParams(location.search).has('statsEmpty');

const PROFILES = [
  { id: 'p-main-1a2b3c', name: 'Main', w: 0.64 },
  { id: 'p-turnier-778899', name: 'Turnier', w: 0.2 },
  { id: 'p-zweitaccount-4d5e6f', name: 'Zweitaccount', w: 0.11 },
  { id: null, name: 'Ohne Profil', w: 0.05 },
];

function makeSessions(now, running) {
  const r = rng(4711);
  const list = [];
  const today = startOfDay(now);
  for (let i = 75; i >= 0; i--) {
    const day = addDays(today, -i);
    const wd = new Date(day).getDay();
    const weekend = wd === 0 || wd === 6;
    if (r() < (weekend ? 0.12 : 0.3)) continue; // freie Tage
    const count = 1 + (r() < (weekend ? 0.55 : 0.3) ? 1 : 0) + (weekend && r() < 0.25 ? 1 : 0);
    let t = day + (weekend ? 13 : 16) * 3600000 + Math.floor(r() * 3) * 3600000 + Math.floor(r() * 50) * MIN;
    for (let k = 0; k < count; k++) {
      const dur = (24 + Math.floor(r() * (weekend ? 130 : 95))) * MIN;
      const pick = r();
      let acc = 0;
      const p = PROFILES.find((x) => { acc += x.w; return pick < acc; }) || PROFILES[0];
      const s = { start: t, end: t + dur, profileId: p.id, profileName: p.id ? p.name : null };
      if (s.end < now - 5 * MIN) list.push(s);
      t = s.end + (20 + Math.floor(r() * 90)) * MIN;
    }
  }
  if (list.length > 6) list[list.length - 6].recovered = true;
  const current = running ? { start: now - 42 * MIN, lastSeen: now, profileId: 'p-main-1a2b3c', profileName: 'Main' } : null;
  return { list, current };
}

function makeAim(now) {
  const r = rng(99);
  const recs = [7.2, 7.0, 7.0, 6.8, 6.8, 6.5, 6.5, 6.5, 6.4, 6.5, 6.5, 6.3, 6.3, 6.3];
  let sens = 8.0;
  return recs.map((rec, i) => {
    const at = startOfDay(now) - (27 - i * 2) * DAY + (17 + Math.floor(r() * 5)) * 3600000 + Math.floor(r() * 59) * MIN;
    const score = Math.round((47 + i * 1.4 + (r() - 0.5) * 7) * 10) / 10;
    const accuracy = Math.round((57 + i * 1.1 + (r() - 0.5) * 6) * 10) / 10;
    const dpi = 800;
    const e = {
      at, dpi, recommendedDpi: dpi, sens, recommendedSens: rec, edpi: Math.round(dpi * rec / 10) / 10,
      cm360: Math.round((2.54 * 360 / (rec * 0.005555 * dpi)) * 10) / 10,
      score, accuracy, hits: 60 + Math.floor(r() * 20), misses: 18 + Math.floor(r() * 10),
      trackingPct: Math.round((52 + i * 1.2 + (r() - 0.5) * 6) * 10) / 10, avgTtkMs: Math.round(640 - i * 9 + (r() - 0.5) * 40), rounds: 5,
    };
    sens = rec;
    return e;
  });
}

function makeReaction(now) {
  const r = rng(7);
  const reaction = Array.from({ length: 11 }, (_, i) => {
    const avgMs = Math.round(248 - i * 3.2 + (r() - 0.5) * 14);
    return { at: now - (24 - i * 2.2) * DAY, avgMs, bestMs: avgMs - 22 - Math.floor(r() * 14), rounds: 5, falseStarts: r() < 0.25 ? 1 : 0 };
  });
  const keys = Array.from({ length: 6 }, (_, i) => ({ at: now - (20 - i * 3) * DAY, avgMs: Math.round(430 - i * 16 + (r() - 0.5) * 20), accuracy: Math.round((87 + i * 1.6) * 10) / 10, count: 30 }));
  return { reaction, keys };
}

function makePing(now) {
  const r = rng(31);
  return {
    history: Array.from({ length: 8 }, (_, i) => ({
      at: now - (26 - i * 3.4) * DAY,
      method: 'ping',
      best: { id: 'eu', name: 'Europa', region: 'EU', ms: Math.round(17 + r() * 9) },
      results: [],
    })),
  };
}

// ---------- gleiche Rechnung wie im Hauptprozess (gekürzt) ----------

function shares(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const base = raw.map(Math.floor);
  let rest = 100 - base.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest > 0) { base[i]++; rest--; } });
  return base;
}

function trend(values, { threshold = 2, lowerIsBetter = false } = {}) {
  if (values.length < 2) return null;
  const g = Math.max(1, Math.min(5, Math.floor(values.length / 2)));
  const avg = (l) => l.reduce((a, b) => a + b, 0) / l.length;
  const first = avg(values.slice(0, g));
  const last = avg(values.slice(-g));
  const delta = last - first;
  const direction = Math.abs(delta) < threshold ? 'gleich' : (delta > 0) !== lowerIsBetter ? 'besser' : 'schlechter';
  return { first: Math.round(first * 10) / 10, last: Math.round(last * 10) / 10, delta: Math.round(delta * 10) / 10, groupSize: g, count: values.length, direction };
}

const fmtDur = (sec) => { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); return h ? (m ? `${h} Std. ${m} Min.` : `${h} Std.`) : `${m} Min.`; };

function overview(days, now, running) {
  const none = empty();
  const raw = none ? { list: [], current: null } : makeSessions(now, running);
  const sessions = [...raw.list, ...(raw.current ? [{ ...raw.current, end: now, live: true }] : [])]
    .map((x) => ({ start: x.start, end: x.end, seconds: Math.round((x.end - x.start) / 1000), profileId: x.profileId, profileName: x.profileName || 'Ohne Profil', live: !!x.live, recovered: !!x.recovered }));
  const from = addDays(startOfDay(now), -(days - 1));
  const daily = Array.from({ length: days }, (_, i) => ({ day: dayKey(addDays(from, i)), start: addDays(from, i), end: addDays(from, i + 1), seconds: 0, sessions: 0 }));
  const inRange = sessions.filter((x) => overlap(x, from, now) > 0);
  for (const x of inRange) {
    for (const d of daily) {
      d.seconds += overlap(x, d.start, d.end);
      const c = Math.max(x.start, from);
      if (c >= d.start && c < d.end) d.sessions++;
    }
  }
  daily.forEach((d) => { d.seconds = Math.round(d.seconds); });
  const total = Math.round(inRange.reduce((n, x) => n + overlap(x, from, now), 0));
  const map = new Map();
  for (const x of inRange) {
    const k = x.profileId || 'ohne';
    const p = map.get(k) || { profileId: x.profileId, name: x.profileName, seconds: 0, sessions: 0 };
    p.seconds += overlap(x, from, now);
    p.sessions++;
    map.set(k, p);
  }
  const perProfile = [...map.values()].map((p) => ({ ...p, seconds: Math.round(p.seconds) })).sort((a, b) => b.seconds - a.seconds);
  shares(perProfile.map((p) => p.seconds)).forEach((v, i) => { perProfile[i].sharePct = v; });
  const fav = perProfile.find((p) => p.profileId) || null;
  const longest = inRange.reduce((m, x) => (!m || x.seconds > m.seconds ? x : m), null);
  const ws = startOfWeek(now);
  const lws = addDays(ws, -7);
  const thisW = Math.round(sessions.reduce((n, x) => n + overlap(x, ws, now), 0));
  const lastW = Math.round(sessions.reduce((n, x) => n + overlap(x, lws, ws), 0));
  const lastSame = Math.round(sessions.reduce((n, x) => n + overlap(x, lws, lws + (now - ws)), 0));
  const delta = thisW - lastSame;
  const activeDays = daily.filter((d) => d.seconds > 0).length;
  const best = daily.reduce((m, d) => (d.seconds > 0 && (!m || d.seconds > m.seconds) ? d : m), null);
  const live = sessions.find((x) => x.live);

  const aimAll = none ? [] : makeAim(now);
  const aimIn = aimAll.filter((e) => e.at >= from);
  const aimShown = aimIn.length ? aimIn : aimAll;
  const maxBy = (l, k, low) => l.reduce((m, e) => (!m || (low ? e[k] < m[k] : e[k] > m[k]) ? e : m), null);
  const re = none ? { reaction: [], keys: [] } : makeReaction(now);
  const last = (l) => (l.length ? l[l.length - 1] : null);
  const ping = (none ? [] : makePing(now).history).map((e) => ({ at: e.at, ms: e.best.ms, name: e.best.name, region: e.best.region, method: e.method }));

  return {
    generatedAt: now,
    days,
    trackingSupported: true,
    hasSessions: sessions.length > 0,
    hasAnyData: sessions.length > 0 || aimAll.length > 0 || re.reaction.length > 0 || re.keys.length > 0 || ping.length > 0,
    play: {
      days, from, to: now, totalSeconds: total,
      allTimeSeconds: sessions.reduce((n, x) => n + x.seconds, 0), allTimeSessions: sessions.length,
      sessionCount: inRange.length, avgSessionSeconds: inRange.length ? Math.round(total / inRange.length) : 0,
      activeDays, avgActiveDaySeconds: activeDays ? Math.round(total / activeDays) : 0,
      bestDay: best ? { day: best.day, start: best.start, seconds: best.seconds } : null,
      longest: longest ? { start: longest.start, end: longest.end, seconds: longest.seconds, profileName: longest.profileName, live: longest.live, recovered: longest.recovered } : null,
      week: { start: ws, thisSeconds: thisW, lastSeconds: lastW, lastSameTimeSeconds: lastSame, deltaSeconds: delta, trend: Math.abs(delta) < Math.max(600, lastSame * 0.1) ? 'gleich' : delta > 0 ? 'mehr' : 'weniger', weekdayName: WEEKDAYS[new Date(now).getDay()] },
      perProfile,
      favourite: fav,
      daily: daily.map(({ day, start, seconds, sessions: n }) => ({ day, start, seconds, sessions: n })),
      recent: sessions.slice(-8).reverse().map((x) => ({ start: x.start, end: x.end, seconds: x.seconds, profileName: x.profileName, live: x.live, recovered: x.recovered })),
      running: !!live,
      current: live ? { start: live.start, seconds: live.seconds, profileName: live.profileName } : null,
    },
    aim: {
      total: aimAll.length, inRange: aimIn.length, outOfRange: !aimIn.length && aimAll.length > 0,
      points: aimShown, trend: trend(aimShown.map((e) => e.score)), accuracyTrend: trend(aimShown.map((e) => e.accuracy)),
      bestAccuracy: maxBy(aimShown, 'accuracy'), bestScore: maxBy(aimShown, 'score'), latest: last(aimAll),
    },
    reaction: {
      count: re.reaction.length, points: re.reaction, latest: last(re.reaction), best: maxBy(re.reaction, 'avgMs', true),
      bestSingleMs: re.reaction.length ? Math.min(...re.reaction.map((e) => e.bestMs)) : null, trend: trend(re.reaction.map((e) => e.avgMs), { threshold: 10, lowerIsBetter: true }),
      keys: { count: re.keys.length, latest: last(re.keys), best: maxBy(re.keys, 'avgMs', true), points: re.keys },
    },
    ping: { count: ping.length, points: ping, latest: last(ping), best: maxBy(ping, 'ms', true), trend: trend(ping.map((e) => e.ms), { threshold: 5, lowerIsBetter: true }) },
    summary: thisW >= 60 ? { text: `Diese Woche ${fmtDur(thisW)} gespielt` } : sessions.length ? { text: 'Diese Woche noch nicht gespielt' } : null,
  };
}

export default {
  async overview(args, mctx) {
    await mctx.wait(250);
    const days = [7, 30, 90].includes(Number(args.days)) ? Number(args.days) : 30;
    return overview(days, Date.now(), !!mctx.db?.fortnite?.running);
  },
  async exportCsv(_args, mctx) {
    await mctx.wait(500);
    if (empty()) { const e = new Error('Es gibt noch keine Werte zum Speichern. Spiele zuerst eine Runde Fortnite, während HELIX läuft, oder mach einen Aim-Test.'); e.code = 'NO_DATA'; throw e; }
    const o = overview(90, Date.now(), false);
    const name = `HELIX-Statistik-${dayKey(Date.now())}.csv`;
    return { canceled: false, file: `C:\\Users\\Spieler\\Documents\\${name}`, fileName: name, sessions: o.play.allTimeSessions, aimTests: o.aim.total, reactionTests: o.reaction.count, keyTests: o.reaction.keys.count, pingTests: o.ping.count };
  },
  async summary(_args, mctx) {
    if (empty()) return null;
    return overview(7, Date.now(), !!mctx.db?.fortnite?.running).summary;
  },
};
