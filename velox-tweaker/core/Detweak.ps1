# VELOX - core/Detweak.ps1
# Finds values that other tweakers changed (data/detweak.json + catalog toggles that are not at the
# Windows default) and resets them, journalled (docs/ARCHITECTURE.md section 5).
# Only function definitions.

function Get-VxStartLabel([string]$Start) {
    switch ($Start) {
        'Automatic' { return 'Automatisch' }
        'AutomaticDelayed' { return 'Automatisch (verzögert)' }
        'Manual' { return 'Manuell' }
        'Disabled' { return 'Deaktiviert' }
        'Boot' { return 'Boot' }
        'System' { return 'System' }
    }
    return [string]$Start
}

function Get-VxStatusLabel([string]$Status) {
    switch ($Status) {
        'applied' { return 'Angepasst' }
        'partial' { return 'Teilweise angepasst' }
        'custom' { return 'Von anderem Tool geändert' }
    }
    return $Status
}

# Value of the '*' segment in a concrete path built from a pattern (for labels).
function Get-VxWildSegment([string]$Pattern, [string]$Concrete) {
    $p = $Pattern.Split('\')
    $i = [Array]::IndexOf($p, '*')
    if ($i -lt 0) { return $null }
    $c = $Concrete.Split('\')
    if ($i -lt $c.Length) { return $c[$i] }
    return $null
}

# Display text of a value for the detweak list ("0", "4294967295 (0xFFFFFFFF)", "nicht gesetzt").
function Format-VxShortValue($Value, [string]$Kind, [bool]$Exists = $true) {
    if (-not $Exists -or $null -eq $Value) { return 'nicht gesetzt' }
    if ($Kind -eq 'DWord' -or $Kind -eq 'QWord') {
        $d = [decimal]0
        if ([decimal]::TryParse([string]$Value, [Globalization.NumberStyles]::Number, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
            if ($d -gt 65535 -and $Kind -eq 'DWord') { return ('{0} (0x{1})' -f $d, ([uint32]$d).ToString('X')) }
            return $d.ToString([Globalization.CultureInfo]::InvariantCulture)
        }
    }
    if ($Kind -eq 'MultiString' -or $Value -is [array]) { return ((@($Value) | ForEach-Object { [string]$_ }) -join ', ') }
    $s = [string]$Value
    if ($s -eq '') { return '(leer)' }
    return $s
}

function Format-VxPowerValue($Value) {
    if ($null -eq $Value) { return 'nicht gesetzt' }
    $ac = Get-VxProp $Value 'ac'
    $dc = Get-VxProp $Value 'dc'
    if ($null -ne $dc -and $null -ne $ac -and [string]$dc -ne [string]$ac) { return ('Netz {0} · Akku {1}' -f $ac, $dc) }
    if ($null -ne $ac) { return [string]$ac }
    return [string]$dc
}

# current/default display text of a catalog tweak in the detweak list: the real values when the tweak
# changes exactly one value, otherwise its status ("Angepasst" -> "Windows-Standard").
function Get-VxTweakValueText($Tweak, [string]$Status) {
    $out = @{ current = (Get-VxStatusLabel $Status); default = 'Windows-Standard' }
    $acts = @($Tweak.actions)
    if ($acts.Count -ne 1) { return $out }
    $a = $acts[0]
    try {
        switch ([string](Get-VxProp $a 'type')) {
            'reg' {
                $targets = @(Resolve-VxRegPattern ([string]$a.path))
                if ($targets.Count -ne 1) { return $out }
                $kind = [string]$a.kind
                $cur = Get-VxRegValue $targets[0] ([string]$a.name)
                $def = Get-VxActionDefault $a
                $ck = $kind
                if ($cur.exists -and $cur.kind) { $ck = [string]$cur.kind }
                $out.current = Format-VxShortValue $cur.value $ck ([bool]$cur.exists)
                $out.default = Format-VxShortValue $def $kind ($null -ne $def)
            }
            'regkey' {
                $targets = @(Resolve-VxRegPattern ([string]$a.path))
                if ($targets.Count -gt 1) { return $out }
                $exists = ($targets.Count -eq 1 -and (Test-VxRegKey $targets[0]))
                $out.current = 'nicht vorhanden'; if ($exists) { $out.current = 'vorhanden' }
                $out.default = 'nicht vorhanden'; if ([bool](Get-VxProp $a 'default' $false)) { $out.default = 'vorhanden' }
            }
            'service' {
                $cur = Get-VxServiceStart ([string]$a.name)
                if ($null -eq $cur) { return $out }
                $out.current = Get-VxStartLabel $cur
                $out.default = Get-VxStartLabel ([string](Get-VxActionDefault $a))
            }
            'task' {
                $cur = Get-VxTaskState ([string]$a.path)
                if ($null -eq $cur) { return $out }
                $out.current = 'deaktiviert'; if ([bool]$cur) { $out.current = 'aktiv' }
                $out.default = 'deaktiviert'; if ([bool](Get-VxProp $a 'default' $true)) { $out.default = 'aktiv' }
            }
            'bcd' {
                $cur = Get-VxBcdValue ([string]$a.name)
                $def = Get-VxProp $a 'default'
                $out.current = 'nicht gesetzt'; if ($null -ne $cur) { $out.current = [string]$cur }
                $out.default = 'nicht gesetzt'; if ($null -ne $def) { $out.default = [string]$def }
            }
            'powerplan' {
                $out.current = [string](Get-VxActivePlan).name
                $out.default = Get-VxPlanDisplayName (Get-VxPlanBaseGuid ([string](Get-VxProp $a 'default' 'balanced')))
            }
            'powersetting' {
                $def = Get-VxProp $a 'default'
                $cur = Get-VxPowerSetting ([string]$a.subgroup) ([string]$a.setting) $def
                if ($null -eq $cur) { return $out }
                if ($null -eq (Get-VxProp $a 'dc')) { $cur = @{ ac = $cur.ac }; if ($null -ne $def) { $def = @{ ac = (Get-VxProp $def 'ac') } } }
                $out.current = Format-VxPowerValue $cur
                if ($null -ne $def) { $out.default = Format-VxPowerValue $def }
            }
            'feature' {
                $cur = Get-VxFeatureState ([string]$a.name)
                if ($null -eq $cur) { return $out }
                $out.current = 'aus'; if ([bool]$cur) { $out.current = 'an' }
                $out.default = 'aus'; if ([bool](Get-VxProp $a 'default' $true)) { $out.default = 'an' }
            }
        }
    } catch {
        Write-VxLog 'warn' ("Werte von '{0}' nicht lesbar: {1}" -f $Tweak.id, $_.Exception.Message)
        return @{ current = (Get-VxStatusLabel $Status); default = 'Windows-Standard' }
    }
    return $out
}

# ------------------------------------------------------------------ what VELOX itself set

# Target key of a journal entry ('reg|<path>|<name>', 'svc|<name>' ... - lower case, the same keys
# the detweak scan uses), $null for entries without a single target.
function Get-VxEntryTargetKey($Entry) {
    $op = [string](Get-VxProp $Entry 'op')
    $k = $null
    switch ($op) {
        'reg' { $k = 'reg|' + [string]$Entry.path + '|' + [string]$Entry.name }
        'regkey' { $k = 'regkey|' + [string]$Entry.path }
        'service' { $k = 'svc|' + [string]$Entry.name }
        'task' { $k = 'task|' + [string]$Entry.path }
        'bcd' { $k = 'bcd|' + [string]$Entry.name }
        'powerplan' { $k = 'powerplan' }
        'powersetting' { $k = 'pws|' + [string]$Entry.subgroup + '|' + [string]$Entry.setting }
        'feature' { $k = 'feature|' + [string]$Entry.name }
        'ps' { $k = 'ps|' + [string]$Entry.tweakId + '#' + [string](Get-VxProp $Entry 'index' 0) }
    }
    if ($null -eq $k) { return $null }
    return $k.ToLowerInvariant()
}

# The last journalled change per target over all backups of the current mode (Testmodus journals
# never explain the real PC and vice versa), oldest backup first. Returns @{ <target key> = entry }.
function Get-VxJournalIndex {
    $ctx = $global:VxCtx
    $index = @{}
    foreach ($id in @(Get-VxBackupIds -Oldest)) {
        $b = $null
        try { $b = Read-VxBackup $id } catch { Write-VxLog 'warn' ("Sicherung {0} unlesbar: {1}" -f $id, $_.Exception.Message); continue }
        if ($null -eq $b) { continue }
        if ([bool](Get-VxProp $b 'simulate' $false) -ne [bool]$ctx.Simulate) { continue }
        foreach ($e in @(Get-VxProp $b 'entries' @())) {
            $k = Get-VxEntryTargetKey $e
            if ($k) { $index[$k] = $e }
        }
    }
    return $index
}

# The journal entry that last wrote this target, when a catalog tweak wrote it (not a detweak reset,
# a restore or a game boost); $null otherwise.
function Get-VxOwnJournalEntry($Index, [string]$Key) {
    $e = $Index[$Key.ToLowerInvariant()]
    if ($null -eq $e) { return $null }
    $tid = [string](Get-VxProp $e 'tweakId' '')
    if (-not $tid -or -not $global:VxCtx.Catalog.byId.ContainsKey($tid)) { return $null }
    return $e
}

# $true when VELOX itself set this catalog tweak: every value of it that is not at the Windows
# default is exactly what VELOX's journals last wrote there for a catalog tweak.
function Test-VxTweakSetByVelox($Tweak, $Index) {
    $explained = 0
    $i = -1
    foreach ($a in @($Tweak.actions)) {
        $i++
        switch ([string](Get-VxProp $a 'type')) {
            'reg' {
                $name = [string]$a.name
                $kind = [string]$a.kind
                $def = Get-VxActionDefault $a
                foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) {
                    $cur = $null
                    try { $cur = Get-VxRegValue $p $name } catch { if (Test-VxAccessDenied $_) { continue }; throw }
                    if (-not $cur.exists) { continue }
                    if ($null -ne $def -and (Test-VxRegEqual $kind $cur.value $def)) { continue }
                    $e = Get-VxOwnJournalEntry $Index ('reg|' + $p + '|' + $name)
                    if ($null -eq $e) { return $false }
                    $after = Get-VxProp $e 'after'
                    if (-not [bool](Get-VxProp $after 'exists' $false)) { return $false }
                    $ak = [string](Get-VxProp $after 'kind' $kind)
                    if (-not (Test-VxRegEqual $ak (Get-VxProp $after 'value') $cur.value)) { return $false }
                    $explained++
                }
            }
            'regkey' {
                $def = Get-VxProp $a 'default'
                foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) {
                    $exists = [bool](Test-VxRegKey $p)
                    if ($null -ne $def -and $exists -eq [bool]$def) { continue }
                    $e = Get-VxOwnJournalEntry $Index ('regkey|' + $p)
                    if ($null -eq $e -or [bool](Get-VxProp $e 'after') -ne $exists) { return $false }
                    $explained++
                }
            }
            'service' {
                $cur = Get-VxServiceStart ([string]$a.name)
                if ($null -eq $cur -or $cur -eq [string](Get-VxActionDefault $a)) { continue }
                $e = Get-VxOwnJournalEntry $Index ('svc|' + [string]$a.name)
                if ($null -eq $e -or [string](Get-VxProp $e 'after') -ne [string]$cur) { return $false }
                $explained++
            }
            'task' {
                $cur = Get-VxTaskState ([string]$a.path)
                if ($null -eq $cur -or [bool]$cur -eq [bool](Get-VxProp $a 'default' $true)) { continue }
                $e = Get-VxOwnJournalEntry $Index ('task|' + [string]$a.path)
                if ($null -eq $e -or [bool](Get-VxProp $e 'after') -ne [bool]$cur) { return $false }
                $explained++
            }
            'bcd' {
                $cur = Get-VxBcdValue ([string]$a.name)
                if ($null -eq $cur) { continue }
                $def = Get-VxProp $a 'default'
                if ($null -ne $def -and (Test-VxBcdEqual $cur $def)) { continue }
                $e = Get-VxOwnJournalEntry $Index ('bcd|' + [string]$a.name)
                if ($null -eq $e -or -not (Test-VxBcdEqual (Get-VxProp $e 'after') $cur)) { return $false }
                $explained++
            }
            'powerplan' {
                $active = [string](Get-VxActivePlan).guid
                if ((Get-VxPlanCandidates ([string](Get-VxProp $a 'default' 'balanced'))) -contains $active) { continue }
                $e = Get-VxOwnJournalEntry $Index 'powerplan'
                if ($null -eq $e -or ([string](Get-VxProp $e 'after')).ToLowerInvariant() -ne $active.ToLowerInvariant()) { return $false }
                $explained++
            }
            'powersetting' {
                $def = Get-VxProp $a 'default'
                $cur = Get-VxPowerSetting ([string]$a.subgroup) ([string]$a.setting) $def
                if ($null -eq $cur) { continue }
                if ($null -ne $def) {
                    $dac = Get-VxProp $def 'ac'; $ddc = Get-VxProp $def 'dc'
                    $atDef = ($null -eq $dac -or [long]$cur.ac -eq [long]$dac) -and ($null -eq $ddc -or $null -eq $cur.dc -or [long]$cur.dc -eq [long]$ddc)
                    if ($atDef) { continue }
                }
                $e = Get-VxOwnJournalEntry $Index ('pws|' + [string]$a.subgroup + '|' + [string]$a.setting)
                if ($null -eq $e) { return $false }
                $after = Get-VxProp $e 'after'
                $aac = Get-VxProp $after 'ac'; $adc = Get-VxProp $after 'dc'
                if ($null -ne $aac -and [long]$aac -ne [long]$cur.ac) { return $false }
                if ($null -ne $adc -and $null -ne $cur.dc -and [long]$adc -ne [long]$cur.dc) { return $false }
                $explained++
            }
            'feature' {
                $cur = Get-VxFeatureState ([string]$a.name)
                if ($null -eq $cur -or [bool]$cur -eq [bool](Get-VxProp $a 'default' $true)) { continue }
                $e = Get-VxOwnJournalEntry $Index ('feature|' + [string]$a.name)
                if ($null -eq $e -or [bool](Get-VxProp $e 'after') -ne [bool]$cur) { return $false }
                $explained++
            }
            'ps' {
                $st = 'unknown'
                try { $st = Get-VxPsState $a $Tweak $i } catch { $st = 'unknown' }
                if ($st -eq 'default') { continue }
                $e = Get-VxOwnJournalEntry $Index ('ps|' + [string]$Tweak.id + '#' + $i)
                if ($null -eq $e -or [string](Get-VxProp $e 'mode') -ne 'apply') { return $false }
                $explained++
            }
        }
    }
    return ($explained -gt 0)
}

# Detweak keys a tweak covers: its own 'tweak|<id>' plus every single target it writes.
function Get-VxTweakDetweakKeys($Tweak) {
    $keys = New-Object System.Collections.ArrayList
    [void]$keys.Add(('tweak|' + [string]$Tweak.id))
    foreach ($a in @($Tweak.actions)) {
        try {
            switch ([string](Get-VxProp $a 'type')) {
                'reg' { foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) { [void]$keys.Add(('reg|' + $p + '|' + $a.name)) } }
                'regkey' { foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) { [void]$keys.Add(('regkey|' + $p)) } }
                'service' { [void]$keys.Add(('svc|' + $a.name)) }
                'task' { [void]$keys.Add(('task|' + $a.path)) }
                'bcd' { [void]$keys.Add(('bcd|' + $a.name)) }
            }
        } catch { $null = $_ }
    }
    return @($keys | ForEach-Object { ([string]$_).ToLowerInvariant() })
}

