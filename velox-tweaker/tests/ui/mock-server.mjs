#!/usr/bin/env node
// VELOX UI mock backend - implements docs/ARCHITECTURE.md section 7 in Node, so the front end can be
// developed and tested without PowerShell. Never touches the system; all state is in memory.
//
//   node tests/ui/mock-server.mjs [--port 0] [--token <hex>] [--profile desktop|laptop]
//        [--speed <ms per job step>] [--latency <ms per API call>] [--bulk <n extra tweaks>]
//        [--fresh-scan] [--no-admin] [--exit-on-shutdown] [--quiet]
//
// Prints exactly one line "VELOX_READY http://127.0.0.1:<port>/?t=<token>" when listening.
// Catalog: data/ first, then tests/fixtures/, then the built-in sample (tests/ui/sample-data.mjs),
// decided per file so a half-written catalog still loads. Unparseable files are skipped with a warning.
//
// Mock-only endpoints (token required, never part of the real API):
//   GET  /__mock/stats   counters (heartbeats, shutdown requests, job types started)
//   POST /__mock/kill    stop answering (simulates the backend having exited)
//   POST /__mock/reset   rebuild all state from scratch
//   POST /__mock/mode    { hosted: bool } bootstrap.mode.hosted (VELOX.exe window, ARCHITECTURE section 11)
//   POST /__mock/ai      { claudeCode: 'ready'|'logged-out'|'missing', failNext: '<provider>' } KI provider state

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as sample from './sample-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
const uiRoot = path.join(appRoot, 'ui');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const opt = {
  port: Number(arg('port', 0)) || 0,
  token: String(arg('token', '')) || crypto.randomBytes(32).toString('hex'),
  profile: String(arg('profile', 'desktop')),
  speed: Number(arg('speed', 140)),
  latency: Number(arg('latency', 0)),
  bulk: Number(arg('bulk', 0)),
  freshScan: !!arg('fresh-scan', false),
  admin: !arg('no-admin', false),
  exitOnShutdown: !!arg('exit-on-shutdown', false),
  quiet: !!arg('quiet', false),
  dataRoot: String(arg('data-root', appRoot)),
  sample: !!arg('sample', false),
  claudeCode: String(arg('claude-code', 'missing'))
};
// the one version number, like Velox.ps1 ($ctx.Version from VERSION)
const APP_VERSION = (() => { try { const v = fs.readFileSync(path.join(appRoot, 'VERSION'), 'utf8').trim(); return /^\d+\.\d+\.\d+$/.test(v) ? v : '1.0.0'; } catch { return '1.0.0'; } })();
const log = (...a) => { if (!opt.quiet) console.error('[mock]', ...a); };

// ---------------------------------------------------------------- catalog loading
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    log('skipping unparseable', path.relative(appRoot, file), '-', e.message);
    return undefined;
  }
}
function candidates(rel) {
  return [path.join(opt.dataRoot, 'data', rel), path.join(appRoot, 'tests', 'fixtures', rel), path.join(appRoot, 'tests', 'fixtures', 'data', rel)];
}
function firstJson(rel, pick) {
  if (opt.sample) return { value: undefined, from: 'built-in sample' };
  for (const f of candidates(rel)) {
    const j = readJson(f);
    const v = j === undefined ? undefined : pick(j);
    if (v !== undefined && v !== null) return { value: v, from: path.relative(appRoot, f) };
  }
  return { value: undefined, from: 'built-in sample' };
}
function loadTweakFiles() {
  // Per category: real data/ file first, then fixtures, then the built-in sample for categories
  // nobody has written yet (the catalog is being authored in parallel).
  const out = []; const covered = new Set(); const from = [];
  if (!opt.sample) {
    for (const dir of candidates('tweaks')) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
      let n = 0;
      for (const f of files) {
        const j = readJson(path.join(dir, f));
        if (!j || !Array.isArray(j.tweaks)) continue;
        const cat = j.category || f.replace(/\.json$/, '');
        if (covered.has(cat)) continue;
        covered.add(cat);
        for (const t of j.tweaks) if (t && t.id) { out.push(Object.assign({}, t, { category: cat })); n++; }
      }
      if (n) from.push(n + ' from ' + path.relative(appRoot, dir));
    }
  }
  let n = 0;
  for (const [cat, list] of Object.entries(sample.tweaks)) {
    if (covered.has(cat)) continue;
    for (const t of list) { out.push(Object.assign({}, t, { category: cat })); n++; }
  }
  if (n) from.push(n + ' from built-in sample');
  return { tweaks: out, from: from.join(', '), pureSample: covered.size === 0 };
}

const profile = JSON.parse(JSON.stringify(sample.profiles[opt.profile] || sample.profiles.desktop));
const INSTALLED_MISSING = new Set(['Microsoft.549981C3F5F10']);

function buildOf(p) { return Number((p.os && p.os.build) || 0); }
function evalWhen(w) {
  if (!w) return null;
  const build = buildOf(profile);
  const vendorName = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };
  if (w.os === 'win11' && build < 22000) return 'Nur für Windows 11';
  if (w.os === 'win10' && build >= 22000) return 'Nur für Windows 10';
  if (w.minBuild && build < w.minBuild) return w.minBuild >= 26100 ? 'Erst ab Windows 11 24H2 verfügbar' : 'Braucht eine neuere Windows-Version (Build ' + w.minBuild + ')';
  if (w.maxBuild && build > w.maxBuild) return 'Nur für ältere Windows-Versionen';
  if (w.formFactor && w.formFactor !== profile.formFactor) return w.formFactor === 'laptop' ? 'Nur für Laptops' : 'Nur für Desktop-PCs';
  if (w.gpuVendor && !profile.gpus.some(g => g.vendor === w.gpuVendor)) return 'Keine ' + vendorName[w.gpuVendor] + '-Grafikkarte gefunden';
  if (w.cpuVendor && profile.cpu.vendor !== w.cpuVendor) return 'Nur für ' + vendorName[w.cpuVendor] + '-Prozessoren';
  if (w.systemDisk && profile.systemDisk !== w.systemDisk) return w.systemDisk === 'ssd' ? 'Nur wenn Windows auf einer SSD liegt' : 'Nur wenn Windows auf einer Festplatte (HDD) liegt';
  if (w.minRamGB && profile.ram.totalGB < w.minRamGB) return 'Braucht mindestens ' + w.minRamGB + ' GB Arbeitsspeicher';
  if (w.maxRamGB && profile.ram.totalGB > w.maxRamGB) return 'Nur bei höchstens ' + w.maxRamGB + ' GB Arbeitsspeicher';
  if (w.package && INSTALLED_MISSING.has(w.package)) return 'App ist nicht installiert';
  return null;
}

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

