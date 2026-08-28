"use strict";

const { getMetadata, downloadAndSend } = require("../download-manager");
const { searchYouTube } = require("../search");
const { sendReact, presenceUpdate, truncate } = require("../utils");
const { storeSearchResults, showQualityMenu } = require("../handler");
const { isValidSearchQuery, parseArgs } = require("../validator");
const { handleAPIError, retryWithBackoff } = require("../error-handler");
const rateLimiter = require("../rate-limiter");
const msgMgr = require("../message-manager");
const { logger } = require("../../logger");
const axios = require("axios");
const ui = require("../ui");

const playCommand = {
  name: "play",
  aliases: ["song", "music", "yta"],
  category: "download",
  description: "Play music from YouTube with lyrics",

  async execute(sock, msg, from, args, cmdName) {
    if (!msg?.key || !from) return;

    const query = args.join(" ").trim();
    if (!query) {
      return msgMgr.sendTemp(sock, from, "🎵 Please provide a song name or YouTube link.", 5000);
    }

    const sender = msg.key.participant || msg.key.remoteJid;
    const limit = rateLimiter.check(sender, "play", 3);
    if (!limit.allowed) {
      return msgMgr.sendTemp(sock, from, `⏳ Slow down! Wait ${limit.resetIn}s.`, 5000);
    }

    sendReact(sock, from, msg, "🎵");
    presenceUpdate(sock, from, "composing");

    try {
      // 1. Search YouTube
      const results = await retryWithBackoff(() => searchYouTube(query, 1), {
        maxAttempts: 2,
        delayMs: 1000,
      });

      if (!results || results.length === 0) {
        return msgMgr.sendTemp(sock, from, "❌ No results found on YouTube.", 5000);
      }

      const video = results[0];
      const url = video.url;

      // 2. Fetch Lyrics (Optional)
      let lyrics = "No lyrics found for this song.";
      try {
        const { data } = await axios.get(`https://api.popcat.xyz/lyrics?song=${encodeURIComponent(video.title)}`, { timeout: 5000 });
        if (data.lyrics) lyrics = data.lyrics;
      } catch (e) {
        logger(`[Play] Lyrics failed: ${e.message}`);
      }

      // 3. Prepare response with Hacker Theme
      let playMsg = `┌── ⋆⋅☆⋅⋆ 𝐂𝐇𝐀𝐓𝐇𝐔 𝐌𝐃 ⋆⋅☆⋅⋆ ──┐\n`;
      playMsg += `│   »»——  ᴍᴜsɪᴄ ᴘʟᴀʏᴇʀ  ——««  │\n`;
      playMsg += `└────────────────────────────┘\n\n`;
      playMsg += ` ╭━━ ❨ 👤 ᴘʀᴏғɪʟᴇ ❩ ━━\n`;
      playMsg += ` ┃ ⌕ ᴜsᴇʀ : @${sender.split('@')[0]}\n`;
      playMsg += ` ╰━━━━━━━━━━━━━━━\n\n`;
      playMsg += `  【 ☁️ sᴏɴɢ ɪɴғᴏ 】\n`;
      playMsg += `  ► Title     : ${truncate(video.title, 45)}\n`;
      playMsg += `  ► Artist    : ${video.author || "Unknown"}\n`;
      playMsg += `  ► Duration  : ${video.duration || "?"}\n\n`;
      playMsg += `  【 🎙️ ʟʏʀɪᴄs 】\n`;
      playMsg += `  ${truncate(lyrics, 400)}\n\n`;
      playMsg += `  【 📥 ᴅᴏᴡɴʟᴏᴀᴅ ᴏᴘᴛɪᴏɴs 】\n`;
      playMsg += `  ► 1️⃣ Reply *1* for Audio 🎵\n`;
      playMsg += `  ► 2️⃣ Reply *2* for Voice Note 🎙️\n`;
      playMsg += `  ► 3️⃣ Reply *3* for Document 📁\n`;
      playMsg += `  ► 4️⃣ Reply *4* for Video 🎬\n\n`;
      playMsg += ` 🌸 ⋆｡°✩ 𝐂𝐇𝐀𝐓𝐇𝐔 𝐌𝐃 ✩°｡⋆ 🌸`;

      const { storePlaySelection } = require("../handler");
      storePlaySelection(sender, video);

      if (ui.isButtonModeOn({ sender, chatJid: from })) {
        await ui.sendQualityMenu(sock, from, video, {
          title: "🎚 PLAY ACTION",
          items: [
            { label: "🎵 Audio",      title: "Audio",      action: "quality:select:audio",     payload: video },
            { label: "🎙️ Voice Note", title: "Voice Note", action: "quality:select:voicenote", payload: video },
            { label: "📁 Document",   title: "Document",   action: "quality:select:document", payload: video },
            { label: "🎬 Video",      title: "Video",      action: "quality:select:sd",       payload: video },
          ],
          send: { quoted: msg },
        }, { sender, chatJid: from });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      await sock.sendMessage(from, {
        image: { url: video.thumbnail },
        caption: playMsg,
        mentions: [sender],
        contextInfo: { isForwarded: true, forwardingScore: 999 }
      }, { quoted: msg });

      await sendReact(sock, from, msg, "✅");

    } catch (err) {
      const fe = handleAPIError(err, "Play");
      await msgMgr.sendTemp(sock, from, `❌ ${fe.message}`, 5000);
      await sendReact(sock, from, msg, "❌");
    }
  },
};

// Search YouTube for a query and immediately download the top hit as video
// (skips the interactive 1/2/3/4 quality menu shown by `.play`).
const playVideoCommand = {
  name: "playvideo",
  aliases: ["pv"],
  category: "download",
  description: "Search YouTube and send the top video result",

  async execute(sock, msg, from, args) {
    if (!msg?.key || !from) return;

    const query = args.join(" ").trim();
    if (!query) {
      return msgMgr.sendTemp(sock, from, "🎬 Please provide a video name or YouTube link.", 5000);
    }

    const sender = msg.key.participant || msg.key.remoteJid;
    const limit = rateLimiter.check(sender, "playvideo", 3);
    if (!limit.allowed) {
      return msgMgr.sendTemp(sock, from, `⏳ Slow down! Wait ${limit.resetIn}s.`, 5000);
    }

    sendReact(sock, from, msg, "🎬");
    presenceUpdate(sock, from, "composing");

    try {
      const results = await retryWithBackoff(() => searchYouTube(query, 1), {
        maxAttempts: 2,
        delayMs: 1000,
      });
      if (!results || results.length === 0) {
        return msgMgr.sendTemp(sock, from, "❌ No results found on YouTube.", 5000);
      }

      const video = results[0];
      const ph = await sock.sendMessage(
        from,
        { text: `🎬 *${truncate(video.title, 60)}*\n⬇️ Downloading SD video...` },
        { quoted: msg },
      );

      await downloadAndSend(sock, from, video.url, "YouTube", "sd", false, false, false);
      await sock.sendMessage(from, { delete: ph.key }).catch(() => {});
      await sendReact(sock, from, msg, "✅");
    } catch (err) {
      const fe = handleAPIError(err, "PlayVideo");
      await msgMgr.sendTemp(sock, from, `❌ ${fe.message}`, 5000);
      await sendReact(sock, from, msg, "❌");
    }
  },
};

module.exports = [playCommand, playVideoCommand];
