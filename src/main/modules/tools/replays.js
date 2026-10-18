'use strict';
// Replay-Tresor: Fortnite behält nur die letzten ~100 ungespeicherten Replays.
// Dieses Tool kopiert die besten in einen eigenen Ordner (Tresor) und holt sie bei Bedarf zurück.
// Gelesen wird nur der Dateikopf (erste 64 KB) – nichts wird entschlüsselt oder verändert.
// Löschen = immer in den Windows-Papierkorb (shell.trashItem), nie endgültig.

const path = require('node:path');
const fsp = require('node:fs/promises');
const { HelixError } = require('../../sys/exec');
const logic = require('../../tools/replays-logic');

const ID = 'replays';
const STATE = 'tool-replays';
const DEFAULT_FOLDER = 'HELIX Replays';

async function readState(ctx) {
  const s = await ctx.core.readState(STATE, {});
  return { vaultDir: null, ...(s && typeof s === 'object' ? s : {}) };
}

function documentsDir(ctx) {
  try {
    const d = ctx.electron?.app?.getPath?.('documents');
    if (d) return d;
  } catch { /* weiter */ }
  if (ctx.env?.USERPROFILE) return path.join(ctx.env.USERPROFILE, 'Documents');
  return null;
}

function defaultVault(ctx) {
  const docs = documentsDir(ctx);
  return docs ? path.join(docs, DEFAULT_FOLDER) : null;
}

async function vaultInfo(ctx) {
  const st = await readState(ctx);
  const def = defaultVault(ctx);
  const dir = st.vaultDir || def;
  return { dir, isDefault: !st.vaultDir, defaultDir: def };
}

async function demosInfo(ctx) {
  let loc = null;
  try { loc = await ctx.core.requireLocation(); } catch { loc = null; }
  if (!loc || !loc.found || !loc.savedDir) return { dir: null, savedDir: null };
  return { dir: path.join(loc.savedDir, 'Demos'), savedDir: loc.savedDir };
}

async function requireVault(ctx) {
  const v = await vaultInfo(ctx);
  if (!v.dir) throw new HelixError('NO_VAULT', 'Es ist kein Tresor-Ordner eingestellt. Bitte wähle einen Ordner aus.');
  const { savedDir } = await demosInfo(ctx);
  const problem = logic.vaultProblem(v.dir, { savedDir });
  if (problem) throw new HelixError('BAD_VAULT', problem);
  return v.dir;
}

async function requireDemos(ctx) {
  const d = await demosInfo(ctx);
  if (!d.dir) throw new HelixError('NO_FORTNITE', 'Der Fortnite-Ordner wurde nicht gefunden. Starte Fortnite einmal oder wähle den Ordner unter „Settings-Profile“ aus.');
  return d.dir;
}

function pub(e) {
  return {
    file: e.file, size: e.size, mtimeMs: e.mtimeMs, lengthMs: e.lengthMs, friendlyName: e.friendlyName,
    recordedAt: e.recordedAt, version: e.version, recording: e.recording, incomplete: e.incomplete,
    ok: e.ok, error: e.error,
  };
}

async function buildList(ctx) {
  const vault = await vaultInfo(ctx);
  const demos = await demosInfo(ctx);
  const now = Date.now();
  const d = demos.dir ? await logic.listReplays(demos.dir, { now }).catch(() => ({ found: false, entries: [] })) : { found: false, entries: [] };
  const v = vault.dir ? await logic.listReplays(vault.dir, { now }).catch(() => ({ found: false, entries: [] })) : { found: false, entries: [] };
  const vaultKeys = new Set(v.entries.map(logic.replayKey));
  const demoKeys = new Set(d.entries.map(logic.replayKey));
  const versions = [...d.entries, ...v.entries].map((e) => e.version).filter(Boolean);
  const newestVersion = versions.sort(logic.compareVersions).pop() || null;
  return {
    newestVersion,
    demos: {
      dir: demos.dir,
      found: d.found,
      entries: d.entries.map((e) => ({ ...pub(e), inVault: vaultKeys.has(logic.replayKey(e)) })),
    },
    vault: {
      dir: vault.dir,
      isDefault: vault.isDefault,
      exists: v.found,
      problem: vault.dir ? logic.vaultProblem(vault.dir, { savedDir: demos.savedDir }) : null,
      entries: v.entries.map((e) => ({ ...pub(e), inDemos: demoKeys.has(logic.replayKey(e)) })),
      bytes: v.entries.reduce((n, e) => n + e.size, 0),
    },
  };
}

