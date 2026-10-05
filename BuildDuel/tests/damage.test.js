// Tests: Schadens-Rechnung (core/damage.js) und Waffen-Werte aus config.js
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import {
  falloffFactor, weaponDamage, applyShieldFirst, explosionDamage, fallDamage, rarityMultiplier, damageNumberKind,
} from '../src/core/damage.js';
import { WEAPON_IDS, HEAL_IDS, spreadFor, fireIntervalOf, createItem, preferredSlot } from '../src/weapons/weapons.js';
import { spreadDirection } from '../src/weapons/hitscan.js';
import { createRng } from '../src/util/random.js';
import * as THREE from 'three';

const W = CONFIG.weapons;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

describe('Schaden: Abfall mit der Entfernung', () => {
  it('Schrotflinte: voll bis 5 m, bis 25 m auf 20 %', () => {
    const f = W.shotgun.falloff;
    assert.equal(falloffFactor(0, f), 1);
    assert.equal(falloffFactor(5, f), 1, '5 m');
    assert.close(falloffFactor(15, f), 0.6, 1e-12, 'Mitte (15 m)');
    assert.close(falloffFactor(25, f), 0.2, 1e-12, '25 m');
    assert.equal(falloffFactor(80, f), 0.2, 'weiter weg bleibt es bei 20 %');
  });

  it('Sturmgewehr: voll bis 30 m, ab 60 m 60 %; MP: voll bis 12 m, ab 30 m 50 %', () => {
    assert.equal(falloffFactor(30, W.ar.falloff), 1);
    assert.close(falloffFactor(45, W.ar.falloff), 0.8, 1e-12);
    assert.close(falloffFactor(60, W.ar.falloff), 0.6, 1e-12);
    assert.equal(falloffFactor(12, W.smg.falloff), 1);
    assert.close(falloffFactor(30, W.smg.falloff), 0.5, 1e-12);
  });

  it('wird mit der Entfernung nie mehr', () => {
    for (const id of WEAPON_IDS) {
      const f = W[id].falloff;
      let last = 1;
      for (let d = 0; d <= 120; d += 0.5) {
        const v = falloffFactor(d, f);
        assert.ok(v <= last + 1e-12 && v > 0, `${id} bei ${d} m: ${v}`);
        last = v;
      }
    }
  });

  it('ohne Abfall-Werte (Sniper) immer voll', () => {
    assert.equal(falloffFactor(500, W.sniper.falloff), 1);
  });
});

describe('Schaden: Treffer', () => {
  it('Sturmgewehr: Körper 30, Kopf ×1,5 = 45', () => {
    assert.equal(weaponDamage(W.ar, { distance: 10 }), 30);
    assert.equal(weaponDamage(W.ar, { distance: 10, head: true }), 45);
  });

  it('Sniper-Kopfschuss: 105 × 2,5 = 262,5', () => {
    assert.equal(weaponDamage(W.sniper, { distance: 100, head: true }), 262.5);
  });

  it('Schrotflinte: 10 Kugeln × 9 = 90 aus der Nähe, Kopf ×1,5 je Kugel', () => {
    assert.equal(weaponDamage(W.shotgun, { distance: 3, pellets: 10 }), 90);
    assert.equal(weaponDamage(W.shotgun, { distance: 3, head: true }), 13.5);
    assert.close(weaponDamage(W.shotgun, { distance: 25, pellets: 10 }), 18, 1e-9, 'auf 25 m nur noch 20 %');
  });

  it('Seltenheit: Bonus nur, wenn eine Seltenheit mitgegeben wird', () => {
    assert.equal(weaponDamage(W.ar, { distance: 1 }), 30, 'ohne Seltenheit (z. B. Duell)');
    assert.close(weaponDamage(W.ar, { distance: 1, rarity: 'legendary' }), 36, 1e-9, 'Legendär ×1,2');
    assert.close(weaponDamage(W.ar, { distance: 1, rarity: 'uncommon' }), 31.5, 1e-9, 'Ungewöhnlich ×1,05');
    assert.equal(rarityMultiplier('gibtsnicht'), 1);
    assert.equal(rarityMultiplier(null), 1);
  });
});

