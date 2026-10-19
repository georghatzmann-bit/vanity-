/**
 * Hinweise auf Betrugsseiten (rein, testbar): Markennamen in fremden Domains („paypal-login.xyz“),
 * vertauschte Zeichen („amaz0n“), Punycode (`xn--`) und Passwortfelder ohne HTTPS.
 * Nur Hinweise – der Nutzer entscheidet.
 */

/** Marken und ihre echten Domains (Auswahl häufig nachgeahmter Dienste). */
const BRANDS: Readonly<Record<string, readonly string[]>> = {
  paypal: ['paypal.com', 'paypal.de', 'paypal.me'],
  amazon: [
    'amazon.com',
    'amazon.de',
    'amazon.co.uk',
    'amazon.fr',
    'amazon.it',
    'amazon.es',
    'amazonaws.com',
    'media-amazon.com',
  ],
  microsoft: [
    'microsoft.com',
    'live.com',
    'office.com',
    'microsoftonline.com',
    'outlook.com',
    'windows.net',
    'azure.com',
    'bing.com',
  ],
  apple: ['apple.com', 'icloud.com', 'apple.de'],
  google: [
    'google.com',
    'google.de',
    'gmail.com',
    'youtube.com',
    'googleusercontent.com',
    'gstatic.com',
  ],
  sparkasse: ['sparkasse.de'],
  volksbank: ['volksbank.de', 'vr.de'],
  dhl: ['dhl.de', 'dhl.com'],
  ebay: ['ebay.de', 'ebay.com', 'ebay.co.uk'],
  netflix: ['netflix.com'],
  facebook: ['facebook.com', 'fb.com', 'meta.com'],
  instagram: ['instagram.com'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  binance: ['binance.com'],
  coinbase: ['coinbase.com'],
};

/** Typische Zeichen-Tricks rückgängig machen (0→o, 1→l, rn→m, vv→w …). */
export function deconfuse(text: string): string {
  return text
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/5/g, 's')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
}

/** Registrierbarer Teil (vereinfachte Annahme: letzte zwei Teile, bei co.uk/com.au drei). */
export function registrable(host: string): string {
  const parts = host.split('.');
  const twoLevel = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

export type Signal = 'brand' | 'punycode' | 'insecure_password';

/** Hinweise für eine Seite. */
export function signals(host: string, protocol: string, hasPassword: boolean): Signal[] {
  const out: Signal[] = [];
  const reg = registrable(host);
  const plain = deconfuse(host.replace(/[-.]/g, ' '));
  for (const [brand, real] of Object.entries(BRANDS)) {
    const isReal = real.some((r) => host === r || host.endsWith(`.${r}`));
    if (!isReal && plain.split(' ').some((w) => w.includes(brand)) && !real.includes(reg)) {
      out.push('brand');
      break;
    }
  }
  if (host.split('.').some((l) => l.startsWith('xn--'))) {
    out.push('punycode');
  }
  if (hasPassword && protocol === 'http:') {
    out.push('insecure_password');
  }
  return out;
}
