/**
 * Update-Bereich (P13): ohne eingebauten Schlüssel abgeschaltet; sonst Suche nur auf Klick,
 * Laden nur nach Klick und Installation erst nach dem Bestätigungsdialog.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdatesApi, UpdateView } from '../platform/updates.ts';
import { parseUpdate } from '../platform/updates.ts';
import { disposeApps, fakePlatform, renderApp } from '../test/harness.tsx';

afterEach(disposeApps);

const base: UpdateView = {
  enabled: true,
  current: '0.1.0',
  latest: null,
  notes: '',
  newer: false,
  ready: false,
};

function fakeUpdates(enabled = true) {
  let view: UpdateView = { ...base, enabled };
  const api = {
    status: vi.fn(() => Promise.resolve(view)),
    check: vi.fn(() => {
      view = { ...view, latest: '0.2.0', newer: true, notes: 'Neu: <b>Schutz</b>' };
      return Promise.resolve(view);
    }),
    download: vi.fn(() => {
      view = { ...view, ready: true };
      return Promise.resolve(view);
    }),
    install: vi.fn(() => Promise.resolve()),
  } satisfies UpdatesApi;
  return api;
}

function renderAbout(updates: UpdatesApi) {
  return renderApp({ hash: '#/about', platform: { ...fakePlatform('tauri'), updates } });
}

describe('UpdatePanel', () => {
  it('zeigt ohne Signaturschlüssel nur den Hinweis und bietet keine Suche an', async () => {
    const updates = fakeUpdates(false);
    renderAbout(updates);
    const panel = await screen.findByTestId('update-panel');
    await within(panel).findByText(/Updates abgeschaltet/);
    expect(within(panel).queryByRole('button', { name: 'Nach Updates suchen' })).toBeNull();
    expect(updates.check).not.toHaveBeenCalled();
  });

  it('sucht, lädt und installiert nur nach Klick und Bestätigung', async () => {
    const updates = fakeUpdates();
    renderAbout(updates);
    const panel = await screen.findByTestId('update-panel');
    const check = await within(panel).findByRole('button', { name: 'Nach Updates suchen' });
    // Kein Netz von selbst.
    expect(updates.check).not.toHaveBeenCalled();
    fireEvent.click(check);
    await within(panel).findByText('Version 0.2.0 ist verfügbar (installiert: 0.1.0).');
    // Fremde Hinweise nur als Text.
    expect(within(panel).getByText('Neu: <b>Schutz</b>')).toBeTruthy();
    expect(updates.download).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Herunterladen und prüfen' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Jetzt installieren …' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(updates.install).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Jetzt installieren …' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Jetzt installieren' }),
    );
    await waitFor(() => expect(updates.install).toHaveBeenCalledTimes(1));
  });

  it('meldet aktuelle Version und Fehler', async () => {
    const updates = fakeUpdates();
    updates.check.mockImplementationOnce(() =>
      Promise.resolve({ ...base, latest: '0.1.0', newer: false }),
    );
    renderAbout(updates);
    const panel = await screen.findByTestId('update-panel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Nach Updates suchen' }));
    await within(panel).findByText('AEGIS ist aktuell (Version 0.1.0).');
    updates.check.mockImplementationOnce(() => Promise.reject(new Error('Signatur ungültig')));
    fireEvent.click(within(panel).getByRole('button', { name: 'Nach Updates suchen' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe('Signatur ungültig');
  });

  it('prüft Antworten streng', () => {
    expect(parseUpdate(null)).toEqual({
      enabled: false,
      current: '',
      latest: null,
      notes: '',
      newer: false,
      ready: false,
    });
    const v = parseUpdate({ enabled: 'ja', latest: 7, notes: 'x'.repeat(5000), newer: true });
    expect(v.enabled).toBe(false);
    expect(v.latest).toBeNull();
    expect(v.notes).toHaveLength(2000);
    expect(v.newer).toBe(true);
  });
});
