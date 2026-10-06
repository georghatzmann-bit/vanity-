<#
.SYNOPSIS
  VELOX - Windows 10/11 Tweaker. Entry point: elevation, core loading, local server, app window.

.DESCRIPTION
  Start via Start.bat (real mode, asks for administrator rights) or Start-Testmodus.bat
  (-Simulate: nothing on the PC is changed). Runs on Windows PowerShell 5.1 and pwsh 7.

.PARAMETER Simulate     Testmodus: all changes go to a simulated overlay (always on outside Windows).
.PARAMETER NoBrowser    Do not open the app window (tests, debugging).
.PARAMETER Port         Port for the local server (0 = random free port).
.PARAMETER Token        Access token for the API (default: random 32-byte hex).
.PARAMETER DataRoot     Folder for settings, backups and logs (default %LOCALAPPDATA%\Velox).
.PARAMETER SimProfile   Simulated hardware outside Windows: desktop or laptop.
.PARAMETER SimReset     Start the simulation from a fresh state.
.PARAMETER HostPid      Process id of the native host (VELOX.exe). The backend ends by itself once
                        that process is gone, never waits for Enter, and reports start errors as
                        "VELOX_ERROR <text>" lines (docs/ARCHITECTURE.md, "Native host & installer").
#>
[CmdletBinding()]
param(
    [switch]$Simulate,
    [switch]$NoBrowser,
    [int]$Port = 0,
    [string]$Token = '',
    [string]$DataRoot = '',
    [ValidateSet('desktop', 'laptop')][string]$SimProfile = 'desktop',
    [switch]$SimReset,
    [int]$HostPid = 0
)

