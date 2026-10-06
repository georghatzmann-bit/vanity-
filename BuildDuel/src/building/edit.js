// =============================================================================
// Edit-Modus und Türen
// =============================================================================
// Ablauf (wie im Original):
//   1. G auf ein EIGENES Bauteil (unter dem Fadenkreuz, bis CONFIG.building.editReach)
//      → Edit-Modus. Auf dem Bauteil erscheinen leuchtende Felder.
//      Fremde Bauteile: kein Edit, kurzer Hinweis.
//   2. Linksklick schaltet das Feld unter dem Fadenkreuz um (rot = wird entfernt).
//      Maus gedrückt halten und über Felder ziehen = alle mit gleichem Zustand.
//   3. Rechtsklick = alle Felder zurücksetzen (nichts gewählt). Bestätigen stellt
//      dann das ganze Bauteil wieder her.
//   4. G nochmal = bestätigen (sofort). Mit "Edit beim Loslassen" bestätigt schon
//      das Loslassen von G. Waffe/Bauteil wählen bestätigt auch und verlässt den Edit.
//   5. Wand: genau die mittleren unteren 2 Felder entfernt = Tür. E öffnet/schließt
//      sie (jeder darf Türen benutzen).
//   6. Rampe: 1 Feld entfernt = Ecktreppe; 2 Felder nebeneinander entfernt = halbe
//      Rampe – sie steigt in die Richtung, in der man die zwei Felder gewählt hat
//      (vom ersten zum zweiten Feld, z. B. Ziehen von unten nach oben).
// Im Tick, in dem G den Edit öffnet (character.editOpenedTick), zählt dasselbe G
// nicht gleich als "bestätigen".
// =============================================================================
import { CONFIG } from '../config.js';
import { pickTile, isDoorPiece, doorRect, pieceOrigin } from './pieces.js';
import { fullTileMask, CELL_SIZE as S, LEVEL_HEIGHT as H } from './grid.js';

const B = CONFIG.building;

/**
 * @param {object} system  Bau-System (structure.js) – braucht game, world, editedPieces,
 *                         doors, setEdit(), setDoorOpen(), aimRay()
 */
