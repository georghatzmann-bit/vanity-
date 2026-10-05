# VELOX - core/Engine.ps1
# apply / revert / detect per action type, journal (backup) writing, restore, restore points.
# Every change is journalled BEFORE it is made (docs/ARCHITECTURE.md section 8).
# Only function definitions.

# ================================================================== journal

function New-VxJournal([string]$Kind, [string]$Label) {
    $ctx = $global:VxCtx
    $base = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + $Kind
    $id = $base
    $n = 2
    while ([IO.File]::Exists([IO.Path]::Combine($ctx.BackupDir, $id + '.json')) -or [IO.File]::Exists([IO.Path]::Combine($ctx.BackupDir, $id + '.journal'))) {
        $id = $base + '-' + $n
        $n++
    }
    $j = @{
        id = $id; label = $Label; kind = $Kind; created = (Get-VxNowIso); simulate = [bool]$ctx.Simulate
        restorePoint = $false; entries = (New-Object System.Collections.ArrayList)
        file = [IO.Path]::Combine($ctx.BackupDir, $id + '.journal'); headerWritten = $false
    }
    return $j
}

# Appends the entry to the on-disk journal (one JSON line) before the change is made.
function Add-VxJournalEntry($Journal, $Entry) {
    if ($null -eq $Journal) { return }
    $enc = New-Object System.Text.UTF8Encoding($false)
    if (-not $Journal.headerWritten) {
        $hdr = [ordered]@{ id = $Journal.id; label = $Journal.label; kind = $Journal.kind; created = $Journal.created; simulate = $Journal.simulate; restorePoint = $Journal.restorePoint }
        [IO.File]::AppendAllText($Journal.file, (ConvertTo-VxJson $hdr) + "`n", $enc)
        $Journal.headerWritten = $true
    }
    [IO.File]::AppendAllText($Journal.file, (ConvertTo-VxJson $Entry) + "`n", $enc)
    [void]$Journal.entries.Add($Entry)
}

function ConvertTo-VxJournalDoc($Journal) {
    return [ordered]@{
        id = $Journal.id; label = $Journal.label; kind = $Journal.kind; created = $Journal.created
        simulate = [bool]$Journal.simulate; restorePoint = [bool]$Journal.restorePoint
        entries = $Journal.entries.ToArray()
    }
}

# Writes <id>.json and removes the line journal. Returns the backup id, or $null when nothing changed.
function Complete-VxJournal($Journal) {
    if ($null -eq $Journal) { return $null }
    $ctx = $global:VxCtx
    if ($Journal.entries.Count -eq 0) {
        if ([IO.File]::Exists($Journal.file)) { [IO.File]::Delete($Journal.file) }
        return $null
    }
    Write-VxJsonFile -Path ([IO.Path]::Combine($ctx.BackupDir, $Journal.id + '.json')) -InputObject (ConvertTo-VxJournalDoc $Journal)
    if ([IO.File]::Exists($Journal.file)) { [IO.File]::Delete($Journal.file) }
    return $Journal.id
}

function Test-VxBackupId([string]$Id) {
    return ($Id -match '^[0-9]{8}-[0-9]{6}-[a-z]+(-[0-9]+)?$')
}

# Reads a journal (finished .json or an interrupted .journal line file).
function Read-VxBackup([string]$Id) {
    if (-not (Test-VxBackupId $Id)) { return $null }
    $dir = $global:VxCtx.BackupDir
    $json = [IO.Path]::Combine($dir, $Id + '.json')
    if ([IO.File]::Exists($json)) { return (Read-VxJsonFile $json) }
    $lines = [IO.Path]::Combine($dir, $Id + '.journal')
    if ([IO.File]::Exists($lines)) {
        $all = @([IO.File]::ReadAllLines($lines, [Text.Encoding]::UTF8) | Where-Object { $_.Trim() })
        if ($all.Count -eq 0) { return $null }
        $hdr = ConvertFrom-VxJsonText $all[0]
        $entries = New-Object System.Collections.ArrayList
        for ($i = 1; $i -lt $all.Count; $i++) {
            try { [void]$entries.Add((ConvertFrom-VxJsonText $all[$i])) } catch { $null = $_ }
        }
        return [pscustomobject]@{
            id = $hdr.id; label = ([string]$hdr.label + ' (unterbrochen)'); kind = $hdr.kind; created = $hdr.created
            simulate = $hdr.simulate; restorePoint = $hdr.restorePoint; entries = $entries.ToArray()
        }
    }
    return $null
}

function Test-VxEntryRestorable($Entry) {
    $op = [string](Get-VxProp $Entry 'op')
    if ($op -eq 'appx' -or $op -eq 'cmd' -or $op -eq 'clean') { return $false }
    if ((Test-VxProp $Entry 'restorable') -and (Get-VxProp $Entry 'restorable') -eq $false) { return $false }
    return $true
}

function Get-VxBackupList {
    $dir = $global:VxCtx.BackupDir
    $list = New-Object System.Collections.ArrayList
    if (-not [IO.Directory]::Exists($dir)) { return @() }
    $ids = @{}
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)) {
        $ext = $f.Extension.ToLowerInvariant()
        if ($ext -ne '.json' -and $ext -ne '.journal') { continue }
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if (Test-VxBackupId $id) { $ids[$id] = $true }
    }
    foreach ($id in @($ids.Keys | Sort-Object -Descending)) {
        try {
            $b = Read-VxBackup $id
            if ($null -eq $b) { continue }
            $entries = @(Get-VxProp $b 'entries' @())
            $restorable = (@($entries | Where-Object { Test-VxEntryRestorable $_ }).Count -gt 0)
            [void]$list.Add([ordered]@{
                    id = $id; label = [string]$b.label; kind = [string]$b.kind; created = (ConvertTo-VxIsoText $b.created)
                    count = $entries.Count; simulate = [bool](Get-VxProp $b 'simulate' $false); restorable = $restorable
                })
        } catch { Write-VxLog 'warn' "Sicherung $id unlesbar: $($_.Exception.Message)" }
    }
    return $list.ToArray()
}

