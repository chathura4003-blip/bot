"use strict";

/**
 * Role-Aware Advanced Menu System
 *
 * Two-level menu:
 *   1. Top level — 10 main categories with the user-requested layout.
 *   2. Per-category — drill-down list of the actual commands in that
 *      category.
 *
 * Three activation paths every level supports:
 *   • Tap a button   (buttonsResponseMessage / templateButtonReplyMessage)
 *   • Pick a list row (listResponseMessage)
 *   • Tap an interactive native-flow option (interactiveResponseMessage)
 *   • Plain number reply (1, 2, 3, …) routed via the numericCache + the
 *     ADVANCED MENU marker embedded in every rendered menu.
 *
 * Action ID format:
 *   rolemenu:cat:<categoryId>   → open the category's sub-menu
 *   rolemenu:cmd:<commandName>  → execute a command (existing behaviour)
 */

const { MemoryCache } = require("./memory-cache");

const MENU_MARKER   = "ADVANCED MENU";
const ACTION_PREFIX = "rolemenu:";

// 10-minute cache, keyed by sender JID. Each entry remembers what the user
// is currently looking at so a plain numeric reply can be resolved correctly.
const numericCache = new MemoryCache(600000);

// ---------------------------------------------------------------------------
// Role detection
// ---------------------------------------------------------------------------

function detectRole(sender, { ownerRefs = [], isOwner, db } = {}) {
  if (!isOwner) isOwner = require("./utils").isOwner;
  if (!db) db = require("./db");

  const isOwnerUser = isOwner(sender, ownerRefs);
  const userData    = db.getUser(sender) || {};
  const isPremium   = Boolean(userData.premium);

  if (isOwnerUser && isPremium) return "premium-owner";
  if (isOwnerUser)              return "owner";
  if (isPremium)                return "premium";
  return "normal";
}

function roleLabel(role) {
  switch (role) {
    case "premium-owner": return "Premium Owner";
    case "owner":         return "Owner";
    case "premium":       return "Premium";
    default:              return "Member";
  }
}

// ---------------------------------------------------------------------------
// Category definitions — order here is the order shown in the menu, which
// also determines the numeric mapping (1-N).
// ---------------------------------------------------------------------------

const ALL_ROLES = ["normal", "premium", "owner", "premium-owner"];
const PREM_PLUS = ["premium", "owner", "premium-owner"];
const OWNER_ONLY = ["owner", "premium-owner"];

