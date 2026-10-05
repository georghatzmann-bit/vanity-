// KI-Optimierer: goal, free text, engine (local Smart-Analyse / Claude), radar scan driven by the
// job log, then before -> after score rings, findings with fixes and a selectable plan.
import { icon } from '../icons.js';
import { h, clear, button, checkbox, scoreRing, toast, plural, riskBadge, badge, stagger, reducedMotion, emptyState, confirmDialog } from '../ui.js';
import { api } from '../api.js';

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
  id: 'advisor', title: 'KI-Optimierer', icon: 'brain', desc: 'Analysiert deinen PC und schlägt den besten Plan vor', keywords: 'ki ai claude analyse smart optimieren',
  mount(el, ctx, opts) {
    const formFactor = ctx.state.profile && ctx.state.profile.formFactor;
    let goal = ctx.cache.goal || (formFactor === 'laptop' ? 'laptop' : 'gaming');
    let engine = ctx.cache.engine && ctx.settings.claude && ctx.settings.claude.hasKey ? ctx.cache.engine : 'local';
    let allowRisky = false;
    let running = false;

    // ---------- setup card
    const goalBox = h('div', { class: 'goal-grid', role: 'radiogroup', 'aria-label': 'Ziel' });
    for (const g of GOALS) {
      const b = h('button', { class: 'goal ripple-host', type: 'button', role: 'radio', 'aria-checked': String(g.id === goal), 'data-goal': g.id },
        h('span', { class: 'goal-icon' }, icon(g.icon, 18)), h('span', { class: 'goal-text' }, h('span', { class: 'goal-label', text: g.label }), h('span', { class: 'goal-desc', text: g.desc })));
      b.addEventListener('click', () => { goal = g.id; for (const x of goalBox.children) x.setAttribute('aria-checked', String(x.dataset.goal === goal)); });
      goalBox.appendChild(b);
    }
    const text = h('textarea', { class: 'textarea', rows: 2, maxLength: 600, placeholder: 'Beschreib dein Problem, z. B. „FiveM ruckelt in der Stadt“ (optional)', 'aria-label': 'Problem beschreiben (optional)', value: ctx.cache.advisorText || '' });
    const hasKey = !!(ctx.settings.claude && ctx.settings.claude.hasKey);
    const ENGINES = [
      { value: 'local', label: 'Smart-Analyse (offline, kostenlos)', desc: 'Läuft komplett auf deinem PC, in Sekunden.', icon: 'cpu' },
      { value: 'claude', label: 'Claude KI (braucht API-Key)', desc: hasKey ? 'Zweite Meinung von Claude, kostet ein paar Cent.' : 'Erst einen API-Key in den Einstellungen hinterlegen.', icon: 'sparkles', disabled: !hasKey }
    ];
    const eng = h('div', { class: 'engine-list', role: 'radiogroup', 'aria-label': 'Analyse-Methode' });
    for (const e of ENGINES) {
      const b = h('button', { class: 'model', type: 'button', role: 'radio', 'aria-checked': String(engine === e.value), disabled: !!e.disabled, 'data-engine': e.value },
        h('span', { class: 'engine-icon' }, icon(e.icon, 16)), h('span', { class: 'model-text' }, h('span', { class: 'model-label', text: e.label }), h('span', { class: 'model-desc', text: e.desc })));
      b.addEventListener('click', () => { engine = e.value; for (const x of eng.children) x.setAttribute('aria-checked', String(x === b)); claudeOpts.hidden = engine !== 'claude'; });
      eng.appendChild(b);
    }
    const keyHint = hasKey ? null : h('button', { class: 'link-btn', type: 'button' }, icon('key', 14), h('span', { text: 'Claude nutzen? API-Key in Einstellungen hinterlegen' }));
    if (keyHint) keyHint.addEventListener('click', () => ctx.navigate('settings', { focus: 'claude' }));
    const claudeOpts = h('div', { class: 'claude-opts', hidden: engine !== 'claude' },
      checkbox({ label: 'Riskante Tweaks erlauben', desc: 'Sonst schlägt Claude nur sichere und mittlere Tweaks vor.', onChange: (v) => { allowRisky = v; } }),
      h('p', { class: 'fine', text: 'An Claude gehen nur Hardware-Daten und Tweak-Status – keine Namen, keine Dateien.' }));
    const startBtn = button({ label: 'Analyse starten', icon: 'sparkles', variant: 'primary', cls: 'btn-brand btn-lg', onClick: () => start(), attrs: { 'data-testid': 'advisor-start' } });
    const setup = h('section', { class: 'card ai-setup pad-24' },
      h('div', { class: 'ai-setup-grid' },
        h('div', { class: 'ai-field' }, h('div', { class: 'field-label', text: 'Worauf soll optimiert werden?' }), goalBox),
        h('div', { class: 'ai-field' }, h('div', { class: 'field-label', text: 'Was stört dich? (optional)' }), text),
        h('div', { class: 'ai-field' }, h('div', { class: 'field-label', text: 'Methode' }), eng, keyHint, claudeOpts)),
      h('div', { class: 'ai-setup-foot' }, h('p', { class: 'fine', text: 'Die Analyse verändert nichts. Du entscheidest danach, was angewendet wird.' }), startBtn));

    const stage = h('div', { class: 'ai-stage' });
    el.append(setup, stage);

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
          h('div', { class: 'eyebrow', text: engine === 'claude' ? 'Claude analysiert' : 'Smart-Analyse läuft' }),
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
      running = true;
      ctx.cache.goal = goal; ctx.cache.engine = engine; ctx.cache.advisorText = text.value.trim();
      startBtn.disabled = true;
      setup.classList.add('is-running');
      const r = radar();
      clear(stage).appendChild(r);
      r.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      const t0 = Date.now();
      const job = await ctx.runJob(engine === 'claude' ? 'claude' : 'advisor', engine === 'claude' ? { goal, text: text.value.trim(), allowRisky } : { goal, text: text.value.trim() }, { overlay: false, quiet: true, onUpdate: (j) => r.update(j) });
      const minShow = reducedMotion() ? 0 : 1400 - (Date.now() - t0);
      if (minShow > 0) await new Promise(res => setTimeout(res, minShow));
      running = false;
      startBtn.disabled = false;
      setup.classList.remove('is-running');
      if (!el.isConnected) return;
      if (job && job.status === 'done' && job.result) {
        ctx.cache.advisor = Object.assign({ goal, at: new Date().toISOString() }, job.result);
        ctx.emit('advisor');
        showResult(ctx.cache.advisor, true);
        toast({ type: 'ok', title: 'Analyse fertig', text: (job.result.plan || []).length + ' Vorschläge für dich.' });
      } else {
        idle();
        if (job && job.status === 'error' && engine === 'claude') stage.prepend(h('div', { class: 'note note-warn' }, icon('alert', 15), h('span', { text: 'Claude-Analyse fehlgeschlagen: ' + (job.error || '') + ' Die Smart-Analyse funktioniert immer offline.' })));
      }
    }

    // ---------- result
    function showResult(r, animate) {
      clear(stage);
      const before = scoreRing({ size: 132, stroke: 11, value: null, label: 'Jetzt' });
      const after = scoreRing({ size: 132, stroke: 11, value: null, label: 'Mit Plan', cls: 'ring-after' });
      requestAnimationFrame(() => { before.set(r.score); setTimeout(() => after.set(r.scoreAfter), animate && !reducedMotion() ? 450 : 0); });
      const gain = Math.max(0, (r.scoreAfter || 0) - (r.score || 0));
      const engineLabel = r.engine === 'claude' ? 'Claude' + (r.model ? ' · ' + modelName(r.model) : '') : 'Smart-Analyse (offline)';
      const head = h('section', { class: 'card ai-score pad-24', 'data-testid': 'advisor-result' },
        h('div', { class: 'ai-rings' }, before, h('div', { class: 'ai-arrow' }, icon('arrowRight', 22), h('span', { class: 'ai-gain', text: '+' + gain })), after),
        h('div', { class: 'ai-summary' },
          h('div', { class: 'eyebrow', text: engineLabel + ' · Ziel: ' + ((GOALS.find(g => g.id === (r.goal || goal)) || {}).label || '') }),
          h('h2', { class: 'hero-title', text: gain > 0 ? '+' + gain + ' Punkte sind drin' : 'Schon sehr gut eingestellt' }),
          h('p', { class: 'hero-text', text: r.summary || '' }),
          r.usage ? h('p', { class: 'fine', text: 'Verbrauch: ' + (r.usage.input_tokens || 0) + ' Eingabe- und ' + (r.usage.output_tokens || 0) + ' Ausgabe-Tokens.' }) : null));

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
      const applyBtn = button({ label: '', icon: 'bolt', variant: 'primary', cls: 'btn-brand', attrs: { 'data-testid': 'plan-apply' } });
      const stageBtn = button({ label: 'Nur vormerken', icon: 'plus', variant: 'secondary' });
      const PRIO = { 1: 'Priorität hoch', 2: 'Priorität mittel', 3: 'Priorität niedrig' };
      function renderPlan() {
        clear(planList);
        planItems.forEach(({ p, t }, i) => {
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
        if (animate) stagger(planList);
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
        const job = await ctx.runJob('apply', { ids, label: 'KI-Plan (' + (r.engine === 'claude' ? 'Claude' : 'Smart-Analyse') + ')' }, { title: 'KI-Plan wird angewendet' });
        if (job && job.status === 'done') { for (const id of ids) { sel.delete(id); ctx.pending.delete(id); } ctx.emit('pending'); renderPlan(); }
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

      stage.append(head,
        findings.length ? h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Befunde' }), h('p', { class: 'section-desc', text: plural(findings.length, 'Punkt', 'Punkte') + ', sortiert nach Wichtigkeit.' }))) : null,
        findings.length ? fGrid : null,
        planCard);
      if (animate) { stagger(stage, ':scope > *'); stagger(fGrid); }
      const onSt = () => renderPlan();
      ctx.on('statuses', onSt);
    }

    idle();
    if (opts && opts.autostart) requestAnimationFrame(() => start());
  }
};

function modelName(m) { return m === 'claude-sonnet-5-5' ? 'Claude Sonnet 5.5' : m === 'claude-opus-5-5' ? 'Claude Opus 5.5' : m; }
