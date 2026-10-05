# BuildDuel – Bauplan (für Entwickler)

Dieses Dokument ist der **Vertrag** zwischen allen Teilen des Spiels. Wer an einem
Teil arbeitet, hält sich an die hier beschriebenen Namen, Formen und Abläufe. Wer
etwas daran ändern MUSS, ändert es hier mit und schreibt kurz dazu, warum.

Die Spielidee und alle Zahlen stehen in `README.md` bzw. `src/config.js`.

---

## 1. Grundregeln

- Reines HTML + JavaScript (ES-Module), Three.js liegt in `lib/` (Import `'three'`).
  Kein Build-Tool, keine weiteren Bibliotheken. Alles läuft offline.
- **Alle Spielwerte** stehen in `src/config.js`. Neue Zahlen kommen dorthin (geschätzte
  Werte mit `// SCHÄTZUNG`). Im Code keine "magischen Zahlen" für Spielregeln.
- **Kommentare auf Deutsch**, einfach und kurz. Bezeichner (Variablen, Funktionen) Englisch.
- Keine Original-Inhalte von 1v1.LOL oder Fortnite (Namen, Grafiken, Töne, Texte).
- Leistung: 60 FPS auf normalem Laptop. In Funktionen, die jeden Tick laufen, keine
  neuen Objekte anlegen (Vektoren wiederverwenden). Bauteile per `InstancedMesh`.
- Jedes Modul, das Spiel-Logik enthält, muss **ohne Bildschirm** laufen können
  (`headless`): Tests erzeugen ein `Game` ohne Renderer und simulieren es.
- Texte für den Spieler: Deutsch, freundlich, kurz.

## 2. Koordinaten und Einheiten

- 1 Einheit = 1 Meter. **Y zeigt nach oben.** Boden (flache Karte) bei y = 0.
- `yaw` (Drehung links/rechts, Radiant): 0 = Blick nach **−Z**. Positiver yaw = nach links drehen.
  - vorwärts = `(-sin(yaw), 0, -cos(yaw))`, rechts = `(cos(yaw), 0, -sin(yaw))`
  - Maus nach rechts → yaw wird kleiner.
- `pitch` (hoch/runter, Radiant): 0 = waagerecht, positiv = nach oben schauen.
  Grenzen aus `CONFIG.camera.minPitch/maxPitch` (Grad).
- `character.position` = Mitte der **Füße** (Unterkante der Hitbox).
- Himmelsrichtungen für Bauen (`dir`): 0 = +X, 1 = +Z, 2 = −X, 3 = −Z.

## 3. Bau-Raster (Grid)

Zellgröße `S = CONFIG.world.gridCellSize` (4 m), Höhe `H = CONFIG.world.wallHeight` (4 m).
Zelle `(i, j, k)` umfasst `x ∈ [i·S, (i+1)·S]`, `y ∈ [j·H, (j+1)·H]`, `z ∈ [k·S, (k+1)·S]`.

Plätze ("Slots") und ihre Schlüssel (Strings, eindeutig):

| Bauteil | Schlüssel | Lage |
|---|---|---|
| Boden | `f:i:j:k` | waagerechte Platte, Oberkante bei `y = j·H` (+ halbe Dicke), über der ganzen Zelle |
| Wand (Ebene z = k·S) | `wx:i:j:k` | senkrecht, verläuft entlang X von `i·S` bis `(i+1)·S`, Höhe `j·H…(j+1)·H` |
| Wand (Ebene x = i·S) | `wz:i:j:k` | senkrecht, verläuft entlang Z von `k·S` bis `(k+1)·S` |
| Rampe | `r:i:j:k` | in der Zelle, steigt in Richtung `dir` von `y = j·H` auf `(j+1)·H` (45°) |
| Dach (Pyramide) | `c:i:j:k` | in der Zelle, Grundfläche bei `y = j·H`, Spitze `CONFIG.building.roofHeight` darüber |

- Eine Zelle hat 4 Wände: `wx:i:j:k` (Nordseite, z = k·S), `wx:i:j:k+1` (Südseite),
  `wz:i:j:k` (Westseite, x = i·S), `wz:i+1:j:k` (Ostseite). Nachbarzellen teilen sich Wände.
- Boden, Rampe und Dach derselben Zelle dürfen gleichzeitig existieren (eigene Slots).
- Eine "Box" = 4 Wände in Ebene j + Dach `c:i:j+1:k` (sitzt oben auf den Wänden) + optional Boden `f:i:j:k`.
- Hilfsfunktionen dafür liefert `src/building/grid.js` (reine Mathematik, testbar).

