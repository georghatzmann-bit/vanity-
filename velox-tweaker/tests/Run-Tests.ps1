<#
.SYNOPSIS
  VELOX backend tests. Plain PowerShell (no Pester), valid for Windows PowerShell 5.1 and pwsh 7.
  Everything runs in simulate mode - nothing on the machine is changed.

.EXAMPLE
  pwsh tests/Run-Tests.ps1
  pwsh tests/Run-Tests.ps1 -Strict          # also fail when the real data/ catalog has errors
  pwsh tests/Run-Tests.ps1 -Only engine     # run one group (compat, catalog, engine, realcatalog, detweak, advisor, claude, server)
#>
param(
    [switch]$Strict,
    [string]$Only = ''
)

$TestRoot = $PSScriptRoot
$AppRoot = Split-Path -Parent $TestRoot
$FixtureData = Join-Path (Join-Path $TestRoot 'fixtures') 'data'
$HostExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$script:Results = New-Object System.Collections.ArrayList
$script:Notes = New-Object System.Collections.ArrayList
$script:TempDirs = New-Object System.Collections.ArrayList
$script:Started = [Diagnostics.Stopwatch]::StartNew()

# ------------------------------------------------------------------ mini framework

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw ('Erwartet: ' + $Message) }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    $e = ConvertTo-Json -InputObject $Expected -Compress -Depth 10
    $a = ConvertTo-Json -InputObject $Actual -Compress -Depth 10
    if ($e -ne $a) { throw ("{0}: erwartet {1}, bekommen {2}" -f $Message, $e, $a) }
}

function Test-Case([string]$Group, [string]$Name, [scriptblock]$Body) {
    if ($Only -and $Group -ne $Only) { return }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ok = $true
    $msg = ''
    try { $null = & $Body } catch {
        $ok = $false
        $msg = [string]$_.Exception.Message
        $frame = @(([string]$_.ScriptStackTrace) -split "`n" | Where-Object { $_ -match 'Run-Tests\.ps1: line \d+' -and $_ -notmatch '^at Assert-' })[0]
        if ($frame -match 'line (\d+)') { $msg += ' (Zeile ' + $Matches[1] + ')' }
    }
    $ms = $sw.ElapsedMilliseconds
    [void]$script:Results.Add([pscustomobject]@{ group = $Group; name = $Name; ok = $ok; msg = $msg; ms = $ms })
    if ($ok) { Write-Host ("PASS  [{0}] {1} ({2} ms)" -f $Group, $Name, $ms) -ForegroundColor Green }
    else { Write-Host ("FAIL  [{0}] {1}: {2}" -f $Group, $Name, $msg) -ForegroundColor Red }
}

function Add-Note([string]$Text) {
    [void]$script:Notes.Add($Text)
    Write-Host ('NOTE  ' + $Text) -ForegroundColor Yellow
}

function New-TempDir([string]$Name) {
    $d = Join-Path ([IO.Path]::GetTempPath()) ('velox-test-' + $Name + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    [void][IO.Directory]::CreateDirectory($d)
    [void]$script:TempDirs.Add($d)
    return $d
}

# ------------------------------------------------------------------ load the backend in-process

foreach ($n in @('Common', 'System', 'Catalog', 'Engine', 'Detweak', 'Scan', 'Advisor', 'Claude', 'Extras', 'Jobs', 'Server')) {
    . (Join-Path (Join-Path $AppRoot 'core') ($n + '.ps1'))
}
Initialize-VxRuntime

# Fresh simulate context on the fixture catalog. -Seed adds the "foreign tweaks".
function New-TestContext([string]$DataDir = $FixtureData, [string]$SimProfile = 'desktop', [switch]$Seed) {
    $root = New-TempDir 'ctx'
    $ctx = New-VxContext -AppRoot $AppRoot -DataRoot $root -Simulate $true -SimProfile $SimProfile -DataDir $DataDir
    $ctx.Windows = $false
    $ctx.Simulate = $true
    Initialize-VxOsInfo
    $null = Import-VxSettings
    $null = Import-VxState
    $null = Import-VxCatalog
    $ctx.Sim.Clear()
    foreach ($k in @('reg', 'svc', 'task', 'bcd', 'power', 'pws', 'feature', 'appx', 'ps')) { $ctx.Sim[$k] = @{} }
    $ctx.Sim.seeded = $true
    if ($Seed) { Initialize-VxSimSeed }
    $ctx.State.profile = Get-VxSimProfile $SimProfile
    $global:VxJob = $null
    return $ctx
}

function Get-Status([string]$Id) {
    $r = Get-VxTweakStatus (Get-VxTweak $Id)
    if ($null -eq $r) { return $null }
    return $r.status
}

function Invoke-Change([string]$Id, [string]$Mode) {
    $J = New-VxJournal $Mode 'test'
    $r = Invoke-VxTweakChange (Get-VxTweak $Id) $Mode $J
    $bid = Complete-VxJournal $J
    $r['backupId'] = $bid
    return $r
}

# Everything a fixture/real tweak can touch, as one comparable JSON string.
function Get-SimSnapshot {
    $out = New-Object System.Collections.ArrayList
    foreach ($t in $global:VxCtx.Catalog.tweaks) {
        foreach ($a in @($t.actions)) {
            switch ([string]$a.type) {
                'reg' { foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) { [void]$out.Add(('reg ' + $p + '|' + $a.name + '=' + (ConvertTo-Json -InputObject (Get-VxRegValue $p ([string]$a.name)) -Compress))) } }
                'regkey' { foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) { [void]$out.Add(('key ' + $p + '=' + (ConvertTo-Json -InputObject (Export-VxRegTree $p) -Compress -Depth 20))) } }
                'service' { [void]$out.Add(('svc ' + $a.name + '=' + (Get-VxServiceStart ([string]$a.name)))) }
                'task' { [void]$out.Add(('task ' + $a.path + '=' + (Get-VxTaskState ([string]$a.path)))) }
                'bcd' { [void]$out.Add(('bcd ' + $a.name + '=' + (Get-VxBcdValue ([string]$a.name)))) }
                'powersetting' { [void]$out.Add(('pws ' + $a.setting + '=' + (ConvertTo-Json -InputObject (Get-VxPowerSetting ([string]$a.subgroup) ([string]$a.setting) $a.default) -Compress))) }
                'feature' { [void]$out.Add(('feat ' + $a.name + '=' + (Get-VxFeatureState ([string]$a.name)))) }
            }
        }
        $i = 0
        foreach ($a in @($t.actions)) {
            if ([string]$a.type -eq 'ps') { [void]$out.Add(('ps ' + $t.id + '#' + $i + '=' + (Get-VxPsState $a $t $i))) }
            $i++
        }
    }
    [void]$out.Add(('plan=' + (Get-VxActivePlan).guid))
    return (($out | Sort-Object) -join "`n")
}

function Compare-Snapshot([string]$A, [string]$B) {
    $x = $A -split "`n"; $y = $B -split "`n"
    $d = @(Compare-Object $x $y | Select-Object -First 4 | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject })
    return ($d -join ' || ')
}

# ==================================================================== compat
$psFiles = @(Get-ChildItem -LiteralPath $AppRoot -Recurse -File -Filter '*.ps1' | Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.git)[\\/]' })

Test-Case 'compat' 'alle .ps1-Dateien sind fehlerfrei parsebar' {
    foreach ($f in $psFiles) {
        $tokens = $null; $errs = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
        Assert-True ($errs.Count -eq 0) ("{0} parsebar: {1}" -f $f.Name, (($errs | Select-Object -First 1) -join ''))
    }
}

Test-Case 'compat' 'keine PS7-only Syntax oder Cmdlet-Features (AST-Scan)' {
    $badTokens = @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark')
    $problems = New-Object System.Collections.ArrayList
    foreach ($f in $psFiles) {
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
        foreach ($t in $tokens) { if ($badTokens -contains [string]$t.Kind) { [void]$problems.Add(("{0}:{1} Operator {2}" -f $f.Name, $t.Extent.StartLineNumber, $t.Kind)) } }
        $nodes = $ast.FindAll({ $true }, $true)
        foreach ($n in $nodes) {
            $line = $n.Extent.StartLineNumber
            if ($n -is [System.Management.Automation.Language.TypeDefinitionAst]) { [void]$problems.Add(("{0}:{1} class-Definition" -f $f.Name, $line)) }
            if ($n -is [System.Management.Automation.Language.UsingStatementAst]) { [void]$problems.Add(("{0}:{1} using-Anweisung" -f $f.Name, $line)) }
            if ($n -is [System.Management.Automation.Language.ScriptBlockAst] -and $n.PSObject.Properties['CleanBlock'] -and $null -ne $n.CleanBlock) { [void]$problems.Add(("{0}:{1} clean-Block" -f $f.Name, $line)) }
            if ($n -is [System.Management.Automation.Language.VariableExpressionAst]) {
                $vn = $n.VariablePath.UserPath
                if (@('PSStyle', 'IsWindows', 'IsLinux', 'IsMacOS', 'IsCoreCLR') -contains $vn) { [void]$problems.Add(("{0}:{1} Variable `${2}" -f $f.Name, $line, $vn)) }
            }
            if ($n -is [System.Management.Automation.Language.AssignmentStatementAst]) {
                if ($n.Left.Extent.Text -match 'ErrorActionPreference' -and $n.Right.Extent.Text -match 'Stop') { [void]$problems.Add(("{0}:{1} ErrorActionPreference = Stop" -f $f.Name, $line)) }
            }
            if ($n -is [System.Management.Automation.Language.CommandAst]) {
                $cmd = [string]$n.GetCommandName()
                $params = @($n.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName.ToLowerInvariant() })
                                switch -Regex ($cmd) {
                    '^(ForEach-Object|%|foreach)$' { if ($params -contains 'parallel') { [void]$problems.Add(("{0}:{1} ForEach-Object -Parallel" -f $f.Name, $line)) } }
                    '^ConvertFrom-Json$' { if ($params -contains 'ashashtable' -or $params -contains 'depth') { [void]$problems.Add(("{0}:{1} ConvertFrom-Json -AsHashtable/-Depth" -f $f.Name, $line)) } }
                    '^(Test-Json|Get-Error)$' { [void]$problems.Add(("{0}:{1} {2}" -f $f.Name, $line, $cmd)) }
                    '^Get-Content$' { if ($params -contains 'asbytestream') { [void]$problems.Add(("{0}:{1} -AsByteStream" -f $f.Name, $line)) } }
                    '^(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)$' { if ($params -contains 'skiphttperrorcheck' -or $params -contains 'statuscodevariable') { [void]$problems.Add(("{0}:{1} {2} PS7-Parameter" -f $f.Name, $line, $cmd)) } }
                    '^Split-Path$' { if ($params -contains 'leafbase' -or $params -contains 'extension') { [void]$problems.Add(("{0}:{1} Split-Path -LeafBase/-Extension" -f $f.Name, $line)) } }
                    '^Get-Date$' { if ($params -contains 'asutc') { [void]$problems.Add(("{0}:{1} Get-Date -AsUTC" -f $f.Name, $line)) } }
                    '^Start-Process$' { if ($params -contains 'environment') { [void]$problems.Add(("{0}:{1} Start-Process -Environment" -f $f.Name, $line)) } }
                    '^Set-StrictMode$' { [void]$problems.Add(("{0}:{1} Set-StrictMode" -f $f.Name, $line)) }
                    '^Join-Path$' {
                        $positional = @($n.CommandElements | Select-Object -Skip 1 | Where-Object { -not ($_ -is [System.Management.Automation.Language.CommandParameterAst]) })
                        if ($params -contains 'additionalchildpath' -or ($params.Count -eq 0 -and $positional.Count -gt 2)) { [void]$problems.Add(("{0}:{1} Join-Path mit mehreren Kindern" -f $f.Name, $line)) }
                    }
                }
                $els = @($n.CommandElements)
                for ($ei = 0; $ei -lt $els.Count - 1; $ei++) {
                    if ($els[$ei] -is [System.Management.Automation.Language.CommandParameterAst] -and $els[$ei].ParameterName -eq 'Encoding' -and $els[$ei + 1].Extent.Text -match '(?i)utf8NoBOM') {
                        [void]$problems.Add(("{0}:{1} -Encoding utf8NoBOM" -f $f.Name, $line))
                    }
                }
            }
        }
    }
    Assert-True ($problems.Count -eq 0) ("keine Funde, aber: " + ($problems -join '; '))
}

