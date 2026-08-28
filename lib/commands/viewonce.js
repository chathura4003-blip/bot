"use strict";

const msgMgr = require("../message-manager");
const themeMgr = require("../theme-manager");
const { isOwner, sendReact } = require("../utils");
const {
  isAntiViewOnceEnabled,
  setAntiViewOnceEnabled,
  isAntiViewOnceForwardEnabled,
  setAntiViewOnceForward,
  getAntiDeleteConfig,
} = require("../viewonce-capture");

module.exports = {
  name: "antivo",
  aliases: ["antiviewonce", "viewonce"],
  category: "automation",
  description: "Toggle View Once auto-download (saves to folder). Use 'forward' to also send to inbox.",

  async execute(sock, msg, from, args, cmdName, context) {
    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    if (!msg.key.fromMe && !isOwner(sender, ownerRefs)) {
      return msgMgr.sendTemp(sock, from, "❌ Only bot owner can use this command.", 5000);
    }

    const sessionId = context.sessionId || "__main__";
    const action = args[0]?.toLowerCase();
    const subAction = args[1]?.toLowerCase();

    if (action === "on" || action === "off") {
      const enabled = action === "on";
      const result = await setAntiViewOnceEnabled(sessionId, enabled);
      if (result?.error) {
        return msgMgr.sendTemp(sock, from, `❌ ${result.error}`, 5000);
      }

      if (enabled && (subAction === "forward" || subAction === "send")) {
        await setAntiViewOnceForward(sessionId, true);
      }

      try {
        const dashboard = require("../../dashboard");
        if (dashboard.io) {
          const payload = sessionId === "__main__"
            ? dashboard.getMainSessionPayload()
            : result.session;
          if (payload) dashboard.io.emit("session:update", payload);
        }
      } catch { }

      await sendReact(sock, from, msg, enabled ? "📥" : "🛑");

      const forwardOn = isAntiViewOnceForwardEnabled(sessionId);
      const modeText = enabled
        ? `✅ Saved to *viewonce/* folder\n${forwardOn ? "📤 Also forwarding to your inbox" : "🚫 No auto-forward (save only)"}`
        : "View Once capture is now disabled.";

      return msgMgr.send(sock, from, {
        text: `✅ *Anti View Once ${enabled ? "enabled" : "disabled"}*.\n\n${modeText}`,
      });
    }

    if (action === "forward") {
      if (subAction === "on" || subAction === "off") {
        const fwdEnabled = subAction === "on";
        const result = await setAntiViewOnceForward(sessionId, fwdEnabled);
        if (result?.error) {
          return msgMgr.sendTemp(sock, from, `❌ ${result.error}`, 5000);
        }
        await sendReact(sock, from, msg, fwdEnabled ? "📤" : "🔇");
        return msgMgr.send(sock, from, {
          text: `✅ Forwarding ${fwdEnabled ? "ENABLED" : "DISABLED"}.\n\n${fwdEnabled ? "Captured media will be sent to your inbox." : "Only saved to viewonce/ folder (no inbox spam)."}`
        });
      }
    }

    const status = isAntiViewOnceEnabled(sessionId) ? "ON" : "OFF";
    const forwardStatus = isAntiViewOnceForwardEnabled(sessionId) ? "ON (sends to inbox)" : "OFF (save only)";
    const cfg = getAntiDeleteConfig(sessionId);
    const target = String(cfg.target || 'chat').toUpperCase();

    let reply = themeMgr.format("header", { title: "ᴀɴᴛɪ ᴠɪᴇᴡ-ᴏɴᴄᴇ" }, tCtx);
    reply += "\n";
    reply += themeMgr.format("section", { title: "sʏsᴛᴇᴍ ᴄᴏɴғɪɢ" }, tCtx);
    reply += themeMgr.format("item", { bullet: "system", content: `Status   : ${status}` }, tCtx);
    reply += themeMgr.format("item", { bullet: "system", content: `Forward  : ${forwardStatus}` }, tCtx);
    reply += themeMgr.format("item", { bullet: "system", content: `Target   : ${target}` }, tCtx);
    reply += themeMgr.format("item", { bullet: "default", content: "Usage    : .antivo on | .antivo off" }, tCtx);
    reply += themeMgr.format("item", { bullet: "default", content: "Forward  : .antivo on forward   OR   .antivo forward on|off" }, tCtx);
    reply += themeMgr.format("item", { bullet: "default", content: "Save     : viewonce/ folder (when enabled)" }, tCtx);
    reply += themeMgr.format("footer", {}, tCtx);
    reply += themeMgr.getSignature(sender, ownerRefs);

    return msgMgr.send(sock, from, { text: reply });
  },
};