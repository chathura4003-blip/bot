"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { OWNER_NUMBER, BOT_NAME } = require("../config");
const msgMgr = require("./message-manager");
const { safeExecute } = require("./error-handler");
const db = require("./db");

const ownerContext = new AsyncLocalStorage();

const _cleanJidCache = new Map();

function cleanJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const cached = _cleanJidCache.get(jid);
  if (cached) return cached;

  let cleaned = jid.trim().toLowerCase();
  if (cleaned.includes(":")) {
    cleaned = cleaned.replace(/:[^@]*@/, "@");
  }

  if (_cleanJidCache.size > 2000) _cleanJidCache.clear();
  _cleanJidCache.set(jid, cleaned);
  return cleaned;
}

function canonicalSender(rawJid, msg = null) {
  if (!rawJid && msg?.key) {
    rawJid = msg.key.participant || msg.key.remoteJid;
  }
  const jid = cleanJid(rawJid);
  if (!jid) return "";

  if (msg?.key?.participantPn) {
    const pn = cleanJid(msg.key.participantPn);
    if (pn) return pn;
  }
  if (msg?.key?.senderPn) {
    const pn = cleanJid(msg.key.senderPn);
    if (pn) return pn;
  }

  if (jid.endsWith("@s.whatsapp.net")) {
    return jid;
  }

  if (jid.endsWith("@lid")) {
    try {
      const userDb = db.getObjectCollection("users");
      const found = userDb[jid];
      if (found && found.number) {
        const numDigits = String(found.number).replace(/\D/g, "");
        if (numDigits) return `${numDigits}@s.whatsapp.net`;
      }
    } catch (_) {}
  }

  return jid;
}

function ownerTokens(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const tokens = new Set([raw]);
  if (digits) {
    tokens.add(digits);
    tokens.add(`${digits}@s.whatsapp.net`);
  }
  return Array.from(tokens);
}

function normalizeOwner(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits) return `${digits}@s.whatsapp.net`;
  const raw = String(value || "").trim().toLowerCase();
  return raw || null;
}

let _cachedOwnerTokens = null;
let _cachedOwnerTime = 0;

function getCachedOwnerTokens() {
  const now = Date.now();
  if (_cachedOwnerTokens && now - _cachedOwnerTime < 5000) {
    return _cachedOwnerTokens;
  }
  const verified = db.getSetting("verified_owners");
  const configured = [
    OWNER_NUMBER,
    db.getSetting("main_owner"),
    ...(Array.isArray(verified) ? verified : []),
  ];
  _cachedOwnerTokens = new Set(configured.flatMap(ownerTokens));
  _cachedOwnerTime = now;
  return _cachedOwnerTokens;
}

function collectOwnerTokens(extraOwners = []) {
  const base = getCachedOwnerTokens();
  const extras = Array.isArray(extraOwners) ? extraOwners : [extraOwners];
  const ctx = (ownerContext.getStore() || {}).owners || [];
  if (!extras.length && !ctx.length) return base;
  return new Set([...base, ...[...extras, ...ctx].flatMap(ownerTokens)]);
}

function withOwnerContext(owners, fn) {
  return ownerContext.run({ owners: Array.isArray(owners) ? owners : [owners].filter(Boolean) }, fn);
}

function sendReact(sock, from, msg, emoji) {
  if (!sock || !from || !msg?.key || !emoji) return Promise.resolve();
  msgMgr.react(sock, from, msg.key, emoji).catch(() => {});
  return Promise.resolve();
}

function presenceUpdate(sock, from, type = "composing") {
  if (!sock || !from) return Promise.resolve();
  safeExecute(
    () => sock.sendPresenceUpdate(type, from),
    "PresenceUpdate",
  ).catch(() => {});
  return Promise.resolve();
}

