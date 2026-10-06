# VELOX - core/Jobs.ps1
# Background job runner: ONE worker runspace that is kept alive and reused for every job (the core
# files are dot-sourced into it once, pre-warmed while VELOX is idle); it is only recreated after
# it crashed. Shared synchronized hashtable for progress / log / result / cancel / skip. One job at
# a time. Only function definitions.

function Get-VxJobTypes {
    return @('scan', 'apply', 'revert', 'restorepoint', 'restore', 'detweak-scan', 'detweak', 'advisor', 'claude', 'ai', 'ai-status',
        'clean-scan', 'run-action', 'startup-list', 'startup-set', 'games-detect', 'game-boost', 'pick-file',
        'explorer-restart', 'reboot', 'restorepoint-list', 'restorepoint-clean')
}

# Jobs that change the system (after them a cached Detweak scan is stale).
function Get-VxMutatingJobTypes {
    return @('apply', 'revert', 'restore', 'detweak', 'run-action', 'startup-set', 'game-boost', 'restorepoint-clean')
}

function Get-VxCoreNames {
    return @('Common', 'System', 'Catalog', 'Engine', 'Detweak', 'Scan', 'Advisor', 'Claude', 'Extras', 'Jobs')
}

function Get-VxCoreFiles {
    $dir = $global:VxCtx.CoreDir
    return @(Get-VxCoreNames | ForEach-Object { [IO.Path]::Combine($dir, $_ + '.ps1') })
}

