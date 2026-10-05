// Tweak rows (used by Tweaks, Spiele and the preset preview) + the human-readable
// "Was genau geändert wird" description of every action type (section 3).
import { icon } from './icons.js';
import { h, clear, toggle, riskBadge, impactBars, badge, button, confirmDialog, toast, append, flyTo } from './ui.js';

const START = { Automatic: 'Automatisch', AutomaticDelayed: 'Automatisch (verzögert)', Manual: 'Manuell', Disabled: 'Deaktiviert' };
const PLAN = { ultimate: 'Ultimative Leistung', high: 'Höchstleistung', balanced: 'Ausbalanciert' };

export function fmtValue(v, kind) {
  if (v === null || v === undefined) return 'nicht vorhanden';
  if (v === true) return 'an';
  if (v === false) return 'aus';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(leer)';
  if (typeof v === 'number') {
    if (v > 65535 || kind === 'hex') return v + ' (0x' + (v >>> 0).toString(16).toUpperCase() + ')';
    return String(v);
  }
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s === '' ? '(leer)' : s;
}

/** One action -> { kind, title, target, from, to, code } (all plain strings). */
export function describeAction(a) {
  switch (a.type) {
    case 'reg': return { kind: 'Registry-Wert', icon: 'key', target: a.path + (a.name === '' ? ' (Standardwert)' : '\\' + a.name), from: fmtValue(a.default), to: fmtValue(a.value), note: a.onlyExisting ? 'nur wo der Wert schon existiert' : (a.path.includes('*') ? 'für jeden Unterschlüssel' : null), extra: a.kind };
    case 'regkey': return { kind: 'Registry-Schlüssel', icon: 'key', target: a.path, from: a.default ? 'vorhanden' : 'nicht vorhanden', to: a.present ? 'wird angelegt' : 'wird gelöscht' };
    case 'service': return { kind: 'Dienst', icon: 'layers', target: a.name, from: START[a.default] || a.default, to: START[a.start] || a.start, note: a.start === 'Disabled' && a.stop !== false ? 'wird auch sofort beendet' : null };
    case 'task': return { kind: 'Geplante Aufgabe', icon: 'clock', target: a.path, from: a.default ? 'aktiviert' : 'deaktiviert', to: a.enabled ? 'aktiviert' : 'deaktiviert' };
    case 'bcd': return { kind: 'Boot-Einstellung', icon: 'power', target: a.name, from: a.default === null || a.default === undefined ? 'nicht gesetzt' : String(a.default), to: String(a.value) };
    case 'powerplan': return { kind: 'Energieplan', icon: 'bolt', target: 'Aktiver Energieplan', from: PLAN[a.default] || a.default, to: PLAN[a.plan] || a.plan };
    case 'powersetting': {
      const d = a.default || {};
      const parts = [];
      if (a.ac !== null && a.ac !== undefined) parts.push('Netzbetrieb ' + fmtValue(d.ac) + ' → ' + a.ac);
      if (a.dc !== null && a.dc !== undefined) parts.push('Akku ' + fmtValue(d.dc) + ' → ' + a.dc);
      return { kind: 'Energieoption', icon: 'bolt', target: a.subgroup + ' / ' + a.setting, text: parts.join(', ') };
    }
    case 'feature': return { kind: 'Windows-Feature', icon: 'package', target: a.name, from: a.default ? 'an' : 'aus', to: a.enabled ? 'an' : 'aus' };
    case 'appx': return { kind: 'App', icon: 'trash', target: a.package, text: 'wird für alle Benutzer entfernt (nicht rückgängig)' };
    case 'clean': return { kind: 'Dateien löschen', icon: 'broom', target: (a.paths || []).join('\n'), text: (a.keep && a.keep.length ? 'ausgenommen: ' + a.keep.join(', ') : '') + (a.stopServices && a.stopServices.length ? ' Dienste kurz anhalten: ' + a.stopServices.join(', ') : '') };
    case 'ps': return { kind: 'PowerShell', icon: 'command', code: a.apply, revert: a.revert };
    default: return { kind: a.type, icon: 'dots', text: JSON.stringify(a) };
  }
}

