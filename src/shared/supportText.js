// Erstellt fertige Texte für den Epic-Support auf Deutsch und Englisch.
// Die Texte füllen sich mit den Daten aus "Meine Daten". Fehlende Angaben werden weggelassen
// und als Liste zurückgegeben, damit die Oberfläche darauf hinweisen kann.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fields'));
  else root.KR_SUPPORT = factory(root.KR_FIELDS);
})(typeof self !== 'undefined' ? self : this, function (F) {
  'use strict';

  // Wichtig: Das Konto selbst gibt Epic nur über das Wiederherstellungsformular zurück.
  // Diese Texte sind für alles andere: Hack melden, fremde Käufe, fremde verknüpfte Konten, Nachfragen.
  const VARIANTS = [
    { key: 'first', label: 'Hack melden', hint: 'Ausführlicher Text mit allen Nachweisen: Hack, fremde Käufe oder Änderungen melden.' },
    { key: 'followup', label: 'Nachfrage', hint: 'Wenn du schon eine Ticket- oder Recovery-Nummer hast und nachhaken willst.' },
    { key: 'short', label: 'Kurzfassung', hint: 'Für den Support-Chat oder Felder mit wenig Platz.' },
  ];

  // Wichtige Angaben je Textart. Fehlen sie, zeigt die Oberfläche einen Hinweis.
  const IMPORTANT = {
    first: ['account_id', 'display_name', 'email_original', 'email_new', 'invoice_ids', 'hack_date', 'recovery_id'],
    followup: ['ticket_number', 'recovery_id', 'account_id', 'display_name'],
    short: ['account_id', 'display_name', 'email_original', 'email_new'],
  };

  // ---------- Kleine Übersetzungshilfe für eigene Eingaben im englischen Text ----------
  // Übersetzt werden nur Datumsangaben und einige feste Wörter. E-Mail-Adressen, Namen und
  // Kennungen bleiben unverändert (z. B. "juli.schmidt@gmx.de" oder ein Gamertag "Winter Wolf").
  const MONTHS = {
    januar: 'January', 'jänner': 'January', februar: 'February', 'märz': 'March', maerz: 'March', april: 'April', mai: 'May', juni: 'June',
    juli: 'July', august: 'August', september: 'September', oktober: 'October', november: 'November', dezember: 'December',
  };
  const SEASONS = { sommer: 'summer', 'frühjahr': 'spring', 'frühling': 'spring', herbst: 'autumn', winter: 'winter' };
  const WORDS = [
    [/\bca\.\s*/gi, 'approx. '],
    [/\bungefähr\b/gi, 'approximately'],
    [/\bgegen(?=\s+\d)/gi, 'around'],
    [/\bverknüpft seit\b/gi, 'linked since'],
    [/\bseit(?=\s+\d)/gi, 'since'],
    [/\bnoch verbunden\b/gi, 'still linked'],
    [/\bnicht mehr verbunden\b/gi, 'no longer linked'],
    [/\bendet auf\b/gi, 'ending in'],
    [/\bKreditkarte\b/gi, 'credit card'],
    [/\bAnfang(?=\s+(?:\d|[A-Z][a-z]+\s+\d))/g, 'early'],
    [/\bMitte(?=\s+(?:\d|[A-Z][a-z]+\s+\d))/g, 'mid'],
    [/\bEnde(?=\s+(?:\d|[A-Z][a-z]+\s+\d))/g, 'late'],
    [/(\d)\s+morgens\b/gi, '$1 in the morning'],
    [/(\d)\s+abends\b/gi, '$1 in the evening'],
    [/(\d)\s+nachts\b/gi, '$1 at night'],
  ];
  const COUNTRIES = {
    deutschland: 'Germany', 'österreich': 'Austria', oesterreich: 'Austria', schweiz: 'Switzerland', niederlande: 'Netherlands',
    belgien: 'Belgium', frankreich: 'France', italien: 'Italy', spanien: 'Spain', polen: 'Poland', luxemburg: 'Luxembourg',
    'vereinigtes königreich': 'United Kingdom', 'vereinigte staaten': 'United States', usa: 'United States', 'türkei': 'Turkey',
  };

  function translatePart(part) {
    let s = part;
    // 02.10.2026 -> 2026-10-02 (eindeutig für alle Länder)
    s = s.replace(/(?<![\w.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\w.])/g, (m, d, mo, y) => y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0'));
    // 21 Uhr / 21:30 Uhr -> 21:00 / 21:30
    s = s.replace(/\b(\d{1,2}):(\d{2})\s*Uhr\b/gi, '$1:$2');
    s = s.replace(/\b(\d{1,2})\s*Uhr\b/gi, '$1:00');
    // Monate und Jahreszeiten nur in Datumsangaben ("März 2019", "4. März 2019", "Sommer 2018")
    s = s.replace(/(?:(\d{1,2})\.\s*)?\b([A-Za-zäöüÄÖÜ]+)(?=\s+\d{4}\b)/g, (m, day, w) => {
      const month = MONTHS[w.toLowerCase()];
      if (month) return day ? month + ' ' + Number(day) + ',' : month;
      const season = SEASONS[w.toLowerCase()];
      if (season) return (day ? day + '. ' : '') + season;
      return m;
    });
    for (const [re, rep] of WORDS) s = s.replace(re, rep);
    return s;
  }

  function toEnglish(text) {
    // Teile mit "@" (E-Mail-Adressen) nie verändern
    return String(text || '').split(/(\S*@\S*)/).map((part, i) => (i % 2 ? part : translatePart(part))).join('');
  }

  // Bei Konten wie "PlayStation: WinterWolf (seit 2019)" nur die Klammer übersetzen,
  // damit Namen und Gamertags nie verändert werden.
  function toEnglishParens(text) {
    return String(text || '').replace(/\(([^)]*)\)/g, (m, inner) => '(' + toEnglish(inner) + ')');
  }

  // Zahlungsart: nur die festen Wendungen übersetzen (die PayPal-Adresse bleibt, wie sie ist)
  function paymentEn(text) {
    return String(text || '').replace(/\bendet auf\b/gi, 'ending in').replace(/\bKreditkarte\b/gi, 'credit card');
  }

  function countryEn(text) {
    const key = String(text || '').trim().toLowerCase();
    return COUNTRIES[key] || text;
  }

  // ---------- Hilfen ----------
  function v(data, key) {
    return F.valueAsText(data, key);
  }

  function list(data, key) {
    return F.listValue(data, key);
  }

  function bullet(lines, label, value) {
    if (value && String(value).trim()) lines.push('- ' + label + ': ' + value);
  }

  function bulletList(lines, label, items) {
    if (!items.length) return;
    if (items.length === 1) lines.push('- ' + label + ': ' + items[0]);
    else {
      lines.push('- ' + label + ':');
      for (const it of items) lines.push('    • ' + it);
    }
  }

  function signature(data) {
    return F.fullName(data) || v(data, 'display_name');
  }

  function changesFor(data, lang) {
    const set = new Set(data.hack_changes || []);
    return F.HACK_CHANGES.filter((c) => set.has(c.key)).map((c) => c[lang]);
  }

  // ---------- Nachweis-Block (für beide Sprachen gleich aufgebaut) ----------
  function evidence(data, lang) {
    const en = lang === 'en';
    const t = en ? toEnglish : (x) => x;
    const L = en
      ? { id: 'Account ID', name: 'Display name (most recent)', orig: 'Original display name', oldNames: 'Previous display names', email: 'Email address before the hack', oldEmails: 'Other email addresses previously on the account', first: 'First name', last: 'Last name', country: 'Country at account creation', created: 'Account created (approx.)', linked: 'Linked accounts', invoices: 'Invoice IDs (Epic receipts)', payment: 'Payment method used', firstPay: 'First purchase (approx. date)', firstAmt: 'Amount of the first purchase', phone: 'Phone number used for 2FA', recovery: 'Account Recovery ID', ticket: 'Support case / ticket number' }
      : { id: 'Konto-ID', name: 'Anzeigename (zuletzt benutzt)', orig: 'Erster Anzeigename', oldNames: 'Frühere Anzeigenamen', email: 'E-Mail-Adresse vor dem Hack', oldEmails: 'Weitere frühere E-Mail-Adressen im Konto', first: 'Vorname', last: 'Nachname', country: 'Land bei der Kontoerstellung', created: 'Konto erstellt (ungefähr)', linked: 'Verknüpfte Konten', invoices: 'Rechnungsnummern (Invoice-ID)', payment: 'Benutzte Zahlungsart', firstPay: 'Erste Zahlung (ungefähres Datum)', firstAmt: 'Betrag der ersten Zahlung', phone: 'Handynummer für die Zwei-Faktor-Anmeldung', recovery: 'Wiederherstellungs-ID (Recovery ID)', ticket: 'Ticket- bzw. Fallnummer' };
    const lines = [];
    bullet(lines, L.id, v(data, 'account_id'));
    bullet(lines, L.name, v(data, 'display_name'));
    bullet(lines, L.orig, v(data, 'display_name_original'));
    bulletList(lines, L.oldNames, list(data, 'display_names_old'));
    bullet(lines, L.email, v(data, 'email_original'));
    bulletList(lines, L.oldEmails, list(data, 'emails_old'));
    bullet(lines, L.first, v(data, 'first_name'));
    bullet(lines, L.last, v(data, 'last_name'));
    bullet(lines, L.country, en ? countryEn(v(data, 'country')) : v(data, 'country'));
    bullet(lines, L.created, t(v(data, 'account_created')));
    bulletList(lines, L.linked, list(data, 'platforms').map(en ? toEnglishParens : t));
    bulletList(lines, L.invoices, list(data, 'invoice_ids'));
    bullet(lines, L.payment, en ? paymentEn(v(data, 'payment_method')) : v(data, 'payment_method'));
    bullet(lines, L.firstPay, t(v(data, 'first_purchase_date')));
    bullet(lines, L.firstAmt, v(data, 'first_purchase_amount'));
    bullet(lines, L.phone, v(data, 'phone'));
    bullet(lines, L.recovery, v(data, 'recovery_id'));
    bullet(lines, L.ticket, v(data, 'ticket_number'));
    return lines;
  }

  // ---------- Texte ----------
  // Satz zur Wiederherstellung: Das Formular ist der einzige Weg zurück ins Konto.
  function recoveryLine(data, lang) {
    const rid = v(data, 'recovery_id');
    if (lang === 'en') {
      return rid
        ? 'I have already submitted an account recovery request through the official form (Recovery ID: ' + rid + ').'
        : 'I am recovering access through the official account recovery form.';
    }
    return rid
      ? 'Die Wiederherstellung habe ich bereits über das offizielle Formular beantragt (Recovery ID: ' + rid + ').'
      : 'Die Wiederherstellung beantrage ich über das offizielle Formular.';
  }

  // Bitten an den Support, passend zu dem, was passiert ist
  function requestsFor(data, lang) {
    const set = new Set(data.hack_changes || []);
    const out = [];
    if (set.has('purchases_made')) out.push(lang === 'en' ? 'Please review the purchases I did not make and refund them if possible.' : 'Bitte prüft die Käufe, die nicht von mir stammen, und erstattet sie, wenn möglich.');
    if (set.has('connections_changed')) out.push(lang === 'en' ? 'Please remove any linked accounts that do not belong to me.' : 'Bitte entfernt verknüpfte Konten, die nicht mir gehören.');
    if (set.has('twofa_changed')) out.push(lang === 'en' ? 'Please remove the two-factor authentication method the attacker added.' : 'Bitte entfernt die Zwei-Faktor-Methode, die der Angreifer eingerichtet hat.');
    if (!out.length) out.push(lang === 'en' ? 'Please check my account and help me undo the changes the attacker made.' : 'Bitte prüft mein Konto und helft mir, die Änderungen des Angreifers rückgängig zu machen.');
    return out;
  }

  function factLines(facts, lang) {
    const out = [];
    if (facts.emailSecured) out.push(lang === 'en' ? 'I have already secured my email account.' : 'Mein E-Mail-Postfach habe ich bereits abgesichert.');
    if (facts.notShared) out.push(lang === 'en' ? 'I have never shared my password with anyone.' : 'Ich habe mein Passwort nie weitergegeben.');
    return out;
  }

  function firstDe(data, facts) {
    const ref = v(data, 'recovery_id') ? 'Recovery ID ' + v(data, 'recovery_id') : (v(data, 'account_id') ? 'Konto-ID ' + v(data, 'account_id') : '');
    const subject = 'Gehacktes Epic-Konto – Änderungen durch einen Angreifer' + (ref ? ' (' + ref + ')' : '');
    const lines = ['Hallo Epic-Games-Support-Team,', ''];
    const when = v(data, 'hack_date');
    lines.push('mein Epic-Games-Konto wurde gehackt' + (when ? ' (bemerkt am ' + when + ')' : '') + '. ' + recoveryLine(data, 'de'));
    lines.push('');
    const changes = changesFor(data, 'de');
    lines.push('Was passiert ist:');
    if (changes.length) changes.forEach((c) => lines.push('- ' + c));
    else lines.push('- Jemand hat sich ohne meine Erlaubnis in mein Konto eingeloggt.');
    if (v(data, 'email_hacker')) lines.push('- Die jetzt eingetragene E-Mail-Adresse ' + v(data, 'email_hacker') + ' gehört nicht mir.');
    lines.push('');
    lines.push(...requestsFor(data, 'de'));
    lines.push('');
    const ev = evidence(data, 'de');
    if (ev.length) {
      lines.push('Meine Angaben als Nachweis, dass das Konto mir gehört:');
      lines.push(...ev);
      lines.push('');
    }
    if (v(data, 'email_new')) {
      lines.push('Bitte schreibt mir an diese E-Mail-Adresse, auf die nur ich Zugriff habe: ' + v(data, 'email_new'));
      lines.push('');
    }
    const fl = factLines(facts, 'de');
    if (fl.length) lines.push(...fl);
    lines.push('Wenn ihr weitere Nachweise braucht, schicke ich sie gerne nach.');
    lines.push('');
    lines.push('Vielen Dank für eure Hilfe!');
    lines.push('');
    lines.push('Viele Grüße');
    const sig = signature(data);
    if (sig) lines.push(sig);
    return { subject, body: lines.join('\n') };
  }

  function firstEn(data, facts) {
    const ref = v(data, 'recovery_id') ? 'Recovery ID ' + v(data, 'recovery_id') : (v(data, 'account_id') ? 'Account ID ' + v(data, 'account_id') : '');
    const subject = 'Compromised Epic account – changes made by an attacker' + (ref ? ' (' + ref + ')' : '');
    const lines = ['Hello Epic Games Support,', ''];
    const when = toEnglish(v(data, 'hack_date'));
    lines.push('My Epic Games account has been compromised' + (when ? ' (noticed on ' + when + ')' : '') + '. ' + recoveryLine(data, 'en'));
    lines.push('');
    const changes = changesFor(data, 'en');
    lines.push('What happened:');
    if (changes.length) changes.forEach((c) => lines.push('- ' + c));
    else lines.push('- Someone signed in to my account without my permission.');
    if (v(data, 'email_hacker')) lines.push('- The email address now on the account, ' + v(data, 'email_hacker') + ', does not belong to me.');
    lines.push('');
    lines.push(...requestsFor(data, 'en'));
    lines.push('');
    const ev = evidence(data, 'en');
    if (ev.length) {
      lines.push('Account details to verify that I am the owner:');
      lines.push(...ev);
      lines.push('');
    }
    if (v(data, 'email_new')) {
      lines.push('Please contact me at this email address, which only I have access to: ' + v(data, 'email_new'));
      lines.push('');
    }
    const fl = factLines(facts, 'en');
    if (fl.length) lines.push(...fl);
    lines.push('If you need any further proof, I am happy to provide it.');
    lines.push('');
    lines.push('Thank you very much for your help!');
    lines.push('');
    lines.push('Best regards');
    const sig = signature(data);
    if (sig) lines.push(sig);
    return { subject, body: lines.join('\n') };
  }

  function followupDe(data) {
    const ref = v(data, 'ticket_number') || v(data, 'recovery_id');
    const subject = 'Nachfrage zur Wiederherstellung meines gehackten Kontos' + (ref ? ' (' + ref + ')' : '');
    const lines = ['Hallo Epic-Games-Support-Team,', ''];
    lines.push('ich melde mich wegen meiner Anfrage zur Wiederherstellung meines gehackten Epic-Kontos.');
    lines.push('');
    const ref1 = [];
    bullet(ref1, 'Ticket- bzw. Fallnummer', v(data, 'ticket_number'));
    bullet(ref1, 'Wiederherstellungs-ID (Recovery ID)', v(data, 'recovery_id'));
    bullet(ref1, 'Konto-ID', v(data, 'account_id'));
    bullet(ref1, 'Anzeigename', v(data, 'display_name'));
    bullet(ref1, 'Meine neue sichere E-Mail-Adresse', v(data, 'email_new'));
    if (ref1.length) {
      lines.push('Meine Angaben:');
      lines.push(...ref1);
      lines.push('');
    }
    lines.push('Gibt es schon einen neuen Stand? Falls ihr noch Nachweise braucht, hier sind weitere Angaben:');
    const more = [];
    bulletList(more, 'Rechnungsnummern (Invoice-ID)', list(data, 'invoice_ids'));
    bulletList(more, 'Verknüpfte Konten', list(data, 'platforms'));
    bullet(more, 'E-Mail-Adresse vor dem Hack', v(data, 'email_original'));
    bulletList(more, 'Frühere Anzeigenamen', list(data, 'display_names_old'));
    if (more.length) lines.push(...more);
    else lines.push('- (Bitte sagt mir, welche Angaben euch noch fehlen.)');
    lines.push('');
    lines.push('Vielen Dank!');
    lines.push('');
    lines.push('Viele Grüße');
    const sig = signature(data);
    if (sig) lines.push(sig);
    return { subject, body: lines.join('\n') };
  }

  function followupEn(data) {
    const ref = v(data, 'ticket_number') || v(data, 'recovery_id');
    const subject = 'Follow-up on the recovery of my compromised account' + (ref ? ' (' + ref + ')' : '');
    const lines = ['Hello Epic Games Support,', ''];
    lines.push('I am following up on my request to recover my compromised Epic account.');
    lines.push('');
    const ref1 = [];
    bullet(ref1, 'Support case / ticket number', v(data, 'ticket_number'));
    bullet(ref1, 'Account Recovery ID', v(data, 'recovery_id'));
    bullet(ref1, 'Account ID', v(data, 'account_id'));
    bullet(ref1, 'Display name', v(data, 'display_name'));
    bullet(ref1, 'My new secure email address', v(data, 'email_new'));
    if (ref1.length) {
      lines.push('My details:');
      lines.push(...ref1);
      lines.push('');
    }
    lines.push('Is there any update? If you need more proof, here are additional details:');
    const more = [];
    bulletList(more, 'Invoice IDs (Epic receipts)', list(data, 'invoice_ids').map(toEnglish));
    bulletList(more, 'Linked accounts', list(data, 'platforms').map(toEnglishParens));
    bullet(more, 'Email address before the hack', v(data, 'email_original'));
    bulletList(more, 'Previous display names', list(data, 'display_names_old'));
    if (more.length) lines.push(...more);
    else lines.push('- (Please let me know which details you still need.)');
    lines.push('');
    lines.push('Thank you!');
    lines.push('');
    lines.push('Best regards');
    const sig = signature(data);
    if (sig) lines.push(sig);
    return { subject, body: lines.join('\n') };
  }

  function shortDe(data) {
    const parts = ['Hallo, mein Epic-Konto wurde gehackt' + (v(data, 'hack_date') ? ' (am ' + v(data, 'hack_date') + ')' : '') + '. ' + recoveryLine(data, 'de')];
    const changes = changesFor(data, 'de');
    if (changes.length) parts.push(changes.join(' '));
    const facts = [];
    if (v(data, 'account_id')) facts.push('Konto-ID: ' + v(data, 'account_id'));
    if (v(data, 'display_name')) facts.push('Anzeigename: ' + v(data, 'display_name'));
    if (v(data, 'email_original')) facts.push('E-Mail vor dem Hack: ' + v(data, 'email_original'));
    if (list(data, 'invoice_ids').length) facts.push('Rechnungsnummer: ' + list(data, 'invoice_ids').slice(0, 3).join(', '));
    if (facts.length) parts.push(facts.join(' | '));
    parts.push(requestsFor(data, 'de').join(' ') + (v(data, 'email_new') ? ' Bitte schreibt mir an ' + v(data, 'email_new') + '.' : '') + ' Danke!');
    return { subject: 'Gehacktes Epic-Konto', body: parts.join('\n') };
  }

  function shortEn(data) {
    const when = toEnglish(v(data, 'hack_date'));
    const parts = ['Hello, my Epic account was compromised' + (when ? ' (on ' + when + ')' : '') + '. ' + recoveryLine(data, 'en')];
    const changes = changesFor(data, 'en');
    if (changes.length) parts.push(changes.join(' '));
    const facts = [];
    if (v(data, 'account_id')) facts.push('Account ID: ' + v(data, 'account_id'));
    if (v(data, 'display_name')) facts.push('Display name: ' + v(data, 'display_name'));
    if (v(data, 'email_original')) facts.push('Email before the hack: ' + v(data, 'email_original'));
    if (list(data, 'invoice_ids').length) facts.push('Invoice ID: ' + list(data, 'invoice_ids').slice(0, 3).join(', '));
    if (facts.length) parts.push(facts.join(' | '));
    parts.push(requestsFor(data, 'en').join(' ') + (v(data, 'email_new') ? ' Please contact me at ' + v(data, 'email_new') + '.' : '') + ' Thank you!');
    return { subject: 'Compromised Epic account', body: parts.join('\n') };
  }

  const BUILDERS = {
    first: { de: firstDe, en: firstEn },
    followup: { de: followupDe, en: followupEn },
    short: { de: shortDe, en: shortEn },
  };

  // Liefert { subject, body, missing } – missing sind die Schlüssel wichtiger fehlender Angaben.
  // facts: { emailSecured, notShared } – Aussagen, die nur rein dürfen, wenn sie stimmen.
  function build(data, { lang = 'de', variant = 'first', facts = {} } = {}) {
    const d = data || F.emptyData();
    const builder = (BUILDERS[variant] || BUILDERS.first)[lang === 'en' ? 'en' : 'de'];
    const out = builder(d, facts || {});
    let missing = (IMPORTANT[variant] || IMPORTANT.first).filter((k) => !F.hasValue(d, k));
    // Bei der Nachfrage reicht eine der beiden Nummern.
    if (variant === 'followup' && (F.hasValue(d, 'ticket_number') || F.hasValue(d, 'recovery_id'))) {
      missing = missing.filter((k) => k !== 'ticket_number' && k !== 'recovery_id');
    }
    return { subject: out.subject, body: out.body, missing };
  }

  return { VARIANTS, IMPORTANT, build, toEnglish };
});
