# Jarvis in 3 Schritten

Diese Anleitung ist für dich, Georg. Jarvis läuft danach unsichtbar im Hintergrund und ist immer da, wenn du „Hey Jarvis“ sagst. Er klappt auch auf einem ganz leeren PC: Der Installer holt alles, was fehlt, von selbst.

## 1. Installieren (5 Minuten)

Du brauchst: Windows 10 (ab Version 1809) oder Windows 11, Internet und etwa 3 GB freien Platz. Sonst nichts, auch keine Administratorrechte.

![Der Installer bei der Arbeit](docs/bilder/installer.jpg)

1. Diese Datei laden: https://github.com/georghatzmann-bit/vanity-/releases/latest/download/JarvisSetup.exe
   Zeigt GitHub „Page not found“: erst oben rechts bei GitHub anmelden (das Projekt ist privat), dann den Link noch einmal öffnen.
2. Doppelklick auf `JarvisSetup.exe`. Fragt Windows nach („Der Computer wurde durch Windows geschützt“): **Weitere Informationen** > **Trotzdem ausführen**. Das kommt, weil der Installer nicht mit einem gekauften Zertifikat signiert ist.
3. Im dunklen Jarvis-Fenster auf **Installieren** klicken. Die zwei Schalter darunter kannst du so lassen: **Mit Windows starten** ist an, **Symbol auf dem Desktop** ist aus (anschalten, wenn du eins willst).
4. Warten oder nebenbei weiterspielen. Rechts siehst du sechs Schritte mit Häkchen, links läuft ein Bogen um Jarvis' Kern. Der Installer holt alles selbst: Python, die Pakete, die Spracherkennung und Claude Code (Jarvis' Gehirn). Beim ersten Mal dauert das ein paar Minuten, ein Update meist nur eine.
5. Fragt Windows zwischendurch nach Administratorrechten: **Ja** klicken. Das kommt nur, wenn auf dem PC die Microsoft-Laufzeit (Visual C++) fehlt oder zu alt ist.
6. Bei **„Jarvis ist bereit.“** auf **Jarvis starten** klicken.

**Geklappt, wenn:** „Jarvis ist bereit.“ erscheint und sich nach **Jarvis starten** die Einrichtung öffnet.

**Läuft schon ein älteres Jarvis?** Dann steht das im Fenster. Der Installer beendet es kurz und startet es danach von selbst wieder. Deine Einstellungen und das Gedächtnis bleiben erhalten.

**Hat etwas nicht geklappt?** Dann sagt der Installer, was los ist und was hilft, zum Beispiel „Keine Verbindung zum Internet“. Meist reicht **Nochmal versuchen**: Was schon geladen ist, bleibt. **Protokoll öffnen** zeigt alle Details. Das Protokoll kannst du Claude im Jarvis-Projekt schicken.

## 2. Einrichtung durchklicken (2 Minuten)

Die Einrichtung führt dich in sieben kurzen Schritten durch. Jeder Schritt wird sofort gespeichert. Später kommst du wieder hin: Rechtsklick aufs Jarvis-Symbol neben der Uhr > **Einstellungen**, oder das Zahnrad im Jarvis-Fenster.

1. **Mikrofon:** dein Mikrofon anklicken und „Hey Jarvis“ sagen. Es klappt, wenn „Hey Jarvis erkannt“ erscheint.
2. **Stimme:** Unter **Lokal** die Stimmen anhören (▶) und eine anklicken. **Thorsten** ist der Standard: ein deutscher Sprecher, sehr deutlich, bricht nie ab. **George** klingt natürlicher, **Charles** am tiefsten. Stimme und Spracherkennung laufen ganz auf deinem PC, der Installer hat sie schon eingerichtet.
3. **Name und Ort:** dein Vorname (damit Jarvis weiß, mit wem er spricht) und dein Wohnort für das Wetter.
4. **Gehirn:** **Bei Claude anmelden** klicken. Im schwarzen Fenster Enter drücken, bis sich der Browser öffnet (fragt es nach der Anmeldeart: die erste nehmen, „Claude account with subscription“). Im Browser mit deinem Claude-Konto anmelden. Dann das schwarze Fenster schließen und **Nochmal prüfen** klicken. Es klappt, wenn „Claude ist verbunden“ erscheint. Dafür reicht dein Claude-Abo (Pro oder Max).
5. **Extras:** Stumm-Taste, Autostart und **Volle Freigabe** (siehe unten). Einfach so lassen, wie es ist.
6. **Jarvis starten.**

### Stimme und Spracherkennung: ganz auf deinem PC

Jarvis spricht mit seiner eigenen deutschen Stimme (Thorsten, oder eine Pocket-TTS-Stimme wie George) und versteht dich mit Parakeet. Zahlen, Uhrzeiten, Daten, Kürzel wie „z. B.“ und englische Wörter wie „Mails“ oder „Update“ liest er so, wie man sie sagt. Beides läuft auf deinem Prozessor: kein Abo, kein Schlüssel, nichts geht ins Internet, und eine Windows- oder Microsoft-Stimme gibt es nicht mehr. Der Installer lädt beides gleich mit (etwa 1,3 GB).

**Beste Stimme auf schnellen PCs:** Jarvis misst einmal, ob dein Prozessor das große deutsche Stimmmodell flüssig schafft (es ist deutlich klarer, braucht aber doppelt so viel Rechenzeit und 640 MB mehr). Wenn ja, nimmt er es von selbst und sagt: „Ich spreche jetzt mit meiner besten Stimme.“ Gemessen wird nur, wenn am PC wenig los ist, nie neben einem Spiel. Immer das große: in `config.toml` bei `[tts]` `lokal_qualitaet = "beste"`, immer das kleine: `"schnell"`.

**Geklappt, wenn:** in der Einrichtung bei **Stimme** > **Lokal** oben „Aktiv“ steht. Steht dort **Lokal einrichten**, ging das Laden bei der Installation nicht (meist kein Internet): einmal klicken, oder einfach warten, Jarvis holt es beim Start im Hintergrund nach und sagt Bescheid.

