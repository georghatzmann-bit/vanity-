# VELOX - core/Claude.ps1
# KI providers of the KI-Optimierer (docs/ARCHITECTURE.md section 9). Every provider gets the same
# rules, the same catalog data and the same output schema, and every answer goes through the same
# validation (Select-VxClaudePlan) and local scoring (Complete-VxAiResult):
#   claude-code  the user's own Claude Code CLI ("claude -p") with their subscription login, no key
#   claude-api   raw HTTPS to the Anthropic Messages API with the user's API key
#   groq         Groq's OpenAI-compatible chat API with the user's (free) API key
#   offline      the local Smart-Analyse (core/Advisor.ps1), always available
# The file keeps its old name because Velox.ps1 and the job runspace load a fixed list of core files.
# API keys are stored DPAPI-encrypted and are never logged or returned to the UI.
# Only function definitions.

# ================================================================== secrets (claude.key, groq.key)

function Get-VxSecretPath([string]$Name) { return (Get-VxDataPath ($Name + '.key')) }

function Test-VxSecret([string]$Name) {
    try { return [IO.File]::Exists((Get-VxSecretPath $Name)) } catch { return $false }
}

function Set-VxSecret([string]$Name, [string]$Value) {
    $path = Get-VxSecretPath $Name
    if (Test-VxWindows) {
        $sec = ConvertTo-SecureString -String $Value -AsPlainText -Force
        $enc = ConvertFrom-SecureString -SecureString $sec
        Write-VxTextFile -Path $path -Text $enc
    } else {
        # non-Windows is only used by tests: no DPAPI available, base64 is good enough there
        Write-VxTextFile -Path $path -Text ('b64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value)))
    }
}

function Remove-VxSecret([string]$Name) {
    $path = Get-VxSecretPath $Name
    if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
}

function Get-VxSecret([string]$Name, [string]$Label = 'API-Key') {
    $path = Get-VxSecretPath $Name
    if (-not [IO.File]::Exists($path)) { return $null }
    $text = ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)).Trim()
    if ($text.StartsWith('b64:')) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text.Substring(4))) }
    try {
        $sec = ConvertTo-SecureString -String $text -ErrorAction Stop
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    } catch {
        throw ('Der gespeicherte ' + $Label + ' kann nicht gelesen werden (anderer Windows-Benutzer?). Bitte trag ihn in den Einstellungen neu ein.')
    }
}

function Get-VxClaudeKeyPath { return (Get-VxSecretPath 'claude') }
function Test-VxClaudeKey { return (Test-VxSecret 'claude') }
function Remove-VxClaudeKey { Remove-VxSecret 'claude' }
function Get-VxClaudeKey { return (Get-VxSecret 'claude' 'API-Key') }
function Set-VxClaudeKey([string]$Key) {
    $k = ([string]$Key).Trim()
    if ($k -notmatch '^sk-ant-[A-Za-z0-9_\-]{16,400}$') { throw 'Das sieht nicht wie ein Anthropic-API-Key aus (er beginnt mit „sk-ant-“).' }
    Set-VxSecret 'claude' $k
}

function Get-VxGroqKeyPath { return (Get-VxSecretPath 'groq') }
function Test-VxGroqKey { return (Test-VxSecret 'groq') }
function Remove-VxGroqKey { Remove-VxSecret 'groq' }
function Get-VxGroqKey { return (Get-VxSecret 'groq' 'Groq-Key') }
function Set-VxGroqKey([string]$Key) {
    $k = ([string]$Key).Trim()
    if ($k -notmatch '^gsk_[A-Za-z0-9]{20,200}$') { throw 'Das sieht nicht wie ein Groq-API-Key aus (er beginnt mit „gsk_“).' }
    Set-VxSecret 'groq' $k
}

# ================================================================== providers + settings

function Get-VxAiProviderIds { return @('claude-code', 'claude-api', 'groq', 'offline') }

function Get-VxAiProviderName([string]$Provider) {
    switch ($Provider) {
        'claude-code' { return 'Claude Code' }
        'claude-api' { return 'Claude' }
        'groq' { return 'Groq' }
    }
    return 'Smart-Analyse'
}

# Claude Code model aliases (the CLI resolves them to the newest model of that family).
function Get-VxClaudeCodeModels { return @('sonnet', 'opus', 'haiku') }

function Get-VxClaudeCodeModel {
    $s = $global:VxCtx.Settings
    $m = ''
    try { $m = [string]$s.ai.claudeCode.model } catch { $m = '' }
    if ((Get-VxClaudeCodeModels) -notcontains $m) { return 'sonnet' }
    return $m
}

# '' = automatic (best model the key can use right now, see Resolve-VxGroqModel)
function Get-VxGroqModelSetting {
    $s = $global:VxCtx.Settings
    $m = ''
    try { $m = [string]$s.ai.groq.model } catch { $m = '' }
    if ($m -notmatch '^[A-Za-z0-9][A-Za-z0-9._/:\-]{1,100}$') { return '' }
    return $m
}

# Test-only overrides (base URLs, CLI path) are ignored in real mode on Windows, so a value planted
# in the user environment can neither send an API key somewhere else nor run another program.
function Test-VxAiTestMode {
    $ctx = $global:VxCtx
    return ($null -eq $ctx -or $ctx.Simulate -or -not $ctx.Windows)
}

# ================================================================== shared prompt + validation

function Get-VxClaudeSchema {
    return [ordered]@{
        type = 'object'
        properties = [ordered]@{
            summary = [ordered]@{ type = 'string' }
            findings = [ordered]@{
                type = 'array'
                items = [ordered]@{
                    type = 'object'
                    properties = [ordered]@{
                        severity = [ordered]@{ type = 'string'; enum = @('good', 'info', 'warn', 'bad') }
                        title = [ordered]@{ type = 'string' }
                        detail = [ordered]@{ type = 'string' }
                    }
                    required = @('severity', 'title', 'detail')
                    additionalProperties = $false
                }
            }
            plan = [ordered]@{
                type = 'array'
                items = [ordered]@{
                    type = 'object'
                    properties = [ordered]@{
                        id = [ordered]@{ type = 'string' }
                        reason = [ordered]@{ type = 'string' }
                    }
                    required = @('id', 'reason')
                    additionalProperties = $false
                }
            }
        }
        required = @('summary', 'findings', 'plan')
        additionalProperties = $false
    }
}

