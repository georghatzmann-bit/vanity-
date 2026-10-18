# HELIX – Aufbau für Entwickler

HELIX ist eine Electron-App (Windows). Hauptprozess = Node.js (Dateien, Windows-Befehle),
Oberfläche = HTML/CSS/JS ohne Framework. Alles bleibt lokal auf dem PC.

## Grenzen (gelten für jede Zeile Code)

- Nur lokale Dateien und normale Windows-Funktionen (reg.exe, tasklist, taskkill, powercfg, PowerShell/CIM, nvidia-smi).
- **Nie**: Spielspeicher lesen/ändern, Anti-Cheat anfassen, Hardware-IDs, IP-Wechsel, Spoofing, Sperren umgehen,
  Login-Daten/Tokens/Cookies, Dateien des Epic Games Launchers kopieren, Overlays im Spiel, Prozesse des Spiels beeinflussen
  (Priorität, Affinität, Injektion …).
- Kein Administrator nötig. Registry-Schreibzugriffe nur unter HKCU.
- Animationen kommen als fertige Higgsfield-Clips/-Bilder (`src/renderer/assets`). Im Code nur schlichte Übergänge (≤ 200 ms).

## Ordner

```
src/main/main.js                 Fenster, Module laden, IPC
src/main/router.js               "modul.aktion" -> Handler, Fehler -> { ok:false, error:{code,message} }
src/main/core/*                  Hauptfunktion Settings-Profile (Scan, Profile, Backups, Anwenden, Cloud-Wächter)
src/main/sys/exec.js             run(), powershell(), powershellStream(), HelixError, IS_WIN
src/main/sys/processes.js        listProcesses(), closeByName(), closeByPid(), parseTasklist()
src/main/sys/registry.js         readKey(), readValue(), writeValue() (nur HKCU), parseRegQuery()
src/main/modules/core.js         IPC der Hauptfunktion (core.*, profiles.*, backups.*)
src/main/modules/app.js          app.settings, app.setSettings, app.openWindowsSettings, app.openUrl
src/main/modules/tools/<id>.js   je Tool ein Modul (wird automatisch geladen)
src/renderer/index.html          Grundgerüst
src/renderer/js/app.js           Start, Intro, Navigation, Statusleiste
src/renderer/js/cockpit.js       Cockpit mit Kern und Planeten
src/renderer/js/ui.js            Bausteine (h, icon, button, toggle, modal, toast, …)
src/renderer/js/views/<id>.js    je Tool eine Ansicht
src/renderer/js/mock/<id>.js     Simulator-Daten je Tool (nur Browser-Vorschau)
src/renderer/css/helix.css       gemeinsames Design
src/renderer/css/tools/<id>.css  optionales Tool-Stylesheet (wird automatisch geladen)
test/*.test.js, test/tools/*.test.js   Unit-Tests (node --test)
```

## Ein Tool bauen

### 1. Hauptprozess: `src/main/modules/tools/<id>.js`

```js
'use strict';
const { HelixError } = require('../../sys/exec');

module.exports = {
  id: '<id>',                    // gleich wie in src/renderer/js/tools.js
  async init(ctx) {},            // optional, beim Programmstart
  dispose(ctx) {},               // optional, beim Beenden
  handlers: {
    // Aufruf aus der Oberfläche: env.call('<id>.summary')
    async summary(args, ctx) { return { text: 'Kurzinfo fürs Cockpit' }; }, // optional, sonst null
    async doSomething(args, ctx) { ... return data; },
  },
};
```

Handler-Namen: camelCase, nur Buchstaben/Ziffern. Rückgabe = JSON-fähige Daten.
Fehler: `throw new HelixError('CODE', 'Verständliche deutsche Meldung')`.
Nicht-Windows: Funktionen aus `sys/*` werfen `HelixError('NOT_WINDOWS', …)` – die Ansicht zeigt dann eine Erklärung.

**ctx** (gemeinsamer Kontext):

