"use strict";

const os = require("os");
const { sendReact, truncate, isOwner } = require("../utils");
const { getPrefix, getBotName } = require("../runtime-settings");
const msgMgr = require("../message-manager");
const themeMgr = require("../theme-manager");
const { sendBannerMessage } = require("../media-fallback");

module.exports = {
  name: "ping",
  aliases: ["alive", "system", "status", "speed", "runtime", "remind", "reminder", "pair"],
  description: "System status, high-speed latency benchmark, and tools",
  category: "system",

  async execute(sock, msg, from, args, cmdName, context) {
    const participant = msg.key.participant || msg.key.remoteJid || from;
    const prefix = context.prefix || getPrefix();
    const botName = context.botName || getBotName();
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender: participant, ownerRefs };

    switch (cmdName) {
      case "ping":
      case "speed": {
        const start = Date.now();
        await sendReact(sock, from, msg, "⚡");
        const initLatency = Date.now() - start;

        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = Math.floor(uptime % 60);
        const procMem = (process.memoryUsage().rss / 1048576).toFixed(1);

        let pingMsg = themeMgr.format("header", { title: `${botName.toUpperCase()} 𝐒𝐏𝐄𝐄𝐃 𝟐𝟎𝟐𝟔` }, tCtx);
        pingMsg += "\n";
        pingMsg += themeMgr.format("box_start", { title: "⚡ 𝐑𝐄𝐒𝐏𝐎𝐍𝐒𝐄 𝐌𝐄𝐓𝐑𝐈𝐂𝐒" }, tCtx);
        pingMsg += themeMgr.format("box_item", { bullet: "default", content: `⚡ 𝐑𝐞𝐬𝐩𝐨𝐧𝐬𝐞 𝐒𝐩𝐞𝐞𝐝 : *${Math.max(1, initLatency)}ms*` }, tCtx);
        pingMsg += themeMgr.format("box_item", { bullet: "default", content: `🚀 𝐄𝐧𝐠𝐢𝐧𝐞 𝐂𝐨𝐫𝐞   : *Node.js ${process.version}*` }, tCtx);
        pingMsg += themeMgr.format("box_item", { bullet: "default", content: `⏱️ 𝐔𝐩𝐭𝐢𝐦𝐞         : *${h}h ${m}m ${s}s*` }, tCtx);
        pingMsg += themeMgr.format("box_item", { bullet: "default", content: `💾 𝐑𝐀𝐌 𝐔𝐬𝐚𝐠𝐞      : *${procMem} MB*` }, tCtx);
        pingMsg += themeMgr.format("box_item", { bullet: "default", content: `🌐 𝐒𝐞𝐫𝐯𝐞𝐫 𝐒𝐭𝐚𝐭𝐮𝐬  : *2026 High-Speed Online*` }, tCtx);
        pingMsg += themeMgr.format("box_end", {}, tCtx);
        pingMsg += themeMgr.getSignature(participant, ownerRefs);

        await msgMgr.send(sock, from, { text: pingMsg, quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      case "alive": {
        await sendReact(sock, from, msg, "✨");
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = Math.floor(uptime % 60);

        let aliveMsg = themeMgr.format("header", { title: `${botName.toUpperCase()} 𝐈𝐒 𝐎𝐍𝐋𝐈𝐍𝐄` }, tCtx);
        aliveMsg += "\n";
        aliveMsg += themeMgr.format("section", { title: "⚡ 𝟐𝟎𝟐𝟔 𝐒𝐘𝐒𝐓𝐄𝐌 𝐒𝐓𝐀𝐓𝐔𝐒" }, tCtx);
        aliveMsg += themeMgr.format("item", { bullet: "success", content: "𝐒𝐭𝐚𝐭𝐮𝐬   : 🟢 ᴀʟɪᴠᴇ & ᴜʟᴛʀᴀ-ғᴀsᴛ" }, tCtx);
        aliveMsg += themeMgr.format("item", { bullet: "system", content: `ᴠᴇʀsɪᴏɴ  : 𝟒.𝟓.𝟎 [𝟐𝟎𝟐𝟔 𝐄𝐝𝐢𝐭𝐢𝐨𝐧]` }, tCtx);
        aliveMsg += themeMgr.format("item", { bullet: "default", content: `ᴜᴘᴛɪᴍᴇ   : ${h}h ${m}m ${s}s` }, tCtx);
        aliveMsg += themeMgr.format("item", { bullet: "user", content: `ʜᴏsᴛᴇᴅ ʙʏ: @${participant.split('@')[0]}` }, tCtx);
        aliveMsg += themeMgr.format("footer", {}, tCtx);
        aliveMsg += "\n";
        aliveMsg += "  『 ✨ ᴛʜᴀɴᴋ ʏᴏᴜ ғᴏʀ ᴜsɪɴɢ ᴄʜᴀᴛʜᴜ ᴍᴅ 𝟐𝟎𝟐𝟔 ✨ 』\n";
        aliveMsg += themeMgr.getSignature(participant, ownerRefs);

        await sendBannerMessage(sock, from, {
          caption: aliveMsg,
          text: aliveMsg,
          mentions: [participant],
          contextInfo: { isForwarded: true, forwardingScore: 999 },
          quoted: msg,
        });
        return;
      }

      case "remind":
      case "reminder": {
        if (args.length < 2) {
          return msgMgr.sendTemp(sock, from, `⚠️ Usage: ${prefix}remind <time><s/m/h> <message>\nExample: ${prefix}remind 10m buy milk`, 6000);
        }
        const timeStr = args[0].toLowerCase();
        const message = args.slice(1).join(" ");
        const match = timeStr.match(/^(\d+)([smh])$/);
        if (!match) {
          return msgMgr.sendTemp(sock, from, "❌ Invalid time format. Use 10s, 5m, or 1h.", 5000);
        }
        const value = parseInt(match[1]);
        const unit = match[2];
        let ms = value * 1000;
        if (unit === "m") ms *= 60;
        if (unit === "h") ms *= 3600;

        if (ms > 24 * 3600 * 1000) {
          return msgMgr.sendTemp(sock, from, "❌ Maximum reminder time is 24 hours.", 4000);
        }

        await sendReact(sock, from, msg, "⏰");
        await msgMgr.send(sock, from, { text: `✅ *Reminder Set Successfully*\n\n📅 Time: ${timeStr}\n📝 Note: ${truncate(message, 50)}` });

        setTimeout(async () => {
          let remMsg = themeMgr.format("header", { title: "ʀᴇᴍɪɴᴅᴇʀ" }, tCtx);
          remMsg += "\n";
          remMsg += ` 🔔 @${participant.split("@")[0]}, time's up!\n\n`;
          remMsg += ` 📝 *Message:* ${message}\n\n`;
          remMsg += themeMgr.getSignature(participant, ownerRefs);
          await sock.sendMessage(from, { text: remMsg, mentions: [participant] }, { quoted: msg });
        }, ms);
        return;
      }

      case "pair": {
        const phone = args[0] ? args[0].replace(/\D/g, "") : "";
        if (!phone || phone.length < 10) {
          return msgMgr.sendTemp(sock, from, `⚠️ Please provide a valid phone number. Example: ${prefix}pair 94742514900`, 5000);
        }

        await sendReact(sock, from, msg, "⏳");
        const sessionId = `pair_${phone}`;

        try {
          const sessionMgr = require("../../session-manager");
          await sessionMgr.createSession(sessionId, { pairMode: true, phone });

          let code = null;
          for (let i = 0; i < 60; i++) {
            const session = sessionMgr.get(sessionId);
            if (session?.pairCode) {
              code = session.pairCode;
              break;
            }
            await new Promise((r) => setTimeout(r, 500));
          }

          if (!code) throw new Error("Timed out generating pairing code.");

          let reply = themeMgr.format("header", { title: "ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
          reply += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ : ${msg.pushName || 'User'}` }, tCtx);
          reply += themeMgr.format("item", { bullet: "default", content: `ɴᴜᴍ  : ${phone}` }, tCtx);
          reply += themeMgr.format("footer", {}, tCtx);
          reply += "\n";
          
          reply += themeMgr.format("box_start", { title: "ᴀᴜᴛʜ" }, tCtx);
          reply += themeMgr.format("box_item", { bullet: "default", content: `ᴄᴏᴅᴇ : *${code.replace(/(.{4})/g, "$1 ").trim()}*` }, tCtx);
          reply += themeMgr.format("box_end", {}, tCtx);
          reply += "\n";
          
          reply += "  【 ℹ️ ʜᴏᴡ ᴛᴏ ʟɪɴᴋ 】\n";
          reply += "  1. Open WhatsApp Settings\n";
          reply += "  2. Linked Devices -> Link with Phone\n";
          reply += "  3. Enter the code above\n\n";
          reply += themeMgr.getSignature(participant, ownerRefs);

          await msgMgr.send(sock, from, { text: reply });
          await msgMgr.send(sock, from, { text: code.replace(/(.{4})/g, "$1 ").trim() });
          await sendReact(sock, from, msg, "✅");
        } catch (err) {
          await msgMgr.sendTemp(sock, from, `❌ Pairing failed: ${err.message}`, 7000);
          await sendReact(sock, from, msg, "❌");
        }
        return;
      }
    }

    // Default: system status / runtime
    await sendReact(sock, from, msg, "⚙️");
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);

    const totalMem = (os.totalmem() / 1073741824).toFixed(2);
    const usedMem = ((os.totalmem() - os.freemem()) / 1073741824).toFixed(2);
    const procMem = (process.memoryUsage().rss / 1048576).toFixed(1);

    let reply = themeMgr.format("header", { title: "sʏsᴛᴇᴍ ᴄᴏʀᴇ 𝟐𝟎𝟐𝟔" }, tCtx);
    reply += "\n";
    reply += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
    reply += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ   : @${participant.split('@')[0]}` }, tCtx);
    reply += themeMgr.format("item", { bullet: "default", content: `ᴜᴘᴛɪᴍᴇ : ${h}h ${m}m ${s}s` }, tCtx);
    reply += themeMgr.format("item", { bullet: "default", content: `ᴘʀᴇғɪx : [ ${prefix} ]` }, tCtx);
    reply += themeMgr.format("footer", {}, tCtx);
    reply += "\n";
    
    reply += themeMgr.format("box_start", { title: "ʜᴀʀᴅᴡᴀʀᴇ sᴘᴇᴄs" }, tCtx);
    reply += themeMgr.format("box_item", { bullet: "default", content: `Memory: ${usedMem}GB / ${totalMem}GB` }, tCtx);
    reply += themeMgr.format("box_item", { bullet: "default", content: `Process: ${procMem}MB` }, tCtx);
    reply += themeMgr.format("box_item", { bullet: "default", content: `Platform: ${os.type()} ${os.arch()}` }, tCtx);
    reply += themeMgr.format("box_end", {}, tCtx);
    reply += "\n";
    
    reply += themeMgr.format("box_start", { title: "sᴛᴀᴛᴜs" }, tCtx);
    reply += themeMgr.format("box_item", { bullet: "success", content: "All 2026 systems fully operational & optimized" }, tCtx);
    reply += themeMgr.format("box_end", {}, tCtx);
    
    reply += themeMgr.getSignature(participant, ownerRefs);

    await sock.sendMessage(from, { text: reply, mentions: [participant], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
    await sendReact(sock, from, msg, "✅");
  },
};
