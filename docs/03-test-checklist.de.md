# Test-Checkliste – Vollversion (Deutsch)

Deutsche Kopie von [`03-test-checklist.md`](03-test-checklist.md). Der Launcher, das Installationsprogramm
und das F9-Menü sind jetzt auf Englisch. Darum stehen alle Knöpfe, Reiter und Meldungen hier **genau so,
wie du sie auf dem Bildschirm siehst** – also auf Englisch.

So testest du Rift mit deinem echten Fortnite 19.10. Bitte **in dieser Reihenfolge**. Bei jedem Punkt,
der nicht klappt: Screenshot + Log an mich (siehe „Was ich brauche“ ganz unten).

Rift hieß früher Niobium (und davor Vanity). Wenn du Niobium oder Vanity installiert hattest, übernimmt
Rift deine Einstellungen von selbst – diese Liste sagt dir, worauf du achten sollst.

**Neu in dieser Version** (Schritte 10–15): Profile mit „Classic match“, Waffen aufheben und tauschen,
Bodenloot und die Loot-Liste bei 19.10, KI-Bots bei 19.10 (experimentell), „Download a version“ (jetzt auch
21.x bis 30.x) und „Bosses & NPCs“ (experimentell, noch im Bau). Nichts davon wurde schon in einem echten Spiel
getestet – genau dafür sind diese Schritte da.

## Herunterladen

Direkter Link (immer der neueste Stand):
**https://github.com/georghatzmann-bit/vanity-/releases/download/rift-test/Rift-Setup.exe**

Windows meldet evtl. „Der Computer wurde durch Windows geschützt“, weil der Installer nicht signiert ist
→ **Weitere Informationen** → **Trotzdem ausführen**. Installiert wird nur für deinen Benutzer, ohne
Admin-Rechte. Wenn dein Virenprogramm die DLLs blockiert: `%LOCALAPPDATA%\Rift` als Ausnahme eintragen
(dorthin installiert sich Rift, und dort liegen auch Logs und Server-Daten). Das ist bei allen
OG-Launchern so, weil die DLLs in Fortnite geladen werden.

## Vorher

- Reboot Launcher, den alten Niobium- oder Vanity-Launcher und Fortnite komplett schließen (Task-Manager: kein
  `FortniteClient-Win64-Shipping.exe`).
- Port 80 frei? Falls Skype, IIS oder etwas anderes ihn belegt: in Rift → **Settings** → **Network** →
  **Matchmaker port** z. B. auf 8080 stellen.
- **Backend port** zeigt 3551 und **Game server port** 7777. Beide sind fest (die DLLs nehmen immer
  diese Ports), du kannst sie nicht ändern.
- Windows-Firewall: Beim ersten Start fragt Windows nach `node.exe` und Fortnite – **Zugriff zulassen**
  (private Netzwerke reichen).

## Schritt 0 – Installieren

- [ ] `Rift-Setup.exe` starten. Zuerst blendet eine kleine dunkle Rift-Karte ein und wieder aus.
- [ ] Dann kommt der dunkle Installer: „Welcome to Rift“, links das Logo. **Next** → den Ordner so
      lassen → **Install**.
- [ ] Nur wenn du Niobium oder Vanity installiert hattest: Der Installer entfernt das alte Programm
      leise – du musst nichts tun. Danach steht im Startmenü „Rift“ und kein „Niobium“ oder „Vanity“
      mehr. Deine alten Einstellungen werden nicht gelöscht.
- [ ] Nach dem Installieren kommt die letzte Seite von selbst: „You're ready to drop.“, mit den Häkchen
      „Create desktop shortcut“ und **„Launch Rift now“** und dem Link „Source code and help (GitHub)“.
      Unter Windows 11 ist auch die Titelleiste des Installers dunkel.
- [ ] „Launch Rift now“ angehakt lassen → **Finish**.

## Schritt 1 – Erster Start

- [ ] In der Bildschirmmitte erscheint eine kleine Karte mit dem Rift-Logo, „Step back into any season.“
      und einer laufenden Linie. Kurz danach geht das große Fenster auf und die Karte verschwindet
      (spätestens nach 8 Sekunden).
- **Wenn du vorher Niobium (oder Vanity) benutzt hast:**
  - [ ] Eine Karte **„What's new“** erscheint: „Niobium is now Rift“, „Bubble Builds“, „A fresh look“,
        „Everything in English“ → **Got it**.
  - [ ] In der **Library** ist dein 19.10-Build noch da. Unter **Profiles** sind deine Profile noch da (das
        Profil „Standard“ heißt jetzt „Default“).
  - [ ] **Live Log**, Quelle **Rift**: eine Zeile „Copied your settings from Niobium to Rift (…). The
        old Niobium folders were left as they are.“ (oder „from Vanity“, wenn du nur Vanity hattest)
- **Wenn Rift neu auf diesem PC ist:**
  - [ ] Ein Willkommens-Bildschirm über das ganze Fenster: „Welcome to Rift“ → **Let's set it up** →
        „What should we call you?“ (3–16 Buchstaben oder Zahlen) → **Next** → „Add your Fortnite build“ →
        **Browse** → dein 19.10-Ordner → **Check** → **Add build** → „You're all set“ → **Let's go**.
  - [ ] Später geht auch: **Skip setup** (oben rechts) schließt den Willkommens-Bildschirm.
- [ ] Rift schließen und wieder öffnen → kein Willkommen und kein „What's new“ mehr.
- [ ] Alles, was du siehst, ist auf Englisch, auch die Knöpfe und die Meldungen unten rechts.

## Schritt 2 – Build hinzufügen (ohne Fortnite zu starten)

Überspringen, wenn du den Build schon im Willkommen hinzugefügt hast oder er von Niobium oder Vanity übernommen wurde.

- [ ] **Library** → **Add a build** → **Browse** → `C:\Users\georg\Downloads\windows-19.10` → **Check**.
- [ ] Vier grüne Haken: „Found FortniteClient-Win64-Shipping.exe“, „Version: 19.10 (CL-18675304)“,
      „Game files found (… .pak files)“, „Version 19.10: Tested“. Darunter: „Fortnite 19.10“,
      „Chapter 3 · Season 1 · Unreal Engine 5.0“ (steht dort „Unreal Engine (unknown)“, ist das auch okay).
- [ ] **Add build** → eine Karte erscheint mit „Tested“ und „Active“. Ihre Zeile „Bubble Builds“ zeigt „—“
      (19.10 hat keine Bubble Builds). Das Profil „Default“ wurde von selbst angelegt (Seite **Profiles**).
- [ ] Auf der Karte **Open folder** → der Explorer öffnet den Build-Ordner.
- [ ] Rift schließen und neu öffnen → Build und Profil sind noch da.

## Schritt 3 – Host & Play: Backend und Server

Auf **Home** auf **Host & Play** drücken. Der Bereich „Launch steps“ zeigt sieben Schritte (Backend,
Server, Redirect, Login, Your game, Game server, Lobby). Schau dazu auf die Seite **Live Log** (in der
Seitenleiste). Erwartete Reihenfolge:

