/**
 * Einfache, akzentunabhängige Unscharf-Suche (Befehlspalette).
 *
 * „uberspringen“ findet „Überspringen“, „strasse“ findet „Straße“. Gefaltet wird pro
 * Code-Point, damit Treffer im Original markiert werden können.
 */

/** Sonderfälle, die NFKD nicht zerlegt. */
const SPECIAL_FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss',
  ẞ: 'ss',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ø: 'o',
  Ø: 'o',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  ı: 'i',
};

const COMBINING_MARKS = /\p{M}/gu;

function foldCharacter(character: string): string {
  const special = SPECIAL_FOLDS[character];
  if (special !== undefined) {
    return special;
  }
  return character.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** Gefalteter Text plus Zuordnung jeder gefalteten Stelle zur Original-Stelle (UTF-16). */
export interface FoldedText {
  readonly text: string;
  /** `map[i]` = Index im Original, aus dem die gefaltete Stelle `i` stammt. */
  readonly map: readonly number[];
  /** `lengths[i]` = Länge (UTF-16) des Original-Zeichens zur gefalteten Stelle `i`. */
  readonly lengths: readonly number[];
}

/** Faltet einen Text für die Suche: klein, ohne Akzente, ß → ss. */
export function foldWithMap(value: string): FoldedText {
  let text = '';
  const map: number[] = [];
  const lengths: number[] = [];
  let offset = 0;
  for (const character of value) {
    const folded = foldCharacter(character);
    for (let index = 0; index < folded.length; index += 1) {
      map.push(offset);
      lengths.push(character.length);
    }
    text += folded;
    offset += character.length;
  }
  return { text, map, lengths };
}

/** Faltet einen Text für die Suche (ohne Zuordnung). */
export function foldForSearch(value: string): string {
  return foldWithMap(value).text;
}

/** Halb-offener Bereich `[start, end)` im Original-Text. */
export type TextRange = readonly [start: number, end: number];

export interface TextMatch {
  readonly score: number;
  /** Treffer-Bereiche im Original-Text (sortiert, nicht überlappend). */
  readonly ranges: readonly TextRange[];
}

const WORD_BOUNDARY = /[\s\-_/\\.:,;()[\]„“"'+&]/;

function isWordStart(text: string, index: number): boolean {
  return index === 0 || WORD_BOUNDARY.test(text[index - 1] ?? ' ');
}

function toOriginalRanges(folded: FoldedText, foldedRanges: readonly TextRange[]): TextRange[] {
  const ranges: [number, number][] = [];
  for (const [start, end] of foldedRanges) {
    const originalStart = folded.map[start] ?? 0;
    const last = end - 1;
    const originalEnd = (folded.map[last] ?? 0) + (folded.lengths[last] ?? 1);
    const previous = ranges.at(-1);
    if (previous !== undefined && originalStart <= previous[1]) {
      previous[1] = Math.max(previous[1], originalEnd);
    } else {
      ranges.push([originalStart, originalEnd]);
    }
  }
  return ranges;
}

/** Bewertet ein einzelnes (bereits gefaltetes) Suchwort gegen einen gefalteten Text. */
function matchToken(token: string, folded: FoldedText): TextMatch | null {
  const text = folded.text;
  if (token === '') {
    return { score: 0, ranges: [] };
  }
  // 1. Zusammenhängender Treffer – am Anfang > Wortanfang > irgendwo.
  let bestIndex = -1;
  let bestScore = -1;
  let from = text.indexOf(token);
  while (from !== -1) {
    let score: number;
    if (from === 0) {
      score = text.length === token.length ? 120 : 100;
    } else if (isWordStart(text, from)) {
      score = 80;
    } else {
      score = 60 - Math.min(from, 20);
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = from;
    }
    from = text.indexOf(token, from + 1);
  }
  if (bestIndex !== -1) {
    return {
      score: bestScore,
      ranges: toOriginalRanges(folded, [[bestIndex, bestIndex + token.length]]),
    };
  }
  // 2. Teilfolge (Buchstaben in Reihenfolge, Lücken erlaubt) – bevorzugt Wortanfänge.
  const positions: number[] = [];
  let cursor = 0;
  for (const character of token) {
    let found = -1;
    // Erst einen Wortanfang ab der aktuellen Stelle suchen, sonst das nächste Vorkommen.
    for (let index = cursor; index < text.length; index += 1) {
      if (text[index] === character && isWordStart(text, index)) {
        found = index;
        break;
      }
    }
    if (found === -1 || found - cursor > 3) {
      const next = text.indexOf(character, cursor);
      if (next !== -1 && (found === -1 || next < found)) {
        found = next;
      }
    }
    if (found === -1) {
      return null;
    }
    positions.push(found);
    cursor = found + 1;
  }
  const first = positions[0] ?? 0;
  const last = positions.at(-1) ?? 0;
  const spread = last - first + 1 - token.length;
  const wordStarts = positions.filter((position) => isWordStart(text, position)).length;
  // Abkürzung über Wortanfänge („qw“ → „Quarantäne-Wiederherstellung“) ist gewollt.
  const acronym = wordStarts === positions.length;
  // Sonst sind zu weit verstreute Treffer eher Zufall als Absicht.
  if (!acronym && spread > Math.max(6, token.length * 2)) {
    return null;
  }
  const score = acronym
    ? 50 - Math.min(first, 10)
    : Math.max(1, 40 - spread * 2 + wordStarts * 4 - Math.min(first, 10));
  return {
    score,
    ranges: toOriginalRanges(
      folded,
      positions.map((position): TextRange => [position, position + 1]),
    ),
  };
}

/** Zerlegt eine Suchanfrage in gefaltete Wörter (leer → keine Wörter). */
export function tokenizeQuery(query: string): string[] {
  return foldForSearch(query)
    .split(/\s+/)
    .filter((token) => token !== '');
}

export interface SearchableText {
  readonly label: string;
  readonly keywords?: readonly string[] | undefined;
  readonly group?: string | undefined;
}

export interface SearchResult {
  readonly score: number;
  /** Treffer-Bereiche in `label` (für Hervorhebung). */
  readonly labelRanges: readonly TextRange[];
}

/**
 * Bewertet einen Eintrag: Jedes Suchwort muss in Beschriftung, Stichwörtern oder Gruppe
 * vorkommen (UND-Verknüpfung). Treffer in der Beschriftung zählen am meisten.
 * Gibt `null` zurück, wenn ein Wort nirgends passt. Leere Anfrage → Punktzahl 0.
 */
export function scoreSearchable(query: string, item: SearchableText): SearchResult | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return { score: 0, labelRanges: [] };
  }
  const label = foldWithMap(item.label);
  const keywords = (item.keywords ?? []).map(foldWithMap);
  const group = item.group === undefined ? undefined : foldWithMap(item.group);
  let total = 0;
  const labelRanges: TextRange[] = [];
  for (const token of tokens) {
    const inLabel = matchToken(token, label);
    let best = inLabel === null ? -1 : inLabel.score;
    for (const keyword of keywords) {
      const inKeyword = matchToken(token, keyword);
      if (inKeyword !== null) {
        best = Math.max(best, inKeyword.score * 0.6);
      }
    }
    if (group !== undefined) {
      const inGroup = matchToken(token, group);
      if (inGroup !== null) {
        best = Math.max(best, inGroup.score * 0.4);
      }
    }
    if (best < 0) {
      return null;
    }
    total += best;
    if (inLabel !== null) {
      labelRanges.push(...inLabel.ranges);
    }
  }
  labelRanges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of labelRanges) {
    const previous = merged.at(-1);
    if (previous !== undefined && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return { score: total, labelRanges: merged };
}
