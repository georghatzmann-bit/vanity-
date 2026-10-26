# Test-Checkliste – Vollversion (Deutsch)

Deutsche Kopie von [`03-test-checklist.md`](03-test-checklist.md). Der Launcher, das Installationsprogramm
und das F9-Menü sind jetzt auf Englisch. Darum stehen alle Knöpfe, Reiter und Meldungen hier **genau so,
wie du sie auf dem Bildschirm siehst** – also auf Englisch.

So testest du Niobium mit deinem echten Fortnite 19.10. Bitte **in dieser Reihenfolge**. Bei jedem Punkt,
der nicht klappt: Screenshot + Log an mich (siehe „Was ich brauche“ ganz unten).

Niobium hieß früher Vanity. Wenn du Vanity installiert hattest, übernimmt Niobium deine Einstellungen
von selbst – diese Liste sagt dir, worauf du achten sollst.

## Herunterladen

Direkter Link (immer der neueste Stand):
**https://github.com/georghatzmann-bit/vanity-/releases/download/niobium-test/Niobium-Setup.exe**

Windows meldet evtl. „Der Computer wurde durch Windows geschützt“, weil der Installer nicht signiert ist
→ **Weitere Informationen** → **Trotzdem ausführen**. Installiert wird nur für deinen Benutzer, ohne
Admin-Rechte. Wenn dein Virenprogramm die DLLs blockiert: `%LOCALAPPDATA%\Niobium` als Ausnahme eintragen
(dorthin installiert sich Niobium, und dort liegen auch Logs und Server-Daten). Das ist bei allen
OG-Launchern so, weil die DLLs in Fortnite geladen werden.

## Vorher

- Reboot Launcher, den alten Vanity-Launcher und Fortnite komplett schließen (Task-Manager: kein
  `FortniteClient-Win64-Shipping.exe`).
- Port 80 frei? Falls Skype, IIS oder etwas anderes ihn belegt: in Niobium → **Settings** → **Network** →
  **Matchmaker port** z. B. auf 8080 stellen.
- **Backend port** zeigt 3551 und **Game server port** 7777. Beide sind fest (die DLLs nehmen immer
  diese Ports), du kannst sie nicht ändern.
- Windows-Firewall: Beim ersten Start fragt Windows nach `node.exe` und Fortnite – **Zugriff zulassen**
  (private Netzwerke reichen).

## Schritt 0 – Installieren

- [ ] `Niobium-Setup.exe` starten. Zuerst blendet eine kleine dunkle Niobium-Karte ein und wieder aus.
- [ ] Dann kommt der dunkle Installer: „Welcome to Niobium“, links das Logo. **Next** → den Ordner so
      lassen → **Install**.
- [ ] Nur wenn du Vanity installiert hattest: Der Installer entfernt das alte Vanity-Programm leise –
      du musst nichts tun. Danach steht im Startmenü „Niobium“ und kein „Vanity“ mehr. Deine
      Vanity-Einstellungen werden nicht gelöscht.
- [ ] Nach dem Installieren kommt die letzte Seite von selbst: „You're ready to drop.“, mit den Häkchen
      „Create desktop shortcut“ und **„Launch Niobium now“** und dem Link „Source code and help (GitHub)“.
      Unter Windows 11 ist auch die Titelleiste des Installers dunkel.
- [ ] „Launch Niobium now“ angehakt lassen → **Finish**.

## Schritt 1 – Erster Start

- [ ] In der Bildschirmmitte erscheint eine kleine Karte mit dem Niobium-Logo, „old seasons, new shine.“
      und einer laufenden Linie. Kurz danach geht das große Fenster auf und die Karte verschwindet
      (spätestens nach 8 Sekunden).
- **Wenn du vorher Vanity benutzt hast:**
  - [ ] Eine Karte **„What's new“** erscheint: „Vanity is now Niobium“, „Bubble Builds“, „A fresh look“,
        „Everything in English“ → **Got it**.
  - [ ] In der **Library** ist dein 19.10-Build noch da. Unter **Profiles** sind deine Profile noch da (das
        Profil „Standard“ heißt jetzt „Default“).
  - [ ] **Live Log**, Quelle **Niobium**: eine Zeile „Copied your settings from Vanity to Niobium (…). The
        old Vanity folders were left as they are.“
