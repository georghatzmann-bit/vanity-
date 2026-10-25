# Test-Checkliste – Vollversion

So testest du Vanity mit deinem echten Fortnite 19.10. Bitte **in dieser Reihenfolge**, und bei
jedem Punkt, der nicht klappt: Screenshot + Log an mich (siehe unten „Was ich brauche“).

## Herunterladen

Direkter Link (immer der neueste Stand):
**https://github.com/georghatzmann-bit/vanity-/releases/download/vanity-testversion/Vanity-Setup.exe**

Windows meldet evtl. „Der Computer wurde durch Windows geschützt“, weil der Installer nicht
signiert ist → **Weitere Informationen** → **Trotzdem ausführen**. Installiert nur für deinen
Benutzer, ohne Admin-Rechte. Wenn dein Virenprogramm die DLLs blockiert: den Vanity-Ordner
(`%LOCALAPPDATA%\Vanity` und das Installationsverzeichnis) als Ausnahme eintragen – das ist bei
allen OG-Launchern so, weil die DLLs in Fortnite geladen werden.

## Vorher

- Reboot Launcher und Fortnite komplett schließen (Task-Manager: kein `FortniteClient-Win64-Shipping.exe`).
- Port 80 frei? Falls Skype/IIS/… ihn belegt, in Vanity → Einstellungen → Matchmaker-Port z. B. auf 8080 stellen.
- Windows-Firewall: beim ersten Start fragt Windows für `node.exe` und Fortnite – **Zulassen** (nur privates Netz).

## Schritt 1 – Build hinzufügen (ohne Fortnite zu starten)

- [ ] Bibliothek → Build hinzufügen → Durchsuchen → `C:\Users\georg\Downloads\windows-19.10` → Prüfen.
- [ ] Vier grüne Haken, Version **19.10 (CL-18675304)**, Season „Chapter 3 · Season 1“, „Unreal Engine 5.0“.
- [ ] Hinzufügen → Karte erscheint, Profil „Standard“ wurde automatisch angelegt (Seite Profile).
- [ ] Vanity schließen und neu öffnen → Build und Profil sind noch da.

## Schritt 2 – Host & Play: Backend und Server

Auf der Startseite **Host & Play** drücken. Die Zeitleiste zeigt sieben Schritte. Beobachte dazu das
**Live-Log** (Seite Logs). Erwartete Reihenfolge:

- [ ] „Backend hört auf 127.0.0.1:3551“ (Schritt *Backend*).
- [ ] „Starte Server-Fortnite …“ und „Umleitung geladen“ (Schritte *Server-Fortnite*, *Umleitung*).
      Das Server-Fortnite läuft **ohne Fenster** (`-nullrhi`). Du siehst es nur im Task-Manager.
- [ ] Im Server-Log eine Zeile mit `ContinueLoggingIn` und **„Anmeldung erkannt“** (Schritt *Anmeldung*).
      → Wenn stattdessen „Kann Backend nicht erreichen“ oder Pak-Fehler kommen: Log schicken.
- [ ] Kurz danach: „vanity_server.dll geladen“ und ein **neues Fenster „Magnesium (FN 19.10, UE 5.0)“**.
      Das ist das Server-Fenster – es bleibt offen, solange der Server läuft. Nicht schließen.
- [ ] Gleichzeitig startet **dein Spiel** (Schritt *Dein Spiel*) – normaler Fortnite-Start mit Lobby.
      Melde dich nicht an, es gibt kein Login: Vanity meldet dich automatisch an (Name aus Einstellungen).
- [ ] Kurz nach dem Server-Fenster: Hinweis **„Server wartet auf den Start“** (die Steuer-Pipe steht).
      Jetzt **Seite Match → „Match starten“** drücken – oder im Server-Fenster unten links **START SERVER**.
      Vorher ggf. Playlist/Lategame auf der Match-Seite setzen (gilt nur vor dem Start).
- [ ] Nach 1–3 Minuten (Karte laden): Server-Log zeigt `IpNetDriver listening on port 7777`,
      Vanity meldet **„Server bereit“** (Schritt *Game Server*, dann *Lobby*).

Wenn „Game Server meldet sich nicht“ kommt: Server-Log (Quelle „Server“) und die Seite *Abstürze*
anschauen. Dort steht in einfachen Worten, was passiert ist.

## Schritt 3 – Match beitreten

- [ ] Im Spiel: Lobby ist da, dein Name steht oben, Skin ist der Standard (das Backend hat alles Nötige).
- [ ] Spielmodus ist egal (Solo reicht) → **Spielen** drücken.
- [ ] Der Matchmaker leitet dich auf 127.0.0.1:7777 → Ladebildschirm → Du stehst auf der Spawn-Insel
      oder im Bus (je nach Server-Einstellung).
