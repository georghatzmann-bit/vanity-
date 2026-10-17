'use strict';
// PURE parser for Valve's text KeyValues format (libraryfolders.vdf, appmanifest_*.acf).
// Handles quoted/unquoted tokens, escape sequences (\\ \" \n \t), // comments,
// conditional suffixes like [$WIN32] and duplicate keys (last one wins).

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '﻿' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '{' || ch === '}') {
      tokens.push({ type: ch });
      i++;
    } else if (ch === '[') {
      // conditional like [$WIN32] - ignored
      while (i < n && text[i] !== ']') i++;
      i++;
    } else if (ch === '"') {
      let value = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const next = text[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          value += text[i++];
        }
      }
      i++; // closing quote
      tokens.push({ type: 'str', value });
    } else {
      let value = '';
      while (i < n && !/[\s{}"]/.test(text[i])) value += text[i++];
      tokens.push({ type: 'str', value });
    }
  }
  return tokens;
}

/**
 * Parses KeyValues text into nested plain objects. Keys are kept as written;
 * use getCI() for case-insensitive access.
 */
function parseVdf(text) {
  const tokens = tokenize(String(text || ''));
  let pos = 0;
  function parseObject() {
    const obj = {};
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.type === '}') {
        pos++;
        return obj;
      }
      if (tok.type !== 'str') {
        pos++;
        continue;
      }
      const key = tok.value;
      pos++;
      const next = tokens[pos];
      if (!next) break;
      if (next.type === '{') {
        pos++;
        obj[key] = parseObject();
      } else if (next.type === 'str') {
        obj[key] = next.value;
        pos++;
      } else {
        pos++;
      }
    }
    return obj;
  }
  return parseObject();
}

/** Case-insensitive property lookup. */
function getCI(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

/**
 * Extracts library folders from libraryfolders.vdf (old and new format).
 * @returns {{path: string, apps: string[]}[]}
 */
function parseLibraryFolders(text) {
  const root = parseVdf(text);
  const lf = getCI(root, 'libraryfolders') || getCI(root, 'LibraryFolders') || {};
  const out = [];
  for (const [key, value] of Object.entries(lf)) {
    if (!/^\d+$/.test(key)) continue;
    if (typeof value === 'string') {
      out.push({ path: value, apps: [] });
    } else if (value && typeof value === 'object') {
      const p = getCI(value, 'path');
      if (typeof p === 'string' && p) {
        const apps = getCI(value, 'apps');
        out.push({ path: p, apps: apps && typeof apps === 'object' ? Object.keys(apps) : [] });
      }
    }
  }
  return out;
}

/**
 * Extracts the interesting fields of an appmanifest_<id>.acf.
 * @returns {{appId: number, name: string, installdir: string, sizeBytes: number, stateFlags: number} | null}
 */
function parseAppManifest(text) {
  const root = parseVdf(text);
  const state = getCI(root, 'AppState');
  if (!state || typeof state !== 'object') return null;
  const appId = Number(getCI(state, 'appid'));
  const name = getCI(state, 'name');
  if (!Number.isFinite(appId) || appId <= 0 || typeof name !== 'string' || !name) return null;
  return {
    appId,
    name,
    installdir: String(getCI(state, 'installdir') || ''),
    sizeBytes: Number(getCI(state, 'SizeOnDisk')) || 0,
    stateFlags: Number(getCI(state, 'StateFlags')) || 0,
  };
}

module.exports = { parseVdf, getCI, parseLibraryFolders, parseAppManifest };
