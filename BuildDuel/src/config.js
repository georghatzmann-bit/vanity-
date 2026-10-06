// =============================================================================
// BuildDuel – ALLE Spielwerte an einem Ort
// =============================================================================
//
// Hier stehen alle Zahlen des Spiels: Tempo, Schaden, Größen, Tasten, Zeiten.
// Wenn sich etwas "falsch" anfühlt (z. B. Schrotflinte zu stark), änderst du
// NUR diese Datei, speicherst und lädst die Seite im Browser neu (F5).
//
// So sind die Kommentare zu lesen:
//   // SCHÄTZUNG  = Das Original (1v1.LOL) hat diesen Wert nie veröffentlicht.
//                  Wir haben einen sinnvollen Wert geschätzt. Gerne anpassen.
//   // belegt     = Steht so in verlässlichen Quellen über das Original.
//   // Vorgabe    = steht so in deinem Plan, ist aber kein Wert des Originals.
//   ohne Markierung = Vorgabe aus deinem Plan oder eigene Entscheidung für
//                  BuildDuel (Technik, Farben, Bots usw.).
//
// Einheiten: 1 Einheit = 1 Meter, Zeiten in Sekunden (s), Winkel in Grad (°),
// Tempo in Metern pro Sekunde (m/s), außer es steht anders dabei.
//
// Hinweis: Die Werte werden beim Start "eingefroren" (Object.freeze). Das Spiel
// kann sie also nicht aus Versehen verändern. Eigene Einstellungen aus dem Menü
// (Tasten, Empfindlichkeit …) werden ab Phase 11 getrennt gespeichert und
// überschreiben dann nur die Standardwerte von hier.
// =============================================================================

