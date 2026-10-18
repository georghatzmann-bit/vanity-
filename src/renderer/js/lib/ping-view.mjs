// Ping-Tester: reine Anzeige-Logik (ohne DOM) – Bewertung, Gruppierung, Balken, Empfehlungstext.
// Wird von der Ansicht und den Unit-Tests benutzt.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const round1 = (x) => Math.round(x * 10) / 10;

/** Zahl in Millisekunden für Menschen: unter 10 mit einer Nachkommastelle. */
export function fmtMs(ms) {
  if (!isNum(ms)) return '–';
  return ms < 10 ? `${String(round1(ms)).replace('.', ',')}\u00a0ms` : `${Math.round(ms)}\u00a0ms`;
}

export function fmtPct(p) {
  if (!isNum(p)) return '–';
  return `${String(Math.round(p * 10) / 10).replace('.', ',')}\u00a0%`;
}

/** Bewertung einer Antwortzeit (Median) – immer mit Text, nicht nur Farbe. */
export function quality(ms) {
  if (!isNum(ms)) return { label: 'keine Antwort', type: 'err' };
  if (ms <= 30) return { label: 'sehr gut', type: 'ok' };
  if (ms <= 60) return { label: 'gut', type: 'ok' };
  if (ms <= 100) return { label: 'spielbar', type: 'warn' };
  return { label: 'hoch', type: 'err' };
}

/** Median einer Liste (null = verloren). */
export function median(values) {
  const ok = (values || []).filter(isNum).sort((a, b) => a - b);
  if (!ok.length) return null;
  const m = Math.floor(ok.length / 2);
  return round1(ok.length % 2 ? ok[m] : (ok[m - 1] + ok[m]) / 2);
}

/** Zwischenstand während der Messung aus den bisher gekommenen Werten. */
export function liveStats(values) {
  const list = values || [];
  const ok = list.filter(isNum);
  let jitterMs = null;
  if (ok.length >= 2) {
    let s = 0;
    for (let i = 1; i < ok.length; i++) s += Math.abs(ok[i] - ok[i - 1]);
    jitterMs = round1(s / (ok.length - 1));
  }
  return {
    sent: list.length,
    received: ok.length,
    medianMs: median(list),
    minMs: ok.length ? Math.min(...ok) : null,
    jitterMs,
    lossPct: list.length ? round1(((list.length - ok.length) / list.length) * 100) : null,
  };
}

/** Obergrenze der Balken: mindestens 150 ms, in 50er-Schritten, höchstens 400 ms. */
export function scaleMax(results) {
  const max = Math.max(0, ...(results || []).map((r) => (isNum(r?.medianMs) ? r.medianMs : 0)));
  return Math.min(400, Math.max(150, Math.ceil(max / 50) * 50));
}

/** Balkenlänge in Prozent (mindestens 2 %, damit auch sehr kleine Werte sichtbar sind). */
export function barPct(ms, max) {
  if (!isNum(ms) || !(max > 0)) return 0;
  return Math.max(2, Math.min(100, Math.round((ms / max) * 1000) / 10));
}

/**
 * Ergebnisse nach Region gruppieren. Regionen mit dem besten Wert zuerst, innerhalb der Region schnellste zuerst.
 * catalog: [{id,label,game,subs:[{id,name,...}]}]; results: [{id, medianMs, ...}]
 */
export function groupResults(catalog, results) {
  const byId = new Map((results || []).map((r) => [r.id, r]));
  const groups = (catalog || []).map((g, gi) => {
    const items = g.subs.map((s, si) => ({ ...s, ...(byId.get(s.id) || {}), id: s.id, name: s.name, order: si }));
    items.sort((a, b) => (isNum(a.medianMs) ? a.medianMs : Infinity) - (isNum(b.medianMs) ? b.medianMs : Infinity) || a.order - b.order);
    const best = items.find((i) => isNum(i.medianMs)) || null;
    return { id: g.id, label: g.label, game: g.game, items, bestMs: best ? best.medianMs : null, order: gi };
  });
  groups.sort((a, b) => (isNum(a.bestMs) ? a.bestMs : Infinity) - (isNum(b.bestMs) ? b.bestMs : Infinity) || a.order - b.order);
  return groups;
}