- [ ] „Backend is listening on 127.0.0.1:3551“ (Schritt *Backend*).
- [ ] „Starting the server Fortnite: …“ und „Redirect loaded“ (Schritte *Server*, *Redirect*).
      Das Server-Fortnite läuft **ohne Fenster** (`-nullrhi`). Du siehst es nur im Task-Manager.
- [ ] Im Server-Log eine Zeile mit `ContinueLoggingIn`, markiert mit **„Logged in“** (Schritt *Login*).
      → Wenn stattdessen „Can't reach the backend“ oder „Build damaged“ kommt: Log an mich schicken.
- [ ] Kurz danach: „rift_server.dll loaded“. **Es geht kein neues Fenster auf**: Das eigene Fenster des
      Game-Servers ist jetzt versteckt. Du steuerst das Match über **Match Control** und im Spiel mit
      **F9 → Host** (Schritt 5). Nur wenn **Settings → Game → „Show the server window (for
      troubleshooting)“** an ist, erscheint ein Fenster „Magnesium (FN 19.10, UE 5.0)“ (nicht schließen,
      das beendet den Server).
- [ ] Gleichzeitig startet **dein Spiel** („Starting your game: …“, Schritt *Your game*) – ein normaler
      Fortnite-Start bis in die Lobby. Melde dich nicht an, es gibt kein Login: Rift meldet dich mit dem
      Spielernamen aus deinem Profil an.
- [ ] Kurz danach erscheint die Meldung **„The server is waiting for you“** (die Steuer-Pipe steht).
      Jetzt im Launcher **Match Control** → Reiter **Game** → **Start match** drücken.
      Wenn du willst, vorher auf derselben Seite unter „Game mode“ „Mode“ und „Lategame“ einstellen – das
      geht nur vor dem Start.
- [ ] Nach 1–3 Minuten (Karte lädt): Das Server-Log zeigt `IpNetDriver listening on port 7777`, und die
      Meldung **„Server ready“** erscheint (Schritt *Lobby*). Auf Home steht „You're in. Press Play in
      Fortnite.“

Wenn „The game server isn't answering“ kommt: Live Log (Quelle **Server**) und die Seite **Crash Analysis**
anschauen. Dort steht in einfachen Worten, was passiert ist.

## Schritt 4 – Match beitreten

- [ ] Im Spiel: Die Lobby ist da, dein Name steht oben, der Skin ist der Standard-Skin (das Backend hat
      alles Nötige).
- [ ] Der Spielmodus ist egal (Solo reicht) → **Play** drücken.
- [ ] Der Matchmaker schickt dich auf 127.0.0.1:7777 → Ladebildschirm → du stehst auf der Spawn-Insel oder
      im Bus (je nach Server-Einstellung).
- [ ] Du kannst laufen, bauen, bearbeiten und Waffen aufheben. Profile spielen jetzt ein „Classic match“,
      solange du nichts anderes einschaltest: Munition und Material gehen aus wie früher. Sammle also
      zuerst mit der Spitzhacke etwas Holz, bevor du baust (mehr in Schritt 10).

Falls das Spiel keine Verbindung zum Server bekommt: War „Server ready“ schon da? Wenn nicht, warten und
nochmal Play drücken.

## Schritt 5 – Host-Steuerung im Spiel (F9 → Host)

Alles, was du beim Spielen steuerst, steckt jetzt in dem einen Rift-Menü. Modus, Lategame, KI-Bots und
Bosses & NPCs stellst du vor dem Match im Launcher-Profil bzw. auf **Match Control** ein.

- [ ] Im Match **F9** → Reiter **Host**. Kurz steht dort „Asking the server...“, dann erscheinen die
      Abschnitte **Match**, **Storm**, **Match rules**, **Items**, **Health**, **Teleport**, **Target
      dummies** und **AI**.
- [ ] **Match**: Auf der Insel vor dem Bus steht „Everyone is on the island – the bus hasn't left yet.“
      (oranger Punkt) → **Start the bus** → alle sitzen im Bus. Danach: „The match is running.“ (grüner
      Punkt), der Knopf ist grau.
- [ ] **Storm** (nach dem Bus): **Pause storm** → der Sturm bleibt stehen, der Knopf heißt jetzt „Resume
      storm“ → drücken → er läuft weiter. **Skip to next zone** → der Kreis schließt sofort. **Start
      shrinking now** → der Sturm zieht los.
- [ ] **Match rules**: **Infinite ammo** anhaken → ein ganzes Magazin verschießen, es wird nicht weniger.
      Haken weg → es wird wieder weniger. Genauso **Infinite materials** (bauen). **Respawn** an → dich
      eliminieren lassen → du kommst zurück. „Lategame: on/off“ zeigt nur die Profil-Einstellung („Change
      it in the launcher profile before the match.“).
- [ ] **Items**: **Pump shotgun**, **Assault rifle**, … geben jeweils dieses Item; `scar` ins Feld tippen
      → **Give**. **Ammo**, **Materials**, **Ammo, materials and traps** füllen dein Inventar.
- [ ] **Health**: etwas Schaden nehmen → **Heal me** → volles Leben und Schild. **Heal everyone** macht
      das für alle Spieler.
- [ ] **Teleport**: **Teleport to my map marker** anhaken → Markierung auf der Karte setzen → du landest
      dort. **Teleport where I aim**, **Save this spot** → weglaufen → **Back to saved spot**.
- [ ] **Target dummies**: **Place a dummy in front of me** → ein Bot steht 30 m vor dir; **Bring dummies
      to me**, **Remove all dummies**.
- [ ] **AI**: zeigt „AI bots: on – 30 bots“ oder „off“ und den Zustand von Bosses & NPCs wie im Profil.
- [ ] Ein Freund, der deinem Server beigetreten ist, öffnet F9 → **Host** → „Only the host can use this“.
      Die anderen Reiter gehen bei ihm wie vorher.
- [ ] Nur zur Fehlersuche: **Settings → Game → „Show the server window (for troubleshooting)“** an → das
      Server-Fenster erscheint (sofort, wenn ein Server läuft). Aus → es verschwindet wieder. Normalerweise
      aus lassen.

## Schritt 6 – Ingame-Menü (F9)

Ob die DLL geladen ist, siehst du im Live Log: „rift_client.dll loaded“ (Quelle **Game**).

- [ ] Im Spiel **F9** drücken → das Menü geht auf (oben: Rift-Logo, **RIFT** Menu), die Maus ist frei.
      Links stehen sechs Reiter: **Main**, **Host**, **Trickshot**, **Commands**, **Options**, **Credits**.
      Abschnitts-Überschriften, Knöpfe und Schalter sehen in jedem Reiter gleich aus.
      Alles ist auf Englisch.