export function actionList(t) {
  const list = h('ul', { class: 'act-list' });
  for (const a of t.actions || []) {
    const d = describeAction(a);
    const li = h('li', { class: 'act' },
      h('div', { class: 'act-kind' }, icon(d.icon, 14), h('span', { text: d.kind })),
      d.target && h('div', { class: 'act-target mono', text: d.target }));
    if (d.from !== undefined || d.to !== undefined) {
      li.appendChild(h('div', { class: 'act-change' },
        h('span', { class: 'val val-from', title: 'Windows-Standard' }, h('span', { class: 'val-label', text: 'Windows' }), h('span', { class: 'mono', text: d.from })),
        icon('arrowRight', 14, 'act-arrow'),
        h('span', { class: 'val val-to', title: 'Mit diesem Tweak' }, h('span', { class: 'val-label', text: 'VELOX' }), h('span', { class: 'mono', text: d.to }))));
    }
    if (d.text) li.appendChild(h('div', { class: 'act-text', text: d.text }));
    if (d.note) li.appendChild(h('div', { class: 'act-text', text: d.note }));
    if (d.code) {
      li.appendChild(h('pre', { class: 'code' }, h('code', { text: d.code })));
      if (d.revert) li.appendChild(h('div', { class: 'act-text', text: 'Rückgängig mit:' }), h('pre', { class: 'code' }, h('code', { text: d.revert })));
    }
    list.appendChild(li);
  }
  return list;
}

const STATUS_BADGE = {
  applied: ['Aktiv', 'ok', 'checkCircle'],
  custom: ['Von anderem Tool geändert', 'warn', 'info'],
  partial: ['Von anderem Tool geändert', 'warn', 'info'],
  unknown: ['Status unbekannt', 'neutral', 'info'],
  na: ['Nicht verfügbar', 'neutral', 'lock']
};

