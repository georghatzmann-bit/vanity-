// =============================================================================
// Eingabe: Tastatur, Maus (mit Maus-Sperre), Controller, Touch/Tests
// =============================================================================
// Aus Tasten werden "Aktionen" (z. B. 'jump', 'buildWall'). Welche Taste welche
// Aktion auslöst, steht in den Einstellungen (Standard: config.js → controls).
//
// Einmal pro Logik-Schritt holt das Spiel mit sample() den Zustand ab:
//   held      – Aktion ist gerade gedrückt
//   pressed   – wurde seit dem letzten sample() gedrückt (auch ganz kurzes Tippen)
//   released  – wurde seit dem letzten sample() losgelassen
//   lookDX/DY – Maus-Bewegung in Pixeln seit dem letzten sample()
//   moveAxisX/Z, lookAxisX/Y – Controller-Sticks bzw. Touch (−1..1)
//   wheel     – Mausrad-Rasten (positiv = runter)
//   device    – zuletzt benutzt: 'keyboard' | 'gamepad' | 'touch'
// Das Objekt wird wiederverwendet (nicht speichern, sondern sofort auslesen).
//
// Maus-Sperre ("Pointer Lock"): Beim Klick ins Spiel verschwindet der
// Mauszeiger, und die Maus dreht die Kamera ohne Rand. Esc gibt die Maus frei.
//
// Für Tests und Touch gibt es "virtuelle" Eingaben:
//   setVirtual('jump', true), addLook(dx, dy), setMoveAxis(x, z), setLookAxis(x, y)
// =============================================================================
import { CONFIG } from './config.js';

// Alle Aktionen (Tastatur-Aktionen aus config.js + Extras)
export const ACTIONS = Object.freeze([...new Set([
  ...Object.keys(CONFIG.controls.keyboard),
  'sprint', // nur belegt, wenn Ducken auf Strg liegt
  'toggleBuild', // Baumodus an/aus (Tastatur Q, Controller B)
])]);

// Tasten, die der Browser selbst braucht – nie blockieren
const NEVER_BLOCK = new Set(['F5', 'F11', 'F12']);
// Diese Tasten würden im Spiel stören (Seite scrollen, Fokus springt, Schnellsuche
// in Firefox …) – während des Spielens immer blockieren
const ALWAYS_BLOCK_WHILE_PLAYING = new Set([
  'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote', 'Backspace',
]);
// ACHTUNG: Strg + W (Tab schließen), Strg + T und Strg + N lassen sich in
// keinem Browser blockieren. Darum liegt Ducken standardmäßig auf Shift.

const MOUSE_CODES = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4'];
const WHEEL_STEP = 40; // so viel "deltaY" ergibt eine Mausrad-Raste
const LOCK_SETTLE_MS = 300; // direkt nach dem Sperren können riesige Sprünge kommen (Browser-Fehler)
const LOCK_SPIKE_PX = 400; // … größer als das wird in dieser Zeit ignoriert

function emptyActionMap() {
  const map = {};
  for (const action of ACTIONS) map[action] = false;
  return map;
}

/** Baut die Tasten-Belegung aus den Einstellungen: Map<code, action[]>. */
export function buildBindings(settings) {
  const keyboard = settings?.controls?.keyboard ?? CONFIG.controls.keyboard;
  const bindings = new Map();
  const add = (code, action) => {
    if (!code) return;
    const list = bindings.get(code);
    if (list) {
      if (!list.includes(action)) list.push(action);
    } else {
      bindings.set(code, [action]);
    }
  };
  const crouchOnCtrl = !!settings?.controls?.crouchOnCtrl;
  const sprintKeys = CONFIG.controls.sprintKeysWhenCrouchOnCtrl;
  for (const action of Object.keys(CONFIG.controls.keyboard)) {
    if (crouchOnCtrl && action === 'crouch') continue;
    const codes = keyboard[action] ?? CONFIG.controls.keyboard[action];
    for (const code of codes) {
      // Bei "Ducken auf Strg" sind die Shift-Tasten für Sprinten reserviert
      if (crouchOnCtrl && sprintKeys.includes(code)) continue;
      add(code, action);
    }
  }
  if (crouchOnCtrl) {
    for (const code of CONFIG.controls.crouchCtrlKeys) add(code, 'crouch');
    for (const code of sprintKeys) add(code, 'sprint');
  }
  return bindings;
}

