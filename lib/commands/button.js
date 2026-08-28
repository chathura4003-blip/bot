"use strict";

/**
 * .button — bot-wide Button Mode control (V4.2).
 *
 * Usage:
 *   .button                  → show status
 *   .button status           → show status
 *   .button on               → enable Advanced UI Engine (buttons / list /
 *                              new menu-state numeric reply)
 *   .button off              → disable Advanced UI Engine, fall back to
 *                              the legacy menu / search / download / settings
 *                              flow exactly as before V4.
 *
 * Old aliases (auto / button / list / text) are accepted for backward
 * compatibility — they normalise down to either `on` or `off` so existing
 * scripts / docs keep working.
 */

const { isOwner, sendReact } = require("../utils");
const msgMgr   = require("../message-manager");
const ui       = require("../ui");

const ON_ALIASES  = new Set(["on", "true", "1", "yes", "y", "auto", "button", "list", "enable", "enabled", "advanced"]);
const OFF_ALIASES = new Set(["off", "false", "0", "no", "n", "text", "disable", "disabled", "legacy"]);

function statusBlock(mode) {
  if (mode === "on") {
    return "🔘 *Button Mode: ON*";
  }
  return "🔘 *Button Mode: OFF*";
}

module.exports = {
  name: "button",
  aliases: ["btn", "buttonmode", "uimode"],
  description: "Toggle the Advanced UI Engine on/off (V4.2).",
  category: "system",

  async execute(sock, msg, from, args, name, context = {}) {
    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const isOwn = msg.key.fromMe || isOwner(sender, ownerRefs);

    const sub = (args[0] || "").toLowerCase().trim();
    const current = ui.getButtonMode(context); // always "on" or "off"

    // Anyone can call `.button status`. Only owner can change.
    if (!sub || sub === "status") {
      const text = [
        statusBlock(current),
        "",
        `Set with: \`${context.prefix || "."}button on\` or \`${context.prefix || "."}button off\``,
      ].join("\n");
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    // Resolve target mode (accept legacy aliases for backward compat).
    let target = null;
    if (ON_ALIASES.has(sub))  target = "on";
    if (OFF_ALIASES.has(sub)) target = "off";

    if (!target) {
      return msgMgr.sendTemp(
        sock,
        from,
        `⚠️ Unknown mode: *${sub}*. Use \`on\`, \`off\`, or \`status\`.`,
        6000,
      );
    }

    if (!isOwn) {
      return msgMgr.sendTemp(sock, from, "🔒 Only the bot owner can change Button Mode.", 4000);
    }

    const ok = ui.setButtonMode(target);
    if (!ok) {
      return msgMgr.sendTemp(sock, from, `❌ Failed to set Button Mode to *${target}*.`, 4000);
    }
    await sendReact(sock, from, msg, "✅");
    await sock.sendMessage(
      from,
      { text: `✨ Button Mode set to *${target.toUpperCase()}*\n\n${statusBlock(target)}` },
      { quoted: msg },
    );
  },
};
