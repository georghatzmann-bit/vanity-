'use strict';
// Installed programs from the Uninstall registry keys (HKLM 64/32-bit + HKCU).
const { runPsJson } = require('../util/ps');

const UNINSTALL_PS = `
$roots = @(
  'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
$list = New-Object System.Collections.ArrayList
foreach ($r in $roots) {
  if (-not (Test-Path -LiteralPath $r)) { continue }
  foreach ($k in Get-ChildItem -LiteralPath $r -ErrorAction SilentlyContinue) {
    $p = $null
    try { $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction Stop } catch { continue }
    if (-not $p.DisplayName) { continue }
    [void]$list.Add([pscustomobject]@{
      name = [string]$p.DisplayName
      version = [string]$p.DisplayVersion
      publisher = [string]$p.Publisher
      installLocation = [string]$p.InstallLocation
      displayIcon = [string]$p.DisplayIcon
      systemComponent = [int]($p.SystemComponent -as [int])
      releaseType = [string]$p.ReleaseType
      parentKeyName = [string]$p.ParentKeyName
      windowsInstaller = [int]($p.WindowsInstaller -as [int])
      estimatedSize = [double]($p.EstimatedSize -as [double])
      keyName = [string]$k.PSChildName
      hive = $(if ($r -like '*HKEY_CURRENT_USER*') { 'HKCU' } else { 'HKLM' })
    })
  }
}
Write-PhxJson @($list)
`;

// Names that are drivers, runtimes, updates or OS parts – not worth listing as "unmatched".
const NOISE = [
  /^KB\d{6,}/i,
  /^(Security )?Update for /i,
  /^Hotfix/i,
  /Microsoft Visual C\+\+ \d{4}.*(Redistributable|Runtime)/i,
  /Microsoft \.NET( Core| Framework)?.*(Runtime|SDK|Targeting|Host|Templates|Toolset)/i,
  /Windows (SDK|Software Development Kit|Driver Kit)/i,
  /^Microsoft Edge( Update| WebView2)?/i,
  /^Microsoft Update Health Tools/i,
  /^Update for Windows/i,
  /^Windows PC Health Check/i,
  /^Microsoft (Windows Desktop Runtime|ASP\.NET Core)/i,
  /\bDriver\b/i,
  /^(NVIDIA|Realtek|Intel\(R\)|AMD) .*(Driver|Audio|Chipset|Management Engine|PhysX|HD Audio|Container|Backend|Telemetry|FrameView)/i,
  /^Vulkan Run ?Time/i,
  /^DirectX/i,
  /^Microsoft GameInput/i,
  /^Teams Machine-Wide Installer/i,
  /^Office 16 Click-to-Run/i,
  /^Epic Online Services/i,
  /^Epic Games Launcher Prerequisites/i,
  /^Steamworks Common/i,
  /^Python \d.*(Launcher|Core Interpreter|Standard Library|Executables|Development Libraries|pip Bootstrap|Tcl\/Tk|Documentation|Test Suite|Utility Scripts|Add to Path)/i,
];

/** PURE: drops system components, updates and noise; dedupes by name. */
function filterEntries(entries) {
  const seen = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.name) continue;
    const name = String(e.name).trim();
    if (!name) continue;
    if (Number(e.systemComponent) === 1) continue;
    if (e.parentKeyName) continue;
    if (/update|hotfix/i.test(e.releaseType || '')) continue;
    if (NOISE.some((re) => re.test(name))) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, { ...e, name });
  }
  return [...seen.values()];
}

/** Strips a trailing ",0" icon index and quotes from DisplayIcon values. */
function iconPath(displayIcon) {
  if (!displayIcon) return null;
  const p = String(displayIcon).trim().replace(/^"(.*)"(,-?\d+)?$/, '$1').replace(/,-?\d+$/, '').replace(/^"|"$/g, '');
  return /\.(exe|ico|dll)$/i.test(p) ? p : null;
}

/** Normalises a product name for fuzzy matching against winget ids/names. */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(x64|x86|64-bit|32-bit|version|v?\d+(\.\d+)+)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

async function readUninstallEntries() {
  const raw = await runPsJson(UNINSTALL_PS, { timeoutMs: 60000 });
  return filterEntries(Array.isArray(raw) ? raw : [raw]);
}

module.exports = { readUninstallEntries, filterEntries, iconPath, normName, NOISE };
