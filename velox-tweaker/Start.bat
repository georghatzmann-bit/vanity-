@echo off
rem Startet VELOX (fragt nach Administratorrechten).
setlocal
title VELOX
cd /d "%~dp0"
if not exist "%~dp0core\Common.ps1" goto :nozip
set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PSEXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PSEXE%" goto :nops
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Velox.ps1" %*
set "RC=%ERRORLEVEL%"
rem 0 = ok, 2 = error already shown by VELOX
if "%RC%"=="0" goto :end
if "%RC%"=="2" goto :end
echo.
echo  VELOX wurde mit Fehlercode %RC% beendet.
echo  Details stehen im Log: %LOCALAPPDATA%\Velox\logs
echo.
pause
goto :end

:nozip
echo.
echo  VELOX: Der Ordner "core" fehlt neben dieser Datei.
echo  Bitte das ZIP zuerst komplett entpacken - Rechtsklick, "Alle extrahieren" -
echo  und dann Start.bat im entpackten Ordner starten.
echo.
pause
exit /b 1

:nops
echo.
echo  Windows PowerShell wurde nicht gefunden:
echo  %PSEXE%
echo.
pause
exit /b 1

:end
endlocal & exit /b %RC%
