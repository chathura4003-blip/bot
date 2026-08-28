"use strict";

/**
 * Role helpers for the bot-wide menu system.
 *
 * - getUserRole(context)            → "normal" | "premium" | "owner" | "premium_owner"
 * - filterItemsByRole(items, role, context) → drop items the role can't see
 * - roleLabel(role)                 → human label for headers
 *
 * Role detection mirrors the legacy `lib/role-menu.js` but uses underscore
 * style names so they match the spec exactly. Both styles ("premium-owner"
 * and "premium_owner") are accepted as aliases.
 */

const ROLE_NORMAL         = "normal";
const ROLE_PREMIUM        = "premium";
const ROLE_OWNER          = "owner";
const ROLE_PREMIUM_OWNER  = "premium_owner";

function _isOwnerJid(sender, ownerRefs) {
  try {
    return require("../utils").isOwner(sender, ownerRefs || []);
  } catch (_) { return false; }
}

function _isPremiumJid(sender) {
  if (!sender) return false;
  try {
    const db = require("../db");
    const u = db.getUser ? db.getUser(sender) : db.get && db.get("users", sender);
    return Boolean(u && u.premium);
  } catch (_) { return false; }
}

function getUserRole(context = {}) {
  // Explicit override (used by /bot-api/menu-ui/preview so the dashboard's
  // role dropdown actually changes what the preview renders, even though the
  // synthetic sender JID isn't in any owner / premium DB row).
  if (context.roleOverride) {
    const r = _normalizeRole(context.roleOverride);
    if (r === ROLE_PREMIUM_OWNER || r === ROLE_OWNER || r === ROLE_PREMIUM || r === ROLE_NORMAL) {
      return r;
    }
  }
  const sender    = context.sender || context.userJid || null;
  const ownerRefs = context.ownerRefs || (context.owner ? [context.owner] : []);
  const isOwn     = _isOwnerJid(sender, ownerRefs);
  const isPrem    = _isPremiumJid(sender);
  if (isOwn && isPrem) return ROLE_PREMIUM_OWNER;
  if (isOwn)           return ROLE_OWNER;
  if (isPrem)          return ROLE_PREMIUM;
  return ROLE_NORMAL;
}

function _normalizeRole(r) {
  if (!r) return ROLE_NORMAL;
  return String(r).toLowerCase().replace(/-/g, "_");
}

function _isOwnerRole(r) {
  const n = _normalizeRole(r);
  return n === ROLE_OWNER || n === ROLE_PREMIUM_OWNER;
}

function _isPremiumPlus(r) {
  const n = _normalizeRole(r);
  return n === ROLE_PREMIUM || n === ROLE_OWNER || n === ROLE_PREMIUM_OWNER;
}

/**
 * Decide whether a single menu item is visible to the given role.
 *
 * Item flags honoured:
 *   - ownerOnly          → only owners (and premium_owner)
 *   - premiumOnly        → only premium / owner / premium_owner
 *   - premiumOwnerOnly   → only premium_owner
 *   - roles: ["normal","premium","owner","premium_owner"] (whitelist)
 *   - hideForRoles: [...] (blacklist)
 */
function canSeeItem(item, role) {
  if (!item) return false;
  const r = _normalizeRole(role);
  if (item.premiumOwnerOnly) return r === ROLE_PREMIUM_OWNER;
  if (item.ownerOnly) return _isOwnerRole(r);
  if (item.premiumOnly) return _isPremiumPlus(r);
  if (Array.isArray(item.roles) && item.roles.length) {
    return item.roles.map(_normalizeRole).includes(r);
  }
  if (Array.isArray(item.hideForRoles) && item.hideForRoles.length) {
    return !item.hideForRoles.map(_normalizeRole).includes(r);
  }
  return true;
}

function filterItemsByRole(items, role) {
  if (!Array.isArray(items)) return [];
  return items.filter((it) => canSeeItem(it, role));
}

function roleLabel(role) {
  switch (_normalizeRole(role)) {
    case ROLE_PREMIUM_OWNER: return "Premium Owner";
    case ROLE_OWNER:         return "Owner";
    case ROLE_PREMIUM:       return "Premium";
    default:                 return "Member";
  }
}

module.exports = {
  ROLE_NORMAL,
  ROLE_PREMIUM,
  ROLE_OWNER,
  ROLE_PREMIUM_OWNER,
  getUserRole,
  filterItemsByRole,
  canSeeItem,
  roleLabel,
};
