<#
.SYNOPSIS
  VELOX backend tests. Plain PowerShell (no Pester), valid for Windows PowerShell 5.1 and pwsh 7.
  Everything runs in simulate mode - nothing on the machine is changed.

.EXAMPLE
  pwsh tests/Run-Tests.ps1
  pwsh tests/Run-Tests.ps1 -Strict          # also fail when the real data/ catalog has errors
  pwsh tests/Run-Tests.ps1 -Only engine     # run one group (compat, catalog, engine, realcatalog, detweak, advisor, claude, ai, server, review, restorepoint, speed, games, settings, clean)
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

foreach ($n in @('Common', 'System', 'Catalog', 'Engine', 'Detweak', 'Scan', 'Advisor', 'Claude', 'Extras', 'Clean', 'Jobs', 'Server')) {
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

# Every C# source the backend hands to Add-Type (type definitions and -MemberDefinition snippets,
# also those inside isolated-script text): @{ name; code; refs }. refs = the assemblies Windows
# PowerShell 5.1 references (System.dll by default, System.Drawing when the source uses it).
function Get-CSharpSources {
    $list = New-Object System.Collections.ArrayList
    $files = @(Get-ChildItem -LiteralPath (Join-Path $AppRoot 'core') -Filter '*.ps1') + @(Get-Item -LiteralPath (Join-Path $AppRoot 'Velox.ps1'))
    foreach ($f in $files) {
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
        $strs = $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $a -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }, $true)
        foreach ($s in $strs) {
            $v = [string]$s.Value
            $where = '{0}:{1}' -f $f.Name, $s.Extent.StartLineNumber
            if ($v -match '(?m)^\s*using System' -and $v -match '\b(class|struct)\b') {
                $refs = @('mscorlib', 'System')
                if ($v -match '(?m)^\s*using System\.Drawing') { $refs += 'System.Drawing' }
                [void]$list.Add(@{ name = $where; code = $v; refs = $refs })
            }
            foreach ($m in [regex]::Matches($v, "Add-Type\s+-Namespace\s+(\w+)\s+-Name\s+(\w+)\s+-MemberDefinition\s+'((?:[^']|'')*)'")) {
                # what Add-Type -MemberDefinition generates around the members
                $code = "using System;`nusing System.Runtime.InteropServices;`nnamespace " + $m.Groups[1].Value + " {`npublic class " + $m.Groups[2].Value + " {`n" + $m.Groups[3].Value.Replace("''", "'") + "`n}`n}`n"
                [void]$list.Add(@{ name = $where + ' (MemberDefinition)'; code = $code; refs = @('mscorlib', 'System') })
            }
        }
    }
    return $list.ToArray()
}

# Folder with the .NET Framework 4.8 reference assemblies (NuGet cache or the Windows SDK), or $null.
function Get-Net48RefDir {
    $cands = New-Object System.Collections.Generic.List[string]
    $pk = [Environment]::GetEnvironmentVariable('NUGET_PACKAGES')
    if (-not $pk) { $pk = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile), '.nuget', 'packages') }
    $base = [IO.Path]::Combine($pk, 'microsoft.netframework.referenceassemblies.net48')
    if ([IO.Directory]::Exists($base)) {
        foreach ($v in @([IO.Directory]::GetDirectories($base) | Sort-Object -Descending)) { $cands.Add([IO.Path]::Combine($v, 'build', '.NETFramework', 'v4.8')) }
    }
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($pf86) { $cands.Add([IO.Path]::Combine($pf86, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', 'v4.8')) }
    foreach ($c in $cands) { if ([IO.File]::Exists([IO.Path]::Combine($c, 'mscorlib.dll'))) { return $c } }
    return $null
}

Test-Case 'compat' 'C#-Quellen für Add-Type kompilieren wie unter Windows PowerShell 5.1 (C# 5, .NET Framework 4.8, Warnungen = Fehler)' {
    $srcs = @(Get-CSharpSources)
    Assert-True ($srcs.Count -ge 6) ('alle C#-Quellen gefunden: ' + $srcs.Count)
    $dotnet = @(Get-Command 'dotnet' -CommandType Application -ErrorAction SilentlyContinue)[0]
    if ($null -eq $dotnet) { Add-Note 'dotnet fehlt - C#-Kompilierprüfung übersprungen.'; return }
    $csc = $null
    try {
        foreach ($line in @(& $dotnet.Source --list-sdks 2>$null)) {
            $m = [regex]::Match([string]$line, '^(\S+)\s+\[(.+)\]\s*$')
            if (-not $m.Success) { continue }
            $c = [IO.Path]::Combine($m.Groups[2].Value, $m.Groups[1].Value, 'Roslyn', 'bincore', 'csc.dll')
            if ([IO.File]::Exists($c)) { $csc = $c }
        }
    } catch { $csc = $null }
    $refDir = Get-Net48RefDir
    if (-not $csc -or -not $refDir) { Add-Note 'C#-Compiler oder .NET-4.8-Referenzassemblys fehlen - C#-Kompilierprüfung übersprungen.'; return }
    $dir = New-TempDir 'csharp'
    $fails = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($s in $srcs) {
        $i++
        $file = Join-Path $dir ('src' + $i + '.cs')
        [IO.File]::WriteAllText($file, $s.code)
        # Windows PowerShell 5.1: CodeDom csc (C# 5), warning level 4, warnings fail Add-Type
        $cargs = @($csc, '-nologo', '-noconfig', '-nostdlib+', '-langversion:5', '-warn:4', '-warnaserror+', '-target:library', ('-out:' + (Join-Path $dir ('src' + $i + '.dll'))))
        foreach ($r in $s.refs) { $cargs += ('-r:' + [IO.Path]::Combine($refDir, $r + '.dll')) }
        $cargs += $file
        $out = @(& $dotnet.Source @cargs 2>&1 | ForEach-Object { [string]$_ })
        if ($LASTEXITCODE -ne 0) { [void]$fails.Add(($s.name + ': ' + (($out | Where-Object { $_ -match 'error' } | Select-Object -First 3) -join ' | ').Replace($file, 'src'))) }
    }
    Assert-True ($fails.Count -eq 0) ('C# 5 kompiliert: ' + ($fails -join ' || '))
}

Test-Case 'compat' 'keine -EncodedCommand-Aufrufe (Virenscanner schlagen bei Base64-Befehlen aus Admin-Prozessen an)' {
    $hits = @()
    foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $AppRoot 'core') -Filter '*.ps1') + @(Get-Item -LiteralPath (Join-Path $AppRoot 'Velox.ps1'))) {
        $n = 0
        foreach ($line in [IO.File]::ReadAllLines($f.FullName)) { $n++; if ($line -match '(?i)-(EncodedCommand|enc|ec)\s' -and $line -notmatch '^\s*#') { $hits += ('{0}:{1}' -f $f.Name, $n) } }
    }
    Assert-True ($hits.Count -eq 0) ('gefunden: ' + ($hits -join ', '))
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

Test-Case 'realcatalog' 'Detweak listet keine Katalog-Tweaks, deren Ziel schon der Windows-Standard ist' {
    $realData = Join-Path $AppRoot 'data'
    if (-not (Test-Path -LiteralPath (Join-Path $realData 'tweaks'))) { Add-Note 'data/tweaks fehlt - übersprungen.'; return }
    $ctx = New-TestContext -DataDir $realData
    if ($ctx.Catalog.errors.Count -gt 0) { Add-Note 'Echter Katalog lädt nicht sauber - übersprungen.'; return }
    $noops = @($ctx.Catalog.tweaks | Where-Object { (Get-VxTweakKind $_) -eq 'toggle' -and (Test-TweakIsNoop $_) } | ForEach-Object { [string]$_.id })
    $scan = Get-VxDetweakScan
    $listed = @($scan.items | Where-Object { $_.source -ne 'detweak' } | ForEach-Object { [string]$_.tweakId })
    $wrong = @($noops | Where-Object { $listed -contains $_ })
    Assert-True ($wrong.Count -eq 0) ('am Windows-Standard, trotzdem als Abweichung gelistet: ' + ($wrong -join ', '))
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
    Assert-True ($scan.commands[0].risk -eq 'safe' -and $scan.commands[1].risk -eq 'moderate') 'Befehle mit risk'
    $own = @($scan.items | Where-Object { $_.key -eq 'tweak|latency.timer-bcd' })[0]
    Assert-Equal 'velox' $own.source 'von VELOX angewendeter Tweak hat source velox'
    Assert-Equal 'catalog' (@($scan.items | Where-Object { $_.key -eq 'tweak|services.sysmain-off' })[0]).source 'fremd gesetzter Katalog-Tweak bleibt catalog'
    Assert-Equal ($keys.Count - 1) ([int]$ctx.State.profile.foreignCount) 'foreignCount im Profil ohne eigene Tweaks'
    Assert-Equal ($keys.Count - 1) ([int](Get-VxStateDto).foreignCount) 'foreignCount oben im State'
    Assert-Equal ($keys.Count - 1) ([int]$scan.foreignCount) 'foreignCount im Scan-Ergebnis'
    $before = Get-SimSnapshot
    $prioBefore = (Get-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl' 'Win32PrioritySeparation').value
    $res = Invoke-VxDetweakJob ([pscustomobject]@{ keys = $keys; commands = @('power-defaults'); thenApply = @('gaming.gamedvr-off'); restorePoint = $true })
    Assert-Equal 0 $res.failed ('keine Fehler: ' + ($res.errors -join '; '))
    Assert-Equal ($keys.Count + 1) $res.reset 'alles zurückgesetzt (+ Befehl)'
    Assert-True ($res.resetValues -eq $keys.Count -and $res.commandsRun -eq 1) ('Werte und Befehle getrennt gezählt: {0}/{1}' -f $res.resetValues, $res.commandsRun)
    Assert-Equal 0 ([int](Get-VxStateDto).foreignCount) 'foreignCount nach Detweak 0 (neu angewendeter Tweak ist eigener)'
    Assert-Equal 0 ([int]$res.foreignCount) 'foreignCount im Detweak-Ergebnis'
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

Test-Case 'detweak' 'Eigene Tweaks (Journal): source velox, echte Werte, foreignCount nach apply/revert synchron' {
    $ctx = New-TestContext -Seed
    $hp = 'HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers'
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('gaming.hags-on') }) 'apply'
    # another tool sets a catalog tweak to exactly VELOX's value - no journal, so it is foreign
    Set-VxRegValue 'HKCU\Software\Microsoft\GameBar' 'AutoGameModeEnabled' 'DWord' 1
    Update-VxStatuses
    Assert-Equal 'applied' (Get-Status 'gaming.gamemode-on') 'fremd auf VELOX-Wert gesetzt'
    $scan = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    $byKey = @{}; foreach ($it in $scan.items) { $byKey[$it.key] = $it }
    $hags = $byKey['tweak|gaming.hags-on']
    Assert-True ($null -ne $hags -and $hags.source -eq 'velox') 'per VELOX angewendet = velox'
    Assert-True ($hags.current -eq '2' -and $hags.default -eq 'nicht gesetzt') ('echte Werte statt Status-Text: {0} -> {1}' -f $hags.current, $hags.default)
    Assert-Equal 'catalog' $byKey['tweak|gaming.gamemode-on'].source 'gleicher Wert ohne Journal = fremd'
    $sys = $byKey['tweak|services.sysmain-off']
    Assert-True ($sys.current -eq 'Deaktiviert' -and $sys.default -eq 'Automatisch') ('Dienst-Werte: {0} -> {1}' -f $sys.current, $sys.default)
    $multi = @($scan.items | Where-Object { $_.source -ne 'detweak' -and @((Get-VxTweak $_.tweakId).actions).Count -gt 1 })
    foreach ($m in $multi) { Assert-True ($m.default -eq 'Windows-Standard') "mehrere Werte -> Status-Text ($($m.key))" }
    $foreign = @($scan.items | Where-Object { $_.source -ne 'velox' }).Count
    Assert-Equal $foreign ([int](Get-VxStateDto).foreignCount) 'foreignCount = alles außer velox'
    # another tool changes VELOX's value afterwards -> foreign again
    Set-VxRegValue $hp 'HwSchMode' 'DWord' 7
    Update-VxStatuses
    $scan2 = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    Assert-Equal 'catalog' (@($scan2.items | Where-Object { $_.key -eq 'tweak|gaming.hags-on' })[0]).source 'nach fremder Änderung wieder fremd'
    $n2 = [int](Get-VxStateDto).foreignCount
    Assert-Equal ($foreign + 1) $n2 'foreignCount +1'
    # apply/revert keep foreignCount in sync: VELOX sets it again -> own; revert -> default
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('gaming.hags-on') }) 'apply'
    Assert-Equal ($n2 - 1) ([int](Get-VxStateDto).foreignCount) 'nach apply nicht mehr fremd'
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('services.sysmain-off') }) 'revert'
    Assert-Equal ($n2 - 2) ([int](Get-VxStateDto).foreignCount) 'nach revert nicht mehr fremd'
    Assert-Equal ($n2 - 2) ([int]$ctx.State.profile.foreignCount) 'Profil ebenso'
    $scan3 = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    Assert-Equal ($n2 - 2) ([int]$scan3.foreignCount) 'neuer Scan bestätigt die Buchführung'
    # Testmodus journals never explain the real PC (and vice versa)
    foreach ($f in @(Get-ChildItem -LiteralPath $ctx.BackupDir -Filter '*.json')) {
        $txt = [IO.File]::ReadAllText($f.FullName) -replace '"simulate":true', '"simulate":false'
        [IO.File]::WriteAllText($f.FullName, $txt)
    }
    $scan4 = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    Assert-Equal 0 @($scan4.items | Where-Object { $_.source -eq 'velox' }).Count 'Journale des anderen Modus zählen nicht'
}

Test-Case 'detweak' 'Sicherungen: tweakCount (verschiedene Tweaks) neben count (Werte)' {
    $ctx = New-TestContext
    $res = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('gaming.gamedvr-off', 'gaming.mmcss-games', 'gaming.hags-on'); label = 'Drei' }) 'apply'
    $b = @(Get-VxBackupList | Where-Object { $_.id -eq $res.backupId })[0]
    Assert-True ($null -ne $b -and $b.tweakCount -eq 3 -and $b.count -eq 6) ('tweakCount 3 / count 6: {0} / {1}' -f $b.tweakCount, $b.count)
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = 'C:\Games\X\x.exe'; priority = $true })
    $g = @(Get-VxBackupList | Where-Object { $_.kind -eq 'game' })[0]
    Assert-True ($null -ne $g -and $g.tweakCount -eq 0 -and $g.count -ge 1) 'Spiele-Boost hat keine Tweak-IDs'
    $ids = @(Get-VxBackupIds -Oldest)
    Assert-Equal $res.backupId $ids[0] 'älteste zuerst'
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

Test-Case 'advisor' 'Smart-Analyse (echter Katalog): Plan-Größe je Ziel, Score-Eichung, 100 nur komplett, Texte deutsch' {
    $realData = Join-Path $AppRoot 'data'
    if (-not (Test-Path -LiteralPath (Join-Path $realData 'tweaks'))) { Add-Note 'echter Katalog fehlt - Advisor-Eichung übersprungen.'; return }
    $ctx = New-TestContext -DataDir $realData
    $desk = $ctx.State.profile
    Update-VxStatuses
    $caps = @{ balanced = 25; gaming = 40; competitive = 55; privacy = 50; laptop = 30; streaming = 40; fivem = 45 }
    foreach ($goal in @($caps.Keys | Sort-Object)) {
        $r = Invoke-VxAdvisor $goal '' $desk
        $n = @($r.plan).Count
        Assert-True ($n -gt 0 -and $n -le $caps[$goal]) ("Plan-Größe {0}: {1} (max {2})" -f $goal, $n, $caps[$goal])
        Assert-True ($r.summary -match '„.+“' -and $r.summary -notmatch "'") ("deutsche Anführungszeichen ($goal): " + $r.summary)
        foreach ($i in $r.plan) {
            $t = Get-VxTweak $i.id
            Assert-True ($i.reason.Length -gt [string]$t.desc.Length) "Begründung erklärt mehr als die Beschreibung ($($i.id))"
            if ([string]$t.category -eq 'network' -and @('gaming', 'competitive', 'fivem') -contains $goal -and (@($t.tags) -contains 'ping' -or @($t.tags) -contains 'network')) {
                Assert-True ($i.reason -match 'Ping|WLAN|Netzwerk') "Netzwerk-Tweak mit Netzwerk-Begründung ($goal, $($i.id)): $($i.reason)"
            }
            if (@($t.tags) -contains 'nvidia') { Assert-True ($i.reason -notmatch 'an Microsoft' -or [string]$t.desc -match 'Microsoft') "NVIDIA-Tweak nicht Microsoft zugeschrieben ($($i.id))" }
        }
        Assert-Equal (ConvertTo-VxJson $r) (ConvertTo-VxJson (Invoke-VxAdvisor $goal '' $desk)) "deterministisch ($goal)"
    }
    # stock Windows: gaming lands in 35..55, the plan promises 85..95
    $g = Invoke-VxAdvisor 'gaming' '' $desk
    Assert-True ($g.score -ge 35 -and $g.score -le 55) ("Serien-Windows Gaming-Score 35-55: {0}" -f $g.score)
    Assert-True ($g.scoreAfter -ge 85 -and $g.scoreAfter -le 95) ("mit Plan 85-95: {0}" -f $g.scoreAfter)
    $clean = ConvertTo-VxHashtable (ConvertFrom-VxJsonText (ConvertTo-VxJson $desk))
    $clean.display.currentHz = $clean.display.maxHz; $clean.ram.configuredMHz = 3600; $clean.security.vbs = $false; $clean.security.hvci = $false
    $clean.uptimeHours = 5; $clean.tempMB = 100
    $cs = Invoke-VxAdvisor 'gaming' '' $clean
    Assert-True ($cs.score -ge 35 -and $cs.score -le 55) ("sauberer Serien-PC 35-55: {0}" -f $cs.score)
    # applying the plan reaches the promised score; hardware/BIOS findings keep it below 100
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @($g.plan | ForEach-Object { $_.id }) }) 'apply'
    $g2 = Invoke-VxAdvisor 'gaming' '' $desk
    Assert-Equal 0 @($g2.plan).Count 'Plan komplett angewendet'
    Assert-True ([math]::Abs($g2.score - $g.scoreAfter) -le 1 -and $g2.score -ge 85 -and $g2.score -le 95) ("Score nach dem Plan {0} = versprochen {1}" -f $g2.score, $g.scoreAfter)
    Assert-True (@($g2.findings | ForEach-Object { $_.id }) -notcontains 'power-plan' -and @($g2.findings | ForEach-Object { $_.id }) -notcontains 'game-dvr') 'gelöste Befunde verschwinden'
    # 100 only with every recommended tweak applied and no open finding
    $c2 = Invoke-VxAdvisor 'gaming' '' $clean
    Assert-True ($c2.score -eq 100 -and @($c2.plan).Count -eq 0) ("alles angewendet, keine Befunde -> 100: {0} / {1}" -f $c2.score, ((@($c2.findings | Where-Object { $_.severity -ne 'good' }) | ForEach-Object { $_.id }) -join ','))
    $clean.uptimeHours = 400
    $c3 = Invoke-VxAdvisor 'gaming' '' $clean
    Assert-True ($c3.score -le 99) ("offener Befund -> nie 100: {0}" -f $c3.score)
    $clean.uptimeHours = 5
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @($g.plan[0].id) }) 'revert'
    $c4 = Invoke-VxAdvisor 'gaming' '' $clean
    Assert-True ($c4.score -le 99 -and @($c4.plan).Count -eq 1) ("ein Tweak offen -> nie 100: {0}" -f $c4.score)
    # free text: German keywords, de-DE numbers
    $k = Invoke-VxAdvisor 'gaming' 'Es ruckelt und der Ping ist hoch' $desk
    Assert-True ($k.summary -match 'Ruckler' -and $k.summary -match 'Ping' -and $k.summary -notmatch 'stutter|network') ('deutsche Stichworte: ' + $k.summary)
    $tf = @($g.findings | Where-Object { $_.id -eq 'temp-files' })[0]
    Assert-True ($tf.title -match '^3,3 GB') ('de-DE Zahl: ' + $tf.title)
}

