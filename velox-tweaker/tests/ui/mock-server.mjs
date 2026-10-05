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
  sample: !!arg('sample', false)
};
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
    settings: { accent: 'violet', motion: 'full', confirmRisky: true, autoRestorePoint: true, claude: { hasKey: false, model: 'claude-opus-5-5' },
      games: [{ id: 'fivem', name: 'FiveM', exe: 'FiveM_GTAProcess.exe', path: 'C:\\Users\\Spieler\\AppData\\Local\\FiveM\\FiveM.app\\data\\cache\\subprocess\\FiveM_GTAProcess.exe', boost: { priority: true, gpu: true, fso: false } }] },
    state: { statuses, profile: opt.freshScan ? profile : null, lastScan: opt.freshScan ? iso(new Date()) : null, needs: { explorer: false, reboot: false, logoff: false } },
    foreign,
    backups: [seedBackup],
    jobs: new Map(),
    running: null,
    restorePointDone: false,
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
    stats: { heartbeats: 0, shutdowns: 0, bootstraps: 0, jobs: {}, unauthorized: 0 },
    shutdownTimer: null,
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
const MUTATING = new Set(['apply', 'revert', 'restorepoint', 'restore', 'detweak', 'run-action', 'startup-set', 'game-boost', 'explorer-restart', 'reboot']);

function newJob(type, params) {
  const job = { id: crypto.randomBytes(6).toString('hex'), type, status: 'running', progress: 0, step: 'Wird vorbereitet …', log: [], result: null, error: null, _cancel: false, _params: params };
  W.jobs.set(job.id, job);
  W.running = job.id;
  W.stats.jobs[type] = (W.stats.jobs[type] || 0) + 1;
  const ctx = {
    step(text, p) { job.step = text; if (typeof p === 'number') job.progress = Math.max(job.progress, Math.min(1, p)); },
    log(level, msg) { job.log.push({ i: job.log.length, t: iso(new Date()), level, msg }); },
    async tick(mult) {
      // _mockDelayMs is a mock-only test hook (keeps a job running long enough to attach to it)
      if (params && params._mockDelayMs && !job._delayed) { job._delayed = true; await sleep(Math.min(20000, Number(params._mockDelayMs) || 0)); }
      await sleep(opt.speed * (mult || 1)); if (job._cancel) throw Object.assign(new Error('cancelled'), { cancelled: true }); }
  };
  (async () => {
    try {
      const fn = JOBS[type];
      job.result = await fn(params || {}, ctx, job);
      job.progress = 1;
      job.status = 'done';
      job.step = 'Fertig';
    } catch (e) {
      if (e.cancelled) { job.status = 'cancelled'; job.step = 'Abgebrochen'; ctx.log('warn', 'Vom Benutzer abgebrochen.'); }
      else { job.status = 'error'; job.error = e.message || String(e); job.step = 'Fehlgeschlagen'; ctx.log('error', job.error); }
    } finally {
      if (W.running === job.id) W.running = null;
    }
  })();
  return job;
}

