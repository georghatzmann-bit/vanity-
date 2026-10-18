// Monitor-Tuner: Testbilder als reine Zeichen- und Rechenfunktionen.
// Die Ansicht übergibt einen Canvas-2D-Kontext; Tests übergeben einen nachgemachten Kontext.
// Alle Maße sind echte Bildschirmpixel (Canvas-Pixel = CSS-Pixel × devicePixelRatio),
// damit feine 1-Pixel-Linien (Gamma-Test) nicht verschwimmen.

export const PATTERNS = [
  {
    id: 'schwarz',
    name: 'Schwarzwert',
    instruction: 'Ab Stufe 3–4 solltest du etwas sehen. Erst ab Stufe 8? Dann ist es zu dunkel.',
  },
  {
    id: 'weiss',
    name: 'Weißwert',
    instruction: 'Die Felder sollten bis etwa 250–253 sichtbar sein. Sonst ist der Kontrast zu hoch.',
  },
  {
    id: 'gamma',
    name: 'Gamma',
    instruction: 'Augen leicht zukneifen: Wo verschmilzt die Mitte mit den Streifen? Ideal ist 2,2.',
  },
  {
    id: 'verlauf',
    name: 'Kontrast-Verlauf',
    instruction: 'Alle 32 Stufen sollten sich unterscheiden, der Verlauf ohne harte Streifen.',
  },
  {
    id: 'farben',
    name: 'Farbbalken',
    instruction: 'Farben kräftig, aber nicht grell. Graustufen ohne Farbstich.',
  },
  {
    id: 'sturm',
    name: 'Sturm-Test',
    instruction: 'Wie viele Figuren erkennst du im lila Sturm? Zähle in Ruhe.',
  },
  {
    id: 'ausleuchtung',
    name: 'Ausleuchtung',
    instruction: 'Die Fläche sollte überall gleich hell sein. Leicht hellere Ränder sind normal.',
    variants: [
      { id: 'schwarz', label: 'Schwarz', level: 0 },
      { id: 'dunkel', label: 'Dunkelgrau', level: 40 },
      { id: 'mittel', label: 'Mittelgrau', level: 128 },
      { id: 'hell', label: 'Hellgrau', level: 200 },
    ],
  },
];

export function findPattern(id) {
  return PATTERNS.find((p) => p.id === id) || PATTERNS[0];
}

export function nextPatternId(id, dir = 1) {
  const i = PATTERNS.findIndex((p) => p.id === id);
  const n = PATTERNS.length;
  return PATTERNS[(((i < 0 ? 0 : i) + dir) % n + n) % n].id;
}

// ---------- Rechenhilfen ----------

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Canvas-Größe in echten Pixeln. */
export function backingSize(cssW, cssH, dpr = 1) {
  const r = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { w: Math.max(1, Math.floor(cssW * r)), h: Math.max(1, Math.floor(cssH * r)), dpr: r };
}

/** Stufen fürs Schwarzwert-Bild: 0 … 25 */
export function blackLevels() {
  return Array.from({ length: 26 }, (_, i) => i);
}

/** Stufen fürs Weißwert-Bild: 230 … 255 */
export function whiteLevels() {
  return Array.from({ length: 26 }, (_, i) => 230 + i);
}

export const GAMMA_TARGETS = [1.8, 2.0, 2.2, 2.4, 2.6];

/**
 * Grauwert (0–255), der bei Gamma g genauso hell aussieht wie ein 50:50-Muster aus Schwarz/Weiß.
 * Das Streifenmuster liefert 50 % Licht; Grau v liefert (v/255)^g.
 */
export function gammaGrey(g) {
  return Math.round(255 * 0.5 ** (1 / g));
}

/** Gleichmäßige Stufen von 0 bis 255 (Kontrast-Verlauf). */
export function contrastSteps(n = 32) {
  return Array.from({ length: n }, (_, i) => Math.round((i * 255) / (n - 1)));
}

export const COLOR_BARS = [
  { name: 'Weiß', rgb: [255, 255, 255] },
  { name: 'Gelb', rgb: [255, 255, 0] },
  { name: 'Cyan', rgb: [0, 255, 255] },
  { name: 'Grün', rgb: [0, 255, 0] },
  { name: 'Magenta', rgb: [255, 0, 255] },
  { name: 'Rot', rgb: [255, 0, 0] },
  { name: 'Blau', rgb: [0, 0, 255] },
  { name: 'Schwarz', rgb: [0, 0, 0] },
];

