import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatBytes, parsePreview, parseRun } from '../platform/tools.ts';
import { disposeApps, fakePlatform, fakeTools, renderApp } from '../test/harness.tsx';

afterEach(() => disposeApps());

function withTools(tools: ReturnType<typeof fakeTools>, picked: readonly string[] = []) {
  const platform = fakePlatform('tauri', undefined, null, picked);
  Object.assign(platform, { tools });
  return platform;
}

describe('Werkzeuge', () => {
  it('Vorschau ohne App: ehrlicher Hinweis', async () => {
    renderApp({ platform: fakePlatform('browser'), hash: '#/tools' });
    expect(await screen.findByText(/nur in der installierten App/)).toBeInTheDocument();
  });

  it('Sortierer: erst Vorschau, abgewählte Schritte bleiben, dann Ergebnis und Rückgängig', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    const panel = await screen.findByTestId('tool-sort_downloads');
    // Standardordner aus der App (Downloads).
    expect(await within(panel).findByText('C:/Users/anna/Downloads')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Vorschau erstellen' }));
    const preview = await within(panel).findByTestId('tool-preview');
    expect(tools.execute).not.toHaveBeenCalled();
    const boxes = within(preview).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(preview).toHaveTextContent('1 Schritte');
    fireEvent.click(within(preview).getByRole('button', { name: 'Ausführen' }));
    const result = await within(panel).findByTestId('tool-result');
    expect(result).toHaveTextContent('1 ausgeführt · 1 übersprungen · 0 fehlgeschlagen');
    expect(tools.execute).toHaveBeenCalledWith('p1', 'a'.repeat(64), [1], undefined);
    fireEvent.click(within(result).getByRole('button', { name: 'Rückgängig' }));
    expect(await within(result).findByText('Zurückgenommen.')).toBeInTheDocument();
    expect(tools.undo).toHaveBeenCalledWith(tools.runList[0]?.id);
  });

  it('Verwerfen führt nichts aus; Protokoll zeigt Läufe', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    const panel = await screen.findByTestId('tool-sort_downloads');
    await within(panel).findByText('C:/Users/anna/Downloads');
    fireEvent.click(within(panel).getByRole('button', { name: 'Vorschau erstellen' }));
    const preview = await within(panel).findByTestId('tool-preview');
    fireEvent.click(within(preview).getByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(within(panel).queryByTestId('tool-preview')).toBeNull());
    expect(tools.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Protokoll' }));
    expect(await screen.findByText('Noch keine Läufe.')).toBeInTheDocument();
  });

  it('Duplikate: Gruppe zeigt, welche Datei bleibt', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools, ['C:/Users/anna/Bilder']), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Duplikate' }));
    const panel = await screen.findByTestId('tool-duplicates');
    fireEvent.click(within(panel).getByRole('button', { name: 'Ordner hinzufügen …' }));
    expect(await within(panel).findByText('C:/Users/anna/Bilder')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Vorschau erstellen' }));
    const preview = await within(panel).findByTestId('tool-preview');
    expect(preview).toHaveTextContent('a/foto.jpg(bleibt)');
    expect(tools.preview).toHaveBeenCalledWith({
      tool: 'duplicates',
      roots: ['C:/Users/anna/Bilder'],
      minSize: 1024 * 1024,
    });
  });

  it('Autostart: nur Konto-Einträge schaltbar, Vorschau mit genau der Änderung', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Autostart' }));
    const list = await screen.findByTestId('autostart-list');
    expect(within(list).getAllByRole('switch')).toHaveLength(1);
    fireEvent.click(within(list).getByRole('switch', { name: 'Chat-Programm' }));
    const panel = screen.getByTestId('tool-autostart');
    fireEvent.click(within(panel).getByRole('button', { name: 'Vorschau erstellen' }));
    await waitFor(() =>
      expect(tools.preview).toHaveBeenCalledWith({
        tool: 'autostart',
        changes: [{ entry: { location: 'run_user', name: 'Chat-Programm' }, enable: false }],
      }),
    );
  });

  it('Regeln: neue Regel ist zunächst aus und wird gespeichert', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Regeln & Überwachung' }));
    const panel = await screen.findByTestId('tool-rules');
    fireEvent.click(within(panel).getByRole('button', { name: 'Neue Regel' }));
    const form = within(panel).getByRole('form', { name: 'Neue Regel' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Archive' } });
    fireEvent.change(within(form).getByLabelText('Endungen (z. B. zip, pdf)'), {
      target: { value: 'zip, 7z' },
    });
    fireEvent.change(within(form).getByLabelText('Unterordner'), { target: { value: 'Archive' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Regel speichern' }));
    await waitFor(() => expect(tools.saveRule).toHaveBeenCalled());
    const saved = (
      tools.saveRule as unknown as {
        mock: { calls: [[{ enabled: boolean; condition: { extensions: string[] } }]] };
      }
    ).mock.calls[0][0];
    expect(saved.enabled).toBe(false);
    expect(saved.condition.extensions).toEqual(['zip', '7z']);
    expect(await within(panel).findByText('Archive')).toBeInTheDocument();
  });

  it('Speicherplatz: nur lesend, Balken über transform', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Speicherplatz' }));
    const panel = await screen.findByTestId('tool-space');
    await within(panel).findByText('C:/Users/anna/Downloads');
    fireEvent.click(within(panel).getByRole('button', { name: 'Analysieren' }));
    const report = await screen.findByTestId('space-report');
    await waitFor(() => expect(report).toHaveTextContent('Spiele'));
    expect(tools.execute).not.toHaveBeenCalled();
  });
});

describe('Lange Vorschau', () => {
  it('nicht angezeigte Schritte laufen nie, „Weitere anzeigen“ blendet sie ein', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cleaner' }));
    const panel = await screen.findByTestId('tool-cleaner');
    fireEvent.click(within(panel).getByRole('button', { name: 'Vorschau erstellen' }));
    const preview = await within(panel).findByTestId('tool-preview');
    expect(preview).toHaveTextContent('300 Schritte');
    expect(preview).toHaveTextContent('5 weitere Schritte noch nicht angezeigt');
    fireEvent.click(within(preview).getByRole('button', { name: 'Ausführen' }));
    await within(panel).findByTestId('tool-result');
    expect(tools.execute).toHaveBeenCalledWith(
      'p1',
      'a'.repeat(64),
      [300, 301, 302, 303, 304],
      undefined,
    );

    fireEvent.click(within(panel).getByRole('button', { name: 'Vorschau erstellen' }));
    const again = await within(panel).findByTestId('tool-preview');
    fireEvent.click(within(again).getByRole('button', { name: 'Weitere anzeigen' }));
    expect(again).toHaveTextContent('305 Schritte');
    expect(within(again).getAllByRole('checkbox')).toHaveLength(305);
  });
});

