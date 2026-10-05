# VELOX - core/System.ps1
# Low-level providers: registry, services, scheduled tasks, BCD, power plans, optional features, Appx.
# Each provider has a REAL implementation (Windows) and a SIMULATED one (docs/ARCHITECTURE.md section 6):
#   - simulate mode writes go to the overlay $VxCtx.Sim (persisted to sim-state.json)
#   - reads check the overlay first, then the real system (Windows) or a seeded default state (non-Windows)
# Only function definitions.

# No script-scope variables: core files are dot-sourced into different scopes (main script,
# job runspaces, tests), so constants live in small getter functions.

function Get-VxHiveName([string]$Name) {
    switch ($Name.ToUpperInvariant()) {
        'HKLM' { return 'HKLM' } 'HKEY_LOCAL_MACHINE' { return 'HKLM' }
        'HKCU' { return 'HKCU' } 'HKEY_CURRENT_USER' { return 'HKCU' }
        'HKCR' { return 'HKCR' } 'HKEY_CLASSES_ROOT' { return 'HKCR' }
        'HKU' { return 'HKU' } 'HKEY_USERS' { return 'HKU' }
        'HKCC' { return 'HKCC' } 'HKEY_CURRENT_CONFIG' { return 'HKCC' }
    }
    return $null
}

function Get-VxPlanBaseGuid([string]$Plan) {
    switch ($Plan) {
        'ultimate' { return 'e9a42b02-d5df-448d-aa00-03f14749eb61' }
        'high' { return '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c' }
        'balanced' { return '381b4222-f694-41f0-9685-ff5bb260df2e' }
    }
    return $null
}

# ================================================================== registry: path helpers

