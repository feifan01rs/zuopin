@echo off
chcp 65001 >nul
title 海风看球 · 本地服务
cd /d "%~dp0"

echo ============================================
echo   海风看球 - 赛程数据服务
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node 命令。
  echo 请先安装 Node.js 18 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo 正在启动服务，稍后会自动打开浏览器...
echo 关闭这个窗口 = 停止服务
echo.

start "" http://localhost:8787
node server.js

echo.
echo 服务已停止。
pause
