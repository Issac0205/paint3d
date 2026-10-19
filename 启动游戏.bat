@echo off
chcp 65001 >nul
rem ------------------------------------------------------------
rem  paint3d launcher
rem  ES modules cannot load from file://, so we need a local HTTP
rem  server. server.js also speaks WebSocket, which is what online
rem  play uses. Falls back to Python (solo only) if Node is absent.
rem ------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PORT=8848"
set "URL=http://127.0.0.1:%PORT%/"

rem --- already running? just open the page ---
netstat -ano | findstr :%PORT% | findstr LISTENING >nul 2>nul
if not errorlevel 1 (
  start "" "%URL%"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 goto nonode

start "paint3d server - keep this window open" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" "%URL%"
exit /b 0

:nonode
echo.
echo   Node.js not found. Online play needs it.
echo   Starting the Python fallback: SOLO ONLY, no rooms.
echo.
where py >nul 2>nul
if errorlevel 1 (
  start "paint3d server" /min python -m http.server %PORT% --bind 127.0.0.1
) else (
  start "paint3d server" /min py -m http.server %PORT% --bind 127.0.0.1
)
timeout /t 2 /nobreak >nul
start "" "%URL%"
exit /b 0
