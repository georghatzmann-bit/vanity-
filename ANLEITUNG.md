# HELIX – Anleitung

HELIX ist dein Fortnite-Tuning-Cockpit für Windows. Es arbeitet nur mit Dateien auf deinem PC und
mit normalen Windows-Einstellungen. Es liest keinen Spielspeicher, fasst kein Anti-Cheat an,
kopiert keine Login-Daten und blendet nichts im Spiel ein.

## Installieren

1. Auf der Release-Seite (https://github.com/georghatzmann-bit/vanity-/releases – Eintrag „HELIX …“)
   die Datei `HELIX-Setup-<Version>.exe` herunterladen und starten.
   Wenn Windows „Der Computer wurde durch Windows geschützt“ zeigt: **Weitere Informationen** → **Trotzdem ausführen**.
   (Das kommt, weil das Setup nicht gegen Geld signiert ist.)
2. Nach dem kurzen Logo auf **Installieren** klicken. Das Setup lädt die neueste HELIX-Version von GitHub,
   prüft sie und richtet Verknüpfungen ein. Kein Administrator nötig.
3. Fertig: **HELIX starten**.

Entfernen: Windows-Einstellungen → Apps → HELIX → Deinstallieren. Deine Profile kannst du dabei behalten.

## Settings-Profile (der Kern in der Mitte)

So speicherst du ein Profil:

1. In Fortnite mit dem gewünschten Konto einloggen und alles einstellen.
2. Fortnite schließen (manche Werte speichert Fortnite erst beim Beenden).
3. In HELIX auf den Kern klicken → **Aktuelle Einstellungen als Profil speichern** → Namen eingeben (z. B. „Main“).

So wechselst du:

1. Im Epic Games Launcher selbst in das gewünschte Konto einloggen.
2. In HELIX unten im Cockpit auf das Profil klicken → **Jetzt anwenden**.
   HELIX prüft vorher, ob Fortnite zu ist (und schließt es auf Wunsch), legt immer eine Sicherung an
   und zeigt danach genau, welche Dateien kopiert wurden.

Wichtig zu wissen:

- **Grafik, Auflösung, FPS, Helligkeit** stehen in `GameUserSettings.ini`. Diese Datei gilt für alle Konten
  auf deinem PC gemeinsam – genau dafür sind die Profile da.
- **Tastenbelegung und Sensi** speichert Fortnite pro Konto in der Epic-Cloud und holt sie beim Einloggen.
  Deshalb kann HELIX sie nicht selbst umstellen. Stattdessen liest HELIX sie aus der Kopie auf dem PC
  (`Saved\Cloud\<Konto>\ClientSettings.Sav`) und zeigt dir nach dem Anwenden nur die Unterschiede,
  zum Beispiel „Wand: Q → Maustaste 4“ oder „Maus-Sensi X: 6,5 % → 7,2 %“. Die stellst du im Spiel um – fertig.
  Die ganze Belegung eines Profils siehst du jederzeit über den Knopf **Tasten & Sensi** am Profil.
- **Schreibschutz** (pro Profil wählbar): schützt die Grafik-Datei davor, dass sie verändert wird.
  Dann speichert Fortnite aber auch Änderungen im Spiel nicht. Aufheben: Kern → „Gefundene Dateien“ →
  **Schreibschutz überall aufheben**.
- **Zeitmaschine**: Vor jedem Anwenden sichert HELIX den alten Zustand. Dort kannst du alles mit einem Klick
  zurückholen. Den Zustand beim allerersten Start von HELIX hebt es immer auf.

## Die Tools (farbige Kreise im Cockpit)

| Planet | Wofür |
|---|---|
| Sensi | Eigener Aim-Test (Flicks, Tracking, bewegliche Ziele), testet mehrere Empfindlichkeiten und DPI, empfiehlt deine beste Sensi, eDPI und Umrechnung in andere Spiele |
| PC-Check | Liest CPU, Grafikkarte, RAM und Monitor aus und schlägt Grafikeinstellungen vor (Leistung, Ausgewogen, Qualität) – mit Vorschau und Sicherung |
| Sicht | Fertige Sicht-Presets (Sturm, Nacht, helle Karte, Turnier) für Helligkeit, Kontrast und störende Effekte |
| Maus | Windows-Zeigergeschwindigkeit, Zeigerbeschleunigung, Abfragerate, DPI-Messung |
| Ping | Misst die Verbindung zu allen Fortnite-Regionen und Unterregionen |
| Booster | Schließt Programme aus deiner eigenen Liste und startet sie danach wieder |
| Monitor | Testbilder für Schwarzwert, Weißwert, Gamma, Kontrast und eine geführte Einstellungshilfe |
| Cache | Löscht Shader-, DirectX- und Fortnite-Zwischenspeicher und zeigt vorher den Platzgewinn |
| Hardware | Temperaturen, Auslastung und Arbeitsspeicher live – nur lesend |
| Statistik | Spielzeit pro Profil und dein Aim-Test-Verlauf als Diagramm |
| Replays | Replay-Tresor: sichert deine besten Fortnite-Replays, bevor Fortnite sie löscht |
| Reaktion | Reaktionstest und Trainer für deine Bau- und Edit-Tasten |
| Windows | Prüft Spielmodus, Aufnahme im Hintergrund, GPU-Planung und Energieplan |

Gut zu wissen:

- **Sensi**: HELIX empfiehlt einen Wert, stellt ihn aber nicht selbst ein. Die Sensi speichert Fortnite in
  deinem Konto in der Cloud. Du stellst sie im Spiel unter Einstellungen → Maus und Tastatur ein.
- **PC-Check, Sicht, Maus**: Bevor HELIX etwas in Fortnite ändert, zeigt es dir genau, was sich ändert, und
  legt eine Sicherung an. Fortnite muss dabei geschlossen sein. Zurück geht es jederzeit über die Zeitmaschine.
- **Booster**: Windows, Virenschutz, Anti-Cheat, Fortnite, der Epic Games Launcher und HELIX selbst werden nie
  geschlossen. Programme schließt HELIX normal (wie mit dem X am Fenster) und startet sie danach wieder.
- **Hardware**: Die Grafikkarten-Temperatur gibt es bei NVIDIA direkt. Eine echte Prozessor-Temperatur bräuchte
  einen extra Treiber – den installiert HELIX absichtlich nicht.
- **Windows-Check und Maus**: HELIX ändert nur Einstellungen deines eigenen Benutzerkontos und den Energieplan.
  Alles, was Administrator-Rechte braucht, erklärt es nur und öffnet die passende Windows-Seite.
- **Windows-Check**: Um den freien Platz auf dem Laufwerk mit Fortnite zu prüfen, liest HELIX aus der
  Installationsliste des Epic Launchers nur den Ordner, in dem Fortnite liegt. Es wird nichts kopiert.

## Wo liegen meine Daten?

- Profile, Sicherungen, Verlauf: `%APPDATA%\HELIX`
- Programm: `%LOCALAPPDATA%\Programs\HELIX`
- Protokoll des Setups: `%TEMP%\HELIX-Setup.log`

## Woran merke ich, dass alles geklappt hat?

1. Nach dem Start siehst du das Cockpit: in der Mitte der große Kreis für die Profile, drumherum 13 farbige Tools.
2. Oben rechts steht „Fortnite geschlossen“ (grün) und der Fortnite-Ordner wurde „automatisch gefunden“.
3. Nach dem Speichern erscheint dein Profil unten in der Leiste „Profil anwenden“.
4. Nach dem Anwenden zeigt HELIX eine Liste „kopiert / neu / entfernt“ und oben „Aktiv: <Profilname>“.