# ================================================================== journalled primitives
# Each returns $true when something was changed.

function Get-VxRegSnapshot([string]$Path, [string]$Name) {
    $v = Get-VxRegValue $Path $Name
    if (-not $v.exists) { return [ordered]@{ exists = $false; kind = $null; value = $null } }
    return [ordered]@{ exists = $true; kind = $v.kind; value = $v.value }
}

# Sets a registry value ($Value $null = delete the value).
function Set-VxRegJ($J, [string]$Path, [string]$Name, [string]$Kind, $Value, [string]$TweakId = $null) {
    $before = Get-VxRegSnapshot $Path $Name
    if ($null -eq $Value) {
        if (-not $before.exists) { return $false }
        $after = [ordered]@{ exists = $false; kind = $null; value = $null }
    } else {
        if ($before.exists -and $before.kind -eq $Kind -and (Test-VxRegEqual $Kind $before.value $Value)) { return $false }
        $after = [ordered]@{ exists = $true; kind = $Kind; value = $Value }
    }
    Add-VxJournalEntry $J ([ordered]@{ op = 'reg'; path = $Path; name = $Name; before = $before; after = $after; tweakId = $TweakId })
    if ($null -eq $Value) { Remove-VxRegValue $Path $Name } else { Set-VxRegValue $Path $Name $Kind $Value }
    return $true
}

# Creates or deletes a key. Deleting exports the whole tree into the journal first.
function Set-VxRegKeyJ($J, [string]$Path, [bool]$Present, [string]$TweakId = $null, $Tree = $null) {
    $exists = Test-VxRegKey $Path
    if ($exists -eq $Present) {
        if ($Present -and $null -ne $Tree) { Import-VxRegTree $Tree }
        return $false
    }
    if ($Present) {
        Add-VxJournalEntry $J ([ordered]@{ op = 'regkey'; path = $Path; before = $false; after = $true; tree = $null; tweakId = $TweakId })
        if ($null -ne $Tree) { Import-VxRegTree $Tree } else { New-VxRegKey $Path }
    } else {
        $export = Export-VxRegTree $Path
        Add-VxJournalEntry $J ([ordered]@{ op = 'regkey'; path = $Path; before = $true; after = $false; tree = $export; tweakId = $TweakId })
        Remove-VxRegKey $Path
    }
    return $true
}

function Set-VxServiceJ($J, [string]$Name, [string]$Start, [bool]$StopNow, [bool]$StartNow, [string]$TweakId = $null) {
    $before = Get-VxServiceStart $Name
    if ($null -eq $before) { return $false }
    if ($before -eq $Start) { return $false }
    Add-VxJournalEntry $J ([ordered]@{ op = 'service'; name = $Name; before = $before; after = $Start; tweakId = $TweakId })
    Set-VxServiceStart $Name $Start $StopNow $StartNow
    return $true
}

function Set-VxTaskJ($J, [string]$Path, [bool]$Enabled, [string]$TweakId = $null) {
    $before = Get-VxTaskState $Path
    if ($null -eq $before) { return $false }
    if ([bool]$before -eq $Enabled) { return $false }
    Add-VxJournalEntry $J ([ordered]@{ op = 'task'; path = $Path; before = [bool]$before; after = $Enabled; tweakId = $TweakId })
    Set-VxTaskState $Path $Enabled
    return $true
}

# $Value $null = /deletevalue
function Set-VxBcdJ($J, [string]$Name, $Value, [string]$TweakId = $null) {
    $before = Get-VxBcdValue $Name
    if ($null -eq $Value) {
        if ($null -eq $before) { return $false }
    } elseif (Test-VxBcdEqual $before $Value) { return $false }
    Add-VxJournalEntry $J ([ordered]@{ op = 'bcd'; name = $Name; before = $before; after = $Value; tweakId = $TweakId })
    if ($null -eq $Value) { Remove-VxBcdValue $Name } else { Set-VxBcdValue $Name ([string]$Value) }
    return $true
}

function Set-VxPlanJ($J, [string]$Guid, [string]$TweakId = $null) {
    $before = (Get-VxActivePlan).guid
    if ($before -eq $Guid.ToLowerInvariant()) { return $false }
    Add-VxJournalEntry $J ([ordered]@{ op = 'powerplan'; before = $before; after = $Guid.ToLowerInvariant(); tweakId = $TweakId })
    Set-VxActivePlanGuid $Guid
    return $true
}

