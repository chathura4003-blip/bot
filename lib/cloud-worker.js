'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const appState = require('../state');
const config = require('../config');
const { logger } = require('../logger');

/**
 * Cloud Data Worker & Offloaded Media Dispatcher
 * Allows local bot to offload heavy 1.7GB downloads/uploads to a cloud instance
 * with 0 local data consumption.
 */

function verifyWorkerAuth(req) {
  const secret = config.WORKER_SECRET || config.JWT_SECRET || config.ADMIN_PASS;
  const authHeader = req.headers['authorization'] || '';
  const customHeader = req.headers['x-worker-secret'] || '';

  if (customHeader && customHeader === secret) return true;
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === secret) return true;
  if (config.ADMIN_PASS && (customHeader === config.ADMIN_PASS || authHeader.slice(7) === config.ADMIN_PASS)) return true;

  return false;
}

function createMediaPayload({ mediaUrl, cleanFileName, caption, mimetype, document = false, audioOnly = false, isPTT = false, sizeBytes = 0 }) {
  const sizeMB = sizeBytes ? sizeBytes / (1024 * 1024) : 0;
  const isAudio = Boolean(audioOnly || (mimetype && mimetype.startsWith('audio/')));

  // WhatsApp strictly limits in-chat playable videos to 64MB. Videos > 64MB sent as videoMessage
  // cause WhatsApp mobile client to fail with: "This video is not available because something is wrong with the video file".
  // Files > 64MB are automatically routed as Document messages (supports up to 2GB).
  const forceDocument = Boolean(document || (!isAudio && sizeMB > 64));

  if (forceDocument) {
    const sizeNote = sizeMB > 64 ? `\n\n📦 *Size:* ${sizeMB.toFixed(1)} MB\n_(WhatsApp 64MB වීඩියෝ සීමාව ඉක්මවූ බැවින් Document ලෙස එවන ලදී)_` : '';
    return {
      document: { url: mediaUrl },
      mimetype: mimetype || 'video/mp4',
      fileName: cleanFileName,
      caption: (caption || '') + sizeNote
    };
  }
  if (isAudio) {
    return {
      audio: { url: mediaUrl },
      mimetype: isPTT ? 'audio/ogg; codecs=opus' : (mimetype || 'audio/mpeg'),
      ptt: Boolean(isPTT)
    };
  }
  return {
    video: { url: mediaUrl },
    mimetype: mimetype || 'video/mp4',
    caption: caption || ''
  };
}

const { workerMetrics } = require('./worker-metrics');
const { getWorkerDashboardHTML } = require('./worker-dashboard-html');

