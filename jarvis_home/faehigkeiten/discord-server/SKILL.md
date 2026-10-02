---
name: discord-server
description: Einen Discord-Server gestalten oder umbauen (Kanäle, Kategorien, Rollen, Begrüßung, Regeln, Einladung) über Jarvis' eigenen Bot, im Hintergrund ohne Maus.
---

# Discord-Server gestalten

Georg zockt dabei oft weiter. Alles läuft über Jarvis' Bot, nie über Mausklicks in Discord.

1. Ist der Bot eingerichtet? `python -m jarvis.tool discord-bot status`. Wenn nicht: Sag Georg kurz, er soll im Jarvis-Fenster oben auf "Verbinden" klicken, Bereich Discord. Dort steht jeder Schritt.
2. Ansehen, was da ist: `python -m jarvis.tool discord-bot struktur [server]`.
3. Einen Plan als JSON-Datei in den Temp-Ordner schreiben (Write-Werkzeug, z. B. `%TEMP%\discord-plan.json`) und umsetzen: `python -m jarvis.tool discord-bot plan "<datei>" [server]`. Der Plan ist idempotent: Was es schon gibt, wird nicht doppelt angelegt, gleiche Nachrichten nicht doppelt gepostet.

Planformat:

```json
{
  "kategorien": [
    {"name": "Info", "kanaele": [
      {"name": "regeln", "typ": "text", "thema": "Bitte lesen"},
      {"name": "ankündigungen", "typ": "text"}
    ]},
    {"name": "Zocken", "kanaele": [
      {"name": "Lobby", "typ": "sprache"},
      {"name": "clips", "typ": "text"}
    ]}
  ],
  "rollen": [{"name": "Admin", "farbe": "#e74c3c", "anzeigen": true}],
  "nachrichten": [{"kanal": "regeln", "text": "1. Seid nett ..."}]
}
```

Einzeln geht auch: `discord-bot kanal "<name>" [text|sprache|forum] ["<kategorie>"]`, `discord-bot rolle "<name>" [#farbe]`, `discord-bot nachricht "<kanal>" "<text>"`, `discord-bot einladung ["<kanal>"]`. Kanal löschen nur nach Georgs Ja: `discord-bot kanal-loeschen "<name>"`.

Ideen, wenn Georg nach Vorschlägen fragt: Sieh dir erst die Struktur an und mach zwei, drei konkrete Vorschläge, die zu seinem Server passen (z. B. Info-Bereich mit Regeln und Ankündigungen, Sprachkanäle pro Spiel, ein Clips-Kanal, eine Rolle pro Spiel zum Anpingen). Kein Roman, Georg soll nur Ja sagen müssen.

Danach kurz sagen, was jetzt neu ist ("Fertig, Sir: drei Kanäle und die Rolle Admin sind angelegt.").
