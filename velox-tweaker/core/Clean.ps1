# VELOX - core/Clean.ps1
# Reinigung: measuring (clean-scan) and cleaning (run-action) of the catalog's clean targets with a
# hard allow-list of roots and a junction-safe walk; long-running Windows tools (DISM, SFC, CHKDSK,
# Datenträgerbereinigung) as isolated processes with live percent, elapsed time, timeout, cancel
# and skip. Only function definitions.

# ================================================================== catalog helpers

# quick (Schnell), deep (Gründlich), optin (only "Alles" and only after an explicit confirmation).
function Get-VxCleanTier($Tweak) { return [string](Get-VxProp $Tweak 'tier' '') }

function Get-VxCleanTiers { return @('quick', 'deep', 'optin') }

# The fixed list of long-running tools a catalog "tool" action may name (tools/Validate-Catalog.ps1
# keeps the same list; a test compares both).
function Get-VxToolIds {
    return @('dism-scanhealth', 'dism-restorehealth', 'dism-component-cleanup', 'dism-component-resetbase', 'sfc-scannow', 'chkdsk-scan', 'cleanmgr-windows-old')
}

# Paths whose size the scan reports for one action: what a clean action deletes, or what a
# tool / ps action declares in "measure" (read only, never deleted by VELOX itself).
function Get-VxCleanMeasurePaths($Action) {
    $type = [string](Get-VxProp $Action 'type')
    if ($type -eq 'clean') { return @(@(Get-VxProp $Action 'paths' @()) | ForEach-Object { [string]$_ }) }
    return @(@(Get-VxProp $Action 'measure' @()) | ForEach-Object { [string]$_ })
}

# Kind "action" tweaks the Reinigung measures: every one with a tier, a clean action or measure paths.
function Get-VxCleanTweaks {
    $out = New-Object System.Collections.ArrayList
    foreach ($t in @($global:VxCtx.Catalog.tweaks)) {
        if ((Get-VxTweakKind $t) -ne 'action') { continue }
        $take = [bool](Get-VxCleanTier $t)
        if (-not $take) {
            foreach ($a in @($t.actions)) { if (@(Get-VxCleanMeasurePaths $a).Count -gt 0) { $take = $true; break } }
        }
        if ($take) { [void]$out.Add($t) }
    }
    return $out.ToArray()
}

# ================================================================== paths

# Fake PC for tests and the Testmodus (VELOX_CLEAN_FIXTURE): a folder with C\... inside. In it,
# deletes really happen - it is a throw-away copy (tests\fixtures\clean\New-CleanFixture.ps1).
function Get-VxCleanFixture {
    $ctx = $global:VxCtx
    if ($ctx.ContainsKey('CleanFixture') -and $ctx.CleanFixture) { return [string]$ctx.CleanFixture }
    if ($ctx.Simulate) {
        $e = [string]$env:VELOX_CLEAN_FIXTURE
        if ($e -and [IO.Directory]::Exists($e)) { return $e }
    }
    return ''
}

