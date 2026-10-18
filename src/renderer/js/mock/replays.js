// Simulator-Daten für den Replay-Tresor (nur Browser-Vorschau).

const now = Date.now();
const MIN = 60 * 1000;
const H = 60 * MIN;
const MB = 1024 * 1024;

function pad(n) { return String(n).padStart(2, '0'); }
function unsavedName(t) {
  const d = new Date(t);
  return `UnsavedReplay-${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}-${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.replay`;
}

function mk(ago, lengthMin, sizeMb, version, extra = {}) {
  const recordedAt = now - ago;
  const lengthMs = Math.round(lengthMin * MIN);
  return {
    file: unsavedName(recordedAt),
    friendlyName: 'Unsaved Replay',
    recordedAt,
    mtimeMs: recordedAt + lengthMs,
    lengthMs,
    size: Math.round(sizeMb * MB),
    version,
    ok: true,
    error: null,
    recording: false,
    incomplete: false,
    ...extra,
  };
}

const db = {
  vaultDir: null,
  demos: [
    mk(3 * MIN, 2.5, 1.4, '42.20', { recording: true, mtimeMs: now - 20 * 1000 }),
    mk(1.2 * H, 21.7, 11.8, '42.20'),
    mk(2.1 * H, 7.3, 4.2, '42.20'),
    mk(5 * H, 23.9, 13.1, '42.20'),
    mk(26 * H, 18.2, 9.9, '42.20', { friendlyName: 'Erster Sieg Season 2' }),
    mk(27 * H, 4.1, 2.6, '42.20', { incomplete: true }),
    mk(3 * 24 * H, 22.4, 12.2, '42.10'),
    mk(9 * 24 * H, 19.8, 10.7, '41.40'),
  ],
  vault: [],
};
db.vault = [
  { ...db.demos[4], file: 'Erster Sieg Season 2.replay' },
  { ...db.demos[6], file: 'Turnier Runde 3.replay' },
  { ...mk(30 * 24 * H, 24.6, 14.3, '41.20'), file: 'Clutch 1v3 Finale.replay' },
];

const DEFAULT_DIR = 'C:\\Users\\Spieler\\Documents\\HELIX Replays';
const DEMOS_DIR = 'C:\\Users\\Spieler\\AppData\\Local\\FortniteGame\\Saved\\Demos';

const key = (e) => `${e.recordedAt}|${e.lengthMs}|${e.size}`;
const err = (code, message) => { const e = new Error(message); e.code = code; throw e; };

function list() {
  const vk = new Set(db.vault.map(key));
  const dk = new Set(db.demos.map(key));
  const sort = (a, b) => b.recordedAt - a.recordedAt;
  return {
    newestVersion: '42.20',
    demos: { dir: DEMOS_DIR, found: true, entries: db.demos.slice().sort(sort).map((e) => ({ ...e, inVault: vk.has(key(e)) })) },
    vault: {
      dir: db.vaultDir || DEFAULT_DIR,
      isDefault: !db.vaultDir,
      exists: true,
      problem: null,
      entries: db.vault.slice().sort(sort).map((e) => ({ ...e, inDemos: dk.has(key(e)) })),
      bytes: db.vault.reduce((n, e) => n + e.size, 0),
    },
  };
}

function copy(e) {
  if (e.recording) err('RECORDING', 'Dieses Replay wird gerade aufgenommen. Warte, bis das Match vorbei ist.');
  const same = db.vault.find((x) => key(x) === key(e));
  if (same) return { already: true, file: same.file };
  db.vault.push({ ...e });
  return { already: false, file: e.file, size: e.size };
}

export default {
  async summary() {
    const n = db.vault.length;
    return n ? { text: n === 1 ? '1 Replay im Tresor' : `${n} Replays im Tresor` } : null;
  },
  async list(_a, mctx) {
    await mctx.wait(300);
    return list();
  },
  async copyToVault(a, mctx) {
    await mctx.wait(400);
    const e = db.demos.find((x) => x.file === a.file) || err('NOT_FOUND', 'Dieses Replay gibt es nicht mehr.');
    return copy(e);
  },
  async copyAllNew(_a, mctx) {
    await mctx.wait(700);
    let copied = 0; let already = 0; let recording = 0;
    for (const e of db.demos) {
      if (e.recording) { recording++; continue; }
      if (copy(e).already) already++; else copied++;
    }
    return { copied, already, recording, failed: 0, unreadable: 0 };
  },
  async restore(a, mctx) {
    await mctx.wait(400);
    if (mctx.db?.fortnite?.running) err('FORTNITE_RUNNING', 'Fortnite läuft noch. Schließe Fortnite zuerst – HELIX kann das für dich übernehmen.');
    const e = db.vault.find((x) => x.file === a.file) || err('NOT_FOUND', 'Diese Datei ist nicht mehr im Tresor.');
    if (db.demos.some((x) => key(x) === key(e))) return { already: true, file: e.file };
    db.demos.push({ ...e });
    return { already: false, file: e.file };
  },
  async rename(a) {
    const e = db.vault.find((x) => x.file === a.file) || err('NOT_FOUND', 'Diese Datei ist nicht mehr im Tresor.');
    const clean = String(a.name || '').replace(/[<>:"/\\|?*]/g, '').trim();
    if (!clean) err('BAD_NAME', 'Bitte gib einen Namen ein.');
    const file = `${clean}.replay`;
    if (db.vault.some((x) => x !== e && x.file.toLowerCase() === file.toLowerCase())) err('NAME_TAKEN', `Im Tresor gibt es schon „${clean}“. Bitte wähle einen anderen Namen.`);
    e.file = file;
    return { file };
  },
  async remove(a, mctx) {
    if (a.where === 'demos') {
      if (mctx.db?.fortnite?.running) err('FORTNITE_RUNNING', 'Fortnite läuft noch. Schließe Fortnite zuerst – HELIX kann das für dich übernehmen.');
      db.demos = db.demos.filter((x) => x.file !== a.file);
    } else {
      db.vault = db.vault.filter((x) => x.file !== a.file);
    }
    return { trashed: true, where: a.where, file: a.file };
  },
  async pickVault() {
    db.vaultDir = 'D:\\Fortnite Clips\\Replays';
    return { canceled: false, dir: db.vaultDir };
  },
  async resetVault() {
    db.vaultDir = null;
    return { dir: DEFAULT_DIR };
  },
  async openFolder(a) {
    return { opened: a.which };
  },
};
