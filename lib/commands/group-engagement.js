"use strict";

const db = require("../db");
const msgMgr = require("../message-manager");
const { isOwner } = require("../utils");
const themeMgr = require("../theme-manager");

module.exports = [
  {
    name: "welcome",
    description: "Enable or disable welcome messages for the current group.",
    category: "group",
    async execute(sock, msg, from, args, cmdName, context) {
      if (!from.endsWith("@g.us")) {
        return msgMgr.sendTemp(sock, from, "⚠️ This command only works in groups.", 5000);
      }

      const sender = msg.key.participant || msg.key.remoteJid;
      const ownerRefs = context.owner ? [context.owner] : [];
      const tCtx = { sender, ownerRefs };

      const isAdmin = (await sock.groupMetadata(from)).participants.find(p => p.id === sender)?.admin;
      if (!isAdmin && !isOwner(sender, ownerRefs)) {
        return msgMgr.sendTemp(sock, from, "❌ Only group admins can use this command.", 5000);
      }

      const action = args[0]?.toLowerCase();
      if (action === "on") {
        db.update("groups", from, { welcome: true });
        await msgMgr.send(sock, from, { text: "✅ *Welcome messages enabled* for this group." });
      } else if (action === "off") {
        db.update("groups", from, { welcome: false });
        await msgMgr.send(sock, from, { text: "✅ *Welcome messages disabled* for this group." });
      } else {
        const status = db.get("groups", from)?.welcome ? "on" : "off";
        let reply = themeMgr.format("header", { title: "ᴡᴇʟᴄᴏᴍᴇ sᴇᴛᴛɪɴɢ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ɢʀᴏᴜᴘ ᴄᴏɴғɪɢ" }, tCtx);
        reply += themeMgr.format("item", { bullet: "system", content: `Status : ${status.toUpperCase()}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: "Usage: .welcome [on|off]" }, tCtx);
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);
        await msgMgr.send(sock, from, { text: reply });
      }
    },
  },
  {
    name: "goodbye",
    description: "Enable or disable goodbye messages for the current group.",
    category: "group",
    async execute(sock, msg, from, args, cmdName, context) {
      if (!from.endsWith("@g.us")) {
        return msgMgr.sendTemp(sock, from, "⚠️ This command only works in groups.", 5000);
      }

      const sender = msg.key.participant || msg.key.remoteJid;
      const ownerRefs = context.owner ? [context.owner] : [];
      const tCtx = { sender, ownerRefs };

      const isAdmin = (await sock.groupMetadata(from)).participants.find(p => p.id === sender)?.admin;
      if (!isAdmin && !isOwner(sender, ownerRefs)) {
        return msgMgr.sendTemp(sock, from, "❌ Only group admins can use this command.", 5000);
      }

      const action = args[0]?.toLowerCase();
      if (action === "on") {
        db.update("groups", from, { goodbye: true });
        await msgMgr.send(sock, from, { text: "✅ *Goodbye messages enabled* for this group." });
      } else if (action === "off") {
        db.update("groups", from, { goodbye: false });
        await msgMgr.send(sock, from, { text: "✅ *Goodbye messages disabled* for this group." });
      } else {
        const status = db.get("groups", from)?.goodbye ? "on" : "off";
        let reply = themeMgr.format("header", { title: "ɢᴏᴏᴅʙʏᴇ sᴇᴛᴛɪɴɢ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ɢʀᴏᴜᴘ ᴄᴏɴғɪɢ" }, tCtx);
        reply += themeMgr.format("item", { bullet: "system", content: `Status : ${status.toUpperCase()}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: "Usage: .goodbye [on|off]" }, tCtx);
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);
        await msgMgr.send(sock, from, { text: reply });
      }
    },
  },
];
