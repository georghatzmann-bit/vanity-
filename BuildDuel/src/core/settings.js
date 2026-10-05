// =============================================================================
// Einstellungen (Tasten, Empfindlichkeit, Grafik, Ton, Spiel)
// =============================================================================
// Die Standardwerte kommen aus config.js. Was der Spieler ändert, wird im
// Browser gespeichert (localStorage, Schlüssel "buildduel.settings.v1").
//
// Beim Laden werden gespeicherte Werte ÜBER die Standardwerte gelegt
// ("deep merge"). Dabei wird alles geprüft:
//   - unbekannte Felder (z. B. aus einer alten Version) werden ignoriert
//   - Felder mit falschem Typ (Text statt Zahl …) werden ignoriert
//   - kaputte Daten (kein gültiges JSON) → einfach die Standardwerte
// So kann eine alte oder beschädigte Speicherung das Spiel nie kaputt machen.
// =============================================================================
import { CONFIG, getQualityPreset } from '../config.js';

export const SETTINGS_KEY = `${CONFIG.game.storageKeyPrefix}settings.v1`;

/** Erzeugt frische Standard-Einstellungen (jedes Mal ein neues Objekt). */
export function defaultSettings() {
  const keyboard = {};
  for (const [action, codes] of Object.entries(CONFIG.controls.keyboard)) keyboard[action] = [...codes];
  return {
    controls: {
      keyboard,
      crouchOnCtrl: CONFIG.controls.crouchOnCtrl,
      crouchToggle: CONFIG.controls.crouchToggle,
      editOnRelease: CONFIG.controls.editOnRelease,
      resetEditAfterConfirm: CONFIG.controls.resetEditAfterConfirm,
      aimAssist: CONFIG.controls.gamepad.aimAssist.enabled,
    },
    sensitivity: {
      x: CONFIG.sensitivity.x,
      y: CONFIG.sensitivity.y,
      aim: CONFIG.sensitivity.aim,
      sniper: CONFIG.sensitivity.sniper,
      build: CONFIG.sensitivity.build,
      edit: CONFIG.sensitivity.edit,
      invertY: CONFIG.sensitivity.invertY,
    },
    graphics: {
      quality: CONFIG.graphics.quality,
      resolutionScale: null, // null = Wert aus der Qualitäts-Stufe, sonst 0,5 … 1
      viewDistance: null, // null = Wert aus der Qualitäts-Stufe, sonst Meter
      showFps: CONFIG.graphics.showFps,
    },
    audio: {
      master: CONFIG.audio.master,
      effects: CONFIG.audio.effects,
      music: CONFIG.audio.music,
    },
    game: {
      playerName: 'Spieler',
      botDifficulty: CONFIG.bots.defaultDifficulty,
      damageNumbers: true,
    },
  };
}

// Felder, deren Standardwert null ist, dürfen eine Zahl ODER null sein.
const NULLABLE_NUMBER = new Set(['graphics.resolutionScale', 'graphics.viewDistance']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Legt "stored" über "defaults". Nur bekannte Felder mit passendem Typ werden
 * übernommen. Ausnahme: controls.keyboard – dort dürfen nur bekannte Aktionen
 * mit einer Liste von Tasten-Codes (Texten) stehen.
 * Ändert "defaults" direkt und gibt es zurück.
 */
export function mergeSettings(defaults, stored, path = '') {
  if (!isPlainObject(stored)) return defaults;
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(stored, key)) continue;
    const fullPath = path ? `${path}.${key}` : key;
    const base = defaults[key];
    const value = stored[key];

    if (Array.isArray(base)) {
      // Tasten-Liste: nur Texte, höchstens 4 Tasten pro Aktion
      if (Array.isArray(value) && value.length <= 4 && value.every((v) => typeof v === 'string' && v.length > 0 && v.length < 40)) {
        defaults[key] = [...value];
      }
    } else if (isPlainObject(base)) {
      mergeSettings(base, value, fullPath);
    } else if (base === null || NULLABLE_NUMBER.has(fullPath)) {
      if (value === null || (typeof value === 'number' && Number.isFinite(value))) defaults[key] = value;
    } else if (typeof base === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) defaults[key] = value;
    } else if (typeof base === typeof value) {
      defaults[key] = value;
    }
  }
  return defaults;
}

// Werte in sinnvolle Grenzen bringen (z. B. nach Handarbeit im Speicher).
function sanitize(settings) {
  const s = settings.sensitivity;
  for (const key of ['x', 'y', 'aim', 'sniper', 'build', 'edit']) s[key] = clamp(s[key], 0.05, 10);
  const g = settings.graphics;
  if (!Object.hasOwn(CONFIG.graphics.presets, String(g.quality).trim().toLowerCase())) g.quality = CONFIG.graphics.quality;
  if (g.resolutionScale !== null) g.resolutionScale = clamp(g.resolutionScale, 0.5, 1);
  if (g.viewDistance !== null) g.viewDistance = clamp(g.viewDistance, 100, 1500);
  const a = settings.audio;
  for (const key of ['master', 'effects', 'music']) a[key] = clamp(a[key], 0, 1);
  if (!Object.hasOwn(CONFIG.bots.difficulties, settings.game.botDifficulty)) {
    settings.game.botDifficulty = CONFIG.bots.defaultDifficulty;
  }
  settings.game.playerName = String(settings.game.playerName).slice(0, 20) || 'Spieler';
  return settings;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // z. B. gesperrt im privaten Modus
  }
}

/**
 * Lädt die Einstellungen. Fehlt etwas oder ist etwas kaputt → Standardwerte.
 * @param {Storage} [storage]  zum Testen austauschbar (Standard: localStorage)
 */
export function loadSettings(storage = defaultStorage()) {
  const settings = defaultSettings();
  if (!storage) return settings;
  let raw = null;
  try {
    raw = storage.getItem(SETTINGS_KEY);
  } catch {
    return settings;
  }
  if (!raw) return settings;
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return settings; // kaputtes JSON → Standardwerte
  }
  try {
    return sanitize(mergeSettings(settings, stored));
  } catch {
    return defaultSettings();
  }
}

/**
 * Speichert die Einstellungen.
 * @returns {boolean} true, wenn es geklappt hat
 */
export function saveSettings(settings, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false; // Speicher voll oder gesperrt
  }
}

/** Löscht die gespeicherten Einstellungen und gibt die Standardwerte zurück. */
export function resetSettings(storage = defaultStorage()) {
  if (storage) {
    try {
      storage.removeItem(SETTINGS_KEY);
    } catch {
      // egal – dann gelten eben beim nächsten Laden noch die alten Werte
    }
  }
  return defaultSettings();
}

/**
 * Die Grafik-Werte, die wirklich gelten: Qualitäts-Stufe aus config.js,
 * überschrieben von eigenen Einstellungen (Auflösung, Sichtweite, FPS-Anzeige).
 */
export function resolveGraphics(settings) {
  const g = settings?.graphics ?? {};
  const preset = getQualityPreset(g.quality ?? CONFIG.graphics.quality);
  return {
    ...preset,
    resolutionScale: g.resolutionScale ?? preset.resolutionScale,
    viewDistance: g.viewDistance ?? preset.viewDistance,
    showFps: g.showFps ?? CONFIG.graphics.showFps,
  };
}
