// Sicherungen: journal list with expandable entries, restore, manual restore point, Windows
// restore points (baseline info, clean-up of the extra VELOX points).
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
    const listDesc = h('p', { class: 'section-desc' });
    const rpBtn = button({ label: 'Wiederherstellungspunkt erstellen', icon: 'shieldCheck', variant: 'primary', onClick: async () => {
      const job = await ctx.runJob('restorepoint', { label: 'Manuell' });
      if (job && job.status === 'done') { load(); rpLoad(true); }
    } });
    const folderBtn = button({ label: 'Ordner öffnen', icon: 'folder', variant: 'ghost', onClick: async () => {
      try { await api.open('backups'); toast({ type: 'ok', title: 'Ordner geöffnet', text: 'Der Explorer zeigt dir die Sicherungsdateien.' }); }
      catch (e) { toast({ type: 'error', title: 'Konnte den Ordner nicht öffnen', text: e.message }); }
    } });
    // ---------- Windows restore points: the baseline and the extra VELOX points
    const rpStatus = h('p', { class: 'section-desc rp-status', 'data-testid': 'rp-baseline' });
    const rpBody = h('div', { class: 'rp-body' });
    const rpCard = h('section', { class: 'card pad-24 rp-card', 'data-testid': 'rp-card' },
      h('div', { class: 'set-head' }, h('span', { class: 'set-icon' }, icon('history', 18)),
        h('div', {}, h('h2', { class: 'section-title', text: 'Windows-Wiederherstellungspunkte' }), rpStatus)),
      rpBody);

    function baselineText(r) {
      const b = (ctx.state && ctx.state.restorePointBaseline) || null;
      const mode = (ctx.settings && ctx.settings.restorePoints) || (ctx.settings && ctx.settings.autoRestorePoint === false ? 'off' : 'first');
      if (b && (b.status === 'created' || b.status === 'adopted')) {
        return 'Dein Ausgangspunkt: der erste VELOX-Wiederherstellungspunkt vom ' + fmtDate(b.created) + '. Damit kommst du über Windows zurück zum Stand vor VELOX.';
      }
      if (b && b.status === 'skipped') return 'Der erste Wiederherstellungspunkt wurde übersprungen. Mit „Wiederherstellungspunkt erstellen“ legst du jederzeit einen an.';
      if (b && (b.status === 'timeout' || b.status === 'failed')) return 'Der erste Wiederherstellungspunkt hat nicht geklappt. VELOX versucht es beim nächsten Start noch einmal – deine Änderungen sind trotzdem im Journal gesichert.';
      if (mode === 'off') return 'Automatische Wiederherstellungspunkte sind aus (Einstellungen). Rückgängig machen geht trotzdem über die Sicherungen unten.';
      const keep = r && r.keep;
      if (keep) return 'Noch kein Ausgangspunkt festgelegt – vor deiner nächsten Änderung übernimmt VELOX deinen ersten VELOX-Punkt vom ' + fmtDate(keep.created) + ' und legt keinen neuen an.';
      return 'Noch keiner – VELOX erstellt genau einen vor deiner ersten Änderung.';
    }

    function rpItem(p, keep) {
      const isKeep = keep && p.sequence === keep.sequence;
      const desc = String(p.description || 'Ohne Namen').replace(/^VELOX:\s*VELOX\s+/, 'VELOX: ');
      return h('li', { class: 'rp-item' + (isKeep ? ' is-keep' : '') + (p.velox ? '' : ' is-foreign') + (p.manual ? ' is-manual' : ''), 'data-rp-seq': String(p.sequence) },
        icon(p.velox ? 'shieldCheck' : 'windows', 15),
        h('span', { class: 'rp-desc', text: desc }),
        h('span', { class: 'rp-date', text: fmtDate(p.created) }),
        isKeep ? badge('Bleibt', 'ok') : p.manual ? badge('Von dir – bleibt', 'neutral') : p.velox ? badge('Überflüssig', 'neutral') : badge('Windows', 'neutral'));
    }

    function rpFill(r, loading) {
      rpStatus.textContent = baselineText(r);
      clear(rpBody);
      if (!r && loading) { rpBody.appendChild(h('p', { class: 'fine', text: 'Liste wird gelesen …' })); return; }
      if (!r) {
        rpBody.appendChild(button({ label: 'Wiederherstellungspunkte anzeigen', icon: 'search', size: 'sm', variant: 'secondary', onClick: () => rpLoad(true) }));
        return;
      }
      if (r.ok === false) { rpBody.appendChild(h('p', { class: 'fine', text: 'Konnte die Liste nicht lesen: ' + (r.message || 'unbekannter Fehler') })); return; }
      const items = (r.items || []).slice().sort((a, b) => String(b.created).localeCompare(String(a.created)));
      const own = items.filter(x => x.velox);
      const extra = typeof r.extra === 'number' ? r.extra : Math.max(0, own.length - 1);
      rpBody.appendChild(h('p', { class: 'fine', text: !items.length ? 'Auf diesem PC gibt es gerade keine Wiederherstellungspunkte.'
        : plural(own.length, 'Wiederherstellungspunkt stammt', 'Wiederherstellungspunkte stammen') + ' von VELOX' + (extra === 1 ? ', davon ist einer überflüssig' : extra > 1 ? ', davon sind ' + extra + ' überflüssig' : '') + '.' }));
      if (items.length) {
        const ul = h('ul', { class: 'rp-list', 'data-testid': 'rp-list' });
        for (const p of items.slice(0, 30)) ul.appendChild(rpItem(p, r.keep));
        rpBody.appendChild(ul);
      }
      const clean = button({ label: extra ? plural(extra, 'überflüssigen Punkt', 'überflüssige Punkte') + ' löschen' : 'Nichts zu löschen', icon: 'trash', size: 'sm', variant: 'secondary', disabled: !extra, attrs: { 'data-testid': 'rp-clean' }, onClick: async () => {
        const keepText = r.keep ? 'Der erste VELOX-Punkt vom ' + fmtDate(r.keep.created) + ' bleibt als Sicherheitsnetz. ' : '';
        const ok = await confirmDialog({ title: plural(extra, 'überflüssigen Wiederherstellungspunkt', 'überflüssige Wiederherstellungspunkte') + ' löschen?', icon: 'trash', danger: true,
          text: keepText + 'Punkte, die du selbst erstellt hast, und Punkte von Windows oder anderen Programmen werden nicht angefasst. Das gibt Speicherplatz frei. Gelöschte Punkte lassen sich aber nicht zurückholen.', confirmLabel: 'Löschen' });
        if (!ok) return;
        const job = await ctx.runJob('restorepoint-clean', {});
        if (job && job.status === 'done') rpLoad(true);
      } });
      rpBody.appendChild(h('div', { class: 'rp-actions' }, clean));
    }

    // the list is read by a quiet background job; while another job (the boot scan, an apply) runs,
    // it waits for that one instead of getting in its way
    let rpWait = null;
    async function rpLoad(force) {
      const c = ctx.cache.restorePoints;
      if (!force && c) { rpFill(c); return; }
      if (rpWait) { rpWait(); rpWait = null; }
      if (!el.isConnected && !first) return;
      if (ctx.busy || ctx.scanning) {
        rpFill(null, true);
        rpWait = ctx.on('busy', (b) => { if (!b && !ctx.scanning) { rpWait(); rpWait = null; if (el.isConnected) setTimeout(() => rpLoad(force), 50); } });
        return;
      }
      first = false;
      rpFill(null, true);
      const job = await ctx.runJob('restorepoint-list', {}, { overlay: false, quiet: true, quietBusy: true, background: true });
      if (job && job.status === 'done' && job.result) { ctx.cache.restorePoints = job.result; rpFill(job.result); }
      else rpFill(null);
    }
    let first = true;

    append(el, 
      h('section', { class: 'card pad-24 bk-head' },
        h('div', { class: 'bk-head-icon' }, icon('shieldCheck', 26)),
        h('div', { class: 'bk-head-text' }, h('h2', { class: 'section-title', text: 'Dein Sicherheitsnetz' }), h('p', { class: 'section-desc', text: 'VELOX speichert vor jeder Änderung den alten Wert. Mit „Wiederherstellen“ kommt genau dieser Stand zurück. Ein Windows-Wiederherstellungspunkt sichert zusätzlich das ganze System.' })),
        h('div', { class: 'bk-head-actions' }, folderBtn, rpBtn)),
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Deine Sicherungen' }), listDesc)),
      list,
      rpCard);

    async function load(animate = true) {
      listDesc.textContent = 'Neueste zuerst. Ein Klick auf „Wiederherstellen“ setzt alle Werte dieser Sicherung zurück.';
      clear(list);
      for (let i = 0; i < 3; i++) list.appendChild(h('div', { class: 'card bk-item' }, h('div', { class: 'bk-main' }, h('div', { class: 'skel', style: { width: '40px', height: '40px', 'border-radius': '12px' } }), skeleton(2, 'grow'))));
      let backups;
      try { backups = (await api.backups()).backups || []; }
      catch (e) { clear(list).appendChild(h('div', { class: 'card pad-24' }, emptyState({ icon: 'alert', title: 'Sicherungen nicht lesbar', text: e.message }))); return; }
      backups.sort((a, b) => String(b.created).localeCompare(String(a.created)));
      ctx.cache.backups = backups;
      ctx.emit('backups');
      listDesc.textContent = plural(backups.length, 'Sicherung', 'Sicherungen') + ', neueste zuerst. „Wiederherstellen“ setzt alle Werte dieser Sicherung zurück.';
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
            h('div', { class: 'bk-meta' }, h('div', { class: 'meta-line' }, h('span', { text: fmtDate(b.created) }), h('span', { text: fmtRelative(b.created) }), h('span', { text: countText(b) })))),
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
    rpLoad(false);
    ctx.on('backups-reload', () => load(false));
    ctx.on('state', () => { rpStatus.textContent = baselineText(ctx.cache.restorePoints); });
  }
};