## 4. Module und ihre Aufgaben

```
src/
  main.js              Start: Renderer, Menüs, startet/beendet Matches
  config.js            alle Werte
  loop.js              feste Spiel-Uhr (60 Hz)
  core/
    game.js            Game: hält Welt, Figuren, Systeme; fixedUpdate / frameUpdate
    events.js          EventBus (on/off/emit)
    settings.js        Einstellungen laden/speichern (localStorage), Standardwerte aus CONFIG
    progress.js        Fortschritt (Pokale, Münzen, Pass, freigeschaltete Farbsets)
    damage.js          reine Schadens-Rechnung (Schild zuerst, Kopf, Abfall, Seltenheit)
  input.js             Tastatur/Maus/Pointer Lock/Controller/Touch → Aktionen pro Tick
  playerController.js  macht aus Aktionen + Kamera einen CharacterCommand für den Spieler
  player.js            Character (Daten) + Bewegung (laufen, springen, ducken, Rampen, Fallschaden, Gleiter)
  physics.js           CollisionWorld: Boxen, Schrägen, Gelände, Raumgitter, Strahltests
  camera.js            Schulter-Kamera (mit Wand-Kollision) + Vorschau-Kamera
  building/            grid.js, pieces.js, structure.js, edit.js
  weapons/             weapons.js, hitscan.js, projectiles.js
  ai/bot.js            Bot-Gehirn → CharacterCommand
  modes/               index.js (Liste), practice.js, duel.js, battleRoyale.js, boxFight.js,
                       zoneWars.js, justBuild.js, aimTrainer.js, deathmatch.js
  world/               environment.js, characterModel.js, mapArena.js, mapIsland.js,
                       mapZoneWars.js, loot.js, storm.js, effects.js, referenceObjects.js
  ui/                  hud.js, menus.js, settings.js (Einstellungs-Fenster), killfeed.js,
                       minimap.js, touch.js, fpsMeter.js, styles.css
  audio/sfx.js         erzeugte Töne (Web Audio)
  util/random.js       Zufall mit Startwert
```

## 5. Game (src/core/game.js)

```js
const game = new Game({
  scene,          // THREE.Scene (auch headless vorhanden, wird nur nicht gemalt)
  camera,         // THREE.PerspectiveCamera oder null (headless)
  settings,       // aus core/settings.js
  headless,       // true = keine HUD/Audio/DOM-Effekte
  seed,           // Zufall
});
```

Felder (öffentlich, andere Module dürfen lesen):
- `config` (CONFIG), `settings`, `events` (EventBus), `rng` (Funktion 0..1), `headless`
- `scene`, `world` (CollisionWorld), `time` (simulierte Sekunden), `tick` (Zähler)
- `characters` (Array von Character), `player` (Character des Menschen oder `null`)
- `building` (Bau-System), `weapons` (Waffen-System), `projectiles`, `effects`, `audio`, `hud`
- `mode` (aktueller Modus) und `map` (aktuelle Karte), `storm` (oder null), `loot` (oder null)
- `systems` (Array von Objekten mit `update(dt, game)` – laufen am Ende jedes Ticks)

Methoden:
- `addCharacter(options) → Character` / `removeCharacter(character)`
- `fixedUpdate(dt)` – ein Logik-Schritt (1/60 s), Reihenfolge siehe unten
- `frameUpdate(frameSeconds, alpha)` – Bild: Figuren-Modelle (interpoliert), Kamera, Effekte, HUD
- `simulate(seconds)` – ruft `fixedUpdate` so oft wie nötig (für Tests, ohne Bild)
- `dispose()` – alles aufräumen (Szene leeren, Ereignisse abmelden)

**Reihenfolge in `fixedUpdate(dt)`:**
1. `mode.preUpdate(dt)`
2. Für jede lebende Figur: Befehl holen (`playerController.buildCommand(...)` bzw. `bot.think(dt)`) → `character.command`
3. Auswahl anwenden (`character.applySelection(command)`: Waffenplatz, Bauteil, Spitzhacke, Edit)
4. Bewegung: `moveCharacter(character, command, dt, world)` (player.js)
5. `building.updateCharacter(character, command, dt)` und `weapons.updateCharacter(character, command, dt)`
6. `projectiles.update(dt)`, `building.update(dt)` (Aufbau, Einsturz), `storm?.update(dt)`, `loot?.update(dt)`
7. `mode.update(dt)`, dann alle `systems[i].update(dt, game)`
8. `time += dt; tick++`

