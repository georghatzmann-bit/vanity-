# VELOX - core/Advisor.ps1
# Offline expert system ("Smart-Analyse"): profile + statuses + catalog + goal + free text
# -> findings, plan, score. Deterministic: same input, same output.
# Only function definitions.

function Get-VxGoalConfig([string]$Goal) {
    switch ($Goal) {
        'competitive' {
            return @{ name = 'Esport / Low Latency'; core = @('fps', 'stutter', 'latency', 'input', 'network', 'ping', 'competitive'); coreRisk = 'moderate'
                safe = @('privacy', 'telemetry', 'ads', 'bloat'); exclude = $null; categories = @() }
        }
        'balanced' {
            return @{ name = 'Ausgewogen'; core = @('fps', 'stutter', 'latency', 'quality-of-life', 'privacy', 'telemetry', 'ads', 'bloat', 'ui', 'explorer', 'storage'); coreRisk = 'safe'
                safe = @(); exclude = $null; categories = @() }
        }
        'privacy' {
            return @{ name = 'Datenschutz'; core = @('privacy', 'telemetry', 'ads', 'ai'); coreRisk = 'moderate'
                safe = @('bloat'); exclude = $null; categories = @() }
        }
        'laptop' {
            return @{ name = 'Laptop & Akku'; core = @('battery'); coreRisk = 'moderate'
                safe = @('fps', 'stutter', 'privacy', 'telemetry', 'ads', 'bloat', 'quality-of-life'); exclude = $null; categories = @() }
        }
        'streaming' {
            return @{ name = 'Streaming'; core = @('fps', 'stutter', 'latency', 'streaming', 'network'); coreRisk = 'moderate'
                safe = @('privacy', 'telemetry', 'ads', 'bloat'); exclude = 'gamedvr|game-dvr|gamebar|game-bar|capture|xbox|dvr|broadcast'; categories = @() }
        }
        'fivem' {
            return @{ name = 'FiveM / GTA V'; core = @('fps', 'stutter', 'latency', 'fivem', 'gta'); coreRisk = 'moderate'
                safe = @('privacy', 'telemetry', 'ads', 'bloat'); exclude = $null; categories = @('games') }
        }
    }
    return @{ name = 'Gaming'; core = @('fps', 'stutter', 'latency'); coreRisk = 'moderate'
        safe = @('privacy', 'telemetry', 'ads', 'bloat'); exclude = $null; categories = @() }
}

# Free-text keywords -> extra tags.
function Get-VxTextTags([string]$Text) {
    $t = ([string]$Text).ToLowerInvariant()
    $tags = New-Object System.Collections.Generic.List[string]
    $map = @(
        @{ rx = 'ruckel|ruckl|stutter|lag|hänger|haenger|freeze|microruckler|mikroruckler'; tags = @('stutter') },
        @{ rx = 'ping|verbindung|netz|internet|wlan|wifi|lan|packet|paket'; tags = @('network', 'ping') },
        @{ rx = 'input|maus|mouse|delay|verzögerung|verzoegerung|tastatur|latenz|latency'; tags = @('input', 'latency') },
        @{ rx = 'akku|batterie|battery|laufzeit'; tags = @('battery') },
        @{ rx = 'fivem|gta|five m|rage'; tags = @('fivem', 'gta') },
        @{ rx = 'datenschutz|telemetrie|privacy|tracking|spionage'; tags = @('privacy', 'telemetry') },
        @{ rx = 'werbung|ads|reklame'; tags = @('ads') },
        @{ rx = 'fps|bilder pro sekunde|frames'; tags = @('fps') },
        @{ rx = 'stream|obs|twitch'; tags = @('streaming') },
        @{ rx = 'copilot|recall|\bki\b|\bai\b'; tags = @('ai') },
        @{ rx = 'langsam|träge|traege|start|boot'; tags = @('boot', 'quality-of-life') }
    )
    foreach ($m in $map) {
        if ($t -match $m.rx) { foreach ($x in $m.tags) { if (-not $tags.Contains($x)) { $tags.Add($x) } } }
    }
    return @($tags)
}

function Get-VxRiskRank([string]$Risk) {
    switch ($Risk) { 'safe' { return 0 } 'moderate' { return 1 } 'risky' { return 2 } }
    return 2
}

# The scan decides the form factor from the chassis (a desktop with a USB UPS reports a battery too).
function Test-VxIsLaptop($VxProfile) {
    if ($null -eq $VxProfile) { return $false }
    return ([string](Get-VxProp $VxProfile 'formFactor') -eq 'laptop')
}

# Ryzen X3D CPUs with two chiplets (7900X3D, 7950X3D, 9900X3D, 9950X3D) need "Ausbalanciert" and
# core parking: AMD's driver parks the second chiplet so games run on the V-Cache cores.
function Test-VxDualCcdX3d($VxProfile) {
    $n = [string](Get-VxProp (Get-VxProp $VxProfile 'cpu') 'name' '')
    return ($n -match '(?i)\b(7900|7950|9900|9950)X3D\b')
}

# Tweaks that fight AMD's chiplet scheduling on dual-CCD X3D CPUs: power plans, core parking, and
# everything whose own catalog text warns about X3D.
function Test-VxX3dHostile($Tweak) {
    foreach ($a in @($Tweak.actions)) {
        $type = [string](Get-VxProp $a 'type')
        if ($type -eq 'powerplan') { return $true }
        if ($type -eq 'powersetting' -and @('0cc5b647-c1df-4637-891a-dec35c318583', 'ea062031-0e34-4ff1-9b6d-eb1059334028') -contains ([string](Get-VxProp $a 'setting')).ToLowerInvariant()) { return $true }
    }
    return (([string](Get-VxProp $Tweak 'warning' '') + ' ' + [string](Get-VxProp $Tweak 'info' '')) -match 'X3D')
}

# WLAN-only tweaks (pointless on a PC without a WLAN adapter).
function Test-VxWifiTweak($Tweak) {
    return (([string]$Tweak.id + ' ' + [string]$Tweak.name) -match '(?i)wifi|wlan|wi-fi')
}

# Preset that matches an advisor goal; its tweak list was reviewed by hand.
function Get-VxGoalPresetIds([string]$Goal) {
    $presetId = $Goal
    if ($Goal -eq 'balanced') { $presetId = 'safe' }
    $p = @(@($global:VxCtx.Catalog.presets) | Where-Object { [string](Get-VxProp $_ 'id') -eq $presetId })[0]
    if ($null -eq $p) { return @() }
    return @(@(Get-VxProp $p 'ids' @()) | ForEach-Object { [string]$_ })
}

