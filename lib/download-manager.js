"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn } = require("child_process");
const { logger } = require("../logger");
const { DOWNLOAD_DIR, DOWNLOAD_CACHE_TTL } = require("../config");
const { retryWithBackoff, handleAPIError } = require("./error-handler");
const {
  ensureYtdlp,
  getYtdlp,
  getBinPath,
  getCommonArgs,
  FFMPEG_PATH,
  fluentFfmpeg,
} = require("./ytdlp-manager");

if (!fs.existsSync(DOWNLOAD_DIR))
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const _cache = new Map();

function _cacheKey(url, quality, audio) {
  return `${url}::${quality}::${audio}`;
}

function _getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (!fs.existsSync(entry.filePath)) {
    _cache.delete(key);
    return null;
  }
  return entry;
}

function _putCache(key, filePath) {
  const existing = _cache.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    _safeDelete(filePath);
    _cache.delete(key);
  }, DOWNLOAD_CACHE_TTL);
  timer.unref();

  _cache.set(key, { filePath, timer });
}

function _safeDelete(filePath) {
  if (filePath)
    try {
      fs.unlinkSync(filePath);
    } catch { }
}

function cleanOldDownloads() {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) return;
    const cutoff = Date.now() - DOWNLOAD_CACHE_TTL;
    const cachedPaths = new Set([..._cache.values()].map((e) => e.filePath));
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      const fp = path.join(DOWNLOAD_DIR, f);
      try {
        if (!cachedPaths.has(fp) && fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
        }
      } catch { }
    }
  } catch { }
}
cleanOldDownloads();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
setInterval(cleanOldDownloads, CACHE_TTL).unref();

async function getMetadata(videoUrl) {
  if (!videoUrl || typeof videoUrl !== "string") return null;
  try {
    const ready = await ensureYtdlp();
    if (!ready) {
      throw new Error("yt-dlp binary is not available yet");
    }
    const info = await getYtdlp().getVideoInfo([videoUrl, ...getCommonArgs()]);
    const mins = Math.floor((info.duration || 0) / 60);
    const secs = String((info.duration || 0) % 60).padStart(2, "0");
    return {
      title: (info.title || "Unknown").slice(0, 100),
      duration: info.duration_string || `${mins}:${secs}`,
      thumbnail: info.thumbnail || info.thumbnails?.slice(-1)[0]?.url || "",
      url: info.webpage_url || videoUrl,
      filesize: info.filesize || info.filesize_approx || 0,
      // Channel / uploader name so the quality picker can display it as a
      // sub-line above the buttons (helps users confirm they picked the
      // right video before downloading).
      channel: info.channel || info.uploader || info.uploader_id || "",
      source: info.extractor_key || info.extractor || "Media",
    };
  } catch (err) {
    logger(`[Metadata] ${err.message}`);
    return null;
  }
}

function buildFormatArgs(quality, audioOnly) {
  if (audioOnly) {
    return FFMPEG_PATH
      ? [
        "-f",
        "ba/b",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
      ]
      : ["-f", "ba/b"];
  }
  switch (quality) {
    case "hd":
      return FFMPEG_PATH
        ? [
          "-f",
          "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
          "--merge-output-format",
          "mp4",
          "--remux-video",
          "mp4",
        ]
        : ["-f", "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b"];
    case "low":
      return [
        "-f",
        "worstvideo+worstaudio/worst",
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
      ];
    default:
      return FFMPEG_PATH
        ? [
          "-f",
          "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
          "--merge-output-format",
          "mp4",
          "--remux-video",
          "mp4",
        ]
        : ["-f", "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b"];
  }
}

