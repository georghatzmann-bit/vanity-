// Apps: Autostart manager (startup-list / startup-set) and Bloatware removal (kind "remove" tweaks).
// Startup names and commands are untrusted strings from the PC: textContent only.
import { icon } from '../icons.js';
import { h, clear, button, toggle, checkbox, badge, segmented, emptyState, stagger, toast, plural, confirmDialog, avatar, skeleton, append } from '../ui.js';

/** Short, friendly label for a startup location; the full path stays in the tooltip. */
function locationBadge(loc) {
  const l = String(loc || '');
  let label = l || 'Unbekannt';
  if (/^HKCU\\/i.test(l) || /^HKEY_CURRENT_USER/i.test(l)) label = 'Registry · Benutzer';
  else if (/^HKLM\\/i.test(l) || /^HKEY_LOCAL_MACHINE/i.test(l)) label = 'Registry · Alle Benutzer';
  const b = badge(label, 'neutral');
  b.title = l;
  return b;
}

export default {
  id: 'apps', title: 'Apps', icon: 'package', desc: 'Autostart aufräumen und vorinstallierten Ballast entfernen', keywords: 'autostart bloatware programme entfernen deinstallieren',
  mount(el, ctx, opts) {
    let tab = (opts && opts.tab) || ctx.cache.appsTab || 'startup';
    const box = h('div', { class: 'apps-body' });
    const tabs = segmented({
      label: 'Bereich', value: tab, cls: 'seg-lg',
      options: [{ value: 'startup', label: 'Autostart', icon: 'power' }, { value: 'bloat', label: 'Bloatware', icon: 'trash' }],
      onChange: (v) => { tab = v; ctx.cache.appsTab = v; render(); }
    });
    append(el, h('div', { class: 'apps-tabs' }, tabs), box);

    function render() { clear(box); if (tab === 'startup') startup(); else bloat(); }

    // ---------- autostart
    function startup() {
      const listEl = h('div', { class: 'list-card', 'data-testid': 'startup-list' });
      const reload = button({ label: 'Aktualisieren', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => load(true) });
      const info = h('p', { class: 'section-desc' });
      append(box, h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Programme beim Windows-Start' }), info), reload), h('section', { class: 'card' }, listEl));
      function fill(animate) {
        clear(listEl);
        const items = ctx.cache.startup;
        if (!items) { for (let i = 0; i < 5; i++) listEl.appendChild(h('div', { class: 'su-row' }, h('div', { class: 'skel', style: { width: '36px', height: '36px', 'border-radius': '10px' } }), skeleton(2, 'grow'))); info.textContent = 'Wird gelesen …'; return; }
        const on = items.filter(i => i.enabled).length;
        info.textContent = plural(items.length, 'Eintrag', 'Einträge') + ', davon ' + on + ' aktiv. Weniger Autostart = schnellerer Start und weniger Hintergrundlast.';
        if (!items.length) { listEl.appendChild(emptyState({ icon: 'power', title: 'Kein Autostart', text: 'Beim Windows-Start werden keine zusätzlichen Programme geladen. Perfekt.' })); return; }
        for (const it of items) {
          const sw = toggle({ checked: !!it.enabled, label: 'Autostart: ' + it.name, onChange: async (next) => {
            const job = await ctx.runJob('startup-set', { id: it.id, enabled: next }, { overlay: false, quiet: true });
            if (job && job.status === 'done') {
              const ni = (job.result && job.result.item) || {};
              it.enabled = ni.enabled !== undefined ? !!ni.enabled : next;
              toast({ type: 'ok', title: it.name + (it.enabled ? ' startet wieder mit Windows' : ' startet nicht mehr mit Windows'), text: 'Gilt ab dem nächsten Windows-Start.' });
              row.classList.toggle('is-off', !it.enabled);
              const n = items.filter(i => i.enabled).length;
              info.textContent = plural(items.length, 'Eintrag', 'Einträge') + ', davon ' + n + ' aktiv. Weniger Autostart = schnellerer Start und weniger Hintergrundlast.';
              return true;
            }
            return false;
          } });
          const row = h('div', { class: ['su-row', !it.enabled && 'is-off'], 'data-id': it.id },
            avatar(it.name, 36),
            h('div', { class: 'su-text' }, h('div', { class: 'su-name', text: it.name }), h('div', { class: 'su-cmd mono', text: it.command || '', title: it.command || '' })),
            locationBadge(it.location),
            sw);
          listEl.appendChild(row);
        }
        if (animate) stagger(listEl);
      }
      async function load(manual) {
        if (manual) { ctx.cache.startup = null; fill(false); }
        const job = await ctx.runJob('startup-list', {}, { overlay: false, quiet: true, quietBusy: !manual });
        if (!box.isConnected) return;
        if (job && job.status === 'done') { ctx.cache.startup = (job.result && job.result.items) || []; fill(true); }
        else if (!job && ctx.busy) ctx.whenIdle(() => { if (box.isConnected && tab === 'startup') load(false); });
        else if (!ctx.cache.startup) { ctx.cache.startup = []; fill(false); }
      }
      fill(false);
      if (!ctx.cache.startup) load(false);
    }

    // ---------- bloatware
    function bloat() {
      const apps = ctx.tweaks.filter(t => t.kind === 'remove');
      const sel = new Set();
      const removeBtn = button({ label: 'Entfernen', icon: 'trash', variant: 'danger', onClick: () => remove(), attrs: { 'data-testid': 'bloat-remove' } });
      const allBtn = button({ label: 'Alle installierten', size: 'sm', variant: 'ghost', onClick: () => { for (const t of apps) if (removable(t)) sel.add(t.id); fill(); } });
      const noneBtn = button({ label: 'Keine', size: 'sm', variant: 'ghost', onClick: () => { sel.clear(); fill(); } });
      const listEl = h('div', { class: 'list-card bloat-list', 'data-testid': 'bloat-list' });
      const removable = (t) => ctx.applicable(t) && ctx.status(t.id) !== 'applied';
      append(box, 
        h('div', { class: 'note note-warn' }, icon('alert', 15), h('span', { text: 'Entfernen ist nicht rückgängig zu machen. Brauchst du eine App doch wieder, installierst du sie einfach über den Microsoft Store neu.' })),
        h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Vorinstallierte Apps' }), h('p', { class: 'section-desc', text: 'Wähle aus, was weg soll. Systemwichtige Apps wie Store oder Sicherheit stehen hier gar nicht erst.' })), h('div', { class: 'section-actions' }, allBtn, noneBtn, removeBtn)),
        h('section', { class: 'card' }, listEl));
      function fill() {
        clear(listEl);
        if (!apps.length) { listEl.appendChild(emptyState({ icon: 'package', title: 'Keine Apps im Katalog', text: 'Die Bloatware-Liste ist noch leer.' })); updBtn(); return; }
        const sorted = apps.slice().sort((a, b) => Number(removable(b)) - Number(removable(a)) || a.name.localeCompare(b.name, 'de'));
        for (const t of sorted) {
          const st = ctx.status(t.id);
          const can = removable(t);
          const cb = checkbox({ checked: sel.has(t.id), disabled: !can, onChange: (v) => { if (v) sel.add(t.id); else sel.delete(t.id); updBtn(); } });
          cb.input.setAttribute('aria-label', t.name);
          const pkg = ((t.actions || []).find(a => a.type === 'appx') || {}).package || '';
          listEl.appendChild(h('div', { class: ['bl-row', !can && 'is-done'], 'data-id': t.id },
            cb,
            h('div', { class: 'su-text' }, h('div', { class: 'su-name', text: t.name }), h('div', { class: 'bl-desc', text: t.desc }), pkg ? h('div', { class: 'su-cmd mono', text: pkg }) : null),
            st === 'applied' ? badge('Entfernt', 'ok', 'check') : !ctx.applicable(t) ? badge('Nicht installiert', 'neutral') : badge('Installiert', 'neutral', 'package')));
        }
        updBtn();
      }
      function updBtn() { removeBtn.querySelector('.btn-label').textContent = 'Entfernen (' + sel.size + ')'; removeBtn.disabled = !sel.size; }
      async function remove() {
        const names = Array.from(sel).map(id => (ctx.byId.get(id) || {}).name).filter(Boolean);
        const ok = await confirmDialog({
          title: plural(sel.size, 'App', 'Apps') + ' entfernen?', danger: true, icon: 'trash',
          text: 'Das ist nicht rückgängig zu machen. Eine Neuinstallation geht nur über den Microsoft Store.',
          body: h('ul', { class: 'confirm-list' }, names.map(n => h('li', { text: n }))),
          confirmLabel: 'Endgültig entfernen'
        });
        if (!ok) return;
        const job = await ctx.runJob('apply', { ids: Array.from(sel), label: 'Apps entfernt (' + sel.size + ')' }, { title: 'Apps werden entfernt' });
        if (job && job.status === 'done') { sel.clear(); fill(); }
      }
      fill();
      stagger(listEl);
      ctx.on('statuses', () => { if (tab === 'bloat' && listEl.isConnected) fill(); });
    }

    render();
  }
};
