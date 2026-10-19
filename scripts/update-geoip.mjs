#!/usr/bin/env node
/**
 * Erzeugt `rules/geo/ip-country.bin` aus den Länderdaten von iptoasn.com (Public Domain,
 * PDDL v1.0). Benachbarte Bereiche desselben Landes werden zusammengefasst, Bereiche ohne Land
 * entfallen. IPv6 wird auf die oberen 64 Bit gekürzt (für ein Land genügt das).
 *
 * Aufruf: node scripts/update-geoip.mjs <ip2country-v4-u32.tsv.gz> <ip2country-v6.tsv.gz>
 * (Dateien vorher von https://iptoasn.com/data/ laden.)
 *
 * Format: "AEGEO1\n", u16 Anzahl Ländercodes + je 2 Byte ASCII, dann je Familie u32 Anzahl und
 * Einträge (varint Abstand zum Ende des vorigen Bereichs, varint Länge, u8 Land).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { argv, exit } from 'node:process';

const [, , v4Path, v6Path] = argv;
if (v4Path === undefined || v6Path === undefined) {
  console.error('Aufruf: node scripts/update-geoip.mjs <v4.tsv.gz> <v6.tsv.gz>');
  exit(2);
}

/** IPv6-Text → obere 64 Bit. */
function v6Top(text) {
  const [head, tail = ''] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = text.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  let value = 0n;
  for (const g of groups.slice(0, 4)) {
    value = (value << 16n) | BigInt(parseInt(g === '' ? '0' : g, 16));
  }
  return value;
}

function read(path, parse) {
  const out = [];
  for (const line of gunzipSync(readFileSync(path)).toString('utf8').split('\n')) {
    const [a, b, cc] = line.split('\t');
    if (a === undefined || b === undefined || cc === undefined || !/^[A-Z]{2}$/.test(cc)) {
      continue;
    }
    const start = parse(a);
    const end = parse(b);
    const last = out.at(-1);
    if (last !== undefined && start <= last.end) {
      continue; // Überlappung (v6 auf 64 Bit gekürzt): erster Eintrag gewinnt.
    }
    if (last !== undefined && last.cc === cc && last.end + 1n === start) {
      last.end = end;
    } else {
      out.push({ start, end, cc });
    }
  }
  return out;
}

const v4 = read(v4Path, (s) => BigInt(s));
const v6 = read(v6Path, v6Top);
const codes = [...new Set([...v4, ...v6].map((r) => r.cc))].sort();
if (codes.length > 255) {
  throw new Error('zu viele Ländercodes');
}
const index = new Map(codes.map((c, i) => [c, i]));

const bytes = [];
const u8 = (n) => bytes.push(n & 0xff);
const u16 = (n) => {
  u8(n);
  u8(n >> 8);
};
const u32 = (n) => {
  u16(n & 0xffff);
  u16(n >>> 16);
};
const varint = (big) => {
  let v = big;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) {
      byte |= 0x80;
    }
    u8(byte);
  } while (v > 0n);
};

for (const c of 'AEGEO1\n') {
  u8(c.charCodeAt(0));
}
u16(codes.length);
for (const c of codes) {
  u8(c.charCodeAt(0));
  u8(c.charCodeAt(1));
}
for (const family of [v4, v6]) {
  u32(family.length);
  let next = 0n;
  for (const r of family) {
    varint(r.start - next);
    varint(r.end - r.start);
    u8(index.get(r.cc));
    next = r.end + 1n;
  }
}
mkdirSync('rules/geo', { recursive: true });
writeFileSync('rules/geo/ip-country.bin', Buffer.from(bytes));
console.log(`v4: ${v4.length}, v6: ${v6.length}, Codes: ${codes.length}, ${bytes.length} Byte`);
