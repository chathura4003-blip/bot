'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { googleDrive } = require('./lib/drive/google-drive');
const { movieScraper } = require('./lib/extractors/movie-scraper');
const { mediaExtractor } = require('./lib/extractors/media-extractor');
const { adultExtractor } = require('./lib/extractors/adult-extractor');
const { transferEngine } = require('./lib/transfer/transfer-engine');
const { logger } = require('./logger');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io Real-time Progress Broadcasts
io.on('connection', (socket) => {
  // Send current tasks immediately upon connection
  socket.emit('initTasks', transferEngine.getTasks());

  socket.on('disconnect', () => {});
});

transferEngine.on('taskUpdated', (task) => {
  io.emit('taskUpdated', task);
});

transferEngine.on('cleared', () => {
  io.emit('initTasks', transferEngine.getTasks());
});

// ================= API ROUTES ================= //

// 1. Status & Settings
app.get('/api/status', (req, res) => {
  res.json({
    app: 'Cloud-to-Drive Leech & Downloader',
    version: '2.0.0',
    gdrive: googleDrive.getStatus(),
    activeTasks: transferEngine.getTasks().filter(t => t.status === 'transferring').length
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

// 2. Movie Hub Endpoints
app.post('/api/movies/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Search query is required.' });
    
    const results = await movieScraper.searchMovies(query);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/movies/details', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Movie URL is required.' });

    const details = await movieScraper.getMovieDetails(url);
    res.json({ success: true, details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Media Extractor Endpoints
app.post('/api/media/extract', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Media URL is required.' });

    const info = await mediaExtractor.extractInfo(url);
    res.json({ success: true, info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. 18+ Adult Video Endpoints
app.post('/api/adult/search', async (req, res) => {
  try {
    const { query, page } = req.body;
    const results = await adultExtractor.searchVideos(query || 'trending', page || 1);
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

// 5. Transfer Management
app.post('/api/transfer/start', async (req, res) => {
  try {
    const { title, url, type, quality, folderId } = req.body;
    if (!url) return res.status(400).json({ error: 'Target URL is required.' });

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

// Catch-all route to serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  logger.info(`🚀 Cloud-to-Drive Leech App is running on http://localhost:${PORT}`);
});
