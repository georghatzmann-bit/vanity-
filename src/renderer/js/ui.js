// Kleine Helfer für die Oberfläche: Elemente bauen, Symbole, Meldungen, Dialoge, Kopieren.
(function () {
  'use strict';

  // Symbole als Linienzeichnungen (24x24, Farbe kommt aus dem Text).
  const ICONS = {
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    message: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
    headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="7" rx="1.5"/><rect x="17" y="13" width="4" height="7" rx="1.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
    arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    warning: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.01"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    bellOff: '<path d="M6 16V11a6 6 0 0 1 8.5-5.5M18 11v5l2 2H8"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M3 3l18 18"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="6" rx="1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };

  function icon(name, extraClass) {
    const span = document.createElement('span');
    span.className = 'icon' + (extraClass ? ' ' + extraClass : '');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
    return span;
  }

  // Baut ein Element. Text wird immer als Text gesetzt (nie als HTML), damit
  // Inhalte aus PDFs nie als Programmcode ausgeführt werden können.
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'fk') node.dataset.fk = value; // Kennung, damit der Fokus nach dem Neuzeichnen zurückfindet
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'value') node.value = value;
        else if (key === 'checked') node.checked = Boolean(value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children === undefined || children === null || children === false) return;
    if (!Array.isArray(children)) children = [children];
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) appendChildren(node, child);
      else node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // ---------- Meldungen unten rechts ----------
  function toast(message, kind) {
    kind = kind || 'success';
    const iconName = { success: 'checkCircle', error: 'warning', warning: 'warning', info: 'info' }[kind] || 'info';
    const node = el('div', { class: 'toast ' + kind }, [icon(iconName), el('div', { text: message })]);
    const root = document.getElementById('toasts');
    root.appendChild(node);
    while (root.children.length > 4) root.removeChild(root.firstChild);
    const ms = kind === 'error' ? 6000 : 3200;
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 200);
    }, ms);
  }

  // ---------- Dialog ----------
  // Gibt ein Promise zurück: true bei Bestätigen, false bei Abbrechen.
  function confirmDialog({ title, text, confirmText, cancelText, danger, body }) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      const previous = document.activeElement;
      let closed = false;
      const close = (result) => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (previous && previous.focus && document.contains(previous)) previous.focus();
        resolve(result);
      };
      // Nur der oberste Dialog reagiert auf Tasten
      const isTop = () => root.lastElementChild === backdrop;
      const onKey = (e) => {
        if (!isTop()) return;
        if (e.key === 'Escape' && cancelText !== null) { e.preventDefault(); e.stopPropagation(); close(false); }
        if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && modal.contains(e.target) && e.target.type !== 'checkbox' && e.target.type !== 'radio') {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        }
      };
      const confirmBtn = el('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), type: 'button', onclick: () => close(true) }, confirmText || 'OK');
      const actions = [];
      if (cancelText !== null) actions.push(el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(false) }, cancelText || 'Abbrechen'));
      actions.push(confirmBtn);
      const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
        el('h2', { text: title }),
        text ? el('p', { text }) : null,
        body || null,
        el('div', { class: 'row row-end' }, actions),
      ]);
      // Schließen per Klick daneben nur, wenn der Klick auch daneben begonnen hat
      // (sonst schließt z. B. ein Markieren von Text, das außerhalb endet, den Dialog)
      let downOnBackdrop = false;
      const backdrop = el('div', { class: 'modal-backdrop' }, modal);
      backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === backdrop; });
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop && downOnBackdrop && cancelText !== null) close(false);
        downOnBackdrop = false;
      });
      root.appendChild(backdrop);
      document.addEventListener('keydown', onKey, true);
      confirmBtn.focus();
    });
  }

  // ---------- Kopieren ----------
  async function copyText(text, label) {
    const value = String(text == null ? '' : text);
    if (!value.trim()) {
      toast('Da ist noch nichts zum Kopieren.', 'warning');
      return false;
    }
    const res = await window.kr.copy(value);
    if (res && res.ok) {
      toast((label ? label + ' kopiert' : 'Kopiert') + '. Mit Strg+V einfügen.', 'success');
      return true;
    }
    toast('Kopieren hat nicht geklappt.', 'error');
    return false;
  }

  function copyButton(getText, label, opts) {
    opts = opts || {};
    const btn = el('button', {
      class: 'btn copy-btn ' + (opts.small ? 'btn-sm' : '') + (opts.primary ? ' btn-primary' : ''),
      type: 'button',
      title: (label || 'Wert') + ' kopieren',
    }, [icon(opts.small ? 'copy' : 'copy', opts.small ? 'icon-sm' : ''), el('span', { text: opts.text || 'Kopieren' })]);
    btn.addEventListener('click', async () => {
      const ok = await copyText(typeof getText === 'function' ? getText() : getText, label);
      if (ok) {
        btn.classList.add('copied');
        btn.lastChild.textContent = 'Kopiert';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.lastChild.textContent = opts.text || 'Kopieren';
        }, 1600);
      }
    });
    return btn;
  }

  async function openUrl(url) {
    const res = await window.kr.openUrl(url);
    if (res && res.ok) toast('Seite wird in deinem Browser geöffnet.', 'info');
    else toast((res && res.message) || 'Seite konnte nicht geöffnet werden.', 'error');
    return Boolean(res && res.ok);
  }

  function callout(kind, title, text) {
    const iconName = { warning: 'warning', danger: 'warning', success: 'checkCircle', info: 'info' }[kind] || 'info';
    return el('div', { class: 'callout callout-' + kind }, [
      icon(iconName),
      el('div', null, [title ? el('div', { class: 'callout-title', text: title }) : null, text ? el('p', { text }) : null]),
    ]);
  }

  function switchControl(label, checked, onChange, hint, fk) {
    const input = el('input', { type: 'checkbox', checked, fk });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'switch' }, [
      input,
      el('span', { class: 'switch-track' }),
      el('span', { class: 'stack-sm' }, [el('span', { text: label }), hint ? el('span', { class: 'hint', text: hint }) : null]),
    ]);
  }

  function segmented(options, value, onChange) {
    const wrap = el('div', { class: 'segmented', role: 'tablist' });
    for (const opt of options) {
      const b = el('button', { type: 'button', role: 'tab', class: opt.value === value ? 'active' : '', 'aria-selected': opt.value === value ? 'true' : 'false', fk: 'seg-' + opt.value }, opt.label);
      b.addEventListener('click', () => onChange(opt.value));
      wrap.appendChild(b);
    }
    return wrap;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' +
      d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  function pageHead(title, sub, actions) {
    return el('div', { class: 'page-head' }, [
      el('div', null, [el('h1', { text: title }), sub ? el('p', { text: sub }) : null]),
      actions ? el('div', { class: 'row' }, actions) : null,
    ]);
  }

  // Zeichnet neu und gibt danach dem gleichen Bedienelement wieder den Fokus (für Tastatur-Nutzer)
  function keepFocus(root, renderFn) {
    const active = document.activeElement;
    const key = active && root && root.contains(active) && active.dataset ? active.dataset.fk : null;
    renderFn();
    if (key) {
      const again = root.querySelector('[data-fk="' + CSS.escape(key) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }

  window.UI = { icon, el, clear, toast, confirmDialog, copyText, copyButton, openUrl, callout, switchControl, segmented, formatDate, pageHead, keepFocus };
})();
