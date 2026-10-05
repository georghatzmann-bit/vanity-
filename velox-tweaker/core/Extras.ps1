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
    foreach ($v in @($env:SystemRoot, $env:windir, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432, $env:ProgramData, $env:USERPROFILE, $env:PUBLIC, $env:APPDATA, $env:LOCALAPPDATA, $env:HOME)) {
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

# Expands a clean path into top-level items: @{ root; filter; contentsOnly }.
function Resolve-VxCleanPath([string]$Raw) {
    $exp = [Environment]::ExpandEnvironmentVariables($Raw)
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
    if ($Resolved.filter) {
        if (-not [IO.Directory]::Exists($root)) { return @() }
        $di = New-Object IO.DirectoryInfo($root)
        $items = @($di.GetFileSystemInfos($Resolved.filter))
    } elseif ([IO.Directory]::Exists($root)) {
        $di = New-Object IO.DirectoryInfo($root)
        $items = @($di.GetFileSystemInfos())
    } elseif ([IO.File]::Exists($root)) {
        $items = @(New-Object IO.FileInfo($root))
    }
    if ($Keep.Count -gt 0) { $items = @($items | Where-Object { $Keep -notcontains $_.Name }) }
    return $items
}

# Walks (and optionally deletes) files below the given items. Never follows junctions/symlinks.
function Invoke-VxCleanWalk($Items, [bool]$Delete, [int]$MaxMs = 30000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $res = @{ bytes = [long]0; files = 0; freed = [long]0; deleted = 0; skipped = 0 }
    $dirs = New-Object System.Collections.Generic.List[string]
    $stack = New-Object System.Collections.Generic.Stack[object]
    foreach ($i in @($Items)) { $stack.Push($i) }
    while ($stack.Count -gt 0) {
        if (-not $Delete -and $sw.ElapsedMilliseconds -gt $MaxMs) { break }
        $it = $stack.Pop()
        try {
            if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($it -is [IO.DirectoryInfo]) {
                $dirs.Add($it.FullName)
                foreach ($c in $it.GetFileSystemInfos()) { $stack.Push($c) }
            } else {
                $len = [long]$it.Length
                $res.bytes += $len
                $res.files++
                if ($Delete) {
                    try {
                        if (($it.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { $it.Attributes = [IO.FileAttributes]::Normal }
                        $it.Delete()
                        $res.freed += $len
                        $res.deleted++
                    } catch { $res.skipped++ }
                }
            }
        } catch { $res.skipped++ }
    }
    if ($Delete) {
        # remove now-empty folders, deepest first
        foreach ($d in @($dirs | Sort-Object { $_.Length } -Descending)) {
            try { if ([IO.Directory]::Exists($d) -and @([IO.Directory]::GetFileSystemEntries($d)).Count -eq 0) { [IO.Directory]::Delete($d) } } catch { $null = $_ }
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
                    $skipped = 0
                    foreach ($p in $paths) {
                        $r = Resolve-VxCleanPath $p
                        $items = @(Get-VxCleanTopItems $r $keep)
                        $w = Invoke-VxCleanWalk $items $true
                        $freed += $w.freed
                        $skipped += $w.skipped
                    }
                    if ($skipped -gt 0) { $msgs += ("{0} Dateien waren in Benutzung und wurden übersprungen" -f $skipped) }
                } finally {
                    foreach ($s in $stopped) { $null = Invoke-VxNative -FilePath (Get-VxSystemTool 'sc.exe') -Arguments @('start', $s) -TimeoutSec 20 }
                }
            } elseif ($type -eq 'ps') {
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
    try { $user = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup) } catch { $null = $_ }
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

function Get-VxGameBoostState([string]$Path) {
    $exe = Get-VxPathLeaf ($Path)
    $b = [ordered]@{ priority = $false; gpu = $false; fso = $false }
    try {
        $p = Get-VxRegValue ('HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\' + $exe + '\PerfOptions') 'CpuPriorityClass'
        $b.priority = ($p.exists -and [long]$p.value -eq 3)
        $g = Get-VxRegValue 'HKCU\Software\Microsoft\DirectX\UserGpuPreferences' $Path
        $b.gpu = ($g.exists -and [string]$g.value -match 'GpuPreference=2;?')
        $f = Get-VxRegValue 'HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers' $Path
        $b.fso = ($f.exists -and (' ' + [string]$f.value + ' ') -match '\sDISABLEDXMAXIMIZEDWINDOWEDMODE\s')
    } catch { $null = $_ }
    return $b
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
        $fivem = [IO.Path]::Combine([IO.Path]::Combine([string]$env:LOCALAPPDATA, 'FiveM'), 'FiveM.exe')
        & $add 'FiveM' $fivem 'fivem'
        $sub = [IO.Path]::Combine([string]$env:LOCALAPPDATA, 'FiveM\FiveM.app\data\cache\subprocess')
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
    $J = New-VxJournal 'game' ('Spiele-Boost: ' + $exe)
    $errors = @()
    try {
        # 1) CPU priority "high" via Image File Execution Options (per exe name)
        try {
            $ifeo = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\' + $exe + '\PerfOptions'
            if ($prio) { $null = Set-VxRegJ $J $ifeo 'CpuPriorityClass' 'DWord' 3 'game' }
            else {
                $null = Set-VxRegJ $J $ifeo 'CpuPriorityClass' $null $null 'game'
                if ((Test-VxRegKey $ifeo) -and @(Get-VxRegValueNames $ifeo).Count -eq 0 -and @(Get-VxRegSubKeys $ifeo).Count -eq 0) {
                    $null = Set-VxRegKeyJ $J $ifeo $false 'game'
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
        [void]$list.Add([ordered]@{ id = $game.id; name = $game.name; exe = $game.exe; path = $game.path; source = $game.source; boost = $game.boost })
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
        Get-Process -Name 'explorer' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        $back = $false
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 500
            if (@(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue).Count -gt 0) { $back = $true; break }
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
