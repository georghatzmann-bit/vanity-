'use strict';
// Holt den Text aus einer PDF-Datei (mit pdf.js von Mozilla).
// Die Textstücke einer Seite werden nach ihrer Position wieder zu Zeilen
// zusammengesetzt, damit "Bezeichnung: Wert" auch in Tabellen erkannt wird.

const path = require('path');
const { pathToFileURL } = require('url');

let pdfjsPromise = null;

function pdfjsDir() {
  // Im installierten Programm liegt pdf.js entpackt neben dem app.asar,
  // weil die Schriften- und Zeichentabellen als echte Dateien gelesen werden.
  const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return base.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
}

function loadPdfjs() {
  if (!pdfjsPromise) {
    const dir = pdfjsDir();
    const entry = pathToFileURL(path.join(dir, 'legacy', 'build', 'pdf.mjs')).href;
    pdfjsPromise = import(entry).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, 'legacy', 'build', 'pdf.worker.mjs')).href;
      return { lib, dir };
    });
  }
  return pdfjsPromise;
}

// Setzt Textstücke einer Seite zu Zeilen zusammen.
// Stücke mit (fast) gleicher Höhe auf der Seite gehören zur selben Zeile.
function itemsToLines(items) {
  const parts = [];
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const str = it.str.replace(/ /g, ' ');
    if (!str.trim() && !it.hasEOL) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    parts.push({ str, x, y, h, w: it.width || 0 });
  }
  // Von oben nach unten, dann von links nach rechts
  parts.sort((a, b) => (Math.abs(b.y - a.y) > Math.min(a.h, b.h) * 0.5 ? b.y - a.y : a.x - b.x));

  const lines = [];
  let current = null;
  for (const p of parts) {
    if (current && Math.abs(current.y - p.y) <= Math.min(current.h, p.h) * 0.5) {
      current.parts.push(p);
    } else {
      current = { y: p.y, h: p.h, parts: [p] };
      lines.push(current);
    }
  }

  return lines.map((line) => {
    line.parts.sort((a, b) => a.x - b.x);
    let out = '';
    let lastEnd = null;
    for (const p of line.parts) {
      if (lastEnd !== null) {
        const gap = p.x - lastEnd;
        // Großer Abstand = andere Tabellenspalte, kleiner Abstand = Leerzeichen
        if (gap > p.h * 1.5) out += '   ';
        else if (gap > p.h * 0.15 && !out.endsWith(' ') && !p.str.startsWith(' ')) out += ' ';
      }
      out += p.str;
      lastEnd = p.x + p.w;
    }
    return out.replace(/[ \t]+$/g, '');
  }).filter((l) => l.trim().length > 0);
}

async function extractText(bytes, { maxPages = 200, password } = {}) {
  const { lib, dir } = await loadPdfjs();
  // pdf.js liest diese Ordner in Node mit fs: also echte Pfade (keine file://-Adressen),
  // und am Ende ein "/" – das verlangt pdf.js, Windows akzeptiert es ebenfalls.
  const toDirUrl = (sub) => path.join(dir, sub) + '/';
  const task = lib.getDocument({
    data: bytes,
    password: password || undefined,
    cMapUrl: toDirUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: toDirUrl('standard_fonts'),
    wasmUrl: toDirUrl('wasm'),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    const e = new Error(err && err.name ? err.name : 'PDF-Fehler');
    if (err && err.name === 'PasswordException') {
      // code 1 = Passwort nötig, code 2 = Passwort falsch (das Passwort selbst wird nie gespeichert)
      e.code = err.code === 2 ? 'WRONG_PASSWORD' : 'NEED_PASSWORD';
      e.userMessage = e.code === 'WRONG_PASSWORD'
        ? 'Das Passwort passt nicht. Bitte nochmal genau aus der Epic-Mail kopieren.'
        : 'Die PDF ist mit einem Passwort geschützt.';
    } else {
      e.userMessage = 'Die PDF konnte nicht gelesen werden. Ist die Datei vielleicht beschädigt?';
    }
    throw e;
  }

  try {
    const pageCount = Math.min(doc.numPages, maxPages);
    const pageTexts = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pageTexts.push(itemsToLines(content.items).join('\n'));
      page.cleanup();
    }
    const text = pageTexts.join('\n\n');
    return { text, pages: doc.numPages, scanned: text.trim().length === 0 };
  } finally {
    await task.destroy();
  }
}

module.exports = { extractText, itemsToLines };