# The rules every provider gets. Mode 'full' = the whole catalog digest follows (Claude API, Claude
# Code); 'compact' = a short candidate list already filtered for this PC follows (Groq's free tier
# allows only a few thousand tokens per minute). Stable text: the cached API prefix stays identical.
function Get-VxAiRulesText([string]$Mode = 'full') {
    $list = 'Choose ONLY tweak ids that appear in the catalog digest below. Never invent ids. Copy them exactly.'
    $size = 'Keep the plan focused: the most useful 5 to 40 tweaks, most important first.'
    if ($Mode -eq 'compact') {
        $list = 'Choose ONLY tweak ids from the candidate list below (it is already filtered for this PC: every entry fits the hardware and is not applied yet). Never invent ids. Copy them exactly.'
        $size = 'Keep the plan focused: the most useful 5 to 20 tweaks, most important first. Each reason is one short sentence.'
    }
    return (@'
You are the optimization advisor inside VELOX, a Windows 10/11 tweaking tool. You receive a hardware/system profile of the user's PC, the current status of tweaks, the user's goal and an optional free-text description of their problem. You choose which tweaks from the VELOX catalog the user should apply and explain why.

Rules:
- {LIST}
- Prefer tweaks with risk "safe". Use "moderate" only when it clearly serves the goal and the trade-off is acceptable.
- NEVER choose a tweak with risk "risky" unless the request says allowRisky is true. Even then, only if it directly serves the goal, and say clearly in the reason what protection is lost.
- Do not choose tweaks whose status is "applied" or "na".
- Respect the profile: on laptops (formFactor "laptop") never choose tweaks tagged "laptop-bad"; choose vendor-tagged tweaks (nvidia, amd, intel) only when the PC has hardware from that vendor; if Windows is on an HDD, do not disable SysMain/prefetch and do not choose "ssd" tweaks; with less than 16 GB RAM, do not disable memory compression or paging.
- AMD Ryzen X3D CPUs with two chiplets (7900X3D, 7950X3D, 9900X3D, 9950X3D) need the "Balanced" power plan and core parking so games run on the V-Cache cores: on those CPUs never choose power plan or core parking tweaks, nor any tweak whose warning mentions X3D, and never call "Balanced" a problem.
- Read each tweak's warning. Tweaks whose text says they only help with a specific problem (flicker, a VRR monitor, mesh WLAN, mixed results) are chosen only when the user's free text describes that problem. Do not choose WLAN tweaks for a PC without a WLAN adapter, and choose per-game priority tweaks only for games the user mentions.
- Match the goal: gaming = FPS, stutter, latency; competitive = also input and network/ping; balanced = safe improvements only; privacy = telemetry, ads, AI features; laptop = battery and heat; streaming = like gaming but keep capture/Game Bar features; fivem = gaming plus FiveM/GTA V specific tweaks.
- Use the free text: map complaints (stutter, ping, input delay, battery, privacy) to the matching tweaks.
- Write every text (summary, finding titles and details, reasons) in simple German, addressing the user as "du". No jargon; when a technical term is unavoidable, explain it in a few words.
- Each plan reason: one or two short sentences saying what it brings for THIS PC (mention the hardware when relevant, e.g. "Du hast eine NVMe-SSD, deshalb ...").
- Findings: notable observations about the PC (e.g. monitor running below its maximum refresh rate, RAM running without XMP/EXPO, low free disk space, many autostart apps, core isolation on). Severity: good, info, warn or bad. Never tell the user to disable security features as a finding fix.
- {SIZE}
- Answer only with the JSON object described by the output schema, nothing before or after it: {"summary": "...", "findings": [{"severity": "good|info|warn|bad", "title": "...", "detail": "..."}], "plan": [{"id": "<tweak id>", "reason": "..."}]}
'@).Replace('{LIST}', $list).Replace('{SIZE}', $size)
}

function Get-VxClaudeSystemText { return (Get-VxAiRulesText 'full') }

function Get-VxDigestLine($Tweak, [switch]$Compact) {
    $t = $Tweak
    $tags = (@($t.tags) | ForEach-Object { [string]$_ }) -join ','
    $name = ([string]$t.name) -replace '[\r\n|]+', ' '
    $warn = ([string](Get-VxProp $t 'warning' '')) -replace '[\r\n|]+', ' '
    if ([bool](Get-VxProp $t 'situational' $false)) { $warn = ('nur bei passendem Problem. ' + $warn).Trim() }
    if ($Compact) {
        if ($warn.Length -gt 90) { $warn = $warn.Substring(0, 87) + '...' }
        return ('{0} | {1} | {2} | {3} | {4}' -f $t.id, $name, $t.risk, $tags, $warn)
    }
    $desc = ([string]$t.desc) -replace '[\r\n|]+', ' '
    return ('{0} | {1} | {2} | {3} | {4} | {5} | {6}' -f $t.id, $name, $t.category, $t.risk, $tags, $desc, $warn)
}

# One line per toggle tweak: id | name | category | risk | tags | desc | warning (sorted, stable for caching).
function Get-VxCatalogDigest {
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add('VELOX catalog digest (id | name | category | risk | tags | desc | warning):')
    foreach ($t in @($global:VxCtx.Catalog.tweaks | Sort-Object { [string]$_.id })) {
        if ((Get-VxTweakKind $t) -ne 'toggle') { continue }
        [void]$lines.Add((Get-VxDigestLine $t))
    }
    return ($lines -join "`n")
}

# Candidate list for small token budgets: the local advisor's recommended set for this goal first
# (already filtered for this PC), then the other fitting candidates by impact, then - only with
# allowRisky - risky tweaks that fit the PC. Applied tweaks are left out. Stops at MaxChars.
function Get-VxCompactDigest([string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile, [int]$MaxChars = 9000) {
    $st = $global:VxCtx.State.statuses
    $extra = @(Get-VxTextTags $Text)
    $ids = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    $add = {
        param($t)
        $id = [string]$t.id
        if ($seen.ContainsKey($id)) { return }
        $seen[$id] = $true
        if ([string]$st[$id] -eq 'applied' -or [string]$st[$id] -eq 'na') { return }
        $ids.Add($id)
    }
    foreach ($r in @(Get-VxRecommended $Goal $VxProfile $extra @(Get-VxFindings $VxProfile $Goal -All))) { & $add $r.tweak }
    $more = @(Get-VxGoalCandidates $Goal $VxProfile $extra @() | Sort-Object -Property @{ Expression = { [int](Get-VxProp $_.tweak 'impact' 1) }; Descending = $true }, @{ Expression = { [string]$_.tweak.id } })
    foreach ($c in $more) { & $add $c.tweak }
    if ($AllowRisky) {
        foreach ($t in @($global:VxCtx.Catalog.tweaks)) {
            if ((Get-VxTweakKind $t) -ne 'toggle' -or [string]$t.risk -ne 'risky') { continue }
            if (-not (Test-VxWhen $t $VxProfile $false).ok) { continue }
            & $add $t
        }
    }
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add('Candidate tweaks for this PC (id | name | risk | tags | warning):')
    $len = $lines[0].Length
    foreach ($id in $ids) {
        $l = Get-VxDigestLine (Get-VxTweak $id) -Compact
        if ($len + $l.Length + 1 -gt $MaxChars -and $lines.Count -gt 1) { break }
        [void]$lines.Add($l)
        $len += $l.Length + 1
    }
    return ($lines -join "`n")
}

# Profile without anything that could identify the user (adapter names can be user-chosen).
function Get-VxClaudeProfile($VxProfile) {
    if ($null -eq $VxProfile) { return $null }
    $h = ConvertTo-VxHashtable (ConvertFrom-VxJsonText (ConvertTo-VxJson $VxProfile))
    if ($h.ContainsKey('network')) {
        $h.network = @(@($h.network) | ForEach-Object { [ordered]@{ type = $_.type; linkMbps = $_.linkMbps } })
    }
    foreach ($k in @('userName', 'computerName', 'serial', 'user', 'host')) { $h.Remove($k) }
    return $h
}

function Get-VxAiUserContent([string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile, [switch]$Compact) {
    $payload = [ordered]@{
        goal = $Goal
        goalName = (Get-VxGoalConfig $Goal).name
        allowRisky = $AllowRisky
        userText = $Text
        profile = (Get-VxClaudeProfile $VxProfile)
    }
    if ($Compact) {
        $payload.tweakStatus = [ordered]@{ note = 'The candidate list only contains tweaks that fit this PC and are not applied yet.' }
    } else {
        $st = $global:VxCtx.State.statuses
        $byStatus = [ordered]@{ applied = @(); partial = @(); custom = @(); na = @() }
        foreach ($id in @($st.Keys | Sort-Object)) {
            $s = [string]$st[$id]
            if ($byStatus.Contains($s)) { $byStatus[$s] += $id }
        }
        $payload.tweakStatus = [ordered]@{
            note = 'Every catalog tweak not listed here is at the Windows default (not applied).'
            applied = $byStatus.applied; partial = $byStatus.partial; custom = $byStatus.custom; na = $byStatus.na
        }
    }
    return ("Here is my PC and what I want. Choose the tweaks for me.`n`n" + (ConvertTo-VxJson $payload))
}

function Get-VxClaudeUserContent([string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile) {
    return (Get-VxAiUserContent $Goal $Text $AllowRisky $VxProfile)
}

# The advisor JSON out of a model's text: plain JSON, JSON in a ``` fence, or the outermost {...}.
function ConvertFrom-VxAiJsonText([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $t = $Text.Trim()
    if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
    $tries = New-Object System.Collections.Generic.List[string]
    $tries.Add($t)
    $m = [regex]::Match($t, '```(?:json)?\s*([\s\S]*?)```')
    if ($m.Success) { $tries.Add($m.Groups[1].Value.Trim()) }
    $a = $t.IndexOf('{'); $b = $t.LastIndexOf('}')
    if ($a -ge 0 -and $b -gt $a) { $tries.Add($t.Substring($a, $b - $a + 1)) }
    foreach ($x in $tries) {
        try {
            $o = ConvertFrom-VxJsonText $x
            if ($null -ne $o -and $o -isnot [string] -and $o -isnot [array]) { return $o }
        } catch { $null = $_ }
    }
    return $null
}

# Validates a model's plan ids. Returns @{ plan; dropped }.
function Select-VxClaudePlan($Items, [bool]$AllowRisky, $VxProfile) {
    $plan = New-Object System.Collections.ArrayList
    $dropped = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    $claimed = @{}
    foreach ($p in @($Items)) {
        $id = [string](Get-VxProp $p 'id')
        if (-not $id -or $seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        $t = Get-VxTweak $id
        if ($null -eq $t) { $dropped.Add("$id (unbekannt)"); continue }
        if ((Get-VxTweakKind $t) -ne 'toggle') { $dropped.Add("$id (keine Umschalt-Option)"); continue }
        if ([string]$t.risk -eq 'risky' -and -not $AllowRisky) { $dropped.Add("$id (riskant)"); continue }
        $tags = @(@($t.tags) | ForEach-Object { [string]$_ })
        if ($tags -contains 'security-off' -and -not $AllowRisky) { $dropped.Add("$id (schaltet Schutz ab)"); continue }
        if ($tags -contains 'laptop-bad' -and (Test-VxIsLaptop $VxProfile)) { $dropped.Add("$id (schlecht für Laptops)"); continue }
        if ((Test-VxDualCcdX3d $VxProfile) -and (Test-VxX3dHostile $t)) { $dropped.Add("$id (kostet auf Ryzen X3D mit zwei Chiplets FPS)"); continue }
        if (-not (Test-VxWhen $t $VxProfile $false).ok -or [string]$global:VxCtx.State.statuses[$id] -eq 'na') { $dropped.Add("$id (passt nicht zu diesem PC)"); continue }
        $keys = @(Get-VxTweakTargetKeys $t)
        $clash = @($keys | Where-Object { $claimed.ContainsKey($_) }).Count -gt 0
        if ($clash) { [void]$dropped.Add("$id (widerspricht einem anderen Vorschlag)"); continue }
        foreach ($k in $keys) { $claimed[$k] = $true }
        $reason = ([string](Get-VxProp $p 'reason')).Trim()
        if ($reason.Length -gt 500) { $reason = $reason.Substring(0, 500) }
        if (-not $reason) { $reason = [string]$t.desc }
        $impact = [int](Get-VxProp $t 'impact' 1)
        $prio = 4 - $impact
        if ($prio -lt 1) { $prio = 1 }
        if ($prio -gt 3) { $prio = 3 }
        [void]$plan.Add([ordered]@{ id = $id; reason = $reason; priority = $prio })
    }
    return @{ plan = $plan.ToArray(); dropped = $dropped.ToArray() }
}

# Turns a provider's parsed answer into an advisorResult (section 7): plan ids validated, findings
# normalised (fix always null), score/scoreAfter from the local advisor's view of the plan.
function Complete-VxAiResult {
    param($Parsed, [string]$Provider, [string]$Model, $Usage, [string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile)
    $name = Get-VxAiProviderName $Provider
    if ($null -eq $Parsed -or -not (Test-VxProp $Parsed 'plan')) { throw ($name + ' hat keine gültige Antwort geliefert (kein lesbares JSON).') }
    Set-VxProgress 0.94 ('Prüfe die Vorschläge von {0} ...' -f $name)
    $sel = Select-VxClaudePlan (Get-VxProp $Parsed 'plan' @()) $AllowRisky $VxProfile
    foreach ($d in $sel.dropped) { Write-VxLog 'warn' ("Vorschlag verworfen: {0}" -f $d) }
    $prefix = 'claude-'
    if ($Provider -eq 'groq') { $prefix = 'groq-' }
    $findings = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($f in @(Get-VxProp $Parsed 'findings' @())) {
        if ($null -eq $f) { continue }
        $title = ([string](Get-VxProp $f 'title')).Trim()
        if (-not $title) { continue }
        $i++
        $sev = [string](Get-VxProp $f 'severity')
        if (@('good', 'info', 'warn', 'bad') -notcontains $sev) { $sev = 'info' }
        [void]$findings.Add([ordered]@{ id = ($prefix + $i); severity = $sev; title = $title; detail = [string](Get-VxProp $f 'detail'); fix = $null })
        if ($i -ge 12) { break }
    }
    $localFindings = @(Get-VxFindings $VxProfile $Goal)
    $rec = @(Get-VxRecommended $Goal $VxProfile @(Get-VxTextTags $Text) @(Get-VxFindings $VxProfile $Goal -All))
    $sc = Get-VxAdvisorScore $rec $localFindings @($sel.plan | ForEach-Object { $_.id })
    $summary = ([string](Get-VxProp $Parsed 'summary')).Trim()
    if (-not $summary) { $summary = ('{0} schlägt dir {1} Tweaks vor.' -f $name, @($sel.plan).Count) }
    $engine = $Provider
    if ($Provider -eq 'claude-api') { $engine = 'claude' }
    Write-VxLog 'ok' ("{0} ({1}) schlägt {2} Tweaks vor." -f $name, $Model, @($sel.plan).Count)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{
        engine = $engine; provider = $Provider; score = $sc.score; scoreAfter = $sc.scoreAfter
        summary = $summary; findings = $findings.ToArray(); plan = $sel.plan
        model = $Model; usage = $Usage
    }
}

# ================================================================== HTTPS

# One HTTPS request. Returns @{ status; text; retryAfter } (status 0 = network error or timeout,
# text = German message then). Cancelling the job aborts the request (throws VX_CANCELLED).
function Send-VxHttpRequest {
    param([string]$Method, [string]$Url, [hashtable]$Headers = @{}, [string]$Json = $null, [int]$TimeoutSec = 60,
        [string]$Service = 'Claude', [string]$HostText = 'api.anthropic.com')
    try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch { $null = $_ }
    $uri = New-Object System.Uri($Url)
    $handler = New-Object System.Net.Http.HttpClientHandler
    if ($uri.IsLoopback) { $handler.UseProxy = $false }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $cts = New-Object System.Threading.CancellationTokenSource
    try {
        $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method.ToUpperInvariant())), $uri)
        foreach ($k in @($Headers.Keys)) { [void]$req.Headers.TryAddWithoutValidation([string]$k, [string]$Headers[$k]) }
        if ($null -ne $Json -and $Json -ne '') {
            $bytes = [Text.Encoding]::UTF8.GetBytes($Json)
            $content = New-Object System.Net.Http.ByteArrayContent -ArgumentList (, $bytes)
            $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/json')
            $req.Content = $content
        }
        $task = $client.SendAsync($req, $cts.Token)
        while (-not $task.Wait(500)) {
            $job = $global:VxJob
            if ($null -ne $job -and $job.cancel) { $cts.Cancel() }
        }
        $resp = $task.Result
        $rb = $resp.Content.ReadAsByteArrayAsync().Result
        $ra = -1
        try {
            $vals = $null
            if ($resp.Headers.TryGetValues('retry-after', [ref]$vals)) {
                $d = 0.0
                if ([double]::TryParse([string]@($vals)[0], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { $ra = [int][math]::Ceiling($d) }
            }
        } catch { $null = $_ }
        return @{ status = [int]$resp.StatusCode; text = [Text.Encoding]::UTF8.GetString($rb); retryAfter = $ra }
    } catch {
        $job = $global:VxJob
        if ($null -ne $job -and $job.cancel) { throw 'VX_CANCELLED' }
        $ex = $_.Exception
        while ($null -ne $ex.InnerException) { $ex = $ex.InnerException }
        if ($ex -is [System.Threading.Tasks.TaskCanceledException] -or $ex -is [TimeoutException]) {
            $span = ('{0} Sekunden' -f $TimeoutSec)
            if ($TimeoutSec -ge 120) { $span = ('{0} Minuten' -f [int]($TimeoutSec / 60)) }
            return @{ status = 0; retryAfter = -1; text = ('{0} hat nicht rechtzeitig geantwortet (Zeitüberschreitung nach {1}). Versuch es noch einmal oder nutze die lokale Smart-Analyse.' -f $Service, $span) }
        }
        return @{ status = 0; retryAfter = -1; text = ('Keine Verbindung zu {0} ({1}). Prüfe deine Internetverbindung. ({2})' -f $Service, $HostText, $ex.Message) }
    } finally {
        $client.Dispose()
        $cts.Dispose()
    }
}

function Get-VxApiErrorMessage([string]$Text) {
    try {
        $j = ConvertFrom-VxJsonText $Text
        $m = [string](Get-VxProp (Get-VxProp $j 'error') 'message')
        if ($m) { return $m }
    } catch { $null = $_ }
    if ($Text.Length -gt 300) { return $Text.Substring(0, 300) }
    return $Text
}

function Get-VxClaudeErrorMessage([string]$Text) { return (Get-VxApiErrorMessage $Text) }

# Waits n seconds in small steps so "Abbrechen" stays responsive.
function Wait-VxAiSeconds([double]$Seconds) {
    $n = [int][math]::Ceiling($Seconds * 2)
    for ($i = 0; $i -lt $n; $i++) { Test-VxCancel; Start-Sleep -Milliseconds 500 }
}

# ================================================================== provider: claude-api

function Get-VxClaudeBaseUrl {
    $b = $null
    if (Test-VxAiTestMode) { $b = [Environment]::GetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL') }
    if ([string]::IsNullOrWhiteSpace($b)) { $b = 'https://api.anthropic.com' }
    return $b.Trim().TrimEnd('/')
}

function Get-VxClaudeTimeoutSec { return 600 }

function New-VxClaudeBody([string]$Model, [string]$UserContent, [bool]$WithFallback) {
    $body = [ordered]@{ model = $Model; max_tokens = 16000 }
    if ($WithFallback) { $body.fallbacks = 'default' }
    $body.output_config = [ordered]@{ effort = 'high'; format = [ordered]@{ type = 'json_schema'; schema = (Get-VxClaudeSchema) } }
    $body.system = @(
        [ordered]@{ type = 'text'; text = (Get-VxClaudeSystemText) },
        [ordered]@{ type = 'text'; text = (Get-VxCatalogDigest); cache_control = [ordered]@{ type = 'ephemeral' } }
    )
    $body.messages = @([ordered]@{ role = 'user'; content = $UserContent })
    return $body
}

# Sends one Messages API request. Returns @{ status; text } (status 0 = network error, text = German message).
function Send-VxClaudeRequest([string]$Key, [string]$Json, [bool]$WithFallback) {
    $h = @{ 'x-api-key' = $Key; 'anthropic-version' = '2023-06-01' }
    if ($WithFallback) { $h['anthropic-beta'] = 'server-side-fallback-2026-07-01' }
    return (Send-VxHttpRequest -Method 'POST' -Url ((Get-VxClaudeBaseUrl) + '/v1/messages') -Headers $h -Json $Json -TimeoutSec (Get-VxClaudeTimeoutSec) -Service 'Claude' -HostText 'api.anthropic.com')
}

# Calls the API with the retry rules of section 9. Returns the parsed response object.
function Invoke-VxClaudeApi([string]$Key, $Body) {
    $withFallback = $true
    $retried5xx = $false
    $retriedFallback = $false
    $r = $null
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        Test-VxCancel
        $b = $Body
        if (-not $withFallback) { $b.Remove('fallbacks') }
        $r = Send-VxClaudeRequest $Key (ConvertTo-VxJson $b) $withFallback
        if ($r.status -eq 400 -and -not $retriedFallback -and $withFallback -and $r.text -match 'fallback') {
            Write-VxLog 'warn' 'Claude-API kennt die Fallback-Option nicht – neuer Versuch ohne.'
            $withFallback = $false
            $retriedFallback = $true
            continue
        }
        if (($r.status -ge 500 -or $r.status -eq 529) -and -not $retried5xx) {
            Write-VxLog 'warn' ("Claude ist gerade überlastet (HTTP {0}) – neuer Versuch in 3 Sekunden." -f $r.status)
            $retried5xx = $true
            Wait-VxAiSeconds 3
            continue
        }
        break
    }
    switch ($r.status) {
        200 { break }
        0 { throw $r.text }
        401 { throw 'API-Key ungültig. Bitte prüfe den Key in den Einstellungen.' }
        403 { throw ('Kein Zugriff auf dieses Modell (403): ' + (Get-VxApiErrorMessage $r.text)) }
        429 { throw 'Zu viele Anfragen an Claude. Bitte warte kurz und versuch es dann noch einmal.' }
        400 { throw ('Claude hat die Anfrage abgelehnt (400): ' + (Get-VxApiErrorMessage $r.text)) }
        default {
            if ($r.status -ge 500) { throw ("Claude ist gerade nicht erreichbar oder überlastet (HTTP {0}). Versuch es später noch einmal oder nutze die lokale Smart-Analyse." -f $r.status) }
            throw ("Unerwartete Antwort von Claude (HTTP {0}): {1}" -f $r.status, (Get-VxApiErrorMessage $r.text))
        }
    }
    try { return (ConvertFrom-VxJsonText $r.text) } catch { throw 'Claude hat eine unlesbare Antwort geschickt.' }
}

function Invoke-VxClaudeApiAdvisor([string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile) {
    $key = Get-VxClaudeKey
    if (-not $key) { throw 'Es ist noch kein Claude-API-Key hinterlegt. Trag ihn in den Einstellungen unter „KI“ ein.' }
    $model = [string]$global:VxCtx.Settings.claude.model
    if (-not $model) { $model = 'claude-opus-5-5' }
    Write-VxLog 'info' ('Frage Claude über die API ({0}).' -f $model)
    Set-VxProgress 0.65 ("Frage Claude ({0}) – das kann ein paar Minuten dauern ..." -f $model)
    $body = New-VxClaudeBody $model (Get-VxAiUserContent $Goal $Text $AllowRisky $VxProfile) $true
    $resp = Invoke-VxClaudeApi $key $body
    $stop = [string](Get-VxProp $resp 'stop_reason')
    if ($stop -eq 'refusal') { throw 'Claude hat diese Anfrage abgelehnt. Formuliere sie anders oder nutze die lokale Smart-Analyse.' }
    if ($stop -eq 'max_tokens') { throw 'Die Antwort von Claude war zu lang und wurde abgeschnitten. Bitte versuch es noch einmal.' }
    $textBlock = @(@(Get-VxProp $resp 'content' @()) | Where-Object { [string](Get-VxProp $_ 'type') -eq 'text' })
    if ($textBlock.Count -eq 0) { throw 'Claude hat keine Antwort geliefert.' }
    $parsed = $null
    try { $parsed = ConvertFrom-VxJsonText ([string]$textBlock[0].text) } catch { $parsed = $null }
    $usage = Get-VxProp $resp 'usage'
    $u = [ordered]@{
        input_tokens = Get-VxProp $usage 'input_tokens' 0
        output_tokens = Get-VxProp $usage 'output_tokens' 0
        cache_read_input_tokens = Get-VxProp $usage 'cache_read_input_tokens' 0
        cache_creation_input_tokens = Get-VxProp $usage 'cache_creation_input_tokens' 0
    }
    $served = [string](Get-VxProp $resp 'model' $model)
    return (Complete-VxAiResult -Parsed $parsed -Provider 'claude-api' -Model $served -Usage $u -Goal $Goal -Text $Text -AllowRisky $AllowRisky -VxProfile $VxProfile)
}

# "Verbindung testen": GET /v1/models costs nothing and answers 401 for a wrong key.
function Test-VxClaudeApiConnection {
    $key = Get-VxClaudeKey
    if (-not $key) { return [ordered]@{ ok = $false; message = 'Noch kein API-Key hinterlegt.' } }
    $r = Send-VxHttpRequest -Method 'GET' -Url ((Get-VxClaudeBaseUrl) + '/v1/models?limit=20') -Headers @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01' } -TimeoutSec 20 -Service 'Claude' -HostText 'api.anthropic.com'
    switch ($r.status) {
        200 { return [ordered]@{ ok = $true; message = 'Verbindung klappt – der Key ist gültig. (Der Test hat nichts gekostet.)' } }
        0 { return [ordered]@{ ok = $false; message = $r.text } }
        401 { return [ordered]@{ ok = $false; message = 'Der API-Key ist ungültig oder wurde gelöscht. Erstell unter console.anthropic.com einen neuen.' } }
        403 { return [ordered]@{ ok = $false; message = 'Der Key hat keinen Zugriff (403). Prüfe in der Anthropic-Konsole, ob er aktiv ist.' } }
        429 { return [ordered]@{ ok = $false; message = 'Gerade zu viele Anfragen – versuch es in einer Minute noch einmal.' } }
    }
    return [ordered]@{ ok = $false; message = ('Anthropic antwortet mit HTTP {0}: {1}' -f $r.status, (Get-VxApiErrorMessage $r.text)) }
}

# ================================================================== provider: groq

function Get-VxGroqBaseUrl {
    $b = $null
    if (Test-VxAiTestMode) { $b = [Environment]::GetEnvironmentVariable('VELOX_GROQ_BASE_URL') }
    if ([string]::IsNullOrWhiteSpace($b)) { $b = 'https://api.groq.com/openai/v1' }
    return $b.Trim().TrimEnd('/')
}

function Get-VxGroqTimeoutSec { return 90 }

# Best first. Groq retires models often, so the list of the key is read (GET /models, free) and the
# first available one wins; unknown newer chat models still show up in the settings.
function Get-VxGroqPreferredModels {
    return @('openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile',
        'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant')
}

# Models with strict json_schema support on Groq (others get json_object).
function Test-VxGroqStrictModel([string]$Model) {
    return ($Model -match '^openai/gpt-oss-(120b|20b)$' -or $Model -match '^qwen/qwen3')
}

function Test-VxGroqChatModel([string]$Id) {
    if (-not $Id) { return $false }
    return ($Id -notmatch '(?i)whisper|guard|tts|orpheus|playai|distil|compound|allam|embed|safeguard')
}

function Get-VxGroqModelLabel([string]$Id) {
    switch ($Id) {
        'openai/gpt-oss-120b' { return 'GPT-OSS 120B – beste Qualität' }
        'openai/gpt-oss-20b' { return 'GPT-OSS 20B – sehr schnell' }
        'qwen/qwen3.8-27b' { return 'Qwen 3.8 27B – gut und schnell' }
        'llama-3.3-70b-versatile' { return 'Llama 3.3 70B' }
        'llama-3.1-8b-instant' { return 'Llama 3.1 8B – am schnellsten, einfachere Antworten' }
    }
    return $Id
}

# Returns @{ ok; status; models:[ { id, label, strict, recommended } ]; message }.
function Get-VxGroqModels([string]$Key) {
    $r = Send-VxHttpRequest -Method 'GET' -Url ((Get-VxGroqBaseUrl) + '/models') -Headers @{ 'Authorization' = ('Bearer ' + $Key) } -TimeoutSec 20 -Service 'Groq' -HostText 'api.groq.com'
    $out = [ordered]@{ ok = $false; status = $r.status; models = @(); message = '' }
    if ($r.status -ne 200) {
        switch ($r.status) {
            0 { $out.message = $r.text }
            401 { $out.message = 'Der Groq-Key ist ungültig oder wurde gelöscht. Erstell unter console.groq.com/keys einen neuen.' }
            429 { $out.message = 'Gerade zu viele Anfragen an Groq – versuch es in einer Minute noch einmal.' }
            default { $out.message = ('Groq antwortet mit HTTP {0}: {1}' -f $r.status, (Get-VxApiErrorMessage $r.text)) }
        }
        return $out
    }
    $j = $null
    try { $j = ConvertFrom-VxJsonText $r.text } catch { $j = $null }
    $pref = @(Get-VxGroqPreferredModels)
    $rows = @()
    foreach ($m in @(Get-VxProp $j 'data' @())) {
        $id = [string](Get-VxProp $m 'id')
        if (-not (Test-VxGroqChatModel $id)) { continue }
        if ($m.PSObject.Properties['active'] -and $m.active -eq $false) { continue }
        $rank = [array]::IndexOf($pref, $id)
        if ($rank -lt 0) { $rank = 100 }
        $rows += [pscustomobject]@{ id = $id; rank = $rank }
    }
    $sorted = @($rows | Sort-Object -Property rank, id)
    $list = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $id = $sorted[$i].id
        [void]$list.Add([ordered]@{ id = $id; label = (Get-VxGroqModelLabel $id); strict = (Test-VxGroqStrictModel $id); recommended = ($i -eq 0 -and $sorted[$i].rank -lt 100) })
    }
    $out.ok = $true
    $out.models = $list.ToArray()
    $out.message = ('Verbindung klappt – {0} Modelle verfügbar. (Der Test hat nichts gekostet.)' -f $list.Count)
    return $out
}

# The model to use: the one picked in the settings, else the best one the key can use.
function Resolve-VxGroqModel([string]$Key, [string]$Exclude = '') {
    $want = Get-VxGroqModelSetting
    if ($want -and $want -ne $Exclude) { return $want }
    $ls = Get-VxGroqModels $Key
    if ($ls.ok) {
        foreach ($m in @($ls.models)) { if ($m.id -ne $Exclude) { return [string]$m.id } }
    } elseif ($ls.status -eq 401) {
        throw 'Groq-API-Key ungültig. Bitte prüfe den Key in den Einstellungen.'
    }
    foreach ($m in @(Get-VxGroqPreferredModels)) { if ($m -ne $Exclude) { return $m } }
    return 'openai/gpt-oss-120b'
}

function New-VxGroqBody([string]$Model, [string]$System, [string]$User, [string]$Format, [bool]$Extras, [int]$MaxTokens) {
    $body = [ordered]@{
        model = $Model
        messages = @([ordered]@{ role = 'system'; content = $System }, [ordered]@{ role = 'user'; content = $User })
        temperature = 0.2
        max_completion_tokens = $MaxTokens
    }
    if ($Format -eq 'schema') {
        $body.response_format = [ordered]@{ type = 'json_schema'; json_schema = [ordered]@{ name = 'velox_plan'; strict = $true; schema = (Get-VxClaudeSchema) } }
    } else {
        $body.response_format = [ordered]@{ type = 'json_object' }
    }
    if ($Extras -and $Model -match 'gpt-oss') {
        # reasoning models: short thinking keeps the answer inside the free tier's token budget
        $body.reasoning_effort = 'low'
        $body.include_reasoning = $false
    }
    return $body
}

function Invoke-VxGroqAdvisor([string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile) {
    $key = Get-VxGroqKey
    if (-not $key) { throw 'Es ist noch kein Groq-API-Key hinterlegt. Trag ihn in den Einstellungen unter „KI“ ein – er ist kostenlos (console.groq.com/keys).' }
    Set-VxProgress 0.62 'Wähle das Groq-Modell ...'
    $model = Resolve-VxGroqModel $key
    $format = 'json'
    if (Test-VxGroqStrictModel $model) { $format = 'schema' }
    $extras = $true
    $digestChars = 9000
    $maxTokens = 2800
    $shrunk = $false; $switched = $false; $retried5xx = $false; $retried429 = $false; $retriedFormat = $false
    $user = Get-VxAiUserContent $Goal $Text $AllowRisky $VxProfile -Compact
    $resp = $null
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        Test-VxCancel
        $digest = Get-VxCompactDigest $Goal $Text $AllowRisky $VxProfile $digestChars
        $system = (Get-VxAiRulesText 'compact') + "`n" + $digest
        $n = ([regex]::Matches($digest, "`n")).Count
        Write-VxLog 'info' ('Frage Groq ({0}) mit {1} passenden Tweaks.' -f $model, $n)
        Set-VxProgress 0.7 ('Groq ({0}) denkt nach – meist nur ein paar Sekunden ...' -f $model)
        $body = New-VxGroqBody $model $system $user $format $extras $maxTokens
        $r = Send-VxHttpRequest -Method 'POST' -Url ((Get-VxGroqBaseUrl) + '/chat/completions') -Headers @{ 'Authorization' = ('Bearer ' + $key) } -Json (ConvertTo-VxJson $body) -TimeoutSec (Get-VxGroqTimeoutSec) -Service 'Groq' -HostText 'api.groq.com'
        $msg = Get-VxApiErrorMessage $r.text
        if ($r.status -eq 200) {
            $j = $null
            try { $j = ConvertFrom-VxJsonText $r.text } catch { $j = $null }
            $choice = @(Get-VxProp $j 'choices' @())
            $content = ''
            $finish = ''
            if ($choice.Count -gt 0) {
                $content = [string](Get-VxProp (Get-VxProp $choice[0] 'message') 'content')
                $finish = [string](Get-VxProp $choice[0] 'finish_reason')
            }
            $parsed = ConvertFrom-VxAiJsonText $content
            if ($null -ne $parsed -and (Test-VxProp $parsed 'plan')) { $resp = @{ json = $j; parsed = $parsed }; break }
            if ($finish -eq 'length' -and -not $shrunk) {
                Write-VxLog 'warn' 'Die Antwort von Groq war zu lang – neuer Versuch mit kürzerer Liste.'
                $shrunk = $true; $digestChars = [math]::Max(1500, [int]($digest.Length * 0.55)); $maxTokens = 3200
                continue
            }
            if (-not $retriedFormat) {
                Write-VxLog 'warn' 'Groq hat kein lesbares JSON geschickt – neuer Versuch.'
                $retriedFormat = $true; $format = 'json'
                continue
            }
            if ($finish -eq 'length') { throw 'Die Antwort von Groq war zu lang und wurde abgeschnitten. Versuch es noch einmal oder wähle ein anderes Modell.' }
            throw 'Groq hat keine gültige Antwort geliefert (kein lesbares JSON). Versuch es noch einmal oder wähle in den Einstellungen ein anderes Modell.'
        }
        if ($r.status -eq 0) { throw $r.text }
        if ($r.status -eq 401) { throw 'Groq-API-Key ungültig. Bitte prüfe den Key in den Einstellungen.' }
        if ($r.status -eq 413 -or ($r.status -eq 429 -and $msg -match '(?i)request too large|requested \d+')) {
            if (-not $shrunk) {
                Write-VxLog 'warn' 'Die Anfrage ist zu groß für dein Groq-Limit – neuer Versuch mit kürzerer Liste.'
                $shrunk = $true; $digestChars = [math]::Max(1500, [int]($digest.Length * 0.55)); $maxTokens = 2000
                continue
            }
            throw 'Die Anfrage ist zu groß für dein kostenloses Groq-Limit. Wähle in den Einstellungen ein anderes Groq-Modell oder nimm Claude bzw. die Smart-Analyse.'
        }
        if ($r.status -eq 429) {
            $wait = [int]$r.retryAfter
            if (-not $retried429 -and $wait -ge 0 -and $wait -le 20) {
                Write-VxLog 'warn' ('Groq-Limit kurz erreicht – neuer Versuch in {0} Sekunden.' -f [math]::Max(1, $wait))
                $retried429 = $true
                Wait-VxAiSeconds ([math]::Max(1, $wait))
                continue
            }
            $when = 'ein paar Minuten'
            if ($wait -gt 0 -and $wait -lt 120) { $when = ('{0} Sekunden' -f $wait) }
            elseif ($wait -ge 120) { $when = ('etwa {0} Minuten' -f [int][math]::Ceiling($wait / 60)) }
            throw ('Dein kostenloses Groq-Limit ist gerade aufgebraucht. Versuch es in {0} noch einmal oder nimm solange die Smart-Analyse.' -f $when)
        }
        if ($r.status -eq 404 -or $r.text -match '(?i)model_not_found|decommissioned|does not exist|no longer supported|not supported for this model') {
            if (-not $switched) {
                $old = $model
                $model = Resolve-VxGroqModel $key $old
                $switched = $true
                $format = 'json'; if (Test-VxGroqStrictModel $model) { $format = 'schema' }
                Write-VxLog 'warn' ('Das Groq-Modell „{0}“ gibt es nicht mehr – nehme „{1}“. Du kannst es in den Einstellungen ändern.' -f $old, $model)
                continue
            }
            throw ('Groq kennt das Modell „{0}“ nicht. Wähle in den Einstellungen unter „KI“ ein anderes.' -f $model)
        }
        if ($r.status -eq 400) {
            if ($r.text -match '(?i)json_validate|response_format|json_schema|schema|generate JSON' -and -not $retriedFormat) {
                Write-VxLog 'warn' 'Groq konnte das Antwortformat nicht einhalten – neuer Versuch im einfachen JSON-Modus.'
                $retriedFormat = $true; $format = 'json'
                continue
            }
            if ($extras -and $msg -match '(?i)reasoning|include_reasoning|property|unsupported|not supported') {
                $extras = $false
                continue
            }
            throw ('Groq hat die Anfrage abgelehnt (400): ' + $msg)
        }
        if ($r.status -ge 500 -and -not $retried5xx) {
            Write-VxLog 'warn' ("Groq ist gerade überlastet (HTTP {0}) – neuer Versuch in 3 Sekunden." -f $r.status)
            $retried5xx = $true
            Wait-VxAiSeconds 3
            continue
        }
        if ($r.status -ge 500) { throw ("Groq ist gerade nicht erreichbar oder überlastet (HTTP {0}). Versuch es später noch einmal oder nutze die Smart-Analyse." -f $r.status) }
        if ($r.status -eq 403) { throw ('Groq verweigert den Zugriff (403): ' + $msg) }
        throw ("Unerwartete Antwort von Groq (HTTP {0}): {1}" -f $r.status, $msg)
    }
    if ($null -eq $resp) { throw 'Groq hat keine gültige Antwort geliefert. Versuch es noch einmal.' }
    $usage = Get-VxProp $resp.json 'usage'
    $u = [ordered]@{
        input_tokens = Get-VxProp $usage 'prompt_tokens' 0
        output_tokens = Get-VxProp $usage 'completion_tokens' 0
    }
    $served = [string](Get-VxProp $resp.json 'model' $model)
    return (Complete-VxAiResult -Parsed $resp.parsed -Provider 'groq' -Model $served -Usage $u -Goal $Goal -Text $Text -AllowRisky $AllowRisky -VxProfile $VxProfile)
}

# ================================================================== provider: claude-code (CLI)

function Get-VxClaudeCodeTimeoutSec { return 180 }

function Get-VxClaudeInstallCommand { return 'irm https://claude.ai/install.ps1 | iex' }

function Get-VxClaudeCodeInstallSteps {
    return @(
        'Öffne PowerShell als normaler Benutzer (Startmenü → „PowerShell“, nicht als Administrator).',
        ('Gib ein: ' + (Get-VxClaudeInstallCommand) + ' – und drück Enter.'),
        'Danach „claude“ eingeben und dich im Browser mit deinem Claude-Konto (Pro oder Max) anmelden.',
        'Zurück in VELOX auf „Erneut prüfen“ klicken.'
    )
}

function Get-VxClaudeCodeLoginSteps {
    return @(
        'Öffne PowerShell als normaler Benutzer (Startmenü → „PowerShell“, nicht als Administrator).',
        'Gib ein: claude auth login – oder starte „claude“ und tippe /login.',
        'Melde dich im Browser mit deinem Claude-Konto (Pro oder Max) an.',
        'Zurück in VELOX auf „Erneut prüfen“ klicken.'
    )
}

# Where the CLI may live, in this order: test override (Testmodus only), the native installer
# (%USERPROFILE%\.local\bin), npm, WinGet, then PATH. User folders are the desktop user's.
function Get-VxClaudeCliCandidates {
    $list = New-Object System.Collections.Generic.List[string]
    $onlyPath = $false
    if (Test-VxAiTestMode) {
        $o = [Environment]::GetEnvironmentVariable('VELOX_CLAUDE_CLI')
        if (-not [string]::IsNullOrWhiteSpace($o)) { $list.Add($o.Trim()) }
        # tests: never pick up a real installation from the well-known folders
        $onlyPath = ([Environment]::GetEnvironmentVariable('VELOX_CLAUDE_CLI_ONLY') -eq '1')
    }
    if ((Test-VxWindows) -and -not $onlyPath) {
        $prof = Get-VxUserFolder 'profile'
        $app = Get-VxUserFolder 'appData'
        $local = Get-VxUserFolder 'localAppData'
        if ($prof) { $list.Add([IO.Path]::Combine($prof, '.local\bin\claude.exe')) }
        if ($app) { $list.Add([IO.Path]::Combine($app, 'npm\claude.cmd')) }
        if ($local) {
            $list.Add([IO.Path]::Combine($local, 'Microsoft\WinGet\Links\claude.exe'))
            $pk = [IO.Path]::Combine($local, 'Microsoft\WinGet\Packages')
            try {
                if ([IO.Directory]::Exists($pk)) {
                    foreach ($d in @([IO.Directory]::GetDirectories($pk, 'Anthropic.ClaudeCode*'))) {
                        $list.Add([IO.Path]::Combine($d, 'claude.exe'))
                    }
                }
            } catch { $null = $_ }
        }
        $pf = [Environment]::GetEnvironmentVariable('ProgramFiles')
        if ($pf) { $list.Add([IO.Path]::Combine($pf, 'WinGet\Links\claude.exe')) }
    }
    try {
        foreach ($c in @(Get-Command 'claude' -CommandType Application -ErrorAction SilentlyContinue)) {
            $src = [string]$c.Source
            if (-not $src) { $src = [string]$c.Path }
            if ($src) { $list.Add($src) }
        }
    } catch { $null = $_ }
    $seen = @{}
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($p in $list) {
        $k = $p.ToLowerInvariant()
        if ($seen.ContainsKey($k)) { continue }
        $seen[$k] = $true
        $out.Add($p)
    }
    return $out.ToArray()
}

# How to start the CLI found at Path: @{ path; file; prefix:[args]; viaCmd }. An npm .cmd shim is
# resolved to its node.exe + cli.js (or bundled claude.exe) so the arguments never pass cmd.exe.
function Resolve-VxClaudeCliLaunch([string]$Path) {
    $l = @{ path = $Path; file = $Path; prefix = @(); viaCmd = $false }
    $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($ext -ne '.cmd' -and $ext -ne '.bat') { return $l }
    $dir = [IO.Path]::GetDirectoryName($Path)
    try {
        $text = [IO.File]::ReadAllText($Path)
        # the npm shim names "%dp0%\node.exe" (only there when node sits next to it) before the real
        # target - every quoted %dp0% path is tried, node.exe itself is never the target
        foreach ($m in [regex]::Matches($text, '"%(?:~dp0|dp0%)\\?([^"%]+?\.(?:exe|js|cjs|mjs))"', [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
            $rel = $m.Groups[1].Value.Replace('\', [string][IO.Path]::DirectorySeparatorChar)
            if ([IO.Path]::GetFileName($rel) -ieq 'node.exe') { continue }
            $target = [IO.Path]::GetFullPath([IO.Path]::Combine($dir, $rel))
            if (-not [IO.File]::Exists($target)) { continue }
            if ($target.ToLowerInvariant().EndsWith('.exe')) { $l.file = $target; return $l }
            $node = [IO.Path]::Combine($dir, 'node.exe')
            if (-not [IO.File]::Exists($node)) {
                $nc = @(Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue)
                $node = $null
                if ($nc.Count -gt 0) { $node = [string]$nc[0].Source }
            }
            if ($node) { $l.file = $node; $l.prefix = @($target); return $l }
            break
        }
    } catch { $null = $_ }
    $l.file = Get-VxSystemTool 'cmd.exe'
    $l.viaCmd = $true
    return $l
}

function Find-VxClaudeCli {
    foreach ($p in @(Get-VxClaudeCliCandidates)) {
        try { if ([IO.File]::Exists($p)) { return (Resolve-VxClaudeCliLaunch $p) } } catch { $null = $_ }
    }
    return $null
}

# Environment for every CLI run: no CLAUDE.md / auto memory from anywhere, no update checks or
# telemetry - VELOX only wants one answer.
function Get-VxClaudeCliEnv {
    return @('CLAUDE_CODE_DISABLE_CLAUDE_MDS=1', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'NO_COLOR=1')
}

# C# helper: starts a program with the token of the desktop's Explorer, i.e. as the signed-in user
# WITHOUT admin rights, with redirected stdin/stdout/stderr. VELOX itself runs elevated, and the
# Claude Code CLI lives in user-writable folders: it must never run with VELOX's admin rights.
function Get-VxShellLauncherSource {
    return @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace VxAi
{
    public sealed class ShellChild : IDisposable
    {
        public int Pid;
        public IntPtr Process = IntPtr.Zero;
        public FileStream StdIn;
        public FileStream StdOut;
        public FileStream StdErr;

        public bool Wait(int ms) { return WaitForSingleObject(Process, (uint)ms) == 0; }
        public int ExitCode { get { uint c = 0; GetExitCodeProcess(Process, out c); return unchecked((int)c); } }
        public void Kill() { if (Process != IntPtr.Zero) TerminateProcess(Process, 1); }
        public void Dispose()
        {
            try { if (StdIn != null) StdIn.Dispose(); } catch { }
            try { if (StdOut != null) StdOut.Dispose(); } catch { }
            try { if (StdErr != null) StdErr.Dispose(); } catch { }
            if (Process != IntPtr.Zero) { CloseHandle(Process); Process = IntPtr.Zero; }
        }

        public static ShellChild Start(string app, string commandLine, string cwd, string[] extraEnv)
        {
            IntPtr shell = GetShellWindow();
            if (shell == IntPtr.Zero) throw new InvalidOperationException("No desktop shell window.");
            uint pid = 0;
            GetWindowThreadProcessId(shell, out pid);
            if (pid == 0) throw new InvalidOperationException("No desktop shell process.");
            IntPtr hProc = OpenProcess(0x1000, false, pid);
            if (hProc == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            IntPtr tok = IntPtr.Zero, prim = IntPtr.Zero, envBlock = IntPtr.Zero, envMem = IntPtr.Zero;
            IntPtr inR = IntPtr.Zero, inW = IntPtr.Zero, outR = IntPtr.Zero, outW = IntPtr.Zero, errR = IntPtr.Zero, errW = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(hProc, 0x0002 | 0x0008 | 0x0001, out tok)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if (!DuplicateTokenEx(tok, 0x02000000, IntPtr.Zero, 2, 1, out prim)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
                sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                sa.bInheritHandle = true;
                if (!CreatePipe(out inR, out inW, ref sa, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if (!CreatePipe(out outR, out outW, ref sa, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if (!CreatePipe(out errR, out errW, ref sa, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                SetHandleInformation(inW, 1, 0);
                SetHandleInformation(outR, 1, 0);
                SetHandleInformation(errR, 1, 0);
                if (!CreateEnvironmentBlock(out envBlock, prim, false)) envBlock = IntPtr.Zero;
                envMem = Marshal.StringToHGlobalUni(BuildEnv(envBlock, extraEnv));
                STARTUPINFO si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = "winsta0\\default";
                si.dwFlags = 0x100 | 0x1;
                si.wShowWindow = 0;
                si.hStdInput = inR;
                si.hStdOutput = outW;
                si.hStdError = errW;
                PROCESS_INFORMATION pi;
                StringBuilder cl = new StringBuilder(commandLine, commandLine.Length + 1);
                if (!CreateProcessWithTokenW(prim, 1, app, cl, 0x08000000 | 0x00000400, envMem, cwd, ref si, out pi))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                CloseHandle(pi.hThread);
                ShellChild c = new ShellChild();
                c.Pid = pi.dwProcessId;
                c.Process = pi.hProcess;
                try
                {
                    c.StdIn = new FileStream(new SafeFileHandle(inW, true), FileAccess.Write, 4096, false); inW = IntPtr.Zero;
                    c.StdOut = new FileStream(new SafeFileHandle(outR, true), FileAccess.Read, 4096, false); outR = IntPtr.Zero;
                    c.StdErr = new FileStream(new SafeFileHandle(errR, true), FileAccess.Read, 4096, false); errR = IntPtr.Zero;
                }
                catch
                {
                    c.Kill();
                    c.Dispose();
                    throw;
                }
                return c;
            }
            finally
            {
                foreach (IntPtr h in new IntPtr[] { inR, inW, outR, outW, errR, errW, tok, prim, hProc })
                    if (h != IntPtr.Zero) CloseHandle(h);
                if (envBlock != IntPtr.Zero) DestroyEnvironmentBlock(envBlock);
                if (envMem != IntPtr.Zero) Marshal.FreeHGlobal(envMem);
            }
        }

        static string BuildEnv(IntPtr block, string[] extra)
        {
            SortedDictionary<string, string> d = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (block != IntPtr.Zero)
            {
                IntPtr p = block;
                while (true)
                {
                    string s = Marshal.PtrToStringUni(p);
                    if (string.IsNullOrEmpty(s)) break;
                    int eq = s.IndexOf('=', 1);
                    if (eq > 0) d[s.Substring(0, eq)] = s.Substring(eq + 1);
                    p = new IntPtr(p.ToInt64() + (s.Length + 1) * 2);
                }
            }
            else
            {
                foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) d[(string)e.Key] = (string)e.Value;
            }
            if (extra != null)
                foreach (string x in extra)
                {
                    int eq = x.IndexOf('=');
                    if (eq > 0) d[x.Substring(0, eq)] = x.Substring(eq + 1);
                }
            StringBuilder sb = new StringBuilder();
            foreach (KeyValuePair<string, string> kv in d) { sb.Append(kv.Key); sb.Append('='); sb.Append(kv.Value); sb.Append('\0'); }
            sb.Append('\0');
            return sb.ToString();
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
            public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
            public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
        [DllImport("user32.dll", SetLastError = true)] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr tok, uint access, IntPtr attrs, int level, int type, out IntPtr newTok);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr r, out IntPtr w, ref SECURITY_ATTRIBUTES sa, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
        [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr tok, bool inherit);
        [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessWithTokenW(IntPtr tok, int logonFlags, string app, StringBuilder cmd, int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    }
}
'@
}

# $true when Invoke-VxClaudeCli starts the CLI through VxAi.ShellChild (VELOX elevated on Windows).
function Test-VxClaudeShellLaunch {
    $ctx = $global:VxCtx
    return ((Test-VxWindows) -and $null -ne $ctx -and [bool]$ctx.Admin)
}

# The argument part of the CLI command line (npm shim prefix and cmd.exe wrapping included).
function Get-VxClaudeCliArgLine([hashtable]$Cli, [string[]]$Arguments) {
    $argLine = (@(@($Cli.prefix) + @($Arguments)) | ForEach-Object { ConvertTo-VxArgument ([string]$_) }) -join ' '
    if ($Cli.viaCmd) { $argLine = '/d /s /c "' + (ConvertTo-VxArgument ([string]$Cli.path)) + ' ' + $argLine + '"' }
    return $argLine
}

# Full command line as the process gets it. CreateProcessWithTokenW (the start without admin rights)
# accepts at most 1024 characters - the advisor drops the inline JSON schema when it would not fit.
function Get-VxClaudeCliLine([hashtable]$Cli, [string[]]$Arguments) {
    return ((ConvertTo-VxArgument ([string]$Cli.file)) + ' ' + (Get-VxClaudeCliArgLine $Cli $Arguments))
}

function Get-VxShellCommandLineMax { return 1000 }

function Initialize-VxShellLauncher {
    if ($null -ne ('VxAi.ShellChild' -as [type])) { return $true }
    try { Add-Type -TypeDefinition (Get-VxShellLauncherSource) -Language CSharp -ErrorAction Stop; return $true }
    catch { Write-VxFileLog 'warn' ('Starthilfe ohne Adminrechte nicht verfügbar: ' + $_.Exception.Message); return $false }
}

# Runs the Claude Code CLI once. Elevated on Windows it runs as the desktop user without admin
# rights (VxAi.ShellChild); otherwise as a normal child process. stdin gets StdinText (UTF-8).
# While it runs the job step shows Step + elapsed time and the progress creeps from ProgFrom to
# ProgTo. "Abbrechen" kills it at once (throws VX_CANCELLED).
# Returns @{ started; exitCode; output; error; timedOut; ms; message }.
function Invoke-VxClaudeCli {
    param([hashtable]$Cli, [string[]]$Arguments = @(), [string]$StdinText = $null, [int]$TimeoutSec = 30,
        [string]$Cwd = '', [string]$Step = '', [double]$ProgFrom = -1, [double]$ProgTo = -1)
    $ctx = $global:VxCtx
    $res = @{ started = $false; exitCode = -1; output = ''; error = ''; timedOut = $false; ms = 0; message = '' }
    $argLine = Get-VxClaudeCliArgLine $Cli $Arguments
    $file = [string]$Cli.file
    if (-not $Cwd -or -not [IO.Directory]::Exists($Cwd)) { $Cwd = [IO.Path]::GetTempPath() }
    $envList = @(Get-VxClaudeCliEnv)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $stdinBytes = $null
    if ($null -ne $StdinText) { $stdinBytes = $utf8.GetBytes($StdinText) }
    $job = $global:VxJob
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $shell = $null
    $p = $null
    $outTask = $null
    $errTask = $null
    $stdinStream = $null
    $stdinOpen = $false
    $useShell = Test-VxClaudeShellLaunch
    try {
        if ($useShell -and (Initialize-VxShellLauncher)) {
            try {
                $cmdLine = (ConvertTo-VxArgument $file) + ' ' + $argLine
                if ($cmdLine.Length -gt 1024) { Write-VxFileLog 'warn' ('Claude-Code-Befehlszeile hat {0} Zeichen (Grenze 1024).' -f $cmdLine.Length) }
                $shell = [VxAi.ShellChild]::Start($file, $cmdLine, $Cwd, [string[]]$envList)
            } catch {
                $shell = $null
                Write-VxFileLog 'warn' ('Start ohne Adminrechte fehlgeschlagen: ' + $_.Exception.Message)
                if ($null -ne $ctx.DesktopUser) {
                    $res.message = ('Claude Code muss unter deinem eigenen Windows-Konto laufen, VELOX wurde aber mit dem Konto eines anderen Administrators gestartet und kommt nicht an „{0}“ heran. Starte VELOX aus deinem eigenen Konto (Rechtsklick → „Als Administrator ausführen“ und dort dein eigenes Admin-Passwort) oder nimm Groq bzw. die Smart-Analyse.' -f [string]$ctx.DesktopUser.name)
                    return $res
                }
            }
        }
        if ($null -ne $shell) {
            $res.started = $true
            $outTask = (New-Object System.IO.StreamReader($shell.StdOut, $utf8)).ReadToEndAsync()
            $errTask = (New-Object System.IO.StreamReader($shell.StdErr, $utf8)).ReadToEndAsync()
            $stdinStream = $shell.StdIn
        } else {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $file
            $psi.Arguments = $argLine
            $psi.WorkingDirectory = $Cwd
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardInput = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.StandardOutputEncoding = $utf8
            $psi.StandardErrorEncoding = $utf8
            foreach ($e in $envList) { $i = $e.IndexOf('='); $psi.EnvironmentVariables[$e.Substring(0, $i)] = $e.Substring($i + 1) }
            try { $p = [System.Diagnostics.Process]::Start($psi) }
            catch { $res.message = ('Claude Code konnte nicht gestartet werden: ' + $_.Exception.Message); return $res }
            $res.started = $true
            $outTask = $p.StandardOutput.ReadToEndAsync()
            $errTask = $p.StandardError.ReadToEndAsync()
            $stdinStream = $p.StandardInput.BaseStream
        }
        # stdin is written in the background: a CLI that never reads it cannot block VELOX
        $stdinTask = $null
        if ($null -ne $stdinBytes -and $stdinBytes.Length -gt 0) {
            try { $stdinTask = $stdinStream.WriteAsync($stdinBytes, 0, $stdinBytes.Length) } catch { $stdinTask = $null }
        }
        $stdinOpen = $true
        $lastSec = -1
        $cancelled = $false
        while ($true) {
            if ($stdinOpen -and ($null -eq $stdinTask -or $stdinTask.IsCompleted)) {
                try { $stdinStream.Flush() } catch { $null = $_ }
                try { $stdinStream.Dispose() } catch { $null = $_ }
                $stdinOpen = $false
            }
            $done = $false
            if ($null -ne $shell) { $done = $shell.Wait(200) } else { $done = $p.WaitForExit(200) }
            if ($done) { break }
            if ($null -ne $job -and $job.cancel) { $cancelled = $true; break }
            $sec = [int][math]::Floor($sw.Elapsed.TotalSeconds)
            if ($sec -ge $TimeoutSec) { $res.timedOut = $true; break }
            if ($Step -and $sec -ne $lastSec) {
                $lastSec = $sec
                $prog = -1
                if ($ProgFrom -ge 0 -and $ProgTo -gt $ProgFrom) { $prog = $ProgFrom + ($ProgTo - $ProgFrom) * (1 - [math]::Exp(-$sec / 45.0)) }
                if ($sec -ge 2) { Set-VxProgress $prog ('{0} ({1}:{2:00})' -f $Step, [int][math]::Floor($sec / 60), ($sec % 60)) }
                elseif ($prog -ge 0) { Set-VxProgress $prog }
            }
        }
        if ($cancelled -or $res.timedOut) {
            if ($null -ne $shell) {
                try { $null = Invoke-VxNative -FilePath (Get-VxSystemTool 'taskkill.exe') -Arguments @('/PID', [string]$shell.Pid, '/T', '/F') -TimeoutSec 10 } catch { $null = $_ }
                $shell.Kill()
            } else { Stop-VxProcessTree $p }
            if ($cancelled) { throw 'VX_CANCELLED' }
            return $res
        }
        if ($null -ne $p) { $p.WaitForExit() }
        if ($null -ne $shell) { $res.exitCode = $shell.ExitCode } else { $res.exitCode = $p.ExitCode }
        # a child of the CLI may still hold the pipe: never block on .Result
        try { if ($outTask.Wait(5000)) { $res.output = [string]$outTask.Result } } catch { $null = $_ }
        try { if ($errTask.Wait(5000)) { $res.error = ([string]$errTask.Result).Trim() } } catch { $null = $_ }
    } finally {
        if ($stdinOpen) { try { $stdinStream.Dispose() } catch { $null = $_ } }
        if ($null -ne $shell) { try { $shell.Dispose() } catch { $null = $_ } }
        if ($null -ne $p) { try { $p.Dispose() } catch { $null = $_ } }
        $res.ms = [int]$sw.ElapsedMilliseconds
    }
    return $res
}

# Status of the local Claude Code CLI without spending a single token ("claude --version",
# "claude auth status"). Returns the provider row of the ai-status job.
function Get-VxClaudeCodeStatus {
    $ctx = $global:VxCtx
    $st = [ordered]@{
        id = 'claude-code'; name = 'Claude Code'; ready = $false; installed = $false; loggedIn = $false; state = 'missing'
        version = $null; account = $null; subscription = $null; authMethod = $null; path = $null
        runsAs = $null; model = (Get-VxClaudeCodeModel); message = ''; steps = @(); installCommand = (Get-VxClaudeInstallCommand)
    }
    if ($null -ne $ctx -and $null -ne $ctx.DesktopUser) { $st.runsAs = [string]$ctx.DesktopUser.name }
    $cli = Find-VxClaudeCli
    if ($null -eq $cli) {
        $st.message = 'Claude Code ist auf diesem PC nicht installiert. Mit deinem Claude-Abo (Pro oder Max) ist es die beste Wahl – ganz ohne API-Key.'
        $st.steps = @(Get-VxClaudeCodeInstallSteps)
        return $st
    }
    $st.installed = $true
    $st.path = [string]$cli.path
    $v = Invoke-VxClaudeCli -Cli $cli -Arguments @('--version') -TimeoutSec 25
    if (-not $v.started) {
        $st.state = 'error'
        $st.message = $v.message
        if (-not $st.message) { $st.message = 'Claude Code wurde gefunden, startet aber nicht.' }
        $st.steps = @(Get-VxClaudeCodeInstallSteps)
        return $st
    }
    $vm = [regex]::Match([string]$v.output, '(\d+\.\d+\.\d+)')
    if ($vm.Success) { $st.version = $vm.Groups[1].Value }
    if ($v.timedOut -or ($v.exitCode -ne 0 -and -not $st.version)) {
        $st.state = 'error'
        $st.message = 'Claude Code wurde gefunden, antwortet aber nicht richtig. Installier es neu oder starte „claude“ einmal selbst in PowerShell.'
        $st.steps = @(Get-VxClaudeCodeInstallSteps)
        return $st
    }
    $a = Invoke-VxClaudeCli -Cli $cli -Arguments @('auth', 'status') -TimeoutSec 25
    $j = ConvertFrom-VxAiJsonText ([string]$a.output)
    if ($null -ne $j -and (Test-VxProp $j 'loggedIn')) {
        $st.loggedIn = [bool](Get-VxProp $j 'loggedIn' $false)
        $st.authMethod = [string](Get-VxProp $j 'authMethod' '')
        $st.account = [string](Get-VxProp $j 'email' '')
        if (-not $st.account) { $st.account = $null }
        $st.subscription = [string](Get-VxProp $j 'subscriptionType' '')
        if (-not $st.subscription) { $st.subscription = $null }
    } elseif ($a.exitCode -eq 0 -or (([string]$a.output + ' ' + [string]$a.error) -match "(?i)unknown command|unknown option|error: unknown")) {
        # older CLI without "auth status": we cannot tell, the first analysis will
        $st.loggedIn = $true
        $st.authMethod = 'unknown'
    }
    if (-not $st.loggedIn) {
        $st.state = 'logged-out'
        $st.message = 'Claude Code ist installiert, aber nicht angemeldet.'
        $st.steps = @(Get-VxClaudeCodeLoginSteps)
        return $st
    }
    $st.ready = $true
    $st.state = 'ready'
    $who = ''
    if ($st.account) { $who = ' – angemeldet als ' + $st.account }
    elseif ($st.authMethod -eq 'unknown') { $who = ' – Anmeldung wird bei der ersten Analyse geprüft' }
    elseif ($st.authMethod -and $st.authMethod -ne 'claude.ai') { $who = ' – angemeldet (' + $st.authMethod + ')' }
    else { $who = ' – angemeldet' }
    $plan = ''
    if ($st.subscription) { $plan = ' (' + $st.subscription.Substring(0, 1).ToUpperInvariant() + $st.subscription.Substring(1) + ')' }
    $ver = ''
    if ($st.version) { $ver = ' ' + $st.version }
    $st.message = ('Claude Code{0} gefunden{1}{2}.' -f $ver, $who, $plan)
    return $st
}

# German text for a failed CLI run (result text / stderr of "claude -p").
function Get-VxClaudeCodeErrorText([string]$Text, [string]$Model) {
    $t = [string]$Text
    if ($t -match '(?i)not logged in|/login|please run .*login|invalid api key|oauth token|authentication_error|401|credentials') {
        return 'Claude Code ist nicht angemeldet. Öffne PowerShell (nicht als Administrator), gib „claude auth login“ ein und melde dich an. Dann noch einmal versuchen.'
    }
    if ($t -match '(?i)credit balance') { return 'Dein Guthaben für Claude ist aufgebraucht. Lade es in der Anthropic-Konsole auf oder nimm Groq bzw. die Smart-Analyse.' }
    if ($t -match '(?i)usage limit|limit reached|rate.?limit|429|quota|too many requests') {
        return 'Dein Claude-Nutzungslimit ist gerade erreicht. Warte, bis es zurückgesetzt wird (Claude Code zeigt dir die Uhrzeit), oder nimm solange Groq oder die Smart-Analyse.'
    }
    if ($t -match '(?i)git.?bash|requires git') { return 'Claude Code braucht auf Windows „Git for Windows“. Installier es von git-scm.com und versuch es dann noch einmal.' }
    if ($t -match '(?i)overloaded|529|50[0-9]|internal server error') { return 'Claude ist gerade überlastet. Versuch es in ein paar Minuten noch einmal oder nimm die Smart-Analyse.' }
    if ($t -match '(?i)model' -and $t -match '(?i)not found|not available|invalid|does not exist|not_found') {
        return ('Das Modell „{0}“ steht in deinem Abo nicht zur Verfügung. Wähle in den Einstellungen unter „KI“ ein anderes.' -f $Model)
    }
    if ($t -match '(?i)ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo|fetch failed') { return 'Claude Code erreicht das Internet nicht. Prüfe deine Verbindung und versuch es noch einmal.' }
    $short = ($t -replace '\s+', ' ').Trim()
    if ($short.Length -gt 220) { $short = $short.Substring(0, 220) + ' …' }
    if (-not $short) { $short = 'ohne Meldung beendet' }
    return ('Claude Code hat mit einem Fehler geantwortet: ' + $short)
}

function New-VxAiTempDir {
    $base = ''
    if (Test-VxWindows) { $base = Get-VxUserFolder 'temp' }
    if (-not $base -or -not [IO.Directory]::Exists($base)) { $base = [IO.Path]::GetTempPath() }
    $d = [IO.Path]::Combine($base, ('velox-ki-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)))
    [void][IO.Directory]::CreateDirectory($d)
    return $d
}

function Invoke-VxClaudeCodeAdvisor([string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile) {
    $cli = Find-VxClaudeCli
    if ($null -eq $cli) {
        throw ('Claude Code ist auf diesem PC nicht installiert. Installier es in PowerShell (nicht als Administrator) mit: ' + (Get-VxClaudeInstallCommand) + ' – dann „claude“ starten und mit deinem Claude-Konto anmelden.')
    }
    $model = Get-VxClaudeCodeModel
    $label = $model.Substring(0, 1).ToUpperInvariant() + $model.Substring(1)
    $dir = New-VxAiTempDir
    try {
        $sysFile = [IO.Path]::Combine($dir, 'velox-system.txt')
        $system = (Get-VxClaudeSystemText) + "`n`n" + (Get-VxCatalogDigest)
        [IO.File]::WriteAllText($sysFile, $system, (New-Object System.Text.UTF8Encoding($false)))
        $user = Get-VxAiUserContent $Goal $Text $AllowRisky $VxProfile
        $schema = ConvertTo-VxJson (Get-VxClaudeSchema)
        $mode = 'full'
        if ($cli.viaCmd) { $mode = 'noschema' }
        $step = ('Claude Code ({0}) denkt nach – meist 30–90 Sekunden' -f $label)
        Write-VxLog 'info' ('Frage Claude Code ({0}) mit deinem Claude-Konto.' -f $label)
        $out = $null
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            Test-VxCancel
            $cliArgs = @('-p', '--output-format', 'json', '--model', $model)
            $stdin = $user
            if ($mode -eq 'compat') {
                # very old CLI: only the basic print-mode flags, everything else goes through stdin
                $stdin = $system + "`n`n---`n`n" + $user
            } else {
                $cliArgs += @('--tools', '', '--no-session-persistence', '--setting-sources', '', '--system-prompt-file', $sysFile)
                if ($mode -eq 'full') {
                    $withSchema = @($cliArgs) + @('--json-schema', $schema)
                    if ((Test-VxClaudeShellLaunch) -and (Get-VxClaudeCliLine $cli $withSchema).Length -gt (Get-VxShellCommandLineMax)) {
                        # too long for the start without admin rights: the answer format comes from the rules text
                        Write-VxFileLog 'info' 'Claude Code: Befehlszeile zu lang für das Antwortschema - frage ohne festes Schema.'
                        $mode = 'noschema'
                    } else { $cliArgs = $withSchema }
                }
            }
            $r = Invoke-VxClaudeCli -Cli $cli -Arguments $cliArgs -StdinText $stdin -TimeoutSec (Get-VxClaudeCodeTimeoutSec) -Cwd $dir -Step $step -ProgFrom 0.66 -ProgTo 0.92
            if (-not $r.started) {
                $m = $r.message
                if (-not $m) { $m = 'Claude Code konnte nicht gestartet werden.' }
                throw $m
            }
            if ($r.timedOut) { throw ('Claude Code hat nach {0} Minuten nicht geantwortet. Versuch es noch einmal oder wähle in den Einstellungen das schnellere Modell „Sonnet“ bzw. „Haiku“.' -f [int]((Get-VxClaudeCodeTimeoutSec) / 60)) }
            $all = ([string]$r.output) + "`n" + ([string]$r.error)
            if ($r.exitCode -ne 0 -and $mode -ne 'compat' -and $all -match "(?i)unknown option|unrecognized option|unknown argument|error: option '") {
                Write-VxLog 'warn' 'Ältere Claude-Code-Version erkannt – neuer Versuch im einfachen Modus. (Tipp: „claude update“ in PowerShell.)'
                $mode = 'compat'
                continue
            }
            $j = ConvertFrom-VxAiJsonText ([string]$r.output)
            if ($null -eq $j -or -not ((Test-VxProp $j 'result') -or (Test-VxProp $j 'structured_output'))) {
                throw (Get-VxClaudeCodeErrorText $all $model)
            }
            if ([bool](Get-VxProp $j 'is_error' $false)) {
                $sub = [string](Get-VxProp $j 'subtype' '')
                if ($mode -eq 'full' -and $sub -match '(?i)structured') {
                    Write-VxLog 'warn' 'Claude Code konnte das Antwortformat nicht einhalten – neuer Versuch ohne festes Schema.'
                    $mode = 'noschema'
                    continue
                }
                throw (Get-VxClaudeCodeErrorText (([string](Get-VxProp $j 'result' '')) + ' ' + $sub + ' ' + [string]$r.error) $model)
            }
            $out = $j
            break
        }
        if ($null -eq $out) { throw 'Claude Code hat keine gültige Antwort geliefert. Versuch es noch einmal.' }
        $parsed = Get-VxProp $out 'structured_output'
        if ($null -eq $parsed -or -not (Test-VxProp $parsed 'plan')) { $parsed = ConvertFrom-VxAiJsonText ([string](Get-VxProp $out 'result' '')) }
        $usage = Get-VxProp $out 'usage'
        $u = [ordered]@{
            input_tokens = Get-VxProp $usage 'input_tokens' 0
            output_tokens = Get-VxProp $usage 'output_tokens' 0
            cache_read_input_tokens = Get-VxProp $usage 'cache_read_input_tokens' 0
            cache_creation_input_tokens = Get-VxProp $usage 'cache_creation_input_tokens' 0
        }
        $served = $model
        $mu = Get-VxProp $out 'modelUsage'
        if ($null -ne $mu) {
            $names = @()
            if ($mu -is [System.Collections.IDictionary]) { $names = @($mu.Keys) } else { $names = @($mu.PSObject.Properties | ForEach-Object { $_.Name }) }
            $names = @($names | Where-Object { [string]$_ -match '^claude-' })
            if ($names.Count -gt 0) { $served = [string]$names[0] }
        }
        return (Complete-VxAiResult -Parsed $parsed -Provider 'claude-code' -Model $served -Usage $u -Goal $Goal -Text $Text -AllowRisky $AllowRisky -VxProfile $VxProfile)
    } finally {
        try { [IO.Directory]::Delete($dir, $true) } catch { $null = $_ }
    }
}

# ================================================================== jobs

# ai-status: which providers are ready. params.test = 'claude-code' | 'claude-api' | 'groq' runs the
# "Verbindung testen" check of that provider (free: auth status / GET models); without test only
# Claude Code is probed (it costs no tokens). Result { providers:[row], recommended, preferred }.
function Invoke-VxAiStatusJob($Params) {
    $test = [string](Get-VxProp $Params 'test' '')
    $rows = New-Object System.Collections.ArrayList
    if (-not $test -or $test -eq 'claude-code') {
        Set-VxProgress 0.2 'Suche Claude Code ...'
        $cc = Get-VxClaudeCodeStatus
        [void]$rows.Add($cc)
        Write-VxLog 'info' $cc.message
    }
    $hasClaude = Test-VxClaudeKey
    $api = [ordered]@{ id = 'claude-api'; name = 'Claude API'; ready = $hasClaude; hasKey = $hasClaude; state = $(if ($hasClaude) { 'ready' } else { 'no-key' })
        model = [string]$global:VxCtx.Settings.claude.model; message = $(if ($hasClaude) { 'API-Key hinterlegt.' } else { 'Kein API-Key hinterlegt.' }); tested = $false }
    if ($test -eq 'claude-api') {
        Set-VxProgress 0.5 'Teste die Verbindung zu Claude ...'
        $t = Test-VxClaudeApiConnection
        $api.tested = $true; $api.ok = [bool]$t.ok; $api.message = [string]$t.message
        if (-not $t.ok -and $hasClaude) { $api.state = 'error' }
        Write-VxLog $(if ($t.ok) { 'ok' } else { 'warn' }) $t.message
    }
    [void]$rows.Add($api)
    $hasGroq = Test-VxGroqKey
    $groq = [ordered]@{ id = 'groq'; name = 'Groq'; ready = $hasGroq; hasKey = $hasGroq; state = $(if ($hasGroq) { 'ready' } else { 'no-key' })
        model = (Get-VxGroqModelSetting); models = $null; message = $(if ($hasGroq) { 'API-Key hinterlegt.' } else { 'Kein API-Key hinterlegt.' }); tested = $false }
    if ($test -eq 'groq') {
        Set-VxProgress 0.5 'Teste die Verbindung zu Groq ...'
        if (-not $hasGroq) { $groq.message = 'Noch kein Groq-Key hinterlegt.'; $groq.ok = $false }
        else {
            $g = Get-VxGroqModels (Get-VxGroqKey)
            $groq.tested = $true; $groq.ok = [bool]$g.ok; $groq.message = [string]$g.message
            if ($g.ok) { $groq.models = @($g.models) } else { $groq.state = 'error' }
            Write-VxLog $(if ($g.ok) { 'ok' } else { 'warn' }) $g.message
        }
    }
    [void]$rows.Add($groq)
    [void]$rows.Add([ordered]@{ id = 'offline'; name = 'Smart-Analyse'; ready = $true; state = 'ready'; message = 'Läuft immer, komplett offline.' })
    Set-VxProgress 1 'Fertig'
    return [ordered]@{ providers = $rows.ToArray(); recommended = 'claude-code'; preferred = [string]$global:VxCtx.Settings.ai.provider }
}

# ai: { provider, goal, text, allowRisky } -> advisorResult + { provider, model, usage }.
function Invoke-VxAiJob($Params) {
    $provider = [string](Get-VxProp $Params 'provider' 'offline')
    if ((Get-VxAiProviderIds) -notcontains $provider) { throw ("Unbekannte KI '{0}'." -f $provider) }
    if ($provider -eq 'offline') { return (Invoke-VxAdvisorJob $Params) }
    $goal = [string](Get-VxProp $Params 'goal' 'gaming')
    if (@('gaming', 'competitive', 'balanced', 'privacy', 'laptop', 'streaming', 'fivem') -notcontains $goal) { $goal = 'gaming' }
    $text = [string](Get-VxProp $Params 'text' '')
    if ($text.Length -gt 2000) { $text = $text.Substring(0, 2000) }
    $allowRisky = [bool](Get-VxProp $Params 'allowRisky' $false)
    # a missing key is found before the (possibly slow) first scan
    if ($provider -eq 'claude-api' -and -not (Test-VxClaudeKey)) { throw 'Es ist noch kein Claude-API-Key hinterlegt. Trag ihn in den Einstellungen unter „KI“ ein.' }
    if ($provider -eq 'groq' -and -not (Test-VxGroqKey)) { throw 'Es ist noch kein Groq-API-Key hinterlegt. Trag ihn in den Einstellungen unter „KI“ ein – er ist kostenlos (console.groq.com/keys).' }
    $prof = Confirm-VxProfile
    Set-VxProgress 0.62 'Stelle die Daten für die KI zusammen ...'
    Write-VxLog 'info' 'Nur Hardware-Daten und Tweak-Status gehen an die KI – keine Namen, keine Dateien.'
    switch ($provider) {
        'claude-code' { return (Invoke-VxClaudeCodeAdvisor $goal $text $allowRisky $prof) }
        'claude-api' { return (Invoke-VxClaudeApiAdvisor $goal $text $allowRisky $prof) }
        'groq' { return (Invoke-VxGroqAdvisor $goal $text $allowRisky $prof) }
    }
    throw ("Unbekannte KI '{0}'." -f $provider)
}

# Old job type "claude" = provider claude-api.
function Invoke-VxClaudeJob($Params) {
    $p = [ordered]@{ provider = 'claude-api'; goal = (Get-VxProp $Params 'goal' 'gaming'); text = (Get-VxProp $Params 'text' ''); allowRisky = (Get-VxProp $Params 'allowRisky' $false) }
    return (Invoke-VxAiJob $p)
}
