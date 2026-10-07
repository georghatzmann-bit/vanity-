// =============================================================================
// Edit-Modus und Türen
// =============================================================================
// Ablauf (wie in Fortnite):
//   1. G auf ein EIGENES Bauteil (unter dem Fadenkreuz, bis CONFIG.building.editReach)
//      → Edit-Modus. Das Bauteil wird ausgeblendet, man sieht sein Raster (Kacheln).
//      Fremde Bauteile: kein Edit, kurzer Hinweis.
//      Ist die linke Maustaste beim Öffnen schon gedrückt, wird das Feld unter dem
//      Fadenkreuz sofort gewählt (schnelle Edits: Maus halten, G tippen, loslassen).
//   2. Linksklick schaltet das Feld unter dem Fadenkreuz um (grau = gewählt).
//      Maus gedrückt halten und über Felder ziehen = alle mit gleichem Zustand.
//        Wand/Boden: gewählte Felder fallen weg (Löcher, Tür, Dreieck, Bogen …).
//        Dach:       gewählte Ecken werden hochgezogen.
//        Rampe:      man zieht einen WEG (jedes Feld neben dem vorigen) – er bleibt als
//                    Treppe: 2 Felder = halbe Rampe, 3 (L) = L-Treppe, 4 (U) = U-Treppe.
//                    Zurück auf das vorige Feld ziehen nimmt den letzten Schritt zurück.
//                    Die Reihenfolge bestimmt die Richtung (vom ersten Feld hinauf).
//   3. Rechtsklick = zurücksetzen. Mit "Auto-Reset" (Standard, wie in Fortnite) ist
//      das Bauteil sofort wieder ganz und der Edit zu; sonst erst nach dem Bestätigen.
//   4. G nochmal = bestätigen (sofort). Mit "Edit beim Loslassen bestätigen"
//      (Fortnite: "Confirm Edit on Release") bestätigt schon das Loslassen der LINKEN
//      MAUSTASTE nach dem Wählen – so gehen schnelle Doppel- und Dreifach-Edits.
//      Waffe/Bauteil wählen: "Auto Confirm Edits" entscheidet, ob der Edit bestätigt
//      oder verworfen wird (Standard: beides bestätigt).
//   5. Wand: genau die mittleren unteren 2 Felder entfernt = Tür. E öffnet/schließt
//      sie (jeder darf Türen benutzen).
// Im Tick, in dem G den Edit öffnet (character.editOpenedTick), zählt dasselbe G
// nicht gleich als "bestätigen".
// =============================================================================
import { CONFIG } from '../config.js';
import { pickTile, isDoorPiece, doorRect, pieceOrigin, rampPathOf, tileDirection, pathMask } from './pieces.js';
import { fullTileMask, CELL_SIZE as S, LEVEL_HEIGHT as H } from './grid.js';

const B = CONFIG.building;

/**
 * @param {object} system  Bau-System (structure.js) – braucht game, world, editedPieces,
 *                         doors, setEdit(), setDoorOpen(), aimRay()
 */
