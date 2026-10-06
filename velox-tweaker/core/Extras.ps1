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
    if ($msgs.Count -gt 0) { if ($message) { $message += ' – ' }; $message += ($msgs -join '; ') }
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
                    Write-VxLog 'warn' ("Spiele-Boost {0}: '{1}' ist jetzt aus – die Einstellung wurde mit zurückgesetzt." -f $name, $what)
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

# Steam app id -> game exe (relative to the install folder; the first one that exists wins).
# Everything else is found by Find-VxGameExe.
function Get-VxSteamExeMap {
    return @{
        '730' = @('game\bin\win64\cs2.exe'); '570' = @('game\bin\win64\dota2.exe'); '440' = @('tf_win64.exe', 'hl2.exe')
        '271590' = @('GTA5.exe'); '3240220' = @('GTA5_Enhanced.exe'); '1174180' = @('RDR2.exe')
        '578080' = @('TslGame\Binaries\Win64\TslGame.exe'); '252490' = @('RustClient.exe'); '1172470' = @('r5apex_dx12.exe', 'r5apex.exe')
        '359550' = @('RainbowSix_DX12.exe', 'RainbowSix.exe'); '1938090' = @('cod.exe'); '252950' = @('Binaries\Win64\RocketLeague.exe')
        '1245620' = @('Game\eldenring.exe'); '1091500' = @('bin\x64\Cyberpunk2077.exe'); '1085660' = @('destiny2.exe')
        '2357570' = @('Overwatch.exe'); '2767030' = @('MarvelGame\Marvel\Binaries\Win64\Marvel-Win64-Shipping.exe'); '2073850' = @('Discovery.exe')
        '1517290' = @('BF2042.exe'); '1422450' = @('game\bin\win64\deadlock.exe', 'game\bin\win64\project8.exe')
        '227300' = @('bin\win_x64\eurotrucks2.exe'); '270880' = @('bin\win_x64\amtrucks.exe'); '1551360' = @('ForzaHorizon5.exe')
        '553850' = @('bin\helldivers2.exe'); '1086940' = @('bin\bg3.exe', 'bin\bg3_dx11.exe'); '107410' = @('arma3_x64.exe')
        '221100' = @('DayZ_x64.exe'); '892970' = @('valheim.exe'); '2694490' = @('PathOfExileSteam.exe'); '238960' = @('PathOfExile_x64Steam.exe', 'PathOfExileSteam.exe')
        '1203220' = @('NarakaBladepoint.exe'); '1966720' = @('Lethal Company.exe'); '3164500' = @('Schedule I.exe'); '3241660' = @('REPO.exe')
        '2246340' = @('MonsterHunterWilds.exe'); '582010' = @('MonsterHunterWorld.exe'); '1623730' = @('Pal\Binaries\Win64\Palworld-Win64-Shipping.exe')
        '945360' = @('Among Us.exe'); '381210' = @('DeadByDaylight\Binaries\Win64\DeadByDaylight-Win64-Shipping.exe'); '236390' = @('win64\aces.exe')
        '1599340' = @('Binaries\Win64\LOSTARK.exe'); '289070' = @('Base\Binaries\Win64Steam\CivilizationVI.exe'); '1158310' = @('binaries\ck3.exe')
        '394360' = @('hoi4.exe'); '2050650' = @('re4.exe'); '1145360' = @('x64\Hades.exe'); '413150' = @('Stardew Valley.exe')
        '105600' = @('Terraria.exe'); '4000' = @('bin\win64\gmod.exe', 'hl2.exe'); '304930' = @('Unturned.exe'); '1240440' = @('HaloInfinite.exe')
        '976730' = @('MCC\Binaries\Win64\MCC-Win64-Shipping.exe'); '2399830' = @('ShooterGame\Binaries\Win64\ArkAscended.exe')
        '346110' = @('ShooterGame\Binaries\Win64\ShooterGame.exe'); '1326470' = @('SonsOfTheForest.exe'); '322170' = @('GeometryDash.exe')
        '1222670' = @('The Sims 4\Game\Bin\TS4_x64.exe', 'Game\Bin\TS4_x64.exe'); '1449850' = @('Yu-Gi-Oh! Master Duel.exe')
        '1817070' = @('Spider-Man.exe'); '2215430' = @('GhostOfTsushima.exe'); '1888930' = @('tlou-i.exe'); '990080' = @('Hogwarts Legacy.exe', 'Phoenix\Binaries\Win64\HogwartsLegacy.exe')
        '1716740' = @('Starfield.exe'); '377160' = @('Fallout4.exe'); '489830' = @('SkyrimSE.exe'); '292030' = @('bin\x64\witcher3.exe')
        '1063730' = @('Bin64\NewWorld.exe'); '2139460' = @('ONCE_HUMAN.exe'); '1904540' = @('FC24.exe'); '2195250' = @('FC25.exe')
    }
}

# Exe names that are certainly the game (a strong hint for Find-VxGameExe).
function Get-VxKnownExeNames {
    $h = @{}
    foreach ($g in @(Get-VxKnownGames)) { $h[(Get-VxPathLeaf ([string]$g.exe)).ToLowerInvariant()] = $true }
    $map = Get-VxSteamExeMap
    foreach ($k in @($map.Keys)) { foreach ($rel in @($map[$k])) { $h[(Get-VxPathLeaf ([string]$rel)).ToLowerInvariant()] = $true } }
    foreach ($x in @('RainbowSix_DX12.exe', 'ACValhalla.exe', 'ACMirage.exe', 'ACShadows.exe', 'FarCry6.exe', 'TheDivision2.exe', 'ForHonor.exe',
            'TheCrewMotorfest.exe', 'Anno1800.exe', 'bf6.exe', 'bfv.exe', 'bf1.exe', 'FC26.exe', 'NFSUnbound.exe', 'Wow.exe', 'WowClassic.exe',
            'Diablo IV.exe', 'D2R.exe', 'Hearthstone.exe', 'VALORANT-Win64-Shipping.exe', 'League of Legends.exe', 'Minecraft.Windows.exe',
            'RobloxPlayerBeta.exe', 'GenshinImpact.exe', 'ZenlessZoneZero.exe', 'StarRail.exe', 'WorldOfTanks.exe', 'WorldOfWarships.exe',
            'Warframe.x64.exe', 'PathOfExile_x64.exe', 'FortniteClient-Win64-Shipping.exe', 'RocketLeague.exe', 'altv.exe', 'ragemp_v.exe')) {
        $h[$x.ToLowerInvariant()] = $true
    }
    return $h
}

# ------------------------------------------------------------------ paths (Windows syntax, also on Linux)

