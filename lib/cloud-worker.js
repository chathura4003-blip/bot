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

function setupWorkerRoutes(app) {
  app.post('/api/worker/upload-media', async (req, res) => {
    try {
      if (!verifyWorkerAuth(req)) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid worker secret' });
      }

      const { targetJid, downloadUrl, fileName, caption, mimetype, document = true } = req.body;
      if (!targetJid || !downloadUrl) {
        return res.status(400).json({ success: false, error: 'targetJid and downloadUrl are required' });
      }

      logger(`[Cloud Worker] Starting offloaded task for ${targetJid}: ${fileName || 'media'}`);
      logger(`[Cloud Worker] Source: ${downloadUrl}`);

      const cleanFileName = (fileName || 'download.mp4').replace(/[^\w\s.-]/g, '_');
      const tempPath = path.join(config.DOWNLOAD_DIR, `worker_${Date.now()}_${cleanFileName}`);

      const { isMegaUrl, downloadMegaFile } = require('./mega-downloader');
      const isDirectStream = /pixeldrain\.com\/api\/file|workers\.dev|ddl\.sinhalasub|\.(mp4|mkv|zip|rar|mp3|webm|m4a|ogg)(\?.*)?$/i.test(downloadUrl);

      if (isMegaUrl(downloadUrl)) {
        logger(`[Cloud Worker] Detected Mega.nz URL. Downloading via Mega engine...`);
        await downloadMegaFile(downloadUrl, tempPath);
      } else if (isDirectStream) {
        // High-speed direct media download
        const response = await axios({
          method: 'GET',
          url: downloadUrl,
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          },
          timeout: 600000 // 10 minutes timeout for 1.7GB
        });

        const writer = fs.createWriteStream(tempPath);
        await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      } else {
        // Platform media extractor (YouTube, Pornhub, XNXX, XVideos, SpankBang, TikTok, FB, etc.)
        logger(`[Cloud Worker] Detected video platform URL. Extracting and streaming via yt-dlp...`);
        const { getBinPath, getCommonArgs, ensureYtdlp } = require('./ytdlp-manager');
        const { spawn } = require('child_process');
        await ensureYtdlp();

        const binPath = getBinPath();
        const args = [
          ...getCommonArgs(),
          '--no-playlist',
          '--no-cache-dir',
          '--no-check-certificates',
          '--geo-bypass',
          '--concurrent-fragments', '5',
          '--hls-use-mpegts',
          '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          '--merge-output-format', 'mp4',
          '--remux-video', 'mp4',
          '--no-part',
          '--postprocessor-args', 'ffmpeg:-movflags +faststart',
          '-o', tempPath,
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          '-R', '3',
          '--',
          downloadUrl
        ];

        let stderrOutput = '';
        const child = spawn(binPath, args, { windowsHide: true });
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
                try { fs.unlinkSync(path.join(dir, frag)); } catch (_) {}
              }
            } catch (_) {}

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
              (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm') || f.endsWith('.mp3')) && 
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

      logger(`[Cloud Worker] Download complete (${fs.statSync(tempPath).size} bytes). Uploading to WhatsApp...`);

      // Free browser memory and trigger GC before transfer
      try {
        const { browserPool } = require('./browser-pool');
        await browserPool.closeBrowser();
      } catch (_) {}
      if (global.gc) {
        try { global.gc(); } catch (_) {}
      }

      const sock = appState.getSocket();
      if (!sock || !sock.user) {
        // Pure Worker Mode: File downloaded & decrypted on Cloud. Return high-speed stream link to PC bot.
        const host = req.get('host') || 'zippy-energy-production-92e4.up.railway.app';
        const proto = req.get('x-forwarded-proto') || 'https';
        const streamUrl = `${proto}://${host}/api/worker/stream/${encodeURIComponent(cleanFileName)}?file=${encodeURIComponent(tempPath)}&mimetype=${encodeURIComponent(mimetype || 'video/mp4')}`;
        logger(`[Cloud Worker] Ready in Pure Worker mode. Stream URL generated for ${cleanFileName}`);
        return res.json({
          success: true,
          mode: 'stream',
          streamUrl,
          fileName: cleanFileName,
          size: fs.statSync(tempPath).size
        });
      }

      // Dispatch to WhatsApp from Cloud Bot if socket is connected
      const payload = document
        ? { document: { url: tempPath }, mimetype: mimetype || 'video/mp4', fileName: cleanFileName, caption: caption || '' }
        : { video: { url: tempPath }, mimetype: mimetype || 'video/mp4', caption: caption || '' };

      try {
        await sock.sendMessage(targetJid, payload);
        logger(`[Cloud Worker] Offloaded upload completed successfully for ${targetJid}!`);
      } finally {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        if (global.gc) {
          try { global.gc(); } catch (_) {}
        }
      }

      return res.json({ success: true, message: 'Uploaded successfully via Cloud Worker' });
    } catch (err) {
      logger(`[Cloud Worker] Error processing offload request: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // High-speed direct streaming endpoint for offloaded media
  app.get('/api/worker/stream/:filename', (req, res) => {
    const filePath = req.query.file;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Stream file not found or expired' });
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': req.query.mimetype || 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${req.params.filename || 'media.mp4'}"`
    });

    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.pipe(res);
    stream.on('close', () => {
      // Clean up temp file after streaming
      setTimeout(() => {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
      }, 60000);
    });
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
        } catch (_) {}
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

    logger(`[Cloud Worker] Received ${count} session files from Local PC! Initializing socket...`);

    // Auto-start Cloud Bot socket only if NOT in pure worker mode
    if (!config.WORKER_ONLY && process.env.WORKER_ONLY !== 'true') {
      try {
        const { startBot } = require('../bot');
        startBot({ forceRestart: true }).catch(() => {});
      } catch (_) {}
    }

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
async function offloadMediaToWorker({ targetJid, downloadUrl, fileName, caption, mimetype, document = true }) {
  const workerUrl = (config.CLOUD_WORKER_URL || process.env.CLOUD_WORKER_URL || '').trim();
  if (!workerUrl) {
    return { offloaded: false, reason: 'CLOUD_WORKER_URL is not configured' };
  }

  const secret = config.WORKER_SECRET || process.env.WORKER_SECRET || config.JWT_SECRET || config.ADMIN_PASS;
  const endpoint = `${workerUrl.replace(/\/$/, '')}/api/worker/upload-media`;

  try {
    logger(`[Local Bot] Offloading 1.7GB upload to Cloud Worker: ${endpoint}`);
    const res = await axios.post(
      endpoint,
      { targetJid, downloadUrl, fileName, caption, mimetype, document },
      {
        headers: {
          'x-worker-secret': secret,
          'Content-Type': 'application/json'
        },
        timeout: 900000 // 15 minutes timeout
      }
    );

    if (res.data && res.data.success) {
      if (res.data.mode === 'stream' && res.data.streamUrl) {
        logger(`[Local Bot] Cloud Worker generated high-speed stream URL. Streaming to WhatsApp...`);
        const appState = require('../state');
        const localSock = appState.getSocket();
        if (localSock) {
          const payload = document
            ? { document: { url: res.data.streamUrl }, mimetype: mimetype || 'video/mp4', fileName: fileName || res.data.fileName, caption: caption || '' }
            : { video: { url: res.data.streamUrl }, mimetype: mimetype || 'video/mp4', caption: caption || '' };
          await localSock.sendMessage(targetJid, payload);
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
      } catch (_) {}
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