export function createEditController(system) {
  const game = system.game;
  const sessions = new Map(); // Figur → Sitzung (siehe open)
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
    const ramp = piece.type === 'ramp';
    const current = ramp ? rampPathOf(piece) : null;
    const path = !resetFirst && current ? [...current] : [];
    const session = {
      piece,
      openedTick: character.editOpenedTick,
      fresh: true, // erster Tick der Sitzung (Maus schon gedrückt → Feld sofort wählen)
      armed: false, // Maus gedrückt, wartet auf ein Feld unter dem Fadenkreuz
      // Wand/Boden: entfernte Felder, Dach: hochgezogene Ecken, Rampe: Felder des Wegs
      selection: ramp ? pathMask(path) : resetFirst ? 0 : piece.editMask | 0,
      path, // nur Rampe: gezogener Weg (Feld-Nummern in Reihenfolge)
      pathStarted: false, // Rampe: in dieser Sitzung schon gezogen (sonst beginnt ein Klick neu)
      reset: ramp && resetFirst, // Rampe: zurückgesetzt (ohne neuen Weg → ganze Rampe)
      hover: -1,
      paint: null, // Wand/Boden/Dach: true = beim Ziehen auswählen, false = abwählen; Rampe: true = zieht
      lastPaint: -1,
      painted: false, // mindestens ein Feld angeklickt (für "beim Loslassen bestätigen")
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

  /** Auswahl übernehmen (sofort). Alle Felder entfernen geht nicht. */
  function confirm(character) {
    const session = sessions.get(character);
    if (!session) return false;
    const piece = session.piece;
    if (!piece.removed) {
      if (piece.type === 'ramp') {
        const old = rampPathOf(piece);
        if (session.path.length >= 2) {
          // neuer Weg (2–4 Felder) → halbe Rampe / L- / U-Treppe
          if (!old || old.join() !== session.path.join()) system.setEdit(piece, 0, session.path);
        } else if (session.reset && old) {
          system.setEdit(piece, 0, null); // zurückgesetzt → ganze Rampe
        }
        // 0 oder 1 Feld: keine Änderung
      } else if (session.selection !== fullTileMask(piece.type) && session.selection !== (piece.editMask | 0)) {
        system.setEdit(piece, session.selection);
      }
    }
    leave(character);
    return true;
  }

  // Wand/Boden/Dach: Feld umschalten (Klick oder Ziehen)
  function toggleTile(session, tile, select) {
    if (select) session.selection |= 1 << tile;
    else session.selection &= ~(1 << tile);
  }

  // Rampe: Klick auf ein Feld. Neuer Weg – außer das Feld setzt den Weg fort (neben dem
  // letzten Feld) oder IST das letzte Feld (dann einfach weiterziehen).
  function rampPress(session, tile) {
    const path = session.path;
    const last = path.length ? path[path.length - 1] : -1;
    if (session.pathStarted && tile === last) return;
    if (session.pathStarted && last >= 0 && !path.includes(tile) && tileDirection(last, tile) >= 0) {
      path.push(tile);
    } else {
      path.length = 0;
      path.push(tile);
    }
    session.pathStarted = true;
    session.selection = pathMask(path);
  }

  // Rampe: mit gedrückter Maus auf ein anderes Feld gezogen
  function rampDrag(session, tile) {
    const path = session.path;
    if (path.length >= 2 && tile === path[path.length - 2]) {
      path.pop(); // zurück aufs vorige Feld: letzten Schritt zurücknehmen
    } else if (path.length && !path.includes(tile) && tileDirection(path[path.length - 1], tile) >= 0) {
      path.push(tile);
    }
    session.selection = pathMask(path);
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
    const ramp = piece.type === 'ramp';

    // Rechtsklick: alles zurücksetzen – mit Auto-Reset sofort übernehmen und Edit schließen
    if (cmd.secondaryPressed) {
      session.selection = 0;
      session.path.length = 0;
      session.pathStarted = false;
      session.reset = true;
      if (option(character, 'resetConfirms')) {
        confirm(character);
        return;
      }
    }

    // Klicken / Ziehen. Maus beim Öffnen schon gedrückt = wie ein Klick (schnelle Edits).
    // Ein Klick neben das Raster wartet, bis das Fadenkreuz (Maus noch gedrückt) ein Feld trifft.
    if (cmd.primaryPressed || (session.fresh && cmd.primary)) session.armed = true;
    if (session.armed && session.paint === null && session.hover >= 0) {
      if (ramp) {
        rampPress(session, session.hover);
        session.paint = true;
      } else {
        session.paint = (session.selection & (1 << session.hover)) === 0;
        toggleTile(session, session.hover, session.paint);
      }
      session.lastPaint = session.hover;
      session.painted = true;
    } else if (cmd.primary && session.paint !== null && session.hover >= 0 && session.hover !== session.lastPaint) {
      if (ramp) rampDrag(session, session.hover);
      else toggleTile(session, session.hover, session.paint);
      session.lastPaint = session.hover;
    }
    if (!cmd.primary) {
      session.paint = null;
      session.lastPaint = -1;
      session.armed = false;
    }
    session.fresh = false;

    // Bestätigen: G nochmal – oder (Einstellung) Loslassen der linken Maustaste nach dem Wählen
    const opening = game.tick === character.editOpenedTick;
    if (!opening && cmd.editPressed) {
      confirm(character);
    } else if (session.painted && !cmd.primary && option(character, 'editOnRelease')) {
      confirm(character);
    }
  }

  // Bau-/Edit-Einstellung: Spieler aus den Einstellungen, Computer-Gegner mit Standardwerten
  function option(character, key) {
    const own = character.isPlayer ? game.settings?.controls?.[key] : undefined;
    return own ?? CONFIG.controls[key];
  }
  const _center = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };

  /**
   * Edit schließen. apply: true = übernehmen, false = verwerfen,
   * 'weapon' / 'build' = Wechsel zu Waffe / Bauteil → "Auto Confirm Edits" entscheidet.
   */
  function close(character, apply = true) {
    if (!sessions.has(character)) {
      candidates.delete(character);
      return;
    }
    if (apply === 'weapon' || apply === 'build') {
      const auto = option(character, 'autoConfirmEdits');
      apply = auto === 'both' || auto === apply;
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
