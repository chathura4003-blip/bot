"use strict";

const fs = require("fs");
const path = require("path");
const { OWNER_NUMBER, DB_PATH: DB_PATH_FROM_CONFIG } = require("../config");

const DB_PATH = DB_PATH_FROM_CONFIG || path.join(__dirname, "..", "db.json");
const FLUSH_DELAY_MS = 10000;
const ARRAY_COLLECTIONS = new Set(["autoReply", "scheduler", "broadcastHistory"]);
const DEFAULT_SCHEMA = {
  users: {},
  groups: {},
  settings: {},
  mods: {},
  bans: {},
  commandSettings: {},
  autoReply: [],
  scheduler: [],
  broadcastHistory: [],
  economy: {},
};

let cache = null;
let dirty = false;
let flushTimer = null;
let flushInFlight = null;

function clone(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t !== "object" && t !== "function") return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (_) {}
  }
  return JSON.parse(JSON.stringify(value));
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.values(value).filter(Boolean);
  }
  return [];
}

function ensureCollectionShape(key, value) {
  return ARRAY_COLLECTIONS.has(key) ? ensureArray(value) : ensureObject(value);
}

function ensureSchema(value) {
  const source = ensureObject(value);
  const normalized = {};

  for (const [key, fallback] of Object.entries(DEFAULT_SCHEMA)) {
    const raw = source[key];
    normalized[key] = raw === undefined || raw === null
      ? clone(fallback)
      : ensureCollectionShape(key, raw);
  }

  return normalized;
}

function normalizeOwnerJid(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits) return `${digits}@s.whatsapp.net`;
  return raw || null;
}

function getManagedIdentityDigits(value) {
  if (!value) return "";
  const raw = String(value).trim().toLowerCase();
  const base = raw.includes("@") ? raw.split("@")[0] : raw;
  return base.replace(/\D/g, "");
}

function getManagedIdentityKey(jid, data = {}) {
  const numberDigits = String(data?.number || "").replace(/\D/g, "");
  if (numberDigits) return numberDigits;

  const jidDigits = getManagedIdentityDigits(jid);
  if (jidDigits) return jidDigits;

  return normalizeOwnerJid(jid) || String(jid || "").trim().toLowerCase();
}

function chooseManagedDisplayJid(aliases, preferredJid = null) {
  const list = Array.from(new Set((aliases || []).filter(Boolean).map((entry) => String(entry).trim().toLowerCase())));
  const normalizedPreferred = normalizeOwnerJid(preferredJid);

  if (normalizedPreferred && list.includes(normalizedPreferred)) return normalizedPreferred;

  return list.find((entry) => entry.endsWith("@s.whatsapp.net"))
    || list.find((entry) => entry.endsWith("@lid"))
    || list[0]
    || normalizedPreferred
    || null;
}

function load() {
  if (cache) return cache;

  if (!fs.existsSync(DB_PATH)) {
    cache = ensureSchema({});
    return cache;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    cache = ensureSchema(parsed);
  } catch {
    cache = ensureSchema({});
  }

  return cache;
}

async function atomicWrite(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });

    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      try {
        await fs.promises.rm(filePath, { force: true });
        await fs.promises.rename(tempPath, filePath);
        return;
      } catch (error) {
        attempts += 1;
        if (attempts >= maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    console.error(`[DB] Flush failed: ${error.message}`);
  }
}

async function flush() {
  if (flushInFlight) return flushInFlight;
  if (!dirty || !cache) return;
  dirty = false;
  const payload = JSON.stringify(cache);
  flushInFlight = atomicWrite(DB_PATH, payload).finally(() => {
    flushInFlight = null;
    if (dirty) scheduleFlush();
  });
  return flushInFlight;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DELAY_MS);

  if (typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}

function markDirty() {
  scheduleFlush();
}

function getCollection(key) {
  const data = load();
  if (!(key in data)) {
    data[key] = clone(DEFAULT_SCHEMA[key] ?? {});
  }
  return data[key];
}

function getObjectCollection(key) {
  const collection = getCollection(key);
  if (Array.isArray(collection)) {
    throw new Error(`Collection "${key}" is array-backed.`);
  }
  return collection;
}

function getArrayCollection(key) {
  const collection = getCollection(key);
  if (!Array.isArray(collection)) {
    throw new Error(`Collection "${key}" is object-backed.`);
  }
  return collection;
}

function get(key, id) {
  const collection = getCollection(key);
  if (Array.isArray(collection)) {
    return clone(collection.find((item) => item && item.id === id) || null);
  }
  return clone(collection[id] ?? null);
}

function getUser(jid, fallback = null) {
  const user = get("users", jid);
  return user ?? fallback;
}

function getGroup(jid, fallback = null) {
  const group = get("groups", jid);
  return group ?? fallback;
}

