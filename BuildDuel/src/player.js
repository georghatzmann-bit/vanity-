// =============================================================================
// Figur ("Character") und Bewegung
// =============================================================================
// Eine Klasse für den Spieler UND für Bots. Sie hält nur Daten (Position,
// Leben, Auswahl …). Die Bewegung macht die Funktion moveCharacter() einmal
// pro Logik-Schritt (1/60 s):
//   laufen, sprinten, ducken, springen, Schwerkraft, an Wänden anstoßen,
//   kleine Stufen hochsteigen, Rampen hochlaufen, Fallschaden.
//
// Kollision: Die Figur ist für Wände und Böden eine stehende Box
// (Breite 2 x Radius, Höhe 1,8 m bzw. geduckt 1,3 m). Bewegung: erst X, dann Z,
// dann Y – jeweils mit Prüfen und Anhalten. Rampen und Dächer sind schräge
// Platten: Man steht auf ihrer Oberseite und kann unter ihnen durchlaufen,
// wenn genug Platz ist.
//
// Gegen "Durchfallen" bei hohem Tempo wird eine lange Bewegung in kleine
// Teilschritte zerlegt (CONFIG.player.maxSubstepDistance).
//
// Leistung: In moveCharacter wird nichts Neues angelegt (Hilfs-Vektoren und
// Listen werden wiederverwendet).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { boxOverlapsStrict, slopeSurfaceY, slopeRangeOverRect } from './physics.js';
import { applyShieldFirst, fallDamage } from './core/damage.js';

const P = CONFIG.player;
const HITBOX = P.hitbox;
const DEG = Math.PI / 180;
const SKIN = 1e-4; // so viel Abstand bleibt zu einer Wand (gegen Rundungsfehler)
const MAX_SLOPE_TAN = Math.tan(P.maxWalkableSlope * DEG);
const NO_DAMAGE = Object.freeze({ shieldDamage: 0, healthDamage: 0, killed: false });
const _split = { health: 0, shield: 0, shieldDamage: 0, healthDamage: 0 }; // wiederverwendet (applyShieldFirst)

// -----------------------------------------------------------------------------
// Befehl pro Tick ("CharacterCommand", siehe ARCHITECTURE.md Abschnitt 6)
// -----------------------------------------------------------------------------

/** Ein leerer Befehl mit allen Feldern. Bitte wiederverwenden (nicht pro Tick neu anlegen). */
export function createCommand() {
  return {
    moveX: 0, // −1..1, rechts positiv
    moveZ: 0, // −1..1, vorwärts positiv
    yaw: 0,
    pitch: 0,
    jump: false,
    jumpPressed: false,
    crouch: false,
    sprint: false,
    primary: false,
    primaryPressed: false,
    primaryReleased: false,
    secondary: false,
    secondaryPressed: false,
    secondaryReleased: false,
    selectSlot: 0, // 1..5, 0 = nichts
    selectPickaxe: false,
    selectBuild: null, // 'wall' | 'floor' | 'ramp' | 'roof' | null
    toggleBuild: false,
    reloadOrRotate: false,
    edit: false, // G gehalten
    editPressed: false,
    editReleased: false,
    usePressed: false,
    emotePressed: false,
    switchMaterial: false,
    nextItem: false,
    prevItem: false,
    aimOrigin: new THREE.Vector3(),
    aimDir: new THREE.Vector3(0, 0, -1),
  };
}

/** Setzt einen Befehl auf "nichts tun" zurück (Blickrichtung bleibt wie angegeben). */
export function resetCommand(cmd, yaw = 0, pitch = 0) {
  cmd.moveX = 0;
  cmd.moveZ = 0;
  cmd.yaw = yaw;
  cmd.pitch = pitch;
  cmd.jump = false;
  cmd.jumpPressed = false;
  cmd.crouch = false;
  cmd.sprint = false;
  cmd.primary = false;
  cmd.primaryPressed = false;
  cmd.primaryReleased = false;
  cmd.secondary = false;
  cmd.secondaryPressed = false;
  cmd.secondaryReleased = false;
  cmd.selectSlot = 0;
  cmd.selectPickaxe = false;
  cmd.selectBuild = null;
  cmd.toggleBuild = false;
  cmd.reloadOrRotate = false;
  cmd.edit = false;
  cmd.editPressed = false;
  cmd.editReleased = false;
  cmd.usePressed = false;
  cmd.emotePressed = false;
  cmd.switchMaterial = false;
  cmd.nextItem = false;
  cmd.prevItem = false;
  return cmd;
}

// -----------------------------------------------------------------------------
// Figur
// -----------------------------------------------------------------------------

let nextCharacterId = 1;

/** Sucht ein Farbset ("Skin") aus config.js. Unbekannt → Standard-Skin. */
export function getSkin(id) {
  const list = CONFIG.skins.list;
  const wanted = CONFIG.skins.legacyIds?.[id] ?? id; // alte Namen (vor dem Outfit-Umbau) gehen weiter
  return list.find((s) => s.id === wanted) ?? list.find((s) => s.id === CONFIG.skins.defaultId) ?? list[0];
}

