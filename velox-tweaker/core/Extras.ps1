# VELOX - core/Extras.ps1
# Cleanup sizes/actions, startup manager, game detection + game booster, file picker,
# Explorer restart, reboot.
# Only function definitions.

# ================================================================== cleanup

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
    foreach ($sub in @('System32', 'SysWOW64', 'WinSxS', 'Boot', 'Fonts')) { $deny.Add($win + '\' + $sub) }
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

# Expands a clean path into top-level items: @{ root; filter; expanded }. Per-user variables point
# at the person at the desktop (Expand-VxUserPath).
function Resolve-VxCleanPath([string]$Raw) {
    $exp = Expand-VxUserPath $Raw
    $leaf = [IO.Path]::GetFileName($exp)
    if ($leaf -match '[\*\?]') {
        $parent = [IO.Path]::GetDirectoryName($exp)
        return @{ root = $parent; filter = $leaf; expanded = $exp }
    }
    return @{ root = $exp; filter = $null; expanded = $exp }
}

function Get-VxCleanTopItems($Resolved, [string[]]$Keep) {
    $items = @()
    $root = $Resolved.root
    if (-not (Test-VxCleanPathSafe $root)) { throw ("Pfad wird aus Sicherheitsgründen nicht bereinigt: {0}" -f $root) }
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
    if ($Keep.Count -gt 0) { $items = @($items | Where-Object { $Keep -notcontains $_.Name }) }
    return $items
}

# Real final path of the cleaned root (\\?\C:\...), $null off Windows or when unknown.
function Get-VxCleanRootFinal([string]$Root) {
    if (-not (Initialize-VxSafeFs)) { return $null }
    try { return [VeloxNative.SafeFs]::FinalPath((Get-VxLongPath $Root)) } catch { return $null }
}

# Deletes one file / empty folder. Returns 'ok', 'locked', 'toolong', 'refused', 'gone' or 'error'.
function Remove-VxCleanItem($Item, [string]$RootFinal) {
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
function Invoke-VxCleanWalk($Items, [bool]$Delete, [int]$MaxMs = 30000, [string]$RootFinal = $null) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $res = @{ bytes = [long]0; files = 0; freed = [long]0; deleted = 0; skipped = 0; tooLong = 0; refused = 0 }
    $dirs = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Generic.Stack[object]
    foreach ($i in @($Items)) { $stack.Push($i) }
    while ($stack.Count -gt 0) {
        if (-not $Delete -and $sw.ElapsedMilliseconds -gt $MaxMs) { break }
        $it = $stack.Pop()
        try {
            $it.Refresh()
            if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
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
        catch { $res.skipped++ }
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
    return $res
}

# Deterministic fake size for simulate mode off Windows.
function Get-VxFakeCleanSize([string]$Seed) {
    $h = Get-VxShortHash $Seed
    $n = [Convert]::ToInt64($h.Substring(0, 6), 16)
    $bytes = [long](20MB + ($n % 1500) * 1MB)
    return @{ bytes = $bytes; files = [int]($bytes / 180KB) }
}

function Measure-VxCleanTweak($Tweak) {
    $ctx = $global:VxCtx
    $total = @{ bytes = [long]0; files = 0 }
    foreach ($a in @($Tweak.actions)) {
        if ([string](Get-VxProp $a 'type') -ne 'clean') { continue }
        if (-not $ctx.Windows) {
            $f = Get-VxFakeCleanSize ([string]$Tweak.id + '|' + ((@($a.paths)) -join ';'))
            $total.bytes += $f.bytes; $total.files += $f.files
            continue
        }
        $keep = @(@(Get-VxProp $a 'keep' @()) | ForEach-Object { [string]$_ })
        foreach ($p in @($a.paths)) {
            try {
                $r = Resolve-VxCleanPath ([string]$p)
                $items = @(Get-VxCleanTopItems $r $keep)
                $w = Invoke-VxCleanWalk $items $false 15000
                $total.bytes += $w.bytes; $total.files += $w.files
            } catch { Write-VxLog 'warn' ("{0}: {1}" -f $p, $_.Exception.Message) }
        }
    }
    return $total
}

function Invoke-VxCleanJob($Params) {
    $ctx = $global:VxCtx
    $list = @($ctx.Catalog.tweaks | Where-Object { (Get-VxTweakKind $_) -eq 'action' -and @(@($_.actions) | Where-Object { [string](Get-VxProp $_ 'type') -eq 'clean' }).Count -gt 0 })
    $items = New-Object System.Collections.ArrayList
    $n = 0
    foreach ($t in $list) {
        Test-VxCancel
        $n++
        Set-VxProgress ($n / [math]::Max(1, $list.Count) * 0.95) ('Messe: ' + $t.name)
        $m = Measure-VxCleanTweak $t
        [void]$items.Add([ordered]@{ id = [string]$t.id; bytes = [long]$m.bytes; files = [int]$m.files })
    }
    $sum = [long]0
    foreach ($i in $items) { $sum += $i.bytes }
    Write-VxLog 'ok' ('Gefunden: ' + (Format-VxBytes $sum) + ' können aufgeräumt werden.')
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ items = $items.ToArray() }
}

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

# Runs a kind "action" tweak (clean and/or ps actions). Returns @{ ok; freedBytes; message }.
function Invoke-VxRunAction($Tweak, $J = $null) {
    $ctx = $global:VxCtx
    $freed = [long]0
    $msgs = @()
    $ok = $true
    $idx = 0
    foreach ($a in @($Tweak.actions)) {
        $type = [string](Get-VxProp $a 'type')
        $ai = $idx
        $idx++
        try {
            if ($type -eq 'clean') {
                $paths = @(@($a.paths) | ForEach-Object { [string]$_ })
                if ($null -ne $J) { Add-VxJournalEntry $J ([ordered]@{ op = 'clean'; tweakId = [string]$Tweak.id; paths = $paths; restorable = $false }) }
                if ($ctx.Simulate) {
                    $m = Measure-VxCleanTweak ([pscustomobject]@{ id = $Tweak.id; actions = @($a) })
                    $freed += $m.bytes
                    $msgs += ('Testmodus: nichts gelöscht (wären ' + (Format-VxBytes $m.bytes) + ')')
                    continue
                }
                $keep = @(@(Get-VxProp $a 'keep' @()) | ForEach-Object { [string]$_ })
                $stopped = @()
                $svc = @(@(Get-VxProp $a 'stopServices' @()) | ForEach-Object { [string]$_ })
                if ($svc.Count -gt 0) { $stopped = @(Stop-VxServicesForClean $svc) }
                try {
                    $skipped = 0; $tooLong = 0; $refused = 0
                    foreach ($p in $paths) {
                        try {
                            $r = Resolve-VxCleanPath $p
                            $items = @(Get-VxCleanTopItems $r $keep)
                            if ($items.Count -eq 0) { continue }
                            $rootFinal = Get-VxCleanRootFinal $r.root
                            if ((Test-VxWindows) -and ('VeloxNative.SafeFs' -as [type]) -and -not $rootFinal) { throw ("Ordner konnte nicht sicher geprüft werden: {0}" -f $r.root) }
                            $w = Invoke-VxCleanWalk $items $true 30000 $rootFinal
                            $freed += $w.freed
                            $skipped += $w.skipped; $tooLong += $w.tooLong; $refused += $w.refused
                        } catch {
                            if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
                            $ok = $false
                            $msgs += (Get-VxErrorText $_)
                        }
                    }
                    if ($skipped -gt 0) { $msgs += ("{0} Dateien waren in Benutzung oder geschützt und wurden übersprungen" -f $skipped) }
                    if ($tooLong -gt 0) { $msgs += ("{0} Dateien haben einen zu langen Pfad und wurden übersprungen" -f $tooLong) }
                    if ($refused -gt 0) { $msgs += ("{0} Dateien lagen hinter einer Ordner-Verknüpfung und wurden aus Sicherheitsgründen nicht gelöscht" -f $refused) }
                } finally {
                    foreach ($s in $stopped) { $null = Invoke-VxNative -FilePath (Get-VxSystemTool 'sc.exe') -Arguments @('start', $s) -TimeoutSec 20 }
                }
            } elseif ($type -eq 'ps') {
                if ($null -ne $ctx.DesktopUser -and (Test-VxPerUserScript ([string]$a.apply))) { throw (Get-VxPerUserBlockText) }
                if ($null -ne $J) { Add-VxJournalEntry $J ([ordered]@{ op = 'cmd'; id = [string]$Tweak.id; label = [string]$Tweak.name; restorable = $false }) }
                if ($ctx.Simulate) { $msgs += 'Testmodus: nur protokolliert'; continue }
                $null = Invoke-VxPsSource ([string]$a.apply)
            }
        } catch {
            if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
            $ok = $false
            $msgs += (Get-VxErrorText $_)
        }
    }
    $message = ''
    if ($freed -gt 0) { $message = (Format-VxBytes $freed) + ' freigegeben' }
    elseif ($ok) { $message = 'Ausgeführt' }
    if ($msgs.Count -gt 0) { if ($message) { $message += ' - ' }; $message += ($msgs -join '; ') }
    return @{ ok = $ok; freedBytes = $freed; message = $message }
}

function Invoke-VxRunActionJob($Params) {
    $ids = @(@(Get-VxProp $Params 'ids' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ } | Select-Object -Unique)
    $J = New-VxJournal 'clean' 'Reinigung & Reparatur'
    Set-VxProgress 0.02 'Bereite vor ...'
    Invoke-VxAutoRestorePoint 'Reinigung & Reparatur' $J
    $results = New-Object System.Collections.ArrayList
    $n = 0
    try {
        foreach ($id in $ids) {
            Test-VxCancel
            $n++
            $t = Get-VxTweak $id
            if ($null -eq $t -or (Get-VxTweakKind $t) -ne 'action') {
                [void]$results.Add([ordered]@{ id = $id; ok = $false; freedBytes = 0; message = 'Unbekannte Aktion.' })
                continue
            }
            Set-VxProgress (($n - 1) / [math]::Max(1, $ids.Count)) ('Führe aus: ' + $t.name)
            $r = Invoke-VxRunAction $t $J
            if ($r.ok) { Write-VxLog 'ok' ("{0}: {1}" -f $t.name, $r.message) } else { Write-VxLog 'error' ("{0}: {1}" -f $t.name, $r.message) }
            [void]$results.Add([ordered]@{ id = $id; ok = [bool]$r.ok; freedBytes = [long]$r.freedBytes; message = $r.message })
        }
    } finally { $null = Complete-VxJournal $J }
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ results = $results.ToArray() }
}

# ================================================================== startup manager

function Get-VxStartupLocations {
    $approved = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\'
    $list = @(
        @{ id = 'hkcu-run'; type = 'reg'; path = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'; approved = 'HKCU\' + $approved + 'Run'; label = 'Benutzer (Registry)' },
        @{ id = 'hklm-run'; type = 'reg'; path = 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'; approved = 'HKLM\' + $approved + 'Run'; label = 'Alle Benutzer (Registry)' },
        @{ id = 'hklm-run32'; type = 'reg'; path = 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; approved = 'HKLM\' + $approved + 'Run32'; label = 'Alle Benutzer (32-Bit)' }
    )
    $user = ''
    $common = ''
    try { $user = Get-VxUserFolder 'startup' } catch { $null = $_ }
    try { $common = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonStartup) } catch { $null = $_ }
    if ($user) { $list += @{ id = 'hkcu-folder'; type = 'folder'; path = $user; approved = 'HKCU\' + $approved + 'StartupFolder'; label = 'Autostart-Ordner (Benutzer)' } }
    if ($common) { $list += @{ id = 'common-folder'; type = 'folder'; path = $common; approved = 'HKLM\' + $approved + 'StartupFolder'; label = 'Autostart-Ordner (alle Benutzer)' } }
    return $list
}

function Test-VxStartupApproved([string]$ApprovedKey, [string]$Name) {
    $v = Get-VxRegValue $ApprovedKey $Name
    if (-not $v.exists -or $v.kind -ne 'Binary') { return $true }
    $hex = [string]$v.value
    if ($hex.Length -lt 2) { return $true }
    $b = [Convert]::ToByte($hex.Substring(0, 2), 16)
    return (($b -band 1) -eq 0)
}

function Get-VxStartupItems {
    $items = New-Object System.Collections.ArrayList
    foreach ($loc in Get-VxStartupLocations) {
        try {
            if ($loc.type -eq 'reg') {
                foreach ($n in @(Get-VxRegValueNames $loc.path | Sort-Object)) {
                    if ([string]::IsNullOrEmpty($n)) { continue }
                    $v = Get-VxRegValue $loc.path $n
                    if (-not $v.exists) { continue }
                    [void]$items.Add([ordered]@{
                            id = ($loc.id + '|' + $n); name = $n; command = [string]$v.value; location = $loc.label
                            enabled = (Test-VxStartupApproved $loc.approved $n)
                        })
                }
            } else {
                if (-not [IO.Directory]::Exists($loc.path)) { continue }
                foreach ($f in @(Get-ChildItem -LiteralPath $loc.path -File -Force -ErrorAction SilentlyContinue | Sort-Object Name)) {
                    if ($f.Name -ieq 'desktop.ini') { continue }
                    [void]$items.Add([ordered]@{
                            id = ($loc.id + '|' + $f.Name); name = [IO.Path]::GetFileNameWithoutExtension($f.Name); command = $f.FullName
                            location = $loc.label; enabled = (Test-VxStartupApproved $loc.approved $f.Name)
                        })
                }
            }
        } catch { Write-VxLog 'warn' ("Autostart-Ort {0} nicht lesbar: {1}" -f $loc.label, $_.Exception.Message) }
    }
    return @($items)
}

function Invoke-VxStartupListJob($Params) {
    $items = @(Get-VxStartupItems)
    $en = @($items | Where-Object { $_.enabled }).Count
    if ($null -ne $global:VxCtx.State.profile) {
        $p = $global:VxCtx.State.profile
        if ($p -is [System.Collections.IDictionary]) { $p['startupCount'] = $en }
    }
    Write-VxLog 'info' ("{0} Autostart-Einträge, davon {1} aktiv." -f $items.Count, $en)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ items = $items }
}

# Enables/disables an entry exactly like Task Manager (StartupApproved 12-byte value).
function Invoke-VxStartupSetJob($Params) {
    $id = [string](Get-VxProp $Params 'id')
    $enabled = [bool](Get-VxProp $Params 'enabled' $true)
    $sep = $id.IndexOf('|')
    if ($sep -lt 1) { throw 'Unbekannter Autostart-Eintrag.' }
    $locId = $id.Substring(0, $sep)
    $name = $id.Substring($sep + 1)
    $loc = @(Get-VxStartupLocations | Where-Object { $_.id -eq $locId })[0]
    if ($null -eq $loc) { throw 'Unbekannter Autostart-Ort.' }
    $item = @(Get-VxStartupItems | Where-Object { $_.id -eq $id })[0]
    if ($null -eq $item) { throw 'Dieser Autostart-Eintrag existiert nicht mehr.' }
    $bytes = New-Object byte[] 12
    if ($enabled) { $bytes[0] = 2 } else {
        $bytes[0] = 3
        $ft = [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc())
        [Array]::Copy($ft, 0, $bytes, 4, 8)
    }
    $hex = ConvertTo-VxHex $bytes
    $verb = 'aktiviert'
    if (-not $enabled) { $verb = 'deaktiviert' }
    $J = New-VxJournal 'startup' ("Autostart: {0} {1}" -f $item.name, $verb)
    Invoke-VxAutoRestorePoint ("Autostart: {0}" -f $item.name) $J
    try {
        $null = Set-VxRegJ $J $loc.approved $name 'Binary' $hex 'startup'
    } finally { $null = Complete-VxJournal $J }
    Save-VxSim
    $item = @(Get-VxStartupItems | Where-Object { $_.id -eq $id })[0]
    Write-VxLog 'ok' ("{0} beim Windows-Start {1}." -f $item.name, $verb)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ ok = $true; item = $item }
}

# ================================================================== games

# File name of a Windows path; also correct when the tests run on Linux (no [IO.Path] there).
function Get-VxPathLeaf([string]$Path) {
    $i = $Path.LastIndexOfAny([char[]]@('\', '/'))
    if ($i -ge 0) { return $Path.Substring($i + 1) }
    return $Path
}

function Get-VxPathStem([string]$Path) {
    $leaf = Get-VxPathLeaf $Path
    $d = $leaf.LastIndexOf('.')
    if ($d -gt 0) { return $leaf.Substring(0, $d) }
    return $leaf
}


function Get-VxKnownGames {
    return @(
        @{ name = 'Grand Theft Auto V'; dir = 'Grand Theft Auto V'; exe = 'GTA5.exe' },
        @{ name = 'Grand Theft Auto V Enhanced'; dir = 'Grand Theft Auto V Enhanced'; exe = 'GTA5_Enhanced.exe' },
        @{ name = 'Counter-Strike 2'; dir = 'Counter-Strike Global Offensive'; exe = 'game\bin\win64\cs2.exe' },
        @{ name = 'Apex Legends'; dir = 'Apex Legends'; exe = 'r5apex.exe' },
        @{ name = 'Rust'; dir = 'Rust'; exe = 'RustClient.exe' },
        @{ name = 'PUBG: BATTLEGROUNDS'; dir = 'PUBG'; exe = 'TslGame\Binaries\Win64\TslGame.exe' },
        @{ name = 'Dota 2'; dir = 'dota 2 beta'; exe = 'game\bin\win64\dota2.exe' },
        @{ name = 'Rainbow Six Siege'; dir = "Tom Clancy's Rainbow Six Siege"; exe = 'RainbowSix.exe' },
        @{ name = 'Call of Duty'; dir = 'Call of Duty HQ'; exe = 'cod.exe' },
        @{ name = 'Call of Duty'; dir = 'Call of Duty'; exe = 'cod.exe' },
        @{ name = 'Rocket League'; dir = 'rocketleague'; exe = 'Binaries\Win64\RocketLeague.exe' },
        @{ name = 'ELDEN RING'; dir = 'ELDEN RING'; exe = 'Game\eldenring.exe' },
        @{ name = 'Cyberpunk 2077'; dir = 'Cyberpunk 2077'; exe = 'bin\x64\Cyberpunk2077.exe' },
        @{ name = 'Red Dead Redemption 2'; dir = 'Red Dead Redemption 2'; exe = 'RDR2.exe' },
        @{ name = 'Destiny 2'; dir = 'Destiny 2'; exe = 'destiny2.exe' },
        @{ name = 'Overwatch 2'; dir = 'Overwatch'; exe = 'Overwatch.exe' },
        @{ name = 'Team Fortress 2'; dir = 'Team Fortress 2'; exe = 'tf_win64.exe' },
        @{ name = 'Marvel Rivals'; dir = 'MarvelRivals'; exe = 'MarvelGame\Marvel\Binaries\Win64\Marvel-Win64-Shipping.exe' },
        @{ name = 'THE FINALS'; dir = 'THE FINALS'; exe = 'Discovery.exe' },
        @{ name = 'Battlefield 2042'; dir = 'Battlefield 2042'; exe = 'BF2042.exe' },
        @{ name = 'Deadlock'; dir = 'Deadlock'; exe = 'game\bin\win64\project8.exe' },
        @{ name = 'Euro Truck Simulator 2'; dir = 'Euro Truck Simulator 2'; exe = 'bin\win_x64\eurotrucks2.exe' },
        @{ name = 'Forza Horizon 5'; dir = 'ForzaHorizon5'; exe = 'ForzaHorizon5.exe' },
        @{ name = 'HELLDIVERS 2'; dir = 'Helldivers 2'; exe = 'bin\helldivers2.exe' },
        @{ name = "Baldur's Gate 3"; dir = "Baldurs Gate 3"; exe = 'bin\bg3.exe' },
        @{ name = 'Arma 3'; dir = 'Arma 3'; exe = 'arma3_x64.exe' },
        @{ name = 'DayZ'; dir = 'DayZ'; exe = 'DayZ_x64.exe' },
        @{ name = 'Valheim'; dir = 'Valheim'; exe = 'valheim.exe' },
        @{ name = 'Path of Exile 2'; dir = 'Path of Exile 2'; exe = 'PathOfExileSteam.exe' }
    )
}

function Get-VxIfeoPerfPath([string]$Exe) {
    return ('HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\' + $Exe + '\PerfOptions')
}

# Id of an APPLIED catalog toggle that sets this exe's IFEO CpuPriorityClass (e.g. games.gta5-priority),
# else $null. The booster and such a tweak share one registry value.
function Get-VxPriorityTweakFor([string]$Exe) {
    $ctx = $global:VxCtx
    if (-not $Exe -or $null -eq $ctx.Catalog) { return $null }
    $path = (Get-VxIfeoPerfPath $Exe).ToLowerInvariant()
    foreach ($t in @($ctx.Catalog.tweaks)) {
        if ((Get-VxTweakKind $t) -ne 'toggle') { continue }
        $hit = @(@($t.actions) | Where-Object { [string](Get-VxProp $_ 'type') -eq 'reg' -and [string](Get-VxProp $_ 'name') -ieq 'CpuPriorityClass' -and ([string](Get-VxProp $_ 'path')).ToLowerInvariant() -eq $path }).Count -gt 0
        if (-not $hit) { continue }
        try { $st = Get-VxTweakStatus $t } catch { $st = $null }
        if ($null -ne $st -and $st.status -eq 'applied') { return [string]$t.id }
    }
    return $null
}

function Get-VxGameBoostState([string]$Path) {
    $exe = Get-VxPathLeaf ($Path)
    $b = [ordered]@{ priority = $false; gpu = $false; fso = $false; priorityTweak = $null }
    try {
        $p = Get-VxRegValue (Get-VxIfeoPerfPath $exe) 'CpuPriorityClass'
        $b.priority = ($p.exists -and [long]$p.value -eq 3)
        if ($b.priority) { $b.priorityTweak = Get-VxPriorityTweakFor $exe }
        $g = Get-VxRegValue 'HKCU\Software\Microsoft\DirectX\UserGpuPreferences' $Path
        $b.gpu = ($g.exists -and [string]$g.value -match 'GpuPreference=2;?')
        $f = Get-VxRegValue 'HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers' $Path
        $b.fso = ($f.exists -and (' ' + [string]$f.value + ' ') -match '\sDISABLEDXMAXIMIZEDWINDOWEDMODE\s')
    } catch { $null = $_ }
    return $b
}

# Re-reads the boost state of every remembered game after a job that may have touched the same
# values (reverting games.*-priority, a restore, a detweak) and says so when a boost went away.
function Sync-VxBoostedGames {
    $ctx = $global:VxCtx
    if ($null -eq $ctx.Settings) { return }
    $list = New-Object System.Collections.ArrayList
    $changed = $false
    foreach ($g in @($ctx.Settings.games)) {
        $path = [string](Get-VxProp $g 'path' '')
        if (-not $path) { continue }
        $old = Get-VxProp $g 'boost'
        $now = Get-VxGameBoostState $path
        $name = [string](Get-VxProp $g 'name' (Get-VxPathStem $path))
        foreach ($k in @('priority', 'gpu', 'fso')) {
            if ([bool](Get-VxProp $old $k $false) -ne [bool]$now[$k]) {
                $changed = $true
                if (-not $now[$k]) {
                    $what = switch ($k) { 'priority' { 'hohe CPU-Priorität' } 'gpu' { 'starke Grafikkarte' } 'fso' { 'Vollbild-Optimierung aus' } }
                    Write-VxLog 'warn' ("Spiele-Boost {0}: '{1}' ist jetzt aus - die Einstellung wurde mit zurückgesetzt." -f $name, $what)
                }
            }
        }
        if (-not ($now.priority -or $now.gpu -or $now.fso)) { $changed = $true; continue }
        $e = [ordered]@{}
        foreach ($k in @('id', 'name', 'exe', 'path', 'source')) { $e[$k] = Get-VxProp $g $k }
        $e['boost'] = $now
        $saved = Get-VxProp $g 'saved'
        if ($now.priority -and $null -ne $saved) { $e['saved'] = $saved }
        [void]$list.Add($e)
    }
    if ($changed) {
        $ctx.Settings.games = $list.ToArray()
        Save-VxSettings
    }
}

function New-VxGameEntry([string]$Name, [string]$Path, [string]$Source) {
    return [ordered]@{
        id = (Get-VxShortHash $Path.ToLowerInvariant()); name = $Name; exe = Get-VxPathLeaf ($Path); path = $Path
        source = $Source; boost = (Get-VxGameBoostState $Path)
    }
}

function Get-VxSteamLibraries {
    $libs = New-Object System.Collections.Generic.List[string]
    $roots = @()
    foreach ($q in @(@('HKCU\Software\Valve\Steam', 'SteamPath'), @('HKLM\SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath'), @('HKLM\SOFTWARE\Valve\Steam', 'InstallPath'))) {
        try {
            $v = Get-VxRegValue $q[0] $q[1]
            if ($v.exists -and $v.value) { $roots += ([string]$v.value).Replace('/', '\') }
        } catch { $null = $_ }
    }
    foreach ($r in ($roots | Select-Object -Unique)) {
        if (-not $libs.Contains($r)) { $libs.Add($r) }
        $vdf = [IO.Path]::Combine([IO.Path]::Combine($r, 'steamapps'), 'libraryfolders.vdf')
        if ([IO.File]::Exists($vdf)) {
            $text = [IO.File]::ReadAllText($vdf)
            foreach ($m in [regex]::Matches($text, '"path"\s+"([^"]+)"')) {
                $p = $m.Groups[1].Value.Replace('\\', '\')
                if (-not ($libs | Where-Object { $_ -ieq $p })) { $libs.Add($p) }
            }
        }
    }
    return @($libs)
}

function Get-VxRealGames {
    $found = New-Object System.Collections.ArrayList
    $add = {
        param([string]$n, [string]$p, [string]$s)
        if (-not $p -or -not [IO.File]::Exists($p)) { return }
        if ($found | Where-Object { $_.path -ieq $p }) { return }
        [void]$found.Add((New-VxGameEntry $n $p $s))
    }
    # FiveM launcher + its GTA processes
    try {
        $lad = Get-VxUserFolder 'localAppData'
        $fivem = [IO.Path]::Combine([IO.Path]::Combine($lad, 'FiveM'), 'FiveM.exe')
        & $add 'FiveM' $fivem 'fivem'
        $sub = [IO.Path]::Combine($lad, 'FiveM\FiveM.app\data\cache\subprocess')
        if ([IO.Directory]::Exists($sub)) {
            foreach ($f in @(Get-ChildItem -LiteralPath $sub -Filter '*GTAProcess.exe' -File -ErrorAction SilentlyContinue)) {
                & $add ('FiveM Spielprozess (' + $f.BaseName + ')') $f.FullName 'fivem'
            }
        }
    } catch { $null = $_ }
    # GTA V via Rockstar launcher
    foreach ($k in @('HKLM\SOFTWARE\WOW6432Node\Rockstar Games\Grand Theft Auto V', 'HKLM\SOFTWARE\WOW6432Node\Rockstar Games\GTAV Enhanced', 'HKLM\SOFTWARE\WOW6432Node\Rockstar Games\Grand Theft Auto V Enhanced')) {
        try {
            $v = Get-VxRegValue $k 'InstallFolder'
            if ($v.exists) {
                & $add 'Grand Theft Auto V' ([IO.Path]::Combine([string]$v.value, 'GTA5.exe')) 'rockstar'
                & $add 'Grand Theft Auto V Enhanced' ([IO.Path]::Combine([string]$v.value, 'GTA5_Enhanced.exe')) 'rockstar'
            }
        } catch { $null = $_ }
    }
    # Steam libraries
    $known = Get-VxKnownGames
    foreach ($lib in @(Get-VxSteamLibraries)) {
        $common = [IO.Path]::Combine([IO.Path]::Combine($lib, 'steamapps'), 'common')
        if (-not [IO.Directory]::Exists($common)) { continue }
        foreach ($g in $known) {
            try { & $add $g.name ([IO.Path]::Combine([IO.Path]::Combine($common, $g.dir), $g.exe)) 'steam' } catch { $null = $_ }
        }
    }
    # Epic manifests
    try {
        $man = [IO.Path]::Combine([string]$env:ProgramData, 'Epic\EpicGamesLauncher\Data\Manifests')
        if ([IO.Directory]::Exists($man)) {
            foreach ($f in @(Get-ChildItem -LiteralPath $man -Filter '*.item' -File -ErrorAction SilentlyContinue)) {
                try {
                    $j = Read-VxJsonFile $f.FullName
                    $exe = [string](Get-VxProp $j 'LaunchExecutable')
                    $loc = [string](Get-VxProp $j 'InstallLocation')
                    if ($exe -and $loc -and $exe.ToLowerInvariant().EndsWith('.exe')) {
                        & $add ([string](Get-VxProp $j 'DisplayName' $exe)) ([IO.Path]::Combine($loc, $exe.Replace('/', '\'))) 'epic'
                    }
                } catch { $null = $_ }
            }
        }
    } catch { $null = $_ }
    # Riot
    & $add 'VALORANT' 'C:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe' 'riot'
    & $add 'League of Legends' 'C:\Riot Games\League of Legends\Game\League of Legends.exe' 'riot'
    # running windowed processes that are not system tools or browsers
    $skip = @('explorer', 'chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi', 'iexplore', 'discord', 'steam', 'steamwebhelper',
        'epicgameslauncher', 'code', 'devenv', 'powershell', 'pwsh', 'cmd', 'conhost', 'windowsterminal', 'textinputhost',
        'applicationframehost', 'systemsettings', 'taskmgr', 'notepad', 'spotify', 'teams', 'ms-teams', 'outlook', 'winword', 'excel',
        'powerpnt', 'onedrive', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'lockapp', 'msedgewebview2',
        'nvidia app', 'nvcontainer', 'radeonsoftware', 'obs64', 'whatsapp', 'telegram', 'slack', 'zoom', 'signal', 'mmc', 'regedit',
        'battle.net', 'origin', 'eadesktop', 'ubisoftconnect', 'upc', 'riotclientservices', 'rockstarlauncher', 'launcher', 'fivem')
    try {
        $win = ([string]$env:SystemRoot).ToLowerInvariant()
        foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
            try {
                $path = [string]$p.Path
                if (-not $path) { continue }
                if ($win -and $path.ToLowerInvariant().StartsWith($win)) { continue }
                if ($skip -contains $p.ProcessName.ToLowerInvariant()) { continue }
                if ($path.ToLowerInvariant().Contains('\velox')) { continue }
                $title = [string]$p.MainWindowTitle
                if (-not $title) { $title = $p.ProcessName }
                & $add $title $path 'running'
            } catch { $null = $_ }
        }
    } catch { $null = $_ }
    return @($found)
}

function Get-VxSimGames {
    $list = @(
        (New-VxGameEntry 'FiveM' 'C:\Users\Gamer\AppData\Local\FiveM\FiveM.exe' 'fivem'),
        (New-VxGameEntry 'Grand Theft Auto V' 'C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V\GTA5.exe' 'steam'),
        (New-VxGameEntry 'Counter-Strike 2' 'C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe' 'steam'),
        (New-VxGameEntry 'Fortnite' 'C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe' 'epic')
    )
    return $list
}

function Invoke-VxGamesDetectJob($Params) {
    $ctx = $global:VxCtx
    Set-VxProgress 0.1 'Suche installierte Spiele ...'
    $games = New-Object System.Collections.ArrayList
    $list = @()
    if ($ctx.Windows) { $list = @(Get-VxRealGames) } else { $list = @(Get-VxSimGames) }
    foreach ($g in $list) { [void]$games.Add($g) }
    # games boosted earlier stay visible
    foreach ($s in @($ctx.Settings.games)) {
        $p = [string](Get-VxProp $s 'path')
        if (-not $p) { continue }
        if ($games | Where-Object { $_.path -ieq $p }) { continue }
        [void]$games.Add((New-VxGameEntry ([string](Get-VxProp $s 'name' (Get-VxPathStem ($p)))) $p ([string](Get-VxProp $s 'source' 'manual'))))
    }
    Write-VxLog 'ok' ("{0} Spiele gefunden." -f $games.Count)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ games = $games.ToArray() }
}

function Test-VxExePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ($Path -notmatch '^[A-Za-z]:\\' -and -not $Path.StartsWith('\\')) { return $false }
    if (-not $Path.ToLowerInvariant().EndsWith('.exe')) { return $false }
    if ($Path -match '[\*\?"<>|]' -or $Path -match '\\\.\.\\') { return $false }
    return $true
}

# "k=v;k2=v2;" helpers for UserGpuPreferences
function Set-VxGpuPrefString([string]$Current, [bool]$On) {
    $pairs = New-Object System.Collections.Generic.List[string]
    foreach ($p in ([string]$Current).Split(';')) {
        $x = $p.Trim()
        if (-not $x) { continue }
        if ($x -match '^GpuPreference=') { continue }
        $pairs.Add($x)
    }
    if ($On) { $pairs.Insert(0, 'GpuPreference=2') }
    if ($pairs.Count -eq 0) { return $null }
    return (($pairs -join ';') + ';')
}

# AppCompat "Layers" flag list, e.g. "~ DISABLEDXMAXIMIZEDWINDOWEDMODE HIGHDPIAWARE"
function Set-VxLayerFlag([string]$Current, [string]$Flag, [bool]$On) {
    $tokens = New-Object System.Collections.Generic.List[string]
    $tilde = $false
    foreach ($t in ([string]$Current).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) {
        if ($t -eq '~') { $tilde = $true; continue }
        if ($t -ieq $Flag) { continue }
        $tokens.Add($t)
    }
    if ($On) { $tokens.Add($Flag); $tilde = $true }
    if ($tokens.Count -eq 0) { return $null }
    $s = ($tokens -join ' ')
    if ($tilde) { $s = '~ ' + $s }
    return $s
}

function Invoke-VxGameBoostJob($Params) {
    $ctx = $global:VxCtx
    $path = ([string](Get-VxProp $Params 'path')).Trim()
    if (-not (Test-VxExePath $path)) { throw 'Bitte wähle eine gültige .exe-Datei (vollständiger Pfad).' }
    if (-not $ctx.Simulate -and -not [IO.File]::Exists($path)) { throw 'Diese Datei gibt es nicht (mehr).' }
    $prio = [bool](Get-VxProp $Params 'priority' $false)
    $gpu = [bool](Get-VxProp $Params 'gpu' $false)
    $fso = [bool](Get-VxProp $Params 'fso' $false)
    $exe = Get-VxPathLeaf ($path)
    $prevEntry = @(@($ctx.Settings.games) | Where-Object { [string](Get-VxProp $_ 'path') -ieq $path })[0]
    $saved = Get-VxProp $prevEntry 'saved'
    $J = New-VxJournal 'game' ('Spiele-Boost: ' + $exe)
    Invoke-VxAutoRestorePoint ('Spiele-Boost: ' + $exe) $J
    $errors = @()
    try {
        # 1) CPU priority "high" via Image File Execution Options (per exe name). The value is
        #    shared with the games.*-priority catalog tweaks and with other tools, so the booster
        #    remembers what was there before and only ever undoes its own change.
        try {
            $ifeo = Get-VxIfeoPerfPath $exe
            $cur = Get-VxRegSnapshot $ifeo 'CpuPriorityClass'
            $isHigh = ($cur.exists -and [long]$cur.value -eq 3)
            if ($prio) {
                if (-not $isHigh -and $null -eq $saved) { $saved = @{ value = $cur; keyExisted = [bool](Test-VxRegKey $ifeo) } }
                $null = Set-VxRegJ $J $ifeo 'CpuPriorityClass' 'DWord' 3 'game'
            } elseif ($isHigh) {
                $tw = Get-VxPriorityTweakFor $exe
                if ($tw) {
                    $tn = [string](Get-VxTweak $tw).name
                    Write-VxLog 'info' ("Hohe CPU-Priorität bleibt an: sie kommt vom Tweak '{0}'. Zum Ausschalten den Tweak zurücksetzen." -f $tn)
                } else {
                    $bv = Get-VxProp $saved 'value'
                    if ($null -ne $bv -and (Get-VxProp $bv 'exists') -eq $true -and @('DWord', 'QWord', 'String') -contains [string](Get-VxProp $bv 'kind')) {
                        $null = Set-VxRegJ $J $ifeo 'CpuPriorityClass' ([string](Get-VxProp $bv 'kind')) (Get-VxProp $bv 'value') 'game'
                    } else {
                        $null = Set-VxRegJ $J $ifeo 'CpuPriorityClass' $null $null 'game'
                    }
                    # delete the key only when VELOX created it (or nobody knows) and it is empty now
                    $keyExisted = [bool](Get-VxProp $saved 'keyExisted' $false)
                    if (-not $keyExisted -and (Test-VxRegKey $ifeo) -and @(Get-VxRegValueNames $ifeo).Count -eq 0 -and @(Get-VxRegSubKeys $ifeo).Count -eq 0) {
                        $null = Set-VxRegKeyJ $J $ifeo $false 'game'
                    }
                    $saved = $null
                }
            }
        } catch { $errors += (Get-VxErrorText $_ 'CPU-Priorität') }
        # 2) high-performance GPU
        try {
            $gk = 'HKCU\Software\Microsoft\DirectX\UserGpuPreferences'
            $cur = Get-VxRegValue $gk $path
            $curText = ''
            if ($cur.exists) { $curText = [string]$cur.value }
            $new = Set-VxGpuPrefString $curText $gpu
            if ($null -eq $new) { $null = Set-VxRegJ $J $gk $path $null $null 'game' } else { $null = Set-VxRegJ $J $gk $path 'String' $new 'game' }
        } catch { $errors += (Get-VxErrorText $_ 'Grafikkarte') }
        # 3) disable fullscreen optimizations, keep other compatibility flags
        try {
            $lk = 'HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
            $cur = Get-VxRegValue $lk $path
            $curText = ''
            if ($cur.exists) { $curText = [string]$cur.value }
            $new = Set-VxLayerFlag $curText 'DISABLEDXMAXIMIZEDWINDOWEDMODE' $fso
            if ($null -eq $new) { $null = Set-VxRegJ $J $lk $path $null $null 'game' } else { $null = Set-VxRegJ $J $lk $path 'String' $new 'game' }
        } catch { $errors += (Get-VxErrorText $_ 'Vollbild-Optimierung') }
    } finally {
        $null = Complete-VxJournal $J
        Save-VxSim
    }
    $name = [string](Get-VxProp $Params 'name' '')
    if (-not $name) { $name = Get-VxPathStem ($exe) }
    $source = [string](Get-VxProp $Params 'source' 'manual')
    $game = New-VxGameEntry $name $path $source
    # remember boosted games in settings.games
    $list = New-Object System.Collections.ArrayList
    foreach ($g in @($ctx.Settings.games)) { if ([string](Get-VxProp $g 'path') -ine $path) { [void]$list.Add($g) } }
    if ($game.boost.priority -or $game.boost.gpu -or $game.boost.fso) {
        $e = [ordered]@{ id = $game.id; name = $game.name; exe = $game.exe; path = $game.path; source = $game.source; boost = $game.boost }
        if ($game.boost.priority -and $null -ne $saved) { $e['saved'] = $saved }
        [void]$list.Add($e)
    }
    $ctx.Settings.games = $list.ToArray()
    Save-VxSettings
    if ($errors.Count -gt 0) {
        Write-VxLog 'error' ($errors -join ' | ')
        throw ('Nicht alles konnte gesetzt werden: ' + ($errors -join ' | '))
    }
    Write-VxLog 'ok' ("{0}: Boost gespeichert." -f $name)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ ok = $true; game = $game }
}

# ================================================================== file picker

function Invoke-VxPickFileJob($Params) {
    $ctx = $global:VxCtx
    if (-not $ctx.Windows) {
        Write-VxLog 'info' 'Dateiauswahl gibt es nur unter Windows.'
        return [ordered]@{ path = $null }
    }
    $code = {
        Add-Type -AssemblyName System.Windows.Forms
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        $owner.ShowInTaskbar = $false
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Filter = 'Programme (*.exe)|*.exe'
        $dlg.Title = 'Spiel auswählen (die .exe-Datei des Spiels)'
        $dlg.CheckFileExists = $true
        $dlg.Multiselect = $false
        $dlg.InitialDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
        try {
            if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.FileName }
            return $null
        } finally { $dlg.Dispose(); $owner.Dispose() }
    }
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = [System.Threading.ApartmentState]::STA
    $rs.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
    $rs.Open()
    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    try {
        $null = $ps.AddScript($code.ToString())
        $out = @($ps.Invoke())
        $path = $null
        if ($out.Count -gt 0 -and $out[$out.Count - 1]) { $path = [string]$out[$out.Count - 1] }
        Set-VxProgress 1 'Fertig'
        return [ordered]@{ path = $path }
    } finally {
        $ps.Dispose()
        $rs.Close()
        $rs.Dispose()
    }
}

# ================================================================== explorer / reboot

function Invoke-VxExplorerRestartJob($Params) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate -and -not $ctx.Windows) {
        Write-VxLog 'info' '[Testmodus] Explorer würde neu gestartet.'
    } elseif ($ctx.Simulate) {
        Write-VxLog 'info' '[Testmodus] Explorer wird im Testmodus nicht neu gestartet.'
    } else {
        Set-VxProgress 0.3 'Starte Explorer neu ...'
        # only this session's Explorer - other signed-in users (fast user switching) keep their desktop
        $sid = [Diagnostics.Process]::GetCurrentProcess().SessionId
        Get-Process -Name 'explorer' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sid } | Stop-Process -Force -ErrorAction SilentlyContinue
        $back = $false
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 500
            if (@(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sid }).Count -gt 0) { $back = $true; break }
        }
        if (-not $back) { Start-Process -FilePath ([IO.Path]::Combine([string]$env:SystemRoot, 'explorer.exe')) }
        Write-VxLog 'ok' 'Explorer neu gestartet.'
    }
    $ctx.State.needs.explorer = $false
    Save-VxState
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ ok = $true }
}

function Invoke-VxRebootJob($Params) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        Write-VxLog 'info' '[Testmodus] Neustart wurde nur protokolliert.'
        Set-VxProgress 1 'Fertig'
        return [ordered]@{ ok = $true }
    }
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'shutdown.exe') -Arguments @('/r', '/t', '10', '/c', 'VELOX: Neustart in 10 Sekunden') -TimeoutSec 20
    if ($r.ExitCode -ne 0) { throw ('Neustart konnte nicht gestartet werden: ' + ($r.Output + $r.Error).Trim()) }
    Write-VxLog 'ok' 'Der PC startet in 10 Sekunden neu.'
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ ok = $true }
}
