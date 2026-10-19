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

/** Angehaltener Host; kurz nachfragen, falls der Hintergrund gerade erst aufwacht. */
async function blockedHost(): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer: unknown = await chrome.runtime.sendMessage({ type: 'blocked-url' });
    const url =
      typeof answer === 'object' && answer !== null ? (answer as { url?: unknown }).url : null;
    const host = typeof url === 'string' ? hostOf(url) : null;
    if (host !== null) {
      return host;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  return null;
}

async function render(): Promise<void> {
  if (app === null) {
    return;
  }
  const host = await blockedHost();

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
    ...(host !== null
      ? [
          el('p', { className: 'muted' }, t.warnHint),
          confirm,
          el('div', { className: 'row' }, open),
        ]
      : []),
  );
  back.focus();
}

void render();