function Set-VxPowerSettingJ($J, [string]$Subgroup, [string]$Setting, $Ac, $Dc, $Default, [string]$TweakId = $null) {
    $before = Get-VxPowerSetting $Subgroup $Setting $Default
    if ($null -eq $before) { throw 'Diese Energieoption gibt es auf diesem PC nicht.' }
    $sameAc = ($null -eq $Ac -or [long]$before.ac -eq [long]$Ac)
    $sameDc = ($null -eq $Dc -or ($null -ne $before.dc -and [long]$before.dc -eq [long]$Dc))
    if ($sameAc -and $sameDc) { return $false }
    $afterDc = $Dc
    if ($null -eq $afterDc) { $afterDc = $before.dc }
    $afterAc = $Ac
    if ($null -eq $afterAc) { $afterAc = $before.ac }
    Add-VxJournalEntry $J ([ordered]@{
            op = 'powersetting'; subgroup = $Subgroup; setting = $Setting
            before = [ordered]@{ ac = $before.ac; dc = $before.dc }; after = [ordered]@{ ac = $afterAc; dc = $afterDc }; tweakId = $TweakId
        })
    Set-VxPowerSetting $Subgroup $Setting $Ac $Dc
    return $true
}

function Set-VxFeatureJ($J, [string]$Name, [bool]$Enabled, [string]$TweakId = $null) {
    $before = Get-VxFeatureState $Name
    if ($null -eq $before) { return $false }
    if ([bool]$before -eq $Enabled) { return $false }
    Add-VxJournalEntry $J ([ordered]@{ op = 'feature'; name = $Name; before = [bool]$before; after = $Enabled; tweakId = $TweakId })
    Set-VxFeatureState $Name $Enabled
    return $true
}

# ================================================================== ps scripts

function Invoke-VxPsSource([string]$Source) {
    $sb = [scriptblock]::Create($Source)
    return @(& $sb)
}

function Get-VxPsKey($Tweak, [int]$Index) { return ([string]$Tweak.id + '#' + $Index) }

function Invoke-VxPsAction($J, $Action, $Tweak, [int]$Index, [string]$Mode) {
    $src = [string](Get-VxProp $Action $Mode)
    if ([string]::IsNullOrWhiteSpace($src)) {
        if ($Mode -eq 'revert') { throw 'Für diesen Tweak gibt es kein Zurücksetzen.' }
        return $false
    }
    Add-VxJournalEntry $J ([ordered]@{ op = 'ps'; tweakId = [string]$Tweak.id; index = $Index; mode = $Mode })
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.ps -is [hashtable])) { $ctx.Sim.ps = @{} }
        $flag = 'default'
        if ($Mode -eq 'apply') { $flag = 'applied' }
        $ctx.Sim.ps[(Get-VxPsKey $Tweak $Index)] = $flag
        Write-VxLog 'info' ("[Testmodus] Skript von '{0}' ({1}) nur vermerkt" -f $Tweak.id, $Mode)
        return $true
    }
    $null = Invoke-VxPsSource $src
    return $true
}

function Get-VxPsState($Action, $Tweak, [int]$Index) {
    $ctx = $global:VxCtx
    if ($ctx.Simulate) {
        if (-not ($ctx.Sim.ps -is [hashtable])) { $ctx.Sim.ps = @{} }
        $k = Get-VxPsKey $Tweak $Index
        if ($ctx.Sim.ps.ContainsKey($k)) { return $ctx.Sim.ps[$k] }
        if (-not $ctx.Windows) { return 'default' }
    }
    $src = [string](Get-VxProp $Action 'detect')
    if ([string]::IsNullOrWhiteSpace($src)) { return 'unknown' }
    $out = @(Invoke-VxPsSource $src)
    if ($out.Count -eq 0) { return 'unknown' }
    $last = $out[$out.Count - 1]
    if ($last -is [bool]) { if ($last) { return 'applied' } return 'default' }
    return 'unknown'
}

# ================================================================== detect

