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

// Empfindlichkeit in Prozent wie in Fortnite. Ältere Speicherungen (Faktoren wie 1,0)
// haben diese Kennung nicht – ihre Empfindlichkeit wird dann auf Standard gesetzt,
// sonst würde aus "1,0" plötzlich "1 %".
export const SENSITIVITY_SCALE = 'fortnite-prozent';
const AUTO_CONFIRM = ['off', 'weapon', 'build', 'both'];
const AUTO_CONFIG_OK = (value) => AUTO_CONFIRM.includes(value);

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
      autoConfirmEdits: CONFIG.controls.autoConfirmEdits,
      resetConfirms: CONFIG.controls.resetConfirms,
      resetEditAfterConfirm: CONFIG.controls.resetEditAfterConfirm,
      turboBuilding: CONFIG.controls.turboBuilding,
      resetBuildingChoice: CONFIG.controls.resetBuildingChoice,
      aimAssist: CONFIG.controls.gamepad.aimAssist.enabled,
    },
    sensitivity: {
      scale: SENSITIVITY_SCALE, // Kennung der Maßeinheit (Prozent wie in Fortnite)
      x: CONFIG.sensitivity.x,
      y: CONFIG.sensitivity.y,
      targeting: CONFIG.sensitivity.targeting,
      scope: CONFIG.sensitivity.scope,
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
  for (const [key, [min, max]] of Object.entries(CONFIG.sensitivity.limits)) s[key] = clamp(s[key], min, max);
  s.scale = SENSITIVITY_SCALE;
  if (!AUTO_CONFIG_OK(settings.controls.autoConfirmEdits)) settings.controls.autoConfirmEdits = CONFIG.controls.autoConfirmEdits;
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
    // alte Empfindlichkeit (Faktoren) nicht übernehmen
    if (isPlainObject(stored) && isPlainObject(stored.sensitivity) && stored.sensitivity.scale !== SENSITIVITY_SCALE) {
      delete stored.sensitivity;
      // alte Belegung: Q war "Material wechseln" – jetzt ist Q der Baumodus (wie in Fortnite)
      if (isPlainObject(stored.controls?.keyboard)) delete stored.controls.keyboard.switchMaterial;
    }
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
