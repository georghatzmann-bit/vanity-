/**
 * Inhaltsskript (nur Hauptrahmen): zeigt an Passwortfeldern einen kleinen AEGIS-Knopf in einem
 * geschlossenen Schatten-Baum. Erst nach einem echten Klick (bzw. Alt+↓ im Feld) fragt es den
 * Hintergrund nach Logins für diese Seite, und erst nach Auswahl eines Logins füllt es aus.
 * Es liest keine Eingaben, speichert nichts und sendet nichts von selbst.
 *
 * Schutz gegen untergeschobene Klicks: Knopf und Menü liegen in der obersten Ebene (Popover),
 * die Seite kann sie nicht überdecken; ändert die Seite Stil oder Attribute des Wirts, schließt
 * alles. Ein Login wird erst nach einer kurzen Pause und nur per Klick genau auf den sichtbaren
 * Eintrag (oder per Tastatur) gewählt, und ausgefüllt wird nur in deutlich sichtbare Felder.
 */

import {
  clearlyVisible,
  effectiveOpacity,
  fill,
  passwordFields,
  usable,
  usernameFor,
} from './lib/fields';
import { texts } from './lib/i18n';
import {
  parseHostResponse,
  parsePopupRequest,
  type HostResponse,
  type Login,
  type PageRequest,
  type PopupAnswer,
} from './lib/messages';
import { applyTheme } from './lib/theme';

const CSS = `
:host{all:initial}
[popover]{inset:auto;margin:0;overflow:visible}
.btn,.menu{position:fixed;z-index:2147483647;font:13px/1.4 var(--aegis-font);color:var(--aegis-text)}
.btn{width:26px;height:26px;display:grid;place-items:center;padding:0;border:1px solid var(--aegis-border-strong);
  border-radius:6px;background:var(--aegis-surface-2);color:var(--aegis-accent);cursor:pointer;
  opacity:0;transform:scale(.9);transition:opacity .16s cubic-bezier(.05,.7,.1,1),transform .16s cubic-bezier(.05,.7,.1,1)}
.btn.in{opacity:1;transform:none}
.btn:hover{background:var(--aegis-surface-3)}
.btn svg{width:16px;height:16px}
.menu{min-width:240px;max-width:360px;padding:6px;border:1px solid var(--aegis-border-strong);border-radius:var(--aegis-radius);
  background:var(--aegis-surface-2);box-shadow:var(--aegis-shadow-lg);
  opacity:0;transform:translateY(-4px);transition:opacity .18s cubic-bezier(.05,.7,.1,1),transform .18s cubic-bezier(.05,.7,.1,1)}
.menu.in{opacity:1;transform:none}
h2{margin:4px 8px 6px;font-size:12px;font-weight:600;color:var(--aegis-text-muted);text-transform:uppercase;letter-spacing:.04em}
p{margin:6px 8px}
.warn{color:var(--aegis-warn)}
.muted{color:var(--aegis-text-muted)}
ul{list-style:none;margin:0;padding:0}
.item{display:block;width:100%;text-align:left;padding:7px 8px;border:0;border-radius:6px;background:transparent;
  color:var(--aegis-text);font:inherit;cursor:pointer}
.item:hover,.item:focus-visible{background:var(--aegis-surface-3)}
.item span{display:block;font-size:12px;color:var(--aegis-text-muted)}
button:focus-visible{outline:2px solid var(--aegis-focus);outline-offset:1px}
@media (prefers-reduced-motion: reduce){.btn,.menu{transition:none}}
`;

const t = texts(navigator.language);
const SVG = 'http://www.w3.org/2000/svg';

let field: HTMLInputElement | null = null;
let ui: { host: HTMLElement; root: ShadowRoot; btn: HTMLButtonElement } | null = null;
let menu: HTMLElement | null = null;
let frame = 0;
/** Zeitpunkt, ab dem Mausklicks auf Einträge zählen (gegen untergeschobene Doppelklicks). */
let armedAt = 0;
const ARM_MS = 500;
let guard: MutationObserver | null = null;

/** Zeigt ein Element in der obersten Ebene (falls der Browser das kann). */
function lift(node: HTMLElement): void {
  node.setAttribute('popover', 'manual');
  try {
    node.showPopover();
  } catch {
    // ohne Popover bleibt es ein festes Element – die Sichtprüfung gilt trotzdem
  }
}

/** Ist unsere Oberfläche unverändert sichtbar (Wirt nicht durchsichtig, verdeckt, verformt)? */
function intact(): boolean {
  if (ui === null || !ui.host.isConnected) {
    return false;
  }
  for (let node: Element | null = ui.host; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.filter !== 'none' ||
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      (node === ui.host && style.transform !== 'none')
    ) {
      return false;
    }
  }
  return effectiveOpacity(ui.host) >= 0.99;
}

