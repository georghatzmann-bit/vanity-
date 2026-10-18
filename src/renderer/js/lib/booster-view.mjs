// Spiel-Booster: reine Anzeige-Logik (ohne DOM) – Status-Texte, Bericht, Suche, Zahlen.
// Wird von der Ansicht und den Unit-Tests benutzt.

/** Status eines Programms aus deiner Liste – immer als Text, nicht nur Farbe. */
export function statusOf(entry) {
  if (!entry) return { label: 'unbekannt', type: '' };
  if (entry.boost === 'closed') return { label: 'geschlossen', type: 'ok' };
  if (entry.boost === 'forced') return { label: 'sofort beendet', type: 'ok' };
  if (entry.boost === 'open') return { label: 'noch offen', type: 'warn' };
  if (entry.running === true) return { label: 'läuft', type: 'accent' };
  if (entry.running === false) return { label: 'nicht offen', type: '' };
  return { label: 'unbekannt', type: '' };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Überschrift des letzten Berichts. */
export function reportHeadline(r) {
  if (!r) return null;
  if (r.kind === 'restore') {
    const parts = [];
    if (r.restarted?.length) parts.push(`${plural(r.restarted.length, 'Programm', 'Programme')} wieder gestartet`);
    if (r.alreadyRunning?.length) parts.push(`${r.alreadyRunning.length} liefen schon`);
    if (r.failed?.length) parts.push(`${r.failed.length} nicht gestartet`);
    return parts.length ? `Wiederhergestellt: ${parts.join(', ')}` : 'Wiederhergestellt – es gab nichts neu zu starten';
  }
  const closed = (r.closed?.length || 0) + (r.forced?.length || 0);
  const parts = [];
  if (closed) parts.push(`${plural(closed, 'Programm', 'Programme')} geschlossen`);
  if (r.stillOpen?.length) parts.push(`${r.stillOpen.length} noch offen`);
  if (!closed && !r.stillOpen?.length) parts.push('keines deiner Programme lief');
  return `Boost: ${parts.join(', ')}`;
}

/** Abschnitte des Berichts: [{ title, items:[text], type }] – nur nicht-leere. */
export function reportSections(r) {
  if (!r) return [];
  const s = [];
  const add = (title, items, type) => { if (items && items.length) s.push({ title, items, type }); };
  if (r.kind === 'restore') {
    add('Wieder gestartet', r.restarted, 'ok');
    add('Liefen schon', r.alreadyRunning, '');
    add('Nicht gestartet', (r.failed || []).map((f) => (typeof f === 'string' ? f : `${f.display}: ${f.reason}`)), 'err');
    add('Waren nicht geschlossen', r.untouched, '');
  } else {
    add('Geschlossen', r.closed, 'ok');
    add('Sofort beendet', r.forced, 'ok');
    add('Noch offen', r.stillOpen, 'warn');
    add('Liefen gerade nicht', r.notRunning, '');
    add('Fehler', (r.failed || []).map((f) => (typeof f === 'string' ? f : `${f.display}: ${f.reason}`)), 'err');
  }
  return s;
}

/** Wer hat ausgelöst? */
export function triggerText(t) {
  return t === 'auto' ? 'automatisch beim Start von Fortnite' : 'von dir gestartet';
}

/** Suche im Programm-Auswahlfenster (Name, Anzeigename, Beschreibung, Firma). */
export function filterProcesses(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list || [];
  return (list || []).filter((p) => [p.name, p.display, p.description, p.company].some((x) => String(x || '').toLowerCase().includes(q)));
}

/** Arbeitsspeicher in MB lesbar. */
export function fmtMem(mb) {
  if (!Number.isFinite(mb) || mb < 0) return '–';
  if (mb >= 1024) return `${(mb / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(mb)} MB`;
}

/** "seit 12 Min." */
export function sinceText(startedAt, now = Date.now()) {
  if (!startedAt) return '';
  const min = Math.max(0, Math.round((now - startedAt) / 60000));
  if (min < 1) return 'seit gerade eben';
  if (min < 60) return `seit ${min} Min.`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `seit ${h} Std. ${m} Min.` : `seit ${h} Std.`;
}

/** Was steht im Programm-Auswahlfenster neben dem Namen? */
export function processHint(p) {
  const parts = [`${p.display || p.name}.exe`];
  if (p.count > 1) parts.push(`${p.count} Prozesse`);
  if (Number.isFinite(p.memMb)) parts.push(fmtMem(p.memMb));
  if (p.hasWindow) parts.push('Fenster offen');
  return parts.join(' · ');
}
