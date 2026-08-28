'use strict';
/**
 * Multi-Session Manager
 * Each session lives in sessions/<id>/ with its own Baileys socket.
 * The main bot.js session (session/) is separate and untouched.
 */

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { BROWSER, SESSIONS_DIR: SESSIONS_DIR_FROM_CONFIG } = require('./config');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { normalizeOwner } = require('./lib/utils');
const { installStreamingUpload } = require('./lib/baileys-streaming-upload');
const { resolveBaileysVersion } = require('./lib/baileys-compat');
const { classifyDisconnect, getReconnectDelay } = require('./lib/connection-recovery');
const { LRUCache } = require('lru-cache');

const sessionSignalKeyCaches = new Map();
function getSessionSignalKeyCache(sessionId) {
    if (!sessionSignalKeyCaches.has(sessionId)) {
        sessionSignalKeyCaches.set(sessionId, new LRUCache({
            max: 5000,
            ttl: 1000 * 60 * 60 * 24, // 24 hours
        }));
    }
    return sessionSignalKeyCaches.get(sessionId);
}

// `bot.js` already calls patchBaileysEncryption() at startup. The patch is
// idempotent and module-global, so re-importing here is harmless. We just
// need installStreamingUpload() per-socket.
const _streamingLogger = {
    info: (...a) => logger(...a),
    warn: (...a) => logger('[WARN]', ...a),
    debug: () => {},
};

const VALID_WORK_MODES = new Set(['public', 'private', 'self', 'group']);

function metadataPath(id) {
    return path.join(SESSIONS_DIR, id, 'metadata.json');
}

function saveMetadata(id, entry) {
    try {
        const data = {
            owner: entry.owner,
            workMode: entry.workMode,
            autoStatus: entry.autoStatus,
            disabledModules: entry.disabledModules,
            botEnabled: entry.botEnabled !== false,
            name: entry.name || null,
            prefix: entry.prefix || null,
            number: entry.number,
            processedCount: entry.processedCount || 0,
            commandsCount: entry.commandsCount || 0,
            autoRead: entry.autoRead,
            autoTyping: entry.autoTyping,
            autoReactStatus: entry.autoReactStatus,
            nsfwEnabled: entry.nsfwEnabled,
            autoReply: entry.autoReply,
            alwaysOnline: entry.alwaysOnline || false,
            antiCall: entry.antiCall || false,
            antiDelete: entry.antiDelete || false,
            autoBio: entry.autoBio || false,
            alwaysRecording: entry.alwaysRecording || false,
            autoViewStatus: entry.autoViewStatus || false,
            antiViewOnce: entry.antiViewOnce || false,
            privacyIgnoreGroups: entry.privacyIgnoreGroups || false,
            antiGroupJoin: entry.antiGroupJoin || false,
            aiAutoReply: entry.aiAutoReply || false,
            aiAutoVoice: entry.aiAutoVoice || false,
            aiAutoPersona: entry.aiAutoPersona || null,
            aiAutoLang: entry.aiAutoLang || null,
            aiGroupMode: entry.aiGroupMode || null,
            aiSystemInstruction: entry.aiSystemInstruction || '',
            aiMaxWords: entry.aiMaxWords || null,
            mentionReply: entry.mentionReply || '',
            privacyAutoCleanup: !!entry.privacyAutoCleanup,
            privacyMaxStorageMb: entry.privacyMaxStorageMb || 500,
            limits: entry.limits || {}
        };
        fs.writeFileSync(metadataPath(id), JSON.stringify(data, null, 2));
    } catch (e) {
        logger(`[Session ${id}] Failed to save metadata: ${e.message}`);
    }
}

function sessionSnapshot(id, s) {
    return {
        id,
        label: id,
        isMain: false,
        number: s.number || null,
        name: s.name || null,
        prefix: s.prefix || null,
        status: s.status,
        startedAt: s.startedAt,
        platform: s.platform || null,
        qrAvailable: !!s.qrDataUrl && s.status !== 'Connected',
        pairCode: s.pairCode || null,
        pairCodeExpiresAt: s.pairCodeExpiresAt || null,
        qrPaused: !!s.qrPaused,
        phoneNumber: s.phoneNumber || null,
        owner: s.owner || null,
        workMode: s.workMode || 'public',
        autoStatus: s.autoStatus !== false,
        botEnabled: s.botEnabled !== false,
        disabledModules: Array.isArray(s.disabledModules) ? s.disabledModules : [],
        processedCount: s.processedCount || 0,
        commandsCount: s.commandsCount || 0,
        autoRead: s.autoRead,
        autoTyping: s.autoTyping,
        autoReactStatus: s.autoReactStatus,
        nsfwEnabled: s.nsfwEnabled,
        autoReply: s.autoReply,
        alwaysOnline: s.alwaysOnline || false,
        antiCall: s.antiCall || false,
        antiDelete: s.antiDelete || false,
        autoBio: s.autoBio || false,
        alwaysRecording: s.alwaysRecording || false,
        autoViewStatus: s.autoViewStatus || false,
        antiViewOnce: s.antiViewOnce || false,
        antiGroupJoin: s.antiGroupJoin || false,
        aiAutoReply: s.aiAutoReply || false,
        aiAutoVoice: s.aiAutoVoice || false,
        aiAutoPersona: s.aiAutoPersona || null,
        aiAutoLang: s.aiAutoLang || null,
        aiGroupMode: s.aiGroupMode || null,
        aiSystemInstruction: s.aiSystemInstruction || '',
        aiMaxWords: s.aiMaxWords || null,
        mentionReply: s.mentionReply || '',
        privacyAutoCleanup: !!s.privacyAutoCleanup,
        privacyMaxStorageMb: s.privacyMaxStorageMb || 500,
        limits: s.limits || {},
        lastError: s.lastError || null,
        reconnectAttempts: s.reconnectAttempts || 0,
        connectedAt: s.connectedAt || null,
    };
}

