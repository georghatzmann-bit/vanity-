// =============================================================================
// Game: das laufende Spiel (Welt, Figuren, Systeme)
// =============================================================================
// Ein Game hält alles, was zu EINEM Spiel gehört: Kollisions-Welt, Figuren,
// Bau-System, Waffen, Effekte, Ton, HUD und den Modus (z. B. Übungsplatz).
//
// fixedUpdate(dt) – ein Logik-Schritt (1/60 s). Reihenfolge (ARCHITECTURE.md §5):
//   1. mode.preUpdate
//   2. Befehle holen (Spieler: Eingabe + Kamera, Bots: Gehirn)
//   3. Auswahl anwenden (Waffe, Bauteil, Spitzhacke, Edit)
//   4. Bewegung
//   5. Bauen und Waffen pro Figur
//   6. Geschosse, Bauteile (Aufbau/Einsturz), Sturm, Loot
//   7. mode.update, dann alle systems
//   8. Zeit weiterzählen
// frameUpdate(frameSeconds, alpha) – ein Bild: Figuren weich zwischen zwei
//   Logik-Schritten, Kamera, Effekte, HUD.
//
// Ohne Bildschirm (headless: true) läuft alles genauso, nur ohne Grafik,
// Ton und HUD – so können Tests ganze Spiele in Sekundenbruchteilen simulieren.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { EventBus } from './events.js';
import { defaultSettings } from './settings.js';
import { createRng } from '../util/random.js';
import { CollisionWorld } from '../physics.js';
import { Character, moveCharacter, resetCommand } from '../player.js';
import { createPlayerController } from '../playerController.js';
import { ThirdPersonCamera } from '../camera.js';
import { createCharacterView } from '../world/characterModel.js';
import { disposeObject } from '../world/mapBuilder.js';
import { createBuildingSystem } from '../building/structure.js';
import { createWeaponSystem } from '../weapons/weapons.js';
import { createProjectileSystem } from '../weapons/projectiles.js';
import { createEffects } from '../world/effects.js';
import { createAudio } from '../audio/sfx.js';
import { createHud } from '../ui/hud.js';
import { createBotBrain } from '../ai/bot.js';
import { getModeDef } from '../modes/index.js';

export class Game {
  /**
   * @param {object} options
   * @param {THREE.Scene} [options.scene]      wird auch headless gebraucht (nie gemalt)
   * @param {THREE.PerspectiveCamera} [options.camera]  null = ohne Bild
   * @param {object} [options.settings]        aus core/settings.js
   * @param {boolean} [options.headless]       true = keine Grafik/Ton/HUD
   * @param {number} [options.seed]            Startwert für den Zufall
   * @param {Input} [options.input]            Eingabe für die Spieler-Figur
   * @param {THREE.WebGLRenderer} [options.renderer]  nur für Textur-Schärfe
   * @param {HTMLElement} [options.uiRoot]     Ebene für das HUD
   */
  constructor(options = {}) {
    this.config = CONFIG;
    this.settings = options.settings ?? defaultSettings();
    this.headless = !!options.headless;
    this.seed = options.seed ?? 1;
    this.rng = createRng(this.seed);
    this.events = new EventBus();

    this.scene = options.scene ?? new THREE.Scene();
    this.camera = options.camera ?? null;
    this.renderer = options.renderer ?? null;
    this.input = options.input ?? null;
    // HTML-Ebene über dem 3D-Bild (Schadenszahlen, HUD); headless: keine
    this.uiRoot = this.headless ? null : options.uiRoot ?? null;
    // Battle Royale: Seltenheit der Waffe gibt einen kleinen Schadens-Bonus (der Modus schaltet das ein)
    this.useRarity = false;
    // Alles, was dieses Spiel in die Szene legt, hängt unter root (leicht aufzuräumen)
    this.root = new THREE.Group();
    this.root.name = 'Spiel';
    this.scene.add(this.root);

    this.world = new CollisionWorld(CONFIG);
    this.time = 0;
    this.tick = 0;
    this.characters = [];
    this.player = null;
    this.mode = null;
    this.map = null;
    this.storm = null;
    this.loot = null;
    this.systems = [];
    this.disposed = false;

    this.cameraRig = new ThirdPersonCamera(this.camera, CONFIG);
    this.playerController = createPlayerController();
    this.lastSample = null; // letzter Eingabe-Zustand (für Tests/Anzeigen)

    this.building = createBuildingSystem(this);
    this.weapons = createWeaponSystem(this);
    this.projectiles = createProjectileSystem(this);
    this.effects = createEffects(this);
    this.audio = createAudio(this);
    this.hud = createHud(this, this.uiRoot);

    // Besiegt → dem Modus Bescheid sagen
    this._offKilled = this.events.on('characterKilled', ({ victim, killer }) => {
      this.mode?.onCharacterKilled?.(victim, killer);
    });
  }

