'use strict';

const fs = require('fs');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { logger } = require('./logger');
const { loadCommands, handleCommand } = require('./lib/handler');
const { findAutoReply } = require('./lib/automation-runtime');
const { normalizeSriLankanPhoneNumber } = require('./lib/phone-normalizer');
const { BROWSER, SESSION_DIR } = require('./config');
const appState = require('./state');
const db = require('./lib/db');
const { getPrefix, getAutoRead, getAutoReadBot, getAutoTyping, getNsfwEnabled, getBotName, getAutoViewStatus, getAutoReactStatus } = require('./lib/runtime-settings');
const { captureViewOnce, isAntiViewOnceEnabled } = require('./lib/viewonce-capture');
const fleetCoordinator = require('./lib/fleet-coordinator');
fleetCoordinator._setDb(db);
const { patchBaileysEncryption, installStreamingUpload } = require('./lib/baileys-streaming-upload');
const { resolveBaileysVersion } = require('./lib/baileys-compat');
const { classifyDisconnect, getReconnectDelay } = require('./lib/connection-recovery');
const { cleanJid, canonicalSender, isOwner } = require('./lib/utils');
const { LRUCache } = require('lru-cache');

// High-speed in-memory LRU cache for E2EE PreKeys & Signal Keys (prevents disk reads on every message)
const signalKeyCache = new LRUCache({
    max: 10000,
    ttl: 1000 * 60 * 60 * 24, // 24 hours in-memory retention
});

// `logger` from ./logger is a plain function; the streaming-upload module
// wants an object with info/warn/debug methods, so wrap it.
const _streamingLogger = {
    info: (...a) => logger(...a),
    warn: (...a) => logger('[WARN]', ...a),
    debug: () => {},
};

// Install the disk-backed encryption patch ONCE, at module load. This
// reduces peak heap during media encryption from ~filesize to ~64 KB —
// see lib/baileys-streaming-upload.js for the rationale.
patchBaileysEncryption(_streamingLogger);

const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'whore', 'nigger'];

