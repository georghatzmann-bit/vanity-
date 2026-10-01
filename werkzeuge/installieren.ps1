# Installiert Jarvis auf Windows. Normalerweise startet Jarvis.bat dieses Skript von selbst
# (beim ersten Mal und wenn ein Update neue Pakete braucht).
# Von Hand, in PowerShell im Jarvis-Ordner:
#   powershell -ExecutionPolicy Bypass -File werkzeuge\installieren.ps1 [-Neu] [-Auto] [-OhneVerknuepfung]
# -Auto: ohne Rueckfragen (so ruft es JarvisSetup.exe auf).
# -OhneVerknuepfung: Desktop- und Startmenue-Symbol legt JarvisSetup.exe selbst an.
param([switch]$Neu, [switch]$Auto, [switch]$OhneVerknuepfung)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$jarvisDir = Join-Path $env:LOCALAPPDATA "Jarvis"
$venvDir = Join-Path $jarvisDir "venv"
$venvPy = Join-Path $venvDir "Scripts\python.exe"
$logFile = Join-Path $jarvisDir "installation.log"
New-Item -ItemType Directory -Force $jarvisDir | Out-Null
"Jarvis-Installation $(Get-Date)" | Set-Content -Encoding UTF8 $logFile

# Falls Jarvis.bat ueber die (minimiert startende) Desktop-Verknuepfung kam: Fenster zeigen.
try {
    Add-Type -Namespace Jarvis -Name Win -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
    [void][Jarvis.Win]::ShowWindow([Jarvis.Win]::GetConsoleWindow(), 9)
} catch {}
try { $Host.UI.RawUI.WindowTitle = "Jarvis wird installiert" } catch {}

# ------------------------------------------------------------------ Anzeige

$total = 8
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
    Write-Host ($label.PadRight(44, ".")) -NoNewline -ForegroundColor Gray
    Add-Content -Encoding UTF8 $logFile "`n== $text"
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

# Startet ein Programm, zeigt solange eine kleine Animation mit der Zeit und schreibt
# alle Ausgaben ins Protokoll. Gibt den Exit-Code zurueck.
function Invoke-Quiet([string]$exe, [string[]]$arguments) {
    $out = Join-Path $jarvisDir "schritt-ausgabe.txt"
    $err = Join-Path $jarvisDir "schritt-fehler.txt"
    $quoted = $arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    $proc = Start-Process -FilePath $exe -ArgumentList $quoted -NoNewWindow -PassThru `
        -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $proc.Handle  # sonst liefert Windows PowerShell spaeter keinen Exit-Code
    $frames = @("(    )", "( .  )", "( .. )", "( ...)", "(  ..)", "(   .)")
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $i = 0
    while (-not $proc.WaitForExit(200)) {
        $time = "{0}:{1:00}" -f [int][math]::Floor($watch.Elapsed.TotalMinutes), $watch.Elapsed.Seconds
        Write-Host (" " + $frames[$i % $frames.Count] + " " + $time) -NoNewline -ForegroundColor Cyan
        Write-Host ("`b" * (8 + $time.Length)) -NoNewline
        $i++
    }
    $proc.WaitForExit()
    Write-Host (" " * 16) -NoNewline
    Write-Host ("`b" * 16) -NoNewline
    foreach ($file in @($out, $err)) {
        if (Test-Path $file) {
            Get-Content $file -ErrorAction SilentlyContinue | Add-Content -Encoding UTF8 $logFile
            Remove-Item $file -ErrorAction SilentlyContinue
        }
    }
    return $proc.ExitCode
}