/** Relative Helligkeit (für die Wahl der Beschriftungsfarbe). */
export function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Felder in einem Raster verteilen: n Felder, cols Spalten, Fläche (x,y,w,h). */
export function gridRects(n, cols, { x = 0, y = 0, w, h, gap = 0 }) {
  const rows = Math.ceil(n / cols);
  const cw = (w - gap * (cols - 1)) / cols;
  const ch = (h - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return { x: Math.round(x + c * (cw + gap)), y: Math.round(y + r * (ch + gap)), w: Math.floor(cw), h: Math.floor(ch) };
  });
}

/** Kleiner, fester Zufallsgenerator (gleicher Startwert = gleiches Bild). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Sturm-Test ----------

/** Unterschied der Figur zum Hintergrund (Stufen von 0–255, vor dem Sturm-Schleier). */
export const STORM_CONTRASTS = [4, 6, 8, 11, 14, 18, 23, 30, 38];
export const STORM_TINT = { rgb: [118, 48, 188], alpha: 0.42 };
const STORM_BG = [34, 26, 50];

/**
 * Baut eine Sturm-Szene: 5–9 Figuren mit wenig Kontrast an festen Plätzen (zufällig verteilt).
 * Rückgabe in Anteilen der Fläche (0–1), damit sie bei jeder Größe gleich aussieht.
 */
export function stormScene(seed) {
  const rnd = mulberry32(seed);
  const total = 5 + Math.floor(rnd() * 5); // 5 … 9
  const cols = 5;
  const rows = 2;
  const slots = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  // Kontraste: von schwer bis leicht, gleichmäßig verteilt
  const contrasts = Array.from({ length: total }, (_, i) => STORM_CONTRASTS[Math.round((i * (STORM_CONTRASTS.length - 1)) / Math.max(1, total - 1))]);
  for (let i = contrasts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [contrasts[i], contrasts[j]] = [contrasts[j], contrasts[i]]; }
  const figures = slots.slice(0, total).map((s, i) => {
    const c = s % cols;
    const r = Math.floor(s / cols);
    return {
      x: (c + 0.25 + rnd() * 0.5) / cols,
      y: 0.42 + r * 0.27 + rnd() * 0.06, // Fußpunkt
      size: 0.14 + rnd() * 0.06, // Höhe als Anteil der Bildhöhe
      contrast: contrasts[i],
      lighter: rnd() < 0.5, // heller oder dunkler als der Hintergrund
    };
  });
  const blocks = Array.from({ length: 7 }, () => ({
    x: rnd() * 0.95, w: 0.04 + rnd() * 0.1, h: 0.12 + rnd() * 0.3, shade: Math.round(rnd() * 8) - 4,
  }));
  const fog = Array.from({ length: 6 }, () => ({ x: rnd(), y: 0.2 + rnd() * 0.7, r: 0.15 + rnd() * 0.25 }));
  return { seed, total, figures, blocks, fog };
}

/** Wie schwer eine Figur zu sehen ist (für die Lösung). */
export function stormDifficulty(contrast) {
  if (contrast <= 6) return 'sehr schwer';
  if (contrast <= 11) return 'schwer';
  if (contrast <= 18) return 'mittel';
  return 'leicht';
}

/** Bewertung: wie viele von total erkannt. */
export function rateStorm(seen, total) {
  const s = Math.round(Number(seen));
  if (!Number.isFinite(s) || s < 0 || !total) return null;
  if (s > total) {
    return { level: 'warn', label: 'zu viele', text: `Es sind nur ${total} Figuren im Bild. Zähle noch einmal.` };
  }
  const q = s / total;
  if (q >= 0.85) return { level: 'ok', label: 'sehr gut', text: `${s} von ${total} erkannt. Dunkle Gegner im Sturm siehst du gut.` };
  if (q >= 0.6) return { level: 'warn', label: 'geht so', text: `${s} von ${total} erkannt. Schwarz-Stabilisator eine Stufe höher oder Fortnite-Helligkeit 110–120 %.` };
  return { level: 'err', label: 'zu dunkel', text: `${s} von ${total} erkannt. Geh die Schritte 1 bis 3 noch einmal durch.` };
}

