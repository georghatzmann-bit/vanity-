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
  building/            grid.js, pieces.js, structure.js, edit.js, view.js (Grafik, Welle 2a)
  weapons/             weapons.js, hitscan.js, projectiles.js
  ai/bot.js            Bot-Gehirn → CharacterCommand
  modes/               index.js (Liste), practice.js, duel.js, battleRoyale.js, boxFight.js,
                       zoneWars.js, justBuild.js, aimTrainer.js, deathmatch.js
  world/               environment.js, characterModel.js, mapBuilder.js (Karten-Baukasten),
                       mapArena.js, mapIsland.js, mapZoneWars.js, loot.js, storm.js, effects.js,
                       referenceObjects.js
                       Welle 3b: terrain.js (Gelände/Rauschen), staticBatch.js (Häuser in einem Mesh),
                       props.js (Bäume/Felsen/Autos/Zäune), houses.js, spawnPoints.js, lootView.js,
                       jumpVehicle.js (Absprung-Ballon), skydive.js (Freifall/Gleiter) – siehe §11d
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
  input,          // Input (input.js) für die Spieler-Figur oder null
  renderer,       // nur für Textur-Schärfe (optional)
  uiRoot,         // HTML-Ebene für das HUD (optional)
});
```

Felder (öffentlich, andere Module dürfen lesen):
- `config` (CONFIG), `settings`, `events` (EventBus), `rng` (Funktion 0..1), `headless`
- `scene`, `world` (CollisionWorld), `time` (simulierte Sekunden), `tick` (Zähler)
- `characters` (Array von Character), `player` (Character des Menschen oder `null`)
- `building` (Bau-System), `weapons` (Waffen-System), `projectiles`, `effects`, `audio`, `hud`
- `mode` (aktueller Modus) und `map` (aktuelle Karte), `storm` (oder null), `loot` (oder null)
- `interactionPrompt` (Welle 3b): was E für den Spieler gerade tun würde – `{ text, action: 'use', kind, target,
  rarity, swap }` oder `null` (setzt loot.js jeden Tick; das HUD zeigt es an), siehe §11d
- `systems` (Array von Objekten mit `update(dt, game)` – laufen am Ende jedes Ticks)
- `root` (THREE.Group: ALLES, was das Spiel in die Szene legt, hängt hier – `dispose()` räumt es ab)
- `cameraRig` (ThirdPersonCamera, auch headless – rechnet den Ziel-Strahl), `playerController`, `input`

Methoden:
- `addCharacter(options) → Character` / `removeCharacter(character)`
- `fixedUpdate(dt)` – ein Logik-Schritt (1/60 s), Reihenfolge siehe unten
- `frameUpdate(frameSeconds, alpha)` – Bild: Figuren-Modelle (interpoliert), Kamera, Effekte, HUD; danach
  (Welle 3b) `storm.frameUpdate(dt)`, `loot.frameUpdate(dt, alpha)` und `systems[i].frameUpdate?.(dt, alpha)`
- `simulate(seconds)` – ruft `fixedUpdate` so oft wie nötig (für Tests, ohne Bild)
- `startMode(id, options)` – räumt den alten Modus ab und startet den neuen (`mode.start()`)
- `endMode()` – Figuren, Karte, Bauteile, Sturm, Loot weg
- `dispose()` – alles aufräumen (Szene leeren, Ereignisse abmelden)

`fixedUpdate(dt, sample?)`: Ohne `sample` holt das Spiel selbst `input.sample(dt)` (vorher setzt es
`input.gamepadBuildMode`, wenn der Spieler baut). Figuren ohne Gehirn (`brain: null`) bekommen
einen leeren Befehl (stehen still). `brain.think()` darf `null` liefern (= alter Befehl).

**Reihenfolge in `fixedUpdate(dt)`:**
1. `mode.preUpdate(dt)`
2. Für jede lebende Figur: Befehl holen (`playerController.buildCommand(...)` bzw. `bot.think(dt)`) → `character.command`
3. Auswahl anwenden (`character.applySelection(command)`: Waffenplatz, Bauteil, Spitzhacke, Edit)
4. Bewegung: `moveCharacter(character, command, dt, world)` (player.js)
5. erst `building.updateCharacter(character, command, dt)` für ALLE Figuren, dann
   `weapons.updateCharacter(character, command, dt)` für alle – ein Bauteil dieses Ticks hält die
   Schüsse desselben Ticks immer auf, egal in welcher Reihenfolge die Figuren in der Liste stehen
6. `projectiles.update(dt)`, `building.update(dt)` (Aufbau, Einsturz), `storm?.update(dt)`, `loot?.update(dt)`
7. `mode.update(dt)`, dann alle `systems[i].update(dt, game)`
8. `time += dt; tick++`

Nach Schritt 4 rechnet `cameraRig.fixedUpdate(player, dt, world)` den Kamera-Zustand des Ticks
(geglättete Duck-Höhe, Schulter-Abstand), danach wird der Ziel-Strahl des Spielers
(`aimOrigin/aimDir`) mit der neuen Lage neu berechnet – er liegt genau auf der Fadenkreuz-Linie,
damit Schüsse/Bauteile in Schritt 5 genau zur Kamera passen.
`frameUpdate` blendet die eigene Figur aus, wenn `cameraRig.hideCharacter` gesetzt ist (Kamera
näher als `CONFIG.camera.hideCharacterDistance` am Kopf, oder Wand rechts: Schulter-Punkt näher
als `hideCharacterSide`), und dreht sie genau mit der Kamera.

## 6. Character (src/player.js)

Eine Klasse für Spieler UND Bots. Wichtige Felder:

```js
character.id, name, team, isBot, isPlayer, skin { body, accent, hat }
character.position, prevPosition, velocity   // THREE.Vector3
character.yaw, pitch, prevYaw
character.health, shield, alive
character.grounded, crouching, sprinting, aiming
character.moveState   // 'ground' | 'air' | 'freefall' | 'glide' | 'vehicle' (Welle 3b: steht im Absprung-Ballon)
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
// seit Welle 1 zusätzlich:
character.radius, height        // aktuelle Maße der Treffer-Kapsel (geduckt kleiner)
character.prevPitch, prevStepOffset, stepOffset // für weiche Grafik (Stufen gleiten nach)
character.scopeFov    // null oder Sichtfeld (°) – Waffen setzen es beim Zielfernrohr, die Kamera nutzt es
character.speedFactor // 1 = normal (z. B. 0,5 beim Heilen)
character.emoteUntil  // Spielzeit, bis zu der die Figur tanzt (B)
character.actionKind, actionTime // Arm-Schwung in der Grafik, gesetzt mit triggerAction('build'|'attack'|…)
character.deathTime   // Spielzeit des Besiegtwerdens (Grafik kippt um)
character.lastCombatMode, modeBeforeEdit, editOpenedTick // Hilfen für Modus-Wechsel/Edit
```

Methoden:
- `applyDamage(amount, info)` → `{ shieldDamage, healthDamage, killed }` – Schild zuerst.
  `info = { attacker, weaponId, head, point, kind: 'bullet'|'explosion'|'fall'|'storm'|'melee' }`.
  Sendet `characterDamaged`, bei Tod `characterKilled`.
- `heal(kind, amount, maxTo)` – kind `'health'|'shield'`.
- `eyePosition(out)` – Augenhöhe (stehend 1,6 m, geduckt weniger).
- `forward(out)`, `aimDirection(out)` (mit pitch).
- `resetForRound(options)` – Leben/Schild/Munition/Material zurücksetzen.
  `options = { health, shield, materials, infiniteMaterials, position, yaw, invulnerableFor }`.
- `spawnAt(position, yaw, pitch)` – ohne Übergang hinsetzen (prevPosition = position).
- `applySelection(command)` – Schritt 3: Bau-Taste → sofort `'build'` mit dem Bauteil;
  Waffen-Taste/F → Baumodus verlassen (leerer Platz ändert `selectedSlot` nicht);
  G → `'edit'` nur wenn `game.building.canEdit(character)` true ist (setzt `modeBeforeEdit`,
  `editOpenedTick = game.tick`). **Bestätigen/Schließen eines Edits macht das Bau-System**
  (es soll im Tick `editOpenedTick` das G nicht gleich als Bestätigung werten). Wird während
  Edit eine andere Auswahl gedrückt, ruft applySelection `game.building.closeEdit(character)`
  (Welle 2a: das übernimmt die gewählten Felder – wie "bestätigen").
  `toggleBuild` (Controller), Mausrad (`nextItem/prevItem`: Bauteile bzw. Spitzhacke + belegte
  Plätze), Q (`switchMaterial`, nur im Baumodus), B (Tanz, nur am Boden).
  `aiming = secondary && mode === 'weapon'` (das Waffen-System darf das verfeinern).
- `applyDamage` versteht zusätzlich `info.bypassShield` und `info.ignoreInvulnerable`
  (Kill-Ebene). Fallschaden geht wie jeder Schaden zuerst auf den Schild.

Weitere Exporte von player.js: `resetCommand(cmd, yaw, pitch)`, `getSkin(id)`,
`moveCharacter(c, cmd, dt, world)`, `landCharacter(c, { noDamage })`, `bodyFits(...)`, `findSupport(...)`,
`registerMoveStateHandler(state, handler)` – **Haken für Welle 3b**: Für `moveState`
`'freefall'`/`'glide'` ruft moveCharacter `handler(character, command, dt, world)` statt der
normalen Bewegung auf; zum Landen `landCharacter(character, { noDamage: true })`.
In `'freefall'`/`'glide'` gibt es nie Fallschaden. Welle 3b meldet in `world/skydive.js` die Zustände
`'vehicle'`, `'freefall'` und `'glide'` an (siehe §11d); dazu die Felder `character.ridingVehicle` und
`character.gliderTime`.

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
  secondaryReleased, edit // seit Welle 1: rechte Taste losgelassen, G gehalten (für "Edit beim Loslassen")
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
   // Figur = Kapsel ∪ Kopf-Kugel (headCenter(ch, hitbox)): 'head' = oberste headZone der Kapsel ODER
   // die Kopf-Kugel (sichtbarer Kopf, Oberkante = Kapsel-Oberkante, geduckt crouchHeadForward vor)
   // wird getroffen, bevor der Strahl mehr als einen Kapsel-Radius durch den Körper gelaufen ist
world.surfaceHeight(x, z, maxY) // höchste begehbare Fläche ≤ maxY (Gelände, Box-Oberkanten, Schrägen)
world.boxBlocked(min, max, ignore) // bool – nur Collider (nicht das Gelände)
world.setTerrain(terrain)     // { heightAt(x, z), isFlat?, height?, maxHeight? } oder null = flach bei 0
world.clear()
```

