'use strict';
// Prüft die Support-Texte auf Deutsch und Englisch.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/shared/fields');
const S = require('../src/shared/supportText');

function fullData() {
  const d = F.emptyData();
  Object.assign(d, {
    account_id: '94b1569506b04f9f8557af611e8c5e47',
    display_name: 'GeorgZockt',
    display_name_original: 'Georg2018',
    display_names_old: ['WinterWolf'],
    email_original: 'max.mustermann@beispiel.de',
    emails_old: ['alt@beispiel.de'],
    email_new: 'neu-und-sicher@beispiel.de',
    email_hacker: 'hacker@fremd.example',
    first_name: 'Max',
    last_name: 'Mustermann',
    country: 'Deutschland',
    account_created: 'Sommer 2018',
    platforms: ['PlayStation: Winter Wolf (verknüpft seit 02.03.2019)', 'Nintendo: Georg'],
    invoice_ids: ['A812855087', 'F1156160356'],
    payment_method: 'Visa, endet auf 4242',
    hack_date: '02.10.2026 gegen 21 Uhr',
    recovery_id: '7XK2-9QPL-4421',
    ticket_number: '12345678',
    hack_changes: ['email_changed', 'password_changed', 'purchases_made'],
  });
  return d;
}

const ALL = [];
for (const variant of ['first', 'followup', 'short']) for (const lang of ['de', 'en']) ALL.push({ variant, lang });

test('Kein Text enthält "undefined", "null" oder "[object"', () => {
  for (const data of [fullData(), F.emptyData()]) {
    for (const opts of ALL) {
      const out = S.build(data, opts);
      for (const part of [out.subject, out.body]) {
        assert.ok(!/undefined|null|\[object/.test(part), opts.variant + '/' + opts.lang + ': ' + part);
      }
    }
  }
});

test('Erste Anfrage (deutsch) enthält alle Nachweise', () => {
  const out = S.build(fullData(), { lang: 'de', variant: 'first' });
  assert.match(out.subject, /94b1569506b04f9f8557af611e8c5e47/);
  for (const needle of ['GeorgZockt', 'Georg2018', 'WinterWolf', 'max.mustermann@beispiel.de', 'alt@beispiel.de', 'neu-und-sicher@beispiel.de', 'hacker@fremd.example', 'A812855087', 'F1156160356', 'Visa, endet auf 4242', '7XK2-9QPL-4421', 'Max Mustermann', 'Käufe getätigt']) {
    assert.ok(out.body.includes(needle), 'fehlt: ' + needle);
  }
  assert.deepEqual(out.missing, []);
});

test('Englischer Text übersetzt Datum und Land, aber keine Namen', () => {
  const out = S.build(fullData(), { lang: 'en', variant: 'first' });
  assert.match(out.body, /noticed on 2026-10-02 around 21:00/);
  assert.match(out.body, /Country at account creation: Germany/);
  assert.match(out.body, /Account created \(approx\.\): summer 2018/);
  // Gamertag "Winter Wolf" darf nicht zu "winter Wolf" werden, nur die Klammer wird übersetzt
  assert.ok(out.body.includes('PlayStation: Winter Wolf (linked since 2019-03-02)'), out.body);
  assert.ok(!/[äöüß]/i.test(out.body.replace(/Mustermann|beispiel/g, '')), 'keine deutschen Umlaute im englischen Text');
});

test('Fehlende Angaben werden gemeldet', () => {
  const out = S.build(F.emptyData(), { lang: 'de', variant: 'first' });
  assert.deepEqual(out.missing, ['account_id', 'display_name', 'email_original', 'email_new', 'invoice_ids', 'hack_date']);
  assert.match(out.body, /Jemand hat sich ohne meine Erlaubnis/);
});

test('Nachfrage: Ticket- ODER Recovery-Nummer reicht', () => {
  const d = F.emptyData();
  d.recovery_id = 'ABC-123456';
  const out = S.build(d, { lang: 'de', variant: 'followup' });
  assert.ok(!out.missing.includes('ticket_number'));
  assert.ok(!out.missing.includes('recovery_id'));
  assert.match(out.subject, /ABC-123456/);
});

test('Kurzfassung bleibt kurz', () => {
  const out = S.build(fullData(), { lang: 'de', variant: 'short' });
  assert.ok(out.body.length < 700, 'zu lang: ' + out.body.length);
});

test('toEnglish', () => {
  assert.equal(S.toEnglish('02.10.2026 gegen 21 Uhr'), '2026-10-02 around 21:00');
  assert.equal(S.toEnglish('ca. März 2019'), 'approx. March 2019');
  assert.equal(S.toEnglish('Visa, endet auf 1234'), 'Visa, ending in 1234');
});