# Returns one state per target: 'applied','default','other','na','unknown'.
function Get-VxActionState($Action, $Tweak, [int]$Index = 0) {
    $type = [string](Get-VxProp $Action 'type')
    switch ($type) {
        'reg' {
            $targets = @(Resolve-VxRegPattern ([string]$Action.path))
            if ($targets.Count -eq 0) { return 'na' }
            $only = [bool](Get-VxProp $Action 'onlyExisting' $false)
            $def = Get-VxActionDefault $Action
            $kind = [string]$Action.kind
            $out = @()
            foreach ($t in $targets) {
                $cur = Get-VxRegValue $t ([string]$Action.name)
                if (-not $cur.exists) {
                    if ($only) { $out += 'na' } else { $out += 'default' }
                    continue
                }
                if (Test-VxRegEqual $kind $cur.value $Action.value) { $out += 'applied' }
                elseif ($null -ne $def -and (Test-VxRegEqual $kind $cur.value $def)) { $out += 'default' }
                else { $out += 'other' }
            }
            return $out
        }
        'regkey' {
            $present = [bool]$Action.present
            $targets = @(Resolve-VxRegPattern ([string]$Action.path))
            if ($targets.Count -eq 0) { if ($present) { return 'default' } return 'applied' }
            $out = @()
            foreach ($t in $targets) {
                if ((Test-VxRegKey $t) -eq $present) { $out += 'applied' } else { $out += 'default' }
            }
            return $out
        }
        'service' {
            $cur = Get-VxServiceStart ([string]$Action.name)
            if ($null -eq $cur) { return 'na' }
            if ($cur -eq [string]$Action.start) { return 'applied' }
            if ($cur -eq [string](Get-VxActionDefault $Action)) { return 'default' }
            return 'other'
        }
        'task' {
            $cur = Get-VxTaskState ([string]$Action.path)
            if ($null -eq $cur) { return 'na' }
            if ([bool]$cur -eq [bool]$Action.enabled) { return 'applied' }
            return 'default'
        }
        'bcd' {
            $cur = Get-VxBcdValue ([string]$Action.name)
            $def = Get-VxProp $Action 'default'
            if ($null -ne $cur -and (Test-VxBcdEqual $cur $Action.value)) { return 'applied' }
            if ($null -eq $cur -and $null -eq $def) { return 'default' }
            if ($null -ne $cur -and $null -ne $def -and (Test-VxBcdEqual $cur $def)) { return 'default' }
            if ($null -eq $cur) { return 'default' }
            return 'other'
        }
        'powerplan' {
            $active = (Get-VxActivePlan).guid
            if ((Get-VxPlanCandidates ([string]$Action.plan)) -contains $active) { return 'applied' }
            $def = [string](Get-VxProp $Action 'default' 'balanced')
            if ((Get-VxPlanCandidates $def) -contains $active) { return 'default' }
            return 'other'
        }
        'powersetting' {
            $def = Get-VxProp $Action 'default'
            $cur = Get-VxPowerSetting ([string]$Action.subgroup) ([string]$Action.setting) $def
            if ($null -eq $cur) { return 'na' }
            $ac = Get-VxProp $Action 'ac'
            $dc = Get-VxProp $Action 'dc'
            $okAc = ($null -eq $ac -or [long]$cur.ac -eq [long]$ac)
            $okDc = ($null -eq $dc -or ($null -ne $cur.dc -and [long]$cur.dc -eq [long]$dc))
            if ($okAc -and $okDc) { return 'applied' }
            if ($null -ne $def) {
                $dac = Get-VxProp $def 'ac'
                $ddc = Get-VxProp $def 'dc'
                $dOkAc = ($null -eq $dac -or [long]$cur.ac -eq [long]$dac)
                $dOkDc = ($null -eq $ddc -or $null -eq $dc -or ($null -ne $cur.dc -and [long]$cur.dc -eq [long]$ddc))
                if ($dOkAc -and $dOkDc) { return 'default' }
            }
            return 'other'
        }
        'feature' {
            $cur = Get-VxFeatureState ([string]$Action.name)
            if ($null -eq $cur) { return 'na' }
            if ([bool]$cur -eq [bool]$Action.enabled) { return 'applied' }
            return 'default'
        }
        'appx' {
            $inst = Test-VxAppxInstalled ([string]$Action.package)
            if ($null -eq $inst) { return 'unknown' }
            if ($inst) { return 'default' }
            return 'applied'
        }
        'ps' { return (Get-VxPsState $Action $Tweak $Index) }
        'clean' { return 'na' }
    }
    return 'unknown'
}

# ================================================================== apply / revert one action

# Returns the number of changes made. Throws (German message) on failure.
function Invoke-VxAction($J, $Action, $Tweak, [int]$Index, [string]$Mode) {
    $type = [string](Get-VxProp $Action 'type')
    $tid = [string]$Tweak.id
    $apply = ($Mode -eq 'apply')
    $changed = 0
    switch ($type) {
        'reg' {
            $only = [bool](Get-VxProp $Action 'onlyExisting' $false)
            $kind = [string]$Action.kind
            $name = [string]$Action.name
            $target = $Action.value
            if (-not $apply) { $target = Get-VxActionDefault $Action }
            foreach ($t in @(Resolve-VxRegPattern ([string]$Action.path))) {
                if ($only -and -not (Get-VxRegValue $t $name).exists) { continue }
                try {
                    if (Set-VxRegJ $J $t $name $kind $target $tid) { $changed++ }
                } catch { throw (Get-VxErrorText $_ ("Registry {0}\{1}" -f $t, $name)) }
            }
        }
        'regkey' {
            $want = [bool]$Action.present
            if (-not $apply) { $want = [bool]$Action.default }
            foreach ($t in @(Resolve-VxRegPattern ([string]$Action.path))) {
                try {
                    if (Set-VxRegKeyJ $J $t $want $tid) { $changed++ }
                } catch { throw (Get-VxErrorText $_ ("Registry-Schlüssel {0}" -f $t)) }
            }
        }
        'service' {
            $name = [string]$Action.name
            if ($apply) {
                $start = [string]$Action.start
                $stop = ($start -eq 'Disabled' -and (Get-VxProp $Action 'stop' $true) -ne $false)
                if (Set-VxServiceJ $J $name $start $stop $false $tid) { $changed++ }
            } else {
                $def = [string](Get-VxActionDefault $Action)
                $startNow = ($def -eq 'Automatic' -or $def -eq 'AutomaticDelayed')
                if (Set-VxServiceJ $J $name $def $false $startNow $tid) { $changed++ }
            }
        }
        'task' {
            $en = [bool]$Action.enabled
            if (-not $apply) { $en = [bool]$Action.default }
            if (Set-VxTaskJ $J ([string]$Action.path) $en $tid) { $changed++ }
        }
        'bcd' {
            $v = $Action.value
            if (-not $apply) { $v = Get-VxProp $Action 'default' }
            if (Set-VxBcdJ $J ([string]$Action.name) $v $tid) { $changed++ }
        }
        'powerplan' {
            $plan = [string]$Action.plan
            if (-not $apply) { $plan = [string](Get-VxProp $Action 'default' 'balanced') }
            $guid = Resolve-VxPlanGuid $plan
            if (Set-VxPlanJ $J $guid $tid) { $changed++ }
        }
        'powersetting' {
            $sub = [string]$Action.subgroup
            $set = [string]$Action.setting
            $def = Get-VxProp $Action 'default'
            $key = ($sub + '|' + $set).ToLowerInvariant()
            $st = $global:VxCtx.State
            if ($apply) {
                $cur = Get-VxPowerSetting $sub $set $def
                if ($null -ne $cur -and -not $st.powersettingBefore.ContainsKey($key)) {
                    $isApplied = ([long]$cur.ac -eq [long]$Action.ac)
                    if (-not $isApplied) { $st.powersettingBefore[$key] = @{ ac = $cur.ac; dc = $cur.dc } }
                }
                if (Set-VxPowerSettingJ $J $sub $set (Get-VxProp $Action 'ac') (Get-VxProp $Action 'dc') $def $tid) { $changed++ }
            } else {
                $ac = Get-VxProp $def 'ac'
                $dc = Get-VxProp $def 'dc'
                if ($st.powersettingBefore.ContainsKey($key)) {
                    $prev = $st.powersettingBefore[$key]
                    $ac = Get-VxProp $prev 'ac'
                    $dc = Get-VxProp $prev 'dc'
                }
                if (Set-VxPowerSettingJ $J $sub $set $ac $dc $def $tid) { $changed++ }
                $st.powersettingBefore.Remove($key)
            }
        }
        'feature' {
            $en = [bool]$Action.enabled
            if (-not $apply) { $en = [bool]$Action.default }
            if (Set-VxFeatureJ $J ([string]$Action.name) $en $tid) { $changed++ }
        }
        'appx' {
            if (-not $apply) { throw 'Entfernte Apps können nur über den Microsoft Store wieder installiert werden.' }
            $pkg = [string]$Action.package
            $inst = Test-VxAppxInstalled $pkg
            if ($inst -ne $false) {
                Add-VxJournalEntry $J ([ordered]@{ op = 'appx'; package = $pkg; restorable = $false; tweakId = $tid })
                Remove-VxAppxPackage $pkg
                $changed++
            }
        }
        'ps' {
            if (Invoke-VxPsAction $J $Action $Tweak $Index $Mode) { $changed++ }
        }
        'clean' { throw 'Reinigungsaktionen werden über "Ausführen" gestartet.' }
        default { throw "Unbekannter Aktionstyp '$type'" }
    }
    return $changed
}

