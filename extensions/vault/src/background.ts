/**
 * Hintergrund: einzige Stelle, die mit AEGIS spricht (Native Messaging, Host
 * „com.aegis.vault“). Er nimmt nur Anfragen unseres Inhaltsskripts aus dem Hauptrahmen an und
 * setzt die Seitenadresse selbst aus dem Absender ein. Er speichert nichts dauerhaft: Ein eben
 * abgeschickter Login wartet nur im Speicher (höchstens 2 Minuten, je Tab) auf „Speichern?“;
 * vorher erfährt AEGIS nur den SHA-256 des Passworts (um „schon gespeichert“ zu erkennen).
 */

import {
  nativeErrorCode,
  pageOrigin,
  parseHostResponse,
  parsePageRequest,
  sameSite,
  type HostResponse,
  type PageRequest,
} from './lib/messages';

const HOST = 'com.aegis.vault';
const PENDING_MS = 120_000;

interface Waiting {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly id: string | null;
  readonly state: 'new' | 'update' | 'locked';
  readonly at: number;
}

/** Abgeschickte Logins je Tab (nur im Speicher). */
const waiting = new Map<number, Waiting>();
/** Laufende Prüfungen je Tab: Die Folgeseite fragt oft schon, bevor AEGIS geantwortet hat. */
const checking = new Map<number, Promise<object>>();

chrome.tabs.onRemoved.addListener((tabId) => waiting.delete(tabId));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function current(tabId: number): Waiting | null {
  const w = waiting.get(tabId);
  if (w === undefined || Date.now() - w.at > PENDING_MS) {
    waiting.delete(tabId);
    return null;
  }
  return w;
}

async function submitted(
  tabId: number,
  origin: string,
  username: string,
  password: string,
): Promise<object> {
  const check = await ask({
    type: 'check',
    origin,
    username,
    password_sha256: await sha256Hex(password),
  });
  const base = { origin, username, password, at: Date.now() };
  if (check.type === 'check' && check.state !== 'same') {
    waiting.set(tabId, { ...base, id: check.id, state: check.state });
  } else if (check.type === 'error' && check.code === 'locked') {
    waiting.set(tabId, { ...base, id: null, state: 'locked' });
  } else {
    waiting.delete(tabId);
  }
  return { type: 'ok' };
}

async function pageRequest(tabId: number, origin: string, request: PageRequest): Promise<object> {
  switch (request.type) {
    case 'logins':
      return ask({ type: 'logins', origin });
    case 'fill':
      return ask({ type: 'fill', id: request.id, origin });
    case 'submitted': {
      const running = submitted(tabId, origin, request.username, request.password);
      checking.set(tabId, running);
      try {
        return await running;
      } finally {
        if (checking.get(tabId) === running) {
          checking.delete(tabId);
        }
      }
    }
    case 'pending': {
      await checking.get(tabId)?.catch(() => undefined);
      const w = current(tabId);
      const host = w === null ? '' : new URL(w.origin).host;
      // Nur auf derselben Website fragen (nach der Anmeldung oft eine andere Unteradresse).
      return w === null || !sameSite(new URL(origin).hostname, new URL(w.origin).hostname)
        ? { type: 'none' }
        : { type: 'pending', host, username: w.username, state: w.state };
    }
    case 'save-pending': {
      const w = current(tabId);
      if (w === null) {
        return { type: 'error', code: 'invalid' };
      }
      const answer = await ask({
        type: 'save',
        origin: w.origin,
        username: w.username,
        password: w.password,
        id: w.id,
      });
      // Gesperrt: Der Nutzer kann entsperren und erneut „Speichern“ wählen.
      if (!(answer.type === 'error' && answer.code === 'locked')) {
        waiting.delete(tabId);
      }
      return answer;
    }
    case 'dismiss-pending':
      waiting.delete(tabId);
      return { type: 'ok' };
  }
}

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
  const tabId = sender.tab?.id;
  if (origin === null || request === null || tabId === undefined) {
    return false;
  }
  void pageRequest(tabId, origin, request).then(sendResponse);
  return true;
});
