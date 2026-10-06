# BuildDuel

Ein Browser-Spiel zum Schießen und Bauen aus der Schulter-Perspektive – angelehnt an das Spielgefühl des alten Browser-Spiels 1v1.LOL. Alles ist selbst gemacht (eigene Formen, Farben und Töne). Es werden keine Original-Grafiken, -Sounds oder -Namen benutzt.

**Stand: Phase 2 von 12** – eine bunte Comic-Figur läuft, springt und duckt sich auf einem Übungsplatz. Die Kamera schaut über die Schulter und geht nie durch Wände.

## Starten in 5 Schritten

1. **Python installieren (nur einmal nötig).**
   Öffne <https://www.python.org/downloads/>. Klicke **nicht** auf den großen gelben Knopf, sondern direkt darunter auf den Link **„Or get the standalone installer for Python 3.…“**. Starte die heruntergeladene Datei.
   **Wichtig:** Unten im Fenster den Haken bei **„Add python.exe to PATH“** setzen. Dann auf „Install Now“ klicken.
   *Geklappt, wenn:* „Setup was successful“ erscheint.
   (Hast du schon den „Python install manager“ vom gelben Knopf installiert? Das geht auch. Der allererste Start von `start.bat` dauert dann 1–2 Minuten, weil Python noch nachgeladen wird.)

