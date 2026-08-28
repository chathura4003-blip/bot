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

      const sock = appState.getSocket();
      if (!sock || !sock.user) {
        return res.status(503).json({ success: false, error: 'Cloud Bot is not connected to WhatsApp. Please scan QR in the Cloud Dashboard.' });
      }

      logger(`[Cloud Worker] Starting offloaded upload for ${targetJid}: ${fileName || 'media'}`);
      logger(`[Cloud Worker] Source: ${downloadUrl}`);

      const cleanFileName = (fileName || 'download.mp4').replace(/[^\w\s.-]/g, '_');
      const tempPath = path.join(config.DOWNLOAD_DIR, `worker_${Date.now()}_${cleanFileName}`);

      // High-speed cloud download
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

      logger(`[Cloud Worker] Download complete (${fs.statSync(tempPath).size} bytes). Uploading to WhatsApp...`);

      // Dispatch to WhatsApp
      const payload = document
        ? { document: { url: tempPath }, mimetype: mimetype || 'video/mp4', fileName: cleanFileName, caption: caption || '' }
        : { video: { url: tempPath }, mimetype: mimetype || 'video/mp4', caption: caption || '' };

      await sock.sendMessage(targetJid, payload);

      // Clean up temp file
      try { fs.unlinkSync(tempPath); } catch (_) {}

      logger(`[Cloud Worker] Offloaded upload completed successfully for ${targetJid}!`);
      return res.json({ success: true, message: 'Uploaded successfully via Cloud Worker' });
    } catch (err) {
      logger(`[Cloud Worker] Error processing offload request: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Session Sync endpoint: exports session files to local PC
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
      return { offloaded: true, result: res.data };
    }
    return { offloaded: false, error: res.data?.error || 'Worker returned failure' };
  } catch (err) {
    logger(`[Local Bot] Cloud Worker request failed: ${err.message}`);
    return { offloaded: false, error: err.response?.data?.error || err.message };
  }
}

module.exports = {
  setupWorkerRoutes,
  offloadMediaToWorker,
  syncSessionFromCloud
};