async function downloadAndSend(
  sock,
  from,
  url,
  siteName = "Media",
  quality = "sd",
  audioOnly = false,
  isPTT = false,
  isDocument = false,
  isGif = false,
) {
  if (!url || !url.startsWith("http")) {
    await sock.sendMessage(from, { text: "⚠️ A valid URL is required." });
    return;
  }

  const cacheKey = _cacheKey(url, quality, audioOnly);
  const cached = _getCached(cacheKey);
  if (cached) {
    logger(`[Download] Cache hit: ${path.basename(cached.filePath)}`);
    const ph = await sock.sendMessage(from, {
      text: "⚡ Sending from cache...",
    });
    try {
      await _sendFile(sock, from, cached.filePath, audioOnly, siteName, isPTT, isDocument, isGif);
      try {
        await sock.sendMessage(from, { delete: ph.key });
      } catch { }
      return;
    } catch {
      _cache.delete(cacheKey);
    }
  }

  // High-Speed Cloud Data Worker Offloading (0 MB PC Data consumption)
  const { CLOUD_WORKER_URL } = require('../config');
  if (CLOUD_WORKER_URL) {
    let workerPh = null;
    let progressTimer = null;
    try {
      workerPh = await sock.sendMessage(from, {
        text: `╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ 〕━━━━━\n┃ ⚡ *CLOUD 1 Gbps STREAMER* 🚀\n┃ 🌐 *Source:* ${siteName}\n┃ 📥 Cloud Server එකට Download වේ...\n┃ ⚡ *Speed:* 1 Gbps Datacenter Line\n┃ 💾 (ඔබගේ පරිගණකයේ Data: 0 MB!)\n╰━━━━━━━━━━━━━━━━━━━━━━`
      });

      let seconds = 0;
      const { progressBar } = require('./premium');
      progressTimer = setInterval(() => {
        seconds += 2;
        try {
          const fakePercent = Math.min(96, Math.floor(seconds * 10));
          const bar = progressBar(fakePercent, 100, 10);
          const stage = seconds < 6
            ? "📥 Server එකට 1 Gbps Line එකෙන් බාගත වේ..."
            : seconds < 12
              ? "⚙️ Codec & Audio WhatsApp සඳහා සකසමින් පවතී..."
              : "📤 WhatsApp වෙත Stream වෙමින් පවතී...";

          const editMsg =
            `╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ 〕━━━━━\n` +
            `┃ ⚡ *CLOUD 1 Gbps STREAMER* 🚀\n` +
            `┃ 🌐 *Source:* ${siteName}\n` +
            `┃ 📊 *Progress:* ${fakePercent}%\n` +
            `┃ ${bar}\n` +
            `┃ 🔄 *Status:* ${stage}\n` +
            `┃ ⏱️ *Elapsed:* ${seconds}s | ⚡ 1 Gbps Line\n` +
            `┃ 💾 (ඔබගේ Data: 0 MB!)\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━`;
          sock.sendMessage(from, { text: editMsg, edit: workerPh.key }).catch(() => {});
        } catch (_) {}
      }, 2500);

      const { offloadMediaToWorker } = require('./cloud-worker');
      const offloadRes = await offloadMediaToWorker({
        targetJid: from,
        downloadUrl: url,
        fileName: `${siteName}_${Date.now()}.${audioOnly ? (isPTT ? 'opus' : 'mp3') : 'mp4'}`,
        caption: `🎬 *${siteName} Media*\n⚡ *Speed:* 1 Gbps High-Speed Stream Engine\n💾 *Saved PC Data: 100% (0 MB PC Data)*`,
        mimetype: audioOnly ? (isPTT ? 'audio/ogg; codecs=opus' : 'audio/mpeg') : 'video/mp4',
        document: isDocument,
        audioOnly: Boolean(audioOnly),
        isPTT: Boolean(isPTT)
      });

      if (progressTimer) clearInterval(progressTimer);

      if (offloadRes.offloaded) {
        try {
          await sock.sendMessage(from, {
            text: `╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ 〕━━━━━\n┃ ⚡ *CLOUD 1 Gbps STREAMER* 🚀\n┃ ✅ Download & Process Complete!\n┃ 🚀 Media එක ඔබ වෙත එවනු ලැබේ...\n╰━━━━━━━━━━━━━━━━━━━━━━`,
            edit: workerPh.key
          }).catch(() => {});
          setTimeout(() => {
            sock.sendMessage(from, { delete: workerPh.key }).catch(() => {});
          }, 1500);
        } catch (_) {}
        logger(`[Download] Successfully offloaded ${siteName} media to Cloud Worker (0 MB PC Data)!`);
        return;
      }

      const errMsg = String(offloadRes.error || '');
      if (errMsg.includes('410') || errMsg.includes('Gone') || errMsg.includes('removed') || errMsg.includes('deleted')) {
        try { await sock.sendMessage(from, { delete: workerPh.key }); } catch (_) {}
        await sock.sendMessage(from, {
          text: `╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ 〕━━━━━\n┃ ⚠️ *VIDEO REMOVED / EXPIRED (410)*\n┃ මෙම වීඩියෝව අදාළ වෙබ් අඩවියෙන්\n┃ ඉවත් කර ඇත (Deleted).\n┃ කරුණාකර වෙනත් වීඩියෝවක් තෝරන්න.\n╰━━━━━━━━━━━━━━━━━━━━━━`
        });
        return;
      }

      logger(`[Download] Cloud worker offload fallback to local: ${offloadRes.error || offloadRes.reason}`);
      try { await sock.sendMessage(from, { delete: workerPh.key }); } catch (_) {}
    } catch (e) {
      if (progressTimer) clearInterval(progressTimer);
      logger(`[Download] Cloud worker offload attempt failed: ${e.message}`);
      if (workerPh) {
        try { await sock.sendMessage(from, { delete: workerPh.key }); } catch (_) {}
      }
    }
  }

  const chain = audioOnly
    ? ["audio"]
    : quality === "hd"
      ? ["hd", "sd", "low", "audio"]
      : quality === "low"
        ? ["low", "audio"]
        : ["sd", "low", "audio"];

  let ph = await sock.sendMessage(from, {
    text: `⏳ Preparing ${audioOnly ? "audio" : quality.toUpperCase()} download from *${siteName}*...`,
  });

  for (let i = 0; i < chain.length; i++) {
    const q = chain[i];
    const isAudio = q === "audio";
    const label = isAudio ? "Audio" : q.toUpperCase();

    if (i > 0) {
      try {
        await sock.sendMessage(from, {
          edit: ph.key,
          text: `🔄 Trying fallback: ${label}...`,
        });
      } catch { }
    }

    let downloadedFile = null;
    try {
      downloadedFile = await _runDownload(
        sock,
        ph,
        from,
        url,
        isAudio ? "sd" : q,
        isAudio,
      );

      if (!isAudio && FFMPEG_PATH) {
        const ext = path.extname(downloadedFile).toLowerCase();

        if (ext !== ".mp4") {
          // Only re-encode if it's an unsupported container
          try {
            await sock.sendMessage(from, {
              edit: ph.key,
              text: `⚙️ Converting format for WhatsApp...`,
            });
          } catch { }
          downloadedFile = await _compress(downloadedFile, false);
        }
      }

      const sizeMB = (fs.statSync(downloadedFile).size / (1024 * 1024)).toFixed(1);
      try {
        await sock.sendMessage(from, {
          edit: ph.key,
          text: `✅ Sending *${sizeMB}MB*...`,
        });
      } catch { }

      await _sendFile(sock, from, downloadedFile, isAudio, siteName, isPTT, isDocument, isGif);
      _putCache(cacheKey, downloadedFile);

      setTimeout(() => {
        try {
          sock.sendMessage(from, { delete: ph.key });
        } catch { }
      }, 1500);
      return;
    } catch (err) {
      logger(`[Download] ${label} failed: ${err.message}`);
      _safeDelete(downloadedFile);
      if (i === chain.length - 1) {
        const friendlyErr = handleAPIError(err, "Download");
        try {
          await sock.sendMessage(from, {
            edit: ph.key,
            text: `❌ All download attempts failed.\n\n*Reason:* ${friendlyErr.message}`,
          });
        } catch { }
      }
    }
  }
}

