/**
 * Deutsche Texte – die Quelle aller Oberflächen-Texte (auch `aria-label`s).
 * `en.ts` ist gegen diese Form typisiert. Platzhalter: `{name}`; Mehrzahl: `{ one, other }`.
 *
 * Ehrlichkeit: Was es noch nicht gibt, heißt hier „folgt in Pn“ – keine Beispiel- oder
 * Schätzwerte. Phasen laut docs/PROGRESS.md.
 */
export const de = {
  app: {
    suite: 'AEGIS Suite',
    skipToContent: 'Zum Inhalt springen',
    pageAnnouncement: 'Seite: {page}',
    documentTitle: '{page} · AEGIS',
  },
  boot: {
    skip: 'Überspringen',
    status: 'AEGIS wird gestartet',
  },
  keys: {
    ctrl: 'Strg',
  },
  phase: {
    comingIn: 'Folgt in {phase}',
    comingInShort: 'folgt in {phase}',
  },
  titlebar: {
    label: 'Titelleiste',
    search: 'Befehl oder Seite suchen …',
    windowControls: 'Fenster',
    minimize: 'Minimieren',
    maximize: 'Maximieren',
    restore: 'Wiederherstellen',
    close: 'AEGIS beenden',
    closeToTray: 'Schließen – AEGIS läuft im Infobereich weiter',
    preview: 'Browser-Vorschau',
    previewHint:
      'Läuft ohne Desktop-App: Fensterknöpfe, Infobereich und Systemwerte gibt es hier nicht.',
  },
  nav: {
    label: 'Hauptnavigation',
    collapse: 'Navigation einklappen',
    expand: 'Navigation ausklappen',
    groups: {
      overview: 'Übersicht',
      protection: 'Schutz',
      system: 'System',
      privacy: 'Privatsphäre & Tools',
      app: 'App',
    },
  },
  statusbar: {
    label: 'Statuszeile',
    golden: 'Goldene Regel: nichts ohne dein Ja',
    version: 'Version {version}',
    desktop: 'Desktop-App',
    preview: 'Browser-Vorschau',
    build: {
      debug: 'Entwicklung',
      release: 'Release',
    },
  },
  pages: {
    dashboard: {
      nav: 'Dashboard',
      title: 'Dashboard',
      eyebrow: 'Übersicht',
      description:
        'Der Stand deines Schutzes – ehrlich: Was noch nicht gebaut ist, steht hier als „Folgt in …“.',
    },
    scan: {
      nav: 'Scan',
      title: 'Scan',
      eyebrow: 'Schutz',
      tagline: 'Dateien und Ordner auf Schadsoftware prüfen',
      summary:
        'Prüft Dateien und Ordner mit ClamAV (als getrenntem Prozess), Hash-Abgleich, YARA-Regeln und statischer Analyse. Funde werden gemeldet und erklärt – isoliert wird nur auf deinen Wunsch.',
    },
    realtime: {
      nav: 'Echtzeit-Wächter',
      title: 'Echtzeit-Wächter',
      eyebrow: 'Schutz',
      tagline: 'Neue und geänderte Dateien im Hintergrund beobachten',
      summary:
        'Beobachtet neue und geänderte Dateien im Hintergrund und warnt sofort. Ohne Kernel-Treiber erkennt und meldet AEGIS – es blockiert keine Programme vor dem Start.',
    },
    lab: {
      nav: 'Labor',
      title: 'Labor',
      eyebrow: 'Sandbox',
      tagline: 'Unbekannte Programme abgeschottet ausprobieren',
      summary:
        'Startet unbekannte Programme abgeschottet (Windows-Sandbox oder Mini-Sandbox) und zeigt in einem Verhaltensbericht, was sie versuchen.',
    },
    network: {
      nav: 'Netzwerk',
      title: 'Netzwerk',
      eyebrow: 'System',
      tagline: 'Verbindungen, Firewall und Heimnetz im Blick',
      summary:
        'Zeigt Verbindungen und Firewall-Regeln, prüft dein Heimnetz auf Lecks und warnt vor gefährlichen Webseiten (Web-Schutz).',
    },
    hardening: {
      nav: 'Härtung',
      title: 'Härtung',
      eyebrow: 'System',
      tagline: 'Windows-Einstellungen prüfen und verbessern',
      summary:
        'Prüft Windows-Einstellungen, Autostart-Einträge und Treiber und schlägt Verbesserungen vor – daraus entsteht der Sicherheits-Score. Geändert wird nur mit deinem Ja.',
    },
    vault: {
      nav: 'Tresor',
      title: 'Tresor',
      eyebrow: 'Privatsphäre',
      tagline: 'Passwörter sicher und lokal aufbewahren',
      summary:
        'Ein Passwort-Tresor mit eigener Browser-Erweiterung. Die Daten bleiben verschlüsselt auf deinem Gerät.',
    },
    tools: {
      nav: 'Tools',
      title: 'Tools',
      eyebrow: 'Privatsphäre & Tools',
      tagline: 'Helfer für Windows-Aufgaben nach deinen Regeln',
      summary:
        'Werkzeuge für Windows-Aufgaben wie Aufräumen und Sortieren. Sie handeln nur nach Regeln, die du anlegst und einschaltest – immer mit Vorschau, Protokoll und Rückgängig.',
    },
    quarantine: {
      nav: 'Quarantäne',
      title: 'Quarantäne',
      eyebrow: 'Schutz',
      tagline: 'Isolierte Dateien ansehen und wiederherstellen',
      summary:
        'Verdächtige Dateien landen verschlüsselt in der Quarantäne – nur nach deinem Ja. Von dort lassen sie sich wiederherstellen; endgültiges Löschen braucht eine zweite Bestätigung.',
    },
    reports: {
      nav: 'Berichte',
      title: 'Berichte',
      eyebrow: 'Übersicht',
      tagline: 'Scans, Funde und Entscheidungen nachlesen',
      summary:
        'Fasst Scans, Funde und deine Entscheidungen verständlich zusammen. Jede Freigabe steht zusätzlich im Prüfprotokoll des Dienstes, das sich nicht unbemerkt ändern lässt.',
    },
    settings: {
      nav: 'Einstellungen',
      title: 'Einstellungen',
      eyebrow: 'App',
      description: 'Änderungen wirken sofort – ohne Neustart.',
    },
    about: {
      nav: 'Über AEGIS',
      title: 'Über AEGIS',
      eyebrow: 'App',
      description: 'Defensiver Virenschutz und Sicherheits-Werkzeugkasten für Windows 10 und 11.',
    },
  },
  placeholder: {
    note: 'Bis dahin zeigt AEGIS hier bewusst nichts an – keine Beispiel- oder Schätzwerte.',
    golden: 'Auch dann gilt die Goldene Regel: AEGIS verändert nichts ohne dein Ja.',
  },
  dashboard: {
    honesty: {
      label: 'Ehrliche Hinweise',
      kernelTitle: 'Ehrlich gesagt',
      kernel:
        'AEGIS hat keinen Kernel-Treiber. Es erkennt, warnt und isoliert auf Wunsch – es blockiert keine Programme vor dem Start.',
      goldenTitle: 'Goldene Regel',
      golden: 'AEGIS ändert nichts ohne dein Ja.',
    },
    score: {
      eyebrow: 'Bewertung',
      title: 'Sicherheits-Score',
      label: 'Sicherheits-Score',
      unavailable: 'Kein Messwert',
      hint: 'Noch nicht bewertet – die Systemprüfungen folgen in P6.',
      outOf: 'von 100',
      bands: {
        low: 'Kritisch',
        medium: 'Verbesserungswürdig',
        high: 'Gut',
      },
    },
    modules: {
      eyebrow: 'Status',
      title: 'Schutz-Module',
      unavailable: 'Nicht verfügbar',
      previewOnly: 'Nur in der Windows-App mit Dienst',
      checking: 'Prüfe …',
      down: 'Dienst nicht erreichbar',
      downHint: 'Ohne Dienst kein Schutz – bitte AEGIS neu installieren oder den Dienst starten.',
      ready: 'Bereit',
      withClamav: 'Engine, YARA-X und ClamAV',
      noClamav: 'Engine und YARA-X (ClamAV nicht installiert)',
      active: 'Aktiv',
      off: 'Aus',
      gaming: 'Gaming-Modus',
      gamingHint: 'Pausiert – endet spätestens nach 4 Stunden',
      signatures: 'Signaturen & Engine',
      realtime: 'Echtzeit-Wächter',
      ransomware: 'Ransomware-Schutz',
      network: 'Netzwerk-Schutz',
      footer: 'Gebaute Module zeigen ihren echten Zustand; Ransomware- und Netzwerk-Schutz folgen.',
    },
    build: {
      eyebrow: 'Aufbau',
      title: 'AEGIS entsteht',
      summary: 'Phase {current} von {last}: {name}',
      lead: 'Das Fundament steht. Die Schutz-Module kommen Schritt für Schritt – jedes erst, wenn es wirklich funktioniert.',
      progressLabel: 'Bauplan',
      current: 'in Arbeit',
      next: 'Als Nächstes',
      phases: {
        P0: 'Fundament',
        P1: 'Oberfläche',
        P2: 'Scan-Engine & Quarantäne',
        P3: 'Echtzeit-Wächter & Berichte',
        P4: 'Labor (Sandbox)',
        P5: 'Notfall-Scan & Ransomware-Schutz',
        P6: 'Härtung & Score',
        P7: 'Netzwerk & Web-Schutz',
        P8: 'Defender-Schalter',
        P9: 'Tresor',
        P10: 'Tools 1–11',
        P11: 'Tools 12–22',
        P12: 'Privacy-Browser',
        P13: 'Setup & Updates',
      },
    },
    activity: {
      eyebrow: 'Diese Sitzung',
      title: 'Live-Aktivität',
      showAll: 'Alle anzeigen',
      showLess: 'Weniger anzeigen',
      count: { one: '{count} Ereignis', other: '{count} Ereignisse' },
      footer:
        'Nur Ereignisse der Oberfläche. Schutz-Ereignisse wie Funde und Scans folgen mit dem Dienst ab P2.',
      events: {
        appStarted: 'AEGIS gestartet',
        settingChanged: '{setting}: {value}',
        bootReplayed: 'Start-Animation abgespielt',
        trayNavigate: 'Über den Infobereich geöffnet: {page}',
        saveFailed: 'Einstellungen nicht gespeichert – sie gelten bis zum Beenden',
      },
    },
    quick: {
      eyebrow: 'Aktionen',
      title: 'Schnellzugriff',
      emergency: 'Notfall-Scan',
      emergencyHint: 'Der Notfall-Scan (Panic-Button) folgt in P5.',
      replayBoot: 'Start-Animation erneut abspielen',
      palette: 'Befehlspalette',
      settings: 'Einstellungen',
    },
  },
  settings: {
    sections: {
      appearance: 'Sprache & Darstellung',
      feedback: 'Klang & Bewegung',
      window: 'Start & Fenster',
      about: 'Version',
    },
    state: {
      on: 'an',
      off: 'aus',
    },
    current: 'Gerade: {value}',
    language: {
      label: 'Sprache',
      description: '„System“ folgt der Sprache von Windows.',
      system: 'System',
      de: 'Deutsch',
      en: 'English',
    },
    theme: {
      label: 'Darstellung',
      description: '„System“ folgt der Windows-Einstellung für helle oder dunkle Apps.',
      system: 'System',
      dark: 'Dunkel',
      light: 'Hell',
    },
    sound: {
      label: 'Klang',
      description:
        'Dezente Töne, etwa beim Einschalten des Klangs und beim erneuten Abspielen der Start-Animation. Beim Öffnen von AEGIS bleibt es still.',
    },
    motion: {
      label: 'Bewegung',
      description:
        '„Reduziert“ schaltet Animationen in der ganzen App ab – auch die Start-Animation.',
      system: 'System',
      reduced: 'Reduziert',
      systemReduced: 'System: reduziert',
      systemNormal: 'System: normal',
    },
    boot: {
      label: 'Start-Animation beim Start zeigen',
      description: 'Das Logo zeichnet sich beim Öffnen von AEGIS (etwa 1,5 Sekunden).',
    },
    closeToTray: {
      label: 'Beim Schließen in den Infobereich',
      description:
        'Der Schließen-Knopf versteckt das Fenster, AEGIS läuft im Infobereich weiter. Alt+F4 beendet AEGIS vollständig.',
      unavailable:
        'Hier nicht verfügbar: Es gibt kein Symbol im Infobereich, über das AEGIS zurückkäme. Der Schließen-Knopf beendet AEGIS deshalb vollständig.',
    },
    persistence: {
      memoryOnly:
        'Die Einstellungen lassen sich gerade nicht speichern. Sie gelten, bis AEGIS beendet wird.',
      newer:
        'Diese Einstellungen stammen von einer neueren AEGIS-Version. Damit nichts überschrieben wird, gelten Änderungen nur bis zum Beenden.',
    },
    about: {
      version: 'AEGIS {version}',
      more: 'Mehr über AEGIS',
    },
    saveFailedToast: 'Einstellungen nicht gespeichert',
    saveFailedToastDetail: 'Sie gelten, bis AEGIS beendet wird.',
  },
  about: {
    infoTitle: 'Version & Plattform',
    previewNote: 'Browser-Vorschau: Diese Werte stammen nicht aus der Desktop-App.',
    loading: 'Wird geladen …',
    error: 'Die App-Informationen konnten nicht gelesen werden.',
    unknown: 'unbekannt',
    fields: {
      version: 'Version',
      build: 'Build',
      platform: 'Plattform',
      osVersion: 'Betriebssystem-Version',
      arch: 'Architektur',
      tauri: 'Tauri',
    },
    build: {
      debug: 'Debug (Entwicklung)',
      release: 'Release',
    },
    platform: {
      windows: 'Windows',
      linux: 'Linux',
      macos: 'macOS',
      preview: 'Browser-Vorschau',
    },
    principlesTitle: 'Grundsätze',
    principles: {
      golden:
        'Goldene Regel: AEGIS verändert, verschiebt, beendet oder löscht nichts ohne dein Ja.',
      defensive: 'Rein defensiv: keine Angriffstechniken, keine fremden Passwörter.',
      kernel:
        'Kein Kernel-Treiber: AEGIS erkennt, warnt und isoliert auf Wunsch – es blockiert keine Programme vor dem Start.',
      privacy:
        'Keine Telemetrie: AEGIS sendet keine Nutzungsdaten. Schriften und Skripte sind lokal.',
    },
    fonts: 'Schriften: Inter und JetBrains Mono (SIL Open Font License 1.1), lokal gebündelt.',
  },
  palette: {
    groups: {
      pages: 'Seiten',
      actions: 'Aktionen',
    },
    themeToLight: 'Helle Darstellung',
    themeToDark: 'Dunkle Darstellung',
    languageSwitch: 'Sprache: English',
    soundOn: 'Klang einschalten',
    soundOff: 'Klang ausschalten',
    motionReduce: 'Bewegung reduzieren',
    motionSystem: 'Bewegung wie im System',
    replayBoot: 'Start-Animation abspielen',
    emergency: 'Notfall-Scan',
  },
  consentFlow: {
    nothingDone: 'Es wurde nichts verändert.',
    executed: 'Ausgeführt',
    partial: 'Teilweise ausgeführt',
    failed: 'Nicht ausgeführt',
    trusted: 'Vermerkt – nichts ausgeführt',
    serviceDown: 'Dienst nicht erreichbar',
    serviceDownHint:
      'Der Hintergrunddienst „aegis-service“ antwortet nicht. Ohne ihn kann AEGIS nicht prüfen oder isolieren – es wird nichts verändert.',
    previewOnly: 'Nur in der Desktop-App verfügbar',
    previewOnlyHint:
      'In der Browser-Vorschau gibt es keinen Dienst. Hier wird nichts geprüft und nichts verändert.',
    error: 'Fehler',
  },
  scanner: {
    intro:
      'Wähle Dateien oder einen Ordner. AEGIS prüft nur und erklärt die Funde – verändert wird nichts ohne dein Ja.',
    pickFiles: 'Dateien wählen …',
    pickFolder: 'Ordner wählen …',
    scanning: 'Prüfe …',
    result: 'Ergebnis',
    checked: '{count} Dateien geprüft · {notable} auffällig',
    clean: 'Nichts Auffälliges gefunden.',
    isolate: 'Isolieren …',
    why: 'Warum?',
    skipped: '{count} Einträge übersprungen (Links, Sonderdateien, nicht lesbar)',
    partial: 'Nur teilweise geprüft',
    confidence: 'Sicherheit {value} %',
    truncated: 'Abgebrochen: zu viele Dateien in einem Lauf.',
    contained: 'Auffällige Inhalte',
    trusted: 'Vertraut seit {date}',
  },
  realtime: {
    intro:
      'Beobachtet Downloads, Desktop, Temp und Wechseldatenträger sowie Programmstarts. Funde werden gemeldet – isoliert oder vertraut wird nur nach deinem Ja.',
    honest:
      'Ehrlich: Ohne Kernel-Treiber warnt AEGIS, sobald eine Datei auftaucht oder ein Programm startet – es blockiert nichts vor dem Start.',
    status: 'Zustand',
    active: 'Wächter läuft.',
    inactive: 'Wächter läuft nicht.',
    folders: '{count} Orte überwacht',
    processesOn: 'Programmstarts werden beobachtet',
    processesOff: 'Programmstarts werden nicht beobachtet',
    dropped:
      '{count} Dateien wegen Überlastung nicht geprüft – bitte einen manuellen Scan starten.',
    gaming: 'Gaming-Modus',
    gamingHint:
      'Pausiert Prüfungen und Hinweise, z. B. während eines Spiels. Endet spätestens nach 4 Stunden; danach wird nachgeprüft.',
    gamingLeft:
      'An – endet in spätestens {minutes} Minuten. Was solange ankommt, wird danach geprüft.',
    events: 'Meldungen',
    eventsHint: 'Neueste zuerst. Jede Aktion fragt vorher nach.',
    none: 'Keine Meldungen. Alles ruhig.',
    kindFile: 'Neue oder geänderte Datei',
    kindProcess: 'Programmstart',
    processNote: 'Das Programm läuft bereits – AEGIS kann es nicht vorab stoppen.',
    isolate: 'Isolieren …',
    trust: 'Vertrauen …',
    ignore: 'Ignorieren',
    more: 'Mehr Infos',
    toastTitle: 'Echtzeit-Wächter: {count} neue Meldung(en)',
    toastHint: 'Nichts wurde verändert. Sieh dir die Meldung an und entscheide selbst.',
    toastShow: 'Anzeigen',
  },
  reports: {
    intro:
      'Was AEGIS geprüft und gemeldet hat und wie du entschieden hast – nur dein Konto und gemeinsame Orte. Ohne dein Ja wurde nichts verändert.',
    timeline: 'Zeitleiste',
    timelineHint: 'Neueste zuerst, nach Tagen gruppiert.',
    print: 'Drucken / als PDF',
    exportHtml: 'Als HTML speichern …',
    saved: 'Bericht gespeichert.',
    saveFailed: 'Bericht nicht gespeichert',
    saveWarning:
      'Der Verlauf konnte zuletzt nicht gespeichert werden – neue Einträge gehen bei einem Neustart des Dienstes verloren.',
    filter: 'Anzeigen',
    empty: 'Noch keine Einträge.',
    filters: {
      all: 'Alles',
      scans: 'Scans',
      watch: 'Wächter',
      decisions: 'Entscheidungen',
      system: 'Updates',
    },
    kinds: {
      scan: 'Scan',
      action: 'Ausgeführt',
      decision: 'Entscheidung',
      watch: 'Wächter',
      schedule: 'Geplanter Scan',
      update: 'Update',
    },
  },
  schedule: {
    title: 'Geplante Scans & Signaturen',
    intro:
      'Prüft regelmäßig Downloads, Desktop und Dokumente deines Profils. Geplante Scans melden nur – verändert wird nichts ohne dein Ja.',
    enabled: 'Geplanter Scan',
    lastRun: 'Zuletzt: {date}',
    never: 'Noch nicht gelaufen.',
    every: 'Abstand',
    daily: 'Täglich',
    weekly: 'Wöchentlich',
    monthly: 'Monatlich',
    hour: 'Ab',
    clamavUpdate: 'ClamAV-Signaturen täglich aktualisieren',
    clamavHint: 'Lädt neue Signaturen aus dem Netz (freshclam). Jederzeit abschaltbar.',
    clamavMissing: 'ClamAV bzw. freshclam ist nicht installiert.',
    updateOk: 'Zuletzt aktualisiert: {date}',
    updateFailed: 'Letzter Versuch fehlgeschlagen ({date}): {message}',
    adminOnly:
      'Das Signatur-Update gilt für den ganzen Rechner – ändern können es nur Administratoren (AEGIS als Administrator starten).',
  },
  trust: {
    title: 'Vertrauensliste',
    intro:
      'Dateien, denen du vertraust (Prüfsumme + Pfad). Ändert sich die Datei, gilt das Vertrauen nicht mehr. Widerrufen macht AEGIS nur strenger.',
    empty: 'Du vertraust noch keiner Datei.',
    revoke: 'Widerrufen',
    revoked: 'Vertrauen widerrufen.',
    since: 'Seit {date}',
  },
  vault: {
    intro:
      'Isolierte Dateien liegen verschlüsselt im Tresor des Dienstes. Wiederherstellen oder endgültig löschen – jeweils nur nach deiner Bestätigung.',
    empty: 'Die Quarantäne ist leer.',
    restore: 'Wiederherstellen …',
    delete: 'Endgültig löschen …',
    refresh: 'Aktualisieren',
    isolatedAt: 'Isoliert am {date}',
    never: 'AEGIS löscht nie automatisch – auch nicht nach Fristen.',
  },
  toast: {
    region: 'Benachrichtigungen',
    dismiss: 'Meldung schließen',
  },
} as const;
