import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHashRouter, type HashRouter } from './hashRouter.ts';
import { DEFAULT_ROUTE, hashFor, isRouteId, parseHash, routeIds, routePhases } from './routes.ts';

describe('routes', () => {
  it('liest gültige Hash-Adressen (auch mit Schrägstrich am Ende, Groß-/Kleinschreibung egal)', () => {
    expect(parseHash('#/dashboard')).toBe('dashboard');
    expect(parseHash('#/scan/')).toBe('scan');
    expect(parseHash('#/Settings')).toBe('settings');
    expect(parseHash('  #/about  ')).toBe('about');
  });

  it('lehnt Leeres, Unbekanntes und Fremdes ab', () => {
    for (const hash of [
      '',
      '#',
      '#/',
      '#/unbekannt',
      '#scan',
      '/scan',
      '#/scan?x=1',
      '#/scan/extra',
      '#/constructor',
      '#/__proto__',
      'javascript:alert(1)',
    ]) {
      expect(parseHash(hash), hash).toBeNull();
    }
  });

  it('bildet jede Seite hin und zurück ab', () => {
    for (const route of routeIds) {
      expect(parseHash(hashFor(route))).toBe(route);
      expect(isRouteId(route)).toBe(true);
    }
    expect(isRouteId('toString')).toBe(false);
  });

  it('kennt die zwölf Seiten und die Phasen der fehlenden Module (docs/PROGRESS.md)', () => {
    expect(routeIds).toHaveLength(12);
    expect(routePhases).toEqual({
      reports: 'P3',
      lab: 'P4',
      hardening: 'P6',
      network: 'P7',
      vault: 'P9',
      tools: 'P10',
    });
    // Dashboard, Einstellungen und „Über AEGIS“ gibt es schon – ohne Phase.
    for (const route of ['dashboard', 'settings', 'about'] as const) {
      expect(routePhases[route]).toBeUndefined();
    }
  });
});

describe('createHashRouter', () => {
  let router: HashRouter | undefined;

  afterEach(() => {
    router?.dispose();
    router = undefined;
    window.history.replaceState(null, '', '#');
  });

  function start(hash: string): HashRouter {
    window.history.replaceState(null, '', hash === '' ? window.location.pathname : hash);
    router = createHashRouter(window);
    return router;
  }

  it('startet auf der Seite aus der Adresse', () => {
    expect(start('#/vault').getSnapshot()).toBe('vault');
  });

  it('leitet leere oder unbekannte Adressen ohne neuen Historien-Eintrag aufs Dashboard', () => {
    const length = window.history.length;
    expect(start('#/gibt-es-nicht').getSnapshot()).toBe(DEFAULT_ROUTE);
    expect(window.location.hash).toBe('#/dashboard');
    expect(window.history.length).toBe(length);

    router?.dispose();
    expect(start('').getSnapshot()).toBe(DEFAULT_ROUTE);
    expect(window.location.hash).toBe('#/dashboard');
  });

  it('wechselt per navigate (neuer Historien-Eintrag) und meldet den Wechsel', async () => {
    const current = start('#/dashboard');
    const listener = vi.fn();
    current.subscribe(listener);

    current.navigate('scan');
    await vi.waitFor(() => expect(current.getSnapshot()).toBe('scan'));
    expect(window.location.hash).toBe('#/scan');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ersetzt mit replace den Eintrag und meldet sofort', () => {
    const current = start('#/dashboard');
    const listener = vi.fn();
    current.subscribe(listener);
    const length = window.history.length;

    current.navigate('settings', { replace: true });
    expect(current.getSnapshot()).toBe('settings');
    expect(window.location.hash).toBe('#/settings');
    expect(window.history.length).toBe(length);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignoriert den Wechsel auf die aktuelle Seite', () => {
    const current = start('#/about');
    const listener = vi.fn();
    current.subscribe(listener);
    current.navigate('about');
    expect(listener).not.toHaveBeenCalled();
  });

  it('folgt Adressänderungen von außen (Zurück/Vor, Links) und repariert ungültige', async () => {
    const current = start('#/dashboard');
    window.location.hash = '#/network';
    await vi.waitFor(() => expect(current.getSnapshot()).toBe('network'));

    window.location.hash = '#/kaputt';
    await vi.waitFor(() => expect(current.getSnapshot()).toBe('dashboard'));
    expect(window.location.hash).toBe('#/dashboard');
  });

  it('meldet nach dispose nichts mehr; Abmelden einzelner Empfänger wirkt', async () => {
    const current = start('#/dashboard');
    const kept = vi.fn();
    const removed = vi.fn();
    current.subscribe(kept);
    const unsubscribe = current.subscribe(removed);
    unsubscribe();

    current.navigate('tools');
    await vi.waitFor(() => expect(kept).toHaveBeenCalledTimes(1));
    expect(removed).not.toHaveBeenCalled();

    current.dispose();
    window.location.hash = '#/lab';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(current.getSnapshot()).toBe('tools');
  });
});