/** Builds one row. Call updateRow() after statuses/pending change. */
export function tweakRow(ctx, t, opts = {}) {
  const kind = t.kind || 'toggle';
  const row = h('div', { class: 'trow', 'data-id': t.id, 'data-risk': t.risk, 'data-kind': kind, 'data-impact': t.impact || 1 });
  const title = h('div', { class: 'trow-title' }, h('span', { class: 'trow-name', text: t.name }), opts.showCategory && h('span', { class: 'trow-cat', text: ctx.catName(t.category) }));
  const meta = h('div', { class: 'trow-meta' });
  const desc = h('div', { class: 'trow-desc', text: t.desc });
  const text = h('div', { class: 'trow-text' }, title, desc, meta);
  const expand = h('button', { class: 'icon-btn trow-expand', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Details zu ' + t.name, 'data-tip': 'Details' }, icon('chevronDown', 16));
  let control;
  if (kind === 'toggle') {
    control = toggle({
      label: t.name,
      onChange: async (next) => {
        const before = ctx.pending.has(t.id);
        const ok = await ctx.stage(t.id, next);
        updateRow(ctx, row, t);
        // staged (not un-staged): a dot springs from the switch into the counter of the pending bar
        if (ok && !before && ctx.pending.has(t.id)) {
          const target = document.getElementById('pending-count');
          requestAnimationFrame(() => flyTo(control, target, () => { target.classList.remove('bump'); void target.offsetWidth; target.classList.add('bump'); }));
        }
        return false;
      }
    });
  } else if (kind === 'action') {
    control = button({ label: 'Ausführen', icon: 'play', size: 'sm', onClick: () => runAction(ctx, t) });
  } else {
    control = button({ label: 'Entfernen', icon: 'trash', size: 'sm', variant: 'ghost', onClick: () => removeApp(ctx, t) });
  }
  const main = h('div', { class: 'trow-main' }, text, h('div', { class: 'trow-ctrl' }, control, expand));
  const details = h('div', { class: 'trow-details', hidden: true });
  append(row, main, details);
  row._control = control;
  row._meta = meta;
  row._t = t;

  const toggleDetails = () => {
    const open = details.hidden;
    if (open && !details.firstChild) fillDetails(ctx, t, details);
    details.hidden = !open;
    expand.setAttribute('aria-expanded', String(open));
    row.classList.toggle('open', open);
  };
  expand.addEventListener('click', toggleDetails);
  main.addEventListener('click', (e) => { if (e.target.closest('button, a, input, label')) return; toggleDetails(); });
  updateRow(ctx, row, t);
  return row;
}

function fillDetails(ctx, t, box) {
  const st = ctx.status(t.id);
  box.appendChild(h('div', { class: 'trow-details-inner' },
    t.info && h('p', { class: 'trow-info', text: t.info }),
    t.warning && h('div', { class: 'note note-warn' }, icon('alert', 15), h('span', { text: 'Nachteil: ' + t.warning })),
    (st === 'custom' || st === 'partial') && h('div', { class: 'note note-info' }, icon('info', 15), h('span', { text: st === 'partial' ? 'Nur ein Teil dieser Werte ist gesetzt – vermutlich von einem anderen Tweaker. Einschalten setzt alle Werte sauber, Detweak setzt sie auf Windows-Standard zurück.' : 'Ein anderes Tool hat hier einen eigenen Wert eingetragen. Einschalten überschreibt ihn, Detweak setzt ihn auf Windows-Standard zurück.' })),
    !ctx.applicable(t) && h('div', { class: 'note note-info' }, icon('lock', 15), h('span', { text: 'Nicht verfügbar: ' + (t.naReason || 'passt nicht zu deinem PC.') })),
    h('div', { class: 'trow-sub', text: 'Was genau geändert wird' }),
    actionList(t),
    proDetails(t)));
}
/** Internal id, tags and value types: only for people who want them. */
function proDetails(t) {
  const kinds = Array.from(new Set((t.actions || []).filter(a => a.type === 'reg' && a.kind).map(a => a.kind)));
  return h('details', { class: 'pro' },
    h('summary', {}, icon('chevronRight', 13), h('span', { text: 'Für Profis' })),
    h('dl', { class: 'pro-list' },
      h('dt', { text: 'ID' }), h('dd', { class: 'mono', text: t.id }),
      t.tags && t.tags.length ? [h('dt', { text: 'Stichwörter' }), h('dd', { class: 'mono', text: t.tags.join(', ') })] : null,
      kinds.length ? [h('dt', { text: 'Registry-Typ' }), h('dd', { class: 'mono', text: kinds.join(', ') })] : null));
}

export function updateRow(ctx, row, t) {
  t = t || row._t;
  const kind = t.kind || 'toggle';
  const st = ctx.status(t.id);
  const na = !ctx.applicable(t);
  const pending = ctx.pending.has(t.id);
  row.dataset.status = st;
  row.classList.toggle('is-pending', pending);
  row.classList.toggle('is-na', na);
  const c = row._control;
  if (kind === 'toggle') {
    c.setChecked(ctx.effective(t.id));
    c.disabled = na;
    if (na) { c.title = t.naReason || 'Nicht verfügbar'; c.dataset.tip = t.naReason || 'Nicht verfügbar'; }
    else { c.removeAttribute('title'); delete c.dataset.tip; }
  } else if (kind === 'remove') {
    c.disabled = na || st === 'applied';
    c.querySelector('.btn-label').textContent = st === 'applied' ? 'Entfernt' : 'Entfernen';
  } else {
    c.disabled = na;
  }
  // Risk + impact + exactly one state; restart needs are a small icon with a tooltip.
  const meta = clear(row._meta);
  meta.appendChild(riskBadge(t.risk));
  meta.appendChild(impactBars(t.impact));
  if (pending) meta.appendChild(h('span', { class: 'badge badge-accent badge-pending' }, h('span', { class: 'dot' }), h('span', { text: ctx.pending.get(t.id) ? 'Vorgemerkt: an' : 'Vorgemerkt: aus' })));
  else if (kind === 'remove') meta.appendChild(badge(st === 'applied' ? 'Entfernt' : na ? 'Nicht vorhanden' : 'Installiert', st === 'applied' ? 'ok' : 'neutral'));
  else if (kind === 'toggle' && STATUS_BADGE[st]) {
    const [txt, tone, ic] = STATUS_BADGE[st];
    const b = badge(txt, tone, ic);
    if (st === 'na' && t.naReason) { b.title = t.naReason; b.querySelector('span:last-child').textContent = 'Nicht verfügbar: ' + t.naReason; }
    meta.appendChild(b);
  }
  const NEEDS = { reboot: ['restart', 'Wirkt erst nach einem Neustart'], logoff: ['user', 'Wirkt erst nach Ab- und Anmelden'], explorer: ['refresh', 'Wirkt nach einem Explorer-Neustart'] };
  if (NEEDS[t.needs]) meta.appendChild(h('span', { class: 'needs-ic', 'data-tip': NEEDS[t.needs][1], title: NEEDS[t.needs][1] }, icon(NEEDS[t.needs][0], 13), h('span', { class: 'sr-only', text: NEEDS[t.needs][1] })));
}

async function runAction(ctx, t) {
  if (t.risk !== 'safe' && t.warning) {
    const ok = await confirmDialog({ title: t.name + ' ausführen?', text: t.warning, confirmLabel: 'Ausführen', danger: t.risk === 'risky' });
    if (!ok) return;
  }
  const job = await ctx.runJob('run-action', { ids: [t.id] }, { title: t.name });
  if (job && job.status === 'done') {
    const r = ((job.result && job.result.results) || [])[0] || {};
    toast({ type: r.ok === false ? 'warn' : 'ok', title: t.name, text: r.message || (r.ok === false ? 'Fehlgeschlagen' : 'Erledigt') });
  }
}

async function removeApp(ctx, t) {
  const ok = await confirmDialog({ title: t.name + ' entfernen?', text: 'Das ist nicht rückgängig zu machen. Du kannst die App später über den Microsoft Store neu installieren.', confirmLabel: 'Entfernen', danger: true });
  if (!ok) return;
  // quiet: the generic apply toast would offer "Rückgängig", which does not exist for removed apps
  const job = await ctx.runJob('apply', { ids: [t.id], label: 'App entfernt: ' + t.name }, { title: 'App wird entfernt', quiet: true });
  if (job && job.status === 'done') {
    const r = ((job.result && job.result.results) || [])[0] || {};
    toast(r.ok === false
      ? { type: 'warn', title: t.name + ' nicht entfernt', text: r.error || 'Fehlgeschlagen.' }
      : { type: 'ok', title: t.name + ' entfernt', text: 'Neu installieren geht jederzeit über den Microsoft Store.' });
  }
}

/**
 * Renders rows into container incrementally (first chunk sync, rest per animation frame) so lists
 * with 500+ tweaks stay smooth. groupBy(t) -> heading text or null. Returns { rows, cancel }.
 */
export function renderList(ctx, container, list, opts = {}) {
  clear(container);
  const rows = new Map();
  let cancelled = false;
  const items = [];
  let lastGroup = null;
  for (const t of list) {
    const g = opts.groupBy ? opts.groupBy(t) : null;
    if (g && g !== lastGroup) { items.push({ group: g }); lastGroup = g; }
    items.push({ t });
  }
  let i = 0;
  let animIndex = 0;
  const step = (n) => {
    if (cancelled) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(items.length, i + n);
    for (; i < end; i++) {
      const it = items[i];
      let el;
      if (it.group) el = h('div', { class: 'trow-group', text: it.group });
      else { el = tweakRow(ctx, it.t, opts); rows.set(it.t.id, el); }
      if (animIndex < 18 && opts.animate !== false) { el.classList.add('enter'); el.style.setProperty('--i', String(animIndex)); }
      animIndex++;
      frag.appendChild(el);
    }
    container.appendChild(frag);
    if (i < items.length && !cancelled) requestAnimationFrame(() => step(80));
    else if (opts.onDone) opts.onDone();
  };
  step(opts.firstChunk || 30);
  return { rows, cancel: () => { cancelled = true; }, update: () => { for (const [, r] of rows) updateRow(ctx, r); } };
}
