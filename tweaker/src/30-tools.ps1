# ------------------------------------------------------------------ Werkzeuge: System-Info, Sicherung, Aufraeumen, Ping

$script:RestorePointCreated = $false

function Get-TWSystemInfo {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
    $gpus = @(Get-CimInstance -ClassName Win32_VideoController |
            Where-Object { $_.Name -notmatch 'Basic|Remote|Virtual|Parsec|Meta' } |
            ForEach-Object { $_.Name.Trim() })
    $drive = Get-PSDrive -Name $env:SystemDrive.TrimEnd(':')
    $isLaptop = Test-TWIsLaptop
    [pscustomobject]@{
        Windows = '{0} (Build {1})' -f $os.Caption.Replace('Microsoft ', ''), $os.BuildNumber
        CPU     = $cpu.Name.Trim()
        GPU     = $(if ($gpus) { $gpus -join ' + ' } else { 'unbekannt' })
        RAM     = '{0:N0} GB' -f ($os.TotalVisibleMemorySize / 1MB)
        Disk    = '{0:N0} GB frei von {1:N0} GB' -f ($drive.Free / 1GB), (($drive.Used + $drive.Free) / 1GB)
        Device  = $(if ($isLaptop) { 'Laptop' } else { 'Desktop-PC' })
        Laptop  = $isLaptop
    }
}

function New-TWRestorePoint {
    # Windows erlaubt normalerweise nur einen Wiederherstellungspunkt pro 24 Stunden.
    # Die Sperre wird kurz aufgehoben und danach wieder auf den alten Wert gesetzt.
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'
    $old = Get-TWRegValue -Path $key -Name 'SystemRestorePointCreationFrequency'
    try {
        Enable-ComputerRestore -Drive "$env:SystemDrive\" -ErrorAction Stop
        Set-TWRegValue -Path $key -Name 'SystemRestorePointCreationFrequency' -Type 'DWord' -Value 0
        Checkpoint-Computer -Description "$script:AppName Sicherung" -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
        $script:RestorePointCreated = $true
        Write-TWLog 'Wiederherstellungspunkt erstellt.' Ok
        return $true
    } catch {
        Write-TWLog "Wiederherstellungspunkt fehlgeschlagen: $($_.Exception.Message)" Error
        return $false
    } finally {
        if ($old) { Set-TWRegValue -Path $key -Name 'SystemRestorePointCreationFrequency' -Type $old.Type -Value $old.Value }
        else { Remove-TWRegValue -Path $key -Name 'SystemRestorePointCreationFrequency' }
    }
}

# --- Aufraeumen -----------------------------------------------------------------------------

function Test-TWSafeTempDir {
    # Sicherheitsnetz: nur Ordner, die wirklich "Temp" heissen und kein Laufwerk sind.
    # Falls TEMP auf C:\ oder den Benutzerordner zeigt, wird NICHTS geloescht.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $trimmed = $Path.TrimEnd('\', '/')
    if ($trimmed -match '^[A-Za-z]:$') { return $false }
    return ((($trimmed -split '[\\/]')[-1]) -eq 'Temp')
}

function Get-TWTempTargets {
    $candidates = @($env:TEMP, (Join-Path $env:SystemRoot 'Temp'))
    @($candidates | Where-Object { (Test-TWSafeTempDir $_) -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
}

function Clear-TWTemp {
    param([int]$MinAgeHours = 24, [switch]$RecycleBin)
    $cutoff = (Get-Date).AddHours(-$MinAgeHours)
    $freed = 0L
    $deleted = 0
    $skipped = 0
    foreach ($dir in Get-TWTempTargets) {
        Write-TWLog "Räume auf: $dir"
        Update-TWUi
        $files = Get-ChildItem -LiteralPath $dir -Recurse -Force -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cutoff }
        foreach ($f in $files) {
            try {
                $size = $f.Length
                Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
                $freed += $size
                $deleted++
            } catch { $skipped++ }   # Datei wird gerade benutzt - das ist normal
            if ((($deleted + $skipped) % 250) -eq 0) { Update-TWUi }
        }
        # Leere Unterordner entfernen (tiefste zuerst)
        Get-ChildItem -LiteralPath $dir -Recurse -Force -Directory -ErrorAction SilentlyContinue |
            Sort-Object { $_.FullName.Length } -Descending |
            ForEach-Object {
                if (-not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue)) {
                    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
                }
            }
    }
    if ($RecycleBin) { Clear-RecycleBin -Force -ErrorAction SilentlyContinue }
    [pscustomobject]@{ FreedMB = [math]::Round($freed / 1MB, 1); Files = $deleted; Skipped = $skipped }
}

