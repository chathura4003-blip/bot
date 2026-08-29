'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');
const { googleDrive } = require('./lib/drive/google-drive');
const { movieScraper } = require('./lib/extractors/movie-scraper');
const { mediaExtractor } = require('./lib/extractors/media-extractor');
const { adultExtractor } = require('./lib/extractors/adult-extractor');
const { transferEngine } = require('./lib/transfer/transfer-engine');
const { downloadManager } = require('./lib/download/download-manager');

process.on('uncaughtException', (err) => {
  console.error('[Server Safe Guard] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server Safe Guard] Unhandled Rejection:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.emit('initTasks', transferEngine.getTasks());
  socket.emit('initDownloads', downloadManager.getAll());
  socket.on('disconnect', () => {});
});

transferEngine.on('taskUpdated', (task) => {
  io.emit('taskUpdated', task);
});

transferEngine.on('cleared', () => {
  io.emit('initTasks', transferEngine.getTasks());
});

downloadManager.on('updated', (item) => {
  io.emit('downloadUpdated', item);
});

downloadManager.on('deleted', (id) => {
  io.emit('downloadDeleted', id);
});

// APIs
app.get('/api/status', (req, res) => {
  res.json({
    app: 'Cloud-to-Drive Leech Mobile',
    version: '2.0.0',
    gdrive: googleDrive.getStatus(),
    activeTasks: transferEngine.getTasks().filter(t => t.status === 'transferring').length,
    activeDownloads: downloadManager.getAll().filter(d => d.status === 'downloading').length
  });
});

app.post('/api/gdrive/config', (req, res) => {
  try {
    const { authType, serviceAccount, oauth2, defaultFolderId } = req.body;
    if (authType === 'service_account') {
      googleDrive.setServiceAccount(serviceAccount, true);
    } else if (authType === 'oauth2') {
      googleDrive.setOAuth2(oauth2, true);
    }

    if (defaultFolderId) {
      googleDrive.setDefaultFolder(defaultFolderId);
    }

    res.json({ success: true, status: googleDrive.getStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const BUILTIN_OAUTH_CLIENT_ID = process.env.GDRIVE_CLIENT_ID || '';
const BUILTIN_OAUTH_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || '';

// Generate Google Login URL (1-Click Google OAuth)
app.post('/api/gdrive/oauth/url', (req, res) => {
  try {
    const host = req.get('host') || `localhost:${PORT}`;
    // Google OAuth ONLY allows 'http://localhost:PORT' or 'http://127.0.0.1:PORT' for local web & native redirect URIs
    const redirectUri = `http://localhost:${PORT}/api/gdrive/oauth2callback`;
    const clientId = req.body.clientId || process.env.GDRIVE_CLIENT_ID || BUILTIN_OAUTH_CLIENT_ID;
    const clientSecret = req.body.clientSecret || process.env.GDRIVE_CLIENT_SECRET || BUILTIN_OAUTH_CLIENT_SECRET;
    const authUrl = googleDrive.getAuthUrl(clientId, clientSecret, redirectUri, host);
    res.json({ success: true, authUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth2 Callback Handler
let lastOAuthParams = { clientId: process.env.GDRIVE_CLIENT_ID || BUILTIN_OAUTH_CLIENT_ID, clientSecret: process.env.GDRIVE_CLIENT_SECRET || BUILTIN_OAUTH_CLIENT_SECRET };

app.post('/api/gdrive/oauth/prepare', (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (clientId) lastOAuthParams.clientId = clientId;
  if (clientSecret) lastOAuthParams.clientSecret = clientSecret;
  res.json({ success: true });
});

app.get('/api/gdrive/oauth2callback', async (req, res) => {
  try {
    if (req.query.error) {
      let msg = req.query.error;
      if (req.query.error === 'access_denied') {
        msg = 'Access was denied. Please make sure to check and allow Google Drive permissions on the consent screen.';
      } else if (req.query.error === 'redirect_uri_mismatch') {
        msg = 'Redirect URI mismatch! In Google Cloud Console, add Authorized redirect URI: http://localhost:5000/api/gdrive/oauth2callback';
      }
      throw new Error(msg);
    }

    const code = req.query.code;
    if (!code) throw new Error('Authorization code was not provided by Google callback.');

    let clientId = '';
    let clientSecret = '';
    let returnHost = '';

    if (req.query.state) {
      try {
        const stateObj = JSON.parse(Buffer.from(req.query.state, 'base64').toString('utf8'));
        clientId = stateObj.clientId;
        clientSecret = stateObj.clientSecret;
        returnHost = stateObj.returnHost;
      } catch (e) {}
    }

    if (!clientId) clientId = process.env.GDRIVE_CLIENT_ID || BUILTIN_OAUTH_CLIENT_ID;
    if (!clientSecret || !clientSecret.startsWith('GOCSPX-')) {
      clientSecret = process.env.GDRIVE_CLIENT_SECRET || BUILTIN_OAUTH_CLIENT_SECRET;
    }

    const redirectUri = `http://localhost:${PORT}/api/gdrive/oauth2callback`;

    await googleDrive.exchangeOAuthCode({
      code,
      clientId,
      clientSecret,
      redirectUri
    });

    if (returnHost && !returnHost.includes('localhost') && !returnHost.includes('127.0.0.1')) {
      res.redirect(`http://${returnHost}/?gdrive_linked=true`);
    } else {
      res.redirect('/?gdrive_linked=true');
    }
  } catch (err) {
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Google Drive Link Setup</title>
        <style>
          body { background: #0b0f17; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #131a26; border: 1px solid rgba(0, 242, 254, 0.3); border-radius: 16px; padding: 28px; max-width: 520px; width: 100%; box-shadow: 0 15px 40px rgba(0,0,0,0.6); }
          h2 { color: #00f2fe; margin-top: 0; font-size: 1.25rem; }
          p { color: #cbd5e1; line-height: 1.5; font-size: 0.92rem; }
          .notice-box { background: rgba(255, 71, 87, 0.1); border-left: 4px solid #ff4757; padding: 12px; border-radius: 4px; margin: 15px 0; color: #ff6b81; font-size: 0.88rem; }
          .code-box { background: #000; color: #00f2fe; padding: 10px 14px; border-radius: 8px; font-family: monospace; word-break: break-all; margin: 12px 0; font-size: 0.82rem; user-select: all; }
          .btn { display: inline-block; background: linear-gradient(135deg, #00f2fe, #4facfe); color: #000; font-weight: 700; text-decoration: none; padding: 10px 22px; border-radius: 30px; margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Google Account Link Notice</h2>
          <div class="notice-box">${err.message}</div>
          <p>Redirect URI configured: <div class="code-box">http://localhost:5000/api/gdrive/oauth2callback</div></p>
          <a href="/" class="btn">⬅️ Back to App</a>
        </div>
      </body>
      </html>
    `);
  }
});

app.get('/api/gdrive/about', async (req, res) => {
  try {
    const about = await googleDrive.getAbout();
    res.json({ success: true, ...about });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gdrive/test', async (req, res) => {
  try {
    const testResult = await googleDrive.testConnection();
    res.json(testResult);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/gdrive/disconnect', (req, res) => {
  googleDrive.disconnect();
  res.json({ success: true });
});

app.get('/api/gdrive/folders', async (req, res) => {
  try {
    const folders = await googleDrive.listFolders(req.query.parentId || 'root');
    res.json({ success: true, folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gdrive/files', async (req, res) => {
  try {
    const files = await googleDrive.listFiles({ folderId: req.query.folderId });
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file from Google Drive
app.post('/api/gdrive/delete', async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });
    const result = await googleDrive.deleteFile(fileId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Movie Search
app.post('/api/movies/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Search query required.' });
    const results = await movieScraper.searchMovies(query);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/movies/details', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Movie URL required.' });
    const details = await movieScraper.getMovieDetails(url);
    res.json({ success: true, details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/movies/resolve', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Movie URL required.' });
    const resolved = await movieScraper.resolveFinalDownloadUrl(url);
    res.json({ success: true, streamUrl: resolved.streamUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct Binary File Downloader (0 External Redirects)
app.get('/api/download', async (req, res) => {
  try {
    const { url, title } = req.query;
    if (!url) return res.status(400).send('URL required');

    let targetUrl = url;
    let fileName = (title || 'video_download').replace(/[/\\?%*:|"<>]/g, '_');
    if (!fileName.includes('.')) fileName += '.mp4';

    let axiosHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };

    // 1. If adult URL, resolve direct video stream
    if (url.includes('pornhub.com') || url.includes('xvideos.com') || url.includes('xnxx.com') || url.includes('eporner.com') || url.includes('redtube.com')) {
      try {
        const resolved = await adultExtractor.resolveStream(url);
        targetUrl = resolved.downloadUrl || resolved.streamUrl || url;
        if (resolved.title) fileName = resolved.title.replace(/[/\\?%*:|"<>]/g, '_') + '.mp4';
      } catch (e) {}
    } else if (url.includes('filespayouts.com') || url.includes('filespayout.com') || url.includes('sinhalasub') || url.includes('baiscope')) {
      const resolved = await movieScraper.resolveFinalDownloadUrl(url);
      targetUrl = resolved.streamUrl || url;
      if (resolved.headers) axiosHeaders = { ...axiosHeaders, ...resolved.headers };
    }

    const streamRes = await axios.get(targetUrl, {
      responseType: 'stream',
      headers: axiosHeaders,
      timeout: 30000
    });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    if (streamRes.headers['content-type']) res.setHeader('Content-Type', streamRes.headers['content-type']);
    if (streamRes.headers['content-length']) res.setHeader('Content-Length', streamRes.headers['content-length']);

    streamRes.data.pipe(res);
  } catch (err) {
    res.status(500).send('Direct Download Error: ' + err.message);
  }
});

// Media Extractor
app.post('/api/media/extract', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Media URL required.' });
    const info = await mediaExtractor.extractInfo(url);
    res.json({ success: true, info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 18+ Adult Extractor
app.post('/api/adult/search', async (req, res) => {
  try {
    const { query, page, source } = req.body;
    const results = await adultExtractor.searchVideos(query || 'popular', page || 1, source || 'all');
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/adult/details', async (req, res) => {
  try {
    const { url } = req.body;
    const details = await adultExtractor.getVideoDetails(url);
    res.json({ success: true, details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/adult/resolve', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const resolved = await adultExtractor.resolveStream(url);
    res.json({ success: true, resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/adult/related', async (req, res) => {
  try {
    const { query } = req.body;
    const results = await adultExtractor.searchVideos(query || 'popular', 1, 'all');
    res.json({ success: true, results: results.slice(0, 24) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transfer APIs
app.post('/api/transfer/start', async (req, res) => {
  try {
    const { title, url, type, quality, folderId } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required.' });
    const task = await transferEngine.startTransfer({
      title,
      url,
      type: type || 'media',
      quality,
      folderId
    });
    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transfer/tasks', (req, res) => {
  res.json({ success: true, tasks: transferEngine.getTasks() });
});

app.post('/api/transfer/cancel', (req, res) => {
  const { taskId } = req.body;
  const ok = transferEngine.cancelTask(taskId);
  res.json({ success: ok });
});

app.post('/api/transfer/clear', (req, res) => {
  transferEngine.clearCompleted();
  res.json({ success: true });
});

// ================= Download Manager APIs (Pause / Resume / Delete / Stream) ================= //
app.post('/api/downloads/start', async (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const item = await downloadManager.startDownload(url, title);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/downloads/pause', async (req, res) => {
  try {
    const { id } = req.body;
    const ok = await downloadManager.pauseDownload(id);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/downloads/resume', async (req, res) => {
  try {
    const { id } = req.body;
    const ok = await downloadManager.resumeDownload(id);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/downloads/delete', async (req, res) => {
  try {
    const { id, deleteFile } = req.body;
    const ok = await downloadManager.deleteDownload(id, deleteFile !== false);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/downloads/list', (req, res) => {
  res.json({ success: true, downloads: downloadManager.getAll() });
});

app.get('/api/downloads/file/:id', (req, res) => {
  const fs = require('fs');
  const item = downloadManager.get(req.params.id);
  if (!item || !fs.existsSync(item.filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(item.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(item.filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(item.fileName)}"`
    };
    res.writeHead(200, head);
    fs.createReadStream(item.filePath).pipe(res);
  }
});

// Health & Worker Status API
app.get('/health', (req, res) => {
  const { getBinPath, FFMPEG_PATH } = require('../lib/ytdlp-manager');
  res.json({
    status: 'online',
    service: 'Cloud-to-Drive Mobile Engine',
    uptime: `${Math.floor(process.uptime())}s`,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    ytDlpAvailable: fs.existsSync(getBinPath()),
    ffmpegAvailable: Boolean(FFMPEG_PATH),
    gdriveConnected: Boolean(googleDrive.tokens && googleDrive.tokens.access_token)
  });
});

app.get('/api/worker/health', async (req, res) => {
  const { cloudWorkerClient } = require('./lib/worker/cloud-worker-client');
  const health = await cloudWorkerClient.checkHealth();
  res.json(health);
});

// Periodic cleanup of orphaned temp files (every 10 minutes - worker style)
setInterval(() => {
  try {
    const dir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      // Delete temp/fragment files older than 30 minutes
      if (now - stats.mtimeMs > 30 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (_) {}
  if (global.gc) {
    try { global.gc(); } catch (_) {}
  }
}, 10 * 60 * 1000);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const os = require('os');

function getLocalIpAddresses() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', async () => {
  const ips = getLocalIpAddresses();
  const memUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`\n======================================================`);
  console.log(`🚀 CLOUD-TO-DRIVE HIGH-SPEED ENGINE READY`);
  console.log(`⚡ 1 Gbps Stream Engine Ready | Memory: ~${memUsed}MB`);
  console.log(`💻 PC Localhost:   http://localhost:${PORT}`);
  ips.forEach(ip => {
    console.log(`📱 Phone (Wi-Fi):  http://${ip}:${PORT}`);
  });
  console.log(`======================================================\n`);

  // Pre-warm yt-dlp binary in background (worker style)
  const { ensureYtdlp, getBinPath } = require('../lib/ytdlp-manager');
  ensureYtdlp().then(() => {
    console.log(`[Cloud Engine] ✅ yt-dlp binary verified at: ${getBinPath()}`);
  }).catch((e) => {
    console.log(`[Cloud Engine] ⚠️ yt-dlp pre-warm warning: ${e.message}`);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Cloud Engine] Received SIGINT. Shutting down cleanly...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('\n[Cloud Engine] Received SIGTERM. Shutting down cleanly...');
  server.close(() => process.exit(0));
});