## 6. Character (src/player.js)

Eine Klasse für Spieler UND Bots. Wichtige Felder:

```js
character.id, name, team, isBot, isPlayer, skin { body, accent, hat }
character.position, prevPosition, velocity   // THREE.Vector3
character.yaw, pitch, prevYaw
character.health, shield, alive
character.grounded, crouching, sprinting, aiming
character.moveState   // 'ground' | 'air' | 'freefall' | 'glide'
character.mode        // 'weapon' | 'pickaxe' | 'build' | 'edit'
character.slots       // Array(5): Gegenstand oder null (siehe weapons)
character.selectedSlot
character.buildPiece  // 'wall' | 'floor' | 'ramp' | 'roof'
character.buildRotation // 0..3 (Zusatz-Drehung für Rampen)
character.materials   // { wood, stone, metal }
character.currentMaterial // 'wood' | 'stone' | 'metal'
character.infiniteMaterials // bool (Freies Bauen)
character.stats       // { kills, damageDealt, damageTaken, shotsFired, shotsHit, headshots, piecesBuilt }
character.invulnerableUntil // game.time, bis zu dem kein Schaden ankommt
character.command     // CharacterCommand dieses Ticks
character.brain       // Bot-Gehirn oder null
character.view        // Grafik (characterModel) oder null (headless)
```

Methoden:
- `applyDamage(amount, info)` → `{ shieldDamage, healthDamage, killed }` – Schild zuerst.
  `info = { attacker, weaponId, head, point, kind: 'bullet'|'explosion'|'fall'|'storm'|'melee' }`.
  Sendet `characterDamaged`, bei Tod `characterKilled`.
- `heal(kind, amount, maxTo)` – kind `'health'|'shield'`.
- `eyePosition(out)` – Augenhöhe (stehend 1,6 m, geduckt weniger).
- `forward(out)`, `aimDirection(out)` (mit pitch).
- `resetForRound(options)` – Leben/Schild/Munition/Material zurücksetzen.

### CharacterCommand (Befehl pro Tick)

```js
{
  moveX, moveZ,        // -1..1, im Blick-Koordinatensystem (x rechts, z vorwärts)
  yaw, pitch,          // absolute Blickrichtung (Radiant)
  jump, jumpPressed,   // gehalten / gerade gedrückt
  crouch, sprint,      // gehalten bzw. Umschalt-Zustand schon eingerechnet
  primary, primaryPressed, primaryReleased,   // schießen / bauen
  secondary, secondaryPressed,                // zielen / Edit zurücksetzen
  selectSlot,          // 1..5 oder 0 (= nichts)
  selectPickaxe,       // bool
  selectBuild,         // 'wall'|'floor'|'ramp'|'roof'|null
  toggleBuild,         // bool (Controller: Baumodus an/aus)
  reloadOrRotate, editPressed, editReleased, usePressed, emotePressed,
  switchMaterial, nextItem, prevItem,
  aimOrigin, aimDir    // Ziel-Strahl in der Welt (Spieler: Kamera-Mitte; Bot: Auge → Ziel)
}
```

`createCommand()` liefert ein leeres Objekt mit allen Feldern (wiederverwenden!).

## 7. CollisionWorld (src/physics.js)

```js
world.terrain                 // { heightAt(x, z) } – Standard: flach bei 0
world.addBox(min, max, data)  // → collider { id, type:'box', min, max, data, enabled }
world.addSlope(spec, data)    // spec { minX, maxX, minZ, maxZ, baseY, rise, dir (0..3) | 'pyramid', thickness }
world.remove(collider)
world.updateCollider(collider)  // nach Änderung der Maße
world.queryBox(min, max, out) // alle Collider, die die Box berühren
world.raycast(origin, dir, maxDist, options) // → Treffer oder null
   // options: { ignore(collider) → bool, characters: Character[] | null, ignoreCharacter }
   // Treffer: { distance, point, normal, collider, character, part ('head'|'body'), terrain }
world.surfaceHeight(x, z, maxY) // höchste begehbare Fläche ≤ maxY (Gelände, Box-Oberkanten, Schrägen)
world.boxBlocked(min, max, ignore) // bool
```

