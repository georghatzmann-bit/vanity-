// Simulator für die Vorschau im normalen Browser und für Oberflächen-Tests.
// Ahmt den Hauptprozess mit Beispieldaten nach. Wird im fertigen Programm nicht benutzt.

const now = Date.now();
const H = 3600 * 1000;

const FILES = [
  { root: 'config', rel: 'WindowsClient/GameUserSettings.ini', size: 4310, kind: 'video', label: 'Grafik, Auflösung, FPS & Anzeige' },
  { root: 'saved', rel: 'Cloud/9f2c41d0a7b3e8c6d5f4a3b2c1d0e9f8/ClientSettings.Sav', size: 18122, kind: 'controls', label: 'Tastenbelegung, Sensi & Spieleinstellungen (Cloud-Kopie)' },
  { root: 'config', rel: 'WindowsClient/Engine.ini', size: 220, kind: 'engine', label: 'Engine-Einstellungen' },
  { root: 'config', rel: 'WindowsClient/Input.ini', size: 96, kind: 'input', label: 'Eingabe' },
  { root: 'config', rel: 'CrashReportClient/UECC-Windows-4F1C/CrashReportClient.ini', size: 64, kind: 'crash', label: 'Einstellungen für Fehlerberichte' },
];

const db = {
  fortnite: { running: false, gameRunning: false, processes: [] },
  activeId: 'p-main-1a2b3c',
  profiles: [
    mkProfile('p-main-1a2b3c', 'Main', 196, { resolution: '1920×1080', fps: '240 FPS', renderMode: 'Leistungsmodus', quality: 'Niedrig', windowMode: 'Vollbild' }, 14, ['video']),
    mkProfile('p-zweitaccount-4d5e6f', 'Zweitaccount', 276, { resolution: '1600×900', fps: '165 FPS', renderMode: 'DirectX 12', quality: 'Mittel', windowMode: 'Vollbild' }, 3, 'none'),
    mkProfile('p-turnier-778899', 'Turnier', 32, { resolution: '1920×1080', fps: '360 FPS', renderMode: 'Leistungsmodus', quality: 'Niedrig', windowMode: 'Vollbild' }, 6, 'all'),
  ],
  backups: [
    { id: '20261018-101500-ab12', createdAt: now - 2 * H, reason: 'vor-anwenden', label: 'Vor dem Anwenden von „Main“', pinned: false, fileCount: 5, bytes: 22812 },
    { id: '20261017-220500-cd34', createdAt: now - 14 * H, reason: 'manuell', label: 'Vor Season-Update', pinned: true, fileCount: 5, bytes: 22790 },
    { id: '20261010-090000-ef56', createdAt: now - 8 * 24 * H, reason: 'original', label: 'Originalzustand beim ersten Start von HELIX', pinned: true, fileCount: 4, bytes: 21900 },
  ],
  app: { sound: true, volume: 0.4, intro: true, reduceMotion: false, closeToTray: true },
};

function mkProfile(id, name, color, summary, applied, readOnly) {
  return {
    id, name, color, notes: '', createdAt: now - 20 * 24 * H, updatedAt: now - applied * H, fileCount: FILES.length,
    bytes: FILES.reduce((n, f) => n + f.size, 0), kinds: FILES.map((f) => f.kind), files: FILES, summary,
    options: { readOnly, removeExtra: true }, stats: { appliedCount: applied, lastAppliedAt: now - applied * 3 * H },
  };
}

const listeners = new Set();
function emit(name, payload) { for (const l of listeners) l(name, payload); }
const pub = (p) => ({ ...p, active: p.id === db.activeId });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (code, message) => { const e = new Error(message); e.code = code; throw e; };

function findP(id) { return db.profiles.find((p) => p.id === id) || err('NOT_FOUND', 'Profil nicht gefunden.'); }

