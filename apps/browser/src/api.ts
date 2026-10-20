/**
 * Schnittstelle der Leiste zum Rust-Teil des Browsers. Antworten werden streng geprüft
 * (Fremdinhalte wie Seitentitel kommen hier als Text an und werden nur als Text gezeigt).
 */

export type Search = 'duck_duck_go' | 'startpage' | 'brave';

export interface Settings {
  readonly httpsOnly: boolean;
  readonly blockTrackers: boolean;
  readonly javascript: boolean;
  readonly search: Search;
  readonly home: string | null;
}

export interface TabView {
  readonly id: number;
  readonly url: string;
  readonly host: string;
  readonly title: string;
  readonly loading: boolean;
  readonly secure: boolean;
  readonly insecure: string | null;
}

export interface Bookmark {
  readonly title: string;
  readonly url: string;
}

export interface View {
  readonly window: string;
  readonly ghost: boolean;
  readonly tor: boolean;
  /** Port des SOCKS-Proxys im Tor-Modus. */
  readonly proxyPort: number | null;
  readonly tabs: readonly TabView[];
  readonly active: number | null;
  readonly settings: Settings;
  readonly bookmarks: readonly Bookmark[];
  readonly rules: number;
  readonly listsUpdated: number | null;
  readonly filtering: boolean;
}

export interface BrowserApi {
  state(): Promise<View>;
  openTab(): Promise<View>;
  closeTab(id: number): Promise<View>;
  selectTab(id: number): Promise<View>;
  go(id: number, input: string): Promise<View>;
  back(id: number): Promise<void>;
  forward(id: number): Promise<void>;
  reload(id: number): Promise<void>;
  allowHttp(id: number): Promise<View>;
  contentVisible(visible: boolean): Promise<void>;
  saveSettings(settings: Settings): Promise<View>;
  updateLists(): Promise<View>;
  addBookmark(title: string, url: string): Promise<View>;
  removeBookmark(url: string): Promise<View>;
  openGhost(tor: boolean): Promise<void>;
  onState(listener: (view: View) => void): Promise<() => void>;
  onNotice(listener: (text: string) => void): Promise<() => void>;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

function oneOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
  return (values as readonly unknown[]).includes(v) ? (v as T) : fallback;
}

export const searchValues = ['duck_duck_go', 'startpage', 'brave'] as const;

export function parseSettings(v: unknown): Settings {
  const o = isObject(v) ? v : {};
  return {
    httpsOnly: o['httpsOnly'] !== false,
    blockTrackers: o['blockTrackers'] !== false,
    javascript: o['javascript'] !== false,
    search: oneOf(searchValues, o['search'], 'duck_duck_go'),
    home: typeof o['home'] === 'string' ? o['home'].slice(0, 2048) : null,
  };
}

export function parseView(v: unknown): View {
  const o = isObject(v) ? v : {};
  return {
    window: str(o['window'], 64),
    ghost: o['ghost'] === true,
    tor: o['tor'] === true,
    proxyPort:
      typeof o['proxyPort'] === 'number' && Number.isInteger(o['proxyPort'])
        ? o['proxyPort']
        : null,
    tabs: arr(o['tabs'])
      .filter(isObject)
      .slice(0, 64)
      .map((t) => ({
        id: num(t['id']),
        url: str(t['url']),
        host: str(t['host'], 253),
        title: str(t['title'], 200),
        loading: t['loading'] === true,
        secure: t['secure'] === true,
        insecure: typeof t['insecure'] === 'string' ? t['insecure'].slice(0, 4096) : null,
      })),
    active: typeof o['active'] === 'number' ? o['active'] : null,
    settings: parseSettings(o['settings']),
    bookmarks: arr(o['bookmarks'])
      .filter(isObject)
      .slice(0, 1000)
      .map((b) => ({ title: str(b['title'], 120), url: str(b['url'], 2048) })),
    rules: num(o['rules']),
    listsUpdated: typeof o['listsUpdated'] === 'number' ? o['listsUpdated'] : null,
    filtering: o['filtering'] === true,
  };
}

/** Echte Anbindung über Tauri. */
export async function tauriApi(): Promise<BrowserApi> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const view = async (cmd: string, args?: Record<string, unknown>) =>
    parseView(await invoke<unknown>(cmd, args));
  return {
    state: () => view('browser_state'),
    openTab: () => view('tab_open'),
    closeTab: (id) => view('tab_close', { id }),
    selectTab: (id) => view('tab_select', { id }),
    go: (id, input) => view('tab_go', { id, input }),
    back: (id) => invoke('tab_back', { id }),
    forward: (id) => invoke('tab_forward', { id }),
    reload: (id) => invoke('tab_reload', { id }),
    allowHttp: (id) => view('tab_allow_http', { id }),
    contentVisible: (visible) => invoke('content_visible', { visible }),
    saveSettings: (settings) => view('settings_save', { settings }),
    updateLists: () => view('lists_update'),
    addBookmark: (title, url) => view('bookmark_add', { title, url }),
    removeBookmark: (url) => view('bookmark_remove', { url }),
    openGhost: (tor) => invoke('ghost_open', { tor }),
    onState: (listener) =>
      listen<unknown>('browser://state', (e) => listener(parseView(e.payload))),
    onNotice: (listener) =>
      listen<unknown>('browser://notice', (e) => listener(str(e.payload, 500))),
  };
}
