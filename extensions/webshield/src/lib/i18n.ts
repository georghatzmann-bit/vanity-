/** Texte der Erweiterung (Deutsch, Englisch als zweite Sprache). */

import type { Category } from './rules';
import type { DownloadRisk } from './downloads';
import type { Signal } from './lookalike';

const de = {
  warnTitle: 'Diese Seite wurde angehalten',
  warnLead: 'AEGIS Web-Schutz hat den Aufruf angehalten, weil die Adresse auf einer Liste steht:',
  category: {
    malware: 'Schadsoftware wird hier verteilt.',
    phishing: 'Phishing: Die Seite will Zugangsdaten oder Zahlungsdaten abgreifen.',
    scam: 'Betrug (Fake-Shop, falscher Support, Abzocke).',
    ransomware: 'Erpressungstrojaner (Ransomware) wird hier verteilt oder gesteuert.',
  } satisfies Record<Category, string>,
  warnUnknown: 'Die Adresse ist nicht mehr bekannt (z. B. nach einem Neustart des Browsers).',
  warnBack: 'Zurück in Sicherheit',
  warnUnderstand: 'Ich verstehe das Risiko und will die Seite trotzdem öffnen.',
  warnOpen: 'Trotzdem öffnen (nur diese Sitzung)',
  warnHint:
    'Listen können irren. Wenn du dir sicher bist, kannst du die Seite für diese Browser-Sitzung freigeben.',
  warnRedirect:
    'Diese Adresse hat dich weitergeleitet – das eigentliche Ziel steht auf der Liste. Eine Freigabe ist hier nicht möglich.',
  bannerTitle: 'AEGIS: Vorsicht auf dieser Seite',
  signal: {
    brand:
      'Die Adresse enthält den Namen einer bekannten Marke, gehört aber nicht zu ihr. Gib hier keine Zugangsdaten ein.',
    punycode:
      'Die Adresse nutzt Sonderzeichen (Punycode) und kann einer bekannten Seite zum Verwechseln ähnlich sehen.',
    insecure_password:
      'Hier wird ein Passwort ohne Verschlüsselung (HTTP) abgefragt. Es könnte mitgelesen werden.',
  } satisfies Record<Signal, string>,
  bannerClose: 'Hinweis schließen',
  downloadTitle: 'AEGIS: Vorsicht bei diesem Download',
  risk: {
    executable: 'Ausführbare Datei – startet beim Öffnen ein Programm.',
    macro: 'Dokument mit Makros – kann Code ausführen.',
    double_extension: 'Doppelte Endung – tarnt ein Programm als Dokument oder Bild.',
    insecure_source: 'Ohne HTTPS geladen – unterwegs veränderbar.',
  } satisfies Record<DownloadRisk, string>,
  downloadAdvice: 'Prüfe die Datei mit AEGIS, bevor du sie öffnest.',
  optionsTitle: 'AEGIS Web-Schutz',
  optionsLead:
    'Hält bekannte Phishing-, Betrugs- und Schadsoftware-Seiten an und weist auf Tricks hin. Die Erweiterung speichert keinen Verlauf und sendet nichts – sie lädt nur die Listen.',
  optUpdate: 'Listen täglich aktualisieren',
  optUpdateHint:
    'Lädt öffentliche Listen von GitHub. Ausgeschaltet gilt nur die mitgelieferte Liste.',
  optPage: 'Hinweise bei verdächtigen Seiten',
  optDownload: 'Hinweise bei riskanten Downloads',
  status: 'Status der Listen',
  statusNever: 'Noch nicht aktualisiert',
  statusAt: 'Zuletzt aktualisiert',
  statusDomains: 'Gesperrte Adressen (geladen)',
  statusBundled: 'Mitgeliefert: Ransomware- und Betrugsliste',
  updateNow: 'Jetzt aktualisieren',
  updating: 'Aktualisiere …',
  sourceFailed: 'nicht erreichbar – alte Einträge bleiben aktiv',
  sources: 'Quellen und Lizenzen',
  honest:
    'Ehrlich gesagt: Listen kennen nur gemeldete Seiten. Neue Betrugsseiten erkennt der Web-Schutz an Merkmalen – aber nicht immer.',
};

type Texts = typeof de;

const en: Texts = {
  warnTitle: 'This page was stopped',
  warnLead: 'AEGIS Web Shield stopped this request because the address is on a list:',
  category: {
    malware: 'Malware is distributed here.',
    phishing: 'Phishing: the page tries to steal login or payment details.',
    scam: 'Scam (fake shop, fake support, rip-off).',
    ransomware: 'Ransomware is distributed or controlled here.',
  },
  warnUnknown: 'The address is no longer known (e.g. after a browser restart).',
  warnBack: 'Back to safety',
  warnUnderstand: 'I understand the risk and want to open the page anyway.',
  warnOpen: 'Open anyway (this session only)',
  warnHint: 'Lists can be wrong. If you are sure, you can allow the page for this browser session.',
  warnRedirect:
    'This address redirected you – the actual destination is on the list. Allowing it is not possible here.',
  bannerTitle: 'AEGIS: Be careful on this page',
  signal: {
    brand:
      'The address contains the name of a well-known brand but does not belong to it. Do not enter credentials here.',
    punycode:
      'The address uses special characters (punycode) and may look confusingly similar to a well-known site.',
    insecure_password:
      'A password is requested without encryption (HTTP). It could be intercepted.',
  },
  bannerClose: 'Close hint',
  downloadTitle: 'AEGIS: Be careful with this download',
  risk: {
    executable: 'Executable file – starts a program when opened.',
    macro: 'Document with macros – can run code.',
    double_extension: 'Double extension – disguises a program as a document or image.',
    insecure_source: 'Loaded without HTTPS – could be tampered with in transit.',
  },
  downloadAdvice: 'Check the file with AEGIS before opening it.',
  optionsTitle: 'AEGIS Web Shield',
  optionsLead:
    'Stops known phishing, scam and malware sites and points out tricks. The extension keeps no history and sends nothing – it only downloads the lists.',
  optUpdate: 'Update lists daily',
  optUpdateHint: 'Downloads public lists from GitHub. When off, only the bundled list applies.',
  optPage: 'Hints on suspicious pages',
  optDownload: 'Hints on risky downloads',
  status: 'List status',
  statusNever: 'Not updated yet',
  statusAt: 'Last updated',
  statusDomains: 'Blocked addresses (downloaded)',
  statusBundled: 'Bundled: ransomware and scam list',
  updateNow: 'Update now',
  updating: 'Updating…',
  sourceFailed: 'unreachable – previous entries stay active',
  sources: 'Sources and licences',
  honest:
    'To be honest: lists only know reported sites. The Web Shield detects new scam sites by their traits – but not always.',
};

/** Texte passend zur Browsersprache. */
export function texts(language: string): Texts {
  return language.toLowerCase().startsWith('de') ? de : en;
}

export type { Texts };
