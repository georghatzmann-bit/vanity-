'use strict';
// Spiel-Booster: schließt Hintergrundprogramme aus DEINER Liste mit einem Klick und startet sie danach wieder.
// - Schließen erst normal (wie das X am Fenster, taskkill ohne /F). Sofort beenden nur nach ausdrücklicher Bestätigung.
// - Nie: Windows-Prozesse, Virenschutz, Anti-Cheat, Fortnite, Epic Launcher, HELIX selbst (Schutzliste in booster-logic).
// - Fortnite selbst wird nie verändert (keine Priorität, keine Kerne, nichts).
// - Optional: Energieplan "Höchstleistung" während des Boosts (vorherigen Plan merken und zurückstellen).
// - Optional: automatisch boosten, wenn Fortnite startet, und wiederherstellen, wenn es schließt (aus ab Werk).

const { HelixError, decodeConsole } = require('../../sys/exec');
const logic = require('../../tools/booster-logic');

const ID = 'booster';
const STATE = 'tool-booster';
const MAX_LIST = 50;

let deps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), closeWaitMs: 8000, forceWaitMs: 2000, pollMs: 700 };
let queue = Promise.resolve();
let stateQueue = Promise.resolve();
let disposed = false;
let busy = null; // 'boost' | 'restore' | 'force' während einer Aktion

function isWindows(ctx) {
  return ctx.exec && typeof ctx.exec.IS_WIN === 'boolean' ? ctx.exec.IS_WIN : process.platform === 'win32';
}

function requireWin(ctx) {
  if (!isWindows(ctx)) throw new HelixError('NOT_WINDOWS', 'Der Spiel-Booster schließt Programme über Windows. Das geht nur unter Windows.');
}

/** Aktionen nacheinander ausführen (Klick und Automatik dürfen sich nicht überschneiden). */
function serial(kind, fn) {
  const run = queue.then(async () => {
    busy = kind;
    try { return await fn(); } finally { busy = null; }
  });
  queue = run.catch(() => {});
  return run;
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

// ---------- Zustand ----------

function cleanState(st) {
  const s = st && typeof st === 'object' ? st : {};
  return {
    list: Array.isArray(s.list) ? s.list.filter((e) => e && logic.validName(e.name)) : [],
    options: { powerPlan: !!s.options?.powerPlan, auto: !!s.options?.auto },
    active: s.active && typeof s.active === 'object' ? s.active : null,
    lastReport: s.lastReport || null,
  };
}

async function load(ctx) {
  return cleanState(await ctx.core.readState(STATE, {}).catch(() => ({})));
}

async function save(ctx, st) {
  await ctx.core.writeState(STATE, st);
}

/**
 * Zustand lesen, ändern, speichern – nacheinander und ohne Wartezeit dazwischen.
 * Ein Boost, der auf Programme wartet, schreibt am Ende nur seine eigenen Felder (active, lastReport)
 * über diesen Weg. So gehen Änderungen an Liste und Optionen aus der Zwischenzeit nicht verloren.
 */
function update(ctx, fn) {
  const run = stateQueue.then(async () => {
    const st = await load(ctx);
    const out = await fn(st);
    await save(ctx, st);
    return out;
  });
  stateQueue = run.catch(() => {});
  return run;
}

// ---------- Windows-Aufrufe (alle über ctx.exec, damit Tests sie ersetzen können) ----------

// Fortnite, Anti-Cheat und der Epic Launcher werden nur am Namen erkannt und danach übersprungen –
// kein Pfad, keine Version, kein Fenstertitel, kein Öffnen des Prozesses. Get-Process liefert Name,
// Sitzung und Speicher aus der Prozessliste von Windows, ohne einen Prozess zu öffnen.
const SKIP = logic.untouchablePattern();

const PS_RUNNING = String.raw`
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64({ skip: SKIP })}')) | ConvertFrom-Json
$skip = [string]$cfg.skip
$sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$out = @(Get-Process | Where-Object { $_.SessionId -eq $sid -and $_.ProcessName -notmatch $skip } | ForEach-Object {
  $path = $null; $company = $null; $desc = $null
  try { $path = $_.Path } catch { }
  if ($path) {
    try { $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path); $company = $vi.CompanyName; $desc = $vi.FileDescription } catch { }
  }
  [pscustomobject]@{ Name = [string]$_.ProcessName; Id = [int]$_.Id; Path = [string]$path; MainWindowTitle = [string]$_.MainWindowTitle; Company = [string]$company; Description = [string]$desc; WorkingSet = [double]$_.WorkingSet64 }
})
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;

// Erst die passenden Prozess-Nummern über die Namen finden, dann nur diese einzeln abfragen
// (Pfad und Befehlszeile für den Neustart). Andere Prozesse – vor allem Fortnite – fragt HELIX nicht ab.
function psDetails(names) {
  return String.raw`
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64({ names, skip: SKIP })}')) | ConvertFrom-Json
$set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($n in @($cfg.names)) { [void]$set.Add([string]$n) }
$skip = [string]$cfg.skip
$sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$ids = @(Get-Process | Where-Object { $_.SessionId -eq $sid -and $set.Contains([string]$_.ProcessName) -and $_.ProcessName -notmatch $skip } | ForEach-Object { [int]$_.Id })
$out = @(foreach ($id in $ids) {
  $c = $null
  try { $c = Get-CimInstance -ClassName Win32_Process -Filter "Handle = '$id'" -ErrorAction Stop } catch { }
  foreach ($x in @($c)) {
    if ($null -eq $x) { continue }
    [pscustomobject]@{ Name = [string]$x.Name; Id = [int]$x.ProcessId; ParentId = [int]$x.ParentProcessId; Path = [string]$x.ExecutablePath; CommandLine = [string]$x.CommandLine }
  }
})
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;
}