| Feld | Inhalt |
|---|---|
| `ctx.dataDir` | HELIX-Datenordner |
| `ctx.env` | Umgebungsvariablen (LOCALAPPDATA, TEMP, USERPROFILE, ProgramData …) – **keine festen Pfade** |
| `ctx.core` | CoreService: `readState(name, fallback)`, `writeState(name, obj)`, `fortniteStatus()`, `ensureFortniteClosed()`, `onFortniteState(cb)`, `location` ({found, configDir, savedDir}), `requireLocation()`, `readIniValues(file, [{section,key}])`, `previewIniChanges(file, [{section,key,value}])`, `applyIniChanges(file, changes, {reason:'tool', label})` (macht Backup, behält Schreibschutz) |
| `ctx.sessions` | Spielzeit-Zähler: `summary({days})` |
| `ctx.emit(name, payload)` | Ereignis an die Oberfläche (`env.on(name, cb)`) |
| `ctx.log(level, ...)` | Protokoll |
| `ctx.exec` | `{ run(file,args,opts), powershell(script,{json,timeout}), powershellStream(script,onObj,onExit), HelixError, IS_WIN }` |
| `ctx.processes`, `ctx.registry` | siehe sys/ |
| `ctx.electron` | `{ app, dialog, shell, screen, getWindow }` |
| `ctx.toolDir(id)` | eigener Ordner für Tool-Dateien |

Eigene Daten: `ctx.core.readState('tool-<id>', {})` / `ctx.core.writeState('tool-<id>', obj)`.

Logik, die man testen kann (Parser, Berechnungen, Empfehlungen), gehört in reine Funktionen
(z. B. `src/main/tools/<id>-logic.js` oder im Modul exportiert) und bekommt Tests in `test/tools/<id>.test.js`.

### 2. Oberfläche: `src/renderer/js/views/<id>.js`

```js
export default {
  async mount(root, env) { /* root = leerer Inhaltsbereich unter dem Tool-Kopf */ },
  unmount() { /* Timer stoppen, Listener abmelden */ },
};
```

`env.call(channel, args)` (wirft Error mit `.code`), `env.on(event, cb)` (gibt Abmeldefunktion zurück),
`env.ui` = { h, icon, button, toggle, toast, showError, modal, confirmDialog, promptDialog, fmtBytes, fmtDate, fmtAgo,
fmtDuration, emptyState, section, badge, spinner, clear, mount }, `env.nav.go(id)`, `env.refreshStatus()`.

Texte: **einfaches Deutsch**, kurze Sätze, Fachwörter erklären. Jede Option bekommt eine graue Erklärungszeile (`.hint`).
Leere Zustände gestalten (`ui.emptyState`). Nach jeder Aktion kurze Rückmeldung (`ui.toast`).
Status nie nur über Farbe – immer Text dazu (`ui.badge('gut', 'ok')`).
Nie `innerHTML` mit Daten. `h()` setzt Text sicher.

Vorhandene CSS-Klassen: `.glass .block .toolbar .row .callout(.ok/.warn/.err/.info) .stat-row .stat .list .table-wrap .table
.kv .segmented .seg .radio-list .radio .field .input .range .badge .btn(.primary/.ghost/.danger/.small) .hint .mono .grow`.
Tool-eigenes CSS in `src/renderer/css/tools/<id>.css`, alle Regeln mit `[data-tool="<id>"]` beginnen.
Design: dunkel, eine Akzentfarbe `var(--accent)` (Cyan), Grün/Orange/Rot nur für Status, Abstände 4/8/12/16/24/32,
Ecken 6–10 px, Übergänge ≤ 200 ms, keine Emojis als Icons.

### 3. Simulator: `src/renderer/js/mock/<id>.js`

```js
export default {
  async summary() { return { text: '…' }; },
  async doSomething(args, mctx) { await mctx.wait(300); return { /* realistische Beispieldaten */ }; },
};
```

### 4. Prüfen

```
npm test                                   # alle Unit-Tests
node scripts/preview-server.mjs &          # Vorschau mit Simulator
node scripts/shoot.mjs test-results/shots <id>   # Bildschirmfoto -> PNG ansehen
```