// Compact preview of a message body for [Skip]/[Drop] log lines so we
// never silently lose a command without an audit trail in the terminal.
function truncatePreview(text, max = 60) {
    if (!text) return '';
    const s = String(text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

// Map<key, msg> instead of an array. Replaces the old O(n) `find()` lookup
// with O(1) Map.get() and the O(n) `shift()` evict with the cheap "delete
// the oldest insertion" trick (Map preserves insertion order). The cap is
// also smaller (250 vs 1000) — Baileys' getMessage retry only ever asks
// for fairly recent ids so a smaller window is plenty and uses far less
// RAM under load.
const MESSAGE_CACHE_CAP = 250;
const messageStore = new Map();
const spamMap = new Map();

let activeSocket = null;
let reconnectTimer = null;
let startPromise = null;
const proTimers = new Map();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function _msgCacheKey(jid, id) {
    return `${jid}|${id}`;
}

function cacheMsg(msg) {
    if (!msg?.message || !msg?.key?.id) return;
    const key = _msgCacheKey(msg.key.remoteJid, msg.key.id);
    if (messageStore.has(key)) {
        messageStore.delete(key); // re-insert at the tail
    } else if (messageStore.size >= MESSAGE_CACHE_CAP) {
        // Map preserves insertion order, so the first key is the oldest.
        const oldest = messageStore.keys().next().value;
        if (oldest !== undefined) messageStore.delete(oldest);
    }
    messageStore.set(key, msg);
}

function getCachedMsg(jid, id) {
    return messageStore.get(_msgCacheKey(jid, id));
}

function getIO() {
    try {
        return require('./dashboard').io;
    } catch {
        return null;
    }
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
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

function clearSocketProTimers(sessionId) {
    for (const key of Array.from(proTimers.keys())) {
        if (key.startsWith(`${sessionId}:`)) clearProTimer(key);
    }
}

function getMainOverrides() {
    return db.getSetting('main_bot_settings') || {};
}

function getSessionFeature(sessionId, key, fallback = false) {
    if (sessionId === '__main__') {
        const value = getMainOverrides()[key];
        return value === undefined || value === null ? fallback : value;
    }

    try {
        const session = require('./session-manager').get(sessionId);
        const value = session ? session[key] : undefined;
        return value === undefined || value === null ? fallback : value;
    } catch {
        return fallback;
    }
}

function getProfileStatusText(sessionId) {
    const botName = sessionId === '__main__'
        ? (getMainOverrides().name || getBotName())
        : (getSessionFeature(sessionId, 'name', null) || getBotName());
    return `${botName} online • ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;
}

async function applyOnlinePresence(sock, sessionId, force = false) {
    if (!sock?.user) return; // Baileys requires user object to encode JID for presence

    const mode = getSessionFeature(sessionId, 'alwaysRecording', false)
        ? 'recording'
        : getSessionFeature(sessionId, 'alwaysOnline', false)
            ? 'available'
            : null;

    if (!mode) {
        clearProTimer(`${sessionId}:presence`);
        if (force) await sock.sendPresenceUpdate('unavailable').catch(() => { });
        return;
    }

    await sock.sendPresenceUpdate(mode).catch((error) => {
        logger(`[${sessionId}] Presence update failed: ${error.message}`);
    });
    const timer = setTimeout(() => {
        applyOnlinePresence(sock, sessionId).catch(() => { });
    }, 25000);
    setProTimer(`${sessionId}:presence`, timer);
}

async function applyAutoBio(sock, sessionId) {
    if (!getSessionFeature(sessionId, 'autoBio', false)) {
        clearProTimer(`${sessionId}:autoBio`);
        return;
    }
    if (typeof sock.updateProfileStatus === 'function') {
        await sock.updateProfileStatus(getProfileStatusText(sessionId)).catch((error) => {
            logger(`[${sessionId}] Auto Bio update failed: ${error.message}`);
        });
    }
    const timer = setTimeout(() => {
        applyAutoBio(sock, sessionId).catch(() => { });
    }, 10 * 60 * 1000);
    setProTimer(`${sessionId}:autoBio`, timer);
}

function applyProFeatureLoops(sock, sessionId) {
    applyOnlinePresence(sock, sessionId, true).catch(() => { });
    applyAutoBio(sock, sessionId).catch(() => { });
}

async function handleIncomingCall(sock, sessionId, calls = []) {
    if (!getSessionFeature(sessionId, 'antiCall', false)) return;
    for (const call of calls || []) {
        if (!call?.id || !call?.from) continue;
        try {
            await sock.rejectCall(call.id, call.from);
            logger(`[${sessionId}] Rejected incoming call from ${call.from}`);
        } catch (error) {
            logger(`[${sessionId}] Anti Call failed: ${error.message}`);
        }
    }
}

function refreshRuntimeFeatures(sessionId = '__main__') {
    const sock = sessionId === '__main__' ? activeSocket : null;
    if (sock) applyProFeatureLoops(sock, sessionId);
}

function shouldBlockGroupJoin(sessionId, update = {}) {
    if (!getSessionFeature(sessionId, 'antiGroupJoin', false)) return false;
    const action = update.action || update.type;
    if (!action || !['add', 'invite'].includes(String(action).toLowerCase())) return false;
    const botId = activeSocket?.user?.id?.split(':')[0];
    const participants = Array.isArray(update.participants) ? update.participants : [];
    return participants.length > 0 && participants.some((jid) => botId && String(jid).startsWith(botId));
}

function getAntiDeleteConfig(sessionId) {
    const value = getSessionFeature(sessionId, 'antiDelete', false);
    if (!value) return null;
    if (typeof value === 'object') {
        if (value.enabled === false) return null;
        return { ...value, target: value.target || 'chat' };
    }
    return value === true ? { enabled: true, target: 'chat' } : null;
}

function getAntiDeleteMessageKind(message = {}) {
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.stickerMessage) return 'sticker';
    if (message.documentMessage) return 'doc';
    return 'text';
}

async function handleAntiDelete(sock, sessionId, key = {}) {
    const cfg = getAntiDeleteConfig(sessionId);
    if (!cfg) return;

    if (cfg.ignoreGroups === true && key.remoteJid.endsWith('@g.us')) return;

    const cached = getCachedMsg(key.remoteJid, key.id);
    if (!cached?.message || cached.key?.fromMe) return;

    const kind = getAntiDeleteMessageKind(cached.message);
    const filters = cfg.filters && typeof cfg.filters === 'object' ? cfg.filters : null;
    if (filters && filters[kind] === false) return;

    let destJid = cached.key.remoteJid;
    const targetMode = String(cfg.target || 'chat').toLowerCase();

    if (targetMode === 'owner') {
        // Force routing ONLY to the bot's own "YOU" chat, ignoring all other owner settings
        const myId = sock?.user?.id;
        if (myId) {
            destJid = myId.split(':')[0] + '@s.whatsapp.net';
        } else {
            // Failsafe fallback only if bot ID is somehow missing
            destJid = appState.getOwner() || cached.key.remoteJid;
        }
    }

    logger(`[${sessionId}] Anti-Delete: mode=${targetMode} | routing from ${cached.key.remoteJid} to ${destJid}`);

    const senderRaw = cached.key.participant || cached.key.remoteJid || '';
    const senderTag = senderRaw.split('@')[0] || 'unknown';
    const banner = `🛡 *Anti-Delete Recovery*\n👤 From: @${senderTag}\n🗑 Original chat: ${cached.key.remoteJid}\n⏱ ${new Date().toLocaleString()}`;

    // Send banner first
    await sock.sendMessage(destJid, {
        text: banner,
        mentions: senderRaw && senderRaw.includes('@') ? [senderRaw] : [],
    }).catch((error) => logger(`[${sessionId}] Anti Delete banner failed: ${error.message}`));

    // Forward the message content
    try {
        await sock.sendMessage(destJid, { forward: cached }, { quoted: cached });
    } catch (error) {
        // Fallback for complex messages
        await sock.relayMessage(destJid, cached.message, { messageId: cached.key.id }).catch(async (err) => {
            const text = cached.message.conversation || cached.message.extendedTextMessage?.text || '';
            if (text) {
                await sock.sendMessage(destJid, { text: `📝 ${text}` }).catch(() => { });
            } else {
                logger(`[${sessionId}] Anti Delete recovery failed: ${err.message}`);
            }
        });
    }
}

function resetMainState(status = 'Disconnected') {
    appState.setSocket(null);
    appState.setStatus(status);
    appState.setNumber(null);
    appState.setConnectedAt(null);
    appState.setMainQr(null);
    appState.setMainPairCode(null);
    appState.setMainPairCodeExpiresAt(null);
}

function clearMainPairState() {
    appState.setMainPairMode(false);
    appState.setMainPairPhone(null);
    appState.setMainPairCode(null);
    appState.setMainPairCodeExpiresAt(null);
}

function configureMainPairState(phoneNumber) {
    appState.setMainPairMode(Boolean(phoneNumber));
    appState.setMainPairPhone(phoneNumber || null);
    appState.setMainPairCode(null);
    appState.setMainPairCodeExpiresAt(null);
}

async function requestMainPairCode(sock) {
    const phoneNumber = appState.getMainPairPhone();
    if (!sock || !phoneNumber || !appState.isMainPairMode()) return null;

    // Wait for the socket to have the requestPairingCode method available
    let methodReady = false;
    const methodCheckTimeout = Date.now() + 5000;
    while (!methodReady && Date.now() < methodCheckTimeout) {
        if (typeof sock.requestPairingCode === 'function') {
            methodReady = true;
            break;
        }
        await delay(100);
    }

    // Check if requestPairingCode method exists
    if (typeof sock.requestPairingCode !== 'function') {
        logger('[Main Bot] requestPairingCode method not available on socket. Please wait and retry.');
        return null;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const normalized = normalizeSriLankanPhoneNumber(phoneNumber);
            if (!normalized.ok) {
                throw new Error(normalized.error);
            }

            const formattedPhone = normalized.phone;
            const code = await sock.requestPairingCode(formattedPhone);
            const expiresAt = Date.now() + 60000;
            appState.setMainPairCode(code);
            appState.setMainPairCodeExpiresAt(expiresAt);
            appState.setStatus('Awaiting Pair Code');

            const io = getIO();
            if (io) {
                io.emit('session:paircode', { id: '__main__', code, expiresAt });
                io.emit('update', { status: 'Awaiting Pair Code', pairCode: code, pairCodeExpiresAt: expiresAt });
            }
            logger(`[Main Bot] Pair code generated for ${formattedPhone}: ${code}`);
            return code;
        } catch (error) {
            lastError = error;
            logger(`[Main Bot] Pair code attempt ${attempt}/4 failed: ${error.message}`);
            if (attempt < 4) {
                await delay(1500);
            }
        }
    }

    throw lastError || new Error('Failed to generate main pair code');
}

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(SESSION_DIR, 0o700); } catch { /* Some mounted filesystems ignore chmod. */ }
}

async function clearMainSessionCredentials() {
    try {
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
        ensureSessionDir();
    } catch (error) {
        logger(`Session Clear Error: ${error.message}`);
    }
}

async function stopBot(options = {}) {
    const {
        logout = false,
        clearCredentials = false,
        status = 'Disconnected'
    } = options;

    clearReconnectTimer();
    const socket = activeSocket;
    activeSocket = null;

    if (socket) {
        try { socket.ev.removeAllListeners('connection.update'); } catch { }
        try { socket.ev.removeAllListeners('creds.update'); } catch { }
        try { socket.ev.removeAllListeners('messages.upsert'); } catch { }
        try { socket.ev.removeAllListeners('messages.update'); } catch { }
        try { socket.ev.removeAllListeners('call'); } catch { }
        try { socket.ev.removeAllListeners('group-participants.update'); } catch { }
        try { socket.ev.removeAllListeners('error'); } catch { }
        if (logout) {
            try { await socket.logout(); } catch { }
        }
        try { socket.end(undefined); } catch { }
    }
    clearSocketProTimers('__main__');

    resetMainState(status);
    appState.resetQrAttempts();
    appState.setQrPaused(false);

    if (clearCredentials) {
        await clearMainSessionCredentials();
        clearMainPairState();
    }
}

function scheduleReconnect(delayMs = getReconnectDelay(appState.getReconnectAttempts?.() || 0)) {
    if (appState.isQrPaused()) return;
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startBot({ forceRestart: true }).catch((error) => {
            logger(`Reconnect Error: ${error.message}`);
            scheduleReconnect();
        });
    }, Math.max(1000, delayMs));
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
}

async function syncGroups(sock, sessionId = '__main__') {
    try {
        if (!sock.groupFetchAllFull) return;
        const groups = await sock.groupFetchAllFull();
        Object.entries(groups).forEach(([jid, metadata]) => {
            db.update('groups', jid, {
                name: metadata.subject,
                memberCount: metadata.participants?.length || 0,
                sessionId: sessionId || '__main__'
            });
        });
        logger(`[${sessionId}] Synced ${Object.keys(groups).length} groups to Dashboard.`);
    } catch (error) {
        logger(`[${sessionId}] Group Sync Error: ${error.message}`);
    }
}

async function createSocket(options = {}) {
    ensureSessionDir();
    loadCommands();

    const pairPhone = options.pairMode && options.phoneNumber
        ? normalizeSriLankanPhoneNumber(options.phoneNumber).phone || null
        : null;
    configureMainPairState(pairPhone);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const version = await resolveBaileysVersion((message) => logger(`[Baileys] ${message}`));

    logger(`Starting CHATHU MD (WhatsApp Web v${version.join('.')})`);
    appState.setStatus('Connecting');
    const io = getIO();
    if (io) io.emit('update', { status: 'Connecting' });

    let sock;
    const baileysConfig = {
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }), signalKeyCache),
        },
        browser: BROWSER,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        retryRequestDelayMs: 150,
        cachedGroupMetadata: async (jid) => {
            if (!sock) return undefined;
            const { getGroupMetadataCached } = require('./lib/utils');
            return getGroupMetadataCached(sock, jid).catch(() => undefined);
        },
        getMessage: async (key) => {
            const msg = getCachedMsg(key.remoteJid, key.id);
            return msg?.message || undefined;
        }
    };
    sock = makeWASocket(baileysConfig);

    // Replace the default in-memory waUploadToServer with the disk-backed,
    // streaming version. Combined with the encryption patch installed at
    // module load, this keeps peak heap bounded regardless of media size.
    installStreamingUpload(sock, baileysConfig, _streamingLogger);

    activeSocket = sock;
    appState.setSocket(sock);

    // Set start time immediately to ignore backlog messages processed before "open" state
    sock.startTime = Math.floor(Date.now() / 1000);

    sock.ev.on('connection.update', async (update) => {
        if (sock !== activeSocket) return;

        try {
            const { connection, lastDisconnect, qr } = update;
            const dashboardIO = getIO();

            if (qr) {
                if (appState.isMainPairMode()) {
                    logger('[Main Bot] QR received during pair mode; waiting for phone-number linking instead.');
                    return;
                }
                const attempts = appState.incQrAttempts();
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                appState.setMainQr(qrDataUrl);
                appState.setStatus('Awaiting QR Scan');
                if (dashboardIO) {
                    dashboardIO.emit('qr', qrDataUrl);
                    dashboardIO.emit('update', { status: 'Awaiting QR Scan' });
                }
                logger(`[Main Bot] QR generated (${attempts}/2). Scan with WhatsApp.`);

                if (attempts >= 2) {
                    logger('[Main Bot] QR pause: too many unscanned codes. Click "Reconnect" to retry.');
                    appState.setQrPaused(true);
                    await stopBot({ status: 'Idle (Paused)' });
                }
                return;
            }

            if (connection === 'open') {
                clearReconnectTimer();
                logger('[Main Bot] Connected.');
                sock.startTime = Math.floor(Date.now() / 1000); // Refresh start time on open
                appState.setStatus('Connected');
                appState.resetQrAttempts();
                appState.setQrPaused(false);
                appState.setConnectedAt(new Date().toISOString());
                appState.setMainQr(null);
                appState.setMainPairCode(null);
                appState.setMainPairCodeExpiresAt(null);
                appState.setMainPairMode(false);
                appState.setMainPairPhone(null);

                const number = sock.user?.id?.split(':')[0] || sock.user?.id || 'Unknown';
                appState.setNumber(number);
                appState.setPushName(sock.user?.name || null);

                if (dashboardIO) {
                    dashboardIO.emit('update', { status: 'Connected', number });
                }

                await syncGroups(sock, '__main__');
                applyProFeatureLoops(sock, '__main__');
                return;
            }

            if (connection === 'close') {
                const recovery = classifyDisconnect(lastDisconnect);
                const statusCode = recovery.code;
                const reason = recovery.message;
                const loggedOut = recovery.loggedOut;

                if (loggedOut) {
                    logger(`[Main Bot] Logged out (${statusCode}). Clearing session and waiting for relink.`);
                    await stopBot({ status: 'Logged Out', clearCredentials: true });
                    return;
                }

                if (recovery.replaced) {
                    logger('[Main Bot] Session replaced by another client.');
                    await stopBot({ status: 'Session Replaced' });
                    return;
                }

                logger(`[Main Bot] Connection closed (${statusCode || 'n/a'}): ${reason}.`);
                await stopBot({ status: appState.isQrPaused() ? 'Idle (Paused)' : 'Disconnected' });
                if (dashboardIO) {
                    dashboardIO.emit('update', { status: 'Reconnecting...' });
                }
                scheduleReconnect();
            }
        } catch (error) {
            logger(`Connection Update Error: ${error.message}`);
        }
    });

    sock.ev.on('error', (error) => {
        if (sock !== activeSocket) return;
        logger(`Socket Error: ${error.message}`);
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('call', async (calls) => {
        if (sock !== activeSocket) return;
        await handleIncomingCall(sock, '__main__', calls);
    });
    sock.ev.on('group-participants.update', async (update) => {
        if (sock !== activeSocket || !shouldBlockGroupJoin('__main__', update)) return;
        await stopBot({ status: 'Group Join Blocked' });
    });
    sock.ev.on('messages.update', async (updates) => {
        if (sock !== activeSocket) return;
        try {
            for (const update of updates || []) {
                const isRevoke = update?.update?.message === null
                    || update?.update?.messageStubType === 68
                    || update?.update?.messageStubType === 'REVOKE';
                if (isRevoke) await handleAntiDelete(sock, '__main__', update.key);
            }
        } catch (error) {
            logger(`[__main__] Anti Delete update handler failed: ${error.message}`);
        }
    });
    sock.ev.on('messages.upsert', async (messageUpdate) => {
        if (sock !== activeSocket) return;
        await handleMessages(sock, messageUpdate);
    });

    if (pairPhone && !state.creds.registered) {
        appState.setStatus('Preparing Pair Code');
        if (io) {
            io.emit('update', { status: 'Preparing Pair Code' });
        }
        setTimeout(() => {
            if (sock !== activeSocket || !appState.isMainPairMode()) return;
            requestMainPairCode(sock).catch(() => { });
        }, 5000);
    }

    return sock;
}

async function startBot(options = {}) {
    const { forceRestart = false, clearCredentials = false, pairMode = false, phoneNumber = '' } = options;
    const shouldClearCredentials = clearCredentials || pairMode;

    if (startPromise) {
        return startPromise;
    }

    if (forceRestart || shouldClearCredentials) {
        await stopBot({ clearCredentials: shouldClearCredentials, status: 'Disconnected' });
    } else if (activeSocket) {
        return activeSocket;
    }

    startPromise = createSocket({ pairMode, phoneNumber })
        .finally(() => {
            startPromise = null;
        });

    return startPromise;
}

async function handleMessages(sock, messageBatch, sessionId = '__main__') {
    // Baileys delivers two flavours of upserts:
    //   * 'notify' — message arrived live, online.
    //   * 'append' — message that was queued by WhatsApp while we were
    //                offline (brief disconnects, Railway free-tier
    //                connection blips, history sync, etc.).
    // The old code processed 'notify' only, which silently swallowed every
    // command sent during any disconnect window. On flaky hosts that's a
    // *huge* source of "the bot never saw my command". We now accept both
    // and rely on the timestamp filter further below to drop genuine
    // historical-sync backlog. Anything else (e.g. 'replace') is metadata
    // and stays ignored.
    if (messageBatch.type !== 'notify' && messageBatch.type !== 'append') return;

    // --- Fleet Solo Mode -------------------------------------------------
    // When the same Fleet hosts multiple sessions and a group message
    // arrives, every session's `messages.upsert` listener fires for the
    // exact same `msg.key.id`. Without this gate, every session would
    // independently react (anti-link, anti-bad, mention reply, command
    // dispatch, auto-view status, …) and produce N copies of every reply
    // in the group. The first session to see a message id claims it; all
    // siblings drop it. Direct messages naturally land on a single
    // session and stay unaffected.
    if (Array.isArray(messageBatch.messages) && messageBatch.messages.length) {
        const claimed = fleetCoordinator.filterClaimable(sessionId, messageBatch.messages);
        if (claimed.length === 0) return;
        if (claimed.length !== messageBatch.messages.length) {
            messageBatch = { ...messageBatch, messages: claimed };
        }
    }

    let owner = null;
    let sAutoRead = null;
    let sAutoTyping = null;
    let sAutoReact = null;
    let sNsfw = null;
    let sPrefix = null;
    let sName = null;
    let sAutoReply = null;
    let workMode = 'public';
    let autoStatus = false;
    let botEnabled = true;
    let disabledModules = [];
    let sAutoReadBot = null;
    let sAiAutoReply = null;
    let sAiAutoVoice = null;
    let sAiAutoPersona = null;
    let sAiAutoLang = null;
    let sAiGroupMode = null;
    let sAiSystemInstruction = null;
    let sAiMaxWords = null;

    if (sessionId === '__main__') {
        const ov = db.getSetting('main_bot_settings') || {};
        workMode = ov.workMode || appState.getWorkMode();
        autoStatus = ov.autoStatus !== undefined ? ov.autoStatus : appState.getAutoStatus();
        botEnabled = ov.botEnabled !== undefined ? ov.botEnabled : appState.getBotEnabled();
        disabledModules = ov.disabledModules || appState.getDisabledModules();
        owner = ov.owner || appState.getOwner();
        sAutoRead = ov.autoRead !== undefined ? ov.autoRead : appState.getAutoRead();
        sAutoReadBot = ov.autoReadBot !== undefined ? ov.autoReadBot : appState.getAutoReadBot();
        sAutoTyping = ov.autoTyping !== undefined ? ov.autoTyping : appState.getAutoTyping();
        sNsfw = ov.nsfwEnabled !== undefined ? ov.nsfwEnabled : appState.getNsfwEnabled();
        sAutoReact = ov.autoReactStatus !== undefined ? ov.autoReactStatus : appState.getAutoReactStatus();
        sPrefix = ov.prefix || getPrefix();
        sName = ov.name || getBotName();
        sAutoReply = ov.autoReply !== undefined ? ov.autoReply : appState.getAutoReply();
        sAiAutoReply = ov.aiAutoReply !== undefined ? ov.aiAutoReply : appState.getAiAutoReply();
        sAiAutoVoice = ov.aiAutoVoice !== undefined ? ov.aiAutoVoice : appState.getAiAutoVoice();
        sAiAutoPersona = ov.aiAutoPersona || appState.getAiAutoPersona();
        sAiAutoLang = ov.aiAutoLang || appState.getAiAutoLang();
        sAiGroupMode = ov.aiGroupMode || appState.getAiGroupMode();
        sAiSystemInstruction = ov.aiSystemInstruction !== undefined ? ov.aiSystemInstruction : appState.getAiSystemInstruction();
        sAiMaxWords = ov.aiMaxWords !== undefined ? ov.aiMaxWords : appState.getAiMaxWords();
    } else {
        const sessionMgr = require('./session-manager');
        const session = sessionMgr.get(sessionId);
        if (session) {
            workMode = session.workMode || 'public';
            autoStatus = session.autoStatus !== false;
            botEnabled = session.botEnabled !== false;
            disabledModules = session.disabledModules || [];
            owner = session.owner || null;

            // Per-bot overrides with global fallbacks
            sAutoRead = session.autoRead !== null && session.autoRead !== undefined
                ? session.autoRead
                : appState.getAutoRead();
            sAutoReadBot = session.autoReadBot !== null && session.autoReadBot !== undefined
                ? session.autoReadBot
                : appState.getAutoReadBot();
            sAutoTyping = session.autoTyping !== null && session.autoTyping !== undefined
                ? session.autoTyping
                : appState.getAutoTyping();
            sAutoReact = session.autoReactStatus !== null && session.autoReactStatus !== undefined
                ? session.autoReactStatus
                : appState.getAutoReactStatus();
            sNsfw = session.nsfwEnabled !== null && session.nsfwEnabled !== undefined
                ? session.nsfwEnabled
                : appState.getNsfwEnabled();
            sPrefix = session.prefix || null;
            sName = session.name || null;
            sAutoReply = session.autoReply !== null && session.autoReply !== undefined
                ? session.autoReply
                : true; // Default to true if not specified per-bot

            sAiAutoReply = session.aiAutoReply !== null && session.aiAutoReply !== undefined ? session.aiAutoReply : null;
            sAiAutoVoice = session.aiAutoVoice !== null && session.aiAutoVoice !== undefined ? session.aiAutoVoice : null;
            sAiAutoPersona = session.aiAutoPersona || null;
            sAiAutoLang = session.aiAutoLang || null;
            sAiGroupMode = session.aiGroupMode || null;
            sAiSystemInstruction = session.aiSystemInstruction !== undefined ? session.aiSystemInstruction : null;
            sAiMaxWords = session.aiMaxWords !== undefined ? session.aiMaxWords : null;
        }
    }

    // Resolve behavioral settings: Session > Global
    const finalAutoRead = sAutoRead !== null ? sAutoRead : getAutoRead();
    const finalAutoReadBot = sAutoReadBot !== null ? sAutoReadBot : getAutoReadBot();
    const finalAutoTyping = sAutoTyping !== null ? sAutoTyping : getAutoTyping();
    const finalAutoReact = sAutoReact !== null ? sAutoReact : getAutoReactStatus();
    const finalNsfw = sNsfw !== null ? sNsfw : getNsfwEnabled();
    const finalPrefix = sPrefix || getPrefix();
    const finalBotName = sName || getBotName();
    const finalAutoReply = sAutoReply !== null ? sAutoReply : true;

    // AI Settings Resolution: Per-bot > Global fallback
    const finalAiAutoReply = sAiAutoReply !== null ? sAiAutoReply : appState.getAiAutoReply();
    const finalAiAutoVoice = sAiAutoVoice !== null ? sAiAutoVoice : appState.getAiAutoVoice();
    const finalAiAutoPersona = sAiAutoPersona || appState.getAiAutoPersona() || 'friendly';
    const finalAiAutoLang = sAiAutoLang || appState.getAiAutoLang() || 'mixed';
    const finalAiGroupMode = sAiGroupMode || appState.getAiGroupMode() || 'mention';
    const finalAiSystemInstruction = sAiSystemInstruction !== null ? sAiSystemInstruction : appState.getAiSystemInstruction();
    const finalAiMaxWords = sAiMaxWords !== null ? sAiMaxWords : appState.getAiMaxWords();
    const mainOverrides = sessionId === '__main__' ? getMainOverrides() : null;
    const finalMentionReply = sessionId === '__main__'
        ? (mainOverrides.mentionReply || '')
        : (getSessionFeature(sessionId, 'mentionReply', '') || '');

    // Auto-view / Auto-react for status@broadcast are now independent of the
    // generic autoStatus flag — either global toggle alone is enough to trigger.
    // Sub-sessions always have autoViewStatus initialized as a boolean by
    // session-manager, so the third arg here is a documentation default.
    const finalAutoView = sessionId === '__main__'
        ? (mainOverrides.autoViewStatus !== undefined ? !!mainOverrides.autoViewStatus : !!getAutoViewStatus())
        : !!getSessionFeature(sessionId, 'autoViewStatus', false);


    // Removed global early exit for !botEnabled so owners can wake it up    // Increment Processed Count
    if (sessionId === '__main__') {
        appState.incProcessedCount();
    } else {
        const sessionMgr = require('./session-manager');
        const session = sessionMgr.get(sessionId);
        if (session) {
            sessionMgr.updateSessionMetrics(sessionId, {
                processedCount: (session.processedCount || 0) + 1
            });
        }
    }

    // 1. First, try to capture ANY View-Once media in the raw batch
    if (isAntiViewOnceEnabled(sessionId)) {
        for (const msg of messageBatch.messages) {
            if (!msg.message || msg.key?.fromMe) continue;
            await captureViewOnce(sock, msg, { sessionId, owner }).catch((error) => {
                logger(`[${sessionId}] View Once capture failed: ${error.message}`);
            });
        }
    }

    // 2. Then, filter for valid/new messages for command processing.
    //
    // The timestamp gate exists ONLY to drop the historical-sync backlog
    // that arrives as `type='append'` on first connect / long disconnects.
    // For live `type='notify'` messages we never want to drop by age — they
    // are by definition real-time and should always be processed.
    //
    // We also handle the cases where `messageTimestamp`:
    //   * is a plain number   (most common)
    //   * is a Long-like obj with .toNumber()  (raw protobuf decode)
    //   * is missing/0/NaN    (some edge message types)
    // When unparseable we err on the side of *processing* the message
    // rather than silently dropping it; the dedup cache in handler.js
    // catches double-processing.
    const nowSec = Math.floor(Date.now() / 1000);
    const botStartTime = sock.startTime || nowSec;

    function getMessageTimestampSec(msg) {
        const raw = msg.messageTimestamp
            || msg.message?.messageTimestamp
            || msg.message?.extendedTextMessage?.contextInfo?.timestamp
            || 0;
        if (raw && typeof raw === 'object' && typeof raw.toNumber === 'function') {
            try { return raw.toNumber(); } catch { return 0; }
        }
        const n = Number(raw);
        return Number.isFinite(n) ? n : 0;
    }

    const validMessages = messageBatch.messages.filter(msg => {
        if (!msg.message) return false;
        const msgTime = getMessageTimestampSec(msg);
        if (msgTime > 0) {
            // Drop messages sent before the bot started (allow 15s grace for in-flight requests)
            const isBeforeBotStart = msgTime < (botStartTime - 15);
            // Drop messages older than 60 seconds from current real-time clock
            const isTooOld = (nowSec - msgTime) > 60;
            if (isBeforeBotStart || isTooOld) {
                const ageSec = (nowSec - msgTime);
                const fromJid = msg.key?.remoteJid || 'unknown';
                logger(`[Skip] Stale message (${msgTime}) from ${fromJid} (age=${ageSec}s)`);
                return false;
            }
        }
        return true;
    });

    for (const msg of validMessages) {
        const jid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const pushName = msg.pushName || 'User';
        const isGroup = jid.endsWith('@g.us');
        const sender = msg.key.participant || jid;

        cacheMsg(msg);

        const protocolMsg = msg.message?.protocolMessage;
        if (protocolMsg && protocolMsg.type === 0) { // REVOKE
            await handleAntiDelete(sock, sessionId, protocolMsg.key).catch((e) => {
                logger(`[${sessionId}] Anti-Delete failed: ${e.message}`);
            });
        }

        if (jid === 'status@broadcast') {
            const { jidNormalizedUser } = require('@whiskeysockets/baileys');

            let selfJid = null;
            try {
                selfJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
            } catch { }

            const rawParticipant = msg.key?.participant || '';
            const normParticipant = rawParticipant.includes('@')
                ? jidNormalizedUser(rawParticipant)
                : rawParticipant;

            const isOwnStatus = fromMe || (selfJid && normParticipant && normParticipant === selfJid);

            // Visibility log: every time a status update arrives we record the
            // current toggle state so when the user complains "react isn't
            // working" we can tell at a glance whether the bot saw the status,
            // whether the toggle was on, and whether the bot decided to react.
            logger(`[Status In] from=${normParticipant || rawParticipant || '?'} id=${msg.key?.id || '?'} self=${selfJid || '?'} ownStatus=${!!isOwnStatus} autoView=${!!finalAutoView} autoReact=${!!finalAutoReact}`);

            if (!isOwnStatus && (finalAutoView || finalAutoReact)) {
                const readDelay = Math.floor(Math.random() * 5000) + 2000 + Math.floor(Math.random() * 800);

                setTimeout(async () => {
                    try {
                        // Take a snapshot of the original Baileys-delivered key.
                        // We pass this *as-is* to sendMessage's react below
                        // because rebuilding the key (e.g. swapping the
                        // participant for a normalized form) is the #1 cause
                        // of "not-acceptable" status-react failures: the
                        // server validates the reaction's signed key against
                        // the original status delivery, and any drift in the
                        // participant field (server type, device suffix,
                        // etc.) gets rejected.
                        const key = msg?.key;
                        const remoteJid = key?.remoteJid;
                        const msgId = key?.id;
                        const participant = key?.participant || rawParticipant || null;

                        if (!key || !remoteJid || !msgId || !participant) {
                            logger(`[Status] Missing key fields | remoteJid=${remoteJid} msgId=${msgId} participant=${participant}`);
                            return;
                        }

                        // Sanitized version (no device suffix) is only used for
                        // the View receipt path — readReceipts care about the
                        // participant identity, not the exact key shape.
                        let sanitizedParticipant = participant;
                        if (participant.includes(':') && participant.includes('@')) {
                            const user = participant.split(':')[0];
                            const server = participant.split('@')[1];
                            sanitizedParticipant = `${user}@${server}`;
                        }

                        logger(`[Status Debug] Incoming status | remoteJid=${remoteJid} participant=${participant} sanitized=${sanitizedParticipant} id=${msgId}`);

                        if (finalAutoView) {
                            try {
                                await sock.readMessages([key]);
                                logger(`[Status View] readMessages() sent for ${sanitizedParticipant}`);

                                await sock.sendReceipt(
                                    remoteJid,
                                    sanitizedParticipant,
                                    [msgId],
                                    'read'
                                ).catch((e) => {
                                    logger(`[Status View] sendReceipt warning: ${e?.message || e}`);
                                });

                                logger(`[Status View] Attempted view for ${sanitizedParticipant.split('@')[0]}`);
                            } catch (viewErr) {
                                logger(`[Status View] Error: ${viewErr.message}`);
                            }
                        }

                        if (finalAutoReact) {
                            const reactDelay = Math.floor(Math.random() * 3500) + 1500;

                            setTimeout(async () => {
                                // Single-codepoint emojis without VS16 / ZWJ
                                // sequences. Multi-codepoint sequences are
                                // sometimes rejected by WhatsApp servers on
                                // status reactions with "not-acceptable".
                                const reactions = [
                                    "🔥", "💯", "✨", "🚀", "😍", "🙏",
                                    "🎉", "👏", "👍", "😁", "😎", "🤩", "😮",
                                    "⚡", "👑", "🌹", "😅", "😜", "🤪",
                                    "😇", "😋", "😌"
                                ];

                                // Try the react with the original key first.
                                // If the server replies "not-acceptable" we
                                // fall back to a freshly-normalized key —
                                // some Baileys forks produce status keys
                                // with device-suffixed participants that the
                                // server signs differently, in which case
                                // the normalized form is the one that
                                // actually validates. We pick a different
                                // emoji on the retry to avoid any
                                // server-side dedup of identical attempts.
                                const tryReact = async (reactKey, reactEmoji, label) => {
                                    const targetJid = jidNormalizedUser(sanitizedParticipant);
                                    if (selfJid && targetJid === selfJid) return { skipped: true };

                                    const payload = {
                                        react: {
                                            text: reactEmoji,
                                            key: reactKey,
                                        },
                                    };

                                    // statusJidList must include the status
                                    // poster AND ourselves so Baileys'
                                    // relayMessage can encrypt for both
                                    // sides. Including only the poster is
                                    // another common cause of silent
                                    // delivery failures even when the
                                    // server returns 200.
                                    const recipients = [targetJid];
                                    if (selfJid && !recipients.includes(selfJid)) recipients.push(selfJid);

                                    await sock.sendMessage(
                                        'status@broadcast',
                                        payload,
                                        { statusJidList: recipients }
                                    );
                                    logger(`[Status React] ${label} ${reactEmoji} → ${sanitizedParticipant.split('@')[0]}`);
                                    return { ok: true };
                                };

                                const primaryEmoji = reactions[Math.floor(Math.random() * reactions.length)];

                                try {
                                    const r = await tryReact(key, primaryEmoji, 'Sent');
                                    if (r?.skipped) return;
                                } catch (reactErr) {
                                    const msgErr = reactErr?.message || String(reactErr);
                                    const isNotAcceptable = /not-acceptable/i.test(msgErr);

                                    if (isNotAcceptable) {
                                        // Retry once with a normalized key
                                        // (no device suffix, normalized
                                        // participant) and a different
                                        // emoji.
                                        const fallbackEmoji = reactions[(reactions.indexOf(primaryEmoji) + 7) % reactions.length];
                                        const fallbackKey = {
                                            remoteJid: 'status@broadcast',
                                            fromMe: false,
                                            id: msgId,
                                            participant: jidNormalizedUser(sanitizedParticipant),
                                        };
                                        try {
                                            await tryReact(fallbackKey, fallbackEmoji, 'Retry-Sent');
                                        } catch (retryErr) {
                                            const rmsg = retryErr?.message || String(retryErr);
                                            if (/not-acceptable/i.test(rmsg)) {
                                                // True permanent fail (status
                                                // truly expired or privacy
                                                // disabled reactions). Log
                                                // once at info — not silenced
                                                // — so the operator can see
                                                // it in the terminal.
                                                logger(`[Status React] Permanent skip for ${sanitizedParticipant.split('@')[0]} (not-acceptable: status expired or react-disabled by user)`);
                                            } else {
                                                logger(`[Status React] Retry failed: ${rmsg}`);
                                            }
                                        }
                                    } else {
                                        logger(`[Status React] Error: ${msgErr}`);
                                    }
                                }
                            }, reactDelay);
                        }

                    } catch (err) {
                        logger(`[Status] Processing error: ${err.message}`);
                    }
                }, readDelay);
            }

            continue;
        }

        // Private Mode Check
        const isUserOwner = db.isUserBanned(sender) ? false : (msg.key.fromMe || require('./lib/utils').isOwner(sender, owner));
        if (!isUserOwner && (workMode === 'self' || (workMode === 'private' && isGroup))) {
            continue;
        }

        if (isGroup && !fromMe) {
            const group = db.get('groups', jid);
            if (group) {
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                if ((group.antiLink || group.antilink) && (text.includes('chat.whatsapp.com') || text.includes('http://') || text.includes('https://'))) {
                    logger(`Anti-Link: Deleting link from ${pushName} in ${group.name}`);
                    await sock.sendMessage(jid, { delete: msg.key });
                    continue;
                }

                if (group.antiSpam) {
                    const now = Date.now();
                    const spamKey = msg.key.participant || jid;
                    const recentMessages = (spamMap.get(spamKey) || []).filter((timestamp) => now - timestamp < 5000);
                    recentMessages.push(now);
                    spamMap.set(spamKey, recentMessages);
                    if (recentMessages.length > 4) {
                        logger(`Anti-Spam: Skipping message from ${pushName} in ${group.name}`);
                        continue;
                    }
                }

                if (group.isMuted && text.startsWith(getPrefix())) {
                    logger(`Mute: Ignoring command in ${group.name}`);
                    continue;
                }
            }
        }
    }

    if (appState.isRestartRequested()) {
        appState.clearRestart();
        logger('Admin restart requested. Reconnecting main bot...');
        await stopBot({ status: 'Restarting' });
        setTimeout(() => {
            startBot({ forceRestart: true }).catch(() => { });
        }, 2000);
        return;
    }

    await Promise.all(validMessages.map(async (msg) => {
        const from = msg.key.remoteJid;
        if (from === 'status@broadcast') return;

        const rawSender = msg.key.participant || msg.key.remoteJid;
        const sender = canonicalSender(rawSender, msg);
        const pushName = msg.pushName || null;

        // Automatically update user metadata (Name and Last Seen) with throttling
        if (sender && sender !== 'status@broadcast') {
            const userDb = db.getObjectCollection('users');
            const existingUser = userDb[sender];
            const now = Date.now();
            const lastSeenTs = existingUser?.lastSeen ? new Date(existingUser.lastSeen).getTime() : 0;
            if (!existingUser || (now - lastSeenTs > 60000) || (pushName && existingUser.pushName !== pushName)) {
                const updateData = {
                    lastSeen: new Date().toISOString(),
                    number: sender.split('@')[0]
                };
                if (pushName) updateData.pushName = pushName;

                db.update('users', sender, updateData);
                const rawCleaned = cleanJid(rawSender);
                if (rawCleaned && rawCleaned !== sender) {
                    db.update('users', rawCleaned, updateData);
                }
            }
        }

        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption || '';

        // Fast O(1) ownership check
        const isUserOwner = msg.key.fromMe ||
            isOwner(sender, owner) ||
            isOwner(rawSender, owner) ||
            (db.getObjectCollection('users')[sender]?.isOwner);

        if (!botEnabled) {
            // If bot is disabled, ignore everything EXCEPT owner running system commands (.on, .settings)
            if (isUserOwner && text.startsWith(finalPrefix)) {
                const cmdName = text.slice(finalPrefix.length).trim().split(' ')[0].toLowerCase();
                if (!['on', 'settings', 'status', 'config'].includes(cmdName)) {
                    if (text.startsWith(finalPrefix)) logger(`[Skip] bot disabled (botEnabled=false): ${truncatePreview(text)}`);
                    return;
                }
            } else {
                if (text.startsWith(finalPrefix) || /^\d+$/.test(text.trim())) {
                    logger(`[Skip] bot disabled, non-owner command from ${sender}: ${truncatePreview(text)}`);
                }
                return;
            }
        }

        // 3. Mark as read logic
        const botSignatures = ["chathu md", "generated by", "auto reply", "power by", "powered by"];
        const isBotMessage = msg.key.fromMe ||
            text.includes("\u200B") ||
            text.includes("\u200C") ||
            botSignatures.some(sig => text.toLowerCase().includes(sig));

        const looksLikeCommand = text.startsWith(finalPrefix) || /^\d+$/.test(text.trim());

        if ((finalAutoRead && !msg.key.fromMe) || (finalAutoReadBot && isBotMessage && looksLikeCommand) || (looksLikeCommand && !msg.key.fromMe)) {
            sock.readMessages([msg.key]).catch(() => { });
        }

        if (finalAutoTyping && !msg.key.fromMe) sock.sendPresenceUpdate('composing', from).catch(() => { });

        const prefix = finalPrefix;

        const hasInteractive = Boolean(
            msg.message?.buttonsResponseMessage?.selectedButtonId
            || msg.message?.templateButtonReplyMessage?.selectedId
            || msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
            || msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
        );
        if (msg.key.fromMe && !text.startsWith(finalPrefix) && !/^\d+$/.test(text.trim()) && !hasInteractive) return;

        if (db.isUserBanned(sender)) {
            if (text.startsWith(finalPrefix) || /^\d+$/.test(text.trim())) {
                logger(`[Skip] banned user ${sender}: ${truncatePreview(text)}`);
            }
            return;
        }
        if (!isUserOwner && (
            workMode === 'self' ||
            (workMode === 'private' && from.endsWith('@g.us')) ||
            (workMode === 'group' && !from.endsWith('@g.us'))
        )) {
            if (text.startsWith(finalPrefix) || /^\d+$/.test(text.trim())) {
                logger(`[Skip] workMode=${workMode}, non-owner ${sender} from ${from}: ${truncatePreview(text)}`);
            }
            return;
        }

        if (finalMentionReply && !msg.key.fromMe && text && sock.user?.id) {
            const botNumber = sock.user.id.split(':')[0];
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const cleanText = text.toLowerCase();
            const botNameLower = (finalBotName || '').toLowerCase();
            const botNameFirstWord = botNameLower.split(/\s+/)[0] || '';
            const mentionsBot = mentioned.some((jid) => String(jid).startsWith(botNumber))
                || text.includes(`@${botNumber}`)
                || (botNameLower.length > 2 && cleanText.includes(botNameLower))
                || (botNameFirstWord.length > 2 && new RegExp(`(^|\\W)${botNameFirstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(cleanText));
            if (mentionsBot && !text.startsWith(finalPrefix)) {
                await sock.sendMessage(from, { text: finalMentionReply }, { quoted: msg }).catch(() => { });
                return;
            }
        }

        if (from.endsWith('@g.us') && text) {
            const groupSettings = db.get('groups', from) || {};

            if ((groupSettings.antilink || groupSettings.antiLink) && /(https?:\/\/|chat\.whatsapp\.com)/i.test(text)) {
                try {
                    const meta = await sock.groupMetadata(from);
                    const isAdmin = meta.participants.find((participant) => participant.id === sender)?.admin;
                    if (!isAdmin) {
                        await sock.sendMessage(from, { delete: msg.key });
                        await sock.groupParticipantsUpdate(from, [sender], 'remove');
                        return;
                    }
                } catch { }
            }

            if (groupSettings.antibad && BAD_WORDS.some((word) => text.toLowerCase().includes(word))) {
                try {
                    const meta = await sock.groupMetadata(from);
                    const isAdmin = meta.participants.find((participant) => participant.id === sender)?.admin;
                    if (!isAdmin) {
                        await sock.sendMessage(from, { delete: msg.key });
                        await sock.sendMessage(from, {
                            text: `Warning @${sender.split('@')[0]}, this group does not allow bad words.`,
                            mentions: [sender]
                        });
                        return;
                    }
                } catch { }
            }
        }

        const isCommand = await handleCommand(sock, msg, from, text, disabledModules, {
            workMode, owner, nsfwEnabled: finalNsfw, prefix: finalPrefix, botName: finalBotName, sessionId,
            autoReply: finalAutoReply,
            aiAutoReply: finalAiAutoReply,
            aiAutoVoice: finalAiAutoVoice,
            aiAutoPersona: finalAiAutoPersona,
            aiAutoLang: finalAiAutoLang,
            aiGroupMode: finalAiGroupMode,
            aiSystemInstruction: finalAiSystemInstruction,
            aiMaxWords: finalAiMaxWords,
            mentionReply: finalMentionReply
        });

        if (isCommand) {
            if (sessionId === '__main__') {
                appState.incCommandsCount();
            } else {
                const sessionMgr = require('./session-manager');
                const session = sessionMgr.get(sessionId);
                if (session) {
                    sessionMgr.updateSessionMetrics(sessionId, {
                        commandsCount: (session.commandsCount || 0) + 1
                    });
                }
            }
        }

        if (!isCommand && !msg.key.fromMe && !text.startsWith(finalPrefix) && finalAutoReply) {
            const autoReplyRule = findAutoReply(text, { isGroupMessage: from.endsWith('@g.us') });
            if (autoReplyRule) {
                logger(`[AutoReply] Rule matched: "${text.substring(0, 20)}..." -> "${autoReplyRule.response.substring(0, 20)}..."`);
                await sock.sendMessage(from, { text: autoReplyRule.response }).catch((err) => {
                    logger(`[AutoReply] Failed to send: ${err.message}`);
                });
                return;
            }

            const lower = text.toLowerCase().trim();
            if (lower === 'hi' || lower === 'hello' || lower === 'hey') {
                await sock.sendMessage(from, {
                    text: `Hello! Welcome.\n\nType *${finalPrefix}menu* to see all features or *${finalPrefix}help* for a quick guide.\n\n- Powered by *${getBotName()}*`
                });
            }
        }
    }));
}

module.exports = {
    startBot,
    stopBot,
    handleMessages,
    syncGroups,
    refreshRuntimeFeatures
};