# Exe names a tweak raises the priority of (IFEO\<exe>\PerfOptions), e.g. games.*-priority.
function Get-VxTweakGameExes($Tweak) {
    $out = @()
    foreach ($a in @($Tweak.actions)) {
        if ([string](Get-VxProp $a 'type') -ne 'reg') { continue }
        $m = [regex]::Match([string](Get-VxProp $a 'path'), '(?i)\\Image File Execution Options\\([^\\]+)\\PerfOptions$')
        if ($m.Success) { $out += $m.Groups[1].Value.ToLowerInvariant() }
    }
    return $out
}

# Games found on this PC (cached per job): @{ exes = @{ <exe lower> = $true }; fivem = bool }.
function Get-VxDetectedGames {
    $ctx = $global:VxCtx
    if ($ctx.Cache.ContainsKey('detectedGames')) { return $ctx.Cache.detectedGames }
    $list = @()
    try { if ($ctx.Windows) { $list = @(Get-VxRealGames) } else { $list = @(Get-VxSimGames) } } catch { $list = @() }
    $list += @(@($ctx.Settings.games))
    $r = @{ exes = @{}; fivem = $false }
    foreach ($g in $list) {
        $exe = Get-VxPathLeaf ([string](Get-VxProp $g 'path' ''))
        if ($exe) { $r.exes[$exe.ToLowerInvariant()] = $true }
        if ([string](Get-VxProp $g 'source' '') -eq 'fivem' -or $exe -match '(?i)^fivem') { $r.fivem = $true }
    }
    $ctx.Cache.detectedGames = $r
    return $r
}

# Recommended set for a goal (status-agnostic). Returns list of @{ tweak; keyword }.
function Get-VxGoalCandidates([string]$Goal, $VxProfile, [string[]]$ExtraTags = @(), [string[]]$FixIds = @()) {
    $ctx = $global:VxCtx
    $cfg = Get-VxGoalConfig $Goal
    $isLaptop = (Test-VxIsLaptop $VxProfile) -or $Goal -eq 'laptop'
    $sysDisk = [string](Get-VxProp $VxProfile 'systemDisk' 'unknown')
    $ram = [double](Get-VxProp (Get-VxProp $VxProfile 'ram') 'totalGB' 0)
    $gpuVendors = @(@(Get-VxProp $VxProfile 'gpus' @()) | ForEach-Object { [string](Get-VxProp $_ 'vendor') })
    $cpuVendor = [string](Get-VxProp (Get-VxProp $VxProfile 'cpu') 'vendor')
    $presetIds = @(Get-VxGoalPresetIds $Goal)
    $x3d = Test-VxDualCcdX3d $VxProfile
    $nets = @(Get-VxProp $VxProfile 'network' @())
    $noWifi = ($nets.Count -gt 0 -and @($nets | Where-Object { [string](Get-VxProp $_ 'type') -eq 'wifi' }).Count -eq 0)
    $games = $null
    $out = New-Object System.Collections.ArrayList
    foreach ($t in $ctx.Catalog.tweaks) {
        if ((Get-VxTweakKind $t) -ne 'toggle') { continue }
        $risk = [string]$t.risk
        $rank = Get-VxRiskRank $risk
        if ($rank -ge 2) { continue }
        $tags = @($t.tags | ForEach-Object { [string]$_ })
        if ($tags -contains 'security-off') { continue }
        $idText = ([string]$t.id + ' ' + [string]$t.name).ToLowerInvariant()
        # --- goal match
        $coreHit = @($tags | Where-Object { $cfg.core -contains $_ }).Count -gt 0
        if ($cfg.categories -contains [string]$t.category) { $coreHit = $true }
        $safeHit = @($tags | Where-Object { $cfg.safe -contains $_ }).Count -gt 0
        $keyword = @($tags | Where-Object { $ExtraTags -contains $_ }).Count -gt 0
        $ok = $false
        if ($coreHit -and $rank -le (Get-VxRiskRank $cfg.coreRisk)) { $ok = $true }
        if (-not $ok -and $safeHit -and $rank -eq 0) { $ok = $true }
        if (-not $ok -and $keyword -and $rank -le 1) { $ok = $true }
        if (-not $ok) { continue }
        # A trade-off ("moderate") is only picked without being asked for when it is part of the
        # hand-reviewed preset for this goal, targets this PC's hardware (GPU/CPU vendor, SSD/HDD)
        # or fixes a finding of this PC (e.g. "Energieplan Ausbalanciert auf einem Desktop-PC").
        # Situational fixes ("only if you have flicker / a VRR monitor ...") need the free text.
        $situational = [bool](Get-VxProp $t 'situational' $false)
        if ($situational -and -not $keyword) { continue }
        if ($rank -eq 1 -and -not $keyword) {
            $hw = (@($tags | Where-Object { @('nvidia', 'amd', 'intel') -contains $_ }).Count -gt 0) -or ($tags -contains 'ssd' -and $sysDisk -eq 'ssd') -or ($tags -contains 'hdd' -and $sysDisk -eq 'hdd')
            if (-not ($presetIds -contains [string]$t.id) -and -not $hw -and -not ($FixIds -contains [string]$t.id)) { continue }
        }
        if ($x3d -and (Test-VxX3dHostile $t)) { continue }
        if ($noWifi -and (Test-VxWifiTweak $t)) { continue }
        # priority tweaks for one game only when that game is installed
        $exes = @(Get-VxTweakGameExes $t)
        if ($exes.Count -gt 0) {
            if ($null -eq $games) { $games = Get-VxDetectedGames }
            $found = @($exes | Where-Object { $games.exes.ContainsKey($_) }).Count -gt 0
            if (-not $found -and -not ($games.fivem -and $tags -contains 'fivem')) { continue }
        }
        if ($cfg.exclude -and $idText -match $cfg.exclude) { continue }
        # --- profile rules
        if ($isLaptop -and $tags -contains 'laptop-bad') { continue }
        if ($isLaptop -and $tags -contains 'desktop') { continue }
        if ($sysDisk -eq 'hdd' -and ($tags -contains 'ssd' -or $idText -match 'sysmain|prefetch|superfetch')) { continue }
        if ($sysDisk -eq 'ssd' -and $tags -contains 'hdd') { continue }
        if ($ram -gt 0 -and $ram -lt 16 -and $idText -match 'memory-compression|memorycompression|speicherkomprimierung|mmagent|paging|pagefile|auslagerung|largesystemcache') { continue }
        $vendorTags = @($tags | Where-Object { @('nvidia', 'amd', 'intel') -contains $_ })
        if ($vendorTags.Count -gt 0) {
            $vm = $false
            foreach ($v in $vendorTags) { if ($gpuVendors -contains $v -or $cpuVendor -eq $v) { $vm = $true } }
            if (-not $vm) { continue }
        }
        $w = Test-VxWhen $t $VxProfile $false
        if (-not $w.ok) { continue }
        $st = [string]$ctx.State.statuses[[string]$t.id]
        if ($st -eq 'na') { continue }
        [void]$out.Add(@{ tweak = $t; keyword = $keyword; core = ($coreHit -or $keyword) })
    }
    return @($out)
}

