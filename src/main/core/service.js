'use strict';
// Kern von HELIX: Settings-Profile.
// Verbindet Suche, Scan, Profile, Backups, Anwenden, Schreibschutz und den Cloud-Wächter.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const ini = require('./ini');
const { locateFortnite } = require('./locator');
const { scan } = require('./scanner');
const engine = require('./engine');
const { SnapshotStore } = require('./snapshots');
const archive = require('./archive');
const fortnite = require('./fortnite');
const { summarizeGameUserSettings } = require('./summary');
const { watchedValues, diffValues } = require('./drift');
const { sanitizeIniText } = require('./sensitive');
const {
  readJson, writeJson, sha256, safeJoin, normRel, exists, isReadOnly, setReadOnly, writeFileSafe, walk,
} = require('./fsutil');
const { HelixError } = require('../sys/exec');

const MAX_BACKUPS = 40;
const NAME_MAX = 40;

function cleanName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!n) throw new HelixError('BAD_NAME', 'Bitte gib einen Namen ein.');
  if (n.length > NAME_MAX) throw new HelixError('BAD_NAME', `Der Name darf höchstens ${NAME_MAX} Zeichen haben.`);
  return n;
}

/** Fingerabdruck einer Abweichung: was sich geändert hat (nicht wann). */
function driftSignature(changed) {
  return changed.map((c) => {
    if (c.missing) return `${c.rel}:fehlt`;
    if (c.settings && c.settings.length) return `${c.rel}:${c.settings.map((x) => `${x.section}|${x.key}=${x.to}`).sort().join(',')}`;
    return `${c.rel}:${c.sha256 || ''}`;
  }).sort().join('|');
}

function publicProfile(meta, activeId) {
  return {
    id: meta.id,
    name: meta.name,
    notes: meta.notes || '',
    color: meta.color,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    importedAt: meta.importedAt || null,
    fileCount: meta.files.length,
    bytes: meta.files.reduce((n, f) => n + (f.size || 0), 0),
    kinds: [...new Set(meta.files.map((f) => f.kind))],
    files: meta.files.map((f) => ({ root: f.root, rel: f.rel, size: f.size, kind: f.kind, label: f.label, sanitized: !!f.sanitized })),
    summary: meta.summary || null,
    options: meta.options || { readOnly: 'none', removeExtra: true },
    stats: meta.stats || { appliedCount: 0, lastAppliedAt: null },
    active: meta.id === activeId,
  };
}

function publicBackup(meta) {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    reason: meta.reason,
    label: meta.label,
    pinned: !!meta.pinned,
    profileId: meta.profileId || null,
    fileCount: meta.files.length,
    bytes: meta.files.reduce((n, f) => n + (f.size || 0), 0),
    files: meta.files.map((f) => ({ root: f.root, rel: f.rel, size: f.size, kind: f.kind, label: f.label })),
  };
}

class CoreService {
  /**
   * @param {object} o
   * @param {string} o.dataDir   HELIX-Datenordner (Profile, Backups, Zustand)
   * @param {object} [o.env]     Umgebungsvariablen (für Tests austauschbar)
   * @param {Function} [o.exec]  Programmstarter (für Tests austauschbar)
   * @param {Function} [o.emit]  Ereignisse an die Oberfläche senden
   */
  constructor({ dataDir, env = process.env, exec, emit = () => {} }) {
    this.dataDir = dataDir;
    this.env = env;
    this.exec = exec;
    this.emit = emit;
    this.profiles = new SnapshotStore(path.join(dataDir, 'profiles'), 'profile');
    this.backups = new SnapshotStore(path.join(dataDir, 'backups'), 'backup');
    this.trashDir = path.join(dataDir, 'papierkorb');
    this.stateDir = path.join(dataDir, 'state');
    this.location = null;
    this.fortniteState = { running: false, gameRunning: false, processes: [], checkedAt: 0 };
    this.lastDrift = null;
    this.ownWriteUntil = 0;
    this.watcher = null;
    this.timers = [];
    this.busy = false;
    this.fortniteListeners = [];
  }

  // ---------- Zustand ----------

  statePath(name) { return path.join(this.stateDir, `${name}.json`); }
  readState(name, fallback) { return readJson(this.statePath(name), fallback); }
  writeState(name, obj) { return writeJson(this.statePath(name), obj); }

  async settings() {
    return { fortniteOverride: null, ...(await this.readState('settings', {})) };
  }

