@echo off
title CrabMeat Install
echo.
echo === CrabMeat install ===
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not on PATH.
    echo Install Node 22 LTS from https://nodejs.org/ then re-run.
    pause
    exit /b 1
)

echo Node version:
node --version
echo.

echo Running npm install ^(first run: 1-3 min, plus playwright browser download^)...
echo.
call npm install
if errorlevel 1 (
    echo.
    echo npm install FAILED. See errors above.
    pause
    exit /b 1
)

echo.
if not exist crabmeat.json (
    if exist crabmeat.example.json (
        echo Creating crabmeat.json from crabmeat.example.json...
        copy /Y crabmeat.example.json crabmeat.json >nul
        if errorlevel 1 (
            echo WARNING: failed to copy crabmeat.example.json to crabmeat.json.
            echo You will need to create crabmeat.json manually before start.bat.
        )
    ) else (
        echo WARNING: crabmeat.example.json missing; cannot seed crabmeat.json.
    )
) else (
    echo crabmeat.json already present; leaving it untouched.
)

echo.
echo === Install complete. Run start.bat to launch CrabMeat. ===
pause