function bestOf(results, ids) {
  const c = (results || []).filter((r) => ids.includes(r.id) && isNum(r.medianMs) && (r.lossPct ?? 0) <= 20);
  c.sort((a, b) => a.medianMs - b.medianMs);
  return c[0] || null;
}

/**
 * Empfehlungstext für den besten Server.
 * Rückgabe: { title, text, sub, competitive, alt, auto } oder null
 */
export function recommendation(catalog, results, best) {
  if (!best) return null;
  const group = (catalog || []).find((g) => g.subs.some((s) => s.id === best.id));
  if (!group) return null;
  const many = group.subs.length > 1;
  const where = 'Stelle in Fortnite unter Einstellungen > Spiel > Sprache und Region';
  const text = many
    ? `${where}: Matchmaking-Region ${group.game}, Unterregion ${best.name}.`
    : `${where}: Matchmaking-Region ${group.game}.`;
  let competitive = null;
  if (group.id === 'NA') {
    const west = bestOf(results, ['ncal', 'or']);
    const central = bestOf(results, ['tx', 'ia']);
    competitive = 'Turniere (Competitive) laufen in Nordamerika weiter nur über NA-West und NA-Central – dort gibt es keine Unterregion.';
    if (west && central) {
      const pick = west.medianMs < central.medianMs ? `NA-West (${west.name}: ${fmtMs(west.medianMs)})` : `NA-Central (${central.name}: ${fmtMs(central.medianMs)})`;
      competitive += ` Für dich ist dort ${pick} besser.`;
    }
  }
  const others = (results || [])
    .filter((r) => r.id !== best.id && isNum(r.medianMs) && (r.lossPct ?? 0) <= 20 && r.medianMs - best.ms <= 5)
    .sort((a, b) => a.medianMs - b.medianMs);
  const alt = others.length ? `Fast genauso gut: ${others.slice(0, 2).map((r) => `${r.name} (${fmtMs(r.medianMs)})`).join(', ')}.` : null;
  return {
    title: `Bester Server: ${best.name}`,
    region: group.game,
    sub: many ? best.name : null,
    text,
    competitive,
    alt,
    auto: 'Steht die Region auf „Automatisch“, wählt Fortnite meist schon richtig. Eine feste Wahl hilft, wenn du oft auf weit entfernten Servern landest.',
  };
}

/** Verlauf: neueste zuerst, höchstens n Einträge. */
export function historyRows(history, n = 10) {
  return (Array.isArray(history) ? history : []).slice(-n).reverse();
}

/** Vergleich mit der Messung davor (gleicher Server). */
export function trend(history) {
  const h = Array.isArray(history) ? history : [];
  if (h.length < 2) return null;
  const a = h[h.length - 1];
  const b = h[h.length - 2];
  if (!a.best || !b.best) return null;
  const prev = (b.results || []).find((r) => r.id === a.best.id);
  const before = isNum(prev?.medianMs) ? prev.medianMs : null;
  if (!isNum(before) || !isNum(a.best.ms)) return null;
  const d = Math.round(a.best.ms - before);
  if (Math.abs(d) < 2) return { text: `Gleich wie bei der letzten Messung (${a.best.name}).`, type: 'ok' };
  return d < 0
    ? { text: `${Math.abs(d)} ms schneller als bei der letzten Messung (${a.best.name}).`, type: 'ok' }
    : { text: `${d} ms langsamer als bei der letzten Messung (${a.best.name}).`, type: 'warn' };
}

/** Text zur benutzten Messart. */
export function methodLabel(m) {
  return m === 'tcp' ? 'TCP-Verbindung' : m === 'mixed' ? 'Ping und TCP' : m === 'icmp' ? 'Ping (ICMP)' : 'Automatisch';
}
