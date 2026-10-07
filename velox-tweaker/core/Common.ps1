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
    # one baseline attempt per session at most (a broken System Restore must not cost every job a wait)
    $ctx.RestorePointTried = $false
    # counts finished jobs that changed the system (Detweak reuses a scan only when nothing changed since)
    $ctx.ChangeGen = 0
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
    # Inside a job the lines are collected and written in one go (Flush-VxFileLog): opening the
    # log file for every line costs a virus scan on close on many PCs.
    $buf = $global:VxLogBuffer
    if ($null -ne $buf) {
        $buf.Add($line)
        if ($buf.Count -ge 200 -or $Level -eq 'error') { Flush-VxFileLog }
        return
    }
    Write-VxFileLines @($line)
}

function Write-VxFileLines([string[]]$Lines) {
    $ctx = $global:VxCtx
    if ($null -eq $ctx -or -not $ctx.LogDir -or @($Lines).Count -eq 0) { return }
    try {
        $file = [IO.Path]::Combine($ctx.LogDir, ('velox-' + (Get-Date).ToString('yyyyMMdd') + '.log'))
        $text = (@($Lines) -join "`r`n") + "`r`n"
        [System.Threading.Monitor]::Enter($ctx.LogLock)
        try { [IO.File]::AppendAllText($file, $text, (New-Object System.Text.UTF8Encoding($false))) }
        finally { [System.Threading.Monitor]::Exit($ctx.LogLock) }
    } catch { $null = $_ }
}

