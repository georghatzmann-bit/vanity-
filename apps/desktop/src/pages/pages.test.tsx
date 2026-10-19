import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_STORAGE_KEY, SETTINGS_VERSION } from '../settings/schema.ts';
import { LIGHT_SCHEME_QUERY } from '../settings/system.ts';
import {
  desktopInfo,
  disposeApps,
  fakePlatform,
  memoryStorage,
  renderApp,
  stubLanguages,
  stubMatchMedia,
} from '../test/harness.tsx';

beforeEach(() => {
  stubLanguages(['de-DE']);
});

afterEach(() => {
  disposeApps();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Dashboard – ehrlich', () => {
  it('Score ohne Wert: kein Messgerät, „–“ und die ehrliche Begründung (P6)', () => {
    renderApp();
    const panel = screen.getByTestId('score-panel');
    expect(within(panel).queryByRole('meter')).toBeNull();
    expect(within(panel).getByRole('group', { name: 'Sicherheits-Score' })).toHaveAttribute(
      'data-score',
      'none',
    );
    expect(
      within(panel).getByText('Noch nicht bewertet – die Systemprüfungen folgen in P6.'),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/\d+\s*von 100/)).toBeNull();
  });

  it('Module: Engine, Wächter und Ransomware-Schutz nur mit Dienst, Netzwerk P7', () => {
    renderApp();
    for (const [id, label] of [
      ['signatures', 'Signaturen & Engine'],
      ['realtime', 'Echtzeit-Wächter'],
      ['ransomware', 'Ransomware-Schutz'],
    ] as const) {
      const item = screen.getByTestId(`module-${id}`);
      expect(item).toHaveTextContent(label);
      expect(item).toHaveTextContent('Nur in der Windows-App mit Dienst');
      expect(item.querySelector('[data-state]')).toHaveAttribute('data-state', 'unavailable');
    }
    const expected = [['network', 'Netzwerk-Schutz', 'P7']] as const;
    for (const [id, label, phase] of expected) {
      const item = screen.getByTestId(`module-${id}`);
      expect(item).toHaveTextContent(label);
      expect(item).toHaveTextContent('Nicht verfügbar');
      expect(item).toHaveTextContent(`Folgt in ${phase}`);
      expect(item.querySelector('[data-state]')).toHaveAttribute('data-state', 'unavailable');
    }
  });

  it('zeigt den Kernel-Hinweis und die Goldene Regel gut sichtbar', () => {
    renderApp();
    expect(screen.getByTestId('honesty-kernel')).toHaveTextContent(
      'Ehrlich gesagt AEGIS hat keinen Kernel-Treiber. Es erkennt, warnt und isoliert auf Wunsch – es blockiert keine Programme vor dem Start.',
    );
    expect(screen.getByTestId('honesty-golden')).toHaveTextContent(
      'AEGIS ändert nichts ohne dein Ja.',
    );
  });

  it('Notfall-Scan ist gesperrt (folgt in P5), bleibt aber per Tastatur erreichbar und erklärt', async () => {
    const user = userEvent.setup();
    renderApp();
    const emergency = screen.getByTestId('emergency-scan');
    expect(emergency).toHaveAttribute('aria-disabled', 'true');
    expect(emergency).toHaveAccessibleName('Notfall-Scan Folgt in P5');
    await user.click(emergency);
    expect(window.location.hash).toBe('#/dashboard');
    emergency.focus();
    act(() => emergency.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    // Hinweis als Tooltip (bei Tastaturfokus sofort) – ergänzt, ersetzt nicht den sichtbaren Text.
    expect(screen.getByText('Folgt in P5', { selector: 'span' })).toBeVisible();
  });

  it('Live-Aktivität: nur echte Ereignisse dieser Sitzung (Start, Einstellungen)', async () => {
    const user = userEvent.setup();
    const { services } = renderApp();
    const list = screen.getByTestId('activity-list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('AEGIS gestartet');
    expect(list).toHaveTextContent('Browser-Vorschau');
    expect(screen.getByTestId('activity-count')).toHaveTextContent('1 Ereignis');

    act(() => {
      services.settings.update({ theme: 'light' });
    });
    // Direkte Store-Änderungen sind keine Nutzeraktion – nur die Oberfläche protokolliert.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
    await user.click(screen.getByRole('radio', { name: 'Dunkel' }));
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    await waitFor(() => expect(screen.getByTestId('activity-list')).toBeInTheDocument());
    expect(screen.getByTestId('activity-list')).toHaveTextContent('Darstellung: Dunkel');
    expect(screen.getByTestId('activity-count')).toHaveTextContent('2 Ereignisse');
  });

  it('Live-Aktivität: nach sechs Einträgen „Alle anzeigen“', async () => {
    const user = userEvent.setup();
    const { services } = renderApp();
    act(() => {
      for (let index = 0; index < 7; index += 1) {
        services.activity.record({ kind: 'boot-replayed' });
      }
    });
    const list = screen.getByTestId('activity-list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    const toggle = screen.getByRole('button', { name: 'Alle anzeigen' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Weniger anzeigen' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });
});

describe('Einstellungen', () => {
  it('Darstellung: Hell/Dunkel sofort, „System“ folgt dem System live', async () => {
    const user = userEvent.setup();
    const media = stubMatchMedia({ [LIGHT_SCHEME_QUERY]: false });
    renderApp({ hash: '#/settings', settings: { theme: 'system' } });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByText('Gerade: Dunkel')).toBeInTheDocument();

    act(() => media.set(LIGHT_SCHEME_QUERY, true));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(screen.getByText('Gerade: Hell')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Dunkel' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    act(() => media.set(LIGHT_SCHEME_QUERY, false));
    act(() => media.set(LIGHT_SCHEME_QUERY, true));
    // Feste Wahl bleibt, egal was das System meldet.
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('Sprache: Englisch wirkt sofort, „System“ folgt der Systemsprache', async () => {
    const user = userEvent.setup();
    const { memory } = renderApp({ hash: '#/settings', settings: { language: 'system' } });
    expect(screen.getByText('Gerade: Deutsch')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeInTheDocument();
    expect(memory.settings()?.language).toBe('en');

    await user.click(
      within(screen.getByRole('radiogroup', { name: 'Language' })).getByRole('radio', {
        name: 'System',
      }),
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Einstellungen');
    stubLanguages(['en-GB', 'de-DE']);
    act(() => {
      window.dispatchEvent(new Event('languagechange'));
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
    expect(screen.getByText('Currently: English')).toBeInTheDocument();
  });

  it('Klang, Bewegung und Start-Animation schalten und speichern', async () => {
    const user = userEvent.setup();
    const { memory } = renderApp({ hash: '#/settings' });
    await user.click(screen.getByRole('switch', { name: 'Klang' }));
    expect(memory.settings()?.sound).toBe(false);
    await user.click(screen.getByRole('radio', { name: 'Reduziert' }));
    expect(memory.settings()?.motion).toBe('reduced');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduced');
    await user.click(screen.getByRole('switch', { name: 'Start-Animation beim Start zeigen' }));
    expect(memory.settings()?.bootAnimation).toBe(true);
    expect(screen.getByRole('switch', { name: 'Klang' })).toHaveAccessibleDescription(
      'Dezente Töne, etwa beim Einschalten des Klangs und beim erneuten Abspielen der Start-Animation. Beim Öffnen von AEGIS bleibt es still.',
    );
  });

  it('„Beim Schließen in den Infobereich“ gibt es nur in der Desktop-App (Standard: an)', async () => {
    const user = userEvent.setup();
    renderApp({ hash: '#/settings' });
    expect(screen.queryByRole('switch', { name: 'Beim Schließen in den Infobereich' })).toBeNull();
    disposeApps();
    document.body.innerHTML = '';

    const { memory } = renderApp({ hash: '#/settings', platform: fakePlatform('tauri') });
    const toggle = screen.getByRole('switch', { name: 'Beim Schließen in den Infobereich' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAccessibleDescription(/Alt\+F4 beendet AEGIS vollständig/);
    await user.click(toggle);
    expect(memory.settings()?.closeToTray).toBe(false);
  });

  it('Erklärungen der Auswahlgruppen sind mit der Gruppe verknüpft (auch der aufgelöste Wert)', () => {
    stubMatchMedia({ '(prefers-reduced-motion: reduce)': true });
    renderApp({ hash: '#/settings', settings: { language: 'system', motion: 'system' } });
    expect(screen.getByRole('radiogroup', { name: 'Sprache' })).toHaveAccessibleDescription(
      '„System“ folgt der Sprache von Windows. Gerade: Deutsch',
    );
    expect(screen.getByRole('radiogroup', { name: 'Darstellung' })).toHaveAccessibleDescription(
      /^„System“ folgt der Windows-Einstellung für helle oder dunkle Apps\. Gerade: /,
    );
    expect(screen.getByRole('radiogroup', { name: 'Bewegung' })).toHaveAccessibleDescription(
      '„Reduziert“ schaltet Animationen in der ganzen App ab – auch die Start-Animation. System: reduziert',
    );
  });

  it('Sprachnamen tragen ihre eigene Sprache (lang), auch in der anderen Oberflächensprache', () => {
    renderApp({ hash: '#/settings', settings: { language: 'en' } });
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    const german = screen.getByRole('radio', { name: 'Deutsch' });
    expect(german.querySelector('[lang]')).toHaveAttribute('lang', 'de');
    expect(german.querySelector('[lang]')).toHaveTextContent('Deutsch');
    const english = screen.getByRole('radio', { name: 'English' });
    expect(english.querySelector('[lang]')).toHaveAttribute('lang', 'en');
  });

  it('ohne Symbol im Infobereich: Schalter gesperrt, aus, mit ehrlicher Erklärung', async () => {
    renderApp({
      hash: '#/settings',
      platform: fakePlatform('tauri', { ...desktopInfo, trayAvailable: false }),
    });
    const toggle = screen.getByRole('switch', { name: 'Beim Schließen in den Infobereich' });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription(/kein Symbol im Infobereich/);
    expect(toggle).toHaveAccessibleDescription(/beendet AEGIS deshalb vollständig/);
  });

  it('Speichern scheitert: Änderung wirkt trotzdem, einmalige Meldung, Hinweis auf der Seite', async () => {
    const user = userEvent.setup();
    const memory = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { bootAnimation: false, language: 'de' },
      }),
    });
    const { services } = renderApp({ hash: '#/settings', storage: memory });
    expect(screen.queryByTestId('settings-persistence')).toBeNull();
    memory.failWrites(true);

    await user.click(screen.getByRole('radio', { name: 'Hell' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(screen.getByTestId('settings-persistence')).toHaveTextContent(
      'Die Einstellungen lassen sich gerade nicht speichern.',
    );
    expect(await screen.findByText('Einstellungen nicht gespeichert')).toBeInTheDocument();
    expect(services.activity.getSnapshot().map((entry) => entry.kind)).toContain('save-failed');

    await user.click(screen.getByRole('radio', { name: 'Dunkel' }));
    expect(screen.getAllByText('Einstellungen nicht gespeichert')).toHaveLength(1);
  });

  it('Einstellungen einer neueren Version: Hinweis, nichts wird überschrieben', () => {
    const raw = JSON.stringify({ version: SETTINGS_VERSION + 1, settings: { theme: 'light' } });
    const memory = memoryStorage({ [SETTINGS_STORAGE_KEY]: raw });
    renderApp({ hash: '#/settings', storage: memory });
    expect(screen.getByTestId('settings-persistence')).toHaveTextContent('neueren AEGIS-Version');
    expect(memory.data.get(SETTINGS_STORAGE_KEY)).toBe(raw);
  });

  it('zeigt die Version und führt zu „Über AEGIS“', async () => {
    const user = userEvent.setup();
    renderApp({ hash: '#/settings' });
    expect(await screen.findByText('AEGIS 0.1.0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mehr über AEGIS' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Über AEGIS'),
    );
  });
});

describe('Über AEGIS', () => {
  it('Browser-Vorschau: Werte deutlich gekennzeichnet, keine erfundenen Systemangaben', async () => {
    renderApp({ hash: '#/about' });
    const info = await screen.findByTestId('about-preview-note');
    expect(info).toHaveTextContent(
      'Browser-Vorschau: Diese Werte stammen nicht aus der Desktop-App.',
    );
    const table = screen.getByTestId('about-info');
    expect(within(table).getByText('Plattform').nextElementSibling).toHaveTextContent(
      'Browser-Vorschau',
    );
    expect(within(table).getByText('Architektur').nextElementSibling).toHaveTextContent(
      'unbekannt',
    );
  });

  it('Desktop-App: Werte aus app_info', async () => {
    renderApp({ hash: '#/about', platform: fakePlatform('tauri') });
    const table = await screen.findByTestId('about-info');
    await waitFor(() => expect(table).toHaveTextContent(desktopInfo.osVersion ?? ''));
    expect(table).toHaveTextContent('Windows');
    expect(table).toHaveTextContent('x86_64');
    expect(table).toHaveTextContent('2.12.4');
    expect(table).toHaveTextContent('Release');
    expect(screen.queryByTestId('about-preview-note')).toBeNull();
    expect(screen.getByTestId('statusbar')).toHaveTextContent('Desktop-App');
  });

  it('Fehler beim Lesen: ehrliche Meldung statt Platzhalterwerten', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const platform = fakePlatform('tauri');
    renderApp({
      hash: '#/about',
      platform: { ...platform, appInfo: () => Promise.reject(new Error('kaputt')) },
    });
    expect(
      await screen.findByText('Die App-Informationen konnten nicht gelesen werden.'),
    ).toBeInTheDocument();
  });
});
