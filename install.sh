#!/usr/bin/env bash
# ==========================================================
#  CHATHU-MD V4 - Automated Linux VPS Installer Script
#  Supported OS: Ubuntu, Debian, CentOS, AlmaLinux, Rocky, Arch, Alpine
# ==========================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║          CHATHU-MD V4 AUTO INSTALLER FOR LINUX             ║"
echo "║         WhatsApp Multi-Device Automation Bot               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# 1. Check Root / Sudo
if [ "$EUID" -ne 0 ]; then
    echo -e "${YELLOW}[!] Note: Running as non-root user. Sudo will be used for system packages.${NC}"
    SUDO="sudo"
else
    SUDO=""
fi

# 2. Detect Package Manager
echo -e "${BLUE}[*] Detecting Linux Distribution...${NC}"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS=$(uname -s)
fi
echo -e "${GREEN}[✓] Detected OS: ${BOLD}$OS${NC}"

# 3. Update System & Install Core Utilities
echo -e "\n${BLUE}[*] Installing essential packages (git, curl, wget, ffmpeg, chromium)...${NC}"
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ] || [ "$OS" = "raspbian" ]; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y git curl wget ffmpeg build-essential ca-certificates libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libasound2 libpangocairo-1.0-0 libxss1 libgtk-3-0
    $SUDO apt-get install -y chromium-browser || $SUDO apt-get install -y chromium || true
elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    $SUDO yum update -y
    $SUDO yum install -y git curl wget ffmpeg gcc-c++ make ca-certificates nss atk at-spi2-atk cups-libs libgbm alsa-lib pango libXcomposite libXcursor libXdamage libXext libXi libXtst libXrandr libXScrnSaver
elif [ "$OS" = "arch" ] || [ "$OS" = "manjaro" ]; then
    $SUDO pacman -Syu --noconfirm git curl wget ffmpeg base-devel chromium nss atk at-spi2-atk libcups libgbm alsa-lib
elif [ "$OS" = "alpine" ]; then
    $SUDO apk update
    $SUDO apk add git curl wget ffmpeg build-base chromium nss freetype harfbuzz ca-certificates
fi
echo -e "${GREEN}[✓] System packages installed successfully!${NC}"

# 4. Check & Install Node.js 20+
echo -e "\n${BLUE}[*] Checking Node.js runtime...${NC}"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
    if [ "$NODE_VER" -ge 20 ]; then
        echo -e "${GREEN}[✓] Found Node.js $(node -v) (Meets requirements >=20.x)${NC}"
        NODE_OK=1
    fi
fi

if [ $NODE_OK -eq 0 ]; then
    echo -e "${YELLOW}[!] Installing Node.js 20.x LTS...${NC}"
    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
        $SUDO apt-get install -y nodejs
    elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
        $SUDO yum install -y nodejs
    elif [ "$OS" = "alpine" ]; then
        $SUDO apk add nodejs npm
    else
        echo -e "${RED}[X] Please install Node.js 20.x manually for your distro.${NC}"
    fi
    echo -e "${GREEN}[✓] Installed Node.js $(node -v)${NC}"
fi

# 5. Navigate to Bot Directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

# 6. Install Project Dependencies
echo -e "\n${BLUE}[*] Installing project NPM dependencies...${NC}"
npm install --loglevel=error
echo -e "${GREEN}[✓] NPM dependencies installed successfully!${NC}"

# 7. Install Puppeteer Chrome (for movie scraping on headless servers)
echo -e "\n${BLUE}[*] Setting up Puppeteer Headless Chrome...${NC}"
npx puppeteer browsers install chrome || true
echo -e "${GREEN}[✓] Headless Chrome configured!${NC}"

# 8. Download Linux yt-dlp binary
echo -e "\n${BLUE}[*] Checking yt-dlp binary for Linux...${NC}"
if [ ! -f "$SCRIPT_DIR/yt-dlp" ]; then
    echo -e "${YELLOW}[!] Downloading latest yt-dlp Linux binary...${NC}"
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$SCRIPT_DIR/yt-dlp"
    chmod a+rx "$SCRIPT_DIR/yt-dlp"
    echo -e "${GREEN}[✓] yt-dlp installed and permissions set!${NC}"
else
    chmod a+rx "$SCRIPT_DIR/yt-dlp"
    echo -e "${GREEN}[✓] yt-dlp binary is present and executable.${NC}"
fi

# 9. Install PM2 Globally
echo -e "\n${BLUE}[*] Installing PM2 Process Manager...${NC}"
$SUDO npm install -g pm2 --loglevel=error || npm install -g pm2 --loglevel=error
echo -e "${GREEN}[✓] PM2 installed successfully!${NC}"

# 10. Check Environment File (.env)
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo -e "\n${YELLOW}[!] Creating default .env configuration...${NC}"
    cat <<EOF > "$SCRIPT_DIR/.env"
PORT=5000
BOT_NAME="CHATHU-MD V4"
OWNER_NUMBER="94750382997"
PREFIX="."
MODE="public"
AUTO_READ="false"
AUTO_TYPING="false"
AUTO_VIEW_STATUS="true"
AUTO_REACT_STATUS="true"
SESSION_DIR="session"
DOWNLOAD_DIR="downloads"
EOF
    echo -e "${GREEN}[✓] Created .env file.${NC}"
fi

# Create required runtime directories
mkdir -p "$SCRIPT_DIR/downloads" "$SCRIPT_DIR/session" "$SCRIPT_DIR/sessions" "$SCRIPT_DIR/viewonce"

echo -e "\n${GREEN}${BOLD}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║          INSTALLATION COMPLETED SUCCESSFULLY!              ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "${CYAN}You can manage the bot using the following commands:${NC}"
echo -e "  ${BOLD}Start Bot (Foreground):${NC}  npm start"
echo -e "  ${BOLD}Start 24/7 (PM2):${NC}        pm2 start ecosystem.config.js"
echo -e "  ${BOLD}View Live Logs:${NC}          pm2 logs chathu-bot"
echo -e "  ${BOLD}Stop Bot:${NC}                pm2 stop chathu-bot"
echo -e "  ${BOLD}Restart Bot:${NC}             pm2 restart chathu-bot"
echo -e "  ${BOLD}Dashboard URL:${NC}           http://localhost:5000"
echo ""