2. **Spiel herunterladen und entpacken.**
   Lade die ZIP-Datei herunter: [BuildDuel als ZIP](https://github.com/georghatzmann-bit/vanity-/archive/refs/heads/claude/1v1-lol-rebuild-threejs-mzvao9.zip) (ohne Anmeldung).
   Rechtsklick auf die ZIP-Datei → „Alle extrahieren …“ → „Extrahieren“.
   *Geklappt, wenn:* Es einen Ordner `vanity--claude-1v1-lol-rebuild-threejs-mzvao9` gibt, darin nochmal einen Ordner mit demselben Namen und darin den Ordner `BuildDuel`.
   Die anderen Dateien daneben (z. B. `Jarvis.bat`) gehören zu einem anderen Projekt – einfach nicht beachten.

3. **`start.bat` doppelklicken** (im Ordner `BuildDuel`). Windows zeigt die Datei oft nur als **„start“** mit dem Typ „Windows-Batchdatei“ und einem Zahnrad-Symbol.
   Falls Windows „Der Computer wurde durch Windows geschützt“ zeigt: auf „Weitere Informationen“ und dann „Trotzdem ausführen“ klicken.
   *Geklappt, wenn:* Ein schwarzes Fenster „BuildDuel laeuft: http://localhost:8000/“ anzeigt.

4. **Spielen.**
   Der Browser öffnet sich von selbst mit <http://localhost:8000>. Das schwarze Fenster dabei **offen lassen** – es ist der kleine Server, der das Spiel ausliefert.
   *Geklappt, wenn:* Du eine bunte Figur von hinten, bunte Kisten und Rampen und in der Mitte den gelben Knopf **„Klicken zum Spielen“** siehst. Klick darauf – dann kannst du laufen (Steuerung siehe unten).

5. **Beenden.**
   Browser-Tab schließen und das schwarze Fenster schließen.

Kein Python? `start.bat` benutzt auch Node.js, falls das installiert ist.

**Bei jeder neuen Phase:** neue ZIP-Datei laden (Schritt 2), entpacken und `start.bat` im neuen Ordner starten. Deine Einstellungen bleiben erhalten, solange das Spiel unter <http://localhost:8000> läuft.

## Steuerung (Phase 2)

Erst auf **„Klicken zum Spielen“** klicken. Dann wird die Maus im Spiel festgehalten (der Mauszeiger verschwindet) und die Maus dreht die Kamera.

| Was | Taste |
|---|---|
| Laufen | **W A S D** |
| Umschauen | **Maus** |
| Springen | **Leertaste** (gedrückt halten = immer wieder springen) |
| Ducken | **Shift** gedrückt halten (linke oder rechte Shift-Taste) |
| Zielen (Kamera fährt näher ran) | **rechte Maustaste** gedrückt halten |
| Tanzen | **B** |
| Pause (Maus freigeben) | **Esc** – danach wieder auf „Klicken zum Weiterspielen“ |

**Bauen und Editieren (Phase 3 und 4):**

| Was | Taste |
|---|---|
| Wand / Boden / Rampe / Dach | **Z** (oder **Y**) / **X** / **C** / **V** – schaltet sofort in den Baumodus, ein Geist zeigt, wo das Teil hinkommt |
| Bauteil setzen | **Linksklick** (gedrückt halten = weiter bauen, während du die Maus bewegst) |
| Material wechseln (Holz → Stein → Metall) | **Q** oder **Mausrad drücken** |
| Rampe drehen | **R** (im Baumodus) |
| Bauteile durchschalten | **Mausrad drehen** (im Baumodus) |
| Edit (Fenster, Tür …) | **G** auf ein eigenes Teil, Felder **anklicken** (oder mit gedrückter Maus darüberziehen), **G** = fertig |
| Edit zurücksetzen | **G**, **Rechtsklick**, **G** |
| Tür auf/zu | **E** |
| Baumodus verlassen | **1–5** oder **F** |

Controller (Xbox/PlayStation) gehen auch: linker Stick laufen, rechter Stick umschauen, A/Kreuz springen, R3 ducken, L2 zielen, **Start/Options** = Pause und wieder weiterspielen. Bauen mit Controller: **B/Kreis** schaltet den Baumodus an, dann R2 Wand, L2 Rampe, R1 Boden, L1 Dach, R3 dreht. Edit: Steuerkreuz unten, R2 wählt Felder, L2 setzt zurück, Steuerkreuz unten bestätigt.

Die Tasten-Belegung kann man in Phase 11 im Menü ändern. Bis dahin steht sie in `src/config.js` (Abschnitt `controls`).

## Der Übungsplatz

Das Spiel startet auf einem Übungsplatz (80 × 80 m mit Mauer rundherum). Probier die Stationen aus:

- **Drei Kisten (0,3 m / 1 m / 2 m):** Auf die kleine läufst du einfach hinauf. Auf die 1-m-Kiste kommst du nur mit Springen, auf die 2-m-Kiste gar nicht.
- **Wand (4 m):** Stell dich mit dem Rücken dicht davor und dreh dich – die Kamera geht nie durch die Wand, und deine Figur steht nie vor dem Fadenkreuz.
- **Türkise Rampe (45°):** ohne Springen hoch auf die 4-m-Plattform. Von dort führen lila Rampen auf den **Turm (12 m)**. Auch direkt aneinander gesetzte Rampen läufst du ohne Springen hinauf.
- **Vom Turm springen:** Ein Sturz aus 12 m macht **50 Schaden** (erst geht der Schild weg, dann das Leben). Bis 7 m Fallhöhe passiert nichts. Wirst du besiegt, stehst du nach 2 Sekunden am Startpunkt wieder auf.
- **Grüner Tunnel (Decke 1,5 m):** nur geduckt passt du hinein. Lässt du Shift darunter los, bleibst du trotzdem geduckt, bis über dir Platz ist.
- **Rosa Rampe:** steht so hoch, dass du darunter durchlaufen kannst.
- **Dach:** ein kleines Pyramiden-Dach zum Drüberlaufen.
- **Übungs-Figuren:** stehen nur herum (ab Phase 7 kämpfen Bots richtig).

Oben links steht die **FPS**-Zahl (Bilder pro Sekunde, grün ab 55) und **„Logik 60/s“** – die Spiel-Logik rechnet immer 60-mal pro Sekunde, egal wie schnell dein Bildschirm ist.

## Bauen – so geht's

Auf dem Übungsplatz hast du **unendlich Material**. (In den späteren Modi kostet jedes Teil 10 Material; ohne Material wird der Geist rot.)

- **Der Geist:** Blau = hier geht's. Rot = geht nicht (Platz belegt, kein Material, jemand steht im Weg oder das Teil hätte keinen Halt).
- **Wohin kommt das Teil?** Die Wand an die Kante vor dir, Boden und Rampe in das Feld vor dir, das Dach über dich. Schaust du nach oben, kommt das Teil eine Etage höher. Schaust du auf den Boden, kommt es dorthin.
- **Aufbau:** Neue Teile sind kurz durchsichtig und wachsen auf volle Stärke (Holz 1 s, Stein 2 s, Metall 3 s). Schüsse halten sie aber sofort auf.
- **Halt:** Jedes Teil muss mit dem Boden verbunden sein. Wird das unterste Teil eines Turms zerstört, fällt alles darüber in sich zusammen.
- **Box (Schutz):** In einer Zelle stehen bleiben, Wand setzen, viermal um 90° drehen und jeweils eine Wand setzen, dann **V** für das Dach.
- **Ramp Rush:** **W** gedrückt halten, Maus gedrückt halten und abwechselnd **C** (Rampe) und **Z** (Wand) drücken – du läufst die Rampen hoch, die Wände schützen dich.
- **90er:** Rampe + Wand setzen, die Rampe hochlaufen (etwas zur linken Seite), oben **90° nach links drehen**, Wand, **springen**, in der Luft Rampe + Wand. Wiederholen – jede Runde eine Etage höher.
- **Edit:** Nur eigene Teile. **G** zeigt leuchtende Felder; angeklickte Felder werden rot und verschwinden nach dem zweiten **G**. Die zwei mittleren unteren Felder einer Wand ergeben eine **Tür** (mit **E** öffnen/schließen).

**Checkliste für Phase 3 und 4** (bitte ausprobieren):

- [ ] Z/X/C/V schalten sofort in den Baumodus, der blaue Geist steht am richtigen Platz, Linksklick setzt das Teil
- [ ] Eine gebaute Rampe hochlaufen, einen Ramp Rush und einen "90er" bauen
- [ ] Q wechselt Holz/Stein/Metall (man sieht Bretter, Steine, Nieten), R dreht die Rampe
- [ ] G-Edit: Fenster und Tür in eine eigene Wand machen, Tür mit E öffnen, mit G – Rechtsklick – G zurücksetzen
- [ ] Material-Abzug und Einsturz prüfen die Tests (tests.html) – im Übungsplatz ist Material unendlich, und Zerstören geht erst mit den Waffen (Phase 5)

**Checkliste für Phase 2** (bitte ausprobieren):

- [ ] Spiel startet per Doppelklick auf `start.bat` und öffnet sich im Browser
- [ ] FPS-Anzeige zeigt 50–60 (grün)
- [ ] WASD, Springen, Ducken, Umschauen funktionieren; die Kamera geht nicht durch Wände
- [ ] Die Rampe hochlaufen geht ohne Springen
- [ ] Sturz vom Turm: unten links bei der Steuerung sinkt „Schild“ von 100 auf 50 (das richtige HUD mit Balken kommt in Phase 6)

## Tests

Während `start.bat` läuft, diese Adresse öffnen: <http://localhost:8000/tests/tests.html>

*Geklappt, wenn:* oben grün „Alle … Tests bestanden“ steht. Rote Zeilen sagen genau, was nicht stimmt. Die Tests prüfen u. a. die Spielwerte, die Kollision, die Eingabe und ganze kleine Szenen („1 Sekunde laufen ≈ 6 m“, „Sturz aus 12 m = 50 Schaden“).

Die Gruppe „Vorgaben aus deinem Plan“ prüft Werte, die genau so in deinem Plan stehen (z. B. Schrotflinte max. 90 Schaden). Änderst du so einen Wert **absichtlich**, wird dort ein Test rot – das ist dann in Ordnung.

*Nur für Entwickler:* `tests/e2e/run.cjs` startet das Spiel automatisch in einem unsichtbaren Browser, steuert die Figur, macht Screenshots und prüft die Konsole (braucht Node.js und Playwright, Anleitung oben in der Datei). Für das Spielen ist das nicht nötig.

## Spielwerte ändern

Alle Zahlen (Tempo, Schaden, Größen, Tasten, Zeiten) stehen in **einer** Datei: `src/config.js`.

- Werte mit `// SCHÄTZUNG` hat das Original nie veröffentlicht – sie sind geschätzt und dürfen gern angepasst werden.
- Werte mit `// belegt` stammen aus verlässlichen Quellen über das Original.
- Nach dem Ändern: Datei speichern, im Browser **F5** drücken. Danach am besten die Tests öffnen – sie melden, wenn Werte nicht mehr zusammenpassen.
- Kommazahlen immer mit **Punkt** schreiben (`8.4`, nicht `8,4`). Sonst meldet das Spiel „Tippfehler in src/config.js (Zeile …)“.

**Ruckelt es?** In `src/config.js` die Zeile `quality: 'hoch'` auf `'mittel'` oder `'niedrig'` ändern.

**Maus zu schnell oder zu langsam?** In `src/config.js` unter `sensitivity` den Wert `x` (links/rechts) und `y` (hoch/runter) ändern, z. B. `0.7` = langsamer, `1.5` = schneller.

## Probleme und Lösungen

| Was du siehst | Was du tun kannst |
|---|---|
| „Bitte über start.bat starten“ | Du hast `index.html` direkt geöffnet. So blockiert der Browser die Spiel-Dateien. Tab schließen, `start.bat` doppelklicken. |
| Schwarzes Fenster: „Weder Python noch Node.js gefunden“ | Schritt 1 machen. Klappt es danach immer noch nicht: PC neu starten und nochmal versuchen. |
| Schwarzes Fenster: „Spiel-Dateien fehlen“ | Die ZIP-Datei wurde nicht ganz entpackt. Schritt 2 wiederholen („Alle extrahieren“). |
| Der Browser öffnet sich nicht von selbst | Die Adresse aus dem schwarzen Fenster (z. B. `http://localhost:8000`) selbst in Chrome, Edge oder Firefox eintippen. |
| „Port 8000 war belegt, darum jetzt Port 8001“ | Es läuft noch ein anderes `start.bat`-Fenster. Alle schließen und neu starten. |
| „Windows sperrt Port 8000 …“ | Kein Problem, das Spiel läuft dann auf einem anderen Port (steht im Fenster). |
| Kasten „Tippfehler in src/config.js (Zeile …)“ | In `config.js` an dieser Zeile nachsehen. Meist: Komma statt Punkt bei einer Zahl oder ein fehlendes Komma am Zeilenende. |
| Kasten mit rotem Rand: „Dein Browser kann gerade keine 3D-Grafik …“ | Browser aktualisieren. In den Browser-Einstellungen „Hardwarebeschleunigung verwenden“ einschalten, Browser neu starten. |
| FPS-Zahl ist orange oder rot | Grafik auf `'mittel'` stellen (siehe oben). Laptop ans Netzteil hängen. |
| „Die Maus konnte nicht gesperrt werden“ | Nach **Esc** braucht der Browser etwa 1 Sekunde Pause. Kurz warten, dann nochmal klicken. Klappt es mehrmals nicht: Seite mit **F5** neu laden oder Chrome/Edge benutzen. Notfalls erscheint der Knopf **„Ohne Maus-Sperre spielen“** – dann bleibt der Mauszeiger sichtbar und dreht die Kamera nur, solange er im Fenster ist. |
| Die Figur läuft nicht, obwohl ich W drücke | Erst auf „Klicken zum Spielen“ klicken. Steht „Pausiert“ da, nochmal klicken. |
| Tab ist plötzlich zu | **Strg + W** schließt im Browser den Tab – das kann kein Spiel verhindern. Darum liegt Ducken auf Shift und nicht auf Strg. |
| Irgendein anderer Kasten mit rotem Rand | Screenshot machen und an Claude schicken. |
| Beim Beenden mit Strg + C fragt das Fenster „Batchvorgang abbrechen (J/N)?“ | `J` drücken. Das ist normal. |

## Ordner-Übersicht

```
BuildDuel/
  index.html            Spielseite
  start.bat             Starter (Doppelklick)
  lib/                  Three.js 0.186.1 (3D-Bibliothek, liegt lokal → läuft ohne Internet)
  src/
    config.js           ALLE Spielwerte
    main.js             Start, "Klicken zum Spielen", Pause, Spielschleife
    loop.js             feste Spiel-Uhr (60 Logik-Schritte pro Sekunde)
    core/               Spiel (game.js), Ereignisse (events.js), Einstellungen (settings.js)
    input.js            Tastatur, Maus (Maus-Sperre), Controller
    playerController.js macht aus Tasten + Maus einen Befehl für die Figur
    player.js           Figur: Laufen, Springen, Ducken, Rampen, Fallschaden
    physics.js          Kollision: Kisten, Rampen, Dächer, Boden, Strahlen
    camera.js           Schulter-Kamera (mit Wand-Schutz) und Vorschau-Kamera
    modes/              Spielmodi (jetzt: Übungsplatz)
    world/              Himmel, Licht, Karten, Figuren-Grafik
    building/           Bauen: Raster + Zielwahl (grid.js), Formen/Bilder (pieces.js, view.js),
                        Edit + Türen (edit.js), Bau-System mit Halt/Einsturz (structure.js)
    weapons/ ai/ audio/ noch "Attrappen" – kommen in den nächsten Phasen
    ui/                 FPS-Anzeige, Aussehen (styles.css), später das HUD
    util/random.js      Zufall mit Startwert (gleiches Muster bei jedem Start)
  tests/                automatische Tests (tests.html), Browser-Tests (e2e/)
  tools/                kleiner lokaler Server (Python oder Node.js)
```

## Fahrplan

| Phase | Inhalt | Stand |
|---|---|---|
| 1 | Projekt, start.bat, Szene mit Boden, Himmel, Licht, FPS-Anzeige | ✅ fertig |
| 2 | Spielerfigur, Laufen, Springen, Ducken, Schulter-Kamera | ✅ fertig |
| 3 | Bau-System: Raster, Vorschau, Wand/Boden/Rampe/Dach, Material | ✅ fertig |
| 4 | Editieren, Einsturz, Spitzhacke | ✅ Editieren + Einsturz fertig (Spitzhacke kommt mit den Waffen) |
| 5 | Waffen | offen |
| 6 | HUD komplett | offen |
| 7 | Bots | offen |
| 8 | Duell 1v1 | offen |
| 9 | Battle Royale | offen |
| 10 | Box Fight, Zone Wars, Freies Bauen, Aim Trainer, Deathmatch | offen |
| 11 | Menüs, Einstellungen, Controller und Touch | offen |
| 12 | Sound, Partikel, Feinschliff, Leistung | offen |

## Technik (für Neugierige)

- HTML + JavaScript (ES-Module) + Three.js. Kein Build-Tool nötig.
- `start.bat` startet nicht einfach `python -m http.server`, sondern `tools/server.py`. Grund: Unter Windows liefert Python `.js`-Dateien je nach PC mit falschem Datei-Typ aus – dann lädt das Spiel nicht. Außerdem verhindert der Server, dass der Browser alte Spiel-Dateien zwischenspeichert, sucht sich bei belegtem Port 8000 selbst einen freien und ist nur auf deinem PC erreichbar.
- Spiel-Logik mit festem Zeitschritt (60 pro Sekunde), Bild per `requestAnimationFrame`.

## Rechtliches

BuildDuel ist ein eigenständiger Nachbau der Spielidee. Es hat nichts mit JustPlay.LOL oder 1v1.LOL zu tun und benutzt keine Original-Inhalte.
Three.js steht unter der MIT-Lizenz (siehe `lib/three-LICENSE.txt`).
