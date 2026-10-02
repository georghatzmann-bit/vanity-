# Installiert Jarvis auf Windows. Normalerweise startet Jarvis.bat dieses Skript von selbst
# (beim ersten Mal und wenn ein Update neue Pakete braucht). JarvisSetup.exe ruft es mit -Auto auf.
# Von Hand, in PowerShell im Jarvis-Ordner:
#   powershell -ExecutionPolicy Bypass -File werkzeuge\installieren.ps1 [-Neu] [-Auto] [-OhneVerknuepfung]
# -Auto: ohne Rückfragen (so ruft es JarvisSetup.exe auf).
# -OhneVerknuepfung: Desktop- und Startmenü-Symbol legt JarvisSetup.exe selbst an.
#
# Fortschritt für die Installer-Oberfläche: Zeilen wie "JARVIS-SCHRITT 3/6 Pakete" stehen im
# Protokoll und, wenn JARVIS_FORTSCHRITT gesetzt ist, auch in dieser Datei
# (Format: installer/setup/Meldung.cs). Läuft mit Windows PowerShell 5.1 und PowerShell 7.
#
# Git for Windows wird nicht gebraucht: Claude Code nimmt seit Version 2.1.120 ohne Git Bash
# das PowerShell-Werkzeug (Jarvis erlaubt beide). Ältere Versionen werden unten aktualisiert.
param([switch]$Neu, [switch]$Auto, [switch]$OhneVerknuepfung)

$ErrorActionPreference = "Stop"
# Der Fortschrittsbalken von Invoke-WebRequest bremst Downloads in Windows PowerShell 5.1 stark.
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$jarvisDir = Join-Path $env:LOCALAPPDATA "Jarvis"
$venvDir = Join-Path $jarvisDir "venv"
$venvPy = Join-Path $venvDir "Scripts\python.exe"
$logFile = Join-Path $jarvisDir "installation.log"
$fortschritt = $env:JARVIS_FORTSCHRITT
$utf8 = New-Object -TypeName Text.UTF8Encoding -ArgumentList $false
$utf8Streng = New-Object -TypeName Text.UTF8Encoding -ArgumentList $false, $true

# Kam der Start aus PowerShell 7 (Windows Terminal, GitHub), erbt Windows PowerShell dessen
# Modulpfade und findet dann manche Befehle nicht. Hier und für alle Kindprozesse bereinigen.
if ($PSVersionTable.PSEdition -ne "Core" -and $env:PSModulePath) {
    $env:PSModulePath = (($env:PSModulePath -split ";") | Where-Object { $_ -and $_ -notmatch "\\PowerShell\\" }) -join ";"
}
# Downloads nur über TLS 1.2: älteres Windows 10 nimmt sonst TLS 1.0, das kein Server mehr annimmt.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}
# Proxy mit Windows-Anmeldung (Firmennetz): die eigenen Zugangsdaten mitschicken.
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch {}
# Python-Programme schreiben ihre Ausgaben als UTF-8 (Umlaute in Pfaden), pip fragt nichts.
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$env:PIP_NO_INPUT = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

New-Item -ItemType Directory -Force $jarvisDir | Out-Null
[IO.File]::WriteAllText($logFile, "Jarvis-Installation $(Get-Date)`r`n", (New-Object -TypeName Text.UTF8Encoding -ArgumentList $true))

# Falls Jarvis.bat über die (minimiert startende) Desktop-Verknüpfung kam: Fenster zeigen.
# Nicht mit -Auto: Da läuft das Skript unsichtbar unter JarvisSetup.exe.
if (-not $Auto) {
    try {
        Add-Type -Namespace Jarvis -Name Win -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
        [void][Jarvis.Win]::ShowWindow([Jarvis.Win]::GetConsoleWindow(), 9)
    } catch {}
    try { $Host.UI.RawUI.WindowTitle = "Jarvis wird installiert" } catch {}
}

# ------------------------------------------------------------------ Protokoll und Fortschritt

# Eine Zeile ins Protokoll. Ist die Datei kurz gesperrt (die Oberfläche liest mit): nochmal.
function Write-Log([string]$text) {
    for ($i = 0; $i -lt 20; $i++) {
        try { [IO.File]::AppendAllText($logFile, $text + "`r`n", $utf8); return } catch { Start-Sleep -Milliseconds 25 }
    }
}

# Fortschritt für JarvisSetup.exe. Ins Protokoll nur, was dort hilft (keine Prozentzahlen).
function Write-Marker([string]$zeile, [switch]$NurOberflaeche) {
    $zeile = ($zeile -replace "[\r\n]+", " ").Trim()
    if (-not $NurOberflaeche) { Write-Log $zeile }
    if (-not $fortschritt) { return }
    for ($i = 0; $i -lt 20; $i++) {
        try { [IO.File]::AppendAllText($fortschritt, $zeile + "`r`n", $utf8); return } catch { Start-Sleep -Milliseconds 25 }
    }
}

$script:phase = 0
$script:anteil = -1
$script:liveText = ""

# Die sechs Schritte der Oberfläche: 1 Vorbereiten, 2 Python, 3 Pakete, 4 Spracherkennung,
# 5 Jarvis' Gehirn, 6 Windows-Bausteine. Schritt 1 beginnt schon im Inno-Kern (Dateien kopieren).
function Enter-Phase([int]$nr, [string]$titel) {
    $script:phase = $nr
    $script:anteil = -1
    $script:liveText = ""
    Write-Marker "JARVIS-SCHRITT $nr/6 $titel"
}
function Set-Detail([string]$text) { Write-Marker "JARVIS-DETAIL $text" }
# Für Zähler, die sich laufend ändern: nur für die Oberfläche, nicht ins Protokoll.
function Set-DetailLive([string]$text) {
    if ($text -ne $script:liveText) { $script:liveText = $text; Write-Marker "JARVIS-DETAIL $text" -NurOberflaeche }
}
# Anteil am laufenden Schritt in Prozent. Geht nur vorwärts.
function Set-Share([double]$prozent) {
    $p = [int][math]::Floor([math]::Max(0, [math]::Min(100, $prozent)))
    if ($p -gt $script:anteil) { $script:anteil = $p; Write-Marker "JARVIS-ANTEIL $p" -NurOberflaeche }
}
function Complete-Phase([string]$text = "") { Write-Marker "JARVIS-OK $($script:phase) $text" }
function Add-Warning([string]$text) { Write-Marker "JARVIS-WARNUNG $($script:phase) $text" }