describe('Werkzeuge 12–22', () => {
  it('Shredder: erst zweiter Dialog, ohne ihn passiert nichts', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools, ['C:/Users/anna/geheim.txt']), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Datei-Shredder' }));
    const panel = await screen.findByTestId('tool-shredder');
    expect(panel).toHaveTextContent('BitLocker');
    fireEvent.click(within(panel).getByRole('button', { name: 'Dateien wählen …' }));
    await within(panel).findByText('C:/Users/anna/geheim.txt');
    fireEvent.click(within(panel).getByRole('button', { name: 'Vorschau erstellen' }));
    const preview = await within(panel).findByTestId('tool-preview');
    fireEvent.click(within(preview).getByRole('button', { name: 'Ausführen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Endgültig löschen?' });
    expect(tools.runList).toHaveLength(0);
    // Abbrechen: nichts gelöscht.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(tools.runList).toHaveLength(0);
    fireEvent.click(within(preview).getByRole('button', { name: 'Ausführen' }));
    const again = await screen.findByRole('alertdialog', { name: 'Endgültig löschen?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Ja, endgültig löschen' }));
    expect(await within(panel).findByTestId('tool-result')).toHaveTextContent('1 ausgeführt');
    expect(tools.execute).toHaveBeenLastCalledWith('p1', 'a'.repeat(64), [], 'b'.repeat(32));
  });

  it('Explorer-Schalter: Vorschau mit genau der Änderung', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Explorer-Tweaks' }));
    const list = await screen.findByTestId('tweaks-explorer');
    fireEvent.click(within(list).getByRole('switch', { name: 'Dateiendungen anzeigen' }));
    fireEvent.click(
      within(screen.getByTestId('tool-explorer_tweaks')).getByRole('button', {
        name: 'Vorschau erstellen',
      }),
    );
    await waitFor(() =>
      expect(tools.preview).toHaveBeenCalledWith({
        tool: 'tweaks',
        changes: [{ id: 'show_extensions', on: true }],
      }),
    );
  });

  it('Hosts und Systeminfo: nur lesend, ehrliche Hinweise', async () => {
    const tools = fakeTools();
    renderApp({ platform: withTools(tools), hash: '#/tools' });
    fireEvent.click(await screen.findByRole('button', { name: 'Hosts-Datei' }));
    expect(await screen.findByText(/1 verdächtige Umleitungen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Systeminfo' }));
    const report = await screen.findByTestId('system-report');
    expect(report).toHaveTextContent('Windows 11 Pro');
    expect(report).toHaveTextContent('Seit über 14 Tagen nicht neu gestartet');
    fireEvent.click(screen.getByRole('button', { name: 'Weitere' }));
    expect(screen.getByRole('link', { name: 'Programm-Updates' })).toHaveAttribute(
      'href',
      '#/hardening',
    );
    expect(tools.execute).not.toHaveBeenCalled();
  });
});

describe('Parser', () => {
  it('Vorschau braucht Kennung und Prüfsumme', () => {
    expect(() => parsePreview({ id: 'x', digest: 'kurz' })).toThrow();
    const p = parsePreview({
      id: 'x',
      digest: 'b'.repeat(64),
      tool: 'unbekannt',
      items: [{ label: 'a', kind: 'format', size: -1 }],
    });
    expect(p.tool).toBe('rules');
    expect(p.items[0]?.kind).toBe('move');
    expect(parseRun({ items: [{ status: 'seltsam' }] }).items[0]?.status).toBe('failed');
  });

  it('Größen', () => {
    expect(formatBytes(512, 'de')).toBe('512 B');
    expect(formatBytes(1536, 'de')).toBe('1,5 KB');
    expect(formatBytes(5 * 1024 ** 3, 'en')).toBe('5 GB');
  });
});
