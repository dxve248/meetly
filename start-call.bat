@echo off
title Meetly
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install it from https://nodejs.org then run again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo Starting Meetly server...
echo The browser will open in a moment. Close this window to stop the server.
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js

pause