#!/usr/bin/env bash
# Quick start script for CHATHU-MD Bot
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

if command -v pm2 >/dev/null 2>&1; then
    echo "Starting CHATHU-MD with PM2 (24/7 background mode)..."
    pm2 start ecosystem.config.js
    pm2 logs chathu-bot
else
    echo "Starting CHATHU-MD in foreground mode..."
    npm start
fi
