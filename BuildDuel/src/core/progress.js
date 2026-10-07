// =============================================================================
// Fortschritt: Münzen, Erfahrung (XP) und Level, Pokale, gekaufte Sachen
// =============================================================================
// Alles wird im Browser gespeichert (localStorage, Schlüssel "buildduel.progress.v1").
// Wie bei den Einstellungen gilt: Kaputte oder alte Daten machen nie etwas kaputt –
// unbekannte Felder werden ignoriert, falsche Typen ebenso, kaputtes JSON → Standard.
//
// Shop und Spind (Werte in CONFIG.cosmetics):
//   - Arten (kind): 'skins' | 'pickaxes' | 'emotes'
//   - Skins kommen aus CONFIG.skins.list (Hut gehört zum Skin), Preis nach Listen-Platz
//   - bezahlt wird nur mit Spiel-Münzen
//
// Reine Logik (ohne Bildschirm) – darum auch in Tests benutzbar.
// =============================================================================
import { CONFIG } from '../config.js';

export const PROGRESS_KEY = `${CONFIG.game.storageKeyPrefix}progress.v1`;
export const ITEM_KINDS = Object.freeze(['skins', 'pickaxes', 'emotes']);
// welcher "equipped"-Eintrag zu welcher Art gehört
export const EQUIP_KEY = Object.freeze({ skins: 'skin', pickaxes: 'pickaxe', emotes: 'emote' });

const PR = CONFIG.progression;
const COS = CONFIG.cosmetics;

// -----------------------------------------------------------------------------
// Katalog (alle Sachen mit Preis)
// -----------------------------------------------------------------------------

/** Stufe ("Seltenheit") eines Skins nach seinem Platz in der Liste. */
function skinTier(index) {
  return COS.skinTiers[index] ?? COS.skinTierFallback;
}

function tierInfo(tier) {
  return COS.tiers[tier] ?? COS.tiers.selten;
}

/** Alle Sachen einer Art: [{ id, name, kind, tier, tierName, color, price, data }]. */
export function catalog(kind) {
  if (kind === 'skins') {
    return CONFIG.skins.list.map((skin, i) => {
      // Der Standard-Skin ist immer gratis (man muss etwas anhaben)
      const tier = skin.id === CONFIG.skins.defaultId ? 'frei' : skinTier(i);
      return item(kind, skin.id, skin.name ?? skin.id, tier, skin);
    });
  }
  if (kind === 'pickaxes') {
    // Gibt es eigene Spitzhacken-Formen (CONFIG.pickaxes.list), gelten diese – sonst die Farb-Varianten
    const forms = pickaxeForms();
    const list = forms ?? COS.pickaxes;
    const defaultId = defaultPickaxeId();
    return list.map((entry, i) => {
      const tier = entry.id === defaultId ? 'frei' : entry.tier ?? COS.pickaxeTiers?.[i] ?? COS.skinTierFallback;
      return item(kind, entry.id, entry.name ?? entry.id, tier, entry);
    });
  }
  const list = kind === 'emotes' ? COS.emotes : [];
  return list.map((entry) => item(kind, entry.id, entry.name, entry.tier, entry));
}

/** Spitzhacken-Formen aus CONFIG.pickaxes.list (andere Welle) – oder null, wenn es sie nicht gibt. */
export function pickaxeForms() {
  const list = CONFIG.pickaxes?.list;
  return Array.isArray(list) && list.length > 0 ? list : null;
}

/** Standard-Spitzhacke (gratis, immer im Besitz). */
export function defaultPickaxeId() {
  return pickaxeForms() ? CONFIG.pickaxes.defaultId ?? pickaxeForms()[0].id : COS.defaultPickaxe;
}

function item(kind, id, name, tier, data) {
  const info = tierInfo(tier);
  return { id, name, kind, tier, tierName: info.name, color: info.color, price: info.price, data };
}

/** Eine Sache suchen. Unbekannt → null. */
export function findItem(kind, id) {
  return catalog(kind).find((entry) => entry.id === id) ?? null;
}

/** Preis in Münzen (unbekannt → null). */
export function itemPrice(kind, id) {
  return findItem(kind, id)?.price ?? null;
}

function freeIds(kind) {
  return catalog(kind).filter((entry) => entry.price === 0).map((entry) => entry.id);
}

function defaultEquipped() {
  return {
    skin: CONFIG.skins.defaultId,
    hat: null, // Hut gehört zum Skin (Feld bleibt für die Form aus ARCHITECTURE.md §11)
    pickaxe: defaultPickaxeId(),
    emote: COS.defaultEmote,
  };
}

