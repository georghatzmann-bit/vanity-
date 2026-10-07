// Tests für den Fortschritt (src/core/progress.js): Speichern, Level, Shop, Spind
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import {
  PROGRESS_KEY, defaultProgress, loadProgress, saveProgress, resetProgress, sanitizeProgress,
  levelInfo, xpForLevel, addXp, addMatchResult, catalog, findItem, canBuy, buyItem, equipItem,
  isOwned, equippedItems, createPlayRewards, defaultPickaxeId,
} from '../src/core/progress.js';
import { Game } from '../src/core/game.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.hasOwn(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('Fortschritt: Speichern und Laden', () => {
  it('Standard: Start-Münzen, Gratis-Sachen besessen und angezogen', () => {
    const p = defaultProgress();
    assert.equal(p.coins, CONFIG.progression.startCoins);
    assert.equal(p.xp, 0);
    assert.ok(p.owned.skins.includes(CONFIG.skins.defaultId), 'Standard-Skin');
    assert.ok(p.owned.skins.length >= 2, 'ein paar Gratis-Skins');
    assert.ok(p.owned.pickaxes.includes(defaultPickaxeId()));
    assert.ok(p.owned.emotes.includes(CONFIG.cosmetics.defaultEmote));
    assert.equal(p.equipped.skin, CONFIG.skins.defaultId);
    for (const key of ['trophies', 'coins', 'xp', 'passTier', 'owned', 'equipped', 'matches', 'wins']) assert.ok(key in p, key);
  });

  it('speichern → laden ergibt dasselbe', () => {
    const storage = memoryStorage();
    const p = defaultProgress();
    p.coins = 1234;
    p.xp = 777;
    p.trophies = 40;
    p.lastMode = 'practice';
    assert.ok(saveProgress(p, storage));
    assert.ok(storage.data[PROGRESS_KEY]);
    const q = loadProgress(storage);
    assert.equal(q.coins, 1234);
    assert.equal(q.xp, 777);
    assert.equal(q.trophies, 40);
    assert.equal(q.lastMode, 'practice');
  });

  it('kaputtes JSON, falsche Typen, unbekannte Sachen → Standard bzw. ignoriert', () => {
    assert.deepEqual(loadProgress(memoryStorage({ [PROGRESS_KEY]: '{kaputt' })), defaultProgress());
    const q = sanitizeProgress({
      coins: 'viel', xp: -50, trophies: 12.7, unbekannt: 1,
      owned: { skins: ['gibtsnicht', 42], pickaxes: 'gold' },
      equipped: { skin: 'gibtsnicht', pickaxe: 'gold' },
    });
    assert.equal(q.coins, CONFIG.progression.startCoins, 'Text statt Zahl');
    assert.equal(q.xp, 0, 'nie negativ');
    assert.equal(q.trophies, 12);
    assert.ok(!('unbekannt' in q));
    assert.ok(!q.owned.skins.includes('gibtsnicht'));
    assert.equal(q.equipped.skin, CONFIG.skins.defaultId, 'nicht besessen → Standard');
    assert.equal(q.equipped.pickaxe, defaultPickaxeId(), 'Goldhacke nicht gekauft');
    assert.deepEqual(sanitizeProgress(null), defaultProgress());
    assert.deepEqual(sanitizeProgress([1, 2]), defaultProgress());
  });

  it('gesperrter Speicher wirft nie', () => {
    const broken = { getItem() { throw new Error('gesperrt'); }, setItem() { throw new Error('voll'); }, removeItem() { throw new Error('x'); } };
    assert.deepEqual(loadProgress(broken), defaultProgress());
    assert.equal(saveProgress(defaultProgress(), broken), false);
    assert.deepEqual(resetProgress(broken), defaultProgress());
    assert.equal(saveProgress(defaultProgress(), null), false);
  });
});

