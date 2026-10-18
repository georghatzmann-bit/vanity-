// Cache-Cleaner – reine Logik für die Ansicht (Auswahl, Summen, Gruppen). Ohne DOM, damit testbar.

export const GROUPS = [
  {
    id: 'shader',
    title: 'Grafik-Zwischenspeicher',
    hint: 'Fertige Grafik-Bausteine (Shader). Das erste Match danach kann kurz ruckeln.',
  },
  {
    id: 'fortnite',
    title: 'Fortnite',
    hint: 'Deine Einstellungen, Replays und Spieldateien bleiben unberührt.',
  },
];

/**
 * Kurze Zeilen für die Bereiche (die ausführlichen Texte kommen vom Hauptprozess und bleiben der Ersatz,
 * falls ein Bereich hier fehlt). hint = graue Zeile, privacy = Datenschutz-Zeile.
 */
const SHORT = {
  directx: { hint: 'Von Windows. Wird beim nächsten Spielstart neu aufgebaut.' },
  nvidia: { hint: 'Vom NVIDIA-Treiber. Wird neu aufgebaut.' },
  amd: { hint: 'Vom AMD-Treiber. Wird neu aufgebaut.' },
  intel: { hint: 'Vom Intel-Treiber. Wird neu aufgebaut.' },
  logs: { hint: 'Fortnite legt beim nächsten Start neue an.', privacy: 'Entfernt auch alte Anmelde-Codes.' },
  crashes: { hint: 'Nur für die Fehlersuche nötig.', privacy: 'Entfernt auch Kopien alter Anmelde-Codes.' },
  temp: { hint: 'Nur Einträge, die mit UE, Unreal, Fortnite oder CrashReport beginnen.' },
};

/** Kurze graue Zeile (oder Datenschutz-Zeile) für einen Bereich. */
export function rowHint(c, field = 'hint') {
  return SHORT[c?.id]?.[field] || c?.[field] || '';
}

/** Standard-Auswahl: alles, was nicht leer ist. */
export function defaultSelection(categories) {
  return new Set((categories || []).filter((c) => c.bytes > 0 || c.count > 0).map((c) => c.id));
}

/** Auswahl nach neuer Messung: frühere Wahl behalten, leere Bereiche abwählen, neue Bereiche wählen. */
export function mergeSelection(prev, categories, knownIds) {
  const next = new Set();
  for (const c of categories || []) {
    const empty = !(c.bytes > 0 || c.count > 0);
    if (empty) continue;
    if (!knownIds || !knownIds.has(c.id)) next.add(c.id);
    else if (prev && prev.has(c.id)) next.add(c.id);
  }
  return next;
}

export function selectedTotals(categories, selected) {
  let bytes = 0;
  let count = 0;
  let n = 0;
  for (const c of categories || []) {
    if (!selected.has(c.id)) continue;
    bytes += c.bytes || 0;
    count += c.count || 0;
    n++;
  }
  return { bytes, count, n };
}

export function grouped(categories) {
  return GROUPS.map((g) => ({ ...g, items: (categories || []).filter((c) => c.group === g.id) })).filter((g) => g.items.length);
}

/** "1.234 Dateien" / "1 Datei" */
export function filesText(n) {
  const v = Math.max(0, Math.round(n || 0));
  return v === 1 ? '1 Datei' : `${v.toLocaleString('de-DE')} Dateien`;
}

/** Kurzer Ergebnissatz nach dem Aufräumen. fmtBytes wird hineingereicht (ui.fmtBytes). */
export function resultText(r, fmtBytes) {
  if (!r) return '';
  if (!r.deleted && !r.skipped) return 'Es war nichts zu löschen.';
  const freed = `${fmtBytes(r.freedBytes)} frei geworden`;
  if (!r.skipped) return `${freed}.`;
  const sk = r.skipped === 1 ? '1 Datei übersprungen' : `${r.skipped.toLocaleString('de-DE')} Dateien übersprungen`;
  return `${freed}, ${sk} (gerade in Benutzung).`;
}