- **Wenn Niobium neu auf diesem PC ist:**
  - [ ] Ein Willkommens-Bildschirm über das ganze Fenster: „Welcome to Niobium“ → **Let's set it up** →
        „What should we call you?“ (3–16 Buchstaben oder Zahlen) → **Next** → „Add your Fortnite build“ →
        **Browse** → dein 19.10-Ordner → **Check** → **Add build** → „You're all set“ → **Let's go**.
  - [ ] Später geht auch: **Skip setup** (oben rechts) schließt den Willkommens-Bildschirm.
- [ ] Niobium schließen und wieder öffnen → kein Willkommen und kein „What's new“ mehr.
- [ ] Alles, was du siehst, ist auf Englisch, auch die Knöpfe und die Meldungen unten rechts.

## Schritt 2 – Build hinzufügen (ohne Fortnite zu starten)

Überspringen, wenn du den Build schon im Willkommen hinzugefügt hast oder er von Vanity übernommen wurde.

- [ ] **Library** → **Add a build** → **Browse** → `C:\Users\georg\Downloads\windows-19.10` → **Check**.
- [ ] Vier grüne Haken: „Found FortniteClient-Win64-Shipping.exe“, „Version: 19.10 (CL-18675304)“,
      „Game files found (… .pak files)“, „Version 19.10: Tested“. Darunter: „Fortnite 19.10“,
      „Chapter 3 · Season 1 · Unreal Engine 5.0“ (steht dort „Unreal Engine (unknown)“, ist das auch okay).
- [ ] **Add build** → eine Karte erscheint mit „Tested“ und „Active“. Ihre Zeile „Bubble Builds“ zeigt „—“
      (19.10 hat keine Bubble Builds). Das Profil „Default“ wurde von selbst angelegt (Seite **Profiles**).
- [ ] Auf der Karte **Open folder** → der Explorer öffnet den Build-Ordner.
- [ ] Niobium schließen und neu öffnen → Build und Profil sind noch da.

## Schritt 3 – Host & Play: Backend und Server

Auf **Home** auf **Host & Play** drücken. Der Bereich „Launch steps“ zeigt sieben Schritte (Backend,
Server, Redirect, Login, Your game, Game server, Lobby). Schau dazu auf die Seite **Live Log** (in der
Seitenleiste). Erwartete Reihenfolge:

- [ ] „Backend is listening on 127.0.0.1:3551“ (Schritt *Backend*).
- [ ] „Starting the server Fortnite: …“ und „Redirect loaded“ (Schritte *Server*, *Redirect*).
      Das Server-Fortnite läuft **ohne Fenster** (`-nullrhi`). Du siehst es nur im Task-Manager.
- [ ] Im Server-Log eine Zeile mit `ContinueLoggingIn`, markiert mit **„Logged in“** (Schritt *Login*).
      → Wenn stattdessen „Can't reach the backend“ oder „Build damaged“ kommt: Log an mich schicken.
- [ ] Kurz danach: „niobium_server.dll loaded“ und ein **neues Fenster „Magnesium (FN 19.10, UE 5.0)“**.
      Das ist das Server-Fenster – es bleibt offen, solange der Server läuft. Nicht schließen.
- [ ] Gleichzeitig startet **dein Spiel** („Starting your game: …“, Schritt *Your game*) – ein normaler
      Fortnite-Start bis in die Lobby. Melde dich nicht an, es gibt kein Login: Niobium meldet dich mit dem
      Spielernamen aus deinem Profil an.
- [ ] Kurz nach dem Server-Fenster erscheint die Meldung **„The server is waiting for you“** (die
      Steuer-Pipe steht). Jetzt im Launcher **Match Control** → Reiter **Game** → **Start match** drücken –
      oder im Server-Fenster unten links **START SERVER**.
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
- [ ] Du kannst laufen, bauen, bearbeiten und Waffen aufheben.

Falls das Spiel keine Verbindung zum Server bekommt: War „Server ready“ schon da? Wenn nicht, warten und
nochmal Play drücken.

## Schritt 5 – Server-Fenster (Magnesium) kennenlernen

Vieles geht auch im Launcher: Seite **Match Control** (Modus, Lategame, Bus, Sturm, Items, Trickshot, Bots).
Das Server-Fenster kann mehr (seine Texte kommen von Magnesium):