function Split-VxRegPath([string]$Path) {
    $p = $Path.Trim()
    while ($p.EndsWith('\')) { $p = $p.Substring(0, $p.Length - 1) }
    $idx = $p.IndexOf('\')
    $hive = $p
    $sub = ''
    if ($idx -ge 0) { $hive = $p.Substring(0, $idx); $sub = $p.Substring($idx + 1) }
    $hive = $hive.TrimEnd(':').ToUpperInvariant()
    $norm = Get-VxHiveName $hive
    if (-not $norm) { throw "Unbekannter Registry-Bereich in '$Path'" }
    return @{ Hive = $norm; Sub = $sub; Full = $(if ($sub) { $norm + '\' + $sub } else { $norm }) }
}

function Get-VxRegParent([string]$Path) {
    $i = $Path.LastIndexOf('\')
    if ($i -le 0) { return $null }
    return $Path.Substring(0, $i)
}

function Get-VxRegLeaf([string]$Path) {
    $i = $Path.LastIndexOf('\')
    if ($i -lt 0) { return $Path }
    return $Path.Substring($i + 1)
}

# ================================================================== registry: value conversion

function Get-VxTwo64 { return [decimal]::Parse('18446744073709551616', [Globalization.CultureInfo]::InvariantCulture) }

function ConvertTo-VxHex([byte[]]$Bytes) {
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
    return ([BitConverter]::ToString($Bytes)).Replace('-', '')
}

function ConvertFrom-VxHex([string]$Hex) {
    $h = ([string]$Hex) -replace '[\s,\-]', ''
    if ($h.Length % 2 -ne 0) { throw "Ungültiger Hex-Wert '$Hex'" }
    $bytes = New-Object byte[] ($h.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $bytes[$i] = [Convert]::ToByte($h.Substring($i * 2, 2), 16)
    }
    return , $bytes
}

# .NET registry value -> JSON-friendly representation.
function ConvertFrom-VxRegRaw($Raw, [string]$Kind) {
    switch ($Kind) {
        'DWord' {
            $n = [long]$Raw
            if ($n -lt 0) { $n = $n + 4294967296 }
            return $n
        }
        'QWord' {
            $n = [long]$Raw
            if ($n -lt 0) { return ([decimal]$n + (Get-VxTwo64)) }
            return $n
        }
        'MultiString' { return , ([string[]]@($Raw)) }
        'Binary' { return (ConvertTo-VxHex ([byte[]]$Raw)) }
        'None' { if ($Raw -is [byte[]]) { return (ConvertTo-VxHex $Raw) } return $null }
        default { return [string]$Raw }
    }
}

# JSON-friendly value -> object for RegistryKey.SetValue.
function ConvertTo-VxRegRaw($Value, [string]$Kind) {
    switch ($Kind) {
        'DWord' {
            $d = [decimal]$Value
            if ($d -lt -2147483648 -or $d -gt 4294967295) { throw "DWORD-Wert außerhalb des Bereichs: $Value" }
            if ($d -gt 2147483647) { $d = $d - [decimal]4294967296 }
            return [int]$d
        }
        'QWord' {
            $d = [decimal]$Value
            if ($d -gt [decimal][long]::MaxValue) { $d = $d - (Get-VxTwo64) }
            return [long]$d
        }
        'MultiString' { return , ([string[]]@($Value | ForEach-Object { [string]$_ })) }
        'Binary' { return , (ConvertFrom-VxHex ([string]$Value)) }
        default { return [string]$Value }
    }
}

function Get-VxRegKindEnum([string]$Kind) {
    switch ($Kind) {
        'DWord' { return [Microsoft.Win32.RegistryValueKind]::DWord }
        'QWord' { return [Microsoft.Win32.RegistryValueKind]::QWord }
        'String' { return [Microsoft.Win32.RegistryValueKind]::String }
        'ExpandString' { return [Microsoft.Win32.RegistryValueKind]::ExpandString }
        'MultiString' { return [Microsoft.Win32.RegistryValueKind]::MultiString }
        'Binary' { return [Microsoft.Win32.RegistryValueKind]::Binary }
    }
    throw "Unbekannter Registry-Typ '$Kind'"
}

# Compares two values of a registry kind. Numbers numerically, strings case-insensitively,
# MultiString element-wise, Binary as hex. $null only equals $null.
function Test-VxRegEqual([string]$Kind, $A, $B) {
    if ($null -eq $A -or $null -eq $B) { return ($null -eq $A -and $null -eq $B) }
    if ($Kind -eq 'MultiString' -or $A -is [array] -or $B -is [array]) {
        $x = @($A); $y = @($B)
        if ($x.Count -ne $y.Count) { return $false }
        for ($i = 0; $i -lt $x.Count; $i++) {
            if (-not [string]::Equals([string]$x[$i], [string]$y[$i], [StringComparison]::OrdinalIgnoreCase)) { return $false }
        }
        return $true
    }
    if ($Kind -eq 'DWord' -or $Kind -eq 'QWord') {
        $da = [decimal]0; $db = [decimal]0
        $inv = [Globalization.CultureInfo]::InvariantCulture
        $okA = [decimal]::TryParse([string]$A, [Globalization.NumberStyles]::Number, $inv, [ref]$da)
        $okB = [decimal]::TryParse([string]$B, [Globalization.NumberStyles]::Number, $inv, [ref]$db)
        if ($okA -and $okB) { return ($da -eq $db) }
    }
    if ($Kind -eq 'Binary') {
        return [string]::Equals((([string]$A) -replace '[\s,\-]', ''), (([string]$B) -replace '[\s,\-]', ''), [StringComparison]::OrdinalIgnoreCase)
    }
    return [string]::Equals([string]$A, [string]$B, [StringComparison]::OrdinalIgnoreCase)
}

# Display text for the UI (detweak "current"/"default").
function Format-VxRegValue($Value, [string]$Kind, [bool]$Exists = $true) {
    if (-not $Exists -or $null -eq $Value) { return 'nicht gesetzt' }
    switch ($Kind) {
        'DWord' { return ('{0} (0x{1})' -f $Value, ([uint32][decimal]$Value).ToString('X')) }
        'MultiString' { return ((@($Value) | ForEach-Object { [string]$_ }) -join ', ') }
        default { return [string]$Value }
    }
}

# ================================================================== registry: REAL (.NET, Registry64)

function Get-VxBaseKey([string]$Hive) {
    $h = switch ($Hive) {
        'HKLM' { [Microsoft.Win32.RegistryHive]::LocalMachine }
        'HKCU' { [Microsoft.Win32.RegistryHive]::CurrentUser }
        'HKCR' { [Microsoft.Win32.RegistryHive]::ClassesRoot }
        'HKU' { [Microsoft.Win32.RegistryHive]::Users }
        'HKCC' { [Microsoft.Win32.RegistryHive]::CurrentConfig }
    }
    return [Microsoft.Win32.RegistryKey]::OpenBaseKey($h, [Microsoft.Win32.RegistryView]::Registry64)
}

# Hive + subkey a path really lives in. When VELOX runs elevated as another account than the
# desktop user (Get-VxDesktopUser), HKCU means the DESKTOP user's hive: HKU\<SID> (and its
# Software\Classes part HKU\<SID>_Classes) - not the hive of the account that typed the password.
function Resolve-VxRealRegTarget([string]$Path) {
    $sp = Split-VxRegPath $Path
    $du = $global:VxCtx.DesktopUser
    if ($sp.Hive -eq 'HKCU' -and $null -ne $du -and $du.sid) {
        $sub = [string]$sp.Sub
        $sid = [string]$du.sid
        if ($sub -match '^(?i)Software\\Classes(\\(.*))?$') {
            $rest = $Matches[2]
            $t = $sid + '_Classes'
            if ($rest) { $t = $t + '\' + $rest }
            return @{ Hive = 'HKU'; Sub = $t }
        }
        if ($sub) { return @{ Hive = 'HKU'; Sub = ($sid + '\' + $sub) } }
        return @{ Hive = 'HKU'; Sub = $sid }
    }
    return @{ Hive = $sp.Hive; Sub = $sp.Sub }
}

# Opens a key; returns $null when it does not exist (and -Create is not given).
function Open-VxRealKey([string]$Path, [bool]$Writable = $false, [bool]$Create = $false) {
    $sp = Resolve-VxRealRegTarget $Path
    $base = Get-VxBaseKey $sp.Hive
    if ([string]::IsNullOrEmpty($sp.Sub)) { return $base }
    try {
        if ($Create) { return $base.CreateSubKey($sp.Sub) }
        return $base.OpenSubKey($sp.Sub, $Writable)
    } finally { $base.Close() }
}

function Get-VxRealRegValue([string]$Path, [string]$Name) {
    $k = Open-VxRealKey $Path $false $false
    if ($null -eq $k) { return @{ exists = $false; kind = $null; value = $null } }
    try {
        $kindEnum = $null
        try { $kindEnum = $k.GetValueKind($Name) } catch { return @{ exists = $false; kind = $null; value = $null } }
        $kind = [string]$kindEnum
        if ($kind -eq 'Unknown') { $kind = 'None' }
        $raw = $k.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        return @{ exists = $true; kind = $kind; value = (ConvertFrom-VxRegRaw $raw $kind) }
    } finally { $k.Close() }
}

function Set-VxRealRegValue([string]$Path, [string]$Name, [string]$Kind, $Value) {
    $k = Open-VxRealKey $Path $true $true
    if ($null -eq $k) { throw "Registry-Schlüssel konnte nicht geöffnet werden: $Path" }
    try {
        $raw = ConvertTo-VxRegRaw $Value $Kind
        $k.SetValue($Name, $raw, (Get-VxRegKindEnum $Kind))
    } finally { $k.Close() }
}

function Remove-VxRealRegValue([string]$Path, [string]$Name) {
    $k = Open-VxRealKey $Path $true $false
    if ($null -eq $k) { return }
    try { $k.DeleteValue($Name, $false) } finally { $k.Close() }
}

function Test-VxRealRegKey([string]$Path) {
    $k = $null
    try { $k = Open-VxRealKey $Path $false $false } catch { return $false }
    if ($null -eq $k) { return $false }
    $k.Close()
    return $true
}

function New-VxRealRegKey([string]$Path) {
    $k = Open-VxRealKey $Path $true $true
    if ($null -ne $k) { $k.Close() }
}

function Remove-VxRealRegKey([string]$Path) {
    $parent = Get-VxRegParent $Path
    if (-not $parent) { throw "Ein Registry-Stamm kann nicht gelöscht werden: $Path" }
    $k = Open-VxRealKey $parent $true $false
    if ($null -eq $k) { return }
    try { $k.DeleteSubKeyTree((Get-VxRegLeaf $Path), $false) } finally { $k.Close() }
}

function Get-VxRealRegSubKeys([string]$Path) {
    $k = $null
    try { $k = Open-VxRealKey $Path $false $false } catch { return @() }
    if ($null -eq $k) { return @() }
    try { return @($k.GetSubKeyNames()) } catch { return @() } finally { $k.Close() }
}

function Get-VxRealRegValueNames([string]$Path) {
    $k = $null
    try { $k = Open-VxRealKey $Path $false $false } catch { return @() }
    if ($null -eq $k) { return @() }
    try { return @($k.GetValueNames()) } catch { return @() } finally { $k.Close() }
}

# ================================================================== registry: SEEDED default state (non-Windows)

function Test-VxSeedKey([string]$Path) {
    $seed = $global:VxCtx.Seed
    if ($null -eq $seed) { return $false }
    $lp = $Path.ToLowerInvariant()
    foreach ($rx in @($seed.noKeys)) { if ($lp -match $rx) { return $false } }
    foreach ($rk in @($seed.regkeys)) { if ($lp -match $rk.regex) { return [bool]$rk.default } }
    if ($seed.keys.ContainsKey($lp)) { return $true }
    $parent = Get-VxRegParent $lp
    if ($parent -and $seed.wildParents.ContainsKey($parent) -and @('0000', '0001') -contains (Get-VxRegLeaf $lp)) { return $true }
    foreach ($w in @($seed.wildValues)) {
        if ($null -ne $w.default -and $lp -match $w.keyRegex) { return $true }
    }
    return $false
}

function Get-VxSeedRegValue([string]$Path, [string]$Name) {
    $none = @{ exists = $false; kind = $null; value = $null }
    $seed = $global:VxCtx.Seed
    if ($null -eq $seed) { return $none }
    if (-not (Test-VxSeedKey $Path)) { return $none }
    $k = ($Path + '|' + $Name).ToLowerInvariant()
    if ($seed.values.ContainsKey($k)) {
        $e = $seed.values[$k]
        if ($null -eq $e.default) { return $none }
        $v = $e.default
        if ($e.kind -eq 'MultiString') { $v = [string[]]@($v) }
        return @{ exists = $true; kind = $e.kind; value = $v }
    }
    $lp = $Path.ToLowerInvariant()
    $ln = $Name.ToLowerInvariant()
    foreach ($w in @($seed.wildValues)) {
        if ($w.name -eq $ln -and $lp -match $w.keyRegex) {
            if ($null -eq $w.default) { return $none }
            $v = $w.default
            if ($w.kind -eq 'MultiString') { $v = [string[]]@($v) }
            return @{ exists = $true; kind = $w.kind; value = $v }
        }
    }
    return $none
}

function Get-VxSeedRegSubKeys([string]$Path) {
    $seed = $global:VxCtx.Seed
    if ($null -eq $seed) { return @() }
    $lp = $Path.ToLowerInvariant()
    $names = New-Object System.Collections.Generic.List[string]
    if ($seed.wildParents.ContainsKey($lp)) { $names.Add('0000'); $names.Add('0001') }
    $prefix = $lp + '\'
    foreach ($key in @($seed.keyNames.Keys)) {
        if ($key.StartsWith($prefix)) {
            $rest = $key.Substring($prefix.Length)
            $seg = $rest.Split('\')[0]
            $orig = Get-VxRegLeaf ($Path + '\' + $seed.keyNames[$key].Substring($prefix.Length).Split('\')[0])
            if (-not ($names | Where-Object { $_ -ieq $seg })) { $names.Add($orig) }
        }
    }
    return @($names | Where-Object { Test-VxSeedKey ($Path + '\' + $_) })
}

function Get-VxSeedRegValueNames([string]$Path) {
    $seed = $global:VxCtx.Seed
    if ($null -eq $seed -or -not (Test-VxSeedKey $Path)) { return @() }
    $lp = $Path.ToLowerInvariant()
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($k in @($seed.values.Keys)) {
        $e = $seed.values[$k]
        if ($null -ne $e.default -and $e.lpath -eq $lp) { $names.Add($e.name) }
    }
    foreach ($w in @($seed.wildValues)) {
        if ($null -ne $w.default -and $lp -match $w.keyRegex -and -not ($names -contains $w.origName)) { $names.Add($w.origName) }
    }
    return @($names)
}

# ================================================================== registry: BASE (real on Windows, seed elsewhere)

function Get-VxBaseRegValue([string]$Path, [string]$Name) {
    if ($global:VxCtx.Windows) { return (Get-VxRealRegValue $Path $Name) }
    return (Get-VxSeedRegValue $Path $Name)
}
function Test-VxBaseRegKey([string]$Path) {
    if ($global:VxCtx.Windows) { return (Test-VxRealRegKey $Path) }
    return (Test-VxSeedKey $Path)
}
function Get-VxBaseRegSubKeys([string]$Path) {
    if ($global:VxCtx.Windows) { return @(Get-VxRealRegSubKeys $Path) }
    return @(Get-VxSeedRegSubKeys $Path)
}
function Get-VxBaseRegValueNames([string]$Path) {
    if ($global:VxCtx.Windows) { return @(Get-VxRealRegValueNames $Path) }
    return @(Get-VxSeedRegValueNames $Path)
}

# ================================================================== registry: SIMULATED overlay

function Get-VxSimReg {
    $sim = $global:VxCtx.Sim
    if (-not $sim.ContainsKey('reg') -or -not ($sim.reg -is [hashtable])) { $sim.reg = @{} }
    return $sim.reg
}

# Key of a value inside an overlay entry. Never the raw name: the key's default value has the
# name "" and a JSON property with an empty name makes sim-state.json unreadable (ConvertFrom-Json
# rejects it on 5.1 and 7), which used to wipe the whole Testmodus overlay on the next start.
function Get-VxSimValueKey([string]$Name) {
    return ('@' + ([string]$Name).ToLowerInvariant())
}

# Re-keys values written by older versions (raw lower-case name) to Get-VxSimValueKey.
function Repair-VxSimRegValues {
    $reg = Get-VxSimReg
    foreach ($k in @($reg.Keys)) {
        $e = $reg[$k]
        if (-not ($e -is [hashtable])) { continue }
        if (-not ($e.values -is [hashtable])) { $e.values = @{}; continue }
        $fixed = @{}
        foreach ($vk in @($e.values.Keys)) {
            $v = $e.values[$vk]
            $nm = [string](Get-VxProp $v 'name' '')
            if (-not (Test-VxProp $v 'name')) { if ([string]$vk -like '@*') { $nm = ([string]$vk).Substring(1) } else { $nm = [string]$vk } }
            $fixed[(Get-VxSimValueKey $nm)] = $v
        }
        $e.values = $fixed
    }
}

function Get-VxSimRegEntry([string]$Path, [bool]$Create = $false) {
    $reg = Get-VxSimReg
    $k = $Path.ToLowerInvariant()
    if ($reg.ContainsKey($k)) {
        $e = $reg[$k]
        if (-not ($e.values -is [hashtable])) { $e.values = @{} }
        return $e
    }
    if (-not $Create) { return $null }
    $e = @{ path = $Path; exists = $null; cleared = $false; values = @{} }
    $reg[$k] = $e
    return $e
}

# $true when an ancestor was deleted (base values below it are hidden) or does not exist in the overlay.
function Test-VxSimAncestorHidden([string]$Path) {
    $p = Get-VxRegParent $Path
    while ($p) {
        $e = Get-VxSimRegEntry $p $false
        if ($null -ne $e) {
            if ($e.cleared) { return $true }
            if ($e.exists -eq $false) { return $true }
        }
        $p = Get-VxRegParent $p
    }
    return $false
}

function Test-VxSimRegKey([string]$Path) {
    $e = Get-VxSimRegEntry $Path $false
    if ($null -ne $e -and $null -ne $e.exists) { return [bool]$e.exists }
    if (Test-VxSimAncestorHidden $Path) { return $false }
    return (Test-VxBaseRegKey $Path)
}

function New-VxSimRegKey([string]$Path) {
    $chain = New-Object System.Collections.Generic.List[string]
    $p = $Path
    while ($p -and $p.Contains('\')) { $chain.Insert(0, $p); $p = Get-VxRegParent $p }
    foreach ($c in $chain) {
        if (-not (Test-VxSimRegKey $c)) {
            $e = Get-VxSimRegEntry $c $true
            $e.exists = $true
            # a re-created key starts empty
            $e.cleared = $true
        }
    }
}

function Remove-VxSimRegKey([string]$Path) {
    $reg = Get-VxSimReg
    $lp = $Path.ToLowerInvariant()
    $prefix = $lp + '\'
    foreach ($k in @($reg.Keys)) {
        if ($k.StartsWith($prefix)) { $reg[$k].exists = $false; $reg[$k].cleared = $true; $reg[$k].values = @{} }
    }
    $e = Get-VxSimRegEntry $Path $true
    $e.exists = $false
    $e.cleared = $true
    $e.values = @{}
}

function Get-VxSimRegValue([string]$Path, [string]$Name) {
    $none = @{ exists = $false; kind = $null; value = $null }
    if (-not (Test-VxSimRegKey $Path)) { return $none }
    $e = Get-VxSimRegEntry $Path $false
    $ln = Get-VxSimValueKey $Name
    if ($null -ne $e) {
        if ($e.values.ContainsKey($ln)) {
            $v = $e.values[$ln]
            if ($v.deleted) { return $none }
            $val = $v.value
            if ($v.kind -eq 'MultiString') { $val = [string[]]@($val) }
            return @{ exists = $true; kind = $v.kind; value = $val }
        }
        if ($e.cleared) { return $none }
    }
    if (Test-VxSimAncestorHidden $Path) { return $none }
    return (Get-VxBaseRegValue $Path $Name)
}

function Set-VxSimRegValue([string]$Path, [string]$Name, [string]$Kind, $Value) {
    # validate exactly like the real write would
    $null = ConvertTo-VxRegRaw $Value $Kind
    New-VxSimRegKey $Path
    $e = Get-VxSimRegEntry $Path $true
    if ($null -eq $e.exists) { $e.exists = $true }
    $stored = $Value
    if ($Kind -eq 'MultiString') { $stored = @(@($Value) | ForEach-Object { [string]$_ }) }
    if ($Kind -eq 'Binary') { $stored = ([string]$Value).ToUpperInvariant() }
    if ($Kind -eq 'DWord' -or $Kind -eq 'QWord') { $stored = [decimal]$Value; if ($stored -le [decimal][long]::MaxValue) { $stored = [long]$stored } }
    $e.values[(Get-VxSimValueKey $Name)] = @{ name = $Name; kind = $Kind; value = $stored; deleted = $false }
}

function Remove-VxSimRegValue([string]$Path, [string]$Name) {
    if (-not (Test-VxSimRegKey $Path)) { return }
    $e = Get-VxSimRegEntry $Path $true
    $e.values[(Get-VxSimValueKey $Name)] = @{ name = $Name; kind = $null; value = $null; deleted = $true }
}

function Get-VxSimRegSubKeys([string]$Path) {
    if (-not (Test-VxSimRegKey $Path)) { return @() }
    $names = New-Object System.Collections.Generic.List[string]
    $e = Get-VxSimRegEntry $Path $false
    $hidden = (($null -ne $e -and $e.cleared) -or (Test-VxSimAncestorHidden $Path))
    if (-not $hidden) {
        foreach ($n in @(Get-VxBaseRegSubKeys $Path)) {
            if (Test-VxSimRegKey ($Path + '\' + $n)) { $names.Add($n) }
        }
    }
    $prefix = $Path.ToLowerInvariant() + '\'
    $reg = Get-VxSimReg
    foreach ($k in @($reg.Keys)) {
        if ($k.StartsWith($prefix) -and -not $k.Substring($prefix.Length).Contains('\')) {
            $ent = $reg[$k]
            if ($ent.exists -eq $true) {
                $leaf = Get-VxRegLeaf ([string]$ent.path)
                if (-not ($names | Where-Object { $_ -ieq $leaf })) { $names.Add($leaf) }
            }
        }
    }
    return @($names)
}

function Get-VxSimRegValueNames([string]$Path) {
    if (-not (Test-VxSimRegKey $Path)) { return @() }
    $e = Get-VxSimRegEntry $Path $false
    $names = New-Object System.Collections.Generic.List[string]
    $hidden = (($null -ne $e -and $e.cleared) -or (Test-VxSimAncestorHidden $Path))
    if (-not $hidden) {
        foreach ($n in @(Get-VxBaseRegValueNames $Path)) {
            if ($null -ne $e -and $e.values.ContainsKey((Get-VxSimValueKey $n))) { continue }
            $names.Add($n)
        }
    }
    if ($null -ne $e) {
        foreach ($k in @($e.values.Keys)) {
            $v = $e.values[$k]
            if (-not $v.deleted) { $names.Add([string]$v.name) }
        }
    }
    return @($names)
}

# ================================================================== registry: PUBLIC API

function Get-VxRegValue([string]$Path, [string]$Name) {
    if ($global:VxCtx.Simulate) { return (Get-VxSimRegValue $Path $Name) }
    return (Get-VxRealRegValue $Path $Name)
}

function Set-VxRegValue([string]$Path, [string]$Name, [string]$Kind, $Value) {
    if ($global:VxCtx.Simulate) { Set-VxSimRegValue $Path $Name $Kind $Value; return }
    Set-VxRealRegValue $Path $Name $Kind $Value
}

function Remove-VxRegValue([string]$Path, [string]$Name) {
    if ($global:VxCtx.Simulate) { Remove-VxSimRegValue $Path $Name; return }
    Remove-VxRealRegValue $Path $Name
}

function Test-VxRegKey([string]$Path) {
    if ($global:VxCtx.Simulate) { return (Test-VxSimRegKey $Path) }
    return (Test-VxRealRegKey $Path)
}

function New-VxRegKey([string]$Path) {
    if ($global:VxCtx.Simulate) { New-VxSimRegKey $Path; return }
    New-VxRealRegKey $Path
}

function Remove-VxRegKey([string]$Path) {
    if ($global:VxCtx.Simulate) { Remove-VxSimRegKey $Path; return }
    Remove-VxRealRegKey $Path
}

function Get-VxRegSubKeys([string]$Path) {
    if ($global:VxCtx.Simulate) { return @(Get-VxSimRegSubKeys $Path) }
    return @(Get-VxRealRegSubKeys $Path)
}

function Get-VxRegValueNames([string]$Path) {
    if ($global:VxCtx.Simulate) { return @(Get-VxSimRegValueNames $Path) }
    return @(Get-VxRealRegValueNames $Path)
}

# Expands one '*' segment to the existing subkeys. Segments after the '*' are appended as-is
# (they may not exist yet). Without '*' the path is returned unchanged.
function Resolve-VxRegPattern([string]$Pattern) {
    $segs = $Pattern.Split('\')
    $star = [Array]::IndexOf($segs, '*')
    if ($star -lt 0) { return @($Pattern) }
    if ($star -eq 0) { return @() }
    $parent = ($segs[0..($star - 1)]) -join '\'
    $suffix = ''
    if ($star -lt $segs.Length - 1) { $suffix = '\' + (($segs[($star + 1)..($segs.Length - 1)]) -join '\') }
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($sk in @(Get-VxRegSubKeys $parent | Sort-Object)) { $out.Add($parent + '\' + $sk + $suffix) }
    return @($out)
}

# Exports a key tree (values + subkeys) so it can be re-created by Import-VxRegTree.
function Export-VxRegTree([string]$Path, [int]$Depth = 0) {
    if ($Depth -gt 20) { return $null }
    if (-not (Test-VxRegKey $Path)) { return $null }
    $vals = New-Object System.Collections.ArrayList
    # sorted: the simulated registry has no stable value order, and a stable export compares equal
    foreach ($n in @(@(Get-VxRegValueNames $Path) | Sort-Object)) {
        $v = Get-VxRegValue $Path $n
        if ($v.exists) { [void]$vals.Add([ordered]@{ name = $n; kind = $v.kind; value = $v.value }) }
    }
    $keys = New-Object System.Collections.ArrayList
    foreach ($sk in @(@(Get-VxRegSubKeys $Path) | Sort-Object)) {
        $t = Export-VxRegTree ($Path + '\' + $sk) ($Depth + 1)
        if ($null -ne $t) { [void]$keys.Add($t) }
    }
    return [ordered]@{ path = $Path; values = $vals.ToArray(); keys = $keys.ToArray() }
}

# Re-creates a key tree. With a journal $J every value that is overwritten and every subkey that is
# created is journalled, so a restore that lands on an existing key can itself be undone.
# Without $J (the key was just created and that creation is journalled) values are written directly.
function Import-VxRegTree($Tree, $J = $null, [string]$TweakId = $null) {
    if ($null -eq $Tree) { return }
    $path = [string](Get-VxProp $Tree 'path')
    if ($null -eq $J) { New-VxRegKey $path }
    elseif (-not (Test-VxRegKey $path)) { $null = Set-VxRegKeyJ $J $path $true $TweakId $Tree; return }
    foreach ($v in @(Get-VxProp $Tree 'values' @())) {
        $kind = [string](Get-VxProp $v 'kind')
        if (@('DWord', 'QWord', 'String', 'ExpandString', 'MultiString', 'Binary') -notcontains $kind) { continue }
        $val = Get-VxProp $v 'value'
        if ($kind -eq 'MultiString') { $val = [string[]]@($val) }
        if ($null -eq $J) { Set-VxRegValue $path ([string](Get-VxProp $v 'name')) $kind $val }
        else { $null = Set-VxRegJ $J $path ([string](Get-VxProp $v 'name')) $kind $val $TweakId }
    }
    foreach ($k in @(Get-VxProp $Tree 'keys' @())) { Import-VxRegTree $k $J $TweakId }
}

# ================================================================== services

function Get-VxRealServiceStart([string]$Name) {
    $path = 'HKLM\SYSTEM\CurrentControlSet\Services\' + $Name
    $start = Get-VxRealRegValue $path 'Start'
    if (-not $start.exists) { return $null }
    $n = [int]$start.value
    $s = switch ($n) { 0 { 'Boot' } 1 { 'System' } 2 { 'Automatic' } 3 { 'Manual' } 4 { 'Disabled' } default { 'Manual' } }
    if ($s -eq 'Automatic') {
        $d = Get-VxRealRegValue $path 'DelayedAutostart'
        if ($d.exists -and [int]$d.value -eq 1) { $s = 'AutomaticDelayed' }
    }
    return $s
}

# Start type name, or $null when the service does not exist.
function Get-VxServiceStart([string]$Name) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        $sim = $ctx.Sim
        if (-not ($sim.svc -is [hashtable])) { $sim.svc = @{} }
        $k = $Name.ToLowerInvariant()
        if ($sim.svc.ContainsKey($k)) {
            # '__missing__' lets tests simulate a service that does not exist
            if ($sim.svc[$k] -eq '__missing__') { return $null }
            return $sim.svc[$k]
        }
        if ($ctx.Windows) { return (Get-VxRealServiceStart $Name) }
        $seed = $ctx.Seed
        if ($null -ne $seed -and $seed.services.ContainsKey($k)) { return $seed.services[$k] }
        return $null
    }
    return (Get-VxRealServiceStart $Name)
}

function Get-VxScArgs([string]$Start) {
    switch ($Start) {
        'Automatic' { return 'auto' }
        'AutomaticDelayed' { return 'delayed-auto' }
        'Manual' { return 'demand' }
        'Disabled' { return 'disabled' }
    }
    throw "Unbekannter Starttyp '$Start'"
}

# Sets the start type; optionally stops (Disabled) or starts (Automatic) the service.
function Set-VxServiceStart([string]$Name, [string]$Start, [bool]$StopNow = $false, [bool]$StartNow = $false) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.svc -is [hashtable])) { $ctx.Sim.svc = @{} }
        $ctx.Sim.svc[$Name.ToLowerInvariant()] = $Start
        if ($StopNow) { Write-VxLog 'info' "[Testmodus] Dienst $Name würde gestoppt" }
        if ($StartNow) { Write-VxLog 'info' "[Testmodus] Dienst $Name würde gestartet" }
        return
    }
    $sc = Get-VxSystemTool 'sc.exe'
    $r = Invoke-VxNative -FilePath $sc -Arguments @('config', $Name, 'start=', (Get-VxScArgs $Start)) -TimeoutSec 30
    if ($r.ExitCode -ne 0) {
        # Some services refuse sc.exe (e.g. per-user templates); fall back to the registry values.
        try {
            $path = 'HKLM\SYSTEM\CurrentControlSet\Services\' + $Name
            $num = switch ($Start) { 'Automatic' { 2 } 'AutomaticDelayed' { 2 } 'Manual' { 3 } 'Disabled' { 4 } }
            Set-VxRealRegValue $path 'Start' 'DWord' $num
            if ($Start -eq 'AutomaticDelayed') { Set-VxRealRegValue $path 'DelayedAutostart' 'DWord' 1 }
            elseif ($Start -eq 'Automatic') {
                $d = Get-VxRealRegValue $path 'DelayedAutostart'
                if ($d.exists) { Set-VxRealRegValue $path 'DelayedAutostart' 'DWord' 0 }
            }
        } catch {
            throw ("Starttyp von Dienst '$Name' konnte nicht geändert werden (sc.exe Code $($r.ExitCode)): " + (($r.Output + ' ' + $r.Error).Trim()))
        }
    }
    if ($StopNow) {
        $s = Invoke-VxNative -FilePath $sc -Arguments @('stop', $Name) -TimeoutSec 20
        # 1062 = not started, 1052 = cannot be stopped - both fine
        if ($s.ExitCode -ne 0 -and $s.ExitCode -ne 1062) { Write-VxLog 'warn' "Dienst $Name konnte nicht sofort gestoppt werden (Code $($s.ExitCode)) – wirkt nach dem Neustart." }
    }
    if ($StartNow) {
        $s2 = Invoke-VxNative -FilePath $sc -Arguments @('start', $Name) -TimeoutSec 20
        if ($s2.ExitCode -ne 0 -and $s2.ExitCode -ne 1056) { Write-VxLog 'warn' "Dienst $Name konnte nicht gestartet werden (Code $($s2.ExitCode)) – startet nach dem Neustart." }
    }
}

# ================================================================== scheduled tasks

function Split-VxTaskPath([string]$Path) {
    $i = $Path.LastIndexOf('\')
    return @{ TaskPath = $Path.Substring(0, $i + 1); TaskName = $Path.Substring($i + 1) }
}

function Test-VxScheduledTasksModule {
    $c = $global:VxCtx.Cache
    if (-not $c.ContainsKey('schedModule')) {
        $c.schedModule = [bool](Get-Command -Name 'Get-ScheduledTask' -ErrorAction SilentlyContinue)
    }
    return $c.schedModule
}

# $true (enabled) / $false (disabled) / $null (missing or unreadable)
function Get-VxRealTaskState([string]$Path) {
    $sp = Split-VxTaskPath $Path
    if (Test-VxScheduledTasksModule) {
        try {
            $t = Get-ScheduledTask -TaskPath $sp.TaskPath -TaskName $sp.TaskName -ErrorAction Stop
            return ([string]$t.State -ne 'Disabled')
        } catch { return $null }
    }
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'schtasks.exe') -Arguments @('/Query', '/TN', $Path, '/XML') -TimeoutSec 20
    if ($r.ExitCode -ne 0) { return $null }
    $m = [regex]::Match($r.Output, '<Settings>[\s\S]*?</Settings>')
    if ($m.Success -and $m.Value -match '<Enabled>\s*false\s*</Enabled>') { return $false }
    return $true
}

function Get-VxTaskState([string]$Path) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.task -is [hashtable])) { $ctx.Sim.task = @{} }
        $k = $Path.ToLowerInvariant()
        if ($ctx.Sim.task.ContainsKey($k)) { return $ctx.Sim.task[$k] }
        if ($ctx.Windows) { return (Get-VxRealTaskState $Path) }
        $seed = $ctx.Seed
        if ($null -ne $seed -and $seed.tasks.ContainsKey($k)) { return [bool]$seed.tasks[$k] }
        return $true
    }
    return (Get-VxRealTaskState $Path)
}

function Set-VxTaskState([string]$Path, [bool]$Enabled) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.task -is [hashtable])) { $ctx.Sim.task = @{} }
        $ctx.Sim.task[$Path.ToLowerInvariant()] = $Enabled
        return
    }
    $sp = Split-VxTaskPath $Path
    if (Test-VxScheduledTasksModule) {
        try {
            if ($Enabled) { $null = Enable-ScheduledTask -TaskPath $sp.TaskPath -TaskName $sp.TaskName -ErrorAction Stop }
            else { $null = Disable-ScheduledTask -TaskPath $sp.TaskPath -TaskName $sp.TaskName -ErrorAction Stop }
            return
        } catch {
            Write-VxLog 'warn' ("ScheduledTasks-Modul fehlgeschlagen, versuche schtasks.exe: " + $_.Exception.Message)
        }
    }
    $flag = '/DISABLE'
    if ($Enabled) { $flag = '/ENABLE' }
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'schtasks.exe') -Arguments @('/Change', '/TN', $Path, $flag) -TimeoutSec 30
    if ($r.ExitCode -ne 0) { throw ("Aufgabe '$Path' konnte nicht geändert werden: " + (($r.Error + ' ' + $r.Output).Trim())) }
}

# ================================================================== BCD

function Test-VxBcdEqual($A, $B) {
    $yes = @('yes', 'ja', 'on', 'true', '1', 'oui', 'si', 'sim', 'tak', 'evet')
    $no = @('no', 'nein', 'off', 'false', '0', 'non', 'nao', 'nie', 'hayir')
    if ($null -eq $A -or $null -eq $B) { return ($null -eq $A -and $null -eq $B) }
    $a = ([string]$A).Trim().ToLowerInvariant()
    $b = ([string]$B).Trim().ToLowerInvariant()
    if ($a -eq $b) { return $true }
    if ($yes -contains $a -and $yes -contains $b) { return $true }
    if ($no -contains $a -and $no -contains $b) { return $true }
    return $false
}

# Parses "bcdedit /enum {current}" output into name(lower) -> value.
function ConvertFrom-VxBcdOutput([string]$Text) {
    $h = @{}
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*$' -or $line -match '^-+\s*$') { continue }
        if ($line -match '^\s') { continue }
        $m = [regex]::Match($line, '^(\S+)\s+(.+?)\s*$')
        if ($m.Success) {
            $k = $m.Groups[1].Value.ToLowerInvariant()
            if (-not $h.ContainsKey($k)) { $h[$k] = $m.Groups[2].Value }
        }
    }
    return $h
}

function Get-VxRealBcdValues {
    $c = $global:VxCtx.Cache
    if ($c.ContainsKey('bcd')) { return $c.bcd }
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'bcdedit.exe') -Arguments @('/enum', '{current}') -TimeoutSec 30
    if ($r.ExitCode -ne 0) { throw ('bcdedit konnte nicht gelesen werden (Adminrechte?): ' + ($r.Output + $r.Error).Trim()) }
    $c.bcd = ConvertFrom-VxBcdOutput $r.Output
    return $c.bcd
}

# Value string or $null when not set. Throws when BCD cannot be read.
function Get-VxBcdValue([string]$Name) {
    $ctx = $global:VxCtx
    $k = $Name.ToLowerInvariant()
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.bcd -is [hashtable])) { $ctx.Sim.bcd = @{} }
        if ($ctx.Sim.bcd.ContainsKey($k)) {
            $v = $ctx.Sim.bcd[$k]
            if ($v -eq '__deleted__') { return $null }
            return $v
        }
        if (-not $ctx.Windows) { return $null }
    }
    $all = Get-VxRealBcdValues
    if ($all.ContainsKey($k)) { return $all[$k] }
    return $null
}

# BCD settings BitLocker ignores (Microsoft "BCD settings and BitLocker": not in the validation
# profile). Changing any OTHER setting (loadoptions, debug, nointegritychecks, testsigning ...)
# can make BitLocker ask for the 48-digit recovery key at the next boot.
function Get-VxBitLockerSafeBcdNames {
    # deliberately short: for anything not known to be ignored, BitLocker is suspended once - harmless
    return @('useplatformclock', 'useplatformtick', 'disabledynamictick', 'tscsyncpolicy', 'hypervisorlaunchtype')
}

function Test-VxBcdNeedsBitLockerSuspend([string]$Name) {
    return ((Get-VxBitLockerSafeBcdNames) -notcontains ([string]$Name).ToLowerInvariant())
}

# Before a boot setting that BitLocker validates is changed: if BitLocker protects the system
# drive, suspend it for exactly one reboot (what Suspend-BitLocker -RebootCount 1 does) so the
# next boot does not ask for the recovery key. Refuses the change when that is not possible.
function Confirm-VxBitLockerForBcd([string]$Name) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate -or -not $ctx.Windows) { return }
    if (-not (Test-VxBcdNeedsBitLockerSuspend $Name)) { return }
    if ($ctx.Cache.ContainsKey('bitlockerSuspended')) { return }
    $drive = [string]$env:SystemDrive
    if (-not $drive) { $drive = 'C:' }
    $vol = $null
    try {
        $vol = @(Get-CimInstance -Namespace 'root/cimv2/Security/MicrosoftVolumeEncryption' -ClassName 'Win32_EncryptableVolume' -Filter ("DriveLetter='{0}'" -f $drive) -OperationTimeoutSec 15 -ErrorAction Stop)[0]
    } catch { $vol = $null }
    # no BitLocker on this PC (Home edition without device encryption, or namespace missing)
    if ($null -eq $vol) { $ctx.Cache.bitlockerSuspended = $false; return }
    $prot = 0
    try { $prot = [int](Invoke-CimMethod -InputObject $vol -MethodName 'GetProtectionStatus' -ErrorAction Stop).ProtectionStatus } catch { $prot = [int]$vol.ProtectionStatus }
    if ($prot -ne 1) { $ctx.Cache.bitlockerSuspended = $false; return }
    $ok = $false
    try {
        $r = Invoke-CimMethod -InputObject $vol -MethodName 'DisableKeyProtectors' -Arguments @{ DisableCount = [uint32]1 } -ErrorAction Stop
        $ok = ([int]$r.ReturnValue -eq 0)
    } catch { $ok = $false }
    if (-not $ok) {
        throw ("BitLocker schützt dein Systemlaufwerk und konnte nicht für einen Neustart pausiert werden. Der Boot-Wert '{0}' wird deshalb nicht geändert – sonst fragt Windows beim nächsten Start nach dem 48-stelligen Wiederherstellungsschlüssel. Notiere dir zuerst den Schlüssel (Systemsteuerung > BitLocker > Wiederherstellungsschlüssel sichern)." -f $Name)
    }
    $ctx.Cache.bitlockerSuspended = $true
    Write-VxLog 'warn' ("BitLocker wurde für den nächsten Neustart pausiert, weil der Boot-Wert '{0}' geändert wird. Danach schaltet er sich von selbst wieder ein." -f $Name)
}

function Set-VxBcdValue([string]$Name, [string]$Value) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.bcd -is [hashtable])) { $ctx.Sim.bcd = @{} }
        $ctx.Sim.bcd[$Name.ToLowerInvariant()] = $Value
        return
    }
    Confirm-VxBitLockerForBcd $Name
    $ctx.Cache.Remove('bcd')
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'bcdedit.exe') -Arguments @('/set', '{current}', $Name, $Value) -TimeoutSec 30
    if ($r.ExitCode -ne 0) { throw ("bcdedit /set $Name fehlgeschlagen: " + ($r.Output + $r.Error).Trim()) }
}