/** Sucht eine Spitzhacke (Aussehen) aus config.js. Unbekannt → Standard. */
export function getPickaxe(id) {
  const list = CONFIG.pickaxes.list;
  return list.find((p) => p.id === id) ?? list.find((p) => p.id === CONFIG.pickaxes.defaultId) ?? list[0];
}

export class Character {
  /**
   * @param {object|null} game  das Spiel (für Zeit und Ereignisse); in Tests auch null
   * @param {object} [options]  { name, team, isBot, isPlayer, skin (id oder Objekt), position, yaw,
   *                              health, shield, materials, infiniteMaterials }
   */
  constructor(game, options = {}) {
    this.game = game;
    this.id = options.id ?? nextCharacterId++;
    this.name = options.name ?? `Figur ${this.id}`;
    this.team = options.team ?? this.id;
    this.isBot = !!options.isBot;
    this.isPlayer = !!options.isPlayer;
    this.skin = typeof options.skin === 'object' && options.skin ? { ...options.skin } : { ...getSkin(options.skin) };
    this.pickaxeId = getPickaxe(options.pickaxe).id; // Aussehen der Spitzhacke (CONFIG.pickaxes)

    // Position = Mitte der Füße
    this.position = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.prevYaw = 0;
    this.prevPitch = 0;

    this.health = options.health ?? P.maxHealth;
    this.shield = options.shield ?? 0;
    this.alive = true;

    this.grounded = true;
    this.crouching = false;
    this.sprinting = false;
    this.aiming = false;
    this.moveState = 'ground'; // 'ground' | 'air' | 'freefall' | 'glide' | 'vehicle' | 'fly' (Kreativ)

    // Maße der Treffer-Kapsel (geduckt kleiner)
    this.radius = HITBOX.radius;
    this.height = HITBOX.height;

    // Auswahl
    this.mode = 'weapon'; // 'weapon' | 'pickaxe' | 'build' | 'edit'
    this.lastCombatMode = 'weapon'; // wohin "Baumodus aus" (Controller) zurückkehrt
    this.modeBeforeEdit = 'weapon';
    this.editOpenedTick = -1; // Tick, in dem der Edit-Modus geöffnet wurde (für building)
    this.slots = [null, null, null, null, null];
    this.selectedSlot = 0;
    this.buildPiece = 'wall';
    this.buildRotation = 0;
    this.materials = { wood: 0, stone: 0, metal: 0, ...(options.materials ?? {}) };
    this.currentMaterial = 'wood';
    this.infiniteMaterials = !!options.infiniteMaterials;

    this.stats = { kills: 0, damageDealt: 0, damageTaken: 0, shotsFired: 0, shotsHit: 0, headshots: 0, piecesBuilt: 0 };
    this.invulnerableUntil = 0;
    this.command = createCommand();
    this.brain = null;
    this.view = null;

    // Für andere Systeme (Waffen, Heilen, Zielfernrohr)
    this.scopeFov = null; // gesetzt (z. B. 20) = Zielfernrohr aktiv → Kamera nutzt dieses Sichtfeld
    this.speedFactor = 1; // z. B. 0,5 beim Heilen

    // Animation (wird von der Grafik gelesen)
    this.emoteUntil = 0; // Spielzeit, bis zu der die Figur tanzt
    this.actionKind = null; // 'build' | 'attack' | 'pickaxe' … (Arm-Schwung)
    this.actionTime = -10;
    this.deathTime = -10;
    this.lastLandTime = -10;
    this.stepOffset = 0; // weiche Stufe: Grafik liegt so viel tiefer (m), klingt ab
    this.prevStepOffset = 0;

    // intern (Bewegung)
    this.airPeakY = 0; // höchster Punkt seit dem Abheben (Fallschaden)
    this.coyoteTimer = 0;
    this.jumpBuffer = 0;
    this.stepDistance = 0; // für Schritt-Geräusche
    this._footstepEvent = { character: this };
    this._jumpEvent = { character: this };

    this.spawnAt(options.position ?? { x: 0, y: 0, z: 0 }, options.yaw ?? 0, 0);
  }

  /** Zeit im Spiel (Sekunden). */
  get time() {
    return this.game?.time ?? 0;
  }

  /** Setzt die Figur ohne Übergang an einen Ort (kein "Rutschen" in der Grafik). */
  spawnAt(position, yaw = this.yaw, pitch = 0) {
    this.position.set(position.x, position.y, position.z);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.prevYaw = yaw;
    this.pitch = pitch;
    this.prevPitch = pitch;
    this.grounded = true;
    this.moveState = 'ground';
    this.airPeakY = this.position.y;
    this.coyoteTimer = 0;
    this.jumpBuffer = 0;
    this.stepOffset = 0;
    this.prevStepOffset = 0;
    this.command.yaw = yaw;
    this.command.pitch = pitch;
  }

