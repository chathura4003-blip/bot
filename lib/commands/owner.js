"use strict";

const { sendReact, isOwner, truncate } = require("../utils");
const msgMgr = require("../message-manager");
const { loadCommands } = require("../handler");
const { getYtdlp } = require("../ytdlp-manager");
const db = require("../db");
const { logger } = require("../../logger");
const themeMgr = require("../theme-manager");

module.exports = {
  name: "owner",
  aliases: ["reload", "broadcast", "ban", "unban", "block", "unblock", "listban", "listblock", "update", "setowner", "addowner", "delowner", "listowner"],
  description: "Owner-only command management",
  category: "owner",

  async execute(sock, msg, from, args, cmdName, context) {
    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };
    const hasOwnerIdentity = (list, jid) => {
      const targetKey = db.getManagedIdentityKey(jid);
      return (list || []).some((entry) => db.getManagedIdentityKey(entry) === targetKey);
    };
    const removeOwnerIdentity = (list, jid) => {
      const targetKey = db.getManagedIdentityKey(jid);
      return (list || []).filter((entry) => db.getManagedIdentityKey(entry) !== targetKey);
    };
    
    // 1. Verification Logic (setowner)
    if (cmdName === "setowner") {
      const code = args[0];
      const { PREMIUM_CODE } = require("../../config");
      if (code === PREMIUM_CODE) {
        const verified = db.getSetting("verified_owners") || [];
        if (!hasOwnerIdentity(verified, sender)) {
          verified.push(sender);
          db.setSetting("verified_owners", verified);
        }
        await sendReact(sock, from, msg, "👑");
        return msgMgr.send(sock, from, { text: `✅ Verification successful! @${sender.split('@')[0]} is now recognized as a Bot Owner.`, mentions: [sender] });
      } else {
        await sendReact(sock, from, msg, "❌");
        return msgMgr.sendTemp(sock, from, "❌ Invalid verification code.", 4000);
      }
    }

    // 2. Authorization Check for remaining commands
    if (!isOwner(sender, ownerRefs)) {
      return msgMgr.sendTemp(sock, from, "❌ This command is restricted to established bot owners.", 4000);
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const target = mentioned[0] || (args[0] ? `${args[0].replace(/\D/g, "")}@s.whatsapp.net` : null);

    switch (cmdName) {
      case "owner": {
        let reply = themeMgr.format("header", { title: "ᴏᴡɴᴇʀ ᴄᴏɴᴛʀᴏʟ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ᴀᴅᴍɪɴ ᴘᴀɴᴇʟ" }, tCtx);
        reply += themeMgr.format("item", { bullet: "system", content: ".reload / .update" }, tCtx);
        reply += themeMgr.format("item", { bullet: "system", content: ".addowner / .delowner @user" }, tCtx);
        reply += themeMgr.format("item", { bullet: "system", content: ".broadcast <text>" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ᴍᴏᴅᴇʀᴀᴛɪᴏɴ" }, tCtx);
        reply += themeMgr.format("item", { bullet: "warn", content: ".ban / .unban @user" }, tCtx);
        reply += themeMgr.format("item", { bullet: "error", content: ".block / .unblock @user" }, tCtx);
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);
        
        await msgMgr.send(sock, from, { text: reply, mentions: [sender] });
        await sendReact(sock, from, msg, "👑");
        break;
      }

      case "addowner": {
        if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Please mention the user to promote.", 5000);
        const verified = db.getSetting("verified_owners") || [];
        if (!hasOwnerIdentity(verified, target)) {
          verified.push(target);
          db.setSetting("verified_owners", verified);
        }
        await msgMgr.send(sock, from, { text: `✅ @${target.split('@')[0]} has been added to the Owner matrix.`, mentions: [target] });
        await sendReact(sock, from, msg, "👑");
        break;
      }

      case "delowner": {
        if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Please mention the user to demote.", 5000);
        const verified = db.getSetting("verified_owners") || [];
        const nextVerified = removeOwnerIdentity(verified, target);
        if (nextVerified.length !== verified.length) {
          db.setSetting("verified_owners", nextVerified);
          await msgMgr.send(sock, from, { text: `✅ @${target.split('@')[0]} has been removed from the Owner matrix.`, mentions: [target] });
          await sendReact(sock, from, msg, "✅");
        } else {
          await msgMgr.sendTemp(sock, from, "❌ User is not an owner.", 4000);
        }
        break;
      }

      case "listowner": {
        const verified = db.getSetting("verified_owners") || [];
        if (!verified.length) return msgMgr.send(sock, from, { text: "ℹ️ No dynamically added owners found." });
        
        let reply = themeMgr.format("header", { title: "ᴏᴡɴᴇʀ ʟɪsᴛ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ᴠᴇʀɪғɪᴇᴅ" }, tCtx);
        verified.forEach((jid, i) => {
          reply += themeMgr.format("item", { bullet: "owner", content: `${i + 1}. @${jid.split("@")[0]}` }, tCtx);
        });
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);
        
        await sock.sendMessage(from, { text: reply, mentions: [sender, ...verified] });
        break;
      }

      case "reload": {
        try {
          loadCommands();
          await msgMgr.send(sock, from, { text: "♻️ Matrix command modules reloaded." });
          await sendReact(sock, from, msg, "✅");
        } catch (err) {
          await msgMgr.sendTemp(sock, from, `❌ Reload failed: ${err.message.slice(0, 80)}`, 7000);
        }
        break;
      }

      case "broadcast": {
        const text = args.join(" ").trim();
        if (!text) return msgMgr.sendTemp(sock, from, "⚠️ Provide a message to broadcast.", 5000);
        try {
          const groups = await sock.groupFetchAllParticipating();
          const jids = Object.keys(groups || {});
          for (const jid of jids) {
            let reply = themeMgr.format("header", { title: "ʙʀᴏᴀᴅᴄᴀsᴛ" }, tCtx);
            reply += "\n";
            reply += themeMgr.format("section", { title: "ᴀɴɴᴏᴜɴᴄᴇᴍᴇɴᴛ" }, tCtx);
            reply += themeMgr.format("item", { bullet: "creative", content: truncate(text, 1000) }, tCtx);
            reply += themeMgr.format("footer", {}, tCtx);
            reply += themeMgr.getSignature(sender, ownerRefs);
            
            await sock.sendMessage(jid, { text: reply, mentions: [sender], contextInfo: { isForwarded: true, forwardingScore: 999 } });
            await new Promise((r) => setTimeout(r, 1500));
          }
          await msgMgr.send(sock, from, { text: `✅ Broadcast sent to ${jids.length} groups.` });
          await sendReact(sock, from, msg, "✅");
        } catch (err) {
          await msgMgr.sendTemp(sock, from, `❌ Broadcast failed: ${err.message.slice(0, 60)}`, 7000);
        }
        break;
      }

      case "ban": {
        if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Mention a user to ban.", 5000);
        db.update("bans", target, { banned: true, at: Date.now() });
        let reply = themeMgr.format("header", { title: "ᴜsᴇʀ ʙᴀɴɴᴇᴅ" }, tCtx);
        reply += `\n⛔ @${target.split('@')[0]} has been restricted.\n`;
        reply += themeMgr.getSignature(sender, ownerRefs);
        await sock.sendMessage(from, { text: reply, mentions: [sender, target] });
        await sendReact(sock, from, msg, "✅");
        break;
      }

      case "unban": {
        if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Mention a user to unban.", 5000);
        db.delete("bans", target);
        let reply = themeMgr.format("header", { title: "ᴜsᴇʀ ᴜɴʙᴀɴɴᴇᴅ" }, tCtx);
        reply += `\n✅ @${target.split('@')[0]} access restored.\n`;
        reply += themeMgr.getSignature(sender, ownerRefs);
        await sock.sendMessage(from, { text: reply, mentions: [sender, target] });
        await sendReact(sock, from, msg, "✅");
        break;
      }

      case "listban": {
        const bans = db.getAll("bans") || {};
        const banned = Object.keys(bans).filter((k) => bans[k]?.banned);
        if (!banned.length) return msgMgr.send(sock, from, { text: "✅ No banned users found." });

        let reply = themeMgr.format("header", { title: "ʙᴀɴɴᴇᴅ ʟɪsᴛ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ᴇɴᴛɪᴛɪᴇs" }, tCtx);
        banned.forEach((jid, i) => {
          reply += themeMgr.format("item", { bullet: "error", content: `${i + 1}. @${jid.split("@")[0]}` }, tCtx);
        });
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);

        await sock.sendMessage(from, { text: reply, mentions: [sender, ...banned] });
        break;
      }

      case "update": {
        try {
          await msgMgr.sendTemp(sock, from, "⏳ Updating system components. Please wait...", 5000);
          const out = await getYtdlp().execPromise(["-U"]);
          await msgMgr.send(sock, from, { text: `✅ *Update Complete*\n\n\`\`\`${out}\`\`\`` });
          await sendReact(sock, from, msg, "✅");
        } catch (err) {
          await msgMgr.sendTemp(sock, from, `❌ Update failed: ${err.message}`, 6000);
        }
        break;
      }
      
      case "block": {
        if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Mention a user to block.", 5000);
        try {
          await sock.updateBlockStatus(target, "block");
          await msgMgr.send(sock, from, { text: `🚫 @${target.split('@')[0]} has been blocked.`, mentions: [target] });
          await sendReact(sock, from, msg, "✅");
        } catch (err) {
          await msgMgr.sendTemp(sock, from, `❌ Block failed: ${err.message}`, 5000);
        }
        break;
      }
      
      case "unblock": {
        if (!target) return msgMgr.sendTemp(sock, from, "⚠️ Mention a user to unblock.", 5000);
        try {
          await sock.updateBlockStatus(target, "unblock");
          await msgMgr.send(sock, from, { text: `✅ @${target.split('@')[0]} has been unblocked.`, mentions: [target] });
          await sendReact(sock, from, msg, "✅");
        } catch (err) {
          await msgMgr.sendTemp(sock, from, `❌ Unblock failed: ${err.message}`, 5000);
        }
        break;
      }

      case "listblock": {
        try {
          const blocked = (await sock.fetchBlocklist()) || [];
          if (!blocked.length) {
            return msgMgr.send(sock, from, { text: "✅ No users are currently blocked." });
          }
          let reply = themeMgr.format("header", { title: "ʙʟᴏᴄᴋᴇᴅ ʟɪsᴛ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: `ᴄᴏᴜɴᴛ : ${blocked.length}` }, tCtx);
          blocked.forEach((jid, i) => {
            reply += themeMgr.format("item", { bullet: "error", content: `${i + 1}. @${jid.split("@")[0]}` }, tCtx);
          });
          reply += themeMgr.format("footer", {}, tCtx);
          reply += themeMgr.getSignature(sender, ownerRefs);

          await sock.sendMessage(from, { text: reply, mentions: blocked });
          await sendReact(sock, from, msg, "✅");
        } catch (err) {
          await msgMgr.sendTemp(sock, from, `❌ Could not fetch block list: ${err.message}`, 5000);
        }
        break;
      }

      default:
        await msgMgr.sendTemp(sock, from, "❓ Unknown administrative command.", 4000);
    }
  },
};