# ================================================================== one tweak

# Applies or reverts one tweak. Returns [ordered]@{ id; ok; status; error; changed }.
function Invoke-VxTweakChange($Tweak, [string]$Mode, $J) {
    $id = [string]$Tweak.id
    $res = [ordered]@{ id = $id; ok = $true; status = $null; error = $null; changed = 0 }
    $kind = Get-VxTweakKind $Tweak
    if ($kind -eq 'action') {
        if ($Mode -ne 'apply') { $res.ok = $false; $res.error = 'Einmal-Aktionen kann man nicht rückgängig machen.'; return $res }
        $r = Invoke-VxRunAction $Tweak $J
        $res.ok = [bool]$r.ok
        if (-not $r.ok) { $res.error = $r.message }
        $res.changed = 1
        return $res
    }
    if ($kind -eq 'remove' -and $Mode -ne 'apply') {
        $res.ok = $false
        $res.error = 'Entfernte Apps können nur über den Microsoft Store wieder installiert werden.'
        $st = Get-VxTweakStatus $Tweak
        if ($null -ne $st) { $res.status = $st.status }
        return $res
    }
    if ($Mode -eq 'apply') {
        $w = Test-VxWhen $Tweak $global:VxCtx.State.profile $true
        if (-not $w.ok) { $res.ok = $false; $res.status = 'na'; $res.error = $w.reason; return $res }
    }
    $actions = @($Tweak.actions)
    $order = @(0..($actions.Count - 1))
    if ($Mode -ne 'apply') { [Array]::Reverse($order) }
    $errors = @()
    if ($actions.Count -gt 0) {
        foreach ($i in $order) {
            try { $res.changed += (Invoke-VxAction $J $actions[$i] $Tweak $i $Mode) }
            catch {
                if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
                $errors += (Get-VxErrorText $_)
            }
        }
    }
    if ($errors.Count -gt 0) { $res.ok = $false; $res.error = ($errors -join ' | ') }
    try {
        $st = Get-VxTweakStatus $Tweak
        if ($null -ne $st) { $res.status = $st.status }
    } catch { $res.status = 'unknown' }
    return $res
}

# ================================================================== restore points

