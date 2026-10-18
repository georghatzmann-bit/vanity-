// Replay-Tresor – reine Logik für die Ansicht (Anzeige-Namen, Dauer, Status). Ohne DOM, damit testbar.

/** Dauer als "23:41" (Minuten:Sekunden) oder "1:02:05" bei über einer Stunde. */
export function fmtLength(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Name ohne ".replay". */
export function baseName(file) {
  return String(file || '').replace(/\.replay$/i, '');
}

/**
 * Anzeigename. In Fortnite: Name aus der Aufnahme ("Unsaved Replay" -> "Ungespeichertes Replay").
 * Im Tresor: der Dateiname (den der Nutzer umbenennen kann).
 */
export function displayName(e, where = 'demos') {
  if (where === 'vault') {
    const b = baseName(e.file);
    if (/^UnsavedReplay-/i.test(b)) return 'Ungespeichertes Replay';
    return b || 'Replay';
  }
  const n = String(e.friendlyName || '').trim();
  if (!n || /^unsaved replay$/i.test(n)) return 'Ungespeichertes Replay';
  return n;
}

/** Kurzer Titel für Dialoge und Meldungen: „Erster Sieg“ oder „Replay vom 18.10.2026, 20:00“. */
export function shortTitle(e, where, fmtDate) {
  const name = displayName(e, where);
  if (name === 'Ungespeichertes Replay' && e.recordedAt && typeof fmtDate === 'function') return `Replay vom ${fmtDate(e.recordedAt)}`;
  return `„${name}“`;
}

/** Vergleicht "42.20" mit "41.4". */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Statusplaketten (immer mit Text). Rückgabe: [{ text, type, title }]
 * where: 'demos' | 'vault'; newestVersion: neueste gesehene Fortnite-Version
 */
export function statusBadges(e, where, newestVersion) {
  const out = [];
  if (e.recording) out.push({ text: 'wird gerade aufgenommen', type: 'warn', title: 'Das Match läuft noch. HELIX wartet, bis die Datei fertig ist.' });
  else if (!e.ok) out.push({ text: 'nicht lesbar', type: 'err', title: e.error || 'Die Datei sieht nicht wie ein Fortnite-Replay aus.' });
  else if (e.incomplete) out.push({ text: 'unvollständig', type: 'warn', title: 'Die Aufnahme wurde nicht sauber beendet (z. B. Absturz). Sie lässt sich vielleicht nur teilweise abspielen.' });
  if (where === 'demos' && e.inVault) out.push({ text: 'im Tresor', type: 'ok', title: 'Eine Kopie liegt sicher im Tresor.' });
  if (where === 'vault' && e.inDemos) out.push({ text: 'auch in Fortnite', type: 'accent', title: 'Fortnite hat dieses Replay noch in seinem Ordner.' });
  // Fortnite hat das Original schon gelöscht: Die Tresor-Kopie ist jetzt die einzige – und sicher.
  if (where === 'vault' && !e.inDemos) out.push({ text: 'nur im Tresor', type: 'ok', title: 'Fortnite hat das Original nicht mehr. Die Kopie im Tresor ist sicher – sie bleibt, bis du sie selbst löschst.' });
  if (e.ok && e.version && newestVersion && compareVersions(e.version, newestVersion) < 0) {
    out.push({ text: 'ältere Version', type: '', title: `Aufgenommen mit Fortnite ${e.version}. Läuft nur in dieser Version.` });
  }
  return out;
}

/** Wie viele Replays in Fortnite sind noch nicht im Tresor (und könnten gesichert werden)? */
export function unsavedCount(entries) {
  return (entries || []).filter((e) => !e.inVault && !e.recording && e.ok).length;
}

/** "12 Replays" / "1 Replay" */
export function countText(n) {
  return n === 1 ? '1 Replay' : `${n} Replays`;
}

/** Ergebnis von "Alle sichern" als kurzer Satz. */
export function copyAllText(r) {
  if (!r) return '';
  const parts = [];
  if (r.copied) parts.push(r.copied === 1 ? '1 Replay gesichert' : `${r.copied} Replays gesichert`);
  else parts.push('Nichts Neues zu sichern');
  if (r.recording) parts.push(r.recording === 1 ? '1 läuft noch' : `${r.recording} laufen noch`);
  if (r.unreadable) parts.push(r.unreadable === 1 ? '1 nicht lesbar' : `${r.unreadable} nicht lesbar`);
  if (r.failed) parts.push(r.failed === 1 ? '1 fehlgeschlagen' : `${r.failed} fehlgeschlagen`);
  return `${parts.join(', ')}.`;
}
