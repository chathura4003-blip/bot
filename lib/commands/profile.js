"use strict";

const { sendReact, isOwner } = require("../utils");
const msgMgr = require("../message-manager");
const db = require("../db");
const { getBotName, getPrefix } = require("../runtime-settings");
const themeMgr = require("../theme-manager");

module.exports = {
  name: "profile",
  aliases: ["pp", "bio", "setbio", "setname", "myinfo", "vcard"],
  description: "Profile tools — view profile pic, bio, and bot info",
  category: "profile",

  async execute(sock, msg, from, args, cmdName, context) {
    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const target = mentioned[0] || sender;

    await sendReact(sock, from, msg, "👤");

    try {
      switch (cmdName) {

        case "profile":
        case "myinfo": {
          let ppUrl;
          try {
            ppUrl = await sock.profilePictureUrl(target, "image");
          } catch {
            ppUrl = null;
          }

          const user = db.get("users", target) || {};
          const uptime = process.uptime();
          const h = Math.floor(uptime / 3600);
          const m = Math.floor((uptime % 3600) / 60);

          let info = themeMgr.format("header", { title: "ᴘʀᴏғɪʟᴇ ᴄᴀʀᴅ" }, tCtx);
          info += "\n";
          info += themeMgr.format("section", { title: "ᴜsᴇʀ ᴅᴇᴛᴀɪʟs" }, tCtx);
          info += themeMgr.format("item", { bullet: "user", content: `Name   : ${user.pushName || "Unknown"}` }, tCtx);
          info += themeMgr.format("item", { bullet: "default", content: `Number : ${target.split("@")[0]}` }, tCtx);
          info += themeMgr.format("item", { bullet: "default", content: `Bio    : ${user.bio || "No bio set"}` }, tCtx);
          info += themeMgr.format("item", { bullet: "default", content: `Coins  : ${user.premium ? "Unlimited" : (user.coins ?? user.balance ?? 1000)}` }, tCtx);
          info += themeMgr.format("item", { bullet: "default", content: `XP     : ${user.xp || 0}` }, tCtx);
          info += themeMgr.format("item", { bullet: "default", content: `Items  : ${user.items?.length ? user.items.join(", ") : "None"}` }, tCtx);
          info += themeMgr.format("item", { bullet: "default", content: `Badge  : ${themeMgr.getBadge(target, ownerRefs)}` }, tCtx);
          info += "\n";
          info += themeMgr.format("section", { title: "ʙᴏᴛ ɪɴғᴏ" }, tCtx);
          info += themeMgr.format("item", { bullet: "system", content: `Bot    : ${context.botName || getBotName()}` }, tCtx);
          info += themeMgr.format("item", { bullet: "system", content: `Uptime : ${h}h ${m}m` }, tCtx);
          info += themeMgr.format("item", { bullet: "system", content: `Prefix : ${context.prefix || getPrefix()}` }, tCtx);
          info += themeMgr.format("footer", {}, tCtx);
          info += themeMgr.getSignature(sender, ownerRefs);

          const content = ppUrl
            ? { image: { url: ppUrl }, caption: info, mentions: [target] }
            : { text: info, mentions: [target] };

          await sock.sendMessage(from, content, { quoted: msg });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        case "pp": {
          let ppTarget = target;
          let ppUrl;
          try {
            ppUrl = await sock.profilePictureUrl(ppTarget, "image");
          } catch {
            return msgMgr.sendTemp(sock, from, "❌ Could not fetch profile picture. User may have privacy settings on.", 5000);
          }
          
          let caption = themeMgr.format("header", { title: "ᴘʀᴏғɪʟᴇ ᴘɪᴄ" }, tCtx);
          caption += "\n";
          caption += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
          caption += themeMgr.format("item", { bullet: "user", content: `User : @${ppTarget.split("@")[0]}` }, tCtx);
          caption += themeMgr.format("footer", {}, tCtx);
          caption += themeMgr.getSignature(sender, ownerRefs);
          
          await sock.sendMessage(from, { image: { url: ppUrl }, caption, mentions: [ppTarget] }, { quoted: msg });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        case "bio":
        case "setbio": {
          const text = args.join(" ").trim();
          if (!text) {
            const currentBio = db.get("users", sender)?.bio || "No bio set";
            return msgMgr.send(sock, from, {
              text: `📝 *Your Bio:* ${currentBio}\n\nTo update: *.bio <your new bio>*`,
            });
          }
          if (text.length > 100)
            return msgMgr.sendTemp(sock, from, "❌ Bio must be under 100 characters.", 5000);
          db.update("users", sender, { bio: text });
          await msgMgr.send(sock, from, { text: `✅ Bio updated to: _${text}_` });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        case "setname": {
          if (!isOwner(sender, ownerRefs))
            return msgMgr.sendTemp(sock, from, "❌ Owner only.", 4000);
          const name = args.join(" ").trim();
          if (!name)
            return msgMgr.sendTemp(sock, from, "⚠️ Usage: .setname <new name>", 5000);
          await sock.updateProfileName(name);
          await msgMgr.send(sock, from, { text: `✅ Bot name updated to: *${name}*` });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        case "vcard": {
          if (!target || target === sender)
            return msgMgr.sendTemp(sock, from, "⚠️ Mention a user to generate vCard.", 5000);
          const num = target.split("@")[0];
          const ud = db.get("users", target) || {};
          await sock.sendMessage(from, {
            contacts: {
              displayName: ud.pushName || `+${num}`,
              contacts: [{
                vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${ud.pushName || "Contact"}\nTEL;type=CELL;type=VOICE;waid=${num}:+${num}\nEND:VCARD`,
              }],
            },
          }, { quoted: msg });
          await sendReact(sock, from, msg, "✅");
          break;
        }

        default:
          await msgMgr.sendTemp(sock, from, "❓ Unknown profile command.", 4000);
      }
    } catch (err) {
      await msgMgr.sendTemp(sock, from, `❌ Error: ${err.message?.slice(0, 60)}`, 5000);
      await sendReact(sock, from, msg, "❌");
    }
  },
};
