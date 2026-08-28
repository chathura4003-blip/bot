@echo off
chcp 65001 >nul
title CHATHU-MD V4 Runner
color 0a

echo.
echo ================================================================
echo                    STARTING CHATHU-MD V4
echo ================================================================
echo.

node --expose-gc --max-old-space-size=2048 --max-semi-space-size=64 index.js

if %errorlevel% neq 0 (
    color 0c
    echo.
    echo [!] Bot stopped unexpectedly.
    pause
)
