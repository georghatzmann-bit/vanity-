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

function Test-VxIsLaptop($VxProfile) {
    if ($null -eq $VxProfile) { return $false }
    return ([string](Get-VxProp $VxProfile 'formFactor') -eq 'laptop' -or [bool](Get-VxProp $VxProfile 'battery' $false))
}

# Recommended set for a goal (status-agnostic). Returns list of @{ tweak; keyword }.
function Get-VxGoalCandidates([string]$Goal, $VxProfile, [string[]]$ExtraTags = @()) {
    $ctx = $global:VxCtx
    $cfg = Get-VxGoalConfig $Goal
    $isLaptop = (Test-VxIsLaptop $VxProfile) -or $Goal -eq 'laptop'
    $sysDisk = [string](Get-VxProp $VxProfile 'systemDisk' 'unknown')
    $ram = [double](Get-VxProp (Get-VxProp $VxProfile 'ram') 'totalGB' 0)
    $gpuVendors = @(@(Get-VxProp $VxProfile 'gpus' @()) | ForEach-Object { [string](Get-VxProp $_ 'vendor') })
    $cpuVendor = [string](Get-VxProp (Get-VxProp $VxProfile 'cpu') 'vendor')
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
        [void]$out.Add(@{ tweak = $t; keyword = $keyword })
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

function Get-VxPlanReason($Tweak, $VxProfile, [string]$Goal) {
    $tags = @($Tweak.tags | ForEach-Object { [string]$_ })
    $desc = ([string]$Tweak.desc).Trim()
    if ($desc.Length -gt 0) { $desc = $desc.Substring(0, 1).ToUpperInvariant() + $desc.Substring(1) }
    $disk = Get-VxDiskLabel $VxProfile
    $nets = @(Get-VxProp $VxProfile 'network' @())
    $hasLan = @($nets | Where-Object { [string](Get-VxProp $_ 'type') -eq 'ethernet' }).Count -gt 0
    $ram = [double](Get-VxProp (Get-VxProp $VxProfile 'ram') 'totalGB' 0)
    foreach ($v in @('nvidia', 'amd', 'intel')) {
        if ($tags -contains $v) {
            $g = Get-VxShortGpuName $VxProfile $v
            if ($g) { return ("Passend zu deiner {0}: {1}" -f $g, $desc) }
            $cpu = [string](Get-VxProp (Get-VxProp $VxProfile 'cpu') 'name')
            if ($cpu) { return ("Passend zu deinem Prozessor ({0}): {1}" -f ($cpu -replace '\(R\)|\(TM\)', ''), $desc) }
        }
    }
    if ($tags -contains 'ssd' -and $disk -and $disk -ne 'Festplatte (HDD)') { return ("Du hast eine {0}, deshalb lohnt sich das: {1}" -f $disk, $desc) }
    if ($tags -contains 'hdd' -and $disk -eq 'Festplatte (HDD)') { return ("Windows liegt bei dir auf einer Festplatte (HDD), deshalb hilft das: {0}" -f $desc) }
    if (($tags -contains 'fivem' -or $tags -contains 'gta') -and $Goal -eq 'fivem') { return ("Speziell für FiveM und GTA V: {0}" -f $desc) }
    if ($tags -contains 'battery' -and (Test-VxIsLaptop $VxProfile)) { return ("Schont den Akku deines Laptops: {0}" -f $desc) }
    if ($tags -contains 'ping' -or $tags -contains 'network') {
        if ($hasLan) { return ("Für niedrigeren Ping über deine LAN-Verbindung: {0}" -f $desc) }
        if ($nets.Count -gt 0) { return ("Für einen stabileren Ping über WLAN: {0}" -f $desc) }
        return ("Für niedrigeren Ping: {0}" -f $desc)
    }
    if ($tags -contains 'input' -or $tags -contains 'latency') { return ("Damit Maus und Tastatur direkter reagieren: {0}" -f $desc) }
    if ($tags -contains 'stutter') {
        if ($ram -gt 0) { return ("Gegen Ruckler (bei deinen {0} GB RAM sinnvoll): {1}" -f $ram, $desc) }
        return ("Gegen Ruckler: {0}" -f $desc)
    }
    if ($tags -contains 'fps') {
        $g = Get-VxShortGpuName $VxProfile ''
        if ($g) { return ("Mehr FPS aus deiner {0}: {1}" -f $g, $desc) }
        return ("Mehr FPS: {0}" -f $desc)
    }
    if ($tags -contains 'privacy' -or $tags -contains 'telemetry') { return ("Weniger Daten an Microsoft: {0}" -f $desc) }
    if ($tags -contains 'ads' -or $tags -contains 'ai' -or $tags -contains 'bloat') { return ("Weniger Werbung und Ballast: {0}" -f $desc) }
    if ($tags -contains 'streaming') { return ("Gut fürs Streamen: {0}" -f $desc) }
    return $desc
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

function Get-VxFindings($VxProfile, [string]$Goal) {
    $ctx = $global:VxCtx
    $f = New-Object System.Collections.ArrayList
    if ($null -eq $VxProfile) { return @() }
    $isLaptop = Test-VxIsLaptop $VxProfile
    # ---- display refresh rate
    $d = Get-VxProp $VxProfile 'display'
    if ($null -ne $d) {
        $cur = [int](Get-VxProp $d 'currentHz' 0); $max = [int](Get-VxProp $d 'maxHz' 0)
        if ($cur -gt 0 -and $max -gt ($cur + 5)) {
            [void]$f.Add((New-VxFinding 'refresh-rate' 'bad' ("Bildschirm läuft nur mit {0} Hz" -f $cur) ("Dein Bildschirm schafft {0} Hz, Windows nutzt aber nur {1} Hz. Stell in den erweiterten Anzeigeeinstellungen die Bildwiederholrate auf {0} Hz - das ist der größte Gratis-Boost für flüssiges Spielen." -f $max, $cur) ([ordered]@{ type = 'open'; target = 'ms-settings:display-advanced' })))
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
            [void]$f.Add((New-VxFinding 'xmp' $sev ("Arbeitsspeicher läuft nur mit {0} MHz" -f $conf) ("Dein {0}-RAM läuft mit {1} MHz, typisch sind {2} MHz. Schalte im BIOS das XMP- bzw. EXPO-Profil ein - das bringt in CPU-lastigen Spielen oft spürbar mehr FPS. Das geht nur im BIOS, nicht per Software.{3}" -f $type, $conf, $typical, $extra) $null))
        }
    }
    # ---- VBS / HVCI
    $sec = Get-VxProp $VxProfile 'security'
    if ($null -ne $sec -and ((Get-VxProp $sec 'hvci') -eq $true -or (Get-VxProp $sec 'vbs') -eq $true)) {
        [void]$f.Add((New-VxFinding 'vbs' 'info' 'Kernisolierung (VBS/HVCI) ist an' "Das schützt den Windows-Kern vor Angriffen, kostet in manchen Spielen aber ein paar Prozent Leistung. VELOX schaltet das nie automatisch ab. Unter 'Experte (riskant)' findest du die passenden Tweaks - nur benutzen, wenn du das Risiko verstehst." $null))
    }
    # ---- power plan
    $pw = Get-VxProp $VxProfile 'power'
    if ($null -ne $pw) {
        $guid = [string](Get-VxProp $pw 'activePlan')
        if ($guid -eq (Get-VxPlanBaseGuid 'balanced') -and -not $isLaptop) {
            $ids = @(Get-VxApplicableFixIds @(Find-VxPlanTweakIds) $VxProfile)
            $fix = $null
            if ($ids.Count -gt 0) { $fix = [ordered]@{ type = 'tweaks'; ids = $ids } } else { $fix = [ordered]@{ type = 'open'; target = 'ms-settings:powersleep' } }
            [void]$f.Add((New-VxFinding 'power-plan' 'warn' "Energieplan 'Ausbalanciert' auf einem Desktop-PC" 'Der Prozessor taktet damit oft herunter und braucht Zeit zum Hochfahren - das kostet Reaktionszeit und kann Ruckler verursachen. Ein Leistungsplan hält ihn auf Trab.' $fix))
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
            [void]$f.Add((New-VxFinding 'disk-space' 'bad' ("Nur noch {0} GB frei auf dem Systemlaufwerk" -f $free) 'Windows wird langsam und Updates können fehlschlagen, wenn weniger als 10 GB frei sind. Räum auf.' ([ordered]@{ type = 'page'; page = 'cleanup' })))
        } elseif ([double]$free -lt 25) {
            [void]$f.Add((New-VxFinding 'disk-space' 'warn' ("Nur {0} GB frei auf dem Systemlaufwerk" -f $free) 'Etwas Platz schaffen hilft Windows und Spielen beim Nachladen.' ([ordered]@{ type = 'page'; page = 'cleanup' })))
        }
    }
    $temp = Get-VxProp $VxProfile 'tempMB'
    if ($null -ne $temp -and [double]$temp -gt 2000) {
        [void]$f.Add((New-VxFinding 'temp-files' 'info' ("{0:N1} GB temporäre Dateien" -f ([double]$temp / 1024)) 'Die kannst du gefahrlos löschen.' ([ordered]@{ type = 'page'; page = 'cleanup' })))
    }
    # ---- uptime
    $up = Get-VxProp $VxProfile 'uptimeHours'
    if ($null -ne $up -and [double]$up -gt 168) {
        [void]$f.Add((New-VxFinding 'uptime' 'info' ("Seit {0} Tagen kein Neustart" -f [math]::Floor([double]$up / 24)) 'Ein Neustart räumt den Arbeitsspeicher auf und schließt hängende Hintergrundprozesse. Danach läuft der PC meist runder.' $null))
    }
    # ---- startup apps
    $sc = Get-VxProp $VxProfile 'startupCount'
    if ($null -ne $sc -and [int]$sc -gt 8) {
        [void]$f.Add((New-VxFinding 'startup' 'warn' ("{0} Programme starten mit Windows" -f $sc) 'Jedes davon verlängert den Start und läuft danach im Hintergrund weiter. Schalte unter "Apps" ab, was du nicht sofort brauchst.' ([ordered]@{ type = 'page'; page = 'apps' })))
    }
    # ---- foreign tweaks
    $fc = Get-VxProp $VxProfile 'foreignCount'
    if ($null -eq $fc) { $fc = Get-VxProp $ctx.State 'foreignCount' $null }
    if ($null -ne $fc -and [int]$fc -gt 0) {
        [void]$f.Add((New-VxFinding 'foreign' 'warn' ("{0} Einstellungen von anderen Tweak-Tools gefunden" -f $fc) 'Andere Tweaker setzen oft Werte, die heute eher schaden. Mit Detweak setzt du sie sauber auf Standard zurück.' ([ordered]@{ type = 'page'; page = 'detweak' })))
    }
    # ---- backups
    $hasBackups = $false
    try { $hasBackups = (@(Get-ChildItem -LiteralPath $ctx.BackupDir -Filter '*.json' -File -ErrorAction Stop).Count -gt 0) } catch { $null = $_ }
    if (-not $hasBackups -and [int](Get-VxProp $ctx.State 'restorePoints' 0) -eq 0) {
        [void]$f.Add((New-VxFinding 'no-backups' 'info' 'Noch keine Sicherung vorhanden' 'Keine Sorge: VELOX sichert vor jeder Änderung automatisch alle alten Werte und legt einen Windows-Wiederherstellungspunkt an. Du kannst alles jederzeit zurückholen.' $null))
    }
    # ---- good news
    if ([string](Get-VxProp $VxProfile 'systemDisk') -eq 'ssd') {
        [void]$f.Add((New-VxFinding 'ssd' 'good' ("Windows liegt auf einer {0}" -f (Get-VxDiskLabel $VxProfile)) 'Schnelle Ladezeiten - perfekt.' $null))
    }
    return @($f)
}

function Get-VxSeverityPenalty([string]$Severity) {
    switch ($Severity) { 'bad' { return 8 } 'warn' { return 4 } }
    return 0
}

# Score 0-100 = 60 % weighted share of the goal's recommended tweaks applied + 40 - finding penalties.
function Get-VxAdvisorScore($Candidates, $Findings, [string[]]$PlanIds) {
    $st = $global:VxCtx.State.statuses
    $total = 0.0; $done = 0.0; $after = 0.0
    foreach ($c in @($Candidates)) {
        $t = $c.tweak
        $w = [double](Get-VxProp $t 'impact' 1)
        if ($w -lt 1) { $w = 1 }
        $total += $w
        $s = [string]$st[[string]$t.id]
        if ($s -eq 'applied') { $done += $w; $after += $w }
        elseif ($PlanIds -contains [string]$t.id) { $after += $w }
    }
    $share = 1.0; $shareAfter = 1.0
    if ($total -gt 0) { $share = $done / $total; $shareAfter = $after / $total }
    $pen = 0; $penAfter = 0
    foreach ($f in @($Findings)) {
        $p = Get-VxSeverityPenalty ([string]$f.severity)
        $pen += $p
        $fixed = $false
        $fix = Get-VxProp $f 'fix'
        if ($null -ne $fix -and [string](Get-VxProp $fix 'type') -eq 'tweaks') {
            $ids = @(Get-VxProp $fix 'ids' @())
            if ($ids.Count -gt 0) {
                $fixed = $true
                foreach ($i in $ids) { if (-not ($PlanIds -contains [string]$i) -and [string]$st[[string]$i] -ne 'applied') { $fixed = $false } }
            }
        }
        if (-not $fixed) { $penAfter += $p }
    }
    if ($pen -gt 40) { $pen = 40 }
    if ($penAfter -gt 40) { $penAfter = 40 }
    $score = [int][math]::Round(60 * $share + 40 - $pen)
    $scoreAfter = [int][math]::Round(60 * $shareAfter + 40 - $penAfter)
    $score = [math]::Max(0, [math]::Min(100, $score))
    $scoreAfter = [math]::Max($score, [math]::Min(100, $scoreAfter))
    return @{ score = $score; scoreAfter = $scoreAfter }
}

# The local advisor. Returns advisorResult (contract section 7).
function Invoke-VxAdvisor([string]$Goal, [string]$Text, $VxProfile) {
    $valid = @('gaming', 'competitive', 'balanced', 'privacy', 'laptop', 'streaming', 'fivem')
    if ($valid -notcontains $Goal) { $Goal = 'gaming' }
    $cfg = Get-VxGoalConfig $Goal
    $extra = @(Get-VxTextTags $Text)
    $cands = @(Get-VxGoalCandidates $Goal $VxProfile $extra)
    $st = $global:VxCtx.State.statuses
    $plan = New-Object System.Collections.ArrayList
    $rows = @()
    foreach ($c in $cands) {
        $t = $c.tweak
        if ([string]$st[[string]$t.id] -eq 'applied') { continue }
        $impact = [int](Get-VxProp $t 'impact' 1)
        $prio = 4 - $impact
        if ($prio -lt 1) { $prio = 1 }
        if ($prio -gt 3) { $prio = 3 }
        if ($c.keyword -and $prio -gt 1) { $prio-- }
        $kw = 1
        if ($c.keyword) { $kw = 0 }
        $rows += [pscustomobject]@{ id = [string]$t.id; prio = $prio; kw = $kw; impact = $impact; risk = (Get-VxRiskRank ([string]$t.risk)); tweak = $t }
    }
    $sorted = @($rows | Sort-Object -Property @{ Expression = 'prio' }, @{ Expression = 'kw' }, @{ Expression = 'impact'; Descending = $true }, @{ Expression = 'risk' }, @{ Expression = 'id' })
    foreach ($r in ($sorted | Select-Object -First 60)) {
        [void]$plan.Add([ordered]@{ id = $r.id; reason = (Get-VxPlanReason $r.tweak $VxProfile $Goal); priority = $r.prio })
    }
    $findings = @(Get-VxFindings $VxProfile $Goal)
    $planIds = @($plan | ForEach-Object { $_.id })
    $sc = Get-VxAdvisorScore $cands $findings $planIds
    $bad = @($findings | Where-Object { $_.severity -eq 'bad' -or $_.severity -eq 'warn' })
    $summary = ("Dein PC erreicht {0} von 100 Punkten für das Ziel '{1}'." -f $sc.score, $cfg.name)
    if ($plan.Count -gt 0) { $summary += (" Mit den {0} empfohlenen Tweaks kommst du auf etwa {1} Punkte." -f $plan.Count, $sc.scoreAfter) }
    else { $summary += ' Alle passenden Tweaks sind schon aktiv - stark!' }
    if ($bad.Count -gt 0) { $summary += (" Am wichtigsten: {0}." -f $bad[0].title) }
    if ($extra.Count -gt 0) { $summary += (' Deine Beschreibung wurde berücksichtigt (' + ($extra -join ', ') + ').') }
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
