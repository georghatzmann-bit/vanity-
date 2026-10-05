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

# Restricts a file to Administrators and SYSTEM (Windows only, never fatal). Used for files that
# hold the API token in real mode, where the normal user's processes must not read them.
function Protect-VxAdminOnlyFile([string]$Path) {
    if (-not (Test-VxWindows)) { return }
    try {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) {
            $id = New-Object System.Security.Principal.SecurityIdentifier($sid)
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
        }
        Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    } catch { Write-VxLog 'warn' ('Zugriffsrechte für ' + [IO.Path]::GetFileName($Path) + ' konnten nicht gesetzt werden: ' + $_.Exception.Message) }
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
    # set by Velox.ps1: the desktop user when VELOX runs elevated as another account (Get-VxDesktopUser)
    $ctx.DesktopUser = $null
    $ctx.UserMismatch = $false
    # core file text read once at startup (Get-VxCoreSources)
    $ctx.CoreSources = $null
    $global:VxCtx = $ctx
    return $ctx
}

function Get-VxDataPath([string]$Name) {
    return [IO.Path]::Combine($global:VxCtx.DataRoot, $Name)
}

# ------------------------------------------------------------------ logging

# Log file only (logs\velox-<date>.log in the data root) - for details the user never sees,
# e.g. PowerShell stack traces.
function Write-VxFileLog {
    param([string]$Level = 'info', [string]$Message = '')
    $ctx = $global:VxCtx
    if ($null -eq $ctx -or -not $ctx.LogDir) { return }
    $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level.ToUpperInvariant(), $Message
    try {
        $file = [IO.Path]::Combine($ctx.LogDir, ('velox-' + (Get-Date).ToString('yyyyMMdd') + '.log'))
        [System.Threading.Monitor]::Enter($ctx.LogLock)
        try { [IO.File]::AppendAllText($file, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false))) }
        finally { [System.Threading.Monitor]::Exit($ctx.LogLock) }
    } catch { $null = $_ }
}

# Log file + the running job's log (user-visible, without stack traces - see Remove-VxStackText).
function Write-VxLog {
    param([string]$Level = 'info', [string]$Message = '')
    Write-VxFileLog -Level $Level -Message $Message
    $job = $global:VxJob
    if ($null -ne $job) { Add-VxJobLog -Job $job -Level $Level -Message $Message }
}

# User-visible error text without PowerShell stack traces and error-position noise:
# "| at <ScriptBlock>, <No file>: line 3", "at Invoke-VxFoo, C:\...\Engine.ps1: line 12",
# "At line:3 char:5" / "In Zeile:3 Zeichen:5", "+ throw ...", "+ CategoryInfo ...", "~~~~".
function Remove-VxStackText([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $keep = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($Text -split "\r?\n")) {
        if ($line -match '^\s*\|?\s*at\s.+(:\s*(line|Zeile)\s*\d+|<ScriptBlock>|<No file>)') { continue }
        if ($line -match '^\s*(At|In|Bei)\s+(line|Zeile)\s*:\s*\d+') { continue }
        if ($line -match '^\s*\+\s' -or $line -match '^\s*~+\s*$') { continue }
        if ($line -match '^\s*\+?\s*(CategoryInfo|FullyQualifiedErrorId)\s*:') { continue }
        # a stack trace appended on the same line: "Fehler | at <ScriptBlock>, <No file>: line 3"
        $l = [regex]::Replace($line, '\s*\|\s*at\s.*$', '')
        $l = [regex]::Replace($l, '\s+at\s+(<ScriptBlock>|[\w-]+),\s*[^,]*:\s*(line|Zeile)\s*\d+.*$', '')
        if ($l.Trim()) { $keep.Add($l.TrimEnd()) }
    }
    $out = ($keep.ToArray() -join "`n").Trim()
    if (-not $out) { return 'Interner Fehler – Details stehen in der Logdatei.' }
    return $out
}

