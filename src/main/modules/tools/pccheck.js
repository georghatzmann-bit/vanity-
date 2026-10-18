'use strict';
// PC-Check & Video-Settings-Finder.
// Liest CPU, Grafikkarte, RAM und Monitor (nur lesend, ohne Administrator) und schlägt
// drei Fortnite-Grafikeinstellungen vor. Geschrieben wird ausschließlich GameUserSettings.ini –
// und nur über ctx.core.applyIniChanges (Backup, Fortnite muss zu sein, Schreibschutz bleibt).

const os = require('node:os');
const { HelixError } = require('../../sys/exec');
const logic = require('../../tools/pccheck-logic');

const ID = 'pccheck';
const STATE = 'tool-pccheck';
const FILE = 'GameUserSettings.ini';

// Ein einziges PowerShell-Skript, Ausgabe als JSON (sprachneutral, auch auf deutschem Windows).
// Nur Get-CimInstance / Get-ChildItem / Get-ItemProperty – es wird nichts verändert.
// Der echte Grafikspeicher steht in der Registrierung (qwMemorySize, 64 Bit); AdapterRAM endet bei 4 GB.
const PS_SCAN = String.raw`
$r = [ordered]@{}
try {
  $r.cpu = @(Get-CimInstance -ClassName Win32_Processor | ForEach-Object {
    [pscustomobject]@{ Name = [string]$_.Name; NumberOfCores = [double]$_.NumberOfCores; NumberOfLogicalProcessors = [double]$_.NumberOfLogicalProcessors; MaxClockSpeed = [double]$_.MaxClockSpeed }
  })
} catch { $r.cpu = @() }
try {
  $r.gpu = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
    $d = $null
    try { if ($_.DriverDate) { $d = ([datetime]$_.DriverDate).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) } } catch { $d = $null }
    [pscustomobject]@{
      Name = [string]$_.Name; DriverVersion = [string]$_.DriverVersion; DriverDate = $d
      AdapterCompatibility = [string]$_.AdapterCompatibility; AdapterRAM = [double]$_.AdapterRAM; PNPDeviceID = [string]$_.PNPDeviceID
      CurrentRefreshRate = [double]$_.CurrentRefreshRate; MaxRefreshRate = [double]$_.MaxRefreshRate
      CurrentHorizontalResolution = [double]$_.CurrentHorizontalResolution; CurrentVerticalResolution = [double]$_.CurrentVerticalResolution
    }
  })
} catch { $r.gpu = @() }
$v = New-Object System.Collections.ArrayList
try {
  $cls = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  foreach ($k in @(Get-ChildItem -Path $cls -ErrorAction SilentlyContinue)) {
    if ($k.PSChildName -notmatch '^\d{4}$') { continue }
    try {
      $p = Get-ItemProperty -Path $k.PSPath -ErrorAction Stop
      $q = $p.'HardwareInformation.qwMemorySize'
      if ($null -eq $q) { $q = $p.'HardwareInformation.MemorySize' }
      if ($q -is [byte[]]) { $b = New-Object byte[] 8; [Array]::Copy($q, $b, [Math]::Min(8, $q.Length)); $q = [BitConverter]::ToUInt64($b, 0) }
      if ($q) { [void]$v.Add([pscustomobject]@{ Name = [string]$p.DriverDesc; MatchingDeviceId = [string]$p.MatchingDeviceId; Bytes = [double]$q }) }
    } catch { }
  }
} catch { }
$r.vram = @($v)
try {
  $r.ram = @(Get-CimInstance -ClassName Win32_PhysicalMemory | ForEach-Object {
    [pscustomobject]@{ Capacity = [double]$_.Capacity; ConfiguredClockSpeed = [double]$_.ConfiguredClockSpeed; Speed = [double]$_.Speed; SMBIOSMemoryType = [double]$_.SMBIOSMemoryType }
  })
} catch { $r.ram = @() }
try {
  $o = Get-CimInstance -ClassName Win32_OperatingSystem
  $r.os = [pscustomobject]@{ Caption = [string]$o.Caption; BuildNumber = [string]$o.BuildNumber; TotalVisibleMemorySize = [double]$o.TotalVisibleMemorySize }
} catch { $r.os = $null }
[pscustomobject]$r | ConvertTo-Json -Compress -Depth 5
`;