// -----------------------------------------------------------------------------
// Standardwerte, Laden, Speichern
// -----------------------------------------------------------------------------

/** Frischer Fortschritt (jedes Mal ein neues Objekt). */
export function defaultProgress() {
  return {
    trophies: 0,
    coins: PR.startCoins,
    xp: 0,
    passTier: 0,
    owned: { skins: freeIds('skins'), hats: [], pickaxes: freeIds('pickaxes'), emotes: freeIds('emotes') },
    equipped: defaultEquipped(),
    matches: 0,
    wins: 0,
    playSeconds: 0, // gespielte Zeit in Kreativ/Übung (für XP pro Minute)
    piecesBuilt: 0, // gebaute Bauteile insgesamt (für XP pro 100 Bauteile)
    lastMode: CONFIG.lobby.defaultMode, // zuletzt in der Lobby gewählter Modus
  };
}

const COUNTERS = ['trophies', 'coins', 'xp', 'passTier', 'matches', 'wins', 'playSeconds', 'piecesBuilt'];

/** Gespeicherte Daten prüfen und über die Standardwerte legen. */
export function sanitizeProgress(stored) {
  const p = defaultProgress();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return p;
  for (const key of COUNTERS) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isFinite(v)) p[key] = Math.max(0, key === 'playSeconds' ? v : Math.floor(v));
  }
  if (typeof stored.lastMode === 'string' && stored.lastMode.length < 40) p.lastMode = stored.lastMode;
  // Besitz: nur bekannte Sachen; Gratis-Sachen hat man immer
  const owned = stored.owned && typeof stored.owned === 'object' ? stored.owned : {};
  for (const kind of ITEM_KINDS) {
    const known = new Set(catalog(kind).map((entry) => entry.id));
    const list = Array.isArray(owned[kind]) ? owned[kind] : [];
    for (const id of list) {
      if (typeof id === 'string' && known.has(id) && !p.owned[kind].includes(id)) p.owned[kind].push(id);
    }
  }
  // Angezogen: nur, was man besitzt – sonst Standard
  const equipped = stored.equipped && typeof stored.equipped === 'object' ? stored.equipped : {};
  for (const kind of ITEM_KINDS) {
    const key = EQUIP_KEY[kind];
    if (typeof equipped[key] === 'string' && p.owned[kind].includes(equipped[key])) p.equipped[key] = equipped[key];
  }
  p.passTier = Math.min(PR.passTiers, p.passTier);
  return p;
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Lädt den Fortschritt. Fehlt etwas oder ist etwas kaputt → Standardwerte. */
export function loadProgress(storage = defaultStorage()) {
  if (!storage) return defaultProgress();
  let raw = null;
  try {
    raw = storage.getItem(PROGRESS_KEY);
  } catch {
    return defaultProgress();
  }
  if (!raw) return defaultProgress();
  try {
    return sanitizeProgress(JSON.parse(raw));
  } catch {
    return defaultProgress(); // kaputtes JSON
  }
}

/** Speichert den Fortschritt. @returns {boolean} true = hat geklappt */
export function saveProgress(progress, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}

/** Löscht den gespeicherten Fortschritt und gibt frische Standardwerte zurück. */
export function resetProgress(storage = defaultStorage()) {
  try {
    storage?.removeItem(PROGRESS_KEY);
  } catch {
    // egal
  }
  return defaultProgress();
}

// -----------------------------------------------------------------------------
// Level-Rechnung
// -----------------------------------------------------------------------------

/** XP, die man von Level n auf n+1 braucht. */
export function xpForLevel(level) {
  return PR.levelXpBase + PR.levelXpStep * Math.max(0, level - 1);
}

/**
 * Level aus der gesamten Erfahrung.
 * @returns {{ level, xpIntoLevel, xpForNext, fraction, maxed }}
 */
export function levelInfo(totalXp) {
  let xp = Math.max(0, Math.floor(Number.isFinite(totalXp) ? totalXp : 0));
  let level = 1;
  while (level < PR.maxLevel && xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level++;
  }
  const maxed = level >= PR.maxLevel;
  const need = xpForLevel(level);
  return { level, xpIntoLevel: maxed ? need : xp, xpForNext: need, fraction: maxed ? 1 : xp / need, maxed };
}

/**
 * XP gutschreiben. Jedes neue Level gibt CONFIG.progression.coinsPerLevel Münzen.
 * @returns {{ levelsGained: number, coinsGained: number, level: number }}
 */
