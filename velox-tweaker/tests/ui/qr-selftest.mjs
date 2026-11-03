#!/usr/bin/env node
// Checks the QR encoder (ui/js/qr.js) without a browser:
//  1. the independent decoder (qr-decode.mjs) reads codes of a second, independent encoder
//     (Kazuhiko Arase's, MIT - ships with npm as qrcode-terminal) -> the decoder is right;
//  2. ui/js/qr.js with the same version + mask gives the SAME matrix, bit for bit;
//  3. ui/js/qr.js codes of every level and many lengths (versions 1-40) decode back to their text.
// Exits 1 on any failure. Also exported as runQrSelftest() for tests/ui/run-ui-tests.mjs.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeMatrix } from './qr-decode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');

function findArase() {
  const roots = [];
  try { roots.push(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* no npm */ }
  roots.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
  for (const r of roots) {
    for (const p of [path.join(r, 'qrcode-terminal'), path.join(r, 'npm', 'node_modules', 'qrcode-terminal')]) {
      const idx = path.join(p, 'vendor', 'QRCode', 'index.js');
      if (fs.existsSync(idx)) {
        const req = createRequire(idx);
        return { QRCode: req(idx), Level: req(path.join(p, 'vendor', 'QRCode', 'QRErrorCorrectLevel.js')), where: p };
      }
    }
  }
  return null;
}

export async function runQrSelftest(log = console.log) {
  const { qrMatrix } = await import(pathToFileURL(path.join(appRoot, 'ui', 'js', 'qr.js')).href);
  const notes = [];
  let checks = 0;
  const texts = ['VELOX', 'https://georghatzmann-bit.github.io/vanity-/bios.html#v=1&p=asus&c=amd&s=rpt.dco.rbo.csu.sbt.tpo&w=bo.bl&g=val&b=ROG%20STRIX%20B550-F%20GAMING&i=2803&d=20220312'];
  for (let n = 1; n <= 2950; n = Math.min(n === 2950 ? 9999 : 2950, Math.ceil(n * 1.37) + 3)) texts.push(('#v=1&p=msi&c=intel&s=' + 'rpt.dcu.'.repeat(400)).slice(0, n));
  const arase = findArase();
  if (arase) {
    for (const lvl of ['L', 'M', 'Q', 'H']) {
      for (const t of texts.slice(0, 14)) {
        const q = new arase.QRCode(-1, arase.Level[lvl]);
        q.addData(t);
        try { q.make(); } catch { continue; }   // Arase's auto-version stops at 39
        const theirs = q.modules.map(r => r.map(Boolean));
        const d = decodeMatrix(theirs);
        if (d.text !== t || d.ecc !== lvl) throw new Error('decoder misread the independent encoder (' + lvl + ', ' + t.length + ' chars): ' + JSON.stringify(d).slice(0, 120));
        const mine = qrMatrix(t, { ecc: lvl, minVersion: d.version, maxVersion: d.version, mask: d.mask });
        let diff = 0;
        for (let y = 0; y < theirs.length; y++) for (let x = 0; x < theirs.length; x++) if (mine.modules[y][x] !== theirs[y][x]) diff++;
        if (mine.size !== theirs.length || diff) throw new Error('ui/js/qr.js differs from the independent encoder in ' + diff + ' modules (' + lvl + ', version ' + d.version + ', mask ' + d.mask + ')');
        checks += 2;
      }
    }
  } else notes.push('Zweiter QR-Encoder (qrcode-terminal) nicht gefunden – nur Rückwärts-Dekodierung geprüft.');
  const versions = new Set();
  for (const lvl of ['L', 'M', 'Q', 'H']) {
    for (const t of texts) {
      let q;
      try { q = qrMatrix(t, { ecc: lvl }); } catch { continue; }
      for (const mask of [q.mask, (q.mask + 3) % 8]) {
        const m = mask === q.mask ? q : qrMatrix(t, { ecc: lvl, minVersion: q.version, maxVersion: q.version, mask });
        const d = decodeMatrix(m.modules);
        if (d.text !== t || d.version !== q.version || d.ecc !== lvl || d.mask !== mask) throw new Error('round trip failed (' + lvl + ', ' + t.length + ' chars, mask ' + mask + ')');
        checks++;
      }
      versions.add(q.version);
    }
  }
  // umlauts and the en dash go through as UTF-8
  const u = 'Grüße – „VELOX“';
  if (decodeMatrix(qrMatrix(u).modules).text !== u) throw new Error('UTF-8 round trip failed');
  checks++;
  log('    QR: ' + checks + ' checks, versions ' + Math.min(...versions) + '–' + Math.max(...versions) + (arase ? ', bit-identical to ' + path.basename(arase.where) : ''));
  return { checks, notes, arase: !!arase };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runQrSelftest().then((r) => { for (const n of r.notes) console.log('NOTE ' + n); console.log('ok'); }).catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
}
