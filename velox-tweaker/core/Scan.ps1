# VELOX - core/Scan.ps1
# Hardware/system profile. No user names, computer names or serial numbers are collected.
# Every section has its own try/catch; CIM queries use -OperationTimeoutSec 10.
# Only function definitions.

function Get-VxCim([string]$Class, [string]$Namespace = 'root/cimv2', [string]$Filter = '') {
    $p = @{ ClassName = $Class; Namespace = $Namespace; OperationTimeoutSec = 10; ErrorAction = 'Stop' }
    if ($Filter) { $p.Filter = $Filter }
    return @(Get-CimInstance @p)
}

function Get-VxGpuVendor([string]$Text) {
    $t = ([string]$Text).ToLowerInvariant()
    if ($t -match 'ven_10de|nvidia|geforce|quadro|rtx|gtx') { return 'nvidia' }
    if ($t -match 'ven_1002|ven_1022|amd|radeon|ati ') { return 'amd' }
    if ($t -match 'ven_8086|intel|iris|uhd graphics|arc ') { return 'intel' }
    return 'other'
}

# ------------------------------------------------------------------ simulated profiles

function Get-VxSimProfile([string]$Kind = 'desktop') {
    if ($Kind -eq 'laptop') {
        return [ordered]@{
            os = [ordered]@{ caption = 'Windows 11 Home'; build = 22631; displayVersion = '23H2'; isWin11 = $true; edition = 'Core' }
            cpu = [ordered]@{ name = '12th Gen Intel(R) Core(TM) i7-12700H'; vendor = 'intel'; cores = 14; threads = 20; maxMHz = 2300 }
            gpus = @(
                [ordered]@{ name = 'NVIDIA GeForce RTX 3060 Laptop GPU'; vendor = 'nvidia'; vramGB = 6; driver = '31.0.15.5222' },
                [ordered]@{ name = 'Intel(R) Iris(R) Xe Graphics'; vendor = 'intel'; vramGB = 1; driver = '31.0.101.5186' }
            )
            ram = [ordered]@{ totalGB = 16; type = 'DDR4'; speedMHz = 3200; configuredMHz = 3200; modules = 2 }
            disks = @([ordered]@{ model = 'SAMSUNG MZVL2512HCJQ'; media = 'ssd'; bus = 'nvme'; sizeGB = 512 })
            systemDisk = 'ssd'
            systemDriveFreeGB = 38.5
            formFactor = 'laptop'
            battery = $true
            display = [ordered]@{ width = 1920; height = 1080; currentHz = 60; maxHz = 144 }
            power = [ordered]@{ activePlan = '381b4222-f694-41f0-9685-ff5bb260df2e'; name = 'Ausbalanciert' }
            security = [ordered]@{ vbs = $true; hvci = $true; defenderRealtime = $true }
            gaming = [ordered]@{ gameMode = $true; hags = $false; gameDvr = $true }
            network = @([ordered]@{ name = 'WLAN'; type = 'wifi'; linkMbps = 866 })
            startupCount = 0
            uptimeHours = 52.4
            tempMB = 1840
            foreignCount = $null
        }
    }
    return [ordered]@{
        os = [ordered]@{ caption = 'Windows 11 Pro'; build = 22631; displayVersion = '23H2'; isWin11 = $true; edition = 'Professional' }
        cpu = [ordered]@{ name = 'AMD Ryzen 7 5800X3D 8-Core Processor'; vendor = 'amd'; cores = 8; threads = 16; maxMHz = 3400 }
        gpus = @([ordered]@{ name = 'NVIDIA GeForce RTX 4070'; vendor = 'nvidia'; vramGB = 12; driver = '32.0.15.6094' })
        ram = [ordered]@{ totalGB = 32; type = 'DDR4'; speedMHz = 3600; configuredMHz = 2133; modules = 2 }
        disks = @(
            [ordered]@{ model = 'Samsung SSD 980 PRO 1TB'; media = 'ssd'; bus = 'nvme'; sizeGB = 1000 },
            [ordered]@{ model = 'ST2000DM008-2FR102'; media = 'hdd'; bus = 'sata'; sizeGB = 2000 }
        )
        systemDisk = 'ssd'
        systemDriveFreeGB = 182.3
        formFactor = 'desktop'
        battery = $false
        display = [ordered]@{ width = 2560; height = 1440; currentHz = 60; maxHz = 165 }
        power = [ordered]@{ activePlan = '381b4222-f694-41f0-9685-ff5bb260df2e'; name = 'Ausbalanciert' }
        security = [ordered]@{ vbs = $true; hvci = $true; defenderRealtime = $true }
        gaming = [ordered]@{ gameMode = $true; hags = $false; gameDvr = $true }
        network = @([ordered]@{ name = 'Ethernet'; type = 'ethernet'; linkMbps = 1000 })
        startupCount = 0
        uptimeHours = 196.5
        tempMB = 3420
        foreignCount = $null
    }
}

