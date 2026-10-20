/** Texte der Erweiterung (Deutsch, Englisch als zweite Sprache). */

import type { ErrorCode } from './messages';

const de = {
  button: 'Login aus AEGIS einsetzen',
  menuTitle: 'AEGIS Tresor',
  loading: 'Frage AEGIS …',
  none: 'Kein gespeicherter Login für diese Seite.',
  noUser: '(ohne Benutzername)',
  insecure:
    'Achtung: Diese Seite nutzt kein HTTPS. Das Passwort könnte unterwegs mitgelesen werden.',
  close: 'Schließen',
  hidden:
    'Nicht ausgefüllt: Das Feld ist nicht deutlich sichtbar oder die Seite hat die AEGIS-Anzeige verändert.',
  error: {
    locked: 'Der Tresor ist gesperrt. Entsperre ihn in der AEGIS-App und versuche es erneut.',
    app_not_running: 'AEGIS läuft nicht. Starte die AEGIS-App und entsperre den Tresor.',
    host_missing:
      'Die Verbindung zu AEGIS ist nicht eingerichtet. Installiere AEGIS bzw. richte die Erweiterung im AEGIS-Setup ein.',
    forbidden: 'Die Verbindung wurde abgelehnt: Am anderen Ende sitzt nicht die AEGIS-App.',
    rate_limited: 'Zu viele Abrufe in kurzer Zeit. Warte eine Minute.',
    no_match: 'Dieser Login gehört nicht zu dieser Seite.',
    invalid: 'Unerwartete Antwort. Bitte AEGIS aktualisieren.',
  } satisfies Record<ErrorCode, string>,
  popupLead: 'Logins für',
  popupFill: 'Einsetzen',
  popupFilled: 'Eingesetzt.',
  popupNoField: 'Auf dieser Seite gibt es kein deutlich sichtbares Passwortfeld.',
  popupNoPage:
    'Auf dieser Seite kann die Erweiterung nicht ausfüllen (keine Webseite oder vor der Installation geöffnet – dann neu laden).',
  popupHonest:
    'Die Erweiterung speichert nichts: Logins kommen nur aus dem entsperrten AEGIS-Tresor und nur für die Seite, auf der du gerade bist.',
};

type Texts = typeof de;

const en: Texts = {
  button: 'Insert login from AEGIS',
  menuTitle: 'AEGIS Vault',
  loading: 'Asking AEGIS …',
  none: 'No saved login for this site.',
  noUser: '(no username)',
  insecure: 'Warning: this site does not use HTTPS. The password could be read in transit.',
  close: 'Close',
  hidden: 'Not filled: the field is not clearly visible or the page changed the AEGIS display.',
  error: {
    locked: 'The vault is locked. Unlock it in the AEGIS app and try again.',
    app_not_running: 'AEGIS is not running. Start the AEGIS app and unlock the vault.',
    host_missing:
      'The connection to AEGIS is not set up. Install AEGIS or set up the extension in AEGIS setup.',
    forbidden: 'The connection was refused: the other end is not the AEGIS app.',
    rate_limited: 'Too many requests in a short time. Wait a minute.',
    no_match: 'This login does not belong to this site.',
    invalid: 'Unexpected answer. Please update AEGIS.',
  },
  popupLead: 'Logins for',
  popupFill: 'Insert',
  popupFilled: 'Inserted.',
  popupNoField: 'There is no clearly visible password field on this page.',
  popupNoPage:
    'The extension cannot fill on this page (not a web page, or opened before installing – reload it then).',
  popupHonest:
    'The extension stores nothing: logins come only from the unlocked AEGIS vault and only for the site you are on.',
};

/** Texte passend zur Browser-Sprache. */
export function texts(language: string): Texts {
  return language.toLowerCase().startsWith('de') ? de : en;
}