function setupWorkerRoutes(app) {
  // Live Dashboard & Telemetry Endpoints
  app.get('/api/worker/stats', (req, res) => {
    return res.json(workerMetrics.getSnapshot());
  });

  app.get('/worker-speed-monitor', (req, res) => {
    return res.send(getWorkerDashboardHTML());
  });

  app.post('/api/worker/upload-media', async (req, res) => {
    let taskId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      if (!verifyWorkerAuth(req)) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid worker secret' });
      }

      const { targetJid, downloadUrl, fileName, caption, mimetype, document = true, audioOnly = false, isPTT = false } = req.body;
      if (!targetJid || !downloadUrl) {
        return res.status(400).json({ success: false, error: 'targetJid and downloadUrl are required' });
      }

      const isAudio = Boolean(audioOnly || (mimetype && mimetype.startsWith('audio/')) || (fileName && /\.(mp3|m4a|ogg|opus|wav)$/i.test(fileName)));
      const defaultExt = isAudio ? (isPTT ? '.opus' : '.mp3') : '.mp4';
      const cleanFileName = (fileName || `download${defaultExt}`).replace(/[^\w\s.-]/g, '_');
      const tempPath = path.join(config.DOWNLOAD_DIR, `worker_${Date.now()}_${cleanFileName}`);
      const downloadStartTime = Date.now();
      let lastKnownSpeed = '1 Gbps Datacenter Line';

      workerMetrics.startTask({
        taskId,
        fileName: cleanFileName,
        sourceUrl: downloadUrl,
        targetJid,
        mode: isAudio ? (isPTT ? 'Voice Note' : 'Audio MP3') : 'Video MP4'
      });

      logger(`[Cloud Worker] Starting offloaded ${isAudio ? 'audio' : 'video'} task for ${targetJid}: ${fileName || 'media'}`);
      logger(`[Cloud Worker] Source: ${downloadUrl}`);

      let finalDownloadUrl = downloadUrl;
      const pdMatch = downloadUrl.match(/pixeldrain\.com\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/i);
      if (pdMatch && pdMatch[1]) {
        finalDownloadUrl = `https://pixeldrain.com/api/file/${pdMatch[1]}`;
        logger(`[Cloud Worker] Converted Pixeldrain URL to direct binary stream URL: ${finalDownloadUrl}`);
      }

      const { isMegaUrl, downloadMegaFile } = require('./mega-downloader');
      const isDirectStream = /pixeldrain\.com\/api\/file|workers\.dev|ddl\.sinhalasub|usersdrive|mediafire|\.(mp4|mkv|zip|rar|mp3|webm|m4a|ogg)(\?.*)?$/i.test(finalDownloadUrl);

      if (isMegaUrl(finalDownloadUrl)) {
        logger(`[Cloud Worker] Detected Mega.nz URL. Downloading via Mega engine...`);
        await downloadMegaFile(finalDownloadUrl, tempPath);
      } else if (isDirectStream) {
        logger(`[Cloud Worker] 🚀 Starting 1 Gbps Direct Binary Stream from: ${finalDownloadUrl}`);
        // High-speed direct media download
        const response = await axios({
          method: 'GET',
          url: finalDownloadUrl,
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          },
          timeout: 900000 // 15 minutes timeout for 1.7GB
        });

        let downloadedBytes = 0;
        const totalLength = parseInt(response.headers['content-length'] || '0', 10);
        response.data.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const pct = totalLength > 0 ? Math.min(99, Math.round((downloadedBytes / totalLength) * 100)) : 0;
          workerMetrics.updateTaskProgress(taskId, {
            percent: pct,
            speed: '1 Gbps Stream',
            sizeBytes: downloadedBytes
          });
        });

        const writer = fs.createWriteStream(tempPath);
        await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      } else {
        // Platform media extractor (YouTube, TikTok, FB, IG, etc.)
        logger(`[Cloud Worker] Detected platform URL (${isAudio ? 'Audio mode' : 'Video mode'}). Extracting and streaming via yt-dlp...`);
        const { getBinPath, getCommonArgs, ensureYtdlp, FFMPEG_PATH } = require('./ytdlp-manager');
        const { spawn } = require('child_process');
        await ensureYtdlp();

        const binPath = getBinPath();
        const args = isAudio
          ? [
              ...getCommonArgs(),
              ...(FFMPEG_PATH ? ['--ffmpeg-location', FFMPEG_PATH] : []),
              '--no-playlist',
              '--no-cache-dir',
              '--no-check-certificates',
              '--geo-bypass',
              '--concurrent-fragments', '16',
              '--buffer-size', '16M',
              '--http-chunk-size', '10M',
              '-x',
              '--audio-format', isPTT ? 'opus' : 'mp3',
              '--audio-quality', '0',
              '--no-part',
              '-o', tempPath,
              '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              '-R', '3',
              '--',
              downloadUrl
            ]
          : [
              ...getCommonArgs(),
              ...(FFMPEG_PATH ? ['--ffmpeg-location', FFMPEG_PATH] : []),
              '--no-playlist',
              '--no-cache-dir',
              '--no-check-certificates',
              '--geo-bypass',
              '--concurrent-fragments', '16',
              '--buffer-size', '16M',
              '--http-chunk-size', '10M',
              '--hls-use-mpegts',
              '--extractor-args', 'youtube:player_client=android,web',
              // Prioritize H.264 (AVC) and AAC for maximum WhatsApp mobile playback compatibility
              '-f', 'bestvideo[vcodec^=avc][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
              '--merge-output-format', 'mp4',
              '--remux-video', 'mp4',
              '--postprocessor-args', 'ffmpeg:-movflags +faststart',
              '--no-part',
              '-o', tempPath,
              '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              '-R', '3',
              '--',
              downloadUrl
            ];

        let stderrOutput = '';
        let lastSpeedLog = 0;
        const child = spawn(binPath, args, { windowsHide: true });

        if (child.stdout) {
          const readline = require('readline');
          const rl = readline.createInterface({ input: child.stdout });
          rl.on('line', (line) => {
            const m = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\w./]+).*?ETA\s+([\d:]+)/);
            if (m) {
              const percent = m[1];
              const speed = m[2];
              const eta = m[3];
              lastKnownSpeed = speed;
              workerMetrics.updateTaskProgress(taskId, { percent, speed, eta });
              if (Date.now() - lastSpeedLog > 3000) {
                lastSpeedLog = Date.now();
                logger(`[Cloud 1Gbps] ⚡ Download: ${percent}% | Speed: ${speed} | ETA: ${eta}`);
              }
            }
          });
        }

        if (child.stderr) {
          child.stderr.on('data', (d) => { stderrOutput += d.toString(); });
        }

        await new Promise((resolve, reject) => {
          child.on('close', (code) => {
            // Clean up any remaining temporary fragment chunks
            try {
              const dir = path.dirname(tempPath);
              const base = path.basename(tempPath, path.extname(tempPath));
              const fragments = fs.readdirSync(dir).filter(f => f.startsWith(base) && (f.includes('-Frag') || f.endsWith('.part') || f.endsWith('.ytdl')));
              for (const frag of fragments) {
                try { fs.unlinkSync(path.join(dir, frag)); } catch (_) { }
              }
            } catch (_) { }

            if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 1024) {
              return resolve();
            }
            const dir = path.dirname(tempPath);
            const base = path.basename(tempPath, path.extname(tempPath));
            const match = fs.readdirSync(dir).find((f) =>
              f.startsWith(base) &&
              !f.endsWith('.part') &&
              !f.includes('-Frag') &&
              !f.endsWith('.ytdl') &&
              (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm') || f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.opus') || f.endsWith('.ogg')) &&
              fs.statSync(path.join(dir, f)).size > 1024
            );
            if (match) {
              const foundPath = path.join(dir, match);
              fs.renameSync(foundPath, tempPath);
              return resolve();
            }
            logger(`[Cloud Worker] yt-dlp stderr: ${stderrOutput.slice(-300)}`);
            reject(new Error(`Cloud yt-dlp failed (code ${code}): ${stderrOutput.slice(-200) || 'Video unavailable'}`));
          });
          child.on('error', reject);
        });
      }

      const elapsedSec = Math.max(0.1, (Date.now() - downloadStartTime) / 1000).toFixed(1);
      const finalSizeBytes = fs.statSync(tempPath).size;
      const finalSizeMB = (finalSizeBytes / (1024 * 1024)).toFixed(1);
      const avgSpeed = (finalSizeMB / elapsedSec).toFixed(1);
      logger(`[Cloud 1Gbps] ✅ Download Complete: ${finalSizeMB} MB in ${elapsedSec}s (Avg Speed: ${avgSpeed} MB/s | Peak: ${lastKnownSpeed})`);

      workerMetrics.finishTask(taskId, {
        success: true,
        finalSizeBytes,
        elapsedSec,
        avgSpeed: `${avgSpeed} MB/s`
      });

      // Free browser memory and trigger GC before transfer
      try {
        const { browserPool } = require('./browser-pool');
        await browserPool.closeBrowser();
      } catch (_) { }
      if (global.gc) {
        try { global.gc(); } catch (_) { }
      }

      const isDoc = Boolean(document || finalSizeBytes > 64 * 1024 * 1024);
      const mediaType = isDoc ? 'document' : (isAudio ? 'audio' : 'video');

      // 1. Direct Cloud-to-WhatsApp MMS Upload (0 MB downloaded or uploaded through Local PC)
      if (req.body.mediaConn) {
        try {
          const { uploadDirectToWhatsAppMMS } = require('./cloud-mms-uploader');
          logger(`[Cloud Worker] 🚀 Starting Pure Cloud Direct Upload to WhatsApp MMS...`);
          const mmsRes = await uploadDirectToWhatsAppMMS({
            filePath: tempPath,
            mediaType,
            mediaConn: req.body.mediaConn,
            taskId
          });

          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { }

          return res.json({
            success: true,
            directUpload: true,
            directPath: mmsRes.directPath,
            url: mmsRes.url,
            mediaKey: mmsRes.mediaKey,
            fileSha256: mmsRes.fileSha256,
            fileEncSha256: mmsRes.fileEncSha256,
            fileLength: mmsRes.fileLength,
            fileName: cleanFileName,
            mimetype: mimetype || (isAudio ? (isPTT ? 'audio/ogg; codecs=opus' : 'audio/mpeg') : 'video/mp4'),
            caption: caption || '',
            isAudio,
            isPTT: Boolean(isPTT),
            document: isDoc
          });
        } catch (mmsErr) {
          logger(`[Cloud Worker] Direct MMS upload fallback to streaming: ${mmsErr.message}`);
        }
      }

      const sock = appState.getSocket();
      if (!sock || !sock.user) {
        // Fallback Stream Mode: Return high-speed stream link to PC bot.
        const host = req.get('host') || 'zippy-energy-production-92e4.up.railway.app';
        const proto = req.get('x-forwarded-proto') || 'https';
        const finalMime = mimetype || (isAudio ? (isPTT ? 'audio/ogg; codecs=opus' : 'audio/mpeg') : 'video/mp4');
        const streamUrl = `${proto}://${host}/api/worker/stream/${encodeURIComponent(cleanFileName)}?file=${encodeURIComponent(tempPath)}&mimetype=${encodeURIComponent(finalMime)}`;
        logger(`[Cloud Worker] Ready in Pure Worker mode. Stream URL generated for ${cleanFileName}`);
        return res.json({
          success: true,
          mode: 'stream',
          streamUrl,
          fileName: cleanFileName,
          size: finalSizeBytes,
          isAudio,
          isPTT: Boolean(isPTT),
          document: isDoc
        });
      }

      // Dispatch to WhatsApp from Cloud Bot if socket is connected
      const payload = createMediaPayload({
        mediaUrl: tempPath,
        cleanFileName,
        caption,
        mimetype,
        document: Boolean(document),
        audioOnly: isAudio,
        isPTT: Boolean(isPTT),
        sizeBytes: finalSizeBytes
      });

      try {
        await sock.sendMessage(targetJid, payload);
        logger(`[Cloud Worker] Offloaded upload completed successfully for ${targetJid}!`);
      } finally {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { }
        if (global.gc) {
          try { global.gc(); } catch (_) { }
        }
      }

      return res.json({ success: true, message: 'Uploaded successfully via Cloud Worker' });
    } catch (err) {
      workerMetrics.finishTask(taskId, {
        success: false,
        error: err.message
      });
      logger(`[Cloud Worker] Error processing offload request: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // High-speed direct streaming endpoint with HTTP Range support for WhatsApp / Baileys
  app.all('/api/worker/stream/:filename', (req, res) => {
    const filePath = req.query.file;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Stream file not found or expired' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const mimeType = req.query.mimetype || 'video/mp4';
    const range = req.headers.range;

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes'
      });
      return res.end();
    }

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const fileStream = fs.createReadStream(filePath, { start, end, highWaterMark: 1024 * 1024 });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${req.params.filename || 'media.mp4'}"`
      });

      fileStream.on('data', (chunk) => {
        workerMetrics.recordStreamActivity(chunk.length, '1 Gbps Pipe');
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${req.params.filename || 'media.mp4'}"`
      });

      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('data', (chunk) => {
        workerMetrics.recordStreamActivity(chunk.length, '1 Gbps Pipe');
      });
      stream.pipe(res);
    }
  });

  // Session Sync endpoint: exports session files from cloud
  app.get('/api/worker/session-sync', (req, res) => {
    if (!verifyWorkerAuth(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid worker secret' });
    }

    const sessionDir = config.SESSION_DIR;
    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ success: false, error: 'No session directory found' });
    }

    const files = fs.readdirSync(sessionDir);
    const sessionData = {};
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          sessionData[f] = fs.readFileSync(path.join(sessionDir, f), 'utf8');
        } catch (_) { }
      }
    }

    return res.json({ success: true, count: Object.keys(sessionData).length, sessionData });
  });

  // Session Push endpoint: imports session files from local PC and connects Cloud Bot
  app.post('/api/worker/session-push', async (req, res) => {
    if (!verifyWorkerAuth(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid worker secret' });
    }

    const { sessionData } = req.body;
    if (!sessionData || typeof sessionData !== 'object') {
      return res.status(400).json({ success: false, error: 'sessionData object is required' });
    }

    const sessionDir = config.SESSION_DIR;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    let count = 0;
    for (const [filename, content] of Object.entries(sessionData)) {
      if (typeof filename === 'string' && filename.endsWith('.json')) {
        fs.writeFileSync(path.join(sessionDir, filename), String(content));
        count++;
      }
    }

    logger(`[Cloud Worker] Received ${count} session files from Local PC!`);
    return res.json({ success: true, message: `Imported ${count} session files.` });
  });

  // Health check endpoint for worker
  app.get('/api/worker/status', (req, res) => {
    const isAuth = verifyWorkerAuth(req);
    const sock = appState.getSocket();
    return res.json({
      workerAvailable: true,
      botConnected: Boolean(sock),
      botNumber: appState.getNumber() || 'connected',
      authenticated: isAuth
    });
  });
}