- [ ] Reiter **Main** → „Editing“: Auf jeder Version stehen dort alle drei Zeilen – „Edit on release“,
      „Reset on release“, „Disable pre-edits“. Jede an- und ausschalten und beim Bearbeiten prüfen.
      Auf 19.10 steht bei „Edit on release“ und „Disable pre-edits“ „Uses Fortnite's own … setting“: Dann
      ändert sich Fortnites eigene Einstellung (Einstellungen → Spiel) mit – bitte nachsehen, ob dort dasselbe
      steht. „Reset on release“ läuft auf 19.10 über Rifts eigenen Code (ohne diese Zeile darunter). Ist
      eine Zeile grau, bitte einen Screenshot.
- [ ] Reiter **Main** → „Field of view“: den Regler „Degrees (normal: 80)“ bewegen → das Bild ändert sich
      sofort. „Back to 80“ stellt es wieder normal.
- [ ] **F8** → Konsole; `fov 110` eingeben → Enter.
- [ ] Reiter **Options** → „Keys“ → **Change menu key [F9]** → eine andere Taste drücken → das Menü geht
      jetzt mit der neuen Taste auf. Danach wieder auf F9 stellen.
- [ ] Reiter **Main** → „Graphics“ → **Bubble look** an → im Match ein paar Wände bauen → der durchsichtige
      Teil sieht weich und „bubblig“ aus. Darunter steht „Bubble look: on (4 of 4 build textures)“ (oder
      „waiting for the build textures. Place one build piece.“). Den Regler „Bubble strength“ bewegen → es
      ändert sich sofort. Bitte ein Screenshot mit Bubble look an und aus.
- [ ] Reiter **Options** → „Build look“: Auf 19.10 steht dort der Bubble-Builds-Status (siehe Schritt 8).
- [ ] **Reset builds** (Reiter **Options** → „Reset builds“):
      - „Reset builds“ einschalten → **Reset builds key [none]** → eine Taste drücken (z. B. die Taste, die du
        in Fortnite für Reset nimmst; nicht die linke oder rechte Maustaste).
      - Einem Match beitreten → der Status wechselt von „Checking the server...“ zu **„Ready.“** (grüner Punkt).
      - Eine Wand bauen, bearbeiten (z. B. Fenster oder Tür), bestätigen. Dann die Wand anschauen, **ohne** die
        Edit-Taste zu drücken, und deine Reset-builds-Taste drücken → die Wand ist wieder ganz.
      - Der normale Weg geht weiterhin: Edit-Taste → im Edit-Modus Reset.
      - Wenn du gerade ein Teil bearbeitest und die Reset-builds-Taste drückst: Nichts Komisches passiert,
        dein Edit läuft einfach weiter.
      - Aus großer Entfernung (mehr als etwa 20 m) probieren: Es passiert nichts.
      - Settings → „Show the server window (for troubleshooting)“ an, dann im Server-Fenster „Allow Reset
        Builds Key“ ausschalten → ein neues Match starten → der Status sagt
        „This server can't do it. It needs a Rift server.“
      - Wenn etwas nicht stimmt: die Zeilen mit `[reset-builds]` aus der `stdout.log` des Servers.
- [ ] Reiter **Trickshot**: Er hat vier Bereiche.
      - „Load a parkour“: eine Karte pro Strecke (Name, easy/medium/hard, kurze Beschreibung, Knopf
        **Load**), darunter „Start over“ und „Clear everything“.
      - „Target bot“: die Regler „Health“ und „Distance“, dazu „Place bot in front of me“, „Remove all bots“,
        „Bring bots to me“.
      - „Gear“: „Give sniper“, „Give launch pads“, „Refill ammo“, „Refill health“.
      - „Practice“: „Save spot“, „Back to spot“, „Launch me up“, „Slow motion“, „Low gravity“,
        „Normal gravity“, „Invincible on/off“, „Pause storm“.
      Bist du noch in der Lobby, steht oben der Hinweis: „You're still in the lobby. Start a match first –
      then these buttons work.“
- [ ] Im Match kurz ausprobieren: „Save spot“, ein Stück weglaufen, „Back to spot“ → du bist wieder an der
      alten Stelle. Nach jedem Klick steht im Bereich kurz „Sent: …“.
- [ ] Dieselbe Stelle klappt auch aus dem Launcher: „Save spot“ in F9, dann **Match Control** → Reiter
      **Trickshot** → „Spot & gear“ → **Back to spot** → du bist wieder an der Stelle.
- [ ] Reiter **Credits**: Unten steht „Rift is based on ATLAS Console by cipherfps, ralz and contributors.“
- [ ] Deine Einstellungen liegen danach in `%APPDATA%\Rift\client.json`.

## Schritt 7 – Trickshot-Parkours testen

Ein Parkour ist eine fertige Trickshot-Strecke: eine Plattform in der Luft, Sprung-Objekte und Ziel-Bots,
die still stehen. Teste das in einem Solo-Match. Du musst schon auf der Insel stehen – nicht in der Lobby,
nicht im Bus.

Die Antworten vom Server stehen in der Konsole (**F8**). Sie beginnen mit „[Rift]“.

- [ ] **Laden:** **F9** → Reiter **Trickshot** → bei „First Jump“ auf **Load**.
      Oder im Launcher: **Match Control** → Reiter **Trickshot** → Karte „First Jump“ → **Load**.
      Die Knöpfe im Launcher wirken auf dich (den Spieler an diesem PC). Bist du nicht im Match, auf den
      ersten Mitspieler.
- [ ] Das soll passieren:
      - Du stehst in der Mitte einer Holz-Plattform (3 × 3 Platten), etwa 25 m über der Stelle, wo du warst.
      - Die Strecke liegt in deiner Blickrichtung, und du schaust nach vorne.
      - 9 m vor dir, kurz hinter dem Rand der Plattform und 1 m tiefer, ist ein Trampolin
        (je nach Version ein Reifenstapel oder ein Hüpf-Schirm).
      - 40 m vor dir steht ein Bot auf einer einzelnen Platte. Er bewegt sich nicht und hat 50 Leben, kein Schild.
      - Du hast eine Sniper im Inventar.
      - In der Konsole steht: „[Rift] "First Jump" is ready! Built: 10 floors, 1 jump objects, 1 target bots.“
- [ ] **Trickshot:** Lauf aufs Trampolin und triff den Bot, während du in der Luft bist.
      → Oben in der Bildmitte erscheint groß **TRICKSHOT!**, darunter dein Name und die Entfernung in Metern
      (etwa 3,5 Sekunden lang). Im Launcher kommt gleichzeitig die Meldung „TRICKSHOT! <dein Name>“.
      Triffst du ihn im Stehen, kommt kein Banner – das ist richtig so.
      Kein Banner trotz Sprung? Im Launcher: **Match Control** → **Trickshot** → „Trickshot banner“ →
      **Banner on** muss an sein.
- [ ] **Start over** (in F9 oder im Launcher): Du stehst wieder am Start und schaust nach vorne.
      Leben und Schild sind voll, die Waffen sind geladen. Hast du den Bot erledigt, ist er wieder da.
      In der Konsole steht: „[Rift] Back at the start of "First Jump". Full health, weapons reloaded. …“
