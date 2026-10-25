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
      Jetzt im Launcher **Match-Steuerung** → Reiter **Spiel** → **Match starten** drücken – oder im
      Server-Fenster unten links **START SERVER**.
      Vorher ggf. „Modus“ und „Lategame“ auf derselben Seite setzen – das geht nur vor dem Start.
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

Vieles geht auch im Launcher: Seite **Match-Steuerung** (Modus, Lategame, Bus, Sturm, Items, Trickshot, Bots).
Das Server-Fenster kann mehr:

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

- [ ] Im Spiel **F9** drücken → Menü „Vanity | Menü“ öffnet sich, die Maus ist frei.
      Links stehen fünf Reiter: **Start**, **Befehle**, **Optionen**, **Trickshot**, **Credits**. Alles ist auf Deutsch.
- [ ] Reiter **Start** → „Editieren“: „Zurücksetzen beim Loslassen“ an- und ausschalten, im Spiel beim Editieren prüfen.
      In 19.10 steht dort nur dieser Schalter. „Edit beim Loslassen“ gibt es nur bis 10.40,
      „Keine Vorschau-Edits“ nur bis 15.1x.
- [ ] Reiter **Start** → „Sichtfeld“: Regler „Blickwinkel“ bewegen → das Bild ändert sich sofort.
      „Zurück auf 80“ stellt es wieder normal.
- [ ] **F8** → Konsole; `fov 110` eingeben → Enter.
- [ ] Reiter **Optionen** → „Menü-Taste ändern“ → eine andere Taste drücken → das Menü geht jetzt mit
      der neuen Taste auf. Danach wieder auf F9 stellen.
- [ ] Reiter **Trickshot**: Er hat vier Bereiche.
      - „Parkour laden“: eine Karte pro Strecke (Name, leicht/mittel/schwer, kurze Beschreibung, Knopf **Laden**),
        darunter „Nochmal von vorne“ und „Alles wegräumen“.
      - „Ziel-Bot“: Regler „Leben“ und „Abstand“, dazu „Bot vor mich stellen“, „Alle Bots weg“, „Bots zu mir“.
      - „Ausrüstung“: „Sniper geben“, „Sprungpads geben“, „Munition auffüllen“, „Leben auffüllen“.
      - „Üben“: „Position merken“, „Zurück zur Position“, „Hochschießen“, „Zeitlupe“, „Wenig Schwerkraft“,
        „Normale Schwerkraft“, „Unverwundbar umschalten“, „Sturm anhalten“.
      Bist du noch in der Lobby, steht oben ein Hinweis: Die Knöpfe klappen erst im Match.
- [ ] Im Match kurz ausprobieren: „Position merken“, ein Stück weglaufen, „Zurück zur Position“ → du bist wieder
      an der alten Stelle. Nach jedem Klick steht unter dem Bereich kurz „Gesendet: …“.
- [ ] Reiter **Credits**: Unten steht „Vanity is based on ATLAS Console by cipherfps, ralz and contributors.“
      (Lizenz-Nennung, darum auf Englisch).
- [ ] Einstellungen liegen danach in `%APPDATA%\Vanity\client.json`.

## Schritt 6 – Trickshot-Parkours testen

Ein Parkour ist eine fertige Trickshot-Strecke: eine Plattform in der Luft, Sprung-Objekte und Ziel-Bots,
die still stehen. Teste das in einem Solo-Match. Du musst schon auf der Insel stehen – nicht in der Lobby,
nicht im Bus.

Die Antworten vom Server stehen in der Konsole (**F8**). Sie beginnen mit „[Vanity]“.

- [ ] **Laden:** **F9** → Reiter **Trickshot** → bei „Erster Sprung“ auf **Laden**.
      Oder im Launcher: **Match-Steuerung** → Reiter **Trickshot** → Karte „Erster Sprung“ → **Laden**.
      Die Knöpfe im Launcher wirken auf dich (den Spieler an diesem PC). Bist du nicht im Match, auf den ersten Mitspieler.
- [ ] Das soll passieren:
      - Du stehst in der Mitte einer Holz-Plattform (3 × 3 Platten), etwa 25 m über der Stelle, wo du warst.
      - Die Strecke liegt in deiner Blickrichtung, und du schaust nach vorne.
      - 9 m vor dir, kurz hinter dem Rand der Plattform und 1 m tiefer, ist ein Trampolin
        (je nach Version ein Reifenstapel oder ein Hüpf-Schirm).
      - 40 m vor dir steht ein Bot auf einer einzelnen Platte. Er bewegt sich nicht und hat 50 Leben, kein Schild.
      - Du hast eine Sniper im Inventar.
      - In der Konsole steht: „„Erster Sprung“ ist bereit! Gebaut: 10 Böden, 1 Sprung-Objekte, 1 Ziel-Bots.“
- [ ] **Trickshot:** Lauf aufs Trampolin und triff den Bot, während du in der Luft bist.
      → Oben in der Bildmitte erscheint groß **TRICKSHOT!**, darunter dein Name und die Entfernung in Metern
      (etwa 3,5 Sekunden lang). Im Launcher kommt gleichzeitig die Meldung „TRICKSHOT! <dein Name>“.
      Triffst du ihn im Stehen, kommt kein Banner – das ist richtig so.
      Kein Banner trotz Sprung? Im Launcher: Match-Steuerung → Trickshot → „Trickshot-Anzeige“ muss an sein.
