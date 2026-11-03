# VELOX - core/Bios.ps1
# BIOS-Optimierer: reads what the firmware set up (mainboard, BIOS, RAM profile, Resizable BAR,
# Secure Boot, TPM, virtualization, BitLocker, UEFI/legacy), compares it with the data-driven
# recommendations in data/bios/recommendations.json and returns a checklist. READ-ONLY: nothing is
# ever written to the BIOS / firmware. The only system action is the "Neustart ins BIOS" job
# (shutdown /r /fw), optionally after pausing BitLocker for exactly one restart.
#
# Pipeline: Get-VxBiosRaw (real reads, or a fixture PC in tests/fixtures/bios) -> ConvertTo-VxBiosFacts
# (all heuristics, pure) -> Get-VxBiosReport (applicability + status per item, warnings, summary).
# Only function definitions.

# ------------------------------------------------------------------ data

function Get-VxBiosDataFile {
    return [IO.Path]::Combine([IO.Path]::Combine([string]$global:VxCtx.DataDir, 'bios'), 'recommendations.json')
}

function Import-VxBiosData {
    $f = Get-VxBiosDataFile
    if (-not [IO.File]::Exists($f)) {
        # tests run on the fixture catalog: the BIOS texts always come from the app's own data folder
        $f = [IO.Path]::Combine([IO.Path]::Combine([IO.Path]::Combine([string]$global:VxCtx.AppRoot, 'data'), 'bios'), 'recommendations.json')
    }
    if (-not [IO.File]::Exists($f)) { throw 'Die BIOS-Empfehlungen (data\bios\recommendations.json) fehlen.' }
    return (Read-VxJsonFile $f)
}

# ------------------------------------------------------------------ raw data: fixture PC or this PC

# Fixture name/path for the simulated PC: $env:VELOX_BIOS_FIXTURE (Testmodus/off Windows only),
# $VxCtx.BiosFixture (tests), else the one that matches -SimProfile.
function Get-VxBiosFixtureFile {
    $ctx = $global:VxCtx
    $name = ''
    if ($ctx.ContainsKey('BiosFixture') -and $ctx.BiosFixture) { $name = [string]$ctx.BiosFixture }
    elseif ($ctx.Simulate -and $env:VELOX_BIOS_FIXTURE) { $name = [string]$env:VELOX_BIOS_FIXTURE }
    if (-not $name) {
        if (-not $ctx.Windows) {
            $name = 'asus-5800x3d'
            if ([string]$ctx.SimProfile -eq 'laptop') { $name = 'laptop-intel' }
        } else { return $null }
    }
    if ($name -match '[\\/]' -or $name.EndsWith('.json')) { return $name }
    return [IO.Path]::Combine([IO.Path]::Combine([IO.Path]::Combine([string]$ctx.AppRoot, 'tests'), 'fixtures'), 'bios') + [IO.Path]::DirectorySeparatorChar + $name + '.json'
}

function Get-VxBiosRaw {
    $fx = Get-VxBiosFixtureFile
    if ($fx) {
        if (-not [IO.File]::Exists($fx)) { throw ('BIOS-Testdaten nicht gefunden: ' + $fx) }
        return (Read-VxJsonFile $fx)
    }
    return (Get-VxBiosRealRaw)
}

function Get-VxFirmwareTypeNative {
    if (-not ('VeloxNative.Firmware' -as [type])) {
        $src = @'
using System;
using System.Runtime.InteropServices;
namespace VeloxNative {
  public static class Firmware {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFirmwareType(out int firmwareType);
    public static int Query() {
      int t;
      if (!GetFirmwareType(out t)) return 0;
      return t;
    }
  }
}
'@
        Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
    }
    $t = [VeloxNative.Firmware]::Query()
    if ($t -eq 2) { return 'uefi' }
    if ($t -eq 1) { return 'bios' }
    return $null
}

# BitLocker of the system drive: @{ protectionStatus; conversionStatus } / @{ none = $true } / $null (not readable).
function Get-VxBitLockerRaw {
    $drive = [string]$env:SystemDrive
    if (-not $drive) { $drive = 'C:' }
    try {
        $vol = @(Get-CimInstance -Namespace 'root/cimv2/Security/MicrosoftVolumeEncryption' -ClassName 'Win32_EncryptableVolume' -Filter ("DriveLetter='{0}'" -f $drive) -OperationTimeoutSec 15 -ErrorAction Stop)
    } catch { return $null }
    if ($vol.Count -eq 0) { return @{ none = $true } }
    $prot = [int]$vol[0].ProtectionStatus
    try { $prot = [int](Invoke-CimMethod -InputObject $vol[0] -MethodName 'GetProtectionStatus' -ErrorAction Stop).ProtectionStatus } catch { $null = $_ }
    $conv = $null
    try { $conv = [int](Invoke-CimMethod -InputObject $vol[0] -MethodName 'GetConversionStatus' -ErrorAction Stop).ConversionStatus } catch { $conv = $null }
    return @{ protectionStatus = $prot; conversionStatus = $conv }
}

