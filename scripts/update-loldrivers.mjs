#!/usr/bin/env node
/**
 * Erzeugt `rules/drivers/loldrivers.tsv` aus der LOLDrivers-Liste (Apache-2.0,
 * https://github.com/magicsword-io/LOLDrivers). Nur Prüfsummen und Kurzangaben werden
 * übernommen – keine Treiberdateien.
 *
 * Aufruf: node scripts/update-loldrivers.mjs <drivers.json>
 * (Die Datei vorher von https://www.loldrivers.io/api/drivers.json laden.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

const source = argv[2];
if (source === undefined) {
  console.error('Aufruf: node scripts/update-loldrivers.mjs <drivers.json>');
  exit(2);
}

const hex64 = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f-]{36}$/;

/** Prüfsumme in Kleinbuchstaben oder `-`. */
function hash(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return hex64.test(v) ? v : '-';
}

/** Dateiname ohne Steuerzeichen/Tabulatoren, höchstens 64 Zeichen. */
function name(value) {
  const v = typeof value === 'string' ? value : '';
  return (
    v
      .replace(/[\p{Cc}\t]/gu, ' ')
      .trim()
      .slice(0, 64) || '-'
  );
}

const drivers = JSON.parse(readFileSync(source, 'utf8'));
const seen = new Set();
const lines = [];
for (const driver of drivers) {
  const category = driver.Category === 'malicious' ? 'm' : 'v';
  const id = typeof driver.Id === 'string' && uuid.test(driver.Id) ? driver.Id : null;
  if (id === null) {
    continue;
  }
  for (const sample of driver.KnownVulnerableSamples ?? []) {
    const sha256 = hash(sample.SHA256);
    const authenti = hash(sample.Authentihash?.SHA256);
    if (sha256 === '-' && authenti === '-') {
      continue;
    }
    const key = `${sha256}/${authenti}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const hvci = String(sample.LoadsDespiteHVCI).toUpperCase() === 'TRUE' ? '1' : '0';
    const file = name(sample.Filename ?? sample.OriginalFilename);
    lines.push([sha256, authenti, category, hvci, id, file].join('\t'));
  }
}
lines.sort();
const today = new Date().toISOString().slice(0, 10);
const header = [
  '# LOLDrivers (https://www.loldrivers.io) – Apache-2.0, siehe LICENSE-LOLDrivers.txt',
  `# Stand: ${today} · Einträge: ${lines.length}`,
  '# Spalten: sha256  authentihash-sha256  kategorie(m=bösartig,v=verwundbar)  lädt-trotz-hvci  id  dateiname',
];
writeFileSync('rules/drivers/loldrivers.tsv', `${[...header, ...lines].join('\n')}\n`);
console.log(`${lines.length} Einträge geschrieben.`);
