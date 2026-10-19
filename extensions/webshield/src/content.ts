/**
 * Inhaltsskript: prüft nur die aktuelle Adresse und ob ein Passwortfeld da ist. Bei Merkmalen
 * eines Betrugs zeigt es einen schließbaren Hinweis. Es liest keine Eingaben, sendet nichts und
 * verändert die Seite sonst nicht.
 */

import { signals, type Signal } from './lib/lookalike';
import { readSettings } from './lib/settings';
import { texts } from './lib/i18n';
import { applyTheme } from './lib/theme';

const BANNER_CSS = `
:host{all:initial}
.box{position:fixed;inset:12px 12px auto auto;z-index:2147483647;max-width:420px;
  font:14px/1.45 var(--aegis-font);color:var(--aegis-text);background:var(--aegis-surface-2);
  border:1px solid var(--aegis-warn);border-radius:var(--aegis-radius);padding:12px 14px;
  box-shadow:0 12px 32px -8px rgb(0 0 0 / .5);opacity:0;transform:translateY(-8px);
  transition:opacity .22s cubic-bezier(.05,.7,.1,1),transform .22s cubic-bezier(.05,.7,.1,1)}
.box.in{opacity:1;transform:none}
h2{margin:0 32px 6px 0;font-size:14px;font-weight:600;color:var(--aegis-warn)}
ul{margin:0;padding-left:18px}
li+li{margin-top:4px}
button{position:absolute;top:8px;right:8px;width:28px;height:28px;border:0;border-radius:6px;
  background:transparent;color:var(--aegis-text-muted);font:18px/1 var(--aegis-font);cursor:pointer}
button:hover{background:var(--aegis-surface-3);color:var(--aegis-text)}
button:focus-visible{outline:2px solid var(--aegis-focus);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.box{transition:none}}
`;

let shown = false;

function show(found: readonly Signal[]): void {
  if (shown || found.length === 0) {
    return;
  }
  shown = true;
  const t = texts(navigator.language);
  // Neutraler, zufälliger Name: Seiten sollen den Hinweis nicht gezielt erkennen können.
  // getRandomValues gibt es auch auf HTTP-Seiten (randomUUID nicht).
  const tag = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const host = document.createElement(`x-${tag}`);
  host.setAttribute('data-hint', '');
  const root = host.attachShadow({ mode: 'closed' });
  applyTheme(root, ':host');
  const style = document.createElement('style');
  style.textContent = BANNER_CSS;
  const box = document.createElement('section');
  box.className = 'box';
  box.setAttribute('role', 'alert');
  const title = document.createElement('h2');
  title.textContent = t.bannerTitle;
  const list = document.createElement('ul');
  for (const s of found) {
    const item = document.createElement('li');
    item.textContent = t.signal[s];
    list.append(item);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', t.bannerClose);
  close.addEventListener('click', () => host.remove());
  box.append(title, list, close);
  root.append(style, box);
  document.documentElement.append(host);
  requestAnimationFrame(() => box.classList.add('in'));
}

function check(): void {
  const hasPassword = document.querySelector('input[type="password"]') !== null;
  show(signals(location.hostname.toLowerCase(), location.protocol, hasPassword));
}

void chrome.storage.local.get('settings').then((stored) => {
  if (!readSettings(stored.settings).pageHints) {
    return;
  }
  check();
  // Passwortfelder erscheinen oft erst später; kurz beobachten, dann aufhören.
  const observer = new MutationObserver(() => {
    if (!shown && document.querySelector('input[type="password"]') !== null) {
      check();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 15_000);
});