function Add-VxJobLog {
    param($Job, [string]$Level = 'info', [string]$Message = '')
    if ($null -eq $Job) { return }
    $lvl = $Level
    if (@('info', 'ok', 'warn', 'error') -notcontains $lvl) { $lvl = 'info' }
    $clean = Remove-VxStackText $Message
    [System.Threading.Monitor]::Enter($Job.lockObj)
    try {
        $i = [int]$Job.nextIndex
        $Job.nextIndex = $i + 1
        $entry = [ordered]@{ i = $i; t = (Get-Date).ToString('HH:mm:ss'); level = $lvl; msg = $clean }
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

# Encoding for a code page number given as text ('850', '65001'); $null when unusable.
function ConvertTo-VxCodePageEncoding($CodePage) {
    $n = 0
    if (-not [int]::TryParse(([string]$CodePage).Trim(), [ref]$n) -or $n -le 0) { return $null }
    if ($n -eq 65001) { return (New-Object System.Text.UTF8Encoding($false)) }
    try { return [Text.Encoding]::GetEncoding($n) } catch { return $null }
}

# The OEM code page console tools (powercfg, bcdedit, sc ...) really print with. It is a system
# setting (Nls\CodePage\OEMCP, 65001 with "Unicode UTF-8 for worldwide language support"), not
# culture data, so it is read from the registry first and the culture is only the fallback.
function Get-VxOemEncoding {
    if (Test-VxWindows) {
        try {
            $raw = [Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Nls\CodePage', 'OEMCP', $null)
            $e = ConvertTo-VxCodePageEncoding $raw
            if ($null -ne $e) { return $e }
        } catch { $null = $_ }
    }
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
            $result.Error = "Zeitüberschreitung nach $TimeoutSec s: $FilePath"
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

# German number text (de-DE: decimal comma, thousands dot), independent of the runspace culture.
function Format-VxNumber([double]$Value, [int]$Decimals = 0) {
    $de = [Globalization.CultureInfo]::GetCultureInfo('de-DE')
    return $Value.ToString(('N' + $Decimals), $de)
}

function Format-VxBytes([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ((Format-VxNumber ($Bytes / 1GB) 1) + ' GB') }
    if ($Bytes -ge 1MB) { return ((Format-VxNumber ($Bytes / 1MB) 0) + ' MB') }
    if ($Bytes -ge 1KB) { return ((Format-VxNumber ($Bytes / 1KB) 0) + ' KB') }
    return ((Format-VxNumber $Bytes 0) + ' B')
}

# $true when an error (ErrorRecord or Exception, possibly wrapped) is "access denied": a registry key
# only SYSTEM may read (e.g. the display class key 'Properties'), a protected file and the like.
function Test-VxAccessDenied($ErrorRecord) {
    $ex = $null
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ex = $ErrorRecord.Exception }
    elseif ($ErrorRecord -is [Exception]) { $ex = $ErrorRecord }
    while ($null -ne $ex) {
        if ($ex -is [System.Security.SecurityException] -or $ex -is [UnauthorizedAccessException]) { return $true }
        $ex = $ex.InnerException
    }
    return $false
}

# German, user-facing text for an exception (no stack traces).
function Get-VxErrorText($ErrorRecord, [string]$Prefix = '') {
    $msg = ''
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $msg = $ErrorRecord.Exception.Message }
    elseif ($ErrorRecord -is [Exception]) { $msg = $ErrorRecord.Message }
    else { $msg = [string]$ErrorRecord }
    if ($msg -match 'denied|verweigert|UnauthorizedAccess|Requested registry access is not allowed') {
        $msg = 'Zugriff verweigert – Administratorrechte nötig oder der Eintrag ist von Windows geschützt. (' + $msg + ')'
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

# Testmodus and real mode keep separate state, instance and lock files: simulated statuses,
# "needs reboot" flags and remembered power-setting values must never show up in real mode.
function Get-VxModeTag {
    if ($global:VxCtx.Simulate) { return 'sim' }
    return 'real'
}

function Get-VxStateFileName {
    if ($global:VxCtx.Simulate) { return 'state-sim.json' }
    return 'state.json'
}

function Get-VxInstanceFileName {
    if ($global:VxCtx.Simulate) { return 'instance-sim.json' }
    return 'instance.json'
}

function Import-VxState {
    $ctx = $global:VxCtx
    $st = @{
        statuses = @{}; profile = $null; lastScan = $null
        needs = @{ explorer = $false; reboot = $false; logoff = $false }
        naReasons = @{}; ultimateGuid = $null; highGuid = $null; powersettingBefore = @{}
        bootId = $null; restorePoints = 0
    }
    $name = Get-VxStateFileName
    $path = Get-VxDataPath $name
    if ([IO.File]::Exists($path)) {
        try {
            $loaded = ConvertTo-VxHashtable (Read-VxJsonFile $path)
            if ($loaded -is [hashtable]) {
                foreach ($k in @($loaded.Keys)) { $st[$k] = $loaded[$k] }
            }
        } catch {
            Write-VxLog 'warn' ($name + ' unlesbar: ' + $_.Exception.Message)
        }
    }
    # The Testmodus may know the power plan copies real mode created (read-only, never written back).
    if ($ctx.Simulate -and -not ($st.ultimateGuid -or $st.highGuid)) {
        $real = Get-VxDataPath 'state.json'
        if ([IO.File]::Exists($real)) {
            try {
                $r = ConvertTo-VxHashtable (Read-VxJsonFile $real)
                if ($r -is [hashtable]) { foreach ($k in @('ultimateGuid', 'highGuid')) { if ($r.ContainsKey($k)) { $st[$k] = $r[$k] } } }
            } catch { $null = $_ }
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
        Write-VxJsonFile -Path (Get-VxDataPath (Get-VxStateFileName)) -InputObject $copy
    } catch {
        Write-VxLog 'warn' ((Get-VxStateFileName) + ' konnte nicht gespeichert werden: ' + $_.Exception.Message)
    }
}

# State as sent to the UI (contract section 7).
function Get-VxStateDto {
    $st = $global:VxCtx.State
    $statuses = [ordered]@{}
    # a running job may write statuses while the server thread enumerates them - retry on that race
    for ($try = 0; $try -lt 5; $try++) {
        try {
            $statuses = [ordered]@{}
            foreach ($k in @($st.statuses.Keys | Sort-Object)) { $statuses[$k] = $st.statuses[$k] }
            break
        } catch { Start-Sleep -Milliseconds 20 }
    }
    # foreignCount: foreign tweaks found by the last detweak scan (VELOX's own tweaks not counted),
    # kept in sync by detweak / apply / revert; null until the first detweak scan
    $fc = $null
    if ($st.ContainsKey('foreignCount') -and $null -ne $st.foreignCount) { $fc = [int]$st.foreignCount }
    return [ordered]@{
        statuses = $statuses
        profile = $st.profile
        lastScan = $st.lastScan
        needs = [ordered]@{ explorer = [bool]$st.needs.explorer; reboot = [bool]$st.needs.reboot; logoff = [bool]$st.needs.logoff }
        foreignCount = $fc
    }
}

function Add-VxNeeds([string]$Needs) {
    $st = $global:VxCtx.State
    if ($Needs -eq 'explorer') { $st.needs.explorer = $true }
    elseif ($Needs -eq 'reboot') { $st.needs.reboot = $true }
    elseif ($Needs -eq 'logoff') { $st.needs.logoff = $true }
}
