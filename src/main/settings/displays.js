'use strict';
// Monitors: resolution, refresh rate, rotation, main monitor and arrangement.
// The PowerShell part only enumerates and applies explicit per-device values; matching, mode choice
// and layout are PURE functions below (unit-tested).

const ROTATIONS = [0, 90, 180, 270];
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const swapped = (rotation) => rotation === 90 || rotation === 270;

/** "\\?\DISPLAY#GSM5B7F#5&1a2b&0&UID4352#{e6f07b5f-...}" -> { monitorId: 'GSM5B7F', instance: 'DISPLAY\GSM5B7F\5&1a2b&0&UID4352' } */
function parseInterface(iface) {
  const m = /^\\\\\?\\(DISPLAY#([A-Za-z0-9]{3,16})#[^{]*?)#\{/.exec(String(iface || ''));
  if (!m) return { monitorId: '', instance: '' };
  return { monitorId: m[2].toUpperCase(), instance: m[1].replace(/#/g, '\\').toUpperCase() };
}

/** "w,h,hz,orient;..." -> unique landscape modes, best first. */
function parseModes(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text || '').split(';')) {
    const [w0, h0, hz, orient] = part.split(',').map((n) => int(n, -1));
    if (w0 < 640 || h0 < 480 || hz < 23 || hz > 1000) continue;
    const [w, h] = orient === 1 || orient === 3 ? [h0, w0] : [w0, h0];
    const key = `${w}x${h}@${hz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ w, h, hz });
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h || b.w - a.w || b.hz - a.hz);
}

/** Raw list-script output -> current displays (width/height always landscape). */
function normalizeCurrent(raw) {
  const rows = Array.isArray(raw && raw.rows) ? raw.rows : [];
  const wmi = Array.isArray(raw && raw.wmi) ? raw.wmi : [];
  return rows
    .map((r) => {
      const { monitorId, instance } = parseInterface(r.iface);
      const hit = instance && wmi.find((w) => String(w.instance || '').toUpperCase().startsWith(instance));
      const orient = int(r.orient) & 3;
      const rotation = ROTATIONS[orient];
      const [width, height] = swapped(rotation) ? [int(r.height), int(r.width)] : [int(r.width), int(r.height)];
      const name = String((hit && hit.name) || '').trim() || (monitorId ? `Monitor ${monitorId}` : String(r.monitorString || 'Monitor'));
      return {
        device: String(r.device || ''),
        monitorId,
        instance,
        name: name.slice(0, 80),
        width,
        height,
        hz: int(r.hz),
        rotation,
        x: int(r.x),
        y: int(r.y),
        primary: !!r.primary,
        modes: parseModes(r.modes),
      };
    })
    .filter((d) => /^\\\\\.\\DISPLAY\d{1,2}$/.test(d.device) && d.width > 0);
}

/** What a backup stores per monitor. */
function toEntry(d) {
  return { monitorId: d.monitorId, instance: d.instance, name: d.name, width: d.width, height: d.height, hz: d.hz, rotation: d.rotation, x: d.x, y: d.y, primary: d.primary };
}

function normalizeEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 16)
    .map((e) => ({
      monitorId: /^[A-Z0-9]{3,16}$/.test(String(e && e.monitorId).toUpperCase()) ? String(e.monitorId).toUpperCase() : '',
      instance: String((e && e.instance) || '').toUpperCase().slice(0, 200),
      name: String((e && e.name) || 'Monitor').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80),
      width: int(e && e.width),
      height: int(e && e.height),
      hz: int(e && e.hz),
      rotation: ROTATIONS.includes(int(e && e.rotation)) ? int(e.rotation) : 0,
      x: Number.isFinite(Number(e && e.x)) && e.x !== null ? int(e.x) : null,
      y: Number.isFinite(Number(e && e.y)) && e.y !== null ? int(e.y) : null,
      primary: !!(e && e.primary),
    }))
    .filter((e) => e.width >= 640 && e.height >= 480 && e.width <= 16384 && e.height <= 16384 && e.hz >= 0 && e.hz <= 1000);
}

/** Pairs saved monitors with connected ones: same instance first, then same model (left to right). */
function matchSaved(saved, current) {
  const pairs = new Map();
  const used = new Set();
  for (const d of current) {
    const i = saved.findIndex((s, idx) => !used.has(idx) && s.instance && s.instance === d.instance);
    if (i >= 0) {
      pairs.set(d.device, saved[i]);
      used.add(i);
    }
  }
  const byX = (a, b) => (a.x ?? 0) - (b.x ?? 0);
  for (const d of [...current].sort(byX)) {
    if (pairs.has(d.device) || !d.monitorId) continue;
    const cand = saved.map((s, idx) => ({ s, idx })).filter(({ s, idx }) => !used.has(idx) && s.monitorId === d.monitorId).sort((a, b) => byX(a.s, b.s))[0];
    if (cand) {
      pairs.set(d.device, cand.s);
      used.add(cand.idx);
    }
  }
  return pairs;
}

function maxMode(modes) {
  return modes.length ? [...modes].sort((a, b) => b.w * b.h - a.w * a.h || b.hz - a.hz)[0] : null;
}

/** Wanted resolution/refresh -> a mode the monitor really offers. */
function bestMode(modes, w, h, hz) {
  const same = modes.filter((m) => m.w === w && m.h === h);
  if (same.length) {
    const exact = same.find((m) => m.hz === hz);
    if (exact) return exact;
    const below = same.filter((m) => m.hz <= hz).sort((a, b) => b.hz - a.hz)[0];
    return below || same.sort((a, b) => a.hz - b.hz)[0];
  }
  return maxMode(modes);
}

/** Highest refresh rate at the given resolution. */
function maxHzAt(modes, w, h) {
  return modes.filter((m) => m.w === w && m.h === h).reduce((best, m) => Math.max(best, m.hz), 0);
}

/**
 * Editable entries for the connected monitors, pre-filled from a backup (saved) and/or upgraded to
 * the best refresh rate (maximize). Each entry carries `device` and `modes` for the editor.
 */
function suggest(current, { saved = [], maximize = false } = {}) {
  const pairs = matchSaved(normalizeEntries(saved), current);
  const entries = current.map((d) => {
    const s = pairs.get(d.device);
    const base = s || d;
    let mode = bestMode(d.modes, base.width, base.height, base.hz) || { w: d.width, h: d.height, hz: d.hz };
    if (maximize && !s) {
      const native = maxMode(d.modes) || mode;
      mode = { w: native.w, h: native.h, hz: maxHzAt(d.modes, native.w, native.h) || native.hz };
    }
    return {
      device: d.device,
      name: d.name,
      monitorId: d.monitorId,
      width: mode.w,
      height: mode.h,
      hz: mode.hz,
      rotation: s ? s.rotation : d.rotation,
      x: s ? s.x : d.x,
      y: s ? s.y : d.y,
      primary: s ? s.primary : d.primary,
      fromBackup: !!s,
      wanted: s ? { width: s.width, height: s.height, hz: s.hz } : null,
      modes: d.modes,
    };
  });
  // a backup only knows some monitors: keep exactly one main monitor
  if (entries.filter((e) => e.primary).length !== 1) {
    const pick = entries.find((e) => e.primary && e.fromBackup) || entries.find((e) => e.primary) || entries[0];
    entries.forEach((e) => (e.primary = e === pick));
  }
  return entries.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
}

const size = (e) => (swapped(e.rotation) ? [e.height, e.width] : [e.width, e.height]);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Final positions: the given x/y when every monitor has one and none overlap (keeps stacked or
 * offset setups from a backup), otherwise side by side in the given order, top-aligned.
 * The main monitor always ends up at 0,0 (Windows requires it).
 */
function layout(entries) {
  const rects = entries.map((e) => {
    const [w, h] = size(e);
    return { e, w, h, x: e.x, y: e.y };
  });
  const keep = rects.every((r) => Number.isInteger(r.x) && Number.isInteger(r.y)) && rects.every((a, i) => rects.every((b, j) => i === j || !overlaps(a, b)));
  if (!keep) {
    let x = 0;
    for (const r of rects) {
      r.x = x;
      r.y = 0;
      x += r.w;
    }
  }
  const main = rects.find((r) => r.e.primary) || rects[0];
  const dx = main ? main.x : 0;
  const dy = main ? main.y : 0;
  return rects.map((r) => ({ ...r.e, x: r.x - dx, y: r.y - dy, primary: r === main }));
}

/** Entries -> device commands for the apply script (DEVMODE wants rotated width/height). */
function plan(entries, current) {
  const byDevice = new Map(current.map((d) => [d.device, d]));
  const valid = entries
    .filter((e) => e && byDevice.has(e.device))
    .map((e) => {
      const d = byDevice.get(e.device);
      const rotation = ROTATIONS.includes(int(e.rotation)) ? int(e.rotation) : 0;
      const mode = bestMode(d.modes, int(e.width), int(e.height), int(e.hz)) || { w: d.width, h: d.height, hz: d.hz };
      return { device: e.device, width: mode.w, height: mode.h, hz: mode.hz, rotation, x: e.x ?? null, y: e.y ?? null, primary: !!e.primary };
    });
  return layout(valid).map((e) => {
    const [w, h] = size(e);
    return { device: e.device, w, h, hz: e.hz, orient: ROTATIONS.indexOf(e.rotation), x: e.x, y: e.y, primary: e.primary };
  });
}

const DISP_CODES = {
  0: 'ok',
  1: 'Neustart nötig',
  [-1]: 'Grafiktreiber hat abgelehnt',
  [-2]: 'Modus wird nicht unterstützt',
  [-3]: 'Konnte nicht gespeichert werden',
  [-4]: 'Ungültige Einstellung',
  [-5]: 'Ungültige Einstellung',
  [-6]: 'Anordnung nicht möglich',
  [-100]: 'Monitor nicht gefunden',
};
const codeText = (c) => DISP_CODES[c] || `Fehler ${c}`;

// PHX_MODE=list -> { rows, wmi } ; PHX_MODE=apply (PHX_JSON_FILE: { displays: [...] }) -> { test, results, final }
const DISPLAYS_PS = `
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PhxDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, uint num, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsEx(string dev, int mode, ref DEVMODE dm, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, IntPtr dm, IntPtr hwnd, uint flags, IntPtr param);
  static DEVMODE NewMode() { DEVMODE d = new DEVMODE(); d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return d; }
  static DISPLAY_DEVICE NewDev() { DISPLAY_DEVICE d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE)); return d; }
  public static List<string[]> List() {
    List<string[]> rows = new List<string[]>();
    for (uint i = 0; i < 32; i++) {
      DISPLAY_DEVICE dd = NewDev();
      if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
      if ((dd.StateFlags & 1) == 0) continue;
      DISPLAY_DEVICE mon = NewDev();
      string iface = "", monName = "";
      if (EnumDisplayDevices(dd.DeviceName, 0, ref mon, 1)) { iface = mon.DeviceID; monName = mon.DeviceString; }
      DEVMODE cur = NewMode();
      if (!EnumDisplaySettingsEx(dd.DeviceName, -1, ref cur, 0)) continue;
      System.Text.StringBuilder modes = new System.Text.StringBuilder();
      Dictionary<string, bool> seen = new Dictionary<string, bool>();
      for (int m = 0; m < 4000; m++) {
        DEVMODE dm = NewMode();
        if (!EnumDisplaySettingsEx(dd.DeviceName, m, ref dm, 0)) break;
        string k = dm.dmPelsWidth + "," + dm.dmPelsHeight + "," + dm.dmDisplayFrequency + "," + dm.dmDisplayOrientation;
        if (seen.ContainsKey(k)) continue;
        seen[k] = true;
        if (modes.Length > 0) modes.Append(';');
        modes.Append(k);
      }
      rows.Add(new string[] { dd.DeviceName, iface, monName, cur.dmPelsWidth.ToString(), cur.dmPelsHeight.ToString(),
        cur.dmDisplayFrequency.ToString(), cur.dmDisplayOrientation.ToString(), cur.dmPositionX.ToString(), cur.dmPositionY.ToString(),
        ((dd.StateFlags & 4) != 0) ? "1" : "0", modes.ToString() });
    }
    return rows;
  }
  static DEVMODE Build(string dev, int w, int h, int hz, int orient, int x, int y) {
    DEVMODE dm = NewMode();
    EnumDisplaySettingsEx(dev, -1, ref dm, 0);
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmDisplayFrequency = hz; dm.dmDisplayOrientation = orient;
    dm.dmPositionX = x; dm.dmPositionY = y;
    dm.dmFields = 0x20 | 0x80 | 0x80000 | 0x100000 | 0x400000;
    return dm;
  }
  public static int Test(string dev, int w, int h, int hz, int orient, int x, int y) {
    DEVMODE dm = Build(dev, w, h, hz, orient, x, y);
    return ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 0x02, IntPtr.Zero);
  }
  public static int Set(string dev, int w, int h, int hz, int orient, int x, int y, bool primary) {
    DEVMODE dm = Build(dev, w, h, hz, orient, x, y);
    uint flags = 0x01 | 0x10000000;
    if (primary) flags |= 0x10;
    return ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, flags, IntPtr.Zero);
  }
  public static int Commit() { return ChangeDisplaySettingsEx(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero); }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