function Get-VxDiskLabel($VxProfile) {
    $sys = [string](Get-VxProp $VxProfile 'systemDisk')
    if ($sys -ne 'ssd') { if ($sys -eq 'hdd') { return 'Festplatte (HDD)' } return $null }
    $nvme = @(@(Get-VxProp $VxProfile 'disks' @()) | Where-Object { [string](Get-VxProp $_ 'media') -eq 'ssd' -and [string](Get-VxProp $_ 'bus') -eq 'nvme' }).Count -gt 0
    if ($nvme) { return 'NVMe-SSD' }
    return 'SSD'
}

function Get-VxShortGpuName($VxProfile, [string]$Vendor = '') {
    $gpus = @(Get-VxProp $VxProfile 'gpus' @())
    if ($Vendor) { $gpus = @($gpus | Where-Object { [string](Get-VxProp $_ 'vendor') -eq $Vendor }) }
    $g = @($gpus | Where-Object { [string](Get-VxProp $_ 'vendor') -ne 'intel' -and [string](Get-VxProp $_ 'vendor') -ne 'other' })
    if ($g.Count -eq 0) { $g = $gpus }
    if ($g.Count -eq 0) { return $null }
    $n = [string](Get-VxProp $g[0] 'name')
    return (($n -replace '\(R\)|\(TM\)', '') -replace '\s+', ' ').Trim()
}

# German word for a free-text keyword tag (summary: "Deine Beschreibung wurde berücksichtigt").
function Get-VxTagWord([string]$Tag) {
    switch ($Tag) {
        'stutter' { return 'Ruckler' }
        'network' { return 'Netzwerk' }
        'ping' { return 'Ping' }
        'input' { return 'Eingabe' }
        'latency' { return 'Latenz' }
        'battery' { return 'Akku' }
        'fivem' { return 'FiveM' }
        'gta' { return 'GTA V' }
        'privacy' { return 'Datenschutz' }
        'telemetry' { return 'Telemetrie' }
        'ads' { return 'Werbung' }
        'fps' { return 'FPS' }
        'streaming' { return 'Streaming' }
        'ai' { return 'KI' }
        'boot' { return 'Systemstart' }
        'quality-of-life' { return 'Bedienkomfort' }
    }
    return $Tag
}

# Which tag of a tweak explains its benefit for a goal: the first one in the goal's order.
function Get-VxGoalTagOrder([string]$Goal) {
    switch ($Goal) {
        'competitive' { return @('input', 'latency', 'ping', 'network', 'fps', 'stutter', 'competitive', 'audio', 'memory', 'storage', 'boot', 'update', 'bloat', 'telemetry', 'privacy', 'ads', 'ai', 'quality-of-life', 'explorer', 'ui') }
        'balanced' { return @('stutter', 'fps', 'boot', 'storage', 'quality-of-life', 'explorer', 'ui', 'input', 'latency', 'memory', 'ping', 'network', 'telemetry', 'privacy', 'ads', 'ai', 'bloat', 'update', 'audio') }
        'privacy' { return @('telemetry', 'privacy', 'ai', 'ads', 'bloat', 'update', 'quality-of-life', 'explorer', 'ui', 'stutter', 'fps') }
        'laptop' { return @('battery', 'stutter', 'fps', 'boot', 'storage', 'memory', 'bloat', 'telemetry', 'privacy', 'ads', 'ai', 'quality-of-life', 'explorer', 'ui', 'input', 'latency', 'ping', 'network') }
        'streaming' { return @('streaming', 'stutter', 'fps', 'ping', 'network', 'input', 'latency', 'memory', 'storage', 'bloat', 'telemetry', 'privacy', 'ads', 'ai', 'quality-of-life') }
        'fivem' { return @('fivem', 'gta', 'fps', 'stutter', 'input', 'latency', 'ping', 'network', 'memory', 'storage', 'bloat', 'telemetry', 'privacy', 'ads', 'ai', 'quality-of-life') }
    }
    return @('fps', 'stutter', 'input', 'latency', 'ping', 'network', 'memory', 'storage', 'boot', 'bloat', 'telemetry', 'privacy', 'ads', 'ai', 'quality-of-life', 'explorer', 'ui')
}

# Tags that describe a tweak of this category best (checked before the goal's order, but only
# tags that also belong to the goal): a network tweak in a gaming plan is about ping, not "latency".
function Get-VxCategoryTagOrder([string]$Category) {
    switch ($Category) {
        'network' { return @('ping', 'network') }
        'gpu' { return @('fps') }
        'privacy' { return @('telemetry', 'privacy') }
        'debloat' { return @('ai', 'ads', 'bloat') }
        'ui' { return @('explorer', 'ui', 'quality-of-life') }
        'memory' { return @('memory', 'storage') }
        'games' { return @('fivem', 'gta') }
    }
    return @()
}