let cache = null; // { at, hw } – letzte Messung in diesem Programmlauf

function isWindows(ctx) {
  return ctx.exec && typeof ctx.exec.IS_WIN === 'boolean' ? ctx.exec.IS_WIN : process.platform === 'win32';
}

function readDisplays(ctx) {
  try {
    const screen = ctx.electron?.screen;
    if (!screen) return {};
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return { displays, primaryId: primary ? primary.id : null };
  } catch {
    return {};
  }
}

function nodeInfo(osMod) {
  let cpus = [];
  let totalmem = null;
  try { cpus = osMod.cpus() || []; } catch { /* egal */ }
  try { totalmem = osMod.totalmem(); } catch { /* egal */ }
  return { cpus, totalmem };
}

/** Liest die Hardware. deps.os ist für Tests austauschbar. */
async function runScan(ctx, deps = {}) {
  if (!isWindows(ctx)) {
    return { unsupported: true, message: 'Der PC-Check liest die Hardware über Windows aus. Das geht nur unter Windows.' };
  }
  let ps = null;
  const extraWarnings = [];
  try {
    ps = await ctx.exec.powershell(PS_SCAN, { json: true, timeout: 45000 });
  } catch (e) {
    if (e && e.code === 'NOT_WINDOWS') return { unsupported: true, message: 'Der PC-Check liest die Hardware über Windows aus. Das geht nur unter Windows.' };
    ctx.log?.('warn', 'pccheck: Hardware-Abfrage fehlgeschlagen', e && e.message);
    extraWarnings.push('Windows hat nicht alle Hardware-Daten geliefert. HELIX nutzt, was es selbst sehen kann.');
  }
  const hw = logic.parseHardware(ps, nodeInfo(deps.os || os), readDisplays(ctx));
  hw.warnings = [...extraWarnings, ...hw.warnings];
  return { unsupported: false, at: Date.now(), hw };
}

function publicResult(scan, analysis) {
  const { hw } = scan;
  const strip = (p) => {
    const { items, ...rest } = p;
    return { ...rest, itemCount: items.length };
  };
  return {
    unsupported: false,
    at: scan.at,
    hardware: {
      cpu: { ...hw.cpu, short: hw.cpu.name ? logic.shortCpuName(hw.cpu.name) : null },
      gpu: hw.gpu,
      gpus: hw.gpus,
      ram: hw.ram,
      display: hw.display,
      displays: hw.displays,
      os: hw.os,
    },
    warnings: hw.warnings,
    ratings: analysis.ratings,
    perf: analysis.perf,
    hz: analysis.hz,
    presets: analysis.presets.map(strip),
    recommended: analysis.recommended,
    recommendReason: analysis.recommendReason,
    competitiveTip: analysis.competitiveTip,
  };
}

async function saveScanState(ctx, scan, analysis) {
  try {
    const st = await ctx.core.readState(STATE, {});
    st.lastScan = {
      at: scan.at,
      gpuShort: scan.hw.gpu ? scan.hw.gpu.short : null,
      recommended: analysis.recommended,
      perfClass: analysis.perf.cls,
      hw: scan.hw,
    };
    await ctx.core.writeState(STATE, st);
  } catch (e) {
    ctx.log?.('warn', 'pccheck: Zustand nicht gespeichert', e && e.message);
  }
}

/** Letzte Messung: aus diesem Programmlauf, sonst gespeichert, sonst neu messen. */
async function getHardware(ctx) {
  if (cache) return cache.hw;
  const st = await ctx.core.readState(STATE, {}).catch(() => ({}));
  if (st?.lastScan?.hw) {
    cache = { at: st.lastScan.at, hw: st.lastScan.hw };
    return cache.hw;
  }
  const scan = await runScan(ctx);
  if (scan.unsupported) throw new HelixError('NOT_WINDOWS', scan.message);
  cache = { at: scan.at, hw: scan.hw };
  return scan.hw;
}

