// =============================================================================
// Bau-System (das Herzstück)
// =============================================================================
// createBuildingSystem(game) verwaltet alle Bauteile eines Spiels:
//   - Zielwahl + Vorschau (grid.js): wohin käme das Bauteil? blau = geht, rot = nicht
//   - Setzen: Platz frei, genug Material (10 pro Teil), höchstens 3000 Teile, keine
//     Figur im Weg, und das Teil braucht Halt (Boden/Karte oder ein anderes Teil).
//     Maus gedrückt halten = weiter setzen, sobald sich der Platz ändert ("Spammen").
//   - Aufbau: neue Teile starten mit 10 % Leben und wachsen (Holz 1 s, Stein 2 s,
//     Metall 3 s) – sie halten Schüsse aber sofort auf.
//   - Schaden (piece.applyDamage), Zerstören, Einsturz: Jedes Teil braucht eine
//     Verbindung zum Boden. Fällt ein tragendes Teil weg, sucht eine Breitensuche
//     über die Nachbarn, was noch Halt hat. Der Rest fällt nach 0,1 s weg
//     (kleine Absack-/Verblass-Animation).
//   - Edit-Modus und Türen (edit.js), Grafik (view.js, nur mit Bildschirm).
// Schnittstelle: ARCHITECTURE.md §9. Alle Zahlen: CONFIG.building / CONFIG.materials.
// =============================================================================
import { CONFIG } from '../config.js';
import { bodyFits } from '../player.js';
import {
  KINDS, slotKey, numericSlotKey, parseSlotKey, slotShape, createShape, colliderToShape, shapesTouch,
  shapeBottomAt, shapeOverlapsBox, shapeTopOverRect, selectTarget, createTarget, typeOfKind, tilesToMask,
  maskToTiles, isDoorMask, fullTileMask,
} from './grid.js';
import { pieceColliderSpecs, isDoorPiece, pieceCenter } from './pieces.js';
import { createEditController } from './edit.js';
import { createBuildingView } from './view.js';

const B = CONFIG.building;
const M = CONFIG.materials;
const KIND_OF_TYPE = { wall: null, floor: 'f', ramp: 'r', roof: 'c' };

/**
 * @param {object} game  Spiel (world, events, time, characters, headless, root …)
 */