# The benefit of a tweak in plain German, for one tag and goal (no hardware - see Get-VxHardwareNote).
# Worded so it holds for every tweak with that tag and category (Edge, NVIDIA, Windows ...); the
# tweak's own description follows it in the reason.
function Get-VxTagBenefit([string]$Tag, $Tweak, $VxProfile, [string]$Goal) {
    $cat = [string]$Tweak.category
    $play = @('gaming', 'competitive', 'fivem', 'streaming') -contains $Goal
    switch ($Tag) {
        'fps' {
            if ($cat -eq 'gpu') { return 'Holt mehr aus deiner Grafikkarte heraus' }
            if ($cat -eq 'power') { return 'Der Prozessor bleibt auf Leistung statt auf Stromsparen – das bringt mehr FPS' }
            return 'Mehr Leistung und FPS für deine Spiele'
        }
        'stutter' {
            if ($cat -eq 'services') { return 'Ein Hintergrunddienst weniger, der mitten im Spiel Ruckler auslösen kann' }
            if ($cat -eq 'power') { return 'Weniger kurze Hänger durch Stromspar-Zustände' }
            if ($cat -eq 'memory') { return 'Programme und Spiele laden flüssiger nach, ohne kurze Hänger' }
            if (-not $play) { return 'Windows läuft gleichmäßiger, ohne kurze Hänger' }
            return 'Gleichmäßigere Bildrate mit weniger Rucklern'
        }
        'input' { return 'Maus und Tastatur reagieren direkter' }
        'latency' { return 'Weniger Verzögerung zwischen deiner Eingabe und dem Bild' }
        { $_ -eq 'network' -or $_ -eq 'ping' } {
            if (Test-VxWifiTweak $Tweak) { return 'Stabilere WLAN-Verbindung mit weniger Ping-Spitzen' }
            if ($play) { return 'Niedrigerer und stabilerer Ping beim Online-Spielen' }
            return 'Stabilere und schnellere Netzwerkverbindung'
        }
        'competitive' { return 'Für Esport: ein direkteres, berechenbareres Spielgefühl' }
        'memory' { return 'Windows geht sparsamer mit dem Arbeitsspeicher um' }
        'storage' { return 'Spart Speicherplatz und unnötige Schreibzugriffe' }
        'boot' { return 'Windows startet schneller' }
        'battery' {
            if (Test-VxIsLaptop $VxProfile) { return 'Verlängert die Akkulaufzeit deines Laptops' }
            return 'Spart Strom'
        }
        'telemetry' { return 'Weniger Nutzungs- und Diagnosedaten verlassen deinen PC' }
        'privacy' { return 'Mehr Privatsphäre – weniger Daten über dich werden gesammelt oder geteilt' }
        'ads' { return 'Weniger Werbung und aufdringliche Vorschläge' }
        'ai' { return 'KI-Funktionen, die du nicht brauchst, bleiben aus' }
        'bloat' {
            if ($cat -eq 'services') { return 'Ein unnötiger Hintergrunddienst weniger – spart Arbeitsspeicher und Rechenzeit' }
            return 'Weniger Ballast in Windows'
        }
        'quality-of-life' { return 'Macht die tägliche Bedienung angenehmer' }
        'explorer' { return 'Der Explorer wird übersichtlicher und reagiert schneller' }
        'ui' { return 'Die Oberfläche wird aufgeräumter' }
        'streaming' { return 'Mehr Reserven, damit Spiel und Stream gleichzeitig flüssig laufen' }
        { $_ -eq 'fivem' -or $_ -eq 'gta' } { return 'Speziell für FiveM und GTA V – mehr Leistung im Spiel' }
        'audio' { return 'Weniger Knacken und Verzögerung beim Ton' }
        'update' { return 'Windows Update funkt dir seltener dazwischen' }
        'compat' { return 'Vermeidet Probleme mit älteren Programmen und Spielen' }
    }
    return $null
}

# Hardware the tweak is made for, when it really matters: GPU/CPU vendor, SSD/HDD, little RAM.
function Get-VxHardwareNote($Tweak, $VxProfile) {
    $tags = @($Tweak.tags | ForEach-Object { [string]$_ })
    foreach ($v in @('nvidia', 'amd', 'intel')) {
        if ($tags -contains $v) {
            $g = Get-VxShortGpuName $VxProfile $v
            $gv = @(@(Get-VxProp $VxProfile 'gpus' @()) | Where-Object { [string](Get-VxProp $_ 'vendor') -eq $v }).Count -gt 0
            if ($g -and $gv) { return ('passend zu deiner {0}' -f $g) }
            $cpu = Get-VxProp $VxProfile 'cpu'
            if ([string](Get-VxProp $cpu 'vendor') -eq $v -and [string](Get-VxProp $cpu 'name')) {
                return ('passend zu deinem Prozessor ({0})' -f ((([string](Get-VxProp $cpu 'name')) -replace '\(R\)|\(TM\)', '' -replace '\s+', ' ').Trim()))
            }
        }
    }
    $disk = Get-VxDiskLabel $VxProfile
    if ($tags -contains 'ssd' -and $disk -and $disk -ne 'Festplatte (HDD)') { return ('lohnt sich, weil Windows auf deiner {0} liegt' -f $disk) }
    if ($tags -contains 'hdd' -and $disk -eq 'Festplatte (HDD)') { return 'hilft, weil Windows bei dir auf einer Festplatte (HDD) liegt' }
    # RAM only matters when there is little of it
    $ram = [double](Get-VxProp (Get-VxProp $VxProfile 'ram') 'totalGB' 0)
    if ($tags -contains 'memory' -and $ram -gt 0 -and $ram -le 16) { return ('gerade bei {0} GB Arbeitsspeicher spürbar' -f (Format-VxNumber $ram ([int]([math]::Round($ram) -ne $ram)))) }
    return $null
}

# Why a tweak is in the plan: its benefit for this goal in simple words (+ the hardware it fits,
# only when that matters), then the tweak's own one-line description (what it does, any downside).
function Get-VxPlanReason($Tweak, $VxProfile, [string]$Goal) {
    $tags = @($Tweak.tags | ForEach-Object { [string]$_ })
    $order = @(Get-VxGoalTagOrder $Goal)
    $lead = $null
    foreach ($x in @(Get-VxCategoryTagOrder ([string]$Tweak.category))) { if ($tags -contains $x -and $order -contains $x) { $lead = $x; break } }
    if (-not $lead) { foreach ($x in $order) { if ($tags -contains $x) { $lead = $x; break } } }
    $benefit = $null
    if ($lead) { $benefit = Get-VxTagBenefit $lead $Tweak $VxProfile $Goal }
    if (-not $benefit) { foreach ($x in $tags) { $benefit = Get-VxTagBenefit $x $Tweak $VxProfile $Goal; if ($benefit) { break } } }
    $hw = Get-VxHardwareNote $Tweak $VxProfile
    $desc = ([string]$Tweak.desc).Trim()
    if ($desc.Length -gt 0) {
        $desc = $desc.Substring(0, 1).ToUpperInvariant() + $desc.Substring(1)
        if ($desc -notmatch '[.!?…]$') { $desc += '.' }
    }
    if (-not $benefit) {
        if ($hw) { return ($hw.Substring(0, 1).ToUpperInvariant() + $hw.Substring(1) + '. ' + $desc).Trim() }
        return $desc
    }
    $head = $benefit
    if ($hw) { $head += ' – ' + $hw }
    return ($head + '. ' + $desc).Trim()
}

# Exclusive targets of a tweak (used to keep conflicting tweaks out of one plan).
function Get-VxTweakTargetKeys($Tweak) {
    $keys = @()
    foreach ($a in @($Tweak.actions)) {
        switch ([string](Get-VxProp $a 'type')) {
            'powerplan' { $keys += 'powerplan' }
            'service' { $keys += ('svc|' + ([string]$a.name).ToLowerInvariant()) }
            'bcd' { $keys += ('bcd|' + ([string]$a.name).ToLowerInvariant()) }
            'powersetting' { $keys += ('pws|' + ([string]$a.subgroup + '|' + [string]$a.setting).ToLowerInvariant()) }
            'reg' { $keys += ('reg|' + ([string]$a.path + '|' + [string]$a.name).ToLowerInvariant()) }
        }
    }
    return $keys
}

