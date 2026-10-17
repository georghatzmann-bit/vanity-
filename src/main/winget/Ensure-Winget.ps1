<#
.SYNOPSIS
    Ensure-Winget.ps1 - make sure a working winget (App Installer,
    Microsoft.DesktopAppInstaller_8wekyb3d8bbwe) exists for the CURRENT user.
    Target: Windows PowerShell 5.1 (powershell.exe) on Windows 10 1809+ / 11.

.DESCRIPTION
    Order of attempts (each followed by a re-detect with polling):
      detect   : run winget --version via the full alias path (no PATH needed)
      register : Add-AppxPackage -RegisterByFamilyName           (no admin)
      store    : ask the Microsoft Store to update App Installer  (no admin; only with -StoreFirst here)
      module   : Microsoft.WinGet.Client + Repair-WinGetPackageManager
                 (no admin = current user; admin = -AllUsers / provisioned)
      manual   : download msixbundle + DesktopAppInstaller_Dependencies.zip
                 from the GitHub release and Add-AppxPackage them  (no admin;
                 admin additionally allows Add-AppxProvisionedPackage + license)
      store    : Store update as last resort (default position)
      source   : after success, make sure the 'winget' source can update
                 (re-add source2.msix: no admin; 'source reset --force': admin)

    Steps that NEED admin are only used when the process is elevated:
      Repair-WinGetPackageManager -AllUsers, Add-AppxProvisionedPackage,
      winget source reset --force, Install-Module/-PackageProvider -Scope AllUsers.

.OUTPUT
    One line per event on stdout (ASCII only), meant to be parsed by Node:
      PHX:STEP:<name>           a step starts
      PHX:INFO:<text>           diagnostics
      PHX:WARN:<text>           non-fatal problem
      PHX:PATH:<full path>      winget.exe path that worked; use it for all later calls
      PHX:OK:<version>          success, e.g. PHX:OK:1.29.380   -> exit code 0
      PHX:FAIL:<CODE>:<detail>  failure                         -> exit code 1

