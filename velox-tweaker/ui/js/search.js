// Tweak search shared by the Tweaks page and the command palette.
// Ranking: whole word > start of a word > inside a word; name > tags > group/category > description.
// Short queries (4 letters or fewer) never match inside a word, so "ping" finds the ping tweaks and
// not "Snipping Tool" or "Shopping". German words map onto the English catalog tags (synonyms).

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

// query word -> extra words that count as a (weaker) match
const SYNONYMS = {
  ping: ['latency', 'network', 'nagle'],
  latenz: ['latency', 'input', 'ping'],
  lag: ['latency', 'stutter', 'ping'],
  verzogerung: ['latency', 'input'],
  netzwerk: ['network', 'internet', 'lan', 'wlan'],
  internet: ['network', 'netzwerk', 'dns'],
  wlan: ['wifi', 'network'],
  ruckler: ['stutter', 'frametime'],
  ruckelt: ['stutter', 'frametime'],
  stottern: ['stutter'],
  fps: ['fps', 'gaming', 'gpu'],
  spiele: ['gaming', 'games', 'fps'],
  spiel: ['gaming', 'games'],
  gaming: ['fps', 'games'],
  maus: ['mouse', 'zeiger'],
  tastatur: ['keyboard', 'input'],
  eingabe: ['input'],
  datenschutz: ['privacy', 'telemetry'],
  telemetrie: ['telemetry', 'privacy'],
  werbung: ['ads'],
  akku: ['battery', 'laptop'],
  strom: ['power', 'battery'],
  energie: ['power'],
  grafik: ['gpu'],
  grafikkarte: ['gpu'],
  speicher: ['storage', 'memory', 'ram'],
  festplatte: ['storage', 'ssd'],
  ki: ['ai', 'copilot'],
  sicherheit: ['security'],
  update: ['update', 'updates'],
  start: ['startup', 'boot']
};

function wordMatch(hay, w) {
  // 1 = whole word, 0.8 = start of a word, 0.3 = inside a word (only for longer words), 0 = none
  let idx = hay.indexOf(w);
  let best = 0;
  while (idx !== -1) {
    const before = idx === 0 ? ' ' : hay[idx - 1];
    const after = hay[idx + w.length] || ' ';
    const startOk = !/[a-z0-9]/.test(before);
    const endOk = !/[a-z0-9]/.test(after);
    if (startOk && endOk) return 1;
    if (startOk) best = Math.max(best, 0.8);
    else if (w.length >= 5) best = Math.max(best, 0.3);
    idx = hay.indexOf(w, idx + 1);
  }
  return best;
}

/** Prepared, normalised fields of a tweak (cached on the object). */
function fields(t, catName) {
  if (t.__sf && t.__sfCat === catName) return t.__sf;
  const f = [
    [norm(t.name), 3],
    [norm((t.tags || []).join(' ')), 2],
    [norm((t.group || '') + ' ' + (catName || '')), 1.5],
    [norm(t.desc), 1],
    [norm(t.id).replace(/[.\-_]/g, ' '), 0.6]
  ];
  Object.defineProperty(t, '__sf', { value: f, configurable: true, writable: true, enumerable: false });
  Object.defineProperty(t, '__sfCat', { value: catName, configurable: true, writable: true, enumerable: false });
  return f;
}

/** Score of a free-text query against a tweak; 0 = no match. Every query word must match. */
export function tweakScore(query, t, catName) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const f = fields(t, catName);
  let total = 0;
  for (const w of words) {
    let best = 0;
    for (const [hay, weight] of f) { const m = wordMatch(hay, w); if (m) best = Math.max(best, m * weight); }
    // synonyms count on the name and the tags only (a category called "Latenz" must not pull in everything in it)
    for (const syn of SYNONYMS[w] || []) {
      for (const [hay, weight] of f.slice(0, 2)) { const m = wordMatch(hay, syn); if (m) best = Math.max(best, m * weight * 0.6); }
    }
    if (!best) return 0;
    total += best;
  }
  return total / words.length;
}

/** Score for a short label (pages, actions in the palette). */
export function textScore(query, text) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = norm(text);
  let total = 0;
  for (const w of words) {
    const m = wordMatch(hay, w);
    if (!m) return 0;
    total += m;
  }
  return (total / words.length) * (hay.startsWith(words[0]) ? 1.2 : 1);
}
