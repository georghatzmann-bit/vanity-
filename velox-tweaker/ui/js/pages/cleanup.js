// Reinigung: scan (clean-scan) -> grouped list with sizes -> presets (Schnell / Gründlich / Alles) ->
// "Bereinigen" with live progress per item (run-action, job.live), result "X GB freigegeben in Y s".
// Repair tools below (DISM, SFC, CHKDSK, network ...) with the duration note and live percent on the
// card. Both run WITHOUT the modal overlay: the PC and the rest of VELOX stay usable, and the page
// re-attaches to a running job when the user comes back.
import { icon } from '../icons.js';
import { h, clear, button, checkbox, countUp, fmtBytes, fmtNumber, emptyState, stagger, toast, badge, needsBadge, confirmDialog, riskBadge, append, fmtRelative, fmtDate, segmented, setBar, spinner, plural } from '../ui.js';
import { api, pollJob, request } from '../api.js';

const PRESETS = [
  { value: 'quick', label: 'Schnell', icon: 'zap', tiers: ['quick'], hint: 'Nur sichere Caches, Temp-Dateien und alte Berichte. Du merkst danach nichts – außer mehr freiem Platz.' },
  { value: 'deep', label: 'Gründlich', icon: 'layers', tiers: ['quick', 'deep'], hint: 'Dazu Shader-Caches, Update-Reste (DISM) und Protokolle. Die ersten Spielstarts dauern danach kurz länger.' },
  { value: 'all', label: 'Alles', icon: 'flame', tiers: ['quick', 'deep', 'optin'], hint: 'Dazu Papierkorb, Windows.old, MEMORY.DMP und Temp anderer Konten. Das geht nicht rückgängig – du bestätigst es vorher.' }
];
const TIER_LABEL = { quick: 'Schnell', deep: 'Gründlich', optin: 'Nur mit Bestätigung' };

/** "0,4 s", "27 s", "3:05 min" */
function fmtDur(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 10) return fmtNumber(Math.max(0.1, s), 1) + ' s';
  if (s < 60) return Math.round(s) + ' s';
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.round(s - m * 60)).padStart(2, '0') + ' min';
}
const fmtClock = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');