function set(key, id, value) {
  if (ARRAY_COLLECTIONS.has(key)) {
    return upsertArrayItem(key, id, value);
  }

  const collection = getObjectCollection(key);
  collection[id] = clone(value);
  markDirty();
  return clone(collection[id]);
}

function update(key, id, patch) {
  if (ARRAY_COLLECTIONS.has(key)) {
    return patchArrayItem(key, id, patch);
  }

  const collection = getObjectCollection(key);
  collection[id] = {
    ...(collection[id] || {}),
    ...clone(patch),
  };
  markDirty();
  return clone(collection[id]);
}

function deleteById(key, id) {
  if (ARRAY_COLLECTIONS.has(key)) {
    return removeArrayItem(key, id);
  }

  const collection = getObjectCollection(key);
  if (!(id in collection)) return false;
  delete collection[id];
  markDirty();
  return true;
}

function getAll(key) {
  return clone(getCollection(key));
}

function getSetting(key) {
  return clone(getObjectCollection("settings")[key]);
}

function setSetting(key, value) {
  const settings = getObjectCollection("settings");
  settings[key] = clone(value);
  markDirty();
  return clone(settings[key]);
}

function listArray(key) {
  return clone(getArrayCollection(key));
}

function replaceArray(key, items) {
  const data = load();
  data[key] = ensureArray(clone(items));
  markDirty();
  return clone(data[key]);
}

function normalizeSchedulerItem(item) {
  const value = ensureObject(item);
  return {
    id: value.id || null,
    message: String(value.message || ""),
    sessionId: value.sessionId || "main",
    targetType: value.targetType || "all",
    targets: ensureArray(value.targets),
    scheduledAt: value.scheduledAt || null,
    sent: Boolean(value.sent),
    sentAt: value.sentAt || null,
    failed: Boolean(value.failed),
    failedAt: value.failedAt || null,
    lastError: value.lastError || null,
    sentCount: Number(value.sentCount || 0),
    failedCount: Number(value.failedCount || 0),
    attemptedTargets: Number(value.attemptedTargets || 0),
    createdAt: value.createdAt || null,
  };
}

function normalizeAutoReplyRule(rule) {
  const value = ensureObject(rule);
  const allowedMatchTypes = new Set(["exact", "word", "contains", "startsWith", "endsWith", "regex"]);
  const matchType = allowedMatchTypes.has(String(value.matchType || "exact")) ? String(value.matchType || "exact") : "exact";
  const groupsOnly = Boolean(value.groupsOnly) && !Boolean(value.pmOnly);
  const pmOnly = Boolean(value.pmOnly) && !Boolean(value.groupsOnly);
  return {
    id: value.id || null,
    trigger: String(value.trigger || "").trim(),
    response: String(value.response || "").trim(),
    matchType,
    caseSensitive: Boolean(value.caseSensitive),
    groupsOnly,
    pmOnly,
    enabled: value.enabled !== false,
  };
}

function normalizeBroadcastHistoryEntry(entry) {
  const value = ensureObject(entry);
  return {
    id: value.id || null,
    message: String(value.message || ""),
    targets: ensureArray(value.targets),
    sessionId: value.sessionId || "main",
    sent: Number(value.sent || 0),
    failed: Number(value.failed || 0),
    total: Number(value.total || 0),
    sentAt: value.sentAt || null,
    createdAt: value.createdAt || value.sentAt || null,
    status: value.status || "success",
  };
}

function pushArrayItem(key, item) {
  const collection = getArrayCollection(key);
  const copy = clone(item);
  collection.push(copy);
  markDirty();
  return clone(copy);
}

function upsertArrayItem(key, id, value) {
  const collection = getArrayCollection(key);
  const index = collection.findIndex((item) => item && item.id === id);
  const nextValue = { ...(clone(value) || {}), id };

  if (index >= 0) {
    collection[index] = nextValue;
  } else {
    collection.push(nextValue);
  }

  markDirty();
  return clone(nextValue);
}

function patchArrayItem(key, id, patch) {
  const collection = getArrayCollection(key);
  const index = collection.findIndex((item) => item && item.id === id);
  if (index < 0) return null;

  collection[index] = {
    ...collection[index],
    ...clone(patch),
  };
  markDirty();
  return clone(collection[index]);
}

function removeArrayItem(key, id) {
  const collection = getArrayCollection(key);
  const next = collection.filter((item) => item && item.id !== id);
  if (next.length === collection.length) return false;
  replaceArray(key, next);
  return true;
}

