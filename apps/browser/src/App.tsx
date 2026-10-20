/**
 * Leiste des AEGIS Browsers: Tabs, Navigation, Adresszeile, Schutzanzeige und ein Menü mit
 * Einstellungen, Filterlisten, Lesezeichen und Ghost-Modus. Seiteninhalte laufen in eigenen
 * WebViews unter der Leiste und haben keinen Zugriff auf diese Befehle.
 */
import {
  Button,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconEye,
  IconLock,
  IconRefresh,
  IconSettings,
  IconShield,
  IconWarning,
  SafeText,
  SegmentedControl,
  Toggle,
} from '@aegis/ui';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { BrowserApi, Doh, Search, Settings, View } from './api.ts';
import { text, type Lang, type TextKey } from './texts.ts';

export function App({ api, lang }: { readonly api: BrowserApi; readonly lang: Lang }) {
  const t = useCallback(
    (key: TextKey, vars?: Record<string, string>) => text(lang, key, vars),
    [lang],
  );
  const [view, setView] = useState<View | null>(null);
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setMessage(e instanceof Error ? e.message : String(e));
  const run = (action: Promise<unknown>) => {
    action.then((v) => {
      // Befehle mit Ansicht liefern den neuen Zustand, andere nichts.
      if (typeof v === 'object' && v !== null && 'tabs' in v) {
        setView(v as View);
      }
    }, fail);
  };

  useEffect(() => {
    let active = true;
    const stops: (() => void)[] = [];
    api.state().then((v) => {
      if (active) {
        setView(v);
      }
    }, fail);
    void api.onState((v) => setView(v)).then((stop) => stops.push(stop));
    void api.onNotice((n) => setMessage(n)).then((stop) => stops.push(stop));
    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, [api]);

  const active = view?.tabs.find((tab) => tab.id === view.active) ?? null;
  const shown = editing ? input : active && active.url !== 'about:blank' ? active.url : '';

  const toggleMenu = (open: boolean) => {
    setMenu(open);
    void api.contentVisible(!open).catch(fail);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (active === null || input.trim() === '') {
      return;
    }
    setEditing(false);
    run(api.go(active.id, input));
  };

  const save = (change: Partial<Settings>) => {
    if (view !== null) {
      run(api.saveSettings({ ...view.settings, ...change }));
    }
  };

  const updateLists = () => {
    setBusy(true);
    api.updateLists().then(
      (v) => {
        setView(v);
        setBusy(false);
      },
      (e: unknown) => {
        fail(e);
        setBusy(false);
      },
    );
  };

  if (view === null) {
    return <div className="h-[88px] bg-surface" />;
  }

  const date = view.listsUpdated
    ? new Date(view.listsUpdated * 1000).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB')
    : '';

  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      {/* Tabs */}
      <div role="tablist" aria-label={t('tabs')} className="flex h-9 items-end gap-1 px-2 pt-1">
        {view.ghost && (
          <span className="mr-1 flex items-center gap-1 rounded-md bg-surface-3 px-2 py-0.5 text-2xs text-accent">
            <IconEye aria-hidden="true" />
            {view.tor ? t('ghostTor') : t('ghost')}
          </span>
        )}
        {view.tabs.map((tab) => {
          const selected = tab.id === view.active;
          return (
            <div
              key={tab.id}
              className={`group flex h-8 max-w-56 min-w-0 flex-1 items-center gap-1 rounded-t-lg px-2 text-xs ${
                selected ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2/60'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => run(api.selectTab(tab.id))}
              >
                <SafeText value={tab.title || tab.host || t('newPage')} />
              </button>
              <button
                type="button"
                aria-label={t('closeTab')}
                className="rounded p-0.5 opacity-70 hover:bg-surface-3 hover:opacity-100 [&_svg]:size-3"
                onClick={() => run(api.closeTab(tab.id))}
              >
                <IconClose aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label={t('newTab')}
          className="mb-1 rounded-md px-2 text-lg leading-none text-text-muted hover:bg-surface-2"
          onClick={() => run(api.openTab())}
        >
          +
        </button>
      </div>

      {/* Navigation + Adresszeile */}
      <div className="flex h-[52px] items-center gap-1.5 border-b border-border bg-surface-2 px-2">
        <IconButton label={t('back')} onClick={() => active && run(api.back(active.id))}>
          <IconChevronLeft aria-hidden="true" />
        </IconButton>
        <IconButton label={t('forward')} onClick={() => active && run(api.forward(active.id))}>
          <IconChevronRight aria-hidden="true" />
        </IconButton>
        <IconButton label={t('reload')} onClick={() => active && run(api.reload(active.id))}>
          <IconRefresh aria-hidden="true" />
        </IconButton>
        <form className="flex min-w-0 flex-1 items-center" onSubmit={submit} role="search">
          <span
            className={`mr-1 [&_svg]:size-4 ${active?.secure ? 'text-success' : 'text-warn'}`}
            title={active?.secure ? t('secure') : t('insecure')}
          >
            {active?.secure ? (
              <IconLock aria-label={t('secure')} />
            ) : (
              <IconWarning aria-label={t('insecure')} />
            )}
          </span>
          <input
            aria-label={t('address')}
            placeholder={t('address')}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none"
            value={shown}
            spellCheck={false}
            autoComplete="off"
            onFocus={(e) => {
              setInput(shown);
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
        {active?.insecure && (
          <Button size="sm" variant="ghost" onClick={() => run(api.allowHttp(active.id))}>
            {t('allowHttp')}
          </Button>
        )}
        <span
          className={`flex items-center gap-1 text-2xs ${view.filtering ? 'text-success' : 'text-text-subtle'}`}
          data-testid="shield"
        >
          <IconShield aria-hidden="true" />
          {view.filtering ? t('blocking', { count: String(view.rules) }) : t('notBlocking')}
        </span>
        <IconButton
          label={t('bookmark')}
          onClick={() =>
            active && active.url !== 'about:blank' && run(api.addBookmark(active.title, active.url))
          }
        >
          <span aria-hidden="true">☆</span>
        </IconButton>
        <IconButton label={menu ? t('closeMenu') : t('menu')} onClick={() => toggleMenu(!menu)}>
          {menu ? <IconClose aria-hidden="true" /> : <IconSettings aria-hidden="true" />}
        </IconButton>
      </div>

      {message !== null && (
        <p role="status" className="bg-surface-3 px-3 py-1 text-xs text-text-muted">
          <SafeText value={message} />
        </p>
      )}

      {menu && (
        <div className="flex-1 overflow-auto p-6" data-testid="menu">
          <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
            <section aria-label={t('settings')} className="space-y-4">
              <h2 className="font-semibold">{t('settings')}</h2>
              <Toggle
                label={t('httpsOnly')}
                checked={view.settings.httpsOnly}
                onCheckedChange={(httpsOnly) => save({ httpsOnly })}
              />
              <Toggle
                label={t('blockTrackers')}
                checked={view.settings.blockTrackers}
                onCheckedChange={(blockTrackers) => save({ blockTrackers })}
              />
              <Toggle
                label={t('javascript')}
                checked={view.settings.javascript}
                onCheckedChange={(javascript) => save({ javascript })}
              />
              <SegmentedControl<Doh>
                label={t('doh')}
                value={view.settings.doh}
                onValueChange={(doh) => save({ doh })}
                options={[
                  { value: 'quad9', label: 'Quad9' },
                  { value: 'mullvad', label: 'Mullvad' },
                  { value: 'cloudflare', label: 'Cloudflare' },
                  { value: 'off', label: t('dohOff') },
                ]}
              />
              <SegmentedControl<Search>
                label={t('search')}
                value={view.settings.search}
                onValueChange={(search) => save({ search })}
                options={[
                  { value: 'duck_duck_go', label: 'DuckDuckGo' },
                  { value: 'startpage', label: 'Startpage' },
                  { value: 'brave', label: 'Brave' },
                ]}
              />
              <p className="text-xs text-text-muted">{t('restartHint')}</p>
            </section>
            <section aria-label={t('lists')} className="space-y-3">
              <h2 className="font-semibold">{t('lists')}</h2>
              <p className="text-sm text-text-muted" data-testid="lists">
                {view.rules > 0
                  ? t('listsLoaded', { count: String(view.rules), date })
                  : t('listsNone')}
              </p>
              <Button size="sm" variant="secondary" loading={busy} onClick={updateLists}>
                {t('listsUpdate')}
              </Button>
              <p className="text-xs text-text-muted">{t('listsHint')}</p>
              <p className="text-xs text-text-subtle">{t('windowsOnly')}</p>
              <h2 className="pt-2 font-semibold">{t('ghostTitle')}</h2>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => run(api.openGhost(false))}>
                  {t('ghostOpen')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => run(api.openGhost(true))}>
                  {t('ghostTorOpen')}
                </Button>
              </div>
              <p className="text-xs text-text-muted">{t('ghostHint')}</p>
              <p className="text-xs text-warn">{t('honest')}</p>
            </section>
            <section aria-label={t('bookmarks')} className="space-y-2 md:col-span-2">
              <h2 className="font-semibold">{t('bookmarks')}</h2>
              {view.bookmarks.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noBookmarks')}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {view.bookmarks.map((b) => (
                    <li key={b.url} className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="min-w-0 truncate text-left text-accent hover:underline"
                        onClick={() => {
                          toggleMenu(false);
                          if (active) {
                            run(api.go(active.id, b.url));
                          }
                        }}
                      >
                        <SafeText value={b.title} />
                      </button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => run(api.removeBookmark(b.url))}
                      >
                        {t('remove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-md text-text-muted hover:bg-surface-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent [&_svg]:size-4"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
