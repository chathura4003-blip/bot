@echo off
chcp 65001 >nul
title CHATHU-MD V4 Auto Installer (Windows)
color 0b

echo.
echo ================================================================
echo           CHATHU-MD V4 WINDOWS AUTO INSTALLER
echo         WhatsApp Multi-Device Automation Bot
echo ================================================================
echo.

:: 1. Check Node.js
echo [*] Checking Node.js installation...
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0c
    echo.
    echo [X] Node.js is NOT installed on this computer!
    echo [!] Please download and install Node.js 20 LTS from:
    echo     https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo [OK] Found Node.js %NODE_VERSION%

:: 2. Check NPM
echo [*] Checking NPM...
where npm >nul 2>nul
if %errorlevel% neq 0 (
    color 0c
    echo [X] NPM is missing. Please reinstall Node.js.
    pause
    exit /b 1
)
echo [OK] NPM is ready.

:: 3. Create Required Folders
echo.
echo [*] Setting up directories...
if not exist "downloads" mkdir downloads
if not exist "session" mkdir session
if not exist "sessions" mkdir sessions
if not exist "viewonce" mkdir viewonce
echo [OK] Folders created.

:: 4. Check / Create .env
if not exist ".env" (
    echo [*] Creating default .env configuration...
    (
        echo PORT=5000
        echo BOT_NAME="CHATHU-MD V4"
        echo OWNER_NUMBER="94750382997"
        echo PREFIX="."
        echo WORK_MODE="public"
        echo AUTO_READ="false"
        echo AUTO_TYPING="false"
        echo AUTO_VIEW_STATUS="true"
        echo AUTO_REACT_STATUS="true"
        echo SESSION_DIR="session"
        echo DOWNLOAD_DIR="downloads"
    ) > .env
    echo [OK] Created .env file.
)

:: 5. Download yt-dlp.exe if missing
echo.
echo [*] Checking yt-dlp binary...
if not exist "yt-dlp.exe" (
    echo [!] Downloading yt-dlp.exe for Windows...
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -o yt-dlp.exe
    if %errorlevel% equ 0 (
        echo [OK] yt-dlp.exe downloaded successfully.
    ) else (
        echo [!] Warning: Could not download yt-dlp.exe automatically.
    )
) else (
    echo [OK] yt-dlp.exe already present.
)

:: 6. Install NPM Packages
echo.
echo [*] Installing NPM Dependencies (this may take 1-2 minutes)...
call npm install --no-audit --no-fund
if %errorlevel% neq 0 (
    color 0c
    echo [X] npm install encountered an error.
    pause
    exit /b 1
)
echo [OK] Dependencies installed successfully!

:: 7. Install Puppeteer Chrome
echo.
echo [*] Setting up Puppeteer Headless Chrome...
call npx puppeteer browsers install chrome >nul 2>nul
echo [OK] Chrome browser engine ready.

color 0a
echo.
echo ================================================================
echo          INSTALLATION COMPLETED SUCCESSFULLY!
echo ================================================================
echo.
echo You can now start the bot anytime by double-clicking 'start.bat'
echo or running 'npm start'.
echo.
set /p START_NOW="Do you want to start the bot now? (Y/N): "
if /i "%START_NOW%"=="Y" (
    cls
    call start.bat
) else (
    echo Goodbye!
    pause
)