# Everything the checklist needs, read from this PC. Each part on its own: a failure only leaves
# that part unknown. Nothing here writes anything.
function Get-VxBiosRealRaw {
    $ctx = $global:VxCtx
    $raw = [ordered]@{ admin = [bool]$ctx.Admin; now = (Get-Date).ToString('yyyy-MM-dd') }
    Set-VxProgress 0.1 'Lese Mainboard und BIOS ...'
    try { $b = @(Get-VxCim 'Win32_BaseBoard')[0]; $raw.baseBoard = @{ Manufacturer = [string]$b.Manufacturer; Product = [string]$b.Product } } catch { $null = $_ }
    try { $c = @(Get-VxCim 'Win32_ComputerSystem')[0]; $raw.computerSystem = @{ Manufacturer = [string]$c.Manufacturer; Model = [string]$c.Model; HypervisorPresent = [bool]$c.HypervisorPresent } } catch { $null = $_ }
    try {
        $bi = @(Get-VxCim 'Win32_BIOS')[0]
        $date = $null
        if ($bi.ReleaseDate) { $date = ([datetime]$bi.ReleaseDate).ToString('yyyy-MM-dd') }
        $raw.bios = @{ Manufacturer = [string]$bi.Manufacturer; SMBIOSBIOSVersion = [string]$bi.SMBIOSBIOSVersion; ReleaseDate = $date }
    } catch { $null = $_ }
    try {
        $ch = @()
        foreach ($e in @(Get-VxCim 'Win32_SystemEnclosure')) { $ch += @($e.ChassisTypes) }
        $bat = @()
        try { $bat = @(Get-VxCim 'Win32_Battery') } catch { $null = $_ }
        $raw.chassis = (Get-VxFormFactor $ch @($bat | ForEach-Object { @{ name = [string]$_.Name; deviceId = [string]$_.DeviceID } })).formFactor
    } catch { $null = $_ }
    Set-VxProgress 0.25 'Lese Prozessor und Arbeitsspeicher ...'
    try { $p = @(Get-VxCim 'Win32_Processor')[0]; $raw.processor = @{ Name = ([string]$p.Name).Trim(); Manufacturer = [string]$p.Manufacturer; VirtualizationFirmwareEnabled = $p.VirtualizationFirmwareEnabled } } catch { $null = $_ }
    try {
        $mem = @()
        foreach ($m in @(Get-VxCim 'Win32_PhysicalMemory')) {
            $mem += @{ Capacity = [double]$m.Capacity; Speed = [int]$m.Speed; ConfiguredClockSpeed = [int](Get-VxProp $m 'ConfiguredClockSpeed' 0); SMBIOSMemoryType = [int](Get-VxProp $m 'SMBIOSMemoryType' 0)
                DeviceLocator = [string]$m.DeviceLocator; BankLabel = [string]$m.BankLabel; PartNumber = ([string]$m.PartNumber).Trim(); Manufacturer = ([string]$m.Manufacturer).Trim() }
        }
        $raw.memory = $mem
    } catch { $null = $_ }
    Set-VxProgress 0.4 'Lese Grafikkarte ...'
    try {
        $g = @()
        foreach ($v in @(Get-VxCim 'Win32_VideoController')) { $g += @{ Name = ([string]$v.Name).Trim(); PNPDeviceID = [string]$v.PNPDeviceID } }
        $raw.gpus = $g
        if (@($g | Where-Object { (Get-VxGpuVendor ($_.Name + ' ' + $_.PNPDeviceID)) -eq 'nvidia' }).Count -gt 0) { $raw.nvidiaSmi = Get-VxNvidiaSmiMemory }
    } catch { $null = $_ }
    Set-VxProgress 0.55 'Lese Secure Boot, TPM und Virtualisierung ...'
    try { $raw.firmwareType = Get-VxFirmwareTypeNative } catch { $null = $_ }
    try {
        $sb = Get-VxRealRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\SecureBoot\State' 'UEFISecureBootEnabled'
        if ($sb.exists) { $raw.secureBoot = [int]$sb.value }
    } catch { $null = $_ }
    try {
        $t = @(Get-CimInstance -Namespace 'root/cimv2/Security/MicrosoftTpm' -ClassName 'Win32_Tpm' -OperationTimeoutSec 10 -ErrorAction Stop)
        if ($t.Count -eq 0) { $raw.tpm = @{ present = $false } }
        else { $raw.tpm = @{ present = $true; enabled = [bool]$t[0].IsEnabled_InitialValue; activated = [bool]$t[0].IsActivated_InitialValue; specVersion = [string]$t[0].SpecVersion; manufacturer = ([string]$t[0].ManufacturerIdTxt).Trim() } }
    } catch { $null = $_ }
    try {
        $dg = @(Get-VxCim 'Win32_DeviceGuard' 'root/Microsoft/Windows/DeviceGuard')[0]
        if ($dg) { $raw.deviceGuard = @{ vbs = [int]$dg.VirtualizationBasedSecurityStatus; services = @(@($dg.SecurityServicesRunning) | ForEach-Object { [int]$_ }) } }
    } catch { $null = $_ }
    try { $raw.vmUse = @(Get-VxVmUse) } catch { $null = $_ }
    Set-VxProgress 0.7 'Lese BitLocker ...'
    $bl = Get-VxBitLockerRaw
    if ($null -ne $bl) { $raw.bitlocker = $bl }
    try {
        $svc = @()
        foreach ($n in @('vgc', 'FACEIT')) { if (Get-Service -Name $n -ErrorAction SilentlyContinue) { $svc += $n } }
        $raw.services = $svc
    } catch { $null = $_ }
    return $raw
}

# nvidia-smi's memory report (English on every Windows language); $null when the tool is missing.
function Get-VxNvidiaSmiMemory {
    $cands = @([IO.Path]::Combine([IO.Path]::Combine([string]$env:SystemRoot, 'System32'), 'nvidia-smi.exe'))
    $pf = [string]$env:ProgramW6432
    if (-not $pf) { $pf = [string]$env:ProgramFiles }
    if ($pf) { $cands += [IO.Path]::Combine([IO.Path]::Combine([IO.Path]::Combine($pf, 'NVIDIA Corporation'), 'NVSMI'), 'nvidia-smi.exe') }
    foreach ($c in $cands) {
        if (-not [IO.File]::Exists($c)) { continue }
        $r = Invoke-VxNative -FilePath $c -Arguments @('-q', '-d', 'MEMORY') -TimeoutSec 15
        if ($r.ExitCode -eq 0 -and $r.Output) { return [string]$r.Output }
    }
    return $null
}

# Programs that need CPU virtualization (VMs, WSL, Android emulators, Docker). Names only.
function Get-VxVmUse {
    $out = New-Object System.Collections.Generic.List[string]
    $pf = [string]$env:ProgramW6432
    if (-not $pf) { $pf = [string]$env:ProgramFiles }
    $pf86 = [string]${env:ProgramFiles(x86)}
    $local = [string](Get-VxUserFolder 'localAppData')
    $sysDrive = [string]$env:SystemDrive
    $checks = @(
        @{ name = 'VirtualBox'; paths = @(($pf + '\Oracle\VirtualBox\VirtualBox.exe')) },
        @{ name = 'VMware'; paths = @(($pf86 + '\VMware\VMware Workstation\vmware.exe'), ($pf86 + '\VMware\VMware Player\vmplayer.exe'), ($pf + '\VMware\VMware Workstation\vmware.exe')) },
        @{ name = 'BlueStacks'; paths = @(($pf + '\BlueStacks_nxt\HD-Player.exe'), ($pf + '\BlueStacks\HD-Player.exe')) },
        @{ name = 'LDPlayer'; paths = @(($sysDrive + '\LDPlayer\LDPlayer9\dnplayer.exe'), ($sysDrive + '\LDPlayer\LDPlayer4.0\dnplayer.exe')) },
        @{ name = 'Nox'; paths = @(($pf86 + '\Nox\bin\Nox.exe'), ($pf + '\Nox\bin\Nox.exe')) },
        @{ name = 'MEmu'; paths = @(($pf + '\Microvirt\MEmu\MEmu.exe')) },
        @{ name = 'Docker'; paths = @(($pf + '\Docker\Docker\Docker Desktop.exe')) },
        @{ name = 'Android-Emulator'; paths = @(($local + '\Android\Sdk\emulator\emulator.exe')) }
    )
    foreach ($c in $checks) {
        foreach ($p in $c.paths) { try { if ($p -and [IO.File]::Exists($p)) { $out.Add($c.name); break } } catch { $null = $_ } }
    }
    try { if (@(Get-VxRealRegSubKeys 'HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss').Count -gt 0) { $out.Add('WSL') } } catch { $null = $_ }
    try { if (Get-Service -Name 'vmms' -ErrorAction SilentlyContinue) { $out.Add('Hyper-V') } } catch { $null = $_ }
    return @($out | Select-Object -Unique)
}

# Lower-case "name exe" lines of the games on this PC (the last detection, reused for 5 minutes).
function Get-VxBiosGameTexts {
    $ctx = $global:VxCtx
    $list = @()
    try { if ($ctx.Windows) { $list = @(Get-VxRealGames) } else { $list = @(Get-VxSimGames) } } catch { $list = @() }
    $list += @(@($ctx.Settings.games))
    $out = @()
    foreach ($g in $list) {
        if ($null -eq $g) { continue }
        $out += ([string](Get-VxProp $g 'name' '') + ' ' + (Get-VxPathLeaf ([string](Get-VxProp $g 'path' '')))).ToLowerInvariant()
    }
    return $out
}

# ------------------------------------------------------------------ heuristics (pure)

function Get-VxBoardVendor([string]$Text) {
    $t = ([string]$Text).ToLowerInvariant()
    if ($t -match 'asustek|\basus') { return 'asus' }
    if ($t -match 'micro-star|\bmsi\b') { return 'msi' }
    if ($t -match 'gigabyte|aorus') { return 'gigabyte' }
    if ($t -match 'asrock') { return 'asrock' }
    return 'generic'
}