`collider.data` (frei, aber diese Felder sind vereinbart):
```js
{
  kind: 'piece' | 'static' | 'tree' | 'rock' | 'car' | 'fence' | 'chest' | 'target' | 'house',
  ref,            // Objekt dahinter (z. B. das Bauteil)
  harvest,        // 'wood' | 'stone' | 'metal' | undefined (Spitzhacke sammelt davon)
  owner,          // Character oder undefined
  blocksBullets,  // Standard true
}
```
Alles, was Schaden nehmen kann, hat am `ref` eine Methode `applyDamage(amount, info)`.

Figuren-Kollision: Figur = senkrechte Kapsel (Radius 0,4 m, Höhe 1,8 m bzw. geduckt),
für Wände als Box angenähert. Bewegung: erst X, dann Z, dann Y (je mit Aufschieben),
Stufen bis `CONFIG.player.stepHeight` werden hochgestiegen, Schrägen bis
`maxWalkableSlope` sind begehbar (Rampen 45°).

## 8. Ereignisse (EventBus, Namen und Inhalte)

| Ereignis | Inhalt |
|---|---|
| `shot` | `{ shooter, weaponId, origin, dir }` |
| `hit` | `{ attacker, target, amount, head, shield, point, killed, kind: 'character'\|'piece'\|'object' }` |
| `characterDamaged` | `{ character, attacker, amount, shieldDamage, healthDamage, head, weaponId, kind }` |
| `characterKilled` | `{ victim, killer, weaponId }` |
| `shieldBroken` | `{ character }` |
| `piecePlaced` | `{ piece, owner }` |
| `pieceDamaged` | `{ piece, amount, by }` |
| `pieceDestroyed` | `{ piece, by, collapsed }` |
| `pieceEdited` | `{ piece, owner }` |
| `doorToggled` | `{ piece, open }` |
| `reloadStart` / `reloadEnd` | `{ character, weaponId }` |
| `weaponSwitched` | `{ character, slot }` |
| `jump` / `land` | `{ character }` / `{ character, fallHeight }` |
| `footstep` | `{ character }` |
| `harvest` | `{ character, material, amount, point }` |
| `heal` | `{ character, kind, amount }` |
| `pickup` | `{ character, item }` |
| `chestOpened` | `{ chest, character }` |
| `explosion` | `{ position, radius, owner }` |
| `stormPhase` | `{ phase, state: 'wait'\|'shrink', timeLeft }` |
| `message` | `{ text, kind: 'round'\|'win'\|'lose'\|'info', duration }` (große Mitte-Nachricht) |
| `matchEnd` | `{ result }` (siehe Modi) |

## 9. Systeme mit festen Schnittstellen

- **Bauen** (`src/building/structure.js`): `createBuildingSystem(game)` →
  `{ updateCharacter(c, cmd, dt), update(dt), placePiece(type, slotKey, owner, material, options), removePiece(piece), clearAll(), pieces (Map), countFor(owner), getPieceAt(slotKey), frameUpdate(alpha) }`.
  Bauteil-Objekt: `{ id, type, slotKey, i, j, k, dir, material, owner, health, maxHealth, buildProgress, edit (Set der entfernten Felder), doorOpen, colliders[] , applyDamage() }`.
- **Waffen** (`src/weapons/weapons.js`): `createWeaponSystem(game)` →
  `{ updateCharacter(c, cmd, dt), giveLoadout(c, ids, options), createItem(id, rarity), frameUpdate(alpha) }`.
  Gegenstand im Slot: `{ id, kind: 'weapon'|'heal', rarity, ammo, reserve, count, ... }`.
- **Geschosse** (`src/weapons/projectiles.js`): `createProjectileSystem(game)` → `{ spawn(spec), update(dt), clear() }`.
- **Effekte** (`src/world/effects.js`): `createEffects(game)` → hört auf Ereignisse, `frameUpdate(dt)`.
- **Ton** (`src/audio/sfx.js`): `createAudio(game)` → hört auf Ereignisse, `setVolumes(settings)`, `frameUpdate()` (Zuhörer an Kamera).
- **HUD** (`src/ui/hud.js`): `createHud(game, root)` → `frameUpdate(dt)`, `dispose()`.
- **Bot-Gehirn** (`src/ai/bot.js`): `createBotBrain(character, game, difficulty)` → `{ think(dt) → CharacterCommand }`.
- **Sturm** (`src/world/storm.js`): `createStorm(game, spec)` → `{ update(dt), isInside(pos), center, radius, nextCenter, nextRadius, phase, state, timeLeft, damagePerSecond }`.
- **Loot** (`src/world/loot.js`): `createLootSystem(game, spec)` → `{ update(dt), dropAll(character), spawnFloorItem(...), chests }`.

