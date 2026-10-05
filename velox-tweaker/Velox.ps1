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
#>
[CmdletBinding()]
param(
    [switch]$Simulate,
    [switch]$NoBrowser,
    [int]$Port = 0,
    [string]$Token = '',
    [string]$DataRoot = '',
    [ValidateSet('desktop', 'laptop')][string]$SimProfile = 'desktop',
    [switch]$SimReset
)

function Write-VxConsole([string]$Text) {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

function Wait-VxEnter([string]$Text) {
    Write-VxConsole $Text
    try { $null = Read-Host 'Enter druecken zum Schliessen' } catch { $null = $_ }
}

function ConvertTo-VxQuotedArg([string]$Value) {
    $v = $Value.TrimEnd('\')
    return ('"' + $v.Replace('"', '\"') + '"')
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
    if (-not $isAdmin) {
        $hostExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-VxQuotedArg $PSCommandPath))
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
        try {
            Start-Process -FilePath $hostExe -ArgumentList ($argList -join ' ') -Verb RunAs -WorkingDirectory $VxRoot -ErrorAction Stop
            exit 0
        } catch {
            Write-VxConsole ''
            Write-VxConsole 'Die Administrator-Abfrage wurde abgelehnt oder ist fehlgeschlagen.'
            Write-VxConsole 'Ohne Adminrechte kann VELOX nichts an Windows aendern.'
            Write-VxConsole 'Tipp: Mit "Start-Testmodus.bat" kannst du VELOX gefahrlos ausprobieren -'
            Write-VxConsole 'im Testmodus wird nichts an deinem PC veraendert.'
            Wait-VxEnter ''
            exit 2
        }
    }
}

# Files from a downloaded ZIP carry the Mark-of-the-Web; unblock them so 5.1 loads them silently.
if ($VxIsWindows) {
    try { Get-ChildItem -LiteralPath $VxRoot -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue } catch { $null = $_ }
}

# ------------------------------------------------------------------ load core

$VxCoreNames = @('Common', 'System', 'Catalog', 'Engine', 'Detweak', 'Scan', 'Advisor', 'Claude', 'Extras', 'Jobs', 'Server')
foreach ($n in $VxCoreNames) {
    $f = Join-Path (Join-Path $VxRoot 'core') ($n + '.ps1')
    try { . $f } catch {
        Wait-VxEnter ('VELOX konnte core\' + $n + '.ps1 nicht laden: ' + $_.Exception.Message)
        exit 2
    }
}

Initialize-VxRuntime
# VELOX_DATA_DIR (tests only) points the catalog at another data folder, e.g. tests/fixtures/data.
$ctx = New-VxContext -AppRoot $VxRoot -DataRoot $DataRoot -Simulate ([bool]$Simulate) -SimProfile $SimProfile -DataDir ([string][Environment]::GetEnvironmentVariable('VELOX_DATA_DIR'))

# ------------------------------------------------------------------ app window

function Find-VxBrowser {
    $cands = New-Object System.Collections.Generic.List[string]
    foreach ($exe in @('msedge.exe', 'chrome.exe', 'brave.exe')) {
        foreach ($hk in @('HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\', 'HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\', 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\')) {
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
        foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
            if ($base) { $cands.Add((Join-Path $base $rel)) }
        }
    }
    foreach ($c in $cands) { if ($c -and [IO.File]::Exists($c)) { return $c } }
    return $null
}

function Open-VxAppWindow([string]$Url) {
    if (-not (Test-VxWindows)) { return }
    try {
        $browser = Find-VxBrowser
        if ($browser) {
            $profileDir = Get-VxDataPath 'edge-profile'
            $a = @(('--app=' + $Url), ('--user-data-dir=' + (ConvertTo-VxQuotedArg $profileDir)), '--no-first-run', '--no-default-browser-check', '--window-size=1360,880')
            Start-Process -FilePath $browser -ArgumentList ($a -join ' ') -ErrorAction Stop
            return
        }
    } catch { Write-VxLog 'warn' ('App-Fenster konnte nicht geoeffnet werden: ' + $_.Exception.Message) }
    try { Start-Process -FilePath $Url -ErrorAction Stop } catch {
        Write-VxConsole ('Bitte diese Adresse im Browser oeffnen: ' + $Url)
    }
}

# ------------------------------------------------------------------ single instance

$VxMutex = $null
$VxOwnsMutex = $false
try {
    $mutexName = 'Local\VELOX-' + (Get-VxShortHash $ctx.DataRoot.ToLowerInvariant())
    $created = $false
    $VxMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$created)
    if ($created) { $VxOwnsMutex = $true }
    else {
        try { $VxOwnsMutex = $VxMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $VxOwnsMutex = $true }
    }
} catch {
    Write-VxLog 'warn' ('Mutex nicht verfuegbar: ' + $_.Exception.Message)
    $VxOwnsMutex = $true
}

if (-not $VxOwnsMutex) {
    $instFile = Get-VxDataPath 'instance.json'
    $url = $null
    for ($i = 0; $i -lt 20 -and -not $url; $i++) {
        try { if ([IO.File]::Exists($instFile)) { $url = [string](Read-VxJsonFile $instFile).url } } catch { $null = $_ }
        if (-not $url) { Start-Sleep -Milliseconds 500 }
    }
    Write-VxConsole 'VELOX laeuft bereits - das vorhandene Fenster wird geoeffnet.'
    if ($url -and -not $NoBrowser) { Open-VxAppWindow $url }
    exit 0
}

# ------------------------------------------------------------------ init + server

$VxListener = $null
try {
    Initialize-VxOsInfo
    $null = Import-VxSettings
    $null = Import-VxState
    $null = Import-VxCatalog
    if ($ctx.Simulate) { Import-VxSim -Reset ([bool]$SimReset) }
    if ($SimReset) {
        $ctx.State.statuses = @{}; $ctx.State.naReasons = @{}; $ctx.State.profile = $null; $ctx.State.lastScan = $null
        $ctx.State.foreignCount = $null; $ctx.State.needs = @{ explorer = $false; reboot = $false; logoff = $false }
    }
    $bootId = Get-VxBootId
    if ($bootId -and $ctx.State.bootId -ne $bootId) {
        $ctx.State.needs = @{ explorer = $false; reboot = $false; logoff = $false }
        $ctx.State.bootId = $bootId
    }
    Save-VxState
    $ctx.OsText = Get-VxOsText
    $ctx.UserMismatch = Test-VxUserMismatch
    if ([string]::IsNullOrEmpty($Token)) { $Token = New-VxRandomHex 32 }
    $ctx.Token = $Token
    $ctx.Life = New-VxLifecycle
    $srv = Start-VxListener $Port
    $VxListener = $srv.listener
    $ctx.Port = $srv.port
    $appUrl = $srv.url + '?t=' + $Token
    Write-VxJsonFile -Path (Get-VxDataPath 'instance.json') -InputObject ([ordered]@{ url = $appUrl; pid = $PID; started = (Get-VxNowIso) })
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

try {
    Invoke-VxServerLoop $VxListener
} finally {
    Write-VxConsole '  VELOX wird beendet ...'
    try { Stop-VxAllJobs 15 } catch { $null = $_ }
    try { $VxListener.Stop(); $VxListener.Close() } catch { $null = $_ }
    try { Save-VxState } catch { $null = $_ }
    try { Save-VxSim } catch { $null = $_ }
    try {
        $instFile = Get-VxDataPath 'instance.json'
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