  /**
   * Schaden nehmen. Schild zuerst, dann Leben.
   * info = { attacker, weaponId, head, point, kind: 'bullet'|'explosion'|'fall'|'storm'|'melee',
   *          bypassShield?, ignoreInvulnerable? }
   * @returns {{shieldDamage: number, healthDamage: number, killed: boolean}}
   */
  applyDamage(amount, info = {}) {
    if (!this.alive || !(amount > 0)) return NO_DAMAGE;
    const time = this.time;
    if (!info.ignoreInvulnerable && time < this.invulnerableUntil) return NO_DAMAGE;

    // Schild zuerst (Rechnung in core/damage.js)
    const split = applyShieldFirst(this.health, info.bypassShield ? 0 : this.shield, amount, _split);
    const shieldDamage = split.shieldDamage;
    const healthDamage = split.healthDamage;
    this.shield -= shieldDamage;
    this.health -= healthDamage;
    const killed = this.health <= 0;
    const total = shieldDamage + healthDamage;
    const attacker = info.attacker ?? null;

    this.stats.damageTaken += total;
    if (attacker && attacker !== this) attacker.stats.damageDealt += total;

    const events = this.game?.events;
    events?.emit('characterDamaged', {
      character: this,
      attacker,
      amount: total,
      shieldDamage,
      healthDamage,
      head: !!info.head,
      weaponId: info.weaponId ?? null,
      kind: info.kind ?? 'bullet',
    });
    if (shieldDamage > 0 && this.shield <= 0) events?.emit('shieldBroken', { character: this });

    if (killed) {
      this.health = 0;
      this.alive = false;
      this.deathTime = time;
      this.aiming = false;
      this.velocity.set(0, 0, 0);
      if (attacker && attacker !== this) attacker.stats.kills++;
      events?.emit('characterKilled', { victim: this, killer: attacker, weaponId: info.weaponId ?? null });
    }
    return { shieldDamage, healthDamage, killed };
  }

  /**
   * Heilen. kind 'health' | 'shield'. Höchstens bis maxTo (und nie über das Maximum).
   * @returns {number} wie viel wirklich geheilt wurde
   */
  heal(kind, amount, maxTo) {
    if (!this.alive || !(amount > 0)) return 0;
    const isShield = kind === 'shield';
    const max = isShield ? P.maxShield : P.maxHealth;
    const cap = Math.min(max, maxTo ?? max);
    const current = isShield ? this.shield : this.health;
    const healed = Math.max(0, Math.min(amount, cap - current));
    if (healed <= 0) return 0;
    if (isShield) this.shield += healed;
    else this.health += healed;
    this.game?.events?.emit('heal', { character: this, kind: isShield ? 'shield' : 'health', amount: healed });
    return healed;
  }

  /** Augenhöhe (stehend 1,6 m, geduckt weniger). */
  eyePosition(out) {
    return out.set(this.position.x, this.position.y + (this.crouching ? P.crouchEyeHeight : P.eyeHeight), this.position.z);
  }

  /** Blickrichtung waagerecht (Länge 1). */
  forward(out) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Blickrichtung mit Neigung (Länge 1). */
  aimDirection(out) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /**
   * Für eine neue Runde: Leben, Schild, Material, Munition zurücksetzen.
   * options = { health, shield, materials, position, yaw, invulnerableFor }
   */
  resetForRound(options = {}) {
    this.alive = true;
    this.health = options.health ?? P.maxHealth;
    this.shield = options.shield ?? 0;
    if (options.materials) this.materials = { wood: 0, stone: 0, metal: 0, ...options.materials };
    if (options.infiniteMaterials !== undefined) this.infiniteMaterials = !!options.infiniteMaterials;
    this.crouching = false;
    this.height = HITBOX.height;
    this.sprinting = false;
    this.aiming = false;
    this.scopeFov = null;
    this.speedFactor = 1;
    this.emoteUntil = 0;
    this.deathTime = -10;
    this.mode = this.slots.some(Boolean) ? 'weapon' : this.mode === 'pickaxe' ? 'pickaxe' : 'weapon';
    this.invulnerableUntil = options.invulnerableFor ? this.time + options.invulnerableFor : 0;
    // Munition auffüllen (Magazin voll)
    for (const item of this.slots) {
      if (item && item.kind === 'weapon') {
        const def = CONFIG.weapons[item.id];
        if (def && def.magazine) item.ammo = def.magazine;
      }
    }
    resetCommand(this.command, this.yaw, 0);
    this.spawnAt(options.position ?? this.position, options.yaw ?? this.yaw, 0);
  }

  /** Startet einen kurzen Arm-Schwung in der Grafik (z. B. 'build', 'attack'). */
  triggerAction(kind) {
    this.actionKind = kind;
    this.actionTime = this.time;
  }

  /** Wechselt den Modus und merkt sich den letzten Kampf-Modus. */
  setMode(mode) {
    if (mode === this.mode) return;
    if (this.mode === 'weapon' || this.mode === 'pickaxe') this.lastCombatMode = this.mode;
    this.mode = mode;
  }

