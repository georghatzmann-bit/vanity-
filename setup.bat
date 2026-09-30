@echo off
cd /d "%~dp0"
echo Jarvis wird eingerichtet ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
