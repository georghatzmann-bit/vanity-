// Erkennt Kontodaten im Text einer PDF (oder einer Text-/Mail-Datei).
// Unterstützt: Epic-Kontodaten-Download, Epic-Kaufbelege, als PDF gespeicherte Epic-Kontoseiten,
// Epic-Mails zur Wiederherstellung/zum Support sowie PlayStation-, Nintendo-, Xbox- und PayPal-Belege.
//
// Ergebnis: { kind, kindLabel, items: [...] }
// Jedes item: { key, label, value, target, confidence, auto, info, note }
//   target = Feld in "Meine Daten" (null = nur zur Info)
//   auto   = darf ohne Rückfrage in ein LEERES Feld übernommen werden
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

  // Kopf- und Fußzeilen vom Browser-Druck ("04.10.26, 14:03  Konto | Epic Games", "Seite 1 von 3", URLs)
  const PRINT_NOISE = [
    /^\s*\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\b.*$/i,
    /^\s*(?:Seite|Page)\s+\d+\s*(?:von|of|\/)\s*\d+\s*$/i,
    /^\s*\d+\s*\/\s*\d+\s*$/,
    /^\s*https?:\/\/\S+(?:\s+\d+\s*\/\s*\d+)?\s*$/i,
  ];

  function toLines(text) {
    return normalize(text)
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
      .filter((l) => l.length > 0);
  }

  function withoutNoise(lines) {
    return lines.filter((l) => !PRINT_NOISE.some((re) => re.test(l)));
  }

  // In schmalen Tabellenspalten bricht ein Datum oft um: "2026-10-" / "02T19:13:02Z".
  // Solche Stücke werden wieder zu einem Datum zusammengesetzt.
  function repairWrappedDates(lines) {
    const out = lines.slice();
    for (let i = 0; i < out.length - 1; i++) {
      const m = /((?:19|20)\d{2}-\d{1,2}-)(?=\s|$)/.exec(out[i]);
      if (!m) continue;
      const n = /^(\d{1,2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)(?=\s|$)/.exec(out[i + 1]);
      if (!n) continue;
      out[i] = out[i].slice(0, m.index) + m[1] + n[1] + out[i].slice(m.index + m[1].length);
      out[i + 1] = out[i + 1].slice(n[0].length).trim();
    }
    return out.filter((l) => l.length > 0);
  }

  // Spalten einer Zeile (pdf.js-Auslese trennt Tabellenspalten mit mehreren Leerzeichen)
  function columns(line) {
    return line.split(/\s{2,}|\t+|\s\|\s/).map((c) => c.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------- Datumsangaben

  const MONTHS_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const MONTHS_DE = { jan: 1, 'jän': 1, feb: 2, 'mär': 3, mae: 3, mar: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dez: 12 };

  function pad(n) { return String(n).padStart(2, '0'); }

  function validYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1;
  }

  function fmt(y, m, d, time) {
    return pad(d) + '.' + pad(m) + '.' + y + (time ? ', ' + time + ' Uhr' : '');
  }

  // Findet das erste Datum in einem Text und gibt es als "TT.MM.JJJJ[, HH:MM Uhr]" zurück.
  // usHint = true: bei mehrdeutigem 03/04/2026 amerikanisch (Monat zuerst) lesen.
  function parseDate(str, usHint) {
    const s = String(str || '');
    let m;
    // ISO 8601: 2026-10-04T12:00:00Z (UTC -> deutsche Zeit)
    m = /(?<!\d)((?:19|20)\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?(?!\d)/.exec(s);
    if (m) {
      const y = +m[1]; const mo = +m[2]; const d = +m[3];
      if (!validYmd(y, mo, d)) return null;
      if (m[4] && m[7]) {
        const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + (m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2'));
        const dt = new Date(iso);
        if (!isNaN(dt)) {
          try {
            const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(dt);
            const get = (t) => (parts.find((p) => p.type === t) || {}).value;
            return get('day') + '.' + get('month') + '.' + get('year') + ', ' + get('hour') + ':' + get('minute') + ' Uhr';
          } catch (_) { /* ohne Zeitzonen-Daten einfach UTC anzeigen */ }
        }
      }
      return fmt(y, mo, d, m[4] ? m[4] + ':' + m[5] : '');
    }
    // Deutsch: 04.10.2026 (optional mit Uhrzeit)
    m = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})(?![\d.])(?:,?\s+(\d{1,2}):(\d{2}))?/.exec(s);
    if (m && validYmd(+m[3], +m[2], +m[1])) return fmt(+m[3], +m[2], +m[1], m[4] ? pad(m[4]) + ':' + m[5] : '');
    // Englisch: October 4, 2026 / Oct 4th 2026
    m = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})(?!\d)/i.exec(s);
    if (m) {
      const mo = MONTHS_EN[m[1].slice(0, 3).toLowerCase()];
      if (validYmd(+m[3], mo, +m[2])) return fmt(+m[3], mo, +m[2], '');
    }
    // Englisch Tag zuerst: 4 Oct 2026
    m = /(?<!\d)(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+((?:19|20)\d{2})(?!\d)/i.exec(s);
    if (m) {
      const mo = MONTHS_EN[m[2].slice(0, 3).toLowerCase()];
      if (validYmd(+m[3], mo, +m[1])) return fmt(+m[3], mo, +m[1], '');
    }
    // Deutsch ausgeschrieben: 4. Oktober 2026
    m = /(?<!\d)(\d{1,2})\.?\s*(Januar|Jänner|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Jan|Feb|Mär|Apr|Jun|Jul|Aug|Sept?|Okt|Nov|Dez)\.?\s+((?:19|20)\d{2})(?!\d)/i.exec(s);
    if (m) {
      const mo = MONTHS_DE[m[2].toLowerCase().slice(0, 3)];
      if (mo && validYmd(+m[3], mo, +m[1])) return fmt(+m[3], mo, +m[1], '');
    }
    // Schrägstrich: 08/07/2020 (mehrdeutig)
    m = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})(?![\d/])(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?/.exec(s);
    if (m) {
      let a = +m[1]; let b = +m[2];
      let d; let mo;
      if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else if (usHint) { mo = a; d = b; } else { d = a; mo = b; }
      let time = '';
      if (m[4]) {
        let h = +m[4];
        if (m[6]) { const pm = /p/i.test(m[6]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
        time = pad(h) + ':' + m[5];
      }
      if (validYmd(+m[3], mo, d)) return fmt(+m[3], mo, d, time);
    }
    return null;
  }

  // ---------------------------------------------------------------- Prüf-Regeln für Werte

  const RE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
  const RE_EMAIL_G = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
  const RE_IPV4_G = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g;
  const RE_IPV6_G = /(?<![0-9A-Fa-f:.])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6})(?![0-9A-Fa-f:])/g;
  const RE_ORDER_G = /(?<![A-Za-z0-9])([AF]\d{16})(?!\d)/g;
  const RE_INVOICE_G = /(?<![A-Za-z0-9])([AF]\d{8,10})(?![\dA-Za-z])/g;

  // Wörter, die selbst Beschriftungen sind und nie als Wert gelten dürfen
  const LABEL_WORDS = /^(?:e-?mail(?:[ -]?adresse)?(?: address)?|display name|anzeigename|first name|last name|vorname|nachname|account id|konto-?id|id|country|land|region|creation date|last login|account status|status|type|bill to|order id|order date|source|invoice id|phone|telefon|name|password|passwort|ja|nein|yes|no|connected|verbunden|disconnect|trennen|edit|bearbeiten)$/i;

  const SYSTEM_EMAIL_DOMAINS = /(?:^|\.)(?:epicgames\.com|unrealengine\.com|fortnite\.com|playstation\.com|sony\.com|sonyentertainmentnetwork\.com|nintendo\.(?:com|net|de|eu|co\.uk)|microsoft\.com|xbox\.com|paypal\.[a-z.]+|apple\.com|google\.com|steampowered\.com)$/i;

  function isLabelText(s) {
    return LABEL_WORDS.test(String(s).trim().replace(/[:：#]+$/, ''));
  }

  const V = {
    accountId: (s) => RE_ACCOUNT_ID.test(s) ? s.toLowerCase() : null,
    displayName: (s) => {
      const t = s.trim();
      if (t.length < 3 || t.length > 16 || isLabelText(t)) return null;
      return /^[\p{L}\p{N}_.\- ]+$/u.test(t) ? t : null;
    },
    personName: (s) => {
      const t = s.trim();
      if (!t || t.length > 40 || isLabelText(t)) return null;
      return /^[\p{L}][\p{L}'’ .\-]*$/u.test(t) ? t : null;
    },
    email: (s) => {
      const m = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}$/.exec(s.trim());
      return m ? m[0].toLowerCase() : null;
    },
    date: (s, usHint) => parseDate(s, usHint),
    country: (s) => countryName(s),
    order: (s) => /^[AF]\d{16}$/.test(s.trim()) ? s.trim() : null,
    invoice: (s) => /^[AF]\d{8,10}$/.test(s.trim()) ? s.trim() : null,
    code: (s) => {
      const t = s.trim().replace(/^#\s*/, '');
      return /^[A-Za-z0-9][A-Za-z0-9-]{4,40}$/.test(t) && /\d/.test(t) && !isLabelText(t) ? t : null;
    },
    phone: (s) => {
      const t = s.trim();
      if (!/^[+0(][\d\s()./*•xX-]{5,24}\d$/.test(t)) return null;
      return t;
    },
    any: (s) => (s.trim() && !isLabelText(s) ? s.trim() : null),
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

  // Sucht eine Beschriftung und liefert den ersten passenden Wert dahinter
  // (gleiche Zeile oder eine der nächsten Zeilen, z. B. bei zweispaltigen Belegen).
  function findLabeled(lines, labelRe, validate, opts) {
    opts = opts || {};
    const lookahead = opts.lookahead == null ? 4 : opts.lookahead;
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const re = new RegExp(labelRe.source, labelRe.flags.replace('g', ''));
      const m = re.exec(line);
      if (!m) continue;
      if (opts.exclude && opts.exclude.test(line.slice(Math.max(0, m.index - 24), m.index + m[0].length))) continue;
      const rest = line.slice(m.index + m[0].length).replace(/^[\s:：#-]+/, '');
      const candidates = [];
      if (rest) {
        candidates.push(columns(rest)[0]);
        candidates.push(rest.trim());
      }
      // Werte in den nächsten Zeilen (Beschriftungs-Zeilen werden übersprungen)
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + lookahead); j++) {
        const next = lines[j];
        const col = columns(next)[0] || next;
        candidates.push(col);
        candidates.push(next.trim());
      }
      for (const c of candidates) {
        if (!c) continue;
        const v = validate(c);
        if (v) {
          results.push({ value: v, line: i });
          break;
        }
      }
      if (results.length && !opts.all) return results[0];
    }
    return opts.all ? results : null;
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
    if (/HISTORY_ACCOUNT_|External\s+Auths?|Third\s+Party\s+App\s+Consents|Payment\s+Profiles/i.test(t)) return 'account-export';
    if (/INVOICE\s*ID|Your\s+Epic\s+Games\s+Receipt|Epic\s+Games[-\s]Beleg|RECHNUNGSNUMMER|HERE'S\s+WHAT\s+YOU\s+ORDERED|DAS\s+HAST\s+DU\s+BESTELLT/i.test(t)) return 'epic-receipt';
    if (/Recovery\s+(?:Request\s+)?ID|account\s+recovery\s+request|Wiederherstellungs-?ID|Account-Wiederherstellung/i.test(t)) return 'recovery-mail';
    if (/epicgames\.com\/account|Account\s+Settings|Kontoeinstellungen|Kontoinformationen|Account\s+Information|Password\s*&\s*Security|Passwort\s+und\s+Sicherheit/i.test(t)) return 'account-page';
    if (/Player\s+Support|Spieler-?Support|support\.epicgames\.com|Case\s*(?:Number|#)|Fallnummer|Ticketnummer/i.test(t)) return 'support-mail';
    if (/Thank\s+You\s+For\s+Your\s+Purchase|Online[\s-]ID|PlayStation\s*Store|txn-email\.playstation\.com/i.test(t)) return 'psn-receipt';
    if (/Nintendo\s+eShop|Nintendo\s+of\s+Europe|accounts\.nintendo\.com/i.test(t)) return 'nintendo-receipt';
    if (/Microsoft[-\s](?:order|Bestellung)|Xbox/i.test(t)) return 'xbox-receipt';
    if (/PayPal/i.test(t)) return 'paypal';
    return 'unknown';
  }

  const EPIC_KINDS = new Set(['account-export', 'epic-receipt', 'account-page', 'recovery-mail', 'support-mail']);

  // ---------------------------------------------------------------- Plattformen

  const PLATFORM_TYPES = {
    psn: 'PlayStation', xbl: 'Xbox', nintendo: 'Nintendo', steam: 'Steam', twitch: 'Twitch', github: 'GitHub', google: 'Google',
    apple: 'Apple', facebook: 'Facebook', lego: 'LEGO', vk: 'VK', ubisoft: 'Ubisoft', discord: 'Discord',
  };
  const PLATFORM_RE = new RegExp('^(' + Object.keys(PLATFORM_TYPES).join('|') + ')\\b', 'i');

  // Liest die Tabelle "External Auths" aus dem Epic-Kontodaten-Download
  function externalAuths(lines) {
    const out = [];
    let inSection = false;
    const SECTION_END = /^(?:Account\s+History|Sessions|Third\s+Party|Devices|Addresses|Payment\s+Profiles|Transaction\s+History)\b/i;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^External\s+Auths?\b/i.test(line)) { inSection = true; continue; }
      if (!inSection) continue;
      if (SECTION_END.test(line)) { inSection = false; continue; }
      if (/^Type\b.*External/i.test(line)) continue; // Tabellenkopf

      // Format A: eine Tabellenzeile "psn   1234567   Name   2021-08-05T..."
      const pm = PLATFORM_RE.exec(line);
      if (pm) {
        const type = pm[1].toLowerCase();
        let rest = line.slice(pm[0].length).trim();
        const date = parseDate(rest, true);
        rest = rest.replace(/(?:19|20)\d{2}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?|\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)?/gi, '').trim();
        const cols = columns(rest);
        let name = '';
        if (cols.length >= 2) name = cols.slice(1).join(' ');
        else {
          const parts = rest.split(/\s+/);
          name = parts.length >= 2 ? parts.slice(1).join(' ') : '';
        }
        out.push({ type, name: name.trim(), date });
        continue;
      }
      // Format B: "Type: psn" gefolgt von weiteren Beschriftungen
      const tm = /^Type\s*:?\s*(\w+)/i.exec(line);
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
      }
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
    const last4 = /(?:ending\s+(?:in|with)|endet\s+(?:auf|mit)|Endziffern|(?:[*•xX]{2,}[\s-]*){1,4})\s*:?\s*(\d{4})(?!\d)/i.exec(text);
    if (!kw && !last4) return null;
    let name = kw ? kw[1] : 'Karte';
    if (/^paysafecard$/i.test(name)) name = 'paysafecard';
    else if (/^mastercard$/i.test(name)) name = 'Mastercard';
    else if (/^amex$/i.test(name)) name = 'American Express';
    if (last4 && !/paypal/i.test(name)) return name + ', endet auf ' + last4[1];
    return name;
  }

  // ---------------------------------------------------------------- Hauptfunktion

  function extractFields(rawText) {
    const allLines = toLines(rawText);
    const lines = repairWrappedDates(withoutNoise(allLines));
    const text = lines.join('\n');
    const kind = detectKind(normalize(rawText));
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

    // --- Konto-ID
    let accountId = null;
    const idLabeled = findLabeled(lines, /(?:Epic[\s-]*)?(?:Account[\s-]*ID|Konto[\s-]*ID)\b|^ID\b/i, V.accountId, {
      exclude: /(?:External|Auth|Session|Client|Recovery|Invoice|Order|Transaction|Request)\s*ID/i,
    });
    if (idLabeled) accountId = { value: idLabeled.value, confidence: 'high' };
    if (!accountId) {
      const counts = new Map();
      for (const line of lines) {
        if (/password|passwort|token|session|client|secret|recovery|external\s+auth/i.test(line)) continue;
        const joined = line.replace(/\b([0-9a-f]{4,28})\s+(?=[0-9a-f]{4,28}\b)/gi, (m, a) => a);
        const found = joined.match(/(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/g) || [];
        for (const f of found) counts.set(f, (counts.get(f) || 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && epic) accountId = { value: best[0], confidence: 'medium' };
    }
    if (accountId) add({ key: 'account_id', label: 'Epic-Konto-ID', target: 'account_id', value: accountId.value, confidence: accountId.confidence, auto: accountId.confidence === 'high' });

    // --- Anzeigename
    if (epic) {
      const dn = findLabeled(lines, /(?:Epic[\s-]*)?Display\s*Name|Anzeigename/i, V.displayName, { exclude: /External\s+Display/i, lookahead: 2 });
      if (dn) add({ key: 'display_name', label: 'Anzeigename', target: 'display_name', value: dn.value, auto: true, note: kind === 'account-export' || kind === 'account-page' ? 'Falls der Hacker den Namen geändert hat, ist das vielleicht nicht dein Name.' : '' });
    }

    // --- Vor- und Nachname, Land, Telefon
    if (epic) {
      const fn = findLabeled(lines, /First\s*Name|Vorname/i, V.personName, { lookahead: 2 });
      if (fn) add({ key: 'first_name', label: 'Vorname', target: 'first_name', value: fn.value, auto: true });
      const ln = findLabeled(lines, /Last\s*Name|Nachname|Familienname/i, V.personName, { lookahead: 2 });
      if (ln) add({ key: 'last_name', label: 'Nachname', target: 'last_name', value: ln.value, auto: true });
      const co = findLabeled(lines, /\bCountry(?:\s*\/\s*Region)?|\bLand(?:\s*\/\s*Region)?(?=\s|:|$)/i, V.country, { lookahead: 2 });
      if (co) add({ key: 'country', label: 'Land', target: 'country', value: co.value, auto: true });
      const ph = findLabeled(lines, /Phone(?:\s*Number)?|Telefon(?:nummer)?|Handy(?:nummer)?|Mobil(?:nummer)?/i, V.phone, { lookahead: 1 });
      if (ph) {
        if (/[*•xX]{2,}/.test(ph.value)) add({ key: 'phone_masked', label: 'Handynummer (teilweise verdeckt)', target: null, value: ph.value, info: true });
        else add({ key: 'phone', label: 'Handynummer', target: 'phone', value: ph.value, auto: true });
      }
    }

    // --- Konto erstellt, letzte Anmeldung, Status
    if (epic) {
      const cd = findLabeled(lines, /Creation\s*Date|Date\s*Created|Account\s*created|Konto\s*erstellt(?:\s*am)?|Erstellungsdatum|Erstellt\s*am/i, (s) => V.date(s, usDates), { lookahead: 2 });
      if (cd) add({ key: 'account_created', label: 'Konto erstellt am', target: 'account_created', value: cd.value.replace(/,.*$/, ''), auto: true });
      const ll = findLabeled(lines, /Last\s*Log(?:in|ged\s*in)|Letzte\s*Anmeldung|Zuletzt\s*angemeldet/i, (s) => V.date(s, usDates), { lookahead: 2 });
      if (ll) add({ key: 'last_login', label: 'Letzte Anmeldung', target: null, value: ll.value, info: true, note: 'Wenn du dich zu dieser Zeit nicht angemeldet hast, war es vermutlich der Hacker.' });
      const st = findLabeled(lines, /Account\s*Status|Kontostatus/i, (s) => (/^(ACTIVE|INACTIVE|DISABLED|LOCKED|BANNED|DELETED|PENDING_DELETION|Aktiv|Gesperrt|Deaktiviert)$/i.test(s.trim()) ? s.trim() : null), { lookahead: 2 });
      if (st) add({ key: 'account_status', label: 'Kontostatus', target: null, value: st.value, info: true });
    }

    // --- E-Mail-Adressen
    const emailsAll = [...new Set((text.match(RE_EMAIL_G) || []).map((e) => e.toLowerCase()))]
      .filter((e) => !SYSTEM_EMAIL_DOMAINS.test(e.split('@')[1]));
    let accountEmail = null;
    if (epic) {
      const em = findLabeled(lines, /E-?Mail(?:[\s-]*Adresse|\s*Address)?|Bill\s*To|Rechnung\s*an/i, V.email, { lookahead: 3 });
      if (em && !SYSTEM_EMAIL_DOMAINS.test(em.value.split('@')[1])) accountEmail = em.value;
      if (!accountEmail && emailsAll.length === 1 && kind !== 'recovery-mail') accountEmail = emailsAll[0];
    }
    if (accountEmail) {
      const note = kind === 'account-export' || kind === 'account-page'
        ? 'Das ist die Adresse, die beim Erstellen der PDF im Konto stand. Hat der Hacker sie schon geändert, gehört sie ihm.'
        : '';
      add({ key: 'email', label: 'E-Mail-Adresse im Konto', target: 'email_original', value: accountEmail, auto: kind === 'epic-receipt', note });
    }
    // In der Bestätigung der Wiederherstellung steht als Empfänger deine neue Adresse
    let newEmail = null;
    if (kind === 'recovery-mail') {
      const to = findLabeled(lines, /^(?:An|To|Empfänger)\s*:/i, (c) => {
        const found = c.match(RE_EMAIL_G);
        return found ? V.email(found[0]) : null;
      }, { lookahead: 0 });
      if (to && !SYSTEM_EMAIL_DOMAINS.test(to.value.split('@')[1])) {
        newEmail = to.value;
        add({ key: 'email_new', label: 'Neue sichere E-Mail-Adresse', target: 'email_new', value: newEmail, auto: true, note: 'An diese Adresse hat Epic die Bestätigung geschickt.' });
      }
    }
    for (const e of emailsAll) {
      if (e === accountEmail || e === newEmail) continue;
      if (!epic || kind === 'recovery-mail') continue;
      add({ key: 'email_other', label: 'Weitere E-Mail-Adresse', target: 'emails_old', value: e, confidence: 'medium', note: 'Nur übernehmen, wenn die Adresse dir gehört.' });
    }
    if (kind === 'account-page' && !accountEmail) {
      const masked = /[A-Za-z0-9._%+-]*[*•]{2,}[A-Za-z0-9._%+*•-]*@[A-Za-z0-9.*•-]+\.[A-Za-z]{2,24}/.exec(text);
      if (masked) add({ key: 'email_masked', label: 'E-Mail-Adresse (teilweise verdeckt)', target: null, value: masked[0], info: true, note: 'Epic zeigt die Adresse nur teilweise. Prüfe, ob das deine ist.' });
    }

    // --- Rechnungs- und Bestellnummern (Bestellnummern zuerst, damit sie nicht als Rechnungsnummer zählen)
    const orders = [...new Set(text.match(RE_ORDER_G) || [])];
    const textNoOrders = text.replace(RE_ORDER_G, ' ');
    const invoices = [...new Set(textNoOrders.match(RE_INVOICE_G) || [])];
    const invoiceLabeled = /INVOICE\s*ID|Invoice\s*(?:Number|No)|Rechnungs(?:nummer|-?ID|-?Nr)/i.test(text);
    for (const inv of invoices) {
      const conf = invoiceLabeled || kind === 'epic-receipt' ? 'high' : 'medium';
      add({ key: 'invoice_id', label: 'Rechnungsnummer (Invoice-ID)', target: 'invoice_ids', value: inv, confidence: conf, auto: conf === 'high' && epic, note: /^F/.test(inv) ? 'Beginnt mit F: gehört zu einem Gratis-Spiel.' : '' });
    }
    for (const ord of orders) {
      add({ key: 'order_id', label: 'Bestellnummer (Order-ID)', target: null, value: ord, info: true, note: 'Für das Formular brauchst du die Rechnungsnummer, nicht die Bestellnummer.' });
    }
    if (kind === 'epic-receipt') {
      const od = findLabeled(lines, /Order\s*Date|Bestelldatum|Kaufdatum/i, (s) => V.date(s, false), { lookahead: 4 });
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
      if (pm) add({ key: 'payment_method', label: 'Zahlungsart', target: 'payment_method', value: pm, auto: true });
    }

    // --- Verknüpfte Konten
    if (kind === 'account-export') {
      for (const p of externalAuths(lines)) {
        add({ key: 'platform', label: 'Verknüpftes Konto', target: 'platforms', value: platformLine(p), auto: true });
      }
    }
    if (kind === 'psn-receipt') {
      const oid = findLabeled(lines, /Online[\s-]*ID/i, (s) => (/^[A-Za-z][A-Za-z0-9_-]{2,15}$/.test(s.trim()) ? s.trim() : null), { lookahead: 1 });
      if (oid) add({ key: 'platform', label: 'PlayStation-Konto', target: 'platforms', value: 'PlayStation: ' + oid.value, confidence: 'medium', note: 'Nur übernehmen, wenn dieses PlayStation-Konto mit Epic verknüpft war.' });
    }

    // --- Kontoverlauf (Zeitstrahl des Hacks) und IP-Adressen
    if (kind === 'account-export') {
      const hist = accountHistory(lines);
      for (const h of hist) {
        add({ key: 'history', label: h.label, target: null, value: [h.date, h.ip ? 'IP ' + h.ip : ''].filter(Boolean).join(' · ') || h.code, info: true });
      }
      const emailChanges = hist.filter((h) => /EMAIL_UPDATED|EMAIL_CHANGED/.test(h.code) && h.date);
      if (emailChanges.length) {
        const last = emailChanges[emailChanges.length - 1];
        add({ key: 'hack_date', label: 'Vorschlag: Zeitpunkt des Hacks', target: 'hack_date', value: last.date, confidence: 'medium', note: 'Zu diesem Zeitpunkt wurde die E-Mail-Adresse zuletzt geändert. Warst du das nicht, war es vermutlich der Hacker.' });
      }
    }
    if (kind === 'account-export' || kind === 'recovery-mail' || kind === 'support-mail') {
      const ips = [...new Set([...(text.match(RE_IPV4_G) || []), ...(text.match(RE_IPV6_G) || [])])]
        .filter((ip) => !/^(?:0\.|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip));
      for (const ip of ips) {
        add({ key: 'ip', label: 'IP-Adresse', target: 'ip_addresses', value: ip, confidence: 'medium', note: 'Kann deine eigene oder die des Hackers sein.' });
      }
    }

    // --- Wiederherstellungs-ID und Ticketnummer
    const rid = findLabeled(lines, /(?:Account\s*)?Recovery\s*(?:Request\s*)?ID|Wiederherstellungs-?(?:ID|nummer)/i, V.code, { lookahead: 2 });
    if (rid) add({ key: 'recovery_id', label: 'Wiederherstellungs-ID', target: 'recovery_id', value: rid.value, auto: true });
    const tk = findLabeled(lines, /Case\s*(?:Number|No\.?|ID|#)|Ticket\s*(?:Number|Nr\.?|ID|#)|Ticketnummer|Fallnummer|Vorgangsnummer|Anfragenummer|Request\s*#/i, V.code, { lookahead: 1 });
    if (tk && epic) add({ key: 'ticket_number', label: 'Ticket- oder Fallnummer', target: 'ticket_number', value: tk.value, confidence: 'medium', note: 'Bitte prüfen, ob das wirklich die Ticketnummer ist.' });

    return { kind, kindLabel: KINDS[kind], items };
  }

  return { extractFields, parseDate, normalize, detectKind, countryName, KINDS };
});
