'use strict';

// Lazy-cached require for the on-disk db. We do it lazily (rather than a
// top-level require) because db.js imports config.js which in turn reads
// state.js indirectly during boot in certain test setups; importing on
// first use side-steps that cycle. After first call _db stays cached so
// each get* / set* below avoids redoing the require.cache lookup on every
// per-message read.
let _db = null;
function _getDb() {
    if (_db) return _db;
    try { _db = require('./lib/db'); } catch { _db = null; }
    return _db;
}

let _socket = null;
let _status = 'Disconnected';
let _number = null;
let _pushName = null;
let _connectedAt = null;
let _mainQr = null;
let _mainPairCode = null;
let _mainPairCodeExpiresAt = null;
let _mainPairMode = false;
let _mainPairPhone = null;
let _workMode = 'public';
let _autoStatus = true;
let _botEnabled = true;
let _disabledModules = [];
let _owner = null;
let _restartRequested = false;
let _qrPaused = false;
let _qrAttempts = 0;
let _processedCount = 0;
let _commandsCount = 0;
const _logs = [];

// --- Button Mode normalizer (V4.2: binary on/off) --------------------------
// Accepts modern "on"/"off" plus legacy values (auto/button/list/text/true/1
// /false/0/yes/no) and reduces them to "on" or "off". `text` and `off` and
// any falsy/no value collapse to "off"; everything else collapses to "on".
function _normalizeButtonMode(v) {
    if (v == null) return null;
    const s = String(v).toLowerCase().trim();
    if (!s) return null;
    if (['off', 'false', '0', 'no', 'n', 'text', 'disable', 'disabled', 'legacy'].includes(s)) return 'off';
    if (['on',  'true',  '1', 'yes', 'y', 'auto', 'button', 'list', 'enable', 'enabled', 'advanced'].includes(s)) return 'on';
    return null;
}

// --- Change-emitter (used by dashboard for real-time UI sync) ---------------
const _listeners = new Set();
let _emitTimer = null;
const _pendingChanges = new Set();
function _emit(key) {
    if (key) _pendingChanges.add(key);
    if (_emitTimer) return;
    // Coalesce multiple rapid changes into a single broadcast tick (50ms).
    _emitTimer = setTimeout(() => {
        _emitTimer = null;
        const keys = Array.from(_pendingChanges);
        _pendingChanges.clear();
        for (const fn of _listeners) {
            try { fn(keys); } catch (e) { /* listener errors must not break setters */ }
        }
    }, 50);
    if (typeof _emitTimer.unref === 'function') _emitTimer.unref();
}

