# Vanity-Backend

Das Backend ist ein kleiner Server auf dem eigenen PC. Er antwortet dem alten Fortnite-Build an
Stelle der echten Epic-Server: Login, Spind, Shop, Einstellungen und Matchmaking. Er spricht
**nie** mit Epic – alles bleibt auf dem eigenen Rechner (oder im eigenen Netzwerk, wenn man es so
einstellt).

Gebaut für Fortnite **19.10** (Kapitel 3, Season 1), funktioniert aber wie LawinServer mit allen Versionen.

## Woher es kommt

Der Kern ist [LawinServer](https://github.com/Lawin0129/LawinServer) von **Lawin0129** (mit
PRO100KatYT), lizenziert unter der **GPL-3.0**. Er liegt fast unverändert im Ordner `lawinserver/`.
Jede Änderung ist im Code mit `// VANITY:` markiert und in
[`lawinserver/VANITY_CHANGES.md`](lawinserver/VANITY_CHANGES.md) aufgelistet. Danke an Lawin für die Arbeit!

Von Vanity selbst kommt nur `src/` (TypeScript): Einstellungen aus Umgebungsvariablen, die
`/vanity`-Endpunkte, das Logging und der Start.

## Ordner

```
backend/
  src/              unser Code (main.ts = Einstieg)
  lawinserver/      LawinServer (GPL-3.0) + VANITY_CHANGES.md
  scripts/build.mjs baut dist/
  test/smoke.mjs    Test: startet den Server und spielt einen 19.10-Client nach
  dist/             fertiges Backend (wird gebaut, nicht im Git)
```

## Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `VANITY_BACKEND_PORT` | `3551` | HTTP-Port für alle Anfragen des Spiels und `/vanity/*` |
| `VANITY_MATCHMAKER_PORT` | `80` | Port für Matchmaker und XMPP (WebSocket) |
| `VANITY_BIND` | `127.0.0.1` | `0.0.0.0`, wenn andere im Netzwerk zugreifen sollen |
| `VANITY_DATA_DIR` | `%LOCALAPPDATA%\Vanity\backend` (Linux/macOS: `~/.vanity/backend`) | hier landet alles, was sich ändert |
| `VANITY_GAMESERVER` | `127.0.0.1:7777` | wohin der Matchmaker die Spieler schickt (`ip:port`) |

Ist eine Variable ungültig (z. B. Port `abc`), bricht das Backend mit einer Meldung und Exit-Code 1 ab.
Das gilt auch, wenn der HTTP-Port schon belegt ist. Ist nur der Matchmaker-Port belegt, läuft das
Backend weiter und schreibt `XMPP and Matchmaker FAILED to start hosting. (port 80: EADDRINUSE)`.

## Daten-Ordner

Beim ersten Start kopiert das Backend die Standard-Daten in den Daten-Ordner:

- `profiles/` – Spind, Items, V-Bucks (das, was sich im Spiel ändert)
- `Config/` – `config.ini` und `catalog_config.json` (Shop) zum selbst Anpassen
- `responses/friendslist*.json`, `responses/privacy.json`, `responses/Athena/SeasonData.json`
- `ClientSettings/` – Spiel-Einstellungen (`ClientSettings-<Build>.Sav`)

Vorhandene Dateien werden nie überschrieben. Wer neu anfangen will, löscht den Ordner.
Alles andere (Shop-Daten, News, Bilder, Hotfixes) wird nur gelesen und bleibt neben `main.js`.

## Eigene Endpunkte

| Methode + Pfad | Wer darf | Antwort |
|---|---|---|
| `GET /vanity/health` | alle | `{ "ok": true, "version": "0.1.0" }` |
| `GET /vanity/status` | alle | `{ "name", "hosting", "playlist", "players", "maxPlayers", "version", "gameServer": { "ip", "port" } }` |
| `POST /vanity/status` | nur 127.0.0.1 / ::1 | setzt einzelne Felder von oben, antwortet mit dem neuen Status |
| `POST /vanity/gameserver` | nur 127.0.0.1 / ::1 | `{ "ip": "100.101.12.7", "port": 7777 }` – Matchmaker-Ziel sofort ändern |

- Anfragen von anderen Rechnern auf die POST-Endpunkte bekommen `403`.
- POST nur mit `Content-Type: application/json` (sonst `415`) – so kann keine fremde Webseite im
  Browser das Ziel umstellen.
- Falsche Werte → `400` mit `{ "ok": false, "error": "…" }`.
- `version` im Status ist die Fortnite-Version des gehosteten Spiels (setzt der Launcher, Standard leer).
- `gameServer` im Status ist immer das aktuelle Matchmaker-Ziel. `POST /vanity/status` darf es
  ebenfalls setzen (`"gameServer": { "ip", "port" }` oder `"ip:port"`).
- Bei `POST /vanity/gameserver` ist `port` optional (Standard `7777`).

Jede Anfrage steht als eine Zeile auf stdout, z. B. `[HTTP] GET /vanity/health → 200`
(ohne `?…`; bricht der Client vorher ab: `→ abgebrochen`). Eigene Meldungen beginnen mit `[Vanity]`.

## Bauen, testen, starten

Voraussetzungen: Node 22 und pnpm 10.

```sh
cd backend
pnpm install
pnpm build      # Typen prüfen (tsc) + dist/ bauen
pnpm test       # Smoke-Test gegen dist/main.js
pnpm start      # node dist/main.js
```

`pnpm build` erzeugt `dist/main.js` (eine Datei, alle npm-Pakete eingebaut – zur Laufzeit braucht
es kein `node_modules`) und kopiert die Daten daneben (`profiles/`, `responses/`, `CloudStorage/`,
`Config/`, `public/`). Dazu kommen `LICENSE` und `THIRD_PARTY_LICENSES.txt`. Der ganze `dist/`-Ordner
ist das fertige Backend; `main.js` findet seine Daten immer neben sich, egal aus welchem Ordner es
gestartet wird.

Der Test startet das Backend auf freien Ports mit einem leeren Temp-Daten-Ordner und prüft Login,
Profile, Spind speichern (auch nach Neustart), Einstellungen, Content-Pages, Hotfixes, Matchmaking
mit WebSocket, XMPP, die `/vanity`-Endpunkte und die `403` für Zugriffe aus dem Netzwerk.

So startet der Launcher das Backend (Ordner `dist/` als `<ressourcen>/backend/`):

```
node.exe <ressourcen>/backend/main.js
```

mit den Umgebungsvariablen von oben und dem Daten-Ordner als Arbeitsordner.
