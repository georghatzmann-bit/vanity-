# VELOX - core/Common.ps1
# Context ($global:VxCtx), logging, JSON helpers, native-process helper, paths.
# Only function definitions - this file is dot-sourced into every job runspace.
# Must run on Windows PowerShell 5.1 and pwsh 7 (see docs/ARCHITECTURE.md section 2).

function Test-VxWindows {
    return ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
}

function Test-VxAdmin {
    if (-not (Test-VxWindows)) { return $false }
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# Runspace-level fixes that must run once per runspace (main + every job runspace).
function Initialize-VxRuntime {
    # Windows PowerShell 5.1 serializes PSObject-wrapped arrays as {"value":[...],"Count":n}
    # because of the ETS type data on System.Array. Removing it fixes ConvertTo-Json.
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch { $null = $_ }
    }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { $null = $_ }
}

# ------------------------------------------------------------------ property helpers

# Works for hashtables, ordered dictionaries and PSCustomObjects.
function Test-VxProp($Object, [string]$Name) {
    if ($null -eq $Object) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
    return ($null -ne $Object.PSObject.Properties[$Name])
}

function Get-VxProp($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -ne $p) { return $p.Value }
    return $Default
}

# ------------------------------------------------------------------ JSON

function ConvertTo-VxJson($InputObject) {
    return (ConvertTo-Json -InputObject $InputObject -Depth 30 -Compress)
}

# Recursively converts ConvertFrom-Json output (PSCustomObject / arrays) to hashtables / object[].
function ConvertTo-VxHashtable($InputObject) {
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $h = @{}
        foreach ($k in @($InputObject.Keys)) { $h[[string]$k] = ConvertTo-VxHashtable $InputObject[$k] }
        return $h
    }
    if ($InputObject -is [string]) { return $InputObject }
    # pwsh 7 turns ISO date strings into DateTime while parsing JSON; keep them as text
    if ($InputObject -is [datetime]) { return (ConvertTo-VxIsoText $InputObject) }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $InputObject.PSObject.Properties) { $h[$p.Name] = ConvertTo-VxHashtable $p.Value }
        return $h
    }
    if ($InputObject -is [System.Collections.IEnumerable]) {
        $list = New-Object System.Collections.ArrayList
        foreach ($x in $InputObject) { [void]$list.Add((ConvertTo-VxHashtable $x)) }
        return , ($list.ToArray())
    }
    return $InputObject
}

function ConvertTo-VxIsoText($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) }
    return [string]$Value
}

function ConvertFrom-VxJsonText([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    return ($Text | ConvertFrom-Json -ErrorAction Stop)
}

function Read-VxJsonFile([string]$Path) {
    $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return (ConvertFrom-VxJsonText $text)
}

function Write-VxTextFile([string]$Path, [string]$Text) {
    $dir = [IO.Path]::GetDirectoryName($Path)
    if ($dir -and -not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
    $tmp = $Path + '.tmp'
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($tmp, $Text, $enc)
    if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }
    [IO.File]::Move($tmp, $Path)
}

function Write-VxJsonFile([string]$Path, $InputObject) {
    Write-VxTextFile -Path $Path -Text (ConvertTo-VxJson $InputObject)
}

# ------------------------------------------------------------------ context

function Get-VxDefaultDataRoot {
    if (Test-VxWindows) {
        $base = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if ([string]::IsNullOrEmpty($base)) { $base = $env:LOCALAPPDATA }
        return [IO.Path]::Combine($base, 'Velox')
    }
    return [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile), '.velox')
}

function New-VxContext {
    param(
        [string]$AppRoot,
        [string]$DataRoot,
        [bool]$Simulate,
        [string]$SimProfile = 'desktop',
        [string]$DataDir = ''
    )
    if ([string]::IsNullOrEmpty($DataRoot)) { $DataRoot = Get-VxDefaultDataRoot }
    if ([string]::IsNullOrEmpty($DataDir)) { $DataDir = [IO.Path]::Combine($AppRoot, 'data') }
    $isWin = Test-VxWindows
    if (-not $isWin) { $Simulate = $true }
    foreach ($d in @($DataRoot, [IO.Path]::Combine($DataRoot, 'backups'), [IO.Path]::Combine($DataRoot, 'logs'))) {
        if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    }
    $ctx = [hashtable]::Synchronized(@{})
    $ctx.Version = '1.0.0'
    $ctx.AppRoot = $AppRoot
    $ctx.CoreDir = [IO.Path]::Combine($AppRoot, 'core')
    $ctx.UiDir = [IO.Path]::Combine($AppRoot, 'ui')
    $ctx.DataDir = $DataDir
    $ctx.DataRoot = $DataRoot
    $ctx.BackupDir = [IO.Path]::Combine($DataRoot, 'backups')
    $ctx.LogDir = [IO.Path]::Combine($DataRoot, 'logs')
    $ctx.Simulate = [bool]$Simulate
    $ctx.Windows = $isWin
    $ctx.Admin = (Test-VxAdmin)
    $ctx.SimProfile = $SimProfile
    $ctx.Sim = [hashtable]::Synchronized(@{})
    $ctx.Cache = [hashtable]::Synchronized(@{})
    $ctx.Jobs = [hashtable]::Synchronized(@{})
    $ctx.CurrentJobId = $null
    $ctx.RestorePointDone = $false
    $ctx.LogLock = New-Object object
    $ctx.Build = 0
    $ctx.IsWin11 = $false
    $ctx.Catalog = $null
    $ctx.Settings = $null
    $ctx.State = $null
    $global:VxCtx = $ctx
    return $ctx
}

