"use strict";

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
process.env.CHMD_ENV_PRELOADED = 'true';
process.env.WORKER_ONLY = 'true';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { logger } = require('./logger');
const { initCloudWorker } = require('./lib/cloud-worker');
const { ensureYtdlp, getBinPath, FFMPEG_PATH } = require('./lib/ytdlp-manager');

const app = express();
const server = http.createServer(app);

// Enable JSON body parsing for worker requests
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Ensure downloads directory exists
if (!fs.existsSync(config.DOWNLOAD_DIR)) {
  fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'CHATHU-MD Cloud Media Worker',
    mode: 'Pure Stream Worker (0 MB PC Data)',
    uptime: `${Math.floor(process.uptime())}s`,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    ytDlpAvailable: fs.existsSync(getBinPath()),
    ffmpegAvailable: Boolean(FFMPEG_PATH)
  });
});

// Initialize Cloud Worker API endpoints
initCloudWorker(app);

// Periodic cleanup of orphaned temp files (every 10 minutes)
setInterval(() => {
  try {
    const dir = config.DOWNLOAD_DIR;
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      // Delete temp/fragment files older than 15 minutes
      if (now - stats.mtimeMs > 15 * 60 * 1000) {
        fs.unlinkSync(filePath);
        logger(`[Worker Cleanup] Removed stale temp file: ${file}`);
      }
    }
  } catch (_) {}
  if (global.gc) {
    try { global.gc(); } catch (_) {}
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, async () => {
  logger(`[Cloud Worker] 🚀 High-Speed Pure Media Worker running on http://${HOST}:${PORT}`);
  logger(`[Cloud Worker] ⚡ 1 Gbps Stream Engine Ready | Memory: ~${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  
  // Pre-warm yt-dlp binary in background
  ensureYtdlp().then(() => {
    logger(`[Cloud Worker] ✅ yt-dlp binary verified at: ${getBinPath()}`);
  }).catch((e) => {
    logger(`[Cloud Worker] ⚠️ yt-dlp pre-warm warning: ${e.message}`);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger('[Cloud Worker] Received SIGINT. Shutting down cleanly...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  logger('[Cloud Worker] Received SIGTERM. Shutting down cleanly...');
  server.close(() => process.exit(0));
});