# ------------------------------------------------------------------ Anzeige

$total = 11
$script:step = 0

function Show-Banner {
    Write-Host ""
    Write-Host "  Jarvis" -ForegroundColor White
    Write-Host "  Installation. Beim ersten Mal dauert das ein paar Minuten." -ForegroundColor DarkGray
    Write-Host ""
}

function Start-Step([string]$text) {
    $script:step++
    $label = "  [$($script:step)/$total] $text "
    Write-Host ($label.PadRight(48, ".")) -NoNewline -ForegroundColor Gray
    Write-Log ""
    Write-Log "== $text"
}

function Write-Ok([string]$detail = "") {
    Write-Host " OK " -ForegroundColor Green -NoNewline
    Write-Host " $detail" -ForegroundColor DarkGray
}

function Write-Warn([string]$detail) {
    Write-Host " !! " -ForegroundColor Yellow -NoNewline
    Write-Host " $detail" -ForegroundColor Yellow
}

function Write-Fail([string]$detail) {
    Write-Host " XX " -ForegroundColor Red
    Write-Host ""
    Write-Host "  $detail" -ForegroundColor Red
}

function Show-LogTail {
    Write-Host ""
    Write-Host "  Letzte Zeilen aus dem Protokoll ($logFile):" -ForegroundColor DarkGray
    Get-Content -LiteralPath $logFile -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

# Abbruch mit klarer Meldung. Die Oberfläche zeigt Meldung und Tipp, der Code sagt, was los war:
# 10 Internet, 11 Speicherplatz, 12 Python, 13 Python-Umgebung, 14 Pakete, 1 Unerwartetes.
function Stop-Install([int]$code, [string]$meldung, [string]$tipp) {
    Write-Fail $meldung
    if ($tipp) { Write-Host "  $tipp" -ForegroundColor Red }
    if ($tipp) { Write-Marker "JARVIS-TIPP $tipp" }
    Write-Marker "JARVIS-FEHLER $($script:phase) $code $meldung"
    Show-LogTail
    exit $code
}

trap {
    $meldung = ($_.Exception.Message -replace "[\r\n]+", " ").Trim()
    Write-Log "Unerwarteter Fehler: $meldung"
    Write-Log "$($_.ScriptStackTrace)"
    Write-Marker 'JARVIS-TIPP Klicken Sie auf „Nochmal versuchen“. Hilft das nicht, öffnen Sie das Protokoll und schicken Sie es an Claude im Jarvis-Projekt.'
    Write-Marker "JARVIS-FEHLER $($script:phase) 1 Unerwarteter Fehler: $meldung"
    Write-Host ""
    Write-Host "  Unerwarteter Fehler: $meldung" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------ Programme starten

# Ein Argument nach den Windows-Regeln einpacken (Leerzeichen, Anführungszeichen, Backslashes).
function ConvertTo-Argument([string]$wert) {
    if ($wert -eq "") { return '""' }
    if ($wert -notmatch '[\s"]') { return $wert }
    $s = $wert -replace '(\\*)"', '$1$1\"'
    $s = $s -replace '(\\+)$', '$1$1'
    return '"' + $s + '"'
}

function Stop-ProcessTree([int]$id) {
    $ErrorActionPreference = "Continue"
    try { & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $id /T /F 2>&1 | Out-Null } catch {}
}

# Liest, was ein Programm seit dem letzten Mal in eine Datei geschrieben hat: nur ganze Zeilen,
# außer mit -Alles (am Ende). Die Stelle steht in $stand. Text erst als UTF-8, sonst wie die Konsole.
function Read-NewLines([string]$datei, [hashtable]$stand, [switch]$Alles) {
    if (-not (Test-Path -LiteralPath $datei)) { return @() }
    try {
        $fs = New-Object -TypeName IO.FileStream -ArgumentList $datei, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::ReadWrite)
    } catch { return @() }
    try {
        $pos = [int64]0
        if ($stand.ContainsKey($datei)) { $pos = [int64]$stand[$datei] }
        $laenge = $fs.Length
        if ($laenge -le $pos) { return @() }
        $fs.Position = $pos
        $puffer = New-Object byte[] ([int]($laenge - $pos))
        $n = $fs.Read($puffer, 0, $puffer.Length)
        if ($n -le 0) { return @() }
        $ende = $n
        if (-not $Alles) {
            $ende = [Array]::LastIndexOf($puffer, [byte]10, $n - 1) + 1
            if ($ende -le 0) { return @() }
        }
        $stand[$datei] = $pos + $ende
        try { $text = $utf8Streng.GetString($puffer, 0, $ende) }
        catch { $text = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage).GetString($puffer, 0, $ende) }
        # Fortschrittsbalken (tqdm) schreiben mit \r: nur der letzte Stand einer Zeile zählt.
        return @($text -split "\r?\n" | ForEach-Object { ($_ -split "\r")[-1].TrimEnd() } | Where-Object { $_.Trim() -ne "" })
    } catch {
        return @()
    } finally {
        $fs.Dispose()
    }
}

