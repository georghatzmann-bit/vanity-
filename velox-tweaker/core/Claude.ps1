# VELOX - core/Claude.ps1
# Optional Claude advisor (docs/ARCHITECTURE.md section 9).
# PowerShell has no official Anthropic SDK, so this is raw HTTPS via System.Net.Http.HttpClient
# (deliberate exception). The API key is stored DPAPI-encrypted and is never logged or returned.
# Only function definitions.

function Get-VxClaudeKeyPath { return (Get-VxDataPath 'claude.key') }

function Test-VxClaudeKey {
    try { return [IO.File]::Exists((Get-VxClaudeKeyPath)) } catch { return $false }
}

function Set-VxClaudeKey([string]$Key) {
    $k = ([string]$Key).Trim()
    if ($k -notmatch '^sk-ant-[A-Za-z0-9_\-]{16,400}$') { throw 'Das sieht nicht wie ein Anthropic-API-Key aus (er beginnt mit "sk-ant-").' }
    $path = Get-VxClaudeKeyPath
    if (Test-VxWindows) {
        $sec = ConvertTo-SecureString -String $k -AsPlainText -Force
        $enc = ConvertFrom-SecureString -SecureString $sec
        Write-VxTextFile -Path $path -Text $enc
    } else {
        # non-Windows is only used by tests: no DPAPI available, base64 is good enough there
        Write-VxTextFile -Path $path -Text ('b64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($k)))
    }
}

function Remove-VxClaudeKey {
    $path = Get-VxClaudeKeyPath
    if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
}

function Get-VxClaudeKey {
    $path = Get-VxClaudeKeyPath
    if (-not [IO.File]::Exists($path)) { return $null }
    $text = ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)).Trim()
    if ($text.StartsWith('b64:')) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text.Substring(4))) }
    try {
        $sec = ConvertTo-SecureString -String $text -ErrorAction Stop
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    } catch {
        throw 'Der gespeicherte API-Key kann nicht gelesen werden (anderer Windows-Benutzer?). Bitte trag ihn in den Einstellungen neu ein.'
    }
}

# The override exists for tests only: in real (elevated) mode it is ignored, so a value planted in
# the user environment cannot send the API key somewhere else.
function Get-VxClaudeBaseUrl {
    $b = $null
    $ctx = $global:VxCtx
    if ($null -eq $ctx -or $ctx.Simulate -or -not $ctx.Windows) { $b = [Environment]::GetEnvironmentVariable('VELOX_ANTHROPIC_BASE_URL') }
    if ([string]::IsNullOrWhiteSpace($b)) { $b = 'https://api.anthropic.com' }
    return $b.Trim().TrimEnd('/')
}

function Get-VxClaudeTimeoutSec { return 600 }

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

# Stable role + rules text (no per-request data, so the cached prefix stays identical).
function Get-VxClaudeSystemText {
    return @'
You are the optimization advisor inside VELOX, a Windows 10/11 tweaking tool. You receive a hardware/system profile of the user's PC, the current status of tweaks, the user's goal and an optional free-text description of their problem. You choose which tweaks from the VELOX catalog the user should apply and explain why.

Rules:
- Choose ONLY tweak ids that appear in the catalog digest below. Never invent ids. Copy them exactly.
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
- Keep the plan focused: the most useful 5 to 40 tweaks, most important first.
- Answer only with the JSON object described by the output schema.
'@
}