Test-Case 'compat' 'PSScriptAnalyzer: PSUseCompatibleSyntax 5.1 + Commands/Types (Win10, PS 5.1)' {
    $mod = Get-Module -ListAvailable -Name PSScriptAnalyzer | Sort-Object Version -Descending | Select-Object -First 1
    if ($null -eq $mod) { Add-Note 'PSScriptAnalyzer ist nicht installiert - Kompatibilitätsprüfung übersprungen.'; return }
    Import-Module $mod.Path -ErrorAction Stop
    $profileName = 'win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework'
    $profileFile = Join-Path (Join-Path $mod.ModuleBase 'compatibility_profiles') ($profileName + '.json')
    $rules = @{ PSUseCompatibleSyntax = @{ Enable = $true; TargetVersions = @('5.1') } }
    $includeRules = @('PSUseCompatibleSyntax')
    if (Test-Path -LiteralPath $profileFile) {
        $rules.PSUseCompatibleCommands = @{ Enable = $true; TargetProfiles = @($profileName) }
        $rules.PSUseCompatibleTypes = @{ Enable = $true; TargetProfiles = @($profileName) }
        $includeRules += @('PSUseCompatibleCommands', 'PSUseCompatibleTypes')
    } else { Add-Note 'Kompatibilitätsprofil für Windows PowerShell 5.1 fehlt - nur Syntax geprüft.' }
    $settings = @{ IncludeRules = $includeRules; Rules = $rules }
    $found = New-Object System.Collections.ArrayList
    # Commands that only exist on Windows / in modules missing from the analyzer profile, but are
    # always guarded by Get-Command or only reached on Windows. Each one was checked by hand.
    $allowedCommands = @('Get-WindowsOptionalFeature', 'Enable-WindowsOptionalFeature', 'Disable-WindowsOptionalFeature',
        'Get-AppxPackage', 'Remove-AppxPackage', 'Get-AppxProvisionedPackage', 'Remove-AppxProvisionedPackage',
        'Get-ScheduledTask', 'Enable-ScheduledTask', 'Disable-ScheduledTask', 'Get-MpComputerStatus', 'Get-MMAgent', 'Enable-MMAgent', 'Disable-MMAgent')
    foreach ($f in $psFiles) {
        foreach ($d in @(Invoke-ScriptAnalyzer -Path $f.FullName -Settings $settings)) {
            $skip = $false
            foreach ($c in $allowedCommands) { if ($d.RuleName -eq 'PSUseCompatibleCommands' -and $d.Message -match [regex]::Escape("'" + $c + "'")) { $skip = $true } }
            # WinForms is loaded explicitly with Add-Type -AssemblyName right before use (pick-file dialog)
            if ($d.RuleName -eq 'PSUseCompatibleTypes' -and $d.Message -match "'System\.Windows\.Forms\.") { $skip = $true }
            if (-not $skip) { [void]$found.Add(("{0}:{1} {2}: {3}" -f $f.Name, $d.Line, $d.RuleName, $d.Message)) }
        }
    }
    Assert-True ($found.Count -eq 0) ("keine Analyzer-Funde, aber: " + ($found -join ' || '))
}

Test-Case 'compat' 'Dateikodierung (UTF-8 BOM .ps1, CRLF/ASCII .bat): Normalize-Files -Check' {
    $out = & $HostExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Join-Path $AppRoot 'tools') 'Normalize-Files.ps1') -Check 2>&1
    Assert-True ($LASTEXITCODE -eq 0) ('Normalize-Files -Check ok: ' + ($out -join ' '))
}

Test-Case 'compat' 'core-Dateien haben keine Top-Level-Seiteneffekte' {
    foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $AppRoot 'core') -Filter '*.ps1')) {
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
        foreach ($st in $ast.EndBlock.Statements) {
            Assert-True ($st -is [System.Management.Automation.Language.FunctionDefinitionAst]) ("{0}: nur Funktionsdefinitionen auf oberster Ebene (Zeile {1})" -f $f.Name, $st.Extent.StartLineNumber)
        }
    }
}

# ==================================================================== catalog
Test-Case 'catalog' 'Validate-Catalog: Fixture-Katalog ist gültig' {
    $out = & $HostExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Join-Path $AppRoot 'tools') 'Validate-Catalog.ps1') -DataDir $FixtureData 2>&1
    Assert-True ($LASTEXITCODE -eq 0) ('Fixture-Katalog gültig: ' + ($out -join ' '))
}

Test-Case 'catalog' 'Validate-Catalog: echter Katalog data/ (nur mit -Strict fatal)' {
    $out = @(& $HostExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Join-Path $AppRoot 'tools') 'Validate-Catalog.ps1') -DataDir (Join-Path $AppRoot 'data') -Quiet 2>&1)
    $code = $LASTEXITCODE
    $summary = [string]($out | Where-Object { [string]$_ -match '^Catalog:' } | Select-Object -Last 1)
    if ($code -ne 0) {
        $errs = @($out | Where-Object { [string]$_ -match '^ERROR' })
        Add-Note ("Echter Katalog hat Fehler ({0}) - {1}. Erste: {2}" -f $errs.Count, $summary, (($errs | Select-Object -First 3) -join ' | '))
        if ($Strict) { throw 'echter Katalog ungültig (-Strict)' }
    } else { Add-Note ('Echter Katalog: ' + $summary) }
}

Test-Case 'catalog' 'Import-VxCatalog lädt Fixture mit Kategorie, kind und Seed-Index' {
    $ctx = New-TestContext
    Assert-True ($ctx.Catalog.errors.Count -eq 0) 'keine Ladefehler'
    Assert-True ($ctx.Catalog.tweaks.Count -ge 30) 'mindestens 30 Fixture-Tweaks'
    $t = Get-VxTweak 'gaming.gamedvr-off'
    Assert-Equal 'gaming' $t.category 'category ergänzt'
    Assert-Equal 'toggle' $t.kind 'kind'
    Assert-True ($ctx.Seed.values.ContainsKey('hkcu\system\gameconfigstore|gamedvr_enabled')) 'Seed-Index kennt den Wert'
    $dto = ConvertTo-VxTweakDto $t $ctx.State.profile
    Assert-True ($dto.Contains('applicable') -and $dto.Contains('naReason') -and $dto.Contains('category')) 'DTO-Felder'
}

