// Detweak: scan for values other tweakers changed, pick what to reset, optionally apply a preset or
// the last AI plan afterwards.
import { icon } from '../icons.js';
import { h, clear, button, checkbox, badge, confirmDialog, emptyState, stagger, plural, countUp, toast, fmtRelative } from '../ui.js';
import { fmtValue } from '../tweakrow.js';

export default {
  id: 'detweak', title: 'Detweak', icon: 'undo', desc: 'Tweaks anderer Tools finden und sauber zurücksetzen', keywords: 'zurücksetzen reset fremd standard default',
  mount(el, ctx, opts) {
    opts = opts || {};
    let thenApply = opts.thenApply ? 'preset:' + opts.thenApply : (ctx.cache.detweakThen || '');
    const selected = new Set();
    const cmdSel = new Set();
    let restorePoint = true;
    let lastResult = null;

    const scanBtn = button({ label: ctx.cache.detweak ? 'Neu scannen' : 'Scan starten', icon: 'search', variant: 'primary', cls: 'btn-brand btn-lg', onClick: () => scan(), attrs: { 'data-testid': 'detweak-scan' } });
    const hero = h('section', { class: 'card hero hero-detweak spot' },
      h('div', { class: 'hero-bg', 'aria-hidden': 'true' }),
      h('div', { class: 'hero-orb' }, h('div', { class: 'hero-orb-ring' }), icon('undo', 34)),
      h('div', { class: 'hero-body' },
        h('div', { class: 'eyebrow', text: 'Detweak' }),
        h('h2', { class: 'hero-title', text: 'Sauber neu starten' }),
        h('p', { class: 'hero-text', text: 'Du hast schon Tweaks von anderen Tools drauf? Hier setzt du alles auf Windows-Standard zurück und startest sauber.' }),
        h('div', { class: 'steps3' },
          h('div', { class: 'step3' }, h('span', { class: 'step3-n', text: '1' }), h('span', { text: 'Scannen' })),
          h('div', { class: 'step3' }, h('span', { class: 'step3-n', text: '2' }), h('span', { text: 'Auswählen' })),
          h('div', { class: 'step3' }, h('span', { class: 'step3-n', text: '3' }), h('span', { text: 'Zurücksetzen' }))),
        h('div', { class: 'hero-actions' }, scanBtn)));
    const body = h('div', { class: 'dt-body' });
    el.append(hero, body);

    if (thenApply && opts.thenApply) {
      const p = ctx.presets.find(x => x.id === opts.thenApply);
      if (p) body.appendChild(h('div', { class: 'note note-info' }, icon('info', 15), h('span', { text: 'Nach dem Zurücksetzen wird das Preset „' + p.name + '“ angewendet. Starte zuerst den Scan.' })));
    }

    function thenIds() {
      if (!thenApply) return [];
      if (thenApply === 'ai') return ((ctx.cache.advisor && ctx.cache.advisor.plan) || []).map(p => p.id).filter(id => { const t = ctx.byId.get(id); return t && t.kind === 'toggle' && ctx.applicable(t); });
      const p = ctx.presets.find(x => 'preset:' + x.id === thenApply);
      return p ? (p.ids || []).filter(id => { const t = ctx.byId.get(id); return t && (t.kind || 'toggle') === 'toggle' && ctx.applicable(t); }) : [];
    }

    async function scan() {
      const job = await ctx.runJob('detweak-scan', {}, { quiet: true });
      if (!job || job.status !== 'done') return;
      const r = job.result || {};
      ctx.cache.detweak = { items: r.items || [], commands: r.commands || [], at: new Date().toISOString() };
      ctx.cache.detweakCount = ctx.cache.detweak.items.length;
      selected.clear();
      for (const it of ctx.cache.detweak.items) selected.add(it.key);
      cmdSel.clear();
      for (const c of ctx.cache.detweak.commands) if (c.defaultOn) cmdSel.add(c.id);
      lastResult = null;
      ctx.emit('pending'); // refreshes the sidebar badge
      toast({ type: ctx.cache.detweak.items.length ? 'warn' : 'ok', title: ctx.cache.detweak.items.length ? plural(ctx.cache.detweak.items.length, 'Abweichung', 'Abweichungen') + ' gefunden' : 'Alles auf Windows-Standard', text: ctx.cache.detweak.items.length ? 'Alles ist vorausgewählt. Entferne Haken bei Dingen, die bleiben sollen.' : 'Kein anderes Tool hat hier etwas verstellt.' });
      render(true);
    }

    function render(animate) {
      clear(body);
      scanBtn.querySelector('.btn-label').textContent = ctx.cache.detweak ? 'Neu scannen' : 'Scan starten';
      if (lastResult) body.appendChild(resultCard(lastResult));
      const data = ctx.cache.detweak;
      if (!data) {
        if (!lastResult) body.appendChild(h('section', { class: 'card pad-24' }, emptyState({ icon: 'search', title: 'Noch nicht gescannt', text: 'Der Scan liest nur und verändert nichts. Er prüft Registry, Boot-Einstellungen, Dienste, Aufgaben und alle VELOX-Tweaks.' })));
        return;
      }
      if (!data.items.length && !lastResult) {
        body.appendChild(h('section', { class: 'card pad-24' }, emptyState({ icon: 'checkCircle', title: 'Alles sauber', text: 'Keine Fremd-Tweaks gefunden. Dein Windows läuft mit Standardwerten – perfekt für einen sauberen Start mit VELOX.', action: button({ label: 'Preset auswählen', icon: 'stack', variant: 'secondary', size: 'sm', onClick: () => ctx.navigate('presets') }) })));
        return;
      }
      if (!data.items.length) return;

      const countEl = h('span', { class: 'dt-count' });
      const allBtn = button({ label: 'Alle', size: 'sm', variant: 'ghost', onClick: () => { for (const it of data.items) selected.add(it.key); syncChecks(); } });
      const noneBtn = button({ label: 'Keine', size: 'sm', variant: 'ghost', onClick: () => { selected.clear(); syncChecks(); } });
      const toolbar = h('div', { class: 'dt-toolbar' },
        h('div', {}, h('h2', { class: 'section-title', text: plural(data.items.length, 'Abweichung', 'Abweichungen') + ' vom Windows-Standard' }), h('p', { class: 'section-desc', text: 'Gescannt ' + fmtRelative(data.at) + '. Links der aktuelle Wert, rechts der Windows-Standard.' })),
        h('div', { class: 'dt-toolbar-actions' }, countEl, allBtn, noneBtn));
      body.appendChild(toolbar);

      const groups = new Map();
      for (const it of data.items) { const g = it.group || 'Sonstiges'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
      const checks = [];
      const groupWrap = h('div', { class: 'dt-groups' });
      for (const [g, items] of groups) {
        const rows = items.map(it => {
          const cb = checkbox({ checked: selected.has(it.key), onChange: (v) => { if (v) selected.add(it.key); else selected.delete(it.key); syncCount(); } });
          cb.input.setAttribute('aria-label', it.label);
          checks.push({ cb, key: it.key });
          return h('div', { class: 'dt-row', 'data-key': it.key },
            cb,
            h('div', { class: 'dt-text' }, h('div', { class: 'dt-label', text: it.label }),
              h('div', { class: 'dt-vals' },
                h('span', { class: 'val val-from', title: 'Aktueller Wert' }, h('span', { class: 'val-label', text: 'Jetzt' }), h('span', { class: 'mono', text: fmtValue(it.current) })),
                icon('arrowRight', 14, 'act-arrow'),
                h('span', { class: 'val val-to', title: 'Windows-Standard' }, h('span', { class: 'val-label', text: 'Standard' }), h('span', { class: 'mono', text: fmtValue(it.default) })))),
            it.source === 'catalog' ? badge('VELOX-Katalog', 'accent', 'sliders') : badge('Fremd-Tweak', 'warn', 'alert'));
        });
        groupWrap.appendChild(h('section', { class: 'card dt-group' }, h('div', { class: 'dt-group-head' }, h('h3', { text: g }), h('span', { class: 'pv-count', text: String(items.length) })), rows));
      }
      body.appendChild(groupWrap);
      if (animate) stagger(groupWrap);

      // options
      const cmds = data.commands.map(c => checkbox({ checked: cmdSel.has(c.id), label: c.label, desc: c.desc + (c.needs === 'reboot' ? ' (Neustart nötig)' : ''), onChange: (v) => { if (v) cmdSel.add(c.id); else cmdSel.delete(c.id); } }));
      const select = h('select', { class: 'select', 'aria-label': 'Danach anwenden', 'data-testid': 'detweak-then' },
        h('option', { value: '', text: 'Nichts – nur zurücksetzen' }),
        ctx.presets.map(p => h('option', { value: 'preset:' + p.id, text: 'Preset: ' + p.name })),
        ctx.cache.advisor ? h('option', { value: 'ai', text: 'Letzter KI-Plan (' + (ctx.cache.advisor.plan || []).length + ' Tweaks)' }) : null);
      select.value = thenApply;
      if (select.value !== thenApply) thenApply = '';
      const thenHint = h('p', { class: 'fine' });
      const updThen = () => { const n = thenIds().length; thenHint.textContent = thenApply ? n + ' Tweaks werden danach angewendet.' : 'Du kannst später jederzeit ein Preset anwenden.'; };
      select.addEventListener('change', () => { thenApply = select.value; ctx.cache.detweakThen = thenApply; updThen(); });
      updThen();
      const rp = checkbox({ checked: restorePoint, label: 'Vorher Wiederherstellungspunkt erstellen', desc: 'Windows-eigenes Sicherheitsnetz. Zusätzlich sichert VELOX jeden Wert.', onChange: (v) => { restorePoint = v; } });
      const goBtn = button({ label: '', icon: 'undo', variant: 'danger', cls: 'btn-lg', onClick: () => run(), attrs: { 'data-testid': 'detweak-run' } });
      body.appendChild(h('section', { class: 'card pad-24 dt-options' },
        h('div', { class: 'dt-opt-grid' },
          h('div', {}, h('div', { class: 'field-label', text: 'Zusätzliche Befehle' }), h('div', { class: 'stack-8' }, cmds.length ? cmds : h('p', { class: 'fine', text: 'Keine zusätzlichen Befehle.' }))),
          h('div', {}, h('div', { class: 'field-label', text: 'Sicherheit' }), rp,
            h('div', { class: 'field-label mt-16', text: 'Danach anwenden' }), select, thenHint)),
        h('div', { class: 'dt-go' }, h('p', { class: 'fine', text: 'Jeder Wert wird vorher gesichert und lässt sich unter "Sicherungen" wiederherstellen.' }), goBtn)));

      function syncCount() {
        countEl.textContent = selected.size + ' von ' + data.items.length + ' ausgewählt';
        goBtn.querySelector('.btn-label').textContent = 'Alles zurücksetzen (' + selected.size + ')';
        goBtn.disabled = !selected.size && !cmdSel.size;
      }
      function syncChecks() { for (const c of checks) c.cb.input.checked = selected.has(c.key); syncCount(); }
      syncCount();
    }

    async function run() {
      const data = ctx.cache.detweak;
      const keys = data.items.filter(i => selected.has(i.key)).map(i => i.key);
      const ids = thenIds();
      const then = !thenApply ? '' : thenApply === 'ai' ? ' Danach wird dein letzter KI-Plan angewendet.' : ' Danach wird „' + ((ctx.presets.find(p => 'preset:' + p.id === thenApply) || {}).name || '') + '“ angewendet.';
      const ok = await confirmDialog({
        title: 'Alles auf Windows-Standard zurücksetzen?', icon: 'undo', tone: 'warn',
        text: plural(keys.length, 'Wert wird', 'Werte werden') + ' zurückgesetzt' + (cmdSel.size ? ' und ' + plural(cmdSel.size, 'Befehl', 'Befehle') + ' ausgeführt' : '') + '.' + then + ' Alles wird vorher gesichert.',
        confirmLabel: 'Zurücksetzen', danger: true
      });
      if (!ok) return;
      const job = await ctx.runJob('detweak', { keys, commands: Array.from(cmdSel), thenApply: ids, restorePoint }, { quiet: true });
      if (!job || job.status !== 'done') return;
      lastResult = job.result || {};
      const remaining = data.items.filter(i => !selected.has(i.key));
      ctx.cache.detweak = Object.assign({}, data, { items: remaining });
      ctx.cache.detweakCount = remaining.length;
      selected.clear();
      ctx.cache.backups = null;
      ctx.emit('pending');
      toast({ type: lastResult.failed ? 'warn' : 'ok', title: plural(lastResult.reset || 0, 'Wert', 'Werte') + ' zurückgesetzt', text: (lastResult.applied ? lastResult.applied + ' Tweaks danach angewendet. ' : '') + 'Gesichert unter "Sicherungen".' });
      render(true);
      body.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function resultCard(r) {
      const n1 = h('strong', { class: 'res-num', text: '0' }); const n2 = h('strong', { class: 'res-num', text: '0' }); const n3 = h('strong', { class: 'res-num', text: '0' });
      requestAnimationFrame(() => { countUp(n1, r.reset || 0); countUp(n2, r.applied || 0); countUp(n3, r.failed || 0); });
      return h('section', { class: 'card result-card pad-24', 'data-testid': 'detweak-result' },
        h('div', { class: 'result-icon' }, icon('checkCircle', 28)),
        h('div', { class: 'result-body' },
          h('h2', { class: 'section-title', text: 'Detweak abgeschlossen' }),
          h('p', { class: 'section-desc', text: r.failed ? 'Ein paar Werte ließen sich nicht ändern – meist fehlen Adminrechte.' : 'Dein Windows ist wieder auf Standard. Ab jetzt hast du die volle Kontrolle.' }),
          h('div', { class: 'res-stats' },
            h('div', { class: 'res-stat' }, n1, h('span', { text: 'zurückgesetzt' })),
            h('div', { class: 'res-stat' }, n2, h('span', { text: 'danach angewendet' })),
            h('div', { class: 'res-stat' + (r.failed ? ' is-warn' : '') }, n3, h('span', { text: 'fehlgeschlagen' })))),
        button({ label: 'Sicherungen', icon: 'archive', variant: 'secondary', size: 'sm', onClick: () => ctx.navigate('backups') }));
    }

    render(false);
    if (opts.autostart) requestAnimationFrame(() => scan());
  }
};