function Get-VxDataPath([string]$Name) {
    return [IO.Path]::Combine($global:VxCtx.DataRoot, $Name)
}

# ------------------------------------------------------------------ logging

function Write-VxLog {
    param([string]$Level = 'info', [string]$Message = '')
    $ctx = $global:VxCtx
    $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level.ToUpperInvariant(), $Message
    if ($null -ne $ctx -and $ctx.LogDir) {
        try {
            $file = [IO.Path]::Combine($ctx.LogDir, ('velox-' + (Get-Date).ToString('yyyyMMdd') + '.log'))
            [System.Threading.Monitor]::Enter($ctx.LogLock)
            try { [IO.File]::AppendAllText($file, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false))) }
            finally { [System.Threading.Monitor]::Exit($ctx.LogLock) }
        } catch { $null = $_ }
    }
    $job = $global:VxJob
    if ($null -ne $job) { Add-VxJobLog -Job $job -Level $Level -Message $Message }
}

function Add-VxJobLog {
    param($Job, [string]$Level = 'info', [string]$Message = '')
    if ($null -eq $Job) { return }
    $lvl = $Level
    if (@('info', 'ok', 'warn', 'error') -notcontains $lvl) { $lvl = 'info' }
    [System.Threading.Monitor]::Enter($Job.lockObj)
    try {
        $i = [int]$Job.nextIndex
        $Job.nextIndex = $i + 1
        $entry = [ordered]@{ i = $i; t = (Get-Date).ToString('HH:mm:ss'); level = $lvl; msg = $Message }
        [void]$Job.log.Add($entry)
        # keep memory bounded on very long jobs
        if ($Job.log.Count -gt 5000) { $Job.log.RemoveAt(0) }
    } finally { [System.Threading.Monitor]::Exit($Job.lockObj) }
}

function Set-VxProgress {
    param([double]$Progress = -1, [string]$Step = '')
    $job = $global:VxJob
    if ($null -eq $job) { return }
    if ($Progress -ge 0) {
        if ($Progress -gt 1) { $Progress = 1 }
        $job.progress = [math]::Round($Progress, 3)
    }
    if ($Step) { $job.step = $Step }
}

function Test-VxCancel {
    $job = $global:VxJob
    if ($null -ne $job -and $job.cancel) { throw 'VX_CANCELLED' }
}

# ------------------------------------------------------------------ native processes