  /**
   * Wendet die Auswahl-Tasten des Befehls an (Schritt 3 im Spiel-Tick):
   *   - Bau-Taste (Z/X/C/V) → SOFORT Baumodus mit diesem Bauteil
   *   - Waffen-Taste (1–5) oder F (Spitzhacke) → Baumodus verlassen
   *   - G → Edit-Modus, aber nur, wenn das Bau-System sagt, dass das anvisierte
   *     Bauteil editierbar ist (game.building.canEdit). Bestätigen/Schließen
   *     macht danach das Bau-System selbst.
   *   - Controller: toggleBuild schaltet den Baumodus an/aus
   *   - Mausrad: im Baumodus Bauteil wechseln, sonst Waffe
   *   - Q (im Baumodus): Material wechseln
   *   - B: Tanz (nur am Boden)
   */
  applySelection(cmd) {
    if (!this.alive) {
      this.aiming = false;
      return;
    }
    const game = this.game;
    const wantsOther = cmd.selectBuild || cmd.selectSlot > 0 || cmd.selectPickaxe || cmd.toggleBuild;
    if (this.mode === 'edit' && wantsOther) {
      game?.building?.closeEdit?.(this);
      if (this.mode === 'edit') this.mode = this.modeBeforeEdit === 'edit' ? 'weapon' : this.modeBeforeEdit;
    }

    if (cmd.selectBuild) {
      this.setMode('build');
      this.buildPiece = cmd.selectBuild;
    } else if (cmd.selectSlot >= 1 && cmd.selectSlot <= this.slots.length) {
      const index = cmd.selectSlot - 1;
      if (this.slots[index] && index !== this.selectedSlot) {
        this.selectedSlot = index;
        game?.events?.emit('weaponSwitched', { character: this, slot: index });
      }
      this.setMode('weapon');
    } else if (cmd.selectPickaxe) {
      this.setMode('pickaxe');
    } else if (cmd.toggleBuild) {
      if (this.mode === 'build') this.setMode(this.lastCombatMode || 'weapon');
      else this.setMode('build');
    }

    if (cmd.nextItem) this.cycleItem(1);
    else if (cmd.prevItem) this.cycleItem(-1);

    if (cmd.switchMaterial && this.mode === 'build') {
      const order = CONFIG.materials.order;
      this.currentMaterial = order[(order.indexOf(this.currentMaterial) + 1) % order.length];
    }

    if (cmd.editPressed && this.mode !== 'edit' && game?.building?.canEdit?.(this)) {
      this.modeBeforeEdit = this.mode;
      this.mode = 'edit';
      this.editOpenedTick = game.tick ?? 0;
    }

    if (cmd.emotePressed && this.grounded) this.emoteUntil = this.time + P.emoteDuration;

    // Zielen (rechte Maustaste) geht nur mit der Waffe in der Hand.
    // Das Waffen-System verfeinert das (canAim: nicht mit einem Heil-Item in der Hand).
    this.aiming = !!cmd.secondary && this.mode === 'weapon' && (game?.weapons?.canAim?.(this) ?? true);
  }

  /** Mausrad: nächstes/voriges Bauteil (Baumodus) oder nächste/vorige Waffe. */
  cycleItem(direction) {
    if (this.mode === 'build') {
      const types = CONFIG.building.pieceTypes;
      const i = types.indexOf(this.buildPiece);
      this.buildPiece = types[(i + direction + types.length) % types.length];
      return;
    }
    // Reihenfolge: Spitzhacke, dann die belegten Plätze 1–5
    const options = [-1];
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]) options.push(i);
    const current = this.mode === 'pickaxe' ? -1 : this.selectedSlot;
    let index = options.indexOf(current);
    if (index < 0) index = 0;
    const next = options[(index + direction + options.length) % options.length];
    if (next === -1) {
      this.setMode('pickaxe');
    } else {
      if (next !== this.selectedSlot) {
        this.selectedSlot = next;
        this.game?.events?.emit('weaponSwitched', { character: this, slot: next });
      }
      this.setMode('weapon');
    }
  }
}

// -----------------------------------------------------------------------------
// Bewegung
// -----------------------------------------------------------------------------

// Platz für besondere Bewegungs-Arten (Freifall, Gleiter – kommen in Welle 3b).
// Ein Handler bekommt (character, command, dt, world) und erledigt die Bewegung
// selbst. Zum Landen ruft er landCharacter(character, { noDamage: true }) auf.
const moveStateHandlers = Object.create(null);

/** Meldet eine eigene Bewegungs-Art an, z. B. registerMoveStateHandler('glide', fn). */
export function registerMoveStateHandler(state, handler) {
  if (state === 'ground' || state === 'air') throw new Error('ground/air sind fest eingebaut');
  moveStateHandlers[state] = handler;
}

// wiederverwendete Hilfs-Objekte (keine neuen Objekte pro Tick)
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const _list = [];
const _list2 = [];
const _range = { min: 0, max: 0 };

