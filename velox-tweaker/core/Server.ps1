# VELOX - core/Server.ps1
# Local HTTP server (System.Net.HttpListener, loopback only): routing, auth, static files.
# Only function definitions.
#
# Security (docs/ARCHITECTURE.md section 7):
#   - every /api/* request needs header X-Velox-Token (constant-time compare), else 401;
#     exception: POST /api/shutdown?t=<token> (navigator.sendBeacon cannot set headers)
#   - Host must be 127.0.0.1:<port> or localhost:<port>, else 403 (DNS rebinding)
#   - an Origin header, if present, must be http://127.0.0.1:<port> or http://localhost:<port>, else 403
#   - OPTIONS -> 403, no CORS headers ever
#   - static files only from ui/, traversal rejected, Cache-Control: no-store everywhere
#
# API notes (details the contract leaves open - the UI relies on these):
#   - Error responses are JSON { "error": "<German message>" } with a 4xx/5xx status.
#     409 for a busy job runner is exactly { "error": "busy", "jobId": "<running job id>" }.
#   - GET /api/bootstrap: "busy" is a boolean; extra field "activeJob" = { id, type } | null so a
#     reloaded UI can resume polling a running job. bootstrap also counts as a heartbeat.
#   - GET /api/jobs/<id>?since=<n>: returns log entries with i >= n. i starts at 0 and increases by 1,
#     so pass the number of entries received so far (or last i + 1). Unknown id -> 404.
#   - POST /api/jobs with an unknown type -> 400. Job state is kept until the next job starts.
#   - POST /api/jobs/<id>/cancel -> { ok: true } when a cancel was requested, { ok: false } when the
#     job is not running. A cancelled job ends with status "cancelled".
#   - POST /api/settings ignores unknown/invalid fields, "games" (managed by the game-boost job) and
#     claude.hasKey; claude.model must match ^[a-z0-9][a-z0-9.-]{2,80}$.
#   - POST /api/claude/key with an invalid key -> 400 { error }.
#   - Kind "remove" (Appx) tweaks: status "applied" = removed ("entfernt"), "default" = installed.
#     Kind "action" tweaks have no status entry. Tweaks whose "when" fails have status "na".
#   - advisorResult finding fixes of type "page" use the page ids "cleanup", "apps", "detweak".
#   - claude job: findings come from Claude (fix always null); score/scoreAfter from the local advisor.
#   - detweak job result additionally has "errors": [German strings]; detweak-scan item keys are
#     "reg|<path>|<name>", "regkey|<path>", "bcd|<name>", "svc|<name>", "task|<path>", "tweak|<id>".
#   - game-boost params may also carry "name" and "source"; a game is removed from settings.games
#     when all three boosts are off. games-detect ids are stable hashes of the exe path.
#   - startup-set id is the id from startup-list ("<location>|<value or file name>").
#   - run-action / clean jobs write a journal of kind "clean" (entries are not restorable).
#   - If http.sys refuses the 127.0.0.1 prefix (Testmodus without admin rights) the server listens
#     on http://localhost:<port>/ instead and the VELOX_READY URL uses localhost.
#   - Static: GET/HEAD only; "/" serves ui/index.html; missing files -> 404.

function Get-VxFreePort {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $l.Start()
    try { return ([System.Net.IPEndPoint]$l.LocalEndpoint).Port } finally { $l.Stop() }
}

# Starts the HttpListener. Returns @{ listener; port; host; url }.
function Start-VxListener([int]$Port = 0) {
    $auto = ($Port -le 0)
    $lastErr = $null
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        $p = $Port
        if ($auto) { $p = Get-VxFreePort }
        foreach ($mode in @('both', 'localhost')) {
            $l = New-Object System.Net.HttpListener
            $l.IgnoreWriteExceptions = $true
            if ($mode -eq 'both') {
                $l.Prefixes.Add("http://127.0.0.1:$p/")
                $l.Prefixes.Add("http://localhost:$p/")
            } else {
                $l.Prefixes.Add("http://localhost:$p/")
            }
            try {
                $l.Start()
                $hostName = '127.0.0.1'
                if ($mode -eq 'localhost') { $hostName = 'localhost' }
                return @{ listener = $l; port = $p; host = $hostName; url = ('http://{0}:{1}/' -f $hostName, $p) }
            } catch {
                $lastErr = $_.Exception.Message
                try { $l.Close() } catch { $null = $_ }
            }
        }
        if (-not $auto) { break }
    }
    throw ('Der lokale Server konnte nicht gestartet werden: ' + $lastErr)
}

# ------------------------------------------------------------------ helpers

