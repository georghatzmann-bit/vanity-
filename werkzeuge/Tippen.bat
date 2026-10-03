@echo off
rem Tippmodus: Jarvis ohne Mikrofon, Befehle eintippen.
call "%~dp0..\Jarvis.bat" --text %*
echo.
pause
