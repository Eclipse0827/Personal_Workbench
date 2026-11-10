@echo off
rem ============================================================
rem  Huan Yi Huan - daily launcher
rem
rem  Pure ASCII on purpose (see one-click.bat for why).
rem  Chinese messages come from scripts\install.js.
rem
rem  Same as: one-click.bat /no-browser ... but still runs the
rem  quick checks, so a broken download is reported in plain words.
rem ============================================================

setlocal
title Huan Yi Huan
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
echo   [X] The server did not start. The message above says why.
echo.
pause
exit /b 1
