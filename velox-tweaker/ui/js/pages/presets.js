// Presets: cards + preview drawer that lists only the changes that would really happen.
import { icon } from '../icons.js';
import { h, clear, button, drawer, badge, riskBadge, needsBadge, checkbox, emptyState, stagger, plural, toast, RISK, append } from '../ui.js';

export function presetPlan(ctx, p) {
  const ts = (p.ids || []).map(id => ctx.byId.get(id)).filter(Boolean);
  const will = ts.filter(t => ctx.applicable(t) && (t.kind === 'action' || (t.kind === 'remove' ? ctx.status(t.id) !== 'applied' : !ctx.isApplied(t.id))));
  const done = ts.filter(t => ctx.applicable(t) && t.kind !== 'action' && ctx.isApplied(t.id));
  const na = ts.filter(t => !ctx.applicable(t));
  return { all: ts, will, done, na, missing: (p.ids || []).length - ts.length };
}

export function recommendedFor(ctx, p) {
  const ff = ctx.state.profile && ctx.state.profile.formFactor;
  return !!ff && Array.isArray(p.recommendedFor) && p.recommendedFor.includes(ff);
}

/** Applies a preset: toggles via one apply job, cleanup actions via run-action afterwards. */
export async function applyPreset(ctx, p, ids) {
  const toggles = ids.filter(id => (ctx.byId.get(id) || {}).kind !== 'action');
  const actions = ids.filter(id => (ctx.byId.get(id) || {}).kind === 'action');
  let ok = true;
  if (toggles.length) {
    const job = await ctx.runJob('apply', { ids: toggles, label: 'Preset: ' + p.name }, { title: 'Preset „' + p.name + '“ wird angewendet' });
    ok = !!job && job.status === 'done';
  }
  if (ok && actions.length) {
    const job = await ctx.runJob('run-action', { ids: actions }, { title: 'Preset „' + p.name + '“: Aufräumen', quiet: true });
    ok = !!job && job.status === 'done';
    if (ok) toast({ type: 'ok', title: 'Aufgeräumt', text: plural(actions.length, 'Aktion', 'Aktionen') + ' ausgeführt.' });
  }
  return ok;
}

export default {
  id: 'presets', title: 'Presets', icon: 'stack', desc: 'Fertige Pakete – ein Klick, alles passend eingestellt', keywords: 'profile pakete gaming esport laptop',
  mount(el, ctx) {
    const grid = h('div', { class: 'preset-grid' });
    function fill() {
      clear(grid);
      if (!ctx.presets.length) {
        grid.appendChild(h('div', { class: 'card pad-24 span-all' }, emptyState({ icon: 'stack', title: 'Noch keine Presets', text: 'Die Preset-Liste ist leer. Du kannst Tweaks trotzdem einzeln unter "Tweaks" vormerken.', action: button({ label: 'Zu den Tweaks', variant: 'secondary', size: 'sm', onClick: () => ctx.navigate('tweaks') }) })));
        return;
      }
      const sorted = ctx.presets.slice().sort((a, b) => Number(recommendedFor(ctx, b)) - Number(recommendedFor(ctx, a)));
      for (const p of sorted) {
        const plan = presetPlan(ctx, p);
        const total = plan.all.length;
        const pct = total ? Math.round(plan.done.length / total * 100) : 0;
        const rec = recommendedFor(ctx, p);
        const r = RISK[p.maxRisk] || RISK.safe;
        const card = h('button', { class: ['card preset-card clickable spot tilt', rec && 'is-rec'], type: 'button', 'data-preset': p.id, 'aria-label': p.name + ': Vorschau öffnen' },
          h('div', { class: 'preset-top' },
            h('div', { class: 'preset-icon' }, icon(p.icon || 'stack', 22)),
            rec ? h('span', { class: 'badge badge-accent' }, icon('star', 12), h('span', { text: 'Empfohlen für dich' })) : null),
          h('div', { class: 'preset-name', text: p.name }),
          h('div', { class: 'preset-tagline', text: p.tagline || '' }),
          h('p', { class: 'preset-desc', text: p.desc || '' }),
          h('div', { class: 'preset-foot' },
            h('span', { class: 'preset-count' }, h('strong', { text: String(total) }), ' ' + (total === 1 ? 'Änderung' : 'Änderungen')),
            h('span', { class: 'badge badge-' + r.tone, title: 'Höchstes Risiko in diesem Preset' }, icon(r.icon, 12), h('span', { text: 'max. ' + r.label }))),
          h('div', { class: 'preset-progress', title: plan.done.length + ' von ' + total + ' schon aktiv' },
            h('div', { class: 'mini-bar' }, h('div', { class: 'mini-bar-fill', style: { transform: 'scaleX(' + pct / 100 + ')' } })),
            h('span', { class: 'preset-pct', text: plan.will.length ? plan.done.length + ' von ' + total + ' aktiv' : 'Alles aktiv' })));
        card.addEventListener('click', () => openPreview(ctx, p));
        grid.appendChild(card);
      }
      stagger(grid);
    }
    append(el, 
      h('div', { class: 'intro' },
        h('p', { class: 'intro-text', text: 'Jedes Preset ist eine geprüfte Auswahl. Riskante Tweaks sind nie dabei. Vor dem Anwenden siehst du genau, was sich ändert – und alles wird gesichert.' })),
      grid);
    fill();
    ctx.on('statuses', fill);
    ctx.on('catalog', fill);
    ctx.on('state', fill);
  }
};

