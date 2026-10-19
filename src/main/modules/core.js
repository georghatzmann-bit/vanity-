'use strict';
// Schnittstelle der Hauptfunktion (Profile, Backups, Fortnite-Status) für die Oberfläche.

const path = require('node:path');
const { HelixError } = require('../sys/exec');
const { safeJoin } = require('../core/fsutil');

const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new HelixError('BAD_ARG', `Angabe fehlt: ${name}`);
  return v;
};

function publicScan(sc) {
  return {
    configDir: sc.configDir,
    savedDir: sc.savedDir,
    scannedAt: sc.scannedAt,
    totals: sc.totals,
    errors: sc.errors,
    files: sc.files.map((f) => ({
      root: f.root, rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, readOnly: f.readOnly, kind: f.kind,
      label: f.label, included: f.included, reason: f.reason, protectedParts: f.sensitive ? (f.sensitive.sections.length + f.sensitive.keys.length) : 0,
    })),
  };
}

const coreModule = {
  id: 'core',
  async init(ctx) {
    await ctx.core.init();
    ctx.core.startWatching();
    ctx.sessions.init().then(() => ctx.sessions.start()).catch(() => {});
    setTimeout(() => ctx.core.checkDrift(true).catch(() => {}), 3000);
  },
  dispose(ctx) {
    ctx.sessions.stop();
    ctx.core.dispose();
  },
  handlers: {
    status: (_a, ctx) => ctx.core.status(),
    locate: async (_a, ctx) => {
      await ctx.core.locate();
      ctx.core.startWatching();
      return ctx.core.status();
    },
    scan: async (_a, ctx) => publicScan(await ctx.core.scanNow()),
    pickFolder: async (_a, ctx) => {
      const r = await ctx.electron.dialog.showOpenDialog(ctx.electron.getWindow(), {
        title: 'Fortnite-Ordner „Saved“ oder „Config“ auswählen',
        properties: ['openDirectory'],
        defaultPath: ctx.env.LOCALAPPDATA || undefined,
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      const loc = await ctx.core.setOverride(r.filePaths[0]);
      if (!loc.found) {
        await ctx.core.setOverride(null);
        throw new HelixError('BAD_FOLDER', 'In diesem Ordner wurden keine Fortnite-Einstellungen gefunden. Wähle den Ordner „FortniteGame\\Saved“ oder „FortniteGame\\Saved\\Config“.');
      }
      return { canceled: false, location: loc };
    },
    resetFolder: async (_a, ctx) => ctx.core.setOverride(null),
    fortniteStatus: (_a, ctx) => ctx.core.fortniteStatus(),
    fortniteClose: (a, ctx) => ctx.core.closeFortnite({ force: !!a.force }),
    driftCheck: (_a, ctx) => ctx.core.checkDrift(false),
    driftAck: (_a, ctx) => ctx.core.acknowledgeDrift(),
    readOnlyClearAll: (_a, ctx) => ctx.core.clearAllReadOnly(),
    readOnlySet: (a, ctx) => ctx.core.setFileReadOnly(a.root === 'saved' ? 'saved' : 'config', str(a.rel, 'rel'), !!a.on),
    openFolder: async (a, ctx) => {
      const loc = ctx.core.location || {};
      const map = {
        config: loc.configDir,
        saved: loc.savedDir,
        data: ctx.dataDir,
        backups: path.join(ctx.dataDir, 'backups'),
        profiles: path.join(ctx.dataDir, 'profiles'),
      };
      const dir = map[a.which];
      if (!dir) throw new HelixError('BAD_ARG', 'Unbekannter Ordner.');
      const err = await ctx.electron.shell.openPath(dir);
      if (err) throw new HelixError('OPEN_FAILED', `Ordner konnte nicht geöffnet werden: ${err}`);
      return { opened: dir };
    },
    showFile: async (a, ctx) => {
      const loc = await ctx.core.requireLocation();
      const p = safeJoin(a.root === 'saved' ? loc.savedDir : loc.configDir, str(a.rel, 'rel'));
      ctx.electron.shell.showItemInFolder(p);
      return { shown: p };
    },
    sessions: (a, ctx) => ctx.sessions.summary({ days: Math.min(90, Math.max(7, Number(a.days) || 30)) }),
  },
};

const profilesModule = {
  id: 'profiles',
  handlers: {
    list: (_a, ctx) => ctx.core.listProfiles(),
    get: (a, ctx) => ctx.core.getProfile(str(a.id, 'id')),
    create: (a, ctx) => ctx.core.createProfile({ name: a.name, notes: a.notes || '' }),
    update: (a, ctx) => ctx.core.updateProfile(str(a.id, 'id')),
    rename: (a, ctx) => ctx.core.renameProfile(str(a.id, 'id'), a.name),
    notes: (a, ctx) => ctx.core.setProfileNotes(str(a.id, 'id'), a.notes),
    duplicate: (a, ctx) => ctx.core.duplicateProfile(str(a.id, 'id'), a.name),
    remove: (a, ctx) => ctx.core.removeProfile(str(a.id, 'id')),
    options: (a, ctx) => ctx.core.setProfileOptions(str(a.id, 'id'), a.options || {}),
    reorder: (a, ctx) => ctx.core.reorderProfiles(Array.isArray(a.ids) ? a.ids.filter((x) => typeof x === 'string') : []),
    preview: (a, ctx) => ctx.core.previewProfile(str(a.id, 'id'), { removeExtra: a.removeExtra }),
    apply: (a, ctx) => ctx.core.applyProfile(str(a.id, 'id'), { readOnly: a.readOnly, removeExtra: a.removeExtra }),
    diff: (a, ctx) => ctx.core.diff('profile', str(a.id, 'id')),
    controls: (a, ctx) => ctx.core.controls(str(a.id, 'id')),
    export: async (a, ctx) => {
      const p = await ctx.core.getProfile(str(a.id, 'id'));
      const safe = p.name.replace(/[^\w\- äöüÄÖÜß()]/g, '_');
      const r = await ctx.electron.dialog.showSaveDialog(ctx.electron.getWindow(), {
        title: `Profil „${p.name}“ exportieren`,
        defaultPath: path.join(ctx.electron.app.getPath('documents'), `${safe}.helixprofil`),
        filters: [{ name: 'HELIX-Profil', extensions: ['helixprofil'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      return { canceled: false, ...(await ctx.core.exportProfile(p.id, r.filePath)) };
    },
    import: async (_a, ctx) => {
      const r = await ctx.electron.dialog.showOpenDialog(ctx.electron.getWindow(), {
        title: 'HELIX-Profil importieren',
        properties: ['openFile'],
        filters: [{ name: 'HELIX-Profil', extensions: ['helixprofil', 'zip'] }],
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      return { canceled: false, ...(await ctx.core.importProfile(r.filePaths[0])) };
    },
  },
};

const backupsModule = {
  id: 'backups',
  handlers: {
    list: (_a, ctx) => ctx.core.listBackups(),
    create: (a, ctx) => ctx.core.createBackup('manuell', String(a.label || 'Manuelle Sicherung').slice(0, 80)),
    restore: (a, ctx) => ctx.core.restoreBackup(str(a.id, 'id')),
    remove: (a, ctx) => ctx.core.removeBackup(str(a.id, 'id')),
    pin: (a, ctx) => ctx.core.pinBackup(str(a.id, 'id'), !!a.pinned),
    diff: (a, ctx) => ctx.core.diff('backup', str(a.id, 'id')),
  },
};

module.exports = [coreModule, profilesModule, backupsModule];
