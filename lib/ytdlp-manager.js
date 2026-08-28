"use strict";

const fs = require("fs");
const path = require("path");
const { ensureRuntimeHome } = require('./runtime-home');
ensureRuntimeHome();
const { execSync } = require("child_process");
const YTDlpWrap = require("yt-dlp-wrap").default;
const ffmpegStatic = require("ffmpeg-static");
const fluentFfmpeg = require("fluent-ffmpeg");
const { logger } = require("../logger");

const isWin = process.platform === "win32";
const BIN_NAME = isWin ? "yt-dlp.exe" : "yt-dlp";
let BIN_PATH = path.join(__dirname, "..", BIN_NAME);

// On Linux (Railway), check system path first
if (!isWin && !fs.existsSync(BIN_PATH) && fs.existsSync("/usr/local/bin/yt-dlp")) {
  BIN_PATH = "/usr/local/bin/yt-dlp";
}

function setBinPath(nextPath) {
  if (!nextPath || nextPath === BIN_PATH) return BIN_PATH;
  BIN_PATH = nextPath;
  if (_ytdlp?.setBinaryPath) {
    _ytdlp.setBinaryPath(BIN_PATH);
  } else {
    _ytdlp = null;
  }
  _supportsJsRuntimes = null;
  _commonArgs = null;
  return BIN_PATH;
}

function resolveExistingBinary() {
  const os = require("os");
  const candidates = [
    BIN_PATH,
    path.join(process.cwd(), BIN_NAME),
    path.join(__dirname, "..", BIN_NAME),
    path.join(os.homedir(), "yt-dlp", BIN_NAME),
    path.join(os.homedir(), ".local", "bin", BIN_NAME),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return setBinPath(candidate);
    }
  }

  try {
    const found = execSync(isWin ? "where yt-dlp" : "which yt-dlp", {
      stdio: "pipe",
      timeout: 3000,
    })
      .toString()
      .trim()
      .split(/\r?\n/)[0]
      .trim();
    if (found && fs.existsSync(found)) {
      return setBinPath(found);
    }
  } catch {}

  return BIN_PATH;
}

let FFMPEG_PATH = null;
(function detectFfmpeg() {
  try {
    const found = execSync(isWin ? "where ffmpeg" : "which ffmpeg", {
      stdio: "pipe",
      timeout: 3000,
    })
      .toString()
      .trim()
      .split("\n")[0]
      .trim();
    if (found && fs.existsSync(found)) {
      FFMPEG_PATH = found;
      return;
    }
  } catch {}

  const candidates = isWin
    ? []
    : [
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/nix/store/6h39ipxhzp4r5in5g4rhdjz7p7fkicd0-replit-runtime-path/bin/ffmpeg",
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      FFMPEG_PATH = c;
      return;
    }
  }

  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    FFMPEG_PATH = ffmpegStatic;
  }
})();

if (FFMPEG_PATH) {
  fluentFfmpeg.setFfmpegPath(FFMPEG_PATH);
  logger(`[ffmpeg] Using: ${FFMPEG_PATH}`);
} else {
  logger("[ffmpeg] WARNING: ffmpeg not found — video compression disabled");
}

// Ensure python3 binary exists — yt-dlp requires it on some Linux environments
function _ensurePython3() {
  try {
    execSync('python3 --version', { stdio: 'pipe', timeout: 3000 });
    return; // already available
  } catch {}
  // Try python as fallback
  try {
    execSync('python --version', { stdio: 'pipe', timeout: 3000 });
    // Create a python3 symlink in ~/.local/bin
    const os = require('os');
    const localBin = path.join(os.homedir(), '.local', 'bin');
    if (!fs.existsSync(localBin)) fs.mkdirSync(localBin, { recursive: true });
    const symlink = path.join(localBin, 'python3');
    if (!fs.existsSync(symlink)) {
      const pythonPath = execSync('which python', { stdio: 'pipe' }).toString().trim();
      fs.symlinkSync(pythonPath, symlink);
      logger('[yt-dlp] Created python3 -> python symlink for yt-dlp compatibility');
    }
  } catch {}
}

function _binarySupportsJsRuntimes(binPath) {
  try {
    const help = execSync(`"${binPath}" --help`, {
      stdio: "pipe",
      timeout: 5000,
      encoding: "utf8",
    });
    return /--js-runtimes\b/.test(help);
  } catch {
    return false;
  }
}

async function _downloadLatestBinary() {
  if (isWin) return null;
  try {
    const os = require("os");
    const localBinDir = path.join(os.homedir(), ".local", "bin");
    const downloadPath = path.join(localBinDir, BIN_NAME);
    if (!fs.existsSync(localBinDir)) fs.mkdirSync(localBinDir, { recursive: true });
    const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
    execSync(`curl -fsSL "${url}" -o "${downloadPath}" 2>/dev/null || wget -q "${url}" -O "${downloadPath}"`, {
      stdio: "pipe",
      timeout: 120000,
      shell: "/bin/bash",
    });
    execSync(`chmod +x "${downloadPath}"`, { stdio: "pipe" });
    if (fs.existsSync(downloadPath)) return downloadPath;
  } catch (error) {
    logger(`[yt-dlp] Could not fetch latest binary: ${error.message}`);
  }
  return null;
}