const CORE = {
  'core.status': () => ({
    fortnite: db.fortnite,
    location: { found: true, configDir: 'C:\\Users\\Spieler\\AppData\\Local\\FortniteGame\\Saved\\Config', savedDir: 'C:\\Users\\Spieler\\AppData\\Local\\FortniteGame\\Saved', source: 'standard', searched: [] },
    active: db.activeId ? { id: db.activeId, name: findP(db.activeId).name, appliedAt: now - 2 * H } : null,
    drift: { status: 'ok' },
    profileCount: db.profiles.length,
    backupCount: db.backups.length,
    platform: 'win32',
  }),
  'core.locate': () => CORE['core.status'](),
  'core.scan': () => ({
    configDir: 'C:\\Users\\Spieler\\AppData\\Local\\FortniteGame\\Saved\\Config',
    totals: { found: FILES.length + 1, included: FILES.length, bytes: 22812, readOnly: 1 },
    files: [
      ...FILES.map((f, i) => ({ ...f, mtimeMs: now - i * 5 * H, included: true, readOnly: f.kind === 'video', reason: null, protectedParts: f.kind === 'video' ? 0 : 0 })),
      { root: 'config', rel: 'WindowsClient/helix-tmp.log', size: 12, kind: 'other', label: 'Weitere Datei', mtimeMs: now, included: false, readOnly: false, reason: 'Schutzfilter: sieht nach Login-, Browser- oder Protokolldaten aus', protectedParts: 0 },
    ],
    errors: [],
  }),
  'core.fortniteStatus': () => db.fortnite,
  'core.fortniteClose': async () => { await wait(600); db.fortnite = { running: false, gameRunning: false, processes: [] }; emit('fortnite.state', db.fortnite); return { closed: true, remaining: [] }; },
  'core.driftCheck': () => ({ status: 'ok' }),
  'core.driftAck': () => ({ ok: true }),
  'core.readOnlyClearAll': () => ({ cleared: ['WindowsClient/GameUserSettings.ini'] }),
  'core.readOnlySet': (a) => ({ rel: a.rel, readOnly: !!a.on }),
  'core.openFolder': (a) => ({ opened: a.which }),
  'core.showFile': () => ({}),
  'core.pickFolder': () => ({ canceled: true }),
  'core.resetFolder': () => ({ found: true }),
  'core.sessions': () => ({
    running: false,
    totalSeconds: 98 * 3600,
    perProfile: [
      { profileId: 'p-main-1a2b3c', name: 'Main', seconds: 71 * 3600, sessions: 64 },
      { profileId: 'p-turnier-778899', name: 'Turnier', seconds: 19 * 3600, sessions: 12 },
      { profileId: 'p-zweitaccount-4d5e6f', name: 'Zweitaccount', seconds: 8 * 3600, sessions: 9 },
    ],
    daily: Array.from({ length: 30 }, (_, i) => ({ day: new Date(now - (29 - i) * 24 * H).toISOString().slice(0, 10), seconds: Math.round((Math.sin(i * 1.7) + 1.2) * 4000 + (i % 6 === 0 ? 0 : 3000)) })),
    recent: [{ start: now - 5 * H, end: now - 3 * H, profileName: 'Main' }, { start: now - 28 * H, end: now - 26.5 * H, profileName: 'Turnier' }],
  }),
  'profiles.list': () => db.profiles.map(pub),
  'profiles.get': (a) => pub(findP(a.id)),
  'profiles.create': async (a) => {
    await wait(400);
    if (db.profiles.some((p) => p.name.toLowerCase() === String(a.name).toLowerCase())) err('NAME_TAKEN', `Es gibt schon ein Profil mit dem Namen „${a.name}“.`);
    const p = mkProfile(`p-${Date.now()}`, a.name, (db.profiles.length * 47 + 190) % 360, db.profiles[0].summary, 0, 'none');
    p.stats = { appliedCount: 0, lastAppliedAt: null };
    db.profiles.push(p);
    return pub(p);
  },
  'profiles.update': (a) => pub(findP(a.id)),
  'profiles.rename': (a) => { const p = findP(a.id); p.name = a.name; return pub(p); },
  'profiles.duplicate': (a) => { const p = findP(a.id); const c = { ...p, id: `p-copy-${Date.now()}`, name: `${p.name} Kopie` }; db.profiles.push(c); return pub(c); },
  'profiles.remove': (a) => { db.profiles = db.profiles.filter((p) => p.id !== a.id); return { removed: true }; },
  'profiles.options': (a) => { const p = findP(a.id); p.options = { ...p.options, ...a.options }; return pub(p); },
  'profiles.preview': (a) => ({
    profile: pub(findP(a.id)),
    counts: { change: 2, new: 1, same: 2, remove: 0, skip: 0, locked: 0 },
    items: FILES.map((f, i) => ({ ...f, action: i < 2 ? 'change' : i === 2 ? 'new' : 'same' })),
    fortnite: db.fortnite,
    target: { configDir: 'C:\\Users\\Spieler\\AppData\\Local\\FortniteGame\\Saved\\Config' },
  }),
  'profiles.apply': async (a) => {
    await wait(700);
    const p = findP(a.id);
    db.activeId = p.id;
    p.stats = { appliedCount: (p.stats.appliedCount || 0) + 1, lastAppliedAt: Date.now() };
    emit('profiles.applied', { profileId: p.id });
    return {
      ok: true, profile: pub(p), backupId: db.backups[0].id, readOnlyMode: a.readOnly,
      written: FILES.slice(0, 3).map((f, i) => ({ ...f, action: i === 2 ? 'new' : 'change' })), removed: [], same: FILES.slice(3), failed: [],
      readOnlySet: a.readOnly && a.readOnly !== 'none' ? ['WindowsClient/GameUserSettings.ini'] : [], readOnlyCleared: [],
    };
  },
  'profiles.diff': (a) => ({
    id: a.id, kind: 'profile', name: findP(a.id).name,
    files: [
      { ...FILES[0], status: 'different', changes: [{ section: '/Script/FortniteGame.FortGameUserSettings', key: 'FrameRateLimit', current: '144.000000', saved: '240.000000' }, { section: 'ScalabilityGroups', key: 'sg.ShadowQuality', current: '2', saved: '0' }] },
      { ...FILES[1], status: 'different', changes: [] },
      { ...FILES[2], status: 'same', changes: [] },
    ],
  }),
  'profiles.export': () => ({ canceled: false, file: 'C:\\Users\\Spieler\\Documents\\Main.helixprofil' }),
  'profiles.import': () => ({ canceled: true }),
  'profiles.reorder': () => db.profiles.map(pub),
  'backups.list': () => db.backups,
  'backups.create': (a) => { const b = { id: `b-${Date.now()}`, createdAt: Date.now(), reason: 'manuell', label: a.label, pinned: false, fileCount: 5, bytes: 22812 }; db.backups.unshift(b); return b; },
  'backups.restore': async () => { await wait(500); return { ok: true, written: FILES.slice(0, 2), removed: [], same: [], failed: [] }; },
  'backups.remove': (a) => { db.backups = db.backups.filter((b) => b.id !== a.id); return { removed: true }; },
  'backups.pin': (a) => { const b = db.backups.find((x) => x.id === a.id); b.pinned = !!a.pinned; return b; },
  'backups.diff': (a) => CORE['profiles.diff']({ id: db.profiles[0].id, kind: 'backup' }),
  'app.info': () => ({ version: '1.0.0 (Vorschau)', dataDir: 'C:\\Users\\Spieler\\AppData\\Roaming\\HELIX', platform: 'win32' }),
  'app.settings': () => db.app,
  'app.setSettings': (a) => { Object.assign(db.app, a.patch); emit('app.settings', db.app); return db.app; },
  'app.openWindowsSettings': (a) => ({ opened: a.uri }),
  'app.openUrl': (a) => ({ opened: a.url }),
  'app.ready': () => ({ ok: true }),
};

