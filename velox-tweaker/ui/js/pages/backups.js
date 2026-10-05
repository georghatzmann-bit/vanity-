// Sicherungen: journal list with expandable entries, restore, manual restore point.
import { icon } from '../icons.js';
import { h, clear, button, badge, confirmDialog, emptyState, stagger, fmtDate, fmtRelative, plural, toast, skeleton, append } from '../ui.js';
import { api } from '../api.js';
import { fmtValue } from '../tweakrow.js';

const KIND = {
  apply: ['Angewendet', 'bolt'], revert: ['Zurückgesetzt', 'undo'], detweak: ['Detweak', 'undo'], restore: ['Wiederherstellung', 'history'],
  game: ['Spiel-Boost', 'gamepad'], startup: ['Autostart', 'power'], action: ['Aktion', 'play'], clean: ['Reinigung', 'broom'],
  restorepoint: ['Wiederherstellungspunkt', 'shieldCheck'], remove: ['Apps entfernt', 'trash']
};
/** "66 Tweaks · 106 Werte": tweaks when the backend tells us, journal entries are single values. */
function countText(b) {
  const vals = plural(b.count || 0, 'Wert', 'Werte');
  return typeof b.tweakCount === 'number' && b.tweakCount ? plural(b.tweakCount, 'Tweak', 'Tweaks') + ' · ' + vals : vals;
}
const START = { Automatic: 'Automatisch', AutomaticDelayed: 'Automatisch (verzögert)', Manual: 'Manuell', Disabled: 'Deaktiviert' };
const PLANS = { '381b4222-f694-41f0-9685-ff5bb260df2e': 'Ausbalanciert', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'Höchstleistung', 'e9a42b02-d5df-448d-aa00-03f14749eb61': 'Ultimative Leistung', 'a1841308-3541-4fab-bc81-f71556f20b4a': 'Energiesparmodus' };

function regVal(v) {
  if (v && typeof v === 'object' && 'exists' in v) return v.exists === false ? 'nicht vorhanden' : fmtValue(v.value);
  return fmtValue(v);
}
function onOff(v) { return v === null || v === undefined ? 'nicht gesetzt' : v ? 'an' : 'aus'; }

/** Journal entry -> { what, target, from, to } as plain strings. */
export function describeEntry(e) {
  switch (e.op) {
    case 'reg': return { what: 'Registry', target: (e.path || '') + (e.name !== undefined ? '\\' + (e.name === '' ? '(Standard)' : e.name) : ''), from: regVal(e.before), to: regVal(e.after) };
    case 'regkey': return { what: 'Registry-Schlüssel', target: e.path, from: e.before ? 'vorhanden' : 'nicht vorhanden', to: e.after ? 'vorhanden' : 'nicht vorhanden' };
    case 'service': return { what: 'Dienst', target: e.name, from: START[e.before] || fmtValue(e.before), to: START[e.after] || fmtValue(e.after) };
    case 'task': return { what: 'Geplante Aufgabe', target: e.path, from: onOff(e.before), to: onOff(e.after) };
    case 'bcd': return { what: 'Boot-Einstellung', target: e.name, from: e.before === null || e.before === undefined ? 'nicht gesetzt' : String(e.before), to: e.after === null || e.after === undefined ? 'nicht gesetzt' : String(e.after) };
    case 'powerplan': return { what: 'Energieplan', target: 'Aktiver Plan', from: PLANS[String(e.before).toLowerCase()] || fmtValue(e.before), to: PLANS[String(e.after).toLowerCase()] || fmtValue(e.after) };
    case 'powersetting': return { what: 'Energieoption', target: (e.subgroup || '') + ' / ' + (e.setting || ''), from: e.before ? 'Netz ' + fmtValue(e.before.ac) + ', Akku ' + fmtValue(e.before.dc) : '–', to: e.after ? 'Netz ' + fmtValue(e.after.ac) + ', Akku ' + fmtValue(e.after.dc) : '–' };
    case 'feature': return { what: 'Windows-Feature', target: e.name, from: onOff(e.before), to: onOff(e.after) };
    case 'ps': return { what: 'Skript', target: e.tweakId || '', from: null, to: e.mode === 'revert' ? 'zurückgesetzt' : 'ausgeführt' };
    case 'cmd': return { what: 'Befehl', target: e.label || e.id || '', from: null, to: 'ausgeführt (nicht automatisch umkehrbar)' };
    case 'clean': return { what: 'Dateien gelöscht', target: e.label || e.id || e.path || '', from: null, to: 'gelöscht' };
    case 'appx': return { what: 'App entfernt', target: e.package, from: null, to: 'nicht wiederherstellbar' };
    case 'startup': return { what: 'Autostart', target: e.id || e.name || '', from: onOff(e.before), to: onOff(e.after) };
    case 'game': return { what: 'Spiel-Boost', target: e.path || '', from: null, to: e.after ? Object.entries(e.after).filter(([, v]) => v).map(([k]) => ({ priority: 'Priorität', gpu: 'Grafikkarte', fso: 'Vollbild' }[k] || k)).join(', ') || 'keine Boosts' : '' };
    default: return { what: e.op || 'Änderung', target: e.path || e.name || '', from: e.before !== undefined ? fmtValue(e.before) : null, to: e.after !== undefined ? fmtValue(e.after) : null };
  }
}