function Remove-VxBcdValue([string]$Name) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.bcd -is [hashtable])) { $ctx.Sim.bcd = @{} }
        $ctx.Sim.bcd[$Name.ToLowerInvariant()] = '__deleted__'
        return
    }
    Confirm-VxBitLockerForBcd $Name
    $ctx.Cache.Remove('bcd')
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'bcdedit.exe') -Arguments @('/deletevalue', '{current}', $Name) -TimeoutSec 30
    # deleting a value that is not set returns an error - treat as success when it is gone
    if ($r.ExitCode -ne 0) {
        $ctx.Cache.Remove('bcd')
        $still = $null
        try { $still = Get-VxBcdValue $Name } catch { $still = $null }
        if ($null -ne $still) { throw ("bcdedit /deletevalue $Name fehlgeschlagen: " + ($r.Output + $r.Error).Trim()) }
    }
}

# ================================================================== power plans

function Get-VxPowercfg { return (Get-VxSystemTool 'powercfg.exe') }

function Get-VxRealActivePlan {
    $c = $global:VxCtx.Cache
    if ($c.ContainsKey('activePlan')) { return $c.activePlan }
    $r = Invoke-VxNative -FilePath (Get-VxPowercfg) -Arguments @('/getactivescheme') -TimeoutSec 20
    $m = [regex]::Match($r.Output, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
    if (-not $m.Success) { throw 'Aktiver Energieplan konnte nicht gelesen werden.' }
    $name = ''
    $n = [regex]::Match($r.Output, '\((.+)\)\s*\*?\s*$')
    if ($n.Success) { $name = $n.Groups[1].Value.Trim() }
    $c.activePlan = @{ guid = $m.Value.ToLowerInvariant(); name = $name }
    return $c.activePlan
}

function Get-VxRealPlanList {
    $r = Invoke-VxNative -FilePath (Get-VxPowercfg) -Arguments @('/list') -TimeoutSec 20
    $list = @()
    foreach ($m in [regex]::Matches($r.Output, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')) { $list += $m.Value.ToLowerInvariant() }
    return $list
}

# @{ guid; name } of the active power plan.
function Get-VxActivePlan {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.power -is [hashtable])) { $ctx.Sim.power = @{} }
        if ($ctx.Sim.power.ContainsKey('active')) {
            $g = [string]$ctx.Sim.power.active
            return @{ guid = $g; name = (Get-VxPlanDisplayName $g) }
        }
        if (-not $ctx.Windows) { return @{ guid = (Get-VxPlanBaseGuid 'balanced'); name = 'Ausbalanciert' } }
    }
    return (Get-VxRealActivePlan)
}