function Test-VxTokenEqual([string]$A, [string]$B) {
    if ($null -eq $A -or $null -eq $B) { return $false }
    $x = [Text.Encoding]::UTF8.GetBytes($A)
    $y = [Text.Encoding]::UTF8.GetBytes($B)
    $diff = $x.Length -bxor $y.Length
    $n = [math]::Min($x.Length, $y.Length)
    for ($i = 0; $i -lt $n; $i++) { $diff = $diff -bor ($x[$i] -bxor $y[$i]) }
    return ($diff -eq 0)
}

function Set-VxCommonHeaders($Response) {
    $Response.Headers['Cache-Control'] = 'no-store'
    $Response.Headers['X-Content-Type-Options'] = 'nosniff'
    $Response.Headers['Referrer-Policy'] = 'no-referrer'
    $Response.Headers['X-Frame-Options'] = 'DENY'
}

function Send-VxBytes($Context, [int]$Status, [byte[]]$Bytes, [string]$ContentType, [bool]$NoBody = $false) {
    $res = $Context.Response
    $res.StatusCode = $Status
    Set-VxCommonHeaders $res
    $res.ContentType = $ContentType
    if ($NoBody -or $null -eq $Bytes) {
        $res.ContentLength64 = 0
        if ($null -ne $Bytes) { $res.ContentLength64 = $Bytes.Length }
    } else {
        $res.ContentLength64 = $Bytes.Length
        $res.OutputStream.Write($Bytes, 0, $Bytes.Length)
    }
}

function Send-VxJson($Context, [int]$Status, $Object) {
    $json = ConvertTo-VxJson $Object
    Send-VxBytes $Context $Status ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8'
}

function Send-VxError($Context, [int]$Status, [string]$Message) {
    Send-VxJson $Context $Status ([ordered]@{ error = $Message })
}

function Read-VxBody($Request) {
    if (-not $Request.HasEntityBody) { return $null }
    $max = 1MB
    if ($Request.ContentLength64 -gt $max) { throw 'VX_TOO_LARGE' }
    $ms = New-Object System.IO.MemoryStream
    try {
        $buf = New-Object byte[] 65536
        while ($true) {
            $n = $Request.InputStream.Read($buf, 0, $buf.Length)
            if ($n -le 0) { break }
            $ms.Write($buf, 0, $n)
            if ($ms.Length -gt $max) { throw 'VX_TOO_LARGE' }
        }
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
    } finally { $ms.Dispose() }
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    try { return (ConvertFrom-VxJsonText $text) } catch { throw 'VX_BAD_JSON' }
}

function Get-VxContentType([string]$Ext) {
    switch ($Ext.ToLowerInvariant()) {
        '.html' { return 'text/html; charset=utf-8' }
        '.htm' { return 'text/html; charset=utf-8' }
        '.css' { return 'text/css; charset=utf-8' }
        '.js' { return 'text/javascript; charset=utf-8' }
        '.mjs' { return 'text/javascript; charset=utf-8' }
        '.json' { return 'application/json; charset=utf-8' }
        '.svg' { return 'image/svg+xml' }
        '.png' { return 'image/png' }
        '.jpg' { return 'image/jpeg' }
        '.jpeg' { return 'image/jpeg' }
        '.webp' { return 'image/webp' }
        '.gif' { return 'image/gif' }
        '.ico' { return 'image/x-icon' }
        '.woff2' { return 'font/woff2' }
        '.woff' { return 'font/woff' }
        '.txt' { return 'text/plain; charset=utf-8' }
        '.map' { return 'application/json; charset=utf-8' }
    }
    return 'application/octet-stream'
}

function Get-VxOpenTargets {
    return @(
        'ms-settings:display', 'ms-settings:display-advanced', 'ms-settings:display-advancedgraphics',
        'ms-settings:gaming-gamemode', 'ms-settings:gaming-gamebar', 'ms-settings:gaming-captures',
        'ms-settings:powersleep', 'ms-settings:batterysaver', 'ms-settings:startupapps', 'ms-settings:appsfeatures',
        'ms-settings:storagesense', 'ms-settings:windowsupdate', 'ms-settings:windowsdefender', 'ms-settings:privacy',
        'ms-settings:privacy-general', 'ms-settings:recovery', 'ms-settings:about', 'ms-settings:network-status',
        'ms-settings:sound', 'ms-settings:mousetouchpad', 'ms-settings:defaultapps', 'ms-settings:notifications',
        'backups'
    )
}