# Foreign tweaks of the last detweak scan (keys) and their count, in state + profile.
function Set-VxForeignKeys([string[]]$Keys) {
    $list = @(@($Keys) | Where-Object { $_ } | ForEach-Object { [string]$_ })
    $global:VxCtx.State.foreignKeys = $list
    Set-VxForeignCount $list.Count
}

# After VELOX changed something: what it just reset or applied is no longer foreign (it is at the
# Windows default or VELOX's own now). No-op until the first detweak scan.
function Update-VxForeignAfterChange([string[]]$Keys) {
    $st = $global:VxCtx.State
    if (-not $st.ContainsKey('foreignKeys') -or $null -eq $st.foreignKeys) { return }
    $drop = @{}
    foreach ($k in @($Keys)) { if ($k) { $drop[([string]$k).ToLowerInvariant()] = $true } }
    $left = @(@($st.foreignKeys) | Where-Object { -not $drop.ContainsKey(([string]$_).ToLowerInvariant()) })
    Set-VxForeignKeys $left
}

# Same, for tweaks an apply/revert job changed successfully.
function Update-VxForeignAfterTweaks($Tweaks) {
    $keys = @()
    foreach ($t in @($Tweaks)) { if ($null -ne $t) { $keys += @(Get-VxTweakDetweakKeys $t) } }
    if ($keys.Count -gt 0) { Update-VxForeignAfterChange $keys }
}