if ($env:PHX_MODE -eq 'list') {
  $rows = @()
  foreach ($r in [PhxDisp]::List()) {
    $rows += [pscustomobject]@{ device = $r[0]; iface = $r[1]; monitorString = $r[2]; width = [int]$r[3]; height = [int]$r[4]; hz = [int]$r[5]; orient = [int]$r[6]; x = [int]$r[7]; y = [int]$r[8]; primary = ($r[9] -eq '1'); modes = $r[10] }
  }
  $wmi = @()
  try {
    foreach ($w in @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID -ErrorAction Stop)) {
      $n = ''
      if ($w.UserFriendlyName) { $n = (($w.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '') }
      $wmi += [pscustomobject]@{ instance = [string]$w.InstanceName; name = $n.Trim() }
    }
  } catch { }
  Write-PhxJson @{ rows = @($rows); wmi = @($wmi) }
} else {
  $cfg = Get-Content -Raw -LiteralPath $env:PHX_JSON_FILE | ConvertFrom-Json
  $list = @($cfg.displays)
  $test = @()
  foreach ($d in $list) {
    $test += [pscustomobject]@{ device = [string]$d.device; code = [PhxDisp]::Test([string]$d.device, [int]$d.w, [int]$d.h, [int]$d.hz, [int]$d.orient, [int]$d.x, [int]$d.y) }
  }
  $results = @()
  $final = $null
  if (@($test | Where-Object { $_.code -ne 0 }).Count -eq 0) {
    foreach ($d in $list) {
      $results += [pscustomobject]@{ device = [string]$d.device; code = [PhxDisp]::Set([string]$d.device, [int]$d.w, [int]$d.h, [int]$d.hz, [int]$d.orient, [int]$d.x, [int]$d.y, [bool]$d.primary) }
    }
    $final = [PhxDisp]::Commit()
  }
  Write-PhxJson @{ test = @($test); results = @($results); final = $final }
}
`;

module.exports = {
  DISPLAYS_PS,
  ROTATIONS,
  parseInterface,
  parseModes,
  normalizeCurrent,
  normalizeEntries,
  toEntry,
  matchSaved,
  bestMode,
  maxMode,
  maxHzAt,
  suggest,
  layout,
  plan,
  codeText,
};
