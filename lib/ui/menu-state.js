"use strict";

/**
 * Bot-wide Menu State Cache
 *
 * Keyed by the WhatsApp message ID of the menu/result/quality message we sent.
 * The handler looks the user's quoted reply up in this cache so a plain
 * numeric reply ("3") can be resolved back to the original menu items.
 *
 * Stored payload shape:
 *   {
 *     type: "menu" | "results" | "quality" | "settings",
 *     menuId: string,
 *     level: "top" | "category" | "results" | "quality" | "settings",
 *     categoryId: string|null,
 *     chatJid: string,
 *     userJid: string,
 *     role: string,
 *     items: Array<{ index, action, label, title, payload? }>,
 *     payload: object,
 *     page: number,
 *     previousMenu: object|null,
 *     createdAt: number,
 *     expiresAt: number,
 *   }
 *
 * Two indexes are kept:
 *   • menuStates       — keyed by message ID, the canonical entry.
 *   • latestByUser     — keyed by userJid (or chatJid for shared menus),
 *                        always points at the most recent menu sent to that
 *                        user. Used as a fallback when WhatsApp clients strip
 *                        the stanzaId from the quoted-reply context.
 */

const { MemoryCache } = require("../memory-cache");

const TTL = 5 * 60 * 1000; // 5 minutes per spec

const menuStates  = new MemoryCache(TTL);
const latestByUser = new MemoryCache(TTL);

function makeUserKey(chatJid, userJid) {
  // Always include the chat JID alongside the user JID so a menu sent in
  // group A doesn't shadow / overwrite a menu sent in group B for the same
  // user. An unquoted numeric reply must resolve against the chat the user
  // is *currently* replying in, not against whichever chat received the
  // most recent menu globally.
  if (chatJid && userJid) return `${chatJid}:${userJid}`;
  if (userJid) return `u:${userJid}`;
  if (chatJid) return `c:${chatJid}`;
  return null;
}

/**
 * Save menu state by sent message ID. Tolerates a missing/falsy id (we just
 * skip the per-message index in that case but still keep the latest-by-user
 * fallback so a quick numeric reply can still resolve).
 */
function saveMenuState(messageId, payload) {
  if (!payload || typeof payload !== "object") return;
  const now = Date.now();
  const entry = {
    type:        payload.type || "menu",
    menuId:      payload.menuId || payload.id || null,
    level:       payload.level || "top",
    categoryId:  payload.categoryId || null,
    chatJid:     payload.chatJid || null,
    userJid:     payload.userJid || null,
    role:        payload.role  || "normal",
    items:       Array.isArray(payload.items) ? payload.items : [],
    payload:     payload.payload || {},
    page:        payload.page || 1,
    totalPages:  payload.totalPages || 1,
    previousMenu: payload.previousMenu || null,
    createdAt:   payload.createdAt || now,
    expiresAt:   now + TTL,
    // Per-spec: useful for older clients that strip stanzaId.
    messageId:   messageId || null,
  };

  if (messageId) menuStates.set(String(messageId), entry, TTL);
  const key = makeUserKey(entry.chatJid, entry.userJid);
  if (key) latestByUser.set(key, entry, TTL);
}

function getMenuStateByMessageId(messageId) {
  if (!messageId) return null;
  const raw = menuStates.get(String(messageId));
  if (!raw) return null;
  if (raw.expiresAt && raw.expiresAt < Date.now()) return null;
  return raw;
}

function getLatestMenuStateForUser(chatJid, userJid) {
  const key = makeUserKey(chatJid, userJid);
  if (!key) return null;
  const raw = latestByUser.get(key);
  if (!raw) return null;
  if (raw.expiresAt && raw.expiresAt < Date.now()) return null;
  return raw;
}

function findItemByIndex(state, num) {
  if (!state || !Array.isArray(state.items)) return null;
  const item = state.items.find((it) => it && it.index === num);
  return item || null;
}

/**
 * Resolve a numeric reply.
 *
 * Authoritative match: quoted message ID → exact menu the user is replying
 * to. Fallback: latest menu sent to that user (tolerates clients that drop
 * the stanzaId).
 */
function resolveNumericReply({ chatJid, userJid, quotedMessageId, num }) {
  if (!Number.isFinite(num)) return null;
  let state = quotedMessageId ? getMenuStateByMessageId(quotedMessageId) : null;
  if (!state) state = getLatestMenuStateForUser(chatJid, userJid);
  if (!state) return null;
  const item = findItemByIndex(state, num);
  if (!item) {
    return { state, item: null, reason: "invalid_number" };
  }
  return { state, item, reason: "ok" };
}

function deleteMenuState(messageId) {
  if (!messageId) return;
  menuStates.delete(String(messageId));
}

module.exports = {
  TTL,
  saveMenuState,
  getMenuStateByMessageId,
  getLatestMenuStateForUser,
  resolveNumericReply,
  deleteMenuState,
};
