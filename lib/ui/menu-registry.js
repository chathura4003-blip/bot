"use strict";

/**
 * Menu Registry — builds the bot-wide category & command menu items by
 * reusing the existing command registry (lib/role-menu.js CATEGORIES) so we
 * don't have to maintain a parallel hand-written list.
 *
 * Two top-level entry points:
 *   • buildTopLevelMenu(context)        → main "Choose Category" menu
 *   • buildCategoryMenu(catId, context) → per-category drill-down menu
 *
 * Each returned menu is in the shape sendMenu() expects:
 *   { id, type, title, sectionTitle, headerFields, items: [{ index, label, title, description, action, ownerOnly?, premiumOnly? }], previousMenu }
 */

const legacy   = require("../role-menu");
const roleHelp = require("./role-menu");

// Map legacy roles[] entries → flags ui/role-menu.js understands.
function _legacyToFlags(cat) {
  const roles = (cat && cat.roles) || [];
  const norm  = roles.map((r) => String(r).toLowerCase().replace(/-/g, "_"));
  const out = {};
  // Owner-only: only owner / premium_owner
  if (norm.length && !norm.includes("normal") && !norm.includes("premium")) {
    out.ownerOnly = true;
  } else if (norm.length && !norm.includes("normal")) {
    // Premium+ (excludes "normal")
    out.premiumOnly = true;
  }
  return out;
}

function _categoryToItem(cat, idx) {
  const flags = _legacyToFlags(cat);
  return {
    index: idx,
    title: cat.title,
    label: cat.title,
    shortLabel: cat.title.length > 24 ? cat.title.slice(0, 22) + "…" : cat.title,
    description: cat.subtitle || "",
    action: `menu:cat:${cat.id}`,
    ...flags,
    payload: { categoryId: cat.id },
  };
}

function _commandToItem(prefix, c, idx) {
  return {
    index: idx,
    title: `${prefix}${c.cmd}`,
    label: `${prefix}${c.cmd}`,
    description: c.desc || "",
    action: `menu:cmd:${c.cmd}`,
    payload: { command: c.cmd },
  };
}

function _activeBotName(context = {}) {
  if (context.botName) return context.botName;
  try {
    const { getBotName } = require("../runtime-settings");
    return getBotName ? getBotName() : "CHATHU MD";
  } catch (_) { return "CHATHU MD"; }
}

function _activePrefix(context = {}) {
  if (context.prefix) return context.prefix;
  try {
    const { getPrefix } = require("../runtime-settings");
    return getPrefix ? getPrefix() : ".";
  } catch (_) { return "."; }
}

function _workMode() {
  try {
    const appState = require("../../state");
    return appState.getWorkMode ? appState.getWorkMode() : "public";
  } catch (_) { return "public"; }
}

function _buttonMode() {
  try {
    const { getButtonMode } = require("./button-mode");
    return getButtonMode().toUpperCase();
  } catch (_) { return "AUTO"; }
}

// Pull the top-level CTA banner image + Visit Us URL button out of env.
// All optional — when nothing is set the menu sends without an image
// header and without CTA pills, so the fallback is exactly the pre-PR
// layout.
//
//   MENU_BANNER_URL  → header image shown above the body / buttons
//   MENU_WEBSITE_URL → "🔗 Visit Us"  CTA URL button (opens link)
function _menuExtras() {
  const image = process.env.MENU_BANNER_URL ? { url: String(process.env.MENU_BANNER_URL).trim() } : null;

  const extras = [];
  if (process.env.MENU_WEBSITE_URL) {
    extras.push({ type: "url", text: "🔗 Visit Us", url: String(process.env.MENU_WEBSITE_URL).trim() });
  }
  return { image, extras };
}

function buildTopLevelMenu(context = {}) {
  const role     = roleHelp.getUserRole(context);
  const prefix   = _activePrefix(context);
  const botName  = _activeBotName(context);
  const pushName = context.pushName || "";

  const visibleCats = legacy.CATEGORIES.filter((c) => {
    const norm = (c.roles || []).map((r) => String(r).toLowerCase().replace(/-/g, "_"));
    return norm.includes(role);
  });

  const items = visibleCats.map((c, i) => _categoryToItem(c, i + 1));
  const { image, extras } = _menuExtras();

  return {
    id:           "main",
    type:         "menu",
    level:        "top",
    title:        `🤖 ${String(botName).toUpperCase()} V4`,
    titleShort:   "Main Menu",
    sectionTitle: "MAIN CATEGORIES",
    buttonText:   "📋 Open Menu",
    // Single status line — the user wanted the menu compact, so drop the
    // separate "Online" line and keep only the work-mode indicator.
    headerFields: [
      { label: "⚡ Mode", value: _capitalize(_workMode()) },
    ],
    welcome:      true,
    items,
    image,
    extraButtons: extras,
    payload: { role },
    previousMenu: null,
    footer: `${botName} • Role: ${roleHelp.roleLabel(role)}`,
    navigation: { home: false, list: true, back: false },
    context: { pushName, prefix, role, botName },
  };
}

function buildCategoryMenu(categoryId, context = {}) {
  const cat = legacy.getCategoryById(categoryId);
  if (!cat) return null;
  const role = roleHelp.getUserRole(context);
  const allowedRoles = (cat.roles || []).map((r) => String(r).toLowerCase().replace(/-/g, "_"));
  if (!allowedRoles.includes(role)) return { ...buildTopLevelMenu(context), accessDenied: true };

  const prefix = _activePrefix(context);
  const items = (cat.commands || []).map((c, i) => _commandToItem(prefix, c, i + 1));

  return {
    id:           `cat:${cat.id}`,
    type:         "menu",
    level:        "category",
    categoryId:   cat.id,
    title:        cat.title,
    titleShort:   cat.title,
    sectionTitle: "COMMANDS",
    buttonText:   "📋 Choose Command",
    headerFields: cat.subtitle ? [{ label: cat.subtitle, value: "" }] : [],
    items,
    payload:      { categoryId: cat.id, role },
    previousMenu: { id: "main" },
    footer:       `${_activeBotName(context)} • ${cat.title}`,
    navigation:   { back: true, home: true, list: true },
  };
}

function _capitalize(s) {
  if (!s) return "";
  s = String(s);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

module.exports = {
  buildTopLevelMenu,
  buildCategoryMenu,
};
