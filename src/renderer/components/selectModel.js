// Pure data model for the select screen: merges profile apps with the curated catalog,
// orders categories, finds the GPU driver suggestion and builds the install job.

export const OTHER = 'Weitere Apps';
export const CATEGORY_ORDER = ['Gaming-Launcher', 'Gaming-Tools', 'Browser', 'Kommunikation', 'Musik & Video', 'Tools', 'Treiber & Runtimes'];
/** Games need their launcher – used for the "launcher missing" hint. */
export const LAUNCHER_KEYS = { epic: 'winget:EpicGames.EpicGamesLauncher', steam: 'winget:Valve.Steam' };
export const PLATFORM_LABEL = { epic: 'Epic Games', steam: 'Steam', other: 'Spiel' };

export const keyOf = (source, id) => `${source}:${id}`;
export const gameKey = (g) => `${g.platform || 'other'}:${g.appId ?? g.appName ?? g.title}`;

const lower = (s) => String(s || '').toLowerCase();
const known = (v) => (v && v !== 'unknown' ? v : null);
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

/** Lowercase + strip diacritics, for forgiving search ("ubi" finds "Übisoft"). */
export const fold = (s) => lower(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

export function prettifyId(id) {
  const parts = String(id || '').split('.');
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  return (
    rest
      .join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim() || String(id || '')
  );
}

function profileDesc(app) {
  const parts = [];
  if (app.version) parts.push(`Version ${app.version}`);
  if (app.publisher) parts.push(app.publisher);
  if (parts.length) return parts.join(' · ');
  return app.source === 'msstore' ? 'Aus dem Microsoft Store' : app.id;
}

/** "NVIDIA GeForce RTX 4070 SUPER" -> "RTX 4070 SUPER"; "AMD Radeon RX 7800 XT" -> "Radeon RX 7800 XT" */
export function shortGpuName(name = '') {
  return String(name)
    .replace(/\((R|TM)\)/gi, '')
    .replace(/^\s*NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .replace(/^\s*AMD\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * buildModel({ mode, profile, catalog, machine })
 * -> { entries: Map<key, Entry>, categories: [{ name, keys }], profileKeys, popularKeys, games, unmatched, gpu }
 * Entry = { key, id, source, name, desc, homepage, icon, category, elevation, scope, inProfile, popular, link, url, catalog, search }
 */
export function buildModel({ mode, profile, catalog, machine }) {
  const items = (catalog && Array.isArray(catalog.items) ? catalog.items : []).filter((i) => i && i.id && i.source);
  const catIndex = new Map(items.map((it) => [lower(keyOf(it.source, it.id)), it]));
  const entries = new Map();
  const profileKeys = [];
  // Locale variants: "Mozilla.Firefox" from a backup belongs to the curated "Mozilla.Firefox.de" tile
  // (one tile instead of an uncategorised duplicate) – but the id from the backup is what gets installed.
  const variantOf = (source, id) => {
    const base = `${lower(id)}.`;
    return items.find((it) => it.source === source && lower(it.id).startsWith(base) && /^[a-z]{2}(-[a-z]{2})?$/.test(lower(it.id).slice(base.length))) || null;
  };

  if (mode === 'restore' && profile) {
    for (const app of profile.apps || []) {
      if (!app || !app.id) continue;
      const source = app.source === 'msstore' ? 'msstore' : 'winget';
      const exact = catIndex.get(lower(keyOf(source, app.id))) || null;
      const cat = exact || variantOf(source, app.id);
      const key = cat ? keyOf(cat.source, cat.id) : keyOf(source, app.id);
      if (entries.has(key)) continue;
      entries.set(key, {
        key,
        id: exact ? exact.id : app.id,
        source,
        name: (cat && cat.name) || app.name || prettifyId(app.id),
        desc: (cat && cat.desc) || profileDesc({ ...app, source }),
        homepage: (cat && cat.homepage) || null,
        icon: typeof app.icon === 'string' && app.icon.startsWith('data:image/') ? app.icon : null,
        category: (cat && cat.category) || app.category || OTHER,
        elevation: known(cat && cat.elevation) || known(app.elevation) || 'unknown',
        scope: known(cat && cat.scope) || 'unknown',
        inProfile: true,
        popular: !!(cat && cat.popular),
        link: false,
        url: null,
        catalog: cat || null,
      });
      profileKeys.push(key);
    }
  }

  for (const it of items) {
    const key = keyOf(it.source, it.id);
    if (entries.has(key)) continue;
    entries.set(key, {
      key,
      id: it.id,
      source: it.source,
      name: it.name || prettifyId(it.id),
      desc: it.desc || '',
      homepage: it.homepage || null,
      icon: null,
      category: it.category || OTHER,
      elevation: it.elevation || 'unknown',
      scope: it.scope || 'unknown',
      inProfile: false,
      popular: !!it.popular,
      link: it.source === 'link',
      url: it.url || null,
      catalog: it,
    });
  }

  for (const e of entries.values()) e.search = fold(`${e.name} ${e.desc} ${e.id} ${e.category} ${(e.catalog && e.catalog.desc) || ''}`);

  // Categories: fixed order first, unknown ones after, "Weitere Apps" last.
  const byCat = new Map();
  for (const e of entries.values()) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }
  const names = [...byCat.keys()];
  const ordered = [
    ...CATEGORY_ORDER.filter((c) => byCat.has(c)),
    ...names.filter((c) => !CATEGORY_ORDER.includes(c) && c !== OTHER).sort(collator.compare),
    ...(byCat.has(OTHER) ? [OTHER] : []),
  ];
  const sortEntries = (a, b) =>
    Number(b.inProfile) - Number(a.inProfile) || Number(b.popular) - Number(a.popular) || Number(a.link) - Number(b.link) || collator.compare(a.name, b.name);
  const categories = ordered.map((name) => ({ name, keys: byCat.get(name).sort(sortEntries).map((e) => e.key) }));
  const rank = new Map();
  categories.forEach((c) => c.keys.forEach((k, i) => rank.set(k, ordered.indexOf(c.name) * 10000 + i)));
  profileKeys.sort((a, b) => rank.get(a) - rank.get(b));

  const popularKeys = categories.flatMap((c) => c.keys).filter((k) => entries.get(k).popular && !entries.get(k).link);

  // GPU-aware driver suggestion.
  let gpu = null;
  const gpus = (machine && Array.isArray(machine.gpus) ? machine.gpus : []).filter(Boolean);
  const nv = gpus.find((g) => g.vendor === 'nvidia' || /nvidia|geforce/i.test(g.name || ''));
  const amd = gpus.find((g) => g.vendor === 'amd' || /radeon/i.test(g.name || ''));
  if (nv) {
    const e = [...entries.values()].find((x) => /^nvidia app$/i.test(x.name));
    if (e) gpu = { vendor: 'nvidia', name: nv.name, short: shortGpuName(nv.name), key: e.key };
  } else if (amd) {
    const e = [...entries.values()].find((x) => /adrenalin/i.test(x.name) || x.id === 'AMDSoftwareAdrenalin');
    if (e) gpu = { vendor: 'amd', name: amd.name, short: shortGpuName(amd.name), key: e.key };
  }

  const games =
    mode === 'restore' && profile
      ? (profile.games || [])
          .filter((g) => g && g.title)
          .map((g) => ({ key: gameKey(g), game: g, title: g.title, platform: g.platform || 'other' }))
          .filter((g, i, arr) => arr.findIndex((x) => x.key === g.key) === i)
      : [];
  const unmatched = mode === 'restore' && profile ? (profile.unmatched || []).filter((u) => u && u.name) : [];

  return { entries, categories, profileKeys, popularKeys, games, unmatched, gpu };
}

/**
 * Install job per ARCHITECTURE §10:
 * { items: [{ key, id, source, name, elevation, scope }] (winget/msstore only), links: CatalogItem[], games: GameEntry[] }
 */
export function buildInstallJob(model, selectedKeys, selectedGameKeys) {
  const items = [];
  const links = [];
  for (const cat of model.categories) {
    for (const key of cat.keys) {
      if (!selectedKeys.has(key)) continue;
      const e = model.entries.get(key);
      if (e.link) {
        if (e.catalog) links.push({ ...e.catalog });
      } else {
        items.push({ key: keyOf(e.source, e.id), id: e.id, source: e.source, name: e.name, elevation: e.elevation || 'unknown', scope: e.scope || 'unknown' });
      }
    }
  }
  const games = model.games.filter((g) => selectedGameKeys.has(g.key)).map((g) => g.game);
  return { items, links, games };
}