Optional: **„Jarvis“ allein** geht auch ohne Schlüssel: Klingt etwas halb nach seinem Namen, prüft Jarvis kurz mit der Spracherkennung, ob „Jarvis“ vorn steht. Ganz zuverlässig wird es mit Picovoice: in der Einrichtung bei Mikrofon auf **Picovoice öffnen** klicken, gratis Konto anlegen, den **AccessKey** einfügen und **Prüfen** klicken. Abschalten: in den Einstellungen beim Mikrofon den Schalter **Auch „Jarvis“ allein** ausschalten.

### Premium-Stimme (ElevenLabs, freiwillig)

Wer mag, nimmt statt der lokalen Stimme eine von ElevenLabs. Die braucht Internet. Ist das Guthaben leer oder das Internet weg, spricht Jarvis mit seiner lokalen Stimme weiter.

1. https://elevenlabs.io öffnen und ein Konto anlegen.
2. https://elevenlabs.io/app/settings/api-keys öffnen > **Create API Key** > Namen eingeben > ohne Einschränkungen erstellen.
3. Den Schlüssel (beginnt mit `sk_`) kopieren.

**Welche Stimmen gehen gratis?** Das Gratis-Konto hat 10.000 Credits im Monat, das sind etwa 150 bis 300 kurze Antworten. Fertige Stimmen gibt ElevenLabs damit aber meist nicht an Programme wie Jarvis heraus. Kostenlos geht immer eine Stimme, die du **selbst entwirfst**:

1. Auf elevenlabs.io links **Voices** > **My Voices** > **Add a new voice** > **Voice Design**.
2. Als Beschreibung einfügen (die Einrichtung hat dafür einen Kopieren-Knopf):
   `Perfect audio quality. Middle-aged British man, calm, deep and warm voice, refined and polite like a loyal butler, dry wit, measured pace, speaks fluent German with a slight British accent.`
3. Als Text einfügen:
   `Guten Abend, Sir. Ich habe alle Systeme überprüft, es läuft alles einwandfrei. Ihr Kaffee ist in fünf Minuten fertig, und das Wetter bleibt bis morgen freundlich.`
4. **Generate** klicken, die drei Vorschläge anhören und den besten speichern, zum Beispiel als „Jarvis“.

Fertige Stimmen aus der Bibliothek (zum Beispiel Lennard) gehen ab dem Abo **Starter** (etwa 6 $ im Monat).

Die lokale Stimme rechnet auf dem Prozessor und nimmt höchstens die Hälfte der Kerne, damit Spiele flüssig bleiben. Beim Start rechnet Jarvis einmal einen Probesatz: Auf schnellen PCs setzt die Stimme dann noch früher ein.

## 3. Handy und Alexa verbinden (freiwillig)

Im Jarvis-Fenster oben auf **Verbinden** klicken. Dort gibt es die Bereiche Handy, Alexa und Konnektoren. Discord brauchst du nicht zu verbinden: Jarvis bedient einfach die Discord-App auf deinem PC.

### Handy

1. Bereich **Handy**: den Schalter einschalten. Fragt Windows nach der Firewall: **Zulassen**.
2. Mit der Handy-Kamera den QR-Code scannen und den Link öffnen.
3. Im Browser-Menü **Zum Startbildschirm hinzufügen** (iPhone: Teilen-Knopf). Jetzt ist Jarvis eine App auf deinem Handy.

**Geklappt, wenn:** oben in der App „Bereit“ steht. Du kannst schreiben, mit dem Mikrofon der Handy-Tastatur diktieren, Schnellaktionen (auch deine eigenen Befehle) antippen und die Werkstatt verfolgen. Das Handy muss im selben WLAN sein.

**Jarvis' Stimme auf dem Handy:** Oben rechts in der App steht, wo Jarvis antwortet. Tippen wechselt zwischen **Handy** (Jarvis spricht auf dem Handy, in derselben Stimme wie am PC), **PC** und **Still**.

**Sicher von überall, mit Sprechtaste:** Mit **Tailscale** (kostenlos) geht die App auch unterwegs, über eine verschlüsselte Adresse. Dann funktioniert auch die **Sprechtaste** in der App (antippen, sprechen, nochmal tippen), und die App lässt sich richtig installieren.

1. Tailscale auf dem PC installieren (oder sag „Jarvis, installiere Tailscale“) und einmal anmelden (Symbol unten rechts neben der Uhr).
2. Auf dem Handy die App **Tailscale** installieren und mit demselben Konto anmelden.
3. Im Bereich **Handy** bei **Sicher von überall** auf **Einschalten** klicken. Kommt der Knopf **HTTPS erlauben**: anklicken, im Browser bestätigen, dann nochmal **Einschalten**.
4. Den QR-Code neu scannen. Die Adresse beginnt jetzt mit `https://`.

**Benachrichtigungen aufs Handy** (Erinnerungen, „Aus der Werkstatt: fertig“), wenn du nicht am PC sitzt:

1. Im selben Bereich **Benachrichtigungen** einschalten.
2. Auf dem Handy die kostenlose App **ntfy** installieren.
3. In der App auf **+** tippen und den Kanalnamen eintragen, den Jarvis anzeigt (beginnt mit `jarvis-`).
4. In Jarvis auf **Test schicken** klicken. Auf dem Handy erscheint sofort eine Nachricht.

### Termine, Mails und Shop: deine Konnektoren

Dafür brauchst du in Jarvis nichts einzurichten. Jarvis denkt mit Claude, und Claude benutzt die Dienste, die du auf claude.ai verbunden hast: **Gmail**, **Google Kalender**, **Shopify**, **Spotify**, **Canva** und mehr. Ohne Passwörter in Jarvis.

1. Auf claude.ai unter **Einstellungen** > **Konnektoren** die Dienste verbinden, die Jarvis nutzen soll (im Jarvis-Fenster: **Verbinden** > **Konnektoren** > **Öffnen**).
2. Fertig. Frag zum Beispiel „Was steht heute an?“ oder „Hab ich neue Mails?“.

