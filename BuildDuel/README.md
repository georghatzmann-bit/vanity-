# BuildDuel

Ein Browser-Spiel zum Schießen und Bauen aus der Schulter-Perspektive – angelehnt an das Spielgefühl des alten Browser-Spiels 1v1.LOL. Alles ist selbst gemacht (eigene Formen, Farben und Töne). Es werden keine Original-Grafiken, -Sounds oder -Namen benutzt.

**Stand:** Lobby (Hauptmenü) mit Spind, Shop und Einstellungen, **Kreativ-Modus** (frei bauen mit unendlich Material) und Übungsplatz. Bauen, Editieren, Waffen, HUD, Ton und die Welt sind fertig; Bots und die Wettkampf-Modi (Duell, Battle Royale …) folgen.

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
   *Geklappt, wenn:* Erst ein blauer Ladebildschirm mit gelbem Balken erscheint und danach die **Lobby**: deine Figur dreht sich in der Mitte auf einem Podest, rechts unten steht der große gelbe Knopf **„SPIELEN“** (Modus „Kreativ“ ist schon gewählt). Klick auf **SPIELEN** – dann bist du im Spiel und kannst laufen und bauen (Steuerung siehe unten).

5. **Beenden.**
   Browser-Tab schließen und das schwarze Fenster schließen.

Kein Python? `start.bat` benutzt auch Node.js, falls das installiert ist.

**Bei jeder neuen Phase:** neue ZIP-Datei laden (Schritt 2), entpacken und `start.bat` im neuen Ordner starten. Deine Einstellungen bleiben erhalten, solange das Spiel unter <http://localhost:8000> läuft.

## Lobby, Spind, Shop und Einstellungen

Nach dem Laden landest du in der **Lobby**:

| Wo | Was |
|---|---|
| Mitte | deine Figur auf dem Podest – mit der Maus ziehen dreht sie |
| oben links | dein **Name** (anklicken = umbenennen, wird gespeichert), **Level** und **XP-Balken** |
| oben rechts | **Pokale**, **Münzen** und das **Zahnrad** (Einstellungen) |
| links | **Shop** (Sachen mit Spiel-Münzen kaufen – kein echtes Geld) und **Spind** (Skin, Spitzhacke, Emote anziehen) |
| rechts unten | **Modus** (anklicken = wechseln; „Kreativ“ und „Übungsplatz“ gehen, graue Modi mit „bald“ kommen später), **Solo/Duo** (Duo kommt bald) und **SPIELEN** |

- **Spind:** Reiter Skins / Spitzhacken / Emotes. Anklicken zeigt die Sache auf dem Podest, **Anziehen** übernimmt sie. Gesperrte Sachen zeigen ein Schloss und den Preis.
- **Shop:** Sache wählen → **Kaufen** → im Fenster **Kaufen** bestätigen. Du startest mit 1.500 Münzen; jedes neue Level bringt 150 Münzen. XP gibt es fürs Spielen (pro Minute) und fürs Bauen (pro 100 Bauteile).
- **Bedienung ohne Maus:** Pfeiltasten wandern über die Knöpfe, **Enter** drückt, **Esc** geht zurück. Mit Controller: Steuerkreuz/Stick, **A** = drücken, **B** = zurück.
- Der zuletzt gewählte Modus und alles Gekaufte bleiben gespeichert (im Browser).

**Im Spiel** gibt **Esc** die Maus frei und öffnet das **Pause-Menü**: Weiter, Einstellungen, (im Kreativ-Modus) Alle Bauteile löschen, Zurück zur Lobby.

**Einstellungen** (Zahnrad in der Lobby oder im Pause-Menü) – alles wird sofort gespeichert:

