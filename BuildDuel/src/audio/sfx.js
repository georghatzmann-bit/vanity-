// =============================================================================
// Ton: alle Geräusche werden mit der Web Audio API erzeugt (keine Dateien)
// =============================================================================
// createAudio(game) hört auf die Ereignisse des Spiels (game.events) und spielt Töne:
//   Schritte (Gras/Holz/Stein/Metall), Springen/Landen, Bauteil setzen (Holz "Klock",
//   Stein dumpf, Metall "Kling"), Bauteil zerstört, alle Waffen, Nachladen, Treffer-"Ping"
//   (Kopfschuss höher), Schild bricht, Spitzhacke, Heilen, Türen, Sturm-Brummen,
//   Sieg-Fanfare (3 Töne), Niederlage, Knöpfe im Menü (audio.ui('click')), Menü-Musik.
//
// - Raumklang: Töne anderer Figuren kommen aus ihrer Richtung und werden mit der
//   Entfernung leiser (PannerNode, HRTF). Der "Zuhörer" sitzt an der Kamera.
//   Eigene Töne (Schüsse, Schritte …) spielen ohne Richtung.
// - Lautstärke-Gruppen: Gesamt → Effekte / Musik (settings.audio, setVolumes()).
// - Browser erlauben Ton erst nach einem Klick oder einer Taste: Der Ton startet beim
//   ersten Klick/Tastendruck von selbst. Vorher werden Töne einfach weggelassen (kein Fehler).
// - Begrenzung (VoiceLimiter): höchstens CONFIG.audio.maxVoices Töne gleichzeitig und je
//   Ton-Art höchstens voicesPerType – 20 schießende Bots bringen den Rechner nicht ins Schwitzen.
//   Neue, wichtigere Töne (eigene, nahe) ersetzen ältere, leisere.
// - Ohne Bildschirm (headless, Tests): eine Attrappe, die nichts tut.
// Werte: CONFIG.audio.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRayHit } from '../physics.js';

const A = CONFIG.audio;

// =============================================================================
// Begrenzung gleichzeitiger Töne (reine Logik, ohne Web Audio testbar)
// =============================================================================

/**
 * Feste Anzahl "Stimmen". acquire() sagt, ob ein neuer Ton spielen darf, und in welchem Platz.
 * Ist alles voll, ersetzt ein Ton mit gleicher oder höherer Wichtigkeit (priority) den
 * schwächsten (niedrigste Wichtigkeit, bei Gleichstand der älteste) – sonst wird er weggelassen.
 */
export class VoiceLimiter {
  constructor(maxVoices = A.maxVoices, perType = A.voicesPerType, defaultPerType = A.defaultVoicesPerType) {
    this.max = Math.max(1, maxVoices | 0);
    this.perType = perType ?? {};
    this.defaultPerType = defaultPerType;
    this.voices = [];
    for (let i = 0; i < this.max; i++) this.voices.push({ type: null, priority: 0, start: 0, end: 0, handle: null });
    this.stolen = null; // handle des ersetzten Tons (nach acquire), sonst null
  }

  /** Höchstzahl gleichzeitiger Töne einer Art. */
  capFor(type) {
    const cap = this.perType[type];
    return Number.isFinite(cap) ? cap : this.defaultPerType;
  }

  /** Wie viele Töne spielen zur Zeit now? (optional nur einer Art) */
  count(now, type = null) {
    let n = 0;
    for (const v of this.voices) {
      if (v.type !== null && v.end > now && (type === null || v.type === type)) n++;
    }
    return n;
  }

  /**
   * Platz für einen neuen Ton? → Platz-Nummer oder −1 (weglassen).
   * Wird dabei ein noch laufender Ton ersetzt, steht sein handle danach in this.stolen.
   */
  acquire(type, priority, now, duration, handle = null) {
    this.stolen = null;
    const cap = this.capFor(type);
    if (cap <= 0) return -1;
    let free = -1;
    let typeCount = 0;
    let weakestType = -1;
    let weakestAll = -1;
    const voices = this.voices;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.type === null || v.end <= now) {
        if (free < 0) free = i;
        continue;
      }
      if (v.type === type) {
        typeCount++;
        if (weakestType < 0 || weaker(v, voices[weakestType])) weakestType = i;
      }
      if (weakestAll < 0 || weaker(v, voices[weakestAll])) weakestAll = i;
    }
    let slot;
    if (typeCount >= cap) {
      if (weakestType < 0 || voices[weakestType].priority > priority) return -1;
      slot = weakestType;
    } else if (free >= 0) {
      slot = free;
    } else if (weakestAll >= 0 && voices[weakestAll].priority <= priority) {
      slot = weakestAll;
    } else {
      return -1;
    }
    const v = voices[slot];
    if (v.type !== null && v.end > now) this.stolen = v.handle;
    v.type = type;
    v.priority = priority;
    v.start = now;
    v.end = now + Math.max(0.01, duration);
    v.handle = handle;
    return slot;
  }

  /** handle eines Platzes nachtragen (z. B. die Ton-Knoten, die erst danach entstehen). */
  setHandle(slot, handle) {
    if (slot >= 0 && slot < this.voices.length) this.voices[slot].handle = handle;
  }

  /** Alles vergessen. */
  clear() {
    for (const v of this.voices) {
      v.type = null;
      v.handle = null;
      v.end = 0;
    }
    this.stolen = null;
  }
}

function weaker(a, b) {
  return a.priority < b.priority || (a.priority === b.priority && a.start < b.start);
}