/** vaultKeys: Map key -> Dateiname im Tresor (wird bei mehreren Kopien wiederverwendet). */
async function vaultKeyMap(vaultDir) {
  const inVault = await logic.listReplays(vaultDir).catch(() => ({ entries: [] }));
  return new Map(inVault.entries.map((x) => [logic.replayKey(x), x.file]));
}

async function copyOneToVault(ctx, file, { demosDir, vaultDir, vaultKeys } = {}) {
  const name = logic.checkReplayFileName(file);
  demosDir ||= await requireDemos(ctx);
  vaultDir ||= await requireVault(ctx);
  const entry = await logic.readReplayEntry(demosDir, name).catch((e) => {
    if (e.code === 'ENOENT') throw new HelixError('NOT_FOUND', 'Dieses Replay gibt es nicht mehr. Fortnite hat es vielleicht schon gelöscht.');
    throw e;
  });
  if (!entry) throw new HelixError('NOT_FOUND', 'Dieses Replay gibt es nicht mehr.');
  if (entry.recording) throw new HelixError('RECORDING', 'Dieses Replay wird gerade aufgenommen. Warte, bis das Match vorbei ist.');
  vaultKeys ||= await vaultKeyMap(vaultDir);
  const key = logic.replayKey(entry);
  if (vaultKeys.has(key)) return { already: true, file: vaultKeys.get(key) };
  const saved = await logic.safeCopy(path.join(demosDir, name), vaultDir, name);
  vaultKeys.set(key, saved);
  return { already: false, file: saved, size: entry.size };
}