function New-VxDetweakItem([string]$Key, [string]$Source, $TweakId, [string]$Label, [string]$Group, [string]$Current, [string]$Default, [string]$Type, $Data) {
    return @{
        key = $Key; source = $Source; tweakId = $TweakId; label = $Label; group = $Group
        current = $Current; default = $Default; type = $Type; data = $Data
    }
}

# Internal scan: returns @{ items = [...internal items...]; commands = [...] }.
# $true when every action of a catalog tweak sits at its declared Windows default. Some tweaks target
# a value that already IS the Windows default on most PCs (e.g. core parking on "Ausbalanciert"):
# their status reads "applied", but nothing deviates from Windows - detweak must not list them.
function Test-VxTweakAtDefault($Tweak) {
    foreach ($a in @($Tweak.actions)) {
        $type = [string](Get-VxProp $a 'type')
        switch ($type) {
            'reg' {
                $def = Get-VxActionDefault $a
                foreach ($t in @(Resolve-VxRegPattern ([string]$a.path))) {
                    $cur = $null
                    try { $cur = Get-VxRegValue $t ([string]$a.name) } catch { if (Test-VxAccessDenied $_) { continue }; throw }
                    if (-not $cur.exists) { continue }
                    if ($null -eq $def -or -not (Test-VxRegEqual ([string]$a.kind) $cur.value $def)) { return $false }
                }
            }
            'regkey' {
                $want = [bool](Get-VxProp $a 'default' $false)
                foreach ($t in @(Resolve-VxRegPattern ([string]$a.path))) { if ((Test-VxRegKey $t) -ne $want) { return $false } }
            }
            'service' {
                $cur = Get-VxServiceStart ([string]$a.name)
                if ($null -ne $cur -and $cur -ne [string](Get-VxActionDefault $a)) { return $false }
            }
            'task' {
                $cur = Get-VxTaskState ([string]$a.path)
                if ($null -ne $cur -and [bool]$cur -ne [bool](Get-VxProp $a 'default' $true)) { return $false }
            }
            'bcd' {
                $cur = Get-VxBcdValue ([string]$a.name)
                $def = Get-VxProp $a 'default'
                if ($null -ne $cur -and ($null -eq $def -or -not (Test-VxBcdEqual $cur $def))) { return $false }
            }
            'powerplan' {
                $def = [string](Get-VxProp $a 'default' 'balanced')
                if ((Get-VxPlanCandidates $def) -notcontains (Get-VxActivePlan).guid) { return $false }
            }
            'powersetting' {
                $def = Get-VxProp $a 'default'
                if ($null -eq $def) { return $false }
                $cur = Get-VxPowerSetting ([string]$a.subgroup) ([string]$a.setting) $def
                if ($null -eq $cur) { continue }
                $dac = Get-VxProp $def 'ac'; $ddc = Get-VxProp $def 'dc'
                if ($null -ne $dac -and [long]$cur.ac -ne [long]$dac) { return $false }
                if ($null -ne $ddc -and $null -ne $cur.dc -and [long]$cur.dc -ne [long]$ddc) { return $false }
            }
            'feature' {
                $cur = Get-VxFeatureState ([string]$a.name)
                if ($null -ne $cur -and [bool]$cur -ne [bool](Get-VxProp $a 'default' $true)) { return $false }
            }
            default { return $false }   # ps and anything else: cannot tell, keep listing it
        }
    }
    return $true
}

