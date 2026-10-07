// Einstellungen: start sound + replay, motion, safety switches, KI providers (settings-ai.js), about + Testmodus.
// (The accent picker is gone: the brand has one signal colour. settings.accent stays in settings.json, unused.)
import { icon } from '../icons.js';
import { h, clear, button, toggle, segmented, optionRow, toast, confirmDialog, badge, append, radioKeys, startHint } from '../ui.js';
import { aiSection } from './settings-ai.js';
import { splash } from '../splash.js';

// Windows restore points (settings.restorePoints, docs/ARCHITECTURE.md section 8)
export const RP_MODES = [
  { id: 'first', label: 'Nur einmal, vor der allerersten Änderung', desc: 'Empfohlen. Danach sichert VELOX jeden Wert im eigenen Journal – das spart Speicherplatz.' },
  { id: 'presets', label: 'Zusätzlich vor großen Paketen', desc: 'Auch vor Presets, Detweak und KI-Plänen ab 10 Tweaks – höchstens einer pro Tag.' },
  { id: 'off', label: 'Aus', desc: 'Kein Windows-Wiederherstellungspunkt. Rückgängig geht trotzdem unter „Sicherungen“.' }
];
export function rpMode(settings) {
  const m = settings && settings.restorePoints;
  if (RP_MODES.some(x => x.id === m)) return m;
  return settings && settings.autoRestorePoint === false ? 'off' : 'first';
}

// The start sequence (settings.introMode, docs/ARCHITECTURE.md sections 7 and 11; VELOX.exe reads it too)
export const INTRO_MODES = [
  { value: 'long', label: 'Lang', title: 'Die lange Startanimation bei jedem Start' },
  { value: 'short', label: 'Kurz', title: 'Die kurze Startanimation' },
  { value: 'off', label: 'Aus', title: 'Keine Animation und kein Ton – nur das Logo' }
];
export function introMode(settings) {
  const m = settings && settings.introMode;
  return INTRO_MODES.some(x => x.value === m) ? m : 'long';
}

export { MODELS } from './settings-ai.js';