# Quotes one argument the way the MS C runtime (CommandLineToArgvW) parses it.
function ConvertTo-VxArgument([string]$Arg) {
    if ($null -eq $Arg) { return '""' }
    if ($Arg.Length -gt 0 -and $Arg -notmatch '[\s"]') { return $Arg }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $bs = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq '\') { $bs++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append(('\' * ($bs * 2 + 1)))
            [void]$sb.Append('"')
            $bs = 0
            continue
        }
        if ($bs -gt 0) { [void]$sb.Append(('\' * $bs)); $bs = 0 }
        [void]$sb.Append($ch)
    }
    if ($bs -gt 0) { [void]$sb.Append(('\' * ($bs * 2))) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Get-VxOemEncoding {
    try {
        $cp = [Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
        return [Text.Encoding]::GetEncoding($cp)
    } catch {
        return [Text.Encoding]::UTF8
    }
}

# Runs a native program, captures stdout + stderr (OEM code page), enforces a timeout.
# Returns @{ ExitCode; Output; Error }. ExitCode -1 = could not start / timed out.
function Invoke-VxNative {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 60,
        [System.Text.Encoding]$Encoding = $null
    )
    $result = @{ ExitCode = -1; Output = ''; Error = '' }
    $argLine = (@($Arguments) | ForEach-Object { ConvertTo-VxArgument ([string]$_) }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $enc = $Encoding
    if ($null -eq $enc) { $enc = Get-VxOemEncoding }
    $psi.StandardOutputEncoding = $enc
    $psi.StandardErrorEncoding = $enc
    $p = $null
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $outTask = $p.StandardOutput.ReadToEndAsync()
        $errTask = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            try { $p.Kill() } catch { $null = $_ }
            $result.Error = "Zeitueberschreitung nach $TimeoutSec s: $FilePath"
            return $result
        }
        $p.WaitForExit()
        [void]$outTask.Wait(5000)
        [void]$errTask.Wait(5000)
        $result.ExitCode = $p.ExitCode
        $result.Output = [string]$outTask.Result
        $result.Error = [string]$errTask.Result
    } catch {
        $result.Error = "Programm konnte nicht gestartet werden ($FilePath): " + $_.Exception.Message
    } finally {
        if ($null -ne $p) { $p.Dispose() }
    }
    return $result
}

# Path of a Windows system tool, preferring the 64-bit System32 even from a 32-bit host.
function Get-VxSystemTool([string]$Name) {
    $win = $env:SystemRoot
    if ([string]::IsNullOrEmpty($win)) { $win = 'C:\Windows' }
    $sysnative = [IO.Path]::Combine($win, 'Sysnative')
    if (-not [Environment]::Is64BitProcess -and [IO.Directory]::Exists($sysnative)) {
        $p = [IO.Path]::Combine($sysnative, $Name)
        if ([IO.File]::Exists($p)) { return $p }
    }
    $p2 = [IO.Path]::Combine([IO.Path]::Combine($win, 'System32'), $Name)
    if ([IO.File]::Exists($p2)) { return $p2 }
    return $Name
}

# ------------------------------------------------------------------ misc helpers

function Get-VxNowIso { return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') }

function Get-VxShortHash([string]$Text) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $b = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))
        return (([BitConverter]::ToString($b)).Replace('-', '').Substring(0, 10).ToLowerInvariant())
    } finally { $sha.Dispose() }
}

function New-VxRandomHex([int]$Bytes = 32) {
    $b = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($b) } finally { $rng.Dispose() }
    return (([BitConverter]::ToString($b)).Replace('-', '').ToLowerInvariant())
}

function Format-VxBytes([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N0} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return ('{0:N0} B' -f $Bytes)
}

# German, user-facing text for an exception (no stack traces).
function Get-VxErrorText($ErrorRecord, [string]$Prefix = '') {
    $msg = ''
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $msg = $ErrorRecord.Exception.Message }
    elseif ($ErrorRecord -is [Exception]) { $msg = $ErrorRecord.Message }
    else { $msg = [string]$ErrorRecord }
    if ($msg -match 'denied|verweigert|UnauthorizedAccess|Requested registry access is not allowed') {
        $msg = 'Zugriff verweigert - Administratorrechte noetig oder der Eintrag ist von Windows geschuetzt. (' + $msg + ')'
    }
    if ($Prefix) { return ($Prefix + ': ' + $msg) }
    return $msg
}

# ------------------------------------------------------------------ settings / state

function Get-VxDefaultSettings {
    return @{
        accent = 'violet'
        motion = 'full'
        confirmRisky = $true
        autoRestorePoint = $true
        claude = @{ model = 'claude-opus-5-5' }
        games = @()
    }
}

function Import-VxSettings {
    $ctx = $global:VxCtx
    $s = Get-VxDefaultSettings
    $path = Get-VxDataPath 'settings.json'
    if ([IO.File]::Exists($path)) {
        try {
            $loaded = ConvertTo-VxHashtable (Read-VxJsonFile $path)
            if ($loaded -is [hashtable]) {
                foreach ($k in @('accent', 'motion', 'confirmRisky', 'autoRestorePoint')) {
                    if ($loaded.ContainsKey($k)) { $s[$k] = $loaded[$k] }
                }
                if ($loaded.ContainsKey('claude') -and $loaded.claude -is [hashtable] -and $loaded.claude.ContainsKey('model') -and $loaded.claude.model) {
                    $s.claude.model = [string]$loaded.claude.model
                }
                if ($loaded.ContainsKey('games') -and $null -ne $loaded.games) { $s.games = @($loaded.games) }
            }
        } catch {
            Write-VxLog 'warn' ('settings.json unlesbar, Standardwerte werden benutzt: ' + $_.Exception.Message)
        }
    }
    $ctx.Settings = [hashtable]::Synchronized($s)
    return $ctx.Settings
}

