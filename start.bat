@echo off
chcp 65001 >nul
title CHATHU-MD V4 Runner
color 0a

echo.
echo ================================================================
echo                    STARTING CHATHU-MD V4
echo ================================================================
echo.

:: Clean up any lingering zombie node processes on port 5000
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":5000 " ^| findstr "LISTENING"') do (
    echo [*] Clearing old process on port 5000 (PID: %%a)...
    taskkill /F /PID %%a >nul 2>nul
)

node --expose-gc --max-old-space-size=512 --max-semi-space-size=32 index.js

if %errorlevel% neq 0 (
    color 0c
    echo.
    echo [!] Bot stopped unexpectedly.
    pause
)
