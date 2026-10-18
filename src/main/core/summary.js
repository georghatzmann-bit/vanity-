'use strict';
// Liest die wichtigsten Werte aus GameUserSettings.ini für die Anzeige auf den Profilkarten.

const ini = require('./ini');

const FGUS = '/Script/FortniteGame.FortGameUserSettings';
const QUALITY = ['Niedrig', 'Mittel', 'Hoch', 'Episch', 'Episch+'];
const WINDOW_MODE = { 0: 'Vollbild', 1: 'Fenster-Vollbild', 2: 'Fenster' };

function num(v) {
  if (v == null) return null;
  const n = Number.parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (v == null) return null;
  return /^true$/i.test(String(v).trim());
}

/** Fasst eine GameUserSettings.ini in wenigen lesbaren Werten zusammen. */
function summarizeGameUserSettings(text) {
  const doc = ini.parse(text);
  const g = (k) => ini.get(doc, FGUS, k);
  const w = num(g('ResolutionSizeX'));
  const h = num(g('ResolutionSizeY'));
  const fps = num(g('FrameRateLimit'));
  const rhi = String(ini.get(doc, 'D3DRHIPreference', 'PreferredRHI') || '').trim().toLowerCase();
  const level = String(ini.get(doc, 'D3DRHIPreference', 'PreferredFeatureLevel') || '').trim().toLowerCase();
  const qualities = ['sg.ViewDistanceQuality', 'sg.ShadowQuality', 'sg.TextureQuality', 'sg.EffectsQuality', 'sg.PostProcessQuality']
    .map((k) => num(ini.get(doc, 'ScalabilityGroups', k)))
    .filter((v) => v != null);
  const avg = qualities.length ? Math.round(qualities.reduce((a, b) => a + b, 0) / qualities.length) : null;
  let renderMode = null;
  if (level === 'es31' || rhi === 'performance') renderMode = 'Leistungsmodus';
  else if (rhi === 'dx12') renderMode = 'DirectX 12';
  else if (rhi === 'dx11') renderMode = 'DirectX 11';
  const mode = num(g('FullscreenMode'));
  return {
    resolution: w && h ? `${w}×${h}` : null,
    fps: fps == null ? null : (fps <= 0 ? 'Unbegrenzt' : `${Math.round(fps)} FPS`),
    renderMode,
    quality: avg == null ? null : QUALITY[Math.max(0, Math.min(4, avg))],
    windowMode: mode == null ? null : (WINDOW_MODE[mode] || null),
    vsync: bool(g('bUseVSync')),
    brightness: num(g('DisplayGamma')),
  };
}

module.exports = { summarizeGameUserSettings, FGUS };
