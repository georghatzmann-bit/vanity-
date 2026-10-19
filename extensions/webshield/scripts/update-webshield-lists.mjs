// Erzeugt public/rules/bundled.json (statische Regeln, mit der Erweiterung ausgeliefert) aus
// den Listen „ransomware“ und „scam“ des Block List Project (Unlicense, siehe docs/LICENSES.md).
// Aufruf: node scripts/update-webshield-lists.mjs [ordner-mit-ransomware-nl.txt-und-scam-nl.txt]
// Ohne Ordner werden die Listen von GitHub geladen.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseList } from '../src/lib/domains.ts';
import { blockRules } from '../src/lib/rules.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/blocklistproject/Lists/master/alt-version/';
const lists = [
  { category: 'ransomware', file: 'ransomware-nl.txt', id: 1 },
  { category: 'scam', file: 'scam-nl.txt', id: 100 },
];

async function load(file) {
  const local = process.argv[2];
  if (local !== undefined) {
    return readFile(resolve(local, file), 'utf8');
  }
  const response = await fetch(BASE + file);
  if (!response.ok) {
    throw new Error(`${file}: HTTP ${response.status}`);
  }
  return response.text();
}

const seen = new Set();
const rules = [];
for (const list of lists) {
  const domains = parseList(await load(list.file)).filter((d) => !seen.has(d) && seen.add(d));
  domains.sort();
  rules.push(...blockRules(list.category, domains, list.id));
  console.warn(`${list.category}: ${domains.length} Domains`);
}
await writeFile(resolve(root, 'public/rules/bundled.json'), `${JSON.stringify(rules)}\n`);
