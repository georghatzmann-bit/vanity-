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

echo Jarvis prueft jetzt alles. Das dauert ein bis zwei Minuten.
echo.
"%PY%" -m jarvis --selftest %*
echo.
pause