function Get-VxDetweakScan {
    param([double]$ProgressFrom = 0, [double]$ProgressTo = 1)
    $ctx = $global:VxCtx
    $cat = $ctx.Catalog
    $dt = $cat.detweak
    $items = New-Object System.Collections.ArrayList
    $seen = @{}
    $span = $ProgressTo - $ProgressFrom

    # ---- catalog toggles that are not at the Windows default
    Set-VxProgress ($ProgressFrom) 'Prüfe VELOX-Katalog ...'
    Update-VxStatuses -ProgressFrom $ProgressFrom -ProgressTo ($ProgressFrom + $span * 0.6)
    $covered = @{}
    $jIndex = $null
    foreach ($t in $cat.tweaks) {
        if ((Get-VxTweakKind $t) -ne 'toggle') { continue }
        $id = [string]$t.id
        $st = [string]$ctx.State.statuses[$id]
        if (@('applied', 'partial', 'custom') -notcontains $st) { continue }
        try { if (Test-VxTweakAtDefault $t) { continue } }
        catch { Write-VxLog 'warn' ("Standard-Prüfung von '{0}' fehlgeschlagen: {1}" -f $id, $_.Exception.Message) }
        $catName = [string](Get-VxProp $cat.categoryNames ([string]$t.category) ([string]$t.category))
        # source "velox": exactly what VELOX's own journals last set - not a foreign tweak
        if ($null -eq $jIndex) { $jIndex = Get-VxJournalIndex }
        $src = 'catalog'
        try { if (Test-VxTweakSetByVelox $t $jIndex) { $src = 'velox' } }
        catch { Write-VxLog 'warn' ("Herkunft von '{0}' nicht prüfbar: {1}" -f $id, $_.Exception.Message) }
        $vals = Get-VxTweakValueText $t $st
        [void]$items.Add((New-VxDetweakItem ('tweak|' + $id) $src $id ([string]$t.name) $catName ([string]$vals.current) ([string]$vals.default) 'tweak' $id))
        foreach ($a in @($t.actions)) {
            $type = [string](Get-VxProp $a 'type')
            try {
                switch ($type) {
                    'reg' { foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) { $covered[('reg|' + $p + '|' + $a.name).ToLowerInvariant()] = $true } }
                    'regkey' { foreach ($p in @(Resolve-VxRegPattern ([string]$a.path))) { $covered[('regkey|' + $p).ToLowerInvariant()] = $true } }
                    'service' { $covered[('svc|' + $a.name).ToLowerInvariant()] = $true }
                    'task' { $covered[('task|' + $a.path).ToLowerInvariant()] = $true }
                    'bcd' { $covered[('bcd|' + $a.name).ToLowerInvariant()] = $true }
                }
            } catch { $null = $_ }
        }
    }
    # Values VELOX itself sets (every catalog reg action, whatever its status) and the IFEO priority
    # of games boosted in the game booster: a registryKeys hit made only of these is not foreign.
    $explained = New-Object System.Collections.ArrayList
    foreach ($t in $cat.tweaks) {
        foreach ($a in @($t.actions)) {
            if ([string](Get-VxProp $a 'type') -eq 'reg') { [void]$explained.Add(@{ rx = (ConvertTo-VxKeyRegex ([string]$a.path)); name = ([string]$a.name).ToLowerInvariant() }) }
        }
    }
    foreach ($g in @($ctx.Settings.games)) {
        $exe = Get-VxPathLeaf ([string](Get-VxProp $g 'path' ''))
        if (-not $exe) { continue }
        $gp = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\' + $exe + '\PerfOptions'
        [void]$explained.Add(@{ rx = (ConvertTo-VxKeyRegex $gp); name = 'cpupriorityclass' })
    }
    $isExplained = {
        param([string]$keyPath, [string]$valueName)
        $lp = $keyPath.ToLowerInvariant()
        $ln = $valueName.ToLowerInvariant()
        foreach ($x in $explained) { if ($x.name -eq $ln -and $lp -match $x.rx) { return $true } }
        return $false
    }

    $addItem = {
        param($item)
        $lk = $item.key.ToLowerInvariant()
        if ($covered.ContainsKey($lk) -or $seen.ContainsKey($lk)) { return }
        $seen[$lk] = $true
        [void]$items.Add($item)
    }

    if ($null -ne $dt) {
        Set-VxProgress ($ProgressFrom + $span * 0.65) 'Suche fremde Registry-Tweaks ...'
        foreach ($r in @(Get-VxProp $dt 'registry' @())) {
            Test-VxCancel
            try {
                $path = [string]$r.path
                $name = [string]$r.name
                $def = Get-VxActionDefault $r
                $kind = [string](Get-VxProp $r 'kind')
                foreach ($t in @(Resolve-VxRegPattern $path)) {
                    $cur = $null
                    try { $cur = Get-VxRegValue $t $name }
                    catch {
                        # a key only Windows itself may read (e.g. the display class key 'Properties')
                        if (Test-VxAccessDenied $_) { continue }
                        throw
                    }
                    if (-not $cur.exists) { continue }
                    $k = $kind
                    if (-not $k) { $k = [string]$cur.kind }
                    if ($null -ne $def -and (Test-VxRegEqual $k $cur.value $def)) { continue }
                    $label = [string]$r.label
                    $seg = Get-VxWildSegment $path $t
                    if ($seg) { $label = $label + ' (' + $seg + ')' }
                    $item = New-VxDetweakItem ('reg|' + $t + '|' + $name) 'detweak' $null $label ([string]$r.group) (Format-VxRegValue $cur.value ([string]$cur.kind) $true) (Format-VxRegValue $def $k ($null -ne $def)) 'reg' @{ path = $t; name = $name; kind = $kind; default = $def }
                    & $addItem $item
                }
            } catch { Write-VxLog 'warn' ("Detweak-Eintrag {0} nicht lesbar: {1}" -f $r.name, $_.Exception.Message) }
        }
        foreach ($r in @(Get-VxProp $dt 'registryKeys' @())) {
            Test-VxCancel
            try {
                $path = [string]$r.path
                foreach ($t in @(Resolve-VxRegPattern $path)) {
                    try {
                        if (-not (Test-VxRegKey $t)) { continue }
                        # listed only when something in it is not explained by VELOX's own tweaks or
                        # boosts - resetting deletes the whole key, which would undo those as well
                        if (@(Get-VxRegSubKeys $t).Count -eq 0) {
                            $foreign = @(@(Get-VxRegValueNames $t) | Where-Object { -not (& $isExplained $t ([string]$_)) })
                            if ($foreign.Count -eq 0) { continue }
                        }
                    } catch {
                        if (Test-VxAccessDenied $_) { continue }
                        throw
                    }
                    $label = [string]$r.label
                    $seg = Get-VxWildSegment $path $t
                    if ($seg) { $label = $label + ' (' + $seg + ')' }
                    & $addItem (New-VxDetweakItem ('regkey|' + $t) 'detweak' $null $label ([string]$r.group) 'vorhanden' 'nicht vorhanden' 'regkey' @{ path = $t })
                }
            } catch { Write-VxLog 'warn' ("Detweak-Schlüssel {0} nicht lesbar: {1}" -f $r.path, $_.Exception.Message) }
        }
        Set-VxProgress ($ProgressFrom + $span * 0.8) 'Prüfe Boot-Einstellungen, Dienste und Aufgaben ...'
        $bcdOk = $true
        foreach ($b in @(Get-VxProp $dt 'bcd' @())) {
            if (-not $bcdOk) { break }
            try {
                $cur = Get-VxBcdValue ([string]$b.name)
                if ($null -ne $cur) {
                    & $addItem (New-VxDetweakItem ('bcd|' + $b.name) 'detweak' $null ([string]$b.label) ([string]$b.group) ([string]$cur) 'nicht gesetzt' 'bcd' @{ name = [string]$b.name })
                }
            } catch {
                $bcdOk = $false
                Write-VxLog 'warn' ('Boot-Einstellungen nicht lesbar: ' + $_.Exception.Message)
            }
        }
        foreach ($s in @(Get-VxProp $dt 'services' @())) {
            try {
                $cur = Get-VxServiceStart ([string]$s.name)
                if ($null -eq $cur) { continue }
                $def = [string](Get-VxActionDefault $s)
                if ($cur -eq $def) { continue }
                & $addItem (New-VxDetweakItem ('svc|' + $s.name) 'detweak' $null ([string]$s.label) ([string]$s.group) (Get-VxStartLabel $cur) (Get-VxStartLabel $def) 'svc' @{ name = [string]$s.name; default = $def })
            } catch { Write-VxLog 'warn' ("Dienst {0} nicht lesbar: {1}" -f $s.name, $_.Exception.Message) }
        }
        foreach ($tk in @(Get-VxProp $dt 'tasks' @())) {
            try {
                $cur = Get-VxTaskState ([string]$tk.path)
                if ($null -eq $cur) { continue }
                $def = [bool](Get-VxProp $tk 'default' $true)
                if ([bool]$cur -eq $def) { continue }
                $lbl = [string](Get-VxProp $tk 'label' '')
                if (-not $lbl) { $lbl = [string]$tk.path }
                $grp = [string](Get-VxProp $tk 'group' 'Aufgaben')
                $curText = 'deaktiviert'; if ($cur) { $curText = 'aktiv' }
                $defText = 'deaktiviert'; if ($def) { $defText = 'aktiv' }
                & $addItem (New-VxDetweakItem ('task|' + $tk.path) 'detweak' $null $lbl $grp $curText $defText 'task' @{ path = [string]$tk.path; default = $def })
            } catch { Write-VxLog 'warn' ("Aufgabe {0} nicht lesbar: {1}" -f $tk.path, $_.Exception.Message) }
        }
    }
    $commands = New-Object System.Collections.ArrayList
    if ($null -ne $dt) {
        foreach ($c in @(Get-VxProp $dt 'commands' @())) {
            [void]$commands.Add([ordered]@{
                    id = [string]$c.id; label = [string]$c.label; desc = [string](Get-VxProp $c 'desc' '')
                    defaultOn = [bool](Get-VxProp $c 'defaultOn' $false); needs = [string](Get-VxProp $c 'needs' 'none')
                    risk = [string](Get-VxProp $c 'risk' 'safe')
                })
        }
    }
    return @{ items = $items.ToArray(); commands = $commands.ToArray() }
}

