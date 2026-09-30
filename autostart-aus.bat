@echo off
cd /d "%~dp0"
chcp 65001 >nul
if not exist ".venv\Scripts\python.exe" (
    echo Bitte zuerst setup.ps1 ausfuehren ^(Rechtsklick ^> Mit PowerShell ausfuehren^).
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -m jarvis --autostart aus
pause
