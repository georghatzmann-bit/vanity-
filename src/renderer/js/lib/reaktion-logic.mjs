// Reaktions-Labor: reine Funktionen (ohne DOM) für Reaktionstest und Tasten-Trainer.
// Wird von der Ansicht und den Unit-Tests benutzt. Die Aktionen und Standard-Tasten müssen mit
// src/main/tools/reaktion-logic.js übereinstimmen (ein Test prüft das).

export const ROUNDS = 5;
export const MIN_DELAY_MS = 1500;
export const MAX_DELAY_MS = 4000;
export const MIN_HUMAN_MS = 100; // schneller reagiert kein Mensch auf ein Bild – das war geraten
export const MAX_REACTION_MS = 2000; // länger = abgelenkt: die Runde zählt nicht und wird wiederholt
export const PROMPTS = 20;
export const PROMPT_TIMEOUT_MS = 2500;
export const GAP_MIN_MS = 450;
export const GAP_MAX_MS = 900;

// Fortnite-Standard am PC (Wand F1, Boden F2, Treppe F3, Dach F4, Bearbeiten G, Waffen 2–6).
export const ACTIONS = [
  { id: 'wall', label: 'Wand', cmd: 'Wand!', code: 'F1', key: 'F1', on: true },
  { id: 'floor', label: 'Boden', cmd: 'Boden!', code: 'F2', key: 'F2', on: true },
  { id: 'stairs', label: 'Treppe', cmd: 'Treppe!', code: 'F3', key: 'F3', on: true },
  { id: 'roof', label: 'Dach', cmd: 'Dach!', code: 'F4', key: 'F4', on: true },
  { id: 'edit', label: 'Bearbeiten', cmd: 'Bearbeiten!', code: 'KeyG', key: 'G', on: true },
  { id: 'weapon1', label: 'Waffe 1', cmd: 'Waffe 1!', code: 'Digit2', key: '2', on: false },
  { id: 'weapon2', label: 'Waffe 2', cmd: 'Waffe 2!', code: 'Digit3', key: '3', on: false },
  { id: 'weapon3', label: 'Waffe 3', cmd: 'Waffe 3!', code: 'Digit4', key: '4', on: false },
  { id: 'weapon4', label: 'Waffe 4', cmd: 'Waffe 4!', code: 'Digit5', key: '5', on: false },
  { id: 'weapon5', label: 'Waffe 5', cmd: 'Waffe 5!', code: 'Digit6', key: '6', on: false },
];
export const ACTION_IDS = ACTIONS.map((a) => a.id);
const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export const RESERVED = /^(Escape|MetaLeft|MetaRight|OSLeft|OSRight|ContextMenu|Unidentified)$/;
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
// Längster Name unten ist „Mittlere Maustaste“ (18 Zeichen), ein Tasten-Code hat höchstens 24 Zeichen
export const LABEL_MAX = 24;

export function actionById(id) {
  return BY_ID.get(id) || null;
}

export function defaultBinds() {
  const out = {};
  for (const a of ACTIONS) out[a.id] = { code: a.code, label: a.key, on: a.on };
  return out;
}

// ---------------------------------------------------------------- Tasten-Namen

const NAMES = {
  Space: 'Leertaste', Tab: 'Tab', CapsLock: 'Feststell', Enter: 'Enter', Backspace: 'Rücktaste',
  ShiftLeft: 'Umschalt', ShiftRight: 'Umschalt rechts', ControlLeft: 'Strg', ControlRight: 'Strg rechts',
  AltLeft: 'Alt', AltRight: 'Alt Gr', ArrowUp: 'Pfeil hoch', ArrowDown: 'Pfeil runter', ArrowLeft: 'Pfeil links', ArrowRight: 'Pfeil rechts',
  Insert: 'Einfg', Delete: 'Entf', Home: 'Pos1', End: 'Ende', PageUp: 'Bild hoch', PageDown: 'Bild runter',
  Mouse0: 'Linke Maustaste', Mouse1: 'Mittlere Maustaste', Mouse2: 'Rechte Maustaste', Mouse3: 'Maus 4', Mouse4: 'Maus 5',
  WheelUp: 'Mausrad hoch', WheelDown: 'Mausrad runter',
  // deutsche Tastatur: ^ und ´ sind „tote“ Tasten (ohne eigenes Zeichen im Ereignis), < steht neben der linken Umschalttaste
  Backquote: '^', Equal: '´', IntlBackslash: '<',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadDecimal: 'Num ,', NumpadComma: 'Num ,', NumpadEnter: 'Num Enter',
};