function ConvertTo-VxDetweakDto($Item) {
    return [ordered]@{
        key = $Item.key; source = $Item.source; tweakId = $Item.tweakId; label = $Item.label; group = $Item.group
        current = $Item.current; default = $Item.default
    }
}

function Set-VxForeignCount([int]$Count) {
    $st = $global:VxCtx.State
    if ($null -ne $st.profile) {
        if ($st.profile -is [System.Collections.IDictionary]) { $st.profile['foreignCount'] = $Count }
        else { $st.profile | Add-Member -NotePropertyName 'foreignCount' -NotePropertyValue $Count -Force }
    }
    $st.foreignCount = $Count
}

# The detweak job reuses the items of the last scan when nothing changed the system since
# (ChangeGen counts finished system-changing jobs) - the full scan is the slow part on a real PC.
function Set-VxDetweakScanCache($Items) {
    $ctx = $global:VxCtx
    $map = @{}
    foreach ($it in @($Items)) { $map[([string]$it.key).ToLowerInvariant()] = $it }
    $ctx.DetweakScanCache = @{ at = [DateTime]::UtcNow; gen = [int]$ctx.ChangeGen; map = $map; simulate = [bool]$ctx.Simulate }
}

function Get-VxDetweakScanCache {
    $ctx = $global:VxCtx
    $c = Get-VxProp $ctx 'DetweakScanCache'
    if ($null -eq $c) { return $null }
    if ([int]$c.gen -ne [int]$ctx.ChangeGen -or [bool]$c.simulate -ne [bool]$ctx.Simulate) { return $null }
    if (([DateTime]::UtcNow - [DateTime]$c.at).TotalMinutes -gt 30) { return $null }
    return $c.map
}

