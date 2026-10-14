# PULSAR – Kreativ-Plan

Pulsar ersetzt NOVA (den Spiele-Launcher) im selben Projekt. Die Idee: ein **Game Booster** wie GearUP Booster –
nur ehrlich, ohne Konto, ohne Abo, ohne Adminrechte, und mit mehr Werkzeugen.

## Der Name

Ein Pulsar ist ein Stern, der in exakt gleichen Abständen pulst – wie ein perfekter, stabiler Ping.
Daraus kommt alles: das Logo (leuchtender Kern, zwei Strahlen, Ring, Druckwellen), die Startanimation
(der Pulsar baut sich auf, Druckwellen laufen nach außen), der Boost (ein „Puls“ durch den PC) und die
Verbindungsnote (wie gleichmäßig pulst deine Leitung?).

## Die drei Versprechen

1. **Ehrlich.** Keine erfundenen Zahlen, kein „Ping -40 %“. Wenn Pulsar etwas nicht messen kann, sagt es das.
   Pulsar hat kein eigenes Servernetz und behauptet das auch nicht.
2. **Rückgängig.** Jede Änderung an Windows wird vorher gesichert und lässt sich mit einem Klick exakt zurückstellen.
   Ein Boost endet immer so, wie er begonnen hat – auch wenn Pulsar geschlossen wird.
3. **Ohne Adminrechte.** Alles läuft im Benutzerkonto: Energiepläne (`powercfg`), HKCU-Einstellungen,
   Prioritäten der eigenen Spielprozesse, `ipconfig /flushdns`, ICMP über die Windows-API.

## Die Seiten

| Seite | Idee |
|---|---|
| **Cockpit** | Ein Blick, alles klar: Note, Live-Kurve, großer BOOST-Knopf, Auslastung, letzte Runde |
| **Spiele** | Spiele als Startpunkt für „Boost & Spielen“, pro Spiel ein Messziel – bei CS2/Dota/Deadlock/LoL die echten Server |
| **Netzwerk** | Fünf Werkzeuge, die sonst fünf Programme wären: Regionen, Route, DNS, Speedtest (mit Bufferbloat), Verbindung |
| **Optimieren** | Vier Schalter, die wirklich etwas bringen – mit Wirkungseinschätzung und Rückgängig |
| **Berichte** | Jede Runde eine Auswertung mit Note – so sieht man, ob der Boost etwas bringt |
| **Overlay** | Ping, Schwankung, Verlust und Auslastung über dem Spiel |

## Design