function New-VxRestorePoint([string]$Label, [bool]$Force = $false) {
    $ctx = $global:VxCtx
    if ($ctx.RestorePointDone -and -not $Force) {
        return @{ ok = $true; created = $false; message = 'In dieser Sitzung wurde schon ein Wiederherstellungspunkt erstellt.' }
    }
    $desc = 'VELOX: ' + $Label
    if ($desc.Length -gt 200) { $desc = $desc.Substring(0, 200) }
    if ($ctx.Simulate) {
        $ctx.RestorePointDone = $true
        Write-VxLog 'info' ("[Testmodus] Wiederherstellungspunkt '{0}' wurde nur protokolliert." -f $desc)
        return @{ ok = $true; created = $false; message = 'Testmodus: Der Wiederherstellungspunkt wurde nur simuliert.' }
    }
    Set-VxProgress -Step 'Erstelle Wiederherstellungspunkt (kann bis zu einer Minute dauern) ...'
    $srKey = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'
    $prev = $null
    try { $prev = Get-VxRealRegValue $srKey 'SystemRestorePointCreationFrequency' } catch { $prev = $null }
    $ok = $false
    $msg = ''
    try {
        try { Set-VxRealRegValue $srKey 'SystemRestorePointCreationFrequency' 'DWord' 0 } catch { Write-VxLog 'warn' ('Häufigkeits-Sperre konnte nicht aufgehoben werden: ' + $_.Exception.Message) }
        $drive = $env:SystemDrive
        if (-not $drive) { $drive = 'C:' }
        if (Get-Command -Name 'Enable-ComputerRestore' -ErrorAction SilentlyContinue) {
            try { Enable-ComputerRestore -Drive ($drive + '\') -ErrorAction Stop } catch { Write-VxLog 'warn' ('Computerschutz konnte nicht eingeschaltet werden: ' + $_.Exception.Message) }
        }
        if (Get-Command -Name 'Checkpoint-Computer' -ErrorAction SilentlyContinue) {
            try {
                Checkpoint-Computer -Description $desc -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop -WarningAction SilentlyContinue
                $ok = $true
            } catch { $msg = $_.Exception.Message }
        }
        if (-not $ok) {
            try {
                $r = Invoke-CimMethod -Namespace 'root/default' -ClassName 'SystemRestore' -MethodName 'CreateRestorePoint' -Arguments @{ Description = $desc; RestorePointType = [uint32]12; EventType = [uint32]100 } -ErrorAction Stop
                if ([int]$r.ReturnValue -eq 0) { $ok = $true } else { $msg = 'SystemRestore-Fehlercode ' + $r.ReturnValue }
            } catch { if (-not $msg) { $msg = $_.Exception.Message } }
        }
    } finally {
        try {
            if ($null -ne $prev -and $prev.exists) { Set-VxRealRegValue $srKey 'SystemRestorePointCreationFrequency' 'DWord' $prev.value }
            else { Remove-VxRealRegValue $srKey 'SystemRestorePointCreationFrequency' }
        } catch { $null = $_ }
    }
    if ($ok) {
        $ctx.RestorePointDone = $true
        $ctx.State.restorePoints = [int](Get-VxProp $ctx.State 'restorePoints' 0) + 1
        Write-VxLog 'ok' "Wiederherstellungspunkt '$desc' erstellt."
        return @{ ok = $true; created = $true; message = 'Wiederherstellungspunkt erstellt.' }
    }
    Write-VxLog 'warn' ('Wiederherstellungspunkt konnte nicht erstellt werden: ' + $msg)
    return @{ ok = $false; created = $false; message = ('Wiederherstellungspunkt konnte nicht erstellt werden. VELOX macht trotzdem weiter und sichert alles im eigenen Journal. (' + $msg + ')') }
}

# Called before every job that changes the system. Never fatal.
function Invoke-VxAutoRestorePoint([string]$Label, $J = $null, [bool]$Force = $false) {
    $ctx = $global:VxCtx
    $want = $Force -or [bool]$ctx.Settings.autoRestorePoint
    if (-not $want) { return }
    if ($ctx.RestorePointDone -and -not $Force) { if ($null -ne $J) { $J.restorePoint = $true }; return }
    try {
        $r = New-VxRestorePoint $Label $Force
        if ($null -ne $J) { $J.restorePoint = [bool]($r.ok) }
        if (-not $r.ok) { Write-VxLog 'warn' $r.message }
    } catch { Write-VxLog 'warn' ('Wiederherstellungspunkt fehlgeschlagen: ' + $_.Exception.Message) }
}

# ================================================================== jobs: apply / revert

function Get-VxNeedsOf($Tweaks) {
    $n = [ordered]@{ explorer = $false; reboot = $false; logoff = $false }
    foreach ($t in @($Tweaks)) {
        $x = [string](Get-VxProp $t 'needs' 'none')
        if ($n.Contains($x)) { $n[$x] = $true }
    }
    return $n
}

function Invoke-VxApplyJob($Params, [string]$Mode) {
    $ctx = $global:VxCtx
    $ids = @(@(Get-VxProp $Params 'ids' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ } | Select-Object -Unique)
    $label = [string](Get-VxProp $Params 'label' '')
    if (-not $label) { if ($Mode -eq 'apply') { $label = 'Tweaks anwenden' } else { $label = 'Tweaks zurücksetzen' } }
    $results = New-Object System.Collections.ArrayList
    $changedTweaks = New-Object System.Collections.ArrayList
    $J = New-VxJournal $Mode $label
    Set-VxProgress 0.02 'Bereite Änderungen vor ...'
    Invoke-VxAutoRestorePoint $label $J
    $n = 0
    $total = [math]::Max(1, $ids.Count)
    try {
        foreach ($id in $ids) {
            Test-VxCancel
            $n++
            $t = Get-VxTweak $id
            if ($null -eq $t) {
                [void]$results.Add([ordered]@{ id = $id; ok = $false; status = $null; error = 'Unbekannter Tweak.' })
                continue
            }
            $verb = 'Wende an'
            if ($Mode -ne 'apply') { $verb = 'Setze zurück' }
            Set-VxProgress (0.05 + 0.9 * ($n - 1) / $total) ("{0}: {1}" -f $verb, $t.name)
            $r = Invoke-VxTweakChange $t $Mode $J
            if ($r.ok) {
                if ($r.changed -gt 0) { Write-VxLog 'ok' ("{0}: {1}" -f $t.name, $(if ($Mode -eq 'apply') { 'angewendet' } else { 'zurückgesetzt' })) }
                else { Write-VxLog 'info' ("{0}: war schon so eingestellt" -f $t.name) }
            } else { Write-VxLog 'error' ("{0}: {1}" -f $t.name, $r.error) }
            if ($r.changed -gt 0) { [void]$changedTweaks.Add($t) }
            if ($null -ne $r.status) { $ctx.State.statuses[$id] = $r.status }
            [void]$results.Add([ordered]@{ id = $id; ok = [bool]$r.ok; status = $r.status; error = $r.error })
        }
    } finally {
        $backupId = Complete-VxJournal $J
        $needs = Get-VxNeedsOf $changedTweaks.ToArray()
        foreach ($k in @('explorer', 'reboot', 'logoff')) { if ($needs[$k]) { Add-VxNeeds $k } }
        Save-VxState
        Save-VxSim
    }
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ results = $results.ToArray(); backupId = $backupId; needs = $needs }
}

# ================================================================== restore

function Restore-VxEntry($J, $E) {
    $op = [string](Get-VxProp $E 'op')
    $before = Get-VxProp $E 'before'
    switch ($op) {
        'reg' {
            if ($null -ne $before -and (Get-VxProp $before 'exists') -eq $true) {
                $val = Get-VxProp $before 'value'
                $kind = [string](Get-VxProp $before 'kind')
                if ($kind -eq 'MultiString') { $val = [string[]]@($val) }
                if (@('DWord', 'QWord', 'String', 'ExpandString', 'MultiString', 'Binary') -notcontains $kind) { throw "Registry-Typ '$kind' kann nicht wiederhergestellt werden." }
                $null = Set-VxRegJ $J ([string]$E.path) ([string]$E.name) $kind $val 'restore'
            } else {
                $null = Set-VxRegJ $J ([string]$E.path) ([string]$E.name) $null $null 'restore'
            }
        }
        'regkey' {
            $tree = Get-VxProp $E 'tree'
            $null = Set-VxRegKeyJ $J ([string]$E.path) ([bool]$before) 'restore' $tree
        }
        'service' {
            if ($null -eq $before) { return }
            $b = [string]$before
            if (@('Automatic', 'AutomaticDelayed', 'Manual', 'Disabled') -notcontains $b) { throw "Starttyp '$b' kann nicht gesetzt werden." }
            $startNow = ($b -eq 'Automatic' -or $b -eq 'AutomaticDelayed')
            $null = Set-VxServiceJ $J ([string]$E.name) $b $false $startNow 'restore'
        }
        'task' { $null = Set-VxTaskJ $J ([string]$E.path) ([bool]$before) 'restore' }
        'bcd' { $null = Set-VxBcdJ $J ([string]$E.name) $before 'restore' }
        'powerplan' { if ($before) { $null = Set-VxPlanJ $J ([string]$before) 'restore' } }
        'powersetting' {
            $null = Set-VxPowerSettingJ $J ([string]$E.subgroup) ([string]$E.setting) (Get-VxProp $before 'ac') (Get-VxProp $before 'dc') $null 'restore'
        }
        'feature' { $null = Set-VxFeatureJ $J ([string]$E.name) ([bool]$before) 'restore' }
        'ps' {
            $t = Get-VxTweak ([string]$E.tweakId)
            if ($null -eq $t) { throw ("Tweak '{0}' gibt es nicht mehr." -f $E.tweakId) }
            $idx = [int](Get-VxProp $E 'index' 0)
            $acts = @($t.actions)
            if ($idx -ge $acts.Count) { throw 'Skript-Aktion nicht gefunden.' }
            $opposite = 'revert'
            if ([string]$E.mode -eq 'revert') { $opposite = 'apply' }
            $null = Invoke-VxPsAction $J $acts[$idx] $t $idx $opposite
        }
        'startup' {
            # kept for completeness: startup changes are journalled as reg entries
            return
        }
        default { throw "Eintrag '$op' kann nicht automatisch rückgängig gemacht werden." }
    }
}

function Invoke-VxRestoreJob($Params) {
    $ctx = $global:VxCtx
    $id = [string](Get-VxProp $Params 'backupId')
    $b = Read-VxBackup $id
    if ($null -eq $b) { throw 'Diese Sicherung wurde nicht gefunden.' }
    if ([bool](Get-VxProp $b 'simulate' $false) -ne [bool]$ctx.Simulate) {
        if ($ctx.Simulate) { throw 'Diese Sicherung stammt aus dem echten Modus und kann im Testmodus nicht wiederhergestellt werden.' }
        throw 'Diese Sicherung stammt aus dem Testmodus - dort wurde am PC nichts verändert.'
    }
    $entries = @(Get-VxProp $b 'entries' @())
    $J = New-VxJournal 'restore' ('Wiederherstellung: ' + [string]$b.label)
    Invoke-VxAutoRestorePoint ('Wiederherstellung ' + $id) $J
    $restored = 0
    $failed = 0
    $errors = New-Object System.Collections.Generic.List[string]
    $total = [math]::Max(1, $entries.Count)
    $n = 0
    $touched = @{}
    try {
        for ($i = $entries.Count - 1; $i -ge 0; $i--) {
            Test-VxCancel
            $n++
            $e = $entries[$i]
            Set-VxProgress (0.05 + 0.9 * $n / $total) ('Stelle wieder her: ' + (Get-VxEntryLabel $e))
            if (-not (Test-VxEntryRestorable $e)) {
                $failed++
                $msg = 'Nicht wiederherstellbar: ' + (Get-VxEntryLabel $e)
                if ([string](Get-VxProp $e 'op') -eq 'appx') { $msg = ('App {0} muss über den Microsoft Store neu installiert werden.' -f (Get-VxProp $e 'package')) }
                $errors.Add($msg)
                Write-VxLog 'warn' $msg
                continue
            }
            try {
                Restore-VxEntry $J $e
                $restored++
                $tid = [string](Get-VxProp $e 'tweakId')
                if ($tid -and $tid -ne 'restore') { $touched[$tid] = $true }
            } catch {
                if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
                $failed++
                $m = (Get-VxEntryLabel $e) + ': ' + (Get-VxErrorText $_)
                $errors.Add($m)
                Write-VxLog 'error' $m
            }
        }
    } finally {
        $null = Complete-VxJournal $J
        try { Update-VxStatuses -Ids @($touched.Keys) } catch { $null = $_ }
        Save-VxState
        Save-VxSim
    }
    Write-VxLog 'ok' ("{0} Einträge wiederhergestellt, {1} fehlgeschlagen." -f $restored, $failed)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ restored = $restored; failed = $failed; errors = $errors.ToArray() }
}

