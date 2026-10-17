'use strict';
// Known folders, drives and the Setup.exe finder.
const fs = require('fs');
const path = require('path');
const { runPsJson } = require('./ps');

function electronPath(name) {
  try {
    return require('electron').app.getPath(name);
  } catch {
    return null;
  }
}

/** Desktop / Documents / Downloads / OneDrive (existing ones only). */
function getKnownFolders() {
  const oneDrive = process.env.OneDriveConsumer || process.env.OneDrive || process.env.OneDriveCommercial || null;
  const folders = {
    desktop: electronPath('desktop'),
    documents: electronPath('documents'),
    downloads: electronPath('downloads'),
    oneDrive: oneDrive && fs.existsSync(oneDrive) ? oneDrive : null,
  };
  return folders;
}

// Many USB SSDs report DriveType 3 (fixed): MSFT_Disk.BusType 7 = USB reveals them.
const DRIVES_PS = `
$sys = $env:SystemDrive
$usb = @{}
try {
  foreach ($part in Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_Partition -ErrorAction Stop) {
    if (-not $part.DriveLetter) { continue }
    $disk = Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_Disk -Filter ('Number = ' + $part.DiskNumber) -ErrorAction SilentlyContinue
    if ($disk -and ([int]$disk.BusType -eq 7 -or [int]$disk.BusType -eq 12)) { $usb[([string]$part.DriveLetter).ToUpper() + ':'] = $true }
  }
} catch { }
$list = @()
foreach ($d in Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction SilentlyContinue) {
  $id = [string]$d.DeviceID
  $list += [pscustomobject]@{
    id = $id
    type = [int]$d.DriveType
    usb = [bool]$usb[$id.ToUpper()]
    label = [string]$d.VolumeName
    free = [double]$d.FreeSpace
    size = [double]$d.Size
    system = ($id -eq $sys)
  }
}
Write-PhxJson @($list)
`;

function kindOf(d) {
  if (d.system) return 'system';
  if (d.type === 2 || d.usb) return 'removable';
  if (d.type === 4) return 'network';
  return 'fixed';
}

/** Drives plus OneDrive (as { root:'onedrive', kind:'cloud', path }) – see listDrives(). */
async function listTargets() {
  const drives = await listDrives();
  const od = getKnownFolders().oneDrive;
  if (od) drives.push({ root: 'onedrive', label: 'OneDrive', kind: 'cloud', path: od, freeBytes: 0, totalBytes: 0 });
  return drives;
}

/** All usable drives: [{ root:'E:\\', label, kind, freeBytes, totalBytes }] */
async function listDrives() {
  try {
    const raw = await runPsJson(DRIVES_PS, { timeoutMs: 20000 });
    return (Array.isArray(raw) ? raw : [raw])
      .filter((d) => d && /^[A-Z]:$/i.test(d.id) && (d.type === 2 || d.type === 3 || d.type === 4) && d.size > 0)
      .map((d) => ({
        root: `${d.id.toUpperCase()}\\`,
        label: d.label || '',
        kind: kindOf(d),
        freeBytes: d.free || 0,
        totalBytes: d.size || 0,
      }));
  } catch {
    // Fallback without PowerShell: probe drive letters.
    const sys = (process.env.SystemDrive || 'C:').toUpperCase();
    const out = [];
    for (let c = 67; c <= 90; c++) {
      const letter = `${String.fromCharCode(c)}:`;
      try {
        fs.accessSync(`${letter}\\`);
        out.push({ root: `${letter}\\`, label: '', kind: letter === sys ? 'system' : 'fixed', freeBytes: 0, totalBytes: 0 });
      } catch {
        /* not present */
      }
    }
    return out;
  }
}

/** Places where profiles are searched (deduped, existing only). */
async function getSearchLocations() {
  const f = getKnownFolders();
  const locs = [];
  const add = (dir, label) => {
    if (dir && fs.existsSync(dir)) locs.push({ dir, label });
  };
  if (process.platform === 'win32') {
    for (const d of await listDrives()) {
      const name = d.kind === 'removable' ? `USB-Stick ${d.root}` : `Laufwerk ${d.root}`;
      add(path.join(d.root, 'Phoenix'), name);
      add(d.root, name);
    }
  }
  add(f.desktop, 'Desktop');
  add(f.downloads, 'Downloads');
  if (f.documents) {
    add(path.join(f.documents, 'Phoenix'), 'Dokumente');
    add(f.documents, 'Dokumente');
  }
  if (f.oneDrive) {
    add(path.join(f.oneDrive, 'Phoenix'), 'OneDrive');
    add(f.oneDrive, 'OneDrive');
  }
  return locs;
}

/** Newest Phoenix-Setup*.exe in Downloads or Desktop (for the "Rettungs-Stick"). */
async function findSetupExe() {
  const f = getKnownFolders();
  let best = null;
  for (const dir of [f.downloads, f.desktop]) {
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^phoenix[- _]?setup.*\.exe$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.size > 1024 * 1024 && (!best || st.mtimeMs > best.mtimeMs)) best = { path: full, mtimeMs: st.mtimeMs };
      } catch {
        /* ignore */
      }
    }
  }
  return best ? { path: best.path } : null;
}

module.exports = { getKnownFolders, listDrives, listTargets, getSearchLocations, findSetupExe };