function Get-VxPlanDisplayName([string]$Guid) {
    $g = $Guid.ToLowerInvariant()
    if ($g -eq (Get-VxPlanBaseGuid 'balanced')) { return 'Ausbalanciert' }
    if ($g -eq (Get-VxPlanBaseGuid 'high')) { return 'Höchstleistung' }
    if ((Get-VxPlanCandidates 'ultimate') -contains $g) { return 'Ultimative Leistung' }
    return 'Benutzerdefiniert'
}

# GUID + name of every power scheme (real system, cached per scan/job).
function Get-VxRealPlanTable {
    $c = $global:VxCtx.Cache
    if ($c.ContainsKey('planTable')) { return $c.planTable }
    $list = @()
    try {
        $r = Invoke-VxNative -FilePath (Get-VxPowercfg) -Arguments @('/list') -TimeoutSec 20
        foreach ($line in ($r.Output -split "`r?`n")) {
            $m = [regex]::Match($line, '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*\((.*)\)')
            if ($m.Success) { $list += @{ guid = $m.Groups[1].Value.ToLowerInvariant(); name = $m.Groups[2].Value.Trim() } }
        }
    } catch { $null = $_ }
    $c.planTable = $list
    return $list
}

# All GUIDs that count as the given plan. Ultimate (and High on Modern-Standby PCs) usually exists only
# as a duplicated copy - the one VELOX made (state.json) or one made by another tool (matched by name).
function Get-VxPlanCandidates([string]$Plan) {
    $ctx = $global:VxCtx
    $st = $ctx.State
    $list = @((Get-VxPlanBaseGuid $Plan))
    if ($Plan -eq 'ultimate' -and $null -ne $st -and $st.ultimateGuid) { $list += ([string]$st.ultimateGuid).ToLowerInvariant() }
    if ($Plan -eq 'high' -and $null -ne $st -and $st.highGuid) { $list += ([string]$st.highGuid).ToLowerInvariant() }
    if ($ctx.Windows -and $Plan -ne 'balanced') {
        # accented letters may arrive mis-decoded (code page mix-ups), so they match 1-2 any characters
        $rx = 'Ultimate Performance|Ultimative Leistung|Performances ultimes|M.{1,2}ximo rendimiento|Prestazioni ottimali|Ultieme prestaties'
        if ($Plan -eq 'high') { $rx = '^(High performance|H.{1,2}chstleistung|Hohe Leistung|Performances .{1,2}lev.{1,2}es|Alto rendimiento|Prestazioni elevate)$' }
        foreach ($p in @(Get-VxRealPlanTable)) { if ($p.name -match $rx -and $list -notcontains $p.guid) { $list += $p.guid } }
    }
    return $list
}