# Source text of the core files, read ONCE (Velox.ps1 stores what it loaded at startup). Job
# runspaces run with admin rights and dot-source this text - never the files again, which sit in
# a folder the normal user (and anything running as that user) can change while VELOX runs.
function Get-VxCoreSources {
    $ctx = $global:VxCtx
    if ($ctx.ContainsKey('CoreSources') -and $null -ne $ctx.CoreSources -and @($ctx.CoreSources).Count -gt 0) { return @($ctx.CoreSources) }
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($f in @(Get-VxCoreFiles)) { $list.Add([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)) }
    $ctx.CoreSources = $list.ToArray()
    return @($ctx.CoreSources)
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

# ------------------------------------------------------------------ worker runspace

function New-VxWorkerRunspace {
    $ctx = $global:VxCtx
    $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    if ($ctx.Windows) {
        try { $iss.ExecutionPolicy = [Microsoft.PowerShell.ExecutionPolicy]::Bypass } catch { $null = $_ }
    }
    $rs = [runspacefactory]::CreateRunspace($iss)
    if ($ctx.Windows) {
        # STA for the file dialog and COM-based Windows APIs
        try { $rs.ApartmentState = [System.Threading.ApartmentState]::STA } catch { $null = $_ }
    }
    # every job runs on the same thread: COM objects and loaded types behave the same each time
    try { $rs.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread } catch { $null = $_ }
    $rs.Open()
    return $rs
}

# Script every invocation in the worker starts with: the core text is dot-sourced only once per
# runspace ($global:VxCoreLoaded), after that a job starts in a few milliseconds.
function Get-VxWorkerBootstrap {
    return @'
param($ctx, $job, $sources)
if (-not $global:VxCoreLoaded) {
    foreach ($src in $sources) { . ([scriptblock]::Create($src)) }
    Initialize-VxRuntime
    $global:VxCoreLoaded = $true
}
$global:VxCtx = $ctx
if ($null -eq $job) {
    $global:VxJob = $null
    Initialize-VxWorkerWarm
    return
}
$global:VxJob = $job
Invoke-VxJobBody
'@
}

# Runs once in a fresh worker while VELOX is idle: things the first job would otherwise pay for.
function Initialize-VxWorkerWarm {
    # tests: a slow warm-up (to exercise jobs that queue behind it)
    $delay = [int](Get-VxProp $global:VxCtx 'TestWarmupDelayMs' 0)
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
    if ($global:VxCtx.Windows -and -not $global:VxCtx.Simulate) {
        try { $null = Initialize-VxServiceNative } catch { $null = $_ }
    }
}

# Disposes a worker that is no longer the current one (waits for a running warm-up to end first).
function Close-VxWorker($Worker) {
    if ($null -eq $Worker) { return }
    if ($null -ne $Worker.handle -and -not $Worker.handle.IsCompleted) {
        if ($null -eq $global:VxRetiredWorkers) { $global:VxRetiredWorkers = New-Object System.Collections.ArrayList }
        [void]$global:VxRetiredWorkers.Add($Worker)
        return
    }
    try { if ($null -ne $Worker.ps) { $Worker.ps.Dispose() } } catch { $null = $_ }
    try { $Worker.rs.Close(); $Worker.rs.Dispose() } catch { $null = $_ }
}

# The worker for the next job: the warm one when it is idle and healthy, otherwise a new one.
# Never waits. -KeepWarming: a worker that is still loading the core (pre-warm at startup) is
# returned as it is - the caller queues the job behind the warm-up (Start-VxJob), which is never
# slower than loading everything again in a fresh runspace. Without it, or when the warm-up takes
# implausibly long, that worker is retired and a fresh one is used.
function Test-VxWorkerWarming($Worker) {
    if ($null -eq $Worker -or -not $Worker.warming -or $null -eq $Worker.handle) { return $false }
    return (-not $Worker.handle.IsCompleted)
}

function Get-VxWorker([switch]$KeepWarming) {
    $w = $global:VxWorker
    if ($null -ne $w) {
        $ok = $false
        $busyOk = ($null -eq $w.handle -or $w.handle.IsCompleted)
        if (-not $busyOk -and $KeepWarming -and (Test-VxWorkerWarming $w) -and $null -ne $w.warmStart -and ([DateTime]::UtcNow - [DateTime]$w.warmStart).TotalSeconds -lt 30) { $busyOk = $true }
        try { $ok = (-not $w.broken -and $w.rs.RunspaceStateInfo.State -eq [System.Management.Automation.Runspaces.RunspaceState]::Opened -and $busyOk) } catch { $ok = $false }
        if ($ok -and (Test-VxWorkerWarming $w)) { return $w }
        # a finished warm-up is collected here; a failed one retires the worker
        if ($ok -and $null -ne $w.ps -and $w.warming) { $ok = Complete-VxWarmup $w }
        if ($ok) { return $w }
        $global:VxWorker = $null
        Close-VxWorker $w
    }
    $w = @{ rs = (New-VxWorkerRunspace); ps = $null; handle = $null; broken = $false; jobs = 0; created = [DateTime]::UtcNow }
    $global:VxWorker = $w
    return $w
}

# Called from the server loop while no job runs: make sure a warm worker is waiting.
function Start-VxWorkerWarmup {
    $ctx = $global:VxCtx
    if ($null -ne $global:VxWorker -or (Test-VxBusy) -or $null -eq $ctx.Catalog) { return }
    if ($global:VxWarmupFailed) { return }
    try {
        $w = Get-VxWorker
        $ps = [PowerShell]::Create()
        $ps.Runspace = $w.rs
        $null = $ps.AddScript((Get-VxWorkerBootstrap)).AddArgument($ctx).AddArgument($null).AddArgument((Get-VxCoreSources))
        $w.ps = $ps
        $w.warming = $true
        $w.warmStart = [DateTime]::UtcNow
        $w.handle = $ps.BeginInvoke()
    } catch {
        Write-VxFileLog 'warn' ('Hintergrund-Arbeiter konnte nicht vorbereitet werden: ' + $_.Exception.Message)
        $global:VxWorker = $null
        $global:VxWarmupFailed = $true
    }
}

# Starts a job. Returns @{ jobId } or @{ busy = $true; jobId } when another job runs.
function Start-VxJob([string]$Type, $Params) {
    $ctx = $global:VxCtx
    if (Test-VxBusy) { return @{ busy = $true; jobId = $ctx.CurrentJobId; type = [string]$ctx.Jobs[$ctx.CurrentJobId].type } }
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
            # skippable: a step that may be skipped is running (restore point, reset command); skip: the user asked
            skippable = $false; skip = $false; durationMs = $null; startTicks = [DateTime]::UtcNow.Ticks
        })
    $ctx.Jobs[$id] = $job
    $ctx.CurrentJobId = $id
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $reused = $false
    $how = ''
    try {
        $w = Get-VxWorker -KeepWarming
        $reused = ($w.jobs -gt 0 -or $null -ne $w.warmed -or $w.warming)
        if (Test-VxWorkerWarming $w) {
            # the worker is still loading the core (startup pre-warm): the job starts right after
            # it in Update-VxJobs (server loop, at most 250 ms later) instead of loading it twice
            (Get-VxJobHandles)[$id] = @{ ps = $null; rs = $w.rs; handle = $null; worker = $w; deferred = $true }
            $how = 'wartet auf den vorbereiteten Arbeiter'
        } else {
            Start-VxJobInvoke $job $w
        }
    } catch {
        $job.status = 'error'
        $job.error = 'Hintergrundaufgabe konnte nicht gestartet werden: ' + $_.Exception.Message
        $job.finished = Get-VxNowIso
        if ($null -ne $global:VxWorker) { $global:VxWorker.broken = $true }
    }
    if (-not $how) {
        $how = 'neuer Arbeiter'
        if ($reused) { $how = 'Arbeiter wiederverwendet' }
    }
    Write-VxLog 'info' ("Job {0} ({1}) gestartet ({2}, {3} ms)" -f $id, $Type, $how, $sw.ElapsedMilliseconds)
    return @{ jobId = $id }
}

