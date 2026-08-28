'use strict';

const express = require('express');
const http = require('http');
const net = require('net');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const si = require('systeminformation');
const config = require('./config');
const { PORT, ADMIN_USER, ADMIN_PASS, JWT_SECRET, DOWNLOAD_DIR } = config;
const appState = require('./state');
const { setIO, logger } = require('./logger');
const db = require('./lib/db');
const runtimeSettings = require('./lib/runtime-settings');
const { validateConfig } = require('./lib/config-validation');
const { normalizeTarget } = require('./lib/automation-runtime');
const { normalizeOwner } = require('./lib/utils');
const { normalizeSriLankanPhoneNumber } = require('./lib/phone-normalizer');
const { createSchedulerRuntime } = require('./lib/scheduler-runtime');
const { getViewOnceLog, removeLogEntry, VIEWONCE_DIR: VO_DIR } = require('./lib/viewonce-capture');
const { setupWorkerRoutes } = require('./lib/cloud-worker');

const app = express();
app.set('trust proxy', String(process.env.TRUST_PROXY || '').toLowerCase() === 'true');
const server = http.createServer(app);
let dashboardStarted = false;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_COOLDOWN_MS = 2 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

function normalizeUserJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.endsWith('@s.whatsapp.net')) return raw.toLowerCase();
    if (raw.endsWith('@lid')) return raw.toLowerCase();
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
}

function normalizeGroupJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.endsWith('@g.us')) return raw.toLowerCase();
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@g.us` : null;
}

function normalizeSessionId(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'main' || raw === '__main__') return '__main__';
    return raw;
}

function parseNumberValue(value, fallback) {
    const n = parseInt(value);
    return isNaN(n) ? fallback : n;
}

function parseBooleanFlag(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === '1') return true;
        if (lower === 'false' || lower === '0') return false;
    }
    return fallback;
}

function getClientAddress(req) {
    return String(req.ip || req.socket.remoteAddress || '0.0.0.0').split(',')[0].trim();
}

function extractBearerToken(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

function getAuthConfigState() {
    const cfg = require('./config');
    const adminPassReady = typeof cfg.ADMIN_PASS === 'string' && cfg.ADMIN_PASS.trim().length > 0;
    const jwtSecretReady = typeof cfg.JWT_SECRET === 'string' && cfg.JWT_SECRET.trim().length > 0;

    return {
        ready: adminPassReady && jwtSecretReady,
        message: !adminPassReady
            ? 'ADMIN_PASS is missing. Configure a dashboard password before signing in.'
            : !jwtSecretReady
                ? 'JWT_SECRET is missing. Configure it before using admin sessions.'
                : null,
    };
}

function getSettingsPayload() {
    const cfg = require('./config');
    const validation = validateConfig(cfg);

    return {
        botName: runtimeSettings.getBotName(),
        prefix: runtimeSettings.getPrefix(),
        ownerNumber: cfg.OWNER_NUMBER,
        autoRead: runtimeSettings.getAutoRead(),
        autoTyping: runtimeSettings.getAutoTyping(),
        nsfwEnabled: runtimeSettings.getNsfwEnabled(),
        workMode: runtimeSettings.getWorkMode(),
        autoViewStatus: runtimeSettings.getAutoViewStatus(),
        autoReactStatus: runtimeSettings.getAutoReactStatus(),
        fleetSoloMode: db.getSetting('fleet_solo_mode') !== false,
        buttonMode:   typeof appState.getButtonMode   === 'function' ? appState.getButtonMode()   : 'auto',
        roleMenuMode: typeof appState.getRoleMenuMode === 'function' ? appState.getRoleMenuMode() : 'strict',
        dashboardVersion: 'v5.0',
        aiAutoReply: appState.getAiAutoReply(),
        aiAutoVoice: appState.getAiAutoVoice(),
        aiAutoPersona: appState.getAiAutoPersona(),
        aiAutoLang: appState.getAiAutoLang(),
        aiGroupMode: appState.getAiGroupMode(),
        aiSystemInstruction: appState.getAiSystemInstruction(),
        aiMaxWords: appState.getAiMaxWords(),
        aiAutoWakeWords: appState.getAiAutoWakeWords(),
        aiAutoBurstShield: appState.getAiAutoBurstShield(),
        aiAutoLightReact: appState.getAiAutoLightReact(),
        aiAutoMemoryDepth: appState.getAiAutoMemoryDepth(),
        premiumCode: cfg.PREMIUM_CODE,
        warnings: validation.warnings,
        runMode: validation.mode.explicitMode,
        secureByDefault: validation.mode.isProductionLike,
        envLoaded: process.env.CHMD_ENV_PRELOADED === 'true',
        envSource: process.env.CHMD_ENV_SOURCE || null,
    };
}

function getMainSessionPayload() {
    const mainStatus = appState.getStatus();
    const ov = db.getSetting('main_bot_settings') || {};
    const config = require('./config');
    return {
        id: '__main__',
        label: 'Main Bot',
        number: appState.getNumber() || null,
        pushName: appState.getPushName() || null,
        name: ov.name || runtimeSettings.getBotName(),
        prefix: ov.prefix || runtimeSettings.getPrefix(),
        status: mainStatus,
        isMain: true,
        startedAt: appState.getConnectedAt() || null,
        qrAvailable: !!appState.getMainQr() && mainStatus !== 'Connected',
        pairCode: mainStatus !== 'Connected' ? (appState.getMainPairCode() || null) : null,
        pairCodeExpiresAt: mainStatus !== 'Connected' ? (appState.getMainPairCodeExpiresAt() || null) : null,
        qrPaused: appState.isQrPaused(),
        workMode: ov.workMode || appState.getWorkMode(),
        autoStatus: ov.autoStatus !== undefined ? ov.autoStatus : appState.getAutoStatus(),
        botEnabled: ov.botEnabled !== undefined ? ov.botEnabled : appState.getBotEnabled(),
        disabledModules: ov.disabledModules || appState.getDisabledModules(),
        owner: ov.owner || appState.getOwner(),
        processedCount: appState.getProcessedCount(),
        commandsCount: appState.getCommandsCount(),
        autoRead: ov.autoRead !== undefined ? ov.autoRead : appState.getAutoRead(),
        autoTyping: ov.autoTyping !== undefined ? ov.autoTyping : appState.getAutoTyping(),
        autoReactStatus: ov.autoReactStatus !== undefined ? ov.autoReactStatus : appState.getAutoReactStatus(),
        nsfwEnabled: ov.nsfwEnabled !== undefined ? ov.nsfwEnabled : appState.getNsfwEnabled(),
        autoReply: ov.autoReply !== undefined ? ov.autoReply : appState.getAutoReply(),
        aiAutoReply: ov.aiAutoReply !== undefined ? ov.aiAutoReply : appState.getAiAutoReply(),
        aiAutoVoice: ov.aiAutoVoice !== undefined ? ov.aiAutoVoice : appState.getAiAutoVoice(),
        aiAutoPersona: ov.aiAutoPersona || appState.getAiAutoPersona(),
        aiAutoLang: ov.aiAutoLang || appState.getAiAutoLang(),
        aiGroupMode: ov.aiGroupMode || appState.getAiGroupMode(),
        aiSystemInstruction: ov.aiSystemInstruction || appState.getAiSystemInstruction(),
        aiMaxWords: ov.aiMaxWords || appState.getAiMaxWords(),
        aiAutoWakeWords: appState.getAiAutoWakeWords(),
        aiAutoBurstShield: appState.getAiAutoBurstShield(),
        aiAutoLightReact: appState.getAiAutoLightReact(),
        aiAutoMemoryDepth: appState.getAiAutoMemoryDepth(),
        alwaysOnline: ov.alwaysOnline || false,
        antiCall: ov.antiCall || false,
        antiDelete: ov.antiDelete || false,
        autoBio: ov.autoBio || false,
        alwaysRecording: ov.alwaysRecording || false,
        autoViewStatus: ov.autoViewStatus !== undefined ? !!ov.autoViewStatus : runtimeSettings.getAutoViewStatus(),
        antiViewOnce: ov.antiViewOnce || false,
        antiGroupJoin: ov.antiGroupJoin || false,
        mentionReply: ov.mentionReply || '',
        privacyAutoCleanup: !!ov.privacyAutoCleanup,
        privacyMaxStorageMb: ov.privacyMaxStorageMb || 500,
        limits: ov.limits || {},
        lastError: appState.getLastError ? (appState.getLastError() || null) : (ov.lastError || null),
        reconnectAttempts: appState.getReconnectAttempts ? (appState.getReconnectAttempts() || 0) : 0,
        connectedAt: appState.getConnectedAt ? (appState.getConnectedAt() || null) : null,
        platform: 'Main Process',
        aiKeysStatus: {
            gemini: !!(config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim()),
            openrouter: !!(config.OPENROUTER_API_KEY && config.OPENROUTER_API_KEY.trim()),
            groq: !!(config.GROQ_API_KEY && config.GROQ_API_KEY.trim()),
        }
    };
}

function loadCommandCatalog() {
    const commandsDir = path.join(__dirname, 'lib', 'commands');
    const files = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js'));
    const overrides = db.getCommandSettings();
    const seen = new Set();
    const list = [];

    files.forEach((file) => {
        try {
            const commandModule = require(path.join(commandsDir, file));
            const commands = Array.isArray(commandModule) ? commandModule : [commandModule];
            const fallbackCategory = file === 'menu.js' ? 'system' : file.replace('.js', '');

            commands.forEach((cmd) => {
                if (!cmd?.name || seen.has(cmd.name)) return;
                seen.add(cmd.name);
                const commandOverride = overrides[cmd.name] || {};
                list.push({
                    name: cmd.name,
                    aliases: cmd.aliases || [],
                    description: cmd.description || '',
                    category: (cmd.category || fallbackCategory).toLowerCase(),
                    enabled: commandOverride.enabled !== undefined ? commandOverride.enabled : true,
                    cooldown: cmd.cooldown || 0,
                    pmOnly: cmd.pmOnly || false,
                    groupOnly: cmd.groupOnly || false,
                    premiumOnly: cmd.premiumOnly || false,
                    ownerOnly: cmd.ownerOnly || false,
                    usageCount: commandOverride.usageCount || 0,
                });
            });
        } catch {}
    });

    return list;
}

function pruneLoginAttempts(now = Date.now()) {
    for (const [key, entry] of loginAttempts.entries()) {
        const attempts = (entry.attempts || []).filter((stamp) => now - stamp <= LOGIN_WINDOW_MS);
        const blockedUntil = Number(entry.blockedUntil || 0);

        if (!attempts.length && blockedUntil <= now) {
            loginAttempts.delete(key);
            continue;
        }

        entry.attempts = attempts;
        if (blockedUntil <= now) {
            entry.blockedUntil = 0;
        }
        loginAttempts.set(key, entry);
    }
}

function getLoginAttemptKey(req) {
    const username = String(req.body?.username || '').trim().toLowerCase();
    return `${getClientAddress(req)}:${username}`;
}

function getLoginRateLimitState(key, now = Date.now()) {
    pruneLoginAttempts(now);
    const entry = loginAttempts.get(key) || { attempts: [], blockedUntil: 0 };
    return {
        key,
        attempts: entry.attempts.slice(),
        blockedUntil: Number(entry.blockedUntil || 0),
        isBlocked: Number(entry.blockedUntil || 0) > now,
    };
}

function recordLoginFailure(key, now = Date.now()) {
    const state = getLoginRateLimitState(key, now);
    const attempts = state.attempts.filter((stamp) => now - stamp <= LOGIN_WINDOW_MS);
    attempts.push(now);

    const nextState = {
        attempts,
        blockedUntil: attempts.length >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_COOLDOWN_MS : state.blockedUntil,
    };

    loginAttempts.set(key, nextState);
    return {
        ...nextState,
        isBlocked: nextState.blockedUntil > now,
    };
}

function clearLoginFailures(key) {
    loginAttempts.delete(key);
}

function logAuthEvent(event, payload = {}) {
    logger(`[Auth] ${JSON.stringify({ event, ...payload })}`);
}

function sendInvalidCredentials(res, options = {}) {
    const retryAfterMs = Number(options.retryAfterMs || 0);
    const statusCode = retryAfterMs > 0 ? 429 : 401;
    const body = { error: 'Invalid credentials' };

    if (retryAfterMs > 0) {
        const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        body.retryAfterSeconds = seconds;
    }

    return res.status(statusCode).json(body);
}

function getSocketForSession(sessionId) {
    if (!sessionId || sessionId === 'main' || sessionId === '__main__') {
        return {
            sessionId: '__main__',
            label: 'Main Bot',
            sock: appState.getSocket(),
        };
    }

    try {
        const sessionMgr = require('./session-manager');
        const session = sessionMgr.get(sessionId);
        return {
            sessionId,
            label: session?.label || sessionId,
            sock: session?.sock || null,
        };
    } catch {
        return {
            sessionId,
            label: sessionId,
            sock: null,
        };
    }
}

function resolveTargets(targetType = 'all', rawTargets = []) {
    if (targetType === 'groups') {
        return [...new Set(db.listGroups().map((group) => group.jid).filter(Boolean))];
    }

    if (targetType === 'custom') {
        return [...new Set((Array.isArray(rawTargets) ? rawTargets : [])
            .map((value) => normalizeTarget(value, String(value || '').includes('@g.us') ? '@g.us' : '@s.whatsapp.net'))
            .filter(Boolean))];
    }

    return [...new Set(db.listUsers().map((user) => user.jid).filter(Boolean))];
}

function findManagedUserByJid(jid) {
    const target = decodeURIComponent(String(jid || ''));
    return db.listUsers().find((item) => item.jid === target || item.realJid === target) || null;
}

function resolveMessageTargets(rawTargets) {
    if (!Array.isArray(rawTargets) || !rawTargets.length) {
        return db.listUsers().map((user) => user.jid);
    }

    return resolveTargets('custom', rawTargets);
}

// ── Network & CPU stats tracker (Ultra-low overhead native calculation) ───────
let netSpeedRx = 0, netSpeedTx = 0;
let netTotalRx = 0, netTotalTx = 0;
let currentCpuLoad = 0;
let prevCpuTimes = null;

function calculateNativeCpuLoad() {
    try {
        const cpus = os.cpus();
        if (!Array.isArray(cpus) || cpus.length === 0) return 0;
        let totalIdle = 0, totalTick = 0;
        for (const cpu of cpus) {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        }
        if (!prevCpuTimes) {
            prevCpuTimes = { idle: totalIdle, total: totalTick };
            return 0;
        }
        const idleDiff = totalIdle - prevCpuTimes.idle;
        const totalDiff = totalTick - prevCpuTimes.total;
        prevCpuTimes = { idle: totalIdle, total: totalTick };
        if (totalDiff <= 0) return currentCpuLoad;
        const loadPercent = Math.min(100, Math.max(0, 100 - (100 * idleDiff / totalDiff)));
        return Math.round(loadPercent * 10) / 10;
    } catch (_) {
        return 0;
    }
}

async function updateStats() {
    try {
        currentCpuLoad = calculateNativeCpuLoad();
    } catch (e) { }
}

// Low overhead native timer: only updates CPU metrics when someone is watching dashboard
const STATS_INTERVAL_MS = Math.max(2000, Number.parseInt(process.env.DASHBOARD_STATS_INTERVAL_MS, 10) || 10000);
updateStats();
const statsTimer = setInterval(() => {
    const clientCount = io?.engine?.clientsCount || 0;
    if (clientCount === 0) return;
    updateStats();
}, STATS_INTERVAL_MS);
if (typeof statsTimer.unref === 'function') statsTimer.unref();

const io = new Server(server, { cors: { origin: false } });

// Real-time bridge: when bot-side code mutates appState (e.g. via WhatsApp
// commands like ".aiauto on", or via the runtime layer), broadcast a fresh
// session:update + settings:update so any open dashboard reflects the change
// without needing a manual refresh.
appState.onChange((keys) => {
    try {
        io.emit('session:update', getMainSessionPayload());
        io.emit('settings:update', getSettingsPayload());
    } catch (e) {
        // Don't let socket errors break the bot.
    }
});

function createPortInUseError(port) {
    const error = new Error(`Dashboard port ${port} is already in use by another process.`);
    error.code = 'EADDRINUSE';
    return error;
}

function isLocalPortInUse(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (result, error = null) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        };

        socket.setTimeout(700);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', (error) => {
            if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
                finish(false);
                return;
            }
            finish(false, error);
        });

        socket.connect(port, host);
    });
}

function markDashboardStarted() {
    setIO(io);
    if (!dashboardStarted) {
        schedulerRuntime.start();
        dashboardStarted = true;
    }
}

io.use((socket, next) => {
    const authState = getAuthConfigState();
    if (!authState.ready) {
        return next(new Error(authState.message || 'Dashboard authentication is not configured.'));
    }

    const token = extractBearerToken(
        socket.handshake?.auth?.token
        || socket.handshake?.headers?.authorization
        || socket.handshake?.query?.token
    );

    if (!token) {
        return next(new Error('Authentication required'));
    }

    try {
        socket.data.admin = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        next(new Error('Invalid or expired token'));
    }
});

const schedulerRuntime = createSchedulerRuntime({
    listScheduler: () => db.listScheduler(),
    updateSchedulerItem: (id, patch) => db.updateSchedulerItem(id, patch),
    resolveTargets,
    getSocketForSession,
    emitSchedulerUpdate: (item) => io.emit('scheduler:update', item),
    logger,
});

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self' https://cdn.socket.io https://fonts.googleapis.com https://fonts.gstatic.com",
        "script-src 'self' 'unsafe-inline' https://cdn.socket.io",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; '));
    next();
});
app.use(express.json({ limit: '2mb', strict: true }));
setupWorkerRoutes(app);
app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    dotfiles: 'ignore',
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
        if (/\.(?:js|css|html)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    },
}));

/**
 * Robust API handler wrapper to prevent unhandled rejections and maintain dashboard stability.
 */
const apiHandler = (fn) => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (error) {
        logger(`[Dashboard API Error] ${req.method} ${req.url}: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'An internal system error occurred' });
        }
    }
};