- **Farben:** Nachtblau (#04070f) mit Eisblau/Blau/Violett (Theme „Pulsar“). Dazu „Glut“ (warm), „Toxic“ (Neongrün) und „Frost“ (hell).
- **Noten statt Zahlen:** Grün (A+/A) = gut, Blau (B) = okay, Orange (C) = spürbar, Rot (D/F) = Problem. Immer mit Text.
- **Bewegung mit Sinn:** Druckwellen beim Boost und im Intro, Lichtkreis beim Theme-Wechsel, Start-Ritual beim Spielstart. Alles abschaltbar.
- **Sound:** „Pulsar-Sonifikation“: live erzeugte Impulse, Rauschen und fallende Sweeps (Web Audio), keine Dateien und keine Melodien. Details im Abschnitt „Sound“.
- **Raster im Hintergrund:** wie ein Radar-Schirm, das Glühen färbt sich leicht nach der aktuellen Note.

## Der Installer

**Das Setup ist ein Radioteleskop.** Statt Glas, Glühen und Fortschrittskugel: Graphitfläche, 1-px-Haarlinien,
Inter für Text, IBM Plex Mono für Messwerte und Beschriftungen, und genau **eine** Signalfarbe (Gelb wie Kanal 1
am Oszilloskop) für Strahlen, Nadeln und Marken. Knöpfe sind knochenweiß, nie gelb.

- **Intro:** Ein Regler sucht im Rauschen die Faltfrequenz und rastet auf PSR B1919+21 ein, den ersten Pulsar
  (entdeckt 1967 von Jocelyn Bell Burnell und Antony Hewish). Zwei Pulse kommen in Echtzeit, 1337,3 ms auseinander,
  danach zeichnet ein beschrifteter Zeitraffer das gestapelte Profil fertig („SIMULIERTES PROFIL“). Die 16 Zeilen
  falten sich zum Zeichen: jede Rotation ein Strahl, die Summe der Ring – auf einer echten Himmelskarte (1′ = 100 px).
  Überspringen mit jeder Taste oder Klick.
- **Schirm (links):** Ein Neutronenstern mit Magnetachse, Polkappen und Feldlinien. Der **echte** Fortschritt treibt
  ihn an: von 1,337 s (B1919) über Vela und den Krebsnebel bis 5,757 ms (J0437−4715). Eine logarithmische
  Periodenskala mit den vier Katalog-Pulsaren zeigt, wo die Drehzahl gerade steht. Die Zuordnung Prozent → Periode
  ist Inszenierung und als **INSZENIERT** markiert; die Übertragung rechts ist **GEMESSEN**.
- **Bedienfeld (rechts):** Schrittskala, Messwerte mit Einheit, Phasenliste mit Dauer, Laufwerksskala, Optionen als
  Schalterzeilen. Fehler zeigt der Schirm als „KEIN SIGNAL“, Abbruch als „EMPFANG ANGEHALTEN“; Fortsetzen rastet
  sichtbar wieder ein („FORTGESETZT BEI …“).
- **Fertig:** Ein Stroboskop friert den Stern in Logo-Lage ein, er wird zum Zeichen, „Signal steht.“.
- **Deinstallieren:** alles rückwärts – der Stern wird langsamer, drei letzte Pulse, der erwartete vierte bleibt aus,
  das Bild zerfällt ins Rauschen: „Signal verloren.“.
- **Ehrlich:** Alles Erfundene ist beschriftet (INSZENIERT, SIMULIERT, SCHEMA · NICHT MASSSTÄBLICH).
- **Für alle:** reduzierte Bewegung (Standbilder, Ton bleibt), Ton aus per Schalter oder Taste M, weißer Fokus,
  Ansagen für Screenreader, Qualitätsstufen für schwache PCs ohne GPU.

Technisch wie gehabt: eine Exe, Download mit Fortsetzen, SHA-256, Verknüpfungen, Apps & Features,
Update- und Deinstallationsmodus, Selbsttest für die CI.

## Sound

**„Pulsar-Sonifikation“ statt Melodien.** Alle Klänge entstehen live (Web Audio) aus drei Bausteinen: Impulse
(Klicks durch einen Resonator), gefiltertes Rauschen und fallende Dispersions-Sweeps – so, wie ein Pulsar im
Radioteleskop klingt.

- **Rhythmus wird Ton:** Bild und Ton haben eine gemeinsame Taktquelle. Während der Installation werden aus
  Einzelklicks Knattern, dann Schnarren, dann ein Ton bei 173,7 Hz (J0437). Die Anzeige „Hörbar als“ sagt, was
  gerade zu hören ist.
- **Keine Melodie:** Alle Tonhöhen sind Vielfache derselben Grundfrequenz, alle Sweeps fallen. Der einzige Akkord
  ist das Obertonspektrum des Endtons; danach ist Ruhe (keine Countdown-Ticks). Ein Test prüft diese Regeln.
- **Leise und schonend:** Der Installer startet mit halber Lautstärke, nach 20 s ohne Phasenwechsel wird der Ton
  leiser (Gewöhnung). Ton aus bleibt gespeichert; stumm heißt: es werden gar keine Klänge erzeugt.
- **Die App** nutzt dieselbe Engine: alle Klänge (Klick, Erfolg, Fehler, Boost, Startklang …) sind im selben
  Vokabular neu vertont, ohne Codeänderung in der App.

## Was bewusst nicht drin ist

- Kein „Ping-Routing“ über eigene Server (gibt es ohne eigene Infrastruktur nicht).
- Kein FPS-Zähler (bräuchte einen Grafik-Hook mit Anti-Cheat-Risiko).
- Keine Konten-, Key- oder Mod-Verwaltung.
- Kein Admin-Helfer. Was Adminrechte bräuchte (TCP-Stack-Tweaks, Dienste), macht Pulsar nicht.
