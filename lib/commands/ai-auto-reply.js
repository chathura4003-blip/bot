"use strict";

const db = require("../db");
const appState = require("../../state");
const msgMgr = require("../message-manager");
const themeMgr = require("../theme-manager");

module.exports = {
  name: "aiauto",
  aliases: ["ai-auto", "autoai"],
  description: "Toggle AI Auto Reply, set persona, language, voice and memory",
  category: "settings",

  async execute(sock, msg, from, args, name, context) {
    const sender = msg.key.participant || msg.key.remoteJid || from;
    const isOwner = context.isOwner || false;
    const cmd = args[0]?.toLowerCase();
    const subCmd = args[1]?.toLowerCase();
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender, ownerRefs };

    if (!isOwner) {
      return msgMgr.sendTemp(sock, from, "❌ මෙම අණ ක්‍රියාත්මක කිරීමට ඔබට අවසර නැත. (Owner Only)", 5000);
    }

    // --- Commands ---

    // Toggle Global ON/OFF
    if (cmd === "on" || cmd === "enable") {
      appState.setAiAutoReply(true);
      return sock.sendMessage(from, { text: "✅ *AI Auto Reply Global:* ON" }, { quoted: msg });
    }
    if (cmd === "off" || cmd === "disable") {
      appState.setAiAutoReply(false);
      return sock.sendMessage(from, { text: "✅ *AI Auto Reply Global:* OFF" }, { quoted: msg });
    }

    // Toggle Voice
    if (cmd === "voice") {
      const mode = subCmd === "on" || subCmd === "enable";
      appState.setAiAutoVoice(mode);
      return sock.sendMessage(from, { text: `✅ *AI Voice Response:* ${mode ? 'ON 🔊' : 'OFF 🔇'}` }, { quoted: msg });
    }

    // Toggle for Current Chat
    if (cmd === "chat") {
      if (!from.endsWith("@g.us")) {
        return sock.sendMessage(from, { text: "⚠️ මෙම අණ පාවිච්චි කළ හැක්කේ ගෲප් වල පමණි." }, { quoted: msg });
      }
      const groupData = db.get("groups", from) || {};
      const mode = subCmd === "on" || subCmd === "enable";
      groupData.ai_auto = mode;
      db.set("groups", from, groupData);
      return sock.sendMessage(from, { text: `✅ *AI Auto Reply for this Chat:* ${mode ? 'ENABLED' : 'DISABLED'}` }, { quoted: msg });
    }

    // Persona Setting
    if (cmd === "persona" || cmd === "type") {
      const valid = ["friendly", "funny", "savage", "romantic", "professional", "robot"];
      if (!subCmd || !valid.includes(subCmd)) {
        return sock.sendMessage(from, { text: `⚠️ ලබාගත හැකි වර්ග: ${valid.join(", ")}` }, { quoted: msg });
      }
      appState.setAiAutoPersona(subCmd);
      return sock.sendMessage(from, { text: `✅ *AI Persona:* ${subCmd.toUpperCase()}` }, { quoted: msg });
    }

    // Language Setting
    if (cmd === "lang") {
      const valid = ["si", "en", "auto"];
      if (!subCmd || !valid.includes(subCmd)) {
        return sock.sendMessage(from, { text: `⚠️ ලබාගත හැකි වර්ග: si, en, auto` }, { quoted: msg });
      }
      appState.setAiAutoLang(subCmd);
      return sock.sendMessage(from, { text: `✅ *AI Language:* ${subCmd.toUpperCase()}` }, { quoted: msg });
    }

    // Group Mode Setting
    if (cmd === "groupmode" || cmd === "gmode") {
      const valid = ["silent", "mention", "respond"];
      if (!subCmd || !valid.includes(subCmd)) {
        return sock.sendMessage(from, { text: `⚠️ ලබාගත හැකි modes: ${valid.join(", ")}` }, { quoted: msg });
      }
      appState.setAiGroupMode(subCmd);
      return sock.sendMessage(from, { text: `✅ *AI Group Mode:* ${subCmd.toUpperCase()}` }, { quoted: msg });
    }

    // Wake Words Setting (.aiauto wake word1, word2, ...)
    if (cmd === "wake" || cmd === "wakewords") {
      if (!subCmd) {
        const cur = appState.getAiAutoWakeWords();
        const txt = cur.length ? cur.join(", ") : "(none)";
        return sock.sendMessage(from, { text: `🔔 *Current wake words:* ${txt}\n\nUsage: .aiauto wake word1, word2, word3\nClear with: .aiauto wake clear` }, { quoted: msg });
      }
      if (subCmd === "clear" || subCmd === "reset") {
        appState.setAiAutoWakeWords("");
        return sock.sendMessage(from, { text: "✅ Wake words cleared." }, { quoted: msg });
      }
      const raw = args.slice(1).join(" ");
      appState.setAiAutoWakeWords(raw);
      const updated = appState.getAiAutoWakeWords();
      return sock.sendMessage(from, { text: `✅ *Wake words updated:* ${updated.join(", ") || "(none)"}` }, { quoted: msg });
    }

    // Burst-spam shield toggle
    if (cmd === "burst" || cmd === "burstshield") {
      const mode = subCmd === "on" || subCmd === "enable";
      appState.setAiAutoBurstShield(mode);
      return sock.sendMessage(from, { text: `✅ *Burst-spam shield:* ${mode ? "ON 🛡️" : "OFF"}` }, { quoted: msg });
    }

    // Light auto-react toggle
    if (cmd === "react" || cmd === "lightreact") {
      const mode = subCmd === "on" || subCmd === "enable";
      appState.setAiAutoLightReact(mode);
      return sock.sendMessage(from, { text: `✅ *Light auto-react:* ${mode ? "ON ✨" : "OFF"}` }, { quoted: msg });
    }

    // Memory depth setting (turns of conversation kept in context)
    if (cmd === "memory" || cmd === "mem") {
      const n = parseInt(subCmd);
      if (!Number.isFinite(n) || n < 2 || n > 20) {
        const cur = appState.getAiAutoMemoryDepth();
        return sock.sendMessage(from, { text: `🧠 *Current memory depth:* ${cur} turns\n\nUsage: .aiauto memory <2-20>` }, { quoted: msg });
      }
      appState.setAiAutoMemoryDepth(n);
      return sock.sendMessage(from, { text: `✅ *Memory depth:* ${n} turns` }, { quoted: msg });
    }

    // Max words for AI replies
    if (cmd === "maxwords" || cmd === "words") {
      const n = parseInt(subCmd);
      if (!Number.isFinite(n) || n < 5 || n > 200) {
        const cur = appState.getAiMaxWords();
        return sock.sendMessage(from, { text: `📏 *Current max words:* ${cur}\n\nUsage: .aiauto maxwords <5-200>` }, { quoted: msg });
      }
      appState.setAiMaxWords(n);
      return sock.sendMessage(from, { text: `✅ *Max words:* ${n}` }, { quoted: msg });
    }

    // System Instruction (free-form custom directive)
    if (cmd === "system" || cmd === "instr") {
      if (!subCmd) {
        const cur = appState.getAiSystemInstruction() || "(none)";
        return sock.sendMessage(from, { text: `🧬 *Current system instruction:*\n${cur}\n\nUsage: .aiauto system <text>\nClear: .aiauto system clear` }, { quoted: msg });
      }
      if (subCmd === "clear" || subCmd === "reset") {
        appState.setAiSystemInstruction("");
        return sock.sendMessage(from, { text: "✅ System instruction cleared." }, { quoted: msg });
      }
      const raw = args.slice(1).join(" ").slice(0, 600);
      appState.setAiSystemInstruction(raw);
      return sock.sendMessage(from, { text: `✅ *System instruction set* (${raw.length} chars)` }, { quoted: msg });
    }

    // Display Menu
    const currentStatus = appState.getAiAutoReply() ? "ON ✅" : "OFF ❌";
    const voiceStatus = appState.getAiAutoVoice() ? "ON 🔊" : "OFF 🔇";
    const persona = appState.getAiAutoPersona();
    const lang = appState.getAiAutoLang();
    const groupMode = appState.getAiGroupMode() || 'mention';
    const burstShield = appState.getAiAutoBurstShield() ? "ON 🛡️" : "OFF";
    const lightReact = appState.getAiAutoLightReact() ? "ON ✨" : "OFF";
    const memDepth = appState.getAiAutoMemoryDepth();
    const maxWords = appState.getAiMaxWords();
    const wakeWords = appState.getAiAutoWakeWords();
    const wakeWordsDisp = wakeWords.length ? wakeWords.slice(0, 5).join(", ") + (wakeWords.length > 5 ? "…" : "") : "(none)";
    
    const personaDesc = {
      'friendly': 'හිතවත් මිතුරෙකු ලෙස',
      'funny': 'විහිළු තහළු කරන මිතුරෙකු ලෙස',
      'savage': 'ටිකක් Roast කරන, සැර මිතුරෙකු ලෙස',
      'romantic': 'ආදරණීය මිතුරෙකු ලෙස',
      'professional': 'වෘත්තීය සහයෙකු ලෙස',
      'robot': 'තාක්ෂණික බොට් ලෙස'
    };
    
    let menu = themeMgr.format("header", { title: "AI AUTO REPLY ULTRA" }, tCtx);
    menu += "\n";
    menu += themeMgr.format("box_start", { title: "CURRENT CONFIG" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Global Status : ${currentStatus}` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Voice Mode    : ${voiceStatus}` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Persona       : ${persona.toUpperCase()} (${personaDesc[persona] || ''})` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Language      : ${lang.toUpperCase()}` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Group Mode    : ${groupMode.toUpperCase()}` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Burst Shield  : ${burstShield}` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Light React   : ${lightReact}` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Memory Depth  : ${memDepth} turns` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Max Words     : ${maxWords}` }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: `Wake Words    : ${wakeWordsDisp}` }, tCtx);
    menu += themeMgr.format("box_end", {}, tCtx);
    menu += "\n";
    menu += themeMgr.format("box_start", { title: "COMMANDS" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto <on/off> - Global Switch" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto voice <on/off> - Voice Reply" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto chat <on/off> - Group Toggle" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto persona <type> - Change Style" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto lang <si/en/auto> - Language" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto groupmode <silent/mention/respond>" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto wake <words...> - Wake words" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto burst <on/off> - Burst shield" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto react <on/off> - Light react" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto memory <2-20> - Memory turns" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto maxwords <5-200> - Reply length" }, tCtx);
    menu += themeMgr.format("box_item", { bullet: "default", content: ".aiauto system <text> - Custom instruction" }, tCtx);
    menu += themeMgr.format("box_end", {}, tCtx);
    menu += themeMgr.getSignature(sender, ownerRefs);

    await sock.sendMessage(from, { text: menu, mentions: [sender] }, { quoted: msg });
  },
};
