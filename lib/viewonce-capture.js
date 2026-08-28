"use strict";

const fs = require("fs");
const path = require("path");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const db = require("./db");
const config = require("../config");

const VIEWONCE_DIR = config.VIEWONCE_DIR || path.join(process.cwd(), "viewonce");
const VIEWONCE_LOG_PATH = config.VIEWONCE_LOG_PATH || path.join(config.DATA_DIR || process.cwd(), "viewonce-log.json");

// Ensure save directory exists on load
if (!fs.existsSync(VIEWONCE_DIR)) {
    fs.mkdirSync(VIEWONCE_DIR, { recursive: true });
}

// Media types that can carry viewOnce
const MEDIA_TYPES = [
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
];

// Keys whose mere presence signals view-once
const VIEW_ONCE_WRAPPERS = [
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
];

/**
 * Detects if a message is View Once.
 *
 * 1. If the top-level message contains a viewOnceMessage / viewOnceMessageV2 /
 *    viewOnceMessageV2Extension wrapper, the inner media is treated as
 *    view-once regardless of whether the inner object has viewOnce === true.
 * 2. Falls back to checking media.viewOnce === true for any other layout.
 */
function isViewOnce(message) {
    if (!message || typeof message !== "object") return null;

    // 1. Check for known view-once wrapper keys first
    for (const wrapperKey of VIEW_ONCE_WRAPPERS) {
        const wrapper = message[wrapperKey];
        if (wrapper && typeof wrapper === "object") {
            const inner = wrapper.message || wrapper;
            if (inner && typeof inner === "object") {
                for (const type of MEDIA_TYPES) {
                    if (inner[type]) return { media: inner[type], type };
                }
                // Recurse deeper (e.g. ephemeralMessage wrapping viewOnce)
                const deeper = isViewOnce(inner);
                if (deeper) return deeper;
            }
        }
    }

    // 2. Direct media with viewOnce flag
    for (const type of MEDIA_TYPES) {
        const media = message[type];
        if (media && media.viewOnce === true) {
            return { media, type };
        }
    }

    // 3. Recurse into other wrapper objects (ephemeralMessage, etc.)
    for (const key of Object.keys(message)) {
        if (VIEW_ONCE_WRAPPERS.includes(key)) continue; // already handled
        const child = message[key];
        if (child && typeof child === "object") {
            const inner = child.message || child;
            if (inner !== message) {
                const found = isViewOnce(inner);
                if (found) return found;
            }
        }
    }

    return null;
}

// ---- Metadata log helpers --------------------------------------------------

function readLog() {
    try {
        if (fs.existsSync(VIEWONCE_LOG_PATH)) {
            return JSON.parse(fs.readFileSync(VIEWONCE_LOG_PATH, "utf8"));
        }
    } catch { /* corrupt / missing — start fresh */ }
    return [];
}

function writeLog(entries) {
    try {
        fs.writeFileSync(VIEWONCE_LOG_PATH, JSON.stringify(entries, null, 2));
    } catch (e) {
        console.error(`[ViewOnce] Failed to write log: ${e.message}`);
    }
}

function appendLogEntry(entry) {
    const log = readLog();
    log.push(entry);
    writeLog(log);
}

function removeLogEntry(filename) {
    const log = readLog().filter((e) => e.filename !== filename);
    writeLog(log);
}

function getViewOnceLog() {
    return readLog();
}

/** Map common mimetypes to file extensions. */
function getExtension(mimetype) {
    const map = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "audio/ogg": "ogg",
        "audio/mpeg": "mp3",
    };
    return map[mimetype] || "bin";
}

/**
 * Capture and save View Once media to disk.
 * Save-only: does NOT forward to inbox.
 *
 * @param {Object} sock  - Baileys socket instance
 * @param {Object} msg   - Raw message object from messages.upsert
 * @param {Object} [context] - Optional { sessionId }
 */
async function captureViewOnce(sock, msg, context = {}) {
    try {
        const content = msg.message;
        if (!content || msg.key?.fromMe) return;

        const viewOnceData = isViewOnce(content);
        if (!viewOnceData) return;

        const { media, type } = viewOnceData;
        const pushName = msg.pushName || "";
        const senderJid = msg.key.participant || msg.key.remoteJid || "unknown";
        const chatJid = msg.key.remoteJid || "";
        const sessionId = context.sessionId || "__main__";
        const sender = (pushName || senderJid)
            .split("@")[0]
            .replace(/[^\w]/g, "_");

        console.log(
            `[ViewOnce] Detected ${type} from ${sender}`
        );

        // Build a structure that downloadMediaMessage expects
        const downloadMsg = { key: msg.key, message: { [type]: media } };

        const buffer = await downloadMediaMessage(
            downloadMsg,
            "buffer",
            {},
            {
                logger: {
                    info: () => {},
                    error: (m) => console.error(`[ViewOnce] Download error: ${m}`),
                    warn: (m) => console.warn(`[ViewOnce] Download warning: ${m}`),
                    debug: () => {},
                    trace: () => {},
                },
            }
        );

        if (!buffer || buffer.length === 0) {
            console.error("[ViewOnce] Download failed: empty buffer");
            return;
        }

        const timestamp = Date.now();
        const ext = getExtension(media.mimetype);
        const filename = `${timestamp}_${sender}.${ext}`;
        const filePath = path.join(VIEWONCE_DIR, filename);

        fs.writeFileSync(filePath, buffer);
        console.log(`[ViewOnce] Saved: ${filename} (${buffer.length} bytes)`);

        const mediaCategory = type.replace("Message", "");
        appendLogEntry({
            filename,
            sender: pushName || senderJid.split("@")[0],
            senderJid,
            chatJid,
            sessionId,
            mediaType: mediaCategory,
            mimetype: media.mimetype || "",
            size: buffer.length,
            timestamp,
        });
    } catch (error) {
        console.error(`[ViewOnce] Error: ${error.message}`);
    }
}

// --- Toggle helpers (used by commands & dashboard) ---

function isAntiViewOnceEnabled(sessionId = "__main__") {
    return db.getSetting("anti_view_once") === true;
}

async function setAntiViewOnceEnabled(_sessionId, enabled) {
    db.setSetting("anti_view_once", !!enabled);
    return { status: true };
}

function isAntiViewOnceForwardEnabled(_sessionId = "__main__") {
    // Forwarding removed; always returns false
    return false;
}

async function setAntiViewOnceForward(_sessionId, _enabled) {
    // No-op: forwarding is disabled (save-only mode)
    return { status: true };
}

function getAntiDeleteConfig(_sessionId = "__main__") {
    const val = db.getSetting("antiDelete") || { enabled: false, target: "chat" };
    return typeof val === "object" ? val : { enabled: !!val, target: "chat" };
}

module.exports = {
    captureViewOnce,
    isAntiViewOnceEnabled,
    setAntiViewOnceEnabled,
    isAntiViewOnceForwardEnabled,
    setAntiViewOnceForward,
    getAntiDeleteConfig,
    getViewOnceLog,
    removeLogEntry,
    VIEWONCE_DIR,
};
