// "Code einfügen" dialog: textarea with live validation hint, decodes via api.profile.decode().
// Resolves with the decoded Profile, or null when the dialog is closed.
import { h, nextId } from '../core/dom.js';
import { icon } from './icons.js';
import { shake, gsap, motionOK } from '../core/motion.js';
import { formatNumber } from '../core/format.js';

/** Classifies the raw text: { tone: 'idle'|'ok'|'warn', text } – never blocks submitting (decode is lenient). */
export function checkCode(raw) {
  const compact = String(raw || '').replace(/\s+/g, '');
  if (!compact) return { tone: 'idle', text: 'Füg den Code ein, den du beim Sichern bekommen hast. Zeilenumbrüche sind egal.' };
  const hasPrefix = /^PHX1-/i.test(compact);
  const body = hasPrefix ? compact.slice(5) : compact;
  if (/^PHX\d+-/i.test(compact) && !hasPrefix) return { tone: 'warn', text: 'Dieser Code stammt von einer anderen Phoenix-Version.' };
  if (!/^[A-Za-z0-9_-]+=*$/.test(body)) return { tone: 'warn', text: 'Der Code enthält ungültige Zeichen. Kopier ihn am besten noch mal komplett.' };
  if (!hasPrefix && body.length < 40) return { tone: 'warn', text: 'Das sieht nicht nach einem Phoenix-Code aus. Er beginnt mit PHX1-.' };
  if (body.length < 24) return { tone: 'warn', text: 'Der Code ist zu kurz – wahrscheinlich fehlt ein Teil.' };
  if (!hasPrefix) return { tone: 'warn', text: 'PHX1- fehlt am Anfang. Phoenix versucht es trotzdem.' };
  return { tone: 'ok', text: `Sieht gut aus · ${formatNumber(compact.length)} Zeichen erkannt` };
}

const TONE_ICON = { idle: 'info', ok: 'check-circle', warn: 'alert', err: 'x-circle' };

/**
 * openCodeDialog({ api, modal, sound }) -> Promise<Profile | null>
 */
export function openCodeDialog({ api, modal, sound }) {
  const inputId = nextId('rc');
  const hintId = nextId('rch');
  let busy = false;
  let handle = null;
  let result = null;

  const input = h('textarea.rc__input', {
    id: inputId,
    rows: 5,
    spellcheck: false,
    autocomplete: 'off',
    placeholder: 'PHX1-…',
    attrs: { autofocus: true, 'aria-describedby': hintId, autocapitalize: 'off', autocorrect: 'off' },
  });
  const statusIcon = h('span.rc__status-icon');
  const statusText = h('span.rc__status-text');
  const status = h('div.rc__status', { id: hintId, attrs: { 'aria-live': 'polite' } }, statusIcon, statusText);
  const field = h('div.rc__field', input, h('span.rc__glow', { attrs: { 'aria-hidden': 'true' } }));

  function setStatus(tone, text) {
    status.dataset.tone = tone;
    statusIcon.replaceChildren(icon(TONE_ICON[tone] || 'info', { size: 16, strokeWidth: 2 }));
    statusText.textContent = text;
    field.dataset.tone = tone;
  }
  const validate = () => {
    const r = checkCode(input.value);
    setStatus(r.tone, r.text);
  };
  input.addEventListener('input', validate);
  validate();

  const content = h(
    'div.rc',
    h('label.rc__label', { htmlFor: inputId }, 'Wiederherstellungs-Code'),
    field,
    status,
  );

  async function submit() {
    if (busy) return false;
    const code = input.value.trim();
    const btn = handle?.el.querySelector('.modal__foot .btn--primary');
    if (!code) {
      setStatus('err', 'Hier ist noch nichts drin. Füg zuerst deinen Code ein (Strg+V).');
      shake(field);
      sound?.play('error');
      input.focus();
      return false;
    }
    busy = true;
    btn?.setLoading?.(true);
    input.readOnly = true;
    try {
      const profile = await api.profile.decode(code);
      result = profile;
      setStatus('ok', 'Code erkannt – deine Sicherung wird geladen.');
      handle.close(profile);
    } catch (err) {
      setStatus('err', (err && err.message) || 'Der Code konnte nicht gelesen werden.');
      shake(field);
      sound?.play('error');
      input.readOnly = false;
      input.focus();
      input.select();
    } finally {
      busy = false;
      if (btn?.isConnected) btn.setLoading?.(false);
    }
    return false;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const btn = handle?.el.querySelector('.modal__foot .btn--primary');
      if (btn) btn.click();
      else submit();
    }
  });

  handle = modal.open({
    title: 'Code einfügen',
    subtitle: 'Den PHX1-Code hast du beim Sichern bekommen – zum Beispiel per WhatsApp oder Mail an dich selbst.',
    icon: 'key',
    size: 'md',
    className: 'modal--restore-code',
    content,
    footStart: h('span.rc__kbd', h('kbd', 'Strg'), h('kbd', 'Enter'), h('span', 'lädt den Code')),
    actions: [
      { label: 'Abbrechen', variant: 'ghost', value: null },
      { label: 'Code laden', variant: 'primary', onClick: submit },
    ],
  });
  if (motionOK()) gsap.fromTo(field, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5, delay: 0.12, ease: 'expo.out', clearProps: 'transform,opacity' });
  return handle.closed.then((v) => (v && typeof v === 'object' ? v : result && v !== null ? result : null));
}