**Geklappt, wenn:** unter **Verbinden** > **Konnektoren** nach **Neu prüfen** deine Dienste mit „verbunden“ stehen. Steht dort nichts, einmal in der Eingabeaufforderung `claude` starten und `/login` eingeben (dann darf Claude Code deine Konnektoren sehen).

Löschen, Kaufen, Bezahlen und Veröffentlichen lässt Jarvis über Konnektoren nicht zu, auch wenn er dich falsch verstanden hat. Das machst du selbst in der App. Eine Mail in deinem Namen schickt er erst nach deinem „Ja“.

### Alexa

„Alexa, sag Jarvis, er soll Discord öffnen.“ Dafür legst du einmal deinen eigenen Alexa-Skill an. Der gehört nur dir. Home Assistant brauchst du dafür nicht.

1. Bereich **Alexa**: den Schalter einschalten.
2. **Öffnen** klicken und mit dem Amazon-Konto anmelden, mit dem dein Echo läuft.
3. **Skill erstellen**: Name „Jarvis“, Sprache Deutsch, Modell „Benutzerdefiniert“, Hosting „Von Alexa gehostet (Python)“, Vorlage „Von Grund auf neu“.
4. In Jarvis bei „Sprachmodell“ **Kopieren** klicken. In der Konsole links **Interaktionsmodell** > **JSON-Editor**: alles ersetzen, **Modell speichern**, **Modell erstellen**.
5. In Jarvis bei „Code“ **Kopieren** klicken. In der Konsole oben **Code**, Datei `lambda_function.py`: alles ersetzen, **Speichern**, **Bereitstellen**.
6. In der Konsole oben **Test**: „Entwicklung“ wählen.

**Geklappt, wenn:** „Alexa, sag Jarvis, er soll Spotify öffnen“ Spotify am PC öffnet. Dauert etwas länger als sechs Sekunden, sagt Alexa „Ich kümmere mich darum“, und Jarvis macht trotzdem weiter. Fragt Jarvis zurück („Gute Nacht, Sir. Soll ich den PC herunterfahren?“), hört Alexa weiter zu: einfach „Ja“ sagen.

### PC per Handy einschalten (Wake-on-LAN)

1. Bereich **Handy**: auf **PC fürs Einschalten per Netzwerk vorbereiten** klicken und bei Windows **Ja** sagen.
2. Auf dem Handy eine App wie **„Wake On Lan“** installieren und die MAC-Adresse und IP-Adresse eintragen, die Jarvis dort anzeigt.

Das geht nur, wenn der PC per Kabel am Router hängt und ausgeschaltet (nicht stromlos) ist. Bei manchen PCs muss „Wake on LAN“ zusätzlich im BIOS eingeschaltet werden.

## So benutzt du Jarvis

![Das Jarvis-Fenster](docs/bilder/hauptfenster.jpg)

- **„Hey Jarvis“** sagen (englisch ausgesprochen), kurz warten, Befehl auf Deutsch sprechen. **„Okay Jarvis“**, **„Hallo Jarvis“** und **„Jarvis“** allein gehen auch (am schnellsten mit „Jarvis, wie spät ist es?“ in einem Satz). Mit Picovoice-Schlüssel klappt „Jarvis“ allein ganz zuverlässig.
- **Gespräch:** Nach jeder Antwort hört Jarvis 8 Sekunden weiter zu (leiser Ton, ein gestrichelter Ring um die Kugel). Einfach weiterreden, ohne „Hey Jarvis“: „Und morgen?“ Schluss ist, wenn du nichts mehr sagst, oder mit **„Danke“**, **„Alles klar“** oder **„Tschüss“**. Beim Zocken (Gaming-Modus oder Vollbild) gibt es kein Gespräch, da redest du ja meist mit anderen. Abschalten: in den Einstellungen beim Mikrofon den Schalter **Gespräch ohne Weckwort** ausschalten.
- Oder **Strg + Alt + J** drücken: Jarvis hört sofort zu.
- Beim Weckwort erscheint **das Jarvis-Fenster** ganz vorn, ohne dir die Tastatur wegzunehmen. 6 Sekunden nach dem Gespräch verschwindet es wieder. Beim Spielen (Vollbild, Gaming-Modus) bleibt es weg.
- **Das Fenster:** In der Mitte Jarvis' Kugel: eine ruhige Kugel aus feinen Linien, die sich langsam dreht. Hört er zu oder spricht er, laufen Wellen durch die Linien. Beim Nachdenken zieht ein heller Streifen hindurch, ohne Mikrofon wird sie grau. Jede Aktion hat ihre eigene Bewegung: Beim Suchen kreist ein Radar-Strich, beim Öffnen läuft ein Ring nach außen, beim Installieren fließen Bänder nach unten, eine Nachricht umkreist die Kugel als Lichtpunkt, Musik lässt die Ringe im Takt springen, Timer und Termine zeigen einen Uhrzeiger, die Werkstatt blendet ein Bau-Gitter ein, Hinweise klopfen zweimal an, auf „Danke“ nickt sie. Die Kugel lässt sich anfassen: Sie neigt und wölbt sich zur Maus, mit gedrückter Maustaste drehst du sie. Ein Klick, und er hört sofort zu. Darunter das Gespräch und das Eingabefeld. Oben: **Gaming**-Schalter, **Werkstatt**, **Blueprint**, **Verbinden** (Handy, Alexa, Discord, Konnektoren), **Verlauf** und die Einstellungen. Rechts: was **heute** ansteht (Erinnerungen, Wecker, Timer), wie ausgelastet der PC ist, und das **Gedächtnis**.
- **Minimieren oder Schließen** lässt Jarvis ganz verschwinden. Er hört trotzdem weiter zu. Beenden: Rechtsklick aufs Symbol neben der Uhr > Jarvis beenden.
- Unter der Antwort steht, **was Jarvis gerade tut** („Installiert Spotify“), mit einem Haken, wenn es fertig ist.
- **Strg + Alt + M** schaltet das Mikrofon stumm und wieder an.
- **„Stopp“** oder der Stopp-Knopf unterbricht Jarvis sofort, auch ein angekündigtes Herunterfahren.