- [ ] **Ziel-Bot:** F9 → Trickshot → „Target bot“: Health 50, Distance 30 m → **Place bot in front of me**
      (im Launcher heißt der Knopf **Place bot**).
      → Ein Bot erscheint genau in deiner Blickrichtung, 30 m weit weg, auf deiner Höhe, auf einer Platte.
      In der Konsole steht: „[Rift] Target bot is 30 m in front of you (50 health). Remove it: parkour clear“
- [ ] **Clear everything** (in F9 oder im Launcher): Plattformen, Trampolin und alle Ziel-Bots sind weg –
      auch der Bot von „Place bot in front of me“. In der Konsole steht: „[Rift] Removed … pieces and …
      target bots.“
      Achtung: Stehst du dabei oben auf der Plattform, fällst du runter.
- [ ] Gern auch die anderen Strecken laden, z. B. „Geyser Shot“ oder „Ground Course“.
      Ein neuer Parkour räumt den alten selbst weg.

**Wenn etwas nicht passt, schick mir bitte das:**

- **Eine Plattform liegt halb daneben.** Du stehst nach dem Laden am Rand der Plattform statt in der Mitte
  (oder fällst sofort runter), oder ein Bot steht neben seiner Platte.
  Schick dann einen Screenshot von schräg oben: im Reiter Trickshot „Launch me up“ drücken, dann nach unten
  schauen. Schreib dazu, wohin die Platten verrutscht sind – links, rechts, vorne oder hinten (so wie du am
  Start schaust) – und ungefähr wie weit: eine halbe Platte (etwa 2,5 m) oder eine ganze (etwa 5 m).
  Dazu die Fortnite-Version.
  Warum: Rift muss wissen, an welcher Stelle Fortnite eine Boden-Platte „anfasst“. Das ist nur an echten
  Bauten aus 10.40 geprüft. Dein Bild zeigt, ob es in deiner Version auch stimmt.
- **Ein Objekt fehlt.** In der Konsole steht dann zum Beispiel „[Rift] Not in this version (left out):
  Trampoline.“ Schick genau diese Zeile und die Fortnite-Version. Dann suche ich einen Ersatz, den es in
  deiner Version gibt.
- **Eine andere Meldung**, zum Beispiel „None of the listed sniper rifles exist in this version.“,
  „… jump objects couldn't be placed.“, „… target bots couldn't spawn.“ oder „The parkour list is missing.
  Please start the game from the Rift launcher.“: Schreib die Zeile ab oder mach ein Foto davon.

## Schritt 8 – Bubble Builds (15.40 bis 16.00, und als Experiment auf 19.10)

Bubble Builds ist der durchsichtige „Luftpolster“-Look der Bauten aus Chapter 2 Season 5–6. Es gibt ihn nur
im Leistungsmodus auf Fortnite 15.40 bis 16.00. Auf 15.30 und 16.10 bis 16.40 ist er „Experimental“ (kann
kommen oder nicht). Auf **19.x** ist er auch „Experimental“: Leistungsmodus plus **Meshes: Low** – nah am alten
Look, aber nicht genau gleich. Umschalten geht nicht während des Spiels – es gilt beim nächsten Start.

Mit Bubble Builds ändert Rift für dieses eine Spiel drei Zeilen in Fortnites eigener Einstellungsdatei und
**setzt sie danach von selbst zurück** (das hattest du so gewollt). Mach bitte vorher eine Kopie von
`%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini` (z. B. auf den Desktop),
damit du am Ende vergleichen kannst.

**Auf 19.10** (kein anderer Build nötig):

- [ ] **Settings** → die Karte „Bubble Builds“ ganz oben → einschalten. Sie hat das Abzeichen „Experimental“
      und sagt „Works as an experiment on your active build, Fortnite 19.10. It's not the exact Chapter 2 look.“
- [ ] **Library**: Die 19.10-Karte zeigt „Bubble Builds: Experimental“.
- [ ] **Host & Play.** Im Live Log steht:
      - „Backed up Fortnite's graphics settings. They are put back when the game closes.“
      - „Meshes set to Low for this game (it was …).“ – oder „Meshes is already Low.“
      - „Bubble Builds on: starting in Performance Mode (-FeatureLevelES31)“
      - Die Zeile „Starting your game: …“ enthält `-FeatureLevelES31`, die Zeile „Starting the server
        Fortnite: …“ **nicht**.
- [ ] Während das Spiel läuft, gibt es die Datei `%LOCALAPPDATA%\Rift\gus-backup.json`.
- [ ] Im Spiel ist die Grafik einfacher. Im Match ein paar Wände und Böden bauen → während sie hochgehen,
      sehen sie weißer und durchsichtiger aus. Bitte ein Screenshot.
- [ ] **F9** → **Options** → „Build look“: „Bubble Builds: On (Performance Mode, Meshes Low)“ mit grünem Punkt.
- [ ] **Stop all.** Kurz nachdem das Spiel zu ist, steht im Live Log und als Pop-up **„Fortnite's graphics
      settings were put back.“** Die Datei `gus-backup.json` ist weg.
- [ ] `GameUserSettings.ini` mit deiner Kopie vergleichen: Die Zeilen `bPreferFeatureLevelES31`,
      `PreferredFeatureLevel` und `MeshQuality` sind wie vorher. (Andere Zeilen, die Fortnite selbst während
      des Spiels gespeichert hat, z. B. die letzte Spielzeit, dürfen anders sein – das ist normal.)
- [ ] **Absturz-Test (freiwillig):** Host & Play mit Bubble Builds → während das Spiel läuft, `Rift.exe` im
      Task-Manager beenden → Fortnite auch schließen → Rift wieder starten → im Live Log steht, dass die
      Einstellungen zurückgesetzt wurden.
- [ ] Bubble Builds ausschalten → nochmal **Host & Play** → kein `-FeatureLevelES31` und keine „Backed up …“-Zeile
      im Log; F9 → Options sagt „Bubble Builds: Off – turn it on in the launcher, then restart the game.“

**Auf 15.40 bis 16.00** (nur wenn du so einen Build hast):

- [ ] **Library** → auf der 19.10-Karte **…** → **Remove from list** (deine Dateien bleiben unberührt). Ein neues
      Profil nimmt im Moment immer den *ersten* Build in der Library.
- [ ] **Add a build** → dein 15.40-bis-16.00-Ordner → **Check** → **Add build**. Die Zeile „Bubble Builds“ auf der
      Karte zeigt **Supported** (oder **Experimental** bei 15.30 / 16.10 bis 16.40).
- [ ] **Profiles** → **New profile** → ein Name wie „Bubble test“ → **Create** → **Use this profile**.
- [ ] **Host & Play** → dieselben Log-Zeilen wie oben. Im Match haben die Bauten den durchsichtigen
      „Luftpolster“-Look. Bitte ein Screenshot. F9 → Options → „Build look“ mit grünem Punkt.
- [ ] **Stop all** → „Fortnite's graphics settings were put back.“
- [ ] Später fügst du 19.10 genauso wieder hinzu; das Profil „Default“ geht dann von selbst wieder.