export const CONFIG = deepFreeze({
  // ---------------------------------------------------------------------------
  // Allgemein
  // ---------------------------------------------------------------------------
  game: {
    name: 'BuildDuel', // Platzhalter-Name, keine Original-Namen benutzen
    version: '0.2.0', // 0.2 = Phase 2 (Figur, Bewegung, Kamera)
    storageKeyPrefix: 'buildduel.', // Vorsilbe für alles, was im Browser gespeichert wird
  },

  // Spielschleife: Die Spiel-Logik rechnet immer genau 60-mal pro Sekunde,
  // egal wie schnell der Bildschirm ist. Das Bild wird so oft gemalt, wie der
  // Browser kann (requestAnimationFrame).
  loop: {
    tickRate: 60, // Logik-Schritte pro Sekunde
    maxFrameTime: 0.2, // längere Pausen (z. B. ein Ruckler) zählen höchstens als 0,2 s
    maxStepsPerFrame: 12, // höchstens 12 Schritte pro Bild (= 0,2 s). Unter 5 Bildern/s läuft das Spiel langsamer, statt zu springen
  },

  // ---------------------------------------------------------------------------
  // Welt und Raster
  // ---------------------------------------------------------------------------
  world: {
    gridCellSize: 4, // Bau-Raster: eine Zelle ist 4 x 4 m // SCHÄTZUNG
    wallHeight: 4, // eine Wand ist 4 m hoch (= eine Stockwerk-Höhe) // SCHÄTZUNG
    gravity: 25, // Schwerkraft in m/s² (Erde wäre 9,81 – Spiele sind "schneller") // SCHÄTZUNG
    groundSize: 2000, // Kantenlänge der Boden-Fläche (größer als die Sichtweite → kein sichtbarer Rand)
    killPlaneY: -50, // wer tiefer fällt, ist raus (Sicherheitsnetz)
  },

  // Technik der Kollisions-Welt (physics.js) – nur für Leistung, ändert das Spiel nicht
  physics: {
    bigColliderCells: 256, // Collider über mehr Raster-Zellen landen in einer eigenen Liste
    terrainRayStep: 1.0, // Strahl gegen hügeliges Gelände: so groß sind die Such-Schritte (m)
    terrainBisectSteps: 12, // danach so oft halbieren (genauer Treffpunkt)
    terrainRayMaxDistance: 2000, // so weit sucht ein Strahl höchstens nach dem Gelände (m) – nie endlos
  },

  // ---------------------------------------------------------------------------
  // Spieler
  // ---------------------------------------------------------------------------
  player: {
    maxHealth: 100, // belegt (mehrere Quellen: 100 Lebenspunkte)
    maxShield: 100, // Schild nimmt Schaden zuerst // SCHÄTZUNG
    healthRegen: 0, // kein automatisches Heilen

    // Bewegung
    walkSpeed: 6, // SCHÄTZUNG
    crouchSpeed: 3, // SCHÄTZUNG
    sprintSpeed: 7.5, // nur aktiv, wenn Ducken auf Strg liegt (siehe controls) // SCHÄTZUNG
    jumpVelocity: 8.4, // Start-Tempo nach oben → Sprunghöhe ca. 1,4 m // SCHÄTZUNG
    groundAcceleration: 60, // wie schnell man auf volles Tempo kommt // SCHÄTZUNG
    airControl: 0.35, // Lenken in der Luft (0 = gar nicht, 1 = wie am Boden) // SCHÄTZUNG
    maxWalkableSlope: 46, // bis zu dieser Steigung (°) kann man ohne Springen laufen – Rampen haben 45°
    stepHeight: 0.35, // kleine Kanten (z. B. Bodenplatten) werden automatisch "hochgestiegen" // SCHÄTZUNG
    maxFallSpeed: 60, // schneller fällt man nicht (Luftwiderstand) // SCHÄTZUNG
    coyoteTime: 0.1, // so lange nach dem Verlassen einer Kante darf man noch springen (fühlt sich fairer an)
    jumpBufferTime: 0.12, // Leertaste kurz VOR der Landung gedrückt → springt sofort bei der Landung
    groundSnapDistance: 0.55, // beim Bergab-Laufen (Rampe, kleine Stufe) bleibt man so weit am Boden "kleben" (m)
    stepSmoothing: 14, // Figur und Kamera ziehen eine Stufe weich nach (höher = schneller)
    eyeHeight: 1.6, // Augenhöhe stehend (über den Füßen)
    crouchEyeHeight: 1.1, // Augenhöhe geduckt
    footstepDistance: 2.0, // alle 2 m ein Schritt (für das Schritt-Geräusch)
    emoteDuration: 2.0, // B: die Figur tanzt so lange
    // Gegen "Durchfallen": Bewegungen, die länger sind, werden in Teilschritte zerlegt.
    maxSubstepDistance: 0.25, // höchstens so weit pro Teilschritt (m)
    maxSubsteps: 40, // höchstens so viele Teilschritte pro Tick

    // Fallschaden
    fallDamage: {
      safeHeight: 7, // bis 7 m Fall: kein Schaden // SCHÄTZUNG
      damagePerMeter: 10, // je Meter darüber: 10 Schaden // SCHÄTZUNG
      // Beim Absprung im Battle Royale (Freifall + Gleiter) gibt es keinen Fallschaden.
    },

    // Treffer-Form ("Hitbox"): eine Kapsel
    hitbox: {
      height: 1.8, // Gesamthöhe stehend // SCHÄTZUNG
      crouchHeight: 1.3, // Gesamthöhe geduckt // SCHÄTZUNG
      radius: 0.4, // SCHÄTZUNG
      headZone: 0.3, // die obersten 0,3 m zählen als Kopf // SCHÄTZUNG
      // Der SICHTBARE Kopf (Kugel der Figur) zählt auch als Kopf: Seine Oberkante liegt immer genau
      // auf der Oberkante der Kapsel (stehend 1,8 m, geduckt 1,3 m). Die Figur (characterModel.js)
      // wird danach gebaut – Bild und Treffer passen so immer zusammen.
      headRadius: 0.27, // Kopf-Kugel (m)
      crouchHeadForward: 0.17, // geduckt beugt sich die Figur vor: Kopf-Mitte so weit (m) vor der Kapsel-Mitte
    },
  },

  // ---------------------------------------------------------------------------
  // Kamera (Über-die-Schulter)
  // ---------------------------------------------------------------------------
  camera: {
    distance: 3.2, // so weit hinter der Figur (genauer: hinter dem Schulter-Punkt) // SCHÄTZUNG
    shoulderOffset: 0.6, // so weit nach rechts versetzt ("Schulter-Punkt" neben dem Kopf) // SCHÄTZUNG
    height: 1.6, // so hoch über den Füßen // SCHÄTZUNG
    aimDistance: 1.8, // beim Zielen näher ran // SCHÄTZUNG
    collisionPadding: 0.2, // Abstand zur Wand, wenn die Kamera sonst durch eine Wand ginge
    fov: 70, // Sichtfeld normal (°) // SCHÄTZUNG
    aimFov: 55, // Sichtfeld beim Zielen (°) // SCHÄTZUNG
    sniperFov: 20, // Sichtfeld mit Zielfernrohr (°) // SCHÄTZUNG
    fovChangeSpeed: 12, // wie schnell das Sichtfeld wechselt (höher = schneller)
    crouchHeight: 1.1, // Kamera-Höhe über den Füßen, wenn man geduckt ist (+ probeRadius passt unter jede Decke, unter die man geduckt passt)
    aimZoomSpeed: 14, // wie schnell die Kamera beim Zielen näher fährt (höher = schneller)
    crouchSmoothing: 12, // wie schnell die Kamera beim Ducken mitgeht
    collisionReturnSpeed: 6, // nach einem Hindernis fährt die Kamera so schnell wieder zurück
    probeRadius: 0.2, // die Kamera bleibt so weit von Wänden weg (größer als die Ecken der Bild-Nahgrenze → nie durch Wände sehen)
    hideCharacterDistance: 0.75, // ist die Kamera näher am Kopf der Figur, wird die eigene Figur ausgeblendet
    hideCharacterSide: 0.45, // Wand rechts: liegt der Schulter-Punkt näher am Kopf, würde die Figur das Fadenkreuz verdecken → ausblenden
    near: 0.1, // näher als das wird nichts gezeichnet
    minPitch: -80, // so weit kann man nach unten schauen (°)
    maxPitch: 80, // so weit kann man nach oben schauen (°)
  },

  // Empfindlichkeit (Standardwerte – ab Phase 11 im Menü änderbar)
  sensitivity: {
    baseRadiansPerPixel: 0.0022, // Grund-Drehung pro Maus-Pixel
    x: 1.0, // links/rechts
    y: 1.0, // hoch/runter
    aim: 0.7, // beim Zielen (Faktor)
    sniper: 0.45, // mit Zielfernrohr (Faktor)
    build: 1.0, // im Baumodus (Faktor)
    edit: 1.0, // im Edit-Modus (Faktor)
    invertY: false, // Y-Achse umkehren
    gamepadLookSpeed: 3.2, // Controller: Drehung in Radiant pro Sekunde bei vollem Stick
    gamepadDeadzone: 0.15, // Controller: kleine Stick-Bewegungen ignorieren
    gamepadLookExponent: 1.6, // Controller: kleine Stick-Ausschläge drehen feiner (1 = gleichmäßig)
  },

  // ---------------------------------------------------------------------------
  // Steuerung (Standard-Tasten)
  // ---------------------------------------------------------------------------
  // Tasten werden als "Tasten-Position" gespeichert (KeyboardEvent.code).
  // Wichtig für deutsche Tastaturen (QWERTZ): Der Code 'KeyZ' ist die Taste
  // UNTEN LINKS neben X (auf deutschen Tastaturen steht dort "Y"). 'KeyY' ist
  // die Taste OBEN, auf der bei dir "Z" steht. Beide bauen eine Wand – so
  // passt es auf jeder Tastatur (das Original erlaubte auch Z und Y).
  // Maus: 'Mouse0' = links, 'Mouse1' = Mausrad drücken, 'Mouse2' = rechts,
  // 'WheelUp' / 'WheelDown' = Mausrad drehen.
  controls: {
    keyboard: {
      moveForward: ['KeyW'], // belegt
      moveBack: ['KeyS'], // belegt
      moveLeft: ['KeyA'], // belegt
      moveRight: ['KeyD'], // belegt
      jump: ['Space'], // belegt
      crouch: ['ShiftLeft', 'ShiftRight'], // belegt (Shift = ducken; linke und rechte Shift-Taste)
      primary: ['Mouse0'], // schießen bzw. Bauteil setzen // belegt
      secondary: ['Mouse2'], // zielen (belegt); im Edit "Felder zurücksetzen" (Vorgabe)
      buildWall: ['KeyZ', 'KeyY'], // belegt (Z, auf QWERTZ auch Y)
      buildFloor: ['KeyX'], // Quellen widersprechen sich bei Boden/Rampe – hier festgelegt
      buildRamp: ['KeyC'], // Quellen widersprechen sich bei Boden/Rampe – hier festgelegt
      buildRoof: ['KeyV'], // belegt
      pickaxe: ['KeyF'], // belegt
      slot1: ['Digit1'], // Schrotflinte
      slot2: ['Digit2'], // Sturmgewehr
      slot3: ['Digit3'], // Scharfschützengewehr
      slot4: ['Digit4'], // Maschinenpistole / Pistole
      slot5: ['Digit5'], // Heil-Item
      reloadOrRotate: ['KeyR'], // nachladen; im Baumodus: Bauteil drehen // belegt
      edit: ['KeyG'], // belegt
      use: ['KeyE'], // Türen öffnen, Gegenstände aufheben // belegt
      emote: ['KeyB'], // belegt
      switchMaterial: ['KeyQ', 'Mouse1'], // im Baumodus: Holz → Stein → Metall
      nextItem: ['WheelDown'], // belegt (Mausrad)
      prevItem: ['WheelUp'], // belegt (Mausrad)
      scoreboard: ['Tab'],
      pause: ['Escape'],
    },
    // Tasten, die absichtlich doppelt belegt sein dürfen, weil sie je nach
    // Situation etwas anderes tun (die Tests prüfen den Rest auf Konflikte).
    allowedSharedKeys: [],
    // Ducken auf Strg legen? Dann ist Shift = Sprinten.
    // ACHTUNG: Strg + W schließt im Browser den Tab! Darum ist das aus.
    crouchOnCtrl: false,
    crouchCtrlKeys: ['ControlLeft', 'ControlRight'], // Ducken, wenn crouchOnCtrl an ist
    sprintKeysWhenCrouchOnCtrl: ['ShiftLeft', 'ShiftRight'], // dann Sprinten
    crouchToggle: false, // false = halten, true = einmal drücken zum Umschalten
    editOnRelease: false, // Edit bestätigen, sobald G losgelassen wird
    resetEditAfterConfirm: false, // Edit-Auswahl nach dem Bestätigen leeren

    // Controller (Standard-Belegung nach "Standard Gamepad", Xbox-Namen)
    // Knopf-Nummern: 0=A 1=B 2=X 3=Y 4=LB 5=RB 6=LT 7=RT 8=Back 9=Start
    //                10=linker Stick drücken 11=rechter Stick drücken
    //                12=Steuerkreuz hoch 13=runter 14=links 15=rechts
    gamepad: {
      jump: 0, // A / Kreuz
      toggleBuildMode: 1, // B / Kreis
      reload: 2, // X / Quadrat
      use: 3, // Y / Dreieck
      prevWeapon: 4, // L1
      nextWeapon: 5, // R1
      aim: 6, // L2
      fire: 7, // R2
      scoreboard: 8,
      pause: 9,
      crouchOrRotate: 11, // R3
      edit: 13, // Steuerkreuz unten
      emote: 12, // Steuerkreuz hoch
      switchMaterial: 14, // Steuerkreuz links
      // Im Baumodus haben die Schultertasten eine andere Aufgabe:
      buildMode: {
        wall: 7, // R2
        ramp: 6, // L2
        floor: 5, // R1
        roof: 4, // L1
      },
      aimAssist: {
        enabled: true, // nur für Controller, im Menü abschaltbar
        slowdownFactor: 0.7, // Drehung um 30 % langsamer, wenn ein Gegner nah am Fadenkreuz ist
        radiusDeg: 4, // "nah am Fadenkreuz" = innerhalb von 4°
        maxDistance: 60, // nur Gegner bis 60 m
        // Keine automatische Ausrichtung auf Gegner – nur "Klebe-Effekt".
      },
    },

    // Handy / Touch (optional, Phase 11). Positionen in % vom Bildschirm.
    touch: {
      autoShoot: false, // schießt automatisch, wenn das Fadenkreuz auf einem Gegner ist
      stickRadiusPx: 60,
      layout: {
        stick: { x: 14, y: 72 },
        fire: { x: 88, y: 62 },
        jump: { x: 92, y: 80 },
        crouch: { x: 80, y: 86 },
        edit: { x: 78, y: 72 },
        reload: { x: 82, y: 50 },
        buildWall: { x: 6, y: 44 },
        buildFloor: { x: 13, y: 40 },
        buildRamp: { x: 20, y: 44 },
        buildRoof: { x: 27, y: 48 },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Material (zum Bauen)
  // ---------------------------------------------------------------------------
  materials: {
    order: ['wood', 'stone', 'metal'], // Reihenfolge beim Wechseln mit Q
    names: { wood: 'Holz', stone: 'Stein', metal: 'Metall' },
    costPerPiece: 10, // SCHÄTZUNG
    maxPerType: 999, // SCHÄTZUNG
    // Aufbau-Zeit: neue Teile starten mit wenig Leben und "wachsen" auf 100 %.
    // Das Teil blockiert Schüsse aber sofort.
    startHealthFraction: 0.1, // SCHÄTZUNG
    buildTime: { wood: 1.0, stone: 2.0, metal: 3.0 }, // Sekunden bis 100 % // SCHÄTZUNG
    // Sammeln mit der Spitzhacke (Battle Royale)
    harvestPerHit: { min: 5, max: 10 }, // SCHÄTZUNG
    harvestSources: { tree: 'wood', rock: 'stone', car: 'metal', metalFence: 'metal' },
  },

  // ---------------------------------------------------------------------------
  // Bauen
  // ---------------------------------------------------------------------------
  building: {
    pieceTypes: ['wall', 'floor', 'ramp', 'roof'],
    pieceNames: { wall: 'Wand', floor: 'Boden', ramp: 'Rampe', roof: 'Dach' },
    // Lebenspunkte bei 100 % Aufbau
    maxHealth: {
      wall: { wood: 150, stone: 300, metal: 500 }, // SCHÄTZUNG
      floor: { wood: 140, stone: 280, metal: 460 }, // SCHÄTZUNG
      ramp: { wood: 140, stone: 280, metal: 460 }, // SCHÄTZUNG
      roof: { wood: 140, stone: 280, metal: 460 }, // SCHÄTZUNG
    },
    placeCooldown: 0.05, // Mindestabstand zwischen zwei Platzierungen (schnelles "Spammen" geht)
    maxPlaceCells: 1, // höchstens 1 Zelle vor der eigenen Zelle
    maxPieces: 3000, // mehr Bauteile gleichzeitig gibt es nicht (Leistung)
    pieceThickness: 0.2, // Dicke von Wand/Boden/Dach (m) // SCHÄTZUNG
    rampSlopeDeg: 45, // Steigung der Rampe
    roofHeight: 1.5, // so hoch ist die Spitze des Dachs (Pyramide) über ihrer Grundfläche // SCHÄTZUNG
    collapseDelay: 0.1, // so lange nach Zerstörung fallen lose Teile weg (Vorgabe)
    collapseAnimTime: 0.4, // Dauer der kleinen Zerfalls-Animation (Absacken + Verblassen)
    // Edit-Raster: Spalten x Reihen
    editGrid: {
      wall: { cols: 3, rows: 3 },
      floor: { cols: 2, rows: 2 },
      ramp: { cols: 2, rows: 2 },
      roof: { cols: 2, rows: 2 },
    },
    // Tür = die mittleren unteren 2 Felder einer Wand (Feld-Nummern 0..8,
    // oben links = 0, unten rechts = 8)
    wallDoorCells: [4, 7],
    previewColorOk: '#4DA6FF', // Vorschau: blau = geht
    previewColorBlocked: '#FF4D4D', // Vorschau: rot = geht nicht
    previewOpacity: 0.35,
    previewOccupiedEdgeOpacity: 0.5, // Platz belegt (z. B. gerade gesetzt): nur ein dünner roter Umriss, keine Fläche

    // --- Zielwahl: wohin kommt das Bauteil? (Welle 2a, siehe src/building/grid.js) ---
    // "Blick-Anker" = Punkt auf dem Blick-Strahl so weit vor den Augen (m). Seine Zelle
    // ist das Ziel für Boden/Rampe/Dach. Trifft der Strahl vorher einen Boden, liegt
    // der Anker dort ("die Zelle, auf die du schaust").
    targetReach: { wall: 3.4, floor: 3.4, ramp: 3.4, roof: 1.8 }, // SCHÄTZUNG (Gefühl wie im Original)
    levelEpsilon: 0.3, // so knapp (m) unter der nächsten Ebene zählt man schon zu ihr (Sprung bei 90ern)
    lookUpPitch: 40, // Blick höher als 40° nach oben → Bauteil eine Ebene höher // SCHÄTZUNG
    lookDownDrop: 0.5, // liegt der Anker so weit (m) unter der eigenen Ebene (Blick über eine Kante) → eine Ebene tiefer
    // Wand in der Nachbar-Spalte (schräg vor einem) nur, wenn der Anker so weit (m) jenseits der
    // eigenen Spalte liegt – sonst bleibt sie an der eigenen Zelle (360° drehen = 4 Wände) // SCHÄTZUNG
    wallColumnMargin: 0.6,
    // Bau-Grenze nach oben: höchste Ebene (0 = Boden, 1 Ebene = 4 m). Karten können eine eigene
    // haben (map.buildBounds.maxLevel) und seitliche Grenzen (Arena: die Mauer) // SCHÄTZUNG
    maxLevel: 30,
    rotationSteps: 4, // R dreht die Rampe in 90°-Schritten (4 Richtungen)
    supportTolerance: 0.05, // so nah (m) müssen sich Teile kommen, um sich zu halten (Berührung)
    // Eine neue Wand, in der eine Figur steht, schiebt sie zur Seite hinaus (wie im Original –
    // eine Wand ist nie vom eigenen Körper blockiert). So viel Luft (m) bleibt danach zur Wand.
    wallPushGap: 0.01,

    // --- Edit und Türen ---
    editReach: 7, // G: so weit (m) darf das Bauteil vom Fadenkreuz-Anfang weg sein // SCHÄTZUNG
    editMaxDistance: 10, // entfernt man sich weiter vom editierten Teil, schließt der Edit
    useReach: 4.5, // E: Tür, auf die man schaut, bis so weit (m) // SCHÄTZUNG
    doorNearDistance: 2.2, // … oder die nächste Tür, wenn man so nah (m) davor steht
    doorOpenTime: 0.2, // so lange (s) schwingt die Tür auf/zu (nur Grafik – Durchgang sofort frei)
    doorOpenAngle: 100, // so weit (°) schwingt die Tür auf
    hintCooldown: 1.5, // Hinweis "fremdes Bauteil" höchstens alle 1,5 s

    // --- Aussehen ---
    textureSize: 256, // Pixel der erzeugten Holz/Stein/Metall-Bilder (1 Bild = 4 x 4 m)
    crackThreshold: 0.5, // unter 50 % Leben: Risse
    damageDarkening: 0.45, // so viel dunkler wird ein Teil bei 0 % Leben (0 = gar nicht, 1 = schwarz)
    constructionOpacity: { start: 0.45, end: 0.85 }, // Aufbau: leicht durchsichtig, wird fester
    collapseSink: 1.2, // Einsturz-Animation: so weit (m) sackt ein Teil ab, während es verblasst
    editTileColor: '#7FE3FF', // Edit-Kacheln: leuchtend hellblau
    editTileSelectedColor: '#FF4D4D', // gewählte Felder (werden entfernt): rot
    editTileHoverColor: '#FFFFFF', // Feld unter dem Fadenkreuz
    editTileOpacity: 0.45,
  },

  // ---------------------------------------------------------------------------
  // Waffen – alle Werte sind geschätzt (das Original hat keine Zahlen veröffentlicht)
  // ---------------------------------------------------------------------------
  // Schadens-Abfall ("falloff"): bis "fullUntil" Meter voller Schaden, danach
  // wird es weniger, ab "minAt" Metern gilt nur noch "minFactor" (z. B. 0,2 = 20 %).
  // Streuung ("spreadDeg", "baseDeg" …): Öffnungswinkel des ganzen Kegels in Grad.
  // Ein Schuss weicht also höchstens um den HALBEN Wert von der Bildmitte ab
  // (Schrotflinte 6° → höchstens 3° → auf 5 m treffen alle Kugeln eine Figur).
  weapons: {
    switchTime: 0.25, // Waffen-Wechsel dauert 0,25 s // SCHÄTZUNG
    aimMoveFactor: 0.7, // beim Zielen läuft man mit 70 % Tempo // SCHÄTZUNG
    // Treffer-Prüfung für Strahl-Waffen: erst von der Kamera-Mitte, dann prüfen,
    // ob von der Waffe aus der Weg frei ist (kein Schießen um Ecken).
    muzzleCheck: true,

    shotgun: {
      name: 'Pump-Schrotflinte',
      slot: 1,
      kind: 'hitscan', // sofortiger Strahl
      pellets: 10, // SCHÄTZUNG
      damagePerPellet: 9, // 10 x 9 = max. 90 // SCHÄTZUNG
      headMultiplier: 1.5, // SCHÄTZUNG
      fireInterval: 0.8, // 1 Schuss alle 0,8 s // SCHÄTZUNG
      magazine: 5, // SCHÄTZUNG
      reloadMode: 'perShell', // Schuss für Schuss nachladen
      reloadTime: 4.5, // für ein ganz leeres Magazin // SCHÄTZUNG
      reloadTimePerShell: 0.9, // 4,5 s / 5 Schuss // SCHÄTZUNG
      falloff: { fullUntil: 5, minAt: 25, minFactor: 0.2 }, // SCHÄTZUNG
      maxRange: 40, // SCHÄTZUNG
      structureDamage: 60, // an Bauteilen, gesamt pro Schuss // SCHÄTZUNG
      spreadDeg: 6, // fester Kegel // SCHÄTZUNG
      crosshair: 'circle',
    },

    ar: {
      name: 'Sturmgewehr',
      slot: 2,
      kind: 'hitscan',
      damage: 30, // SCHÄTZUNG
      headMultiplier: 1.5, // SCHÄTZUNG
      fireRate: 5.5, // Schuss pro Sekunde // SCHÄTZUNG
      automatic: true,
      magazine: 30, // SCHÄTZUNG
      reloadTime: 2.2, // SCHÄTZUNG
      falloff: { fullUntil: 30, minAt: 60, minFactor: 0.6 }, // SCHÄTZUNG
      maxRange: 300, // SCHÄTZUNG
      structureDamage: 25, // SCHÄTZUNG
      spread: { baseDeg: 0.6, movingMultiplier: 2, aimMultiplier: 0.4 }, // SCHÄTZUNG
      tracer: true, // Leuchtspur
      crosshair: 'cross',
    },

    smg: {
      name: 'Maschinenpistole',
      slot: 4,
      kind: 'hitscan',
      damage: 17, // SCHÄTZUNG
      headMultiplier: 1.5, // SCHÄTZUNG
      fireRate: 12, // SCHÄTZUNG
      automatic: true,
      magazine: 30, // SCHÄTZUNG
      reloadTime: 2.0, // SCHÄTZUNG
      falloff: { fullUntil: 12, minAt: 30, minFactor: 0.5 }, // SCHÄTZUNG
      maxRange: 150, // SCHÄTZUNG
      structureDamage: 18, // SCHÄTZUNG
      spread: { baseDeg: 1.2, movingMultiplier: 1.6, aimMultiplier: 0.6 }, // SCHÄTZUNG
      tracer: false,
      crosshair: 'cross',
    },

    sniper: {
      name: 'Scharfschützengewehr',
      slot: 3,
      kind: 'projectile', // echtes Geschoss mit Flugzeit
      damage: 105, // SCHÄTZUNG
      headMultiplier: 2.5, // SCHÄTZUNG
      fireInterval: 1.6, // SCHÄTZUNG
      magazine: 1, // SCHÄTZUNG
      reloadTime: 2.5, // SCHÄTZUNG
      projectileSpeed: 300, // m/s // SCHÄTZUNG
      projectileGravity: 4, // "leichter Fall" in m/s² // SCHÄTZUNG
      projectileMaxLifetime: 3, // danach verschwindet das Geschoss
      structureDamage: 50, // SCHÄTZUNG
      spread: { hipDeg: 4, aimedDeg: 0 }, // aus der Hüfte ungenau, mit Zielfernrohr genau // SCHÄTZUNG
      scopeOverlay: true,
      crosshair: 'dot',
    },

    pistol: {
      name: 'Pistole',
      slot: 4, // teilt sich Platz 4 mit der Maschinenpistole
      kind: 'hitscan',
      damage: 24, // SCHÄTZUNG
      headMultiplier: 1.5, // SCHÄTZUNG
      fireRate: 6, // SCHÄTZUNG
      automatic: true, // laut Fan-Videos automatisch
      magazine: 16, // SCHÄTZUNG
      reloadTime: 1.5, // SCHÄTZUNG
      falloff: { fullUntil: 20, minAt: 45, minFactor: 0.6 }, // SCHÄTZUNG
      maxRange: 150, // SCHÄTZUNG
      structureDamage: 20, // SCHÄTZUNG
      spread: { baseDeg: 0.9, movingMultiplier: 1.8, aimMultiplier: 0.5 }, // SCHÄTZUNG
      tracer: false,
      crosshair: 'cross',
    },

    grenadeLauncher: {
      name: 'Granatwerfer',
      slot: 4,
      kind: 'projectile',
      explosionDamage: 70, // in der Mitte der Explosion // SCHÄTZUNG
      explosionRadius: 4, // SCHÄTZUNG
      edgeDamageFactor: 0.3, // am Rand der Explosion nur noch 30 % // SCHÄTZUNG
      damageThroughWalls: true, // trifft auch hinter Wänden
      fireInterval: 1.0, // SCHÄTZUNG
      magazine: 6, // SCHÄTZUNG
      reloadTime: 3.0, // SCHÄTZUNG
      projectileSpeed: 35, // Bogenflug // SCHÄTZUNG
      projectileGravity: 20, // SCHÄTZUNG
      fuseTime: 3, // explodiert spätestens nach 3 s // SCHÄTZUNG
      structureDamage: 150, // SCHÄTZUNG
      crosshair: 'cross',
    },

    pickaxe: {
      name: 'Spitzhacke',
      kind: 'melee',
      playerDamage: 20, // SCHÄTZUNG
      structureDamage: 50, // SCHÄTZUNG
      swingInterval: 0.5, // SCHÄTZUNG
      range: 2, // SCHÄTZUNG
    },

    // Munitions-Vorrat (Reserve) je Waffe, wenn ein Modus nicht "unendlich" hat
    defaultReserveAmmo: {
      shotgun: 15, // SCHÄTZUNG
      ar: 120, // SCHÄTZUNG
      smg: 120, // SCHÄTZUNG
      sniper: 8, // SCHÄTZUNG
      pistol: 64, // SCHÄTZUNG
      grenadeLauncher: 12, // SCHÄTZUNG
    },

    // --- Feinheiten (Phase 5) ---------------------------------------------------
    // Halb-automatische Waffen (Schrotflinte, Sniper, Granatwerfer) schießen pro
    // Klick einmal. Ein Klick kurz vor Ende der Wartezeit wird gemerkt und zählt dann.
    fireBufferTime: 0.2, // so lange (s) wird ein zu früher Klick gemerkt // SCHÄTZUNG
    autoReloadWhenEmpty: true, // Magazin leer → lädt sofort von selbst nach
    friendlyFire: false, // eigenes Team nimmt keinen Schaden (Schüsse fliegen hindurch)
    selfDamage: false, // eigene Granaten verletzen einen selbst nicht // SCHÄTZUNG
    // Mündung (für die Prüfung "kein Schießen um Ecken"): so weit von den Augen weg
    muzzleOffset: { right: 0.25, forward: 0.35, down: 0.15 }, // m
    movingSpeed: 0.5, // ab so viel m/s zählt man als "in Bewegung" (mehr Streuung); in der Luft immer
    projectileAimRange: 1000, // Geschosse fliegen zu dem Punkt, den das Fadenkreuz trifft (höchstens so weit, m)
    // In der Hand halten: Heil-Items liegen immer auf Platz 5
    healSlot: 5,
    // Spitzhacke sammelt Material: CONFIG.materials.harvestPerHit (5–10 pro Schlag)
  },

  // Seltenheiten (nur Farbe + kleiner Schadens-Bonus im Battle Royale)
  // Hinweis für später: Grün sieht fast aus wie Gras – Boden-Loot bekommt darum in
  // Phase 9 ein Leuchten. Schadenszahlen (Phase 5) bekommen einen dunklen Rand,
  // damit Weiß/Gelb/Blau auch vor dem hellen Himmel lesbar sind.
  rarities: {
    order: ['common', 'uncommon', 'rare', 'epic', 'legendary'],
    common: { name: 'Gewöhnlich', color: '#A0A7AE', damageMultiplier: 1.0 }, // SCHÄTZUNG
    uncommon: { name: 'Ungewöhnlich', color: '#5BC74A', damageMultiplier: 1.05 }, // SCHÄTZUNG
    rare: { name: 'Selten', color: '#3E8BFF', damageMultiplier: 1.1 }, // SCHÄTZUNG
    epic: { name: 'Episch', color: '#A64DFF', damageMultiplier: 1.15 }, // SCHÄTZUNG
    legendary: { name: 'Legendär', color: '#F5A623', damageMultiplier: 1.2 }, // SCHÄTZUNG
  },

  // Heil-Items (Battle Royale) – Platz 5
  healing: {
    moveSpeedFactor: 0.5, // beim Benutzen langsamer laufen // SCHÄTZUNG
    cancelOnWeaponSwitch: true,
    bandage: { name: 'Verband', heals: 'health', amount: 15, maxTo: 75, useTime: 3, stack: 15 }, // SCHÄTZUNG
    medkit: { name: 'Medikit', heals: 'health', amount: 100, maxTo: 100, useTime: 8, stack: 3 }, // SCHÄTZUNG
    smallShield: { name: 'Kleiner Schildtrank', heals: 'shield', amount: 25, maxTo: 50, useTime: 2, stack: 6 }, // SCHÄTZUNG
    bigShield: { name: 'Großer Schildtrank', heals: 'shield', amount: 50, maxTo: 100, useTime: 4, stack: 3 }, // SCHÄTZUNG
  },

  // ---------------------------------------------------------------------------
  // Waffen-Optik (Phase 5): Mündungsblitz, Leuchtspur, Geschosse, Schadenszahlen
  // ---------------------------------------------------------------------------
  weaponVisuals: {
    muzzleFlashTime: 0.06, // so lange leuchtet der Mündungsblitz (s)
    muzzleFlashSize: 0.45, // Größe des Blitzes (m)
    muzzleLight: { color: '#FFC56B', intensity: 6, distance: 5 }, // kurzes Licht beim Schuss
    tracerLifetime: 0.09, // Leuchtspur (Sturmgewehr) verblasst in so vielen Sekunden
    tracerWidth: 0.035, // Dicke der Leuchtspur (m)
    tracerColor: '#FFD45C',
    modelScale: 1.35, // Waffen in der Hand etwas größer als echt (Comic-Stil, besser zu erkennen)
    // Blick steil nach oben: Waffe zeigt etwas tiefer als der Blick (sonst ragt sie ins Fadenkreuz)
    lookUpLowering: 0.4, // so viel tiefer pro Radiant Blick nach oben
    lookUpLoweringFrom: 0.2, // ab dieser Blick-Neigung (Radiant)
    holdTiltDown: 0.09, // Waffe zeigt immer ein klein wenig tiefer als der Blick (Radiant)
    holdTiltIn: 0.11, // … und ein klein wenig zur Körpermitte (Radiant)
    recoilKick: 0.06, // Waffe zuckt beim Schuss so weit nach hinten (m)
    harvestFullText: 'voll', // Spitzhacke bei vollem Material (999): statt "+N" diese Anzeige
    // Eigene Figur ausgeblendet (Kamera dicht am Kopf) oder Zielfernrohr: kein Mündungsblitz,
    // Leuchtspur/Geschoss-Streifen beginnen erst so weit (m) vor der Kamera
    hiddenShotStartDistance: 1.5,
    bulletColor: '#FFF3C4', // Scharfschützen-Geschoss (Leuchtstreifen)
    bulletLength: 2.2, // Länge des Leuchtstreifens (m)
    grenadeColor: '#3B4A3A',
    grenadeRadius: 0.09, // m
    explosionTime: 0.45, // Feuerball wächst und verblasst in so vielen Sekunden
    explosionColor: '#FF7A1F', // Feuerball außen
    explosionCoreColor: '#FFD34D', // Feuerball innen
    // Treffer-Zahlen über dem Ziel (weiß = Körper, gelb = Kopf, blau = Schild; Farben: visuals.colors)
    damageNumbers: {
      lifetime: 0.9, // so lange sichtbar (s)
      rise: 0.9, // steigen dabei so weit nach oben (m)
      fontPx: 26, // Schrift-Größe (Pixel)
      headFontPx: 32, // Kopfschuss größer
      structureFontPx: 18, // Treffer an Bauteilen: klein und grau
      structureColor: '#D8DCE3',
      harvestColor: '#FFE2A8', // "+7" beim Sammeln mit der Spitzhacke
      onlyOwnHits: true, // nur Treffer des Spielers anzeigen (wie im Original)
      showStructureHits: true,
      pool: 32, // so viele Zahlen gleichzeitig höchstens
    },
    // Zielfernrohr-Bild (vorläufig, bis das HUD in Phase 6 kommt)
    scopeOverlayColor: 'rgba(5, 8, 12, 0.94)',
  },

  // ---------------------------------------------------------------------------
  // Übungsplatz: Waffen, Zielpuppen, Sammel-Objekte (Phase 5)
  // ---------------------------------------------------------------------------
  practiceRange: {
    // Waffen-Plätze 1–5. Mehrere Namen in einem Platz = gleiche Taste nochmal drücken wechselt
    // (4 → Maschinenpistole, nochmal 4 → Pistole, nochmal 4 → Granatwerfer).
    loadoutSlots: [
      ['shotgun'],
      ['ar'],
      ['sniper'],
      ['smg', 'pistol', 'grenadeLauncher'],
      ['bandage', 'medkit', 'smallShield', 'bigShield'],
    ],
    infiniteReserveAmmo: true, // Munition geht nie aus (nur das Magazin)
    infiniteHeals: true, // Heil-Items gehen nie aus
    // Schieß-Stand: hier stehen und nach Westen (−X) schauen
    stand: { x: 35, z: 33 },
    dummies: {
      health: 1000, // viel Leben, damit man lange üben kann
      shield: 100, // nur die Puppe mit "shield: true"
      regenDelay: 1.5, // so lange nach dem letzten Treffer wieder voll (s)
      respawnDelay: 1.5, // falls eine Puppe doch umfällt: so schnell steht sie wieder
      // Abstand vom Schieß-Stand (m); side = seitlich versetzt (m, nach Süden +).
      // Die Versätze sind so gewählt, dass keine Puppe eine andere verdeckt.
      list: [
        { distance: 5, side: 3 },
        { distance: 15 },
        { distance: 15, side: -3, shield: true },
        { distance: 30, side: 4 },
        { distance: 60, side: -6 },
      ],
      skin: { body: '#E9D8B4', accent: '#C0392B', skinTone: '#E9D8B4', hat: 'helmet', hatColor: '#C0392B' },
    },
    // Sammel-Objekte für die Spitzhacke (F): Baum = Holz, Fels = Stein, Auto = Metall
    harvest: {
      tree: { x: -30, z: 19 },
      rock: { x: -24, z: 19 },
      car: { x: -17, z: 19 },
    },
  },

  // ---------------------------------------------------------------------------
  // Bots (Gegner-KI)
  // ---------------------------------------------------------------------------
  bots: {
    defaultDifficulty: 'medium',
    difficulties: {
      easy: { name: 'Leicht', reactionMs: 600, aimErrorDeg: 4, buildsPerSecond: 1 },
      medium: { name: 'Mittel', reactionMs: 350, aimErrorDeg: 2, buildsPerSecond: 2 },
      hard: { name: 'Schwer', reactionMs: 200, aimErrorDeg: 1, buildsPerSecond: 4 },
    },
    // Zustände: Suchen -> Annähern -> Kämpfen -> Deckung -> Heilen -> Fliehen (vor der Zone)
    states: ['search', 'approach', 'fight', 'cover', 'heal', 'flee'],
    wallWhenHitChance: 0.7, // wenn getroffen: mit 70 % Chance eine Wand vor sich
    lowHealthThreshold: 40, // darunter: Box bauen und heilen
    hearingRange: 60, // hören Schüsse im Umkreis von 60 m
    sightRange: 150, // sehen (ohne Wände dazwischen) bis 150 m
    // Waffenwahl nach Abstand
    weaponRanges: { shotgunBelow: 8, sniperAbove: 50 }, // dazwischen: Sturmgewehr
    names: ['Bot_1', 'Bot_2', 'Bot_3', 'Bot_4', 'Bot_5', 'Bot_6', 'Bot_7', 'Bot_8', 'Bot_9',
      'Bot_10', 'Bot_11', 'Bot_12', 'Bot_13', 'Bot_14', 'Bot_15', 'Bot_16', 'Bot_17', 'Bot_18',
      'Bot_19', 'Bot_20', 'Bot_21', 'Bot_22', 'Bot_23'],
  },

  // ---------------------------------------------------------------------------
  // Spielmodi
  // ---------------------------------------------------------------------------
  modes: {
    duel: {
      name: 'Duell 1v1',
      arenaSize: 80, // 80 x 80 m
      spawnDistance: 40, // Abstand der beiden Startpunkte
      roundsToWin: 5, // wer zuerst 5 Runden gewinnt
      roundPause: 3, // Pause zwischen Runden (s)
      startHealth: 100,
      startShield: 100, // SCHÄTZUNG (100 Leben + 100 Schild)
      startMaterials: { wood: 500, stone: 500, metal: 500 }, // SCHÄTZUNG
      loadout: ['shotgun', 'ar', 'sniper', 'smg'], // SCHÄTZUNG
      infiniteReserveAmmo: true, // SCHÄTZUNG
      trophiesWin: 25,
      trophiesLoss: -15,
    },

    battleRoyale: {
      name: 'Battle Royale',
      islandSize: 600, // 600 x 600 m
      totalPlayers: 10, // du + 9 Bots; Quellen nennen 10, 16 oder 24 – CrazyGames sagt "bis zu 10"
      minPlayers: 2,
      maxPlayers: 24,
      startHealth: 100,
      startShield: 0,
      startMaterials: { wood: 0, stone: 0, metal: 0 },
      // Absprung
      jumpVehicleHeight: 120, // Flughöhe des fliegenden Objekts // SCHÄTZUNG
      jumpVehicleSpeed: 30, // SCHÄTZUNG
      freefallSpeed: 30, // Fall-Tempo im freien Fall // SCHÄTZUNG
      freefallMoveSpeed: 15, // seitliches Lenken im freien Fall // SCHÄTZUNG
      gliderDeployHeight: 30, // ab 30 m über dem Boden öffnet der Gleiter automatisch // SCHÄTZUNG
      gliderFallSpeed: 6, // SCHÄTZUNG
      gliderMoveSpeed: 14, // SCHÄTZUNG
      // Sturm-Zone: 5 Phasen. wait = Warten, shrink = Schrumpfen (s), dps = Schaden pro Sekunde draußen
      storm: {
        initialRadius: 430, // deckt am Anfang die ganze Insel ab
        phases: [
          { wait: 60, shrink: 45, dps: 1, endRadius: 200 }, // SCHÄTZUNG
          { wait: 45, shrink: 40, dps: 2, endRadius: 120 }, // SCHÄTZUNG
          { wait: 40, shrink: 35, dps: 5, endRadius: 65 }, // SCHÄTZUNG
          { wait: 30, shrink: 30, dps: 8, endRadius: 30 }, // SCHÄTZUNG
          { wait: 20, shrink: 30, dps: 10, endRadius: 0 }, // SCHÄTZUNG
        ],
        // Die neue Zone liegt immer komplett in der alten.
      },
      chest: {
        materialAmount: 30, // je Kiste von einer zufälligen Sorte // SCHÄTZUNG
        ammoMagazines: 2, // Munition für 2 Magazine // SCHÄTZUNG
        healItemChance: 0.5, // SCHÄTZUNG
      },
      rarityWeights: { common: 40, uncommon: 30, rare: 18, epic: 9, legendary: 3 }, // SCHÄTZUNG
      trophiesByPlacement: [40, 25, 15, 10, 5], // Platz 1..5, danach 0
      trophiesPerKill: 5,
      trophiesEarlyOut: -10, // als Erster/Zweiter raus
    },

    boxFight: {
      name: 'Box Fight',
      teamSizes: [1, 2], // 1v1 oder 2v2 (mit Bot-Partner)
      roundsToWin: 5,
      roundPause: 3,
      startHealth: 100,
      startShield: 100, // SCHÄTZUNG (100 Leben + 100 Schild)
      startMaterials: { wood: 200, stone: 200, metal: 200 }, // Plan nennt 500 und 200 – hier gilt der Wert aus dem Modus-Abschnitt // SCHÄTZUNG
      loadout: ['shotgun', 'smg'], // Vorgabe: nur Schrotflinte + Maschinenpistole
      infiniteReserveAmmo: true, // SCHÄTZUNG
      boxGapCells: 0, // die zwei Boxen stehen direkt nebeneinander
    },

    zoneWars: {
      name: 'Zone Wars',
      totalPlayers: 6, // du + 5 Bots
      mapSize: 160,
      roundDuration: 90, // ganze Runde ca. 90 s // SCHÄTZUNG
      startHealth: 100,
      startShield: 100, // SCHÄTZUNG
      startMaterials: { wood: 300, stone: 300, metal: 300 }, // Plan nennt 500 und 300 – hier gilt der Wert aus dem Modus-Abschnitt // SCHÄTZUNG
      randomLoadout: true,
      storm: {
        initialRadius: 80, // SCHÄTZUNG
        moving: true, // Zone wandert und schrumpft
        phases: [
          { wait: 10, shrink: 20, dps: 5, endRadius: 50 }, // SCHÄTZUNG
          { wait: 8, shrink: 18, dps: 8, endRadius: 25 }, // SCHÄTZUNG
          { wait: 6, shrink: 16, dps: 12, endRadius: 8 }, // SCHÄTZUNG
          { wait: 4, shrink: 8, dps: 20, endRadius: 0 }, // SCHÄTZUNG
        ],
      },
    },

    justBuild: {
      name: 'Freies Bauen',
      infiniteMaterials: true,
      showPiecesPerSecond: true,
    },

    aimTrainer: {
      name: 'Aim Trainer',
      duration: 60, // Länge einer Runde (s)
      targetLifetime: 1.5, // Zielscheiben verschwinden nach 1,5 s
      spawnInterval: 0.7,
      targetRadius: 0.5,
      headRadius: 0.18,
      minDistance: 8,
      maxDistance: 35,
    },

    deathmatch: {
      name: 'Deathmatch',
      totalPlayers: 8, // du + 7 Bots
      killsToWin: 20,
      respawnDelay: 3,
      spawnProtection: 2, // 2 s unverwundbar nach dem Wiederbeleben
      startHealth: 100,
      startShield: 50,
      startMaterials: { wood: 300, stone: 300, metal: 300 },
      loadout: ['shotgun', 'ar', 'sniper', 'smg'],
      infiniteReserveAmmo: true,
    },

    // Übungsplatz (Phase 2): zum Ausprobieren von Laufen, Springen, Ducken, Kamera
    practice: {
      name: 'Übungsplatz',
      arenaSize: 80, // 80 x 80 m
      borderHeight: 3, // Rand-Mauer
      startHealth: 100,
      startShield: 100,
      startMaterials: { wood: 999, stone: 999, metal: 999 },
      infiniteMaterials: true, // ab Phase 3: frei bauen zum Üben
      idleBots: 4, // stehende Übungs-Figuren (ohne KI)
      stepHeights: [0.3, 1, 2], // Kisten zum Testen: 0,3 m geht man hoch, 1 m und 2 m nicht
      highWall: 4, // hohe Wand (Kamera-Test)
      platformHeight: 4, // Plattform am Ende der 45°-Rampe
      towerHeight: 12, // hoher Turm (Fallschaden-Test: 12 m → 50 Schaden)
      lowCeiling: 1.5, // niedrige Decke: nur geduckt passt man durch
      bridgeRampHeight: 3, // frei stehende Rampe, unter der man durchlaufen kann (Unterkante)
      respawnDelay: 2, // nach dem Besiegtwerden (z. B. vom Turm gefallen) so schnell wieder da
      spawn: { x: 0, z: 22 }, // Startpunkt (schaut Richtung −Z auf die Stationen)
    },

    // Später / optional
    zombies: { name: 'Zombies', enabled: false },
    zeroBuilds: { name: 'Ohne Bauen', enabled: false },
    team4v4: { name: 'Team 4v4', enabled: false },
  },

  // ---------------------------------------------------------------------------
  // Optik
  // ---------------------------------------------------------------------------
  visuals: {
    labelMinScreenHeight: 22, // Schilder (Übungsplatz) sind auf dem Bildschirm mindestens so hoch (Pixel) – lesbar auch von weit weg
    labelMaxGrow: 4, // … dafür werden sie höchstens 4-mal so groß
    colors: {
      skyTop: '#3A8DDE', // Himmel oben
      skyHorizon: '#7EC8F2', // Himmel am Horizont
      grass: '#5DBB4C',
      desert: '#E3C47A',
      water: '#3FB7D9',
      storm: '#8E3FD8',
      wood: '#D9A066',
      stone: '#9C9C9C',
      metal: '#7D8FA3',
      damageBody: '#FFFFFF', // Schadenszahl: Körper
      damageHead: '#FFD93D', // Schadenszahl: Kopf
      damageShield: '#4FC3F7', // Schadenszahl: Schild
    },
    stormOpacity: 0.35,
    fogStartFraction: 0.15, // leichter Nebel beginnt bei 15 % der Sichtweite …
    fogEndFraction: 0.9, // … und verdeckt ab 90 % alles (Horizont-Farbe)
    // Sonne: Richtung, aus der das Licht kommt (wird normalisiert)
    sunDirection: { x: -0.55, y: 1.0, z: 0.35 },
    sunIntensity: 2.6,
    hemiIntensity: 1.6, // weiches Licht von Himmel und Boden (Comic-Look: eher hell)
    shadowArea: 70, // Schatten werden im Umkreis von 70 m berechnet
    groundGridLines: true, // feine Linien im 4-m-Bauraster auf dem Boden
    groundGridOpacity: 0.07,
  },

  // Figuren-Aussehen ("Skins" = Farbsets + Hut-Form). Eigene Platzhalter, keine Original-Skins.
  // body = Oberteil, accent = Hose/Rucksack, skinTone = Haut, hat = Hut-Form, hatColor = Hut-Farbe
  skins: {
    hatShapes: ['none', 'cap', 'beanie', 'cone', 'tophat', 'crown', 'helmet', 'headband'],
    defaultId: 'sonne',
    list: [
      { id: 'sonne', name: 'Sonnenschein', body: '#FFB627', accent: '#3A6EA5', skinTone: '#F2C9A0', hat: 'cap', hatColor: '#E8483B' },
      { id: 'ozean', name: 'Ozean', body: '#2EC4E6', accent: '#1D3557', skinTone: '#C68E6B', hat: 'beanie', hatColor: '#F1FAEE' },
      { id: 'wald', name: 'Waldläufer', body: '#56C271', accent: '#6B4F2A', skinTone: '#E8B98F', hat: 'helmet', hatColor: '#3E7C3A' },
      { id: 'kirsche', name: 'Kirsche', body: '#E8475F', accent: '#2B2D42', skinTone: '#F5D0B5', hat: 'headband', hatColor: '#FFFFFF' },
      { id: 'lava', name: 'Lava', body: '#FF6B35', accent: '#3D3D3D', skinTone: '#8D5A3B', hat: 'tophat', hatColor: '#222222' },
      { id: 'mitternacht', name: 'Mitternacht', body: '#5B5BD6', accent: '#1E1E3F', skinTone: '#D9A77E', hat: 'crown', hatColor: '#FFD23D' },
      { id: 'bonbon', name: 'Bonbon', body: '#FF8CC6', accent: '#7B2CBF', skinTone: '#F7D6BF', hat: 'cone', hatColor: '#4CC9F0' },
      { id: 'zitrone', name: 'Zitrone', body: '#F4E04D', accent: '#2A9D8F', skinTone: '#B07A55', hat: 'none', hatColor: '#000000' },
    ],
  },

  // Grafik-Qualität (ab Phase 11 im Menü wählbar)
  graphics: {
    quality: 'hoch', // 'niedrig' | 'mittel' | 'hoch'  ← bei Ruckeln auf 'mittel' stellen
    showFps: true,
    // maxPixelRatio ist der größte Hebel für die Leistung: Bei Bildschirmen mit
    // Windows-Skalierung 150–200 % malt der Browser sonst 2–4-mal so viele Pixel.
    presets: {
      niedrig: { shadows: false, shadowMapSize: 512, maxPixelRatio: 1, resolutionScale: 0.75, antialias: false, viewDistance: 250 },
      mittel: { shadows: true, shadowMapSize: 1024, maxPixelRatio: 1.25, resolutionScale: 1, antialias: true, viewDistance: 450 },
      hoch: { shadows: true, shadowMapSize: 2048, maxPixelRatio: 1.5, resolutionScale: 1, antialias: true, viewDistance: 700 },
    },
  },

  // Ton (Lautstärken 0..1)
  audio: {
    master: 0.8,
    effects: 1.0,
    music: 0.5,
    refDistance: 5, // ab hier wird es leiser
    maxDistance: 120, // weiter weg hört man nichts mehr
    rolloff: 1.2,
  },

  // Fortschritt (Pokale, Münzen, Pass)
  progression: {
    passTiers: 20,
    xpPerTier: 1000,
    xpPerMatch: 150,
    xpPerKill: 50,
    xpPerWin: 300,
    coinsPerWin: 50,
    coinsPerMatch: 10,
  },

  // Hilfen für die Entwicklung
  debug: {
    showReferenceObjects: false, // Phase 1: Maßstab-Figur und eine Bau-Zelle anzeigen (true = einschalten)
    previewOrbitSpeed: 0.12, // Phase 1: so schnell dreht sich die Vorschau-Kamera (Radiant/s)
  },
});

// Friert ein Objekt samt allen Unter-Objekten ein (nichts kann es mehr ändern).
function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

// Liefert die Grafik-Voreinstellung samt Namen, z. B. { name: 'hoch', shadows: true, … }.
// Groß-/Kleinschreibung ist egal ('Hoch' = 'hoch'). Unbekannter Name → 'mittel'
// (mit Hinweis in der Browser-Konsole), damit das Spiel trotzdem startet.
export function getQualityPreset(name = CONFIG.graphics.quality) {
  const key = String(name).trim().toLowerCase();
  const presets = CONFIG.graphics.presets;
  if (Object.hasOwn(presets, key)) return { name: key, ...presets[key] };
  console.warn(`Grafik-Stufe "${name}" gibt es nicht – nehme "mittel". Erlaubt: ${Object.keys(presets).join(', ')}`);
  return { name: 'mittel', ...presets.mittel };
}