# Startet ein Programm unsichtbar, schreibt seine Ausgaben laufend ins Protokoll und zeigt in der
# Konsole eine kleine Animation mit der Zeit. Gibt den Exit-Code zurück (-1: startet nicht,
# -2: nach $timeout Sekunden abgebrochen). $beobachter bekommt etwa jede Sekunde die neuen Zeilen
# und die vergangenen Sekunden (für den Fortschritt).
function Invoke-Quiet([string]$exe, [string[]]$arguments, [int]$timeout = 0, [scriptblock]$beobachter = $null) {
    $out = Join-Path $jarvisDir "schritt-ausgabe.txt"
    $err = Join-Path $jarvisDir "schritt-fehler.txt"
    Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue
    $zeile = ($arguments | ForEach-Object { ConvertTo-Argument $_ }) -join " "
    Write-Log ("> " + (Split-Path -Leaf $exe) + " " + $(if ($zeile.Length -gt 300) { $zeile.Substring(0, 300) + " ..." } else { $zeile }))
    try {
        $proc = Start-Process -FilePath $exe -ArgumentList $zeile -NoNewWindow -PassThru `
            -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err
    } catch {
        Write-Log "Start ging nicht: $($_.Exception.Message)"
        return -1
    }
    $null = $proc.Handle  # sonst liefert Windows PowerShell später keinen Exit-Code
    $frames = @("(    )", "( .  )", "( .. )", "( ...)", "(  ..)", "(   .)")
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $stand = @{}
    $i = 0
    $naechste = 1.0
    $abgebrochen = $false
    while (-not $proc.WaitForExit(250)) {
        $time = "{0}:{1:00}" -f [int][math]::Floor($watch.Elapsed.TotalMinutes), $watch.Elapsed.Seconds
        Write-Host (" " + $frames[$i % $frames.Count] + " " + $time) -NoNewline -ForegroundColor Cyan
        Write-Host ("`b" * (8 + $time.Length)) -NoNewline
        $i++
        if ($watch.Elapsed.TotalSeconds -ge $naechste) {
            $naechste = $watch.Elapsed.TotalSeconds + 1.0
            $neu = @(Read-NewLines $out $stand) + @(Read-NewLines $err $stand)
            foreach ($z in $neu) { Write-Log $z }
            if ($beobachter) { try { & $beobachter $neu $watch.Elapsed.TotalSeconds } catch {} }
        }
        if ($timeout -gt 0 -and $watch.Elapsed.TotalSeconds -gt $timeout) {
            Write-Log "Nach $timeout Sekunden abgebrochen."
            Stop-ProcessTree $proc.Id
            $abgebrochen = $true
            break
        }
    }
    if (-not $abgebrochen) { $proc.WaitForExit() }
    Write-Host (" " * 16) -NoNewline
    Write-Host ("`b" * 16) -NoNewline
    $neu = @(Read-NewLines $out $stand -Alles) + @(Read-NewLines $err $stand -Alles)
    foreach ($z in $neu) { Write-Log $z }
    if ($beobachter) { try { & $beobachter $neu $watch.Elapsed.TotalSeconds } catch {} }
    Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue
    if ($abgebrochen) { return -2 }
    return $proc.ExitCode
}

# Startet ein Programm und gibt seine Ausgabe zurück ($null nach $timeoutMs oder bei Fehlern).
function Get-Output([string]$exe, [string[]]$arguments, [int]$timeoutMs = 60000) {
    try {
        $psi = New-Object -TypeName Diagnostics.ProcessStartInfo -ArgumentList $exe, (($arguments | ForEach-Object { ConvertTo-Argument $_ }) -join " ")
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $p = [Diagnostics.Process]::Start($psi)
        $ausgabe = $p.StandardOutput.ReadToEndAsync()
        $null = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($timeoutMs)) { Stop-ProcessTree $p.Id; return $null }
        return $ausgabe.Result
    } catch {
        return $null
    }
}

# Lädt eine Datei herunter. $melden bekommt unterwegs (geladen, gesamt) in Bytes.
function Save-Download([string]$url, [string]$ziel, [scriptblock]$melden = $null) {
    $anfrage = [Net.WebRequest]::Create($url)
    $anfrage.Timeout = 30000
    $anfrage.ReadWriteTimeout = 60000
    $antwort = $anfrage.GetResponse()
    try {
        $gesamt = [int64]$antwort.ContentLength
        $quelle = $antwort.GetResponseStream()
        $datei = [IO.File]::Create($ziel)
        try {
            $puffer = New-Object byte[] 65536
            $geladen = [int64]0
            $uhr = [Diagnostics.Stopwatch]::StartNew()
            while (($n = $quelle.Read($puffer, 0, $puffer.Length)) -gt 0) {
                $datei.Write($puffer, 0, $n)
                $geladen += $n
                if ($melden -and $uhr.ElapsedMilliseconds -ge 500) {
                    $uhr.Reset(); $uhr.Start()
                    try { & $melden $geladen $gesamt } catch {}
                }
            }
            if ($melden) { try { & $melden $geladen $gesamt } catch {} }
        } finally {
            $datei.Dispose()
            $quelle.Dispose()
        }
    } finally {
        $antwort.Close()
    }
}

function Get-Sha256([string]$datei) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($datei)
    try { return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace "-", "") } finally { $fs.Dispose(); $sha.Dispose() }
}

function Get-FolderSize([string]$ordner) {
    $summe = [int64]0
    if (-not (Test-Path -LiteralPath $ordner)) { return $summe }
    try {
        foreach ($f in [IO.Directory]::EnumerateFiles($ordner, "*", [IO.SearchOption]::AllDirectories)) {
            try { $summe += (New-Object -TypeName IO.FileInfo -ArgumentList $f).Length } catch {}
        }
    } catch {}
    return $summe
}

function Format-MB([int64]$bytes) { return "{0:N0}" -f ($bytes / 1MB) }