# One line per toggle tweak: id | name | category | risk | tags | desc | warning (sorted, stable for caching).
function Get-VxCatalogDigest {
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add('VELOX catalog digest (id | name | category | risk | tags | desc | warning):')
    foreach ($t in @($global:VxCtx.Catalog.tweaks | Sort-Object { [string]$_.id })) {
        if ((Get-VxTweakKind $t) -ne 'toggle') { continue }
        $tags = (@($t.tags) | ForEach-Object { [string]$_ }) -join ','
        $desc = ([string]$t.desc) -replace '[\r\n|]+', ' '
        $name = ([string]$t.name) -replace '[\r\n|]+', ' '
        $warn = ([string](Get-VxProp $t 'warning' '')) -replace '[\r\n|]+', ' '
        if ([bool](Get-VxProp $t 'situational' $false)) { $warn = ('nur bei passendem Problem. ' + $warn).Trim() }
        [void]$lines.Add(('{0} | {1} | {2} | {3} | {4} | {5} | {6}' -f $t.id, $name, $t.category, $t.risk, $tags, $desc, $warn))
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

function Get-VxClaudeUserContent([string]$Goal, [string]$Text, [bool]$AllowRisky, $VxProfile) {
    $st = $global:VxCtx.State.statuses
    $byStatus = [ordered]@{ applied = @(); partial = @(); custom = @(); na = @() }
    foreach ($id in @($st.Keys | Sort-Object)) {
        $s = [string]$st[$id]
        if ($byStatus.Contains($s)) { $byStatus[$s] += $id }
    }
    $payload = [ordered]@{
        goal = $Goal
        goalName = (Get-VxGoalConfig $Goal).name
        allowRisky = $AllowRisky
        userText = $Text
        profile = (Get-VxClaudeProfile $VxProfile)
        tweakStatus = [ordered]@{
            note = 'Every catalog tweak not listed here is at the Windows default (not applied).'
            applied = $byStatus.applied; partial = $byStatus.partial; custom = $byStatus.custom; na = $byStatus.na
        }
    }
    return ("Here is my PC and what I want. Choose the tweaks for me.`n`n" + (ConvertTo-VxJson $payload))
}

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

# Sends one request. Returns @{ status; text } (status 0 = network error, text = German message).
function Send-VxClaudeRequest([string]$Key, [string]$Json, [bool]$WithFallback) {
    try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch { $null = $_ }
    $base = Get-VxClaudeBaseUrl
    $uri = New-Object System.Uri(($base + '/v1/messages'))
    $handler = New-Object System.Net.Http.HttpClientHandler
    if ($uri.IsLoopback) { $handler.UseProxy = $false }
    $client = New-Object System.Net.Http.HttpClient($handler)
    # effort "high" with up to 16000 output tokens can take several minutes on a non-streaming call
    $client.Timeout = [TimeSpan]::FromSeconds((Get-VxClaudeTimeoutSec))
    $cts = New-Object System.Threading.CancellationTokenSource
    try {
        $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $uri)
        [void]$req.Headers.TryAddWithoutValidation('x-api-key', $Key)
        [void]$req.Headers.TryAddWithoutValidation('anthropic-version', '2023-06-01')
        if ($WithFallback) { [void]$req.Headers.TryAddWithoutValidation('anthropic-beta', 'server-side-fallback-2026-07-01') }
        $bytes = [Text.Encoding]::UTF8.GetBytes($Json)
        $content = New-Object System.Net.Http.ByteArrayContent -ArgumentList (, $bytes)
        $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/json')
        $req.Content = $content
        $task = $client.SendAsync($req, $cts.Token)
        while (-not $task.Wait(500)) {
            $job = $global:VxJob
            if ($null -ne $job -and $job.cancel) { $cts.Cancel() }
        }
        $resp = $task.Result
        $rb = $resp.Content.ReadAsByteArrayAsync().Result
        return @{ status = [int]$resp.StatusCode; text = [Text.Encoding]::UTF8.GetString($rb) }
    } catch {
        $job = $global:VxJob
        if ($null -ne $job -and $job.cancel) { throw 'VX_CANCELLED' }
        $ex = $_.Exception
        while ($null -ne $ex.InnerException) { $ex = $ex.InnerException }
        if ($ex -is [System.Threading.Tasks.TaskCanceledException] -or $ex -is [TimeoutException]) {
            return @{ status = 0; text = ('Claude hat nicht rechtzeitig geantwortet (Zeitüberschreitung nach {0} Minuten). Versuch es noch einmal oder nutze die lokale Smart-Analyse.' -f [int]((Get-VxClaudeTimeoutSec) / 60)) }
        }
        return @{ status = 0; text = ('Keine Verbindung zu Claude (api.anthropic.com). Prüfe deine Internetverbindung. (' + $ex.Message + ')') }
    } finally {
        $client.Dispose()
        $cts.Dispose()
    }
}

function Get-VxClaudeErrorMessage([string]$Text) {
    try {
        $j = ConvertFrom-VxJsonText $Text
        $m = [string](Get-VxProp (Get-VxProp $j 'error') 'message')
        if ($m) { return $m }
    } catch { $null = $_ }
    if ($Text.Length -gt 300) { return $Text.Substring(0, 300) }
    return $Text
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
            Write-VxLog 'warn' 'Claude-API kennt die Fallback-Option nicht - neuer Versuch ohne.'
            $withFallback = $false
            $retriedFallback = $true
            continue
        }
        if (($r.status -ge 500 -or $r.status -eq 529) -and -not $retried5xx) {
            Write-VxLog 'warn' ("Claude ist gerade überlastet (HTTP {0}) - neuer Versuch in 3 Sekunden." -f $r.status)
            $retried5xx = $true
            for ($i = 0; $i -lt 6; $i++) { Test-VxCancel; Start-Sleep -Milliseconds 500 }
            continue
        }
        break
    }
    switch ($r.status) {
        200 { break }
        0 { throw $r.text }
        401 { throw 'API-Key ungültig. Bitte prüfe den Key in den Einstellungen.' }
        403 { throw ('Kein Zugriff auf dieses Modell (403): ' + (Get-VxClaudeErrorMessage $r.text)) }
        429 { throw 'Zu viele Anfragen an Claude. Bitte warte kurz und versuch es dann noch einmal.' }
        400 { throw ('Claude hat die Anfrage abgelehnt (400): ' + (Get-VxClaudeErrorMessage $r.text)) }
        default {
            if ($r.status -ge 500) { throw ("Claude ist gerade nicht erreichbar oder überlastet (HTTP {0}). Versuch es später noch einmal oder nutze die lokale Smart-Analyse." -f $r.status) }
            throw ("Unerwartete Antwort von Claude (HTTP {0}): {1}" -f $r.status, (Get-VxClaudeErrorMessage $r.text))
        }
    }
    try { return (ConvertFrom-VxJsonText $r.text) } catch { throw 'Claude hat eine unlesbare Antwort geschickt.' }
}

