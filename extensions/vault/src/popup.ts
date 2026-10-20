/**
 * Popup: listet die Logins für die Seite im aktiven Tab und setzt einen auf Klick ein. Alle
 * Anfragen laufen über das Inhaltsskript dieser Seite – so bestimmt immer der Browser die
 * Adresse, nie das Popup oder die Seite.
 */

import { el } from './lib/dom';
import { texts } from './lib/i18n';
import type { Login, PopupAnswer, PopupRequest } from './lib/messages';
import { applyTheme } from './lib/theme';

const t = texts(navigator.language);
document.documentElement.lang = navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
applyTheme(document, ':root');
const app = document.getElementById('app');

function isAnswer(v: unknown): v is PopupAnswer {
  return typeof v === 'object' && v !== null && 'type' in v;
}

async function send(tabId: number, request: PopupRequest): Promise<PopupAnswer | null> {
  try {
    const answer: unknown = await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
    return isAnswer(answer) ? answer : null;
  } catch {
    return null;
  }
}

function render(...children: (Node | string | null)[]): void {
  app?.replaceChildren(
    el('h1', {}, t.menuTitle),
    ...children.filter((c): c is Node | string => c !== null),
    el('p', { className: 'muted small' }, t.popupHonest),
  );
}

function row(tabId: number, login: Login, status: HTMLElement): HTMLLIElement {
  const button = el('button', { className: 'primary' }, t.popupFill);
  button.type = 'button';
  button.addEventListener('click', () => {
    button.disabled = true;
    void send(tabId, { type: 'popup-fill', id: login.id }).then((answer) => {
      button.disabled = false;
      if (answer?.type === 'filled') {
        status.textContent = t.popupFilled;
        status.className = 'ok';
        setTimeout(() => window.close(), 600);
      } else {
        status.textContent =
          answer === null
            ? t.popupNoPage
            : answer.type === 'no_field'
              ? t.popupNoField
              : answer.type === 'error'
                ? t.error[answer.code]
                : t.error.invalid;
        status.className = 'fail';
      }
    });
  });
  return el(
    'li',
    {},
    el(
      'div',
      { className: 'who' },
      login.title,
      el('span', {}, login.username === '' ? t.noUser : login.username),
    ),
    button,
  );
}

async function main(): Promise<void> {
  render(el('p', { className: 'muted' }, t.loading));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (tabId === undefined) {
    render(el('p', { className: 'muted' }, t.popupNoPage));
    return;
  }
  const answer = await send(tabId, { type: 'popup-logins' });
  if (answer === null) {
    render(el('p', { className: 'muted' }, t.popupNoPage));
    return;
  }
  if (answer.type === 'error') {
    render(el('p', { className: 'fail' }, t.error[answer.code]));
    return;
  }
  if (answer.type !== 'logins') {
    render(el('p', { className: 'fail' }, t.error.invalid));
    return;
  }
  const status = el('p', { className: 'muted' });
  status.setAttribute('role', 'status');
  const lead = el(
    'p',
    { className: 'muted' },
    `${t.popupLead} `,
    el('span', { className: 'host' }, answer.origin),
  );
  const insecure = answer.origin.startsWith('http:')
    ? el('p', { className: 'fail' }, t.insecure)
    : null;
  render(
    lead,
    insecure,
    answer.logins.length === 0
      ? el('p', { className: 'muted' }, t.none)
      : el('ul', { className: 'logins' }, ...answer.logins.map((l) => row(tabId, l, status))),
    status,
  );
}

void main();
