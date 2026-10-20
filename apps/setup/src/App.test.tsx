import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import {
  megabytes,
  parseInfo,
  parseOffer,
  parseProgress,
  type Info,
  type Offer,
  type Progress,
  type SetupApi,
} from './api.ts';
import { lang } from './texts.ts';

const info: Info = {
  version: '0.1.0',
  enabled: true,
  defaultDir: 'C:\\Program Files\\AEGIS Suite',
  windows: true,
  offline: false,
  components: [],
};

const offer: Offer = {
  version: '0.2.0',
  published: '2026-10-20',
  notes: 'Neu: <b>Browser</b>',
  components: [
    { kind: 'app', name: 'AEGIS-Suite-0.2.0-x64-setup.exe', size: 12 * 1024 * 1024 },
    { kind: 'browser', name: 'AEGIS-Browser-0.2.0-x64-setup.exe', size: 6 * 1024 * 1024 },
  ],
};

function fakeApi(overrides: Partial<Info> = {}) {
  let emit: ((p: Progress) => void) | null = null;
  const api = {
    info: vi.fn(() => Promise.resolve({ ...info, ...overrides })),
    check: vi.fn(() => Promise.resolve(offer)),
    download: vi.fn((browser: boolean) => {
      void browser;
      emit?.({ name: 'AEGIS-Suite-0.2.0-x64-setup.exe', done: 6, total: 12, stage: 'download' });
      return Promise.resolve();
    }),
    install: vi.fn((browser: boolean) => {
      void browser;
      return Promise.resolve();
    }),
    launch: vi.fn(() => Promise.resolve()),
    onProgress: vi.fn((listener: (p: Progress) => void) => {
      emit = listener;
      return Promise.resolve(() => undefined);
    }),
  } satisfies SetupApi;
  return api;
}

async function toOptions() {
  fireEvent.click(await screen.findByRole('button', { name: 'Los geht’s' }));
  expect(await screen.findByText(/Keine Telemetrie/)).toBeTruthy();
  expect(screen.getByText(/SmartScreen/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
}

describe('Setup-Assistent', () => {
  it('lädt und installiert nur nach den jeweiligen Klicks', async () => {
    const api = fakeApi();
    render(<App api={api} lang="de" />);
    await toOptions();
    // Fester Ordner unter „Programme“ – keine Auswahl.
    await waitFor(() =>
      expect(screen.getByTestId('install-dir')).toHaveTextContent('C:\\Program Files\\AEGIS Suite'),
    );
    expect(screen.queryByRole('button', { name: /Ändern/ })).toBeNull();
    // Kein Netz von selbst.
    expect(api.check).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Laden und prüfen' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Neueste Version suchen' }));
    const found = await screen.findByTestId('offer');
    expect(found).toHaveTextContent('Version 0.2.0');
    expect(found).toHaveTextContent('veröffentlicht am 2026-10-20 (signiert)');
    // Hinweise der Angaben nur als Text.
    expect(found.querySelector('b')).toBeNull();
    expect(found).toHaveTextContent('12,0 MB');
    fireEvent.click(within(found).getByRole('switch', { name: /AEGIS Browser/ }));
    expect(api.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Laden und prüfen' }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith(true));
    const install = await screen.findByRole('button', { name: 'Installieren' });
    expect(screen.getByText('Alles geladen und geprüft.')).toBeTruthy();
    expect(api.install).not.toHaveBeenCalled();
    fireEvent.click(install);
    await waitFor(() => expect(api.install).toHaveBeenCalledWith(true));
    expect(await screen.findByText('AEGIS ist installiert')).toBeTruthy();
    expect(api.launch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'AEGIS starten' }));
    await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  });

  it('Offline-Setup: alles eingebettet, kein Netz, Installieren startet sofort', async () => {
    const api = fakeApi({
      enabled: false,
      offline: true,
      components: offer.components,
    });
    render(<App api={api} lang="de" />);
    await toOptions();
    expect(await screen.findByTestId('offline')).toHaveTextContent('enthält bereits alles');
    // Kein Hinweis auf fehlenden Schlüssel, keine Suche, kein Download.
    expect(screen.queryByTestId('disabled')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Neueste Version suchen' })).toBeNull();
    const found = screen.getByTestId('offer');
    expect(found).toHaveTextContent('Version 0.1.0');
    fireEvent.click(within(found).getByRole('switch', { name: /AEGIS Browser/ }));
    expect(api.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Installieren' }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith(true));
    expect(await screen.findByText('AEGIS ist installiert')).toBeTruthy();
    expect(api.check).not.toHaveBeenCalled();
    expect(api.download).not.toHaveBeenCalled();
  });

  it('ohne Signaturschlüssel lädt das Setup nichts und sagt das', async () => {
    const api = fakeApi({ enabled: false });
    render(<App api={api} lang="de" />);
    await toOptions();
    expect(await screen.findByTestId('disabled')).toHaveTextContent('ohne Signaturschlüssel');
    expect(screen.getByRole('button', { name: 'Neueste Version suchen' })).toBeDisabled();
  });

  it('zeigt Fehler ehrlich und bietet einen neuen Versuch', async () => {
    const api = fakeApi();
    api.download.mockImplementationOnce(() => Promise.reject(new Error('Prüfsumme passt nicht')));
    render(<App api={api} lang="de" />);
    await toOptions();
    fireEvent.click(await screen.findByRole('button', { name: 'Neueste Version suchen' }));
    await screen.findByTestId('offer');
    fireEvent.click(screen.getByRole('button', { name: 'Laden und prüfen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Prüfsumme passt nicht');
    expect(screen.queryByRole('button', { name: 'Installieren' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByTestId('offer')).toBeTruthy();
    expect(api.install).not.toHaveBeenCalled();
  });

  it('prüft Antworten streng', () => {
    expect(lang(['de-CH'])).toBe('de');
    expect(lang(['fr-FR'])).toBe('en');
    expect(parseInfo(null)).toEqual({
      version: '',
      enabled: false,
      defaultDir: '',
      windows: false,
      offline: false,
      components: [],
    });
    const o = parseOffer({
      version: '1.0.0',
      published: '2026-10-20<b>',
      components: [
        { kind: 'evil', name: 'x', size: 1 },
        { kind: 'browser', name: 'b', size: -5 },
      ],
    });
    expect(o.components).toEqual([{ kind: 'browser', name: 'b', size: 0 }]);
    expect(o.published).toBe('');
    expect(parseProgress({ stage: 'boom', done: 'x' })).toEqual({
      name: '',
      done: 0,
      total: 0,
      stage: 'download',
    });
    expect(megabytes(1536 * 1024, 'en')).toBe('1.5 MB');
  });
});
