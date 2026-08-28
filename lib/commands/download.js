"use strict";

const { getMetadata, downloadAndSend } = require("../download-manager");
const { searchYouTube, searchAdultSite, searchAllAdult } = require("../search");
const { sendReact, presenceUpdate, truncate } = require("../utils");
const { storeSearchResults, showQualityMenu } = require("../handler");
const { isValidUrl, isValidSearchQuery, parseArgs } = require("../validator");
const { handleAPIError, retryWithBackoff } = require("../error-handler");
const rateLimiter = require("../rate-limiter");
const msgMgr = require("../message-manager");
const { logger } = require("../../logger");
const themeMgr = require("../theme-manager");
const ui = require("../ui");

const SITE_MAP = {
  yt: { name: "YouTube", adult: false },
  tt: { name: "TikTok", adult: false },
  ig: { name: "Instagram", adult: false },
  fb: { name: "Facebook", adult: false },
  ph: { name: "Pornhub", adult: true },
  xnxx: { name: "XNXX", adult: true },
  xv: { name: "XVideos", adult: true },
  xh: { name: "xHamster", adult: true },
  yp: { name: "YouPorn", adult: true },
  sb: { name: "SpankBang", adult: true },
  rt: { name: "RedTube", adult: true },
};

module.exports = {
  name: "download",
  // `video` is a generic alias that infers the platform from the URL/keyword.
  aliases: [...Object.keys(SITE_MAP), "video"],
  category: "download",
  description: "Universal media downloader",

  async execute(sock, msg, from, args, cmdName, context) {
    if (!msg?.key || !from) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    // `video` falls back to the YouTube site profile; the smart link
    // detection below upgrades it to TikTok/Instagram/Facebook when the URL
    // matches.
    const site = SITE_MAP[cmdName] || (cmdName === "video" ? { ...SITE_MAP.yt } : { name: "Media", adult: false });
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    const limit = rateLimiter.check(sender, "download", 3);
    if (!limit.allowed) {
      await msgMgr.sendTemp(sock, from, `⏳ Slow down! Wait ${limit.resetIn}s.`, 5000);
      return;
    }

    const { urls, keywords, flags } = parseArgs(args);
    let url = urls[0];
    const keyword = keywords.join(" ");

    // Smart Link Detection
    if (url) {
      if (url.includes("tiktok.com")) site.name = "TikTok";
      else if (url.includes("instagram.com")) site.name = "Instagram";
      else if (url.includes("facebook.com") || url.includes("fb.watch")) site.name = "Facebook";
    }

    const isAudio = cmdName === "yta" || flags.audio || flags.mp3;

    if (!url && !keyword) {
      await sendReact(sock, from, msg, "❓");
      await msgMgr.sendTemp(
        sock,
        from,
        `⚠️ *Usage*\n*.${cmdName} <link>* — direct download\n*.${cmdName} <keyword>* — search\n\n_Example: .${cmdName} funny cats_`,
        8000,
      );
      return;
    }

    if (!url && keyword) {
      if (!isValidSearchQuery(keyword)) {
        await msgMgr.sendTemp(sock, from, "❌ Invalid query (max 100 chars).", 4000);
        return;
      }

      sendReact(sock, from, msg, "🔍");
      presenceUpdate(sock, from, "composing");
      msgMgr.sendTemp(sock, from, `🔍 Searching *${site.name}*…`, 3000);

      try {
        let results = await retryWithBackoff(
          async () => {
            if (!site.adult) return searchYouTube(keyword, 10);
            try {
              const r = await searchAdultSite(site.name, keyword, 10);
              if (r && r.length > 0) return r;
            } catch (e) {
              logger(`[Search] Primary adult search failed: ${e.message}`);
            }
            const fallback = await searchAllAdult(keyword, 10);
            if (!fallback || fallback.length === 0)
              throw new Error("No adult results across all modules");
            return fallback;
          },
          { maxAttempts: 2, delayMs: 1000, context: "MediaSearch", throwOnFail: false, fallback: [] },
        );

        if (!results?.length) {
          await msgMgr.sendTemp(sock, from, "❌ No results found.", 5000);
          await sendReact(sock, from, msg, "❌");
          return;
        }

        results = results.slice(0, 10);
        let listMsg = themeMgr.format("header", { title: "sᴇᴀʀᴄʜ ʀᴇsᴜʟᴛs" }, tCtx);
        listMsg += "\n";
        listMsg += themeMgr.format("section", { title: `ʀᴇsᴜʟᴛs: ${site.name.toUpperCase()}` }, tCtx);
        listMsg += themeMgr.format("item", { bullet: "search", content: `ǫᴜᴇʀʏ : "${truncate(keyword, 30)}"` }, tCtx);
        listMsg += "\n";

        results.forEach((v, i) => {
          listMsg += themeMgr.format("item", { bullet: "default", content: `${i + 1}. ${truncate(v.title, 40)}` }, tCtx);
          listMsg += `    ┖ Duration: ${v.duration || "?"}\n`;
        });
        
        listMsg += "\n";
        listMsg += themeMgr.format("box_start", { title: "ᴀᴄᴛɪᴏɴ" }, tCtx);
        listMsg += themeMgr.format("box_item", { bullet: "creative", content: `Reply 1–${results.length} to select ${themeMgr.getKeyword("video_ready")}` }, tCtx);
        listMsg += themeMgr.format("box_end", {}, tCtx);
        
        listMsg += themeMgr.getSignature(sender, ownerRefs);

        if (ui.isButtonModeOn({ ...context, sender, chatJid: from })) {
          storeSearchResults(msg.key.id, sender, results);
          await ui.sendResultMenu(sock, from, keyword, results, {
            title: `🔎 ${site.name.toUpperCase()} RESULTS`,
            send:  { quoted: msg },
          }, { sender, ownerRefs, chatJid: from });
          await sendReact(sock, from, msg, "✅");
          return;
        }
        await sock.sendMessage(from, { text: listMsg, mentions: [sender], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
        storeSearchResults(msg.key.id, sender, results);
        await sendReact(sock, from, msg, "✅");
      } catch (err) {
        const fe = handleAPIError(err, "Search");
        await msgMgr.sendTemp(sock, from, `❌ ${fe.message}`, 5000);
        await sendReact(sock, from, msg, "❌");
      }
      return;
    }

    if (!isValidUrl(url)) {
      await msgMgr.sendTemp(sock, from, "❌ Invalid URL.", 4000);
      await sendReact(sock, from, msg, "❌");
      return;
    }

    const hasQuality = flags.hd || flags.sd || flags.low || isAudio;

    if (!hasQuality) {
      sendReact(sock, from, msg, "🎬");
      presenceUpdate(sock, from, "composing");
      try {
        let meta = await getMetadata(url);
        if (!meta) {
          meta = {
            title: `${site.name} Media`,
            duration: "N/A",
            thumbnail: "",
            url: url,
            filesize: 0,
            channel: site.name,
            source: site.name,
          };
        }
        meta.msg = msg;
        if (ui.isButtonModeOn({ ...context, sender, chatJid: from })) {
          return await ui.sendQualityMenu(sock, from, meta, { send: { quoted: msg } }, { sender, ownerRefs, chatJid: from });
        }
        return await showQualityMenu(sock, from, meta, sender, ownerRefs);
      } catch (err) {
        logger(`[Download] Metadata: ${err.message}`);
        const fallbackMeta = {
          title: `${site.name} Media`,
          duration: "N/A",
          thumbnail: "",
          url: url,
          filesize: 0,
          channel: site.name,
          source: site.name,
          msg,
        };
        return await showQualityMenu(sock, from, fallbackMeta, sender, ownerRefs);
      }
    }

    sendReact(sock, from, msg, "⏳");
    presenceUpdate(sock, from, isAudio ? "recording" : "composing");

    const quality = flags.hd ? "hd" : (flags.sd ? "sd" : (flags.low ? "low" : "sd"));

    try {
      await downloadAndSend(sock, from, url, site.name, quality, isAudio);
      await sendReact(sock, from, msg, "✅");
    } catch (err) {
      const fe = handleAPIError(err, "Download");
      await msgMgr.sendTemp(sock, from, `❌ ${fe.message}`, 5000);
      await sendReact(sock, from, msg, "❌");
      logger(`[Download] Error: ${err.message}`);
    }
  },
};
