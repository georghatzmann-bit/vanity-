---
description: Ein Video wirklich ansehen - TikTok, YouTube, Instagram, Reels, Shorts oder eine Videodatei. Holt Bilder mit Zeitstempel und das Gesagte als Transkript, lokal und ohne Abo. Nimm es, wenn der Nutzer einen Video-Link schickt, fragt, was in einem Video passiert oder gezeigt wird, oder ein Video zusammengefasst, nachgebaut oder geprüft haben will.
---

# Video ansehen

Videos abspielen kannst du nicht. Dieses Werkzeug lädt das Video, holt gleichmäßig verteilte Bilder heraus (je neun
auf einem Übersichtsbild, jedes mit Zeitstempel) und schreibt den Ton mit. Alles läuft auf dem PC des Nutzers.

## So geht's

1. Ausführen. Lange Videos brauchen ein paar Minuten, setz deshalb timeout 600000:
   - PowerShell: `Push-Location "${user_config.jarvis}"; & "${user_config.python}" -m jarvis.video "<Link oder Datei>"; Pop-Location`
   - Bash: `(cd "${user_config.jarvis}" && "${user_config.python}" -m jarvis.video "<Link oder Datei>")`

   Steht in einem Pfad `~`, ist das Benutzerverzeichnis (unter Windows `%USERPROFILE%`).
2. Die Ausgabe nennt Titel, Länge, Beschreibung, das Transkript mit Zeiten und die Pfade der Übersichtsbilder.
3. Lies zuerst das Transkript. Dann sieh dir die Übersichtsbilder der Reihe nach mit dem Read-Werkzeug an, wenn es
   auf das Gezeigte ankommt.

## Sparsam mit Tokens

- Ein Übersichtsbild kostet etwa so viel wie ein Foto (rund 1200 bis 1500 Tokens) und zeigt neun Szenen. Standard
  sind höchstens 36 Bilder, also vier Übersichtsbilder.
- Geht die Frage nur um das Gesagte (Zusammenfassung eines Vortrags, ein Zitat), reicht das Transkript.
- Geht es um etwas Gezeigtes (eine Oberfläche, Code, Text auf dem Bildschirm, ein Produkt), sieh dir die
  Übersichtsbilder an und danach gezielt einzelne Bilder aus dem Ordner `bilder`. Der Dateiname enthält die Zeit,
  zum Beispiel `bild_007_0-41.jpg` für 0:41. Nie alle Einzelbilder öffnen.
- Weniger Bilder: `--bilder 18`. Mehr bei schnellen Schnitten: `--bilder 72`. Nur Bilder, ohne Ton (schneller):
  `--ohne-ton`. Neu laden statt aus dem Zwischenspeicher: `--neu`.
- Derselbe Link ein zweites Mal kommt aus dem Zwischenspeicher (14 Tage), ohne neu zu laden.

## Antwort

- Beantworte, was der Nutzer wissen will, mit Zeitstempeln ("bei 0:41 zeigt er ..."). Keine Nacherzählung Szene
  für Szene, außer er will genau das.
- Zeigt das Video Programme, Befehle, Links oder Preise, schreib sie genau ab (dafür das Einzelbild ansehen) und sag,
  was du nicht sicher lesen konntest.
- Bleib ehrlich: Was zwischen zwei Bildern passiert, siehst du nicht.

## Wenn es nicht klappt

- "yt-dlp fehlt": Das Werkzeug installiert es beim ersten Mal selbst, dafür braucht es Internet.
- YouTube: Fehlt Deno (ein kleines JavaScript-Programm), installier es mit `winget install --id DenoLand.Deno -e`
  und versuch es noch einmal.
- Private, gelöschte oder nur angemeldet sichtbare Videos (Instagram manchmal) lassen sich nicht laden. Bitte den
  Nutzer dann, das Video als Datei zu speichern, und gib die Datei an.
- Stimmen Python oder Jarvis-Ordner nicht: In Jarvis "Richte die Claude-Plugins ein" sagen, oder in Claude Code
  `/plugin` öffnen und bei "video" die Einstellungen ändern.