function Invoke-VxDetweakScanJob($Params) {
    $scan = Get-VxDetweakScan -ProgressFrom 0.02 -ProgressTo 0.95
    Set-VxDetweakScanCache $scan.items
    $items = @($scan.items | ForEach-Object { ConvertTo-VxDetweakDto $_ })
    # VELOX's own tweaks are listed (they can be reset too) but are not foreign
    $foreign = @($scan.items | Where-Object { $_.source -ne 'velox' } | ForEach-Object { [string]$_.key })
    Set-VxForeignKeys $foreign
    Save-VxState
    $nOwn = $items.Count - $foreign.Count
    $nCat = @($scan.items | Where-Object { $_.source -eq 'catalog' }).Count
    Write-VxLog 'info' ("{0} Fremd-Tweaks gefunden ({1} geänderte VELOX-Einstellungen, {2} typische Fremd-Tweaks), {3} von VELOX selbst gesetzt." -f $foreign.Count, $nCat, ($foreign.Count - $nCat), $nOwn)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ items = $items; commands = @($scan.commands); foreignCount = $foreign.Count }
}

function Invoke-VxDetweakJob($Params) {
    $ctx = $global:VxCtx
    $keys = @(@(Get-VxProp $Params 'keys' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ })
    $cmdIds = @(@(Get-VxProp $Params 'commands' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ })
    $thenApply = @(@(Get-VxProp $Params 'thenApply' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ } | Select-Object -Unique)
    # restorePoint (checkbox in older UIs): false = no extra point for this job. It never forces
    # one any more - the policy in settings.restorePoints decides (Invoke-VxAutoRestorePoint).
    $allowRp = [bool](Get-VxProp $Params 'restorePoint' $true)
    $label = 'Detweak: fremde Tweaks zurückgesetzt'
    $J = New-VxJournal 'detweak' $label
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Set-VxProgress 0.02 'Bereite Detweak vor ...'
    $purpose = ''
    if ($allowRp) { $purpose = 'detweak' }
    Invoke-VxAutoRestorePoint 'Detweak' $J $false $purpose ($keys.Count + $thenApply.Count)
    $rpMs = [int]$sw.ElapsedMilliseconds
    $sw.Restart()

    # power plan tweaks are reverted after, and applied before, everything else (power settings
    # belong to a plan - see Get-VxPowerOrderedIds)
    $planKeys = @($keys | Where-Object { $_ -like 'tweak|*' -and (Test-VxTweakHasAction (Get-VxTweak $_.Substring(6)) 'powerplan') })
    $keys = @(@($keys | Where-Object { $planKeys -notcontains $_ }) + $planKeys)
    $thenApply = @(Get-VxPowerOrderedIds $thenApply 'apply')
    $map = Get-VxDetweakScanCache
    $scan = $null
    if ($null -eq $map) {
        Set-VxProgress 0.05 'Prüfe noch einmal, was zurückgesetzt werden muss ...'
        $scan = Get-VxDetweakScan -ProgressFrom 0.05 -ProgressTo 0.3
        $map = @{}
        foreach ($it in $scan.items) { $map[$it.key.ToLowerInvariant()] = $it }
    } else {
        Write-VxFileLog 'info' 'Detweak: Ergebnis der letzten Suche wiederverwendet (seitdem nichts geändert).'
    }
    $scanMs = [int]$sw.ElapsedMilliseconds
    $sw.Restart()
    $skipped = 0
    $reset = 0
    $resetValues = 0
    $commandsRun = 0
    $failed = 0
    $applied = 0
    $doneKeys = New-Object System.Collections.ArrayList
    $appliedTweaks = New-Object System.Collections.ArrayList
    $errors = New-Object System.Collections.Generic.List[string]
    $needsTweaks = New-Object System.Collections.ArrayList
    $extraNeeds = @()
    $n = 0
    $total = [math]::Max(1, $keys.Count + $cmdIds.Count + $thenApply.Count)
    try {
        foreach ($key in $keys) {
            Test-VxCancel
            $n++
            $it = $map[$key.ToLowerInvariant()]
            if ($null -eq $it) { Write-VxLog 'info' ("{0}: ist schon auf Standard" -f $key); continue }
            Set-VxProgress (0.3 + 0.6 * $n / $total) ('Setze zurück: ' + $it.label)
            try {
                $d = $it.data
                switch ($it.type) {
                    'reg' {
                        $kind = [string]$d.kind
                        if ($null -ne $d.default -and -not $kind) { throw 'Typ des Standardwerts unbekannt.' }
                        $null = Set-VxRegJ $J $d.path $d.name $kind $d.default 'detweak'
                    }
                    'regkey' { $null = Set-VxRegKeyJ $J $d.path $false 'detweak' }
                    'bcd' { $null = Set-VxBcdJ $J $d.name $null 'detweak' }
                    'svc' {
                        $startNow = ($d.default -eq 'Automatic' -or $d.default -eq 'AutomaticDelayed')
                        $null = Set-VxServiceJ $J $d.name $d.default ($d.default -eq 'Disabled') $startNow 'detweak'
                    }
                    'task' { $null = Set-VxTaskJ $J $d.path ([bool]$d.default) 'detweak' }
                    'tweak' {
                        $t = Get-VxTweak $d
                        $r = Invoke-VxTweakChange $t 'revert' $J
                        if (-not $r.ok) { throw $r.error }
                        if ($r.changed -gt 0) { [void]$needsTweaks.Add($t) }
                    }
                }
                $reset++
                $resetValues++
                [void]$doneKeys.Add($key)
                Write-VxLog 'ok' ('Zurückgesetzt: ' + $it.label)
            } catch {
                if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
                $failed++
                $m = $it.label + ': ' + (Get-VxErrorText $_)
                $errors.Add($m)
                Write-VxLog 'error' $m
            }
        }
        foreach ($cid in $cmdIds) {
            Test-VxCancel
            $n++
            $cmd = @(@(Get-VxProp $ctx.Catalog.detweak 'commands' @()) | Where-Object { [string]$_.id -eq $cid })[0]
            if ($null -eq $cmd) { $errors.Add("Unbekannter Befehl '$cid'"); $failed++; continue }
            $stepText = 'Führe aus: ' + $cmd.label
            Set-VxProgress (0.3 + 0.6 * $n / $total) $stepText
            Add-VxJournalEntry $J ([ordered]@{ op = 'cmd'; id = $cid; label = [string]$cmd.label; restorable = $false })
            try {
                if ($ctx.Simulate -and -not (Get-VxProp $ctx 'SimCommandScript')) { Write-VxLog 'info' ("[Testmodus] Befehl '{0}' nur protokolliert" -f $cmd.label) }
                else {
                    # own powershell.exe with a hard timeout and "Überspringen": a reset command that
                    # hangs (network stack, Defender, page file ...) can never block the job
                    $src = [string]$cmd.script
                    if ($ctx.Simulate) { $src = [string]$ctx.SimCommandScript }
                    $limit = [int](Get-VxProp $cmd 'timeoutSec' 120)
                    $ov = [int](Get-VxProp $ctx 'CommandTimeoutSec' 0)
                    if ($ov -gt 0) { $limit = $ov }
                    $x = Invoke-VxIsolated -Script $src -TimeoutSec $limit -Skippable -Step $stepText
                    try { Clear-VxCacheFor $src } catch { $null = $_ }
                    Write-VxFileLog 'info' ("Detweak-Befehl {0}: {1} ms, Code {2}" -f $cid, $x.ms, $x.exitCode)
                    if ($x.skipped) {
                        $skipped++
                        $errors.Add([string]$cmd.label + ': übersprungen')
                        Write-VxLog 'warn' ([string]$cmd.label + ': übersprungen.')
                        continue
                    }
                    if ($x.timedOut) { throw ('Hat länger als {0} s gedauert und wurde abgebrochen.' -f $limit) }
                    if (-not $x.ok) {
                        $why = ([string]$x.error).Trim()
                        if (-not $why) { $why = 'Fehlercode ' + $x.exitCode }
                        throw $why
                    }
                    Write-VxLog 'ok' ('Ausgeführt: ' + $cmd.label)
                }
                $extraNeeds += [string](Get-VxProp $cmd 'needs' 'none')
                $reset++
                $commandsRun++
            } catch {
                if ([string]$_.Exception.Message -eq 'VX_CANCELLED') { throw }
                $failed++
                $m = [string]$cmd.label + ': ' + (Get-VxErrorText $_)
                $errors.Add($m)
                Write-VxLog 'error' $m
            }
        }
        foreach ($id in $thenApply) {
            Test-VxCancel
            $n++
            $t = Get-VxTweak $id
            if ($null -eq $t) { continue }
            Set-VxProgress (0.3 + 0.6 * $n / $total) ('Wende an: ' + $t.name)
            $r = Invoke-VxTweakChange $t 'apply' $J
            if ($r.ok) { $applied++; if ($r.changed -gt 0) { [void]$needsTweaks.Add($t); [void]$appliedTweaks.Add($t) }; Write-VxLog 'ok' ('Angewendet: ' + $t.name) }
            else { $failed++; $errors.Add($t.name + ': ' + $r.error); Write-VxLog 'error' ($t.name + ': ' + $r.error) }
        }
    } finally {
        $workMs = [int]$sw.ElapsedMilliseconds
        $sw.Restart()
        $backupId = Complete-VxJournal $J
        # only the tweaks this job can have changed are read again, not the whole catalog
        $refresh = @(Get-VxDetweakTouchedTweaks @($doneKeys.ToArray()) $thenApply ($commandsRun -gt 0))
        Set-VxProgress 0.93 ('Lese den neuen Stand von {0} Tweaks ...' -f $refresh.Count)
        try { if ($refresh.Count -gt 0) { Update-VxStatuses -Ids $refresh } } catch { $null = $_ }
        try { Sync-VxBoostedGames } catch { $null = $_ }
        $needs = Get-VxNeedsOf $needsTweaks.ToArray()
        foreach ($x in $extraNeeds) { if ($needs.Contains($x)) { $needs[$x] = $true } }
        # registry resets of foreign tweaks usually need a reboot to take effect
        if ($reset -gt 0 -and @($keys | Where-Object { -not $_.StartsWith('tweak|') }).Count -gt 0) { $needs.reboot = $true }
        foreach ($k in @('explorer', 'reboot', 'logoff')) { if ($needs[$k]) { Add-VxNeeds $k } }
        # foreign = the last scan's foreign tweaks minus what was just reset or applied by VELOX
        $st = $ctx.State
        if (-not $st.ContainsKey('foreignKeys') -or $null -eq $st.foreignKeys) {
            Set-VxForeignKeys @(@($map.Values) | Where-Object { $_.source -ne 'velox' } | ForEach-Object { [string]$_.key })
        }
        Update-VxForeignAfterChange @($doneKeys.ToArray())
        Update-VxForeignAfterTweaks $appliedTweaks.ToArray()
        Save-VxState
        Save-VxSim
        Write-VxFileLog 'info' ("detweak: {0} Werte, {1} Befehle, {2} Tweaks (Wiederherstellungspunkt {3} ms, Suche {4} ms, Änderungen {5} ms, Abschluss {6} ms, {7} Status neu gelesen)" -f $keys.Count, $cmdIds.Count, $thenApply.Count, $rpMs, $scanMs, $workMs, [int]$sw.ElapsedMilliseconds, $refresh.Count)
    }
    Set-VxProgress 1 'Fertig'
    # reset = values + commands (kept for older UIs); resetValues / commandsRun count them apart
    return [ordered]@{
        reset = $reset; resetValues = $resetValues; commandsRun = $commandsRun; failed = $failed; applied = $applied; skipped = $skipped
        backupId = $backupId; needs = $needs; errors = $errors.ToArray(); foreignCount = [int](Get-VxProp $ctx.State 'foreignCount' 0)
    }
}