# Returns the GUID to activate for a plan, duplicating the hidden scheme once if needed.
function Resolve-VxPlanGuid([string]$Plan) {
    $ctx = $global:VxCtx
    $base = (Get-VxPlanBaseGuid $Plan)
    if (-not $base) { throw "Unbekannter Energieplan '$Plan'" }
    if ($ctx.Simulate) { return $base }
    $existing = @(Get-VxRealPlanList)
    foreach ($g in @(Get-VxPlanCandidates $Plan)) { if ($existing -contains $g) { return $g } }
    if ($Plan -eq 'balanced') { return $base }
    # Ultimate (and High on Modern-Standby devices) is hidden: duplicate it once and remember the copy.
    $r = Invoke-VxNative -FilePath (Get-VxPowercfg) -Arguments @('-duplicatescheme', $base) -TimeoutSec 30
    $m = [regex]::Match($r.Output, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
    if ($r.ExitCode -ne 0 -or -not $m.Success) { throw ('Energieplan konnte nicht angelegt werden: ' + ($r.Output + $r.Error).Trim()) }
    $guid = $m.Value.ToLowerInvariant()
    $ctx.Cache.Remove('planTable')
    if ($Plan -eq 'ultimate') { $ctx.State.ultimateGuid = $guid } else { $ctx.State.highGuid = $guid }
    Save-VxState
    return $guid
}

function Set-VxActivePlanGuid([string]$Guid) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.power -is [hashtable])) { $ctx.Sim.power = @{} }
        $ctx.Sim.power.active = $Guid.ToLowerInvariant()
        return
    }
    $ctx.Cache.Remove('activePlan')
    $ctx.Cache.Remove('planTable')
    $r = Invoke-VxNative -FilePath (Get-VxPowercfg) -Arguments @('/setactive', $Guid) -TimeoutSec 30
    if ($r.ExitCode -ne 0) { throw ('Energieplan konnte nicht aktiviert werden: ' + ($r.Output + $r.Error).Trim()) }
}