/** Liegt an der Klickstelle wirklich unser Element (nichts von der Seite darüber)? */
function hit(e: MouseEvent, target: Element): boolean {
  if (ui === null) {
    return false;
  }
  // Tastatur (Enter/Leertaste auf dem fokussierten Eintrag) hat keine Klickstelle.
  if (e.detail === 0) {
    return true;
  }
  if (document.elementFromPoint(e.clientX, e.clientY) !== ui.host) {
    return false;
  }
  const inner = ui.root.elementFromPoint(e.clientX, e.clientY);
  return inner !== null && target.contains(inner);
}

function shield(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function ensureUi(): NonNullable<typeof ui> {
  if (ui !== null && ui.host.isConnected) {
    return ui;
  }
  // Neutraler, zufälliger Name: Seiten sollen den Knopf nicht gezielt erkennen können.
  const tag = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const host = document.createElement(`x-${tag}`);
  host.setAttribute('data-hint', '');
  const root = host.attachShadow({ mode: 'closed' });
  // Ändert die Seite Stil, Klassen oder Attribute des Wirts, wird alles geschlossen.
  guard?.disconnect();
  guard = new MutationObserver(() => hide());
  guard.observe(host, { attributes: true });
  applyTheme(root, ':host');
  const style = document.createElement('style');
  style.textContent = CSS;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.title = t.button;
  btn.setAttribute('aria-label', t.button);
  btn.setAttribute('aria-haspopup', 'menu');
  btn.append(shield());
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // Fokus bleibt im Feld
  btn.addEventListener('click', (e) => {
    if (e.isTrusted && intact() && hit(e, btn)) {
      toggleMenu(false);
    }
  });
  root.append(style, btn);
  document.documentElement.append(host);
  lift(btn);
  ui = { host, root, btn };
  return ui;
}

function place(): void {
  frame = 0;
  if (ui === null || field === null) {
    return;
  }
  if (!field.isConnected || !usable(field)) {
    hide();
    return;
  }
  const r = field.getBoundingClientRect();
  const size = 26;
  ui.btn.style.left = `${Math.max(0, r.right - size - 4)}px`;
  ui.btn.style.top = `${r.top + Math.max(0, (r.height - size) / 2)}px`;
  if (menu !== null) {
    const width = Math.max(240, Math.min(360, r.width));
    menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - width - 4))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.width = `${width}px`;
  }
}

function schedule(): void {
  if (frame === 0 && ui !== null) {
    frame = requestAnimationFrame(place);
  }
}

function show(target: HTMLInputElement): void {
  field = target;
  const { btn } = ensureUi();
  place();
  requestAnimationFrame(() => btn.classList.add('in'));
}

function closeMenu(refocus: boolean): void {
  menu?.remove();
  menu = null;
  ui?.btn.setAttribute('aria-expanded', 'false');
  if (refocus) {
    field?.focus();
  }
}

function hide(): void {
  closeMenu(false);
  guard?.disconnect();
  guard = null;
  ui?.host.remove();
  ui = null;
  field = null;
}

function ask(request: PageRequest): Promise<HostResponse> {
  return chrome.runtime.sendMessage(request).then(
    (answer: unknown) => parseHostResponse(answer),
    () => ({ type: 'error', code: 'app_not_running' }) as const,
  );
}

function line(text: string, className = ''): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function render(body: HTMLElement, answer: HostResponse, focusFirst: boolean): void {
  body.replaceChildren();
  if (location.protocol === 'http:') {
    body.append(line(t.insecure, 'warn'));
  }
  if (answer.type === 'error') {
    body.append(line(t.error[answer.code], answer.code === 'locked' ? 'muted' : 'warn'));
    return;
  }
  if (answer.type !== 'logins') {
    body.append(line(t.error.invalid, 'warn'));
    return;
  }
  if (answer.logins.length === 0) {
    body.append(line(t.none, 'muted'));
    return;
  }
  const list = document.createElement('ul');
  list.setAttribute('role', 'menu');
  for (const login of answer.logins) {
    list.append(item(login, body));
  }
  body.append(list);
  armedAt = performance.now() + ARM_MS;
  // Nur bei Tastaturbedienung gleich in die Liste – sonst würde ein zweiter Mausklick an
  // derselben Stelle sofort einen Eintrag wählen.
  if (focusFirst) {
    list.querySelector('button')?.focus();
  }
}