const CATEGORIES = [
  {
    id: "ai",
    title: "🤖 AI Center",
    subtitle: "Conversational AI, image gen, auto-reply",
    roles: ALL_ROLES,
    commands: [
      { cmd: "ai",     desc: "Ask the AI anything" },
      { cmd: "chat",   desc: "Conversational chat" },
      { cmd: "gpt",    desc: "GPT shortcut" },
      { cmd: "img",    desc: "AI image generation" },
      { cmd: "aiauto", desc: "AI auto-reply settings" },
    ],
  },
  {
    id: "voice",
    title: "🎙 Voice & TTS",
    subtitle: "Text-to-speech and translation",
    roles: ALL_ROLES,
    commands: [
      { cmd: "tts",       desc: "Text-to-speech" },
      { cmd: "translate", desc: "Translate text" },
      { cmd: "trt",       desc: "Translate shortcut" },
    ],
  },
  {
    id: "downloader",
    title: "🎬 Downloader",
    subtitle: "YouTube, TikTok, Instagram, Facebook…",
    roles: ALL_ROLES,
    commands: [
      { cmd: "play",      desc: "Music search & play" },
      { cmd: "song",      desc: "Music download" },
      { cmd: "playvideo", desc: "Video preview play" },
      { cmd: "yt",        desc: "YouTube link" },
      { cmd: "tt",        desc: "TikTok video" },
      { cmd: "ig",        desc: "Instagram media" },
      { cmd: "fb",        desc: "Facebook video" },
      { cmd: "video",     desc: "Generic video link" },
      { cmd: "movie",     desc: "Search & download movies" },
      { cmd: "baiscop",   desc: "Baiscope movie downloader" },
    ],
  },
  {
    id: "nsfw",
    title: "🍆 18+ 💦",
    subtitle: "Adult content (premium only)",
    roles: PREM_PLUS,
    commands: [
      { cmd: "nsfw",     desc: "Toggle NSFW for this chat" },
      { cmd: "boobs",    desc: "Random NSFW image" },
      { cmd: "ass",      desc: "Random NSFW image" },
      { cmd: "waifu",    desc: "Anime waifu" },
      { cmd: "blowjob",  desc: "Random NSFW image" },
      { cmd: "ph",       desc: "Pornhub video" },
      { cmd: "xnxx",     desc: "XNXX video" },
      { cmd: "xv",       desc: "Xvideos video" },
    ],
  },
  {
    id: "media",
    title: "🎨 Media Tools",
    subtitle: "Stickers, profile pics, status",
    roles: ALL_ROLES,
    commands: [
      { cmd: "sticker", desc: "Image / video → sticker" },
      { cmd: "s",       desc: "Sticker shortcut" },
      { cmd: "steal",   desc: "Save a status / view-once" },
      { cmd: "pp",      desc: "Profile picture" },
      { cmd: "vcard",   desc: "Generate vCard" },
    ],
  },
  {
    id: "group",
    title: "👥 Group Control",
    subtitle: "Welcome, kick, promote, antilink",
    roles: ALL_ROLES,
    commands: [
      { cmd: "welcome",  desc: "Welcome message" },
      { cmd: "goodbye",  desc: "Goodbye message" },
      { cmd: "kick",     desc: "Remove member" },
      { cmd: "add",      desc: "Add member" },
      { cmd: "promote",  desc: "Promote to admin" },
      { cmd: "demote",   desc: "Demote from admin" },
      { cmd: "lock",     desc: "Lock chat (admins only)" },
      { cmd: "unlock",   desc: "Unlock chat" },
    ],
  },
  {
    id: "privacy",
    title: "🛡 Privacy & Security",
    subtitle: "Anti view-once, anti-link, blocklist",
    roles: ALL_ROLES,
    commands: [
      { cmd: "antivo",   desc: "Anti view-once toggle" },
      { cmd: "antilink", desc: "Anti-link toggle" },
      { cmd: "block",    desc: "Block a user" },
      { cmd: "unblock",  desc: "Unblock a user" },
      { cmd: "listblock",desc: "List blocked users" },
    ],
  },
  {
    id: "settings",
    title: "⚙️ Bot Settings",
    subtitle: "Theme, mode, prefix, keys",
    roles: ALL_ROLES,
    commands: [
      { cmd: "settings", desc: "Open settings panel" },
      { cmd: "theme",    desc: "Change theme" },
      { cmd: "mode",     desc: "Change work mode" },
      { cmd: "setkey",   desc: "Set API key (owner)" },
      { cmd: "autoview", desc: "Auto-view status" },
      { cmd: "autoreact",desc: "Auto-react to status" },
    ],
  },
  {
    id: "owner",
    title: "👑 Owner Panel",
    subtitle: "Broadcast, ban, reload, owners",
    roles: OWNER_ONLY,
    commands: [
      { cmd: "broadcast", desc: "Broadcast message" },
      { cmd: "ban",       desc: "Ban a user" },
      { cmd: "unban",     desc: "Unban a user" },
      { cmd: "addowner",  desc: "Add an owner" },
      { cmd: "delowner",  desc: "Remove an owner" },
      { cmd: "listowner", desc: "List owners" },
      { cmd: "reload",    desc: "Reload commands" },
      { cmd: "update",    desc: "Update bot" },
    ],
  },
  {
    id: "system",
    title: "📊 System Status",
    subtitle: "Ping, alive, menu",
    roles: ALL_ROLES,
    commands: [
      { cmd: "ping",   desc: "Bot latency" },
      { cmd: "alive",  desc: "Bot status card" },
      { cmd: "system", desc: "System info" },
      { cmd: "status", desc: "Status snapshot" },
      { cmd: "menu",   desc: "Classic menu" },
    ],
  },
];

