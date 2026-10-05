// =============================================================================
// Treffer anwenden (gemeinsam für Strahl-Waffen, Geschosse und Explosionen)
// =============================================================================
// damageCharacter: Schaden an einer Figur (Schild zuerst macht Character.applyDamage),
//                  danach Ereignis 'hit' (für Treffer-Marker und Schadenszahlen).
// damageObject:    Schaden an einem Bauteil oder Objekt (collider.data.ref.applyDamage).
//
// Das Ereignis-Objekt von 'hit' wird WIEDERVERWENDET (keine neuen Objekte pro Treffer):
// Wer etwas davon länger braucht, kopiert es sofort (z. B. point.clone()).
// =============================================================================
import * as THREE from 'three';

/**
 * @param {object} game
 */
export function createCombat(game) {
  const info = { attacker: null, weaponId: null, head: false, point: null, kind: 'bullet' };
  const hitEvent = {
    attacker: null,
    target: null, // Character oder Bauteil/Objekt (collider.data.ref)
    amount: 0, // wirklich angerichteter Schaden
    shieldDamage: 0,
    healthDamage: 0,
    head: false,
    shield: false, // true = Schild wurde getroffen (blaue Zahl)
    point: new THREE.Vector3(),
    killed: false,
    kind: 'character', // 'character' | 'piece' | 'object'
    weaponId: null,
    collider: null,
  };

  return {
    /**
     * Schaden an einer Figur. Unverwundbare Figuren (invulnerableUntil) nehmen nichts.
     * @returns {number} angerichteter Schaden (0 = nichts passiert, kein 'hit')
     */
    damageCharacter(attacker, target, amount, head, point, weaponId, kind = 'bullet') {
      if (!target?.alive || !(amount > 0)) return 0;
      info.attacker = attacker ?? null;
      info.weaponId = weaponId ?? null;
      info.head = !!head;
      info.point = point ?? null;
      info.kind = kind;
      const result = target.applyDamage(amount, info);
      const total = result.shieldDamage + result.healthDamage;
      if (total <= 0) return 0;
      hitEvent.attacker = attacker ?? null;
      hitEvent.target = target;
      hitEvent.amount = total;
      hitEvent.shieldDamage = result.shieldDamage;
      hitEvent.healthDamage = result.healthDamage;
      hitEvent.head = !!head;
      hitEvent.shield = result.shieldDamage > 0;
      if (point) hitEvent.point.copy(point);
      else hitEvent.point.set(target.position.x, target.position.y + target.height, target.position.z);
      hitEvent.killed = !!result.killed;
      hitEvent.kind = 'character';
      hitEvent.weaponId = weaponId ?? null;
      hitEvent.collider = null;
      game.events.emit('hit', hitEvent);
      return total;
    },

    /**
     * Schaden an einem Bauteil/Objekt mit collider.data.ref.applyDamage(amount, info).
     * @returns {number} angerichteter Schaden (0 = Objekt nimmt keinen Schaden)
     */
    damageObject(attacker, collider, amount, point, weaponId, kind = 'bullet') {
      const ref = collider?.data?.ref;
      if (!ref || typeof ref.applyDamage !== 'function' || !(amount > 0)) return 0;
      // Eigenes Objekt: Das Bau-System darf sich "info" merken (z. B. wer es zerstört hat)
      const result = ref.applyDamage(amount, { attacker: attacker ?? null, weaponId: weaponId ?? null, point: point ? point.clone() : null, kind });
      const done = typeof result === 'number' ? result : amount;
      if (!(done > 0)) return 0;
      hitEvent.attacker = attacker ?? null;
      hitEvent.target = ref;
      hitEvent.amount = done;
      hitEvent.shieldDamage = 0;
      hitEvent.healthDamage = done;
      hitEvent.head = false;
      hitEvent.shield = false;
      if (point) hitEvent.point.copy(point);
      hitEvent.killed = typeof ref.health === 'number' ? ref.health <= 0 : false;
      hitEvent.kind = collider.data.kind === 'piece' ? 'piece' : 'object';
      hitEvent.weaponId = weaponId ?? null;
      hitEvent.collider = collider;
      game.events.emit('hit', hitEvent);
      return done;
    },
  };
}

/** Kann dieser Collider Schaden nehmen? */
export function isDamageable(collider) {
  return typeof collider?.data?.ref?.applyDamage === 'function';
}

/** Ist es ein Bauteil (Schaden = structureDamage der Waffe)? */
export function isPiece(collider) {
  return collider?.data?.kind === 'piece';
}