export default {
  id: 'cleanup', title: 'Reinigung', icon: 'broom', desc: 'Speicher freiräumen und Windows reparieren', keywords: 'aufräumen temp cache speicher browser papierkorb windows.old reparatur sfc dism',
  mount(el, ctx) {
    // the cleanup category first (catalog order), then tiered items of other categories (FiveM ...)
    const tiered = ctx.tweaks.filter(t => t.kind === 'action' && t.tier && t.category !== 'repair');
    const items = [...tiered.filter(t => t.category === 'cleanup'), ...tiered.filter(t => t.category !== 'cleanup')];
    const repairs = ctx.tweaks.filter(t => t.category === 'repair' && t.kind === 'action');
    const byId = new Map(items.map(t => [t.id, t]));
    const cache = ctx.cache.clean || null;
    let sizes = cache ? cache.sizes : null;
    let preset = ctx.cache.cleanPreset || 'quick';
    const sel = new Set();
    const rowState = new Map();      // id -> { status: 'wait'|'run'|'ok'|'partial'|'skipped'|'failed', freed, message, progress }
    let running = null;              // { jobId, kind: 'clean'|'repair', ids, started }
    const rows = new Map();          // id -> { row, cb, size, status }

    // ---------------------------------------------------------------- hero
    const totalEl = h('span', { class: 'cl-total-num', 'data-testid': 'clean-total', text: '0 B' });
    const totalSub = h('span', { class: 'cl-total-sub' });
    const presetHint = h('p', { class: 'cl-preset-hint' });
    const seg = segmented({ label: 'Umfang der Reinigung', value: preset, cls: 'cl-presets', options: PRESETS.map(p => ({ value: p.value, label: p.label, icon: p.icon })), onChange: (v) => setPreset(v) });
    seg.setAttribute('data-testid', 'clean-presets');
    const runBtn = button({ label: 'Bereinigen', icon: 'broom', variant: 'primary', cls: 'btn-brand btn-lg', onClick: () => run(), attrs: { 'data-testid': 'clean-run' } });
    const rescan = button({ label: 'Neu scannen', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => scan(true), attrs: { 'data-testid': 'clean-rescan' } });
    // live area (while cleaning) and the result line
    const liveBar = h('div', { class: 'pbar-fill' });
    const livePbar = h('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Fortschritt der Reinigung' }, liveBar);
    const liveText = h('span', { class: 'cl-live-text', 'data-testid': 'clean-live' });
    const liveFreed = h('span', { class: 'cl-live-freed', text: '0 B' });
    const cancelBtn = button({ label: 'Abbrechen', variant: 'ghost', size: 'sm', onClick: () => cancel(), attrs: { 'data-testid': 'clean-cancel' } });
    const skipBtn = button({ label: 'Überspringen', icon: 'arrowRight', variant: 'secondary', size: 'sm', onClick: () => skip(), attrs: { 'data-testid': 'clean-skip', title: 'Nur diesen Bereich auslassen – der Rest läuft weiter' } });
    skipBtn.hidden = true;
    const live = h('div', { class: 'cl-live', hidden: true },
      h('div', { class: 'cl-live-row' }, spinner(14), liveText, h('span', { class: 'grow' }), h('span', { class: 'cl-live-label', text: 'frei:' }), liveFreed),
      livePbar,
      h('div', { class: 'cl-live-actions' }, skipBtn, cancelBtn));
    const result = h('div', { class: 'cl-result', hidden: true, 'data-testid': 'clean-result' });

    const hero = h('section', { class: 'card cl-hero' },
      h('div', { class: 'cl-hero-main' },
        h('div', { class: 'cl-total' }, h('span', { class: 'eyebrow', text: 'Frei machbar' }), totalEl, totalSub),
        h('div', { class: 'cl-hero-side' }, seg, presetHint)),
      h('div', { class: 'cl-hero-foot' }, runBtn, rescan, h('span', { class: 'grow' }), h('span', { class: 'cl-foot-note fine', text: 'Gesperrte Dateien werden übersprungen. Nichts außerhalb der aufgelisteten Ordner wird angefasst.' })),
      live, result);

    const appsNote = h('div', { class: 'cl-apps', hidden: true, role: 'status', 'data-testid': 'clean-apps' });
    const groupsBox = h('div', { class: 'cl-groups', 'data-testid': 'clean-list' });
    const missingBox = h('details', { class: 'cl-missing', hidden: true });

    // ---------------------------------------------------------------- selection
    const tiersOf = (p) => (PRESETS.find(x => x.value === p) || PRESETS[0]).tiers;
    const isFound = (t) => !sizes || !sizes[t.id] || sizes[t.id].found !== false;
    const usable = (t) => ctx.applicable(t) && isFound(t);
    function setPreset(p, quiet) {
      preset = p;
      ctx.cache.cleanPreset = p;
      sel.clear();
      for (const t of items) if (usable(t) && tiersOf(p).includes(t.tier)) sel.add(t.id);
      seg.select(p);
      const meta = PRESETS.find(x => x.value === p);
      presetHint.textContent = meta ? meta.hint : 'Eigene Auswahl.';
      if (!quiet) syncChecks();
      updTotal();
    }
    function markCustom() {
      // the boxes no longer match a preset: no segment is highlighted, the hint says so
      const match = PRESETS.find(p => { const want = items.filter(t => usable(t) && p.tiers.includes(t.tier)).map(t => t.id); return want.length === sel.size && want.every(id => sel.has(id)); });
      preset = match ? match.value : 'custom';
      seg.select(match ? match.value : '');
      presetHint.textContent = match ? match.hint : 'Eigene Auswahl – du hast einzelne Bereiche an- oder abgewählt.';
    }
    function total() {
      let b = 0; let f = 0; let unknown = 0; let partial = false;
      for (const id of sel) {
        const s = sizes && sizes[id];
        if (!s || s.measurable === false) { unknown++; continue; }
        b += s.bytes || 0; f += s.files || 0; if (s.partial) partial = true;
      }
      return { b, f, unknown, partial };
    }
    function updTotal() {
      const { b, f, unknown, partial } = total();
      countUp(totalEl, b, { format: (v) => (partial ? '≥ ' : '') + fmtBytes(v), duration: 600 });
      let all = 0;
      if (sizes) for (const t of items) { const s = sizes[t.id]; if (s && usable(t)) all += s.bytes || 0; }
      totalSub.textContent = !sizes ? 'Wird gemessen …'
        : plural(sel.size, 'Bereich', 'Bereiche') + ' ausgewählt · ' + plural(f, 'Datei', 'Dateien') + (unknown ? ' · ' + unknown + ' ohne Vorab-Größe' : '') + ' · insgesamt ' + fmtBytes(all) + ' gefunden';
      runBtn.disabled = !!running || !sel.size || !sizes || (b === 0 && !unknown);
      runBtn.title = runBtn.disabled && sizes && sel.size && !running ? 'Gerade gibt es hier nichts zu löschen.' : '';
      rescan.disabled = !!running;
      seg.classList.toggle('is-disabled', !!running);
      for (const b2 of seg.querySelectorAll('.seg-btn')) b2.disabled = !!running;
    }
    function syncChecks() {
      for (const [id, r] of rows) { r.cb.input.checked = sel.has(id); r.cb.input.disabled = !!running || !usable(byId.get(id)); }
      for (const g of groupsBox.querySelectorAll('.cl-group')) syncGroup(g);
    }
    function syncGroup(g) {
      const ids = (g._ids || []).filter(id => usable(byId.get(id)));
      const on = ids.filter(id => sel.has(id)).length;
      const gcb = g._cb.input;
      gcb.checked = ids.length > 0 && on === ids.length;
      gcb.indeterminate = on > 0 && on < ids.length;
      gcb.disabled = !!running || !ids.length;
      let b = 0; for (const id of ids) { const s = sizes && sizes[id]; if (s && s.measurable !== false) b += s.bytes || 0; }
      g._sum.textContent = sizes ? fmtBytes(b) : '';
    }

    // ---------------------------------------------------------------- list
    function sizeCell(t) {
      const s = sizes && sizes[t.id];
      const box = h('div', { class: 'cl-size' });
      if (!sizes) box.appendChild(h('div', { class: 'skel', style: { width: '64px', height: '14px' } }));
      else if (!s) box.appendChild(h('span', { class: 'cl-files', text: '–' }));
      else if (s.measurable === false) box.appendChild(h('span', { class: 'cl-files', text: 'Größe erst beim Bereinigen' }));
      else {
        const n = h('span', { class: 'cl-bytes', text: '0 B' });
        append(box, n, h('span', { class: 'cl-files', text: plural(s.files || 0, 'Datei', 'Dateien') }));
        countUp(n, s.bytes || 0, { format: (v) => (s.partial ? '≥ ' : '') + fmtBytes(v), from: 0, duration: 800 });
      }
      return box;
    }
    function rowFor(t) {
      const s = sizes && sizes[t.id];
      const cb = checkbox({ checked: sel.has(t.id), disabled: !!running, onChange: (v) => { if (v) sel.add(t.id); else sel.delete(t.id); markCustom(); updTotal(); syncGroup(row.closest('.cl-group')); } });
      cb.input.setAttribute('aria-label', t.name);
      const badges = h('span', { class: 'cl-badges' },
        t.risk !== 'safe' ? riskBadge(t.risk) : null,
        t.tier === 'optin' ? h('span', { class: 'badge badge-accent cl-optin', title: 'Nur mit „Alles“ und deiner Bestätigung' }, icon('lock', 12), h('span', { text: 'Bestätigung' })) : null,
        t.duration ? h('span', { class: 'badge badge-info', title: 'Ungefähre Dauer' }, icon('clock', 12), h('span', { text: t.duration })) : null,
        s && s.running && s.running.length ? h('span', { class: 'badge badge-warn cl-running', title: 'Schließe das Programm, sonst wird dieser Bereich übersprungen.' }, icon('warn', 12), h('span', { text: s.running.join(', ') + ' läuft' })) : null);
      const status = h('div', { class: 'cl-status', hidden: true });
      const size = sizeCell(t);
      const row = h('div', { class: ['cl-row', 'tier-' + t.tier], 'data-id': t.id },
        cb,
        h('div', { class: 'cl-text' },
          h('div', { class: 'cl-name' }, h('span', { text: t.name }), badges),
          h('div', { class: 'cl-desc', text: t.desc }),
          t.warning ? h('div', { class: 'cl-warn' }, icon('alert', 13), h('span', { text: t.warning })) : null,
          status),
        size);
      rows.set(t.id, { row, cb, size, status });
      paintRow(t.id);
      return row;
    }
    function fill(animate) {
      rows.clear();
      clear(groupsBox);
      if (!items.length) { groupsBox.appendChild(emptyState({ icon: 'broom', title: 'Keine Reinigungs-Bereiche', text: 'Der Katalog enthält noch keine Reinigung.' })); return; }
      const groups = new Map();
      const missing = [];
      for (const t of items) {
        if (!usable(t)) { missing.push(t); continue; }
        const g = t.group || 'Weitere';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(t);
      }
      for (const [name, list] of groups) {
        const gcb = checkbox({ onChange: (v) => { for (const t of list) { if (!usable(t)) continue; if (v) sel.add(t.id); else sel.delete(t.id); } markCustom(); syncChecks(); updTotal(); } });
        gcb.input.setAttribute('aria-label', 'Alle in „' + name + '“');
        const sum = h('span', { class: 'cl-group-sum' });
        const body = h('div', { class: 'cl-group-rows' }, list.map(rowFor));
        const sec = h('section', { class: 'card cl-group', 'data-group': name },
          h('header', { class: 'cl-group-head' }, gcb, h('h3', { class: 'cl-group-name', text: name }), h('span', { class: 'cl-group-count', text: String(list.length) }), h('span', { class: 'grow' }), sum),
          body);
        sec._ids = list.map(t => t.id); sec._cb = gcb; sec._sum = sum;
        groupsBox.appendChild(sec);
        syncGroup(sec);
      }
      clear(missingBox);
      missingBox.hidden = !missing.length || !sizes;
      if (missing.length) {
        append(missingBox, h('summary', {}, icon('chevronRight', 14), h('span', { text: 'Auf diesem PC nicht gefunden (' + missing.length + ')' })),
          h('p', { class: 'fine', text: 'Diese Programme oder Ordner gibt es hier nicht – oder sie passen nicht zu deiner Hardware. Nichts zu tun.' }),
          h('ul', { class: 'cl-missing-list' }, missing.map(t => h('li', { text: t.name }))));
      }
      if (animate) stagger(groupsBox);
      updApps();
      updTotal();
    }
    function updApps() {
      const names = new Set();
      if (sizes) for (const id of sel) { const s = sizes[id]; for (const n of (s && s.running) || []) names.add(n); }
      const list = Array.from(names);
      appsNote.hidden = !list.length;
      if (!list.length) return;
      clear(appsNote).appendChild(icon('warn', 16));
      append(appsNote, h('span', { text: (list.length === 1 ? list[0] + ' läuft' : list.slice(0, -1).join(', ') + ' und ' + list[list.length - 1] + ' laufen') + ' gerade. Schließe ' + (list.length === 1 ? 'es' : 'sie') + ' ganz (auch im Infobereich) für die volle Wirkung – sonst wird der Cache übersprungen.' }),
        button({ label: 'Neu scannen', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => scan(true) }));
    }

    // ---------------------------------------------------------------- per-row live state
    function paintRow(id) {
      const r = rows.get(id);
      const st = rowState.get(id);
      if (!r) return;
      r.row.classList.remove('is-wait', 'is-run', 'is-ok', 'is-partial', 'is-skipped', 'is-failed');
      if (!st) { r.status.hidden = true; return; }
      r.row.classList.add('is-' + st.status);
      r.status.hidden = false;
      clear(r.status);
      if (st.status === 'wait') append(r.status, icon('clock', 13), h('span', { text: 'Wartet …' }));
      else if (st.status === 'run') {
        const fill2 = h('div', { class: 'pbar-fill' });
        const pb = h('div', { class: 'pbar cl-row-bar' }, fill2);
        append(r.status, spinner(12), h('span', { text: st.text || 'Wird bereinigt …' }), pb);
        if (st.progress >= 0) setBar(fill2, st.progress); else pb.classList.add('is-indeterminate');
      } else {
        const ic = st.status === 'ok' ? 'checkCircle' : st.status === 'failed' ? 'xCircle' : 'warn';
        append(r.status, icon(ic, 13), h('span', { class: 'cl-status-msg', text: st.message || (st.status === 'ok' ? 'Erledigt' : '') }));
      }
    }
    function applyLive(job) {
      const L = job.live;
      if (!L) return;
      for (const d of L.done || []) {
        const prev = rowState.get(d.id);
        if (prev && !['wait', 'run'].includes(prev.status)) continue;
        rowState.set(d.id, { status: d.ok === false && !d.skipped ? 'failed' : (d.status || (d.ok ? 'ok' : 'failed')), freed: d.freedBytes || 0, message: d.message || '' });
        paintRow(d.id);
      }
      if (L.id) {
        const s = sizes && sizes[L.id];
        let p = typeof L.progress === 'number' && L.progress >= 0 ? L.progress : -1;
        if (p < 0 && s && s.files && L.files) p = Math.min(1, L.files / s.files);
        const parts = [];
        if (L.percent >= 0) parts.push(fmtNumber(L.percent, 1) + ' %');
        else if (L.files) parts.push(plural(L.files, 'Datei', 'Dateien') + ' gelöscht');
        if (L.freed) parts.push(fmtBytes(L.freed) + ' frei');
        if (L.elapsedSec >= 3) parts.push(fmtClock(L.elapsedSec));
        rowState.set(L.id, { status: 'run', progress: p, text: (parts.join(' · ') || 'Wird bereinigt …') + (L.note ? ' – wartet auf Windows' : '') });
        paintRow(L.id);
      }
    }

    // ---------------------------------------------------------------- scan
    async function scan(manual) {
      if (running) return;
      sizes = null; fill(false);
      // background: read only - a job the user or the boot scan starts meanwhile waits for it instead of being refused
      const job = await ctx.runJob('clean-scan', {}, { overlay: false, quiet: true, quietBusy: !manual, background: true });
      if (!el.isConnected) return;
      if (job && job.status === 'done') {
        sizes = {};
        for (const it of (job.result && job.result.items) || []) sizes[it.id] = { bytes: it.bytes || 0, files: it.files || 0, found: it.found !== false, partial: !!it.partial, measurable: it.measurable !== false, running: it.running || [] };
        ctx.cache.clean = { sizes, at: Date.now() };
      } else if (!job && ctx.busy) {
        ctx.whenIdle(() => { if (el.isConnected) scan(false); });
        return;
      } else sizes = {};
      const keepCustom = preset === 'custom' && sel.size;
      if (!keepCustom) setPreset(preset === 'custom' ? 'quick' : preset, true);
      fill(true);
      if (manual && job && job.status === 'done') toast({ type: 'info', title: 'Neu gemessen', text: fmtBytes((job.result && job.result.totalBytes) || 0) + ' gefunden.' });
    }

    // ---------------------------------------------------------------- run
    async function run() {
      // the long Windows tools (DISM, Datenträgerbereinigung - they carry a duration) run last: all
      // quick items are done first, and "Überspringen" on a long tool loses nothing else
      const sel2 = items.filter(t => sel.has(t.id));
      const ids = [...sel2.filter(t => !t.duration), ...sel2.filter(t => t.duration)].map(t => t.id);
      if (!ids.length) return;
      const optin = ids.map(id => byId.get(id)).filter(t => t.tier === 'optin');
      const risky = ids.map(id => byId.get(id)).filter(t => t.tier !== 'optin' && t.risk !== 'safe' && t.warning);
      if (optin.length || risky.length) {
        const list = (arr) => h('ul', { class: 'cl-confirm-list' }, arr.map(t => h('li', {}, h('strong', { text: t.name }), h('span', { class: 'muted', text: ' – ' + t.warning }))));
        const body = h('div', { class: 'stack-12' },
          optin.length ? list(optin) : null,
          risky.length ? h('div', { class: 'stack-8' }, optin.length ? h('p', { class: 'cl-confirm-sub', text: 'Gut zu wissen (lässt sich neu aufbauen):' }) : null, list(risky)) : null);
        const ok = await confirmDialog({
          title: optin.length ? 'Auch das endgültig löschen?' : 'Wirklich löschen?',
          text: optin.length ? 'Diese Bereiche lassen sich danach nicht zurückholen:' : 'Kurz zur Info:',
          body, confirmLabel: 'Bereinigen', danger: optin.length > 0,
          checkbox: optin.length ? 'Ich weiß, dass das nicht rückgängig geht.' : null
        });
        if (!ok) return;
      }
      const expect = {};
      for (const id of ids) { const s = sizes && sizes[id]; if (s && s.files) expect[id] = s.files; }
      rowState.clear();
      for (const id of ids) rowState.set(id, { status: 'wait' });
      for (const id of ids) paintRow(id);
      result.hidden = true;
      await follow('clean', ids, { ids, confirmOptIn: optin.length > 0, expect });
    }

    /** Starts (or, with jobId, re-attaches to) a run-action job and keeps the page in sync. */
    async function follow(kind, ids, params, jobId) {
      running = { kind, ids, jobId: jobId || null, started: Date.now() };
      ctx.cache.cleanRun = running;
      setRunning(true);
      const onUpdate = (j) => {
        if (j.id && !running.jobId) running.jobId = j.id;
        if (!el.isConnected) return;
        if (kind === 'clean') updLive(j); else updRepair(ids[0], j);
      };
      let job = null;
      if (jobId) {
        try { job = await pollJob(jobId, onUpdate); } catch { job = null; }
      } else {
        job = await ctx.runJob('run-action', params, { overlay: false, quiet: true, quietError: true, quietCancel: true, onUpdate });
      }
      if (ctx.cache.cleanRun === running) ctx.cache.cleanRun = null;
      const mine = running;
      running = null;
      if (!el.isConnected) return;
      setRunning(false);
      if (kind === 'clean') finishClean(job, mine); else finishRepair(ids[0], job);
    }
    function setRunning(on) {
      live.hidden = !on || (running && running.kind !== 'clean');
      hero.classList.toggle('is-running', !!on && running && running.kind === 'clean');
      cancelBtn.disabled = false;
      const lbl = cancelBtn.querySelector('.btn-label'); if (lbl) lbl.textContent = 'Abbrechen';
      if (on && running.kind === 'clean') { liveText.textContent = 'Wird vorbereitet …'; liveFreed.textContent = '0 B'; setBar(liveBar, 0.02); }
      for (const b of repairGrid.querySelectorAll('.repair-run')) b.disabled = !!on;
      syncChecks();
      updTotal();
    }
    function updLive(j) {
      applyLive(j);
      const L = j.live || {};
      const t = L.id && (byId.get(L.id) || ctx.byId.get(L.id));
      liveText.textContent = t ? (L.total > 1 ? L.index + '/' + L.total + ' · ' : '') + t.name : (j.step || 'Wird vorbereitet …');
      let freed = 0;
      for (const d of L.done || []) freed += Number(d.freedBytes) || 0;
      freed += Number(L.freed) || 0;
      liveFreed.textContent = fmtBytes(freed);
      setBar(liveBar, j.progress || 0.02);
      livePbar.setAttribute('aria-valuenow', String(Math.round((j.progress || 0) * 100)));
      skipBtn.hidden = !j.skippable;
      skipBtn.disabled = false;
    }
    function finishClean(job, mine) {
      updTotal();
      if (!job) { rowState.clear(); for (const id of rows.keys()) paintRow(id); return; }
      if (job.live) applyLive(Object.assign({}, job, { live: Object.assign({}, job.live, { id: '' }) }));
      // cancelled: no result object, but every item that finished is in live.done
      const res = (job.result && job.result.results) || (job.live && job.live.done) || [];
      for (const r of res) { rowState.set(r.id, { status: r.ok === false && !r.skipped ? 'failed' : (r.status || 'ok'), freed: r.freedBytes || 0, message: r.message || '' }); paintRow(r.id); }
      // rows that never started (cancelled): back to normal
      for (const [id, st] of rowState) if (st.status === 'wait' || st.status === 'run') { rowState.delete(id); paintRow(id); }
      const bytes = res.reduce((s, r) => s + (Number(r.freedBytes) || 0), 0);
      const skipped = res.filter(r => r.skipped);
      const failed = res.filter(r => r.ok === false && !r.skipped);
      const apps = new Set(); for (const r of res) for (const a of r.running || []) apps.add(a);
      const locked = res.reduce((s, r) => s + (Number(r.locked) || 0), 0);
      const dur = job.result && typeof job.result.durationMs === 'number' ? job.result.durationMs : (job.durationMs || 0);
      const title = job.status === 'cancelled' ? 'Abgebrochen – ' + fmtBytes(bytes) + ' freigegeben' : job.status === 'error' ? 'Reinigung fehlgeschlagen' : fmtBytes(bytes) + ' freigegeben in ' + fmtDur(dur);
      const notes = [];
      if (apps.size) notes.push('Übersprungen, weil ' + Array.from(apps).join(', ') + (apps.size === 1 ? ' läuft' : ' laufen') + ' – schließen und noch einmal bereinigen.');
      if (locked) notes.push(plural(locked, 'Datei war', 'Dateien waren') + ' gerade in Benutzung und ' + (locked === 1 ? 'bleibt' : 'bleiben') + '.');
      if (failed.length) notes.push(plural(failed.length, 'Bereich', 'Bereiche') + ' mit Fehler – Details in der Liste.');
      if (job.status === 'error' && job.error) notes.push(job.error);
      clear(result);
      append(result,
        h('div', { class: 'cl-result-icon' }, icon(job.status === 'done' && !failed.length ? 'checkCircle' : 'warn', 22)),
        h('div', { class: 'cl-result-text' },
          h('div', { class: 'cl-result-title', 'data-testid': 'clean-freed', text: title }),
          notes.length ? h('div', { class: 'cl-result-notes', text: notes.join(' ') }) : null),
        skipped.length ? badge(plural(skipped.length, 'übersprungen', 'übersprungen'), 'warn', 'arrowRight') : null);
      result.hidden = false;
      result.classList.toggle('is-warn', job.status !== 'done' || failed.length > 0);
      if (job.status === 'done') toast({ type: failed.length || apps.size ? 'warn' : 'ok', title: fmtBytes(bytes) + ' freigegeben in ' + fmtDur(dur), text: notes[0] || 'Sauber!' });
      ctx.cache.clean = null;
      void mine;
      setTimeout(() => { if (el.isConnected && !running) scan(false); }, 1200);
    }
    async function cancel() {
      if (!running || !running.jobId) return;
      cancelBtn.disabled = true;
      const lbl = cancelBtn.querySelector('.btn-label'); if (lbl) lbl.textContent = 'Wird abgebrochen …';
      try { await api.cancelJob(running.jobId); } catch { /* the poll shows the outcome */ }
    }
    async function skip() {
      if (!running || !running.jobId) return;
      skipBtn.disabled = true;
      try { await request('POST', '/api/jobs/' + encodeURIComponent(running.jobId) + '/skip'); } catch { /* ignore */ }
    }

    // ---------------------------------------------------------------- repair
    const repairGrid = h('div', { class: 'repair-grid' });
    ctx.cache.repairLast = ctx.cache.repairLast || {};
    const cards = new Map();
    const lastLine = (t) => {
      const l = ctx.cache.repairLast[t.id];
      if (!l) return h('p', { class: 'repair-last fine', text: 'Noch nicht ausgeführt.' });
      return h('p', { class: 'repair-last' + (l.ok ? '' : ' is-warn'), title: fmtDate(l.at) }, icon(l.ok ? 'checkCircle' : 'warn', 13), h('span', { text: 'Zuletzt ' + fmtRelative(l.at) + ': ' + l.msg }));
    };
    for (const t of repairs) {
      const lastBox = h('div', { class: 'repair-last-box' }, lastLine(t));
      const fillR = h('div', { class: 'pbar-fill' });
      const pctEl = h('span', { class: 'repair-pct', text: '' });
      const stepEl = h('span', { class: 'repair-step' });
      const noteEl = h('p', { class: 'repair-note', hidden: true });
      const stopBtn = button({ label: 'Abbrechen', variant: 'ghost', size: 'sm', onClick: () => { stopBtn.disabled = true; cancel(); }, attrs: { 'data-testid': 'repair-cancel' } });
      const prog = h('div', { class: 'repair-live', hidden: true, 'data-testid': 'repair-live' },
        h('div', { class: 'repair-live-row' }, spinner(12), stepEl, h('span', { class: 'grow' }), pctEl),
        h('div', { class: 'pbar' }, fillR), noteEl, h('div', { class: 'repair-live-actions' }, stopBtn));
      const b = button({ label: 'Ausführen', icon: 'play', size: 'sm', variant: 'secondary', cls: 'repair-run', disabled: !ctx.applicable(t), onClick: async () => {
        if (running) return;
        if (t.warning) { const ok = await confirmDialog({ title: t.name + '?', text: t.warning, confirmLabel: 'Ausführen' }); if (!ok) return; }
        await follow('repair', [t.id], { ids: [t.id] });
      } });
      const card = h('article', { class: 'card repair-card', 'data-id': t.id },
        h('div', { class: 'repair-top' }, h('span', { class: 'repair-icon' }, icon('wrench', 18)), h('div', { class: 'repair-badges' }, t.risk !== 'safe' ? riskBadge(t.risk) : null, needsBadge(t.needs))),
        h('h3', { class: 'repair-name', text: t.name }),
        h('p', { class: 'repair-desc', text: t.desc }),
        t.duration ? h('p', { class: 'repair-duration' }, icon('clock', 13), h('span', { text: 'Dauer etwa ' + t.duration })) : null,
        t.warning ? h('p', { class: 'cl-warn' }, icon('alert', 13), h('span', { text: t.warning })) : null,
        lastBox, prog,
        h('div', { class: 'repair-foot' }, b));
      cards.set(t.id, { card, lastBox, prog, fillR, pctEl, stepEl, noteEl, b, t, stopBtn });
      repairGrid.appendChild(card);
    }
    function updRepair(id, j) {
      const c = cards.get(id);
      if (!c) return;
      c.prog.hidden = false;
      c.card.classList.add('is-running');
      const L = j.live || {};
      const pct = typeof L.percent === 'number' && L.percent >= 0 ? L.percent : null;
      c.pctEl.textContent = (pct !== null ? fmtNumber(pct, 1) + ' %' : '') + (L.elapsedSec ? (pct !== null ? ' · ' : '') + fmtClock(L.elapsedSec) : '');
      // step text without the trailing " – 42,3 % · 3:12" (shown on the right)
      c.stepEl.textContent = String(j.step || 'Startet …').split(' – ')[0].split(' · ')[0];
      setBar(c.fillR, pct !== null ? pct / 100 : 0.02);
      c.noteEl.hidden = !L.note;
      c.noteEl.textContent = L.note || '';
    }
    function finishRepair(id, job) {
      const c = cards.get(id);
      if (!c) return;
      c.prog.hidden = true;
      c.stopBtn.disabled = false;
      c.card.classList.remove('is-running');
      if (!job) return;
      if (job.status === 'done') {
        const r = ((job.result && job.result.results) || [])[0] || {};
        const ok = r.ok !== false && !r.skipped;
        ctx.cache.repairLast[id] = { at: new Date().toISOString(), ok, msg: r.message || (r.ok === false ? 'Fehlgeschlagen' : 'Fertig, keine Fehler gemeldet') };
        clear(c.lastBox).appendChild(lastLine(c.t));
        toast({ type: ok ? 'ok' : 'warn', title: c.t.name + (ok ? ' – fertig in ' + fmtDur(job.durationMs || 0) : ''), text: r.message || 'Fertig.' });
      } else if (job.status === 'cancelled') toast({ type: 'info', title: c.t.name + ' abgebrochen', text: 'Windows bleibt dabei heil – starte es später einfach noch einmal.' });
      else toast({ type: 'error', title: c.t.name, text: job.error || 'Fehlgeschlagen.' });
    }

    const repairNote = h('div', { class: 'repair-intro' }, icon('clock', 16),
      h('p', { text: 'DISM und SFC brauchen oft 5–30 Minuten. Der PC bleibt dabei benutzbar, und du siehst hier live, wie weit sie sind. Bei Problemen in dieser Reihenfolge: Windows-Abbild prüfen → Windows-Abbild reparieren → Systemdateien prüfen (SFC).' }));

    append(el, hero, appsNote,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Was gelöscht werden kann' }), h('p', { class: 'section-desc', text: 'Nur Dateien, die Windows und Programme jederzeit neu anlegen. Anmeldungen, Cookies, Verlauf, Passwörter und Spielstände bleiben.' }))),
      groupsBox, missingBox,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Reparatur' }), h('p', { class: 'section-desc', text: 'Werkzeuge für typische Windows-Probleme. Jedes zeigt dir live, was passiert.' }))),
      repairNote,
      repairs.length ? repairGrid : h('section', { class: 'card pad-24' }, emptyState({ icon: 'wrench', title: 'Keine Reparatur-Werkzeuge', text: 'Der Katalog enthält noch keine Reparaturen.' })));
    stagger(repairGrid);

    setPreset(preset === 'custom' ? 'quick' : preset, true);
    // a cleaning or repair job of this page still runs (the user went to another page and came back)
    const prev = ctx.cache.cleanRun;
    if (prev && prev.jobId && ctx.busy && ctx.busy.id === prev.jobId) {
      fill(false);
      if (prev.kind === 'clean') { for (const id of prev.ids) rowState.set(id, { status: 'wait' }); for (const id of prev.ids) { sel.add(id); paintRow(id); } }
      follow(prev.kind, prev.ids, null, prev.jobId);
    } else if (sizes) fill(false);
    else scan(false);
  }
};
