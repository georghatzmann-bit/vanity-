'use strict';
// Nur diese Webseiten darf der Konto-Retter im Browser öffnen.
// Schutz davor, dass jemals ein fremder oder gefälschter Link geöffnet wird.

const ALLOWED_HOSTS = [
  'epicgames.com',
  'fortnite.com',
  'unrealengine.com',
  // E-Mail-Anbieter (Schritt "E-Mail-Postfach sichern")
  'google.com',
  'live.com',
  'microsoft.com',
  'outlook.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  't-online.de',
  'apple.com',
  'icloud.com',
  'yahoo.com',
  'proton.me',
  // Plattformen, die mit Epic verbunden sein können
  'playstation.com',
  'xbox.com',
  'nintendo.com',
  'nintendo.de',
  'steampowered.com',
  'discord.com',
  // Prüfen, ob die E-Mail in Datenlecks auftaucht
  'haveibeenpwned.com',
];

function isAllowedUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

module.exports = { isAllowedUrl, ALLOWED_HOSTS };