function Get-VxBoardVendorName([string]$Vendor, [string]$Raw) {
    switch ($Vendor) { 'asus' { return 'ASUS' } 'msi' { return 'MSI' } 'gigabyte' { return 'Gigabyte' } 'asrock' { return 'ASRock' } }
    $r = ([string]$Raw) -replace '(?i),?\s*(inc\.?|ltd\.?|co\.?|corporation|corp\.?|gmbh|technology|computer)\b', ''
    return ($r -replace '\s+', ' ').Trim(' ', ',', '.')
}

# "yyyy-MM-dd" from a CIM date, a DateTime or a string; $null when unknown.
function ConvertTo-VxBiosDate($Value) {
    if ($null -eq $Value -or [string]$Value -eq '') { return $null }
    if ($Value -is [datetime]) { return $Value.ToString('yyyy-MM-dd') }
    $s = [string]$Value
    if ($s -match '^(\d{4})(\d{2})(\d{2})\d*') { return ('{0}-{1}-{2}' -f $Matches[1], $Matches[2], $Matches[3]) }
    if ($s -match '^(\d{4})-(\d{2})-(\d{2})') { return ('{0}-{1}-{2}' -f $Matches[1], $Matches[2], $Matches[3]) }
    if ($s -match '^(\d{1,2})/(\d{1,2})/(\d{4})') { return ('{0}-{1:D2}-{2:D2}' -f $Matches[3], [int]$Matches[1], [int]$Matches[2]) }
    return $null
}

