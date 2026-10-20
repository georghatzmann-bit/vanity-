import { describe, expect, it } from 'vitest';
import {
  nativeErrorCode,
  originOf,
  pageOrigin,
  parseHostResponse,
  parsePageRequest,
  parsePopupRequest,
} from './messages';

const ID = 'mfhpbiifllddbcddpanidjedgmbglhon';

describe('Adresse aus dem Absender', () => {
  const ok = { id: ID, frameId: 0, tab: { id: 3 }, url: 'https://bank.example/login?x=1' };

  it('Hauptrahmen unseres Inhaltsskripts', () => {
    expect(pageOrigin(ok, ID)).toBe('https://bank.example');
    expect(pageOrigin({ ...ok, origin: 'https://bank.example' }, ID)).toBe('https://bank.example');
    expect(pageOrigin({ ...ok, url: 'http://alt.example:8080/' }, ID)).toBe(
      'http://alt.example:8080',
    );
  });

  it('kein Unterrahmen, keine fremde Erweiterung, kein Popup, keine Sonderseiten', () => {
    expect(pageOrigin({ ...ok, frameId: 2 }, ID)).toBeNull();
    expect(pageOrigin({ ...ok, id: 'andere' }, ID)).toBeNull();
    expect(pageOrigin({ ...ok, tab: undefined }, ID)).toBeNull();
    expect(pageOrigin({ ...ok, url: 'file:///C:/x.html' }, ID)).toBeNull();
    expect(pageOrigin({ ...ok, url: 'chrome://settings' }, ID)).toBeNull();
    expect(pageOrigin({ ...ok, url: undefined }, ID)).toBeNull();
    // Widerspruch zwischen Herkunft und Adresse → abgelehnt.
    expect(pageOrigin({ ...ok, origin: 'https://evil.example' }, ID)).toBeNull();
  });

  it('originOf', () => {
    expect(originOf('https://a.example/x')).toBe('https://a.example');
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf('kaputt')).toBeNull();
  });
});

describe('Anfragen', () => {
  it('Seite: keine Adresse im Inhalt erlaubt', () => {
    expect(parsePageRequest({ type: 'logins' })).toEqual({ type: 'logins' });
    expect(parsePageRequest({ type: 'logins', origin: 'https://evil.example' })).toBeNull();
    expect(parsePageRequest({ type: 'fill', id: 'abc-1' })).toEqual({ type: 'fill', id: 'abc-1' });
    expect(parsePageRequest({ type: 'fill', id: 'abc', origin: 'https://x' })).toBeNull();
    expect(parsePageRequest({ type: 'fill', id: '../x' })).toBeNull();
    expect(parsePageRequest({ type: 'status' })).toBeNull();
    expect(parsePageRequest('logins')).toBeNull();
  });

  it('Popup', () => {
    expect(parsePopupRequest({ type: 'popup-logins' })).toEqual({ type: 'popup-logins' });
    expect(parsePopupRequest({ type: 'popup-fill', id: 'a' })).toEqual({
      type: 'popup-fill',
      id: 'a',
    });
    expect(parsePopupRequest({ type: 'popup-fill', id: '' })).toBeNull();
    expect(parsePopupRequest({ type: 'fill', id: 'a' })).toBeNull();
  });
});

describe('Antworten von AEGIS', () => {
  it('gültige', () => {
    expect(parseHostResponse({ type: 'status', unlocked: true })).toEqual({
      type: 'status',
      unlocked: true,
    });
    expect(
      parseHostResponse({ type: 'logins', logins: [{ id: 'a1', title: 'Bank', username: 'u' }] }),
    ).toEqual({ type: 'logins', logins: [{ id: 'a1', title: 'Bank', username: 'u' }] });
    expect(parseHostResponse({ type: 'fill', username: 'u', password: 'p' })).toEqual({
      type: 'fill',
      username: 'u',
      password: 'p',
    });
    expect(parseHostResponse({ type: 'locked' })).toEqual({ type: 'error', code: 'locked' });
    expect(parseHostResponse({ type: 'error', code: 'rate_limited' })).toEqual({
      type: 'error',
      code: 'rate_limited',
    });
  });

  it('ungültige werden zu invalid', () => {
    const invalid = { type: 'error', code: 'invalid' };
    expect(parseHostResponse(null)).toEqual(invalid);
    expect(parseHostResponse({ type: 'status' })).toEqual(invalid);
    expect(parseHostResponse({ type: 'error', code: 'boom' })).toEqual(invalid);
    expect(parseHostResponse({ type: 'logins', logins: [{ id: 1 }] })).toEqual(invalid);
    expect(
      parseHostResponse({
        type: 'logins',
        logins: Array.from({ length: 21 }, (_, i) => ({ id: `a${i}`, title: '', username: '' })),
      }),
    ).toEqual(invalid);
    expect(parseHostResponse({ type: 'fill', username: 'u' })).toEqual(invalid);
  });

  it('Fehler von Native Messaging', () => {
    expect(nativeErrorCode('Specified native messaging host not found.')).toBe('host_missing');
    expect(nativeErrorCode('Access to the specified native messaging host is forbidden.')).toBe(
      'forbidden',
    );
    expect(nativeErrorCode('Native host has exited.')).toBe('app_not_running');
  });
});