Test-Case 'advisor' 'Smart-Analyse: Fremd-Tweak-Befund zählt VELOX-eigene Tweaks nicht' {
    $ctx = New-TestContext
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('latency.timer-bcd', 'gaming.hags-on') }) 'apply'
    $null = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    Assert-Equal 0 ([int]$ctx.State.profile.foreignCount) 'nur eigene Tweaks -> 0'
    $r = Invoke-VxAdvisor 'gaming' '' $ctx.State.profile
    Assert-True (@($r.findings | Where-Object { $_.id -eq 'foreign' }).Count -eq 0) 'kein Fremd-Tweak-Befund'
    Set-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl' 'Win32PrioritySeparation' 'DWord' 38
    $null = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    $f = @((Invoke-VxAdvisor 'gaming' '' $ctx.State.profile).findings | Where-Object { $_.id -eq 'foreign' })[0]
    Assert-True ($null -ne $f -and $f.title -match '^1 Einstellung von') ('ein Fremd-Tweak: ' + $f.title)
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
            if ($resp.ContainsKey('headers')) { foreach ($hk in @($resp.headers.Keys)) { $c.Response.AddHeader([string]$hk, [string]$resp.headers[$hk]) } }
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
# fake Claude Code CLI (tests/fixtures/claude-cli): the real CLI must never run a prompt in the tests
$FakeClaudeDir = Join-Path (Join-Path $TestRoot 'fixtures') 'claude-cli'
$FakeClaudeCli = Join-Path $FakeClaudeDir 'claude'
if (Test-VxWindows) { $FakeClaudeCli = Join-Path $FakeClaudeDir 'claude.cmd' }

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
    # KI: the fake Claude Code CLI comes first on PATH - the real one is never run by the tests
    $psi.EnvironmentVariables['PATH'] = $FakeClaudeDir + [IO.Path]::PathSeparator + [Environment]::GetEnvironmentVariable('PATH')
    $psi.EnvironmentVariables['VELOX_CLAUDE_CLI'] = $FakeClaudeCli
    $psi.EnvironmentVariables['VELOX_CLAUDE_CLI_ONLY'] = '1'
    # games: the fixture PC also on Windows (Testmodus only)
    $psi.EnvironmentVariables['VELOX_GAMES_FIXTURE'] = (Join-Path (Join-Path (Join-Path $TestRoot 'fixtures') 'games') 'pc')
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
        Assert-True ($null -ne $bs.mode.PSObject.Properties['desktopUser'] -and $bs.mode.userMismatch -eq $false) 'mode.desktopUser/userMismatch'
        $tw = @($bs.tweaks | Where-Object { $_.id -eq 'gaming.gamedvr-off' })[0]
        Assert-True ($tw.category -eq 'gaming' -and $tw.applicable -eq $true -and $null -ne $tw.PSObject.Properties['naReason']) 'tweak-Felder'
        $w10 = @($bs.tweaks | Where-Object { $_.id -eq 'system.win10-only' })[0]
        Assert-True ($w10.applicable -eq $false -and $w10.naReason) 'nicht anwendbar mit Grund'
        Assert-True ($bs.settings.claude.hasKey -eq $false -and $bs.settings.claude.model -eq 'claude-opus-5-5' -and $bs.settings.accent -eq 'violet') 'settings'
        Assert-True ($null -ne $bs.state.needs -and $null -ne $bs.state.PSObject.Properties['statuses']) 'state'
        Assert-True ($null -ne $bs.state.PSObject.Properties['foreignCount']) 'state.foreignCount vorhanden'
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
        Assert-Equal 'scan' $r2.json.type '409 nennt den Job-Typ'
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
        Assert-Equal 2 ([int]$b.tweakCount) 'Backup-Liste: tweakCount'
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
        $stDt = (Invoke-Http 'GET' ($base + 'api/state') $null $H).json
        Assert-True ($stDt.foreignCount -eq $dt.result.foreignCount -and $stDt.profile.foreignCount -eq $dt.result.foreignCount) 'foreignCount im State und Profil'
        $ad = Start-JobAndWait $base $H 'advisor' @{ goal = 'competitive'; text = 'Maus fühlt sich verzögert an' }
        Assert-True ($ad.result.engine -eq 'local' -and @($ad.result.plan).Count -gt 0 -and @($ad.result.findings).Count -gt 0 -and $ad.result.summary) 'advisor'
        $cs = Start-JobAndWait $base $H 'clean-scan' @{}
        Assert-True (@($cs.result.items).Count -eq 2) 'clean-scan'
        $sl = Start-JobAndWait $base $H 'startup-list' @{}
        Assert-True (@($sl.result.items).Count -ge 6) 'startup-list'
        $gd = Start-JobAndWait $base $H 'games-detect' @{}
        Assert-True (@($gd.result.games).Count -ge 3) 'games-detect'
        # ---- game art: token as ?t= (an <img> sends no headers), only ids of detected games
        $cs2 = @($gd.result.games | Where-Object { $_.exe -eq 'cs2.exe' })[0]
        Assert-True ($null -ne $cs2 -and $cs2.art.cover -and $cs2.art.icon -and $cs2.art.v) 'games-detect meldet Bilder'
        $artBase = $base + 'api/game-art/' + $cs2.id
        $ga = Invoke-Http 'GET' ($artBase + '?kind=cover&v=' + $cs2.art.v + '&t=' + $token)
        Assert-True ($ga.status -eq 200 -and $ga.contentType -eq 'image/jpeg' -and $ga.cache -match 'max-age' -and $ga.text.Length -gt 1000) ('Titelbild (' + $ga.status + ' ' + $ga.contentType + ')')
        Assert-Equal 'image/jpeg' (Invoke-Http 'GET' ($artBase + '?kind=icon&t=' + $token)).contentType 'Icon'
        Assert-Equal 200 (Invoke-Http 'GET' ($artBase + '?kind=cover') $null $H).status 'Token auch als Header'
        Assert-Equal 401 (Invoke-Http 'GET' ($artBase + '?kind=cover')).status 'ohne Token 401'
        Assert-Equal 401 (Invoke-Http 'GET' ($artBase + '?kind=cover&t=falsch')).status 'falsches Token 401'
        Assert-Equal 401 (Invoke-Http 'POST' ($artBase + '?kind=cover&t=' + $token)).status 'POST mit ?t= 401'
        Assert-Equal 400 (Invoke-Http 'GET' ($artBase + '?kind=datei&t=' + $token)).status 'unbekannte Bildart 400'
        Assert-Equal 404 (Invoke-Http 'GET' ($base + 'api/game-art/ffffffffff?kind=cover&t=' + $token)).status 'unbekannte id 404'
        Assert-Equal 404 (Invoke-Http 'GET' ($base + 'api/game-art/..%2F..%2Fsystem.json?kind=cover&t=' + $token)).status 'Pfad statt id 404'
        Assert-Equal 404 (Invoke-Http 'GET' ($base + 'api/game-art/%2E%2E%5Cstate-sim.json?kind=icon&t=' + $token)).status 'Backslash-Pfad 404'
        $gg = @($gd.result.games | Where-Object { $_.exe -eq 'LanternKeep.exe' })[0]
        Assert-Equal 'image/x-icon' (Invoke-Http 'GET' ($base + 'api/game-art/' + $gg.id + '?kind=icon&t=' + $token)).contentType 'GOG-.ico'
        $none = @($gd.result.games | Where-Object { -not $_.art.cover -and -not $_.art.icon })[0]
        Assert-Equal 404 (Invoke-Http 'GET' ($base + 'api/game-art/' + $none.id + '?kind=cover&t=' + $token)).status 'Spiel ohne Bild 404'
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
        # ---- KI providers: Groq key, ai settings, ai-status with the fake Claude Code CLI
        $k = Invoke-Http 'POST' ($base + 'api/ai/key/groq') @{ key = 'sk-ant-falsch' } $H
        Assert-True ($k.status -eq 400 -and $k.json.error -match 'gsk_') 'falscher Groq-Key -> 400'
        $k = Invoke-Http 'POST' ($base + 'api/ai/key/groq') @{ key = 'gsk_E2EGROQ0123456789abcdefABCDEF' } $H
        Assert-True ($k.json.hasKey -eq $true -and $k.json.settings.ai.groq.hasKey -eq $true -and -not $k.text.Contains('E2EGROQ')) 'Groq-Key gespeichert, nicht zurückgegeben'
        $k = Invoke-Http 'DELETE' ($base + 'api/ai/key/groq') $null $H
        Assert-True ($k.json.hasKey -eq $false -and $k.json.settings.ai.groq.hasKey -eq $false) 'Groq-Key gelöscht'
        Assert-Equal 405 (Invoke-Http 'GET' ($base + 'api/ai/key/groq') $null $H).status 'GET auf Key -> 405'
        $s = Invoke-Http 'POST' ($base + 'api/settings') @{ ai = @{ provider = 'claude-code'; claudeCode = @{ model = 'haiku' }; groq = @{ model = 'openai/gpt-oss-20b'; hasKey = $true } } } $H
        Assert-True ($s.json.settings.ai.provider -eq 'claude-code' -and $s.json.settings.ai.claudeCode.model -eq 'haiku' -and $s.json.settings.ai.groq.model -eq 'openai/gpt-oss-20b' -and $s.json.settings.ai.groq.hasKey -eq $false) 'ai-Einstellungen'
        $as = Start-JobAndWait $base $H 'ai-status' @{}
        $ccRow = @($as.result.providers | Where-Object { $_.id -eq 'claude-code' })[0]
        Assert-True ($ccRow.ready -eq $true -and $ccRow.account -eq 'gamer@example.com' -and @($as.result.providers).Count -eq 4) ('ai-status mit Fake-CLI: ' + $ccRow.message)
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
        # ---- shutdown via sendBeacon-style ?t= (no header), per window session
        $hbA = Invoke-Http 'POST' ($base + 'api/heartbeat?s=aaaa1111') $null $H
        Assert-True ($hbA.json.ok) 'heartbeat mit Session'
        $sdB = Invoke-Http 'POST' ($base + 'api/shutdown?t=' + $token + '&s=bbbb2222')
        Assert-True ($sdB.status -eq 200 -and $sdB.json.ok -and $sdB.json.closing -eq $false) 'anderes Fenster lebt -> kein Beenden'
        Start-Sleep -Milliseconds 300
        Assert-True (-not $proc.HasExited) 'läuft weiter'
        $sd = Invoke-Http 'POST' ($base + 'api/shutdown?t=' + $token + '&s=aaaa1111')
        Assert-True ($sd.status -eq 200 -and $sd.json.ok -and $sd.json.closing -eq $true) 'letztes Fenster -> shutdown angenommen'
        Assert-True ($proc.WaitForExit(20000)) 'Prozess beendet sich nach dem Shutdown'
        Assert-Equal 0 $proc.ExitCode 'Exit-Code 0'
        Assert-True (-not [IO.File]::Exists((Join-Path $dataRoot 'instance-sim.json'))) 'instance-sim.json aufgeräumt'
        Assert-True (-not [IO.File]::Exists((Join-Path $dataRoot 'state.json')) -and [IO.File]::Exists((Join-Path $dataRoot 'state-sim.json'))) 'Testmodus schreibt nur state-sim.json'
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

Test-Case 'server' 'Fenster-Sessions: Beenden nur, wenn kein anderes Fenster lebt; alter Ablauf ohne s' {
    $null = New-TestContext
    $global:VxCtx.Life = New-VxLifecycle
    $life = $global:VxCtx.Life
    # window A lives, window B closes -> VELOX keeps running
    Register-VxHeartbeat 'winA'
    Assert-True (-not (Request-VxShutdown 'winB')) 'B schließt, A lebt -> kein Beenden'
    Assert-True ($null -eq $life.shutdownAt) 'nichts geplant'
    # A's last heartbeat is older than the grace period -> A closing ends VELOX
    $life.sessions['winA'] = [DateTime]::UtcNow.AddSeconds(-10)
    Register-VxHeartbeat 'winC'
    $life.sessions['winC'] = [DateTime]::UtcNow.AddSeconds(-10)
    Assert-True (Request-VxShutdown 'winA') 'kein anderes Fenster in der Gnadenfrist -> Beenden geplant'
    # A heartbeat of A that was already in flight does not cancel ...
    Register-VxHeartbeat 'winA'
    Assert-True ($null -ne $life.shutdownAt) 'verspäteter Heartbeat des schließenden Fensters bricht nicht ab'
    # ... a heartbeat of another window during the grace period does
    Register-VxHeartbeat 'winC'
    Assert-True ($null -eq $life.shutdownAt) 'Heartbeat eines anderen Fensters bricht ab'
    # back from the back/forward cache: A's own later heartbeat cancels too
    $life.sessions['winC'] = [DateTime]::UtcNow.AddSeconds(-10)
    Assert-True (Request-VxShutdown 'winA') 'erneut geplant'
    $life.shutdownRequested = ([DateTime]$life.shutdownRequested).AddSeconds(-2)
    Register-VxHeartbeat 'winA'
    Assert-True ($null -eq $life.shutdownAt) 'späterer Heartbeat von A (bfcache) bricht ab'
    # at the end of the grace period another window that beat in time still blocks
    $life.sessions['winC'] = [DateTime]::UtcNow.AddSeconds(-10)
    $null = Request-VxShutdown 'winA'
    $life.sessions['winC'] = [DateTime]::UtcNow
    $life.shutdownAt = [DateTime]::UtcNow.AddSeconds(-1)
    Test-VxLifecycle
    Assert-True (-not $life.stop -and $null -eq $life.shutdownAt) 'anderes Fenster lebt bei Ablauf -> kein Beenden'
    $life.sessions['winC'] = [DateTime]::UtcNow.AddSeconds(-10)
    $null = Request-VxShutdown 'winA'
    $life.shutdownAt = [DateTime]::UtcNow.AddSeconds(-1)
    Test-VxLifecycle
    Assert-True ($life.stop -and $life.reason -eq 'shutdown') 'sonst Beenden nach Ablauf'
    # without session ids: old behaviour (beacon always schedules, any heartbeat cancels)
    $global:VxCtx.Life = New-VxLifecycle
    $life = $global:VxCtx.Life
    Register-VxHeartbeat 'winA'
    Assert-True (Request-VxShutdown '') 'ohne s immer geplant'
    Register-VxHeartbeat ''
    Assert-True ($null -eq $life.shutdownAt) 'ohne s bricht jeder Heartbeat ab'
}

Test-Case 'server' 'Jobs: keine Stacktraces im Job-Log oder Fehlertext, nur in der Logdatei' {
    $ctx = New-TestContext
    $orig = ${function:Invoke-VxScanJob}
    try {
        ${function:global:Invoke-VxScanJob} = { param($Params) Write-VxLog 'error' ("Schritt kaputt | at <ScriptBlock>, <No file>: line 3`n   at Invoke-VxFoo, C:\x\Engine.ps1: line 12"); throw ("Etwas ging schief`nAt line:1 char:1`n+ throw 'x'`n+ ~~~~~~~~~`n    + CategoryInfo          : OperationStopped: (:) [], RuntimeException") }
        $job = [hashtable]::Synchronized(@{ id = 'abcdef12'; type = 'scan'; status = 'running'; progress = 0.0; step = 'Starte ...'
                log = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); nextIndex = 0
                result = $null; error = $null; cancel = $false; lockObj = (New-Object object); params = @{} })
        $global:VxJob = $job
        Invoke-VxJobBody
    } finally {
        $global:VxJob = $null
        ${function:global:Invoke-VxScanJob} = $orig
    }
    Assert-Equal 'error' $job.status 'Job fehlgeschlagen'
    Assert-Equal 'Etwas ging schief' $job.error 'Fehlertext ohne Position/Stack'
    $all = (@($job.log | ForEach-Object { $_.msg }) -join "`n")
    Assert-True ($all -match 'Schritt kaputt' -and $all -match 'Etwas ging schief') 'Meldungen bleiben'
    Assert-True ($all -notmatch '<ScriptBlock>|line \d|At line|CategoryInfo|Engine\.ps1') ('kein Stacktrace im Job-Log: ' + $all)
    $logText = (@(Get-ChildItem -LiteralPath $ctx.LogDir -Filter '*.log' | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n")
    Assert-True ($logText -match 'Job scan fehlgeschlagen' -and $logText -match 'at ') 'Stacktrace steht in der Logdatei'
    Assert-Equal 'Zugriff verweigert – Administratorrechte nötig' (Remove-VxStackText 'Zugriff verweigert – Administratorrechte nötig | at <ScriptBlock>, <No file>: line 9') 'angehängter Stack wird abgeschnitten'
    Assert-Equal 'Fehler A' (Remove-VxStackText "Fehler A`nIn Zeile:4 Zeichen:5`n+ foo") 'deutsche Positionszeilen'
}

# ==================================================================== review fixes (regression tests)
$PwsSub = '54533251-82be-4824-96c1-47b60b740d00'
$PwsPark = '0cc5b647-c1df-4637-891a-dec35c318583'
$PwsUsbSub = '2a737441-1930-4402-8d77-b2bebba308a3'
$PwsUsb = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'
$GuidBalanced = '381b4222-f694-41f0-9685-ff5bb260df2e'
$GuidUltimate = 'e9a42b02-d5df-448d-aa00-03f14749eb61'
$GuidHigh = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

Test-Case 'review' 'Testmodus und echter Modus: getrennte state-/instance-Dateien, getrennte Sperre' {
    $ctx = New-TestContext
    $ctx.State.statuses['gaming.gamedvr-off'] = 'applied'
    $ctx.State.needs.reboot = $true
    $ctx.State.lastScan = Get-VxNowIso
    Save-VxState
    Assert-Equal 'state-sim.json' (Get-VxStateFileName) 'Testmodus-Datei'
    Assert-Equal 'instance-sim.json' (Get-VxInstanceFileName) 'Testmodus-Instanzdatei'
    Assert-Equal 'sim' (Get-VxModeTag) 'Modus-Kennung'
    Assert-True ([IO.File]::Exists((Get-VxDataPath 'state-sim.json'))) 'state-sim.json geschrieben'
    Assert-True (-not [IO.File]::Exists((Get-VxDataPath 'state.json'))) 'state.json nicht angefasst'
    # the real mode (same data root) starts clean and never sees the simulated statuses
    Write-VxJsonFile -Path (Get-VxDataPath 'state.json') -InputObject @{ ultimateGuid = 'aaaaaaaa-1111-2222-3333-444444444444'; statuses = @{ 'x.y' = 'default' } }
    $ctx.Simulate = $false
    $real = Import-VxState
    Assert-True (-not $real.statuses.ContainsKey('gaming.gamedvr-off') -and -not $real.needs.reboot -and -not $real.lastScan) 'echter Modus ohne Testmodus-Status'
    Assert-Equal 'state.json' (Get-VxStateFileName) 'echte Datei'
    Assert-Equal 'real' (Get-VxModeTag) 'echte Kennung'
    # the Testmodus may reuse the plan copies real mode created (read-only)
    $ctx.Simulate = $true
    Remove-Item -LiteralPath (Get-VxDataPath 'state-sim.json') -Force
    $sim = Import-VxState
    Assert-Equal 'aaaaaaaa-1111-2222-3333-444444444444' $sim.ultimateGuid 'Plan-Kopie aus dem echten Modus bekannt'
    Assert-True (-not $sim.statuses.ContainsKey('x.y')) 'aber keine echten Statuswerte'
    $velox = [IO.File]::ReadAllText((Join-Path $AppRoot 'Velox.ps1'))
    Assert-True ($velox -match "'Local\\VELOX-' \+ \(Get-VxModeTag\)" -and $velox -match 'catch \[System\.UnauthorizedAccessException\]') 'Sperre pro Modus, fremde Admin-Sperre = läuft schon'
}

Test-Case 'review' 'Energie: Plan zuerst, Einstellungen landen im aktiven Plan, Journal merkt sich den Plan' {
    $ctx = New-TestContext
    $ids = @('power.core-parking-off', 'power.usb-suspend-off', 'power.ultimate-plan')
    Assert-Equal @('power.ultimate-plan', 'power.core-parking-off', 'power.usb-suspend-off') @(Get-VxPowerOrderedIds $ids 'apply') 'Plan zuerst beim Anwenden'
    Assert-Equal @('power.core-parking-off', 'power.usb-suspend-off', 'power.ultimate-plan') @(Get-VxPowerOrderedIds $ids 'revert') 'Plan zuletzt beim Zurücksetzen'
    $res = Invoke-VxApplyJob ([pscustomobject]@{ ids = $ids; label = 'Plan-Test' }) 'apply'
    Assert-Equal $GuidUltimate (Get-VxActivePlan).guid 'Ultimate aktiv'
    foreach ($r in $res.results) { Assert-True ($r.ok -and $r.status -eq 'applied') ("{0} angewendet: {1} {2}" -f $r.id, $r.status, $r.error) }
    Assert-Equal 100 ([int](Get-VxPowerSetting $PwsSub $PwsPark $null $GuidUltimate).ac) 'Wert im neuen Plan'
    Assert-Equal 10 ([int](Get-VxPowerSetting $PwsSub $PwsPark @{ ac = 10; dc = 10 } $GuidBalanced).ac) 'Ausbalanciert unverändert'
    $doc = Read-VxBackup $res.backupId
    $pe = @($doc.entries | Where-Object { $_.op -eq 'powersetting' })
    Assert-True ($pe.Count -eq 2 -and @($pe | Where-Object { $_.scheme -ne $GuidUltimate }).Count -eq 0) 'Journal kennt den Plan'
    Assert-True ([string]$doc.entries[0].op -eq 'powerplan') 'Planwechsel steht vorne im Journal'
    # a later plan switch does not redirect a restore: the values go back into Ultimate
    Set-VxActivePlanGuid $GuidHigh
    $rr = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $res.backupId })
    Assert-Equal 0 $rr.failed ('Restore ohne Fehler: ' + ($rr.errors -join '; '))
    Assert-Equal 10 ([int](Get-VxPowerSetting $PwsSub $PwsPark @{ ac = 10; dc = 10 } $GuidUltimate).ac) 'Ultimate wieder auf dem alten Wert'
    Assert-Equal $null (Get-VxProp $ctx.Sim.pws ($GuidHigh + '|' + $PwsSub + '|' + $PwsPark).ToLowerInvariant()) 'Höchstleistung nie angefasst'
    # revert batch: the plan goes last, the settings are reverted in the plan they were applied to
    Set-VxActivePlanGuid $GuidBalanced
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = $ids }) 'apply'
    $rv = Invoke-VxApplyJob ([pscustomobject]@{ ids = $ids }) 'revert'
    Assert-Equal $GuidBalanced (Get-VxActivePlan).guid 'zurück auf Ausbalanciert'
    Assert-Equal 10 ([int](Get-VxPowerSetting $PwsSub $PwsPark @{ ac = 10; dc = 10 } $GuidUltimate).ac) 'Ultimate-Wert zurückgesetzt'
    foreach ($r in $rv.results) { Assert-Equal 'default' $r.status ("{0} nach revert" -f $r.id) }
    # older overlays without a scheme are moved to the plan that was active then
    $ctx.Sim.pws = @{ ($PwsSub + '|' + $PwsPark).ToLowerInvariant() = @{ ac = 77; dc = 77 } }
    $ctx.Sim.power.active = $GuidHigh
    Repair-VxSimPowerSettings
    Assert-Equal 77 ([int](Get-VxPowerSetting $PwsSub $PwsPark $null $GuidHigh).ac) 'alte Overlay-Werte übernommen'
}

Test-Case 'review' 'Energieoption: AC und DC zusammen gemerkt, AC-only-Tweaks lassen DC in Ruhe' {
    $null = New-TestContext
    # usb suspend (ac 0 / dc 0): AC already 0, DC custom 3 -> remembered as a whole, DC comes back
    Set-VxPowerSetting $PwsUsbSub $PwsUsb 0 3
    $null = Invoke-Change 'power.usb-suspend-off' 'apply'
    Assert-Equal 'applied' (Get-Status 'power.usb-suspend-off') 'angewendet'
    $null = Invoke-Change 'power.usb-suspend-off' 'revert'
    $v = Get-VxPowerSetting $PwsUsbSub $PwsUsb $null
    Assert-True ([int]$v.ac -eq 0 -and [int]$v.dc -eq 3) ("eigener DC-Wert zurück: {0}/{1}" -f $v.ac, $v.dc)
    # core parking (ac only): DC is never written, also not on revert
    Set-VxPowerSetting $PwsSub $PwsPark 10 0
    $null = Invoke-Change 'power.core-parking-off' 'apply'
    Set-VxPowerSetting $PwsSub $PwsPark $null 5
    $null = Invoke-Change 'power.core-parking-off' 'revert'
    $p = Get-VxPowerSetting $PwsSub $PwsPark $null
    Assert-True ([int]$p.ac -eq 10 -and [int]$p.dc -eq 5) ("AC zurück, DC unberührt: {0}/{1}" -f $p.ac, $p.dc)
}

Test-Case 'review' 'Testmodus: Standardwert ("") eines Schlüssels übersteht Speichern und Laden' {
    $ctx = New-TestContext
    $null = Invoke-Change 'system.classic-context-menu' 'apply'
    $ctx.Sim.svc['xyz'] = 'Disabled'
    Save-VxSim
    $text = [IO.File]::ReadAllText((Get-VxDataPath 'sim-state.json'))
    Assert-True ($text -notmatch '"":') 'kein leerer JSON-Schlüssel'
    Import-VxSim
    Assert-Equal 'Disabled' $ctx.Sim.svc['xyz'] 'Overlay nicht verworfen'
    Assert-Equal 'applied' (Get-Status 'system.classic-context-menu') 'Tweak nach dem Laden noch aktiv'
    # overlays of older versions (raw value names) are re-keyed on load
    $ck = 'HKCU\Software\VeloxFixture\Legacy'
    $ctx.Sim.reg[$ck.ToLowerInvariant()] = @{ path = $ck; exists = $true; cleared = $false; values = @{ 'mixedcase' = @{ name = 'MixedCase'; kind = 'DWord'; value = 7; deleted = $false } } }
    Repair-VxSimRegValues
    Assert-Equal 7 ([int](Get-VxRegValue $ck 'MixedCase').value) 'alter Overlay-Wert lesbar'
}

