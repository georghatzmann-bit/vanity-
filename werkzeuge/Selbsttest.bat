@echo off
rem Selbsttest: prueft alles und sagt, was zu tun ist (1 bis 2 Minuten).
call "%~dp0..\Jarvis.bat" --selftest %*
echo.
pause
