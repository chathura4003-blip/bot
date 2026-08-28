'use strict';

// Async, low-overhead logger.
//
// Two big perf wins compared to the previous implementation:
//
//   1. We no longer fs.appendFileSync(...) on every single log call. That
//      blocks the event loop and was by far the bot's hottest sync I/O —
//      every WhatsApp event, every command, every periodic stats tick was
//      paying a disk-write tax. We now use a single fs.WriteStream so the
//      OS handles batching/flushing on its own.
//
//   2. In production (NODE_ENV=production) we skip both stdout writes for
//      "noisy" entries and skip the file write entirely unless DEBUG_LOG is
//      truthy. Free-host plans (Railway / Render) charge log-volume so this
//      also cuts dashboard noise + log retention costs.

const fs = require('fs');
const path = require('path');
const appState = require('./state');

let _io = null;
const MAX_LOGS = 500;
const NOISY_PATTERNS = [
    'Closing session', 'SessionEntry', 'Signal', 'Frame',
    'Binary', 'Success', 'Stream', 'Node', 'Attribute',
    'Ratchet', 'Buffer', 'pubKey', 'rootKey', 'previousCounter',
    'lastRemoteEphemeralKey', 'registrationId', 'prekey bundle',
    'closed session', 'stale open session'
];

const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
// In production we keep the file log off by default (set DEBUG_LOG=1 to
// force-enable). In development everyone wants debug.log so we keep the
// historical default.
const FILE_LOG_ENABLED = (() => {
    const explicit = String(process.env.DEBUG_LOG || '').trim().toLowerCase();
    if (explicit === '1' || explicit === 'true' || explicit === 'on') return true;
    if (explicit === '0' || explicit === 'false' || explicit === 'off') return false;
    return !IS_PRODUCTION;
})();

// Lazily create the write stream so importing this module never throws when
// the cwd is read-only. We also reopen on EBADF / write errors so a rotated /
// truncated debug.log self-heals without restarting the process.
let _stream = null;
let _streamOpenedFor = null;

function getStream() {
    if (!FILE_LOG_ENABLED) return null;
    const filePath = path.resolve(process.cwd(), 'debug.log');
    if (_stream && _streamOpenedFor === filePath && !_stream.destroyed) return _stream;
    try {
        _stream = fs.createWriteStream(filePath, { flags: 'a' });
        _stream.on('error', () => {
            try { _stream?.destroy(); } catch {}
            _stream = null;
        });
        _streamOpenedFor = filePath;
    } catch {
        _stream = null;
    }
    return _stream;
}

function setIO(io) { _io = io; }

function logger(...args) {
    const msg = args.map(arg => {
        if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch { return String(arg); }
        }
        return String(arg);
    }).join(' ');

    const entry = {
        time: new Date().toISOString(),
        message: msg,
    };
    const logs = appState.getLogs();
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();

    const stamp = entry.time.split('T')[1].split('.')[0];
    const logStr = entry.message; // removed .replace(/\n/g, ' ') for multi-line support
    const isNoisy = NOISY_PATTERNS.some(p => logStr.includes(p));

    if (!isNoisy) {
        let coloredMsg = logStr;
        if (logStr.includes('[Incoming]')) coloredMsg = `\x1b[36m${logStr}\x1b[0m`; // Cyan
        else if (logStr.includes('[Handler]')) coloredMsg = `\x1b[35m${logStr}\x1b[0m`; // Magenta
        else if (logStr.includes('[ERROR]')) coloredMsg = `\x1b[31m${logStr}\x1b[0m`; // Red
        else if (logStr.includes('[Main Bot]')) coloredMsg = `\x1b[32m${logStr}\x1b[0m`; // Green
        
        process.stdout.write(`\x1b[90m[${stamp}]\x1b[0m ${coloredMsg}\n`);
    }

    const stream = getStream();
    if (stream) {
        // write() is non-blocking; we explicitly do NOT pass a callback to
        // avoid creating per-log microtasks. If write() returns false we just
        // let backpressure handle itself — log lines are small and the OS
        // page cache will absorb bursts.
        try { stream.write(`[${entry.time}] ${entry.message}\n`); } catch {}
    }

    if (_io) {
        try { _io.emit('log', entry); } catch {}
    }
}

module.exports = { logger, setIO };
