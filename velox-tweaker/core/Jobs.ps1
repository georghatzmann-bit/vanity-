# VELOX - core/Jobs.ps1
# Background job runner: one runspace per job (the core files are dot-sourced inside it),
# shared synchronized hashtable for progress / log / result / cancel. One job at a time.
# Only function definitions.

function Get-VxJobTypes {
    return @('scan', 'apply', 'revert', 'restorepoint', 'restore', 'detweak-scan', 'detweak', 'advisor', 'claude',
        'clean-scan', 'run-action', 'startup-list', 'startup-set', 'games-detect', 'game-boost', 'pick-file',
        'explorer-restart', 'reboot')
}

function Get-VxCoreFiles {
    $dir = $global:VxCtx.CoreDir
    return @('Common', 'System', 'Catalog', 'Engine', 'Detweak', 'Scan', 'Advisor', 'Claude', 'Extras', 'Jobs') |
        ForEach-Object { [IO.Path]::Combine($dir, $_ + '.ps1') }
}

function Test-VxBusy {
    $ctx = $global:VxCtx
    $id = $ctx.CurrentJobId
    if (-not $id) { return $false }
    $j = $ctx.Jobs[$id]
    return ($null -ne $j -and $j.status -eq 'running')
}

function Get-VxJobHandles {
    $ctx = $global:VxCtx
    if (-not $ctx.ContainsKey('JobHandles') -or $null -eq $ctx.JobHandles) { $ctx.JobHandles = [hashtable]::Synchronized(@{}) }
    return $ctx.JobHandles
}

# Starts a job. Returns @{ jobId } or @{ busy = $true; jobId } when another job runs.
function Start-VxJob([string]$Type, $Params) {
    $ctx = $global:VxCtx
    if (Test-VxBusy) { return @{ busy = $true; jobId = $ctx.CurrentJobId } }
    if ((Get-VxJobTypes) -notcontains $Type) { throw "Unbekannter Job-Typ '$Type'" }
    # job state survives until the next job starts
    Update-VxJobs
    foreach ($k in @($ctx.Jobs.Keys)) { if ($ctx.Jobs[$k].status -ne 'running') { $ctx.Jobs.Remove($k) } }
    $id = New-VxRandomHex 8
    $job = [hashtable]::Synchronized(@{
            id = $id; type = $Type; status = 'running'; progress = 0.0; step = 'Starte ...'
            log = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); nextIndex = 0
            result = $null; error = $null; cancel = $false; started = (Get-VxNowIso); finished = $null
            lockObj = (New-Object object); params = $Params
        })
    $ctx.Jobs[$id] = $job
    $ctx.CurrentJobId = $id
    $bootstrap = @'
param($ctx, $job, $files)
foreach ($f in $files) { . ([scriptblock]::Create([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8))) }
Initialize-VxRuntime
$global:VxCtx = $ctx
$global:VxJob = $job
Invoke-VxJobBody
'@
    try {
        $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
        if ($ctx.Windows) {
            try { $iss.ExecutionPolicy = [Microsoft.PowerShell.ExecutionPolicy]::Bypass } catch { $null = $_ }
        }
        $rs = [runspacefactory]::CreateRunspace($iss)
        if ($ctx.Windows) {
            # STA for the file dialog and COM-based Windows APIs
            try { $rs.ApartmentState = [System.Threading.ApartmentState]::STA } catch { $null = $_ }
        }
        $rs.Open()
        $ps = [PowerShell]::Create()
        $ps.Runspace = $rs
        $null = $ps.AddScript($bootstrap).AddArgument($ctx).AddArgument($job).AddArgument((Get-VxCoreFiles))
        $handle = $ps.BeginInvoke()
        (Get-VxJobHandles)[$id] = @{ ps = $ps; rs = $rs; handle = $handle }
    } catch {
        $job.status = 'error'
        $job.error = 'Hintergrundaufgabe konnte nicht gestartet werden: ' + $_.Exception.Message
        $job.finished = Get-VxNowIso
    }
    Write-VxLog 'info' ("Job {0} ({1}) gestartet" -f $id, $Type)
    return @{ jobId = $id }
}

