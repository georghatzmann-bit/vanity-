@echo off
rem ================================================================
rem  J.A.R.V.I.S.  -  Doppelklick genuegt.
rem  Beim ersten Mal wird alles installiert (ein paar Minuten), danach
rem  oeffnet sich die Einrichtung. Ab dann startet hier einfach Jarvis.
rem  Mit Optionen (z. B. Jarvis.bat --selftest) laeuft Jarvis in diesem
rem  Konsolenfenster. Kleine Helfer liegen im Ordner "werkzeuge".
rem ================================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set "JV=%LOCALAPPDATA%\Jarvis"
set "PY=%JV%\venv\Scripts\python.exe"
set "PYW=%JV%\venv\Scripts\pythonw.exe"

rem Installieren, wenn noch nichts da ist oder ein Update neue Pakete braucht.
set "INSTALL="
if not exist "%PY%" set "INSTALL=1"
fc /b "requirements.txt" "%JV%\requirements.txt" >nul 2>&1 || set "INSTALL=1"
fc /b "requirements-extras.txt" "%JV%\requirements-extras.txt" >nul 2>&1 || set "INSTALL=1"
if not defined INSTALL goto :starten
title Jarvis wird installiert
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0werkzeuge\installieren.ps1"
if errorlevel 1 goto :fehler

:starten
if "%~1"=="" goto :fenster
if /i "%~1"=="--einrichten" goto :fenster
"%PY%" -m jarvis %*
exit /b %ERRORLEVEL%

:fenster
rem Ohne Konsolenfenster (pythonw). Beim allerersten Start kommt die Einrichtung.
if not exist "%PYW%" set "PYW=%PY%"
start "" "%PYW%" -m jarvis %*
exit /b 0

:fehler
echo.
echo  Die Installation hat nicht geklappt. Die Meldungen oben sagen warum.
echo  Danach einfach Jarvis.bat noch einmal doppelklicken.
echo.
pause
exit /b 1