| Reiter | Was |
|---|---|
| Steuerung | jede Taste neu belegen (Feld anklicken, dann Taste, Maustaste oder Mausrad drücken; Entf löscht). Doppelt belegte Tasten werden **rot**. „Auf Standard“ setzt alles zurück. Ducken halten/umschalten, Ducken auf Strg, Edit beim Loslassen bestätigen, Edit nach Bestätigen zurücksetzen |
| Empfindlichkeit | Maus X und Y, Zielen, Zielfernrohr, Baumodus, Edit-Modus, Y-Achse umkehren |
| Grafik | Qualität (gilt nach dem Neuladen – Knopf „Jetzt neu laden“), Auflösung 50–100 % (sofort), Sichtweite (nach dem Neuladen), FPS-Anzeige |
| Ton | Gesamt, Effekte, Musik (sofort hörbar) |
| Spiel | Schadenszahlen, Controller-Zielhilfe, Bot-Schwierigkeit |

## Der Kreativ-Modus

Der Standard-Modus der Lobby: eine große, flache Wiese (200 × 200 m) zum freien Bauen und Üben.

- **Unendlich Material** – Holz, Stein und Metall gehen nie aus.
- **Alle Waffen und Heil-Items** auf den Plätzen 1–5, Munition unendlich. **Zielpuppen** stehen an der Seite, Baum/Fels/Auto zum Abbauen mit der Spitzhacke.
- Oben in der Mitte: **Bauteile/s** (wie viele Teile du in der letzten Sekunde gesetzt hast, mit Rekord) und **Bauteile** gesamt.
- **P** (oder im Pause-Menü „Alle Bauteile löschen“) räumt alle Bauteile weg.
- Fällst du aus der Welt oder wirst besiegt, stehst du nach 2 Sekunden wieder am Startpunkt.

Schnellstart ohne Lobby (für Tests): <http://localhost:8000/?mode=creative> bzw. `?mode=practice`.

## Steuerung

Im Spiel einmal ins Bild klicken (bzw. nach **SPIELEN** passiert das von selbst). Dann wird die Maus im Spiel festgehalten (der Mauszeiger verschwindet) und die Maus dreht die Kamera.

| Was | Taste |
|---|---|
| Laufen | **W A S D** |
| Umschauen | **Maus** |
| Springen | **Leertaste** (gedrückt halten = immer wieder springen) |
| Ducken | **Shift** gedrückt halten (linke oder rechte Shift-Taste) |
| Zielen (Kamera fährt näher ran) | **rechte Maustaste** gedrückt halten |
| Tanzen | **B** |
| Pause-Menü (Maus freigeben) | **Esc** – „Weiter“ spielt weiter |
| Alle Bauteile löschen (Kreativ) | **P** |
| Alle Tasten auf einen Blick | **H** (nochmal **H** schließt die Hilfe) |

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

Alle Tasten kannst du in den **Einstellungen → Steuerung** ändern. Die Standard-Belegung steht in `src/config.js` (Abschnitt `controls`).

## Der Übungsplatz