function Show-LogTail {
    Write-Host ""
    Write-Host "  Letzte Zeilen aus dem Protokoll ($logFile):" -ForegroundColor DarkGray
    Get-Content $logFile -Tail 12 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

Show-Banner

# ------------------------------------------------------------------ 1. Python

Start-Step "Python suchen"
# Bevorzugt eine gut unterstuetzte Version. "py -3" nimmt sonst die neueste, und fuer
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

$python = Find-Python
if (-not $python) {
    Write-Warn "nicht gefunden"
    Write-Host ""
    Write-Host "  Jarvis braucht Python (kostenlos). Ich kann es jetzt automatisch installieren." -ForegroundColor White
    $answer = if ($Auto) { "j" } else { Read-Host "  Python 3.12 installieren? [J/n]" }
    if ($answer -notmatch '^(n|nein)$') {
        Write-Host "  Python wird installiert, das dauert etwa eine Minute ..." -ForegroundColor Cyan
        $ErrorActionPreference = "Continue"
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements --silent *>> $logFile
            $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
            $python = Find-Python
        }
        if (-not $python) {
            # Ohne winget (aeltere Windows 10): direkt von python.org, nur fuer diesen Benutzer
            $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
            $setup = Join-Path $env:TEMP "python-3.12-setup.exe"
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -UseBasicParsing "https://www.python.org/ftp/python/3.12.10/python-3.12.10-$arch.exe" -OutFile $setup
                $null = Invoke-Quiet $setup @("/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_launcher=1", "Include_test=0")
                Remove-Item $setup -ErrorAction SilentlyContinue
            } catch {
                Add-Content -Encoding UTF8 $logFile "Python-Download: $($_.Exception.Message)"
            }
            $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
            $python = Find-Python
        }
        $ErrorActionPreference = "Stop"
    }
    if (-not $python) {
        Write-Host ""
        Write-Host "  Bitte Python von https://www.python.org/downloads/ installieren" -ForegroundColor Red
        Write-Host "  (Haken bei 'Add python.exe to PATH' setzen) und Jarvis.bat noch einmal starten." -ForegroundColor Red
        exit 1
    }
    $script:step--
    Start-Step "Python suchen"
}
$ErrorActionPreference = "Continue"
$version = & $python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
$ErrorActionPreference = "Stop"
Write-Ok "Python $version"

# Heruntergeladene Dateien entsperren, sonst fragt Windows bei jedem Doppelklick nach.
Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.venv\\' } |
    Unblock-File -ErrorAction SilentlyContinue

# ------------------------------------------------------------------ 2. Umgebung

Start-Step "Eigene Python-Umgebung"
# Sie liegt (rund 1 GB) ausserhalb des Jarvis-Ordners, damit OneDrive sie nicht
# hochlaedt und beim Installieren keine Dateien sperrt.
if ($Neu -and (Test-Path $venvDir)) {
    Remove-Item -Recurse -Force $venvDir -ErrorAction SilentlyContinue
}
if (Test-Path $venvPy) {
    $ErrorActionPreference = "Continue"
    & $venvPy -c "import sys" 2>$null
    $venvOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = "Stop"
    if (-not $venvOk) { Remove-Item -Recurse -Force $venvDir -ErrorAction SilentlyContinue }
}
if (-not (Test-Path $venvPy)) {
    $code = Invoke-Quiet $python @("-m", "venv", $venvDir)
    if ($code -ne 0 -or -not (Test-Path $venvPy)) {
        Write-Fail "Die Python-Umgebung konnte nicht angelegt werden."
        Show-LogTail
        exit 1
    }
    Write-Ok "neu angelegt"
} else {
    Write-Ok "vorhanden"
}

# ------------------------------------------------------------------ 3. Pakete

Start-Step "Pakete (beim 1. Mal ein paar Minuten)"
$null = Invoke-Quiet $venvPy @("-m", "pip", "install", "--upgrade", "pip", "--disable-pip-version-check")
$code = Invoke-Quiet $venvPy @("-m", "pip", "install", "-r", "requirements.txt", "--disable-pip-version-check")
if ($code -ne 0) {
    Write-Fail "Die wichtigsten Pakete gingen nicht. Internet pruefen, alle Jarvis-Fenster schliessen und nochmal versuchen."
    Show-LogTail
    exit 1
}
Write-Ok

Start-Step "Oberflaeche und Extras"
$missing = @()
foreach ($line in Get-Content "requirements-extras.txt") {
    $package = $line.Trim()
    if (-not $package -or $package.StartsWith("#")) { continue }
    $code = Invoke-Quiet $venvPy @("-m", "pip", "install", $package, "--disable-pip-version-check")
    if ($code -ne 0) { $missing += $package }
}
if ($missing.Count -gt 0) {
    Write-Warn ("fehlt: " + ($missing -join ", ") + " (Jarvis laeuft trotzdem)")
} else {
    Write-Ok "Fenster, Tray-Symbol, Systemanzeige"
}

# Die alte Umgebung im Jarvis-Ordner wird nicht mehr gebraucht.
$oldVenv = Join-Path $root ".venv"
if (Test-Path $oldVenv) { Remove-Item -Recurse -Force $oldVenv -ErrorAction SilentlyContinue }
if (-not (Test-Path "config.toml")) { Copy-Item "config.example.toml" "config.toml" }

# ------------------------------------------------------------------ 4. Modelle

Start-Step "Hey-Jarvis-Erkennung laden"
$code = Invoke-Quiet $venvPy @("-c", "import openwakeword.utils as u; u.download_models(model_names=['hey_jarvis'])")
if ($code -eq 0) { Write-Ok } else { Write-Warn "laedt Jarvis beim ersten Start" }

Start-Step "Spracherkennung laden (500 MB)"
$code = Invoke-Quiet $venvPy @("-c", "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')")
if ($code -eq 0) { Write-Ok } else { Write-Warn "laedt Jarvis beim ersten Start" }

