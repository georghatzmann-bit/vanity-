'use strict';
// openExternal with a scheme allowlist (renderer input is untrusted).
const { shell } = require('electron');

const ALLOWED = new Set([
  'https:',
  'http:',
  'steam:',
  'com.epicgames.launcher:',
  'battlenet:',
  'uplay:',
  'goggalaxy:',
  'origin2:',
  'ms-windows-store:',
  'ms-settings:',
]);

function isAllowedUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    return ALLOWED.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function openExternalSafe(url) {
  if (!isAllowedUrl(url)) throw new Error('Dieser Link ist nicht erlaubt.');
  await shell.openExternal(url);
  return true;
}

module.exports = { openExternalSafe, isAllowedUrl, ALLOWED };
