// Reinigung: measure cleanup actions (clean-scan), pick, run, show freed space; repair tools below.
import { icon } from '../icons.js';
import { h, clear, button, checkbox, countUp, fmtBytes, fmtNumber, emptyState, stagger, toast, badge, needsBadge, confirmDialog, riskBadge, append } from '../ui.js';

export default {
  id: 'cleanup', title: 'Reinigung', icon: 'broom', desc: 'Speicher freiräumen und Windows reparieren', keywords: 'aufräumen temp cache speicher reparatur sfc dism',
  mount(el, ctx) {
    const actions = ctx.tweaks.filter(t => t.category === 'cleanup' && t.kind === 'action');
    const repairs = ctx.tweaks.filter(t => t.category === 'repair' && t.kind === 'action');
    const sel = new Set(actions.filter(t => t.risk === 'safe' && ctx.applicable(t)).map(t => t.id));
    let sizes = ctx.cache.clean ? ctx.cache.clean.sizes : null;

    const totalEl = h('span', { class: 'clean-total-num', text: '0 B' });
    const totalSub = h('span', { class: 'clean-total-sub' });
    const runBtn = button({ label: 'Ausgewählte bereinigen', icon: 'broom', variant: 'primary', cls: 'btn-brand btn-lg', onClick: () => run(), attrs: { 'data-testid': 'clean-run' } });
    const rescan = button({ label: 'Neu messen', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => scan(true) });
    const list = h('div', { class: 'clean-list', 'data-testid': 'clean-list' });
    const freedBox = h('div', { class: 'clean-freed', hidden: true });

    const summary = h('section', { class: 'card clean-hero spot' },
      h('div', { class: 'hero-bg', 'aria-hidden': 'true' }),
      h('div', { class: 'clean-gauge' }, h('div', { class: 'clean-gauge-ring' }), icon('broom', 30)),
      h('div', { class: 'clean-total' }, h('span', { class: 'eyebrow', text: 'Ausgewählt zum Löschen' }), totalEl, totalSub),
      h('div', { class: 'clean-actions' }, runBtn, rescan),
      freedBox);

    function total() { let b = 0; let f = 0; for (const id of sel) { const s = sizes && sizes[id]; if (s) { b += s.bytes || 0; f += s.files || 0; } } return { b, f }; }
    function updTotal() {
      const { b, f } = total();
      countUp(totalEl, b, { format: fmtBytes, duration: 600 });
      totalSub.textContent = sizes ? (sel.size + ' von ' + actions.length + ' Bereichen · ' + fmtNumber(f) + ' Dateien') : 'Wird gemessen …';
      const unknown = sizes ? Array.from(sel).some(id => !sizes[id]) : false;
      runBtn.disabled = !sel.size || !sizes || (b === 0 && !unknown);
      runBtn.title = runBtn.disabled && sizes && sel.size ? 'Gerade gibt es hier nichts zu löschen.' : '';
    }

    function fill(animate) {
      clear(list);
      if (!actions.length) { list.appendChild(emptyState({ icon: 'broom', title: 'Keine Reinigungs-Aktionen', text: 'Der Katalog enthält noch keine Reinigung.' })); return; }
      for (const t of actions) {
        const s = sizes && sizes[t.id];
        const na = !ctx.applicable(t);
        const cb = checkbox({ checked: sel.has(t.id), disabled: na, onChange: (v) => { if (v) sel.add(t.id); else sel.delete(t.id); updTotal(); } });
        cb.input.setAttribute('aria-label', t.name);
        const size = h('div', { class: 'clean-size' });
        if (!sizes) size.appendChild(h('div', { class: 'skel', style: { width: '64px', height: '14px' } }));
        else if (s) { const n = h('span', { class: 'clean-bytes', text: '0 B' }); append(size, n, h('span', { class: 'clean-files', text: fmtNumber(s.files || 0) + ' Dateien' })); countUp(n, s.bytes || 0, { format: fmtBytes, from: 0, duration: 800 }); }
        else size.appendChild(h('span', { class: 'clean-files', text: '–' }));
        list.appendChild(h('div', { class: ['clean-row', na && 'is-na'], 'data-id': t.id },
          cb,
          h('div', { class: 'clean-text' }, h('div', { class: 'clean-name' }, h('span', { text: t.name }), t.risk !== 'safe' ? riskBadge(t.risk) : null), h('div', { class: 'clean-desc', text: na ? (t.naReason || 'Nicht verfügbar') : t.desc }), t.warning ? h('div', { class: 'clean-warn' }, icon('alert', 13), h('span', { text: t.warning })) : null),
          size));
      }
      if (animate) stagger(list);
      updTotal();
    }

    async function scan(manual) {
      sizes = null; fill(false);
      const job = await ctx.runJob('clean-scan', {}, { overlay: false, quiet: true, quietBusy: !manual });
      if (!el.isConnected) return;
      if (job && job.status === 'done') {
        sizes = {};
        for (const it of (job.result && job.result.items) || []) sizes[it.id] = { bytes: it.bytes || 0, files: it.files || 0 };
        ctx.cache.clean = { sizes, at: Date.now() };
      } else if (!job && ctx.busy) {
        ctx.whenIdle(() => { if (el.isConnected) scan(false); });
        return;
      } else sizes = {};
      fill(true);
    }

    async function run() {
      const ids = Array.from(sel);
      const risky = ids.map(id => ctx.byId.get(id)).filter(t => t && t.risk !== 'safe' && t.warning);
      if (risky.length) {
        const ok = await confirmDialog({ title: 'Wirklich löschen?', text: risky.map(t => t.name + ': ' + t.warning).join(' '), confirmLabel: 'Löschen', danger: true });
        if (!ok) return;
      }
      const before = total().b;
      const job = await ctx.runJob('run-action', { ids }, { title: 'Reinigung läuft', quiet: true });
      if (!job || job.status !== 'done') return;
      const res = (job.result && job.result.results) || [];
      const bytes = res.reduce((s, r) => s + (Number(r.freedBytes) || 0), 0);
      const fails = res.filter(r => !r.ok);
      append(clear(freedBox), 
        h('div', { class: 'freed-icon' }, icon('checkCircle', 22)),
        h('div', {}, h('div', { class: 'freed-label', text: 'Freigegeben' }), h('div', { class: 'freed-num', 'data-testid': 'clean-freed', text: '0 B' })),
        fails.length ? badge(fails.length + ' übersprungen', 'warn', 'warn') : null);
      freedBox.hidden = false;
      countUp(freedBox.querySelector('.freed-num'), bytes, { from: 0, format: fmtBytes, duration: 1400 });
      toast({ type: fails.length ? 'warn' : 'ok', title: fmtBytes(bytes) + ' freigegeben', text: fails.length ? fails.length + ' Bereiche waren gesperrt oder fehlgeschlagen.' : (before > bytes * 1.2 ? 'Manche Dateien waren gerade in Benutzung und bleiben.' : 'Sauber!') });
      ctx.cache.clean = null;
      scan(false);
    }

    // repair
    const repairGrid = h('div', { class: 'repair-grid' });
    for (const t of repairs) {
      const b = button({ label: 'Ausführen', icon: 'play', size: 'sm', variant: 'secondary', disabled: !ctx.applicable(t), onClick: async () => {
        if (t.warning) { const ok = await confirmDialog({ title: t.name + '?', text: t.warning, confirmLabel: 'Ausführen' }); if (!ok) return; }
        const job = await ctx.runJob('run-action', { ids: [t.id] }, { title: t.name, quiet: true, icon: 'wrench' });
        if (job && job.status === 'done') { const r = ((job.result && job.result.results) || [])[0] || {}; toast({ type: r.ok === false ? 'warn' : 'ok', title: t.name, text: r.message || 'Fertig.' }); }
      } });
      repairGrid.appendChild(h('article', { class: 'card repair-card spot', 'data-id': t.id },
        h('div', { class: 'repair-top' }, h('span', { class: 'repair-icon' }, icon('wrench', 18)), h('div', { class: 'repair-badges' }, t.risk !== 'safe' ? riskBadge(t.risk) : null, needsBadge(t.needs))),
        h('h3', { class: 'repair-name', text: t.name }),
        h('p', { class: 'repair-desc', text: t.desc }),
        t.warning ? h('p', { class: 'clean-warn' }, icon('alert', 13), h('span', { text: t.warning })) : null,
        h('div', { class: 'repair-foot' }, b)));
    }

    append(el, summary,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Was gelöscht werden kann' }), h('p', { class: 'section-desc', text: 'Nur Dateien, die Windows und Programme jederzeit neu anlegen. Gesperrte Dateien werden übersprungen.' }))),
      h('section', { class: 'card clean-card' }, list),
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Reparatur' }), h('p', { class: 'section-desc', text: 'Werkzeuge für typische Windows-Probleme. Jedes zeigt dir live, was passiert.' }))),
      repairs.length ? repairGrid : h('section', { class: 'card pad-24' }, emptyState({ icon: 'wrench', title: 'Keine Reparatur-Werkzeuge', text: 'Der Katalog enthält noch keine Reparaturen.' })));
    stagger(repairGrid);

    if (sizes) fill(false);
    else scan(false);
  }
};
