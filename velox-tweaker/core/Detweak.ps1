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

function New-VxDetweakItem([string]$Key, [string]$Source, $TweakId, [string]$Label, [string]$Group, [string]$Current, [string]$Default, [string]$Type, $Data) {
    return @{
        key = $Key; source = $Source; tweakId = $TweakId; label = $Label; group = $Group
        current = $Current; default = $Default; type = $Type; data = $Data
    }
}

# Internal scan: returns @{ items = [...internal items...]; commands = [...] }.
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
    foreach ($t in $cat.tweaks) {
        if ((Get-VxTweakKind $t) -ne 'toggle') { continue }
        $id = [string]$t.id
        $st = [string]$ctx.State.statuses[$id]
        if (@('applied', 'partial', 'custom') -notcontains $st) { continue }
        $catName = [string](Get-VxProp $cat.categoryNames ([string]$t.category) ([string]$t.category))
        [void]$items.Add((New-VxDetweakItem ('tweak|' + $id) 'catalog' $id ([string]$t.name) $catName (Get-VxStatusLabel $st) 'Windows-Standard' 'tweak' $id))
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

function Invoke-VxDetweakScanJob($Params) {
    $scan = Get-VxDetweakScan -ProgressFrom 0.02 -ProgressTo 0.95
    $items = @($scan.items | ForEach-Object { ConvertTo-VxDetweakDto $_ })
    Set-VxForeignCount $items.Count
    Save-VxState
    $nCat = @($scan.items | Where-Object { $_.source -eq 'catalog' }).Count
    Write-VxLog 'info' ("{0} Abweichungen gefunden ({1} aus dem VELOX-Katalog, {2} typische Fremd-Tweaks)." -f $items.Count, $nCat, ($items.Count - $nCat))
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ items = $items; commands = @($scan.commands) }
}

function Invoke-VxDetweakJob($Params) {
    $ctx = $global:VxCtx
    $keys = @(@(Get-VxProp $Params 'keys' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ })
    $cmdIds = @(@(Get-VxProp $Params 'commands' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ })
    $thenApply = @(@(Get-VxProp $Params 'thenApply' @()) | ForEach-Object { [string]$_ } | Where-Object { $_ } | Select-Object -Unique)
    $wantRp = [bool](Get-VxProp $Params 'restorePoint' $false)
    $label = 'Detweak: fremde Tweaks zurückgesetzt'
    $J = New-VxJournal 'detweak' $label
    Set-VxProgress 0.02 'Bereite Detweak vor ...'
    Invoke-VxAutoRestorePoint 'Detweak' $J $wantRp

    # power plan tweaks are reverted after, and applied before, everything else (power settings
    # belong to a plan - see Get-VxPowerOrderedIds)
    $planKeys = @($keys | Where-Object { $_ -like 'tweak|*' -and (Test-VxTweakHasAction (Get-VxTweak $_.Substring(6)) 'powerplan') })
    $keys = @(@($keys | Where-Object { $planKeys -notcontains $_ }) + $planKeys)
    $thenApply = @(Get-VxPowerOrderedIds $thenApply 'apply')
    $scan = Get-VxDetweakScan -ProgressFrom 0.05 -ProgressTo 0.3
    $map = @{}
    foreach ($it in $scan.items) { $map[$it.key.ToLowerInvariant()] = $it }
    $reset = 0
    $failed = 0
    $applied = 0
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
            Set-VxProgress (0.3 + 0.6 * $n / $total) ('Führe aus: ' + $cmd.label)
            Add-VxJournalEntry $J ([ordered]@{ op = 'cmd'; id = $cid; label = [string]$cmd.label; restorable = $false })
            try {
                if ($ctx.Simulate) { Write-VxLog 'info' ("[Testmodus] Befehl '{0}' nur protokolliert" -f $cmd.label) }
                else { $null = Invoke-VxPsSource ([string]$cmd.script); Write-VxLog 'ok' ('Ausgeführt: ' + $cmd.label) }
                $extraNeeds += [string](Get-VxProp $cmd 'needs' 'none')
                $reset++
            } catch {
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
            if ($r.ok) { $applied++; if ($r.changed -gt 0) { [void]$needsTweaks.Add($t) }; Write-VxLog 'ok' ('Angewendet: ' + $t.name) }
            else { $failed++; $errors.Add($t.name + ': ' + $r.error); Write-VxLog 'error' ($t.name + ': ' + $r.error) }
        }
    } finally {
        $backupId = Complete-VxJournal $J
        Set-VxProgress 0.93 'Aktualisiere Status ...'
        try { Update-VxStatuses } catch { $null = $_ }
        try { Sync-VxBoostedGames } catch { $null = $_ }
        $needs = Get-VxNeedsOf $needsTweaks.ToArray()
        foreach ($x in $extraNeeds) { if ($needs.Contains($x)) { $needs[$x] = $true } }
        # registry resets of foreign tweaks usually need a reboot to take effect
        if ($reset -gt 0 -and @($keys | Where-Object { -not $_.StartsWith('tweak|') }).Count -gt 0) { $needs.reboot = $true }
        foreach ($k in @('explorer', 'reboot', 'logoff')) { if ($needs[$k]) { Add-VxNeeds $k } }
        $left = [int](Get-VxProp $ctx.State 'foreignCount' $scan.items.Count) - $reset
        if ($left -lt 0) { $left = 0 }
        Set-VxForeignCount $left
        Save-VxState
        Save-VxSim
    }
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ reset = $reset; failed = $failed; applied = $applied; backupId = $backupId; needs = $needs; errors = $errors.ToArray() }
}