describe('Schaden: Schild zuerst', () => {
  it('Schild nimmt alles, solange er reicht', () => {
    const r = applyShieldFirst(100, 50, 30);
    assert.deepEqual([r.health, r.shield, r.shieldDamage, r.healthDamage], [100, 20, 30, 0]);
  });

  it('Rest geht aufs Leben', () => {
    const r = applyShieldFirst(100, 20, 50);
    assert.deepEqual([r.health, r.shield, r.shieldDamage, r.healthDamage], [70, 0, 20, 30]);
  });

  it('mehr Schaden als Leben + Schild: beide 0, nie negativ', () => {
    const r = applyShieldFirst(100, 100, 262.5);
    assert.deepEqual([r.health, r.shield, r.shieldDamage, r.healthDamage], [0, 0, 100, 100]);
  });

  it('negativer oder kein Schaden ändert nichts', () => {
    const r = applyShieldFirst(80, 10, -5);
    assert.deepEqual([r.health, r.shield], [80, 10]);
  });
});

describe('Schaden: Explosion und Fallen', () => {
  it('Granate: Mitte 70, am Rand (4 m) 30 % = 21, außerhalb 0', () => {
    const g = W.grenadeLauncher;
    assert.equal(explosionDamage(g, 0), 70);
    assert.close(explosionDamage(g, 4), 21, 1e-9);
    assert.close(explosionDamage(g, 2), 45.5, 1e-9);
    assert.equal(explosionDamage(g, 4.01), 0);
  });

  it('Fallschaden: bis 7 m nichts, 12 m → 50', () => {
    assert.equal(fallDamage(7), 0);
    assert.equal(fallDamage(12), 50);
  });

  it('Farbe der Treffer-Zahl: Kopf gelb vor Schild blau vor Körper weiß', () => {
    assert.equal(damageNumberKind(true, true), 'head');
    assert.equal(damageNumberKind(false, true), 'shield');
    assert.equal(damageNumberKind(false, false), 'body');
  });
});

describe('Waffen: Werte und Hilfen', () => {
  it('Streuung Sturmgewehr: 0,6°, laufen ×2, zielen ×0,4', () => {
    assert.close(spreadFor(W.ar, false, false), 0.6, 1e-12);
    assert.close(spreadFor(W.ar, true, false), 1.2, 1e-12);
    assert.close(spreadFor(W.ar, false, true), 0.24, 1e-12);
  });

  it('Streuung Schrotflinte fester Kegel 6°, Sniper mit Zielfernrohr 0°', () => {
    assert.equal(spreadFor(W.shotgun, true, true), 6);
    assert.equal(spreadFor(W.sniper, false, true), 0);
    assert.ok(spreadFor(W.sniper, false, false) > 0, 'aus der Hüfte ungenau');
  });

  it('Feuer-Tempo: AR 5,5/s, MP 12/s, Schrotflinte alle 0,8 s', () => {
    assert.close(fireIntervalOf(W.ar), 1 / 5.5, 1e-12);
    assert.close(fireIntervalOf(W.smg), 1 / 12, 1e-12);
    assert.equal(fireIntervalOf(W.shotgun), 0.8);
    assert.equal(fireIntervalOf(W.sniper), 1.6);
  });

  it('Kegel-Streuung: nie weiter als der halbe Winkel, 0° = genau geradeaus', () => {
    const rng = createRng(3);
    const dir = new THREE.Vector3(0.3, -0.2, -1).normalize();
    const out = new THREE.Vector3();
    let maxDeg = 0;
    for (let i = 0; i < 500; i++) {
      spreadDirection(dir, 6, rng, out);
      assert.close(out.length(), 1, 1e-9, 'Länge 1');
      maxDeg = Math.max(maxDeg, (out.angleTo(dir) * 180) / Math.PI);
    }
    assert.ok(maxDeg <= 3 + 1e-9 && maxDeg > 2.5, `größte Abweichung ${maxDeg.toFixed(3)}°`);
    spreadDirection(dir, 0, rng, out);
    assert.close(out.angleTo(dir), 0, 1e-12);
    // auch senkrecht nach oben
    const up = new THREE.Vector3(0, 1, 0);
    spreadDirection(up, 4, rng, out);
    assert.ok((out.angleTo(up) * 180) / Math.PI <= 2 + 1e-9);
  });

  it('Gegenstände: Waffe mit vollem Magazin, Heil-Item mit Anzahl', () => {
    const ar = createItem('ar', 'rare');
    assert.deepEqual([ar.kind, ar.ammo, ar.magazine, ar.rarity, ar.reserve], ['weapon', 30, 30, 'rare', W.defaultReserveAmmo.ar]);
    const b = createItem('bandage', 'common', { count: 5 });
    assert.deepEqual([b.kind, b.count, b.stack], ['heal', 5, CONFIG.healing.bandage.stack]);
    assert.equal(createItem('gibtsnicht'), null);
    assert.equal(createItem('ar', 'quatsch').rarity, 'common');
  });

  it('Plätze: 1 Schrotflinte, 2 AR, 3 Sniper, 4 MP/Pistole/Granatwerfer, 5 Heilen', () => {
    assert.deepEqual(['shotgun', 'ar', 'sniper', 'smg', 'pistol', 'grenadeLauncher'].map(preferredSlot), [1, 2, 3, 4, 4, 4]);
    for (const id of HEAL_IDS) assert.equal(preferredSlot(id), 5);
  });
});