Test-Case 'review' 'ps-Aktionen: schon erreichter Zustand wird weder ausgeführt noch gesichert' {
    $null = New-TestContext
    $r1 = Invoke-Change 'memory.compression-off' 'apply'
    Assert-True ($r1.changed -gt 0 -and $null -ne $r1.backupId) 'erstes Anwenden gesichert'
    $r2 = Invoke-Change 'memory.compression-off' 'apply'
    Assert-True ($r2.changed -eq 0 -and $null -eq $r2.backupId) 'zweites Anwenden ohne Journal'
    $rr = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $r1.backupId })
    Assert-Equal 0 $rr.failed 'Restore ok'
    Assert-Equal 'default' (Get-Status 'memory.compression-off') 'Restore stellt den alten Zustand her'
    $r3 = Invoke-Change 'memory.compression-off' 'revert'
    Assert-True ($r3.changed -eq 0 -and $null -eq $r3.backupId) 'Zurücksetzen eines Standardzustands ohne Journal'
}

Test-Case 'review' 'Spiele-Boost teilt sich den IFEO-Wert sauber mit Katalog-Tweaks' {
    $ctx = New-TestContext
    $exePath = 'C:\Users\Gamer\AppData\Local\FiveM\FiveM.app\data\cache\subprocess\FiveM_GTAProcess.exe'
    $ifeo = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\FiveM_GTAProcess.exe\PerfOptions'
    $null = Invoke-Change 'games.fivem-priority' 'apply'
    $st = Get-VxGameBoostState $exePath
    Assert-True ($st.priority -and $st.priorityTweak -eq 'games.fivem-priority') 'Boost zeigt, woher die Priorität kommt'
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = $exePath; priority = $false; gpu = $true; fso = $false })
    Assert-Equal 3 ([int](Get-VxRegValue $ifeo 'CpuPriorityClass').value) 'Katalog-Tweak bleibt unangetastet'
    Assert-Equal 'applied' (Get-Status 'games.fivem-priority') 'Tweak weiter aktiv'
    # reverting the tweak takes the priority away -> the remembered boost follows and says so
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = $exePath; priority = $true; gpu = $true; fso = $false })
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('games.fivem-priority') }) 'revert'
    $g = @($ctx.Settings.games | Where-Object { $_.path -eq $exePath })[0]
    Assert-True ($null -ne $g -and -not $g.boost.priority -and $g.boost.gpu) 'settings.games nachgezogen'
    # a priority that existed before the boost comes back on un-boost; the key stays
    $other = 'C:\Games\Other\Other.exe'
    $oifeo = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\Other.exe\PerfOptions'
    Set-VxRegValue $oifeo 'CpuPriorityClass' 'DWord' 5
    Set-VxRegValue $oifeo 'IoPriority' 'DWord' 3
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = $other; priority = $true })
    Assert-Equal 3 ([int](Get-VxRegValue $oifeo 'CpuPriorityClass').value) 'geboostet'
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = $other; priority = $false })
    Assert-Equal 5 ([int](Get-VxRegValue $oifeo 'CpuPriorityClass').value) 'alter Wert zurück statt gelöscht'
    Assert-Equal 3 ([int](Get-VxRegValue $oifeo 'IoPriority').value) 'fremder Wert im Schlüssel bleibt'
    # un-ticking something unrelated never deletes another tool's priority
    Set-VxRegValue $oifeo 'CpuPriorityClass' 'DWord' 1
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = $other; priority = $false; gpu = $true })
    Assert-Equal 1 ([int](Get-VxRegValue $oifeo 'CpuPriorityClass').value) 'fremde Priorität bleibt'
}

Test-Case 'review' 'Detweak: IFEO-Schlüssel von VELOX-Tweaks und Spiele-Boosts sind keine Fremd-Tweaks' {
    $ctx = New-TestContext -Seed
    $null = Invoke-Change 'games.fivem-priority' 'apply'
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = 'C:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe'; priority = $true })
    $keys = @((Invoke-VxDetweakScanJob ([pscustomobject]@{})).items | ForEach-Object { $_.key })
    Assert-True (@($keys | Where-Object { $_ -match 'regkey\|.*FiveM_GTAProcess' }).Count -eq 0) 'Katalog-IFEO nicht als Fremd-Tweak'
    Assert-True (@($keys | Where-Object { $_ -match 'regkey\|.*VALORANT' }).Count -eq 0) 'Boost-IFEO nicht als Fremd-Tweak'
    Assert-True ($keys -contains 'regkey|HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\GTA5.exe\PerfOptions') 'echter Fremd-Schlüssel weiter gelistet'
    Assert-True ($keys -contains 'tweak|games.fivem-priority') 'eigener Tweak als Katalog-Eintrag'
    Set-VxRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\FiveM_GTAProcess.exe\PerfOptions' 'IoPriority' 'DWord' 3
    $keys2 = @((Invoke-VxDetweakScanJob ([pscustomobject]@{})).items | ForEach-Object { $_.key })
    Assert-True (@($keys2 | Where-Object { $_ -match 'regkey\|.*FiveM_GTAProcess' }).Count -eq 1) 'fremder Wert im selben Schlüssel wird gemeldet'
}

Test-Case 'review' 'Smart-Analyse: Kompromiss-Tweaks nur aus dem Preset, passend zur Hardware oder auf Wunsch' {
    $ctx = New-TestContext
    $desk = Get-VxSimProfile 'desktop'
    $ctx.State.profile = $desk
    $ids = @((Invoke-VxAdvisor 'gaming' '' $desk).plan | ForEach-Object { $_.id })
    Assert-True ($ids -notcontains 'memory.compression-off') 'kein ungefragter Kompromiss'
    Assert-True ($ids -contains 'latency.timer-bcd') 'Kompromiss aus dem Gaming-Preset bleibt'
    Assert-True ($ids -contains 'services.sysmain-off') 'Kompromiss passend zur SSD bleibt'
    $kw = @((Invoke-VxAdvisor 'gaming' 'Mein Spiel ruckelt' $desk).plan | ForEach-Object { $_.id })
    Assert-True ($kw -contains 'memory.compression-off') 'auf Wunsch (Freitext) dabei'
    # catalog flag "situational": only with free text
    $t = Get-VxTweak 'latency.timer-bcd'
    Add-Member -InputObject $t -NotePropertyName 'situational' -NotePropertyValue $true -Force
    try {
        Assert-True (@((Invoke-VxAdvisor 'gaming' '' $desk).plan | ForEach-Object { $_.id }) -notcontains 'latency.timer-bcd') 'situational ohne Freitext raus'
        Assert-True (@((Invoke-VxAdvisor 'gaming' 'input lag und Verzögerung' $desk).plan | ForEach-Object { $_.id }) -contains 'latency.timer-bcd') 'situational mit Freitext drin'
        Assert-True ((Get-VxCatalogDigest) -match 'latency\.timer-bcd \|.*\| nur bei passendem Problem') 'Claude sieht den Hinweis'
    } finally { $t.PSObject.Properties.Remove('situational') }
    # per-game priority only for installed games
    Assert-True (@((Invoke-VxAdvisor 'fivem' '' $desk).plan | ForEach-Object { $_.id }) -contains 'games.fivem-priority') 'FiveM gefunden -> Tweak'
    $ctx.Cache.detectedGames = @{ exes = @{}; fivem = $false }
    Assert-True (@((Invoke-VxAdvisor 'fivem' '' $desk).plan | ForEach-Object { $_.id }) -notcontains 'games.fivem-priority') 'ohne FiveM kein FiveM-Tweak'
    $ctx.Cache.Remove('detectedGames')
    # reasons: neutral wording, WLAN only for WLAN tweaks
    $r = Get-VxPlanReason (Get-VxTweak 'latency.timer-bcd') $desk 'gaming'
    Assert-True ($r -match '^Weniger Verzögerung' -and $r -notmatch 'Maus') ('Latenz-Begründung: ' + $r)
    Assert-True ((Get-VxPlanReason (Get-VxTweak 'latency.mouse-accel-off') $desk 'gaming') -match 'Maus') 'Eingabe-Begründung'
    Assert-True ((Get-VxPlanReason (Get-VxTweak 'gaming.mmcss-games') $desk 'gaming') -notmatch 'GB RAM') 'RAM nur bei Speicher-Tweaks'
    $wifi = [pscustomobject]@{ id = 'network.wifi-roaming-low'; name = 'WLAN-Roaming niedrig'; desc = 'x'; tags = @('network', 'ping'); category = 'network'; actions = @() }
    Assert-True ((Get-VxPlanReason $wifi $desk 'gaming') -match 'WLAN') 'WLAN-Tweak auf LAN-PC sagt WLAN'
    Assert-True (Test-VxWifiTweak $wifi) 'WLAN-Tweak erkannt'
}

Test-Case 'review' 'Ryzen X3D mit zwei Chiplets: kein Energieplan-/Core-Parking-Vorschlag; Befund und Plan nennen denselben Plan' {
    $ctx = New-TestContext
    $p = Get-VxSimProfile 'desktop'
    $p.cpu.name = 'AMD Ryzen 9 7950X3D 16-Core Processor'
    $ctx.State.profile = $p
    $r = Invoke-VxAdvisor 'gaming' '' $p
    $ids = @($r.plan | ForEach-Object { $_.id })
    Assert-True (@($ids | Where-Object { $_ -like 'power.*-plan' -or $_ -eq 'power.core-parking-off' }).Count -eq 0) ('keine Plan-/Parking-Tweaks: ' + ($ids -join ','))
    $pp = @($r.findings | Where-Object { $_.id -eq 'power-plan' })[0]
    Assert-True ($null -ne $pp -and $pp.severity -eq 'good' -and $null -eq $pp.fix) 'Ausbalanciert als richtig erklärt'
    $sel = Select-VxClaudePlan @([pscustomobject]@{ id = 'power.ultimate-plan'; reason = 'x' }) $false $p
    Assert-True (@($sel.plan).Count -eq 0) 'Claude-Vorschlag ebenfalls verworfen'
    # single-CCD X3D (5800X3D in the sim profile) keeps the normal advice, finding = plan
    $d = Get-VxSimProfile 'desktop'
    $ctx.State.profile = $d
    $r2 = Invoke-VxAdvisor 'gaming' '' $d
    $planPlan = @($r2.plan | ForEach-Object { $_.id } | Where-Object { $_ -like 'power.*-plan' })
    $pp2 = @($r2.findings | Where-Object { $_.id -eq 'power-plan' })[0]
    Assert-True ($planPlan.Count -eq 1 -and @($pp2.fix.ids).Count -eq 1 -and $pp2.fix.ids[0] -eq $planPlan[0]) 'Befund-Fix = Plan-Eintrag'
}

Test-Case 'review' 'Gehäusetyp entscheidet: USV-Akku macht keinen Laptop' {
    $ff = Get-VxFormFactor @(3) @(@{ name = 'Back-UPS XS 700U'; deviceId = 'APC'; chemistry = 3 })
    Assert-True ($ff.formFactor -eq 'desktop' -and -not $ff.battery) 'Desktop mit USV'
    $ff = Get-VxFormFactor @(3) @(@{ name = 'Interner Akku'; deviceId = 'BAT0'; chemistry = 6 })
    Assert-Equal 'desktop' $ff.formFactor 'Desktop-Gehäuse gewinnt'
    Assert-Equal 'laptop' (Get-VxFormFactor @(10) @()).formFactor 'Notebook-Gehäuse'
    Assert-Equal 'laptop' (Get-VxFormFactor @(2) @(@{ name = 'Akku'; deviceId = 'BAT0' })).formFactor 'unbekanntes Gehäuse + Akku'
    Assert-Equal 'desktop' (Get-VxFormFactor @(2) @(@{ name = 'Smart-UPS 1500'; deviceId = 'x' })).formFactor 'unbekanntes Gehäuse + USV'
    Assert-True (-not (Test-VxIsLaptop @{ formFactor = 'desktop'; battery = $true })) 'Advisor folgt nur formFactor'
}

Test-Case 'review' 'Restore: nur Einträge, die VELOX selbst schreibt, werden wiederhergestellt' {
    $ctx = New-TestContext
    Set-VxRegValue 'HKCU\System\GameConfigStore' 'GameDVR_Enabled' 'DWord' 0
    $evil = [ordered]@{
        id = '20261005-120000-apply'; label = 'Gepflanzt'; kind = 'apply'; created = '2026-10-05T12:00:00'; simulate = $true; restorePoint = $false
        entries = @(
            [ordered]@{ op = 'reg'; path = 'HKCU\System\GameConfigStore'; name = 'GameDVR_Enabled'; before = @{ exists = $true; kind = 'DWord'; value = 1 }; after = @{ exists = $true; kind = 'DWord'; value = 0 } },
            [ordered]@{ op = 'reg'; path = 'HKLM\SYSTEM\CurrentControlSet\Services\Evil'; name = 'ImagePath'; before = @{ exists = $true; kind = 'ExpandString'; value = 'C:\evil.exe' }; after = @{ exists = $false } },
            [ordered]@{ op = 'bcd'; name = 'testsigning'; before = 'Yes'; after = $null },
            [ordered]@{ op = 'regkey'; path = 'HKLM\SYSTEM\CurrentControlSet\Services'; before = $false; after = $true },
            [ordered]@{ op = 'regkey'; path = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\x.exe\PerfOptions'; before = $true; after = $false
                tree = [ordered]@{ path = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\x.exe\PerfOptions'; values = @(); keys = @([ordered]@{ path = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\x.exe\Debugger'; values = @(); keys = @() }) } },
            [ordered]@{ op = 'service'; name = 'EvilSvc'; before = 'Automatic'; after = 'Disabled' }
        )
    }
    Write-VxJsonFile -Path (Join-Path $ctx.BackupDir '20261005-120000-apply.json') -InputObject $evil
    $rr = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = '20261005-120000-apply' })
    Assert-Equal 1 $rr.restored 'nur der echte VELOX-Eintrag'
    Assert-Equal 5 $rr.failed 'fünf Einträge verweigert'
    Assert-True (@($rr.errors | Where-Object { $_ -match 'Sicherheitsgründen' }).Count -eq 5) 'deutscher Grund'
    Assert-Equal 1 ([int](Get-VxRegValue 'HKCU\System\GameConfigStore' 'GameDVR_Enabled').value) 'erlaubter Eintrag wiederhergestellt'
    Assert-True (-not (Get-VxRegValue 'HKLM\SYSTEM\CurrentControlSet\Services\Evil' 'ImagePath').exists) 'Dienst-Pfad nicht geschrieben'
    Assert-True ($null -eq (Get-VxBcdValue 'testsigning')) 'testsigning nicht gesetzt'
    Assert-True (-not (Test-VxRegKey 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\x.exe\Debugger')) 'Baum außerhalb des Schlüssels verweigert'
}

Test-Case 'review' 'Reinigung: Verknüpfungen (Junction/Symlink) werden nie verfolgt' {
    $ctx = New-TestContext
    $base = New-TempDir 'clean'
    # the cache sits in the fake PC's LOCALAPPDATA (allow-list), the link target outside of it
    $ctx.CleanFixture = $base
    $outside = Join-Path $base 'outside'
    $local = Join-Path $base 'C/Users/Max/AppData/Local'
    [void][IO.Directory]::CreateDirectory($local)
    $cache = Join-Path $local 'cache'
    [void][IO.Directory]::CreateDirectory($outside)
    [void][IO.Directory]::CreateDirectory((Join-Path $cache 'sub'))
    [IO.File]::WriteAllText((Join-Path $outside 'wichtig.txt'), 'x')
    [IO.File]::WriteAllText((Join-Path $cache 'a.tmp'), 'abc')
    [IO.File]::WriteAllText((Join-Path (Join-Path $cache 'sub') 'b.tmp'), 'abcd')
    $linkOk = $true
    try { $null = New-Item -ItemType SymbolicLink -Path (Join-Path $cache 'link') -Target $outside -ErrorAction Stop } catch { $linkOk = $false }
    if (-not $linkOk) { Add-Note 'Symlinks nicht erlaubt - Verknüpfungstest übersprungen.'; return }
    $r = Resolve-VxCleanPath $cache
    $items = @(Get-VxCleanTopItems $r @())
    $w = Invoke-VxCleanWalk $items $true 30000 (Get-VxCleanRootFinal $r.root)
    Assert-Equal 2 $w.deleted 'beide Cache-Dateien gelöscht'
    Assert-True ([IO.File]::Exists((Join-Path $outside 'wichtig.txt'))) 'Ziel der Verknüpfung unberührt'
    # the cleaned folder itself (or a folder above it) is a link -> refused
    $linkRoot = Join-Path $local 'cache-link'
    $null = New-Item -ItemType SymbolicLink -Path $linkRoot -Target $outside
    $refused = $false
    try { $null = Get-VxCleanTopItems (Resolve-VxCleanPath $linkRoot) @() } catch { $refused = ([string]$_.Exception.Message -match 'Verknüpfung') }
    Assert-True $refused 'Wurzel als Verknüpfung verweigert'
    $refused2 = $false
    try { $null = Get-VxCleanTopItems (Resolve-VxCleanPath (Join-Path $linkRoot 'x')) @() } catch { $refused2 = ([string]$_.Exception.Message -match 'Verknüpfung') }
    Assert-True $refused2 'Verknüpfung weiter oben verweigert'
    Assert-True ([IO.File]::Exists((Join-Path $outside 'wichtig.txt'))) 'nichts außerhalb gelöscht'
}

Test-Case 'review' 'Cache: jeder Job und jedes Skript liest Energieplan/BCD neu' {
    $ctx = New-TestContext
    $ctx.Cache.activePlan = @{ guid = 'stale'; name = 'alt' }
    $ctx.Cache.bcd = @{ useplatformclock = 'Yes' }
    $ctx.Cache.appx = @{ 'microsoft.bingnews' = $true }
    $null = Invoke-VxPsSource '$null = 1'
    Assert-True ($ctx.Cache.ContainsKey('activePlan') -and $ctx.Cache.ContainsKey('bcd')) 'ein Skript ohne powercfg/bcdedit lässt den Cache stehen'
    $null = Invoke-VxPsSource '$exe = "powercfg.exe"; $null = $exe' -ReadOnly
    Assert-True ($ctx.Cache.ContainsKey('activePlan')) 'Erkennungs-Skripte (nur lesen) lassen den Cache stehen'
    $null = Invoke-VxPsSource '$a = "powercfg"; $b = "bcdedit"; $null = $a + $b'
    Assert-True (-not $ctx.Cache.ContainsKey('activePlan') -and -not $ctx.Cache.ContainsKey('bcd')) 'nach powercfg/bcdedit-Skript geleert'
    Assert-True ($ctx.Cache.ContainsKey('appx')) 'App-Liste bleibt, das Skript fasst keine Apps an'
    $ctx.Cache.activePlan = @{ guid = 'stale'; name = 'alt' }
    $job = [hashtable]::Synchronized(@{ id = 'x'; type = 'startup-list'; status = 'running'; progress = 0.0; step = ''; log = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); nextIndex = 0; result = $null; error = $null; cancel = $false; lockObj = (New-Object object); params = @{} })
    $global:VxJob = $job
    try { Invoke-VxJobBody } finally { $global:VxJob = $null }
    Assert-Equal 'done' $job.status 'Job lief'
    Assert-True (-not $ctx.Cache.ContainsKey('activePlan')) 'Job startet ohne alten Cache'
}

Test-Case 'review' 'Anderes Admin-Konto: HKCU, Benutzerordner und Skripte zielen auf den angemeldeten Benutzer' {
    $ctx = New-TestContext
    Assert-Equal 'HKCU' (Resolve-VxRealRegTarget 'HKCU\Software\X').Hive 'ohne Fremdkonto unverändert'
    $ctx.DesktopUser = @{ name = 'PC\Kind'; sid = 'S-1-5-21-1-2-3-1001'; profile = 'C:\Users\Kind'; localAppData = 'C:\Users\Kind\AppData\Local'; appData = 'C:\Users\Kind\AppData\Roaming'; temp = 'C:\Users\Kind\AppData\Local\Temp'; startup = 'C:\Users\Kind\Start' }
    try {
        $t = Resolve-VxRealRegTarget 'HKCU\System\GameConfigStore'
        Assert-True ($t.Hive -eq 'HKU' -and $t.Sub -eq 'S-1-5-21-1-2-3-1001\System\GameConfigStore') 'HKCU -> HKU\<SID>'
        $c = Resolve-VxRealRegTarget 'HKCU\Software\Classes\CLSID\{x}'
        Assert-Equal 'S-1-5-21-1-2-3-1001_Classes\CLSID\{x}' $c.Sub 'Klassen -> HKU\<SID>_Classes'
        Assert-Equal 'HKLM' (Resolve-VxRealRegTarget 'HKLM\SOFTWARE\X').Hive 'HKLM unverändert'
        Assert-Equal 'C:\Users\Kind\AppData\Local\Temp\x' (Expand-VxUserPath '%TEMP%\x') 'TEMP des angemeldeten Benutzers'
        Assert-Equal 'C:\Users\Kind\AppData\Local\D3DSCache' (Expand-VxUserPath '%localappdata%\D3DSCache') 'LOCALAPPDATA (Groß/klein egal)'
        Assert-Equal 'C:\Users\Kind\Start' (Get-VxUserFolder 'startup') 'Autostart-Ordner'
        $r = Invoke-Change 'memory.compression-off' 'apply'
        Assert-True ($r.ok) 'Skript ohne Benutzerdaten läuft'
        Assert-True (Test-VxPerUserScript 'Set-ItemProperty -Path HKCU:\Software\X -Name A -Value 1') 'HKCU-Skript erkannt'
        Assert-True (-not (Test-VxPerUserScript 'Disable-MMAgent -MemoryCompression')) 'Maschinen-Skript nicht betroffen'
        $act = [pscustomobject]@{ type = 'ps'; apply = 'Set-ItemProperty -Path HKCU:\Software\X -Name A -Value 1'; revert = $null; detect = $null }
        $tw = [pscustomobject]@{ id = 'test.per-user'; name = 'x'; actions = @($act) }
        $blocked = $false
        try { $null = Invoke-VxPsAction $null $act $tw 0 'apply' } catch { $blocked = ([string]$_.Exception.Message -match 'anderen Konto') }
        Assert-True $blocked 'Benutzer-Skript im falschen Konto verweigert'
    } finally { $ctx.DesktopUser = $null }
}

