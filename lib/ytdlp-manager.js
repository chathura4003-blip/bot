"use strict";

const fs = require("fs");
const path = require("path");
const { ensureRuntimeHome } = require('./runtime-home');
ensureRuntimeHome();
const { execSync } = require("child_process");
const YTDlpWrap = require("yt-dlp-wrap").default;
const ffmpegStatic = require("ffmpeg-static");
const fluentFfmpeg = require("fluent-ffmpeg");
const axios = require("axios");
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

async function _downloadFileDirect(url, destPath) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tempPath = destPath + ".tmp." + Date.now();
  try {
    const res = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
      timeout: 180000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "*/*",
      },
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tempPath);
      res.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
      res.data.on("error", reject);
    });

    if (fs.existsSync(tempPath) && fs.statSync(tempPath).size >= 1024 * 1024) {
      if (fs.existsSync(destPath)) {
        try { fs.unlinkSync(destPath); } catch (_) {}
      }
      fs.renameSync(tempPath, destPath);
      if (!isWin) {
        try { fs.chmodSync(destPath, 0o755); } catch (_) {}
      }
      return true;
    }
  } catch (err) {
    logger(`[yt-dlp] Direct streaming download failed: ${err.message}`);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
  }
  return false;
}

async function _downloadLatestBinary() {
  const os = require("os");
  const targetDir = isWin
    ? path.join(__dirname, "..")
    : path.join(os.homedir(), ".local", "bin");
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const downloadPath = path.join(targetDir, BIN_NAME);
  const downloadUrl = isWin
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  // Tier 1: Pure Node.js Axios stream download (cross-platform, zero external dependencies)
  logger(`[yt-dlp] Downloading binary from GitHub...`);
  let success = await _downloadFileDirect(downloadUrl, downloadPath);
  if (success && fs.existsSync(downloadPath)) return downloadPath;

  // Tier 2: YTDlpWrap.downloadFromGithub
  try {
    logger(`[yt-dlp] Attempting YTDlpWrap.downloadFromGithub...`);
    await YTDlpWrap.downloadFromGithub(downloadPath);
    if (fs.existsSync(downloadPath) && fs.statSync(downloadPath).size >= 1024 * 1024) {
      if (!isWin) {
        try { fs.chmodSync(downloadPath, 0o755); } catch (_) {}
      }
      return downloadPath;
    }
  } catch (err) {
    logger(`[yt-dlp] YTDlpWrap download failed: ${err.message}`);
  }

  // Tier 3: Platform CLI download fallback
  try {
    if (isWin) {
      execSync(`powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('${downloadUrl}', '${downloadPath}')"`, {
        stdio: "pipe",
        timeout: 120000,
      });
    } else {
      execSync(`curl -fsSL "${downloadUrl}" -o "${downloadPath}" || wget -q "${downloadUrl}" -O "${downloadPath}"`, {
        stdio: "pipe",
        timeout: 120000,
      });
      execSync(`chmod +x "${downloadPath}"`, { stdio: "pipe" });
    }
    if (fs.existsSync(downloadPath) && fs.statSync(downloadPath).size >= 1024 * 1024) {
      return downloadPath;
    }
  } catch (err) {
    logger(`[yt-dlp] CLI download fallback failed: ${err.message}`);
  }

  // Tier 4: pip install fallback (with PEP 668 bypass)
  try {
    logger(`[yt-dlp] Attempting pip install as fallback...`);
    const pipCmds = [
      "python3 -m pip install --break-system-packages -q yt-dlp",
      "pip3 install --break-system-packages -q yt-dlp",
      "pip install -q yt-dlp",
    ];
    for (const cmd of pipCmds) {
      try {
        execSync(cmd, { stdio: "pipe", timeout: 60000 });
        const whichCmd = isWin ? "where yt-dlp" : "which yt-dlp";
        const found = execSync(whichCmd, { stdio: "pipe", timeout: 3000 })
          .toString()
          .trim()
          .split(/\r?\n/)[0]
          .trim();
        if (found && fs.existsSync(found)) {
          return found;
        }
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

async function ensureYtdlp() {
  resolveExistingBinary();

  if (fs.existsSync(BIN_PATH) && fs.statSync(BIN_PATH).size >= 1024 * 1024) {
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
    if (!isWin) _ensurePython3();
    return true;
  }

  // Binary is missing or broken - download now
  logger("[yt-dlp] Binary missing or invalid — acquiring yt-dlp binary...");
  const downloadedPath = await _downloadLatestBinary();
  if (downloadedPath && fs.existsSync(downloadedPath)) {
    setBinPath(downloadedPath);
    logger(`[yt-dlp] Binary ready at: ${BIN_PATH}`);

    // On Windows, also copy to alternate path without spaces if needed
    if (isWin) {
      try {
        const os = require("os");
        const altDir = path.join(os.homedir(), "yt-dlp");
        if (!fs.existsSync(altDir)) fs.mkdirSync(altDir, { recursive: true });
        const altPath = path.join(altDir, BIN_NAME);
        if (BIN_PATH !== altPath) {
          fs.copyFileSync(BIN_PATH, altPath);
          setBinPath(altPath);
          logger(`[yt-dlp] Copied binary to safe path: ${BIN_PATH}`);
        }
      } catch (_) {}
    }

    if (!isWin) _ensurePython3();
    return true;
  }

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
