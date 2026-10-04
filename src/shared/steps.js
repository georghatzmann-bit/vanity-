// Die Schritte zur Kontorettung. Jeder Schritt öffnet die passende offizielle Seite.
// Stand der Links: Oktober 2026 (Epic ändert seine Hilfe-Seiten gelegentlich).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KR_STEPS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Hängt "lang=de" an, damit Epic die Seite auf Deutsch zeigt.
  function de(url) {
    const hashAt = url.indexOf('#');
    const hash = hashAt >= 0 ? url.slice(hashAt) : '';
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
    if (/[?&]lang=/.test(base)) return url;
    return base + (base.includes('?') ? '&' : '?') + 'lang=de' + hash;
  }

  const EPIC = 'https://www.epicgames.com';
  const HELP = EPIC + '/help';

  const URLS = {
    compromisedArticle: HELP + '/de/c-202300000001645/c-202300000001755/mein-epic-konto-wurde-kompromittiert-und-ich-kann-nicht-mehr-darauf-zugreifen-a202300000010592',
    invoiceArticle: de(HELP + '/c-202300000001642/c-202300000001746/where-can-i-find-an-invoice-id-of-my-epic-games-purchase-a202300000016612'),
    forgotPassword: de(EPIC + '/id/login/forgot-password'),
    login: de(EPIC + '/id/login'),
    recoveryRequestArticle: de(HELP + '/c-202300000001645/c-202300000001755/how-do-i-submit-an-account-recovery-request-a202300000085779'),
    recoveryIdArticle: de(HELP + '/c-202300000001645/c-202300000001755/where-can-i-find-the-recovery-id-for-the-recovery-process-of-my-epic-games-account-a202300000011680'),
    recoveryStatusArticle: de(HELP + '/c-202300000001645/c-202300000001755/how-do-i-check-the-status-of-my-account-recovery-a202300000022568'),
    noResponseArticle: de(HELP + '/c-202300000001645/c-202300000001755/i-have-not-received-a-response-to-my-account-recovery-request-a202300000017087'),
    appealArticle: de(HELP + '/c-202300000001645/c-202300000001755/how-can-i-appeal-my-account-recovery-request-decision-a202300000012035'),
    deniedArticle: de(HELP + '/c-202300000001645/c-202300000001755/why-was-my-account-recovery-request-denied-a202300000012540'),
    contactUs: de(HELP + '/en-US/contact-us'),
    ticketsArticle: de(HELP + '/account-c-202300000001645/account-services-c-202300000001752/how-to-view-and-manage-your-epic-games-support-tickets-a202300000014119'),
    password: de(EPIC + '/account/password'),
    signOutArticle: de(HELP + '/c-202300000001645/c-202300000001755/how-do-i-sign-out-of-all-devices-and-all-signed-in-sessions-for-my-epic-games-account-a202300000014282'),
    twoFaArticle: de(HELP + '/c-202300000001645/c-202300000001755/what-two-factor-authentication-2fa-methods-are-available-to-use-with-my-epic-games-account-a202300000022083'),
    personal: de(EPIC + '/account/personal'),
    connections: de(EPIC + '/account/connections'),
    apps: de(EPIC + '/account/connections#apps'),
    transactions: de(EPIC + '/account/transactions'),
    payment: de(EPIC + '/account/payment-management'),
    vbucksArticle: de(HELP + '/en-US/fortnite-battle-royale-c-202300000001636/billing-and-payment-c-202300000001723/how-can-i-check-how-i-ve-spent-v-bucks-in-fortnite-a202300000015005'),
    downloadDataArticle: de(HELP + '/en-US/c-Category_EpicAccount/c-EpicAccountServices/how-do-i-download-my-account-data-a000086239'),
    stillAccessArticle: de(HELP + '/en-US/c-Category_EpicAccount/c-AccountSecurity/my-epic-account-was-compromised-but-i-still-can-access-it-a000085971'),
    realEpicArticle: de(HELP + '/account-c-45487929/account-security-c-38978022/how-can-i-check-if-it-is-really-epic-games-contacting-me-a17080747'),
    status: 'https://status.epicgames.com/',
  };

  // Sicherheitsseiten der großen E-Mail-Anbieter (Schritt 1).
  const EMAIL_PROVIDERS = [
    { name: 'Gmail (Google)', domains: ['gmail.com', 'googlemail.com'], url: 'https://myaccount.google.com/security' },
    { name: 'Outlook / Hotmail (Microsoft)', domains: ['outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com'], url: 'https://account.microsoft.com/security' },
    { name: 'GMX', domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'], url: 'https://www.gmx.net/' },
    { name: 'WEB.DE', domains: ['web.de'], url: 'https://web.de/' },
    { name: 'T-Online', domains: ['t-online.de'], url: 'https://www.t-online.de/' },
    { name: 'iCloud (Apple)', domains: ['icloud.com', 'me.com', 'mac.com'], url: 'https://account.apple.com/' },
    { name: 'Yahoo', domains: ['yahoo.com', 'yahoo.de'], url: 'https://login.yahoo.com/account/security' },
    { name: 'Proton', domains: ['proton.me', 'protonmail.com', 'pm.me'], url: 'https://account.proton.me/' },
  ];

  function providerForEmail(email) {
    const m = /@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase());
    if (!m) return null;
    return EMAIL_PROVIDERS.find((p) => p.domains.includes(m[1])) || null;
  }

  const PHASES = [
    { key: 'prepare', title: 'Vorbereiten' },
    { key: 'recover', title: 'Konto zurückholen' },
    { key: 'secure', title: 'Konto absichern' },
  ];

  const STEPS = [
    // ---------------- Vorbereiten ----------------
    {
      id: 'email',
      phase: 'prepare',
      title: 'Zuerst dein E-Mail-Postfach sichern',
      why: 'Wer in dein Postfach kommt, kann dein Epic-Konto immer wieder übernehmen. Deshalb kommt das E-Mail-Konto zuerst.',
      todo: [
        'Melde dich bei deinem E-Mail-Anbieter an. Die Seite öffnet sich automatisch.',
        'Ändere dort das Passwort. Nimm ein neues, das du nirgendwo sonst benutzt.',
        'Schalte dort die Zwei-Faktor-Anmeldung (Bestätigung per App oder SMS) ein.',
        'Prüfe, ob in deinem Postfach eine fremde Weiterleitung oder ein fremder Filter eingerichtet ist, und lösche ihn.',
      ],
      url: URLS.compromisedArticle,
      urlLabel: 'Epic-Hilfe: Konto wurde gehackt',
      urlFromEmail: 'email_original',
      data: ['email_original'],
      inputs: ['email_original'],
      warnings: [
        { kind: 'warning', title: 'Kommst du nicht mehr in dein Postfach?', text: 'Dann hol zuerst das E-Mail-Konto über die "Passwort vergessen"-Funktion deines Anbieters zurück. Danach geht es hier weiter.' },
      ],
    },
    {
      id: 'evidence',
      phase: 'prepare',
      title: 'Beweise sammeln',
      why: 'Epic gibt das Konto nur zurück, wenn du zeigen kannst, dass es dir gehört. Je mehr du einträgst, desto besser.',
      todo: [
        'Hast du die Konto-PDF von Epic? Zieh sie unter "PDF auslesen" hinein. Die Daten werden automatisch erkannt.',
        'Such in deinem Postfach nach "Your Epic Games Receipt" oder "Epic Games-Beleg". Dort steht die Rechnungsnummer (Invoice-ID, beginnt mit A oder F).',
        'Trag unter "Meine Daten" alles ein, was du weißt: frühere Namen, E-Mail-Adressen, verknüpfte Konsolen, Zahlungsart.',
      ],
      url: URLS.invoiceArticle,
      urlLabel: 'Epic-Hilfe: Wo finde ich die Rechnungsnummer?',
      internal: [
        { label: 'PDF auslesen', view: 'pdf', icon: 'file' },
        { label: 'Meine Daten eintragen', view: 'data', icon: 'user' },
      ],
      data: ['account_id', 'display_name', 'invoice_ids', 'platforms'],
    },

    // ---------------- Konto zurückholen ----------------
    {
      id: 'reset',
      phase: 'recover',
      title: 'Passwort zurücksetzen',
      why: 'Wenn der Hacker nur das Passwort geändert hat, bist du damit in zwei Minuten wieder drin.',
      todo: [
        'Gib auf der Epic-Seite deine E-Mail-Adresse ein. Die Seite öffnet sich automatisch.',
        'Epic schickt dir einen Code per Mail. Gib ihn ein.',
        'Wähle ein neues, langes Passwort, das du nirgendwo sonst benutzt.',
        'Klappt es nicht, weil der Hacker die E-Mail-Adresse geändert hat? Dann einfach weiter zum nächsten Schritt.',
      ],
      url: URLS.forgotPassword,
      urlLabel: 'Epic: Passwort vergessen',
      data: ['email_original'],
      success: { label: 'Hat geklappt, ich bin wieder drin', jumpTo: 'password' },
    },
    {
      id: 'platform-login',
      phase: 'recover',
      title: 'Über PlayStation, Xbox, Nintendo und Co. anmelden',
      why: 'Ist dein Epic-Konto mit einer Konsole, Steam, Google oder Apple verbunden, kommst du darüber oft noch rein.',
      todo: [
        'Klick auf der Epic-Anmeldeseite auf das Symbol deiner Plattform (z. B. PlayStation).',
        'Melde dich dort mit deinem Konsolen-Konto an.',
        'Bist du drin? Dann sofort Passwort und E-Mail-Adresse ändern.',
        'Geht das nicht oder ist nichts verbunden? Weiter zum nächsten Schritt.',
      ],
      url: URLS.login,
      urlLabel: 'Epic: Anmelden',
      data: ['platforms'],
      success: { label: 'Hat geklappt, ich bin wieder drin', jumpTo: 'password' },
    },
    {
      id: 'recovery',
      phase: 'recover',
      title: 'Wiederherstellung bei Epic beantragen',
      why: 'Das ist der wichtigste Schritt. Mit dem Formular prüft Epic, dass das Konto dir gehört, und gibt es dir zurück.',
      todo: [
        'Schalte VPN oder Proxy aus. Nimm deinen normalen PC und dein WLAN von zu Hause.',
        'Klick auf der Anmeldeseite unten auf "Probleme bei der Anmeldung?" und dann auf "Konto wiederherstellen".',
        'Gib deine neue sichere E-Mail-Adresse ein und bestätige sie mit dem Code, den Epic schickt.',
        'Fülle das Formular so vollständig wie möglich aus. Die Daten unten kannst du einzeln kopieren.',
        'Prüfe alles und klick auf "Absenden".',
      ],
      url: URLS.login,
      urlLabel: 'Epic: Anmelden > Probleme bei der Anmeldung?',
      links: [{ label: 'Epic-Anleitung zum Formular', url: URLS.recoveryRequestArticle }],
      data: ['email_new', 'account_id', 'invoice_ids', 'email_original', 'emails_old', 'display_name', 'display_name_original', 'display_names_old', 'first_name', 'last_name', 'country', 'phone', 'platforms', 'payment_method'],
      inputs: ['email_new'],
      warnings: [
        { kind: 'warning', title: 'Nur eine Anfrage schicken', text: 'Mehrere Anfragen machen nichts schneller, sondern verzögern die Prüfung.' },
        { kind: 'info', title: 'Noch mit einem anderen Epic-Konto angemeldet?', text: 'Dann vorher abmelden oder ein privates Browserfenster öffnen (Strg + Umschalt + N) und den Link dort einfügen.' },
      ],
    },
    {
      id: 'recovery-id',
      phase: 'recover',
      title: 'Wiederherstellungs-ID aufschreiben',
      why: 'Mit dieser Nummer kannst du den Stand prüfen und Einspruch einlegen. Ohne sie musst du von vorne anfangen.',
      todo: [
        'Öffne die Mail "Your Epic account recovery request" in deinem NEUEN Postfach. Schau auch im Spam-Ordner.',
        'Kopiere die Recovery ID aus der Mail.',
        'Füge sie unten ein. Sie wird automatisch gespeichert.',
      ],
      url: URLS.recoveryIdArticle,
      urlLabel: 'Epic-Hilfe: Wo finde ich die Recovery ID?',
      data: ['email_new'],
      inputs: ['recovery_id'],
      warnings: [
        { kind: 'danger', title: 'Vorsicht vor falschen Mails', text: 'Echte Epic-Mails kommen nur von Adressen, die auf "epicgames.com" enden, z. B. @support.epicgames.com oder @acct.epicgames.com.' },
      ],
    },
    {
      id: 'status',
      phase: 'recover',
      title: 'Stand prüfen und warten',
      why: 'Epic antwortet meistens innerhalb von 48 Stunden, manchmal dauert es ein paar Tage.',
      todo: [
        'Klick in der Epic-Mail auf "Check your account recovery status" oder folge der Anleitung auf der Epic-Seite.',
        'Gib dort deine Recovery ID ein.',
        'Schick in der Zwischenzeit KEINE zweite Anfrage und KEIN Support-Ticket.',
        'Wurde dein Konto zurückgegeben? Dann geht es mit "Konto absichern" weiter.',
      ],
      url: URLS.recoveryStatusArticle,
      urlLabel: 'Epic-Hilfe: Stand der Wiederherstellung',
      links: [{ label: 'Keine Antwort nach 48 Stunden?', url: URLS.noResponseArticle }],
      data: ['recovery_id', 'email_new'],
      success: { label: 'Konto ist zurück, weiter zum Absichern', jumpTo: 'password' },
    },
    {
      id: 'appeal',
      phase: 'recover',
      optional: true,
      title: 'Abgelehnt? Einspruch einlegen',
      why: 'Nur nötig, wenn Epic deine Anfrage abgelehnt hat. Du hast 14 Tage Zeit und nur einen Versuch.',
      todo: [
        'Klick in der Ablehnungs-Mail auf "appeal this decision".',
        'Ergänze mehr Beweise: weitere Rechnungsnummern, frühere Namen, verknüpfte Konten.',
        'Sind mehr als 14 Tage vergangen? Dann stell eine neue Wiederherstellungsanfrage (Schritt "Wiederherstellung beantragen").',
      ],
      url: URLS.appealArticle,
      urlLabel: 'Epic-Hilfe: Einspruch einlegen',
      links: [{ label: 'Warum wurde meine Anfrage abgelehnt?', url: URLS.deniedArticle }],
      data: ['recovery_id', 'invoice_ids', 'platforms', 'display_names_old', 'emails_old'],
    },
    {
      id: 'support',
      phase: 'recover',
      optional: true,
      title: 'Nur wenn nötig: Epic-Support anschreiben',
      why: 'Wenn das Formular nicht weiterhilft oder fremde Käufe passiert sind, schreibst du den Support an. Der fertige Text liegt im Bereich "Support-Text".',
      todo: [
        'Erstelle den Text unter "Support-Text" und kopiere ihn.',
        'Wähle auf der Epic-Seite "Konto" als Thema und füge den Text ein.',
        'Öffne nur EIN Ticket. Antworte später immer im selben Ticket.',
        'Trag die Ticketnummer aus der Bestätigungsmail unten ein.',
      ],
      url: URLS.contactUs,
      urlLabel: 'Epic: Support kontaktieren',
      links: [{ label: 'So verwaltest du deine Tickets', url: URLS.ticketsArticle }],
      internal: [{ label: 'Support-Text erstellen', view: 'support', icon: 'message' }],
      data: ['recovery_id', 'account_id', 'display_name'],
      inputs: ['ticket_number'],
      warnings: [
        { kind: 'danger', title: 'Niemals Passwort oder Codes weitergeben', text: 'Auch nicht an "Epic-Mitarbeiter" auf Discord, TikTok oder Instagram. Epic fragt nie nach deinem Passwort.' },
      ],
    },

    // ---------------- Konto absichern ----------------
    {
      id: 'password',
      phase: 'secure',
      title: 'Neues Passwort setzen',
      why: 'Sobald du wieder drin bist, muss ein Passwort her, das der Hacker nicht kennt.',
      todo: [
        'Melde dich bei Epic an. Die Seite "Passwort und Sicherheit" öffnet sich automatisch.',
        'Ändere das Passwort. Nimm ein langes, neues Passwort, das du nirgendwo sonst benutzt.',
        'Am besten speicherst du es in einem Passwort-Manager.',
      ],
      url: URLS.password,
      urlLabel: 'Epic: Passwort und Sicherheit',
    },
    {
      id: 'signout',
      phase: 'secure',
      title: 'Überall abmelden',
      why: 'Damit fliegt der Hacker von allen Geräten, Konsolen und Browsern raus.',
      todo: [
        'Scroll auf derselben Seite nach unten zu "Überall abmelden".',
        'Klick auf "Abmelden" und gib den Code aus der Mail ein.',
      ],
      url: URLS.password,
      urlLabel: 'Epic: Passwort und Sicherheit',
      links: [{ label: 'Epic-Anleitung: Überall abmelden', url: URLS.signOutArticle }],
    },
    {
      id: 'twofa',
      phase: 'secure',
      title: 'Zwei-Faktor-Schutz einschalten',
      why: 'Mit Zwei-Faktor-Schutz reicht ein gestohlenes Passwort nicht mehr. Der Hacker bräuchte zusätzlich dein Handy.',
      todo: [
        'Such auf derselben Seite "Zwei-Faktor-Authentifizierung".',
        'Am sichersten: eine Authenticator-App (z. B. Epic Games App, Google oder Microsoft Authenticator). SMS oder E-Mail gehen auch.',
        'Klick auf "Einrichten" und folge den Anweisungen.',
        'Schreib die Ersatz-Codes auf Papier und bewahre sie sicher auf.',
      ],
      url: URLS.password,
      urlLabel: 'Epic: Passwort und Sicherheit',
      links: [{ label: 'Welche 2FA-Arten gibt es?', url: URLS.twoFaArticle }],
    },
    {
      id: 'personal',
      phase: 'secure',
      title: 'E-Mail, Name und Konto-ID prüfen',
      why: 'Der Hacker hat vielleicht deine E-Mail-Adresse oder deinen Namen geändert.',
      todo: [
        'Prüfe E-Mail-Adresse, Anzeigename, Vor- und Nachname und Land.',
        'Stell alles zurück, was der Hacker geändert hat, und bestätige deine E-Mail-Adresse.',
        'Kopiere deine Konto-ID und trag sie unter "Meine Daten" ein, falls sie noch fehlt.',
      ],
      url: URLS.personal,
      urlLabel: 'Epic: Kontoeinstellungen',
      data: ['email_new', 'display_name', 'first_name', 'last_name', 'country'],
      inputs: ['account_id'],
    },
    {
      id: 'connections',
      phase: 'secure',
      title: 'Verknüpfte Konten prüfen',
      why: 'Über ein fremdes verknüpftes Konto könnte der Hacker wieder reinkommen.',
      todo: [
        'Schau dir die Liste der verknüpften Konten an (PlayStation, Xbox, Nintendo, Steam, Google ...).',
        'Gehört eins nicht dir? Klick dort auf "Trennen".',
        'Verbinde danach deine eigenen Konten wieder, falls nötig.',
      ],
      url: URLS.connections,
      urlLabel: 'Epic: Apps und Konten',
      data: ['platforms'],
    },
    {
      id: 'apps',
      phase: 'secure',
      title: 'Fremde Apps entfernen',
      why: 'Apps und Webseiten mit Zugriff auf dein Konto können ein Einfallstor sein.',
      todo: [
        'Wechsle auf derselben Seite zum Reiter "Apps".',
        'Entferne alles, was du nicht kennst oder nicht selbst erlaubt hast.',
      ],
      url: URLS.apps,
      urlLabel: 'Epic: Apps',
    },
    {
      id: 'transactions',
      phase: 'secure',
      title: 'Käufe prüfen',
      why: 'Fremde Käufe solltest du schnell melden, möglichst innerhalb von 90 Tagen.',
      todo: [
        'Geh alle Käufe und eingelösten Codes durch.',
        'Für jeden fremden Kauf: Datum und Rechnungsnummer notieren und einen Screenshot machen.',
        'Melde fremde Käufe im Support-Ticket (Bereich "Support-Text").',
      ],
      url: URLS.transactions,
      urlLabel: 'Epic: Transaktionen',
      data: ['invoice_ids'],
      warnings: [
        { kind: 'warning', title: 'Keine Rückbuchung bei der Bank ohne Epic', text: 'Eine Rückbuchung ohne vorherigen Kontakt zu Epic kann dazu führen, dass dein Konto für Käufe gesperrt wird.' },
      ],
    },
    {
      id: 'payment',
      phase: 'secure',
      title: 'Gespeicherte Zahlungsarten prüfen',
      why: 'Unbekannte Karten oder PayPal-Konten im Konto müssen raus.',
      todo: [
        'Lösche Karten oder PayPal-Konten, die du nicht kennst oder nicht mehr willst.',
        'Schau auf deinem Kontoauszug oder bei PayPal nach fremden Abbuchungen von Epic Games.',
      ],
      url: URLS.payment,
      urlLabel: 'Epic: Zahlungsverwaltung',
      data: ['payment_method'],
    },
    {
      id: 'vbucks',
      phase: 'secure',
      title: 'V-Bucks und Fortnite-Käufe prüfen',
      why: 'So siehst du, ob der Hacker V-Bucks ausgegeben hat.',
      todo: [
        'Starte Fortnite und schau, wie viele V-Bucks du noch hast.',
        'Unter Profil > Support und Rückerstattungen siehst du die Käufe der letzten 30 Tage.',
        'Fremde Käufe trotzdem im Support-Ticket melden. Epic ersetzt bei Hacks aber meistens nichts.',
      ],
      url: URLS.vbucksArticle,
      urlLabel: 'Epic-Hilfe: V-Bucks-Ausgaben prüfen',
    },
    {
      id: 'download-data',
      phase: 'secure',
      title: 'Konto-PDF für später sichern',
      why: 'Die PDF ist ein guter Beweis, falls dein Konto noch einmal gehackt wird.',
      todo: [
        'Scroll in den Kontoeinstellungen nach unten zu "Kontoinformationen herunterladen".',
        'Klick auf "Download anfordern". Wenn die Mail kommt, lädst du die Datei herunter.',
        'Zieh die PDF danach unter "PDF auslesen" hinein und heb sie gut auf.',
      ],
      url: URLS.personal,
      urlLabel: 'Epic: Kontoeinstellungen',
      links: [{ label: 'Epic-Anleitung: Kontodaten herunterladen', url: URLS.downloadDataArticle }],
      internal: [{ label: 'PDF auslesen', view: 'pdf', icon: 'file' }],
    },
    {
      id: 'platforms-secure',
      phase: 'secure',
      title: 'Auch Konsolen- und andere Konten absichern',
      why: 'Über PlayStation, Xbox, Nintendo, Steam oder Google kann der Hacker sonst wieder in dein Epic-Konto kommen.',
      todo: [
        'Ändere bei jedem verknüpften Konto das Passwort, wenn du es mehrfach benutzt hast.',
        'Schalte überall die Zwei-Faktor-Anmeldung ein.',
        'Benutze ab jetzt für jedes Konto ein eigenes Passwort.',
      ],
      url: URLS.stillAccessArticle,
      urlLabel: 'Epic-Hilfe: Konto absichern',
      data: ['platforms'],
    },
  ];

  // Allgemeine Sicherheitstipps (Anzeige im Abschluss und in der Seitenleiste)
  const TIPS = [
    'Gib niemals dein Passwort oder Codes weiter, auch nicht an angebliche Epic-Mitarbeiter.',
    'Echte Epic-Mails kommen nur von Adressen, die auf "epicgames.com" enden.',
    'Es gibt keine Gratis-V-Bucks. Solche Seiten stehlen Konten.',
  ];

  function stepById(id) {
    return STEPS.find((s) => s.id === id) || null;
  }

  function indexOf(id) {
    return STEPS.findIndex((s) => s.id === id);
  }

  return { STEPS, PHASES, URLS, EMAIL_PROVIDERS, TIPS, providerForEmail, stepById, indexOf, de };
});
