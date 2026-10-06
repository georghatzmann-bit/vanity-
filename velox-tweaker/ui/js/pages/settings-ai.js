// Einstellungen → KI: one card per provider (Claude Code, Claude API, Groq, Smart-Analyse) with its
// status, setup steps, API key, connection test and model choice. See ui/js/ai.js and
// docs/ARCHITECTURE.md section 9.
import { icon } from '../icons.js';
import { h, clear, button, toast, confirmDialog, badge, append, radioKeys, spinner } from '../ui.js';
import { api } from '../api.js';
import { PROVIDER_BY_ID, CLAUDE_CODE_MODELS, GROQ_MODELS, PRIVACY_TEXT, providerStatus, statusText, statusTone, loadAiStatus } from '../ai.js';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 – beste Qualität (Standard)', desc: 'Gründlichste Analyse. Dauert etwas länger und kostet mehr pro Anfrage.' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 – schneller und günstiger', desc: 'Sehr gute Vorschläge in kürzerer Zeit.' }
];

/** A radio list of models (.model-list). onPick(id) resolves true when saved. */
function modelList({ label, items, value, onPick, attr = 'data-model' }) {
  const list = h('div', { class: 'model-list', role: 'radiogroup', 'aria-label': label });
  const mark = (id) => { for (const x of list.children) x.setAttribute('aria-checked', String(x.getAttribute(attr) === id)); if (list.syncRadios) list.syncRadios(); };
  for (const m of items) {
    const b = h('button', { class: 'model ripple-host', type: 'button', role: 'radio', 'aria-checked': String(value === m.id), [attr]: m.id },
      h('span', { class: 'radio-dot' }), h('span', { class: 'model-text' }, h('span', { class: 'model-label', text: m.label }), m.desc ? h('span', { class: 'model-desc', text: m.desc }) : null));
    b.addEventListener('click', async () => {
      const prev = value;
      if (prev === m.id && b.getAttribute('aria-checked') === 'true') return;
      mark(m.id);
      const ok = await onPick(m.id);
      if (ok) value = m.id; else mark(prev);
    });
    list.appendChild(b);
  }
  radioKeys(list, (b) => b.click());
  return list;
}

function statusPill(st) {
  if (st.state === 'checking') return h('span', { class: 'badge badge-neutral ai-pill', 'data-state': 'checking' }, spinner(12), h('span', { text: statusText(st) }));
  const ic = st.state === 'ready' ? 'checkCircle' : st.state === 'error' ? 'xCircle' : st.state === 'unknown' ? 'clock' : 'alert';
  const el = badge(statusText(st), statusTone(st), ic);
  el.classList.add('ai-pill');
  el.dataset.state = st.state;
  return el;
}

