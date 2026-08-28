"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { fluentFfmpeg } = require("../ytdlp-manager");
const { sendReact, extractQuotedContext, getRealMessage } = require("../utils");
const msgMgr = require("../message-manager");
const { logger } = require("../../logger");

module.exports = {
  name: "sticker",
  aliases: ["st", "s"],
  description: "Convert image/video to sticker",
  category: "sticker",

  async execute(sock, msg, from, args, cmdName) {
    const real = getRealMessage(msg);
    const quoted = extractQuotedContext(msg);
    const qMsg = quoted.quotedMsg;

    const imgMsg = qMsg?.imageMessage || real?.imageMessage;
    const vidMsg = qMsg?.videoMessage || real?.videoMessage;
    const type = imgMsg ? "image" : vidMsg ? "video" : null;
    const target = imgMsg || vidMsg;

    if (!target || !type) {
      await msgMgr.sendTemp(sock, from, "⚠️ Reply to an image or video to create a sticker.", 6000);
      return;
    }

    await sendReact(sock, from, msg, "🎨");

    const uid = Date.now();
    const inExt = type === "image" ? "jpg" : "mp4";
    const tmpIn = path.join(os.tmpdir(), `stk_in_${uid}.${inExt}`);
    const tmpOut = path.join(os.tmpdir(), `stk_out_${uid}.webp`);

    try {
      const stream = await downloadContentFromMessage(target, type);
      const ws = fs.createWriteStream(tmpIn);
      for await (const chunk of stream) ws.write(chunk);
      ws.end();
      await new Promise((r) => ws.on("finish", r));

      await new Promise((resolve, reject) => {
        let cmd = fluentFfmpeg(tmpIn).outputOptions([
          "-vcodec libwebp",
          "-vf scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000",
          "-preset ultrafast",
          "-quality 75",
        ]);
        if (type === "video") {
          cmd = cmd.outputOptions(["-loop 0", "-an", "-vsync 0", "-t 6"]);
        }
        cmd.on("end", resolve).on("error", reject).save(tmpOut);
      });

      const stickerBuf = fs.readFileSync(tmpOut);
      await sock.sendMessage(from, { sticker: stickerBuf });
      await sendReact(sock, from, msg, "✅");
    } catch (err) {
      logger(`[Sticker] ${err.message}`);
      await msgMgr.sendTemp(sock, from, `❌ Sticker failed: ${err.message.slice(0, 60)}`, 6000);
      await sendReact(sock, from, msg, "❌");
    } finally {
      [tmpIn, tmpOut].forEach((f) => {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      });
    }
  },
};