export function createEditController(system) {
  const game = system.game;
  const sessions = new Map(); // Figur → { piece, openedTick, selection, hover, paint, lastPaint }
  let candidates = new WeakMap(); // Figur → Bauteil, das canEdit zuletzt gefunden hat
  const hintAt = new WeakMap(); // Figur → Spielzeit des letzten Hinweises
  const _origin = { x: 0, y: 0, z: 0 };
  const _dir = { x: 0, y: 0, z: -1 };
  const _tileHit = { distance: 0 };
  const _rayOptions = { ignore: null, characters: null, skipTerrain: false };

  /** Bauteil unter dem Fadenkreuz (auch eigene editierte Teile mit Löchern) oder null. */
  function pieceUnderCrosshair(character, reach) {
    const world = system.world;
    if (!world || !character?.position) return null;
    system.aimRay(character, _origin, _dir);
    const hit = world.raycast(_origin, _dir, reach, _rayOptions);
    let best = null;
    let bestDist = reach;
    if (hit) {
      bestDist = hit.distance;
      const data = hit.collider?.data;
      if (data && data.kind === 'piece' && data.ref && !data.ref.removed) best = data.ref;
    }
    // Löcher: editierte Teile über ihre ganze Fläche prüfen
    for (const piece of system.editedPieces) {
      if (piece === best || piece.removed) continue;
      if (pickTile(piece, _origin, _dir, bestDist, _tileHit) >= 0 && _tileHit.distance < bestDist) {
        best = piece;
        bestDist = _tileHit.distance;
      }
    }
    return best;
  }

  /** Darf die Figur jetzt editieren? (merkt sich das Bauteil für den Start) */
  function canEdit(character) {
    if (!character || !character.position || !character.alive) return false;
    const piece = pieceUnderCrosshair(character, B.editReach);
    if (piece && piece.owner !== character) {
      candidates.delete(character);
      hint(character, 'Nur eigene Bauteile kann man bearbeiten.');
      return false;
    }
    if (!piece || piece.collapsing) {
      candidates.delete(character);
      return false;
    }
    candidates.set(character, piece);
    return true;
  }

  function hint(character, text) {
    if (!character.isPlayer) return;
    const last = hintAt.get(character) ?? -Infinity;
    if (game.time - last < B.hintCooldown) return;
    hintAt.set(character, game.time);
    game.events?.emit?.('message', { text, kind: 'info', duration: 1.2 });
  }

  function open(character, piece) {
    const resetFirst = character.isPlayer && !!game.settings?.controls?.resetEditAfterConfirm;
    const session = {
      piece,
      openedTick: character.editOpenedTick,
      selection: resetFirst ? 0 : piece.editMask | 0,
      hover: -1,
      paint: null, // true = beim Ziehen auswählen, false = abwählen
      lastPaint: -1,
      prevAdded: -1, // die zwei zuletzt GEWÄHLTEN Felder (Rampe: Richtung der halben Rampe)
      lastAdded: -1,
    };
    sessions.set(character, session);
    candidates.delete(character);
    return session;
  }

  // Edit verlassen (Modus zurück)
  function leave(character) {
    sessions.delete(character);
    if (character.mode === 'edit') {
      character.mode = character.modeBeforeEdit && character.modeBeforeEdit !== 'edit' ? character.modeBeforeEdit : 'weapon';
    }
  }

  // Rampe: Richtung aus der Wahl-Reihenfolge (vom vorletzten zum letzten gewählten Feld),
  // wenn genau diese zwei nebeneinander liegenden Felder gewählt sind; sonst die alte
  function rampEditDir(session, piece) {
    const a = session.prevAdded;
    const b = session.lastAdded;
    if (a >= 0 && b >= 0 && session.selection === ((1 << a) | (1 << b))) {
      const dx = (b % 2) - (a % 2);
      const dz = Math.floor(b / 2) - Math.floor(a / 2);
      if (Math.abs(dx) + Math.abs(dz) === 1) return dx === 1 ? 0 : dz === 1 ? 1 : dx === -1 ? 2 : 3;
    }
    return session.selection === (piece.editMask | 0) ? piece.editDir ?? null : null;
  }

  /** Auswahl übernehmen (sofort). Alle Felder entfernen geht nicht. */
  function confirm(character) {
    const session = sessions.get(character);
    if (!session) return false;
    const piece = session.piece;
    const full = fullTileMask(piece.type);
    const editDir = piece.type === 'ramp' ? rampEditDir(session, piece) : null;
    const changed = session.selection !== (piece.editMask | 0) || (piece.type === 'ramp' && editDir !== (piece.editDir ?? null));
    if (!piece.removed && session.selection !== full && changed) {
      system.setEdit(piece, session.selection, editDir);
    }
    leave(character);
    return true;
  }

  // Feld umschalten (Klick oder Ziehen); merkt sich die Reihenfolge der gewählten Felder
  function toggleTile(session, tile, select) {
    const bit = 1 << tile;
    if (select) {
      session.selection |= bit;
      session.prevAdded = session.lastAdded;
      session.lastAdded = tile;
    } else {
      session.selection &= ~bit;
    }
  }

  /** Jeden Tick für eine Figur im Edit-Modus (aus building.updateCharacter). */
  function update(character, cmd) {
    let session = sessions.get(character);
    if (character.mode !== 'edit') {
      if (session) sessions.delete(character);
      return;
    }
    if (!session || session.openedTick !== character.editOpenedTick) {
      const piece = candidates.get(character);
      if (!piece || piece.removed || piece.collapsing || piece.owner !== character) {
        leave(character);
        return;
      }
      session = open(character, piece);
    }
    const piece = session.piece;
    if (piece.removed || piece.collapsing || !character.alive) {
      leave(character);
      return;
    }
    // zu weit weg → Edit zu (ohne Änderung)
    const p = character.position;
    const o = pieceOrigin(piece, _center);
    if (Math.hypot(o.x - p.x, o.y + H / 2 - p.y, o.z - p.z) > B.editMaxDistance) {
      leave(character);
      return;
    }

    // Feld unter dem Fadenkreuz
    system.aimRay(character, _origin, _dir);
    session.hover = pickTile(piece, _origin, _dir, B.editReach * 1.5);

    // Rechtsklick: alles zurücksetzen
    if (cmd.secondaryPressed) {
      session.selection = 0;
      session.prevAdded = -1;
      session.lastAdded = -1;
    }

    // Klicken / Ziehen
    if (cmd.primaryPressed && session.hover >= 0) {
      session.paint = (session.selection & (1 << session.hover)) === 0;
      toggleTile(session, session.hover, session.paint);
      session.lastPaint = session.hover;
    } else if (cmd.primary && session.paint !== null && session.hover >= 0 && session.hover !== session.lastPaint) {
      toggleTile(session, session.hover, session.paint);
      session.lastPaint = session.hover;
    }
    if (!cmd.primary) {
      session.paint = null;
      session.lastPaint = -1;
    }

    // Bestätigen
    const fresh = game.tick === character.editOpenedTick;
    const onRelease = character.isPlayer && !!game.settings?.controls?.editOnRelease;
    if (onRelease) {
      if (!fresh && (cmd.editReleased || !cmd.edit)) confirm(character);
    } else if (!fresh && cmd.editPressed) {
      confirm(character);
    }
  }
  const _center = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };

  /** Edit schließen (Waffe/Bauteil gewählt): Auswahl wird übernommen. */
  function close(character, apply = true) {
    if (!sessions.has(character)) {
      candidates.delete(character);
      return;
    }
    if (apply) confirm(character);
    else leave(character);
  }

  /** Bauteil ist weg → offene Edits darauf beenden. */
  function pieceRemoved(piece) {
    for (const [character, session] of sessions) {
      if (session.piece === piece) leave(character);
    }
    // (candidates: ein weggefallenes Teil wird beim Öffnen über piece.removed erkannt)
  }

  // --- Türen (E) ---------------------------------------------------------------------

  /** E gedrückt: Tür unter dem Fadenkreuz oder die nächste Tür dicht vor der Figur umschalten. */
  function use(character) {
    const best = findDoor(character);
    if (!best) return false;
    return system.setDoorOpen(best, !best.doorOpen);
  }

  // Tür, die E jetzt öffnen/schließen würde (auch für den HUD-Hinweis "E – Tür öffnen"), oder null
  function findDoor(character) {
    if (!character?.alive || system.doors.size === 0) return null;
    system.aimRay(character, _origin, _dir);
    let best = null;
    let bestDist = B.useReach;
    for (const piece of system.doors) {
      if (piece.removed) continue;
      const tile = pickTile(piece, _origin, _dir, bestDist, _tileHit);
      if ((tile === B.wallDoorCells[0] || tile === B.wallDoorCells[1]) && _tileHit.distance < bestDist) {
        best = piece;
        bestDist = _tileHit.distance;
      }
    }
    if (!best) {
      // nah davor stehen reicht auch
      let near = B.doorNearDistance;
      const p = character.position;
      for (const piece of system.doors) {
        if (piece.removed) continue;
        doorCenter(piece, _center);
        const d = Math.hypot(_center.x - p.x, _center.z - p.z);
        if (d < near && Math.abs(_center.y - (p.y + 1)) < 1.6) {
          near = d;
          best = piece;
        }
      }
    }
    return best && isDoorPiece(best) ? best : null;
  }

  // Mitte der Tür-Öffnung
  function doorCenter(piece, out) {
    const d = doorRect();
    const u = (d.u0 + d.u1) / 2;
    const v = (d.v0 + d.v1) / 2;
    if (piece.kind === 'wx') return out.set(piece.i * S + u, piece.j * H + v, piece.k * S);
    return out.set(piece.i * S, piece.j * H + v, piece.k * S + u);
  }

  return {
    canEdit,
    findDoor,
    update,
    close,
    confirm,
    pieceRemoved,
    use,
    pieceUnderCrosshair,
    /** Offener Edit einer Figur (oder undefined). */
    sessionOf(character) {
      return sessions.get(character);
    },
    clear() {
      for (const character of [...sessions.keys()]) leave(character);
      sessions.clear();
      candidates = new WeakMap();
    },
  };
}