function Join-VxWinPath([string]$A, [string]$B) {
    if (-not $A) { return $null }
    if (-not $B) { return $A }
    return ($A.TrimEnd('\', '/') + '\' + $B.TrimStart('\', '/'))
}

# Normalizes a path from a launcher file or the registry: quotes, %VARS%, '/' -> '\', doubled '\'.
function ConvertTo-VxWinPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $x = $Path.Trim().Trim('"').Trim()
    if ($x.Contains('%')) { $x = [Environment]::ExpandEnvironmentVariables($x) }
    $x = $x.Replace('/', '\')
    $head = ''
    if ($x.StartsWith('\\')) { $head = '\\'; $x = $x.Substring(2) }
    $x = $head + [regex]::Replace($x, '\\{2,}', '\')
    if ($x.Length -gt 3) { $x = $x.TrimEnd('\') }
    return $x
}

# Exe from an uninstall entry's DisplayIcon ("C:\x\game.exe",0 / C:\x\game.exe,-101).
function ConvertTo-VxIconPath([string]$Raw) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return '' }
    $x = $Raw.Trim()
    if ($x.StartsWith('"')) {
        $e = $x.IndexOf('"', 1)
        if ($e -gt 0) { $x = $x.Substring(1, $e - 1) }
    } else {
        $x = [regex]::Replace($x, ',\s*-?\d+\s*$', '')
    }
    return (ConvertTo-VxWinPath $x)
}

function Format-VxGameName([string]$Name) {
    $n = [regex]::Replace([string]$Name, '[\u2122\u00AE\u00A9]', '')
    return ([regex]::Replace($n, '\s+', ' ')).Trim()
}

function ConvertTo-VxGameKey([string]$Text) {
    return [regex]::Replace(([string]$Text).ToLowerInvariant(), '[^a-z0-9]', '')
}

# ------------------------------------------------------------------ the PC the detection looks at

# Real Windows: this PC's registry, folders, drives and processes (reads only - also in Testmodus).
# Off Windows (or in Testmodus with $env:VELOX_GAMES_FIXTURE set): a fake PC described by tests/fixtures/games/pc/system.json
# whose C:\ and D:\ are the folders C/ and D/ next to it, so the whole detection and the art
# pipeline run for real in the tests. $null when neither exists.
function Get-VxGameSystem {
    $ctx = $global:VxCtx
    $root = [string]$env:VELOX_GAMES_FIXTURE
    # Testmodus may point the detection at a fixture PC (tests); otherwise Windows reads this PC
    if ($ctx.Windows -and -not ($ctx.Simulate -and $root)) { return (New-VxRealGameSystem) }
    if (-not $root -and $ctx.AppRoot) { $root = [IO.Path]::Combine([string]$ctx.AppRoot, 'tests', 'fixtures', 'games', 'pc') }
    if ($root -and [IO.File]::Exists([IO.Path]::Combine($root, 'system.json'))) {
        try { return (New-VxFixtureGameSystem $root) } catch { Write-VxFileLog 'warn' ('Spiele-Testdaten unlesbar: ' + $_.Exception.Message) }
    }
    return $null
}

function New-VxRealGameSystem {
    $drives = New-Object System.Collections.Generic.List[string]
    try {
        foreach ($d in [IO.DriveInfo]::GetDrives()) {
            try { if ($d.DriveType -eq [IO.DriveType]::Fixed -and $d.IsReady) { $drives.Add($d.RootDirectory.FullName) } } catch { $null = $_ }
        }
    } catch { $null = $_ }
    $pf = [string]$env:ProgramW6432
    if (-not $pf) { $pf = [string]$env:ProgramFiles }
    return @{
        Root = $null; Real = $true; Reg = $null; Processes = $null; Appx = $null; Deadline = [DateTime]::MaxValue
        Folders = @{
            localAppData = [string](Get-VxUserFolder 'localAppData'); appData = [string](Get-VxUserFolder 'appData')
            programData = [string]$env:ProgramData; programFiles = $pf; programFilesX86 = [string]${env:ProgramFiles(x86)}
            systemRoot = [string]$env:SystemRoot
        }
        Drives = @($drives)
    }
}

function New-VxFixtureGameSystem([string]$Root) {
    $j = Read-VxJsonFile ([IO.Path]::Combine($Root, 'system.json'))
    $folders = @{}
    $f = Get-VxProp $j 'folders'
    if ($null -ne $f) { foreach ($p in $f.PSObject.Properties) { $folders[$p.Name] = [string]$p.Value } }
    $reg = @{}
    $r = Get-VxProp $j 'registry'
    if ($null -ne $r) {
        foreach ($k in $r.PSObject.Properties) {
            $vals = @{}
            if ($null -ne $k.Value) { foreach ($v in $k.Value.PSObject.Properties) { $vals[$v.Name] = $v.Value } }
            $reg[$k.Name.ToLowerInvariant()] = @{ path = [string]$k.Name; values = $vals }
        }
    }
    return @{
        Root = $Root; Real = $false; Reg = $reg; Deadline = [DateTime]::MaxValue
        Folders = $folders
        Drives = @(@(Get-VxProp $j 'drives' @()) | ForEach-Object { [string]$_ })
        Processes = @(Get-VxProp $j 'processes' @())
        Appx = @(Get-VxProp $j 'appx' @())
    }
}

function Test-VxGameTimeUp($Sys) { return ([DateTime]::UtcNow -gt $Sys.Deadline) }

# Registry value ($null when missing) / subkey names - real registry or the fixture's.
function Get-VxGameReg($Sys, [string]$Path, [string]$Name) {
    if ($null -ne $Sys.Reg) {
        $k = $Sys.Reg[$Path.ToLowerInvariant()]
        if ($null -eq $k -or -not $k.values.ContainsKey($Name)) { return $null }
        return $k.values[$Name]
    }
    try {
        $v = Get-VxRegValue $Path $Name
        if ($v.exists) { return $v.value }
    } catch { $null = $_ }
    return $null
}

function Get-VxGameRegKeys($Sys, [string]$Path) {
    if ($null -ne $Sys.Reg) {
        $pre = $Path.TrimEnd('\').ToLowerInvariant() + '\'
        $names = New-Object System.Collections.Generic.List[string]
        foreach ($k in @($Sys.Reg.Keys)) {
            if (-not $k.StartsWith($pre)) { continue }
            $seg = ([string]$Sys.Reg[$k].path).Substring($pre.Length).Split('\')[0]
            if ($seg -and -not ($names | Where-Object { $_ -ieq $seg })) { $names.Add($seg) }
        }
        return @($names | Sort-Object)
    }
    try { return @(Get-VxRegSubKeys $Path) } catch { return @() }
}

# Windows path -> path on disk. Real PC: unchanged. Fixture: X:\a\b -> <root>/X/a/b, matched
# case-insensitively like Windows does (registry values often are lower case: c:/program files ...).
function Resolve-VxGamePath($Sys, [string]$Path) {
    if (-not $Path) { return $null }
    if ($null -eq $Sys.Root) { return $Path }
    $m = [regex]::Match($Path, '^([A-Za-z]):(\\(.*))?$')
    if (-not $m.Success) { return $null }
    $cur = [IO.Path]::Combine([string]$Sys.Root, $m.Groups[1].Value.ToUpperInvariant())
    foreach ($seg in ([string]$m.Groups[3].Value).Split('\')) {
        if (-not $seg -or $seg -eq '.') { continue }
        if ($seg -eq '..') { return $null }
        $next = [IO.Path]::Combine($cur, $seg)
        if (-not [IO.File]::Exists($next) -and -not [IO.Directory]::Exists($next) -and [IO.Directory]::Exists($cur)) {
            foreach ($e in [IO.Directory]::GetFileSystemEntries($cur)) {
                if ([IO.Path]::GetFileName($e) -ieq $seg) { $next = $e; break }
            }
        }
        $cur = $next
    }
    return $cur
}

function Test-VxGameFile($Sys, [string]$Path) {
    try { $p = Resolve-VxGamePath $Sys $Path; return ([bool]$p -and [IO.File]::Exists($p)) } catch { return $false }
}

function Test-VxGameDir($Sys, [string]$Path) {
    try { $p = Resolve-VxGamePath $Sys $Path; return ([bool]$p -and [IO.Directory]::Exists($p)) } catch { return $false }
}

# Names of the sub folders (sorted).
function Get-VxGameDirs($Sys, [string]$Dir) {
    $p = Resolve-VxGamePath $Sys $Dir
    if (-not $p) { return @() }
    try {
        if (-not [IO.Directory]::Exists($p)) { return @() }
        return @([IO.Directory]::GetDirectories($p) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
    } catch { return @() }
}

# Files of a folder as @{ name; size; mtime } (sorted by name).
function Get-VxGameFiles($Sys, [string]$Dir, [string]$Pattern = '*') {
    $p = Resolve-VxGamePath $Sys $Dir
    if (-not $p) { return @() }
    try {
        $di = New-Object IO.DirectoryInfo($p)
        if (-not $di.Exists) { return @() }
        return @($di.GetFiles($Pattern) | Sort-Object Name | ForEach-Object { @{ name = $_.Name; size = [long]$_.Length; mtime = $_.LastWriteTimeUtc } })
    } catch { return @() }
}

function Read-VxGameText($Sys, [string]$Path) {
    $p = Resolve-VxGamePath $Sys $Path
    if (-not $p) { return $null }
    try {
        $fi = New-Object IO.FileInfo($p)
        if (-not $fi.Exists -or $fi.Length -gt 4MB) { return $null }
        return [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
    } catch { return $null }
}

# ------------------------------------------------------------------ result list (deduplicated by exe path)

function New-VxGameFound { return @{ list = (New-Object System.Collections.ArrayList); seen = @{} } }

# Adds a game when its exe exists and was not found before. $Info: appid, cover, shape (wide|tall),
# icon - art paths in Windows syntax. Returns $true when added.
function Add-VxGameFound($Found, $Sys, [string]$Name, [string]$Path, [string]$Source, $Info = $null) {
    $p = ConvertTo-VxWinPath $Path
    if (-not $p -or -not $p.ToLowerInvariant().EndsWith('.exe')) { return $false }
    $key = $p.ToLowerInvariant()
    if ($Found.seen.ContainsKey($key)) { return $false }
    if (-not (Test-VxGameFile $Sys $p)) { return $false }
    $Found.seen[$key] = $true
    $n = Format-VxGameName $Name
    if (-not $n) { $n = Get-VxPathStem $p }
    $g = @{ name = $n; path = $p; source = $Source; appid = $null; cover = $null; shape = $null; icon = $null; running = $false }
    if ($null -ne $Info) { foreach ($k in @('appid', 'cover', 'shape', 'icon', 'running')) { if ($Info.ContainsKey($k) -and $Info[$k]) { $g[$k] = [string]$Info[$k] } } }
    [void]$Found.list.Add($g)
    return $true
}

# ------------------------------------------------------------------ "which exe is the game?"

function Test-VxNonGameExe([string]$Name) {
    $s = (Get-VxPathStem $Name).ToLowerInvariant()
    return ($s -match '^(unins\d*|uninst.*|uninstall.*|setup.*|.*[-_ ]setup|install.*|.*installer.*|vc_?redist.*|vcredist.*|dxsetup|dxwebsetup|directx.*|dotnet.*|ndp\d.*|oalinst|physx.*|ue\d?prereq.*|prereq.*|unitycrashhandler.*|crashreport.*|crashpad.*|crashsender.*|.*crashhandler.*|.*crash_?reporter.*|bugreport.*|.*bugsplat.*|easyanticheat.*|eac(_?launcher)?|start_protected_game|beservice.*|battleye.*|be_?launcher|.*_be|vanguard|vgc|xigncode.*|nprotect.*|.*launcher.*|.*helper.*|.*updater.*|update|patcher.*|redist.*|cefprocess|cefsharp.*|.*webhelper|.*webview.*|.*errorreporter.*|quicksfv|7z.*|touchup|activation.*|gamelaunchhelper|cleanup.*|.*configtool.*|.*config|.*settings|.*benchmark.*|.*server.*|dedicated.*|.*editor.*|python.*|javaw?|node|.*uploader.*|.*reporter.*|.*overlay.*|steam_?api.*|.*service.*|.*elevate.*|ffmpeg|vrstartup|.*bootstrap.*)$')
}

function Test-VxNonGameDir([string]$Name) {
    return ($Name.ToLowerInvariant() -match '^(_?commonredist|redist|redistributables?|_redist|directx|dxsetup|vcredist|vc_?redist|support|installers?|_+installer|easyanticheat.*|eac|battleye|prereq.*|prerequisites|physx|dotnet.*|netfx.*|monobleedingedge|engine|tools?|docs?|manuals?|crashreport.*|crashpad|launcher|uninstall.*|.*_data|thirdparty|third_?party|extras?|soundtrack|ost|artbook|bonus.*|sdk|.*editor.*|server|dedicated.*|logs?|cache|shadercache|screenshots|saves?|mods|workshop|overlay|anticheat.*)$')
}

# Best guess for the game exe in an install folder: every .exe up to two folders deep (plus the
# Unreal "<Game>\Binaries\Win64" folders a bit deeper), without crash handlers, launchers,
# redistributables, uninstallers and anti-cheat services. Known game exe names win, then Unreal
# "*-Shipping.exe", then a name that looks like the game, then the biggest file.
function Find-VxGameExe($Sys, [string]$Dir, [string]$Hint = '') {
    if (-not $Dir -or -not (Test-VxGameDir $Sys $Dir)) { return $null }
    $known = $Sys.KnownExes
    if ($null -eq $known) { $known = Get-VxKnownExeNames; $Sys.KnownExes = $known }
    $hintKey = ConvertTo-VxGameKey $Hint
    $best = $null
    $bestScore = -1.0
    $queue = New-Object System.Collections.ArrayList
    [void]$queue.Add(@{ dir = $Dir; depth = 0 })
    $i = 0
    while ($i -lt $queue.Count -and $i -lt 250) {
        if (Test-VxGameTimeUp $Sys) { break }
        $q = $queue[$i]
        $i++
        foreach ($f in @(Get-VxGameFiles $Sys $q.dir '*.exe')) {
            if (Test-VxNonGameExe $f.name) { continue }
            $score = [double]$f.size
            if ($known.ContainsKey($f.name.ToLowerInvariant())) { $score += 4e12 }
            if ($f.name -match '(?i)-(Win64|WinGDK|Win32)-Shipping\.exe$') { $score += 2e12 }
            $stemKey = ConvertTo-VxGameKey (Get-VxPathStem $f.name)
            if ($hintKey -and $stemKey.Length -ge 3 -and ($hintKey.Contains($stemKey) -or $stemKey.Contains($hintKey))) { $score += 1e12 }
            if ($score -gt $bestScore) { $bestScore = $score; $best = Join-VxWinPath $q.dir $f.name }
        }
        $childDepth = $q.depth + 1
        if ($childDepth -gt 4) { continue }
        foreach ($d in @(Get-VxGameDirs $Sys $q.dir)) {
            if (Test-VxNonGameDir $d) { continue }
            if ($childDepth -gt 2 -and $d -notmatch '^(?i)(binaries|win64|wingdk|x64)$') { continue }
            [void]$queue.Add(@{ dir = (Join-VxWinPath $q.dir $d); depth = $childDepth })
        }
    }
    return $best
}

# First existing "<dir>\<rel>" of a list.
function Find-VxGameExeIn($Sys, [string]$Dir, $Rels) {
    if (-not $Dir) { return $null }
    foreach ($rel in @($Rels)) {
        if (-not $rel) { continue }
        $p = Join-VxWinPath $Dir ([string]$rel)
        if (Test-VxGameFile $Sys $p) { return $p }
    }
    return $null
}

function Get-VxUninstallRoots {
    return @('HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall')
}

# Uninstall entries (read once per detection): @{ key; name; publisher; location; icon }.
function Get-VxUninstallEntries($Sys) {
    if ($null -ne $Sys.Uninstall) { return $Sys.Uninstall }
    $list = New-Object System.Collections.ArrayList
    foreach ($base in @(Get-VxUninstallRoots)) {
        foreach ($k in @(Get-VxGameRegKeys $Sys $base)) {
            $key = $base + '\' + $k
            $dn = [string](Get-VxGameReg $Sys $key 'DisplayName')
            if (-not $dn) { continue }
            [void]$list.Add(@{
                    key = $k; name = $dn; publisher = [string](Get-VxGameReg $Sys $key 'Publisher')
                    location = (ConvertTo-VxWinPath ([string](Get-VxGameReg $Sys $key 'InstallLocation')))
                    icon = [string](Get-VxGameReg $Sys $key 'DisplayIcon')
                })
        }
    }
    $Sys.Uninstall = $list.ToArray()
    return $Sys.Uninstall
}

# ------------------------------------------------------------------ sources

function Get-VxSteamRoots($Sys) {
    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($q in @(@('HKLM\SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath'), @('HKLM\SOFTWARE\Valve\Steam', 'InstallPath'), @('HKCU\Software\Valve\Steam', 'SteamPath'))) {
        $v = ConvertTo-VxWinPath ([string](Get-VxGameReg $Sys $q[0] $q[1]))
        if ($v -and -not ($roots | Where-Object { $_ -ieq $v }) -and (Test-VxGameDir $Sys $v)) { $roots.Add($v) }
    }
    if ($roots.Count -eq 0) {
        $def = Join-VxWinPath $Sys.Folders.programFilesX86 'Steam'
        if ($def -and (Test-VxGameDir $Sys $def)) { $roots.Add($def) }
    }
    return @($roots)
}

# Every Steam library: the install folder(s) plus all paths in libraryfolders.vdf (new and old format).
function Get-VxSteamLibraries($Sys) {
    $libs = New-Object System.Collections.Generic.List[string]
    foreach ($r in @(Get-VxSteamRoots $Sys)) {
        if (-not ($libs | Where-Object { $_ -ieq $r })) { $libs.Add($r) }
        $text = Read-VxGameText $Sys (Join-VxWinPath $r 'steamapps\libraryfolders.vdf')
        if (-not $text) { $text = Read-VxGameText $Sys (Join-VxWinPath $r 'config\libraryfolders.vdf') }
        if (-not $text) { continue }
        $paths = New-Object System.Collections.Generic.List[string]
        foreach ($m in [regex]::Matches($text, '"path"\s+"((?:[^"\\]|\\.)*)"')) { $paths.Add($m.Groups[1].Value) }
        foreach ($m in [regex]::Matches($text, '(?m)^\s*"\d+"\s+"([A-Za-z]:(?:[^"\\]|\\.)*)"')) { $paths.Add($m.Groups[1].Value) }
        foreach ($raw in $paths) {
            $p = ConvertTo-VxWinPath ($raw.Replace('\\', '\'))
            if (-not $p) { continue }
            $idx = -1
            for ($i = 0; $i -lt $libs.Count; $i++) { if ($libs[$i] -ieq $p) { $idx = $i } }
            # the vdf spelling is the nicer one (the registry often has c:/program files (x86)/steam)
            if ($idx -ge 0) { $libs[$idx] = $p } else { $libs.Add($p) }
        }
    }
    return @($libs)
}

function Get-VxVdfValue([string]$Text, [string]$Key) {
    $m = [regex]::Match($Text, '(?im)^\s*"' + [regex]::Escape($Key) + '"\s+"((?:[^"\\]|\\.)*)"')
    if (-not $m.Success) { return $null }
    return ([regex]::Replace($m.Groups[1].Value, '\\(.)', '$1'))
}

# Steam's local library art: old flat names (<appid>_header.jpg ...) and the newer per-app folders
# (librarycache\<appid>\header.jpg, library_600x900.jpg, logo.png, <sha1>.jpg = icon, sometimes one
# sub folder deeper), plus the multi-size .ico Steam keeps for desktop shortcuts.
function Get-VxSteamArt($Sys, $Roots, [string]$AppId) {
    $art = @{}
    foreach ($r in @($Roots)) {
        $lc = Join-VxWinPath $r 'appcache\librarycache'
        if (-not (Test-VxGameDir $Sys $lc)) { continue }
        $c = @{}
        foreach ($f in @(Get-VxGameFiles $Sys $lc ($AppId + '_*'))) {
            $n = $f.name.Substring($AppId.Length + 1).ToLowerInvariant()
            if (-not $c.ContainsKey($n)) { $c[$n] = Join-VxWinPath $lc $f.name }
        }
        $dir = Join-VxWinPath $lc $AppId
        if (Test-VxGameDir $Sys $dir) {
            $dirs = @($dir) + @(@(Get-VxGameDirs $Sys $dir) | Select-Object -First 6 | ForEach-Object { Join-VxWinPath $dir $_ })
            foreach ($d in $dirs) {
                foreach ($f in @(Get-VxGameFiles $Sys $d '*')) {
                    $n = $f.name.ToLowerInvariant()
                    if ($n -match '^[0-9a-f]{40}\.(jpg|png)$') { $n = 'icon.jpg' }
                    if (-not $c.ContainsKey($n)) { $c[$n] = Join-VxWinPath $d $f.name }
                }
            }
        }
        foreach ($n in @('header.jpg', 'library_header.jpg', 'library_hero.jpg')) { if (-not $art.cover -and $c.ContainsKey($n)) { $art.cover = $c[$n]; $art.shape = 'wide' } }
        foreach ($n in @('library_600x900.jpg', 'library_capsule.jpg', 'library_600x900_2x.jpg')) { if (-not $art.cover -and $c.ContainsKey($n)) { $art.cover = $c[$n]; $art.shape = 'tall' } }
        if ($c.ContainsKey('icon.jpg')) { $art.icon = $c['icon.jpg'] }
        if ($art.cover -or $art.icon) { break }
    }
    foreach ($u in @(Get-VxUninstallRoots)) {
        $ico = ConvertTo-VxIconPath ([string](Get-VxGameReg $Sys ($u + '\Steam App ' + $AppId) 'DisplayIcon'))
        if ($ico -and $ico.ToLowerInvariant().EndsWith('.ico') -and (Test-VxGameFile $Sys $ico)) { $art.icon = $ico; break }
    }
    return $art
}

function Find-VxSteamGames($Sys, $Found) {
    $roots = @(Get-VxSteamRoots $Sys)
    $map = Get-VxSteamExeMap
    # runtimes, Proton, redistributables, SteamVR, Wallpaper Engine are no games
    $skip = @('228980', '1070560', '1391110', '1628350', '1493710', '2180100', '2348590', '250820', '431960', '1826330', '2230260', '1161040')
    foreach ($lib in @(Get-VxSteamLibraries $Sys)) {
        $apps = Join-VxWinPath $lib 'steamapps'
        foreach ($f in @(Get-VxGameFiles $Sys $apps 'appmanifest_*.acf')) {
            if (Test-VxGameTimeUp $Sys) { return }
            try {
                $text = Read-VxGameText $Sys (Join-VxWinPath $apps $f.name)
                if (-not $text) { continue }
                $appid = Get-VxVdfValue $text 'appid'
                $name = Get-VxVdfValue $text 'name'
                $dir = Get-VxVdfValue $text 'installdir'
                if (-not $appid -or -not $dir) { continue }
                if ($skip -contains $appid -or $name -match '^(?i)(proton|steam linux runtime|steamworks|steamvr)') { continue }
                $flags = Get-VxVdfValue $text 'StateFlags'
                if ($flags -match '^\d+$' -and ([long]$flags -band 4) -eq 0) { continue }
                $gameDir = Join-VxWinPath (Join-VxWinPath $apps 'common') $dir
                if (-not (Test-VxGameDir $Sys $gameDir)) { continue }
                $exe = Find-VxGameExeIn $Sys $gameDir $map[$appid]
                if (-not $exe) { $exe = Find-VxGameExe $Sys $gameDir $name }
                if (-not $exe) { continue }
                $info = Get-VxSteamArt $Sys $roots $appid
                $info['appid'] = $appid
                $null = Add-VxGameFound $Found $Sys $name $exe 'steam' $info
            } catch { Write-VxFileLog 'warn' ('Steam-Manifest ' + $f.name + ': ' + $_.Exception.Message) }
        }
    }
}

function Find-VxEpicGames($Sys, $Found) {
    $man = Join-VxWinPath $Sys.Folders.programData 'Epic\EpicGamesLauncher\Data\Manifests'
    foreach ($f in @(Get-VxGameFiles $Sys $man '*.item')) {
        if (Test-VxGameTimeUp $Sys) { return }
        try {
            $j = ConvertFrom-VxJsonText (Read-VxGameText $Sys (Join-VxWinPath $man $f.name))
            if ($null -eq $j -or [bool](Get-VxProp $j 'bIsIncompleteInstall' $false)) { continue }
            # Unreal Engine, plugins and other software also have manifests
            $cats = @(Get-VxProp $j 'AppCategories' @())
            if ($cats.Count -gt 0 -and -not ($cats -contains 'games')) { continue }
            $rel = ConvertTo-VxWinPath ([string](Get-VxProp $j 'LaunchExecutable'))
            $loc = ConvertTo-VxWinPath ([string](Get-VxProp $j 'InstallLocation'))
            if (-not $rel -or -not $loc) { continue }
            $exe = Join-VxWinPath $loc $rel
            # "FortniteLauncher.exe" only starts the real game process next to it
            if ((Get-VxPathStem $rel) -match '(?i)launcher') {
                $folder = $exe.Substring(0, $exe.LastIndexOf('\'))
                $ship = @(Get-VxGameFiles $Sys $folder '*-Shipping.exe' | Sort-Object { -not ($_.name -match '(?i)client') })[0]
                if ($null -ne $ship) { $exe = Join-VxWinPath $folder $ship.name }
            }
            $null = Add-VxGameFound $Found $Sys ([string](Get-VxProp $j 'DisplayName' '')) $exe 'epic' @{ appid = [string](Get-VxProp $j 'AppName' '') }
        } catch { Write-VxFileLog 'warn' ('Epic-Manifest ' + $f.name + ': ' + $_.Exception.Message) }
    }
}

function Find-VxGogGames($Sys, $Found) {
    foreach ($base in @('HKLM\SOFTWARE\WOW6432Node\GOG.com\Games', 'HKLM\SOFTWARE\GOG.com\Games')) {
        foreach ($k in @(Get-VxGameRegKeys $Sys $base)) {
            if (Test-VxGameTimeUp $Sys) { return }
            $key = $base + '\' + $k
            $name = [string](Get-VxGameReg $Sys $key 'gameName')
            $dir = ConvertTo-VxWinPath ([string](Get-VxGameReg $Sys $key 'path'))
            $exe = ConvertTo-VxWinPath ([string](Get-VxGameReg $Sys $key 'exe'))
            if (-not $exe -and $dir) {
                $ef = [string](Get-VxGameReg $Sys $key 'exeFile')
                if ($ef) { $exe = Join-VxWinPath $dir $ef }
            }
            if ((-not $exe -or -not (Test-VxGameFile $Sys $exe)) -and $dir) { $exe = Find-VxGameExe $Sys $dir $name }
            $id = [string](Get-VxGameReg $Sys $key 'gameID')
            if (-not $id) { $id = $k }
            $info = @{ appid = $id }
            if ($dir) {
                $ico = Join-VxWinPath $dir ('goggame-' + $id + '.ico')
                if (-not (Test-VxGameFile $Sys $ico)) {
                    $ico = $null
                    $any = @(Get-VxGameFiles $Sys $dir 'goggame-*.ico')[0]
                    if ($null -ne $any) { $ico = Join-VxWinPath $dir $any.name }
                }
                if ($ico) { $info.icon = $ico }
            }
            $null = Add-VxGameFound $Found $Sys $name $exe 'gog' $info
        }
    }
}

function Find-VxUbisoftGames($Sys, $Found) {
    foreach ($base in @('HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs', 'HKLM\SOFTWARE\Ubisoft\Launcher\Installs')) {
        foreach ($k in @(Get-VxGameRegKeys $Sys $base)) {
            if (Test-VxGameTimeUp $Sys) { return }
            $dir = ConvertTo-VxWinPath ([string](Get-VxGameReg $Sys ($base + '\' + $k) 'InstallDir'))
            if (-not $dir -or -not (Test-VxGameDir $Sys $dir)) { continue }
            $name = Get-VxPathLeaf $dir
            $null = Add-VxGameFound $Found $Sys $name (Find-VxGameExe $Sys $dir $name) 'ubisoft' @{ appid = $k }
        }
    }
}

function Find-VxEaGames($Sys, $Found) {
    foreach ($base in @('HKLM\SOFTWARE\WOW6432Node\EA Games', 'HKLM\SOFTWARE\EA Games', 'HKLM\SOFTWARE\WOW6432Node\Origin Games', 'HKLM\SOFTWARE\Origin Games')) {
        foreach ($k in @(Get-VxGameRegKeys $Sys $base)) {
            if (Test-VxGameTimeUp $Sys) { return }
            $key = $base + '\' + $k
            $dir = ''
            foreach ($vn in @('Install Dir', 'InstallDir', 'InstallLocation')) { if (-not $dir) { $dir = ConvertTo-VxWinPath ([string](Get-VxGameReg $Sys $key $vn)) } }
            if (-not $dir -or -not (Test-VxGameDir $Sys $dir)) { continue }
            $name = [string](Get-VxGameReg $Sys $key 'DisplayName')
            if (-not $name) { $name = $k }
            if ($name -match '^(OFB-|Origin\.|\d)') { $name = Get-VxPathLeaf $dir }
            $null = Add-VxGameFound $Found $Sys $name (Find-VxGameExe $Sys $dir $name) 'ea'
        }
    }
    # EA app default folders: every game there has an __Installer folder
    foreach ($root in @((Join-VxWinPath $Sys.Folders.programFiles 'EA Games'), (Join-VxWinPath $Sys.Folders.programFilesX86 'Origin Games'))) {
        foreach ($d in @(Get-VxGameDirs $Sys $root)) {
            if (Test-VxGameTimeUp $Sys) { return }
            $dir = Join-VxWinPath $root $d
            if (-not (Test-VxGameDir $Sys (Join-VxWinPath $dir '__Installer'))) { continue }
            $null = Add-VxGameFound $Found $Sys $d (Find-VxGameExe $Sys $dir $d) 'ea'
        }
    }
}

function Find-VxBattleNetGames($Sys, $Found) {
    $known = @(
        @{ m = '^Overwatch'; exe = @('_retail_\Overwatch.exe', 'Overwatch.exe') },
        @{ m = '^Diablo IV'; exe = @('Diablo IV.exe') },
        @{ m = '^Diablo III'; exe = @('x64\Diablo III64.exe', 'Diablo III64.exe') },
        @{ m = '^Diablo II'; exe = @('D2R.exe') },
        @{ m = '^World of Warcraft'; exe = @('_retail_\Wow.exe', '_classic_\WowClassic.exe', '_classic_era_\WowClassic.exe') },
        @{ m = '^Hearthstone'; exe = @('Hearthstone.exe') },
        @{ m = '^Warcraft III'; exe = @('_retail_\x86_64\Warcraft III.exe') },
        @{ m = '^Call of Duty'; exe = @('cod.exe', 'ModernWarfare.exe', 'BlackOpsColdWar.exe', 'Vanguard.exe') }
    )
    foreach ($e in @(Get-VxUninstallEntries $Sys)) {
        if (Test-VxGameTimeUp $Sys) { return }
        if ($e.publisher -notmatch '(?i)blizzard|activision' -or $e.name -match '^(?i)battle\.net' -or -not $e.location) { continue }
        $exe = $null
        foreach ($k in $known) { if (-not $exe -and $e.name -match ('(?i)' + $k.m)) { $exe = Find-VxGameExeIn $Sys $e.location $k.exe } }
        if (-not $exe) { $exe = Find-VxGameExe $Sys $e.location $e.name }
        $null = Add-VxGameFound $Found $Sys $e.name $exe 'battlenet'
    }
}

function Find-VxRiotGames($Sys, $Found) {
    $dirs = New-Object System.Collections.Generic.List[string]
    $pd = $Sys.Folders.programData
    try {
        $j = ConvertFrom-VxJsonText (Read-VxGameText $Sys (Join-VxWinPath $pd 'Riot Games\RiotClientInstalls.json'))
        $ac = Get-VxProp $j 'associated_client'
        if ($null -ne $ac) { foreach ($p in $ac.PSObject.Properties) { $dirs.Add((ConvertTo-VxWinPath $p.Name)) } }
    } catch { $null = $_ }
    $meta = Join-VxWinPath $pd 'Riot Games\Metadata'
    foreach ($d in @(Get-VxGameDirs $Sys $meta)) {
        foreach ($f in @(Get-VxGameFiles $Sys (Join-VxWinPath $meta $d) '*.product_settings.yaml')) {
            $t = Read-VxGameText $Sys (Join-VxWinPath (Join-VxWinPath $meta $d) $f.name)
            $m = [regex]::Match([string]$t, '(?m)^\s*product_install_full_path:\s*"?([^"\r\n]+)"?')
            if ($m.Success) { $dirs.Add((ConvertTo-VxWinPath $m.Groups[1].Value)) }
        }
    }
    foreach ($drv in @($Sys.Drives)) {
        $dirs.Add((Join-VxWinPath $drv 'Riot Games\VALORANT\live'))
        $dirs.Add((Join-VxWinPath $drv 'Riot Games\League of Legends'))
    }
    foreach ($d in $dirs) {
        if (-not $d) { continue }
        if ($d -match '(?i)valorant') { $null = Add-VxGameFound $Found $Sys 'VALORANT' (Join-VxWinPath $d 'ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe') 'riot' }
        elseif ($d -match '(?i)league of legends') { $null = Add-VxGameFound $Found $Sys 'League of Legends' (Join-VxWinPath $d 'Game\League of Legends.exe') 'riot' }
        elseif ($d -match '(?i)\\LoR(\\|$)') { $null = Add-VxGameFound $Found $Sys 'Legends of Runeterra' (Join-VxWinPath $d 'LoR.exe') 'riot' }
        elseif ($d -match '(?i)2XKO') { $null = Add-VxGameFound $Found $Sys '2XKO' (Find-VxGameExe $Sys $d '2XKO') 'riot' }
    }
}

# Xbox app / PC Game Pass folders: "XboxGames" on every drive, or what the drive's .GamingRoot names.
function Get-VxXboxRoots($Sys) {
    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($drv in @($Sys.Drives)) {
        $names = New-Object System.Collections.Generic.List[string]
        $names.Add('XboxGames')
        $gr = Resolve-VxGamePath $Sys (Join-VxWinPath $drv '.GamingRoot')
        try {
            if ($gr -and [IO.File]::Exists($gr)) {
                $b = [IO.File]::ReadAllBytes($gr)
                if ($b.Length -gt 8 -and $b.Length -lt 65536) {
                    foreach ($s in [Text.Encoding]::Unicode.GetString($b, 8, $b.Length - 8).Split([char]0)) {
                        $s = $s.Trim().TrimStart('\')
                        if ($s -and $s -notmatch '[\x00-\x1f:*?"<>|]') { $names.Add($s) }
                    }
                }
            }
        } catch { $null = $_ }
        foreach ($n in $names) {
            $p = Join-VxWinPath $drv $n
            if (-not ($roots | Where-Object { $_ -ieq $p }) -and (Test-VxGameDir $Sys $p)) { $roots.Add($p) }
        }
    }
    return @($roots)
}

# Image of a package: the exact file, else the biggest "name.scale-NNN.ext" variant.
function Resolve-VxPackageImage($Sys, [string]$Dir, [string]$Rel) {
    if (-not $Rel) { return $null }
    $p = Join-VxWinPath $Dir (ConvertTo-VxWinPath $Rel)
    if (Test-VxGameFile $Sys $p) { return $p }
    $cut = $p.LastIndexOf('\')
    $parent = $p.Substring(0, $cut)
    $leaf = $p.Substring($cut + 1)
    $dot = $leaf.LastIndexOf('.')
    if ($dot -le 0) { return $null }
    $best = $null
    $bestScale = 0
    foreach ($f in @(Get-VxGameFiles $Sys $parent ($leaf.Substring(0, $dot) + '.*' + $leaf.Substring($dot)))) {
        $m = [regex]::Match($f.name, '(?i)scale-(\d+)')
        $s = 1
        if ($m.Success) { $s = [int]$m.Groups[1].Value }
        if ($s -gt $bestScale) { $bestScale = $s; $best = Join-VxWinPath $parent $f.name }
    }
    return $best
}

function Find-VxXboxGames($Sys, $Found) {
    foreach ($root in @(Get-VxXboxRoots $Sys)) {
        foreach ($d in @(Get-VxGameDirs $Sys $root)) {
            if (Test-VxGameTimeUp $Sys) { return }
            try {
                $content = Join-VxWinPath (Join-VxWinPath $root $d) 'Content'
                $text = Read-VxGameText $Sys (Join-VxWinPath $content 'MicrosoftGame.config')
                if (-not $text) { continue }
                $x = New-Object System.Xml.XmlDocument
                $x.XmlResolver = $null
                $x.LoadXml($text)
                $game = $x.DocumentElement
                $sv = $game.SelectSingleNode("*[local-name()='ShellVisuals']")
                $name = ''
                if ($null -ne $sv) { $name = $sv.GetAttribute('DefaultDisplayName') }
                if (-not $name -or $name -like 'ms-resource:*') { $name = $d }
                $exes = @($game.SelectNodes("*[local-name()='ExecutableList']/*[local-name()='Executable']") | ForEach-Object { $_.GetAttribute('Name') } | Where-Object { $_ })
                $pick = @($exes | Where-Object { $_ -notmatch '(?i)gamelaunchhelper' })[0]
                if (-not $pick) { $pick = $exes[0] }
                if (-not $pick) { continue }
                $info = @{}
                $idn = $game.SelectSingleNode("*[local-name()='Identity']")
                if ($null -ne $idn) { $info.appid = $idn.GetAttribute('Name') }
                if ($null -ne $sv) {
                    foreach ($a in @('Square480x480Logo', 'Square150x150Logo', 'StoreLogo')) {
                        if (-not $info.icon) { $img = Resolve-VxPackageImage $Sys $content $sv.GetAttribute($a); if ($img) { $info.icon = $img } }
                    }
                    $splash = Resolve-VxPackageImage $Sys $content $sv.GetAttribute('SplashScreenImage')
                    if ($splash) { $info.cover = $splash; $info.shape = 'wide' }
                }
                $null = Add-VxGameFound $Found $Sys $name (Join-VxWinPath $content $pick) 'xbox' $info
            } catch { Write-VxFileLog 'warn' ('Xbox-Spiel ' + $d + ': ' + $_.Exception.Message) }
        }
    }
}

function Find-VxRockstarGames($Sys, $Found) {
    $map = @{
        'grand theft auto v' = @('GTA5.exe'); 'gtav enhanced' = @('GTA5_Enhanced.exe'); 'grand theft auto v enhanced' = @('GTA5_Enhanced.exe')
        'red dead redemption 2' = @('RDR2.exe'); 'red dead redemption' = @('RDR.exe'); 'l.a. noire' = @('LANoire.exe'); 'max payne 3' = @('MaxPayne3.exe')
        'grand theft auto iv' = @('GTAIV.exe'); 'bully' = @('Bully.exe')
    }
    foreach ($base in @('HKLM\SOFTWARE\WOW6432Node\Rockstar Games', 'HKLM\SOFTWARE\Rockstar Games')) {
        foreach ($k in @(Get-VxGameRegKeys $Sys $base)) {
            if (Test-VxGameTimeUp $Sys) { return }
            if ($k -match '^(?i)(launcher|rockstar games launcher|social club|rockstar games social club)$') { continue }
            $dir = ConvertTo-VxWinPath ([string](Get-VxGameReg $Sys ($base + '\' + $k) 'InstallFolder'))
            if (-not $dir -or -not (Test-VxGameDir $Sys $dir)) { continue }
            if ($k -ieq 'Grand Theft Auto V') {
                $null = Add-VxGameFound $Found $Sys 'Grand Theft Auto V' (Join-VxWinPath $dir 'GTA5.exe') 'rockstar'
                $null = Add-VxGameFound $Found $Sys 'Grand Theft Auto V Enhanced' (Join-VxWinPath $dir 'GTA5_Enhanced.exe') 'rockstar'
                continue
            }
            $exe = Find-VxGameExeIn $Sys $dir $map[$k.ToLowerInvariant()]
            if (-not $exe) { $exe = Find-VxGameExe $Sys $dir $k }
            $null = Add-VxGameFound $Found $Sys $k $exe 'rockstar'
        }
    }
}

# FiveM (launcher + its GTA processes), RedM, alt:V, RAGE Multiplayer.
function Find-VxCfxGames($Sys, $Found) {
    $lad = $Sys.Folders.localAppData
    if ($lad) {
        $null = Add-VxGameFound $Found $Sys 'FiveM' (Join-VxWinPath $lad 'FiveM\FiveM.exe') 'fivem'
        $sub = Join-VxWinPath $lad 'FiveM\FiveM.app\data\cache\subprocess'
        foreach ($f in @(Get-VxGameFiles $Sys $sub '*GTAProcess.exe')) {
            $label = 'FiveM Spielprozess'
            $bm = [regex]::Match($f.name, '(?i)_b(\d+)_')
            if ($bm.Success) { $label = 'FiveM Spielprozess (Build ' + $bm.Groups[1].Value + ')' }
            $null = Add-VxGameFound $Found $Sys $label (Join-VxWinPath $sub $f.name) 'fivem'
        }
        $null = Add-VxGameFound $Found $Sys 'RedM' (Join-VxWinPath $lad 'RedM\RedM.exe') 'fivem'
    }
    $alt = New-Object System.Collections.Generic.List[string]
    $rage = New-Object System.Collections.Generic.List[string]
    foreach ($drv in @($Sys.Drives)) {
        $alt.Add((Join-VxWinPath $drv 'altV'))
        $alt.Add((Join-VxWinPath $drv 'alt-V'))
        $rage.Add((Join-VxWinPath $drv 'RAGEMP'))
    }
    foreach ($e in @(Get-VxUninstallEntries $Sys)) {
        if (-not $e.location) { continue }
        if ($e.name -match '^(?i)alt[:\- ]?v') { $alt.Insert(0, $e.location) }
        elseif ($e.name -match '^(?i)rage ?(mp|multiplayer)') { $rage.Insert(0, $e.location) }
    }
    foreach ($d in $alt) { $null = Add-VxGameFound $Found $Sys 'alt:V' (Join-VxWinPath $d 'altv.exe') 'fivem' }
    foreach ($d in $rage) { $null = Add-VxGameFound $Found $Sys 'RAGE Multiplayer' (Join-VxWinPath $d 'ragemp_v.exe') 'fivem' }
}

# Installed Appx packages of one name: @{ Name; InstallLocation } (fixture list or Get-AppxPackage).
function Get-VxGameAppx($Sys, [string]$Name) {
    if ($null -ne $Sys.Appx) {
        return @(@($Sys.Appx) | Where-Object { [string](Get-VxProp $_ 'Name') -eq $Name } | ForEach-Object { @{ Name = [string](Get-VxProp $_ 'Name'); InstallLocation = [string](Get-VxProp $_ 'InstallLocation') } })
    }
    if (-not $Sys.Real) { return @() }
    try { return @(Get-AppxPackage -Name $Name -ErrorAction Stop | ForEach-Object { @{ Name = [string]$_.Name; InstallLocation = [string]$_.InstallLocation } }) } catch { return @() }
}

function Find-VxMinecraftGames($Sys, $Found) {
    foreach ($pf in @($Sys.Folders.programFilesX86, $Sys.Folders.programFiles)) {
        if ($pf) { $null = Add-VxGameFound $Found $Sys 'Minecraft: Java Edition' (Join-VxWinPath $pf 'Minecraft Launcher\MinecraftLauncher.exe') 'minecraft' }
    }
    foreach ($pkg in @(Get-VxGameAppx $Sys 'Microsoft.4297127D64EC6')) {
        $null = Add-VxGameFound $Found $Sys 'Minecraft: Java Edition' (Join-VxWinPath (ConvertTo-VxWinPath $pkg.InstallLocation) 'Minecraft.exe') 'minecraft'
    }
    foreach ($pkg in @(Get-VxGameAppx $Sys 'Microsoft.MinecraftUWP')) {
        $null = Add-VxGameFound $Found $Sys 'Minecraft for Windows' (Join-VxWinPath (ConvertTo-VxWinPath $pkg.InstallLocation) 'Minecraft.Windows.exe') 'minecraft'
    }
}

# Roblox keeps one folder per version; the newest RobloxPlayerBeta.exe is the one that runs.
function Find-VxRobloxGames($Sys, $Found) {
    $best = $null
    $bestTime = [DateTime]::MinValue
    foreach ($b in @($Sys.Folders.localAppData, $Sys.Folders.programFilesX86, $Sys.Folders.programFiles)) {
        $base = Join-VxWinPath $b 'Roblox\Versions'
        foreach ($d in @(Get-VxGameDirs $Sys $base)) {
            $f = @(Get-VxGameFiles $Sys (Join-VxWinPath $base $d) 'RobloxPlayerBeta.exe')[0]
            if ($null -ne $f -and $f.mtime -ge $bestTime) { $best = Join-VxWinPath (Join-VxWinPath $base $d) $f.name; $bestTime = $f.mtime }
        }
    }
    if ($best) { $null = Add-VxGameFound $Found $Sys 'Roblox' $best 'roblox' }
}

# Uninstall entries of well-known game publishers (Steam games are covered by Steam itself).
function Get-VxGamePublisherSource([string]$Publisher) {
    $p = [string]$Publisher
    if (-not $p) { return $null }
    if ($p -match '(?i)blizzard|activision') { return 'battlenet' }
    if ($p -match '(?i)riot games') { return 'riot' }
    if ($p -match '(?i)electronic arts|^ea\b|ea swiss') { return 'ea' }
    if ($p -match '(?i)ubisoft') { return 'ubisoft' }
    if ($p -match '(?i)rockstar') { return 'rockstar' }
    if ($p -match '(?i)mojang') { return 'minecraft' }
    if ($p -match '(?i)\b(bethesda|id software|cd projekt|bungie|square enix|bandai namco|sega|capcom|paradox|wargaming|gaijin|mihoyo|hoyoverse|cognosphere|kuro games|grinding gear|digital extremes|jagex|embark|netease|krafton|pubg|nexon|smilegate|garena|tencent|level infinite|proxima beta|2k|take-two|warner bros|focus entertainment|deep silver|plaion|koch media|thq nordic|frontier developments|larian|arrowhead|hi-rez|pearl abyss|kakao games|bohemia interactive|facepunch|scs software|innersloth|re-logic|supercell|respawn|codemasters|psyonix|sony interactive|playstation pc|xbox game studios|hello games|fromsoftware|konami|team17|devolver|techland|remedy|io interactive|gearbox|crytek|funcom|gameforge|ncsoft|amazon games|moonton|lilith|innogames|bigpoint|gravity|webzen|perfect world|gameloft|marvelous|koei tecmo|nintendo)\b') { return 'other' }
    return $null
}

function Test-VxLauncherName([string]$Name) {
    return ($Name -match '^(?i)(steam|epic games launcher|ea app|ea desktop|origin|ubisoft connect|uplay|battle\.net|riot client|riot vanguard|rockstar games launcher|rockstar games social club|social club|gog galaxy|xbox|amazon games|itch|playnite|overwolf|curseforge|discord|nvidia|geforce|amd software|logitech|razer|corsair|steelseries|wallpaper engine|vulkan|directx|microsoft visual c\+\+|.*redistributable.*|.*runtime.*|easyanticheat|easy anti-cheat|battleye|vanguard|punkbuster|.*anti-?cheat.*|.*launcher$)')
}

function Find-VxUninstallGames($Sys, $Found) {
    foreach ($e in @(Get-VxUninstallEntries $Sys)) {
        if (Test-VxGameTimeUp $Sys) { return }
        if ($e.key -match '^(?i)steam app \d+$' -or (Test-VxLauncherName $e.name)) { continue }
        $src = Get-VxGamePublisherSource $e.publisher
        if (-not $src) { continue }
        $exe = ConvertTo-VxIconPath $e.icon
        if (-not $exe -or -not $exe.ToLowerInvariant().EndsWith('.exe') -or (Test-VxNonGameExe (Get-VxPathLeaf $exe)) -or -not (Test-VxGameFile $Sys $exe)) {
            $exe = $null
            if ($e.location) { $exe = Find-VxGameExe $Sys $e.location $e.name }
        }
        $null = Add-VxGameFound $Found $Sys $e.name $exe $src
    }
}

# Processes with a window: browsers, chat, tools and Windows itself never count.
function Get-VxGameProcessSkip {
    $h = @{}
    foreach ($n in @('explorer', 'chrome', 'msedge', 'firefox', 'opera', 'opera_gx', 'brave', 'vivaldi', 'iexplore', 'discord', 'steam', 'steamwebhelper',
            'epicgameslauncher', 'code', 'devenv', 'powershell', 'pwsh', 'cmd', 'conhost', 'windowsterminal', 'textinputhost',
            'applicationframehost', 'systemsettings', 'taskmgr', 'notepad', 'spotify', 'teams', 'ms-teams', 'outlook', 'winword', 'excel',
            'powerpnt', 'onedrive', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'lockapp', 'msedgewebview2',
            'nvidia app', 'nvcontainer', 'radeonsoftware', 'obs64', 'obs32', 'whatsapp', 'telegram', 'slack', 'zoom', 'signal', 'mmc', 'regedit',
            'battle.net', 'origin', 'eadesktop', 'ealauncher', 'ubisoftconnect', 'upc', 'riotclientservices', 'riotclientux', 'rockstarlauncher', 'launcher', 'fivem',
            'galaxyclient', 'xboxpcapp', 'gamebar', 'vlc', 'mpc-hc64', 'photos', 'snippingtool', 'mspaint', 'calculatorapp', 'nvidia share', 'medal', 'overwolf', 'parsecd', 'velox')) {
        $h[$n] = $true
    }
    return $h
}

function Get-VxGameProcesses($Sys, $Skip, [string]$WinDir) {
    if ($null -ne $Sys.Processes) {
        return @(@($Sys.Processes) | ForEach-Object { @{ name = [string](Get-VxProp $_ 'name'); path = [string](Get-VxProp $_ 'path'); title = [string](Get-VxProp $_ 'title'); fullscreen = [bool](Get-VxProp $_ 'fullscreen' $false); product = '' } })
    }
    if (-not $Sys.Real) { return @() }
    $out = New-Object System.Collections.ArrayList
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
        if (Test-VxGameTimeUp $Sys) { break }
        try {
            if ($Skip.ContainsKey($p.ProcessName.ToLowerInvariant())) { continue }
            $path = [string]$p.Path
            if (-not $path -or ($WinDir -and $path.ToLowerInvariant().StartsWith($WinDir + '\'))) { continue }
            $fs = $false
            if (Initialize-VxShellArt) { try { $fs = [bool](('VxShellArt' -as [type])::IsFullscreenish($p.MainWindowHandle)) } catch { $fs = $false } }
            $prod = ''
            try { $prod = [string]([Diagnostics.FileVersionInfo]::GetVersionInfo($path)).ProductName } catch { $prod = '' }
            [void]$out.Add(@{ name = $p.ProcessName; path = $path; title = [string]$p.MainWindowTitle; fullscreen = $fs; product = $prod })
        } catch { $null = $_ }
    }
    return @($out)
}

# Running games: a window that covers the whole screen, or an exe inside a typical game folder.
function Find-VxRunningGames($Sys, $Found) {
    $skip = Get-VxGameProcessSkip
    $win = ([string]$Sys.Folders.systemRoot).TrimEnd('\').ToLowerInvariant()
    foreach ($p in @(Get-VxGameProcesses $Sys $skip $win)) {
        $lp = ([string]$p.path).ToLowerInvariant()
        if (-not $lp -or ($win -and $lp.StartsWith($win + '\'))) { continue }
        if ($skip.ContainsKey(([string]$p.name).ToLowerInvariant()) -or $lp.Contains('\velox')) { continue }
        $inGameDir = $lp -match '\\(steamapps\\common|epic games|xboxgames|riot games|gog games|ubisoft game launcher\\games|ea games|origin games|rockstar games|games|spiele)\\'
        if (-not ($p.fullscreen -or $inGameDir)) { continue }
        if (Test-VxNonGameExe (Get-VxPathLeaf $p.path)) { continue }
        $name = [string]$p.product
        if (-not $name -or $name -match '^(?i)(unreal engine|unity|microsoft.*windows.*operating system)') { $name = [string]$p.title }
        if (-not $name) { $name = [string]$p.name }
        # already found by a launcher: only mark it as running
        $key = (ConvertTo-VxWinPath ([string]$p.path)).ToLowerInvariant()
        if ($Found.seen.ContainsKey($key)) {
            foreach ($g in $Found.list) { if (([string]$g.path).ToLowerInvariant() -eq $key) { $g.running = $true } }
            continue
        }
        $null = Add-VxGameFound $Found $Sys $name $p.path 'other' @{ running = $true }
    }
}

function Get-VxGameSources {
    return @(
        @{ id = 'steam'; label = 'Steam'; fn = 'Find-VxSteamGames'; sec = 12 },
        @{ id = 'epic'; label = 'Epic Games'; fn = 'Find-VxEpicGames'; sec = 4 },
        @{ id = 'gog'; label = 'GOG'; fn = 'Find-VxGogGames'; sec = 4 },
        @{ id = 'ubisoft'; label = 'Ubisoft Connect'; fn = 'Find-VxUbisoftGames'; sec = 5 },
        @{ id = 'ea'; label = 'EA app'; fn = 'Find-VxEaGames'; sec = 5 },
        @{ id = 'battlenet'; label = 'Battle.net'; fn = 'Find-VxBattleNetGames'; sec = 5 },
        @{ id = 'riot'; label = 'Riot Games'; fn = 'Find-VxRiotGames'; sec = 3 },
        @{ id = 'xbox'; label = 'Xbox / PC Game Pass'; fn = 'Find-VxXboxGames'; sec = 5 },
        @{ id = 'rockstar'; label = 'Rockstar'; fn = 'Find-VxRockstarGames'; sec = 4 },
        @{ id = 'fivem'; label = 'FiveM, RedM, alt:V'; fn = 'Find-VxCfxGames'; sec = 3 },
        @{ id = 'minecraft'; label = 'Minecraft'; fn = 'Find-VxMinecraftGames'; sec = 6 },
        @{ id = 'roblox'; label = 'Roblox'; fn = 'Find-VxRobloxGames'; sec = 3 },
        @{ id = 'other'; label = 'weitere Spiele'; fn = 'Find-VxUninstallGames'; sec = 8 },
        @{ id = 'running'; label = 'laufende Spiele'; fn = 'Find-VxRunningGames'; sec = 4 }
    )
}

# Runs every source with its own time budget. A source that fails or runs out of time costs only
# its own games. -Report: progress + one log line per source (games-detect job).
function Find-VxGames($Sys, [bool]$Report = $false) {
    $found = New-VxGameFound
    if ($null -eq $Sys) { return $found }
    $Sys.KnownExes = Get-VxKnownExeNames
    $src = @(Get-VxGameSources)
    $n = 0
    foreach ($s in $src) {
        if ($Report) {
            Test-VxCancel
            Set-VxProgress (0.05 + 0.7 * $n / $src.Count) ('Suche: ' + $s.label + ' ...')
        }
        $n++
        $Sys.Deadline = [DateTime]::UtcNow.AddSeconds([double]$s.sec)
        $before = $found.list.Count
        try { & $s.fn $Sys $found } catch { Write-VxFileLog 'warn' ('Spielesuche ' + $s.label + ': ' + $_.Exception.Message) }
        if (Test-VxGameTimeUp $Sys) { Write-VxFileLog 'warn' ('Spielesuche ' + $s.label + ': Zeitlimit erreicht, Rest übersprungen') }
        $c = $found.list.Count - $before
        if ($Report -and $c -gt 0) {
            $what = 'Spiele'
            if ($c -eq 1) { $what = 'Spiel' }
            Write-VxLog 'info' ('{0}: {1} {2}' -f $s.label, $c, $what)
        }
    }
    $Sys.Deadline = [DateTime]::MaxValue
    return $found
}

function ConvertTo-VxGameEntry($Raw) {
    $e = New-VxGameEntry ([string]$Raw.name) ([string]$Raw.path) ([string]$Raw.source)
    if ($Raw.appid) { $e['appid'] = [string]$Raw.appid }
    if ($Raw.running) { $e['running'] = $true }
    return $e
}

# Games on this PC, for the advisor. The last detection is reused for 5 minutes (no Steam folder
# walk on every advisor run).
function Get-VxRealGames {
    $ctx = $global:VxCtx
    $c = $null
    if ($ctx.ContainsKey('GameScan')) { $c = $ctx.GameScan }
    if ($null -ne $c -and ([DateTime]::UtcNow - [DateTime]$c.at).TotalMinutes -lt 5) { return @($c.games) }
    $found = Find-VxGames (Get-VxGameSystem) $false
    $games = @(@($found.list) | ForEach-Object { ConvertTo-VxGameEntry $_ })
    $ctx.GameScan = @{ at = [DateTime]::UtcNow; games = $games }
    return $games
}

# Off Windows: the fixture PC (tests/fixtures/games/pc) when it is there, else a fixed list.
function Get-VxSimGames {
    $sys = Get-VxGameSystem
    if ($null -ne $sys) {
        $found = Find-VxGames $sys $false
        return @(@($found.list) | ForEach-Object { ConvertTo-VxGameEntry $_ })
    }
    $list = @(
        (New-VxGameEntry 'FiveM' 'C:\Users\Gamer\AppData\Local\FiveM\FiveM.exe' 'fivem'),
        (New-VxGameEntry 'Grand Theft Auto V' 'C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V\GTA5.exe' 'steam'),
        (New-VxGameEntry 'Counter-Strike 2' 'C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe' 'steam'),
        (New-VxGameEntry 'Fortnite' 'C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe' 'epic')
    )
    return $list
}

# ------------------------------------------------------------------ game art

# Compiles the shell icon helper once per process (Add-Type types live as long as the process, so
# every later job runspace reuses it). Windows only; $false when it is not available.
function Initialize-VxShellArt {
    if ($null -ne ('VxShellArt' -as [type])) { return $true }
    if (-not (Test-VxWindows)) { return $false }
    $ctx = $global:VxCtx
    if ($ctx.ContainsKey('ShellArtFailed') -and $ctx.ShellArtFailed) { return $false }
    $src = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public static class VxShellArt {
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory {
        [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int cx; public int cy; }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLongW(IntPtr h, int index);

    // The exe's own icon at up to <size> px as PNG with transparency (SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY).
    public static bool SaveIconPng(string file, string png, int size) {
        Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
        IShellItemImageFactory f = null;
        if (SHCreateItemFromParsingName(file, IntPtr.Zero, ref iid, out f) != 0 || f == null) return false;
        IntPtr hbm = IntPtr.Zero;
        try {
            SIZE s; s.cx = size; s.cy = size;
            if (f.GetImage(s, 0x1 | 0x4, out hbm) != 0 || hbm == IntPtr.Zero) return false;
            using (Bitmap bmp = ToArgb(hbm)) { bmp.Save(png, ImageFormat.Png); }
            return true;
        } finally {
            if (hbm != IntPtr.Zero) DeleteObject(hbm);
            Marshal.ReleaseComObject(f);
        }
    }

    // Shell objects want an STA thread (the job runspace is MTA) and a broken shell extension must
    // not hang the detection: own STA thread, joined with a timeout.
    public static bool SaveIconPngSta(string file, string png, int size, int timeoutMs) {
        bool ok = false;
        Thread t = new Thread(delegate () { try { ok = SaveIconPng(file, png, size); } catch { ok = false; } });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        if (!t.Join(timeoutMs)) return false;
        return ok;
    }

    // Image.FromHbitmap drops the alpha channel; the bits still have it (premultiplied).
    private static Bitmap ToArgb(IntPtr hbm) {
        Bitmap src = Image.FromHbitmap(hbm);
        if (Image.GetPixelFormatSize(src.PixelFormat) != 32) return src;
        int w = src.Width, h = src.Height;
        Rectangle r = new Rectangle(0, 0, w, h);
        BitmapData d = src.LockBits(r, ImageLockMode.ReadOnly, src.PixelFormat);
        Bitmap result = null;
        try {
            bool alpha = false;
            for (int y = 0; y < h && !alpha; y++) {
                for (int x = 0; x < w; x++) { if (Marshal.ReadByte(d.Scan0, y * d.Stride + x * 4 + 3) != 0) { alpha = true; break; } }
            }
            if (alpha) {
                using (Bitmap wrap = new Bitmap(w, h, d.Stride, PixelFormat.Format32bppPArgb, d.Scan0)) {
                    result = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                    using (Graphics g = Graphics.FromImage(result)) {
                        g.Clear(Color.Transparent);
                        g.DrawImage(wrap, r, r, GraphicsUnit.Pixel);
                    }
                }
            }
        } finally { src.UnlockBits(d); }
        if (result != null) { src.Dispose(); return result; }
        return src;
    }

    // True when the window covers its whole monitor (exclusive or borderless fullscreen). A window
    // with a title bar is a maximized normal window (with an auto-hide taskbar it covers the screen too).
    public static bool IsFullscreenish(IntPtr hwnd) {
        RECT wr;
        if ((GetWindowLongW(hwnd, -16) & 0x00C00000) == 0x00C00000) return false;
        if (!GetWindowRect(hwnd, out wr)) return false;
        IntPtr mon = MonitorFromWindow(hwnd, 2);
        if (mon == IntPtr.Zero) return false;
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(mon, ref mi)) return false;
        return wr.Left <= mi.rcMonitor.Left && wr.Top <= mi.rcMonitor.Top && wr.Right >= mi.rcMonitor.Right && wr.Bottom >= mi.rcMonitor.Bottom;
    }
}
'@
    try {
        Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.Drawing' -ErrorAction Stop
        return $true
    } catch {
        $ctx.ShellArtFailed = $true
        Write-VxFileLog 'warn' ('Spiele-Icons: Hilfsklasse nicht verfügbar: ' + $_.Exception.Message)
        return $false
    }
}

# The exe's icon as PNG in <dataRoot>\cache\gameart (cached per exe path, size and date). Windows only.
function Get-VxExeIconPng([string]$Exe) {
    if (-not (Test-VxWindows) -or -not $Exe) { return $null }
    try {
        $fi = New-Object IO.FileInfo($Exe)
        if (-not $fi.Exists) { return $null }
        $dir = [IO.Path]::Combine([string]$global:VxCtx.DataRoot, 'cache', 'gameart')
        if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
        $key = Get-VxShortHash ($Exe.ToLowerInvariant() + '|' + $fi.Length + '|' + $fi.LastWriteTimeUtc.Ticks)
        $png = [IO.Path]::Combine($dir, 'icon-' + $key + '.png')
        if ([IO.File]::Exists($png)) { return $png }
        # the shell thread may still finish after its timeout: it gets its own temp file
        $tmp = $png + '.shell.tmp'
        $ok = $false
        if (Initialize-VxShellArt) {
            try { $ok = [bool](('VxShellArt' -as [type])::SaveIconPngSta($Exe, $tmp, 256, 3000)) } catch { $ok = $false }
        }
        if (-not $ok) {
            $tmp = $png + '.tmp'
            Add-Type -AssemblyName System.Drawing -ErrorAction Stop
            $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)
            if ($null -ne $ico) {
                $bmp = $ico.ToBitmap()
                try { $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png); $ok = $true } finally { $bmp.Dispose(); $ico.Dispose() }
            }
        }
        if ($ok -and [IO.File]::Exists($tmp)) {
            if ([IO.File]::Exists($png)) { [IO.File]::Delete($png) }
            [IO.File]::Move($tmp, $png)
            return $png
        }
        if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
    } catch { Write-VxFileLog 'warn' ('Spiele-Icon für ' + $Exe + ': ' + $_.Exception.Message) }
    return $null
}

# The registered art survives a restart: <data root>\cache\gameart\art-map(-sim).json, so the images
# of the last detection show up at once instead of 404 until the next scan.
function Get-VxGameArtMapFile {
    $name = 'art-map.json'
    if ($global:VxCtx.Simulate) { $name = 'art-map-sim.json' }
    return [IO.Path]::Combine([string]$global:VxCtx.DataRoot, 'cache', 'gameart', $name)
}

function Get-VxGameArtMap {
    $ctx = $global:VxCtx
    if ($ctx.ContainsKey('GameArt') -and $null -ne $ctx.GameArt) { return $ctx.GameArt }
    $map = [hashtable]::Synchronized(@{})
    try {
        $f = Get-VxGameArtMapFile
        if ([IO.File]::Exists($f)) {
            $j = Read-VxJsonFile $f
            if ($null -ne $j) {
                foreach ($p in @($j.PSObject.Properties)) {
                    if ([string]$p.Name -notmatch '^[a-f0-9]{10}$' -or $null -eq $p.Value) { continue }
                    $e = @{ cover = $null; icon = $null; v = [string](Get-VxProp $p.Value 'v' '') }
                    foreach ($k in @('cover', 'icon')) { $x = Get-VxProp $p.Value $k; if ($x -is [string] -and $x) { $e[$k] = $x } }
                    $map[[string]$p.Name] = $e
                }
            }
        }
    } catch { Write-VxFileLog 'warn' ('Spiele-Bilder: gespeicherte Liste nicht lesbar: ' + $_.Exception.Message) }
    $ctx.GameArt = $map
    return $map
}

function Save-VxGameArtMap {
    try {
        $map = Get-VxGameArtMap
        $out = [ordered]@{}
        foreach ($k in @($map.Keys | Sort-Object)) { $e = $map[$k]; $out[$k] = [ordered]@{ cover = $e.cover; icon = $e.icon; v = $e.v } }
        Write-VxJsonFile (Get-VxGameArtMapFile) $out
    } catch { Write-VxFileLog 'warn' ('Spiele-Bilder: Liste nicht gespeichert: ' + $_.Exception.Message) }
}

# Resolves the art of detected games to files on disk, registers them for GET /api/game-art and
# returns @{ <gameId> = @{ cover; icon; shape; v } } for the UI. Launcher art first (Steam library
# cache, GOG .ico, Xbox package logos); on Windows the exe's own icon fills the gaps (and replaces
# Steam's tiny 32 px icon), with a time budget - the rest comes on the next detection from the cache.
function Update-VxGameArt($Sys, $Raws, [int]$BudgetSec = 12) {
    $map = Get-VxGameArtMap
    $dtos = @{}
    $deadline = [DateTime]::UtcNow.AddSeconds($BudgetSec)
    foreach ($r in @($Raws)) {
        try {
            $id = Get-VxShortHash ([string]$r.path).ToLowerInvariant()
            $cover = $null
            $icon = $null
            if ($null -ne $Sys) {
                if ($r.cover) { $p = Resolve-VxGamePath $Sys ([string]$r.cover); if ($p -and [IO.File]::Exists($p)) { $cover = $p } }
                if ($r.icon) { $p = Resolve-VxGamePath $Sys ([string]$r.icon); if ($p -and [IO.File]::Exists($p)) { $icon = $p } }
                if ($Sys.Real -and (-not $icon -or $icon -match '(?i)\.jpe?g$') -and [DateTime]::UtcNow -lt $deadline) {
                    $png = Get-VxExeIconPng ([string]$r.path)
                    if ($png) { $icon = $png }
                }
            }
            if (-not $cover -and -not $icon) { $dtos[$id] = [ordered]@{ cover = $false; icon = $false; shape = $null; v = '' }; continue }
            $stamp = ''
            foreach ($f in @($cover, $icon)) { if ($f) { $stamp += $f + '|' + ([IO.File]::GetLastWriteTimeUtc($f)).Ticks + '|' } }
            $v = Get-VxShortHash $stamp
            $shape = 'wide'
            if ($r.shape -eq 'tall') { $shape = 'tall' }
            $map[$id] = @{ cover = $cover; icon = $icon; v = $v }
            $dtos[$id] = [ordered]@{ cover = [bool]$cover; icon = [bool]$icon; shape = $shape; v = $v }
        } catch { Write-VxFileLog 'warn' ('Spiele-Bild ' + [string]$r.path + ': ' + $_.Exception.Message) }
    }
    Save-VxGameArtMap
    return $dtos
}

# File of one registered image (GET /api/game-art/<id>?kind=cover|icon). Only what a detection
# registered, never a path from the request. $null = 404.
function Get-VxGameArtFile([string]$Id, [string]$Kind) {
    if ($Id -notmatch '^[a-f0-9]{10}$' -or @('cover', 'icon') -notcontains $Kind) { return $null }
    $e = (Get-VxGameArtMap)[$Id]
    if ($null -eq $e) { return $null }
    $p = [string]$e[$Kind]
    if (-not $p) { return $null }
    if (@('.jpg', '.jpeg', '.png', '.ico', '.bmp', '.gif', '.webp') -notcontains [IO.Path]::GetExtension($p).ToLowerInvariant()) { return $null }
    if (-not [IO.File]::Exists($p)) { return $null }
    return $p
}

# Art for one game added by hand (game-boost): the exe icon, when that game has no art yet.
function Add-VxGameIconArt($Game) {
    if (-not $global:VxCtx.Windows) { return $null }
    $map = Get-VxGameArtMap
    if ($map.ContainsKey([string]$Game.id)) { return $null }
    $sys = @{ Root = $null; Real = $true }
    $dtos = Update-VxGameArt $sys @(@{ name = $Game.name; path = $Game.path; source = $Game.source; cover = $null; shape = $null; icon = $null }) 5
    $d = $dtos[[string]$Game.id]
    if ($null -ne $d -and ($d.cover -or $d.icon)) { return $d }
    return $null
}

function Invoke-VxGamesDetectJob($Params) {
    $ctx = $global:VxCtx
    Set-VxProgress 0.02 'Suche installierte Spiele ...'
    $sys = Get-VxGameSystem
    $found = Find-VxGames $sys $true
    $raws = New-Object System.Collections.ArrayList
    foreach ($r in $found.list) { [void]$raws.Add($r) }
    # games boosted earlier stay visible
    foreach ($s in @($ctx.Settings.games)) {
        $p = [string](Get-VxProp $s 'path')
        if (-not $p -or $found.seen.ContainsKey($p.ToLowerInvariant())) { continue }
        $found.seen[$p.ToLowerInvariant()] = $true
        [void]$raws.Add(@{ name = [string](Get-VxProp $s 'name' (Get-VxPathStem $p)); path = $p; source = [string](Get-VxProp $s 'source' 'manual'); appid = $null; cover = $null; shape = $null; icon = $null })
    }
    Test-VxCancel
    Set-VxProgress 0.8 'Lade Spiele-Bilder ...'
    $art = Update-VxGameArt $sys $raws
    $games = New-Object System.Collections.ArrayList
    $plain = New-Object System.Collections.ArrayList
    foreach ($r in $raws) {
        $e = ConvertTo-VxGameEntry $r
        [void]$plain.Add($e)
        $dto = [ordered]@{}
        foreach ($k in @($e.Keys)) { $dto[$k] = $e[$k] }
        $a = $art[[string]$e.id]
        if ($null -eq $a) { $a = [ordered]@{ cover = $false; icon = $false; shape = $null; v = '' } }
        $dto['art'] = $a
        [void]$games.Add($dto)
    }
    $ctx.GameScan = @{ at = [DateTime]::UtcNow; games = $plain.ToArray() }
    if ($games.Count -eq 1) { Write-VxLog 'ok' '1 Spiel gefunden.' } else { Write-VxLog 'ok' ("{0} Spiele gefunden." -f $games.Count) }
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
    # a game added by hand gets its exe icon (Windows); detected games keep their launcher art
    $artDto = $null
    try { $artDto = Add-VxGameIconArt $game } catch { $artDto = $null }
    if ($null -ne $artDto) { $game['art'] = $artDto }
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