## Was du sagen kannst

**Sofort, ohne Wartezeit** (meist unter einer Sekunde):

- „Was kannst du?“ (eine kurze Übersicht zum Einstieg)
- „Öffne Spotify“, „Starte Discord“, „Mach Steam zu“, „Öffne YouTube“, „Öffne den Ordner Downloads“
- „Geh auf Reddit“, „Such auf YouTube nach Katzenvideos“, „Google mal Pizza in der Nähe“, „Navigiere nach Graz“
- „Spiel Thunderstruck“ (das erste YouTube-Video läuft sofort), „Spiel Queen auf Spotify“
- „Dunkelmodus an“, „Bluetooth aus“, „WLAN an“, „Öffne die Bluetooth-Einstellungen“
- „Wie wird das Wetter morgen?“, „Was ist 15 mal 23?“, „Wie spät ist es?“
- „Lauter“, „Lautstärke 30“, „Mach Musik an“, „Nächstes Lied“, „Pausiere“
- „Minimiere alles“, „Mach einen Screenshot“ (landet unter Bilder > Screenshots), „Wie viel Speicher ist frei?“
- „Weck mich um 7“ (Jarvis sagt es an, und mit Benachrichtigungen kommt es auch aufs Handy)
- „Installier mir Spotify“ (Jarvis meldet sich, wenn es fertig ist)
- „Gaming-Modus an“, „Sperr den PC“, „Zeig dich“, „Versteck dich“
- „Erinnere mich in 20 Minuten an den Tee“, „Stell einen Timer auf 10 Minuten“
- Mehrere auf einmal: „Öffne Spotify und Discord“

**Spiele** (Steam und Epic Games, in etwa einer Sekunde, ohne Claude):

- „Installiere CS2“, „Lad mal schnell Palworld herunter“: Der Steam-Dialog geht sofort auf. Hast du nur ein Steam-Laufwerk, bestätigt Jarvis ihn selbst. Bei mehreren sagt er dir, wo am meisten Platz ist, und du wählst im Dialog. Sobald der Download läuft, sagt er, auf welchem Laufwerk. Gibt es das Spiel nicht eindeutig bei Steam (zum Beispiel Minecraft), kümmert sich Claude darum, das dauert dann ein paar Sekunden länger.
- „Starte CS2“, „Starte Lethal Company“, „Starte Fortnite“ (auch Abkürzungen wie CS2, GTA 5, R6, BG3, Repo)
- „Welche Spiele brauchen Updates?“: Jarvis sieht alle Steam-Bibliotheken durch und zählt auf, was ein Update braucht. „Ja“ öffnet die Steam-Downloads. Epic-Spiele aktualisiert der Epic-Launcher selbst.
- „Welche Spiele habe ich?“, „Deinstalliere Rust“ (Steam fragt selbst noch einmal nach)

**Discord und Chats** (ohne Maus, in ein, zwei Sekunden):

- „Schreib Max auf Discord, bin gleich da“, „Schick Anna über WhatsApp: Ich komme später“ (auch Telegram)
- „Sag Max, dass ich später anrufe“: Jarvis nimmt die App, über die du Max sonst schreibst, und schickt „Ich rufe später an“.
- „Schreib in den Kanal allgemein: bin gleich da“
- „Geh in den Sprachkanal Zocken“, „Öffne den Discord-Server Gilde“, „Geh in den Kanal memes“
- „Ruf Max an“ (über Discord), „Discord stumm“, „Discord taub“

**PC** (mit 15 Sekunden Vorlauf, „Stopp“ oder „Abbrechen“ hält es auf):

- „Fahr den PC herunter“, „Starte den PC neu“, „Energiesparmodus“, „Melde mich ab“
- „Gute Nacht“: Jarvis fragt, ob er den PC herunterfahren soll. „Ja“ genügt.

**Gedächtnis:**

- „Merk dir, dass ich gern Pizza esse“, „Merk dir: Max hat am 3. Mai Geburtstag“
- „Was weißt du über mich?“, „Vergiss das mit der Pizza“

**Eigene Befehle und Zeitpläne:**

- „Wenn ich Zockmodus sage, öffne Discord und Steam und mach den Gaming-Modus an“, danach reicht **„Zockmodus“**
- „Welche Befehle kennst du?“, „Lösch den Befehl Zockmodus“
- „Jeden Morgen um 8 Uhr: Briefing“, „Werktags um 18 Uhr öffne Discord“, „Freitags um 20 Uhr: Zockmodus“
- „Welche Zeitpläne habe ich?“, „Lösch den Zeitplan Briefing“

**Termine, Mails und Shop** (über deine Konnektoren, siehe oben):

- „Was steht heute an?“, „Trag morgen um 18 Uhr Training ein“, „Wann ist mein nächster Termin?“
- „Hab ich neue Mails?“, „Was schreibt Max?“, „Fass meine Mails von heute zusammen“
- „Wie läuft der Shop?“, „Gibt es neue Bestellungen?“

**Notizbuch:**

- „Notiere: Milch kaufen“, „Schreib in mein Notizbuch, dass ich Max anrufen muss“
- „Öffne mein Notizbuch“, „Was haben wir gestern gemacht?“, „Recherchiere die besten Gaming-Mäuse“ (der Bericht landet im Notizbuch)

**Licht** (wenn Home Assistant eingerichtet ist, siehe ganz unten):

- „Mach das Licht im Wohnzimmer an“, „Dimm das Licht auf 30 Prozent“, „Licht aus“

**Mit Nachdenken** (ein paar Sekunden):

- „Was gibt es Neues?“, „Wann spielt Rapid heute?“, „Guten Morgen“
- „Was steht gerade auf meinem Bildschirm?“ (Jarvis liest den Text in etwa einer Sekunde)
- „Schreib Max auf Discord, dass ich später komme, und entschuldige dich“ (Jarvis formuliert selbst)

