/**
 * Scan- und Quarantäne-Seite mit nachgebildetem Dienst: Die Oberfläche schlägt nur vor und
 * reicht die Antwort aus dem Freigabe-Dialog weiter – ohne „Ja“ geht keine Ausführung raus.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HistoryEntry,
  LabReport,
  LabRun,
  LabState,
  SafeState,
  RansomState,
  BackupState,
  HardeningState,
  PersistenceState,
  EmergencyResult,
  Proposal,
  ScheduleState,
  ServiceApi,
  WatchState,
} from '../platform/service.ts';
import { toLocalHour, toUtcHour } from './SchedulePanel.tsx';
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
    allowTrust: kind === 'In die Quarantäne verschieben',
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
    history: vi.fn(() => Promise.resolve({ entries: [], saveFailed: false })),
    getSchedule: vi.fn(() => Promise.resolve(scheduleState())),
    setSchedule: vi.fn((enabled: boolean, everyDays: 1 | 7 | 30, hourUtc: number) =>
      Promise.resolve(scheduleState({ schedule: { enabled, everyDays, hourUtc, lastRun: null } })),
    ),
    setClamavUpdate: vi.fn((on: boolean) => Promise.resolve(scheduleState({ clamavUpdate: on }))),
    exportReport: vi.fn(() => Promise.resolve('/home/x/AEGIS-Bericht.html')),
    labStatus: vi.fn(() => Promise.resolve(labState())),
    proposeLabRun: vi.fn(() => Promise.resolve(proposal('Im Labor ausführen'))),
    proposeEnableSandbox: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    labReport: vi.fn(() => Promise.reject(new Error('kein Bericht'))),
    labScreenshot: vi.fn(() => Promise.resolve(new Uint8Array([137, 80, 78, 71]))),
    labCaptureWindows: vi.fn(() => Promise.resolve([])),
    proposeProcessAction: vi.fn(() => Promise.resolve(proposal('Prozess beenden'))),
    ransomStatus: vi.fn(() => Promise.resolve(ransomState())),
    backupStatus: vi.fn(() => Promise.resolve(backupState())),
    hardeningStatus: vi.fn(() => Promise.resolve(hardeningState())),
    proposeHardeningFix: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    proposeHardeningUndo: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    persistenceStatus: vi.fn(() => Promise.resolve(persistenceState())),
    proposeAutorunDisable: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    proposeBackup: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    proposeBackupRestore: vi.fn(() => Promise.resolve(proposal('Rückfall-Kopie zurückholen'))),
    proposeBackupExport: vi.fn(() => Promise.resolve(proposal('Rückfall-Kopien exportieren'))),
    proposeBackupPrune: vi.fn(() => Promise.resolve(proposal('Endgültig löschen'))),
    setProtectedFolders: vi.fn((folders: readonly string[]) =>
      Promise.resolve(ransomState({ folders })),
    ),
    panicStatus: vi.fn(() => Promise.resolve({ since: null, available: true })),
    memoryScan: vi.fn(() =>
      Promise.resolve({
        result: {
          findings: [
            {
              ...finding,
              path: 'Speicher von C:\\x\\tool.exe (PID 7) @ 0x1000',
              sha256: null,
            },
          ],
          skipped: [],
          truncated: false,
        },
        processes: 12,
        modules: 340,
        regions: 5,
      }),
    ),
    proposePanic: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    proposeBaits: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    emergencyScan: vi.fn(() => Promise.resolve(emergencyResult())),
    proposeRestoreMany: vi.fn(() =>
      Promise.resolve(proposal('Aus der Quarantäne wiederherstellen')),
    ),
    safeStatus: vi.fn(() => Promise.resolve(safeState())),
    proposeSafeSetup: vi.fn(() => Promise.resolve(proposal('Einstellung ändern'))),
    safeUnlock: vi.fn(() => Promise.resolve(safeState({ exists: true, unlocked: true }))),
    safeLock: vi.fn(() => Promise.resolve(safeState({ exists: true }))),
    proposeSafeStore: vi.fn(() => Promise.resolve(proposal('In den Datei-Safe legen'))),
    proposeSafeRetrieve: vi.fn(() => Promise.resolve(proposal('Aus dem Datei-Safe holen'))),
    ...overrides,
  };
}

function emergencyResult(): EmergencyResult {
  const danger = {
    ...finding,
    path: 'C:\\Users\\a\\Downloads\\rechnung.com',
    risk: 'dangerous' as const,
  };
  const susp = {
    ...finding,
    path: 'C:\\Users\\a\\AppData\\Roaming\\x\\tool.exe',
    risk: 'suspicious' as const,
  };
  const mem = {
    ...finding,
    path: 'Speicher von C:\\x\\t.exe (PID 7) @ 0x1000',
    sha256: null,
    risk: 'dangerous' as const,
  };
  return {
    areas: [
      { id: 'autostart', checked: 12, findings: [], skipped: 0, note: null },
      { id: 'downloads', checked: 40, findings: [danger], skipped: 0, note: null },
      { id: 'appdata', checked: 300, findings: [susp], skipped: 0, note: null },
      { id: 'memory', checked: 5, findings: [mem], skipped: 0, note: null },
    ],
    memory: [{ pid: 7, program: 'C:\\x\\t.exe' }],
    update: 'Signatur-Update angestoßen',
  };
}

function backupState(over: Partial<BackupState> = {}): BackupState {
  return {
    available: true,
    enabled: false,
    quotaMb: 10240,
    files: 0,
    versions: 0,
    bytes: 0,
    lastRun: null,
    note: null,
    folders: [],
    recent: [],
    ...over,
  };
}

function hardeningState(over: Partial<HardeningState> = {}): HardeningState {
  return {
    available: true,
    score: 72,
    checks: [
      {
        id: 'updates',
        status: 'pass',
        weight: 15,
        summaryDe: 'Letztes Update vor 3 Tagen.',
        summaryEn: 'Last update 3 days ago.',
        fix: null,
      },
      {
        id: 'smb1',
        status: 'fail',
        weight: 7,
        summaryDe: 'SMBv1 ist an.',
        summaryEn: 'SMBv1 is on.',
        fix: 'disable_smb1',
      },
      {
        id: 'tpm',
        status: 'unknown',
        weight: 5,
        summaryDe: 'Nicht lesbar – zählt nicht in den Score.',
        summaryEn: 'Not readable.',
        fix: null,
      },
    ],
    history: [
      { date: '2026-10-18', value: 65 },
      { date: '2026-10-19', value: 72 },
    ],
    checkedAt: '2026-10-19T12:00:00Z',
    osVersion: '10.0.22631.4317',
    dnsServers: [],
    listening: [{ port: 3389, protocol: 'tcp', allInterfaces: true, program: 'svchost.exe' }],
    admin: true,
    undo: [],
    ...over,
  };
}

function persistenceState(): PersistenceState {
  const base = {
    machine: false,
    enabled: true,
    reasons: [],
    file: null,
    missing: false,
    action: null,
    start: null,
    knownDriver: null,
  } as const;
  return {
    available: true,
    filesChecked: 3,
    admin: false,
    undo: [],
    driversChecked: 412,
    driverList: {
      source: 'LOLDrivers (loldrivers.io, Apache-2.0)',
      entries: 2256,
      date: '2026-10-19',
    },
    entries: [
      {
        ...base,
        id: 'a1',
        kind: 'run',
        location: 'HKU\\S-1-5-21-1\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        name: 'Updater',
        command: 'powershell -enc SQBFAFgA',
        risk: 'dangerous',
        reasons: [{ de: 'PowerShell mit verschlüsseltem Befehl.', en: 'Encoded PowerShell.' }],
        action: 'disable',
      },
      {
        ...base,
        id: 'a2',
        kind: 'startup_folder',
        location: 'C:\\Users\\a\\Startup',
        name: 'tool.lnk',
        command: 'C:\\Users\\a\\Startup\\tool.lnk',
        risk: 'clean',
        file: 'C:\\Users\\a\\Startup\\tool.lnk',
        action: 'quarantine',
      },
      {
        ...base,
        id: 'a3',
        kind: 'service',
        machine: true,
        location: 'HKLM\\SYSTEM\\CurrentControlSet\\Services',
        name: 'Spooler',
        command: 'C:\\Windows\\System32\\spoolsv.exe',
        risk: 'clean',
        action: 'disable',
      },
      {
        ...base,
        id: 'd1',
        kind: 'driver',
        machine: true,
        location: 'HKLM\\SYSTEM\\CurrentControlSet\\Services',
        name: 'RTCore64',
        command: 'C:\\Program Files\\Tool\\RTCore64.sys',
        risk: 'suspicious',
        reasons: [{ de: 'Bekannt verwundbarer Treiber.', en: 'Known vulnerable driver.' }],
        action: 'disable',
        start: 3,
        knownDriver: { category: 'vulnerable', file: 'RTCore64.sys' },
      },
    ],
  };
}

function ransomState(over: Partial<RansomState> = {}): RansomState {
  return {
    baits: [],
    defaultFolders: ['C:\\Users\\a\\Desktop', 'C:\\Users\\a\\Documents'],
    folders: [],
    recent: ['C:\\Users\\a\\Downloads\\setup.exe'],
    controlledFolderAccess: 'off',
    ...over,
  };
}

function safeState(over: Partial<SafeState> = {}): SafeState {
  return {
    exists: false,
    unlocked: false,
    entries: [],
    minPassword: 10,
    idleMinutes: 10,
    ...over,
  };
}

function labState(over: Partial<LabState> = {}): LabState {
  return {
    sandbox: { enabled: true, supported: true, edition: 'Professional' },
    miniAvailable: true,
    runs: [],
    ...over,
  };
}

function scheduleState(over: Partial<ScheduleState> = {}): ScheduleState {
  return {
    schedule: null,
    clamavAvailable: true,
    clamavUpdateAvailable: true,
    clamavUpdate: true,
    canChangeGlobal: true,
    lastUpdate: null,
    ...over,
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

describe('Berichte', () => {
  const entries: HistoryEntry[] = [
    {
      seq: 3,
      at: '2026-10-19T12:00:00Z',
      kind: 'decision',
      risk: 'dangerous',
      title: '1 Datei in die Quarantäne verschieben – abgelehnt, nichts verändert',
      detail: '',
      paths: ['/home/x/Downloads/eicar.com'],
    },
    {
      seq: 2,
      at: '2026-10-19T11:00:00Z',
      kind: 'watch',
      risk: 'dangerous',
      title: 'Wächter – Neue Datei: EICAR',
      detail: '',
      paths: ['/home/x/Downloads/eicar.com'],
    },
    {
      seq: 1,
      at: '2026-10-18T09:00:00Z',
      kind: 'scan',
      risk: null,
      title: 'Scan: 3 Dateien geprüft, 0 auffällig',
      detail: '',
      paths: [],
    },
  ];

  it('Zeitleiste nach Tagen, Filter, Export und Drucken – nur lesend', async () => {
    const service = fakeService({
      history: vi.fn(() => Promise.resolve({ entries, saveFailed: false })),
    });
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/reports' });
    expect(await screen.findAllByTestId('history-entry')).toHaveLength(3);
    expect(screen.getAllByRole('region').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('radio', { name: 'Wächter' }));
    expect(screen.getAllByTestId('history-entry')).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Entscheidungen' }));
    expect(screen.getByTestId('history-entry')).toHaveTextContent('nichts verändert');
    fireEvent.click(screen.getByRole('radio', { name: 'Updates' }));
    expect(screen.getByTestId('history-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Drucken / als PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Als HTML speichern/ }));
    await waitFor(() => expect(service.exportReport).toHaveBeenCalledWith(false));
    expect(await screen.findByText('Bericht gespeichert.')).toBeInTheDocument();
    expect(service.decide).not.toHaveBeenCalled();
    print.mockRestore();
  });

  it('Vorschau ohne Dienst: ehrlicher Hinweis', async () => {
    renderApp({ platform: fakePlatform('browser'), hash: '#/reports' });
    expect(await screen.findByTestId('service-preview')).toBeInTheDocument();
  });
});

describe('Zeitplan', () => {
  it('Stunden zwischen Ortszeit und UTC', () => {
    expect(toUtcHour(18, -120)).toBe(16);
    expect(toLocalHour(16, -120)).toBe(18);
    expect(toUtcHour(1, -120)).toBe(23);
    expect(toLocalHour(23, -120)).toBe(1);
    expect(toUtcHour(22, 300)).toBe(3);
  });

  it('setzt den geplanten Scan und das Signatur-Update über den Dienst', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/scan' });
    const panel = await screen.findByTestId('schedule-panel');
    fireEvent.click(within(panel).getByRole('switch', { name: /Geplanter Scan/ }));
    await waitFor(() => expect(service.setSchedule).toHaveBeenCalledTimes(1));
    const [enabled, every, hour] = vi.mocked(service.setSchedule).mock.calls[0] ?? [];
    expect(enabled).toBe(true);
    expect(every).toBe(7);
    expect(hour).toBe(toUtcHour(18, new Date().getTimezoneOffset()));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Täglich' }));
    await waitFor(() => expect(vi.mocked(service.setSchedule).mock.calls[1]?.[1]).toBe(1));
    fireEvent.click(within(panel).getByRole('switch', { name: /ClamAV-Signaturen/ }));
    await waitFor(() => expect(service.setClamavUpdate).toHaveBeenCalledWith(false));
  });
});

describe('Labor', () => {
  const sample = 'C:\\Users\\a\\Downloads\\setup.exe';
  const doneReport: LabReport = {
    sha256: 'ab'.repeat(32),
    end: { type: 'timed_out' },
    processes: [{ pid: 7, parent: 1, image: 'C:\\AEGIS\\Probe\\probe.exe', commandLine: null }],
    files: [{ path: 'C:\\Users\\x\\a.locked', change: 'created', size: 10, entropy: 7.9 }],
    registry: [
      {
        key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        value: 'Updater',
        change: 'created',
        data: 'C:\\x.exe',
      },
    ],
    network: [],
    screenshots: ['bild-01.png'],
    notes: ['Der Bericht wurde in der VM erstellt – die Probe hätte ihn verfälschen können.'],
  };
  const done: LabRun = {
    id: 'r1',
    sample: 'setup.exe',
    stage: 'windows_sandbox',
    seconds: 60,
    started: '2026-10-19T12:00:00Z',
    container: null,
    state: {
      state: 'done',
      assessment: {
        risk: 'dangerous',
        behaviors: ['autostart'],
        summaryDe: 'Dieses Programm versucht, sich im Autostart einzutragen.',
        summaryEn: 'This program tries to add itself to autostart.',
      },
    },
  };

  it('Vorschau ohne Dienst: ehrlicher Hinweis', async () => {
    renderApp({ platform: fakePlatform('browser'), hash: '#/lab' });
    expect(await screen.findByTestId('service-preview')).toBeInTheDocument();
  });

  it('Datei per Drag & Drop, Stufe/Dauer wählen – gestartet wird nur über den Freigabe-Dialog', async () => {
    const service = fakeService();
    const platform = fakePlatform('tauri', undefined, service);
    renderApp({ platform, hash: '#/lab' });
    expect(await screen.findByTestId('lab-status')).toHaveTextContent('Windows Sandbox ist bereit');
    const start = screen.getByRole('button', { name: /Im Labor starten/ });
    expect(start).toBeDisabled();
    act(() => platform.emitFileDrop({ type: 'enter' }));
    expect(screen.getByTestId('lab-drop')).toHaveAttribute('data-dragging', 'true');
    act(() => platform.emitFileDrop({ type: 'drop', paths: [sample] }));
    expect(screen.getByTestId('lab-path')).toHaveTextContent('setup.exe');
    expect(screen.getByTestId('lab-drop')).toHaveAttribute('data-dragging', 'false');

    fireEvent.click(screen.getByRole('radio', { name: '120 s' }));
    fireEvent.click(screen.getByRole('switch', { name: /Netzwerk im Labor/ }));
    fireEvent.click(start);
    const dialog = await screen.findByRole('alertdialog');
    expect(service.proposeLabRun).toHaveBeenCalledWith(sample, 'windows_sandbox', 120, true);
    expect(service.decide).not.toHaveBeenCalled();
    // Labor-Vorschläge bieten kein „Vertrauen“ an (die Probe käme sonst auf die Liste).
    expect(within(dialog).queryByRole('button', { name: /Vertrauen/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nein' }));
    await waitFor(() => expect(service.decide).toHaveBeenCalledTimes(1));
    expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('decline');
  });

  it('Mini-Sandbox: ehrlicher Hinweis, Netzwerk gesperrt', async () => {
    const service = fakeService({
      labStatus: vi.fn(() =>
        Promise.resolve(
          labState({ sandbox: { enabled: false, supported: false, edition: 'Core' } }),
        ),
      ),
    });
    const platform = fakePlatform('tauri', undefined, service, [sample]);
    renderApp({ platform, hash: '#/lab' });
    expect(await screen.findByTestId('lab-status')).toHaveTextContent('keine Windows Sandbox');
    expect(screen.getByRole('radio', { name: 'Windows Sandbox' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Mini-Sandbox' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/Mini-Sandbox: gleicher Kernel/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Netzwerk im Labor/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Windows Sandbox einschalten/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Datei wählen/ }));
    expect(await screen.findByTestId('lab-path')).toHaveTextContent('setup.exe');
    fireEvent.click(screen.getByRole('button', { name: /Im Labor starten/ }));
    await screen.findByRole('alertdialog');
    expect(service.proposeLabRun).toHaveBeenCalledWith(sample, 'mini_sandbox', 60, false);
  });

  it('Windows Sandbox einschalten nur als Vorschlag', async () => {
    const service = fakeService({
      labStatus: vi.fn(() =>
        Promise.resolve(labState({ sandbox: { enabled: false, supported: true, edition: 'Pro' } })),
      ),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/lab' });
    fireEvent.click(await screen.findByRole('button', { name: /Windows Sandbox einschalten/ }));
    await screen.findByRole('alertdialog');
    expect(service.proposeEnableSandbox).toHaveBeenCalledTimes(1);
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('Bericht: Einschätzung, Verhalten, Dateien, Registrierung, Bildschirmfotos', async () => {
    const failed: LabRun = {
      ...done,
      id: 'r2',
      sample: 'tool.exe',
      stage: 'mini_sandbox',
      state: { state: 'failed', message: 'Nur unter Windows' },
    };
    const service = fakeService({
      labStatus: vi.fn(() => Promise.resolve(labState({ runs: [failed, done] }))),
      labReport: vi.fn(() => Promise.resolve(doneReport)),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/lab' });
    const runs = await screen.findAllByTestId('lab-run');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveTextContent('Nicht möglich: Nur unter Windows');
    const report = within(runs[1] as HTMLElement).getByTestId('lab-report');
    expect(report).toHaveTextContent('versucht, sich im Autostart einzutragen');
    await waitFor(() => expect(report).toHaveTextContent('Dateien (1)'));
    expect(service.labReport).toHaveBeenCalledWith('r1');
    expect(within(report).getByTestId('lab-notes')).toHaveTextContent('verfälschen');
    expect(report).toHaveTextContent('Beobachtungszeit abgelaufen');
    expect(report).toHaveTextContent('Dateien (1)');
    expect(report).toHaveTextContent('sieht verschlüsselt aus');
    expect(report).toHaveTextContent('Registrierung (Autostart) (1)');
    expect(report).toHaveTextContent('Verbindungsversuche (0)');
    fireEvent.click(
      within(runs[1] as HTMLElement).getByRole('button', { name: /1 Bildschirmfotos/ }),
    );
    await waitFor(() => expect(service.labScreenshot).toHaveBeenCalledWith('r1', 'bild-01.png'));
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('Wächter bietet für Programme das Labor an – nur Vormerken, kein Start', async () => {
    const service = fakeService({
      watchPoll: vi.fn(() =>
        Promise.resolve(
          watchState([
            {
              seq: 9,
              at: '2026-10-19T12:00:00Z',
              kind: 'file',
              path: sample,
              finding: { ...finding, path: sample, risk: 'suspicious' },
            },
          ]),
        ),
      ),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const row = await screen.findByTestId('watch-event');
    fireEvent.click(within(row).getByRole('button', { name: /Im Labor prüfen/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/lab'));
    expect(await screen.findByTestId('lab-path')).toHaveTextContent('setup.exe');
    expect(service.proposeLabRun).not.toHaveBeenCalled();
  });
});

describe('Prozess-Aktionen', () => {
  it('Programmstart: Beenden nur über den Freigabe-Dialog, ohne „Vertrauen“', async () => {
    const service = fakeService({
      watchPoll: vi.fn(() =>
        Promise.resolve(
          watchState([
            {
              seq: 3,
              at: '2026-10-19T12:00:00Z',
              kind: 'process',
              path: 'C:\\Users\\a\\Downloads\\tool.exe',
              finding: { ...finding, risk: 'suspicious' },
            },
          ]),
        ),
      ),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const row = await screen.findByTestId('watch-event');
    fireEvent.click(within(row).getByRole('button', { name: /Beenden/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(service.proposeProcessAction).toHaveBeenCalledWith(
      'C:\\Users\\a\\Downloads\\tool.exe',
      'terminate',
    );
    expect(within(dialog).queryByRole('button', { name: /Vertrauen/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nein' }));
    await waitFor(() => expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('decline'));
  });
});

describe('Ransomware-Schutz', () => {
  it('Köder anlegen nur über den Freigabe-Dialog; Verdacht wird deutlich gemeldet', async () => {
    const service = fakeService({
      watchPoll: vi.fn(() =>
        Promise.resolve(
          watchState([
            {
              seq: 5,
              at: '2026-10-19T12:00:00Z',
              kind: 'ransomware',
              path: '/home/x/Dokumente/a.docx.locked',
              finding: {
                ...finding,
                risk: 'suspicious',
                summaryDe: 'Möglicher Ransomware-Angriff: … AEGIS hat nichts verändert.',
              },
            },
          ]),
        ),
      ),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const panel = await screen.findByTestId('ransom-panel');
    expect(panel).toHaveTextContent('Keine Köderdateien');
    const row = await screen.findByTestId('watch-event');
    expect(row).toHaveTextContent('Ransomware-Verdacht');
    fireEvent.click(within(panel).getByRole('button', { name: /Köder anlegen/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(service.proposeBaits).toHaveBeenCalledWith(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nein' }));
    await waitFor(() => expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('decline'));
  });
});

describe('Panic-Button', () => {
  it('Netz trennen nur über den Freigabe-Dialog', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const panel = await screen.findByTestId('ransom-panel');
    expect(screen.queryByTestId('panic-bar')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: /Netz trennen/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(service.proposePanic).toHaveBeenCalledWith(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nein' }));
    await waitFor(() => expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('decline'));
  });

  it('Leiste, solange getrennt – „Wieder verbinden“ nur als Vorschlag', async () => {
    const service = fakeService({
      panicStatus: vi.fn(() => Promise.resolve({ since: '2026-10-19T12:00:00Z', available: true })),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/dashboard' });
    const bar = await screen.findByTestId('panic-bar');
    expect(bar).toHaveTextContent('Netz getrennt');
    fireEvent.click(within(bar).getByRole('button', { name: /Wieder verbinden/ }));
    await screen.findByRole('alertdialog');
    expect(service.proposePanic).toHaveBeenCalledWith(false);
    expect(service.decide).not.toHaveBeenCalled();
  });
});

describe('Speicher-Scan', () => {
  it('zeigt Umfang und Funde – ohne Aktion', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/scan' });
    fireEvent.click(await screen.findByRole('button', { name: 'Arbeitsspeicher prüfen' }));
    const result = await screen.findByTestId('memory-result');
    expect(result).toHaveTextContent('12 Programme');
    expect(result).toHaveTextContent('340 Programmdateien/Module');
    expect(within(result).getByTestId('memory-finding')).toHaveTextContent('PID 7');
    expect(service.decide).not.toHaveBeenCalled();
    expect(service.proposeQuarantine).not.toHaveBeenCalled();
  });
});

describe('Datei-Safe', () => {
  const entry = {
    id: '0b6f3c1e-1111-4222-8333-944455556666',
    originalPath: 'C:\\Users\\a\\Documents\\vertrag.txt',
    size: 4096,
    sha256: 'ab'.repeat(32),
    storedAt: '2026-10-19T12:00:00Z',
  };

  it('Anlegen prüft das Passwort und geht nur über den Freigabe-Dialog', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/safe' });
    const form = await screen.findByTestId('safe-create');
    const pw = within(form).getByLabelText('Passwort') as HTMLInputElement;
    const repeat = within(form).getByLabelText('Passwort wiederholen');
    fireEvent.change(pw, { target: { value: 'kurz' } });
    fireEvent.change(repeat, { target: { value: 'kurz' } });
    fireEvent.click(within(form).getByRole('button', { name: /Safe anlegen/ }));
    expect(await screen.findAllByText(/braucht mindestens 10 Zeichen/)).not.toHaveLength(0);
    expect(service.proposeSafeSetup).not.toHaveBeenCalled();
    fireEvent.change(pw, { target: { value: 'ein-langes-passwort' } });
    fireEvent.change(repeat, { target: { value: 'ein-anderes-passwort' } });
    fireEvent.click(within(form).getByRole('button', { name: /Safe anlegen/ }));
    expect(await screen.findAllByText(/stimmen nicht überein/)).not.toHaveLength(0);
    fireEvent.change(repeat, { target: { value: 'ein-langes-passwort' } });
    fireEvent.click(within(form).getByRole('button', { name: /Safe anlegen/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(service.proposeSafeSetup).toHaveBeenCalledWith('ein-langes-passwort');
    expect(pw.value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nein' }));
    await waitFor(() => expect(vi.mocked(service.decide).mock.calls[0]?.[1]).toBe('decline'));
  });

  it('Entsperren zeigt Einträge; Hineinlegen und Herausholen nur als Vorschlag', async () => {
    const service = fakeService({
      safeStatus: vi.fn(() => Promise.resolve(safeState({ exists: true }))),
      safeUnlock: vi.fn(() =>
        Promise.resolve(safeState({ exists: true, unlocked: true, entries: [entry] })),
      ),
    });
    renderApp({
      platform: fakePlatform('tauri', undefined, service, ['C:\\Users\\a\\x.txt']),
      hash: '#/safe',
    });
    const form = await screen.findByTestId('safe-unlock');
    fireEvent.change(within(form).getByLabelText('Passwort'), {
      target: { value: 'ein-langes-passwort' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Entsperren' }));
    const open = await screen.findByTestId('safe-open');
    expect(service.safeUnlock).toHaveBeenCalledWith('ein-langes-passwort');
    expect(within(open).getByTestId('safe-entry')).toHaveTextContent('vertrag.txt');
    fireEvent.click(within(open).getByRole('button', { name: /Herausholen/ }));
    await screen.findByRole('alertdialog');
    expect(service.proposeSafeRetrieve).toHaveBeenCalledWith(entry.id);
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('Hineinlegen nimmt die gewählten Dateien', async () => {
    const service = fakeService({
      safeStatus: vi.fn(() => Promise.resolve(safeState({ exists: true, unlocked: true }))),
    });
    renderApp({
      platform: fakePlatform('tauri', undefined, service, ['C:\\Users\\a\\x.txt']),
      hash: '#/safe',
    });
    expect(await screen.findByTestId('safe-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /hineinlegen/ }));
    await screen.findByRole('alertdialog');
    expect(service.proposeSafeStore).toHaveBeenCalledWith(['C:\\Users\\a\\x.txt']);
    fireEvent.click(screen.getByRole('button', { name: 'Sperren' }));
    await waitFor(() => expect(service.safeLock).toHaveBeenCalled());
  });
});

describe('Notfall-Scan (Panic-Button)', () => {
  it('vorausgewählt nur „Gefährlich“, Isolieren und „Alles rückgängig“ nur über Freigabe', async () => {
    const service = fakeService({
      decide: vi.fn(() =>
        Promise.resolve({
          kind: 'executed' as const,
          ok: true,
          message: null,
          entryIds: ['q-1'],
        }),
      ),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/scan' });
    fireEvent.click(await screen.findByRole('button', { name: 'Notfall-Scan starten' }));
    const result = await screen.findByTestId('emergency-result');
    expect(service.decide).not.toHaveBeenCalled();
    const boxes = within(result).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(within(result).getByTestId('emergency-memory')).toHaveTextContent('PID 7');
    fireEvent.click(within(result).getByRole('button', { name: /Gewählte Funde isolieren \(1\)/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(service.proposeQuarantine).toHaveBeenCalledWith([
      'C:\\Users\\a\\Downloads\\rechnung.com',
    ]);
    // Sperrzeit des Dialogs abwarten (600 ms), dann bewusst „Ja“.
    await act(() => new Promise((r) => setTimeout(r, 700)));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ja, ausführen' }));
    const summary = await screen.findByTestId('emergency-summary');
    expect(summary).toHaveTextContent('1 Datei(en) isoliert');
    fireEvent.click(within(summary).getByRole('button', { name: /Alles rückgängig/ }));
    await waitFor(() => expect(service.proposeRestoreMany).toHaveBeenCalledWith(['q-1']));
  });
});

describe('Ransomware-Schutz – Ordner, Alarm, Windows', () => {
  it('Schutzordner hinzufügen und entfernen (nur Beobachtung, keine Freigabe nötig)', async () => {
    const service = fakeService();
    renderApp({
      platform: fakePlatform('tauri', undefined, service, ['D:\\Fotos']),
      hash: '#/realtime',
    });
    const folders = await screen.findByTestId('ransom-folders');
    expect(folders).toHaveTextContent('Documents');
    fireEvent.click(within(folders).getByRole('button', { name: /Ordner hinzufügen/ }));
    await waitFor(() => expect(service.setProtectedFolders).toHaveBeenCalledWith(['D:\\Fotos']));
    fireEvent.click(
      await within(folders).findByRole('button', { name: /Nicht mehr schützen: D:\\Fotos/ }),
    );
    await waitFor(() => expect(service.setProtectedFolders).toHaveBeenLastCalledWith([]));
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('Alarm bietet Einfrieren kürzlich gestarteter Programme nur als Vorschlag an', async () => {
    const alarm = {
      seq: 9,
      at: '2026-10-19T12:00:00Z',
      kind: 'ransomware' as const,
      path: 'C:\\Users\\a\\Documents\\brief.txt',
      finding: { ...finding, risk: 'dangerous' as const },
    };
    const service = fakeService({
      watchPoll: vi.fn(() => Promise.resolve(watchState([alarm]))),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const box = await screen.findByTestId('ransom-alarm');
    expect(box).toHaveTextContent('setup.exe');
    fireEvent.click(within(box).getByRole('button', { name: /Einfrieren/ }));
    await screen.findByRole('alertdialog');
    expect(service.proposeProcessAction).toHaveBeenCalledWith(
      'C:\\Users\\a\\Downloads\\setup.exe',
      'suspend',
    );
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('Überwachter Ordnerzugriff: nur erklären und Windows-Sicherheit öffnen', async () => {
    const service = fakeService();
    const platform = fakePlatform('tauri', undefined, service);
    renderApp({ platform, hash: '#/realtime' });
    const cfa = await screen.findByTestId('ransom-cfa');
    await waitFor(() => expect(cfa).toHaveTextContent('Ist ausgeschaltet'));
    fireEvent.click(within(cfa).getByRole('button', { name: 'Windows-Sicherheit öffnen' }));
    expect(platform.openWindowsSecurity).toHaveBeenCalled();
  });
});

describe('Rückfall-Kopien', () => {
  it('Einschalten nur als Vorschlag mit gewählter Grenze', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/realtime' });
    const panel = await screen.findByTestId('backup-panel');
    expect(panel).toHaveTextContent('Ausgeschaltet');
    fireEvent.click(within(panel).getByRole('radio', { name: '25 GiB' }));
    fireEvent.click(within(panel).getByRole('button', { name: /einschalten/ }));
    await screen.findByRole('alertdialog');
    expect(service.proposeBackup).toHaveBeenCalledWith(true, 25600);
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('Versionen: zurückholen, exportieren, ausdünnen – jeweils nur als Vorschlag', async () => {
    const service = fakeService({
      backupStatus: vi.fn(() =>
        Promise.resolve(
          backupState({
            enabled: true,
            files: 1,
            versions: 2,
            bytes: 2048,
            lastRun: '2026-10-19T12:00:00Z',
            recent: [
              {
                id: 'v-1',
                original: 'C:\\Users\\a\\Documents\\brief.txt',
                size: 1024,
                storedAt: '2026-10-19T11:00:00Z',
              },
            ],
          }),
        ),
      ),
    });
    renderApp({
      platform: fakePlatform('tauri', undefined, service, ['E:\\']),
      hash: '#/realtime',
    });
    const panel = await screen.findByTestId('backup-panel');
    expect(await within(panel).findByTestId('backup-version')).toHaveTextContent('brief.txt');
    fireEvent.click(within(panel).getByRole('button', { name: /Version zurückholen/ }));
    await waitFor(() => expect(service.proposeBackupRestore).toHaveBeenCalledWith('v-1'));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Nein' }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: /exportieren/ }));
    await waitFor(() => expect(service.proposeBackupExport).toHaveBeenCalledWith('E:\\'));
  });
});

describe('Härtung', () => {
  it('zeigt Score, Prüfungen und Verlauf – nur lesend, „unbekannt“ ehrlich', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/hardening' });
    const checks = await screen.findByTestId('hardening-checks');
    expect(service.hardeningStatus).toHaveBeenCalledWith(false);
    const smb = within(checks).getByTestId('hardening-check-smb1');
    expect(smb).toHaveAttribute('data-status', 'fail');
    expect(smb).toHaveTextContent('Risiko');
    expect(smb).toHaveTextContent('Vorschlag: SMBv1 abschalten.');
    expect(within(checks).getByTestId('hardening-check-tpm')).toHaveTextContent('Unbekannt');
    expect(screen.getByTestId('hardening-rated')).toHaveTextContent('2 von 3 Prüfungen bewertet');
    expect(screen.getByRole('img', { name: /Score-Verlauf/ })).toBeInTheDocument();
    expect(screen.getByTestId('hardening-details')).toHaveTextContent('3389');
    fireEvent.click(screen.getByRole('button', { name: 'Neu prüfen' }));
    await waitFor(() => expect(service.hardeningStatus).toHaveBeenLastCalledWith(true));
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('ohne Windows: kein Score, ehrlicher Hinweis', async () => {
    const service = fakeService({
      hardeningStatus: vi.fn(() =>
        Promise.resolve(hardeningState({ available: false, score: null, history: [] })),
      ),
    });
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/hardening' });
    expect(
      await screen.findByText(
        'Die Prüfung liest Windows-Einstellungen und läuft nur unter Windows.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('hardening-details')).toBeNull();
  });

  it('Dashboard zeigt den gemerkten Score des Dienstes', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/dashboard' });
    const panel = screen.getByTestId('score-panel');
    await waitFor(() =>
      expect(within(panel).getByRole('meter', { name: 'Sicherheits-Score' })).toHaveAttribute(
        'aria-valuenow',
        '72',
      ),
    );
    expect(service.hardeningStatus).toHaveBeenCalledWith(false);
  });

  it('Beheben und Rückgängig nur als Vorschlag; rechnerweit nur für Administratoren', async () => {
    const service = fakeService({
      hardeningStatus: vi.fn(() =>
        Promise.resolve(
          hardeningState({
            admin: false,
            checks: [
              ...hardeningState().checks,
              {
                id: 'network',
                status: 'warn',
                weight: 5,
                summaryDe: 'Ein Proxy ist eingerichtet.',
                summaryEn: 'A proxy is configured.',
                fix: 'disable_proxy',
              },
              {
                id: 'antivirus',
                status: 'fail',
                weight: 12,
                summaryDe: 'Kein aktiver Echtzeit-Virenschutz.',
                summaryEn: 'No active real-time antivirus.',
                fix: 'open_settings',
              },
            ],
            undo: [{ id: 'u-1', fix: 'disable_smb1', at: '2026-10-19T12:00:00Z' }],
          }),
        ),
      ),
    });
    const platform = fakePlatform('tauri', undefined, service);
    renderApp({ platform, hash: '#/hardening' });
    const checks = await screen.findByTestId('hardening-checks');
    const smb = within(checks).getByTestId('hardening-check-smb1');
    expect(within(smb).getByRole('button', { name: 'Beheben …' })).toBeDisabled();
    expect(smb).toHaveTextContent('Administratorrechte');
    const proxy = within(checks).getByTestId('hardening-check-network');
    fireEvent.click(within(proxy).getByRole('button', { name: 'Beheben …' }));
    await screen.findByRole('alertdialog');
    expect(service.proposeHardeningFix).toHaveBeenCalledWith('disable_proxy');
    expect(service.decide).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Nein' }));
    const av = within(checks).getByTestId('hardening-check-antivirus');
    fireEvent.click(within(av).getByRole('button', { name: 'In Windows öffnen' }));
    expect(platform.openWindowsSettings).toHaveBeenCalledWith('virus_protection');
    const undo = screen.getByTestId('hardening-undo');
    expect(undo).toHaveTextContent('SMBv1 abgeschaltet');
    fireEvent.click(within(undo).getByRole('button', { name: /Rückgängig/ }));
    await waitFor(() => expect(service.proposeHardeningUndo).toHaveBeenCalledWith('u-1'));
  });

  it('Autostarts: erst auf Knopfdruck, Deaktivieren und Quarantäne nur als Vorschlag', async () => {
    const service = fakeService();
    renderApp({ platform: fakePlatform('tauri', undefined, service), hash: '#/hardening' });
    const panel = await screen.findByTestId('persistence-panel');
    expect(service.persistenceStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Autostarts prüfen' }));
    const entries = await within(panel).findByTestId('persistence-entries');
    const shown = within(entries).getAllByTestId('persistence-entry');
    expect(shown).toHaveLength(3);
    expect(entries).toHaveTextContent('PowerShell mit verschlüsseltem Befehl.');
    // Verwundbarer Treiber: markiert, Liste mit Quelle und Stand genannt.
    const driver = shown.find((e) => e.getAttribute('data-kind') === 'driver') as HTMLElement;
    expect(driver).toHaveTextContent('Verwundbarer Treiber');
    expect(within(panel).getByTestId('persistence-driver-list')).toHaveTextContent(
      '412 Treiber abgeglichen mit LOLDrivers (loldrivers.io, Apache-2.0) (2256 Einträge, Stand 2026-10-19)',
    );
    expect(within(driver).getByRole('button', { name: 'Deaktivieren …' })).toBeDisabled();
    const run = shown.find((e) => e.getAttribute('data-kind') === 'run') as HTMLElement;
    fireEvent.click(within(run).getByRole('button', { name: 'Deaktivieren …' }));
    await screen.findByRole('alertdialog');
    expect(service.proposeAutorunDisable).toHaveBeenCalledWith('a1');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Nein' }));
    fireEvent.click(within(entries).getByRole('button', { name: 'In die Quarantäne …' }));
    await waitFor(() =>
      expect(service.proposeQuarantine).toHaveBeenCalledWith(['C:\\Users\\a\\Startup\\tool.lnk']),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Nein' }),
    );
    // Alle zeigen: auch Dienste; rechnerweite nur mit Administratorrechten.
    fireEvent.click(within(panel).getByRole('radio', { name: 'Alle (4)' }));
    const spooler = within(panel)
      .getAllByTestId('persistence-entry')
      .find((e) => e.getAttribute('data-kind') === 'service');
    expect(spooler).toBeDefined();
    expect(
      within(spooler as HTMLElement).getByRole('button', { name: 'Deaktivieren …' }),
    ).toBeDisabled();
    expect(service.decide).not.toHaveBeenCalledWith(
      expect.anything(),
      'execute',
      expect.anything(),
    );
  });
});
