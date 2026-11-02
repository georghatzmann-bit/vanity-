'use strict';
// Windows settings + monitors: capture for the backup, apply after the reset. Runs in the UI
// process (current user, not elevated): everything here is per-user (HKCU) or allowed for users.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPsJson } = require('../util/ps');
const log = require('../log');
const prefs = require('./prefs');
const displays = require('./displays');

const SETTINGS_PS = `
$src = @'
using System;
using System.Runtime.InteropServices;
public static class PhxSys {
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)] static extern bool SpiArr(uint a, uint b, int[] c, uint d);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)] static extern bool SpiPtr(uint a, uint b, IntPtr c, uint d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr w, string l, uint flags, uint timeout, out UIntPtr result);
  public static bool Mouse(int[] v) { return SpiArr(0x0004, 0, v, 3); }
  public static bool Speed(int s) { return SpiPtr(0x0071, 0, new IntPtr(s), 3); }
  public static void Broadcast() {
    UIntPtr r;
    foreach (string s in new string[] { "ImmersiveColorSet", "TraySettings", "WindowsThemeElement", "Policy" }) {
      SendMessageTimeout(new IntPtr(0xffff), 0x1A, UIntPtr.Zero, s, 2, 1000, out r);
    }
  }
}
'@
$GUID_RE = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
$DPI_BASE = 'HKCU:\\Control Panel\\Desktop\\PerMonitorSettings'
$cfg = Get-Content -Raw -LiteralPath $env:PHX_JSON_FILE | ConvertFrom-Json

function Set-PhxPower([string]$plan) {
  $map = @{ balanced = '381b4222-f694-41f0-9685-ff5bb260df2e'; high = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'; ultimate = 'e9a42b02-d5df-448d-aa00-03f14749eb61' }
  $base = $map[$plan]
  if (-not $base) { throw 'Unbekannter Energiesparplan.' }
  try { & powercfg /setactive $base | Out-Null } catch { }
  if ($LASTEXITCODE -eq 0) { return }
  $guid = $null
  if ($plan -eq 'ultimate') {
    foreach ($l in @(& powercfg /list)) { if ($l -match 'Ultimat' -and $l -match $GUID_RE) { $guid = $Matches[1] } }
  }
  if (-not $guid) {
    $dup = (@(& powercfg -duplicatescheme $base) -join ' ')
    if ($dup -match $GUID_RE) { $guid = $Matches[1] }
  }
  if (-not $guid) { throw 'Dieser Energiesparplan ist auf diesem PC nicht verfuegbar.' }
  try { & powercfg /setactive $guid | Out-Null } catch { }
  if ($LASTEXITCODE -ne 0) { throw 'Energiesparplan konnte nicht aktiviert werden.' }
}

if ($env:PHX_MODE -eq 'read') {
  $values = @{}
  foreach ($r in @($cfg.reads)) {
    try {
      $v = (Get-ItemProperty -LiteralPath $r.path -Name $r.name -ErrorAction Stop).($r.name)
      $values[[string]$r.key] = $v
    } catch { }
  }
  $guid = ''
  $pname = ''
  try {
    $line = (@(& powercfg /getactivescheme) -join ' ')
    if ($line -match $GUID_RE) { $guid = $Matches[1] }
    if ($line -match '\\((.+)\\)') { $pname = $Matches[1] }
  } catch { }
  $tz = ''
  try { $tz = (Get-TimeZone).Id } catch { }
  $dpi = @()
  try {
    foreach ($k in @(Get-ChildItem -LiteralPath $DPI_BASE -ErrorAction Stop)) {
      $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
      if ($p -and $null -ne $p.DpiValue) { $dpi += [pscustomobject]@{ key = [string]$k.PSChildName; value = [int64]$p.DpiValue } }
    }
  } catch { }
  Write-PhxJson @{ values = $values; powerGuid = $guid; powerName = $pname; timezone = $tz; dpi = @($dpi) }
} else {
  Add-Type -TypeDefinition $src -Language CSharp
  $results = @()
  foreach ($g in @($cfg.groups)) {
    $err = ''
    try {
      foreach ($w in @($g.writes)) {
        if (-not (Test-Path -LiteralPath $w.path)) { New-Item -Path $w.path -Force | Out-Null }
        if ($w.type -eq 'DWord') { New-ItemProperty -LiteralPath $w.path -Name $w.name -Value ([int]$w.value) -PropertyType DWord -Force | Out-Null }
        else { New-ItemProperty -LiteralPath $w.path -Name $w.name -Value ([string]$w.value) -PropertyType String -Force | Out-Null }
      }
      $s = $g.special
      if ($s) {
        if ($null -ne $s.mouseAccel) {
          if ($s.mouseAccel) { $a = [int[]](6, 10, 1) } else { $a = [int[]](0, 0, 0) }
          if (-not [PhxSys]::Mouse($a)) { throw 'Mauseinstellung wurde abgelehnt.' }
        }
        if ($null -ne $s.mouseSpeed) { if (-not [PhxSys]::Speed([int]$s.mouseSpeed)) { throw 'Mausgeschwindigkeit wurde abgelehnt.' } }
        if ($s.power) { Set-PhxPower ([string]$s.power) }
        if ($s.timezone) { Set-TimeZone -Id ([string]$s.timezone) }
        if ($s.dpi) {
          foreach ($d in @($s.dpi)) {
            $p = Join-Path $DPI_BASE ([string]$d.key)
            if (-not (Test-Path -LiteralPath $p)) { New-Item -Path $p -Force | Out-Null }
            New-ItemProperty -LiteralPath $p -Name DpiValue -Value ([int]$d.value) -PropertyType DWord -Force | Out-Null
          }
        }
      }
    } catch { $err = $_.Exception.Message }
    $results += [pscustomobject]@{ id = [string]$g.id; ok = ($err -eq ''); error = $err }
  }
  try { [PhxSys]::Broadcast() } catch { }
  Write-PhxJson @{ results = @($results) }
}
`;

