# Änderungen von Vanity an LawinServer

Quelle: <https://github.com/Lawin0129/LawinServer>, Commit `70414917f57187cba1f22190f696f3a4ffbcd058`
(16.10.2026, „Added the new Grave Feather hero and new questline“). Lizenz: GPL-3.0, siehe `LICENSE`.
Autoren: Lawin0129 (Lawin) und PRO100KatYT.

Jede Änderung im Code ist mit `// VANITY:` markiert (in `config.ini` mit `# VANITY:`).
Bei mehrzeiligen Blöcken steht die Markierung in der Kommentarzeile darüber.

## Nicht übernommen

| Datei | Grund |
|---|---|
| `package.json`, `package-lock.json` | Abhängigkeiten stehen in `backend/package.json` (feste Versionen, pnpm). Das Paket `path` (npm-Nachbau des Node-Moduls) entfällt, Node nimmt ohnehin sein eingebautes `path`. |
| `start.bat`, `install_packages.bat` | LawinServer wird nicht mehr allein gestartet, sondern über `backend/src/main.ts`. |
| `.gitignore`, `.git/` | nicht nötig |

## Neue Datei

**`structure/vanity.js`** – zentrale Stelle für Pfade, Ports und Game-Server-Ziel:

- `configure()` – setzt Ressourcen-Ordner, Daten-Ordner, Bind-Adresse, Matchmaker-Port, Game-Server-Ziel
  (aufgerufen von `src/main.ts`, bevor ein anderes LawinServer-Modul geladen wird).
- `file(rel)` – absoluter Pfad. Beschreibbare Pfade (`WRITABLE`: `profiles/`, `Config/`, `ClientSettings/`,
  `responses/friendslist.json`, `responses/friendslist2.json`, `responses/privacy.json`,
  `responses/Athena/SeasonData.json`) liegen im Daten-Ordner, alles andere im Ressourcen-Ordner
  (neben `dist/main.js`). Pfade mit `..` werden abgelehnt.
- `json(rel)` – Ersatz für `require("./../<rel>.json")`, gleiches Verhalten (einmal lesen, danach dasselbe Objekt).
- `writeFile(rel, data)` – Ersatz für `fs.writeFileSync("./<rel>", data)`; schreibt über eine Temp-Datei
  und benennt sie um, damit ein Abbruch keine halbe `athena.json` hinterlässt.
- `isSafeName(name)` – prüft Profil- und Dateinamen aus Anfragen.

## Geänderte Dateien

### Alle Dateien in `structure/` mit Datenzugriff (mechanisch, gleiche Art von Änderung)

`affiliate.js`, `cloudstorage.js`, `contentpages.js`, `discovery.js`, `friends.js`, `functions.js`,
`main.js`, `matchmaking.js`, `mcp.js`, `privacy.js`, `storefront.js`, `timeline.js`, `user.js`

- `const vanity = require("./vanity.js");` am Dateianfang.
- `require("./../profiles|responses|Config/….json")` → `vanity.json("…")`
- `fs.writeFileSync("./profiles|responses/…", …)` → `vanity.writeFile("…", …)`
- `fs.readdirSync("./profiles")` → `fs.readdirSync(vanity.file("profiles"))`
- `path.join(__dirname, "..", "Config", "config.ini")` (und ähnliche) → `vanity.file("Config/config.ini")`

**Warum:** LawinServer las Daten relativ zum Modul-Ordner und schrieb relativ zum Arbeitsordner.
Vanity packt alles mit esbuild in eine Datei (`dist/main.js`) – dort würde `require` die JSON-Dateien
fest einbauen (Profile könnten nie neu geladen werden) und `__dirname` zeigte auf den falschen Ordner.
Außerdem müssen alle geschriebenen Daten im Daten-Ordner (`VANITY_DATA_DIR`) landen, nicht im
Programm-Ordner.

### `index.js`

- App-Aufbau in die Funktion `createApp()` verschoben, Export `module.exports = { createApp }`.
  **Warum:** `src/main.ts` hängt die LawinServer-App hinter die eigenen `/vanity`-Endpunkte und das Logging.
- `Express.static('public')` → `Express.static(vanity.file("public"))`. **Warum:** unabhängig vom Arbeitsordner.
- `express.listen(…)`, Start von `xmpp.js` und das Anlegen von `%LOCALAPPDATA%\LawinServer` entfernt.
  **Warum:** macht jetzt `src/main.ts` (Port/Bind aus Umgebungsvariablen, Exit-Code 1 statt 0 bei belegtem Port,
  Daten-Ordner statt `%LOCALAPPDATA%\LawinServer`).

