"use strict";

const axios = require("axios");
const { searchYouTube, searchAdultSite } = require("../search");
const { sendReact, presenceUpdate, truncate } = require("../utils");
const { storeSearchResults } = require("../handler");
const { handleAPIError, retryWithBackoff } = require("../error-handler");
const { isValidSearchQuery } = require("../validator");
const rateLimiter = require("../rate-limiter");
const themeMgr = require("../theme-manager");
const msgMgr = require("../message-manager");
const ui = require("../ui");

const ADULT_SITE_MAP = {
  phsearch: "Pornhub",
  xvsearch: "XVideos",
  xhsearch: "xHamster",
  ypsearch: "YouPorn",
  sbsearch: "SpankBang",
  rtsearch: "RedTube",
};

function formatList(results, query, label, sender, ownerRefs) {
  const tCtx = { sender, ownerRefs };
  let msg = themeMgr.format("header", { title: label.toUpperCase() }, tCtx);
  msg += "\n";
  msg += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
  msg += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ  : @${sender.split('@')[0]}` }, tCtx);
  msg += themeMgr.format("item", { bullet: "search", content: `ǫᴜᴇʀʏ : "${truncate(query, 30)}"` }, tCtx);
  msg += themeMgr.format("footer", {}, tCtx);
  msg += "\n";

  msg += themeMgr.format("box_start", { title: "sᴇᴀʀᴄʜ ʀᴇsᴜʟᴛs" }, tCtx);
  results.forEach((v, i) => {
    msg += themeMgr.format("box_item", { bullet: "default", content: `${i + 1}. ${truncate(v.title, 40)} (${v.duration || "?"})` }, tCtx);
  });
  msg += themeMgr.format("box_end", {}, tCtx);
  msg += "\n";

  msg += themeMgr.format("box_start", { title: themeMgr.getKeyword("action") }, tCtx);
  msg += themeMgr.format("box_item", { bullet: "default", content: `👉 Reply 1–${results.length} to download` }, tCtx);
  msg += themeMgr.format("box_end", {}, tCtx);
  
  msg += themeMgr.getSignature(sender, ownerRefs);
  return msg;
}

module.exports = {
  name: "search",
  aliases: ["yts", "g", "google", "wiki", "reddit", "pinsearch", "imdb", "github", "weather", "news", "lyrics", ...Object.keys(ADULT_SITE_MAP)],
  category: "search",
  description: "Multi-site search engine",

  async execute(sock, msg, from, args, cmdName, context) {
    const q = args?.join(" ").trim() || "";
    if (!isValidSearchQuery(q)) {
      return msgMgr.sendTemp(sock, from, "🔍 Please provide a search keyword.", 5000);
    }

    const sender = msg?.key?.participant || msg?.key?.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    const limit = rateLimiter.check(sender, "search", 15);
    if (!limit.allowed) {
      return msgMgr.sendTemp(sock, from, `⏳ Too many searches. Wait ${limit.resetIn}s.`, 5000);
    }

    sendReact(sock, from, msg, "🔍");
    presenceUpdate(sock, from, "composing");

    try {
      // 1. YouTube Search
      if (cmdName === "yts") {
        const results = await retryWithBackoff(() => searchYouTube(q, 10), {
          maxAttempts: 2,
          delayMs: 1000,
          throwOnFail: false,
          fallback: [],
        });
        if (!results.length) {
          return msgMgr.sendTemp(sock, from, `❌ No YouTube results for "${q}".`, 6000);
        }
        if (ui.isButtonModeOn({ ...context, sender, chatJid: from })) {
          storeSearchResults(msg?.key?.id, sender, results);
          await ui.sendResultMenu(sock, from, q, results, {
            title: "🔎 YOUTUBE RESULTS",
            send: { quoted: msg },
          }, { sender, ownerRefs, chatJid: from });
          await sendReact(sock, from, msg, "✅");
          return;
        }
        await sock.sendMessage(from, { text: formatList(results, q, "YouTube Search", sender, ownerRefs), mentions: [sender], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
        storeSearchResults(msg?.key?.id, sender, results);
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 2. Adult Searches
      const adultSite = ADULT_SITE_MAP[cmdName];
      if (adultSite) {
        const results = await retryWithBackoff(
          () => searchAdultSite(adultSite, q, 10),
          { maxAttempts: 2, delayMs: 1000, throwOnFail: false, fallback: [] },
        );
        if (!results.length) {
          return msgMgr.sendTemp(sock, from, `🔞 No *${adultSite}* results for "${q}". Try again shortly.`, 7000);
        }
        if (ui.isButtonModeOn({ ...context, sender, chatJid: from })) {
          storeSearchResults(msg?.key?.id, sender, results);
          await ui.sendResultMenu(sock, from, q, results, {
            title: `🔞 ${adultSite.toUpperCase()} RESULTS`,
            send: { quoted: msg },
          }, { sender, ownerRefs, chatJid: from });
          await sendReact(sock, from, msg, "✅");
          return;
        }
        await sock.sendMessage(from, { text: formatList(results, q, `${adultSite} Search`, sender, ownerRefs), mentions: [sender], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
        storeSearchResults(msg?.key?.id, sender, results);
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 3. DuckDuckGo / Google Instant
      if (cmdName === "g" || cmdName === "google") {
        const { data } = await axios.get(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json`,
          { timeout: 8000 },
        );
        
        let reply = themeMgr.format("header", { title: "ᴅᴜᴄᴋᴅᴜᴄᴋɢᴏ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
        reply += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ  : @${sender.split('@')[0]}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "search", content: `ǫᴜᴇʀʏ : "${truncate(q, 30)}"` }, tCtx);
        reply += themeMgr.format("footer", {}, tCtx);
        reply += "\n";

        if (data.Abstract) {
          reply += themeMgr.format("box_start", { title: "sᴜᴍᴍᴀʀʏ" }, tCtx);
          reply += themeMgr.format("box_item", { bullet: "default", content: truncate(data.Abstract, 500) }, tCtx);
          reply += themeMgr.format("box_end", {}, tCtx);
          reply += "\n";
        }

        const topics = (data?.RelatedTopics || []).slice(0, 5);
        if (topics.length > 0) {
          reply += themeMgr.format("box_start", { title: "ʀᴇʟᴀᴛᴇᴅ ᴛᴏᴘɪᴄs" }, tCtx);
          topics.forEach((r, i) => {
            if (r?.Text) reply += themeMgr.format("box_item", { bullet: "default", content: `${i + 1}. ${truncate(r.Text, 80)}` }, tCtx);
          });
          reply += themeMgr.format("box_end", {}, tCtx);
          reply += "\n";
        }
        
        reply += themeMgr.getSignature(sender, ownerRefs);
        await sock.sendMessage(from, { text: reply, mentions: [sender], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 4. Wikipedia
      if (cmdName === "wiki") {
        const { data } = await axios.get(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`,
          { timeout: 8000 },
        );
        
        let reply = themeMgr.format("header", { title: "ᴡɪᴋɪᴘᴇᴅɪᴀ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ᴛᴏᴘɪᴄ" }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: data.title }, tCtx);
        reply += themeMgr.format("footer", {}, tCtx);
        reply += "\n";

        reply += themeMgr.format("box_start", { title: "sᴜᴍᴍᴀʀʏ" }, tCtx);
        reply += themeMgr.format("box_item", { bullet: "default", content: truncate(data.extract, 600) }, tCtx);
        reply += themeMgr.format("box_end", {}, tCtx);
        
        reply += themeMgr.getSignature(sender, ownerRefs);
        await sock.sendMessage(from, { text: reply, mentions: [sender], contextInfo: { isForwarded: true, forwardingScore: 999 } }, { quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 5. IMDB
      if (cmdName === "imdb") {
        const { data } = await axios.get(`http://www.omdbapi.com/?t=${encodeURIComponent(q)}&apikey=df43c644`);
        if (data.Response === "False") return msgMgr.sendTemp(sock, from, "❌ Movie not found.", 5000);

        let reply = themeMgr.format("header", { title: "ɪᴍᴅʙ ᴍᴏᴠɪᴇ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: data.Title }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Year: ${data.Year}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Rated: ${data.Rated}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Runtime: ${data.Runtime}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Genre: ${data.Genre}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Rating: ⭐ ${data.imdbRating}` }, tCtx);
        reply += themeMgr.format("footer", {}, tCtx);
        reply += "\n";

        reply += themeMgr.format("box_start", { title: "ᴘʟᴏᴛ" }, tCtx);
        reply += themeMgr.format("box_item", { bullet: "default", content: truncate(data.Plot, 500) }, tCtx);
        reply += themeMgr.format("box_end", {}, tCtx);
        
        reply += themeMgr.getSignature(sender, ownerRefs);

        const content = data.Poster && data.Poster !== "N/A" 
            ? { image: { url: data.Poster }, caption: reply } 
            : { text: reply };

        await sock.sendMessage(from, content, { quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 6. GitHub
      if (cmdName === "github") {
        const { data } = await axios.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=5`);
        if (!data.items?.length) return msgMgr.sendTemp(sock, from, "❌ No repositories found.", 5000);

        let reply = themeMgr.format("header", { title: "ɢɪᴛʜᴜʙ sᴇᴀʀᴄʜ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: "ʀᴇsᴜʟᴛs" }, tCtx);
        
        data.items.forEach((repo, i) => {
          reply += themeMgr.format("item", { bullet: "default", content: `*${i+1}. ${repo.full_name}*` }, tCtx);
          reply += `    ┕ 🌟 Stars: ${repo.stargazers_count} | 🍴 Forks: ${repo.forks_count}\n`;
        });
        
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 7. Weather
      if (cmdName === "weather") {
        const { data } = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&units=metric&appid=060a6bcfa19809c2cd4d97a212b199c8`);
        
        let reply = themeMgr.format("header", { title: "ᴡᴇᴀᴛʜᴇʀ ʀᴇᴘᴏʀᴛ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: `${data.name}, ${data.sys.country}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Condition : ${data.weather[0].main}` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Temp      : ${data.main.temp}°C` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Humidity  : ${data.main.humidity}%` }, tCtx);
        reply += themeMgr.format("item", { bullet: "default", content: `Wind      : ${data.wind.speed} m/s` }, tCtx);
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);
        
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 8. Lyrics
      if (cmdName === "lyrics") {
        const { data } = await axios.get(`https://lyrist.vercel.app/api/${encodeURIComponent(q)}`);
        if (!data || data.error || !data.lyrics) return msgMgr.sendTemp(sock, from, "❌ Lyrics not found.", 5000);

        let reply = themeMgr.format("header", { title: "ʟʏʀɪᴄs ғɪɴᴅᴇʀ" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: `${data.title} - ${data.artist}` }, tCtx);
        reply += "\n";
        reply += truncate(data.lyrics, 2000);
        reply += "\n\n";
        reply += themeMgr.getSignature(sender, ownerRefs);

        const content = data.image ? { image: { url: data.image }, caption: reply } : { text: reply };
        await sock.sendMessage(from, content, { quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 9. News
      if (cmdName === "news") {
        const { data } = await axios.get(`https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=5&apiKey=060a6bcfa19809c2cd4d97a212b199c8`); // Note: Reusing a key or getting a free one is better, but this is for demo
        if (!data.articles?.length) return msgMgr.sendTemp(sock, from, "❌ No news found.", 5000);

        let reply = themeMgr.format("header", { title: "ɢʟᴏʙᴀʟ ɴᴇᴡs" }, tCtx);
        reply += "\n";
        reply += themeMgr.format("section", { title: `ʀᴇsᴜʟᴛs ғᴏʀ "${q}"` }, tCtx);
        
        data.articles.forEach((art, i) => {
          reply += themeMgr.format("item", { bullet: "default", content: `*${i+1}. ${art.title}*` }, tCtx);
          reply += `    ┕ ${art.source.name} | ${art.url}\n`;
        });
        
        reply += themeMgr.format("footer", {}, tCtx);
        reply += themeMgr.getSignature(sender, ownerRefs);
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
        await sendReact(sock, from, msg, "✅");
        return;
      }

      // 10. Reddit / Pinterest (Existing)
      if (cmdName === "reddit" || cmdName === "pinsearch") {
         // Keep existing logic from previous turn or implement similar to others
         // ... (I'll re-add it below for completeness)
         if (cmdName === "reddit") {
            const { data } = await axios.get(`https://www.reddit.com/r/${encodeURIComponent(q)}/hot.json?limit=5`, { headers: { "User-Agent": "ChathuMDBot/3.5" } });
            const posts = (data?.data?.children || []).map(p => p.data);
            let reply = themeMgr.format("header", { title: `ʀᴇᴅᴅɪᴛ: r/${q}` }, tCtx);
            posts.forEach((p, i) => reply += themeMgr.format("item", { bullet: "default", content: `${i+1}. ${truncate(p.title, 50)} (👍 ${p.ups})` }, tCtx));
            reply += themeMgr.getSignature(sender, ownerRefs);
            await sock.sendMessage(from, { text: reply }, { quoted: msg });
         } else {
            const link = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`;
            let reply = themeMgr.format("header", { title: "ᴘɪɴᴛᴇʀᴇsᴛ" }, tCtx);
            reply += themeMgr.format("item", { bullet: "search", content: `Query: ${q}` }, tCtx);
            reply += themeMgr.format("item", { bullet: "default", content: `Link: ${link}` }, tCtx);
            reply += themeMgr.getSignature(sender, ownerRefs);
            await sock.sendMessage(from, { text: reply }, { quoted: msg });
         }
         await sendReact(sock, from, msg, "✅");
         return;
      }

      await sendReact(sock, from, msg, "❓");
    } catch (err) {
      await sendReact(sock, from, msg, "❌");
      const fe = handleAPIError(err, "Search");
      await msgMgr.sendTemp(sock, from, `❌ ${fe.message}`, 7000);
    }
  },
};
