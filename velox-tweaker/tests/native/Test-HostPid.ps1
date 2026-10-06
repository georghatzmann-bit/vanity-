<#
.SYNOPSIS
    Checks the VELOX.exe <-> Velox.ps1 contract in simulate mode (runs on Linux with pwsh 7, and on Windows):
    - "-NoBrowser -Port 0 -HostPid <pid>" prints "VELOX_READY http://127.0.0.1:<port>/?t=<token>"
    - the backend answers /api/bootstrap and POST /api/heartbeat (busy check before closing) with that token
    - the backend ends by itself a few seconds after the host process is gone
    - POST /api/shutdown?t=<token> (what VELOX.exe sends on close) is accepted
.EXAMPLE
    pwsh velox-tweaker/tests/native/Test-HostPid.ps1
#>
[CmdletBinding()]
param()

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $root 'Velox.ps1'
$fails = 0
function Check([bool]$Ok, [string]$What) {
    if ($Ok) { Write-Host ('  ok    ' + $What) } else { Write-Host ('  FAIL  ' + $What) -ForegroundColor Red; $script:fails++ }
}

$psExe = (Get-Process -Id $PID).Path

function Start-Backend([int]$HostPid, [string]$DataDir) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -Simulate -NoBrowser -Port 0 -HostPid ' + $HostPid
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['VELOX_DATA_DIR'] = $DataDir
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    return $p
}

# stands in for VELOX.exe: any process whose life we control
function Start-FakeHost {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 120"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    return [Diagnostics.Process]::Start($psi)
}

function Wait-Ready($Proc, [int]$TimeoutSec) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    $task = $Proc.StandardOutput.ReadLineAsync()
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($task.Wait(250)) {
            $line = $task.Result
            if ($null -eq $line) { return $null }
            if ($line -match '^VELOX_READY (\S+)') { return $Matches[1] }
            $task = $Proc.StandardOutput.ReadLineAsync()
        }
    }
    return $null
}

function Get-Origin([string]$Url) { $u = [Uri]$Url; return ('{0}://{1}:{2}/' -f $u.Scheme, $u.Host, $u.Port) }
function Get-Token([string]$Url) { if ($Url -match '[?&]t=([0-9A-Za-z]+)') { return $Matches[1] } return '' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('velox-hostpid-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $tmp -Force

Write-Host 'Host-PID: backend ends when the host is gone'
$hostProc = Start-FakeHost
$be = Start-Backend $hostProc.Id (Join-Path $tmp 'a')
$url = Wait-Ready $be 60
Check ($null -ne $url) ('VELOX_READY line: ' + $url)
if ($url) {
    $u = [Uri]$url
    Check ($u.Host -eq '127.0.0.1' -and $u.Port -gt 0 -and (Get-Token $url)) 'url is http://127.0.0.1:<port>/?t=<token>'
    try {
        $r = Invoke-RestMethod -Uri ((Get-Origin $url) + 'api/bootstrap') -Headers @{ 'X-Velox-Token' = (Get-Token $url) } -TimeoutSec 10
        Check ($null -ne $r -and $r.PSObject.Properties.Name -contains 'busy') '/api/bootstrap answers with "busy"'
    } catch { Check $false ('/api/bootstrap: ' + $_.Exception.Message) }
    # what VELOX.exe asks before it closes (Backend.IsBusy): a cheap POST /api/heartbeat, no session id
    try {
        $raw = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ((Get-Origin $url) + 'api/heartbeat') -Headers @{ 'X-Velox-Token' = (Get-Token $url) } -Body '' -TimeoutSec 10
        Check ([string]$raw.Content -match '"busy"\s*:\s*(true|false)') ('POST /api/heartbeat answers with "busy" (the regex VELOX.exe uses): ' + [string]$raw.Content)
    } catch { Check $false ('/api/heartbeat: ' + $_.Exception.Message) }
}
Check (-not $be.HasExited) 'backend keeps running while the host lives'
Stop-Process -Id $hostProc.Id -Force
$sw = [Diagnostics.Stopwatch]::StartNew()
$ended = $be.WaitForExit(20000)
Check $ended ('backend ended by itself {0:N1} s after the host was gone' -f $sw.Elapsed.TotalSeconds)
if (-not $ended) { try { $be.Kill() } catch { $null = $_ } }

Write-Host 'Host-PID: shutdown request (VELOX.exe closing)'
$hostProc = Start-FakeHost
$be = Start-Backend $hostProc.Id (Join-Path $tmp 'b')
$url = Wait-Ready $be 60
Check ($null -ne $url) 'VELOX_READY again'
if ($url) {
    try {
        $r = Invoke-RestMethod -Method Post -Uri ((Get-Origin $url) + 'api/shutdown?t=' + (Get-Token $url)) -TimeoutSec 10
        Check ([bool]$r.ok) 'POST /api/shutdown?t=<token> accepted'
    } catch { Check $false ('/api/shutdown: ' + $_.Exception.Message) }
    $ended = $be.WaitForExit(20000)
    Check $ended 'backend ends after the shutdown request'
    if (-not $ended) { try { $be.Kill() } catch { $null = $_ } }
}
try { Stop-Process -Id $hostProc.Id -Force -ErrorAction Stop } catch { $null = $_ }
try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction Stop } catch { $null = $_ }

if ($fails -gt 0) { Write-Host ("FAILED: {0} check(s)" -f $fails) -ForegroundColor Red; exit 1 }
Write-Host 'Host-PID: all checks passed' -ForegroundColor Green
exit 0
