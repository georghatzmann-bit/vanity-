// Detweak: scan for values other tweakers changed, pick what to reset, optionally apply a preset or
// the last AI plan afterwards.
import { icon } from '../icons.js';
import { h, clear, button, checkbox, badge, riskBadge, confirmDialog, emptyState, stagger, plural, countUp, toast, fmtRelative, append, reducedMotion } from '../ui.js';
import { fmtValue, describeAction } from '../tweakrow.js';

export default {
  id: 'detweak', title: 'Detweak', icon: 'undo', desc: 'Tweaks anderer Tools finden und sauber zurücksetzen', keywords: 'zurücksetzen reset fremd standard default',
  mount(el, ctx, opts) {
    opts = opts || {};
    let thenApply = opts.thenApply ? 'preset:' + opts.thenApply : (ctx.cache.detweakThen || '');
    const selected = new Set();
    const cmdSel = new Set();
    const restorePoint = true; // allows the policy's extra point (settings.restorePoints), never forces one
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
    append(el, hero, body);
    const fromPreset = opts.thenApply ? ctx.presets.find(x => x.id === opts.thenApply) : null;

    function thenIds() {
      if (!thenApply) return [];
      if (thenApply === 'ai') return ((ctx.cache.advisor && ctx.cache.advisor.plan) || []).map(p => p.id).filter(id => { const t = ctx.byId.get(id); return t && t.kind === 'toggle' && ctx.applicable(t); });
      const p = ctx.presets.find(x => 'preset:' + x.id === thenApply);
      return p ? (p.ids || []).filter(id => { const t = ctx.byId.get(id); return t && (t.kind || 'toggle') === 'toggle' && ctx.applicable(t); }) : [];
    }
    function thenName() {
      if (!thenApply) return '';
      if (thenApply === 'ai') return 'dein letzter KI-Plan';
      const p = ctx.presets.find(x => 'preset:' + x.id === thenApply);
      return p ? '„' + p.name + '“' : '';
    }

    /**
     * VELOX's own tweaks: a catalog item whose tweak is fully applied is exactly what VELOX sets
     * (backend may also mark it source "velox"). Those are not foreign, are unchecked by default and
     * are not counted as Fremd-Tweaks.
     */
    // The backend decides from its journals what VELOX set itself (source "velox"); the same rule feeds state.foreignCount.
    const isOwn = (it) => it.source === 'velox';
    const foreignOf = (items) => items.filter(it => !isOwn(it));
    function publishCount() {
      const d = ctx.cache.detweak;
      ctx.cache.detweakCount = d ? foreignOf(d.items).length : null;
      ctx.emit('pending'); // refreshes the sidebar badge
      ctx.emit('detweak');
    }
    /** Real values for a catalog item when its tweak has a single change (e.g. "aus → an"). */
    function values(it) {
      const t = it.tweakId && ctx.byId.get(it.tweakId);
      const acts = t ? (t.actions || []) : [];
      if (it.source !== 'detweak' && acts.length === 1 && isOwn(it)) {
        const d = describeAction(acts[0]);
        if (d.from !== undefined && d.to !== undefined) return { cur: d.to, def: d.from };
      }
      return { cur: fmtValue(it.current), def: fmtValue(it.default) };
    }

    async function scan() {
      const job = await ctx.runJob('detweak-scan', {}, { quiet: true });
      if (!job || job.status !== 'done') return;
      const r = job.result || {};
      ctx.cache.detweak = { items: r.items || [], commands: r.commands || [], at: new Date().toISOString() };
      selected.clear();
      for (const it of ctx.cache.detweak.items) if (!isOwn(it)) selected.add(it.key);
      cmdSel.clear();
      for (const c of ctx.cache.detweak.commands) if (c.defaultOn) cmdSel.add(c.id);
      lastResult = null;
      publishCount();
      const nF = ctx.cache.detweakCount; const nOwn = ctx.cache.detweak.items.length - nF;
      toast({
        type: nF ? 'warn' : 'ok',
        title: nF ? plural(nF, 'Fremd-Tweak', 'Fremd-Tweaks') + ' gefunden' : 'Keine Fremd-Tweaks',
        text: nF ? 'Sie sind vorausgewählt. Entferne Haken bei Dingen, die bleiben sollen.' + (nOwn ? ' Deine ' + nOwn + ' VELOX-Tweaks bleiben unangetastet.' : '') : (nOwn ? 'Nur deine eigenen VELOX-Tweaks weichen ab – die bleiben, wie sie sind.' : 'Kein anderes Tool hat hier etwas verstellt.')
      });
      render(true);
    }

    function thenNote() {
      if (!thenApply) return null;
      const n = thenIds().length;
      return h('section', { class: 'card then-card', 'data-testid': 'detweak-then-note' },
        h('span', { class: 'then-icon' }, icon(thenApply === 'ai' ? 'brain' : 'stack', 18)),
        h('div', { class: 'then-text' },
          h('div', { class: 'then-title', text: 'Danach: ' + thenName().replace(/^dein /, 'Dein ') + ' – ' + plural(n, 'Tweak', 'Tweaks') }),
          h('div', { class: 'fine', text: ctx.cache.detweak ? 'Wird direkt nach dem Zurücksetzen angewendet. Unten unter „Danach anwenden“ kannst du das ändern.' : 'Wird nach dem Zurücksetzen angewendet. Der Scan läuft – danach wählst du aus, was zurückgesetzt wird.' })));
    }

    function render(animate) {
      clear(body);
      document.documentElement.classList.remove('has-dock');
      scanBtn.querySelector('.btn-label').textContent = ctx.cache.detweak ? 'Neu scannen' : 'Scan starten';
      // once there is a result, the red "zurücksetzen" bar is the next step: the rescan steps back
      const scanned = !!ctx.cache.detweak;
      scanBtn.classList.toggle('btn-primary', !scanned); scanBtn.classList.toggle('btn-brand', !scanned);
      scanBtn.classList.toggle('btn-secondary', scanned);
      if (lastResult) body.appendChild(resultCard(lastResult));
      const note = thenNote();
      if (note) body.appendChild(note);
      const data = ctx.cache.detweak;
      if (!data) {
        if (!lastResult) body.appendChild(h('section', { class: 'card pad-24' }, emptyState({ icon: 'search', title: ctx.busy && ctx.busy.type === 'detweak-scan' ? 'Scan läuft …' : 'Noch nicht gescannt', text: 'Der Scan liest nur und verändert nichts. Er prüft Registry, Boot-Einstellungen, Dienste, Aufgaben und alle VELOX-Tweaks.' })));
        return;
      }
      const foreign = foreignOf(data.items);
      const own = data.items.filter(isOwn);
      if (!foreign.length && !own.length && !lastResult) {
        body.appendChild(h('section', { class: 'card pad-24' }, emptyState({ icon: 'checkCircle', title: 'Alles sauber', text: 'Keine Fremd-Tweaks gefunden. Dein Windows läuft mit Standardwerten – perfekt für einen sauberen Start mit VELOX.', action: button({ label: 'Preset auswählen', icon: 'stack', variant: 'secondary', size: 'sm', onClick: () => ctx.navigate('presets') }) })));
        return;
      }
      if (!data.items.length) return;

      const countEl = h('span', { class: 'dt-count' });
      const allBtn = button({ label: 'Alle Fremd-Tweaks', size: 'sm', variant: 'ghost', onClick: () => { for (const it of foreign) selected.add(it.key); syncChecks(); } });
      const noneBtn = button({ label: 'Keine', size: 'sm', variant: 'ghost', onClick: () => { selected.clear(); syncChecks(); } });
      const toolbar = h('div', { class: 'dt-toolbar' },
        h('div', {}, h('h2', { class: 'section-title', text: foreign.length ? plural(foreign.length, 'Fremd-Tweak', 'Fremd-Tweaks') + ' gefunden' : 'Keine Fremd-Tweaks' }),
          h('p', { class: 'section-desc', text: 'Gescannt ' + fmtRelative(data.at) + '. Links der aktuelle Wert, rechts der Windows-Standard.' + (own.length ? ' Deine eigenen VELOX-Tweaks stehen ganz unten und sind nicht ausgewählt.' : '') })),
        h('div', { class: 'dt-toolbar-actions' }, countEl, allBtn, noneBtn));
      body.appendChild(toolbar);

      const checks = [];
      const groupWrap = h('div', { class: 'dt-groups' });
      const row = (it) => {
        const cb = checkbox({ checked: selected.has(it.key), onChange: (v) => { if (v) selected.add(it.key); else selected.delete(it.key); syncCount(); } });
        cb.input.setAttribute('aria-label', it.label);
        checks.push({ cb, key: it.key });
        const v = values(it);
        return h('div', { class: ['dt-row', isOwn(it) && 'is-own'], 'data-key': it.key, 'data-own': isOwn(it) ? '1' : null },
          cb,
          h('div', { class: 'dt-text' }, h('div', { class: 'dt-label', text: it.label }),
            h('div', { class: 'dt-vals' },
              h('span', { class: 'val val-from', title: 'Aktueller Wert' }, h('span', { class: 'val-label', text: 'Jetzt' }), h('span', { class: 'mono', text: v.cur })),
              icon('arrowRight', 14, 'act-arrow'),
              h('span', { class: 'val val-to', title: 'Windows-Standard' }, h('span', { class: 'val-label', text: 'Standard' }), h('span', { class: 'mono', text: v.def })))),
          isOwn(it) ? badge('Von VELOX gesetzt', 'accent', 'check') : it.source === 'catalog' ? badge('Anderes Tool', 'warn', 'info') : badge('Fremd-Tweak', 'warn', 'alert'));
      };
      const groups = new Map();
      for (const it of foreign) { const g = it.group || 'Sonstiges'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
      for (const [g, items] of groups) {
        groupWrap.appendChild(h('section', { class: 'card dt-group' }, h('div', { class: 'dt-group-head' }, h('h3', { text: g }), h('span', { class: 'pv-count', text: String(items.length) })), items.map(row)));
      }
      if (own.length) {
        const sect = h('details', { class: 'card dt-group dt-own', open: !foreign.length },
          h('summary', { class: 'dt-group-head' }, icon('chevronRight', 14), h('h3', { text: 'Von VELOX gesetzt' }), h('span', { class: 'fine', text: 'Deine eigenen Tweaks – nur abhaken, wenn du sie auf Windows-Standard zurücksetzen willst.' }), h('span', { class: 'pv-count', text: String(own.length) })),
          own.map(row));
        groupWrap.appendChild(sect);
      }
      body.appendChild(groupWrap);
      if (animate) stagger(groupWrap);

      // options
      const cmds = data.commands.map(c => {
        const cb = checkbox({ checked: cmdSel.has(c.id), label: c.label, desc: c.desc, onChange: (v) => { if (v) cmdSel.add(c.id); else cmdSel.delete(c.id); syncCount(); } });
        const badges = [c.needs === 'reboot' ? badge('Neustart', 'neutral', 'restart') : null, c.risk && c.risk !== 'safe' ? riskBadge(c.risk) : null].filter(Boolean);
        return h('div', { class: 'dt-cmd', 'data-cmd': c.id }, cb, badges.length ? h('div', { class: 'dt-cmd-badges' }, badges) : null);
      });
      const select = h('select', { class: 'select', 'aria-label': 'Danach anwenden', 'data-testid': 'detweak-then' },
        h('option', { value: '', text: 'Nichts – nur zurücksetzen' }),
        ctx.presets.map(p => h('option', { value: 'preset:' + p.id, text: 'Preset: ' + p.name })),
        ctx.cache.advisor ? h('option', { value: 'ai', text: 'Letzter KI-Plan (' + (ctx.cache.advisor.plan || []).length + ' Tweaks)' }) : null);
      select.value = thenApply;
      if (select.value !== thenApply) thenApply = '';
      const thenHint = h('p', { class: 'fine' });
      const updThen = () => { const n = thenIds().length; thenHint.textContent = thenApply ? plural(n, 'Tweak wird', 'Tweaks werden') + ' danach angewendet.' : 'Du kannst später jederzeit ein Preset anwenden.'; };
      select.addEventListener('change', () => { thenApply = select.value; ctx.cache.detweakThen = thenApply; updThen(); syncCount(); const n = body.querySelector('.then-card'); const nn = thenNote(); if (n && nn) n.replaceWith(nn); else if (n) n.remove(); else if (nn) toolbar.before(nn); });
      updThen();
      // Windows restore points follow settings.restorePoints (docs/ARCHITECTURE.md §8) - Detweak
      // never forces an extra one; the journal makes every reset undoable anyway
      const rpMode = (ctx.settings && ctx.settings.restorePoints) || (ctx.settings && ctx.settings.autoRestorePoint === false ? 'off' : 'first');
      const rpText = rpMode === 'presets'
        ? 'VELOX sichert jeden Wert vorher im eigenen Journal. Ab 10 Werten legt es zusätzlich einen Windows-Wiederherstellungspunkt an – höchstens einen pro Tag.'
        : rpMode === 'off'
          ? 'VELOX sichert jeden Wert vorher im eigenen Journal – rückgängig unter „Sicherungen“. Windows-Wiederherstellungspunkte sind aus.'
          : 'VELOX sichert jeden Wert vorher im eigenen Journal – rückgängig unter „Sicherungen“. Einen Windows-Wiederherstellungspunkt gibt es nur einmal, vor deiner allerersten Änderung.';
      const rp = h('div', { class: 'stack-8', 'data-testid': 'detweak-rp' }, h('p', { class: 'fine', text: rpText }),
        h('div', {}, button({ label: 'Wiederherstellungspunkte einstellen', icon: 'cog', size: 'sm', variant: 'ghost', onClick: () => ctx.navigate('settings', { focus: 'safety' }) })));
      body.appendChild(h('section', { class: 'card pad-24 dt-options' },
        h('div', { class: 'dt-opt-grid' },
          h('div', {}, h('div', { class: 'field-label', text: 'Zusätzliche Befehle' }), h('p', { class: 'fine dt-cmd-hint', text: 'Wirken auf das ganze System. Lies die Beschreibung, bevor du einen Haken setzt.' }), h('div', { class: 'stack-8' }, cmds.length ? cmds : h('p', { class: 'fine', text: 'Keine zusätzlichen Befehle.' }))),
          h('div', {}, h('div', { class: 'field-label', text: 'Sicherheit' }), rp,
            h('div', { class: 'field-label mt-16', text: 'Danach anwenden' }), select, thenHint))));

      // sticky action bar: always shows what will happen
      const sumEl = h('div', { class: 'dt-go-sum' });
      const goBtn = button({ label: '', icon: 'undo', variant: 'danger', cls: 'btn-lg', onClick: () => run(), attrs: { 'data-testid': 'detweak-run' } });
      body.appendChild(h('div', { class: 'dt-go card' }, sumEl, goBtn));
      document.documentElement.classList.add('has-dock'); // toasts move above the sticky bar

      function syncCount() {
        const nV = selected.size; const nC = cmdSel.size;
        countEl.textContent = nV + ' von ' + data.items.length + ' ausgewählt';
        const parts = [plural(nV, 'Wert', 'Werte')];
        if (nC) parts.push(plural(nC, 'Befehl', 'Befehle'));
        const none = !nV && !nC;
        goBtn.querySelector('.btn-label').textContent = none ? 'Nichts ausgewählt' : 'Ausgewählte zurücksetzen (' + parts.join(' + ') + ')';
        goBtn.disabled = none;
        clear(sumEl).append(
          h('strong', { text: none ? 'Nichts ausgewählt' : parts.join(' + ') + ' ausgewählt' }),
          h('span', { class: 'fine', text: none ? 'Setz oben einen Haken bei allem, was zurück auf Windows-Standard soll.' : (nC ? 'Befehle: ' + data.commands.filter(c => cmdSel.has(c.id)).map(c => c.label).join(', ') + '. ' : '') + (thenApply ? 'Danach: ' + thenName() + '. ' : '') + 'Alles wird vorher gesichert.' }));
      }
      function syncChecks() { for (const c of checks) c.cb.input.checked = selected.has(c.key); syncCount(); }
      syncCount();
    }

    async function run() {
      const data = ctx.cache.detweak;
      const keys = data.items.filter(i => selected.has(i.key)).map(i => i.key);
      const ownKeys = data.items.filter(i => selected.has(i.key) && isOwn(i)).length;
      const cmdList = data.commands.filter(c => cmdSel.has(c.id));
      const ids = thenIds();
      const then = !thenApply ? '' : ' Danach wird ' + thenName() + ' angewendet.';
      const ok = await confirmDialog({
        title: 'Ausgewählte auf Windows-Standard zurücksetzen?', icon: 'undo', tone: 'warn',
        text: plural(keys.length, 'Wert wird', 'Werte werden') + ' zurückgesetzt' + (ownKeys ? ' (davon ' + ownKeys + ' eigene VELOX-Tweaks)' : '') + (cmdList.length ? ' und ' + plural(cmdList.length, 'Befehl', 'Befehle') + ' ausgeführt' : '') + '.' + then + ' Werte werden vorher gesichert.',
        body: cmdList.length ? h('div', { class: 'stack-8' }, h('div', { class: 'field-label', text: 'Diese Befehle laufen für das ganze System:' }), h('ul', { class: 'confirm-list' }, cmdList.map(c => h('li', {}, h('strong', { text: c.label }), h('span', { class: 'fine', text: ' – ' + c.desc + (c.needs === 'reboot' ? ' Danach ist ein Neustart nötig.' : '') })))), h('p', { class: 'fine', text: 'Befehle lassen sich nicht automatisch rückgängig machen.' })) : null,
        confirmLabel: 'Zurücksetzen', danger: true
      });
      if (!ok) return;
      const job = await ctx.runJob('detweak', { keys, commands: cmdList.map(c => c.id), thenApply: ids, restorePoint }, { quiet: true, summary: (j) => ctx.detweakLine(splitCounts(j.result || {}, keys.length, cmdList.length)) + ctx.needsSuffix((j.result || {}).needs) });
      if (!job || job.status !== 'done') return;
      lastResult = splitCounts(job.result || {}, keys.length, cmdList.length);
      const remaining = data.items.filter(i => !selected.has(i.key));
      ctx.cache.detweak = Object.assign({}, data, { items: remaining });
      selected.clear();
      // the commands just ran: offering "0 Werte + 2 Befehle" again right away would only repeat them
      for (const c of cmdList) cmdSel.delete(c.id);
      publishCount();
      toast({ type: lastResult.failed ? 'warn' : 'ok', title: ctx.detweakLine(lastResult), text: (lastResult.failed ? lastResult.failed + ' fehlgeschlagen. ' : '') + 'Gesichert unter „Sicherungen“.' + ctx.needsSuffix(lastResult.needs).replace(' · ', ' ') });
      render(true);
      body.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    /** The backend counts commands inside "reset"; split them so values and commands are reported apart. */
    function splitCounts(r, nValues, nCmds) {
      if (typeof r.resetValues === 'number' || typeof r.commandsRun === 'number') return r;
      const reset = r.reset || 0;
      const vals = Math.min(nValues, reset);
      return Object.assign({}, r, { resetValues: vals, commandsRun: Math.min(nCmds, Math.max(0, reset - vals)) });
    }

    function resultCard(r) {
      const n1 = h('strong', { class: 'res-num', text: '0' }); const n1b = h('strong', { class: 'res-num', text: '0' }); const n2 = h('strong', { class: 'res-num', text: '0' }); const n3 = h('strong', { class: 'res-num', text: '0' });
      requestAnimationFrame(() => { countUp(n1, r.resetValues || 0); countUp(n1b, r.commandsRun || 0); countUp(n2, r.applied || 0); countUp(n3, r.failed || 0); });
      const errs = (r.errors || []).slice(0, 2);
      return h('section', { class: 'card result-card pad-24', 'data-testid': 'detweak-result' },
        h('div', { class: 'result-icon' }, icon('checkCircle', 28)),
        h('div', { class: 'result-body' },
          h('h2', { class: 'section-title', text: 'Detweak abgeschlossen' }),
          h('p', { class: 'section-desc', text: r.failed ? 'Ein paar Werte ließen sich nicht ändern – meist fehlen Adminrechte.' : 'Die ausgewählten Werte sind wieder auf Windows-Standard.' + (r.needs && r.needs.reboot ? ' Starte den PC neu, damit alles wirkt.' : '') }),
          h('div', { class: 'res-stats' },
            h('div', { class: 'res-stat' }, n1, h('span', { text: 'Werte zurückgesetzt' })),
            r.commandsRun ? h('div', { class: 'res-stat' }, n1b, h('span', { text: 'Befehle ausgeführt' })) : null,
            h('div', { class: 'res-stat' }, n2, h('span', { text: 'Tweaks danach angewendet' })),
            h('div', { class: 'res-stat' + (r.failed ? ' is-warn' : '') }, n3, h('span', { text: 'fehlgeschlagen' }))),
          errs.length ? h('ul', { class: 'res-errors' }, errs.map(e => h('li', { text: ctx.friendlyError(e) }))) : null),
        button({ label: 'Sicherungen', icon: 'archive', variant: 'secondary', size: 'sm', onClick: () => ctx.navigate('backups') }));
    }

    render(false);
    // coming from a preset ("Vorher Detweak"): the scan is the obvious next step, start it right away
    if (opts.autostart || (fromPreset && !ctx.cache.detweak)) requestAnimationFrame(() => scan());
    return { destroy() { document.documentElement.classList.remove('has-dock'); } };
  }
};
