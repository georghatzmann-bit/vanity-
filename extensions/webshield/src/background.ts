/**
 * Hintergrund der Web-Schutz-Erweiterung (Service Worker).
 *
 * - Lädt (abschaltbar) öffentliche Sperrlisten und legt sie als dynamische
 *   `declarativeNetRequest`-Regeln an: bekannte Seiten werden auf die Warnseite umgeleitet.
 *   Der Browser prüft die Adressen selbst – die Erweiterung sieht dabei keinen Verlauf.
 * - Merkt sich je Tab nur die zuletzt aufgerufene Adresse (Sitzungsspeicher), damit die
 *   Warnseite sie anzeigen und auf Wunsch einmalig freigeben kann.
 * - Weist bei riskanten Downloads per Benachrichtigung hin (bricht nie ab, löscht nichts).
 */

import { hostOf, parseList } from './lib/domains';
import { downloadRisks } from './lib/downloads';
import { texts } from './lib/i18n';
import { ALLOW_BASE, allowRule, blockRules, type Category, type Rule } from './lib/rules';
import {
  categoryBase,
  MAX_LIST_BYTES,
  MAX_TOTAL_DOMAINS,
  SOURCES,
  UPDATE_MINUTES,
  type Source,
} from './lib/sources';
import {
  EMPTY_STATUS,
  isMessage,
  readSettings,
  readStatus,
  updateDue,
  type ListStatus,
  type SourceStatus,
} from './lib/settings';

const ALARM = 'aegis-lists';
const NAV = 'nav:';
const NEXT_ALLOW = 'nextAllow';

type DnrRule = chrome.declarativeNetRequest.Rule;

/** Unsere Regel-Objekte entsprechen dem DNR-Format (Zeichenketten statt Enum-Typen). */
function toDnr(rules: readonly Rule[]): DnrRule[] {
  return rules as unknown as DnrRule[];
}

async function settings() {
  return readSettings((await chrome.storage.local.get('settings')).settings);
}

async function status(): Promise<ListStatus> {
  return readStatus((await chrome.storage.local.get('status')).status);
}

/** Liest eine Antwort bis höchstens `max` Bytes. */
async function readLimited(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error('Liste zu groß');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchList(source: Source): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(source.url, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return parseList(await readLimited(response, MAX_LIST_BYTES), source.max);
  } finally {
    clearTimeout(timer);
  }
}

function inCategory(rule: DnrRule, category: Category): boolean {
  const base = categoryBase(category);
  return rule.id >= base && rule.id < base + 1000;
}

function isBlockRule(rule: DnrRule): boolean {
  return rule.id < ALLOW_BASE;
}

let running: Promise<ListStatus> | null = null;

/** Aktualisiert die Listen (nie parallel). Fehlt eine Quelle, bleibt ihre Kategorie wie sie war. */
function updateLists(): Promise<ListStatus> {
  running ??= doUpdate().finally(() => {
    running = null;
  });
  return running;
}