Gibt es ein System (noch) nicht, liefert die Datei eine einfache Attrappe mit denselben
Methoden, die nichts tut. So läuft das Spiel in jeder Phase.

## 10. Modi (src/modes/)

`src/modes/index.js` enthält die Liste: `{ id, name, description, create(game, options) }`.

Jeder Modus:
```js
{
  id,
  start(),                 // Karte bauen, Figuren erzeugen, Ausrüstung geben
  preUpdate(dt), update(dt),
  onCharacterKilled(victim, killer),
  hudInfo(),               // { topCenter, alive, kills, zoneText, extra[] } für das HUD
  isOver,                  // bool
  result,                  // { won, placement, kills, damage, accuracy, trophies, coins, xp, title, lines[] }
  dispose(),
}
```
`options` aus dem Menü: `{ botDifficulty, teamSize (1|2), totalPlayers, roundsToWin, seed }`.

## 11. Einstellungen und Fortschritt

- `core/settings.js`: `loadSettings()`, `saveSettings(s)`, `defaultSettings()`, `resetSettings()`.
  Form: `{ controls: { keyboard: { action: [codes] }, crouchOnCtrl, crouchToggle, editOnRelease, resetEditAfterConfirm, aimAssist }, sensitivity: { x, y, aim, sniper, build, edit, invertY }, graphics: { quality, resolutionScale, viewDistance, showFps }, audio: { master, effects, music }, game: { playerName, botDifficulty, damageNumbers } }`.
- `core/progress.js`: `loadProgress()`, `saveProgress(p)`, `addMatchResult(p, result)`.
  Form: `{ trophies, coins, xp, passTier, owned: { skins: [], hats: [], pickaxes: [], emotes: [] }, equipped: { skin, hat, pickaxe, emote }, matches, wins }`.
- Schlüssel im localStorage: `buildduel.settings.v1`, `buildduel.progress.v1`. Lesen/Schreiben immer mit try/catch.

## 12. Testen

- **Einheiten-Tests** (`tests/*.test.js`, in `tests/tests.html` eingetragen): reine Logik.
- **Szenario-Tests** (`tests/scenario/*.test.js`, ebenfalls in tests.html): erzeugen ein
  `Game({ headless: true })` mit einem Modus, simulieren Sekunden und prüfen das Ergebnis
  (z. B. Turm stürzt ein, Duell endet, Zone macht Schaden).
- **Browser-Tests für Entwickler** (`tests/e2e/run.cjs`, braucht Node + Playwright, nicht für
  Spieler): startet `tools/server.py`, öffnet Spiel und Tests im echten Browser, prüft
  Konsole, macht Screenshots, steuert Spielszenen über `window.buildDuel`.
- `window.buildDuel` (Debug-Zugang im Browser): `{ game, startMode(id, options), simulate(seconds), input, CONFIG }`.
- URL-Schnellstart (für Tests/Entwicklung): `index.html?mode=duel&bots=hard&seed=1` überspringt das Menü.

## 13. Wer besitzt welche Dateien (Entwicklungs-Wellen)

Jede Welle darf nur ihre eigenen Dateien ändern. Kleine, nötige Änderungen an fremden
Dateien sind erlaubt, wenn sie eng begrenzt sind (Git führt sie zusammen); sie werden im
Abschlussbericht genannt.

| Welle | Dateien |
|---|---|
| 1 Fundament (Phase 2) | core/game.js, core/events.js, core/settings.js, input.js, playerController.js, player.js, physics.js, camera.js, world/characterModel.js, modes/index.js, modes/practice.js, main.js, Attrappen aller Systeme, tests/e2e/* |
| 2a Bauen (3+4) | building/*, Bau-Tests |
| 2b Waffen (5) | core/damage.js, weapons/*, Zielpuppen, Schadenszahlen, Waffen-Tests |
| 3a HUD + Ton + Effekte (6, 12) | ui/hud.js, ui/killfeed.js, ui/minimap.js, audio/sfx.js, world/effects.js |
| 3b Welt (9 Teil) | world/storm.js, world/loot.js, world/mapArena.js, world/mapIsland.js, world/mapZoneWars.js, Gleiter/Freifall in player.js |
| 4a Bots (7) | ai/bot.js |
| 4b Modi (8–10) | modes/* |
| 5 Menüs (11) | ui/menus.js, ui/settings.js, ui/touch.js, core/progress.js, main.js-Ablauf |
| 6 Feinschliff (12) | alles, nach Prüfung |