// ── Page routes (one HTML file per path) ───────────────────────────────────
const PAGE_IDS = [
    'dashboard', 'sessions', 'users', 'groups', 'commands',
    'aiengine', 'broadcast', 'autoreply', 'scheduler', 'users_db',
    'files', 'viewonce_gallery', 'settings', 'logs',
];

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pages', 'dashboard.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check for Railway/Fly/Render/etc. (no auth, lightweight, always 200
// when the dashboard process is up). Cloud platforms poll this to decide
// whether to route traffic / restart the container.
app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        service: 'chathu-md-dashboard',
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
for (const id of PAGE_IDS) {
    app.get('/' + id, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'pages', `${id}.html`));
    });
}

// ── JWT middleware ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const authState = getAuthConfigState();
    if (!authState.ready) {
        return res.status(503).json({ error: authState.message || 'Admin authentication is not configured securely.' });
    }

    const token = extractBearerToken(req.headers.authorization) || null;
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.admin = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ── Auth ───────────────────────────────────────────────────────────────────
app.post('/bot-api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const now = Date.now();
    const key = getLoginAttemptKey(req);
    const rateState = getLoginRateLimitState(key, now);
    const authState = getAuthConfigState();

    if (!authState.ready) {
        logAuthEvent('login_blocked_unconfigured', {
            ip: getClientAddress(req),
            username: String(username || '').trim() || null,
        });
        return res.status(503).json({ error: authState.message || 'Admin authentication is not configured securely.' });
    }

    if (rateState.isBlocked) {
        const retryAfterMs = Math.max(0, rateState.blockedUntil - now);
        logAuthEvent('login_blocked', {
            ip: getClientAddress(req),
            username: String(username || '').trim() || null,
            attempts: rateState.attempts.length,
            retryAfterMs,
        });
        return sendInvalidCredentials(res, { retryAfterMs });
    }

    const suppliedPassword = typeof password === 'string' ? password : '';
    const expectedPassword = typeof ADMIN_PASS === 'string' ? ADMIN_PASS : '';
    const passwordMatches = suppliedPassword.length === expectedPassword.length &&
        crypto.timingSafeEqual(Buffer.from(suppliedPassword), Buffer.from(expectedPassword));

    if (username === ADMIN_USER && passwordMatches) {
        clearLoginFailures(key);
        const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({ token, username });
    }

    const failureState = recordLoginFailure(key, now);
    logAuthEvent(failureState.isBlocked ? 'login_cooldown' : 'login_failed', {
        ip: getClientAddress(req),
        username: String(username || '').trim() || null,
        attempts: failureState.attempts.length,
        blockedUntil: failureState.blockedUntil || null,
    });
    return sendInvalidCredentials(res, {
        retryAfterMs: failureState.isBlocked ? Math.max(0, failureState.blockedUntil - now) : 0,
    });
});

// ── Stats ──────────────────────────────────────────────────────────────────
app.get('/bot-api/stats', authMiddleware, (req, res) => {
    const memTotal = os.totalmem();
    const memFree  = os.freemem();
    const memUsed  = memTotal - memFree;
    const cpuLoad  = currentCpuLoad;

    let fileCount = 0, fileSize = 0;
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        fileCount = files.length;
        files.forEach(f => {
            try { fileSize += fs.statSync(path.join(DOWNLOAD_DIR, f)).size; } catch {}
        });
    } catch {}

    let userCount = 0;
    try {
        userCount = Object.keys(db.getAll('users') || {}).length;
    } catch {}

    let currentStatus = appState.getStatus();
    let currentNumber = appState.getNumber();
    try {
        const sm = require('./session-manager');
        const cSession = sm.getAll().find(s => s.status === 'Connected');
        if (cSession && currentStatus !== 'Connected') {
            currentStatus = 'Connected';
            currentNumber = cSession.number;
        }
    } catch(e) {}

    function fmtBytes(b) {
        const v = Number(b);
        if (!Number.isFinite(v) || v <= 0) return '0 B';
        if (v < 1024) return Math.round(v) + ' B';
        if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
        if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
        return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function fmtSpeed(bps) {
        const v = Number(bps);
        if (!Number.isFinite(v) || v <= 0) return '0 B/s';
        if (v < 1024) return Math.round(v) + ' B/s';
        if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB/s';
        return (v / 1024 / 1024).toFixed(2) + ' MB/s';
    }

    let sessionCount = 1; // main bot
    try {
        const sm = require('./session-manager');
        sessionCount += sm.getAll().length;
    } catch {}

    let broadcastCount = 0;
    try {
        broadcastCount = db.listBroadcastHistory().length;
    } catch {}

    res.json({
        status: currentStatus,
        number: currentNumber,
        connectedAt: appState.getConnectedAt(),
        uptime: Math.floor(process.uptime()),
        memUsed: Math.round(memUsed / 1024 / 1024),
        memTotal: Math.round(memTotal / 1024 / 1024),
        memPercent: Math.round((memUsed / memTotal) * 100),
        cpuLoad: cpuLoad.toFixed(2),
        platform: os.platform(),
        nodeVersion: process.version,
        userCount,
        sessionCount,
        broadcastCount,
        fileCount,
        fileSizeMB: (fileSize / 1024 / 1024).toFixed(1),
        net: {
            speedRx: fmtSpeed(netSpeedRx),
            speedTx: fmtSpeed(netSpeedTx),
            speedRxRaw: netSpeedRx,
            speedTxRaw: netSpeedTx,
            totalRx: fmtBytes(netTotalRx),
            totalTx: fmtBytes(netTotalTx),
            totalRxRaw: netTotalRx,
            totalTxRaw: netTotalTx,
        },
    });
});

// ── Sessions (Main bot) ────────────────────────────────────────────────────
app.get('/bot-api/bot/session', authMiddleware, (req, res) => {
    const sock = appState.getSocket();
    res.json({
        id: '__main__',
        label: 'Main Bot',
        number: appState.getNumber() || null,
        status: appState.getStatus(),
        connectedAt: appState.getConnectedAt(),
        platform: sock?.authState?.creds?.platform || 'whatsapp',
        isMain: true,
    });
});

