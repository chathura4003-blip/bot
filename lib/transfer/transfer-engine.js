'use strict';

const { EventEmitter } = require('events');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('crypto').randomUUID ? { v4: require('crypto').randomUUID } : { v4: () => Math.random().toString(36).substring(2, 11) };
const { googleDrive } = require('../drive/google-drive');
const { movieScraper } = require('../extractors/movie-scraper');
const { mediaExtractor } = require('../extractors/media-extractor');
const { adultExtractor } = require('../extractors/adult-extractor');
const { getYtDlp } = require('../ytdlp-manager');
const { logger } = require('../../logger');

class TransferEngine extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.history = [];
  }

  getTasks() {
    return Array.from(this.tasks.values()).reverse();
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  /**
   * Start a new Cloud ➔ Google Drive transfer task
   */
  async startTransfer({ title, url, type = 'media', quality = 'HD', folderId }) {
    const taskId = 'task_' + Math.random().toString(36).substring(2, 10);
    const abortController = new AbortController();

    const task = {
      id: taskId,
      title: title || 'Media Cloud Download',
      sourceUrl: url,
      type, // 'movie' | 'media' | 'nsfw' | 'direct'
      quality,
      folderId: folderId || googleDrive.defaultFolderId,
      status: 'queued', // queued | resolving | transferring | completed | failed | cancelled
      percent: 0,
      speedMBps: '0.00',
      uploadedMB: '0.0',
      totalMB: '0.0',
      etaSec: 0,
      driveResult: null,
      error: null,
      createdAt: new Date().toISOString(),
      abortController
    };

    this.tasks.set(taskId, task);
    this.emitChange(task);

    // Execute in background
    this.processTask(task).catch(err => {
      task.status = 'failed';
      task.error = err.message;
      this.emitChange(task);
      logger.error(`[TransferEngine] Task ${taskId} error:`, err);
    });

    return task;
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (task && (task.status === 'queued' || task.status === 'resolving' || task.status === 'transferring')) {
      task.abortController?.abort();
      task.status = 'cancelled';
      task.error = 'Cancelled by user';
      this.emitChange(task);
      return true;
    }
    return false;
  }

  clearCompleted() {
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(id);
      }
    }
    this.emit('cleared');
  }

  emitChange(task) {
    this.emit('taskUpdated', {
      id: task.id,
      title: task.title,
      type: task.type,
      status: task.status,
      percent: task.percent,
      speedMBps: task.speedMBps,
      uploadedMB: task.uploadedMB,
      totalMB: task.totalMB,
      etaSec: task.etaSec,
      driveResult: task.driveResult,
      error: task.error,
      createdAt: task.createdAt
    });
  }

  async processTask(task) {
    task.status = 'resolving';
    this.emitChange(task);

    let targetUrl = task.sourceUrl;
    let fileName = (task.title || 'cloud_file').replace(/[/\\?%*:|"<>]/g, '_');
    let mimeType = 'video/mp4';

    // 1. Resolve final download link based on type
    if (task.type === 'movie') {
      const resolved = await movieScraper.resolveFinalDownloadUrl(targetUrl);
      targetUrl = resolved.streamUrl;
      if (!fileName.endsWith('.mp4') && !fileName.endsWith('.mkv')) {
        fileName += '.mp4';
      }
    } else if (task.type === 'nsfw') {
      if (targetUrl.includes('eporner.com') || targetUrl.includes('xvideos.com')) {
        const details = await adultExtractor.getVideoDetails(targetUrl);
        if (details.qualities?.[0]?.downloadUrl) {
          targetUrl = details.qualities[0].downloadUrl;
        }
        if (details.title) fileName = details.title.replace(/[/\\?%*:|"<>]/g, '_') + '.mp4';
      }
    }

    task.status = 'transferring';
    this.emitChange(task);

    // 2. Stream probe & download stream acquisition
    let stream;
    let sizeBytes = 0;

    // Check if target is a direct streamable HTTP/HTTPS URL
    try {
      const head = await axios.head(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 12000,
        signal: task.abortController.signal
      }).catch(() => null);

      if (head?.headers) {
        sizeBytes = parseInt(head.headers['content-length'] || '0', 10);
        if (head.headers['content-type']) mimeType = head.headers['content-type'];
        
        const cd = head.headers['content-disposition'];
        if (cd && cd.includes('filename=')) {
          const m = cd.match(/filename=["']?([^"';]+)["']?/i);
          if (m && m[1]) fileName = m[1];
        }
      }

      const getRes = await axios.get(targetUrl, {
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 0,
        signal: task.abortController.signal
      });

      stream = getRes.data;
    } catch (err) {
      // If direct stream failed, fallback to yt-dlp stream
      logger.info(`[TransferEngine] Direct stream failed (${err.message}), trying yt-dlp...`);
      const ytdlp = await getYtDlp();
      stream = ytdlp.execStream([targetUrl, '-f', 'bestvideo+bestaudio/best', '--no-playlist']);
      if (!fileName.includes('.')) fileName += '.mp4';
    }

    if (!fileName.includes('.')) {
      fileName += mimeType.includes('audio') ? '.mp3' : '.mp4';
    }

    task.title = fileName;
    task.totalMB = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(1) : 'Live Stream';

    // 3. Upload stream directly to Google Drive
    const driveResult = await googleDrive.uploadStream({
      stream,
      fileName,
      mimeType,
      sizeBytes,
      folderId: task.folderId,
      abortSignal: task.abortController.signal,
      onProgress: (p) => {
        task.percent = p.percent;
        task.speedMBps = p.speedMBps;
        task.uploadedMB = (p.uploadedBytes / (1024 * 1024)).toFixed(1);
        task.totalMB = p.totalBytes > 0 ? (p.totalBytes / (1024 * 1024)).toFixed(1) : task.uploadedMB;
        task.etaSec = p.etaSec;
        this.emitChange(task);
      }
    });

    task.status = 'completed';
    task.percent = 100;
    task.driveResult = driveResult;
    this.emitChange(task);
  }
}

const transferEngine = new TransferEngine();
module.exports = { transferEngine, TransferEngine };