function Update-PathFromRegistry {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# Einen Ordner dauerhaft in den PATH des Benutzers aufnehmen (ohne Administrator).
function Add-UserPath([string]$ordner) {
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if (-not $key) { return }
        try {
            $alt = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $teile = @($alt -split ";" | Where-Object { $_ })
            foreach ($t in $teile) {
                if ([Environment]::ExpandEnvironmentVariables($t).TrimEnd("\") -ieq $ordner.TrimEnd("\")) { return }
            }
            $art = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($alt) { try { $art = $key.GetValueKind("Path") } catch {} }
            $key.SetValue("Path", (($teile + $ordner) -join ";"), $art)
            Write-Log "PATH ergänzt: $ordner"
        } finally {
            $key.Close()
        }
        # Windows Bescheid geben, damit neue Fenster den PATH gleich kennen.
        [Environment]::SetEnvironmentVariable("JARVIS_PFAD_GEAENDERT", $null, "User")
    } catch {
        Write-Log "PATH: $($_.Exception.Message)"
    }
}

Show-Banner
Write-Log "Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion), 64 Bit: $([Environment]::Is64BitProcess)"

# ------------------------------------------------------------------ 1. Platz und Internet

Enter-Phase 1 "Vorbereiten"
Start-Step "Speicherplatz und Internet"
Set-Detail "Speicherplatz und Internet werden geprüft"
if ($Neu -and (Test-Path $venvDir)) {
    Remove-Item -Recurse -Force $venvDir -ErrorAction SilentlyContinue
}
$laufwerk = [IO.Path]::GetPathRoot($jarvisDir)
$frei = [int64]-1
try { $frei = (New-Object -TypeName IO.DriveInfo -ArgumentList $laufwerk).AvailableFreeSpace } catch {}
# Neu: Python-Umgebung, Spracherkennung und Claude Code brauchen zusammen etwa 2,5 GB.
$noetig = if (Test-Path $venvPy) { 512MB } else { 2GB }
if ($frei -ge 0 -and $frei -lt $noetig) {
    $name = $laufwerk.TrimEnd("\")
    Stop-Install 11 ("Auf Laufwerk $name ist zu wenig Platz frei (noch {0:N1} GB)." -f ($frei / 1GB)) `
        'Jarvis braucht etwa 3 GB. Leeren Sie zum Beispiel den Papierkorb oder deinstallieren Sie ein altes Spiel. Dann „Nochmal versuchen“.'
}
Set-Share 75

# Erreichbar ist das Internet, sobald irgendein Server antwortet (auch mit einem Fehlercode).
function Test-Internet {
    $grund = "netz"
    foreach ($url in @("https://pypi.org/simple/pip/", "https://www.python.org/", "https://downloads.claude.ai/claude-code-releases/latest")) {
        try {
            $null = Invoke-WebRequest -UseBasicParsing -Uri $url -Method Head -TimeoutSec 20
            return ""
        } catch {
            $ex = $_.Exception
            Write-Log "Internet-Prüfung ${url}: $($ex.Message)"
            $antwort = $null
            try { $antwort = $ex.Response } catch {}
            if ($antwort) {
                $status = 0
                try { $status = [int]$antwort.StatusCode } catch {}
                if ($status -eq 407) { return "proxy" }
                return ""
            }
            $text = "$($ex.Message) $($ex.InnerException)"
            if ($text -match "SSL|TLS|secure channel|sicheren Kanal|Vertrauensstellung|trust relationship|certificate|Zertifikat") { $grund = "tls" }
        }
    }
    return $grund
}

$internet = Test-Internet
if ($internet -eq "proxy") {
    Stop-Install 10 "Ihr Netzwerk verlangt eine Anmeldung am Proxy." `
        'Melden Sie sich einmal im Browser an oder fragen Sie, wer Ihr Netzwerk betreut. Dann „Nochmal versuchen“.'
} elseif ($internet -eq "tls") {
    Stop-Install 10 "Die sichere Verbindung zu den Download-Servern klappt nicht." `
        'Prüfen Sie Datum und Uhrzeit des PCs und installieren Sie alle Windows-Updates. Dann „Nochmal versuchen“.'
} elseif ($internet) {
    Stop-Install 10 "Keine Verbindung zum Internet." `
        'Prüfen Sie WLAN oder Netzwerkkabel und klicken Sie dann auf „Nochmal versuchen“.'
}
if ($frei -ge 0) { Write-Ok ("{0:N0} GB frei, Internet da" -f ($frei / 1GB)) } else { Write-Ok "Internet da" }
Complete-Phase

# ------------------------------------------------------------------ 2. Python

Enter-Phase 2 "Python"
Start-Step "Python suchen"
Set-Detail "Python wird gesucht"
# Bevorzugt eine gut unterstützte Version. "py -3" nimmt sonst die neueste, und für
# ganz neue Versionen gibt es manche Pakete noch nicht. (Fehlermeldungen von "py" werden
# verschluckt. Das geht in Windows PowerShell nur mit ErrorActionPreference Continue.)
function Find-Python {
    $ErrorActionPreference = "Continue"
    $launchers = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { $launchers += "py" }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Launcher\py.exe"),
        (Join-Path $env:SystemRoot "py.exe"))) {
        if (Test-Path $candidate) { $launchers += $candidate }
    }
    foreach ($launcher in $launchers) {
        foreach ($version in @("-3.13", "-3.12", "-3.11", "-3.14")) {
            $found = & $launcher $version -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $found) { return "$found".Trim() }
        }
    }
    $direct = @(Get-Command python -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    $direct += @("Python313", "Python312", "Python311") |
        ForEach-Object { Join-Path $env:LOCALAPPDATA "Programs\Python\$_\python.exe" } |
        Where-Object { Test-Path $_ }
    foreach ($exe in $direct) {
        # Der "python" aus dem Microsoft Store ist oft nur ein Platzhalter.
        $found = & $exe -c "import sys; print(sys.executable) if sys.version_info >= (3, 11) and sys.version_info < (3, 15) else None" 2>$null
        if ($LASTEXITCODE -eq 0 -and $found -and "$found".Trim() -ne "None") { return "$found".Trim() }
    }
    return $null
}

# Python 3.12 direkt von python.org, nur für diesen Benutzer, ohne Administrator und ohne winget
# (das fehlt auf manchem Windows 10). Die Prüfsummen stammen von python.org.
function Install-Python {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
    $pruefsummen = @{
        "amd64" = "67B5635E80EA51072B87941312D00EC8927C4DB9BA18938F7AD2D27B328B95FB"
        "arm64" = "377AC8FD478987940088E879441E702A71B53164D2A1E6F1D51FF77A7E470258"
    }
    $setup = Join-Path $env:TEMP "python-3.12.10-$arch.exe"
    for ($versuch = 1; $versuch -le 2; $versuch++) {
        try {
            Set-Detail "Python 3.12 wird geladen"
            Save-Download "https://www.python.org/ftp/python/3.12.10/python-3.12.10-$arch.exe" $setup {
                param($geladen, $gesamt)
                if ($gesamt -gt 0) {
                    Set-Share (5 + 55 * $geladen / $gesamt)
                    Set-DetailLive ("Python 3.12 wird geladen: {0} von {1} MB" -f (Format-MB $geladen), (Format-MB $gesamt))
                }
            }
            if ((Get-Sha256 $setup) -ne $pruefsummen[$arch]) {
                Write-Log "Python-Download: Die Prüfsumme passt nicht (Versuch $versuch)."
                continue
            }
            Set-Detail "Python 3.12 wird eingerichtet"
            # InstallLauncherAllUsers=0: Sonst will der py-Starter Administratorrechte.
            $code = Invoke-Quiet $setup @("/quiet", "InstallAllUsers=0", "InstallLauncherAllUsers=0", "PrependPath=1",
                "Include_launcher=1", "Include_test=0", "Include_doc=0", "Shortcuts=0") 900 {
                param($neu, $sekunden)
                Set-Share (60 + [math]::Min(38, $sekunden / 2))
            }
            Write-Log "Python-Installer beendet mit $code"
            return
        } catch {
            Write-Log "Python-Download: $($_.Exception.Message)"
        } finally {
            Remove-Item -LiteralPath $setup -ErrorAction SilentlyContinue
        }
    }
}

$python = Find-Python
if (-not $python) {
    Write-Warn "nicht gefunden"
    Write-Host ""
    Write-Host "  Jarvis braucht Python (kostenlos). Ich kann es jetzt automatisch installieren." -ForegroundColor White
    $answer = if ($Auto) { "j" } else { Read-Host "  Python 3.12 installieren? [J/n]" }
    if ($answer -notmatch '^(n|nein)$') {
        Write-Host "  Python wird installiert, das dauert etwa eine Minute ..." -ForegroundColor Cyan
        Install-Python
        Update-PathFromRegistry
        $python = Find-Python
    }
    if (-not $python) {
        Stop-Install 12 "Python ließ sich nicht installieren." `
            'Installieren Sie Python 3.12 von https://www.python.org/downloads/ (Haken bei „Add python.exe to PATH“). Dann „Nochmal versuchen“.'
    }
    $script:step--
    Start-Step "Python suchen"
}
$ErrorActionPreference = "Continue"
$version = & $python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
$ErrorActionPreference = "Stop"
Write-Ok "Python $version"
Write-Log "Python: $python"
Complete-Phase "Python $version"

# Heruntergeladene Dateien entsperren, sonst fragt Windows bei jedem Doppelklick nach.
Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.venv\\' } |
    Unblock-File -ErrorAction SilentlyContinue

# ------------------------------------------------------------------ 3. Umgebung und Pakete

Enter-Phase 3 "Pakete"
Start-Step "Eigene Python-Umgebung"
Set-Detail "Eigene Python-Umgebung wird angelegt"
# Sie liegt (rund 1 GB) außerhalb des Jarvis-Ordners, damit OneDrive sie nicht
# hochlädt und beim Installieren keine Dateien sperrt.
if (Test-Path $venvPy) {
    $ErrorActionPreference = "Continue"
    & $venvPy -c "import sys" 2>$null
    $venvOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = "Stop"
    if (-not $venvOk) { Remove-Item -Recurse -Force $venvDir -ErrorAction SilentlyContinue }
}
if (-not (Test-Path $venvPy)) {
    $code = Invoke-Quiet $python @("-m", "venv", $venvDir) 600
    if ($code -ne 0 -or -not (Test-Path $venvPy)) {
        Stop-Install 13 "Die eigene Python-Umgebung ließ sich nicht anlegen." `
            'Klicken Sie auf „Nochmal versuchen“. Hilft das nicht, starten Sie den PC neu und versuchen Sie es dann noch einmal.'
    }
    Write-Ok "neu angelegt"
} else {
    Write-Ok "vorhanden"
}
Set-Share 5

# Woran pip gescheitert ist, steht in den letzten Zeilen des Protokolls.
function Get-PipProblem {
    $ende = (Get-Content -LiteralPath $logFile -Tail 80 -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`n"
    if ($ende -match "No space left|Errno 28|nicht genügend Speicher|not enough space|disk is full") { return "platz" }
    if ($ende -match "WinError 32|WinError 5\]|Zugriff verweigert|Access is denied|being used by another process|von einem anderen Prozess verwendet") { return "gesperrt" }
    if ($ende -match "ConnectionError|NewConnectionError|Max retries|ReadTimeout|timed out|ProxyError|SSLError|getaddrinfo|Name or service|No matching distribution|Could not find a version") { return "netz" }
    return ""
}

function Stop-PipProblem([string]$was) {
    switch (Get-PipProblem) {
        "platz" {
            Stop-Install 14 "Beim Laden der $was war die Festplatte voll." `
                'Jarvis braucht etwa 3 GB. Machen Sie Platz frei (Papierkorb, alte Spiele) und klicken Sie auf „Nochmal versuchen“.'
        }
        "gesperrt" {
            Stop-Install 14 "Eine Datei war gesperrt, die $was ließen sich nicht ersetzen." `
                'Schließen Sie alle Jarvis-Fenster und klicken Sie auf „Nochmal versuchen“.'
        }
        "netz" {
            Stop-Install 14 "Die Verbindung ist beim Laden der $was abgebrochen." `
                'Prüfen Sie das Internet und klicken Sie auf „Nochmal versuchen“. Was schon geladen ist, bleibt erhalten.'
        }
        default {
            Stop-Install 14 "Die $was ließen sich nicht installieren." `
                'Klicken Sie auf „Nochmal versuchen“. Hilft das nicht, öffnen Sie das Protokoll und schicken Sie es an Claude im Jarvis-Projekt.'
        }
    }
}

Start-Step "Pakete (beim 1. Mal ein paar Minuten)"
Set-Detail "pip wird aktualisiert"
$null = Invoke-Quiet $venvPy @("-m", "pip", "install", "--upgrade", "pip", "--disable-pip-version-check") 600
Set-Share 8
Set-Detail "Pakete werden geladen"
$script:pakete = @{}
$code = Invoke-Quiet $venvPy @("-m", "pip", "install", "-r", "requirements.txt", "--disable-pip-version-check") 3600 {
    param($neu, $sekunden)
    foreach ($z in $neu) {
        if ($z -match '^(?:Collecting|Requirement already satisfied:)\s+([A-Za-z0-9_.\-]+)') {
            $script:pakete[$Matches[1].ToLowerInvariant()] = $true
        } elseif ($z -match '^Installing collected packages') {
            Set-Share 80
            Set-DetailLive "Pakete werden eingerichtet"
            return
        }
    }
    $n = $script:pakete.Count
    if ($n -gt 0 -and $script:anteil -lt 80) {
        # Rund 60 Pakete samt Abhängigkeiten
        Set-Share (8 + 70 * [math]::Min(1, $n / 60))
        Set-DetailLive ("Pakete werden geladen: {0} von etwa {1}" -f $n, [math]::Max(60, $n))
    }
}
if ($code -ne 0) { Stop-PipProblem "Pakete" }
Write-Ok
Set-Share 84

Start-Step "Oberfläche und Extras"
$extras = @(Get-Content "requirements-extras.txt" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
$missing = @()
for ($k = 0; $k -lt $extras.Count; $k++) {
    $package = $extras[$k]
    Set-DetailLive ("Oberfläche und Extras: {0} ({1} von {2})" -f ($package -replace '[<>=!~;\[].*$', ''), ($k + 1), $extras.Count)
    $code = Invoke-Quiet $venvPy @("-m", "pip", "install", $package, "--disable-pip-version-check") 1800
    if ($code -ne 0) { $missing += $package }
    Set-Share (84 + 16 * ($k + 1) / [math]::Max(1, $extras.Count))
}
if ($missing.Count -gt 0) {
    Write-Warn ("fehlt: " + ($missing -join ", ") + " (Jarvis läuft trotzdem)")
    Add-Warning ("Nicht alle Extras ließen sich laden (" + (($missing | ForEach-Object { $_ -replace '[<>=!~;\[].*$', '' }) -join ", ") + "). Jarvis läuft trotzdem. Später hilft werkzeuge\Neu-installieren.bat.")
} else {
    Write-Ok "Fenster, Tray-Symbol, Systemanzeige"
}

# Die alte Umgebung im Jarvis-Ordner wird nicht mehr gebraucht.
$oldVenv = Join-Path $root ".venv"
if (Test-Path $oldVenv) { Remove-Item -Recurse -Force $oldVenv -ErrorAction SilentlyContinue }
if (-not (Test-Path "config.toml")) { Copy-Item "config.example.toml" "config.toml" }
Complete-Phase

# ------------------------------------------------------------------ 4. Modelle

Enter-Phase 4 "Spracherkennung"
Start-Step "Hey-Jarvis-Erkennung laden"
Set-Detail '„Hey Jarvis“-Erkennung wird geladen'
$code = Invoke-Quiet $venvPy @("-c", "import openwakeword.utils as u; u.download_models(model_names=['hey_jarvis'])") 900
if ($code -eq 0) {
    Write-Ok
} else {
    Write-Warn "lädt Jarvis beim ersten Start"
    Add-Warning 'Die „Hey Jarvis“-Erkennung lädt Jarvis beim ersten Start nach.'
}
Set-Share 8

Start-Step "Spracherkennung laden (500 MB)"
Set-Detail "Spracherkennung wird geladen (etwa 460 MB)"
# Den Fortschritt verrät die Größe des Modell-Ordners. Ohne Xet lädt huggingface_hub die Datei
# am Stück (kein zweiter Zwischenspeicher, der doppelt Platz kostet).
$hfHub = if ($env:HF_HUB_CACHE) { $env:HF_HUB_CACHE } elseif ($env:HF_HOME) { Join-Path $env:HF_HOME "hub" } else { Join-Path $env:USERPROFILE ".cache\huggingface\hub" }
$modellDir = Join-Path $hfHub "models--Systran--faster-whisper-small"
$script:modellVorher = Get-FolderSize $modellDir
$env:HF_HUB_DISABLE_XET = "1"
$code = Invoke-Quiet $venvPy @("-c", "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')") 1800 {
    param($neu, $sekunden)
    $geladen = (Get-FolderSize $modellDir) - $script:modellVorher
    if ($geladen -gt 1MB) {
        Set-Share (10 + 88 * [math]::Min(1, $geladen / 486MB))
        Set-DetailLive ("Spracherkennung wird geladen: {0} von etwa 460 MB" -f (Format-MB ([math]::Min($geladen, 486MB))))
    }
}
Remove-Item Env:\HF_HUB_DISABLE_XET -ErrorAction SilentlyContinue
if ($code -eq 0) {
    Write-Ok
} else {
    Write-Warn "lädt Jarvis beim ersten Start"
    Add-Warning "Die Spracherkennung lädt Jarvis beim ersten Start nach (etwa 460 MB)."
}
Complete-Phase

# ------------------------------------------------------------------ 5. Claude Code

Enter-Phase 5 "Jarvis' Gehirn"
Start-Step "Jarvis' Gehirn (Claude Code)"
function Find-Claude {
    $found = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
    foreach ($candidate in @(
        (Join-Path $env:USERPROFILE ".local\bin\claude.exe"),
        (Join-Path $env:APPDATA "npm\claude.cmd"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\claude.exe"))) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Find-GitBash {
    foreach ($candidate in @(
        $env:CLAUDE_CODE_GIT_BASH_PATH,
        (Join-Path $env:ProgramFiles "Git\bin\bash.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Git\bin\bash.exe"))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

$claudeBin = Join-Path $env:USERPROFILE ".local\bin"
$claude = Find-Claude
if ($claude) {
    Set-Detail "Claude Code ist schon da, die Version wird geprüft"
    $ausgabe = Get-Output $claude @("--version") 60000
    $claudeVersion = $null
    if ("$ausgabe" -match '(\d+)\.(\d+)\.(\d+)') { $claudeVersion = New-Object -TypeName Version -ArgumentList ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3]) }
    Write-Log "Claude Code $claudeVersion ($claude)"
    # Vor 2.1.120 brauchte Claude Code unter Windows Git Bash. Ohne Git: auf den neuesten Stand.
    if ($claudeVersion -and $claudeVersion -lt (New-Object -TypeName Version -ArgumentList 2, 1, 120) -and -not (Find-GitBash)) {
        Set-Detail "Claude Code wird aktualisiert"
        $null = Invoke-Quiet $claude @("update") 900
    }
    Write-Ok "vorhanden"
    Complete-Phase "Claude Code ist schon da"
} else {
    # Der offizielle Installer (ohne Administrator, ohne Node.js). Anmelden geht danach in der Einrichtung.
    # In einem eigenen PowerShell-Prozess (der Installer beendet sich bei Fehlern mit "exit"),
    # dort zuerst TLS 1.2 einschalten. -EncodedCommand: keine Probleme mit Leerzeichen und Umlauten.
    Set-Detail "Claude Code wird geladen (etwa 250 MB)"
    $groesse = [int64]250MB
    try {
        $neueste = (Invoke-WebRequest -UseBasicParsing -Uri "https://downloads.claude.ai/claude-code-releases/latest" -TimeoutSec 20).Content
        $neueste = ([string]$neueste).Trim()
        if ($neueste -match '^\d+\.\d+\.\d+') {
            $manifest = Invoke-RestMethod -Uri "https://downloads.claude.ai/claude-code-releases/$neueste/manifest.json" -TimeoutSec 20
            $plattform = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win32-arm64" } else { "win32-x64" }
            if ($manifest.platforms.$plattform.size) { $groesse = [int64]$manifest.platforms.$plattform.size }
        }
    } catch {}
    $downloads = Join-Path $env:USERPROFILE ".claude\downloads"
    $script:claudeVorher = Get-FolderSize $downloads
    $claudeSetup = Join-Path $env:TEMP "claude-install.ps1"
    try {
        Save-Download "https://claude.ai/install.ps1" $claudeSetup
        $befehl = "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; " +
            "& '" + $claudeSetup.Replace("'", "''") + "'; exit `$LASTEXITCODE"
        $kodiert = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($befehl))
        $code = Invoke-Quiet "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $kodiert) 1800 {
            param($neu, $sekunden)
            $geladen = (Get-FolderSize $downloads) - $script:claudeVorher
            if ($geladen -gt 1MB -and $script:anteil -lt 85) {
                Set-Share (5 + 80 * [math]::Min(1, $geladen / $groesse))
                Set-DetailLive ("Claude Code wird geladen: {0} von {1} MB" -f (Format-MB ([math]::Min($geladen, $groesse))), (Format-MB $groesse))
            }
            foreach ($z in $neu) {
                if ($z -match "Setting up|Installing Claude Code|launcher") { Set-Share 88; Set-DetailLive "Claude Code wird eingerichtet" }
            }
        }
        Write-Log "Claude-Installer beendet mit $code"
    } catch {
        Write-Log "Claude-Installer: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $claudeSetup -ErrorAction SilentlyContinue
    }
    if (Find-Claude) {
        Write-Ok "installiert, anmelden in der Einrichtung"
        Complete-Phase "Claude Code installiert, die Anmeldung kommt in der Einrichtung"
    } else {
        Write-Warn "ging nicht, die Einrichtung hilft weiter"
        Add-Warning "Claude Code ließ sich nicht installieren. Die Einrichtung hilft beim zweiten Versuch."
        Complete-Phase
    }
}
# Damit "claude" auch in neuen Konsolenfenstern geht (der Installer trägt das nicht selbst ein).
if (Test-Path -LiteralPath (Join-Path $claudeBin "claude.exe")) { Add-UserPath $claudeBin }

