@echo off
title CrabMeat
echo.
echo === CrabMeat start ===
echo.

if not exist node_modules\ (
    echo ERROR: node_modules\ missing. Run install.bat first.
    pause
    exit /b 1
)

if not exist .env (
    echo ERROR: .env missing.
    echo Copy .env.example to .env and set CRABMEAT_TOKEN before launching.
    pause
    exit /b 1
)

if not exist crabmeat.json (
    echo ERROR: crabmeat.json missing.
    echo Run install.bat, or copy crabmeat.example.json to crabmeat.json.
    pause
    exit /b 1
)

if not exist dist\entry.js (
    echo dist\ not found - building from source...
    call npm run build
    if errorlevel 1 (
        echo.
        echo Build FAILED. See errors above.
        pause
        exit /b 1
    )
    echo Build OK.
    echo.
)

echo Starting gateway and chat in two windows...
echo Close either window to stop that piece.
echo If you edited source, run "npm run build" before relaunching.
echo.

REM Both processes load CRABMEAT_TOKEN and provider keys from .env
REM via entry.js (process.loadEnvFile). No token is stored in this file.
start "CrabMeat Gateway" cmd /k node dist\entry.js run
timeout /t 4 /nobreak >nul
start "CrabMeat Chat" cmd /k node dist\entry.js chat

echo Two windows launched. This window can be closed.
pause
