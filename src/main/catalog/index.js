'use strict';
// Curated catalog access + display-name helpers.
const catalog = require('./catalog.json');

const CATEGORY_ORDER = [
  'Gaming-Launcher',
  'Gaming-Tools',
  'Browser',
  'Kommunikation',
  'Musik & Video',
  'Tools',
  'Treiber & Runtimes',
];

let index = null;
function buildIndex() {
  index = new Map();
  for (const item of catalog.items || catalog) index.set(`${item.source}:${item.id}`.toLowerCase(), item);
}

function items() {
  return catalog.items || catalog;
}

/** { categories, items } for the renderer. */
function getCatalog() {
  const list = items();
  const present = new Set(list.map((i) => i.category));
  const categories = CATEGORY_ORDER.filter((c) => present.has(c)).concat([...present].filter((c) => !CATEGORY_ORDER.includes(c)));
  return { categories, items: list };
}

/** Catalog entry for a winget/msstore id (case-insensitive) or undefined. */
function lookup(id, source = 'winget') {
  if (!index) buildIndex();
  return index.get(`${source}:${id}`.toLowerCase());
}

/** "EpicGames.EpicGamesLauncher" -> "Epic Games Launcher" (fallback when no better name is known). */
function prettifyId(id) {
  const parts = String(id || '').split('.');
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  const words = rest
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return words || String(id || '');
}

/** Best display name for an id: catalog name > given name > prettified id. */
function displayName(id, source, fallback) {
  const hit = lookup(id, source);
  if (hit) return hit.name;
  if (fallback && String(fallback).trim()) return String(fallback).trim();
  return prettifyId(id);
}

module.exports = { getCatalog, lookup, prettifyId, displayName, CATEGORY_ORDER };
