# Richtet Jarvis auf Windows ein. Am einfachsten: setup.bat doppelklicken.
# Oder in PowerShell im Jarvis-Ordner:
#   powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== Jarvis Setup ==" -ForegroundColor Cyan

if (Get-Command py -ErrorAction SilentlyContinue) {
    function Invoke-Py { py -3 @args }
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    function Invoke-Py { python @args }
} else {
    Write-Host "Python wurde nicht gefunden." -ForegroundColor Red
    Write-Host "Download: https://www.python.org/downloads/ (Haken bei 'Add python.exe to PATH' setzen)"
    exit 1
}
$version = Invoke-Py -c "import sys; print('%d.%d' % sys.version_info[:2])"
if (-not $version -or [version]$version -lt [version]"3.11") {
    Write-Host "Python 3.11 oder neuer wird gebraucht (gefunden: $version)." -ForegroundColor Red
    Write-Host "Download: https://www.python.org/downloads/ (Haken bei 'Add python.exe to PATH' setzen)"
    exit 1
}
Write-Host "Python $version gefunden."

if ($PSScriptRoot -match "OneDrive") {
    Write-Host "Hinweis: Jarvis liegt in OneDrive. Das geht, aber OneDrive synchronisiert dann" -ForegroundColor Yellow
    Write-Host "tausende Dateien aus dem Ordner .venv. Schneller ist ein Ordner wie C:\Jarvis." -ForegroundColor Yellow
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Erstelle virtuelle Umgebung ..."
    Invoke-Py -m venv .venv
}
$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "Die virtuelle Umgebung konnte nicht angelegt werden." -ForegroundColor Red
    exit 1
}

Write-Host "Installiere Pakete (das dauert beim ersten Mal ein paar Minuten) ..."
& $venvPy -m pip install --upgrade pip --quiet
& $venvPy -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host "Die wichtigsten Pakete konnten nicht installiert werden (siehe Meldungen oben)." -ForegroundColor Red
    Write-Host "Internet pruefen und setup.bat noch einmal starten."
    exit 1
}
Write-Host "Installiere Extras (Oberflaeche, Tray-Icon, Systemanzeige) ..."
& $venvPy -m pip install -r requirements-extras.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host "Einige Extras gingen nicht. Jarvis laeuft trotzdem, notfalls ohne Fenster." -ForegroundColor Yellow
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
