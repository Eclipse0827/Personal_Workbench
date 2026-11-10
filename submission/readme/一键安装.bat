@echo off
rem ============================================================
rem  Huan Yi Huan - one-click install / environment check
rem
rem  This file is intentionally pure ASCII: cmd.exe parses batch
rem  files with the system ANSI code page (936 on Chinese Windows)
rem  and would misread non-ASCII bytes. All Chinese messages are
rem  printed by scripts\install.js instead (UTF-8 + chcp 65001).
rem
rem  Usage:
rem    one-click.bat                start on 5180, open browser
rem    one-click.bat /port=5200     use another port
rem    one-click.bat /no-browser    start without opening browser
rem    one-click.bat /check         check environment only
rem ============================================================

setlocal
title Huan Yi Huan - Setup
cd /d "%~dp0"

chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 goto no_node

node "%~dp0scripts\install.js" %*
if errorlevel 1 goto failed

exit /b 0

:no_node
echo.
echo   [X] Node.js was not found on this computer.
echo.
echo   Install the LTS version from https://nodejs.org
echo   then run this file again.
echo.
pause
exit /b 1

:failed
echo.
echo   [X] Setup did not finish. The message above says why.
echo.
pause
exit /b 1