const SLOPE_NONE = 0;
const SLOPE_ON_TOP = 1;
const SLOPE_UNDER = 2;
const SLOPE_BLOCKED = 3;

/**
 * Wie steht ein Körper (Füße bei y, Höhe h) zu einer Schräge?
 *   ON_TOP  = darüber (bis "tolerance" darunter zählt noch als "darauf steigen")
 *   UNDER   = ganz darunter (Kopf unter der Unterseite)
 *   BLOCKED = steckt in der Platte
 */
function classifySlope(c, x, y, z, r, h, tolerance) {
  if (x + r <= c.minX || x - r >= c.maxX || z + r <= c.minZ || z - r >= c.maxZ) return SLOPE_NONE;
  const s = slopeSurfaceY(c, x, z);
  if (y >= s - tolerance - 1e-4) return SLOPE_ON_TOP;
  slopeRangeOverRect(c, x - r, x + r, z - r, z + r, _range);
  if (y + h <= _range.min - c.vThickness + 1e-4) return SLOPE_UNDER;
  return SLOPE_BLOCKED;
}

/** Passt ein Körper an diese Stelle (ohne in einer Box/Schräge zu stecken)? */
export function bodyFits(world, x, y, z, r, h) {
  _min.set(x - r, y, z - r);
  _max.set(x + r, y + h, z + r);
  const list = world.queryBox(_min, _max, _list2);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.type === 'box') {
      if (boxOverlapsStrict(c, x - r, y, z - r, x + r, y + h, z + r)) return false;
    } else if (classifySlope(c, x, y, z, r, h, 0) === SLOPE_BLOCKED) {
      return false;
    }
  }
  return true;
}

/**
 * Höchste Fläche unter den Füßen zwischen minY und y (Boxen, Schrägen, Gelände).
 * Das Gelände zählt immer (auch wenn man darunter steckt → nach oben schieben).
 * @returns {number} Höhe oder -Infinity
 */
export function findSupport(world, x, y, z, r, minY) {
  let best = -Infinity;
  _min.set(x - r, minY - 1e-3, z - r);
  _max.set(x + r, y + 1e-3, z + r);
  const list = world.queryBox(_min, _max, _list2);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.type === 'box') {
      // Füße müssen wirklich über der Box stehen (nicht nur am Rand entlang)
      if (c.min.x >= x + r - 1e-5 || c.max.x <= x - r + 1e-5 || c.min.z >= z + r - 1e-5 || c.max.z <= z - r + 1e-5) continue;
      const top = c.max.y;
      if (top <= y + 1e-4 && top >= minY - 1e-9 && top > best) best = top;
    } else {
      if (x + r <= c.minX || x - r >= c.maxX || z + r <= c.minZ || z - r >= c.maxZ) continue;
      const s = slopeSurfaceY(c, x, z);
      if (s <= y + 1e-4 && s >= minY - 1e-9 && s > best) best = s;
    }
  }
  const t = world.terrain.heightAt(x, z);
  if (t >= minY && t > best) best = t;
  return best;
}

// Ergebnis von moveAxis
const MOVED = 0;
const BLOCKED = 1;

/**
 * Bewegt die Figur auf einer waagerechten Achse (0 = X, 2 = Z) um d.
 * Stößt sie an, bleibt sie an der Kante stehen. Kleine Stufen und Rampen
 * werden hochgestiegen.
 */