- [ ] **Playlist**: Knöpfe wie „Solos“, „Duos“, „Tournament Solos“ (Arena), „Zero Build …“. Vor dem Start
      wählen, dann das Match starten.
- [ ] **Late Game** anhaken → Lategame-Modus (Ausrüstung, kleine Zone).
- [ ] **Bots**: Anzahl eintragen und spawnen; „Use Custom Bot Names“ für eigene Namen.
- [ ] **Trickshot**: „Enable Trickshot Tab“ anhaken → ein neuer Reiter mit Wegpunkten, Zeitlupe („Toggle
      Crown Slomo“), „Negate Velocity on Win“, „Auto Reload on Waypoint TP“ und mehr.
- [ ] **Praktisch zum Testen**: „Infinite Materials“, „Infinite Ammo“, „Infinite Respawns“, „Siphon“.
- [ ] „Save Settings“ anhaken → die Einstellungen landen in `%LOCALAPPDATA%\Niobium\server\`.

## Schritt 6 – Ingame-Menü (F9)

Ob die DLL geladen ist, siehst du im Live Log: „niobium_client.dll loaded“ (Quelle **Game**).

- [ ] Im Spiel **F9** drücken → das Menü „Niobium | Menu“ geht auf, die Maus ist frei.
      Links stehen fünf Reiter: **Main**, **Commands**, **Options**, **Trickshot**, **Credits**.
      Alles ist auf Englisch.
- [ ] Reiter **Main** → „Editing“: „Reset on release“ an- und ausschalten und im Spiel beim Bearbeiten
      prüfen. In 19.10 steht dort nur dieser Schalter. „Edit on release“ gibt es nur bis 10.40,
      „Disable pre-edits“ nur bis 15.10.
- [ ] Reiter **Main** → „Field of view“: den Regler „Degrees (normal: 80)“ bewegen → das Bild ändert sich
      sofort. „Back to 80“ stellt es wieder normal.
- [ ] **F8** → Konsole; `fov 110` eingeben → Enter.
- [ ] Reiter **Options** → „Keys“ → **Change menu key [F9]** → eine andere Taste drücken → das Menü geht
      jetzt mit der neuen Taste auf. Danach wieder auf F9 stellen.
- [ ] Reiter **Options** → „Build look“: Bei 19.10 steht dort „Bubble Builds: Not available on 19.10“.
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
- [ ] Reiter **Credits**: Unten steht „Niobium is based on ATLAS Console by cipherfps, ralz and contributors.“
- [ ] Deine Einstellungen liegen danach in `%APPDATA%\Niobium\client.json`.

## Schritt 7 – Trickshot-Parkours testen

Ein Parkour ist eine fertige Trickshot-Strecke: eine Plattform in der Luft, Sprung-Objekte und Ziel-Bots,
die still stehen. Teste das in einem Solo-Match. Du musst schon auf der Insel stehen – nicht in der Lobby,
nicht im Bus.

Die Antworten vom Server stehen in der Konsole (**F8**). Sie beginnen mit „[Niobium]“.

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
      - In der Konsole steht: „[Niobium] "First Jump" is ready! Built: 10 floors, 1 jump objects, 1 target bots.“
- [ ] **Trickshot:** Lauf aufs Trampolin und triff den Bot, während du in der Luft bist.
      → Oben in der Bildmitte erscheint groß **TRICKSHOT!**, darunter dein Name und die Entfernung in Metern
      (etwa 3,5 Sekunden lang). Im Launcher kommt gleichzeitig die Meldung „TRICKSHOT! <dein Name>“.
      Triffst du ihn im Stehen, kommt kein Banner – das ist richtig so.
      Kein Banner trotz Sprung? Im Launcher: **Match Control** → **Trickshot** → „Trickshot banner“ →
      **Banner on** muss an sein.
- [ ] **Start over** (in F9 oder im Launcher): Du stehst wieder am Start und schaust nach vorne.
      Leben und Schild sind voll, die Waffen sind geladen. Hast du den Bot erledigt, ist er wieder da.
      In der Konsole steht: „[Niobium] Back at the start of "First Jump". Full health, weapons reloaded. …“
- [ ] **Ziel-Bot:** F9 → Trickshot → „Target bot“: Health 50, Distance 30 m → **Place bot in front of me**
      (im Launcher heißt der Knopf **Place bot**).
      → Ein Bot erscheint genau in deiner Blickrichtung, 30 m weit weg, auf deiner Höhe, auf einer Platte.
      In der Konsole steht: „[Niobium] Target bot is 30 m in front of you (50 health). Remove it: parkour clear“
- [ ] **Clear everything** (in F9 oder im Launcher): Plattformen, Trampolin und alle Ziel-Bots sind weg –
      auch der Bot von „Place bot in front of me“. In der Konsole steht: „[Niobium] Removed … pieces and …
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
  Warum: Niobium muss wissen, an welcher Stelle Fortnite eine Boden-Platte „anfasst“. Das ist nur an echten
  Bauten aus 10.40 geprüft. Dein Bild zeigt, ob es in deiner Version auch stimmt.
- **Ein Objekt fehlt.** In der Konsole steht dann zum Beispiel „[Niobium] Not in this version (left out):
  Trampoline.“ Schick genau diese Zeile und die Fortnite-Version. Dann suche ich einen Ersatz, den es in
  deiner Version gibt.
- **Eine andere Meldung**, zum Beispiel „None of the listed sniper rifles exist in this version.“,
  „… jump objects couldn't be placed.“, „… target bots couldn't spawn.“ oder „The parkour list is missing.
  Please start the game from the Niobium launcher.“: Schreib die Zeile ab oder mach ein Foto davon.

## Schritt 8 – Bubble Builds (braucht einen Build von 15.40 bis 16.00)

Bubble Builds ist der durchsichtige „Luftpolsterfolie“-Look der Bauteile aus Chapter 2 Season 5–6. Den gibt
es nur im Leistungsmodus („Performance Mode“) bei Fortnite 15.40 bis 16.00. Bei 15.30 und 16.10 bis 16.40
heißt es „Experimental“ (kann klappen, muss aber nicht). Während des Spielens lässt es sich nicht umschalten –
es gilt ab dem nächsten Start.

Wenn du keinen solchen Build hast: nur den Teil „Bei 19.10“ ganz unten machen.

**Build vorbereiten.** Ein neues Profil nimmt im Moment immer den *ersten* Build in der Library. Darum:

- [ ] **Library** → auf der 19.10-Karte **…** → **Remove from list** (deine Dateien bleiben unberührt).
- [ ] **Add a build** → dein Ordner mit 15.40 bis 16.00 → **Check** → **Add build**.
- [ ] Die Zeile „Bubble Builds“ auf der Karte zeigt **Supported** (oder **Experimental** bei 15.30 /
      16.10 bis 16.40); mit der Maus darüber siehst du die Erklärung. Die Zahl „Bubble Builds ready“ oben
      zählt ihn mit.
- [ ] **Profiles** → **New profile** → ein Name wie „Bubble test“, dein Spielername → **Create** → auf der
      neuen Karte **Use this profile**. Auf der Karte steht „Build: Fortnite 15.…“.
- [ ] Später fügst du 19.10 genauso wieder hinzu; das Profil „Default“ funktioniert dann von selbst wieder.

**Einschalten und spielen:**

- [ ] **Settings** → die Karte „Bubble Builds“ ganz oben → einschalten („On“). Unter dem Text steht
      „Works on your active build, Fortnite 15.…“ (oder der „Experimental“-Text).
- [ ] **Home**: Neben „Active build“ steht ein Abzeichen „Bubble Builds“.
- [ ] **Host & Play.** Im Live Log steht „Bubble Builds on: starting in Performance Mode (-FeatureLevelES31)“.
      Die Zeile „Starting your game: …“ enthält `-FeatureLevelES31`; die Zeile „Starting the server
      Fortnite: …“ enthält es **nicht**.
- [ ] Im Spiel ist die Grafik einfacher (Leistungsmodus). Im Match ein paar Wände und Böden bauen → sie haben
      den durchsichtigen „Luftpolsterfolie“-Look. Bitte schick mir einen Screenshot.
- [ ] **F9** → **Options** → „Build look“: „Bubble Builds: On (set in the launcher)“ mit einem grünen Punkt.
- [ ] **Stop all.** Hat Fortnite den Leistungsmodus als Standard gespeichert, erscheint ein Fenster
      „Performance Mode is now saved“: „Fortnite saved Performance Mode as your default. This also affects
      your other builds. Reset it?“ → **Reset** → die Meldung „Performance Mode reset“. (Kommt kein Fenster,
      hat Fortnite die Einstellung nicht geändert – das ist auch in Ordnung.) **Keep** lässt alles so.
- [ ] Bubble Builds ausschalten → nochmal **Host & Play** → kein `-FeatureLevelES31` im Log; in F9 → Options
      steht „Bubble Builds: Off – turn it on in the launcher, then restart the game.“

**Bei 19.10** (Schalter an):

- [ ] Auf der Karte in Settings steht „Your active build is Fortnite 19.10. Only on Fortnite 15.40 – 16.00
      (Chapter 2, Seasons 5–6). Try Mobile Builds in the F9 menu.“
- [ ] **Host & Play** → im Live Log steht „Bubble Builds are on, but Fortnite 19.10 can't show them –
      starting normally“. Das Spiel startet genau wie ohne Schalter.
- [ ] F9 → **Main** → „Graphics“ → **Mobile Builds**: geht bei jeder Version, sofort.

## Schritt 9 – Beenden

- [ ] Home → **Stop all** → Spiel, Server-Fortnite, Server-Fenster und Backend sind weg (Task-Manager: kein
      `FortniteClient-Win64-Shipping.exe`, kein `node.exe` von Niobium).
- [ ] Schau im Task-Manager auch nach `FortniteLauncher.exe` und `FortniteClient-Win64-Shipping_EAC.exe`.
      Wenn die noch da sind (angehalten), sag mir bitte Bescheid.
- [ ] Nochmal **Host & Play** → klappt ein zweites Mal ohne Neustart von Niobium.

## Andere Versionen testen (ungetestet, aber startbar)

Niobium startet jede Version von 1.7 bis 30.x. Für alles außer 19.10 gilt: gleiche Schritte wie oben, nur
dass die Build-Karte „Untested“ zeigt und im Log ein Hinweis steht. Wenn es nicht klappt, sind diese drei
Dateien wichtig:

- `%LOCALAPPDATA%\Niobium\logs\redirect.log` – stand die Umleitung? („Ready - …“ oder eine Zeile mit „ERROR:“)
- `%LOCALAPPDATA%\Niobium\logs\client-diagnostics.log` – lief das Ingame-Menü an?
- `<Build>\FortniteGame\Binaries\Win64\stdout.log` und der Ordner `MagnesiumCrashes` daneben – was der Game
  Server sagt.

Bekannte Grenzen: 9.40–10.40 ohne Party/XMPP; „Edit on release“ nur bis 10.40; ab 31.00 noch nicht startbar.
Bei Trickshot-Parkours kann es je nach Version andere Objekte geben – fehlt eins, sagt der Server das in der
Konsole (siehe Schritt 7).

## Was ich brauche, wenn etwas nicht klappt

1. **Welcher Schritt** aus dieser Liste (z. B. „Schritt 3, ‚Logged in‘ kommt nicht“).
2. **Screenshot** vom Launcher (Launch steps + Live Log) und ggf. vom Spiel oder Server-Fenster.
3. **Logs**: Seite **Live Log** → **Copy** (oder die Dateien aus `%LOCALAPPDATA%\Niobium\logs\`; der Knopf
   **Folder** öffnet den Ordner).
4. Bei einem Fortnite-Absturz: Seite **Crash Analysis** → den neuesten Eintrag → **Copy report**.
5. Bei Trickshot-Sachen: die Zeilen aus der Konsole (**F8**), die mit „[Niobium]“ beginnen.
6. Bei Bubble Builds: ein Screenshot deiner Bauten im Spiel und die Zeile „Starting your game: …“.

Kurz und ehrlich: Ich kann hier kein Fortnite starten. Alles bis zum Ladebildschirm ist aus den
Quell-Projekten (Reboot-Ablauf, LawinServer, Tellurium, Magnesium) 1:1 nachgebaut und gegen deren Verhalten
geprüft – ob es bei dir durchläuft, zeigt erst dieser Test.
