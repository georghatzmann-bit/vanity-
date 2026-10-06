// KI providers (docs/ARCHITECTURE.md section 9): shared by the KI-Optimierer, the settings page and
// the Übersicht. The backend reports which provider is ready through the "ai-status" job; the
// result is kept in ctx.cache.aiStatus (rows merged by id) and announced with the "ai-status" event.

export const PROVIDERS = [
  { id: 'claude-code', name: 'Claude Code', icon: 'sparkles', recommended: true,
    desc: 'Nutzt dein Claude-Abo (Pro oder Max) über Claude Code auf deinem PC. Kein API-Key, keine Extrakosten.' },
  { id: 'claude-api', name: 'Claude API', icon: 'key',
    desc: 'Mit deinem Anthropic-API-Key. Sehr gründlich, kostet ein paar Cent pro Analyse.' },
  { id: 'groq', name: 'Groq', icon: 'zap',
    desc: 'Kostenloser API-Key, antwortet in Sekunden. Die Vorschläge sind etwas einfacher.' },
  { id: 'offline', name: 'Smart-Analyse', icon: 'cpu',
    desc: 'Läuft komplett offline auf deinem PC, kostenlos und in Sekunden.' }
];
export const PROVIDER_BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));

export const CLAUDE_CODE_MODELS = [
  { id: 'sonnet', label: 'Sonnet – schnell und sehr gut (Standard)', desc: 'Meist in 30–90 Sekunden fertig. Schont dein Nutzungslimit.' },
  { id: 'opus', label: 'Opus – gründlichste Analyse', desc: 'Dauert länger und verbraucht mehr von deinem Limit.' },
  { id: 'haiku', label: 'Haiku – am schnellsten', desc: 'Kurze, einfachere Analyse in wenigen Sekunden.' }
];

// Fallback list until "Verbindung testen" read the models the key can really use.
export const GROQ_MODELS = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B – beste Qualität' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B – sehr schnell' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B – gut und schnell' },
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' }
];

export const PRIVACY_TEXT = 'Was gesendet wird: nur Hardware-Daten (z. B. Prozessor, Grafikkarte, RAM) und welche Tweaks an oder aus sind. Keine Namen, keine Dateien, keine Passwörter.';

/** The known status row of a provider (from the last ai-status job), merged with the settings. */
export function providerStatus(ctx, id) {
  const s = ctx.settings || {};
  const rows = (ctx.cache.aiStatus && ctx.cache.aiStatus.rows) || {};
  const row = rows[id] || null;
  if (id === 'offline') return { id, ready: true, state: 'ready', known: true, message: 'Läuft immer, komplett offline.' };
  if (id === 'claude-api') {
    const hasKey = !!(s.claude && s.claude.hasKey);
    const failed = row && row.tested && row.ok === false && hasKey;
    return Object.assign({ id, known: true }, row || {}, { ready: hasKey, hasKey, state: !hasKey ? 'no-key' : failed ? 'error' : 'ready' });
  }
  if (id === 'groq') {
    const hasKey = !!(s.ai && s.ai.groq && s.ai.groq.hasKey);
    const failed = row && row.tested && row.ok === false && hasKey;
    return Object.assign({ id, known: true }, row || {}, { ready: hasKey, hasKey, state: !hasKey ? 'no-key' : failed ? 'error' : 'ready' });
  }
  const checking = !!ctx.cache.aiStatusLoading || ctx.cache.aiTesting === id;
  if (!row) return { id, ready: false, state: checking ? 'checking' : 'unknown', known: false, message: '' };
  return Object.assign({ known: true }, row, checking ? { state: 'checking', checking: true } : {});
}

/** Short German status text for a provider chip / card. */
export function statusText(st) {
  switch (st.state) {
    case 'ready': return 'Bereit';
    case 'checking': return 'Wird geprüft …';
    case 'logged-out': return 'Nicht angemeldet';
    case 'missing': return 'Nicht installiert';
    case 'no-key': return 'Kein Key';
    case 'error': return 'Problem';
    case 'unknown': return 'Noch nicht geprüft';
    default: return st.ready ? 'Bereit' : 'Nicht bereit';
  }
}
export function statusTone(st) {
  return st.state === 'ready' ? 'ok' : st.state === 'checking' || st.state === 'unknown' ? 'neutral' : st.state === 'error' ? 'error' : 'warn';
}