function Write-VxConsole([string]$Text) {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

# Under VELOX.exe: one line per start-up phase. The host shows it on its start screen (it maps the
# key to German text) and knows the backend is still busy, so a slow first start is not cut off.
function Write-VxHostStatus([string]$Key) {
    if ($HostPid -gt 0) { Write-VxConsole ('VELOX_STATUS ' + $Key) }
}

function Wait-VxEnter([string]$Text) {
    # Under VELOX.exe there is no console to press Enter in: the host shows the text instead.
    if ($HostPid -gt 0) {
        if ($Text) { Write-VxConsole ('VELOX_ERROR ' + ($Text -replace '[\r\n]+', ' ')) }
        return
    }
    Write-VxConsole $Text
    try { $null = Read-Host 'Enter druecken zum Schliessen' } catch { $null = $_ }
}

function ConvertTo-VxQuotedArg([string]$Value) {
    $v = $Value.TrimEnd('\')
    return ('"' + $v.Replace('"', '\"') + '"')
}

# A path on a mapped network drive (Z:\...) as UNC path: the elevated process after the UAC prompt
# does not see drive letters mapped in the normal session (EnableLinkedConnections is off).
function ConvertTo-VxUncPath([string]$Path) {
    try {
        if ($Path -notmatch '^([A-Za-z]):\\') { return $Path }
        $letter = $Matches[1]
        $di = New-Object IO.DriveInfo(($letter + ':\'))
        if ($di.DriveType -ne [IO.DriveType]::Network) { return $Path }
        $root = $null
        try { $root = [string](Get-PSDrive -Name $letter -PSProvider FileSystem -ErrorAction Stop).DisplayRoot } catch { $root = $null }
        if (-not $root) {
            try { $root = [string](Get-ItemProperty -LiteralPath ('HKCU:\Network\' + $letter) -Name 'RemotePath' -ErrorAction Stop).RemotePath } catch { $root = $null }
        }
        if ($root -and $root.StartsWith('\\')) { return ($root.TrimEnd('\') + $Path.Substring(2)) }
    } catch { $null = $_ }
    return $Path
}

# ------------------------------------------------------------------ basic checks

if ($PSVersionTable.PSVersion.Major -lt 5 -or ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) {
    Wait-VxEnter ('VELOX braucht Windows PowerShell 5.1 oder neuer. Gefunden: ' + $PSVersionTable.PSVersion.ToString())
    exit 2
}

$VxRoot = $PSScriptRoot
if (-not $VxRoot) { $VxRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$VxIsWindows = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)

if (-not (Test-Path -LiteralPath (Join-Path $VxRoot 'core'))) {
    Wait-VxEnter 'Der Ordner "core" fehlt. Bitte das ZIP zuerst komplett entpacken und VELOX aus dem entpackten Ordner starten.'
    exit 2
}

# ------------------------------------------------------------------ elevation (real mode only)

if ($VxIsWindows -and -not $Simulate) {
    $isAdmin = $false
    try {
        $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        $isAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { $isAdmin = $false }
    if (-not $isAdmin -and $HostPid -gt 0) {
        # VELOX.exe elevates itself before it starts the backend; never open a second UAC prompt here
        Wait-VxEnter 'VELOX braucht Administratorrechte. Bitte VELOX neu starten und die Windows-Abfrage mit Ja bestaetigen - oder den Testmodus nehmen.'
        exit 2
    }
    if (-not $isAdmin) {
        $hostExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $scriptPath = ConvertTo-VxUncPath $PSCommandPath
        $workDir = ConvertTo-VxUncPath $VxRoot
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-VxQuotedArg $scriptPath))
        foreach ($k in @($PSBoundParameters.Keys)) {
            $v = $PSBoundParameters[$k]
            if ($v -is [System.Management.Automation.SwitchParameter]) {
                if ($v.IsPresent) { $argList += ('-' + $k) }
            } else {
                $argList += ('-' + $k)
                $argList += (ConvertTo-VxQuotedArg ([string]$v))
            }
        }
        Write-VxConsole 'VELOX braucht Administratorrechte, um Windows-Einstellungen zu aendern. Bitte die Windows-Abfrage bestaetigen ...'
        $elevated = $null
        try {
            $elevated = Start-Process -FilePath $hostExe -ArgumentList ($argList -join ' ') -Verb RunAs -WorkingDirectory $workDir -PassThru -ErrorAction Stop
        } catch {
            $elevated = $null
        }
        if ($null -ne $elevated) {
            # The elevated window closes at once when it cannot even start the script (e.g. the
            # folder is on a network drive the admin session cannot reach). Say so instead of
            # vanishing: VELOX itself always returns 0 or 2 (2 = error already shown there).
            $quick = $false
            try { $quick = $elevated.WaitForExit(8000) } catch { $quick = $false }
            if ($quick) {
                $code = 0
                try { $code = [int]$elevated.ExitCode } catch { $code = 0 }
                if ($code -ne 0 -and $code -ne 2) {
                    Write-VxConsole ''
                    Write-VxConsole ('VELOX konnte mit Administratorrechten nicht gestartet werden (Code ' + $code + ').')
                    if ($scriptPath.StartsWith('\\')) {
                        Write-VxConsole 'VELOX liegt auf einem Netzlaufwerk - das sieht Windows mit Administratorrechten oft nicht.'
                        Write-VxConsole 'Kopiere den VELOX-Ordner auf ein lokales Laufwerk (z. B. den Desktop) und starte ihn dort.'
                    }
                    Wait-VxEnter ''
                    exit 2
                }
            }
            exit 0
        }
        Write-VxConsole ''
        Write-VxConsole 'Die Administrator-Abfrage wurde abgelehnt oder ist fehlgeschlagen.'
        Write-VxConsole 'Ohne Adminrechte kann VELOX nichts an Windows aendern.'
        Write-VxConsole 'Tipp: Mit "Start-Testmodus.bat" kannst du VELOX gefahrlos ausprobieren -'
        Write-VxConsole 'im Testmodus wird nichts an deinem PC veraendert.'
        Wait-VxEnter ''
        exit 2
    }
}

# Files from a downloaded ZIP carry the Mark-of-the-Web; unblock VELOX's OWN files so 5.1 loads them
# silently. Never the whole start folder: unpacked straight into Downloads or onto the Desktop that
# would strip the download marker from every unrelated file (SmartScreen / Office macro protection).
if ($VxIsWindows) {
    try {
        $own = New-Object System.Collections.Generic.List[string]
        foreach ($f in @(Get-ChildItem -LiteralPath $VxRoot -File -ErrorAction SilentlyContinue)) {
            if ($f.Name -ieq 'Velox.ps1' -or $f.Name -like 'Start*.bat' -or $f.Name -ieq 'README.md') { $own.Add($f.FullName) }
        }
        foreach ($sub in @('core', 'ui', 'data', 'tools')) {
            $d = Join-Path $VxRoot $sub
            if (Test-Path -LiteralPath $d) { foreach ($f in @(Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue)) { $own.Add($f.FullName) } }
        }
        foreach ($f in $own) { try { Unblock-File -LiteralPath $f -ErrorAction SilentlyContinue } catch { $null = $_ } }
    } catch { $null = $_ }
}

# ------------------------------------------------------------------ load core

# Each core file is read once; the job runspaces get exactly this text later (Get-VxCoreSources),
# never a fresh read of files the normal user could change while VELOX runs as admin.
Write-VxHostStatus 'core'
$VxCoreNames = @('Common', 'System', 'Catalog', 'Engine', 'Detweak', 'Scan', 'Advisor', 'Claude', 'Extras', 'Clean', 'Jobs', 'Server')
$VxCoreText = @{}
foreach ($n in $VxCoreNames) {
    $f = Join-Path (Join-Path $VxRoot 'core') ($n + '.ps1')
    try {
        $VxCoreText[$n] = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
        . ([scriptblock]::Create($VxCoreText[$n]))
    } catch {
        Wait-VxEnter ('VELOX konnte core\' + $n + '.ps1 nicht laden: ' + $_.Exception.Message)
        exit 2
    }
}

Initialize-VxRuntime
# VELOX_DATA_DIR (tests only) points the catalog at another data folder, e.g. tests/fixtures/data.
# Honoured only in the Testmodus: in real mode a value planted in the user environment would make
# the elevated process run another catalog's scripts.
$VxDataDir = ''
if ($Simulate -or -not $VxIsWindows) { $VxDataDir = [string][Environment]::GetEnvironmentVariable('VELOX_DATA_DIR') }
$ctx = New-VxContext -AppRoot $VxRoot -DataRoot $DataRoot -Simulate ([bool]$Simulate) -SimProfile $SimProfile -DataDir $VxDataDir
$ctx.CoreSources = @(Get-VxCoreNames | ForEach-Object { [string]$VxCoreText[$_] })
# VERSION next to Velox.ps1 is the one version number of VELOX (installer, VELOX.exe, UI)
try {
    $vxVersionFile = Join-Path $VxRoot 'VERSION'
    if ([IO.File]::Exists($vxVersionFile)) {
        $vxVersion = ([IO.File]::ReadAllText($vxVersionFile)).Trim()
        if ($vxVersion -match '^\d+\.\d+\.\d+$') { $ctx.Version = $vxVersion }
    }
} catch { $null = $_ }

# ------------------------------------------------------------------ app window

# Only browsers in places a normal user cannot change (HKLM App Paths, Program Files): this is
# started from the elevated process, so an exe from HKCU or %LOCALAPPDATA% would run as admin.
function Find-VxBrowser {
    $cands = New-Object System.Collections.Generic.List[string]
    foreach ($exe in @('msedge.exe', 'chrome.exe', 'brave.exe')) {
        foreach ($hk in @('HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\', 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\')) {
            try {
                $v = Get-VxRealRegValue ($hk + $exe) ''
                if ($v.exists -and $v.value) { $cands.Add(([Environment]::ExpandEnvironmentVariables([string]$v.value)).Trim('"')) }
            } catch { $null = $_ }
        }
        $rel = switch ($exe) {
            'msedge.exe' { 'Microsoft\Edge\Application\msedge.exe' }
            'chrome.exe' { 'Google\Chrome\Application\chrome.exe' }
            'brave.exe' { 'BraveSoftware\Brave-Browser\Application\brave.exe' }
        }
        foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
            if ($base) { $cands.Add((Join-Path $base $rel)) }
        }
    }
    $pf = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:ProgramW6432, $env:SystemRoot) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') + '\' }
    foreach ($c in $cands) {
        if (-not $c -or -not [IO.File]::Exists($c)) { continue }
        # an App Paths entry may point anywhere - accept it only inside the protected folders
        if (@($pf | Where-Object { $c.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) { continue }
        return $c
    }
    return $null
}

# Profile folder of the app window: in the desktop user's own LOCALAPPDATA when VELOX runs as a
# different account, because the browser drops admin rights and runs as that desktop user.
function Get-VxEdgeProfileDir {
    $du = $global:VxCtx.DesktopUser
    if ($null -ne $du -and $du.localAppData) { return [IO.Path]::Combine([IO.Path]::Combine([string]$du.localAppData, 'Velox'), 'edge-profile') }
    return (Get-VxDataPath 'edge-profile')
}

function Open-VxAppWindow([string]$Url) {
    if (-not (Test-VxWindows)) { return }
    try {
        $browser = Find-VxBrowser
        if ($browser) {
            $profileDir = Get-VxEdgeProfileDir
            # autoplay: the in-app start sequence plays its sound without a click (VELOX's own profile, so the
            # flag only applies to this window; with a profile already open the intro offers "Ton: klicken")
            $a = @(('--app=' + $Url), ('--user-data-dir=' + (ConvertTo-VxQuotedArg $profileDir)), '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--window-size=1360,880')
            Start-Process -FilePath $browser -ArgumentList ($a -join ' ') -ErrorAction Stop
            return
        }
    } catch { Write-VxLog 'warn' ('App-Fenster konnte nicht geoeffnet werden: ' + $_.Exception.Message) }
    # No browser in a protected folder: let the running (non-elevated) Explorer open the address in
    # the default browser - started from here, the user-chosen browser would run as admin.
    try {
        $explorer = [IO.Path]::Combine([string]$env:SystemRoot, 'explorer.exe')
        if ((Test-VxAdmin) -and [IO.File]::Exists($explorer)) { Start-Process -FilePath $explorer -ArgumentList ('"' + $Url + '"') -ErrorAction Stop }
        else { Start-Process -FilePath $Url -ErrorAction Stop }
    } catch {
        Write-VxConsole ('Bitte diese Adresse im Browser oeffnen: ' + $Url)
    }
}

# ------------------------------------------------------------------ single instance

# Testmodus and real mode are separate instances (own lock, own state, own instance file): a
# Testmodus window must never be mistaken for real mode, or the other way round.
$VxMutex = $null
$VxOwnsMutex = $false
try {
    $mutexName = 'Local\VELOX-' + (Get-VxModeTag) + '-' + (Get-VxShortHash $ctx.DataRoot.ToLowerInvariant())
    $created = $false
    $VxMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$created)
    if ($created) { $VxOwnsMutex = $true }
    else {
        try { $VxOwnsMutex = $VxMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $VxOwnsMutex = $true }
    }
} catch [System.UnauthorizedAccessException] {
    # the lock exists but belongs to an elevated instance: that instance is running
    $VxOwnsMutex = $false
} catch {
    Write-VxLog 'warn' ('Mutex nicht verfuegbar: ' + $_.Exception.Message)
    $VxOwnsMutex = $true
}

if (-not $VxOwnsMutex) {
    $instFile = Get-VxDataPath (Get-VxInstanceFileName)
    $url = $null
    for ($i = 0; $i -lt 20 -and -not $url; $i++) {
        try { if ([IO.File]::Exists($instFile)) { $url = [string](Read-VxJsonFile $instFile).url } } catch { $null = $_ }
        if (-not $url) { Start-Sleep -Milliseconds 500 }
    }
    Write-VxConsole 'VELOX laeuft bereits - das vorhandene Fenster wird geoeffnet.'
    if ($url -and $HostPid -gt 0) { Write-VxConsole ('VELOX_RUNNING ' + $url) }
    if ($url -and -not $NoBrowser) { Open-VxAppWindow $url }
    exit 0
}

# ------------------------------------------------------------------ init + server

$VxListener = $null
try {
    Write-VxHostStatus 'system'
    Initialize-VxOsInfo
    $null = Import-VxSettings
    $null = Import-VxState
    Write-VxHostStatus 'catalog'
    $null = Import-VxCatalog
    if ($ctx.Simulate) { Import-VxSim -Reset ([bool]$SimReset) }
    if ($SimReset) {
        $ctx.State.statuses = @{}; $ctx.State.naReasons = @{}; $ctx.State.profile = $null; $ctx.State.lastScan = $null
        $ctx.State.foreignCount = $null; $ctx.State.foreignKeys = $null; $ctx.State.needs = @{ explorer = $false; reboot = $false; logoff = $false }
    }
    $bootId = Get-VxBootId
    if ($bootId -and $ctx.State.bootId -ne $bootId) {
        $ctx.State.needs = @{ explorer = $false; reboot = $false; logoff = $false }
        $ctx.State.bootId = $bootId
    }
    Save-VxState
    $ctx.OsText = Get-VxOsText
    $ctx.DesktopUser = Get-VxDesktopUser
    $ctx.UserMismatch = ($null -ne $ctx.DesktopUser)
    if ($ctx.UserMismatch) { Write-VxLog 'warn' ('VELOX läuft als anderes Konto als der angemeldete Benutzer (' + $ctx.DesktopUser.name + '). Benutzer-Einstellungen werden in dessen Profil geschrieben.') }
    if ([string]::IsNullOrEmpty($Token)) { $Token = New-VxRandomHex 32 }
    $ctx.Token = $Token
    $ctx.Life = New-VxLifecycle
    # VELOX.exe shows the UI in its own window and ends the backend itself (job object, -HostPid
    # watcher): the page-heartbeat timeout is not needed there
    if ($HostPid -gt 0 -and $NoBrowser) { $ctx.Life.hostWindow = $true }
    Write-VxHostStatus 'server'
    $srv = Start-VxListener $Port
    $VxListener = $srv.listener
    $ctx.Port = $srv.port
    $appUrl = $srv.url + '?t=' + $Token
    $instPath = Get-VxDataPath (Get-VxInstanceFileName)
    Write-VxJsonFile -Path $instPath -InputObject ([ordered]@{ url = $appUrl; pid = $PID; started = (Get-VxNowIso) })
    # the URL carries the API token: in real mode only administrators may read it (the second
    # instance that reads it runs elevated as well)
    if (-not $ctx.Simulate) { Protect-VxAdminOnlyFile $instPath }
} catch {
    Write-VxLog 'error' ('Start fehlgeschlagen: ' + $_.Exception.Message)
    if ($null -ne $VxListener) { try { $VxListener.Close() } catch { $null = $_ } }
    if ($VxOwnsMutex -and $null -ne $VxMutex) { try { $VxMutex.ReleaseMutex() } catch { $null = $_ } }
    Wait-VxEnter ('VELOX konnte nicht starten: ' + $_.Exception.Message)
    exit 2
}

Write-VxConsole ''
Write-VxConsole '  __     __  _____   _        ___   __  __'
Write-VxConsole '  \ \   / / | ____| | |      / _ \  \ \/ /'
Write-VxConsole '   \ \ / /  |  _|   | |     | | | |  \  / '
Write-VxConsole '    \ V /   | |___  | |___  | |_| |  /  \ '
Write-VxConsole '     \_/    |_____| |_____|  \___/  /_/\_\'
Write-VxConsole ''
Write-VxConsole ('  VELOX ' + $ctx.Version + ' - Windows Tweaker')
if ($ctx.Simulate) { Write-VxConsole '  Modus: TESTMODUS - an deinem PC wird nichts veraendert.' }
else { Write-VxConsole '  Modus: ECHT (Administrator) - jede Aenderung wird vorher gesichert.' }
$catCount = $ctx.Catalog.tweaks.Count
Write-VxConsole ('  Katalog: ' + $catCount + ' Tweaks geladen.')
if ($ctx.Catalog.errors.Count -gt 0) { Write-VxConsole ('  Hinweis: ' + $ctx.Catalog.errors.Count + ' Katalog-Datei(en) mit Fehlern, Details im Log.') }
Write-VxConsole ''
Write-VxConsole '  VELOX laeuft - dieses Fenster offen lassen.'
Write-VxConsole '  Zum Beenden das VELOX-Fenster schliessen (oder hier Strg+C druecken).'
Write-VxConsole ''
Write-VxConsole ('VELOX_READY ' + $appUrl)
Write-VxLog 'info' ('VELOX gestartet auf ' + $srv.url + ' (Testmodus: ' + $ctx.Simulate + ')')

if (-not $NoBrowser) { Open-VxAppWindow $appUrl }

# -HostPid: a small watcher runspace asks the server loop to end (the normal shutdown path, so a
# running job still finishes) as soon as VELOX.exe is gone. Normally the host's job object ends the
# backend anyway; this covers a host that could not create one.
$VxHostWatch = $null
if ($HostPid -gt 0) {
    try {
        $hostStart = $null
        try { $hostStart = [Diagnostics.Process]::GetProcessById($HostPid).StartTime } catch { $hostStart = $null }
        $VxHostWatch = [PowerShell]::Create()
        $null = $VxHostWatch.AddScript({
            param($Life, [int]$HostId, $HostStart)
            while (-not $Life.stop) {
                Start-Sleep -Milliseconds 2000
                $gone = $false
                $hp = $null
                try {
                    $hp = [Diagnostics.Process]::GetProcessById($HostId)
                    if ($hp.HasExited) { $gone = $true }
                    elseif ($null -ne $HostStart -and $hp.StartTime -ne $HostStart) { $gone = $true }   # pid reused
                } catch { $gone = $true }
                if ($null -ne $hp) { try { $hp.Dispose() } catch { $null = $_ } }
                # $Life is a synchronized hashtable; ask only once (do not overwrite a shutdown in progress)
                if ($gone -and $null -eq $Life.shutdownAt) {
                    $Life.shutdownSession = $null
                    $Life.shutdownRequested = [DateTime]::UtcNow
                    $Life.shutdownAt = [DateTime]::UtcNow
                    $Life.reason = 'host'
                }
            }
        }).AddArgument($ctx.Life).AddArgument($HostPid).AddArgument($hostStart)
        $null = $VxHostWatch.BeginInvoke()
    } catch {
        Write-VxLog 'warn' ('Host-Ueberwachung nicht verfuegbar: ' + $_.Exception.Message)
        $VxHostWatch = $null
    }
}

try {
    Invoke-VxServerLoop $VxListener
} finally {
    if ($null -ne $VxHostWatch) { try { $ctx.Life.stop = $true; $VxHostWatch.Stop(); $VxHostWatch.Dispose() } catch { $null = $_ } }
    Write-VxConsole '  VELOX wird beendet ...'
    try { Stop-VxAllJobs 15 } catch { $null = $_ }
    try { $VxListener.Stop(); $VxListener.Close() } catch { $null = $_ }
    try { Save-VxState } catch { $null = $_ }
    try { Save-VxSim } catch { $null = $_ }
    try {
        $instFile = Get-VxDataPath (Get-VxInstanceFileName)
        if ([IO.File]::Exists($instFile)) {
            $inst = Read-VxJsonFile $instFile
            if ([int]$inst.pid -eq $PID) { [IO.File]::Delete($instFile) }
        }
    } catch { $null = $_ }
    $reason = [string]$ctx.Life.reason
    if (-not $reason) { $reason = 'abgebrochen' }
    Write-VxLog 'info' ('VELOX beendet (' + $reason + ')')
    if ($VxOwnsMutex -and $null -ne $VxMutex) { try { $VxMutex.ReleaseMutex(); $VxMutex.Dispose() } catch { $null = $_ } }
    Write-VxConsole '  VELOX beendet. Bis bald!'
}
exit 0