/** Wichtigkeit eines Tons: eigene Töne am wichtigsten, dann nahe, dann ferne. */
export function soundPriority(own, distance) {
  if (own) return 3;
  return distance < 25 ? 2 : 1;
}

// =============================================================================
// Ton-Rezepte: jede Funktion baut einen Ton aus Oszillatoren und Rauschen in "out"
// und gibt seine Länge (s) zurück. h = Helfer (siehe createEngine), v = Zufall 0..1.
// =============================================================================
const SOUNDS = {
  // --- Bewegung ---
  footstep_grass(h, out, t, v) {
    h.noise(out, t, 0.09, 'lowpass', 380 + v * 120, 0.7, 0.42);
    h.tone(out, 'sine', 75 + v * 15, t, 0.07, 0.3, 50);
    return 0.12;
  },
  footstep_wood(h, out, t, v) {
    h.noise(out, t, 0.07, 'bandpass', 850 + v * 200, 2, 0.5);
    h.tone(out, 'triangle', 210 + v * 30, t, 0.07, 0.22, 170);
    return 0.1;
  },
  footstep_stone(h, out, t, v) {
    h.noise(out, t, 0.06, 'bandpass', 1300 + v * 300, 1.4, 0.45);
    h.tone(out, 'sine', 140, t, 0.05, 0.18, 110);
    return 0.09;
  },
  footstep_metal(h, out, t, v) {
    h.noise(out, t, 0.05, 'bandpass', 2400 + v * 400, 3, 0.4);
    h.tone(out, 'sine', 1250 + v * 120, t, 0.14, 0.07);
    h.tone(out, 'sine', 1870 + v * 150, t, 0.1, 0.04);
    return 0.16;
  },
  jump(h, out, t) {
    h.noise(out, t, 0.12, 'bandpass', 700, 1.2, 0.18, 0.005, 1500);
    h.tone(out, 'sine', 170, t, 0.09, 0.14, 260);
    return 0.14;
  },
  land(h, out, t, v, k = 0.5) {
    h.tone(out, 'sine', 95, t, 0.14, 0.35 + 0.45 * k, 45);
    h.noise(out, t, 0.12 + 0.1 * k, 'lowpass', 520, 0.8, 0.25 + 0.35 * k);
    return 0.26;
  },
  // --- Bauen ---
  place_wood(h, out, t, v) {
    h.tone(out, 'triangle', 820 + v * 60, t, 0.08, 0.55);
    h.tone(out, 'sine', 1240 + v * 80, t, 0.05, 0.25);
    h.noise(out, t, 0.02, 'highpass', 2200, 0.7, 0.35);
    return 0.12;
  },
  place_stone(h, out, t, v) {
    h.tone(out, 'sine', 330 + v * 30, t, 0.13, 0.55, 250);
    h.noise(out, t, 0.1, 'bandpass', 620, 1.1, 0.4);
    return 0.16;
  },
  place_metal(h, out, t, v) {
    const f = 1150 + v * 90;
    h.tone(out, 'sine', f, t, 0.55, 0.22);
    h.tone(out, 'sine', f * 1.51, t, 0.38, 0.14);
    h.tone(out, 'sine', f * 2.27, t, 0.26, 0.09);
    h.noise(out, t, 0.02, 'highpass', 3000, 0.7, 0.3);
    return 0.6;
  },
  destroy(h, out, t, v, k = 0, material = 'wood') {
    const crack = material === 'stone' ? 1300 : material === 'metal' ? 2600 : 1900;
    h.noise(out, t, 0.05, 'bandpass', crack + v * 300, 0.9, 0.7);
    h.noise(out, t + 0.02, 0.45, 'lowpass', material === 'stone' ? 650 : 950, 0.6, 0.38, 0.02);
    h.tone(out, 'sine', 120, t, 0.22, 0.4, 55);
    if (material === 'metal') h.tone(out, 'sine', 980 + v * 80, t, 0.4, 0.12);
    return 0.5;
  },
  // --- Waffen ---
  shotgun(h, out, t, v) {
    h.noise(out, t, 0.32, 'lowpass', 3400, 0.6, 0.95, 0.002);
    h.noise(out, t, 0.5, 'lowpass', 520, 0.7, 0.55, 0.002);
    h.tone(out, 'sine', 115 + v * 10, t, 0.26, 0.85, 42);
    h.send(out, 0.18);
    return 0.55;
  },
  ar(h, out, t, v) {
    h.noise(out, t, 0.085, 'bandpass', 2300 + v * 300, 0.7, 0.7, 0.001);
    h.tone(out, 'sawtooth', 190 + v * 20, t, 0.05, 0.16, 90);
    h.tone(out, 'sine', 95, t, 0.07, 0.35, 60);
    return 0.11;
  },
  smg(h, out, t, v) {
    h.noise(out, t, 0.06, 'bandpass', 3100 + v * 300, 0.8, 0.5, 0.001);
    h.tone(out, 'sawtooth', 260 + v * 30, t, 0.04, 0.12, 140);
    return 0.08;
  },
  pistol(h, out, t, v) {
    h.noise(out, t, 0.1, 'bandpass', 1900 + v * 200, 0.8, 0.6, 0.001);
    h.tone(out, 'sine', 165, t, 0.08, 0.4, 80);
    return 0.12;
  },
  sniper(h, out, t) {
    h.noise(out, t, 0.05, 'highpass', 1500, 0.7, 1.0, 0.001);
    h.noise(out, t + 0.01, 0.9, 'lowpass', 1700, 0.5, 0.42, 0.01);
    h.tone(out, 'sine', 82, t, 0.35, 0.75, 34);
    h.send(out, 0.55);
    return 1.0;
  },
  grenadeLauncher(h, out, t) {
    h.tone(out, 'sine', 150, t, 0.18, 0.7, 58);
    h.noise(out, t, 0.15, 'lowpass', 520, 0.7, 0.4, 0.003);
    return 0.2;
  },
  explosion(h, out, t, v) {
    h.noise(out, t, 0.08, 'bandpass', 2400, 0.8, 0.6, 0.001);
    h.noise(out, t, 1.3, 'lowpass', 1300, 0.6, 1.0, 0.004, 180);
    h.tone(out, 'sine', 95 + v * 10, t, 0.9, 1.0, 26);
    h.send(out, 0.6);
    return 1.35;
  },
  reload_start(h, out, t) {
    h.noise(out, t, 0.03, 'bandpass', 3200, 5, 0.55);
    h.noise(out, t + 0.12, 0.04, 'bandpass', 2100, 4, 0.5);
    return 0.18;
  },
  reload_end(h, out, t) {
    h.noise(out, t, 0.05, 'bandpass', 1700, 3, 0.6);
    h.tone(out, 'square', 900, t, 0.025, 0.08);
    h.noise(out, t + 0.07, 0.03, 'bandpass', 2600, 4, 0.4);
    return 0.12;
  },
  switch(h, out, t) {
    h.noise(out, t, 0.03, 'bandpass', 2500, 3, 0.25);
    h.noise(out, t + 0.06, 0.03, 'bandpass', 1500, 3, 0.2);
    return 0.1;
  },
  // --- Treffer ---
  hit(h, out, t) {
    h.tone(out, 'sine', 1250, t, 0.12, 0.38, 0, 0.003);
    h.tone(out, 'sine', 2500, t, 0.06, 0.08, 0, 0.003);
    return 0.13;
  },
  hit_head(h, out, t) {
    h.tone(out, 'sine', 1880, t, 0.14, 0.4, 0, 0.003);
    h.tone(out, 'sine', 3760, t, 0.07, 0.1, 0, 0.003);
    return 0.15;
  },
  hit_kill(h, out, t) {
    h.tone(out, 'sine', 1250, t, 0.1, 0.38, 0, 0.003);
    h.tone(out, 'sine', 1870, t + 0.075, 0.2, 0.42, 0, 0.003);
    h.tone(out, 'triangle', 2500, t + 0.075, 0.12, 0.08, 0, 0.003);
    return 0.3;
  },
  shield_break(h, out, t, v) {
    const notes = [2637, 3520, 4186, 3136];
    for (let i = 0; i < notes.length; i++) h.tone(out, 'sine', notes[i] * (1 + (v - 0.5) * 0.04), t + i * 0.018, 0.25 + i * 0.05, 0.12);
    h.noise(out, t, 0.14, 'highpass', 4200, 0.7, 0.35);
    return 0.45;
  },
  // --- Spitzhacke ---
  pickaxe_swing(h, out, t) {
    h.noise(out, t, 0.16, 'bandpass', 450, 1.3, 0.28, 0.03, 1700);
    return 0.18;
  },
  pickaxe_hit(h, out, t) {
    h.tone(out, 'sine', 165, t, 0.09, 0.45, 90);
    h.noise(out, t, 0.05, 'bandpass', 1050, 1.2, 0.35);
    return 0.11;
  },
  harvest_wood(h, out, t, v) {
    h.tone(out, 'triangle', 610 + v * 50, t, 0.07, 0.35);
    h.noise(out, t, 0.06, 'bandpass', 1200, 1.5, 0.35);
    return 0.09;
  },
  harvest_stone(h, out, t, v) {
    h.noise(out, t, 0.05, 'bandpass', 2500 + v * 300, 1.5, 0.45);
    h.tone(out, 'sine', 480, t, 0.06, 0.25, 380);
    return 0.08;
  },
  harvest_metal(h, out, t, v) {
    h.tone(out, 'sine', 1480 + v * 80, t, 0.28, 0.2);
    h.tone(out, 'sine', 2230 + v * 100, t, 0.2, 0.12);
    h.noise(out, t, 0.03, 'highpass', 3000, 0.7, 0.25);
    return 0.3;
  },
  // --- Heilen ---
  heal_start(h, out, t) {
    h.tone(out, 'sine', 440, t, 0.26, 0.12, 660, 0.04);
    h.noise(out, t, 0.22, 'bandpass', 3200, 1, 0.07, 0.05);
    return 0.3;
  },
  heal_done_health(h, out, t) {
    h.tone(out, 'sine', 660, t, 0.22, 0.16, 0, 0.01);
    h.tone(out, 'sine', 880, t + 0.08, 0.3, 0.16, 0, 0.01);
    return 0.4;
  },
  heal_done_shield(h, out, t) {
    h.tone(out, 'triangle', 880, t, 0.2, 0.12, 0, 0.01);
    h.tone(out, 'sine', 1320, t + 0.07, 0.3, 0.14, 0, 0.01);
    h.tone(out, 'sine', 1760, t + 0.14, 0.25, 0.06, 0, 0.01);
    return 0.42;
  },
  // --- Türen, Loot ---
  door(h, out, t) {
    h.tone(out, 'triangle', 210, t, 0.12, 0.3, 140);
    h.noise(out, t, 0.1, 'lowpass', 700, 0.8, 0.3);
    return 0.15;
  },
  pickup(h, out, t) {
    h.tone(out, 'sine', 700, t, 0.08, 0.2, 1050, 0.005);
    h.tone(out, 'sine', 1400, t + 0.05, 0.1, 0.1, 0, 0.005);
    return 0.16;
  },
  chest(h, out, t) {
    const notes = [784, 988, 1175, 1568];
    for (let i = 0; i < notes.length; i++) h.tone(out, 'sine', notes[i], t + i * 0.06, 0.35, 0.12, 0, 0.005);
    return 0.6;
  },
  // --- Spiel-Ende, Runden ---
  fanfare(h, out, t) {
    // drei Töne nach oben, der letzte lang
    const notes = [523.25, 659.25, 783.99];
    const lens = [0.16, 0.16, 0.75];
    let at = t;
    for (let i = 0; i < 3; i++) {
      h.tone(out, 'triangle', notes[i], at, lens[i] + 0.08, 0.32, 0, 0.012);
      h.tone(out, 'square', notes[i], at, lens[i] + 0.04, 0.05, 0, 0.012);
      h.tone(out, 'sine', notes[i] * 2, at, lens[i], 0.06, 0, 0.012);
      at += i < 2 ? 0.17 : 0;
    }
    h.send(out, 0.25);
    return 1.2;
  },
  defeat(h, out, t) {
    const notes = [392, 311.13, 261.63];
    const lens = [0.26, 0.26, 0.9];
    let at = t;
    for (let i = 0; i < 3; i++) {
      h.tone(out, 'triangle', notes[i], at, lens[i] + 0.1, 0.3, i === 2 ? notes[i] * 0.97 : 0, 0.015);
      at += 0.28;
    }
    h.send(out, 0.2);
    return 1.6;
  },
  round(h, out, t) {
    h.tone(out, 'sine', 660, t, 0.18, 0.22, 0, 0.005);
    h.tone(out, 'sine', 990, t + 0.12, 0.3, 0.22, 0, 0.005);
    return 0.45;
  },
  // --- Menü ---
  ui_click(h, out, t) {
    h.tone(out, 'sine', 1800, t, 0.035, 0.22, 1400, 0.001);
    h.noise(out, t, 0.012, 'highpass', 5000, 0.7, 0.12);
    return 0.05;
  },
  ui_hover(h, out, t) {
    h.tone(out, 'sine', 1300, t, 0.025, 0.08, 0, 0.002);
    return 0.03;
  },
  ui_back(h, out, t) {
    h.tone(out, 'sine', 900, t, 0.08, 0.18, 600, 0.002);
    return 0.09;
  },
  ui_confirm(h, out, t) {
    h.tone(out, 'sine', 880, t, 0.08, 0.18, 0, 0.002);
    h.tone(out, 'sine', 1320, t + 0.06, 0.12, 0.18, 0, 0.002);
    return 0.2;
  },
};