async function _runDownload(sock, ph, from, url, quality, audioOnly) {
  const ready = await ensureYtdlp();
  if (!ready) {
    throw new Error("yt-dlp binary is not available for downloads");
  }

  const uid = `${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const outputTemplate = path.join(DOWNLOAD_DIR, `${uid}.%(ext)s`);

  const formatArgs = buildFormatArgs(quality, audioOnly);
  const args = [
    url,
    ...getCommonArgs(),
    ...(FFMPEG_PATH ? ["--ffmpeg-location", FFMPEG_PATH] : []),
    ...formatArgs,
    "--no-playlist",
    "--no-cache-dir",
    "--concurrent-fragments",
    "5",
    "--buffer-size",
    "64k",
    "--no-part",
    "--quiet",
    "--no-warnings",
    "--no-check-certificate",
    "--geo-bypass",
    "--socket-timeout",
    "30",
    "--newline",
    "--extractor-args",
    "youtube:player_client=android,web",
    "--postprocessor-args",
    "ffmpeg:-movflags +faststart",
    "-o",
    outputTemplate,
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "-R",
    "3",
  ];

  let lastUpdate = 0;
  const binPath = getBinPath();
  const child = spawn(binPath, args, { windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });

  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  rl.on("line", (line) => {
    const m = line.match(
      /\[download\]\s+([\d.]+)%.*?at\s+([\w./]+).*?ETA\s+([\d:]+)/,
    );
    if (m && Date.now() - lastUpdate > 3500) {
      lastUpdate = Date.now();
      const p = parseFloat(m[1]);
      const { progressBar } = require("./premium");
      const bar = progressBar(p, 100, 12);
      sock
        .sendMessage(from, {
          edit: ph.key,
          text: `📥 *Downloading...*\n\n${bar}  *${p}%*\n⚡ *Speed:* ${m[2]}\n⏳ *ETA:* ${m[3]}`,
        })
        .catch(() => { });
    }
  });

  await new Promise((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (stderrOutput) {
        logger(`[yt-dlp] stderr (exit ${code}): ${stderrOutput}`);
      }
      if (code === 127) {
        return reject(new Error("yt-dlp: python3 not found — install python3 on your server"));
      }
      const detail = stderrOutput ? `: ${stderrOutput.split("\n")[0]}` : "";
      return reject(new Error(`yt-dlp exited with code ${code}${detail}`));
    });
    child.on("error", reject);
    setTimeout(() => {
      child.kill();
      reject(new Error("Download timeout (10 min)"));
    }, 600000);
  });

  const exts = ["mp4", "mp3", "m4a", "webm", "mkv", "ogg", "opus"];
  for (const ext of exts) {
    const fp = path.join(DOWNLOAD_DIR, `${uid}.${ext}`);
    if (fs.existsSync(fp)) return fp;
  }
  const files = fs.readdirSync(DOWNLOAD_DIR);
  const match = files.find((f) => f.startsWith(uid) && !f.endsWith(".part"));
  if (match) return path.join(DOWNLOAD_DIR, match);
  throw new Error("Downloaded file not found after completion");
}

async function _compress(inputPath, isLarge = true) {
  const outputPath = inputPath.replace(/\.\w+$/, `_${Date.now()}_c.mp4`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Compression timeout")),
      1800000,
    );
    const options = [
      "-crf 26",
      "-preset ultrafast",
      "-tune fastdecode",
      "-profile:v high",
      "-level 4.1",
      "-pix_fmt yuv420p",
      "-movflags +faststart",
      "-threads 0",
    ];
    if (isLarge) options.push("-vf scale=trunc(iw/2)*2:720");

    fluentFfmpeg(inputPath)
      .videoCodec("libx264")
      .outputOptions(options)
      .audioCodec("aac")
      .audioBitrate("192k")
      .output(outputPath)
      .on("end", () => {
        clearTimeout(timeout);
        resolve();
      })
      .on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      })
      .run();
  });
  _safeDelete(inputPath);
  return outputPath;
}

async function _faststartOnly(inputPath) {
  const outputPath = inputPath.replace(/\.\w+$/, `_${Date.now()}_f.mp4`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Faststart timeout")),
      600000,
    );
    fluentFfmpeg(inputPath)
      .outputOptions(["-c copy", "-movflags +faststart"])
      .output(outputPath)
      .on("end", () => {
        clearTimeout(timeout);
        resolve();
      })
      .on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      })
      .run();
  });
  _safeDelete(inputPath);
  return outputPath;
}

async function _toOpus(inputPath) {
  const outputPath = inputPath.replace(/\.\w+$/, `_${Date.now()}_o.ogg`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Opus conversion timeout")), 300000);
    fluentFfmpeg(inputPath)
      .noVideo()
      .audioCodec("libopus")
      .audioBitrate("128k")
      .format("ogg")
      .outputOptions(["-avoid_negative_ts make_zero"])
      .output(outputPath)
      .on("end", () => {
        clearTimeout(timeout);
        resolve();
      })
      .on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      })
      .run();
  });
  _safeDelete(inputPath);
  return outputPath;
}

async function _sendFile(sock, from, filePath, audioOnly, siteName, isPTT = false, isDocument = false, isGif = false) {
  if (!fs.existsSync(filePath)) throw new Error("File not found");
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);

  const caption = `🎬 *${siteName}* | ${sizeMB}MB`;

  if (audioOnly) {
    if (isPTT) {
      filePath = await _toOpus(filePath);
    }
    const currentExt = path.extname(filePath).toLowerCase();
    const mime = currentExt === ".mp3" ? "audio/mpeg" : currentExt === ".m4a" ? "audio/mp4" : "audio/ogg; codecs=opus";

    if (isDocument) {
      await sock.sendMessage(from, {
        document: { url: filePath },
        mimetype: mime,
        fileName: `${siteName}_${Date.now()}${currentExt}`,
        caption,
      });
    } else {
      await sock.sendMessage(from, {
        audio: { url: filePath },
        mimetype: mime,
        ptt: isPTT,
      });
    }
  } else if (isDocument || parseFloat(sizeMB) > 64 || ext === ".webm" || ext === ".mkv") {
    logger(`[SendFile] Video Document Mode: isDocument=${isDocument}, size=${sizeMB}MB`);
    await sock.sendMessage(from, {
      document: { url: filePath },
      mimetype: "video/mp4",
      fileName: `${siteName}_${Date.now()}${ext}`,
      caption,
    });
  } else {
    logger(`[SendFile] Standard Video Mode`);
    await sock.sendMessage(from, {
      video: { url: filePath },
      mimetype: "video/mp4",
      caption,
      gifPlayback: isGif,
    });
  }

  setTimeout(() => _safeDelete(filePath), 3000);
}

module.exports = { getMetadata, downloadAndSend };
