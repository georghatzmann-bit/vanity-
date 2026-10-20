/**
 * Nachrichten zwischen Seite, Hintergrund und AEGIS. Die Adresse einer Anfrage kommt immer vom
 * Browser (Absender des Inhaltsskripts im Hauptrahmen), nie aus dem Nachrichteninhalt – eine
 * Webseite kann so keine Logins einer anderen Seite anfordern.
 */

/** Ein Login ohne Passwort. */
export interface Login {
  readonly id: string;
  readonly title: string;
  readonly username: string;
}

/** Fehlerkennungen, die die Erweiterung unterscheidet. */
export type ErrorCode =
  | 'locked'
  | 'app_not_running'
  | 'host_missing'
  | 'forbidden'
  | 'rate_limited'
  | 'no_match'
  | 'invalid';

/** Antwort von AEGIS (über den Native-Messaging-Host), geprüft. */
export type HostResponse =
  | { readonly type: 'status'; readonly unlocked: boolean }
  | { readonly type: 'check'; readonly state: CheckState; readonly id: string | null }
  | { readonly type: 'saved'; readonly updated: boolean }
  | { readonly type: 'logins'; readonly logins: readonly Login[] }
  | { readonly type: 'fill'; readonly username: string; readonly password: string }
  | { readonly type: 'error'; readonly code: ErrorCode };

/** Ergebnis der Prüfung vor dem Speichern. */
export type CheckState = 'new' | 'update' | 'same';

/** Anfragen des Inhaltsskripts an den Hintergrund (ohne Adresse!). */
export type PageRequest =
  | { readonly type: 'logins' }
  | { readonly type: 'fill'; readonly id: string }
  | { readonly type: 'submitted'; readonly username: string; readonly password: string }
  | { readonly type: 'pending' }
  | { readonly type: 'save-pending' }
  | { readonly type: 'dismiss-pending' };

/** Ein Login, der auf „Speichern?“ wartet (ohne Passwort). */
export interface Pending {
  readonly host: string;
  readonly username: string;
  readonly state: 'new' | 'update' | 'locked';
}

/** Antwort des Hintergrunds auf `pending`. */
export function parsePending(v: unknown): Pending | null {
  if (!isRecord(v) || v.type !== 'pending' || !text(v.host, 260) || !text(v.username)) {
    return null;
  }
  const state = v.state;
  return state === 'new' || state === 'update' || state === 'locked'
    ? { host: v.host, username: v.username, state }
    : null;
}

/** Ungefähr dieselbe Website (gleiche letzte zwei Namensteile bzw. gleicher Host)? */
export function sameSite(a: string, b: string): boolean {
  const tail = (h: string) => h.split('.').slice(-2).join('.');
  return a === b || (a.includes('.') && b.includes('.') && tail(a) === tail(b));
}

/** Anfragen des Popups an das Inhaltsskript des aktiven Tabs. */
export type PopupRequest =
  { readonly type: 'popup-logins' } | { readonly type: 'popup-fill'; readonly id: string };

/** Antwort des Inhaltsskripts an das Popup. */
export type PopupAnswer =
  | { readonly type: 'logins'; readonly origin: string; readonly logins: readonly Login[] }
  | { readonly type: 'filled' }
  | { readonly type: 'no_field' }
  | { readonly type: 'error'; readonly code: ErrorCode };