function categoriesForRole(role) {
  return CATEGORIES.filter((c) => c.roles.includes(role));
}

function getCategoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

// ---------------------------------------------------------------------------
// Item builders & numeric cache
// ---------------------------------------------------------------------------

/**
 * Top-level items = the 10 main categories visible to this role.
 * Each item carries a numeric `index` and a `cat:<id>` action.
 */
function buildTopLevelItems(role) {
  return categoriesForRole(role).map((c, i) => ({
    index:    i + 1,
    type:     "cat",
    value:    c.id,
    title:    c.title,
    subtitle: c.subtitle,
  }));
}

/**
 * Sub-menu items for a single category = its commands, filtered by role.
 */
function buildCategoryItems(role, categoryId) {
  const cat = getCategoryById(categoryId);
  if (!cat || !cat.roles.includes(role)) return null;
  return cat.commands.map((c, i) => ({
    index:    i + 1,
    type:     "cmd",
    value:    c.cmd,
    title:    c.cmd,
    subtitle: c.desc,
  }));
}

/**
 * Cache the numeric mapping for a sender so a plain "1" / "2" reply can be
 * resolved later. Stores the level + items + role context, keyed by the
 * outbound message id(s) of the menu we just rendered. A "latest" pointer
 * is also kept as a fallback for clients that strip stanzaId from quoted
 * replies.
 *
 * @param {string}   sender   Sender JID
 * @param {Object}   payload  { level, items, role, categoryId? }
 * @param {string[]} msgIds   IDs of the messages that constitute this menu
 *                            (text fallback + native-flow). At least one
 *                            should be supplied so a quoted reply can be
 *                            mapped back to the correct level.
 */
function rememberNumericMapping(sender, payload, msgIds = []) {
  if (!sender) return;
  const entry = { ...payload, ts: Date.now(), msgIds: msgIds.filter(Boolean) };
  // Per-stanza buckets: `${sender}|${msgId}` → entry. Lets two menus from the
  // same sender (e.g. top-level + drilled-in sub-menu) coexist so quoting
  // the older one still resolves to its own items.
  for (const id of entry.msgIds) {
    if (id) numericCache.set(`${sender}|${id}`, entry, 600000);
  }
  // "Latest" pointer for clients that don't include stanzaId.
  numericCache.set(sender, entry, 600000);
}

/**
 * Prime ONLY the sender-keyed fallback entry. Call this *before* sending the
 * outbound menu so a very fast numeric reply (arriving while the network
 * round-trip for the menu is still in flight) can still be resolved against
 * the items list. The full rememberNumericMapping(...) call should follow
 * once outbound message ids are known, to add per-stanza buckets.
 */
function primeNumericFallback(sender, payload) {
  if (!sender) return;
  numericCache.set(sender, { ...payload, ts: Date.now(), msgIds: [] }, 600000);
}

/**
 * Resolve a numeric reply.
 *
 * @param {string}  sender    Sender JID
 * @param {number}  num       Number the user typed (1-based)
 * @param {string=} stanzaId  ID of the message the user *quoted* in their
 *                            reply. When present, this is the authoritative
 *                            way to pick the correct cache entry — quoting
 *                            the original top-level menu after drilling
 *                            into a sub-menu correctly resolves against the
 *                            top-level items, not the latest sub-menu.
 */
function resolveNumeric(sender, num, stanzaId) {
  if (!sender || !Number.isFinite(num)) return null;
  let entry = null;
  if (stanzaId) entry = numericCache.get(`${sender}|${stanzaId}`);
  if (!entry)   entry = numericCache.get(sender); // fallback: latest
  if (!entry || !Array.isArray(entry.items)) return null;
  const item = entry.items.find((it) => it.index === num);
  if (!item) return null;
  return { type: item.type, value: item.value, level: entry.level || "top", item };
}

// ---------------------------------------------------------------------------
// Interactive selection resolution
// ---------------------------------------------------------------------------

