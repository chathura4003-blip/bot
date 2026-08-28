"use strict";

/**
 * Access control for menu items and dispatched commands.
 *
 * Validates the same rules at *render time* (so we don't show items the user
 * cannot run) AND again at *execute time* (button taps / list selections /
 * numeric replies must not bypass the filter).
 */

const roleHelper = require("./role-menu");

function getUserRoleFromContext(context = {}) {
  return roleHelper.getUserRole(context);
}

/**
 * canAccess(item, context) → { allowed: bool, reason?: string, message?: string }
 *
 * `item` may carry: ownerOnly, premiumOnly, premiumOwnerOnly, roles[],
 * hideForRoles[], groupOnly, pmOnly, disabled.
 */
function canAccess(item, context = {}) {
  if (!item) return { allowed: false, reason: "missing_item", message: "⚠️ Item not available." };

  if (item.disabled) {
    return { allowed: false, reason: "disabled", message: "⚠️ This option is currently disabled." };
  }

  const role = getUserRoleFromContext(context);
  if (!roleHelper.canSeeItem(item, role)) {
    if (item.ownerOnly || item.premiumOwnerOnly) {
      return { allowed: false, reason: "owner_only", message: "❌ This option is only available for the bot owner." };
    }
    if (item.premiumOnly) {
      return { allowed: false, reason: "premium_only", message: "⭐ This option is only available for premium users." };
    }
    return { allowed: false, reason: "role_restricted", message: "⚠️ This option is not available for your role." };
  }

  // Chat-type gating
  const chatJid = context.chatJid || context.from || "";
  const isGroup = String(chatJid).endsWith("@g.us");
  if (item.groupOnly && !isGroup) {
    return { allowed: false, reason: "group_only", message: "⚠️ This option only works inside a group chat." };
  }
  if (item.pmOnly && isGroup) {
    return { allowed: false, reason: "pm_only", message: "⚠️ This option only works in private chat." };
  }

  return { allowed: true, role };
}

module.exports = {
  canAccess,
  getUserRoleFromContext,
};