# ------------------------------------------------------------------ 6. Windows-Bausteine

Enter-Phase 6 "Windows-Bausteine"

# Für Spracherkennung und Wake Word: die Microsoft-Laufzeit, mindestens 14.40. Ältere stürzen mit
# Paketen ab, die mit neuem Visual Studio gebaut sind (onnxruntime, ctranslate2).
function Get-VcVersion {
    $dll = Join-Path $env:SystemRoot "System32\msvcp140.dll"
    if (-not (Test-Path -LiteralPath $dll)) { return $null }
    try {
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($dll)
        return New-Object -TypeName Version -ArgumentList $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
    } catch {
        return $null
    }
}
$vcNoetig = New-Object -TypeName Version -ArgumentList 14, 40, 0
Start-Step "Microsoft-Laufzeit"
Set-Detail "Microsoft-Laufzeit wird geprüft"
$vc = Get-VcVersion
if ($vc -and $vc -ge $vcNoetig) {
    Write-Ok "vorhanden ($vc)"
} else {
    Write-Host ""
    Write-Host "  Die Microsoft-Laufzeit (Visual C++) fehlt oder ist alt, Windows fragt gleich einmal nach." -ForegroundColor Cyan
    $vcArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $vcSetup = Join-Path $env:TEMP "vc_redist.$vcArch.exe"
    try {
        Set-Detail "Microsoft-Laufzeit wird geladen"
        Save-Download "https://aka.ms/vs/17/release/vc_redist.$vcArch.exe" $vcSetup {
            param($geladen, $gesamt)
            if ($gesamt -gt 0) { Set-Share (5 + 30 * $geladen / $gesamt) }
        }
        Set-Detail 'Windows fragt gleich nach Administratorrechten. Bitte auf „Ja“ klicken.'
        $p = Start-Process -FilePath $vcSetup -ArgumentList "/install", "/quiet", "/norestart" -Verb RunAs -Wait -PassThru
        Write-Log "VC-Laufzeit beendet mit $($p.ExitCode)"
    } catch {
        Write-Log "VC-Laufzeit: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $vcSetup -ErrorAction SilentlyContinue
    }
    $vc = Get-VcVersion
    if ($vc -and $vc -ge $vcNoetig) {
        Write-Ok "installiert ($vc)"
    } elseif ($vc) {
        Write-Warn "veraltet ($vc)"
        Add-Warning 'Die Microsoft-Laufzeit ist veraltet. Stürzt die Spracherkennung ab: JarvisSetup.exe noch einmal starten und bei der Windows-Frage „Ja“ klicken.'
    } else {
        Write-Warn "fehlt"
        Add-Warning 'Die Microsoft-Laufzeit (Visual C++) fehlt, ohne sie geht die Spracherkennung nicht. JarvisSetup.exe noch einmal starten und bei der Windows-Frage „Ja“ klicken.'
    }
}
Set-Share 35

