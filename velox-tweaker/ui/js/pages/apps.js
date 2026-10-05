// Apps: Autostart manager (startup-list / startup-set) and Bloatware removal (kind "remove" tweaks).
// Startup names and commands are untrusted strings from the PC: textContent only.
import { icon } from '../icons.js';
import { h, clear, button, toggle, checkbox, badge, segmented, emptyState, stagger, toast, plural, confirmDialog, avatar, skeleton, append } from '../ui.js';

/** "Nur für dich" / "Für alle Benutzer" instead of registry paths; the raw location stays in the details. */
function scopeLabel(it) {
  const id = String(it.id || ''); const loc = String(it.location || '');
  if (/^(hklm|common)/i.test(id) || /alle benutzer|^HKLM|HKEY_LOCAL_MACHINE/i.test(loc)) return 'Für alle Benutzer';
  return 'Nur für dich';
}

/**
 * Friendly names for well-known autostart entries. important: switching it off removes something
 * the user notices (sound control, the security icon, touchpad gestures) - VELOX asks first.
 */
const KNOWN = [
  { re: /securityhealth/i, name: 'Windows-Sicherheit', info: 'Zeigt das Schild-Symbol und Warnungen von Windows-Sicherheit (Virenschutz, Firewall) an.', important: true },
  { re: /rtkaud|rthdvcpl|rtkngui|realtek/i, name: 'Realtek-Audio', info: 'Steuert Sound, Lautsprecher und die Erkennung von Kopfhörern.', important: true },
  { re: /waves|maxxaudio/i, name: 'Waves-Audio', info: 'Klangverbesserung und Mikrofon-Einstellungen mancher Laptops.', important: true },
  { re: /syntp|synaptics|etdctrl|elantech|precisiontouch/i, name: 'Touchpad-Treiber', info: 'Gesten und Einstellungen des Touchpads.', important: true },
  { re: /iastor|rapid storage/i, name: 'Intel Rapid Storage', info: 'Überwacht Festplatten und RAID.', important: true },
  { re: /igfx|intel.*graphics/i, name: 'Intel-Grafik', info: 'Hotkeys und Symbol der Intel-Grafik. Aus schadet meist nicht.' },
  { re: /onedrive/i, name: 'OneDrive', info: 'Synchronisiert deine Dateien mit der Cloud. Aus = schnellerer Start; synchronisiert wird dann erst, wenn du OneDrive öffnest.' },
  { re: /teams/i, name: 'Microsoft Teams', info: 'Chat und Videoanrufe. Startet sonst einfach, wenn du es öffnest.' },
  { re: /msedge|edgeautolaunch/i, name: 'Microsoft Edge (Vorstart)', info: 'Lädt Edge schon beim Start vor. Aus = schnellerer Start.' },
  { re: /discord/i, name: 'Discord', info: 'Chat für Gamer. Startet sonst, wenn du es öffnest.' },
  { re: /steam/i, name: 'Steam', info: 'Spiele-Launcher. Startet sonst, wenn du ein Spiel öffnest.' },
  { re: /epicgames/i, name: 'Epic Games Launcher', info: 'Spiele-Launcher. Startet sonst, wenn du ein Spiel öffnest.' },
  { re: /spotify/i, name: 'Spotify', info: 'Musik. Startet sonst, wenn du es öffnest.' },
  { re: /lghub|logitech/i, name: 'Logitech G HUB', info: 'Profile für Maus und Tastatur. Aus = Profile erst nach dem Öffnen aktiv.' },
  { re: /razer|synapse/i, name: 'Razer Synapse', info: 'Profile und Beleuchtung für Razer-Geräte.' },
  { re: /nvidia|nvbackend|nvcontainer/i, name: 'NVIDIA-Hilfsprogramm', info: 'Overlay und Updates der NVIDIA-App. Der Grafiktreiber läuft auch ohne.' },
  { re: /radeon|amd ?software/i, name: 'AMD Software', info: 'Overlay und Updates von AMD. Der Grafiktreiber läuft auch ohne.' }
];
function knownOf(it) {
  const hay = String(it.name || '') + ' ' + String(it.command || '');
  return KNOWN.find(k => k.re.test(hay)) || null;
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
          const known = knownOf(it);
          const friendly = known ? known.name : it.name;
          const sw = toggle({ checked: !!it.enabled, label: 'Autostart: ' + friendly, onChange: async (next) => {
            if (!next && known && known.important) {
              const ok = await confirmDialog({ title: friendly + ' wirklich nicht mehr starten?', icon: 'alert', tone: 'warn', text: known.info + ' Ohne Autostart fehlt das, bis du es von Hand startest. Empfohlen: anlassen.', confirmLabel: 'Trotzdem ausschalten' });
              if (!ok) return false;
            }
            sw.setAttribute('aria-busy', 'true'); sw.disabled = true;
            const job = await ctx.runJob('startup-set', { id: it.id, enabled: next }, { overlay: false, quiet: true });
            sw.removeAttribute('aria-busy'); sw.disabled = false;
            if (job && job.status === 'done') {
              const ni = (job.result && job.result.item) || {};
              it.enabled = ni.enabled !== undefined ? !!ni.enabled : next;
              toast({ type: 'ok', title: friendly + (it.enabled ? ' startet wieder mit Windows' : ' startet nicht mehr mit Windows'), text: 'Gilt ab dem nächsten Windows-Start. Du kannst es jederzeit wieder umschalten.' });
              row.classList.toggle('is-off', !it.enabled);
              const n = items.filter(i => i.enabled).length;
              info.textContent = plural(items.length, 'Eintrag', 'Einträge') + ', davon ' + n + ' aktiv. Weniger Autostart = schnellerer Start und weniger Hintergrundlast.';
              return true;
            }
            return false;
          } });
          const details = h('div', { class: 'su-details', hidden: true },
            h('dl', { class: 'pro-list' },
              h('dt', { text: 'Eintrag' }), h('dd', { class: 'mono', text: it.name || '' }),
              h('dt', { text: 'Befehl' }), h('dd', { class: 'mono', text: it.command || '–' }),
              h('dt', { text: 'Ort' }), h('dd', { text: it.location || '–' })));
          const expand = h('button', { class: 'icon-btn su-expand', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Details zu ' + friendly, 'data-tip': 'Details' }, icon('chevronDown', 16));
          expand.addEventListener('click', () => { const open = details.hidden; details.hidden = !open; expand.setAttribute('aria-expanded', String(open)); row.classList.toggle('open', open); });
          const row = h('div', { class: ['su-row', !it.enabled && 'is-off', known && known.important && 'is-important'], 'data-id': it.id },
            h('div', { class: 'su-main' },
              avatar(friendly, 36),
              h('div', { class: 'su-text' },
                h('div', { class: 'su-name' }, h('span', { text: friendly }), known && known.important ? badge('Wichtig – besser anlassen', 'warn', 'shieldCheck') : null),
                h('div', { class: 'su-info', text: known ? known.info : (it.command ? 'Startet automatisch mit Windows. Details zeigen den genauen Befehl.' : 'Startet automatisch mit Windows.') })),
              badge(scopeLabel(it), 'neutral', 'user'),
              expand, sw),
            details);
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
        // quiet: the generic apply toast would promise an undo that does not exist for removed apps
        const job = await ctx.runJob('apply', { ids: Array.from(sel), label: 'Apps entfernt (' + sel.size + ')' }, { title: 'Apps werden entfernt', quiet: true });
        if (job && job.status === 'done') {
          const res = (job.result && job.result.results) || [];
          const ok = res.filter(r => r.ok).length; const fail = res.length - ok;
          const firstErr = res.find(r => !r.ok);
          toast(fail
            ? { type: 'warn', title: plural(ok, 'App entfernt', 'Apps entfernt') + ', ' + fail + ' nicht', text: firstErr ? ((ctx.byId.get(firstErr.id) || {}).name || firstErr.id) + ': ' + (firstErr.error || 'Fehler') : '' }
            : { type: 'ok', title: plural(ok, 'App entfernt', 'Apps entfernt'), text: 'Neu installieren geht jederzeit über den Microsoft Store.' });
          sel.clear(); fill();
        }
      }
      fill();
      stagger(listEl);
      ctx.on('statuses', () => { if (tab === 'bloat' && listEl.isConnected) fill(); });
    }

    render();
  }
};