/** Lesbarer Name zu einem Tasten-Code (ohne Tastatur-Layout: Ersatz, wenn kein gespeicherter Name da ist). */
export function codeLabel(code) {
  if (!code) return '–';
  if (NAMES[code]) return NAMES[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

/**
 * Taste/Maustaste/Mausrad aus einem Ereignis.
 * Gibt {code, label} zurück oder null (z. B. Esc, Windows-Taste, Tastenwiederholung).
 * Die linke Maustaste ist nicht belegbar (damit kann man in HELIX klicken).
 */
export function bindFromEvent(e) {
  if (!e || !e.type) return null;
  if (e.type === 'wheel') {
    if (!e.deltaY) return null;
    const code = e.deltaY < 0 ? 'WheelUp' : 'WheelDown';
    return { code, label: codeLabel(code) };
  }
  if (e.type === 'mousedown' || e.type === 'pointerdown') {
    if (!Number.isInteger(e.button) || e.button < 1 || e.button > 4) return null;
    const code = `Mouse${e.button}`;
    return { code, label: codeLabel(code) };
  }
  if (e.type === 'keydown') {
    if (e.repeat) return null;
    const code = e.code;
    if (!code || !CODE_RE.test(code) || RESERVED.test(code)) return null;
    const k = typeof e.key === 'string' ? e.key : '';
    // Ziffernblock immer als „Num …“, damit man ihn nicht mit den Zahlen oben verwechselt
    if (/^Numpad/.test(code) || k.length !== 1 || k === ' ') return { code, label: codeLabel(code) };
    const up = k.toUpperCase();
    return { code, label: up.length === 1 ? up : k }; // „ß“ bleibt „ß“ (nicht „SS“)
  }
  return null;
}

export function normalizeBinds(input) {
  const def = defaultBinds();
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const id of ACTION_IDS) {
    const b = src[id];
    if (b && typeof b === 'object' && typeof b.code === 'string' && CODE_RE.test(b.code) && !RESERVED.test(b.code)) {
      out[id] = { code: b.code, label: typeof b.label === 'string' && b.label ? b.label.slice(0, LABEL_MAX) : codeLabel(b.code), on: typeof b.on === 'boolean' ? b.on : def[id].on };
    } else out[id] = { ...def[id] };
  }
  return out;
}

/** Codes, die mehreren eingeschalteten Aktionen zugeordnet sind: Map(code -> [ids]). */
export function findDuplicates(binds) {
  const by = new Map();
  for (const id of ACTION_IDS) {
    const b = binds[id];
    if (!b || !b.on) continue;
    if (!by.has(b.code)) by.set(b.code, []);
    by.get(b.code).push(id);
  }
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

export function activeActions(binds) {
  return ACTION_IDS.filter((id) => binds[id] && binds[id].on);
}

/** Welche eingeschaltete Aktion gehört zu diesem Code? */
export function actionForCode(binds, code) {
  for (const id of ACTION_IDS) if (binds[id] && binds[id].on && binds[id].code === code) return id;
  return null;
}

/** Kann das Training starten? Gibt null oder einen verständlichen Grund zurück. */
export function trainingBlocker(binds) {
  const act = activeActions(binds);
  if (act.length < 2) return 'Schalte mindestens zwei Aktionen ein.';
  const d = findDuplicates(binds);
  if (d.size) {
    const [code, ids] = [...d][0];
    return `Die Taste ${binds[ids[0]].label || codeLabel(code)} ist doppelt belegt (${ids.map((i) => actionById(i).label).join(' und ')}).`;
  }
  return null;
}

// ---------------------------------------------------------------- Zufall

export function randomDelay(rand = Math.random) {
  return MIN_DELAY_MS + rand() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

export function randomGap(rand = Math.random) {
  return GAP_MIN_MS + rand() * (GAP_MAX_MS - GAP_MIN_MS);
}

/**
 * Zufällige Befehlsfolge: jede Aktion etwa gleich oft.
 * Ab drei Aktionen nie zweimal direkt hintereinander. Bei nur zwei Aktionen darf dieselbe auch zweimal
 * hintereinander kommen (höchstens zweimal) – sonst wäre es immer A, B, A, B und man könnte ohne Lesen drücken.
 */
export function makeSequence(ids, count = PROMPTS, rand = Math.random) {
  if (!ids.length) return [];
  if (ids.length === 1) return Array(count).fill(ids[0]);
  const two = ids.length === 2;
  const out = [];
  while (out.length < count) {
    const bag = two ? [...ids, ...ids] : ids.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    const last = out[out.length - 1];
    if (two) {
      // Übergang zum vorigen Beutel: nie dreimal dieselbe Aktion -> sonst beide Aktionen im Beutel tauschen
      const tail = out.length > 1 && out[out.length - 2] === last ? 2 : 1;
      const head = bag[1] === bag[0] ? 2 : 1;
      if (out.length && bag[0] === last && tail + head > 2) bag.forEach((x, i) => { bag[i] = x === ids[0] ? ids[1] : ids[0]; });
    } else if (out.length && bag[0] === last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    out.push(...bag);
  }
  return out.slice(0, count);
}

// ---------------------------------------------------------------- Reaktionstest

/** Ein Klick nach dem Hellwerden: 'early' wenn unter 100 ms (geraten), 'slow' wenn über 2 Sekunden (abgelenkt), sonst 'ok'. */
export function classifyPress(ms) {
  if (!Number.isFinite(ms) || ms < MIN_HUMAN_MS) return 'early';
  return ms > MAX_REACTION_MS ? 'slow' : 'ok';
}

export function evaluateReaction(times) {
  const t = times.filter((x) => Number.isFinite(x) && x > 0);
  if (!t.length) return null;
  return {
    avgMs: Math.round(t.reduce((a, b) => a + b, 0) / t.length),
    bestMs: Math.round(Math.min(...t)),
    worstMs: Math.round(Math.max(...t)),
  };
}

/** Einfache Einordnung des Durchschnitts. tone: ok | accent | warn */
export function rateReaction(avgMs) {
  if (!Number.isFinite(avgMs)) return { label: '–', text: '', tone: '' };
  if (avgMs < 200) return { label: 'Sehr schnell', text: 'Das ist Profi-Niveau.', tone: 'ok' };
  if (avgMs < 250) return { label: 'Schnell', text: 'Schneller als die meisten Menschen.', tone: 'ok' };
  if (avgMs < 300) return { label: 'Gut', text: 'Ein ganz normaler, guter Wert.', tone: 'accent' };
  if (avgMs < 360) return { label: 'Okay', text: 'Mit etwas Übung geht da noch was.', tone: 'warn' };
  return { label: 'Langsam', text: 'Müde? Mach kurz Pause und versuch es noch einmal.', tone: 'warn' };
}

// ---------------------------------------------------------------- Tasten-Trainer

/**
 * results: [{ id, kind: 'hit'|'wrong'|'timeout', ms }]
 * Rückgabe: { count, hits, wrong, timeouts, accuracy (0–100, 1 Nachkommastelle), avgMs (nur Treffer, sonst null), perAction, slowest, weakest }
 */
export function evaluateKeys(results) {
  const count = results.length;
  const hits = results.filter((r) => r.kind === 'hit');
  const wrong = results.filter((r) => r.kind === 'wrong').length;
  const timeouts = results.filter((r) => r.kind === 'timeout').length;
  const avg = (l) => (l.length ? Math.round(l.reduce((a, r) => a + r.ms, 0) / l.length) : null);
  const per = new Map();
  for (const r of results) {
    if (!per.has(r.id)) per.set(r.id, []);
    per.get(r.id).push(r);
  }
  const perAction = [...per].map(([id, list]) => {
    const h = list.filter((r) => r.kind === 'hit');
    return { id, label: actionById(id)?.label || id, total: list.length, hits: h.length, misses: list.length - h.length, avgMs: avg(h) };
  }).sort((a, b) => ACTION_IDS.indexOf(a.id) - ACTION_IDS.indexOf(b.id));
  const withTime = perAction.filter((p) => p.avgMs !== null);
  const slowest = withTime.length > 1 ? withTime.reduce((a, b) => (b.avgMs > a.avgMs ? b : a)) : null;
  const missed = perAction.filter((p) => p.misses > 0);
  const weakest = missed.length ? missed.reduce((a, b) => (b.misses > a.misses ? b : a)) : null;
  return {
    count,
    hits: hits.length,
    wrong,
    timeouts,
    accuracy: count ? Math.round((1000 * hits.length) / count) / 10 : 0,
    avgMs: avg(hits),
    perAction,
    slowest,
    weakest,
  };
}

export function rateKeys({ avgMs, accuracy }) {
  if (!Number.isFinite(accuracy)) return { label: '–', text: '', tone: '' };
  if (accuracy < 80) return { label: 'Genauigkeit üben', text: 'Lieber langsamer, dafür die richtige Taste.', tone: 'warn' };
  if (!Number.isFinite(avgMs)) return { label: '–', text: '', tone: '' };
  if (avgMs < 380 && accuracy >= 95) return { label: 'Sehr gut', text: 'Deine Finger wissen, wo die Tasten sind.', tone: 'ok' };
  if (avgMs < 500) return { label: 'Gut', text: 'Solide. Mit Übung wird es noch schneller.', tone: 'ok' };
  if (avgMs < 650) return { label: 'Okay', text: 'Übe die langsamste Taste extra.', tone: 'accent' };
  return { label: 'Weiter üben', text: 'Jeden Tag ein paar Runden helfen schon viel.', tone: 'warn' };
}

/** Tipp nach dem Training (oder null). */
export function keysTip(ev) {
  if (!ev) return null;
  if (ev.weakest && ev.weakest.misses >= 2) return `Am häufigsten daneben: ${ev.weakest.label} (${ev.weakest.misses}-mal).`;
  if (ev.slowest) return `Am langsamsten: ${ev.slowest.label} (Ø ${ev.slowest.avgMs} ms).`;
  return null;
}

// ---------------------------------------------------------------- Verlauf

/** Vergleicht den letzten Wert mit dem Schnitt der vorherigen bis zu 5 Werte. Kleiner = besser bei ms. */
export function trend(list, field = 'avgMs') {
  const vals = list.map((e) => e[field]).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const last = vals[vals.length - 1];
  const prev = vals.slice(-6, -1);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  const diff = Math.round(last - avg);
  return { last, prevAvg: Math.round(avg), diff };
}

/** Balken für ein einfaches Diagramm: Höhe 0..1 relativ zum größten Wert. */
export function bars(list, field = 'avgMs', max = 20) {
  const items = list.slice(-max).filter((e) => Number.isFinite(e[field]));
  if (!items.length) return [];
  const top = Math.max(...items.map((e) => e[field]));
  return items.map((e) => ({ at: e.at, value: e[field], h: top > 0 ? e[field] / top : 0 }));
}
