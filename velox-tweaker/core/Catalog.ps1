# VELOX - core/Catalog.ps1
# Loads and indexes data/*.json, evaluates applicability ("when") and aggregates tweak status.
# Only function definitions.

function Import-VxCatalog {
    param([string]$DataDir = '')
    $ctx = $global:VxCtx
    if (-not $DataDir) { $DataDir = $ctx.DataDir }
    $cat = @{
        categories = @(); tweaks = (New-Object System.Collections.ArrayList); byId = @{}
        presets = @(); detweak = $null; errors = (New-Object System.Collections.Generic.List[string])
        categoryNames = @{}
    }
    # categories
    $cf = [IO.Path]::Combine($DataDir, 'categories.json')
    if ([IO.File]::Exists($cf)) {
        try {
            $doc = Read-VxJsonFile $cf
            $cat.categories = @(@($doc.categories) | Sort-Object { [int](Get-VxProp $_ 'order' 99) })
            foreach ($c in $cat.categories) { $cat.categoryNames[[string]$c.id] = [string]$c.name }
        } catch { $cat.errors.Add('categories.json: ' + $_.Exception.Message) }
    } else { $cat.errors.Add('categories.json fehlt') }

    # tweaks, in category order, then file name
    $tdir = [IO.Path]::Combine($DataDir, 'tweaks')
    $files = @()
    if ([IO.Directory]::Exists($tdir)) { $files = @(Get-ChildItem -LiteralPath $tdir -Filter '*.json' -File | Sort-Object Name) }
    $order = @{}
    $i = 0
    foreach ($c in $cat.categories) { $order[[string]$c.id] = $i; $i++ }
    $files = @($files | Sort-Object { $n = [IO.Path]::GetFileNameWithoutExtension($_.Name); if ($order.ContainsKey($n)) { $order[$n] } else { 999 } }, Name)
    foreach ($f in $files) {
        try {
            $doc = Read-VxJsonFile $f.FullName
            $category = [string](Get-VxProp $doc 'category')
            if (-not $category) { $category = [IO.Path]::GetFileNameWithoutExtension($f.Name) }
            foreach ($t in @(Get-VxProp $doc 'tweaks' @())) {
                if ($null -eq $t) { continue }
                $id = [string](Get-VxProp $t 'id')
                if (-not $id) { $cat.errors.Add("$($f.Name): Tweak ohne id"); continue }
                if ($cat.byId.ContainsKey($id)) { $cat.errors.Add("$($f.Name): doppelte id $id"); continue }
                if (-not (Test-VxProp $t 'category')) { Add-Member -InputObject $t -NotePropertyName 'category' -NotePropertyValue $category }
                if (-not (Test-VxProp $t 'kind')) { Add-Member -InputObject $t -NotePropertyName 'kind' -NotePropertyValue 'toggle' }
                if (-not (Test-VxProp $t 'actions')) { Add-Member -InputObject $t -NotePropertyName 'actions' -NotePropertyValue @() }
                if (-not (Test-VxProp $t 'tags')) { Add-Member -InputObject $t -NotePropertyName 'tags' -NotePropertyValue @() }
                [void]$cat.tweaks.Add($t)
                $cat.byId[$id] = $t
            }
        } catch { $cat.errors.Add("$($f.Name): " + $_.Exception.Message) }
    }

    $pf = [IO.Path]::Combine($DataDir, 'presets.json')
    if ([IO.File]::Exists($pf)) {
        try { $cat.presets = @((Read-VxJsonFile $pf).presets) } catch { $cat.errors.Add('presets.json: ' + $_.Exception.Message) }
    }
    $df = [IO.Path]::Combine($DataDir, 'detweak.json')
    if ([IO.File]::Exists($df)) {
        try { $cat.detweak = Read-VxJsonFile $df } catch { $cat.errors.Add('detweak.json: ' + $_.Exception.Message) }
    }
    $ctx.Catalog = $cat
    foreach ($e in $cat.errors) { Write-VxLog 'warn' ('Katalog: ' + $e) }
    Initialize-VxSeedIndex
    return $cat
}

function Get-VxTweak([string]$Id) {
    $cat = $global:VxCtx.Catalog
    if ($null -eq $cat -or -not $cat.byId.ContainsKey($Id)) { return $null }
    return $cat.byId[$Id]
}

function Get-VxTweakKind($Tweak) {
    $k = [string](Get-VxProp $Tweak 'kind' 'toggle')
    if (-not $k) { $k = 'toggle' }
    return $k
}

# Default of an action/entry, honouring defaultWin11 on Windows 11.
function Get-VxActionDefault($Action, [string]$Field = 'default') {
    if ($global:VxCtx.IsWin11 -and (Test-VxProp $Action ($Field + 'Win11'))) { return (Get-VxProp $Action ($Field + 'Win11')) }
    return (Get-VxProp $Action $Field)
}

