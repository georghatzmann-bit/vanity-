'use strict';
// PURE restore code: "PHX1-" + base64url(deflateRaw(JSON)) – compact enough to send via chat.
const zlib = require('zlib');
const { normalize } = require('./profile');
const catalog = require('../catalog');

const PREFIX = 'PHX1-';
const SOURCES = ['winget', 'msstore'];

function toMinimal(profile) {
  const p = normalize(profile);
  return {
    v: 1,
    h: p.machine.hostname || undefined,
    d: p.createdAt,
    // names are only kept when they cannot be derived from the catalog or the id itself
    a: p.apps.map((a) => {
      const derivable = catalog.lookup(a.id, a.source) || a.name === catalog.prettifyId(a.id);
      return derivable ? [SOURCES.indexOf(a.source), a.id] : [SOURCES.indexOf(a.source), a.id, a.name];
    }),
    g: p.games.map((g) => {
      if (g.platform === 'epic') return ['e', g.title, g.appName, g.namespace || '', g.catalogItemId || ''];
      if (g.platform === 'steam') return ['s', g.title, g.appId];
      return ['o', g.title];
    }),
  };
}

function fromMinimal(min) {
  if (!min || typeof min !== 'object' || min.v !== 1) throw new Error('Unbekannte Code-Version.');
  const apps = (Array.isArray(min.a) ? min.a : []).map((entry) => ({
    source: SOURCES[entry && entry[0]] || 'winget',
    id: entry && entry[1],
    name: entry && typeof entry[2] === 'string' ? entry[2] : undefined,
  }));
  const games = (Array.isArray(min.g) ? min.g : []).map((g) => {
    if (!Array.isArray(g)) return null;
    if (g[0] === 'e') return { platform: 'epic', title: g[1], appName: g[2], namespace: g[3] || undefined, catalogItemId: g[4] || undefined };
    if (g[0] === 's') return { platform: 'steam', title: g[1], appId: g[2] };
    return { platform: 'other', title: g[1] };
  });
  return normalize({ createdAt: min.d, machine: { hostname: min.h || '' }, apps, games, unmatched: [] });
}

/** Profile -> "PHX1-..." */
function encode(profile) {
  const json = JSON.stringify(toMinimal(profile));
  return PREFIX + zlib.deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
}

/** "PHX1-..." (whitespace, line breaks and a missing prefix are tolerated) -> Profile */
function decode(text) {
  let body = String(text || '').replace(/\s+/g, '');
  if (!body) throw new Error('Der Code ist leer.');
  const at = body.toUpperCase().indexOf(PREFIX);
  if (at !== -1) body = body.slice(at + PREFIX.length);
  body = body.replace(/[^A-Za-z0-9\-_+/=]/g, '');
  let json;
  try {
    if (!body) throw new Error('empty');
    const buf = Buffer.from(body.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
    json = JSON.parse(zlib.inflateRawSync(buf, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8'));
  } catch {
    throw new Error('Der Code ist ungültig oder unvollständig. Bitte komplett kopieren (beginnt mit PHX1-).');
  }
  return fromMinimal(json);
}

module.exports = { encode, decode, PREFIX };
