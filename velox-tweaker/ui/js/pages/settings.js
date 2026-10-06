// Einstellungen: accent (live), motion, safety switches, KI providers (settings-ai.js), about + Testmodus.
import { icon } from '../icons.js';
import { h, clear, button, toggle, segmented, optionRow, toast, confirmDialog, badge, append, radioKeys, startHint } from '../ui.js';
import { aiSection } from './settings-ai.js';

const ACCENTS = [
  ['violet', 'Violett'], ['blue', 'Blau'], ['cyan', 'Cyan'], ['green', 'Grün'], ['pink', 'Pink'], ['orange', 'Orange']
];
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

export { MODELS } from './settings-ai.js';

export default {
  id: 'settings', title: 'Einstellungen', icon: 'cog', desc: 'Aussehen, Sicherheit und KI', keywords: 'optionen farbe animation api key claude code groq ki',
  mount(el, ctx, opts) {
    const s = () => ctx.settings;

    // ---------- appearance
    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Akzentfarbe' });
    for (const [id, name] of ACCENTS) {
      const b = h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(s().accent === id), 'aria-label': name, 'data-tip': name, 'data-accent': id }, h('span', { class: 'swatch-dot' }), icon('check', 14, 'swatch-check'));
      b.addEventListener('click', async () => {
        const prev = s().accent || 'violet';
        if (prev === id && b.getAttribute('aria-checked') === 'true') return;
        markSwatch(id);
        document.documentElement.dataset.accent = id; // live preview before the server answers
        const ok = await ctx.saveSettings({ accent: id }, { silent: true });
        if (ok) toast({ type: 'ok', title: 'Akzentfarbe: ' + name });
        else { markSwatch(prev); document.documentElement.dataset.accent = prev; } // show what is really saved
      });
      swatches.appendChild(b);
    }
    function markSwatch(id) { for (const x of swatches.children) x.setAttribute('aria-checked', String(x.dataset.accent === id)); if (swatches.syncRadios) swatches.syncRadios(); }
    radioKeys(swatches, (b) => b.click());
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
      h('dt', { text: 'Version' }), h('dd', { text: (ctx.app.name || 'VELOX') + ' ' + (ctx.app.version || '') }),
      h('dt', { text: 'Modus' }), h('dd', {}, m.simulate ? badge('Testmodus', 'neutral', 'flask') : badge('Echtbetrieb', 'accent', 'bolt')),
      h('dt', { text: 'Rechte' }), h('dd', {}, m.admin ? badge('Administrator', 'ok', 'shieldCheck') : badge('Ohne Adminrechte', 'warn', 'alert')),
      h('dt', { text: 'Windows' }), h('dd', { text: m.os || 'unbekannt' }),
      h('dt', { text: 'PowerShell' }), h('dd', { text: m.ps || 'unbekannt' }));

    const section = (id, ic, title, desc, ...children) => h('section', { class: 'card pad-24 set-section', id: 'set-' + id },
      h('div', { class: 'set-head' }, h('span', { class: 'set-icon' }, icon(ic, 18)), h('div', {}, h('h2', { class: 'section-title', text: title }), h('p', { class: 'section-desc', text: desc }))), ...children);

    append(el, h('div', { class: 'set-grid' },
      section('look', 'palette', 'Aussehen', 'So sieht VELOX für dich aus.',
        optionRow({ title: 'Akzentfarbe', desc: 'Färbt Schalter, Buttons und Hervorhebungen. Wirkt sofort.', control: swatches }),
        optionRow({ title: 'Animationen', desc: osReduced ? 'Windows wünscht weniger Bewegung – VELOX hält sich daran.' : 'Reduziert schaltet Bewegungen ab und lässt nur sanfte Überblendungen.', control: motion })),
      section('safety', 'shield', 'Sicherheit', 'Schutz vor ungewollten Änderungen.',
        optionRow({ title: 'Bei riskanten Tweaks nachfragen', desc: 'Zeigt eine Warnung mit Häkchen, bevor ein riskanter Tweak vorgemerkt wird.', control: risky }),
        h('div', { class: 'rp-block' },
          h('div', { class: 'field-label', text: 'Windows-Wiederherstellungspunkte' }),
          h('p', { class: 'fine', text: 'Ein Wiederherstellungspunkt kann mehrere GB Speicher belegen. VELOX braucht ihn nicht, um etwas rückgängig zu machen – er ist nur ein zusätzliches Netz.' }),
          rpList)),
      section('ai', 'sparkles', 'KI', 'Welche KI der KI-Optimierer nutzt. Am besten: Claude Code mit deinem Claude-Abo.', ai.el),
      section('about', 'info', 'Über VELOX', 'Version und Umgebung.', about,
        h('div', { class: 'note ' + (m.simulate ? 'note-warn' : 'note-info') + ' mt-16' }, icon('flask', 15), h('span', { text: m.simulate
          ? 'Testmodus ist an: VELOX zeigt dir alles und tut so, als würde es Änderungen anwenden – an deinem PC wird aber nichts verändert. Zum echten Anwenden schließ VELOX und starte ' + startHint(false) + '.'
          : 'Echtbetrieb: Änderungen werden wirklich angewendet. Zum gefahrlosen Ausprobieren gibt es ' + startHint(true) + ' – dort wird nichts verändert.' })))));

    // focus 'ai' / 'claude' (older links) / 'groq' / 'claude-code' / 'claude-api': open that provider card
    const aiFocus = opts && { ai: 'claude-code', claude: 'claude-api', 'claude-api': 'claude-api', groq: 'groq', 'claude-code': 'claude-code' }[opts.focus];
    if (aiFocus) requestAnimationFrame(() => ai.focus(aiFocus));
    if (opts && opts.focus === 'safety') requestAnimationFrame(() => { const t = el.querySelector('#set-safety'); if (t) { t.scrollIntoView({ block: 'start' }); t.classList.add('flash'); const r = rpList.querySelector('[aria-checked="true"]'); if (r) r.focus({ preventScroll: true }); } });
    ctx.on('settings', () => { markSwatch(s().accent || 'violet'); markRp(rpMode(s())); });
  }
};