function Get-VxMonthsBetween([string]$From, [string]$To) {
    if (-not $From -or -not $To) { return $null }
    try {
        $a = [datetime]::ParseExact($From, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
        $b = [datetime]::ParseExact($To, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
        $m = ($b.Year - $a.Year) * 12 + ($b.Month - $a.Month)
        if ($b.Day -lt $a.Day) { $m-- }
        return [math]::Max(0, $m)
    } catch { return $null }
}

# Tags the recommendations' "cpuTags" match: x3d, x3d-locked, x3d-tunable, x3d-dual, ryzen,
# ryzen-tunable, am5, raptor-lake, intel-k. Mobile chips (H/HS/HX/U suffix) get no tuning tags.
function Get-VxCpuTags([string]$Name) {
    $n = ([string]$Name)
    $tags = New-Object System.Collections.Generic.List[string]
    $mobile = ($n -match '(?i)\b\d{4,5}(H|HS|HX|U|P)\b') -or ($n -match '(?i)\bHX\b|\bmobile\b|\blaptop\b')
    if ($n -match '(?i)ryzen') {
        $tags.Add('ryzen')
        if ($n -match '(?i)\b(\d{4})X3D\b') {
            $num = [int]$Matches[1]
            $tags.Add('x3d')
            if ($num -lt 7000) { $tags.Add('x3d-locked') }
            else {
                $tags.Add('x3d-tunable')
                if (@(7900, 7950, 9900, 9950) -contains $num) { $tags.Add('x3d-dual') }
            }
        }
        if ($n -match '(?i)ryzen\s+(?:threadripper\s+)?\d\s+(?:pro\s+)?(\d)(\d{3})' -and -not $mobile) {
            $series = [int]$Matches[1]
            if (@(7, 9) -contains $series) { $tags.Add('am5') }
            if (@(5, 7, 9) -contains $series -and -not $tags.Contains('x3d-locked')) { $tags.Add('ryzen-tunable') }
        }
    }
    if ($n -match '(?i)core\(?(?:tm)?\)?\s+i[579]-?\s*(1[34])(\d{3})([A-Z]{0,2})\b') {
        $suffix = [string]$Matches[3]
        if (@('H', 'HX', 'U', 'P', 'HK') -notcontains $suffix.ToUpperInvariant()) { $tags.Add('raptor-lake') }
    }
    if ($n -match '(?i)\bi[3579]-\d{4,5}K[FS]?\b') { $tags.Add('intel-k') }
    return @($tags)
}

function Get-VxGpuTags([string]$Name) {
    $n = ([string]$Name)
    $tags = @()
    if ($n -match '(?i)\bRTX\s*(20|30|40|50)\d\d' -and [int]$Matches[1] -ge 30) { $tags += 'rebar-capable' }
    elseif ($n -match '(?i)\bRX\s*(6|7|9)\d{3}') { $tags += 'rebar-capable' }
    elseif ($n -match '(?i)\bArc\b') { $tags += 'rebar-capable' }
    return $tags
}

# "BAR1 Memory Usage / Total : 16384 MiB" -> 16384; $null when not found.
function Get-VxBar1MiB([string]$SmiText) {
    if (-not $SmiText) { return $null }
    $m = [regex]::Match($SmiText, 'BAR1 Memory Usage[\s\S]*?Total\s*:\s*(\d+)\s*MiB')
    if ($m.Success) { return [int]$m.Groups[1].Value }
    return $null
}

function Get-VxRamTypeName([int]$Smbios) {
    switch ($Smbios) { 20 { return 'DDR' } 21 { return 'DDR2' } 24 { return 'DDR3' } 26 { return 'DDR4' } 34 { return 'DDR5' } 30 { return 'LPDDR4' } 35 { return 'LPDDR5' } }
    return 'unknown'
}

# Rated speed (MT/s) a part number names: G.Skill F4-3600..., Corsair CMK..X4M2B3200C16, Kingston
# KF436C.. / HX436C.., Crucial BL..G32C.. / CP..G60C.., else a standalone known speed in it. 0 = none.
function Get-VxRamPartSpeed([string]$Part) {
    $p = ([string]$Part).Trim().ToUpperInvariant()
    if (-not $p) { return 0 }
    if ($p -match '^F[345]-(\d{4})') { return [int]$Matches[1] }
    if ($p -match 'X[345]M\d[A-Z](\d{4})C\d') { return [int]$Matches[1] }
    if ($p -match '^(?:KF|HX)[345](\d{2})C') { return ([int]$Matches[1]) * 100 }
    if ($p -match '^(?:BL|CP|CT)\d+G(\d{2})C') { return ([int]$Matches[1]) * 100 }
    $known = @(2400, 2666, 2800, 2933, 3000, 3200, 3333, 3466, 3600, 3733, 3800, 4000, 4133, 4266, 4400, 4600, 4800, 5200, 5600, 6000, 6200, 6400, 6600, 6800, 7000, 7200, 7600, 8000, 8200, 8400)
    foreach ($m in [regex]::Matches($p, '(?<!\d)(\d{4})(?!\d)')) {
        $v = [int]$m.Groups[1].Value
        if ($known -contains $v) { return $v }
    }
    return 0
}

# Win32_PhysicalMemory rows (CIM objects, hashtables or fixture objects) -> plain module list.
function ConvertTo-VxRamModules($Rows) {
    $out = @()
    foreach ($m in @($Rows)) {
        if ($null -eq $m) { continue }
        $out += @{
            sizeGB = [math]::Round([double](Get-VxProp $m 'Capacity' 0) / 1GB)
            speed = [int](Get-VxProp $m 'Speed' 0); configured = [int](Get-VxProp $m 'ConfiguredClockSpeed' 0)
            type = Get-VxRamTypeName ([int](Get-VxProp $m 'SMBIOSMemoryType' 0))
            locator = ([string](Get-VxProp $m 'DeviceLocator' '')).Trim(); bank = ([string](Get-VxProp $m 'BankLabel' '')).Trim()
            part = ([string](Get-VxProp $m 'PartNumber' '')).Trim(); maker = ([string](Get-VxProp $m 'Manufacturer' '')).Trim()
        }
    }
    return $out
}

# Is the RAM running at the speed it is sold for (XMP / EXPO / D.O.C.P. on)? Honest about doubt:
# returns @{ profile = on|off|unknown; confidence = high|medium|low; ratedMHz; configuredMHz; partMHz; type; reason }.
#  - SMBIOS "Speed" (what the module may run) or the speed in the part number clearly above the
#    configured speed -> off. Win32 reports MT/s as "MHz" - so do we.
#  - configured at/above the target and above the JEDEC base speed -> on.
#  - everything equal at a base speed (2133 / 2400 / 4800 ...) -> unknown: only the BIOS or the
#    label on the module tells whether it could do more.
function Get-VxRamProfileInfo($Modules) {
    $mods = @($Modules)
    $o = [ordered]@{ profile = 'unknown'; confidence = 'low'; ratedMHz = 0; configuredMHz = 0; partMHz = 0; type = 'unknown'; reason = '' }
    if ($mods.Count -eq 0) { $o.reason = 'Der Arbeitsspeicher konnte nicht ausgelesen werden.'; return $o }
    foreach ($m in $mods) {
        if ([int]$m.speed -gt $o.ratedMHz) { $o.ratedMHz = [int]$m.speed }
        if ([int]$m.configured -gt $o.configuredMHz) { $o.configuredMHz = [int]$m.configured }
        $ps = Get-VxRamPartSpeed ([string]$m.part)
        if ($ps -gt $o.partMHz) { $o.partMHz = $ps }
        if ([string]$m.type -ne 'unknown') { $o.type = [string]$m.type }
    }
    if ($o.configuredMHz -le 0) { $o.configuredMHz = $o.ratedMHz }
    $conf = $o.configuredMHz
    if ($conf -le 0) { $o.reason = 'Die RAM-Geschwindigkeit konnte nicht ausgelesen werden.'; return $o }
    $base = 2666
    if ($o.type -match 'DDR5') { $base = 4800 }
    elseif ($o.type -eq 'DDR3') { $base = 1600 }
    if ($o.ratedMHz -gt $conf + 100) {
        $o.profile = 'off'; $o.confidence = 'high'
        $o.reason = ('Dein RAM kann {0} MHz, läuft aber nur mit {1} MHz.' -f $o.ratedMHz, $conf)
        return $o
    }
    if ($o.partMHz -gt $conf + 100) {
        $o.profile = 'off'; $o.confidence = 'medium'
        $o.reason = ('Laut Typenbezeichnung ist dein RAM für {0} MHz gebaut, er läuft aber nur mit {1} MHz.' -f $o.partMHz, $conf)
        return $o
    }
    if ($conf -gt $base) {
        $o.profile = 'on'
        $o.confidence = 'high'
        if ($o.type -match 'DDR5' -and $conf -le 5600) { $o.confidence = 'medium' }
        if ($o.type -eq 'DDR4' -and $conf -le 3200) { $o.confidence = 'medium' }
        $o.reason = ('Dein RAM läuft mit {0} MHz – so schnell, wie er gebaut ist.' -f $conf)
        return $o
    }
    $o.profile = 'unknown'; $o.confidence = 'low'
    $o.reason = ('Dein RAM läuft mit {0} MHz, dem Grundtakt. Ob er mehr kann, steht auf dem Aufkleber am Riegel oder im BIOS beim RAM-Profil.' -f $conf)
    return $o
}

# Channel letter of a module from its slot names (DIMM_A2, ChannelA-DIMM1, P0 CHANNEL A, DDR5_B2, A1).
function Get-VxRamChannel($Module) {
    foreach ($t in @([string]$Module.locator, [string]$Module.bank)) {
        if (-not $t) { continue }
        # Intel 12th gen+: "Controller0-ChannelA-DIMM0" / "Controller1-ChannelA-DIMM0" are two channels
        if ($t -match '(?i)controller\s*(\d)\D*channel\s*([A-H])\b') { return ($Matches[1] + $Matches[2].ToUpperInvariant()) }
        if ($t -match '(?i)channel\s*([A-H])\b') { return $Matches[1].ToUpperInvariant() }
        if ($t -match '(?i)DIMM[\s_-]?([A-H])\d') { return $Matches[1].ToUpperInvariant() }
        if ($t -match '(?i)DDR\d?[\s_-]([A-H])\d') { return $Matches[1].ToUpperInvariant() }
        if ($t -match '(?i)^([A-H])\d(?:[\s_-]|$)') { return $Matches[1].ToUpperInvariant() }
    }
    return $null
}

# @{ dualChannel = yes|no|unknown; reason }
function Get-VxDualChannelInfo($Modules) {
    $mods = @($Modules)
    if ($mods.Count -eq 0) { return @{ dualChannel = 'unknown'; reason = 'Der Arbeitsspeicher konnte nicht ausgelesen werden.' } }
    if ($mods.Count -eq 1) { return @{ dualChannel = 'no'; reason = 'Es steckt nur ein RAM-Riegel im PC – das ist Single-Channel.' } }
    $letters = @{}
    $unknown = 0
    foreach ($m in $mods) {
        $c = Get-VxRamChannel $m
        if ($c) { $letters[$c] = 1 + [int](Get-VxProp $letters $c 0) } else { $unknown++ }
    }
    if ($letters.Count -ge 2) { return @{ dualChannel = 'yes'; reason = ('{0} Riegel, verteilt auf {1} Kanäle – so ist es richtig.' -f $mods.Count, $letters.Count) } }
    if ($letters.Count -eq 1 -and $unknown -eq 0) {
        $who = 'Beide Riegel stecken'
        if ($mods.Count -gt 2) { $who = ('Alle {0} Riegel stecken' -f $mods.Count) }
        return @{ dualChannel = 'no'; reason = ($who + ' im selben Kanal – sie sollten auf zwei Kanäle verteilt sein.') }
    }
    return @{ dualChannel = 'unknown'; reason = ('{0} Riegel gefunden; die Steckplatz-Namen verraten nicht, ob sie in zwei Kanälen stecken.' -f $mods.Count) }
}

function Test-VxBiosGameMatch($Game, [string[]]$Texts, [string[]]$Services) {
    foreach ($s in @(Get-VxProp $Game 'services' @())) {
        foreach ($x in @($Services)) { if ([string]::Equals([string]$s, [string]$x, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
    }
    foreach ($m in @(Get-VxProp $Game 'match' @())) {
        $needle = ([string]$m).ToLowerInvariant()
        foreach ($t in @($Texts)) { if ($t -and $t.Contains($needle)) { return $true } }
    }
    return $false
}

# All heuristics in one place: raw readings -> facts. $GameTexts: lower-case "name exe" lines
# (the raw data's own "games" list wins when it has one); $Data: recommendations.json.
function ConvertTo-VxBiosFacts($Raw, $GameTexts, $Data) {
    $f = [ordered]@{}
    $now = ConvertTo-VxBiosDate (Get-VxProp $Raw 'now' $null)
    if (-not $now) { $now = (Get-Date).ToString('yyyy-MM-dd') }
    # --- board + BIOS
    $bb = Get-VxProp $Raw 'baseBoard'
    $cs = Get-VxProp $Raw 'computerSystem'
    $bbMan = [string](Get-VxProp $bb 'Manufacturer' '')
    $csMan = [string](Get-VxProp $cs 'Manufacturer' '')
    $vendor = Get-VxBoardVendor $bbMan
    if ($vendor -eq 'generic') { $vendor = Get-VxBoardVendor $csMan }
    $model = ([string](Get-VxProp $bb 'Product' '')).Trim()
    $sysModel = ([string](Get-VxProp $cs 'Model' '')).Trim()
    if (-not $model -or $model -match '(?i)^(base board|default string|to be filled.*|not applicable)$') { $model = $sysModel }
    $vendorRaw = $bbMan
    if (-not $vendorRaw -or $vendorRaw -match '(?i)default string|to be filled') { $vendorRaw = $csMan }
    $f.board = [ordered]@{ vendor = $vendor; vendorName = (Get-VxBoardVendorName $vendor $vendorRaw); model = $model }
    $bi = Get-VxProp $Raw 'bios'
    $bdate = ConvertTo-VxBiosDate (Get-VxProp $bi 'ReleaseDate' $null)
    $f.bios = [ordered]@{ vendor = ([string](Get-VxProp $bi 'Manufacturer' '')).Trim(); version = ([string](Get-VxProp $bi 'SMBIOSBIOSVersion' '')).Trim(); date = $bdate; ageMonths = (Get-VxMonthsBetween $bdate $now) }
    $ff = [string](Get-VxProp $Raw 'chassis' 'desktop')
    if (@('desktop', 'laptop') -notcontains $ff) { $ff = 'desktop' }
    $f.formFactor = $ff
    $f.admin = [bool](Get-VxProp $Raw 'admin' $true)
    # --- firmware
    $ft = [string](Get-VxProp $Raw 'firmwareType' '')
    $mode = 'unknown'
    if ($ft -eq 'uefi') { $mode = 'uefi' } elseif ($ft -eq 'bios' -or $ft -eq 'legacy') { $mode = 'legacy' }
    $sbRaw = Get-VxProp $Raw 'secureBoot' $null
    $sb = 'unknown'
    if ($mode -eq 'legacy') { $sb = 'off' }
    elseif ($null -ne $sbRaw -and [string]$sbRaw -ne '') { if ([int]$sbRaw -eq 1) { $sb = 'on' } else { $sb = 'off' } }
    if ($mode -eq 'unknown' -and $sb -ne 'unknown') { $mode = 'uefi' }   # the SecureBoot\State key only exists on UEFI
    $csm = 'unknown'
    if ($mode -eq 'legacy') { $csm = 'on' } elseif ($sb -eq 'on') { $csm = 'off' }
    $f.firmware = [ordered]@{ mode = $mode; secureBoot = $sb; csm = $csm }
    # --- CPU
    $pr = Get-VxProp $Raw 'processor'
    $cpuName = (([string](Get-VxProp $pr 'Name' '')) -replace '\s+', ' ').Trim()
    $man = ([string](Get-VxProp $pr 'Manufacturer' '')).ToLowerInvariant()
    $cv = 'other'
    if ($man -match 'amd' -or $cpuName -match '(?i)\bamd\b|ryzen') { $cv = 'amd' } elseif ($man -match 'intel' -or $cpuName -match '(?i)intel') { $cv = 'intel' }
    $ctags = @(Get-VxCpuTags $cpuName)
    $x3d = $null
    if ($ctags -contains 'x3d-locked') { $x3d = 'locked' } elseif ($ctags -contains 'x3d-dual') { $x3d = 'dual' } elseif ($ctags -contains 'x3d-tunable') { $x3d = 'tunable' }
    $f.cpu = [ordered]@{ name = $cpuName; vendor = $cv; tags = $ctags; x3d = $x3d }
    # --- RAM
    $mods = @(ConvertTo-VxRamModules @(Get-VxProp $Raw 'memory' @()))
    $rp = Get-VxRamProfileInfo $mods
    $dc = Get-VxDualChannelInfo $mods
    $total = 0
    foreach ($m in $mods) { $total += [double]$m.sizeGB }
    $f.ram = [ordered]@{
        totalGB = $total; type = $rp.type; modules = $mods.Count
        slots = @($mods | ForEach-Object { [ordered]@{ slot = $_.locator; sizeGB = $_.sizeGB; speed = $_.speed; configured = $_.configured; part = $_.part } })
        ratedMHz = $rp.ratedMHz; configuredMHz = $rp.configuredMHz; partMHz = $rp.partMHz
        profile = $rp.profile; profileConfidence = $rp.confidence; profileReason = $rp.reason
        dualChannel = $dc.dualChannel; dualChannelReason = $dc.reason
    }
    # --- GPU (the dedicated one first)
    $gpus = @(@(Get-VxProp $Raw 'gpus' @()) | Where-Object { $_ -and ([string](Get-VxProp $_ 'Name' '')) -notmatch 'Microsoft Basic|Remote Display|Parsec|Virtual Display|Meta Virtual|IddSampleDriver' })
    $gpu = $null
    foreach ($g in $gpus) { $v = Get-VxGpuVendor ([string](Get-VxProp $g 'Name' '') + ' ' + [string](Get-VxProp $g 'PNPDeviceID' '')); if ($v -eq 'nvidia' -or $v -eq 'amd') { $gpu = $g; break } }
    if ($null -eq $gpu) { foreach ($g in $gpus) { if ((Get-VxGpuTags ([string](Get-VxProp $g 'Name' ''))).Count -gt 0) { $gpu = $g; break } } }
    if ($null -eq $gpu -and $gpus.Count -gt 0) { $gpu = $gpus[0] }
    $gName = ([string](Get-VxProp $gpu 'Name' '')).Trim()
    $gVendor = 'other'
    if ($gpu) { $gVendor = Get-VxGpuVendor ($gName + ' ' + [string](Get-VxProp $gpu 'PNPDeviceID' '')) }
    $rebar = 'unknown'; $src = $null
    $bar1 = $null
    if ($gVendor -eq 'nvidia') { $bar1 = Get-VxBar1MiB ([string](Get-VxProp $Raw 'nvidiaSmi' '')) }
    if ($null -ne $bar1) { $src = 'nvidia-smi'; if ($bar1 -gt 256) { $rebar = 'on' } else { $rebar = 'off' } }
    if ($mode -eq 'legacy') { $rebar = 'off'; $src = 'legacy' }
    $f.gpu = [ordered]@{ name = $gName; vendor = $gVendor; tags = @(Get-VxGpuTags $gName); rebar = $rebar; rebarSource = $src; bar1MiB = $bar1 }
    # --- TPM
    $tpm = Get-VxProp $Raw 'tpm'
    $tstate = 'unknown'; $tver = $null; $tkind = $null
    if ($null -ne $tpm) {
        if (-not [bool](Get-VxProp $tpm 'present' $false)) { $tstate = 'off' }
        else {
            $spec = [string](Get-VxProp $tpm 'specVersion' '')
            if ($spec -match '^\s*(\d+\.\d+)') { $tver = $Matches[1] }
            $on = [bool](Get-VxProp $tpm 'enabled' $true) -and [bool](Get-VxProp $tpm 'activated' $true)
            if (-not $on) { $tstate = 'off' } elseif ($tver -and $tver -ne '2.0') { $tstate = 'old' } else { $tstate = 'on' }
            $tm = ([string](Get-VxProp $tpm 'manufacturer' '')).Trim().ToUpperInvariant()
            if ($tm -eq 'AMD' -or $tm -eq 'INTC' -or $tm -eq 'INTEL' -or $tm -eq 'QCOM' -or $tm -eq 'MSFT') { $tkind = 'firmware' } elseif ($tm) { $tkind = 'discrete' }
        }
    }
    $f.tpm = [ordered]@{ state = $tstate; version = $tver; kind = $tkind }
    # --- games that need Secure Boot / TPM / VBS
    $texts = @()
    if (Test-VxProp $Raw 'games') { $texts = @(@(Get-VxProp $Raw 'games' @()) | ForEach-Object { ([string]$_).ToLowerInvariant() }) } else { $texts = @($GameTexts) }
    $services = @(@(Get-VxProp $Raw 'services' @()) | ForEach-Object { [string]$_ })
    $games = @()
    foreach ($g in @(Get-VxProp $Data 'games' @())) {
        if (Test-VxBiosGameMatch $g $texts $services) { $games += [ordered]@{ code = [string]$g.code; name = [string]$g.name; needs = @(@($g.needs) | ForEach-Object { [string]$_ }) } }
    }
    $f.games = $games
    # --- virtualization / VBS
    $dg = Get-VxProp $Raw 'deviceGuard'
    $vbs = $null; $hvci = $null
    if ($null -ne $dg) { $vbs = ([int](Get-VxProp $dg 'vbs' 0) -eq 2); $hvci = (@(@(Get-VxProp $dg 'services' @()) | ForEach-Object { [int]$_ }) -contains 2) }
    $hyper = [bool](Get-VxProp $cs 'HypervisorPresent' $false)
    $vfe = Get-VxProp $pr 'VirtualizationFirmwareEnabled' $null
    $vfw = 'unknown'
    if ($hyper -or $vbs) { $vfw = 'on' } elseif ($null -ne $vfe -and [string]$vfe -ne '') { if ([bool]$vfe) { $vfw = 'on' } else { $vfw = 'off' } }
    $uses = @(@(Get-VxProp $Raw 'vmUse' @()) | ForEach-Object { [string]$_ })
    $needVbs = @($games | Where-Object { @($_.needs) -contains 'vbs' } | ForEach-Object { $_.name })
    $advice = 'unknown'
    if ($uses.Count -gt 0 -or $needVbs.Count -gt 0) { $advice = 'needed' }
    elseif ($hyper -or $vbs) { $advice = 'optional' }
    elseif ($vfw -ne 'unknown') { $advice = 'nocost' }
    $f.virtualization = [ordered]@{ firmware = $vfw; hypervisor = $hyper; vbs = $vbs; hvci = $hvci; uses = $uses; advice = $advice }
    # --- BitLocker
    $bl = Get-VxProp $Raw 'bitlocker'
    $bls = 'unknown'
    if ($null -ne $bl) {
        if ([bool](Get-VxProp $bl 'none' $false)) { $bls = 'off' }
        else {
            $ps = [int](Get-VxProp $bl 'protectionStatus' 0)
            $cs2 = Get-VxProp $bl 'conversionStatus' $null
            if ($ps -eq 1) { $bls = 'on' }
            elseif ($null -ne $cs2 -and @(1, 2, 3, 4) -contains [int]$cs2) { $bls = 'suspended' }
            else { $bls = 'off' }
        }
    }
    $f.bitlocker = [ordered]@{ state = $bls }
    $f.now = $now
    return $f
}

# Facts of this PC (or the fixture PC). -NoGames skips the game library (overview profile).
function Get-VxBiosFacts([switch]$NoGames) {
    $data = Import-VxBiosData
    $raw = Get-VxBiosRaw
    $texts = @()
    if (-not $NoGames -and -not (Test-VxProp $raw 'games')) { $texts = @(Get-VxBiosGameTexts) }
    return (ConvertTo-VxBiosFacts $raw $texts $data)
}

# ------------------------------------------------------------------ recommendations

# "ram.profile" -> the value in the facts.
function Get-VxBiosFact($Facts, [string]$Path) {
    $cur = $Facts
    foreach ($p in $Path.Split('.')) { $cur = Get-VxProp $cur $p $null; if ($null -eq $cur) { return $null } }
    return $cur
}

# Does an item's "when" hold for these facts? Returns '' (yes) or a German reason (no).
function Test-VxBiosWhen($When, $Facts) {
    if ($null -eq $When) { return '' }
    $ff = Get-VxProp $When 'formFactor' $null
    if ($ff -and [string]$ff -ne [string]$Facts.formFactor) { if ($ff -eq 'desktop') { return 'Bei Laptops meist nicht einstellbar.' } else { return 'Nur bei Laptops.' } }
    $cv = Get-VxProp $When 'cpuVendor' $null
    if ($cv -and [string]$cv -ne [string]$Facts.cpu.vendor) { return 'Passt nicht zu deinem Prozessor.' }
    $ct = @(Get-VxProp $When 'cpuTags' @())
    if ($ct.Count -gt 0 -and @($ct | Where-Object { @($Facts.cpu.tags) -contains [string]$_ }).Count -eq 0) { return 'Passt nicht zu deinem Prozessor.' }
    $gt = @(Get-VxProp $When 'gpuTags' @())
    if ($gt.Count -gt 0 -and @($gt | Where-Object { @($Facts.gpu.tags) -contains [string]$_ }).Count -eq 0) { return 'Deine Grafikkarte unterstützt das nicht.' }
    $rt = @(Get-VxProp $When 'ramType' @())
    if ($rt.Count -gt 0 -and $rt -notcontains [string]$Facts.ram.type) { return 'Passt nicht zu deinem Arbeitsspeicher.' }
    return ''
}

# Short German note per item from the facts (why this status).
function Get-VxBiosItemNote([string]$Id, $Facts, [string]$Status, [string[]]$NeededBy) {
    switch ($Id) {
        'ram-profile' {
            $t = [string]$Facts.ram.profileReason
            if ($Facts.ram.profile -eq 'off' -and $Facts.ram.profileConfidence -ne 'high') { $t += ' Das ist eine Schätzung – prüf es im BIOS.' }
            return $t
        }
        'dual-channel' { return [string]$Facts.ram.dualChannelReason }
        'rebar' {
            if ($Facts.gpu.rebarSource -eq 'legacy') { return 'Geht erst, wenn Windows im UEFI-Modus startet.' }
            if ($Facts.gpu.rebarSource -eq 'nvidia-smi') { if ($Facts.gpu.rebar -eq 'on') { return ('Laut NVIDIA-Treiber an ({0} MiB BAR1).' -f $Facts.gpu.bar1MiB) } else { return 'Laut NVIDIA-Treiber aus (BAR1 nur 256 MiB).' } }
            return 'Bei dieser Grafikkarte kann Windows das nicht sicher auslesen.'
        }
        'uefi-csm' {
            if ($Facts.firmware.mode -eq 'legacy') { return 'Windows startet im Legacy-Modus – erst MBR2GPT, sonst startet Windows nicht mehr.' }
            if ($Facts.firmware.csm -eq 'off') { return 'Windows startet im UEFI-Modus mit Secure Boot – CSM ist damit aus.' }
            if ($Facts.firmware.mode -eq 'uefi') { return 'Windows startet im UEFI-Modus. Ob CSM im BIOS noch an ist, sieht man nur dort.' }
            return ''
        }
        'secure-boot' {
            if ($Facts.firmware.mode -eq 'legacy') { return 'Geht erst, wenn Windows im UEFI-Modus startet (siehe „CSM aus“).' }
            if ($Status -eq 'todo' -and $NeededBy.Count -gt 0) { return ('Ohne Secure Boot ' + (Get-VxGermanVerb $NeededBy 'startet' 'starten') + ' ' + (Join-VxGermanList $NeededBy) + ' nicht.') }
            return ''
        }
        'tpm' {
            if ($Facts.tpm.state -eq 'old') { return ('TPM {0} gefunden – Windows 11 und Anti-Cheats brauchen 2.0.' -f $Facts.tpm.version) }
            if ($Facts.tpm.state -eq 'unknown') { return 'Nur mit Adminrechten auslesbar.' }
            if ($Facts.tpm.kind -eq 'firmware' -and $Status -eq 'ok') { return 'Firmware-TPM im Prozessor ist an.' }
            if ($Status -eq 'todo' -and $NeededBy.Count -gt 0) { return ('Ohne TPM 2.0 ' + (Get-VxGermanVerb $NeededBy 'startet' 'starten') + ' ' + (Join-VxGermanList $NeededBy) + ' nicht.') }
            return ''
        }
        'virtualization' {
            $v = $Facts.virtualization
            if (@($v.uses).Count -gt 0) { return ('An lassen – du nutzt ' + (Join-VxGermanList @($v.uses)) + '.') }
            if ($NeededBy.Count -gt 0) { return ('An lassen – ' + (Join-VxGermanList $NeededBy) + ' ' + (Get-VxGermanVerb $NeededBy 'braucht' 'brauchen') + ' VBS.') }
            if ($v.advice -eq 'nocost') { return 'Windows nutzt die Virtualisierung gerade nicht – sie kostet dich keine FPS.' }
            if ($v.advice -eq 'optional') { return 'Windows nutzt sie gerade für VBS. Keine VMs, kein WSL, keine Emulatoren gefunden.' }
            return ''
        }
    }
    return ''
}

# The checklist for these facts. Returns @{ items; warnings; summary; vendor; cpuVendor; games }.
function Get-VxBiosReport($Facts, $Data) {
    $items = New-Object System.Collections.ArrayList
    $hidden = New-Object System.Collections.ArrayList
    $sum = [ordered]@{ ok = 0; todo = 0; unknown = 0; total = 0 }
    foreach ($it in @($Data.items)) {
        $id = [string]$it.id
        $why = Test-VxBiosWhen (Get-VxProp $it 'when' $null) $Facts
        if ($why) { [void]$hidden.Add([ordered]@{ id = $id; reason = $why }); continue }
        $status = 'unknown'
        $chk = Get-VxProp $it 'check' $null
        if ($null -ne $chk) {
            $val = [string](Get-VxBiosFact $Facts ([string]$chk.fact))
            if (@(Get-VxProp $chk 'ok' @()) -contains $val) { $status = 'ok' }
            elseif (@(Get-VxProp $chk 'todo' @()) -contains $val) { $status = 'todo' }
        }
        $feature = [string](Get-VxProp $it 'feature' '')
        $needed = @()
        if ($feature) { $needed = @(@($Facts.games) | Where-Object { @($_.needs) -contains $feature } | ForEach-Object { [string]$_.name }) }
        $prio = 'normal'
        if ($status -eq 'todo' -and $needed.Count -gt 0 -and [string](Get-VxProp $it 'direction' 'on') -eq 'on') { $prio = 'high' }
        $row = [ordered]@{ id = $id; code = [string]$it.code; section = [string]$it.section; status = $status; priority = $prio; neededBy = $needed; note = (Get-VxBiosItemNote $id $Facts $status $needed) }
        [void]$items.Add($row)
        if ([string]$it.section -eq 'core') {
            $sum.total++
            $sum[$status] = 1 + [int]$sum[$status]
        }
    }
    $f = $Facts
    $warn = New-Object System.Collections.ArrayList
    $needVbs = @(@($f.games) | Where-Object { @($_.needs) -contains 'vbs' }).Count -gt 0
    foreach ($w in @($Data.warnings)) {
        $on = $false
        $detail = ''
        switch ([string]$w.id) {
            'legacy-boot' { $on = ($f.firmware.mode -eq 'legacy') }
            'intel-microcode' { $on = (@($f.cpu.tags) -contains 'raptor-lake' -and $f.formFactor -eq 'desktop' -and $f.bios.date -and [string]$f.bios.date -lt '2024-10-01') }
            'bios-old' {
                $on = ($null -ne $f.bios.ageMonths -and [int]$f.bios.ageMonths -ge 24)
                if ($on) { $detail = ('Deine Version {0} ist vom {1} – {2} Monate alt.' -f $f.bios.version, (ConvertTo-VxGermanDate $f.bios.date), $f.bios.ageMonths) }
            }
            'bitlocker' { $on = ($f.bitlocker.state -eq 'on') }
            'vbs-fps' { $on = ($f.virtualization.vbs -eq $true -and -not $needVbs) }
            'laptop' { $on = ($f.formFactor -eq 'laptop') }
            'vendor-unknown' { $on = ($f.board.vendor -eq 'generic') }
            'not-admin' { $on = (-not $f.admin) }
        }
        if ($on) {
            $o = [ordered]@{ id = [string]$w.id; code = [string]$w.code; severity = [string]$w.severity; detail = $detail }
            $tw = Get-VxProp $w 'tweak' $null
            if ($tw) { $o['tweak'] = [string]$tw }
            [void]$warn.Add($o)
        }
    }
    return [ordered]@{ items = $items.ToArray(); hidden = $hidden.ToArray(); warnings = $warn.ToArray(); summary = $sum; vendor = [string]$f.board.vendor; cpuVendor = [string]$f.cpu.vendor; games = @($f.games) }
}

# "A", "A und B", "A, B und C"
function Join-VxGermanList([string[]]$Items) {
    $a = @($Items)
    if ($a.Count -le 1) { return ($a -join '') }
    return ((@($a[0..($a.Count - 2)]) -join ', ') + ' und ' + $a[$a.Count - 1])
}

function Get-VxGermanVerb([string[]]$Items, [string]$One, [string]$Many) {
    if (@($Items).Count -eq 1) { return $One }
    return $Many
}

function ConvertTo-VxGermanDate([string]$Iso) {
    if ($Iso -match '^(\d{4})-(\d{2})-(\d{2})$') { return ('{0}.{1}.{2}' -f $Matches[3], $Matches[2], $Matches[1]) }
    return [string]$Iso
}

# Can "Neustart ins BIOS" work here? @{ available; reason; bitlocker }
function Get-VxBiosRebootInfo($Facts) {
    $ctx = $global:VxCtx
    $o = [ordered]@{ available = $true; reason = ''; bitlocker = [string]$Facts.bitlocker.state; recoveryUrl = 'https://aka.ms/myrecoverykey' }
    if ($Facts.firmware.mode -eq 'legacy') { $o.available = $false; $o.reason = 'Dein PC startet im alten Legacy-Modus – dann geht der Neustart direkt ins BIOS nicht. Starte normal neu und drück beim Start die BIOS-Taste.' }
    elseif ($Facts.firmware.mode -ne 'uefi') { $o.available = $false; $o.reason = 'VELOX kann nicht erkennen, ob dein PC im UEFI-Modus startet. Starte normal neu und drück beim Start die BIOS-Taste.' }
    elseif ($ctx.Windows -and -not $ctx.Simulate -and -not $ctx.Admin) { $o.available = $false; $o.reason = 'Dafür braucht VELOX Administratorrechte.' }
    return $o
}

# Texts for the UI and the phone page: recommendations.json without the backend-only fields.
function Get-VxBiosTexts($Data) {
    $items = @()
    foreach ($it in @($Data.items)) {
        $o = [ordered]@{}
        foreach ($p in $it.PSObject.Properties) { if (@('when', 'check', 'feature', 'direction') -notcontains $p.Name) { $o[$p.Name] = $p.Value } }
        $items += $o
    }
    $games = @(@($Data.games) | ForEach-Object { [ordered]@{ code = [string]$_.code; name = [string]$_.name; needs = @($_.needs) } })
    return [ordered]@{ version = $Data.version; statusLabels = $Data.statusLabels; riskLabels = $Data.riskLabels; general = $Data.general; vendors = $Data.vendors; games = $games; items = $items; warnings = @($Data.warnings) }
}

# ------------------------------------------------------------------ jobs

function Invoke-VxBiosScanJob($Params) {
    $ctx = $global:VxCtx
    Set-VxProgress 0.03 'Lese BIOS und Mainboard ...'
    $data = Import-VxBiosData
    $raw = Get-VxBiosRaw
    Test-VxCancel
    $texts = @()
    if (-not (Test-VxProp $raw 'games')) {
        Set-VxProgress 0.8 'Prüfe deine Spiele ...'
        $texts = @(Get-VxBiosGameTexts)
    }
    $facts = ConvertTo-VxBiosFacts $raw $texts $data
    $rep = Get-VxBiosReport $facts $data
    # the Übersicht shows board, BIOS and RAM profile from the profile: keep it in step
    try {
        if ($null -ne $ctx.State.profile) { Set-VxProfileBoard $ctx.State.profile $facts; Save-VxState }
    } catch { $null = $_ }
    $s = $rep.summary
    Write-VxLog 'ok' ('BIOS-Check: {0} von {1} Punkten passen schon, {2} fehlen, {3} unklar.' -f $s.ok, $s.total, $s.todo, $s.unknown)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{
        facts = $facts; items = $rep.items; hidden = $rep.hidden; warnings = $rep.warnings; summary = $rep.summary
        vendor = $rep.vendor; cpuVendor = $rep.cpuVendor; games = $rep.games
        reboot = (Get-VxBiosRebootInfo $facts); texts = (Get-VxBiosTexts $data); scanned = (Get-VxNowIso)
    }
}

# Board, BIOS and RAM-profile summary in the hardware profile (Übersicht).
function Set-VxProfileBoard($VxProfile, $Facts) {
    $b = [ordered]@{ vendor = $Facts.board.vendor; vendorName = $Facts.board.vendorName; model = $Facts.board.model; biosVersion = $Facts.bios.version; biosDate = $Facts.bios.date; firmware = $Facts.firmware.mode }
    if ($VxProfile -is [System.Collections.IDictionary]) { $VxProfile['board'] = $b } else { $VxProfile | Add-Member -NotePropertyName 'board' -NotePropertyValue $b -Force }
    $ram = Get-VxProp $VxProfile 'ram' $null
    if ($null -eq $ram) { return }
    foreach ($k in @('profile', 'profileConfidence')) {
        $v = $Facts.ram[$k]
        if ($ram -is [System.Collections.IDictionary]) { $ram[$k] = $v } else { $ram | Add-Member -NotePropertyName $k -NotePropertyValue $v -Force }
    }
}

# Pauses BitLocker on the system drive for exactly one restart (what the BitLocker cmdlet with
# RebootCount 1 does). Returns $true when it is paused now.
function Suspend-VxBitLockerOnce {
    $drive = [string]$env:SystemDrive
    if (-not $drive) { $drive = 'C:' }
    $vol = @(Get-CimInstance -Namespace 'root/cimv2/Security/MicrosoftVolumeEncryption' -ClassName 'Win32_EncryptableVolume' -Filter ("DriveLetter='{0}'" -f $drive) -OperationTimeoutSec 15 -ErrorAction Stop)
    if ($vol.Count -eq 0) { return $false }
    $r = Invoke-CimMethod -InputObject $vol[0] -MethodName 'DisableKeyProtectors' -Arguments @{ DisableCount = [uint32]1 } -ErrorAction Stop
    return ([int]$r.ReturnValue -eq 0)
}

# "Neustart ins BIOS": shutdown /r /fw /t 10. params { suspendBitLocker }
function Invoke-VxBiosRebootJob($Params) {
    $ctx = $global:VxCtx
    $suspend = [bool](Get-VxProp $Params 'suspendBitLocker' $false)
    Set-VxProgress 0.2 'Prüfe, ob der Neustart ins BIOS geht ...'
    $raw = $null
    $mode = $null
    $bl = 'unknown'
    if ($ctx.Simulate -or -not $ctx.Windows) {
        $raw = Get-VxBiosRaw
        $facts = ConvertTo-VxBiosFacts $raw @() (Import-VxBiosData)
        $mode = $facts.firmware.mode
        $bl = $facts.bitlocker.state
    } else {
        try { $mode = Get-VxFirmwareTypeNative } catch { $mode = $null }
        if ($mode -eq 'bios') { $mode = 'legacy' }
        $b = Get-VxBitLockerRaw
        if ($null -ne $b -and -not $b.none -and [int]$b.protectionStatus -eq 1) { $bl = 'on' }
    }
    if ($mode -ne 'uefi') { throw 'Dein PC startet nicht im UEFI-Modus – der Neustart direkt ins BIOS geht dann nicht. Starte normal neu und drück beim Start die BIOS-Taste (meist Entf oder F2).' }
    $paused = $false
    if ($bl -eq 'on' -and $suspend) {
        Set-VxProgress 0.5 'Pausiere BitLocker für einen Neustart ...'
        if ($ctx.Simulate) {
            Write-VxLog 'info' '[Testmodus] BitLocker würde für genau einen Neustart pausiert.'
            $paused = $true
        } else {
            $ok = $false
            try { $ok = Suspend-VxBitLockerOnce } catch { $ok = $false }
            if (-not $ok) { throw 'BitLocker konnte nicht pausiert werden. Der PC wurde nicht neu gestartet. Halte deinen Wiederherstellungsschlüssel bereit (aka.ms/myrecoverykey) und versuch es ohne Pausieren – oder pausiere BitLocker selbst in der Systemsteuerung.' }
            $paused = $true
            Write-VxLog 'ok' 'BitLocker ist für den nächsten Start pausiert und schaltet sich danach von selbst wieder ein.'
        }
    }
    if ($ctx.Simulate) {
        Write-VxLog 'info' '[Testmodus] shutdown /r /fw /t 10 wurde nur protokolliert – der PC startet nicht neu.'
        Set-VxProgress 1 'Fertig'
        return [ordered]@{ ok = $true; simulated = $true; bitlockerPaused = $paused }
    }
    Set-VxProgress 0.8 'Plane den Neustart ins BIOS ...'
    $r = Invoke-VxNative -FilePath (Get-VxSystemTool 'shutdown.exe') -Arguments @('/r', '/fw', '/t', '10', '/c', 'VELOX: Neustart ins BIOS in 10 Sekunden') -TimeoutSec 20
    if ($r.ExitCode -ne 0) {
        throw ('Windows konnte den Neustart ins BIOS nicht planen (' + ($r.Output + ' ' + $r.Error).Trim() + '). Starte normal neu und drück beim Start die BIOS-Taste (meist Entf oder F2).')
    }
    Write-VxLog 'ok' 'Der PC startet in 10 Sekunden neu – direkt ins BIOS.'
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ ok = $true; simulated = $false; bitlockerPaused = $paused }
}
