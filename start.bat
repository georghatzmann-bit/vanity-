@echo off
cd /d "%~dp0"
chcp 65001 >nul
if not exist ".venv\Scripts\python.exe" (
    echo Bitte zuerst setup.ps1 ausfuehren ^(Rechtsklick ^> Mit PowerShell ausfuehren^).
    pause
    exit /b 1
)

rem Startet Jarvis mit Arc-Reactor-Fenster. Optionen: --text, --konsole, --silent,
rem --mic-test, --claude-test, --selftest, --autostart an/aus, -v
".venv\Scripts\python.exe" -m jarvis %*
if errorlevel 1 pause
