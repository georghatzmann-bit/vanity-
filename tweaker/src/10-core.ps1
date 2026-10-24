# ------------------------------------------------------------------ Kern: Log, Registry, Sicherung, Tweak-Engine

$script:Window = $null
$script:LogSink = $null   # von der Oberflaeche gesetzt: { param($Line, $Level) ... }

function Write-TWLog {
    param(
        [string]$Message,
        [ValidateSet('Info', 'Ok', 'Warn', 'Error')][string]$Level = 'Info'
    )
    $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
    if ($script:LogFile) {
        try { Add-Content -LiteralPath $script:LogFile -Value "[$Level] $line" -Encoding UTF8 -ErrorAction Stop } catch { }
    }
    if ($script:LogSink) { & $script:LogSink $line $Level } else { Write-Host $line }
}

function Update-TWUi {
    # Laesst die Oberflaeche kurz neu zeichnen, damit sie bei laengeren Aktionen nicht einfriert
    if ($script:Window) {
        $script:Window.Dispatcher.Invoke([action] {}, [System.Windows.Threading.DispatcherPriority]::Background)
    }
}

# --- Registry -------------------------------------------------------------------------------
# Eigene Wrapper statt Get-ItemProperty: keine Platzhalter-Probleme bei Namen wie "C:\Spiele\[x].exe"
# und immer die 64-Bit-Ansicht der Registry.

function Open-TWRegKey {
    param([string]$Path, [switch]$Writable, [switch]$Create)
    $hiveName, $subKey = $Path -split ':\\', 2
    $hive = switch ($hiveName) {
        'HKCU' { [Microsoft.Win32.RegistryHive]::CurrentUser }
        'HKLM' { [Microsoft.Win32.RegistryHive]::LocalMachine }
        default { throw "Unbekannter Registry-Pfad: $Path" }
    }
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
    if ($Create) { return $base.CreateSubKey($subKey) }
    return $base.OpenSubKey($subKey, [bool]$Writable)
}

function Get-TWRegValue {
    # Liefert $null, wenn Schluessel oder Wert fehlen, sonst ein Objekt mit Type und Value
    param([string]$Path, [string]$Name)
    $key = Open-TWRegKey -Path $Path
    if (-not $key) { return $null }
    try {
        if ($key.GetValueNames() -notcontains $Name) { return $null }
        [pscustomobject]@{
            Type  = $key.GetValueKind($Name).ToString()
            Value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        }
    } finally { $key.Close() }
}

function Get-TWRegValueNames {
    param([string]$Path)
    $key = Open-TWRegKey -Path $Path
    if (-not $key) { return @() }
    try { return @($key.GetValueNames() | Where-Object { $_ }) } finally { $key.Close() }
}

function Set-TWRegValue {
    param([string]$Path, [string]$Name, [string]$Type, $Value)
    $kind = [Microsoft.Win32.RegistryValueKind]$Type
    switch ($Type) {
        'DWord' { $Value = [int]$Value }
        'QWord' { $Value = [long]$Value }
        'Binary' { $Value = [byte[]]$Value }
        'MultiString' { $Value = [string[]]$Value }
        default { $Value = [string]$Value }
    }
    $key = Open-TWRegKey -Path $Path -Create
    try { $key.SetValue($Name, $Value, $kind) } finally { $key.Close() }
}

function Remove-TWRegValue {
    param([string]$Path, [string]$Name)
    $key = Open-TWRegKey -Path $Path -Writable
    if ($key) { try { $key.DeleteValue($Name, $false) } finally { $key.Close() } }
}

# --- Sicherung ------------------------------------------------------------------------------
# backup.json enthaelt pro Tweak-Id den Zustand VOR der ersten Aenderung.

function Get-TWBackup {
    $result = @{}
    if (-not (Test-Path -LiteralPath $script:BackupFile)) { return $result }
    $raw = Get-Content -LiteralPath $script:BackupFile -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $result }
    $obj = $raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $result[$p.Name] = $p.Value }
    return $result
}

function Save-TWBackup {
    param([hashtable]$Backup)
    $dir = Split-Path -Parent $script:BackupFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        # Windows PowerShell 5.1 schreibt Arrays sonst als {"value":[...],"Count":n}
        Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue
    }
    ConvertTo-Json -InputObject $Backup -Depth 8 | Set-Content -LiteralPath $script:BackupFile -Encoding UTF8
}

function Get-TWRegistryState {
    param($Tweak)
    , @(foreach ($r in $Tweak.Registry) {
            $cur = Get-TWRegValue -Path $r.Path -Name $r.Name
            [pscustomobject]@{
                Path    = $r.Path
                Name    = $r.Name
                Existed = [bool]$cur
                Type    = $(if ($cur) { $cur.Type } else { $r.Type })
                Value   = $(if ($cur) { $cur.Value } else { $null })
            }
        })
}