## Volle Freigabe

Jarvis macht alles, ohne nachzufragen: Programme installieren und deinstallieren, Dinge in den Papierkorb legen, Befehle mit Administratorrechten, Herunterfahren und Neustarten. Braucht etwas Administratorrechte, zeigt Windows die übliche Abfrage: einmal **Ja** klicken.

Nur zwei Dinge fragt er immer: bevor er **etwas kauft** und bevor er **in deinem Namen schreibt**, was du nicht selbst gesagt hast. Endgültig löschen (statt Papierkorb) und Laufwerke formatieren macht er nie.

Lieber vorher gefragt werden? Einstellungen > Extras > **Volle Freigabe** ausschalten.

## Gedächtnis: Jarvis lernt dich kennen

![Das Gedächtnis](docs/bilder/gedaechtnis.jpg)

- Was du sagst („Merk dir, …“), behält Jarvis für immer.
- Er merkt sich, mit wem du über welche App schreibst. „Sag Max …“ nimmt dann die richtige App.
- Er sieht, was du ungefähr zur selben Zeit öffnest und in welchen Discord-Sprachkanal du gehst. Nach ein paar Tagen sagt er es zur passenden Zeit nebenbei, am Ende einer normalen Antwort: **„Es ist 18 Uhr, Sir. Übrigens: Um diese Zeit öffnen Sie meist Discord und gehen in den Sprachkanal Zocken. Soll ich?“** Antworte einfach mit **„Ja“**, **„Nein“** oder **„Nie wieder“** (ohne „Hey Jarvis“). Es gibt kein Fenster dafür. Beim Zocken fragt er nie.
- **Festplatte fast voll:** Sind auf einem Laufwerk weniger als 10 Gigabyte frei, erwähnt Jarvis es tagsüber in einer Antwort (höchstens alle drei Tage) und schaut auf „Ja“ nach, was am meisten Platz braucht.
- **Geburtstage:** Sag „Merk dir, Max hat am 3. Mai Geburtstag“. Am 3. Mai sagt Jarvis bei der nächsten Antwort: „Übrigens, Sir: Heute hat Max Geburtstag. Soll ich Max auf Discord gratulieren?“ Ein „Ja“, und die Glückwünsche sind raus. Sprichst du den ganzen Tag nicht mit ihm, sagt er es abends von selbst.
- Jede Nacht schaut er kurz auf die Gespräche vom Vortag und merkt sich, was wichtig war. Auch was du vorhattest: Sagst du nebenbei „Ich muss morgen noch zur Post“, erinnert er dich am nächsten Morgen im Überblick daran („Sie wollten heute: zur Post gehen.“), sonst am Nachmittag.
- Alles bleibt auf deinem PC. Im Fenster rechts bei **Gedächtnis** > **Ansehen** siehst du alles und kannst mit × einzelne Sachen löschen.

## Notizbuch und Fähigkeiten

**Notizbuch:** Jarvis schreibt jedes Gespräch mit Datum in einen Ordner (`%USERPROFILE%\Jarvis-Notizbuch`): ein Tagebuch pro Tag, eine Seite pro Person (mit Geburtstag und allem, was er über sie weiß), Berichte von Recherchen und deine Notizen. Mit dem kostenlosen Programm **Obsidian** („Ordner als Tresor öffnen“) siehst du alles verlinkt. Eigene Notizen in den Seiten bleiben erhalten. Passwörter schreibt er nie hinein.

**Fähigkeiten:** Für wiederkehrende Aufgaben hat Jarvis genaue Anleitungen, die er nur liest, wenn er sie braucht: Morgen-Briefing, Recherche mit Bericht, PC aufräumen und aktualisieren, Spiele starten (auch Steam und Epic), Smart Home, Bildschirm lesen. Zeigst du ihm etwas Neues und sagst **„Lern das“**, schreibt er sich selbst eine neue Fähigkeit. Alle stehen unter **Gedächtnis** > **Ansehen**.

## Gehirn: Jarvis wählt das passende Modell

Für jede Aufgabe entscheidet Jarvis selbst, wie viel Denkleistung sie braucht:

- **Kurze Fragen und einfache Befehle:** Sonnet mit wenig Nachdenken. Die Antwort kommt schnell.
- **Texte, Recherche, Erklärungen:** Sonnet mit mittlerem Nachdenken.
- **Knifflige Sachen** (Fehlersuche am PC, Code, Analysen, Planung, Geld und Verträge): Opus mit viel Nachdenken.
- **Maximal** nur, wenn du es sagst: „Denk richtig gründlich nach“ oder „Nimm dein stärkstes Modell“.

Du kannst jederzeit mitreden: „kurz und knapp“, „denk gründlich nach“, „mit Opus“. Sagst du „Das stimmt nicht“, denkt er beim nächsten Mal gründlicher. Im Verlauf steht bei jeder Antwort, womit er gedacht hat, zum Beispiel „Opus · gründlich“. Fehlt ein Modell in deinem Abo oder ist das Kontingent dafür aufgebraucht, nimmt Jarvis von selbst das nächstkleinere.

Lieber immer gleich? Einstellungen > **Gehirn** > **Modellwahl**: Automatisch (empfohlen), Immer schnell oder Immer gründlich.

## Jarvis meldet sich von selbst

Jarvis wartet nicht nur auf Befehle. Wie ein guter Butler sagt er Bescheid, wenn etwas seltsam ist oder du etwas zu vergessen drohst:

- **Am PC:** Ein Programm reagiert nicht mehr („Discord reagiert seit einer halben Minute nicht mehr. Soll ich es neu starten?“). Ein Programm im Hintergrund frisst minutenlang den Prozessor. Der Arbeitsspeicher ist voll, der Akku fast leer, die Grafikkarte sehr heiß, das Internet weg (und wieder da).
- **Sicherheit:** Ein neues Programm startet mit Windows. Auf „Ja“ schaut Jarvis nach, ob es harmlos ist. Und wenn Windows seit Tagen auf einen Neustart für Updates wartet.
- **Morgens:** Ein kurzer Überblick über den Tag (Wetter, Erinnerungen, Geburtstage und was du vorhattest). Termine und Mails sagt er dir, wenn du „Was steht heute an?“ fragst.
- **Zurück am PC:** „Willkommen zurück, Sir. Während Sie weg waren: …“ mit allem, was du verpasst hast. Wer mit Jarvis redet, tippt oder mit dem Controller zockt, gilt als da: Was du schon gehört hast, wiederholt er nicht.
- **Pause:** Nach drei Stunden am Stück schlägt er fünf Minuten Pause vor.