let W; // world state
function buildWorld() {
  const cats = firstJson('categories.json', j => Array.isArray(j.categories) ? j.categories : undefined);
  const tw = loadTweakFiles();
  const pr = firstJson('presets.json', j => Array.isArray(j.presets) ? j.presets : undefined);
  const dt = firstJson('detweak.json', j => (j && typeof j === 'object' && (j.registry || j.services || j.bcd)) ? j : undefined);
  const categories = JSON.parse(JSON.stringify(cats.value || sample.categories));
  let tweaks = tw.tweaks;

  if (opt.bulk > 0) {
    const catIds = categories.map(c => c.id).filter(c => !['cleanup', 'repair', 'apps'].includes(c));
    const risks = ['safe', 'safe', 'safe', 'moderate', 'risky'];
    for (let n = 0; n < opt.bulk; n++) {
      const cat = catIds[n % catIds.length];
      const risk = risks[n % risks.length];
      tweaks.push({ id: cat + '.bulk-' + n, category: cat, name: 'Lasttest-Eintrag ' + (n + 1), desc: 'Synthetischer Eintrag, um die Liste mit sehr vielen Zeilen zu testen.', kind: 'toggle',
        group: 'Lasttest', impact: 1 + (n % 3), risk, warning: risk === 'safe' ? null : 'Nur ein Test-Eintrag.', needs: n % 7 === 0 ? 'reboot' : 'none', tags: ['fps'],
        actions: [{ type: 'reg', path: 'HKCU\\Software\\VeloxBulk', name: 'Value' + n, kind: 'DWord', value: 1, default: null }] });
    }
  }
  const known = new Set(tweaks.map(t => t.id));
  for (const t of tweaks) if (!categories.some(c => c.id === t.category)) categories.push({ id: t.category, order: 99, icon: 'layers', name: t.category, desc: '' });
  categories.sort((a, b) => (a.order || 0) - (b.order || 0));

  const decorated = tweaks.map(t => {
    const naReason = evalWhen(t.when);
    return Object.assign({ kind: 'toggle', warning: null, needs: 'none', tags: [] }, t, { applicable: !naReason, naReason });
  });
  const presets = JSON.parse(JSON.stringify(pr.value || sample.presets)).map(p => {
    let ids = (p.ids || []).filter(id => known.has(id));
    if (p.id === 'ultimate' && ids.length === 0) ids = decorated.filter(t => t.kind === 'toggle' && t.risk !== 'risky' && t.applicable && !['cleanup', 'repair', 'apps', 'security'].includes(t.category)).map(t => t.id);
    return Object.assign({}, p, { ids });
  });
  const detweak = JSON.parse(JSON.stringify(dt.value || sample.detweak));

  const statuses = {};
  const seeds = { applied: ['gaming.gamedvr-off', 'privacy.adid-off', 'ui.file-ext', 'system.menu-delay'], custom: ['gaming.priority-sep', 'gaming.responsiveness'], partial: ['privacy.telemetry-min'], unknown: ['network.autotuning'] };
  const sampleIds = new Set(Object.values(sample.tweaks).flat().map(t => t.id));
  for (const t of decorated) {
    if (t.kind === 'action') continue;
    if (!t.applicable) { statuses[t.id] = 'na'; continue; }
    let st = 'default';
    if (t.kind === 'toggle') {
      if (sampleIds.has(t.id)) { for (const [k, ids] of Object.entries(seeds)) if (ids.includes(t.id)) st = k; }
      else { const h = hash(t.id); if (h % 11 === 0) st = 'applied'; else if (h % 23 === 1) st = 'custom'; else if (h % 29 === 2) st = 'partial'; }
    }
    statuses[t.id] = st;
  }

  // foreign tweaks seeded like section 6 describes
  const foreign = new Map();
  const regSeeds = { Win32PrioritySeparation: 38, SystemResponsiveness: 0, NetworkThrottlingIndex: 4294967295, LargeSystemCache: 1 };
  for (const r of detweak.registry || []) if (r.name in regSeeds) foreign.set('reg:' + r.path + '|' + r.name, { kind: 'reg', entry: r, current: regSeeds[r.name] });
  const ifeo = (detweak.registryKeys || [])[0];
  if (ifeo) foreign.set('key:' + ifeo.path.replace('*', 'csgo.exe'), { kind: 'key', entry: ifeo, current: 'vorhanden', path: ifeo.path.replace('*', 'csgo.exe') });
  for (const b of detweak.bcd || []) if (['useplatformclock', 'disabledynamictick'].includes(b.name)) foreign.set('bcd:' + b.name, { kind: 'bcd', entry: b, current: 'yes' });
  for (const s of detweak.services || []) if (s.name === 'SysMain') foreign.set('svc:' + s.name, { kind: 'svc', entry: s, current: 'Disabled' });

  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  const seedBackup = {
    id: stamp(twoDaysAgo) + '-apply', label: 'Preset: Sicherer Boost', kind: 'apply', created: iso(twoDaysAgo), simulate: true, restorePoint: true,
    entries: decorated.filter(t => statuses[t.id] === 'applied').flatMap(t => journalFor(t, 'apply'))
  };

  log('catalog:', 'categories from', cats.from, '| tweaks', decorated.length, 'from', tw.from, '| presets from', pr.from, '| detweak from', dt.from);
  return {
    categories, tweaks: decorated, byId: new Map(decorated.map(t => [t.id, t])), presets, detweak,
    settings: { accent: 'violet', motion: 'full', confirmRisky: true, restorePoints: 'first', autoRestorePoint: true, startSound: true, introSeen: '', claude: { hasKey: false, model: 'claude-opus-5-5' },
      ai: { provider: '', claudeCode: { model: 'sonnet' }, groq: { hasKey: false, model: '' } },
      games: [{ id: 'fivem', name: 'FiveM', exe: 'FiveM_GTAProcess.exe', path: 'C:\\Users\\Spieler\\AppData\\Local\\FiveM\\FiveM.app\\data\\cache\\subprocess\\FiveM_GTAProcess.exe', boost: { priority: true, gpu: true, fso: false } }] },
    state: { statuses, profile: opt.freshScan ? profile : null, lastScan: opt.freshScan ? iso(new Date()) : null, needs: { explorer: false, reboot: false, logoff: false } },
    foreign,
    claudeCode: opt.claudeCode, aiFailNext: null,
    backups: [seedBackup],
    jobs: new Map(),
    running: null,
    restorePointDone: false,
    // like core/Engine.ps1 Get-VxSimRestorePoints: one Windows point + old VELOX points (one per job)
    restorePoints: [
      [12, 'Windows Update'], [9, 'VELOX: Preset: Sicherer Boost'], [8, 'VELOX: Tweaks: 3 aktiviert'], [6, 'VELOX: Detweak'],
      [5, 'VELOX: Tweaks: 1 aktiviert'], [3, 'VELOX: Preset: Gaming Max']
    ].map((x, i) => ({ sequence: 41 + i, description: x[1], created: iso(new Date(Date.now() - x[0] * 86400000)) })),
    rpNext: 47,
    restorePointBaseline: null,
    cleanSizes: null,
    startup: [
      { id: 'run:hkcu:Discord', name: 'Discord', command: '"C:\\Users\\Spieler\\AppData\\Local\\Discord\\Update.exe" --processStart Discord.exe', location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', enabled: true },
      { id: 'run:hkcu:Steam', name: 'Steam', command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', enabled: true },
      { id: 'run:hkcu:OneDrive', name: 'Microsoft OneDrive', command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', enabled: true },
      { id: 'run:hkcu:Spotify', name: 'Spotify', command: '"C:\\Users\\Spieler\\AppData\\Roaming\\Spotify\\Spotify.exe" --autostart --minimized', location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', enabled: false },
      { id: 'run:hklm:EpicGamesLauncher', name: 'Epic Games Launcher', command: '"C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe" -silent', location: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', enabled: true },
      { id: 'folder:user:Updater.lnk', name: 'Updater <img src=x onerror="window.__veloxXss=1">', command: 'C:\\Temp\\<script>window.__veloxXss=2</script>\\upd.exe', location: 'Autostart-Ordner (Benutzer)', enabled: true },
      { id: 'task:NvTmRep', name: 'NVIDIA Telemetry Report', command: 'C:\\Program Files\\NVIDIA Corporation\\NvTelemetry\\NvTmRep.exe', location: 'Aufgabenplanung', enabled: true },
      { id: 'hklm-run|SecurityHealth', name: 'SecurityHealth', command: '%windir%\\system32\\SecurityHealthSystray.exe', location: 'Alle Benutzer (Registry)', enabled: true }
    ],
    stats: { heartbeats: 0, shutdowns: 0, bootstraps: 0, jobs: {}, unauthorized: 0, settingsPosts: [] },
    shutdownTimer: null,
    shutdownSession: '',
    shutdownAt: 0,
    sessions: new Map(),
    foreignKeys: null,
    dead: false
  };
}

function iso(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
function stamp(d) { return iso(d).replace(/[-:]/g, '').replace('T', '-'); }

function journalFor(t, mode) {
  const toApplied = mode === 'apply';
  return (t.actions || []).map(a => {
    const e = { tweakId: t.id };
    switch (a.type) {
      case 'reg': {
        const before = { exists: a.default !== null, kind: a.kind, value: a.default };
        const after = { exists: true, kind: a.kind, value: a.value };
        return Object.assign(e, { op: 'reg', path: a.path, name: a.name, before: toApplied ? before : after, after: toApplied ? after : before });
      }
      case 'regkey': return Object.assign(e, { op: 'regkey', path: a.path, before: toApplied ? a.default : a.present, after: toApplied ? a.present : a.default, tree: null });
      case 'service': return Object.assign(e, { op: 'service', name: a.name, before: toApplied ? a.default : a.start, after: toApplied ? a.start : a.default });
      case 'task': return Object.assign(e, { op: 'task', path: a.path, before: toApplied ? a.default : a.enabled, after: toApplied ? a.enabled : a.default });
      case 'bcd': return Object.assign(e, { op: 'bcd', name: a.name, before: toApplied ? a.default : a.value, after: toApplied ? a.value : a.default });
      case 'powerplan': return Object.assign(e, { op: 'powerplan', before: '381b4222-f694-41f0-9685-ff5bb260df2e', after: 'e9a42b02-d5df-448d-aa00-03f14749eb61' });
      case 'powersetting': return Object.assign(e, { op: 'powersetting', subgroup: a.subgroup, setting: a.setting, before: a.default, after: { ac: a.ac, dc: a.dc } });
      case 'feature': return Object.assign(e, { op: 'feature', name: a.name, before: a.default, after: a.enabled });
      case 'appx': return Object.assign(e, { op: 'appx', package: a.package, restorable: false });
      default: return Object.assign(e, { op: 'ps', mode });
    }
  });
}

// ---------------------------------------------------------------- jobs
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MUTATING = new Set(['apply', 'revert', 'restorepoint', 'restore', 'detweak', 'run-action', 'startup-set', 'game-boost', 'explorer-restart', 'reboot', 'restorepoint-clean']);

function newJob(type, params) {
  const job = { id: crypto.randomBytes(6).toString('hex'), type, status: 'running', progress: 0, step: 'Wird vorbereitet …', log: [], result: null, error: null, _cancel: false, _params: params,
    skippable: false, _skip: false, durationMs: null, _start: Date.now() };
  W.jobs.set(job.id, job);
  W.running = job.id;
  W.stats.jobs[type] = (W.stats.jobs[type] || 0) + 1;
  const ctx = {
    step(text, p) { job.step = text; if (typeof p === 'number') job.progress = Math.max(job.progress, Math.min(1, p)); },
    log(level, msg) { job.log.push({ i: job.log.length, t: iso(new Date()), level, msg }); },
    async tick(mult) {
      // _mockDelayMs is a mock-only test hook (keeps a job running long enough to attach to it)
      if (params && params._mockDelayMs && !job._delayed) { job._delayed = true; await sleep(Math.min(20000, Number(params._mockDelayMs) || 0)); }
      await sleep(opt.speed * (mult || 1)); if (job._cancel) throw Object.assign(new Error('cancelled'), { cancelled: true }); },
    /** Like core/Common.ps1 Invoke-VxIsolated -Skippable: waits up to ms, ends early on "Überspringen". Returns true when skipped. */
    async skippableWait(ms) {
      job.skippable = true; job._skip = false;
      try {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          await sleep(50);
          if (job._cancel) throw Object.assign(new Error('cancelled'), { cancelled: true });
          if (job._skip) return true;
        }
        return false;
      } finally { job.skippable = false; job._skip = false; }
    }
  };
  (async () => {
    try {
      const fn = JOBS[type];
      job.result = await fn(params || {}, ctx, job);
      job.durationMs = Date.now() - job._start;
      if (job.result && typeof job.result === 'object' && !Array.isArray(job.result)) job.result.durationMs = job.durationMs;
      job.progress = 1;
      job.status = 'done';
      job.step = 'Fertig';
    } catch (e) {
      if (e.cancelled) { job.status = 'cancelled'; job.step = 'Abgebrochen'; ctx.log('warn', 'Vom Benutzer abgebrochen.'); }
      else { job.status = 'error'; job.error = e.message || String(e); job.step = 'Fehlgeschlagen'; ctx.log('error', job.error); }
    } finally {
      if (job.durationMs === null) job.durationMs = Date.now() - job._start;
      if (W.running === job.id) W.running = null;
    }
  })();
  return job;
}

function addNeeds(t) { if (t && t.needs && t.needs !== 'none' && W.state.needs[t.needs] !== undefined) W.state.needs[t.needs] = true; }
/** settings.restorePoints like core/Common.ps1 Get-VxRestorePointMode (old bool autoRestorePoint migrated). */
function rpMode() {
  const m = W.settings.restorePoints;
  return ['first', 'presets', 'off'].includes(m) ? m : (W.settings.autoRestorePoint === false ? 'off' : 'first');
}
const RP_STEP = 'Wiederherstellungspunkt wird erstellt – das kann bis zu 1–2 Minuten dauern';
/** Like core/Engine.ps1 New-VxRestorePoint in Testmodus: the baseline adopts the oldest VELOX point. */
async function makeRestorePoint(ctx, label, kind, p) {
  ctx.step(RP_STEP);
  const own = W.restorePoints.filter(x => x.description.startsWith('VELOX')).sort((a, b) => a.sequence - b.sequence);
  const baseline = kind === 'baseline' || !W.restorePointBaseline || !['created', 'adopted', 'skipped'].includes(W.restorePointBaseline.status);
  // _mockRpWaitMs: mock-only test hook - a slow restore point that can be skipped
  const skipped = await ctx.skippableWait(Math.min(20000, Number((p && p._mockRpWaitMs) || 0) || opt.speed * 2));
  if (skipped) {
    ctx.log('warn', 'Wiederherstellungspunkt übersprungen. VELOX sichert trotzdem jeden Wert im eigenen Journal.');
    if (baseline) W.restorePointBaseline = { status: 'skipped', created: iso(new Date()), sequence: null, description: 'VELOX: ' + label };
    return { ok: false, skipped: true, message: 'Wiederherstellungspunkt übersprungen. VELOX sichert trotzdem jeden Wert im eigenen Journal.' };
  }
  let item;
  if (baseline && own.length) {
    item = own[0];
    W.restorePointBaseline = { status: 'adopted', created: item.created, sequence: item.sequence, description: item.description };
    ctx.log('ok', 'Dein erster VELOX-Wiederherstellungspunkt gilt als Ausgangspunkt – es wird kein neuer angelegt.');
  } else {
    item = { sequence: W.rpNext++, description: 'VELOX: ' + label, created: iso(new Date()) };
    W.restorePoints.push(item);
    W.restorePointLast = item.created;
    if (baseline) W.restorePointBaseline = { status: 'created', created: item.created, sequence: item.sequence, description: item.description };
    ctx.log('info', 'Testmodus: Wiederherstellungspunkt "' + item.description + '" nur simuliert.');
  }
  W.restorePointDone = true;
  return { ok: true, skipped: false, message: 'Wiederherstellungspunkt erstellt.' };
}
/** Like core/Engine.ps1 Invoke-VxAutoRestorePoint: one baseline ever; mode 'presets' adds one before
 *  presets / KI plans / Detweak with 10+ tweaks, at most one per 24 h; everything else never. */
async function maybeRestorePoint(ctx, p, purpose, count) {
  const mode = rpMode();
  if (mode === 'off') return;
  const b = W.restorePointBaseline;
  if (!b || !['created', 'adopted', 'skipped'].includes(b.status)) {
    if (W.rpTried) return;
    W.rpTried = true;
    await makeRestorePoint(ctx, 'Ausgangszustand vor der ersten Änderung', 'baseline', p);
    return;
  }
  if (mode !== 'presets' || !['preset', 'plan', 'detweak'].includes(purpose) || (count || 0) < 10) return;
  const last = W.restorePointLast || (b && b.created);
  if (last && Date.now() - Date.parse(last) < 86400000) { ctx.log('info', 'Der letzte Wiederherstellungspunkt ist jünger als 24 Stunden – VELOX legt keinen weiteren an.'); return; }
  await makeRestorePoint(ctx, (p && p.label) || 'Großes Paket', 'extra', p);
}
function rpList() {
  const items = W.restorePoints.slice().sort((a, b) => a.sequence - b.sequence)
    .map(x => Object.assign({}, x, { velox: /^\s*VELOX/.test(x.description), manual: /^\s*VELOX:\s*(VELOX\s+)?manuell/i.test(x.description) }));
  const own = items.filter(x => x.velox);
  const b = W.restorePointBaseline;
  const keep = (b && b.sequence != null && own.find(x => x.sequence === b.sequence)) || own[0] || null;
  return { items, keep, extra: own.filter(x => !x.manual && (!keep || x.sequence !== keep.sequence)).length };
}
/** Same shape as core/Common.ps1 Get-VxStateDto: statuses, profile, lastScan, needs, foreignCount (null before the first detweak scan). */
function stateDto() {
  const s = W.state;
  return { statuses: s.statuses, profile: s.profile || null, lastScan: s.lastScan || null, needs: s.needs, foreignCount: typeof s.foreignCount === 'number' ? s.foreignCount : null,
    restorePointBaseline: W.restorePointBaseline };
}
/** Like core/Detweak.ps1 Set-VxForeignKeys: foreign keys of the last scan, count in state + profile. */
function setForeignKeys(keys) {
  W.foreignKeys = new Set(keys);
  W.state.foreignCount = W.foreignKeys.size;
  if (W.state.profile) W.state.profile.foreignCount = W.foreignKeys.size;
}
/** Like core/Detweak.ps1 Update-VxForeignAfterChange: what VELOX just reset/applied is not foreign. */
function dropForeign(keys) {
  if (!W.foreignKeys) return;
  for (const k of keys) W.foreignKeys.delete(k);
  setForeignKeys([...W.foreignKeys]);
}
/** source "velox": the tweak is applied and VELOX's newest journal for it set it (not a revert/restore). */
function setByVelox(id) {
  if (W.state.statuses[id] !== 'applied') return false;
  const b = W.backups.find(x => x.entries.some(e => e.tweakId === id));
  return !!b && b.kind !== 'revert' && b.kind !== 'restore';
}

function saveBackup(kind, label, entries) {
  const id = stamp(new Date()) + '-' + kind + '-' + crypto.randomBytes(2).toString('hex');
  W.backups.unshift({ id, label: label || kind, kind, created: iso(new Date()), simulate: true, restorePoint: W.restorePointDone, entries });
  return id;
}

const GOALS = {
  gaming: ['fps', 'stutter', 'latency', 'input'], competitive: ['latency', 'input', 'ping', 'competitive', 'fps'], balanced: ['quality-of-life', 'boot', 'bloat', 'fps'],
  privacy: ['privacy', 'telemetry', 'ads', 'ai'], laptop: ['bloat', 'boot', 'quality-of-life', 'ads'], streaming: ['streaming', 'network', 'fps'], fivem: ['fivem', 'gta', 'fps', 'stutter']
};
function advisorResult(params, engine) {
  const goal = GOALS[params.goal] ? params.goal : 'balanced';
  const tags = new Set(GOALS[goal]);
  const text = String(params.text || '').toLowerCase();
  if (/ruckel|stutter|lag|hänger|freeze/.test(text)) { tags.add('stutter'); tags.add('fps'); }
  if (/ping|lag|verbindung|netz/.test(text)) { tags.add('ping'); tags.add('network'); }
  if (/fivem|gta|stadt/.test(text)) { tags.add('fivem'); tags.add('gta'); }
  const laptop = profile.formFactor === 'laptop' || goal === 'laptop';
  const relevant = W.tweaks.filter(t => t.kind === 'toggle' && t.applicable && (t.risk !== 'risky' || params.allowRisky) && (t.tags || []).some(x => tags.has(x)) && !(laptop && (t.tags || []).includes('laptop-bad')));
  const weight = t => t.impact || 1;
  const total = relevant.reduce((s, t) => s + weight(t), 0) || 1;
  const done = relevant.filter(t => W.state.statuses[t.id] === 'applied').reduce((s, t) => s + weight(t), 0);
  const foreignPenalty = Math.min(12, W.foreign.size * 2);
  const score = Math.max(18, Math.min(96, Math.round(35 + 55 * done / total - foreignPenalty)));
  const plan = relevant.filter(t => W.state.statuses[t.id] !== 'applied').sort((a, b) => (b.impact || 0) - (a.impact || 0)).slice(0, 18)
    .map(t => ({ id: t.id, reason: reasonFor(t, goal), priority: t.impact >= 3 ? 1 : t.impact === 2 ? 2 : 3 }));
  const scoreAfter = Math.min(98, Math.max(score + 4, Math.round(35 + 55 * (done + plan.reduce((s, p) => s + weight(W.byId.get(p.id)), 0)) / total) + (W.foreign.size ? 4 : 0)));
  const findings = [];
  const st = W.state.statuses;
  if (st['power.ultimate-plan'] && st['power.ultimate-plan'] !== 'applied' && W.byId.get('power.ultimate-plan').applicable && !laptop)
    findings.push({ id: 'power-plan', severity: 'warn', title: 'Energieplan bremst deinen Prozessor', detail: 'Aktiv ist "Ausbalanciert". Der Prozessor taktet zwischen zwei Bildern herunter und braucht dann Zeit, um wieder hochzukommen.', fix: { type: 'tweaks', ids: ['power.ultimate-plan'] } });
  if (W.foreign.size > 0)
    findings.push({ id: 'foreign', severity: 'bad', title: W.foreign.size + ' Fremd-Tweaks von anderen Tools gefunden', detail: 'Einige Werte wurden von anderen Tweakern verstellt (z. B. HPET erzwungen). Das kann Ruckler verursachen. Setz sie mit Detweak zurück.', fix: { type: 'page', page: 'detweak' } });
  if (st['gaming.gamedvr-off'] === 'applied') findings.push({ id: 'dvr', severity: 'good', title: 'Hintergrund-Aufnahme ist aus', detail: 'Game DVR kostet keine Leistung mehr.', fix: null });
  findings.push({ id: 'gfx-settings', severity: 'info', title: 'Grafikeinstellungen pro Spiel prüfen', detail: 'In den Windows-Grafikeinstellungen kannst du jedem Spiel die schnelle Grafikkarte fest zuweisen.', fix: { type: 'open', target: 'ms-settings:display-advancedgraphics' } });
  if (/ruckel|stutter|lag/.test(text)) findings.push({ id: 'stutter', severity: 'warn', title: 'Ruckler: wahrscheinliche Ursachen', detail: 'Hintergrund-Aufnahme, Energiesparen der CPU und Fremd-Timer-Einstellungen sind die häufigsten Gründe. Der Plan unten geht genau das an.', fix: { type: 'tweaks', ids: plan.slice(0, 3).map(p => p.id) } });
  if (profile.systemDriveFreeGB < 80) findings.push({ id: 'disk', severity: 'warn', title: 'Systemlaufwerk wird voll', detail: 'Weniger als 80 GB frei. Eine Reinigung schafft Platz.', fix: { type: 'page', page: 'cleanup' } });
  const goalName = { gaming: 'Gaming', competitive: 'Esport', balanced: 'Ausgewogen', privacy: 'Datenschutz', laptop: 'Laptop', streaming: 'Streaming', fivem: 'FiveM' }[goal];
  const summary = AI_NAMES[engine]
    ? AI_NAMES[engine] + ' hat dein System für „' + goalName + '“ bewertet: ' + plan.length + ' Änderungen bringen dich von ' + score + ' auf ' + scoreAfter + ' Punkte. Die größten Hebel sind Energieplan und Hintergrund-Aufnahmen.'
    : 'Dein PC ist gut ausgestattet, aber noch nicht auf „' + goalName + '“ eingestellt. ' + plan.length + ' Änderungen bringen dich von ' + score + ' auf ' + scoreAfter + ' Punkte.';
  return { engine, goal, score, scoreAfter, summary, findings, plan };
}
function reasonFor(t, goal) {
  const tg = t.tags || [];
  if (tg.includes('fivem')) return 'Speziell für FiveM: ' + t.desc;
  if (tg.includes('latency') || tg.includes('input')) return 'Senkt die Eingabeverzögerung. ' + t.desc;
  if (tg.includes('privacy') || tg.includes('telemetry')) return 'Weniger Daten an Microsoft. ' + t.desc;
  if (tg.includes('ping') || tg.includes('network')) return 'Stabilerer Ping. ' + t.desc;
  return t.desc;
}

const JOBS = {
  async scan(p, ctx) {
    const steps = ['Prozessor wird erkannt', 'Grafikkarte wird erkannt', 'Arbeitsspeicher wird gelesen', 'Laufwerke werden geprüft', 'Bildschirm wird erkannt', 'Windows-Version wird gelesen', 'Tweak-Status wird ermittelt'];
    for (let i = 0; i < steps.length; i++) { ctx.step(steps[i] + ' …', (i + 1) / (steps.length + 1)); ctx.log('info', steps[i]); await ctx.tick(); }
    W.state.profile = profile; W.state.lastScan = iso(new Date());
    ctx.log('ok', W.tweaks.length + ' Tweaks geprüft.');
    return { profile, statuses: W.state.statuses };
  },
  async apply(p, ctx) { return applyRevert(p, ctx, 'apply'); },
  async revert(p, ctx) { return applyRevert(p, ctx, 'revert'); },
  async restorepoint(p, ctx) {
    const x = await makeRestorePoint(ctx, p.label || 'Manuell', 'manual', p);
    return { ok: x.ok, message: x.ok ? 'Wiederherstellungspunkt erstellt (Testmodus: nur simuliert).' : x.message, skipped: x.skipped, timedOut: false, baseline: W.restorePointBaseline };
  },
  async 'restorepoint-list'(p, ctx) {
    ctx.step('Lese Wiederherstellungspunkte ...', 0.2); await ctx.tick(0.5);
    return Object.assign({ ok: true, message: '', baseline: W.restorePointBaseline, mode: rpMode() }, rpList());
  },
  async 'restorepoint-clean'(p, ctx) {
    ctx.step('Lese Wiederherstellungspunkte ...', 0.1); await ctx.tick(0.5);
    const l = rpList();
    const drop = l.items.filter(x => x.velox && !x.manual && (!l.keep || x.sequence !== l.keep.sequence));
    ctx.step('Lösche ' + drop.length + ' Wiederherstellungspunkte ...', 0.4); await ctx.tick();
    const gone = new Set(drop.map(x => x.sequence));
    W.restorePoints = W.restorePoints.filter(x => !gone.has(x.sequence));
    if (l.keep && (!W.restorePointBaseline || W.restorePointBaseline.sequence !== l.keep.sequence)) W.restorePointBaseline = { status: 'adopted', created: l.keep.created, sequence: l.keep.sequence, description: l.keep.description };
    ctx.log(drop.length ? 'ok' : 'info', drop.length ? drop.length + ' überflüssige VELOX-Wiederherstellungspunkte gelöscht.' : 'Keine überflüssigen VELOX-Wiederherstellungspunkte gefunden.');
    return { removed: drop.length, failed: 0, kept: l.keep, errors: [], baseline: W.restorePointBaseline };
  },
  async restore(p, ctx) {
    const b = W.backups.find(x => x.id === p.backupId);
    if (!b) throw new Error('Sicherung nicht gefunden.');
    await maybeRestorePoint(ctx, p, 'restore', 0);
    const entries = b.entries.slice().reverse();
    let restored = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      ctx.step('Wird wiederhergestellt: ' + (e.name || e.path || e.package || e.tweakId || e.op), (i + 1) / (entries.length + 1));
      if (e.detweakKey && e.foreign) W.foreign.set(e.detweakKey, e.foreign);
      restored++;
      ctx.log('ok', 'Zurückgesetzt: ' + (e.name || e.path || e.op));
      await ctx.tick(0.4);
    }
    const ids = new Set(b.entries.map(e => e.tweakId).filter(Boolean));
    for (const id of ids) {
      const t = W.byId.get(id);
      if (!t || t.kind === 'remove') continue;
      if (b.kind === 'apply') W.state.statuses[id] = 'default';
      else if (b.kind === 'revert' || b.kind === 'detweak') W.state.statuses[id] = 'applied';
    }
    saveBackup('restore', 'Wiederherstellung: ' + b.label, []);
    return { restored, failed: 0, errors: [] };
  },
  async 'detweak-scan'(p, ctx) {
    const groups = ['Registry wird durchsucht', 'Boot-Einstellungen werden gelesen', 'Dienste werden geprüft', 'Geplante Aufgaben werden geprüft', 'Katalog-Tweaks werden verglichen'];
    for (let i = 0; i < groups.length; i++) { ctx.step(groups[i] + ' …', (i + 1) / (groups.length + 1)); ctx.log('info', groups[i]); await ctx.tick(); }
    const items = [];
    for (const [key, f] of W.foreign) {
      const e = f.entry;
      if (f.kind === 'reg') items.push({ key, source: 'detweak', tweakId: null, label: e.label, group: e.group, current: f.current, default: e.default });
      if (f.kind === 'key') items.push({ key, source: 'detweak', tweakId: null, label: e.label + ' (' + f.path.split('\\').slice(-2, -1)[0] + ')', group: e.group, current: 'vorhanden', default: 'nicht vorhanden' });
      if (f.kind === 'bcd') items.push({ key, source: 'detweak', tweakId: null, label: e.label, group: e.group, current: f.current, default: null });
      if (f.kind === 'svc') items.push({ key, source: 'detweak', tweakId: null, label: e.label, group: e.group, current: f.current, default: e.default });
    }
    for (const t of W.tweaks) {
      const s = W.state.statuses[t.id];
      if (t.kind !== 'toggle' || !['applied', 'custom', 'partial'].includes(s)) continue;
      const cat = W.categories.find(c => c.id === t.category);
      // like core/Detweak.ps1: real values for a single registry value, else the status text
      const acts = t.actions || [];
      const one = acts.length === 1 && acts[0].type === 'reg' && !String(acts[0].path).includes('*') ? acts[0] : null;
      const show = v => v === null || v === undefined ? 'nicht gesetzt' : Array.isArray(v) ? v.join(', ') : String(v);
      const current = one && s === 'applied' ? show(one.value) : s === 'applied' ? 'Angepasst' : s === 'partial' ? 'Teilweise angepasst' : 'Von anderem Tool geändert';
      items.push({ key: 'tweak:' + t.id, source: setByVelox(t.id) ? 'velox' : 'catalog', tweakId: t.id, label: t.name, group: cat ? cat.name : t.category, current, default: one ? show(one.default) : 'Windows-Standard' });
    }
    const foreign = items.filter(i => i.source !== 'velox');
    ctx.log(foreign.length ? 'warn' : 'ok', foreign.length + ' Fremd-Tweaks gefunden, ' + (items.length - foreign.length) + ' von VELOX selbst gesetzt.');
    setForeignKeys(foreign.map(i => i.key));
    return { items, commands: (W.detweak.commands || []).map(c => ({ id: c.id, label: c.label, desc: c.desc, defaultOn: !!c.defaultOn, needs: c.needs || 'none', risk: c.risk || 'safe' })), foreignCount: foreign.length };
  },
  async detweak(p, ctx) {
    const keys = Array.isArray(p.keys) ? p.keys : [];
    // like core/Detweak.ps1: no forced restore point any more - the policy decides
    await maybeRestorePoint(ctx, p, keys.length + (p.thenApply || []).length >= 10 ? 'detweak' : '', keys.length + (p.thenApply || []).length);
    const entries = [];
    let reset = 0, failed = 0, applied = 0, resetValues = 0, commandsRun = 0;
    const done = [];
    const total = keys.length + (p.commands || []).length + (p.thenApply || []).length + 1;
    let n = 0;
    for (const key of keys) {
      n++;
      ctx.step('Wird zurückgesetzt …', n / total);
      if (key.startsWith('tweak:')) {
        const id = key.slice(6); const t = W.byId.get(id);
        if (t) { entries.push(...journalFor(t, 'revert')); W.state.statuses[id] = 'default'; reset++; resetValues++; done.push(key); ctx.log('ok', 'Standard: ' + t.name); }
        else { failed++; ctx.log('error', 'Unbekannt: ' + key); }
      } else if (W.foreign.has(key)) {
        const f = W.foreign.get(key);
        entries.push({ op: f.kind === 'reg' ? 'reg' : f.kind === 'bcd' ? 'bcd' : f.kind === 'svc' ? 'service' : 'regkey', name: f.entry.name, path: f.path || f.entry.path, before: f.current, after: f.entry.default === undefined ? null : f.entry.default, detweakKey: key, foreign: f });
        W.foreign.delete(key); reset++; resetValues++; done.push(key); ctx.log('ok', 'Standard: ' + f.entry.label);
      } else { failed++; ctx.log('warn', 'Schon auf Standard: ' + key); }
      await ctx.tick(0.5);
    }
    for (const c of p.commands || []) {
      n++;
      const cmd = (W.detweak.commands || []).find(x => x.id === c);
      ctx.step('Befehl: ' + (cmd ? cmd.label : c), n / total);
      ctx.log('info', 'Testmodus: ' + (cmd ? cmd.script : c) + ' nur protokolliert.');
      if (cmd && cmd.needs && cmd.needs !== 'none') W.state.needs[cmd.needs] = true;
      if (cmd) { reset++; commandsRun++; } else failed++; // like the backend: reset = values + commands
      await ctx.tick(0.6);
    }
    for (const id of p.thenApply || []) {
      n++;
      const t = W.byId.get(id);
      if (!t || !t.applicable || t.kind !== 'toggle') continue;
      ctx.step('Wird angewendet: ' + t.name, n / total);
      entries.push(...journalFor(t, 'apply'));
      W.state.statuses[id] = 'applied'; applied++; addNeeds(t); done.push('tweak:' + id);
      ctx.log('ok', 'Angewendet: ' + t.name);
      await ctx.tick(0.4);
    }
    const backupId = saveBackup('detweak', 'Detweak', entries);
    dropForeign(done);
    return { reset, resetValues, commandsRun, failed, applied, backupId, needs: W.state.needs, errors: [], foreignCount: typeof W.state.foreignCount === 'number' ? W.state.foreignCount : 0 };
  },
  async advisor(p, ctx) { return advise(p, ctx, 'local'); },
  async 'ai-status'(p, ctx) {
    const rows = [];
    if (!p.test || p.test === 'claude-code') {
      ctx.step('Suche Claude Code …', 0.3); await ctx.tick(2);
      rows.push(claudeCodeRow());
    }
    const s = W.settings;
    const api = { id: 'claude-api', name: 'Claude API', ready: s.claude.hasKey, hasKey: s.claude.hasKey, state: s.claude.hasKey ? 'ready' : 'no-key', model: s.claude.model, message: s.claude.hasKey ? 'API-Key hinterlegt.' : 'Kein API-Key hinterlegt.', tested: false };
    if (p.test === 'claude-api') { await ctx.tick(2); Object.assign(api, { tested: true, ok: s.claude.hasKey, message: s.claude.hasKey ? 'Verbindung klappt – der Key ist gültig. (Der Test hat nichts gekostet.)' : 'Noch kein API-Key hinterlegt.' }); }
    rows.push(api);
    const g = s.ai.groq;
    const groq = { id: 'groq', name: 'Groq', ready: g.hasKey, hasKey: g.hasKey, state: g.hasKey ? 'ready' : 'no-key', model: g.model, models: null, message: g.hasKey ? 'API-Key hinterlegt.' : 'Kein API-Key hinterlegt.', tested: false };
    if (p.test === 'groq') {
      await ctx.tick(2);
      const models = [{ id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B – beste Qualität', strict: true, recommended: true }, { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B – sehr schnell', strict: true, recommended: false }, { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B – am schnellsten, einfachere Antworten', strict: false, recommended: false }];
      Object.assign(groq, g.hasKey ? { tested: true, ok: true, models, message: 'Verbindung klappt – 3 Modelle verfügbar. (Der Test hat nichts gekostet.)' } : { ok: false, message: 'Noch kein Groq-Key hinterlegt.' });
    }
    rows.push(groq);
    rows.push({ id: 'offline', name: 'Smart-Analyse', ready: true, state: 'ready', message: 'Läuft immer, komplett offline.' });
    return { providers: rows, recommended: 'claude-code', preferred: s.ai.provider };
  },
  async ai(p, ctx) {
    const prov = p.provider;
    if (prov === 'offline') return advise(p, ctx, 'local');
    if (!['claude-code', 'claude-api', 'groq'].includes(prov)) throw new Error("Unbekannte KI '" + prov + "'.");
    if (prov === 'claude-api' && !W.settings.claude.hasKey) throw new Error('Es ist noch kein Claude-API-Key hinterlegt. Trag ihn in den Einstellungen unter „KI“ ein.');
    if (prov === 'groq' && !W.settings.ai.groq.hasKey) throw new Error('Es ist noch kein Groq-API-Key hinterlegt. Trag ihn in den Einstellungen unter „KI“ ein – er ist kostenlos (console.groq.com/keys).');
    if (prov === 'claude-code' && W.claudeCode === 'missing') throw new Error('Claude Code ist auf diesem PC nicht installiert. Installier es in PowerShell (nicht als Administrator) mit: irm https://claude.ai/install.ps1 | iex – dann „claude“ starten und mit deinem Claude-Konto anmelden.');
    if (prov === 'claude-code' && W.claudeCode === 'logged-out') throw new Error('Claude Code ist nicht angemeldet. Öffne PowerShell (nicht als Administrator), gib „claude auth login“ ein und melde dich an. Dann noch einmal versuchen.');
    if (W.aiFailNext === prov) { W.aiFailNext = null; await ctx.tick(2); throw new Error(prov === 'groq' ? 'Dein kostenloses Groq-Limit ist gerade aufgebraucht. Versuch es in 30 Sekunden noch einmal oder nimm solange die Smart-Analyse.' : 'Dein Claude-Nutzungslimit ist gerade erreicht. Warte, bis es zurückgesetzt wird (Claude Code zeigt dir die Uhrzeit), oder nimm solange Groq oder die Smart-Analyse.'); }
    const r = await advise(p, ctx, prov);
    const model = prov === 'claude-api' ? W.settings.claude.model : prov === 'groq' ? (W.settings.ai.groq.model || 'openai/gpt-oss-120b') : 'claude-' + (W.settings.ai.claudeCode.model || 'sonnet') + '-5-5';
    return Object.assign(r, { engine: prov === 'claude-api' ? 'claude' : prov, provider: prov, model, usage: { input_tokens: 18234, output_tokens: 1420 } });
  },
  async claude(p, ctx) {
    if (!W.settings.claude.hasKey) throw new Error('Kein API-Key hinterlegt. Trage ihn unter Einstellungen ein.');
    const r = await advise(p, ctx, 'claude');
    return Object.assign(r, { model: W.settings.claude.model, usage: { input_tokens: 18234, output_tokens: 1420 } });
  },
  async 'clean-scan'(p, ctx) {
    const ids = W.tweaks.filter(t => t.kind === 'action' && (t.actions || []).some(a => a.type === 'clean')).map(t => t.id);
    if (!W.cleanSizes) W.cleanSizes = Object.fromEntries(ids.map(id => [id, { bytes: (hash(id) % 1900 + 20) * 1048576 + (hash(id + 'b') % 1048576), files: hash(id) % 4000 + 12 }]));
    for (let i = 0; i < ids.length; i++) { ctx.step('Wird gemessen: ' + W.byId.get(ids[i]).name, (i + 1) / (ids.length + 1)); await ctx.tick(0.5); }
    return { items: ids.map(id => Object.assign({ id }, W.cleanSizes[id] || { bytes: 0, files: 0 })) };
  },
  async 'run-action'(p, ctx) {
    const ids = Array.isArray(p.ids) ? p.ids : [];
    const results = [];
    for (let i = 0; i < ids.length; i++) {
      const t = W.byId.get(ids[i]);
      if (!t) { results.push({ id: ids[i], ok: false, freedBytes: 0, message: 'Unbekannte Aktion' }); continue; }
      ctx.step(t.name + ' …', i / ids.length);
      if (t.category === 'repair') {
        for (const pct of [12, 37, 64, 91, 100]) { ctx.step(t.name + ' … ' + pct + ' %', (i + pct / 100) / ids.length); ctx.log('info', 'Überprüfung ' + pct + ' % abgeschlossen.'); await ctx.tick(0.6); }
      } else await ctx.tick();
      const size = W.cleanSizes && W.cleanSizes[t.id];
      const freed = size ? size.bytes : (t.actions || []).some(a => a.type === 'clean') ? 42 * 1048576 : 0;
      if (size) W.cleanSizes[t.id] = { bytes: 0, files: 0 };
      addNeeds(t);
      results.push({ id: t.id, ok: true, freedBytes: freed, message: freed ? (size ? size.files : 120) + ' Dateien gelöscht' : 'Erfolgreich ausgeführt (Testmodus)' });
      ctx.log('ok', t.name + ': fertig');
    }
    return { results };
  },
  async 'startup-list'(p, ctx) { ctx.step('Autostart wird gelesen …', 0.5); await ctx.tick(); return { items: W.startup }; },
  async 'startup-set'(p, ctx) {
    const item = W.startup.find(i => i.id === p.id);
    if (!item) throw new Error('Eintrag nicht gefunden.');
    await ctx.tick(0.5);
    item.enabled = !!p.enabled;
    saveBackup('startup', (item.enabled ? 'Autostart an: ' : 'Autostart aus: ') + item.name, [{ op: 'startup', id: item.id, before: !item.enabled, after: item.enabled }]);
    return { ok: true, item };
  },
  async 'games-detect'(p, ctx) {
    const libs = ['Steam-Bibliotheken', 'Epic Games', 'GOG', 'Xbox / PC Game Pass', 'Rockstar Launcher', 'FiveM', 'Riot Games'];
    for (let i = 0; i < libs.length; i++) { ctx.step('Suche: ' + libs[i] + ' …', (i + 1) / 8); await ctx.tick(0.4); }
    const found = [
      { id: 'fivem', name: 'FiveM', exe: 'FiveM_GTAProcess.exe', path: 'C:\\Users\\Spieler\\AppData\\Local\\FiveM\\FiveM.app\\data\\cache\\subprocess\\FiveM_GTAProcess.exe', source: 'fivem' },
      { id: 'gta5', name: 'Grand Theft Auto V', exe: 'GTA5.exe', path: 'C:\\Program Files\\Rockstar Games\\Grand Theft Auto V\\GTA5.exe', source: 'rockstar', running: true },
      { id: 'cs2', name: 'Counter-Strike 2', exe: 'cs2.exe', path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe', source: 'steam', appid: '730' },
      { id: 'valorant', name: 'VALORANT', exe: 'VALORANT-Win64-Shipping.exe', path: 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', source: 'riot' },
      { id: 'fortnite', name: 'Fortnite', exe: 'FortniteClient-Win64-Shipping.exe', path: 'C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe', source: 'epic', appid: 'Fortnite' },
      { id: 'ironharbor', name: 'Iron Harbor', exe: 'IronHarbor-Win64-Shipping.exe', path: 'D:\\SteamLibrary\\steamapps\\common\\Iron Harbor\\IronHarbor\\Binaries\\Win64\\IronHarbor-Win64-Shipping.exe', source: 'steam', appid: '999002' },
      { id: 'skycourier', name: 'Sky Courier', exe: 'SkyCourier.exe', path: 'C:\\XboxGames\\Sky Courier\\Content\\SkyCourier.exe', source: 'xbox', appid: 'Contoso.SkyCourier' },
      { id: 'lanternkeep', name: 'Lantern Keep', exe: 'LanternKeep.exe', path: 'C:\\GOG Games\\Lantern Keep\\LanternKeep.exe', source: 'gog', appid: '1207658924' }
    ];
    const games = found.map(g => {
      const b = W.settings.games.find(x => x.path.toLowerCase() === g.path.toLowerCase());
      const a = MOCK_ART[g.id];
      return Object.assign(g, { boost: b ? b.boost : { priority: false, gpu: false, fso: false }, art: a ? { cover: !!a.cover, icon: !!a.icon, shape: a.shape || 'wide', v: 'm1' } : { cover: false, icon: false, shape: null, v: '' } });
    });
    for (const b of W.settings.games) if (!games.some(g => g.path.toLowerCase() === b.path.toLowerCase())) games.push(Object.assign({ source: 'manual' }, b));
    ctx.log('ok', games.length + ' Spiele gefunden.');
    return { games };
  },
  async 'game-boost'(p, ctx) {
    if (!p.path || typeof p.path !== 'string') throw new Error('Kein Pfad angegeben.');
    if (!/\.exe$/i.test(p.path)) throw new Error('Bitte wähle eine .exe-Datei.');
    await ctx.tick(0.5);
    const exe = p.path.split(/[\\/]/).pop();
    let g = W.settings.games.find(x => x.path.toLowerCase() === p.path.toLowerCase());
    if (!g) { g = { id: exe.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-exe$/, ''), name: exe.replace(/\.exe$/i, ''), exe, path: p.path, boost: {} }; W.settings.games.push(g); }
    g.boost = { priority: !!p.priority, gpu: !!p.gpu, fso: !!p.fso };
    saveBackup('game', 'Spiel-Boost: ' + g.name, [{ op: 'game', path: g.path, after: g.boost }]);
    return { ok: true, game: Object.assign({ source: 'manual' }, g) };
  },
  async 'pick-file'(p, ctx) { await ctx.tick(0.3); ctx.log('info', 'Testmodus: kein Dateidialog.'); return { path: null }; },
  async 'explorer-restart'(p, ctx) { ctx.step('Explorer wird neu gestartet …', 0.5); await ctx.tick(2); W.state.needs.explorer = false; ctx.log('ok', 'Explorer neu gestartet (Testmodus).'); return { ok: true }; },
  async reboot(p, ctx) { ctx.step('Neustart wird geplant …', 0.5); await ctx.tick(); ctx.log('info', 'Testmodus: shutdown /r /t 10 nur protokolliert.'); return { ok: true }; }
};

async function applyRevert(p, ctx, mode) {
  const ids = Array.isArray(p.ids) ? p.ids : [];
  if (!ids.length) throw new Error('Keine Tweaks ausgewählt.');
  const lbl = String(p.label || '');
  const purpose = p.purpose === 'plan' || /^KI-Plan/.test(lbl) ? 'plan' : /^Preset/.test(lbl) ? 'preset' : '';
  await maybeRestorePoint(ctx, p, mode === 'apply' ? purpose : 'revert', ids.length);
  const results = []; const entries = [];
  for (let i = 0; i < ids.length; i++) {
    const t = W.byId.get(ids[i]);
    ctx.step((mode === 'apply' ? 'Wird angewendet: ' : 'Wird zurückgesetzt: ') + (t ? t.name : ids[i]), (i + 0.5) / ids.length);
    await ctx.tick(0.6);
    if (!t) { results.push({ id: ids[i], ok: false, status: 'unknown', error: 'Unbekannter Tweak' }); ctx.log('error', 'Unbekannt: ' + ids[i]); continue; }
    if (!t.applicable) { results.push({ id: t.id, ok: false, status: 'na', error: t.naReason }); ctx.log('warn', t.name + ': ' + t.naReason); continue; }
    if (mode === 'revert' && t.kind === 'remove') { results.push({ id: t.id, ok: false, status: W.state.statuses[t.id], error: 'Entfernte Apps lassen sich nur über den Microsoft Store neu installieren.' }); continue; }
    if (t.id.endsWith('.bulk-13')) { results.push({ id: t.id, ok: false, status: W.state.statuses[t.id], error: 'Zugriff verweigert (Test)' }); ctx.log('error', t.name + ': Zugriff verweigert'); continue; }
    entries.push(...journalFor(t, mode));
    const status = mode === 'apply' ? 'applied' : 'default';
    W.state.statuses[t.id] = status;
    addNeeds(t);
    for (const a of t.actions || []) ctx.log('info', describe(a, mode));
    ctx.log('ok', (mode === 'apply' ? 'Angewendet: ' : 'Zurückgesetzt: ') + t.name);
    results.push({ id: t.id, ok: true, status, error: null });
  }
  const backupId = saveBackup(mode, p.label || (mode === 'apply' ? 'Tweaks angewendet' : 'Tweaks zurückgesetzt'), entries);
  dropForeign(results.filter(r => r.ok).map(r => 'tweak:' + r.id)); // like core/Engine.ps1 Invoke-VxApplyJob
  return { results, backupId, needs: W.state.needs };
}
function describe(a, mode) {
  const v = mode === 'apply';
  switch (a.type) {
    case 'reg': return 'Registry ' + a.path + '\\' + a.name + ' = ' + JSON.stringify(v ? a.value : a.default);
    case 'service': return 'Dienst ' + a.name + ' -> ' + (v ? a.start : a.default);
    case 'task': return 'Aufgabe ' + a.path + ' -> ' + ((v ? a.enabled : a.default) ? 'an' : 'aus');
    case 'bcd': return 'bcdedit ' + a.name + ' -> ' + (v ? a.value : 'Standard');
    default: return 'Aktion ' + a.type + ' (Testmodus)';
  }
}
const AI_NAMES = { claude: 'Claude', 'claude-api': 'Claude', 'claude-code': 'Claude Code', groq: 'Groq' };
function claudeCodeRow() {
  const st = W.claudeCode;
  const base = { id: 'claude-code', name: 'Claude Code', model: W.settings.ai.claudeCode.model, installCommand: 'irm https://claude.ai/install.ps1 | iex', runsAs: null };
  if (st === 'ready') return Object.assign(base, { ready: true, installed: true, loggedIn: true, state: 'ready', version: '2.1.289', account: 'gamer@example.com', subscription: 'max', authMethod: 'claude.ai', message: 'Claude Code 2.1.289 gefunden – angemeldet als gamer@example.com (Max).', steps: [] });
  if (st === 'logged-out') return Object.assign(base, { ready: false, installed: true, loggedIn: false, state: 'logged-out', version: '2.1.289', message: 'Claude Code ist installiert, aber nicht angemeldet.',
    steps: ['Öffne PowerShell als normaler Benutzer (Startmenü → „PowerShell“, nicht als Administrator).', 'Gib ein: claude auth login – oder starte „claude“ und tippe /login.', 'Melde dich im Browser mit deinem Claude-Konto (Pro oder Max) an.', 'Zurück in VELOX auf „Erneut prüfen“ klicken.'] });
  return Object.assign(base, { ready: false, installed: false, loggedIn: false, state: 'missing', message: 'Claude Code ist auf diesem PC nicht installiert. Mit deinem Claude-Abo (Pro oder Max) ist es die beste Wahl – ganz ohne API-Key.',
    steps: ['Öffne PowerShell als normaler Benutzer (Startmenü → „PowerShell“, nicht als Administrator).', 'Gib ein: irm https://claude.ai/install.ps1 | iex – und drück Enter.', 'Danach „claude“ eingeben und dich im Browser mit deinem Claude-Konto (Pro oder Max) anmelden.', 'Zurück in VELOX auf „Erneut prüfen“ klicken.'] });
}
async function advise(p, ctx, engine) {
  const name = AI_NAMES[engine];
  const steps = name
    ? ['Systemprofil wird anonymisiert', 'Katalog wird zusammengefasst', 'Anfrage an ' + name + ' wird gesendet', name + ' denkt nach', 'Antwort wird geprüft', 'Plan wird bewertet']
    : ['Hardware-Profil wird ausgewertet', 'Energieplan wird geprüft', 'Grafik-Einstellungen werden geprüft', 'Netzwerk wird geprüft', 'Hintergrund-Dienste werden geprüft', 'Datenschutz wird geprüft', 'Fremd-Tweaks werden gesucht', 'Plan wird erstellt'];
  for (let i = 0; i < steps.length; i++) { ctx.step(steps[i] + ' …', (i + 1) / (steps.length + 1)); ctx.log(i === 6 && W.foreign.size ? 'warn' : 'info', steps[i]); await ctx.tick(name ? 1.5 : 1); }
  const r = advisorResult(p, engine);
  ctx.log('ok', r.findings.length + ' Befunde, ' + r.plan.length + ' Vorschläge.');
  return r;
}

// ---------------------------------------------------------------- http
// game art like core/Server.ps1 (GET /api/game-art/<id>?kind=cover|icon&v=&t=): placeholder art of
// the fixture PC in tests/fixtures/games/pc - only for ids games-detect announced
const ART_PC = path.join(appRoot, 'tests', 'fixtures', 'games', 'pc');
const ART_LC = path.join(ART_PC, 'C', 'Program Files (x86)', 'Steam', 'appcache', 'librarycache');
const MOCK_ART = {
  gta5: { cover: path.join(ART_LC, '271590_header.jpg'), icon: path.join(ART_LC, '271590_icon.jpg') },
  cs2: { cover: path.join(ART_LC, '730', 'header.jpg'), icon: path.join(ART_LC, '730', '8dbc71957312bbd3baea65848b545be9eae2a355.jpg') },
  ironharbor: { cover: path.join(ART_LC, '999002', 'library_600x900.jpg'), shape: 'tall' },
  skycourier: { cover: path.join(ART_PC, 'C', 'XboxGames', 'Sky Courier', 'Content', 'Splash.png'), icon: path.join(ART_PC, 'C', 'XboxGames', 'Sky Courier', 'Content', 'Logo150.png') },
  lanternkeep: { icon: path.join(ART_PC, 'C', 'GOG Games', 'Lantern Keep', 'goggame-1207658924.ico') }
};
function serveGameArt(req, res, p, url) {
  const kind = url.searchParams.get('kind');
  if (kind !== 'cover' && kind !== 'icon') return send(res, 400, { error: 'Unbekannte Bildart.' });
  const id = decodeURIComponent(p.slice('/api/game-art/'.length));
  const file = Object.prototype.hasOwnProperty.call(MOCK_ART, id) ? MOCK_ART[id][kind] : null;
  if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Kein Bild für dieses Spiel.' });
  const buf = fs.readFileSync(file);
  const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
let port = 0;

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { resolve(null); } });
  });
}
function publicJob(job, since) {
  return { id: job.id, type: job.type, status: job.status, progress: job.progress, step: job.step, log: job.log.filter(l => l.i >= since), result: job.result, error: job.error,
    skippable: !!job.skippable, durationMs: job.durationMs === null ? Date.now() - job._start : job.durationMs };
}
function cancelShutdown() { if (W.shutdownTimer) { clearTimeout(W.shutdownTimer); W.shutdownTimer = null; log('shutdown cancelled'); } }

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.includes('..') || rel.includes('\\')) { res.writeHead(403, { 'Cache-Control': 'no-store' }); return res.end('forbidden'); }
  const file = path.resolve(uiRoot, '.' + rel);
  if (!file.startsWith(uiRoot + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}

async function handle(req, res) {
  if (W.dead) { req.socket.destroy(); return; }
  const host = req.headers.host || '';
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) { res.writeHead(403); return res.end('bad host'); }
  const origin = req.headers.origin;
  if (origin && origin !== 'http://127.0.0.1:' + port && origin !== 'http://localhost:' + port) { res.writeHead(403); return res.end('bad origin'); }
  if (req.method === 'OPTIONS') { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://' + host);
  const p = url.pathname;

  if (!p.startsWith('/api/') && !p.startsWith('/__mock/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  }

  // game art: an <img> cannot send headers, the token comes as ?t= (GET/HEAD only)
  if (p.startsWith('/api/game-art/') && (req.method === 'GET' || req.method === 'HEAD') && url.searchParams.get('t') === opt.token) return serveGameArt(req, res, p, url);
  const tokenOk = req.headers['x-velox-token'] === opt.token || (p === '/api/shutdown' && req.method === 'POST' && url.searchParams.get('t') === opt.token);
  if (!tokenOk) { W.stats.unauthorized++; return send(res, 401, { error: 'unauthorized' }); }
  if (opt.latency) await sleep(opt.latency);
  if (W.dead) { req.socket.destroy(); return; }

  const body = req.method === 'POST' ? await readBody(req) : {};
  if (body === null) return send(res, 400, { error: 'invalid json' });
  const m = (method, re) => req.method === method && re.test(p);

  if (m('GET', /^\/api\/bootstrap$/)) {
    cancelShutdown(); W.stats.bootstraps++;
    return send(res, 200, {
      app: { name: 'VELOX', version: APP_VERSION },
      mode: { simulate: true, admin: opt.admin, windows: false, os: profile.os.caption + ' ' + profile.os.displayVersion + ' (' + profile.os.build + ')', ps: '7.6.0 (Mock)', userMismatch: false, hosted: !!W.hosted },
      categories: W.categories, tweaks: W.tweaks, presets: W.presets, settings: W.settings, state: stateDto(),
      // same as core/Server.ps1: busy is a boolean, activeJob tells which job to attach to
      busy: !!W.running,
      activeJob: W.running ? { id: W.running, type: W.jobs.get(W.running).type } : null
    });
  }
  if (m('GET', /^\/api\/state$/)) return send(res, 200, stateDto());
  if (m('POST', /^\/api\/jobs$/)) {
    const type = body.type;
    if (!JOBS[type]) return send(res, 400, { error: 'Unbekannter Job-Typ: ' + String(type) });
    if (W.running) return send(res, 409, { error: 'busy', jobId: W.running, type: W.jobs.get(W.running).type });
    const job = newJob(type, body.params || {});
    return send(res, 200, { jobId: job.id });
  }
  let mm = p.match(/^\/api\/jobs\/([a-f0-9]+)$/);
  if (mm && req.method === 'GET') {
    const job = W.jobs.get(mm[1]);
    if (!job) return send(res, 404, { error: 'not found' });
    return send(res, 200, publicJob(job, Number(url.searchParams.get('since')) || 0));
  }
  // "Überspringen" like core/Server.ps1 POST /api/jobs/<id>/skip: ok only while a skippable step runs
  mm = p.match(/^\/api\/jobs\/([a-f0-9]+)\/skip$/);
  if (mm && req.method === 'POST') {
    const job = W.jobs.get(mm[1]);
    if (!job) return send(res, 404, { error: 'Job nicht gefunden.' });
    const ok = job.status === 'running' && job.skippable;
    if (ok) { job._skip = true; job.log.push({ i: job.log.length, t: iso(new Date()), level: 'warn', msg: 'Überspringen angefordert ...' }); }
    return send(res, 200, { ok });
  }
  mm = p.match(/^\/api\/jobs\/([a-f0-9]+)\/cancel$/);
  if (mm && req.method === 'POST') {
    const job = W.jobs.get(mm[1]);
    if (!job) return send(res, 404, { error: 'not found' });
    job._cancel = true;
    return send(res, 200, { ok: true });
  }
  if (m('POST', /^\/api\/settings$/)) {
    const s = W.settings;
    if (['violet', 'blue', 'cyan', 'green', 'pink', 'orange'].includes(body.accent)) s.accent = body.accent;
    if (['full', 'reduced'].includes(body.motion)) s.motion = body.motion;
    if (typeof body.confirmRisky === 'boolean') s.confirmRisky = body.confirmRisky;
    if (typeof body.startSound === 'boolean') s.startSound = body.startSound;
    if (typeof body.introSeen === 'string' && (body.introSeen === '' || /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(body.introSeen))) s.introSeen = body.introSeen;
    W.stats.settingsPosts.push(Object.keys(body).sort().join(','));
    if (['first', 'presets', 'off'].includes(body.restorePoints)) s.restorePoints = body.restorePoints;
    else if (typeof body.autoRestorePoint === 'boolean') s.restorePoints = body.autoRestorePoint ? (s.restorePoints === 'off' ? 'first' : s.restorePoints) : 'off';
    s.autoRestorePoint = s.restorePoints !== 'off';
    if (body.claude && ['claude-opus-5-5', 'claude-sonnet-5-5'].includes(body.claude.model)) s.claude.model = body.claude.model;
    if (body.ai && typeof body.ai === 'object') {
      if (['', 'claude-code', 'claude-api', 'groq', 'offline'].includes(body.ai.provider)) s.ai.provider = body.ai.provider;
      if (body.ai.claudeCode && ['sonnet', 'opus', 'haiku'].includes(body.ai.claudeCode.model)) s.ai.claudeCode.model = body.ai.claudeCode.model;
      if (body.ai.groq && typeof body.ai.groq.model === 'string' && (body.ai.groq.model === '' || /^[A-Za-z0-9][A-Za-z0-9._/:-]{1,100}$/.test(body.ai.groq.model))) s.ai.groq.model = body.ai.groq.model;
    }
    return send(res, 200, { settings: s });
  }
  if (m('POST', /^\/api\/claude\/key$/)) {
    if (typeof body.key !== 'string' || body.key.trim().length < 20) return send(res, 400, { error: 'Der Schlüssel sieht nicht gültig aus.' });
    W.settings.claude.hasKey = true;
    return send(res, 200, { hasKey: true });
  }
  if (m('DELETE', /^\/api\/claude\/key$/)) { W.settings.claude.hasKey = false; return send(res, 200, { hasKey: false }); }
  mm = p.match(/^\/api\/ai\/key\/(claude-api|groq)$/);
  if (mm) {
    const prov = mm[1];
    if (req.method === 'POST') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (prov === 'groq' && !/^gsk_[A-Za-z0-9]{20,200}$/.test(key)) return send(res, 400, { error: 'Das sieht nicht wie ein Groq-API-Key aus (er beginnt mit „gsk_“).' });
      if (prov === 'claude-api' && key.length < 20) return send(res, 400, { error: 'Das sieht nicht wie ein Anthropic-API-Key aus (er beginnt mit „sk-ant-“).' });
      if (prov === 'groq') W.settings.ai.groq.hasKey = true; else W.settings.claude.hasKey = true;
      return send(res, 200, { provider: prov, hasKey: true, settings: W.settings });
    }
    if (req.method === 'DELETE') {
      if (prov === 'groq') W.settings.ai.groq.hasKey = false; else W.settings.claude.hasKey = false;
      return send(res, 200, { provider: prov, hasKey: false, settings: W.settings });
    }
    return send(res, 405, { error: 'Methode nicht erlaubt.' });
  }
  if (m('GET', /^\/api\/backups$/)) {
    return send(res, 200, { backups: W.backups.map(b => ({ id: b.id, label: b.label, kind: b.kind, created: b.created, count: b.entries.length, tweakCount: new Set(b.entries.map(e => e.tweakId).filter(x => /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(String(x)))).size, simulate: b.simulate, restorable: b.kind !== 'restore' && b.entries.some(e => e.op !== 'appx') })) });
  }
  mm = p.match(/^\/api\/backups\/([A-Za-z0-9-]+)$/);
  if (mm && req.method === 'GET') {
    const b = W.backups.find(x => x.id === mm[1]);
    if (!b) return send(res, 404, { error: 'not found' });
    return send(res, 200, Object.assign({}, b, { entries: b.entries.map(e => { const c = Object.assign({}, e); delete c.foreign; delete c.detweakKey; return c; }) }));
  }
  if (m('POST', /^\/api\/open$/)) {
    const t = String(body.target || '');
    const allowed = t === 'backups' || /^ms-settings:[a-z-]+$/.test(t);
    if (!allowed) return send(res, 400, { error: 'Ziel nicht erlaubt.' });
    log('open', t);
    return send(res, 200, { ok: true });
  }
  // window sessions like core/Server.ps1: ?s=<id> on heartbeat and shutdown beacon
  const sess = /^[A-Za-z0-9_-]{4,64}$/.test(url.searchParams.get('s') || '') ? url.searchParams.get('s') : '';
  if (m('POST', /^\/api\/heartbeat$/)) {
    W.stats.heartbeats++;
    const now = Date.now();
    // the closing window's heartbeat that was already in flight does not cancel its own shutdown
    const stray = sess && W.shutdownTimer && W.shutdownSession === sess && now - W.shutdownAt < 1000;
    if (!stray) { if (sess) W.sessions.set(sess, now); cancelShutdown(); }
    return send(res, 200, { ok: true, busy: !!W.running });
  }
  if (m('POST', /^\/api\/shutdown$/)) {
    W.stats.shutdowns++;
    if (sess) {
      W.sessions.delete(sess);
      const other = [...W.sessions.values()].some(t => Date.now() - t <= 4000);
      if (other) { log('shutdown: another window is still open'); return send(res, 200, { ok: true, closing: false }); }
    }
    cancelShutdown();
    W.shutdownSession = sess; W.shutdownAt = Date.now();
    W.shutdownTimer = setTimeout(() => {
      W.shutdownTimer = null;
      if (opt.exitOnShutdown) { log('shutdown: exiting'); process.exit(0); }
      log('shutdown timer elapsed (mock keeps running; use --exit-on-shutdown to exit)');
    }, 4000);
    return send(res, 200, { ok: true, closing: true });
  }
  if (m('GET', /^\/__mock\/stats$/)) return send(res, 200, Object.assign({}, W.stats, { shutdownPending: !!W.shutdownTimer }));
  if (m('POST', /^\/__mock\/kill$/)) { send(res, 200, { ok: true }); setTimeout(() => { W.dead = true; }, 20); return; }
  if (m('POST', /^\/__mock\/reset$/)) { W = buildWorld(); return send(res, 200, { ok: true }); }
  if (m('POST', /^\/__mock\/ai$/)) {
    if (['ready', 'logged-out', 'missing'].includes(body.claudeCode)) W.claudeCode = body.claudeCode;
    if ('failNext' in body) W.aiFailNext = body.failNext || null;
    if (body.reset) { W.settings.claude.hasKey = false; W.settings.ai = { provider: '', claudeCode: { model: 'sonnet' }, groq: { hasKey: false, model: '' } }; W.claudeCode = opt.claudeCode; W.aiFailNext = null; }
    return send(res, 200, { claudeCode: W.claudeCode, settings: W.settings });
  }
  if (m('POST', /^\/__mock\/mode$/)) { W.hosted = !!body.hosted; return send(res, 200, { hosted: W.hosted }); }
  if (m('POST', /^\/__mock\/state$/)) { if (body.needs) Object.assign(W.state.needs, body.needs); return send(res, 200, W.state); }
  return send(res, 404, { error: 'not found' });
}

W = buildWorld();
const server = http.createServer((req, res) => { handle(req, res).catch(e => { log('error', e); try { send(res, 500, { error: String(e.message || e) }); } catch { /* ignore */ } }); });
server.listen(opt.port, '127.0.0.1', () => {
  port = server.address().port;
  process.stdout.write('VELOX_READY http://127.0.0.1:' + port + '/?t=' + opt.token + '\n');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
