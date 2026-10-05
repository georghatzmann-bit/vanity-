// Einstellungen: accent (live), motion, safety switches, Claude key/model, about + Testmodus.
import { icon } from '../icons.js';
import { h, clear, button, toggle, segmented, optionRow, toast, confirmDialog, badge, append } from '../ui.js';
import { api } from '../api.js';

const ACCENTS = [
  ['violet', 'Violett'], ['blue', 'Blau'], ['cyan', 'Cyan'], ['green', 'Grün'], ['pink', 'Pink'], ['orange', 'Orange']
];
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 – beste Qualität (Standard)', desc: 'Gründlichste Analyse. Dauert etwas länger und kostet mehr pro Anfrage.' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 – schneller und günstiger', desc: 'Sehr gute Vorschläge in kürzerer Zeit.' }
];

export default {
  id: 'settings', title: 'Einstellungen', icon: 'cog', desc: 'Aussehen, Sicherheit und Claude KI', keywords: 'optionen farbe animation api key claude',
  mount(el, ctx, opts) {
    const s = () => ctx.settings;

    // ---------- appearance
    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Akzentfarbe' });
    for (const [id, name] of ACCENTS) {
      const b = h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(s().accent === id), 'aria-label': name, 'data-tip': name, 'data-accent': id }, h('span', { class: 'swatch-dot' }), icon('check', 14, 'swatch-check'));
      b.addEventListener('click', async () => {
        for (const x of swatches.children) x.setAttribute('aria-checked', String(x === b));
        document.documentElement.dataset.accent = id; // live preview before the server answers
        const ok = await ctx.saveSettings({ accent: id }, { silent: true });
        if (ok) toast({ type: 'ok', title: 'Akzentfarbe: ' + name });
      });
      swatches.appendChild(b);
    }
    const osReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motion = segmented({
      label: 'Animationen', value: s().motion === 'reduced' ? 'reduced' : 'full',
      options: [{ value: 'full', label: 'Voll', icon: 'sparkles' }, { value: 'reduced', label: 'Reduziert', icon: 'motion' }],
      onChange: async (v) => { const ok = await ctx.saveSettings({ motion: v }, { silent: true }); if (ok) toast({ type: 'ok', title: v === 'reduced' ? 'Animationen reduziert' : 'Alle Animationen an' }); }
    });

    // ---------- safety
    const risky = toggle({ checked: s().confirmRisky !== false, label: 'Bei riskanten Tweaks nachfragen', onChange: async (v) => {
      if (!v) { const ok = await confirmDialog({ title: 'Nachfrage abschalten?', text: 'Riskante Tweaks werden dann ohne Warnung vorgemerkt. Empfohlen ist: anlassen.', confirmLabel: 'Abschalten', danger: true }); if (!ok) return false; }
      return ctx.saveSettings({ confirmRisky: v });
    } });
    const rp = toggle({ checked: s().autoRestorePoint !== false, label: 'Automatischer Wiederherstellungspunkt', onChange: (v) => ctx.saveSettings({ autoRestorePoint: v }) });

    // ---------- claude
    const claudeBox = h('div', { class: 'claude-box' });
    function fillClaude() {
      clear(claudeBox);
      const c = s().claude || {};
      const status = h('div', { class: 'key-status ' + (c.hasKey ? 'is-ok' : 'is-off') },
        icon(c.hasKey ? 'checkCircle' : 'key', 18),
        h('div', {}, h('strong', { text: c.hasKey ? 'API-Key hinterlegt' : 'Kein API-Key hinterlegt' }), h('span', { text: c.hasKey ? 'Verschlüsselt mit Windows (DPAPI) gespeichert. VELOX zeigt ihn nie wieder an.' : 'Ohne Key nutzt der KI-Optimierer die kostenlose Smart-Analyse.' })));
      const input = h('input', { class: 'input', type: 'password', placeholder: c.hasKey ? 'Neuen Key eingeben, um ihn zu ersetzen' : 'sk-ant-…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Claude API-Key', 'data-testid': 'claude-key' });
      const save = button({ label: 'Speichern', icon: 'lock', variant: 'primary', onClick: async () => {
        const key = input.value.trim();
        if (!key) { toast({ type: 'warn', title: 'Kein Key eingegeben' }); input.focus(); return; }
        save.disabled = true;
        try {
          const r = await api.setClaudeKey(key);
          input.value = '';
          ctx.settings.claude = Object.assign({}, ctx.settings.claude, { hasKey: !!(r && r.hasKey) });
          ctx.emit('settings');
          toast({ type: 'ok', title: 'API-Key gespeichert', text: 'Claude ist jetzt im KI-Optimierer verfügbar.' });
          fillClaude();
        } catch (e) { toast({ type: 'error', title: 'Key nicht gespeichert', text: e.message }); save.disabled = false; }
      }, attrs: { 'data-testid': 'claude-save' } });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
      const del = c.hasKey ? button({ label: 'Key löschen', icon: 'trash', variant: 'ghost', onClick: async () => {
        const ok = await confirmDialog({ title: 'API-Key löschen?', text: 'Der KI-Optimierer nutzt danach wieder die Smart-Analyse.', confirmLabel: 'Löschen', danger: true });
        if (!ok) return;
        try { await api.deleteClaudeKey(); ctx.settings.claude = Object.assign({}, ctx.settings.claude, { hasKey: false }); ctx.emit('settings'); toast({ type: 'ok', title: 'API-Key gelöscht' }); fillClaude(); }
        catch (e) { toast({ type: 'error', title: 'Konnte nicht löschen', text: e.message }); }
      } }) : null;
      const models = h('div', { class: 'model-list', role: 'radiogroup', 'aria-label': 'Modell' });
      for (const m of MODELS) {
        const b = h('button', { class: 'model ripple-host', type: 'button', role: 'radio', 'aria-checked': String((c.model || 'claude-opus-5-5') === m.id), 'data-model': m.id },
          h('span', { class: 'radio-dot' }), h('span', { class: 'model-text' }, h('span', { class: 'model-label', text: m.label }), h('span', { class: 'model-desc', text: m.desc })));
        b.addEventListener('click', async () => {
          for (const x of models.children) x.setAttribute('aria-checked', String(x === b));
          const ok = await ctx.saveSettings({ claude: { model: m.id } }, { silent: true });
          if (ok) { ctx.settings.claude = Object.assign({}, c, ctx.settings.claude, { model: m.id }); toast({ type: 'ok', title: 'Modell: ' + m.label.split(' – ')[0] }); }
        });
        models.appendChild(b);
      }
      append(claudeBox, status,
        h('div', { class: 'key-row' }, h('div', { class: 'path-input' }, icon('key', 16), input), save, del),
        h('p', { class: 'fine', text: 'Den Key bekommst du unter console.anthropic.com. Jede Analyse kostet ein paar Cent und wird über dein Anthropic-Konto abgerechnet.' }),
        h('div', { class: 'field-label mt-16', text: 'Modell' }), models,
        h('div', { class: 'note note-info mt-16' }, icon('shieldCheck', 15), h('span', { text: 'Was gesendet wird: nur Hardware-Daten (z. B. Prozessor, Grafikkarte, RAM) und welche Tweaks an oder aus sind. Keine Namen, keine Dateien, keine Passwörter.' })));
    }
    fillClaude();

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
        optionRow({ title: 'Automatischer Wiederherstellungspunkt', desc: 'Erstellt vor der ersten Änderung pro Sitzung einen Windows-Wiederherstellungspunkt.', control: rp })),
      section('claude', 'sparkles', 'Claude KI', 'Optional: eine zweite Meinung von Claude für den KI-Optimierer.', claudeBox),
      section('about', 'info', 'Über VELOX', 'Version und Umgebung.', about,
        h('div', { class: 'note ' + (m.simulate ? 'note-warn' : 'note-info') + ' mt-16' }, icon('flask', 15), h('span', { text: m.simulate
          ? 'Testmodus ist an: VELOX zeigt dir alles und tut so, als würde es Änderungen anwenden – an deinem PC wird aber nichts verändert. Zum echten Anwenden starte VELOX über Start.bat statt Start-Testmodus.bat.'
          : 'Echtbetrieb: Änderungen werden wirklich angewendet. Zum gefahrlosen Ausprobieren gibt es Start-Testmodus.bat – dort wird nichts verändert.' })))));

    if (opts && opts.focus === 'claude') requestAnimationFrame(() => { const t = el.querySelector('#set-claude'); if (t) { t.scrollIntoView({ block: 'start' }); t.classList.add('flash'); const i = t.querySelector('input'); if (i) i.focus({ preventScroll: true }); } });
    ctx.on('settings', () => { for (const x of swatches.children) x.setAttribute('aria-checked', String(x.dataset.accent === s().accent)); });
  }
};