.EXAMPLE
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File Ensure-Winget.ps1
#>
[CmdletBinding()]
param(
    # Hard floor. winget older than 1.6.3482 talks to a retired CDN and can exit
    # silently (winget-cli doc/troubleshooting/README.md). --disable-interactivity
    # exists since 1.4.10173, export since 1.0.11451.
    [string]$MinVersion = '1.6.3482',

    # Known-good release used by the manual step. Hashes are the values published
    # next to the assets (Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.txt and
    # DesktopAppInstaller_Dependencies.txt) and in winget-pkgs (Microsoft.AppInstaller 1.29.380).
    [string]$PinnedTag    = 'v1.29.380',
    [string]$BundleSha256 = '65DEA9C01CE08EE7B763366B27C0E651F97DB857C11CA9B9C301826C10092F2E',
    [string]$DepsSha256   = 'BA875AFE9D190F61218985AC0292A99D1DB710BF93E13C68944CA9D89F0D82D1',
    [string]$LicenseName  = 'e53e159d00e04f729cc2180cffd1c02e_License1.xml',

    [string]$WorkDir = (Join-Path $env:TEMP 'PhoenixWinget'),
    [int]$StoreTimeoutSec = 300,
    [switch]$StoreFirst,
    [switch]$SkipStore,
    [switch]$SkipModule,
    [switch]$SkipSourceCheck
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # Invoke-WebRequest/Expand-Archive are very slow with progress bars
try {
    # PSGallery and GitHub require TLS 1.2; PS 5.1 may default to TLS 1.0.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$Pfn         = 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe'
$WindowsApps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
$Identity    = [Security.Principal.WindowsIdentity]::GetCurrent()
$IsAdmin     = ([Security.Principal.WindowsPrincipal]$Identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$IsSystem    = $Identity.IsSystem

# ---------------------------------------------------------------------------
# Output helper: exactly one ASCII line per message.
# ---------------------------------------------------------------------------
function Out-Phx {
    param([string]$Kind, [string]$Text)
    $clean = ([string]$Text -replace '[\r\n]+', ' ') -replace '[^\x20-\x7E]', '?'
    [Console]::Out.WriteLine('PHX:' + $Kind + ':' + $clean)
    [Console]::Out.Flush()
}

# ---------------------------------------------------------------------------
# Run an external exe with timeout. ErrorActionPreference is 'Continue' here so
# that stderr output or a failing exe never becomes a terminating error.
# stdin is redirected and closed immediately: a winget prompt then reads EOF
# instead of hanging forever.
# ---------------------------------------------------------------------------
function Invoke-Exe {
    param([string]$FilePath, [string]$Arguments, [int]$TimeoutSec = 60)
    $res = New-Object PSObject -Property @{ ExitCode = -1; StdOut = ''; StdErr = ''; Error = $null }
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName               = $FilePath
        $psi.Arguments              = $Arguments
        $psi.UseShellExecute        = $false
        $psi.CreateNoWindow         = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        $psi.RedirectStandardInput  = $true
        $p = New-Object System.Diagnostics.Process
        $p.StartInfo = $psi
        [void]$p.Start()
        $p.StandardInput.Close()
        $outTask = $p.StandardOutput.ReadToEndAsync()
        $errTask = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            try { $p.Kill() } catch { }
            $res.Error = 'timeout after ' + $TimeoutSec + 's'
        } else {
            $p.WaitForExit()   # lets the async readers finish
            $res.ExitCode = $p.ExitCode
            $res.StdOut   = [string]$outTask.Result
            $res.StdErr   = [string]$errTask.Result
        }
    } catch {
        # Win32Exception: file missing, or 'No applicable app licenses found'
        $res.Error = $_.Exception.Message
    } finally {
        $ErrorActionPreference = $oldEap
    }
    return $res
}

function Format-HResult {
    param([int]$Code)
    return ('0x{0:X8}' -f $Code)
}

# ---------------------------------------------------------------------------
# PATH handling for THIS process (we do not rely on it: full paths are used).
# ---------------------------------------------------------------------------
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user, $WindowsApps) | Where-Object { $_ }) -join ';'
}

# Persist %USERPROFILE%\AppData\Local\Microsoft\WindowsApps in the user PATH if
# it is missing. Keeps REG_EXPAND_SZ (SetEnvironmentVariable would write REG_SZ).
function Repair-UserPath {
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        if ($null -eq $key) { return }
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $expanded = [Environment]::ExpandEnvironmentVariables($raw)
        if ($expanded -notmatch [regex]::Escape($WindowsApps)) {
            $entry = '%USERPROFILE%\AppData\Local\Microsoft\WindowsApps'
            if ($raw) { $new = $raw.TrimEnd(';') + ';' + $entry } else { $new = $entry }
            $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
            Out-Phx 'INFO' 'userPath=added WindowsApps'
        }
        $key.Close()
    } catch {
        Out-Phx 'WARN' ('could not check user PATH: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------
function Get-WingetCandidates {
    $list = New-Object System.Collections.Generic.List[string]
    # 1) Per-package alias folder: exists even if the 'App execution alias'
    #    toggle for winget is switched off (used by Microsoft.WinGet.Client).
    $list.Add((Join-Path $WindowsApps ($Pfn + '\winget.exe')))
    # 2) The normal app execution alias.
    $list.Add((Join-Path $WindowsApps 'winget.exe'))
    # 3) Whatever PATH resolves (could be a stale copy; checked last).
    $cmd = Get-Command 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Path) { $list.Add([string]$cmd.Path) }
    return $list
}

function Get-AppInstallerVersion {
    try {
        $pkg = Get-AppxPackage -Name 'Microsoft.DesktopAppInstaller' -ErrorAction SilentlyContinue |
            Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
        if ($pkg) { return [string]$pkg.Version }
    } catch { }
    return 'none'
}

function Test-Winget {
    $min = [version]$MinVersion
    $reason = 'NO_WINGET:winget.exe alias not found'
    foreach ($exe in (Get-WingetCandidates)) {
        # File.Exists works on app execution alias reparse points.
        if (-not [IO.File]::Exists($exe)) { continue }
        $r = Invoke-Exe -FilePath $exe -Arguments '--version' -TimeoutSec 60
        if ($r.Error) {
            if ($r.Error -match 'licen') { $reason = 'NO_LICENSE:' + $r.Error } else { $reason = 'START_FAILED:' + $r.Error }
            continue
        }
        if ($r.ExitCode -ne 0) { $reason = 'EXIT:' + (Format-HResult $r.ExitCode); continue }
        $m = [regex]::Match([string]$r.StdOut, 'v?(\d+\.\d+\.\d+)')
        if (-not $m.Success) { $reason = 'NO_OUTPUT:winget --version printed nothing usable'; continue }
        $ver = [version]$m.Groups[1].Value
        if ($ver -lt $min) { $reason = 'TOO_OLD:' + $ver + ' < ' + $min; continue }
        return @{ Ok = $true; Version = $ver.ToString(); Path = $exe; Reason = '' }
    }
    return @{ Ok = $false; Version = ''; Path = ''; Reason = $reason }
}

# Registration and alias creation are asynchronous: poll for a while.
function Wait-Winget {
    param([int]$Seconds = 30)
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        Update-SessionPath
        $t = Test-Winget
        if ($t.Ok) { return $t }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)
    return $t
}

