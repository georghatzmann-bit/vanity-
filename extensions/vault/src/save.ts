/**
 * „Speichern?“ nach dem Anmelden: Beim Absenden eines Login-Formulars gehen Benutzername und
 * Passwort an den Hintergrund der Erweiterung (nur im Speicher, höchstens 2 Minuten). Erst wenn
 * der Nutzer in der Frage „Speichern“ bzw. „Aktualisieren“ wählt, gehen sie an AEGIS. Die Frage
 * hat dieselben Schutzmaßnahmen wie das Ausfüll-Menü (oberste Ebene, Wächter, echte Klickstelle,
 * kurze Pause, kein Vorfokus).
 */

import { passwordFields, usernameFor } from './lib/fields';
import { hit, intact, lift, randomHost, watchHost } from './lib/guard';
import { texts } from './lib/i18n';
import { parseHostResponse, parsePending, type Pending } from './lib/messages';
import { applyTheme } from './lib/theme';

const CSS = `
:host{all:initial}
[popover]{inset:auto;margin:0;overflow:visible}
.box{position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;max-width:calc(100vw - 24px);
  box-sizing:border-box;padding:14px 16px;font:14px/1.45 var(--aegis-font);color:var(--aegis-text);
  background:var(--aegis-surface-2);border:1px solid var(--aegis-border-strong);border-radius:var(--aegis-radius);
  box-shadow:var(--aegis-shadow-lg);opacity:0;transform:translateY(-8px);
  transition:opacity .22s cubic-bezier(.05,.7,.1,1),transform .22s cubic-bezier(.05,.7,.1,1)}
.box.in{opacity:1;transform:none}
h2{margin:0 0 6px;font-size:14px;font-weight:600}
p{margin:0 0 8px}
.who{color:var(--aegis-text-muted);overflow-wrap:anywhere}
.warn{color:var(--aegis-warn)}
.ok{color:var(--aegis-success)}
.row{display:flex;gap:8px;margin-top:10px}
button{font:inherit;border-radius:8px;padding:6px 14px;cursor:pointer;border:1px solid var(--aegis-border-strong);
  background:var(--aegis-surface-3);color:var(--aegis-text)}
button.primary{border-color:var(--aegis-accent);background:var(--aegis-accent);color:var(--aegis-on-accent)}
button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible{outline:2px solid var(--aegis-focus);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.box{transition:none}}
`;

const t = texts(navigator.language);
const ARM_MS = 500;
const SHOW_MS = 45_000;

let open: { host: HTMLElement; guard: MutationObserver; timer: number } | null = null;
let lastSent = '';

function close(): void {
  if (open === null) {
    return;
  }
  open.guard.disconnect();
  clearTimeout(open.timer);
  open.host.remove();
  open = null;
}

function button(text: string, primary: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (primary) {
    b.className = 'primary';
  }
  return b;
}

function show(p: Pending): void {
  close();
  const host = randomHost();
  const root = host.attachShadow({ mode: 'closed' });
  applyTheme(root, ':host');
  const style = document.createElement('style');
  style.textContent = CSS;
  const box = document.createElement('section');
  box.className = 'box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', t.menuTitle);
  const title = document.createElement('h2');
  title.textContent = p.state === 'update' ? t.saveUpdateTitle : t.saveTitle;
  const who = document.createElement('p');
  who.className = 'who';
  who.textContent = `${p.host} · ${p.username === '' ? t.noUser : p.username}`;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  if (p.state === 'locked') {
    status.className = 'warn';
    status.textContent = t.saveLocked;
  }
  const save = button(p.state === 'update' ? t.saveUpdate : t.save, true);
  const later = button(t.saveLater, false);
  const row = document.createElement('div');
  row.className = 'row';
  row.append(save, later);
  box.append(title, who, status, row);
  root.append(style, box);
  document.documentElement.append(host);
  lift(box);
  const armedAt = performance.now() + ARM_MS;
  const allowed = (e: MouseEvent, target: Element) =>
    e.isTrusted &&
    intact(host) &&
    hit(e, host, root, target) &&
    (e.detail === 0 || performance.now() >= armedAt);

  save.addEventListener('click', (e) => {
    if (!allowed(e, save)) {
      return;
    }
    save.disabled = true;
    void chrome.runtime
      .sendMessage({ type: 'save-pending' })
      .then((answer: unknown) => parseHostResponse(answer))
      .catch(() => ({ type: 'error', code: 'app_not_running' }) as const)
      .then((answer) => {
        if (answer.type === 'saved') {
          status.className = 'ok';
          status.textContent = answer.updated ? t.savedUpdated : t.saved;
          row.remove();
          if (open !== null) {
            clearTimeout(open.timer);
            open.timer = window.setTimeout(close, 2500);
          }
        } else {
          save.disabled = false;
          status.className = 'warn';
          status.textContent = answer.type === 'error' ? t.error[answer.code] : t.error.invalid;
        }
      });
  });
  later.addEventListener('click', (e) => {
    if (!allowed(e, later)) {
      return;
    }
    void chrome.runtime.sendMessage({ type: 'dismiss-pending' }).catch(() => undefined);
    close();
  });
  open = { host, guard: watchHost(host, close), timer: window.setTimeout(close, SHOW_MS) };
  requestAnimationFrame(() => box.classList.add('in'));
}

/** Fragt den Hintergrund, ob für diese Seite ein Login auf „Speichern?“ wartet. */
export function offerSave(): void {
  if (open !== null) {
    return;
  }
  void chrome.runtime
    .sendMessage({ type: 'pending' })
    .then((answer: unknown) => {
      const p = parsePending(answer);
      if (p !== null) {
        show(p);
      }
    })
    .catch(() => undefined);
}

/** Merkt sich einen abgeschickten Login (nur, wenn ein Passwort darin steht). */
function noteSubmit(scope: ParentNode): void {
  const password = passwordFields(document).find(
    (p) => p.value !== '' && (scope === document || scope.contains(p)),
  );
  if (password === undefined) {
    return;
  }
  const username = usernameFor(password)?.value ?? '';
  const signature = `${username}\u0000${password.value}`;
  if (signature === lastSent || password.value.length > 1024 || username.length > 1024) {
    return;
  }
  lastSent = signature;
  setTimeout(() => {
    lastSent = '';
  }, 5000);
  void chrome.runtime
    .sendMessage({ type: 'submitted', username, password: password.value })
    .then(() => setTimeout(offerSave, 600))
    .catch(() => undefined);
}

/** Beobachtet Formular-Absenden und Klicks auf Absende-Knöpfe (auch ohne `<form>`). */
export function watchLogins(): void {
  document.addEventListener(
    'submit',
    (e) => {
      if (e.target instanceof HTMLFormElement) {
        noteSubmit(e.target);
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || !(e.target instanceof Element)) {
        return;
      }
      // Nur echte Absende-Knöpfe (nicht etwa „Passwort zeigen“).
      const trigger = e.target.closest('button, input[type="submit"]');
      if (
        !(trigger instanceof HTMLButtonElement || trigger instanceof HTMLInputElement) ||
        trigger.type !== 'submit'
      ) {
        return;
      }
      noteSubmit(trigger.form ?? document);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (
        e.isTrusted &&
        e.key === 'Enter' &&
        e.target instanceof HTMLInputElement &&
        e.target.type === 'password'
      ) {
        noteSubmit(e.target.form ?? document);
      }
    },
    true,
  );
}
