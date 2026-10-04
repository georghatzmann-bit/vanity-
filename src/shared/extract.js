// Erkennt Kontodaten im Text einer PDF (oder einer Text-/Mail-Datei).
// Unterstützt: Epic-Kontodaten-Download, Epic-Kaufbelege, als PDF gespeicherte Epic-Kontoseiten,
// Epic-Mails zur Wiederherstellung/zum Support sowie PlayStation-, Nintendo-, Xbox- und PayPal-Belege.
//
// Ergebnis: { kind, kindLabel, items: [...] }
// Jedes item: { key, label, value, target, confidence, auto, info, note }
//   target = Feld in "Meine Daten" (null = nur zur Info)
//   auto   = darf ohne Rückfrage in ein LEERES Feld übernommen werden.
//            Nur wenn Dokumentart UND Fundstelle eindeutig sind – im Zweifel wird nur vorgeschlagen.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KR_EXTRACT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- Text aufbereiten

  function normalize(text) {
    return String(text || '')
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(/[   -   　]/g, ' ')
      .replace(/[­​-‍⁠﻿]/g, '')
      .replace(/[-]/g, '')
      .replace(/：/g, ':');
  }

  // Zeilen, die wichtige Daten enthalten, werden nie als "Kopfzeile" verworfen
  const PROTECTED_LINE = /HISTORY_ACCOUNT_|(?<![A-Za-z0-9])[AF]\d{8,}(?!\d)|(?:\d{1,3}\.){3}\d{1,3}|@/;

  // Kopf- und Fußzeilen vom Browser-Druck: "04.10.26, 14:03   Konto | Epic Games", "Seite 1 von 3", URLs
  const PRINT_NOISE = [
    /^\d{1,2}[./]\d{1,2}[./]\d{2},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\s{2,}\S.*$/i,
    /^(?:Seite|Page)\s+\d+\s*(?:von|of|\/)\s*\d+$/i,
    /^\d+\s*\/\s*\d+$/,
    /^https?:\/\/\S+(?:\s+\d+\s*\/\s*\d+)?$/i,
  ];

  function toLines(text) {
    return normalize(text)
      .split('\n')
      .map((l) => l.replace(/^[ \t]+|[ \t]+$/g, ''))
      .filter((l) => l.length > 0);
  }

  function withoutNoise(lines) {
    return lines.filter((l) => PROTECTED_LINE.test(l) || !PRINT_NOISE.some((re) => re.test(l)));
  }

  const RE_EMAIL_FULL = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}$/;

  // In schmalen Tabellenspalten brechen Werte um:
  //   Datum:  "2026-10-" / "02T19:13:02Z"
  //   E-Mail: "jan-" / "georg.max@gmx.de"  oder  "max@t-" / "online.de"
  // Solche Stücke werden wieder zusammengesetzt.
  function repairWrapped(lines) {
    const out = lines.slice();
    for (let i = 0; i < out.length - 1; i++) {
      const m = /((?:19|20)\d{2}-\d{1,2}-)(?=\s|$)/.exec(out[i]);
      if (m) {
        const n = /^(\d{1,2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)(?=\s|$)/.exec(out[i + 1]);
        if (n) {
          out[i] = out[i].slice(0, m.index) + m[1] + n[1] + out[i].slice(m.index + m[1].length);
          out[i + 1] = out[i + 1].slice(n[0].length).trim();
        }
      }
      const last = /(\S+)$/.exec(out[i]);
      const first = /^(\S+)/.exec(out[i + 1] || '');
      if (last && first && /[-.@]$/.test(last[1])) {
        const joined = last[1] + first[1];
        const lastPart = /[A-Za-z0-9._%+-]*@?[A-Za-z0-9.-]*$/.exec(last[1]);
        const candidate = (lastPart ? lastPart[0] : last[1]) + first[1];
        if (RE_EMAIL_FULL.test(candidate) && (last[1].includes('@') || first[1].includes('@'))) {
          out[i] = out[i].slice(0, out[i].length - last[1].length) + joined;
          out[i + 1] = out[i + 1].slice(first[1].length).trim();
        }
      }
    }
    return out.filter((l) => l.length > 0);
  }

  // Spalten einer Zeile (die PDF-Auslese trennt Tabellenspalten mit mehreren Leerzeichen)
  function columns(line) {
    return line.split(/\s{2,}|\t+|\s\|\s/).map((c) => c.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------- Datumsangaben

  const MONTHS_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MONTHS_DE = { jan: 1, 'jän': 1, feb: 2, 'mär': 3, mae: 3, mar: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dez: 12 };
  const EN_MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const DE_MONTH = '(Januar|Jänner|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Jan|Feb|Mär|Apr|Jun|Jul|Aug|Sept?|Okt|Nov|Dez)';

  // Alle Datumsformate, die parseDate kennt (zum Entfernen aus Tabellenzeilen)
  const DATE_PATTERNS = [
    /(?<!\d)(?:19|20)\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT)?)?(?!\d)/gi,
    /(?<![\d.])\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}(?![\d.])(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*Uhr)?)?/gi,
    new RegExp('\\b' + EN_MONTH + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}(?!\\d)', 'gi'),
    new RegExp('(?<!\\d)\\d{1,2}\\s+' + EN_MONTH + '\\.?,?\\s+(?:19|20)\\d{2}(?!\\d)', 'gi'),
    new RegExp('(?<!\\d)\\d{1,2}\\.?\\s*' + DE_MONTH + '\\.?\\s+(?:19|20)\\d{2}(?!\\d)', 'gi'),
    /(?<![\d/])\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}(?![\d/])(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?(?:\s*(?:UTC|GMT|P[SD]?T))?)?/gi,
  ];

  function stripDates(s) {
    let out = String(s || '');
    for (const re of DATE_PATTERNS) out = out.replace(re, ' ');
    return out.replace(/\s{2,}/g, '   ').trim();
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function validYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1;
  }

  function fmt(y, m, d, time) {
    return pad(d) + '.' + pad(m) + '.' + y + (time ? ', ' + time + ' Uhr' : '');
  }

  // Zeitpunkt in UTC -> deutsche Ortszeit (Sommer-/Winterzeit wird berücksichtigt)
  function berlin(dt) {
    try {
      const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(dt);
      const get = (t) => (parts.find((p) => p.type === t) || {}).value;
      return get('day') + '.' + get('month') + '.' + get('year') + ', ' + get('hour') + ':' + get('minute') + ' Uhr';
    } catch (_) {
      return null; // ohne Zeitzonen-Daten: Aufrufer nimmt die Originalzeit
    }
  }

  // Findet das erste Datum in einem Text und gibt es als "TT.MM.JJJJ[, HH:MM Uhr]" zurück.
  // usHint = true: bei mehrdeutigem 03/04/2026 amerikanisch (Monat zuerst) lesen.
  function parseDate(str, usHint) {
    const s = String(str || '');
    let m;
    // ISO 8601: 2026-10-04T12:00:00Z (UTC/GMT/Versatz -> deutsche Zeit)
    m = /(?<!\d)((?:19|20)\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?)?(?!\d)/i.exec(s);
    if (m) {
      const y = +m[1]; const mo = +m[2]; const d = +m[3];
      if (!validYmd(y, mo, d)) return null;
      if (m[4] && m[7]) {
        const zone = /^(Z|UTC|GMT)$/i.test(m[7]) ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
        const dt = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + zone);
        if (!isNaN(dt)) {
          const local = berlin(dt);
          if (local) return local;
        }
      }
      return fmt(y, mo, d, m[4] ? m[4] + ':' + m[5] : '');
    }
    // Deutsch: 04.10.2026 (optional mit Uhrzeit)
    m = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})(?![\d.])(?:,?\s+(\d{1,2}):(\d{2}))?/.exec(s);
    if (m && validYmd(+m[3], +m[2], +m[1])) return fmt(+m[3], +m[2], +m[1], m[4] ? pad(m[4]) + ':' + m[5] : '');
    // Englisch: October 4, 2026 / Oct 4th 2026
    m = new RegExp('\\b' + EN_MONTH + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})(?!\\d)', 'i').exec(s);
    if (m) {
      const mo = MONTHS_EN[m[1].slice(0, 3).toLowerCase()];
      if (validYmd(+m[3], mo, +m[2])) return fmt(+m[3], mo, +m[2], '');
    }
    // Englisch Tag zuerst: 4 Oct 2026
    m = new RegExp('(?<!\\d)(\\d{1,2})\\s+' + EN_MONTH + '\\.?,?\\s+((?:19|20)\\d{2})(?!\\d)', 'i').exec(s);
    if (m) {
      const mo = MONTHS_EN[m[2].slice(0, 3).toLowerCase()];
      if (validYmd(+m[3], mo, +m[1])) return fmt(+m[3], mo, +m[1], '');
    }
    // Deutsch ausgeschrieben: 4. Oktober 2026
    m = new RegExp('(?<!\\d)(\\d{1,2})\\.?\\s*' + DE_MONTH + '\\.?\\s+((?:19|20)\\d{2})(?!\\d)', 'i').exec(s);
    if (m) {
      const mo = MONTHS_DE[m[2].toLowerCase().slice(0, 3)];
      if (mo && validYmd(+m[3], mo, +m[1])) return fmt(+m[3], mo, +m[1], '');
    }
    // Schrägstrich: 08/07/2020 (mehrdeutig), optional mit Uhrzeit und "UTC"
    m = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})(?![\d/])(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?(?:\s*(UTC|GMT))?)?/i.exec(s);
    if (m) {
      const a = +m[1]; const b = +m[2];
      let d; let mo;
      if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else if (usHint) { mo = a; d = b; } else { d = a; mo = b; }
      if (!validYmd(+m[3], mo, d)) return null;
      let time = '';
      if (m[4]) {
        let h = +m[4];
        if (m[6]) { const pm = /p/i.test(m[6]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
        time = pad(h) + ':' + m[5];
        if (m[7]) {
          const local = berlin(new Date(Date.UTC(+m[3], mo - 1, d, h, +m[5])));
          if (local) return local;
        }
      }
      return fmt(+m[3], mo, d, time);
    }
    return null;
  }

  // "02.10.2026, 21:13 Uhr" -> "202610022113" (zum Sortieren)
  function sortKey(formatted) {
    const m = /(\d{2})\.(\d{2})\.(\d{4})(?:,\s*(\d{2}):(\d{2}))?/.exec(formatted || '');
    return m ? m[3] + m[2] + m[1] + (m[4] || '00') + (m[5] || '00') : '';
  }

  // ---------------------------------------------------------------- Prüf-Regeln für Werte

  const RE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
  const RE_EMAIL_G = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
  const RE_IPV4_G = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g;
  const RE_IPV6_G = /(?<![0-9A-Fa-f:.])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6})(?![0-9A-Fa-f:])/g;
  const RE_ORDER_G = /(?<![A-Za-z0-9])([AF]\d{16})(?!\d)/g;
  const RE_INVOICE_G = /(?<![A-Za-z0-9])([AF]\d{8,10})(?![\dA-Za-z])/g;
  const RE_RECOVERY_AR = /(?<![A-Za-z0-9])AR[A-Za-z0-9]{18}(?![A-Za-z0-9])/;
  const RE_DATE_ONLY = /^(?:(?:19|20)\d{2}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/;

  // Wörter, die selbst Beschriftungen oder Menüpunkte sind und nie als Wert gelten dürfen
  const LABEL_WORDS = /^(?:e-?mail(?:[ -]?adresse)?(?: address)?|display name|anzeigename|first name|last name|vorname|nachname|account id|konto-?id|id|country|land|region|land\/region|country\/region|creation date|last login|account status|status|type|bill to|order id|order date|source|invoice id|phone|telefon|name|password|passwort|ja|nein|yes|no|connected|verbunden|disconnect|trennen|edit|bearbeiten|adresse|address|stadt|city|postleitzahl|postal code|abmelden|sign out|hilfe|help|support|datenschutz|privacy|transaktionen|transactions|einstellungen|settings|konto|account|kontoeinstellungen|account settings|kontoinformationen|account information|passwort und sicherheit|password & security|verbindungen|connections|apps|jugendschutz|parental controls|zahlungsverwaltung|payment management|rücknahme|keine angabe|none)$/i;

  // Füllwörter: kommen sie vor, ist es ein Satz und kein Name
  const SENTENCE_WORDS = /(?:^|\s)(?:und|oder|bitte|deinen?|dein|uns|the|and|or|please|your|you|are|ist|sind|as|they|wie|mit|with|für|for|von|from|an|to|auf|on|in|im|der|die|das|des|dem|ein|eine|grüße|regards|hallo|hello)(?=\s|$|[.,!?])/i;

  const SYSTEM_EMAIL_DOMAINS = /(?:^|\.)(?:epicgames\.com|unrealengine\.com|fortnite\.com|playstation\.com|sony\.com|sonyentertainmentnetwork\.com|nintendo\.(?:com|net|de|eu|co\.uk)|microsoft\.com|xbox\.com|paypal\.[a-z.]+|apple\.com|google\.com|steampowered\.com)$/i;

  function isLabelText(s) {
    return LABEL_WORDS.test(String(s).trim().replace(/[:：#]+$/, '').trim());
  }

  const V = {
    accountId: (s) => {
      // Stücke wie "94b15695 06b04f9f ..." zusammensetzen
      const joined = String(s).trim().replace(/^([0-9a-f]{2,})(\s+[0-9a-f]{2,})+$/i, (m) => m.replace(/\s+/g, ''));
      return RE_ACCOUNT_ID.test(joined) ? joined.toLowerCase() : null;
    },
    displayName: (s) => {
      const t = s.trim();
      if (t.length < 3 || t.length > 16 || isLabelText(t)) return null;
      if (!/^[\p{L}\p{N}_]/u.test(t)) return null; // nicht mit "-" oder "." anfangen (Aufzählung)
      return /^[\p{L}\p{N}_.\- ]+$/u.test(t) ? t : null;
    },
    personName: (s) => {
      const t = s.trim();
      if (!t || t.length > 40 || isLabelText(t)) return null;
      if (t.split(/\s+/).length > 3 || /[.!?,:;]$/.test(t) || SENTENCE_WORDS.test(t)) return null;
      return /^[\p{L}][\p{L}'’ .\-]*$/u.test(t) ? t : null;
    },
    email: (s) => {
      const m = RE_EMAIL_FULL.exec(s.trim());
      return m ? m[0].toLowerCase() : null;
    },
    date: (s, usHint) => parseDate(s, usHint),
    country: (s) => countryName(s),
    code: (s) => {
      const t = s.trim().replace(/^#\s*/, '');
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{4,40}$/.test(t) || !/\d/.test(t) || isLabelText(t)) return null;
      if (RE_DATE_ONLY.test(t) || /^[AF]\d{8,}$/.test(t)) return null; // Datum, Bestell- oder Rechnungsnummer
      return t;
    },
    phone: (s) => {
      const t = s.trim();
      if (!/^[+0(][\d\s()./*•xX-]{5,24}\d$/.test(t)) return null;
      if (RE_DATE_ONLY.test(t) || (t.match(/\d/g) || []).length < 7) return null;
      return t;
    },
  };

  // ---------------------------------------------------------------- Länder

  const COUNTRY_CODES = {
    DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', LI: 'Liechtenstein', LU: 'Luxemburg', NL: 'Niederlande', BE: 'Belgien',
    FR: 'Frankreich', IT: 'Italien', ES: 'Spanien', PT: 'Portugal', PL: 'Polen', CZ: 'Tschechien', DK: 'Dänemark', SE: 'Schweden',
    NO: 'Norwegen', FI: 'Finnland', GB: 'Vereinigtes Königreich', UK: 'Vereinigtes Königreich', IE: 'Irland', US: 'USA', CA: 'Kanada',
    TR: 'Türkei', HU: 'Ungarn', HR: 'Kroatien', RO: 'Rumänien', GR: 'Griechenland', SK: 'Slowakei', SI: 'Slowenien', RS: 'Serbien',
    BA: 'Bosnien und Herzegowina', BG: 'Bulgarien', UA: 'Ukraine', RU: 'Russland', AU: 'Australien', BR: 'Brasilien', MX: 'Mexiko',
  };
  const COUNTRY_NAMES_EN = {
    germany: 'Deutschland', austria: 'Österreich', switzerland: 'Schweiz', netherlands: 'Niederlande', belgium: 'Belgien', france: 'Frankreich',
    italy: 'Italien', spain: 'Spanien', poland: 'Polen', 'united kingdom': 'Vereinigtes Königreich', 'united states': 'USA', turkey: 'Türkei',
    luxembourg: 'Luxemburg', denmark: 'Dänemark', sweden: 'Schweden', norway: 'Norwegen', ireland: 'Irland', 'czech republic': 'Tschechien',
  };
  const COUNTRY_NAMES_DE = new Set(Object.values(COUNTRY_CODES).map((n) => n.toLowerCase()));

  function countryName(s) {
    const t = String(s || '').trim();
    if (/^[A-Z]{2}$/.test(t)) return COUNTRY_CODES[t] || null;
    const low = t.toLowerCase();
    if (COUNTRY_NAMES_EN[low]) return COUNTRY_NAMES_EN[low];
    if (COUNTRY_NAMES_DE.has(low)) return Object.values(COUNTRY_CODES).find((n) => n.toLowerCase() === low);
    return null;
  }

  // ---------------------------------------------------------------- Bezeichnung -> Wert

  // Sucht eine Beschriftung, die als eigene Zelle dasteht (Zeilen- oder Spaltenanfang),
  // und liefert den Wert dazu. Gesucht wird in dieser Reihenfolge:
  //   1. in derselben Zelle hinter der Beschriftung ("Vorname: Max")
  //   2. in der nächsten Spalte derselben Zeile ("Display Name   GeorgZockt")
  //   3. in der GLEICHEN Spalte der nächsten Zeile (Formulare mit Beschriftung über dem Wert)
  // Steht in Fall 1 schon Text hinter der Beschriftung, der nicht passt, wird nicht weitergesucht –
  // so werden Satzteile nie zu Werten.
  // Ergebnis: { value, line, where: 'same' | 'next-col' | 'below' }
  function findLabeled(lines, labelRe, validate, opts) {
    opts = opts || {};
    const re = new RegExp('^(?:' + labelRe.source + ')(?=$|[\\s:：#])[\\s:：#]*', labelRe.flags.replace('g', ''));
    for (let i = 0; i < lines.length; i++) {
      const cols = columns(lines[i]);
      for (let k = 0; k < cols.length; k++) {
        const m = re.exec(cols[k]);
        if (!m) continue;
        if (opts.exclude && opts.exclude.test(cols[k])) continue;
        if (opts.skipLine && opts.skipLine.test(lines[i])) continue;
        const rest = cols[k].slice(m[0].length).trim();
        if (rest) {
          const v = validate(rest);
          if (v) return { value: v, line: i, where: 'same' };
          continue;
        }
        if (k + 1 < cols.length) {
          const v = validate(cols[k + 1]);
          if (v) return { value: v, line: i, where: 'next-col' };
          // Nebenan steht etwas anderes (z. B. die nächste Beschriftung): Wert kann darunter stehen
        }
        if (opts.noBelow) continue;
        const next = lines[i + 1];
        if (!next || (opts.skipLine && opts.skipLine.test(next))) continue;
        const ncols = columns(next);
        // Gleiche Spalte; hat die nächste Zeile weniger Spalten, nur bei Beschriftung ganz links
        const cand = ncols.length > k ? ncols[k] : (k === 0 && ncols.length === 1 ? ncols[0] : null);
        if (cand) {
          const v = validate(cand);
          if (v) return { value: v, line: i, where: 'below' };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- Dokumentart erkennen

  const KINDS = {
    'account-export': 'Epic-Kontodaten (Download aus den Kontoeinstellungen)',
    'epic-receipt': 'Epic-Kaufbeleg',
    'account-page': 'Epic-Kontoseite (als PDF gespeichert)',
    'recovery-mail': 'Epic-Mail zur Kontowiederherstellung',
    'support-mail': 'Mail vom Epic-Support',
    'psn-receipt': 'PlayStation-Kaufbeleg',
    'nintendo-receipt': 'Nintendo-eShop-Beleg',
    'xbox-receipt': 'Microsoft/Xbox-Bestellung',
    paypal: 'PayPal-Beleg',
    unknown: 'Dokument',
  };

  function detectKind(text) {
    const t = text;
    if (/HISTORY_ACCOUNT_|^External\s+Auths?\b|Third\s+Party\s+App\s+Consents|^Payment\s+Profiles\b/im.test(t)) return 'account-export';
    // Mails zur Wiederherstellung vor den Belegen prüfen: sie erwähnen oft "Rechnungsnummern"
    if (/Recovery\s+(?:Request\s+)?ID|account\s+recovery\s+request|Wiederherstellungs-?ID|Anfrage\s+zur\s+Account-Wiederherstellung/i.test(t) || RE_RECOVERY_AR.test(t)) return 'recovery-mail';
    // Kaufbeleg nur an seinem Aufbau erkennen, nicht an einzelnen Wörtern
    const receiptHeading = /^(?:INVOICE\s*ID|RECHNUNGSNUMMER)\s*:?\s*(?:[AF]\d{8,10})?\s*$/im.test(t) && RE_INVOICE_G.test(t);
    RE_INVOICE_G.lastIndex = 0;
    if (receiptHeading || /HERE'S\s+WHAT\s+YOU\s+ORDERED|DAS\s+HAST\s+DU\s+BESTELLT|Your\s+Epic\s+Games\s+Receipt|Dein\s+Epic\s+Games-Beleg/i.test(t)) return 'epic-receipt';
    if (/epicgames\.com\/account|^(?:Account\s+Settings|Kontoeinstellungen|Kontoinformationen|Account\s+Information|Password\s*&\s*Security|Passwort\s+und\s+Sicherheit)\b/im.test(t)) return 'account-page';
    if (/Player\s+Support|Spieler-?Support|@support\.epicgames\.com|Case\s*(?:Number|#)|Fallnummer|Ticketnummer/i.test(t)) return 'support-mail';
    if (/Thank\s+You\s+For\s+Your\s+Purchase|^Online[\s-]ID\b|PlayStation\s*Store|txn-email\.playstation\.com/im.test(t)) return 'psn-receipt';
    if (/Nintendo\s+eShop|Nintendo\s+of\s+Europe|accounts\.nintendo\.com/i.test(t)) return 'nintendo-receipt';
    if (/Microsoft[-\s](?:order|Bestellung)/i.test(t)) return 'xbox-receipt';
    if (/PayPal/i.test(t)) return 'paypal';
    return 'unknown';
  }

  const EPIC_KINDS = new Set(['account-export', 'epic-receipt', 'account-page', 'recovery-mail', 'support-mail']);

  // ---------------------------------------------------------------- Plattformen

  const PLATFORM_TYPES = {
    psn: 'PlayStation', xbl: 'Xbox', nintendo: 'Nintendo', steam: 'Steam', twitch: 'Twitch', github: 'GitHub', google: 'Google',
    apple: 'Apple', facebook: 'Facebook', lego: 'LEGO', vk: 'VK', ubisoft: 'Ubisoft', discord: 'Discord',
  };
  const PLATFORM_RE = new RegExp('^(' + Object.keys(PLATFORM_TYPES).join('|') + ')(?=\\s|$)', 'i');
  const LOOKS_LIKE_EXTERNAL_ID = /^(?:[0-9a-f]{8,}|\d{6,})$/i;

  // Liest die Tabelle "External Auths" aus dem Epic-Kontodaten-Download
  function externalAuths(lines) {
    const out = [];
    let inSection = false;
    let started = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^External\s+Auths?\b/i.test(line)) { inSection = true; started = false; continue; }
      if (!inSection) continue;
      if (/^Type\b/i.test(line) && /External/i.test(line)) continue; // Tabellenkopf

      // Format B: "Type: psn" gefolgt von weiteren Beschriftungen
      const tm = /^Type\s*:\s*(\w+)/i.exec(line);
      if (tm && PLATFORM_TYPES[tm[1].toLowerCase()]) {
        const entry = { type: tm[1].toLowerCase(), name: '', date: null };
        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
          const l = lines[j];
          if (/^Type\b/i.test(l)) break;
          const dn = /External\s+Display\s+Name\s*:?\s*(.+)$/i.exec(l);
          if (dn) entry.name = dn[1].trim();
          const ad = /Added\s+Date\s*:?\s*(.+)$/i.exec(l);
          if (ad) entry.date = parseDate(ad[1], true);
        }
        out.push(entry);
        started = true;
        continue;
      }

      // Format A: eine Tabellenzeile "psn   1234567   Name   2021-08-05T..."
      const pm = PLATFORM_RE.exec(line);
      if (!pm) {
        // Erste fremde Zeile nach Beginn der Tabelle = nächster Abschnitt
        if (started || out.length) inSection = false;
        else if (!/^(?:Type|None|Keine)\b/i.test(line)) inSection = false;
        continue;
      }
      started = true;
      const type = pm[1].toLowerCase();
      const rest = line.slice(pm[0].length);
      const date = parseDate(rest, true);
      const cleaned = stripDates(rest);
      let parts = columns(cleaned);
      if (parts.length <= 1) parts = cleaned.split(/\s+/).filter(Boolean);
      // Die ID-Spalte am Inhalt erkennen (lange Zahl oder Hex), nicht an der Position
      if (parts.length > 1 && LOOKS_LIKE_EXTERNAL_ID.test(parts[0])) parts = parts.slice(1);
      else if (parts.length === 1 && LOOKS_LIKE_EXTERNAL_ID.test(parts[0])) parts = [];
      out.push({ type, name: parts.join(' ').trim(), date });
    }
    return out;
  }

  function platformLine(p) {
    const name = PLATFORM_TYPES[p.type] || p.type;
    return name + (p.name ? ': ' + p.name : '') + (p.date ? ' (verknüpft seit ' + p.date.replace(/,.*$/, '') + ')' : '');
  }

  // ---------------------------------------------------------------- Kontoverlauf

  const HISTORY_LABELS = [
    [/EMAIL_UPDATED|EMAIL_CHANGED/, 'E-Mail-Adresse geändert'],
    [/EMAIL_CONFIRM/, 'E-Mail-Adresse bestätigt'],
    [/ALTERNATE_EMAIL/, 'Zweite E-Mail-Adresse hinzugefügt'],
    [/PASSWORD/, 'Passwort geändert'],
    [/DISPLAY_?NAME/, 'Anzeigename geändert'],
    [/DECLINED_MFA/, 'Zwei-Faktor-Einrichtung abgelehnt'],
    [/MFA|TFA|TWO_FACTOR/, 'Zwei-Faktor-Schutz geändert'],
    [/CHALLENGE_CREATED/, 'Sicherheitscode angefordert'],
    [/CHALLENGE_EXECUTED/, 'Sicherheitscode benutzt'],
    [/REVIEWED_SECURITY/, 'Sicherheitseinstellungen angesehen'],
    [/RECOVERY/, 'Konto wiederhergestellt'],
    [/LINK|EXTERNAL_AUTH/, 'Verknüpftes Konto geändert'],
  ];

  function historyLabel(code) {
    for (const [re, label] of HISTORY_LABELS) if (re.test(code)) return label;
    return code.replace(/^HISTORY_ACCOUNT_/, '').replace(/_/g, ' ').toLowerCase();
  }

  function accountHistory(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /\bHISTORY_ACCOUNT_[A-Z_]+\b/.exec(lines[i]);
      if (!m) continue;
      // Datum und IP stehen in derselben Tabellenzeile, manchmal auch in der nächsten
      const ctx = lines[i] + ' ' + (lines[i + 1] && !/HISTORY_ACCOUNT_/.test(lines[i + 1]) ? lines[i + 1] : '');
      const date = parseDate(ctx.replace(m[0], ''), true);
      const ips = (ctx.match(RE_IPV4_G) || []).concat(ctx.match(RE_IPV6_G) || []);
      out.push({ code: m[0], label: historyLabel(m[0]), date, ip: ips[0] || '' });
    }
    return out;
  }

  // ---------------------------------------------------------------- Zahlungsart

  function paymentMethod(text) {
    const kw = /\b(PayPal|Visa|Master[Cc]ard|American\s+Express|Amex|Maestro|Apple\s+Pay|Google\s+Pay|Amazon\s+Pay|paysafecard|Klarna|Sofort(?:überweisung)?|giropay|iDEAL|Bancontact|Skrill)\b/i.exec(text);
    // Begrenzte Wiederholungen, damit präparierte Texte (z. B. tausende Sternchen) nichts einfrieren
    const last4 = /(?:ending\s{1,3}(?:in|with)|endet\s{1,3}(?:auf|mit)|Endziffern|[*•xX]{2}[*•xX \t-]{0,24})[ \t]{0,3}:?[ \t]{0,3}(\d{4})(?!\d)/i.exec(text);
    if (!kw && !last4) return null;
    let name = kw ? kw[1] : 'Karte';
    if (/^paysafecard$/i.test(name)) name = 'paysafecard';
    else if (/^mastercard$/i.test(name)) name = 'Mastercard';
    else if (/^amex$/i.test(name)) name = 'American Express';
    if (last4 && !/paypal/i.test(name)) return name + ', endet auf ' + last4[1];
    return name;
  }

  // ---------------------------------------------------------------- Hauptfunktion

  // Obergrenzen schützen vor riesigen oder präparierten Dateien
  const MAX_CHARS = 1500000;
  const MAX_LINE = 1000;

  function extractFields(rawInput) {
    const rawText = String(rawInput || '').slice(0, MAX_CHARS);
    const allLines = toLines(rawText).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));
    const lines = repairWrapped(withoutNoise(allLines));
    const text = lines.join('\n');
    const kind = detectKind(text);
    const epic = EPIC_KINDS.has(kind);
    const usDates = kind === 'account-export' || kind === 'psn-receipt';
    const items = [];
    const seen = new Set();

    function add(item) {
      const k = (item.target || item.key + ':' + item.label) + '|' + String(item.value).toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      items.push(Object.assign({ confidence: 'high', auto: false, info: false, note: '' }, item));
    }

    const NOT_ACCOUNT_LINE = /client|session|consent|auth\b|external|token|secret|recovery|password|passwort/i;

    // --- Konto-ID
    let accountId = null;
    const idLabeled = findLabeled(lines, /(?:Epic[\s-]*)?(?:Account[\s-]*ID|Konto[\s-]*ID)|ID/i, V.accountId, {
      exclude: /(?:External|Auth|Session|Client|Recovery|Invoice|Order|Transaction|Request)\s*ID/i,
      skipLine: NOT_ACCOUNT_LINE,
    });
    if (idLabeled) accountId = { value: idLabeled.value, confidence: 'high', auto: epic };
    if (!accountId && epic) {
      // Ohne Beschriftung: die häufigste 32-stellige Hex-Kennung, aber nie aus Zeilen mit Client/Session/...
      const counts = new Map();
      for (const line of lines) {
        if (NOT_ACCOUNT_LINE.test(line)) continue;
        const found = line.match(/(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/g) || [];
        for (const f of found) counts.set(f, (counts.get(f) || 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) accountId = { value: best[0], confidence: 'medium', auto: false };
    }
    if (accountId) {
      add({ key: 'account_id', label: 'Epic-Konto-ID', target: 'account_id', value: accountId.value, confidence: accountId.confidence, auto: accountId.auto, note: accountId.auto ? '' : 'Bitte prüfen, ob das deine Konto-ID ist.' });
    }

    // --- Angaben, die nur in Epic-Kontodaten und auf Epic-Kontoseiten stehen
    const accountDoc = kind === 'account-export' || kind === 'account-page';
    if (accountDoc) {
      const dn = findLabeled(lines, /(?:Epic[\s-]*)?Display\s*Name|Anzeigename/i, V.displayName, { exclude: /External/i });
      if (dn) add({ key: 'display_name', label: 'Anzeigename', target: 'display_name', value: dn.value, auto: true, note: 'Falls der Hacker den Namen geändert hat, ist das vielleicht nicht dein Name.' });
      const fn = findLabeled(lines, /First\s*Name|Vorname/i, V.personName);
      if (fn) add({ key: 'first_name', label: 'Vorname', target: 'first_name', value: fn.value, auto: true });
      const ln = findLabeled(lines, /Last\s*Name|Nachname|Familienname/i, V.personName);
      if (ln) add({ key: 'last_name', label: 'Nachname', target: 'last_name', value: ln.value, auto: true });
      const co = findLabeled(lines, /Country(?:\s*\/\s*Region)?|Land(?:\s*\/\s*Region)?/i, V.country);
      if (co) add({ key: 'country', label: 'Land', target: 'country', value: co.value, auto: true });
      const ph = findLabeled(lines, /Phone(?:\s*Number)?|Telefon(?:nummer)?|Handy(?:nummer)?|Mobil(?:nummer)?/i, V.phone);
      if (ph) {
        if (/[*•xX]{2,}/.test(ph.value)) add({ key: 'phone_masked', label: 'Handynummer (teilweise verdeckt)', target: null, value: ph.value, info: true });
        else add({ key: 'phone', label: 'Handynummer', target: 'phone', value: ph.value, auto: true });
      }
      const cd = findLabeled(lines, /Creation\s*Date|Date\s*Created|Account\s*created|Konto\s*erstellt(?:\s*am)?|Erstellungsdatum|Erstellt\s*am/i, (s) => V.date(s, usDates));
      if (cd) add({ key: 'account_created', label: 'Konto erstellt am', target: 'account_created', value: cd.value.replace(/,.*$/, ''), auto: true });
      const ll = findLabeled(lines, /Last\s*Log(?:in|ged\s*in)|Letzte\s*Anmeldung|Zuletzt\s*angemeldet/i, (s) => V.date(s, usDates));
      if (ll) add({ key: 'last_login', label: 'Letzte Anmeldung', target: null, value: ll.value, info: true, note: 'Wenn du dich zu dieser Zeit nicht angemeldet hast, war es vermutlich der Hacker.' });
      const st = findLabeled(lines, /Account\s*Status|Kontostatus/i, (s) => (/^(ACTIVE|INACTIVE|DISABLED|LOCKED|BANNED|DELETED|PENDING_DELETION|Aktiv|Gesperrt|Deaktiviert)$/i.test(s.trim()) ? s.trim() : null));
      if (st) add({ key: 'account_status', label: 'Kontostatus', target: null, value: st.value, info: true });
    }

    // --- E-Mail-Adressen
    const emailsAll = [...new Set((text.match(RE_EMAIL_G) || []).map((e) => e.toLowerCase()))]
      .filter((e) => !SYSTEM_EMAIL_DOMAINS.test(e.split('@')[1]));
    let accountEmail = null;
    let newEmail = null;
    if (kind === 'epic-receipt') {
      // Auf Belegen ist "Rechnung an" die Konto-Adresse zum Kaufzeitpunkt
      const em = findLabeled(lines, /Bill\s*To|Rechnung\s*an/i, V.email);
      if (em) {
        accountEmail = em.value;
        add({ key: 'email', label: 'E-Mail-Adresse im Konto (beim Kauf)', target: 'email_original', value: em.value, auto: true });
      }
    } else if (accountDoc) {
      const em = findLabeled(lines, /E-?Mail(?:[\s-]*Adresse|\s*Address)?/i, V.email);
      if (em) {
        accountEmail = em.value;
        add({ key: 'email', label: 'E-Mail-Adresse im Konto', target: 'email_original', value: em.value, note: 'Das ist die Adresse, die beim Erstellen der Datei im Konto stand. Hat der Hacker sie schon geändert, gehört sie ihm.' });
      }
    } else if (kind === 'recovery-mail') {
      // In der Bestätigung der Wiederherstellung steht als Empfänger deine neue Adresse
      const to = findLabeled(lines, /An|To|Empfänger/i, (c) => {
        const found = c.match(RE_EMAIL_G);
        return found ? V.email(found[0]) : null;
      }, { noBelow: true });
      if (to && !SYSTEM_EMAIL_DOMAINS.test(to.value.split('@')[1])) {
        newEmail = to.value;
        add({ key: 'email_new', label: 'Neue sichere E-Mail-Adresse', target: 'email_new', value: newEmail, auto: true, note: 'An diese Adresse hat Epic die Bestätigung geschickt.' });
      }
    }
    if (epic && kind !== 'recovery-mail' && kind !== 'support-mail') {
      for (const e of emailsAll) {
        if (e === accountEmail || e === newEmail) continue;
        add({ key: 'email_other', label: 'Weitere E-Mail-Adresse', target: 'emails_old', value: e, confidence: 'medium', note: 'Nur übernehmen, wenn die Adresse dir gehört.' });
      }
    }
    if (kind === 'account-page' && !accountEmail) {
      for (const line of lines) {
        if (!line.includes('@') || !/[*•]{2}/.test(line)) continue;
        const masked = /(?<![A-Za-z0-9._%+*•-])[A-Za-z0-9._%+-]{0,64}[*•]{2,64}[A-Za-z0-9._%+-]{0,64}[*•]{0,64}@[A-Za-z0-9*•-]{1,64}(?:\.[A-Za-z0-9*•-]{1,64}){0,4}\.[A-Za-z]{2,24}/.exec(line);
        if (masked) {
          add({ key: 'email_masked', label: 'E-Mail-Adresse (teilweise verdeckt)', target: null, value: masked[0], info: true, note: 'Epic zeigt die Adresse nur teilweise. Prüfe, ob das deine ist.' });
          break;
        }
      }
    }

    // --- Rechnungs- und Bestellnummern (Bestellnummern zuerst, damit sie nicht als Rechnungsnummer zählen)
    const orders = [...new Set(text.match(RE_ORDER_G) || [])];
    const textNoOrders = text.replace(RE_ORDER_G, ' ');
    const invoices = [...new Set(textNoOrders.match(RE_INVOICE_G) || [])];
    for (const inv of invoices) {
      const sure = kind === 'epic-receipt' || kind === 'account-export';
      add({ key: 'invoice_id', label: 'Rechnungsnummer (Invoice-ID)', target: 'invoice_ids', value: inv, confidence: sure ? 'high' : 'medium', auto: sure, note: /^F/.test(inv) ? 'Beginnt mit F: gehört zu einem Gratis-Spiel.' : '' });
    }
    for (const ord of orders) {
      add({ key: 'order_id', label: 'Bestellnummer (Order-ID)', target: null, value: ord, info: true, note: 'Für das Formular brauchst du die Rechnungsnummer, nicht die Bestellnummer.' });
    }
    if (kind === 'epic-receipt') {
      const od = findLabeled(lines, /Order\s*Date|Bestelldatum|Kaufdatum/i, (s) => V.date(s, false));
      if (od) add({ key: 'order_date', label: 'Kaufdatum', target: null, value: od.value, info: true });
      const tot = /(?:TOTAL|GESAMT)(?:\s*\[\s*[A-Z]{3}\s*\])?\s*:?\s*\n?\s*((?:[A-Z]{3}\s*)?[€$£]?\s*\d[\d.,]*(?:\s*(?:€|EUR|USD|GBP|CHF))?)/i.exec(text);
      if (tot) add({ key: 'total', label: 'Betrag', target: null, value: tot[1].trim(), info: true });
    }

    // --- Zahlungsart
    if (kind === 'epic-receipt' || kind === 'account-export' || kind === 'paypal') {
      let scope = text;
      const pd = /(?:PAID\s+FROM|PAYMENT\s+DETAILS|BEZAHLT\s+MIT|ZAHLUNGSDETAILS|Payment\s+Profiles|Zahlungsprofile)[\s\S]{0,300}/i.exec(text);
      if (pd) scope = pd[0];
      const pm = paymentMethod(scope) || (kind === 'paypal' ? 'PayPal' : null);
      if (pm) add({ key: 'payment_method', label: 'Zahlungsart', target: 'payment_method', value: pm, auto: kind !== 'paypal' });
    }

    // --- Verknüpfte Konten
    if (kind === 'account-export') {
      for (const p of externalAuths(lines)) {
        add({ key: 'platform', label: 'Verknüpftes Konto', target: 'platforms', value: platformLine(p), auto: true });
      }
    }
    if (kind === 'psn-receipt') {
      const oid = findLabeled(lines, /Online[\s-]*ID/i, (s) => (/^[A-Za-z][A-Za-z0-9_-]{2,15}$/.test(s.trim()) ? s.trim() : null));
      if (oid) add({ key: 'platform', label: 'PlayStation-Konto', target: 'platforms', value: 'PlayStation: ' + oid.value, confidence: 'medium', note: 'Nur übernehmen, wenn dieses PlayStation-Konto mit Epic verknüpft war.' });
    }

    // --- Kontoverlauf (Zeitstrahl des Hacks) und IP-Adressen
    if (kind === 'account-export') {
      const hist = accountHistory(lines);
      for (const h of hist) {
        add({ key: 'history', label: h.label, target: null, value: [h.date, h.ip ? 'IP ' + h.ip : ''].filter(Boolean).join(' · ') || h.code, info: true });
      }
      // Vorschlag für den Zeitpunkt des Hacks: die NEUESTE Änderung der E-Mail-Adresse
      const emailChanges = hist.filter((h) => /EMAIL_UPDATED|EMAIL_CHANGED/.test(h.code) && h.date)
        .sort((a, b) => sortKey(b.date).localeCompare(sortKey(a.date)));
      if (emailChanges.length) {
        add({ key: 'hack_date', label: 'Vorschlag: Zeitpunkt des Hacks', target: 'hack_date', value: emailChanges[0].date, confidence: 'medium', note: 'Zu diesem Zeitpunkt wurde die E-Mail-Adresse zuletzt geändert. Warst du das nicht, war es vermutlich der Hacker.' });
      }
    }
    if (kind === 'account-export' || kind === 'recovery-mail' || kind === 'support-mail') {
      const ips = [...new Set([...(text.match(RE_IPV4_G) || []), ...(text.match(RE_IPV6_G) || [])])]
        .filter((ip) => !/^(?:0\.|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip));
      for (const ip of ips) {
        add({ key: 'ip', label: 'IP-Adresse', target: 'ip_addresses', value: ip, confidence: 'medium', note: 'Kann deine eigene oder die des Hackers sein.' });
      }
    }

    // --- Wiederherstellungs-ID (laut Epic: "AR" + 18 Buchstaben oder Ziffern) und Ticketnummer
    if (epic) {
      const ridAr = RE_RECOVERY_AR.exec(text);
      if (ridAr) {
        add({ key: 'recovery_id', label: 'Wiederherstellungs-ID', target: 'recovery_id', value: ridAr[0], auto: true });
      } else {
        const rid = findLabeled(lines, /(?:Account\s*)?Recovery\s*(?:Request\s*)?ID|Wiederherstellungs-?(?:ID|nummer)/i, V.code);
        if (rid) add({ key: 'recovery_id', label: 'Wiederherstellungs-ID', target: 'recovery_id', value: rid.value, confidence: 'medium', note: 'Normalerweise beginnt die Recovery ID mit "AR". Bitte prüfen.' });
      }
      const tk = findLabeled(lines, /Case\s*(?:Number|No\.?|ID|#)|Ticket\s*(?:Number|Nr\.?|ID|#)|Ticketnummer|Fallnummer|Vorgangsnummer|Anfragenummer|Request\s*#/i, V.code);
      if (tk) add({ key: 'ticket_number', label: 'Ticket- oder Fallnummer', target: 'ticket_number', value: tk.value, confidence: 'medium', note: 'Bitte prüfen, ob das wirklich die Ticketnummer ist.' });
    }

    return { kind, kindLabel: KINDS[kind], items };
  }

  return { extractFields, parseDate, normalize, detectKind, countryName, findLabeled, KINDS };
});
