// Simulator für den Windows-Gaming-Check (nur Browser-Vorschau).
// Spielt einen typischen PC nach: Spielmodus aus, Daueraufnahme an, Energieplan „Ausbalanciert“.

const S = 'ms-settings:';
const st = {
  gamemode: false,
  dvr: 'historical', // 'historical' | 'ready' | 'off'
  power: 'balanced', // 'balanced' | 'high' | 'saver'
  undo: {},
};

const PLAN_NAMES = { balanced: 'Ausbalanciert', high: 'Höchstleistung', saver: 'Energiesparmodus' };
const link = (uri, label) => ({ kind: 'settings', uri: S + uri, label });

function items() {
  const u = (id, label) => (st.undo[id] ? { at: st.undo[id].at, label } : undefined);
  const list = [];
  list.push(st.gamemode
    ? { id: 'gamemode', group: 'leistung', title: 'Spielmodus', status: 'good', value: 'An', text: 'Windows gibt Fortnite Vorrang und hält Updates beim Spielen zurück.', fix: null, links: [link('gaming-gamemode', 'Windows-Einstellung')], undo: u('gamemode', 'Von HELIX eingeschaltet') }
    : { id: 'gamemode', group: 'leistung', title: 'Spielmodus', status: 'change', value: 'Aus', text: 'Ohne Spielmodus können Updates im Hintergrund das Spiel stören.', fix: { label: 'Einschalten', safe: true }, links: [link('gaming-gamemode', 'Windows-Einstellung')] });
  const dvrFix = { label: 'Ausschalten', safe: true, note: 'Danach gehen Clips mit der Xbox Game Bar nicht mehr. Mit „Rückgängig“ holst du sie zurück.' };
  list.push(st.dvr === 'historical'
    ? { id: 'gamedvr', group: 'leistung', title: 'Aufnahme im Hintergrund', status: 'change', value: 'Nimmt dauernd auf', text: 'Windows filmt ständig die letzten Minuten mit. Das kostet FPS.', fix: dvrFix, links: [link('gaming-gamedvr', 'Windows-Einstellung')] }
    : { id: 'gamedvr', group: 'leistung', title: 'Aufnahme im Hintergrund', status: 'good', value: 'Aus', text: 'Windows nimmt im Hintergrund nichts auf.', fix: null, links: [link('gaming-gamedvr', 'Windows-Einstellung')], undo: u('gamedvr', 'Von HELIX ausgeschaltet') });
  const powerFix = { label: 'Höchstleistung einschalten', safe: false, confirm: `Windows nutzt dann den Plan „Höchstleistung“. Der Prozessor bleibt immer auf Tempo und braucht mehr Strom. Mit „Rückgängig“ kommt „${PLAN_NAMES[st.power]}“ zurück.` };
  list.push(st.power === 'high'
    ? { id: 'power', group: 'leistung', title: 'Energieplan', status: 'good', value: 'Höchstleistung', text: 'Der Prozessor darf immer volle Leistung geben.', fix: null, links: [link('powersleep', 'Energie-Einstellungen')], undo: u('power', 'Von HELIX umgestellt') }
    : st.power === 'saver'
      ? { id: 'power', group: 'leistung', title: 'Energieplan', status: 'change', value: 'Energiesparmodus', text: 'Bremst den Prozessor – Fortnite läuft langsamer.', fix: powerFix, links: [link('powersleep', 'Energie-Einstellungen')] }
      : { id: 'power', group: 'leistung', title: 'Energieplan', status: 'hint', value: 'Ausbalanciert', text: 'Passt für die meisten PCs. „Höchstleistung“ kann ein paar FPS bringen.', fix: powerFix, links: [link('powersleep', 'Energie-Einstellungen')] });
  list.push({ id: 'hags', group: 'leistung', title: 'Hardwarebeschleunigte GPU-Planung', status: 'hint', value: 'Aus', text: 'Kann bei neueren Grafikkarten helfen. Umschalten braucht einen Neustart.', fix: null, note: 'HELIX ändert das nicht selbst, weil es Administrator-Rechte braucht.', links: [link('display-advancedgraphics', 'Grafikeinstellungen öffnen')] });
  const diskLinks = [link('storagesense', 'Speicher-Einstellungen'), { kind: 'tool', id: 'cache', label: 'Zum Cache-Cleaner' }];
  list.push({ id: 'disk-c', group: 'system', title: 'Freier Speicher (C:, Windows)', status: 'good', value: '118 GB frei von 476 GB', text: 'Genug Platz für Updates.', fix: null, links: diskLinks });
  list.push({ id: 'disk-d', group: 'system', title: 'Freier Speicher (D:, Fortnite)', status: 'hint', value: '31 GB frei von 931 GB', text: 'Es wird eng. Für Fortnite-Updates sind 40 GB frei gut.', fix: null, links: diskLinks });
  list.push({ id: 'windows', group: 'system', title: 'Windows-Version', status: 'good', value: 'Windows 11 Home · 24H2 · Build 26100.2033', text: 'Eine aktuelle Windows-11-Version.', fix: null, links: [link('windowsupdate', 'Windows Update öffnen')] });
  list.push({ id: 'mouse', group: 'ruhe', title: 'Zeigerbeschleunigung', status: 'hint', value: 'An', text: 'Schnelle Bewegungen schieben den Zeiger weiter – nur im Menü, nicht beim Zielen.', fix: null, links: [{ kind: 'tool', id: 'maus', label: 'Zum Maus-Check' }] });
  list.push({ id: 'notifications', group: 'ruhe', title: 'Nicht stören beim Spielen', status: 'tip', value: null, text: 'Kann Meldungen automatisch ausblenden, solange ein Spiel läuft.', fix: null, links: [link('notifications', 'Benachrichtigungen öffnen')] });
  list.push({ id: 'visual', group: 'ruhe', title: 'Visuelle Effekte', status: 'tip', value: null, text: 'Kosten auf schwachen PCs etwas Leistung – in Fortnite kaum spürbar.', fix: null, links: [link('easeofaccess-visualeffects', 'Visuelle Effekte öffnen')] });
  return list;
}