function psStart(items) {
  return String.raw`
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64({ items })}')) | ConvertFrom-Json
$out = @(foreach ($x in @($cfg.items)) {
  $ok = $false; $err = $null
  try {
    if (-not (Test-Path -LiteralPath ([string]$x.file) -PathType Leaf)) { throw 'Die Programmdatei gibt es nicht mehr.' }
    $p = @{ FilePath = [string]$x.file; ErrorAction = 'Stop' }
    if ($x.cwd -and (Test-Path -LiteralPath ([string]$x.cwd) -PathType Container)) { $p.WorkingDirectory = [string]$x.cwd }
    if ($x.args) { $p.ArgumentList = [string]$x.args }
    Start-Process @p
    $ok = $true
  } catch { $err = [string]$_.Exception.Message }
  [pscustomobject]@{ key = [string]$x.key; ok = $ok; error = $err }
})
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;
}

/**
 * Laufende Prozesse (tasklist, schnell): Map pid -> normalisierter Name.
 * Nur die Windows-Sitzung von HELIX – Dienste und andere Benutzerkonten am selben PC zählen nicht.
 */
async function snapshot(ctx) {
  // tasklist schreibt in der Konsolen-Codepage (deutsch 850) – Umlaute in Programmnamen sonst kaputt
  const out = decodeConsole(await ctx.exec.run('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 10000, encoding: 'buffer' }));
  return new Map(logic.ownSession(logic.parseTasklistSessions(out)).map((p) => [p.pid, logic.normalizeName(p.name)]));
}

async function details(ctx, names) {
  if (!names.length) return [];
  return logic.asArray(await ctx.exec.powershell(psDetails(names), { json: true, timeout: 30000 }));
}

/**
 * Laufende Prozesse dieser Programme in der eigenen Windows-Sitzung: Map pid -> Name.
 * Gleiche Abfrage wie beim Boost (CIM, nach Sitzung gefiltert); klappt sie nicht, tasklist (auch nur eigene Sitzung).
 */
async function ownPids(ctx, names) {
  let rows;
  try {
    rows = (await details(ctx, names)).map((p) => [Number(p.Id), logic.normalizeName(p.Name)]);
  } catch (e) {
    ctx.log?.('warn', 'booster: Prozessdetails', e && e.message);
    rows = [...(await snapshot(ctx))];
  }
  return new Map(rows.filter(([pid, n]) => names.includes(n) && Number.isInteger(pid) && pid > 4 && pid !== process.pid));
}

async function closePids(ctx, pids, force) {
  const safe = pids.filter((p) => Number.isInteger(p) && p > 4 && p !== process.pid);
  if (safe.length) await ctx.processes.closeByPid(safe, { force: !!force }, ctx.exec.run);
}

/** Wartet, bis die Prozesse weg sind. Rückgabe: Set der PIDs, die noch laufen. */
async function waitGone(ctx, expect, maxMs) {
  // expect: Map pid -> name (gleicher Name schützt vor wiederverwendeten PIDs)
  const check = async () => {
    const snap = await snapshot(ctx);
    return new Set([...expect].filter(([pid, name]) => snap.get(pid) === name).map(([pid]) => pid));
  };
  let alive = await check();
  const until = Date.now() + maxMs;
  while (alive.size && Date.now() < until) {
    await deps.sleep(deps.pollMs);
    alive = await check();
  }
  return alive;
}

async function powercfg(ctx, args) {
  const out = await ctx.exec.run('powercfg.exe', args, { timeout: 10000, encoding: 'buffer' });
  return logic.decodeConsole(out);
}

async function readPlans(ctx) {
  const plans = logic.parsePowercfgList(await powercfg(ctx, ['/list']));
  let active = plans.find((p) => p.active) || null;
  if (!active) {
    const guid = logic.parseActiveScheme(await powercfg(ctx, ['/getactivescheme']));
    active = plans.find((p) => p.guid === guid) || (guid ? { guid, name: '', active: true } : null);
  }
  return { plans, active };
}

/** Schaltet auf "Höchstleistung". Rückgabe: Merkzettel für das Zurückstellen oder null. */
async function switchToHigh(ctx, report) {
  try {
    const { plans, active } = await readPlans(ctx);
    const target = logic.chooseHighPlan(plans);
    if (!target) {
      report.powerPlan = { changed: false, missing: true, text: 'Den Energieplan „Höchstleistung“ gibt es auf diesem PC nicht (bei vielen Laptops ausgeblendet). Nichts verändert.' };
      return null;
    }
    if (active && (active.guid === target.guid || logic.isHighPlan(active))) {
      // auch "Ultimative Leistung" zählt – nie auf einen schwächeren Plan herunterschalten
      report.powerPlan = { changed: false, already: true, text: `Der Energieplan „${logic.planLabel(active)}“ war schon aktiv.` };
      return null;
    }
    if (!logic.validGuid(target.guid)) throw new Error('GUID');
    await powercfg(ctx, ['/setactive', target.guid]);
    const now = logic.parseActiveScheme(await powercfg(ctx, ['/getactivescheme']));
    if (now !== target.guid) throw new Error('nicht übernommen');
    report.powerPlan = { changed: true, from: logic.planLabel(active), to: logic.planLabel(target), text: `Energieplan von „${logic.planLabel(active)}“ auf „${logic.planLabel(target)}“ gestellt.` };
    return { before: active ? active.guid : null, beforeName: logic.planLabel(active), set: target.guid, setName: logic.planLabel(target) };
  } catch (e) {
    ctx.log?.('warn', 'booster: Energieplan', e && e.message);
    report.powerPlan = { changed: false, error: true, text: 'Windows hat den Energieplan nicht gewechselt (vielleicht vom Administrator gesperrt). Du kannst ihn in den Windows-Einstellungen unter „Energie“ selbst ändern.' };
    return null;
  }
}

async function restorePlan(ctx, memo, report) {
  if (!memo || !memo.before || !logic.validGuid(memo.before)) return;
  try {
    const { plans, active } = await readPlans(ctx);
    if (active && memo.set && active.guid !== memo.set) {
      report.powerPlan = { changed: false, text: 'Der Energieplan wurde in der Zwischenzeit geändert – HELIX lässt ihn so.' };
      return;
    }
    if (!plans.some((p) => p.guid === memo.before)) {
      report.powerPlan = { changed: false, error: true, text: `Den vorherigen Energieplan „${memo.beforeName}“ gibt es nicht mehr.` };
      return;
    }
    await powercfg(ctx, ['/setactive', memo.before]);
    report.powerPlan = { changed: true, to: memo.beforeName, text: `Energieplan zurück auf „${memo.beforeName}“.` };
  } catch (e) {
    ctx.log?.('warn', 'booster: Energieplan zurück', e && e.message);
    report.powerPlan = { changed: false, error: true, text: `Der Energieplan konnte nicht zurückgestellt werden. Stelle „${memo.beforeName}“ in den Windows-Einstellungen unter „Energie“ selbst ein.` };
  }
}

// ---------- Abläufe ----------

const entryOf = (st, name) => st.list.find((e) => e.name === name);
const displayOf = (st, name) => entryOf(st, name)?.display || name;

async function doBoost(ctx, { trigger = 'manual' } = {}) {
  requireWin(ctx);
  return serial('boost', async () => {
    const st = await load(ctx);
    const names = st.list.map((e) => e.name).filter((n) => !logic.isBlocked(n));
    if (!names.length && !st.options.powerPlan) {
      throw new HelixError('EMPTY_LIST', 'Deine Liste ist leer. Füge zuerst Programme hinzu, die beim Spielen zu sein sollen.');
    }
    const now = Date.now();
    const report = { kind: 'boost', at: now, trigger, closed: [], stillOpen: [], notRunning: [], failed: [], powerPlan: null };
    const procs = (await details(ctx, names)).filter((p) => names.includes(logic.normalizeName(p.Name)) && !logic.isBlocked(p.Name));
    const active = st.active || { startedAt: now, trigger, apps: [], powerPlan: null };
    const targets = [];
    for (const name of names) {
      const mine = procs.filter((p) => logic.normalizeName(p.Name) === name && Number(p.Id) > 4 && Number(p.Id) !== process.pid);
      if (!mine.length) {
        const prev = active.apps.find((a) => a.name === name);
        if (prev?.status === 'open') Object.assign(prev, { status: 'closed', openPids: [], closedAt: now }); // inzwischen selbst beendet
        else if (!prev) report.notRunning.push(displayOf(st, name)); // schon von diesem Boost geschlossen: nicht als "lief nicht" melden
        continue;
      }
      targets.push({ name, pids: mine.map((p) => Number(p.Id)), instances: logic.pickRoots(mine) });
    }
    const expect = new Map(targets.flatMap((t) => t.pids.map((pid) => [pid, t.name])));
    let alive = new Set();
    if (expect.size) {
      await closePids(ctx, [...expect.keys()], false); // normal schließen, nie /F
      alive = await waitGone(ctx, expect, deps.closeWaitMs);
    }
    for (const t of targets) {
      const open = t.pids.filter((p) => alive.has(p));
      const prev = active.apps.find((a) => a.name === t.name);
      const app = {
        name: t.name,
        display: displayOf(st, t.name),
        instances: prev?.instances?.length ? prev.instances : t.instances,
        status: open.length ? 'open' : 'closed',
        openPids: open,
        closedAt: open.length ? (prev?.closedAt || null) : now,
      };
      if (prev) Object.assign(prev, app); else active.apps.push(app);
    }
    if (st.options.powerPlan && !active.powerPlan) active.powerPlan = await switchToHigh(ctx, report);
    // Bericht über den ganzen Boost – auch nach "Erneut boosten" stehen die schon geschlossenen Programme drin
    const byStatus = (s) => active.apps.filter((a) => a.status === s).map((a) => a.display);
    report.closed = byStatus('closed');
    report.forced = byStatus('forced');
    report.stillOpen = byStatus('open');
    if (!report.powerPlan && st.active && st.lastReport?.kind === 'boost') report.powerPlan = st.lastReport.powerPlan || null;
    const next = active.apps.length > 0 || !!active.powerPlan ? active : null;
    await update(ctx, (fresh) => { fresh.active = next; fresh.lastReport = report; });
    ctx.emit?.('booster.state', { active: !!next });
    return { report, active: next };
  });
}

async function doForce(ctx, { names, confirm } = {}) {
  requireWin(ctx);
  if (confirm !== true) throw new HelixError('CONFIRM_NEEDED', 'Sofort beenden geht nur nach deiner ausdrücklichen Bestätigung.');
  return serial('force', async () => {
    const st = await load(ctx);
    if (!st.active) throw new HelixError('NOT_ACTIVE', 'Es läuft gerade kein Boost.');
    const want = Array.isArray(names) && names.length ? new Set(names.map(logic.normalizeName)) : null;
    const apps = st.active.apps.filter((a) => a.status === 'open' && (!want || want.has(a.name)) && !logic.isBlocked(a.name));
    const report = { kind: 'force', at: Date.now(), trigger: 'manual', forced: [], stillOpen: [], failed: [] };
    if (!apps.length) return { report, active: st.active, nothing: true };
    // Wie beim Boost nur die eigene Windows-Sitzung – nie Dienste oder Programme anderer Benutzerkonten
    const expect = await ownPids(ctx, apps.map((a) => a.name));
    if (expect.size) {
      await closePids(ctx, [...expect.keys()], true);
      await deps.sleep(300);
    }
    const alive = expect.size ? await waitGone(ctx, expect, deps.forceWaitMs) : new Set();
    const aliveNames = new Set([...alive].map((pid) => expect.get(pid)));
    for (const a of apps) {
      if (aliveNames.has(a.name)) { report.stillOpen.push(a.display); a.openPids = [...alive].filter((p) => expect.get(p) === a.name); continue; }
      a.status = 'forced';
      a.openPids = [];
      a.closedAt = Date.now();
      report.forced.push(a.display);
    }
    const last = st.lastReport && st.lastReport.kind === 'boost' ? st.lastReport : { kind: 'boost', at: report.at, trigger: 'manual', closed: [], stillOpen: [], notRunning: [], failed: [] };
    last.stillOpen = (last.stillOpen || []).filter((d) => !report.forced.includes(d));
    last.forced = [...new Set([...(last.forced || []), ...report.forced])];
    await update(ctx, (fresh) => { fresh.active = st.active; fresh.lastReport = last; });
    ctx.emit?.('booster.state', { active: true });
    return { report, active: st.active };
  });
}

async function doRestore(ctx, { trigger = 'manual' } = {}) {
  requireWin(ctx);
  return serial('restore', async () => {
    const st = await load(ctx);
    if (!st.active) return { nothing: true, report: null };
    const report = { kind: 'restore', at: Date.now(), trigger, restarted: [], alreadyRunning: [], failed: [], untouched: [], powerPlan: null };
    // Läuft es schon wieder? Nur die eigene Windows-Sitzung zählt (Discord eines anderen Benutzerkontos nicht)
    const check = (st.active.apps || []).filter((a) => a.status !== 'open' && !logic.isBlocked(a.name)).map((a) => a.name);
    const runningNames = new Set((await ownPids(ctx, check)).values());
    const items = [];
    const keyToApp = new Map();
    for (const a of st.active.apps || []) {
      if (a.status === 'open') { report.untouched.push(a.display); continue; }
      if (logic.isBlocked(a.name)) continue;
      if (runningNames.has(a.name)) { report.alreadyRunning.push(a.display); continue; }
      const inst = (a.instances || []).filter((i) => logic.validExePath(i.path) && logic.normalizeName(i.path) === a.name);
      if (!inst.length) { report.failed.push({ display: a.display, reason: 'Der Speicherort war nicht lesbar. Bitte selbst starten.' }); continue; }
      inst.forEach((i, k) => {
        const key = `${a.name}#${k}`;
        keyToApp.set(key, a);
        items.push({ key, file: i.path, args: String(i.args || '').replace(/[\r\n]/g, ' ').slice(0, 4000), cwd: i.cwd || '' });
      });
    }
    if (items.length) {
      let res = [];
      try {
        res = logic.asArray(await ctx.exec.powershell(psStart(items), { json: true, timeout: 45000 }));
      } catch (e) {
        ctx.log?.('warn', 'booster: Neustart', e && e.message);
        res = items.map((i) => ({ key: i.key, ok: false, error: 'Windows hat das Programm nicht gestartet.' }));
      }
      const done = new Set();
      for (const r of res) {
        const a = keyToApp.get(r.key);
        if (!a || done.has(a.name)) continue;
        if (r.ok) { report.restarted.push(a.display); done.add(a.name); }
      }
      for (const a of new Set(keyToApp.values())) {
        if (done.has(a.name)) continue;
        const err = res.find((r) => keyToApp.get(r.key) === a && r.error);
        report.failed.push({ display: a.display, reason: err?.error ? String(err.error).slice(0, 200) : 'Start nicht möglich.' });
      }
    }
    if (st.active.powerPlan) await restorePlan(ctx, st.active.powerPlan, report);
    await update(ctx, (fresh) => { fresh.active = null; fresh.lastReport = report; });
    ctx.emit?.('booster.state', { active: false });
    return { report, active: null };
  });
}

