# Test-Checkliste – Vollversion

So testest du Vanity mit deinem echten Fortnite 19.10. Bitte **in dieser Reihenfolge**, und bei
jedem Punkt, der nicht klappt: Screenshot + Log an mich (siehe unten „Was ich brauche“).

## Herunterladen

Direkter Link (immer der neueste Stand):
**https://github.com/georghatzmann-bit/vanity-/releases/download/vanity-testversion/Vanity-Setup.exe**

Windows meldet evtl. „Der Computer wurde durch Windows geschützt“, weil der Installer nicht
signiert ist → **Weitere Informationen** → **Trotzdem ausführen**. Installiert nur für deinen
Benutzer, ohne Admin-Rechte. Wenn dein Virenprogramm die DLLs blockiert: den Vanity-Ordner
(`%LOCALAPPDATA%\Vanity` und das Installationsverzeichnis) als Ausnahme eintragen – das ist bei
allen OG-Launchern so.

## Vorher

- Reboot Launcher und Fortnite komplett schließen (Task-Manager: kein `FortniteClient-Win64-Shipping.exe`).
- Port 80 frei? Falls Skype/IIS/… ihn belegt, in Vanity → Einstellungen → Matchmaker-Port z. B. auf 8080 stellen.

## Schritt 1 – Build hinzufügen (ohne Fortnite zu starten)

- [ ] Bibliothek → Build hinzufügen → Durchsuchen → `C:\Users\georg\Downloads\windows-19.10` → Prüfen.
- [ ] Vier grüne Haken, Version **19.10 (CL-18675304)**, Season „Chapter 3 · Season 1“, „Unreal Engine 5.0“.
- [ ] Hinzufügen → Karte erscheint, Profil „Standard“ wurde automatisch angelegt (Seite Profile).
- [ ] Vanity schließen und neu öffnen → Build und Profil sind noch da.

## Schritt 2 – Backend allein (Lobby)

Es gibt keinen Extra-Knopf dafür – „Host & Play“ startet alles. Beobachte deshalb beim ersten Mal
das **Live-Log**:

- [ ] Zeile „Backend hört auf 127.0.0.1:3551“.
- [ ] Zeile „Starte Server-Fortnite …“, dann „Umleitung geladen“.
- [ ] Im Server-Log eine Zeile mit `ContinueLoggingIn` und **„Anmeldung erkannt“** (violett).
      → Wenn st