@echo off
rem Mikrofon-Test: zeigt alle Mikrofone, den Pegel und ob "Hey Jarvis" erkannt wird.
call "%~dp0..\Jarvis.bat" --mic-test %*
echo.
pause
