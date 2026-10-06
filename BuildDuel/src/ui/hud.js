// =============================================================================
// HUD – alle Anzeigen über dem 3D-Bild (HTML/CSS, Stil in src/ui/hud.css)
// =============================================================================
// Aufbau (wie im Plan, Abschnitt "HUD"):
//   Mitte        Fadenkreuz (4 Striche, Schrotflinte = Kreis, wächst mit der Streuung),
//                Treffer-X (rot bei Kill, gelb bei Kopfschuss), "EDIT", Nachlade-Ring,
//                Heil-Balken, Hinweis "E – Tür öffnen", "Bot_3 besiegt"
//   unten links  Schild-Balken (blau) über Lebens-Balken (grün), je mit Zahl; darüber "H Steuerung"
//   unten rechts Waffen-Leiste (5 Plätze + Spitzhacke) mit Munition "Magazin / Reserve",
//                darüber Bau-Leiste (Wand/Boden/Rampe/Dach mit den Tasten DEINER Tastatur)
//                und Material (Holz/Stein/Metall)
//   oben rechts  Minimap (nur mit Sturm-Zone oder wenn der Modus es will), Lebend, Kills, Zone
//   oben links   Kill-Feed (letzte 5 Meldungen)
//   oben Mitte   Stand (z. B. Duell "3 – 2" mit Namen) oder Name des Modus
//   Bildschirm   große Nachrichten ("RUNDE 2", "SIEG!"), Zielfernrohr, Treffer-Richtung (roter Bogen),
//                roter Rand bei wenig Leben, lila Färbung außerhalb der Zone, "Du schaust zu: …"
//   H            Steuerungs-Hilfe ein/aus (aus der echten Tasten-Belegung erzeugt)
//
// Leistung: Das HUD schreibt nur dann ins HTML, wenn sich ein Wert geändert hat
// (letzte Werte werden gemerkt), liest pro Bild keine Größen aus dem Layout und legt pro
// Bild keine neuen Objekte an.
//
// Andere Teile des Spiels können einen Hinweis zeigen (siehe ARCHITECTURE.md §9b):
//   game.hud.setPrompt(text | null, source?)   z. B. Modus/Tutorial
//   game.interactionPrompt = { text, action, rarity } | Text | null   Logik (Loot, Kisten), auch headless
//   game.hud.addPromptProvider(fn) → remove()  fn(player) → Text | { text, action, rarity } | null
// Ohne Bildschirm (headless) liefert createHud eine Attrappe mit denselben Methoden.
// =============================================================================
import { CONFIG } from '../config.js';
import { createKillFeed, killFeedEntry } from './killfeed.js';
import { createMinimap } from './minimap.js';
import { WEAPON_ICONS, PIECE_ICONS, HUD_ICONS, itemIcon } from './hudIcons.js';

const HC = CONFIG.hud;
const T = HC.texts;
const P = CONFIG.player;
export const INFINITY = '∞';
const PIECES = CONFIG.building.pieceTypes; // wall, floor, ramp, roof
const PIECE_ACTIONS = { wall: 'buildWall', floor: 'buildFloor', ramp: 'buildRamp', roof: 'buildRoof' };
const MATERIALS = CONFIG.materials.order;
const RELOAD_CIRCUMFERENCE = 2 * Math.PI * 19;

// =============================================================================
// Reine Hilfsfunktionen (ohne Bildschirm testbar)
// =============================================================================

/** Sekunden → "0:45", "1:05" (aufgerundet, nie negativ). */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const s = Math.ceil(seconds - 1e-6);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Munition als Text: "30 / 120" bzw. "30 / ∞". */
export function formatAmmo(mag, reserve, infinite) {
  return `${Math.max(0, mag | 0)} / ${infinite ? INFINITY : Math.max(0, reserve | 0)}`;
}

/** Anzahl (Material, Heil-Items): Zahl oder ∞. */
export function formatCount(count, infinite) {
  return infinite ? INFINITY : String(Math.max(0, Math.floor(count)));
}

/** Sekunden mit einer Nachkommastelle, deutsch: 1.44 → "1,4 s". */
export function formatSeconds(seconds) {
  return `${Math.max(0, seconds).toFixed(1).replace('.', ',')} s`;
}

// Tasten-Namen (deutsch). long = Hilfe-Fenster, short = kleine Tasten-Kappen im HUD
const KEY_NAMES = {
  Space: ['Leertaste', 'Leer'],
  ShiftLeft: ['Shift', 'Shift'],
  ShiftRight: ['Shift', 'Shift'],
  ControlLeft: ['Strg', 'Strg'],
  ControlRight: ['Strg', 'Strg'],
  AltLeft: ['Alt', 'Alt'],
  AltRight: ['Alt Gr', 'AltGr'],
  Escape: ['Esc', 'Esc'],
  Tab: ['Tab', 'Tab'],
  Enter: ['Enter', 'Enter'],
  Backspace: ['Rücktaste', '⌫'],
  CapsLock: ['Feststelltaste', 'Caps'],
  ArrowUp: ['Pfeil hoch', '↑'],
  ArrowDown: ['Pfeil runter', '↓'],
  ArrowLeft: ['Pfeil links', '←'],
  ArrowRight: ['Pfeil rechts', '→'],
  Mouse0: ['Linksklick', 'LMT'],
  Mouse1: ['Mausrad-Klick', 'MMT'],
  Mouse2: ['Rechtsklick', 'RMT'],
  Mouse3: ['Maustaste 4', 'M4'],
  Mouse4: ['Maustaste 5', 'M5'],
  WheelUp: ['Mausrad hoch', '⇡'],
  WheelDown: ['Mausrad runter', '⇣'],
};

/**
 * Anzeige-Name einer Taste (KeyboardEvent.code). Mit Tastatur-Belegung (layout = Map
 * aus navigator.keyboard.getLayoutMap()) steht dort der Buchstabe DEINER Tastatur –
 * auf einer deutschen QWERTZ-Tastatur ist 'KeyZ' also "Y".
 * @param {string} code
 * @param {Map<string,string>|null} [layout]
 * @param {boolean} [short]  kurze Form für Tasten-Kappen
 */
