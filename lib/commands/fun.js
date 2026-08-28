"use strict";

const axios = require("axios");
const { sendReact, presenceUpdate } = require("../utils");
const msgMgr = require("../message-manager");
const { handleAPIError } = require("../error-handler");
const themeMgr = require("../theme-manager");

const JOKE_API = "https://v2.jokeapi.dev/joke/Any?safe-mode";
const FACT_API = "https://uselessfacts.jsph.pl/random.json?language=en";
const MEME_API = "https://meme-api.com/gimme";
const INSPIRE_API = "https://zenquotes.io/api/random";

module.exports = {
  name: "joke",
  aliases: ["meme", "fact", "inspire", "quote", "roll", "flip"],
  category: "fun",
  description: "Fun commands",

  async execute(sock, msg, from, args, cmdName, context) {
    sendReact(sock, from, msg, "🎲");
    presenceUpdate(sock, from, "composing");

    const participant = msg.key.participant || msg.key.remoteJid || from;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender: participant, ownerRefs };

    try {
      switch (cmdName) {
        case "joke": {
          const { data } = await axios.get(JOKE_API, { timeout: 8000 });
          let text = themeMgr.format("header", { title: "ᴊᴏᴋᴇ" }, tCtx);
          text += "\n";
          text += themeMgr.format("section", { title: "ғᴜɴ ᴊᴏᴋᴇ" }, tCtx);
          
          if (data.type === "twopart") {
            text += themeMgr.format("item", { bullet: "creative", content: `Q. ${data.setup}` }, tCtx);
            text += themeMgr.format("item", { bullet: "default", content: `${data.delivery}` }, tCtx);
          } else {
            text += themeMgr.format("item", { bullet: "creative", content: data.joke }, tCtx);
          }
          text += themeMgr.format("footer", {}, tCtx);
          text += themeMgr.getSignature(participant, ownerRefs);
          
          await sock.sendMessage(from, { text, mentions: [participant], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
          break;
        }

        case "meme": {
          const { data } = await axios.get(MEME_API, { timeout: 10000 });
          if (!data?.url) throw new Error("No meme URL");
          
          let caption = themeMgr.format("header", { title: "ᴍᴇᴍᴇ" }, tCtx);
          caption += "\n";
          caption += themeMgr.format("section", { title: "ᴍᴇᴍᴇ ᴢᴏɴᴇ" }, tCtx);
          caption += themeMgr.format("item", { bullet: "creative", content: data.title || "Random Meme" }, tCtx);
          caption += themeMgr.format("item", { bullet: "default", content: `ᴜᴘᴠᴏᴛᴇs : ${data.ups || 0}` }, tCtx);
          caption += themeMgr.format("footer", {}, tCtx);
          caption += themeMgr.getSignature(participant, ownerRefs);
          
          await sock.sendMessage(from, {
            image: { url: data.url },
            caption,
            mentions: [participant],
            contextInfo: { isForwarded: true, forwardingScore: 999 }
          }, { quoted: msg });
          break;
        }

        case "fact": {
          const { data } = await axios.get(FACT_API, { timeout: 8000 });
          let text = themeMgr.format("header", { title: "ғᴀᴄᴛ" }, tCtx);
          text += "\n";
          text += themeMgr.format("section", { title: "ᴅɪᴅ ʏᴏᴜ ᴋɴᴏᴡ?" }, tCtx);
          text += themeMgr.format("item", { bullet: "creative", content: data.text }, tCtx);
          text += themeMgr.format("footer", {}, tCtx);
          text += themeMgr.getSignature(participant, ownerRefs);
          
          await sock.sendMessage(from, { text, mentions: [participant], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
          break;
        }

        case "inspire":
        case "quote": {
          const { data } = await axios.get(INSPIRE_API, { timeout: 8000 });
          const q = Array.isArray(data) ? data[0] : data;
          
          let text = themeMgr.format("header", { title: "ǫᴜᴏᴛᴇ" }, tCtx);
          text += "\n";
          text += themeMgr.format("section", { title: "ɪɴsᴘɪʀᴀᴛɪᴏɴ" }, tCtx);
          text += themeMgr.format("item", { bullet: "creative", content: `"${q.q}"` }, tCtx);
          text += themeMgr.format("item", { bullet: "user", content: `— ${q.a}` }, tCtx);
          text += themeMgr.format("footer", {}, tCtx);
          text += themeMgr.getSignature(participant, ownerRefs);
          
          await sock.sendMessage(from, { text, mentions: [participant], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
          break;
        }

        case "roll": {
          const max = parseInt(args[0]) || 6;
          const roll = Math.floor(Math.random() * max) + 1;
          
          let text = themeMgr.format("header", { title: "ʀᴏʟʟ" }, tCtx);
          text += "\n";
          text += themeMgr.format("section", { title: "ʀɴɢ ʀᴇsᴜʟᴛ" }, tCtx);
          text += themeMgr.format("item", { bullet: "default", content: `🎲 Dice rolled: ${roll}` }, tCtx);
          text += themeMgr.format("item", { bullet: "system", content: `ʀᴀɴɢᴇ : ${max}` }, tCtx);
          text += themeMgr.format("footer", {}, tCtx);
          text += themeMgr.getSignature(participant, ownerRefs);
          
          await sock.sendMessage(from, { text, mentions: [participant], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
          break;
        }

        case "flip": {
          const r = Math.random() > 0.5 ? "🟡 Heads" : "⚪ Tails";
          
          let text = themeMgr.format("header", { title: "ғʟɪᴘ" }, tCtx);
          text += "\n";
          text += themeMgr.format("section", { title: "ʀɴɢ ʀᴇsᴜʟᴛ" }, tCtx);
          text += themeMgr.format("item", { bullet: "default", content: `🪙 Coin landed on: ${r}` }, tCtx);
          text += themeMgr.format("footer", {}, tCtx);
          text += themeMgr.getSignature(participant, ownerRefs);
          
          await sock.sendMessage(from, { text, mentions: [participant], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
          break;
        }

        default:
          await msgMgr.sendTemp(sock, from, "❓ Unknown fun command.", 4000);
      }

      await sendReact(sock, from, msg, "✅");
    } catch (err) {
      const fe = handleAPIError(err, "Fun");
      await msgMgr.sendTemp(sock, from, `❌ ${fe.message}`, 5000);
      await sendReact(sock, from, msg, "❌");
    }
  },
};