# ==================================================================== engine
Test-Case 'engine' 'Parser: bcdedit (deutsch), powercfg (sprachunabhängig), Argument-Quoting' {
    $bcd = "Windows-Startladeprogramm`r`n-------------------------`r`nBezeichner              {current}`r`ndevice                  partition=C:`r`ndescription             Windows 11`r`nuseplatformclock        Ja`r`ndisabledynamictick      Yes`r`nresumeobject            {1234}`r`n"
    $h = ConvertFrom-VxBcdOutput $bcd
    Assert-Equal 'Ja' $h['useplatformclock'] 'useplatformclock gelesen'
    Assert-True (Test-VxBcdEqual $h['useplatformclock'] 'yes') 'Ja == yes'
    Assert-True (Test-VxBcdEqual 'On' 'TRUE') 'On == true'
    Assert-True (-not (Test-VxBcdEqual 'yes' 'no')) 'yes != no'
    $pc = "Energieschema-GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Ausbalanciert)`r`n  GUID der Untergruppe: 54533251-82be-4824-96c1-47b60b740d00  (Prozessorenergieverwaltung)`r`n    Minimaler möglicher Wert: 0x00000000`r`n    Maximaler möglicher Wert: 0x00000064`r`n  Aktueller Wechselstrom-Energieeinstellungsindex: 0x00000064`r`n  Aktueller Gleichstrom-Energieeinstellungsindex: 0x0000000a`r`n"
    $v = ConvertFrom-VxPowercfgQuery $pc
    Assert-Equal 100 ([int]$v.ac) 'AC'
    Assert-Equal 10 ([int]$v.dc) 'DC'
    Assert-Equal '{current}' (ConvertTo-VxArgument '{current}') 'kein Quoting nötig'
    Assert-Equal '"C:\Program Files\x"' (ConvertTo-VxArgument 'C:\Program Files\x') 'Leerzeichen gequotet'
    Assert-Equal '"a\"b"' (ConvertTo-VxArgument 'a"b') 'Anführungszeichen escaped'
    Assert-Equal '"C:\dir with space\\"' (ConvertTo-VxArgument 'C:\dir with space\') 'Backslash vor Quote verdoppelt'
}

Test-Case 'engine' 'Registry-Werte: DWORD > 0x7FFFFFFF, QWord, Binary, MultiString, ExpandString' {
    $null = New-TestContext
    Assert-Equal (-1) (ConvertTo-VxRegRaw 4294967295 'DWord') 'DWORD 0xFFFFFFFF als Int32-Bitmuster'
    Assert-Equal (-2147483648) (ConvertTo-VxRegRaw 2147483648 'DWord') 'DWORD 0x80000000'
    Assert-Equal 4294967295 (ConvertFrom-VxRegRaw -1 'DWord') 'DWORD zurück unsigned'
    Assert-Equal '9E1E0780' (ConvertTo-VxHex (ConvertTo-VxRegRaw '9e1e0780' 'Binary')) 'Binary hex'
    $r = Invoke-Change 'system.value-kinds' 'apply'
    Assert-True $r.ok ('apply ok: ' + $r.error)
    $p = 'HKLM\SOFTWARE\VeloxFixture\Values'
    Assert-Equal 4294967295 ([long](Get-VxRegValue $p 'BigDword').value) 'BigDword'
    Assert-Equal 5000000000 ([long](Get-VxRegValue $p 'QWordVal').value) 'QWord'
    Assert-Equal '9E1E078012000000' (Get-VxRegValue $p 'BinaryVal').value 'Binary'
    Assert-Equal @('alpha', 'beta') @((Get-VxRegValue $p 'MultiVal').value) 'MultiString'
    Assert-Equal '%SystemRoot%\velox' (Get-VxRegValue $p 'ExpandVal').value 'ExpandString unexpandiert'
    Assert-Equal 'applied' (Get-Status 'system.value-kinds') 'Status applied'
    $r = Invoke-Change 'system.value-kinds' 'revert'
    Assert-True $r.ok 'revert ok'
    Assert-Equal @('gamma') @((Get-VxRegValue $p 'MultiVal').value) 'MultiString Standard'
    Assert-Equal 'default' (Get-Status 'system.value-kinds') 'Status default'
}

Test-Case 'engine' 'jeder Aktionstyp: apply -> applied -> revert -> default' {
    $null = New-TestContext
    $ids = @('gaming.gamedvr-off', 'gaming.gamemode-on', 'gaming.hags-on', 'gaming.mmcss-games', 'gaming.nvidia-telemetry-off',
        'latency.timer-bcd', 'latency.mouse-accel-off', 'network.nagle-off', 'network.eee-off', 'network.autotuning',
        'power.ultimate-plan', 'power.high-plan', 'power.core-parking-off', 'power.usb-suspend-off', 'services.sysmain-off', 'services.diagtrack-off',
        'services.fax-off', 'services.delayed-start', 'system.classic-context-menu', 'system.xps-off', 'privacy.telemetry-policy',
        'privacy.ads-id-off', 'memory.compression-off', 'games.fivem-priority', 'security.vbs-off')
    foreach ($id in $ids) {
        Assert-Equal 'default' (Get-Status $id) "$id vorher"
        $r = Invoke-Change $id 'apply'
        Assert-True $r.ok ("$id apply ok: " + $r.error)
        Assert-Equal 'applied' $r.status "$id nach apply"
        Assert-True ($r.changed -gt 0) "$id hat etwas geändert"
        $r2 = Invoke-Change $id 'revert'
        Assert-True $r2.ok ("$id revert ok: " + $r2.error)
        Assert-Equal 'default' $r2.status "$id nach revert"
    }
}

Test-Case 'engine' 'Details: Wildcard, onlyExisting, regkey + Standardwert, Dienste, BCD, Energie' {
    $null = New-TestContext
    $null = Invoke-Change 'network.nagle-off' 'apply'
    $ifs = @(Resolve-VxRegPattern 'HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\*')
    Assert-True ($ifs.Count -ge 2) 'Wildcard findet mehrere Schnittstellen'
    foreach ($k in $ifs) { Assert-Equal 1 ([int](Get-VxRegValue $k 'TCPNoDelay').value) "TCPNoDelay auf $k" }
    $null = Invoke-Change 'network.nagle-off' 'revert'
    foreach ($k in $ifs) { Assert-True (-not (Get-VxRegValue $k 'TCPNoDelay').exists) "TCPNoDelay gelöscht auf $k" }
    # onlyExisting: the value does not exist anywhere -> nothing written, status na
    Assert-Equal 'na' (Get-Status 'network.flowcontrol-off') 'onlyExisting ohne vorhandene Werte = na'
    $r = Invoke-Change 'network.flowcontrol-off' 'apply'
    Assert-Equal 0 $r.changed 'onlyExisting legt nichts an'
    # regkey + default value
    $null = Invoke-Change 'system.classic-context-menu' 'apply'
    $ck = 'HKCU\Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32'
    Assert-True (Test-VxRegKey $ck) 'Schlüssel angelegt'
    $dv = Get-VxRegValue $ck ''
    Assert-True ($dv.exists -and $dv.value -eq '') 'Standardwert leer gesetzt'
    $null = Invoke-Change 'system.classic-context-menu' 'revert'
    Assert-True (-not (Test-VxRegKey $ck)) 'Schlüssel wieder entfernt'
    # services
    $null = Invoke-Change 'services.delayed-start' 'apply'
    Assert-Equal 'AutomaticDelayed' (Get-VxServiceStart 'Spooler') 'verzögerter Start'
    $null = Invoke-Change 'services.delayed-start' 'revert'
    Assert-Equal 'Automatic' (Get-VxServiceStart 'Spooler') 'automatisch'
    $global:VxCtx.Sim.svc['vxnosuchservice'] = '__missing__'
    $st = Get-VxTweakStatus (Get-VxTweak 'services.missing-service')
    Assert-Equal 'na' $st.status 'fehlender Dienst = na'
    Assert-True ($st.naReason -match 'Dienst') 'deutscher naReason'
    $r = Invoke-Change 'services.missing-service' 'apply'
    Assert-True (-not $r.ok -and $r.status -eq 'na') 'apply auf na-Tweak wird verweigert'
    # when.os
    Assert-Equal 'na' (Get-Status 'system.win10-only') 'Windows-10-Tweak auf Win11 = na'
    # BCD
    $null = Invoke-Change 'latency.timer-bcd' 'apply'
    Assert-Equal 'yes' (Get-VxBcdValue 'disabledynamictick') 'bcd gesetzt'
    $null = Invoke-Change 'latency.timer-bcd' 'revert'
    Assert-True ($null -eq (Get-VxBcdValue 'disabledynamictick')) 'bcd /deletevalue'
    # power plan
    $null = Invoke-Change 'power.ultimate-plan' 'apply'
    Assert-Equal 'e9a42b02-d5df-448d-aa00-03f14749eb61' (Get-VxActivePlan).guid 'Ultimative Leistung aktiv'
    $null = Invoke-Change 'power.ultimate-plan' 'revert'
    Assert-Equal '381b4222-f694-41f0-9685-ff5bb260df2e' (Get-VxActivePlan).guid 'Ausbalanciert aktiv'
    # powersetting: revert goes back to the remembered previous value, not the catalog default
    Set-VxPowerSetting '54533251-82be-4824-96c1-47b60b740d00' '0cc5b647-c1df-4637-891a-dec35c318583' 50 50
    Assert-Equal 'custom' (Get-Status 'power.core-parking-off') 'fremder Wert = custom'
    $null = Invoke-Change 'power.core-parking-off' 'apply'
    Assert-Equal 'applied' (Get-Status 'power.core-parking-off') 'applied'
    $null = Invoke-Change 'power.core-parking-off' 'revert'
    $v = Get-VxPowerSetting '54533251-82be-4824-96c1-47b60b740d00' '0cc5b647-c1df-4637-891a-dec35c318583' $null
    Assert-Equal 50 ([int]$v.ac) 'vorheriger Wert wiederhergestellt'
}

Test-Case 'engine' 'Status custom / partial / remove / action' {
    $null = New-TestContext
    Set-VxRegValue 'HKCU\System\GameConfigStore' 'GameDVR_Enabled' 'DWord' 7
    Assert-Equal 'custom' (Get-Status 'gaming.gamedvr-off') 'fremder Wert = custom'
    Set-VxRegValue 'HKCU\System\GameConfigStore' 'GameDVR_Enabled' 'DWord' 0
    Assert-Equal 'partial' (Get-Status 'gaming.gamedvr-off') 'halb angewendet = partial'
    Set-VxRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games' 'Scheduling Category' 'String' 'high'
    Set-VxRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games' 'Priority' 'DWord' 6
    Set-VxRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games' 'SFIO Priority' 'String' 'HIGH'
    Assert-Equal 'applied' (Get-Status 'gaming.mmcss-games') 'Strings ohne Groß-/Kleinschreibung verglichen'
    # remove (Appx)
    Assert-Equal 'default' (Get-Status 'apps.bingnews') 'App installiert = default'
    $r = Invoke-Change 'apps.bingnews' 'apply'
    Assert-True $r.ok 'App entfernt'
    Assert-Equal 'applied' $r.status 'entfernt = applied'
    $r = Invoke-Change 'apps.bingnews' 'revert'
    Assert-True (-not $r.ok -and $r.error -match 'Store') 'Entfernen nicht rückgängig machbar'
    # action: no status
    Assert-True ($null -eq (Get-VxTweakStatus (Get-VxTweak 'cleanup.temp'))) 'action hat keinen Status'
    $r = Invoke-Change 'cleanup.temp' 'apply'
    Assert-True $r.ok 'Reinigung im Testmodus ok'
}

Test-Case 'engine' 'Journal: wird vor der Änderung geschrieben, Restore stellt exakt den alten Zustand her' {
    $ctx = New-TestContext -Seed
    # foreign / custom values and a whole key tree that the tweaks will overwrite or delete
    Set-VxRegValue 'HKCU\System\GameConfigStore' 'GameDVR_Enabled' 'DWord' 9
    Set-VxRegValue 'HKCU\Software\VeloxFixture\Tree' 'A' 'DWord' 3000000000
    Set-VxRegValue 'HKCU\Software\VeloxFixture\Tree' 'B' 'Binary' '00FF10'
    Set-VxRegValue 'HKCU\Software\VeloxFixture\Tree\Sub' 'C' 'MultiString' @('x', 'y')
    Set-VxPowerSetting '54533251-82be-4824-96c1-47b60b740d00' '0cc5b647-c1df-4637-891a-dec35c318583' 33 44
    $before = Get-SimSnapshot
    $ids = @('gaming.gamedvr-off', 'system.remove-tree', 'system.value-kinds', 'network.nagle-off', 'latency.timer-bcd', 'power.ultimate-plan',
        'power.core-parking-off', 'services.diagtrack-off', 'system.xps-off', 'network.autotuning', 'system.classic-context-menu', 'services.sysmain-off')
    $res = Invoke-VxApplyJob ([pscustomobject]@{ ids = $ids; label = 'Test' }) 'apply'
    Assert-True ($null -ne $res.backupId) 'Backup-ID'
    foreach ($r in $res.results) { Assert-True $r.ok ("{0}: {1}" -f $r.id, $r.error) }
    Assert-True (-not (Test-VxRegKey 'HKCU\Software\VeloxFixture\Tree')) 'Baum gelöscht'
    $doc = Read-VxBackup $res.backupId
    $treeEntry = @($doc.entries | Where-Object { $_.op -eq 'regkey' -and $_.path -eq 'HKCU\Software\VeloxFixture\Tree' })[0]
    Assert-True ($null -ne $treeEntry.tree) 'Baum im Journal exportiert'
    Assert-True ($res.needs.reboot) 'needs.reboot gesetzt'
    Assert-True ($res.needs.explorer) 'needs.explorer gesetzt'
    $list = @(Get-VxBackupList)
    $b = @($list | Where-Object { $_.id -eq $res.backupId })[0]
    Assert-True ($null -ne $b -and $b.count -gt 10 -and $b.restorable -and $b.simulate) 'Backup-Liste'
    $rr = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $res.backupId })
    Assert-Equal 0 $rr.failed ('Restore ohne Fehler: ' + ($rr.errors -join '; '))
    Assert-True ($rr.restored -gt 10) 'Einträge wiederhergestellt'
    $after = Get-SimSnapshot
    Assert-True ($before -eq $after) ('Zustand nach Restore identisch: ' + (Compare-Snapshot $before $after))
    Assert-Equal 3000000000 ([long](Get-VxRegValue 'HKCU\Software\VeloxFixture\Tree' 'A').value) 'großes DWORD im Baum'
    Assert-Equal @('x', 'y') @((Get-VxRegValue 'HKCU\Software\VeloxFixture\Tree\Sub' 'C').value) 'Unterschlüssel im Baum'
    # an interrupted journal (line file without .json) is still listed and readable
    $J = New-VxJournal 'apply' 'abgebrochen'
    Add-VxJournalEntry $J ([ordered]@{ op = 'reg'; path = 'HKCU\X'; name = 'Y'; before = @{ exists = $false }; after = @{ exists = $true; kind = 'DWord'; value = 1 } })
    $ib = Read-VxBackup $J.id
    Assert-True ($null -ne $ib -and @($ib.entries).Count -eq 1 -and $ib.label -match 'unterbrochen') 'unterbrochenes Journal lesbar'
    Assert-True (Test-VxBackupId '20261005-153012-apply') 'gültige ID'
    Assert-True (-not (Test-VxBackupId '..\..\x')) 'Traversal-ID abgelehnt'
}

