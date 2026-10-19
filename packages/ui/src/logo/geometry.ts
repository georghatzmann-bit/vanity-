/**
 * Geometrie des AEGIS-Logos (eigener Entwurf).
 *
 * Konzept: Ein facettierter Schild (Aigis = mythischer Schutzschild) aus zwei gespiegelten
 * Strichen, die sich an der unteren Spitze treffen. Innen ein spitzes „Λ“ (das A von AEGIS,
 * zugleich ein nach oben weisender Chevron) und ein waagerechter Scan-Balken, der das Λ zum
 * „A“ ergänzt und den Prüfvorgang andeutet.
 *
 * Raster: viewBox 64 × 64, Strichstärke 4. Senkrechte und waagerechte Kanten liegen so, dass
 * sie bei 16 px (1 Einheit = ¼ px) und 32 px (½ px) exakt auf Pixelgrenzen fallen.
 *
 * Alle Pfade werden hier einmal berechnet und von den React-Komponenten, der Start-Animation
 * und dem Asset-Generator (scripts/export-logo.mjs) gemeinsam verwendet.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Rundet auf zwei Nachkommastellen und entfernt überflüssige Nullen. */
export function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function point(p: Point): string {
  return `${formatNumber(p.x)} ${formatNumber(p.y)}`;
}

export const markSize = 64;
export const markViewBox = `0 0 ${markSize} ${markSize}`;
export const markStrokeWidth = 4;
const markCenterX = markSize / 2;

/* ---------------------------------------------------------------- Schild-Umriss */

const shieldTop: Point = { x: markCenterX, y: 4 };
const shieldShoulderInset = 10;
const shieldShoulderY = 10;
const shieldWaistY = 34;
const shieldTip: Point = { x: markCenterX, y: 60 };

function shieldHalf(side: -1 | 1): string {
  const x = markCenterX + side * (markCenterX - shieldShoulderInset);
  return `M${point(shieldTop)} L${point({ x, y: shieldShoulderY })} V${formatNumber(shieldWaistY)} L${point(shieldTip)}`;
}

/** Linke Schildhälfte: von der oberen Mitte bis zur Spitze (Mittellinie des Strichs). */
export const outlineLeft = shieldHalf(-1);
/** Rechte Schildhälfte, gespiegelt. */
export const outlineRight = shieldHalf(1);

/** Geschlossener Umriss (für die statische Darstellung mit spitzen Gehrungen). */
export const outline = [
  `M${point(shieldTop)}`,
  `L${point({ x: markSize - shieldShoulderInset, y: shieldShoulderY })}`,
  `V${formatNumber(shieldWaistY)}`,
  `L${point(shieldTip)}`,
  `L${point({ x: shieldShoulderInset, y: shieldWaistY })}`,
  `V${formatNumber(shieldShoulderY)}`,
  'Z',
].join(' ');

/**
 * Füllform (Silhouette). Gefüllt UND mit `markStrokeWidth` (Gehrung) umrandet ergibt sie die
 * äußere Kontur des Strich-Logos – Grundlage für das App-Icon.
 */
export const fillShape = outline;

/* ------------------------------------------------------------------ Inneres Λ */

const innerApex: Point = { x: markCenterX, y: 19 };
const innerFootY = 41;
const innerFootSpread = 8;

/**
 * Λ als Füllfläche mit waagerecht abgeschnittenen Füßen. Berechnet aus der Mittellinie
 * (Spitze → Fuß) und der halben Strichstärke, damit die Stärke exakt `markStrokeWidth` ist.
 */
function chevronPolygon(): string {
  const half = markStrokeWidth / 2;
  const dx = -innerFootSpread;
  const dy = innerFootY - innerApex.y;
  const length = Math.hypot(dx, dy);
  // Normale zur Außenseite des linken Schenkels.
  const ox = (-dy / length) * half;
  const oy = (dx / length) * half;
  const outer = { x: innerApex.x + ox, y: innerApex.y + oy };
  const inner = { x: innerApex.x - ox, y: innerApex.y - oy };
  const apexOuterY = outer.y + ((markCenterX - outer.x) / dx) * dy;
  const apexInnerY = inner.y + ((markCenterX - inner.x) / dx) * dy;
  const footOuterX = outer.x + ((innerFootY - outer.y) / dy) * dx;
  const footInnerX = inner.x + ((innerFootY - inner.y) / dy) * dx;
  const mirror = (x: number): number => markSize - x;
  return [
    `M${point({ x: markCenterX, y: apexOuterY })}`,
    `L${point({ x: footOuterX, y: innerFootY })}`,
    `H${formatNumber(footInnerX)}`,
    `L${point({ x: markCenterX, y: apexInnerY })}`,
    `L${point({ x: mirror(footInnerX), y: innerFootY })}`,
    `H${formatNumber(mirror(footOuterX))}`,
    'Z',
  ].join(' ');
}

/** Inneres Zeichen (Λ) als Füllfläche. */
export const innerMark = chevronPolygon();

