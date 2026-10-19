/**
 * Scan- und Quarantäne-Seite mit nachgebildetem Dienst: Die Oberfläche schlägt nur vor und
 * reicht die Antwort aus dem Freigabe-Dialog weiter – ohne „Ja“ geht keine Ausführung raus.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, ServiceApi, WatchState } from '../platform/service.ts';
import { disposeApps, fakePlatform, renderApp } from '../test/harness.tsx';

const finding = {
  path: '/home/x/Downloads/eicar.com',
  sha256: 'ab',
  size: 68,
  risk: 'dangerous' as const,
  confidence: 95,
  category: 'test_file',
  summaryDe: 'Das ist die EICAR-Testdatei – harmlos, aber jeder Virenscanner soll sie melden.',
  summaryEn: 'This is the EICAR test file.',
  recommendation: 'quarantine' as const,
  reasons: [{ code: 'eicar', de: 'Enthält die EICAR-Prüfzeichenkette.', en: 'Contains EICAR.' }],
  notScannable: null,
  contained: [
    {
      name: 'paket.zip/eicar.com',
      risk: 'dangerous' as const,
      summaryDe: 'Das ist die EICAR-Testdatei.',
      summaryEn: 'This is the EICAR test file.',
    },
  ],
  trusted: null,
};

function proposal(kind = 'In die Quarantäne verschieben'): Proposal {
  return {
    digest: 'd'.repeat(64),
    nonce: 'n'.repeat(32),
    plan: {
      id: '11111111-1111-4111-8111-111111111111',
      digest: 'd'.repeat(64),
      kindLabel: kind,
      severity: 'dangerous',
      targets: [{ type: 'file', path: finding.path }],
      what: '1 Datei in die Quarantäne verschieben: eicar.com',
      why: finding.summaryDe,
      consequence: 'Die Datei wird verschlüsselt verschoben.',
      undo: { type: 'reversible', how: 'Quarantäne → Wiederherstellen' },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  };
}

function watchState(events: WatchState['events'] = []): WatchState {
  return {
    events,
    active: true,
    folders: ['C:\\Users\\a\\Downloads'],
    processes: true,
    gaming: false,
    gamingLeft: null,
    pending: 0,
    dropped: 0,
    note: null,
  };
}

function fakeService(overrides: Partial<ServiceApi> = {}): ServiceApi {
  return {
    scan: vi.fn(() => Promise.resolve({ findings: [finding], skipped: [], truncated: false })),
    listQuarantine: vi.fn(() => Promise.resolve([])),
    proposeQuarantine: vi.fn(() => Promise.resolve(proposal())),
    proposeRestore: vi.fn(() => Promise.resolve(proposal('Aus der Quarantäne wiederherstellen'))),
    proposeDelete: vi.fn(() => Promise.resolve(proposal('Endgültig löschen'))),
    decide: vi.fn(() => Promise.resolve({ kind: 'nothing' as const })),
    confirmSecond: vi.fn(() => Promise.resolve({ kind: 'nothing' as const })),
    listTrust: vi.fn(() => Promise.resolve([])),
    revokeTrust: vi.fn(() => Promise.resolve()),
    watchPoll: vi.fn(() => Promise.resolve(watchState())),
    setGaming: vi.fn((on: boolean) =>
      Promise.resolve({ ...watchState(), gaming: on, gamingLeft: on ? 14_400 : null }),
    ),
    ...overrides,
  };
}

afterEach(() => {
  disposeApps();
});

describe('Scan-Seite', () => {
  it('Vorschau ohne Dienst: ehrlicher Hinweis, keine Knöpfe', async () => {
    renderApp({ platform: fakePlatform('browser'), hash: '#/scan' });
    expect(await screen.findByTestId('service-preview')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ordner wählen/ })).toBeNull();
  });

  it('prüft, erklärt und schlägt Isolieren vor – „Nein“ schickt nur decline', async () => {
    const service = fakeService();
    renderApp({
      platform: fakePlatform('tauri', undefined, service, ['/home/x/Downloads']),
      hash: '#/scan',
    });
    fireEvent.click(await screen.findByRole('button', { name: /Ordner wählen/ }));
    expect(await screen.findByTestId('scan-summary')).toHaveTextContent(
      '1 Dateien geprüft · 1 auffällig',
    );
    expect(service.scan).toHaveBeenCalledWith(['/home/x/Downloads']);
    const row = screen.getByTestId('finding');
    fireEvent.click(within(row).getByRole('button', { name: 'Warum?' }));
    expect(within(row).getByText('Enthält die EICAR-Prüfzeichenkette.')).toBeInTheDocument();
    const contained = within(row).getByTestId('contained');
    expect(contained).toHaveTextContent('Auffällige Inhalte');
    expect(contained).toHaveTextContent('paket.zip/eicar.com');

    fireEvent.click(within(row).getByRole('button', { name: /Isolieren/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getAllByText(/eicar\.com/).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nein' }));
    await waitFor(() => expect(service.decide).toHaveBeenCalledTimes(1));
    expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('decline');
    expect((await screen.findAllByText('Es wurde nichts verändert.')).length).toBeGreaterThan(0);
  });

  it('Dienst nicht erreichbar: Hinweis statt Ergebnis', async () => {
    const service = fakeService({
      scan: vi.fn(() => Promise.reject(new Error('nicht erreichbar'))),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service, ['/x']), hash: '#/scan' });
    fireEvent.click(await screen.findByRole('button', { name: /Dateien wählen/ }));
    expect(await screen.findByTestId('service-down')).toBeInTheDocument();
  });
});

describe('Quarantäne-Seite', () => {
  const entry = {
    id: '22222222-2222-4222-8222-222222222222',
    originalPath: '/home/x/Downloads/eicar.com',
    sha256: 'ab',
    size: 68,
    quarantinedAt: '2026-10-19T10:00:00Z',
    reason: 'EICAR-Testdatei in die Quarantäne verschieben',
  };

  it('leer: ehrliche Meldung', async () => {
    renderApp({ platform: fakePlatform('tauri', undefined, fakeService()), hash: '#/quarantine' });
    expect(await screen.findByTestId('vault-empty')).toBeInTheDocument();
  });

  it('Löschen: nach erstem „Ja“ kommt die zweite Bestätigung, erst dann confirmSecond', async () => {
    const service = fakeService({
      listQuarantine: vi.fn(() => Promise.resolve([entry])),
      decide: vi.fn(() =>
        Promise.resolve({
          kind: 'second' as const,
          challenge: {
            challengeId: 'c1',
            notBefore: new Date(Date.now() + 1_500).toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            nonce: 'm'.repeat(32),
          },
        }),
      ),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/quarantine' });
    fireEvent.click(await screen.findByRole('button', { name: /Endgültig löschen/ }));
    const first = await screen.findByRole('alertdialog');
    const yes = within(first).getByRole('button', { name: 'Ja, ausführen' });
    // Sperrzeit des Dialogs abwarten (600 ms), dann bewusst „Ja“.
    await act(() => new Promise((r) => setTimeout(r, 700)));
    fireEvent.click(yes);
    await waitFor(() => expect(service.decide).toHaveBeenCalledTimes(1));
    expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('execute');
    const second = await screen.findByRole('alertdialog');
    expect(within(second).getByText(/kann nicht rückgängig gemacht werden/i)).toBeInTheDocument();
    expect(service.confirmSecond).not.toHaveBeenCalled();
    fireEvent.click(within(second).getByRole('button', { name: /Abbrechen/ }));
    await waitFor(() => expect(service.confirmSecond).toHaveBeenCalledTimes(1));
    expect(vi.mocked(service.confirmSecond).mock.calls[0]?.[1]).toBe('decline');
  });
});

describe('Vertrauensliste', () => {
  it('zeigt vertraute Dateien und widerruft nur auf Klick', async () => {
    const entry = {
      id: 't1',
      sha256: 'ab'.repeat(32),
      path: '/home/x/Spiele/trainer.exe',
      reason: 'Ein Spiel-Tool (z. B. Trainer oder Mod-Menü).',
      createdAt: '2026-10-19T10:00:00Z',
    };
    const listTrust = vi
      .fn<ServiceApi['listTrust']>()
      .mockResolvedValueOnce([entry])
      .mockResolvedValue([]);
    const service = fakeService({ listTrust });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/quarantine' });
    const row = await screen.findByTestId('trust-entry');
    expect(row).toHaveTextContent('trainer.exe');
    expect(service.revokeTrust).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Widerrufen' }));
    await waitFor(() => expect(service.revokeTrust).toHaveBeenCalledWith('t1'));
    expect(await screen.findByTestId('trust-empty')).toBeInTheDocument();
  });

  it('Scan zeigt „Vertraut“ ohne die Stufe zu verstecken', async () => {
    const trustedFinding = {
      ...finding,
      risk: 'game' as const,
      recommendation: 'none' as const,
      trusted: { id: 't1', reason: 'x', since: '2026-10-19T10:00:00Z' },
    };
    const service = fakeService({
      scan: vi.fn(() =>
        Promise.resolve({ findings: [trustedFinding], skipped: [], truncated: false }),
      ),
    });
    renderApp({
      platform: fakePlatform('tauri', undefined, service, ['/home/x']),
      hash: '#/scan',
    });
    fireEvent.click(await screen.findByRole('button', { name: /Ordner wählen/ }));
    expect(await screen.findByTestId('trusted')).toHaveTextContent('Vertraut seit 2026-10-19');
    expect(
      within(screen.getByTestId('finding')).queryByRole('button', { name: /Isolieren/ }),
    ).toBeNull();
  });
});

describe('Echtzeit-Wächter', () => {
  const event = {
    seq: 7,
    at: '2026-10-19T10:00:00Z',
    kind: 'file' as const,
    path: finding.path,
    finding,
  };

  it('Vorschau ohne Dienst: ehrlicher Hinweis', async () => {
    renderApp({ platform: fakePlatform('browser'), hash: '#/realtime' });
    expect(await screen.findByTestId('service-preview')).toBeInTheDocument();
  });

  it('zeigt Meldungen; Isolieren nur über den Freigabe-Dialog, Ignorieren blendet nur aus', async () => {
    const service = fakeService({ watchPoll: vi.fn(() => Promise.resolve(watchState([event]))) });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const row = await screen.findByTestId('watch-event');
    expect(row).toHaveTextContent('eicar.com');
    expect(row).toHaveTextContent('Neue oder geänderte Datei');
    expect(screen.getByTestId('watch-status')).toHaveTextContent('Wächter läuft.');
    fireEvent.click(within(row).getByRole('button', { name: 'Mehr Infos' }));
    expect(within(row).getByTestId('watch-reasons')).toHaveTextContent('EICAR-Prüfzeichenkette');

    fireEvent.click(within(row).getByRole('button', { name: /Isolieren/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(service.proposeQuarantine).toHaveBeenCalledWith([finding.path]);
    expect(service.decide).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nein' }));
    await waitFor(() => expect(service.decide).toHaveBeenCalledTimes(1));
    expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('decline');

    fireEvent.click(
      within(screen.getByTestId('watch-event')).getByRole('button', { name: 'Ignorieren' }),
    );
    expect(await screen.findByTestId('watch-empty')).toBeInTheDocument();
    expect(service.decide).toHaveBeenCalledTimes(1);
  });

  it('Gaming-Modus schaltet über den Dienst und zeigt die Restzeit', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const toggle = await screen.findByRole('switch', { name: /Gaming-Modus/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(service.setGaming).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/endet in spätestens 240 Minuten/)).toBeInTheDocument();
  });

  it('Hinweis auf anderen Seiten mit „Anzeigen“ – ohne Aktion', async () => {
    const watchPoll = vi
      .fn<ServiceApi['watchPoll']>()
      .mockResolvedValueOnce(watchState([event]))
      .mockResolvedValue(watchState());
    const service = fakeService({ watchPoll });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/quarantine' });
    expect(await screen.findByText('Echtzeit-Wächter: 1 neue Meldung(en)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Anzeigen' }));
    await waitFor(() => expect(window.location.hash).toBe('#/realtime'));
    expect(service.proposeQuarantine).not.toHaveBeenCalled();
    act(() => undefined);
  });
});