module.exports = {
  id: ID,
  handlers: {
    /** Alles für die Ansicht: Replays in Fortnite (Demos) und im Tresor. */
    async list(_a, ctx) {
      return buildList(ctx);
    },

    /** Kopiert ein Replay in den Tresor. Das Original bleibt in Fortnite. */
    async copyToVault(a, ctx) {
      const r = await copyOneToVault(ctx, a.file);
      if (!r.already) ctx.log?.('info', 'replays: in den Tresor kopiert');
      return r;
    },

    /** Kopiert alle Replays, die noch nicht im Tresor sind (laufende Aufnahmen werden übersprungen). */
    async copyAllNew(_a, ctx) {
      const demosDir = await requireDemos(ctx);
      const vaultDir = await requireVault(ctx);
      const list = await logic.listReplays(demosDir);
      const vaultKeys = await vaultKeyMap(vaultDir);
      let copied = 0; let already = 0; let recording = 0; let failed = 0; let unreadable = 0;
      for (const e of list.entries) {
        if (e.recording) { recording++; continue; }
        if (!e.ok) { unreadable++; continue; } // nicht lesbare Dateien nur einzeln auf Wunsch
        try {
          const r = await copyOneToVault(ctx, e.file, { demosDir, vaultDir, vaultKeys });
          if (r.already) already++; else copied++;
        } catch (err) {
          if (err.code === 'NO_SPACE') throw err;
          failed++;
        }
      }
      return { copied, already, recording, failed, unreadable };
    },

    /** Holt eine Kopie aus dem Tresor zurück in den Fortnite-Ordner. Fortnite muss geschlossen sein. */
    async restore(a, ctx) {
      const name = logic.checkReplayFileName(a.file);
      const vaultDir = await requireVault(ctx);
      const demosDir = await requireDemos(ctx);
      await ctx.core.ensureFortniteClosed();
      const entry = await logic.readReplayEntry(vaultDir, name).catch(() => null);
      if (!entry) throw new HelixError('NOT_FOUND', 'Diese Datei ist nicht mehr im Tresor.');
      const inDemos = await logic.listReplays(demosDir).catch(() => ({ entries: [] }));
      const same = inDemos.entries.find((x) => logic.replayKey(x) === logic.replayKey(entry));
      if (same) return { already: true, file: same.file };
      const saved = await logic.safeCopy(path.join(vaultDir, name), demosDir, name);
      return { already: false, file: saved };
    },

    /** Benennt eine Kopie im Tresor um (nur der Dateiname, der Inhalt bleibt unverändert). */
    async rename(a, ctx) {
      const name = logic.checkReplayFileName(a.file);
      const clean = logic.cleanReplayName(a.name);
      const vaultDir = await requireVault(ctx);
      const target = `${clean}.replay`;
      if (target === name) return { file: name };
      const src = path.join(vaultDir, name);
      const st = await fsp.lstat(src).catch(() => null);
      if (!st || !st.isFile()) throw new HelixError('NOT_FOUND', 'Diese Datei ist nicht mehr im Tresor.');
      const dest = path.join(vaultDir, target);
      const exists = await fsp.lstat(dest).then(() => true, () => false);
      if (exists && target.toLowerCase() !== name.toLowerCase()) {
        throw new HelixError('NAME_TAKEN', `Im Tresor gibt es schon „${clean}“. Bitte wähle einen anderen Namen.`);
      }
      await fsp.rename(src, dest);
      return { file: target };
    },

    /** Verschiebt ein Replay in den Windows-Papierkorb (aus dem Tresor oder aus Fortnite). */
    async remove(a, ctx) {
      const name = logic.checkReplayFileName(a.file);
      const where = a.where === 'demos' ? 'demos' : 'vault';
      let dir;
      if (where === 'demos') {
        dir = await requireDemos(ctx);
        await ctx.core.ensureFortniteClosed();
      } else {
        dir = await requireVault(ctx);
      }
      const abs = path.join(dir, name);
      const st = await fsp.lstat(abs).catch(() => null);
      if (!st || !st.isFile()) throw new HelixError('NOT_FOUND', 'Diese Datei gibt es nicht mehr.');
      if (where === 'demos') {
        const e = await logic.readReplayEntry(dir, name).catch(() => null);
        if (e?.recording) throw new HelixError('RECORDING', 'Dieses Replay wird gerade aufgenommen.');
      }
      try {
        await ctx.electron.shell.trashItem(abs);
      } catch (e) {
        throw new HelixError('TRASH_FAILED', 'Die Datei konnte nicht in den Papierkorb verschoben werden. Sie wurde nicht gelöscht.');
      }
      return { trashed: true, where, file: name };
    },

    /** Neuen Tresor-Ordner wählen. Vorhandene Kopien bleiben im alten Ordner. */
    async pickVault(_a, ctx) {
      const v = await vaultInfo(ctx);
      const r = await ctx.electron.dialog.showOpenDialog(ctx.electron.getWindow(), {
        title: 'Ordner für den Replay-Tresor wählen',
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
        defaultPath: v.dir || v.defaultDir || undefined,
      });
      if (r.canceled || !r.filePaths?.[0]) return { canceled: true };
      const dir = path.resolve(r.filePaths[0]);
      const { savedDir } = await demosInfo(ctx);
      const problem = logic.vaultProblem(dir, { savedDir });
      if (problem) throw new HelixError('BAD_VAULT', problem);
      await fsp.mkdir(dir, { recursive: true });
      const st = await readState(ctx);
      st.vaultDir = v.defaultDir && dir.toLowerCase() === v.defaultDir.toLowerCase() ? null : dir;
      await ctx.core.writeState(STATE, st);
      return { canceled: false, dir };
    },

    /** Zurück zum Standardordner (Dokumente\HELIX Replays). */
    async resetVault(_a, ctx) {
      const st = await readState(ctx);
      st.vaultDir = null;
      await ctx.core.writeState(STATE, st);
      return { dir: defaultVault(ctx) };
    },

    /** Öffnet den Tresor oder den Fortnite-Replay-Ordner im Explorer. */
    async openFolder(a, ctx) {
      let dir;
      if (a.which === 'demos') {
        dir = await requireDemos(ctx);
      } else {
        dir = await requireVault(ctx);
        await fsp.mkdir(dir, { recursive: true });
      }
      const err = await ctx.electron.shell.openPath(dir);
      if (err) throw new HelixError('OPEN_FAILED', `Ordner konnte nicht geöffnet werden: ${err}`);
      return { opened: dir };
    },

    async summary(_a, ctx) {
      const v = await vaultInfo(ctx);
      if (!v.dir) return null;
      let count = 0;
      try {
        const ents = await fsp.readdir(v.dir, { withFileTypes: true });
        count = ents.filter((e) => !e.isDirectory() && /\.replay$/i.test(e.name)).length;
      } catch { return null; }
      const text = logic.summaryText(count);
      return text ? { text } : null;
    },
  },
  _test: { defaultVault, vaultInfo },
};
