"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const LINUX_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/google-chrome-unstable",
  "/usr/lib/chromium/chromium",
];

const WINDOWS_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "Application", "msedge.exe"),
];

const MAC_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function findSystemChrome() {
  const platform = process.platform;
  let candidates = [];

  if (platform === "win32") {
    candidates = WINDOWS_CANDIDATES;
  } else if (platform === "darwin") {
    candidates = MAC_CANDIDATES;
  } else {
    candidates = LINUX_CANDIDATES;
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "string" && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Check puppeteer cache as fallback
  try {
    const cacheDir = path.join(os.homedir(), ".cache", "puppeteer");
    if (fs.existsSync(cacheDir)) {
      const findExecutable = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findExecutable(fullPath);
            if (found) return found;
          } else if (
            entry.name === "chrome.exe" ||
            entry.name === "chrome" ||
            entry.name === "chrome-headless-shell.exe" ||
            entry.name === "chrome-headless-shell"
          ) {
            return fullPath;
          }
        }
        return null;
      };
      const foundInCache = findExecutable(cacheDir);
      if (foundInCache) return foundInCache;
    }
  } catch (_) {}

  return null;
}

function getBrowserLaunchOptions(customOptions = {}) {
  const executablePath = customOptions.executablePath || findSystemChrome();
  const baseArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-zygote",
    "--disable-extensions",
    "--disable-software-rasterizer",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--mute-audio",
    "--js-flags=--max-old-space-size=128",
    "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "--disable-blink-features=AutomationControlled",
  ];

  const mergedArgs = Array.from(new Set([...baseArgs, ...(customOptions.args || [])]));

  const launchOpts = {
    headless: true,
    args: mergedArgs,
    ...customOptions,
  };

  if (executablePath) {
    launchOpts.executablePath = executablePath;
  }

  return launchOpts;
}

module.exports = {
  findSystemChrome,
  getBrowserLaunchOptions,
};