app.post('/bot-api/sessions/__main__/paircode', authMiddleware, async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const normalized = normalizeSriLankanPhoneNumber(phone);
    if (!normalized.ok) {
        return res.status(400).json({ error: normalized.error });
    }

    if (appState.getStatus() === 'Connected') return res.status(400).json({ error: 'Already connected' });

    const { startBot, stopBot } = require('./bot');
    try {
        appState.resetQrAttempts();
        appState.setQrPaused(false);
        await stopBot({ status: 'Disconnected' });
        await startBot({ forceRestart: true, clearCredentials: true, pairMode: true, phoneNumber: normalized.phone });

        let code = null;
        const timeoutAt = Date.now() + 12000;
        while (Date.now() < timeoutAt) {
            code = appState.getMainPairCode();
            if (code) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        if (!code) {
            return res.status(504).json({ error: 'Pair code is still being prepared. Please wait a moment and try again.' });
        }

        res.json({ ok: true, code, expiresAt: appState.getMainPairCodeExpiresAt() || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reconnect main bot (after QR pause)
app.post('/bot-api/bot/reconnect', authMiddleware, async (req, res) => {
    const { startBot, stopBot } = require('./bot');
    appState.resetQrAttempts();
    appState.setQrPaused(false);
    await stopBot({ status: 'Disconnected' });
    setTimeout(() => startBot({ forceRestart: true }).catch(() => {}), 500);
    res.json({ ok: true });
});

// Reconnect a multi-session (after QR pause)
app.post('/bot-api/sessions/:id/reconnect', authMiddleware, async (req, res) => {
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.reconnectSession(req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.post('/bot-api/bot/session/logout', authMiddleware, async (req, res) => {
    const sock = appState.getSocket();
    if (!sock) return res.status(400).json({ error: 'No active main session' });
    try {
        const { stopBot } = require('./bot');
        await stopBot({ logout: true, clearCredentials: true, status: 'Logged Out' });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Multi-Session Manager API ──────────────────────────────────────────────
app.get('/bot-api/sessions', authMiddleware, (req, res) => {
    const sessionMgr = require('./session-manager');
    const multiSessions = sessionMgr.getAll();
    res.json([getMainSessionPayload(), ...multiSessions]);
});

app.post('/bot-api/sessions/:id/settings', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { workMode, autoStatus, botEnabled, disabledModules, owner, autoRead, autoTyping, autoReactStatus, nsfwEnabled } = req.body || {};
    
    if (id === '__main__') {
        try {
            if (workMode !== undefined) {
                const normalizedMode = String(workMode).toLowerCase();
                if (['public', 'private', 'self', 'group'].includes(normalizedMode)) {
                    appState.setWorkMode(normalizedMode);
                    db.setSetting('work_mode', normalizedMode);
                }
            }
            if (autoStatus !== undefined) {
                appState.setAutoStatus(autoStatus);
                db.setSetting('auto_status', !!autoStatus);
            }
            if (botEnabled !== undefined) {
                appState.setBotEnabled(botEnabled);
                db.setSetting('bot_enabled', !!botEnabled);
            }
            if (disabledModules !== undefined) {
                const mods = Array.isArray(disabledModules) ? disabledModules.map(m => String(m).toLowerCase()).filter(Boolean) : [];
                appState.setDisabledModules(mods);
            }
            if (owner !== undefined) {
                const normOwner = normalizeOwner(owner);
                appState.setOwner(normOwner);
            }

            const overrides = db.getSetting('main_bot_settings') || {};
            
            // Keep overrides in sync with appState
            if (workMode !== undefined) overrides.workMode = appState.getWorkMode();
            if (autoStatus !== undefined) overrides.autoStatus = appState.getAutoStatus();
            if (botEnabled !== undefined) overrides.botEnabled = appState.getBotEnabled();
            if (disabledModules !== undefined) overrides.disabledModules = appState.getDisabledModules();
            if (owner !== undefined) overrides.owner = appState.getOwner();

            if (autoRead !== undefined) {
                overrides.autoRead = autoRead;
                db.setSetting('autoRead', !!autoRead);
            }
            if (autoTyping !== undefined) {
                overrides.autoTyping = autoTyping;
                db.setSetting('autoTyping', !!autoTyping);
            }
            if (autoReactStatus !== undefined) {
                overrides.autoReactStatus = autoReactStatus;
                db.setSetting('auto_react_status', !!autoReactStatus);
            }
            if (nsfwEnabled !== undefined) {
                overrides.nsfwEnabled = nsfwEnabled;
                db.setSetting('nsfwEnabled', !!nsfwEnabled);
            }
            if (req.body.autoReply !== undefined) {
                overrides.autoReply = req.body.autoReply;
                appState.setAutoReply(!!req.body.autoReply);
            }
            if (req.body.name !== undefined) {
                const cleanName = String(req.body.name).trim();
                overrides.name = cleanName;
                db.setSetting('botName', cleanName);
            }
            if (req.body.prefix !== undefined) {
                const cleanPrefix = String(req.body.prefix).trim().slice(0, 3) || '.';
                overrides.prefix = cleanPrefix;
                db.setSetting('prefix', cleanPrefix);
            }
            if (req.body.aiAutoReply !== undefined) {
                overrides.aiAutoReply = !!req.body.aiAutoReply;
                appState.setAiAutoReply(!!req.body.aiAutoReply);
            }
            if (req.body.aiAutoVoice !== undefined) {
                overrides.aiAutoVoice = !!req.body.aiAutoVoice;
                appState.setAiAutoVoice(!!req.body.aiAutoVoice);
            }
            if (req.body.aiAutoPersona !== undefined) {
                overrides.aiAutoPersona = String(req.body.aiAutoPersona);
                appState.setAiAutoPersona(overrides.aiAutoPersona);
            }
            if (req.body.aiAutoLang !== undefined) {
                overrides.aiAutoLang = String(req.body.aiAutoLang);
                appState.setAiAutoLang(overrides.aiAutoLang);
            }
            if (req.body.aiGroupMode !== undefined) {
                overrides.aiGroupMode = String(req.body.aiGroupMode);
                appState.setAiGroupMode(overrides.aiGroupMode);
            }
            if (req.body.aiSystemInstruction !== undefined) {
                overrides.aiSystemInstruction = String(req.body.aiSystemInstruction);
                appState.setAiSystemInstruction(overrides.aiSystemInstruction);
            }
            if (req.body.aiMaxWords !== undefined) {
                overrides.aiMaxWords = parseInt(req.body.aiMaxWords) || 30;
                appState.setAiMaxWords(overrides.aiMaxWords);
            }
            if (req.body.aiAutoWakeWords !== undefined) {
                appState.setAiAutoWakeWords(req.body.aiAutoWakeWords);
            }
            if (req.body.aiAutoBurstShield !== undefined) {
                appState.setAiAutoBurstShield(!!req.body.aiAutoBurstShield);
            }
            if (req.body.aiAutoLightReact !== undefined) {
                appState.setAiAutoLightReact(!!req.body.aiAutoLightReact);
            }
            if (req.body.aiAutoMemoryDepth !== undefined) {
                appState.setAiAutoMemoryDepth(parseInt(req.body.aiAutoMemoryDepth) || 6);
            }
            if (req.body.mentionReply !== undefined) overrides.mentionReply = String(req.body.mentionReply);
            if (req.body.alwaysOnline !== undefined) overrides.alwaysOnline = !!req.body.alwaysOnline;
            if (req.body.antiCall !== undefined) overrides.antiCall = !!req.body.antiCall;
            if (req.body.antiDelete !== undefined) {
                const existingAd = overrides.antiDelete || {};
                if (typeof req.body.antiDelete === 'object') {
                    overrides.antiDelete = {
                        ...existingAd,
                        ...req.body.antiDelete,
                        filters: {
                            ...(existingAd.filters || {}),
                            ...(req.body.antiDelete.filters || {})
                        }
                    };
                } else {
                    overrides.antiDelete = !!req.body.antiDelete;
                }
            }
            if (req.body.autoBio !== undefined) overrides.autoBio = !!req.body.autoBio;
            if (req.body.alwaysRecording !== undefined) overrides.alwaysRecording = !!req.body.alwaysRecording;
            if (req.body.autoViewStatus !== undefined) {
                overrides.autoViewStatus = !!req.body.autoViewStatus;
                db.setSetting('auto_view_status', overrides.autoViewStatus);
            }
            if (req.body.antiViewOnce !== undefined) {
                overrides.antiViewOnce = !!req.body.antiViewOnce;
                appState.setAntiViewOnceEnabled(overrides.antiViewOnce);
            }
            if (req.body.antiGroupJoin !== undefined) overrides.antiGroupJoin = !!req.body.antiGroupJoin;
            if (req.body.privacyAutoCleanup !== undefined) overrides.privacyAutoCleanup = !!req.body.privacyAutoCleanup;
            if (req.body.privacyMaxStorageMb !== undefined) overrides.privacyMaxStorageMb = parseInt(req.body.privacyMaxStorageMb) || 500;
            if (req.body.limits !== undefined && typeof req.body.limits === 'object' && req.body.limits) {
                const lim = req.body.limits;
                overrides.limits = {
                    cmdPerMin: parseInt(lim.cmdPerMin) || 0,
                    aiPerMin: parseInt(lim.aiPerMin) || 0,
                    downloadCooldownSec: parseInt(lim.downloadCooldownSec) || 0,
                    maxConcurrentDownloads: parseInt(lim.maxConcurrentDownloads) || 3,
                    maxFileSizeMb: parseInt(lim.maxFileSizeMb) || 100,
                    broadcastDelayMs: parseInt(lim.broadcastDelayMs) || 0,
                    schedulerDelayMs: parseInt(lim.schedulerDelayMs) || 0,
                };
            }

            db.setSetting('main_bot_settings', overrides);
            db.flush();
            const sock = appState.getSocket();
            if (sock && (
                req.body.alwaysOnline !== undefined ||
                req.body.alwaysRecording !== undefined ||
                req.body.autoBio !== undefined ||
                req.body.name !== undefined
            )) {
                const { refreshRuntimeFeatures } = require('./bot');
                refreshRuntimeFeatures('__main__');
            }
            
            const session = getMainSessionPayload();
            io.emit('session:update', session);
            return res.json({ ok: true, session });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.updateSessionSettings(id, req.body);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.post('/bot-api/bot/api-keys', authMiddleware, (req, res) => {
    const { gemini, openrouter, groq } = req.body || {};
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, '');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    // We require config dynamically to ensure we have the object reference
    const cfg = require('./config');

    const updates = {
        GEMINI_API_KEY: gemini,
        OPENROUTER_API_KEY: openrouter,
        GROQ_API_KEY: groq
    };

    let changed = false;
    for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
            const regex = new RegExp(`^${key}=.*`, 'm');
            const cleanValue = String(value).trim();
            if (envContent.match(regex)) {
                envContent = envContent.replace(regex, `${key}=${cleanValue}`);
            } else {
                envContent += `\n${key}=${cleanValue}`;
            }
            cfg[key] = cleanValue;
            process.env[key] = cleanValue;
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(envPath, envContent.trim() + '\n');
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'No keys provided' });
    }
});

app.delete('/bot-api/bot/ai-history', authMiddleware, (req, res) => {
    try {
        const handler = require('./lib/handler');
        if (handler.chatHistory && typeof handler.chatHistory.clear === 'function') {
            handler.chatHistory.clear();
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/bot-api/bot/check-ai-keys', authMiddleware, async (req, res) => {
    try {
        const ai = require('./lib/commands/ai');
        const results = await ai.validateKeys();
        res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/sessions', authMiddleware, async (req, res) => {
    const { id, pairMode, phone } = req.body || {};
    let normalizedPhone = null;
    if (!id || !/^[a-zA-Z0-9_-]{2,30}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid session ID. Use 2-30 characters (A-Z, 0-9, _, -) and no spaces.' });
    }
    if (pairMode && phone) {
        const normalized = normalizeSriLankanPhoneNumber(phone);
        if (!normalized.ok) return res.status(400).json({ error: normalized.error });
        normalizedPhone = normalized.phone;
    }
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.createSession(id, { pairMode: !!pairMode, phone: normalizedPhone || phone || '' });
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.get('/bot-api/commands/categories', authMiddleware, apiHandler((req, res) => {
    const { getCategories } = require('./lib/handler');
    res.json(getCategories());
}));

app.delete('/bot-api/sessions/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    if (id === '__main__') {
        try {
            const { stopBot } = require('./bot');
            await stopBot({ logout: true, clearCredentials: true, status: 'Idle (Removed)' });
            const session = getMainSessionPayload();
            io.emit('session:update', session);
            return res.json({ ok: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.removeSession(id);
    res.json(result);
});

app.post('/bot-api/sessions/:id/paircode', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    if (id === '__main__') {
        try {
            const { startBot } = require('./bot');
            const appState = require('./state');
            // If already connected, can't pair
            if (appState.getStatus() === 'Connected') return res.status(400).json({ error: 'Main bot is already connected' });
            
            // Re-initialize main bot in pair mode
            await startBot({ forceRestart: true, pairMode: true, phoneNumber: phone });
            res.json({ ok: true, message: 'Main bot pairing initiated. Wait for code.' });
        } catch (e) { res.status(500).json({ error: e.message }); }
        return;
    }

    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.requestPairCode(id, phone);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.get('/bot-api/sessions/:id/qr', authMiddleware, (req, res) => {
    const { id } = req.params;
    if (id === '__main__') {
        if (appState.getStatus() === 'Connected') return res.status(400).json({ error: 'Bot is already linked! (Connected)' });
        const qr = appState.getMainQr();
        if (!qr) return res.status(404).json({ error: 'QR not ready yet. Please wait or refresh.' });
        return res.json({ qrCode: qr });
    }
    const sessionMgr = require('./session-manager');
    const entry = sessionMgr.get(id);
    if (!entry) return res.status(404).json({ error: 'Session not found' });
    if (!entry.qrDataUrl) return res.status(404).json({ error: 'No QR available' });
    res.json({ qrCode: entry.qrDataUrl });
});

app.post('/bot-api/sessions/:id/disconnect', authMiddleware, async (req, res) => {
    const { id } = req.params;
    if (id === '__main__') {
        const sock = appState.getSocket();
        if (!sock) return res.status(400).json({ error: 'Main bot not connected' });
        try {
            const { stopBot } = require('./bot');
            await stopBot({ logout: true, clearCredentials: true, status: 'Logged Out' });
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
        return;
    }
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.disconnectSession(id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// ── Per-session runtime ops (clear error, clear caches, sync groups, etc.) ──
app.post('/bot-api/sessions/:id/runtime', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const op = String(req.body?.op || '').trim();
    if (!op) return res.status(400).json({ error: 'Missing op' });
    try {
        if (id === '__main__') {
            const overrides = db.getSetting('main_bot_settings') || {};
            if (op === 'clearError') {
                overrides.lastError = null;
                if (typeof appState.clearLastError === 'function') appState.clearLastError();
            } else if (op === 'clearQrPause') {
                if (typeof appState.setQrPaused === 'function') appState.setQrPaused(false);
            } else if (op === 'clearPairCode') {
                if (typeof appState.setMainPairCode === 'function') appState.setMainPairCode(null);
            } else if (op === 'clearCache') {
                overrides.lastError = null;
            } else if (op === 'syncGroups') {
                const sock = appState.getSocket();
                if (sock && typeof sock.groupFetchAllParticipating === 'function') {
                    try { await sock.groupFetchAllParticipating(); } catch { /* best-effort */ }
                }
            } else {
                return res.status(400).json({ error: 'Unknown op' });
            }
            db.setSetting('main_bot_settings', overrides);
            db.flush();
            const session = getMainSessionPayload();
            io.emit('session:update', session);
            return res.json({ ok: true, session });
        }
        const sessionMgr = require('./session-manager');
        const result = sessionMgr.runRuntimeOp ? await sessionMgr.runRuntimeOp(id, op) : { ok: true };
        if (result?.error) return res.status(400).json(result);
        return res.json(result || { ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-session group listing ──────────────────────────────────────────────
app.get('/bot-api/sessions/:id/groups', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const allGroups = db.getAll('groups') || {};
        const list = Object.entries(allGroups)
            .filter(([jid, group]) => {
                if (!group) return false;
                const owner = group.botSessionId || group.sessionId || '__main__';
                return owner === id;
            })
            .map(([jid, group]) => ({
                jid,
                name: group.name || group.subject || jid,
                memberCount: group.memberCount || group.size || 0,
                welcome: !!group.welcome,
                goodbye: !!group.goodbye,
                antiLink: !!group.antiLink,
                aiMode: group.aiMode || null,
            }));
        res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Broadcast ──────────────────────────────────────────────────────────────
app.post('/bot-api/broadcast', authMiddleware, async (req, res) => {
    const { message, targets, sessionId } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const session = getSocketForSession(sessionId);
    if (!session.sock) return res.status(400).json({ error: `${session.label} is not connected` });

    const jids = Array.isArray(targets) && targets.length
        ? resolveTargets('custom', targets)
        : resolveTargets('all');

    const results = { sent: 0, failed: 0, total: jids.length, errors: [] };
    for (const jid of jids.slice(0, 50)) {
        try {
            await session.sock.sendMessage(jid, { text: message });
            results.sent++;
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {
            results.failed++;
            results.errors.push({ jid, error: e.message });
        }
    }

    db.addBroadcastHistory({
        id: Date.now().toString(),
        message: message.substring(0, 200),
        targets: (targets || []).slice(0, 5),
        sessionId: session.sessionId,
        sent: results.sent,
        failed: results.failed,
        total: results.total,
        sentAt: new Date().toISOString(),
        status: results.failed === 0 ? 'success' : results.sent === 0 ? 'failed' : 'partial',
    });

    res.json(results);
});

app.get('/bot-api/broadcast/history', authMiddleware, (req, res) => {
    res.json(db.listBroadcastHistory());
});

// ── Bot Control ────────────────────────────────────────────────────────────
app.post('/bot-api/restart', authMiddleware, (req, res) => {
    appState.requestRestart();
    res.json({ ok: true, message: 'Restarting bot...' });
    setTimeout(() => {
        if (appState.isRestartRequested()) {
            appState.clearRestart();
            const { startBot } = require('./bot');
            startBot({ forceRestart: true }).catch(console.error);
        }
    }, 2000);
});

// ── Menu UI Preview (V4.2) ────────────────────────────────────────────────
// Returns a server-rendered preview of the bot-wide menu system so the
// dashboard's Menu UI page can show *exactly* what a WhatsApp client would
// see for a given role / button mode. We reuse lib/ui directly so the
// preview never drifts from the real implementation.
app.get('/bot-api/menu-ui/preview', authMiddleware, (req, res) => {
    try {
        const ui = require('./lib/ui');
        const role       = String(req.query.role       || 'normal');
        const buttonMode = String(req.query.buttonMode || 'auto');
        const categoryId = req.query.category ? String(req.query.category) : null;
        // `roleOverride` is honoured by lib/ui/role-menu.js#getUserRole so
        // the dropdown actually changes what the preview renders. Without
        // it the synthetic sender JID would always resolve to 'normal' and
        // owner / premium-only categories would be invisible regardless of
        // the dropdown selection.
        const ctx = {
            sender:   '94700000000@s.whatsapp.net',
            chatJid:  '94700000000@s.whatsapp.net',
            role,
            roleOverride: role,
            buttonMode,
            botName:  runtimeSettings.getBotName(),
            prefix:   runtimeSettings.getPrefix(),
            pushName: 'Preview User',
        };
        const menu = categoryId
            ? ui.buildCategoryMenu(categoryId, ctx)
            : ui.buildTopLevelMenu(ctx);
        if (!menu) return res.status(404).json({ error: 'Unknown category' });
        // Run the same item filter / role pipeline `sendMenu` uses.
        const filtered = (typeof ui.filterItemsByRole === 'function'
            ? ui.filterItemsByRole(menu.items || [], role, ctx)
            : (menu.items || []));
        const items = filtered.map((it, i) => ({
            ...it,
            index: i + 1,
            label: it.label || it.title || `Option ${i + 1}`,
        }));
        // Build the styled box-text menu using the same builder.
        let text = '';
        try {
            const builder = require('./lib/ui/menu-builder');
            text = builder.buildMenuText(menu, items, { ...ctx, role, buttonMode });
        } catch (_) { text = String(menu.text || menu.body || ''); }
        res.json({
            ok: true,
            mode: buttonMode,
            role,
            menu: {
                id: menu.id,
                type: menu.type || 'menu',
                title: menu.title || 'Select Option',
                buttonText: menu.buttonText || '📋 Choose One',
                sectionTitle: menu.sectionTitle || 'Options',
                footer: menu.footer || `${runtimeSettings.getBotName()} • V4.2`,
                items,
                text,
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Settings ───────────────────────────────────────────────────────────────
app.get('/bot-api/settings', authMiddleware, (req, res) => {
    res.json(getSettingsPayload());
});

app.post('/bot-api/settings', authMiddleware, (req, res) => {
    const { 
        botName, prefix, autoRead, autoTyping, nsfwEnabled, workMode, autoViewStatus, autoReactStatus,
        fleetSoloMode,
        buttonMode, roleMenuMode,
        aiAutoReply, aiAutoPersona, aiAutoLang, aiAutoVoice, aiGroupMode, aiSystemInstruction, aiMaxWords,
        aiAutoWakeWords, aiAutoBurstShield, aiAutoLightReact, aiAutoMemoryDepth
    } = req.body || {};
    try {
        if (botName !== undefined) db.setSetting('botName', String(botName).trim());
        if (prefix !== undefined) {
            const normalizedPrefix = String(prefix).trim() || '.';
            db.setSetting('prefix', normalizedPrefix.slice(0, 3));
        }
        if (autoRead !== undefined) db.setSetting('autoRead', !!autoRead);
        if (autoTyping !== undefined) db.setSetting('autoTyping', !!autoTyping);
        if (nsfwEnabled !== undefined) db.setSetting('nsfwEnabled', !!nsfwEnabled);
        if (workMode !== undefined) {
            const normalizedWorkMode = ['public', 'private', 'self', 'group'].includes(String(workMode).toLowerCase())
                ? String(workMode).toLowerCase()
                : 'public';
            db.setSetting('work_mode', normalizedWorkMode);
        }
        if (autoViewStatus !== undefined) db.setSetting('auto_view_status', !!autoViewStatus);
        if (autoReactStatus !== undefined) db.setSetting('auto_react_status', !!autoReactStatus);
        if (fleetSoloMode !== undefined) db.setSetting('fleet_solo_mode', !!fleetSoloMode);

        // Bot-wide UI Mode (Button Mode + Role Menu Mode) — populated by the
        // V4.2 Settings panel. Validation lives in state.js.
        if (buttonMode   !== undefined && typeof appState.setButtonMode   === 'function') appState.setButtonMode(String(buttonMode));
        if (roleMenuMode !== undefined && typeof appState.setRoleMenuMode === 'function') appState.setRoleMenuMode(String(roleMenuMode));

        // AI Settings - Aligning with canonical camelCase fields
        if (aiAutoReply !== undefined) appState.setAiAutoReply(!!aiAutoReply);
        if (aiAutoPersona !== undefined) appState.setAiAutoPersona(String(aiAutoPersona));
        if (aiAutoLang !== undefined) appState.setAiAutoLang(String(aiAutoLang));
        if (aiAutoVoice !== undefined) appState.setAiAutoVoice(!!aiAutoVoice);
        if (aiGroupMode !== undefined) appState.setAiGroupMode(String(aiGroupMode));
        if (aiSystemInstruction !== undefined) appState.setAiSystemInstruction(String(aiSystemInstruction));
        if (aiMaxWords !== undefined) appState.setAiMaxWords(Number(aiMaxWords) || 30);
        if (aiAutoWakeWords !== undefined) appState.setAiAutoWakeWords(aiAutoWakeWords);
        if (aiAutoBurstShield !== undefined) appState.setAiAutoBurstShield(!!aiAutoBurstShield);
        if (aiAutoLightReact !== undefined) appState.setAiAutoLightReact(!!aiAutoLightReact);
        if (aiAutoMemoryDepth !== undefined) appState.setAiAutoMemoryDepth(Number(aiAutoMemoryDepth) || 6);

        db.flush();
        const payload = getSettingsPayload();
        io.emit('settings:update', payload);
        res.json({ ok: true, settings: payload });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});




// ── File Manager ───────────────────────────────────────────────────────────
app.get('/bot-api/files', authMiddleware, (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR).map(name => {
            const fPath = path.join(DOWNLOAD_DIR, name);
            try {
                const stat = fs.statSync(fPath);
                return {
                    name,
                    sizeMB: (stat.size / 1024 / 1024).toFixed(2),
                    modified: stat.mtime.toISOString(),
                    ext: path.extname(name).slice(1).toLowerCase() || 'file',
                };
            } catch { return null; }
        }).filter(Boolean).sort((a, b) => new Date(b.modified) - new Date(a.modified));
        res.json(files);
    } catch (e) { res.status(500).json({ error: e.message || 'Unable to read files' }); }
});

app.delete('/bot-api/files/:name', authMiddleware, (req, res) => {
    const name = path.basename(req.params.name);
    const fPath = path.join(DOWNLOAD_DIR, name);
    if (!fs.existsSync(fPath)) return res.status(404).json({ error: 'File not found' });
    try {
        fs.unlinkSync(fPath);
        res.json({ ok: true, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── View Once Gallery ──────────────────────────────────────────────────────
// Scoped middleware: also accepts ?token= for img/video src attributes
function authWithQueryToken(req, res, next) {
    if (!extractBearerToken(req.headers.authorization) && req.query.token) {
        req.headers.authorization = 'Bearer ' + req.query.token;
    }
    authMiddleware(req, res, next);
}

app.get('/bot-api/viewonce', authMiddleware, (req, res) => {
    try {
        const log = getViewOnceLog();
        const voDir = VO_DIR;
        const enriched = log.map((entry) => {
            const fPath = path.join(voDir, entry.filename);
            let exists = false;
            let sizeMB = '0.00';
            try {
                const stat = fs.statSync(fPath);
                exists = true;
                sizeMB = (stat.size / 1024 / 1024).toFixed(2);
            } catch { /* file may have been removed manually */ }
            return { ...entry, exists, sizeMB };
        }).filter((e) => e.exists).reverse();
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to read view-once gallery' });
    }
});

app.get('/bot-api/viewonce/:name', authWithQueryToken, (req, res) => {
    const name = path.basename(req.params.name);
    const fPath = path.join(VO_DIR, name);
    if (!fs.existsSync(fPath)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(fPath);
});

app.get('/bot-api/viewonce/:name/download', authWithQueryToken, (req, res) => {
    const name = path.basename(req.params.name);
    const fPath = path.join(VO_DIR, name);
    if (!fs.existsSync(fPath)) return res.status(404).json({ error: 'File not found' });
    res.download(fPath, name);
});

app.delete('/bot-api/viewonce/:name', authMiddleware, (req, res) => {
    const name = path.basename(req.params.name);
    const fPath = path.join(VO_DIR, name);
    if (!fs.existsSync(fPath)) return res.status(404).json({ error: 'File not found' });
    try {
        fs.unlinkSync(fPath);
        removeLogEntry(name);
        res.json({ ok: true, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Commands List ──────────────────────────────────────────────────────────
app.get('/bot-api/commands', authMiddleware, (req, res) => {
    try {
        res.json(loadCommandCatalog());
    } catch (e) { res.json([]); }
});

app.patch('/bot-api/commands/:name', authMiddleware, (req, res) => {
    const name = decodeURIComponent(req.params.name || '');
    const { enabled } = req.body || {};
    try {
        if (enabled !== undefined) {
            const nextEnabled = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
            db.setCommandEnabled(name, nextEnabled);
            const catalog = loadCommandCatalog();
            const command = catalog.find(c => c.name === name);
            return res.json({ ok: true, command });
        }
        res.json({ ok: true, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/commands/toggle-all', authMiddleware, (req, res) => {
    const { enabled, category } = req.body || {};
    try {
        const nextEnabled = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
        const catalog = loadCommandCatalog();
        const updated = [];
        catalog.forEach((command) => {
            if (category && command.category !== category) return;
            db.setCommandEnabled(command.name, nextEnabled);
            command.enabled = nextEnabled;
            updated.push(command);
        });
        res.json({ ok: true, updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Groups Management ──────────────────────────────────────────────────────
app.get('/bot-api/groups', authMiddleware, (req, res) => {
    res.json(db.listGroups());
});

app.post('/bot-api/groups/upsert', authMiddleware, (req, res) => {
    const body = req.body || {};
    const jid = normalizeGroupJid(body.jid);
    if (!jid) return res.status(400).json({ error: 'Valid group JID required' });
    try {
        db.update('groups', jid, {
            name: String(body.name || '').trim() || jid.split('@')[0],
            sessionId: normalizeSessionId(body.sessionId),
            memberCount: parseNumberValue(body.memberCount, 0),
            isMuted: parseBooleanFlag(body.isMuted, false),
            antiLink: parseBooleanFlag(body.antiLink, false),
            antiSpam: parseBooleanFlag(body.antiSpam, false),
            welcome: parseBooleanFlag(body.welcome, false),
            welcomeEnabled: parseBooleanFlag(body.welcome, false),
            goodbye: parseBooleanFlag(body.goodbye, false),
            goodbyeEnabled: parseBooleanFlag(body.goodbye, false),
            nsfw: parseBooleanFlag(body.nsfw, false),
        });
        const group = db.listGroups().find((item) => item.jid === jid) || null;
        if (group) io.emit('group:update', group);
        res.json({ ok: true, group });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/bot-api/groups/:jid', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const patch = { ...(req.body || {}) };
        if (Object.prototype.hasOwnProperty.call(patch, 'sessionId')) {
            patch.sessionId = normalizeSessionId(patch.sessionId);
        }
        db.update('groups', jid, patch);
        const group = db.listGroups().find((item) => item.jid === jid) || null;
        if (group) io.emit('group:update', group);
        res.json({ ok: true, group });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/groups/:jid', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        db.delete('groups', jid);
        io.emit('group:removed', { jid });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Scheduler ──────────────────────────────────────────────────────────────
app.get('/bot-api/scheduler', authMiddleware, (req, res) => {
    const items = db.listScheduler().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    res.json(items);
});

app.post('/bot-api/scheduler', authMiddleware, (req, res) => {
    const { message, sessionId, targetType, targets, scheduledAt } = req.body || {};
    if (!message || !scheduledAt) return res.status(400).json({ error: 'message and scheduledAt required' });
    if (!['all', 'groups', 'custom'].includes(targetType || 'all')) {
        return res.status(400).json({ error: 'Invalid target type' });
    }
    try {
        const item = {
            id: Date.now().toString(),
            message,
            sessionId: normalizeSessionId(sessionId),
            targetType: targetType || 'all',
            targets: targets || [],
            scheduledAt,
            sent: false,
            sentAt: null,
            failed: false,
            failedAt: null,
            lastError: null,
            sentCount: 0,
            failedCount: 0,
            attemptedTargets: 0,
            createdAt: new Date().toISOString(),
        };
        const created = db.addSchedulerItem(item);
        io.emit('scheduler:update', created);
        res.json(created);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/bot-api/scheduler/:id', authMiddleware, (req, res) => {
    const current = db.listScheduler().find((item) => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Scheduled job not found' });
    if (current.sent) return res.status(400).json({ error: 'Sent jobs cannot be edited' });
    if (current.failed) return res.status(400).json({ error: 'Use retry for failed jobs' });

    const { message, sessionId, targetType, targets, scheduledAt } = req.body || {};
    if (targetType === 'custom' && (!Array.isArray(targets) || !targets.length)) {
        return res.status(400).json({ error: 'Custom targets required' });
    }
    if (targetType !== undefined && !['all', 'groups', 'custom'].includes(targetType || 'all')) {
        return res.status(400).json({ error: 'Invalid target type' });
    }
    if (scheduledAt !== undefined && !Number.isFinite(Date.parse(scheduledAt))) {
        return res.status(400).json({ error: 'Invalid scheduledAt value' });
    }

    try {
        const updated = db.updateSchedulerItem(req.params.id, {
            ...(message !== undefined ? { message: String(message).trim() } : {}),
            ...(sessionId !== undefined ? { sessionId: normalizeSessionId(sessionId) } : {}),
            ...(targetType !== undefined ? { targetType: targetType || 'all' } : {}),
            ...(targets !== undefined ? { targets: Array.isArray(targets) ? targets : [] } : {}),
            ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        });
        if (updated) io.emit('scheduler:update', updated);
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/scheduler/:id/retry', authMiddleware, (req, res) => {
    const current = db.listScheduler().find((item) => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Scheduled job not found' });
    if (!current.failed) return res.status(400).json({ error: 'Only failed jobs can be retried' });

    const scheduledAt = req.body?.scheduledAt && Number.isFinite(Date.parse(req.body.scheduledAt))
        ? req.body.scheduledAt
        : new Date().toISOString();

    try {
        const updated = db.updateSchedulerItem(req.params.id, {
            sent: false,
            sentAt: null,
            failed: false,
            failedAt: null,
            lastError: null,
            sentCount: 0,
            failedCount: 0,
            attemptedTargets: 0,
            scheduledAt,
        });
        if (updated) io.emit('scheduler:update', updated);
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/scheduler/:id', authMiddleware, (req, res) => {
    try {
        const ok = db.removeSchedulerItem(req.params.id);
        if (ok) io.emit('scheduler:removed', { id: req.params.id });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-Reply ─────────────────────────────────────────────────────────────
app.get('/bot-api/auto-reply', authMiddleware, (req, res) => {
    res.json(db.listAutoReply());
});

app.post('/bot-api/auto-reply', authMiddleware, (req, res) => {
    const { trigger, response, matchType, caseSensitive, groupsOnly, pmOnly } = req.body || {};
    if (!trigger || !response) return res.status(400).json({ error: 'trigger and response required' });
    if (groupsOnly && pmOnly) return res.status(400).json({ error: 'Choose either groupsOnly or pmOnly, not both' });
    if (matchType === 'regex') {
        try {
            new RegExp(String(trigger), caseSensitive ? '' : 'i');
        } catch (e) {
            return res.status(400).json({ error: `Invalid regex: ${e.message}` });
        }
    }
    try {
        const rule = {
            id: Date.now().toString(),
            trigger: String(trigger).trim(),
            response: String(response).trim(),
            matchType: matchType || 'exact',
            caseSensitive: !!caseSensitive,
            groupsOnly: !!groupsOnly,
            pmOnly: !!pmOnly,
            enabled: true,
        };
        const created = db.addAutoReply(rule);
        io.emit('auto-reply:update', created);
        res.json(created);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/bot-api/auto-reply/:id', authMiddleware, (req, res) => {
    const patch = req.body || {};
    if (patch.trigger !== undefined && !String(patch.trigger).trim()) {
        return res.status(400).json({ error: 'trigger is required' });
    }
    if (patch.response !== undefined && !String(patch.response).trim()) {
        return res.status(400).json({ error: 'response is required' });
    }
    const current = db.listAutoReply().find((rule) => rule.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Rule not found' });
    const nextTrigger = patch.trigger !== undefined ? String(patch.trigger).trim() : undefined;
    const nextMatchType = patch.matchType !== undefined ? (patch.matchType || 'exact') : undefined;
    const nextCaseSensitive = patch.caseSensitive !== undefined ? !!patch.caseSensitive : undefined;
    const nextGroupsOnly = patch.groupsOnly !== undefined ? !!patch.groupsOnly : undefined;
    const nextPmOnly = patch.pmOnly !== undefined ? !!patch.pmOnly : undefined;
    const finalTrigger = nextTrigger !== undefined ? nextTrigger : String(current.trigger || '').trim();
    const finalMatchType = nextMatchType !== undefined ? nextMatchType : (current.matchType || 'exact');
    const finalCaseSensitive = nextCaseSensitive !== undefined ? nextCaseSensitive : !!current.caseSensitive;
    const finalGroupsOnly = nextGroupsOnly !== undefined ? nextGroupsOnly : !!current.groupsOnly;
    const finalPmOnly = nextPmOnly !== undefined ? nextPmOnly : !!current.pmOnly;
    if (finalGroupsOnly && finalPmOnly) {
        return res.status(400).json({ error: 'Choose either groupsOnly or pmOnly, not both' });
    }
    if (finalMatchType === 'regex') {
        try {
            new RegExp(finalTrigger, finalCaseSensitive ? '' : 'i');
        } catch (e) {
            return res.status(400).json({ error: `Invalid regex: ${e.message}` });
        }
    }
    try {
        const updated = db.updateAutoReply(req.params.id, {
            ...(patch.trigger !== undefined ? { trigger: nextTrigger } : {}),
            ...(patch.response !== undefined ? { response: String(patch.response).trim() } : {}),
            ...(patch.matchType !== undefined ? { matchType: nextMatchType } : {}),
            ...(patch.caseSensitive !== undefined ? { caseSensitive: nextCaseSensitive } : {}),
            ...(patch.groupsOnly !== undefined ? { groupsOnly: nextGroupsOnly } : {}),
            ...(patch.pmOnly !== undefined ? { pmOnly: nextPmOnly } : {}),
            ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
        });
        io.emit('auto-reply:update', updated);
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/auto-reply/:id', authMiddleware, (req, res) => {
    try {
        db.removeAutoReply(req.params.id);
        io.emit('auto-reply:removed', { id: req.params.id });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Users Management ───────────────────────────────────────────────────────
app.get('/bot-api/users', authMiddleware, (req, res) => {
    res.json(db.listUsers());
});

app.post('/bot-api/users/upsert', authMiddleware, (req, res) => {
    const body = req.body || {};
    const jid = normalizeUserJid(body.jid || body.number);
    if (!jid) return res.status(400).json({ error: 'Valid phone number or user JID required' });
    try {
        const current = db.get('users', jid) || {};
        db.upsertUser(jid, {
            number: String(body.number || jid.split('@')[0]).replace(/\D/g, ''),
            pushName: String(body.pushName || '').trim() || current.pushName || null,
            balance: parseNumberValue(body.balance, current.balance || 0),
            wins: parseNumberValue(body.wins, current.wins || 0),
            losses: parseNumberValue(body.losses, current.losses || 0),
            premium: parseBooleanFlag(body.premium, current.premium || false),
            banned: parseBooleanFlag(body.banned, current.banned || false),
            lastSeen: body.lastSeen || current.lastSeen || new Date().toISOString(),
            joinedAt: current.joinedAt || new Date().toISOString(),
        });
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/users/:jid/premium', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const body = req.body || {};
        const current = db.get('users', jid) || {};
        const newValue = body.premium !== undefined ? parseBooleanFlag(body.premium, false) : !current.premium;
        db.setUserPremium(jid, newValue);
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, premium: newValue, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/users/:jid/owner', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const verified = db.getSetting('verified_owners') || [];
        const normalizedJid = normalizeUserJid(jid) || jid;
        const identityKey = db.getManagedIdentityKey(normalizedJid);
        const index = verified.findIndex((entry) => db.getManagedIdentityKey(entry) === identityKey);
        const body = req.body || {};
        const newValue = body.isOwner !== undefined
            ? parseBooleanFlag(body.isOwner, false)
            : index === -1;
        if (newValue) {
            if (index === -1) verified.push(normalizedJid);
            const current = db.get('users', jid) || {};
            db.upsertUser(jid, {
                number: current.number || jid.split('@')[0],
                pushName: current.pushName || null,
                joinedAt: current.joinedAt || new Date().toISOString(),
                lastSeen: current.lastSeen || new Date().toISOString(),
            });
        } else if (index > -1) {
            verified.splice(index, 1);
        }
        db.setSetting('verified_owners', verified);
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, isOwner: newValue, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/users/:jid/ban', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const body = req.body || {};
        const newValue = body.banned !== undefined ? parseBooleanFlag(body.banned, false) : !db.isUserBanned(jid);
        db.setUserBanned(jid, newValue);
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, banned: newValue, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/users/:jid', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        db.deleteUser(jid);
        io.emit('user:removed', { jid });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── Stats & Data ──────────────────────────────────────────────────────────
// ── Logs ───────────────────────────────────────────────────────────────────
app.get('/bot-api/logs', authMiddleware, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    res.json(appState.getLogs().slice(-limit).reverse());
});
app.delete('/bot-api/logs', authMiddleware, (req, res) => {
    appState.getLogs().length = 0;
    res.json({ ok: true });
});

// ── WebSocket ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    logger('Dashboard client connected: ' + socket.id);
    socket.emit('update', {
        status: appState.getStatus(),
        number: appState.getNumber(),
    });
    appState.getLogs().slice(-30).forEach(l => socket.emit('log', l));
});

// ── Fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
    if (req.path.startsWith('/bot-api/')) return res.status(404).json({ error: 'Not found' });
    res.redirect('/dashboard');
});

// ── Start ──────────────────────────────────────────────────────────────────
const HOST = process.env.HOST || '0.0.0.0';

function startDashboard() {
    server.listen(PORT, HOST, () => {
        markDashboardStarted();
        console.log(`🌐 Dashboard: http://${HOST}:${PORT}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`❌ Port ${PORT} is already in use!`);
            console.log(`💡 Try running: "npx kill-port ${PORT}" or close the other bot window.`);
        } else {
            console.error('Server Error:', err);
        }
    });
}

async function startDashboardAsync() {
    if (server.listening) {
        markDashboardStarted();
        return Promise.resolve(server);
    }

    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('listening', onListening);
            if (err.code === 'EADDRINUSE') {
                console.error(`Dashboard port ${PORT} is already in use.`);
                console.log(`Try running: "npx kill-port ${PORT}" or close the other bot window.`);
            } else {
                console.error('Server Error:', err);
            }
            reject(err);
        };

        const onListening = () => {
            server.off('error', onError);
            markDashboardStarted();
            console.log(`Dashboard: http://${HOST}:${PORT}`);
            resolve(server);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(PORT, HOST);
    });
}

module.exports = {
    startDashboard: startDashboardAsync,
    io,
    app,
    getSettingsPayload,
    getMainSessionPayload,
    __internals: {
        clearLoginFailures,
        getLoginRateLimitState,
        getSocketForSession,
        loginAttempts,
        recordLoginFailure,
        resolveTargets,
        resolveMessageTargets,
        sendInvalidCredentials,
    },
};