/* ------------------------------------------------------------------ Scan-Balken */

const scanLineY = 34;
const scanLineStart = 18;
const scanLineEnd = markSize - scanLineStart;

/** Scan-Balken als Füllfläche (Rechteck, Höhe = Strichstärke). */
export const scanLine = `M${point({ x: scanLineStart, y: scanLineY - markStrokeWidth / 2 })} H${formatNumber(scanLineEnd)} V${formatNumber(scanLineY + markStrokeWidth / 2)} H${formatNumber(scanLineStart)} Z`;

/** Horizontale Ausdehnung des Scan-Balkens als Anteil der Logobreite (für die Animation). */
export const scanLineSpan = {
  start: scanLineStart / markSize,
  end: scanLineEnd / markSize,
} as const;

/* ----------------------------------------------------------------- Zeichen-Masken */

/** Überstand der Zeichen-Masken über Spitze/Scheitel, damit Gehrungen vollständig frei werden. */
const revealOvershoot = 6;

function revealHalf(side: -1 | 1): string {
  const x = markCenterX + side * (markCenterX - shieldShoulderInset);
  return [
    `M${point({ x: markCenterX, y: shieldTop.y - revealOvershoot })}`,
    `V${formatNumber(shieldTop.y)}`,
    `L${point({ x, y: shieldShoulderY })}`,
    `V${formatNumber(shieldWaistY)}`,
    `L${point(shieldTip)}`,
    `V${formatNumber(shieldTip.y + revealOvershoot)}`,
  ].join(' ');
}

function revealLeg(side: -1 | 1): string {
  // Schenkel über den Fuß hinaus verlängert (gleiche Steigung), Start oberhalb der Spitze.
  const extension = 0.1;
  const foot = {
    x: innerApex.x + side * innerFootSpread * (1 + extension),
    y: innerApex.y + (innerFootY - innerApex.y) * (1 + extension),
  };
  return `M${point({ x: innerApex.x, y: innerApex.y - 7 })} V${formatNumber(innerApex.y)} L${point(foot)}`;
}

/**
 * Pfade für das „Zeichnen“ in der Start-Animation. Sie werden als breite weiße Striche mit
 * stumpfen Enden in einer Maske animiert (pathLength 0 → 1) und legen so die exakte Form
 * frei – mit geraden, präzisen Vorderkanten und vollständigen Gehrungen. Ein Vorlauf über
 * dem Scheitel und ein Nachlauf unter der Spitze sorgen dafür, dass beide Hälften die Ecken
 * ganz aufdecken.
 */
export const reveal = {
  outlineLeft: revealHalf(-1),
  outlineRight: revealHalf(1),
  outlineWidth: 10,
  innerLeft: revealLeg(-1),
  innerRight: revealLeg(1),
  innerWidth: 12,
  scanLine: `M${point({ x: scanLineStart, y: scanLineY })} H${formatNumber(scanLineEnd)}`,
  scanLineWidth: markStrokeWidth + 2,
} as const;

/** Alle Teile des Bildzeichens auf einen Blick. */
export const markGeometry = {
  viewBox: markViewBox,
  size: markSize,
  strokeWidth: markStrokeWidth,
  outlineLeft,
  outlineRight,
  outline,
  innerMark,
  scanLine,
  fillShape,
} as const;

/* -------------------------------------------------------------------- Schriftzug */

/** Versalhöhe des Schriftzugs in eigenen Einheiten. */
export const wordmarkCapHeight = 20;
/** Strichstärke der Buchstaben (12 % der Versalhöhe). */
export const wordmarkStrokeWidth = 2.4;

const t = wordmarkStrokeWidth;
const c = t / 2;
const H = wordmarkCapHeight;
/** Bogenradius der Mittellinie (Außenradius 5). */
const r = 5 - c;

interface GlyphPaths {
  /** Füllflächen (A, E, I). */
  readonly fill?: string;
  /** Mittellinien (G, S) – Strich `wordmarkStrokeWidth`, stumpfe Enden, Gehrung. */
  readonly stroke?: string;
}

interface GlyphSpec {
  readonly char: string;
  readonly width: number;
  /** Optisch korrigierter Abstand zum vorherigen Buchstaben (weite Sperrung). */
  readonly gap: number;
  readonly build: (x: (value: number) => string) => GlyphPaths;
}

const n = formatNumber;