function listUsers() {
  const users = getObjectCollection("users");
  const bans = getObjectCollection("bans");
  const verifiedOwners = getSetting("verified_owners") || [];
  const mainOwnerJid = normalizeOwnerJid(OWNER_NUMBER) || normalizeOwnerJid(getSetting("main_owner"));

  const configuredOwners = [
    normalizeOwnerJid(OWNER_NUMBER),
    normalizeOwnerJid(getSetting("main_owner")),
  ].filter(Boolean);

  const ownerSet = new Set([
    ...configuredOwners,
    ...verifiedOwners.map((entry) => normalizeOwnerJid(entry)).filter(Boolean),
  ]);

  const allJids = new Set([
    ...Object.keys(users),
    ...Object.keys(bans),
    ...ownerSet,
  ]);

  const grouped = new Map();

  Array.from(allJids).forEach((jid) => {
    const data = users[jid] || {};
    const identityKey = getManagedIdentityKey(jid, data);
    if (!grouped.has(identityKey)) {
      grouped.set(identityKey, []);
    }
    grouped.get(identityKey).push({ jid, data });
  });

  const results = Array.from(grouped.entries()).map(([identityKey, entries]) => {
    const aliases = entries.map((entry) => entry.jid);
    const prefersMainOwner = mainOwnerJid && getManagedIdentityKey(mainOwnerJid, { number: mainOwnerJid.split("@")[0] }) === identityKey
      ? mainOwnerJid
      : null;
    const displayJid = chooseManagedDisplayJid(aliases, prefersMainOwner) || aliases[0] || identityKey;
    const fallbackDigits = getManagedIdentityDigits(displayJid) || identityKey;

    const merged = {
      jid: displayJid,
      realJid: displayJid,
      aliases,
      number: fallbackDigits || displayJid.split("@")[0],
      balance: 0,
      premium: false,
      isOwner: false,
      wins: 0,
      losses: 0,
      dailyLast: null,
      banned: false,
      joinedAt: null,
      lastSeen: null,
      pushName: null,
    };

    entries.forEach(({ jid, data }) => {
      merged.balance = Math.max(merged.balance, Number(data.coins != null ? data.coins : (data.balance || 0)));
      merged.premium = merged.premium || Boolean(data.premium);
      merged.isOwner = merged.isOwner || ownerSet.has(jid) || Boolean(data.isOwner);
      merged.wins = Math.max(merged.wins, Number(data.wins || 0));
      merged.losses = Math.max(merged.losses, Number(data.losses || 0));
      if (data.dailyLast && (!merged.dailyLast || data.dailyLast > merged.dailyLast)) merged.dailyLast = data.dailyLast;
      merged.banned = merged.banned || Boolean(data.banned || bans[jid]?.banned);
      if (data.joinedAt && (!merged.joinedAt || data.joinedAt < merged.joinedAt)) merged.joinedAt = data.joinedAt;
      if (data.lastSeen && (!merged.lastSeen || data.lastSeen > merged.lastSeen)) merged.lastSeen = data.lastSeen;
      if (data.pushName && !merged.pushName) merged.pushName = data.pushName;
      if (!String(merged.number || "").replace(/\D/g, "") && data.number) {
        merged.number = String(data.number).replace(/\D/g, "");
      }
    });

    return merged;
  });

  return results.sort((a, b) => {
    const ownerDelta = Number(b.isOwner) - Number(a.isOwner);
    if (ownerDelta) return ownerDelta;
    const premiumDelta = Number(b.premium) - Number(a.premium);
    if (premiumDelta) return premiumDelta;
    return String(a.pushName || a.number || a.jid).localeCompare(String(b.pushName || b.number || b.jid));
  });
}

function upsertUser(jid, patch) {
  const normalizedPatch = { ...(patch || {}) };
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "balance")
    && !Object.prototype.hasOwnProperty.call(normalizedPatch, "coins")) {
    normalizedPatch.coins = Number(normalizedPatch.balance) || 0;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "coins")
    && !Object.prototype.hasOwnProperty.call(normalizedPatch, "balance")) {
    normalizedPatch.balance = Number(normalizedPatch.coins) || 0;
  }

  const nextUser = update("users", jid, normalizedPatch);
  if (Object.prototype.hasOwnProperty.call(patch || {}, "banned")) {
    setUserBanned(jid, Boolean(patch.banned));
  }
  return nextUser;
}

function setUserPremium(jid, premium) {
  return update("users", jid, { premium: Boolean(premium) });
}

function setUserBanned(jid, banned) {
  update("users", jid, { banned: Boolean(banned) });

  if (banned) {
    update("bans", jid, { banned: true, at: Date.now() });
  } else {
    deleteById("bans", jid);
  }

  return Boolean(banned);
}

function isUserBanned(jid) {
  if (!jid) return false;
  const bans = getObjectCollection("bans");
  const users = getObjectCollection("users");
  return Boolean(users[jid]?.banned || bans[jid]?.banned);
}