export default {
  id: 'backups', title: 'Sicherungen', icon: 'archive', desc: 'Jede Änderung ist gesichert – hier machst du sie rückgängig', keywords: 'backup journal wiederherstellen rückgängig undo',
  mount(el, ctx) {
    const list = h('div', { class: 'bk-list', 'data-testid': 'backup-list' });
    const rpBtn = button({ label: 'Wiederherstellungspunkt erstellen', icon: 'shieldCheck', variant: 'primary', onClick: async () => {
      const job = await ctx.runJob('restorepoint', { label: 'VELOX manuell' });
      if (job && job.status === 'done') load();
    } });
    const folderBtn = button({ label: 'Ordner öffnen', icon: 'folder', variant: 'ghost', onClick: async () => {
      try { await api.open('backups'); toast({ type: 'ok', title: 'Ordner geöffnet', text: 'Der Explorer zeigt dir die Sicherungsdateien.' }); }
      catch (e) { toast({ type: 'error', title: 'Konnte den Ordner nicht öffnen', text: e.message }); }
    } });
    append(el, 
      h('section', { class: 'card pad-24 bk-head' },
        h('div', { class: 'bk-head-icon' }, icon('shieldCheck', 26)),
        h('div', { class: 'bk-head-text' }, h('h2', { class: 'section-title', text: 'Dein Sicherheitsnetz' }), h('p', { class: 'section-desc', text: 'VELOX speichert vor jeder Änderung den alten Wert. Mit "Wiederherstellen" kommt genau dieser Stand zurück. Ein Windows-Wiederherstellungspunkt sichert zusätzlich das ganze System.' })),
        h('div', { class: 'bk-head-actions' }, folderBtn, rpBtn)),
      list);

    async function load(animate = true) {
      clear(list);
      for (let i = 0; i < 3; i++) list.appendChild(h('div', { class: 'card bk-item' }, h('div', { class: 'bk-main' }, h('div', { class: 'skel', style: { width: '40px', height: '40px', 'border-radius': '12px' } }), skeleton(2, 'grow'))));
      let backups;
      try { backups = (await api.backups()).backups || []; }
      catch (e) { clear(list).appendChild(h('div', { class: 'card pad-24' }, emptyState({ icon: 'alert', title: 'Sicherungen nicht lesbar', text: e.message }))); return; }
      backups.sort((a, b) => String(b.created).localeCompare(String(a.created)));
      ctx.cache.backups = backups;
      ctx.emit('backups');
      clear(list);
      if (!backups.length) {
        list.appendChild(h('div', { class: 'card pad-24' }, emptyState({ icon: 'archive', title: 'Noch keine Sicherungen', text: 'Sobald du etwas anwendest, legt VELOX hier automatisch eine Sicherung an. Du kannst jede davon mit einem Klick zurückholen.', action: button({ label: 'Zu den Presets', icon: 'stack', size: 'sm', variant: 'secondary', onClick: () => ctx.navigate('presets') }) })));
        return;
      }
      for (const b of backups) list.appendChild(item(b));
      if (animate) stagger(list);
    }

    function item(b) {
      const [kindLabel, kindIcon] = (Object.prototype.hasOwnProperty.call(KIND, b.kind) && KIND[b.kind]) || ['Änderung', 'archive'];
      const details = h('div', { class: 'bk-details', hidden: true });
      const expand = h('button', { class: 'icon-btn', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Details: ' + b.label, 'data-tip': 'Details' }, icon('chevronDown', 16));
      const restore = b.restorable === false ? null : button({ label: 'Wiederherstellen', icon: 'history', size: 'sm', variant: 'secondary', attrs: { 'data-testid': 'backup-restore' }, onClick: async () => {
        const ok = await confirmDialog({ title: '„' + b.label + '“ wiederherstellen?', icon: 'history', text: plural(b.count || 0, 'Wert wird', 'Werte werden') + ' auf den Stand vor dieser Sicherung zurückgesetzt. Auch das wird wieder gesichert.', confirmLabel: 'Wiederherstellen' });
        if (!ok) return;
        const job = await ctx.runJob('restore', { backupId: b.id });
        if (job && job.status === 'done') load(false);
      } });
      const card = h('article', { class: 'card bk-item', 'data-backup': b.id },
        h('div', { class: 'bk-main' },
          h('div', { class: 'bk-icon kind-' + b.kind }, icon(kindIcon, 18)),
          h('div', { class: 'bk-text' },
            h('div', { class: 'bk-label', text: b.label || kindLabel }),
            h('div', { class: 'bk-meta' }, h('span', { text: fmtDate(b.created) }), h('span', { class: 'dotsep', text: '·' }), h('span', { text: fmtRelative(b.created) }), h('span', { class: 'dotsep', text: '·' }), h('span', { text: countText(b) }))),
          h('div', { class: 'bk-badges' }, badge(kindLabel, 'neutral'), b.simulate ? badge('Testmodus', 'neutral', 'flask') : null, b.restorable === false ? badge('Nicht umkehrbar', 'neutral', 'lock') : null),
          h('div', { class: 'bk-actions' }, restore, expand)),
        details);
      expand.addEventListener('click', async () => {
        const open = details.hidden;
        details.hidden = !open;
        expand.setAttribute('aria-expanded', String(open));
        card.classList.toggle('open', open);
        if (open && !details.dataset.loaded) {
          details.dataset.loaded = '1';
          details.appendChild(skeleton(3));
          try {
            const full = await api.backup(b.id);
            clear(details);
            const entries = full.entries || [];
            if (!entries.length) { details.appendChild(h('p', { class: 'fine pad-16', text: 'Diese Sicherung enthält keine Einzelwerte.' })); return; }
            const ul = h('ul', { class: 'bk-entries' });
            for (const e of entries.slice(0, 200)) {
              const d = describeEntry(e);
              const tw = e.tweakId && ctx.byId.get(e.tweakId);
              ul.appendChild(h('li', { class: 'bk-entry' },
                h('div', { class: 'bk-entry-head' }, h('span', { class: 'bk-what', text: d.what }), tw ? h('span', { class: 'bk-tweak', text: tw.name }) : null),
                d.target ? h('div', { class: 'act-target mono', text: d.target }) : null,
                (d.from !== null || d.to !== null) ? h('div', { class: 'act-change' },
                  d.from !== null ? h('span', { class: 'val val-from' }, h('span', { class: 'val-label', text: 'Vorher' }), h('span', { class: 'mono', text: d.from })) : null,
                  d.from !== null ? icon('arrowRight', 14, 'act-arrow') : null,
                  h('span', { class: 'val val-to' }, h('span', { class: 'val-label', text: 'Nachher' }), h('span', { class: 'mono', text: d.to }))) : null));
            }
            if (entries.length > 200) ul.appendChild(h('li', { class: 'fine', text: '… und ' + (entries.length - 200) + ' weitere.' }));
            details.appendChild(ul);
          } catch (e) { clear(details).appendChild(h('p', { class: 'fine pad-16', text: 'Konnte nicht geladen werden: ' + e.message })); details.dataset.loaded = ''; }
        }
      });
      return card;
    }

    load();
    ctx.on('backups-reload', () => load(false));
  }
};