Genauer (Welle 1):
- `raycast(origin, dir, maxDist, options, out)`: `dir` muss Länge 1 haben. Ohne `out` wird ein
  internes Ergebnis-Objekt benutzt, das beim nächsten raycast überschrieben wird (`createRayHit()`
  liefert ein eigenes). `options.skipTerrain` lässt das Gelände weg. Startet der Strahl IN einer Box
  oder Platte, zählt diese nicht. Strahlen laufen per 3D-DDA durch das Raumgitter (Zelle = 4 m).
- `queryBox(min, max, out)` liefert nur eingeschaltete Collider (`enabled`), jeden nur einmal.
  Ohne `out` ein internes Array (gültig bis zur nächsten Abfrage).
- Schrägen-Collider haben zusätzlich `kind` ('ramp'|'pyramid'), `minX/maxX/minZ/maxZ`, `baseY`,
  `rise`, `vThickness` (Dicke senkrecht gemessen) und für Rampen `a, b, c` (Höhe = a·x + b·z + c).
  Hilfen: `slopeSurfaceY(c, x, z)`, `slopeRangeOverRect(...)`, `slopeIntersectsBox(...)`,
  `boxOverlapsStrict(...)`, `createFlatTerrain(h)`.
- Sehr große Collider (über `CONFIG.physics.bigColliderCells` Zellen) liegen in einer eigenen
  Liste und werden immer geprüft.
- `collider.mesh` (optional) setzt der Karten-Baukasten für die Grafik.
- Welle 2a: `addSlope(spec)` versteht zusätzlich `spec.clip = { minX, maxX, minZ, maxZ }` – die
  Schräge wird auf dieses Rechteck zugeschnitten (gleiche Fläche/Höhe, kleinerer Umriss; jedes
  konvexe Teilstück bekommt 4 Grenz-Ebenen, `minX…maxZ` = Rechteck). So entstehen editierte
  Rampen (halbe Rampe, Eck-Rampe) und Dach-Viertel. Ohne `clip` ändert sich nichts.

