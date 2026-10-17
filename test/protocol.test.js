'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encodeMessage, createDecoder, sanitizeItems } = require('../src/main/install/protocol');

test('decoder handles split chunks, CRLF and garbage', () => {
  const got = [];
  const errors = [];
  const feed = createDecoder((m) => got.push(m), (e) => errors.push(e));
  const a = encodeMessage({ t: 'hello', token: 'x' });
  feed(a.slice(0, 5));
  feed(a.slice(5) + '{"t":"ev');
  feed(Buffer.from('ent","n":1}\r\nnot json\n\n{"x":1}\n'));
  assert.deepStrictEqual(got, [{ t: 'hello', token: 'x' }, { t: 'event', n: 1 }]);
  assert.strictEqual(errors.length, 2);
});

test('decoder keeps a multi-byte character split across chunks', () => {
  const got = [];
  const feed = createDecoder((m) => got.push(m));
  const buf = Buffer.from(encodeMessage({ t: 'log', line: 'Lädt … ✓' }));
  const cut = buf.indexOf(0xc3) + 1; // inside the "ä"
  feed(buf.subarray(0, cut));
  feed(buf.subarray(cut));
  assert.deepStrictEqual(got, [{ t: 'log', line: 'Lädt … ✓' }]);
});

test('sanitizeItems validates ids, sources and dedupes', () => {
  const items = sanitizeItems([
    { id: 'Discord.Discord', source: 'winget', name: 'Discord', elevation: 'none' },
    { id: 'discord.discord', source: 'winget' },
    { id: '9NKSQGP7F2NH', source: 'msstore', name: 'WhatsApp', elevation: 'weird' },
    { id: 'x & calc.exe', source: 'winget' },
    { id: 'Valve.Steam', source: 'link' },
    null,
  ]);
  assert.deepStrictEqual(items, [
    { key: 'winget:Discord.Discord', id: 'Discord.Discord', source: 'winget', name: 'Discord', elevation: 'none', scope: 'unknown' },
    { key: 'msstore:9NKSQGP7F2NH', id: '9NKSQGP7F2NH', source: 'msstore', name: 'WhatsApp', elevation: 'unknown', scope: 'unknown' },
  ]);
});