// ---------- Zeichnen ----------

const rgb = (v) => `rgb(${v[0]},${v[1]},${v[2]})`;
const grey = (v) => `rgb(${v},${v},${v})`;

function font(px, weight = 500) {
  return `${weight} ${Math.round(px)}px "Segoe UI", system-ui, sans-serif`;
}

function label(ctx, text, x, y, size, color, align = 'center') {
  ctx.font = font(size);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

function steps(ctx, w, h, levels, { bg, labelColor, cols = 13 }) {
  ctx.fillStyle = grey(bg);
  ctx.fillRect(0, 0, w, h);
  const pad = Math.round(Math.min(w, h) * 0.06);
  const lab = Math.max(10, Math.round(h * 0.035));
  const rows = Math.ceil(levels.length / cols);
  const areaH = h - pad * 2 - rows * (lab + 8);
  const cell = Math.floor(Math.min((w - pad * 2) / cols, areaH / rows) * 0.86);
  const gapX = Math.floor(((w - pad * 2) - cell * cols) / Math.max(1, cols - 1));
  const totalW = cell * cols + gapX * (cols - 1);
  const totalH = rows * (cell + lab + 8) + (rows - 1) * Math.round(cell * 0.25);
  const x0 = Math.round((w - totalW) / 2);
  const y0 = Math.round((h - totalH) / 2);
  levels.forEach((lv, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = x0 + c * (cell + gapX);
    const y = y0 + r * (cell + lab + 8 + Math.round(cell * 0.25));
    ctx.fillStyle = grey(lv);
    ctx.fillRect(x, y, cell, cell);
    label(ctx, String(lv), x + cell / 2, y + cell + 6, lab, labelColor);
  });
}

/** Gamma: Streifen aus 1-Pixel-Linien (Schwarz/Weiß) mit einem festen Grau in der Mitte. */
export function drawGammaPatch(ctx, x, y, size, g) {
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#fff';
  for (let yy = y; yy < y + size; yy += 2) ctx.fillRect(x, yy, size, 1);
  const inner = Math.round(size * 0.44);
  const o = Math.round((size - inner) / 2);
  ctx.fillStyle = grey(gammaGrey(g));
  ctx.fillRect(x + o, y + o, inner, inner);
}

function drawGamma(ctx, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const n = GAMMA_TARGETS.length;
  const size = Math.floor(Math.min((w * 0.9) / n * 0.82, h * 0.5));
  const gap = Math.floor((w * 0.9 - size * n) / (n - 1));
  const x0 = Math.round((w - (size * n + gap * (n - 1))) / 2);
  const y0 = Math.round(h * 0.5 - size * 0.62);
  const lab = Math.max(11, Math.round(h * 0.04));
  GAMMA_TARGETS.forEach((g, i) => {
    const x = x0 + i * (size + gap);
    drawGammaPatch(ctx, x, y0, size, g);
    const t = g.toFixed(1).replace('.', ',');
    label(ctx, g === 2.2 ? `${t} (Ziel)` : t, x + size / 2, y0 + size + 10, lab, g === 2.2 ? '#9be9ff' : '#9a9a9a');
  });
}

function drawGradient(ctx, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const pad = Math.round(w * 0.04);
  const bw = w - pad * 2;
  const lab = Math.max(10, Math.round(h * 0.03));
  const s = contrastSteps(32);
  const bandH = Math.round(h * 0.34);
  const y1 = Math.round(h * 0.1);
  s.forEach((v, i) => {
    const x = pad + Math.floor((i * bw) / s.length);
    const x2 = pad + Math.floor(((i + 1) * bw) / s.length);
    ctx.fillStyle = grey(v);
    ctx.fillRect(x, y1, x2 - x, bandH);
    if (i % 4 === 0 || i === s.length - 1) label(ctx, String(i + 1), (x + x2) / 2, y1 + bandH + 6, lab, '#8a8a8a');
  });
  // dünner Rahmen, damit man sieht, wo Stufe 1 (reines Schwarz) beginnt
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad - 0.5, y1 - 0.5, bw + 1, bandH + 1);
  const y2 = y1 + bandH + lab + 24;
  const smoothH = Math.round(h * 0.18);
  const grad = ctx.createLinearGradient(pad, 0, pad + bw, 0);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, '#fff');
  ctx.fillStyle = grad;
  ctx.fillRect(pad, y2, bw, smoothH);
  const colorH = Math.round(h * 0.05);
  [[255, 0, 0], [0, 255, 0], [0, 0, 255]].forEach((c, i) => {
    const g2 = ctx.createLinearGradient(pad, 0, pad + bw, 0);
    g2.addColorStop(0, '#000');
    g2.addColorStop(1, rgb(c));
    ctx.fillStyle = g2;
    ctx.fillRect(pad, y2 + smoothH + 8 + i * (colorH + 4), bw, colorH);
  });
}

