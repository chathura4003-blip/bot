"use strict";

const axios = require("axios");
const { sendReact } = require("../utils");
const msgMgr = require("../message-manager");
const db = require("../db");
const { handleAPIError } = require("../error-handler");
const { isGroupAdmin, isOwner } = require("../utils");
const { getNsfwEnabled } = require("../runtime-settings");
const themeMgr = require("../theme-manager");

const NSFW_SOURCES = [
  { tag: "boobs", url: "https://api.waifu.pics/nsfw/waifu" },
  { tag: "ass", url: "https://api.waifu.pics/nsfw/waifu" },
  { tag: "waifu", url: "https://api.waifu.pics/nsfw/waifu" },
  { tag: "blowjob", url: "https://api.waifu.pics/nsfw/blowjob" },
];

function isNsfwEnabled(from) {
  const g = db.get("groups", from) || {};
  return !!g.nsfw;
}

module.exports = {
  name: "nsfw",
  aliases: ["nsfwtoggle", "boobs", "ass", "waifu", "blowjob"],
  category: "nsfw",
  description: "NSFW content (groups only, must be enabled by admin)",

  async execute(sock, msg, from, args, cmdName, context) {
    const isGroup = from.endsWith("@g.us");
    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    if (!isGroup) {
      const nsfwEnabled = context.nsfwEnabled !== undefined ? context.nsfwEnabled : getNsfwEnabled();
      if (!nsfwEnabled && !isOwner(sender, ownerRefs)) {
        return msgMgr.sendTemp(sock, from, "🔞 Private NSFW is disabled in config.", 5000);
      }
    }

    if (cmdName === "nsfwtoggle" || cmdName === "nsfw") {
      if (!isGroup)
        return msgMgr.sendTemp(sock, from, "⚠️ Admins toggle is for groups only.", 4000);
      const adminOk = await isGroupAdmin(sock, from, sender);
      if (!adminOk && !isOwner(sender, ownerRefs)) {
        return msgMgr.sendTemp(sock, from, "❌ Admins only can toggle NSFW.", 4000);
      }
      const val = args[0]?.toLowerCase();
      if (val !== "on" && val !== "off") {
        return msgMgr.sendTemp(sock, from, "⚠️ Usage: .nsfw on / .nsfw off", 5000);
      }
      db.update("groups", from, { nsfw: val === "on" });
      
      let reply = themeMgr.format("header", { title: "ᴘʀɪᴠᴀᴄʏ ᴜᴘᴅᴀᴛᴇ" }, tCtx);
      reply += "\n";
      reply += themeMgr.format("section", { title: "ɴsғᴡ ᴍᴏᴅᴇ" }, tCtx);
      reply += themeMgr.format("item", { bullet: "system", content: `Status : ${val.toUpperCase()}` }, tCtx);
      reply += themeMgr.format("footer", {}, tCtx);
      reply += themeMgr.getSignature(sender, ownerRefs);
      
      await sock.sendMessage(from, { text: reply, mentions: [sender], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
      await sendReact(sock, from, msg, "✅");
      return;
    }

    if (isGroup && !isNsfwEnabled(from)) {
      return msgMgr.sendTemp(
        sock,
        from,
        "🔞 NSFW is not enabled in this group.\nAsk an admin: `.nsfw on`",
        6000,
      );
    }

    const source = NSFW_SOURCES.find((s) => s.tag === cmdName) || NSFW_SOURCES[0];
    await sendReact(sock, from, msg, "🔞");

    try {
      const { data } = await axios.get(source.url, { timeout: 10000 });
      const url = data?.url;
      if (!url) throw new Error("No image URL returned");

      let caption = themeMgr.format("header", { title: cmdName.toUpperCase() }, tCtx);
      caption += "\n";
      caption += themeMgr.format("section", { title: "ᴄᴏɴᴛᴇɴᴛ" }, tCtx);
      caption += themeMgr.format("item", { bullet: "default", content: "Adult Registry • 18+" }, tCtx);
      caption += themeMgr.format("footer", {}, tCtx);
      caption += themeMgr.getSignature(sender, ownerRefs);
      
      await sock.sendMessage(from, {
        image: { url },
        caption: caption,
        mentions: [sender],
        contextInfo: { isForwarded: true, forwardingScore: 999 }
      }, { quoted: msg });
      await sendReact(sock, from, msg, "✅");
    } catch (err) {
      const fe = handleAPIError(err, "NSFW");
      await msgMgr.sendTemp(sock, from, `❌ ${fe.message}`, 5000);
      await sendReact(sock, from, msg, "❌");
    }
  },
};