  async init() {
    await fsp.mkdir(this.stateDir, { recursive: true });
    await this.profiles.cleanup();
    await this.backups.cleanup();
    await this.locate();
    await this.purgeTrash();
  }

  /**
   * Sichert den Originalzustand eines Fortnite-Ordners, bevor HELIX dort zum ersten Mal etwas ändert
   * (angeheftet, wird nie automatisch gelöscht). Merkt sich das pro Ordner.
   */
  async ensureOriginalBackup() {
    if (!this.location?.found) return null;
    const key = String(this.location.configDir).toLowerCase();
    const state = await this.readState('first-run', {});
    const done = state.folders || {};
    if (state.backupId && !Object.keys(done).length && state.configDir === undefined) {
      // älteres Format (ein Eintrag ohne Ordner): gilt für den damals gefundenen Ordner
      done[key] = { at: state.at, backupId: state.backupId };
    }
    if (done[key]) return done[key];
    try {
      const sc = await scan({ configDir: this.location.configDir, savedDir: this.location.savedDir });
      const b = await this.backupFromScan(sc, 'original', 'Originalzustand vor der ersten Änderung durch HELIX', { pinned: true });
      done[key] = { at: Date.now(), backupId: b.id };
      await this.writeState('first-run', { folders: done });
      return done[key];
    } catch { return null; }
  }

  async locate() {
    const s = await this.settings();
    this.location = await locateFortnite({ env: this.env, override: s.fortniteOverride });
    if (this.location.found) await this.ensureOriginalBackup();
    return this.location;
  }

  async requireLocation() {
    if (!this.location?.found) await this.locate();
    if (!this.location?.found) {
      throw new HelixError('NO_FORTNITE', 'Der Fortnite-Einstellungsordner wurde nicht gefunden. Starte Fortnite einmal oder wähle den Ordner von Hand aus.');
    }
    return this.location;
  }

  roots() {
    const l = this.location;
    return { config: l.configDir, saved: l.savedDir };
  }

  async scanNow() {
    const loc = await this.requireLocation();
    return scan({ configDir: loc.configDir, savedDir: loc.savedDir });
  }