Die Regeln: Jarvis spricht nur, wenn du am PC sitzt, nie beim Zocken oder im Vollbild, nie mitten in ein Gespräch, und zwischen zwei Hinweisen bleiben ein paar Minuten Ruhe. Denselben Satz sagt er höchstens alle drei Stunden. Sagst du **„Weiß ich schon“** oder **„Das hast du schon gesagt“**, kommt diese Art Hinweis heute nicht mehr. Dringendes (Akku fast leer) kommt sonst aufs Handy. Antworte mit **„Ja“**, **„Nein“** oder **„Nie wieder“**, ohne „Hey Jarvis“. „Nie wieder“ stellt diese Art Hinweis für immer ab. Sagst du **„Hinweise aus“**, meldet er sich nur noch bei Dringendem, **„Hinweise an“** schaltet alles wieder ein (auch was du mit „Nie wieder“ abgestellt hast). Im Verlauf stehen Hinweise mit „Hinweis“ hinter der Uhrzeit. Ganze Bereiche schaltest du in der `config.toml` unter `[hinweise]` ab, zum Beispiel `pausen = false`.

## Die Werkstatt: Jarvis programmiert für dich

![Die Werkstatt-Projekte](docs/bilder/projekte.jpg)

Sag zum Beispiel **„Bau mir einen Discord-Bot, der jeden Morgen Hallo sagt“**, **„Programmier mir ein kleines Spiel“** oder **„Schreib mir ein Python-Skript, das meine Downloads sortiert“**.

1. Jarvis sagt „Ich gehe in die Werkstatt“ und das Fenster zeigt den Auftrag als Blaupause: links den Plan, in der Mitte jeden Schritt mit Dauer, rechts das Projekt als Hologramm und die Dateien. Das Hologramm baut sich mit der Arbeit von unten nach oben auf, zuerst als Drahtmodell, das zum Auftrag passt (Roboter für einen Bot, Controller für ein Spiel, Globus für eine Webseite …). Gleich nach dem Plan zeichnet Jarvis ein eigenes Logo für das Projekt (`logo.svg` im Projektordner), ab dann baut sich dieses Logo als Hologramm auf. Ist alles fertig, leuchtet es grün.
2. Jarvis arbeitet im Hintergrund, und du kannst dabei mit ihm reden:
   - **„Wie weit bist du?“** nennt den aktuellen Schritt.
   - **Wünsche gehen direkt in die laufende Arbeit:** „Mach den Hintergrund blau“, „Nimm lieber Python“, „Füg noch einen Highscore hinzu“. Jarvis sagt „Ich baue das gleich mit ein“, im Ablauf steht dann „Ihr Wunsch: …“.
   - **Fragen zur Arbeit** („Welche Sprache nimmst du?“, „Was hast du schon fertig?“) beantwortet er mit Blick auf seinen Plan.
3. Ist er fertig, sagt er es dir und fragt: „Soll ich es gleich starten?“ Ein **„Ja“** genügt. **Ordner öffnen** zeigt das Projekt.

- **Große Aufträge** (Spiele, Apps mit Login, Shops) baut Jarvis mit Opus und viel Nachdenken, kleine mit Sonnet. Sagst du „beste Qualität“, denkt er noch gründlicher.
- **Alle Projekte auf einen Blick:** oben im Fenster **Werkstatt**, oder „Zeig mir meine Projekte“. Jede Karte zeigt das Logo des Projekts, den Stand, **Ansehen**, **Starten**, **Vorschau** (bei Webseiten) und **Weiterbauen**.
- **Ein Projekt ansehen:** **Ansehen** (oder ein Klick auf den Namen) oder „Zeig mir das Projekt Würfelspiel“. Die Werkstatt zeigt dann Plan, Ablauf, alle Dateien im Ordner, das Logo-Hologramm und die bisherigen Aufträge. Unten im Feld **Weiterbauen** schreibst du, was noch dazu soll.
- **Mitten in der Arbeit ändern:** unten in der Werkstatt ins Feld **Ändern** schreiben („Mach den Hintergrund blau“) und **Einbauen**, oder einfach sagen. Es geht sofort in die laufende Arbeit.
- **Projekt löschen:** auf der Karte das **×** zweimal klicken, in der Projektansicht **Löschen** zweimal, oder „Lösch das Projekt Würfelspiel“ (Jarvis fragt nach, „Ja“ löscht). Der Ordner kommt in den Papierkorb, von dort holst du ihn zurück. Woran die Werkstatt gerade arbeitet, wird nicht gelöscht.
- **Weiter am selben Projekt:** „Arbeite am Discord-Bot weiter: füg einen Befehl hinzu“. Jarvis weiß noch, was er gebaut hat.
- „Starte das Projekt Würfelspiel“, „Öffne den Ordner vom Discord-Bot“
- Jedes Projekt hat einen eigenen Ordner unter `%USERPROFILE%\Jarvis-Werkstatt`.
- **Tests stören dich nicht:** Die Werkstatt testet auf einem eigenen, unsichtbaren Windows-Arbeitsplatz. Fenster von Spielen und Programmen, die sie zum Ausprobieren startet, poppen nicht auf deinem Bildschirm auf, auch nicht beim Zocken. Erst „Starte es“ zeigt dir das Ergebnis. (Abschalten: `unsichtbar = false` unter `[werkstatt]`.)
- **Mit deinen Konnektoren:** Die Werkstatt darf deine claude.ai-Konnektoren benutzen, zum Beispiel Canva für ein Logo.
- **Stopp** (zweimal klicken) oder **„Brich die Werkstatt ab“** beendet die Arbeit. Was schon gebaut ist, bleibt.