function moveAxis(ch, world, axis, d, depth = 0) {
  const r = ch.radius;
  const h = ch.height;
  const oldX = ch.position.x;
  const oldZ = ch.position.z;
  const y = ch.position.y;
  const x = axis === 0 ? oldX + d : oldX;
  const z = axis === 2 ? oldZ + d : oldZ;

  _min.set(x - r, y, z - r);
  _max.set(x + r, y + h + P.stepHeight, z + r);
  const list = world.queryBox(_min, _max, _list);
  let stepTo = y;
  let stepFromBox = false;
  let limit = d;
  let hardBlock = false;

  // 1. Durchgang: Schrägen und Gelände (heben die Füße evtl. schon an)
  // slopeFront = höchste Rampen-Fläche unter dem Körper-Umriss. Oben an einer Rampe ist
  // die Vorderkante des Körpers schon höher als die Füße (Mitte) – von dort aus zählt
  // eine Stufe auf die anschließende Plattform.
  let slopeFront = y;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.type === 'box') continue;
    if (classifySlope(c, x, y, z, r, h, P.stepHeight) === SLOPE_ON_TOP) {
      const s = slopeSurfaceY(c, x, z);
      if (s > stepTo) stepTo = s;
      if (slopeRangeOverRect(c, x - r, x + r, z - r, z + r, _range) && _range.max > slopeFront) slopeFront = _range.max;
    }
  }
  // Rampe → Rampe (Rampen-Kette, Grat): Die nächste Rampe zählt ab der Vorderkante
  // der Figur – genauso wie die Plattform am Ende einer Rampe (siehe unten).
  const slopeBase = Math.max(y, Math.min(slopeFront, y + P.stepHeight));
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.type === 'box') continue;
    const cls = classifySlope(c, x, y, z, r, h, P.stepHeight);
    if (cls === SLOPE_ON_TOP) continue; // schon oben gezählt
    if (slopeBase > y && classifySlope(c, x, slopeBase, z, r, h, P.stepHeight) === SLOPE_ON_TOP) {
      const s = slopeSurfaceY(c, x, z);
      if (s > stepTo) stepTo = s;
    } else if (cls === SLOPE_BLOCKED && classifySlope(c, oldX, y, oldZ, r, h, P.stepHeight) !== SLOPE_BLOCKED) {
      hardBlock = true;
    }
  }
  // Gelände: sanfte Hänge hoch, zu steile blockieren
  const t = world.terrain.heightAt(x, z);
  if (t > y) {
    if (t - y <= P.stepHeight + Math.abs(d) * MAX_SLOPE_TAN) {
      if (t > stepTo) stepTo = t;
    } else if (world.terrain.heightAt(oldX, oldZ) <= y + 1e-4) {
      hardBlock = true;
    }
  }

  // 2. Durchgang: Boxen – gemessen ab der (evtl. angehobenen) Fuß-Höhe
  const feet = stepTo;
  const stepBase = Math.max(feet, Math.min(slopeFront, feet + P.stepHeight));
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.type !== 'box') continue;
    if (!boxOverlapsStrict(c, x - r, feet, z - r, x + r, feet + h, z + r)) continue;
    // Steckte man schon vorher drin (z. B. Bauteil im Körper), darf man hinaus.
    if (boxOverlapsStrict(c, oldX - r, y, oldZ - r, oldX + r, y + h, oldZ + r)) continue;
    const top = c.max.y;
    if (top - stepBase <= P.stepHeight + 1e-4) {
      if (top > stepTo) {
        stepTo = top;
        stepFromBox = true;
      }
      continue;
    }
    // Wand: bis an die Kante heran
    const pos = axis === 0 ? oldX : oldZ;
    if (d > 0) {
      const allowed = Math.max(0, (axis === 0 ? c.min.x : c.min.z) - (pos + r) - SKIN);
      if (allowed < limit) limit = allowed;
    } else {
      const allowed = Math.min(0, (axis === 0 ? c.max.x : c.max.z) - (pos - r) + SKIN);
      if (allowed > limit) limit = allowed;
    }
  }

  if (hardBlock) {
    // Schräge im Weg: halbe Strecke versuchen (kleinerer Spalt zur Kante)
    if (depth < 2) return moveAxis(ch, world, axis, d / 2, depth + 1);
    setAxisVelocity(ch, axis, 0);
    return BLOCKED;
  }

  if (limit !== d) {
    // nur bis an die Wand – dabei aber Rampen/Stufen auf dem Teilstück beachten
    setAxisVelocity(ch, axis, 0);
    if (Math.abs(limit) > 1e-6 && depth < 3) moveAxis(ch, world, axis, limit, depth + 1);
    return BLOCKED;
  }

  if (stepTo > y + 1e-6) {
    // Stufe / Rampe: passt der Körper oben hin (keine Decke im Weg)?
    if (!bodyFits(world, x, stepTo, z, r, h)) {
      setAxisVelocity(ch, axis, 0);
      return BLOCKED;
    }
    if (stepFromBox) addStepOffset(ch, y - stepTo);
    ch.position.y = stepTo;
  }
  if (axis === 0) ch.position.x = x;
  else ch.position.z = z;
  return MOVED;
}

function setAxisVelocity(ch, axis, value) {
  if (axis === 0) ch.velocity.x = value;
  else ch.velocity.z = value;
}

// Grafik weich nachziehen lassen (negativ = Grafik liegt tiefer als die Logik)
function addStepOffset(ch, amount) {
  ch.stepOffset = Math.max(-0.6, Math.min(0.6, ch.stepOffset + amount));
}

const LANDED = 1;
const CEILING = 2;

