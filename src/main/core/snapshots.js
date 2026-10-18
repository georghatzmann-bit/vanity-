'use strict';
// Speicherort für Profile und Backups (gleiches Format, verschiedene Ordner).

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { readJson, writeJson, exists, retry } = require('./fsutil');
const { capture } = require('./engine');
const { HelixError } = require('../sys/exec');

const SCHEMA = 1;

function slug(name) {
  return String(name).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'profil';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const rand = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);

class SnapshotStore {
  constructor(root, type) {
    this.root = root;
    this.type = type;
  }

  dir(id) {
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(id))) throw new HelixError('BAD_ID', 'Ungültige Kennung.');
    return path.join(this.root, id);
  }

  newId(name) {
    return this.type === 'profile' ? `p-${slug(name)}-${rand(6)}` : `${stamp()}-${rand(4)}`;
  }

  async list() {
    let entries = [];
    try { entries = await fsp.readdir(this.root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const meta = await readJson(path.join(this.root, ent.name, 'meta.json'));
      if (meta && meta.type === this.type && meta.id === ent.name) out.push(meta);
    }
    return out;
  }

  async get(id) {
    const meta = await readJson(path.join(this.dir(id), 'meta.json'));
    if (!meta) throw new HelixError('NOT_FOUND', this.type === 'profile' ? 'Profil nicht gefunden.' : 'Sicherung nicht gefunden.');
    return meta;
  }

  async saveMeta(meta) {
    meta.updatedAt = Date.now();
    await writeJson(path.join(this.dir(meta.id), 'meta.json'), meta);
    return meta;
  }

  /** Legt einen neuen Eintrag aus einem Scan an (erst in einen Hilfsordner, dann umbenennen). */
  async createFromScan(scanResult, baseMeta) {
    await fsp.mkdir(this.root, { recursive: true });
    const id = baseMeta.id || this.newId(baseMeta.name || baseMeta.reason || 'x');
    const tmp = path.join(this.root, `.tmp-${id}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    try {
      const files = await capture(scanResult, tmp);
      const meta = {
        schema: SCHEMA,
        type: this.type,
        ...baseMeta,
        id,
        createdAt: baseMeta.createdAt || Date.now(),
        updatedAt: Date.now(),
        source: { configDir: scanResult.configDir, savedDir: scanResult.savedDir, scannedAt: scanResult.scannedAt },
        files,
      };
      await writeJson(path.join(tmp, 'meta.json'), meta);
      const final = this.dir(id);
      if (await exists(final)) {
        // bestehenden Eintrag ersetzen: alt beiseite, neu hinein, alt löschen
        const old = path.join(this.root, `.old-${id}-${rand(4)}`);
        await retry(() => fsp.rename(final, old));
        await retry(() => fsp.rename(tmp, final));
        await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
      } else {
        await retry(() => fsp.rename(tmp, final));
      }
      return meta;
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  /** Kopiert einen kompletten Eintrag unter neuer Kennung. */
  async duplicate(id, patch) {
    const meta = await this.get(id);
    const newId = this.newId(patch.name || meta.name || 'kopie');
    const tmp = path.join(this.root, `.tmp-${newId}`);
    await fsp.cp(this.dir(id), tmp, { recursive: true });
    const copy = { ...meta, ...patch, id: newId, createdAt: Date.now(), updatedAt: Date.now() };
    await writeJson(path.join(tmp, 'meta.json'), copy);
    await retry(() => fsp.rename(tmp, this.dir(newId)));
    return copy;
  }

  async remove(id, trashRoot) {
    const dir = this.dir(id);
    if (!(await exists(dir))) return;
    if (trashRoot) {
      await fsp.mkdir(trashRoot, { recursive: true });
      await retry(() => fsp.rename(dir, path.join(trashRoot, `${id}-${stamp()}`)));
    } else {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  /** Räumt halbfertige Hilfsordner auf (z. B. nach Absturz). */
  async cleanup() {
    let entries = [];
    try { entries = await fsp.readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory() && /^\.(tmp|old)-/.test(ent.name)) {
        await fsp.rm(path.join(this.root, ent.name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

module.exports = { SnapshotStore, slug, stamp, SCHEMA };
