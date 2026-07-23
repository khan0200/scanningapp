@echo off
title Build Standalone Windows Executable (.exe)
echo ====================================================
echo  Building Scanning App Standalone EXE...
echo ====================================================
echo.

cd /d "%~dp0backend"

echo [1/3] Checking Node.js environment...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH. Please install Node.js.
    pause
    exit /b 1
)

echo [2/3] Installing backend dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo [3/3] Compiling standalone executable using pkg...
call npm run build:exe
if %errorlevel% neq 0 (
    echo [ERROR] Failed to package application.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo  SUCCESS: Standalone executable created!
echo  Location: %~dp0dist\scanningapp.exe
echo ====================================================
echo.
pause