const toolMocks = new Map();
async function toolMock(id) {
  if (!toolMocks.has(id)) {
    toolMocks.set(id, import(`./${id}.js`).then((m) => m.default || {}).catch(() => ({})));
  }
  return toolMocks.get(id);
}

export function createMock() {
  // ?running=1 in der Adresse simuliert ein laufendes Fortnite
  if (new URLSearchParams(location.search).has('running')) {
    db.fortnite = { running: true, gameRunning: true, processes: [{ name: 'FortniteClient-Win64-Shipping.exe', pid: 4242 }] };
  }
  return {
    platform: 'win32',
    async call(channel, args) {
      try {
        let fn = CORE[channel];
        if (!fn) {
          const mod = await toolMock(channel.split('.')[0]);
          const h = mod.handlers || mod;
          fn = h[channel.split('.')[1]];
          if (fn) {
            const ctx = { emit, wait, db };
            const data = await fn(args || {}, ctx);
            return { ok: true, data: data ?? null };
          }
          return { ok: false, error: { code: 'NO_CHANNEL', message: `Unbekannte Aktion: ${channel}` } };
        }
        return { ok: true, data: (await fn(args || {})) ?? null };
      } catch (e) {
        return { ok: false, error: { code: e.code || 'INTERNAL', message: e.message } };
      }
    },
    on(event, cb) {
      const l = (name, payload) => { if (name === event || event === '*') cb(payload, name); };
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