export default {
  id: 'settings', title: 'Einstellungen', icon: 'cog', desc: 'Start, Sicherheit und KI', keywords: 'optionen ton sound start animation startanimation intro lang kurz aus api key claude code groq ki',
  mount(el, ctx, opts) {
    const s = () => ctx.settings;

    // ---------- start + motion
    // settings.startSound: also read by VELOX.exe for its start screen (ARCHITECTURE.md section 11)
    const startSound = toggle({ checked: s().startSound !== false, label: 'Start-Sound', cls: 'start-sound', onChange: async (v) => {
      const ok = await ctx.saveSettings({ startSound: v }, { silent: true });
      if (ok) toast({ type: 'ok', title: v ? 'Start-Sound an' : 'Start-Sound aus' });
      return ok;
    } });
    const replay = button({ label: 'Abspielen', icon: 'play', size: 'sm', attrs: { 'data-testid': 'intro-replay', title: 'Spielt die lange Startanimation ab' }, onClick: () => splash.preview(s()) });
    const introDesc = (m) => m === 'off'
      ? 'Aus: beim Start nur das Logo, ohne Bewegung und ohne Ton. Abspielen zeigt die lange Fassung.'
      : m === 'short'
        ? 'Kurz: unter einer Sekunde. Abspielen zeigt die lange Fassung.'
        : 'Lang: rund drei Sekunden, bei jedem Start. Esc oder ein Klick überspringt sie.';
    const introRow = optionRow({ icon: 'play', title: 'Startanimation', desc: introDesc(introMode(s())), control: null });
    introRow.classList.add('opt-row-stack');   // the choice + Abspielen sit under the text (the card is narrow)
    const intro = segmented({
      label: 'Startanimation', value: introMode(s()), cls: 'intro-mode',
      options: INTRO_MODES,
      onChange: async (v) => {
        const prev = introMode(s());
        if (v === prev) return;
        const ok = await ctx.saveSettings({ introMode: v }, { silent: true });
        if (ok) toast({ type: 'ok', title: v === 'off' ? 'Startanimation aus' : 'Startanimation: ' + INTRO_MODES.find(x => x.value === v).label });
        else intro.select(prev);   // show what is really saved
        introRow.querySelector('.opt-desc').textContent = introDesc(introMode(s()));
      }
    });
    intro.dataset.testid = 'intro-mode';
    introRow.querySelector('.opt-control').append(h('div', { class: 'intro-ctl' }, intro, replay));
    const osReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motion = segmented({
      label: 'Animationen', value: s().motion === 'reduced' ? 'reduced' : 'full',
      options: [{ value: 'full', label: 'Voll', icon: 'sparkles' }, { value: 'reduced', label: 'Reduziert', icon: 'motion' }],
      onChange: async (v) => {
        const prev = s().motion === 'reduced' ? 'reduced' : 'full';
        const ok = await ctx.saveSettings({ motion: v }, { silent: true });
        if (ok) toast({ type: 'ok', title: v === 'reduced' ? 'Animationen reduziert' : 'Alle Animationen an' });
        else motion.select(prev);
      }
    });

    // ---------- safety
    const risky = toggle({ checked: s().confirmRisky !== false, label: 'Bei riskanten Tweaks nachfragen', onChange: async (v) => {
      if (!v) { const ok = await confirmDialog({ title: 'Nachfrage abschalten?', text: 'Riskante Tweaks werden dann ohne Warnung vorgemerkt. Empfohlen ist: anlassen.', confirmLabel: 'Abschalten', danger: true }); if (!ok) return false; }
      return ctx.saveSettings({ confirmRisky: v });
    } });
    const rpList = h('div', { class: 'model-list rp-modes', role: 'radiogroup', 'aria-label': 'Windows-Wiederherstellungspunkte', 'data-testid': 'rp-modes' });
    const markRp = (id) => { for (const x of rpList.children) x.setAttribute('aria-checked', String(x.dataset.rp === id)); if (rpList.syncRadios) rpList.syncRadios(); };
    for (const m of RP_MODES) {
      const b = h('button', { class: 'model ripple-host', type: 'button', role: 'radio', 'aria-checked': String(rpMode(s()) === m.id), 'data-rp': m.id },
        h('span', { class: 'radio-dot' }), h('span', { class: 'model-text' }, h('span', { class: 'model-label', text: m.label }), h('span', { class: 'model-desc', text: m.desc })));
      b.addEventListener('click', async () => {
        const prev = rpMode(s());
        if (prev === m.id && b.getAttribute('aria-checked') === 'true') return;
        markRp(m.id);
        const ok = await ctx.saveSettings({ restorePoints: m.id }, { silent: true });
        if (ok) toast({ type: 'ok', title: m.id === 'off' ? 'Wiederherstellungspunkte aus' : 'Wiederherstellungspunkte: ' + m.label });
        else markRp(prev); // show what is really saved
      });
      rpList.appendChild(b);
    }
    radioKeys(rpList, (b) => b.click());

    // ---------- KI providers
    const ai = aiSection(ctx);

    // ---------- about
    const m = ctx.mode || {};
    const about = h('dl', { class: 'about' },
      h('dt', { text: 'Version' }), h('dd', { class: 'about-mono', text: ctx.app.version || '–' }),
      h('dt', { text: 'Modus' }), h('dd', {}, m.simulate ? badge('Testmodus', 'neutral', 'flask') : badge('Echtbetrieb', 'accent', 'bolt')),
      h('dt', { text: 'Rechte' }), h('dd', {}, m.admin ? badge('Administrator', 'ok', 'shieldCheck') : badge('Ohne Adminrechte', 'warn', 'alert')),
      h('dt', { text: 'Windows' }), h('dd', { text: m.os || 'unbekannt' }),
      h('dt', { text: 'PowerShell' }), h('dd', { class: 'about-mono', text: m.ps || 'unbekannt' }));
    const aboutBrand = h('div', { class: 'about-brand' }, h('img', { src: 'brand/wordmark.svg', alt: 'VELOX', width: '136', height: '32' }));

    const section = (id, ic, title, desc, ...children) => h('section', { class: 'card pad-24 set-section', id: 'set-' + id },
      h('div', { class: 'set-head' }, h('span', { class: 'set-icon' }, icon(ic, 18)), h('div', {}, h('h2', { class: 'section-title', text: title }), h('p', { class: 'section-desc', text: desc }))), ...children);

    append(el, h('div', { class: 'set-grid' },
      section('look', 'sparkles', 'Start und Bewegung', 'Wie VELOX startet und sich bewegt.',
        optionRow({ icon: 'volume', title: 'Start-Sound', desc: 'Ein kurzer Klang zur Startanimation. Taste M schaltet ihn auch beim Start um.', control: startSound }),
        introRow,
        optionRow({ icon: 'motion', title: 'Animationen', desc: osReduced ? 'Windows wünscht weniger Bewegung – VELOX hält sich daran.' : 'Reduziert schaltet Bewegungen ab und lässt nur sanfte Überblendungen.', control: motion })),
      section('safety', 'shield', 'Sicherheit', 'Schutz vor ungewollten Änderungen.',
        optionRow({ title: 'Bei riskanten Tweaks nachfragen', desc: 'Zeigt eine Warnung mit Häkchen, bevor ein riskanter Tweak vorgemerkt wird.', control: risky }),
        h('div', { class: 'rp-block' },
          h('div', { class: 'field-label', text: 'Windows-Wiederherstellungspunkte' }),
          h('p', { class: 'fine', text: 'Ein Wiederherstellungspunkt kann mehrere GB Speicher belegen. VELOX braucht ihn nicht, um etwas rückgängig zu machen – er ist nur ein zusätzliches Netz.' }),
          rpList)),
      section('ai', 'sparkles', 'KI', 'Welche KI der KI-Optimierer nutzt. Am besten: Claude Code mit deinem Claude-Abo.', ai.el),
      section('about', 'info', 'Über VELOX', 'Version und Umgebung.', aboutBrand, about,
        h('div', { class: 'note ' + (m.simulate ? 'note-warn' : 'note-info') + ' mt-16' }, icon('flask', 15), h('span', { text: m.simulate
          ? 'Testmodus ist an: VELOX zeigt dir alles und tut so, als würde es Änderungen anwenden – an deinem PC wird aber nichts verändert. Zum echten Anwenden schließ VELOX und starte ' + startHint(false) + '.'
          : 'Echtbetrieb: Änderungen werden wirklich angewendet. Zum gefahrlosen Ausprobieren gibt es ' + startHint(true) + ' – dort wird nichts verändert.' })))));

    // focus 'ai' / 'claude' (older links) / 'groq' / 'claude-code' / 'claude-api': open that provider card
    const aiFocus = opts && { ai: 'claude-code', claude: 'claude-api', 'claude-api': 'claude-api', groq: 'groq', 'claude-code': 'claude-code' }[opts.focus];
    if (aiFocus) requestAnimationFrame(() => ai.focus(aiFocus));
    if (opts && opts.focus === 'safety') requestAnimationFrame(() => { const t = el.querySelector('#set-safety'); if (t) { t.scrollIntoView({ block: 'start' }); t.classList.add('flash'); const r = rpList.querySelector('[aria-checked="true"]'); if (r) r.focus({ preventScroll: true }); } });
    ctx.on('settings', () => {
      startSound.setChecked(s().startSound !== false); markRp(rpMode(s()));
      intro.select(introMode(s())); introRow.querySelector('.opt-desc').textContent = introDesc(introMode(s()));
    });
  }
};