/** Senkrechte Bewegung um dy mit Landen (dy < 0) oder Kopfstoß (dy > 0). */
function moveVertical(ch, world, dy) {
  const r = ch.radius;
  const h = ch.height;
  const x = ch.position.x;
  const z = ch.position.z;
  const y = ch.position.y;
  if (dy < 0) {
    const newY = y + dy;
    const support = findSupport(world, x, y, z, r, newY);
    if (support > -Infinity) {
      ch.position.y = support;
      return LANDED;
    }
    ch.position.y = newY;
    return 0;
  }
  const head = y + h;
  const newHead = head + dy;
  _min.set(x - r, head - 1e-3, z - r);
  _max.set(x + r, newHead, z + r);
  const list = world.queryBox(_min, _max, _list);
  let ceiling = Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.type === 'box') {
      if (c.min.x >= x + r - 1e-5 || c.max.x <= x - r + 1e-5 || c.min.z >= z + r - 1e-5 || c.max.z <= z - r + 1e-5) continue;
      const bottom = c.min.y;
      if (bottom >= head - 1e-4 && bottom < newHead && bottom < ceiling) ceiling = bottom;
    } else {
      if (x + r <= c.minX || x - r >= c.maxX || z + r <= c.minZ || z - r >= c.maxZ) continue;
      slopeRangeOverRect(c, x - r, x + r, z - r, z + r, _range);
      const underside = _range.min - c.vThickness;
      if (underside >= head - 1e-4 && underside < newHead && underside < ceiling) ceiling = underside;
    }
  }
  if (ceiling < Infinity) {
    // nie tiefer als vorher (die Decke darf bis 0,1 mm unter dem Kopf liegen –
    // sonst würden die Füße in den Boden gedrückt)
    ch.position.y = Math.max(y, ceiling - h);
    return CEILING;
  }
  ch.position.y = y + dy;
  return 0;
}

/**
 * Landen: Fallschaden ausrechnen und "land" melden.
 * options.noDamage = true → kein Fallschaden (z. B. nach dem Gleiter); ebenso, wenn die
 * Figur ch.noFallDamage hat (Kreativ-Modus)
 */
export function landCharacter(ch, options = {}) {
  const fallHeight = Math.max(0, ch.airPeakY - ch.position.y);
  const previous = ch.moveState;
  ch.grounded = true;
  ch.moveState = 'ground';
  ch.velocity.y = 0;
  ch.lastLandTime = ch.time;
  ch.game?.events?.emit('land', { character: ch, fallHeight });
  const fd = P.fallDamage;
  // ch.noFallDamage: Modus ohne Fallschaden (Kreativ)
  const noDamage = options.noDamage || ch.noFallDamage || previous === 'freefall' || previous === 'glide';
  if (!noDamage && fallHeight > fd.safeHeight) {
    ch.applyDamage(fallDamage(fallHeight, fd), { kind: 'fall', weaponId: 'fall' });
  }
  ch.airPeakY = ch.position.y;
  return fallHeight;
}

/**
 * Ein Logik-Schritt Bewegung für eine Figur (Schritt 4 im Spiel-Tick).
 * @param {Character} ch
 * @param {object} command  CharacterCommand
 * @param {number} dt       Sekunden (1/60)
 * @param {CollisionWorld} world
 */