function Save-VxSettings {
    $ctx = $global:VxCtx
    $s = $ctx.Settings
    $out = [ordered]@{
        accent = $s.accent; motion = $s.motion; confirmRisky = [bool]$s.confirmRisky
        autoRestorePoint = [bool]$s.autoRestorePoint
        claude = [ordered]@{ model = [string]$s.claude.model }
        games = @($s.games)
    }
    Write-VxJsonFile -Path (Get-VxDataPath 'settings.json') -InputObject $out
}

# Settings as sent to the UI (adds claude.hasKey, never the key itself).
function Get-VxSettingsDto {
    $ctx = $global:VxCtx
    $s = $ctx.Settings
    return [ordered]@{
        accent = $s.accent
        motion = $s.motion
        confirmRisky = [bool]$s.confirmRisky
        autoRestorePoint = [bool]$s.autoRestorePoint
        claude = [ordered]@{ hasKey = (Test-VxClaudeKey); model = [string]$s.claude.model }
        games = @($s.games)
    }
}

# Merges a partial settings object from the UI. Unknown fields and invalid values are ignored.
function Update-VxSettings($Partial) {
    $ctx = $global:VxCtx
    $s = $ctx.Settings
    $p = ConvertTo-VxHashtable $Partial
    if (-not ($p -is [hashtable])) { return }
    if ($p.ContainsKey('accent') -and @('violet', 'blue', 'cyan', 'green', 'pink', 'orange') -contains [string]$p.accent) { $s.accent = [string]$p.accent }
    if ($p.ContainsKey('motion') -and @('full', 'reduced') -contains [string]$p.motion) { $s.motion = [string]$p.motion }
    if ($p.ContainsKey('confirmRisky') -and $p.confirmRisky -is [bool]) { $s.confirmRisky = $p.confirmRisky }
    if ($p.ContainsKey('autoRestorePoint') -and $p.autoRestorePoint -is [bool]) { $s.autoRestorePoint = $p.autoRestorePoint }
    if ($p.ContainsKey('claude') -and $p.claude -is [hashtable] -and $p.claude.ContainsKey('model')) {
        $m = [string]$p.claude.model
        if ($m -match '^[a-z0-9][a-z0-9.\-]{2,80}$') { $s.claude.model = $m }
    }
    Save-VxSettings
}

function Import-VxState {
    $ctx = $global:VxCtx
    $st = @{
        statuses = @{}; profile = $null; lastScan = $null
        needs = @{ explorer = $false; reboot = $false; logoff = $false }
        naReasons = @{}; ultimateGuid = $null; highGuid = $null; powersettingBefore = @{}
        bootId = $null; restorePoints = 0
    }
    $path = Get-VxDataPath 'state.json'
    if ([IO.File]::Exists($path)) {
        try {
            $loaded = ConvertTo-VxHashtable (Read-VxJsonFile $path)
            if ($loaded -is [hashtable]) {
                foreach ($k in @($loaded.Keys)) { $st[$k] = $loaded[$k] }
            }
        } catch {
            Write-VxLog 'warn' ('state.json unlesbar: ' + $_.Exception.Message)
        }
    }
    foreach ($k in @('statuses', 'naReasons', 'powersettingBefore')) { if (-not ($st[$k] -is [hashtable])) { $st[$k] = @{} } }
    if (-not ($st.needs -is [hashtable])) { $st.needs = @{ explorer = $false; reboot = $false; logoff = $false } }
    $ctx.State = [hashtable]::Synchronized($st)
    return $ctx.State
}

function Save-VxState {
    $ctx = $global:VxCtx
    if ($null -eq $ctx.State) { return }
    try {
        $copy = @{}
        foreach ($k in @($ctx.State.Keys)) { $copy[$k] = $ctx.State[$k] }
        Write-VxJsonFile -Path (Get-VxDataPath 'state.json') -InputObject $copy
    } catch {
        Write-VxLog 'warn' ('state.json konnte nicht gespeichert werden: ' + $_.Exception.Message)
    }
}

# State as sent to the UI (contract section 7).
function Get-VxStateDto {
    $st = $global:VxCtx.State
    $statuses = [ordered]@{}
    foreach ($k in @($st.statuses.Keys | Sort-Object)) { $statuses[$k] = $st.statuses[$k] }
    return [ordered]@{
        statuses = $statuses
        profile = $st.profile
        lastScan = $st.lastScan
        needs = [ordered]@{ explorer = [bool]$st.needs.explorer; reboot = [bool]$st.needs.reboot; logoff = [bool]$st.needs.logoff }
    }
}

function Add-VxNeeds([string]$Needs) {
    $st = $global:VxCtx.State
    if ($Needs -eq 'explorer') { $st.needs.explorer = $true }
    elseif ($Needs -eq 'reboot') { $st.needs.reboot = $true }
    elseif ($Needs -eq 'logoff') { $st.needs.logoff = $true }
}