## Der Blueprint: 3D-Modelle wie bei Tony Stark

![Der Blueprint](docs/bilder/blaupause.jpg)

Sag **„Blueprint“** (oder oben im Fenster **Blueprint**), dann **„Generiere einen Iron-Man-Helm“**, **„Bau mir eine Drohne“** oder **„Konstruiere ein Raumschiff“**. Jarvis zeichnet das Modell Teil für Teil als leuchtendes Hologramm über einem Projektor, jedes Teil baut sich mit einem Laser von unten nach oben auf. Dazu Maßlinien in echten Größen.

**Einfach weiterreden:** Solange der Blueprint offen ist, brauchst du kein „Hey Jarvis“. Jarvis antwortet kurz („Sofort, Sir.“, danach „Erledigt, Sir.“) und hört gleich wieder zu, auch wenn du dir das Modell eine Weile ansiehst (bis anderthalb Minuten Pause). Sagst du etwas, während er noch baut, merkt er es sich und macht es direkt danach. Unten im Blueprint steht, ob er gerade zuhört.

- **Ansehen:** Ziehen dreht, das Mausrad zoomt, rechte Maustaste verschiebt, Doppelklick holt ein Teil heran. Auf dem Touchscreen: ein Finger dreht, zwei zoomen.
- **Sofort per Sprache:** „Dreh es um 90 Grad“, „Lass es drehen“, „Zoom rein“, „Von oben“, „Explosionsansicht“ (alle Baugruppen auseinander, mit Namen), „Bau es wieder zusammen“, „Zeig mir das Triebwerk genauer“, „Nur den Rumpf“, „Zeig alles“, „Mach das größer“, „Mach die Flügel doppelt so groß“, „Mach die Flügel rot“, „Entferne die Antenne“, „Rückgängig“, „Drahtmodell“, „Hologramm“, „Echte Farben“.
- **Umbauen mit Jarvis:** „Füg noch zwei Raketen an die Flügel“, „Mach den Rumpf schlanker“, „Setz ein Cockpit drauf“. Hast du ein Teil angeklickt, meint „das“ dieses Teil.
- **Darstellung:** **Holo** (leuchtendes Hologramm, Standard), **Echt** (Farben und Material, mit Spiegelungen), **Papier** (weiße Zeichnung auf Blaupausen-Papier).
- **Speichern und 3D-Druck:** „Speicher das als Drohne“, „Lade den Blueprint Drohne“, „Zeig mir meine Blueprints“. **STL** oder „Exportier als STL“ legt eine Datei für den 3D-Drucker in `Jarvis-Werkstatt\Blaupausen` (in Millimetern, steht auf dem Boden).
- **Foto mit Blender:** **„Render das“** (oder „Mach ein Foto davon“, oben **Foto**) baut das Modell in Blender nach, mit echten Materialien (Metall, Lack, Glas, Leuchten), Fotostudio, Licht von vier Seiten und Kamera, und zeigt das fertige Bild im Blueprint. Mit Grafikkarte dauert das ein paar Sekunden, nur mit Prozessor bis zu zwei Minuten; du kannst derweil weiterbauen. Die Fotos (PNG) liegen in `Jarvis-Werkstatt\Blaupausen\Fotos`.
- **In Blender weiterbauen:** **„Öffne das in Blender“** (oben **Blender**) legt eine .blend-Datei mit Modell, Licht und Kamera an (`Blaupausen\Blender`, jedes Mal eine neue, nichts wird überschrieben) und öffnet Blender. Dort drückst du F12 für dasselbe Foto.
- **Blender fehlt?** Dann installiert Jarvis es beim ersten Mal selbst (kostenlos, ein paar Minuten, Windows fragt dabei vielleicht nach deiner Erlaubnis). Liegt Blender an einem ungewöhnlichen Ort, trag den Pfad in `config.toml` unter `[blaupause] blender_pfad` ein.
- **Stopp** hält eine laufende Konstruktion an, auch ein Foto in Blender. Gezeichnet wird mit Sonnet (`[blaupause] modell = "opus"` für aufwendigere Modelle).

![Foto aus Blender im Blueprint](docs/bilder/blueprint-foto.jpg)

## Die Weltlage: Gottes Auge

![Die Weltlage](docs/bilder/weltlage.jpg)

Sag **„Zeig mir, was in der Welt passiert“** (oder oben im Fenster **Weltlage**). Eine Satelliten-Erde geht auf, Jarvis holt die neuesten Meldungen der Tagesschau, fliegt zu jedem Ort und liest die Meldung vor. Rechts stehen alle Meldungen mit Foto (antippen: hinfliegen und vorlesen), darunter DAX, S&P 500 und Bitcoin. Die Meldung, die Jarvis gerade vorliest, klappt auf: großes Foto, erster Satz, Bildquelle. Am Ziel auf der Erde steht das Foto klein dabei. Hat eine Meldung kein Foto, zeigt Jarvis ein Satellitenbild vom Ort.

- **Lageberichte:** „Was passiert in Deutschland?“, „Wirtschaftsnachrichten“, „Lagebericht“. Während des Berichts: **„Weiter“**, **„Zurück“**, **„Stopp“**. Fragst du zwischendurch etwas anderes, hört der Bericht auf.
- **Hinfliegen:** „Flieg nach Tokio“, „Zeig mir Paris“, „Zoom rein“, „Weiter weg“, oder unten ins Suchfeld tippen. **„Wo ist die ISS gerade?“** fliegt zur Raumstation, live.
- **Hologramm:** **„Zeig die Erde als Hologramm“** (oder unten **Hologramm**, Taste **H**). Die Kontinente leuchten als Lichtpunkte, über den Orten der Meldungen stehen Lichtsäulen, von weit oben schwebt die Erde über einem Projektor. Aus der Nähe wird das Gelände zum Hologramm. **„Satellitenbild“** oder **„Hologramm aus“** schaltet zurück. Jarvis merkt sich, was du zuletzt hattest.
- **Flugverkehr:** „Flugverkehr an“ zeigt die Flugzeuge, die gerade in der Luft sind (ab Landesgröße, live über OpenSky).
- **Börse:** „Wie steht der DAX?“ sagt die Kurse an.
- **Maus:** ziehen verschiebt, Mausrad zoomt, rechte Maustaste dreht und kippt, Doppelklick fliegt hin. **Esc** oder **„Zurück zum Hauptmenü“** schließt.