function deleteUser(jid) {
  const users = getObjectCollection("users");
  const bans = getObjectCollection("bans");
  const identityKey = getManagedIdentityKey(jid, users[jid] || {});
  const aliases = new Set([
    String(jid || "").trim().toLowerCase(),
    ...Object.keys(users).filter((entry) => getManagedIdentityKey(entry, users[entry] || {}) === identityKey),
    ...Object.keys(bans).filter((entry) => getManagedIdentityKey(entry, users[entry] || {}) === identityKey),
  ]);
  const verifiedOwners = (getSetting("verified_owners") || []).filter((entry) => getManagedIdentityKey(entry) !== identityKey);
  setSetting("verified_owners", verifiedOwners);
  aliases.forEach((entry) => {
    deleteById("bans", entry);
    deleteById("users", entry);
  });
  return aliases.size > 0;
}

function listGroups() {
  const groups = getObjectCollection("groups");

  return Object.entries(groups).map(([jid, data]) => ({
    jid,
    name: data.name || jid.split("@")[0],
    sessionId: data.sessionId || "main",
    memberCount: Number(data.memberCount || 0),
    isMuted: Boolean(data.isMuted),
    antiLink: Boolean(data.antiLink || data.antilink),
    antiSpam: Boolean(data.antiSpam),
    welcome: Boolean(data.welcome || data.welcomeEnabled),
    welcomeEnabled: Boolean(data.welcomeEnabled || data.welcome),
    welcomeMessage: data.welcomeMessage || "Welcome to the group!",
    goodbye: Boolean(data.goodbye || data.goodbyeEnabled),
    goodbyeEnabled: Boolean(data.goodbyeEnabled || data.goodbye),
    nsfw: Boolean(data.nsfw),
  }));
}



function getCommandSettings() {
  return getObjectCollection("commandSettings");
}

function setCommandEnabled(name, enabled) {
  return update("commandSettings", name, { enabled: Boolean(enabled) });
}

function addSchedulerItem(item) {
  return pushArrayItem("scheduler", normalizeSchedulerItem(item));
}

function listScheduler() {
  return listArray("scheduler").map(normalizeSchedulerItem);
}

function removeSchedulerItem(id) {
  return removeArrayItem("scheduler", id);
}

function updateSchedulerItem(id, patch) {
  return patchArrayItem("scheduler", id, patch);
}

function addAutoReply(rule) {
  return pushArrayItem("autoReply", normalizeAutoReplyRule(rule));
}

function listAutoReply() {
  return listArray("autoReply").map(normalizeAutoReplyRule);
}

function updateAutoReply(id, patch) {
  return patchArrayItem("autoReply", id, patch);
}

function removeAutoReply(id) {
  return removeArrayItem("autoReply", id);
}

function addBroadcastHistory(entry, limit = 50) {
  const history = getArrayCollection("broadcastHistory");
  history.unshift(normalizeBroadcastHistoryEntry(entry));
  if (history.length > limit) {
    history.length = limit;
  }
  markDirty();
  return clone(history[0]);
}

function listBroadcastHistory() {
  return listArray("broadcastHistory").map(normalizeBroadcastHistoryEntry);
}

function getSecuritySnapshot() {
  const settings = getObjectCollection("settings");
  return {
    userCount: Object.keys(getObjectCollection("users")).length,
    groupCount: Object.keys(getObjectCollection("groups")).length,
    bannedCount: Object.keys(getObjectCollection("bans")).length,
    autoReplyCount: getArrayCollection("autoReply").length,
    scheduledCount: getArrayCollection("scheduler").length,
    broadcastCount: getArrayCollection("broadcastHistory").length,
    prefix: settings.prefix || null,
    workMode: settings.work_mode || null,
  };
}

for (const eventName of ["exit", "SIGINT", "SIGTERM", "beforeExit"]) {
  process.on(eventName, () => {
    try {
      flush();
    } catch { }
  });
}

module.exports = {
  DB_PATH,
  DEFAULT_SCHEMA,
  get,
  getUser,
  getGroup,
  set,
  update,
  delete: deleteById,
  getAll,
  getSetting,
  setSetting,
  listArray,
  replaceArray,
  pushArrayItem,
  upsertArrayItem,
  patchArrayItem,
  removeArrayItem,
  getManagedIdentityKey,
  listUsers,
  upsertUser,
  setUserPremium,
  setUserBanned,
  isUserBanned,
  deleteUser,
  listGroups,
  getCommandSettings,
  setCommandEnabled,
  addSchedulerItem,
  listScheduler,
  removeSchedulerItem,
  updateSchedulerItem,
  addAutoReply,
  listAutoReply,
  updateAutoReply,
  removeAutoReply,
  addBroadcastHistory,
  listBroadcastHistory,
  getSecuritySnapshot,
  getObjectCollection,
  flush,
};
