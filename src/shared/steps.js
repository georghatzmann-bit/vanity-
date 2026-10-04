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
    // Passwort & Sicherheit (Zwei-Faktor-Authentifizierung einrichten/prüfen)
    password: de(EPIC + '/account/password'),
    twoFaArticle: de(HELP + '/c-202300000001645/c-202300000001755/what-two-factor-authentication-2fa-methods-are-available-to-use-with-my-epic-games-account-a202300000022083'),
    // Anmeldung, Abmelden, Passwort vergessen, "kein Zugriff auf diese E-Mail"
    forgotPassword: de(EPIC + '/id/login/forgot-password'),
    logout: EPIC + '/id/logout',
    lostTwoFa: de(EPIC + '/id/login/recovery/original-email'),
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
  ];

  // Kurze Anleitung in 6 Schritten: Konto über Authenticator + SMS zurückholen,
  // wenn der Hacker die E-Mail-Adresse geändert hat.
  const STEPS = [
    // ---------------- Vorbereiten ----------------
    {
      id: 'twofa-setup',
      phase: 'prepare',
      title: 'SMS und Authenticator einrichten',
      why: 'Mit zwei Sicherheitsmethoden – einer Authenticator-App und einer SMS-Nummer – kannst du dein Konto auch ohne Zugriff auf dein Postfach zurückholen.',
      todo: [
        'Öffne "Passwort und Sicherheit". Die Seite öffnet sich mit dem Knopf unten.',
        'Richte unter "Zwei-Faktor-Authentifizierung" eine Authenticator-App ein (z. B. Epic Games App, Google oder Microsoft Authenticator).',
        'Richte zusätzlich SMS (Bestätigung per Textnachricht) mit deiner Handynummer ein.',
        'Schreib dir die Ersatz-Codes auf und bewahre sie sicher auf.',
      ],
      url: URLS.password,
      urlLabel: 'Epic: Passwort und Sicherheit',
      links: [{ label: 'Welche 2FA-Arten gibt es?', url: URLS.twoFaArticle }],
    },
    {
      id: 'email-2fa-off',
      phase: 'prepare',
      title: 'E-Mail-Bestätigung (E-Mail-2FA) ausschalten',
      why: 'Ist die Bestätigung per E-Mail an, schickt Epic beim Zurückholen wieder einen Code an die (vielleicht gekaperte) alte Adresse. Deshalb muss sie aus sein.',
      todo: [
        'Bleib auf "Passwort und Sicherheit".',
        'Schau bei der Zwei-Faktor-Authentifizierung nach, ob "E-Mail" als Methode an ist.',
        'Wenn ja: schalte die E-Mail-Methode aus. Authenticator und SMS bleiben an.',
      ],
      url: URLS.password,
      urlLabel: 'Epic: Passwort und Sicherheit',
    },

    // ---------------- Konto zurückholen ----------------
    {
      id: 'forgot',
      phase: 'recover',
      title: 'Abmelden und auf "Passwort vergessen"',
      why: 'Jetzt holst du das Konto zurück. Melde dich zuerst ab, damit du nicht aus Versehen in einem anderen Konto bist.',
      todo: [
        'Melde dich bei Epic ab (Link unten).',
        'Klick auf "Anmelden" und dann auf "Passwort vergessen".',
        'Gib deine alte E-Mail-Adresse ein – die, die vor dem Hack im Konto war.',
      ],
      url: URLS.forgotPassword,
      urlLabel: 'Epic: Passwort vergessen',
      links: [{ label: 'Bei Epic abmelden', url: URLS.logout }],
      data: ['email_original'],
    },
    {
      id: 'lost-access',
      phase: 'recover',
      title: '"Kein Zugriff auf diese E-Mail" wählen',
      why: 'So sagst du Epic, dass du nicht mehr an die alte E-Mail-Adresse kommst – und dich stattdessen mit deinen 2FA-Codes ausweist.',
      todo: [
        'Klick auf der nächsten Seite auf "Ich habe keinen Zugriff mehr auf diese E-Mail-Adresse" (englisch "I no longer have access to this email address").',
      ],
      url: URLS.lostTwoFa,
      urlLabel: 'Epic: Kein Zugriff auf die E-Mail',
    },
    {
      id: 'codes',
      phase: 'recover',
      title: 'Codes aus Authenticator und SMS eingeben',
      why: 'Mit den beiden Codes beweist du Epic, dass das Konto dir gehört.',
      todo: [
        'Gib den Code aus deiner Authenticator-App ein.',
        'Gib den Code aus der SMS ein.',
        'Hast du einen der Codes nicht? Nimm einen deiner aufgeschriebenen Ersatz-Codes.',
      ],
    },
    {
      id: 'new-email',
      phase: 'recover',
      title: 'Neue E-Mail-Adresse eintragen',
      why: 'Zum Schluss trägst du deine neue, sichere E-Mail-Adresse ein. Damit gehört das Konto wieder dir.',
      todo: [
        'Trag eine neue E-Mail-Adresse ein, auf die nur du Zugriff hast und die mit keinem anderen Epic-Konto verbunden ist.',
        'Bestätige sie mit dem Code, den Epic an die neue Adresse schickt.',
        'Ändere danach dein Passwort und prüfe deine verknüpften Konten.',
      ],
      inputs: ['email_new'],
    },
  ];

  // Allgemeine Sicherheitstipps (Anzeige im Abschluss und in der Seitenleiste)
  const TIPS = [
    'Gib niemals dein Passwort oder Codes weiter, auch nicht an angebliche Epic-Mitarbeiter.',
    'Echte Epic-Mails kommen nur von Adressen wie …@acct.epicgames.com oder …@support.epicgames.com. Adressen wie …@epicgames-support.com sind Fälschungen.',
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