module.exports = {
    onChange: (fn) => {
        if (typeof fn !== 'function') return () => {};
        _listeners.add(fn);
        return () => _listeners.delete(fn);
    },
    setSocket: (s) => { _socket = s; },
    getSocket: () => _socket,
    setStatus: (s) => { _status = s; },
    getStatus: () => _status,
    setNumber: (n) => { _number = n; },
    getNumber: () => _number,
    setPushName: (n) => { _pushName = n; },
    getPushName: () => _pushName,
    setConnectedAt: (t) => { _connectedAt = t; },
    getConnectedAt: () => _connectedAt,
    setMainQr: (q) => { _mainQr = q; },
    getMainQr: () => _mainQr,
    setMainPairCode: (c) => { _mainPairCode = c; },
    getMainPairCode: () => _mainPairCode,
    setMainPairCodeExpiresAt: (t) => { _mainPairCodeExpiresAt = t; },
    getMainPairCodeExpiresAt: () => _mainPairCodeExpiresAt,
    setMainPairMode: (m) => { _mainPairMode = !!m; },
    isMainPairMode: () => _mainPairMode,
    setMainPairPhone: (p) => { _mainPairPhone = p; },
    getMainPairPhone: () => _mainPairPhone,
    requestRestart: () => { _restartRequested = true; },
    clearRestart: () => { _restartRequested = false; },
    isRestartRequested: () => _restartRequested,
    setQrPaused: (v) => { _qrPaused = !!v; },
    isQrPaused: () => _qrPaused,
    incQrAttempts: () => ++_qrAttempts,
    resetQrAttempts: () => { _qrAttempts = 0; },
    resetReconnectAttempts: () => { _qrAttempts = 0; },
    getQrAttempts: () => _qrAttempts,
    incProcessedCount: () => {
        _processedCount++;
        try { _getDb().setSetting('main_processed_count', _processedCount); } catch {}
        return _processedCount;
    },
    getProcessedCount: () => {
        try { return _getDb().getSetting('main_processed_count') || _processedCount; } catch { return _processedCount; }
    },
    incCommandsCount: () => {
        _commandsCount++;
        try { _getDb().setSetting('main_commands_count', _commandsCount); } catch {}
        return _commandsCount;
    },
    getCommandsCount: () => {
        try { return _getDb().getSetting('main_commands_count') || _commandsCount; } catch { return _commandsCount; }
    },
    setWorkMode: (v) => { 
        _workMode = v; 
        try { _getDb().setSetting('work_mode', v); } catch {}
        _emit('workMode');
    },
    getWorkMode: () => {
        try { return _getDb().getSetting('work_mode') || _workMode; } catch { return _workMode; }
    },
    setAutoStatus: (v) => { 
        _autoStatus = !!v; 
        try { _getDb().setSetting('main_auto_status', !!v); } catch {}
        _emit('autoStatus');
    },
    getAutoStatus: () => {
        try {
            const val = _getDb().getSetting('main_auto_status');
            return val !== undefined ? val : _autoStatus;
        } catch { return _autoStatus; }
    },
    setBotEnabled: (v) => { 
        _botEnabled = !!v; 
        try { _getDb().setSetting('main_bot_enabled', !!v); } catch {}
        _emit('botEnabled');
    },
    getBotEnabled: () => {
        try { 
            const val = _getDb().getSetting('main_bot_enabled');
            return val !== undefined ? val : _botEnabled;
        } catch { return _botEnabled; }
    },
    setDisabledModules: (v) => { 
        _disabledModules = Array.isArray(v) ? v : []; 
        try { _getDb().setSetting('main_disabled_modules', _disabledModules); } catch {}
        _emit('disabledModules');
    },
    getDisabledModules: () => {
        try { return _getDb().getSetting('main_disabled_modules') || _disabledModules; } catch { return _disabledModules; }
    },
    setOwner: (v) => { 
        _owner = v; 
        try { _getDb().setSetting('main_owner', v); } catch {}
        _emit('owner');
    },
    getOwner: () => {
        try { return _getDb().getSetting('main_owner') || _owner; } catch { return _owner; }
    },
    setAutoRead: (v) => {
        try { _getDb().setSetting('autoRead', v === null ? null : !!v); } catch {}
        _emit('autoRead');
    },
    getAutoRead: () => {
        try { return _getDb().getSetting('autoRead'); } catch { return null; }
    },
    setAutoReadBot: (v) => {
        try { _getDb().setSetting('autoReadBot', v === null ? null : !!v); } catch {}
        _emit('autoReadBot');
    },
    getAutoReadBot: () => {
        try { return _getDb().getSetting('autoReadBot'); } catch { return null; }
    },
    setAutoTyping: (v) => {
        try { _getDb().setSetting('autoTyping', v === null ? null : !!v); } catch {}
        _emit('autoTyping');
    },
    getAutoTyping: () => {
        try { return _getDb().getSetting('autoTyping'); } catch { return null; }
    },
    setAutoReactStatus: (v) => {
        try { _getDb().setSetting('auto_react_status', v === null ? null : !!v); } catch {}
        _emit('autoReactStatus');
    },
    getAutoReactStatus: () => {
        try { return _getDb().getSetting('auto_react_status'); } catch { return null; }
    },
    setAntiViewOnceEnabled: (v) => {
        try { _getDb().setSetting('anti_view_once', !!v); } catch {}
        _emit('antiViewOnce');
    },
    getAntiViewOnceEnabled: () => {
        try { return _getDb().getSetting('anti_view_once') === true; } catch { return false; }
    },
    setNsfwEnabled: (v) => {
        try { _getDb().setSetting('nsfwEnabled', v === null ? null : !!v); } catch {}
        _emit('nsfwEnabled');
    },
    getNsfwEnabled: () => {
        try { return _getDb().getSetting('nsfwEnabled'); } catch { return null; }
    },
    setAutoReply: (v) => {
        try { _getDb().setSetting('autoReply', v === null ? null : !!v); } catch {}
        _emit('autoReply');
    },
    getAutoReply: () => {
        try { return _getDb().getSetting('autoReply'); } catch { return null; }
    },
    setAiAutoReply: (v) => {
        try { _getDb().setSetting('aiAutoReply', v === null ? null : !!v); } catch {}
        _emit('aiAutoReply');
    },
    getAiAutoReply: () => {
        try { return _getDb().getSetting('aiAutoReply'); } catch { return null; }
    },
    setAiAutoPersona: (v) => {
        try { _getDb().setSetting('aiAutoPersona', v); } catch {}
        _emit('aiAutoPersona');
    },
    getAiAutoPersona: () => {
        try { return _getDb().getSetting('aiAutoPersona') || 'friendly'; } catch { return 'friendly'; }
    },
    setAiAutoLang: (v) => {
        try { _getDb().setSetting('aiAutoLang', v); } catch {}
        _emit('aiAutoLang');
    },
    getAiAutoLang: () => {
        try { return _getDb().getSetting('aiAutoLang') || 'auto'; } catch { return 'auto'; }
    },
    setAiAutoVoice: (v) => {
        try { _getDb().setSetting('aiAutoVoice', !!v); } catch { return false; }
        _emit('aiAutoVoice');
    },
    getAiAutoVoice: () => {
        try { return _getDb().getSetting('aiAutoVoice') === true; } catch { return false; }
    },
    setAiGroupMode: (v) => {
        try { _getDb().setSetting('aiGroupMode', v); } catch {}
        _emit('aiGroupMode');
    },
    getAiGroupMode: () => {
        try { return _getDb().getSetting('aiGroupMode') || 'mention'; } catch { return 'mention'; }
    },
    setAiSystemInstruction: (v) => {
        try { _getDb().setSetting('aiSystemInstruction', v); } catch {}
        _emit('aiSystemInstruction');
    },
    getAiSystemInstruction: () => {
        try { return _getDb().getSetting('aiSystemInstruction') || ''; } catch { return ''; }
    },
    setAiMaxWords: (v) => {
        try { _getDb().setSetting('aiMaxWords', parseInt(v) || 30); } catch {}
        _emit('aiMaxWords');
    },
    getAiMaxWords: () => {
        try { return parseInt(_getDb().getSetting('aiMaxWords')) || 30; } catch { return 30; }
    },
    // --- AI auto-reply advanced features --------------------------------
    setAiAutoWakeWords: (v) => {
        const cleaned = String(v || '')
            .split(/[,\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
            .slice(0, 30).join(',');
        try { _getDb().setSetting('aiAutoWakeWords', cleaned); } catch {}
        _emit('aiAutoWakeWords');
    },
    getAiAutoWakeWords: () => {
        try {
            const raw = _getDb().getSetting('aiAutoWakeWords') || '';
            return String(raw).split(',').map(s => s.trim()).filter(Boolean);
        } catch { return []; }
    },
    setAiAutoBurstShield: (v) => {
        try { _getDb().setSetting('aiAutoBurstShield', v === null ? null : !!v); } catch {}
        _emit('aiAutoBurstShield');
    },
    getAiAutoBurstShield: () => {
        try {
            const val = _getDb().getSetting('aiAutoBurstShield');
            return val === undefined || val === null ? true : !!val;
        } catch { return true; }
    },
    setAiAutoLightReact: (v) => {
        try { _getDb().setSetting('aiAutoLightReact', v === null ? null : !!v); } catch {}
        _emit('aiAutoLightReact');
    },
    getAiAutoLightReact: () => {
        try {
            const val = _getDb().getSetting('aiAutoLightReact');
            return val === undefined || val === null ? true : !!val;
        } catch { return true; }
    },
    setAiAutoMemoryDepth: (v) => {
        const n = Math.max(2, Math.min(parseInt(v) || 6, 20));
        try { _getDb().setSetting('aiAutoMemoryDepth', n); } catch {}
        _emit('aiAutoMemoryDepth');
    },
    getAiAutoMemoryDepth: () => {
        try { return Math.max(2, Math.min(parseInt(_getDb().getSetting('aiAutoMemoryDepth')) || 6, 20)); } catch { return 6; }
    },

    // --- Button Mode (bot-wide menu UI mode) ----------------------------
    // V4.2: simplified to a binary on/off switch.
    //   on  — Advanced UI Engine: WhatsApp buttons / list / native flow,
    //         advanced text fallback, new menu-state numeric reply.
    //   off — Legacy flow: every menu/search/download command runs through
    //         the original code paths exactly as before V4.
    // Old values (auto/button/list/true/1) all normalise to "on";
    // (text/false/0) normalise to "off" so persisted settings keep working.
    setButtonMode: (v) => {
        const norm = _normalizeButtonMode(v);
        if (norm == null) return false;
        try { _getDb().setSetting('buttonMode', norm); } catch {}
        _emit('buttonMode');
        return true;
    },
    getButtonMode: () => {
        try {
            const v = _getDb().getSetting('buttonMode');
            const norm = _normalizeButtonMode(v);
            if (norm) return norm;
        } catch {}
        const env = _normalizeButtonMode(process.env.BUTTON_MODE);
        if (env) return env;
        return 'on';
    },

    // Role-menu mode: how role-based filtering is applied to menus.
    //   strict — hide items the user cannot access AND deny on action
    //   relaxed — show all items, deny on action only
    //   off    — show all items, allow on action (visibility only — actual
    //            command execution still goes through the regular role
    //            checks downstream).
    setRoleMenuMode: (v) => {
        const allowed = ['strict', 'relaxed', 'off'];
        const val = String(v || '').toLowerCase().trim();
        if (!allowed.includes(val)) return false;
        try { _getDb().setSetting('roleMenuMode', val); } catch {}
        _emit('roleMenuMode');
        return true;
    },
    getRoleMenuMode: () => {
        try {
            const v = _getDb().getSetting('roleMenuMode');
            const allowed = ['strict', 'relaxed', 'off'];
            if (typeof v === 'string' && allowed.includes(v.toLowerCase())) return v.toLowerCase();
        } catch {}
        return 'strict';
    },

    getLogs: () => _logs,
};
