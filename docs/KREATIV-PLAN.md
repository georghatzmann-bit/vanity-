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
- **Sound:** live erzeugte Töne (Web Audio), keine Dateien. Startklang, Klick, Erfolg, Fehler, Boost.
- **Raster im Hintergrund:** wie ein Radar-Schirm, das Glühen färbt sich leicht nach der aktuellen Note.

## Der Installer

Noch eine Stufe über dem NOVA-Setup: Intro mit Druckwellen und „Signal wird aufgebaut … Signal steht.“,
Fortschritt als flüssig gefüllte Kugel, wechselnde Tipps während des Downloads, Druckwellen hinter dem Haken
am Ende. Technisch wie gehabt: eine Exe, Download mit Fortsetzen, SHA-256, Verknüpfungen, Apps & Features,
Update- und Deinstallationsmodus, Selbsttest für die CI.

## Was bewusst nicht drin ist

- Kein „Ping-Routing“ über eigene Server (gibt es ohne eigene Infrastruktur nicht).
- Kein FPS-Zähler (bräuchte einen Grafik-Hook mit Anti-Cheat-Risiko).
- Keine Konten-, Key- oder Mod-Verwaltung.
- Kein Admin-Helfer. Was Adminrechte bräuchte (TCP-Stack-Tweaks, Dienste), macht Pulsar nicht.