function result() {
  const list = items();
  const open = list.filter((i) => i.status === 'change').length;
  const counts = { good: 0, hint: 0, change: 0, tip: 0 };
  for (const i of list) counts[i.status] += 1;
  return {
    unsupported: false,
    at: Date.now(),
    groups: [
      { id: 'leistung', title: 'Leistung beim Spielen', hint: 'Wirkt direkt auf FPS und Ruckler.' },
      { id: 'system', title: 'System', hint: 'Speicherplatz und Windows-Version.' },
      { id: 'ruhe', title: 'Ruhe und Komfort', hint: 'Weniger Ablenkung, gleichmäßige Maus.' },
    ],
    items: list,
    summary: { ...counts, open, text: open ? (open === 1 ? '1 Empfehlung offen' : `${open} Empfehlungen offen`) : 'Alles bestens' },
    safeFixes: list.filter((i) => i.status === 'change' && i.fix?.safe).map((i) => i.id),
    system: { name: 'Windows 11 Home', label: 'Windows 11 Home · 24H2 · Build 26100.2033', win11: true },
  };
}

const MSG = {
  gamemode: 'Spielmodus ist an – wirkt ab dem nächsten Fortnite-Start.',
  gamedvr: 'Aufnahme im Hintergrund ist aus – wirkt ab dem nächsten Fortnite-Start.',
  power: 'Energieplan „Höchstleistung“ ist jetzt aktiv.',
};

function apply(id) {
  if (id === 'gamemode' && !st.gamemode) { st.undo.gamemode = { at: Date.now() }; st.gamemode = true; return true; }
  if (id === 'gamedvr' && st.dvr !== 'off') { st.undo.gamedvr = { at: Date.now(), prev: st.dvr }; st.dvr = 'off'; return true; }
  if (id === 'power' && st.power !== 'high') { st.undo.power = { at: Date.now(), prev: st.power }; st.power = 'high'; return true; }
  return false;
}

export default {
  async check(_a, mctx) { await mctx.wait(700); return result(); },
  async fix(a, mctx) {
    await mctx.wait(400);
    const changed = apply(a.id);
    return { ok: true, changed, message: changed ? MSG[a.id] : 'Das war schon richtig eingestellt.', result: result() };
  },
  async fixAll(_a, mctx) {
    await mctx.wait(500);
    const ids = result().safeFixes;
    const applied = ids.filter((id) => apply(id));
    return { ok: true, applied, failed: [], result: result() };
  },
  async undo(a, mctx) {
    await mctx.wait(300);
    const u = st.undo[a.id];
    if (!u) { const e = new Error('Hier gibt es nichts rückgängig zu machen.'); e.code = 'NO_UNDO'; throw e; }
    if (a.id === 'gamemode') st.gamemode = false;
    if (a.id === 'gamedvr') st.dvr = u.prev;
    if (a.id === 'power') st.power = u.prev;
    delete st.undo[a.id];
    const message = a.id === 'power' ? `Energieplan „${PLAN_NAMES[st.power]}“ ist wieder aktiv.` : a.id === 'gamemode' ? 'Spielmodus ist wieder wie vorher.' : 'Die Aufnahme-Einstellungen sind wieder wie vorher.';
    return { ok: true, message, result: result() };
  },
  async summary() { return { text: result().summary.text }; },
};