# Runs inside the job runspace.
function Invoke-VxJobBody {
    $job = $global:VxJob
    $p = $job.params
    try {
        $r = $null
        switch ($job.type) {
            'scan' { $r = Invoke-VxScanJob $p }
            'apply' { $r = Invoke-VxApplyJob $p 'apply' }
            'revert' { $r = Invoke-VxApplyJob $p 'revert' }
            'restorepoint' {
                $label = [string](Get-VxProp $p 'label' 'Manuell')
                if (-not $label) { $label = 'Manuell' }
                Set-VxProgress 0.1 'Erstelle Wiederherstellungspunkt ...'
                $x = New-VxRestorePoint $label $true
                Save-VxState
                if ($x.ok) { Write-VxLog 'ok' $x.message } else { Write-VxLog 'warn' $x.message }
                $r = [ordered]@{ ok = [bool]$x.ok; message = [string]$x.message }
            }
            'restore' { $r = Invoke-VxRestoreJob $p }
            'detweak-scan' { $r = Invoke-VxDetweakScanJob $p }
            'detweak' { $r = Invoke-VxDetweakJob $p }
            'advisor' { $r = Invoke-VxAdvisorJob $p }
            'claude' { $r = Invoke-VxClaudeJob $p }
            'clean-scan' { $r = Invoke-VxCleanJob $p }
            'run-action' { $r = Invoke-VxRunActionJob $p }
            'startup-list' { $r = Invoke-VxStartupListJob $p }
            'startup-set' { $r = Invoke-VxStartupSetJob $p }
            'games-detect' { $r = Invoke-VxGamesDetectJob $p }
            'game-boost' { $r = Invoke-VxGameBoostJob $p }
            'pick-file' { $r = Invoke-VxPickFileJob $p }
            'explorer-restart' { $r = Invoke-VxExplorerRestartJob $p }
            'reboot' { $r = Invoke-VxRebootJob $p }
            default { throw ("Unbekannter Job-Typ '{0}'" -f $job.type) }
        }
        $job.result = $r
        $job.progress = 1.0
        if (-not $job.step -or $job.step -eq 'Starte ...') { $job.step = 'Fertig' }
        $job.status = 'done'
    } catch {
        $msg = [string]$_.Exception.Message
        if ($job.cancel -or $msg -eq 'VX_CANCELLED') {
            $job.error = 'Abgebrochen.'
            $job.step = 'Abgebrochen'
            Add-VxJobLog $job 'warn' 'Vom Benutzer abgebrochen.'
            $job.status = 'cancelled'
        } else {
            $job.error = $msg
            Add-VxJobLog $job 'error' $msg
            try { Write-VxLog 'error' ("Job {0} fehlgeschlagen: {1} | {2}" -f $job.type, $msg, $_.ScriptStackTrace) } catch { $null = $_ }
            $job.status = 'error'
        }
    } finally {
        $job.finished = Get-VxNowIso
    }
}

# Disposes finished runspaces; marks jobs whose runspace died as error. Called by the server loop.
function Update-VxJobs {
    $ctx = $global:VxCtx
    $handles = Get-VxJobHandles
    foreach ($id in @($handles.Keys)) {
        $h = $handles[$id]
        if (-not $h.handle.IsCompleted) { continue }
        $job = $ctx.Jobs[$id]
        try { $null = $h.ps.EndInvoke($h.handle) } catch {
            if ($null -ne $job -and $job.status -eq 'running') { $job.error = 'Interner Fehler: ' + $_.Exception.Message }
        }
        if ($null -ne $job -and $job.status -eq 'running') {
            $errs = @($h.ps.Streams.Error | ForEach-Object { [string]$_ })
            if (-not $job.error) {
                $job.error = 'Die Hintergrundaufgabe wurde unerwartet beendet.'
                if ($errs.Count -gt 0) { $job.error += ' ' + $errs[0] }
            }
            $job.status = 'error'
            $job.finished = Get-VxNowIso
        }
        try { $h.ps.Dispose() } catch { $null = $_ }
        try { $h.rs.Close(); $h.rs.Dispose() } catch { $null = $_ }
        $handles.Remove($id)
    }
}

function Stop-VxJob([string]$Id) {
    $job = $global:VxCtx.Jobs[$Id]
    if ($null -eq $job) { return $false }
    if ($job.status -ne 'running') { return $false }
    $job.cancel = $true
    Add-VxJobLog $job 'warn' 'Abbruch angefordert ...'
    return $true
}

# Cancels everything and waits up to $WaitSec for the runspaces to end (shutdown).
function Stop-VxAllJobs([int]$WaitSec = 10) {
    $ctx = $global:VxCtx
    $handles = Get-VxJobHandles
    foreach ($id in @($ctx.Jobs.Keys)) { $j = $ctx.Jobs[$id]; if ($j.status -eq 'running') { $j.cancel = $true } }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $WaitSec) {
        $open = @($handles.Values | Where-Object { -not $_.handle.IsCompleted })
        if ($open.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }
    foreach ($id in @($handles.Keys)) {
        $h = $handles[$id]
        try { if (-not $h.handle.IsCompleted) { $h.ps.Stop() } } catch { $null = $_ }
        try { $h.ps.Dispose() } catch { $null = $_ }
        try { $h.rs.Close(); $h.rs.Dispose() } catch { $null = $_ }
        $handles.Remove($id)
    }
}

# Job object as sent to the UI. Log entries with i >= $Since.
function Get-VxJobDto($Job, [int]$Since = 0) {
    $entries = @()
    [System.Threading.Monitor]::Enter($Job.lockObj)
    try { $entries = @($Job.log | Where-Object { [int]$_.i -ge $Since }) }
    finally { [System.Threading.Monitor]::Exit($Job.lockObj) }
    return [ordered]@{
        id = $Job.id; type = $Job.type; status = $Job.status; progress = [double]$Job.progress; step = [string]$Job.step
        log = $entries; result = $Job.result; error = $Job.error
    }
}