/**
 * Sync active WhatsApp session credentials from Railway Cloud to Local PC
 */
async function syncSessionFromCloud() {
  const workerUrl = (config.CLOUD_WORKER_URL || process.env.CLOUD_WORKER_URL || '').trim();
  if (!workerUrl) return false;

  const secret = config.WORKER_SECRET || process.env.WORKER_SECRET || config.JWT_SECRET || config.ADMIN_PASS;
  const endpoint = `${workerUrl.replace(/\/$/, '')}/api/worker/session-sync`;

  try {
    const res = await axios.get(endpoint, {
      headers: { 'x-worker-secret': secret },
      timeout: 15000
    });

    if (res.data && res.data.success && res.data.sessionData) {
      const sessionDir = config.SESSION_DIR;
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      let written = 0;
      for (const [filename, content] of Object.entries(res.data.sessionData)) {
        fs.writeFileSync(path.join(sessionDir, filename), content);
        written++;
      }
      if (written > 0) {
        logger(`[Session Sync] Successfully synced ${written} session files from Cloud Server!`);
        return true;
      }
    }
  } catch (err) {
    // Non-fatal if cloud session not available yet
  }
  return false;
}

/**
 * Client-side function used by local bot to offload upload to Cloud Worker
 */
async function offloadMediaToWorker({ targetJid, downloadUrl, fileName, caption, mimetype, document = true, audioOnly = false, isPTT = false, quoted = null }) {
  const workerUrl = (config.CLOUD_WORKER_URL || process.env.CLOUD_WORKER_URL || '').trim();
  if (!workerUrl) {
    return { offloaded: false, reason: 'CLOUD_WORKER_URL is not configured' };
  }

  const secret = config.WORKER_SECRET || process.env.WORKER_SECRET || config.JWT_SECRET || config.ADMIN_PASS;
  const endpoint = `${workerUrl.replace(/\/$/, '')}/api/worker/upload-media`;
  const appState = require('../state');
  const localSock = appState.getSocket();

  let mediaConn = null;
  if (localSock && typeof localSock.refreshMediaConn === 'function') {
    try {
      mediaConn = await localSock.refreshMediaConn(false);
    } catch (_) { }
  }

  try {
    logger(`[Local Bot] Offloading media upload to Cloud Worker: ${endpoint}`);
    const res = await axios.post(
      endpoint,
      { targetJid, downloadUrl, fileName, caption, mimetype, document, audioOnly, isPTT, mediaConn },
      {
        headers: {
          'x-worker-secret': secret,
          'Content-Type': 'application/json'
        },
        timeout: 900000 // 15 minutes timeout
      }
    );

    if (res.data && res.data.success) {
      // Option 1: Direct Cloud MMS Upload (0 MB local data consumed!)
      if (res.data.directUpload && localSock) {
        logger(`[Local Bot] 🚀 Pure Cloud Upload confirmed! Relaying 1KB message to WhatsApp (0 MB Local PC data)...`);
        const isDoc = Boolean(document !== undefined ? document : res.data.document);
        const isAudio = Boolean(audioOnly || res.data.isAudio || (mimetype && mimetype.startsWith('audio/')));
        const isVoice = Boolean(isPTT || res.data.isPTT);

        const mediaContent = isDoc
          ? {
              documentMessage: {
                url: res.data.url || `https://mmg.whatsapp.net${res.data.directPath}`,
                mimetype: res.data.mimetype || 'video/mp4',
                title: res.data.fileName || fileName,
                fileSha256: Buffer.from(res.data.fileSha256, 'base64'),
                fileLength: res.data.fileLength,
                mediaKey: Buffer.from(res.data.mediaKey, 'base64'),
                fileName: res.data.fileName || fileName,
                fileEncSha256: Buffer.from(res.data.fileEncSha256, 'base64'),
                directPath: res.data.directPath,
                caption: caption || ''
              }
            }
          : isAudio
            ? {
                audioMessage: {
                  url: res.data.url || `https://mmg.whatsapp.net${res.data.directPath}`,
                  mimetype: res.data.mimetype || (isVoice ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
                  fileSha256: Buffer.from(res.data.fileSha256, 'base64'),
                  fileLength: res.data.fileLength,
                  seconds: res.data.seconds || 0,
                  ptt: isVoice,
                  mediaKey: Buffer.from(res.data.mediaKey, 'base64'),
                  fileEncSha256: Buffer.from(res.data.fileEncSha256, 'base64'),
                  directPath: res.data.directPath
                }
              }
            : {
                videoMessage: {
                  url: res.data.url || `https://mmg.whatsapp.net${res.data.directPath}`,
                  mimetype: res.data.mimetype || 'video/mp4',
                  fileSha256: Buffer.from(res.data.fileSha256, 'base64'),
                  fileLength: res.data.fileLength,
                  mediaKey: Buffer.from(res.data.mediaKey, 'base64'),
                  fileEncSha256: Buffer.from(res.data.fileEncSha256, 'base64'),
                  directPath: res.data.directPath,
                  caption: caption || ''
                }
              };

        const baileys = require('@whiskeysockets/baileys');
        const userJid = localSock.user?.id || undefined;
        const wam = baileys.generateWAMessageFromContent(
          targetJid,
          mediaContent,
          { userJid, quoted: quoted || undefined }
        );
        await localSock.relayMessage(targetJid, wam.message, { messageId: wam.key.id });
        logger(`[Local Bot] ✅ Pure Cloud Upload completed successfully! 0 MB downloaded to PC.`);
        return { offloaded: true, mode: 'direct_mms', result: res.data };
      }

      // Option 2: Fallback High-Speed Stream Mode
      if (res.data.mode === 'stream' && res.data.streamUrl) {
        logger(`[Local Bot] Cloud Worker generated high-speed stream URL. Streaming to WhatsApp...`);
        if (localSock) {
          const isAudio = Boolean(audioOnly || res.data.isAudio || (mimetype && mimetype.startsWith('audio/')));
          const isDoc = Boolean(document !== undefined ? document : res.data.document);
          const isVoice = Boolean(isPTT || res.data.isPTT);

          const payload = createMediaPayload({
            mediaUrl: res.data.streamUrl,
            cleanFileName: fileName || res.data.fileName,
            caption: caption || '',
            mimetype: mimetype,
            document: isDoc,
            audioOnly: isAudio,
            isPTT: isVoice,
            sizeBytes: res.data.size || 0
          });
          await localSock.sendMessage(targetJid, payload, { quoted: quoted || undefined });
          return { offloaded: true, mode: 'stream', result: res.data };
        }
      }
      return { offloaded: true, result: res.data };
    }
    return { offloaded: false, error: res.data?.error || 'Worker returned failure' };
  } catch (err) {
    logger(`[Local Bot] Cloud Worker request failed: ${err.message}`);
    return { offloaded: false, error: err.response?.data?.error || err.message };
  }
}

/**
 * Push local PC session credentials to Railway Cloud Worker so Cloud Bot connects automatically
 */
async function pushSessionToCloud() {
  const workerUrl = (config.CLOUD_WORKER_URL || process.env.CLOUD_WORKER_URL || '').trim();
  if (!workerUrl) return false;

  const secret = config.WORKER_SECRET || process.env.WORKER_SECRET || config.JWT_SECRET || config.ADMIN_PASS;
  const endpoint = `${workerUrl.replace(/\/$/, '')}/api/worker/session-push`;

  const sessionDir = config.SESSION_DIR;
  if (!fs.existsSync(sessionDir)) return false;

  const files = fs.readdirSync(sessionDir);
  const sessionData = {};
  for (const f of files) {
    if (f.endsWith('.json')) {
      try {
        sessionData[f] = fs.readFileSync(path.join(sessionDir, f), 'utf8');
      } catch (_) { }
    }
  }

  if (Object.keys(sessionData).length === 0) return false;

  try {
    const res = await axios.post(
      endpoint,
      { sessionData },
      {
        headers: {
          'x-worker-secret': secret,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    if (res.data && res.data.success) {
      logger(`[Session Push] Successfully synced local WhatsApp session to Cloud Worker!`);
      return true;
    }
  } catch (err) {
    logger(`[Session Push] Cloud session sync notice: ${err.message}`);
  }
  return false;
}

module.exports = {
  setupWorkerRoutes,
  initCloudWorker: setupWorkerRoutes,
  offloadMediaToWorker,
  syncSessionFromCloud,
  pushSessionToCloud
};