Test-Case 'engine' 'Cleanup: gefährliche Pfade werden verweigert, Fake-Größen im Testmodus' {
    $null = New-TestContext
    $saved = @{ SystemRoot = $env:SystemRoot; SystemDrive = $env:SystemDrive; USERPROFILE = $env:USERPROFILE }
    try {
        $env:SystemRoot = 'C:\Windows'; $env:SystemDrive = 'C:'; $env:USERPROFILE = 'C:\Users\Max'
        foreach ($p in @('C:\', 'C:', 'D:\', 'C:\Windows', 'C:\Windows\System32', 'C:\Users', 'C:\Users\Max', 'C:\Users\Someone\', '%TEMP%', 'C:\Temp\..\Windows', 'relative\path')) {
            Assert-True (-not (Test-VxCleanPathSafe $p)) "verweigert: $p"
        }
        foreach ($p in @('C:\Users\Max\AppData\Local\Temp', 'C:\Windows\Temp', 'C:\Windows\SoftwareDistribution\Download')) {
            Assert-True (Test-VxCleanPathSafe $p) "erlaubt: $p"
        }
    } finally { $env:SystemRoot = $saved.SystemRoot; $env:SystemDrive = $saved.SystemDrive; $env:USERPROFILE = $saved.USERPROFILE }
    $res = Invoke-VxCleanJob ([pscustomobject]@{})
    Assert-True (@($res.items).Count -eq 2) 'zwei Reinigungs-Aktionen gemessen'
    foreach ($i in $res.items) { Assert-True ($i.bytes -gt 0 -and $i.files -gt 0) ('Größe für ' + $i.id) }
    $res2 = Invoke-VxCleanJob ([pscustomobject]@{})
    Assert-Equal $res.items[0].bytes $res2.items[0].bytes 'Fake-Größen deterministisch'
    $run = Invoke-VxRunActionJob ([pscustomobject]@{ ids = @('cleanup.temp', 'repair.sfc', 'gaming.gamedvr-off') })
    Assert-True ($run.results[0].ok -and $run.results[0].freedBytes -gt 0) 'Reinigung meldet Bytes'
    Assert-True $run.results[1].ok 'Reparatur protokolliert'
    Assert-True (-not $run.results[2].ok) 'Toggle ist keine Aktion'
}

Test-Case 'engine' 'Autostart-Manager wie der Task-Manager (StartupApproved) + Journal' {
    $null = New-TestContext -Seed
    $items = @(Get-VxStartupItems)
    Assert-True ($items.Count -ge 6) 'Autostart-Einträge gefunden'
    $spot = @($items | Where-Object { $_.name -eq 'Spotify' })[0]
    Assert-True (-not $spot.enabled) 'Spotify ist deaktiviert (03...)'
    $disc = @($items | Where-Object { $_.name -eq 'Discord' })[0]
    Assert-True $disc.enabled 'Discord aktiv'
    $r = Invoke-VxStartupSetJob ([pscustomobject]@{ id = $disc.id; enabled = $false })
    Assert-True ($r.ok -and -not $r.item.enabled) 'Discord deaktiviert'
    $v = Get-VxRegValue 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' 'Discord'
    Assert-True ($v.kind -eq 'Binary' -and ([string]$v.value).StartsWith('03') -and ([string]$v.value).Length -eq 24) '12-Byte-Wert 03 + FILETIME'
    $b = @(Get-VxBackupList | Where-Object { $_.kind -eq 'startup' })[0]
    Assert-True ($null -ne $b) 'Journal angelegt'
    $null = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $b.id })
    Assert-True (@(Get-VxStartupItems | Where-Object { $_.name -eq 'Discord' })[0].enabled) 'Restore aktiviert wieder'
    $hk = @($items | Where-Object { $_.name -eq 'EpicGamesLauncher' })[0]
    Assert-True ($null -ne $hk -and $hk.location -match '32-Bit') 'WOW6432Node-Run erkannt'
}