/** Namen aller Ton-Rezepte (für Tests). */
export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

// Ton-Art (für die Begrenzung) und Grund-Lautstärke je Rezept
const SOUND_INFO = {
  footstep: { type: 'footstep', volume: 0.32 },
  jump: { type: 'move', volume: 0.35 },
  land: { type: 'move', volume: 0.5 },
  place: { type: 'build', volume: 0.55 },
  destroy: { type: 'destroy', volume: 0.7 },
  shotgun: { type: 'shot', volume: 0.85 },
  ar: { type: 'shot', volume: 0.6 },
  smg: { type: 'shot', volume: 0.5 },
  pistol: { type: 'shot', volume: 0.55 },
  sniper: { type: 'shot', volume: 0.9 },
  grenadeLauncher: { type: 'shot', volume: 0.6 },
  explosion: { type: 'explosion', volume: 1.0 },
  reload: { type: 'reload', volume: 0.45 },
  switch: { type: 'reload', volume: 0.35 },
  hit: { type: 'hit', volume: 0.55 },
  shield: { type: 'shield', volume: 0.6 },
  pickaxe: { type: 'pickaxe', volume: 0.5 },
  harvest: { type: 'pickaxe', volume: 0.5 },
  heal: { type: 'heal', volume: 0.5 },
  door: { type: 'door', volume: 0.5 },
  pickup: { type: 'ui', volume: 0.5 },
  chest: { type: 'ui', volume: 0.5 },
  fanfare: { type: 'fanfare', volume: 0.75 },
  defeat: { type: 'fanfare', volume: 0.7 },
  round: { type: 'fanfare', volume: 0.6 },
  ui: { type: 'ui', volume: 0.5 },
};
function infoOf(name) {
  const base = name.startsWith('footstep') ? 'footstep' : name.startsWith('place_') ? 'place'
    : name.startsWith('reload') ? 'reload' : name.startsWith('hit') ? 'hit' : name.startsWith('shield') ? 'shield'
      : name.startsWith('pickaxe') ? 'pickaxe' : name.startsWith('harvest') ? 'harvest' : name.startsWith('heal') ? 'heal'
        : name.startsWith('ui_') ? 'ui' : name;
  return SOUND_INFO[base] ?? { type: 'misc', volume: 0.5 };
}

