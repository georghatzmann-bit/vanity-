'use strict';
// Cloud-Wächter: Was zählt als "Fortnite hat Einstellungen verändert"?
//
// Fortnite schreibt GameUserSettings.ini bei jedem Beenden neu – mit Zeitstempeln, Benchmark-Werten
// und Statistiken, auch wenn der Spieler nichts geändert hat. Deshalb werden INI-Dateien nicht per
// Prüfsumme verglichen, sondern Wert für Wert – bei GameUserSettings.ini nur die echten Einstellungen.

const ini = require('./ini');

// Einstellungen in GameUserSettings.ini, die der Spieler wirklich bemerkt
const GUS_KEYS = [
  /^ResolutionSize[XY]$/i,
  /^LastUserConfirmedResolutionSize[XY]$/i,
  /^(Preferred|LastConfirmed)?FullscreenMode$/i,
  /^FrameRateLimit$/i,
  /^bUseVSync$/i,
  /^bUseDynamicResolution$/i,
  /^DisplayGamma$/i,
  /^UserInterfaceContrast$/i,
  /^bShowGrass$/i,
  /^bMotionBlur$/i,
  /^bShowFPS$/i,
  /^bUseNanite$/i,
  /^bRayTracing$/i,
  /^bDisableMouseAcceleration$/i,
  /^FortAntiAliasingMethod$/i,
  /^TemporalSuperResolutionQuality$/i,
  /^(DLSS|XeSS)Quality$/i,
  /^LatencyTweak2$/i,
  /^sg\./i,
  /^PreferredRHI$/i,
  /^PreferredFeatureLevel$/i,
  /^MeshQuality$/i,
];

const isGus = (rel) => /(^|\/)GameUserSettings\.ini$/i.test(rel);
const isIni = (rel) => /\.ini$/i.test(rel);

/** Liest die Werte, die der Wächter für eine Datei beobachtet. Für Nicht-INI-Dateien: null. */
function watchedValues(rel, buf) {
  if (!isIni(rel)) return null;
  const obj = ini.toObject(ini.parse(ini.decode(buf).text));
  const out = {};
  for (const [section, keys] of Object.entries(obj)) {
    for (const [key, value] of Object.entries(keys)) {
      if (isGus(rel) && !GUS_KEYS.some((re) => re.test(key))) continue;
      out[`${section}|${key}`] = String(value).trim();
    }
  }
  return out;
}

/** Unterschiede zwischen erwarteten und aktuellen Werten. */
function diffValues(expected, current) {
  const changes = [];
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(current || {})]);
  for (const k of keys) {
    const a = expected?.[k];
    const b = current?.[k];
    if (a === b) continue;
    // Zahlen tolerant vergleichen (240 == 240.000000)
    if (a != null && b != null && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b)) continue;
    const [section, key] = k.split('|');
    changes.push({ section, key, from: a ?? null, to: b ?? null });
  }
  return changes;
}

module.exports = { watchedValues, diffValues, GUS_KEYS };