function ConvertTo-VxKeyRegex([string]$Pattern) {
    $parts = $Pattern.ToLowerInvariant().Split('\') | ForEach-Object { if ($_ -eq '*') { '[^\\]+' } else { [regex]::Escape($_) } }
    return ('^' + ($parts -join '\\') + '$')
}

# Index of Windows defaults used by the simulated (non-Windows) base state.
function Initialize-VxSeedIndex {
    $ctx = $global:VxCtx
    $seed = @{
        values = @{}; wildValues = (New-Object System.Collections.ArrayList); keys = @{}; keyNames = @{}
        wildParents = @{}; regkeys = (New-Object System.Collections.ArrayList); noKeys = (New-Object System.Collections.Generic.List[string])
        services = @{}; tasks = @{}
    }
    $addKey = {
        param([string]$p)
        $q = $p
        while ($q -and $q.Contains('\')) {
            $l = $q.ToLowerInvariant()
            if (-not $seed.keys.ContainsKey($l)) { $seed.keys[$l] = $true; $seed.keyNames[$l] = $q }
            $q = Get-VxRegParent $q
        }
    }
    $addValue = {
        param([string]$path, [string]$name, [string]$kind, $default)
        if ($path.Contains('*')) {
            $star = $path.Split('\')
            $idx = [Array]::IndexOf($star, '*')
            $parent = ($star[0..($idx - 1)] -join '\')
            [void]$seed.wildValues.Add(@{ keyRegex = (ConvertTo-VxKeyRegex $path); name = $name.ToLowerInvariant(); origName = $name; kind = $kind; default = $default })
            # the level of the '*' always has some subkeys on a real system (adapters, interfaces ...)
            $seed.wildParents[$parent.ToLowerInvariant()] = $true
            & $addKey $parent
        } else {
            $k = ($path + '|' + $name).ToLowerInvariant()
            if (-not $seed.values.ContainsKey($k)) {
                $seed.values[$k] = @{ kind = $kind; default = $default; name = $name; lpath = $path.ToLowerInvariant() }
                if ($null -ne $default) { & $addKey $path }
            }
        }
    }
    $cat = $ctx.Catalog
    if ($null -ne $cat) {
        foreach ($t in $cat.tweaks) {
            foreach ($a in @($t.actions)) {
                $type = [string](Get-VxProp $a 'type')
                switch ($type) {
                    'reg' { & $addValue ([string]$a.path) ([string]$a.name) ([string]$a.kind) (Get-VxActionDefault $a) }
                    'regkey' {
                        [void]$seed.regkeys.Add(@{ regex = (ConvertTo-VxKeyRegex ([string]$a.path)); default = [bool](Get-VxProp $a 'default') })
                        if ((Get-VxProp $a 'default') -eq $true -and -not ([string]$a.path).Contains('*')) { & $addKey ([string]$a.path) }
                    }
                    'service' { $seed.services[([string]$a.name).ToLowerInvariant()] = [string](Get-VxActionDefault $a) }
                    'task' { $seed.tasks[([string]$a.path).ToLowerInvariant()] = [bool](Get-VxProp $a 'default') }
                }
            }
        }
        $dt = $cat.detweak
        if ($null -ne $dt) {
            foreach ($r in @(Get-VxProp $dt 'registry' @())) {
                & $addValue ([string]$r.path) ([string]$r.name) ([string](Get-VxProp $r 'kind')) (Get-VxActionDefault $r)
            }
            foreach ($r in @(Get-VxProp $dt 'registryKeys' @())) { $seed.noKeys.Add((ConvertTo-VxKeyRegex ([string]$r.path))) }
            foreach ($s in @(Get-VxProp $dt 'services' @())) {
                $k = ([string]$s.name).ToLowerInvariant()
                if (-not $seed.services.ContainsKey($k)) { $seed.services[$k] = [string](Get-VxActionDefault $s) }
            }
            foreach ($tk in @(Get-VxProp $dt 'tasks' @())) {
                $k = ([string]$tk.path).ToLowerInvariant()
                if (-not $seed.tasks.ContainsKey($k)) { $seed.tasks[$k] = [bool](Get-VxProp $tk 'default' $true) }
            }
        }
    }
    $ctx.Seed = $seed
}

# ------------------------------------------------------------------ applicability

function Get-VxProfileBuild($VxProfile) {
    $b = 0
    if ($null -ne $VxProfile) { $b = [int](Get-VxProp (Get-VxProp $VxProfile 'os') 'build' 0) }
    if ($b -le 0) { $b = [int]$global:VxCtx.Build }
    return $b
}

function Get-VxVendorName([string]$Vendor) {
    switch ($Vendor) { 'nvidia' { return 'NVIDIA' } 'amd' { return 'AMD' } 'intel' { return 'Intel' } }
    return $Vendor
}

# Evaluates a tweak's "when". -Live also checks services/packages on the system (slower).
# Returns @{ ok; reason }.
function Test-VxWhen($Tweak, $VxProfile, [bool]$Live = $true) {
    $ok = @{ ok = $true; reason = $null }
    if (-not (Test-VxProp $Tweak 'when')) { return $ok }
    $w = Get-VxProp $Tweak 'when'
    if ($null -eq $w) { return $ok }
    $build = Get-VxProfileBuild $VxProfile
    $os = [string](Get-VxProp $w 'os')
    if ($os -eq 'win11' -and $build -gt 0 -and $build -lt 22000) { return @{ ok = $false; reason = 'Nur für Windows 11.' } }
    if ($os -eq 'win10' -and $build -ge 22000) { return @{ ok = $false; reason = 'Nur für Windows 10.' } }
    if ((Test-VxProp $w 'minBuild') -and $build -gt 0 -and $build -lt [int]$w.minBuild) {
        return @{ ok = $false; reason = ('Braucht eine neuere Windows-Version (ab Build {0}).' -f $w.minBuild) }
    }
    if ((Test-VxProp $w 'maxBuild') -and $build -gt [int]$w.maxBuild) {
        return @{ ok = $false; reason = ('Nur für ältere Windows-Versionen (bis Build {0}).' -f $w.maxBuild) }
    }
    if ($null -ne $VxProfile) {
        $ff = [string](Get-VxProp $w 'formFactor')
        $pff = [string](Get-VxProp $VxProfile 'formFactor')
        if ($ff -and $pff -and $ff -ne $pff) {
            if ($ff -eq 'laptop') { return @{ ok = $false; reason = 'Nur für Laptops.' } }
            return @{ ok = $false; reason = 'Nur für Desktop-PCs.' }
        }
        $gv = [string](Get-VxProp $w 'gpuVendor')
        if ($gv) {
            $gpus = @(Get-VxProp $VxProfile 'gpus' @())
            $match = @($gpus | Where-Object { [string](Get-VxProp $_ 'vendor') -eq $gv })
            if ($gpus.Count -gt 0 -and $match.Count -eq 0) { return @{ ok = $false; reason = ('Nur für {0}-Grafikkarten.' -f (Get-VxVendorName $gv)) } }
        }
        $cv = [string](Get-VxProp $w 'cpuVendor')
        $pcv = [string](Get-VxProp (Get-VxProp $VxProfile 'cpu') 'vendor')
        if ($cv -and $pcv -and $pcv -ne 'unknown' -and $cv -ne $pcv) { return @{ ok = $false; reason = ('Nur für {0}-Prozessoren.' -f (Get-VxVendorName $cv)) } }
        $sd = [string](Get-VxProp $w 'systemDisk')
        $psd = [string](Get-VxProp $VxProfile 'systemDisk')
        if ($sd -and $psd -and $psd -ne 'unknown' -and $sd -ne $psd) {
            if ($sd -eq 'ssd') { return @{ ok = $false; reason = 'Nur wenn Windows auf einer SSD liegt.' } }
            return @{ ok = $false; reason = 'Nur wenn Windows auf einer Festplatte (HDD) liegt.' }
        }
        $ram = [double](Get-VxProp (Get-VxProp $VxProfile 'ram') 'totalGB' 0)
        if ($ram -gt 0) {
            if ((Test-VxProp $w 'minRamGB') -and $ram -lt [double]$w.minRamGB) { return @{ ok = $false; reason = ('Braucht mindestens {0} GB Arbeitsspeicher.' -f $w.minRamGB) } }
            if ((Test-VxProp $w 'maxRamGB') -and $ram -gt [double]$w.maxRamGB) { return @{ ok = $false; reason = ('Nur bei höchstens {0} GB Arbeitsspeicher sinnvoll.' -f $w.maxRamGB) } }
        }
    }
    if ($Live) {
        $svc = [string](Get-VxProp $w 'service')
        if ($svc) {
            $st = $null
            try { $st = Get-VxServiceStart $svc } catch { $st = $null }
            if ($null -eq $st) { return @{ ok = $false; reason = ("Der Dienst '{0}' ist auf diesem PC nicht vorhanden." -f $svc) } }
        }
        $pkg = [string](Get-VxProp $w 'package')
        if ($pkg -and (Get-VxTweakKind $Tweak) -ne 'remove') {
            $inst = Test-VxAppxInstalled $pkg
            if ($inst -eq $false) { return @{ ok = $false; reason = 'Die App ist nicht installiert.' } }
        }
    }
    return $ok
}

# ------------------------------------------------------------------ status

# Aggregates per-target states ('applied','default','other','na','unknown') to a tweak status.
function Merge-VxStates([string[]]$States) {
    $s = @($States | Where-Object { $_ -and $_ -ne 'na' })
    if ($s.Count -eq 0) { return 'na' }
    $known = @($s | Where-Object { $_ -ne 'unknown' })
    if ($known.Count -eq 0) { return 'unknown' }
    if (@($known | Where-Object { $_ -eq 'other' }).Count -gt 0) { return 'custom' }
    $applied = @($known | Where-Object { $_ -eq 'applied' }).Count
    $default = @($known | Where-Object { $_ -eq 'default' }).Count
    if ($applied -gt 0 -and $default -eq 0) { return 'applied' }
    if ($default -gt 0 -and $applied -eq 0) { return 'default' }
    return 'partial'
}

# Returns @{ status; naReason } for one tweak. Kind "action" -> $null (no status).
function Get-VxTweakStatus($Tweak, $VxProfile = $null) {
    $kind = Get-VxTweakKind $Tweak
    if ($kind -eq 'action') { return $null }
    if ($null -eq $VxProfile) { $VxProfile = $global:VxCtx.State.profile }
    $w = Test-VxWhen $Tweak $VxProfile $true
    if (-not $w.ok) { return @{ status = 'na'; naReason = $w.reason } }
    $states = New-Object System.Collections.Generic.List[string]
    $idx = 0
    foreach ($a in @($Tweak.actions)) {
        $ai = $idx
        $idx++
        try {
            foreach ($s in @(Get-VxActionState $a $Tweak $ai)) { $states.Add([string]$s) }
        } catch {
            Write-VxLog 'warn' ("Status von '{0}' nicht lesbar: {1}" -f $Tweak.id, $_.Exception.Message)
            $states.Add('unknown')
        }
    }
    $status = Merge-VxStates $states.ToArray()
    $reason = $null
    if ($status -eq 'na') { $reason = 'Auf diesem PC nicht vorhanden.' }
    return @{ status = $status; naReason = $reason }
}

# Detects all (or the given) tweaks and stores the result in state.statuses / state.naReasons.
function Update-VxStatuses {
    param([string[]]$Ids = $null, [double]$ProgressFrom = -1, [double]$ProgressTo = -1)
    $ctx = $global:VxCtx
    $cat = $ctx.Catalog
    $list = @()
    if ($null -eq $Ids) { $list = @($cat.tweaks) } else { $list = @($Ids | ForEach-Object { Get-VxTweak $_ } | Where-Object { $null -ne $_ }) }
    $n = 0
    $total = [math]::Max(1, $list.Count)
    foreach ($t in $list) {
        $n++
        if ($ProgressFrom -ge 0 -and ($n % 10 -eq 0)) {
            Test-VxCancel
            Set-VxProgress ($ProgressFrom + ($ProgressTo - $ProgressFrom) * $n / $total)
        }
        $r = Get-VxTweakStatus $t
        if ($null -eq $r) { continue }
        $ctx.State.statuses[[string]$t.id] = $r.status
        if ($r.naReason) { $ctx.State.naReasons[[string]$t.id] = $r.naReason } else { $ctx.State.naReasons.Remove([string]$t.id) }
    }
    # drop statuses of tweaks that no longer exist
    if ($null -eq $Ids) {
        foreach ($k in @($ctx.State.statuses.Keys)) { if (-not $cat.byId.ContainsKey($k)) { $ctx.State.statuses.Remove($k) } }
    }
}

# Catalog tweak as sent to the UI: all catalog fields + category, applicable, naReason.
function ConvertTo-VxTweakDto($Tweak, $VxProfile) {
    $o = [ordered]@{}
    foreach ($p in $Tweak.PSObject.Properties) { $o[$p.Name] = $p.Value }
    $w = Test-VxWhen $Tweak $VxProfile $false
    $reason = $w.reason
    $applicable = [bool]$w.ok
    if ($applicable) {
        $st = $global:VxCtx.State
        $id = [string]$Tweak.id
        if ($st.naReasons.ContainsKey($id) -and $st.statuses[$id] -eq 'na') { $applicable = $false; $reason = $st.naReasons[$id] }
    }
    $o['applicable'] = $applicable
    $o['naReason'] = $reason
    return $o
}

function Get-VxTweakDtos {
    $ctx = $global:VxCtx
    $prof = $ctx.State.profile
    $list = New-Object System.Collections.ArrayList
    foreach ($t in $ctx.Catalog.tweaks) { [void]$list.Add((ConvertTo-VxTweakDto $t $prof)) }
    return $list.ToArray()
}