# Parses powercfg /query output independent of the UI language: the last two 0x numbers are AC and DC.
function ConvertFrom-VxPowercfgQuery([string]$Text) {
    $nums = @([regex]::Matches($Text, '0x([0-9a-fA-F]+)') | ForEach-Object { $_.Groups[1].Value })
    if ($nums.Count -lt 2) { return $null }
    $ac = [Convert]::ToInt64($nums[$nums.Count - 2], 16)
    $dc = [Convert]::ToInt64($nums[$nums.Count - 1], 16)
    return @{ ac = $ac; dc = $dc }
}

# GUID of the active scheme, or '' when it cannot be read (callers then fall back to SCHEME_CURRENT).
function Get-VxActiveSchemeGuid {
    try { return [string](Get-VxActivePlan).guid } catch { return '' }
}

# Key of a power setting in the simulated per-scheme table.
function Get-VxSimPwsKey([string]$Scheme, [string]$Subgroup, [string]$Setting) {
    return ($Scheme + '|' + $Subgroup + '|' + $Setting).ToLowerInvariant()
}

# AC/DC value of a power setting in the given scheme ('' = the active one). Power settings belong
# to a scheme: switching the plan switches every value, so callers that remember or journal a value
# must also remember the scheme it came from.
function Get-VxPowerSetting([string]$Subgroup, [string]$Setting, $Default = $null, [string]$Scheme = '') {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.pws -is [hashtable])) { $ctx.Sim.pws = @{} }
        $sch = $Scheme
        if (-not $sch) { $sch = Get-VxActiveSchemeGuid }
        $key = Get-VxSimPwsKey $sch $Subgroup $Setting
        if ($ctx.Sim.pws.ContainsKey($key)) { $v = $ctx.Sim.pws[$key]; return @{ ac = $v.ac; dc = $v.dc } }
        if (-not $ctx.Windows) {
            if ($null -ne $Default) { return @{ ac = (Get-VxProp $Default 'ac'); dc = (Get-VxProp $Default 'dc') } }
            return $null
        }
    }
    $target = $Scheme
    if (-not $target) { $target = 'SCHEME_CURRENT' }
    $r = Invoke-VxNative -FilePath (Get-VxPowercfg) -Arguments @('/query', $target, $Subgroup, $Setting) -TimeoutSec 20
    if ($r.ExitCode -ne 0) { return $null }
    return (ConvertFrom-VxPowercfgQuery $r.Output)
}