export function createBuildingSystem(game) {
  const world = game?.world ?? null;
  const visual = !!(game && game.headless === false && game.root &&
    typeof document !== 'undefined' && typeof document.createElement === 'function');

  const pieces = new Map(); // Text-Schlüssel → Bauteil
  const byNum = new Map(); // Zahl-Schlüssel → Bauteil (schnell)
  const ownerCounts = new Map(); // Besitzer → Anzahl
  const constructing = new Set(); // Teile im Aufbau
  const doors = new Set(); // Teile, die gerade Türen sind
  const editedPieces = new Set(); // Teile mit Löchern
  const collapseQueue = []; // { piece, at, by }
  const states = new WeakMap(); // Figur → Bau-Zustand (Ziel, Abklingzeit …); entfernte Figuren fallen von selbst weg
  let generation = 1; // clearAll erhöht das → alte Zustände gelten als zurückgesetzt
  let nextId = 1;
  let visitStamp = 0;
  let safeStamp = 0;
  let view = null;

  // wiederverwendete Hilfs-Objekte
  const _shape = createShape();
  const _other = createShape();
  const _parsed = {};
  const _queue = [];
  const _list = [];
  const _qMin = { x: 0, y: 0, z: 0 };
  const _qMax = { x: 0, y: 0, z: 0 };

  function getPiece(kind, i, j, k) {
    return byNum.get(numericSlotKey(kind, i, j, k)) ?? null;
  }

  function stateOf(character) {
    let s = states.get(character);
    if (!s) {
      s = { target: createTarget(), hasTarget: false, nextPlaceTime: 0, lastKey: -1, generation };
      states.set(character, s);
    } else if (s.generation !== generation) {
      s.generation = generation;
      s.hasTarget = false;
      s.lastKey = -1;
      s.nextPlaceTime = 0;
    }
    return s;
  }

  // Blick-Strahl einer Figur: der Ziel-Strahl aus dem Befehl (Spieler = Fadenkreuz-Linie
  // aus der Kamera, Bot = Auge → Ziel), wenn er zur Figur passt (Anfang höchstens 3 m
  // von den Augen). Sonst (z. B. Figur ohne Gehirn): Augen + Blickrichtung.
  function aimRay(character, outOrigin, outDir) {
    const cmd = character.command;
    const p = character.position;
    const eyeY = p.y + (character.crouching ? CONFIG.player.crouchEyeHeight : CONFIG.player.eyeHeight);
    const d = cmd?.aimDir;
    const o = cmd?.aimOrigin;
    const dirOk = d && Number.isFinite(d.x + d.y + d.z) && Math.abs(d.x * d.x + d.y * d.y + d.z * d.z - 1) < 0.05;
    const originOk = o && Number.isFinite(o.x + o.y + o.z) &&
      (o.x - p.x) ** 2 + (o.y - eyeY) ** 2 + (o.z - p.z) ** 2 < 9;
    if (dirOk && originOk) {
      outOrigin.x = o.x; outOrigin.y = o.y; outOrigin.z = o.z;
      outDir.x = d.x; outDir.y = d.y; outDir.z = d.z;
      return;
    }
    outOrigin.x = p.x; outOrigin.y = eyeY; outOrigin.z = p.z;
    const cp = Math.cos(character.pitch ?? 0);
    outDir.x = -Math.sin(character.yaw ?? 0) * cp;
    outDir.y = Math.sin(character.pitch ?? 0);
    outDir.z = -Math.cos(character.yaw ?? 0) * cp;
  }

  // ---------------------------------------------------------------------------
  // Prüfen: Halt, Figuren im Weg
  // ---------------------------------------------------------------------------

  /** Steht die Form auf dem Gelände oder an einem Karten-Teil (nicht Bauteil)? */
  function touchesGround(shape) {
    const tol = B.supportTolerance;
    if (world) {
      const terrain = world.terrain;
      // 3 x 3 Punkte der Unterseite
      for (let a = 0; a <= 2; a++) {
        const x = shape.minX + ((shape.maxX - shape.minX) * a) / 2;
        for (let b = 0; b <= 2; b++) {
          const z = shape.minZ + ((shape.maxZ - shape.minZ) * b) / 2;
          if (shapeBottomAt(shape, x, z) <= terrain.heightAt(x, z) + tol) return true;
        }
      }
      // Karten-Teile (Kisten, Häuser, Felsen …) zählen wie Boden
      _qMin.x = shape.minX - tol; _qMin.y = shape.minY - tol; _qMin.z = shape.minZ - tol;
      _qMax.x = shape.maxX + tol; _qMax.y = shape.maxY + tol; _qMax.z = shape.maxZ + tol;
      const list = world.queryBox(_qMin, _qMax, _list);
      for (let n = 0; n < list.length; n++) {
        const c = list[n];
        if (c.data?.kind === 'piece') continue;
        if (shapesTouch(shape, colliderToShape(c, _other), tol)) return true;
      }
    } else if (shape.minY <= tol) {
      return true;
    }
    return false;
  }

  /** Hat die Form (an diesem Slot) ein Nachbar-Bauteil, das sie berührt? */
  function hasSupportingNeighbor(shape, kind, i, j, k) {
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          for (let n = 0; n < KINDS.length; n++) {
            const other = KINDS[n];
            if (di === 0 && dj === 0 && dk === 0 && other === kind) continue;
            const piece = byNum.get(numericSlotKey(other, i + di, j + dj, k + dk));
            if (piece && !piece.collapsing && shapesTouch(shape, piece.shape)) return true;
          }
        }
      }
    }
    return false;
  }

  // Wie weit darf das Teil die Figur anheben? Normal: nur so viel wie eine Stufe
  // (Füße stecken knapp drin). Eine Rampe, die man in die EIGENE Zelle setzt, hebt
  // den Bauenden ganz auf die Rampe (wie im Original).
  function liftLimit(c, shape, builder) {
    return c === builder && shape.kind === 'ramp' ? Infinity : CONFIG.player.stepHeight;
  }

  // Was passiert mit einer Figur, wenn das Teil gesetzt wird?
  const BODY_FREE = 0; // steckt nicht drin
  const BODY_LIFT = 1; // nur die Füße stecken drin → auf das Teil heben (_move.y)
  const BODY_PUSH = 2; // Wand: zur Seite hinausschieben (_move.x/_move.z)
  const BODY_BLOCKED = 3; // geht nicht (Platz bleibt rot)
  const _move = { x: 0, y: 0, z: 0 };

  /**
   * Wand: Die Figur wird zu der Seite der Wand-Ebene geschoben, auf der ihre Mitte
   * steht (wie im Original: eine Wand ist nie "vom eigenen Körper blockiert").
   * Schreibt das Ziel in _move. false = dort ist kein Platz.
   */
  function wallPushTarget(shape, kind, c) {
    const p = c.position;
    const r = c.radius;
    const gap = B.wallPushGap;
    _move.x = p.x;
    _move.y = p.y;
    _move.z = p.z;
    if (kind === 'wx') {
      const plane = (shape.minZ + shape.maxZ) / 2;
      const half = (shape.maxZ - shape.minZ) / 2;
      _move.z = plane + (p.z >= plane ? 1 : -1) * (half + r + gap);
    } else {
      const plane = (shape.minX + shape.maxX) / 2;
      const half = (shape.maxX - shape.minX) / 2;
      _move.x = plane + (p.x >= plane ? 1 : -1) * (half + r + gap);
    }
    return !world || bodyFits(world, _move.x, p.y, _move.z, r, c.height);
  }

  /**
   * Steckt Figur c im neuen Teil – und wenn ja: anheben, schieben oder blockiert?
   * Nur die Füße (bis zur Stufen-Höhe, siehe liftLimit) dürfen im Teil stecken – dann
   * wird die Figur auf das Teil gehoben. Steckt mehr drin, wird sie bei einer Wand zur
   * Seite geschoben; bei Boden/Rampe/Dach ist der Platz blockiert.
   */
  function bodyResult(shape, kind, c, builder) {
    const p = c.position;
    const r = c.radius;
    const h = c.height;
    if (!shapeOverlapsBox(shape, p.x - r, p.y, p.z - r, p.x + r, p.y + h, p.z + r)) return BODY_FREE;
    const lift = liftLimit(c, shape, builder);
    let liftOk = !(lift < h && shapeOverlapsBox(shape, p.x - r, p.y + lift, p.z - r, p.x + r, p.y + h, p.z + r));
    let top = p.y;
    if (liftOk) {
      top = shapeTopOverRect(shape, p.x - r, p.x + r, p.z - r, p.z + r);
      liftOk = top - p.y <= lift + 1e-6 && (!world || bodyFits(world, p.x, top, p.z, r, h));
    }
    if (liftOk) {
      _move.x = p.x;
      _move.y = Math.max(p.y, top);
      _move.z = p.z;
      return BODY_LIFT;
    }
    if ((kind === 'wx' || kind === 'wz') && wallPushTarget(shape, kind, c)) return BODY_PUSH;
    return BODY_BLOCKED;
  }

  /** Steht eine Figur so im Weg, dass das Teil nicht gesetzt werden kann? */
  function bodyBlocks(shape, kind, builder) {
    const list = game?.characters;
    if (!list) return false;
    for (let n = 0; n < list.length; n++) {
      const c = list[n];
      if (c.alive && bodyResult(shape, kind, c, builder) === BODY_BLOCKED) return true;
    }
    return false;
  }

  // Figuren, die im neuen Teil stecken, auf das Teil heben bzw. aus der Wand schieben
  function settleCharacters(shape, kind, builder) {
    const list = game?.characters;
    if (!list) return;
    for (let n = 0; n < list.length; n++) {
      const c = list[n];
      if (!c.alive) continue;
      const result = bodyResult(shape, kind, c, builder);
      const p = c.position;
      if (result === BODY_LIFT && _move.y > p.y) {
        const top = _move.y;
        c.stepOffset = Math.max(-0.6, (c.stepOffset ?? 0) - (top - p.y)); // Grafik zieht weich nach
        p.y = top;
        if (c.airPeakY !== undefined && c.airPeakY < top) c.airPeakY = top; // kein Fallschaden durchs Anheben
      } else if (result === BODY_PUSH) {
        // waagerecht hinaus (die Grafik gleitet über einen Tick nach)
        p.x = _move.x;
        p.z = _move.z;
      }
    }
  }

  /**
   * Prüft, ob ein Bauteil an diesen Platz darf.
   * @returns {string|null} Grund ('limit'|'occupied'|'material'|'blocked'|'unsupported') oder null = geht
   */
  function checkPlacement(type, kind, i, j, k, dir, character, options = null) {
    if (pieces.size >= B.maxPieces) return 'limit';
    if (byNum.has(numericSlotKey(kind, i, j, k))) return 'occupied';
    if (character && !character.infiniteMaterials && !options?.skipMaterial) {
      const material = options?.material ?? character.currentMaterial;
      if ((character.materials?.[material] ?? 0) < M.costPerPiece) return 'material';
    }
    const shape = slotShape(kind, i, j, k, dir, _shape);
    if (!options?.skipBodyCheck && bodyBlocks(shape, kind, character)) return 'blocked';
    if (!options?.skipSupport && !touchesGround(shape) && !hasSupportingNeighbor(shape, kind, i, j, k)) return 'unsupported';
    return null;
  }

  // ---------------------------------------------------------------------------
  // Setzen
  // ---------------------------------------------------------------------------

  function makeColliders(piece) {
    for (const c of piece.colliders) world?.remove(c);
    piece.colliders.length = 0;
    piece.doorCollider = null;
    if (!world) return;
    for (const spec of pieceColliderSpecs(piece)) {
      const c = spec.type === 'box' ? world.addBox(spec.min, spec.max, piece.data) : world.addSlope(spec.spec, piece.data);
      if (spec.door) {
        c.enabled = !piece.doorOpen;
        piece.doorCollider = c;
      }
      piece.colliders.push(c);
    }
  }

  // Lebenspunkte im Aufbau: wachsen von startHealthFraction auf 100 %
  function growthHealth(piece) {
    const f = M.startHealthFraction;
    return piece.maxHealth * (f + (1 - f) * piece.buildProgress);
  }

  /**
   * Bauteil setzen (ohne Kosten-/Halt-Prüfung, wenn options.force).
   * @param {string} type      'wall' | 'floor' | 'ramp' | 'roof'
   * @param {string} key       Slot-Schlüssel (z. B. "wx:0:0:-1")
   * @param {object|null} owner  Figur oder null
   * @param {string} [material] 'wood' | 'stone' | 'metal'
   * @param {object} [options] { dir (Rampe), edit (Feld-Liste), instant (gleich 100 %),
   *                             force (keine Halt-/Figuren-Prüfung), charge (Material abziehen) }
   * @returns {object|null} Bauteil oder null (geht nicht)
   */
  function placePiece(type, key, owner = null, material = 'wood', options = {}) {
    const slot = parseSlotKey(key, _parsed);
    if (!slot || slot.type !== type) return null;
    if (!M.order.includes(material)) material = 'wood';
    const dir = type === 'ramp' ? (((options.dir ?? 0) % 4) + 4) % 4 : 0;
    const { kind, i, j, k } = slot;
    if (pieces.size >= B.maxPieces || byNum.has(numericSlotKey(kind, i, j, k))) return null;
    if (!options.force) {
      const reason = checkPlacement(type, kind, i, j, k, dir, owner, { material, skipMaterial: !options.charge });
      if (reason) return null;
    }
    if (options.charge && owner && !owner.infiniteMaterials) {
      if ((owner.materials[material] ?? 0) < M.costPerPiece) return null;
      owner.materials[material] -= M.costPerPiece;
    }

    const maxHealth = B.maxHealth[type][material];
    const piece = {
      id: nextId++,
      type,
      kind,
      slotKey: slotKey(kind, i, j, k),
      numKey: numericSlotKey(kind, i, j, k),
      i, j, k, dir,
      material,
      owner: owner ?? null,
      maxHealth,
      health: maxHealth,
      buildProgress: 1,
      buildTime: M.buildTime[material],
      damageTaken: 0, // Schaden während des Aufbaus
      placedAt: game?.time ?? 0,
      edit: new Set(),
      editMask: 0,
      doorOpen: false,
      doorChangedAt: -10,
      doorCollider: null,
      colliders: [],
      neighbors: new Set(),
      grounded: false,
      shape: slotShape(kind, i, j, k, dir),
      collapsing: false,
      collapseAt: 0,
      removed: false,
      data: null,
      view: null,
      _visit: 0,
      _safe: 0,
      applyDamage(amount, info) {
        return damagePiece(piece, amount, info);
      },
      get isDoor() {
        return isDoorPiece(piece);
      },
    };
    piece.data = { kind: 'piece', ref: piece, owner: piece.owner ?? undefined, blocksBullets: true };
    if (!options.instant) {
      piece.buildProgress = 0;
      piece.health = growthHealth(piece);
      constructing.add(piece);
    }
    if (options.edit) {
      piece.editMask = tilesToMask(options.edit) & fullTileMask(type);
      if (piece.editMask === fullTileMask(type)) piece.editMask = 0;
      piece.edit = new Set(maskToTiles(piece.editMask));
      if (piece.editMask) editedPieces.add(piece);
      if (isDoorPiece(piece)) doors.add(piece);
    }

    pieces.set(piece.slotKey, piece);
    byNum.set(piece.numKey, piece);
    ownerCounts.set(piece.owner, (ownerCounts.get(piece.owner) ?? 0) + 1);
    // erst die Figuren hinaus/hinauf (gleiche Rechnung wie checkPlacement, ohne das neue Teil)
    if (!options.force) settleCharacters(piece.shape, kind, owner);
    makeColliders(piece);
    linkNeighbors(piece);
    piece.grounded = touchesGround(piece.shape);
    view?.add(piece);
    if (options.charge && owner?.stats) owner.stats.piecesBuilt++; // selbst gebaut (nicht vom Modus hingestellt)
    game?.events?.emit?.('piecePlaced', { piece, owner: piece.owner });
    return piece;
  }

  function linkNeighbors(piece) {
    const { kind, i, j, k } = piece;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          for (let n = 0; n < KINDS.length; n++) {
            const other = KINDS[n];
            if (di === 0 && dj === 0 && dk === 0 && other === kind) continue;
            const o = byNum.get(numericSlotKey(other, i + di, j + dj, k + dk));
            if (o && o !== piece && shapesTouch(piece.shape, o.shape)) {
              piece.neighbors.add(o);
              o.neighbors.add(piece);
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Schaden, Entfernen, Einsturz
  // ---------------------------------------------------------------------------

  function damagePiece(piece, amount, info = {}) {
    if (piece.removed || !(amount > 0)) return { amount: 0, destroyed: false };
    const by = info?.attacker ?? info?.by ?? null;
    const before = piece.health;
    if (piece.buildProgress < 1) {
      piece.damageTaken += amount;
      piece.health = growthHealth(piece) - piece.damageTaken;
    } else {
      piece.health -= amount;
    }
    const dealt = Math.min(before, amount);
    game?.events?.emit?.('pieceDamaged', { piece, amount: dealt, by });
    if (piece.health <= 0) {
      piece.health = 0;
      removePiece(piece, { by });
      return { amount: dealt, destroyed: true };
    }
    view?.damaged(piece);
    return { amount: dealt, destroyed: false };
  }

  /**
   * Bauteil entfernen (zerstört). options = { by, collapsed, silent (kein Ereignis), noCollapse }
   */
  function removePiece(piece, options = {}) {
    if (!piece || piece.removed) return;
    piece.removed = true;
    for (const c of piece.colliders) world?.remove(c);
    piece.colliders.length = 0;
    piece.doorCollider = null;
    pieces.delete(piece.slotKey);
    byNum.delete(piece.numKey);
    const count = (ownerCounts.get(piece.owner) ?? 1) - 1;
    if (count > 0) ownerCounts.set(piece.owner, count);
    else ownerCounts.delete(piece.owner);
    constructing.delete(piece);
    doors.delete(piece);
    editedPieces.delete(piece);
    edit.pieceRemoved(piece);
    const neighbors = [...piece.neighbors];
    for (const n of neighbors) n.neighbors.delete(piece);
    piece.neighbors.clear();
    view?.remove(piece, !!options.collapsed, game?.time ?? 0);
    if (!options.silent) {
      game?.events?.emit?.('pieceDestroyed', { piece, by: options.by ?? null, collapsed: !!options.collapsed });
    }
    if (!options.noCollapse) checkSupport(neighbors, options.by ?? null);
  }

  /**
   * Breitensuche ab den Nachbarn eines entfernten Teils: Jede Gruppe ohne Verbindung
   * zu einem Teil mit Boden-Halt stürzt nach collapseDelay ein.
   */
  function checkSupport(starts, by) {
    if (starts.length === 0) return;
    const at = (game?.time ?? 0) + B.collapseDelay;
    const call = ++safeStamp; // Teile mit _safe === call haben sicher Halt
    for (const start of starts) {
      if (start.removed || start.collapsing || start._safe === call) continue;
      const stamp = ++visitStamp;
      _queue.length = 0;
      _queue.push(start);
      start._visit = stamp;
      let grounded = false;
      for (let q = 0; q < _queue.length; q++) {
        const p = _queue[q];
        if (p.grounded || p._safe === call) {
          grounded = true;
          break;
        }
        for (const n of p.neighbors) {
          if (n._visit === stamp || n.removed || n.collapsing) continue;
          n._visit = stamp;
          _queue.push(n);
        }
      }
      if (grounded) {
        // alles bisher Gefundene hängt am Halt → muss nicht nochmal gesucht werden
        for (const p of _queue) p._safe = call;
        continue;
      }
      // ganze Gruppe ohne Halt → einstürzen lassen
      for (const p of _queue) {
        if (p.collapsing) continue;
        p.collapsing = true;
        p.collapseAt = at;
        collapseQueue.push({ piece: p, by });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Edit (Felder) und Türen
  // ---------------------------------------------------------------------------

  /** Felder eines Teils entfernen (mask = entfernte Felder). 0 = ganzes Teil. */
  function setEdit(piece, mask) {
    if (piece.removed) return false;
    mask &= fullTileMask(piece.type);
    if (mask === fullTileMask(piece.type)) return false;
    const wasDoor = isDoorPiece(piece);
    piece.editMask = mask;
    piece.edit = new Set(maskToTiles(mask));
    if (mask) editedPieces.add(piece);
    else editedPieces.delete(piece);
    const door = isDoorMask(piece.type, mask);
    if (door) {
      doors.add(piece);
      if (!wasDoor) piece.doorOpen = false;
    } else {
      doors.delete(piece);
      piece.doorOpen = false;
    }
    makeColliders(piece);
    view?.refresh(piece);
    game?.events?.emit?.('pieceEdited', { piece, owner: piece.owner });
    return true;
  }

  /** Tür öffnen/schließen. Schließen geht nicht, wenn jemand in der Tür steht. */
  function setDoorOpen(piece, open) {
    if (piece.removed || !isDoorPiece(piece) || piece.doorOpen === open) return false;
    if (!open && piece.doorCollider) {
      colliderToShape(piece.doorCollider, _shape);
      const list = game?.characters ?? [];
      for (const c of list) {
        if (!c.alive) continue;
        const p = c.position;
        if (shapeOverlapsBox(_shape, p.x - c.radius, p.y, p.z - c.radius, p.x + c.radius, p.y + c.height, p.z + c.radius)) return false;
      }
    }
    piece.doorOpen = open;
    piece.doorChangedAt = game?.time ?? 0;
    if (piece.doorCollider) piece.doorCollider.enabled = !open;
    game?.events?.emit?.('doorToggled', { piece, open });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pro Figur und Tick
  // ---------------------------------------------------------------------------

  const _aimO = { x: 0, y: 0, z: 0 };
  const _aimD = { x: 0, y: 0, z: -1 };

  /** Ziel für ein Bauteil (für Vorschau und Bots). out = createTarget() */
  function getTarget(character, type = character.buildPiece, out = createTarget()) {
    aimRay(character, _aimO, _aimD);
    selectTarget(character, type, _aimD, world, getPiece, out);
    validate(out, character);
    return out;
  }

  function validate(target, character) {
    target.reason = checkPlacement(target.type, target.kind, target.i, target.j, target.k, target.dir, character);
    target.valid = target.reason === null;
    if (target._keyFor !== target.numKey) {
      target.slotKey = slotKey(target.kind, target.i, target.j, target.k);
      target._keyFor = target.numKey;
    }
    target.material = character.currentMaterial;
    return target;
  }

  function updateCharacter(character, cmd, dt) {
    const state = stateOf(character);
    if (!character.alive) {
      state.hasTarget = false;
      if (edit.sessionOf(character)) edit.close(character, false);
      return;
    }
    // E: Türen (in jedem Modus)
    if (cmd.usePressed) edit.use(character);

    if (character.mode === 'edit') {
      state.hasTarget = false;
      edit.update(character, cmd);
      return;
    }
    if (edit.sessionOf(character)) edit.close(character, false);
    if (character.mode !== 'build') {
      state.hasTarget = false;
      state.lastKey = -1;
      return;
    }
    // R im Baumodus: Rampe drehen
    if (cmd.reloadOrRotate) character.buildRotation = ((character.buildRotation ?? 0) + 1) % B.rotationSteps;

    const target = getTarget(character, character.buildPiece, state.target);
    state.hasTarget = true;
    if (!cmd.primary) {
      state.lastKey = -1;
      return;
    }
    const time = game?.time ?? 0;
    const wants = cmd.primaryPressed || target.numKey !== state.lastKey;
    if (wants && target.valid && time >= state.nextPlaceTime - 1e-9) {
      const piece = placePiece(target.type, target.slotKey, character, character.currentMaterial,
        { dir: target.dir, charge: true });
      if (piece) {
        state.lastKey = target.numKey;
        state.nextPlaceTime = time + B.placeCooldown;
        character.triggerAction?.('build');
        target.valid = false;
        target.reason = 'occupied';
      }
    }
  }

  /** Pro Tick: Aufbau und Einsturz. */
  function update(dt) {
    const time = game?.time ?? 0;
    for (const piece of constructing) {
      piece.buildProgress = Math.min(1, (time - piece.placedAt) / piece.buildTime);
      piece.health = growthHealth(piece) - piece.damageTaken;
      if (piece.buildProgress >= 1) {
        constructing.delete(piece);
        piece.damageTaken = 0;
        view?.refresh(piece);
      }
    }
    if (collapseQueue.length) {
      let n = 0;
      while (n < collapseQueue.length) {
        const entry = collapseQueue[n];
        if (entry.piece.removed) {
          collapseQueue[n] = collapseQueue[collapseQueue.length - 1];
          collapseQueue.pop();
          continue;
        }
        if (time + 1e-9 >= entry.piece.collapseAt) {
          collapseQueue[n] = collapseQueue[collapseQueue.length - 1];
          collapseQueue.pop();
          removePiece(entry.piece, { by: entry.by, collapsed: true, noCollapse: true });
          continue;
        }
        n++;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Bild
  // ---------------------------------------------------------------------------

  function frameUpdate(alpha = 1) {
    if (!view) return;
    const time = (game.time ?? 0) + (alpha - 1) / CONFIG.loop.tickRate;
    view.frameUpdate(time, constructing, doors);
    // Vorschau und Edit-Kacheln nur für den Spieler
    const player = game.player;
    const state = player ? states.get(player) : null;
    const showPreview = player && player.alive && player.mode === 'build' && state?.hasTarget && state.generation === generation;
    view.setPreview(showPreview ? state.target : null);
    const session = player && player.mode === 'edit' ? edit.sessionOf(player) : null;
    view.setEditOverlay(session ?? null);
  }

  // ---------------------------------------------------------------------------
  // Aufräumen
  // ---------------------------------------------------------------------------

  function clearAll() {
    edit.clear();
    for (const piece of [...pieces.values()]) {
      piece.removed = true;
      for (const c of piece.colliders) world?.remove(c);
      piece.colliders.length = 0;
      piece.neighbors.clear();
      view?.remove(piece, false, 0);
    }
    pieces.clear();
    byNum.clear();
    ownerCounts.clear();
    constructing.clear();
    doors.clear();
    editedPieces.clear();
    collapseQueue.length = 0;
    generation++;
    view?.clear();
  }

  const system = {
    game,
    world,
    pieces,
    doors,
    editedPieces,
    updateCharacter,
    update,
    placePiece,
    removePiece,
    clearAll,
    countFor(owner) {
      return ownerCounts.get(owner ?? null) ?? 0;
    },
    getPieceAt(key) {
      return pieces.get(key) ?? null;
    },
    /** Bauteil an einem Platz (Zahlen statt Text). */
    getPiece,
    canEdit(character) {
      return edit.canEdit(character);
    },
    closeEdit(character) {
      edit.close(character, true);
    },
    getTarget,
    checkPlacement,
    setEdit,
    setDoorOpen,
    aimRay,
    damagePiece,
    /** Mitte eines Bauteils (für Effekte/Töne). */
    pieceCenter,
    /** Offener Edit einer Figur (für HUD/Tests). */
    editSession(character) {
      return edit.sessionOf(character) ?? null;
    },
    /** Letztes Bau-Ziel einer Figur (Vorschau), oder null. */
    targetOf(character) {
      const s = states.get(character);
      return s?.hasTarget && s.generation === generation ? s.target : null;
    },
    /** Wie viele Teile warten gerade auf den Einsturz? */
    get collapsingCount() {
      return collapseQueue.length;
    },
    get view() {
      return view;
    },
    frameUpdate,
    dispose() {
      clearAll();
      view?.dispose();
      view = null;
    },
  };
  const edit = createEditController(system);
  if (visual) view = createBuildingView(game);
  return system;
}

/** Slot-Art eines Bauteil-Typs (Wand: null, weil es zwei gibt: wx/wz). */
export function kindOfType(type) {
  return KIND_OF_TYPE[type] ?? null;
}

export { typeOfKind };