// =============================================================================
// Ton-Maschine: EIN AudioContext für die ganze Seite (auch über mehrere Spiele hinweg)
// =============================================================================
let engine = null;

/** Die gemeinsame Ton-Maschine (wird beim ersten Aufruf angelegt, der Ton startet erst nach einem Klick). */
export function getAudioEngine() {
  if (!engine) engine = createEngine();
  return engine;
}

function createEngine() {
  const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  let ctx = null;
  let master = null;
  let effects = null;
  let musicBus = null;
  let reverbIn = null;
  let noiseBuffer = null;
  const limiter = new VoiceLimiter();
  const volumes = { master: A.master, effects: A.effects, music: A.music };
  const stats = { played: 0, dropped: 0, culled: 0, maxActive: 0, byName: {} };
  const listenerPos = new THREE.Vector3();
  let musicWanted = null;
  let music = null;
  let hrtf = A.hrtf;

  function canStart() {
    try {
      const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
      return !ua || ua.isActive || ua.hasBeenActive;
    } catch {
      return true;
    }
  }

  function init() {
    if (ctx || !AC) return ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (error) {
      console.warn('Ton: AudioContext konnte nicht starten – das Spiel läuft ohne Ton.', error);
      ctx = null;
      return null;
    }
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    compressor.connect(ctx.destination);
    master = ctx.createGain();
    master.connect(compressor);
    effects = ctx.createGain();
    effects.connect(master);
    musicBus = ctx.createGain();
    musicBus.connect(master);
    // Hall: erzeugte Impulsantwort (abklingendes Rauschen)
    const convolver = ctx.createConvolver();
    convolver.buffer = createImpulse(ctx, A.reverbSeconds);
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.5;
    reverbIn.connect(convolver);
    convolver.connect(effects);
    // Rauschen (einmal erzeugt, von allen Tönen geteilt)
    noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.5), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    applyVolumes();
    return ctx;
  }

  function applyVolumes() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(clamp01(volumes.master), t, 0.02);
    effects.gain.setTargetAtTime(clamp01(volumes.effects), t, 0.02);
    musicBus.gain.setTargetAtTime(clamp01(volumes.music) * A.musicLevel, t, 0.05);
  }

  // Erster Klick / erste Taste: Ton einschalten
  const GESTURES = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];
  function removeGestureListeners() {
    for (const name of GESTURES) window.removeEventListener(name, onGesture, true);
  }
  function onGesture() {
    unlock();
    if (ctx && ctx.state === 'running') removeGestureListeners();
  }
  if (typeof window !== 'undefined' && AC) {
    for (const name of GESTURES) window.addEventListener(name, onGesture, true);
  }
  // Anderer Tab / Fenster minimiert: Ton anhalten (sonst brummt der Sturm im Hintergrund weiter)
  if (typeof document !== 'undefined' && AC) {
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (document.hidden) {
        if (ctx.state === 'running') ctx.suspend().catch(() => {});
      } else if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    });
  }

  function unlock() {
    if (!AC) return false;
    if (!ctx) {
      if (!canStart()) return false;
      init();
    }
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (musicWanted && !music) startMusic(musicWanted);
      }, () => {});
    }
    if (ctx.state === 'running' && musicWanted && !music) startMusic(musicWanted);
    return true;
  }

  // --- Helfer für die Rezepte (h) ----------------------------------------------------
  const h = {
    /**
     * Ton (Oszillator) mit Hüllkurve. endFreq > 0: gleitet dorthin.
     */
    tone(out, type, freq, t, dur, peak, endFreq = 0, attack = 0.002) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (endFreq > 0) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
      const g = ctx.createGain();
      envelope(g.gain, t, attack, peak, dur);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + attack + dur + 0.05);
      return osc;
    },
    /** Gefiltertes Rauschen mit Hüllkurve. sweepTo > 0: Filter gleitet dorthin. */
    noise(out, t, dur, filterType, freq, q, peak, attack = 0.002, sweepTo = 0) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.setValueAtTime(freq, t);
      if (sweepTo > 0) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
      filter.Q.value = q;
      const g = ctx.createGain();
      envelope(g.gain, t, attack, peak, dur);
      src.connect(filter);
      filter.connect(g);
      g.connect(out);
      const offset = Math.random() * Math.max(0, noiseBuffer.duration - dur - 0.1);
      src.start(t, offset);
      src.stop(t + attack + dur + 0.05);
      return src;
    },
    /** Anteil in den Hall schicken. */
    send(out, amount) {
      const g = ctx.createGain();
      g.gain.value = amount;
      out.connect(g);
      g.connect(reverbIn);
    },
  };

  function envelope(param, t, attack, peak, dur) {
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + dur);
  }

  function stopVoice(handle) {
    if (!handle || !ctx) return;
    try {
      const t = ctx.currentTime;
      handle.gain.gain.cancelScheduledValues(t);
      handle.gain.gain.setTargetAtTime(0, t, 0.01);
      setTimeout(() => disconnectVoice(handle), 80);
    } catch {
      // schon weg
    }
  }

  function disconnectVoice(handle) {
    if (handle.done) return;
    handle.done = true;
    try {
      handle.gain.disconnect();
      handle.panner?.disconnect();
    } catch {
      // schon getrennt
    }
  }

  /**
   * Einen Ton spielen.
   * @param {string} name     Rezept (siehe SOUNDS)
   * @param {object|null} position  {x,y,z} = Raumklang, null = ohne Richtung (eigene Töne, Menü)
   * @param {object} [o]      { own, volume, k (Stärke 0..1), material }
   * @returns {boolean} gespielt?
   */
  function play(name, position = null, o = NO_OPTIONS) {
    const recipe = SOUNDS[name];
    if (!recipe || !ctx || ctx.state !== 'running') return false;
    const now = ctx.currentTime;
    let distance = 0;
    if (position) {
      distance = Math.hypot(position.x - listenerPos.x, position.y - listenerPos.y, position.z - listenerPos.z);
      if (distance > A.maxDistance) {
        stats.culled++;
        return false;
      }
    }
    const info = infoOf(name);
    const priority = soundPriority(!!o.own || !position, distance);
    const slot = limiter.acquire(info.type, priority, now, 0.5);
    if (slot < 0) {
      stats.dropped++;
      return false;
    }
    if (limiter.stolen) stopVoice(limiter.stolen);
    const gain = ctx.createGain();
    gain.gain.value = info.volume * (o.volume ?? 1);
    let panner = null;
    if (position) {
      panner = ctx.createPanner();
      panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = A.refDistance;
      panner.maxDistance = A.maxDistance;
      panner.rolloffFactor = A.rolloff;
      if (panner.positionX) {
        panner.positionX.value = position.x;
        panner.positionY.value = position.y;
        panner.positionZ.value = position.z;
      } else {
        panner.setPosition(position.x, position.y, position.z);
      }
      gain.connect(panner);
      panner.connect(effects);
    } else {
      gain.connect(o.music ? musicBus : effects);
    }
    const duration = recipe(h, gain, now + 0.005, Math.random(), o.k ?? 0.5, o.material ?? 'wood');
    const handle = { gain, panner, done: false };
    limiter.voices[slot].end = now + duration + 0.06;
    limiter.setHandle(slot, handle);
    setTimeout(() => disconnectVoice(handle), (duration + 0.3) * 1000);
    stats.played++;
    stats.byName[name] = (stats.byName[name] ?? 0) + 1;
    const active = limiter.count(now);
    if (active > stats.maxActive) stats.maxActive = active;
    return true;
  }

  // --- Sturm-Brummen (Dauerton, nur Lautstärke ändert sich) ----------------------------------
  let hum = null;
  let humLevel = 0;
  function setStormHum(level) {
    if (!ctx || ctx.state !== 'running') return;
    if (!hum) {
      if (level < 0.01) return;
      const g = ctx.createGain();
      g.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 170;
      filter.Q.value = 2;
      const o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 55;
      const o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = 55.8;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.35;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 60;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      o1.connect(filter);
      o2.connect(filter);
      filter.connect(g);
      g.connect(effects);
      o1.start();
      o2.start();
      lfo.start();
      hum = { g, nodes: [o1, o2, lfo] };
    }
    if (Math.abs(level - humLevel) < 0.02) return;
    humLevel = level;
    hum.g.gain.setTargetAtTime(level * 0.45, ctx.currentTime, 0.25);
  }
  function stopStormHum() {
    if (!hum) return;
    const h0 = hum;
    hum = null;
    humLevel = 0;
    try {
      h0.g.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      setTimeout(() => {
        for (const n of h0.nodes) n.stop();
        h0.g.disconnect();
      }, 600);
    } catch {
      // egal
    }
  }

  // --- Menü-Musik: kleine, ruhige Schleife (Akkorde + Arpeggio + Bass) ---------------------------
  function startMusic(name) {
    if (!ctx || music) return;
    music = createMusicLoop(ctx, musicBus, name);
  }

  return {
    get context() {
      return ctx;
    },
    get state() {
      return ctx ? ctx.state : 'gesperrt';
    },
    limiter,
    stats,
    listenerPos,
    unlock,
    play,
    setStormHum,
    stopStormHum,
    setHrtf(on) {
      hrtf = !!on;
    },
    setVolumes(audio) {
      if (!audio) return;
      if (Number.isFinite(audio.master)) volumes.master = audio.master;
      if (Number.isFinite(audio.effects)) volumes.effects = audio.effects;
      if (Number.isFinite(audio.music)) volumes.music = audio.music;
      applyVolumes();
    },
    playMusic(name = 'menu') {
      musicWanted = name;
      if (ctx && ctx.state === 'running') startMusic(name);
    },
    stopMusic() {
      musicWanted = null;
      if (music) {
        music.stop();
        music = null;
      }
    },
    get musicPlaying() {
      return !!music;
    },
    /** Zuhörer an die Kamera setzen. */
    setListener(position, forward, up) {
      listenerPos.copy(position);
      if (!ctx) return;
      const l = ctx.listener;
      if (l.positionX) {
        l.positionX.value = position.x;
        l.positionY.value = position.y;
        l.positionZ.value = position.z;
        l.forwardX.value = forward.x;
        l.forwardY.value = forward.y;
        l.forwardZ.value = forward.z;
        l.upX.value = up.x;
        l.upY.value = up.y;
        l.upZ.value = up.z;
      } else {
        l.setPosition(position.x, position.y, position.z);
        l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    },
  };
}