function resolveInteractiveSelection(msg) {
  if (!msg || !msg.message) return null;
  for (const id of collectSelectionIds(msg.message)) {
    if (typeof id !== "string" || !id.startsWith(ACTION_PREFIX)) continue;
    const parts = id.slice(ACTION_PREFIX.length).split(":");
    const kind  = parts[0];
    const value = parts.slice(1).join(":");
    if ((kind === "cmd" || kind === "cat") && value) {
      return { type: kind, value, rawId: id };
    }
  }
  return null;
}

function collectSelectionIds(message) {
  const out = [];
  const list = message.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (list) out.push(list);

  const btn = message.buttonsResponseMessage?.selectedButtonId;
  if (btn) out.push(btn);

  const tpl = message.templateButtonReplyMessage?.selectedId;
  if (tpl) out.push(tpl);

  const nfm = message.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nfm?.paramsJson) {
    try {
      const parsed = JSON.parse(nfm.paramsJson);
      if (parsed?.id) out.push(parsed.id);
    } catch (_) { /* ignore */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering — text fallback (matches the user's exact mockup format)
// ---------------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, "0"); }

function safeName(s) {
  if (!s) return "there";
  return String(s).split(/[\s|·•·]/)[0].slice(0, 24) || "there";
}

function uiModeLabel() {
  return "Button Mode Auto";
}

/**
 * Render the top-level "main categories" menu in the user's requested
 * box-drawing layout.
 */
function renderTopLevelText({ role, prefix, botName, sender, pushName, workMode }) {
  const items = buildTopLevelItems(role);
  const lines = [];
  lines.push(`╭━━━〔 🤖 ${String(botName).toUpperCase()} 〕━━━╮`);
  lines.push("┃");
  lines.push(`┃ 👋 Welcome, ${safeName(pushName)}`);
  lines.push("┃ 🟢 Status: Online");
  lines.push(`┃ ⚡ Mode: ${capitalize(workMode || "Public")}`);
  lines.push(`┃ 🔘 UI: ${uiModeLabel()}`);
  lines.push("┃");
  lines.push("┣━━〔 MAIN CATEGORIES 〕");
  for (const it of items) {
    lines.push(`┃ ${pad2(it.index)}. ${it.title}`);
  }
  lines.push("┃");
  lines.push("┣━━〔 HOW TO USE 〕");
  lines.push("┃ • Tap a button or list row below");
  lines.push("┃ • Or reply with the option number (e.g. 1)");
  lines.push(`┃ • Role: ${roleLabel(role)} • Prefix: ${prefix}`);
  lines.push("┃");
  lines.push("╰━━━━━━━━━━━━━━━━━━━━━━╯");
  // Marker for numeric-reply detection (kept on its own line so quoted-text
  // matching always finds it even if WhatsApp trims long messages).
  lines.push(MENU_MARKER);
  return lines.join("\n");
}

/**
 * Render a category sub-menu (drill-down). Same box-drawing style.
 */
function renderCategoryText({ role, prefix, botName, categoryId }) {
  const cat = getCategoryById(categoryId);
  const items = buildCategoryItems(role, categoryId) || [];
  const lines = [];
  lines.push(`╭━━━〔 ${cat ? cat.title : "Menu"} 〕━━━╮`);
  lines.push("┃");
  if (cat?.subtitle) {
    lines.push(`┃ ${cat.subtitle}`);
    lines.push("┃");
  }
  if (!items.length) {
    lines.push("┃ ⚠️ No commands available for your role.");
  } else {
    for (const it of items) {
      lines.push(`┃ ${pad2(it.index)}. ${prefix}${it.value} — ${it.subtitle}`);
    }
  }
  lines.push("┃");
  lines.push("┣━━〔 HOW TO USE 〕");
  lines.push("┃ • Tap a button to run a command");
  lines.push("┃ • Or reply with the option number");
  lines.push(`┃ • Type ${prefix}menupro to go back to main`);
  lines.push("┃");
  lines.push("╰━━━━━━━━━━━━━━━━━━━━━━╯");
  lines.push(MENU_MARKER);
  return lines.join("\n");
}

function capitalize(s) {
  if (!s) return "";
  s = String(s);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Native-flow interactive payloads
// ---------------------------------------------------------------------------

/**
 * Build the interactive top-level message: a single-select list of all 10
 * (role-filtered) categories plus up to 3 quick-action buttons.
 */
function buildTopLevelInteractive({ role, prefix, botName, items, bodyText, footerText }) {
  const { proto } = require("@whiskeysockets/baileys");

  const rows = items.map((it) => ({
    header: "",
    title:  `${pad2(it.index)}. ${it.title}`,
    description: it.subtitle || "",
    id:     `${ACTION_PREFIX}cat:${it.value}`,
  }));

  const listButton = {
    name: "single_select",
    buttonParamsJson: JSON.stringify({
      title: "📋 Open Categories",
      sections: [{ title: "Main Categories", rows }],
    }),
  };

  // Quick-pick three categories so a tap can drill in immediately on clients
  // that render quick buttons more prominently than lists.
  const quickPicks = items.slice(0, 3).map((it) => ({
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({
      display_text: `${pad2(it.index)}. ${stripLeadingEmoji(it.title)}`,
      id: `${ACTION_PREFIX}cat:${it.value}`,
    }),
  }));

  const interactive = proto.Message.InteractiveMessage.fromObject({
    body:   { text: bodyText },
    footer: { text: footerText },
    header: {
      title:    `${botName} • Main Menu`,
      subtitle: `Role: ${roleLabel(role)} • Prefix: ${prefix}`,
      hasMediaAttachment: false,
    },
    nativeFlowMessage: {
      buttons: [listButton, ...quickPicks],
      messageParamsJson: "",
    },
  });

  return { interactiveMessage: interactive };
}

/**
 * Build the interactive sub-menu for a single category: list of its commands
 * plus a "← Back to Main" button.
 */
function buildCategoryInteractive({ role, prefix, botName, categoryId, items, bodyText, footerText }) {
  const { proto } = require("@whiskeysockets/baileys");
  const cat = getCategoryById(categoryId);

  const rows = items.map((it) => ({
    header: "",
    title:  `${pad2(it.index)}. ${prefix}${it.value}`,
    description: it.subtitle || "",
    id:     `${ACTION_PREFIX}cmd:${it.value}`,
  }));

  const listButton = {
    name: "single_select",
    buttonParamsJson: JSON.stringify({
      title: "📋 Open Commands",
      sections: [{ title: cat ? cat.title : "Commands", rows }],
    }),
  };

  // Up to two quick replies for the most-used commands of this category.
  const quickPicks = items.slice(0, 2).map((it) => ({
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({
      display_text: `${pad2(it.index)}. ${prefix}${it.value}`,
      id: `${ACTION_PREFIX}cmd:${it.value}`,
    }),
  }));

  const interactive = proto.Message.InteractiveMessage.fromObject({
    body:   { text: bodyText },
    footer: { text: footerText },
    header: {
      title:    `${botName} • ${cat ? cat.title : "Menu"}`,
      subtitle: `Role: ${roleLabel(role)} • Prefix: ${prefix}`,
      hasMediaAttachment: false,
    },
    nativeFlowMessage: {
      buttons: [listButton, ...quickPicks],
      messageParamsJson: "",
    },
  });

  return { interactiveMessage: interactive };
}

function stripLeadingEmoji(s) {
  // Lightweight trim of leading emoji + space so quick-button text stays short.
  return String(s).replace(/^[^\w(]+/u, "").trim() || s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = {
  MENU_MARKER,
  ACTION_PREFIX,
  CATEGORIES,
  detectRole,
  roleLabel,
  categoriesForRole,
  getCategoryById,
  buildTopLevelItems,
  buildCategoryItems,
  renderTopLevelText,
  renderCategoryText,
  rememberNumericMapping,
  primeNumericFallback,
  resolveNumeric,
  resolveInteractiveSelection,
  buildTopLevelInteractive,
  buildCategoryInteractive,
};