Test-Case 'engine' 'Spiele: Erkennung (simuliert) + Boost mit IFEO, GPU-Präferenz, FSO (fremde Flags bleiben)' {
    $ctx = New-TestContext
    $g = Invoke-VxGamesDetectJob ([pscustomobject]@{})
    Assert-True (@($g.games).Count -ge 3) 'Spiele gefunden'
    $gta = @($g.games | Where-Object { $_.exe -eq 'GTA5.exe' })[0]
    Assert-True ($null -ne $gta -and $gta.id -and -not $gta.boost.priority) 'GTA V gefunden, noch ohne Boost'
    $lk = 'HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
    Set-VxRegValue $lk $gta.path 'String' '~ HIGHDPIAWARE'
    Set-VxRegValue 'HKCU\Software\Microsoft\DirectX\UserGpuPreferences' $gta.path 'String' 'SwapEffectUpgradeEnable=1;'
    $r = Invoke-VxGameBoostJob ([pscustomobject]@{ path = $gta.path; priority = $true; gpu = $true; fso = $true; name = 'GTA V' })
    Assert-True ($r.ok -and $r.game.boost.priority -and $r.game.boost.gpu -and $r.game.boost.fso) 'Boost aktiv'
    Assert-Equal 3 ([int](Get-VxRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\GTA5.exe\PerfOptions' 'CpuPriorityClass').value) 'IFEO CpuPriorityClass=3'
    Assert-Equal 'GpuPreference=2;SwapEffectUpgradeEnable=1;' (Get-VxRegValue 'HKCU\Software\Microsoft\DirectX\UserGpuPreferences' $gta.path).value 'GPU-Präferenz, andere Werte erhalten'
    Assert-Equal '~ HIGHDPIAWARE DISABLEDXMAXIMIZEDWINDOWEDMODE' (Get-VxRegValue $lk $gta.path).value 'FSO-Flag ergänzt'
    Assert-True (@($ctx.Settings.games | Where-Object { $_.path -eq $gta.path }).Count -eq 1) 'in settings.games gemerkt'
    $r = Invoke-VxGameBoostJob ([pscustomobject]@{ path = $gta.path; priority = $false; gpu = $false; fso = $false })
    Assert-Equal '~ HIGHDPIAWARE' (Get-VxRegValue $lk $gta.path).value 'nur das eigene Flag entfernt'
    Assert-Equal 'SwapEffectUpgradeEnable=1;' (Get-VxRegValue 'HKCU\Software\Microsoft\DirectX\UserGpuPreferences' $gta.path).value 'GPU-Präferenz entfernt'
    Assert-True (-not (Test-VxRegKey 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\GTA5.exe\PerfOptions')) 'leerer PerfOptions-Schlüssel entfernt'
    Assert-True (@($ctx.Settings.games).Count -eq 0) 'aus settings.games entfernt'
    $failed = $false
    try { $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = 'C:\x\..\evil.bat'; priority = $true }) } catch { $failed = $true }
    Assert-True $failed 'ungültiger Pfad abgelehnt'
    Assert-Equal $null (Invoke-VxPickFileJob ([pscustomobject]@{})).path 'Dateiauswahl außerhalb Windows = null'
}

# True when every action's target equals its Windows default (the tweak only repairs other tools' changes).
function Test-TweakIsNoop($Tweak) {
    $acts = @($Tweak.actions)
    if ($acts.Count -eq 0) { return $false }
    foreach ($a in $acts) {
        switch ([string]$a.type) {
            'reg' { if (-not (Test-VxRegEqual ([string]$a.kind) $a.value (Get-VxActionDefault $a))) { return $false } }
            'powersetting' {
                $d = Get-VxProp $a 'default'
                if ($null -eq $d -or [long]$a.ac -ne [long](Get-VxProp $d 'ac')) { return $false }
                if ($null -ne $a.dc -and [long]$a.dc -ne [long](Get-VxProp $d 'dc')) { return $false }
            }
            'service' { if ([string]$a.start -ne [string](Get-VxActionDefault $a)) { return $false } }
            'powerplan' { if ([string]$a.plan -ne [string]$a.default) { return $false } }
            default { return $false }
        }
    }
    return $true
}

# ==================================================================== real catalog round trip
Test-Case 'realcatalog' 'echter Katalog: jeder Toggle apply -> applied, revert -> default (Testmodus)' {
    $realData = Join-Path $AppRoot 'data'
    $tdir = Join-Path $realData 'tweaks'
    if (-not (Test-Path -LiteralPath $tdir) -or @(Get-ChildItem -LiteralPath $tdir -Filter '*.json' -ErrorAction SilentlyContinue).Count -eq 0) {
        Add-Note 'data/tweaks/*.json noch nicht vorhanden - Round-Trip des echten Katalogs übersprungen.'
        return
    }
    $ctx = New-TestContext -DataDir $realData
    if ($ctx.Catalog.errors.Count -gt 0) {
        Add-Note ('Echter Katalog lädt nicht sauber - Round-Trip übersprungen: ' + ($ctx.Catalog.errors -join '; '))
        return
    }
    $bad = New-Object System.Collections.ArrayList
    $done = 0; $skipped = 0; $noop = 0
    foreach ($t in @($ctx.Catalog.tweaks)) {
        $kind = Get-VxTweakKind $t
        if ($kind -eq 'action') { continue }
        # tweaks whose target already IS the Windows default (documented in the catalog) start as applied
        $restStatus = 'default'
        if (Test-TweakIsNoop $t) { $restStatus = 'applied'; $noop++ }
        $before = Get-Status $t.id
        if ($before -eq 'na') { $skipped++; continue }
        if ($before -ne $restStatus) { [void]$bad.Add(("{0}: vorher {1}" -f $t.id, $before)); continue }
        $r = Invoke-Change $t.id 'apply'
        if (-not $r.ok -or $r.status -ne 'applied') { [void]$bad.Add(("{0}: apply -> {1} {2}" -f $t.id, $r.status, $r.error)); continue }
        if ($kind -eq 'remove') { $done++; continue }
        $r = Invoke-Change $t.id 'revert'
        if (-not $r.ok -or $r.status -ne $restStatus) { [void]$bad.Add(("{0}: revert -> {1} {2}" -f $t.id, $r.status, $r.error)); continue }
        $done++
    }
    Add-Note ("Echter Katalog: {0} Tweaks hin und zurück geprüft ({1} davon sind auf einem frischen Windows schon so), {2} nicht anwendbar (na) im simulierten Desktop-Profil." -f $done, $noop, $skipped)
    Assert-True ($bad.Count -eq 0) ("alle Round-Trips ok, aber: " + ($bad -join ' || '))
}

# ==================================================================== detweak
Test-Case 'detweak' 'Fremd-Tweaks finden, gezielt zurücksetzen, Journal stellt sie wieder her' {
    $ctx = New-TestContext -Seed
    $null = Invoke-Change 'latency.timer-bcd' 'apply'
    $scan = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    $keys = @($scan.items | ForEach-Object { $_.key })
    Assert-True ($keys -contains 'reg|HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl|Win32PrioritySeparation') 'Win32PrioritySeparation gefunden'
    Assert-True ($keys -contains 'reg|HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile|SystemResponsiveness') 'SystemResponsiveness gefunden'
    Assert-True ($keys -contains 'bcd|useplatformclock') 'useplatformclock gefunden'
    Assert-True ($keys -contains 'regkey|HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\GTA5.exe\PerfOptions') 'IFEO-Schlüssel gefunden'
    Assert-True ($keys -contains 'tweak|services.sysmain-off') 'SysMain als Katalog-Eintrag'
    Assert-True ($keys -notcontains 'svc|SysMain') 'SysMain nicht doppelt (dedupliziert)'
    Assert-True ($keys -contains 'tweak|latency.timer-bcd') 'eigener Tweak erkannt'
    Assert-True ($keys -notcontains 'bcd|disabledynamictick') 'BCD-Wert nicht doppelt'
    Assert-True ($keys -notcontains 'reg|HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\0000|TcpAckFrequency') 'Standardwerte nicht gelistet'
    $prio = @($scan.items | Where-Object { $_.key -match 'Win32PrioritySeparation' })[0]
    Assert-True ($prio.current -match '38' -and $prio.default -match '^2' -and $prio.source -eq 'detweak' -and $prio.label) 'current/default/label'
    Assert-True (@($scan.commands).Count -eq 2 -and $scan.commands[0].id -eq 'power-defaults') 'Befehle gelistet'
    Assert-Equal $keys.Count ([int]$ctx.State.profile.foreignCount) 'foreignCount im Profil'
    $before = Get-SimSnapshot
    $prioBefore = (Get-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl' 'Win32PrioritySeparation').value
    $res = Invoke-VxDetweakJob ([pscustomobject]@{ keys = $keys; commands = @('power-defaults'); thenApply = @('gaming.gamedvr-off'); restorePoint = $true })
    Assert-Equal 0 $res.failed ('keine Fehler: ' + ($res.errors -join '; '))
    Assert-Equal ($keys.Count + 1) $res.reset 'alles zurückgesetzt (+ Befehl)'
    Assert-Equal 1 $res.applied 'danach angewendet'
    Assert-True ($null -ne $res.backupId -and $res.needs.reboot) 'Backup + Neustart nötig'
    Assert-Equal 2 ([int](Get-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl' 'Win32PrioritySeparation').value) 'Standard 2'
    Assert-True ($null -eq (Get-VxBcdValue 'useplatformclock')) 'BCD-Wert gelöscht'
    Assert-Equal 'Automatic' (Get-VxServiceStart 'SysMain') 'SysMain wieder automatisch'
    Assert-Equal 'applied' (Get-Status 'gaming.gamedvr-off') 'thenApply angewendet'
    $scan2 = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    $left = @($scan2.items | Where-Object { $_.source -eq 'detweak' -or $_.tweakId -ne 'gaming.gamedvr-off' })
    Assert-Equal 0 $left.Count ('nur noch der neu angewendete Tweak: ' + (($left | ForEach-Object { $_.key }) -join ', '))
    $rr = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $res.backupId })
    Assert-True ($rr.failed -eq 1) 'nur der Befehl ist nicht wiederherstellbar'
    Assert-Equal $prioBefore ((Get-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl' 'Win32PrioritySeparation').value) 'Fremdwert zurück'
    $after = Get-SimSnapshot
    Assert-True ($before -eq $after) ('Zustand wie vor dem Detweak: ' + (Compare-Snapshot $before $after))
    Assert-True (Test-VxRegKey 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\GTA5.exe\PerfOptions') 'IFEO-Baum zurück'
}

# ==================================================================== advisor
Test-Case 'advisor' 'Desktop vs. Laptop, Ziele, Hardware-Regeln, Befunde, deterministisch' {
    $ctx = New-TestContext
    $desk = Get-VxSimProfile 'desktop'
    $lap = Get-VxSimProfile 'laptop'
    $hddPath = Join-Path (Join-Path (Join-Path $TestRoot 'fixtures') 'profiles') 'hdd-8gb-amd.json'
    $hdd = ConvertTo-VxHashtable (Read-VxJsonFile $hddPath)
    $goals = @('gaming', 'competitive', 'balanced', 'privacy', 'laptop', 'streaming', 'fivem')
    foreach ($goal in $goals) {
        foreach ($p in @($desk, $lap, $hdd)) {
            $ctx.State.profile = $p
            $r = Invoke-VxAdvisor $goal '' $p
            Assert-Equal 'local' $r.engine 'engine'
            Assert-True ($r.score -ge 0 -and $r.score -le 100 -and $r.scoreAfter -ge $r.score -and $r.scoreAfter -le 100) "Score-Bereich ($goal)"
            foreach ($i in $r.plan) {
                $t = Get-VxTweak $i.id
                Assert-True ([string]$t.risk -ne 'risky') "nie riskant ($goal, $($i.id))"
                Assert-True ((Get-VxTweakKind $t) -eq 'toggle') 'nur Toggles'
                Assert-True ($i.reason -and @(1, 2, 3) -contains $i.priority) 'Grund + Priorität'
                if ((Test-VxIsLaptop $p) -or $goal -eq 'laptop') { Assert-True (@($t.tags) -notcontains 'laptop-bad') "kein laptop-bad auf Laptop ($goal, $($i.id))" }
            }
        }
    }
    $ctx.State.profile = $desk
    $g = Invoke-VxAdvisor 'gaming' '' $desk
    $ids = @($g.plan | ForEach-Object { $_.id })
    Assert-True ($ids -contains 'gaming.gamedvr-off' -and $ids -contains 'power.ultimate-plan') 'Gaming-Plan Desktop'
    Assert-True ($ids -notcontains 'power.high-plan') 'nur ein Energieplan im Plan (keine Konflikte)'
    Assert-True ($ids -contains 'gaming.nvidia-telemetry-off') 'NVIDIA-Tweak bei NVIDIA-Karte'
    Assert-True ($ids -notcontains 'gaming.amd-ulps-off') 'kein AMD-Tweak bei NVIDIA'
    Assert-True ($ids -notcontains 'security.vbs-off') 'kein riskanter Tweak'
    $sys = @($g.plan | Where-Object { $_.id -eq 'services.sysmain-off' })[0]
    Assert-True ($null -ne $sys -and $sys.reason -match 'NVMe-SSD') 'Begründung nennt die NVMe-SSD'
    $fids = @($g.findings | ForEach-Object { $_.id })
    foreach ($f in @('refresh-rate', 'xmp', 'vbs', 'power-plan', 'game-dvr', 'hags', 'uptime')) { Assert-True ($fids -contains $f) "Befund $f" }
    $rf = @($g.findings | Where-Object { $_.id -eq 'refresh-rate' })[0]
    Assert-True ($rf.severity -eq 'bad' -and $rf.fix.type -eq 'open' -and $rf.fix.target -eq 'ms-settings:display-advanced') 'Hz-Befund mit Fix'
    $xmp = @($g.findings | Where-Object { $_.id -eq 'xmp' })[0]
    Assert-True ($null -eq $xmp.fix -and $xmp.detail -match 'XMP') 'XMP-Hinweis ohne Fix-Button'
    Assert-True ($null -eq @($g.findings | Where-Object { $_.id -eq 'vbs' })[0].fix) 'VBS nie automatisch'
    $pp = @($g.findings | Where-Object { $_.id -eq 'power-plan' })[0]
    Assert-True ($pp.fix.type -eq 'tweaks' -and @($pp.fix.ids) -contains 'power.ultimate-plan') 'Energieplan-Fix'
    $g2 = Invoke-VxAdvisor 'gaming' '' $desk
    Assert-Equal (ConvertTo-VxJson $g) (ConvertTo-VxJson $g2) 'deterministisch'
    # laptop
    $ctx.State.profile = $lap
    $l = Invoke-VxAdvisor 'gaming' '' $lap
    $lids = @($l.plan | ForEach-Object { $_.id })
    Assert-True ($lids -notcontains 'power.ultimate-plan' -and $lids -notcontains 'latency.timer-bcd') 'Laptop ohne laptop-bad'
    Assert-True (@($l.findings | Where-Object { $_.id -eq 'power-plan' }).Count -eq 0) 'Ausbalanciert auf Laptop ok'
    $lb = Invoke-VxAdvisor 'laptop' '' $lap
    Assert-True (@($lb.plan | ForEach-Object { $_.id }) -contains 'power.battery-saver-early') 'Akku-Tweak im Laptop-Ziel'
    # HDD + 8 GB + AMD
    $ctx.State.profile = $hdd
    $h = Invoke-VxAdvisor 'gaming' '' $hdd
    $hids = @($h.plan | ForEach-Object { $_.id })
    Assert-True ($hids -notcontains 'services.sysmain-off') 'HDD behält SysMain'
    Assert-True ($hids -notcontains 'memory.compression-off') '8 GB RAM: Speicherkomprimierung bleibt'
    Assert-True ($hids -notcontains 'gaming.nvidia-telemetry-off') 'kein NVIDIA-Tweak bei AMD'
    Assert-True ($hids -contains 'gaming.amd-ulps-off') 'AMD-Tweak bei AMD-Karte'
    Assert-True (@($h.findings | Where-Object { $_.id -eq 'disk-space' }).Count -eq 1) 'wenig Speicherplatz erkannt'
    # free text
    $ctx.State.profile = $desk
    $b1 = @((Invoke-VxAdvisor 'balanced' '' $desk).plan | ForEach-Object { $_.id })
    $b2 = @((Invoke-VxAdvisor 'balanced' 'Mein Spiel ruckelt und der Ping ist hoch' $desk).plan | ForEach-Object { $_.id })
    Assert-True ($b1 -notcontains 'network.nagle-off' -and $b2 -contains 'network.nagle-off') 'Freitext "Ping" holt Netzwerk-Tweaks dazu'
    $s = Invoke-VxAdvisor 'streaming' '' $desk
    Assert-True (@($s.plan | ForEach-Object { $_.id }) -notcontains 'gaming.gamedvr-off') 'Streaming behält Aufnahme-Funktionen'
    $fv = Invoke-VxAdvisor 'fivem' '' $desk
    $fi = @($fv.plan | Where-Object { $_.id -eq 'games.fivem-priority' })[0]
    Assert-True ($null -ne $fi -and $fi.reason -match 'FiveM') 'FiveM-Tweak mit Begründung'
    # applying the plan raises the score
    $ctx.State.profile = $desk
    $before = Invoke-VxAdvisor 'gaming' '' $desk
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @($before.plan | ForEach-Object { $_.id }) }) 'apply'
    $ctx.State.profile = Get-VxProfile
    $afterRun = Invoke-VxAdvisor 'gaming' '' $ctx.State.profile
    Assert-True ($afterRun.score -gt $before.score) ("Score steigt nach dem Anwenden ({0} -> {1})" -f $before.score, $afterRun.score)
}

# ==================================================================== claude
function Start-MockAnthropic {
    $state = [hashtable]::Synchronized(@{ queue = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); requests = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); stop = $false; port = 0; ready = $false; error = $null; host = '127.0.0.1' })
    $port = Get-VxFreePort
    $state.port = $port
    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    $code = {
        param($state)
        # 127.0.0.1 needs admin rights with http.sys on Windows; localhost does not
        $l = $null
        foreach ($h in @('127.0.0.1', 'localhost')) {
            $l = New-Object System.Net.HttpListener
            $l.Prefixes.Add('http://' + $h + ':' + $state.port + '/')
            try { $l.Start(); $state.host = $h; break } catch { $state.error = $_.Exception.Message; $l.Close(); $l = $null }
        }
        if ($null -eq $l) { return }
        $state.ready = $true
        $pending = $null
        while (-not $state.stop) {
            if ($null -eq $pending) { $pending = $l.GetContextAsync() }
            if (-not $pending.Wait(100)) { continue }
            $c = $pending.Result
            $pending = $null
            $sr = New-Object System.IO.StreamReader($c.Request.InputStream, [Text.Encoding]::UTF8)
            $body = $sr.ReadToEnd()
            $hdr = @{}
            foreach ($k in $c.Request.Headers.AllKeys) { $hdr[$k.ToLowerInvariant()] = $c.Request.Headers[$k] }
            [void]$state.requests.Add(@{ path = $c.Request.RawUrl; headers = $hdr; body = $body })
            $resp = @{ status = 500; body = '{"type":"error","error":{"type":"api_error","message":"no mock response queued"}}' }
            if ($state.queue.Count -gt 0) { $resp = $state.queue[0]; $state.queue.RemoveAt(0) }
            $bytes = [Text.Encoding]::UTF8.GetBytes([string]$resp.body)
            $c.Response.StatusCode = [int]$resp.status
            $c.Response.ContentType = 'application/json'
            $c.Response.ContentLength64 = $bytes.Length
            $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $c.Response.Close()
        }
        $l.Stop()
        $l.Close()
    }
    $null = $ps.AddScript($code.ToString()).AddArgument($state)
    $h = $ps.BeginInvoke()
    for ($i = 0; $i -lt 50 -and -not $state.ready; $i++) { Start-Sleep -Milliseconds 100 }
    if (-not $state.ready) { throw ('Mock-Server startet nicht: ' + $state.error) }
    return @{ state = $state; ps = $ps; rs = $rs; handle = $h; url = ('http://' + $state.host + ':' + $port) }
}

function Stop-MockAnthropic($Mock) {
    $Mock.state.stop = $true
    for ($i = 0; $i -lt 30 -and -not $Mock.handle.IsCompleted; $i++) { Start-Sleep -Milliseconds 100 }
    try { $Mock.ps.Dispose(); $Mock.rs.Close(); $Mock.rs.Dispose() } catch { $null = $_ }
}

function New-MockMessage([string]$Text, [string]$StopReason = 'end_turn') {
    $msg = [ordered]@{
        id = 'msg_test'; type = 'message'; role = 'assistant'; model = 'claude-opus-5-5'
        content = @([ordered]@{ type = 'thinking'; thinking = ''; signature = 'sig' }, [ordered]@{ type = 'text'; text = $Text })
        stop_reason = $StopReason; stop_details = $null
        usage = [ordered]@{ input_tokens = 1200; output_tokens = 800; cache_read_input_tokens = 900; cache_creation_input_tokens = 0 }
    }
    if ($StopReason -eq 'refusal') { $msg.content = @(); $msg.stop_details = [ordered]@{ type = 'refusal'; category = 'cyber'; explanation = 'x' } }
    return (ConvertTo-Json -InputObject $msg -Depth 10 -Compress)
}

$claudeFix = Join-Path (Join-Path $TestRoot 'fixtures') 'claude'

Test-Case 'claude' 'Key-Speicher: verschlüsselt/kodiert, nie im Klartext, ungültige Keys abgelehnt' {
    $null = New-TestContext
    $key = 'sk-ant-api03-TESTKEY0123456789abcdefABCDEF'
    $failed = $false
    try { Set-VxClaudeKey 'not-a-key' } catch { $failed = $true }
    Assert-True $failed 'ungültiger Key abgelehnt'
    Set-VxClaudeKey $key
    Assert-True (Test-VxClaudeKey) 'hasKey'
    $raw = [IO.File]::ReadAllText((Get-VxClaudeKeyPath))
    Assert-True (-not $raw.Contains($key)) 'Key nicht im Klartext gespeichert'
    Assert-Equal $key (Get-VxClaudeKey) 'Key lesbar'
    Assert-True (-not (ConvertTo-VxJson (Get-VxSettingsDto)).Contains('TESTKEY')) 'Settings-DTO enthält den Key nicht'
    Remove-VxClaudeKey
    Assert-True (-not (Test-VxClaudeKey)) 'gelöscht'
}

Test-Case 'claude' 'Mock-API: Anfrageform, Plan-Filter, Refusal, 401, 429, 400-fallbacks, 529-Retry, kaputtes JSON' {
    $ctx = New-TestContext
    $mock = Start-MockAnthropic
    $oldBase = [Environment]::GetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL')
    [Environment]::SetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL', $mock.url)
    try {
        $key = 'sk-ant-api03-MOCKKEY0123456789abcdefABCDEF'
        Set-VxClaudeKey $key
        $okText = [IO.File]::ReadAllText((Join-Path $claudeFix 'plan-ok.json'), [Text.Encoding]::UTF8)
        $q = $mock.state.queue
        # 1) success with unknown / risky / action / not-applicable ids
        [void]$q.Add(@{ status = 200; body = (New-MockMessage $okText) })
        $r = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming'; text = 'Ruckler in GTA'; allowRisky = $false })
        $ids = @($r.plan | ForEach-Object { $_.id })
        Assert-Equal @('gaming.gamedvr-off', 'gaming.mmcss-games') $ids 'nur gültige, sichere, anwendbare Toggles'
        Assert-True ($r.engine -eq 'claude' -and $r.model -eq 'claude-opus-5-5' -and $r.usage.cache_read_input_tokens -eq 900) 'engine/model/usage'
        Assert-True ($r.summary -and @($r.findings).Count -eq 2 -and $r.findings[0].id -eq 'claude-1' -and $null -eq $r.findings[0].fix) 'Befunde übernommen'
        Assert-True ($r.score -ge 0 -and $r.scoreAfter -ge $r.score) 'Score vom lokalen Advisor'
        $req = $mock.state.requests[0]
        Assert-Equal '/v1/messages' $req.path 'Pfad'
        Assert-Equal $key $req.headers['x-api-key'] 'x-api-key'
        Assert-Equal '2023-06-01' $req.headers['anthropic-version'] 'anthropic-version'
        Assert-Equal 'server-side-fallback-2026-07-01' $req.headers['anthropic-beta'] 'Beta-Header'
        $b = $req.body | ConvertFrom-Json
        Assert-Equal 'claude-opus-5-5' $b.model 'Modell'
        Assert-Equal 16000 ([int]$b.max_tokens) 'max_tokens'
        Assert-Equal 'default' $b.fallbacks 'fallbacks'
        Assert-Equal 'high' $b.output_config.effort 'effort'
        Assert-Equal 'json_schema' $b.output_config.format.type 'format'
        $sch = $b.output_config.format.schema
        Assert-True ($sch.additionalProperties -eq $false -and $sch.properties.findings.items.additionalProperties -eq $false -and $sch.properties.plan.items.additionalProperties -eq $false) 'additionalProperties false überall'
        Assert-True (@($b.system).Count -eq 2 -and $b.system[1].cache_control.type -eq 'ephemeral' -and $null -eq $b.system[0].PSObject.Properties['cache_control']) 'cache_control auf dem Katalog-Block'
        Assert-True ($b.system[1].text -match 'gaming\.gamedvr-off \| ') 'Katalog-Digest'
        Assert-True ($b.system[0].text -match 'ONLY' -and $b.system[0].text -match 'risky') 'Regeln im System-Prompt'
        $content = [string]$b.messages[0].content
        Assert-True ($content -match '"goal":"gaming"' -and $content -match 'Ruckler in GTA' -and $content -match '"allowRisky":false') 'Ziel/Text im User-Content'
        foreach ($secret in @([Environment]::UserName, [Environment]::MachineName)) {
            if ($secret -and $secret.Length -ge 3) { Assert-True (-not $content.Contains($secret)) "kein Benutzer-/Computername ($secret)" }
        }
        Assert-True (-not $content.Contains('"name":"Ethernet"')) 'Adapternamen entfernt'
        # 2) allowRisky keeps risky ids
        [void]$q.Add(@{ status = 200; body = (New-MockMessage $okText) })
        $r = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming'; text = ''; allowRisky = $true })
        Assert-True (@($r.plan | ForEach-Object { $_.id }) -contains 'security.vbs-off') 'riskant nur mit allowRisky'
        # 3) refusal
        [void]$q.Add(@{ status = 200; body = (New-MockMessage '' 'refusal') })
        $msg = ''; try { $null = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' }) } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match 'abgelehnt') "Refusal-Meldung ($msg)"
        # 4) max_tokens
        [void]$q.Add(@{ status = 200; body = (New-MockMessage '{"summary":' 'max_tokens') })
        $msg = ''; try { $null = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' }) } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match 'abgeschnitten') "max_tokens-Meldung ($msg)"
        # 5) 401
        [void]$q.Add(@{ status = 401; body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' })
        $msg = ''; try { $null = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' }) } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match 'API-Key ungültig') "401-Meldung ($msg)"
        # 6) 429
        [void]$q.Add(@{ status = 429; body = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}' })
        $msg = ''; try { $null = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' }) } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match 'Zu viele Anfragen') "429-Meldung ($msg)"
        # 7) 400 mentioning fallbacks -> retry without fallbacks + beta header
        $n0 = $mock.state.requests.Count
        [void]$q.Add(@{ status = 400; body = '{"type":"error","error":{"type":"invalid_request_error","message":"fallbacks: Extra inputs are not permitted"}}' })
        [void]$q.Add(@{ status = 200; body = (New-MockMessage $okText) })
        $r = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' })
        Assert-True (@($r.plan).Count -eq 2) 'zweiter Versuch erfolgreich'
        $retry = $mock.state.requests[$n0 + 1]
        Assert-True (-not $retry.headers.ContainsKey('anthropic-beta')) 'ohne Beta-Header'
        Assert-True ($null -eq ($retry.body | ConvertFrom-Json).PSObject.Properties['fallbacks']) 'ohne fallbacks'
        # 8) 529 -> one retry after 3 s
        $n0 = $mock.state.requests.Count
        [void]$q.Add(@{ status = 529; body = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })
        [void]$q.Add(@{ status = 200; body = (New-MockMessage $okText) })
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' })
        Assert-True ($sw.Elapsed.TotalSeconds -ge 2.5 -and @($r.plan).Count -eq 2) 'Retry nach 3 s'
        Assert-Equal ($n0 + 2) $mock.state.requests.Count 'genau ein Retry'
        # 9) two 5xx in a row -> German error
        [void]$q.Add(@{ status = 500; body = '{}' })
        [void]$q.Add(@{ status = 503; body = '{}' })
        $msg = ''; try { $null = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' }) } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match 'überlastet|nicht erreichbar') "5xx-Meldung ($msg)"
        # 10) invalid JSON in the text block
        [void]$q.Add(@{ status = 200; body = (New-MockMessage 'Das ist kein JSON') })
        $msg = ''; try { $null = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' }) } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match 'keine gültige Antwort') "JSON-Fehler ($msg)"
        # no key -> clear message, no request
        Remove-VxClaudeKey
        $n0 = $mock.state.requests.Count
        $msg = ''; try { $null = Invoke-VxClaudeJob ([pscustomobject]@{ goal = 'gaming' }) } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match 'API-Key' -and $mock.state.requests.Count -eq $n0) 'ohne Key keine Anfrage'
    } finally {
        [Environment]::SetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL', $oldBase)
        Stop-MockAnthropic $mock
    }
}

# ==================================================================== server end-to-end
function Invoke-Http([string]$Method, [string]$Url, $Body = $null, [hashtable]$Headers = @{}) {
    try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch { $null = $_ }
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    try {
        $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method)), $Url)
        foreach ($k in $Headers.Keys) {
            if ($k -eq 'Host') { $req.Headers.Host = $Headers[$k] } else { [void]$req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) }
        }
        if ($null -ne $Body) {
            $json = $Body
            if (-not ($Body -is [string])) { $json = ConvertTo-Json -InputObject $Body -Depth 10 -Compress }
            $req.Content = New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, 'application/json')
        } elseif ($Method -eq 'POST') {
            $req.Content = New-Object System.Net.Http.StringContent('', [Text.Encoding]::UTF8, 'application/json')
        }
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $obj = $null
        try { $obj = $text | ConvertFrom-Json } catch { $obj = $null }
        $ctype = ''
        if ($resp.Content.Headers.ContentType) { $ctype = $resp.Content.Headers.ContentType.ToString() }
        $cors = $resp.Headers.Contains('Access-Control-Allow-Origin')
        $cache = ''
        if ($resp.Headers.CacheControl) { $cache = $resp.Headers.CacheControl.ToString() }
        return @{ status = [int]$resp.StatusCode; text = $text; json = $obj; contentType = $ctype; cors = $cors; cache = $cache }
    } finally { $client.Dispose() }
}

function Wait-Job([string]$Base, [hashtable]$H, [string]$JobId, [int]$TimeoutSec = 60) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $r = Invoke-Http 'GET' ($Base + 'api/jobs/' + $JobId) $null $H
        if ($r.json.status -ne 'running') { return $r.json }
        Start-Sleep -Milliseconds 150
    }
    throw "Job $JobId hängt"
}

function Start-JobAndWait([string]$Base, [hashtable]$H, [string]$Type, $Params) {
    $r = Invoke-Http 'POST' ($Base + 'api/jobs') @{ type = $Type; params = $Params } $H
    if ($r.status -eq 409) {
        $null = Wait-Job $Base $H $r.json.jobId
        $r = Invoke-Http 'POST' ($Base + 'api/jobs') @{ type = $Type; params = $Params } $H
    }
    if ($r.status -ne 200) { throw ("Job {0} nicht gestartet: {1} {2}" -f $Type, $r.status, $r.text) }
    $j = Wait-Job $Base $H $r.json.jobId
    if ($j.status -ne 'done') { throw ("Job {0}: {1} {2}" -f $Type, $j.status, $j.error) }
    return $j
}

Test-Case 'server' 'Velox.ps1 -Simulate -NoBrowser: Sicherheit, API, Jobs, Backups, statische Dateien, Shutdown' {
    $dataRoot = New-TempDir 'server'
    $token = New-VxRandomHex 16
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $HostExe
    $psi.Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Simulate -NoBrowser -Port 0 -Token {1} -DataRoot "{2}"' -f (Join-Path $AppRoot 'Velox.ps1'), $token, $dataRoot)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['VELOX_DATA_DIR'] = $FixtureData
    $proc = [System.Diagnostics.Process]::Start($psi)
    $errTask = $proc.StandardError.ReadToEndAsync()
    try {
        $url = $null
        $lines = New-Object System.Collections.ArrayList
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while (-not $url -and $sw.Elapsed.TotalSeconds -lt 60) {
            $lineTask = $proc.StandardOutput.ReadLineAsync()
            if (-not $lineTask.Wait(60000)) { break }
            $line = $lineTask.Result
            if ($null -eq $line) { break }
            [void]$lines.Add($line)
            if ($line -match '^VELOX_READY (\S+)$') { $url = $Matches[1] }
        }
        if ($null -eq $url) {
            if (-not $proc.HasExited) { try { $proc.Kill() } catch { $null = $_ } }
            throw ('keine VELOX_READY-Zeile: ' + ($lines -join ' / ') + ' ' + $errTask.Result)
        }
        Assert-True ($url -match '^http://(127\.0\.0\.1|localhost):(\d+)/\?t=' + $token + '$') "URL-Format ($url)"
        $port = [int]$Matches[2]
        $hostName = $Matches[1]
        $base = ('http://{0}:{1}/' -f $hostName, $port)
        $H = @{ 'X-Velox-Token' = $token }
        # ---- security
        $r = Invoke-Http 'GET' ($base + 'api/bootstrap')
        Assert-Equal 401 $r.status 'ohne Token'
        $r = Invoke-Http 'GET' ($base + 'api/bootstrap') $null @{ 'X-Velox-Token' = 'falsch' }
        Assert-Equal 401 $r.status 'falsches Token'
        $r = Invoke-Http 'GET' ($base + 'api/bootstrap') $null @{ 'X-Velox-Token' = $token; Host = ('evil.example:' + $port) }
        Assert-True (@(400, 403, 404) -contains $r.status) ("fremder Host abgewiesen ({0})" -f $r.status)
        $r = Invoke-Http 'GET' ($base + 'api/bootstrap') $null @{ 'X-Velox-Token' = $token; Origin = 'http://evil.example' }
        Assert-Equal 403 $r.status 'fremder Origin'
        $r = Invoke-Http 'GET' ($base + 'api/bootstrap') $null @{ 'X-Velox-Token' = $token; Origin = ('http://localhost:' + ($port + 1)) }
        Assert-Equal 403 $r.status 'Origin mit falschem Port'
        $r = Invoke-Http 'OPTIONS' ($base + 'api/jobs') $null @{ Origin = 'http://evil.example'; 'Access-Control-Request-Method' = 'POST' }
        Assert-Equal 403 $r.status 'OPTIONS'
        Assert-True (-not $r.cors) 'keine CORS-Header'
        # ---- bootstrap
        $r = Invoke-Http 'GET' ($base + 'api/bootstrap') $null $H
        Assert-Equal 200 $r.status 'bootstrap'
        Assert-True ($r.contentType -match 'application/json' -and $r.contentType -match 'utf-8') 'Content-Type'
        Assert-True ($r.cache -match 'no-store') 'Cache-Control no-store'
        $bs = $r.json
        foreach ($k in @('app', 'mode', 'categories', 'tweaks', 'presets', 'settings', 'state', 'busy')) { Assert-True ($null -ne $bs.PSObject.Properties[$k]) "bootstrap.$k" }
        Assert-True ($bs.app.name -eq 'VELOX' -and $bs.mode.simulate -eq $true -and $bs.mode.os) 'app/mode'
        $tw = @($bs.tweaks | Where-Object { $_.id -eq 'gaming.gamedvr-off' })[0]
        Assert-True ($tw.category -eq 'gaming' -and $tw.applicable -eq $true -and $null -ne $tw.PSObject.Properties['naReason']) 'tweak-Felder'
        $w10 = @($bs.tweaks | Where-Object { $_.id -eq 'system.win10-only' })[0]
        Assert-True ($w10.applicable -eq $false -and $w10.naReason) 'nicht anwendbar mit Grund'
        Assert-True ($bs.settings.claude.hasKey -eq $false -and $bs.settings.claude.model -eq 'claude-opus-5-5' -and $bs.settings.accent -eq 'violet') 'settings'
        Assert-True ($null -ne $bs.state.needs -and $null -ne $bs.state.PSObject.Properties['statuses']) 'state'
        Assert-True (@($bs.presets).Count -eq 3 -and @($bs.categories).Count -ge 10) 'presets/categories'
        # ---- jobs
        $r = Invoke-Http 'POST' ($base + 'api/jobs') @{ type = 'bogus'; params = @{} } $H
        Assert-Equal 400 $r.status 'unbekannter Job-Typ'
        $r = Invoke-Http 'GET' ($base + 'api/jobs/0123456789abcdef') $null $H
        Assert-Equal 404 $r.status 'unbekannte Job-ID'
        $r1 = Invoke-Http 'POST' ($base + 'api/jobs') @{ type = 'scan'; params = @{} } $H
        Assert-Equal 200 $r1.status 'scan gestartet'
        $r2 = Invoke-Http 'POST' ($base + 'api/jobs') @{ type = 'advisor'; params = @{ goal = 'gaming' } } $H
        Assert-True ($r2.status -eq 409 -and $r2.json.error -eq 'busy' -and $r2.json.jobId -eq $r1.json.jobId) ('zweiter Job -> 409 busy (' + $r2.status + ')')
        $hb = Invoke-Http 'POST' ($base + 'api/heartbeat') $null $H
        Assert-True ($hb.json.ok -eq $true -and $hb.json.busy -eq $true) 'heartbeat meldet busy'
        $scan = Wait-Job $base $H $r1.json.jobId
        Assert-Equal 'done' $scan.status ('scan fertig: ' + $scan.error)
        Assert-True ($scan.result.profile.cpu.name -and $scan.result.statuses.'gaming.gamedvr-off' -eq 'default') 'scan-Ergebnis'
        Assert-True ($scan.progress -eq 1 -and @($scan.log).Count -ge 1 -and $scan.log[0].i -eq 0 -and $scan.log[0].level) 'Fortschritt + Log'
        $st = Invoke-Http 'GET' ($base + 'api/state') $null $H
        Assert-True ($st.json.lastScan -and $st.json.profile.formFactor -eq 'desktop' -and $st.json.statuses.'services.sysmain-off' -eq 'applied') 'state nach scan'
        $ap = Start-JobAndWait $base $H 'apply' @{ ids = @('gaming.gamedvr-off', 'gaming.hags-on'); label = 'E2E' }
        Assert-True (@($ap.result.results | Where-Object { $_.ok -and $_.status -eq 'applied' }).Count -eq 2) 'apply-Ergebnisse'
        Assert-True ($ap.result.backupId -and $ap.result.needs.reboot -eq $true) 'backupId + needs'
        Assert-True (@($ap.log).Count -ge 2) 'Log-Einträge'
        $since = Invoke-Http 'GET' ($base + 'api/jobs/' + $ap.id + '?since=1') $null $H
        Assert-True (@($since.json.log).Count -eq (@($ap.log).Count - 1) -and $since.json.log[0].i -eq 1) '?since filtert'
        $st = Invoke-Http 'GET' ($base + 'api/state') $null $H
        Assert-True ($st.json.statuses.'gaming.gamedvr-off' -eq 'applied' -and $st.json.needs.reboot -eq $true) 'state nach apply'
        $rv = Start-JobAndWait $base $H 'revert' @{ ids = @('gaming.gamedvr-off') }
        Assert-Equal 'default' $rv.result.results[0].status 'revert'
        # ---- backups
        $bl = Invoke-Http 'GET' ($base + 'api/backups') $null $H
        $b = @($bl.json.backups | Where-Object { $_.id -eq $ap.result.backupId })[0]
        Assert-True ($null -ne $b -and $b.kind -eq 'apply' -and $b.label -eq 'E2E' -and $b.count -ge 2 -and $b.simulate -eq $true -and $b.restorable -eq $true) 'Backup-Liste'
        $bd = Invoke-Http 'GET' ($base + 'api/backups/' + $b.id) $null $H
        Assert-True ($bd.status -eq 200 -and @($bd.json.entries).Count -eq $b.count -and $bd.json.entries[0].before) 'Journal abrufbar'
        $bt = Invoke-Http 'GET' ($base + 'api/backups/..%2F..%2Fsettings') $null $H
        Assert-True (@(400, 404) -contains $bt.status) 'Backup-Traversal abgewiesen'
        $rs = Start-JobAndWait $base $H 'restore' @{ backupId = $b.id }
        Assert-True ($rs.result.restored -ge 1 -and $rs.result.failed -eq 0) 'restore'
        $st = Invoke-Http 'GET' ($base + 'api/state') $null $H
        Assert-Equal 'default' $st.json.statuses.'gaming.hags-on' 'Status nach restore'
        # ---- detweak + advisor + more job types
        $dt = Start-JobAndWait $base $H 'detweak-scan' @{}
        Assert-True (@($dt.result.items | Where-Object { $_.key -match 'Win32PrioritySeparation' }).Count -eq 1 -and @($dt.result.commands).Count -ge 1) 'detweak-scan'
        $ad = Start-JobAndWait $base $H 'advisor' @{ goal = 'competitive'; text = 'Maus fühlt sich verzögert an' }
        Assert-True ($ad.result.engine -eq 'local' -and @($ad.result.plan).Count -gt 0 -and @($ad.result.findings).Count -gt 0 -and $ad.result.summary) 'advisor'
        $cs = Start-JobAndWait $base $H 'clean-scan' @{}
        Assert-True (@($cs.result.items).Count -eq 2) 'clean-scan'
        $sl = Start-JobAndWait $base $H 'startup-list' @{}
        Assert-True (@($sl.result.items).Count -ge 6) 'startup-list'
        $gd = Start-JobAndWait $base $H 'games-detect' @{}
        Assert-True (@($gd.result.games).Count -ge 3) 'games-detect'
        $rp = Start-JobAndWait $base $H 'restorepoint' @{ label = 'Test' }
        Assert-True ($rp.result.ok -eq $true -and $rp.result.message) 'restorepoint (simuliert)'
        $pf = Start-JobAndWait $base $H 'pick-file' @{}
        Assert-True ($null -eq $pf.result.path) 'pick-file null'
        $rb = Start-JobAndWait $base $H 'reboot' @{}
        Assert-True ($rb.result.ok -eq $true) 'reboot nur protokolliert'
        $cl = Invoke-Http 'POST' ($base + 'api/jobs') @{ type = 'claude'; params = @{ goal = 'gaming' } } $H
        $cj = Wait-Job $base $H $cl.json.jobId
        Assert-True ($cj.status -eq 'error' -and $cj.error -match 'API-Key') 'claude ohne Key -> verständlicher Fehler'
        $cc = Invoke-Http 'POST' ($base + 'api/jobs/' + $cj.id + '/cancel') $null $H
        Assert-True ($cc.status -eq 200 -and $cc.json.ok -eq $false) 'cancel auf fertigem Job'
        # ---- settings + key + open
        $s = Invoke-Http 'POST' ($base + 'api/settings') @{ accent = 'cyan'; motion = 'reduced'; confirmRisky = $false; bogus = 1; claude = @{ model = 'claude-sonnet-5-5'; hasKey = $true } } $H
        Assert-True ($s.json.settings.accent -eq 'cyan' -and $s.json.settings.motion -eq 'reduced' -and $s.json.settings.confirmRisky -eq $false -and $s.json.settings.claude.model -eq 'claude-sonnet-5-5' -and $s.json.settings.claude.hasKey -eq $false) 'settings gespeichert'
        $s = Invoke-Http 'POST' ($base + 'api/settings') @{ accent = 'rainbow' } $H
        Assert-Equal 'cyan' $s.json.settings.accent 'ungültiger Wert ignoriert'
        $bs2 = (Invoke-Http 'GET' ($base + 'api/bootstrap') $null $H).json
        Assert-Equal 'cyan' $bs2.settings.accent 'settings im bootstrap'
        $k = Invoke-Http 'POST' ($base + 'api/claude/key') @{ key = 'nope' } $H
        Assert-True ($k.status -eq 400 -and $k.json.error) 'ungültiger Key -> 400'
        $k = Invoke-Http 'POST' ($base + 'api/claude/key') @{ key = 'sk-ant-api03-E2EKEY0123456789abcdef' } $H
        Assert-True ($k.json.hasKey -eq $true -and -not $k.text.Contains('E2EKEY')) 'Key gespeichert, nicht zurückgegeben'
        Assert-True (-not (Invoke-Http 'GET' ($base + 'api/bootstrap') $null $H).text.Contains('E2EKEY')) 'Key nie im bootstrap'
        $k = Invoke-Http 'DELETE' ($base + 'api/claude/key') $null $H
        Assert-True ($k.json.hasKey -eq $false) 'Key gelöscht'
        $o = Invoke-Http 'POST' ($base + 'api/open') @{ target = 'ms-settings:display-advanced' } $H
        Assert-True ($o.status -eq 200 -and $o.json.ok) 'open whitelist'
        $o = Invoke-Http 'POST' ($base + 'api/open') @{ target = 'calc.exe' } $H
        Assert-Equal 400 $o.status 'open außerhalb der Whitelist'
        $bad = Invoke-Http 'POST' ($base + 'api/settings') '{kaputt' $H
        Assert-Equal 400 $bad.status 'kaputtes JSON -> 400'
        # ---- static files
        $idx = Invoke-Http 'GET' $base
        if (Test-Path -LiteralPath (Join-Path (Join-Path $AppRoot 'ui') 'index.html')) {
            Assert-True ($idx.status -eq 200 -and $idx.contentType -match 'text/html' -and $idx.cache -match 'no-store') 'index.html'
        } else {
            Assert-Equal 404 $idx.status 'index.html fehlt noch (UI in Arbeit)'
            Add-Note 'ui/index.html existiert noch nicht - statischer Test akzeptiert 404.'
        }
        foreach ($p in @('..%2Fcore%2FCommon.ps1', '%2e%2e/Velox.ps1', '..%5cVelox.ps1', 'css/..%2F..%2FVelox.ps1', '%2e%2e%2f%2e%2e%2fetc%2fpasswd')) {
            $tr = Invoke-Http 'GET' ($base + $p)
            Assert-True ($tr.status -ne 200 -and -not $tr.text.Contains('function ')) ("Traversal abgewiesen: $p ({0})" -f $tr.status)
        }
        $api404 = Invoke-Http 'GET' ($base + 'api/nope') $null $H
        Assert-Equal 404 $api404.status 'unbekannter API-Pfad'
        # ---- second instance (same data root) hands over and exits
        $psi2 = New-Object System.Diagnostics.ProcessStartInfo
        $psi2.FileName = $HostExe
        $psi2.Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Simulate -NoBrowser -DataRoot "{1}"' -f (Join-Path $AppRoot 'Velox.ps1'), $dataRoot)
        $psi2.UseShellExecute = $false
        $psi2.RedirectStandardOutput = $true
        $psi2.EnvironmentVariables['VELOX_DATA_DIR'] = $FixtureData
        $p2 = [System.Diagnostics.Process]::Start($psi2)
        $out2 = $p2.StandardOutput.ReadToEndAsync()
        Assert-True ($p2.WaitForExit(30000)) 'zweite Instanz beendet sich'
        Assert-True ($out2.Result -match 'laeuft bereits' -and $out2.Result -notmatch 'VELOX_READY') 'zweite Instanz übergibt an die erste'
        # ---- shutdown via sendBeacon-style ?t= (no header)
        $sd = Invoke-Http 'POST' ($base + 'api/shutdown?t=' + $token)
        Assert-True ($sd.status -eq 200 -and $sd.json.ok) 'shutdown angenommen'
        Assert-True ($proc.WaitForExit(20000)) 'Prozess beendet sich nach dem Shutdown'
        Assert-Equal 0 $proc.ExitCode 'Exit-Code 0'
        Assert-True (-not [IO.File]::Exists((Join-Path $dataRoot 'instance.json'))) 'instance.json aufgeräumt'
        $ready = @($lines | Where-Object { $_ -match '^VELOX_READY ' })
        Assert-Equal 1 $ready.Count 'genau eine VELOX_READY-Zeile'
    } finally {
        if (-not $proc.HasExited) { try { $proc.Kill() } catch { $null = $_ } }
    }
}

Test-Case 'server' 'Shutdown wird durch einen Heartbeat abgebrochen; Heartbeat-Timeout beendet' {
    $null = New-TestContext
    $global:VxCtx.Life = New-VxLifecycle
    $life = $global:VxCtx.Life
    $life.shutdownAt = [DateTime]::UtcNow.AddSeconds(4)
    Register-VxHeartbeat
    Assert-True ($null -eq $life.shutdownAt) 'Heartbeat bricht Beenden ab'
    $life.shutdownAt = [DateTime]::UtcNow.AddSeconds(-1)
    Test-VxLifecycle
    Assert-True ($life.stop -and $life.reason -eq 'shutdown') 'Beenden nach Ablauf'
    $global:VxCtx.Life = New-VxLifecycle
    $life = $global:VxCtx.Life
    Test-VxLifecycle
    Assert-True (-not $life.stop) 'ohne ersten Heartbeat kein Timeout'
    Register-VxHeartbeat
    $life.lastHeartbeat = [DateTime]::UtcNow.AddSeconds(-151)
    Test-VxLifecycle
    Assert-True ($life.stop -and $life.reason -eq 'timeout') 'Timeout nach 150 s'
}

# ------------------------------------------------------------------ summary
foreach ($d in $script:TempDirs) { try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop } catch { $null = $_ } }
$total = $script:Results.Count
$failed = @($script:Results | Where-Object { -not $_.ok })
Write-Host ''
Write-Host '==================================================================='
foreach ($g in @($script:Results | Group-Object group)) {
    $f = @($g.Group | Where-Object { -not $_.ok }).Count
    Write-Host ("  {0,-12} {1,3} Tests, {2} fehlgeschlagen" -f $g.Name, $g.Count, $f)
}
foreach ($n in $script:Notes) { Write-Host ('  Hinweis: ' + $n) -ForegroundColor Yellow }
Write-Host ("SUMMARY: {0} passed, {1} failed, {2} total in {3:N1} s" -f ($total - $failed.Count), $failed.Count, $total, $script:Started.Elapsed.TotalSeconds)
if ($failed.Count -gt 0) {
    foreach ($f in $failed) { Write-Host ("  FAIL [{0}] {1}: {2}" -f $f.group, $f.name, $f.msg) -ForegroundColor Red }
    exit 1
}
exit 0