function emitSessionUpdate(id, patch = {}) {
    const entry = registry.get(id);
    emit('session:update', { ...(entry ? sessionSnapshot(id, entry) : { id }), ...patch });
}

function loadMetadata(id) {
    try {
        const p = metadataPath(id);
        if (fs.existsSync(p)) {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
    } catch (e) {
        logger(`[Session ${id}] Failed to load metadata: ${e.message}`);
    }
    return {};
}
const { normalizeSriLankanPhoneNumber } = require('./lib/phone-normalizer');

const SESSIONS_DIR = SESSIONS_DIR_FROM_CONFIG || path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(SESSIONS_DIR, 0o700); } catch { /* Mounted filesystems may ignore chmod. */ }

// session registry: id → { sock, status, qr, pairCode, number, startedAt, phoneNumber }
const registry = new Map();
let _io = null;

const proTimers = new Map();
// Map<sessionId, Map<jid|id, msg>> with insertion-order eviction. Same
// rationale as bot.js#messageStore: O(1) lookup, O(1) eviction, ~10x less
// RAM than an unbounded array on multi-session deployments.
const SESSION_MESSAGE_CACHE_CAP = 200;
const messageStores = new Map();

function getSessionMessageStore(id) {
    let store = messageStores.get(id);
    if (!store) {
        store = new Map();
        messageStores.set(id, store);
    }
    return store;
}

function _sessionMsgCacheKey(jid, msgId) {
    return `${jid}|${msgId}`;
}

function cacheSessionMsg(id, msg) {
    if (!msg?.key?.remoteJid || !msg?.key?.id) return;
    const store = getSessionMessageStore(id);
    const key = _sessionMsgCacheKey(msg.key.remoteJid, msg.key.id);
    if (store.has(key)) {
        store.delete(key);
    } else if (store.size >= SESSION_MESSAGE_CACHE_CAP) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, msg);
}

function getCachedSessionMsg(id, jid, msgId) {
    if (!jid || !msgId) return null;
    const store = messageStores.get(id);
    if (!store) return null;
    return store.get(_sessionMsgCacheKey(jid, msgId)) || null;
}

function setProTimer(key, timer) {
    clearProTimer(key);
    proTimers.set(key, timer);
    if (typeof timer.unref === 'function') timer.unref();
}

function clearProTimer(key) {
    const timer = proTimers.get(key);
    if (timer) clearTimeout(timer);
    proTimers.delete(key);
}

function clearSessionProTimers(id) {
    for (const key of Array.from(proTimers.keys())) {
        if (key.startsWith(`${id}:`)) clearProTimer(key);
    }
}

function clearSessionRuntimeCaches(id) {
    clearSessionProTimers(id);
    messageStores.delete(id);
}

function getSessionFeature(entry, key, fallback = false) {
    const value = entry ? entry[key] : undefined;
    return value === undefined || value === null ? fallback : value;
}

async function applyOnlinePresence(id, entry, force = false) {
    if (!entry?.sock) return;
    const mode = getSessionFeature(entry, 'alwaysRecording', false)
        ? 'recording'
        : getSessionFeature(entry, 'alwaysOnline', false)
            ? 'available'
            : null;

    if (!mode) {
        clearProTimer(`${id}:presence`);
        if (force) await entry.sock.sendPresenceUpdate('unavailable').catch(() => {});
        return;
    }

    await entry.sock.sendPresenceUpdate(mode).catch((error) => {
        logger(`[Session ${id}] Presence update failed: ${error.message}`);
    });
    const timer = setTimeout(() => {
        applyOnlinePresence(id, entry).catch(() => {});
    }, 25000);
    setProTimer(`${id}:presence`, timer);
}