function openPreview(ctx, p) {
  const plan = presetPlan(ctx, p);
  let detweakFirst = false;
  const listItem = (t, state) => h('li', { class: 'pv-item pv-' + state },
    h('div', { class: 'pv-text' }, h('div', { class: 'pv-name', text: t.name }), h('div', { class: 'pv-desc', text: state === 'na' ? (t.naReason || 'Passt nicht zu deinem PC') : t.desc })),
    h('div', { class: 'pv-badges' }, state === 'will' ? riskBadge(t.risk) : null, state === 'will' ? needsBadge(t.needs) : null, state === 'done' ? badge('Schon aktiv', 'ok', 'check') : null, state === 'na' ? badge('Nicht verfügbar', 'neutral', 'lock') : null, t.kind === 'action' ? badge('Einmalig', 'neutral', 'play') : null));
  const sect = (title, items, state, open) => {
    if (!items.length) return null;
    const d = h('details', { class: 'pv-sect', open: !!open }, h('summary', {}, icon('chevronRight', 14), h('span', { text: title }), h('span', { class: 'pv-count', text: String(items.length) })),
      h('ul', { class: 'pv-list' }, items.map(t => listItem(t, state))));
    return d;
  };
  const needsReboot = plan.will.some(t => t.needs === 'reboot');
  const summary = h('div', { class: 'pv-summary' },
    h('div', { class: 'pv-stat' }, h('strong', { text: String(plan.will.length) }), h('span', { text: 'werden geändert' })),
    h('div', { class: 'pv-stat' }, h('strong', { text: String(plan.done.length) }), h('span', { text: 'schon aktiv' })),
    h('div', { class: 'pv-stat' }, h('strong', { text: String(plan.na.length) }), h('span', { text: 'passen nicht' })));
  const applyBtn = button({ label: plan.will.length ? 'Anwenden (' + plan.will.length + ')' : 'Alles schon aktiv', icon: plan.will.length ? 'bolt' : 'check', variant: 'primary', disabled: !plan.will.length, attrs: { 'data-testid': 'preset-apply' } });
  const dtBox = checkbox({
    label: 'Vorher Detweak ausführen', desc: 'Setzt zuerst Tweaks anderer Tools auf Windows-Standard zurück und wendet danach dieses Preset an.',
    onChange: (v) => { detweakFirst = v; applyBtn.querySelector('.btn-label').textContent = v ? 'Weiter zu Detweak' : (plan.will.length ? 'Anwenden (' + plan.will.length + ')' : 'Alles schon aktiv'); applyBtn.disabled = !v && !plan.will.length; }
  });
  const body = h('div', { class: 'pv' },
    h('p', { class: 'pv-desc-main', text: p.desc || '' }),
    summary,
    needsReboot ? h('div', { class: 'note note-info' }, icon('restart', 15), h('span', { text: 'Einige Änderungen wirken erst nach einem Neustart.' })) : null,
    plan.will.length ? sect('Wird geändert', plan.will, 'will', true) : h('div', { class: 'note note-ok' }, icon('checkCircle', 15), h('span', { text: 'Alles aus diesem Preset ist bei dir schon eingestellt.' })),
    sect('Schon aktiv', plan.done, 'done', false),
    sect('Passt nicht zu deinem PC', plan.na, 'na', false),
    dtBox);
  const cancel = button({ label: 'Abbrechen', variant: 'ghost', onClick: () => d.close(false) });
  const d = drawer({ title: p.name, subtitle: p.tagline, icon: p.icon || 'stack', body, footer: [cancel, applyBtn] });
  applyBtn.addEventListener('click', async () => {
    if (detweakFirst) { d.close(true); ctx.navigate('detweak', { thenApply: p.id }); return; }
    d.close(true);
    await applyPreset(ctx, p, plan.will.map(t => t.id));
  });
}