# Das Jarvis-Fenster braucht Microsoft Edge WebView2 (unter Windows 11 immer da, unter 10 meistens).
$webviewKeys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
function Test-WebView2 {
    foreach ($key in $webviewKeys) {
        try {
            $pv = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction Stop).pv
            if ($pv -and $pv -ne "0.0.0.0") { return $true }
        } catch {}
    }
    return $false
}
Start-Step "WebView2 (für das Fenster)"
Set-Detail "WebView2 für das Jarvis-Fenster wird geprüft"
if (Test-WebView2) {
    Write-Ok "vorhanden"
} else {
    $wv = Join-Path $env:TEMP "MicrosoftEdgeWebview2Setup.exe"
    try {
        Set-Detail "Microsoft Edge WebView2 wird installiert (für das Jarvis-Fenster)"
        Save-Download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" $wv
        $null = Invoke-Quiet $wv @("/silent", "/install") 900 {
            param($neu, $sekunden)
            Set-Share (40 + [math]::Min(40, $sekunden / 3))
        }
    } catch {
        Write-Log "WebView2: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $wv -ErrorAction SilentlyContinue
    }
    if (Test-WebView2) {
        Write-Ok "installiert"
    } else {
        Write-Warn "fehlt noch"
        Write-Host "  WebView2 fehlt noch: https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen Bootstrapper)" -ForegroundColor Yellow
        Add-Warning "Microsoft Edge WebView2 fehlt noch, ohne sie öffnet sich das Jarvis-Fenster nicht. Hilfe: https://developer.microsoft.com/microsoft-edge/webview2/"
    }
}
Set-Share 80

