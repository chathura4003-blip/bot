"use strict";

const themeMgr = require("../theme-manager");
const msgMgr = require("../message-manager");
const { sendReact } = require("../utils");

module.exports = {
  name: "steal",
  aliases: ["ss", "statussteal"],
  category: "status",
  description: "Steal (download) a status message",

  async execute(sock, msg, from, args, cmdName, context) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) {
      return msgMgr.sendTemp(sock, from, "⚠️ Please reply to a status message to steal it.", 5000);
    }

    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    await sendReact(sock, from, msg, "📥");

    try {
      const content = {};
      if (quoted.imageMessage) {
          content.image = { url: await require('../utils').downloadMediaMessage({ message: quoted }, 'image') };
          content.caption = quoted.imageMessage.caption;
      } else if (quoted.videoMessage) {
          content.video = { url: await require('../utils').downloadMediaMessage({ message: quoted }, 'video') };
          content.caption = quoted.videoMessage.caption;
      } else if (quoted.audioMessage) {
          content.audio = { url: await require('../utils').downloadMediaMessage({ message: quoted }, 'audio') };
      } else if (quoted.documentMessage) {
          content.document = { url: await require('../utils').downloadMediaMessage({ message: quoted }, 'document') };
          content.fileName = quoted.documentMessage.fileName;
          content.mimetype = quoted.documentMessage.mimetype;
      } else if (quoted.conversation) {
          content.text = quoted.conversation;
      } else if (quoted.extendedTextMessage) {
          content.text = quoted.extendedTextMessage.text;
      }

      if (Object.keys(content).length === 0) {
        return msgMgr.sendTemp(sock, from, "❌ Unsupported status type.", 4000);
      }

      const originalCaption = content.caption || "";
      let caption = themeMgr.format("header", { title: "sᴛᴀᴛᴜs sᴛᴇᴀʟᴇʀ" }, tCtx);
      caption += "\n";
      if (originalCaption) {
        caption += themeMgr.format("section", { title: "ᴏʀɪɢɪɴᴀʟ ᴄᴀᴘᴛɪᴏɴ" }, tCtx);
        caption += themeMgr.format("item", { bullet: "creative", content: originalCaption }, tCtx);
        caption += themeMgr.format("footer", {}, tCtx);
        caption += "\n";
      }
      caption += themeMgr.getSignature(sender, ownerRefs);
      
      if (content.image || content.video) {
          content.caption = caption;
      } else if (!content.text) {
          // For audio/docs, send caption as separate text or omit
          await sock.sendMessage(from, { text: caption }, { quoted: msg });
      } else {
          content.text = caption + "\n\n" + content.text;
      }
      
      await sock.sendMessage(from, content, { quoted: msg });
      await sendReact(sock, from, msg, "✅");
    } catch (err) {
      await msgMgr.sendTemp(sock, from, `❌ Failed to steal status: ${err.message}`, 5000);
    }
  },
};