- [ ] **Nochmal von vorne** (in F9 oder im Launcher): Du stehst wieder am Start und schaust nach vorne.
      Leben und Schild sind voll, die Waffen sind geladen. Hast du den Bot erledigt, ist er wieder da.
      In der Konsole steht: „Zurück am Start von „Erster Sprung“. Leben voll, Waffen geladen. …“
- [ ] **Ziel-Bot:** F9 → Trickshot → „Ziel-Bot“: Leben 50, Abstand 30 m → **Bot vor mich stellen**
      (im Launcher heißt der Knopf „Bot hinstellen“).
      → Ein Bot erscheint genau in deiner Blickrichtung, 30 m weit weg, auf deiner Höhe, auf einer Platte.
      In der Konsole steht: „Ziel-Bot steht 30 m vor dir (50 Leben). Weg damit: parkour clear“.
- [ ] **Alles wegräumen** (in F9 oder im Launcher): Plattformen, Trampolin und alle Ziel-Bots sind weg –
      auch der Bot vom Knopf „Bot vor mich stellen“. In der Konsole steht: „Weggeräumt: … Teile und … Ziel-Bots.“
      Achtung: Stehst du dabei oben auf der Plattform, fällst du runter.
- [ ] Gern auch die anderen Strecken laden, z. B. „Geysir-Shot“ oder „Boden-Kurs“.
      Ein neuer Parkour räumt den alten selbst weg.

**Wenn etwas nicht passt, schick mir bitte das:**

- **Eine Plattform liegt halb daneben.** Du stehst nach dem Laden am Rand der Plattform statt in der Mitte
  (oder fällst sofort runter), oder ein Bot steht neben seiner Platte.
  Schick dann einen Screenshot von schräg oben: im Reiter Trickshot „Hochschießen“ drücken, dann nach unten
  schauen. Schreib dazu, wohin die Platten verrutscht sind – links, rechts, vorne oder hinten (so wie du am
  Start schaust) – und ungefähr wie weit: eine halbe Platte (etwa 2,5 m) oder eine ganze (etwa 5 m).
  Dazu die Fortnite-Version.
  Warum: Vanity muss wissen, an welcher Stelle Fortnite eine Boden-Platte „anfasst“. Das ist nur an echten
  Bauten aus 10.40 geprüft. Dein Bild zeigt, ob es in deiner Version auch stimmt.
- **Ein Objekt fehlt.** In der Konsole steht dann zum Beispiel „Gibt es in dieser Version nicht (weggelassen): Trampolin.“
  Schick genau diese Zeile und die Fortnite-Version. Dann suche ich einen Ersatz, den es in deiner Version gibt.
- **Eine andere Meldung**, zum Beispiel „In dieser Version gibt es keins der Scharfschützengewehre aus der Liste.“,
  „… Sprung-Objekte ließen sich nicht aufstellen.“, „… Ziel-Bots konnten nicht erscheinen.“ oder
  „Die Parkour-Liste fehlt …“: Schreib die Zeile ab oder mach ein Foto davon.

## Schritt 7 – Beenden

- [ ] Startseite → **Alles stoppen** → Spiel, Server-Fortnite, Server-Fenster und Backend sind weg
      (Task-Manager: kein `FortniteClient-Win64-Shipping.exe`, kein `node.exe` von Vanity).
- [ ] Nochmal Host & Play → klappt ein zweites Mal ohne Neustart von Vanity.

## Andere Versionen testen (ungetestet, aber startbar)

Vanity startet jede Version von 1.7 bis 30.x. Für alles außer 19.10 gilt: gleiche Schritte wie oben, nur
dass die Build-Karte „Ungetestet“ zeigt und im Log ein Hinweis steht. Wenn es nicht klappt, sind diese
drei Dateien wichtig:

- `%LOCALAPPDATA%\Vanity\logs\redirect.log` – stand die Umleitung? („Bereit“ oder „FEHLER“)
- `%LOCALAPPDATA%\Vanity\logs\client-diagnostics.log` – lief das Ingame-Menü an?
- `<Build>\FortniteGame\Binaries\Win64\stdout.log` und der Ordner `MagnesiumCrashes` daneben – was der Game Server sagt.

Bekannte Grenzen: 9.40–10.40 ohne Party/XMPP; „Edit beim Loslassen“ nur bis 10.40; ab 31.00 noch nicht startbar.
Bei Trickshot-Parkours kann es je nach Version andere Objekte geben – fehlt eins, sagt der Server das in der
Konsole (siehe Schritt 6).

## Was ich brauche, wenn etwas nicht klappt

1. **Welcher Schritt** aus dieser Liste (z. B. „Schritt 2, Anmeldung erkannt kommt nicht“).
2. **Screenshot** vom Launcher (Zeitleiste + Live-Log) und ggf. vom Spiel/Server-Fenster.
3. **Logs**: Seite Logs → „Exportieren“ (oder die Dateien aus `%LOCALAPPDATA%\Vanity\logs\`).
4. Bei Fortnite-Absturz: Seite *Abstürze* → den neuesten Eintrag aufklappen → Text kopieren.
5. Bei Trickshot-Sachen: die Zeilen aus der Konsole (**F8**), die mit „[Vanity]“ beginnen.

Kurz und ehrlich: Ich kann hier kein Fortnite starten. Alles bis zum Ladebildschirm ist aus den
Quell-Projekten (Reboot-Ablauf, LawinServer, Tellurium, Magnesium) 1:1 nachgebaut und gegen deren
Verhalten geprüft – ob es bei dir durchläuft, zeigt erst dieser Test.