# ---------------------------------------------------------------------------
# Step (a): register the App Installer package that is already on the disk
# (provisioned in the image, or restored by 'Reset this PC'). No admin.
# ---------------------------------------------------------------------------
function Step-Register {
    Out-Phx 'STEP' 'register'
    try {
        Add-AppxPackage -RegisterByFamilyName -MainPackage $Pfn -ErrorAction Stop
        Out-Phx 'INFO' 'register=RegisterByFamilyName done'
    } catch {
        Out-Phx 'WARN' ('RegisterByFamilyName failed: ' + $_.Exception.Message)
    }
    if ($IsAdmin) {
        # Elevated only: -AllUsers lets us see a staged copy and register its manifest.
        try {
            $pkg = Get-AppxPackage -AllUsers -Name 'Microsoft.DesktopAppInstaller' -ErrorAction SilentlyContinue |
                Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
            if ($pkg -and $pkg.InstallLocation) {
                $manifest = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
                Add-AppxPackage -DisableDevelopmentMode -Register $manifest -ErrorAction Stop
                Out-Phx 'INFO' ('register=manifest ' + $pkg.Version)
            }
        } catch {
            Out-Phx 'WARN' ('manifest register failed: ' + $_.Exception.Message)
        }
    }
}

# ---------------------------------------------------------------------------
# Store step: ask the Microsoft Store to update App Installer (official channel,
# no GitHub). Uses the WinRT AppInstallManager API from PS 5.1. Best effort.
# ---------------------------------------------------------------------------
function Step-Store {
    Out-Phx 'STEP' 'store'
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $null = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager, Windows.ApplicationModel.Store.Preview.InstallControl, ContentType = WindowsRuntime]
        $null = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallItem, Windows.ApplicationModel.Store.Preview.InstallControl, ContentType = WindowsRuntime]
        $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1
        $mgr  = New-Object Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager
        $op   = $mgr.UpdateAppByPackageFamilyNameAsync($Pfn)
        $task = $asTaskGeneric.MakeGenericMethod([Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallItem]).Invoke($null, @($op))
        if (-not $task.Wait(90000)) { Out-Phx 'WARN' 'store: no answer within 90s'; return }
        $item = $task.Result
        if ($null -eq $item) { Out-Phx 'INFO' 'store=no update offered'; return }
        $deadline = (Get-Date).AddSeconds($StoreTimeoutSec)
        while ((Get-Date) -lt $deadline) {
            $st    = $item.GetCurrentStatus()
            $state = [string]$st.InstallState
            Out-Phx 'INFO' ('store=' + $state + ' ' + [int]$st.PercentComplete + '%')
            if ($state -eq 'Completed') { break }
            if ($state -eq 'Error' -or $state -eq 'Canceled') {
                $hr = 0
                if ($st.ErrorCode) { $hr = $st.ErrorCode.HResult }
                Out-Phx 'WARN' ('store: ' + $state + ' ' + (Format-HResult $hr))
                return
            }
            Start-Sleep -Seconds 3
        }
        # A fresh App Installer may need a registration nudge before the alias appears.
        try { Add-AppxPackage -RegisterByFamilyName -MainPackage $Pfn -ErrorAction Stop } catch { }
    } catch {
        Out-Phx 'WARN' ('store step failed: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# Step (b): Microsoft.WinGet.Client + Repair-WinGetPackageManager.
# Needs: NuGet provider (bootstrap via go.microsoft.com -> cdn.oneget.org),
# PSGallery, and the GitHub REST API (unauthenticated: 60 requests/hour/IP).
# ---------------------------------------------------------------------------
function Step-Module {
    Out-Phx 'STEP' 'module'
    if ($IsAdmin) { $scope = 'AllUsers' } else { $scope = 'CurrentUser' }   # PowerShellGet 1.x defaults to AllUsers = admin
    try {
        $nuget = Get-PackageProvider -ListAvailable -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'NuGet' -and $_.Version -ge [version]'2.8.5.201' }
        if (-not $nuget) {
            Out-Phx 'INFO' 'module=installing NuGet provider'
            Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope $scope -ErrorAction Stop | Out-Null
        }
        if (-not (Get-Module -ListAvailable -Name 'Microsoft.WinGet.Client')) {
            Out-Phx 'INFO' 'module=installing Microsoft.WinGet.Client'
            # -Force also suppresses the 'untrusted repository' confirmation.
            Install-Module -Name 'Microsoft.WinGet.Client' -Repository PSGallery -Scope $scope -Force -ErrorAction Stop
        }
        Import-Module 'Microsoft.WinGet.Client' -Force -ErrorAction Stop
        $done = $false
        if ($IsAdmin) {
            try {
                Out-Phx 'INFO' 'module=Repair-WinGetPackageManager -AllUsers -Latest -Force'
                Repair-WinGetPackageManager -AllUsers -Latest -Force -ErrorAction Stop | Out-Null
                $done = $true
            } catch {
                Out-Phx 'WARN' ('repair -AllUsers failed: ' + $_.Exception.Message)
            }
        }
        if (-not $done) {
            Out-Phx 'INFO' 'module=Repair-WinGetPackageManager -Latest -Force'
            Repair-WinGetPackageManager -Latest -Force -ErrorAction Stop | Out-Null
        }
        Out-Phx 'INFO' 'module=repair finished'
    } catch {
        Out-Phx 'WARN' ('module step failed: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# Step (c): manual install from the GitHub release (no GitHub API needed).
# ---------------------------------------------------------------------------
function Get-NativeArch {
    $a = $null
    try {
        $a = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE
    } catch { }
    if (-not $a) { if ($env:PROCESSOR_ARCHITEW6432) { $a = $env:PROCESSOR_ARCHITEW6432 } else { $a = $env:PROCESSOR_ARCHITECTURE } }
    switch (([string]$a).ToUpperInvariant()) {
        'ARM64' { return 'arm64' }
        'X86'   { return 'x86' }
        default { return 'x64' }
    }
}

# Streamed download with progress lines (PHX:INFO:progress=<file> <pct>).
# HttpWebRequest follows the github.com -> release-assets.githubusercontent.com redirect.
function Save-Url {
    param([string]$Url, [string]$OutFile)
    $label = Split-Path -Leaf $OutFile
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = 'Phoenix-Ensure-Winget'
    $req.AllowAutoRedirect = $true
    $req.Timeout = 60000
    $req.ReadWriteTimeout = 120000
    $resp = $req.GetResponse()
    try {
        $total = $resp.ContentLength
        $in  = $resp.GetResponseStream()
        $out = [System.IO.File]::Create($OutFile)
        try {
            $buf = New-Object byte[] 1048576
            $done = [long]0
            $last = -5
            while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                $out.Write($buf, 0, $n)
                $done += $n
                if ($total -gt 0) {
                    $pct = [int][math]::Floor(100 * $done / $total)
                    if ($pct -ge $last + 5) { Out-Phx 'INFO' ('progress=' + $label + ' ' + $pct); $last = $pct }
                }
            }
        } finally { $out.Close(); $in.Close() }
    } finally { $resp.Close() }
}

# Sources: array of @{ Url = '...'; Sha = '...' or '' }. First one that works wins.
function Get-Download {
    param([object[]]$Sources, [string]$OutFile)
    foreach ($s in $Sources) {
        try {
            Out-Phx 'INFO' ('download=' + $s.Url)
            if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
            Save-Url -Url $s.Url -OutFile $OutFile
            if ($s.Sha) {
                $h = (Get-FileHash -LiteralPath $OutFile -Algorithm SHA256).Hash
                if ($h -ne $s.Sha.ToUpperInvariant()) { throw ('SHA256 mismatch: ' + $h) }
            }
            return $true
        } catch {
            Out-Phx 'WARN' ('download failed: ' + $_.Exception.Message)
        }
    }
    return $false
}

function Test-FrameworkPresent {
    param([string]$Name, [version]$MinVer, [string]$Arch)
    $hit = Get-AppxPackage -Name $Name -ErrorAction SilentlyContinue | Where-Object {
        ([string]$_.Architecture) -ieq $Arch -and ([version]$_.Version) -ge $MinVer
    }
    return [bool]$hit
}

function Step-Manual {
    Out-Phx 'STEP' 'manual'
    try {
        if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
        $arch   = Get-NativeArch
        $rel    = 'https://github.com/microsoft/winget-cli/releases/download/' + $PinnedTag + '/'
        $latest = 'https://github.com/microsoft/winget-cli/releases/latest/download/'
        Out-Phx 'INFO' ('arch=' + $arch + ' tag=' + $PinnedTag)

        # 1) Dependencies (VCLibs.140.00, VCLibs.140.00.UWPDesktop, WindowsAppRuntime.1.8 for 1.12+).
        $depsZip = Join-Path $WorkDir 'DesktopAppInstaller_Dependencies.zip'
        $ok = Get-Download -OutFile $depsZip -Sources @(
            @{ Url = $rel + 'DesktopAppInstaller_Dependencies.zip'; Sha = $DepsSha256 },
            @{ Url = $latest + 'DesktopAppInstaller_Dependencies.zip'; Sha = '' })
        $depPaths = @()
        if ($ok) {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $depDir = Join-Path $WorkDir ('deps-' + $arch)
            if (Test-Path -LiteralPath $depDir) { Remove-Item -LiteralPath $depDir -Recurse -Force }
            New-Item -ItemType Directory -Path $depDir -Force | Out-Null
            $zip = [System.IO.Compression.ZipFile]::OpenRead($depsZip)
            try {
                foreach ($e in $zip.Entries) {
                    # Entries look like 'x64/Microsoft.VCLibs.140.00_14.0.33519.0_x64.appx'
                    if ($e.FullName -like ($arch + '/*.appx') -or $e.FullName -like ($arch + '\*.appx')) {
                        $dest = Join-Path $depDir $e.Name
                        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
                        $depPaths += $dest
                    }
                }
            } finally { $zip.Dispose() }
            foreach ($d in $depPaths) {
                $leaf = Split-Path -Leaf $d
                $m = [regex]::Match($leaf, '^(?<n>.+)_(?<v>\d+\.\d+\.\d+\.\d+)_(?<a>[A-Za-z0-9]+)\.appx$')
                if ($m.Success -and (Test-FrameworkPresent -Name $m.Groups['n'].Value -MinVer ([version]$m.Groups['v'].Value) -Arch $arch)) {
                    Out-Phx 'INFO' ('dep present ' + $leaf)
                    continue
                }
                try {
                    Add-AppxPackage -Path $d -ErrorAction Stop
                    Out-Phx 'INFO' ('dep installed ' + $leaf)
                } catch {
                    Out-Phx 'WARN' ('dep ' + $leaf + ': ' + $_.Exception.Message)
                }
            }
        } else {
            Out-Phx 'WARN' 'dependencies zip not available; trying the bundle anyway'
        }

        # 2) The App Installer bundle (~207 MB for 1.29).
        $bundle = Join-Path $WorkDir 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle'
        $ok = Get-Download -OutFile $bundle -Sources @(
            @{ Url = $rel + 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle'; Sha = $BundleSha256 },
            @{ Url = $latest + 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle'; Sha = '' },
            @{ Url = 'https://aka.ms/getwinget'; Sha = '' })
        if (-not $ok) { Out-Phx 'WARN' 'bundle download failed'; return }
        try {
            Add-AppxPackage -Path $bundle -ForceApplicationShutdown -ErrorAction Stop
            Out-Phx 'INFO' 'bundle installed (current user)'
        } catch {
            $msg = $_.Exception.Message
            if ($msg -match '0x80073D06') {
                Out-Phx 'INFO' 'bundle: same or newer version already installed'
            } elseif ($depPaths.Count -gt 0) {
                Out-Phx 'WARN' ('bundle failed, retrying with -DependencyPath: ' + $msg)
                try {
                    Add-AppxPackage -Path $bundle -DependencyPath $depPaths -ForceApplicationShutdown -ErrorAction Stop
                    Out-Phx 'INFO' 'bundle installed with dependencies'
                } catch {
                    Out-Phx 'WARN' ('bundle with deps failed: ' + $_.Exception.Message)
                }
            } else {
                Out-Phx 'WARN' ('bundle failed: ' + $msg)
            }
        }

        # 3) Elevated only: provision machine-wide with the license file. Fixes
        #    'No applicable app licenses found' (ClipSVC has no license yet).
        if ($IsAdmin) {
            $t = Wait-Winget -Seconds 20
            if (-not $t.Ok) {
                $lic = Join-Path $WorkDir $LicenseName
                $haveLic = Get-Download -OutFile $lic -Sources @(@{ Url = $rel + $LicenseName; Sha = '' })
                try {
                    $prov = @{ Online = $true; PackagePath = $bundle; ErrorAction = 'Stop' }
                    if ($haveLic) { $prov['LicensePath'] = $lic } else { $prov['SkipLicense'] = $true }
                    if ($depPaths.Count -gt 0) { $prov['DependencyPackagePath'] = $depPaths }
                    Add-AppxProvisionedPackage @prov | Out-Null
                    Out-Phx 'INFO' 'bundle provisioned (all users)'
                    Add-AppxPackage -RegisterByFamilyName -MainPackage $Pfn -ErrorAction Stop
                } catch {
                    Out-Phx 'WARN' ('provisioning failed: ' + $_.Exception.Message)
                }
            }
        }
    } catch {
        Out-Phx 'WARN' ('manual step failed: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# Source check: make sure the 'winget' community source can be updated.
# Never fails the script (winget itself works); reports PHX:WARN instead.
# ---------------------------------------------------------------------------
function Step-Source {
    param([string]$Exe, [string]$Version)
    Out-Phx 'STEP' 'source'
    $args1 = 'source update --name winget --disable-interactivity'
    $r = Invoke-Exe -FilePath $Exe -Arguments $args1 -TimeoutSec 300
    if (-not $r.Error -and $r.ExitCode -eq 0) { Out-Phx 'INFO' 'source=ok'; return }
    Out-Phx 'WARN' ('source update failed: ' + $(if ($r.Error) { $r.Error } else { Format-HResult $r.ExitCode }))

    # Repair 1 (no admin): re-add the pre-indexed source package.
    # winget >= 1.10 uses source2.msix, older clients use source.msix.
    if ([version]$Version -ge [version]'1.10.0') { $srcName = 'source2.msix' } else { $srcName = 'source.msix' }
    try {
        if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
        $srcFile = Join-Path $WorkDir $srcName
        if (Get-Download -OutFile $srcFile -Sources @(@{ Url = 'https://cdn.winget.microsoft.com/cache/' + $srcName; Sha = '' })) {
            Add-AppxPackage -Path $srcFile -ErrorAction Stop
            Out-Phx 'INFO' ('source package re-added: ' + $srcName)
        }
    } catch {
        Out-Phx 'WARN' ('source package add failed: ' + $_.Exception.Message)
    }
    $r = Invoke-Exe -FilePath $Exe -Arguments $args1 -TimeoutSec 300
    if (-not $r.Error -and $r.ExitCode -eq 0) { Out-Phx 'INFO' 'source=ok after re-add'; return }

    # Repair 2 (admin only): reset sources to defaults. Agreements must be accepted again later.
    if ($IsAdmin) {
        $null = Invoke-Exe -FilePath $Exe -Arguments 'source reset --force --disable-interactivity' -TimeoutSec 120
        $r = Invoke-Exe -FilePath $Exe -Arguments $args1 -TimeoutSec 300
        if (-not $r.Error -and $r.ExitCode -eq 0) { Out-Phx 'INFO' 'source=ok after reset'; return }
    }
    Out-Phx 'WARN' 'source still failing (network? https://cdn.winget.microsoft.com/cache must be reachable)'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
try {
    if ($IsSystem) { Out-Phx 'FAIL' 'SYSTEM_ACCOUNT:winget does not support the LocalSystem account'; exit 1 }
    $os = [Environment]::OSVersion.Version
    Out-Phx 'INFO' ('os=' + $os + ' admin=' + $IsAdmin + ' ps=' + $PSVersionTable.PSVersion)
    if ($os.Build -lt 17763) { Out-Phx 'FAIL' ('OS_UNSUPPORTED:build ' + $os.Build + ' < 17763'); exit 1 }
    Out-Phx 'INFO' ('appinstaller=' + (Get-AppInstallerVersion))

    Out-Phx 'STEP' 'detect'
    Update-SessionPath
    $t = Test-Winget
    if (-not $t.Ok) {
        Out-Phx 'INFO' ('detect=' + $t.Reason)
        $plan = New-Object System.Collections.Generic.List[string]
        $plan.Add('Step-Register')
        if ($StoreFirst -and -not $SkipStore) { $plan.Add('Step-Store') }
        if (-not $SkipModule) { $plan.Add('Step-Module') }
        $plan.Add('Step-Manual')
        if (-not $StoreFirst -and -not $SkipStore) { $plan.Add('Step-Store') }
        foreach ($step in $plan) {
            & $step
            if ($step -eq 'Step-Store') { $wait = 60 } else { $wait = 30 }
            $t = Wait-Winget -Seconds $wait
            if ($t.Ok) { break }
            Out-Phx 'INFO' ('after ' + $step + ': ' + $t.Reason + ' appinstaller=' + (Get-AppInstallerVersion))
        }
    }
    if (-not $t.Ok) { Out-Phx 'FAIL' $t.Reason; exit 1 }

    Repair-UserPath
    if (-not $SkipSourceCheck) { Step-Source -Exe $t.Path -Version $t.Version }
    Out-Phx 'PATH' $t.Path
    Out-Phx 'OK' $t.Version
    exit 0
} catch {
    Out-Phx 'FAIL' ('UNEXPECTED:' + $_.Exception.Message)
    exit 1
}
