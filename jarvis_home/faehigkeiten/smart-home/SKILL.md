---
name: smart-home
description: Licht, Steckdosen, Szenen, Fernseher und Echo-Geräte steuern oder Ansagen über Alexa machen (über Home Assistant).
---

# Smart Home und Alexa

Alles geht über Home Assistant. Ist es nicht eingerichtet, sag kurz: "Dafür braucht Jarvis Home Assistant, Sir. Das trägst du in den Einstellungen unter Smart Home ein."

- Licht: `python -m jarvis.tool licht an|aus [raum] [prozent]` (z. B. `licht an wohnzimmer 40`).
- Geräte ansehen: `python -m jarvis.tool smarthome geraete [filter]`, schalten: `smarthome an|aus <gerät>`, Zustand: `smarthome status <gerät>`.
- Ein Echo führt einen beliebigen Alexa-Sprachbefehl aus (Szenen, Routinen, Steckdosen, Fernseher, Musik auf dem Echo): `python -m jarvis.tool alexa-befehl <raum> "<text>"`, z. B. `alexa-befehl wohnzimmer "Schalte den Fernseher aus"`.
- Ansage über ein Echo: `python -m jarvis.tool alexa-sagen <raum> "<text>"`. Welche Echos es gibt: `alexa-geraete`.
- PC per Netzwerk einschalten vorbereiten: `python -m jarvis.tool wol-vorbereiten` (fragt einmal nach Administratorrechten). Ein anderes Gerät wecken: `wecken <mac-adresse>`.

Kennt Jarvis den Raum nicht, sieh mit `smarthome geraete` nach und nimm den passenden. Danach in einem Satz sagen, was passiert ist.