export function moveCharacter(ch, command, dt, world) {
  // Stand vom Anfang des Ticks merken (für weiche Grafik zwischen zwei Ticks)
  ch.prevPosition.copy(ch.position);
  ch.prevYaw = ch.yaw;
  ch.prevPitch = ch.pitch;
  ch.prevStepOffset = ch.stepOffset;
  // Stufen-Glättung klingt ab
  if (ch.stepOffset !== 0) {
    ch.stepOffset *= Math.exp(-P.stepSmoothing * dt);
    if (Math.abs(ch.stepOffset) < 0.002) ch.stepOffset = 0;
  }

  if (!ch.alive) {
    ch.velocity.set(0, 0, 0);
    return;
  }
  ch.yaw = command.yaw;
  ch.pitch = command.pitch;

  const handler = moveStateHandlers[ch.moveState];
  if (handler) {
    handler(ch, command, dt, world);
    checkKillPlane(ch);
    return;
  }

  const wasGrounded = ch.grounded;

  // --- Ducken -------------------------------------------------------------------
  if (command.crouch && !ch.crouching) {
    ch.crouching = true;
    ch.height = HITBOX.crouchHeight;
  } else if (!command.crouch && ch.crouching) {
    // Aufstehen nur, wenn über dem Kopf Platz ist
    if (bodyFits(world, ch.position.x, ch.position.y, ch.position.z, ch.radius, HITBOX.height)) {
      ch.crouching = false;
      ch.height = HITBOX.height;
    }
  }

  // --- Tempo und Richtung ---------------------------------------------------------
  let mx = command.moveX || 0;
  let mz = command.moveZ || 0;
  const inputLen = Math.hypot(mx, mz);
  if (inputLen > 1) {
    mx /= inputLen;
    mz /= inputLen;
  }
  ch.sprinting = !!command.sprint && !ch.crouching && !ch.aiming && mz > 0.1;
  let speed = ch.crouching ? P.crouchSpeed : ch.sprinting ? P.sprintSpeed : P.walkSpeed;
  if (ch.aiming) speed *= CONFIG.weapons.aimMoveFactor;
  speed *= ch.speedFactor;

  const sin = Math.sin(ch.yaw);
  const cos = Math.cos(ch.yaw);
  // vorwärts = (−sin, 0, −cos), rechts = (cos, 0, −sin)  (siehe ARCHITECTURE.md)
  const wishX = (cos * mx - sin * mz) * speed;
  const wishZ = (-sin * mx - cos * mz) * speed;
  if (ch.grounded || inputLen > 0.01) {
    const accel = ch.grounded ? P.groundAcceleration : P.groundAcceleration * P.airControl;
    let ddx = wishX - ch.velocity.x;
    let ddz = wishZ - ch.velocity.z;
    const dl = Math.hypot(ddx, ddz);
    const maxDv = accel * dt;
    if (dl > maxDv) {
      ddx *= maxDv / dl;
      ddz *= maxDv / dl;
    }
    ch.velocity.x += ddx;
    ch.velocity.z += ddz;
  }

  // --- Springen -----------------------------------------------------------------
  ch.jumpBuffer = command.jumpPressed ? P.jumpBufferTime : Math.max(0, ch.jumpBuffer - dt);
  ch.coyoteTimer = ch.grounded ? P.coyoteTime : Math.max(0, ch.coyoteTimer - dt);
  let jumped = false;
  if ((command.jump || ch.jumpBuffer > 0) && (ch.grounded || ch.coyoteTimer > 0) && ch.velocity.y <= 0.01) {
    if (ch.grounded) ch.airPeakY = ch.position.y;
    ch.velocity.y = P.jumpVelocity;
    ch.grounded = false;
    ch.moveState = 'air';
    ch.coyoteTimer = 0;
    ch.jumpBuffer = 0;
    jumped = true;
    ch.game?.events?.emit('jump', ch._jumpEvent);
  }

  // --- Schwerkraft ----------------------------------------------------------------
  const g = CONFIG.world.gravity;
  let dy = 0;
  if (!ch.grounded) {
    // genaue Wurf-Formel → Sprunghöhe stimmt auch bei 60 Schritten pro Sekunde
    dy = ch.velocity.y * dt - 0.5 * g * dt * dt;
    ch.velocity.y -= g * dt;
    if (ch.velocity.y < -P.maxFallSpeed) ch.velocity.y = -P.maxFallSpeed;
  } else {
    ch.velocity.y = 0;
  }

  // --- Bewegen (in Teilschritten) -------------------------------------------------
  const dx = ch.velocity.x * dt;
  const dz = ch.velocity.z * dt;
  const longest = Math.max(Math.abs(dx), Math.abs(dz), Math.abs(dy));
  const steps = Math.min(P.maxSubsteps, Math.max(1, Math.ceil(longest / P.maxSubstepDistance)));
  const sx = dx / steps;
  const sz = dz / steps;
  let sy = dy / steps;
  let blockedX = sx === 0;
  let blockedZ = sz === 0;
  const startX = ch.position.x;
  const startZ = ch.position.z;
  let landed = false;
  for (let i = 0; i < steps; i++) {
    if (!blockedX && moveAxis(ch, world, 0, sx) === BLOCKED) blockedX = true;
    if (!blockedZ && moveAxis(ch, world, 2, sz) === BLOCKED) blockedZ = true;
    if (sy !== 0) {
      const result = moveVertical(ch, world, sy);
      if (result === LANDED) {
        landed = true;
        sy = 0;
      } else if (result === CEILING) {
        sy = 0;
        if (ch.velocity.y > 0) ch.velocity.y = 0;
      }
    }
    if (!ch.grounded && ch.position.y > ch.airPeakY) ch.airPeakY = ch.position.y;
    if (blockedX && blockedZ && sy === 0) break;
  }

  // --- Boden ------------------------------------------------------------------------
  if (landed) {
    landCharacter(ch);
  } else if (wasGrounded && !jumped) {
    // Am Boden bleiben (Rampe bergab, kleine Stufe hinunter)
    const y = ch.position.y;
    const support = findSupport(world, ch.position.x, y, ch.position.z, ch.radius, y - P.groundSnapDistance);
    if (support > -Infinity) {
      if (y - support > 0.15) addStepOffset(ch, y - support);
      ch.position.y = support;
      ch.grounded = true;
      ch.moveState = 'ground';
    } else {
      ch.grounded = false;
      ch.moveState = 'air';
      ch.airPeakY = y;
      ch.coyoteTimer = P.coyoteTime;
    }
  }

  // --- Schritte (für Geräusche) -----------------------------------------------------
  if (ch.grounded) {
    ch.stepDistance += Math.hypot(ch.position.x - startX, ch.position.z - startZ);
    if (ch.stepDistance >= P.footstepDistance) {
      ch.stepDistance %= P.footstepDistance;
      ch.game?.events?.emit('footstep', ch._footstepEvent);
    }
  }

  // Tanz endet, sobald man sich bewegt, springt oder schießt
  if (ch.emoteUntil > 0 && (inputLen > 0.05 || jumped || command.primaryPressed)) ch.emoteUntil = 0;

  checkKillPlane(ch);
}

// Unterhalb der Welt = raus
function checkKillPlane(ch) {
  if (ch.alive && ch.position.y < CONFIG.world.killPlaneY) {
    ch.applyDamage(ch.health + ch.shield + 1, { kind: 'fall', weaponId: 'fall', bypassShield: true, ignoreInvulnerable: true });
  }
}
