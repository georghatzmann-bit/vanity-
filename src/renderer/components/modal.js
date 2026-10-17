// Glass dialog with backdrop blur, focus trap, Esc to close, focus restore.
import { h } from '../core/dom.js';
import { Button, IconButton } from './button.js';
import { icon } from './icons.js';
import { gsap, motionOK, richMotion } from '../core/motion.js';
import { sound } from '../core/sound.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * createModalHost(hostEl, { inertTargets: [elements to make inert while open] }) -> modal
 *   modal.open({ title, subtitle, icon, tone: 'accent'|'danger', content, actions, footStart, size: 'sm'|'md'|'lg', dismissible = true, onClose })
 *     content: Node | string | (handle) => Node
 *     actions: [{ label, variant, icon, value, onClick(handle) -> false keeps it open }]
 *     footStart: Node shown at the left end of the footer (meta info, secondary links)
 *     -> handle { el, body, close(value), closed: Promise<value> }
 *   modal.confirm({ title, message, confirmLabel, cancelLabel, danger }) -> Promise<boolean>
 *   modal.closeAll() · modal.isOpen
 */
export function createModalHost(host, { inertTargets = [] } = {}) {
  const stack = [];

  function setInert(on) {
    for (const t of inertTargets) if (t) t.inert = on;
    // Lets CSS pause decorative loops behind the blurred backdrop (each frame would be re-blurred).
    document.documentElement.classList.toggle('modal-open', on);
  }

  function open({ title = '', subtitle = '', icon: iconName, tone = 'accent', content, actions = [], footStart = null, size = 'md', dismissible = true, onClose, className = '' } = {}) {
    const returnFocus = document.activeElement;
    let resolveClosed;
    const closed = new Promise((r) => (resolveClosed = r));
    const titleId = `modal-t-${stack.length}-${Date.now()}`;

    const backdrop = h('div.modal-backdrop');
    const body = h('div.modal__body');
    const head = h(
      'div.modal__head',
      iconName ? h(`div.icon-tile${tone === 'danger' ? '.icon-tile--danger' : ''}`, icon(iconName)) : null,
      h('div.modal__titles', h('h2.modal__title', { id: titleId }, title), subtitle ? h('p.modal__subtitle', subtitle) : null),
      dismissible ? IconButton({ icon: 'close', label: 'Schließen', className: 'modal__close', onClick: () => handle.close() }) : null,
    );
    const dialog = h('div', { class: `modal modal--${size} ${className}`, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } }, head, body);
    const layer = h('div.modal-layer', backdrop, dialog);

    const handle = {
      el: dialog,
      body,
      closed,
      close(value) {
        if (handle._closing) return;
        handle._closing = true;
        const i = stack.indexOf(handle);
        if (i >= 0) stack.splice(i, 1);
        document.removeEventListener('keydown', onKey);
        layer.style.pointerEvents = 'none';
        // Closing mid-entrance: stop the entrance tweens so they cannot fight the exit.
        gsap.killTweensOf([dialog, backdrop]);
        const finish = () => {
          layer.remove();
          if (!stack.length) setInert(false);
          if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
          onClose?.(value);
          resolveClosed(value);
        };
        if (!motionOK()) return finish();
        gsap
          .timeline({ onComplete: finish })
          .to(dialog, { opacity: 0, y: 10, scale: 0.975, duration: 0.18, ease: 'power2.in' })
          .to(backdrop, { opacity: 0, duration: 0.22, ease: 'power1.out' }, 0.02);
      },
    };

    if (typeof content === 'function') content = content(handle);
    if (typeof content === 'string') body.append(h('p.t-body.c-text-2', content));
    else if (content) body.append(content);

    if (actions.length || footStart) {
      const foot = h('div.modal__foot', footStart ? h('div.modal__foot-start', footStart) : null);
      for (const a of actions) {
        foot.append(
          Button({
            label: a.label,
            variant: a.variant || 'secondary',
            icon: a.icon,
            magnetic: false,
            onClick: async () => {
              const res = a.onClick ? await a.onClick(handle) : undefined;
              if (res !== false) handle.close(a.value);
            },
          }),
        );
      }
      dialog.append(foot);
    }

    function onKey(e) {
      if (stack[stack.length - 1] !== handle) return;
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        handle.close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    }

    // Document-level so Esc/Tab also work while focus sits in the titlebar; inputs can still
    // swallow Esc first (stopPropagation), e.g. to clear a search field.
    document.addEventListener('keydown', onKey);
    if (dismissible) backdrop.addEventListener('click', () => handle.close());

    host.append(layer);
    stack.push(handle);
    setInert(true);
    sound.play('whoosh');

    if (motionOK()) {
      gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' });
      gsap.fromTo(
        dialog,
        { opacity: 0, y: 24, scale: 0.95, filter: richMotion() ? 'blur(10px)' : 'none' },
        { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.55, ease: 'expo.out', clearProps: 'filter,transform,opacity' },
      );
    }

    // Focus the dialog itself (no ring); Tab then walks into it. [autofocus] wins if present.
    dialog.tabIndex = -1;
    requestAnimationFrame(() => (dialog.querySelector('[autofocus]') || dialog).focus({ preventScroll: true }));
    return handle;
  }

  function confirm({ title = 'Bist du sicher?', message = '', confirmLabel = 'OK', cancelLabel = 'Abbrechen', danger = false, icon: iconName } = {}) {
    const handle = open({
      title,
      icon: iconName || (danger ? 'alert' : 'info'),
      tone: danger ? 'danger' : 'accent',
      content: message,
      size: 'sm',
      actions: [
        { label: cancelLabel, variant: 'ghost', value: false },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', value: true },
      ],
    });
    return handle.closed.then((v) => v === true);
  }

  return {
    open,
    confirm,
    closeAll() {
      [...stack].reverse().forEach((m) => m.close());
    },
    get isOpen() {
      return stack.length > 0;
    },
  };
}
