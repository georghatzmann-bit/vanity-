/**
 * Hintergrund: einzige Stelle, die mit AEGIS spricht (Native Messaging, Host
 * „com.aegis.vault“). Er nimmt nur Anfragen unseres Inhaltsskripts aus dem Hauptrahmen an und
 * setzt die Seitenadresse selbst aus dem Absender ein. Er speichert nichts.
 */

import {
  nativeErrorCode,
  pageOrigin,
  parseHostResponse,
  parsePageRequest,
  type HostResponse,
} from './lib/messages';

const HOST = 'com.aegis.vault';

async function ask(message: object): Promise<HostResponse> {
  try {
    return parseHostResponse(await chrome.runtime.sendNativeMessage(HOST, message));
  } catch (e) {
    return { type: 'error', code: nativeErrorCode(e instanceof Error ? e.message : String(e)) };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const origin = pageOrigin(sender, chrome.runtime.id);
  const request = parsePageRequest(message);
  if (origin === null || request === null) {
    return false;
  }
  const forward =
    request.type === 'logins'
      ? { type: 'logins', origin }
      : { type: 'fill', id: request.id, origin };
  void ask(forward).then(sendResponse);
  return true;
});
