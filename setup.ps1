# Richtet Jarvis auf Windows ein. Am einfachsten: setup.bat doppelklicken.
# Oder in PowerShell im Jarvis-Ordner:
#   powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== Jarvis Setup ==" -ForegroundColor Cyan

# Bevorzugt eine gut unterstuetzte Python-Version. "py -3" nimmt sonst die neueste,
# und fuer ganz neue Versionen gibt es manche Pakete noch nicht.
# (Fehlermeldungen von "py" werden verschluckt. Das geht in Windows PowerShell nur mit
# ErrorActionPreference Continue, sonst bricht das Skript an der Umleitung ab.)
$pyArgs = $null
$ErrorActionPreference = "Continue"
if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($candidate in @("-3.13", "-3.12", "-3.11", "-3.14", "-3")) {
        $found = & py $candidate -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $found) { $pyArgs = @("py", $candidate); break }
    }
}
$ErrorActionPreference = "Stop"
if (-not $pyArgs -and (Get-Command python -ErrorAction SilentlyContinue)) {
    $pyArgs = @("python")
}
if (-not $pyArgs) {
    Write-Host "Python wurde nicht gefunden." -ForegroundColor Red
    Write-Host "Download: https://www.python.org/downloads/ (Haken bei 'Add python.exe to PATH' setzen)"
    exit 1
}
function Invoke-Py {
    if ($pyArgs.Count -gt 1) { & $pyArgs[0] $pyArgs[1] @args } else { & $pyArgs[0] @args }
}
$version = Invoke-Py -c "import sys; print('%d.%d' % sys.version_info[:2])"
if (-not $version -or [version]$version -lt [version]"3.11") {
    Write-Host "Python 3.11 oder neuer wird gebraucht (gefunden: $version)." -ForegroundColor Red
    Write-Host "Download: https://www.python.org/downloads/ (Haken bei 'Add python.exe to PATH' setzen)"
    exit 1
}
if ([version]$version -ge [version]"3.15") {
    Write-Host "Python $version ist noch zu neu, dafuer fehlen manche Pakete." -ForegroundColor Red
    Write-Host "Bitte zusaetzlich Python 3.13 installieren: https://www.python.org/downloads/"
    exit 1
}
Write-Host "Python $version gefunden."

# Heruntergeladene Dateien entsperren, sonst fragt Windows bei jedem Doppelklick nach.
Get-ChildItem -Path $PSScriptRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.venv\\' } |
    Unblock-File -ErrorAction SilentlyContinue

# Die Python-Umgebung (rund 1 GB) liegt ausserhalb des Jarvis-Ordners, damit OneDrive
# sie nicht hochlaedt und beim Installieren keine Dateien sperrt.
$venvDir = Join-Path $env:LOCALAPPDATA "Jarvis\venv"
$venvPy = Join-Path $venvDir "Scripts\python.exe"
if (Test-Path $venvPy) {
    $ErrorActionPreference = "Continue"
    & $venvPy -c "import sys" 2>$null
    $venvOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = "Stop"
    if (-not $venvOk) {
        Write-Host "Die Python-Umgebung ist kaputt und wird neu angelegt ..."
        Remove-Item -Recurse -Force $venvDir -ErrorAction SilentlyContinue
    }
}
if (-not (Test-Path $venvPy)) {
    Write-Host "Erstelle die Python-Umgebung in $venvDir ..."
    New-Item -ItemType Directory -Force (Split-Path $venvDir) | Out-Null
    Invoke-Py -m venv $venvDir
}
if (-not (Test-Path $venvPy)) {
    Write-Host "Die Python-Umgebung konnte nicht angelegt werden." -ForegroundColor Red
    exit 1
}

Write-Host "Installiere Pakete (das dauert beim ersten Mal ein paar Minuten) ..."
& $venvPy -m pip install --upgrade pip --quiet
& $venvPy -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host "Die wichtigsten Pakete konnten nicht installiert werden (siehe Meldungen oben)." -ForegroundColor Red
    Write-Host "Internet pruefen, alle Jarvis-Fenster schliessen und setup.bat noch einmal starten."
    exit 1
}
Write-Host "Installiere Extras (Oberflaeche, Tray-Icon, Systemanzeige) ..."
$missing = @()
foreach ($line in Get-Content "requirements-extras.txt") {
    $package = $line.Trim()
    if (-not $package -or $package.StartsWith("#")) { continue }
    & $venvPy -m pip install $package --quiet
    if ($LASTEXITCODE -ne 0) { $missing += $package }
}
if ($missing.Count -gt 0) {
    Write-Host ("Diese Extras gingen nicht: " + ($missing -join ", ") + ". Jarvis laeuft trotzdem.") -ForegroundColor Yellow
}

# Die alte Umgebung im Jarvis-Ordner wird nicht mehr gebraucht.
$oldVenv = Join-Path $PSScriptRoot ".venv"
if (Test-Path $oldVenv) {
    Remove-Item -Recurse -Force $oldVenv -ErrorAction SilentlyContinue
    if (-not (Test-Path $oldVenv)) { Write-Host "Alten Ordner .venv entfernt (liegt jetzt in $venvDir)." }
}

if (-not (Test-Path "config.toml")) {
    Copy-Item "config.example.toml" "config.toml"
    Write-Host "config.toml angelegt."
}

Write-Host "Lade das 'Hey Jarvis'-Modell ..."
& $venvPy -c "import openwakeword.utils as u; u.download_models(model_names=['hey_jarvis'])"

Write-Host "Lade die Spracherkennung (etwa 500 MB, nur beim ersten Mal) ..."
& $venvPy -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Die Spracherkennung laedt Jarvis dann beim ersten Start." -ForegroundColor Yellow
}

$webview2 = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
) | Where-Object { Test-Path $_ }
if (-not $webview2) {
    Write-Host ""
    Write-Host "Fuer das Jarvis-Fenster fehlt 'Microsoft Edge WebView2'." -ForegroundColor Yellow
    Write-Host "Download: https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen Bootstrapper)"
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "Claude Code wurde nicht gefunden." -ForegroundColor Yellow
    Write-Host "Installieren:  irm https://claude.ai/install.ps1 | iex"
    Write-Host "Danach einmal 'claude' starten und mit deinem Pro-Konto anmelden."
}

Write-Host ""
Write-Host "Fertig! Als Naechstes:" -ForegroundColor Green
Write-Host "  1. mikrofon.bat   Mikrofon auswaehlen"
Write-Host "  2. selbsttest.bat pruefen, ob alles geht"
Write-Host "  3. start.bat      Jarvis starten"