`collider.data` (frei, aber diese Felder sind vereinbart):
```js
{
  kind: 'piece' | 'static' | 'tree' | 'rock' | 'car' | 'fence' | 'chest' | 'target' | 'house' | 'barrier',
  // 'barrier' (Welle 3b) = unsichtbare Karten-Grenze (blocksBullets: false, hält keine Bauteile)
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
Schrägen sind Platten: Man steht auf ihrer Oberseite (Höhe an der Figuren-Mitte), läuft
darunter durch, wenn der Kopf unter der Unterseite bleibt, und wird sonst aufgehalten.
Lange Bewegungen werden in Teilschritte zerlegt (`maxSubstepDistance`), damit man nie
durch dünne Böden/Wände rutscht. Am Boden "klebt" man bergab bis `groundSnapDistance`.

## 8. Ereignisse (EventBus, Namen und Inhalte)

| Ereignis | Inhalt |
|---|---|
| `shot` | `{ shooter, weaponId, origin, dir }` |
| `hit` | `{ attacker, target, amount, head, shield, point, killed, kind: 'character'\|'piece'\|'object' }` |
| `characterDamaged` | `{ character, attacker, amount, shieldDamage, healthDamage, head, weaponId, kind }` |
| `characterKilled` | `{ victim, killer, weaponId }` |
| `shieldBroken` | `{ character }` |
| `piecePlaced` | `{ piece, owner }` |
| `pieceDamaged` | `{ piece, amount, by }` (amount = wirklich abgezogen) |
| `pieceDestroyed` | `{ piece, by, collapsed }` |
| `pieceEdited` | `{ piece, owner }` |
| `doorToggled` | `{ piece, open }` |
| `reloadStart` / `reloadEnd` | `{ character, weaponId }` |
| `weaponSwitched` | `{ character, slot }` |
| `jump` / `land` | `{ character }` / `{ character, fallHeight }` |
| `footstep` | `{ character }` |
| `harvest` | `{ character, material, amount, point }` |
| `heal` | `{ character, kind, amount }` |
| `pickup` | `{ character, item (Boden-Gegenstand, §11d), amount }` |
| `chestOpened` | `{ chest, character }` |
| `explosion` | `{ position, radius, owner }` |
| `stormPhase` | `{ phase, state: 'wait'\|'shrink'\|'closed', timeLeft }` |
| `lootDropped` | `{ character, items }` (Welle 3b: dropAll) |
| `propDestroyed` | `{ prop, by }` (Welle 3b: Baum/Fels/Auto/Zaun zerstört) |
| `skydive` | `{ character, state: 'freefall'\|'glide' }` (Welle 3b) |
| `vehicleDrop` | `{ character, vehicle }` (Welle 3b: aus dem Ballon gesprungen) |
| `message` | `{ text, kind: 'round'\|'win'\|'lose'\|'info', duration }` (große Mitte-Nachricht) |
| `matchEnd` | `{ result }` (siehe Modi) |

## 9. Systeme mit festen Schnittstellen

- **Bauen** (`src/building/structure.js`): `createBuildingSystem(game)` →
  `{ updateCharacter(c, cmd, dt), update(dt), placePiece(type, slotKey, owner, material, options), removePiece(piece), clearAll(), pieces (Map), countFor(owner), getPieceAt(slotKey), frameUpdate(alpha) }`.
  Bauteil-Objekt: `{ id, type, slotKey, i, j, k, dir, material, owner, health, maxHealth, buildProgress, edit (Set der entfernten Felder), doorOpen, colliders[] , applyDamage() }`.
  Genaue Beschreibung (Welle 2a): siehe **§9a**.
- **Waffen** (`src/weapons/weapons.js`): `createWeaponSystem(game)` →
  `{ updateCharacter(c, cmd, dt), giveLoadout(c, ids, options), createItem(id, rarity), frameUpdate(alpha) }`.
  Gegenstand im Slot: `{ id, kind: 'weapon'|'heal', rarity, ammo, reserve, count, ... }`.
- **Geschosse** (`src/weapons/projectiles.js`): `createProjectileSystem(game)` → `{ spawn(spec), update(dt), clear() }`.
- **Effekte** (`src/world/effects.js`): `createEffects(game)` → hört auf Ereignisse, `frameUpdate(dt)`.
- **Ton** (`src/audio/sfx.js`): `createAudio(game)` → hört auf Ereignisse, `setVolumes(settings)`, `frameUpdate()` (Zuhörer an Kamera).
- **HUD** (`src/ui/hud.js`): `createHud(game, root)` → `frameUpdate(dt)`, `dispose()`.
- **Bot-Gehirn** (`src/ai/bot.js`): `createBotBrain(character, game, difficulty)` → `{ think(dt) → CharacterCommand }`.
- Zusätzlich (Welle 1): Bau-System hat `canEdit(character)` und `closeEdit(character)` (siehe §6);
  alle Systeme haben `dispose()` (Game.dispose ruft es auf).
- **Sturm** (`src/world/storm.js`): `createStorm(game, spec)` → `{ update(dt), isInside(pos), center, radius, nextCenter, nextRadius, phase, state, timeLeft, damagePerSecond }`.
- **Loot** (`src/world/loot.js`): `createLootSystem(game, spec)` → `{ update(dt), dropAll(character), spawnFloorItem(...), chests }`.
  Sturm und Loot genau beschrieben (Welle 3b): siehe **§11d**.

Gibt es ein System (noch) nicht, liefert die Datei eine einfache Attrappe mit denselben
Methoden, die nichts tut. So läuft das Spiel in jeder Phase.

## 9a. Bau-System im Detail (Welle 2a)

Dateien in `src/building/`:

| Datei | Inhalt |
|---|---|
| `grid.js` | reine Mathematik: Zellen, Slot-Schlüssel (Text `slotKey()` und Zahl `numericSlotKey()`), `parseSlotKey`, `wallSlotForSide(i,j,k,dir)`, `slotBounds`, Formen (`slotShape`, `shapesTouch`, `shapeOverlapsBox` …), Edit-Felder (`presentRects`, `tilesToMask`, `isDoorMask` …) und die **Zielwahl** `selectTarget()` |
| `pieces.js` | Kollisions-Teile je Edit (`pieceColliderSpecs`), Formen daraus (Bild = Kollision), Texturen (Holz/Stein/Metall + Risse), Edit-Kacheln, `pickTile()` (Dach: Strahl gegen die echten Pyramiden-Flächen oben/unten, `roofHitDistance`), `pieceOrigin()`, `pieceCenter()`, `pieceHealthFraction()` |
| `view.js` | Grafik (nur mit Bildschirm): InstancedMesh-Gruppen, Einzel-Meshes, Trümmer, Tür-Blatt, Vorschau, Edit-Kacheln |
| `edit.js` | Edit-Modus (Öffnen, Klicken/Ziehen, Zurücksetzen, Bestätigen) und Türen (E) |
| `structure.js` | `createBuildingSystem(game)` – Setzen, Prüfen, Aufbau, Schaden, Halt/Einsturz, Ereignisse |

**Schnittstelle** (alles aus §9 plus):
```js
building.getTarget(character, type = character.buildPiece, out?) // → Ziel (siehe unten), mit Prüfung
building.checkPlacement(type, kind, i, j, k, dir, character, options?) // → Grund oder null
building.placePiece(type, slotKey, owner, material, options)
   // options: { dir (Rampe 0..3), edit (Feld-Liste), editDir (Rampe: Richtung der halben Rampe), instant (gleich 100 %, kein Aufbau),
   //            force (ohne Halt-/Figuren-Prüfung, z. B. vorgebaute Box), charge (Material abziehen) }
   // → Bauteil oder null. Modi stellen Teile mit { instant: true } (und evtl. force) hin.