  // ---------------------------------------------------------------------------
  // Modus
  // ---------------------------------------------------------------------------

  /**
   * Startet einen Modus (räumt den alten vorher auf).
   * @param {string} id       z. B. 'practice'
   * @param {object} [options] { botDifficulty, teamSize, totalPlayers, roundsToWin, seed }
   */
  startMode(id, options = {}) {
    const def = getModeDef(id);
    if (!def) throw new Error(`Den Spielmodus "${id}" gibt es nicht.`);
    this.endMode();
    this.mode = def.create(this, options);
    this.mode.start();
    this.cameraRig.snap();
    return this.mode;
  }

  /** Beendet den aktuellen Modus (Figuren, Karte, Bauteile weg). */
  endMode() {
    for (const c of [...this.characters]) this.removeCharacter(c);
    this.building.clearAll();
    this.projectiles.clear();
    this.mode?.dispose?.();
    this.mode = null;
    this.storm?.dispose?.();
    this.storm = null;
    this.loot?.dispose?.();
    this.loot = null;
    if (this.map) {
      this.map.dispose?.();
      this.map = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Figuren
  // ---------------------------------------------------------------------------

  /**
   * Neue Figur. options wie bei Character, dazu:
   *   brain: Bot-Gehirn | null (null = steht nur da), difficulty: 'easy'|'medium'|'hard'
   * @returns {Character}
   */
  addCharacter(options = {}) {
    const character = new Character(this, options);
    if (character.isPlayer) {
      this.player = character;
      this.playerController.reset();
    } else if (options.brain !== undefined) {
      character.brain = options.brain;
    } else if (character.isBot) {
      character.brain = createBotBrain(character, this, options.difficulty ?? this.settings.game?.botDifficulty);
    }
    if (!this.headless) character.view = createCharacterView(character, this.root);
    this.characters.push(character);
    return character;
  }

  /** Figur entfernen (Grafik wird entsorgt). */
  removeCharacter(character) {
    const index = this.characters.indexOf(character);
    if (index < 0) return;
    this.characters.splice(index, 1);
    character.view?.dispose();
    character.view = null;
    if (this.player === character) this.player = null;
  }

  // ---------------------------------------------------------------------------
  // Logik-Schritt
  // ---------------------------------------------------------------------------

  /**
   * Ein Logik-Schritt.
   * @param {number} dt  Länge in Sekunden (1/60)
   * @param {object} [sample]  Eingabe-Zustand; ohne Angabe wird game.input abgefragt
   */
  fixedUpdate(dt, sample = null) {
    if (this.disposed) return;
    const mode = this.mode;
    const player = this.player;
    // Controller: Im Baumodus haben die Schultertasten eine andere Aufgabe
    if (this.input && player) this.input.gamepadBuildMode = player.mode === 'build' || player.mode === 'edit';
    if (!sample && this.input) sample = this.input.sample(dt);
    this.lastSample = sample;

    // 1. Modus vorher
    mode?.preUpdate?.(dt);

    const list = this.characters;
    // 2. Befehle
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.isPlayer && sample) {
        this.playerController.buildCommand(sample, c, this.cameraRig, this.settings, this);
      } else if (c.brain && c.alive) {
        c.command = c.brain.think(dt) ?? c.command;
      } else {
        resetCommand(c.command, c.yaw, c.pitch);
      }
    }
    // 3. Auswahl
    for (let i = 0; i < list.length; i++) list[i].applySelection(list[i].command);
    // 4. Bewegung
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      moveCharacter(c, c.command, dt, this.world);
      if (c === this.player) {
        // Kamera-Zustand (Duck-Höhe, Schulter) einmal pro Tick – Bild und Ziel-Strahl teilen ihn
        this.cameraRig.fixedUpdate(c, dt, this.world);
        // Ziel-Strahl des Spielers nach der Bewegung neu (passt dann genau zur neuen Lage)
        if (c.alive && sample) this.cameraRig.computeAimRay(c, this.world, c.command.aimOrigin, c.command.aimDir);
      }
    }
    // 5. Bauen und Waffen
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      this.building.updateCharacter(c, c.command, dt);
      this.weapons.updateCharacter(c, c.command, dt);
    }
    // 6. Systeme
    this.projectiles.update(dt);
    this.building.update(dt);
    this.storm?.update(dt);
    this.loot?.update(dt);
    // 7. Modus und weitere Systeme
    mode?.update?.(dt);
    for (let i = 0; i < this.systems.length; i++) this.systems[i].update(dt, this);
    // 8. Zeit
    this.time += dt;
    this.tick++;
  }

  /**
   * Simuliert Sekunden ohne Bild (für Tests). Benutzt game.input, falls vorhanden.
   * @returns {Game}
   */
  simulate(seconds) {
    const step = 1 / CONFIG.loop.tickRate;
    const steps = Math.round(seconds / step);
    for (let i = 0; i < steps; i++) this.fixedUpdate(step);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Bild
  // ---------------------------------------------------------------------------

  /**
   * Ein Bild vorbereiten (vor renderer.render).
   * @param {number} frameSeconds  Zeit seit dem letzten Bild
   * @param {number} alpha         0..1 zwischen zwei Logik-Schritten
   */
  frameUpdate(frameSeconds, alpha) {
    if (this.disposed) return;
    const player = this.player;
    if (player && this.camera) {
      this.cameraRig.update(player, alpha, frameSeconds, this.world, this.input, this.settings);
    }
    for (let i = 0; i < this.characters.length; i++) {
      const c = this.characters[i];
      if (!c.view) continue;
      if (c === player && this.camera) {
        // eigene Figur: dreht sich genau mit der Kamera; zu nah oder Zielfernrohr → ausblenden
        c.view.setHidden(this.cameraRig.hideCharacter || !!c.scopeFov);
        c.view.update(alpha, frameSeconds, c.alive ? this.cameraRig.yaw : undefined);
      } else {
        c.view.update(alpha, frameSeconds);
      }
    }
    this.building.frameUpdate(alpha);
    this.weapons.frameUpdate(alpha);
    this.effects.frameUpdate(frameSeconds);
    this.audio.frameUpdate();
    this.hud.frameUpdate(frameSeconds);
    this.map?.frameUpdate?.(frameSeconds);
  }

  // ---------------------------------------------------------------------------
  // Aufräumen
  // ---------------------------------------------------------------------------

  /** Alles aufräumen (Szene leeren, Ereignisse abmelden). */
  dispose() {
    if (this.disposed) return;
    this.endMode();
    for (const system of this.systems) system.dispose?.();
    this.systems.length = 0;
    this.hud.dispose?.();
    this.audio.dispose?.();
    this.effects.dispose?.();
    this.weapons.dispose?.();
    this.projectiles.dispose?.();
    this.building.dispose?.();
    this._offKilled();
    this.events.clear();
    this.world.clear();
    disposeObject(this.root);
    this.scene.remove(this.root);
    this.disposed = true;
  }
}