function Join-VxCleanPath([string]$A, [string]$B) {
    if (-not $A) { return '' }
    $sep = '\'
    if ($A.Contains('/') -and -not $A.Contains('\')) { $sep = '/' }
    if (-not (Test-VxWindows)) { $sep = '/'; $B = $B.Replace('\', '/') }
    return ($A.TrimEnd('\', '/') + $sep + $B.TrimStart('\', '/'))
}

# Steam's install folder (registry), '' when Steam is not installed.
function Get-VxSteamRoot {
    $ctx = $global:VxCtx
    if ($ctx.Cache.ContainsKey('cleanSteam')) { return [string]$ctx.Cache.cleanSteam }
    $root = ''
    if (Test-VxWindows) {
        foreach ($c in @(@('HKCU\Software\Valve\Steam', 'SteamPath'), @('HKLM\SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath'), @('HKLM\SOFTWARE\Valve\Steam', 'InstallPath'))) {
            try {
                $v = Get-VxRealRegValue $c[0] $c[1]
                if ($v.exists -and $v.value) {
                    $p = ([string]$v.value).Replace('/', '\').TrimEnd('\')
                    if ([IO.Directory]::Exists($p)) { $root = $p; break }
                }
            } catch { $null = $_ }
        }
    }
    $ctx.Cache.cleanSteam = $root
    return $root
}

# The SID whose recycle bin is "mine": the desktop user's when VELOX runs as another account.
function Get-VxCleanUserSid {
    $du = $global:VxCtx.DesktopUser
    if ($null -ne $du -and $du.sid) { return [string]$du.sid }
    if (-not (Test-VxWindows)) { return 'S-1-5-21-0-0-0-1001' }
    try { return [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { return '' }
}

# Every %TOKEN% a clean path may use -> folder. Per-user tokens point at the person at the desktop.
function Get-VxCleanVars {
    $fx = Get-VxCleanFixture
    $v = @{}
    if ($fx) {
        $c = Join-VxCleanPath $fx 'C'
        $prof = Join-VxCleanPath $c 'Users\Max'
        $v['SYSTEMDRIVE'] = $c
        $v['WINDIR'] = Join-VxCleanPath $c 'Windows'
        $v['SYSTEMROOT'] = $v['WINDIR']
        $v['PROGRAMDATA'] = Join-VxCleanPath $c 'ProgramData'
        $v['PROGRAMFILES'] = Join-VxCleanPath $c 'Program Files'
        $v['PROGRAMFILES(X86)'] = Join-VxCleanPath $c 'Program Files (x86)'
        $v['USERPROFILE'] = $prof
        $v['LOCALAPPDATA'] = Join-VxCleanPath $prof 'AppData\Local'
        $v['APPDATA'] = Join-VxCleanPath $prof 'AppData\Roaming'
        $v['TEMP'] = Join-VxCleanPath $prof 'AppData\Local\Temp'
        $v['STEAM'] = ''
        $st = Join-VxCleanPath $c 'Program Files (x86)\Steam'
        if ([IO.Directory]::Exists($st)) { $v['STEAM'] = $st }
    } else {
        $sd = [string]$env:SystemDrive
        if (-not $sd) { $sd = 'C:' }
        $win = [string]$env:SystemRoot
        if (-not $win) { $win = [string]$env:windir }
        if (-not $win) { $win = $sd + '\Windows' }
        $v['SYSTEMDRIVE'] = $sd
        $v['WINDIR'] = $win
        $v['SYSTEMROOT'] = $win
        $v['PROGRAMDATA'] = [string]$env:ProgramData
        $v['PROGRAMFILES'] = [string]$env:ProgramFiles
        $v['PROGRAMFILES(X86)'] = [string]${env:ProgramFiles(x86)}
        $v['USERPROFILE'] = Get-VxUserFolder 'profile'
        $v['LOCALAPPDATA'] = Get-VxUserFolder 'localAppData'
        $v['APPDATA'] = Get-VxUserFolder 'appData'
        $v['TEMP'] = Get-VxUserFolder 'temp'
        $v['STEAM'] = Get-VxSteamRoot
    }
    $v['TMP'] = $v['TEMP']
    $v['LOCALLOW'] = ''
    if ($v['USERPROFILE']) { $v['LOCALLOW'] = Join-VxCleanPath $v['USERPROFILE'] 'AppData\LocalLow' }
    return $v
}

# Replaces the %TOKENS% of a catalog path. $null when a token is unknown or empty (the target does
# not exist on this PC, e.g. %STEAM% without Steam).
function Expand-VxCleanPath([string]$Raw, $Vars) {
    if ($null -eq $Vars) { $Vars = Get-VxCleanVars }
    $sb = New-Object System.Text.StringBuilder
    $pos = 0
    foreach ($m in [regex]::Matches($Raw, '%([^%]+)%')) {
        [void]$sb.Append($Raw.Substring($pos, $m.Index - $pos))
        $k = $m.Groups[1].Value.ToUpperInvariant()
        if (-not $Vars.ContainsKey($k) -or -not [string]$Vars[$k]) { return $null }
        [void]$sb.Append([string]$Vars[$k])
        $pos = $m.Index + $m.Length
    }
    [void]$sb.Append($Raw.Substring($pos))
    $out = $sb.ToString()
    if (-not (Test-VxWindows)) { $out = $out.Replace('\', '/') }
    return $out
}

# Path form used for comparisons only: lower case, backslashes, no trailing separator.
function ConvertTo-VxCmpPath([string]$Path) {
    if (-not $Path) { return '' }
    $p = $Path.Replace('/', '\')
    if ($p.StartsWith('\\?\UNC\')) { $p = '\\' + $p.Substring(8) }
    elseif ($p.StartsWith('\\?\')) { $p = $p.Substring(4) }
    $p = $p.TrimEnd('\')
    return $p.ToLowerInvariant()
}

# Refuses roots that must never be emptied: drive roots, Windows, System32, Program Files,
# ProgramData, Users and every user-profile root.
function Test-VxCleanPathSafe([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $p = $Path.Trim().TrimEnd('\', '/')
    if ($p -match '%') { return $false }
    if ($p -eq '' -or $p -match '^[A-Za-z]:$') { return $false }
    if (-not ($p -match '^[A-Za-z]:\\' -or $p.StartsWith('\\') -or $p.StartsWith('/'))) { return $false }
    if ($p -match '(^|[\\/])\.\.([\\/]|$)') { return $false }
    # string handling instead of [IO.Path] so the checks behave the same in the Linux tests
    $deny = New-Object System.Collections.Generic.List[string]
    foreach ($v in @($env:SystemRoot, $env:windir, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432, $env:ProgramData, $env:USERPROFILE, $env:PUBLIC, $env:APPDATA, $env:LOCALAPPDATA, $env:HOME, (Get-VxUserFolder 'profile'), (Get-VxUserFolder 'appData'), (Get-VxUserFolder 'localAppData'))) {
        if ($v) { $deny.Add($v.TrimEnd('\', '/')) }
    }
    $win = $env:SystemRoot
    if (-not $win) { $win = 'C:\Windows' }
    $win = $win.TrimEnd('\')
    foreach ($sub in @('System32', 'SysWOW64', 'WinSxS', 'Boot', 'Fonts', 'Installer', 'servicing')) { $deny.Add($win + '\' + $sub) }
    $sysDrive = $env:SystemDrive
    if (-not $sysDrive) { $sysDrive = 'C:' }
    $users = $sysDrive.TrimEnd('\') + '\Users'
    $deny.Add($users)
    foreach ($d in $deny) { if ([string]::Equals($p, $d, [StringComparison]::OrdinalIgnoreCase)) { return $false } }
    # any user-profile root (C:\Users\<name>)
    $i = $p.LastIndexOf('\')
    if ($i -gt 0 -and [string]::Equals($p.Substring(0, $i), $users, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return $true
}

# The hard allow-list: a cleaned (or measured) root must lie in one of these folders, whatever the
# catalog says. Folders: @{ path; file = $false }; single files: @{ path; file = $true }.
function Get-VxCleanAllowList {
    $v = Get-VxCleanVars
    $list = New-Object System.Collections.ArrayList
    $add = { param([string]$p, [bool]$file) if ($p) { [void]$list.Add(@{ path = (ConvertTo-VxCmpPath $p); file = $file }) } }
    foreach ($k in @('TEMP', 'LOCALAPPDATA', 'APPDATA', 'LOCALLOW')) { & $add $v[$k] $false }
    $win = $v['WINDIR']
    foreach ($s in @('Temp', 'Logs\CBS', 'Logs\DISM', 'Logs\WindowsUpdate', 'Logs\MoSetup', 'Logs\NetSetup', 'Minidump', 'LiveKernelReports', 'SoftwareDistribution\Download',
            'ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization', 'ServiceProfiles\LocalService\AppData\Local\FontCache', 'System32\spool\PRINTERS')) {
        & $add (Join-VxCleanPath $win $s) $false
    }
    & $add (Join-VxCleanPath $win 'MEMORY.DMP') $true
    & $add (Join-VxCleanPath $win 'System32\FNTCACHE.DAT') $true
    $pd = $v['PROGRAMDATA']
    foreach ($s in @('Microsoft\Windows\WER', 'NVIDIA Corporation\Downloader', 'NVIDIA Corporation\NV_Cache', 'Blizzard Entertainment\Battle.net\Cache')) { & $add (Join-VxCleanPath $pd $s) $false }
    $sd = $v['SYSTEMDRIVE']
    foreach ($s in @('NVIDIA', 'AMD', '$Windows.~BT', '$Windows.~WS', 'Windows.old')) { & $add (Join-VxCleanPath $sd $s) $false }
    if ($v['STEAM']) { foreach ($s in @('appcache\httpcache', 'logs', 'dumps', 'steamapps\shadercache')) { & $add (Join-VxCleanPath $v['STEAM'] $s) $false } }
    foreach ($rb in @(Get-VxRecycleRoots)) { & $add $rb $false }
    return $list.ToArray()
}

function Test-VxCleanAllowed([string]$Root, $Allow = $null) {
    if ($null -eq $Allow) { $Allow = Get-VxCleanAllowList }
    $r = ConvertTo-VxCmpPath $Root
    if (-not $r) { return $false }
    foreach ($a in @($Allow)) {
        if ($a.file) { if ($r -eq $a.path) { return $true }; continue }
        if ($r -eq $a.path -or $r.StartsWith($a.path + '\')) { return $true }
    }
    # Temp folder of any user profile (opt-in "andere Benutzer"): <SystemDrive>\Users\<name>\AppData\Local\Temp
    $sd = ConvertTo-VxCmpPath (Get-VxCleanVars)['SYSTEMDRIVE']
    if ($sd -and $r -match ('^' + [regex]::Escape($sd) + '\\users\\[^\\]+\\appdata\\local\\temp(\\|$)')) { return $true }
    return $false
}

# The recycle bin folders of the desktop user: <drive>\$Recycle.Bin\<SID> on every fixed drive.
function Get-VxRecycleRoots {
    $sid = Get-VxCleanUserSid
    if (-not $sid) { return @() }
    $fx = Get-VxCleanFixture
    if ($fx) { return @((Join-VxCleanPath (Join-VxCleanPath $fx 'C') ('$Recycle.Bin\' + $sid))) }
    if (-not (Test-VxWindows)) { return @() }
    $out = @()
    try {
        foreach ($d in [IO.DriveInfo]::GetDrives()) {
            try { if ($d.DriveType -eq [IO.DriveType]::Fixed -and $d.IsReady) { $out += ($d.RootDirectory.FullName.TrimEnd('\') + '\$Recycle.Bin\' + $sid) } } catch { $null = $_ }
        }
    } catch { $null = $_ }
    return $out
}

# Expands one catalog path into roots: @{ root; filter; expanded }. Handles %RECYCLEBIN% (one root
# per drive) and ONE wildcard segment in the middle (every profile of a browser, every user's Temp):
# it matches real folders only - never a junction or symbolic link, and never the desktop user's own
# profile folder (that one has its own items).
function Resolve-VxCleanRoots([string]$Raw, $Vars = $null) {
    $out = New-Object System.Collections.ArrayList
    $raws = @($Raw)
    if ($Raw -match '^(?i)%RECYCLEBIN%') {
        $rest = $Raw.Substring(12)
        $raws = @(Get-VxRecycleRoots | ForEach-Object { $_ + $rest })
        if (-not (Test-VxWindows)) { $raws = @($raws | ForEach-Object { $_.Replace('\', '/') }) }
    }
    foreach ($r in $raws) {
        $exp = $r
        if ($exp -match '%') { $exp = Expand-VxCleanPath $r $Vars }
        if (-not $exp) { continue }
        $sep = '\'
        if (-not (Test-VxWindows)) { $sep = '/' }
        $segs = @($exp.Split([char[]]@('\', '/')))
        $mid = -1
        for ($i = 0; $i -lt $segs.Count - 1; $i++) { if ($segs[$i] -match '[\*\?]') { $mid = $i; break } }
        $bases = @()
        if ($mid -eq 0) { continue }
        if ($mid -lt 0) { $bases = @($exp) }
        else {
            $prefix = ($segs[0..($mid - 1)] -join $sep)
            if ($prefix -eq '') { $prefix = $sep }
            $suffix = ''
            if ($mid + 1 -le $segs.Count - 1) { $suffix = ($segs[($mid + 1)..($segs.Count - 1)] -join $sep) }
            $own = ConvertTo-VxCmpPath ([string](Get-VxCleanVars)['USERPROFILE'])
            $lp = Get-VxLongPath $prefix
            if ([IO.Directory]::Exists($lp)) {
                try {
                    foreach ($d in (New-Object IO.DirectoryInfo($lp)).GetDirectories($segs[$mid])) {
                        if (($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                        $full = $prefix.TrimEnd('\', '/') + $sep + $d.Name
                        if ($own -and (ConvertTo-VxCmpPath $full) -eq $own) { continue }
                        $bases += ($full + $sep + $suffix)
                    }
                } catch { $null = $_ }
            }
        }
        foreach ($b in $bases) {
            $leaf = [IO.Path]::GetFileName($b)
            if ($leaf -match '[\*\?]') { [void]$out.Add(@{ root = [IO.Path]::GetDirectoryName($b); filter = $leaf; expanded = $b }) }
            else { [void]$out.Add(@{ root = $b; filter = $null; expanded = $b }) }
        }
    }
    return $out.ToArray()
}

# Kept for callers that pass one plain path (no middle wildcard): the first root.
function Resolve-VxCleanPath([string]$Raw) {
    $r = @(Resolve-VxCleanRoots $Raw)
    if ($r.Count -gt 0) { return $r[0] }
    $exp = Expand-VxUserPath $Raw
    return @{ root = $exp; filter = $null; expanded = $exp }
}

# ================================================================== safe file system (Windows)

# Native helpers for deleting without following junctions (Windows only, compiled once per runspace).
# DeleteUnder opens the item itself (never a link target), asks Windows for the item's real final
# path, refuses when that is not below the cleaned root and then deletes THROUGH THAT HANDLE - so a
# folder swapped for a junction between listing and deleting cannot redirect the delete.
function Initialize-VxSafeFs {
    if ('VeloxNative.SafeFs' -as [type]) { return $true }
    if (-not (Test-VxWindows)) { return $false }
    $src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace VeloxNative {
  public static class SafeFs {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint len, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref uint info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref byte info, uint size);
    const uint DELETE = 0x00010000, READ_ATTR = 0x80, SHARE_ALL = 7, OPEN_EXISTING = 3;
    const uint OPEN_REPARSE = 0x00200000, BACKUP = 0x02000000;
    static string Final(SafeFileHandle h) {
      StringBuilder sb = new StringBuilder(1024);
      uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
      if (n == 0) return null;
      if (n >= sb.Capacity) {
        sb = new StringBuilder((int)n + 2);
        n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
        if (n == 0) return null;
      }
      return sb.ToString();
    }
    public static string FinalPath(string path) {
      using (SafeFileHandle h = CreateFileW(path, READ_ATTR, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP, IntPtr.Zero)) {
        if (h.IsInvalid) return null;
        return Final(h);
      }
    }
    static int Map(int err) {
      if (err == 32 || err == 33 || err == 5 || err == 145 || err == 1224) return 2;
      if (err == 206 || err == 3 || err == 111) return 3;
      if (err == 2) return 5;
      return 4;
    }
    // 0 deleted, 1 not below the root (refused), 2 in use / access denied, 3 path too long, 4 other, 5 gone
    public static int DeleteUnder(string path, string rootFinal) {
      using (SafeFileHandle h = CreateFileW(path, DELETE | READ_ATTR, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, OPEN_REPARSE | BACKUP, IntPtr.Zero)) {
        if (h.IsInvalid) return Map(Marshal.GetLastWin32Error());
        string f = Final(h);
        if (f == null) return 4;
        string root = rootFinal.TrimEnd('\\') + "\\";
        if (!f.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return 1;
        uint flags = 0x1 | 0x2 | 0x10; // DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE (Win10 1809+)
        if (SetFileInformationByHandle(h, 21, ref flags, 4)) return 0;
        byte del = 1;
        if (SetFileInformationByHandle(h, 4, ref del, 1)) return 0;
        return Map(Marshal.GetLastWin32Error());
      }
    }
  }
}
'@
    try { Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop; return $true } catch {
        Write-VxLog 'warn' ('Sicheres Löschen nicht verfügbar: ' + $_.Exception.Message)
        return $false
    }
}

# Long-path form of a local or UNC path (\\?\C:\... / \\?\UNC\server\share\...) when .NET accepts it
# (Windows PowerShell 5.1 otherwise fails above 260 characters); else the path unchanged.
function Get-VxLongPath([string]$Path) {
    if (-not (Test-VxWindows) -or -not $Path -or $Path.StartsWith('\\?\')) { return $Path }
    $lp = $null
    if ($Path -match '^[A-Za-z]:\\') { $lp = '\\?\' + $Path }
    elseif ($Path.StartsWith('\\')) { $lp = '\\?\UNC\' + $Path.Substring(2) }
    if ($null -eq $lp) { return $Path }
    try { if ([IO.Directory]::Exists($lp) -or [IO.File]::Exists($lp)) { return $lp } } catch { $null = $_ }
    return $Path
}

# Refuses a root when it or any folder above it is a junction / symbolic link: then the folder that
# looks like a cache could really be C:\Program Files\... and the cleaner would empty that.
function Test-VxCleanRootChain([string]$Root) {
    $p = $Root
    while ($p) {
        try {
            $di = New-Object IO.DirectoryInfo($p)
            if ($di.Exists -and (($di.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
        } catch { return $false }
        $parent = [IO.Path]::GetDirectoryName($p)
        if (-not $parent -or $parent -eq $p) { break }
        $p = $parent
    }
    return $true
}

# Top-level items of one resolved root. Throws (German) when the root is not allowed.
function Get-VxCleanTopItems($Resolved, [string[]]$Keep, $Allow = $null) {
    $items = @()
    $root = $Resolved.root
    if (-not (Test-VxCleanPathSafe $root)) { throw ("Pfad wird aus Sicherheitsgründen nicht bereinigt: {0}" -f $root) }
    $target = $root
    if (-not $Resolved.filter) { $target = $Resolved.expanded }
    if (-not (Test-VxCleanAllowed $target $Allow)) { throw ("Pfad steht nicht auf der Liste erlaubter Ordner und wird nicht angefasst: {0}" -f $target) }
    if (-not (Test-VxCleanRootChain $root)) { throw ("Pfad wird nicht bereinigt, weil er (oder ein Ordner darüber) eine Verknüpfung auf einen anderen Ort ist: {0}" -f $root) }
    $lr = Get-VxLongPath $root
    if ($Resolved.filter) {
        if (-not [IO.Directory]::Exists($lr)) { return @() }
        $di = New-Object IO.DirectoryInfo($lr)
        $items = @($di.GetFileSystemInfos($Resolved.filter))
    } elseif ([IO.Directory]::Exists($lr)) {
        $di = New-Object IO.DirectoryInfo($lr)
        $items = @($di.GetFileSystemInfos())
    } elseif ([IO.File]::Exists($lr)) {
        $items = @(New-Object IO.FileInfo($lr))
    }
    if (@($Keep).Count -gt 0) { $items = @($items | Where-Object { $Keep -notcontains $_.Name }) }
    return $items
}

# Real final path of the cleaned root (\\?\C:\...), $null off Windows or when unknown.
function Get-VxCleanRootFinal([string]$Root) {
    if (-not (Initialize-VxSafeFs)) { return $null }
    try { return [VeloxNative.SafeFs]::FinalPath((Get-VxLongPath $Root)) } catch { return $null }
}

# Deletes one file / empty folder. Returns 'ok', 'locked', 'toolong', 'refused', 'gone' or 'error'.
function Remove-VxCleanItem($Item, [string]$RootFinal) {
    if ($null -ne $global:VxCleanLocked -and $global:VxCleanLocked.Contains((ConvertTo-VxCmpPath $Item.FullName))) { return 'locked' }
    if ($RootFinal -and ('VeloxNative.SafeFs' -as [type])) {
        $code = [VeloxNative.SafeFs]::DeleteUnder($Item.FullName, $RootFinal)
        switch ($code) { 0 { return 'ok' } 1 { return 'refused' } 2 { return 'locked' } 3 { return 'toolong' } 5 { return 'gone' } }
        return 'error'
    }
    # fallback (non-Windows tests, or the native helper is unavailable): the folder the item sits
    # in must still be a real folder right before the delete
    try {
        $parent = $null
        if ($Item -is [IO.FileInfo]) { $parent = $Item.Directory } else { $parent = $Item.Parent }
        if ($null -ne $parent) {
            $parent.Refresh()
            if (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'refused' }
        }
        if ($Item -is [IO.FileInfo] -and ($Item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { $Item.Attributes = [IO.FileAttributes]::Normal }
        $Item.Delete()
        return 'ok'
    } catch [System.IO.PathTooLongException] { return 'toolong' }
    catch [System.IO.FileNotFoundException] { return 'gone' }
    catch [System.IO.DirectoryNotFoundException] { return 'gone' }
    catch { return 'locked' }
}

# Walks (and optionally deletes) files below the given items. Never follows junctions/symlinks:
# reparse points are skipped, every folder is re-checked right before it is listed, and deletes
# are verified against the root's real path (Remove-VxCleanItem).
# Counts: skipped (in use / access denied), tooLong (path too long), refused (redirected).
# partial = the measuring budget ran out; stopped = "Überspringen" ended the delete.
# $Live (synchronized hashtable of the job, optional) gets files/freed while deleting.
# $CutoffUtc (minAgeHours of the action): files and folders written or created after it are left
# alone and not counted (young) - a running installer or an update waiting for the reboot may
# still need them. A young folder is skipped with everything in it.
function Invoke-VxCleanWalk($Items, [bool]$Delete, [int]$MaxMs = 30000, [string]$RootFinal = $null, $Live = $null, [DateTime]$CutoffUtc = [DateTime]::MinValue) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $res = @{ bytes = [long]0; files = 0; freed = [long]0; deleted = 0; skipped = 0; tooLong = 0; refused = 0; young = 0; partial = $false; stopped = $false }
    $useAge = ($CutoffUtc -gt [DateTime]::MinValue)
    $job = $global:VxJob
    $baseFiles = 0; $baseFreed = [long]0
    if ($null -ne $Live) { $baseFiles = [int]$Live.files; $baseFreed = [long]$Live.freed }
    $dirs = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Generic.Stack[object]
    foreach ($i in @($Items)) { $stack.Push($i) }
    $n = 0
    while ($stack.Count -gt 0) {
        $n++
        if (($n % 64) -eq 0) {
            if ($null -ne $job) {
                if ($job.cancel) { throw 'VX_CANCELLED' }
                if ($Delete -and $job.skip -and $job.skippable) { $res.stopped = $true; break }
            }
            if ($null -ne $Live) { Update-VxCleanLive $Live ($baseFiles + $res.deleted) ($baseFreed + $res.freed) }
        }
        if (-not $Delete -and $sw.ElapsedMilliseconds -gt $MaxMs) { $res.partial = $true; break }
        $it = $stack.Pop()
        try {
            # measuring trusts the data of the listing; deleting reads the item fresh
            if ($Delete) { $it.Refresh() }
            if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($useAge -and (Test-VxCleanYoung $it $CutoffUtc)) { $res.young++; continue }
            if ($it -is [IO.DirectoryInfo]) {
                $dirs.Add($it)
                foreach ($c in $it.GetFileSystemInfos()) { $stack.Push($c) }
            } else {
                $len = [long]$it.Length
                $res.bytes += $len
                $res.files++
                if ($Delete) {
                    switch (Remove-VxCleanItem $it $RootFinal) {
                        'ok' { $res.freed += $len; $res.deleted++ }
                        'gone' { $null = $_ }
                        'toolong' { $res.tooLong++ }
                        'refused' { $res.refused++ }
                        default { $res.skipped++ }
                    }
                }
            }
        } catch [System.IO.PathTooLongException] { $res.tooLong++ }
        catch {
            if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
            $res.skipped++
        }
    }
    if ($Delete) {
        # remove now-empty folders, deepest first
        foreach ($d in @($dirs | Sort-Object { $_.FullName.Length } -Descending)) {
            try {
                $d.Refresh()
                if ($d.Exists -and (($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and @($d.GetFileSystemInfos()).Count -eq 0) { $null = Remove-VxCleanItem $d $RootFinal }
            } catch { $null = $_ }
        }
    }
    if ($null -ne $Live) { Update-VxCleanLive $Live ($baseFiles + $res.deleted) ($baseFreed + $res.freed) }
    return $res
}

# $true when the item was written or created after the cutoff (Windows keeps the original write
# time when a program unpacks or copies files, so the creation time counts too there).
function Test-VxCleanYoung($Item, [DateTime]$CutoffUtc) {
    $t = $Item.LastWriteTimeUtc
    if (Test-VxWindows) { $c = $Item.CreationTimeUtc; if ($c -gt $t) { $t = $c } }
    return ($t -gt $CutoffUtc)
}

# Cutoff of a clean action's minAgeHours, [DateTime]::MinValue without one.
function Get-VxCleanCutoff($Action) {
    $h = [int](Get-VxProp $Action 'minAgeHours' 0)
    if ($h -le 0) { return [DateTime]::MinValue }
    return [DateTime]::UtcNow.AddHours(-$h)
}

# Live numbers of the item being cleaned; with the file count of the last scan (expect) also its
# progress and the job's progress bar.
function Update-VxCleanLive($Live, [int]$Files, [long]$Freed) {
    $Live.files = $Files
    $Live.freed = $Freed
    $exp = [int](Get-VxProp $Live 'expect' 0)
    if ($exp -gt 0) {
        $f = [math]::Min(1.0, $Files / [double]$exp)
        $Live.progress = [math]::Round($f, 3)
        Set-VxProgress ([double](Get-VxProp $Live 'base' 0) + [double](Get-VxProp $Live 'span' 0) * $f)
    }
}

# Paths of the fixture that act as "in use" (fixture file locked.txt, relative to the fixture root).
function Initialize-VxCleanLocked {
    $global:VxCleanLocked = $null
    $fx = Get-VxCleanFixture
    if (-not $fx) { return }
    $f = Join-VxCleanPath $fx 'locked.txt'
    if (-not [IO.File]::Exists($f)) { return }
    $set = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($l in [IO.File]::ReadAllLines($f)) {
        if ($l.Trim()) { [void]$set.Add((ConvertTo-VxCmpPath (Join-VxCleanPath $fx $l.Trim()))) }
    }
    $global:VxCleanLocked = $set
}

# ================================================================== running apps

function Get-VxAppLabel([string]$Name) {
    $map = @{ msedge = 'Edge'; chrome = 'Chrome'; brave = 'Brave'; opera = 'Opera'; vivaldi = 'Vivaldi'; firefox = 'Firefox'
        discord = 'Discord'; discordptb = 'Discord PTB'; discordcanary = 'Discord Canary'; spotify = 'Spotify'; steam = 'Steam'; steamwebhelper = 'Steam'
        epicgameslauncher = 'Epic Games Launcher'; epicwebhelper = 'Epic Games Launcher'; 'battle.net' = 'Battle.net'; eadesktop = 'EA app'
        teams = 'Teams'; slack = 'Slack'; fivem = 'FiveM'
    }
    $k = $Name.ToLowerInvariant()
    if ($map.ContainsKey($k)) { return $map[$k] }
    return ($Name + '.exe')
}

function Get-VxCleanApps($Tweak) {
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($a in @($Tweak.actions)) {
        foreach ($n in @(Get-VxProp $a 'closeApps' @())) { if ($n -and -not $names.Contains([string]$n)) { $names.Add([string]$n) } }
    }
    return $names.ToArray()
}

# Display names of the given processes that run in this desktop session (fixture: running.txt).
function Get-VxRunningApps([string[]]$Names) {
    $labels = New-Object System.Collections.Generic.List[string]
    if (@($Names).Count -eq 0) { return @() }
    $fx = Get-VxCleanFixture
    $running = @{}
    if ($fx) {
        $f = Join-VxCleanPath $fx 'running.txt'
        if ([IO.File]::Exists($f)) { foreach ($l in [IO.File]::ReadAllLines($f)) { if ($l.Trim()) { $running[$l.Trim().ToLowerInvariant()] = $true } } }
    } elseif (Test-VxWindows) {
        $sid = -1
        try { $sid = [Diagnostics.Process]::GetCurrentProcess().SessionId } catch { $null = $_ }
        foreach ($n in $Names) {
            try {
                foreach ($p in [Diagnostics.Process]::GetProcessesByName($n)) {
                    try { if ($sid -lt 0 -or $p.SessionId -eq $sid) { $running[$n.ToLowerInvariant()] = $true } } catch { $null = $_ }
                    $p.Dispose()
                }
            } catch { $null = $_ }
        }
    }
    foreach ($n in $Names) {
        if ($running.ContainsKey($n.ToLowerInvariant())) {
            $l = Get-VxAppLabel $n
            if (-not $labels.Contains($l)) { $labels.Add($l) }
        }
    }
    return $labels.ToArray()
}

# ================================================================== measuring

# Deterministic fake size for simulate mode off Windows (no fixture).
function Get-VxFakeCleanSize([string]$Seed) {
    $h = Get-VxShortHash $Seed
    $n = [Convert]::ToInt64($h.Substring(0, 6), 16)
    $bytes = [long](20MB + ($n % 1500) * 1MB)
    return @{ bytes = $bytes; files = [int]($bytes / 180KB) }
}

# Measures what one tweak would free. $Seen (HashSet) makes a root that two items share count once.
# Returns @{ bytes; files; found; partial; measurable }.
function Measure-VxCleanTweak($Tweak, $Seen = $null, [int]$MaxMs = 15000) {
    $ctx = $global:VxCtx
    $total = @{ bytes = [long]0; files = 0; found = $false; partial = $false; measurable = $false }
    $fx = Get-VxCleanFixture
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $vars = Get-VxCleanVars
    $allow = Get-VxCleanAllowList
    foreach ($a in @($Tweak.actions)) {
        $paths = @(Get-VxCleanMeasurePaths $a)
        if ($paths.Count -eq 0) { continue }
        $total.measurable = $true
        if (-not $ctx.Windows -and -not $fx) {
            $f = Get-VxFakeCleanSize ([string]$Tweak.id + '|' + ($paths -join ';'))
            $total.bytes += $f.bytes; $total.files += $f.files; $total.found = $true
            continue
        }
        $keep = @(@(Get-VxProp $a 'keep' @()) | ForEach-Object { [string]$_ })
        $cutoff = Get-VxCleanCutoff $a
        foreach ($p in $paths) {
            foreach ($r in @(Resolve-VxCleanRoots $p $vars)) {
                $key = (ConvertTo-VxCmpPath $r.root) + '|' + [string]$r.filter
                if ($null -ne $Seen) { if (-not $Seen.Add($key)) { continue } }
                try {
                    $items = @(Get-VxCleanTopItems $r $keep $allow)
                    $lr = Get-VxLongPath $r.root
                    if ([IO.Directory]::Exists($lr) -or [IO.File]::Exists((Get-VxLongPath $r.expanded))) { $total.found = $true }
                    if ($items.Count -eq 0) { continue }
                    $left = [int]($MaxMs - $sw.ElapsedMilliseconds)
                    if ($left -le 0) { $total.partial = $true; continue }
                    $w = Invoke-VxCleanWalk $items $false $left $null $null $cutoff
                    $total.bytes += $w.bytes; $total.files += $w.files
                    if ($w.partial) { $total.partial = $true }
                } catch {
                    if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
                    Write-VxFileLog 'warn' ("{0}: {1}" -f $p, $_.Exception.Message)
                }
            }
        }
    }
    return $total
}

function Invoke-VxCleanJob($Params) {
    $list = @(Get-VxCleanTweaks)
    $items = New-Object System.Collections.ArrayList
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $budgetMs = 120000
    $n = 0
    foreach ($t in $list) {
        Test-VxCancel
        $n++
        Set-VxProgress ($n / [math]::Max(1, $list.Count) * 0.95) ('Messe: ' + $t.name)
        $left = [int]($budgetMs - $sw.ElapsedMilliseconds)
        $per = [math]::Max(1500, [math]::Min(15000, $left))
        $m = Measure-VxCleanTweak $t $seen $per
        $running = @(Get-VxRunningApps (Get-VxCleanApps $t))
        [void]$items.Add([ordered]@{ id = [string]$t.id; bytes = [long]$m.bytes; files = [int]$m.files; found = [bool]$m.found; partial = [bool]$m.partial; measurable = [bool]$m.measurable; running = $running })
    }
    $sum = [long]0
    foreach ($i in $items) { $sum += $i.bytes }
    Write-VxLog 'ok' ('Gefunden: ' + (Format-VxBytes $sum) + ' können aufgeräumt werden.')
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ items = $items.ToArray(); totalBytes = $sum }
}

# ================================================================== services

function Stop-VxServicesForClean([string[]]$Names) {
    $stopped = @()
    foreach ($n in $Names) {
        try {
            $s = Get-Service -Name $n -ErrorAction Stop
            if ($s.Status -eq 'Running') {
                $null = Invoke-VxNative -FilePath (Get-VxSystemTool 'sc.exe') -Arguments @('stop', $n) -TimeoutSec 20
                for ($i = 0; $i -lt 30; $i++) {
                    $s.Refresh()
                    if ($s.Status -eq 'Stopped') { break }
                    Start-Sleep -Milliseconds 500
                }
                $stopped += $n
            }
        } catch { Write-VxLog 'warn' ("Dienst {0} konnte nicht gestoppt werden: {1}" -f $n, $_.Exception.Message) }
    }
    return $stopped
}

# ================================================================== tools (DISM, SFC, CHKDSK, cleanmgr)

# What a tool runs. DISM always gets /NoRestart: without it DISM asks "Restart now? (Y/N)" when an
# operation needs a reboot - nobody can answer that prompt here, and it must never restart the PC.
# timeoutSec: generous but finite; stallSec: no new percent/output for that long
# -> the step says that Windows is busy (a pending update or the Windows Modules Installer).
function Get-VxToolSpec([string]$Tool) {
    $sd = [string]$env:SystemDrive
    if (-not $sd) { $sd = 'C:' }
    switch ($Tool) {
        'dism-scanhealth' { return @{ id = $Tool; exe = 'dism.exe'; args = @('/Online', '/Cleanup-Image', '/ScanHealth', '/NoRestart'); parser = 'dism'; timeoutSec = 2700; stallSec = 600; name = 'DISM'; step = 'DISM prüft das Windows-Abbild' } }
        'dism-restorehealth' { return @{ id = $Tool; exe = 'dism.exe'; args = @('/Online', '/Cleanup-Image', '/RestoreHealth', '/NoRestart'); parser = 'dism'; timeoutSec = 5400; stallSec = 600; name = 'DISM'; step = 'DISM repariert das Windows-Abbild' } }
        'dism-component-cleanup' { return @{ id = $Tool; exe = 'dism.exe'; args = @('/Online', '/Cleanup-Image', '/StartComponentCleanup', '/NoRestart'); parser = 'dism'; timeoutSec = 3600; stallSec = 600; name = 'DISM'; step = 'DISM räumt alte Update-Reste auf'; diskDelta = $true } }
        'dism-component-resetbase' { return @{ id = $Tool; exe = 'dism.exe'; args = @('/Online', '/Cleanup-Image', '/StartComponentCleanup', '/ResetBase', '/NoRestart'); parser = 'dism'; timeoutSec = 5400; stallSec = 600; name = 'DISM'; step = 'DISM entfernt Update-Reste endgültig'; diskDelta = $true } }
        'sfc-scannow' { return @{ id = $Tool; exe = 'sfc.exe'; args = @('/scannow'); parser = 'sfc'; timeoutSec = 3600; stallSec = 600; name = 'SFC'; step = 'SFC prüft die Systemdateien' } }
        'chkdsk-scan' { return @{ id = $Tool; exe = 'chkdsk.exe'; args = @($sd, '/scan'); parser = 'chkdsk'; timeoutSec = 2700; stallSec = 600; name = 'CHKDSK'; step = ('CHKDSK prüft Laufwerk ' + $sd) } }
        'cleanmgr-windows-old' { return @{ id = $Tool; exe = 'cleanmgr.exe'; args = @('/sagerun:9417'); parser = 'none'; timeoutSec = 3600; stallSec = 0; name = 'Datenträgerbereinigung'; step = 'Die Datenträgerbereinigung entfernt alte Windows-Installationen'; diskDelta = $true; sageId = 9417
                handlers = @('Previous Installations', 'Temporary Setup Files', 'Setup Log Files', 'Windows Upgrade Log Files') } }
    }
    return $null
}

# Reader state for a tool's output: bytes -> text (OEM code page, or UTF-16LE when the tool writes
# wide characters into the pipe like sfc.exe does), split on \r and \n (DISM and SFC redraw their
# progress with a bare \r), live percent, the last lines for the result.
function New-VxToolReader([string]$Parser, $Encoding = $null) {
    return @{ parser = $Parser; encoding = $Encoding; decoder = $null; head = (New-Object System.Collections.Generic.List[byte]); pending = ''
        lines = (New-Object System.Collections.Generic.List[string]); percent = -1.0; lastChange = [DateTime]::UtcNow; chars = 0 }
}

# Percent in one output segment, -1 when there is none.
#   DISM   "[=====     42.3%      ]"            SFC "Verification 45% complete." / "Überprüfung 45 % abgeschlossen."
#   CHKDSK "Progress: 9 of 100 done; Stage: 26%; Total: 9%; ..." (German "Gesamt: 9 %")
function Get-VxToolPercent([string]$Parser, [string]$Text) {
    if (-not $Text -or $Text.IndexOf('%') -lt 0) { return -1.0 }
    if ($Parser -eq 'chkdsk') {
        $m = [regex]::Match($Text, '(?i)(Total|Gesamt|Insgesamt)\s*:\s*(\d{1,3})\s*%')
        if ($m.Success) { return [double]$m.Groups[2].Value }
    }
    $all = [regex]::Matches($Text, '(\d{1,3}(?:[.,]\d+)?)\s*%')
    if ($all.Count -eq 0) { return -1.0 }
    $v = 0.0
    $s = $all[$all.Count - 1].Groups[1].Value.Replace(',', '.')
    if (-not [double]::TryParse($s, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) { return -1.0 }
    if ($v -lt 0 -or $v -gt 100) { return -1.0 }
    return $v
}

function Test-VxToolBarOnly([string]$Text) {
    return ($Text -match '^\s*\[[=\s\-]*\d{1,3}(?:[.,]\d+)?\s*%[=\s\-]*\]\s*$')
}

function Add-VxToolText($Reader, [string]$Text) {
    if (-not $Text) { return }
    $Reader.chars += $Text.Length
    $buf = $Reader.pending + $Text.Replace([string][char]0xFEFF, '').Replace([string][char]0, '')
    $parts = $buf.Split([char[]]@("`r", "`n"))
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
        $seg = $parts[$i]
        $pc = Get-VxToolPercent $Reader.parser $seg
        if ($pc -ge 0) {
            if ($pc -ne $Reader.percent) { $Reader.percent = $pc; $Reader.lastChange = [DateTime]::UtcNow }
            if (Test-VxToolBarOnly $seg) { continue }
        }
        $t = $seg.Trim()
        if ($t) {
            $Reader.lines.Add($t)
            $Reader.lastChange = [DateTime]::UtcNow
            if ($Reader.lines.Count -gt 400) { $Reader.lines.RemoveAt(0) }
        }
    }
    $Reader.pending = $parts[$parts.Count - 1]
    # an unfinished segment: DISM writes "\r[== 42.3% ]" and only ends it with the next \r. The
    # percent sign arrives after all digits, so a complete number can be read already.
    $pt = Get-VxToolPercent $Reader.parser $Reader.pending
    if ($pt -ge 0 -and $pt -ne $Reader.percent) { $Reader.percent = $pt; $Reader.lastChange = [DateTime]::UtcNow }
    if ($Reader.pending.Length -gt 4096) { $Reader.pending = $Reader.pending.Substring($Reader.pending.Length - 1024) }
}

# Feeds raw bytes. The encoding is decided on the first two bytes when none is given: a zero in the
# second byte (or a FF FE BOM) means UTF-16LE (sfc.exe writes wide characters into a pipe);
# otherwise the OEM code page. The decoder keeps state, so a character split across reads survives.
function Add-VxToolBytes($Reader, [byte[]]$Bytes, [int]$Count) {
    if ($Count -le 0) { return }
    if ($null -eq $Reader.decoder) {
        for ($i = 0; $i -lt $Count; $i++) { $Reader.head.Add($Bytes[$i]) }
        if ($null -eq $Reader.encoding) {
            if ($Reader.head.Count -lt 2) { return }
            $b0 = $Reader.head[0]; $b1 = $Reader.head[1]
            if (($b0 -eq 0xFF -and $b1 -eq 0xFE) -or ($b1 -eq 0 -and $b0 -ne 0)) { $Reader.encoding = New-Object System.Text.UnicodeEncoding($false, $false) }
            else { $Reader.encoding = Get-VxOemEncoding }
        }
        $Reader.decoder = $Reader.encoding.GetDecoder()
        $all = $Reader.head.ToArray()
        $Reader.head.Clear()
        $chars = New-Object char[] ($all.Length + 2)
        $n = $Reader.decoder.GetChars($all, 0, $all.Length, $chars, 0)
        Add-VxToolText $Reader (New-Object string($chars, 0, $n))
        return
    }
    $cbuf = New-Object char[] ($Count + 2)
    $cn = $Reader.decoder.GetChars($Bytes, 0, $Count, $cbuf, 0)
    Add-VxToolText $Reader (New-Object string($cbuf, 0, $cn))
}

function Format-VxElapsed([int]$Sec) { return ('{0}:{1:00}' -f [int][math]::Floor($Sec / 60), ($Sec % 60)) }

# Step text + progress while a tool runs. $Slot = @{ base; span; step } of the current item.
function Update-VxToolProgress($Slot, $Reader, [int]$Sec, [int]$StallSec, [string]$Name) {
    $job = $global:VxJob
    if ($null -eq $job) { return }
    $text = [string]$Slot.step
    $pct = [double]$Reader.percent
    if ($pct -ge 0) {
        $text += ' – ' + (Format-VxNumber $pct 1) + ' %'
        Set-VxProgress ([double]$Slot.base + [double]$Slot.span * ($pct / 100.0))
    }
    $text += ' · ' + (Format-VxElapsed $Sec)
    $note = ''
    $idle = [int]([DateTime]::UtcNow - [DateTime]$Reader.lastChange).TotalSeconds
    if ($StallSec -gt 0 -and $idle -ge $StallSec) {
        $note = ('{0} wartet auf Windows (seit {1} Min. keine neue Meldung). Das ist normal, wenn im Hintergrund ein Update installiert wird.' -f $Name, [int][math]::Floor($idle / 60))
        $text += ' · wartet auf Windows'
    }
    Set-VxProgress -Step $text
    $live = $job.live
    if ($null -ne $live) {
        $live.percent = [math]::Round($pct, 1)
        $live.elapsedSec = $Sec
        $live.note = $note
        if ($pct -ge 0) { $live.progress = [math]::Round($pct / 100.0, 3) }
    }
}

# Runs a tool as its own process and reads its output live. Never blocks: the pipe is read with
# ReadAsync and only completed reads are looked at (rule 15). Abbrechen / Überspringen / timeout
# end the whole process tree (DISM starts DismHost.exe). Returns
# @{ exitCode; reader; timedOut; skipped; error; ms }. Throws VX_CANCELLED on cancel.
function Invoke-VxToolProcess([string]$FilePath, [string[]]$Arguments, [string]$Parser, [int]$TimeoutSec, $Slot, [int]$StallSec = 600, [string]$Name = '', $Encoding = $null) {
    $job = $global:VxJob
    $reader = New-VxToolReader $Parser $Encoding
    $res = @{ exitCode = -1; reader = $reader; timedOut = $false; skipped = $false; error = ''; ms = 0 }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-VxArgument ([string]$_) }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = $null
    $cancelled = $false
    try {
        try { $p = [System.Diagnostics.Process]::Start($psi) }
        catch { $res.error = ('{0} konnte nicht gestartet werden: {1}' -f $Name, $_.Exception.Message); return $res }
        try { $p.StandardInput.Close() } catch { $null = $_ }
        $stream = $p.StandardOutput.BaseStream
        $errTask = $p.StandardError.ReadToEndAsync()
        $buf = New-Object byte[] 8192
        $task = $stream.ReadAsync($buf, 0, $buf.Length)
        $eof = $false
        $lastTick = -1
        while ($true) {
            # take everything that is already there
            while (-not $eof -and $task.IsCompleted) {
                $n = 0
                if ($task.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) { $n = [int]$task.Result }
                if ($n -le 0) { $eof = $true; break }
                Add-VxToolBytes $reader $buf $n
                $task = $stream.ReadAsync($buf, 0, $buf.Length)
            }
            if ($eof -and $p.HasExited) { break }
            if ($p.HasExited -and -not $eof) {
                # exited: give the pipe a moment to deliver the rest (a grandchild may hold it open)
                if ($task.Wait(1500)) { continue }
                break
            }
            if ($null -ne $job -and $job.cancel) { $cancelled = $true; break }
            if ($null -ne $job -and $job.skip -and $job.skippable) { $res.skipped = $true; break }
            $sec = [int][math]::Floor($sw.Elapsed.TotalSeconds)
            if ($sec -ge $TimeoutSec) { $res.timedOut = $true; break }
            $tick = [int][math]::Floor($sw.ElapsedMilliseconds / 500)
            if ($tick -ne $lastTick) { $lastTick = $tick; Update-VxToolProgress $Slot $reader $sec $StallSec $Name }
            if (-not $eof) { try { [void]$task.Wait(200) } catch { $null = $_ } } else { [void]$p.WaitForExit(200) }
        }
        if ($cancelled -or $res.skipped -or $res.timedOut) {
            Stop-VxProcessTree $p
        } else {
            [void]$p.WaitForExit(5000)
            try { $res.exitCode = $p.ExitCode } catch { $res.exitCode = -1 }
            if ($errTask.Wait(2000)) { $res.error = ([string]$errTask.Result).Trim() }
        }
        # the tail of a segment that never got its line end
        if ($reader.pending.Trim() -and -not (Test-VxToolBarOnly $reader.pending)) { $reader.lines.Add($reader.pending.Trim()) }
        $reader.pending = ''
    } finally {
        if ($null -ne $p) { try { $p.Dispose() } catch { $null = $_ } }
        $res.ms = [int]$sw.ElapsedMilliseconds
    }
    if ($cancelled) { throw 'VX_CANCELLED' }
    return $res
}

# Fake output of a tool for the Testmodus: fed through the same reader (bytes, \r progress, SFC as
# UTF-16LE), so the overlay shows live percent and tests can assert it. $ctx.TestToolMs = duration.
function Get-VxToolSimChunks($Spec) {
    $chunks = New-Object System.Collections.ArrayList
    $oem = Get-VxOemEncoding
    $uni = New-Object System.Text.UnicodeEncoding($false, $false)
    switch ($Spec.parser) {
        'dism' {
            [void]$chunks.Add($oem.GetBytes("`r`nTool zur Imageverwaltung für die Bereitstellung`r`nVersion: 10.0.22621.2792`r`n`r`nAbbildversion: 10.0.22631.4317`r`n`r`n"))
            foreach ($p in @(0, 4.2, 10.1, 21.7, 33.3, 47.9, 62.3, 62.3, 78.4, 89.0, 100)) {
                $bar = ('=' * [int]($p / 2)).PadRight(50)
                $s = ('{0:0.0}%' -f $p).Replace(',', '.')
                [void]$chunks.Add($oem.GetBytes("`r[" + $bar.Substring(0, 23) + $s + $bar.Substring(23 + [math]::Min(27, $s.Length)) + ']'))
            }
            $tail = "`r`n"
            if ($Spec.id -eq 'dism-scanhealth') { $tail += "Es wurde keine Komponentenspeicherbeschädigung erkannt.`r`n" }
            $tail += "Der Vorgang wurde erfolgreich beendet.`r`n"
            [void]$chunks.Add($oem.GetBytes($tail))
        }
        'sfc' {
            [void]$chunks.Add($uni.GetBytes("`r`nSystemüberprüfung wird gestartet. Dieser Vorgang wird einige Zeit in Anspruch nehmen.`r`n`r`nDie Überprüfungsphase der Systemüberprüfung wird gestartet.`r`n"))
            foreach ($p in @(0, 5, 12, 26, 38, 51, 67, 80, 93, 100)) { [void]$chunks.Add($uni.GetBytes("`rÜberprüfung $p % abgeschlossen.")) }
            [void]$chunks.Add($uni.GetBytes("`r`n`r`nDer Windows-Ressourcenschutz hat keine Integritätsverletzungen gefunden.`r`n"))
        }
        'chkdsk' {
            [void]$chunks.Add($oem.GetBytes("Der Typ des Dateisystems ist NTFS.`r`n`r`nPhase 1: Die grundlegende Dateisystemstruktur wird untersucht ...`r`n"))
            foreach ($p in @(3, 14, 30, 45, 61, 77, 92, 100)) { [void]$chunks.Add($oem.GetBytes("`r  Fortschritt: $p von 100 erledigt; Phase: $p %; Gesamt: $p %; Verbleibend: 0:00:01 ...")) }
            [void]$chunks.Add($oem.GetBytes("`r`nWindows hat das Dateisystem überprüft und keine Probleme festgestellt.`r`n"))
        }
        default { foreach ($i in 1..8) { [void]$chunks.Add([byte[]]@()) } }
    }
    return $chunks.ToArray()
}

function Invoke-VxToolSim($Spec, $Slot) {
    $job = $global:VxJob
    $ms = 2400
    $ctx = $global:VxCtx
    if ($ctx.ContainsKey('TestToolMs') -and $null -ne $ctx.TestToolMs) { $ms = [int]$ctx.TestToolMs }
    elseif ($env:VELOX_SIM_TOOL_MS) { $ms = [int]$env:VELOX_SIM_TOOL_MS }
    $enc = $null
    if ($Spec.parser -ne 'sfc') { $enc = Get-VxOemEncoding }
    $reader = New-VxToolReader $Spec.parser $enc
    $res = @{ exitCode = 0; reader = $reader; timedOut = $false; skipped = $false; error = ''; ms = 0 }
    $chunks = @(Get-VxToolSimChunks $Spec)
    $wait = [int]($ms / [math]::Max(1, $chunks.Count))
    $sw = [Diagnostics.Stopwatch]::StartNew()
    foreach ($c in $chunks) {
        if ($null -ne $job -and $job.cancel) { throw 'VX_CANCELLED' }
        if ($null -ne $job -and $job.skip -and $job.skippable) { $res.skipped = $true; $res.exitCode = -1; break }
        $bytes = [byte[]]$c
        if ($bytes.Length -gt 0) { Add-VxToolBytes $reader $bytes $bytes.Length }
        Update-VxToolProgress $Slot $reader ([int]$sw.Elapsed.TotalSeconds) 0 $Spec.name
        if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    }
    if ($reader.pending.Trim()) { $reader.lines.Add($reader.pending.Trim()); $reader.pending = '' }
    $res.ms = [int]$sw.ElapsedMilliseconds
    return $res
}

function Format-VxHresult([int]$Code) { return ('0x{0:X8}' -f $Code) }

# The last error lines DISM printed ("Error: 0x800f081f" / "Fehler: ..." and the line after it).
function Get-VxDismErrorLines($Reader) {
    $out = @()
    $lines = @($Reader.lines.ToArray())
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^(?i)(Error|Fehler)\s*:') {
            $out = @($lines[$i])
            if ($i + 1 -lt $lines.Count -and $lines[$i + 1] -notmatch '(?i)dism\.log') { $out += $lines[$i + 1] }
        }
    }
    return ($out -join ' ')
}

function Get-VxDismCodeText([int]$Code) {
    switch ($Code) {
        -2146498554 { return 'Ein Windows-Update wartet auf einen Neustart. Starte den PC neu und versuche es danach noch einmal.' }       # 0x800F0806
        -2146498529 { return 'DISM hat keine Ersatzdateien gefunden. Prüfe die Internetverbindung und ob Windows Update funktioniert, dann noch einmal versuchen.' }  # 0x800F081F
        -2146498298 { return 'DISM konnte die Ersatzdateien nicht herunterladen. Prüfe die Internetverbindung und versuche es später noch einmal.' }  # 0x800F0906
        -2146498530 { return 'Dieser DISM-Schritt passt nicht zu diesem Windows.' }   # 0x800F081E
        87 { return 'DISM kennt diesen Befehl auf diesem Windows nicht.' }
        740 { return 'DISM braucht Administratorrechte. Starte VELOX als Administrator.' }
        1726 { return 'Der Windows-Modulinstaller hat nicht geantwortet. Starte den PC neu und versuche es noch einmal.' }
        1727 { return 'Der Windows-Modulinstaller hat nicht geantwortet. Starte den PC neu und versuche es noch einmal.' }
        1392 { return 'Eine Windows-Datei ist beschädigt. Führe zuerst „Windows-Abbild reparieren (DISM)“ aus.' }
    }
    return ''
}

# German outcome of a finished tool. Returns @{ ok; message; reboot }.
function Get-VxToolOutcome($Spec, [int]$Code, $Reader) {
    $o = @{ ok = $false; message = ''; reboot = $false }
    $text = (@($Reader.lines.ToArray()) -join "`n")
    switch ($Spec.parser) {
        'dism' {
            if ($Code -eq 0 -or $Code -eq 3010) {
                $o.ok = $true
                $o.reboot = ($Code -eq 3010)
                $o.message = 'Fertig, ohne Fehler'
                if ($Spec.id -eq 'dism-scanhealth') {
                    if ($text -match '(?i)cannot be repaired|nicht repariert werden') { $o.ok = $false; $o.message = 'Der Komponentenspeicher ist nicht mehr reparierbar. Hier hilft nur eine Reparatur-Installation von Windows (Inplace-Upgrade).' }
                    elseif ($text -match '(?i)is repairable|kann repariert werden') { $o.ok = $false; $o.message = 'Der Komponentenspeicher hat Fehler. Starte jetzt „Windows-Abbild reparieren (DISM)“ und danach SFC.' }
                    elseif ($text -match '(?i)No component store corruption|keine Komponentenspeicherbesch') { $o.message = 'Keine Fehler im Windows-Abbild gefunden' }
                }
                if ($Spec.id -eq 'dism-restorehealth') { $o.message = 'Windows-Abbild repariert bzw. in Ordnung. Starte jetzt SFC, um die Systemdateien zu prüfen.' }
                if ($o.reboot) { $o.message += ' – Neustart nötig, damit alles wirkt' }
            } else {
                $t = Get-VxDismCodeText $Code
                if (-not $t) { $t = 'DISM meldet einen Fehler.' }
                $detail = Get-VxDismErrorLines $Reader
                $o.message = ('{0} (Code {1}){2}' -f $t, (Format-VxHresult $Code), $(if ($detail) { ' – ' + $detail } else { '' }))
            }
        }
        'sfc' {
            if ($text -match '(?i)repair pending|Systemreparatur steht aus|Neustart erforderlich') { $o.message = 'Eine Systemreparatur wartet auf einen Neustart. Starte den PC neu und führe SFC danach noch einmal aus.' }
            elseif ($text -match '(?i)unable to fix|einige davon nicht|nicht alle .*reparieren|konnte .* nicht reparieren') { $o.message = 'SFC hat beschädigte Dateien gefunden, konnte aber nicht alle reparieren. Führe zuerst „Windows-Abbild reparieren (DISM)“ aus und dann SFC noch einmal.' }
            elseif ($text -match '(?i)successfully repaired|erfolgreich repariert') { $o.ok = $true; $o.reboot = $true; $o.message = 'SFC hat beschädigte Dateien gefunden und repariert – starte den PC neu.' }
            elseif ($text -match '(?i)did not find any integrity|keine Integritätsverletzungen') { $o.ok = $true; $o.message = 'Keine beschädigten Systemdateien gefunden' }
            elseif ($text -match '(?i)could not perform|konnte den angeforderten Vorgang nicht') { $o.message = 'SFC konnte die Prüfung nicht ausführen. Starte den PC neu und versuche es noch einmal; hilft das nicht, führe zuerst DISM aus.' }
            elseif ($text -match '(?i)must be an administrator|Administrator') { $o.message = 'SFC braucht Administratorrechte. Starte VELOX als Administrator.' }
            elseif ($Code -eq 0) { $o.ok = $true; $o.message = 'Fertig, ohne Fehler' }
            else { $o.message = ('SFC meldet Code {0}. Details stehen in {1}\Logs\CBS\CBS.log.' -f $Code, [string]$env:SystemRoot) }
        }
        'chkdsk' {
            if ($Code -le 2 -and $Code -ge 0) { $o.ok = $true; $o.message = 'Keine Probleme im Dateisystem gefunden' }
            if ($Code -eq 1) { $o.message = 'Kleine Fehler im Dateisystem gefunden und behoben' }
            if ($Code -ge 3 -or $Code -lt 0) {
                $sd = [string]$env:SystemDrive
                $o.message = ('CHKDSK hat Fehler gefunden, die erst beim Neustart behoben werden können (Code {0}). Öffne eine Eingabeaufforderung als Admin, tippe chkdsk {1} /spotfix und starte neu.' -f $Code, $sd)
            }
        }
        default {
            if ($Code -eq 0) { $o.ok = $true; $o.message = 'Fertig' } else { $o.message = ('{0} meldet Code {1}.' -f $Spec.name, $Code) }
        }
    }
    return $o
}

# A reboot-pending update / the Windows Modules Installer at work make DISM wait or fail: say so first.
function Write-VxToolPrecheck($Spec) {
    if (-not (Test-VxWindows) -or $global:VxCtx.Simulate) { return }
    if ($Spec.parser -ne 'dism' -and $Spec.parser -ne 'sfc') { return }
    try {
        if (Test-VxRealRegKey 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') {
            Write-VxLog 'warn' ('Windows wartet auf einen Neustart nach einem Update. {0} kann deshalb lange warten oder abbrechen – im Zweifel erst neu starten.' -f $Spec.name)
        }
    } catch { $null = $_ }
    try {
        $tw = @([Diagnostics.Process]::GetProcessesByName('TiWorker'))
        if ($tw.Count -gt 0) { Write-VxLog 'info' ('Windows installiert gerade im Hintergrund (Windows-Modulinstaller). {0} wartet, bis das fertig ist.' -f $Spec.name) }
        foreach ($x in $tw) { $x.Dispose() }
    } catch { $null = $_ }
}

function Get-VxFreeBytes {
    try {
        $sd = [string]$env:SystemDrive
        if (-not $sd) { $sd = 'C:' }
        return [long](New-Object IO.DriveInfo($sd.Substring(0, 1))).AvailableFreeSpace
    } catch { return [long]-1 }
}

# cleanmgr /sagerun reads which handlers to run from StateFlags<id> under VolumeCaches.
function Set-VxSageFlags($Spec, [bool]$On) {
    $base = 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches\'
    $name = 'StateFlags' + ([string]$Spec.sageId).PadLeft(4, '0')
    foreach ($h in @($Spec.handlers)) {
        try {
            $k = Open-VxRealKey ($base + $h) $true $false
            if ($null -eq $k) { continue }
            try {
                if ($On) { $k.SetValue($name, 2, [Microsoft.Win32.RegistryValueKind]::DWord) }
                else { $k.DeleteValue($name, $false) }
            } finally { $k.Close() }
        } catch { Write-VxFileLog 'warn' ('cleanmgr ' + $h + ': ' + $_.Exception.Message) }
    }
}

# Runs one "tool" action. Returns @{ ok; message; freedBytes; skipped; timedOut; reboot; percent }.
function Invoke-VxToolAction($Tweak, $Action, $Slot) {
    $ctx = $global:VxCtx
    $tool = [string](Get-VxProp $Action 'tool')
    $spec = Get-VxToolSpec $tool
    $out = @{ ok = $false; message = ''; freedBytes = [long]0; skipped = $false; timedOut = $false; reboot = $false; percent = -1 }
    if ($null -eq $spec) { $out.message = ('Unbekanntes Werkzeug: {0}' -f $tool); return $out }
    $timeout = [int](Get-VxProp $Action 'timeoutSec' $spec.timeoutSec)
    $Slot.step = $spec.step
    $mins = [int][math]::Round($timeout / 60)
    Write-VxLog 'info' ('{0} gestartet. Das kann dauern – der PC bleibt benutzbar. Spätestens nach {1} Minuten bricht VELOX ab.' -f $spec.name, $mins)
    Write-VxToolPrecheck $spec
    $measureBefore = $null
    $freeBefore = [long]-1
    if (@(Get-VxProp $Action 'measure' @()).Count -gt 0) { $measureBefore = Measure-VxCleanTweak ([pscustomobject]@{ id = $Tweak.id; actions = @($Action) }) $null 20000 }
    $r = $null
    if ($ctx.Simulate) {
        $r = Invoke-VxToolSim $spec $Slot
    } else {
        if ($spec.diskDelta) { $freeBefore = Get-VxFreeBytes }
        if ($spec.ContainsKey('handlers')) { Set-VxSageFlags $spec $true }
        try {
            $r = Invoke-VxToolProcess (Get-VxSystemTool $spec.exe) $spec.args $spec.parser $timeout $Slot $spec.stallSec $spec.name
        } finally { if ($spec.ContainsKey('handlers')) { Set-VxSageFlags $spec $false } }
    }
    $out.percent = $r.reader.percent
    if ($r.skipped) {
        $out.skipped = $true; $out.ok = $true
        $out.message = ('Übersprungen – {0} wurde beendet. Windows bleibt dabei heil; starte es später einfach noch einmal.' -f $spec.name)
        return $out
    }
    if ($r.timedOut) {
        $out.timedOut = $true
        $out.message = ('{0} hat nach {1} Minuten nicht fertig gemeldet und wurde beendet. Starte den PC neu und versuche es noch einmal – oft blockiert ein wartendes Windows-Update.' -f $spec.name, $mins)
        return $out
    }
    if ($r.exitCode -eq -1 -and $r.error -and $r.reader.chars -eq 0) { $out.message = $r.error; return $out }
    $o = Get-VxToolOutcome $spec $r.exitCode $r.reader
    $out.ok = [bool]$o.ok; $out.message = $o.message; $out.reboot = [bool]$o.reboot
    if ($out.reboot) { Add-VxNeeds 'reboot' }
    # DISM ScanHealth: when the text was in an unknown language, ask the image state language-independently
    if ($spec.id -eq 'dism-scanhealth' -and $out.ok -and $out.message -eq 'Fertig, ohne Fehler' -and -not $ctx.Simulate) {
        $chk = Invoke-VxIsolated -Script '$r = Repair-WindowsImage -Online -CheckHealth -ErrorAction Stop; Write-Output ([string]$r.ImageHealthState)' -TimeoutSec 120
        if ($chk.ok -and $chk.output -match 'NonRepairable') { $out.ok = $false; $out.message = 'Der Komponentenspeicher ist nicht mehr reparierbar. Hier hilft nur eine Reparatur-Installation von Windows (Inplace-Upgrade).' }
        elseif ($chk.ok -and $chk.output -match 'Repairable') { $out.ok = $false; $out.message = 'Der Komponentenspeicher hat Fehler. Starte jetzt „Windows-Abbild reparieren (DISM)“ und danach SFC.' }
        elseif ($chk.ok -and $chk.output -match 'Healthy') { $out.message = 'Keine Fehler im Windows-Abbild gefunden' }
    }
    if ($null -ne $measureBefore) {
        if ($ctx.Simulate) { $out.freedBytes = [long]$measureBefore.bytes }
        else {
            $after = Measure-VxCleanTweak ([pscustomobject]@{ id = $Tweak.id; actions = @($Action) }) $null 20000
            $out.freedBytes = [math]::Max([long]0, [long]$measureBefore.bytes - [long]$after.bytes)
        }
    } elseif ($spec.diskDelta -and $freeBefore -ge 0) {
        $out.freedBytes = [math]::Max([long]0, (Get-VxFreeBytes) - $freeBefore)
    }
    return $out
}

# ================================================================== running actions

# Runs a kind "action" tweak (clean, tool and/or ps actions). $Opts: @{ optIn = bool; seen = HashSet;
# slot = @{ base; span; step } }. Returns @{ ok; freedBytes; message; deleted; locked; skipped;
# running; status = ok|partial|skipped|failed }.
function Invoke-VxRunAction($Tweak, $J = $null, $Opts = $null) {
    $ctx = $global:VxCtx
    $job = $global:VxJob
    if ($null -eq $Opts) { $Opts = @{} }
    $slot = Get-VxProp $Opts 'slot' $null
    if ($null -eq $slot) { $slot = @{ base = 0.0; span = 1.0; step = [string]$Tweak.name } }
    $seen = Get-VxProp $Opts 'seen' $null
    $freed = [long]0
    $msgs = New-Object System.Collections.Generic.List[string]
    $ok = $true
    $skippedStep = $false
    $deleted = 0; $locked = 0; $tooLong = 0; $refused = 0; $young = 0; $youngHours = 0
    $res = @{ ok = $true; freedBytes = [long]0; message = ''; deleted = 0; locked = 0; skipped = $false; running = @(); status = 'ok' }
    if ((Get-VxCleanTier $Tweak) -eq 'optin' -and -not [bool](Get-VxProp $Opts 'optIn' $false)) {
        $res.ok = $false; $res.skipped = $true; $res.status = 'skipped'
        $res.message = 'Nicht ausgeführt: Dieser Punkt braucht deine ausdrückliche Bestätigung („Alles“ mit Häkchen).'
        return $res
    }
    $apps = @(Get-VxCleanApps $Tweak)
    if ($apps.Count -gt 0) {
        $run = @(Get-VxRunningApps $apps)
        if ($run.Count -gt 0) {
            $res.running = $run
            $res.skipped = $true; $res.status = 'skipped'
            $res.message = ('Übersprungen: {0} läuft gerade. Schließe {1} ganz (auch im Infobereich) und starte die Reinigung noch einmal.' -f ($run -join ', '), $(if ($run.Count -eq 1) { 'das Programm' } else { 'die Programme' }))
            return $res
        }
    }
    if ($null -eq $global:VxCleanLocked) { Initialize-VxCleanLocked }
    $fx = Get-VxCleanFixture
    $live = $null
    if ($null -ne $job) { $live = $job.live }
    $vars = Get-VxCleanVars
    $allow = Get-VxCleanAllowList
    foreach ($a in @($Tweak.actions)) {
        $type = [string](Get-VxProp $a 'type')
        if ($null -ne $job) { $job.skip = $false; $job.skippable = $true }
        try {
            if ($type -eq 'clean') {
                $paths = @(@($a.paths) | ForEach-Object { [string]$_ })
                if ($null -ne $J) { Add-VxJournalEntry $J ([ordered]@{ op = 'clean'; tweakId = [string]$Tweak.id; paths = $paths; restorable = $false }) }
                if ($ctx.Simulate -and -not $fx) {
                    $m = Measure-VxCleanTweak ([pscustomobject]@{ id = $Tweak.id; actions = @($a) }) $seen
                    $freed += $m.bytes
                    $msgs.Add('Testmodus: nichts gelöscht (wären ' + (Format-VxBytes $m.bytes) + ')')
                    if ($null -ne $live) { $live.freed = [long]$live.freed + [long]$m.bytes; $live.files = [int]$live.files + [int]$m.files }
                    continue
                }
                $keep = @(@(Get-VxProp $a 'keep' @()) | ForEach-Object { [string]$_ })
                $cutoff = Get-VxCleanCutoff $a
                if ($cutoff -gt [DateTime]::MinValue) { $youngHours = [int](Get-VxProp $a 'minAgeHours' 0) }
                $stopped = @()
                $svc = @(@(Get-VxProp $a 'stopServices' @()) | ForEach-Object { [string]$_ })
                if ($svc.Count -gt 0 -and -not $fx) { $stopped = @(Stop-VxServicesForClean $svc) }
                try {
                    foreach ($p in $paths) {
                        foreach ($r in @(Resolve-VxCleanRoots $p $vars)) {
                            $key = (ConvertTo-VxCmpPath $r.root) + '|' + [string]$r.filter
                            if ($null -ne $seen) { if (-not $seen.Add($key)) { continue } }
                            try {
                                $items = @(Get-VxCleanTopItems $r $keep $allow)
                                if ($items.Count -eq 0) { continue }
                                # a single file (MEMORY.DMP, FNTCACHE.DAT) is checked against its folder
                                $rf = $r.root
                                if (-not $r.filter -and [IO.File]::Exists((Get-VxLongPath $r.root))) { $rf = [IO.Path]::GetDirectoryName($r.root) }
                                $rootFinal = Get-VxCleanRootFinal $rf
                                if ((Test-VxWindows) -and ('VeloxNative.SafeFs' -as [type]) -and -not $rootFinal) { throw ("Ordner konnte nicht sicher geprüft werden: {0}" -f $r.root) }
                                $w = Invoke-VxCleanWalk $items $true 30000 $rootFinal $live $cutoff
                                $freed += $w.freed
                                $deleted += $w.deleted; $locked += $w.skipped; $tooLong += $w.tooLong; $refused += $w.refused; $young += $w.young
                                if ($w.stopped) { $skippedStep = $true; break }
                            } catch {
                                if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
                                $ok = $false
                                $msgs.Add((Get-VxErrorText $_))
                            }
                        }
                        if ($skippedStep) { break }
                    }
                } finally {
                    foreach ($s in $stopped) { $null = Invoke-VxNative -FilePath (Get-VxSystemTool 'sc.exe') -Arguments @('start', $s) -TimeoutSec 20 }
                }
                if ($a.paths -match '(?i)^%RECYCLEBIN%' -and (Test-VxWindows) -and -not $ctx.Simulate) { Update-VxRecycleIcon }
            } elseif ($type -eq 'tool') {
                if ($null -ne $J) { Add-VxJournalEntry $J ([ordered]@{ op = 'cmd'; id = [string]$Tweak.id; label = [string]$Tweak.name; restorable = $false }) }
                $t = Invoke-VxToolAction $Tweak $a $slot
                $freed += [long]$t.freedBytes
                if ($t.skipped) { $skippedStep = $true }
                if (-not $t.ok) { $ok = $false }
                if ($t.message) { $msgs.Add($t.message) }
            } elseif ($type -eq 'ps') {
                $src = [string]$a.apply
                if ($null -ne $ctx.DesktopUser -and (Test-VxPerUserScript $src)) { throw (Get-VxPerUserBlockText) }
                if ($null -ne $J) { Add-VxJournalEntry $J ([ordered]@{ op = 'cmd'; id = [string]$Tweak.id; label = [string]$Tweak.name; restorable = $false }) }
                $before = $null
                if (@(Get-VxProp $a 'measure' @()).Count -gt 0) { $before = Measure-VxCleanTweak ([pscustomobject]@{ id = $Tweak.id; actions = @($a) }) $null 15000 }
                if ($ctx.Simulate) {
                    $msgs.Add('Testmodus: nur protokolliert')
                    if ($null -ne $before) { $freed += [long]$before.bytes }
                    continue
                }
                # every script runs in its own powershell.exe with a hard timeout and "Überspringen":
                # a hanging script (Store reset, Windows Update reset ...) can never block VELOX
                $timeout = [int](Get-VxProp $a 'timeoutSec' 600)
                $ir = Invoke-VxIsolated -Script $src -TimeoutSec $timeout -Skippable -Step ([string]$slot.step)
                try { Clear-VxCacheFor $src } catch { $null = $_ }
                if ($ir.skipped) { $skippedStep = $true; $msgs.Add('Übersprungen.') }
                elseif ($ir.timedOut) { $ok = $false; $msgs.Add(('Hat nach {0} Minuten nicht geantwortet und wurde beendet. Starte den PC neu und versuche es noch einmal.' -f [int][math]::Ceiling($timeout / 60))) }
                elseif (-not $ir.ok) {
                    $ok = $false
                    $e = [string]$ir.error
                    if (-not $e) { $e = 'Fehlgeschlagen (Code ' + $ir.exitCode + ').' }
                    $msgs.Add((Remove-VxStackText $e))
                }
                if ($null -ne $before -and $ir.ok) {
                    $after = Measure-VxCleanTweak ([pscustomobject]@{ id = $Tweak.id; actions = @($a) }) $null 15000
                    $freed += [math]::Max([long]0, [long]$before.bytes - [long]$after.bytes)
                }
            }
        } catch {
            if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
            $ok = $false
            $msgs.Add((Get-VxErrorText $_))
        } finally {
            if ($null -ne $job) { $job.skippable = $false; $job.skip = $false }
        }
        if ($skippedStep) { break }
    }
    if ($locked -eq 1) { $msgs.Add('1 Datei war gerade in Benutzung und bleibt') }
    elseif ($locked -gt 1) { $msgs.Add(("{0} Dateien waren gerade in Benutzung und bleiben" -f (Format-VxNumber $locked))) }
    if ($young -gt 0) { $msgs.Add(("{0} neue Datei(en) oder Ordner (jünger als {1} Std.) bleiben, weil ein Programm sie noch brauchen könnte" -f (Format-VxNumber $young), $youngHours)) }
    if ($tooLong -gt 0) { $msgs.Add(("{0} Datei(en) mit zu langem Pfad übersprungen" -f (Format-VxNumber $tooLong))) }
    if ($refused -gt 0) { $msgs.Add(("{0} Datei(en) lagen hinter einer Ordner-Verknüpfung und wurden aus Sicherheitsgründen nicht gelöscht" -f (Format-VxNumber $refused))) }
    $message = ''
    if ($freed -gt 0) { $message = (Format-VxBytes $freed) + ' freigegeben' }
    elseif ($ok -and -not $skippedStep -and $msgs.Count -eq 0) { $message = 'Ausgeführt' }
    if ($msgs.Count -gt 0) { if ($message) { $message += ' – ' }; $message += ($msgs.ToArray() -join '; ') }
    $res.ok = $ok
    $res.freedBytes = $freed
    $res.message = $message
    $res.deleted = $deleted
    $res.locked = $locked
    $res.skipped = $skippedStep
    if (-not $ok) { $res.status = 'failed' } elseif ($skippedStep) { $res.status = 'skipped' } elseif ($locked -gt 0 -or $tooLong -gt 0 -or $refused -gt 0) { $res.status = 'partial' }
    return $res
}

# The desktop's recycle bin icon still shows "full" after its files were removed: ask the shell to redraw it.
function Update-VxRecycleIcon {
    try {
        if (-not ('VeloxNative.RecycleIcon' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace VeloxNative {
  public static class RecycleIcon {
    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
    public static void Refresh() { SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); }
  }
}
'@ -ErrorAction Stop
        }
        [VeloxNative.RecycleIcon]::Refresh()
    } catch { $null = $_ }
}

function ConvertTo-VxLiveDto($Live) {
    if ($null -eq $Live) { return $null }
    $done = @()
    try { $done = @($Live.done.ToArray()) } catch { $done = @() }
    return [ordered]@{ id = [string]$Live.id; index = [int]$Live.index; total = [int]$Live.total; progress = [double]$Live.progress
        percent = [double]$Live.percent; elapsedSec = [int]$Live.elapsedSec; files = [int]$Live.files; freed = [long]$Live.freed; note = [string]$Live.note; done = $done }
}

# run-action: { ids, confirmOptIn?, expect?: { <id>: files } } -> { results, freedBytes }.
function Invoke-VxRunActionJob($Params) {
    $ids = @(@(Get-VxProp $Params 'ids' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ } | Select-Object -Unique)
    $optIn = [bool](Get-VxProp $Params 'confirmOptIn' $false)
    $expect = Get-VxProp $Params 'expect' $null
    $job = $global:VxJob
    $J = New-VxJournal 'clean' 'Reinigung & Reparatur'
    Set-VxProgress 0.02 'Bereite vor ...'
    Invoke-VxAutoRestorePoint 'Reinigung & Reparatur' $J
    Initialize-VxCleanLocked
    $results = New-Object System.Collections.ArrayList
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $live = [hashtable]::Synchronized(@{ id = ''; index = 0; total = $ids.Count; progress = -1.0; percent = -1.0; elapsedSec = 0; files = 0; freed = [long]0; note = ''
            done = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)) })
    if ($null -ne $job) { $job.live = $live }
    $total = [long]0
    $n = 0
    try {
        foreach ($id in $ids) {
            Test-VxCancel
            $n++
            $t = Get-VxTweak $id
            $sw = [Diagnostics.Stopwatch]::StartNew()
            if ($null -eq $t -or (Get-VxTweakKind $t) -ne 'action') {
                $bad = [ordered]@{ id = $id; ok = $false; freedBytes = 0; message = 'Unbekannte Aktion.'; status = 'failed'; skipped = $false; deleted = 0; locked = 0; running = @(); durationMs = 0 }
                [void]$results.Add($bad); [void]$live.done.Add($bad)
                continue
            }
            $live.id = $id; $live.index = $n; $live.progress = -1.0; $live.percent = -1.0; $live.files = 0; $live.freed = [long]0; $live.note = ''; $live.elapsedSec = 0
            $base = ($n - 1) / [math]::Max(1, $ids.Count)
            $span = 1.0 / [math]::Max(1, $ids.Count)
            Set-VxProgress $base ('Führe aus: ' + $t.name)
            $slot = @{ base = $base; span = $span; step = [string]$t.name }
            $live.base = $base; $live.span = $span; $live.expect = 0
            if ($null -ne $expect) { $live.expect = [int](Get-VxProp $expect $id 0) }
            $r = Invoke-VxRunAction $t $J @{ optIn = $optIn; seen = $seen; slot = $slot; expect = $expect }
            $level = 'ok'
            if (-not $r.ok) { $level = 'error' } elseif ($r.status -ne 'ok') { $level = 'warn' }
            Write-VxLog $level ("{0}: {1}" -f $t.name, $r.message)
            $row = [ordered]@{ id = $id; ok = [bool]$r.ok; freedBytes = [long]$r.freedBytes; message = $r.message; status = [string]$r.status; skipped = [bool]$r.skipped
                deleted = [int]$r.deleted; locked = [int]$r.locked; running = @($r.running); durationMs = [int]$sw.ElapsedMilliseconds }
            $total += [long]$r.freedBytes
            [void]$results.Add($row)
            [void]$live.done.Add($row)
        }
    } finally { $null = Complete-VxJournal $J; $global:VxCleanLocked = $null }
    $live.id = ''
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ results = $results.ToArray(); freedBytes = $total }
}
