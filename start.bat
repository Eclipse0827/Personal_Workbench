@echo off
rem ============================================================
rem  Huan Yi Huan launcher
rem
rem  IMPORTANT: this file is intentionally pure ASCII.
rem  cmd.exe parses batch files with the system ANSI code page
rem  (936 on Chinese Windows). Non-ASCII bytes get misread, and
rem  the script then breaks with "not recognized as a command".
rem  So the Chinese text lives in the Node app, not in here.
rem  "chcp 65001" makes the console UTF-8, which is exactly what
rem  Node writes -- that is why the app's own output displays
rem  Chinese correctly.
rem ============================================================

setlocal
title Huan Yi Huan
cd /d "%~dp0"

chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 goto no_node

echo.
echo   Starting Huan Yi Huan ...
echo   The browser will open by itself in a moment.
echo   To stop: close this window, or press Ctrl + C.
echo.

node "server\server.js" --open
if errorlevel 1 goto failed

echo.
echo   Server stopped.
echo.
pause
exit /b 0

:no_node
echo.
echo   [X] Node.js was not found on this computer.
echo.
echo   Install the LTS version from https://nodejs.org
echo   then double-click this file again.
echo.
pause
exit /b 1

:failed
echo.
echo   [X] The server did not start.
echo   The message above says what went wrong.
echo.
pause
exit /b 1
