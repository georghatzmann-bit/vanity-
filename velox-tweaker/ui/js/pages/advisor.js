// KI-Optimierer: goal, free text, KI provider (Claude Code / Claude API / Groq / Smart-Analyse, see
// ui/js/ai.js), radar scan driven by the job log, then before -> after score rings, findings with
// fixes and a selectable plan.
import { icon } from '../icons.js';
import { h, clear, button, checkbox, scoreRing, toast, plural, riskBadge, badge, stagger, reducedMotion, emptyState, confirmDialog, append, radioKeys, spinner } from '../ui.js';
import { api } from '../api.js';
import { PROVIDERS, PROVIDER_BY_ID, providerStatus, statusText, statusTone, defaultProvider, loadAiStatus, engineLabel, engineShort } from '../ai.js';

export const GOALS = [
  { id: 'gaming', label: 'Gaming', icon: 'gamepad', desc: 'Mehr FPS, weniger Ruckler' },
  { id: 'competitive', label: 'Esport', icon: 'target', desc: 'Niedrigste Latenz' },
  { id: 'balanced', label: 'Ausgewogen', icon: 'scale', desc: 'Schneller ohne Nachteile' },
  { id: 'privacy', label: 'Datenschutz', icon: 'eye-off', desc: 'Weniger Daten an Microsoft' },
  { id: 'laptop', label: 'Laptop', icon: 'battery', desc: 'Leistung und Akku' },
  { id: 'streaming', label: 'Streaming', icon: 'broadcast', desc: 'Spielen und streamen' },
  { id: 'fivem', label: 'FiveM', icon: 'car', desc: 'FiveM und GTA V' }
];

const SEV = { good: ['Gut', 'ok', 'checkCircle'], info: ['Hinweis', 'info', 'info'], warn: ['Warnung', 'warn', 'warn'], bad: ['Problem', 'error', 'xCircle'] };
export function severityBadge(sev) {
  const [label, tone, ic] = SEV[sev] || SEV.info;
  return h('span', { class: 'badge badge-' + tone + ' sev-badge', 'data-sev': sev }, icon(ic, 12), h('span', { text: label }));
}

const PAGE_ALIAS = { reinigung: 'cleanup', clean: 'cleanup', spiele: 'games', game: 'games', autostart: 'apps', startup: 'apps', sicherungen: 'backups', einstellungen: 'settings', tweak: 'tweaks', preset: 'presets', ki: 'advisor' };
export async function applyFix(ctx, fix) {
  if (!fix) return;
  if (fix.type === 'tweaks') {
    const n = await ctx.stageMany(fix.ids || [], true);
    if (n) toast({ type: 'ok', title: plural(n, 'Tweak', 'Tweaks') + ' vorgemerkt', text: 'Klick unten auf "Anwenden", um sie zu übernehmen.', action: { label: 'Jetzt anwenden', onClick: () => ctx.applyPending() } });
    else toast({ type: 'info', title: 'Schon erledigt', text: 'Diese Tweaks sind bereits aktiv oder vorgemerkt.' });
  } else if (fix.type === 'open') {
    try { await api.open(fix.target); toast({ type: 'ok', title: 'Windows-Einstellungen geöffnet', text: 'Das Fenster erscheint gleich neben VELOX.' }); }
    catch (e) { toast({ type: 'error', title: 'Konnte nicht geöffnet werden', text: e.message }); }
  } else if (fix.type === 'page') {
    const p = PAGE_ALIAS[fix.page] || fix.page;
    ctx.navigate(p, p === 'detweak' ? { autostart: true } : {});
  }
}