# Gaming flags read through the registry provider so simulate-mode changes show up.
function Get-VxGamingFlags {
    $g = [ordered]@{ gameMode = $null; hags = $null; gameDvr = $null }
    try {
        $gm = Get-VxRegValue 'HKCU\Software\Microsoft\GameBar' 'AutoGameModeEnabled'
        $g.gameMode = (-not $gm.exists) -or ([long]$gm.value -ne 0)
    } catch { $null = $_ }
    try {
        $h = Get-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' 'HwSchMode'
        $g.hags = ($h.exists -and [long]$h.value -eq 2)
    } catch { $null = $_ }
    try {
        $d = Get-VxRegValue 'HKCU\System\GameConfigStore' 'GameDVR_Enabled'
        $g.gameDvr = (-not $d.exists) -or ([long]$d.value -ne 0)
    } catch { $null = $_ }
    return $g
}

# ------------------------------------------------------------------ display (EnumDisplaySettings)

function Get-VxDisplayInfo {
    if (-not ('VeloxNative.Display' -as [type])) {
        $src = @'
using System;
using System.Runtime.InteropServices;
namespace VeloxNative {
  public static class Display {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE {
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
      public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
      public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
      public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
      public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
      public int dmDisplayFlags; public int dmDisplayFrequency;
      public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
      public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
    public static int[] Query() {
      DEVMODE cur = new DEVMODE(); cur.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(null, -1, ref cur)) return null;
      int max = cur.dmDisplayFrequency;
      for (int i = 0; i < 2000; i++) {
        DEVMODE m = new DEVMODE(); m.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        if (!EnumDisplaySettings(null, i, ref m)) break;
        if (m.dmPelsWidth == cur.dmPelsWidth && m.dmPelsHeight == cur.dmPelsHeight && m.dmDisplayFrequency > max) max = m.dmDisplayFrequency;
      }
      return new int[] { cur.dmPelsWidth, cur.dmPelsHeight, cur.dmDisplayFrequency, max };
    }
  }
}
'@
        Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
    }
    $r = [VeloxNative.Display]::Query()
    if ($null -eq $r) { return $null }
    return [ordered]@{ width = $r[0]; height = $r[1]; currentHz = $r[2]; maxHz = $r[3] }
}

# ------------------------------------------------------------------ temp size (quick, capped)