export function addXp(progress, amount) {
  const before = levelInfo(progress.xp).level;
  progress.xp = Math.max(0, Math.floor(progress.xp + Math.max(0, amount)));
  const after = levelInfo(progress.xp).level;
  const levelsGained = Math.max(0, after - before);
  const coinsGained = levelsGained * PR.coinsPerLevel;
  progress.coins += coinsGained;
  progress.passTier = Math.min(PR.passTiers, Math.max(progress.passTier, after - 1));
  return { levelsGained, coinsGained, level: after };
}

/** Ergebnis eines Spiels eintragen (mode.result, ARCHITECTURE.md §10). */
export function addMatchResult(progress, result = {}) {
  progress.matches++;
  if (result.won) progress.wins++;
  if (Number.isFinite(result.trophies)) progress.trophies = Math.max(0, progress.trophies + Math.round(result.trophies));
  if (Number.isFinite(result.coins)) progress.coins = Math.max(0, progress.coins + Math.round(result.coins));
  return addXp(progress, Number.isFinite(result.xp) ? result.xp : 0);
}

// -----------------------------------------------------------------------------
// Shop und Spind
// -----------------------------------------------------------------------------

export function isOwned(progress, kind, id) {
  return !!progress.owned?.[kind]?.includes(id);
}

/** Kann man das kaufen? → { ok, reason: 'owned' | 'unknown' | 'coins' | null, price } */
export function canBuy(progress, kind, id) {
  const entry = findItem(kind, id);
  if (!entry) return { ok: false, reason: 'unknown', price: null };
  if (isOwned(progress, kind, id)) return { ok: false, reason: 'owned', price: entry.price };
  if (progress.coins < entry.price) return { ok: false, reason: 'coins', price: entry.price };
  return { ok: true, reason: null, price: entry.price };
}

/** Kaufen (Münzen abziehen, als Besitz eintragen). → wie canBuy */
export function buyItem(progress, kind, id) {
  const check = canBuy(progress, kind, id);
  if (!check.ok) return check;
  progress.coins -= check.price;
  progress.owned[kind].push(id);
  return check;
}

/** Anziehen/auswählen (nur, was man besitzt). @returns {boolean} */
export function equipItem(progress, kind, id) {
  if (!isOwned(progress, kind, id)) return false;
  progress.equipped[EQUIP_KEY[kind]] = id;
  return true;
}

/** Die angezogenen Sachen als Daten: { skin, pickaxe, emote } (Einträge aus dem Katalog). */
export function equippedItems(progress) {
  const e = progress.equipped ?? defaultEquipped();
  return {
    skin: findItem('skins', e.skin) ?? findItem('skins', CONFIG.skins.defaultId),
    pickaxe: findItem('pickaxes', e.pickaxe) ?? findItem('pickaxes', defaultPickaxeId()),
    emote: findItem('emotes', e.emote) ?? findItem('emotes', COS.defaultEmote),
  };
}

// -----------------------------------------------------------------------------
// XP beim Spielen (Kreativ, Übungsplatz)
// -----------------------------------------------------------------------------

/**
 * System für game.systems: zählt gespielte Zeit und gebaute Bauteile des Spielers und
 * gibt dafür XP (CONFIG.progression.xpPerMinute, xpPer100Pieces). Läuft nur, solange
 * das Spiel rechnet (Pause = keine Zeit).
 * @param {object} game
 * @param {object} progress
 * @param {object} [options] { onChange(info) – nach jeder Gutschrift (zum Speichern/Anzeigen) }
 */
export function createPlayRewards(game, progress, options = {}) {
  const onChange = options.onChange ?? null;
  let secondsLeft = 60 - (progress.playSeconds % 60);
  let piecesLeft = 100 - (progress.piecesBuilt % 100);
  const off = game.events.on('piecePlaced', (e) => {
    if (!game.player || e.owner !== game.player) return;
    progress.piecesBuilt++;
    if (--piecesLeft <= 0) {
      piecesLeft = 100;
      grant(PR.xpPer100Pieces, 'pieces');
    }
  });

  function grant(xp, reason) {
    const result = addXp(progress, xp);
    if (result.levelsGained > 0) {
      game.events.emit('message', {
        text: `Level ${result.level}! +${result.coinsGained} Münzen`,
        kind: 'info',
        duration: 2.5,
      });
    }
    onChange?.({ xp, reason, ...result });
  }

  return {
    update(dt) {
      if (!game.player) return;
      progress.playSeconds += dt;
      secondsLeft -= dt;
      if (secondsLeft <= 0) {
        secondsLeft += 60;
        grant(PR.xpPerMinute, 'time');
      }
    },
    dispose() {
      off();
    },
  };
}