Test-Case 'review' 'Kleinkram: BitLocker-Liste, Codepage, Wildcard ohne Leserecht, Baum-Restore, Claude, Wiederherstellungspunkte' {
    $ctx = New-TestContext
    # BitLocker validates loadoptions/debug/nointegritychecks, not the timer values of the catalog
    Assert-True (Test-VxBcdNeedsBitLockerSuspend 'loadoptions') 'loadoptions -> BitLocker pausieren'
    Assert-True (Test-VxBcdNeedsBitLockerSuspend 'nointegritychecks') 'nointegritychecks -> BitLocker pausieren'
    Assert-True (-not (Test-VxBcdNeedsBitLockerSuspend 'disabledynamictick')) 'Timer-Wert ohne BitLocker'
    # code page from the system setting
    $e = ConvertTo-VxCodePageEncoding '65001'
    Assert-True ($null -ne $e -and $e.WebName -eq 'utf-8' -and $e.GetPreamble().Length -eq 0) 'OEMCP 65001 = UTF-8'
    Assert-True ($null -eq (ConvertTo-VxCodePageEncoding 'abc')) 'Unsinn -> Fallback'
    # a '*' level with a subkey only SYSTEM may read
    $cls = 'HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    New-VxSimRegKey ($cls + '\Properties')
    Set-VxRegValue ($cls + '\0000') 'EnableUlps' 'DWord' 1
    $orig = ${function:Get-VxRegValue}
    ${function:Get-VxRegValue} = { param([string]$Path, [string]$Name) if ($Path -match '\\Properties$') { throw (New-Object System.Security.SecurityException 'Der angeforderte Registrierungszugriff ist unzulässig.') }; & $orig $Path $Name }.GetNewClosure()
    try {
        $prof = $ctx.State.profile
        $ctx.State.profile = ConvertTo-VxHashtable (ConvertFrom-VxJsonText (ConvertTo-VxJson $prof))
        $ctx.State.profile.gpus = @(@{ name = 'Radeon'; vendor = 'amd' })
        Assert-True ((Get-Status 'gaming.amd-ulps-off') -ne 'unknown') 'Status nicht unknown'
        $r = Invoke-Change 'gaming.amd-ulps-off' 'apply'
        Assert-True ($r.ok -and $r.status -eq 'applied') ('Anwenden ok: ' + $r.error)
        $null = Get-VxDetweakScan
    } finally { ${function:Get-VxRegValue} = $orig; $ctx.State.profile = Get-VxSimProfile 'desktop' }
    # restoring a deleted key that exists again journals what it overwrites
    $tk = 'HKCU\Software\VeloxFixture\Tree'
    Set-VxRegValue $tk 'A' 'DWord' 1
    $r1 = Invoke-Change 'system.remove-tree' 'apply'
    Set-VxRegValue $tk 'A' 'DWord' 5
    $rr = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $r1.backupId })
    Assert-Equal 1 ([int](Get-VxRegValue $tk 'A').value) 'Baum-Wert zurück'
    $restoreId = @(Get-VxBackupList | Where-Object { $_.kind -eq 'restore' })[0].id
    $doc = Read-VxBackup $restoreId
    Assert-True (@($doc.entries | Where-Object { $_.op -eq 'reg' -and $_.name -eq 'A' -and [int]$_.before.value -eq 5 }).Count -eq 1) 'überschriebener Wert im Journal'
    $null = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $restoreId })
    Assert-Equal 5 ([int](Get-VxRegValue $tk 'A').value) 'Restore selbst rückgängig machbar'
    # Claude: more time, warnings in the digest, laptop-bad / security-off filtered locally
    Assert-True ((Get-VxClaudeTimeoutSec) -ge 600) 'Zeitlimit für effort high'
    Assert-True ((Get-VxCatalogDigest) -match 'latency\.timer-bcd \|.*\| Etwas mehr Stromverbrauch\.') 'Warnung im Digest'
    $lap = Get-VxSimProfile 'laptop'
    $sel = Select-VxClaudePlan @([pscustomobject]@{ id = 'power.ultimate-plan'; reason = 'x' }, [pscustomobject]@{ id = 'gaming.gamedvr-off'; reason = 'y' }) $false $lap
    Assert-Equal @('gaming.gamedvr-off') @($sel.plan | ForEach-Object { $_.id }) 'laptop-bad auf dem Laptop verworfen'
    $ctx.Simulate = $false; $ctx.Windows = $true
    [Environment]::SetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL', 'http://evil.example')
    try { Assert-Equal 'https://api.anthropic.com' (Get-VxClaudeBaseUrl) 'Test-Umleitung im echten Modus ignoriert' }
    finally { [Environment]::SetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL', $null); $ctx.Simulate = $true; $ctx.Windows = $false }
    # boost / autostart / cleanup jobs never add a restore point - only the one baseline before the
    # very first change (whatever job that is)
    $ctx.Sim.rp = @{ next = 1; items = @() }
    $ctx.State.restorePointBaseline = $null
    $ctx.RestorePointTried = $false
    foreach ($case in @('game', 'startup', 'clean')) {
        switch ($case) {
            'game' { $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = 'C:\Games\X\x.exe'; priority = $true }) }
            'startup' { $it = @(Get-VxStartupItems)[0]; if ($null -eq $it) { Initialize-VxSimSeed; $it = @(Get-VxStartupItems)[0] }; $null = Invoke-VxStartupSetJob ([pscustomobject]@{ id = $it.id; enabled = $false }) }
            'clean' { $null = Invoke-VxRunActionJob ([pscustomobject]@{ ids = @('cleanup.temp') }) }
        }
        Assert-Equal 1 @($ctx.Sim.rp.items).Count ("nur der Basis-Punkt nach '{0}'" -f $case)
    }
    Assert-Equal 'created' ([string]$ctx.State.restorePointBaseline.status) 'Basis-Punkt vor der ersten Änderung'
    # core text is read once and reused by job runspaces
    $ctx.CoreSources = @('function Get-VxMarker { 1 }')
    Assert-Equal @('function Get-VxMarker { 1 }') @(Get-VxCoreSources) 'gespeicherter Quelltext'
    $ctx.CoreSources = $null
    Assert-Equal 11 @(Get-VxCoreSources).Count 'einmal gelesen'
    $vx = [IO.File]::ReadAllText((Join-Path $AppRoot 'Velox.ps1'))
    Assert-True ($vx -notmatch 'LiteralPath \$VxRoot -Recurse') 'Unblock nicht rekursiv über den Startordner'
    Assert-True ($vx -notmatch "'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths") 'kein Browser aus HKCU'
}

# ==================================================================== restore points

# A job object like Start-VxJob creates, for running Invoke-VxJobBody in-process.
function New-TestJob([string]$Type, $Params) {
    return [hashtable]::Synchronized(@{
            id = (New-VxRandomHex 8); type = $Type; status = 'running'; progress = 0.0; step = ''
            log = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); nextIndex = 0
            result = $null; error = $null; cancel = $false; lockObj = (New-Object object); params = $Params
            skippable = $false; skip = $false; durationMs = $null; startTicks = [DateTime]::UtcNow.Ticks
        })
}

function Invoke-TestJob([string]$Type, $Params) {
    $job = New-TestJob $Type $Params
    $global:VxJob = $job
    try { Invoke-VxJobBody } finally { $global:VxJob = $null }
    return $job
}

# ==================================================================== ai (KI providers)
# Runs the fake CLI with a clean PATH (fake first) and the given fake mode; restores everything.
function Use-FakeClaude([string]$Mode, [scriptblock]$Body, [switch]$NoCli) {
    $oldPath = [Environment]::GetEnvironmentVariable('PATH')
    $oldCli = [Environment]::GetEnvironmentVariable('VELOX_CLAUDE_CLI')
    $oldMode = [Environment]::GetEnvironmentVariable('VELOX_FAKE_CLAUDE_MODE')
    $oldLog = [Environment]::GetEnvironmentVariable('VELOX_FAKE_CLAUDE_LOG')
    $oldOnly = [Environment]::GetEnvironmentVariable('VELOX_CLAUDE_CLI_ONLY')
    $log = Join-Path (New-TempDir 'fakeclaude') 'calls.jsonl'
    try {
        # only the override and PATH count: a real Claude Code on a developer PC is never used
        [Environment]::SetEnvironmentVariable('VELOX_CLAUDE_CLI_ONLY', '1')
        if ($NoCli) {
            # an empty PATH folder: neither the fake nor a real CLI can be found
            [Environment]::SetEnvironmentVariable('PATH', (New-TempDir 'nopath'))
            [Environment]::SetEnvironmentVariable('VELOX_CLAUDE_CLI', $null)
        } else {
            [Environment]::SetEnvironmentVariable('PATH', ($FakeClaudeDir + [IO.Path]::PathSeparator + $oldPath))
            [Environment]::SetEnvironmentVariable('VELOX_CLAUDE_CLI', $null)
        }
        [Environment]::SetEnvironmentVariable('VELOX_FAKE_CLAUDE_MODE', $Mode)
        [Environment]::SetEnvironmentVariable('VELOX_FAKE_CLAUDE_LOG', $log)
        & $Body $log
    } finally {
        [Environment]::SetEnvironmentVariable('PATH', $oldPath)
        [Environment]::SetEnvironmentVariable('VELOX_CLAUDE_CLI', $oldCli)
        [Environment]::SetEnvironmentVariable('VELOX_FAKE_CLAUDE_MODE', $oldMode)
        [Environment]::SetEnvironmentVariable('VELOX_FAKE_CLAUDE_LOG', $oldLog)
        [Environment]::SetEnvironmentVariable('VELOX_CLAUDE_CLI_ONLY', $oldOnly)
    }
}

