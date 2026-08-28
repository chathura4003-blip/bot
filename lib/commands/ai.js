"use strict";

const axios = require("axios");
const googleTTS = require("google-tts-api");
const translate = require("translate-google-api");
const { sendReact, presenceUpdate, truncate, downloadMediaMessage, extractQuotedContext, getRealMessage } = require("../utils");
const msgMgr = require("../message-manager");
const { logger } = require("../../logger");
const themeMgr = require("../theme-manager");
const config = require("../../config");

/**
 * AI CORE - Optimized for Chathu MD
 * Supports Gemini (Direct), OpenRouter (Fallback), and Groq.
 */

function hasGeminiKey() {
  return !!(config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim());
}

function hasOpenAiKey() {
  return !!(config.OPENAI_API_KEY && config.OPENAI_API_KEY.trim());
}

function hasGroqKey() {
  return !!(config.GROQ_API_KEY && config.GROQ_API_KEY.trim());
}

function hasOpenRouterKey() {
  return !!(config.OPENROUTER_API_KEY && config.OPENROUTER_API_KEY.trim());
}

function logProviderFailure(enabled, message) {
  if (enabled) {
    logger(message);
  }
}

function isGeminiModelNotSupported(status, errorMsg) {
  return status === 404 || /not found|not supported for generatecontent/i.test(errorMsg);
}

function isQuotaOrRateLimit(status, errorMsg) {
  return status === 429 || /quota|rate limit|billing/i.test(errorMsg);
}

/**
 * Core AI Response Generator (2026 Fast Multi-Engine)
 */
