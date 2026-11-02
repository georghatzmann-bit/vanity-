'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const guide = require('../src/main/reset/guide');

test('virus-reset guide: offline page lists every step and saves only to a drive root', () => {
  const html = guide.toHtml();
  for (const s of guide.STEPS) assert.ok(html.includes(s.title.replace(/&/g, '&amp;')), s.id);
  assert.ok(html.includes(guide.LINKS.windows));
  assert.throws(() => guide.saveGuide('C:\\Users\\x'), /Ungültiges Laufwerk/);
  if (process.platform !== 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phx-guide-'));
    const res = guide.saveGuide(dir);
    assert.ok(fs.readFileSync(res.path, 'utf8').startsWith('<!doctype html>'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