function getProfileStatusText(entry) {
    return `${entry.name || 'Chathu MD'} online • ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;
}

async function applyAutoBio(id, entry) {
    if (!entry?.sock || !getSessionFeature(entry, 'autoBio', false)) {
        clearProTimer(`${id}:autoBio`);
        return;
    }
    if (typeof entry.sock.updateProfileStatus === 'function') {
        await entry.sock.updateProfileStatus(getProfileStatusText(entry)).catch((error) => {
            logger(`[Session ${id}] Auto Bio update failed: ${error.message}`);
        });
    }
    const timer = setTimeout(() => {
        applyAutoBio(id, entry).catch(() => {});
    }, 10 * 60 * 1000);
    setProTimer(`${id}:autoBio`, timer);
}

function applyProFeatureLoops(id, entry) {
    applyOnlinePresence(id, entry, true).catch(() => {});
    applyAutoBio(id, entry).catch(() => {});
}

async function handleIncomingCall(id, entry, calls = []) {
    if (!entry?.sock || !getSessionFeature(entry, 'antiCall', false)) return;
    for (const call of calls || []) {
        if (!call?.id || !call?.from) continue;
        try {
            await entry.sock.rejectCall(call.id, call.from);
            logger(`[Session ${id}] Rejected incoming call from ${call.from}`);
        } catch (error) {
            logger(`[Session ${id}] Anti Call failed: ${error.message}`);
        }
    }
}

function shouldBlockGroupJoin(entry, update = {}) {
    if (!getSessionFeature(entry, 'antiGroupJoin', false)) return false;
    const action = update.action || update.type;
    if (!action || !['add', 'invite'].includes(String(action).toLowerCase())) return false;
    const botId = entry?.sock?.user?.id?.split(':')[0];
    const participants = Array.isArray(update.participants) ? update.participants : [];
    return participants.length > 0 && participants.some((jid) => botId && String(jid).startsWith(botId));
}

function getAntiDeleteConfig(entry) {
    const value = getSessionFeature(entry, 'antiDelete', false);
    if (!value) return null;
    if (typeof value === 'object') return value.enabled === false ? null : value;
    return value === true ? { enabled: true } : null;
}

function getAntiDeleteMessageKind(message = {}) {
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.stickerMessage) return 'sticker';
    if (message.documentMessage) return 'doc';
    return 'text';
}

async function handleAntiDelete(id, entry, key = {}) {
    if (!entry?.sock) return;
    const cfg = getAntiDeleteConfig(entry);
    if (!cfg) return;

    const cached = getCachedSessionMsg(id, key.remoteJid, key.id);
    if (!cached?.message || cached.key?.fromMe) return;

    const kind = getAntiDeleteMessageKind(cached.message);
    const filters = cfg.filters && typeof cfg.filters === 'object' ? cfg.filters : null;
    if (filters && filters[kind] === false) return;

    let destJid = cached.key.remoteJid;
    if (cfg.target === 'owner' && entry.owner) {
        const digits = String(entry.owner).replace(/\D/g, '');
        if (digits) destJid = `${digits}@s.whatsapp.net`;
    }

    const senderRaw = cached.key.participant || cached.key.remoteJid || '';
    const senderTag = senderRaw.split('@')[0] || 'unknown';
    const banner = `🛡 *Anti-Delete Recovery*\n👤 From: @${senderTag}\n🗑 Original chat: ${cached.key.remoteJid}\n⏱ ${new Date().toLocaleString()}`;

    await entry.sock.sendMessage(destJid, {
        text: banner,
        mentions: senderRaw && senderRaw.includes('@') ? [senderRaw] : [],
    }).catch((error) => logger(`[Session ${id}] Anti Delete banner failed: ${error.message}`));

    await entry.sock.relayMessage(destJid, cached.message, { messageId: cached.key.id }).catch(async (error) => {
        const text = cached.message.conversation || cached.message.extendedTextMessage?.text || '';
        if (text) {
            await entry.sock.sendMessage(destJid, { text: `📝 ${text}` }).catch(() => {});
        } else {
            logger(`[Session ${id}] Anti Delete relay failed (${kind}): ${error.message}`);
        }
    });
}

function setIO(io) { _io = io; }

function emit(event, data) {
    if (_io) _io.emit(event, data);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionDir(id) {
    return path.join(SESSIONS_DIR, String(id));
}

function listSessionIds() {
    try {
        return fs.readdirSync(SESSIONS_DIR).filter(f => {
            return fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory();
        });
    } catch { return []; }
}

function getAll() {
    return Array.from(registry.entries()).map(([id, s]) => sessionSnapshot(id, s));
}

function get(id) { return registry.get(id) || null; }

async function requestPairCodeInternal(id, cleaned, options = {}) {
    const {
        waitForSocket = true,
        retries = 4,
        retryDelayMs = 1500,
        socketWaitMs = 12000,
    } = options;

    const entry = registry.get(id);
    if (!entry) return { error: 'Session not found' };

    entry.pairMode = true;
    entry.phoneNumber = cleaned;
    entry.pairCode = null;
    entry.pairCodeExpiresAt = null;

    const waitUntil = Date.now() + socketWaitMs;
    while (waitForSocket && !entry.sock && Date.now() < waitUntil) {
        await delay(250);
    }

    if (!entry.sock) {
        return { error: 'Socket not ready yet. Please wait a moment and retry.' };
    }

    // Wait for the socket to have the requestPairingCode method available
    let methodReady = false;
    const methodCheckTimeout = Date.now() + 5000;
    while (!methodReady && Date.now() < methodCheckTimeout) {
        if (typeof entry.sock.requestPairingCode === 'function') {
            methodReady = true;
            break;
        }
        await delay(100);
    }

    // Check if requestPairingCode method exists
    if (!entry.sock || typeof entry.sock.requestPairingCode !== 'function') {
        return { error: 'Socket not fully initialized. Please wait and retry.' };
    }

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const formattedPhone = cleaned;
            const code = await entry.sock.requestPairingCode(formattedPhone);
            entry.pairCode = code;
            entry.pairCodeExpiresAt = Date.now() + 60000;
            entry.status = 'Awaiting Pair Code';
            emit('session:paircode', { id, code, expiresAt: entry.pairCodeExpiresAt });
            emit('session:update', { id, pairCode: code, pairCodeExpiresAt: entry.pairCodeExpiresAt, status: entry.status });
            logger(`[Session ${id}] Pair code requested for ${formattedPhone}: ${code}`);
            return { ok: true, code, expiresAt: entry.pairCodeExpiresAt };
        } catch (error) {
            lastError = error;
            logger(`[Session ${id}] Pair code attempt ${attempt}/${retries} failed: ${error.message}`);
            if (attempt < retries) {
                await delay(retryDelayMs);
            }
        }
    }

    return { error: lastError?.message || 'Failed to generate pair code' };
}

// ── Create / start a session ───────────────────────────────────────────────
async function createSession(id, opts = {}) {
    if (registry.has(id)) {
        const existing = registry.get(id);
        if (existing.status === 'Connected') return { error: 'Session already connected' };
        await destroySocket(id, { logout: false });
    }

    const normalizedPhone = opts.pairMode && opts.phone
        ? normalizeSriLankanPhoneNumber(opts.phone)
        : null;
    if (opts.pairMode && (!normalizedPhone || !normalizedPhone.ok)) {
        return { error: normalizedPhone?.error || 'Invalid phone number' };
    }

    // If session already exists, stop the old one first to avoid conflicts
    if (registry.has(id)) {
        const oldEntry = registry.get(id);
        if (oldEntry.sock) {
            try { oldEntry.sock.ev.removeAllListeners('connection.update'); } catch { }
            try { oldEntry.sock.ev.removeAllListeners('call'); } catch { }
            try { oldEntry.sock.ev.removeAllListeners('group-participants.update'); } catch { }
            try { oldEntry.sock.ev.removeAllListeners('messages.update'); } catch { }
            try { oldEntry.sock.ev.removeAllListeners('messages.upsert'); } catch { }
            try { oldEntry.sock.end(undefined); } catch { }
            oldEntry.sock = null;
        }
        clearSessionRuntimeCaches(id);
        registry.delete(id);
    }

    const dir = sessionDir(id);

    // For pair mode: always start fresh — stale creds cause "Couldn't link device"
    if (opts.pairMode && fs.existsSync(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const entry = {
        sock: null,
        status: 'Initializing',
        qr: null,
        qrDataUrl: null,
        pairCode: null,
        pairCodeExpiresAt: null,
        pairCodeRequested: false,
        number: null,
        startedAt: new Date().toISOString(),
        phoneNumber: normalizedPhone?.phone || null,
        name: null,
        pairMode: !!opts.pairMode,
        reconnectTimer: null,
        qrPaused: false,
        manualDisconnectKeep: false,
        // New management fields
        owner: normalizeOwner(opts.owner),
        workMode: 'public', // public or private
        autoStatus: true,
        botEnabled: true,
        disabledModules: [],
        processedCount: 0,
        commandsCount: 0,
        autoRead: null, // null means use global
        autoTyping: null,
        autoReactStatus: null,
        nsfwEnabled: null,
        autoReply: null,
        alwaysOnline: false,
        antiCall: false,
        antiDelete: false,
        autoBio: false,
        alwaysRecording: false,
        autoViewStatus: false,
        antiViewOnce: false,
        antiGroupJoin: false,
        aiAutoReply: null,
        aiAutoVoice: null,
        aiAutoPersona: null,
        aiAutoLang: null,
        aiGroupMode: null,
        aiSystemInstruction: '',
        aiMaxWords: null,
        mentionReply: '',
        isMain: false
    };
    registry.set(id, entry);
    emit('session:update', { id, status: 'Initializing' });

    await startSocket(id, entry);
    return { ok: true, id };
}

async function startSocket(id, entry) {
    try {
        const dir = sessionDir(id);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(dir, 0o700); } catch { /* Mounted filesystems may ignore chmod. */ }
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const version = await resolveBaileysVersion((message) => logger(`[Session ${id}][Baileys] ${message}`));

        let sock;
        const baileysConfig = {
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }), getSessionSignalKeyCache(id)),
            },
            browser: BROWSER,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: false,
            retryRequestDelayMs: 150,
            printQRInTerminal: false,
            cachedGroupMetadata: async (jid) => {
                if (!sock) return undefined;
                const { getGroupMetadataCached } = require('./lib/utils');
                return getGroupMetadataCached(sock, jid).catch(() => undefined);
            },
            getMessage: async (key) => {
                const msg = getCachedSessionMsg(id, key.remoteJid, key.id);
                return msg?.message || undefined;
            },
        };
        sock = makeWASocket(baileysConfig);

        // Streaming upload override per-socket — see lib/baileys-streaming-upload.js.
        installStreamingUpload(sock, baileysConfig, _streamingLogger);

        entry.sock = sock;
        entry.status = 'Connecting';
        sock.startTime = Math.floor(Date.now() / 1000);
        emit('session:update', { id, status: 'Connecting' });

        // Auto-request pair code immediately if pairMode is set
        if (entry.pairMode && entry.phoneNumber && !state.creds.registered) {
            const normalized = normalizeSriLankanPhoneNumber(entry.phoneNumber);
            const cleaned = normalized.ok ? normalized.phone : '';
            setTimeout(async () => {
                try {
                    const currentEntry = registry.get(id);
                    if (!currentEntry || currentEntry.status === 'Connected') return;
                    await requestPairCodeInternal(id, cleaned, { waitForSocket: true });
                } catch (e) {
                    logger(`[Session ${id}] Pair code auto-request failed: ${e.message}`);
                    emit('session:update', { id, pairCodeError: e.message });
                }
            }, 5000);
        }

        entry.qrAttempts = entry.qrAttempts || 0;

        sock.ev.on('connection.update', async (update) => {
            if (entry.sock !== sock && entry.status !== 'Initializing') return;
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // Skip QR if in pair mode (pair code was already requested)
                if (entry.pairMode) return;
                entry.qrAttempts = (entry.qrAttempts || 0) + 1;
                try {
                    entry.qr = qr;
                    const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
                    entry.qrDataUrl = dataUrl;
                    entry.status = 'Awaiting QR Scan';
                    emit('session:qr', { id, qr: dataUrl });
                    emit('session:update', { id, status: 'Awaiting QR Scan', qr: dataUrl });
                    logger(`[Session ${id}] QR generated (${entry.qrAttempts}/2)`);
                } catch (e) { logger(`[Session ${id}] QR error: ${e.message}`); }
                // Throttle: stop generating after 2 unscanned QRs
                if (entry.qrAttempts >= 2) {
                    logger(`[Session ${id}] QR pause: too many unscanned codes. Click "Reconnect" to retry.`);
                    entry.qrPaused = true;
                    entry.status = 'Idle (Paused)';
                    emit('session:update', { id, status: 'Idle (Paused)' });
                    clearSessionRuntimeCaches(id);
                    try { sock.ev.removeAllListeners('connection.update'); } catch { }
                    try { sock.ev.removeAllListeners('call'); } catch { }
                    try { sock.ev.removeAllListeners('group-participants.update'); } catch { }
                    try { sock.ev.removeAllListeners('messages.update'); } catch { }
                    try { sock.ev.removeAllListeners('messages.upsert'); } catch { }
                    try { sock.end(undefined); } catch { }
                    return;
                }
            }

            if (connection === 'close') {
                const recovery = classifyDisconnect(lastDisconnect);
                const code = recovery.code;
                const isBadMac = recovery.badMac;
                const loggedOut = recovery.loggedOut;

                if (isBadMac) {
                    logger(`[Session ${id}] Session credentials are corrupted (Bad MAC). Clearing only this session and waiting for relink.`);
                    clearSessionRuntimeCaches(id);
                    entry.sock = null;
                    try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch { }
                    entry.status = 'Relink Required';
                    entry.qrPaused = false;
                    entry.pairMode = false;
                    emit('session:update', { id, status: entry.status, requiresRelink: true });
                    return;
                }

                entry.sock = null;
                entry.status = loggedOut ? 'Logged Out' : 'Disconnected';
                entry.qr = null;
                entry.qrDataUrl = null;
                entry.pairCode = null;
                entry.pairCodeExpiresAt = null;
                if (entry.reconnectTimer) {
                    clearTimeout(entry.reconnectTimer);
                    entry.reconnectTimer = null;
                }
                emit('session:update', { id, status: entry.status });
                logger(`[Session ${id}] Closed (code ${code})`);

                if (!loggedOut && !entry.qrPaused) {
                    entry.reconnectAttempts = Math.min((entry.reconnectAttempts || 0) + 1, 8);
                    const reconnectDelay = getReconnectDelay(entry.reconnectAttempts);
                    logger(`[Session ${id}] Auto-reconnect scheduled in ${Math.ceil(reconnectDelay / 1000)}s.`);
                    entry.reconnectTimer = setTimeout(() => {
                        if (registry.has(id) && !registry.get(id).qrPaused) {
                            logger(`[Session ${id}] Auto-reconnecting...`);
                            startSocket(id, registry.get(id)).catch(e => logger(`[Session ${id}] Reconnect error: ${e.message}`));
                        }
                    }, reconnectDelay);
                } else if (loggedOut) {
                    if (entry.manualDisconnectKeep) {
                        entry.manualDisconnectKeep = false;
                        entry.status = 'Logged Out';
                        entry.qrPaused = false;
                        entry.pairMode = false;
                        entry.phoneNumber = null;
                        emit('session:update', { id, status: entry.status });
                    } else {
                        // Remove session dir on logout
                        registry.delete(id);
                        try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch { }
                        emit('session:removed', { id });
                    }
                }
            }

            if (connection === 'open') {
                const num = sock.user?.id?.split(':')[0] || sock.user?.id || 'Unknown';
                entry.number = num;
                entry.name = sock.user?.name || null;
                entry.status = 'Connected';
                entry.reconnectAttempts = 0;
                entry.qrAttempts = 0;
                entry.qrPaused = false;

                // Capture Device Metadata
                const device = sock.authState?.creds?.me?.platform || 'Unknown';
                const brand = sock.authState?.creds?.me?.deviceBrand || '';
                entry.platform = `${device}${brand ? ' (' + brand + ')' : ''}`;

                saveMetadata(id, entry);

                entry.qr = null;
                entry.qrDataUrl = null;
                entry.pairCode = null;
                emit('session:update', { id, status: 'Connected', number: num, platform: entry.platform });
                logger(`[Session ${id}] Connected as ${num} on ${entry.platform}`);

                // Sync groups for sub-session
                try {
                    const { syncGroups } = require('./bot');
                    if (syncGroups) await syncGroups(sock, id);
                } catch (e) {
                    logger(`[Session ${id}] Group sync failed: ${e.message}`);
                }
                applyProFeatureLoops(id, entry);
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('call', async (calls) => {
            await handleIncomingCall(id, entry, calls);
        });
        sock.ev.on('group-participants.update', async (update) => {
            if (!shouldBlockGroupJoin(entry, update)) return;
            entry.manualDisconnectKeep = true;
            entry.qrPaused = true;
            entry.status = 'Group Join Blocked';
            emit('session:update', { id, status: entry.status });
            await destroySocket(id, { logout: false });
        });

        sock.ev.on('messages.update', async (updates) => {
            try {
                for (const update of updates || []) {
                    const isRevoke = update?.update?.message === null
                        || update?.update?.messageStubType === 68
                        || update?.update?.messageStubType === 'REVOKE';
                    if (isRevoke) await handleAntiDelete(id, entry, update.key);
                }
            } catch (error) {
                logger(`[Session ${id}] Anti Delete update handler failed: ${error.message}`);
            }
        });

        sock.ev.on('messages.upsert', (m) => {
            for (const msg of m?.messages || []) {
                cacheSessionMsg(id, msg);
            }
            setImmediate(() => {
                let handleMessages;
                try { handleMessages = require('./bot').handleMessages; } catch (e) { }
                if (handleMessages) {
                    handleMessages(sock, m, id).catch((err) => {
                        logger(`[Session ${id}] Messages Upsert Error: ${err.message}`);
                    });
                }
            });
        });

    } catch (e) {
        logger(`[Session ${id}] Socket error: ${e.message}`);
        const entry = registry.get(id);
        if (entry) {
            entry.status = 'Error';
            emit('session:update', { id, status: 'Error', error: e.message });
        }
    }
}

// ── Request pair code ──────────────────────────────────────────────────────
// ── Request pair code internal logic ───────────────────────────────────────
async function requestPairCode(id, phoneNumber) {
    const entry = registry.get(id);
    if (!entry) return { error: 'Session not found' };
    if (entry.status === 'Connected') return { error: 'Already connected' };

    const normalized = normalizeSriLankanPhoneNumber(phoneNumber);
    if (!normalized.ok) {
        return { error: normalized.error };
    }

    return requestPairCodeInternal(id, normalized.phone);
}

// ── Remove / logout session ────────────────────────────────────────────────
async function destroySocket(id, options = {}) {
    const { logout = false } = options;
    const entry = registry.get(id);
    if (!entry) return;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    clearSessionRuntimeCaches(id);
    if (entry.sock) {
        if (logout) {
            try { await entry.sock.logout(); } catch { }
        }
        try { entry.sock.end(undefined); } catch { }
    }
    entry.sock = null;
}

async function removeSession(id) {
    await destroySocket(id, { logout: true });
    registry.delete(id);
    try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch { }
    emit('session:removed', { id });
    logger(`[Session ${id}] Removed`);
    return { ok: true };
}

// ── Auto-restore sessions on startup ──────────────────────────────────────
async function autoRestore() {
    const ids = listSessionIds();
    logger(`Session Manager: restoring ${ids.length} session(s)...`);
    for (const id of ids) {
        const meta = loadMetadata(id);
        const entry = {
            sock: null,
            status: 'Restoring',
            qr: null,
            qrDataUrl: null,
            pairCode: null,
            number: meta.number || null,
            name: meta.name || null,
            startedAt: new Date().toISOString(),
            phoneNumber: null,
            reconnectTimer: null,
            qrPaused: false,
            manualDisconnectKeep: false,
            owner: normalizeOwner(meta.owner),
            workMode: meta.workMode || 'public',
            autoStatus: meta.autoStatus !== false,
            botEnabled: meta.botEnabled !== false,
            disabledModules: meta.disabledModules || [],
            processedCount: meta.processedCount || 0,
            commandsCount: meta.commandsCount || 0,
            autoRead: meta.autoRead !== undefined ? meta.autoRead : null,
            autoTyping: meta.autoTyping !== undefined ? meta.autoTyping : null,
            autoReactStatus: meta.autoReactStatus !== undefined ? meta.autoReactStatus : null,
            nsfwEnabled: meta.nsfwEnabled !== undefined ? meta.nsfwEnabled : null,
            autoReply: meta.autoReply !== undefined ? meta.autoReply : null,
            alwaysOnline: meta.alwaysOnline || false,
            antiCall: meta.antiCall || false,
            antiDelete: meta.antiDelete || false,
            autoBio: meta.autoBio || false,
            alwaysRecording: meta.alwaysRecording || false,
            autoViewStatus: meta.autoViewStatus || false,
            antiViewOnce: meta.antiViewOnce || false,
            privacyIgnoreGroups: meta.privacyIgnoreGroups || false,
            antiGroupJoin: meta.antiGroupJoin || false,
            aiAutoReply: meta.aiAutoReply !== undefined ? meta.aiAutoReply : null,
            aiAutoVoice: meta.aiAutoVoice !== undefined ? meta.aiAutoVoice : null,
            aiAutoPersona: meta.aiAutoPersona || null,
            aiAutoLang: meta.aiAutoLang || null,
            aiGroupMode: meta.aiGroupMode || null,
            aiSystemInstruction: meta.aiSystemInstruction || '',
            aiMaxWords: meta.aiMaxWords || null,
            mentionReply: meta.mentionReply || '',
            privacyAutoCleanup: !!meta.privacyAutoCleanup,
            privacyMaxStorageMb: meta.privacyMaxStorageMb || 500,
            limits: meta.limits || {},
            isMain: false
        };
        registry.set(id, entry);
        await startSocket(id, entry).catch(e => logger(`[Session ${id}] Restore error: ${e.message}`));
        await new Promise(r => setTimeout(r, 500)); // stagger startup
    }
}

async function updateSessionSettings(id, settings) {
    const entry = registry.get(id);
    if (!entry) return { error: 'Session not found' };

    if (settings.workMode !== undefined) {
        const mode = String(settings.workMode).toLowerCase();
        if (!VALID_WORK_MODES.has(mode)) return { error: 'Invalid work mode' };
        entry.workMode = mode;
    }
    if (settings.autoStatus !== undefined) entry.autoStatus = !!settings.autoStatus;
    if (settings.botEnabled !== undefined) entry.botEnabled = !!settings.botEnabled;
    if (settings.name !== undefined) entry.name = typeof settings.name === 'string' ? settings.name.trim() : null;
    if (settings.prefix !== undefined) entry.prefix = typeof settings.prefix === 'string' ? settings.prefix.trim() : null;
    if (settings.disabledModules !== undefined) entry.disabledModules = Array.isArray(settings.disabledModules)
        ? settings.disabledModules.map((item) => String(item).toLowerCase()).filter(Boolean)
        : [];
    if (settings.owner !== undefined) entry.owner = require('./lib/utils').normalizeOwner(settings.owner);
    if (settings.autoRead !== undefined) entry.autoRead = settings.autoRead === null ? null : !!settings.autoRead;
    if (settings.autoTyping !== undefined) entry.autoTyping = settings.autoTyping === null ? null : !!settings.autoTyping;
    if (settings.autoReactStatus !== undefined) entry.autoReactStatus = settings.autoReactStatus === null ? null : !!settings.autoReactStatus;
    if (settings.nsfwEnabled !== undefined) entry.nsfwEnabled = settings.nsfwEnabled === null ? null : !!settings.nsfwEnabled;
    if (settings.autoReply !== undefined) entry.autoReply = settings.autoReply === null ? null : !!settings.autoReply;
    if (settings.alwaysOnline !== undefined) entry.alwaysOnline = !!settings.alwaysOnline;
    if (settings.antiCall !== undefined) entry.antiCall = !!settings.antiCall;
    if (settings.antiDelete !== undefined) entry.antiDelete = settings.antiDelete;
    if (settings.autoBio !== undefined) entry.autoBio = !!settings.autoBio;
    if (settings.alwaysRecording !== undefined) entry.alwaysRecording = !!settings.alwaysRecording;
    if (settings.autoViewStatus !== undefined) entry.autoViewStatus = !!settings.autoViewStatus;
    if (settings.antiViewOnce !== undefined) entry.antiViewOnce = !!settings.antiViewOnce;
    if (settings.antiGroupJoin !== undefined) entry.antiGroupJoin = !!settings.antiGroupJoin;
    if (settings.aiAutoReply !== undefined) entry.aiAutoReply = !!settings.aiAutoReply;
    if (settings.aiAutoVoice !== undefined) entry.aiAutoVoice = !!settings.aiAutoVoice;
    if (settings.aiAutoPersona !== undefined) entry.aiAutoPersona = String(settings.aiAutoPersona);
    if (settings.aiAutoLang !== undefined) entry.aiAutoLang = String(settings.aiAutoLang);
    if (settings.aiGroupMode !== undefined) entry.aiGroupMode = String(settings.aiGroupMode);
    if (settings.aiSystemInstruction !== undefined) entry.aiSystemInstruction = String(settings.aiSystemInstruction);
    if (settings.aiMaxWords !== undefined) entry.aiMaxWords = parseInt(settings.aiMaxWords) || 30;
    if (settings.mentionReply !== undefined) entry.mentionReply = String(settings.mentionReply);
    if (settings.privacyAutoCleanup !== undefined) entry.privacyAutoCleanup = !!settings.privacyAutoCleanup;
    if (settings.privacyMaxStorageMb !== undefined) entry.privacyMaxStorageMb = parseInt(settings.privacyMaxStorageMb) || 500;

    // --- Button Mode (per-session UI override) ---------------------------
    if (settings.buttonMode !== undefined) {
        const allowed = ['on', 'off', 'auto', 'button', 'list', 'text'];
        const val = settings.buttonMode === null ? null : String(settings.buttonMode).toLowerCase().trim();
        if (val === null) entry.buttonMode = null;
        else if (allowed.includes(val)) entry.buttonMode = val;
    }
    if (settings.roleMenuMode !== undefined) {
        const allowed = ['strict', 'relaxed', 'off'];
        const val = settings.roleMenuMode === null ? null : String(settings.roleMenuMode).toLowerCase().trim();
        if (val === null) entry.roleMenuMode = null;
        else if (allowed.includes(val)) entry.roleMenuMode = val;
    }
    
    if (settings.activeTheme !== undefined) {
        try {
            require('./lib/db').setSetting('active_theme', String(settings.activeTheme));
        } catch (e) {
            logger(`[Session ${id}] Failed to save global theme: ${e.message}`);
        }
    }

    saveMetadata(id, entry);
    if (settings.limits !== undefined && typeof settings.limits === 'object' && settings.limits) {
        entry.limits = {
            cmdPerMin: parseInt(settings.limits.cmdPerMin) || 0,
            aiPerMin: parseInt(settings.limits.aiPerMin) || 0,
            downloadCooldownSec: parseInt(settings.limits.downloadCooldownSec) || 0,
            maxConcurrentDownloads: parseInt(settings.limits.maxConcurrentDownloads) || 3,
            maxFileSizeMb: parseInt(settings.limits.maxFileSizeMb) || 100,
            broadcastDelayMs: parseInt(settings.limits.broadcastDelayMs) || 0,
            schedulerDelayMs: parseInt(settings.limits.schedulerDelayMs) || 0,
        };
    }
    if (settings.alwaysOnline !== undefined || settings.alwaysRecording !== undefined || settings.autoBio !== undefined || settings.name !== undefined) {
        applyProFeatureLoops(id, entry);
    }

    saveMetadata(id, entry);
    const session = sessionSnapshot(id, entry);
    emit('session:update', session);
    return { ok: true, session };
}

async function reconnectSession(id) {
    const entry = registry.get(id);
    if (!entry) return { error: 'Session not found' };
    if (entry.status === 'Connected') return { error: 'Already connected' };
    entry.qrAttempts = 0;
    entry.qrPaused = false;
    entry.status = 'Restarting';
    emit('session:update', { id, status: 'Restarting' });
    if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
    await destroySocket(id, { logout: false });
    await startSocket(id, entry);
    return { ok: true };
}

async function disconnectSession(id) {
    const entry = registry.get(id);
    if (!entry) return { error: 'Session not found' };

    entry.manualDisconnectKeep = true;
    entry.qrPaused = false;
    entry.qr = null;
    entry.qrDataUrl = null;
    entry.pairCode = null;
    entry.pairCodeExpiresAt = null;
    entry.pairMode = false;
    entry.phoneNumber = null;

    await destroySocket(id, { logout: true });

    try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch { }
    try { fs.mkdirSync(sessionDir(id), { recursive: true }); } catch { }

    entry.sock = null;
    entry.number = null;
    entry.platform = null;
    entry.status = 'Logged Out';
    emit('session:update', { id, status: entry.status });
    logger(`[Session ${id}] Disconnected and kept for relink.`);
    return { ok: true };
}

async function updateSessionMetrics(id, patch = {}) {
    const entry = registry.get(id);
    if (!entry) return;
    if (patch.processedCount !== undefined) entry.processedCount = patch.processedCount;
    if (patch.commandsCount !== undefined) entry.commandsCount = patch.commandsCount;
    saveMetadata(id, entry);
    emitSessionUpdate(id);
}

async function runRuntimeOp(id, op) {
    const entry = registry.get(id);
    if (!entry) return { error: 'Session not found' };
    if (op === 'clearError') {
        entry.lastError = null;
    } else if (op === 'clearQrPause') {
        entry.qrPaused = false;
        entry.qrAttempts = 0;
    } else if (op === 'clearPairCode') {
        entry.pairCode = null;
        entry.pairCodeExpiresAt = null;
    } else if (op === 'clearCache') {
        messageStores.delete(id);
        entry.lastError = null;
    } else if (op === 'syncGroups') {
        if (entry.sock && typeof entry.sock.groupFetchAllParticipating === 'function') {
            try { await entry.sock.groupFetchAllParticipating(); } catch { /* best-effort */ }
        }
    } else {
        return { error: 'Unknown op' };
    }
    saveMetadata(id, entry);
    const session = sessionSnapshot(id, entry);
    emit('session:update', session);
    return { ok: true, session };
}

function refreshRuntimeFeatures(id = null) {
    if (id) {
        const entry = registry.get(id);
        if (entry) applyProFeatureLoops(id, entry);
        return;
    }
    for (const [sessionId, entry] of registry.entries()) {
        applyProFeatureLoops(sessionId, entry);
    }
}

module.exports = {
    setIO,
    createSession,
    removeSession,
    disconnectSession,
    requestPairCode,
    reconnectSession,
    refreshRuntimeFeatures,
    runRuntimeOp,
    updateSessionSettings,
    updateSessionMetrics,
    getAll,
    get,
    autoRestore,
    SESSIONS_DIR,
};