# Writes the lines a job collected (see Write-VxFileLog).
function Flush-VxFileLog {
    $buf = $global:VxLogBuffer
    if ($null -eq $buf -or $buf.Count -eq 0) { return }
    $lines = $buf.ToArray()
    $buf.Clear()
    Write-VxFileLines $lines
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
        $result.ExitCode = $p.ExitCode
        # a grandchild that inherited the pipe can keep it open: never block on .Result
        if ($outTask.Wait(5000)) { $result.Output = [string]$outTask.Result }
        if ($errTask.Wait(5000)) { $result.Error = [string]$errTask.Result }
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

# 64-bit Windows PowerShell 5.1 for isolated steps (pwsh off Windows, for the tests).
function Get-VxPowerShellExe {
    if (Test-VxWindows) { return (Get-VxSystemTool 'WindowsPowerShell\v1.0\powershell.exe') }
    try {
        $self = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        if ([IO.Path]::GetFileNameWithoutExtension($self) -match '^(pwsh|powershell)$') { return $self }
    } catch { $null = $_ }
    return 'pwsh'
}

# Ends a process and (on Windows) everything it started - a killed powershell.exe must not leave
# a powercfg or netsh behind.
function Stop-VxProcessTree($Process) {
    if ($null -eq $Process) { return }
    try { if ($Process.HasExited) { return } } catch { return }
    if (Test-VxWindows) {
        try { $null = Invoke-VxNative -FilePath (Get-VxSystemTool 'taskkill.exe') -Arguments @('/PID', [string]$Process.Id, '/T', '/F') -TimeoutSec 10 } catch { $null = $_ }
    } else {
        # pwsh 7 (tests): .NET's own tree kill; Process.Kill(bool) does not exist in Windows PowerShell 5.1
        try { $Process.Kill($true) } catch { $null = $_ }
    }
    try { if (-not $Process.HasExited) { $Process.Kill() } } catch { $null = $_ }
    try { [void]$Process.WaitForExit(3000) } catch { $null = $_ }
}

# Folder for the isolated scripts: <data root>\tmp (VELOX-owned, never the shared %TEMP%).
function Get-VxIsolatedDir {
    $d = Get-VxDataPath 'tmp'
    if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

# Deletes a script file of Invoke-VxIsolated; a scanner may hold it for a moment after the run.
function Remove-VxIsolatedFile([string]$Path) {
    for ($i = 0; $i -lt 5; $i++) {
        try { if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }; return } catch { Start-Sleep -Milliseconds 100 }
    }
}

# Removes isolated scripts older than a day (a VELOX that was killed mid-run cannot delete its own).
function Clear-VxIsolatedDir([string]$Dir) {
    try {
        $limit = [DateTime]::UtcNow.AddDays(-1)
        foreach ($f in @([IO.Directory]::GetFiles($Dir, 'iso-*.ps1'))) {
            try { if ([IO.File]::GetLastWriteTimeUtc($f) -lt $limit) { [IO.File]::Delete($f) } } catch { $null = $_ }
        }
    } catch { $null = $_ }
}

# Runs PowerShell source in its own powershell.exe with a hard timeout, so a step that hangs
# (restore point, a reset command) can never block a job. -Skippable shows "Überspringen" in the
# job overlay while it runs (job.skippable); the button (job.skip) and "Abbrechen" (job.cancel) end
# the process at once. The script runs with the default error preference; a terminating error
# becomes exit code 1 with its message on stderr.
# The source goes into a temp .ps1 in <data root>\tmp (UTF-8 with BOM, so 5.1 keeps the umlauts)
# started with -File and deleted afterwards - never -EncodedCommand: virus scanners (Defender ASR,
# AMSI heuristics) flag base64-encoded commands from elevated processes.
# Returns @{ ok; exitCode; output; error; timedOut; skipped; ms }. Throws VX_CANCELLED on cancel.
function Invoke-VxIsolated {
    param([string]$Script, [int]$TimeoutSec = 90, [switch]$Skippable, [string]$Step = '')
    $job = $global:VxJob
    $res = @{ ok = $false; exitCode = -1; output = ''; error = ''; timedOut = $false; skipped = $false; ms = 0 }
    $wrapped = "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding(`$false) } catch { `$null = `$_ }`r`n" +
        "`$ProgressPreference = 'SilentlyContinue'`r`n" +
        "try {`r`n& {`r`n" + $Script + "`r`n}`r`n} catch { [Console]::Error.WriteLine([string]`$_.Exception.Message); exit 1 }`r`nexit 0`r`n"
    $file = $null
    try {
        $dir = Get-VxIsolatedDir
        Clear-VxIsolatedDir $dir
        $file = [IO.Path]::Combine($dir, ('iso-' + [Guid]::NewGuid().ToString('N').Substring(0, 12) + '.ps1'))
        [IO.File]::WriteAllText($file, $wrapped, (New-Object System.Text.UTF8Encoding($true)))
    } catch {
        $res.error = 'PowerShell-Skript konnte nicht angelegt werden: ' + $_.Exception.Message
        return $res
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Get-VxPowerShellExe
    $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (ConvertTo-VxArgument $file)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = $null
    $cancelled = $false
    if ($Skippable -and $null -ne $job) { $job.skip = $false; $job.skippable = $true }
    try {
        try { $p = [System.Diagnostics.Process]::Start($psi) }
        catch { $res.error = 'PowerShell konnte nicht gestartet werden: ' + $_.Exception.Message; return $res }
        try { $p.StandardInput.Close() } catch { $null = $_ }
        $outTask = $p.StandardOutput.ReadToEndAsync()
        $errTask = $p.StandardError.ReadToEndAsync()
        $lastSec = -1
        while (-not $p.WaitForExit(200)) {
            if ($null -ne $job -and $job.cancel) { $cancelled = $true; break }
            if ($Skippable -and $null -ne $job -and $job.skip) { $res.skipped = $true; break }
            $sec = [int][math]::Floor($sw.Elapsed.TotalSeconds)
            if ($sec -ge $TimeoutSec) { $res.timedOut = $true; break }
            if ($Step -and $sec -ne $lastSec -and $sec -ge 3) {
                $lastSec = $sec
                Set-VxProgress -Step ('{0} ({1}:{2:00})' -f $Step, [int][math]::Floor($sec / 60), ($sec % 60))
            }
        }
        if ($cancelled -or $res.skipped -or $res.timedOut) {
            Stop-VxProcessTree $p
            # what the script printed before it was stopped (e.g. the points deleted so far)
            try { if ($outTask.Wait(3000)) { $res.output = [string]$outTask.Result } } catch { $null = $_ }
        } else {
            $p.WaitForExit()
            $res.exitCode = $p.ExitCode
            # a process the script started may still hold the pipe: never block on .Result
            if ($outTask.Wait(5000)) { $res.output = [string]$outTask.Result }
            if ($errTask.Wait(5000)) { $res.error = ([string]$errTask.Result).Trim() }
            $res.ok = ($p.ExitCode -eq 0)
        }
    } finally {
        if ($Skippable -and $null -ne $job) { $job.skippable = $false; $job.skip = $false }
        if ($null -ne $p) { try { $p.Dispose() } catch { $null = $_ } }
        if ($file) { Remove-VxIsolatedFile $file }
        $res.ms = [int]$sw.ElapsedMilliseconds
    }
    if ($cancelled) { throw 'VX_CANCELLED' }
    return $res
}

# The JSON a script printed as "VXRESULT <json>" (Invoke-VxIsolated output), or $null.
function Get-VxIsolatedResult([string]$Output) {
    foreach ($line in ([string]$Output -split "\r?\n")) {
        if ($line.StartsWith('VXRESULT ')) {
            try { return (ConvertFrom-VxJsonText $line.Substring(9)) } catch { return $null }
        }
    }
    return $null
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

# restorePoints: 'first' = one baseline restore point before the first change VELOX ever makes
# on this PC, 'presets' = baseline + before big jobs (presets, Detweak, KI plan with 10+ tweaks,
# at most one per 24 h), 'off' = none (the JSON journals still make everything undoable).
function Get-VxRestorePointModes { return @('first', 'presets', 'off') }

function Get-VxDefaultSettings {
    return @{
        accent = 'violet'
        motion = 'full'
        confirmRisky = $true
        restorePoints = 'first'
        # start sequence (brand/intro.js): its sound may play (also read by VELOX.exe, see ARCHITECTURE §11)
        startSound = $true
        # which start sequence plays (also read by VELOX.exe): 'long' = the long intro on every launch,
        # 'short' = the short one, 'off' = no animation and no sound (the still frame)
        introMode = 'long'
        # VERSION whose full intro the in-app splash last played ('' = never; Start.bat / Edge window only)
        introSeen = ''
        claude = @{ model = 'claude-opus-5-5' }
        # KI-Optimierer (core/Claude.ps1): provider '' = automatic (first ready one)
        ai = @{ provider = ''; claudeCode = @{ model = 'sonnet' }; groq = @{ model = '' } }
        games = @()
    }
}

# Merges a partial "ai" settings object (from settings.json or the UI) into $Settings.ai.
function Merge-VxAiSettings($Settings, $Ai) {
    if (-not ($Ai -is [hashtable])) { return }
    if ($Ai.ContainsKey('provider')) {
        $pv = [string]$Ai.provider
        if ($pv -eq '' -or @('claude-code', 'claude-api', 'groq', 'offline') -contains $pv) { $Settings.ai.provider = $pv }
    }
    if ($Ai.ContainsKey('claudeCode') -and $Ai.claudeCode -is [hashtable] -and $Ai.claudeCode.ContainsKey('model')) {
        $m = [string]$Ai.claudeCode.model
        if (@('sonnet', 'opus', 'haiku') -contains $m) { $Settings.ai.claudeCode.model = $m }
    }
    if ($Ai.ContainsKey('groq') -and $Ai.groq -is [hashtable] -and $Ai.groq.ContainsKey('model')) {
        $g = [string]$Ai.groq.model
        if ($g -eq '' -or $g -match '^[A-Za-z0-9][A-Za-z0-9._/:\-]{1,100}$') { $Settings.ai.groq.model = $g }
    }
}

# settings.introSeen: '' or a version like 1.2.0 (it is only ever compared with VERSION)
function Test-VxIntroSeenValue($Value) {
    return ($Value -is [string] -and ($Value -eq '' -or $Value -match '^\d{1,4}\.\d{1,4}\.\d{1,4}$'))
}

# settings.introMode: 'long' (default) | 'short' | 'off' (ARCHITECTURE §7 / §11)
function Get-VxIntroModes { return @('long', 'short', 'off') }

function Get-VxIntroMode {
    $s = $global:VxCtx.Settings
    $m = ''
    if ($null -ne $s) { $m = [string]$s.introMode }
    if ((Get-VxIntroModes) -cnotcontains $m) { return 'long' }
    return $m
}

function Get-VxRestorePointMode {
    $s = $global:VxCtx.Settings
    $m = ''
    if ($null -ne $s) { $m = [string]$s.restorePoints }
    if ((Get-VxRestorePointModes) -notcontains $m) { return 'first' }
    return $m
}

function Import-VxSettings {
    $ctx = $global:VxCtx
    $s = Get-VxDefaultSettings
    $path = Get-VxDataPath 'settings.json'
    if ([IO.File]::Exists($path)) {
        try {
            $loaded = ConvertTo-VxHashtable (Read-VxJsonFile $path)
            if ($loaded -is [hashtable]) {
                foreach ($k in @('accent', 'motion', 'confirmRisky')) {
                    if ($loaded.ContainsKey($k)) { $s[$k] = $loaded[$k] }
                }
                # older versions stored the bool autoRestorePoint: on -> 'first', off -> 'off'
                if ($loaded.ContainsKey('restorePoints') -and (Get-VxRestorePointModes) -contains [string]$loaded.restorePoints) { $s.restorePoints = [string]$loaded.restorePoints }
                elseif ($loaded.ContainsKey('autoRestorePoint') -and $loaded.autoRestorePoint -is [bool]) {
                    if ($loaded.autoRestorePoint) { $s.restorePoints = 'first' } else { $s.restorePoints = 'off' }
                }
                if ($loaded.ContainsKey('claude') -and $loaded.claude -is [hashtable] -and $loaded.claude.ContainsKey('model') -and $loaded.claude.model) {
                    $s.claude.model = [string]$loaded.claude.model
                }
                if ($loaded.ContainsKey('ai')) { Merge-VxAiSettings $s $loaded.ai }
                if ($loaded.ContainsKey('startSound') -and $loaded.startSound -is [bool]) { $s.startSound = $loaded.startSound }
                if ($loaded.ContainsKey('introMode') -and $loaded.introMode -is [string] -and (Get-VxIntroModes) -ccontains $loaded.introMode) { $s.introMode = [string]$loaded.introMode }
                if ($loaded.ContainsKey('introSeen') -and (Test-VxIntroSeenValue $loaded.introSeen)) { $s.introSeen = [string]$loaded.introSeen }
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
        restorePoints = (Get-VxRestorePointMode)
        startSound = ($s.startSound -ne $false)
        introMode = (Get-VxIntroMode)
        introSeen = [string]$s.introSeen
        claude = [ordered]@{ model = [string]$s.claude.model }
        ai = [ordered]@{ provider = [string]$s.ai.provider; claudeCode = [ordered]@{ model = [string]$s.ai.claudeCode.model }; groq = [ordered]@{ model = [string]$s.ai.groq.model } }
        games = @($s.games)
    }
    Write-VxJsonFile -Path (Get-VxDataPath 'settings.json') -InputObject $out
}

# Settings as sent to the UI (adds claude.hasKey / ai.groq.hasKey, never a key itself).
function Get-VxSettingsDto {
    $ctx = $global:VxCtx
    $s = $ctx.Settings
    return [ordered]@{
        accent = $s.accent
        motion = $s.motion
        confirmRisky = [bool]$s.confirmRisky
        restorePoints = (Get-VxRestorePointMode)
        # read-only, for older UIs: any automatic restore point at all
        autoRestorePoint = ((Get-VxRestorePointMode) -ne 'off')
        startSound = ($s.startSound -ne $false)
        introMode = (Get-VxIntroMode)
        introSeen = [string]$s.introSeen
        claude = [ordered]@{ hasKey = (Test-VxClaudeKey); model = [string]$s.claude.model }
        ai = [ordered]@{
            provider = [string]$s.ai.provider
            claudeCode = [ordered]@{ model = [string]$s.ai.claudeCode.model }
            groq = [ordered]@{ hasKey = (Test-VxGroqKey); model = [string]$s.ai.groq.model }
        }
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
    if ($p.ContainsKey('startSound') -and $p.startSound -is [bool]) { $s.startSound = $p.startSound }
    if ($p.ContainsKey('introMode') -and $p.introMode -is [string] -and (Get-VxIntroModes) -ccontains $p.introMode) { $s.introMode = [string]$p.introMode }
    if ($p.ContainsKey('introSeen') -and (Test-VxIntroSeenValue $p.introSeen)) { $s.introSeen = [string]$p.introSeen }
    if ($p.ContainsKey('restorePoints') -and (Get-VxRestorePointModes) -contains [string]$p.restorePoints) { $s.restorePoints = [string]$p.restorePoints }
    elseif ($p.ContainsKey('autoRestorePoint') -and $p.autoRestorePoint -is [bool]) {
        # older UIs: off -> 'off', on -> keep the current mode ('first' when it was off)
        if (-not $p.autoRestorePoint) { $s.restorePoints = 'off' }
        elseif ((Get-VxRestorePointMode) -eq 'off') { $s.restorePoints = 'first' }
    }
    if ($p.ContainsKey('claude') -and $p.claude -is [hashtable] -and $p.claude.ContainsKey('model')) {
        $m = [string]$p.claude.model
        if ($m -match '^[a-z0-9][a-z0-9.\-]{2,80}$') { $s.claude.model = $m }
    }
    if ($p.ContainsKey('ai')) { Merge-VxAiSettings $s $p.ai }
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
        # the one baseline restore point (Engine.ps1 Invoke-VxAutoRestorePoint) and the newest
        # restore point VELOX made (for the 24 h rule of restorePoints = 'presets')
        restorePointBaseline = $null; restorePointLast = $null
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
        restorePointBaseline = (Get-VxBaselineDto)
    }
}

# The baseline restore point as sent to the UI: { status, created, sequence, description } or null.
# status: created | adopted (an older VELOX point became the baseline) | skipped | timeout | failed
function Get-VxBaselineDto {
    $st = $global:VxCtx.State
    if ($null -eq $st -or -not $st.ContainsKey('restorePointBaseline')) { return $null }
    $b = $st.restorePointBaseline
    if ($null -eq $b) { return $null }
    $seq = Get-VxProp $b 'sequence'
    if ($null -ne $seq) { $seq = [long]$seq }
    return [ordered]@{
        status = [string](Get-VxProp $b 'status' '')
        created = (ConvertTo-VxIsoText (Get-VxProp $b 'created'))
        sequence = $seq
        description = [string](Get-VxProp $b 'description' '')
    }
}

function Add-VxNeeds([string]$Needs) {
    $st = $global:VxCtx.State
    if ($Needs -eq 'explorer') { $st.needs.explorer = $true }
    elseif ($Needs -eq 'reboot') { $st.needs.reboot = $true }
    elseif ($Needs -eq 'logoff') { $st.needs.logoff = $true }
}