  async withLock(fn) {
    if (this.busy) throw new HelixError('BUSY', 'HELIX ist gerade mit einer anderen Aktion beschäftigt. Bitte kurz warten.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  // ---------- Fortnite ----------

  async fortniteStatus() {
    try {
      const st = await fortnite.status(this.exec);
      const was = this.fortniteState.running;
      const since = st.running ? (was ? this.fortniteState.since : Date.now()) : null;
      this.fortniteState = { ...st, since, checkedAt: Date.now() };
      if (was !== st.running) {
        for (const l of this.fortniteListeners) { try { l(st.running, st); } catch { /* egal */ } }
        this.emit('fortnite.state', this.fortniteState);
        if (was && !st.running) setTimeout(() => this.checkDrift(true).catch(() => {}), 1500);
      }
      return this.fortniteState;
    } catch (e) {
      if (e.code === 'NOT_WINDOWS') return { running: false, gameRunning: false, processes: [], unsupported: true };
      throw e;
    }
  }

  onFortniteState(cb) { this.fortniteListeners.push(cb); }

  async ensureFortniteClosed() {
    const st = await this.fortniteStatus();
    if (st.running) {
      throw new HelixError('FORTNITE_RUNNING', 'Fortnite läuft noch. Schließe Fortnite zuerst – HELIX kann das für dich übernehmen.', { processes: st.processes });
    }
  }

  async closeFortnite({ force = false } = {}) {
    const r = await fortnite.close({ force }, this.exec);
    await this.fortniteStatus();
    return r;
  }

  // ---------- Profile ----------

  async activeProfileId() {
    const a = await this.readState('applied', null);
    return a?.profileId || null;
  }

  async listProfiles() {
    const active = await this.activeProfileId();
    const list = await this.profiles.list();
    list.sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
    return list.map((m) => publicProfile(m, active));
  }

  async getProfile(id) {
    return publicProfile(await this.profiles.get(id), await this.activeProfileId());
  }

  async uniqueName(name, exceptId) {
    const list = await this.profiles.list();
    const taken = (n) => list.some((p) => p.id !== exceptId && p.name.toLowerCase() === n.toLowerCase());
    if (!taken(name)) return name;
    for (let i = 2; i < 100; i++) {
      const cand = `${name.slice(0, NAME_MAX - 5)} (${i})`;
      if (!taken(cand)) return cand;
    }
    return `${name.slice(0, 30)} ${Date.now()}`;
  }

  async assertNameFree(name, exceptId) {
    const list = await this.profiles.list();
    if (list.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
      throw new HelixError('NAME_TAKEN', `Es gibt schon ein Profil mit dem Namen „${name}“.`);
    }
  }

  async summaryFor(dir, files) {
    const gus = files.find((f) => f.kind === 'video');
    if (!gus) return null;
    try {
      const buf = await engine.readStored(dir, gus);
      return summarizeGameUserSettings(ini.decode(buf).text);
    } catch { return null; }
  }

  /** Speichert die aktuellen Fortnite-Einstellungen als neues Profil. */
  async createProfile({ name, notes = '', color } = {}) {
    return this.withLock(async () => {
      const clean = cleanName(name);
      await this.assertNameFree(clean);
      const sc = await this.scanNow();
      if (!sc.totals.included) throw new HelixError('NOTHING_FOUND', 'Im Fortnite-Ordner wurden keine Einstellungsdateien gefunden.');
      const count = (await this.profiles.list()).length;
      const meta = await this.profiles.createFromScan(sc, {
        name: clean,
        notes: String(notes).slice(0, 500),
        color: Number.isFinite(color) ? color : (count * 47 + 190) % 360,
        order: Date.now(),
        options: { readOnly: 'none', removeExtra: true },
        stats: { appliedCount: 0, lastAppliedAt: null },
      });
      meta.summary = await this.summaryFor(this.profiles.dir(meta.id), meta.files);
      await this.profiles.saveMeta(meta);
      return publicProfile(meta, await this.activeProfileId());
    });
  }

  /** Überschreibt ein Profil mit den aktuellen Einstellungen (Name, Optionen, Statistik bleiben). */
  async updateProfile(id) {
    return this.withLock(async () => {
      const old = await this.profiles.get(id);
      const sc = await this.scanNow();
      if (!sc.totals.included) throw new HelixError('NOTHING_FOUND', 'Im Fortnite-Ordner wurden keine Einstellungsdateien gefunden.');
      const keep = { ...old };
      delete keep.files;
      delete keep.source;
      const meta = await this.profiles.createFromScan(sc, keep);
      meta.summary = await this.summaryFor(this.profiles.dir(id), meta.files);
      await this.profiles.saveMeta(meta);
      // Wenn das Profil gerade aktiv ist: aktueller Stand ist jetzt der erwartete Stand
      const applied = await this.readState('applied', null);
      if (applied?.profileId === id) await this.recordApplied(meta, sc);
      return publicProfile(meta, await this.activeProfileId());
    });
  }

  async renameProfile(id, name) {
    return this.withLock(async () => {
      const clean = cleanName(name);
      await this.assertNameFree(clean, id);
      const meta = await this.profiles.get(id);
      meta.name = clean;
      await this.profiles.saveMeta(meta);
      const applied = await this.readState('applied', null);
      if (applied?.profileId === id) await this.writeState('applied', { ...applied, profileName: clean });
      return publicProfile(meta, await this.activeProfileId());
    });
  }

  async setProfileNotes(id, notes) {
    return this.withLock(async () => {
      const meta = await this.profiles.get(id);
      meta.notes = String(notes ?? '').slice(0, 500);
      await this.profiles.saveMeta(meta);
      return publicProfile(meta, await this.activeProfileId());
    });
  }

  async duplicateProfile(id, name) {
    return this.withLock(async () => {
      const src = await this.profiles.get(id);
      const clean = name ? cleanName(name) : await this.uniqueName(`${src.name} Kopie`.slice(0, NAME_MAX));
      await this.assertNameFree(clean);
      const copy = await this.profiles.duplicate(id, {
        name: clean, order: Date.now(), stats: { appliedCount: 0, lastAppliedAt: null }, color: ((src.color ?? 200) + 40) % 360,
      });
      return publicProfile(copy, await this.activeProfileId());
    });
  }

  async removeProfile(id) {
    return this.withLock(async () => {
      await this.profiles.get(id); // existiert?
      await this.profiles.remove(id, this.trashDir);
      const applied = await this.readState('applied', null);
      if (applied?.profileId === id) await this.writeState('applied', { ...applied, profileId: null, removed: true });
      return { removed: true };
    });
  }

  async setProfileOptions(id, options = {}) {
    return this.withLock(async () => {
      const meta = await this.profiles.get(id);
      const cur = meta.options || { readOnly: 'none', removeExtra: true };
      const next = { ...cur };
      if ('readOnly' in options) {
        const ro = options.readOnly;
        if (ro === 'none' || ro === 'all') next.readOnly = ro;
        else if (Array.isArray(ro)) next.readOnly = ro.filter((k) => typeof k === 'string').slice(0, 20);
        else throw new HelixError('BAD_OPTION', 'Ungültige Schreibschutz-Einstellung.');
      }
      if ('removeExtra' in options) next.removeExtra = !!options.removeExtra;
      meta.options = next;
      await this.profiles.saveMeta(meta);
      return publicProfile(meta, await this.activeProfileId());
    });
  }

  async reorderProfiles(ids) {
    return this.withLock(async () => {
      const list = await this.profiles.list();
      let i = 0;
      for (const id of ids) {
        const meta = list.find((m) => m.id === id);
        if (!meta) continue;
        meta.order = ++i;
        await this.profiles.saveMeta(meta);
      }
      return this.listProfiles();
    });
  }

  // ---------- Vorschau & Anwenden ----------

  async previewProfile(id, { removeExtra } = {}) {
    const meta = await this.profiles.get(id);
    const loc = await this.requireLocation();
    const sc = await scan({ configDir: loc.configDir, savedDir: loc.savedDir });
    const rm = removeExtra ?? meta.options?.removeExtra ?? true;
    const p = await engine.plan(this.profiles.dir(id), meta, this.roots(), sc, { removeExtra: rm });
    return {
      profile: publicProfile(meta, await this.activeProfileId()),
      counts: p.counts,
      items: p.items.map((i) => ({ root: i.root, rel: i.rel, label: i.label, kind: i.kind, action: i.action, size: i.size })),
      fortnite: await this.fortniteStatus(),
      target: { configDir: loc.configDir, savedDir: loc.savedDir },
    };
  }

  /**
   * Wendet ein Profil an: Fortnite-Check -> Backup -> Schreiben -> Prüfen -> Schreibschutz.
   * Bei einem Fehler wird automatisch das Backup zurückgespielt.
   */
  async applyProfile(id, { readOnly, removeExtra } = {}) {
    return this.withLock(async () => {
      const meta = await this.profiles.get(id);
      await this.requireLocation();
      await this.ensureFortniteClosed();
      const opts = meta.options || {};
      const ro = readOnly ?? opts.readOnly ?? 'none';
      const rm = removeExtra ?? opts.removeExtra ?? true;
      const sc = await this.scanNow();
      await this.ensureOriginalBackup();
      const backup = await this.backupFromScan(sc, 'vor-anwenden', `Vor dem Anwenden von „${meta.name}“`, { profileId: id });
      this.ownWriteUntil = Date.now() + 4000;
      const res = await engine.apply(this.profiles.dir(id), meta, this.roots(), sc, { removeExtra: rm, readOnly: ro });
      if (!res.ok) {
        const rollback = await this.rollback(backup.id);
        return { ok: false, profile: publicProfile(meta, await this.activeProfileId()), backupId: backup.id, ...res, rollback };
      }
      meta.stats = { appliedCount: (meta.stats?.appliedCount || 0) + 1, lastAppliedAt: Date.now() };
      await this.profiles.saveMeta(meta);
      const after = await this.scanNow();
      await this.recordApplied(meta, after);
      this.lastDrift = null;
      this.emit('profiles.applied', { profileId: id, name: meta.name });
      await this.pruneBackups();
      return {
        ok: true,
        profile: publicProfile(meta, id),
        backupId: backup.id,
        ...res,
        readOnlyMode: ro,
      };
    });
  }

  /** Spielt nach einem Fehler das gerade erstellte Backup zurück. */
  async rollback(backupId) {
    try {
      const meta = await this.backups.get(backupId);
      const sc = await this.scanNow();
      const r = await engine.apply(this.backups.dir(backupId), meta, this.roots(), sc, { removeExtra: true, restoreReadOnly: true });
      return { ok: r.ok, failed: r.failed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Merkt sich, welcher Stand nach dem Anwenden erwartet wird (für den Cloud-Wächter). */
  async recordApplied(meta, sc) {
    const files = [];
    for (const original of meta.files) {
      const rel = original.root === 'saved' ? (engine.resolveAccount(original.rel, sc) || original.rel) : original.rel;
      const f = { ...original, rel };
      const cur = sc.files.find((x) => engine.keyOf(x.root, x.rel) === engine.keyOf(f.root, f.rel));
      let values = null;
      if (cur?.abs) {
        try { values = watchedValues(f.rel, await fsp.readFile(cur.abs)); } catch { /* gesperrt */ }
      }
      files.push({ root: f.root, rel: f.rel, label: f.label, kind: f.kind, sha256: cur?.sha256 || null, readOnly: !!cur?.readOnly, values });
    }
    await this.writeState('applied', {
      profileId: meta.id, profileName: meta.name, appliedAt: Date.now(), files, acknowledged: null,
    });
  }

  // ---------- Cloud-Wächter ----------

  /**
   * Vergleicht die aktuellen Dateien mit dem Stand direkt nach dem Anwenden.
   * Rückgabe: { status: 'none'|'ok'|'drift', changed: [...], ... }
   */
  async checkDrift(notify = false) {
    const applied = await this.readState('applied', null);
    if (!applied || !applied.profileId || !this.location?.found) return { status: 'none' };
    const changed = [];
    for (const f of applied.files) {
      let p;
      try { p = safeJoin(this.roots()[f.root], f.rel); } catch { continue; }
      let buf = null;
      let mtimeMs = null;
      try {
        buf = await fsp.readFile(p);
        mtimeMs = Math.round((await fsp.stat(p)).mtimeMs);
      } catch { /* fehlt oder gesperrt */ }
      if (!buf) {
        if (f.sha256) changed.push({ rel: f.rel, label: f.label, kind: f.kind, missing: true, mtimeMs: null, settings: [] });
        continue;
      }
      if (f.values) {
        // INI: nur echte Einstellungen vergleichen (Fortnite schreibt beim Beenden Zeitstempel u. Ä. neu)
        let settings;
        try { settings = diffValues(f.values, watchedValues(f.rel, buf)); } catch { settings = []; }
        if (settings.length) changed.push({ rel: f.rel, label: f.label, kind: f.kind, missing: false, mtimeMs, settings: settings.slice(0, 20) });
      } else if (sha256(buf) !== f.sha256) {
        changed.push({ rel: f.rel, label: f.label, kind: f.kind, missing: false, mtimeMs, settings: [], sha256: sha256(buf) });
      }
    }
    const sessions = await this.readState('sessions', { list: [] });
    const since = (sessions.list || []).filter((s) => s.start > applied.appliedAt);
    const ranSince = since.length > 0 || (this.fortniteState.running && this.fortniteState.checkedAt > applied.appliedAt);
    let likelyCloud = false;
    if (changed.length && ranSince) {
      const starts = since.map((s) => s.start);
      if (this.fortniteState.running && this.fortniteState.since) starts.push(this.fortniteState.since);
      likelyCloud = changed.some((c) => c.mtimeMs && starts.some((s) => c.mtimeMs >= s && c.mtimeMs - s < 5 * 60 * 1000));
    }
    const ack = applied.acknowledged;
    const sig = driftSignature(changed);
    const result = {
      status: changed.length ? 'drift' : 'ok',
      profileId: applied.profileId,
      profileName: applied.profileName,
      appliedAt: applied.appliedAt,
      changed,
      fortniteRanSinceApply: ranSince,
      likelyCloud,
      acknowledged: !!ack && ack === sig,
    };
    if (notify && result.status === 'drift' && !result.acknowledged) {
      const key = `${result.profileId}|${sig}`;
      if (this.lastDrift !== key) {
        this.lastDrift = key;
        this.emit('drift', result);
      }
    }
    return result;
  }

  async acknowledgeDrift() {
    const applied = await this.readState('applied', null);
    if (!applied) return { ok: true };
    const d = await this.checkDrift(false);
    applied.acknowledged = driftSignature(d.changed || []);
    await this.writeState('applied', applied);
    return { ok: true };
  }

  startWatching() {
    this.stopWatching();
    const loc = this.location;
    if (loc?.found) {
      try {
        let t = null;
        this.watcher = fs.watch(loc.configDir, { recursive: true }, () => {
          if (Date.now() < this.ownWriteUntil) return;
          clearTimeout(t);
          t = setTimeout(() => this.checkDrift(true).catch(() => {}), 1500);
        });
        this.watcher.on('error', () => {});
      } catch { /* ohne Live-Überwachung weiter, die Zeitprüfung reicht */ }
    }
    this.timers.push(setInterval(() => this.checkDrift(true).catch(() => {}), 60000));
  }

  stopWatching() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* egal */ } }
    this.watcher = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ---------- Backups ----------

  async backupFromScan(sc, reason, label, extra = {}) {
    const meta = await this.backups.createFromScan(sc, { reason, label, pinned: false, ...extra }, { allAccounts: true });
    return publicBackup(meta);
  }

  async createBackup(reason = 'manuell', label = 'Manuelle Sicherung', extra = {}) {
    const sc = await this.scanNow();
    const b = await this.backupFromScan(sc, reason, label, extra);
    await this.pruneBackups();
    return b;
  }

  async listBackups() {
    const list = await this.backups.list();
    // neueste zuerst; bei gleicher Zeit steht der Originalzustand hinten (er ist immer der älteste Stand)
    list.sort((a, b) => (b.createdAt - a.createdAt) || ((a.reason === 'original') - (b.reason === 'original')));
    return list.map(publicBackup);
  }

  async restoreBackup(id) {
    return this.withLock(async () => {
      const meta = await this.backups.get(id);
      await this.requireLocation();
      await this.ensureFortniteClosed();
      const sc = await this.scanNow();
      await this.ensureOriginalBackup();
      const before = await this.backupFromScan(sc, 'vor-wiederherstellen', `Vor dem Wiederherstellen von „${meta.label}“`);
      this.ownWriteUntil = Date.now() + 4000;
      const res = await engine.apply(this.backups.dir(id), meta, this.roots(), sc, { removeExtra: true, restoreReadOnly: true });
      if (!res.ok) {
        const rollback = await this.rollback(before.id);
        return { ok: false, backupId: before.id, ...res, rollback };
      }
      // Wiederhergestellt: der Cloud-Wächter vergleicht ab jetzt nicht mehr mit einem Profil
      const applied = await this.readState('applied', null);
      if (applied) await this.writeState('applied', { ...applied, profileId: null, restoredBackup: id });
      await this.pruneBackups();
      return { ok: true, backupId: before.id, ...res };
    });
  }

  async removeBackup(id) {
    const meta = await this.backups.get(id);
    if (meta.reason === 'original') throw new HelixError('PROTECTED', 'Die Sicherung des Originalzustands kann nicht gelöscht werden.');
    await this.backups.remove(id);
    return { removed: true };
  }

  async pinBackup(id, pinned) {
    const meta = await this.backups.get(id);
    meta.pinned = !!pinned || meta.reason === 'original';
    await this.backups.saveMeta(meta);
    return publicBackup(meta);
  }

  async pruneBackups() {
    const list = (await this.backups.list()).sort((a, b) => b.createdAt - a.createdAt);
    const loose = list.filter((b) => !b.pinned && b.reason !== 'original');
    for (const b of loose.slice(MAX_BACKUPS)) await this.backups.remove(b.id).catch(() => {});
  }

  async purgeTrash() {
    let entries = [];
    try { entries = await fsp.readdir(this.trashDir, { withFileTypes: true }); } catch { return; }
    const limit = Date.now() - 30 * 24 * 3600 * 1000;
    for (const ent of entries) {
      const p = path.join(this.trashDir, ent.name);
      try {
        // Löschdatum steht im Namen: <id>-JJJJMMTT-hhmmss
        const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(ent.name);
        const deletedAt = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : (await fsp.stat(p)).mtimeMs;
        if (deletedAt < limit) await fsp.rm(p, { recursive: true, force: true });
      } catch { /* egal */ }
    }
  }

  // ---------- Vergleich ----------

  /** Vergleicht ein Profil oder Backup Datei für Datei und Wert für Wert mit dem aktuellen Stand. */
  async diff(kind, id) {
    const store = kind === 'backup' ? this.backups : this.profiles;
    const meta = await store.get(id);
    const loc = await this.requireLocation();
    const sc = await this.scanNow().catch(() => ({ files: [] }));
    const out = [];
    for (const f of meta.files) {
      let target;
      const rel = f.root === 'saved' ? engine.resolveAccount(f.rel, sc) : f.rel;
      if (!rel) continue;
      try { target = safeJoin(f.root === 'saved' ? loc.savedDir : loc.configDir, rel); } catch { continue; }
      const stored = await engine.readStored(store.dir(id), f);
      let current = null;
      try { current = await fsp.readFile(target); } catch { /* fehlt */ }
      const entry = { root: f.root, rel: f.rel, label: f.label, kind: f.kind, status: 'same', changes: [] };
      const isIniFile = /\.ini$/i.test(f.rel);
      // INI: Login- und Konto-Daten auf beiden Seiten entfernen, bevor verglichen wird
      const curText = current && isIniFile ? sanitizeIniText(ini.decode(current).text).text : null;
      const savText = isIniFile ? sanitizeIniText(ini.decode(stored).text).text : null;
      if (!current) entry.status = 'missing';
      else if (isIniFile ? curText !== savText : sha256(current) !== sha256(stored)) entry.status = 'different';
      if (entry.status === 'different' && isIniFile) {
        const a = ini.toObject(ini.parse(curText));
        const b = ini.toObject(ini.parse(savText));
        for (const sec of new Set([...Object.keys(a), ...Object.keys(b)])) {
          for (const k of new Set([...Object.keys(a[sec] || {}), ...Object.keys(b[sec] || {})])) {
            const now = a[sec]?.[k];
            const then = b[sec]?.[k];
            if (now !== then) entry.changes.push({ section: sec, key: k, current: now ?? null, saved: then ?? null });
          }
        }
        if (!entry.changes.length) entry.status = 'same-values';
        entry.changes = entry.changes.slice(0, 300);
      }
      out.push(entry);
    }
    return { id, kind, name: meta.name || meta.label, files: out };
  }

  // ---------- Export / Import ----------

  async exportProfile(id, file) {
    return archive.exportProfile(this.profiles, id, file);
  }

  async importProfile(file) {
    const { meta, rejected } = await archive.importProfile(this.profiles, file, (n) => this.uniqueName(n));
    meta.summary = await this.summaryFor(this.profiles.dir(meta.id), meta.files);
    meta.order = Date.now();
    await this.profiles.saveMeta(meta);
    return { profile: publicProfile(meta, await this.activeProfileId()), rejected };
  }

  // ---------- Schreibschutz ----------

  /** Hebt den Schreibschutz aller Dateien im Config-Ordner auf (Notfall-Knopf). */
  async clearAllReadOnly() {
    const loc = await this.requireLocation();
    const { files } = await walk(loc.configDir, { maxDepth: 10, maxFiles: 5000 });
    const sc = await this.scanNow().catch(() => ({ files: [] }));
    const all = [...files, ...sc.files.filter((f) => f.root === 'saved')];
    const cleared = [];
    for (const f of all) {
      if (f.readOnly) {
        try { await setReadOnly(f.abs, false); cleared.push(f.rel); } catch { /* weiter */ }
      }
    }
    return { cleared };
  }

  async setFileReadOnly(root, rel, on) {
    if (root === 'saved' && on) {
      throw new HelixError('NOT_ALLOWED', 'Die Tasten-/Sensi-Datei ist eine Kopie aus der Epic-Cloud. Ein Schreibschutz würde Fortnite nur beim Aktualisieren stören.');
    }
    const loc = await this.requireLocation();
    const p = safeJoin(root === 'saved' ? loc.savedDir : loc.configDir, rel);
    if (!(await exists(p))) throw new HelixError('NOT_FOUND', 'Datei nicht gefunden.');
    await setReadOnly(p, !!on);
    return { rel, readOnly: await isReadOnly(p) };
  }

  // ---------- Für die Tools: INI-Werte ändern (mit Backup) ----------

  async findConfigFile(name) {
    const loc = await this.requireLocation();
    const { files } = await walk(loc.configDir, { maxDepth: 6, maxFiles: 3000 });
    const matches = files.filter((f) => path.basename(f.rel).toLowerCase() === String(name).toLowerCase());
    if (!matches.length) return null;
    // WindowsClient bevorzugen
    matches.sort((a, b) => (/windowsclient\//i.test(b.rel) ? 1 : 0) - (/windowsclient\//i.test(a.rel) ? 1 : 0));
    return matches[0];
  }

  /** Liest Werte aus einer Config-Datei: keys = [{section, key}] */
  async readIniValues(fileName, keys) {
    const f = await this.findConfigFile(fileName);
    if (!f) return { found: false, values: {} };
    const doc = ini.parse(ini.decode(await fsp.readFile(f.abs)).text);
    const values = {};
    for (const { section, key } of keys) values[`${section}|${key}`] = ini.get(doc, section, key);
    return { found: true, rel: f.rel, readOnly: f.readOnly, values };
  }

  /** Zeigt, was sich ändern würde: changes = [{section, key, value}] */
  async previewIniChanges(fileName, changes) {
    const f = await this.findConfigFile(fileName);
    if (!f) throw new HelixError('NO_FILE', `${fileName} wurde nicht gefunden. Starte Fortnite einmal, damit die Datei angelegt wird.`);
    const doc = ini.parse(ini.decode(await fsp.readFile(f.abs)).text);
    return {
      rel: f.rel,
      readOnly: f.readOnly,
      changes: changes.map((c) => {
        const from = ini.get(doc, c.section, c.key);
        return { section: c.section, key: c.key, from, to: String(c.value), changed: from === null || String(from).trim() !== String(c.value) };
      }),
    };
  }

  /**
   * Schreibt INI-Werte mit Backup. Schreibschutz bleibt wie er war.
   * Ist gerade ein Profil aktiv, wird der neue Stand als erwarteter Stand übernommen.
   */
  async applyIniChanges(fileName, changes, { reason = 'tool', label = 'Änderung durch ein HELIX-Tool' } = {}) {
    return this.withLock(async () => {
      await this.ensureFortniteClosed();
      const f = await this.findConfigFile(fileName);
      if (!f) throw new HelixError('NO_FILE', `${fileName} wurde nicht gefunden. Starte Fortnite einmal, damit die Datei angelegt wird.`);
      for (const c of changes) {
        if (!c.section || !c.key || /[\r\n]/.test(String(c.value)) || /[\r\n=[\]]/.test(c.key)) {
          throw new HelixError('BAD_CHANGE', 'Ungültige Änderung.');
        }
      }
      const sc = await this.scanNow();
      await this.ensureOriginalBackup();
      const backup = await this.backupFromScan(sc, reason, label);
      const buf = await fsp.readFile(f.abs);
      const dec = ini.decode(buf);
      const doc = ini.parse(dec.text);
      const applied = [];
      for (const c of changes) {
        const from = ini.get(doc, c.section, c.key);
        if (from !== null && String(from).trim() === String(c.value)) continue;
        ini.set(doc, c.section, c.key, c.value);
        applied.push({ section: c.section, key: c.key, from, to: String(c.value) });
      }
      if (applied.length) {
        const wasRo = await isReadOnly(f.abs);
        this.ownWriteUntil = Date.now() + 4000;
        await writeFileSafe(f.abs, ini.encode(ini.stringify(doc), dec.encoding));
        if (wasRo) await setReadOnly(f.abs, true);
        await this.refreshAppliedHash('config', f.rel);
      }
      await this.pruneBackups();
      return { rel: f.rel, applied, backupId: backup.id };
    });
  }

  async refreshAppliedHash(root, rel) {
    const applied = await this.readState('applied', null);
    if (!applied?.files) return;
    const entry = applied.files.find((x) => engine.keyOf(x.root, x.rel) === engine.keyOf(root, rel));
    if (!entry) return;
    try {
      const buf = await fsp.readFile(safeJoin(this.roots()[root], rel));
      entry.sha256 = sha256(buf);
      entry.values = watchedValues(rel, buf);
      await this.writeState('applied', applied);
    } catch { /* egal */ }
  }

  async setOverride(dir) {
    const s = await this.readState('settings', {});
    s.fortniteOverride = dir || null;
    await this.writeState('settings', s);
    await this.locate();
    if (this.timers.length || this.watcher) this.startWatching();
    return this.location;
  }

  async status() {
    const fn = await this.fortniteStatus().catch(() => this.fortniteState);
    const applied = await this.readState('applied', null);
    const drift = await this.checkDrift(false).catch(() => ({ status: 'none' }));
    const loc = this.location || { found: false };
    return {
      fortnite: fn,
      location: { found: !!loc.found, configDir: loc.configDir || null, savedDir: loc.savedDir || null, source: loc.source || null, searched: loc.searched || [] },
      active: applied?.profileId ? { id: applied.profileId, name: applied.profileName, appliedAt: applied.appliedAt } : null,
      drift,
      profileCount: (await this.profiles.list()).length,
      backupCount: (await this.backups.list()).length,
      platform: process.platform,
    };
  }

  dispose() { this.stopWatching(); }
}

module.exports = { CoreService, cleanName, normRel };
