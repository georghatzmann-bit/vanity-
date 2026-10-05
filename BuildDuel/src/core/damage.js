// =============================================================================
// Schadens-Rechnung (reine Mathematik, ohne Grafik – gut testbar)
// =============================================================================
// - falloffFactor:   Schadens-Abfall mit der Entfernung (voll bis X m, dann weniger)
// - weaponDamage:    Schaden eines Treffers (Grundschaden × Abfall × Kopf × Seltenheit)
// - applyShieldFirst: Schild nimmt den Schaden zuerst, der Rest geht aufs Leben
// - explosionDamage: Granate – in der Mitte voll, am Rand weniger
// - fallDamage:      Fallschaden aus der Fallhöhe
// - damageNumberKind: Farbe der Treffer-Zahl (Kopf gelb, Schild blau, sonst weiß)
// Alle Zahlen kommen aus config.js.
// =============================================================================
import { CONFIG } from '../config.js';

/**
 * Anteil des Schadens nach Entfernung (1 = voll).
 * falloff = { fullUntil, minAt, minFactor }: bis fullUntil voll, dann gleichmäßig weniger,
 * ab minAt nur noch minFactor. Ohne falloff immer 1.
 * Beispiel Schrotflinte { 5, 25, 0.2 }: 5 m → 1, 15 m → 0,6, 25 m und weiter → 0,2.
 */
export function falloffFactor(distance, falloff) {
  if (!falloff) return 1;
  const { fullUntil, minAt, minFactor } = falloff;
  if (!(distance > fullUntil)) return 1;
  if (distance >= minAt) return minFactor;
  const t = (distance - fullUntil) / (minAt - fullUntil);
  return 1 + (minFactor - 1) * t;
}

/** Schadens-Faktor einer Seltenheit ('common' … 'legendary'). Unbekannt/null → 1. */
export function rarityMultiplier(rarity, rarities = CONFIG.rarities) {
  if (!rarity) return 1;
  return rarities[rarity]?.damageMultiplier ?? 1;
}

/**
 * Schaden eines Treffers an einer Figur.
 * @param {object} def  Waffen-Werte aus CONFIG.weapons (damage oder damagePerPellet, headMultiplier, falloff)
 * @param {object} [hit] { distance (m), head (bool), rarity (nur im Battle Royale, sonst null), pellets (Anzahl Kugeln) }
 * @returns {number} Schaden (nicht gerundet, z. B. Sniper-Kopfschuss 262,5)
 */
export function weaponDamage(def, hit = {}) {
  const base = def.damage ?? def.damagePerPellet ?? 0;
  const distance = hit.distance ?? 0;
  const head = hit.head ? (def.headMultiplier ?? 1) : 1;
  const pellets = hit.pellets ?? 1;
  return base * falloffFactor(distance, def.falloff) * head * rarityMultiplier(hit.rarity ?? null) * pellets;
}

/**
 * Schild zuerst: Wie viel nimmt der Schild, wie viel das Leben?
 * @param {number} health
 * @param {number} shield
 * @param {number} damage
 * @param {object} [out]  wird gefüllt (spart neue Objekte)
 * @returns {{health:number, shield:number, shieldDamage:number, healthDamage:number}}
 */
export function applyShieldFirst(health, shield, damage, out = {}) {
  const d = damage > 0 ? damage : 0;
  const shieldDamage = Math.min(shield > 0 ? shield : 0, d);
  const healthDamage = Math.min(health > 0 ? health : 0, d - shieldDamage);
  out.shieldDamage = shieldDamage;
  out.healthDamage = healthDamage;
  out.shield = shield - shieldDamage;
  out.health = health - healthDamage;
  return out;
}

/**
 * Explosions-Schaden in einer Entfernung vom Mittelpunkt.
 * def = { explosionDamage, explosionRadius, edgeDamageFactor }: in der Mitte voll,
 * am Rand (Radius) nur noch edgeDamageFactor, außerhalb 0.
 */
export function explosionDamage(def, distance) {
  const r = def.explosionRadius;
  if (!(distance <= r) || !(r > 0)) return 0;
  const t = Math.max(0, distance) / r;
  return def.explosionDamage * (1 + ((def.edgeDamageFactor ?? 1) - 1) * t);
}

/** Fallschaden: bis safeHeight nichts, danach damagePerMeter je Meter. */
export function fallDamage(height, fd = CONFIG.player.fallDamage) {
  return height > fd.safeHeight ? (height - fd.safeHeight) * fd.damagePerMeter : 0;
}

/**
 * Welche Farbe bekommt die Treffer-Zahl?
 * Kopf → 'head' (gelb), sonst Schild getroffen → 'shield' (blau), sonst 'body' (weiß).
 */
export function damageNumberKind(head, shieldHit) {
  if (head) return 'head';
  if (shieldHit) return 'shield';
  return 'body';
}
