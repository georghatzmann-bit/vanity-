import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { parseView, type BrowserApi, type View } from './api.ts';
import { lang } from './texts.ts';

function view(over: Partial<View> = {}): View {
  return parseView({
    window: 'win-1',
    ghost: false,
    tor: false,
    tabs: [
      {
        id: 1,
        url: 'https://example.org/',
        host: 'example.org',
        title: '<b>Beispiel</b>',
        loading: false,
        secure: true,
        insecure: null,
      },
      {
        id: 2,
        url: 'https://news.example/',
        host: 'news.example',
        title: '',
        loading: false,
        secure: true,
        insecure: 'http://news.example/',
      },
    ],
    active: 1,
    settings: {
      httpsOnly: true,
      blockTrackers: true,
      javascript: true,
      search: 'duck_duck_go',
      home: null,
    },
    bookmarks: [],
    rules: 0,
    listsUpdated: null,
    filtering: false,
    ...over,
  });
}

function fakeApi(initial: View): BrowserApi & { calls: string[] } {
  const calls: string[] = [];
  let current = initial;
  const record = (name: string, next?: Partial<View>) => {
    calls.push(name);
    current = { ...current, ...next };
    return Promise.resolve(current);
  };
  return {
    calls,
    state: () => Promise.resolve(current),
    openTab: vi.fn(() => record('openTab')),
    closeTab: vi.fn((id: number) => record(`closeTab:${id}`)),
    selectTab: vi.fn((id: number) => record(`selectTab:${id}`, { active: id })),
    go: vi.fn((id: number, input: string) => record(`go:${id}:${input}`)),
    back: vi.fn(() => Promise.resolve()),
    forward: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    allowHttp: vi.fn((id: number) => record(`allowHttp:${id}`)),
    contentVisible: vi.fn((v: boolean) => {
      calls.push(`content:${v}`);
      return Promise.resolve();
    }),
    saveSettings: vi.fn((s) => record('save', { settings: s })),
    updateLists: vi.fn(() => record('lists', { rules: 120, listsUpdated: 1_760_000_000 })),
    addBookmark: vi.fn((title: string, url: string) =>
      record(`bookmark:${url}`, { bookmarks: [{ title, url }] }),
    ),
    removeBookmark: vi.fn((url: string) => record(`unbookmark:${url}`, { bookmarks: [] })),
    openGhost: vi.fn(() => Promise.resolve()),
    onState: () => Promise.resolve(() => undefined),
    onNotice: () => Promise.resolve(() => undefined),
  };
}

describe('Browser-Leiste', () => {
  it('zeigt Tabs (Titel nur als Text) und wechselt per Klick', async () => {
    const api = fakeApi(view());
    render(<App api={api} lang="de" />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('<b>Beispiel</b>');
    expect(tabs[0]?.querySelector('b')).toBeNull();
    expect(tabs[1]).toHaveTextContent('news.example');
    fireEvent.click(tabs[1] as HTMLElement);
    await waitFor(() => expect(api.calls).toContain('selectTab:2'));
  });

  it('Tabs per Tastatur: nur der aktive ist im Fokus-Weg, Pfeile wechseln', async () => {
    const api = fakeApi(view());
    render(<App api={api} lang="de" />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    await waitFor(() => expect(api.calls).toContain('selectTab:2'));
    fireEvent.keyDown(screen.getAllByRole('tab')[1] as HTMLElement, { key: 'Home' });
    await waitFor(() => expect(api.calls).toContain('selectTab:1'));
  });

  it('Adresszeile schickt die Eingabe an den aktiven Tab', async () => {
    const api = fakeApi(view());
    render(<App api={api} lang="de" />);
    const field = await screen.findByLabelText('Adresse oder Suche');
    expect(field).toHaveValue('https://example.org/');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'wetter berlin' } });
    fireEvent.submit(field);
    await waitFor(() => expect(api.calls).toContain('go:1:wetter berlin'));
  });

  it('HTTP nur nach ausdrücklichem Klick (mit Host), Blocker ehrlich ohne Listen', async () => {
    const api = fakeApi(view({ active: 2 }));
    render(<App api={api} lang="de" />);
    expect(await screen.findByTestId('shield')).toHaveTextContent('Blocker ohne Listen');
    fireEvent.click(
      await screen.findByRole('button', { name: 'news.example unverschlüsselt (HTTP) öffnen' }),
    );
    await waitFor(() => expect(api.calls).toContain('allowHttp:2'));
  });

  it('Blocker aus heißt „aus“, Tor-Fenster nennt den Proxy ehrlich', async () => {
    const base = view();
    const api = fakeApi(
      view({
        ghost: true,
        tor: true,
        proxyPort: 9150,
        settings: { ...base.settings, blockTrackers: false },
      }),
    );
    render(<App api={api} lang="de" />);
    expect(await screen.findByTestId('shield')).toHaveTextContent('Blocker aus');
    const badge = screen.getByText('Ghost · Tor-Proxy');
    expect(badge.closest('[title]')?.getAttribute('title')).toContain(
      'AEGIS kann nicht prüfen, ob dort wirklich Tor läuft',
    );
  });

  it('Menü verdeckt die Seite, Listen laden nur auf Klick, ehrlicher Tor-Hinweis', async () => {
    const api = fakeApi(view());
    render(<App api={api} lang="de" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Menü' }));
    const menu = await screen.findByTestId('menu');
    expect(api.calls).toContain('content:false');
    expect(api.updateLists).not.toHaveBeenCalled();
    expect(menu).toHaveTextContent('Tor Browser deutlich stärker');
    // Kein DoH-Schalter, der nichts bewirkt – ehrlicher Hinweis auf das DNS von Windows.
    expect(within(menu).queryByText('DNS-over-HTTPS')).toBeNull();
    expect(within(menu).getByTestId('dns-hint')).toHaveTextContent('DNS von Windows');
    fireEvent.click(within(menu).getByRole('button', { name: 'EasyList + EasyPrivacy laden' }));
    await waitFor(() => expect(within(menu).getByTestId('lists')).toHaveTextContent('120 Regeln'));
    fireEvent.click(within(menu).getByRole('switch', { name: 'JavaScript erlauben' }));
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ javascript: false })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Menü schließen' }));
    expect(api.calls).toContain('content:true');
  });

  it('Sprache und Parser', () => {
    expect(lang(['de-AT'])).toBe('de');
    expect(lang(['en-US'])).toBe('en');
    const v = parseView({
      tabs: [{ id: 'x', title: 5 }],
      settings: { search: 1 },
      proxyPort: 1.5,
    });
    expect(v.tabs[0]?.id).toBe(0);
    expect(v.settings.search).toBe('duck_duck_go');
    expect(v.proxyPort).toBeNull();
    expect(v.settings.httpsOnly).toBe(true);
  });
});
