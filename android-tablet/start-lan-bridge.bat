@echo off
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，请先安装 Node.js 或把它加入 PATH。
  pause
  exit /b 1
)
echo 请先确认工作台服务已经在 5180 端口运行。
echo 这个窗口要保持开着，平板才能连上。
echo.
node android-tablet\lan-bridge.js
pause