**Andere Versionen:** Die Settings-Karte sagt „Not available for <Version>. … try Bubble look in the F9 menu.“
**Host & Play** → „Bubble Builds are on, but Fortnite <Version> can't show them – starting normally“, und
Fortnites Einstellungsdatei wird nicht angefasst. F9 → Main → „Graphics“ → **Bubble look** und **Mobile Builds**
gehen auf jeder Version, sofort.

## Schritt 9 – Beenden

- [ ] Home → **Stop all** → Spiel, Server-Fortnite (samt Fenster, falls eingeblendet) und Backend sind weg (Task-Manager: kein
      `FortniteClient-Win64-Shipping.exe`, kein `node.exe` von Rift).
- [ ] Schau im Task-Manager auch nach `FortniteLauncher.exe` und `FortniteClient-Win64-Shipping_EAC.exe`.
      Wenn die noch da sind (angehalten), sag mir bitte Bescheid.
- [ ] Nochmal **Host & Play** → klappt ein zweites Mal ohne Neustart von Rift.

## Schritt 10 – Spielregeln („Classic match“)

„Classic match“ heißt: wie früher – kein Lategame, normale Munition, normales Material. Bisher waren
Munition und Material immer unendlich. Jetzt entscheidet jedes Profil selbst.

- [ ] **Profiles** → auf deinem 19.10-Profil **…** → **Edit**. Rechts unter „Match rules“ gibt es drei
      Schalter: „Lategame“, „Infinite ammo“, „Infinite materials“. Bei einem Profil von vor dieser Version
      sind „Infinite ammo“ und „Infinite materials“ jetzt **aus**; „Lategame“ ist so, wie du es eingestellt
      hattest.
- [ ] Sind alle drei aus, steht dort ein goldenes Abzeichen **Classic match**, und unter den Schaltern:
      „Classic match = like back then: full map, normal ammo and materials.“
- [ ] „Infinite ammo“ einschalten → das Abzeichen zeigt **Custom**, und ein Knopf **Classic** erscheint.
      **Classic** drücken → alle drei sind wieder aus. **Save**.
- [ ] Auf der Profil-Karte steht „Rules: Classic match“ (ist etwas an, steht dort stattdessen das, z. B.
      „Lategame · Infinite ammo“).
- [ ] **New profile** → die drei Schalter sind am Anfang aus.
- [ ] **Host & Play** mit „Classic match“ → **Start match** → im Match:
      - beim Schießen geht die Munition runter und kann ausgehen;
      - Bauen verbraucht dein Material (vorher mit der Spitzhacke sammeln);
      - **Match Control** → **Game** → „Infinite“: „Infinite ammo“ und „Infinite materials“ sind aus.
- [ ] Auf **Match Control** „Infinite ammo“ einschalten → ab jetzt bleibt deine Munition voll. Wieder
      ausschalten.
- [ ] Profil bearbeiten: „Infinite ammo“ und „Infinite materials“ an → **Save** → **Stop all** →
      **Host & Play** → Munition und Material gehen nie aus, und beide Schalter auf Match Control sind an.

## Schritt 11 – Waffen aufheben und tauschen

Bisher konnte das Aufheben hängen bleiben: Nach einem Tausch fielen Munition und Material wieder auf den
Boden, mit der Spitzhacke in der Hand ließ sich keine Waffe aufheben, oder deine Waffe wurde getauscht,
obwohl ein Platz frei war. Teste das in einem Solo-Match auf 19.10 (die Spawn-Insel vor dem Bus reicht).
Heb die Sachen auf wie immer.

- [ ] **Platz frei, Spitzhacke in der Hand:** eine Waffe vom Boden aufheben → sie kommt in einen freien Platz.
- [ ] **Platz frei, Waffe in der Hand:** eine zweite Waffe aufheben → sie kommt in einen freien Platz. Deine
      Waffe wird nicht fallen gelassen.
- [ ] **Alle 5 Plätze voll, Waffe in der Hand:** Plätze füllen (Waffen aufheben, oder im Launcher
      **Match Control** → **Game** → „Give items“ → eine Waffe wählen → **Give to me**, mit verschiedenen
      Waffen). Eine Waffe in die Hand nehmen (nicht die Spitzhacke) und eine Waffe vom Boden aufheben →
      deine Waffe landet vor dir, die neue hast du in der Hand.
- [ ] **Direkt nach dem Tausch:** über Munition und Holz, Stein oder Metall laufen → alles kommt ins Inventar
      und fällt **nicht** wieder auf den Boden.
- [ ] **Alle 5 Plätze voll, Spitzhacke in der Hand:** eine Waffe aufheben wollen → sie bleibt auf dem Boden
      (oder landet wieder dort). Dann eine Waffe in die Hand nehmen und sie aufheben → jetzt wird getauscht.
- [ ] **Ein Stapel mit Platz:** Hast du einen Stapel, der nicht voll ist (z. B. „Small Shield Potion“ aus
      „Give items“), und hebst mehr davon auf → der Stapel wird größer, nichts wird getauscht.
- [ ] Bei allem gilt: **Nichts verschwindet.** Jeder Gegenstand ist entweder in deinem Inventar oder auf dem
      Boden.

## Schritt 12 – Bodenloot und die Loot-Liste (19.10)

Bisher hat der Server auf 19.10 die Loot-Plätze auf dem Boden entfernt, ohne sie zu füllen. Jetzt füllt er
jeden Platz einmal pro Match. Ein paar leere Plätze sind normal (früher waren auch manche Plätze leer).

- [ ] Solo-Match mit „Classic match“ → **Start match**. Auf der Spawn-Insel und nach der Landung (z. B. in
      einem benannten Ort) liegen Waffen, Munition und Items auf dem Boden in den Häusern.
- [ ] Truhen gehen weiterhin auf und lassen Loot fallen.
- [ ] **Loot-Liste:** direkt nach **Start match** (während die Karte lädt) auf **Live Log** → **Server** →
      ins Feld „Search the log…“ `loot` tippen. Du siehst Zeilen mit der Kategorie „loot“:
      - „features: …“ (die Spiel-Teile der Season, die Loot dazugeben),
      - „items: …“ (wie viele verschiedene Items vorkommen können),
      - viele Zeilen „item …“ (je ein Item, höchstens 400).
      **Copy** drücken und mir schicken. Dann sehe ich, welche Items aus Chapter 3 Season 1 dabei sind.
- [ ] Tauchen Season-Items im Match auf (z. B. die Web-Shooter von Spider-Man)? Schreib auf, was du gefunden
      hast und ob es funktioniert.
- [ ] Nach dem Match: `<dein 19.10-Ordner>\FortniteGame\Binaries\Win64\stdout.log` mit dem Editor öffnen, nach
      `[FloorLoot]` suchen und mir diese Zeilen schicken (eine pro Platz-Art, `Tiered_Athena_FloorLoot_Warmup_C`
      und `Tiered_Athena_FloorLoot_01_C`). Sie sehen so aus:
      `[FloorLoot] Tiered_Athena_FloorLoot_01_C: … spots, … filled now, … empty now, … already rolled`.
      Gibt es auf 19.10 keine solche Zeile → bitte Bescheid sagen. (Mach das vor dem nächsten
      **Host & Play** – die Datei fängt bei jedem Server-Start neu an.)