# Writes AC and/or DC ($null = leave that half alone) into the given scheme ('' = the active one).
# Only the active scheme is re-activated so the change takes effect; other schemes are just written.
function Set-VxPowerSetting([string]$Subgroup, [string]$Setting, $Ac, $Dc, [string]$Scheme = '') {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.pws -is [hashtable])) { $ctx.Sim.pws = @{} }
        $sch = $Scheme
        if (-not $sch) { $sch = Get-VxActiveSchemeGuid }
        $cur = Get-VxPowerSetting $Subgroup $Setting $null $sch
        $newAc = $Ac
        if ($null -eq $newAc -and $null -ne $cur) { $newAc = $cur.ac }
        $newDc = $Dc
        if ($null -eq $newDc -and $null -ne $cur) { $newDc = $cur.dc }
        $ctx.Sim.pws[(Get-VxSimPwsKey $sch $Subgroup $Setting)] = @{ ac = $newAc; dc = $newDc }
        return
    }
    $pc = Get-VxPowercfg
    $target = $Scheme
    $isActive = $true
    if ($target) {
        $active = Get-VxActiveSchemeGuid
        $isActive = (-not $active -or [string]::Equals($active, $target, [StringComparison]::OrdinalIgnoreCase))
    } else { $target = 'SCHEME_CURRENT' }
    if ($null -ne $Ac) {
        $r = Invoke-VxNative -FilePath $pc -Arguments @('/setacvalueindex', $target, $Subgroup, $Setting, [string]$Ac) -TimeoutSec 20
        if ($r.ExitCode -ne 0) { throw ('powercfg (Netzbetrieb) fehlgeschlagen: ' + ($r.Output + $r.Error).Trim()) }
    }
    if ($null -ne $Dc) {
        $r2 = Invoke-VxNative -FilePath $pc -Arguments @('/setdcvalueindex', $target, $Subgroup, $Setting, [string]$Dc) -TimeoutSec 20
        if ($r2.ExitCode -ne 0) { throw ('powercfg (Akkubetrieb) fehlgeschlagen: ' + ($r2.Output + $r2.Error).Trim()) }
    }
    if ($isActive) { $null = Invoke-VxNative -FilePath $pc -Arguments @('/setactive', 'SCHEME_CURRENT') -TimeoutSec 20 }
}