const NO_OPTIONS = Object.freeze({});

function clamp01(v) {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

// Hall-Impulsantwort: Stereo-Rauschen, das exponentiell leiser wird
function createImpulse(ctx, seconds) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
  }
  return buffer;
}

// Menü-Musik: C – Am – F – G, 92 Schläge pro Minute, leise. Wird vorausgeplant (Zeitplaner alle 100 ms).
function createMusicLoop(ctx, out, name) {
  const local = ctx.createGain();
  local.gain.value = 0;
  local.gain.setTargetAtTime(1, ctx.currentTime, 0.8);
  local.connect(out);
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.33;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.28;
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(local);
  const beat = 60 / 92;
  const chords = [
    [261.63, 329.63, 392.0], // C
    [220.0, 261.63, 329.63], // Am
    [174.61, 220.0, 261.63], // F
    [196.0, 246.94, 293.66], // G
  ];
  const arp = [0, 1, 2, 1, 2, 0, 1, 2];
  let step = 0;
  let next = ctx.currentTime + 0.1;
  function note(type, freq, t, dur, peak, attack, dest) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = 900;
  padFilter.connect(local);
  function schedule(t) {
    const bar = Math.floor(step / 8) % chords.length;
    const chord = chords[bar];
    const inBar = step % 8;
    if (inBar === 0) {
      for (const f of chord) note('triangle', f, t, beat * 4.2, 0.05, 0.4, padFilter);
      note('sine', chord[0] / 2, t, beat * 1.9, 0.12, 0.02, local);
    }
    if (inBar === 4) note('sine', chord[0] / 2, t, beat * 1.9, 0.1, 0.02, local);
    // Arpeggio (Achtel), eine Oktave höher, mit Echo
    const f = chord[arp[inBar]] * 2;
    note('sine', f, t, beat * 0.45, 0.045, 0.005, local);
    note('sine', f, t, beat * 0.45, 0.02, 0.005, delay);
    step++;
  }
  const timer = setInterval(() => {
    while (next < ctx.currentTime + 0.5) {
      schedule(next);
      next += beat / 2;
    }
  }, 100);
  return {
    name,
    stop() {
      clearInterval(timer);
      try {
        local.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
        setTimeout(() => {
          local.disconnect();
          delay.disconnect();
          feedback.disconnect();
        }, 1500);
      } catch {
        // egal
      }
    },
  };
}

