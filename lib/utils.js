"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { OWNER_NUMBER, BOT_NAME } = require("../config");
const msgMgr = require("./message-manager");
const { safeExecute } = require("./error-handler");
const db = require("./db");

const ownerContext = new AsyncLocalStorage();

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

module.exports = {
  sendReact,
  presenceUpdate,
  isOwner,
  normalizeOwner,
  withOwnerContext,
  isGroupAdmin,
  truncate,
  downloadMediaMessage,
};