function isOwner(sender, extraOwners = []) {
  if (!sender) return false;
  
  const senderJid = String(sender).toLowerCase();
  const senderTokens = ownerTokens(senderJid);
  const baseOwners = getCachedOwnerTokens();

  for (const token of senderTokens) {
    if (baseOwners.has(token)) return true;
  }

  if (extraOwners && (Array.isArray(extraOwners) ? extraOwners.length : extraOwners)) {
    const extraList = Array.isArray(extraOwners) ? extraOwners : [extraOwners];
    for (const owner of extraList) {
      for (const token of ownerTokens(owner)) {
        if (senderTokens.includes(token)) return true;
      }
    }
  }

  const store = ownerContext.getStore();
  if (store?.owners?.length) {
    for (const owner of store.owners) {
      for (const token of ownerTokens(owner)) {
        if (senderTokens.includes(token)) return true;
      }
    }
  }

  return false;
}

const _groupMetaCache = new Map();

async function getGroupMetadataCached(sock, from) {
  const entry = _groupMetaCache.get(from);
  const now = Date.now();
  if (entry && now - entry.ts < 10000) {
    return entry.data;
  }
  const data = await sock.groupMetadata(from);
  _groupMetaCache.set(from, { data, ts: now });
  return data;
}

async function isGroupAdmin(sock, from, sender) {
  if (!sock || !from || !sender) return false;
  if (!from.endsWith("@g.us")) return false;
  try {
    const meta = await getGroupMetadataCached(sock, from);
    const p = meta?.participants?.find((x) => x.id === sender);
    return p?.admin === "admin" || p?.admin === "superadmin";
  } catch {
    return false;
  }
}

function truncate(str, max = 50) {
  if (!str || typeof str !== "string") return "Unknown";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/**
 * Unwraps nested message structures (ephemeral, viewOnce, documentWithCaption, deviceSent, etc.)
 */
function getRealMessage(msg) {
  if (!msg) return null;
  let m = msg.message || msg;
  while (m) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else if (m.deviceSentMessage?.message) m = m.deviceSentMessage.message;
    else break;
  }
  return m;
}

/**
 * Universally extracts quoted message and contextInfo from ANY WhatsApp message structure
 */
function extractQuotedContext(msg) {
  if (!msg) {
    return { isQuoted: false, stanzaId: null, participant: null, sender: null, quotedMsg: null, text: "", contextInfo: null };
  }
  const m = getRealMessage(msg);
  if (!m) {
    return { isQuoted: false, stanzaId: null, participant: null, sender: null, quotedMsg: null, text: "", contextInfo: null };
  }

  const contextInfo =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    m.buttonsResponseMessage?.contextInfo ||
    m.listResponseMessage?.contextInfo ||
    m.templateButtonReplyMessage?.contextInfo ||
    m.interactiveResponseMessage?.contextInfo ||
    m.locationMessage?.contextInfo ||
    m.contactMessage?.contextInfo ||
    null;

  if (!contextInfo) {
    return { isQuoted: false, stanzaId: null, participant: null, sender: null, quotedMsg: null, text: "", contextInfo: null };
  }

  const stanzaId = contextInfo.stanzaId || null;
  const participant = contextInfo.participant || null;
  const sender = participant ? canonicalSender(participant) : null;
  const rawQuoted = contextInfo.quotedMessage || null;
  const qReal = rawQuoted ? getRealMessage(rawQuoted) : null;

  let text = "";
  if (qReal) {
    text =
      qReal.conversation ||
      qReal.extendedTextMessage?.text ||
      qReal.imageMessage?.caption ||
      qReal.videoMessage?.caption ||
      qReal.documentMessage?.caption ||
      qReal.buttonsResponseMessage?.selectedButtonId ||
      qReal.listResponseMessage?.singleSelectReply?.selectedRowId ||
      qReal.templateButtonReplyMessage?.selectedId ||
      "";
  }

  return {
    isQuoted: Boolean(stanzaId),
    stanzaId,
    participant,
    sender,
    quotedMsg: qReal || rawQuoted,
    text,
    contextInfo
  };
}

module.exports = {
  cleanJid,
  canonicalSender,
  sendReact,
  presenceUpdate,
  isOwner,
  normalizeOwner,
  withOwnerContext,
  isGroupAdmin,
  truncate,
  downloadMediaMessage,
  getRealMessage,
  extractQuotedContext,
};