function Get-VxModeDto {
    $ctx = $global:VxCtx
    return [ordered]@{
        simulate = [bool]$ctx.Simulate; admin = [bool]$ctx.Admin; windows = [bool]$ctx.Windows
        os = [string]$ctx.OsText; ps = $PSVersionTable.PSVersion.ToString(); userMismatch = [bool]$ctx.UserMismatch
        desktopUser = $(if ($null -ne $ctx.DesktopUser) { [string]$ctx.DesktopUser.name } else { $null })
    }
}

function Get-VxBootstrapDto {
    $ctx = $global:VxCtx
    $active = $null
    if (Test-VxBusy) {
        $j = $ctx.Jobs[$ctx.CurrentJobId]
        $active = [ordered]@{ id = $j.id; type = $j.type }
    }
    $cat = $ctx.Catalog
    return [ordered]@{
        app = [ordered]@{ name = 'VELOX'; version = [string]$ctx.Version }
        mode = (Get-VxModeDto)
        categories = @($cat.categories)
        tweaks = @(Get-VxTweakDtos)
        presets = @($cat.presets)
        settings = (Get-VxSettingsDto)
        state = (Get-VxStateDto)
        busy = (Test-VxBusy)
        activeJob = $active
    }
}

function Register-VxHeartbeat {
    $life = $global:VxCtx.Life
    $life.lastHeartbeat = [DateTime]::UtcNow
    $life.firstHeartbeat = $true
    if ($null -ne $life.shutdownAt) {
        $life.shutdownAt = $null
        Write-VxLog 'info' 'Beenden abgebrochen - die Oberfläche ist wieder da.'
    }
}

# ------------------------------------------------------------------ static files

function Send-VxStatic($Context, [string]$RawPath, [bool]$Head) {
    $ctx = $global:VxCtx
    $path = $RawPath
    $q = $path.IndexOf('?')
    if ($q -ge 0) { $path = $path.Substring(0, $q) }
    $decoded = $path
    try { $decoded = [Uri]::UnescapeDataString($path) } catch { Send-VxError $Context 400 'Ungültiger Pfad.'; return }
    if ($decoded -match '\.\.' -or $decoded.Contains('\') -or $decoded.Contains(':') -or $decoded.Contains([char]0) -or $decoded -match '//') {
        Send-VxError $Context 403 'Zugriff verweigert.'
        return
    }
    if ($decoded -eq '/' -or $decoded -eq '') { $decoded = '/index.html' }
    $rel = $decoded.TrimStart('/')
    $root = [IO.Path]::GetFullPath($ctx.UiDir)
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel.Replace('/', [IO.Path]::DirectorySeparatorChar)))
    $sep = [string][IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($root.TrimEnd([IO.Path]::DirectorySeparatorChar) + $sep, [StringComparison]::OrdinalIgnoreCase)) {
        Send-VxError $Context 403 'Zugriff verweigert.'
        return
    }
    if (-not [IO.File]::Exists($full)) {
        Send-VxError $Context 404 'Nicht gefunden.'
        return
    }
    $bytes = [IO.File]::ReadAllBytes($full)
    Send-VxBytes $Context 200 $bytes (Get-VxContentType ([IO.Path]::GetExtension($full))) $Head
}

# ------------------------------------------------------------------ request handling

function Invoke-VxRequest($Context) {
    $ctx = $global:VxCtx
    $req = $Context.Request
    try {
        $port = $ctx.Port
        $method = $req.HttpMethod.ToUpperInvariant()
        # Host check (DNS rebinding)
        $hostHdr = ([string]$req.Headers['Host']).ToLowerInvariant()
        if (@("127.0.0.1:$port", "localhost:$port") -notcontains $hostHdr) {
            Send-VxError $Context 403 'Ungültiger Host.'
            return
        }
        $origin = [string]$req.Headers['Origin']
        if ($origin -and @("http://127.0.0.1:$port", "http://localhost:$port") -notcontains $origin.ToLowerInvariant()) {
            Send-VxError $Context 403 'Ungültiger Ursprung.'
            return
        }
        if ($method -eq 'OPTIONS') { Send-VxError $Context 403 'Nicht erlaubt.'; return }
        $raw = [string]$req.RawUrl
        $path = $raw
        $qi = $path.IndexOf('?')
        if ($qi -ge 0) { $path = $path.Substring(0, $qi) }
        if (-not $path.StartsWith('/api/') -and $path -ne '/api') {
            if ($method -ne 'GET' -and $method -ne 'HEAD') { Send-VxError $Context 405 'Methode nicht erlaubt.'; return }
            Send-VxStatic $Context $raw ($method -eq 'HEAD')
            return
        }
        # ---- auth
        $token = [string]$req.Headers['X-Velox-Token']
        $okToken = Test-VxTokenEqual $token $ctx.Token
        if (-not $okToken -and $method -eq 'POST' -and $path -eq '/api/shutdown') {
            $okToken = Test-VxTokenEqual ([string]$req.QueryString['t']) $ctx.Token
        }
        if (-not $okToken) { Send-VxError $Context 401 'Nicht autorisiert.'; return }
        $fetchSite = [string]$req.Headers['Sec-Fetch-Site']
        if ($fetchSite -eq 'cross-site') { Send-VxError $Context 403 'Ungültiger Ursprung.'; return }
        Invoke-VxApi $Context $method $path
    } catch {
        $m = [string]$_.Exception.Message
        try {
            if ($m -eq 'VX_TOO_LARGE') { Send-VxError $Context 413 'Anfrage zu groß.' }
            elseif ($m -eq 'VX_BAD_JSON') { Send-VxError $Context 400 'Ungültiges JSON.' }
            else {
                Write-VxLog 'error' ('Serverfehler: ' + $m + ' | ' + $_.ScriptStackTrace)
                Send-VxError $Context 500 ('Interner Fehler: ' + $m)
            }
        } catch { $null = $_ }
    } finally {
        try { $Context.Response.Close() } catch { $null = $_ }
    }
}