function Read-FakeClaudeCalls([string]$Log) {
    if (-not [IO.File]::Exists($Log)) { return @() }
    return @([IO.File]::ReadAllLines($Log, [Text.Encoding]::UTF8) | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}

function Get-AiError([scriptblock]$Body) {
    $msg = ''
    try { $null = & $Body } catch { $msg = $_.Exception.Message }
    return $msg
}

$groqKey = 'gsk_TESTGROQ0123456789abcdefABCDEFxyz'
function New-GroqChat([string]$Content, [string]$Model = 'openai/gpt-oss-120b', [string]$Finish = 'stop') {
    $m = [ordered]@{ id = 'chatcmpl-test'; object = 'chat.completion'; model = $Model
        choices = @([ordered]@{ index = 0; message = [ordered]@{ role = 'assistant'; content = $Content }; finish_reason = $Finish })
        usage = [ordered]@{ prompt_tokens = 3100; completion_tokens = 700; total_tokens = 3800 } }
    return (ConvertTo-Json -InputObject $m -Depth 10 -Compress)
}
$groqModels = '{"object":"list","data":[{"id":"whisper-large-v3","active":true},{"id":"llama-3.1-8b-instant","active":true},{"id":"openai/gpt-oss-20b","active":true},{"id":"openai/gpt-oss-120b","active":true},{"id":"meta-llama/llama-prompt-guard-2-86m","active":true},{"id":"some/new-model","active":true}]}'

Test-Case 'ai' 'Gleiche Regeln für alle Anbieter, kompakte Liste für Groq, ai-Einstellungen' {
    $ctx = New-TestContext
    foreach ($mode in @('full', 'compact')) {
        $r = Get-VxAiRulesText $mode
        foreach ($w in @('ONLY', 'risky', 'laptop-bad', 'X3D', 'simple German', '"du"', 'allowRisky', 'free text')) { Assert-True ($r.Contains($w)) "$mode-Regeln enthalten $w" }
    }
    Assert-Equal (Get-VxAiRulesText 'full') (Get-VxClaudeSystemText) 'Claude-API nutzt dieselben Regeln'
    $prof = $ctx.State.profile
    Set-VxRegValue 'HKCU\System\GameConfigStore' 'GameDVR_Enabled' 'DWord' 0
    $ctx.State.statuses['gaming.gamedvr-off'] = 'applied'
    $d = Get-VxCompactDigest 'gaming' '' $false $prof 9000
    Assert-True ($d.Length -le 9000 -and $d.StartsWith('Candidate tweaks')) 'kompakte Liste in der Größe begrenzt'
    Assert-True (-not ($d -match '(?m)^gaming\.gamedvr-off \|')) 'schon angewendete Tweaks fehlen'
    Assert-True ($d -match '(?m)^gaming\.mmcss-games \|') 'passender Tweak dabei'
    Assert-True (-not ($d -match '\| risky \|')) 'ohne allowRisky keine riskanten'
    $small = Get-VxCompactDigest 'gaming' '' $false $prof 300
    Assert-True ($small.Length -le 300 -or ($small -split "`n").Count -eq 2) 'kleines Budget = kurze Liste'
    $lap = Get-VxSimProfile 'laptop'
    $dl = Get-VxCompactDigest 'gaming' '' $false $lap 20000
    foreach ($line in @($dl -split "`n" | Select-Object -Skip 1)) { Assert-True (-not ($line -match '\|[^|]*laptop-bad[^|]*\|')) ("Laptop ohne laptop-bad: $line") }
    # settings.ai
    Assert-True ((Get-VxSettingsDto).ai.provider -eq '' -and (Get-VxSettingsDto).ai.claudeCode.model -eq 'sonnet' -and (Get-VxSettingsDto).ai.groq.hasKey -eq $false) 'Standard'
    Update-VxSettings ([pscustomobject]@{ ai = [pscustomobject]@{ provider = 'groq'; claudeCode = [pscustomobject]@{ model = 'opus' }; groq = [pscustomobject]@{ model = 'openai/gpt-oss-20b' } } })
    Update-VxSettings ([pscustomobject]@{ ai = [pscustomobject]@{ provider = 'evil'; claudeCode = [pscustomobject]@{ model = 'gpt-9' }; groq = [pscustomobject]@{ model = 'a b; rm -rf' } } })
    $dto = Get-VxSettingsDto
    Assert-True ($dto.ai.provider -eq 'groq' -and $dto.ai.claudeCode.model -eq 'opus' -and $dto.ai.groq.model -eq 'openai/gpt-oss-20b') 'gültige Werte gespeichert, ungültige ignoriert'
    $null = Import-VxSettings
    Assert-True ((Get-VxSettingsDto).ai.claudeCode.model -eq 'opus' -and (Get-VxClaudeCodeModel) -eq 'opus' -and (Get-VxGroqModelSetting) -eq 'openai/gpt-oss-20b') 'nach Neustart noch da'
    # JSON out of model text
    Assert-True ((ConvertFrom-VxAiJsonText "Klar!`n``````json`n{`"plan`":[]}`n``````").PSObject.Properties['plan']) 'JSON aus Code-Block'
    Assert-True ((ConvertFrom-VxAiJsonText 'Text {"plan":[{"id":"x"}]} Ende').plan[0].id -eq 'x') 'JSON mitten im Text'
    Assert-True ($null -eq (ConvertFrom-VxAiJsonText 'kein json')) 'kein JSON -> null'
}

Test-Case 'ai' 'Groq-Key: verschlüsselt/kodiert, Format geprüft, nie im Settings-DTO' {
    $null = New-TestContext
    Assert-True ((Get-AiError { Set-VxGroqKey 'sk-ant-api03-abcdefabcdefabcdefabcdef' }) -match 'gsk_') 'Anthropic-Key als Groq-Key abgelehnt'
    Set-VxGroqKey ('  ' + $groqKey + ' ')
    Assert-True (Test-VxGroqKey) 'hasKey'
    Assert-True (-not ([IO.File]::ReadAllText((Get-VxGroqKeyPath))).Contains($groqKey)) 'nicht im Klartext'
    Assert-Equal $groqKey (Get-VxGroqKey) 'lesbar, getrimmt'
    Assert-True ((Get-VxSettingsDto).ai.groq.hasKey -eq $true -and -not (ConvertTo-VxJson (Get-VxSettingsDto)).Contains('TESTGROQ')) 'DTO: hasKey, kein Key'
    Assert-True (-not (Test-VxClaudeKey)) 'getrennt vom Claude-Key'
    Remove-VxGroqKey
    Assert-True (-not (Test-VxGroqKey)) 'gelöscht'
}

Test-Case 'ai' 'Claude Code: Suche auf PATH, Version und Anmeldestatus ohne Tokens, fehlend, abgemeldet' {
    $null = New-TestContext
    Use-FakeClaude 'ok' {
        param($log)
        $cli = Find-VxClaudeCli
        Assert-True ($null -ne $cli -and [IO.Path]::GetFileName($cli.path) -match '^claude(\.cmd)?$') ('gefunden: ' + $cli.path)
        Assert-True ($cli.path.StartsWith($FakeClaudeDir)) 'die Fake-CLI auf PATH gewinnt'
        $st = Get-VxClaudeCodeStatus
        Assert-True ($st.ready -and $st.installed -and $st.loggedIn -and $st.state -eq 'ready') 'bereit'
        Assert-True ($st.version -eq '2.1.289' -and $st.account -eq 'gamer@example.com' -and $st.subscription -eq 'max') 'Version, Konto, Abo'
        Assert-True ($st.message -match 'angemeldet als gamer@example\.com' -and $st.message -match 'Max') ('Text: ' + $st.message)
        $calls = @(Read-FakeClaudeCalls $log)
        Assert-True ($calls.Count -eq 2 -and ($calls[0].argv -join ' ') -eq '--version' -and ($calls[1].argv -join ' ') -eq 'auth status') 'nur --version und auth status, kein -p'
        Assert-True ($calls[1].env.CLAUDE_CODE_DISABLE_CLAUDE_MDS -eq '1' -and $calls[1].env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -eq '1') 'ohne CLAUDE.md und Telemetrie'
    }
    Use-FakeClaude 'logged-out' {
        $st = Get-VxClaudeCodeStatus
        Assert-True (-not $st.ready -and $st.installed -and $st.state -eq 'logged-out') 'abgemeldet erkannt'
        Assert-True ((@($st.steps) -join ' ') -match 'claude auth login' -and (@($st.steps) -join ' ') -match '/login') 'Anleitung zum Anmelden'
    }
    Use-FakeClaude 'old' {
        $st = Get-VxClaudeCodeStatus
        Assert-True ($st.ready -and $st.authMethod -eq 'unknown') 'alte CLI ohne auth-Befehl: wird probiert'
    }
    Use-FakeClaude 'ok' {
        $st = Get-VxClaudeCodeStatus
        Assert-True (-not $st.installed -and $st.state -eq 'missing' -and -not $st.ready) 'nicht installiert'
        Assert-True ((@($st.steps) -join ' ').Contains('irm https://claude.ai/install.ps1 | iex') -and $st.installCommand -eq 'irm https://claude.ai/install.ps1 | iex') 'Installationsbefehl'
        Assert-True ((Get-AiError { Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' }) }) -match 'nicht installiert.*install\.ps1') 'Analyse ohne CLI -> Anleitung'
    } -NoCli
    # npm shim: "%dp0%\node_modules\...\cli.js" is run with node directly (no cmd.exe quoting)
    $shimDir = New-TempDir 'npmshim'
    [void][IO.Directory]::CreateDirectory((Join-Path $shimDir 'node_modules\@anthropic-ai\claude-code'.Replace('\', [IO.Path]::DirectorySeparatorChar)))
    $js = [IO.Path]::Combine($shimDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    [IO.File]::WriteAllText($js, '//')
    $shim = Join-Path $shimDir 'claude.cmd'
    # the real npm cmd-shim names "%dp0%\node.exe" first (missing unless node sits next to it)
    [IO.File]::WriteAllText($shim, "@ECHO off`r`nSET dp0=%~dp0`r`nIF EXIST `"%dp0%\node.exe`" (`r`n  SET `"_prog=%dp0%\node.exe`"`r`n) ELSE (`r`n  SET `"_prog=node`"`r`n)`r`n`"%_prog%`"  `"%dp0%\node_modules\@anthropic-ai\claude-code\cli.js`" %*`r`n")
    $l = Resolve-VxClaudeCliLaunch $shim
    Assert-True (-not $l.viaCmd -or -not (Get-Command node -ErrorAction SilentlyContinue)) ('npm-Shim über node: ' + $l.file)
    if (-not $l.viaCmd) { Assert-True (@($l.prefix).Count -eq 1 -and ([string]$l.prefix[0]).EndsWith('cli.js')) 'cli.js als erstes Argument' }
}

Test-Case 'ai' 'Claude Code: Analyse über die Fake-CLI (Aufruf, stdin, Schema, Filter, Fallbacks, Fehler)' {
    $ctx = New-TestContext
    Use-FakeClaude 'ok' {
        param($log)
        $r = Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming'; text = 'Ruckler in GTA'; allowRisky = $false })
        Assert-Equal @('gaming.gamedvr-off', 'gaming.mmcss-games') @($r.plan | ForEach-Object { $_.id }) 'gleicher Filter wie bei der API'
        Assert-True ($r.engine -eq 'claude-code' -and $r.provider -eq 'claude-code' -and $r.model -eq 'claude-sonnet-5-5') ('engine/model: ' + $r.model)
        Assert-True (@($r.findings).Count -eq 2 -and $r.findings[0].id -eq 'claude-1' -and $null -eq $r.findings[0].fix -and $r.usage.input_tokens -eq 21000) 'Befunde + usage'
        Assert-True ($r.score -ge 0 -and $r.scoreAfter -ge $r.score) 'Score vom lokalen Advisor'
        $call = @(Read-FakeClaudeCalls $log | Where-Object { $_.argv -contains '-p' })[0]
        $a = @($call.argv)
        $at = { param($f) $i = [array]::IndexOf($a, $f); if ($i -ge 0 -and $i + 1 -lt $a.Count) { return [string]$a[$i + 1] } return $null }
        Assert-True ((& $at '--output-format') -eq 'json' -and (& $at '--model') -eq 'sonnet') 'print mode, json, Modell'
        Assert-True ($a -contains '--tools' -and (& $at '--tools') -eq '' -and (& $at '--setting-sources') -eq '' -and $a -contains '--no-session-persistence') 'keine Tools, keine Settings, keine Sitzung'
        Assert-True (-not ($a -contains '--bare')) 'nie --bare (das würde das Abo-Login abschalten)'
        $schema = (& $at '--json-schema') | ConvertFrom-Json
        Assert-True ($schema.additionalProperties -eq $false -and $null -ne $schema.properties.plan) 'JSON-Schema übergeben'
        Assert-True ($call.systemHasDigest -and $call.systemHead -match 'optimization advisor inside VELOX') 'System-Prompt mit Regeln + Katalog aus Datei'
        Assert-True ([string]$call.stdin -match '"goal":"gaming"' -and [string]$call.stdin -match 'Ruckler in GTA') 'Anfrage über stdin'
        Assert-True ([IO.Path]::GetFileName([string]$call.cwd) -match '^velox-ki-' -and -not [IO.Directory]::Exists([string]$call.cwd)) 'leerer Temp-Ordner, danach gelöscht'
        foreach ($secret in @([Environment]::UserName, [Environment]::MachineName)) {
            if ($secret -and $secret.Length -ge 3) { Assert-True (-not ([string]$call.stdin).Contains($secret)) "kein Benutzer-/Computername ($secret)" }
        }
        $r = Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming'; allowRisky = $true })
        Assert-True (@($r.plan | ForEach-Object { $_.id }) -contains 'security.vbs-off') 'riskant nur mit allowRisky'
    }
    Use-FakeClaude 'text' {
        $r = Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' })
        Assert-Equal 2 @($r.plan).Count 'JSON aus dem Antworttext'
    }
    Use-FakeClaude 'old' {
        param($log)
        $r = Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' })
        Assert-Equal 2 @($r.plan).Count 'alte CLI: einfacher Modus klappt'
        $calls = @(Read-FakeClaudeCalls $log | Where-Object { $_.argv -contains '-p' })
        Assert-True ($calls.Count -eq 2 -and -not (@($calls[1].argv) -contains '--json-schema') -and [string]$calls[1].stdin -match 'ONLY') 'zweiter Aufruf ohne neue Flags, Regeln über stdin'
    }
    Use-FakeClaude 'schema-fail' {
        param($log)
        $r = Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' })
        Assert-True (@($r.plan).Count -eq 2 -and @(Read-FakeClaudeCalls $log | Where-Object { $_.argv -contains '-p' }).Count -eq 2) 'Schema gescheitert -> zweiter Versuch ohne Schema'
    }
    Use-FakeClaude 'logged-out' {
        Assert-True ((Get-AiError { Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' }) }) -match 'nicht angemeldet.*claude auth login') 'abgemeldet -> Anleitung'
    }
    Use-FakeClaude 'limit' {
        Assert-True ((Get-AiError { Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' }) }) -match 'Nutzungslimit') 'Limit erreicht'
    }
    Use-FakeClaude 'slow' {
        function Get-VxClaudeCodeTimeoutSec { return 2 }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $msg = Get-AiError { Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' }) }
        Assert-True ($msg -match 'nicht geantwortet' -and $sw.Elapsed.TotalSeconds -lt 20) ("hartes Zeitlimit ($msg)")
        # "Abbrechen" ends the CLI at once
        $job = New-TestJob 'ai' $null
        $global:VxJob = $job
        $rs = [PowerShell]::Create()
        $null = $rs.AddScript({ param($j) Start-Sleep -Milliseconds 1500; $j.cancel = $true }).AddArgument($job)
        $h = $rs.BeginInvoke()
        try {
            function Get-VxClaudeCodeTimeoutSec { return 60 }
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $msg = Get-AiError { Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming' }) }
            Assert-True ($msg -eq 'VX_CANCELLED' -and $sw.Elapsed.TotalSeconds -lt 15) ("Abbrechen beendet die CLI ($msg, {0:n1} s)" -f $sw.Elapsed.TotalSeconds)
        } finally { $global:VxJob = $null; try { $null = $rs.EndInvoke($h) } catch { $null = $_ }; $rs.Dispose() }
    }
}
Test-Case 'ai' 'Claude Code: Start ohne Adminrechte - Befehlszeile bleibt unter 1024 Zeichen (Schema fällt weg)' {
    $ctx = New-TestContext
    Use-FakeClaude 'ok' {
        param($log)
        # pretend VELOX runs elevated, but start the fake CLI normally (no ShellChild off Windows)
        function Test-VxClaudeShellLaunch { return $true }
        function Initialize-VxShellLauncher { return $false }
        function Get-VxShellCommandLineMax { return 200 }
        $r = Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming'; text = ''; allowRisky = $false })
        Assert-True (@($r.plan).Count -gt 0) 'Analyse klappt ohne Schema'
        $call = @(Read-FakeClaudeCalls $log | Where-Object { $_.argv -contains '-p' })[0]
        Assert-True (-not (@($call.argv) -contains '--json-schema') -and (@($call.argv) -contains '--system-prompt-file')) 'kein --json-schema, Regeln weiter aus der Datei'
    }
    Use-FakeClaude 'ok' {
        param($log)
        function Test-VxClaudeShellLaunch { return $true }
        function Initialize-VxShellLauncher { return $false }
        $null = Invoke-VxAiJob ([pscustomobject]@{ provider = 'claude-code'; goal = 'gaming'; text = ''; allowRisky = $false })
        $call = @(Read-FakeClaudeCalls $log | Where-Object { $_.argv -contains '-p' })[0]
        $cli = Find-VxClaudeCli
        $line = Get-VxClaudeCliLine $cli @($call.argv)
        if ($line.Length -le 1000) { Assert-True (@($call.argv) -contains '--json-schema') 'kurze Befehlszeile: Schema bleibt' }
        Assert-True ($line.Length -le 1024) ('Befehlszeile ' + $line.Length + ' Zeichen')
    }
}

Test-Case 'ai' 'Groq: Mock-API (Modelle, Anfrageform, Filter, 401, 429, 413, Modell weg, Format-Fehler)' {
    $ctx = New-TestContext
    $mock = Start-MockAnthropic
    $oldBase = [Environment]::GetEnvironmentVariable('VELOX_GROQ_BASE_URL')
    [Environment]::SetEnvironmentVariable('VELOX_GROQ_BASE_URL', ($mock.url + '/openai/v1'))
    try {
        $q = $mock.state.queue
        $okText = [IO.File]::ReadAllText((Join-Path $claudeFix 'plan-ok.json'), [Text.Encoding]::UTF8)
        $P = [pscustomobject]@{ provider = 'groq'; goal = 'gaming'; text = 'Ruckler in GTA'; allowRisky = $false }
        Assert-True ((Get-AiError { Invoke-VxAiJob $P }) -match 'Groq-API-Key' -and $mock.state.requests.Count -eq 0) 'ohne Key keine Anfrage'
        Set-VxGroqKey $groqKey
        # 1) automatic model: GET /models, best one (gpt-oss-120b), strict json_schema
        [void]$q.Add(@{ status = 200; body = $groqModels })
        [void]$q.Add(@{ status = 200; body = (New-GroqChat $okText) })
        $r = Invoke-VxAiJob $P
        Assert-Equal @('gaming.gamedvr-off', 'gaming.mmcss-games') @($r.plan | ForEach-Object { $_.id }) 'gleicher Filter'
        Assert-True ($r.engine -eq 'groq' -and $r.model -eq 'openai/gpt-oss-120b' -and $r.findings[0].id -eq 'groq-1' -and $r.usage.input_tokens -eq 3100) 'engine/model/usage'
        $req = $mock.state.requests
        Assert-True ($req[0].path -eq '/openai/v1/models' -and $req[0].headers['authorization'] -eq ('Bearer ' + $groqKey)) 'Modell-Liste mit Bearer-Key'
        Assert-Equal '/openai/v1/chat/completions' $req[1].path 'Chat-Endpunkt'
        $b = $req[1].body | ConvertFrom-Json
        Assert-True ($b.model -eq 'openai/gpt-oss-120b' -and $b.response_format.type -eq 'json_schema' -and $b.response_format.json_schema.strict -eq $true) 'strict json_schema'
        Assert-True ($b.temperature -le 0.3 -and $b.max_completion_tokens -le 3200 -and $b.reasoning_effort -eq 'low') 'niedrige Temperatur, wenig Denk-Tokens'
        Assert-True ($b.messages[0].role -eq 'system' -and $b.messages[0].content -match 'Candidate tweaks' -and $b.messages[0].content -match 'ONLY') 'Regeln + Kandidaten'
        Assert-True ($b.messages[1].content -match 'Ruckler in GTA' -and -not ($b.messages[1].content -match '"applied":')) 'kompakte Anfrage'
        $chars = ([string]$b.messages[0].content).Length + ([string]$b.messages[1].content).Length
        Assert-True ($chars -lt 16000) ("passt ins Gratis-Limit (~{0} Zeichen)" -f $chars)
        # 2) model picked in the settings: no model list, json_object for a model without strict schema
        $ctx.Settings.ai.groq.model = 'llama-3.3-70b-versatile'
        $n0 = $mock.state.requests.Count
        [void]$q.Add(@{ status = 200; body = (New-GroqChat $okText 'llama-3.3-70b-versatile') })
        $r = Invoke-VxAiJob $P
        $b = $mock.state.requests[$n0].body | ConvertFrom-Json
        Assert-True ($mock.state.requests.Count -eq $n0 + 1 -and $b.model -eq 'llama-3.3-70b-versatile' -and $b.response_format.type -eq 'json_object' -and $null -eq $b.PSObject.Properties['reasoning_effort']) 'json_object für Llama'
        # 3) 401
        [void]$q.Add(@{ status = 401; body = '{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}' })
        Assert-True ((Get-AiError { Invoke-VxAiJob $P }) -match 'Groq-API-Key ungültig') '401'
        # 4) 429 with a short retry-after -> one retry
        [void]$q.Add(@{ status = 429; headers = @{ 'retry-after' = '1' }; body = '{"error":{"message":"Rate limit reached for model on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000.","code":"rate_limit_exceeded"}}' })
        [void]$q.Add(@{ status = 200; body = (New-GroqChat $okText 'llama-3.3-70b-versatile') })
        $r = Invoke-VxAiJob $P
        Assert-Equal 2 @($r.plan).Count '429 -> kurz warten, dann klappt es'
        # 5) 429 with a long wait -> German message with the time
        [void]$q.Add(@{ status = 429; headers = @{ 'retry-after' = '300' }; body = '{"error":{"message":"Rate limit reached for requests per day (RPD)","code":"rate_limit_exceeded"}}' })
        Assert-True ((Get-AiError { Invoke-VxAiJob $P }) -match 'Groq-Limit.*5 Minuten') '429 lang -> Wartezeit'
        # 6) 413 request too large -> one retry with a shorter list
        $n0 = $mock.state.requests.Count
        [void]$q.Add(@{ status = 413; body = '{"error":{"message":"Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9100","code":"rate_limit_exceeded"}}' })
        [void]$q.Add(@{ status = 200; body = (New-GroqChat $okText 'llama-3.3-70b-versatile') })
        $r = Invoke-VxAiJob $P
        $l1 = ([string](($mock.state.requests[$n0].body | ConvertFrom-Json).messages[0].content)).Length
        $l2 = ([string](($mock.state.requests[$n0 + 1].body | ConvertFrom-Json).messages[0].content)).Length
        Assert-True (@($r.plan).Count -eq 2 -and $l2 -lt $l1) ("413 -> kürzere Liste ($l1 -> $l2)")
        # 7) model retired -> switch to the best available one
        $n0 = $mock.state.requests.Count
        [void]$q.Add(@{ status = 404; body = '{"error":{"message":"The model `llama-3.3-70b-versatile` has been decommissioned","code":"model_decommissioned"}}' })
        [void]$q.Add(@{ status = 200; body = $groqModels })
        [void]$q.Add(@{ status = 200; body = (New-GroqChat $okText) })
        $r = Invoke-VxAiJob $P
        Assert-True ($r.model -eq 'openai/gpt-oss-120b' -and ($mock.state.requests[$n0 + 2].body | ConvertFrom-Json).model -eq 'openai/gpt-oss-120b') 'stillgelegtes Modell -> bestes verfügbares'
        $ctx.Settings.ai.groq.model = ''
        # 8) json_validate_failed -> json_object
        $n0 = $mock.state.requests.Count
        [void]$q.Add(@{ status = 200; body = $groqModels })
        [void]$q.Add(@{ status = 400; body = '{"error":{"message":"Failed to generate JSON. Please adjust your prompt.","code":"json_validate_failed"}}' })
        [void]$q.Add(@{ status = 200; body = (New-GroqChat $okText) })
        $r = Invoke-VxAiJob $P
        Assert-True (@($r.plan).Count -eq 2 -and ($mock.state.requests[$n0 + 2].body | ConvertFrom-Json).response_format.type -eq 'json_object') 'Format-Fehler -> json_object'
        # 9) garbage twice -> clear error
        [void]$q.Add(@{ status = 200; body = $groqModels })
        [void]$q.Add(@{ status = 200; body = (New-GroqChat 'Das ist kein JSON') })
        [void]$q.Add(@{ status = 200; body = (New-GroqChat 'immer noch nicht') })
        Assert-True ((Get-AiError { Invoke-VxAiJob $P }) -match 'keine gültige Antwort') 'kaputte Antwort'
        # 10) 5xx twice
        [void]$q.Add(@{ status = 200; body = $groqModels })
        [void]$q.Add(@{ status = 503; body = '{}' })
        [void]$q.Add(@{ status = 503; body = '{}' })
        Assert-True ((Get-AiError { Invoke-VxAiJob $P }) -match 'überlastet|nicht erreichbar') '5xx'
    } finally {
        [Environment]::SetEnvironmentVariable('VELOX_GROQ_BASE_URL', $oldBase)
        Stop-MockAnthropic $mock
    }
}

Test-Case 'ai' 'ai-status: alle Anbieter, „Verbindung testen“ kostenlos (Claude: GET /v1/models, Groq: Modell-Liste)' {
    $ctx = New-TestContext
    $mock = Start-MockAnthropic
    $oldA = [Environment]::GetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL')
    $oldG = [Environment]::GetEnvironmentVariable('VELOX_GROQ_BASE_URL')
    [Environment]::SetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL', $mock.url)
    [Environment]::SetEnvironmentVariable('VELOX_GROQ_BASE_URL', ($mock.url + '/openai/v1'))
    try {
        Use-FakeClaude 'ok' {
            $r = Invoke-VxAiStatusJob ([pscustomobject]@{})
            Assert-Equal @('claude-code', 'claude-api', 'groq', 'offline') @($r.providers | ForEach-Object { $_.id }) 'Reihenfolge'
            Assert-True ($r.recommended -eq 'claude-code' -and $r.providers[0].ready -and -not $r.providers[1].ready -and -not $r.providers[2].ready -and $r.providers[3].ready) 'bereit-Status'
            Assert-Equal 0 $mock.state.requests.Count 'ohne Test keine Netzwerk-Anfrage'
        }
        $q = $mock.state.queue
        Set-VxClaudeKey 'sk-ant-api03-MOCKKEY0123456789abcdefABCDEF'
        [void]$q.Add(@{ status = 200; body = '{"data":[{"id":"claude-opus-5-5","type":"model"}],"has_more":false}' })
        $r = Invoke-VxAiStatusJob ([pscustomobject]@{ test = 'claude-api' })
        $api = @($r.providers | Where-Object { $_.id -eq 'claude-api' })[0]
        Assert-True ($api.tested -and $api.ok -and $api.message -match 'klappt') 'Claude-Test ok'
        Assert-True (@($r.providers | Where-Object { $_.id -eq 'claude-code' }).Count -eq 0) 'Claude Code wird beim API-Test nicht gestartet'
        $last = $mock.state.requests[$mock.state.requests.Count - 1]
        Assert-True ($last.path -match '^/v1/models' -and $last.headers['x-api-key'] -match '^sk-ant-' -and -not $last.body) 'GET /v1/models, keine Nachricht'
        [void]$q.Add(@{ status = 401; body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' })
        $api = @((Invoke-VxAiStatusJob ([pscustomobject]@{ test = 'claude-api' })).providers | Where-Object { $_.id -eq 'claude-api' })[0]
        Assert-True (-not $api.ok -and $api.message -match 'ungültig' -and $api.state -eq 'error') 'Claude-Test 401'
        Set-VxGroqKey $groqKey
        [void]$q.Add(@{ status = 200; body = $groqModels })
        $g = @((Invoke-VxAiStatusJob ([pscustomobject]@{ test = 'groq' })).providers | Where-Object { $_.id -eq 'groq' })[0]
        $ids = @($g.models | ForEach-Object { $_.id })
        Assert-True ($g.ok -and $ids[0] -eq 'openai/gpt-oss-120b' -and $g.models[0].recommended -and $g.models[0].strict) ('Groq-Modelle, bestes zuerst: ' + ($ids -join ', '))
        Assert-True (-not ($ids -contains 'whisper-large-v3') -and -not ($ids -contains 'meta-llama/llama-prompt-guard-2-86m') -and $ids -contains 'some/new-model') 'nur Chat-Modelle, neue auch'
        Assert-True ($g.models[0].label -match 'beste Qualität') 'deutsche Beschriftung'
        [void]$q.Add(@{ status = 401; body = '{"error":{"message":"Invalid API Key"}}' })
        $g = @((Invoke-VxAiStatusJob ([pscustomobject]@{ test = 'groq' })).providers | Where-Object { $_.id -eq 'groq' })[0]
        Assert-True (-not $g.ok -and $g.message -match 'ungültig') 'Groq-Test 401'
    } finally {
        [Environment]::SetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL', $oldA)
        [Environment]::SetEnvironmentVariable('VELOX_GROQ_BASE_URL', $oldG)
        Stop-MockAnthropic $mock
    }
}

Test-Case 'ai' 'Job-Runner: ai und ai-status als Job-Typen, offline = Smart-Analyse' {
    $null = New-TestContext
    Assert-True ((Get-VxJobTypes) -contains 'ai' -and (Get-VxJobTypes) -contains 'ai-status' -and -not ((Get-VxMutatingJobTypes) -contains 'ai')) 'Job-Typen'
    $j = Invoke-TestJob 'ai' ([pscustomobject]@{ provider = 'offline'; goal = 'gaming'; text = '' })
    Assert-True ($j.status -eq 'done' -and $j.result.engine -eq 'local' -and @($j.result.plan).Count -gt 0) 'offline -> Smart-Analyse'
    $j = Invoke-TestJob 'ai' ([pscustomobject]@{ provider = 'chatgpt'; goal = 'gaming' })
    Assert-True ($j.status -eq 'error' -and $j.error -match 'Unbekannte KI') 'unbekannter Anbieter'
}


Test-Case 'restorepoint' 'Einstellung restorePoints: Standard first, Umzug von autoRestorePoint, nur gültige Werte' {
    $ctx = New-TestContext
    Assert-Equal 'first' (Get-VxSettingsDto).restorePoints 'Standard'
    $path = Get-VxDataPath 'settings.json'
    [IO.File]::WriteAllText($path, '{"accent":"blue","autoRestorePoint":false}')
    $null = Import-VxSettings
    Assert-Equal 'off' (Get-VxSettingsDto).restorePoints 'aus bleibt aus'
    Assert-Equal $false (Get-VxSettingsDto).autoRestorePoint 'altes Feld für ältere Oberflächen'
    [IO.File]::WriteAllText($path, '{"autoRestorePoint":true}')
    $null = Import-VxSettings
    Assert-Equal 'first' (Get-VxSettingsDto).restorePoints 'an -> nur der erste'
    Update-VxSettings ([pscustomobject]@{ restorePoints = 'presets' })
    Assert-Equal 'presets' (Get-VxSettingsDto).restorePoints 'presets gesetzt'
    Update-VxSettings ([pscustomobject]@{ restorePoints = 'jeden-job' })
    Assert-Equal 'presets' (Get-VxSettingsDto).restorePoints 'Unsinn ignoriert'
    $saved = Read-VxJsonFile $path
    Assert-Equal 'presets' ([string]$saved.restorePoints) 'gespeichert'
    Assert-True ($null -eq $saved.PSObject.Properties['autoRestorePoint']) 'altes Feld wird nicht mehr gespeichert'
    Update-VxSettings ([pscustomobject]@{ autoRestorePoint = $false })
    Assert-Equal 'off' (Get-VxSettingsDto).restorePoints 'alte Oberfläche: aus'
    Update-VxSettings ([pscustomobject]@{ autoRestorePoint = $true })
    Assert-Equal 'first' (Get-VxSettingsDto).restorePoints 'alte Oberfläche: an'
}

Test-Case 'restorepoint' 'Basis-Punkt genau einmal; Einzel-Tweaks, Zurücksetzen, Restore nie; presets höchstens einmal in 24 h' {
    $ctx = New-TestContext
    $ctx.Sim.rp = @{ next = 100; items = @() }
    $count = { @($ctx.Sim.rp.items).Count }
    Assert-True ($null -eq (Get-VxStateDto).restorePointBaseline) 'vorher kein Basis-Punkt'
    $r1 = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('gaming.gamedvr-off'); label = 'Tweaks: 1 aktiviert' }) 'apply'
    Assert-Equal 1 (& $count) 'Basis-Punkt vor der allerersten Änderung'
    $b = (Get-VxStateDto).restorePointBaseline
    Assert-Equal 'created' $b.status 'Status created'
    Assert-Equal 100 ([int]$b.sequence) 'Nummer gemerkt'
    Assert-True ([bool](Read-VxBackup $r1.backupId).restorePoint) 'Journal weiß vom Punkt'
    # a new session (VELOX restarted): the baseline is never repeated
    $ctx.RestorePointTried = $false
    $null = Import-VxState
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('gaming.mmcss-games') }) 'apply'
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('gaming.mmcss-games') }) 'revert'
    $big = @($ctx.Catalog.tweaks | Where-Object { (Get-VxTweakKind $_) -eq 'toggle' } | Select-Object -First 12 | ForEach-Object { [string]$_.id })
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = $big; label = 'Preset: Groß' }) 'apply'
    $null = Invoke-VxRestoreJob ([pscustomobject]@{ backupId = $r1.backupId })
    Assert-Equal 1 (& $count) "Modus 'first': nie wieder einer"
    # 'presets': one before a big preset, but not twice within 24 h, never for small jobs
    Update-VxSettings ([pscustomobject]@{ restorePoints = 'presets' })
    $ctx.State.restorePointLast = (Get-Date).AddDays(-2).ToString('yyyy-MM-ddTHH:mm:ss')
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @($big[0..2]); label = 'Preset: Klein' }) 'apply'
    Assert-Equal 1 (& $count) 'Preset mit weniger als 10 Tweaks: keiner'
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = $big; label = 'Tweaks: 12 aktiviert' }) 'apply'
    Assert-Equal 1 (& $count) 'viele einzelne Schalter: keiner'
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = $big; label = 'Preset: Groß' }) 'apply'
    Assert-Equal 2 (& $count) 'großes Preset: einer'
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = $big; label = 'KI-Plan (Smart-Analyse)' }) 'apply'
    $null = Invoke-VxDetweakJob ([pscustomobject]@{ keys = @($big | ForEach-Object { 'tweak|' + $_ }); commands = @(); thenApply = @() })
    Assert-Equal 2 (& $count) 'höchstens einer pro 24 Stunden'
    $ctx.State.restorePointLast = (Get-Date).AddDays(-2).ToString('yyyy-MM-ddTHH:mm:ss')
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = $big; purpose = 'plan'; label = 'x' }) 'apply'
    Assert-Equal 3 (& $count) 'KI-Plan nach 24 h: einer'
    $ctx.State.restorePointLast = (Get-Date).AddDays(-2).ToString('yyyy-MM-ddTHH:mm:ss')
    $null = Invoke-VxDetweakJob ([pscustomobject]@{ keys = @($big | ForEach-Object { 'tweak|' + $_ }); commands = @(); thenApply = @(); restorePoint = $false })
    Assert-Equal 3 (& $count) 'Detweak mit restorePoint=false: keiner (nie erzwungen)'
    Update-VxSettings ([pscustomobject]@{ restorePoints = 'off' })
    $ctx.State.restorePointBaseline = $null
    $ctx.RestorePointTried = $false
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = $big; label = 'Preset: Groß' }) 'apply'
    Assert-Equal 3 (& $count) "Modus 'off': gar keiner"
}

Test-Case 'restorepoint' 'Alte VELOX-Punkte: der erste wird Basis, Aufräumen löscht den Rest, Windows-Punkte bleiben' {
    $ctx = New-TestContext
    # the Testmodus list: one Windows point + several VELOX points from older versions
    $before = @(Get-VxSimRestorePoints)
    $own = @($before | Where-Object { $_.description -like 'VELOX*' })
    Assert-True ($own.Count -ge 3) 'Testliste enthält alte VELOX-Punkte'
    $null = Invoke-VxApplyJob ([pscustomobject]@{ ids = @('gaming.gamedvr-off') }) 'apply'
    $b = (Get-VxStateDto).restorePointBaseline
    Assert-Equal 'adopted' $b.status 'ältester VELOX-Punkt wird übernommen'
    Assert-Equal ([long]$own[0].sequence) ([long]$b.sequence) 'der älteste'
    Assert-Equal $before.Count @(Get-VxSimRestorePoints).Count 'kein neuer Punkt'
    $list = (Invoke-TestJob 'restorepoint-list' ([pscustomobject]@{})).result
    Assert-Equal ($own.Count - 1) ([int]$list.extra) 'überflüssige gezählt'
    Assert-Equal ([long]$own[0].sequence) ([long]$list.keep.sequence) 'bleibt: der erste'
    # a point the user made on purpose is never "überflüssig"
    $manual = (Invoke-TestJob 'restorepoint' ([pscustomobject]@{ label = 'Manuell' })).result
    Assert-True $manual.ok 'manueller Punkt'
    $list2 = (Invoke-TestJob 'restorepoint-list' ([pscustomobject]@{})).result
    Assert-Equal ($own.Count - 1) ([int]$list2.extra) 'manueller Punkt zählt nicht als überflüssig'
    Assert-Equal 1 @($list2.items | Where-Object { $_.manual }).Count 'als manuell markiert'
    Assert-True (Test-VxManualRestorePoint 'VELOX: VELOX manuell') 'alte Beschriftung erkannt'
    $job = Invoke-TestJob 'restorepoint-clean' ([pscustomobject]@{})
    Assert-Equal 'done' $job.status ('Aufräumen lief: ' + $job.error)
    Assert-Equal ($own.Count - 1) ([int]$job.result.removed) 'gelöscht'
    $after = @(Get-VxSimRestorePoints)
    Assert-Equal 2 @($after | Where-Object { $_.description -like 'VELOX*' }).Count 'der erste VELOX-Punkt und der manuelle bleiben'
    Assert-Equal 1 @($after | Where-Object { $_.description -notlike 'VELOX*' }).Count 'Windows-Punkt unangetastet'
    Assert-True ($null -ne $job.result.durationMs) 'durationMs im Ergebnis'
    $again = (Invoke-TestJob 'restorepoint-clean' ([pscustomobject]@{})).result
    Assert-Equal 0 ([int]$again.removed) 'zweites Mal: nichts mehr zu tun'
}

Test-Case 'restorepoint' 'Hängt nie: Zeitlimit und Überspringen beenden nur diesen Schritt, der Job läuft weiter' {
    $ctx = New-TestContext
    $ctx.Sim.rp = @{ next = 1; items = @() }
    # a restore point that never finishes
    $ctx.SimRestorePointScript = 'Start-Sleep -Seconds 60'
    $ctx.RestorePointTimeoutSec = 2
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $job = Invoke-TestJob 'apply' ([pscustomobject]@{ ids = @('gaming.gamedvr-off'); label = 'Tweaks: 1 aktiviert' })
    Assert-True ($sw.Elapsed.TotalSeconds -lt 15) ('Zeitlimit greift: {0:N1} s' -f $sw.Elapsed.TotalSeconds)
    Assert-Equal 'done' $job.status ('Job fertig: ' + $job.error)
    Assert-True ($job.result.results[0].ok) 'Tweak trotzdem angewendet'
    Assert-True (@($job.log | Where-Object { $_.level -eq 'warn' -and $_.msg -match 'länger als 2 s' }).Count -eq 1) 'Warnung erklärt das Zeitlimit'
    Assert-Equal 'timeout' (Get-VxStateDto).restorePointBaseline.status 'als Zeitüberschreitung vermerkt'
    Assert-Equal $false ([bool]$job.skippable) 'Überspringen-Knopf wieder weg'
    # same session: no second attempt (one wait per start at most)
    $sw.Restart()
    $null = Invoke-TestJob 'apply' ([pscustomobject]@{ ids = @('gaming.mmcss-games') })
    Assert-True ($sw.Elapsed.TotalSeconds -lt 5) 'kein zweiter Versuch in derselben Sitzung'
    # next session: "Überspringen" ends the step at once
    $ctx.RestorePointTried = $false
    $ctx.RestorePointTimeoutSec = 60
    $job2 = New-TestJob 'apply' ([pscustomobject]@{ ids = @('gaming.hags-on') })
    $clicker = [PowerShell]::Create()
    $null = $clicker.AddScript('param($j) for ($i = 0; $i -lt 100 -and -not $j.skippable; $i++) { Start-Sleep -Milliseconds 100 }; Start-Sleep -Milliseconds 300; $j.skip = $true').AddArgument($job2)
    $h = $clicker.BeginInvoke()
    $sw.Restart()
    $global:VxJob = $job2
    try { Invoke-VxJobBody } finally { $global:VxJob = $null; try { $null = $clicker.EndInvoke($h) } catch { $null = $_ }; $clicker.Dispose() }
    Assert-True ($sw.Elapsed.TotalSeconds -lt 15) ('Überspringen beendet sofort: {0:N1} s' -f $sw.Elapsed.TotalSeconds)
    Assert-Equal 'done' $job2.status 'Job lief weiter'
    Assert-Equal 'skipped' (Get-VxStateDto).restorePointBaseline.status 'übersprungen vermerkt'
    Assert-True (Test-VxBaselineSettled) 'übersprungen = erledigt, kein neuer Versuch'
    # a reset command that hangs: own process, timeout, the detweak goes on
    $ctx.SimRestorePointScript = $null
    $ctx.SimCommandScript = 'Start-Sleep -Seconds 60'
    $ctx.CommandTimeoutSec = 2
    $sw.Restart()
    $res = Invoke-VxDetweakJob ([pscustomobject]@{ keys = @(); commands = @('power-defaults'); thenApply = @('gaming.gamedvr-off') })
    Assert-True ($sw.Elapsed.TotalSeconds -lt 15) 'Befehl mit Zeitlimit'
    Assert-Equal 1 ([int]$res.failed) 'als fehlgeschlagen gezählt'
    Assert-True (@($res.errors | Where-Object { $_ -match 'länger als 2 s' }).Count -eq 1) 'mit Erklärung'
    Assert-Equal 1 ([int]$res.applied) 'danach weiter angewendet'
    $ctx.SimCommandScript = 'throw "kaputt"'
    $res2 = Invoke-VxDetweakJob ([pscustomobject]@{ keys = @(); commands = @('power-defaults'); thenApply = @() })
    Assert-True (@($res2.errors | Where-Object { $_ -match 'kaputt' }).Count -eq 1) 'Fehlertext des Befehls kommt an'
    $ctx.SimCommandScript = $null
}

Test-Case 'restorepoint' 'Isolierter Schritt: Ergebnis, Fehlercode, Abbrechen' {
    $null = New-TestContext
    $x = Invoke-VxIsolated -Script '[Console]::Out.WriteLine("VXRESULT " + (ConvertTo-Json -InputObject @{ a = "ä" } -Compress)); return' -TimeoutSec 30
    Assert-True ($x.ok) ('ok: ' + $x.error)
    Assert-Equal 'ä' ([string](Get-VxIsolatedResult $x.output).a) 'Umlaute heil'
    $y = Invoke-VxIsolated -Script 'throw "Fehler XY"' -TimeoutSec 30
    Assert-True (-not $y.ok -and $y.exitCode -eq 1 -and $y.error -match 'Fehler XY') 'Fehler kommt an'
    $job = New-TestJob 'detweak' $null
    $job.cancel = $true
    $global:VxJob = $job
    $cancelled = $false
    try { $null = Invoke-VxIsolated -Script 'Start-Sleep -Seconds 30' -TimeoutSec 60 } catch { $cancelled = ([string]$_.Exception.Message -eq 'VX_CANCELLED') } finally { $global:VxJob = $null }
    Assert-True $cancelled 'Abbrechen beendet den Prozess'
    # the script ran from a temp .ps1 in <dataRoot>\tmp (never -EncodedCommand) that is gone afterwards
    $tmp = Get-VxDataPath 'tmp'
    Assert-True ([IO.Directory]::Exists($tmp) -and @([IO.Directory]::GetFiles($tmp, 'iso-*.ps1')).Count -eq 0) 'Skriptdateien wieder gelöscht'
    $old = Join-Path $tmp 'iso-alt000000.ps1'
    [IO.File]::WriteAllText($old, '#')
    [IO.File]::SetLastWriteTimeUtc($old, [DateTime]::UtcNow.AddDays(-2))
    $z = Invoke-VxIsolated -Script '[Console]::Out.WriteLine("VXRM 7 0"); [Console]::Out.Flush(); Start-Sleep -Seconds 30' -TimeoutSec 3
    Assert-True ($z.timedOut -and (Get-VxRestorePointRemoveCodes $z.output)['7'] -eq 0) ('Ausgabe bis zum Zeitlimit bleibt: ' + $z.output)
    Assert-True (-not [IO.File]::Exists($old)) 'Reste älter als ein Tag werden aufgeräumt'
}

# ==================================================================== speed

Test-Case 'speed' 'Großes Preset im Testmodus: wenig Engine-Overhead pro Tweak, durationMs, Zeiten im Log' {
    $realData = Join-Path $AppRoot 'data'
    if (-not (Test-Path -LiteralPath (Join-Path $realData 'tweaks'))) { Add-Note 'data/tweaks fehlt - übersprungen.'; return }
    $ctx = New-TestContext -DataDir $realData
    $ctx.Sim.rp = @{ next = 1; items = @() }
    $p = @($ctx.Catalog.presets | Sort-Object { @($_.ids).Count } -Descending)[0]
    $ids = @($p.ids | Where-Object { (Get-VxTweakKind (Get-VxTweak $_)) -eq 'toggle' })
    Assert-True ($ids.Count -ge 50) ('großes Preset: {0}' -f $ids.Count)
    $job = Invoke-TestJob 'apply' ([pscustomobject]@{ ids = $ids; label = ('Preset: ' + $p.name) })
    Assert-Equal 'done' $job.status ('lief: ' + $job.error)
    $r = $job.result
    $bad = @($r.results | Where-Object { -not $_.ok -and $_.status -ne 'na' })
    Assert-Equal 0 $bad.Count ('nur nicht anwendbare Tweaks fehlen: ' + (($bad | ForEach-Object { $_.id + ' ' + $_.error }) -join '; '))
    Assert-True ([int]$r.durationMs -gt 0 -and [int]$job.durationMs -ge [int]$r.durationMs) 'durationMs im Ergebnis und am Job'
    $per = [double]$r.timing.perTweakMs
    # pwsh 7 on Linux: ~10-15 ms per tweak in the Testmodus (simulated registry included);
    # the bound leaves room for Windows PowerShell 5.1 and slow CI machines
    Assert-True ($per -lt 80) ('{0} ms je Tweak' -f $per)
    Assert-True ([int]$r.timing.finishMs -lt [math]::Max(1500, [int]$r.timing.tweaksMs / 2)) ('Abschluss {0} ms' -f $r.timing.finishMs)
    Add-Note ('Preset {0}: {1} Tweaks in {2} ms ({3} ms je Tweak, Abschluss {4} ms, Wiederherstellungspunkt {5} ms)' -f $p.id, $ids.Count, $r.durationMs, $per, $r.timing.finishMs, $r.timing.restorePointMs)
    $log = [IO.File]::ReadAllText([IO.Path]::Combine($ctx.LogDir, ('velox-' + (Get-Date).ToString('yyyyMMdd') + '.log')))
    Assert-True ($log -match ('apply ' + [regex]::Escape($ids[0]) + ': \d+ ms')) 'Zeit pro Tweak in der Logdatei'
    Assert-True ($log -match 'Tweaks in \d+ ms \(Vorbereitung') 'Zusammenfassung in der Logdatei'
    Assert-True (-not [IO.File]::Exists([IO.Path]::Combine($ctx.BackupDir, $r.backupId + '.journal'))) 'Journal-Datei geschlossen und abgeschlossen'
    $okIds = @($r.results | Where-Object { $_.ok } | ForEach-Object { $_.id })
    $inJournal = @((Read-VxBackup $r.backupId).entries | ForEach-Object { [string]$_.tweakId } | Select-Object -Unique)
    Assert-True (@($inJournal | Where-Object { $okIds -notcontains $_ }).Count -eq 0 -and $inJournal.Count -ge [int]($okIds.Count * 0.9)) ('Journal vollständig: {0} von {1}' -f $inJournal.Count, $okIds.Count)
}

Test-Case 'speed' 'Journal: offene Datei lesbar, Eintrag sofort auf der Platte' {
    $ctx = New-TestContext
    $global:VxOpenJournals = New-Object System.Collections.ArrayList
    try {
        $J = New-VxJournal 'apply' 'offen'
        Add-VxJournalEntry $J ([ordered]@{ op = 'reg'; path = 'HKCU\Software\X'; name = 'a'; before = @{ exists = $false }; after = @{ exists = $true; kind = 'DWord'; value = 1 }; tweakId = 'gaming.gamedvr-off' })
        Assert-True ($null -ne $J.stream) 'Datei bleibt offen'
        $b = Read-VxBackup $J.id
        Assert-Equal 1 @($b.entries).Count 'unterbrochenes Journal lesbar, während es offen ist'
        Assert-Equal 1 $global:VxOpenJournals.Count 'als offen gemerkt'
        $id = Complete-VxJournal $J
        Assert-True ($null -eq $J.stream -and $global:VxOpenJournals.Count -eq 0) 'geschlossen'
        Assert-True ([IO.File]::Exists([IO.Path]::Combine($ctx.BackupDir, $id + '.json'))) 'fertige Sicherung'
    } finally { $global:VxOpenJournals = $null }
}

Test-Case 'speed' 'Hintergrund-Arbeiter: einmal geladen, wiederverwendet, nach Absturz neu' {
    $ctx = New-TestContext
    $ctx.CoreSources = $null
    $global:VxWorker = $null
    try {
        $run = {
            param([string]$Type)
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $j = Start-VxJob $Type ([pscustomobject]@{})
            while ($ctx.Jobs[$j.jobId].status -eq 'running' -and $sw.Elapsed.TotalSeconds -lt 60) { Start-Sleep -Milliseconds 10 }
            for ($i = 0; $i -lt 100 -and (Get-VxJobHandles).ContainsKey($j.jobId); $i++) { Update-VxJobs; Start-Sleep -Milliseconds 10 }
            return @{ job = $ctx.Jobs[$j.jobId]; ms = $sw.ElapsedMilliseconds }
        }
        $a = & $run 'startup-list'
        Assert-Equal 'done' $a.job.status ('erster Job: ' + $a.job.error)
        $w1 = $global:VxWorker
        Assert-True ($null -ne $w1) 'Arbeiter bleibt'
        $b = & $run 'startup-list'
        Assert-Equal 'done' $b.job.status 'zweiter Job'
        Assert-True ([object]::ReferenceEquals($w1.rs, $global:VxWorker.rs)) 'derselbe Runspace'
        Assert-True ($b.ms -le [math]::Max(1000, $a.ms)) ('wiederverwendet ist nicht langsamer: {0} ms / {1} ms' -f $b.ms, $a.ms)
        # crashed / closed runspace -> the next job gets a fresh one
        $w1.rs.Close()
        $c = & $run 'startup-list'
        Assert-Equal 'done' $c.job.status 'nach Absturz läuft der nächste Job'
        Assert-True (-not [object]::ReferenceEquals($w1.rs, $global:VxWorker.rs)) 'neuer Runspace'
        $dto = Get-VxJobDto $c.job 0
        Assert-True ($dto.Contains('skippable') -and $dto.Contains('durationMs')) 'Job-DTO mit skippable und durationMs'
        # startup pre-warm: a job that arrives while the worker still loads the core waits for it
        # (same runspace, the core is loaded once) instead of loading everything a second time
        Stop-VxAllJobs 5
        $global:VxWorker = $null
        $ctx.TestWarmupDelayMs = 700
        Start-VxWorkerWarmup
        $ww = $global:VxWorker
        Assert-True ($null -ne $ww -and $ww.warming) 'Vorwärmen läuft'
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $d = Start-VxJob 'startup-list' ([pscustomobject]@{})
        $wasDeferred = [bool](Get-VxJobHandles)[$d.jobId].deferred
        Assert-True $wasDeferred 'Job wartet auf den Arbeiter, der noch lädt'
        while ((Get-VxJobHandles).ContainsKey($d.jobId) -and $sw.Elapsed.TotalSeconds -lt 60) { Update-VxJobs; Start-Sleep -Milliseconds 20 }
        Assert-Equal 'done' $ctx.Jobs[$d.jobId].status ('Job hinter dem Vorwärmen: ' + $ctx.Jobs[$d.jobId].error)
        Assert-True ([object]::ReferenceEquals($ww.rs, $global:VxWorker.rs)) 'derselbe vorgewärmte Runspace'
        Assert-True ($null -ne $ww.warmed -and -not $ww.warming) 'Vorwärmen abgeschlossen'
        Add-Note ('Job hinter dem Vorwärmen: {0} ms (wartete: {1})' -f $sw.ElapsedMilliseconds, $wasDeferred)
        # a queued job can be cancelled before it starts
        $global:VxWorker = $null
        Start-VxWorkerWarmup
        $e = Start-VxJob 'startup-list' ([pscustomobject]@{})
        Assert-True ([bool](Get-VxJobHandles)[$e.jobId].deferred) 'zweiter Job wartet'
        $null = Stop-VxJob $e.jobId
        Update-VxJobs
        Assert-Equal 'cancelled' $ctx.Jobs[$e.jobId].status 'wartender Job abgebrochen'
        Assert-True (-not (Test-VxBusy)) 'danach nicht mehr beschäftigt'
    } finally { $ctx.TestWarmupDelayMs = 0; Stop-VxAllJobs 5; $global:VxWorker = $null }
}

Test-Case 'speed' 'powercfg: eine Liste pro Schema statt ein Aufruf pro Einstellung (Sprache egal)' {
    $null = New-TestContext
    $en = @"
Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  GUID Alias: SCHEME_BALANCED
  Subgroup GUID: 54533251-82be-4824-96c1-47b60b740d00  (Processor power management)
    GUID Alias: SUB_PROCESSOR
    Power Setting GUID: be337238-0d82-4146-a960-4f3749d470c7  (Processor performance boost mode)
      GUID Alias: PERFBOOSTMODE
      Possible Setting Index: 000
      Possible Setting Friendly Name: Disabled
    Current AC Power Setting Index: 0x00000002
    Current DC Power Setting Index: 0x00000001

    Power Setting GUID: 893dee8e-2bef-41e0-89c6-b55d0929964c  (Minimum processor state)
      GUID Alias: PROCTHROTTLEMIN
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0x00000064
      Possible Settings increment: 0x00000001
      Possible Settings units: %
    Current AC Power Setting Index: 0x00000064
    Current DC Power Setting Index: 0x00000005
  Subgroup GUID: 0012ee47-9041-4b5d-9b77-535fba8b1442  (Hard disk)
    GUID Alias: SUB_DISK
    Power Setting GUID: 6738e2c4-e8a5-4a42-b16a-e040e769756e  (Turn off hard disk after)
      GUID Alias: DISKIDLE
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0xffffffff
    Current AC Power Setting Index: 0x000004b0
    Current DC Power Setting Index: 0x00000258
"@
    $t = ConvertFrom-VxPowercfgDump $en
    Assert-Equal 2 ([int]$t['sub_processor|perfboostmode'].ac) 'Alias|Alias'
    Assert-Equal 1 ([int]$t['54533251-82be-4824-96c1-47b60b740d00|be337238-0d82-4146-a960-4f3749d470c7'].dc) 'GUID|GUID'
    Assert-Equal 100 ([int]$t['sub_processor|893dee8e-2bef-41e0-89c6-b55d0929964c'].ac) 'Alias|GUID, Grenzen nicht verwechselt'
    Assert-Equal 600 ([int]$t['sub_disk|diskidle'].dc) 'zweite Untergruppe'
    $de = $en.Replace('Power Scheme GUID', 'GUID des Energieschemas').Replace('Subgroup GUID', 'GUID der Untergruppe').Replace('GUID Alias', 'GUID-Alias').Replace('Power Setting GUID', 'GUID der Energieeinstellung').Replace('Current AC Power Setting Index', 'Index der aktuellen Wechselstromeinstellung').Replace('Current DC Power Setting Index', 'Index der aktuellen Gleichstromeinstellung')
    $t2 = ConvertFrom-VxPowercfgDump $de
    Assert-Equal 5 ([int]$t2['sub_processor|procthrottlemin'].dc) 'deutsche Ausgabe'
}

Test-Case 'detweak' 'Detweak nutzt die letzte Suche, liest nur betroffene Tweaks neu und erzwingt keinen Wiederherstellungspunkt' {
    $ctx = New-TestContext -Seed
    $ctx.Sim.rp = @{ next = 1; items = @() }
    $scan = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    $keys = @($scan.items | Where-Object { $_.source -eq 'detweak' } | ForEach-Object { $_.key })
    Assert-True ($keys.Count -ge 2) 'Fremd-Tweaks gefunden'
    $origScan = ${function:Get-VxDetweakScan}
    $origUpd = ${function:Update-VxStatuses}
    # the closures get their own scope - they report through this hashtable
    $probe = @{ scans = 0; ids = $null; updates = 0 }
    ${function:Get-VxDetweakScan} = { param([double]$ProgressFrom = 0, [double]$ProgressTo = 1) $probe.scans++; & $origScan -ProgressFrom $ProgressFrom -ProgressTo $ProgressTo }.GetNewClosure()
    ${function:Update-VxStatuses} = { param([string[]]$Ids = $null, [double]$ProgressFrom = -1, [double]$ProgressTo = -1) $probe.updates++; $probe.ids = $Ids; & $origUpd -Ids $Ids -ProgressFrom $ProgressFrom -ProgressTo $ProgressTo }.GetNewClosure()
    try {
        $res = Invoke-VxDetweakJob ([pscustomobject]@{ keys = $keys; commands = @(); thenApply = @('gaming.gamedvr-off'); restorePoint = $true })
        Assert-Equal 0 $probe.scans 'keine zweite volle Suche'
        Assert-Equal 1 $probe.updates 'Status einmal gezielt gelesen'
        Assert-True ($null -ne $probe.ids -and @($probe.ids).Count -lt @($ctx.Catalog.tweaks).Count) ('nur betroffene Tweaks neu gelesen: {0}' -f @($probe.ids).Count)
        Assert-True (@($probe.ids) -contains 'gaming.gamedvr-off') 'angewendeter Tweak dabei'
        Assert-Equal $keys.Count ([int]$res.resetValues) 'alles zurückgesetzt'
        Assert-Equal 1 @($ctx.Sim.rp.items).Count 'nur der Basis-Punkt, kein erzwungener'
        # something changed the system since the scan -> a new scan
        $ctx.ChangeGen = [int]$ctx.ChangeGen + 1
        $null = Invoke-VxDetweakJob ([pscustomobject]@{ keys = $keys; commands = @(); thenApply = @() })
        Assert-Equal 1 $probe.scans 'nach einer Änderung wird neu gesucht'
    } finally { ${function:Get-VxDetweakScan} = $origScan; ${function:Update-VxStatuses} = $origUpd }
    $after = Invoke-VxDetweakScanJob ([pscustomobject]@{})
    Assert-Equal 0 @($after.items | Where-Object { $keys -contains $_.key }).Count 'Fremd-Tweaks sind weg'
}

# ==================================================================== games (detection + art)
# The fixture PC tests/fixtures/games/pc (system.json + folders C/ and D/) is what Get-VxGameSystem
# reads off Windows: every launcher source runs for real against it.

function Get-FixtureGames {
    $null = New-TestContext
    $g = Invoke-VxGamesDetectJob ([pscustomobject]@{})
    $by = @{}
    foreach ($x in @($g.games)) { $by[[string]$x.path] = $x }
    return @{ list = @($g.games); byPath = $by }
}
function Find-FixtureGame($Games, [string]$Path) { return $Games.byPath[$Path] }

Test-Case 'games' 'Erkennung: Steam (alle Bibliotheken, appmanifest, Exe-Karte + Heuristik), Epic, GOG, Ubisoft, EA' {
    $r = Get-FixtureGames
    $steam = @($r.list | Where-Object { $_.source -eq 'steam' })
    Assert-Equal 4 $steam.Count ('vier Steam-Spiele aus zwei Bibliotheken: ' + (($steam | ForEach-Object { $_.name }) -join ', '))
    $cs = Find-FixtureGame $r 'C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe'
    Assert-True ($null -ne $cs -and $cs.appid -eq '730' -and $cs.name -eq 'Counter-Strike 2') 'CS2 über die Exe-Karte (appid 730)'
    $gta = Find-FixtureGame $r 'C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V\GTA5.exe'
    Assert-True ($null -ne $gta -and $gta.source -eq 'steam' -and $gta.appid -eq '271590') 'GTA V: GTA5.exe, nicht PlayGTAV.exe'
    Assert-True ($null -eq (Find-FixtureGame $r 'C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V\PlayGTAV.exe')) 'Starter-Exe nicht als eigenes Spiel'
    $nd = Find-FixtureGame $r 'D:\SteamLibrary\steamapps\common\Nebula Drift\NebulaDrift.exe'
    Assert-True ($null -ne $nd -and $nd.appid -eq '999001') 'Heuristik: NebulaDrift.exe statt Crash-Handler, Launcher, vc_redist, unins000'
    $ih = Find-FixtureGame $r 'D:\SteamLibrary\steamapps\common\Iron Harbor\IronHarbor\Binaries\Win64\IronHarbor-Win64-Shipping.exe'
    Assert-True ($null -ne $ih) 'Heuristik: Unreal *-Shipping.exe schlägt den kleinen Starter und CrashReportClient'
    Assert-True (-not @($r.list | Where-Object { $_.name -match 'Half Built|Steamworks|Redist' -or $_.path -match '(?i)dxsetup|unins|crash|vc_redist' }).Count) 'halb installiert, Steamworks Shared und Hilfsprogramme fehlen'
    $fn = Find-FixtureGame $r 'C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe'
    Assert-True ($null -ne $fn -and $fn.source -eq 'epic' -and $fn.appid -eq 'Fortnite') 'Epic: Fortnite aus dem .item-Manifest'
    $lk = Find-FixtureGame $r 'C:\GOG Games\Lantern Keep\LanternKeep.exe'
    Assert-True ($null -ne $lk -and $lk.source -eq 'gog' -and $lk.appid -eq '1207658924' -and $lk.name -eq 'Lantern Keep') 'GOG aus der Registry'
    Assert-True (-not @($r.list | Where-Object { $_.name -eq 'Deinstalliert' }).Count) 'GOG-Eintrag ohne Dateien fehlt'
    $r6 = @($r.list | Where-Object { $_.source -eq 'ubisoft' })[0]
    Assert-True ($null -ne $r6 -and $r6.exe -eq 'RainbowSix.exe' -and $r6.appid -eq '635') 'Ubisoft Connect: Installs\635\InstallDir (mit /)'
    $bf = @($r.list | Where-Object { $_.source -eq 'ea' })
    Assert-True ($bf.Count -eq 1 -and $bf[0].exe -eq 'BF2042.exe' -and $bf[0].name -eq 'Battlefield 2042') 'EA app: Battlefield 2042'
}

Test-Case 'games' 'Erkennung: Battle.net, Riot, Xbox/Game Pass, Rockstar, FiveM/alt:V, Minecraft, Roblox, Publisher, laufende Spiele' {
    $r = Get-FixtureGames
    $ow = Find-FixtureGame $r 'C:\Program Files (x86)\Overwatch\_retail_\Overwatch.exe'
    Assert-True ($null -ne $ow -and $ow.source -eq 'battlenet') 'Battle.net: Overwatch.exe im _retail_-Ordner, nicht der Launcher'
    $va = Find-FixtureGame $r 'C:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe'
    Assert-True ($null -ne $va -and $va.source -eq 'riot' -and $va.name -eq 'VALORANT') 'Riot: VALORANT aus RiotClientInstalls.json'
    Assert-True (-not @($r.list | Where-Object { $_.name -eq 'League of Legends' }).Count) 'Riot: nicht installiertes LoL fehlt'
    $sc = Find-FixtureGame $r 'C:\XboxGames\Sky Courier\Content\SkyCourier.exe'
    Assert-True ($null -ne $sc -and $sc.source -eq 'xbox' -and $sc.appid -eq 'Contoso.SkyCourier' -and $sc.name -eq 'Sky Courier') 'Xbox: ExecutableList ohne gamelaunchhelper'
    $rdr = Find-FixtureGame $r 'C:\Program Files\Rockstar Games\Red Dead Redemption 2\RDR2.exe'
    Assert-True ($null -ne $rdr -and $rdr.source -eq 'rockstar') 'Rockstar: RDR2 aus der Registry'
    Assert-True (-not @($r.list | Where-Object { $_.exe -eq 'Launcher.exe' }).Count) 'Rockstar Launcher ist kein Spiel'
    $five = @($r.list | Where-Object { $_.source -eq 'fivem' } | ForEach-Object { $_.exe })
    foreach ($x in @('FiveM.exe', 'FiveM_b3095_GTAProcess.exe', 'altv.exe')) { Assert-True ($five -contains $x) ('FiveM & Co.: ' + $x) }
    $mc = @($r.list | Where-Object { $_.source -eq 'minecraft' } | ForEach-Object { $_.exe })
    Assert-True ($mc -contains 'MinecraftLauncher.exe' -and $mc -contains 'Minecraft.Windows.exe') 'Minecraft: Java-Launcher und Bedrock (Appx)'
    $rb = @($r.list | Where-Object { $_.source -eq 'roblox' })
    Assert-True ($rb.Count -eq 1 -and $rb[0].exe -eq 'RobloxPlayerBeta.exe') 'Roblox: nur der Player, nicht Studio'
    $ta = Find-FixtureGame $r 'D:\Games\Tank Arena\TankArena.exe'
    Assert-True ($null -ne $ta -and $ta.source -eq 'other') 'Uninstall-Eintrag eines Spiele-Publishers (DisplayIcon mit ",0")'
    Assert-True (-not @($r.list | Where-Object { $_.name -match 'Office Tool|^Steam$' -or $_.exe -match '^(notepad|chrome|steam)\.exe$' }).Count) 'keine Programme, kein Launcher, kein Browser'
    $pq = Find-FixtureGame $r 'D:\Indie\PixelQuest\PixelQuest.exe'
    Assert-True ($null -ne $pq -and $pq.source -eq 'other' -and $pq.running -eq $true -and $pq.name -eq 'Pixel Quest') 'laufendes Vollbild-Spiel (Fenstertitel als Name)'
    $gta = Find-FixtureGame $r 'C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V\GTA5.exe'
    Assert-True ($gta.source -eq 'steam' -and $gta.running -eq $true) 'läuft und schon über Steam bekannt: bleibt Steam, nur als laufend markiert'
    # dedupe: GTA V is in Steam, the Rockstar registry and the process list - once
    Assert-Equal 1 @($r.list | Where-Object { $_.exe -eq 'GTA5.exe' }).Count 'jede Exe genau einmal'
    $paths = @($r.list | ForEach-Object { ([string]$_.path).ToLowerInvariant() })
    Assert-Equal $paths.Count @($paths | Select-Object -Unique).Count 'keine doppelten Pfade'
    $ids = @($r.list | ForEach-Object { [string]$_.id })
    Assert-True (@($ids | Where-Object { $_ -notmatch '^[a-f0-9]{10}$' }).Count -eq 0 -and $ids.Count -eq @($ids | Select-Object -Unique).Count) 'eindeutige ids'
    $okSrc = @('steam', 'epic', 'gog', 'ubisoft', 'ea', 'battlenet', 'riot', 'xbox', 'rockstar', 'fivem', 'minecraft', 'roblox', 'other', 'manual')
    Assert-True (@($r.list | Where-Object { $okSrc -notcontains [string]$_.source }).Count -eq 0) 'nur bekannte Quellen'
    foreach ($x in $r.list) { Assert-True ($null -ne $x.boost -and $null -ne $x.art -and $x.exe -and $x.name) ('Felder vollständig: ' + $x.name) }
}

Test-Case 'games' 'Erkennung: kaputte Quelle, Zeitlimit, Boost bleibt erhalten, Heuristik-Filter' {
    $null = New-TestContext
    $sys = Get-VxGameSystem
    Assert-True ($null -ne $sys -and -not $sys.Real) 'Testmodus liest den Fixture-PC'
    # one source throws: only its games are missing
    function Find-VxEpicGames($Sys, $Found) { throw 'kaputt' }
    $found = Find-VxGames $sys $false
    Assert-True (@($found.list | Where-Object { $_.source -eq 'epic' }).Count -eq 0 -and @($found.list | Where-Object { $_.source -eq 'gog' }).Count -eq 1) 'eine kaputte Quelle kostet nur ihre eigenen Spiele'
    # time is up: the walk stops instead of hanging
    $sys.Deadline = [DateTime]::UtcNow.AddSeconds(-1)
    Assert-Equal $null (Find-VxGameExe $sys 'D:\SteamLibrary\steamapps\common\Nebula Drift' 'Nebula Drift') 'Zeitlimit beendet die Ordnersuche'
    $sys.Deadline = [DateTime]::MaxValue
    Assert-Equal 'D:\SteamLibrary\steamapps\common\Nebula Drift\NebulaDrift.exe' (Find-VxGameExe $sys 'D:\SteamLibrary\steamapps\common\Nebula Drift' 'Nebula Drift') 'ohne Zeitlimit gefunden'
    foreach ($n in @('UnityCrashHandler64.exe', 'unins000.exe', 'VC_redist.x64.exe', 'DXSETUP.exe', 'EasyAntiCheat_Setup.exe', 'BEService_x64.exe', 'CrashReportClient.exe', 'NebulaDriftLauncher.exe', 'start_protected_game.exe', 'gamelaunchhelper.exe')) {
        Assert-True (Test-VxNonGameExe $n) ('kein Spiel: ' + $n)
    }
    foreach ($n in @('NebulaDrift.exe', 'GTA5.exe', 'cs2.exe', 'RainbowSix.exe', 'Overwatch.exe')) { Assert-True (-not (Test-VxNonGameExe $n)) ('Spiel: ' + $n) }
    Assert-Equal 'C:\x\Game.exe' (ConvertTo-VxIconPath '"C:\x\Game.exe",0') 'DisplayIcon mit Anführungszeichen'
    Assert-Equal 'C:\Program Files (x86)\Steam' (ConvertTo-VxWinPath 'c:/program files (x86)//steam/') 'Registry-Pfad normalisiert'
    # a game boosted by hand stays in the list, with its boost
    $ctx = $global:VxCtx
    $null = Invoke-VxGameBoostJob ([pscustomobject]@{ path = 'E:\Spiele\Eigen\eigen.exe'; priority = $true; name = 'Eigenes Spiel' })
    $g = Invoke-VxGamesDetectJob ([pscustomobject]@{})
    $own = @($g.games | Where-Object { $_.path -eq 'E:\Spiele\Eigen\eigen.exe' })[0]
    Assert-True ($null -ne $own -and $own.boost.priority -and $own.art.cover -eq $false -and $own.art.icon -eq $false) 'manuelles Spiel bleibt mit Boost, ohne Bild'
    Assert-True ($ctx.GameScan.games.Count -eq @($g.games).Count) 'Ergebnis für den Advisor gemerkt'
}

Test-Case 'games' 'Bilder: Steam-Cache (alt + neu), GOG-.ico, Xbox-Logos; Art-Datei nur für erkannte ids' {
    $r = Get-FixtureGames
    $lc = Join-Path (Join-Path $TestRoot 'fixtures') (Join-Path 'games' (Join-Path 'pc' (Join-Path 'C' (Join-Path 'Program Files (x86)' (Join-Path 'Steam' (Join-Path 'appcache' 'librarycache'))))))
    $gta = Find-FixtureGame $r 'C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V\GTA5.exe'
    Assert-True ($gta.art.cover -and $gta.art.icon -and $gta.art.shape -eq 'wide' -and $gta.art.v -match '^[a-f0-9]{10}$') 'GTA V: alte flache Namen (271590_header.jpg, _icon.jpg)'
    Assert-Equal (Join-Path $lc '271590_header.jpg') (Get-VxGameArtFile $gta.id 'cover') 'Header als Titelbild'
    $cs = Find-FixtureGame $r 'C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe'
    Assert-Equal (Join-Path (Join-Path $lc '730') 'header.jpg') (Get-VxGameArtFile $cs.id 'cover') 'CS2: neuer Ordner librarycache\730\header.jpg'
    Assert-Equal (Join-Path (Join-Path $lc '730') '8dbc71957312bbd3baea65848b545be9eae2a355.jpg') (Get-VxGameArtFile $cs.id 'icon') 'CS2: Icon mit Hash-Namen'
    $ih = Find-FixtureGame $r 'D:\SteamLibrary\steamapps\common\Iron Harbor\IronHarbor\Binaries\Win64\IronHarbor-Win64-Shipping.exe'
    Assert-True ($ih.art.cover -and -not $ih.art.icon -and $ih.art.shape -eq 'tall') 'nur Hochformat-Kapsel (600x900) -> shape tall'
    $lk = Find-FixtureGame $r 'C:\GOG Games\Lantern Keep\LanternKeep.exe'
    Assert-True (-not $lk.art.cover -and $lk.art.icon) 'GOG: goggame-<id>.ico'
    Assert-True ((Get-VxGameArtFile $lk.id 'icon') -match 'goggame-1207658924\.ico$') 'GOG-Icon-Datei'
    $sc = Find-FixtureGame $r 'C:\XboxGames\Sky Courier\Content\SkyCourier.exe'
    Assert-True ((Get-VxGameArtFile $sc.id 'cover') -match 'Splash\.png$' -and (Get-VxGameArtFile $sc.id 'icon') -match 'Logo150\.png$') 'Xbox: SplashScreenImage + Square150x150Logo'
    $nd = Find-FixtureGame $r 'D:\SteamLibrary\steamapps\common\Nebula Drift\NebulaDrift.exe'
    Assert-True (-not $nd.art.cover -and -not $nd.art.icon -and $nd.art.v -eq '') 'ohne Bild: cover/icon false (UI zeigt Initialen; Windows nimmt das Exe-Icon)'
    Assert-Equal $null (Get-VxGameArtFile $nd.id 'cover') 'kein Bild -> null'
    Assert-Equal $null (Get-VxGameArtFile 'ffffffffff' 'cover') 'unbekannte id -> null'
    Assert-Equal $null (Get-VxGameArtFile '..\..\sys' 'cover') 'Pfad statt id -> null'
    Assert-Equal $null (Get-VxGameArtFile $gta.id 'path') 'unbekannte Bildart -> null'
    Assert-Equal $null (Get-VxExeIconPng 'C:\x\y.exe') 'Exe-Icon nur unter Windows'
    # after a restart (empty in-memory map) the images of the last detection are still served
    $global:VxCtx.GameArt = $null
    Assert-Equal (Join-Path $lc '271590_header.jpg') (Get-VxGameArtFile $gta.id 'cover') 'Bild nach Neustart aus art-map-sim.json'
    Assert-True ((Get-VxGameArtFile $sc.id 'icon') -match 'Logo150\.png$') 'Xbox-Logo nach Neustart'
    [IO.File]::WriteAllText((Get-VxGameArtMapFile), '{ kaputt')
    $global:VxCtx.GameArt = $null
    Assert-Equal $null (Get-VxGameArtFile $gta.id 'cover') 'kaputte Datei: kein Fehler, nur kein Bild'
}

Test-Case 'settings' 'Start-Sound und introSeen: Standard, gespeichert, nur gültige Werte, VELOX.exe-Vertrag' {
    $ctx = New-TestContext
    $dto = Get-VxSettingsDto
    Assert-Equal $true $dto.startSound 'Standard: Ton an'
    Assert-Equal '' $dto.introSeen 'Standard: noch kein Intro gesehen'
    Update-VxSettings ([pscustomobject]@{ startSound = $false; introSeen = '1.2.0' })
    Assert-Equal $false (Get-VxSettingsDto).startSound 'aus gesetzt'
    Assert-Equal '1.2.0' (Get-VxSettingsDto).introSeen 'Version gemerkt'
    Update-VxSettings ([pscustomobject]@{ startSound = 'nein'; introSeen = '../../x' })
    Assert-Equal $false (Get-VxSettingsDto).startSound 'kein bool -> ignoriert'
    Assert-Equal '1.2.0' (Get-VxSettingsDto).introSeen 'keine Version -> ignoriert'
    # the file VELOX.exe reads: top-level JSON boolean "startSound"
    $path = Get-VxDataPath 'settings.json'
    $raw = [IO.File]::ReadAllText($path)
    Assert-True ($raw -match '"startSound"\s*:\s*false') ('settings.json enthält "startSound": false - ' + $raw)
    $saved = Read-VxJsonFile $path
    Assert-True ($saved.startSound -is [bool] -and $saved.startSound -eq $false) 'als bool gespeichert'
    $null = Import-VxSettings
    Assert-Equal $false (Get-VxSettingsDto).startSound 'nach Neustart noch aus'
    Assert-Equal '1.2.0' (Get-VxSettingsDto).introSeen 'nach Neustart noch gemerkt'
    # older settings.json without the keys, and garbage values -> defaults
    [IO.File]::WriteAllText($path, '{"accent":"blue","startSound":"aus","introSeen":5}')
    $null = Import-VxSettings
    Assert-Equal $true (Get-VxSettingsDto).startSound 'kaputter Wert -> Ton an'
    Assert-Equal '' (Get-VxSettingsDto).introSeen 'kaputter Wert -> leer'
    Update-VxSettings ([pscustomobject]@{ startSound = $true })
    Assert-True ([IO.File]::ReadAllText($path) -match '"startSound"\s*:\s*true') 'wieder an gespeichert'
}

Test-Case 'settings' 'bootstrap.mode.hosted nur unter VELOX.exe (-HostPid + -NoBrowser)' {
    $ctx = New-TestContext
    $ctx.Life = New-VxLifecycle
    Assert-Equal $false (Get-VxModeDto).hosted 'Start.bat / Edge-Fenster'
    $ctx.Life.hostWindow = $true
    Assert-Equal $true (Get-VxModeDto).hosted 'im Fenster von VELOX.exe'
    $ctx.Life = $null
    Assert-Equal $false (Get-VxModeDto).hosted 'ohne Lebenszyklus'
}

# ==================================================================== clean (Reinigung + DISM/SFC)

# A fresh fake PC for the Reinigung (deletes really happen in it) on the REAL catalog.
function New-CleanContext([string[]]$Running = @('chrome')) {
    $ctx = New-TestContext -DataDir (Join-Path $AppRoot 'data')
    $fx = Join-Path (New-TempDir 'cleanfx') 'pc'
    $null = & (Join-Path (Join-Path (Join-Path $TestRoot 'fixtures') 'clean') 'New-CleanFixture.ps1') -Root $fx -Running $Running
    $ctx.CleanFixture = $fx
    $ctx.TestToolMs = 150
    return $ctx
}
function Get-FxPath([string]$Rel) { return (Join-Path $global:VxCtx.CleanFixture ($Rel.Replace('\', [IO.Path]::DirectorySeparatorChar))) }

Test-Case 'clean' 'Werkzeug-Ausgabe: \r-Fortschritt, geteilte Zahlen, SFC als UTF-16 (deutsch + englisch), CHKDSK Gesamt' {
    $null = New-TestContext
    $r = New-VxToolReader 'dism' ([Text.Encoding]::UTF8)
    $b = [Text.Encoding]::UTF8.GetBytes("Image Version: 10.0`r`n`r`n`r[=====   2")
    Add-VxToolBytes $r $b $b.Length
    Assert-True ($r.percent -lt 0) 'halbe Zahl ohne % zählt noch nicht'
    $b = [Text.Encoding]::UTF8.GetBytes("7.4%     ]`r[=========== 62.3%    ]")
    Add-VxToolBytes $r $b $b.Length
    Assert-Equal 62.3 $r.percent 'letzter Balken ohne Zeilenende wird gelesen'
    Assert-True (@($r.lines | Where-Object { $_ -match '%' }).Count -eq 0) 'Balken landen nicht in den Ergebniszeilen'
    # sfc.exe: UTF-16LE into the pipe, split in the middle of a character
    $s = New-VxToolReader 'sfc'
    $u = (New-Object System.Text.UnicodeEncoding($false, $false)).GetBytes("`r`nÜberprüfung 45 % abgeschlossen.`rÜberprüfung 100 % abgeschlossen.`r`nDer Windows-Ressourcenschutz hat keine Integritätsverletzungen gefunden.`r`n")
    Add-VxToolBytes $s ([byte[]]$u[0..2]) 3
    Add-VxToolBytes $s ([byte[]]$u[3..($u.Length - 1)]) ($u.Length - 3)
    Assert-Equal 100.0 $s.percent 'SFC-Prozent (deutsch)'
    Assert-True ($s.encoding -is [System.Text.UnicodeEncoding]) 'UTF-16 erkannt'
    $o = Get-VxToolOutcome (Get-VxToolSpec 'sfc-scannow') 0 $s
    Assert-True ($o.ok -and $o.message -match 'Keine beschädigten') ('SFC deutsch: ' + $o.message)
    $e = New-VxToolReader 'sfc'
    $u = (New-Object System.Text.UnicodeEncoding($false, $false)).GetBytes("`rVerification 37% complete.`r`nWindows Resource Protection found corrupt files but was unable to fix some of them.`r`n")
    Add-VxToolBytes $e $u $u.Length
    Assert-Equal 37.0 $e.percent 'SFC-Prozent (englisch)'
    $o = Get-VxToolOutcome (Get-VxToolSpec 'sfc-scannow') 0 $e
    Assert-True (-not $o.ok -and $o.message -match 'DISM') ('SFC englisch, nicht alles repariert: ' + $o.message)
    Assert-Equal 9.0 (Get-VxToolPercent 'chkdsk' 'Progress: 9 of 100 done; Stage: 26%; Total: 9%; ETA: 0:01:00') 'CHKDSK Total'
    Assert-Equal 31.0 (Get-VxToolPercent 'chkdsk' 'Fortschritt: 1 von 9 erledigt; Phase: 80 %; Gesamt: 31 %') 'CHKDSK Gesamt'
    Assert-Equal 42.5 (Get-VxToolPercent 'dism' '[====  42,5 %  ]') 'Komma als Dezimalzeichen'
    # DISM outcomes
    $d = New-VxToolReader 'dism'
    Add-VxToolText $d "Error: 0x800f0806`r`n`r`nThe operation could not be completed due to pending operations.`r`n"
    $o = Get-VxToolOutcome (Get-VxToolSpec 'dism-component-cleanup') -2146498554 $d
    Assert-True (-not $o.ok -and $o.message -match 'Neustart' -and $o.message -match '0x800F0806') ('wartender Neustart: ' + $o.message)
    $h = New-VxToolReader 'dism'
    Add-VxToolText $h "The component store is repairable.`r`nThe operation completed successfully.`r`n"
    $o = Get-VxToolOutcome (Get-VxToolSpec 'dism-scanhealth') 0 $h
    Assert-True (-not $o.ok -and $o.message -match 'RestoreHealth|reparieren') ('ScanHealth: reparierbar: ' + $o.message)
    $o = Get-VxToolOutcome (Get-VxToolSpec 'dism-restorehealth') 3010 (New-VxToolReader 'dism')
    Assert-True ($o.ok -and $o.reboot) '3010 = ok + Neustart'
}

Test-Case 'clean' 'Werkzeug-Prozess: Live-Prozent, Fehlercode, Zeitlimit, Überspringen und Abbrechen beenden den ganzen Prozessbaum' {
    $null = New-TestContext
    $fake = Join-Path (Join-Path (Join-Path $TestRoot 'fixtures') 'clean') 'fake-tool.ps1'
    $job = New-TestJob 'run-action' $null
    $job.live = [hashtable]::Synchronized(@{ percent = -1.0; progress = -1.0; elapsedSec = 0; note = '' })
    $global:VxJob = $job
    try {
        $slot = @{ base = 0.0; span = 1.0; step = 'DISM repariert das Windows-Abbild' }
        $r = Invoke-VxToolProcess $HostExe @('-NoProfile', '-File', $fake, '-Mode', 'dism') 'dism' 60 $slot 600 'DISM' ([Text.Encoding]::UTF8)
        Assert-Equal 0 $r.exitCode 'Code 0'
        Assert-Equal 100.0 $r.reader.percent 'bis 100 % gelesen'
        $o = Get-VxToolOutcome (Get-VxToolSpec 'dism-restorehealth') $r.exitCode $r.reader
        Assert-True $o.ok ('ok: ' + $o.message)
        # exit codes above 255 do not survive a Linux process: 87 here, the HRESULT mapping directly
        $r = Invoke-VxToolProcess $HostExe @('-NoProfile', '-File', $fake, '-Mode', 'dism', '-ExitCode', '87') 'dism' 60 $slot 600 'DISM' ([Text.Encoding]::UTF8)
        $o = Get-VxToolOutcome (Get-VxToolSpec 'dism-restorehealth') $r.exitCode $r.reader
        Assert-True (-not $o.ok -and $o.message -match 'kennt diesen Befehl' -and $o.message -match 'Error: 0x800f081f') ('Fehler mit DISM-Zeile: ' + $o.message)
        $o = Get-VxToolOutcome (Get-VxToolSpec 'dism-restorehealth') -2146498529 $r.reader
        Assert-True ($o.message -match 'Ersatzdateien' -and $o.message -match '0x800F081F') ('0x800F081F: ' + $o.message)
        $r = Invoke-VxToolProcess $HostExe @('-NoProfile', '-File', $fake, '-Mode', 'sfc') 'sfc' 60 $slot 600 'SFC'
        Assert-Equal 100.0 $r.reader.percent 'SFC über die echte Pipe als UTF-16'
        $o = Get-VxToolOutcome (Get-VxToolSpec 'sfc-scannow') $r.exitCode $r.reader
        Assert-True (-not $o.ok -and $o.message -match 'nicht alle') ('SFC: ' + $o.message)
        # timeout: the tool and the process it started are gone afterwards
        $pidFile = Join-Path (New-TempDir 'tool') 'child.pid'
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-VxToolProcess $HostExe @('-NoProfile', '-File', $fake, '-Mode', 'hang', '-PidFile', $pidFile) 'dism' 4 $slot 600 'DISM' ([Text.Encoding]::UTF8)
        Assert-True ($r.timedOut -and $sw.Elapsed.TotalSeconds -lt 20) 'Zeitlimit greift'
        Assert-Equal 10.0 $r.reader.percent 'Prozent bis zum Zeitlimit'
        Assert-True ($job.step -match '10,0 %' -and $job.step -match '0:0\d') ('Schritt mit Prozent und Zeit: ' + $job.step)
        Start-Sleep -Milliseconds 300
        if ([IO.File]::Exists($pidFile)) {
            $cp = [int][IO.File]::ReadAllText($pidFile)
            $alive = $true
            try { $x = [Diagnostics.Process]::GetProcessById($cp); $alive = -not $x.HasExited } catch { $alive = $false }
            # Linux container without an init that reaps: a killed orphan stays as zombie ("Z")
            $stat = "/proc/$cp/stat"
            if ($alive -and [IO.File]::Exists($stat)) { $alive = ([IO.File]::ReadAllText($stat) -notmatch '\) Z ') }
            Assert-True (-not $alive) 'Kindprozess mit beendet'
        }
        # Überspringen
        $job.skippable = $true; $job.skip = $true
        $r = Invoke-VxToolProcess $HostExe @('-NoProfile', '-File', $fake, '-Mode', 'hang') 'dism' 60 $slot 600 'DISM'
        Assert-True ($r.skipped -and $r.ms -lt 15000) 'Überspringen beendet den Schritt'
        $job.skip = $false
        # Abbrechen
        $job.cancel = $true
        $c = $false
        try { $null = Invoke-VxToolProcess $HostExe @('-NoProfile', '-File', $fake, '-Mode', 'hang') 'dism' 60 $slot 600 'DISM' } catch { $c = ([string]$_.Exception.Message -eq 'VX_CANCELLED') }
        Assert-True $c 'Abbrechen wirft VX_CANCELLED'
    } finally { $global:VxJob = $null }
}

Test-Case 'clean' 'Testmodus: DISM/SFC zeigen Live-Fortschritt im Job, Überspringen geht weiter' {
    $ctx = New-TestContext -DataDir (Join-Path $AppRoot 'data')
    $ctx.TestToolMs = 400
    $job = New-TestJob 'run-action' ([pscustomobject]@{ ids = @('repair.dism-restorehealth', 'repair.sfc') })
    $global:VxJob = $job
    $seen = New-Object System.Collections.ArrayList
    try {
        # watch the job from a second runspace like the HTTP server does
        $ps = [PowerShell]::Create()
        $null = $ps.AddScript({ param($j, $out) for ($i = 0; $i -lt 200; $i++) { if ($j.status -ne 'running') { break }; [void]$out.Add([string]$j.step); Start-Sleep -Milliseconds 15 } }).AddArgument($job).AddArgument($seen)
        $h = $ps.BeginInvoke()
        Invoke-VxJobBody
        $null = $ps.EndInvoke($h); $ps.Dispose()
    } finally { $global:VxJob = $null }
    Assert-Equal 'done' $job.status ('Job fertig: ' + $job.error)
    $res = @($job.result.results)
    Assert-True ($res[0].ok -and $res[0].message -match 'SFC') ('DISM: ' + $res[0].message)
    Assert-True ($res[1].ok -and $res[1].message -match 'Keine beschädigten') ('SFC: ' + $res[1].message)
    Assert-True (@($seen | Where-Object { $_ -match 'DISM repariert .* %' }).Count -gt 0) ('DISM-Prozent im Schritt: ' + (($seen | Select-Object -Unique) -join ' | '))
    Assert-True (@($seen | Where-Object { $_ -match 'SFC prüft .* %' }).Count -gt 0) 'SFC-Prozent im Schritt'
    $dto = Get-VxJobDto $job 0
    Assert-True ($null -ne $dto.live -and @($dto.live.done).Count -eq 2) 'live.done im Job-Objekt'
    # skip: the first tool ends, the second runs
    $ctx.TestToolMs = 3000
    $job = New-TestJob 'run-action' ([pscustomobject]@{ ids = @('repair.dism-scanhealth', 'repair.chkdsk-scan') })
    $global:VxJob = $job
    try {
        $ps = [PowerShell]::Create()
        $null = $ps.AddScript({ param($j) for ($i = 0; $i -lt 300; $i++) { if ($j.skippable -and [string]$j.step -match 'DISM') { $j.skip = $true; break }; Start-Sleep -Milliseconds 10 } }).AddArgument($job)
        $h = $ps.BeginInvoke()
        Invoke-VxJobBody
        $null = $ps.EndInvoke($h); $ps.Dispose()
    } finally { $global:VxJob = $null }
    $res = @($job.result.results)
    Assert-True ($res[0].skipped -and $res[0].status -eq 'skipped' -and $res[0].message -match 'Übersprungen') ('DISM übersprungen: ' + $res[0].message)
    Assert-True ($res[1].ok -and -not $res[1].skipped) 'CHKDSK lief danach weiter'
}

Test-Case 'clean' 'Fake-PC: Größen pro Bereich, Allow-List, Browser nur Cache, laufende Apps, gesperrte Dateien, Opt-in' {
    $ctx = New-CleanContext
    $scan = Invoke-VxCleanJob ([pscustomobject]@{})
    $by = @{}; foreach ($i in $scan.items) { $by[$i.id] = $i }
    Assert-Equal 5500 ([long]$by['cleanup.user-temp'].bytes) 'eigener Temp: genaue Bytes'
    Assert-Equal 3 ([int]$by['cleanup.user-temp'].files) 'eigener Temp: Dateien'
    Assert-Equal 1600 ([long]$by['cleanup.browser-edge'].bytes) 'Edge: nur Cache-Ordner aller Profile (ohne Cookies/Verlauf)'
    Assert-Equal 700 ([long]$by['cleanup.inetcache'].bytes) 'INetCache ohne den Outlook-Anhangsordner'
    Assert-Equal 2200 ([long]$by['cleanup.other-users-temp'].bytes) 'andere Konten: ohne das eigene'
    Assert-Equal 5100 ([long]$by['cleanup.recycle-bin'].bytes) 'Papierkorb ohne desktop.ini'
    Assert-Equal 16000 ([long]$by['cleanup.memory-dump'].bytes) 'MEMORY.DMP'
    Assert-Equal 12000 ([long]$by['cleanup.windows-old'].bytes) 'Windows.old gemessen (measure)'
    Assert-True (-not $by['cleanup.browser-brave'].found) 'Brave nicht installiert = nicht gefunden'
    Assert-Equal @('Chrome') @($by['cleanup.browser-chrome'].running) 'Chrome läuft'
    Assert-True ([long]$scan.totalBytes -gt 100000) 'Summe'
    # a catalog path outside the allow-list is never touched
    $evil = [pscustomobject]@{ id = 'cleanup.evil'; name = 'Böse'; kind = 'action'; tier = 'quick'; actions = @([pscustomobject]@{ type = 'clean'; paths = @('%USERPROFILE%\Documents\*', '%WINDIR%\System32\drivers\*') }) }
    $m = Measure-VxCleanTweak $evil
    Assert-Equal 0 ([long]$m.bytes) 'außerhalb der Allow-List wird nicht einmal gemessen'
    $r = Invoke-VxRunAction $evil $null @{}
    Assert-True (-not $r.ok -and $r.message -match 'erlaubter Ordner') ('verweigert: ' + $r.message)
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\Documents\wichtig.docx')) -and [IO.File]::Exists((Get-FxPath 'C\Windows\System32\drivers\keep.sys'))) 'Dokumente und Treiber unberührt'
    # run: locked file stays, Chrome skipped, opt-in refused without confirmation
    $ids = @('cleanup.user-temp', 'cleanup.browser-edge', 'cleanup.browser-chrome', 'cleanup.recycle-bin', 'games.fivem-cache-clean')
    $job = Invoke-TestJob 'run-action' ([pscustomobject]@{ ids = $ids; expect = [pscustomobject]@{ 'cleanup.user-temp' = 3 } })
    Assert-Equal 'done' $job.status ('Job: ' + $job.error)
    $res = @{}; foreach ($x in $job.result.results) { $res[$x.id] = $x }
    Assert-True ($res['cleanup.user-temp'].ok -and $res['cleanup.user-temp'].status -eq 'partial' -and $res['cleanup.user-temp'].locked -eq 1) ('gesperrte Datei gezählt: ' + $res['cleanup.user-temp'].message)
    Assert-Equal 5000 ([long]$res['cleanup.user-temp'].freedBytes) 'freigegeben ohne die gesperrte'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Temp\in-use.tmp'))) 'gesperrte Datei bleibt'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Temp\fresh.tmp')) -and [IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Temp\setup-new\product.msi'))) 'Dateien und Ordner der letzten 24 Stunden bleiben (minAgeHours)'
    Assert-True (-not [IO.Directory]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Temp\setup-1234'))) 'alter, geleerter Ordner wird entfernt'
    Assert-True ($res['cleanup.user-temp'].message -match 'jünger als 24 Std') ('neue Dateien gemeldet: ' + $res['cleanup.user-temp'].message)
    Assert-True ($res['cleanup.browser-chrome'].skipped -and $res['cleanup.browser-chrome'].message -match 'Chrome läuft') 'laufender Browser übersprungen'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Google\Chrome\User Data\Default\Cache\Cache_Data\data_1'))) 'Chrome-Cache unberührt'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Microsoft\Edge\User Data\Default\Cookies'))) 'Cookies bleiben'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Microsoft\Edge\User Data\Default\History'))) 'Verlauf bleibt'
    Assert-True (-not [IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Microsoft\Edge\User Data\Profile 1\Code Cache\js\index'))) 'Edge-Cache des 2. Profils gelöscht'
    Assert-True (-not $res['cleanup.recycle-bin'].ok -and $res['cleanup.recycle-bin'].message -match 'Bestätigung') 'Opt-in ohne Bestätigung abgelehnt'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\$Recycle.Bin\S-1-5-21-0-0-0-1001\$RABC.txt'))) 'Papierkorb unberührt'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\FiveM\FiveM.app\data\cache\game\keep.rpf'))) 'FiveM: keep bleibt'
    Assert-True (-not [IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\FiveM\FiveM.app\data\cache\priv\c.bin'))) 'FiveM-Cache gelöscht'
    Assert-True ([long]$job.result.freedBytes -gt 0 -and $null -ne $job.result.durationMs) 'Summe + Dauer im Ergebnis'
    $live = Get-VxJobDto $job 0
    Assert-Equal 5 @($live.live.done).Count 'jeder Bereich live gemeldet'
    # with the confirmation: recycle bin emptied, desktop.ini stays
    $job = Invoke-TestJob 'run-action' ([pscustomobject]@{ ids = @('cleanup.recycle-bin', 'cleanup.memory-dump'); confirmOptIn = $true })
    Assert-True (@($job.result.results | Where-Object { -not $_.ok }).Count -eq 0) 'mit Bestätigung ok'
    Assert-True (-not [IO.File]::Exists((Get-FxPath 'C\$Recycle.Bin\S-1-5-21-0-0-0-1001\$RABC.txt'))) 'Papierkorb geleert'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\$Recycle.Bin\S-1-5-21-0-0-0-1001\desktop.ini'))) 'desktop.ini bleibt'
    Assert-True (-not [IO.File]::Exists((Get-FxPath 'C\Windows\MEMORY.DMP'))) 'MEMORY.DMP gelöscht'
    # INetCache: Outlook's folder for opened attachments (edits may live only there) stays
    $r = Invoke-VxRunAction (Get-VxTweak 'cleanup.inetcache') $null @{}
    Assert-True ($r.ok -and -not [IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Microsoft\Windows\INetCache\IE\x.dat'))) ('INetCache geleert: ' + $r.message)
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Max\AppData\Local\Microsoft\Windows\INetCache\Content.Outlook\AB12CD34\Angebot.docx'))) 'geöffneter Outlook-Anhang bleibt'
    # the apply path (Invoke-VxTweakChange) never runs an opt-in item
    $ch = Invoke-VxTweakChange (Get-VxTweak 'cleanup.other-users-temp') 'apply' $null
    Assert-True (-not $ch.ok) 'Opt-in nie über apply'
    Assert-True ([IO.File]::Exists((Get-FxPath 'C\Users\Lena\AppData\Local\Temp\other.tmp'))) 'Temp anderer Konten unberührt'
}

Test-Case 'clean' 'Fake-PC: Verknüpfungen in Profil-Platzhaltern werden nie verfolgt, gemeinsame Ordner zählen einmal' {
    $ctx = New-CleanContext -Running @()
    $outside = Join-Path (New-TempDir 'outside') 'secret'
    [void][IO.Directory]::CreateDirectory((Join-Path $outside 'Cache'))
    [IO.File]::WriteAllText((Join-Path (Join-Path $outside 'Cache') 'wichtig.bin'), 'x')
    $ud = Get-FxPath 'C\Users\Max\AppData\Local\Microsoft\Edge\User Data'
    $linkOk = $true
    try { $null = New-Item -ItemType SymbolicLink -Path (Join-Path $ud 'Profile 9') -Target $outside -ErrorAction Stop } catch { $linkOk = $false }
    if (-not $linkOk) { Add-Note 'Symlinks nicht erlaubt - Test übersprungen.'; return }
    $r = Invoke-VxRunAction (Get-VxTweak 'cleanup.browser-edge') $null @{}
    Assert-True $r.ok $r.message
    Assert-True ([IO.File]::Exists((Join-Path (Join-Path $outside 'Cache') 'wichtig.bin'))) 'Ziel der Verknüpfung unberührt'
    # the same root in two items is measured once
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $a = Measure-VxCleanTweak (Get-VxTweak 'cleanup.user-temp') $seen
    $dup = [pscustomobject]@{ id = 'cleanup.dup'; kind = 'action'; actions = @([pscustomobject]@{ type = 'clean'; paths = @('%TEMP%\*') }) }
    $b = Measure-VxCleanTweak $dup $seen
    Assert-True ($a.bytes -gt 0 -and $b.bytes -eq 0) 'doppelter Ordner nur einmal gezählt'
}

Test-Case 'clean' 'Allow-List und Pfadregeln: Validator kennt dieselben Werkzeuge, prüft Platzhalter und Opt-in' {
    $null = New-TestContext
    $vtext = [IO.File]::ReadAllText((Join-Path (Join-Path $AppRoot 'tools') 'Validate-Catalog.ps1'))
    $m = [regex]::Match($vtext, '\$ToolIds = @\(([^)]*)\)')
    $vt = @([regex]::Matches($m.Groups[1].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    Assert-Equal (@(Get-VxToolIds) -join ',') ($vt -join ',') 'gleiche Werkzeug-Liste'
    foreach ($t in @(Get-VxToolIds)) { Assert-True ($null -ne (Get-VxToolSpec $t)) ('Spezifikation für ' + $t) }
    # DISM without /NoRestart asks "Restart now? (Y/N)" - nobody answers that prompt, and VELOX never restarts the PC
    foreach ($t in @(Get-VxToolIds | Where-Object { $_ -like 'dism-*' })) { Assert-True (@((Get-VxToolSpec $t).args) -contains '/NoRestart') ('/NoRestart bei ' + $t) }
    $dir = New-TempDir 'badcat'
    $null = Copy-Item -Path (Join-Path $FixtureData '*') -Destination $dir -Recurse
    $bad = '{ "category": "cleanup", "tweaks": [' +
        '{ "id": "cleanup.a", "name": "A", "desc": "a", "kind": "action", "tier": "quick", "impact": 1, "risk": "safe", "needs": "none", "tags": ["cleanup"], "actions": [ { "type": "tool", "tool": "format-c" } ] },' +
        '{ "id": "cleanup.b", "name": "B", "desc": "b", "kind": "action", "tier": "quick", "impact": 1, "risk": "safe", "needs": "none", "tags": ["cleanup"], "actions": [ { "type": "clean", "paths": ["%LOCALAPPDATA%\\x\\*\\y\\*\\z\\*", "%FOO%\\x\\*", "%USERPROFILE%\\*"], "closeApps": ["chrome.exe"] } ] },' +
        '{ "id": "cleanup.c", "name": "C", "desc": "c", "kind": "action", "tier": "optin", "impact": 1, "risk": "moderate", "needs": "none", "tags": ["cleanup"], "actions": [ { "type": "clean", "paths": ["%TEMP%\\*"] } ] },' +
        '{ "id": "cleanup.d", "name": "D", "desc": "d", "kind": "action", "impact": 1, "risk": "safe", "needs": "none", "tags": ["cleanup"], "actions": [ { "type": "ps", "apply": "$null = 1", "timeoutSec": 5 } ] }' +
        '] }'
    [IO.File]::WriteAllText((Join-Path (Join-Path $dir 'tweaks') 'cleanup.json'), $bad)
    $out = @(& $HostExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Join-Path $AppRoot 'tools') 'Validate-Catalog.ps1') -DataDir $dir 2>&1 | ForEach-Object { [string]$_ })
    $txt = $out -join "`n"
    foreach ($want in @("unknown tool 'format-c'", 'at most one wildcard folder', "unknown token '%FOO%'", 'profile root', 'without .exe', 'opt-in clean items need a warning', 'need a tier', 'timeoutSec')) {
        Assert-True ($txt -match [regex]::Escape($want)) ('Validator meldet: ' + $want)
    }
}


Test-Case 'clean' 'Reparatur-Skripte (ps) laufen isoliert: Zeitlimit statt Hänger, Fehlertext kommt an' {
    $ctx = New-TestContext
    $ctx.Simulate = $false
    try {
        $job = New-TestJob 'run-action' $null
        $global:VxJob = $job
        $t = [pscustomobject]@{ id = 'repair.hang'; name = 'Hängt'; kind = 'action'; actions = @([pscustomobject]@{ type = 'ps'; apply = 'Start-Sleep -Seconds 60'; timeoutSec = 3 }) }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-VxRunAction $t $null @{}
        Assert-True (-not $r.ok -and $r.message -match 'nicht geantwortet' -and $sw.Elapsed.TotalSeconds -lt 30) ('Zeitlimit: ' + $r.message)
        $t2 = [pscustomobject]@{ id = 'repair.fail'; name = 'Fehler'; kind = 'action'; actions = @([pscustomobject]@{ type = 'ps'; apply = "throw 'Dienst fehlt'" }) }
        $r = Invoke-VxRunAction $t2 $null @{}
        Assert-True (-not $r.ok -and $r.message -match 'Dienst fehlt') ('Fehlertext: ' + $r.message)
    } finally { $ctx.Simulate = $true; $global:VxJob = $null }
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
