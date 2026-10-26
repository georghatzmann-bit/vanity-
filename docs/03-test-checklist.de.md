# Test-Checkliste – Vollversion (Deutsch)

Deutsche Kopie von [`03-test-checklist.md`](03-test-checklist.md). Der Launcher, das Installationsprogramm
und das F9-Menü sind jetzt auf Englisch. Darum stehen alle Knöpfe, Reiter und Meldungen hier **genau so,
wie du sie auf dem Bildschirm siehst** – also auf Englisch.

So testest du Niobium mit deinem echten Fortnite 19.10. Bitte **in dieser Reihenfolge**. Bei jedem Punkt,
der nicht klappt: Screenshot + Log an mich (siehe „Was ich brauche“ ganz unten).

Niobium hieß früher Vanity. Wenn du Vanity installiert hattest, übernimmt Niobium deine Einstellungen
von selbst – diese Liste sagt dir, worauf du achten sollst.

**Neu in dieser Version** (Schritte 10–14): Profile mit „Classic match“, Waffen aufheben und tauschen,
Bodenloot und die Loot-Liste bei 19.10, KI-Bots bei 19.10 (experimentell) und „Download a version“.
Nichts davon wurde schon in einem echten Spiel getestet – genau dafür sind diese Schritte da.

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
- [ ] Du kannst laufen, bauen, bearbeiten und Waffen aufheben. Profile spielen jetzt ein „Classic match“,
      solange du nichts anderes einschaltest: Munition und Material gehen aus wie früher. Sammle also
      zuerst mit der Spitzhacke etwas Holz, bevor du baust (mehr in Schritt 10).

Falls das Spiel keine Verbindung zum Server bekommt: War „Server ready“ schon da? Wenn nicht, warten und
nochmal Play drücken.

## Schritt 5 – Server-Fenster (Magnesium) kennenlernen

Vieles geht auch im Launcher: Seite **Match Control** (Modus, Lategame, Bus, Sturm, Items, Trickshot,
Target dummies).
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
      - Quelle **Niobium**: „AI bots are on for this match.“
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

## Schritt 14 – Eine Version herunterladen (freiwillig – braucht etwa 50 GB und 2 Stunden)

Niobium kann einige alte Builds herunterladen. Die Dateiliste kommt aus einem öffentlichen GitHub-Archiv, und
jede Spieldatei kommt direkt von Epics eigenen Download-Servern – nie von Re-Uploads. Epic hat bei vielen alten
Seasons Teile gelöscht, die kann man nicht herunterladen. **Chapter 3 Season 1 (19.10) gehört dazu** – deine
19.10 funktioniert aber weiter.

**Umschauen (es wird nichts heruntergeladen):**

- [ ] **Library** → **Download a version** (Knopf oben, oder die Kachel unter „Add a build“). Die Seite
      „Download a version“ geht auf; in der Seitenleiste bleibt „Library“ hervorgehoben.
- [ ] Oben: Reiter „Chapter 1“ bis „Chapter 5“. Nur „Chapter 2“ hat eine grüne Zahl (5).
- [ ] **Chapter 1:** ein Hinweis „All of Chapter 1 · Not available from Epic.“ mit der Erklärung, und auf jeder
      Karte steht „Not available from Epic“.
- [ ] **Chapter 3:** die Hinweise „Seasons 1 and 2 · Not available from Epic.“ und „Seasons 3 and 4 · Not
      offered yet.“ Auf der Karte „Season 1“ steht „Epic deleted some of its files.“ und in Grün „Your 19.10
      keeps working.“
- [ ] **Chapter 2:** „Season 3“, „Season 5“, „Season 6“, „Season 7“ und „Season 8“ sind „Available“; auf
      „Season 8“ steht „7 builds · from 40.1 GB“.
- [ ] Auf **Season 8** klicken → ein Fenster „Chapter 2 · Season 8“. Oben steht der neueste Build: „18.30“, mit
      „41.1 GB download · 45.4 GB on disk · about 1 h 50 min at 50 Mbit/s“ und „Experimental“. „Download to“ ist
      schon ausgefüllt (z. B. `D:\Niobium\Builds\18.30-CL-17882303`), darunter „Needs about 47.5 GB free on
      that drive.“
- [ ] **Ordner-Prüfungen** (jedes Mal: den Ordner bei „Download to“ eintippen und **Download 18.30** drücken –
      der rote Text erscheint unter dem Feld, nichts startet):
      - ein Ordner mit Dateien drin, z. B. `C:\Users\georg\Downloads` → „This folder already has other files in
        it. Pick an empty folder.“
      - falls du OneDrive nutzt: ein Ordner darin → „This folder is synced by OneDrive. Pick a folder outside
        OneDrive, or it will try to upload about 40 GB.“
      - falls du einen USB-Stick mit FAT32 hast: ein Ordner darauf → „Drive E: can't hold files bigger than 4 GB
        (FAT32). Pick a folder on another drive.“ (mit deinem Laufwerksbuchstaben)
      - ein Laufwerk mit zu wenig Platz → „There isn't enough free space on drive D:. This version needs
        47.5 GB and … GB is free. Free up space or pick another folder.“ (mit deinem Laufwerksbuchstaben)
      Danach **Cancel**.