# ------------------------------------------------------------------ 5. Claude Code und Windows-Bausteine

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
if (Find-Claude) {
    Write-Ok "vorhanden"
} else {
    # Der offizielle Installer (ohne Administrator, ohne Node.js). Anmelden geht danach in der Einrichtung.
    # In einem eigenen PowerShell-Prozess: der Installer beendet sich bei Fehlern mit "exit".
    $ErrorActionPreference = "Continue"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $claudeSetup = Join-Path $env:TEMP "claude-install.ps1"
        Invoke-WebRequest -UseBasicParsing "https://claude.ai/install.ps1" -OutFile $claudeSetup
        $null = Invoke-Quiet "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $claudeSetup)
        Remove-Item $claudeSetup -ErrorAction SilentlyContinue
    } catch {
        Add-Content -Encoding UTF8 $logFile "Claude-Installer: $($_.Exception.Message)"
    }
    $ErrorActionPreference = "Stop"
    if (Find-Claude) { Write-Ok "installiert, anmelden in der Einrichtung" } else { Write-Warn "ging nicht, die Einrichtung hilft weiter" }
}

# Fuer Spracherkennung und Wake Word: die Microsoft-Laufzeit (auf fast jedem PC schon da)
$runtime = Join-Path $env:SystemRoot "System32\msvcp140.dll"
if (-not (Test-Path $runtime)) {
    Write-Host "  Die Microsoft-Laufzeit (Visual C++) fehlt, Windows fragt gleich einmal nach." -ForegroundColor Cyan
    $ErrorActionPreference = "Continue"
    try {
        $vc = Join-Path $env:TEMP "vc_redist.x64.exe"
        Invoke-WebRequest -UseBasicParsing "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vc
        Start-Process $vc -ArgumentList "/install", "/quiet", "/norestart" -Verb RunAs -Wait
        Remove-Item $vc -ErrorAction SilentlyContinue
    } catch {
        Add-Content -Encoding UTF8 $logFile "VC-Laufzeit: $($_.Exception.Message)"
    }
    $ErrorActionPreference = "Stop"
}

# ------------------------------------------------------------------ 6. Symbol

Start-Step "Symbol auf dem Desktop"
$icon = Join-Path $jarvisDir "jarvis.ico"
$null = Invoke-Quiet $venvPy @("-c", "import sys; from jarvis.tray import save_app_icon; save_app_icon(sys.argv[1])", $icon)
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
        Write-Ok "Desktop und Startmenue"
    } catch {
        Write-Warn "ging nicht ($($_.Exception.Message)). Jarvis.bat geht trotzdem."
    }
}

# Merken, womit installiert wurde. Jarvis.bat installiert nur neu, wenn sich das aendert.
Copy-Item "requirements.txt", "requirements-extras.txt" $jarvisDir -Force

# ------------------------------------------------------------------ Hinweise

$webviewKeys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
$webview2 = $webviewKeys | Where-Object { Test-Path $_ }
if (-not $webview2) {
    # Das Jarvis-Fenster braucht Microsoft Edge WebView2 (unter Windows 11 immer da, unter 10 meistens)
    Write-Host "  Fuer das Jarvis-Fenster wird Microsoft Edge WebView2 installiert ..." -ForegroundColor Cyan
    $ErrorActionPreference = "Continue"
    try {
        $wv = Join-Path $env:TEMP "MicrosoftEdgeWebview2Setup.exe"
        Invoke-WebRequest -UseBasicParsing "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $wv
        $null = Invoke-Quiet $wv @("/silent", "/install")
        Remove-Item $wv -ErrorAction SilentlyContinue
    } catch {
        Add-Content -Encoding UTF8 $logFile "WebView2: $($_.Exception.Message)"
    }
    $ErrorActionPreference = "Stop"
    if (-not ($webviewKeys | Where-Object { Test-Path $_ })) {
        Write-Host "  WebView2 fehlt noch: https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen Bootstrapper)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  Fertig. Jarvis ist installiert." -ForegroundColor Green
if ($Neu) {
    Write-Host "  Starte Jarvis mit dem Symbol auf dem Desktop." -ForegroundColor White
} elseif (Test-Path (Join-Path $root "daten\einrichtung-fertig.txt")) {
    Write-Host "  Jarvis startet gleich." -ForegroundColor White
} else {
    Write-Host "  Gleich oeffnet sich die Einrichtung. Ab jetzt startest du Jarvis mit dem Symbol auf dem Desktop." -ForegroundColor White
}
Write-Host ""
if (-not $Auto) { Start-Sleep -Seconds 2 }
exit 0