/** The provider a fresh KI-Optimierer starts with: the user's choice if ready, else the best ready one. */
export function defaultProvider(ctx) {
  const pick = [ctx.cache.engine, ctx.settings.ai && ctx.settings.ai.provider].filter(Boolean);
  for (const id of pick) if (PROVIDER_BY_ID.has(id) && providerStatus(ctx, id).ready) return id;
  for (const p of PROVIDERS) if (providerStatus(ctx, p.id).ready) return p.id;
  return 'offline';
}

/**
 * Runs the ai-status job. test = 'claude-code' | 'claude-api' | 'groq' runs that provider's free
 * connection test. Background runs never block a job the user starts. Resolves with the result or null.
 */
export async function loadAiStatus(ctx, { test = '', force = false } = {}) {
  const c = ctx.cache;
  if (!test && !force && c.aiStatus && c.aiStatus.at && Date.now() - c.aiStatus.at < 5 * 60 * 1000) return c.aiStatus;
  if (!test && c.aiStatusLoading) return c.aiStatusLoading;
  let done;
  const promise = new Promise(r => { done = r; });
  if (test) c.aiTesting = test; else c.aiStatusLoading = promise;
  ctx.emit('ai-status');
  let res = null;
  try {
    // another job (the first scan, an apply …) runs: check right after it instead of giving up
    for (let i = 0; i < 300 && ctx.busy && !ctx.busy.background; i++) await new Promise(r => setTimeout(r, 400));
    const job = await ctx.runJob('ai-status', test ? { test } : {}, { overlay: false, quiet: true, background: !test, quietBusy: !test });
    res = job && job.status === 'done' ? job.result : null;
    if (res) {
      const rows = Object.assign({}, (c.aiStatus && c.aiStatus.rows) || {});
      for (const r of res.providers || []) rows[r.id] = r;
      const fresh = !test || test === 'claude-code';
      c.aiStatus = { at: fresh ? Date.now() : ((c.aiStatus && c.aiStatus.at) || 0), rows };
    }
  } finally {
    if (test) c.aiTesting = null; else c.aiStatusLoading = null;
    done(res);
    ctx.emit('ai-status');
  }
  return res;
}

const CC_MODEL_NAMES = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };
/** "Claude Opus 5.5", "Sonnet", "openai/gpt-oss-120b" -> a readable model name. */
export function modelName(m) {
  if (!m) return '';
  if (CC_MODEL_NAMES[m]) return CC_MODEL_NAMES[m];
  const c = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(m);
  if (c) return 'Claude ' + c[1][0].toUpperCase() + c[1].slice(1) + ' ' + c[2] + '.' + c[3];
  const g = GROQ_MODELS.find(x => x.id === m);
  if (g) return g.label.split(' – ')[0];
  return m;
}

/** Provider id of an advisorResult (engine 'claude' = the Claude API, 'local' = Smart-Analyse). */
export function resultProvider(r) {
  if (!r) return 'offline';
  if (r.provider) return r.provider;
  return r.engine === 'claude' ? 'claude-api' : r.engine === 'local' ? 'offline' : (r.engine || 'offline');
}
/** "Claude Code · Claude Sonnet 5.5", "Smart-Analyse (offline)" */
export function engineLabel(r) {
  const id = resultProvider(r);
  if (id === 'offline') return 'Smart-Analyse (offline)';
  const p = PROVIDER_BY_ID.get(id);
  return (p ? p.name : id) + (r && r.model ? ' · ' + modelName(r.model) : '');
}
export function engineShort(r) {
  const id = resultProvider(r);
  return id === 'offline' ? 'Smart-Analyse' : (PROVIDER_BY_ID.get(id) || { name: 'KI' }).name;
}
