@echo off
cd /d "%~dp0"
chcp 65001 >nul
if not exist ".venv\Scripts\python.exe" (
    echo Bitte zuerst setup.ps1 ausfuehren ^(Rechtsklick ^> Mit PowerShell ausfuehren^).
    pause
    exit /b 1
)

echo Jarvis prueft jetzt alles. Das dauert ein bis zwei Minuten.
echo.
".venv\Scripts\python.exe" -m jarvis --selftest %*
echo.
pause
