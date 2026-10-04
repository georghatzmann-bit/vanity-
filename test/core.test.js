'use strict';
// Prüft Speicherung, Link-Freigabe und die Rettungsschritte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, FILE_NAME } = require('../src/main/store');
const { isAllowedUrl } = require('../src/main/links');
const F = require('../src/shared/fields');
const STEPS = require('../src/shared/steps');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kr-test-'));
}

const fakeCrypto = {
  isAvailable: () => true,
  encrypt: (t) => Buffer.from(Buffer.from(t, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
};

const DEFAULTS = { version: 1, data: F.emptyData(), recovery: { current: null, done: {}, autoOpen: true }, ui: { view: 'recovery' } };

test('Speichern und Laden, verschlüsselt', async () => {
  const dir = tmpDir();
  const store = createStore({ dir, crypto: fakeCrypto, defaults: DEFAULTS });
  const st = store.load();
  st.data.account_id = '94b1569506b04f9f8557af611e8c5e47';
  st.recovery.done.email = '2026-10-04T10:00:00.000Z';
  await store.save(st);
  const raw = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8');
  assert.ok(!raw.includes('94b1569506b04f9f8557af611e8c5e47'), 'Daten dürfen nicht im Klartext stehen');
  const again = createStore({ dir, crypto: fakeCrypto, defaults: DEFAULTS }).load();
  assert.equal(again.data.account_id, '94b1569506b04f9f8557af611e8c5e47');
  assert.equal(again.recovery.done.email, '2026-10-04T10:00:00.000Z');
});

test('Fehlende neue Felder werden nach einem Update ergänzt', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify({ format: 'konto-retter', version: 1, enc: 'none', data: { data: { account_id: 'x' }, recovery: { done: { a: '1' } } } }));
  const st = createStore({ dir, crypto: null, defaults: DEFAULTS }).load();
  assert.equal(st.data.account_id, 'x');
  assert.deepEqual(st.data.invoice_ids, []);
  assert.equal(st.recovery.autoOpen, true);
  assert.deepEqual(st.recovery.done, { a: '1' });
});

test('Kaputte Datei: Sicherung wird benutzt', async () => {
  const dir = tmpDir();
  const store = createStore({ dir, crypto: null, defaults: DEFAULTS });
  const st = store.load();
  st.data.display_name = 'Erste';
  await store.save(st);
  st.data.display_name = 'Zweite';
  await store.save(st); // die erste Version liegt jetzt in der .bak-Datei
  fs.writeFileSync(path.join(dir, FILE_NAME), '{kaputt');
  const loaded = createStore({ dir, crypto: null, defaults: DEFAULTS }).load();
  assert.equal(loaded.data.display_name, 'Erste');
});

test('Standardwerte werden nicht zwischen Ladevorgängen geteilt', () => {
  const dir = tmpDir();
  const store = createStore({ dir, crypto: null, defaults: DEFAULTS });
  const a = store.load();
  a.data.invoice_ids.push('A123456789');
  const b = store.load();
  assert.deepEqual(b.data.invoice_ids, []);
  assert.deepEqual(DEFAULTS.data.invoice_ids, []);
});

test('Link-Freigabe: nur https und bekannte Seiten', () => {
  assert.ok(isAllowedUrl('https://www.epicgames.com/id/login?lang=de'));
  assert.ok(isAllowedUrl('https://store.epicgames.com/de/'));
  assert.ok(isAllowedUrl('https://myaccount.google.com/security'));
  assert.ok(!isAllowedUrl('http://www.epicgames.com/'));
  assert.ok(!isAllowedUrl('https://epicgames.com.evil.example/'));
  assert.ok(!isAllowedUrl('https://evil-epicgames.com/'));
  assert.ok(!isAllowedUrl('https://user:pass@www.epicgames.com/'));
  assert.ok(!isAllowedUrl('javascript:alert(1)'));
  assert.ok(!isAllowedUrl('file:///C:/Windows/System32/calc.exe'));
  assert.ok(!isAllowedUrl('kein link'));
});

test('Alle Links der Schritte sind freigegeben', () => {
  for (const step of STEPS.STEPS) {
    assert.ok(isAllowedUrl(step.url), step.id + ': ' + step.url);
    for (const l of step.links || []) assert.ok(isAllowedUrl(l.url), step.id + ': ' + l.url);
  }
  for (const p of STEPS.EMAIL_PROVIDERS) assert.ok(isAllowedUrl(p.url), p.url);
  for (const u of Object.values(STEPS.URLS)) assert.ok(isAllowedUrl(u), u);
});

test('Schritte sind vollständig und verweisen nur auf vorhandene Felder', () => {
  const ids = new Set();
  for (const step of STEPS.STEPS) {
    assert.ok(!ids.has(step.id), 'doppelte ID ' + step.id);
    ids.add(step.id);
    assert.ok(step.title && step.why && step.todo.length, step.id);
    assert.ok(STEPS.PHASES.some((p) => p.key === step.phase), step.id);
    for (const k of [...(step.data || []), ...(step.inputs || [])]) assert.ok(F.byKey(k), step.id + ': unbekanntes Feld ' + k);
    if (step.urlFromEmail) assert.ok(F.byKey(step.urlFromEmail));
  }
  for (const step of STEPS.STEPS) {
    if (step.success) assert.ok(ids.has(step.success.jumpTo), step.id + ' springt ins Leere');
    for (const it of step.internal || []) assert.ok(['pdf', 'data', 'support', 'discord', 'recovery'].includes(it.view));
  }
});

test('lang=de wird richtig angehängt', () => {
  assert.equal(STEPS.de('https://a.epicgames.com/x'), 'https://a.epicgames.com/x?lang=de');
  assert.equal(STEPS.de('https://a.epicgames.com/x?y=1'), 'https://a.epicgames.com/x?y=1&lang=de');
  assert.equal(STEPS.de('https://a.epicgames.com/x#apps'), 'https://a.epicgames.com/x?lang=de#apps');
  assert.equal(STEPS.de('https://a.epicgames.com/x?lang=en'), 'https://a.epicgames.com/x?lang=en');
});

test('E-Mail-Anbieter werden erkannt', () => {
  assert.equal(STEPS.providerForEmail('Max@GMX.de').name, 'GMX');
  assert.equal(STEPS.providerForEmail('a@googlemail.com').name, 'Gmail (Google)');
  assert.equal(STEPS.providerForEmail('a@hotmail.de').name, 'Outlook / Hotmail (Microsoft)');
  assert.equal(STEPS.providerForEmail('a@firma.de'), null);
  assert.equal(STEPS.providerForEmail(''), null);
});

test('Felder: Listen und Texte', () => {
  const d = F.emptyData();
  d.invoice_ids = ['A1', '', '  A2 '];
  d.display_names_old = 'X\n\nY';
  assert.deepEqual(F.listValue(d, 'invoice_ids'), ['A1', 'A2']);
  assert.deepEqual(F.listValue(d, 'display_names_old'), ['X', 'Y']);
  assert.equal(F.valueAsText(d, 'invoice_ids'), 'A1\nA2');
  d.first_name = 'Max';
  d.last_name = 'Mustermann';
  assert.equal(F.fullName(d), 'Max Mustermann');
});