export function keyLabel(code, layout = null, short = false) {
  if (!code) return '';
  const named = KEY_NAMES[code];
  if (named) return named[short ? 1 : 0];
  const fromLayout = layout && typeof layout.get === 'function' ? layout.get(code) : null;
  if (fromLayout && fromLayout.trim()) return fromLayout.toUpperCase();
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

/** Mehrere Tasten: "Z / Y" (doppelte Namen nur einmal). */
export function keysLabel(codes, layout = null, short = false) {
  const out = [];
  for (const code of codes ?? []) {
    const label = keyLabel(code, layout, short);
    if (label && !out.includes(label)) out.push(label);
  }
  return out.join(' / ');
}

/**
 * Radius (Pixel) eines Streu-Kegels auf dem Bildschirm.
 * @param {number} spreadDeg  ganzer Kegel-Winkel (Grad)
 * @param {number} fovDeg     senkrechtes Sichtfeld der Kamera (Grad)
 * @param {number} viewportHeight  Bild-Höhe (CSS-Pixel)
 */
export function crosshairGapPx(spreadDeg, fovDeg, viewportHeight) {
  if (!(spreadDeg > 0) || !(fovDeg > 0) || !(viewportHeight > 0)) return 0;
  const half = (spreadDeg * Math.PI) / 360;
  return (Math.tan(half) / Math.tan((fovDeg * Math.PI) / 360)) * (viewportHeight / 2);
}

/**
 * Richtung zum Angreifer auf dem Bildschirm: Winkel (Radiant) im Uhrzeigersinn ab "oben"
 * (0 = vor dir, π/2 = rechts, π = hinter dir, −π/2 = links).
 * @param {number} dx  Angreifer.x − eigene.x
 * @param {number} dz  Angreifer.z − eigene.z
 * @param {number} yaw Blickrichtung (Kamera)
 */
export function damageAngle(dx, dz, yaw) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
}

/** Zonen-Text aus dem Sturm: "Zone schrumpft in 0:45" / "Zone schrumpft: 0:12" oder null. */
export function stormZoneText(storm) {
  if (!storm || !Number.isFinite(storm.radius) || !Number.isFinite(storm.timeLeft)) return null;
  if (storm.state === 'shrink') return `Zone schrumpft: ${formatTime(storm.timeLeft)}`;
  if (storm.state === 'closed' || storm.state === 'done') return 'Letzte Zone';
  return `Zone schrumpft in ${formatTime(storm.timeLeft)}`;
}

/**
 * Oben Mitte: Text oder Stand. Erlaubt: 'Übungsplatz' oder
 * { leftName, leftScore, rightName, rightScore } (z. B. Duell "Du 3 – 2 Bot_1").
 */
export function normalizeTopCenter(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number') return { title: String(value) };
  if (typeof value === 'object') {
    if (value.leftScore !== undefined || value.rightScore !== undefined) {
      return {
        leftName: value.leftName ?? '',
        leftScore: value.leftScore ?? 0,
        rightName: value.rightName ?? '',
        rightScore: value.rightScore ?? 0,
        title: value.title ?? null,
      };
    }
    if (value.title || value.text) return { title: String(value.title ?? value.text) };
  }
  return null;
}

// --- Tastatur-Belegung des Browsers (einmal laden, für alle HUDs) -------------------
let layoutMap = null;
let layoutRequested = false;
const layoutListeners = new Set();
function requestLayoutMap() {
  if (layoutRequested) return;
  layoutRequested = true;
  try {
    const kb = typeof navigator !== 'undefined' ? navigator.keyboard : null;
    if (!kb || typeof kb.getLayoutMap !== 'function') return;
    kb.getLayoutMap().then((map) => {
      layoutMap = map;
      for (const fn of layoutListeners) fn();
    }, () => {});
  } catch {
    // ältere Browser: Buchstaben aus dem Tasten-Code
  }
}

// =============================================================================
// Attrappe ohne Bildschirm (Tests, headless)
// =============================================================================
function createHeadlessHud(game) {
  return {
    game,
    headless: true,
    helpOpen: false,
    frameUpdate() {},
    setPrompt() {},
    addPromptProvider() {
      return () => {};
    },
    applySettings() {},
    clear() {},
    setPaused() {},
    setHelpOpen() {},
    toggleHelp() {},
    debugState() {
      return null;
    },
    dispose() {},
  };
}

// =============================================================================
// Das echte HUD
// =============================================================================

const TEMPLATE = `
<div class="hud-tint hud-storm-tint"></div>
<div class="hud-tint hud-lowhp"><div class="hud-lowhp-pulse"></div></div>
<div class="hud-dmgdir"></div>
<div class="hud-scope"><div class="hud-scope-lens"></div><i class="h"></i><i class="v"></i><i class="ticks"></i><b></b></div>
<div class="hud-center">
  <div class="hud-cross" data-type="cross"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><b class="circle"></b><b class="dot"></b></div>
  <svg class="hud-reload" viewBox="0 0 44 44" aria-hidden="true"><circle class="bg" cx="22" cy="22" r="19"/><circle class="fg" cx="22" cy="22" r="19"/></svg>
  <div class="hud-hit"><i></i><i></i><i></i><i></i></div>
  <div class="hud-edit"></div>
  <div class="hud-elim"></div>
  <div class="hud-healbar"><div class="hud-healbar-text"><span class="n"></span><span class="t"></span></div><div class="hud-healbar-track"><div class="hud-healbar-fill"></div></div></div>
  <div class="hud-prompt"><kbd></kbd><span></span></div>
</div>
<div class="hud-toast"></div>
<div class="hud-message"><div class="hud-message-text"></div></div>
<div class="hud-top">
  <div class="hud-score"><span class="ln"></span><b class="ls"></b><span class="sep">–</span><b class="rs"></b><span class="rn"></span></div>
  <div class="hud-title"></div>
  <div class="hud-extra"></div>
</div>
<div class="hud-feed"></div>
<div class="hud-side"><div class="hud-map"></div><div class="hud-stats"><div class="alive"></div><div class="kills"></div><div class="zone"></div></div></div>
<div class="hud-hint"><kbd></kbd><span></span></div>
<div class="hud-vitals">
  <div class="hud-bar shield"><span class="ico">${HUD_ICONS.shield}</span><span class="num"></span><div class="track"><div class="fill"></div></div></div>
  <div class="hud-bar health"><span class="ico">${HUD_ICONS.health}</span><span class="num"></span><div class="track"><div class="fill"></div></div></div>
</div>
<div class="hud-loadout">
  <div class="hud-mats"></div>
  <div class="hud-build"></div>
  <div class="hud-weapons">
    <div class="hud-ammo"><div class="name"></div><div class="nums"><b class="mag"></b><span class="res"></span></div><div class="state"></div></div>
    <div class="hud-slots"></div>
  </div>
</div>
<div class="hud-spectate"></div>
<div class="hud-help"><div class="hud-help-card"></div></div>
`;

