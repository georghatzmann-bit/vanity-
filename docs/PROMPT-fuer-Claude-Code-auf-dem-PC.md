Du arbeitest auf meinem Windows-PC am Projekt "Rift" (Launcher für private Fortnite-Server mit alten Builds, die ich selbst besitze). Antworte mir auf einfachem Deutsch, ich bin kein Programmierer.

Projekt: GitHub-Repo georghatzmann-bit/vanity-, Branch claude/eloquent-wozniak-en0j35. Klone es in C:\Rift-dev (falls noch nicht da) und arbeite auf diesem Branch. Lies zuerst README.md, native/client/README.md und docs/.

Regeln (immer einhalten):
- Nur Privatserver und alte Builds, die ich selbst habe. Nichts für das echte aktuelle Fortnite, keine Anti-Cheat-Umgehung.
- Keine fertigen DLLs aus Discord oder sonst woher – alles aus dem Quellcode im Repo bauen. Lizenzen respektieren.
- Frag mich, bevor du Einstellungen oder Dateien außerhalb von C:\Rift-dev und den Rift-Ordnern (%APPDATA%\Rift, %LOCALAPPDATA%\Rift) änderst.

Mein Setup: Fortnite 19.10 (CL-18675304) liegt in meinem Downloads-Ordner (finde den genauen Pfad über Rift → Library). Rift ist installiert. Profil "Default": Solo, AI bots 30 Hard, Bosses & NPCs an, Bubble Builds an.

Was kaputt ist (Fortnite 19.10):
1. Bus startet nicht: Auf der Start-Insel bleibt "Battle Bus launching in 0s" stehen. Dadurch kommen auch keine Bots (die steigen erst in den Bus).
2. F9-Menü (rift_client.dll, ATLAS-Basis) öffnet sich nicht – weder in der Lobby noch auf der Insel. Konsole geht auch nicht.
3. "Reset on release" funktioniert nicht (Hook "select-reset" wird installiert, wirkt aber nicht).
4. Bubble Builds sehen nicht wie Bubble Builds aus.

Logs:
- %LOCALAPPDATA%\Rift\logs\ (client-diagnostics.log, backend.log, …)
- Rift → Live Log (Server- und Spiel-Zeilen)
- Fortnite-Ordner: FortniteGame\Binaries\Win64\stdout.log (CRT-Ausgabe der Server-DLL) und FortniteGame\Saved\Logs\
- Crash-Berichte: Rift → Crash Analysis

Vorgehen:
1. Bauen wie in .github/workflows/launcher.yml (Visual Studio 2022 + Rust + Node). Wenn Werkzeuge fehlen, sag mir welche und frag, bevor du sie installierst.
2. Rift starten, Host & Play drücken, die Logs live lesen und jeden Fehler an der Ursache beheben (nicht raten – erst im Log belegen).
3. Nach jedem Fix selbst testen: Bus startet (F9 → Host → Start the bus), Bots springen ab, F9 öffnet sich, Reset on release, Bubble Builds.
4. Wenn alles geht: committen und auf den Branch pushen, das komplette Setup bauen (Rift-Setup.exe) und mir sagen, wo es liegt.