**Ein echter Download** (nur wenn du Zeit und Platz hast; 18.30 ist eine gute Wahl):

- [ ] 18.30 wählen, den Ordner lassen → **Download 18.30**. Oben erscheint eine Karte mit vier Schritten:
      „Check at Epic“, „Download“, „Check files“, „Add to Library“. Zuerst „Checking that Epic still has every
      file… (about 1 min)“, dann die Prozent, die aktuelle Datei, „Downloaded“, „Speed“, „Time left“ und
      „Files … of 785“. In der Seitenleiste zeigt eine kleine Fortschritts-Pille den Stand, auch auf anderen
      Seiten.
- [ ] **Pause** → „Pausing…“ → „Paused – everything downloaded so far is kept.“ → **Resume** → es geht weiter
      (zuerst kurz wieder „Check at Epic“, dann laufen die Prozent dort weiter, wo sie waren).
- [ ] Niobium schließen, während es lädt → „Close Niobium?“ zeigt „Download (18.30)“ → **Stop & close**. Niobium
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

## Andere Versionen testen (ungetestet, aber startbar)

Niobium startet jede Version von 1.7 bis 30.x. Für alles außer 19.10 gilt: gleiche Schritte wie oben, nur
dass die Build-Karte „Untested“ zeigt und im Log ein Hinweis steht. Wenn es nicht klappt, sind diese drei
Dateien wichtig:

- `%LOCALAPPDATA%\Niobium\logs\redirect.log` – stand die Umleitung? („Ready - …“ oder eine Zeile mit „ERROR:“)
- `%LOCALAPPDATA%\Niobium\logs\client-diagnostics.log` – lief das Ingame-Menü an?
- `<Build>\FortniteGame\Binaries\Win64\stdout.log` und der Ordner `MagnesiumCrashes` daneben – was der Game
  Server sagt.

Bekannte Grenzen: 9.40–10.40 ohne Party/XMPP; „Edit on release“ nur bis 10.40; ab 31.00 noch nicht startbar;
KI-Bots nur auf 19.10 (CL-18675304). Bei Trickshot-Parkours kann es je nach Version andere Objekte geben – fehlt
eins, sagt der Server das in der Konsole (siehe Schritt 7). Einen Build, den du in Schritt 14 heruntergeladen
hast, testest du genauso.

## Was ich brauche, wenn etwas nicht klappt

1. **Welcher Schritt** aus dieser Liste (z. B. „Schritt 3, ‚Logged in‘ kommt nicht“).
2. **Screenshot** vom Launcher (Launch steps + Live Log) und ggf. vom Spiel oder Server-Fenster.
3. **Logs**: Seite **Live Log** → **Copy** (oder die Dateien aus `%LOCALAPPDATA%\Niobium\logs\`; der Knopf
   **Folder** öffnet den Ordner).
4. Bei einem Fortnite-Absturz: Seite **Crash Analysis** → den neuesten Eintrag → **Copy report**.
5. Bei Trickshot-Sachen: die Zeilen aus der Konsole (**F8**), die mit „[Niobium]“ beginnen.
6. Bei Bubble Builds: ein Screenshot deiner Bauten im Spiel und die Zeile „Starting your game: …“.
7. Bei KI-Bots: Live Log → `bots` suchen → **Copy**, dazu was du im Spiel gesehen hast (Schritt 13).
8. Bei Loot: Live Log → `loot` suchen → **Copy**, dazu die `[FloorLoot]`-Zeilen aus `stdout.log` (Schritt 12).
9. Bei einem Download: ein Screenshot der Download-Karte und die Live-Log-Zeilen, die mit „Download of“ anfangen.

Kurz und ehrlich: Ich kann hier kein Fortnite starten. Alles bis zum Ladebildschirm ist aus den
Quell-Projekten (Reboot-Ablauf, LawinServer, Tellurium, Magnesium) 1:1 nachgebaut und gegen deren Verhalten
geprüft – ob es bei dir durchläuft, zeigt erst dieser Test. Das gilt auch für die neuen Teile: Die KI-Bots und
die Korrekturen beim Aufheben und beim Bodenloot wurden hier nur testweise kompiliert, und der Downloader hat in
einem Test nur drei kleine Dateien von Epics Servern geholt – ein ganzer Download, die Bots und der Loot liefen
noch nie in einem echten Spiel.
