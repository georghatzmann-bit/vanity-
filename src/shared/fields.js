// Alle Daten, die der Konto-Retter über dein Konto sammelt ("Meine Daten").
// Wird im Hauptprozess (Node) und in der Oberfläche (Browser) benutzt.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KR_FIELDS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GROUPS = [
    { key: 'konto', title: 'Dein Epic-Konto', hint: 'Damit findet Epic dein Konto und sieht, dass es dir gehört.' },
    { key: 'email', title: 'E-Mail-Adressen', hint: 'Welche Adressen im Konto waren und welche neue Adresse du jetzt benutzt.' },
    { key: 'person', title: 'Persönliche Angaben', hint: 'So, wie sie im Epic-Konto eingetragen waren.' },
    { key: 'kaeufe', title: 'Käufe und Zahlung', hint: 'Rechnungsnummern sind der stärkste Beweis, dass das Konto dir gehört.' },
    { key: 'hack', title: 'Hack und Support', hint: 'Was passiert ist und welche Nummern Epic dir geschickt hat.' },
  ];

  // type: 'text' = eine Zeile, 'list' = mehrere Einträge (je eine Zeile), 'multiline' = freier Text
  const FIELDS = [
    {
      key: 'account_id', label: 'Epic-Konto-ID', type: 'text', group: 'konto', important: true, mono: true,
      hint: '32 Zeichen aus Ziffern und Buchstaben a bis f. Steht in der Konto-PDF oder auf epicgames.com unter Konto > Kontoinformationen.',
      placeholder: 'z. B. 0123456789abcdef0123456789abcdef',
    },
    {
      key: 'display_name', label: 'Anzeigename (zuletzt benutzt)', type: 'text', group: 'konto', important: true,
      hint: 'Dein Name in Fortnite und im Epic Games Launcher, wie er vor dem Hack war.',
      placeholder: 'z. B. GeorgZockt',
    },
    {
      key: 'display_name_original', label: 'Erster Anzeigename', type: 'text', group: 'konto',
      hint: 'Der Name, den du bei der Kontoerstellung gewählt hast. Wenn du ihn nie geändert hast: leer lassen.',
      placeholder: 'z. B. Georg2018',
    },
    {
      key: 'display_names_old', label: 'Weitere frühere Anzeigenamen', type: 'list', group: 'konto',
      hint: 'Jeder Name, den du sonst noch hattest. Ein Name pro Zeile.',
      placeholder: 'Ein Name pro Zeile',
    },
    {
      key: 'account_created', label: 'Konto erstellt am (ungefähr)', type: 'text', group: 'konto',
      hint: 'Ein ungefähres Datum reicht, z. B. "Sommer 2018".',
      placeholder: 'z. B. 15.07.2018',
    },
    {
      key: 'platforms', label: 'Verknüpfte Konten (Konsolen und Co.)', type: 'list', group: 'konto', important: true,
      hint: 'Pro Zeile ein Konto: Plattform, Name oder Gamertag, ungefähr seit wann. Zum Beispiel "PlayStation: GeorgPSN (seit 2019)".',
      placeholder: 'z. B. Nintendo: Georg (seit 2020)',
    },
    {
      key: 'email_original', label: 'Deine E-Mail-Adresse vor dem Hack', type: 'text', group: 'email', important: true, mono: true,
      hint: 'Die Adresse, die vor dem Hack im Epic-Konto eingetragen war.',
      placeholder: 'z. B. name@beispiel.de',
    },
    {
      key: 'emails_old', label: 'Weitere E-Mail-Adressen, die mal im Konto waren', type: 'list', group: 'email', mono: true,
      hint: 'Falls du die Adresse früher mal gewechselt hast. Eine Adresse pro Zeile.',
      placeholder: 'Eine Adresse pro Zeile',
    },
    {
      key: 'email_new', label: 'Neue sichere E-Mail-Adresse', type: 'text', group: 'email', important: true, mono: true,
      hint: 'Eine Adresse, auf die nur du Zugriff hast und die noch mit keinem anderen Epic-Konto verbunden ist (auch nicht mit einem Zweitkonto oder dem Konto von Geschwistern). An diese Adresse schickt Epic die Antwort.',
      placeholder: 'z. B. neu-und-sicher@beispiel.de',
    },
    {
      key: 'email_hacker', label: 'E-Mail-Adresse des Hackers (falls bekannt)', type: 'text', group: 'email', mono: true,
      hint: 'Steht oft in der Epic-Mail "Deine E-Mail-Adresse wurde geändert".',
      placeholder: 'z. B. fremde-adresse@beispiel.com',
    },
    {
      key: 'first_name', label: 'Vorname', type: 'text', group: 'person',
      hint: 'Wie im Epic-Konto eingetragen.',
      placeholder: 'z. B. Max',
    },
    {
      key: 'last_name', label: 'Nachname', type: 'text', group: 'person',
      hint: 'Wie im Epic-Konto eingetragen.',
      placeholder: 'z. B. Mustermann',
    },
    {
      key: 'country', label: 'Land bei der Kontoerstellung', type: 'text', group: 'person',
      hint: 'Das Land, das du beim Erstellen des Kontos angegeben hast.',
      placeholder: 'z. B. Deutschland',
    },
    {
      key: 'phone', label: 'Handynummer (falls für SMS-Codes eingetragen)', type: 'text', group: 'person', mono: true,
      hint: 'Nur ausfüllen, wenn du im Epic-Konto SMS-Codes eingerichtet hattest.',
      placeholder: 'z. B. +49 151 23456789',
    },
    {
      key: 'invoice_ids', label: 'Rechnungsnummern (Invoice-ID)', type: 'list', group: 'kaeufe', important: true, mono: true,
      hint: 'Beginnen mit A (Kauf) oder F (Gratis-Spiel), danach 8 bis 9 Ziffern. Stehen in der Mail "Your Epic Games Receipt". Eine pro Zeile.',
      placeholder: 'z. B. A123456789',
    },
    {
      key: 'payment_method', label: 'Zahlungsart bei Epic-Käufen', type: 'text', group: 'kaeufe',
      hint: 'Zum Beispiel "PayPal (name@beispiel.de)" oder "Visa, endet auf 1234". Nie die ganze Kartennummer eintragen.',
      placeholder: 'z. B. Visa, endet auf 1234',
    },
    {
      key: 'hack_date', label: 'Wann wurde das Konto gehackt?', type: 'text', group: 'hack', important: true,
      hint: 'Datum und ungefähre Uhrzeit, ab wann du nicht mehr reinkamst oder komische Mails bekommen hast.',
      placeholder: 'z. B. 02.10.2026 gegen 21 Uhr',
    },
    {
      key: 'recovery_id', label: 'Wiederherstellungs-ID (Recovery ID)', type: 'text', group: 'hack', important: true, mono: true,
      hint: 'Kommt per Mail an deine neue Adresse, nachdem du das Wiederherstellungsformular abgeschickt hast. Beginnt mit "AR".',
      placeholder: 'z. B. AR0A1B2C3D4E5F6G7H8J',
    },
    {
      key: 'ticket_number', label: 'Ticket- oder Fallnummer vom Epic-Support', type: 'text', group: 'hack', mono: true,
      hint: 'Bekommst du per Mail, wenn du den Support angeschrieben hast. Bei jeder Nachfrage angeben.',
      placeholder: 'z. B. 12345678',
    },
    {
      key: 'ip_addresses', label: 'IP-Adressen (falls bekannt)', type: 'list', group: 'hack', mono: true,
      hint: 'Stehen manchmal in der Konto-PDF oder in Epic-Mails über neue Anmeldungen. Nicht nötig, aber hilfreich.',
      placeholder: 'Eine Adresse pro Zeile',
    },
    {
      key: 'notes', label: 'Eigene Notizen', type: 'multiline', group: 'hack',
      hint: 'Alles, was dir sonst noch einfällt. Wird nicht automatisch in den Support-Text übernommen.',
      placeholder: 'Freier Text',
    },
  ];

  // Was der Hacker verändert hat. Wird im Support-Text als Liste verwendet.
  const HACK_CHANGES = [
    { key: 'email_changed', label: 'E-Mail-Adresse wurde geändert', de: 'Die E-Mail-Adresse des Kontos wurde ohne meine Erlaubnis geändert.', en: 'The email address on the account was changed without my permission.' },
    { key: 'password_changed', label: 'Passwort wurde geändert', de: 'Das Passwort wurde geändert. Ich komme nicht mehr in mein Konto.', en: 'The password was changed and I can no longer sign in.' },
    { key: 'twofa_changed', label: 'Zwei-Faktor-Schutz vom Hacker eingerichtet', de: 'Die Zwei-Faktor-Authentifizierung wurde vom Angreifer eingerichtet oder geändert.', en: 'Two-factor authentication was set up or changed by the attacker.' },
    { key: 'name_changed', label: 'Anzeigename wurde geändert', de: 'Der Anzeigename wurde geändert.', en: 'The display name was changed.' },
    { key: 'purchases_made', label: 'Fremde Käufe', de: 'Es wurden Käufe getätigt, die ich nicht gemacht habe.', en: 'Purchases were made that I did not make.' },
    { key: 'items_missing', label: 'V-Bucks oder Gegenstände fehlen', de: 'V-Bucks oder Gegenstände fehlen.', en: 'V-Bucks or items are missing.' },
    { key: 'connections_changed', label: 'Verknüpfte Konten geändert', de: 'Verknüpfte Konten (z. B. PlayStation, Xbox, Nintendo) wurden getrennt oder fremde Konten verknüpft.', en: 'Linked accounts (e.g. PlayStation, Xbox, Nintendo) were unlinked or unknown accounts were linked.' },
  ];

  function emptyData() {
    const data = {};
    for (const f of FIELDS) data[f.key] = f.type === 'list' ? [] : '';
    data.hack_changes = [];
    return data;
  }

  function byKey(key) {
    return FIELDS.find((f) => f.key === key) || null;
  }

  function listValue(data, key) {
    const v = data ? data[key] : null;
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return [];
  }

  // Liefert den Wert eines Feldes immer als Text (Listen zeilenweise).
  function valueAsText(data, key) {
    const v = data ? data[key] : '';
    if (Array.isArray(v)) return listValue(data, key).join('\n');
    return v == null ? '' : String(v).trim();
  }

  function hasValue(data, key) {
    return valueAsText(data, key).length > 0;
  }

  function fullName(data) {
    return [valueAsText(data, 'first_name'), valueAsText(data, 'last_name')].filter(Boolean).join(' ');
  }

  return { GROUPS, FIELDS, HACK_CHANGES, emptyData, byKey, listValue, valueAsText, hasValue, fullName };
});