- [ ] Du kannst laufen, bauen, bearbeiten, Waffen aufheben.

Falls „Verbindung zum Server fehlgeschlagen“: War „Server bereit“ schon da? Wenn nicht, warten und
nochmal Spielen drücken.

## Schritt 4 – Server-Fenster (Magnesium) kennenlernen

Vieles geht auch im Launcher (Seite Match: Playlist, Lategame, Bus, Bots, Items). Das Server-Fenster kann mehr:

- [ ] **Playlist**: Knöpfe wie „Solos“, „Duos“, „Tournament Solos“ (Arena), „Zero Build …“.
      Vor dem Start wählen, dann Match starten.
- [ ] **Late Game** anhaken → Lategame-Modus (Loadouts, kleine Zone).
- [ ] **Bots**: Anzahl eintragen und spawnen; „Use Custom Bot Names“ für eigene Namen.
- [ ] **Trickshot**: „Enable Trickshot Tab“ anhaken → neuer Reiter mit Waypoints, Zeitlupe
      („Toggle Crown Slomo“), „Negate Velocity on Win“, Auto-Reload beim Teleport usw.
- [ ] **Hilfreich fürs Testen**: „Infinite Materials“, „Infinite Ammo“, „Infinite Respawns“, „Siphon“.
- [ ] „Save Settings“ anhaken → Einstellungen landen in `%LOCALAPPDATA%\Vanity\server\`.

## Schritt 5 – Ingame-Menü (F9) – erst ab dem Build mit `vanity_client.dll`

Ob die DLL dabei ist, siehst du im Live-Log: „vanity_client.dll geladen“ (Quelle Spiel).

- [ ] Im Spiel **F9** drücken → Menü „Vanity | Console“ öffnet sich, Maus ist frei.
- [ ] Reiter **Editing**: Edit on Release, Reset on Release, Pre-Edits aus – an-/ausschalten, im Spiel prüfen.
- [ ] Reiter **Graphics**: FOV-Regler bewegen → Bild ändert sich sofort.
- [ ] **F8** oder **^** → Konsole; `fov 110` eingeben → Enter.
- [ ] Reiter **Info**: Unten steht „Vanity is based on ATLAS Console …“ (Lizenz-Nennung).
- [ ] Einstellungen liegen danach in `%APPDATA%\Vanity\client.json`.

## Andere Versionen testen (ungetestet, aber startbar)

Vanity startet jede Version von 1.7 bis 30.x. Für alles außer 19.10 gilt: gleiche Schritte wie oben, nur
dass die Build-Karte „Ungetestet“ zeigt und im Log ein Hinweis steht. Wenn es nicht klappt, sind diese
drei Dateien wichtig:

- `%LOCALAPPDATA%\Vanity\logs\redirect.log` – stand die Umleitung? („Bereit“ oder „FEHLER“)
- `%LOCALAPPDATA%\Vanity\logs\client-diagnostics.log` – lief das Ingame-Menü an?
- `<Build>\FortniteGame\Binaries\Win64\stdout.log` und der Ordner `MagnesiumCrashes` daneben – was der Game Server sagt.

Bekannte Grenzen: 9.40–10.40 ohne Party/XMPP; Edit on Release nur bis 10.40; ab 31.00 noch nicht startbar.

## Schritt 6 – Beenden

- [ ] Startseite → **Alles stoppen** → Spiel, Server-Fortnite, Server-Fenster und Backend sind weg
      (Task-Manager: kein `FortniteClient-Win64-Shipping.exe`, kein `node.exe` von Vanity).
- [ ] Nochmal Host & Play → klappt ein zweites Mal ohne Neustart von Vanity.

## Was ich brauche, wenn etwas nicht klappt

1. **Welcher Schritt** aus dieser Liste (z. B. „Schritt 2, Anmeldung erkannt kommt nicht“).
2. **Screenshot** vom Launcher (Zeitleiste + Live-Log) und ggf. vom Spiel/Server-Fenster.
3. **Logs**: Seite Logs → „Exportieren“ (oder die Dateien aus `%LOCALAPPDATA%\Vanity\logs\`).
4. Bei Fortnite-Absturz: Seite *Abstürze* → den neuesten Eintrag aufklappen → Text kopieren.

Kurz und ehrlich: Ich kann hier kein Fortnite starten. Alles bis zum Ladebildschirm ist aus den
Quell-Projekten (Reboot-Ablauf, LawinServer, Tellurium, Magnesium) 1:1 nachgebaut und gegen deren
Verhalten geprüft – ob es bei dir durchläuft, zeigt erst dieser Test.
