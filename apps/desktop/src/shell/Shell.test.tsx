import { isSoundEnabled, prefersReducedMotion, setSoundEnabled } from '@aegis/ui';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTauriPlatform } from '../platform/platform.ts';
import { routeIds, routePhases } from '../router/routes.ts';
import {
  disposeApps,
  fakePlatform,
  renderApp,
  stubLanguages,
  stubMatchMedia,
} from '../test/harness.tsx';

function heading(): HTMLElement {
  return screen.getByRole('heading', { level: 1 });
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Hauptnavigation' });
}

async function openPalette(): Promise<HTMLElement> {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return screen.findByRole('dialog', { name: 'Befehlspalette' });
}

/** Wählt einen Eintrag der Befehlspalette per Suche und Enter. */
async function runCommand(query: string): Promise<void> {
  const user = userEvent.setup();
  const dialog = await openPalette();
  await user.type(within(dialog).getByRole('combobox'), query);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

beforeEach(() => {
  stubLanguages(['de-DE']);
  setSoundEnabled(true);
  localStorage.clear();
});

afterEach(() => {
  disposeApps();
  clearMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Seitenleiste', () => {
  it('zeigt alle zwölf Seiten; die aktive trägt aria-current, Module ihre Phase', () => {
    renderApp();
    const links = within(nav()).getAllByRole('link');
    expect(links).toHaveLength(routeIds.length);
    expect(within(nav()).getByRole('link', { current: 'page' })).toHaveAccessibleName('Dashboard');
    expect(within(nav()).getByRole('link', { name: 'Scan, folgt in P2' })).toHaveAttribute(
      'href',
      '#/scan',
    );
    expect(within(nav()).getByRole('link', { name: 'Tools, folgt in P10' })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Einstellungen' })).toBeInTheDocument();
  });

  it('Klick öffnet die Seite; der Fokus bleibt in der Navigation, die Seite wird angesagt', async () => {
    const user = userEvent.setup();
    renderApp();
    const scan = within(nav()).getByRole('link', { name: /^Scan/ });
    await user.click(scan);
    await waitFor(() => expect(heading()).toHaveTextContent('Scan'));
    expect(window.location.hash).toBe('#/scan');
    expect(scan).toHaveAttribute('aria-current', 'page');
    expect(scan).toHaveFocus();
    expect(screen.getByTestId('route-announcement')).toHaveTextContent('Seite: Scan');
    expect(document.title).toBe('Scan · AEGIS');
  });

  it('Tastatur: ein Tab-Stopp, ↑/↓/Pos1/Ende bewegen den Fokus, Enter öffnet', async () => {
    const user = userEvent.setup();
    renderApp();
    const links = within(nav()).getAllByRole('link');
    // Nur die aktive Seite ist per Tab erreichbar (roving tabindex).
    expect(links.filter((link) => link.tabIndex === 0)).toHaveLength(1);

    const dashboard = within(nav()).getByRole('link', { name: 'Dashboard' });
    dashboard.focus();
    await user.keyboard('{ArrowDown}');
    expect(within(nav()).getByRole('link', { name: /^Berichte/ })).toHaveFocus();
    await user.keyboard('{End}');
    expect(within(nav()).getByRole('link', { name: 'Über AEGIS' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(dashboard).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(within(nav()).getByRole('link', { name: 'Über AEGIS' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(dashboard).toHaveFocus();

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    const realtime = within(nav()).getByRole('link', { name: /^Echtzeit-Wächter/ });
    expect(realtime).toHaveFocus();
    expect(realtime.tabIndex).toBe(0);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(heading()).toHaveTextContent('Echtzeit-Wächter'));
  });

  it('einklappen: nur Symbole (Namen bleiben zugänglich), Einstellung wird gespeichert', async () => {
    const user = userEvent.setup();
    const { memory } = renderApp();
    const toggle = screen.getByRole('button', { name: 'Navigation einklappen' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByRole('button', { name: 'Navigation ausklappen' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav()).getByRole('link', { name: 'Scan, folgt in P2' })).toBeInTheDocument();
    expect(memory.settings()?.sidebarCollapsed).toBe(true);
    // Bedien-Komfort, kein Ereignis für die Live-Aktivität.
    expect(screen.queryByText(/Navigation einklappen:/)).toBeNull();
  });
});

describe('Seiten', () => {
  it('jedes noch fehlende Modul zeigt einen ehrlichen Platzhalter mit seiner Phase', async () => {
    const { services } = renderApp();
    for (const route of routeIds) {
      const phase = routePhases[route];
      act(() => services.router.navigate(route, { replace: true }));
      await waitFor(() => expect(window.location.hash).toBe(`#/${route}`));
      const placeholder = screen.queryByTestId('module-placeholder');
      if (phase === undefined) {
        expect(placeholder, route).toBeNull();
      } else {
        expect(placeholder, route).toHaveAttribute('data-phase', phase);
        expect(
          within(placeholder as HTMLElement).getByText(`Folgt in ${phase}`),
        ).toBeInTheDocument();
        expect(
          within(placeholder as HTMLElement).getByText(/keine Beispiel- oder Schätzwerte/),
        ).toBeInTheDocument();
      }
    }
  });

  it('nach einem Seitenwechsel außerhalb der Navigation liegt der Fokus auf der Überschrift', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
    await waitFor(() => expect(heading()).toHaveTextContent('Einstellungen'));
    expect(heading()).toHaveFocus();
  });

  it('„Zum Inhalt springen“ führt zur Überschrift', async () => {
    const user = userEvent.setup();
    renderApp();
    const skip = screen.getByRole('button', { name: 'Zum Inhalt springen' });
    skip.focus();
    await user.keyboard('{Enter}');
    expect(heading()).toHaveFocus();
  });
});

describe('Titelleiste', () => {
  it('Browser-Vorschau: keine Fensterknöpfe, ehrliches Abzeichen, keine Zieh-Fläche', () => {
    renderApp();
    expect(screen.getByTestId('preview-badge')).toHaveTextContent('Browser-Vorschau');
    expect(screen.queryByRole('group', { name: 'Fenster' })).toBeNull();
    expect(screen.getByTestId('titlebar')).not.toHaveAttribute('data-tauri-drag-region');
  });

  it('Desktop: Minimieren, Maximieren/Wiederherstellen rufen die passende Fenster-API', async () => {
    const user = userEvent.setup();
    const platform = fakePlatform('tauri');
    renderApp({ platform });
    const controls = screen.getByRole('group', { name: 'Fenster' });
    expect(screen.getByTestId('titlebar')).toHaveAttribute('data-tauri-drag-region', 'deep');
    expect(screen.queryByTestId('preview-badge')).toBeNull();

    await user.click(within(controls).getByRole('button', { name: 'Minimieren' }));
    expect(platform.windowMock?.minimize).toHaveBeenCalledTimes(1);

    await user.click(within(controls).getByRole('button', { name: 'Maximieren' }));
    expect(platform.windowMock?.toggleMaximize).toHaveBeenCalledTimes(1);
    // Tauri meldet die Größenänderung → das Symbol wechselt zu „Wiederherstellen“.
    act(() => platform.emitResized());
    expect(
      await within(controls).findByRole('button', { name: 'Wiederherstellen' }),
    ).toBeInTheDocument();
  });

  it('Doppelklick auf die Leiste macht die App nicht selbst (das übernimmt Tauris Zieh-Skript)', () => {
    const platform = fakePlatform('tauri');
    renderApp({ platform });
    fireEvent.doubleClick(screen.getByTestId('titlebar'));
    expect(platform.windowMock?.toggleMaximize).not.toHaveBeenCalled();
  });

  it('Schließen: mit „In den Infobereich“ (Standard) hide(), sonst close()', async () => {
    const user = userEvent.setup();
    const platform = fakePlatform('tauri');
    const { services } = renderApp({ platform });
    await user.click(
      screen.getByRole('button', { name: 'Schließen – AEGIS läuft im Infobereich weiter' }),
    );
    expect(platform.windowMock?.hide).toHaveBeenCalledTimes(1);
    expect(platform.windowMock?.close).not.toHaveBeenCalled();

    act(() => {
      services.settings.update({ closeToTray: false });
    });
    await user.click(screen.getByRole('button', { name: 'AEGIS beenden' }));
    expect(platform.windowMock?.close).toHaveBeenCalledTimes(1);
    expect(platform.windowMock?.hide).toHaveBeenCalledTimes(1);
  });

  it('Fehler eines Fensterbefehls werden gemeldet, nicht geworfen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const platform = fakePlatform('tauri');
    platform.windowMock?.minimize.mockRejectedValueOnce(new Error('verweigert'));
    renderApp({ platform });
    fireEvent.click(screen.getByRole('button', { name: 'Minimieren' }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('AEGIS: minimize fehlgeschlagen', expect.any(Error)),
    );
  });

  it('der Suchknopf öffnet die Befehlspalette', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: /Seite oder Befehl suchen/ }));
    expect(await screen.findByRole('dialog', { name: 'Befehlspalette' })).toBeInTheDocument();
  });
});

describe('Befehlspalette', () => {
  it('Strg+K öffnet; eine Seite auswählen navigiert und fokussiert die Überschrift', async () => {
    renderApp();
    await runCommand('Einstell');
    await waitFor(() => expect(heading()).toHaveTextContent('Einstellungen'));
    expect(window.location.hash).toBe('#/settings');
    await waitFor(() => expect(heading()).toHaveFocus());
  });

  it('enthält alle Seiten, die Schnellschalter und Kürzel-Hinweise', async () => {
    renderApp();
    const dialog = await openPalette();
    const options = within(dialog).getAllByRole('option');
    const labels = options.map((option) => option.textContent ?? '');
    expect(options).toHaveLength(routeIds.length + 6);
    for (const label of [
      'Dashboard',
      'Über AEGIS',
      'Helle Darstellung',
      'Sprache: English',
      'Klang ausschalten',
      'Bewegung reduzieren',
      'Start-Animation abspielen',
    ]) {
      expect(
        labels.some((text) => text.includes(label)),
        label,
      ).toBe(true);
    }
    const emergency = options.find((option) => option.textContent?.includes('Notfall-Scan'));
    expect(emergency).toHaveAttribute('aria-disabled', 'true');
    expect(emergency).toHaveTextContent('Folgt in P5');
    const settings = options.find((option) => option.textContent?.startsWith('Einstellungen'));
    expect(settings).toHaveTextContent('Strg');
  });

  it('⌘K und „/“ öffnen ebenfalls; in Textfeldern bleibt „/“ ein Zeichen', async () => {
    renderApp();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(document.body, { key: '/' });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: '/' });
    // Kein zweites Öffnen, kein Fehler – das Zeichen gehört dem Suchfeld.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('Strg+, öffnet die Einstellungen', async () => {
    renderApp();
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    await waitFor(() => expect(heading()).toHaveTextContent('Einstellungen'));
  });

  it('Darstellung umschalten setzt data-theme sofort und speichert', async () => {
    stubMatchMedia({});
    const { memory } = renderApp();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await runCommand('Helle Darstellung');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(memory.settings()?.theme).toBe('light');
    await runCommand('Dunkle Darstellung');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('Sprache wechseln: Oberfläche sofort auf Englisch (auch aria-labels und lang)', async () => {
    const { memory } = renderApp();
    await runCommand('Sprache');
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(heading()).toHaveTextContent('Dashboard');
    expect(screen.getByText(/Not rated yet/)).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(memory.settings()?.language).toBe('en');
  });

  it('Klang aus/an schaltet den Klang von @aegis/ui', async () => {
    renderApp();
    expect(isSoundEnabled()).toBe(true);
    await runCommand('Klang aus');
    expect(isSoundEnabled()).toBe(false);
    await runCommand('Klang ein');
    expect(isSoundEnabled()).toBe(true);
  });

  it('Bewegung reduzieren wirkt überall (data-motion, matchMedia für @aegis/ui)', async () => {
    renderApp();
    expect(prefersReducedMotion()).toBe(false);
    await runCommand('Bewegung reduzieren');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduced');
    expect(prefersReducedMotion()).toBe(true);
    await runCommand('Bewegung wie');
    expect(document.documentElement).not.toHaveAttribute('data-motion');
    expect(prefersReducedMotion()).toBe(false);
  });

  it('Start-Animation abspielen legt die Start-Ebene erneut über die Shell', async () => {
    renderApp();
    await runCommand('Start-Animation');
    expect(await screen.findByTestId('aegis-boot')).toBeInTheDocument();
    expect(screen.getByTestId('shell')).toHaveAttribute('inert');
  });
});

describe('Infobereich (Tray)', () => {
  it('aegis://navigate öffnet die Seite und erscheint in der Live-Aktivität', async () => {
    const platform = fakePlatform('tauri');
    const { services } = renderApp({ platform });
    await waitFor(() => expect(platform.listenerCount()).toBeGreaterThan(0));
    act(() => platform.emitNavigate('settings'));
    await waitFor(() => expect(heading()).toHaveTextContent('Einstellungen'));
    expect(heading()).toHaveFocus();
    expect(services.activity.getSnapshot()[0]).toMatchObject({
      kind: 'tray-navigate',
      target: 'settings',
    });

    act(() => platform.emitNavigate('dashboard'));
    await waitFor(() => expect(heading()).toHaveTextContent('Dashboard'));
    expect(screen.getByText('Über den Infobereich geöffnet: Einstellungen')).toBeInTheDocument();
  });

  it('mit der echten Tauri-API (IPC nachgebildet): Ereignis → Seitenwechsel', async () => {
    vi.stubGlobal('isTauri', true);
    mockWindows('main');
    mockIPC((command) => (command === 'plugin:window|is_maximized' ? false : null), {
      shouldMockEvents: true,
    });
    renderApp({ platform: createTauriPlatform() });
    expect(screen.getByRole('group', { name: 'Fenster' })).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(() => emit('aegis://navigate', { page: 'settings' }));
    await waitFor(() => expect(heading()).toHaveTextContent('Einstellungen'));
  });

  it('meldet den Empfänger beim Abbauen wieder ab', async () => {
    const platform = fakePlatform('tauri');
    const { unmount } = renderApp({ platform });
    await waitFor(() => expect(platform.listenerCount()).toBe(2));
    unmount();
    await waitFor(() => expect(platform.listenerCount()).toBe(0));
  });
});