const glyphSpecs: readonly GlyphSpec[] = [
  {
    char: 'A',
    width: 18,
    gap: 0,
    build: (x) => {
      const width = 18;
      const apexX = width / 2;
      // Waagerechte Schenkelstärke aus der Neigung, damit die Strichstärke exakt t ist.
      const legThickness = t / Math.sin(Math.atan2(H, apexX));
      const innerApexY = H - ((apexX - legThickness) * H) / apexX;
      const barTop = 12.4;
      const barInset = 4;
      return {
        fill: [
          `M${x(apexX)} 0 L${x(width)} ${n(H)} H${x(width - legThickness)} L${x(apexX)} ${n(innerApexY)} L${x(legThickness)} ${n(H)} H${x(0)} Z`,
          `M${x(barInset)} ${n(barTop)} H${x(width - barInset)} V${n(barTop + t)} H${x(barInset)} Z`,
        ].join(' '),
      };
    },
  },
  {
    char: 'E',
    width: 13,
    gap: 6,
    build: (x) => {
      const width = 13;
      const middleTop = (H - t) / 2;
      return {
        fill: `M${x(0)} 0 H${x(width)} V${n(t)} H${x(t)} V${n(middleTop)} H${x(width - 1.5)} V${n(middleTop + t)} H${x(t)} V${n(H - t)} H${x(width)} V${n(H)} H${x(0)} Z`,
      };
    },
  },
  {
    char: 'G',
    width: 18,
    gap: 6.5,
    build: (x) => {
      const width = 18;
      const arc = (toX: number, toY: number): string =>
        `A${n(r)} ${n(r)} 0 0 0 ${x(toX)} ${n(toY)}`;
      return {
        stroke: [
          `M${x(width)} ${n(c)}`,
          `H${x(c + r)}`,
          arc(c, c + r),
          `V${n(H - c - r)}`,
          arc(c + r, H - c),
          `H${x(width - c - r)}`,
          arc(width - c, H - c - r),
          `V${n(H / 2)}`,
          `H${x(width - 8)}`,
        ].join(' '),
      };
    },
  },
  {
    char: 'I',
    width: t,
    gap: 7,
    build: (x) => ({ fill: `M${x(0)} 0 H${x(t)} V${n(H)} H${x(0)} Z` }),
  },
  {
    char: 'S',
    width: 16,
    gap: 7,
    build: (x) => {
      const width = 16;
      const mid = H / 2;
      const arc = (sweep: 0 | 1, toX: number, toY: number): string =>
        `A${n(r)} ${n(r)} 0 0 ${sweep} ${x(toX)} ${n(toY)}`;
      return {
        stroke: [
          `M${x(width)} ${n(c)}`,
          `H${x(c + r)}`,
          arc(0, c, c + r),
          `V${n(mid - r)}`,
          arc(0, c + r, mid),
          `H${x(width - c - r)}`,
          arc(1, width - c, mid + r),
          `V${n(H - c - r)}`,
          arc(1, width - c - r, H - c),
          `H${x(0)}`,
        ].join(' '),
      };
    },
  },
];

interface PlacedGlyph extends GlyphPaths {
  readonly char: string;
  readonly x: number;
  readonly width: number;
}

function layoutGlyphs(): readonly PlacedGlyph[] {
  const placed: PlacedGlyph[] = [];
  let cursor = 0;
  for (const spec of glyphSpecs) {
    cursor += spec.gap;
    const offset = cursor;
    placed.push({
      char: spec.char,
      x: offset,
      width: spec.width,
      ...spec.build((value) => n(value + offset)),
    });
    cursor += spec.width;
  }
  return placed;
}

/** Positionierte Buchstaben des Schriftzugs „AEGIS“. */
export const wordmarkGlyphs = layoutGlyphs();

/** Breite des Schriftzugs in eigenen Einheiten. */
export const wordmarkWidth = wordmarkGlyphs.reduce((max, g) => Math.max(max, g.x + g.width), 0);
export const wordmarkViewBox = `0 0 ${n(wordmarkWidth)} ${wordmarkCapHeight}`;

function joinGlyphPaths(kind: keyof GlyphPaths): string {
  return wordmarkGlyphs
    .map((glyph) => glyph[kind])
    .filter((path): path is string => path !== undefined)
    .join(' ');
}

/** Füllflächen des Schriftzugs (A, E, I), fertig positioniert. */
export const wordmarkFill = joinGlyphPaths('fill');
/** Mittellinien des Schriftzugs (G, S), fertig positioniert. */
export const wordmarkStroke = joinGlyphPaths('stroke');

/* ----------------------------------------------------------- Kombiniertes Logo */

/** Abstand Bildzeichen → Schriftzug und Skalierung des Schriftzugs im Logo „full“. */
const lockupMarkOffsetX = -6;
const lockupGap = 14;
const lockupWordmarkScale = 1.1;
const lockupMarkRight = markSize - shieldShoulderInset + markStrokeWidth / 2 + lockupMarkOffsetX;

export const lockup = {
  markOffsetX: lockupMarkOffsetX,
  wordmarkX: lockupMarkRight + lockupGap,
  wordmarkY: (markSize - wordmarkCapHeight * lockupWordmarkScale) / 2,
  wordmarkScale: lockupWordmarkScale,
  width: lockupMarkRight + lockupGap + wordmarkWidth * lockupWordmarkScale + 2,
  height: markSize,
} as const;

export const lockupViewBox = `0 0 ${formatNumber(lockup.width)} ${lockup.height}`;
