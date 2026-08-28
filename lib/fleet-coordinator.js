'use strict';

/**
 * Fleet Coordinator — single-process multi-session deduplication.
 *
 * When several bot accounts share a WhatsApp group while running inside the
 * same Node process (Fleet Orchestration), every session's `messages.upsert`
 * listener fires for the exact same group event with an identical
 * `msg.key.id`. Without coordination each session would independently react
 * (auto-view status, anti-link delete, anti-bad warning, mention reply,
 * command dispatch, …) and the group would see N copies of every response.
 *
 * This module exposes a tiny "claim" primitive: the first delivery of a
 * message id wins; every later delivery — whether it's a sibling Fleet
 * session re-receiving the same group message or the *same* session re-
 * delivering after a Baileys retransmit / reconnect — gets back `false`
 * and skips the message. Claims are kept in an in-memory Map with a short
 * TTL so the process never accumulates unbounded state.
 *
 * Notes:
 *   • Direct messages naturally only reach one session (their socket is the
 *     only one peered with the sender), so multi-session claiming is a
 *     no-op for DMs in practice. Same-session retransmits of a DM still
 *     get deduped, which prevents the bot from replying twice to the same
 *     message after a reconnect or a duplicate `messages.upsert` event.
 *   • Owner commands typed from a phone linked to one specific account
 *     still flow through the claim. Whichever session sees the message
 *     first runs the command, which is the user-visible "single reply"
 *     behaviour we want.
 *   • The coordinator can be disabled at runtime by setting the global
 *     `fleet_solo_mode` setting to `false`; the call returns `true` in
 *     that case so every session processes everything (legacy behaviour).
 */

const DEFAULT_TTL_MS = 60_000;

const claims = new Map(); // msgId -> { sessionId, expiresAt, timer }

let _enabledOverride = null; // null = use db setting; true/false = forced
let _dbRef = null;

function _now() {
    return Date.now();
}

function _setDb(db) {
    _dbRef = db || null;
}

function _isEnabled() {
    if (_enabledOverride === true) return true;
    if (_enabledOverride === false) return false;
    if (!_dbRef) return true;
    try {
        const v = _dbRef.getSetting('fleet_solo_mode');
        if (v === false) return false;
        return true;
    } catch (_) {
        return true;
    }
}

function _release(msgId) {
    const entry = claims.get(msgId);
    if (!entry) return;
    if (entry.timer) {
        try { clearTimeout(entry.timer); } catch (_) { }
    }
    claims.delete(msgId);
}

/**
 * Try to claim a message id. Returns true on the first call for that id
 * (the caller should process the message), and false on every subsequent
 * call within the TTL window — even if it's the same session re-delivering
 * the same id (Baileys retransmit / reconnect).
 */
function tryClaim(sessionId, msgId, ttlMs = DEFAULT_TTL_MS) {
    if (!msgId) return true;       // can't dedup, let it through
    if (!_isEnabled()) return true;

    const existing = claims.get(msgId);
    const now = _now();
    if (existing && existing.expiresAt > now) {
        return false;
    }
    if (existing) _release(msgId);

    const timer = setTimeout(() => _release(msgId), ttlMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    claims.set(msgId, {
        sessionId: sessionId || '__main__',
        expiresAt: now + ttlMs,
        timer,
    });
    return true;
}

/**
 * Filter a Baileys `messages.upsert` batch down to just the messages this
 * session is allowed to process. Returns the kept array; sibling-claimed
 * messages are dropped.
 */
function filterClaimable(sessionId, messages, ttlMs = DEFAULT_TTL_MS) {
    if (!Array.isArray(messages)) return [];
    if (!_isEnabled()) return messages.slice();
    const out = [];
    for (const msg of messages) {
        const id = msg && msg.key && msg.key.id;
        if (tryClaim(sessionId, id, ttlMs)) out.push(msg);
    }
    return out;
}

function _reset() {
    for (const id of Array.from(claims.keys())) _release(id);
    _enabledOverride = null;
}

function _setEnabledOverride(v) {
    _enabledOverride = v;
}

function _peek(msgId) {
    return claims.get(msgId) || null;
}

function size() {
    return claims.size;
}

module.exports = {
    tryClaim,
    filterClaimable,
    size,
    _setDb,
    _setEnabledOverride,
    _reset,
    _peek,
    DEFAULT_TTL_MS,
};
