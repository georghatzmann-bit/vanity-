// PC-Check – kleine reine Helfer für die Ansicht (auch in Node-Tests nutzbar).
// FPS-Grenze erklären (Bildzeit in ms), Zeilen der Vorschau gruppieren und zählen.

const de = (n, d = 1) => Number(n).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: 0 });

/** Zeit zwischen zwei Bildern in Millisekunden (null bei "unbegrenzt"/ungültig). */
export function frameTimeMs(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return null;
  return 1000 / n;
}

/** 6.944 -> "6,9 ms", 16.67 -> "16,7 ms", 2.08 -> "2,1 ms" */
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  return `${de(ms, ms < 100 ? 1 : 0)} ms`;
}

/** 0 -> "Unbegrenzt", 144 -> "144 FPS" */
export function fpsLabel(cap) {
  const n = Number(cap);
  if (!Number.isFinite(n)) return '–';
  return n <= 0 ? 'Unbegrenzt' : `${Math.round(n)} FPS`;
}

/**
 * Erklärt die gewählte FPS-Grenze im Vergleich zum Monitor.
 * cap: 0 = unbegrenzt; hz: Bildwiederholrate des Monitors; est: { low, typical } grobe Schätzung.
 * Rückgabe: { tone: 'ok'|'info'|'warn', title, lines: [Text], gameMs, monitorMs, gameRate }
 */
export function fpsExplain({ cap, hz, est } = {}) {
  hz = Number(hz) > 0 ? Math.round(Number(hz)) : 60;
  cap = Number(cap) > 0 ? Math.round(Number(cap)) : 0;
  const low = Number(est?.low) > 0 ? Math.round(Number(est.low)) : null;
  const typical = Number(est?.typical) > 0 ? Math.round(Number(est.typical)) : null;
  const monitorMs = frameTimeMs(hz);
  // Was Fortnite wirklich schafft: Grenze oder (bei unbegrenzt) die Schätzung
  const gameRate = cap > 0 ? (typical ? Math.min(cap, typical) : cap) : (typical || hz);
  const gameMs = frameTimeMs(gameRate);
  const lines = [];
  let tone = 'ok';
  let title;

  if (cap === 0) {
    title = 'Unbegrenzt: so viele Bilder, wie der PC schafft';
    lines.push(typical
      ? `Dein PC macht grob ${typical} Bilder pro Sekunde – also alle ${fmtMs(gameMs)} ein neues Bild.`
      : 'Dein PC macht so viele Bilder pro Sekunde, wie er schafft.');
    lines.push(`Dein Monitor zeigt davon nur ${hz} pro Sekunde (alle ${fmtMs(monitorMs)} eins). Die Extra-Bilder machen die Maus minimal direkter, der PC wird dafür wärmer und lauter.`);
    tone = 'info';
  } else if (cap === hz) {
    title = 'Passt genau zu deinem Monitor';
    lines.push(`Fortnite macht höchstens ${cap} Bilder pro Sekunde – alle ${fmtMs(frameTimeMs(cap))} eins. Dein Monitor zeigt genauso alle ${fmtMs(monitorMs)} ein Bild (${hz} Hz).`);
    lines.push('Kein Bild ist umsonst berechnet. Das läuft gleichmäßig und hält den PC kühler.');
  } else if (cap > hz) {
    title = 'Mehr Bilder, als der Monitor zeigt';
    lines.push(`Fortnite macht bis zu ${cap} Bilder pro Sekunde – alle ${fmtMs(frameTimeMs(cap))} eins. Dein Monitor zeigt nur alle ${fmtMs(monitorMs)} ein Bild (${hz} Hz).`);
    lines.push('Das gezeigte Bild ist dadurch etwas frischer, die Maus fühlt sich minimal direkter an. Der PC arbeitet dafür mehr.');
    tone = 'info';
  } else {
    title = 'Weniger Bilder, dafür gleichmäßig';
    lines.push(`Fortnite macht höchstens ${cap} Bilder pro Sekunde – alle ${fmtMs(frameTimeMs(cap))} eins. Dein Monitor könnte alle ${fmtMs(monitorMs)} ein Bild zeigen (${hz} Hz).`);
    lines.push('Eine Grenze, die dein PC sicher schafft, fühlt sich ruhiger an als stark schwankende FPS.');
    tone = 'info';
  }
  if (cap > 0 && low && low < cap * 0.9) {
    lines.push(`Achtung: In großen Kämpfen schafft dein PC mit diesem Vorschlag grob ${low} FPS. Die Grenze von ${cap} wird dann nicht erreicht – das Bild kann schwanken.`);
    tone = 'warn';
  }
  return { tone, title, lines, gameMs, monitorMs, gameRate };
}

/**
 * Positionen (0–100 %) der Bilder in einem Zeitfenster – für die kleine Zeitleiste
 * "Monitor vs. Fortnite". Höchstens maxTicks Striche, damit es lesbar bleibt.
 */
export function timelineTicks(rate, windowMs = 50, maxTicks = 80) {
  const step = frameTimeMs(rate);
  if (!step || windowMs <= 0) return [];
  const out = [];
  for (let t = 0; t < windowMs - 1e-9 && out.length < maxTicks; t += step) out.push(Math.round((t / windowMs) * 10000) / 100);
  return out;
}

const GROUP_ORDER = ['Anzeige', 'Grafik', 'Extras'];

/** Teilt die Vorschau-Zeilen in Gruppen (Anzeige, Grafik, Extras, Rest) in fester Reihenfolge. */
export function groupRows(rows = []) {
  const map = new Map();
  for (const r of rows) {
    const g = r.group || 'Weitere';
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(r);
  }
  const names = [...map.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return names.map((group) => ({ group, rows: map.get(group) }));
}

/** Wie viele Zeilen wirklich geschrieben würden (geänderte, nicht abgewählte). */
export function countWrites(rows = [], skip = new Set()) {
  return rows.filter((r) => r.changed && !skip.has(r.id)).length;
}

/** Stufe 1–4 für die kleine Anzeige auf den Hardware-Karten. */
export function meterLevel(kind, rating = {}, extra = {}) {
  if (kind === 'cpu' || kind === 'gpu') return Math.max(1, Math.min(4, Number(rating.tier) || 2));
  if (kind === 'ram') {
    const gb = Number(extra.gb) || 0;
    return gb >= 31 ? 4 : gb >= 15 ? 3 : gb >= 7.5 ? 2 : gb > 0 ? 1 : 2;
  }
  if (kind === 'display') {
    const hz = Number(extra.hz) || 0;
    return hz >= 240 ? 4 : hz >= 144 ? 3 : hz >= 100 ? 2 : hz > 0 ? 1 : 2;
  }
  return 2;
}

/** "ca. 300 FPS" (typischer Wert) und "in Kämpfen ca. 220" aus der groben Schätzung. */
export function estText(est) {
  if (!est || !(est.typical > 0)) return 'unbekannt';
  return `ca. ${est.typical} FPS`;
}

export function estFightText(est) {
  if (!est || !(est.low > 0)) return '';
  return `in großen Kämpfen ca. ${est.low} FPS`;
}