function Invoke-VxApi($Context, [string]$Method, [string]$Path) {
    $ctx = $global:VxCtx
    $req = $Context.Request
    $life = $ctx.Life
    $life.lastActivity = [DateTime]::UtcNow
    if ($Method -eq 'GET' -and $Path -eq '/api/bootstrap') {
        Register-VxHeartbeat
        Send-VxJson $Context 200 (Get-VxBootstrapDto)
        return
    }
    if ($Method -eq 'GET' -and $Path -eq '/api/state') { Send-VxJson $Context 200 (Get-VxStateDto); return }
    if ($Method -eq 'POST' -and $Path -eq '/api/heartbeat') {
        Register-VxHeartbeat
        Send-VxJson $Context 200 ([ordered]@{ ok = $true; busy = (Test-VxBusy) })
        return
    }
    if ($Method -eq 'POST' -and $Path -eq '/api/shutdown') {
        $life.shutdownAt = [DateTime]::UtcNow.AddSeconds(4)
        Write-VxLog 'info' 'Oberfläche geschlossen - VELOX beendet sich in 4 Sekunden.'
        Send-VxJson $Context 200 ([ordered]@{ ok = $true })
        return
    }
    if ($Method -eq 'POST' -and $Path -eq '/api/jobs') {
        $body = Read-VxBody $req
        $type = [string](Get-VxProp $body 'type')
        $params = Get-VxProp $body 'params'
        if ($null -eq $params) { $params = [pscustomobject]@{} }
        if ((Get-VxJobTypes) -notcontains $type) { Send-VxError $Context 400 ("Unbekannter Job-Typ '{0}'." -f $type); return }
        $r = Start-VxJob $type $params
        if ($r.busy) { Send-VxJson $Context 409 ([ordered]@{ error = 'busy'; jobId = $r.jobId }); return }
        Send-VxJson $Context 200 ([ordered]@{ jobId = $r.jobId })
        return
    }
    $m = [regex]::Match($Path, '^/api/jobs/([a-f0-9]{8,32})(/cancel)?$')
    if ($m.Success) {
        Update-VxJobs
        $job = $ctx.Jobs[$m.Groups[1].Value]
        if ($null -eq $job) { Send-VxError $Context 404 'Job nicht gefunden.'; return }
        if ($m.Groups[2].Success -and $m.Groups[2].Value) {
            if ($Method -ne 'POST') { Send-VxError $Context 405 'Methode nicht erlaubt.'; return }
            Send-VxJson $Context 200 ([ordered]@{ ok = (Stop-VxJob $job.id) })
            return
        }
        if ($Method -ne 'GET') { Send-VxError $Context 405 'Methode nicht erlaubt.'; return }
        $since = 0
        $s = [string]$req.QueryString['since']
        if ($s -match '^\d{1,9}$') { $since = [int]$s }
        Send-VxJson $Context 200 (Get-VxJobDto $job $since)
        return
    }
    if ($Method -eq 'POST' -and $Path -eq '/api/settings') {
        $body = Read-VxBody $req
        if ($null -ne $body) { Update-VxSettings $body }
        Send-VxJson $Context 200 ([ordered]@{ settings = (Get-VxSettingsDto) })
        return
    }
    if ($Path -eq '/api/claude/key') {
        if ($Method -eq 'POST') {
            $body = Read-VxBody $req
            try { Set-VxClaudeKey ([string](Get-VxProp $body 'key')) }
            catch { Send-VxError $Context 400 ([string]$_.Exception.Message); return }
            Write-VxLog 'info' 'Claude-API-Key gespeichert (verschlüsselt).'
            Send-VxJson $Context 200 ([ordered]@{ hasKey = $true })
            return
        }
        if ($Method -eq 'DELETE') {
            Remove-VxClaudeKey
            Write-VxLog 'info' 'Claude-API-Key gelöscht.'
            Send-VxJson $Context 200 ([ordered]@{ hasKey = $false })
            return
        }
        Send-VxError $Context 405 'Methode nicht erlaubt.'
        return
    }
    if ($Method -eq 'GET' -and $Path -eq '/api/backups') {
        Send-VxJson $Context 200 ([ordered]@{ backups = @(Get-VxBackupList) })
        return
    }
    $b = [regex]::Match($Path, '^/api/backups/([^/]+)$')
    if ($b.Success -and $Method -eq 'GET') {
        $id = [Uri]::UnescapeDataString($b.Groups[1].Value)
        if (-not (Test-VxBackupId $id)) { Send-VxError $Context 400 'Ungültige Sicherungs-ID.'; return }
        $doc = Read-VxBackup $id
        if ($null -eq $doc) { Send-VxError $Context 404 'Sicherung nicht gefunden.'; return }
        Send-VxJson $Context 200 $doc
        return
    }
    if ($Method -eq 'POST' -and $Path -eq '/api/open') {
        $body = Read-VxBody $req
        $target = [string](Get-VxProp $body 'target')
        if ((Get-VxOpenTargets) -notcontains $target) { Send-VxError $Context 400 'Dieses Ziel darf nicht geöffnet werden.'; return }
        if (-not $ctx.Windows) {
            Write-VxLog 'info' ("[Testmodus] Würde öffnen: {0}" -f $target)
            Send-VxJson $Context 200 ([ordered]@{ ok = $true })
            return
        }
        try {
            if ($target -eq 'backups') {
                Start-Process -FilePath ([IO.Path]::Combine([string]$env:SystemRoot, 'explorer.exe')) -ArgumentList ('"' + $ctx.BackupDir + '"')
            } else {
                Start-Process -FilePath $target
            }
            Send-VxJson $Context 200 ([ordered]@{ ok = $true })
        } catch {
            Send-VxError $Context 500 ('Konnte nicht geöffnet werden: ' + $_.Exception.Message)
        }
        return
    }
    Send-VxError $Context 404 'Unbekannter API-Pfad.'
}