function Get-VxQuickFolderMB([string[]]$Paths, [int]$MaxFiles = 20000, [int]$MaxMs = 3000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $total = [long]0
    $count = 0
    foreach ($root in $Paths) {
        if (-not $root -or -not [IO.Directory]::Exists($root)) { continue }
        $stack = New-Object System.Collections.Generic.Stack[string]
        $stack.Push($root)
        while ($stack.Count -gt 0) {
            if ($count -ge $MaxFiles -or $sw.ElapsedMilliseconds -gt $MaxMs) { break }
            $d = $stack.Pop()
            try {
                $di = New-Object IO.DirectoryInfo($d)
                foreach ($f in $di.GetFiles()) { $total += $f.Length; $count++ }
                foreach ($s in $di.GetDirectories()) {
                    if (($s.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $stack.Push($s.FullName) }
                }
            } catch { $null = $_ }
        }
    }
    return [math]::Round($total / 1MB)
}

# ------------------------------------------------------------------ form factor

# Decides desktop vs. laptop. The chassis type wins: a desktop with a USB UPS (which Windows lists
# as Win32_Battery) stays a desktop. Batteries only decide when the chassis is unknown, and
# batteries that look like a UPS are ignored. Returns @{ formFactor; battery }.
function Get-VxFormFactor([object[]]$ChassisTypes, [object[]]$Batteries) {
    $laptopTypes = @(8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32)
    $desktopTypes = @(3, 4, 5, 6, 7, 13, 15, 16, 17, 23, 24, 28, 29, 34, 35, 36)
    $realBat = @(@($Batteries) | Where-Object {
            $null -ne $_ -and -not (([string](Get-VxProp $_ 'name') + ' ' + [string](Get-VxProp $_ 'deviceId')) -match '(?i)\bups\b|apc|eaton|cyberpower|back-?ups|smart-?ups|powerwalker|riello|salicru|bluewalker')
        })
    $hasBattery = ($realBat.Count -gt 0)
    $isLaptop = $false; $isDesktop = $false
    foreach ($ct in @($ChassisTypes)) {
        $n = 0
        if (-not [int]::TryParse([string]$ct, [ref]$n)) { continue }
        if ($laptopTypes -contains $n) { $isLaptop = $true }
        elseif ($desktopTypes -contains $n) { $isDesktop = $true }
    }
    $ff = 'desktop'
    if ($isLaptop) { $ff = 'laptop' }
    elseif (-not $isDesktop -and $hasBattery) { $ff = 'laptop' }
    # a battery in a desktop chassis is a UPS or similar - it must not count as "on battery" either
    $bat = $hasBattery
    if ($ff -eq 'desktop') { $bat = $false }
    return @{ formFactor = $ff; battery = $bat }
}

# ------------------------------------------------------------------ real profile

function Get-VxRealProfile {
    $p = [ordered]@{
        os = $null; cpu = $null; gpus = @(); ram = $null; disks = @(); systemDisk = 'unknown'; systemDriveFreeGB = $null
        formFactor = 'desktop'; battery = $false; display = $null; power = $null; security = $null; gaming = $null
        network = @(); startupCount = $null; uptimeHours = $null; tempMB = $null; foreignCount = $null
    }
    $osObj = $null
    Set-VxProgress -Step 'Lese Windows-Version ...'
    try {
        $osObj = @(Get-VxCim 'Win32_OperatingSystem')[0]
        $cv = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        $build = [int]$osObj.BuildNumber
        $dv = (Get-VxRealRegValue $cv 'DisplayVersion').value
        if (-not $dv) { $dv = (Get-VxRealRegValue $cv 'ReleaseId').value }
        $edition = [string](Get-VxRealRegValue $cv 'EditionID').value
        $caption = ([string]$osObj.Caption) -replace '^Microsoft\s+', ''
        # Windows 11 still reports "Windows 10" in some places
        if ($build -ge 22000) { $caption = $caption -replace 'Windows 10', 'Windows 11' }
        $p.os = [ordered]@{ caption = $caption.Trim(); build = $build; displayVersion = [string]$dv; isWin11 = ($build -ge 22000); edition = $edition }
    } catch {
        Write-VxLog 'warn' ('Windows-Version nicht lesbar: ' + $_.Exception.Message)
        $b = [int]$global:VxCtx.Build
        $p.os = [ordered]@{ caption = 'Windows'; build = $b; displayVersion = ''; isWin11 = ($b -ge 22000); edition = '' }
    }
    Set-VxProgress -Step 'Lese Prozessor und Grafikkarte ...'
    try {
        $cpus = @(Get-VxCim 'Win32_Processor')
        $c0 = $cpus[0]
        $man = ([string]$c0.Manufacturer).ToLowerInvariant()
        $vendor = 'unknown'
        if ($man -match 'intel') { $vendor = 'intel' } elseif ($man -match 'amd') { $vendor = 'amd' }
        $cores = 0; $threads = 0
        foreach ($c in $cpus) { $cores += [int]$c.NumberOfCores; $threads += [int]$c.NumberOfLogicalProcessors }
        $p.cpu = [ordered]@{ name = ([string]$c0.Name).Trim(); vendor = $vendor; cores = $cores; threads = $threads; maxMHz = [int]$c0.MaxClockSpeed }
    } catch { Write-VxLog 'warn' ('Prozessor nicht lesbar: ' + $_.Exception.Message) }
    try {
        # exact VRAM from the display class keys (Win32_VideoController.AdapterRAM caps at 4 GB)
        $vramByName = @{}
        $classKey = 'HKLM\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
        foreach ($sk in @(Get-VxRealRegSubKeys $classKey)) {
            if ($sk -notmatch '^\d{4}$') { continue }
            try {
                $k = $classKey + '\' + $sk
                $desc = (Get-VxRealRegValue $k 'DriverDesc').value
                $q = Get-VxRealRegValue $k 'HardwareInformation.qwMemorySize'
                if ($desc -and $q.exists) {
                    $bytes = [double]$q.value
                    if ($q.kind -eq 'Binary') { $bytes = [double][BitConverter]::ToUInt64((ConvertFrom-VxHex $q.value), 0) }
                    $vramByName[[string]$desc] = $bytes
                }
            } catch { $null = $_ }
        }
        $list = @()
        foreach ($g in @(Get-VxCim 'Win32_VideoController')) {
            $name = ([string]$g.Name).Trim()
            if ($name -match 'Microsoft Basic|Remote Display|Parsec|Virtual Display|Meta Virtual|IddSampleDriver') { continue }
            $vram = 0
            if ($vramByName.ContainsKey($name)) { $vram = $vramByName[$name] } elseif ($g.AdapterRAM) { $vram = [double]$g.AdapterRAM }
            $list += [ordered]@{ name = $name; vendor = (Get-VxGpuVendor ($name + ' ' + [string]$g.PNPDeviceID)); vramGB = [math]::Round($vram / 1GB, 1); driver = [string]$g.DriverVersion }
        }
        $p.gpus = $list
    } catch { Write-VxLog 'warn' ('Grafikkarte nicht lesbar: ' + $_.Exception.Message) }
    Set-VxProgress -Step 'Lese Arbeitsspeicher und Laufwerke ...'
    try {
        $mods = @(Get-VxCim 'Win32_PhysicalMemory')
        $total = [double]0; $speed = 0; $conf = 0; $type = 'unknown'
        foreach ($m in $mods) {
            $total += [double]$m.Capacity
            if ([int]$m.Speed -gt $speed) { $speed = [int]$m.Speed }
            $cs = 0
            if ($m.PSObject.Properties['ConfiguredClockSpeed']) { $cs = [int]$m.ConfiguredClockSpeed }
            if ($cs -gt $conf) { $conf = $cs }
            $smt = 0
            if ($m.PSObject.Properties['SMBIOSMemoryType']) { $smt = [int]$m.SMBIOSMemoryType }
            switch ($smt) { 20 { $type = 'DDR' } 21 { $type = 'DDR2' } 24 { $type = 'DDR3' } 26 { $type = 'DDR4' } 34 { $type = 'DDR5' } 30 { $type = 'LPDDR4' } 35 { $type = 'LPDDR5' } }
        }
        if ($conf -eq 0) { $conf = $speed }
        $p.ram = [ordered]@{ totalGB = [math]::Round($total / 1GB); type = $type; speedMHz = $speed; configuredMHz = $conf; modules = $mods.Count }
    } catch { Write-VxLog 'warn' ('Arbeitsspeicher nicht lesbar: ' + $_.Exception.Message) }
    try {
        $ns = 'root/Microsoft/Windows/Storage'
        $disks = @()
        $byNumber = @{}
        foreach ($d in @(Get-VxCim 'MSFT_PhysicalDisk' $ns)) {
            $media = 'unknown'
            switch ([int]$d.MediaType) { 3 { $media = 'hdd' } 4 { $media = 'ssd' } }
            $bus = 'other'
            switch ([int]$d.BusType) { 17 { $bus = 'nvme' } 11 { $bus = 'sata' } 7 { $bus = 'usb' } 8 { $bus = 'raid' } 10 { $bus = 'sas' } 3 { $bus = 'ata' } 12 { $bus = 'sd' } 15 { $bus = 'virtual' } }
            if ($bus -eq 'nvme' -and $media -eq 'unknown') { $media = 'ssd' }
            $o = [ordered]@{ model = ([string]$d.FriendlyName).Trim(); media = $media; bus = $bus; sizeGB = [math]::Round([double]$d.Size / 1e9) }
            $disks += $o
            $byNumber[[string]$d.DeviceId] = $o
        }
        $p.disks = $disks
        $sysLetter = ([string]$env:SystemDrive).TrimEnd(':')
        if (-not $sysLetter) { $sysLetter = 'C' }
        $part = @(Get-VxCim 'MSFT_Partition' $ns | Where-Object { [string]$_.DriveLetter -eq $sysLetter })
        if ($part.Count -gt 0) {
            $num = [string]$part[0].DiskNumber
            if ($byNumber.ContainsKey($num)) { $p.systemDisk = $byNumber[$num].media }
        }
        if ($p.systemDisk -eq 'unknown' -and $disks.Count -eq 1) { $p.systemDisk = $disks[0].media }
    } catch { Write-VxLog 'warn' ('Laufwerke nicht lesbar: ' + $_.Exception.Message) }
    try {
        $drive = New-Object IO.DriveInfo(([string]$env:SystemDrive) + '\')
        $p.systemDriveFreeGB = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
    } catch { $null = $_ }
    Set-VxProgress -Step 'Lese Gehäuse, Akku und Bildschirm ...'
    try {
        $bat = @()
        try { $bat = @(Get-VxCim 'Win32_Battery') } catch { $null = $_ }
        $chassis = @()
        foreach ($e in @(Get-VxCim 'Win32_SystemEnclosure')) { $chassis += @($e.ChassisTypes) }
        $ff = Get-VxFormFactor $chassis @($bat | ForEach-Object { @{ name = [string]$_.Name; deviceId = [string]$_.DeviceID; chemistry = [int]$_.Chemistry } })
        $p.formFactor = $ff.formFactor
        $p.battery = $ff.battery
    } catch { Write-VxLog 'warn' ('Gehäusetyp nicht lesbar: ' + $_.Exception.Message) }
    try { $p.display = Get-VxDisplayInfo } catch { Write-VxLog 'warn' ('Bildschirm über user32 nicht lesbar: ' + $_.Exception.Message) }
    if ($null -eq $p.display) {
        try {
            $vc = @(Get-VxCim 'Win32_VideoController' | Where-Object { $_.CurrentRefreshRate })[0]
            if ($vc) { $p.display = [ordered]@{ width = [int]$vc.CurrentHorizontalResolution; height = [int]$vc.CurrentVerticalResolution; currentHz = [int]$vc.CurrentRefreshRate; maxHz = [int]$vc.MaxRefreshRate } }
        } catch { $null = $_ }
    }
    try {
        $ap = Get-VxActivePlan
        $p.power = [ordered]@{ activePlan = $ap.guid; name = $ap.name }
    } catch { Write-VxLog 'warn' ('Energieplan nicht lesbar: ' + $_.Exception.Message) }
    Set-VxProgress -Step 'Lese Sicherheit, Netzwerk und Autostart ...'
    $sec = [ordered]@{ vbs = $null; hvci = $null; defenderRealtime = $null }
    try {
        $dg = @(Get-VxCim 'Win32_DeviceGuard' 'root/Microsoft/Windows/DeviceGuard')[0]
        if ($dg) {
            $sec.vbs = ([int]$dg.VirtualizationBasedSecurityStatus -eq 2)
            $sec.hvci = (@($dg.SecurityServicesRunning) -contains 2) -or (@($dg.SecurityServicesRunning) -contains [uint32]2)
        }
    } catch { $null = $_ }
    try {
        if (Get-Command -Name 'Get-MpComputerStatus' -ErrorAction SilentlyContinue) {
            $mp = Get-MpComputerStatus -ErrorAction Stop
            $sec.defenderRealtime = [bool]$mp.RealTimeProtectionEnabled
        }
    } catch { $null = $_ }
    $p.security = $sec
    $p.gaming = Get-VxGamingFlags
    try {
        $nets = @()
        foreach ($a in @(Get-VxCim 'MSFT_NetAdapter' 'root/StandardCimv2')) {
            if (-not $a.ConnectorPresent) { continue }
            if ([int]$a.MediaConnectState -ne 1) { continue }
            $type = $null
            switch ([int]$a.NdisPhysicalMedium) { 14 { $type = 'ethernet' } 9 { $type = 'wifi' } 0 { $type = 'ethernet' } }
            if (-not $type) { continue }
            $speed = 0
            if ($a.Speed) { $speed = [math]::Round([double]$a.Speed / 1e6) }
            $nets += [ordered]@{ name = [string]$a.Name; type = $type; linkMbps = $speed }
        }
        $p.network = $nets
    } catch { Write-VxLog 'warn' ('Netzwerk nicht lesbar: ' + $_.Exception.Message) }
    try {
        if ($null -ne $osObj -and $osObj.LastBootUpTime) {
            $p.uptimeHours = [math]::Round(((Get-Date) - [datetime]$osObj.LastBootUpTime).TotalHours, 1)
        }
    } catch { $null = $_ }
    return $p
}

# Full profile (real or simulated) + startupCount, uptime and temp size.
function Get-VxProfile {
    $ctx = $global:VxCtx
    if (-not $ctx.Windows) {
        $p = Get-VxSimProfile $ctx.SimProfile
        try {
            $ap = Get-VxActivePlan
            $p.power = [ordered]@{ activePlan = $ap.guid; name = $ap.name }
        } catch { $null = $_ }
        $g = Get-VxGamingFlags
        foreach ($k in @('gameMode', 'gameDvr')) { if ($null -ne $g[$k]) { $p.gaming[$k] = $g[$k] } }
        $h = Get-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' 'HwSchMode'
        if ($h.exists) { $p.gaming.hags = ([long]$h.value -eq 2) }
    } else {
        $p = Get-VxRealProfile
        try {
            $tmp = @((Get-VxUserFolder 'temp'), [IO.Path]::Combine([string]$env:SystemRoot, 'Temp'))
            $p.tempMB = Get-VxQuickFolderMB $tmp
        } catch { $null = $_ }
    }
    try { $p.startupCount = @(Get-VxStartupItems | Where-Object { $_.enabled }).Count } catch { $null = $_ }
    $prev = $ctx.State.profile
    if ($null -ne $prev) { $p.foreignCount = Get-VxProp $prev 'foreignCount' $null }
    return $p
}

function Invoke-VxScanJob($Params) {
    $ctx = $global:VxCtx
    Set-VxProgress 0.03 'Analysiere deinen PC ...'
    $ctx.Cache.Clear()
    $prof = Get-VxProfile
    $ctx.State.profile = $prof
    if ($null -ne $prof.os -and $prof.os.build) {
        $ctx.Build = [int]$prof.os.build
        $ctx.IsWin11 = ($ctx.Build -ge 22000)
    }
    Set-VxProgress 0.35 'Prüfe, welche Tweaks schon aktiv sind ...'
    Update-VxStatuses -ProgressFrom 0.35 -ProgressTo 0.97
    $ctx.State.lastScan = Get-VxNowIso
    Save-VxState
    $counts = @{}
    foreach ($v in @($ctx.State.statuses.Values)) { $counts[$v] = 1 + [int](Get-VxProp $counts $v 0) }
    Write-VxLog 'ok' ("Analyse fertig: {0} Tweaks aktiv, {1} auf Standard, {2} von anderen Tools geändert." -f [int](Get-VxProp $counts 'applied' 0), [int](Get-VxProp $counts 'default' 0), [int](Get-VxProp $counts 'custom' 0))
    Set-VxProgress 1 'Fertig'
    $st = Get-VxStateDto
    return [ordered]@{ profile = $prof; statuses = $st.statuses }
}

# ------------------------------------------------------------------ startup info (mode object)

# "Windows 11 Pro 23H2 (22631)" - from the registry on Windows, from the simulated profile elsewhere.
function Get-VxOsText {
    $ctx = $global:VxCtx
    if (-not $ctx.Windows) {
        $p = Get-VxSimProfile $ctx.SimProfile
        return ('{0} {1} ({2}) – simuliert' -f $p.os.caption, $p.os.displayVersion, $p.os.build)
    }
    try {
        $cv = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        $name = [string](Get-VxRealRegValue $cv 'ProductName').value
        $dv = [string](Get-VxRealRegValue $cv 'DisplayVersion').value
        if (-not $dv) { $dv = [string](Get-VxRealRegValue $cv 'ReleaseId').value }
        $build = [int]$ctx.Build
        if ($build -ge 22000) { $name = $name -replace 'Windows 10', 'Windows 11' }
        return (('{0} {1} ({2})' -f $name, $dv, $build) -replace '\s+', ' ').Trim()
    } catch { return ('Windows (Build {0})' -f $ctx.Build) }
}

# The account that owns the desktop (explorer.exe in VELOX's own session) when VELOX runs elevated
# as a DIFFERENT account - e.g. a child's standard account where a parent typed the admin password
# into the UAC prompt. Returns $null when it is the same account or cannot be determined, otherwise
# @{ name; sid; profile; localAppData; appData; temp; startup }. HKCU access, user folders (cleanup,
# game detection, autostart folder) and the app window profile are then redirected to this user.
function Get-VxDesktopUser {
    $ctx = $global:VxCtx
    if (-not $ctx.Windows -or -not $ctx.Admin) { return $null }
    try {
        $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
        $exp = @(Get-CimInstance -ClassName Win32_Process -Filter ("Name='explorer.exe' AND SessionId={0}" -f [int]$session) -OperationTimeoutSec 5 -ErrorAction Stop)
        if ($exp.Count -eq 0) { return $null }
        $o = Invoke-CimMethod -InputObject $exp[0] -MethodName GetOwnerSid -ErrorAction Stop
        $sid = [string]$o.Sid
        if ($sid -notmatch '^S-1-5-21-[0-9-]+$') { return $null }
        $me = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if ([string]::Equals($me, $sid, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        return (New-VxDesktopUserInfo $sid)
    } catch {
        Write-VxLog 'warn' ('Angemeldeter Benutzer nicht ermittelbar: ' + $_.Exception.Message)
        return $null
    }
}

# Folders of the user with the given SID, from that user's own registry hive.
function New-VxDesktopUserInfo([string]$Sid) {
    $name = $Sid
    try { $name = [string](New-Object Security.Principal.SecurityIdentifier($Sid)).Translate([Security.Principal.NTAccount]).Value } catch { $null = $_ }
    $prof = $null
    try {
        $v = Get-VxRealRegValue ('HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid) 'ProfileImagePath'
        if ($v.exists -and $v.value) { $prof = [Environment]::ExpandEnvironmentVariables([string]$v.value) }
    } catch { $null = $_ }
    if (-not $prof) { return $null }
    $expand = {
        param([string]$raw, [string]$fallback)
        if (-not $raw) { return $fallback }
        $x = [regex]::Replace($raw, '%USERPROFILE%', $prof.Replace('$', '$$'), [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        return [Environment]::ExpandEnvironmentVariables($x)
    }
    $usf = 'HKU\' + $Sid + '\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $read = {
        param([string]$key, [string]$name)
        try { $r = Get-VxRealRegValue $key $name; if ($r.exists) { return [string]$r.value } } catch { $null = $_ }
        return ''
    }
    $local = & $expand (& $read $usf 'Local AppData') ([IO.Path]::Combine($prof, 'AppData\Local'))
    $roaming = & $expand (& $read $usf 'AppData') ([IO.Path]::Combine($prof, 'AppData\Roaming'))
    $startup = & $expand (& $read $usf 'Startup') ([IO.Path]::Combine($roaming, 'Microsoft\Windows\Start Menu\Programs\Startup'))
    $temp = & $expand (& $read ('HKU\' + $Sid + '\Environment') 'TEMP') ([IO.Path]::Combine($local, 'Temp'))
    return @{ name = $name; sid = $Sid; profile = $prof; localAppData = $local; appData = $roaming; temp = $temp; startup = $startup }
}

# Kept for callers that only need the yes/no answer.
function Test-VxUserMismatch {
    return ($null -ne $global:VxCtx.DesktopUser)
}

# A per-user folder of the person sitting at the desktop: the desktop user's when VELOX runs as
# another account, otherwise this process's own. Kind: profile, localAppData, appData, temp, startup.
function Get-VxUserFolder([string]$Kind) {
    $du = $global:VxCtx.DesktopUser
    if ($null -ne $du -and $du.ContainsKey($Kind) -and $du[$Kind]) { return [string]$du[$Kind] }
    switch ($Kind) {
        'profile' { return [string]$env:USERPROFILE }
        'localAppData' { return [string]$env:LOCALAPPDATA }
        'appData' { return [string]$env:APPDATA }
        'temp' { return [string]$env:TEMP }
        'startup' { try { return [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup) } catch { return '' } }
    }
    return ''
}

# Expands %VARS% in a path; the per-user ones point at the desktop user (see Get-VxDesktopUser).
function Expand-VxUserPath([string]$Raw) {
    $x = [string]$Raw
    if ($null -ne $global:VxCtx.DesktopUser) {
        $map = @{ 'TEMP' = 'temp'; 'TMP' = 'temp'; 'LOCALAPPDATA' = 'localAppData'; 'APPDATA' = 'appData'; 'USERPROFILE' = 'profile' }
        foreach ($k in @($map.Keys)) {
            $val = [string](Get-VxUserFolder $map[$k])
            $x = [regex]::Replace($x, ('%' + $k + '%'), $val.Replace('$', '$$'), [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }
    return [Environment]::ExpandEnvironmentVariables($x)
}

# $true when a ps script works on per-user data (HKCU, user folders) and would therefore hit the
# wrong account while VELOX runs as a different user than the one at the desktop.
function Test-VxPerUserScript([string]$Source) {
    return ([string]$Source -match '(?i)HKCU:|HKEY_CURRENT_USER|Registry::HKCU|\$env:(LOCALAPPDATA|APPDATA|TEMP|TMP|USERPROFILE)\b|SpecialFolder\]::(LocalApplicationData|ApplicationData|UserProfile|Startup)|GetTempPath')
}

# Identifies the current boot; "needs reboot" flags are cleared when it changes.
function Get-VxBootId {
    if (-not $global:VxCtx.Windows) { return 'sim' }
    try {
        $os = @(Get-CimInstance -ClassName Win32_OperatingSystem -OperationTimeoutSec 10 -ErrorAction Stop)[0]
        return ([datetime]$os.LastBootUpTime).ToString('yyyyMMddHHmm')
    } catch { return $null }
}