function drawBars(ctx, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const topH = Math.round(h * 0.66);
  const lab = Math.max(9, Math.round(Math.min(h * 0.035, (w / COLOR_BARS.length) * 0.15)));
  COLOR_BARS.forEach((b, i) => {
    const x = Math.floor((i * w) / COLOR_BARS.length);
    const x2 = Math.floor(((i + 1) * w) / COLOR_BARS.length);
    ctx.fillStyle = rgb(b.rgb);
    ctx.fillRect(x, 0, x2 - x, topH);
    label(ctx, b.name, (x + x2) / 2, topH - lab - 12, lab, luminance(b.rgb) > 0.45 ? '#202020' : '#d8d8d8');
  });
  const n = 11;
  const y = topH;
  const greyH = Math.round((h - topH) * 0.62);
  for (let i = 0; i < n; i++) {
    const x = Math.floor((i * w) / n);
    const x2 = Math.floor(((i + 1) * w) / n);
    const v = Math.round((i * 255) / (n - 1));
    ctx.fillStyle = grey(v);
    ctx.fillRect(x, y, x2 - x, greyH);
    label(ctx, `${i * 10} %`, (x + x2) / 2, y + greyH / 2 - lab / 2, lab * 0.85, v > 120 ? '#202020' : '#bdbdbd');
  }
  const skinY = y + greyH;
  const skins = [[255, 224, 196], [234, 192, 160], [198, 140, 104], [141, 85, 54], [88, 52, 33]];
  skins.forEach((c, i) => {
    const x = Math.floor((i * w) / skins.length);
    const x2 = Math.floor(((i + 1) * w) / skins.length);
    ctx.fillStyle = rgb(c);
    ctx.fillRect(x, skinY, x2 - x, h - skinY);
  });
}

function figurePath(ctx, cx, footY, height) {
  const head = height * 0.13;
  const bodyW = height * 0.3;
  const bodyTop = footY - height + head * 2.1;
  ctx.beginPath();
  ctx.arc(cx, footY - height + head, head, 0, Math.PI * 2);
  ctx.moveTo(cx - bodyW / 2, bodyTop);
  ctx.lineTo(cx + bodyW / 2, bodyTop);
  ctx.lineTo(cx + bodyW * 0.42, footY - height * 0.42);
  ctx.lineTo(cx + bodyW * 0.36, footY);
  ctx.lineTo(cx + bodyW * 0.08, footY);
  ctx.lineTo(cx, footY - height * 0.3);
  ctx.lineTo(cx - bodyW * 0.08, footY);
  ctx.lineTo(cx - bodyW * 0.36, footY);
  ctx.lineTo(cx - bodyW * 0.42, footY - height * 0.42);
  ctx.closePath();
}