function Get-VxEntryLabel($E) {
    $op = [string](Get-VxProp $E 'op')
    switch ($op) {
        'reg' { return ('{0}\{1}' -f $E.path, $E.name) }
        'regkey' { return [string]$E.path }
        'service' { return ('Dienst ' + $E.name) }
        'task' { return ('Aufgabe ' + $E.path) }
        'bcd' { return ('Boot-Wert ' + $E.name) }
        'powerplan' { return 'Energieplan' }
        'powersetting' { return 'Energieoption' }
        'feature' { return ('Windows-Feature ' + $E.name) }
        'ps' { return ('Skript ' + $E.tweakId) }
        'appx' { return ('App ' + $E.package) }
        'cmd' { return ('Befehl ' + $E.id) }
    }
    return $op
}

# ================================================================== simulate overlay persistence

function Save-VxSim {
    $ctx = $global:VxCtx
    if (-not $ctx.Simulate) { return }
    try {
        $copy = @{}
        foreach ($k in @($ctx.Sim.Keys)) { $copy[$k] = $ctx.Sim[$k] }
        Write-VxJsonFile -Path (Get-VxDataPath 'sim-state.json') -InputObject $copy
    } catch { Write-VxLog 'warn' ('sim-state.json konnte nicht gespeichert werden: ' + $_.Exception.Message) }
}

