<#
.SYNOPSIS
  Strict validation of the VELOX data files (data/categories.json, data/tweaks/*.json,
  data/presets.json, data/detweak.json, data/bios/recommendations.json) against docs/ARCHITECTURE.md
  sections 3-5 and "BIOS-Optimierer".

.EXAMPLE
  pwsh tools/Validate-Catalog.ps1                 # validate everything, exit 1 on errors
  pwsh tools/Validate-Catalog.ps1 -File data/tweaks/gaming.json
  pwsh tools/Validate-Catalog.ps1 -AllowMissing   # presets/detweak may not exist yet

  Works on Windows PowerShell 5.1 and pwsh 7.
#>
param(
    [string]$DataDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'data'),
    [string]$File = '',
    [switch]$AllowMissing,
    [switch]$Quiet
)

$script:Errors = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]

function Add-Err([string]$where, [string]$msg) { $script:Errors.Add("ERROR  ${where}: $msg") }
function Add-Warn([string]$where, [string]$msg) { $script:Warnings.Add("WARN   ${where}: $msg") }

function Read-JsonFile([string]$path) {
    try {
        $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
        $bytes = [IO.File]::ReadAllBytes($path)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            Add-Err $path 'JSON files must be UTF-8 WITHOUT BOM'
        }
        return ($text | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        Add-Err $path ("invalid JSON: " + $_.Exception.Message)
        return $null
    }
}

function Has-Prop($obj, [string]$name) {
    if ($null -eq $obj) { return $false }
    return ($null -ne $obj.PSObject.Properties[$name])
}

function Get-Prop($obj, [string]$name) {
    if (Has-Prop $obj $name) { return $obj.PSObject.Properties[$name].Value }
    return $null
}

function Test-IsInt($v) {
    return ($v -is [int] -or $v -is [long] -or $v -is [int16] -or $v -is [byte] -or $v -is [uint32] -or $v -is [uint64] -or $v -is [int64] -or ($v -is [double] -and [math]::Floor($v) -eq $v) -or ($v -is [decimal] -and [math]::Floor($v) -eq $v))
}

function Test-IsAscii([string]$s) {
    foreach ($ch in $s.ToCharArray()) { if ([int]$ch -gt 127) { return $false } }
    return $true
}

$TagVocab = @('fps','latency','input','stutter','network','ping','privacy','telemetry','ads','ai','bloat',
    'battery','laptop-bad','desktop','ssd','hdd','nvidia','amd','intel','streaming','security-off','ui',
    'explorer','cleanup','repair','boot','storage','memory','audio','update','compat','fivem','gta',
    'competitive','quality-of-life')
$Kinds = @('toggle','action','remove')
$Risks = @('safe','moderate','risky')
$Needs = @('none','explorer','logoff','reboot')
$RegKinds = @('DWord','QWord','String','ExpandString','MultiString','Binary')
$StartTypes = @('Automatic','AutomaticDelayed','Manual','Disabled')
$WhenKeys = @('os','minBuild','maxBuild','formFactor','gpuVendor','cpuVendor','systemDisk','minRamGB','maxRamGB','service','package')
$ActionTypes = @('reg','regkey','service','task','bcd','powerplan','powersetting','feature','appx','clean','ps','tool')
# Long-running Windows tools a 'tool' action may name - the same list as Get-VxToolIds in core/Clean.ps1.
$ToolIds = @('dism-scanhealth','dism-restorehealth','dism-component-cleanup','dism-component-resetbase','sfc-scannow','chkdsk-scan','cleanmgr-windows-old')
$CleanTiers = @('quick','deep','optin')
# %TOKENS% a clean/measure path may use (core/Clean.ps1 Get-VxCleanVars); %RECYCLEBIN% only at the start.
$CleanTokens = @('TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','LOCALLOW','SYSTEMDRIVE','WINDIR','SYSTEMROOT','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','STEAM','RECYCLEBIN')

# Things that must never be disabled / removed (ARCHITECTURE.md section 3).
$ProtectedServices = @('appxsvc','staterepository','cryptsvc','bfe','dhcp','dnscache','rpcss','audiosrv',
    'winmgmt','eventlog','windefend','mpssvc','wuauserv','bits','trustedinstaller','profsvc','schedule',
    'power','plugplay','lsm','wscsvc','sense','securityhealthservice','wdnissvc','samss','lanmanworkstation',
    'nsi','netprofm','nlasvc','coremessagingregistrar','dcomlaunch','brokerinfrastructure','systemeventsbroker',
    'usermanager','gpsvc','camsvc','keyiso','vaultsvc','audioendpointbuilder','wlansvc','themes')
$ProtectedPackages = @('microsoft.windowsstore','microsoft.desktopappinstaller','microsoft.vclibs',
    'microsoft.ui.xaml','microsoft.net.native','microsoft.xboxidentityprovider','microsoft.webview2',
    'microsoft.windowsappruntime','microsoft.storepurchaseapp','microsoft.secHealthui','microsoft.windows.shellexperiencehost',
    'microsoft.windows.startmenuexperiencehost','microsoft.aad.brokerplugin','microsoft.accountscontrol',
    'microsoft.windows.cloudexperiencehost','microsoft.lockapp','microsoft.windowsterminal','microsoft.windowsnotepad',
    'microsoft.windowscalculator','microsoft.windows.photos','microsoft.paint','microsoft.hevcvideoextension',
    'microsoft.vp9videoextensions','microsoft.webmediaextensions','microsoft.webpimageextension',
    'microsoft.heifimageextension','microsoft.rawimageextension','microsoft.avcencodervideoextension','microsoft.services.store.engagement')
$ForbiddenRegNames = @('disableantispyware','disablerealtimemonitoring','enablelua','enablefirewall','tamperprotection',
    'noautoupdate','disablewindowsupdateaccess','pagingfiles')

$RiskRank = @{ 'safe' = 0; 'moderate' = 1; 'risky' = 2 }

# ---------------------------------------------------------------- categories
$catFile = Join-Path $DataDir 'categories.json'
$CategoryIds = @()
if (Test-Path $catFile) {
    $cats = Read-JsonFile $catFile
    if ($cats) {
        foreach ($c in @($cats.categories)) {
            foreach ($f in @('id','name','desc','icon','order')) {
                if (-not (Has-Prop $c $f)) { Add-Err $catFile "category missing '$f'" }
            }
            $CategoryIds += [string]$c.id
        }
    }
} else {
    Add-Err $catFile 'missing'
}

# ---------------------------------------------------------------- value checks
function Test-RegValue([string]$where, [string]$kind, $v, [string]$field) {
    if ($null -eq $v) { return }
    switch ($kind) {
        'DWord' {
            if (-not (Test-IsInt $v)) { Add-Err $where "$field must be an integer for DWord"; return }
            if ([double]$v -lt 0 -or [double]$v -gt 4294967295) { Add-Err $where "$field out of DWord range (0..4294967295)" }
        }
        'QWord' {
            if (-not (Test-IsInt $v)) { Add-Err $where "$field must be an integer for QWord" }
        }
        'String' { if (-not ($v -is [string])) { Add-Err $where "$field must be a string" } }
        'ExpandString' { if (-not ($v -is [string])) { Add-Err $where "$field must be a string" } }
        'MultiString' {
            $arr = @($v)
            if (-not ($v -is [array]) -and -not ($v -is [string])) { Add-Err $where "$field must be an array of strings" }
            foreach ($x in $arr) { if (-not ($x -is [string])) { Add-Err $where "$field must contain strings only" } }
        }
        'Binary' {
            if (-not ($v -is [string]) -or ($v -notmatch '^([0-9A-Fa-f]{2})*$')) { Add-Err $where "$field must be an even-length hex string for Binary" }
        }
    }
}

function Test-RegPath([string]$where, $path) {
    if (-not ($path -is [string]) -or [string]::IsNullOrWhiteSpace($path)) { Add-Err $where 'path missing'; return }
    if ($path -notmatch '^(HKLM|HKCU|HKCR|HKU|HKCC)\\') { Add-Err $where "path must start with HKLM\, HKCU\, HKCR\, HKU\ or HKCC\ (got '$path')" }
    if ($path -match '\\\\') { Add-Err $where "path contains an empty segment: '$path'" }
    if ($path.EndsWith('\')) { Add-Err $where "path must not end with a backslash: '$path'" }
    if ($path -match '^HK[A-Z]+:') { Add-Err $where "use HKLM\..., not the PowerShell drive form: '$path'" }
    $stars = ([regex]::Matches($path, '(^|\\)\*(\\|$)')).Count
    if ($stars -gt 1) { Add-Err $where "at most one '*' segment allowed: '$path'" }
    if ($path -match '[^\\]\*|\*[^\\]') { Add-Err $where "'*' must be a whole segment: '$path'" }
}

$RegIndex = @{}   # "path|name" (lower) -> tweak id, to find conflicting tweaks
$SeenIds = @{}
$AllTweaks = @{}

# Clean and measure paths: %TOKENS% from the list, absolute after expansion, at most ONE wildcard
# segment before the last one (it only ever matches real folders - every browser profile, every
# user's Temp), never a drive / Windows root.
function Test-CleanPath([string]$w, [string]$ps) {
    if ([string]::IsNullOrWhiteSpace($ps)) { Add-Err $w 'empty clean path'; return }
    if ($ps -match '^[A-Za-z]:\\?$' -or $ps -match '^(?i)%(SystemDrive|WINDIR|SystemRoot|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|ProgramFiles|ProgramFiles\(x86\)|LOCALLOW)%\\?\*?$') { Add-Err $w "refusing to clean a drive/Windows/profile root: '$ps'" }
    if ($ps -match '\.\.') { Add-Err $w "'..' is not allowed: '$ps'" }
    foreach ($m in [regex]::Matches($ps, '%([^%]+)%')) {
        if ($CleanTokens -notcontains $m.Groups[1].Value.ToUpperInvariant()) { Add-Err $w "unknown token '%$($m.Groups[1].Value)%' in '$ps'" }
    }
    if ($ps -match '(?i)%RECYCLEBIN%' -and $ps -notmatch '^(?i)%RECYCLEBIN%\\') { Add-Err $w "%RECYCLEBIN% only at the start: '$ps'" }
    if ($ps -notmatch '^%[^%]+%' -and $ps -notmatch '^[A-Za-z]:\\') { Add-Err $w "path must start with a %TOKEN% or a drive: '$ps'" }
    $segs = $ps -split '\\'
    $mid = 0
    for ($i = 0; $i -lt $segs.Count - 1; $i++) {
        if ($segs[$i] -match '[\*\?]') {
            $mid++
            if ($i -lt 2) { Add-Err $w "a wildcard folder needs at least one fixed folder before it: '$ps'" }
        }
    }
    if ($mid -gt 1) { Add-Err $w "at most one wildcard folder before the last segment: '$ps'" }
}

function Test-MeasureAndTimeout([string]$w, $a) {
    if (Has-Prop $a 'measure') {
        $ms = @(Get-Prop $a 'measure')
        if ($ms.Count -eq 0) { Add-Err $w "'measure' must be a non-empty array of paths" }
        foreach ($p in $ms) { Test-CleanPath $w ([string]$p) }
    }
    if (Has-Prop $a 'timeoutSec') {
        $to = Get-Prop $a 'timeoutSec'
        if (-not (Test-IsInt $to) -or [int]$to -lt 30 -or [int]$to -gt 14400) { Add-Err $w "'timeoutSec' must be an integer 30..14400" }
    }
}

function Test-Action([string]$where, $a, $tweak, [string]$tkind) {
    $type = [string](Get-Prop $a 'type')
    if ($ActionTypes -notcontains $type) { Add-Err $where "unknown action type '$type'"; return }
    $w = "$where [$type]"
    switch ($type) {
        'reg' {
            Test-RegPath $w (Get-Prop $a 'path')
            if (-not (Has-Prop $a 'name')) { Add-Err $w "'name' missing (use \"\" for the default value)" }
            $kind = [string](Get-Prop $a 'kind')
            if ($RegKinds -notcontains $kind) { Add-Err $w "kind must be one of $($RegKinds -join ', ') (got '$kind')" }
            if (-not (Has-Prop $a 'value')) { Add-Err $w "'value' missing" }
            if ($null -eq (Get-Prop $a 'value')) { Add-Err $w "'value' must not be null (to delete a value, apply=delete is not supported; model it as regkey or ps)" }
            if (-not (Has-Prop $a 'default')) { Add-Err $w "'default' missing (null = value absent on a clean install)" }
            Test-RegValue $w $kind (Get-Prop $a 'value') 'value'
            Test-RegValue $w $kind (Get-Prop $a 'default') 'default'
            if (Has-Prop $a 'defaultWin11') { Test-RegValue $w $kind (Get-Prop $a 'defaultWin11') 'defaultWin11' }
            if ((Has-Prop $a 'onlyExisting') -and -not ((Get-Prop $a 'onlyExisting') -is [bool])) { Add-Err $w 'onlyExisting must be boolean' }
            $val = Get-Prop $a 'value'; $def = Get-Prop $a 'default'
            if ($null -ne $def -and ((ConvertTo-Json -InputObject $val -Compress) -eq (ConvertTo-Json -InputObject $def -Compress))) {
                Add-Err $w "value equals default - the tweak would do nothing on a clean install"
            }
            $nm = [string](Get-Prop $a 'name')
            if ($ForbiddenRegNames -contains $nm.ToLowerInvariant()) { Add-Err $w "registry value '$nm' is on the never-touch list" }
            $key = (([string](Get-Prop $a 'path')) + '|' + $nm).ToLowerInvariant()
            if ($RegIndex.ContainsKey($key) -and $RegIndex[$key] -ne $tweak.id) {
                Add-Err $w "registry value already used by tweak '$($RegIndex[$key])' - two tweaks must not fight over one value"
            } elseif ($RegIndex.ContainsKey($key) -and $RegIndex[$key] -eq $tweak.id) {
                Add-Err $w "registry value appears twice in the same tweak"
            } else { $RegIndex[$key] = $tweak.id }
        }
        'regkey' {
            Test-RegPath $w (Get-Prop $a 'path')
            if (-not ((Get-Prop $a 'present') -is [bool])) { Add-Err $w "'present' must be boolean" }
            if (-not ((Get-Prop $a 'default') -is [bool])) { Add-Err $w "'default' must be boolean" }
            if ((Get-Prop $a 'present') -eq (Get-Prop $a 'default')) { Add-Err $w 'present equals default' }
        }
        'service' {
            $n = [string](Get-Prop $a 'name')
            if ([string]::IsNullOrWhiteSpace($n)) { Add-Err $w "'name' missing" }
            $s = [string](Get-Prop $a 'start'); $d = [string](Get-Prop $a 'default')
            if ($StartTypes -notcontains $s) { Add-Err $w "start must be one of $($StartTypes -join ', ')" }
            if ($StartTypes -notcontains $d) { Add-Err $w "default must be one of $($StartTypes -join ', ')" }
            if ($s -eq $d) { Add-Err $w 'start equals default' }
            if ($ProtectedServices -contains $n.ToLowerInvariant() -and ($s -eq 'Disabled' -or $s -eq 'Manual')) {
                Add-Err $w "service '$n' is protected and must not be disabled"
            }
            if ((Has-Prop $a 'defaultWin11') -and ($StartTypes -notcontains [string](Get-Prop $a 'defaultWin11'))) { Add-Err $w 'defaultWin11 invalid' }
        }
        'task' {
            $p = [string](Get-Prop $a 'path')
            if (-not $p.StartsWith('\')) { Add-Err $w "task path must start with '\' (full path incl. task name)" }
            if (-not ((Get-Prop $a 'enabled') -is [bool])) { Add-Err $w "'enabled' must be boolean" }
            if (-not ((Get-Prop $a 'default') -is [bool])) { Add-Err $w "'default' must be boolean" }
            if ((Get-Prop $a 'enabled') -eq (Get-Prop $a 'default')) { Add-Err $w 'enabled equals default' }
        }
        'bcd' {
            if (-not ((Get-Prop $a 'name') -is [string])) { Add-Err $w "'name' must be a string" }
            if (-not ((Get-Prop $a 'value') -is [string])) { Add-Err $w "'value' must be a string" }
            if (-not (Has-Prop $a 'default')) { Add-Err $w "'default' missing (null = deletevalue)" }
            $n = ([string](Get-Prop $a 'name')).ToLowerInvariant()
            if ($n -eq 'nx' -and ([string](Get-Prop $a 'value')) -match 'alwaysoff') { Add-Err $w 'disabling DEP is forbidden' }
        }
        'powerplan' {
            if (@('ultimate','high','balanced') -notcontains [string](Get-Prop $a 'plan')) { Add-Err $w 'plan must be ultimate|high|balanced' }
            if (@('ultimate','high','balanced') -notcontains [string](Get-Prop $a 'default')) { Add-Err $w 'default must be ultimate|high|balanced' }
        }
        'powersetting' {
            foreach ($f in @('subgroup','setting')) { if (-not ((Get-Prop $a $f) -is [string])) { Add-Err $w "'$f' must be a string" } }
            if (-not (Test-IsInt (Get-Prop $a 'ac'))) { Add-Err $w "'ac' must be an integer" }
            if ((Has-Prop $a 'dc') -and $null -ne (Get-Prop $a 'dc') -and -not (Test-IsInt (Get-Prop $a 'dc'))) { Add-Err $w "'dc' must be an integer or null" }
            $d = Get-Prop $a 'default'
            if ($null -eq $d -or -not (Has-Prop $d 'ac')) { Add-Err $w "'default' must be an object { ac, dc }" }
        }
        'feature' {
            if (-not ((Get-Prop $a 'name') -is [string])) { Add-Err $w "'name' must be a string" }
            if (-not ((Get-Prop $a 'enabled') -is [bool])) { Add-Err $w "'enabled' must be boolean" }
            if (-not ((Get-Prop $a 'default') -is [bool])) { Add-Err $w "'default' must be boolean" }
        }
        'appx' {
            $p = [string](Get-Prop $a 'package')
            if ([string]::IsNullOrWhiteSpace($p)) { Add-Err $w "'package' missing" }
            foreach ($pp in $ProtectedPackages) { if ($p.ToLowerInvariant().StartsWith($pp.ToLowerInvariant())) { Add-Err $w "package '$p' is protected" } }
            if ($tkind -ne 'remove') { Add-Err $w "appx actions require kind 'remove'" }
        }
        'clean' {
            $paths = @(Get-Prop $a 'paths')
            if ($paths.Count -eq 0) { Add-Err $w "'paths' must be a non-empty array" }
            foreach ($p in $paths) { Test-CleanPath $w ([string]$p) }
            if ($tkind -ne 'action') { Add-Err $w "clean actions require kind 'action'" }
            if (Has-Prop $a 'closeApps') {
                $ca = @(Get-Prop $a 'closeApps')
                if ($ca.Count -eq 0) { Add-Err $w "'closeApps' must be a non-empty array of process names" }
                foreach ($n in $ca) { if (-not ($n -is [string]) -or [string]$n -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$' -or [string]$n -match '(?i)\.exe$') { Add-Err $w "closeApps: '$n' must be a process name without .exe" } }
            }
            foreach ($f in @('keep','stopServices')) { if ((Has-Prop $a $f) -and @(Get-Prop $a $f).Count -eq 0) { Add-Err $w "'$f' must be a non-empty array when present" } }
            if (Has-Prop $a 'minAgeHours') {
                $mh = Get-Prop $a 'minAgeHours'
                if (-not (Test-IsInt $mh) -or [int]$mh -lt 1 -or [int]$mh -gt 720) { Add-Err $w "'minAgeHours' must be an integer 1..720" }
            }
        }
        'tool' {
            $tl = [string](Get-Prop $a 'tool')
            if ($ToolIds -notcontains $tl) { Add-Err $w "unknown tool '$tl' (allowed: $($ToolIds -join ', '))" }
            if ($tkind -ne 'action') { Add-Err $w "tool actions require kind 'action'" }
            Test-MeasureAndTimeout $w $a
        }
        'ps' {
            $ap = Get-Prop $a 'apply'
            if (-not ($ap -is [string]) -or [string]::IsNullOrWhiteSpace($ap)) { Add-Err $w "'apply' script missing" }
            foreach ($f in @('apply','revert','detect')) {
                $s = Get-Prop $a $f
                if ($null -ne $s) {
                    if (-not ($s -is [string])) { Add-Err $w "'$f' must be a string or null" }
                    elseif (-not (Test-IsAscii $s)) { Add-Err $w "'$f' script must be ASCII" }
                    else {
                        $tokens = $null; $perr = $null
                        [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$tokens, [ref]$perr)
                        if ($perr -and $perr.Count -gt 0) { Add-Err $w "'$f' does not parse: $($perr[0].Message)" }
                        if ($s -match '\?\?|\?\.|&&|\|\|') { Add-Err $w "'$f' uses PowerShell 7-only syntax" }
                    }
                }
            }
            if ($tkind -eq 'toggle' -and [string]::IsNullOrWhiteSpace([string](Get-Prop $a 'revert'))) { Add-Err $w "toggle tweaks need a 'revert' script" }
            if ($tkind -ne 'action' -and ((Has-Prop $a 'measure') -or (Has-Prop $a 'timeoutSec'))) { Add-Err $w "'measure'/'timeoutSec' only for kind 'action'" }
            Test-MeasureAndTimeout $w $a
            if ($tkind -eq 'toggle' -and -not (Has-Prop $a 'detect')) { Add-Warn $w "no 'detect' script - status will be 'unknown'" }
        }
    }
}

function Test-Tweak([string]$file, [string]$category, $t) {
    $id = [string](Get-Prop $t 'id')
    $where = "$file :: $id"
    if ($id -notmatch '^[a-z0-9]+(\.[a-z0-9-]+)+$') { Add-Err $where "id must match ^[a-z0-9]+(\.[a-z0-9-]+)+$" }
    if (-not $id.StartsWith("$category.")) { Add-Err $where "id must start with '$category.'" }
    if ($SeenIds.ContainsKey($id)) { Add-Err $where "duplicate id (also in $($SeenIds[$id]))" } else { $SeenIds[$id] = $file }
    $AllTweaks[$id] = $t

    $name = [string](Get-Prop $t 'name'); $desc = [string](Get-Prop $t 'desc')
    if ([string]::IsNullOrWhiteSpace($name)) { Add-Err $where 'name missing' } elseif ($name.Length -gt 60) { Add-Err $where "name longer than 60 chars ($($name.Length))" }
    if ([string]::IsNullOrWhiteSpace($desc)) { Add-Err $where 'desc missing' } elseif ($desc.Length -gt 150) { Add-Err $where "desc longer than 150 chars ($($desc.Length))" }
    $info = Get-Prop $t 'info'
    if ($null -ne $info -and ([string]$info).Length -gt 500) { Add-Err $where 'info longer than 500 chars' }
    $kind = 'toggle'; if (Has-Prop $t 'kind') { $kind = [string](Get-Prop $t 'kind') }
    # situational: only for a specific problem - the advisors pick it only when the user's own text asks for it
    if ((Has-Prop $t 'situational') -and -not ((Get-Prop $t 'situational') -is [bool])) { Add-Err $where 'situational must be boolean' }
    if ((Get-Prop $t 'situational') -eq $true -and $kind -ne 'toggle') { Add-Err $where 'situational only makes sense for toggles' }
    if ($Kinds -notcontains $kind) { Add-Err $where "kind must be toggle|action|remove" }
    $impact = Get-Prop $t 'impact'
    if (-not (Test-IsInt $impact) -or [int]$impact -lt 1 -or [int]$impact -gt 3) { Add-Err $where 'impact must be 1, 2 or 3' }
    $risk = [string](Get-Prop $t 'risk')
    if ($Risks -notcontains $risk) { Add-Err $where 'risk must be safe|moderate|risky' }
    $warning = Get-Prop $t 'warning'
    if ($risk -eq 'risky' -and [string]::IsNullOrWhiteSpace([string]$warning)) { Add-Err $where 'risky tweaks need a warning' }
    if ($risk -eq 'moderate' -and [string]::IsNullOrWhiteSpace([string]$warning)) { Add-Warn $where 'moderate tweak without warning' }
    if ($null -ne $warning -and ([string]$warning).Length -gt 200) { Add-Err $where 'warning longer than 200 chars' }
    if ($Needs -notcontains [string](Get-Prop $t 'needs')) { Add-Err $where 'needs must be none|explorer|logoff|reboot' }
    $tags = @(Get-Prop $t 'tags')
    if ($tags.Count -eq 0) { Add-Err $where 'tags must be a non-empty array' }
    foreach ($tg in $tags) { if ($TagVocab -notcontains [string]$tg) { Add-Err $where "unknown tag '$tg'" } }
    if ($tags -contains 'security-off' -and $risk -ne 'risky') { Add-Err $where "tag 'security-off' requires risk 'risky'" }
    if ($category -eq 'security' -and $risk -eq 'safe') { Add-Warn $where 'safe tweak in the security (expert) category' }

    if (Has-Prop $t 'when') {
        $when = Get-Prop $t 'when'
        foreach ($p in $when.PSObject.Properties) {
            if ($WhenKeys -notcontains $p.Name) { Add-Err $where "unknown 'when' key '$($p.Name)'" }
        }
        if ((Has-Prop $when 'os') -and @('win10','win11') -notcontains [string]$when.os) { Add-Err $where "when.os must be win10|win11" }
        if ((Has-Prop $when 'formFactor') -and @('desktop','laptop') -notcontains [string]$when.formFactor) { Add-Err $where "when.formFactor must be desktop|laptop" }
        if ((Has-Prop $when 'gpuVendor') -and @('nvidia','amd','intel') -notcontains [string]$when.gpuVendor) { Add-Err $where "when.gpuVendor must be nvidia|amd|intel" }
        if ((Has-Prop $when 'cpuVendor') -and @('intel','amd') -notcontains [string]$when.cpuVendor) { Add-Err $where "when.cpuVendor must be intel|amd" }
        if ((Has-Prop $when 'systemDisk') -and @('ssd','hdd') -notcontains [string]$when.systemDisk) { Add-Err $where "when.systemDisk must be ssd|hdd" }
        foreach ($k in @('minBuild','maxBuild','minRamGB','maxRamGB')) { if ((Has-Prop $when $k) -and -not (Test-IsInt (Get-Prop $when $k))) { Add-Err $where "when.$k must be an integer" } }
    }

    # Reinigung: tier = quick (Schnell) | deep (Gründlich) | optin (only "Alles" + explicit confirmation)
    if (Has-Prop $t 'tier') {
        $tier = [string](Get-Prop $t 'tier')
        if ($CleanTiers -notcontains $tier) { Add-Err $where "tier must be quick|deep|optin" }
        if ($kind -ne 'action') { Add-Err $where "tier only for kind 'action'" }
        if ($tier -eq 'optin' -and [string]::IsNullOrWhiteSpace([string]$warning)) { Add-Err $where "opt-in clean items need a warning (what is lost)" }
    } elseif ($category -eq 'cleanup' -and $kind -eq 'action') { Add-Err $where "cleanup actions need a tier (quick|deep|optin)" }
    if (Has-Prop $t 'duration') {
        $du = Get-Prop $t 'duration'
        if (-not ($du -is [string]) -or [string]::IsNullOrWhiteSpace($du) -or ([string]$du).Length -gt 40) { Add-Err $where "duration must be a short text (<= 40 chars), e.g. '5–30 Min.'" }
        if ($kind -ne 'action') { Add-Err $where "duration only for kind 'action'" }
    }

    $actions = @(Get-Prop $t 'actions')
    if ($actions.Count -eq 0) { Add-Err $where 'actions must be a non-empty array' }
    $i = 0
    foreach ($a in $actions) {
        Test-Action "$where actions[$i]" $a $t $kind
        $type = [string](Get-Prop $a 'type')
        if ($kind -eq 'toggle' -and @('appx','clean') -contains $type) { Add-Err $where "toggle tweaks must not contain '$type' actions" }
        if ($kind -eq 'action' -and @('clean','ps','tool') -notcontains $type) { Add-Err $where "action tweaks may only contain clean/ps/tool actions" }
        if ($kind -ne 'action' -and $type -eq 'tool') { Add-Err $where "tool actions require kind 'action'" }
        if ($kind -eq 'remove' -and $type -ne 'appx') { Add-Err $where "remove tweaks may only contain appx actions" }
        $i++
    }
}

# ---------------------------------------------------------------- tweak files
$tweakDir = Join-Path $DataDir 'tweaks'
$files = @()
if ($File) {
    $files = @(Get-Item -LiteralPath $File)
    # Load the other files too so cross-file duplicates are found, but only report the chosen one fully.
} else {
    $files = @(Get-ChildItem -Path $tweakDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)
}
$others = @()
if ($File) {
    $full = (Resolve-Path -LiteralPath $File).Path
    $others = @(Get-ChildItem -Path $tweakDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $full } | Sort-Object Name)
}
if ($files.Count -eq 0) { Add-Err $tweakDir 'no tweak files found' }

foreach ($f in @($others + $files)) {
    $doc = Read-JsonFile $f.FullName
    if (-not $doc) { continue }
    $expected = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    $cat = [string](Get-Prop $doc 'category')
    if ($cat -ne $expected) { Add-Err $f.Name "category '$cat' must equal the file name '$expected'" }
    if ($CategoryIds.Count -gt 0 -and $CategoryIds -notcontains $cat) { Add-Err $f.Name "category '$cat' is not in categories.json" }
    $tw = @(Get-Prop $doc 'tweaks')
    if ($tw.Count -eq 0) { Add-Err $f.Name "'tweaks' must be a non-empty array" }
    foreach ($t in $tw) { Test-Tweak $f.Name $cat $t }
}

# ---------------------------------------------------------------- presets
$presetFile = Join-Path $DataDir 'presets.json'
if (Test-Path $presetFile) {
    $pd = Read-JsonFile $presetFile
    $pids = @{}
    foreach ($p in @(Get-Prop $pd 'presets')) {
        $pw = "presets.json :: $($p.id)"
        foreach ($f in @('id','name','tagline','desc','icon','maxRisk','ids')) { if (-not (Has-Prop $p $f)) { Add-Err $pw "missing '$f'" } }
        if ($pids.ContainsKey([string]$p.id)) { Add-Err $pw 'duplicate preset id' } else { $pids[[string]$p.id] = 1 }
        if (@('safe','moderate') -notcontains [string]$p.maxRisk) { Add-Err $pw "maxRisk must be safe|moderate" }
        $seen = @{}
        foreach ($tid in @($p.ids)) {
            if ($seen.ContainsKey([string]$tid)) { Add-Err $pw "id '$tid' listed twice" }; $seen[[string]$tid] = 1
            if (-not $AllTweaks.ContainsKey([string]$tid)) { if (-not $File) { Add-Err $pw "unknown tweak id '$tid'" }; continue }
            $t = $AllTweaks[[string]$tid]
            $tk = 'toggle'; if (Has-Prop $t 'kind') { $tk = [string]$t.kind }
            if ($RiskRank[[string]$t.risk] -gt $RiskRank[[string]$p.maxRisk]) { Add-Err $pw "'$tid' is $($t.risk), above maxRisk $($p.maxRisk)" }
            if ([string]$t.risk -eq 'risky') { Add-Err $pw "'$tid' is risky - never allowed in presets" }
            if ($tk -eq 'remove') { Add-Err $pw "'$tid' is an Appx removal - not allowed in presets" }
            if ($tk -eq 'action' -and [string]$p.id -ne 'clean') { Add-Err $pw "'$tid' is a one-shot action - only allowed in the 'clean' preset" }
            if ([string]$p.id -eq 'laptop' -and @($t.tags) -contains 'laptop-bad') { Add-Err $pw "'$tid' is tagged laptop-bad" }
        }
    }
} elseif (-not $AllowMissing) { Add-Err $presetFile 'missing' }

# ---------------------------------------------------------------- detweak
$detFile = Join-Path $DataDir 'detweak.json'
if (Test-Path $detFile) {
    $dd = Read-JsonFile $detFile
    $seenKeys = @{}
    $i = 0
    foreach ($r in @(Get-Prop $dd 'registry')) {
        $w = "detweak.json registry[$i] $($r.name)"
        Test-RegPath $w (Get-Prop $r 'path')
        if (-not (Has-Prop $r 'name')) { Add-Err $w "'name' missing" }
        if (-not (Has-Prop $r 'default')) { Add-Err $w "'default' missing (null = delete)" }
        $k = [string](Get-Prop $r 'kind')
        if ($null -ne (Get-Prop $r 'default') -and $RegKinds -notcontains $k) { Add-Err $w "kind required when default is not null" }
        if ($null -ne (Get-Prop $r 'default')) { Test-RegValue $w $k (Get-Prop $r 'default') 'default' }
        foreach ($f in @('label','group')) { if ([string]::IsNullOrWhiteSpace([string](Get-Prop $r $f))) { Add-Err $w "'$f' missing" } }
        $key = ([string]$r.path + '|' + [string]$r.name).ToLowerInvariant()
        if ($seenKeys.ContainsKey($key)) { Add-Err $w 'duplicate entry' } else { $seenKeys[$key] = 1 }
        if ($RegIndex.ContainsKey($key)) {
            $tw = $AllTweaks[$RegIndex[$key]]
            foreach ($a in @($tw.actions)) {
                if ($a.type -eq 'reg' -and (([string]$a.path + '|' + [string]$a.name).ToLowerInvariant()) -eq $key) {
                    if ((ConvertTo-Json -InputObject $a.default -Compress) -ne (ConvertTo-Json -InputObject (Get-Prop $r 'default') -Compress)) {
                        Add-Err $w "default disagrees with catalog tweak '$($tw.id)' ($(ConvertTo-Json -InputObject $a.default -Compress) vs $(ConvertTo-Json -InputObject (Get-Prop $r 'default') -Compress))"
                    }
                }
            }
        }
        $i++
    }
    $i = 0
    foreach ($r in @(Get-Prop $dd 'registryKeys')) {
        $w = "detweak.json registryKeys[$i]"
        Test-RegPath $w (Get-Prop $r 'path')
        foreach ($f in @('label','group')) { if ([string]::IsNullOrWhiteSpace([string](Get-Prop $r $f))) { Add-Err $w "'$f' missing" } }
        $i++
    }
    foreach ($b in @(Get-Prop $dd 'bcd')) {
        if (-not ((Get-Prop $b 'name') -is [string])) { Add-Err 'detweak.json bcd' "name must be a string" }
        foreach ($f in @('label','group')) { if ([string]::IsNullOrWhiteSpace([string](Get-Prop $b $f))) { Add-Err "detweak.json bcd $($b.name)" "'$f' missing" } }
        if (@('nx','hypervisorlaunchtype','bootmenupolicy','device','osdevice','path','systemroot','recoverysequence','locale','inherit','displaymessageoverride','resumeobject','bootstatuspolicy') -contains ([string]$b.name).ToLowerInvariant()) {
            Add-Err "detweak.json bcd $($b.name)" 'this BCD element must not be deleted by detweak'
        }
    }
    foreach ($s in @(Get-Prop $dd 'services')) {
        $w = "detweak.json services $($s.name)"
        if ($StartTypes -notcontains [string](Get-Prop $s 'default')) { Add-Err $w 'default start type invalid' }
        if ((Has-Prop $s 'defaultWin11') -and $StartTypes -notcontains [string](Get-Prop $s 'defaultWin11')) { Add-Err $w 'defaultWin11 invalid' }
        foreach ($f in @('label','group')) { if ([string]::IsNullOrWhiteSpace([string](Get-Prop $s $f))) { Add-Err $w "'$f' missing" } }
    }
    foreach ($t in @(Get-Prop $dd 'tasks')) {
        $w = "detweak.json tasks $($t.path)"
        if (-not ([string](Get-Prop $t 'path')).StartsWith('\')) { Add-Err $w "path must start with '\'" }
        if (-not ((Get-Prop $t 'default') -is [bool])) { Add-Err $w 'default must be boolean' }
    }
    $cids = @{}
    foreach ($c in @(Get-Prop $dd 'commands')) {
        $w = "detweak.json commands $($c.id)"
        foreach ($f in @('id','label','desc','script','needs')) { if ([string]::IsNullOrWhiteSpace([string](Get-Prop $c $f))) { Add-Err $w "'$f' missing" } }
        if (-not ((Get-Prop $c 'defaultOn') -is [bool])) { Add-Err $w 'defaultOn must be boolean' }
        if ($Needs -notcontains [string](Get-Prop $c 'needs')) { Add-Err $w 'needs invalid' }
        # optional: 'moderate' marks a command that changes system-wide behaviour (UI shows a badge)
        if ((Has-Prop $c 'risk') -and @('safe', 'moderate') -notcontains [string](Get-Prop $c 'risk')) { Add-Err $w "risk must be safe|moderate" }
        if ((Has-Prop $c 'risk') -and [string](Get-Prop $c 'risk') -eq 'moderate' -and (Get-Prop $c 'defaultOn') -eq $true) { Add-Warn $w 'moderate command is defaultOn' }
        if ($cids.ContainsKey([string]$c.id)) { Add-Err $w 'duplicate command id' } else { $cids[[string]$c.id] = 1 }
        $s = [string](Get-Prop $c 'script')
        if (-not (Test-IsAscii $s)) { Add-Err $w 'script must be ASCII' }
        $tokens = $null; $perr = $null
        [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$tokens, [ref]$perr)
        if ($perr -and $perr.Count -gt 0) { Add-Err $w "script does not parse: $($perr[0].Message)" }
    }
} elseif (-not $AllowMissing) { Add-Err $detFile 'missing' }

# ---------------------------------------------------------------- BIOS recommendations
# data/bios/recommendations.json (core/Bios.ps1, docs/ARCHITECTURE.md "BIOS-Optimierer"). The website's
# phone page copies the file, so the texts follow the same rules as the app's.
$biosFile = Join-Path (Join-Path $DataDir 'bios') 'recommendations.json'
$BiosVendors = @('asus', 'msi', 'gigabyte', 'asrock', 'generic')
$BiosNeeds = @('secureBoot', 'tpm', 'vbs', 'uefi')
$BiosCpuTags = @('ryzen', 'x3d', 'x3d-locked', 'x3d-tunable', 'x3d-dual', 'ryzen-tunable', 'am5', 'raptor-lake', 'intel-k')
$BiosGpuTags = @('rebar-capable')
# fact -> the values core/Bios.ps1 ConvertTo-VxBiosFacts can produce
$BiosFacts = @{
    'ram.profile' = @('on', 'off', 'unknown'); 'ram.dualChannel' = @('yes', 'no', 'unknown'); 'gpu.rebar' = @('on', 'off', 'unknown')
    'firmware.mode' = @('uefi', 'legacy', 'unknown'); 'firmware.csm' = @('on', 'off', 'unknown'); 'firmware.secureBoot' = @('on', 'off', 'unknown')
    'tpm.state' = @('on', 'off', 'old', 'unknown'); 'virtualization.advice' = @('needed', 'nocost', 'optional', 'unknown')
    'bitlocker.state' = @('on', 'off', 'suspended', 'unknown')
}
# warning ids core/Bios.ps1 Get-VxBiosReport has a rule for
$BiosWarningIds = @('legacy-boot', 'intel-microcode', 'bios-old', 'bitlocker', 'vbs-fps', 'laptop', 'vendor-unknown', 'not-admin')

function Test-BiosText([string]$where, $value, [int]$max, [switch]$Optional) {
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { if (-not $Optional) { Add-Err $where 'text missing' }; return }
    if (-not ($value -is [string])) { Add-Err $where 'must be a string'; return }
    if ($value.Length -gt $max) { Add-Err $where "longer than $max characters ($($value.Length))" }
    if ($value -match '[<>]') { Add-Err $where 'no HTML / angle brackets in texts' }
    if ($value.Contains('"')) { Add-Err $where 'use German quotes „…“, not "' }
    if ($value -match '\s$|^\s') { Add-Err $where 'leading/trailing whitespace' }
}

function Test-BiosSteps([string]$where, $steps, [switch]$NeedAny) {
    if ($steps -is [System.Array]) {
        if ($steps.Count -lt 1 -or $steps.Count -gt 6) { Add-Err $where 'needs 1-6 steps' }
        $i = 0
        foreach ($x in $steps) { Test-BiosText "$where[$i]" $x 220; $i++ }
        return
    }
    if ($null -eq $steps -or -not ($steps -is [System.Management.Automation.PSCustomObject])) { Add-Err $where 'steps must be an array or { any, amd, intel }'; return }
    $keys = @($steps.PSObject.Properties.Name)
    foreach ($k in $keys) {
        if (@('any', 'amd', 'intel') -notcontains $k) { Add-Err $where "unknown platform '$k' (any|amd|intel)"; continue }
        $list = @(Get-Prop $steps $k)
        if ($list.Count -lt 1 -or $list.Count -gt 6) { Add-Err "$where.$k" 'needs 1-6 steps' }
        $i = 0
        foreach ($x in $list) { Test-BiosText "$where.$k[$i]" $x 220; $i++ }
    }
    if (-not (($keys -contains 'amd') -and ($keys -contains 'intel')) -and -not ($keys -contains 'any')) { Add-Err $where "a platform list needs both 'amd' and 'intel', or 'any'" }
    if ($NeedAny -and $keys -notcontains 'any') { Add-Err $where "the generic steps need an 'any' list for other CPUs" }
}

if (-not $File -and (Test-Path -LiteralPath $biosFile)) {
    $bd = Read-JsonFile $biosFile
    if ($null -ne $bd) {
        $bw = 'bios/recommendations.json'
        if ((Get-Prop $bd 'version') -ne 1) { Add-Err $bw 'version must be 1 (the link format version, docs/ARCHITECTURE.md)' }
        $sl = Get-Prop $bd 'statusLabels'
        foreach ($k in @('o', 't', 'u')) { Test-BiosText "$bw statusLabels.$k" (Get-Prop $sl $k) 40 }
        $rl = Get-Prop $bd 'riskLabels'
        foreach ($k in @('safe', 'moderate')) { Test-BiosText "$bw riskLabels.$k" (Get-Prop $rl $k) 20 }
        if (Has-Prop $rl 'risky') { Add-Err $bw 'no risky BIOS recommendations (riskLabels.risky)' }
        $gen = Get-Prop $bd 'general'
        foreach ($k in @('pathNote', 'intro', 'saveNote')) { Test-BiosText "$bw general.$k" (Get-Prop $gen $k) 300 }
        if ([string](Get-Prop $gen 'recoveryUrl') -ne 'https://aka.ms/myrecoverykey') { Add-Err $bw 'general.recoveryUrl must be https://aka.ms/myrecoverykey' }
        $ven = Get-Prop $bd 'vendors'
        foreach ($v in $BiosVendors) {
            $vo = Get-Prop $ven $v
            if ($null -eq $vo) { Add-Err $bw "vendors.$v missing"; continue }
            foreach ($k in @('name', 'biosKey', 'advanced', 'save', 'help')) { Test-BiosText "$bw vendors.$v.$k" (Get-Prop $vo $k) 160 }
        }
        if ($null -ne $ven) { foreach ($k in @($ven.PSObject.Properties.Name)) { if ($BiosVendors -notcontains $k) { Add-Err $bw "unknown vendor '$k'" } } }
        $codes = @{}
        foreach ($g in @(Get-Prop $bd 'games')) {
            $gw = "$bw games $($g.code)"
            if ([string](Get-Prop $g 'code') -notmatch '^[a-z0-9]{3}$') { Add-Err $gw 'code must be 3 characters a-z0-9' }
            elseif ($codes.ContainsKey('g:' + $g.code)) { Add-Err $gw 'duplicate game code' } else { $codes['g:' + $g.code] = 1 }
            Test-BiosText "$gw name" (Get-Prop $g 'name') 40
            $needs = @(Get-Prop $g 'needs')
            if ($needs.Count -eq 0) { Add-Err $gw 'needs must name at least one feature' }
            foreach ($n in $needs) { if ($BiosNeeds -notcontains [string]$n) { Add-Err $gw "unknown need '$n'" } }
            $match = @(Get-Prop $g 'match') + @(Get-Prop $g 'services')
            if (@($match | Where-Object { $_ }).Count -eq 0) { Add-Err $gw 'match or services needed' }
            foreach ($m in @(Get-Prop $g 'match')) { if ([string]$m -ne ([string]$m).ToLowerInvariant() -or [string]::IsNullOrWhiteSpace([string]$m)) { Add-Err $gw "match '$m' must be lower case and non-empty" } }
        }
        $ids = @{}
        $items = @(Get-Prop $bd 'items')
        if ($items.Count -eq 0) { Add-Err $bw 'items must be a non-empty array' }
        foreach ($it in $items) {
            $iw = "$bw items $($it.id)"
            if ([string](Get-Prop $it 'id') -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { Add-Err $iw 'id must be lower-case words with -' }
            elseif ($ids.ContainsKey([string]$it.id)) { Add-Err $iw 'duplicate id' } else { $ids[[string]$it.id] = 1 }
            if ([string](Get-Prop $it 'code') -notmatch '^[a-z]{2}$') { Add-Err $iw 'code must be two letters a-z (link format)' }
            elseif ($codes.ContainsKey('i:' + $it.code)) { Add-Err $iw "duplicate code '$($it.code)'" } else { $codes['i:' + $it.code] = 1 }
            if (@('core', 'optional') -notcontains [string](Get-Prop $it 'section')) { Add-Err $iw 'section must be core|optional' }
            if (@('safe', 'moderate') -notcontains [string](Get-Prop $it 'risk')) { Add-Err $iw 'risk must be safe|moderate (never risky)' }
            if (-not (Test-IsInt (Get-Prop $it 'impact')) -or [int](Get-Prop $it 'impact') -lt 1 -or [int](Get-Prop $it 'impact') -gt 3) { Add-Err $iw 'impact must be 1..3' }
            Test-BiosText "$iw title" (Get-Prop $it 'title') 70
            Test-BiosText "$iw why" (Get-Prop $it 'why') 400
            Test-BiosText "$iw info" (Get-Prop $it 'info') 500 -Optional
            $when = Get-Prop $it 'when'
            if ($null -ne $when) {
                foreach ($k in @($when.PSObject.Properties.Name)) {
                    $val = Get-Prop $when $k
                    switch ($k) {
                        'formFactor' { if (@('desktop', 'laptop') -notcontains [string]$val) { Add-Err $iw 'when.formFactor must be desktop|laptop' } }
                        'cpuVendor' { if (@('amd', 'intel') -notcontains [string]$val) { Add-Err $iw 'when.cpuVendor must be amd|intel' } }
                        'cpuTags' { foreach ($x in @($val)) { if ($BiosCpuTags -notcontains [string]$x) { Add-Err $iw "unknown cpu tag '$x'" } } }
                        'gpuTags' { foreach ($x in @($val)) { if ($BiosGpuTags -notcontains [string]$x) { Add-Err $iw "unknown gpu tag '$x'" } } }
                        'ramType' { foreach ($x in @($val)) { if (@('DDR3', 'DDR4', 'DDR5') -notcontains [string]$x) { Add-Err $iw "unknown RAM type '$x'" } } }
                        default { Add-Err $iw "unknown when condition '$k'" }
                    }
                }
            }
            $chk = Get-Prop $it 'check'
            if ($null -ne $chk) {
                $fact = [string](Get-Prop $chk 'fact')
                if (-not $BiosFacts.ContainsKey($fact)) { Add-Err $iw "check.fact '$fact' is not a known fact" }
                else {
                    foreach ($k in @('ok', 'todo')) { foreach ($x in @(Get-Prop $chk $k)) { if ($BiosFacts[$fact] -notcontains [string]$x) { Add-Err $iw "check.$k value '$x' is not a value of $fact" } } }
                    if (@(Get-Prop $chk 'ok').Count -eq 0) { Add-Err $iw 'check.ok must name at least one value' }
                }
            }
            $feat = Get-Prop $it 'feature'
            if ($null -ne $feat -and $BiosNeeds -notcontains [string]$feat) { Add-Err $iw "unknown feature '$feat'" }
            if ((Has-Prop $it 'direction') -and @('on', 'off') -notcontains [string](Get-Prop $it 'direction')) { Add-Err $iw 'direction must be on|off' }
            $steps = Get-Prop $it 'steps'
            if ($null -eq $steps -or -not (Has-Prop $steps 'generic')) { Add-Err $iw 'steps.generic missing (fallback for every vendor)' }
            else {
                foreach ($k in @($steps.PSObject.Properties.Name)) {
                    if ($BiosVendors -notcontains $k) { Add-Err $iw "steps for unknown vendor '$k'"; continue }
                    $gs = Get-Prop $steps $k
                    if ($k -eq 'generic') { Test-BiosSteps "$iw steps.generic" $gs -NeedAny:(-not ($gs -is [System.Array])) } else { Test-BiosSteps "$iw steps.$k" $gs }
                }
            }
            foreach ($v in @(Get-Prop $it 'verified')) {
                if ($BiosVendors -notcontains [string]$v -or [string]$v -eq 'generic') { Add-Err $iw "verified: unknown vendor '$v'" }
                elseif (-not (Has-Prop $steps ([string]$v))) { Add-Err $iw "verified vendor '$v' has no own steps" }
            }
            if (-not (Has-Prop $it 'verified')) { Add-Err $iw "'verified' missing (list the vendors whose menu path was checked, [] if none)" }
            $st = Get-Prop $it 'statusText'
            if ($null -ne $st) { foreach ($k in @($st.PSObject.Properties.Name)) { if (@('o', 't', 'u') -notcontains $k) { Add-Err $iw "statusText.${k}: only o|t|u" } else { Test-BiosText "$iw statusText.$k" (Get-Prop $st $k) 40 } } }
        }
        foreach ($w in @(Get-Prop $bd 'warnings')) {
            $ww = "$bw warnings $($w.id)"
            if ($BiosWarningIds -notcontains [string](Get-Prop $w 'id')) { Add-Err $ww 'unknown warning id (core/Bios.ps1 Get-VxBiosReport has no rule for it)' }
            elseif ($codes.ContainsKey('w:' + $w.id)) { Add-Err $ww 'duplicate warning id' } else { $codes['w:' + $w.id] = 1 }
            if ([string](Get-Prop $w 'code') -notmatch '^[a-z]{2}$') { Add-Err $ww 'code must be two letters a-z' }
            elseif ($codes.ContainsKey('wc:' + $w.code)) { Add-Err $ww "duplicate warning code '$($w.code)'" } else { $codes['wc:' + $w.code] = 1 }
            if (@('bad', 'warn', 'info') -notcontains [string](Get-Prop $w 'severity')) { Add-Err $ww 'severity must be bad|warn|info' }
            Test-BiosText "$ww title" (Get-Prop $w 'title') 70
            Test-BiosText "$ww text" (Get-Prop $w 'text') 600
            $tw = Get-Prop $w 'tweak'
            if ($null -ne $tw -and $AllTweaks.Count -gt 0 -and -not $AllTweaks.ContainsKey([string]$tw)) { Add-Err $ww "tweak '$tw' is not in the catalog" }
        }
        foreach ($id in $BiosWarningIds) { if (-not $codes.ContainsKey('w:' + $id)) { Add-Err $bw "warning '$id' missing (core/Bios.ps1 shows it)" } }
    }
} elseif (-not $File -and -not $AllowMissing -and ((Resolve-Path -LiteralPath $DataDir).Path -eq (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'data')).Path)) {
    # the app's own data folder must have it; a test catalog (tests/fixtures/data) borrows the app's file
    Add-Err $biosFile 'missing'
}

# ---------------------------------------------------------------- report
$total = $AllTweaks.Count
if (-not $Quiet) {
    foreach ($w in $script:Warnings) { Write-Host $w -ForegroundColor Yellow }
}
foreach ($e in $script:Errors) { Write-Host $e -ForegroundColor Red }
$risky = @($AllTweaks.Values | Where-Object { $_.risk -eq 'risky' }).Count
$biosNote = ''
if (Get-Variable -Name bd -ErrorAction SilentlyContinue) { if ($null -ne $bd) { $biosNote = (', {0} BIOS items' -f @(Get-Prop $bd 'items').Count) } }
Write-Host ("Catalog: {0} tweaks in {1} files, {2} risky{5} - {3} error(s), {4} warning(s)" -f $total, (@($others + $files)).Count, $risky, $script:Errors.Count, $script:Warnings.Count, $biosNote)
if ($script:Errors.Count -gt 0) { exit 1 }
exit 0
