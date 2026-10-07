// =============================================================================
// Menü-Logik ohne Bildschirm (für Tests): Zustände, Tasten-Konflikte, Pfeil-Navigation
// =============================================================================
import { CONFIG } from '../config.js';

// -----------------------------------------------------------------------------
// Zustände des Spiels (main.js)
//   'loading' → 'lobby' → 'start' → 'playing' ⇄ 'paused' → 'lobby'
//   'start'   = Spiel ist geladen, wartet auf den Klick (Maus-Sperre)
// -----------------------------------------------------------------------------
export const MENU_STATES = Object.freeze(['loading', 'lobby', 'start', 'playing', 'paused']);

const TRANSITIONS = {
  loading: ['lobby', 'start'], // Lobby – oder Schnellstart ?mode=… direkt ins Spiel
  lobby: ['start'], // SPIELEN
  start: ['playing', 'paused', 'lobby', 'start'],
  playing: ['paused', 'start', 'lobby'],
  paused: ['playing', 'lobby', 'start', 'paused'],
};

/** Darf der Zustand von "from" nach "to" wechseln? */
export function canTransition(from, to) {
  return !!TRANSITIONS[from]?.includes(to);
}

/** Welche Knöpfe zeigt das Pause-/Start-Fenster? */
export function overlayButtons(state, modeId) {
  if (state !== 'paused' && state !== 'start') return [];
  const list = ['resume', 'settings'];
  if (modeId === 'creative') list.push('clearBuilds');
  list.push('lobby');
  return list;
}

// -----------------------------------------------------------------------------
// Tasten: Namen der Aktionen, Konflikte, Ereignis → Tasten-Code
// -----------------------------------------------------------------------------

/** Aktionen in den Einstellungen (Reihenfolge + deutscher Name), gruppiert. */
export const ACTION_GROUPS = Object.freeze([
  ['Bewegen', [
    ['moveForward', 'Vorwärts'], ['moveBack', 'Rückwärts'], ['moveLeft', 'Links'], ['moveRight', 'Rechts'],
    ['jump', 'Springen'], ['crouch', 'Ducken'], ['emote', 'Emote (Tanzen)'],
  ]],
  ['Kämpfen', [
    ['primary', 'Schießen / Bauen'], ['secondary', 'Zielen'], ['reloadOrRotate', 'Nachladen / Drehen'],
    ['pickaxe', 'Spitzhacke'], ['slot1', 'Platz 1 (Schrotflinte)'], ['slot2', 'Platz 2 (Sturmgewehr)'],
    ['slot3', 'Platz 3 (Sniper)'], ['slot4', 'Platz 4 (MP / Pistole)'], ['slot5', 'Platz 5 (Heilen)'],
    ['nextItem', 'Nächster Gegenstand'], ['prevItem', 'Voriger Gegenstand'],
  ]],
  ['Bauen', [
    ['buildWall', 'Wand'], ['buildFloor', 'Boden'], ['buildRamp', 'Rampe'], ['buildRoof', 'Dach'],
    ['edit', 'Bearbeiten (Edit)'], ['switchMaterial', 'Material wechseln'], ['clearBuilds', 'Alles löschen (Kreativ)'],
  ]],
  ['Sonstiges', [
    ['use', 'Benutzen / Aufheben'], ['scoreboard', 'Rangliste'], ['help', 'Steuerungs-Hilfe'], ['pause', 'Pause-Menü'],
  ]],
]);

/** Alle Aktionen aus config.js, die in den Gruppen fehlen, kommen in "Sonstiges" (z. B. neue). */
export function settingsActions() {
  const listed = new Set(ACTION_GROUPS.flatMap(([, rows]) => rows.map(([a]) => a)));
  const extra = Object.keys(CONFIG.controls.keyboard).filter((a) => !listed.has(a)).map((a) => [a, a]);
  return ACTION_GROUPS.map(([title, rows]) => [
    title,
    [...rows.filter(([a]) => Object.hasOwn(CONFIG.controls.keyboard, a)), ...(title === 'Sonstiges' ? extra : [])],
  ]);
}

/**
 * Doppelt belegte Tasten finden.
 * @param {object} keyboard  settings.controls.keyboard ({ action: [codes] })
 * @param {object} [options] { crouchOnCtrl } – dann sind Strg = Ducken, Shift = Sprinten
 * @returns {Map<string, string[]>}  Tasten-Code → Aktionen (nur Codes mit 2+ Aktionen)
 */
export function findKeyConflicts(keyboard, options = {}) {
  const allowed = new Set(CONFIG.controls.allowedSharedKeys);
  const byCode = new Map();
  const add = (code, action) => {
    if (!code) return;
    const list = byCode.get(code) ?? [];
    if (!list.includes(action)) list.push(action);
    byCode.set(code, list);
  };
  for (const [action, codes] of Object.entries(keyboard ?? {})) {
    if (options.crouchOnCtrl && action === 'crouch') continue;
    for (const code of codes ?? []) add(code, action);
  }
  if (options.crouchOnCtrl) {
    for (const code of CONFIG.controls.crouchCtrlKeys) add(code, 'crouch');
    for (const code of CONFIG.controls.sprintKeysWhenCrouchOnCtrl) add(code, 'sprint');
  }
  const conflicts = new Map();
  for (const [code, actions] of byCode) if (actions.length > 1 && !allowed.has(code)) conflicts.set(code, actions);
  return conflicts;
}

/**
 * Taste neu belegen: setzt code als Taste Nr. index der Aktion (ersetzt die alte dort).
 * null = Taste löschen. Gibt die neue Liste zurück (ändert keyboard direkt).
 */
export function rebind(keyboard, action, index, code) {
  const list = [...(keyboard[action] ?? [])];
  if (code === null) list.splice(index, 1);
  else if (index < list.length) list[index] = code;
  else list.push(code);
  // gleiche Taste nicht zweimal in derselben Aktion
  keyboard[action] = list.filter((c, i) => c && list.indexOf(c) === i).slice(0, 4);
  return keyboard[action];
}

/**
 * Browser-Ereignis → Tasten-Code wie in config.js:
 * KeyboardEvent → event.code, Maus → 'Mouse0' …, Mausrad → 'WheelUp' / 'WheelDown'.
 */
export function eventToCode(event) {
  if (!event) return null;
  if (event.type === 'wheel') return event.deltaY < 0 ? 'WheelUp' : event.deltaY > 0 ? 'WheelDown' : null;
  if (event.type === 'mousedown' || event.type === 'pointerdown') return `Mouse${event.button}`;
  if (event.type === 'keydown') return event.code || null;
  return null;
}

// -----------------------------------------------------------------------------
// Pfeiltasten / Controller: nächsten Knopf in einer Richtung finden
// -----------------------------------------------------------------------------

/**
 * @param {{x,y,width,height}} from  Rechteck des aktuellen Knopfs
 * @param {{x,y,width,height}[]} rects  Kandidaten
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {number} Index des besten Kandidaten oder -1
 */
export function pickNeighbor(from, rects, dir) {
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const vx = cx - fx;
    const vy = cy - fy;
    const along = vx * dx + vy * dy; // Abstand in Pfeil-Richtung
    if (along <= 1) continue;
    const across = Math.abs(vx * dy - vy * dx); // seitlicher Versatz
    const score = along + across * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
