@echo off
rem Installiert alle Pakete neu. Hilft, wenn nach einem Update etwas fehlt oder kaputt ist.
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installieren.ps1" -Neu
echo.
pause
