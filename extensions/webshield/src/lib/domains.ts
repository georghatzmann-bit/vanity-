/**
 * Domains aus Listen lesen und prüfen (rein, testbar). Unterstützt Hosts-Format
 * (`0.0.0.0 example.com`), „Adblock-Kurzform“ (`||example.com^`) und reine Domain-Zeilen.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Gültiger, normalisierter Domainname (klein, ohne Punkt am Ende, mindestens zwei Teile). */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  if (d.length < 3 || d.length > 253 || !d.includes('.')) {
    return null;
  }
  const labels = d.split('.');
  if (!labels.every((l) => LABEL.test(l))) {
    return null;
  }
  // Reine IP-Adressen gehören nicht in Domainlisten.
  if (labels.every((l) => /^\d+$/.test(l))) {
    return null;
  }
  return d;
}

/** Liest eine Liste; Kommentare, lokale Namen und ungültige Zeilen entfallen. */
export function parseList(text: string, max = 500_000): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (out.size >= max) {
      break;
    }
    const line = raw.replace(/[#!].*$/, '').trim();
    if (line === '') {
      continue;
    }
    const parts = line.split(/\s+/);
    let candidate = parts.length > 1 ? (parts[1] ?? '') : (parts[0] ?? '');
    candidate = candidate.replace(/^\|\|/, '').replace(/\^.*$/, '');
    if (candidate === 'localhost' || candidate.endsWith('.local')) {
      continue;
    }
    const d = normalizeDomain(candidate);
    if (d !== null) {
      out.add(d);
    }
  }
  return [...out];
}

/** Hostname einer Adresse (oder `null`). */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Liegt `host` in `domain` (gleich oder Subdomain)? */
export function withinDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