const MAX_LOGINS = 20;
const MAX_TEXT = 512;
const CODES: readonly ErrorCode[] = [
  'locked',
  'app_not_running',
  'host_missing',
  'forbidden',
  'rate_limited',
  'no_match',
  'invalid',
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `https://host[:port]` einer Seitenadresse – nur http(s), sonst `null`. */
export function originOf(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Absender, wie ihn der Browser meldet (Teil von `chrome.runtime.MessageSender`). */
export interface Sender {
  readonly id?: string | undefined;
  readonly frameId?: number | undefined;
  readonly origin?: string | undefined;
  readonly url?: string | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
}

/**
 * Adresse der Seite, wenn die Nachricht von unserem Inhaltsskript im Hauptrahmen eines Tabs
 * stammt; sonst `null`. Herkunft und Adresse müssen übereinstimmen.
 */
export function pageOrigin(sender: Sender, extensionId: string): string | null {
  if (sender.id !== extensionId || sender.frameId !== 0 || sender.tab?.id === undefined) {
    return null;
  }
  const fromUrl = originOf(sender.url);
  if (fromUrl === null) {
    return null;
  }
  if (sender.origin !== undefined && sender.origin !== fromUrl) {
    return null;
  }
  return fromUrl;
}

/** Prüft eine Anfrage des Inhaltsskripts. */
export function parsePageRequest(v: unknown): PageRequest | null {
  if (!isRecord(v)) {
    return null;
  }
  if (v.type === 'logins' && Object.keys(v).length === 1) {
    return { type: 'logins' };
  }
  if (v.type === 'fill' && Object.keys(v).length === 2 && text(v.id, 64) && ID.test(v.id)) {
    return { type: 'fill', id: v.id };
  }
  if (
    v.type === 'submitted' &&
    Object.keys(v).length === 3 &&
    text(v.username, 1024) &&
    text(v.password, 1024) &&
    v.password !== ''
  ) {
    return { type: 'submitted', username: v.username, password: v.password };
  }
  if (
    (v.type === 'pending' || v.type === 'save-pending' || v.type === 'dismiss-pending') &&
    Object.keys(v).length === 1
  ) {
    return { type: v.type };
  }
  return null;
}

/** Prüft eine Anfrage des Popups. */
export function parsePopupRequest(v: unknown): PopupRequest | null {
  if (!isRecord(v)) {
    return null;
  }
  if (v.type === 'popup-logins' && Object.keys(v).length === 1) {
    return { type: 'popup-logins' };
  }
  if (v.type === 'popup-fill' && Object.keys(v).length === 2 && text(v.id, 64) && ID.test(v.id)) {
    return { type: 'popup-fill', id: v.id };
  }
  return null;
}

function parseLogin(v: unknown): Login | null {
  if (!isRecord(v) || !text(v.id, 64) || !ID.test(v.id) || !text(v.title) || !text(v.username)) {
    return null;
  }
  return { id: v.id, title: v.title, username: v.username };
}

/** Prüft eine Antwort von AEGIS; Unbekanntes wird zu `invalid`. */
export function parseHostResponse(v: unknown): HostResponse {
  const invalid: HostResponse = { type: 'error', code: 'invalid' };
  if (!isRecord(v)) {
    return invalid;
  }
  switch (v.type) {
    case 'status':
      return typeof v.unlocked === 'boolean' ? { type: 'status', unlocked: v.unlocked } : invalid;
    case 'logins': {
      if (!Array.isArray(v.logins) || v.logins.length > MAX_LOGINS) {
        return invalid;
      }
      const logins = v.logins.map(parseLogin);
      return logins.every((l): l is Login => l !== null) ? { type: 'logins', logins } : invalid;
    }
    case 'fill':
      return text(v.username) && text(v.password, 4096)
        ? { type: 'fill', username: v.username, password: v.password }
        : invalid;
    case 'check': {
      const state = v.state;
      const id = v.id === null || v.id === undefined ? null : v.id;
      if (
        (state === 'new' || state === 'update' || state === 'same') &&
        (id === null || (text(id, 64) && ID.test(id)))
      ) {
        return { type: 'check', state, id };
      }
      return invalid;
    }
    case 'saved':
      return typeof v.updated === 'boolean' ? { type: 'saved', updated: v.updated } : invalid;
    case 'locked':
      return { type: 'error', code: 'locked' };
    case 'error':
      return typeof v.code === 'string' && (CODES as readonly string[]).includes(v.code)
        ? { type: 'error', code: v.code as ErrorCode }
        : invalid;
    default:
      return invalid;
  }
}

/** Fehler von `sendNativeMessage` → Kennung. */
export function nativeErrorCode(message: string): ErrorCode {
  // Chrome/Edge: „Specified native messaging host not found.“ bzw. „Access to the specified
  // native messaging host is forbidden.“
  if (/not found/i.test(message)) {
    return 'host_missing';
  }
  if (/forbidden/i.test(message)) {
    return 'forbidden';
  }
  return 'app_not_running';
}