const asciiJson = (v) => JSON.stringify(v).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function run(script, mode, payload, timeoutMs = 60000) {
  const dir = path.join(os.tmpdir(), 'phoenix');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cfg-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, asciiJson(payload || {}), 'ascii');
  try {
    return await runPsJson(script, { env: { PHX_MODE: mode, PHX_JSON_FILE: file }, timeoutMs });
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

async function listDisplays() {
  return displays.normalizeCurrent(await run(displays.DISPLAYS_PS, 'list', {}));
}

/** Everything a backup stores besides the apps. Each part may fail on its own. */
async function capture() {
  const [mon, raw] = await Promise.allSettled([listDisplays(), run(SETTINGS_PS, 'read', { reads: prefs.readList() })]);
  if (mon.status === 'rejected') log.warn('Monitore lesen fehlgeschlagen:', mon.reason && mon.reason.message);
  if (raw.status === 'rejected') log.warn('Einstellungen lesen fehlgeschlagen:', raw.reason && raw.reason.message);
  const { prefs: p, dpi } = raw.status === 'fulfilled' ? prefs.fromRaw(raw.value) : { prefs: {}, dpi: [] };
  return { displays: mon.status === 'fulfilled' ? mon.value.map(displays.toEntry) : [], prefs: p, dpi };
}

async function suggestDisplays(opts = {}) {
  const current = await listDisplays();
  return { entries: displays.suggest(current, { saved: opts.saved, maximize: !!opts.maximize }) };
}

/** Applies monitor entries. Returns the previous state so the UI can revert ("Behalten?"). */
async function applyDisplays(entries) {
  const current = await listDisplays();
  const previous = current.map((d) => ({ device: d.device, width: d.width, height: d.height, hz: d.hz, rotation: d.rotation, x: d.x, y: d.y, primary: d.primary }));
  const cmds = displays.plan(Array.isArray(entries) ? entries : [], current);
  if (!cmds.length) throw new Error('Keine passenden Monitore gefunden.');
  log.info('Monitore anwenden:', JSON.stringify(cmds));
  const res = await run(displays.DISPLAYS_PS, 'apply', { displays: cmds });
  const failed = (res.test || []).find((t) => t.code !== 0) || (res.results || []).find((r) => r.code !== 0 && r.code !== 1);
  const restart = (res.results || []).some((r) => r.code === 1) || res.final === 1;
  if (failed) {
    log.warn('Monitore: ', JSON.stringify(res));
    return { ok: false, error: `${failed.device}: ${displays.codeText(failed.code)}`, previous };
  }
  if (res.final !== null && res.final !== 0 && res.final !== 1) return { ok: false, error: displays.codeText(res.final), previous };
  return { ok: true, restart, previous };
}

async function applyPrefs(values, dpi) {
  const groups = prefs.toGroups(values, dpi);
  if (!groups.length) return { results: [] };
  log.info('Einstellungen anwenden:', groups.map((g) => g.id).join(', '));
  const res = await run(SETTINGS_PS, 'apply', { groups }, 120000);
  for (const r of res.results || []) if (!r.ok) log.warn(`Einstellung ${r.id}: ${r.error}`);
  return { results: res.results || [] };
}

module.exports = { SETTINGS_PS, capture, listDisplays, suggestDisplays, applyDisplays, applyPrefs, defs: prefs.publicDefs };
