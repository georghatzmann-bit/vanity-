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
    return this.type === 'profile' ? `p-${slug(name)}-${rand(6)}` : `${stamp()}-${rand(8)}`;
  }

  /** Neue, garantiert freie Kennung (kein Überschreiben vorhandener Einträge). */
  async freeId(name) {
    for (let i = 0; i < 20; i++) {
      const id = this.newId(name);
      if (!(await exists(this.dir(id))) && !(await exists(path.join(this.root, `.tmp-${id}`)))) return id;
    }
    throw new HelixError('ID_COLLISION', 'Es konnte keine freie Kennung erzeugt werden.');
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
    const dir = this.dir(meta.id);
    // nie einen halben Eintrag (nur meta.json, ohne Dateien) neu anlegen
    if (!(await exists(path.join(dir, 'files'))) && !(await exists(path.join(dir, 'meta.json')))) {
      throw new HelixError('NOT_FOUND', this.type === 'profile' ? 'Profil nicht gefunden.' : 'Sicherung nicht gefunden.');
    }
    meta.updatedAt = Date.now();
    await writeJson(path.join(dir, 'meta.json'), meta);
    return meta;
  }

  /**
   * Legt einen Eintrag aus einem Scan an (erst in einen Hilfsordner, dann umbenennen).
   * Mit baseMeta.id wird ein vorhandener Eintrag ersetzt (Profil aktualisieren) – sicher:
   * schlägt der Tausch fehl, kommt der alte Stand zurück.
   * options.allAccounts: auch Cloud-Kopien anderer Konten sichern (für Backups).
   */
  async createFromScan(scanResult, baseMeta, options = {}) {
    await fsp.mkdir(this.root, { recursive: true });
    const replace = !!baseMeta.id;
    const id = replace ? baseMeta.id : await this.freeId(baseMeta.name || baseMeta.reason || 'x');
    const tmp = path.join(this.root, `.tmp-${id}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    try {
      const files = await capture(scanResult, tmp, options);
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
      if (replace && await exists(final)) {
        // bestehenden Eintrag ersetzen: alt beiseite, neu hinein, alt löschen – bei Fehler alt zurück
        const old = path.join(this.root, `.old-${id}-${rand(4)}`);
        await retry(() => fsp.rename(final, old));
        try {
          await retry(() => fsp.rename(tmp, final));
        } catch (e) {
          await retry(() => fsp.rename(old, final)).catch(() => {});
          throw e;
        }
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
    const newId = await this.freeId(patch.name || meta.name || 'kopie');
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
      const target = path.join(trashRoot, `${id}-${stamp()}`);
      await retry(() => fsp.rename(dir, target));
      // Verschieben ändert das Datum nicht – für die 30-Tage-Frist das Löschdatum setzen
      const now = new Date();
      await fsp.utimes(target, now, now).catch(() => {});
    } else {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Räumt nach einem Absturz auf. Eine alte Kopie (.old-<id>-xxxx) wird zurückgeholt, wenn der
   * Eintrag selbst fehlt – sonst ginge ein Profil verloren, dessen Tausch unterbrochen wurde.
   */
  async cleanup() {
    let entries = [];
    try { entries = await fsp.readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(this.root, ent.name);
      const old = /^\.old-(.+)-[0-9a-f]{4}$/.exec(ent.name);
      if (old) {
        const final = path.join(this.root, old[1]);
        if (!(await exists(final)) && await exists(path.join(full, 'meta.json'))) {
          await retry(() => fsp.rename(full, final)).catch(() => {});
        } else {
          await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
        }
      } else if (/^\.tmp-/.test(ent.name)) {
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

module.exports = { SnapshotStore, slug, stamp, SCHEMA };
