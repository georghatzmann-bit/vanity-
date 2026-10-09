@echo off
rem Claude-Test: zeigt, welches Claude-Modell antwortet.
call "%~dp0..\Jarvis.bat" --claude-test %*
echo.
pause