# Runs a job on the given (idle) worker.
function Start-VxJobInvoke($Job, $Worker) {
    $ctx = $global:VxCtx
    $Worker.jobs++
    $ps = [PowerShell]::Create()
    $ps.Runspace = $Worker.rs
    $null = $ps.AddScript((Get-VxWorkerBootstrap)).AddArgument($ctx).AddArgument($Job).AddArgument((Get-VxCoreSources))
    $Worker.ps = $ps
    $Worker.jobId = $Job.id
    $Worker.warming = $false
    $handle = $ps.BeginInvoke()
    $Worker.handle = $handle
    (Get-VxJobHandles)[$Job.id] = @{ ps = $ps; rs = $Worker.rs; handle = $handle; worker = $Worker }
}

# Ends a finished warm-up invocation; $false when the warm-up failed (the worker is then broken).
function Complete-VxWarmup($Worker) {
    $Worker.warming = $false
    $ok = $true
    try { $null = $Worker.ps.EndInvoke($Worker.handle); $Worker.warmed = [DateTime]::UtcNow } catch {
        Write-VxFileLog 'warn' ('Hintergrund-Arbeiter: ' + $_.Exception.Message)
        $Worker.broken = $true
        $ok = $false
    }
    try { $Worker.ps.Dispose() } catch { $null = $_ }
    $Worker.ps = $null; $Worker.handle = $null
    return $ok
}

# Jobs queued behind a warm-up: start them once it ended (or on a fresh worker when it failed or
# took longer than 30 s).
function Start-VxDeferredJobs {
    $ctx = $global:VxCtx
    $handles = Get-VxJobHandles
    foreach ($id in @($handles.Keys)) {
        $h = $handles[$id]
        if (-not $h.deferred) { continue }
        $job = $ctx.Jobs[$id]
        $w = $h.worker
        if ($null -ne $job -and $job.cancel) {
            $job.status = 'cancelled'; $job.error = 'Abgebrochen.'; $job.step = 'Abgebrochen'; $job.finished = Get-VxNowIso
            $handles.Remove($id)
            continue
        }
        $age = 0
        if ($null -ne $w.warmStart) { $age = ([DateTime]::UtcNow - [DateTime]$w.warmStart).TotalSeconds }
        if ((Test-VxWorkerWarming $w) -and $age -lt 30) { continue }
        $handles.Remove($id)
        try {
            $healthy = $true
            if (Test-VxWorkerWarming $w) {
                Write-VxFileLog 'warn' 'Hintergrund-Arbeiter braucht zu lange zum Vorbereiten - nehme einen neuen.'
                $healthy = $false
            } elseif ($w.warming) { $healthy = Complete-VxWarmup $w }
            if (-not $healthy) {
                $w.broken = $true
                if ($global:VxWorker -eq $w) { $global:VxWorker = $null }
                Close-VxWorker $w
                $w = Get-VxWorker
            }
            if ($null -ne $job -and $job.status -eq 'running') { Start-VxJobInvoke $job $w }
        } catch {
            if ($null -ne $job) {
                $job.status = 'error'
                $job.error = 'Hintergrundaufgabe konnte nicht gestartet werden: ' + $_.Exception.Message
                $job.finished = Get-VxNowIso
            }
            if ($null -ne $global:VxWorker) { $global:VxWorker.broken = $true }
        }
    }
}

# Asks the running step of a job to stop (only while job.skippable). Returns $true when asked.
function Skip-VxJobStep([string]$Id) {
    $job = $global:VxCtx.Jobs[$Id]
    if ($null -eq $job -or $job.status -ne 'running' -or -not $job.skippable) { return $false }
    $job.skip = $true
    Add-VxJobLog $job 'warn' 'Überspringen angefordert ...'
    return $true
}