function Restore-TWRegistryState {
    param($State)
    foreach ($s in @($State)) {
        if (-not $s -or -not $s.Path) { continue }
        if ($s.Existed) { Set-TWRegValue -Path $s.Path -Name $s.Name -Type $s.Type -Value $s.Value }
        else { Remove-TWRegValue -Path $s.Path -Name $s.Name }
    }
}

# --- Tweak-Engine ---------------------------------------------------------------------------
# Ein Tweak ist eine Hashtable. Entweder mit Registry = @(@{ Path; Name; Type; On; Off }) -
# Off = $null heisst "Wert loeschen", Missing = Standard, wenn der Wert fehlt -
# oder mit eigenen Skriptbloecken Capture/Apply/Revert/Test.

function Test-TWValueEqual {
    param($Current, $Expected)
    if ($Current -is [array] -or $Expected -is [array]) { return ((@($Current) -join ',') -eq (@($Expected) -join ',')) }
    return ("$Current" -eq "$Expected")
}

function Test-TWTweak {
    param($Tweak)
    if ($Tweak.Test) { return [bool](& $Tweak.Test) }
    foreach ($r in $Tweak.Registry) {
        $cur = Get-TWRegValue -Path $r.Path -Name $r.Name
        if (-not $cur) {
            # Missing = Wert, von dem Windows ausgeht, wenn nichts eingetragen ist
            if ($r.ContainsKey('Missing') -and (Test-TWValueEqual $r.Missing $r.On)) { continue }
            return $false
        }
        if (-not (Test-TWValueEqual $cur.Value $r.On)) { return $false }
    }
    return $true
}

function Invoke-TWTweak {
    param($Tweak, [ValidateSet('Apply', 'Revert')][string]$Action)
    $backup = Get-TWBackup
    if ($Action -eq 'Apply') {
        if (-not $backup.ContainsKey($Tweak.Id)) {
            # Nur beim ersten Mal sichern, sonst wuerde der Original-Zustand ueberschrieben
            if ($Tweak.Capture) { $backup[$Tweak.Id] = & $Tweak.Capture }
            else { $backup[$Tweak.Id] = Get-TWRegistryState -Tweak $Tweak }
            Save-TWBackup -Backup $backup
        }
        if ($Tweak.Apply) { & $Tweak.Apply }
        else {
            foreach ($r in $Tweak.Registry) { Set-TWRegValue -Path $r.Path -Name $r.Name -Type $r.Type -Value $r.On }
        }
    } else {
        $saved = $null
        $hasBackup = $backup.ContainsKey($Tweak.Id)
        if ($hasBackup) { $saved = $backup[$Tweak.Id] }
        if ($Tweak.Revert) { & $Tweak.Revert $saved }
        elseif ($hasBackup) { Restore-TWRegistryState -State $saved }
        else {
            # Kein Backup (war schon vorher so eingestellt): auf den "Aus"-Zustand setzen
            foreach ($r in $Tweak.Registry) {
                if ($null -eq $r.Off) { Remove-TWRegValue -Path $r.Path -Name $r.Name }
                else { Set-TWRegValue -Path $r.Path -Name $r.Name -Type $r.Type -Value $r.Off }
            }
        }
        if ($hasBackup) {
            $backup.Remove($Tweak.Id)
            Save-TWBackup -Backup $backup
        }
    }
    if ($Tweak.After) { & $Tweak.After }
}

function Undo-TWAll {
    # Setzt alles zurueck, was in backup.json steht. Liefert die Zahl der Fehler.
    $errors = 0
    $backup = Get-TWBackup
    foreach ($id in @($backup.Keys)) {
        $tweak = $script:Tweaks | Where-Object { $_.Id -eq $id } | Select-Object -First 1
        try {
            if ($tweak) {
                Invoke-TWTweak -Tweak $tweak -Action Revert
                Write-TWLog "$($tweak.Name): zurückgesetzt" Ok
            } else {
                # z. B. Pro-Tweak, aber jetzt laeuft die Gratis-Version: Registry-Sicherung trotzdem anwenden
                Restore-TWRegistryState -State $backup[$id]
                $current = Get-TWBackup
                $current.Remove($id)
                Save-TWBackup -Backup $current
                Write-TWLog "$id`: zurückgesetzt" Ok
            }
        } catch {
            $errors++
            Write-TWLog "$id konnte nicht zurückgesetzt werden: $($_.Exception.Message)" Error
        }
    }
    return $errors
}