# Finds catalog toggles that set a registry value (path suffix + name) to a value.
function Find-VxTweakIdsByReg([string]$PathSuffix, [string]$Name, $Value) {
    $ids = @()
    foreach ($t in $global:VxCtx.Catalog.tweaks) {
        if ((Get-VxTweakKind $t) -ne 'toggle' -or [string]$t.risk -eq 'risky') { continue }
        foreach ($a in @($t.actions)) {
            if ([string](Get-VxProp $a 'type') -eq 'reg' -and ([string]$a.path).EndsWith($PathSuffix, [StringComparison]::OrdinalIgnoreCase) -and [string]$a.name -ieq $Name -and (Test-VxRegEqual ([string]$a.kind) $a.value $Value)) {
                $ids += [string]$t.id
            }
        }
    }
    return @($ids | Sort-Object -Unique)
}

function Find-VxPlanTweakIds {
    $ult = @(); $high = @()
    foreach ($t in $global:VxCtx.Catalog.tweaks) {
        if ((Get-VxTweakKind $t) -ne 'toggle' -or [string]$t.risk -eq 'risky') { continue }
        foreach ($a in @($t.actions)) {
            if ([string](Get-VxProp $a 'type') -eq 'powerplan') {
                if ([string]$a.plan -eq 'ultimate') { $ult += [string]$t.id } elseif ([string]$a.plan -eq 'high') { $high += [string]$t.id }
            }
        }
    }
    if ($ult.Count -gt 0) { return @($ult | Sort-Object | Select-Object -First 1) }
    return @($high | Sort-Object | Select-Object -First 1)
}

function New-VxFinding([string]$Id, [string]$Severity, [string]$Title, [string]$Detail, $Fix = $null) {
    return [ordered]@{ id = $Id; severity = $Severity; title = $Title; detail = $Detail; fix = $Fix }
}

function Get-VxApplicableFixIds([string[]]$Ids, $VxProfile) {
    $ok = @()
    foreach ($id in $Ids) {
        $t = Get-VxTweak $id
        if ($null -eq $t) { continue }
        if (-not (Test-VxWhen $t $VxProfile $false).ok) { continue }
        if ([string]$global:VxCtx.State.statuses[$id] -eq 'na') { continue }
        $ok += $id
    }
    return $ok
}

