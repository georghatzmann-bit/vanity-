/** Warnseite: zeigt, warum angehalten wurde; „Trotzdem öffnen“ nur nach ausdrücklicher Bestätigung. */

import { hostOf } from './lib/domains';
import { el } from './lib/dom';
import { texts } from './lib/i18n';
import { categoryFrom } from './lib/rules';
import { applyTheme } from './lib/theme';

applyTheme(document, ':root');
const t = texts(navigator.language);
document.documentElement.lang = navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
const app = document.getElementById('app');
const category = categoryFrom(location.search);

interface BlockedInfo {
  readonly host: string | null;
  readonly allowable: boolean;
}

/** Angehaltener Host; kurz nachfragen, falls der Hintergrund gerade erst aufwacht. */
async function blockedInfo(): Promise<BlockedInfo> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const answer: unknown = await chrome.runtime.sendMessage({ type: 'blocked-url' });
    const o =
      typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {};
    const host = typeof o.url === 'string' ? hostOf(o.url) : null;
    if (host !== null) {
      return { host, allowable: o.allowable === true };
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return { host: null, allowable: false };
}

async function render(): Promise<void> {
  if (app === null) {
    return;
  }
  const { host, allowable } = await blockedInfo();

  const back = el('button', { className: 'primary' }, t.warnBack);
  back.type = 'button';
  back.addEventListener('click', () => {
    if (history.length > 1) {
      history.back();
    } else {
      location.replace('about:blank');
    }
  });

  const understand = el('input');
  understand.type = 'checkbox';
  understand.id = 'understand';
  const open = el('button', {}, t.warnOpen);
  open.type = 'button';
  open.disabled = true;
  understand.addEventListener('change', () => {
    open.disabled = !understand.checked;
  });
  open.addEventListener('click', () => {
    open.disabled = true;
    void chrome.runtime.sendMessage({ type: 'allow-once' });
  });
  const confirm = el('label', {}, understand, t.warnUnderstand);
  confirm.htmlFor = 'understand';

  app.replaceChildren(
    el('h1', {}, t.warnTitle),
    el('p', {}, t.warnLead),
    el(
      'div',
      { className: 'card danger' },
      el('p', { className: 'host' }, host ?? t.warnUnknown),
      el('strong', {}, category !== null ? t.category[category] : ''),
    ),
    el('div', { className: 'row' }, back),
    ...(host !== null && allowable
      ? [
          el('p', { className: 'muted' }, t.warnHint),
          confirm,
          el('div', { className: 'row' }, open),
        ]
      : host !== null
        ? [el('p', { className: 'muted' }, t.warnRedirect)]
        : []),
  );
  back.focus();
}

void render();