// =============================================================================
// Attrappe (ohne Bildschirm / ohne Web Audio)
// =============================================================================
function createSilentAudio(game) {
  return {
    game,
    enabled: false,
    setVolumes() {},
    frameUpdate() {},
    play() {
      return false;
    },
    ui() {},
    playMusic() {},
    stopMusic() {},
    unlock() {
      return false;
    },
    debug: {
      activeVoices: () => 0,
      stats: () => null,
    },
    dispose() {},
  };
}

// =============================================================================
// Ton für ein Spiel: hört auf Ereignisse
// =============================================================================

/**
 * @param {object} game
 */
export function createAudio(game) {
  if (game.headless || typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) {
    return createSilentAudio(game);
  }
  const eng = getAudioEngine();
  eng.setVolumes(game.settings?.audio ?? A);
  const offs = [];
  const on = (name, fn) => offs.push(game.events.on(name, fn));
  const pos = new THREE.Vector3(); // wiederverwendet: Position eines Tons
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const rayHit = createRayHit();
  const opts = { own: false, volume: 1, k: 0.5, material: 'wood' };
  let lastEndSound = -Infinity;
  let disposed = false;

  function isOwn(c) {
    return !!c && c === game.player;
  }
  function options(own, volume = 1, k = 0.5, material = 'wood') {
    opts.own = own;
    opts.volume = volume;
    opts.k = k;
    opts.material = material;
    return opts;
  }
  // Ton an einer Figur: eigene ohne Richtung, andere mit Raumklang (Brusthöhe)
  function atCharacter(name, c, volume = 1, k = 0.5, material = 'wood') {
    if (!c) return false;
    const own = isOwn(c);
    if (own) return eng.play(name, null, options(true, volume, k, material));
    pos.set(c.position.x, c.position.y + 1, c.position.z);
    return eng.play(name, pos, options(false, volume, k, material));
  }
  function atPoint(name, p, own = false, volume = 1, k = 0.5, material = 'wood') {
    if (!p) return false;
    pos.set(p.x, p.y, p.z);
    return eng.play(name, pos, options(own, volume, k, material));
  }
  function atPiece(name, piece, volume = 1, material = piece?.material ?? 'wood') {
    if (!piece || !game.building?.pieceCenter) return false;
    game.building.pieceCenter(piece, pos);
    return eng.play(name, pos, options(isOwn(piece.owner), volume, 0.5, material));
  }

  // Untergrund unter einer Figur: Gras oder Material des Bauteils
  function surfaceOf(c) {
    rayOrigin.set(c.position.x, c.position.y + 0.3, c.position.z);
    const hit = game.world?.raycast(rayOrigin, DOWN, 0.7, null, rayHit);
    const data = hit?.collider?.data;
    if (data?.kind === 'piece') return data.ref?.material ?? 'wood';
    if (data && (data.kind === 'house' || data.kind === 'static')) return 'stone';
    return 'grass';
  }

  function endSound(won) {
    if (game.time - lastEndSound < 3 && lastEndSound > -Infinity) return;
    lastEndSound = game.time;
    eng.play(won ? 'fanfare' : 'defeat', null, options(true));
  }

  // --- Ereignisse ------------------------------------------------------------------------------
  on('shot', (e) => {
    if (!SOUNDS[e.weaponId]) return;
    if (isOwn(e.shooter)) eng.play(e.weaponId, null, options(true));
    else atPoint(e.weaponId, e.origin);
  });
  on('explosion', (e) => atPoint('explosion', e.position, isOwn(e.owner)));
  on('impact', (e) => {
    if (e.weaponId === 'pickaxe' && e.kind !== 'character') atPoint('pickaxe_hit', e.point, isOwn(e.shooter), isOwn(e.shooter) ? 0.8 : 1);
  });
  on('swing', (e) => atCharacter('pickaxe_swing', e.character));
  on('harvest', (e) => {
    const name = `harvest_${e.material}`;
    if (SOUNDS[name]) atCharacter(name, e.character);
  });
  on('hit', (e) => {
    const player = game.player;
    if (!player || e.attacker !== player || e.target === player) return;
    if (e.kind === 'character') eng.play(e.killed ? 'hit_kill' : e.head ? 'hit_head' : 'hit', null, options(true));
  });
  on('shieldBroken', (e) => atCharacter('shield_break', e.character));
  on('piecePlaced', (e) => {
    const m = e.piece?.material ?? 'wood';
    atPiece(SOUNDS[`place_${m}`] ? `place_${m}` : 'place_wood', e.piece, isOwn(e.owner) ? 0.8 : 1);
  });
  on('pieceDestroyed', (e) => atPiece('destroy', e.piece, e.collapsed ? 0.6 : 1));
  on('doorToggled', (e) => atPiece('door', e.piece));
  on('footstep', (e) => {
    const c = e.character;
    if (!c) return;
    // ferne Schritte gar nicht erst untersuchen
    if (!isOwn(c) && c.position.distanceTo(eng.listenerPos) > A.maxDistance * 0.5) return;
    const surface = surfaceOf(c);
    atCharacter(`footstep_${surface}`, c, isOwn(c) ? 0.55 : 1);
  });
  on('jump', (e) => atCharacter('jump', e.character, isOwn(e.character) ? 0.6 : 0.8));
  on('land', (e) => {
    const h = e.fallHeight ?? 0;
    if (h < 0.5) return;
    atCharacter('land', e.character, isOwn(e.character) ? 0.7 : 1, Math.min(1, h / 8));
  });
  on('reloadStart', (e) => atCharacter('reload_start', e.character));
  on('reloadEnd', (e) => {
    if (!e.interrupted) atCharacter('reload_end', e.character);
  });
  on('weaponSwitched', (e) => {
    if (isOwn(e.character)) eng.play('switch', null, options(true));
  });
  on('healStart', (e) => atCharacter('heal_start', e.character));
  on('heal', (e) => atCharacter(e.kind === 'shield' ? 'heal_done_shield' : 'heal_done_health', e.character));
  on('pickup', (e) => atCharacter('pickup', e.character));
  on('chestOpened', (e) => atCharacter('chest', e.character));
  on('message', (e) => {
    if (e.kind === 'win') endSound(true);
    else if (e.kind === 'lose') endSound(false);
    else if (e.kind === 'round') eng.play('round', null, options(true));
  });
  on('matchEnd', (e) => {
    if (e?.result && typeof e.result.won === 'boolean') endSound(e.result.won);
  });

  return {
    game,
    enabled: true,
    engine: eng,

    /** Lautstärken aus den Einstellungen (settings.audio: master, effects, music 0..1). */
    setVolumes(settings) {
      eng.setVolumes(settings?.audio ?? settings);
    },

    /** Pro Bild: Zuhörer an die Kamera, Sturm-Brummen. */
    frameUpdate() {
      if (disposed) return;
      const cam = game.camera;
      if (cam) {
        fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
        up.set(0, 1, 0).applyQuaternion(cam.quaternion);
        eng.setListener(cam.position, fwd, up);
      }
      // Sturm: lautes Brummen draußen, leiser nahe der Wand innen
      const storm = game.storm;
      const p = game.player;
      let level = 0;
      if (storm && p && p.alive && Number.isFinite(storm.radius) && storm.center) {
        const d = Math.hypot(p.position.x - storm.center.x, p.position.z - storm.center.z);
        const inside = typeof storm.isInside === 'function' ? storm.isInside(p.position) : d <= storm.radius;
        level = inside ? Math.max(0, 1 - (storm.radius - d) / A.stormHumNear) * 0.5 : 1;
      }
      eng.setStormHum(level);
    },

    /** Einen Ton spielen (für Modi/Menüs). position = {x,y,z} oder null. */
    play(name, position = null, own = !position) {
      return position ? atPoint(name, position, own) : eng.play(name, null, options(true));
    },

    /** Menü-Töne: 'click' | 'hover' | 'back' | 'confirm'. */
    ui(name = 'click') {
      eng.play(`ui_${name}`, null, options(true));
    },

    /** Menü-Musik ('menu') starten / anhalten (Lautstärke-Gruppe "Musik"). */
    playMusic(name = 'menu') {
      eng.playMusic(name);
    },
    stopMusic() {
      eng.stopMusic();
    },

    /** Ton einschalten (passiert sonst beim ersten Klick/Tastendruck von selbst). */
    unlock() {
      return eng.unlock();
    },

    /** Für Tests. */
    debug: {
      activeVoices: (type = null) => (eng.context ? eng.limiter.count(eng.context.currentTime, type) : 0),
      stats: () => ({ state: eng.state, ...eng.stats, byName: { ...eng.stats.byName }, maxVoices: eng.limiter.max, music: eng.musicPlaying }),
      soundNames: () => SOUND_NAMES,
      playAll: () => SOUND_NAMES.map((name) => eng.play(name, null, options(true))),
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      offs.length = 0;
      eng.stopStormHum();
    },
  };
}