# Findings for the profile of the last scan. Without -All, findings that a tweak VELOX applied since
# has solved are left out (the profile itself is not re-read).
function Get-VxFindings($VxProfile, [string]$Goal, [switch]$All) {
    $ctx = $global:VxCtx
    $f = New-Object System.Collections.ArrayList
    if ($null -eq $VxProfile) { return @() }
    $isLaptop = Test-VxIsLaptop $VxProfile
    # ---- display refresh rate
    $d = Get-VxProp $VxProfile 'display'
    if ($null -ne $d) {
        $cur = [int](Get-VxProp $d 'currentHz' 0); $max = [int](Get-VxProp $d 'maxHz' 0)
        if ($cur -gt 0 -and $max -gt ($cur + 5)) {
            [void]$f.Add((New-VxFinding 'refresh-rate' 'bad' ("Bildschirm läuft nur mit {0} Hz" -f $cur) ("Dein Bildschirm schafft {0} Hz, Windows nutzt aber nur {1} Hz. Stell in den erweiterten Anzeigeeinstellungen die Bildwiederholrate auf {0} Hz – das ist der größte Gratis-Boost für flüssiges Spielen." -f $max, $cur) ([ordered]@{ type = 'open'; target = 'ms-settings:display-advanced' })))
        } elseif ($cur -ge 100) {
            [void]$f.Add((New-VxFinding 'refresh-rate' 'good' ("Bildschirm nutzt {0} Hz" -f $cur) 'Die Bildwiederholrate steht schon auf dem Maximum.' $null))
        }
    }
    # ---- RAM speed (XMP / EXPO)
    $ram = Get-VxProp $VxProfile 'ram'
    if ($null -ne $ram) {
        $type = [string](Get-VxProp $ram 'type'); $conf = [int](Get-VxProp $ram 'configuredMHz' 0)
        $slow = $false; $typical = ''
        if ($type -eq 'DDR4' -and $conf -gt 0 -and $conf -le 2400) { $slow = $true; $typical = '3200 bis 3600' }
        if ($type -eq 'DDR5' -and $conf -gt 0 -and $conf -le 4800) { $slow = $true; $typical = '6000' }
        if ($slow) {
            $sev = 'warn'; $extra = ''
            if ($isLaptop) { $sev = 'info'; $extra = ' Bei Laptops geht das nur, wenn das BIOS diese Option anbietet.' }
            [void]$f.Add((New-VxFinding 'xmp' $sev ("Arbeitsspeicher läuft nur mit {0} MHz" -f $conf) ("Dein {0}-RAM läuft mit {1} MHz, typisch sind {2} MHz. Schalte im BIOS das XMP- bzw. EXPO-Profil ein – das bringt in CPU-lastigen Spielen oft spürbar mehr FPS. Das geht nur im BIOS, nicht per Software.{3}" -f $type, $conf, $typical, $extra) $null))
        }
    }
    # ---- VBS / HVCI
    $sec = Get-VxProp $VxProfile 'security'
    if ($null -ne $sec -and ((Get-VxProp $sec 'hvci') -eq $true -or (Get-VxProp $sec 'vbs') -eq $true)) {
        [void]$f.Add((New-VxFinding 'vbs' 'info' 'Kernisolierung (VBS/HVCI) ist an' 'Das schützt den Windows-Kern vor Angriffen, kostet in manchen Spielen aber ein paar Prozent Leistung. VELOX schaltet das nie automatisch ab. Unter „Experte (riskant)“ findest du die passenden Tweaks – nur benutzen, wenn du das Risiko verstehst.' $null))
    }
    # ---- power plan
    $pw = Get-VxProp $VxProfile 'power'
    if ($null -ne $pw) {
        $guid = [string](Get-VxProp $pw 'activePlan')
        if ($guid -eq (Get-VxPlanBaseGuid 'balanced') -and -not $isLaptop -and (Test-VxDualCcdX3d $VxProfile)) {
            [void]$f.Add((New-VxFinding 'power-plan' 'good' 'Energieplan „Ausbalanciert“ passt zu deinem Ryzen X3D' 'Bei Ryzen-X3D-Prozessoren mit zwei Chiplets braucht AMD diesen Plan, damit Spiele auf den Kernen mit dem großen Cache laufen. Lass ihn so.' $null))
        } elseif ($guid -eq (Get-VxPlanBaseGuid 'balanced') -and -not $isLaptop) {
            $ids = @(Get-VxApplicableFixIds @(Find-VxPlanTweakIds) $VxProfile)
            $fix = $null
            if ($ids.Count -gt 0) { $fix = [ordered]@{ type = 'tweaks'; ids = $ids } } else { $fix = [ordered]@{ type = 'open'; target = 'ms-settings:powersleep' } }
            [void]$f.Add((New-VxFinding 'power-plan' 'warn' 'Energieplan „Ausbalanciert“ auf einem Desktop-PC' 'Der Prozessor taktet damit oft herunter und braucht Zeit zum Hochfahren – das kostet Reaktionszeit und kann Ruckler verursachen. Ein Leistungsplan hält ihn auf Trab.' $fix))
        }
    }
    # ---- gaming flags
    $g = Get-VxProp $VxProfile 'gaming'
    if ($null -ne $g) {
        if ((Get-VxProp $g 'gameMode') -eq $false) {
            $ids = @(Get-VxApplicableFixIds @(Find-VxTweakIdsByReg 'Software\Microsoft\GameBar' 'AutoGameModeEnabled' 1) $VxProfile)
            $fix = $null; if ($ids.Count -gt 0) { $fix = [ordered]@{ type = 'tweaks'; ids = $ids } } else { $fix = [ordered]@{ type = 'open'; target = 'ms-settings:gaming-gamemode' } }
            [void]$f.Add((New-VxFinding 'game-mode' 'warn' 'Spielmodus ist aus' 'Der Windows-Spielmodus gibt dem Spiel Vorrang und hält Updates im Hintergrund zurück. Er sollte an sein.' $fix))
        }
        $gpus = @(Get-VxProp $VxProfile 'gpus' @())
        $supported = @($gpus | Where-Object { @('nvidia', 'amd') -contains [string](Get-VxProp $_ 'vendor') -and [double](Get-VxProp $_ 'vramGB' 0) -ge 4 }).Count -gt 0
        if ((Get-VxProp $g 'hags') -eq $false -and $supported -and (Get-VxProfileBuild $VxProfile) -ge 19041) {
            $ids = @(Get-VxApplicableFixIds @(Find-VxTweakIdsByReg 'Control\GraphicsDrivers' 'HwSchMode' 2) $VxProfile)
            $fix = $null; if ($ids.Count -gt 0) { $fix = [ordered]@{ type = 'tweaks'; ids = $ids } } else { $fix = [ordered]@{ type = 'open'; target = 'ms-settings:display-advancedgraphics' } }
            [void]$f.Add((New-VxFinding 'hags' 'info' 'Hardwarebeschleunigte GPU-Planung ist aus' 'Deine Grafikkarte unterstützt sie. Eingeschaltet kann sie die Latenz senken und ist für DLSS Frame Generation nötig. Wirkt nach einem Neustart.' $fix))
        }
        if ((Get-VxProp $g 'gameDvr') -eq $true -and $Goal -ne 'streaming') {
            $ids = @(Get-VxApplicableFixIds @(Find-VxTweakIdsByReg 'System\GameConfigStore' 'GameDVR_Enabled' 0) $VxProfile)
            $fix = $null; if ($ids.Count -gt 0) { $fix = [ordered]@{ type = 'tweaks'; ids = $ids } } else { $fix = [ordered]@{ type = 'open'; target = 'ms-settings:gaming-captures' } }
            [void]$f.Add((New-VxFinding 'game-dvr' 'warn' 'Hintergrund-Aufnahme (Game DVR) ist an' 'Windows nimmt dabei ständig Gameplay auf, das kostet FPS und kann Ruckler verursachen.' $fix))
        }
    }
    # ---- free space
    $free = Get-VxProp $VxProfile 'systemDriveFreeGB'
    if ($null -ne $free) {
        if ([double]$free -lt 10) {
            [void]$f.Add((New-VxFinding 'disk-space' 'bad' ("Nur noch {0} GB frei auf dem Systemlaufwerk" -f (Format-VxNumber ([double]$free) ([int]([math]::Round([double]$free) -ne [double]$free)))) 'Windows wird langsam und Updates können fehlschlagen, wenn weniger als 10 GB frei sind. Räum auf.' ([ordered]@{ type = 'page'; page = 'cleanup' })))
        } elseif ([double]$free -lt 25) {
            [void]$f.Add((New-VxFinding 'disk-space' 'warn' ("Nur {0} GB frei auf dem Systemlaufwerk" -f (Format-VxNumber ([double]$free) ([int]([math]::Round([double]$free) -ne [double]$free)))) 'Etwas Platz schaffen hilft Windows und Spielen beim Nachladen.' ([ordered]@{ type = 'page'; page = 'cleanup' })))
        }
    }
    $temp = Get-VxProp $VxProfile 'tempMB'
    if ($null -ne $temp -and [double]$temp -gt 2000) {
        [void]$f.Add((New-VxFinding 'temp-files' 'info' ("{0} GB temporäre Dateien" -f (Format-VxNumber ([double]$temp / 1024) 1)) 'Die kannst du gefahrlos löschen.' ([ordered]@{ type = 'page'; page = 'cleanup' })))
    }
    # ---- uptime
    $up = Get-VxProp $VxProfile 'uptimeHours'
    if ($null -ne $up -and [double]$up -gt 168) {
        [void]$f.Add((New-VxFinding 'uptime' 'info' ("Seit {0} Tagen kein Neustart" -f [math]::Floor([double]$up / 24)) 'Ein Neustart räumt den Arbeitsspeicher auf und schließt hängende Hintergrundprozesse. Danach läuft der PC meist runder.' $null))
    }
    # ---- startup apps
    $sc = Get-VxProp $VxProfile 'startupCount'
    if ($null -ne $sc -and [int]$sc -gt 8) {
        [void]$f.Add((New-VxFinding 'startup' 'warn' ("{0} Programme starten mit Windows" -f [int]$sc) 'Jedes davon verlängert den Start und läuft danach im Hintergrund weiter. Schalte unter „Apps“ ab, was du nicht sofort brauchst.' ([ordered]@{ type = 'page'; page = 'apps' })))
    }
    # ---- foreign tweaks
    $fc = Get-VxProp $VxProfile 'foreignCount'
    if ($null -eq $fc) { $fc = Get-VxProp $ctx.State 'foreignCount' $null }
    if ($null -ne $fc -and [int]$fc -gt 0) {
        # foreignCount never counts what VELOX itself set (core/Detweak.ps1)
        $what = 'Einstellungen'; if ([int]$fc -eq 1) { $what = 'Einstellung' }
        [void]$f.Add((New-VxFinding 'foreign' 'warn' ("{0} {1} von anderen Tweak-Tools gefunden" -f [int]$fc, $what) 'Andere Tweaker setzen oft Werte, die heute eher schaden. Mit Detweak setzt du sie sauber auf Standard zurück.' ([ordered]@{ type = 'page'; page = 'detweak' })))
    }
    # ---- backups
    $hasBackups = $false
    try { $hasBackups = (@(Get-ChildItem -LiteralPath $ctx.BackupDir -Filter '*.json' -File -ErrorAction Stop).Count -gt 0) } catch { $null = $_ }
    if (-not $hasBackups -and [int](Get-VxProp $ctx.State 'restorePoints' 0) -eq 0) {
        [void]$f.Add((New-VxFinding 'no-backups' 'info' 'Noch keine Sicherung vorhanden' 'Keine Sorge: VELOX sichert vor jeder Änderung automatisch alle alten Werte und legt einen Windows-Wiederherstellungspunkt an. Du kannst alles jederzeit zurückholen.' $null))
    }
    # ---- good news
    if ([string](Get-VxProp $VxProfile 'systemDisk') -eq 'ssd') {
        [void]$f.Add((New-VxFinding 'ssd' 'good' ("Windows liegt auf einer {0}" -f (Get-VxDiskLabel $VxProfile)) 'Schnelle Ladezeiten – perfekt.' $null))
    }
    if ($All) { return @($f) }
    # the profile is from the last scan: a finding one of whose fix tweaks VELOX has applied since is
    # solved (each fix id alone fixes it: "a performance plan", "Game DVR off"); the power plan
    # finding is solved by any performance plan tweak
    $st = $ctx.State.statuses
    $planIds = @()
    foreach ($t in $ctx.Catalog.tweaks) {
        foreach ($a in @($t.actions)) { if ([string](Get-VxProp $a 'type') -eq 'powerplan' -and [string](Get-VxProp $a 'plan') -ne 'balanced') { $planIds += [string]$t.id } }
    }
    $open = @($f | Where-Object {
            $fix = Get-VxProp $_ 'fix'
            if ([string](Get-VxProp $_ 'id') -eq 'power-plan' -and @($planIds | Where-Object { [string]$st[$_] -eq 'applied' }).Count -gt 0) { return $false }
            if ($null -eq $fix -or [string](Get-VxProp $fix 'type') -ne 'tweaks') { return $true }
            $ids = @(Get-VxProp $fix 'ids' @())
            if ($ids.Count -eq 0) { return $true }
            return (@($ids | Where-Object { [string]$st[[string]$_] -eq 'applied' }).Count -eq 0)
        })
    return @($open)
}