# Runs inside the job runspace.
function Invoke-VxJobBody {
    $job = $global:VxJob
    $p = $job.params
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # Power plan, BCD, feature and app lists may have changed outside VELOX since the last job
    # (Windows settings, another tool): every job starts from fresh reads.
    try { $global:VxCtx.Cache.Clear() } catch { $null = $_ }
    # per-job state of the reused worker runspace
    $global:VxLogBuffer = New-Object System.Collections.Generic.List[string]
    $global:VxOpenJournals = New-Object System.Collections.ArrayList
    $global:VxTaskService = $null
    $global:VxTaskServiceFailed = $false
    try {
        $r = $null
        switch ($job.type) {
            'scan' { $r = Invoke-VxScanJob $p }
            'apply' { $r = Invoke-VxApplyJob $p 'apply' }
            'revert' { $r = Invoke-VxApplyJob $p 'revert' }
            'restorepoint' { $r = Invoke-VxManualRestorePointJob $p }
            'restorepoint-list' { $r = Invoke-VxRestorePointListJob $p }
            'restorepoint-clean' { $r = Invoke-VxRestorePointCleanJob $p }
            'restore' { $r = Invoke-VxRestoreJob $p }
            'detweak-scan' { $r = Invoke-VxDetweakScanJob $p }
            'detweak' { $r = Invoke-VxDetweakJob $p }
            'advisor' { $r = Invoke-VxAdvisorJob $p }
            'claude' { $r = Invoke-VxClaudeJob $p }
            'ai' { $r = Invoke-VxAiJob $p }
            'ai-status' { $r = Invoke-VxAiStatusJob $p }
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
        try { Complete-VxPowerChanges } catch { Write-VxLog 'warn' ('Energieplan konnte nicht neu aktiviert werden: ' + $_.Exception.Message) }
        $ms = [int]$sw.ElapsedMilliseconds
        if ($r -is [System.Collections.IDictionary]) { $r['durationMs'] = $ms }
        elseif ($r -is [System.Management.Automation.PSCustomObject]) { $r | Add-Member -NotePropertyName 'durationMs' -NotePropertyValue $ms -Force }
        $job.durationMs = $ms
        $job.result = $r
        $job.progress = 1.0
        if (-not $job.step -or $job.step -eq 'Starte ...') { $job.step = 'Fertig' }
        $job.status = 'done'
    } catch {
        $msg = [string]$_.Exception.Message
        try { Complete-VxPowerChanges } catch { $null = $_ }
        if ($job.cancel -or $msg -eq 'VX_CANCELLED') {
            $job.error = 'Abgebrochen.'
            $job.step = 'Abgebrochen'
            Add-VxJobLog $job 'warn' 'Vom Benutzer abgebrochen.'
            $job.status = 'cancelled'
        } else {
            # the user sees the message only; the stack trace goes to the log file in the data root
            $job.error = Remove-VxStackText $msg
            Add-VxJobLog $job 'error' $msg
            try { Write-VxFileLog 'error' ("Job {0} fehlgeschlagen: {1} | {2}" -f $job.type, $msg, $_.ScriptStackTrace) } catch { $null = $_ }
            $job.status = 'error'
        }
    } finally {
        # a journal left open by an error path is closed (its .journal file stays as "unterbrochen")
        foreach ($jr in @($global:VxOpenJournals)) { try { Close-VxJournalStream $jr } catch { $null = $_ } }
        if ((Get-VxMutatingJobTypes) -contains [string]$job.type) { $global:VxCtx.ChangeGen = [int]$global:VxCtx.ChangeGen + 1 }
        if ($null -eq $job.durationMs) { $job.durationMs = [int]$sw.ElapsedMilliseconds }
        Write-VxFileLog 'info' ("Job {0} ({1}) beendet: {2} nach {3} ms" -f $job.id, $job.type, $job.status, $job.durationMs)
        try { Flush-VxFileLog } catch { $null = $_ }
        $global:VxLogBuffer = $null
        $global:VxTaskService = $null
        $job.finished = Get-VxNowIso
    }
}

# Ends finished job invocations (the worker runspace stays open for the next job); marks jobs whose
# runspace died as error and retires that runspace. Called by the server loop, which also gets a
# warm worker ready here while VELOX is idle.
function Update-VxJobs {
    $ctx = $global:VxCtx
    Start-VxDeferredJobs
    $handles = Get-VxJobHandles
    foreach ($id in @($handles.Keys)) {
        $h = $handles[$id]
        if ($h.deferred -or $null -eq $h.handle -or -not $h.handle.IsCompleted) { continue }
        $job = $ctx.Jobs[$id]
        $crashed = $false
        try { $null = $h.ps.EndInvoke($h.handle) } catch {
            $crashed = $true
            Write-VxFileLog 'error' ('Job-Runspace: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace)
            if ($null -ne $job -and $job.status -eq 'running') { $job.error = Remove-VxStackText ('Interner Fehler: ' + $_.Exception.Message) }
        }
        if ($null -ne $job -and $job.status -eq 'running') {
            $crashed = $true
            $errs = @($h.ps.Streams.Error | ForEach-Object { [string]$_ })
            foreach ($e in @($h.ps.Streams.Error)) { Write-VxFileLog 'error' ('Job-Runspace: ' + [string]$e + ' | ' + [string]$e.ScriptStackTrace) }
            if (-not $job.error) {
                $job.error = 'Die Hintergrundaufgabe wurde unerwartet beendet.'
                if ($errs.Count -gt 0) { $job.error += ' ' + (Remove-VxStackText $errs[0]) }
            }
            $job.status = 'error'
            $job.finished = Get-VxNowIso
        }
        try { $h.ps.Dispose() } catch { $null = $_ }
        $w = $h.worker
        if ($null -ne $w) {
            if ($w.ps -eq $h.ps) { $w.ps = $null; $w.handle = $null }
            try { if ($w.rs.RunspaceStateInfo.State -ne [System.Management.Automation.Runspaces.RunspaceState]::Opened) { $crashed = $true } } catch { $crashed = $true }
            if ($crashed) {
                # only a crashed worker is replaced; the next job (or the idle warm-up) creates a new one
                $w.broken = $true
                if ($global:VxWorker -eq $w) { $global:VxWorker = $null }
                Close-VxWorker $w
            }
        } else {
            try { $h.rs.Close(); $h.rs.Dispose() } catch { $null = $_ }
        }
        $handles.Remove($id)
    }
    # warm-up finished: keep the worker, remember it is warm
    $cw = $global:VxWorker
    if ($null -ne $cw -and $cw.warming -and $null -ne $cw.handle -and $cw.handle.IsCompleted) {
        if (-not (Complete-VxWarmup $cw)) { $global:VxWorker = $null; Close-VxWorker $cw }
    }
    if ($null -ne $global:VxRetiredWorkers -and $global:VxRetiredWorkers.Count -gt 0) {
        foreach ($rw in @($global:VxRetiredWorkers.ToArray())) {
            if ($null -eq $rw.handle -or $rw.handle.IsCompleted) {
                $global:VxRetiredWorkers.Remove($rw)
                $rw.handle = $null
                Close-VxWorker $rw
            }
        }
    }
    if ($null -ne $ctx.Life) { Start-VxWorkerWarmup }
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
    # jobs still queued behind a warm-up never started: nothing to wait for
    foreach ($id in @($handles.Keys)) {
        if (-not $handles[$id].deferred) { continue }
        $j = $ctx.Jobs[$id]
        if ($null -ne $j -and $j.status -eq 'running') { $j.status = 'cancelled'; $j.error = 'Abgebrochen.'; $j.step = 'Abgebrochen'; $j.finished = Get-VxNowIso }
        $handles.Remove($id)
    }
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
    # the idle worker and retired warm-ups
    $all = New-Object System.Collections.ArrayList
    if ($null -ne $global:VxWorker) { [void]$all.Add($global:VxWorker) }
    if ($null -ne $global:VxRetiredWorkers) { foreach ($rw in @($global:VxRetiredWorkers.ToArray())) { [void]$all.Add($rw) } }
    $global:VxWorker = $null
    $global:VxRetiredWorkers = $null
    foreach ($w in $all) {
        try { if ($null -ne $w.ps -and $null -ne $w.handle -and -not $w.handle.IsCompleted) { $w.ps.Stop() } } catch { $null = $_ }
        try { if ($null -ne $w.ps) { $w.ps.Dispose() } } catch { $null = $_ }
        try { $w.rs.Close(); $w.rs.Dispose() } catch { $null = $_ }
    }
}

# Job object as sent to the UI. Log entries with i >= $Since.
function Get-VxJobDto($Job, [int]$Since = 0) {
    $entries = @()
    [System.Threading.Monitor]::Enter($Job.lockObj)
    try { $entries = @($Job.log | Where-Object { [int]$_.i -ge $Since }) }
    finally { [System.Threading.Monitor]::Exit($Job.lockObj) }
    $dur = $Job.durationMs
    if ($null -eq $dur -and $Job.ContainsKey('startTicks')) { $dur = [int](([DateTime]::UtcNow.Ticks - [long]$Job.startTicks) / 10000) }
    return [ordered]@{
        id = $Job.id; type = $Job.type; status = $Job.status; progress = [double]$Job.progress; step = [string]$Job.step
        log = $entries; result = $Job.result; error = $Job.error
        skippable = [bool]$Job.skippable; durationMs = $dur
    }
}