function addNeeds(t) { if (t && t.needs && t.needs !== 'none' && W.state.needs[t.needs] !== undefined) W.state.needs[t.needs] = true; }
async function maybeRestorePoint(ctx) {
  if (W.settings.autoRestorePoint && !W.restorePointDone) {
    ctx.step('Wiederherstellungspunkt wird erstellt …', 0.05);
    ctx.log('info', 'Testmodus: Wiederherstellungspunkt nur protokolliert.');
    W.restorePointDone = true;
    await ctx.tick();
  }
}
/** Same shape as core/Common.ps1 Get-VxStateDto: statuses, profile, lastScan, needs (no top-level foreignCount). */
function stateDto() {
  const s = W.state;
  return { statuses: s.statuses, profile: s.profile || null, lastScan: s.lastScan || null, needs: s.needs };
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
  const summary = engine === 'claude'
    ? 'Claude hat dein System für „' + goalName + '“ bewertet: ' + plan.length + ' Änderungen bringen dich von ' + score + ' auf ' + scoreAfter + ' Punkte. Die größten Hebel sind Energieplan und Hintergrund-Aufnahmen.'
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
    ctx.step('Wiederherstellungspunkt wird erstellt …', 0.3); await ctx.tick(3);
    ctx.log('info', 'Testmodus: Wiederherstellungspunkt "' + (p.label || 'VELOX') + '" nur protokolliert.');
    return { ok: true, message: 'Wiederherstellungspunkt erstellt (Testmodus: nur protokolliert).' };
  },
  async restore(p, ctx) {
    const b = W.backups.find(x => x.id === p.backupId);
    if (!b) throw new Error('Sicherung nicht gefunden.');
    await maybeRestorePoint(ctx);
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
      items.push({ key: 'tweak:' + t.id, source: 'catalog', tweakId: t.id, label: t.name, group: cat ? cat.name : t.category, current: s === 'applied' ? 'Tweak aktiv' : s === 'partial' ? 'Teilweise geändert' : 'Eigener Wert', default: 'Windows-Standard' });
    }
    ctx.log(items.length ? 'warn' : 'ok', items.length + ' Abweichungen vom Windows-Standard gefunden.');
    W.state.foreignCount = items.length;
    if (W.state.profile) W.state.profile.foreignCount = items.length; // like core/Detweak.ps1 Set-VxForeignCount
    return { items, commands: (W.detweak.commands || []).map(c => ({ id: c.id, label: c.label, desc: c.desc, defaultOn: !!c.defaultOn, needs: c.needs || 'none' })) };
  },
  async detweak(p, ctx) {
    const keys = Array.isArray(p.keys) ? p.keys : [];
    if (p.restorePoint) { ctx.step('Wiederherstellungspunkt wird erstellt …', 0.04); ctx.log('info', 'Testmodus: Wiederherstellungspunkt nur protokolliert.'); W.restorePointDone = true; await ctx.tick(); }
    const entries = [];
    let reset = 0, failed = 0, applied = 0;
    const total = keys.length + (p.commands || []).length + (p.thenApply || []).length + 1;
    let n = 0;
    for (const key of keys) {
      n++;
      ctx.step('Wird zurückgesetzt …', n / total);
      if (key.startsWith('tweak:')) {
        const id = key.slice(6); const t = W.byId.get(id);
        if (t) { entries.push(...journalFor(t, 'revert')); W.state.statuses[id] = 'default'; reset++; ctx.log('ok', 'Standard: ' + t.name); }
        else { failed++; ctx.log('error', 'Unbekannt: ' + key); }
      } else if (W.foreign.has(key)) {
        const f = W.foreign.get(key);
        entries.push({ op: f.kind === 'reg' ? 'reg' : f.kind === 'bcd' ? 'bcd' : f.kind === 'svc' ? 'service' : 'regkey', name: f.entry.name, path: f.path || f.entry.path, before: f.current, after: f.entry.default === undefined ? null : f.entry.default, detweakKey: key, foreign: f });
        W.foreign.delete(key); reset++; ctx.log('ok', 'Standard: ' + f.entry.label);
      } else { failed++; ctx.log('warn', 'Schon auf Standard: ' + key); }
      await ctx.tick(0.5);
    }
    for (const c of p.commands || []) {
      n++;
      const cmd = (W.detweak.commands || []).find(x => x.id === c);
      ctx.step('Befehl: ' + (cmd ? cmd.label : c), n / total);
      ctx.log('info', 'Testmodus: ' + (cmd ? cmd.script : c) + ' nur protokolliert.');
      if (cmd && cmd.needs && cmd.needs !== 'none') W.state.needs[cmd.needs] = true;
      await ctx.tick(0.6);
    }
    for (const id of p.thenApply || []) {
      n++;
      const t = W.byId.get(id);
      if (!t || !t.applicable || t.kind !== 'toggle') continue;
      ctx.step('Wird angewendet: ' + t.name, n / total);
      entries.push(...journalFor(t, 'apply'));
      W.state.statuses[id] = 'applied'; applied++; addNeeds(t);
      ctx.log('ok', 'Angewendet: ' + t.name);
      await ctx.tick(0.4);
    }
    const backupId = saveBackup('detweak', 'Detweak', entries);
    return { reset, failed, applied, backupId, needs: W.state.needs };
  },
  async advisor(p, ctx) { return advise(p, ctx, 'local'); },
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
    const libs = ['Steam-Bibliotheken', 'Epic Games', 'Rockstar Launcher', 'FiveM', 'Riot Games'];
    for (let i = 0; i < libs.length; i++) { ctx.step(libs[i] + ' werden durchsucht …', (i + 1) / 6); await ctx.tick(0.5); }
    const found = [
      { id: 'fivem', name: 'FiveM', exe: 'FiveM_GTAProcess.exe', path: 'C:\\Users\\Spieler\\AppData\\Local\\FiveM\\FiveM.app\\data\\cache\\subprocess\\FiveM_GTAProcess.exe', source: 'fivem' },
      { id: 'gta5', name: 'Grand Theft Auto V', exe: 'GTA5.exe', path: 'C:\\Program Files\\Rockstar Games\\Grand Theft Auto V\\GTA5.exe', source: 'rockstar' },
      { id: 'cs2', name: 'Counter-Strike 2', exe: 'cs2.exe', path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe', source: 'steam' },
      { id: 'valorant', name: 'VALORANT', exe: 'VALORANT-Win64-Shipping.exe', path: 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', source: 'riot' },
      { id: 'fortnite', name: 'Fortnite', exe: 'FortniteClient-Win64-Shipping.exe', path: 'C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe', source: 'epic' }
    ];
    const games = found.map(g => { const b = W.settings.games.find(x => x.path.toLowerCase() === g.path.toLowerCase()); return Object.assign(g, { boost: b ? b.boost : { priority: false, gpu: false, fso: false } }); });
    for (const b of W.settings.games) if (!games.some(g => g.path.toLowerCase() === b.path.toLowerCase())) games.push(Object.assign({ source: 'manual' }, b));
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
  await maybeRestorePoint(ctx);
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
async function advise(p, ctx, engine) {
  const steps = engine === 'claude'
    ? ['Systemprofil wird anonymisiert', 'Katalog wird zusammengefasst', 'Anfrage an Claude wird gesendet', 'Claude analysiert dein System', 'Antwort wird geprüft', 'Plan wird bewertet']
    : ['Hardware-Profil wird ausgewertet', 'Energieplan wird geprüft', 'Grafik-Einstellungen werden geprüft', 'Netzwerk wird geprüft', 'Hintergrund-Dienste werden geprüft', 'Datenschutz wird geprüft', 'Fremd-Tweaks werden gesucht', 'Plan wird erstellt'];
  for (let i = 0; i < steps.length; i++) { ctx.step(steps[i] + ' …', (i + 1) / (steps.length + 1)); ctx.log(i === 6 && W.foreign.size ? 'warn' : 'info', steps[i]); await ctx.tick(engine === 'claude' ? 1.5 : 1); }
  const r = advisorResult(p, engine);
  ctx.log('ok', r.findings.length + ' Befunde, ' + r.plan.length + ' Vorschläge.');
  return r;
}

// ---------------------------------------------------------------- http
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
  return { id: job.id, type: job.type, status: job.status, progress: job.progress, step: job.step, log: job.log.filter(l => l.i >= since), result: job.result, error: job.error };
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
      app: { name: 'VELOX', version: '1.0.0' },
      mode: { simulate: true, admin: opt.admin, windows: false, os: profile.os.caption + ' ' + profile.os.displayVersion + ' (' + profile.os.build + ')', ps: '7.6.0 (Mock)', userMismatch: false },
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
    if (W.running) return send(res, 409, { error: 'busy', jobId: W.running });
    const job = newJob(type, body.params || {});
    return send(res, 200, { jobId: job.id });
  }
  let mm = p.match(/^\/api\/jobs\/([a-f0-9]+)$/);
  if (mm && req.method === 'GET') {
    const job = W.jobs.get(mm[1]);
    if (!job) return send(res, 404, { error: 'not found' });
    return send(res, 200, publicJob(job, Number(url.searchParams.get('since')) || 0));
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
    if (typeof body.autoRestorePoint === 'boolean') s.autoRestorePoint = body.autoRestorePoint;
    if (body.claude && ['claude-opus-5-5', 'claude-sonnet-5-5'].includes(body.claude.model)) s.claude.model = body.claude.model;
    return send(res, 200, { settings: s });
  }
  if (m('POST', /^\/api\/claude\/key$/)) {
    if (typeof body.key !== 'string' || body.key.trim().length < 20) return send(res, 400, { error: 'Der Schlüssel sieht nicht gültig aus.' });
    W.settings.claude.hasKey = true;
    return send(res, 200, { hasKey: true });
  }
  if (m('DELETE', /^\/api\/claude\/key$/)) { W.settings.claude.hasKey = false; return send(res, 200, { hasKey: false }); }
  if (m('GET', /^\/api\/backups$/)) {
    return send(res, 200, { backups: W.backups.map(b => ({ id: b.id, label: b.label, kind: b.kind, created: b.created, count: b.entries.length, simulate: b.simulate, restorable: b.kind !== 'restore' && b.entries.some(e => e.op !== 'appx') })) });
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
  if (m('POST', /^\/api\/heartbeat$/)) { cancelShutdown(); W.stats.heartbeats++; return send(res, 200, { ok: true, busy: !!W.running }); }
  if (m('POST', /^\/api\/shutdown$/)) {
    W.stats.shutdowns++;
    cancelShutdown();
    W.shutdownTimer = setTimeout(() => {
      W.shutdownTimer = null;
      if (opt.exitOnShutdown) { log('shutdown: exiting'); process.exit(0); }
      log('shutdown timer elapsed (mock keeps running; use --exit-on-shutdown to exit)');
    }, 4000);
    return send(res, 200, { ok: true });
  }
  if (m('GET', /^\/__mock\/stats$/)) return send(res, 200, Object.assign({}, W.stats, { shutdownPending: !!W.shutdownTimer }));
  if (m('POST', /^\/__mock\/kill$/)) { send(res, 200, { ok: true }); setTimeout(() => { W.dead = true; }, 20); return; }
  if (m('POST', /^\/__mock\/reset$/)) { W = buildWorld(); return send(res, 200, { ok: true }); }
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