# --- Netzwerk -------------------------------------------------------------------------------
# Gemessen wird die TCP-Verbindungszeit zu Rechenzentren, in denen viele Spieleserver stehen.
# Das funktioniert auch dort, wo Ping (ICMP) blockiert ist, und entspricht etwa einem Ping.

$script:PingTargets = @(
    @{ Name = 'Frankfurt (EU Zentral)'; Host = 'ec2.eu-central-1.amazonaws.com' }
    @{ Name = 'Irland (EU West)'; Host = 'ec2.eu-west-1.amazonaws.com' }
    @{ Name = 'Stockholm (EU Nord)'; Host = 'ec2.eu-north-1.amazonaws.com' }
    @{ Name = 'Virginia (US Ost)'; Host = 'ec2.us-east-1.amazonaws.com' }
    @{ Name = 'Cloudflare (nächster Knoten)'; Host = '1.1.1.1' }
)

function Get-TWLatencyStats {
    param([double[]]$Samples, [int]$Lost)
    $total = $Samples.Count + $Lost
    if ($Samples.Count -eq 0) {
        return [pscustomobject]@{ Avg = $null; Min = $null; Max = $null; Jitter = $null; LossPct = 100; Rating = 'Keine Verbindung' }
    }
    $jitter = 0.0
    if ($Samples.Count -gt 1) {
        $diffs = for ($i = 1; $i -lt $Samples.Count; $i++) { [math]::Abs($Samples[$i] - $Samples[$i - 1]) }
        $jitter = ($diffs | Measure-Object -Average).Average
    }
    $avg = ($Samples | Measure-Object -Average).Average
    $rating = 'Hoch'
    if ($avg -lt 30) { $rating = 'Sehr gut' } elseif ($avg -lt 60) { $rating = 'Gut' } elseif ($avg -lt 100) { $rating = 'OK' }
    [pscustomobject]@{
        Avg     = [math]::Round($avg, 0)
        Min     = [math]::Round(($Samples | Measure-Object -Minimum).Minimum, 0)
        Max     = [math]::Round(($Samples | Measure-Object -Maximum).Maximum, 0)
        Jitter  = [math]::Round($jitter, 0)
        LossPct = [math]::Round(100 * $Lost / $total, 0)
        Rating  = $rating
    }
}

function Measure-TWLatency {
    param([string]$HostName, [int]$Port = 443, [int]$Count = 6, [int]$TimeoutMs = 1500)
    try {
        # Einmal vorher aufloesen, damit die DNS-Zeit nicht mitgemessen wird
        $ip = [System.Net.Dns]::GetHostAddresses($HostName) |
            Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
            Select-Object -First 1
    } catch { $ip = $null }
    if (-not $ip) { return Get-TWLatencyStats -Samples @() -Lost $Count }

    $samples = New-Object System.Collections.Generic.List[double]
    $lost = 0
    for ($i = 0; $i -lt $Count; $i++) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $task = $client.ConnectAsync($ip, $Port)
            if ($task.Wait($TimeoutMs) -and $client.Connected) { $samples.Add($sw.Elapsed.TotalMilliseconds) }
            else { $lost++ }
        } catch { $lost++ }
        finally { $client.Close() }
        Update-TWUi
    }
    return Get-TWLatencyStats -Samples $samples.ToArray() -Lost $lost
}

function Clear-TWDnsCache {
    Clear-DnsClientCache
    Write-TWLog 'DNS-Cache geleert.' Ok
}