Den Übungsplatz wählst du in der Lobby unter **Modus** (oder direkt mit <http://localhost:8000/?mode=practice>): 80 × 80 m mit Mauer rundherum. Probier die Stationen aus:

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

- **Der Geist:** Blau = hier geht's. Rot = geht nicht (kein Material, jemand steht im Weg, das Teil hätte keinen Halt oder du bist am Rand des Platzes bzw. zu hoch). Steht dort schon ein Teil, siehst du nur einen dünnen roten Rahmen. Eine **Wand** geht immer – stehst du in ihr, schiebt sie dich zur Seite.
- **Wohin kommt das Teil?** Die Wand an die Kante vor dir, Boden und Rampe in das Feld vor dir, das Dach über dich. Schaust du nach oben, kommt das Teil eine Etage höher. Schaust du auf den Boden, kommt es dorthin.
- **Aufbau:** Neue Teile sind kurz durchsichtig und wachsen auf volle Stärke (Holz 1 s, Stein 2 s, Metall 3 s). Schüsse halten sie aber sofort auf.
- **Halt:** Jedes Teil muss mit dem Boden verbunden sein. Wird das unterste Teil eines Turms zerstört, fällt alles darüber in sich zusammen.
- **Box (Schutz):** In einer Zelle stehen bleiben, Wand setzen, viermal um 90° drehen und jeweils eine Wand setzen, dann **V** für das Dach.
- **Ramp Rush:** **W** gedrückt halten, Maus gedrückt halten und abwechselnd **C** (Rampe) und **Z** (Wand) drücken – du läufst die Rampen hoch, die Wände schützen dich.
- **Maus gedrückt halten:** Wird deine Wand zerschossen, setzt das Spiel sie sofort wieder hin (solange du hinschaust).
- **90er:** Rampe + Wand setzen, die Rampe hochlaufen (etwas zur linken Seite), oben **90° nach links drehen**, Wand, **springen**, in der Luft Rampe + Wand. Wiederholen – jede Runde eine Etage höher.
- **Edit:** Nur eigene Teile. **G** zeigt leuchtende Felder; angeklickte Felder werden rot und verschwinden nach dem zweiten **G**. Die zwei mittleren unteren Felder einer Wand ergeben eine **Tür** (mit **E** öffnen/schließen).
- **Ecktreppe:** Bei einer Rampe **ein** Feld wegnehmen – dann wird sie zur Treppe mit Ecke: ein Stück hoch auf ein kleines Podest, um die Ecke drehen und weiter hinauf. Nimmst du **zwei Felder nebeneinander** weg, bleibt eine schmale Rampe; sie steigt in die Richtung, in der du über die zwei Felder gezogen (oder sie nacheinander angeklickt) hast: erstes Feld = unten, zweites = oben.

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
- [ ] Sturz vom Turm: unten links sinkt der blaue Schild-Balken von 100 auf 50

## Waffen (Phase 5)

| Was | Taste |
|---|---|
| Schießen | **linke Maustaste** (Sturmgewehr, MP, Pistole: gedrückt halten) |
| Zielen | **rechte Maustaste** – mit dem Scharfschützengewehr: Zielfernrohr |
| Waffe wählen | **1** Schrotflinte · **2** Sturmgewehr · **3** Scharfschützengewehr · **4** Maschinenpistole |
| Heilen | **5** (Heil-Item in die Hand), dann **linke Maustaste** |
| Spitzhacke | **F** (Material sammeln, Bauteile abbauen) |
| Nachladen | **R** (leeres Magazin lädt von selbst nach) |
| Mausrad | nächste / vorige Waffe |

Auf dem Übungsplatz: **4 nochmal** drücken wechselt zu Pistole und Granatwerfer, **5 nochmal** zum nächsten Heil-Item (Verband, Medikit, kleiner und großer Schildtrank). Munition und Heil-Items gehen dort nie aus.

- **Schieß-Stand** (gelbe Matte, vom Start aus hinten rechts): Zielpuppen in 5, 15, 30 und 60 m, eine davon mit Schild. Über dem Ziel erscheint der Schaden: **weiß** = Körper, **gelb** = Kopf, **blau** = Schild. Die Puppen sind nach 1,5 s wieder heil.
- **Baum, Fels, Auto** (vom Start aus vorn links, hinter dem Turm): mit der Spitzhacke (F) schlagen gibt 5–10 Holz, Stein oder Metall.
- Tipp: Schrotflinte schießen und **sofort** auf das Sturmgewehr (2) wechseln – das geht schneller, als auf den nächsten Schrot-Schuss zu warten.
- Unten rechts stehen Waffe und Munition („Sturmgewehr 30 / ∞“) – mehr dazu im nächsten Abschnitt.
- Alle Waffen-Werte (Schaden, Magazin, Nachladen, Streuung) stehen in `src/config.js` unter `weapons`.

## Anzeigen, Ton und Effekte (Phase 6 und 12)

**Das HUD** (Anzeigen über dem Spielbild):

| Wo | Was |
|---|---|
| Mitte | Fadenkreuz (4 Striche; Schrotflinte = Kreis; wird beim Laufen größer, beim Zielen kleiner). Treffer = kurzes **X** (gelb bei Kopfschuss, **rot** beim Besiegen). Im Edit steht **EDIT** darunter. Beim Nachladen läuft ein Ring, beim Heilen ein grüner Balken. |
| unten links | **Schild** (blau) über **Leben** (grün), je mit Zahl. Darüber der Hinweis **H Steuerung**. |
| unten rechts | **Waffen-Leiste**: Spitzhacke (F) und 5 Plätze (Taste klein in der Ecke, Rand in der Seltenheits-Farbe, gewählter Platz hebt sich ab), daneben **Munition „Magazin / Reserve“** (∞ = unendlich). Darüber die **Bau-Leiste** (Wand/Boden/Rampe/Dach mit den Tasten **deiner** Tastatur – auf einer deutschen Tastatur steht bei der Wand „Y“) und das **Material** (Holz/Stein/Metall, das aktive ist blau umrandet). Im Baumodus hat die Bau-Leiste einen **blauen Rahmen**. |
| oben links | **Kill-Feed**: „Du [AR] Bot_3“ – die letzten 5 Meldungen, sie verschwinden nach 5 Sekunden. ◎ = Kopfschuss. |
| oben Mitte | Name des Modus bzw. der Stand (Duell: „Du 3 – 2 Bot_1“). |
| oben rechts | **Minimap** (nur mit Sturm-Zone: Norden oben, gelber Pfeil = du, weißer Kreis = Zone, gestrichelt = nächste Zone), darunter „Lebend“, „Kills“ und „Zone schrumpft in 0:45“. |
| ganzer Bildschirm | Große Nachrichten („RUNDE 2“, „SIEG!“), Zielfernrohr beim Scharfschützengewehr, ein **roter Bogen** zeigt, aus welcher Richtung du getroffen wirst, **roter Rand** bei wenig Leben, **lila Rand** außerhalb der Zone, „E – Tür öffnen“ vor einer Tür, „Du schaust zu: …“ nach dem Besiegtwerden. |

**H** öffnet eine Übersicht aller Tasten (nochmal **H** schließt sie). Sie zeigt immer die gerade gültige Belegung.

**Ton:** Alle Geräusche werden im Browser erzeugt (keine Sound-Dateien): Schritte (Gras klingt anders als ein Holz-, Stein- oder Metallboden), Springen und Landen, Bauteile setzen (Holz „klock“, Stein dumpf, Metall „kling“) und zerbrechen, jede Waffe eigen, Nachladen, ein heller „Ping“ bei Treffern (Kopfschuss höher), Schild zerbricht (Glas-Klirren), Spitzhacke, Heilen, Sturm-Brummen und eine Sieg-Fanfare. Gegner hörst du aus ihrer Richtung und leiser, je weiter weg sie sind – so hörst du auch, wo jemand baut. Der Ton startet erst nach dem ersten Klick (das verlangen alle Browser). Lautstärken stellst du in den **Einstellungen → Ton** ein (Standardwerte in `src/config.js` unter `audio`). In der Lobby läuft leise Menü-Musik.

**Effekte:** Splitter in Holz-, Stein- oder Metallfarbe bei Treffern auf Bauteile, Trümmer und Staub beim Zerstören und Einstürzen, Funken bei Einschlägen, Rauch und Glut bei Explosionen, Späne beim Sammeln mit der Spitzhacke, blaue Scherben, wenn ein Schild bricht, Staub bei harten Landungen. Bei Grafik „niedrig“ gibt es weniger Teilchen.

**Checkliste für Phase 6** (bitte ausprobieren):

- [ ] Alle Anzeigen stehen an der beschriebenen Stelle und ändern sich sofort (Schild/Leben nach einem Sturz, Munition beim Schießen, Material-Wechsel mit Q)
- [ ] Baumodus (Z/X/C/V): blauer Rahmen um die Bau-Leiste; G auf eine eigene Wand: „EDIT“ unter dem Fadenkreuz
- [ ] Eine Zielpuppe treffen: weißes X; Kopfschuss: gelbes X
- [ ] H zeigt die Steuerung, H schließt sie wieder
- [ ] Ton: Schüsse, Bauen, Treffer-Ping – und nach Esc + Weiterspielen ist der Ton noch da

## Die Welt (Phase 8–10, Teil 1)

Die Spielmodi Duell, Battle Royale und Zone Wars kommen als Nächstes – ihre Welt ist schon fertig und kann in **Test-Modi** ausprobiert werden (Adresse während `start.bat` läuft):

| Test-Modus | Adresse | Was es gibt |
|---|---|---|
| Insel | <http://localhost:8000/?mode=sandbox-island> | 600 x 600 m Insel: Wüstenstadt „Sandkrug“ mit begehbaren Häusern (manche mit Treppe in den 2. Stock), Fluss mit Brücken, Wald, Hof mit Feldern, Hügel, Strand. Du startest auf einem bunten **Heißluftballon** |
| Duell-Arena | <http://localhost:8000/?mode=sandbox-arena> | 80 x 80 m Arena mit Felsen und Bäumen, Startpunkte 40 m auseinander |
| Zone Wars | <http://localhost:8000/?mode=sandbox-zonewars> | kleine hügelige Karte, die Zone wandert und schrumpft schnell |

- **Absprung:** Über der Insel mit der **Leertaste** aus dem Ballon springen. Im freien Fall mit WASD lenken – nach unten schauen + W = Sturzflug. 30 m über dem Boden öffnet sich der **Gleiter** von selbst (oder früher mit der Leertaste). Die Kamera fährt dabei etwas weiter weg, damit du siehst, wo du landest. Landen macht nie Schaden.
- **Kisten** (goldener Würfel, leuchtet): davor stehen und **E** drücken. Heraus springen eine Waffe, Munition, Material und manchmal ein Heil-Item.
- **Gegenstände am Boden** leuchten in ihrer Seltenheits-Farbe (grau, grün, blau, lila, gold). Waffen und Heil-Items mit **E** aufheben – sind alle 5 Plätze voll, wird mit der Waffe in der Hand **getauscht**. Munition und Material sammelst du im Vorbeilaufen ein.
- **Sturm:** die lila Wand. Draußen wird das Bild lila und du verlierst jede Sekunde Leben (der Schild hilft nicht). Die neue Zone liegt immer ganz in der alten.
- Bäume (Holz), Felsen (Stein), Autos und Metallzäune (Metall) kann man mit der Spitzhacke abbauen – sie halten aber nicht ewig.
- Alle Werte (Zonen, Kisten-Inhalt, Seltenheiten, Insel-Größe, Anzahl Häuser/Bäume, Ballon-Tempo …) stehen in `src/config.js` unter `stormZone`, `loot`, `maps`, `skydive` und `modes.battleRoyale`.

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

**Ruckelt es?** In den **Einstellungen → Grafik** die Qualität auf „Mittel“ oder „Niedrig“ stellen (oder die Auflösung senken).

**Maus zu schnell oder zu langsam?** **Einstellungen → Empfindlichkeit**: X (links/rechts) und Y (hoch/runter), z. B. `0,7` = langsamer, `1,5` = schneller.

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
| FPS-Zahl ist orange oder rot | Einstellungen → Grafik: Qualität „Mittel“ (siehe oben). Laptop ans Netzteil hängen. |
| „Die Maus konnte nicht gesperrt werden“ | Nach **Esc** braucht der Browser etwa 1 Sekunde Pause. Kurz warten, dann nochmal klicken. Klappt es mehrmals nicht: Seite mit **F5** neu laden oder Chrome/Edge benutzen. Notfalls erscheint der Knopf **„Ohne Maus-Sperre spielen“** – dann bleibt der Mauszeiger sichtbar und dreht die Kamera nur, solange er im Fenster ist. |
| Die Figur läuft nicht, obwohl ich W drücke | In der Lobby erst **SPIELEN** drücken. Steht „Pausiert“ da, auf **Weiter** klicken. |
| Einstellungen/Münzen sind weg | Sie stehen im Browser-Speicher von `http://localhost:8000`. Ein anderer Port (8001 …) oder „Browserdaten löschen“ fängt neu an. |
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
    main.js             Start, Ladebildschirm, Lobby → Spiel → Pause → Lobby, Spielschleife
    loop.js             feste Spiel-Uhr (60 Logik-Schritte pro Sekunde)
    core/               Spiel (game.js), Ereignisse (events.js), Einstellungen (settings.js),
                        Fortschritt: Münzen, Level, Shop, Spind (progress.js)
    input.js            Tastatur, Maus (Maus-Sperre), Controller
    playerController.js macht aus Tasten + Maus einen Befehl für die Figur
    player.js           Figur: Laufen, Springen, Ducken, Rampen, Fallschaden
    physics.js          Kollision: Kisten, Rampen, Dächer, Boden, Strahlen
    camera.js           Schulter-Kamera (mit Wand-Schutz) und Vorschau-Kamera
    modes/              Spielmodi (Kreativ, Übungsplatz, Test-Modi)
    world/              Himmel, Licht, Karten (Arena, Insel, Zone Wars), Sturm, Loot, Ballon + Gleiter, Figuren-Grafik,
                        Lobby-Bühne (lobbyScene.js), Spind-Aussehen (cosmetics.js)
    building/           Bauen: Raster + Zielwahl (grid.js), Formen/Bilder (pieces.js, view.js),
                        Edit + Türen (edit.js), Bau-System mit Halt/Einsturz (structure.js)
    weapons/            Waffen, Treffer, Geschosse, Waffen-Grafik
    ai/                 noch eine "Attrappe" – Bots kommen in Phase 7
    audio/sfx.js        alle Töne (erzeugt, keine Dateien), Raumklang, Menü-Musik
    ui/                 HUD (hud.js, hud.css, Kill-Feed, Minimap), FPS-Anzeige, Aussehen (styles.css),
                        Lobby/Spind/Shop (menus.js, menus.css), Einstellungen (settings.js, settings.css)
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
| 4 | Editieren, Einsturz, Spitzhacke | ✅ fertig |
| 5 | Waffen | ✅ fertig |
| 6 | HUD komplett | ✅ fertig |
| 7 | Bots | offen |
| 8 | Duell 1v1 | offen |
| 9 | Battle Royale | offen |
| 10 | Box Fight, Zone Wars, Freies Bauen, Aim Trainer, Deathmatch | offen |
| 11 | Menüs, Einstellungen, Controller und Touch | Ladebildschirm, Lobby, Spind, Shop, Einstellungen, Pause-Menü, Kreativ-Modus fertig; Ergebnis-Bildschirm, Pass und Touch folgen |
| 12 | Sound, Partikel, Feinschliff, Leistung | Sound + Partikel fertig, Feinschliff folgt |

## Technik (für Neugierige)

- HTML + JavaScript (ES-Module) + Three.js. Kein Build-Tool nötig.
- `start.bat` startet nicht einfach `python -m http.server`, sondern `tools/server.py`. Grund: Unter Windows liefert Python `.js`-Dateien je nach PC mit falschem Datei-Typ aus – dann lädt das Spiel nicht. Außerdem verhindert der Server, dass der Browser alte Spiel-Dateien zwischenspeichert, sucht sich bei belegtem Port 8000 selbst einen freien und ist nur auf deinem PC erreichbar.
- Spiel-Logik mit festem Zeitschritt (60 pro Sekunde), Bild per `requestAnimationFrame`.

## Rechtliches

BuildDuel ist ein eigenständiger Nachbau der Spielidee. Es hat nichts mit JustPlay.LOL oder 1v1.LOL zu tun und benutzt keine Original-Inhalte.
Three.js steht unter der MIT-Lizenz (siehe `lib/three-LICENSE.txt`).