# Score points a finding costs. "no-backups" is reassurance, not a problem.
function Get-VxFindingPenalty($Finding) {
    if ([string](Get-VxProp $Finding 'id') -eq 'no-backups') { return 0 }
    switch ([string](Get-VxProp $Finding 'severity')) { 'bad' { return 5 } 'warn' { return 3 } 'info' { return 1 } }
    return 0
}

# Plan size per goal: enough for a noticeable effect, few enough to review.
function Get-VxGoalPlanCap([string]$Goal) {
    switch ($Goal) {
        'balanced' { return 25 }
        'competitive' { return 55 }
        'privacy' { return 50 }
        'laptop' { return 30 }
        'streaming' { return 40 }
        'fivem' { return 45 }
    }
    return 40
}

# The recommended set for a goal on this PC: candidates ranked by priority (impact and relevance:
# free-text match, the goal's hand-reviewed preset, goal tags), conflicting tweaks removed (an
# applied one keeps its slot), capped per goal. Status-agnostic apart from that, so applying the
# plan does not change the set. Returns rows { id; tweak; prio; core; keyword; applied }.
function Get-VxRecommended([string]$Goal, $VxProfile, [string[]]$ExtraTags = @(), $Findings = @()) {
    $st = $global:VxCtx.State.statuses
    $presetIds = @(Get-VxGoalPresetIds $Goal)
    # tweaks that fix a finding of this PC ("Game DVR is on") are the most relevant ones
    $fixIds = @{}
    foreach ($f in @($Findings)) {
        $fix = Get-VxProp $f 'fix'
        if ($null -ne $fix -and [string](Get-VxProp $fix 'type') -eq 'tweaks' -and @('bad', 'warn', 'info') -contains [string](Get-VxProp $f 'severity')) {
            foreach ($i in @(Get-VxProp $fix 'ids' @())) { $fixIds[[string]$i] = $true }
        }
    }
    $rows = @()
    foreach ($c in @(Get-VxGoalCandidates $Goal $VxProfile $ExtraTags @($fixIds.Keys))) {
        $t = $c.tweak
        $impact = [int](Get-VxProp $t 'impact' 1)
        # goal tweaks: impact 3 -> priority 1 ... ; side benefits (privacy/debloat in a gaming goal) rank lower
        $prio = 4 - $impact
        if (-not $c.core) { $prio = 5 - $impact }
        if ($c.keyword) { $prio-- }
        if ($fixIds.ContainsKey([string]$t.id)) { $prio = 1 }
        if ($prio -lt 1) { $prio = 1 }
        if ($prio -gt 3) { $prio = 3 }
        $kw = 1; if ($c.keyword -or $fixIds.ContainsKey([string]$t.id)) { $kw = 0 }
        $pre = 1; if ($presetIds -contains [string]$t.id) { $pre = 0 }
        $cr = 1; if ($c.core) { $cr = 0 }
        $rows += [pscustomobject]@{
            id = [string]$t.id; tweak = $t; prio = $prio; kw = $kw; preset = $pre; coreRank = $cr; impact = $impact
            risk = (Get-VxRiskRank ([string]$t.risk)); core = [bool]$c.core; keyword = [bool]$c.keyword
            applied = ([string]$st[[string]$t.id] -eq 'applied')
        }
    }
    $sorted = @($rows | Sort-Object -Property @{ Expression = 'prio' }, @{ Expression = 'kw' }, @{ Expression = 'preset' }, @{ Expression = 'coreRank' }, @{ Expression = 'impact'; Descending = $true }, @{ Expression = 'risk' }, @{ Expression = 'id' })
    # two tweaks that set the same thing (e.g. two power plans) never both: one already applied wins
    $claimed = @{}
    foreach ($r in $sorted) {
        if (-not $r.applied) { continue }
        foreach ($k in @(Get-VxTweakTargetKeys $r.tweak)) { if (-not $claimed.ContainsKey($k)) { $claimed[$k] = $r.id } }
    }
    $cap = Get-VxGoalPlanCap $Goal
    $out = New-Object System.Collections.ArrayList
    foreach ($r in $sorted) {
        if ($out.Count -ge $cap) { break }
        $keys = @(Get-VxTweakTargetKeys $r.tweak)
        $clash = $false
        foreach ($k in $keys) { if ($claimed.ContainsKey($k) -and $claimed[$k] -ne $r.id) { $clash = $true } }
        if ($clash) { continue }
        foreach ($k in $keys) { $claimed[$k] = $r.id }
        [void]$out.Add($r)
    }
    return @($out)
}