# Validates Claude's plan ids. Returns @{ plan; dropped }.
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

function Invoke-VxClaudeJob($Params) {
    $ctx = $global:VxCtx
    $goal = [string](Get-VxProp $Params 'goal' 'gaming')
    if (@('gaming', 'competitive', 'balanced', 'privacy', 'laptop', 'streaming', 'fivem') -notcontains $goal) { $goal = 'gaming' }
    $text = [string](Get-VxProp $Params 'text' '')
    if ($text.Length -gt 2000) { $text = $text.Substring(0, 2000) }
    $allowRisky = [bool](Get-VxProp $Params 'allowRisky' $false)
    $key = Get-VxClaudeKey
    if (-not $key) { throw 'Es ist noch kein Claude-API-Key hinterlegt. Trag ihn in den Einstellungen ein.' }
    $prof = Confirm-VxProfile
    $model = [string]$ctx.Settings.claude.model
    if (-not $model) { $model = 'claude-opus-5-5' }
    Set-VxProgress 0.65 ("Frage Claude ({0}) - das kann ein paar Minuten dauern ..." -f $model)
    $body = New-VxClaudeBody $model (Get-VxClaudeUserContent $goal $text $allowRisky $prof) $true
    $resp = Invoke-VxClaudeApi $key $body
    $stop = [string](Get-VxProp $resp 'stop_reason')
    if ($stop -eq 'refusal') { throw 'Claude hat diese Anfrage abgelehnt. Formuliere sie anders oder nutze die lokale Smart-Analyse.' }
    if ($stop -eq 'max_tokens') { throw 'Die Antwort von Claude war zu lang und wurde abgeschnitten. Bitte versuch es noch einmal.' }
    $textBlock = @(@(Get-VxProp $resp 'content' @()) | Where-Object { [string](Get-VxProp $_ 'type') -eq 'text' })
    if ($textBlock.Count -eq 0) { throw 'Claude hat keine Antwort geliefert.' }
    $parsed = $null
    try { $parsed = ConvertFrom-VxJsonText ([string]$textBlock[0].text) } catch { $parsed = $null }
    if ($null -eq $parsed -or -not (Test-VxProp $parsed 'plan')) { throw 'Claude hat keine gültige Antwort geliefert (kein lesbares JSON).' }
    Set-VxProgress 0.92 'Prüfe Claudes Vorschläge ...'
    $sel = Select-VxClaudePlan (Get-VxProp $parsed 'plan' @()) $allowRisky $prof
    foreach ($d in $sel.dropped) { Write-VxLog 'warn' ("Vorschlag verworfen: {0}" -f $d) }
    $findings = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($f in @(Get-VxProp $parsed 'findings' @())) {
        $i++
        $sev = [string](Get-VxProp $f 'severity')
        if (@('good', 'info', 'warn', 'bad') -notcontains $sev) { $sev = 'info' }
        [void]$findings.Add([ordered]@{ id = ('claude-' + $i); severity = $sev; title = [string](Get-VxProp $f 'title'); detail = [string](Get-VxProp $f 'detail'); fix = $null })
    }
    # score from the local advisor's view of the resulting plan
    $cands = @(Get-VxGoalCandidates $goal $prof @(Get-VxTextTags $text))
    $localFindings = @(Get-VxFindings $prof $goal)
    $sc = Get-VxAdvisorScore $cands $localFindings @($sel.plan | ForEach-Object { $_.id })
    $usage = Get-VxProp $resp 'usage'
    $u = [ordered]@{
        input_tokens = Get-VxProp $usage 'input_tokens' 0
        output_tokens = Get-VxProp $usage 'output_tokens' 0
        cache_read_input_tokens = Get-VxProp $usage 'cache_read_input_tokens' 0
        cache_creation_input_tokens = Get-VxProp $usage 'cache_creation_input_tokens' 0
    }
    $served = [string](Get-VxProp $resp 'model' $model)
    Write-VxLog 'ok' ("Claude ({0}) schlägt {1} Tweaks vor." -f $served, $sel.plan.Count)
    Set-VxProgress 1 'Fertig'
    return [ordered]@{
        engine = 'claude'; score = $sc.score; scoreAfter = $sc.scoreAfter
        summary = [string](Get-VxProp $parsed 'summary'); findings = $findings.ToArray(); plan = $sel.plan
        model = $served; usage = $u
    }
}