Die grobe Erde ist in Jarvis eingebaut. Die scharfen Satellitenbilder (Sentinel-2) lädt das Fenster beim Heranzoomen aus dem Internet.

### Handsteuerung: wie Tony Stark

Sag **„Starte die Handsteuerung“** (oder unten **Handsteuerung**). Unten links erscheint ein kleines Kamerabild, die Webcam erkennt deine Hände.

1. **Greifen:** Daumen und Zeigefinger zusammen, dann die Hand bewegen. Die Erde verschiebt sich, im Blueprint dreht sich das Modell.
2. **Zoomen:** mit beiden Händen greifen und auseinanderziehen (näher) oder zusammenführen (weiter weg).
3. **Drehen:** mit beiden Händen greifen und wie ein Lenkrad kippen.

**Geklappt, wenn:** im Kamerafenster „Hand erkannt“ steht und auf dem Bildschirm ein heller Kreis deiner Hand folgt. Fragt das Fenster nach der Kamera: **Zulassen**. Kommt „Die Kamera ist nicht erlaubt“: Windows-Einstellungen > Datenschutz und Sicherheit > Kamera > **Desktop-Apps den Zugriff erlauben** einschalten. Das Kamerabild bleibt auf deinem PC, die Erkennung läuft im Fenster. Beim ersten Mal lädt sie etwa 10 MB aus dem Internet. **„Handsteuerung aus“** oder das **×** beendet sie, dann ist die Kamera wieder aus.

## Wenn etwas nicht klappt

- **Jarvis reagiert nicht auf „Hey Jarvis“:** Einstellungen > Mikrofon. Dort siehst du den Pegel und ob „Hey Jarvis“ ankommt. Klappt es nur knapp, „Empfindlicher“ einschalten. Strg + Alt + J geht immer.
- **Eine Discord-Nachricht kam nicht an:** Jarvis holt Discord kurz nach vorn, tippt und bringt dich danach zurück ins Spiel. Bewegst du dabei die Maus oder klickst woanders hin, versucht er es von selbst noch zweimal. Klappt es dann immer noch nicht, sagt er dir das. Discord muss installiert und angemeldet sein, und der Name muss so heißen, wie die Person in Discord angezeigt wird.
- **Das Handy verbindet nicht:** Handy und PC im selben WLAN? Jarvis läuft? Hat Windows nach der Firewall gefragt, „Zulassen“ wählen. Hat der PC eine neue Adresse bekommen, den QR-Code noch einmal scannen.
- **Alexa sagt „Ihr PC antwortet nicht“:** Läuft Jarvis? Im Fenster unter Verbinden > Alexa auf **Verbindung testen** klicken.
- **Die Alexa-Konsole will beim Aufrufnamen „jarvis“ nicht:** links unter **Invocations** > **Skill Invocation Name** `mein jarvis` eintragen, **Save**, **Build**. Dann heißt es „Alexa, sag mein Jarvis, …“.
- **Die Stimme klingt wieder nach Computer:** Dann ist das ElevenLabs-Guthaben aufgebraucht, die gewählte Stimme braucht ein Abo, oder das Internet ist weg. Unter Einstellungen > Stimme steht, wie viele Credits übrig sind.
- **Jarvis schneidet dich ab:** In `config.toml` im Jarvis-Ordner (`%LOCALAPPDATA%\Programs\Jarvis`) unter `[listen]` die Zeile `silence_seconds = 1.2` eintragen und Jarvis neu starten.
- **Jarvis lehnt etwas ab:** Anders formulieren hilft meistens. Unter Einstellungen > Gehirn steht Claudes genaue Meldung.
- **Mikrofon blockiert** (die Einrichtung meldet absolute Stille): Windows-Einstellungen > Datenschutz und Sicherheit > Mikrofon > „Desktop-Apps den Zugriff auf das Mikrofon erlauben“ einschalten.
- **Irgendwas anderes:** `werkzeuge\Selbsttest.bat` im Jarvis-Ordner prüft alles. In `logs\jarvis.log` steht genau, was passiert ist. Beides kannst du Claude im Jarvis-Projekt schicken.

**Neue Version:** Rechtsklick aufs Jarvis-Symbol neben der Uhr > **Neueste Version laden**. Der Browser lädt die neue `JarvisSetup.exe`, doppelklicken, fertig. Deine Einstellungen und das Gedächtnis bleiben.

Deinstallieren: Windows-Einstellungen > Apps > Jarvis > Deinstallieren. Das nimmt auch den Autostart mit.

## Echos und Licht über Home Assistant (freiwillig)

Damit Jarvis auf deinen Echos etwas ansagt („Sag im Wohnzimmer Bescheid, dass das Essen fertig ist“) und dein Licht schaltet. Kostet nichts, braucht aber einmal Einrichtung:

1. **Home Assistant** installieren, zum Beispiel auf einem Raspberry Pi: https://www.home-assistant.io/installation/
2. In Home Assistant **HACS** installieren und darüber **„Alexa Media Player“**. Dann mit deinem Amazon-Konto anmelden.
3. In Home Assistant unten links auf deinen Namen > **Sicherheit** > **Langlebige Zugriffstoken** > Token erstellen und kopieren.
4. In der Jarvis-Einrichtung bei **Extras > Alexa über Home Assistant** die Adresse (zum Beispiel `http://homeassistant.local:8123`) und den Token einfügen und **Verbindung testen** klicken.
5. Ausprobieren: „Hey Jarvis, mach das Licht im Wohnzimmer an.“
