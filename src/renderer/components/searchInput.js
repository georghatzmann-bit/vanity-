// Search field with icon, clear button, debounced input and a "/" or Ctrl+F shortcut.
import { h } from '../core/dom.js';
import { icon } from './icons.js';

/**
 * SearchInput({ placeholder, value, onInput, debounce, shortcut, label })
 * Returns the element with: value (get/set), focus(), clear(), destroy()
 */
export function SearchInput({ placeholder = 'Suchen …', value = '', onInput, debounce = 120, shortcut = true, label = 'Suchen' } = {}) {
  const input = h('input.search__input', { type: 'search', placeholder, value, spellcheck: false, autocomplete: 'off', attrs: { 'aria-label': label } });
  const clearBtn = h('button.search__clear', { type: 'button', attrs: { 'aria-label': 'Suche leeren' } }, icon('x'));
  const el = h('div.search', h('span.search__icon', icon('search', { size: 18 })), input, clearBtn, shortcut ? h('kbd.search__kbd', '/') : null);
  let timer = 0;

  const emit = (immediate) => {
    el.classList.toggle('has-value', !!input.value);
    clearTimeout(timer);
    if (immediate || !debounce) onInput?.(input.value.trim());
    else timer = setTimeout(() => onInput?.(input.value.trim()), debounce);
  };
  input.addEventListener('input', () => emit(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      api.clear();
    }
  });
  clearBtn.addEventListener('click', () => {
    api.clear();
    input.focus();
  });
  el.addEventListener('click', (e) => {
    if (e.target === el) input.focus();
  });

  const onGlobalKey = (e) => {
    if (!el.isConnected) {
      window.removeEventListener('keydown', onGlobalKey);
      return;
    }
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) {
      if (el.closest('[inert]')) return;
      e.preventDefault();
      input.focus();
      input.select();
    }
  };
  if (shortcut) window.addEventListener('keydown', onGlobalKey);
  el.classList.toggle('has-value', !!value);

  const api = {
    get value() {
      return input.value.trim();
    },
    set value(v) {
      input.value = v ?? '';
      el.classList.toggle('has-value', !!input.value);
    },
    focus() {
      input.focus();
    },
    clear() {
      input.value = '';
      emit(true);
    },
    destroy() {
      clearTimeout(timer);
      window.removeEventListener('keydown', onGlobalKey);
    },
  };
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
