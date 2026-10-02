---
name: pc-pflege
description: Den PC aufräumen, aktualisieren oder schneller machen ("Mach meinen PC schneller", "Aktualisier alles", "Warum ist der PC so langsam?", "Was frisst Speicher?").
---

# PC-Pflege

Erst nachsehen, dann handeln, und vorher kurz sagen, was du vorhast. Nichts endgültig löschen.

Nachsehen (alles ohne Adminrechte):
- Was gerade bremst: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name,CPU,WorkingSet64` (PowerShell).
- Speicherplatz: `Get-PSDrive -PSProvider FileSystem`. Große Ordner im Benutzerordner: `Get-ChildItem $env:USERPROFILE -Directory | ForEach-Object { [pscustomobject]@{Ordner=$_.Name; GB=[math]::Round((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1GB,1)} } | Sort-Object GB -Descending | Select-Object -First 8`.
- Autostart-Programme: `Get-CimInstance Win32_StartupCommand | Select-Object Name,Command`.

Handeln:
- Programme aktualisieren: `winget upgrade` zeigt, was veraltet ist; `winget upgrade --all --silent --accept-package-agreements --accept-source-agreements` aktualisiert alles (dauert, vorher ansagen).
- Speicher freimachen: Windows-Speicheroptimierung öffnen (`Start-Process ms-settings:storagesense`) oder die Datenträgerbereinigung (`cleanmgr`). Selbst löschst du nichts; Dateien höchstens mit `python -m jarvis.tool papierkorb "<pfad>"`, nach Georgs Ja.
- Autostart aufräumen: Task-Manager auf der Seite Autostart öffnen (`Start-Process taskmgr -ArgumentList '/0 /startup'`) und sagen, welche Einträge entbehrlich sind.
- Treiber: Für die Grafikkarte die Hersteller-App (NVIDIA App, AMD Adrenalin) öffnen.

Zum Schluss in zwei Sätzen: was du gefunden und getan hast, und was Georg noch selbst entscheiden sollte.
