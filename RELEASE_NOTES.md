## Konto-Retter – Hilfe nach einem Epic-Hack

**So installierst du ihn:**

1. Unten bei „Assets“ auf **Konto-Retter-Setup-….exe** klicken. Die Datei wird heruntergeladen.
2. Die heruntergeladene Datei doppelklicken.
3. Zeigt Windows „Der Computer wurde durch Windows geschützt“: auf **Weitere Informationen** klicken, dann auf **Trotzdem ausführen**. (Das kommt, weil das Programm nicht bei Microsoft gekauft-signiert ist.)
4. Fertig: Der Konto-Retter startet von selbst. Auf dem Desktop liegt ein Symbol, im Startmenü ein Eintrag.

**Neu in Version 1.2.4:**

- **Konten springen nicht mehr zurück:** Epic erneuert den gespeicherten Zugang bei jedem Start des Launchers. Der Konto-Retter ordnet den erneuerten Zugang jetzt dem zuletzt eingewechselten Konto zu, auch ohne E-Mail-Adresse oder Konto-ID. Vorher blieb dort ein veralteter Zugang stehen, und der nächste Wechsel landete auf der Anmeldeseite.
- Lehnt Epic einen gespeicherten Zugang trotzdem ab, zeigt der Konto-Retter das an und sagt, was zu tun ist.
- Beim „Aktuelles Konto speichern" werden zum Ersetzen nur noch Einträge angeboten, die zum angemeldeten Konto passen. Ein doppelter Eintrag fällt dabei automatisch weg.
- Kopien der Launcher-Einstellungen in anderen Ordnern werden nicht mehr angefasst. Die richtige Datei wird zuverlässiger erkannt.
- Klappt das Speichern der Kontenliste nicht, bleibt der Launcher unverändert und startet wieder. Das Programm friert beim Speichern nicht mehr kurz ein.

**Neu in Version 1.2.3:**

- **Konten-Wechsel sicherer:** Ein von Epic erneuerter Zugang wird nicht mehr durch einen älteren überschrieben. Die gespeicherte Liste wird gesichert, bevor die Launcher-Datei geändert wird; schlägt das Schreiben fehl, bleibt alles, wie es war.
- **Alte Einträge reparieren:** Beim „Aktuelles Konto speichern" kannst du wählen, welchen vorhandenen Eintrag die Anmeldung ersetzen soll. Einträge aus älteren Versionen sind als „Alter Eintrag" markiert.
- Der Zugang wird nur noch in die Datei geschrieben, die der Launcher wirklich liest; alte Kopien werden geleert. Die Konto-ID in Windows wird beim Wechsel immer passend gesetzt oder gelöscht.
- Startet der Launcher nicht von selbst (z. B. „Als Administrator ausführen"), startet Windows ihn; klappt auch das nicht, sagt der Konto-Retter klar Bescheid.

**Neu in Version 1.2.2:**

- **Konten-Wechsel repariert:** Der Konto-Retter liest und schreibt jetzt die Datei, die der Epic Games Launcher seit Version 19 benutzt (Ordner „WindowsEditor"). Beim Wechsel wird zusätzlich die Konto-ID zurückgestellt, und die Hilfsprogramme des Launchers werden mit beendet – so, wie es bekannte Konto-Wechsler auch machen.
- **Neuer Knopf „Weiteres Konto hinzufügen":** öffnet den Launcher mit der Anmeldeseite, **ohne** dich abzumelden. Wichtig: Im Launcher nie auf „Abmelden" klicken – das macht den gespeicherten Zugang bei Epic ungültig, und „Wechseln" führt dann nur zur Anmeldeseite.
- Erneuert Epic einen Zugang, wird der gespeicherte Eintrag beim nächsten Wechsel automatisch aufgefrischt statt doppelt angelegt.

**Neu in Version 1.2.1:**

- **Konten:** Wird die Anmeldung nicht gefunden, zeigt der Konto-Retter jetzt genau, was er auf dem PC sieht („Was der Konto-Retter sieht"), mit Knopf zum Kopieren. Dazu bietet er an, den Launcher für dich zu beenden und danach erneut zu lesen – der Launcher schreibt die Anmeldung oft erst beim Beenden. 2FA muss dafür nicht aus.
- Die Anmeldung wird in allen Einstellungsdateien des Launchers gesucht, nicht nur in der üblichen.

**Neu in Version 1.2:**

- **Kurze Anleitung statt 21 Schritten:** SMS und Authenticator einrichten, E-Mail-2FA aus, abmelden und „Passwort vergessen“, „Kein Zugriff auf diese E-Mail“, Codes eingeben, neue E-Mail eintragen.
- **Klick auf einen Schritt öffnet keine Seite mehr.** Die Epic-Seite öffnest du nur noch mit dem Knopf „Seite öffnen“.
- **Neuer Tab „Konten“:** Mit einem Klick zwischen deinen Epic-Konten im Launcher wechseln.
- **PDF-Auslese:** Kaufdatum und Betrag werden als „erste Zahlung“ vorgeschlagen – das fragt Epic, um dich als Eigentümer zu bestätigen. Dazu neue Felder unter „Meine Daten“. Die Konto-ID-Suche auf dem PC ist jetzt dort.

**Neu in Version 1.1:**

- Komplett neues Aussehen: Tabs oben, Glas-Optik und ein bewegter 3D-Hintergrund.
- Viele Animationen: Karten neigen sich zur Maus, Knöpfe ziehen die Maus leicht an, Klick-Wellen, Funken beim Abhaken eines Schritts und ein Feuerwerk am Ende.
- Zu viel Bewegung? Oben rechts das Funkel-Symbol anklicken, dann ist alles ruhig.

Schon installiert? Einfach die neue Setup-Datei doppelklicken. Dein Fortschritt und deine Daten bleiben erhalten.

**Was drin ist:**

- **Konto retten:** Kurze Anleitung in 6 Schritten, jeder mit der passenden Epic-Seite. Wichtige Daten groß mit Kopieren-Knopf. Fortschritt wird gespeichert.
- **Konten:** Zwischen mehreren Epic-Konten im Launcher mit einem Klick wechseln.
- **PDF auslesen:** Epic-Konto-PDF oder Kaufbelege hineinziehen, die Daten werden automatisch erkannt (auch die passwortgeschützte Epic-PDF).
- **Support-Text:** Fertiger Text für den Epic-Support auf Deutsch und Englisch, füllt sich automatisch.
- **Discord:** Starten, beenden, Benachrichtigungen stumm schalten – per Klick.

Deine Daten bleiben verschlüsselt auf deinem PC. Kein offizielles Programm von Epic Games oder Discord.

**Deinstallieren:** Windows-Einstellungen > Apps > Installierte Apps > Konto-Retter > Deinstallieren.