# Loads the overlay; off Windows seeds "foreign tweaks" on first start or with -Reset.
function Import-VxSim([bool]$Reset = $false) {
    $ctx = $global:VxCtx
    $path = Get-VxDataPath 'sim-state.json'
    $ctx.Sim.Clear()
    if (-not $Reset -and [IO.File]::Exists($path)) {
        try {
            $h = ConvertTo-VxHashtable (Read-VxJsonFile $path)
            if ($h -is [hashtable]) { foreach ($k in @($h.Keys)) { $ctx.Sim[$k] = $h[$k] } }
        } catch { Write-VxLog 'warn' ('sim-state.json unlesbar, starte neu: ' + $_.Exception.Message) }
    }
    foreach ($k in @('reg', 'svc', 'task', 'bcd', 'power', 'pws', 'feature', 'appx', 'ps')) {
        if (-not ($ctx.Sim[$k] -is [hashtable])) { $ctx.Sim[$k] = @{} }
    }
    if (-not $ctx.Windows -and -not $ctx.Sim.ContainsKey('seeded')) {
        Initialize-VxSimSeed
        $ctx.Sim.seeded = $true
        Save-VxSim
    }
}

# Foreign tweaks + autostart entries so the Detweak and Apps pages have something to show.
function Initialize-VxSimSeed {
    Set-VxSimRegValue 'HKLM\SYSTEM\CurrentControlSet\Control\PriorityControl' 'Win32PrioritySeparation' 'DWord' 38
    Set-VxSimRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile' 'SystemResponsiveness' 'DWord' 0
    Set-VxSimRegValue 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\GTA5.exe\PerfOptions' 'CpuPriorityClass' 'DWord' 3
    $global:VxCtx.Sim.bcd['useplatformclock'] = 'Yes'
    $global:VxCtx.Sim.svc['sysmain'] = 'Disabled'
    $run = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'
    Set-VxSimRegValue $run 'Discord' 'String' '"C:\Users\Gamer\AppData\Local\Discord\Update.exe" --processStart Discord.exe'
    Set-VxSimRegValue $run 'Steam' 'String' '"C:\Program Files (x86)\Steam\steam.exe" -silent'
    Set-VxSimRegValue $run 'Spotify' 'String' '"C:\Users\Gamer\AppData\Roaming\Spotify\Spotify.exe" /minimized'
    Set-VxSimRegValue $run 'OneDrive' 'String' '"C:\Program Files\Microsoft OneDrive\OneDrive.exe" /background'
    Set-VxSimRegValue 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' 'SecurityHealth' 'ExpandString' '%windir%\system32\SecurityHealthSystray.exe'
    Set-VxSimRegValue 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' 'RtkAudUService' 'String' '"C:\Windows\System32\DriverStore\FileRepository\realtekservice.inf_amd64\RtkAudUService64.exe" -background'
    Set-VxSimRegValue 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run' 'EpicGamesLauncher' 'String' '"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe" -silent'
    # Spotify is already disabled in Task Manager
    Set-VxSimRegValue 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' 'Spotify' 'Binary' '030000005A1B3C4D5E6F7001'
}