# Catalog tweaks whose status a detweak job can have changed: the reverted / applied tweaks, every
# tweak that writes one of the reset targets, and after a reset command (power plans, network,
# boot settings ...) every tweak with a powerplan, powersetting, bcd or ps action.
function Get-VxDetweakTouchedTweaks([string[]]$Keys, [string[]]$ApplyIds, [bool]$CommandsRan) {
    $cat = $global:VxCtx.Catalog
    $ids = @{}
    $targets = @{}
    foreach ($k in @($Keys)) {
        $lk = ([string]$k).ToLowerInvariant()
        if ($lk.StartsWith('tweak|')) { $ids[$k.Substring(6)] = $true } else { $targets[$lk] = $true }
    }
    foreach ($id in @($ApplyIds)) { if ($id) { $ids[$id] = $true } }
    foreach ($t in @($cat.tweaks)) {
        if ((Get-VxTweakKind $t) -eq 'action') { continue }
        $id = [string]$t.id
        if ($ids.ContainsKey($id)) { continue }
        if ($CommandsRan) {
            foreach ($a in @($t.actions)) {
                if (@('powerplan', 'powersetting', 'bcd', 'ps') -contains [string](Get-VxProp $a 'type')) { $ids[$id] = $true; break }
            }
            if ($ids.ContainsKey($id)) { continue }
        }
        if ($targets.Count -eq 0) { continue }
        foreach ($tk in @(Get-VxTweakDetweakKeys $t)) { if ($targets.ContainsKey($tk)) { $ids[$id] = $true; break } }
    }
    return @($ids.Keys | Where-Object { $null -ne (Get-VxTweak $_) })
}
