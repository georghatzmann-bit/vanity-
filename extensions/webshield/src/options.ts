/** Einstellungen der Erweiterung: Listen-Aktualisierung, Hinweise, Status, Quellen. */

import { el } from './lib/dom';
import { texts } from './lib/i18n';
import { readSettings, readStatus, type ListStatus, type Settings } from './lib/settings';
import { SOURCES } from './lib/sources';
import { applyTheme } from './lib/theme';

applyTheme(document, ':root');
const language = navigator.language;
const t = texts(language);
document.documentElement.lang = language.toLowerCase().startsWith('de') ? 'de' : 'en';
const app = document.getElementById('app');

function toggle(
  id: keyof Settings,
  label: string,
  current: Settings,
  hint?: string,
): HTMLLabelElement {
  const box = el('input');
  box.type = 'checkbox';
  box.id = id;
  box.checked = current[id];
  box.addEventListener('change', () => {
    void chrome.storage.local.get('settings').then((stored) =>
      chrome.storage.local.set({
        settings: { ...readSettings(stored.settings), [id]: box.checked },
      }),
    );
  });
  const text = el('span', {}, label, hint !== undefined ? el('br') : null);
  if (hint !== undefined) {
    text.append(el('span', { className: 'muted' }, hint));
  }
  const wrap = el('label', {}, box, text);
  wrap.htmlFor = id;
  return wrap;
}

function statusView(status: ListStatus): HTMLElement {
  const when =
    status.updatedAt > 0
      ? `${t.statusAt}: ${new Date(status.updatedAt).toLocaleString(language)}`
      : t.statusNever;
  const list = el('ul');
  for (const source of SOURCES) {
    const s = status.sources.find((x) => x.id === source.id);
    const line = el('li', {}, `${source.id}: `);
    if (s === undefined) {
      line.append('–');
    } else if (s.ok) {
      line.append(el('span', { className: 'ok' }, s.domains.toLocaleString(language)));
    } else {
      line.append(el('span', { className: 'fail' }, `${t.sourceFailed} (${s.error ?? ''})`));
    }
    list.append(line);
  }
  return el(
    'div',
    { className: 'card', id: 'status' },
    el('p', {}, when),
    el('p', {}, `${t.statusDomains}: ${status.domains.toLocaleString(language)}`),
    el('p', { className: 'muted' }, t.statusBundled),
    list,
  );
}

async function render(): Promise<void> {
  if (app === null) {
    return;
  }
  const stored = await chrome.storage.local.get(['settings', 'status']);
  const current = readSettings(stored.settings);
  const update = el('button', { className: 'primary' }, t.updateNow);
  update.type = 'button';
  update.addEventListener('click', () => {
    update.disabled = true;
    update.textContent = t.updating;
    void chrome.runtime.sendMessage({ type: 'update-now' }).then((answer: unknown) => {
      document.getElementById('status')?.replaceWith(statusView(readStatus(answer)));
      update.disabled = false;
      update.textContent = t.updateNow;
    });
  });
  const sources = el('ul');
  for (const s of SOURCES) {
    const link = el('a', {}, s.homepage);
    link.href = s.homepage;
    link.target = '_blank';
    link.rel = 'noreferrer';
    sources.append(el('li', {}, `${s.id} (${s.license}): `, link));
  }
  const bundled = el('a', {}, 'https://github.com/blocklistproject/Lists');
  bundled.href = 'https://github.com/blocklistproject/Lists';
  bundled.target = '_blank';
  bundled.rel = 'noreferrer';
  sources.append(el('li', {}, 'blocklistproject ransomware/scam (Unlicense): ', bundled));

  app.replaceChildren(
    el('h1', {}, t.optionsTitle),
    el('p', { className: 'muted' }, t.optionsLead),
    el(
      'div',
      { className: 'card' },
      toggle('updateLists', t.optUpdate, current, t.optUpdateHint),
      toggle('pageHints', t.optPage, current),
      toggle('downloadHints', t.optDownload, current),
    ),
    el('h2', {}, t.status),
    statusView(readStatus(stored.status)),
    el('div', { className: 'row' }, update),
    el('h2', {}, t.sources),
    sources,
    el('p', { className: 'muted' }, t.honest),
  );
}

void render();