building.removePiece(piece, { by, collapsed, silent, noCollapse })   // zerstört (mit Ereignis + Halt-Prüfung)
building.getPiece(kind, i, j, k), building.getPieceAt(slotKey), building.pieces (Map)
building.setEdit(piece, mask, editDir?) // entfernte Felder als Bitmaske (0 = ganzes Teil); editDir nur Rampe
building.setDoorOpen(piece, open)       // false, wenn jemand in der Tür steht
building.canEdit(c), building.closeEdit(c)   // closeEdit ÜBERNIMMT die gewählten Felder (wie im Original)
building.editSession(c)                 // { piece, selection (Bitmaske), hover (Feld) } oder null
building.targetOf(c)                    // letztes Bau-Ziel (Vorschau) oder null
building.aimRay(c, outOrigin, outDir)   // Ziel-Strahl (Befehl, sonst Augen + Blick)
building.pieceCenter(piece, out)        // Mitte (Effekte, Töne)
building.countFor(owner), building.clearAll(), building.dispose()
building.doors, building.editedPieces   // Sets; building.view = Grafik oder null (headless)
```

**Ziel-Objekt** (`createTarget()` aus grid.js, wird wiederverwendet):
`{ type, kind, i, j, k, dir, slotKey, numKey, valid, reason, material, anchorX, anchorY, anchorZ }`,
`reason` = `'limit'` (3000 erreicht) | `'outside'` (außerhalb des Bau-Bereichs, siehe unten) |
`'occupied'` | `'material'` | `'blocked'` (Figur im Weg) | `'unsupported'` (kein Halt) | `null`.

**Bauteil-Felder** (zusätzlich zu §9): `kind` (`'f'|'wx'|'wz'|'r'|'c'`), `numKey`, `editMask`
(Bitmaske der entfernten Felder, passend zu `edit`), `editDir` (Rampe: gewählte Richtung der halben
Rampe oder `null`), `isDoor` (Getter), `doorCollider`,
`buildTime`, `placedAt`, `neighbors` (Set berührender Teile), `grounded` (berührt Gelände oder
Karten-Teile), `collapsing` (fällt gleich), `removed`, `shape` (ganze Form für Halt).
`applyDamage(amount, info)` → `{ amount, destroyed }`; `info.attacker` landet als `by` im Ereignis.
Collider-Daten: `{ kind: 'piece', ref: piece, owner, blocksBullets: true }`.

**Regeln:**
- Zielwahl (`selectTarget`): "Blick-Anker" = Punkt auf dem Blick-Strahl (von den Augen,
  `CONFIG.building.targetReach[typ]`), oder der Boden, auf den man schaut. Dessen Zelle (höchstens
  `maxPlaceCells` weg) ist das Ziel für Boden/Rampe/Dach. Ebene aus den Füßen (auf einer Rampe:
  ihre Ebene; für die Zelle davor: die Höhe, an der man sie betritt; in der Luft: Fuß-Höhe +
  `levelEpsilon`). Blick > `lookUpPitch` = eine Ebene höher, Blick über eine Kante nach unten =
  eine tiefer (Rampe dann zu einem hin). Wand: Kante der eigenen Zelle in Blickrichtung; steht davor
  eine von einem weg steigende Rampe → an deren oberes Ende. Spalte entlang der Wand = die eigene, die
  Nachbar-Spalte nur, wenn der Anker mehr als `wallColumnMargin` in ihr liegt (360° drehen = 4 eigene
  Wände). Steht vor einem schon eine Wand, kommt
  die Rampe in die eigene Zelle (der Bauende wird auf sie gehoben). Dach: über einem.
  Rampen-Richtung = Blick + `buildRotation` (R im Baumodus, `rotationSteps`).
- Setzen: Platz frei, Material (`costPerPiece`, außer `infiniteMaterials`), höchstens `maxPieces`,
  keine Figur im Weg (nur die Füße bis `player.stepHeight` dürfen drinstecken → Figur wird
  angehoben), Halt (Gelände, Karten-Teil oder berührendes Bauteil). `placeCooldown` pro Figur.
  **Wände** sind nie vom Körper blockiert: eine Figur, die in der neuen Wand steht, wird waagerecht
  zu der Seite der Wand-Ebene geschoben, auf der ihre Mitte steht (Abstand `wallPushGap`); nur wenn
  dort kein Platz ist, bleibt `'blocked'`. Boden/Rampe/Dach im Körper → `'blocked'`.
  Maus gehalten ("Turbo-Bauen"): setzt, sobald das Ziel gültig ist und `placeCooldown` um ist – auf
  einem neuen Platz oder auf demselben, wenn das Teil dort zerstört wurde.
- Bau-Bereich: höchstens Ebene `game.map.buildBounds.maxLevel` bzw. `CONFIG.building.maxLevel`;
  seitlich nur innerhalb von `game.map.buildBounds = { minX, maxX, minZ, maxZ }` (falls die Karte
  das hat; die Arena: innerhalb der Mauer, Wände direkt auf der Mauer-Linie gehen). Sonst `'outside'`.
  `placePiece(…, { force: true })` (Modi) prüft das nicht.
- Aufbau: Leben wächst von `startHealthFraction` auf 100 % in `buildTime[material]`; Schaden
  im Aufbau zählt mit. Das Teil blockiert sofort (Collider ab dem ersten Tick).
- Halt/Einsturz: Nachbarn = berührende Formen (ganze Formen, Edits ändern den Halt nicht). Wird ein
  Teil entfernt, sucht eine Breitensuche ab seinen Nachbarn ein Teil mit `grounded`; Gruppen ohne
  Halt bekommen `collapsing` und verschwinden nach `collapseDelay` (`pieceDestroyed` mit
  `collapsed: true`, Grafik: `collapseAnimTime`).
- Edit-Felder: Wand 3 x 3 (Nummer = Reihe·3 + Spalte, Reihe 0 oben, Spalte 0 = kleines x bzw. z),
  sonst 2 x 2 (Spalte entlang x, Reihe entlang z). Tür = genau `wallDoorCells` entfernt; das
  Tür-Blatt ist ein eigener Collider (offen = ausgeschaltet). Alle Felder entfernen geht nicht.
  **Rampe:** 1 Feld entfernt = **Ecktreppe** (pieces.js `rampEditSpecs`): kurze 45°-Rampe vom unteren
  Ende-Feld (das bei der ganzen Rampe tiefer lag) auf ein flaches Podest im Eck-Feld (halbe Höhe,
  gegenüber vom entfernten Feld), 90° gedreht die zweite kurze Rampe ganz hinauf. 2 Felder
  nebeneinander entfernt = **halbe Rampe** über den übrigen Streifen (2 m breit, 45°); Richtung =
  `editDir` (im Edit: vom vorletzten zum letzten gewählten Feld = "hinauf"), sonst die alte
  Richtung, wenn sie entlang des Streifens liegt, sonst 90° weiter. Sonst (1 Feld übrig, Diagonale):
  Stücke der ganzen Rampe. Edit-Kacheln/`pickTile` liegen immer auf der ganzen Rampe. Wer nach
  einem Edit in der neuen Form steckt, wird bis zu einer halben Ebene angehoben (Wand: hinausgeschoben).
  Im Tick `editOpenedTick` bestätigt G nicht. `settings.controls.editOnRelease`: Loslassen von G
  bestätigt; `resetEditAfterConfirm`: ein neuer Edit beginnt mit leerer Auswahl.
- E (`usePressed`): Tür unter dem Fadenkreuz (bis `useReach`) oder die nächste bis
  `doorNearDistance` – jede Figur darf Türen benutzen.
- Bots bauen über denselben Befehl (`selectBuild` + `primaryPressed`, Ziel-Strahl in
  `aimOrigin/aimDir`) und prüfen vorher mit `getTarget()`.
- Grafik: fertige Teile → InstancedMesh je (Form, Material, Risse); Form = Typ bzw. bei
  editierten Teilen (Art, Rampen-Richtung, Edit-Maske) – jede Edit-Form wird einmal gebaut und
  geteilt (gilt bis `clear()`); im Aufbau und Trümmer → einzelne Meshes. Risse/Dunkelheit nach
  `pieceHealthFraction(piece)` (pieces.js; im Aufbau gemessen am jetzt möglichen Leben
  `pieceHealthCap`, ein neues Teil ist also heil). Vorschau/Edit-Kacheln nur für `game.player`;
  Vorschau mit `reason === 'occupied'` = nur dünner roter Umriss (keine Fläche über dem Teil).

## 10. Modi (src/modes/)

`src/modes/index.js` enthält die Liste `MODES`: `{ id, name, description, create(game, options), hidden? }`,
dazu `getModeDef(id)` und `DEFAULT_MODE_ID` (`'practice'`, bis es ein Hauptmenü gibt).
`hidden: true` = Test-Modus für Entwickler (Welle 3b: `sandbox-island`, `sandbox-arena`, `sandbox-zonewars`
in `modes/sandbox.js`) – das Hauptmenü zeigt diese nicht an; Start über `?mode=sandbox-island`.

**Karten** (Welle 1): `createArenaMap(game, spec)` (world/mapArena.js) und allgemein
`createMapBuilder(game, name)` (world/mapBuilder.js) liefern ein Karten-Objekt:
`{ root, colliders, addBox(min, max, { color, data, kind }), addSlope(spec, { color, data, kind }),
addLabel(text, position), addObject(obj), dispose() }` – addBox/addSlope legen Kollision UND
Grafik an (headless nur Kollision). Die Arena hat zusätzlich `size`, `ground`, `contains(x, z, margin)` und
`buildBounds` (Bau-Bereich, siehe §9a; `spec.buildBounds`/`spec.maxBuildLevel` ändern ihn).
Schilder (`addLabel`) sind auf dem Bildschirm mindestens `visuals.labelMinScreenHeight` und höchstens
`labelMaxScreenHeight` Pixel hoch (`map.frameUpdate()`), näher als `labelFadeFar` verblassen sie.
Der Modus setzt `game.map = karte` und räumt sie in `dispose()` ab.
Welle 3b: Duell-Arena (`createArenaMap(game, { props: true })`), Insel (`createIslandMap`) und
Zone-Wars-Karte (`createZoneWarsMap`) mit gemeinsamen Karten-Feldern – siehe §11d.

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
- Welle 1: `loadSettings(storage?)`, `saveSettings(s, storage?)`, `resetSettings(storage?)` nehmen zum
  Testen einen Speicher-Ersatz. Gespeichertes wird über die Standardwerte gelegt; unbekannte Felder
  und falsche Typen werden ignoriert, kaputtes JSON → Standardwerte. `graphics.resolutionScale` und
  `graphics.viewDistance` sind `null` = Wert der Qualitäts-Stufe; `resolveGraphics(settings)` liefert
  die wirklich geltenden Grafik-Werte.

## 11a. Eingabe, Steuerung, Kamera, Figuren-Grafik (Welle 1)

- **Input** (`src/input.js`): `new Input(settings, { getGamepads?, now? })`, `attach(canvas)`,
  `requestPointerLock()`, `exitPointerLock()`, `applySettings(settings)`, `releaseAll()` (gehaltene
  Controller-Knöpfe zählen danach erst nach dem Loslassen wieder), `clearEdges()` (verwirft
  pressed/released, Maus-Bewegung, Mausrad – main.js ruft es beim (Weiter-)Spielen auf),
  `pollPauseButton()` (nur Start-/Pause-Bildschirm: Controller-Start neu gedrückt?),
  `sample(dt)` → `{ held, pressed, released, lookDX, lookDY, moveAxisX, moveAxisZ, lookAxisX,
  lookAxisY, wheel, device, dt }` (wiederverwendetes Objekt; Aktions-Namen = Tasten-Aktionen aus
  config.js + `sprint` + `toggleBuild`). Virtuell: `setVirtual(action, down)`, `addLook(dx, dy)`,
  `setMoveAxis(x, z)`, `setLookAxis(x, y)`. Schalter: `playing` (Spiel-Tasten blockieren),
  `gamepadBuildMode`, `allowMouseWithoutLock`, `lookWithoutLock` (Notlösung ohne Maus-Sperre).
  Rückrufe: `onLockChange(locked)`, `onLockError(err)`. Die Aktion `pause` (Esc, Controller-Start)
  pausiert in main.js.
  `peekLook(out)` = noch nicht abgeholte Maus-Bewegung (Kamera zeigt sie sofort).
- **Spieler-Steuerung** (`src/playerController.js`): `createPlayerController()` →
  `{ buildCommand(sample, character, cameraRig, settings, game), reset() }`. Hilfen:
  `applyMouseLook`, `modeSensitivity`, `enemyNearCrosshair`, `wrapAngle`, `clampPitch`.
  yaw wird im Bereich −π…π gehalten (Grafik interpoliert mit `lerpAngle`).
- **Kamera** (`src/camera.js`): `new ThirdPersonCamera(threeCamera | null)`. Kamera-Arm aus zwei
  Teilen: Kopf → Schulter-Punkt (0,6 m rechts, Wand rechts → kürzer), dann vom Schulter-Punkt
  gegen die Blickrichtung nach hinten (3,2 m, Zielen 1,8 m). Die Kamera ist eine kleine Box
  (`CONFIG.camera.probeRadius`) – sie kommt nie so nah an Wände, dass die Bild-Nahgrenze hineinragt.
  `fixedUpdate(character, dt, world)` (einmal pro Tick, Game ruft es für den Spieler auf),
  `computeAimRay(character, world, outOrigin, outDir, yaw?, pitch?)` (= Fadenkreuz-Linie; benutzt
  nur den Tick-Zustand → gleich bei jeder Bildrate), `computePose(world, fx, fy, fz, yaw, pitch,
  distance, pivotHeight, outPos, outDir, side?, probe?)`, `shoulderSide(world, hx, hy, hz, yaw)`,
  `isFree(world, x, y, z, m)`, `update(character, alpha, dt, world, input?, settings?)`, `snap()`
  (nach Teleport/Runde; Sprünge > 3 m werden auch selbst erkannt), Felder `yaw`, `pitch`, `fov`,
  `side`, `characterDistance` (Kamera ↔ Kopf), `hideCharacter`.
- **Figuren-Grafik** (`src/world/characterModel.js`): Kopf-Größe und -Lage (stehend und geduckt) kommen aus
  `CONFIG.player.hitbox` (`headRadius`, `crouchHeight`, `crouchHeadForward`) – die Grafik wird nach der
  Treffer-Prüfung gebaut, nicht umgekehrt. `createCharacterView(character, parent)` →
  `{ root, rightHand, attach(name, obj), detach(name), setHidden(bool), update(alpha, dt, yawOverride?), dispose() }`.
  Farbsets und Hut-Formen stehen in `CONFIG.skins`.

## 11b. Waffen, Schaden, Geschosse (Welle 2b)

Ergänzt §5, §6, §8 und §9 (dort stehen nur die Grundformen).

**Schadens-Rechnung** (`src/core/damage.js`, reine Funktionen):
`falloffFactor(distance, falloff)` (voll bis `fullUntil`, linear bis `minAt` auf `minFactor`),
`weaponDamage(def, { distance, head, rarity, pellets })` (Grundschaden × Abfall × Kopf × Seltenheit × Kugeln,
nicht gerundet – Sniper-Kopfschuss 262,5), `rarityMultiplier(rarity)` (null → 1),
`applyShieldFirst(health, shield, damage, out?)` → `{ health, shield, shieldDamage, healthDamage }`,
`explosionDamage(def, distance)` (Mitte voll → Rand `edgeDamageFactor`, außerhalb 0),
`fallDamage(height)`, `damageNumberKind(head, shieldHit)` → `'head'|'shield'|'body'`.
`Character.applyDamage` und der Fallschaden in player.js benutzen sie.

**Game** (§5) hat zusätzlich `uiRoot` (HTML-Ebene, headless `null`) und `useRarity` (Standard `false`;
der Battle-Royale-Modus setzt es auf `true` → Seltenheits-Bonus auf den Schaden). `endMode()` ruft
`weapons.clearEffects()`. Die eigene Figur wird mit Zielfernrohr (`scopeFov`) ausgeblendet.

**Character** (§6) zusätzlich: `weaponState` (gehört dem Waffen-System, nur lesen: `reloadItem`,
`equipReadyAt`, `healItem`, `variants` …), `healing` (`null` oder `{ itemId, name, kind, duration,
progress 0..1, timeLeft }`), beim Heilen `speedFactor = CONFIG.healing.moveSpeedFactor`.
`applySelection` fragt `game.weapons.canAim(character)` (mit Heil-Item kein Zielen).
Zielpuppen (Übungsplatz) haben `isDummy = true`.

**Waffen-System** (`src/weapons/weapons.js`), `createWeaponSystem(game)` →
- `updateCharacter(c, cmd, dt)` – Wechsel (`CONFIG.weapons.switchTime`, jede Waffe hat ihr eigenes
  `item.readyAt` → Schrotflinte → sofort AR geht), gleiche Platz-Taste nochmal = nächste Variante im Platz,
  Abzug (automatisch: halten; halb-automatisch: Klick; ein zu früher Klick wird `fireBufferTime` gemerkt –
  während der Wechsel-Zeit läuft der Merker nicht ab: "1 + Klick im selben Tick" schießt nach `switchTime`),
  Nachladen (R; leer + Abzug; `autoReloadWhenEmpty`: eine leere Waffe in der Hand lädt von selbst, sobald
  sie bereit ist – auch nach einem Ausflug in den Baumodus; Schrotflinte Patrone für Patrone, Schießen unterbricht),
  Zielen/`scopeFov` (Sniper), Streuung, Spitzhacke (Schlag alle `swingInterval`, Reichweite `range` ab
  `aimOrigin`, `data.harvest` → Material), Heil-Items (Linksklick, `useTime`, Waffenwechsel bricht ab).
  Ziel-Strahl = `cmd.aimOrigin/aimDir`; liegt `aimOrigin` weiter als 1,2 m von den Augen weg (nie gesetzt),
  gilt Augen + Blickrichtung.
- `giveLoadout(c, ids, { rarity, infiniteReserve, reserve, infiniteHeals, healCount })` – `ids` z. B.
  `['shotgun', 'ar', 'sniper', ['smg', 'pistol', 'grenadeLauncher'], 'bandage']`; ein Eintrag als Liste =
  mehrere Gegenstände in EINEM Platz (Varianten). Platz aus `CONFIG.weapons[id].slot` bzw.
  `CONFIG.weapons.healSlot`, sonst der nächste freie. Liefert `c.slots`.
- `createItem(id, rarity, options)` → Waffe `{ id, kind: 'weapon', name, rarity, ammo, magazine, reserve,
  infiniteReserve, readyAt }` bzw. Heil-Item `{ id, kind: 'heal', name, rarity, count, stack, infinite }`.
- Für HUD/Bots: `canAim(c)`, `getCrosshair(c)` → `{ type: 'cross'|'circle'|'dot', spread }` (Grad, ganzer
  Kegel, aktuell), `getAmmo(c)` → `{ mag, reserve, infinite, magazine, reloading, reloadProgress, heal }`
  oder `null` (wiederverwendetes Objekt), `isReloading(c)`, `resetCharacter(c)` (Runde: Nachladen/Heilen
  abbrechen, alle Magazine voll), `hitscan` (siehe unten).
- Grafik: `frameUpdate(alpha)` (zeichnet auch die Geschosse), `setEffectsPaused(bool)` (Screenshots),
  `clearEffects()`, `visuals` (`visibleNumbers()` für Tests, `muzzleWorld(c, out)`).
- Exporte: `WEAPON_IDS`, `HEAL_IDS`, `fireIntervalOf(def)`, `spreadFor(def, moving, aiming)`,
  `preferredSlot(id)`, `createItem`.

**Treffer-Strahl** (`src/weapons/hitscan.js`): `trace(shooter, origin, dir, maxRange, out)` – erst der
Kamera-Strahl, dann die **Mündungs-Prüfung** Augen → Mündung (`CONFIG.weapons.muzzleOffset`) → Treffpunkt;
steht dort etwas, bekommt DAS den Treffer (`out.blocked`). Nie den Schützen, Team-Kollegen werden
(ohne `friendlyFire`) durchschossen, Collider mit `data.blocksBullets === false` lassen durch.
Kopf = `part === 'head'` aus dem raycast. Dazu `aimPoint(...)`, `muzzlePosition(c, out)`, `targetsFor(c)`
und `spreadDirection(dir, coneDeg, rng, out)` (gleichmäßig im Kegel, höchstens der HALBE Winkel).
Schaden anwenden: `src/weapons/combat.js` (`damageCharacter`, `damageObject`, `isDamageable`, `isPiece`).
An Bauteilen (`data.kind === 'piece'`) zählt `structureDamage` (Schrotflinte: 60 verteilt auf die
treffenden Kugeln), an anderen Objekten mit `data.ref.applyDamage` der normale Waffen-Schaden.
`data.ref.applyDamage(amount, info)` bekommt ein eigenes `info`-Objekt `{ attacker, weaponId, point, kind }`
und darf eine Zahl (wirklicher Schaden) oder `{ amount, destroyed }` (Bauteile, §9a) zurückgeben; ohne
Rückgabe gilt der verlangte Schaden. 0 → kein `hit` (z. B. Bauteil schon weg).

**Geschosse** (`src/weapons/projectiles.js`): `spawn({ type: 'bullet'|'grenade', owner, weaponId, rarity,
position, velocity, gravity, lifetime, visualFrom? })`, `update(dt)` (Strecke pro Tick per raycast →
kein Durchtunneln), `clear()`, `frameUpdate(alpha)`, `active` (Liste). Sniper-Kugel startet an den Augen
und fliegt zum Punkt unter dem Fadenkreuz (300 m/s, leichter Fall). Granate: explodiert beim Aufprall
oder nach `fuseTime`; Figuren im Radius nehmen Schaden durch Wände hindurch (Abstand zur Kapsel),
Bauteile im Radius `structureDamage`; eigene Granaten verletzen nicht (`selfDamage: false`).
**Wiedereintritt:** Empfänger der Ereignisse (`hit`, `characterKilled`, `impact`, `explosion` …) dürfen
mitten im Schritt `projectiles.clear()`, `spawn()`, `game.removeCharacter()` oder `game.endMode()` aufrufen:
`update()` macht danach nur mit Geschossen weiter, die noch fliegen (in diesem Schritt erzeugte fliegen erst
im nächsten), `explode()` läuft über eine Kopie von `game.characters` (aus dem Spiel genommene Figuren
werden übersprungen, keine wird ausgelassen).

**Ereignisse** (§8) – genauer bzw. neu. Die Ereignis-Objekte werden **wiederverwendet**: Wer etwas
länger braucht, kopiert es sofort (z. B. `e.point.clone()`).
| Ereignis | Inhalt |
|---|---|
| `shot` | `{ shooter, weaponId, origin (Mündung), dir, end (Treffpunkt/Ende des Strahls), pellets, kind: 'hitscan'\|'projectile' }` |
| `hit` | `{ attacker, target, amount, nominal, shieldDamage, healthDamage, head, shield, point, killed, kind: 'character'\|'piece'\|'object', weaponId, collider }` – eine Meldung pro Ziel und Schuss (Schrotflinte: Summe der Kugeln); `amount` = wirklich angerichtet (Bauteil mit 15 Leben, Treffer 25 → 15), `nominal` = verlangter Waffen-Schaden (Schadenszahl an Bauteilen), `killed` = besiegt bzw. Bauteil zerstört; kein `hit` bei 0 Schaden (unverwundbar, schon zerstört) |
| `impact` | `{ shooter, weaponId, point, normal, kind: 'character'\|'piece'\|'object'\|'static'\|'terrain' }` – jede Kugel (für Funken/Splitter) |
| `reloadStart` / `reloadEnd` | `{ character, weaponId, interrupted }` |
| `swing` | `{ character }` – Spitzhacke schlägt |
| `harvest` | `{ character, material, amount (wirklich dazu), rolled (gewürfelt 5–10), point }` |
| `healStart` / `healCancel` | `{ character, itemId, duration }` / `{ character, itemId }` (`heal` sendet Character.heal) |
| `explosion` | `{ position, radius, owner, weaponId }` |

Reihenfolge pro Strahl-Schuss: `shot` → `impact` (jede Kugel) → `hit` (je Ziel) → evtl. `characterKilled`
bzw. `pieceDestroyed`. Spitzhacke: `swing` → `impact` → `hit` / `harvest`. Sniper/Granate: `shot` beim
Abfeuern, `impact`/`hit`/`explosion` beim Einschlag (Geschoss).

**Grafik** (nur mit Bildschirm): `src/weapons/models.js` (`createWeaponModel(id, rarity)`, `createHandMount`;
geteilte Formen/Materialien mit `userData.shared`), `src/weapons/visuals.js` (Waffe an der rechten Hand per
`view.attach('weapon', …)`, Mündungsblitz-Sprite + EIN dauerhaftes PointLight (Anzahl Lichter bleibt gleich →
kein Shader-Neubau), Leuchtspur bei `tracer: true`, Feuerball, Treffer-Zahlen als HTML in `game.uiRoot`
(Vorrat, `settings.game.damageNumbers`, nur eigene Treffer), Ist die eigene Figur ausgeblendet (Kamera am Kopf) oder im Zielfernrohr: kein Blitz-Bild (beim Ausblenden nur
das kurze Licht), Leuchtspur und Sniper-Streifen beginnen `weaponVisuals.hiddenShotStartDistance` vor der Kamera;
der Streifen eines Geschosses reicht nie hinter seinen Bild-Start zurück. Spitzhacke: Zahl = wirklich gesammelt
(`+N`), bei vollem Material `harvestFullText`. **vorläufiges** Zielfernrohr-Bild `.bd-scope`
(das HUD in Welle 3a darf es ersetzen; `CONFIG.weapons.sniper.scopeOverlay`)). Werte: `CONFIG.weaponVisuals`.

**Übungsplatz** (`src/weapons/practiceRange.js`, eingehängt in modes/practice.js): alle Waffen
(`CONFIG.practiceRange.loadoutSlots`), Schieß-Stand mit Zielpuppen (5/15/30/60 m, eine mit Schild; viel
Leben, nach `regenDelay` wieder voll, stehen wieder auf), Baum/Fels/Auto für die Spitzhacke.
Browser-Prüfungen der Waffen: `tests/e2e/weaponChecks.cjs` (in `GAME_CHECKS` von run.cjs eingehängt).

## 11d. Welt: Karten, Sturm, Loot, Absprung (Welle 3b)

**Gemeinsame Karten-Felder** (alle Karten = `createMapBuilder` + Zusätze):
`id`, `size`, `center {x, z}`, `buildBounds`, `contains(x, z, margin)`, `isLand(x, z)` (für die Sturm-Zone),
`areaAt(x, z)` → Name der Gegend oder `null`, `spawnPoints(count, options)` → `[{ x, y, z, yaw }]`
(auf freiem, begehbarem Boden, Mindestabstand, Blick zur Mitte), `props` (Sammel-Objekte), `dispose()`.
Karten mit Gelände (Insel, Zone Wars) setzen `world.setTerrain(heightfield)` und beim Aufräumen wieder
`null`; `playBounds` = Spielfeld innerhalb der unsichtbaren Wand (Freifall/Gleiter bleiben darin).
- **Duell-Arena** (`mapArena.js`): `createArenaMap(game, { size, props: true, seed })` – Felsen und Bäume
  punkt-symmetrisch (fair), Platz um die Startpunkte; `spawnPoints(2)` = die festen Duell-Punkte
  (`CONFIG.modes.duel.spawnDistance` auseinander, Blick zueinander). Jede Arena (auch der Übungsplatz) hat
  über der Mauer eine unsichtbare Wand bis `CONFIG.maps.arena.barrierHeight` (`addBarrierRing`).
- **Insel** (`mapIsland.js`): `createIslandMap(game, { seed })` – gleiche Insel bei gleichem `seed`
  (`CONFIG.maps.island.seed`). Gelände mit sanften Hügeln (jedes Dreieck höchstens `maxSlopeDeg` steil), Strand,
  flaches Wasser bis zur unsichtbaren Wand, Fluss (0,7 m tief, begehbar, 2 Brücken), Wüstenstadt "Sandkrug"
  (begehbare Häuser, manche mit 2 Stockwerken und Treppe), Weiler, Hof mit Feldern, Wald, Felsen, Autos,
  Metallzäune. Zusätzlich: `terrain`, `seaLevel`, `heightAt(x, z)`, `isWater(x, z)`, `riverX(z)`, `houses`
  (je Haus: `bounds`, `floorY[]`, `door { outside, inside }`, `stairs { bottom, top }`, `toWorld(u, v)`),
  `chestSpots`, `floorLootSpots` (`{ x, y, z, yaw, area, indoor }`), `areas`, `generationMs`,
  `jumpPath(rng)` → `{ start, end, dir }` (Flug-Linie des Ballons). Die Insel stellt Nebel, Kamera-Sichtweite
  und das weiche Licht von unten passend ein (`CONFIG.maps.island.fog/cameraFar/hemiGroundColor`) und setzt sie
  beim Aufräumen zurück.
- **Zone Wars** (`mapZoneWars.js`): `createZoneWarsMap(game, { seed })` – 160 x 160 m, Hügel, Rand steigt an,
  Felsen/Bäume/Deckungs-Mauern, `spawnPoints(count)` weit verteilt (`spawnMinDistance`).
- Bausteine: `terrain.js` (`createHeightfield` – heightAt nimmt GENAU die Dreiecke des Gelände-Meshes,
  `buildTerrainGeometry`, `createNoise`, `limitSlopes`), `staticBatch.js` (viele Kisten/Schrägen → EIN Mesh mit
  Ecken-Farben und etwas "Eigenlicht", Kollision pro Kiste), `props.js` (`createPropSet`:
  `addTree/addRock/addCar/addFence`, Grafik als InstancedMesh; Leben aus `CONFIG.maps.props`, `applyDamage` →
  zerstört = Kollision weg + `propDestroyed`), `houses.js` (`buildHouse`), `spawnPoints.js`
  (`findSpawnPoints`, `checkSpawnPoint`).
- Leistung (gemessen in `tests/e2e/worldChecks.cjs`): Insel in ca. 0,2 s erzeugt, < 150 Zeichen-Aufrufe für
  die ganze Welt (Gelände, Wasser, Häuser, Bäume, Loot, Sturm, Ballon) – die Figuren kommen dazu.

**Sturm** (`storm.js`): `createStorm(game, spec)` mit `spec = { initialRadius, phases: [{ wait, shrink, dps,
endRadius }], moving?, center?, autoStart? (false = Uhr steht bis start()), isGoodZone?(x, z, r), baseY? }`
(Battle Royale: `CONFIG.modes.battleRoyale.storm`, Zone Wars: `CONFIG.modes.zoneWars.storm`). Ohne Phasen:
unendlich groß. Felder: `center`, `radius`, `nextCenter`, `nextRadius` (schon beim Warten bekannt → Minimap),
`phase` (0 = erste), `phaseCount`, `state` ('wait' | 'shrink' | 'closed'), `timeLeft`, `stateDuration`,
`damagePerSecond`, `paused`. Methoden: `update(dt)`, `isInside(pos)` (nur waagerecht), `distanceToEdge(pos)`
(positiv = drinnen), `start()`, `frameUpdate(dt)`, `dispose()`.
Regeln: Die neue Zone liegt immer komplett in der alten (`game.rng`), an Land bevorzugt (`map.isLand`);
`moving` = wandert fast bis an den erlaubten Rand. Schrumpfen verschiebt Mitte und Radius gleichmäßig.
Schaden: alle `CONFIG.stormZone.damageInterval` s (`kind: 'storm'`, `weaponId: 'storm'`, **direkt aufs Leben** –
wie im Original schützt der Schild nicht: `CONFIG.stormZone.ignoresShield`). Wer im Ballon steht
(`moveState 'vehicle'`), nimmt keinen Schaden. Grafik: lila Wand (Zylinder ohne Deckel, `fog: false`), erst ab
dem ersten Schrumpfen; ist der Spieler draußen: lila Färbung (Kugel um die Kamera) + lila Nebel. Das HUD (3a)
kann zusätzlich `storm.isInside(game.player.position)` benutzen.

**Loot** (`loot.js`, Grafik `lootView.js`): `createLootSystem(game, spec)`, `spec = { rarityWeights, chest:
{ materialAmount, ammoMagazines, healItemChance }, dropOnDeath (Standard true) }`.
- Kiste: `{ id, position, yaw, opened, openedBy, openTime, collider (kind 'chest'), area }` – `spawnChest(pos,
  { yaw })`, `openChest(chest, character)` (Inhalt springt heraus: 1 Waffe + passende Munition + Material,
  mit `healItemChance` ein Heil-Item; danach verschwindet die Kiste). Liste: `loot.chests`.
- Boden-Gegenstand: `{ id, kind: 'weapon'|'heal'|'ammo'|'material', item (weapons.createItem), weaponId, material,
  amount, rarity, name, position (Ruhe-Lage am Boden), fromMap, removed, pop }` – `spawnFloorItem(desc)`,
  `removeItem(fi)`, Liste `loot.items`.
- Aufheben: `pickUp(c, fi)` (Waffe → ihr Platz 1–4, sonst nächster freier; Heil-Item → stapeln, sonst Platz 5,
  sonst frei; alles voll → **Tausch mit dem gewählten Platz**, der alte Gegenstand fällt hin; leere Hand → gleich
  in die Hand), `collect(c, fi)` (Munition → Reserve einer passenden Waffe, höchstens `maxReserveMagazines`
  Magazine; Material bis 999; geht im Vorbeilaufen automatisch), `slotFor(c, fi)` → `{ slot, swap, stack }`.
- E: Jeder Tick prüft `command.usePressed` jeder Figur: `focusFor(c)` = Kiste/Gegenstand in Reichweite, am
  nächsten am Fadenkreuz, ohne Wand dazwischen → `interact(c, target)`. Für den Spieler steht das Ergebnis in
  `game.interactionPrompt` (siehe §5). E öffnet außerdem Türen (Bau-System) – beides kann im selben Tick passieren.
- Bots: `findNearestLoot(pos, filter)` (`filter` = Funktion oder `{ kinds, maxDistance, rarityAtLeast }`) und
  `interact(character, target)` (gleiche Reichweiten-Regeln).
- `dropAll(c)`: Waffen (auch Varianten), Heil-Items, Material fallen verstreut hin (`scatterRadius`), das Inventar
  wird mit `weapons.giveLoadout(c, [])` geleert. Bei `characterKilled` automatisch (am Ende des Ticks).
- `populate(map)`: Kisten/Boden-Loot auf `map.chestSpots`/`map.floorLootSpots` (Wahrscheinlichkeiten aus
  `CONFIG.loot`). Verschwinden: fallen Gelassenes nach `droppedDespawnTime`, höchstens `maxFloorItems`.
- `loot.js` schreibt beim Aufheben/Tauschen `c.slots[i]` und leert `c.weaponState.variants[i]` (sonst ist
  weaponState nur zum Lesen) – so bleibt das Waffen-System unverändert.
- Grafik: pro Waffen-Art ein InstancedMesh (Teile in Seltenheits-Farbe werden weiß gebacken und per Instanz-Farbe
  eingefärbt), Lichtsäule + Leucht-Fleck in Seltenheits-Farbe, Kisten pulsieren, Schild über dem Gegenstand im Fokus.

**Absprung** (`jumpVehicle.js`, `skydive.js`):
`createJumpVehicle(game, { path: map.jumpPath(rng), speed?, dropZone?(x, z) })` → System (in `game.systems`
legen, bleibt bis zum Ende des Modus): `board(c)`, `drop(c)`, `dropAll()`, `canDrop()` (über der Insel),
`scheduleBotDrops(rng)` (Bots springen verteilt ab), `seatPosition(c)`, `riders`, `position`, `velocity`,
`finished`, `update()`, `frameUpdate(dt, alpha)`, `dispose()`. Mitfahrer haben `moveState 'vehicle'` und stehen
auf der Plattform (Kamera wie immer); Leertaste springt ab (erst über der Insel), am Inselrand werden alle
abgesetzt. `skydive.js`: `startFreefall(c, velocity?)`, `deployGlider(c)`, `heightAboveGround(c, world)`,
`createSkydiveView(game)` (Gleiter-Schirm, Freifall-Haltung, Fahrtwind; der Ballon benutzt ihn).
Freifall: Tempo `freefallSpeed`, lenken `freefallMoveSpeed`, Blick nach unten + W = Sturzflug bis
`CONFIG.skydive.diveSpeed`; der Gleiter öffnet von selbst `gliderDeployHeight` über dem Boden (Dächer zählen) oder
mit der Leertaste; in diesen Zuständen keine Aktionen (der Befehl wird geleert). Landung: `landCharacter(c,
{ noDamage: true })` – `land.fallHeight` ist die ganze Fallhöhe, Schaden gibt es keinen.

**Test-Modi** (`modes/sandbox.js`, `hidden: true`): `sandbox-island` (Insel + Sturm + Loot + Ballon, Optionen
`{ bots, skipVehicle, stormAutoStart, mapSeed }`), `sandbox-arena`, `sandbox-zonewars`. Browser-Prüfungen:
`tests/e2e/worldChecks.cjs` (in `GAME_CHECKS` eingehängt, Namen beginnen mit "Welt:", `--grep Welt`).

## 12. Testen

- **Einheiten-Tests** (`tests/*.test.js`, in `tests/tests.html` eingetragen): reine Logik.
- **Szenario-Tests** (`tests/scenario/*.test.js`, ebenfalls in tests.html): erzeugen ein
  `Game({ headless: true })` mit einem Modus, simulieren Sekunden und prüfen das Ergebnis
  (z. B. Turm stürzt ein, Duell endet, Zone macht Schaden).
- **Browser-Tests für Entwickler** (`tests/e2e/run.cjs`, braucht Node + Playwright, nicht für
  Spieler): startet `tools/server.py`, öffnet Spiel und Tests im echten Browser, prüft
  Konsole, macht Screenshots, steuert Spielszenen über `window.buildDuel`.
- `window.buildDuel` (Debug-Zugang im Browser): `{ game, startMode(id, options), simulate(seconds), input, CONFIG,
  settings, play(), pause(), manualStep(on), state, modeId, frames, ticks, renderer, scene, camera }`.
  `play()` spielt ohne Maus-Sperre (Tests), `manualStep(true)` hält die Spielschleife an
  (Bilder laufen weiter, Logik nur noch über `simulate`).
- `tests/e2e/run.cjs`: neue Prüfungen als Eintrag in `GAME_CHECKS` anhängen
  (`{ name, run: async (ctx) => … }`, ctx = `{ page, assert, log, shot }`).
  Welle 2a: Bau-Prüfungen stehen in `tests/e2e/buildChecks.cjs` (in GAME_CHECKS eingehängt);
  `--grep text` führt nur Prüfungen aus, deren Name passt (z. B. `--grep "Bauen|Edit"`).
- Modi dürfen `helpHint` (Text) haben – main.js zeigt ihn unter der Steuerungs-Hilfe.
- URL-Schnellstart (für Tests/Entwicklung): `index.html?mode=duel&bots=hard&seed=1` überspringt das Menü.

## 13. Wer besitzt welche Dateien (Entwicklungs-Wellen)

Jede Welle darf nur ihre eigenen Dateien ändern. Kleine, nötige Änderungen an fremden
Dateien sind erlaubt, wenn sie eng begrenzt sind (Git führt sie zusammen); sie werden im
Abschlussbericht genannt.

| Welle | Dateien |
|---|---|
| 1 Fundament (Phase 2) | core/game.js, core/events.js, core/settings.js, input.js, playerController.js, player.js, physics.js, camera.js, world/characterModel.js, world/mapBuilder.js, modes/index.js, modes/practice.js, main.js, Attrappen aller Systeme, tests/e2e/* (mapArena.js: Boden in createArenaMap verschoben – gehört weiter Welle 3b) |
| 2a Bauen (3+4) | building/*, Bau-Tests |
| 2b Waffen (5) | core/damage.js, weapons/*, Zielpuppen, Schadenszahlen, Waffen-Tests |
| 3a HUD + Ton + Effekte (6, 12) | ui/hud.js, ui/killfeed.js, ui/minimap.js, audio/sfx.js, world/effects.js |
| 3b Welt (9 Teil) | world/storm.js, world/loot.js, world/lootView.js, world/mapArena.js, world/mapIsland.js, world/mapZoneWars.js, world/terrain.js, world/staticBatch.js, world/props.js, world/houses.js, world/spawnPoints.js, world/jumpVehicle.js, world/skydive.js (Gleiter/Freifall über registerMoveStateHandler), modes/sandbox.js, tests/world.test.js, tests/scenario/world.test.js, tests/e2e/worldChecks.cjs |
| 4a Bots (7) | ai/bot.js |
| 4b Modi (8–10) | modes/* |
| 5 Menüs (11) | ui/menus.js, ui/settings.js, ui/touch.js, core/progress.js, main.js-Ablauf |
| 6 Feinschliff (12) | alles, nach Prüfung |