/**
 * @param {object} game
 * @param {HTMLElement|null} root  Ebene über dem 3D-Bild (#ui)
 */
export function createHud(game, root) {
  if (!root || game.headless || typeof document === 'undefined') return createHeadlessHud(game);
  requestLayoutMap();

  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = TEMPLATE;
  // vor "Klicken zum Spielen", damit das Start-/Pause-Fenster darüber liegt
  const overlay = root.querySelector('#play-overlay');
  root.insertBefore(el, overlay && overlay.parentNode === root ? overlay : null);
  const q = (selector) => el.querySelector(selector);

  // --- Elemente --------------------------------------------------------------------
  const ui = {
    cross: q('.hud-cross'),
    reload: q('.hud-reload'),
    reloadFg: q('.hud-reload .fg'),
    hit: q('.hud-hit'),
    edit: q('.hud-edit'),
    elim: q('.hud-elim'),
    heal: q('.hud-healbar'),
    healName: q('.hud-healbar .n'),
    healTime: q('.hud-healbar .t'),
    healFill: q('.hud-healbar-fill'),
    prompt: q('.hud-prompt'),
    promptKey: q('.hud-prompt kbd'),
    promptText: q('.hud-prompt span'),
    toast: q('.hud-toast'),
    message: q('.hud-message'),
    messageText: q('.hud-message-text'),
    score: q('.hud-score'),
    scoreLN: q('.hud-score .ln'),
    scoreLS: q('.hud-score .ls'),
    scoreRS: q('.hud-score .rs'),
    scoreRN: q('.hud-score .rn'),
    title: q('.hud-title'),
    extra: q('.hud-extra'),
    side: q('.hud-side'),
    map: q('.hud-map'),
    alive: q('.hud-stats .alive'),
    kills: q('.hud-stats .kills'),
    zone: q('.hud-stats .zone'),
    hint: q('.hud-hint'),
    hintKey: q('.hud-hint kbd'),
    hintText: q('.hud-hint span'),
    shieldNum: q('.hud-bar.shield .num'),
    shieldFill: q('.hud-bar.shield .fill'),
    healthNum: q('.hud-bar.health .num'),
    healthFill: q('.hud-bar.health .fill'),
    mats: q('.hud-mats'),
    build: q('.hud-build'),
    ammo: q('.hud-ammo'),
    ammoName: q('.hud-ammo .name'),
    ammoMag: q('.hud-ammo .mag'),
    ammoRes: q('.hud-ammo .res'),
    ammoState: q('.hud-ammo .state'),
    slots: q('.hud-slots'),
    spectate: q('.hud-spectate'),
    help: q('.hud-help'),
    helpCard: q('.hud-help-card'),
    dmgdir: q('.hud-dmgdir'),
  };
  ui.edit.textContent = T.edit;
  el.style.setProperty('--scope-color', CONFIG.weaponVisuals.scopeOverlayColor);
  el.style.setProperty('--storm-tint', String(HC.stormTint));
  ui.hintText.textContent = T.help;

  // Material-Anzeige
  const matCells = {};
  for (const m of MATERIALS) {
    const d = document.createElement('div');
    d.className = 'hud-mat';
    d.dataset.m = m;
    d.innerHTML = `<i></i><span class="label">${CONFIG.materials.names[m]}</span><b></b>`;
    ui.mats.appendChild(d);
    matCells[m] = { el: d, num: d.querySelector('b'), v: null, active: null };
  }
  // Bau-Leiste
  const pieceCells = {};
  for (const type of PIECES) {
    const d = document.createElement('div');
    d.className = 'hud-piece';
    d.dataset.p = type;
    d.title = CONFIG.building.pieceNames[type];
    d.innerHTML = `${PIECE_ICONS[type]}<kbd></kbd><span class="label">${CONFIG.building.pieceNames[type]}</span>`;
    ui.build.appendChild(d);
    pieceCells[type] = { el: d, key: d.querySelector('kbd'), active: null };
  }
  // Waffen-Plätze: Spitzhacke + 5 Plätze
  const pick = document.createElement('div');
  pick.className = 'hud-slot pick';
  pick.innerHTML = `<span class="icon">${WEAPON_ICONS.pickaxe}</span><kbd></kbd>`;
  ui.slots.appendChild(pick);
  const pickCell = { el: pick, key: pick.querySelector('kbd'), active: null };
  const slotCells = [];
  for (let i = 0; i < 5; i++) {
    const d = document.createElement('div');
    d.className = 'hud-slot empty';
    d.innerHTML = '<span class="icon"></span><kbd></kbd><span class="count"></span>';
    ui.slots.appendChild(d);
    slotCells.push({ el: d, icon: d.querySelector('.icon'), key: d.querySelector('kbd'), count: d.querySelector('.count'), item: undefined, id: null, rarity: null, countV: null, active: null });
  }
  // Treffer-Richtung: feste Anzahl Bögen
  const arcs = [];
  for (let i = 0; i < HC.damageIndicator.count; i++) {
    const a = document.createElement('div');
    a.className = 'hud-arc';
    ui.dmgdir.appendChild(a);
    arcs.push({ el: a, timer: 0, x: 0, z: 0, angle: NaN, opacity: -1 });
  }

  const feed = createKillFeed(q('.hud-feed'));
  const minimap = createMinimap(ui.map);

  // --- Zustand (letzte Werte, damit nur Änderungen ins HTML gehen) --------------------
  let now = 0;
  let viewportH = window.innerHeight || 720;
  let disposed = false;
  const flags = {}; // Klassen am HUD-Element
  const last = {
    shield: -1, health: -1, shieldF: -1, healthF: -1,
    crossType: '', gap: -1, reloadP: -1, reloadOn: null,
    ammoKey: '', ammoMag: null, ammoRes: null, ammoState: null,
    healOn: null, healName: '', healTime: '', healF: -1,
    lowhp: -1, prompt: null, promptKey: '', promptRarity: null,
    alive: undefined, kills: undefined, zone: undefined, extra: undefined,
    topKey: '', spectate: null, hitOpacity: -1, elimOpacity: -1,
  };
  let info = null;
  let infoTimer = 0;
  let promptTimer = 0;
  let mapVisible = false;
  let helpOpen = false;
  let paused = false; // Tests/Screenshots: Zeit-Anzeigen (Treffer-X, Nachrichten …) anhalten
  const labels = { use: 'E', help: 'H' };

  // Treffer-Marker
  const hit = { timer: 0, total: 1, kind: '' };
  // "Bot_3 besiegt"
  const elim = { timer: 0 };
  // Nachrichten
  const message = { timer: 0, total: 1, kind: '' };
  const toast = { timer: 0, total: 1 };
  // Kopfschuss-Merker für den Kill-Feed (characterDamaged kommt direkt vor characterKilled)
  const lastDamage = { character: null, head: false };
  // Hinweise (E – …)
  const promptSources = new Map();
  const promptProviders = [];

  function setFlag(name, on) {
    if (flags[name] === on) return;
    flags[name] = on;
    el.classList.toggle(name, on);
  }

  function setText(node, value) {
    if (node._v === value) return;
    node._v = value;
    node.textContent = value;
  }

  // --- Tasten-Beschriftung ------------------------------------------------------------
  function bindingCodes(action) {
    return game.settings?.controls?.keyboard?.[action] ?? CONFIG.controls.keyboard[action] ?? [];
  }
  function firstKey(action, short = true) {
    return keyLabel(bindingCodes(action)[0] ?? '', layoutMap, short);
  }
  function refreshLabels() {
    for (const type of PIECES) setText(pieceCells[type].key, firstKey(PIECE_ACTIONS[type]));
    for (let i = 0; i < 5; i++) setText(slotCells[i].key, firstKey(`slot${i + 1}`));
    setText(pickCell.key, firstKey('pickaxe'));
    labels.use = firstKey('use');
    labels.help = firstKey('help');
    setText(ui.hintKey, labels.help);
    last.promptKey = '';
    if (helpOpen) renderHelp();
  }
  const onLayout = () => refreshLabels();
  layoutListeners.add(onLayout);
  refreshLabels();

  // --- Hilfe (H) -------------------------------------------------------------------------
  function renderHelp() {
    const s = game.settings ?? {};
    const c = s.controls ?? {};
    const kb = (action) => keysLabel(bindingCodes(action), layoutMap);
    const crouch = c.crouchOnCtrl ? keysLabel(CONFIG.controls.crouchCtrlKeys, layoutMap) : kb('crouch');
    // Mausrad hoch/runter zusammen: einfach "Mausrad"
    const wheelLabel = () => {
      const next = bindingCodes('nextItem');
      const prev = bindingCodes('prevItem');
      if (next.length === 1 && prev.length === 1 && /^Wheel/.test(next[0]) && /^Wheel/.test(prev[0])) return 'Mausrad';
      return `${kb('nextItem')} / ${kb('prevItem')}`;
    };
    const groups = [
      ['Bewegen', [
        ['Laufen', [kb('moveForward'), kb('moveLeft'), kb('moveBack'), kb('moveRight')].join(' ')],
        ['Umschauen', 'Maus'],
        ['Springen', kb('jump')],
        ['Ducken', `${crouch} (${c.crouchToggle ? 'umschalten' : 'halten'})`],
        ...(c.crouchOnCtrl ? [['Sprinten', keysLabel(CONFIG.controls.sprintKeysWhenCrouchOnCtrl, layoutMap)]] : []),
        ['Tanzen', kb('emote')],
      ]],
      ['Kämpfen', [
        ['Schießen', kb('primary')],
        ['Zielen', kb('secondary')],
        ['Waffen', ['slot1', 'slot2', 'slot3', 'slot4'].map((a) => firstKey(a, false)).join(' ')],
        ['Heilen', firstKey('slot5', false)],
        ['Spitzhacke', kb('pickaxe')],
        ['Nachladen', kb('reloadOrRotate')],
        ['Waffe wechseln', wheelLabel()],
      ]],
      ['Bauen', [
        ['Wand', kb('buildWall')],
        ['Boden', kb('buildFloor')],
        ['Rampe', kb('buildRamp')],
        ['Dach', kb('buildRoof')],
        ['Setzen (halten: mehrere)', kb('primary')],
        ['Drehen', kb('reloadOrRotate')],
        ['Material', kb('switchMaterial')],
      ]],
      ['Edit und mehr', [
        ['Edit an / bestätigen', kb('edit')],
        ['Felder wählen (auch ziehen)', kb('primary')],
        ['Edit zurücksetzen', kb('secondary')],
        ['Tür / Aufheben', kb('use')],
        ['Rangliste', kb('scoreboard')],
        ['Pause', kb('pause')],
        ['Hilfe ein/aus', kb('help')],
      ]],
    ];
    const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    const hint = game.mode?.helpHint;
    ui.helpCard.innerHTML =
      `<div class="hud-help-head"><b>Steuerung</b><span><kbd>${esc(labels.help)}</kbd> schließt</span></div>` +
      '<div class="hud-help-grid">' +
      groups.map(([title, rows]) => `<section><h3>${esc(title)}</h3>${rows.map(([what, key]) =>
        `<div class="row"><span>${esc(what)}</span><kbd>${esc(key)}</kbd></div>`).join('')}</section>`).join('') +
      '</div>' +
      (hint ? `<div class="hud-help-hint">${esc(hint)}</div>` : '');
  }

  function setHelpOpen(open) {
    helpOpen = !!open;
    if (helpOpen) renderHelp();
    setFlag('help-open', helpOpen);
  }

  function isTextField(target) {
    const tag = target?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target?.isContentEditable;
  }
  const onKeyDown = (event) => {
    if (event.repeat || isTextField(event.target)) return;
    if (bindingCodes('help').includes(event.code)) setHelpOpen(!helpOpen);
  };
  window.addEventListener('keydown', onKeyDown);
  const onResize = () => {
    viewportH = window.innerHeight || viewportH;
    last.gap = -1;
    minimap.measure();
  };
  window.addEventListener('resize', onResize);

  // --- Ereignisse ------------------------------------------------------------------------
  const offs = [];
  const on = (name, fn) => offs.push(game.events.on(name, fn));

  on('hit', (e) => {
    const player = game.player;
    if (!player || e.attacker !== player || e.kind !== 'character' || e.target === player) return;
    const kind = e.killed ? 'kill' : e.head ? 'head' : 'hit';
    // ein Kill bleibt sichtbar, auch wenn im selben Moment weitere Kugeln treffen
    if (hit.timer > 0 && hit.kind === 'kill' && kind !== 'kill') return;
    hit.kind = kind;
    hit.total = kind === 'kill' ? HC.hitMarker.killTime : HC.hitMarker.time;
    hit.timer = hit.total;
    ui.hit.dataset.kind = kind;
  });

  on('characterDamaged', (e) => {
    lastDamage.character = e.character;
    lastDamage.head = !!e.head;
    const player = game.player;
    const attacker = e.attacker;
    if (!player || e.character !== player || !attacker || attacker === player || !attacker.position) return;
    // freien (oder ältesten) Bogen nehmen; derselbe Angreifer frischt seinen Bogen auf
    let slot = arcs[0];
    for (const a of arcs) {
      if (a.timer <= 0 || a.timer < slot.timer) slot = a;
    }
    slot.timer = HC.damageIndicator.time;
    slot.x = attacker.position.x;
    slot.z = attacker.position.z;
    slot.angle = NaN;
  });

  on('characterKilled', (e) => {
    const player = game.player;
    const head = lastDamage.character === e.victim && lastDamage.head;
    feed.add(killFeedEntry(e, player, head), now);
    if (player && e.killer === player && e.victim !== player) {
      setText(ui.elim, `${e.victim.name} ${T.eliminated}`);
      elim.timer = HC.eliminationTime;
    }
  });

  on('message', (e) => {
    const text = String(e?.text ?? '');
    if (!text) return;
    const kind = e.kind ?? 'info';
    if (kind === 'info') {
      setText(ui.toast, text);
      toast.total = e.duration ?? HC.message.infoDuration;
      toast.timer = toast.total;
      ui.toast.style.opacity = '1';
    } else {
      setText(ui.messageText, text);
      message.kind = kind;
      ui.message.dataset.kind = kind;
      message.total = e.duration ?? HC.message.duration;
      message.timer = message.total;
    }
  });

  // --- Hinweis (E – …) ---------------------------------------------------------------------
  function doorPrompt(player) {
    const door = game.building?.doors?.size ? game.building.findDoor?.(player) : null;
    if (!door) return null;
    return door.doorOpen ? 'Tür schließen' : 'Tür öffnen';
  }

  function currentPrompt(player) {
    // 1. ausdrücklich gesetzt (neueste Quelle zuerst)
    let chosen = null;
    for (const value of promptSources.values()) chosen = value;
    if (chosen) return chosen;
    if (!player || !player.alive) return null;
    // 2. vom Spiel gesetzt (Loot/Kisten, Welle 3b): game.interactionPrompt = { text, action, rarity } oder Text
    const fromGame = game.interactionPrompt;
    if (fromGame && (typeof fromGame === 'string' || fromGame.text)) return fromGame;
    // 3. Anbieter in der Reihenfolge der Anmeldung
    for (const fn of promptProviders) {
      let value = null;
      try {
        value = fn(player);
      } catch (error) {
        console.error('HUD: Hinweis-Anbieter fehlgeschlagen', error);
      }
      if (value) return value;
    }
    // 4. Türen
    return doorPrompt(player);
  }

  function updatePrompt(player) {
    const value = currentPrompt(player);
    const text = value ? (typeof value === 'string' ? value : value.text) : null;
    const key = value && typeof value === 'object' && value.action ? firstKey(value.action) : labels.use;
    const rarity = value && typeof value === 'object' && value.rarity ? value.rarity : null;
    if (text === last.prompt && key === last.promptKey && rarity === last.promptRarity) return;
    last.prompt = text;
    last.promptKey = key;
    last.promptRarity = rarity;
    setFlag('has-prompt', !!text);
    if (text) {
      setText(ui.promptText, text);
      setText(ui.promptKey, key);
    }
    // Seltenheit (Waffe am Boden): farbiger Rand
    if (rarity) ui.prompt.dataset.r = rarity;
    else delete ui.prompt.dataset.r;
  }

  // --- Bild für Bild -------------------------------------------------------------------------
  function updateInfo() {
    try {
      info = game.mode?.hudInfo?.() ?? null;
    } catch (error) {
      info = null;
      console.error('HUD: mode.hudInfo() ist fehlgeschlagen', error);
    }
    const storm = game.storm;
    // oben Mitte
    const top = normalizeTopCenter(info?.topCenter);
    const topKey = top ? `${top.title ?? ''}|${top.leftName ?? ''}|${top.leftScore ?? ''}|${top.rightName ?? ''}|${top.rightScore ?? ''}` : '';
    if (topKey !== last.topKey) {
      last.topKey = topKey;
      const isScore = !!top && top.leftScore !== undefined;
      setFlag('has-score', isScore);
      setFlag('has-title', !!top && !!top.title);
      if (isScore) {
        setText(ui.scoreLN, top.leftName);
        setText(ui.scoreLS, String(top.leftScore));
        setText(ui.scoreRS, String(top.rightScore));
        setText(ui.scoreRN, top.rightName);
      }
      if (top?.title) setText(ui.title, top.title);
    }
    // oben rechts: Lebend, Kills, Zone
    const alive = info?.alive ?? null;
    if (alive !== last.alive) {
      last.alive = alive;
      ui.alive.hidden = alive === null;
      if (alive !== null) setText(ui.alive, `Lebend: ${alive}`);
    }
    const kills = info?.kills ?? null;
    if (kills !== last.kills) {
      last.kills = kills;
      ui.kills.hidden = kills === null;
      if (kills !== null) setText(ui.kills, `Kills: ${kills}`);
    }
    const zone = info?.zoneText ?? stormZoneText(storm);
    if (zone !== last.zone) {
      last.zone = zone;
      ui.zone.hidden = !zone;
      if (zone) setText(ui.zone, zone);
    }
    const extra = info?.extra?.length ? info.extra.join('\n') : '';
    if (extra !== last.extra) {
      last.extra = extra;
      setFlag('has-extra', !!extra);
      setText(ui.extra, extra);
    }
    setFlag('has-stats', alive !== null || kills !== null || !!zone);
    // Minimap: nur mit Sturm-Zone, oder wenn der Modus es ausdrücklich will
    const wantMap = info?.minimap ?? (!!storm && Number.isFinite(storm.radius));
    if (wantMap !== mapVisible) {
      mapVisible = wantMap;
      setFlag('has-map', wantMap);
      if (wantMap) minimap.measure();
    }
  }

  function updateVitals(p) {
    const shield = Math.ceil(Math.max(0, p.shield) - 1e-6);
    const health = Math.ceil(Math.max(0, p.health) - 1e-6);
    if (shield !== last.shield) {
      last.shield = shield;
      setText(ui.shieldNum, String(shield));
      ui.shieldFill.style.transform = `scaleX(${Math.min(1, shield / P.maxShield)})`;
      setFlag('no-shield', shield <= 0);
    }
    if (health !== last.health) {
      last.health = health;
      setText(ui.healthNum, String(health));
      ui.healthFill.style.transform = `scaleX(${Math.min(1, health / P.maxHealth)})`;
      setFlag('hp-low', health <= HC.lowHealth);
    }
  }

  function updateLoadout(p) {
    // Material
    for (const m of MATERIALS) {
      const cell = matCells[m];
      const v = p.infiniteMaterials ? INFINITY : Math.floor(p.materials[m] ?? 0);
      if (v !== cell.v) {
        cell.v = v;
        cell.num.textContent = typeof v === 'number' ? String(v) : v;
      }
      const active = p.currentMaterial === m;
      if (active !== cell.active) {
        cell.active = active;
        cell.el.classList.toggle('active', active);
      }
    }
    // Bau-Leiste
    for (const type of PIECES) {
      const cell = pieceCells[type];
      const active = p.buildPiece === type;
      if (active !== cell.active) {
        cell.active = active;
        cell.el.classList.toggle('active', active);
      }
    }
    // Waffen-Plätze
    const weaponMode = p.mode === 'weapon';
    for (let i = 0; i < 5; i++) {
      const cell = slotCells[i];
      const item = p.slots[i] ?? null;
      if (item !== cell.item) {
        cell.item = item;
        const id = item ? item.id : null;
        if (id !== cell.id) {
          cell.id = id;
          cell.icon.innerHTML = id ? itemIcon(id) : '';
          cell.el.classList.toggle('empty', !id);
          cell.el.title = item ? item.name : '';
        }
        cell.countV = null;
      }
      const rarity = item ? item.rarity ?? 'common' : null;
      if (rarity !== cell.rarity) {
        cell.rarity = rarity;
        if (rarity) cell.el.dataset.r = rarity;
        else delete cell.el.dataset.r;
      }
      const count = item && item.kind === 'heal' ? (item.infinite ? INFINITY : item.count) : '';
      if (count !== cell.countV) {
        cell.countV = count;
        cell.count.textContent = typeof count === 'number' ? String(count) : count;
      }
      const active = weaponMode && p.selectedSlot === i;
      if (active !== cell.active) {
        cell.active = active;
        cell.el.classList.toggle('active', active);
      }
    }
    const pickActive = p.mode === 'pickaxe';
    if (pickActive !== pickCell.active) {
      pickCell.active = pickActive;
      pickCell.el.classList.toggle('active', pickActive);
    }

    // Munition / Name – nur bei Änderung neu (Zahlen vergleichen, keine Texte bauen)
    const item = weaponMode ? p.slots[p.selectedSlot] ?? null : null;
    const ammo = item ? game.weapons?.getAmmo?.(p) ?? null : null;
    const la = lastAmmo;
    const mag = ammo ? ammo.mag : -1;
    const res = ammo ? ammo.reserve : -1;
    const inf = ammo ? !!ammo.infinite : false;
    const rel = ammo ? !!ammo.reloading : false;
    if (p.mode === la.mode && item === la.item && mag === la.mag && res === la.res && inf === la.inf &&
      rel === la.rel && p.buildPiece === la.piece && p.currentMaterial === la.mat) return ammo;
    la.mode = p.mode;
    la.item = item;
    la.mag = mag;
    la.res = res;
    la.inf = inf;
    la.rel = rel;
    la.piece = p.buildPiece;
    la.mat = p.currentMaterial;
    let name = '';
    let magText = '';
    let resText = '';
    let state = '';
    if (ammo && item) {
      name = item.name;
      if (ammo.heal) {
        magText = formatCount(ammo.mag, ammo.infinite);
      } else {
        magText = String(ammo.mag);
        resText = `/ ${ammo.infinite ? INFINITY : ammo.reserve}`;
        state = ammo.reloading ? T.reloading : ammo.mag <= 0 ? 'Leer' : '';
      }
    } else if (p.mode === 'pickaxe') {
      name = CONFIG.weapons.pickaxe.name;
    } else if (p.mode === 'build') {
      name = `${CONFIG.building.pieceNames[p.buildPiece] ?? ''} · ${CONFIG.materials.names[p.currentMaterial] ?? ''}`;
    } else if (p.mode === 'edit') {
      name = 'Bearbeiten';
    }
    setText(ui.ammoName, name);
    setText(ui.ammoMag, magText);
    setText(ui.ammoRes, resText);
    setText(ui.ammoState, state);
    setFlag('has-ammo', magText !== '');
    setFlag('ammo-empty', !!ammo && !ammo.heal && ammo.mag <= 0);
    return ammo;
  }
  const lastAmmo = { mode: null, item: undefined, mag: NaN, res: NaN, inf: null, rel: null, piece: null, mat: null };

  function updateCrosshair(p, ammo, dt) {
    let type;
    let spread = 0;
    if (p.mode === 'build' || p.mode === 'edit') type = 'build';
    else if (p.mode === 'pickaxe') type = 'dot';
    else {
      const ch = game.weapons?.getCrosshair?.(p);
      type = ch?.type ?? 'cross';
      spread = ch?.spread ?? 0;
    }
    if (type !== last.crossType) {
      last.crossType = type;
      ui.cross.dataset.type = type;
      last.gap = -1;
    }
    const fov = game.camera?.fov ?? CONFIG.camera.fov;
    const cfg = HC.crosshair;
    let gap = type === 'build' ? cfg.buildGap : cfg.minGap + crosshairGapPx(spread, fov, viewportH);
    gap = Math.round(Math.min(cfg.maxGap, gap) * 2) / 2;
    if (gap !== last.gap) {
      last.gap = gap;
      ui.cross.style.setProperty('--gap', `${gap}px`);
    }
    // Nachlade-Ring
    const reloading = !!ammo && !ammo.heal && ammo.reloading;
    if (reloading !== last.reloadOn) {
      last.reloadOn = reloading;
      setFlag('reloading', reloading);
      last.reloadP = -1;
    }
    if (reloading) {
      const pr = Math.round(ammo.reloadProgress * 100) / 100;
      if (pr !== last.reloadP) {
        last.reloadP = pr;
        ui.reloadFg.style.strokeDashoffset = String(RELOAD_CIRCUMFERENCE * (1 - pr));
      }
    }
    // Treffer-X
    if (hit.timer > 0) {
      hit.timer = Math.max(0, hit.timer - dt);
      const k = hit.timer / hit.total;
      const o = Math.round(Math.min(1, k * 1.6) * 20) / 20;
      if (o !== last.hitOpacity) {
        last.hitOpacity = o;
        ui.hit.style.opacity = String(o);
        ui.hit.style.transform = `translate(-50%, -50%) scale(${(1 + 0.35 * k).toFixed(3)})`;
      }
    } else if (last.hitOpacity !== 0) {
      last.hitOpacity = 0;
      ui.hit.style.opacity = '0';
    }
    // "Bot_3 besiegt"
    if (elim.timer > 0) {
      elim.timer = Math.max(0, elim.timer - dt);
      const o = Math.round(Math.min(1, elim.timer / 0.4) * 20) / 20;
      if (o !== last.elimOpacity) {
        last.elimOpacity = o;
        ui.elim.style.opacity = String(o);
      }
    } else if (last.elimOpacity !== 0) {
      last.elimOpacity = 0;
      ui.elim.style.opacity = '0';
    }
  }

  function updateHeal(p) {
    const h = p.healing;
    const onNow = !!h;
    if (onNow !== last.healOn) {
      last.healOn = onNow;
      setFlag('healing', onNow);
      last.healF = -1;
    }
    if (!h) return;
    if (h.name !== last.healName) {
      last.healName = h.name;
      setText(ui.healName, h.name);
    }
    const t = formatSecondsCached(h.timeLeft);
    if (t !== last.healTime) {
      last.healTime = t;
      setText(ui.healTime, t);
    }
    const f = Math.round(h.progress * 200) / 200;
    if (f !== last.healF) {
      last.healF = f;
      ui.healFill.style.transform = `scaleX(${f})`;
    }
  }
  // Heil-Zeit: Text nur bei neuer Zehntelsekunde bauen
  let healTenths = -1;
  let healText = '';
  function formatSecondsCached(seconds) {
    const tenths = Math.max(0, Math.round(seconds * 10));
    if (tenths !== healTenths) {
      healTenths = tenths;
      healText = formatSeconds(tenths / 10);
    }
    return healText;
  }

  function updateArcs(p, dt) {
    const yaw = game.cameraRig?.yaw ?? p.yaw;
    for (const a of arcs) {
      if (a.timer <= 0) {
        if (a.opacity !== 0) {
          a.opacity = 0;
          a.el.style.opacity = '0';
        }
        continue;
      }
      a.timer = Math.max(0, a.timer - dt);
      const angle = Math.round(damageAngle(a.x - p.position.x, a.z - p.position.z, yaw) * 100) / 100;
      if (angle !== a.angle) {
        a.angle = angle;
        a.el.style.transform = `rotate(${angle}rad)`;
      }
      const o = Math.round(Math.min(1, a.timer / (HC.damageIndicator.time * 0.6)) * 20) / 20;
      if (o !== a.opacity) {
        a.opacity = o;
        a.el.style.opacity = String(o);
      }
    }
  }

  function updateMessages(dt) {
    if (message.timer > 0) {
      message.timer = Math.max(0, message.timer - dt);
      const age = message.total - message.timer;
      const fadeIn = Math.min(1, age / 0.15);
      const fadeOut = Math.min(1, message.timer / 0.35);
      const o = Math.round(Math.min(fadeIn, fadeOut) * 20) / 20;
      const s = age < 0.15 ? 1.25 - 0.25 * (age / 0.15) : 1;
      ui.message.style.opacity = String(o);
      ui.messageText.style.transform = `scale(${s.toFixed(3)})`;
      if (message.timer <= 0) ui.message.style.opacity = '0';
    }
    if (toast.timer > 0) {
      toast.timer = Math.max(0, toast.timer - dt);
      const o = Math.round(Math.min(1, toast.timer / 0.3) * 20) / 20;
      ui.toast.style.opacity = String(o);
    }
  }

  function updateSpectate(p) {
    let text = null;
    if (p && !p.alive) {
      const target = info?.spectating ?? game.spectateTarget ?? null;
      const name = target ? (typeof target === 'string' ? target : target.name) : null;
      text = name ? `${T.spectating} ${name}` : info?.deadText ?? T.dead;
    }
    if (text === last.spectate) return;
    last.spectate = text;
    setFlag('spectating', !!text);
    if (text) setText(ui.spectate, text);
  }

  const hud = {
    game,
    headless: false,
    element: el,

    /** Pro Bild (nach der Logik). dt = echte Bild-Zeit in Sekunden. */
    frameUpdate(dt = 0) {
      if (disposed) return;
      dt = paused ? 0 : Math.min(0.25, Math.max(0, dt || 0));
      now += dt;
      const p = game.player;
      const alive = !!p && p.alive;
      setFlag('has-player', !!p);
      setFlag('dead', !!p && !p.alive);
      setFlag('mode-build', alive && p.mode === 'build');
      setFlag('mode-edit', alive && p.mode === 'edit');
      setFlag('scoped', alive && !!p.scopeFov);

      infoTimer -= dt;
      if (infoTimer <= 0) {
        infoTimer = HC.infoInterval;
        updateInfo();
      }
      let ammo = null;
      if (p) {
        updateVitals(p);
        ammo = updateLoadout(p);
        if (alive) {
          updateCrosshair(p, ammo, dt);
          updateHeal(p);
          updateArcs(p, dt);
        }
        // roter Rand bei wenig Leben
        const low = alive && p.health < HC.lowHealth ? Math.round((1 - p.health / HC.lowHealth) * 10) / 10 : 0;
        if (low !== last.lowhp) {
          last.lowhp = low;
          setFlag('lowhp', low > 0);
          if (low > 0) el.style.setProperty('--lowhp', String(0.35 + 0.65 * low));
        }
        // lila außerhalb der Zone
        const storm = game.storm;
        setFlag('outside-storm', HC.stormTint > 0 && alive && !!storm && typeof storm.isInside === 'function' && storm.isInside(p.position) === false);
      }
      if (!alive) {
        if (flags.reloading) setFlag('reloading', false);
        if (flags.healing) setFlag('healing', false);
        last.reloadOn = null;
        last.healOn = null;
      }
      promptTimer -= dt;
      if (promptTimer <= 0) {
        promptTimer = HC.promptInterval;
        updatePrompt(p);
      }
      updateMessages(dt);
      updateSpectate(p);
      feed.update(now);
      if (mapVisible) minimap.draw(game, p, now, game.cameraRig?.yaw ?? p?.yaw ?? 0);
    },

    /**
     * Hinweis setzen/löschen ("E – Tür öffnen"). text = Handlung ohne Taste ("Aufheben: Sturmgewehr")
     * oder { text, action } (action = Tasten-Aktion, Standard 'use'); null = löschen.
     * Mehrere Quellen dürfen gleichzeitig etwas setzen; gezeigt wird die zuletzt gesetzte.
     */
    setPrompt(text, source = 'default') {
      promptSources.delete(source);
      if (text) promptSources.set(source, text);
      promptTimer = 0;
    },

    /** Anbieter für Hinweise: fn(player) → Text | { text, action } | null (wird ~10-mal pro s gefragt). */
    addPromptProvider(fn) {
      promptProviders.push(fn);
      return () => {
        const i = promptProviders.indexOf(fn);
        if (i >= 0) promptProviders.splice(i, 1);
      };
    },

    /** Neue Einstellungen (Tasten-Belegung): Beschriftungen neu. */
    applySettings() {
      refreshLabels();
    },

    /** Kurze Anzeigen sofort weg (Treffer-X, Nachrichten, Treffer-Richtung, Kill-Feed) – z. B. neue Runde. */
    clear() {
      hit.timer = 0;
      elim.timer = 0;
      message.timer = 0;
      toast.timer = 0;
      ui.message.style.opacity = '0';
      ui.toast.style.opacity = '0';
      for (const a of arcs) a.timer = 0;
      feed.clear();
    },

    /** Zeit-Anzeigen anhalten (nur für Screenshots in Tests). */
    setPaused(on) {
      paused = !!on;
    },

    get helpOpen() {
      return helpOpen;
    },
    setHelpOpen,
    toggleHelp() {
      setHelpOpen(!helpOpen);
    },

    /** Für Tests: was das HUD gerade zeigt. */
    debugState() {
      const p = game.player;
      return {
        flags: Object.keys(flags).filter((k) => flags[k]),
        crosshair: { type: last.crossType, gap: last.gap },
        hit: hit.timer > 0 ? hit.kind : null,
        edit: !!flags['mode-edit'],
        shield: last.shield,
        health: last.health,
        ammo: `${ui.ammoMag.textContent} ${ui.ammoRes.textContent}`.trim(),
        ammoName: ui.ammoName.textContent,
        ammoState: ui.ammoState.textContent,
        materials: MATERIALS.map((m) => `${m}:${matCells[m].num.textContent}${matCells[m].active ? '*' : ''}`),
        buildKeys: PIECES.map((t) => pieceCells[t].key.textContent),
        slotKeys: slotCells.map((c) => c.key.textContent),
        slots: slotCells.map((c) => (c.id ? `${c.id}:${c.rarity}${c.active ? '*' : ''}` : null)),
        feed: feed.texts(),
        prompt: flags['has-prompt'] ? `${ui.promptKey.textContent} – ${ui.promptText.textContent}` : null,
        message: message.timer > 0 ? ui.messageText.textContent : null,
        toast: toast.timer > 0 ? ui.toast.textContent : null,
        elimination: elim.timer > 0 ? ui.elim.textContent : null,
        minimap: mapVisible,
        stats: { alive: last.alive, kills: last.kills, zone: last.zone },
        topCenter: last.topKey,
        spectate: last.spectate,
        heal: flags.healing ? `${ui.healName.textContent} ${ui.healTime.textContent}` : null,
        reloading: !!flags.reloading,
        arcs: arcs.filter((a) => a.timer > 0).map((a) => a.angle),
        help: helpOpen,
        player: p ? p.name : null,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      offs.length = 0;
      layoutListeners.delete(onLayout);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      feed.dispose();
      minimap.dispose();
      promptProviders.length = 0;
      promptSources.clear();
      el.remove();
    },
  };
  return hud;
}