## Schritt 13 – KI-Bots (19.10, experimentell)

Die eigenen KI-Spieler von Fortnite. Sie sollen wie echte Spieler aus dem Bus springen, Loot sammeln und
kämpfen. Nur auf 19.10 mit CL-18675304, und nur experimentell: Niemand hat sie bisher im Spiel getestet. Sie
sind nicht die Übungspuppen unter **Match Control** → **Target dummies**, die still stehen.

**Bevor du anfängst:** Der Server schaltet Bots nur ein, wenn deine Spieldatei genau Epics 19.10-Datei ist.
Explorer → `<dein 19.10-Ordner>\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe` → Rechtsklick →
**Eigenschaften** → bei „Größe“ sollte **198.580.704 Bytes** stehen. Wenn nicht, bleiben die Bots aus – mach
den Test trotzdem und schick mir die Größe.

- [ ] **Profiles** → dein 19.10-Profil **…** → **Edit**. Bereich „AI bots“ mit dem Abzeichen „Experimental ·
      19.10 only“. „Play with AI bots“ einschalten, „Number of bots“ z. B. 30, „Bot skill“ **Easy** →
      **Save**. Die Karte zeigt „AI bots: 30 · Easy“ und den Tag „AI bots“.
- [ ] (Wenn du einen anderen Build hast, z. B. einen aus Schritt 14:) In einem Profil dafür ist der Bereich
      „AI bots“ ausgegraut, mit z. B. „Fortnite 18.30: AI bots aren't available for this version yet.“
- [ ] **Host & Play**. **Match Control** → **Game**: Auf der Start-Karte stehen „Mode Solo“, „Lategame Off“ und
      „AI bots 30 · Easy“. **Start match** drücken.
- [ ] **Live Log**, ins Suchfeld `bots` tippen. Während die Karte lädt, solltest du das sehen:
      - „checks passed for 19.10 CL 18675304, hooks installed; 30 bots, ELO 500“,
      - „service set up, 30 bots, ELO 500 (playlist …)“,
      - Quelle **Rift**: „AI bots are on for this match.“
      Später z. B.: „bot service started“, „spawn amount: 30 bots (…)“, „1 bots spawned“, „10 bots spawned“,
      „cached … POI volumes and … foundations“.
