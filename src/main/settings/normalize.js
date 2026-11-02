'use strict';
// PURE: cleans the settings block of a profile (untrusted file content).
const prefs = require('./prefs');
const displays = require('./displays');

function normalizeSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { displays: displays.normalizeEntries(s.displays), prefs: prefs.normalizePrefs(s.prefs), dpi: prefs.normalizeDpi(s.dpi) };
  return out.displays.length || Object.keys(out.prefs).length || out.dpi.length ? out : null;
}

module.exports = { normalizeSettings };
