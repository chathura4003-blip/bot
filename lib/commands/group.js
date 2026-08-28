"use strict";

const { sendReact, isGroupAdmin, isOwner } = require("../utils");
const msgMgr = require("../message-manager");
const db = require("../db");
const themeMgr = require("../theme-manager");

module.exports = {
  name: "kick",
  aliases: ["add", "promote", "demote", "lock", "unlock", "antilink"],
  category: "group",
  description: "Advanced Group Management Suite",

  async execute(sock, msg, from, args, cmdName, context) {
    if (!from.endsWith("@g.us")) {
      return msgMgr.sendTemp(sock, from, "⚠️ This command is only functional within groups.", 5000);
    }

    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    const adminOk = await isGroupAdmin(sock, from, sender);
    if (!adminOk && !isOwner(sender, ownerRefs)) {
      return msgMgr.sendTemp(sock, from, "❌ Administrative privileges required.", 4000);
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const target = mentioned[0];

    try {
      switch (cmdName) {
        case "kick": {
          if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Please mention a user to kick.", 5000);
          const botId = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";
          if (target === botId) return msgMgr.sendTemp(sock, from, "❌ Operation denied: Cannot kick self.", 4000);
          
          await sock.groupParticipantsUpdate(from, [target], "remove");
          let reply = themeMgr.format("header", { title: "ɢʀᴏᴜᴘ ᴍᴏᴅᴇʀᴀᴛɪᴏɴ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: "ᴀᴄᴛɪᴏɴ ʀᴇᴘᴏʀᴛ" }, tCtx);
          reply += themeMgr.format("item", { bullet: "error", content: "Target Removed" }, tCtx);
          reply += themeMgr.format("item", { bullet: "user", content: `@${target.split('@')[0]}` }, tCtx);
          reply += themeMgr.format("footer", {}, tCtx);
          reply += themeMgr.getSignature(sender, ownerRefs);
          
          await sock.sendMessage(from, { text: reply, mentions: [target] }, { quoted: msg });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        case "add": {
          const num = args[0]?.replace(/\D/g, "");
          if (!num) return msgMgr.sendTemp(sock, from, "⚠️ Provide a valid phone number.", 5000);
          try {
            const jid = `${num}@s.whatsapp.net`;
            await sock.groupParticipantsUpdate(from, [jid], "add");
            let reply = themeMgr.format("header", { title: "ɢʀᴏᴜᴘ ᴍᴏᴅᴇʀᴀᴛɪᴏɴ" }, tCtx);
            reply += "\n";
            reply += themeMgr.format("section", { title: "ᴀᴄᴛɪᴏɴ ʀᴇᴘᴏʀᴛ" }, tCtx);
            reply += themeMgr.format("item", { bullet: "success", content: "Target Added" }, tCtx);
            reply += themeMgr.format("item", { bullet: "user", content: `@${num}` }, tCtx);
            reply += themeMgr.format("footer", {}, tCtx);
            reply += themeMgr.getSignature(sender, ownerRefs);
            
            await sock.sendMessage(from, { text: reply, mentions: [jid] }, { quoted: msg });
            await sendReact(sock, from, msg, "✅");
          } catch (e) {
            return msgMgr.send(sock, from, { text: "❌ Failed to add user. Ensure privacy settings permit external additions." });
          }
          break;
        }

        case "promote":
        case "demote": {
          if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Please mention a user.", 5000);
          const type = cmdName === "promote" ? "promote" : "demote";
          await sock.groupParticipantsUpdate(from, [target], type);
          
          let reply = themeMgr.format("header", { title: "ᴘʀɪᴠɪʟᴇɢᴇ ᴜᴘᴅᴀᴛᴇ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: "ɢʀᴏᴜᴘ ᴇᴠᴇɴᴛ" }, tCtx);
          reply += themeMgr.format("item", { bullet: "system", content: `Status: ${type.toUpperCase()}` }, tCtx);
          reply += themeMgr.format("item", { bullet: "user", content: `@${target.split('@')[0]}` }, tCtx);
          reply += themeMgr.format("footer", {}, tCtx);
          reply += themeMgr.getSignature(sender, ownerRefs);
          
          await sock.sendMessage(from, { text: reply, mentions: [target] }, { quoted: msg });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        case "lock":
        case "unlock": {
          const type = cmdName === "lock" ? "announcement" : "not_announcement";
          await sock.groupSettingUpdate(from, type);
          
          let reply = themeMgr.format("header", { title: "sᴇᴄᴜʀɪᴛʏ ᴜᴘᴅᴀᴛᴇ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: "ɢʀᴏᴜᴘ sᴛᴀᴛᴜs" }, tCtx);
          reply += themeMgr.format("item", { bullet: "system", content: `Mode: ${cmdName.toUpperCase()}` }, tCtx);
          reply += themeMgr.format("item", { bullet: "default", content: cmdName === "lock" ? "Only admins can message." : "Everyone can message." }, tCtx);
          reply += themeMgr.format("footer", {}, tCtx);
          reply += themeMgr.getSignature(sender, ownerRefs);
          
          await sock.sendMessage(from, { text: reply }, { quoted: msg });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        case "antilink": {
          const val = args[0]?.toLowerCase();
          if (val !== "on" && val !== "off") return msgMgr.sendTemp(sock, from, "⚠️ Usage: .antilink on/off", 5000);
          
          db.update("groups", from, { antilink: val === "on" });
          let reply = themeMgr.format("header", { title: "ᴍᴀᴛʀɪx sʜɪᴇʟᴅ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: "ᴀɴᴛɪ-ʟɪɴᴋ" }, tCtx);
          reply += themeMgr.format("item", { bullet: "system", content: `Shield Status: ${val.toUpperCase()}` }, tCtx);
          reply += themeMgr.format("footer", {}, tCtx);
          reply += themeMgr.getSignature(sender, ownerRefs);
          
          await sock.sendMessage(from, { text: reply }, { quoted: msg });
          await sendReact(sock, from, msg, "🛡️");
          break;
        }

        default:
          await msgMgr.sendTemp(sock, from, "❓ Unrecognized administrative command.", 5000);
      }
    } catch (err) {
      await msgMgr.sendTemp(sock, from, `❌ Execution Error: ${err.message?.slice(0, 60)}`, 5000);
      await sendReact(sock, from, msg, "❌");
    }
  },
};