# Score 0-100 for the recommended set: 50 + 50 x weighted share applied (weight = impact, half for
# side benefits) - finding penalties (bad 5, warn 3, info 1; at most 12). A stock Windows PC lands
# around 35-55, a fully applied plan around 85-95 (hardware/BIOS findings remain). 100 only when
# every recommended tweak is applied and no finding (other than good news) is left.
# scoreAfter: the same with the plan applied and the findings its tweaks fix gone.
function Get-VxAdvisorScore($Recommended, $Findings, [string[]]$PlanIds) {
    $st = $global:VxCtx.State.statuses
    $total = 0.0; $done = 0.0; $after = 0.0
    foreach ($r in @($Recommended)) {
        $t = Get-VxProp $r 'tweak'
        $w = [double](Get-VxProp $t 'impact' 1)
        if ($w -lt 1) { $w = 1 }
        if (-not [bool](Get-VxProp $r 'core' $true)) { $w = $w / 2 }
        $total += $w
        if ([string]$st[[string]$t.id] -eq 'applied') { $done += $w; $after += $w }
        elseif ($PlanIds -contains [string]$t.id) { $after += $w }
    }
    $share = 1.0; $shareAfter = 1.0
    if ($total -gt 0) { $share = $done / $total; $shareAfter = $after / $total }
    $pen = 0; $penAfter = 0; $left = 0; $leftAfter = 0
    foreach ($f in @($Findings)) {
        $p = Get-VxFindingPenalty $f
        $counts = ([string](Get-VxProp $f 'severity') -ne 'good' -and [string](Get-VxProp $f 'id') -ne 'no-backups')
        $pen += $p
        if ($counts) { $left++ }
        $fixed = $false
        $fix = Get-VxProp $f 'fix'
        if ($null -ne $fix -and [string](Get-VxProp $fix 'type') -eq 'tweaks') {
            $ids = @(Get-VxProp $fix 'ids' @())
            # any one of the fix tweaks solves it
            foreach ($i in $ids) { if (($PlanIds -contains [string]$i) -or [string]$st[[string]$i] -eq 'applied') { $fixed = $true } }
        }
        if (-not $fixed) { $penAfter += $p; if ($counts) { $leftAfter++ } }
    }
    if ($pen -gt 12) { $pen = 12 }
    if ($penAfter -gt 12) { $penAfter = 12 }
    $score = [int][math]::Round(50 + 50 * $share - $pen)
    $scoreAfter = [int][math]::Round(50 + 50 * $shareAfter - $penAfter)
    # 100 is earned only by a complete plan and no open finding
    if ($score -ge 100 -and ($done -lt $total -or $left -gt 0)) { $score = 99 }
    if ($scoreAfter -ge 100 -and ($after -lt $total -or $leftAfter -gt 0)) { $scoreAfter = 99 }
    $score = [math]::Max(0, [math]::Min(100, $score))
    $scoreAfter = [math]::Max($score, [math]::Min(100, $scoreAfter))
    return @{ score = [int]$score; scoreAfter = [int]$scoreAfter }
}

# The local advisor. Returns advisorResult (contract section 7). Deterministic.
function Invoke-VxAdvisor([string]$Goal, [string]$Text, $VxProfile) {
    $valid = @('gaming', 'competitive', 'balanced', 'privacy', 'laptop', 'streaming', 'fivem')
    if ($valid -notcontains $Goal) { $Goal = 'gaming' }
    $cfg = Get-VxGoalConfig $Goal
    $extra = @(Get-VxTextTags $Text)
    $findings = @(Get-VxFindings $VxProfile $Goal)
    # the recommended set follows the scanned findings (also the ones solved since), so applying the
    # plan does not change it
    $rec = @(Get-VxRecommended $Goal $VxProfile $extra @(Get-VxFindings $VxProfile $Goal -All))
    $plan = New-Object System.Collections.ArrayList
    foreach ($r in $rec) {
        if ($r.applied) { continue }
        [void]$plan.Add([ordered]@{ id = $r.id; reason = (Get-VxPlanReason $r.tweak $VxProfile $Goal); priority = $r.prio })
    }
    $planIds = @($plan | ForEach-Object { $_.id })
    # the power plan finding offers the same plan the plan list contains
    $planPlan = @($planIds | Where-Object { Test-VxTweakHasAction (Get-VxTweak $_) 'powerplan' })
    if ($planPlan.Count -gt 0) {
        foreach ($fd in $findings) {
            if ($fd.id -eq 'power-plan' -and $null -ne $fd.fix -and [string]$fd.fix.type -eq 'tweaks') { $fd.fix = [ordered]@{ type = 'tweaks'; ids = @($planPlan[0]) } }
        }
    }
    $sc = Get-VxAdvisorScore $rec $findings $planIds
    $bad = @(@($findings | Where-Object { $_.severity -eq 'bad' }) + @($findings | Where-Object { $_.severity -eq 'warn' }))
    $summary = ('Dein PC erreicht {0} von 100 Punkten für das Ziel „{1}“.' -f $sc.score, $cfg.name)
    if ($plan.Count -eq 1) { $summary += (' Mit dem empfohlenen Tweak kommst du auf etwa {0} Punkte.' -f $sc.scoreAfter) }
    elseif ($plan.Count -gt 1) { $summary += (' Mit den {0} empfohlenen Tweaks kommst du auf etwa {1} Punkte.' -f $plan.Count, $sc.scoreAfter) }
    else { $summary += ' Alle passenden Tweaks sind schon aktiv – stark!' }
    if ($bad.Count -gt 0) { $summary += (' Am wichtigsten: {0}.' -f $bad[0].title) }
    if ($extra.Count -gt 0) { $summary += (' Deine Beschreibung wurde berücksichtigt: ' + ((@($extra | ForEach-Object { Get-VxTagWord $_ }) | Select-Object -Unique) -join ', ') + '.') }
    return [ordered]@{
        engine = 'local'; score = $sc.score; scoreAfter = $sc.scoreAfter; summary = $summary
        findings = $findings; plan = $plan.ToArray()
    }
}

# Makes sure a profile and statuses exist (runs a quick scan if needed).
function Confirm-VxProfile {
    $ctx = $global:VxCtx
    if ($null -eq $ctx.State.profile -or -not $ctx.State.lastScan) {
        Set-VxProgress 0.05 'Analysiere deinen PC ...'
        $ctx.State.profile = Get-VxProfile
        Update-VxStatuses -ProgressFrom 0.1 -ProgressTo 0.6
        $ctx.State.lastScan = Get-VxNowIso
        Save-VxState
    }
    return $ctx.State.profile
}

function Invoke-VxAdvisorJob($Params) {
    $goal = [string](Get-VxProp $Params 'goal' 'gaming')
    $text = [string](Get-VxProp $Params 'text' '')
    $prof = Confirm-VxProfile
    Set-VxProgress 0.7 'Werte die Analyse aus ...'
    $r = Invoke-VxAdvisor $goal $text $prof
    Write-VxLog 'ok' ("Smart-Analyse: {0} Punkte, {1} Empfehlungen, {2} Hinweise." -f $r.score, @($r.plan).Count, @($r.findings).Count)
    Set-VxProgress 1 'Fertig'
    return $r
}
