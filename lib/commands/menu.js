"use strict";

const { getPrefix, getBotName } = require("../runtime-settings");
const { sendReact } = require("../utils");
const themeMgr = require("../theme-manager");
const { sendBannerMessage } = require("../media-fallback");
const ui = require("../ui");

// Aliases that should always render the legacy "show every command" text
// dump (preserves backward compatibility with workflows that paste the
// full command list).
const LEGACY_FULL_LIST_ALIASES = new Set(["allmenu", "commands", "list"]);

module.exports = {
  name: "menu",
  aliases: ["help", "allmenu", "commands", "list", "start"],
  description: "Bot command menu",
  category: "system",

  async execute(sock, msg, from, args, name, context) {
    const participant = msg.key.participant || msg.key.remoteJid || from;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender: participant, ownerRefs };

    await sendReact(sock, from, msg, "📜");

    // --- Bot-wide central menu ---
    // `.menu`, `.help`, `.start` route through the bot-wide UI system so
    // they pick up Button Mode, role-based filtering, list messages, and
    // numeric replies automatically. The full-text-dump aliases below
    // (`.allmenu`, `.commands`, `.list`) keep their original behaviour.
    //
    // V4.2: only run the advanced menu path when Button Mode is ON. When
    // OFF, fall straight through to the legacy themed text menu below.
    const aliasName = String(name || "").toLowerCase();
    const advancedOn = ui.isButtonModeOn({ ...(context || {}), sender: participant, chatJid: from });
    if (!LEGACY_FULL_LIST_ALIASES.has(aliasName) && advancedOn) {
      try {
        const menu = ui.buildTopLevelMenu({
          sender:    participant,
          ownerRefs,
          chatJid:   from,
          prefix:    context.prefix || getPrefix(),
          botName:   context.botName || getBotName(),
          pushName:  context.pushName || msg.pushName || "",
          session:   context.session || null,
        });
        await ui.sendMenu(sock, from, menu, { quoted: msg }, {
          sender:    participant,
          ownerRefs,
          chatJid:   from,
          prefix:    context.prefix || getPrefix(),
          botName:   context.botName || getBotName(),
          pushName:  context.pushName || msg.pushName || "",
          session:   context.session || null,
        });
        await sendReact(sock, from, msg, "✅");
        return;
      } catch (e) {
        // Fall through to legacy text dump below if the new menu system
        // fails for any reason — old behaviour stays as a safety net.
      }
    }

    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);

    const prefix = context.prefix || getPrefix();
    const botName = context.botName || getBotName();

    let fullMenu = themeMgr.format("header", { title: `${botName.toUpperCase()} 𝟐𝟎𝟐𝟔` }, tCtx);
    fullMenu += "\n";
    fullMenu += themeMgr.format("section", { title: "⚡ 𝐔𝐒𝐄𝐑 𝐈𝐍𝐅𝐎" }, tCtx);
    fullMenu += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ   : @${participant.split('@')[0]}` }, tCtx);
    fullMenu += themeMgr.format("item", { bullet: "default", content: `ᴘʀᴇғɪx : 「 ${prefix} 」` }, tCtx);
    fullMenu += themeMgr.format("item", { bullet: "default", content: `ᴜᴘᴛɪᴍᴇ : ${h}h ${m}m` }, tCtx);
    fullMenu += themeMgr.format("item", { bullet: "system", content: `ᴇᴅɪᴛɪᴏɴ: 𝟐𝟎𝟐𝟔 𝐔𝐥𝐭𝐫𝐚-𝐅𝐚𝐬𝐭` }, tCtx);
    fullMenu += themeMgr.format("footer", {}, tCtx);
    fullMenu += "\n";

    // --- DOWNLOADERS ---
    fullMenu += themeMgr.format("box_start", { title: "📥 ᴅᴏᴡɴʟᴏᴀᴅᴇʀs" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}yt · ${prefix}yta · ${prefix}tt` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}ig · ${prefix}fb · ${prefix}play` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}song · ${prefix}video · ${prefix}playvideo` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- MOVIES & CINEMA ---
    fullMenu += themeMgr.format("box_start", { title: "🎬 ᴍᴏᴠɪᴇs & ᴄɪɴᴇᴍᴀ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}movie · ${prefix}baiscope · ${prefix}sinhalasub` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}cinesubz · ${prefix}sub` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- SEARCH ---
    fullMenu += themeMgr.format("box_start", { title: "🔍 sᴇᴀʀᴄʜ & ɪɴғᴏ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}yts · ${prefix}google · ${prefix}wiki` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}weather · ${prefix}imdb · ${prefix}news` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}github · ${prefix}reddit · ${prefix}pinsearch` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}lyrics` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- AI ---
    fullMenu += themeMgr.format("box_start", { title: "🤖 ᴀɪ ᴄᴏɴᴛʀᴏʟ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "creative", content: `${prefix}ai · ${prefix}chat · ${prefix}gpt · ${prefix}gemini` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "creative", content: `${prefix}tts · ${prefix}trt · ${prefix}translate · ${prefix}img` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "creative", content: `${prefix}aiauto (Ultra Settings)` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- ADULT ---
    fullMenu += themeMgr.format("box_start", { title: "🔞 ᴀᴅᴜʟᴛ ᴢᴏɴᴇ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}ph · ${prefix}xnxx · ${prefix}xv · ${prefix}xh` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}yp · ${prefix}sb · ${prefix}rt · ${prefix}boobs` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}ass · ${prefix}waifu · ${prefix}blowjob` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- GAMES ---
    fullMenu += themeMgr.format("box_start", { title: "🎮 ɢᴀᴍᴇs ᴢᴏɴᴇ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}8ball · ${prefix}truth · ${prefix}dare` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}tord · ${prefix}rps · ${prefix}ship` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}lovecalc · ${prefix}roast · ${prefix}rate` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}compliment` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- GROUP ---
    fullMenu += themeMgr.format("box_start", { title: "🛡️ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}kick · ${prefix}add · ${prefix}promote` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}demote · ${prefix}lock · ${prefix}unlock` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}antilink · ${prefix}welcome` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}goodbye · ${prefix}nsfw` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- ECONOMY ---
    fullMenu += themeMgr.format("box_start", { title: "💰 ᴇᴄᴏɴᴏᴍʏ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "economy", content: `${prefix}bal · ${prefix}daily · ${prefix}shop` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "economy", content: `${prefix}buy · ${prefix}transfer · ${prefix}work` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- FUN ---
    fullMenu += themeMgr.format("box_start", { title: "🎈 ғᴜɴ & ᴊᴏᴋᴇs" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "fun", content: `${prefix}joke · ${prefix}meme · ${prefix}fact` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "fun", content: `${prefix}inspire · ${prefix}quote · ${prefix}roll · ${prefix}flip` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- USER ---
    fullMenu += themeMgr.format("box_start", { title: "👤 ᴜsᴇʀ ᴄᴇɴᴛᴇʀ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "user", content: `${prefix}profile · ${prefix}pp · ${prefix}bio` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "user", content: `${prefix}vcard · ${prefix}sticker · ${prefix}myinfo` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- SYSTEM ---
    fullMenu += themeMgr.format("box_start", { title: "⚙️ sʏsᴛᴇᴍ ᴏᴘs" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}ping · ${prefix}speed · ${prefix}alive · ${prefix}runtime` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}status · ${prefix}autoview · ${prefix}autostatus` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}autoreact · ${prefix}antivo (Anti-VO)` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}settings · ${prefix}theme · ${prefix}mode` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}pair · ${prefix}remind · ${prefix}menupro` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- OWNER ---
    fullMenu += themeMgr.format("box_start", { title: "👑 ᴏᴡɴᴇʀ ᴘᴀɴᴇʟ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}reload · ${prefix}update · ${prefix}broadcast` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}ban · ${prefix}unban · ${prefix}listban` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}block · ${prefix}unblock · ${prefix}listblock` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}setowner · ${prefix}addowner · ${prefix}delowner` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}listowner` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);

    fullMenu += themeMgr.getSignature(participant, ownerRefs);

    await sendBannerMessage(sock, from, {
      caption: fullMenu,
      text: fullMenu,
      mentions: [participant],
      contextInfo: { isForwarded: true, forwardingScore: 999 },
      quoted: msg,
    });

    await sendReact(sock, from, msg, "✅");
  },
};