export class Input {
  /**
   * @param {object} settings  aus core/settings.js
   * @param {object} [options] { getGamepads: () => Gamepad[] (für Tests), now: () => ms }
   */
  constructor(settings, options = {}) {
    this.settings = settings;
    this.getGamepads = options.getGamepads ??
      (() => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []));
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

    this.element = null; // Spiel-Fläche (Canvas)
    this.locked = false; // Maus-Sperre aktiv?
    this.playing = false; // Spiel läuft (dann werden Spiel-Tasten blockiert)
    this.allowMouseWithoutLock = false; // Tests/Touch: Maus-Tasten auch ohne Sperre
    this.lookWithoutLock = false; // Notlösung ohne Maus-Sperre: Maus dreht trotzdem (solange der Zeiger im Fenster ist)
    this.device = 'keyboard';
    this.gamepadBuildMode = false; // Controller: Schultertasten bauen (Baumodus)
    this.gamepadConnected = false;
    this.onLockChange = null; // (locked) => void
    this.onLockError = null; // (error) => void

    this._count = {}; // wie viele Quellen halten die Aktion gerade?
    this._down = emptyActionMap(); // seit dem letzten sample() gedrückt
    this._up = emptyActionMap(); // seit dem letzten sample() losgelassen
    this._virtual = emptyActionMap();
    this._gp = emptyActionMap(); // Controller-Zustand beim letzten Abfragen
    this._gpNext = emptyActionMap();
    for (const action of ACTIONS) this._count[action] = 0;
    this._codesDown = new Set();
    this._lookDX = 0;
    this._lookDY = 0;
    this._wheel = 0;
    this._wheelAccum = 0;
    this._moveX = 0; // virtueller Stick (Touch)
    this._moveZ = 0;
    this._lookAxisX = 0;
    this._lookAxisY = 0;
    this._lockTime = -1e9;
    this._lockFailReported = false;
    this._gpMoveX = 0;
    this._gpMoveZ = 0;
    this._gpLookX = 0;
    this._gpLookY = 0;
    this._gpActive = false;
    // Knöpfe, die beim Umschalten Baumodus ↔ Kampf schon gedrückt waren, zählen erst
    // nach dem Loslassen wieder (sonst würde z. B. gehaltenes L2 sofort eine Rampe setzen)
    this._gpSuppressed = new Uint8Array(32);
    this._gpPrevButtons = new Uint8Array(32); // roh gedrückt bei der letzten Abfrage
    this._gpLastBuildMode = false;

    this.state = {
      held: emptyActionMap(),
      pressed: emptyActionMap(),
      released: emptyActionMap(),
      lookDX: 0,
      lookDY: 0,
      moveAxisX: 0,
      moveAxisZ: 0,
      lookAxisX: 0,
      lookAxisY: 0,
      wheel: 0,
      device: 'keyboard',
      dt: 0,
    };

    this.applySettings(settings);