### `structure/xmpp.js`

- Port `80` → `vanity.settings.matchmakerPort` (`VANITY_MATCHMAKER_PORT`), Bind-Adresse `vanity.settings.bindAddress` (`VANITY_BIND`).
  **Warum:** Port änderbar, und standardmäßig nur auf 127.0.0.1 statt auf allen Netzwerkkarten.
- Fehlermeldung beim Start nennt Port und Grund (z. B. `EADDRINUSE`).

### `structure/matchmaking.js`

- `serviceUrl`: `ws://127.0.0.1` → `ws://127.0.0.1:<VANITY_MATCHMAKER_PORT>` (ohne Port, wenn 80).
- `serverAddress`/`serverPort`: aus `vanity.settings.gameServer` (`VANITY_GAMESERVER`, zur Laufzeit änderbar
  über `POST /vanity/gameserver`) statt aus `config.ini` `[GameServer]`.

### `structure/cloudstorage.js`

- `CloudStorage/` aus dem Ressourcen-Ordner; Dateiname aus der URL wird mit `isSafeName` geprüft.
  **Warum:** vorher konnte `GET /fortnite/api/cloudstorage/system/..%2F..%2F<pfad>` beliebige Dateien lesen
  (wichtig, sobald das Backend mit `VANITY_BIND=0.0.0.0` im Netzwerk erreichbar ist).
- `ClientSettings-<CL>.Sav` im Daten-Ordner (`ClientSettings/`) statt `%LOCALAPPDATA%\LawinServer\ClientSettings`.
- `DefaultEngine.ini`: `ServerPort=80` (XMPP) wird beim Ausliefern durch `VANITY_MATCHMAKER_PORT` ersetzt,
  wenn der Port nicht 80 ist. Die Datei selbst bleibt unverändert.

### `structure/mcp.js`

- Zusätzlich zur mechanischen Änderung: `profileId` aus der Anfrage muss ein einfacher Name sein
  (`isSafeName`), sonst `400`. **Warum:** `profileId` wird Teil eines Dateipfads (vorher z. B.
  `profileId=../../x` → Lesen/Schreiben außerhalb von `profiles/`).
- `DailyQuestPath` (für `FortRerollDailyQuest`) nutzt `vanity.json` statt `require`.

### `Config/config.ini`

- Hinweis im Abschnitt `[GameServer]`: `ip`/`port` werden von Vanity nicht benutzt
  (Ziel kommt aus `VANITY_GAMESERVER` / `POST /vanity/gameserver`).

## Unverändert

`structure/lightswitch.js`, `structure/matchmaker.js`, `structure/party.js`, `structure/version.js`,
alle Daten in `profiles/`, `responses/`, `CloudStorage/`, `public/`, `Config/catalog_config.json`, `README.md`, `LICENSE`.
Anzeigename wie bei LawinServer: E-Mail beim Login → Name vor dem `@` (`georg@vanity.local` → `georg`).

## Bekannt, aber nicht geändert

- Das Backend selbst baut keine Verbindung nach außen auf (kein `http(s).request`, `fetch` o. Ä. im Code).
  Die Antwort-Daten (`responses/*.json`, `structure/functions.js`) enthalten aber URLs, die das **Spiel**
  aufrufen könnte: rund 2300 Bild-URLs auf `cdn2.unrealengine.com` (Shop, News, Lobby-Hintergründe) und
  einige `*.ol.epicgames.com`/`api.epicgames.dev`-Adressen (z. B. in `sdkv1.json`). Das Backend ruft
  sie selbst nie auf; es sind nur Daten aus LawinServer.
- Das Backend kennt nur ein Profil für alle (wie LawinServer). Mit `VANITY_BIND=0.0.0.0` teilen sich alle
  Spieler im Netzwerk denselben Spind.

## Schutz vor Abstürzen (Oktober 2026)

- `structure/storefront.js`: `req.headers["user-agent"]` kann fehlen (Werkzeuge, Tests) – jetzt `(… || "")`.
- `structure/matchmaking.js`: `req.query.bucketId` kann fehlen – jetzt `String(… || "")`.

Beide Stellen sind mit `// VANITY:` markiert. Grund: Ohne diese Prüfungen antwortete das Backend mit 500.