// ---------- Automatik ----------

async function onFortnite(ctx, running) {
  if (disposed || !isWindows(ctx)) return;
  try {
    const st = await load(ctx);
    if (!st.options.auto) return;
    if (running && !st.active && (st.list.length || st.options.powerPlan)) {
      const r = await doBoost(ctx, { trigger: 'auto' });
      ctx.log?.('info', 'booster: automatisch gestartet', JSON.stringify({ closed: r.report.closed.length }));
    } else if (!running && st.active) {
      await doRestore(ctx, { trigger: 'auto' });
      ctx.log?.('info', 'booster: automatisch wiederhergestellt');
    }
  } catch (e) {
    ctx.log?.('warn', 'booster: Automatik', e && e.message);
  }
}

// ---------- Öffentliche Daten ----------

async function publicInfo(ctx) {
  const st = await load(ctx);
  const win = isWindows(ctx);
  let runningNames = null;
  if (win) {
    try { runningNames = new Set((await snapshot(ctx)).values()); } catch { runningNames = null; }
  }
  let power = null;
  if (win) {
    try {
      const { plans, active } = await readPlans(ctx);
      const high = logic.chooseHighPlan(plans);
      power = { active: logic.planLabel(active), highAvailable: !!high, highName: high ? logic.planLabel(high) : null };
    } catch { power = null; }
  }
  const activeApps = new Map((st.active?.apps || []).map((a) => [a.name, a]));
  return {
    supported: win,
    busy,
    list: st.list.map((e) => {
      const a = activeApps.get(e.name);
      return {
        name: e.name,
        display: e.display,
        path: e.path || null,
        protect: logic.classify(e.name),
        running: runningNames ? runningNames.has(e.name) : null,
        boost: a ? a.status : null,
      };
    }),
    options: st.options,
    active: st.active ? {
      startedAt: st.active.startedAt,
      trigger: st.active.trigger,
      apps: st.active.apps.map((a) => ({ name: a.name, display: a.display, status: a.status, restartable: (a.instances || []).length > 0 })),
      powerPlan: st.active.powerPlan ? { beforeName: st.active.powerPlan.beforeName, setName: st.active.powerPlan.setName } : null,
    } : null,
    lastReport: st.lastReport,
    power,
  };
}

