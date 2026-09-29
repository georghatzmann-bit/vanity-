# Richtet Jarvis auf Windows ein. Ausführen im Jarvis-Ordner:
#   powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== Jarvis Setup ==" -ForegroundColor Cyan

if (Get-Command py -ErrorAction SilentlyContinue) {
    function Invoke-Py { py -3 @args }
} else {
    function Invoke-Py { python @args }
}
$version = Invoke-Py -c "import sys; print('%d.%d' % sys.version_info[:2])"
if ([version]$version -lt [version]"3.11") {
    Write-Host "Python 3.11 oder neuer wird gebraucht (gefunden: $version)." -ForegroundColor Red
    Write-Host "Download: https://www.python.org/downloads/ (Haken bei 'Add to PATH' setzen)"
    exit 1
}

if (-not (Test-Path ".venv")) {
    Write-Host "Erstelle virtuelle Umgebung ..."
    Invoke-Py -m venv .venv
}
$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "Installiere Pakete ..."
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r requirements.txt

if (-not (Test-Path "config.toml")) {
    Copy-Item "config.example.toml" "config.toml"
    Write-Host "config.toml angelegt."
}

Write-Host "Lade das 'Hey Jarvis'-Modell ..."
& $venvPy -c "import openwakeword; openwakeword.utils.download_models(model_names=['hey_jarvis'])"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "Claude Code wurde nicht gefunden." -ForegroundColor Yellow
    Write-Host "Installieren:  irm https://claude.ai/install.ps1 | iex"
    Write-Host "Danach einmal 'claude' starten und mit deinem Pro-Konto anmelden."
}

Write-Host ""
Write-Host "Fertig! Starte Jarvis mit start.bat (oder start.bat --text zum Testen per Tastatur)." -ForegroundColor Green