/** Sturm-Test zeichnen. reveal = Lösung mit Rahmen und Nummern zeigen. */
export function drawStorm(ctx, w, h, scene, { reveal = false } = {}) {
  // dunkler Boden mit leichtem Verlauf
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, rgb([STORM_BG[0] + 10, STORM_BG[1] + 6, STORM_BG[2] + 14]));
  sky.addColorStop(1, rgb([STORM_BG[0] - 14, STORM_BG[1] - 12, STORM_BG[2] - 20]));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // Gebäude-Silhouetten (fast gleiche Farbe wie der Boden)
  for (const b of scene.blocks) {
    const base = STORM_BG.map((c) => clamp(c + b.shade, 0, 255));
    ctx.fillStyle = rgb(base);
    ctx.fillRect(Math.round(b.x * w), Math.round(h * (0.95 - b.h)), Math.round(b.w * w), Math.round(b.h * h));
  }
  // Figuren
  for (const f of scene.figures) {
    const d = f.lighter ? f.contrast : -f.contrast;
    ctx.fillStyle = rgb(STORM_BG.map((c) => clamp(c + d, 0, 255)));
    figurePath(ctx, f.x * w, f.y * h, f.size * h);
    ctx.fill();
  }
  // Sturm-Schleier und Nebel
  ctx.fillStyle = `rgba(${STORM_TINT.rgb.join(',')},${STORM_TINT.alpha})`;
  ctx.fillRect(0, 0, w, h);
  for (const g of scene.fog) {
    const r = g.r * Math.max(w, h);
    const grad = ctx.createRadialGradient(g.x * w, g.y * h, 0, g.x * w, g.y * h, r);
    grad.addColorStop(0, 'rgba(170,110,235,0.16)');
    grad.addColorStop(1, 'rgba(170,110,235,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  if (reveal) {
    const lab = Math.max(11, Math.round(h * 0.032));
    scene.figures.forEach((f, i) => {
      const fh = f.size * h;
      const fw = fh * 0.42;
      ctx.strokeStyle = '#4fd8ff';
      ctx.lineWidth = Math.max(2, Math.round(h / 300));
      ctx.strokeRect(Math.round(f.x * w - fw / 2 - 6), Math.round(f.y * h - fh - 6), Math.round(fw + 12), Math.round(fh + 12));
      label(ctx, `${i + 1} · ${stormDifficulty(f.contrast)}`, f.x * w, f.y * h + 10, lab, '#9be9ff');
    });
  }
}

function drawUniform(ctx, w, h, level) {
  ctx.fillStyle = grey(level);
  ctx.fillRect(0, 0, w, h);
}

/** Zerlegt Text in Zeilen, die höchstens maxW breit sind (measure = Breite eines Textes). */
export function wrapText(text, maxW, measure) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && measure(test) > maxW) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Hinweis unten im Bild (nur kurz sichtbar, z. B. im Vollbild). */
export function drawHint(ctx, w, h, lines, dpr = 1) {
  const size = Math.round(13 * dpr);
  const pad = Math.round(12 * dpr);
  ctx.font = font(size);
  const measure = (t) => { const m = ctx.measureText(t); return m && Number.isFinite(m.width) ? m.width : t.length * size * 0.55; };
  const maxW = Math.max(120, Math.min(w * 0.8, 760 * dpr));
  const rows = lines.flatMap((l, i) => wrapText(l, maxW, measure).map((t) => ({ t, first: i === 0 })));
  const bw = Math.min(w - pad * 2, Math.max(...rows.map((r) => measure(r.t))) + pad * 2);
  const bh = rows.length * (size + 6) + pad * 2 - 6;
  const x = Math.round((w - bw) / 2);
  const y = Math.round(h - bh - 24 * dpr);
  ctx.fillStyle = 'rgba(8,10,16,0.82)';
  ctx.fillRect(x, y, bw, bh);
  rows.forEach((r, i) => label(ctx, r.t, w / 2, y + pad + i * (size + 6), size, r.first ? '#e8eaf0' : '#a3a9b9'));
  return rows.length;
}

/**
 * Zeichnet ein Testbild. opts: { variant, scene (Sturm), reveal, hint: [Zeilen], dpr }
 * w/h = echte Pixel des Canvas.
 */
export function drawPattern(ctx, id, w, h, opts = {}) {
  if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
  if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
  const p = findPattern(id);
  switch (p.id) {
    case 'schwarz': steps(ctx, w, h, blackLevels(), { bg: 0, labelColor: '#7a7a7a' }); break;
    case 'weiss': steps(ctx, w, h, whiteLevels(), { bg: 255, labelColor: '#5a5a5a' }); break;
    case 'gamma': drawGamma(ctx, w, h); break;
    case 'verlauf': drawGradient(ctx, w, h); break;
    case 'farben': drawBars(ctx, w, h); break;
    case 'sturm': drawStorm(ctx, w, h, opts.scene || stormScene(1), { reveal: !!opts.reveal }); break;
    case 'ausleuchtung': {
      const v = (p.variants.find((x) => x.id === opts.variant) || p.variants[2]);
      drawUniform(ctx, w, h, v.level);
      break;
    }
    default: break;
  }
  if (opts.hint?.length) drawHint(ctx, w, h, opts.hint, opts.dpr || 1);
  return p.id;
}
