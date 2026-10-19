/**
 * Listen, die die Erweiterung zur Laufzeit lädt (nur wenn „Listen aktualisieren“ an ist).
 * Lizenzen und Herkunft stehen in `docs/LICENSES.md`; neue Quellen erst nach Prüfung.
 */

import type { Category } from './rules';

export interface Source {
  readonly id: string;
  readonly category: Category;
  readonly url: string;
  readonly homepage: string;
  readonly license: string;
  /** Höchstzahl übernommener Domains (Schutz vor übergroßen Antworten). */
  readonly max: number;
}

export const SOURCES: readonly Source[] = [
  {
    id: 'phishing-database',
    category: 'phishing',
    url: 'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt',
    homepage: 'https://github.com/Phishing-Database/Phishing.Database',
    license: 'MIT',
    max: 450_000,
  },
  {
    id: 'blocklistproject-phishing',
    category: 'phishing',
    url: 'https://raw.githubusercontent.com/blocklistproject/Lists/master/alt-version/phishing-nl.txt',
    homepage: 'https://github.com/blocklistproject/Lists',
    license: 'Unlicense',
    max: 250_000,
  },
  {
    id: 'blocklistproject-fraud',
    category: 'scam',
    url: 'https://raw.githubusercontent.com/blocklistproject/Lists/master/alt-version/fraud-nl.txt',
    homepage: 'https://github.com/blocklistproject/Lists',
    license: 'Unlicense',
    max: 300_000,
  },
];

/** Größte akzeptierte Antwort je Liste (Bytes). */
export const MAX_LIST_BYTES = 24 * 1024 * 1024;
/** Höchstzahl Domains über alle geladenen Listen (Speicher des Browsers schonen). */
export const MAX_TOTAL_DOMAINS = 900_000;
/** Abstand der automatischen Aktualisierung. */
export const UPDATE_MINUTES = 24 * 60;

/** Kennungsbereich der dynamischen Regeln je Kategorie (je 1000 Regeln Platz). */
export function categoryBase(category: Category): number {
  const order: Record<Category, number> = { phishing: 0, scam: 1, malware: 2, ransomware: 3 };
  return 1000 + order[category] * 1000;
}