function checkArgs(a) {
  const preset = String(a.preset || '');
  if (!logic.PRESET_IDS.includes(preset)) throw new HelixError('BAD_ARG', 'Unbekannter Vorschlag.');
  let fpsCap = null;
  if (a.fpsCap !== undefined && a.fpsCap !== null) {
    fpsCap = Number(a.fpsCap);
    if (!logic.validFpsCap(fpsCap)) throw new HelixError('BAD_ARG', 'Ungültige FPS-Grenze.');
  }
  return { preset, fpsCap };
}

async function presetFor(ctx, a) {
  const { preset, fpsCap } = checkArgs(a);
  const hw = await getHardware(ctx);
  const analysis = logic.analyze(hw, { fpsOverride: fpsCap == null ? {} : { [preset]: fpsCap } });
  return { preset: analysis.presets.find((p) => p.id === preset), analysis };
}

module.exports = {
  id: ID,
  handlers: {
    /** Hardware neu lesen und Vorschläge bauen. */
    async scan(_a, ctx) {
      const scan = await runScan(ctx);
      if (scan.unsupported) return { unsupported: true, message: scan.message };
      cache = { at: scan.at, hw: scan.hw };
      const analysis = logic.analyze(scan.hw);
      await saveScanState(ctx, scan, analysis);
      return publicResult(scan, analysis);
    },

    /** Zeigt Zeile für Zeile, was sich in GameUserSettings.ini ändern würde (Einstellung | jetzt | neu | warum). */
    async preview(a, ctx) {
      const { preset } = await presetFor(ctx, a);
      const pv = await ctx.core.previewIniChanges(FILE, logic.allChanges(preset.items));
      const rows = logic.buildRows(preset.items, pv);
      const fortnite = await ctx.core.fortniteStatus().catch(() => null);
      return {
        preset: preset.id,
        title: preset.title,
        fps: preset.fps,
        est: preset.est,
        rel: pv.rel,
        readOnly: !!pv.readOnly,
        rows,
        counts: { total: rows.length, changed: rows.filter((r) => r.changed).length, same: rows.filter((r) => !r.changed).length },
        fortnite: fortnite ? { running: !!fortnite.running, unsupported: !!fortnite.unsupported, processes: fortnite.processes || [] } : null,
      };
    },

    /** Schreibt den Vorschlag in GameUserSettings.ini – mit Backup, nur wenn Fortnite zu ist. */
    async apply(a, ctx) {
      const { preset } = await presetFor(ctx, a);
      const known = new Set(preset.items.map((i) => i.id));
      const skip = Array.isArray(a.skip) ? a.skip.filter((s) => typeof s === 'string' && known.has(s)) : [];
      const pv = await ctx.core.previewIniChanges(FILE, logic.allChanges(preset.items));
      const changes = logic.changesToWrite(preset.items, pv, skip);
      if (!changes.length) return { preset: preset.id, applied: 0, nothing: true };
      const res = await ctx.core.applyIniChanges(FILE, changes, { reason: 'tool', label: `PC-Check: Vorschlag „${preset.title}“` });
      const count = res.applied.length;
      try {
        const st = await ctx.core.readState(STATE, {});
        st.lastApplied = { at: Date.now(), preset: preset.id, fpsCap: preset.fps.cap, backupId: res.backupId, count };
        await ctx.core.writeState(STATE, st);
      } catch { /* nicht kritisch */ }
      ctx.emit?.('pccheck.applied', { preset: preset.id, count });
      return { preset: preset.id, title: preset.title, applied: count, backupId: res.backupId, rel: res.rel, skipped: skip };
    },

    async summary(_a, ctx) {
      if (!isWindows(ctx)) return null;
      const st = await ctx.core.readState(STATE, {}).catch(() => ({}));
      const text = logic.summaryText(st);
      return { text: text || 'Noch nicht geprüft – zeigt passende Grafik für deinen PC' };
    },
  },
  _test: {
    PS_SCAN, runScan, checkArgs, resetCache: () => { cache = null; },
  },
};
