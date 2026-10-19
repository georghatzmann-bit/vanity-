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

/**
 * Öffentliche Endungen und Hosting-Plattformen: Ein Listeneintrag genau dafür würde alle Seiten
 * darunter sperren – solche Einträge werden verworfen.
 */
const SHARED_SUFFIXES = new Set([
  'co.uk',
  'com.au',
  'co.jp',
  'com.br',
  'co.nz',
  'co.za',
  'com.tr',
  'com.mx',
  'co.in',
  'github.io',
  'gitlab.io',
  'blogspot.com',
  'wordpress.com',
  'web.app',
  'firebaseapp.com',
  'pages.dev',
  'workers.dev',
  'netlify.app',
  'vercel.app',
  'herokuapp.com',
  'azurewebsites.net',
  'appspot.com',
  'wixsite.com',
  'weebly.com',
  'weeblysite.com',
  '000webhostapp.com',
  'glitch.me',
  'ngrok.io',
  'ngrok-free.app',
  'ipfs.io',
  'r2.dev',
  'onrender.com',
  'fly.dev',
  'surge.sh',
]);

/**
 * Große Dienste, die AEGIS nie über Fremdlisten sperrt (auch keine Unteradressen wie
 * `docs.google.com` – das würde den Dienst für alle sperren). Phishing auf diesen Plattformen
 * erkennen die Seitenhinweise und die Browser-eigenen Filter.
 */
const NEVER_BLOCK = [
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'youtube.com',
  'microsoft.com',
  'live.com',
  'office.com',
  'microsoftonline.com',
  'sharepoint.com',
  'windows.net',
  'azure.com',
  'bing.com',
  'apple.com',
  'icloud.com',
  'amazon.com',
  'amazonaws.com',
  'github.com',
  'githubusercontent.com',
  'cloudflare.com',
  'facebook.com',
  'instagram.com',
  'whatsapp.com',
  'dropbox.com',
  'wikipedia.org',
  'mozilla.org',
];

/** Darf dieser Listeneintrag gesperrt werden? */
export function blockable(domain: string): boolean {
  return !SHARED_SUFFIXES.has(domain) && !NEVER_BLOCK.some((d) => withinDomain(domain, d));
}

/** Die Domain und alle übergeordneten Domains mit mindestens zwei Teilen. */
export function parents(host: string): string[] {
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}