async function generateAIResponse(prompt, imageBuffer = null, mimeType = "image/jpeg", systemInstruction = "", options = {}) {
  const { quietFailures = false } = options;

  // --- 1. DIRECT GEMINI API (2026 Fast Models) ---
  if (hasGeminiKey()) {
    const models = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-flash-latest"
    ];

    for (const modelName of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

        const payload = {
          contents: [{
            parts: [{ text: (systemInstruction ? `[SYSTEM: ${systemInstruction}]\n\n` : "") + (prompt || "Hello") }]
          }]
        };

        if (imageBuffer) {
          payload.contents[0].parts.push({ inline_data: { mime_type: mimeType, data: imageBuffer.toString("base64") } });
        }

        const { data } = await axios.post(url, payload, {
          timeout: 20000,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": config.GEMINI_API_KEY,
          },
        });
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (text) {
          return { text, model: `Gemini (${modelName})` };
        }
      } catch (err) {
        const status = err.response?.status;
        const errorMsg = err.response?.data?.error?.message || err.message;
        logProviderFailure(!quietFailures, `[AI] Direct Gemini ${modelName} failed: ${errorMsg}`);
        if (isGeminiModelNotSupported(status, errorMsg)) continue;
        if (isQuotaOrRateLimit(status, errorMsg)) break;
      }
    }
  }

  // --- 2. DIRECT OPENAI API (2026 Engine) ---
  if (hasOpenAiKey()) {
    const openAiModels = ["gpt-4o-mini", "gpt-4o", "o3-mini", "gpt-3.5-turbo"];
    for (const modelId of openAiModels) {
      try {
        const messages = [];
        if (systemInstruction) {
          messages.push({ role: "system", content: systemInstruction });
        }
        if (imageBuffer) {
          messages.push({
            role: "user",
            content: [
              { type: "text", text: prompt || "Describe this image" },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBuffer.toString("base64")}` } }
            ]
          });
        } else {
          messages.push({ role: "user", content: prompt || "Hello" });
        }

        const { data } = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: modelId,
            messages,
            max_tokens: 1500,
          },
          {
            headers: {
              "Authorization": `Bearer ${config.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 20000,
          }
        );

        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) {
          return { text, model: `OpenAI (${modelId})` };
        }
      } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message;
        logProviderFailure(!quietFailures, `[AI] Direct OpenAI ${modelId} failed: ${errorMsg}`);
      }
    }
  }

  // --- 3. OPENROUTER FALLBACK ---
  if (hasOpenRouterKey()) {
    const orModels = [
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
      "openai/gpt-4o-mini"
    ];

    for (const modelId of orModels) {
      try {
        const messages = [];
        if (systemInstruction) {
          messages.push({ role: "system", content: systemInstruction });
        }
        messages.push({ role: "user", content: prompt || "Hello" });

        const { data } = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model: modelId,
            messages: messages,
          },
          {
            headers: {
              "Authorization": `Bearer ${config.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://github.com/chathura",
              "X-Title": "Chathu MD"
            },
            timeout: 25000
          }
        );

        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) {
          const modelName = modelId.split('/')[1] || modelId;
          return { text, model: `OpenRouter (${modelName})` };
        }
      } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message;
        logProviderFailure(!quietFailures, `[AI] OpenRouter ${modelId} failed: ${errorMsg}`);
      }
    }
  }

  // --- 4. GROQ FALLBACK ---
  if (!imageBuffer && hasGroqKey()) {
    const groqModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
    for (const groqModel of groqModels) {
      try {
        const messages = [];
        if (systemInstruction) messages.push({ role: "system", content: systemInstruction });
        messages.push({ role: "user", content: prompt });

        const { data } = await axios.post(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            model: groqModel,
            messages,
            max_tokens: 2048
          },
          {
            headers: {
              "Authorization": `Bearer ${config.GROQ_API_KEY}`,
              "Content-Type": "application/json"
            },
            timeout: 12000
          }
        );

        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return { text, model: `Groq (${groqModel})` };
      } catch (err) {
        logProviderFailure(!quietFailures, `[AI] Groq ${groqModel} failed: ${err.message}`);
      }
    }
  }

  // --- 5. PUBLIC BACKUP APIS ---
  if (!imageBuffer) {
    const backupUrls = [
      `https://api.bk9.site/ai/chatgpt?q=${encodeURIComponent(prompt)}`,
      `https://api.guruapi.tech/ai/gpt4?username=chathu&query=${encodeURIComponent(prompt)}`
    ];

    for (const url of backupUrls) {
      try {
        const { data } = await axios.get(url, { timeout: 8000 });
        const text = data?.result || data?.answer || data?.response;
        if (text && typeof text === "string" && text.length > 2) return { text: text.trim(), model: "Backup AI" };
      } catch (e) { }
    }
  }

  return null;
}

/**
 * Expands simple prompts for better image generation
 */
async function generateImagePrompt(prompt) {
  const expanded = await generateAIResponse(
    `Expand this into a clean, detailed AI image generation prompt. Only return the final prompt:\n\n${prompt}`
  );
  return expanded?.text || prompt;
}

/**
 * Handler for .ai / .chat commands
 */
async function handleChat(sock, msg, from, q, sender) {
  const real = getRealMessage(msg);
  const quoted = extractQuotedContext(msg);
  const qMsg = quoted.quotedMsg;
  const hasImage = !!real?.imageMessage || !!qMsg?.imageMessage;

  let imageSource = null;
  if (real?.imageMessage) {
    imageSource = { message: real };
  } else if (qMsg?.imageMessage) {
    imageSource = { message: qMsg };
  }

  await sendReact(sock, from, msg, "🤖");
  await presenceUpdate(sock, from, "composing");

  const appState = require("../../state");
  const persona = appState.getAiAutoPersona();
  const lang = appState.getAiAutoLang();
  
  const mixedStyle = " Respond in a natural, friendly WhatsApp chat style using a mix of Sinhala and English (Singlish). Use common Sri Lankan slang and informal grammar. Avoid formal or pure Sinhala. Sound like a close friend.";
  const personas = {
    'friendly': 'You are a helpful and chill friend named CHATHU MD.' + mixedStyle,
    'funny': 'You are a funny and witty friend named CHATHU MD. Use humor, memes, and emojis.' + mixedStyle,
    'savage': 'You are a savage friend named CHATHU MD. Give sharp, funny comebacks and roast the user lightly.' + mixedStyle,
    'romantic': 'You are a caring and sweet friend named CHATHU MD. Use heart emojis and caring words.' + mixedStyle,
    'professional': 'You are a helpful assistant named CHATHU MD. Keep it polite but efficient.',
    'robot': 'You are a logical AI named CHATHU MD. Use technical terms.'
  };
  const langInfo = lang === 'si' ? 'Reply mostly in Singlish (Sinhala mixed with English).' : 
                   lang === 'en' ? 'Reply in English only.' : 
                   'Reply naturally based on the user\'s language. If they use Sinhala, reply in Singlish.';
  const sysInstr = `${personas[persona] || personas.friendly} ${langInfo} Keep it natural for WhatsApp.`;

  let result;
  if (hasImage && imageSource) {
    try {
      const buffer = await downloadMediaMessage(imageSource, "buffer", {}, {
        logger: { info: () => { }, error: () => { }, warn: () => { }, debug: () => { }, trace: () => { } }
      });
      result = await generateAIResponse(q, buffer, "image/jpeg", sysInstr);
    } catch (e) {
      logger(`[AI] Image download failed: ${e.message}`);
      result = await generateAIResponse(q, null, null, sysInstr);
    }
  } else {
    result = await generateAIResponse(q, null, null, sysInstr);
  }

  if (!result?.text) {
    await sendReact(sock, from, msg, "❌");
    let errorHelp = "❌ AI සේවාවන් ක්‍රියාත්මක නොවේ.\n\n";
    errorHelp += "📍 *හේතුව:* API Quota අවසන් වීම හෝ සබඳතා බිඳ වැටීමක් විය හැක.\n";
    errorHelp += "💡 කරුණාකර නැවත උත්සාහ කරන්න.";
    return msgMgr.sendTemp(sock, from, errorHelp, 10000);
  }

  const finalMsg = `${result.text}\n\n*Generated by ${result.model}*`;

  await sock.sendMessage(
    from,
    {
      text: finalMsg,
      mentions: [sender],
      contextInfo: { isForwarded: true, forwardingScore: 999 },
    },
    { quoted: msg }
  );

  await sendReact(sock, from, msg, "✅");
}

/**
 * Handler for .img command
 */
async function handleImage(sock, msg, from, q, sender, context) {
  const prompt = q || "cat in space";
  await sendReact(sock, from, msg, "🎨");
  await presenceUpdate(sock, from, "composing");

  let finalPrompt = prompt;
  try {
    const expanded = await generateImagePrompt(prompt);
    if (expanded && expanded.length > 5) finalPrompt = expanded;
  } catch (e) { }

  const imgApis = [
    { name: "Pollinations HD", url: `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=1024&height=1024&enhance=true&nologo=true` },
    { name: "Vreden DALL-E", url: `https://api.vreden.my.id/api/ai/dalle?prompt=${encodeURIComponent(finalPrompt)}` },
    { name: "Magic Studio", url: `https://api.vreden.my.id/api/ai/magicstudio?prompt=${encodeURIComponent(finalPrompt)}` }
  ];

  let imgUrl = null;
  let modelName = "AI Generator";

  for (const api of imgApis) {
    try {
      if (api.name === "Pollinations HD") {
        imgUrl = api.url;
        modelName = api.name;
        break;
      }
      const res = await axios.get(api.url, { timeout: 15000 });
      if (res.status === 200) {
        if (res.headers['content-type']?.includes('application/json')) {
          const data = res.data;
          const extractedUrl = data.result?.url || data.result || data.url || data.image;
          if (extractedUrl && typeof extractedUrl === 'string' && extractedUrl.startsWith('http')) imgUrl = extractedUrl;
        } else {
          imgUrl = api.url;
        }
        if (imgUrl) {
          modelName = api.name;
          break;
        }
      }
    } catch (e) { }
  }

  if (!imgUrl) {
    await sendReact(sock, from, msg, "❌");
    return msgMgr.sendTemp(sock, from, "❌ HD පින්තූරය සෑදීමට නොහැකි වුණා.", 6000);
  }

  await sock.sendMessage(from, { image: { url: imgUrl }, caption: `🎨 *AI IMAGE GENERATED*\n\n✨ *Prompt:* ${prompt}\n🧩 *Model:* ${modelName}\n\n*CHATHU MD*`, mentions: [sender] }, { quoted: msg });
  await sendReact(sock, from, msg, "✅");
}

/**
 * Handler for .translate command
 */
async function handleTranslate(sock, msg, from, q, sender, context) {
  const quoted = extractQuotedContext(msg);
  const textToTranslate = q || quoted.text;

  if (!textToTranslate) return msgMgr.sendTemp(sock, from, "⚠️ පරිවර්තනය කිරීමට මැසේජ් එකක් reply කරන්න.", 5000);

  const ownerRefs = context.owner ? [context.owner] : [];
  const tCtx = { sender, ownerRefs };
  await sendReact(sock, from, msg, "🔠");

  let translated = null;
  const aiRes = await generateAIResponse(`Translate this text into Sinhala (or English if already Sinhala). Only output the result:\n\n${textToTranslate}`);
  translated = aiRes?.text;

  if (!translated) {
    try {
      const gres = await translate(textToTranslate, { to: "si" });
      translated = gres[0];
    } catch (e) { }
  }

  if (!translated) {
    await sendReact(sock, from, msg, "❌");
    return msgMgr.sendTemp(sock, from, "❌ පරිවර්තනය අසාර්ථකයි.", 6000);
  }

  let reply = themeMgr.format("header", { title: "TRANSLATION" }, tCtx);
  reply += "\n" + themeMgr.format("box_start", { title: "TRANSLATED TEXT" }, tCtx);
  reply += themeMgr.format("box_item", { bullet: "creative", content: truncate(translated, 3000) }, tCtx);
  reply += themeMgr.format("box_end", {}, tCtx);
  reply += themeMgr.getSignature(sender, ownerRefs);

  await sock.sendMessage(from, { text: reply, mentions: [sender] }, { quoted: msg });
  await sendReact(sock, from, msg, "✅");
}

// Disambiguating an opt-in language prefix from common English words is hard
// (`.tts hi there` legitimately means "hi there" in English, but `hi` is also
// the Hindi language code). Require an explicit `lang:` suffix instead so the
// language is opt-in and never accidentally swallows a real word.
const TTS_LANG_RE = /^\s*([a-z]{2}(?:-[A-Z]{2})?):\s*([\s\S]+)$/;

async function handleTTS(sock, msg, from, q, sender) {
  const quoted = extractQuotedContext(msg);
  let lang = "en";
  let text = q;

  // Allow `.tts si: සිංහල පෙළ` to choose the language explicitly.
  const langMatch = q.match(TTS_LANG_RE);
  if (langMatch) {
    lang = langMatch[1];
    text = langMatch[2];
  }
  if (!text) text = quoted.text;

  if (!text) {
    return msgMgr.sendTemp(sock, from, "🔊 Usage: `.tts <text>` or `.tts si: <සිංහල පෙළ>` (or reply to a message).", 6000);
  }

  await sendReact(sock, from, msg, "🔊");
  try {
    const url = googleTTS.getAudioUrl(text.slice(0, 200), {
      lang,
      slow: false,
      host: "https://translate.google.com",
    });
    await sock.sendMessage(
      from,
      { audio: { url }, mimetype: "audio/mp4", ptt: true, mentions: [sender] },
      { quoted: msg },
    );
    await sendReact(sock, from, msg, "✅");
  } catch (e) {
    logger(`[TTS] ${e.message}`);
    await sendReact(sock, from, msg, "❌");
    await msgMgr.sendTemp(sock, from, `❌ TTS failed: ${e.message}`, 6000);
  }
}

module.exports = {
  name: "ai",
  aliases: ["chat", "gpt", "bot", "trt", "translate", "img", "tts"],
  description: "AI chat, translation & TTS powered by Gemini & OpenRouter",
  category: "creative",
  generateAIResponse,

  async execute(sock, msg, from, args, name, context) {
    const q = args.join(" ");
    const sender = msg.key.participant || msg.key.remoteJid || from;
    const quoted = extractQuotedContext(msg);
    const real = getRealMessage(msg);

    if (name === "img") return handleImage(sock, msg, from, q, sender, context);
    if (name === "trt" || name === "translate") return handleTranslate(sock, msg, from, q, sender, context);
    if (name === "tts") return handleTTS(sock, msg, from, q, sender);

    const hasQuotedText = !!quoted.text;
    const hasImage = !!(real?.imageMessage || quoted.quotedMsg?.imageMessage);

    if (!q && !hasImage && !hasQuotedText) return msgMgr.sendTemp(sock, from, "👋 ආයුබෝවන්! මට උදව් කළ හැකි දේ දැනගැනීමට .help ai බලන්න.", 8000);

    try {
      const effectiveQ = q || quoted.text || "";
      await handleChat(sock, msg, from, effectiveQ, sender);
    } catch (e) {
      await sendReact(sock, from, msg, "❌");
      await msgMgr.sendTemp(sock, from, `❌ Error: ${e.message}`, 7000);
    }
  },

  async validateKeys() {
    const results = { gemini: false, openrouter: false, groq: false };
    
    // Gemini Check
    if (hasGeminiKey()) {
      try {
        const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.GEMINI_API_KEY}`, { timeout: 5000 });
        if (res.status === 200) results.gemini = true;
      } catch (e) { results.gemini = false; }
    }

    // OpenRouter Check
    if (hasOpenRouterKey()) {
      try {
        const res = await axios.get("https://openrouter.ai/api/v1/auth/key", {
          headers: { "Authorization": `Bearer ${config.OPENROUTER_API_KEY}` },
          timeout: 5000
        });
        if (res.status === 200) results.openrouter = true;
      } catch (e) { results.openrouter = false; }
    }

    // Groq Check
    if (hasGroqKey()) {
      try {
        const res = await axios.get("https://api.groq.com/openai/v1/models", {
          headers: { "Authorization": `Bearer ${config.GROQ_API_KEY}` },
          timeout: 5000
        });
        if (res.status === 200) results.groq = true;
      } catch (e) { results.groq = false; }
    }

    return results;
  }
};
