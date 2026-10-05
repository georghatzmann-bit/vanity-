@echo off
rem ==========================================================================
rem  BuildDuel starten - einfach doppelklicken
rem
rem  1. sucht Python (py, python, python3), sonst Node.js
rem  2. startet damit den kleinen Server aus dem Ordner tools
rem  3. der Server oeffnet den Browser mit http://localhost:8000
rem
rem  Dieses Fenster muss offen bleiben, solange du spielst.
rem ==========================================================================
setlocal
title BuildDuel - Server
cd /d "%~dp0"

echo.
echo  === BuildDuel wird gestartet ===
echo.

if not exist "index.html" goto :files_missing
if not exist "lib\three.module.js" goto :files_missing
if not exist "lib\three.core.js" goto :files_missing
if not exist "src\main.js" goto :files_missing
if not exist "tools\server.py" goto :files_missing
if not exist "tools\server.js" goto :files_missing

rem --- Python suchen. Wichtig: wirklich die Version abfragen. "python" kann
rem --- auch nur der Platzhalter aus dem Microsoft Store sein - der kann nichts
rem --- und meldet dann einen Fehler-Code.
py -3 --version >nul 2>&1
if %errorlevel%==0 goto :run_py

python --version >nul 2>&1
if %errorlevel%==0 goto :run_python

python3 --version >nul 2>&1
if %errorlevel%==0 goto :run_python3

rem --- Kein Python? Dann Node.js versuchen.
node --version >nul 2>&1
if %errorlevel%==0 goto :run_node

goto :nothing_found


:run_py
echo  [OK] Python gefunden.
py -3 "tools\server.py" %*
goto :server_stopped

:run_python
echo  [OK] Python gefunden.
python "tools\server.py" %*
goto :server_stopped

:run_python3
echo  [OK] Python gefunden.
python3 "tools\server.py" %*
goto :server_stopped

:run_node
echo  [OK] Node.js gefunden.
node "tools\server.js" %*
goto :server_stopped


:server_stopped
set "CODE=%errorlevel%"
rem Fehler-Code 3 = Python zu alt. Dann noch Node.js versuchen (falls da).
if not "%CODE%"=="3" goto :check_code
node --version >nul 2>&1
if %errorlevel%==0 goto :run_node

:check_code
echo.
if "%CODE%"=="0" goto :bye
echo  [FEHLER] Der Server wurde mit Fehler-Code %CODE% beendet.
echo  Lies die Meldung oben. Wenn du nicht weiterkommst: Screenshot an Claude.
echo.
pause
exit /b %CODE%

:bye
echo  Server beendet. Du kannst dieses Fenster schliessen.
echo.
pause
exit /b 0


:files_missing
echo  [FEHLER] Spiel-Dateien fehlen.
echo.
echo  start.bat muss im Ordner BuildDuel liegen, zusammen mit index.html
echo  und den Ordnern lib, src und tools.
echo.
echo  Tipp: Die ZIP-Datei zuerst komplett entpacken.
echo  Rechtsklick auf die ZIP-Datei, dann "Alle extrahieren".
echo  Direkt aus der ZIP heraus starten klappt nicht.
echo.
pause
exit /b 2


:nothing_found
echo  [FEHLER] Weder Python noch Node.js gefunden.
echo.
echo  So behebst du das - einmalig, dauert etwa 3 Minuten:
echo    1. Oeffne https://www.python.org/downloads/
echo    2. Klicke auf den gelben Knopf "Download Python".
echo    3. Starte die heruntergeladene Datei.
echo    4. WICHTIG: Unten im Fenster den Haken bei "Add python.exe to PATH" setzen.
echo    5. Auf "Install Now" klicken und warten, bis "Setup was successful" kommt.
echo    6. Danach start.bat nochmal doppelklicken.
echo.
set "OPEN="
set /p "OPEN=Python-Seite jetzt im Browser oeffnen? J = ja, N = nein: "
if /i "%OPEN%"=="J" start "" "https://www.python.org/downloads/"
echo.
pause
exit /b 1
