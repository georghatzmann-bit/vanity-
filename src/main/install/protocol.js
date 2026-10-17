'use strict';
// PURE NDJSON framing for the UI <-> elevated worker pipe (docs/ARCHITECTURE.md §6).

const MAX_LINE = 1024 * 1024; // 1 MiB per message is far more than we ever send

/** Serialises one message as a single line. */
function encodeMessage(msg) {
  return JSON.stringify(msg) + '\n';
}

/**
 * Creates a stateful decoder. Feed it raw chunks (Buffer or string); it calls
 * onMessage for every complete, valid JSON object and onError for garbage.
 */
function createDecoder(onMessage, onError = () => {}) {
  let buffer = '';
  return function feed(chunk) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (buffer.length > MAX_LINE && buffer.indexOf('\n') === -1) {
      buffer = '';
      onError(new Error('message too large'));
      return;
    }
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        onError(err);
        continue;
      }
      if (msg && typeof msg === 'object' && typeof msg.t === 'string') onMessage(msg);
      else onError(new Error('invalid message'));
    }
  };
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+_\-]{0,127}$/;

/** Validates and sanitises install items coming from the renderer or over the pipe. */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const id = typeof it.id === 'string' ? it.id.trim() : '';
    const source = it.source === 'msstore' ? 'msstore' : it.source === 'winget' ? 'winget' : null;
    if (!source || !ID_RE.test(id)) continue;
    const key = `${source}:${id}`;
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    const elevation = ['required', 'prohibited', 'none', 'unknown'].includes(it.elevation) ? it.elevation : 'unknown';
    const scope = ['user', 'machine', 'both'].includes(it.scope) ? it.scope : 'unknown';
    const name = typeof it.name === 'string' && it.name.trim() ? it.name.trim().slice(0, 120) : id;
    out.push({ key, id, source, name, elevation, scope });
  }
  return out;
}

module.exports = { encodeMessage, createDecoder, sanitizeItems, ID_RE };