Start-Step "Symbol auf dem Desktop"
Set-Detail "Symbol wird angelegt"
$icon = Join-Path $jarvisDir "jarvis.ico"
$null = Invoke-Quiet $venvPy @("-c", "import sys; from jarvis.tray import save_app_icon; save_app_icon(sys.argv[1])", $icon) 120
function New-JarvisShortcut([string]$path) {
    # Direkt pythonw + Jarvis.pyw: kein Konsolenfenster beim Start
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = Join-Path $venvDir "Scripts\pythonw.exe"
    $link.Arguments = '"' + (Join-Path $root "Jarvis.pyw") + '"'
    $link.WorkingDirectory = $root
    $link.Description = "Jarvis zeigen"
    if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
    $link.Save()
}
if ($OhneVerknuepfung) {
    Write-Ok "legt der Installer an"
} else {
    try {
        New-JarvisShortcut (Join-Path ([Environment]::GetFolderPath("Desktop")) "Jarvis.lnk")
        New-JarvisShortcut (Join-Path ([Environment]::GetFolderPath("Programs")) "Jarvis.lnk")
        Write-Ok "Desktop und Startmenü"
    } catch {
        Write-Warn "ging nicht ($($_.Exception.Message)). Jarvis.bat geht trotzdem."
    }
}

# Merken, womit installiert wurde. Jarvis.bat installiert nur neu, wenn sich das ändert.
Copy-Item "requirements.txt", "requirements-extras.txt" $jarvisDir -Force
Complete-Phase
Write-Marker "JARVIS-FERTIG"

Write-Host ""
Write-Host "  Fertig. Jarvis ist installiert." -ForegroundColor Green
if ($Neu) {
    Write-Host "  Starte Jarvis mit dem Symbol auf dem Desktop." -ForegroundColor White
} elseif (Test-Path (Join-Path $root "daten\einrichtung-fertig.txt")) {
    Write-Host "  Jarvis startet gleich." -ForegroundColor White
} else {
    Write-Host "  Gleich öffnet sich die Einrichtung. Ab jetzt startest du Jarvis mit dem Symbol auf dem Desktop." -ForegroundColor White
}
Write-Host ""
Write-Log ""
Write-Log "== Fertig"
if (-not $Auto) { Start-Sleep -Seconds 2 }
exit 0