function item(login: Login, body: HTMLElement): HTMLLIElement {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'item';
  b.setAttribute('role', 'menuitem');
  b.textContent = login.title;
  const sub = document.createElement('span');
  sub.textContent = login.username === '' ? t.noUser : login.username;
  b.append(sub);
  b.addEventListener('click', (e) => {
    const pointer = e.detail !== 0;
    if (!e.isTrusted || !intact() || !hit(e, b) || (pointer && performance.now() < armedAt)) {
      return;
    }
    const target = field;
    void ask({ type: 'fill', id: login.id }).then((answer) => {
      if (answer.type !== 'fill') {
        render(body, answer, false);
      } else if (target === null || !target.isConnected || !intact()) {
        body.replaceChildren(line(t.hidden, 'warn'));
      } else if (fill(target, answer.username, answer.password)) {
        closeMenu(true);
      } else {
        body.replaceChildren(line(t.hidden, 'warn'));
      }
    });
  });
  li.append(b);
  return li;
}

function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu(true);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
    return;
  }
  const items = [...(menu?.querySelectorAll<HTMLButtonElement>('.item') ?? [])];
  if (items.length === 0 || ui === null) {
    return;
  }
  e.preventDefault();
  const current = items.indexOf(ui.root.activeElement as HTMLButtonElement);
  const next = e.key === 'ArrowDown' ? current + 1 : current - 1;
  items[(next + items.length) % items.length]?.focus();
}

function toggleMenu(byKeyboard: boolean): void {
  if (menu !== null) {
    closeMenu(true);
    return;
  }
  const { root, btn } = ensureUi();
  menu = document.createElement('section');
  menu.className = 'menu';
  menu.setAttribute('aria-label', t.menuTitle);
  menu.addEventListener('keydown', onMenuKey);
  const title = document.createElement('h2');
  title.textContent = t.menuTitle;
  const body = document.createElement('div');
  body.setAttribute('role', 'status');
  body.append(line(t.loading, 'muted'));
  menu.append(title, body);
  root.append(menu);
  lift(menu);
  btn.setAttribute('aria-expanded', 'true');
  place();
  const opened = menu;
  requestAnimationFrame(() => opened.classList.add('in'));
  void ask({ type: 'logins' }).then((answer) => {
    if (menu === opened) {
      render(body, answer, byKeyboard);
    }
  });
}

/** Passwortfeld zu einem fokussierten Feld (das Passwortfeld selbst oder sein Benutzername). */
function passwordFor(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement) || !usable(target)) {
    return null;
  }
  if (target.type === 'password') {
    return target;
  }
  return passwordFields(document).find((p) => usernameFor(p) === target) ?? null;
}

document.addEventListener(
  'focusin',
  (e) => {
    if (ui !== null && e.target === ui.host) {
      return;
    }
    const password = passwordFor(e.target);
    if (password !== null) {
      if (password !== field) {
        closeMenu(false);
      }
      show(password);
    } else if (ui !== null) {
      hide();
    }
  },
  true,
);

document.addEventListener(
  'keydown',
  (e) => {
    if (!e.isTrusted || field === null) {
      return;
    }
    const inField = e.target === field || (field !== null && usernameFor(field) === e.target);
    if (inField && e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      toggleMenu(true);
    } else if (inField && e.key === 'Escape' && menu !== null) {
      closeMenu(true);
    }
  },
  true,
);

document.addEventListener(
  'pointerdown',
  (e) => {
    if (ui !== null && e.target !== ui.host && e.target !== field && menu !== null) {
      closeMenu(false);
    }
  },
  true,
);

window.addEventListener('scroll', schedule, { capture: true, passive: true });
window.addEventListener('resize', schedule, { passive: true });

/** Anfragen des Popups (nur von unserer Erweiterung, nicht von einer Seite). */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) {
    return false;
  }
  const request = parsePopupRequest(message);
  if (request === null) {
    return false;
  }
  const answer = (a: PopupAnswer) => sendResponse(a);
  if (request.type === 'popup-logins') {
    void ask({ type: 'logins' }).then((r) =>
      answer(
        r.type === 'logins'
          ? { type: 'logins', origin: location.origin, logins: r.logins }
          : { type: 'error', code: r.type === 'error' ? r.code : 'invalid' },
      ),
    );
    return true;
  }
  const target =
    (field !== null && field.isConnected && usable(field) ? field : null) ??
    passwordFields(document).find((p) => clearlyVisible(p)) ??
    null;
  if (target === null) {
    answer({ type: 'no_field' });
    return false;
  }
  void ask({ type: 'fill', id: request.id }).then((r) => {
    if (r.type === 'fill') {
      answer(fill(target, r.username, r.password) ? { type: 'filled' } : { type: 'no_field' });
    } else {
      answer({ type: 'error', code: r.type === 'error' ? r.code : 'invalid' });
    }
  });
  return true;
});