export default {
  id: 'advisor', title: 'KI-Optimierer', icon: 'brain', desc: 'Analysiert deinen PC und schlägt den besten Plan vor', keywords: 'ki ai claude code groq analyse smart optimieren',
  mount(el, ctx, opts) {
    const formFactor = ctx.state.profile && ctx.state.profile.formFactor;
    let goal = ctx.cache.goal || (formFactor === 'laptop' ? 'laptop' : 'gaming');
    // provider: chosen by the user in this visit (picked), else the best ready one (re-evaluated
    // when the ai-status job reports back)
    let engine = defaultProvider(ctx);
    let picked = !!(ctx.cache.engine && engine === ctx.cache.engine);
    let allowRisky = false;
    let running = false;
    let planUnsub = null;

    // ---------- setup card
    const goalBox = h('div', { class: 'goal-grid', role: 'radiogroup', 'aria-label': 'Ziel' });
    for (const g of GOALS) {
      const b = h('button', { class: 'goal ripple-host', type: 'button', role: 'radio', 'aria-checked': String(g.id === goal), 'data-goal': g.id },
        h('span', { class: 'goal-icon' }, icon(g.icon, 18)), h('span', { class: 'goal-text' }, h('span', { class: 'goal-label', text: g.label }), h('span', { class: 'goal-desc', text: g.desc })));
      b.addEventListener('click', () => { goal = g.id; for (const x of goalBox.children) x.setAttribute('aria-checked', String(x.dataset.goal === goal)); });
      goalBox.appendChild(b);
    }
    radioKeys(goalBox, (b) => b.click());
    const text = h('textarea', { class: 'textarea', rows: 2, maxLength: 600, placeholder: 'Beschreib dein Problem, z. B. „FiveM ruckelt in der Stadt“ (optional)', 'aria-label': 'Problem beschreiben (optional)', value: ctx.cache.advisorText || '' });
    const eng = h('div', { class: 'prov-grid', role: 'radiogroup', 'aria-label': 'KI auswählen', 'data-testid': 'ai-providers' });
    const provHint = h('div', { class: 'prov-hint' });
    const claudeOpts = h('div', { class: 'claude-opts' },
      checkbox({ label: 'Riskante Tweaks erlauben', desc: 'Sonst schlägt die KI nur sichere und mittlere Tweaks vor.', onChange: (v) => { allowRisky = v; } }),
      h('p', { class: 'fine', text: 'An die KI gehen nur Hardware-Daten und Tweak-Status – keine Namen, keine Dateien.' }));
    function renderProviders() {
      clear(eng);
      for (const p of PROVIDERS) {
        const st = providerStatus(ctx, p.id);
        const b = h('button', { class: ['prov', 'ripple-host', 'is-' + st.state], type: 'button', role: 'radio', 'aria-checked': String(engine === p.id), 'data-provider': p.id, 'data-ready': String(!!st.ready) },
          h('span', { class: 'engine-icon' }, icon(p.icon, 16)),
          h('span', { class: 'prov-text' },
            h('span', { class: 'prov-name' }, h('span', { text: p.name }), p.recommended ? h('span', { class: 'prov-rec', text: 'Empfohlen' }) : null),
            h('span', { class: 'prov-state pst-' + statusTone(st) }, st.state === 'checking' ? spinner(10) : h('span', { class: 'prov-dot' }), h('span', { text: statusText(st) }))));
        b.addEventListener('click', () => {
          engine = p.id; picked = true; ctx.cache.engine = engine;
          for (const x of eng.children) x.setAttribute('aria-checked', String(x === b));
          if (eng.syncRadios) eng.syncRadios();
          syncSetup();
          if (providerStatus(ctx, p.id).ready && (ctx.settings.ai || {}).provider !== p.id) ctx.saveSettings({ ai: { provider: p.id } }, { silent: true });
        });
        eng.appendChild(b);
      }
      if (eng.syncRadios) eng.syncRadios();
    }
    radioKeys(eng, (b) => b.click());
    function syncSetup() {
      const st = providerStatus(ctx, engine);
      const p = PROVIDER_BY_ID.get(engine);
      claudeOpts.hidden = engine === 'offline';
      clear(provHint);
      if (st.ready || st.state === 'checking') {
        provHint.appendChild(h('p', { class: 'fine prov-desc', text: (st.ready && st.message && engine === 'claude-code' ? st.message + ' ' : '') + p.desc }));
      } else {
        const setupText = engine === 'claude-code'
          ? (st.state === 'logged-out' ? 'Claude Code ist installiert, aber nicht angemeldet.' : st.state === 'missing' ? 'Claude Code ist noch nicht installiert.' : (st.message || 'Claude Code wurde noch nicht geprüft.'))
          : st.state === 'error' ? (st.message || 'Die Verbindung klappt gerade nicht.') : 'Dafür brauchst du einen API-Key' + (engine === 'groq' ? ' – bei Groq ist er kostenlos.' : '.');
        const go = button({ label: engine === 'claude-code' ? 'So richtest du es ein' : 'Key eintragen', icon: 'arrowRight', size: 'sm', variant: 'secondary', attrs: { 'data-testid': 'prov-setup' }, onClick: () => ctx.navigate('settings', { focus: engine }) });
        provHint.appendChild(h('div', { class: 'note note-warn prov-note' }, icon('alert', 15), h('div', {}, h('span', { text: setupText }), h('div', { class: 'prov-note-act' }, go))));
      }
      startBtn.disabled = running || !st.ready;
      const lbl = startBtn.querySelector('.btn-label');
      if (lbl) lbl.textContent = engine === 'offline' ? 'Analyse starten' : 'Mit ' + p.name + ' analysieren';
    }
    const startBtn = button({ label: 'Analyse starten', icon: 'sparkles', variant: 'primary', cls: 'btn-brand btn-lg', onClick: () => start(), attrs: { 'data-testid': 'advisor-start' } });
    const setup = h('section', { class: 'card ai-setup pad-24' },
      h('div', { class: 'ai-setup-grid' },
        h('div', { class: 'ai-field' }, h('div', { class: 'field-label', text: 'Worauf soll optimiert werden?' }), goalBox),
        h('div', { class: 'ai-field' }, h('div', { class: 'field-label', text: 'Was stört dich? (optional)' }), text),
        h('div', { class: 'ai-field' }, h('div', { class: 'field-label', text: 'Welche KI?' }), eng, provHint, claudeOpts)),
      h('div', { class: 'ai-setup-foot' }, h('p', { class: 'fine', text: 'Die Analyse verändert nichts. Du entscheidest danach, was angewendet wird.' }), startBtn));

    const stage = h('div', { class: 'ai-stage' });
    append(el, setup, stage);
    renderProviders();
    syncSetup();
    // Claude Code is looked up in the background (no tokens); the chips follow the answer
    const offStatus = ctx.on('ai-status', () => {
      if (!el.isConnected) { offStatus(); return; }
      if (!picked && !running) engine = defaultProvider(ctx);
      renderProviders(); syncSetup();
    });
    const offSettings = ctx.on('settings', () => { if (!el.isConnected) { offSettings(); return; } if (!running) { renderProviders(); syncSetup(); } });
    loadAiStatus(ctx).catch(() => {});

    function idle() {
      clear(stage);
      if (ctx.cache.advisor) { showResult(ctx.cache.advisor, false); return; }
      stage.appendChild(h('section', { class: 'card pad-24' }, emptyState({ icon: 'radar', title: 'Bereit für die Analyse', text: 'Wähle oben dein Ziel und starte. Die Smart-Analyse läuft komplett offline und dauert nur ein paar Sekunden.' })));
    }

    // ---------- radar
    function radar() {
      const blips = h('div', { class: 'radar-blips' });
      const stepTxt = h('div', { class: 'radar-step', text: 'Wird gestartet …' });
      const pctTxt = h('div', { class: 'radar-pct', text: '0 %' });
      const bar = h('div', { class: 'pbar' }, h('div', { class: 'pbar-fill' }));
      const steps = h('ol', { class: 'radar-steps' });
      const cancel = button({ label: 'Abbrechen', variant: 'ghost', size: 'sm', onClick: () => { if (ctx.busy && ctx.busy.id) api.cancelJob(ctx.busy.id).catch(() => {}); cancel.disabled = true; } });
      const box = h('section', { class: 'card ai-radar pad-24', 'data-testid': 'advisor-radar' },
        h('div', { class: 'radar' }, h('div', { class: 'radar-grid' }), h('div', { class: 'radar-sweep' }), blips, h('div', { class: 'radar-core' }, icon('brain', 26))),
        h('div', { class: 'radar-side' },
          h('div', { class: 'eyebrow', text: engine === 'offline' ? 'Smart-Analyse läuft' : PROVIDER_BY_ID.get(engine).name + ' analysiert' }),
          stepTxt, h('div', { class: 'radar-progress' }, bar, pctTxt), steps, h('div', { class: 'radar-foot' }, cancel)));
      let seen = 0;
      box.update = (job) => {
        const p = Math.round((job.progress || 0) * 100);
        pctTxt.textContent = p + ' %';
        bar.firstChild.style.transform = 'scaleX(' + Math.max(0.03, p / 100) + ')';
        if (job.step) stepTxt.textContent = job.step;
        const log = job.log || [];
        for (; seen < log.length; seen++) {
          const l = log[seen];
          for (const prev of steps.querySelectorAll('.is-current')) prev.classList.remove('is-current');
          const tag = l.level === 'warn' ? 'Auffällig' : l.level === 'error' ? 'Fehler' : l.level === 'ok' ? 'Fertig' : '';
          steps.appendChild(h('li', { class: 'radar-li lv-' + l.level + ' is-current' }, icon(l.level === 'warn' ? 'warn' : l.level === 'error' ? 'xCircle' : 'check', 14), h('span', { text: l.msg }), tag ? h('span', { class: 'log-tag', text: tag }) : null));
          while (steps.children.length > 7) steps.firstElementChild.remove();
          const ang = (seen * 137.5) % 360; const rad = 22 + (seen * 29) % 58;
          const bx = 50 + Math.cos(ang * Math.PI / 180) * rad * 0.5; const by = 50 + Math.sin(ang * Math.PI / 180) * rad * 0.5;
          blips.appendChild(h('span', { class: 'blip' + (l.level === 'warn' ? ' blip-warn' : ''), style: { left: bx + '%', top: by + '%' } }));
        }
      };
      return box;
    }

    async function start() {
      if (running) return;
      if (!providerStatus(ctx, engine).ready) { syncSetup(); return; }
      running = true;
      ctx.cache.goal = goal; ctx.cache.engine = engine; ctx.cache.advisorText = text.value.trim();
      startBtn.disabled = true;
      setup.classList.add('is-running');
      const usedEngine = engine;
      const r = radar();
      clear(stage).appendChild(r);
      r.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      const t0 = Date.now();
      const job = usedEngine === 'offline'
        ? await ctx.runJob('advisor', { goal, text: text.value.trim() }, { overlay: false, quiet: true, onUpdate: (j) => r.update(j) })
        : await ctx.runJob('ai', { provider: usedEngine, goal, text: text.value.trim(), allowRisky }, { overlay: false, quiet: true, onUpdate: (j) => r.update(j) });
      const minShow = reducedMotion() ? 0 : 1400 - (Date.now() - t0);
      if (minShow > 0) await new Promise(res => setTimeout(res, minShow));
      running = false;
      setup.classList.remove('is-running');
      syncSetup();
      // Keep the result even when the user left the page meanwhile (a Claude call is paid for).
      const okJob = job && job.status === 'done' && job.result;
      if (okJob) {
        ctx.cache.advisor = Object.assign({ goal, at: new Date().toISOString() }, job.result);
        ctx.emit('advisor');
      }
      if (!el.isConnected) {
        if (okJob) toast({ type: 'ok', title: 'Analyse fertig', text: plural((job.result.plan || []).length, 'Vorschlag', 'Vorschläge') + ' für dich.', action: { label: 'Ansehen', onClick: () => ctx.navigate('advisor') } });
        return;
      }
      if (okJob) {
        showResult(ctx.cache.advisor, true);
        requestAnimationFrame(() => stage.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }));
        toast({ type: 'ok', title: 'Analyse fertig', text: plural((job.result.plan || []).length, 'Vorschlag', 'Vorschläge') + ' für dich.' });
      } else {
        idle();
        if (job && job.status === 'error' && usedEngine !== 'offline') {
          const name = PROVIDER_BY_ID.get(usedEngine).name;
          const offline = button({ label: 'Smart-Analyse starten', icon: 'cpu', size: 'sm', variant: 'secondary', onClick: () => { engine = 'offline'; picked = true; renderProviders(); syncSetup(); start(); } });
          const fix = button({ label: 'Einstellungen öffnen', icon: 'cog', size: 'sm', variant: 'ghost', onClick: () => ctx.navigate('settings', { focus: usedEngine }) });
          stage.prepend(h('div', { class: 'note note-warn ai-error', 'data-testid': 'advisor-error' }, icon('alert', 15),
            h('div', {}, h('strong', { text: name + '-Analyse fehlgeschlagen' }), h('p', { text: job.error || '' }), h('p', { class: 'fine', text: 'Die Smart-Analyse funktioniert immer – offline und sofort.' }), h('div', { class: 'prov-note-act' }, offline, fix))));
          // a setup problem (logged out, key gone) shows on the chips too
          if (usedEngine === 'claude-code' || /Key|angemeldet/.test(job.error || '')) loadAiStatus(ctx, { force: true }).catch(() => {});
        }
      }
    }

    // ---------- result
    function showResult(r, animate) {
      clear(stage);
      const before = scoreRing({ size: 132, stroke: 11, value: null, label: 'Jetzt' });
      const after = scoreRing({ size: 132, stroke: 11, value: null, label: 'Mit Plan', cls: 'ring-after' });
      requestAnimationFrame(() => { before.set(r.score); setTimeout(() => after.set(r.scoreAfter), animate && !reducedMotion() ? 450 : 0); });
      const gain = Math.max(0, (r.scoreAfter || 0) - (r.score || 0));
      const head = h('section', { class: 'card ai-score pad-24', 'data-testid': 'advisor-result' },
        h('div', { class: 'ai-rings' }, before, h('div', { class: 'ai-arrow' }, icon('arrowRight', 22), h('span', { class: 'ai-gain', text: '+' + gain })), after),
        h('div', { class: 'ai-summary' },
          h('div', { class: 'eyebrow', text: engineLabel(r) + ' · Ziel: ' + ((GOALS.find(g => g.id === (r.goal || goal)) || {}).label || '') }),
          h('h2', { class: 'hero-title', text: gain > 0 ? '+' + gain + ' Punkte sind drin' : 'Schon sehr gut eingestellt' }),
          h('p', { class: 'hero-text', text: r.summary || '' }),
          usageNote(r)));

      // findings
      const order = { bad: 0, warn: 1, info: 2, good: 3 };
      const findings = (r.findings || []).slice().sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
      const fGrid = h('div', { class: 'finding-grid' });
      for (const f of findings) {
        const fixLabel = !f.fix ? null : f.fix.type === 'tweaks' ? 'Beheben (' + (f.fix.ids || []).length + ')' : f.fix.type === 'open' ? 'Einstellungen öffnen' : 'Hingehen';
        fGrid.appendChild(h('article', { class: 'card finding sev-' + f.severity },
          h('div', { class: 'finding-top' }, severityBadge(f.severity)),
          h('h3', { class: 'finding-title', text: f.title }),
          h('p', { class: 'finding-detail', text: f.detail }),
          f.fix ? button({ label: fixLabel, size: 'sm', variant: f.severity === 'good' ? 'ghost' : 'secondary', icon: f.fix.type === 'tweaks' ? 'bolt' : f.fix.type === 'open' ? 'external' : 'arrowRight', onClick: () => applyFix(ctx, f.fix), cls: 'finding-fix' }) : null));
      }

      // plan
      const planItems = (r.plan || []).map(p => ({ p, t: ctx.byId.get(p.id) })).filter(x => x.t);
      const sel = new Set(planItems.filter(x => ctx.applicable(x.t) && !ctx.isApplied(x.t.id)).map(x => x.t.id));
      const planList = h('div', { class: 'plan-list' });
      const SHOW = 12;
      let firstPlan = true;
      let showAll = planItems.length <= SHOW + 3;
      const moreBtn = button({ label: '', variant: 'ghost', size: 'sm', iconRight: 'chevronDown', cls: 'plan-more', onClick: () => { showAll = true; renderPlan(); } });
      const applyBtn = button({ label: '', icon: 'bolt', variant: 'primary', cls: 'btn-brand', attrs: { 'data-testid': 'plan-apply' } });
      const stageBtn = button({ label: 'Nur vormerken', icon: 'plus', variant: 'secondary' });
      const PRIO = { 1: 'Priorität hoch', 2: 'Priorität mittel', 3: 'Priorität niedrig' };
      function renderPlan() {
        clear(planList);
        // most important first; long plans show the top items and fold the rest
        const ordered = planItems.slice().sort((a, b) => (a.p.priority || 2) - (b.p.priority || 2));
        const visible = showAll ? ordered : ordered.slice(0, SHOW);
        visible.forEach(({ p, t }, i) => {
          const done = ctx.isApplied(t.id); const na = !ctx.applicable(t);
          const cb = checkbox({ checked: sel.has(t.id), disabled: done || na, onChange: (v) => { if (v) sel.add(t.id); else sel.delete(t.id); updateBtns(); } });
          cb.input.setAttribute('aria-label', t.name);
          planList.appendChild(h('div', { class: ['plan-item', (done || na) && 'is-done'], 'data-id': t.id, style: { '--i': String(Math.min(i, 20)) } },
            cb,
            h('div', { class: 'plan-text' }, h('div', { class: 'plan-name', text: t.name }), h('div', { class: 'plan-reason', text: p.reason || t.desc })),
            h('div', { class: 'plan-badges' },
              done ? badge('Schon aktiv', 'ok', 'check') : na ? badge('Nicht verfügbar', 'neutral', 'lock') : badge(PRIO[p.priority] || PRIO[2], p.priority === 1 ? 'accent' : 'neutral'),
              riskBadge(t.risk))));
        });
        if (!showAll) {
          const hidden = ordered.length - visible.length;
          const hiddenSel = ordered.slice(SHOW).filter(x => sel.has(x.t.id)).length;
          moreBtn.querySelector('.btn-label').textContent = 'Weitere ' + hidden + ' Vorschläge anzeigen' + (hiddenSel ? ' (' + hiddenSel + ' davon ausgewählt)' : '');
          planList.appendChild(moreBtn);
        }
        if (animate && firstPlan) stagger(planList);
        firstPlan = false;
        updateBtns();
      }
      function updateBtns() {
        applyBtn.querySelector('.btn-label').textContent = 'Plan anwenden (' + sel.size + ')';
        applyBtn.disabled = !sel.size;
        stageBtn.disabled = !sel.size;
      }
      applyBtn.addEventListener('click', async () => {
        const ids = Array.from(sel);
        const risky = ids.map(id => ctx.byId.get(id)).filter(t => t && t.risk === 'risky');
        if (risky.length && ctx.settings.confirmRisky !== false) {
          const ok = await confirmDialog({ title: 'Plan enthält riskante Tweaks', text: risky.map(t => t.name + ': ' + (t.warning || '')).join(' '), danger: true, checkbox: 'Ich weiß, was ich tue', confirmLabel: 'Anwenden' });
          if (!ok) return;
        }
        const job = await ctx.runJob('apply', { ids, label: 'KI-Plan (' + engineShort(r) + ')' }, { title: 'KI-Plan wird angewendet' });
        if (job && job.status === 'done') {
          for (const id of ids) { sel.delete(id); ctx.pending.delete(id); }
          r.planApplied = planItems.every(({ t }) => ctx.isApplied(t.id) || !ctx.applicable(t));
          ctx.emit('pending'); ctx.emit('advisor'); renderPlan();
        }
      });
      stageBtn.addEventListener('click', async () => {
        const n = await ctx.stageMany(Array.from(sel), true, { confirmed: false });
        toast({ type: 'ok', title: plural(n, 'Tweak', 'Tweaks') + ' vorgemerkt', text: 'Du findest sie unten in der Leiste.' });
      });
      renderPlan();

      const planCard = h('section', { class: 'card pad-24' },
        h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Dein Plan' }), h('p', { class: 'section-desc', text: planItems.length ? 'Abgehakte Tweaks werden angewendet. Alles wird vorher gesichert.' : 'Keine Vorschläge – dein PC ist für dieses Ziel schon optimal eingestellt.' })),
          planItems.length ? h('div', { class: 'card-actions' }, stageBtn, applyBtn) : null),
        planItems.length ? planList : emptyState({ icon: 'checkCircle', title: 'Nichts zu tun', text: 'Alle passenden Tweaks sind schon aktiv.' }));

      append(stage, head,
        findings.length ? h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Befunde' }), h('p', { class: 'section-desc', text: plural(findings.length, 'Punkt', 'Punkte') + ', sortiert nach Wichtigkeit.' }))) : null,
        findings.length ? fGrid : null,
        planCard);
      if (animate) { stagger(stage, ':scope > *'); stagger(fGrid); }
      if (planUnsub) planUnsub();
      planUnsub = ctx.on('statuses', () => { if (planList.isConnected) renderPlan(); });
    }

    idle();
    if (opts && opts.autostart) requestAnimationFrame(() => start());
  }
};

function usageNote(r) {
  const p = r.provider || (r.engine === 'claude' ? 'claude-api' : r.engine);
  if (p === 'claude-api' && r.usage) return h('p', { class: 'fine', text: 'Diese Analyse hat ein paar Cent gekostet und läuft über dein Anthropic-Konto. Die genauen Kosten siehst du in der Anthropic-Konsole.' });
  if (p === 'claude-code') return h('p', { class: 'fine', text: 'Lief über dein Claude-Abo mit Claude Code – keine Extrakosten, zählt zu deinem normalen Nutzungslimit.' });
  if (p === 'groq') return h('p', { class: 'fine', text: 'Lief über dein kostenloses Groq-Kontingent.' });
  return null;
}