    // Ereignis-Funktionen (fest gebunden, damit sie wieder abgemeldet werden können)
    this._onKeyDown = (e) => this.handleKeyDown(e);
    this._onKeyUp = (e) => this.handleKeyUp(e);
    this._onMouseDown = (e) => this.handleMouseDown(e);
    this._onMouseUp = (e) => this.handleMouseUp(e);
    this._onMouseMove = (e) => this.handleMouseMove(e);
    this._onWheel = (e) => this.handleWheel(e);
    this._onBlur = () => this.releaseAll();
    this._onVisibility = () => {
      if (document.visibilityState !== 'visible') this.releaseAll();
    };
    this._onLockChange = () => this._lockChanged();
    this._onLockError = () => this._lockFailed(new Error('Maus-Sperre wurde vom Browser abgelehnt'));
    this._onContextMenu = (e) => e.preventDefault();
    this._onAuxClick = (e) => {
      if (this.playing) e.preventDefault(); // Maus-Seitentasten: nicht "Zurück" im Browser
    };
  }

  /** Neue Einstellungen übernehmen (Tasten-Belegung). Gedrückte Tasten werden losgelassen. */
  applySettings(settings) {
    this.releaseAll();
    this.settings = settings;
    this.bindings = buildBindings(settings);
  }

  // ---------------------------------------------------------------------------
  // An den Browser anschließen
  // ---------------------------------------------------------------------------

  /** Hört auf Tastatur, Maus und Maus-Sperre. element = die Spiel-Fläche (Canvas). */
  attach(element) {
    this.detach();
    this.element = element;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onVisibility);
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('pointerlockerror', this._onLockError);
    document.addEventListener('auxclick', this._onAuxClick);
    element.addEventListener('contextmenu', this._onContextMenu);
  }

  detach() {
    if (!this.element) return;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('visibilitychange', this._onVisibility);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('pointerlockerror', this._onLockError);
    document.removeEventListener('auxclick', this._onAuxClick);
    this.element.removeEventListener('contextmenu', this._onContextMenu);
    this.element = null;
  }

  /**
   * Maus-Sperre anfordern (nur nach einem Klick erlaubt).
   * Versucht zuerst "rohe" Maus-Bewegung (ohne Windows-Beschleunigung). Kann der
   * Browser das nicht, gibt es die normale Sperre.
   */
  requestPointerLock() {
    this._lockFailReported = false; // neuer Versuch: ein Fehlschlag wird wieder gemeldet
    const element = this.element;
    if (!element || !element.requestPointerLock) {
      this._lockFailed(new Error('Dieser Browser kann die Maus nicht sperren'));
      return;
    }
    const fallback = () => {
      try {
        const p2 = element.requestPointerLock();
        if (p2 && typeof p2.catch === 'function') p2.catch((err) => this._lockFailed(err));
      } catch (err) {
        this._lockFailed(err);
      }
    };
    try {
      const p = element.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          // "NotSupportedError" = rohe Bewegung geht hier nicht → normale Sperre
          if (err && err.name === 'NotSupportedError') fallback();
          else this._lockFailed(err);
        });
      }
    } catch {
      fallback();
    }
  }

  /** Maus-Sperre freigeben. */
  exitPointerLock() {
    if (typeof document !== 'undefined' && document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  }

  _lockChanged() {
    const locked = !!this.element && document.pointerLockElement === this.element;
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked) {
      this._lockTime = this.now();
      this._lookDX = 0;
      this._lookDY = 0;
      this.device = 'keyboard';
    } else {
      this.releaseAll();
    }
    this.onLockChange?.(locked);
  }

  // Chrome meldet einen Fehlschlag doppelt (abgelehntes Promise UND "pointerlockerror") –
  // pro Versuch nur einmal weitergeben
  _lockFailed(error) {
    if (this._lockFailReported) return;
    this._lockFailReported = true;
    this.onLockError?.(error);
  }

  // ---------------------------------------------------------------------------
  // Rohe Ereignisse (öffentlich, damit Tests sie nachspielen können)
  // ---------------------------------------------------------------------------

  handleKeyDown(e) {
    if (isTextField(e.target)) return;
    const code = e.code;
    if (!code) return;
    if (this._shouldBlockKey(code)) e.preventDefault?.();
    this.device = 'keyboard';
    if (e.repeat || this._codesDown.has(code)) return; // gehaltene Taste wiederholt sich – zählt nicht neu
    this._codesDown.add(code);
    const actions = this.bindings.get(code);
    if (actions) for (let i = 0; i < actions.length; i++) this._press(actions[i]);
  }

  handleKeyUp(e) {
    const code = e.code;
    if (!code) return;
    if (this._shouldBlockKey(code)) e.preventDefault?.();
    if (!this._codesDown.has(code)) return;
    this._codesDown.delete(code);
    const actions = this.bindings.get(code);
    if (actions) for (let i = 0; i < actions.length; i++) this._release(actions[i]);
  }

  handleMouseDown(e) {
    if (!this.locked && !this.allowMouseWithoutLock) return; // Klick zum Sperren schießt nicht
    const code = MOUSE_CODES[e.button];
    if (!code) return;
    if (this.playing) e.preventDefault?.(); // Mausrad-Klick: kein Auto-Scrollen
    this.device = 'keyboard';
    if (this._codesDown.has(code)) return;
    this._codesDown.add(code);
    const actions = this.bindings.get(code);
    if (actions) for (let i = 0; i < actions.length; i++) this._press(actions[i]);
  }

  handleMouseUp(e) {
    const code = MOUSE_CODES[e.button];
    if (!code) return;
    if (this.playing) e.preventDefault?.();
    if (!this._codesDown.has(code)) return; // war nicht gedrückt (z. B. Klick zum Sperren)
    this._codesDown.delete(code);
    const actions = this.bindings.get(code);
    if (actions) for (let i = 0; i < actions.length; i++) this._release(actions[i]);
  }

  handleMouseMove(e) {
    if (!this.locked && !(this.lookWithoutLock && this.playing)) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    // Direkt nach dem Sperren melden manche Browser einen riesigen Sprung → ignorieren
    if (this.now() - this._lockTime < LOCK_SETTLE_MS && (Math.abs(dx) > LOCK_SPIKE_PX || Math.abs(dy) > LOCK_SPIKE_PX)) return;
    this._lookDX += dx;
    this._lookDY += dy;
    if (dx || dy) this.device = 'keyboard';
  }

  handleWheel(e) {
    if (!this.playing) return; // in Menüs darf das Rad scrollen
    e.preventDefault?.();
    // Einheiten angleichen: Zeilen (Firefox) und Seiten in Pixel umrechnen
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1;
    this._wheelAccum += (e.deltaY || 0) * scale;
    if (Math.abs(this._wheelAccum) < WHEEL_STEP) return;
    const notch = this._wheelAccum > 0 ? 1 : -1;
    this._wheelAccum = 0; // höchstens eine Raste pro Ereignis
    this._wheel += notch;
    this._tapCode(notch > 0 ? 'WheelDown' : 'WheelUp');
  }

  // ---------------------------------------------------------------------------
  // Virtuelle Eingaben (Touch und Tests)
  // ---------------------------------------------------------------------------

  /** Aktion virtuell drücken/loslassen. */
  setVirtual(action, down) {
    if (!Object.hasOwn(this._virtual, action)) throw new Error(`Unbekannte Aktion "${action}"`);
    down = !!down;
    if (this._virtual[action] === down) return;
    this._virtual[action] = down;
    if (down) this._press(action);
    else this._release(action);
  }

  /** Blick virtuell drehen (in "Maus-Pixeln"). */
  addLook(dx, dy) {
    this._lookDX += dx;
    this._lookDY += dy;
  }

  /** Virtueller Lauf-Stick (x rechts, z vorwärts, −1..1). */
  setMoveAxis(x, z) {
    this._moveX = x;
    this._moveZ = z;
    if (x || z) this.device = 'touch';
  }

  /** Virtueller Blick-Stick (−1..1), wirkt wie der rechte Controller-Stick. */
  setLookAxis(x, y) {
    this._lookAxisX = x;
    this._lookAxisY = y;
  }

  /** Alle Tasten loslassen (Fenster verliert den Fokus, Pause …). */
  releaseAll() {
    for (const code of this._codesDown) {
      const actions = this.bindings?.get(code);
      if (actions) for (let i = 0; i < actions.length; i++) this._release(actions[i]);
    }
    this._codesDown.clear();
    for (const action of ACTIONS) {
      if (this._virtual[action]) {
        this._virtual[action] = false;
        this._release(action);
      }
      if (this._gp[action]) {
        this._gp[action] = false;
        this._release(action);
      }
    }
    this._moveX = 0;
    this._moveZ = 0;
    this._lookAxisX = 0;
    this._lookAxisY = 0;
    this._wheelAccum = 0;
    // Gehaltene Controller-Knöpfe zählen erst nach dem Loslassen wieder (sonst würde
    // z. B. ein gehaltenes R2 nach der Pause sofort einen neuen Schuss auslösen)
    this._suppressHeldGamepadButtons();
  }

  /**
   * Verwirft "gedrückt"/"losgelassen", Maus-Bewegung und Mausrad, die noch nicht
   * abgeholt wurden – z. B. Tasten, die im Pause-Bildschirm gedrückt wurden.
   * Gehaltene Tasten bleiben gehalten (ein gehaltenes W läuft weiter).
   * Aufrufen, wenn das Spiel (wieder) losgeht.
   */
  clearEdges() {
    for (let i = 0; i < ACTIONS.length; i++) {
      this._down[ACTIONS[i]] = false;
      this._up[ACTIONS[i]] = false;
    }
    this._lookDX = 0;
    this._lookDY = 0;
    this._wheel = 0;
    this._wheelAccum = 0;
    this._suppressHeldGamepadButtons();
  }

  /**
   * Nur für Start-/Pause-Bildschirm (dort läuft sample() nicht): Wurde am Controller
   * der Pause-Knopf ("Start") neu gedrückt? Ein schon gehaltener Knopf zählt nicht.
   */
  pollPauseButton() {
    const pad = this._findPad();
    const index = CONFIG.controls.gamepad.pause;
    const buttons = pad?.buttons || [];
    const count = Math.min(buttons.length, this._gpPrevButtons.length);
    const wasDown = this._gpPrevButtons[index] === 1;
    for (let i = 0; i < this._gpPrevButtons.length; i++) this._gpPrevButtons[i] = i < count && buttonDown(buttons[i]) ? 1 : 0;
    return !wasDown && this._gpPrevButtons[index] === 1;
  }

  /** Noch nicht abgeholte Maus-Bewegung (für die Kamera, ohne sie zu verbrauchen). */
  peekLook(out) {
    out.x = this._lookDX;
    out.y = this._lookDY;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Abholen (einmal pro Logik-Schritt)
  // ---------------------------------------------------------------------------

  /**
   * Liefert den Eingabe-Zustand seit dem letzten Aufruf.
   * @param {number} dt  Länge des Logik-Schritts (s)
   */
  sample(dt = 0) {
    this._pollGamepad();
    const s = this.state;
    for (let i = 0; i < ACTIONS.length; i++) {
      const action = ACTIONS[i];
      s.held[action] = this._count[action] > 0;
      s.pressed[action] = this._down[action];
      s.released[action] = this._up[action];
      this._down[action] = false;
      this._up[action] = false;
    }
    s.lookDX = this._lookDX;
    s.lookDY = this._lookDY;
    this._lookDX = 0;
    this._lookDY = 0;
    s.wheel = this._wheel;
    this._wheel = 0;

    // Sticks: Controller + virtueller Stick, zusammen höchstens Länge 1
    let mx = this._gpMoveX + this._moveX;
    let mz = this._gpMoveZ + this._moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    s.moveAxisX = mx;
    s.moveAxisZ = mz;
    s.lookAxisX = clamp1(this._gpLookX + this._lookAxisX);
    s.lookAxisY = clamp1(this._gpLookY + this._lookAxisY);
    s.device = this.device;
    s.dt = dt;
    return s;
  }

  // Controller abfragen (Standard-Belegung, "standard mapping")
  _pollGamepad() {
    this._gpMoveX = 0;
    this._gpMoveZ = 0;
    this._gpLookX = 0;
    this._gpLookY = 0;
    const pad = this._findPad();
    const next = this._gpNext;
    for (const action of ACTIONS) next[action] = false;

    if (pad) {
      const dz = CONFIG.sensitivity.gamepadDeadzone;
      const axes = pad.axes || [];
      const left = deadzone(axes[0] || 0, axes[1] || 0, dz);
      this._gpMoveX = left.x;
      this._gpMoveZ = -left.y; // Stick nach oben = vorwärts
      const right = deadzone(axes[2] || 0, axes[3] || 0, dz);
      this._gpLookX = right.x;
      this._gpLookY = right.y;
      this._gpActive = this._gpMoveX !== 0 || this._gpMoveZ !== 0 || this._gpLookX !== 0 || this._gpLookY !== 0;

      const map = CONFIG.controls.gamepad;
      const buttons = pad.buttons || [];
      const count = Math.min(buttons.length, this._gpPrevButtons.length);
      if (this.gamepadBuildMode !== this._gpLastBuildMode) {
        this._gpLastBuildMode = this.gamepadBuildMode;
        for (let i = 0; i < count; i++) {
          if (this._gpPrevButtons[i] && buttonDown(buttons[i])) this._gpSuppressed[i] = 1;
        }
      }
      for (let i = 0; i < count; i++) this._gpPrevButtons[i] = buttonDown(buttons[i]) ? 1 : 0;
      this._gpButton(buttons, map.jump, 'jump');
      this._gpButton(buttons, map.toggleBuildMode, 'toggleBuild');
      this._gpButton(buttons, map.use, 'use');
      this._gpButton(buttons, map.scoreboard, 'scoreboard');
      this._gpButton(buttons, map.pause, 'pause');
      this._gpButton(buttons, map.edit, 'edit');
      this._gpButton(buttons, map.emote, 'emote');
      this._gpButton(buttons, map.switchMaterial, 'switchMaterial');
      this._gpButton(buttons, map.reload, 'reloadOrRotate');
      if (this.gamepadBuildMode) {
        // Baumodus: Schultertasten = Bauteil wählen UND setzen; R3 = drehen
        const b = map.buildMode;
        const anyPiece = this._gpButton(buttons, b.wall, 'buildWall') | this._gpButton(buttons, b.ramp, 'buildRamp') |
          this._gpButton(buttons, b.floor, 'buildFloor') | this._gpButton(buttons, b.roof, 'buildRoof');
        if (anyPiece) next.primary = true;
        this._gpButton(buttons, map.crouchOrRotate, 'reloadOrRotate');
      } else {
        this._gpButton(buttons, map.fire, 'primary');
        this._gpButton(buttons, map.aim, 'secondary');
        this._gpButton(buttons, map.prevWeapon, 'prevItem');
        this._gpButton(buttons, map.nextWeapon, 'nextItem');
        this._gpButton(buttons, map.crouchOrRotate, 'crouch');
      }
      if (this._gpActive) this.device = 'gamepad';
    } else {
      this._gpPrevButtons.fill(0);
    }

    // Änderungen gegenüber der letzten Abfrage als Drücken/Loslassen melden
    const prev = this._gp;
    for (const action of ACTIONS) {
      if (next[action] !== prev[action]) {
        prev[action] = next[action];
        if (next[action]) this._press(action);
        else this._release(action);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // intern
  // ---------------------------------------------------------------------------

  // Der benutzte Controller (bevorzugt mit Standard-Belegung) oder null
  _findPad() {
    let pads;
    try {
      pads = this.getGamepads() || [];
    } catch {
      pads = [];
    }
    let pad = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || p.connected === false) continue;
      if (p.mapping === 'standard') {
        pad = p;
        break;
      }
      if (!pad) pad = p;
    }
    this.gamepadConnected = !!pad;
    return pad;
  }

  // Alle gerade gehaltenen Controller-Knöpfe sperren, bis sie losgelassen werden
  _suppressHeldGamepadButtons() {
    for (let i = 0; i < this._gpPrevButtons.length; i++) {
      if (this._gpPrevButtons[i]) this._gpSuppressed[i] = 1;
    }
  }

  // Ein Controller-Knopf: gedrückt → Aktion für diese Abfrage merken. Gibt 1/0 zurück.
  _gpButton(buttons, index, action) {
    const down = buttonDown(buttons[index]);
    if (!down) {
      if (index < this._gpSuppressed.length) this._gpSuppressed[index] = 0;
      return 0;
    }
    if (this._gpSuppressed[index]) return 0;
    this._gpNext[action] = true;
    this._gpActive = true;
    return 1;
  }

  _press(action) {
    if (this._count[action] === undefined) return;
    if (this._count[action]++ === 0) this._down[action] = true;
  }

  _release(action) {
    if (!this._count[action]) return;
    if (--this._count[action] === 0) this._up[action] = true;
  }

  // Mausrad-"Taste": einmal kurz drücken und loslassen
  _tapCode(code) {
    const actions = this.bindings.get(code);
    if (!actions) return;
    for (let i = 0; i < actions.length; i++) {
      this._down[actions[i]] = true;
      this._up[actions[i]] = true;
    }
  }

  _shouldBlockKey(code) {
    if (!this.playing || NEVER_BLOCK.has(code)) return false;
    return this.bindings.has(code) || ALWAYS_BLOCK_WHILE_PLAYING.has(code);
  }
}

function isTextField(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

function buttonDown(b) {
  if (!b) return false;
  return typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
}

function clamp1(v) {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

// Runde Totzone: kleine Ausschläge = 0, danach weich von 0 bis 1
const _dz = { x: 0, y: 0 };
function deadzone(x, y, dz) {
  const mag = Math.hypot(x, y);
  if (mag <= dz) {
    _dz.x = 0;
    _dz.y = 0;
    return _dz;
  }
  const scaled = Math.min(1, (mag - dz) / (1 - dz)) / mag;
  _dz.x = x * scaled;
  _dz.y = y * scaled;
  return _dz;
}