module.exports = {
  id: ID,
  init(ctx) {
    disposed = false;
    ctx.core?.onFortniteState?.((running) => { onFortnite(ctx, running); });
  },
  dispose() { disposed = true; },
  handlers: {
    async summary(_a, ctx) {
      if (!isWindows(ctx)) return null;
      return { text: logic.summaryText(await load(ctx)) };
    },

    info: (_a, ctx) => publicInfo(ctx),

    /** Laufende Programme zum Auswählen (ohne Windows-Interna). */
    async running(_a, ctx) {
      if (!isWindows(ctx)) return { unsupported: true, processes: [] };
      const st = await load(ctx);
      const raw = await ctx.exec.powershell(PS_RUNNING, { json: true, timeout: 30000 });
      const processes = logic.groupRunning(raw, { listNames: st.list.map((e) => e.name) })
        .map(({ pids, ...p }) => ({ ...p, count: pids.length }));
      return { unsupported: false, processes };
    },

    /** Programm in die Liste aufnehmen. Geschützte nie; Treiber-Helfer nur mit confirm:true. */
    async add(a, ctx) {
      const raw = String(a.name ?? '').trim();
      if (!raw || !logic.validName(raw)) throw new HelixError('BAD_ARG', 'Bitte gib den Namen der Programmdatei ein, zum Beispiel „Discord.exe“.');
      const name = logic.normalizeName(raw);
      const display = logic.cleanDisplay(a.display || raw.split(/[\\/]/).pop(), name);
      const protect = logic.classify(name);
      if (protect?.level === 'block') throw new HelixError('PROTECTED', `„${display}“ ist geschützt: ${protect.reason}`, { kind: protect.kind });
      if (protect?.level === 'warn' && a.confirm !== true) throw new HelixError('CONFIRM_NEEDED', protect.reason, { kind: protect.kind, display });
      const added = await update(ctx, (st) => {
        if (st.list.some((e) => e.name === name)) return false;
        if (st.list.length >= MAX_LIST) throw new HelixError('LIST_FULL', `Die Liste ist voll (${MAX_LIST} Programme).`);
        st.list.push({ name, display, path: logic.validExePath(a.path) ? String(a.path) : null, addedAt: Date.now(), warn: protect ? protect.kind : null });
        return true;
      });
      if (!added) return { added: false, already: true, info: await publicInfo(ctx) };
      return { added: true, display, info: await publicInfo(ctx) };
    },

    async remove(a, ctx) {
      const name = logic.normalizeName(a.name);
      const removed = await update(ctx, (st) => {
        const before = st.list.length;
        st.list = st.list.filter((e) => e.name !== name);
        return st.list.length < before;
      });
      return { removed, info: await publicInfo(ctx) };
    },

    async setOptions(a, ctx) {
      const options = await update(ctx, (st) => {
        if (typeof a.powerPlan === 'boolean') st.options.powerPlan = a.powerPlan;
        if (typeof a.auto === 'boolean') st.options.auto = a.auto;
        return { ...st.options };
      });
      return { options };
    },

    boost: (_a, ctx) => doBoost(ctx, { trigger: 'manual' }),
    forceClose: (a, ctx) => doForce(ctx, a || {}),
    restore: (_a, ctx) => doRestore(ctx, { trigger: 'manual' }),
  },
  _test: {
    PS_RUNNING, psDetails, psStart, onFortnite,
    setDeps(d) { deps = { ...deps, ...d }; },
    reset() { queue = Promise.resolve(); stateQueue = Promise.resolve(); disposed = false; busy = null; },
  },
};