# Older Testmodus overlays stored power settings without a scheme: they belonged to the plan that
# was active then, which is the simulated active plan (or Balanced).
function Repair-VxSimPowerSettings {
    $ctx = $global:VxCtx
    if (-not ($ctx.Sim.pws -is [hashtable])) { $ctx.Sim.pws = @{}; return }
    $legacy = @($ctx.Sim.pws.Keys | Where-Object { @(([string]$_).Split('|')).Count -eq 2 })
    if ($legacy.Count -eq 0) { return }
    $sch = ''
    if ($ctx.Sim.power -is [hashtable] -and $ctx.Sim.power.ContainsKey('active')) { $sch = [string]$ctx.Sim.power.active }
    if (-not $sch) { $sch = Get-VxPlanBaseGuid 'balanced' }
    foreach ($k in $legacy) {
        $v = $ctx.Sim.pws[$k]
        $ctx.Sim.pws.Remove($k)
        $nk = ($sch + '|' + $k).ToLowerInvariant()
        if (-not $ctx.Sim.pws.ContainsKey($nk)) { $ctx.Sim.pws[$nk] = $v }
    }
}

# ================================================================== optional features

function Get-VxRealFeatureTable {
    $c = $global:VxCtx.Cache
    if ($c.ContainsKey('features')) { return $c.features }
    $h = @{}
    try {
        foreach ($f in @(Get-WindowsOptionalFeature -Online -ErrorAction Stop)) {
            $h[([string]$f.FeatureName).ToLowerInvariant()] = [string]$f.State
        }
    } catch {
        Write-VxLog 'warn' ('Windows-Features konnten nicht gelesen werden: ' + $_.Exception.Message)
        $h = 'error'
    }
    $c.features = $h
    return $h
}

# $true / $false / $null (missing or unknown)
function Get-VxFeatureState([string]$Name) {
    $ctx = $global:VxCtx
    $k = $Name.ToLowerInvariant()
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.feature -is [hashtable])) { $ctx.Sim.feature = @{} }
        if ($ctx.Sim.feature.ContainsKey($k)) { return [bool]$ctx.Sim.feature[$k] }
        if (-not $ctx.Windows) { return $true }
    }
    $t = Get-VxRealFeatureTable
    # unreadable (e.g. Testmodus without admin rights) -> the caller reports "unknown", not "na"
    if ($t -is [string]) { throw 'Windows-Features können ohne Administratorrechte nicht gelesen werden.' }
    if ($null -eq $t -or -not $t.ContainsKey($k)) { return $null }
    return ($t[$k] -match '^Enable')
}

function Set-VxFeatureState([string]$Name, [bool]$Enabled) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.feature -is [hashtable])) { $ctx.Sim.feature = @{} }
        $ctx.Sim.feature[$Name.ToLowerInvariant()] = $Enabled
        return
    }
    $ctx.Cache.Remove('features')
    try {
        if ($Enabled) { $null = Enable-WindowsOptionalFeature -Online -FeatureName $Name -All -NoRestart -WarningAction SilentlyContinue -ErrorAction Stop }
        else { $null = Disable-WindowsOptionalFeature -Online -FeatureName $Name -NoRestart -WarningAction SilentlyContinue -ErrorAction Stop }
        return
    } catch {
        Write-VxLog 'warn' ('DISM-Modul fehlgeschlagen, versuche dism.exe: ' + $_.Exception.Message)
    }
    $a = @('/Online', '/Disable-Feature', "/FeatureName:$Name", '/NoRestart', '/Quiet')
    if ($Enabled) { $a = @('/Online', '/Enable-Feature', "/FeatureName:$Name", '/All', '/NoRestart', '/Quiet') }
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'dism.exe') -Arguments $a -TimeoutSec 900
    # 3010 = success, reboot required
    if ($r.ExitCode -ne 0 -and $r.ExitCode -ne 3010) { throw ("Windows-Feature '$Name' konnte nicht geändert werden (Code $($r.ExitCode)).") }
}

# ================================================================== Appx packages

function Get-VxRealAppxTable {
    $c = $global:VxCtx.Cache
    if ($c.ContainsKey('appx')) { return $c.appx }
    $h = @{}
    try {
        foreach ($p in @(Get-AppxPackage -AllUsers -ErrorAction Stop)) { $h[([string]$p.Name).ToLowerInvariant()] = $true }
    } catch {
        try {
            foreach ($p in @(Get-AppxPackage -ErrorAction Stop)) { $h[([string]$p.Name).ToLowerInvariant()] = $true }
        } catch {
            Write-VxLog 'warn' ('App-Liste konnte nicht gelesen werden: ' + $_.Exception.Message)
            $h = $null
        }
    }
    $c.appx = $h
    return $h
}

# $true installed, $false not installed, $null unknown
function Test-VxAppxInstalled([string]$Package) {
    $ctx = $global:VxCtx
    $k = $Package.ToLowerInvariant()
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.appx -is [hashtable])) { $ctx.Sim.appx = @{} }
        if ($ctx.Sim.appx.ContainsKey($k)) { return [bool]$ctx.Sim.appx[$k] }
        if (-not $ctx.Windows) { return $true }
    }
    $t = Get-VxRealAppxTable
    if ($null -eq $t) { return $null }
    return $t.ContainsKey($k)
}

function Remove-VxAppxPackage([string]$Package) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.appx -is [hashtable])) { $ctx.Sim.appx = @{} }
        $ctx.Sim.appx[$Package.ToLowerInvariant()] = $false
        return
    }
    $ctx.Cache.Remove('appx')
    $errors = @()
    $pkgs = @()
    try { $pkgs = @(Get-AppxPackage -AllUsers -Name $Package -ErrorAction Stop) } catch { $pkgs = @(Get-AppxPackage -Name $Package -ErrorAction SilentlyContinue) }
    foreach ($p in $pkgs) {
        try { Remove-AppxPackage -Package $p.PackageFullName -AllUsers -ErrorAction Stop }
        catch {
            try { Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop }
            catch { $errors += $_.Exception.Message }
        }
    }
    try {
        foreach ($pp in @(Get-AppxProvisionedPackage -Online -ErrorAction Stop | Where-Object { $_.DisplayName -eq $Package })) {
            try { $null = Remove-AppxProvisionedPackage -Online -PackageName $pp.PackageName -AllUsers -ErrorAction Stop }
            catch {
                try { $null = Remove-AppxProvisionedPackage -Online -PackageName $pp.PackageName -ErrorAction Stop }
                catch { $errors += $_.Exception.Message }
            }
        }
    } catch { Write-VxLog 'warn' ('Bereitgestellte Pakete konnten nicht gelesen werden: ' + $_.Exception.Message) }
    if ($errors.Count -gt 0 -and $pkgs.Count -gt 0) {
        $still = @(Get-AppxPackage -AllUsers -Name $Package -ErrorAction SilentlyContinue)
        if ($still.Count -gt 0) { throw ("App '$Package' konnte nicht entfernt werden: " + ($errors -join '; ')) }
    }
}

# ================================================================== OS build

# Sets $VxCtx.Build / IsWin11 from the real system or the simulated profile.
function Initialize-VxOsInfo {
    $ctx = $global:VxCtx
    if ($ctx.Windows) {
        try {
            $v = Get-VxRealRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'CurrentBuildNumber'
            if ($v.exists) { $ctx.Build = [int]$v.value }
        } catch { $null = $_ }
        if ($ctx.Build -eq 0) { $ctx.Build = [Environment]::OSVersion.Version.Build }
    } else {
        $ctx.Build = 22631
    }
    $ctx.IsWin11 = ($ctx.Build -ge 22000)
}
