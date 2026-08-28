'use strict';

const { DisconnectReason } = require('@whiskeysockets/baileys');

function getStatusCode(lastDisconnect) {
  return lastDisconnect?.error?.output?.statusCode
    || lastDisconnect?.error?.statusCode
    || null;
}

function classifyDisconnect(lastDisconnect) {
  const error = lastDisconnect?.error;
  const message = String(error?.message || error || 'Unknown disconnect');
  const code = getStatusCode(lastDisconnect);
  const lower = message.toLowerCase();
  const badMac = lower.includes('bad mac') || lower.includes('verifymac') || lower.includes('messagecountererror');
  const loggedOut = code === DisconnectReason.loggedOut || code === 401 || code === 403 || badMac;
  const replaced = code === 440;
  const recoverable = !loggedOut && !replaced;
  return { code, message, badMac, loggedOut, replaced, recoverable };
}

function getReconnectDelay(attempt = 0, { baseMs = 5000, maxMs = 120000, jitterMs = 1000 } = {}) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.min(safeAttempt, 6)));
  return exponential + Math.floor(Math.random() * Math.max(0, jitterMs));
}

module.exports = { getStatusCode, classifyDisconnect, getReconnectDelay };
