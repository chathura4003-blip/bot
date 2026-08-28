require('dotenv').config({ path: require('path').join(__dirname, '.env') });
process.env.CHMD_ENV_PRELOADED = 'true';
process.env.CHMD_ENV_SOURCE = require('path').join(__dirname, '.env');

// ---------------------------------------------------------------------------
// Suppress benign Signal/Baileys decryption noise
// ---------------------------------------------------------------------------
// libsignal & Baileys log "Bad MAC", "MessageCounterError", "Failed to decrypt
// message with any known session..." straight to console.error / console.log.
// These errors are handled internally (Baileys retries automatically) but
// flood the dashboard log. Filter only the well-known harmless lines.
const NOISY_PATTERNS = [
    /Failed to decrypt message with any known session/i,
    /Session error:.*MessageCounterError/i,
    /Session error:.*Bad MAC/i,
    /MessageCounterError: Key used already or never filled/i,
    /Error: Bad MAC Error: Bad MAC/i,
    /at SessionCipher\./i,
    /at Object\.verifyMAC/i,
    /at _asyncQueueExecutor/i,
    /libsignal\/src\/(session_cipher|crypto|queue_job)\.js/i,
    /at process\.processTicksAndRejections/i,
    /Decrypted message with closed session/i,
    /Closing session: SessionEntry/i,
    /Closing open session in favor of/i,
    /Closing stale open session/i,
    /Removing old closed session/i,
    /SessionEntry {/i,
    /Ratchet {/i,
    /Buffer </i,
    /pubKey: <Buffer/i,
    /privKey: <Buffer/i,
    /rootKey: <Buffer/i,
    /ephemeralKeyPair: {/i,
    /lastRemoteEphemeralKey:/i,
    /previousCounter:/i,
    /registrationId:/i,
    /indexInfo: {/i,
    /baseKey:/i,
    /remoteIdentityKey:/i,
    /pendingPreKey:/i,
    /new outgoing prekey bundle/i,
    /Closing session as it was already open/i,
    // Benign Node.js / npm warnings that pollute the dashboard log
    /ExperimentalWarning:/i,
    /Use `node --trace-warnings/i,
    /\(Use `node --trace-warnings/i,
    /DeprecationWarning:/i,
    /npm warn deprecated/i,
];
const util = require('util');
const isNoisySignalLine = (args) => {
    try {
        const text = args.map(a => {
            if (typeof a === 'object') return util.inspect(a, { depth: null });
            return String(a);
        }).join(' ');
        
        // Always show our own movie debug logs
        if (text.includes('[Movie]')) return false;

        return NOISY_PATTERNS.some(re => re.test(text)) || 
               text.includes('SessionEntry') || 
               text.includes('Ratchet') ||
               text.includes('prekey bundle') ||
               text.includes('lastRemoteEphemeralKey');
    } catch { return false; }
};

const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = function (chunk, encoding, callback) {
    if (isNoisySignalLine([chunk ? chunk.toString() : ""])) return true;
    return _origStdoutWrite.apply(process.stdout, arguments);
};

process.stderr.write = function (chunk, encoding, callback) {
    if (isNoisySignalLine([chunk ? chunk.toString() : ""])) return true;
    return _origStderrWrite.apply(process.stderr, arguments);
};

const { logger } = require('./logger');
const _origConsoleLog = console.log.bind(console);
const _origConsoleError = console.error.bind(console);

console.log = (...args) => {
    if (isNoisySignalLine(args)) return;
    try { logger(args.map(a => (typeof a === 'object' ? util.inspect(a) : String(a))).join(' ')); } catch {
        _origConsoleLog(...args);
    }
};

console.error = (...args) => {
    if (isNoisySignalLine(args)) return;
    try { logger('[ERROR] ' + args.map(a => (a instanceof Error ? a.stack || a.message : String(a))).join(' ')); } catch {
        _origConsoleError(...args);
    }
};

// Suppress Node's default ExperimentalWarning printer (CommonJS importing ESM
// is required by Baileys today and the warning floods the dashboard log).
process.removeAllListeners('warning');
process.on('warning', (warning) => {
    const text = `${warning.name || 'Warning'}: ${warning.message || ''}`;
    if (NOISY_PATTERNS.some(re => re.test(text))) return;
    _origConsoleError(warning);
});

// Final safety net: never crash on uncaught Signal/decryption errors
process.on('uncaughtException', (err) => {
    const msg = String(err?.message || err);
    if (NOISY_PATTERNS.some(re => re.test(msg))) return;
    _origConsoleError('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
    const msg = String(reason?.message || reason);
    if (NOISY_PATTERNS.some(re => re.test(msg))) return;
    _origConsoleError('[unhandledRejection]', reason);
});

const { validateConfig } = require('./lib/config-validation');
const runtimeConfig = require('./config');
const { startDashboard } = require('./dashboard');
const { startBot } = require('./bot');
const sessionManager = require('./session-manager');

async function main() {
    try {
        const validation = validateConfig(runtimeConfig);
        for (const warning of validation.warnings) logger(`[Config] ${warning}`);
        if (validation.mode.explicitMode === 'production' && !validation.mode.isProductionLike) {
            throw new Error('Production configuration is not hardened. Set a unique ADMIN_PASS, a random JWT_SECRET of at least 32 characters, and a supported Node.js runtime.');
        }
        logger('Initializing dashboard and bots...');
        
        // Start the web dashboard
        await startDashboard();
        
        // Start the main bot
        await startBot();
        
        // Restore any multi-sessions
        await sessionManager.autoRestore();
        
    } catch (error) {
        if (error?.code === 'EADDRINUSE') {
            logger(`Startup aborted: ${error.message}`);
        } else {
            logger(`Startup Error: ${error.message}`);
        }
        process.exitCode = 1;
    }
}

main();
