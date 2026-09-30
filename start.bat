@echo off
cd /d "%~dp0"
chcp 65001 >nul
set "PY=%LOCALAPPDATA%\Jarvis\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
    echo Jarvis ist noch nicht eingerichtet. Bitte zuerst setup.bat doppelklicken.
    pause
    exit /b 1
)

rem Startet Jarvis mit Arc-Reactor-Fenster. Optionen: --text, --konsole, --silent,
rem --mic-test, --claude-test, --selftest, --autostart an/aus, -v
"%PY%" -m jarvis %*
if errorlevel 1 pause
