'use strict';
// MachineInfo via Get-CimInstance (wmic is gone on Windows 11 24H2+).
const os = require('os');
const { runPsJson } = require('../util/ps');
const log = require('../log');

const HW_PS = `
$o = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction SilentlyContinue
$c = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
$g = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Name })
$cv = Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue
Write-PhxJson @{
  caption = [string]$o.Caption
  version = [string]$o.Version
  build = [string]$o.BuildNumber
  displayVersion = [string]$cv.DisplayVersion
  ubr = [string]$cv.UBR
  ramBytes = [double]$o.TotalVisibleMemorySize * 1024
  cpu = [string]$c.Name
  gpus = $g
}
`;

function vendorOf(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('nvidia') || n.includes('geforce') || n.includes('quadro') || n.includes('rtx')) return 'nvidia';
  if (n.includes('amd') || n.includes('radeon')) return 'amd';
  if (n.includes('intel')) return 'intel';
  return 'other';
}

/** Cleans up "Microsoft Windows 11 Pro" -> "Windows 11 Pro". Build >= 22000 means Windows 11 even if caption lags. */
function prettyCaption(caption, build) {
  let c = String(caption || '').replace(/^Microsoft\s+/i, '').trim();
  if (Number(build) >= 22000) c = c.replace(/Windows 10/i, 'Windows 11');
  return c || 'Windows';
}

let cached = null;

async function getMachineInfo() {
  if (cached) return cached;
  const base = {
    hostname: os.hostname(),
    user: os.userInfo().username,
    os: { caption: 'Windows', version: os.release(), build: '', displayVersion: '' },
    cpu: (os.cpus()[0] && os.cpus()[0].model.trim()) || '',
    ramGB: Math.round(os.totalmem() / 1024 ** 3),
    gpus: [],
  };
  try {
    const hw = await runPsJson(HW_PS, { timeoutMs: 30000 });
    base.os = {
      caption: prettyCaption(hw.caption, hw.build),
      version: hw.version || base.os.version,
      build: hw.ubr ? `${hw.build}.${hw.ubr}` : String(hw.build || ''),
      displayVersion: hw.displayVersion || '',
    };
    if (hw.cpu) base.cpu = hw.cpu.replace(/\s+/g, ' ').trim();
    if (hw.ramBytes > 0) base.ramGB = Math.round(hw.ramBytes / 1024 ** 3);
    base.gpus = (Array.isArray(hw.gpus) ? hw.gpus : [hw.gpus])
      .filter(Boolean)
      .map((name) => ({ name: String(name).trim(), vendor: vendorOf(name) }));
  } catch (err) {
    log.warn('Hardware-Info unvollständig', err);
  }
  cached = base;
  return base;
}

module.exports = { getMachineInfo, vendorOf, prettyCaption };
