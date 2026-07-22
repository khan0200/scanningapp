@echo off
title NAPS2 Web Hardware Scanner Server (Canon G3410 WIA/TWAIN)
echo Starting NAPS2 Web Hardware Scanner Backend on http://localhost:3000...
echo.

cd /d "%~dp0backend"
if not exist "node_modules\express" (
    echo Installing required Node.js dependencies (express, cors)...
    call npm install
)

start "" "http://localhost:3000"
node server.js
pause