# ------------------------------------------------------------------ main loop

function Test-VxLifecycle {
    $ctx = $global:VxCtx
    $life = $ctx.Life
    $now = [DateTime]::UtcNow
    if ($null -ne $life.shutdownAt -and $now -ge $life.shutdownAt) {
        if (Test-VxBusy) {
            if (-not $life.waitLogged) { Write-VxLog 'info' 'Warte auf laufende Aufgabe, dann wird beendet.'; $life.waitLogged = $true }
        } else {
            $life.stop = $true
            $life.reason = 'shutdown'
            return
        }
    }
    if ($life.firstHeartbeat -and $null -ne $life.lastHeartbeat -and ($now - $life.lastHeartbeat).TotalSeconds -gt [double]$life.timeoutSec) {
        if (-not (Test-VxBusy)) {
            $life.stop = $true
            $life.reason = 'timeout'
        }
    }
}

function Invoke-VxServerLoop($Listener) {
    $ctx = $global:VxCtx
    $life = $ctx.Life
    $pending = $null
    while (-not $life.stop) {
        if ($null -eq $pending) {
            try { $pending = $Listener.GetContextAsync() } catch { if (-not $Listener.IsListening) { break }; Start-Sleep -Milliseconds 100; continue }
        }
        $got = $false
        try { $got = $pending.Wait(250) } catch {
            $pending = $null
            if (-not $Listener.IsListening) { break }
            continue
        }
        if ($got) {
            $c = $pending.Result
            $pending = $null
            Invoke-VxRequest $c
        }
        Update-VxJobs
        Test-VxLifecycle
    }
}

function New-VxLifecycle {
    return [hashtable]::Synchronized(@{
            lastHeartbeat = $null; firstHeartbeat = $false; shutdownAt = $null; stop = $false; reason = $null
            timeoutSec = 150; waitLogged = $false; lastActivity = [DateTime]::UtcNow
        })
}