describe('Fortschritt: Level', () => {
  it('Level-Rechnung: Grenzen genau, Bruchteil für den Balken', () => {
    assert.equal(levelInfo(0).level, 1);
    assert.equal(levelInfo(xpForLevel(1) - 1).level, 1);
    assert.equal(levelInfo(xpForLevel(1)).level, 2);
    assert.equal(levelInfo(xpForLevel(1) + xpForLevel(2)).level, 3);
    assert.ok(xpForLevel(2) > xpForLevel(1), 'höhere Level brauchen mehr');
    const half = levelInfo(Math.floor(xpForLevel(1) / 2));
    assert.close(half.fraction, 0.5, 0.01);
    assert.equal(levelInfo(1e9).level, CONFIG.progression.maxLevel);
    assert.equal(levelInfo(1e9).fraction, 1);
    assert.equal(levelInfo(NaN).level, 1);
  });

  it('XP geben: neues Level bringt Münzen', () => {
    const p = defaultProgress();
    const coins = p.coins;
    const r = addXp(p, xpForLevel(1) + 5);
    assert.equal(r.levelsGained, 1);
    assert.equal(r.level, 2);
    assert.equal(p.coins, coins + CONFIG.progression.coinsPerLevel);
    assert.equal(addXp(p, 1).levelsGained, 0);
  });

  it('Spiel-Ergebnis: Pokale, Münzen, Siege', () => {
    const p = defaultProgress();
    addMatchResult(p, { won: true, trophies: 25, coins: 50, xp: 100 });
    addMatchResult(p, { won: false, trophies: -100, coins: 10 });
    assert.equal(p.matches, 2);
    assert.equal(p.wins, 1);
    assert.equal(p.trophies, 0, 'nie unter 0');
    assert.equal(p.coins, CONFIG.progression.startCoins + 60);
    assert.equal(p.xp, 100);
  });
});

describe('Fortschritt: Shop und Spind', () => {
  it('Katalog: alle Skins aus CONFIG.skins, Preise aus den Stufen', () => {
    const skins = catalog('skins');
    assert.equal(skins.length, CONFIG.skins.list.length);
    for (const s of skins) assert.ok(Number.isFinite(s.price) && s.name && s.color, s.id);
    assert.equal(findItem('skins', CONFIG.skins.defaultId).price, 0, 'Standard-Skin gratis');
    assert.ok(catalog('pickaxes').length >= 3);
    assert.ok(catalog('emotes').length >= 3);
    assert.equal(findItem('emotes', 'gibtsnicht'), null);
  });

  it('kaufen: Münzen weg, Besitz da; zu teuer / doppelt geht nicht', () => {
    const p = defaultProgress();
    const target = catalog('pickaxes').find((x) => x.price > 0);
    assert.ok(!isOwned(p, 'pickaxes', target.id));
    p.coins = target.price - 1;
    assert.equal(canBuy(p, 'pickaxes', target.id).reason, 'coins');
    assert.equal(buyItem(p, 'pickaxes', target.id).ok, false);
    p.coins = target.price + 10;
    const r = buyItem(p, 'pickaxes', target.id);
    assert.ok(r.ok);
    assert.equal(p.coins, 10);
    assert.ok(isOwned(p, 'pickaxes', target.id));
    assert.equal(buyItem(p, 'pickaxes', target.id).reason, 'owned');
    assert.equal(canBuy(p, 'pickaxes', 'gibtsnicht').reason, 'unknown');
  });

  it('anziehen: nur Besessenes; gespeichert und wieder geladen', () => {
    const p = defaultProgress();
    const locked = catalog('skins').find((x) => x.price > 0);
    assert.equal(equipItem(p, 'skins', locked.id), false);
    p.coins = 99999;
    buyItem(p, 'skins', locked.id);
    assert.ok(equipItem(p, 'skins', locked.id));
    assert.equal(equippedItems(p).skin.id, locked.id);
    const storage = memoryStorage();
    saveProgress(p, storage);
    assert.equal(loadProgress(storage).equipped.skin, locked.id);
  });
});

describe('Fortschritt: XP beim Spielen', () => {
  it('XP pro Minute und pro 100 Bauteile (nur eigene)', () => {
    const game = new Game({ headless: true, seed: 1 });
    game.startMode('creative');
    const p = defaultProgress();
    let changes = 0;
    const rewards = createPlayRewards(game, p, { onChange: () => changes++ });
    game.systems.push(rewards);
    game.simulate(61);
    assert.equal(p.xp, CONFIG.progression.xpPerMinute, 'eine Minute');
    for (let i = 0; i < 100; i++) game.events.emit('piecePlaced', { piece: {}, owner: game.player });
    game.events.emit('piecePlaced', { piece: {}, owner: null }); // fremdes zählt nicht
    assert.equal(p.piecesBuilt, 100);
    assert.equal(p.xp, CONFIG.progression.xpPerMinute + CONFIG.progression.xpPer100Pieces);
    assert.equal(changes, 2);
    game.dispose();
  });
});