describe('Spielwerte: Waffen-Optik und Übungsplatz (Phase 5)', () => {
  it('Farben sind gültig', () => {
    const v = CONFIG.weaponVisuals;
    for (const key of ['tracerColor', 'bulletColor', 'grenadeColor', 'explosionColor']) assert.ok(HEX_COLOR.test(v[key]), key);
    assert.ok(HEX_COLOR.test(v.damageNumbers.structureColor) && HEX_COLOR.test(v.damageNumbers.harvestColor));
    for (const key of ['damageBody', 'damageHead', 'damageShield']) assert.ok(HEX_COLOR.test(CONFIG.visuals.colors[key]), key);
  });

  it('Übungsplatz: alle Gegenstände gibt es, Platz 5 nur Heil-Items', () => {
    const slots = CONFIG.practiceRange.loadoutSlots;
    assert.equal(slots.length, 5);
    slots.forEach((list, i) => {
      for (const id of list) {
        assert.ok(WEAPON_IDS.includes(id) || HEAL_IDS.includes(id), `Platz ${i + 1}: "${id}" gibt es nicht`);
        assert.equal(preferredSlot(id), i + 1, `"${id}" gehört auf Platz ${preferredSlot(id)}`);
      }
    });
    const all = slots.flat();
    for (const id of WEAPON_IDS) assert.ok(all.includes(id), `Übungsplatz ohne ${id}`);
  });

  it('Zielpuppen auf 5, 15, 30 und 60 m, eine mit Schild, alle in der Arena', () => {
    const r = CONFIG.practiceRange;
    const half = CONFIG.modes.practice.arenaSize / 2;
    const d = r.dummies.list.map((x) => x.distance);
    for (const m of [5, 15, 30, 60]) assert.ok(d.includes(m), `${m} m fehlt`);
    assert.ok(r.dummies.list.some((x) => x.shield), 'eine Puppe mit Schild');
    for (const x of r.dummies.list) {
      const px = r.stand.x - x.distance;
      const pz = r.stand.z + (x.side ?? 0);
      assert.ok(Math.abs(px) < half - 1 && Math.abs(pz) < half - 1, `Puppe bei ${px}, ${pz}`);
    }
    assert.ok(r.dummies.health > 0 && r.dummies.regenDelay > 0);
  });

  it('Sammel-Objekte geben das richtige Material', () => {
    const h = CONFIG.materials.harvestSources;
    assert.deepEqual([h.tree, h.rock, h.car], ['wood', 'stone', 'metal']);
    const m = CONFIG.materials.harvestPerHit;
    assert.ok(m.min >= 1 && m.max >= m.min);
  });

  it('Mündung liegt nah an den Augen (sonst würde man durch dünne Wände schießen)', () => {
    const m = W.muzzleOffset;
    assert.ok(m.right < CONFIG.player.hitbox.radius, 'nicht weiter rechts als die Kapsel');
    assert.ok(Math.hypot(m.right, m.forward, m.down) < 0.6);
  });
});