- [ ] **Wenn die Bots aus sind:** eine Meldung „AI bots are off for this match“ mit dem Grund (z. B. „Bots
      aren't available for this copy of 19.10.“), und im Live Log eine Zeile „disabled: …“. Das Match läuft
      ohne Bots. Schick mir bitte diese „disabled: …“-Zeile.
- [ ] Im Spiel bitte beobachten und aufschreiben:
      - Erscheinen Bots (vor dem Bus oder wenn er losfliegt)? Sie haben evtl. Standard-Skins.
      - Der Bus: Im Live Log steht „… bots got on the bus“. Springen die Bots ab und gleiten runter?
      - Landen sie, heben Waffen auf, schießen auf dich, bauen sie?
      - Wie gut sind sie auf **Easy**?
      - Der Sturm: Verlieren Bots außerhalb des Sturmkreises Leben und scheiden aus?
      - Bots erledigen: Geht die Zahl der übrigen Spieler runter? Bist du der Letzte: **Victory Royale**?
        (Im Live Log steht dann „all bots are out“.)
      - Bildrate und Stabilität: bitte 3 Matches mit 30 Bots spielen. Hänger oder Abstürze? Ungefähr wie viele
        FPS?
- [ ] **Normal** und **Hard** ausprobieren: **Stop all** → Profil bearbeiten → „Bot skill“ → **Save** →
      **Host & Play** (die Bot-Einstellungen gelten ab dem nächsten Start). Wie fühlen sie sich im Vergleich
      zu Easy an? Im Live Log steht dann ELO 1000 (Normal) oder 2000 (Hard).
- [ ] „Play with AI bots“ ausschalten → **Host & Play** → keine „bots“-Zeilen, keine Meldung, das Match ist wie
      vorher.

## Schritt 14 – Eine Version herunterladen (freiwillig – 18.30 braucht etwa 50 GB und 2 Stunden, Chapter 5 bis zu 120 GB)

Rift kann einige alte Builds herunterladen. Die Dateiliste kommt aus einem öffentlichen GitHub-Archiv, und
jede Spieldatei kommt direkt von Epics eigenen Download-Servern – nie von Re-Uploads. Epic hat bei vielen alten
Seasons Teile gelöscht, die kann man nicht herunterladen. **Chapter 3 Season 1 (19.10) gehört dazu** – deine
19.10 funktioniert aber weiter. **Neu:** Chapter 3 Season 3 und 4, ganz Chapter 4 (mit Season OG) und Chapter 5
Season 1–3 (21.x bis 30.x) kann man jetzt herunterladen. Die sind groß: etwa 40 GB (21.x, 22.x) bis etwa 120 GB
(30.x) auf der Festplatte.

**Umschauen (es wird nichts heruntergeladen):**

- [ ] **Library** → **Download a version** (Knopf oben, oder die Kachel unter „Add a build“). Die Seite
      „Download a version“ geht auf; in der Seitenleiste bleibt „Library“ hervorgehoben.
- [ ] Oben: Reiter „Chapter 1“ bis „Chapter 5“. Grüne Zahlen: „Chapter 2“ 5, „Chapter 3“ 2, „Chapter 4“ 5,
      „Chapter 5“ 3. „Chapter 1“ hat keine.
- [ ] **Chapter 1:** ein Hinweis „All of Chapter 1 · Not available from Epic.“ mit der Erklärung, und auf jeder
      Karte steht „Not available from Epic“.
- [ ] **Chapter 3:** nur der Hinweis „Seasons 1 and 2 · Not available from Epic.“ Auf der Karte „Season 1“ steht
      „Epic deleted some of its files.“ und in Grün „Your 19.10 keeps working.“ „Season 3“ und „Season 4“ sind
      „Available“; auf „Season 3“ steht „3 builds · from 35.0 GB“ und eine kurze Zeile „Vibin': Reality Tree,
      Ballers, Darth Vader and Indiana Jones. Dragon Ball from 21.40.“
- [ ] **Chapter 4:** alle fünf Seasons sind „Available“, oben kein Hinweis. Auf „Season OG“ steht „3 builds · from
      74.2 GB“ und „The Chapter 1 map comes back: Season 5 (27.00), Seasons 7–8 (27.10), Seasons 9–X (27.11).“
- [ ] **Chapter 5:** Season 1, 2 und 3 sind „Available“. Auf **Season 3** klicken → oben steht der neueste Build:
      „30.40“ mit „107.8 GB download · 116.0 GB on disk · about 4 h 50 min at 50 Mbit/s“ und in Orange „Very big:
      about 116 GB on disk. Last Chapter 5 Season 3 update: Fall Guys event (Where We Fallin').“ 30.10 wählen →
      unter dem Ordner steht „Needs about 121.9 GB free on that drive.“ Danach **Cancel**.
- [ ] **Chapter 2:** „Season 3“, „Season 5“, „Season 6“, „Season 7“ und „Season 8“ sind „Available“; auf
      „Season 8“ steht „7 builds · from 40.1 GB“.
- [ ] Auf **Season 8** klicken → ein Fenster „Chapter 2 · Season 8“. Oben steht der neueste Build: „18.30“, mit
      „41.1 GB download · 45.4 GB on disk · about 1 h 50 min at 50 Mbit/s“ und „Experimental“. „Download to“ ist
      schon ausgefüllt (z. B. `D:\Rift\Builds\18.30-CL-17882303`), darunter „Needs about 47.5 GB free on
      that drive.“
- [ ] **Ordner-Prüfungen** (jedes Mal: den Ordner bei „Download to“ eintippen und **Download 18.30** drücken –
      der rote Text erscheint unter dem Feld, nichts startet):
      - ein Ordner mit Dateien drin, z. B. `C:\Users\georg\Downloads` → „This folder already has other files in
        it. Pick an empty folder.“
      - falls du OneDrive nutzt: ein Ordner darin → „This folder is synced by OneDrive. Pick a folder outside
        OneDrive, or it will try to upload the whole game (up to about 120 GB).“
      - falls du einen USB-Stick mit FAT32 hast: ein Ordner darauf → „Drive E: can't hold files bigger than 4 GB
        (FAT32). Pick a folder on another drive.“ (mit deinem Laufwerksbuchstaben)
      - ein Laufwerk mit zu wenig Platz → „There isn't enough free space on drive D:. This version needs
        47.5 GB and … GB is free. Free up space or pick another folder.“ (mit deinem Laufwerksbuchstaben)
      Danach **Cancel**.

**Ein echter Download** (nur wenn du Zeit und Platz hast; 18.30 ist eine gute Wahl):

- [ ] 18.30 wählen, den Ordner lassen → **Download 18.30**. Oben erscheint eine Karte mit vier Schritten:
      „Check at Epic“, „Download“, „Check files“, „Add to Library“. Zuerst „Checking that Epic still has every
      file… (a few minutes)“, dann die Prozent, die aktuelle Datei, „Downloaded“, „Speed“, „Time left“ und
      „Files … of 785“. In der Seitenleiste zeigt eine kleine Fortschritts-Pille den Stand, auch auf anderen
      Seiten („Checking at Epic, a few minutes“).
- [ ] **Pause** → „Pausing…“ → „Paused – everything downloaded so far is kept.“ → **Resume** → es geht weiter
      (zuerst kurz wieder „Check at Epic“, dann laufen die Prozent dort weiter, wo sie waren).
- [ ] Rift schließen, während es lädt → „Close Rift?“ zeigt „Download (18.30)“ → **Stop & close**. Rift
      öffnen → **Library** → **Download a version** → die Karte zeigt „Paused“ → **Resume** → es geht weiter.
- [ ] **Cancel** → „Cancel the download of 18.30?“ – „Delete the downloaded files? If you keep them, downloading
      18.30 into the same folder again continues where it stopped.“ → **Keep files**. 18.30 nochmal in denselben
      Ordner starten → es geht weiter, statt von vorne anzufangen.
- [ ] Fertig laden lassen: „Check files“ → „Add to Library“ → „Fortnite 18.30 is ready“ – „It's in your Library
      now. Press Play to use it.“, die Meldung „18.30 is ready“, und im Live Log „Download of 18.30 finished and
      added to your Library“.
- [ ] **Play** → du bist auf Home, Meldung „Fortnite 18.30 is set“ (ein Profil „Fortnite 18.30“ mit „Classic
      match“ wurde angelegt, falls du für diesen Build noch keins hattest). In der **Library** gibt es eine
      18.30-Karte mit „Untested“.
- [ ] **Host & Play** → startet 18.30, und kannst du ein Match spielen?
- [ ] Erscheint eine Fehler-Karte: ein Screenshot davon und die Live-Log-Zeile, die mit „Download of“ anfängt.
- [ ] (Freiwillig, wenn du Platz hast) eine neuere Season, z. B. **Chapter 4 → Season OG → 27.11** (87.3 GB auf
      der Festplatte) oder **Chapter 3 → Season 3 → 21.50** (40.1 GB). Die Schritte sind gleich; „Check at Epic“
      kann bei den großen ein paar Minuten dauern. Danach **Host & Play** damit und sag mir: Startet es, kannst
      du ein Match spielen?

## Schritt 15 – Bosses & NPCs (experimentell, noch im Bau)

Das Ziel: Die Bosse, Wachen und Tiere der Season laufen herum, wie damals. Das ist noch im Bau: Der Game Server
bekommt es Season für Season (zuerst 19.10). Solange deine Season noch nicht fertig ist, antwortet der Server
mit „Not available“ – das ist in Ordnung und so erwartet. Beide Antworten helfen mir, also schick mir bitte
deine. Probier es zuerst mit 19.10, dann mit einem anderen Build, den du hast (z. B. einem aus Schritt 14).

- [ ] **Profiles** → dein Profil **…** → **Edit**. Im Kasten „Match rules“ gibt es einen Schalter „Bosses & NPCs“
      mit dem Abzeichen „Experimental“ und dem Text „Bosses, guards and creatures of this season walk around,
      like back then. Still being built: not every season has them yet.“ Einschalten. Bei „Max. bosses & NPCs“
      steht 40 – so lassen → **Save**. Die Karte bekommt den Tag „Bosses & NPCs“; bei „Rules“ steht weiter
      „Classic match“.
- [ ] **Host & Play**. **Match Control** → **Game** → Kasten „Game mode“: „Bosses & NPCs“ ist an, „Max. bosses &
      NPCs“ 40. **Start match** drücken.
- [ ] Während die Karte lädt, erscheint im selben Kasten eine Zeile „This match“ mit einem Chip. Beides ist in
      Ordnung – schreib auf, was du bekommst:
      - orange „Not available: …“ mit dem Grund (heute wohl „Not available: not built yet for this version“)
        und einmal die Meldung „Bosses & NPCs aren't available this match“, oder
      - grün „Active“ oder „Active · N spawned“.
- [ ] **Live Log** → den Filter **Bosses & NPCs** anklicken (neben Info/Warning/Error). Du siehst die
      `[LivingWorld]`-Zeilen des Servers (ohne das Kürzel, Kategorie „livingWorld“) und von der Quelle **Rift**
      eine Zeile wie „Bosses & NPCs aren't available: …“ oder „Bosses & NPCs are on: N spawned.“ → **Copy** und
      schick mir diese Zeilen. Nochmal auf **Bosses & NPCs** klicken, dann siehst du wieder alles.
- [ ] Nur wenn der Chip „Active“ zeigte: Schreib auf, was du im Spiel siehst. Tauchen Bosse, Wachen oder Tiere
      auf? Wo? Hänger oder Abstürze?
- [ ] Wenn das Match vorbei ist, verschwindet die Zeile „This match“.
- [ ] „Bosses & NPCs“ im Profil ausschalten → **Host & Play** → **Start match**: keine Zeile „This match“, keine
      Meldung, keine „Bosses & NPCs“-Zeile von **Rift** im Live Log – das Match ist wie vorher.

## Schritt 16 – Mit einem Freund spielen (zwei PCs)

Du brauchst einen Freund mit Rift und der gleichen Fortnite-Version. Ihr seid beide im gleichen Tailscale- oder
Radmin-VPN-Netz. Du bist der Host, dein Freund kommt dazu.

- [ ] **Host:** **Profiles** → dein Profil **…** → **Edit**. Unter „Playlist" steht „With friends":
      **Against each other** (jeder gegen jeden, Solo) oder **Together** (ein Team). Nimm **Together** → die
      Playlist wird Duos (du kannst auch Trios oder Squads nehmen). Bots und Lategame gehen bei beidem an oder aus.
      **Save**.
- [ ] **Host:** **Servers & Friends** → Kasten „Can friends reach me?". Steht dort „Not yet" oder „blocked",
      drück **Allow friends to connect** → Windows fragt → **Ja**. Jetzt steht dort „Yes". (Bei Nein ändert sich nichts.)
- [ ] **Host:** **Host & Play**. Auf Home erscheint der Knopf **Invite friends** – drück ihn („Invite copied").
      Oder **Servers & Friends** → Kasten „Invite friends": dort steht z. B. „Duo together · bots on",
      „Fortnite 19.10", „Tailscale" und ein Code mit `RIFT1:` → **Copy invite**. Schick die Zeile deinem Freund.
- [ ] **Freund:** **Servers & Friends** → Kasten „Join a friend" → die ganze Zeile einfügen → **Join**. Erst
      „Checking …", dann „Host found: Fortnite 19.10" mit „Waiting for players" und „Your game is starting".
- [ ] **Freund:** Wenn die Lobby da ist, **Play** drücken → du landest in der Lobby vom Host.
- [ ] **Host:** **Match Control** → **Start match**. Bei **Together** seid ihr im gleichen Team (gleiche Farbe
      auf der Karte, ihr könnt euch wiederbeleben). Die Bots sind in anderen Teams.
- [ ] Fehler ausprobieren und die Texte aufschreiben: Freund fügt `hallo` ein („That isn't an invite code …");
      Host drückt **Stop all**, Freund drückt **Join** („Your friend isn't hosting right now" oder „Can't reach
      your friend's PC", mit **Join anyway**); Freund ohne diese Version („You need Fortnite …", vielleicht mit
      **Download it**).
- [ ] Im Spiel: F9 → Main → „Join a server" → „On another PC" → Einladung einfügen → **Join**. Mit einer anderen
      Fortnite-Version kommt eine rote Zeile „This invite is for Fortnite …".
- [ ] **Host:** **Servers & Friends** → **Remove the rule** → Windows fragt → **Ja**. Dann steht dort wieder „Not yet".

## Andere Versionen testen (ungetestet, aber startbar)

Rift startet jede Version von 1.7 bis 30.x. Für alles außer 19.10 gilt: gleiche Schritte wie oben, nur
dass die Build-Karte „Untested“ zeigt und im Log ein Hinweis steht. Wenn es nicht klappt, sind diese drei
Dateien wichtig:

- `%LOCALAPPDATA%\Rift\logs\redirect.log` – stand die Umleitung? („Ready - …“ oder eine Zeile mit „ERROR:“)
- `%LOCALAPPDATA%\Rift\logs\client-diagnostics.log` – lief das Ingame-Menü an?
- `<Build>\FortniteGame\Binaries\Win64\stdout.log` und der Ordner `MagnesiumCrashes` daneben – was der Game
  Server sagt.

Bekannte Grenzen: 9.40–10.40 ohne Party/XMPP; ab 31.00 noch nicht startbar;
KI-Bots nur auf 19.10 (CL-18675304). Bei Trickshot-Parkours kann es je nach Version andere Objekte geben – fehlt
eins, sagt der Server das in der Konsole (siehe Schritt 7). Einen Build, den du in Schritt 14 heruntergeladen
hast, testest du genauso.

## Was ich brauche, wenn etwas nicht klappt

1. **Welcher Schritt** aus dieser Liste (z. B. „Schritt 3, ‚Logged in‘ kommt nicht“).
2. **Screenshot** vom Launcher (Launch steps + Live Log) und ggf. vom Spiel (F9-Menü).
3. **Logs**: Seite **Live Log** → **Copy** (oder die Dateien aus `%LOCALAPPDATA%\Rift\logs\`; der Knopf
   **Folder** öffnet den Ordner).
4. Bei einem Fortnite-Absturz: Seite **Crash Analysis** → den neuesten Eintrag → **Copy report**.
5. Bei Trickshot-Sachen: die Zeilen aus der Konsole (**F8**), die mit „[Rift]“ beginnen.
6. Bei Bubble Builds: ein Screenshot deiner Bauten im Spiel, die Zeile „Starting your game: …“ und die Zeilen
   mit „graphics settings“ oder „Meshes“.
7. Bei Reset builds: ein Screenshot von F9 → Options → „Reset builds“ und die `[reset-builds]`-Zeilen aus der
   `stdout.log` des Servers.
8. Bei KI-Bots: Live Log → `bots` suchen → **Copy**, dazu was du im Spiel gesehen hast (Schritt 13).
9. Bei Loot: Live Log → `loot` suchen → **Copy**, dazu die `[FloorLoot]`-Zeilen aus `stdout.log` (Schritt 12).
10. Bei einem Download: ein Screenshot der Download-Karte und die Live-Log-Zeilen, die mit „Download of“ anfangen.
11. Bei Bosses & NPCs: der Text auf dem Chip, die Build-Version und die Live-Log-Zeilen mit dem Filter **Bosses &
    NPCs** (**Copy**) (Schritt 15).

Kurz und ehrlich: Ich kann hier kein Fortnite starten. Alles bis zum Ladebildschirm ist aus den
Quell-Projekten (Reboot-Ablauf, LawinServer, Tellurium, Magnesium) 1:1 nachgebaut und gegen deren Verhalten
geprüft – ob es bei dir durchläuft, zeigt erst dieser Test. Das gilt auch für die neuen Teile: Die KI-Bots und
die Korrekturen beim Aufheben und beim Bodenloot wurden hier nur testweise kompiliert, und der Downloader hat in
einem Test nur drei kleine Dateien von Epics Servern geholt – ein ganzer Download, die Bots und der Loot liefen
noch nie in einem echten Spiel. Auch die neuen Seasons 21.x–30.x liefen noch nie in einem echten Spiel, und
Bosses & NPCs sind noch im Bau (heute antwortet der Server mit „Not available“).
