"use strict";

/**
 * Role-Aware Advanced Menu Command
 *
 * Sends a two-level menu:
 *   1. Top level — 10 main categories with the user-requested layout.
 *   2. Sub-menu — drill-down list of commands for a chosen category. The
 *      sub-menu is sent by `sendCategorySubmenu()` which the handler calls
 *      when a "cat:<id>" selection comes back from the user.
 *
 * Both levels send a rich text fallback (always renders) followed by a
 * native-flow interactive payload (buttons + single-select list) when the
 * sock supports it.
 */

const { logger } = require("../../logger");
const { getPrefix, getBotName } = require("../runtime-settings");
const { sendReact } = require("../utils");
const appState = require("../../state");
const roleMenu = require("../role-menu");

module.exports = {
  name: "menupro",
  aliases: ["rmenu", "advmenu", "fullmenu", "rolemenu", "promenu"],
  description: "Advanced role-aware menu (button + list + number reply)",
  category: "system",

  async execute(sock, msg, from, args, name, context = {}) {
    const sender    = msg.key.participant || msg.key.remoteJid || from;
    const ownerRefs = context.owner ? [context.owner] : [];
    const prefix    = context.prefix  || getPrefix();
    const botName   = context.botName || getBotName();
    const pushName  = context.pushName || msg.pushName || "";
    const workMode  = appState.getWorkMode ? appState.getWorkMode() : "public";

    const role  = roleMenu.detectRole(sender, { ownerRefs });
    const items = roleMenu.buildTopLevelItems(role);

    // Prime the sender-keyed fallback BEFORE any awaited I/O so a very fast
    // numeric reply (arriving while the outbound menu is still in flight)
    // can still be resolved against the items list. The full per-stanza
    // mapping is added once message ids are known.
    roleMenu.primeNumericFallback(sender, { level: "top", items, role });

    await sendReact(sock, from, msg, "📜");

    const text = roleMenu.renderTopLevelText({
      role, prefix, botName, sender, pushName, workMode,
    });

    const sentIds = [];
    let quotedRef = null;
    try {
      quotedRef = await sock.sendMessage(
        from,
        { text, mentions: [sender] },
        { quoted: msg }
      );
      if (quotedRef?.key?.id) sentIds.push(quotedRef.key.id);
    } catch (err) {
      logger(`[RoleMenu] Failed to send text menu: ${err.message}`);
    }

    try {
      const flowId = await sendInteractiveTopLevel({
        sock, from, msg, role, prefix, botName, items, quotedRef,
      });
      if (flowId) sentIds.push(flowId);
    } catch (err) {
      logger(`[RoleMenu] Interactive send skipped: ${err.message}`);
    }

    // Cache after sending so we can key the mapping by the actual outbound
    // stanzaIds — quoting the *original* top-level menu after drilling into a
    // sub-menu still resolves to the right items.
    roleMenu.rememberNumericMapping(sender, { level: "top", items, role }, sentIds);

    await sendReact(sock, from, msg, "✅");
  },

  /**
   * Send a category sub-menu. Called from the handler when a `cat:<id>`
   * selection arrives via button / list / native-flow / numeric reply.
   *
   * Returns true on success (or graceful fallback), false if the category
   * is not visible to the user's role.
   */
  async sendCategorySubmenu(sock, msg, from, sender, categoryId, context = {}) {
    const ownerRefs = context.owner ? [context.owner] : [];
    const prefix    = context.prefix  || getPrefix();
    const botName   = context.botName || getBotName();
    const role      = roleMenu.detectRole(sender, { ownerRefs });

    const items = roleMenu.buildCategoryItems(role, categoryId);
    if (!items) {
      try {
        await sock.sendMessage(from, { text: "⚠️ That category is not available for your role." }, { quoted: msg });
      } catch (_) {}
      return false;
    }

    // Prime the sender-keyed fallback BEFORE any awaited I/O so a very fast
    // numeric reply (arriving while the sub-menu is still in flight) can
    // still be resolved against the sub-menu items.
    roleMenu.primeNumericFallback(sender, { level: "category", categoryId, items, role });

    const text = roleMenu.renderCategoryText({ role, prefix, botName, categoryId });

    const sentIds = [];
    let quotedRef = null;
    try {
      quotedRef = await sock.sendMessage(from, { text, mentions: [sender] }, { quoted: msg });
      if (quotedRef?.key?.id) sentIds.push(quotedRef.key.id);
    } catch (err) {
      logger(`[RoleMenu] Failed to send category text: ${err.message}`);
    }

    try {
      const flowId = await sendInteractiveCategory({
        sock, from, msg, role, prefix, botName, categoryId, items, quotedRef,
      });
      if (flowId) sentIds.push(flowId);
    } catch (err) {
      logger(`[RoleMenu] Interactive category send skipped: ${err.message}`);
    }

    // Register cache entry under both the text and native-flow message ids.
    // Importantly, this does NOT clobber the previously-cached top-level
    // mapping under its own ids — the user can still quote the original
    // top-level menu and have its numbers route to categories.
    roleMenu.rememberNumericMapping(
      sender,
      { level: "category", categoryId, items, role },
      sentIds,
    );
    return true;
  },
};

async function sendInteractiveTopLevel({ sock, from, msg, role, prefix, botName, items, quotedRef }) {
  const baileys = require("@whiskeysockets/baileys");
  const generateWAMessageFromContent = baileys.generateWAMessageFromContent;
  if (typeof generateWAMessageFromContent !== "function") return null;
  if (typeof sock?.relayMessage !== "function") return null;

  const bodyText =
    `Pick a category to drill into.\n\n` +
    `Role: ${roleMenu.roleLabel(role)}\n` +
    `Prefix: ${prefix}\n` +
    `Tip: you can also reply with the option number (e.g. 1).`;
  const footerText = `${botName} • ${roleMenu.MENU_MARKER}`;

  const interactiveContent = roleMenu.buildTopLevelInteractive({
    role, prefix, botName, items, bodyText, footerText,
  });

  const userJid = sock?.user?.id || undefined;
  const wam = generateWAMessageFromContent(
    from,
    { viewOnceMessage: { message: interactiveContent } },
    { userJid, quoted: quotedRef || msg }
  );
  await sock.relayMessage(from, wam.message, { messageId: wam.key.id });
  return wam?.key?.id || null;
}

async function sendInteractiveCategory({ sock, from, msg, role, prefix, botName, categoryId, items, quotedRef }) {
  const baileys = require("@whiskeysockets/baileys");
  const generateWAMessageFromContent = baileys.generateWAMessageFromContent;
  if (typeof generateWAMessageFromContent !== "function") return null;
  if (typeof sock?.relayMessage !== "function") return null;

  const cat = roleMenu.getCategoryById(categoryId);
  const bodyText =
    `${cat ? cat.title : "Menu"} commands.\n\n` +
    `Role: ${roleMenu.roleLabel(role)}\n` +
    `Prefix: ${prefix}\n` +
    `Tap an option, or reply with the number to run it.`;
  const footerText = `${botName} • ${roleMenu.MENU_MARKER}`;

  const interactiveContent = roleMenu.buildCategoryInteractive({
    role, prefix, botName, categoryId, items, bodyText, footerText,
  });

  const userJid = sock?.user?.id || undefined;
  const wam = generateWAMessageFromContent(
    from,
    { viewOnceMessage: { message: interactiveContent } },
    { userJid, quoted: quotedRef || msg }
  );
  await sock.relayMessage(from, wam.message, { messageId: wam.key.id });
  return wam?.key?.id || null;
}