async function doUpdate(): Promise<ListStatus> {
  const results = await Promise.all(
    SOURCES.map(async (source) => {
      try {
        return { source, domains: await fetchList(source), error: null };
      } catch (e) {
        return { source, domains: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const seen = new Set<string>();
  const remove: number[] = [];
  const add: DnrRule[] = [];
  const replaced = new Set<Category>();
  for (const category of new Set(SOURCES.map((s) => s.category))) {
    const own = results.filter((r) => r.source.category === category);
    if (own.some((r) => r.error !== null)) {
      continue;
    }
    const domains: string[] = [];
    for (const r of own) {
      for (const d of r.domains) {
        if (seen.size >= MAX_TOTAL_DOMAINS) {
          break;
        }
        if (!seen.has(d)) {
          seen.add(d);
          domains.push(d);
        }
      }
    }
    replaced.add(category);
    remove.push(...existing.filter((r) => inCategory(r, category)).map((r) => r.id));
    add.push(...toDnr(blockRules(category, domains, categoryBase(category))));
  }
  if (remove.length > 0 || add.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: remove, addRules: add });
  }
  const kept = existing
    .filter((r) => isBlockRule(r) && ![...replaced].some((c) => inCategory(r, c)))
    .reduce((sum, r) => sum + (r.condition.requestDomains?.length ?? 0), 0);
  const sources: SourceStatus[] = results.map((r) =>
    r.error === null
      ? { id: r.source.id, domains: r.domains.length, ok: true }
      : { id: r.source.id, domains: 0, ok: false, error: r.error },
  );
  const previous = await status();
  const next: ListStatus = {
    // Nur bei vollem Erfolg gilt die Aktualisierung als erledigt; sonst nächste Stunde erneut.
    updatedAt: sources.every((s) => s.ok) ? Date.now() : previous.updatedAt,
    sources,
    domains: kept + seen.size,
  };
  await chrome.storage.local.set({ status: next });
  return next;
}

/** Ausgeschaltet: geladene Listen wieder entfernen (mitgelieferte Liste bleibt). */
async function dropLists(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing.filter(isBlockRule).map((r) => r.id);
  if (ids.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  }
  await chrome.storage.local.set({ status: EMPTY_STATUS });
}

async function maybeUpdate(): Promise<void> {
  if ((await settings()).updateLists && updateDue(await status(), Date.now(), UPDATE_MINUTES)) {
    await updateLists();
  }
}

/** Einmalige Freigabe (nur diese Browser-Sitzung) für die Adresse, die im Tab angehalten wurde. */
async function allowOnce(tabId: number): Promise<boolean> {
  const key = `${NAV}${tabId}`;
  const url = (await chrome.storage.session.get(key))[key];
  const host = typeof url === 'string' ? hostOf(url) : null;
  if (typeof url !== 'string' || host === null) {
    return false;
  }
  const stored = (await chrome.storage.session.get(NEXT_ALLOW))[NEXT_ALLOW];
  const id = typeof stored === 'number' ? stored : ALLOW_BASE;
  await chrome.storage.session.set({ [NEXT_ALLOW]: id + 1 });
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: toDnr([allowRule(host, id)]) });
  await chrome.tabs.update(tabId, { url });
  return true;
}

async function blockedUrl(tabId: number): Promise<string | null> {
  const key = `${NAV}${tabId}`;
  const url = (await chrome.storage.session.get(key))[key];
  return typeof url === 'string' ? url : null;
}

async function notifyDownload(id: number): Promise<void> {
  if (!(await settings()).downloadHints) {
    return;
  }
  const [item] = await chrome.downloads.search({ id });
  if (item === undefined) {
    return;
  }
  const risks = downloadRisks(item.filename, item.finalUrl || item.url);
  if (risks.length === 0) {
    return;
  }
  const t = texts(chrome.i18n.getUILanguage());
  const name = item.filename.split(/[\\/]/).pop() ?? '';
  await chrome.notifications.create(`aegis-download-${id}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title: t.downloadTitle,
    message: `${name}\n${risks.map((r) => t.risk[r]).join(' ')}\n${t.downloadAdvice}`,
    priority: 1,
  });
}

function fromPage(sender: chrome.runtime.MessageSender, page: string): boolean {
  return (
    sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(page)) === true
  );
}

// --- Ereignisse (oberste Ebene, damit der Service Worker sie nach dem Aufwachen kennt) ---

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: 60, delayInMinutes: 1 });
  void maybeUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  void maybeUpdate();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    void maybeUpdate();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || changes.settings === undefined) {
    return;
  }
  const before = readSettings(changes.settings.oldValue);
  const after = readSettings(changes.settings.newValue);
  if (before.updateLists && !after.updateLists) {
    void dropLists();
  } else if (!before.updateLists && after.updateLists) {
    void updateLists();
  }
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0 && hostOf(details.url) !== null) {
    void chrome.storage.session.set({ [`${NAV}${details.tabId}`]: details.url });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`${NAV}${tabId}`);
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.filename?.current) {
    void notifyDownload(delta.id);
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, reply: (value: unknown) => void) => {
  if (!isMessage(raw)) {
    return false;
  }
  const tabId = sender.tab?.id;
  if (raw.type === 'blocked-url' && fromPage(sender, 'warn.html') && tabId !== undefined) {
    void blockedUrl(tabId).then((url) => reply({ url }));
    return true;
  }
  if (raw.type === 'allow-once' && fromPage(sender, 'warn.html') && tabId !== undefined) {
    void allowOnce(tabId).then((ok) => reply({ ok }));
    return true;
  }
  if (raw.type === 'update-now' && fromPage(sender, 'options.html')) {
    void settings().then(async (s) => reply(s.updateLists ? await updateLists() : await status()));
    return true;
  }
  return false;
});
