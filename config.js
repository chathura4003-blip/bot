"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}

const DEFAULT_ADMIN_PASS = "chathura123";
const DEFAULT_JWT_SECRET = "replace_this_jwt_secret_before_production";

function readInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

// ---- Persistent data directory --------------------------------------------
// Free hosts (Railway, Fly, Render, etc.) typically mount a persistent volume
// at a single configurable path. We honour DATA_DIR if set so all stateful
// files (db.json, WhatsApp session creds, downloaded files) live on the
// volume and survive deploys/restarts. When unset we fall back to the repo
// root so local development still "just works".
const DATA_DIR = (() => {
  const fromEnv = readString(process.env.DATA_DIR);
  const dir = fromEnv ? path.resolve(fromEnv) : __dirname;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Non-fatal: callers will surface a clearer error when they fail to
    // write into the directory.
  }
  return dir;
})();

const SESSION_DIR = readString(process.env.SESSION_DIR) || path.join(DATA_DIR, "session");
const DOWNLOAD_DIR = readString(process.env.DOWNLOAD_DIR) || path.join(DATA_DIR, "downloads");
const DB_PATH = readString(process.env.DB_PATH) || path.join(DATA_DIR, "db.json");
const SESSIONS_DIR = readString(process.env.SESSIONS_DIR) || path.join(DATA_DIR, "sessions");
const VIEWONCE_DIR = readString(process.env.VIEWONCE_DIR) || path.join(DATA_DIR, "viewonce");
const VIEWONCE_LOG_PATH = readString(process.env.VIEWONCE_LOG_PATH) || path.join(DATA_DIR, "viewonce-log.json");

// ---- Auto-provisioned JWT secret ------------------------------------------
// Free-host first-deploy UX: if JWT_SECRET is not provided we generate a
// strong random secret and persist it under the data dir so it stays stable
// across restarts. This keeps logged-in admins logged in (no surprise
// invalidation) while still being safer than the placeholder default.
function ensureJwtSecret() {
  const fromEnv = readString(process.env.JWT_SECRET);
  if (fromEnv) return fromEnv;
  const secretFile = path.join(DATA_DIR, ".jwt_secret");
  try {
    if (fs.existsSync(secretFile)) {
      const cached = fs.readFileSync(secretFile, "utf8").trim();
      if (cached) return cached;
    }
    const generated = crypto.randomBytes(48).toString("hex");
    try {
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    } catch {
      // Read-only filesystem — fall through and reuse generated for this run.
    }
    return generated;
  } catch {
    return crypto.randomBytes(48).toString("hex");
  }
}

const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const ADMIN_PASS = readString(process.env.ADMIN_PASS, isProduction ? '' : DEFAULT_ADMIN_PASS);
const JWT_SECRET = ensureJwtSecret();

module.exports = {
  BOT_NAME: process.env.BOT_NAME || "Chathu MD",
  OWNER_NUMBER: process.env.OWNER_NUMBER || "94742514900",
  PREFIX: process.env.PREFIX || ".",
  PORT: readInt(process.env.PORT, 5000),
  HOST: readString(process.env.HOST, "0.0.0.0"),
  ADMIN_USER: readString(process.env.ADMIN_USER, "admin"),
  ADMIN_PASS,
  JWT_SECRET,
  PREMIUM_CODE: process.env.PREMIUM_CODE || "CHATHU2026",
  DATA_DIR,
  SESSION_DIR,
  SESSIONS_DIR,
  DOWNLOAD_DIR,
  VIEWONCE_DIR,
  VIEWONCE_LOG_PATH,
  DB_PATH,
  // Identifies the bot in WhatsApp's "Linked devices" list. Matches the
  // triple Baileys' Browsers.macOS('Chrome') would produce, so the device
  // shows up as a Mac client instead of Ubuntu.
  BROWSER: ["Mac OS", "Chrome", "14.4.1"],
  SEARCH_CACHE_TTL: readInt(process.env.SEARCH_CACHE_TTL, 300000),
  DOWNLOAD_CACHE_TTL: readInt(process.env.DOWNLOAD_CACHE_TTL, 10 * 60 * 1000),
  AUTO_READ: String(process.env.AUTO_READ || "true").toLowerCase() !== "false",
  AUTO_READ_BOT: String(process.env.AUTO_READ_BOT || "true").toLowerCase() !== "false",
  AUTO_TYPING: String(process.env.AUTO_TYPING || "true").toLowerCase() !== "false",
  NSFW_ENABLED: String(process.env.NSFW_ENABLED || "true").toLowerCase() !== "false",
  WORK_MODE: process.env.WORK_MODE || "public",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  CLOUD_WORKER_URL: readString(process.env.CLOUD_WORKER_URL, ""),
  WORKER_SECRET: readString(process.env.WORKER_SECRET, ""),
  WORKER_ONLY: String(process.env.WORKER_ONLY || "false").toLowerCase() === "true",
  DEFAULT_ADMIN_PASS,
  DEFAULT_JWT_SECRET,
};