/** Copies text; the WebView may refuse the clipboard, then the text gets selected instead. */
async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); toast({ type: 'ok', title: 'Kopiert', text: 'Füge es in PowerShell mit Rechtsklick ein.' }); }
  catch {
    if (fallbackEl) { const r = document.createRange(); r.selectNodeContents(fallbackEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    toast({ type: 'info', title: 'Markiert', text: 'Kopier den Befehl mit Strg+C.' });
  }
}

/** Ordered setup steps; a step "… Gib ein: <command> – …" shows the command with a copy button. */
function stepList(steps) {
  const ol = h('ol', { class: 'ai-steps', 'data-testid': 'ai-steps' });
  for (const s of steps || []) {
    const m = /^(.*?Gib ein: )(.+?)( – .*)?$/.exec(s);
    if (!m) { ol.appendChild(h('li', { text: s })); continue; }
    const code = h('code', { class: 'ai-cmd', text: m[2] });
    ol.appendChild(h('li', {}, h('span', { text: m[1] }),
      h('span', { class: 'ai-cmd-row' }, code, button({ label: 'Kopieren', icon: 'file', size: 'sm', variant: 'ghost', cls: 'ai-copy', onClick: () => copyText(m[2], code) })),
      m[3] ? h('span', { class: 'ai-step-rest', text: m[3].replace(/^ – /, '').replace(/^./, c => c.toUpperCase()) }) : null));
  }
  return ol;
}

/** Key field + Speichern / Key löschen / Verbindung testen for claude-api and groq. */
function keyBlock(ctx, { provider, hasKey, placeholder, testid, cls, onChanged, onTest }) {
  const name = provider === 'groq' ? 'Groq' : 'Claude';
  const box = h('div', { class: 'ai-key ' + (cls || '') });
  const status = h('div', { class: 'key-status ' + (hasKey ? 'is-ok' : 'is-off') },
    icon(hasKey ? 'checkCircle' : 'key', 18),
    h('div', {}, h('strong', { text: hasKey ? 'API-Key hinterlegt' : 'Kein API-Key hinterlegt' }),
      h('span', { text: hasKey ? 'Sicher in Windows gespeichert – nur dein Benutzerkonto kann ihn lesen. VELOX zeigt ihn nie wieder an.' : 'Füg deinen Key ein und klick auf „Speichern“.' })));
  const input = h('input', { class: 'input', type: 'password', placeholder: hasKey ? 'Neuen Key eingeben, um ihn zu ersetzen' : placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': name + ' API-Key', 'data-testid': testid + '-key' });
  const save = button({ label: 'Speichern', icon: 'lock', variant: 'primary', onClick: async () => {
    const key = input.value.trim();
    if (!key) { toast({ type: 'warn', title: 'Kein Key eingegeben' }); input.focus(); return; }
    save.disabled = true;
    try {
      const r = await api.setAiKey(provider, key);
      input.value = '';
      if (r && r.settings) Object.assign(ctx.settings, r.settings); // pages get a child of ctx: mutate, never reassign
      ctx.emit('settings');
      toast({ type: 'ok', title: 'API-Key gespeichert', text: name + ' ist jetzt im KI-Optimierer verfügbar.' });
      onChanged(true);
    } catch (e) { toast({ type: 'error', title: 'Key nicht gespeichert', text: e.message }); save.disabled = false; }
  }, attrs: { 'data-testid': testid + '-save' } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  const del = hasKey ? button({ label: 'Key löschen', icon: 'trash', variant: 'ghost', attrs: { 'data-testid': testid + '-delete' }, onClick: async () => {
    const ok = await confirmDialog({ title: 'API-Key löschen?', text: name + ' kann danach nicht mehr genutzt werden, bis du wieder einen Key einträgst.', confirmLabel: 'Löschen', danger: true });
    if (!ok) return;
    try {
      const r = await api.deleteAiKey(provider);
      if (r && r.settings) Object.assign(ctx.settings, r.settings); // pages get a child of ctx: mutate, never reassign
      ctx.emit('settings'); toast({ type: 'ok', title: 'API-Key gelöscht' }); onChanged(false);
    } catch (e) { toast({ type: 'error', title: 'Konnte nicht löschen', text: e.message }); }
  } }) : null;
  const test = hasKey ? button({ label: 'Verbindung testen', icon: 'refresh', variant: 'secondary', attrs: { 'data-testid': testid + '-test' }, onClick: async () => {
    test.disabled = true;
    const lbl = test.querySelector('.btn-label'); if (lbl) lbl.textContent = 'Wird getestet …';
    try { await onTest(); } finally { test.disabled = false; if (lbl) lbl.textContent = 'Verbindung testen'; }
  } }) : null;
  append(box, status, h('div', { class: 'key-row' }, h('div', { class: 'path-input' }, icon('key', 16), input), save, test, del));
  return box;
}

/** The KI section of the settings page. Returns { el, focus(provider) }. */
export function aiSection(ctx) {
  const s = () => ctx.settings;
  const el = h('div', { class: 'ai-cards', 'data-testid': 'ai-cards' });
  const results = {}; // provider -> last "Verbindung testen" result row

  function card(id, ...children) {
    const p = PROVIDER_BY_ID.get(id);
    const st = providerStatus(ctx, id);
    return h('article', { class: 'ai-card is-' + st.state, 'data-provider': id, id: 'ai-card-' + id },
      h('header', { class: 'ai-card-head' },
        h('span', { class: 'ai-card-icon' }, icon(p.icon, 18)),
        h('strong', { class: 'ai-card-title', text: p.name }),
        h('div', { class: 'ai-card-badges' }, p.recommended ? badge('Empfohlen', 'accent', 'star') : null, statusPill(st))),
      h('p', { class: 'fine ai-card-desc', text: p.desc }),
      ...children);
  }

  function testNote(id) {
    const r = results[id];
    if (!r) return null;
    return h('div', { class: 'note ' + (r.ok ? 'note-ok' : 'note-warn'), 'data-testid': 'ai-test-' + id }, icon(r.ok ? 'checkCircle' : 'alert', 15), h('span', { text: r.message || '' }));
  }

  function claudeCodeCard() {
    const st = providerStatus(ctx, 'claude-code');
    const body = [];
    const msg = st.state === 'checking' ? 'VELOX sucht Claude Code auf deinem PC …' : st.message || (st.state === 'unknown' ? 'Noch nicht geprüft.' : '');
    // the state as a status box, styled like the "API-Key hinterlegt" box of the other cards
    const tone = st.state === 'ready' ? 'ok' : (st.state === 'checking' || st.state === 'unknown') ? 'info' : 'warn';
    body.push(h('div', { class: 'ai-msg is-' + tone, 'data-testid': 'ai-cc-message' },
      st.state === 'checking' ? spinner(16) : icon(tone === 'ok' ? 'checkCircle' : tone === 'warn' ? 'alert' : 'info', 18), h('span', { text: msg })));
    if (st.steps && st.steps.length && st.state !== 'ready') body.push(stepList(st.steps));
    if ((ctx.mode || {}).desktopUser) body.push(h('div', { class: 'note note-info' }, icon('user', 15), h('span', { text: 'VELOX läuft mit dem Konto eines anderen Administrators. Claude Code wird trotzdem unter deinem Windows-Konto „' + ctx.mode.desktopUser + '“ gestartet – ohne Adminrechte.' })));
    const recheck = button({ label: st.state === 'ready' ? 'Erneut prüfen' : 'Erneut prüfen', icon: 'refresh', variant: 'secondary', size: 'sm', attrs: { 'data-testid': 'ai-cc-recheck' }, disabled: st.state === 'checking', onClick: async () => {
      await loadAiStatus(ctx, { test: 'claude-code' });
      const now = providerStatus(ctx, 'claude-code');
      toast({ type: now.ready ? 'ok' : 'warn', title: now.ready ? 'Claude Code ist bereit' : 'Claude Code ist noch nicht bereit', text: now.message || '' });
    } });
    body.push(h('div', { class: 'ai-card-actions' }, recheck));
    const cur = (s().ai && s().ai.claudeCode && s().ai.claudeCode.model) || 'sonnet';
    body.push(h('div', { class: 'field-label', text: 'Modell' }), modelList({ label: 'Claude-Code-Modell', items: CLAUDE_CODE_MODELS, value: cur, attr: 'data-cc-model', onPick: async (m) => {
      const ok = await ctx.saveSettings({ ai: { claudeCode: { model: m } } }, { silent: true });
      if (ok) toast({ type: 'ok', title: 'Claude-Code-Modell: ' + CLAUDE_CODE_MODELS.find(x => x.id === m).label.split(' – ')[0] });
      return ok;
    } }));
    body.push(h('p', { class: 'fine', text: 'Läuft über dein Claude-Konto (Pro oder Max) und zählt zu deinem normalen Nutzungslimit. VELOX startet Claude Code ohne Adminrechte, ohne Werkzeuge und ohne Zugriff auf deine Dateien.' }));
    return card('claude-code', ...body);
  }

  function claudeApiCard() {
    const hasKey = !!(s().claude && s().claude.hasKey);
    const cur = (s().claude && s().claude.model) || 'claude-opus-5-5';
    return card('claude-api',
      h('div', { class: 'claude-box' },
        keyBlock(ctx, { provider: 'claude-api', hasKey, placeholder: 'sk-ant-…', testid: 'claude', onChanged: () => { delete results['claude-api']; render(); }, onTest: async () => {
          const r = await loadAiStatus(ctx, { test: 'claude-api' });
          const row = r && (r.providers || []).find(x => x.id === 'claude-api');
          if (row) { results['claude-api'] = row; toast({ type: row.ok ? 'ok' : 'warn', title: row.ok ? 'Verbindung klappt' : 'Verbindung klappt nicht', text: row.message }); render(); }
        } }),
        testNote('claude-api'),
        h('p', { class: 'fine', text: 'Den Key bekommst du unter console.anthropic.com. Jede Analyse kostet ein paar Cent und wird über dein Anthropic-Konto abgerechnet. Der Verbindungstest ist kostenlos.' }),
        h('div', { class: 'field-label', text: 'Modell' }),
        modelList({ label: 'Claude-API-Modell', items: MODELS, value: cur, onPick: async (m) => {
          const ok = await ctx.saveSettings({ claude: { model: m } }, { silent: true });
          if (ok) toast({ type: 'ok', title: 'Modell: ' + MODELS.find(x => x.id === m).label.split(' – ')[0] });
          return ok;
        } })));
  }

  function groqCard() {
    const g = (s().ai && s().ai.groq) || {};
    const row = results.groq || (ctx.cache.aiStatus && ctx.cache.aiStatus.rows && ctx.cache.aiStatus.rows.groq) || null;
    const live = row && row.models && row.models.length ? row.models : null;
    const items = [{ id: '', label: 'Automatisch (empfohlen)', desc: 'VELOX nimmt das beste Modell, das dein Key gerade nutzen kann – auch wenn Groq Modelle austauscht.' }]
      .concat((live || GROQ_MODELS).slice(0, 8).map(m => ({ id: m.id, label: m.label || m.id, desc: m.id !== (m.label || m.id) ? m.id : '' })));
    if (g.model && !items.some(x => x.id === g.model)) items.push({ id: g.model, label: g.model, desc: 'Zuletzt gewählt' });
    return card('groq',
      keyBlock(ctx, { provider: 'groq', hasKey: !!g.hasKey, placeholder: 'gsk_…', testid: 'groq', onChanged: () => { delete results.groq; render(); }, onTest: async () => {
        const r = await loadAiStatus(ctx, { test: 'groq' });
        const rr = r && (r.providers || []).find(x => x.id === 'groq');
        if (rr) { results.groq = rr; toast({ type: rr.ok ? 'ok' : 'warn', title: rr.ok ? 'Verbindung klappt' : 'Verbindung klappt nicht', text: rr.message }); render(); }
      } }),
      testNote('groq'),
      h('p', { class: 'fine', text: 'Kostenlos: bei console.groq.com anmelden → „API Keys“ → „Create API Key“. Das Gratis-Kontingent reicht für viele Analysen am Tag. Der Verbindungstest ist kostenlos.' }),
      h('div', { class: 'field-label', text: live ? 'Modell (' + live.length + ' verfügbar)' : 'Modell' }),
      modelList({ label: 'Groq-Modell', items, value: g.model || '', attr: 'data-groq-model', onPick: async (m) => {
        const ok = await ctx.saveSettings({ ai: { groq: { model: m } } }, { silent: true });
        if (ok) toast({ type: 'ok', title: 'Groq-Modell: ' + (m ? (items.find(x => x.id === m) || {}).label.split(' – ')[0] : 'automatisch') });
        return ok;
      } }));
  }

  function offlineCard() {
    return card('offline', h('div', { class: 'ai-msg is-ok' }, icon('checkCircle', 18), h('span', { text: 'Immer verfügbar. Rechnet auch die Punkte aus – für jede KI.' })));
  }

  function render() {
    const active = document.activeElement;
    const keep = active && el.contains(active) && active.dataset ? active.dataset.testid : null;
    clear(el);
    append(el,
      h('div', { class: 'note note-info ai-privacy' }, icon('shieldCheck', 15), h('span', { text: PRIVACY_TEXT })),
      claudeCodeCard(), claudeApiCard(), groqCard(), offlineCard());
    if (keep) { const t = el.querySelector('[data-testid="' + keep + '"]'); if (t) t.focus({ preventScroll: true }); }
  }

  render();
  // ctx is the page's scope: its listeners end when the page is left
  ctx.on('ai-status', () => render());
  ctx.on('settings', () => { if (!el.contains(document.activeElement) || document.activeElement.tagName !== 'INPUT') render(); });
  // first visit: find out about Claude Code (costs no tokens)
  loadAiStatus(ctx).catch(() => {});

  return {
    el,
    focus(provider) {
      const c = el.querySelector('#ai-card-' + (provider || 'claude-code'));
      if (!c) return;
      c.scrollIntoView({ block: 'start' });
      c.classList.add('flash');
      const i = c.querySelector('input') || c.querySelector('button');
      if (i) i.focus({ preventScroll: true });
    }
  };
}
