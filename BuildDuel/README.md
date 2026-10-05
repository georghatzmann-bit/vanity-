# BuildDuel

Ein Browser-Spiel zum Schießen und Bauen aus der Schulter-Perspektive – angelehnt an das Spielgefühl des alten Browser-Spiels 1v1.LOL. Alles ist selbst gemacht (eigene Formen, Farben und Töne). Es werden keine Original-Grafiken, -Sounds oder -Namen benutzt.

**Stand: Phase 1 von 12** – leere Szene mit Himmel, Boden, Sonne, Schatten und FPS-Anzeige.

## Starten in 5 Schritten

1. **Python installieren (nur einmal nötig).**
   Öffne <https://www.python.org/downloads/> und klicke auf den gelben Knopf „Download Python“. Starte die heruntergeladene Datei.
   **Wichtig:** Unten im Fenster den Haken bei **„Add python.exe to PATH“** setzen. Dann auf „Install Now“ klicken.
   *Geklappt, wenn:* „Setup was successful“ erscheint.

2. **Spiel herunterladen und entpacken.**
   Lade die ZIP-Datei herunter: [BuildDuel als ZIP](https://github.com/georghatzmann-bit/vanity-/archive/refs/heads/claude/1v1-lol-rebuild-threejs-mzvao9.zip) (du musst bei GitHub angemeldet sein).
   Rechtsklick auf die ZIP-Datei → „Alle extrahieren …“ → „Extrahieren“.
   *Geklappt, wenn:* Du einen normalen Ordner siehst und darin den Ordner `BuildDuel`.

3. **`start.bat` doppelklicken** (im Ordner `BuildDuel`).
   Falls Windows „Der Computer wurde durch Windows geschützt“ zeigt: auf „Weitere Informationen“ und dann „Trotzdem ausführen“ klicken.
   *Geklappt, wenn:* Ein schwarzes Fenster „BuildDuel laeuft: http://localhost:8000/“ anzeigt.

4. **Spielen.**
   Der Browser öffnet sich von selbst mit <http://localhost:8000>. Das schwarze Fenster dabei **offen lassen** – es ist der kleine Server, der das Spiel ausliefert.
   *Geklappt, wenn:* Du Himmel, grünen Boden, eine orange Figur in einem blauen Kasten und oben links die FPS-Zahl siehst.

5. **Beenden.**
   Browser-Tab schließen und das schwarze Fenster schließen.

Kein Python? `start.bat` benutzt auch Node.js, falls das installiert ist.

**Bei jeder neuen Phase:** neue ZIP-Datei laden (Schritt 2), entpacken und `start.bat` im neuen Ordner starten. Deine Einstellungen bleiben erhalten, solange das Spiel unter <http://localhost:8000> läuft.

## Was du in Phase 1 siehst

- Hellblauen Himmel mit Farbverlauf, grünen Boden mit feinem 4-m-Raster (das spätere Bau-Raster) und leichten Nebel in der Ferne.
- Eine **orange Figur** in Spielergröße (1,8 m). Der gelbe Ring zeigt, wo die Kopf-Zone beginnt (oberste 0,3 m = Kopfschuss).
- Einen **blauen Kasten**: genau eine Bau-Zelle (4 × 4 × 4 m). So groß werden später Wände, Böden und Rampen.
- Die Kamera dreht sich langsam. **Maus ziehen** = selbst drehen, **Mausrad** = näher/weiter.
- Oben links: **FPS** (Bilder pro Sekunde, grün ab 55), die Zeit pro Bild und **„Logik 60/s“** – die Spiel-Logik rechnet immer genau 60-mal pro Sekunde, egal wie schnell dein Bildschirm ist.

## Tests

Während `start.bat` läuft, diese Adresse öffnen: <http://localhost:8000/tests/tests.html>

*Geklappt, wenn:* oben grün „Alle … Tests bestanden“ steht. Rote Zeilen sagen genau, was nicht stimmt.

## Spielwerte ändern

Alle Zahlen (Tempo, Schaden, Größen, Tasten, Zeiten) stehen in **einer** Datei: `src/config.js`.

- Werte mit `// SCHÄTZUNG` hat das Original nie veröffentlicht – sie sind geschätzt und dürfen gern angepasst werden.
- Werte mit `// belegt` stammen aus verlässlichen Quellen über das Original.
- Nach dem Ändern: Datei speichern, im Browser **F5** drücken. Danach am besten die Tests öffnen – sie melden, wenn Werte nicht mehr zusammenpassen.

**Ruckelt es?** In `src/config.js` die Zeile `quality: 'hoch'` auf `'mittel'` oder `'niedrig'` ändern.

## Probleme und Lösungen

| Was du siehst | Was du tun kannst |
|---|---|
| „Bitte über start.bat starten“ | Du hast `index.html` direkt geöffnet. So blockiert der Browser die Spiel-Dateien. Tab schließen, `start.bat` doppelklicken. |
| Schwarzes Fenster: „Weder Python noch Node.js gefunden“ | Schritt 1 machen. Klappt es danach immer noch nicht: PC neu starten und nochmal versuchen. |
| Schwarzes Fenster: „Spiel-Dateien fehlen“ | Die ZIP-Datei wurde nicht ganz entpackt. Schritt 2 wiederholen („Alle extrahieren“). |
| „Port 8000 war belegt, darum jetzt Port 8001“ | Es läuft noch ein anderes `start.bat`-Fenster. Alle schließen und neu starten. |
| Kasten mit rotem Rand: „Dein Browser kann gerade keine 3D-Grafik …“ | Browser aktualisieren. In den Browser-Einstellungen „Hardwarebeschleunigung verwenden“ einschalten, Browser neu starten. |
| FPS-Zahl ist orange oder rot | Grafik auf `'mittel'` stellen (siehe oben). Laptop ans Netzteil hängen. |
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
    main.js             Start und Spielschleife
    loop.js             feste Spiel-Uhr (60 Logik-Schritte pro Sekunde)
    camera.js           Kamera (Phase 1: Vorschau-Kamera)
    world/              Himmel, Licht, Boden, Maßstab-Objekte
    ui/                 FPS-Anzeige und Aussehen (styles.css)
    util/random.js      Zufall mit Startwert (gleiches Muster bei jedem Start)
  tests/                automatische Tests (tests.html)
  tools/                kleiner lokaler Server (Python oder Node.js)
```

Weitere Ordner aus dem Plan (`building/`, `weapons/`, `ai/`, `modes/`, `audio/`) kommen in den jeweiligen Phasen dazu.

## Fahrplan

| Phase | Inhalt | Stand |
|---|---|---|
| 1 | Projekt, start.bat, Szene mit Boden, Himmel, Licht, FPS-Anzeige | ✅ fertig |
| 2 | Spielerfigur, Laufen, Springen, Ducken, Schulter-Kamera | offen |
| 3 | Bau-System: Raster, Vorschau, Wand/Boden/Rampe/Dach, Material | offen |
| 4 | Editieren, Einsturz, Spitzhacke | offen |
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