async function ensureYtdlp() {
  resolveExistingBinary();

  if (fs.existsSync(BIN_PATH)) {
    if (!isWin && !_binarySupportsJsRuntimes(BIN_PATH)) {
      logger(`[yt-dlp] Found ${BIN_PATH} but it lacks --js-runtimes; pulling latest...`);
      const fresh = await _downloadLatestBinary();
      if (fresh) {
        setBinPath(fresh);
        logger(`[yt-dlp] Upgraded binary at: ${BIN_PATH}`);
      } else {
        logger(`[yt-dlp] Binary ready at: ${BIN_PATH}`);
      }
    } else {
      logger(`[yt-dlp] Binary ready at: ${BIN_PATH}`);
    }
    // Ensure python3 is available (yt-dlp needs it on some systems)
    if (!isWin) _ensurePython3();
    return true;
  }
  
  if (isWin) {
    logger("[yt-dlp] Binary missing — downloading...");
    try {
      const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
      execSync(`powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${BIN_PATH}'"`, { stdio: "pipe", timeout: 120000 });
      logger("[yt-dlp] Downloaded successfully");
      // On Windows, copy the binary to a path without spaces to avoid spawn issues
      try {
        const os = require("os");
        const altDir = path.join(os.homedir(), "yt-dlp");
        if (!fs.existsSync(altDir)) fs.mkdirSync(altDir, { recursive: true });
        const altPath = path.join(altDir, BIN_NAME);
        fs.copyFileSync(BIN_PATH, altPath);
        // prefer the alternate path if copy succeeded
        if (fs.existsSync(altPath)) {
          setBinPath(altPath);
          logger(`[yt-dlp] Copied binary to safe path: ${BIN_PATH}`);
        }
      } catch (copyErr) {
        logger(`[yt-dlp] Could not copy binary to alternate path: ${copyErr.message}`);
      }
      return true;
    } catch (err) {
      logger(`[yt-dlp] Download failed: ${err.message}`);
      return false;
    }
  }
  
  // Linux/macOS: Try to find yt-dlp in system PATH
  try {
    const found = execSync("which yt-dlp", { stdio: "pipe", timeout: 3000 })
      .toString()
      .trim();
    if (found && fs.existsSync(found)) {
      setBinPath(found);
      logger(`[yt-dlp] Found system binary at: ${BIN_PATH}`);
      return true;
    }
  } catch {}
  
  // Try to download yt-dlp to home directory
  logger("[yt-dlp] Binary missing — downloading to ~/.local/bin...");
  try {
    const os = require("os");
    const localBinDir = path.join(os.homedir(), ".local", "bin");
    const downloadPath = path.join(localBinDir, BIN_NAME);
    
    // Ensure directory exists
    if (!fs.existsSync(localBinDir)) {
      fs.mkdirSync(localBinDir, { recursive: true });
    }
    
    const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
    execSync(`curl -L "${url}" -o "${downloadPath}" 2>/dev/null || wget -q "${url}" -O "${downloadPath}"`, { 
      stdio: "pipe", 
      timeout: 120000,
      shell: "/bin/bash"
    });
    
    // Make executable
    execSync(`chmod +x "${downloadPath}"`, { stdio: "pipe" });
    
    if (fs.existsSync(downloadPath)) {
      setBinPath(downloadPath);
      logger(`[yt-dlp] Downloaded to: ${BIN_PATH}`);
      return true;
    }
  } catch (err) {
    logger(`[yt-dlp] Download attempt failed: ${err.message}`);
  }
  
  // Last resort: try pip install
  logger("[yt-dlp] Attempting pip install as fallback...");
  try {
    execSync("pip install -q yt-dlp 2>/dev/null", { stdio: "pipe", timeout: 60000 });
    const found = execSync("which yt-dlp", { stdio: "pipe", timeout: 3000 })
      .toString()
      .trim();
    if (found && fs.existsSync(found)) {
      setBinPath(found);
      logger(`[yt-dlp] Installed via pip at: ${BIN_PATH}`);
      return true;
    }
  } catch {}
  
  logger("[yt-dlp] ERROR: Could not obtain yt-dlp binary. Install with: pip install yt-dlp or apt install yt-dlp");
  return false;
}

let _ytdlp = null;
function getYtdlp() {
  resolveExistingBinary();
  if (!_ytdlp) _ytdlp = new YTDlpWrap(BIN_PATH);
  return _ytdlp;
}

function getBinPath() {
  return resolveExistingBinary();
}

let _commonArgs = null;
let _supportsJsRuntimes = null;

function _ytdlpSupportsJsRuntimes() {
  if (_supportsJsRuntimes !== null) return _supportsJsRuntimes;
  resolveExistingBinary();
  if (!fs.existsSync(BIN_PATH)) {
    _supportsJsRuntimes = false;
    return false;
  }
  _supportsJsRuntimes = _binarySupportsJsRuntimes(BIN_PATH);
  return _supportsJsRuntimes;
}

function getCommonArgs() {
  if (_commonArgs) return _commonArgs.slice();
  if (!_ytdlpSupportsJsRuntimes()) {
    _commonArgs = [];
    logger("[yt-dlp] --js-runtimes not supported by this binary — skipping");
    return _commonArgs.slice();
  }

  const candidates = [];
  if (process.execPath && fs.existsSync(process.execPath)) candidates.push(process.execPath);
  try {
    const found = execSync(isWin ? "where node" : "which node", {
      stdio: "pipe",
      timeout: 3000,
    }).toString().trim().split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) candidates.push(found);
  } catch {}

  const nodePath = candidates.find(Boolean);
  _commonArgs = nodePath ? ["--js-runtimes", `node:${nodePath}`] : [];
  if (_commonArgs.length) logger(`[yt-dlp] Using Node JS runtime at ${nodePath}`);
  return _commonArgs.slice();
}

module.exports = { ensureYtdlp, getYtdlp, getBinPath, getCommonArgs, FFMPEG_PATH, fluentFfmpeg };
