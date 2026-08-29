'use strict';

const { EventEmitter } = require('events');
const axios = require('axios');
const https = require('https');
const path = require('path');
const { googleDrive } = require('../drive/google-drive');
const { movieScraper } = require('../extractors/movie-scraper');
const { mediaExtractor } = require('../extractors/media-extractor');
const { adultExtractor } = require('../extractors/adult-extractor');
const { cloudWorkerClient } = require('../worker/cloud-worker-client');
const { getYtDlp } = require('../../../lib/ytdlp-manager');

class TransferEngine extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
  }

  getTasks() {
    return Array.from(this.tasks.values()).reverse();
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  async startTransfer({ title, url, type = 'media', quality = 'HD', folderId }) {
    const taskId = 'task_' + Math.random().toString(36).substring(2, 10);
    const abortController = new AbortController();

    const task = {
      id: taskId,
      title: title || 'Media Cloud Download',
      sourceUrl: url,
      type,
      quality,
      folderId: folderId || googleDrive.defaultFolderId,
      status: 'queued',
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

    this.processTask(task).catch(err => {
      task.status = 'failed';
      task.error = err.message;
      this.emitChange(task);
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

    let customHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' };

    if (task.type === 'movie') {
      const resolved = await movieScraper.resolveFinalDownloadUrl(targetUrl);
      targetUrl = resolved.streamUrl;
      if (resolved.headers) customHeaders = { ...customHeaders, ...resolved.headers };
      if (!fileName.endsWith('.mp4') && !fileName.endsWith('.mkv')) {
        fileName += '.mp4';
      }
    } else if (task.type === 'nsfw' || targetUrl.includes('pornhub.com') || targetUrl.includes('xvideos.com') || targetUrl.includes('xnxx.com') || targetUrl.includes('eporner.com') || targetUrl.includes('redtube.com')) {
      try {
        const resolved = await adultExtractor.resolveStream(targetUrl);
        if (resolved.downloadUrl || resolved.streamUrl) {
          targetUrl = resolved.downloadUrl || resolved.streamUrl;
        }
        if (resolved.title) fileName = resolved.title.replace(/[/\\?%*:|"<>]/g, '_') + '.mp4';
      } catch (err) {}
    }

    task.status = 'transferring';
    this.emitChange(task);

    // 🚀 Hybrid Cloud Offload: If Railway Cloud Worker is available, offload upload with 0 MB PC Data!
    const cloudWorkerUrl = (process.env.CLOUD_WORKER_URL || '').trim();
    if (cloudWorkerUrl) {
      try {
        const offloadRes = await axios.post(`${cloudWorkerUrl.replace(/\/$/, '')}/api/worker/drive-transfer`, {
          taskId: task.id,
          sourceUrl: targetUrl,
          title: fileName,
          folderId: task.folderId,
          accessToken: googleDrive.tokens?.access_token,
          refreshToken: googleDrive.tokens?.refresh_token,
          clientId: googleDrive.credentials?.clientId,
          clientSecret: googleDrive.credentials?.clientSecret,
          type: task.type
        }, { timeout: 10000 });

        if (offloadRes.data && offloadRes.data.success) {
          console.log(`[Transfer Engine] 🚀 Successfully offloaded Google Drive upload to Railway Cloud Worker (0 MB PC Data)!`);
          
          return new Promise((resolve, reject) => {
            const poller = setInterval(async () => {
              try {
                const statusRes = await axios.get(`${cloudWorkerUrl.replace(/\/$/, '')}/api/worker/drive-status/${task.id}`, { timeout: 5000 });
                const ws = statusRes.data;
                if (ws) {
                  task.percent = ws.percent || task.percent;
                  task.speedMBps = ws.speedMBps || '45.00';
                  task.uploadedMB = ws.uploadedMB || task.uploadedMB;
                  task.totalMB = ws.totalMB || task.totalMB;
                  task.etaSec = ws.etaSec || 0;
                  task.status = ws.status === 'completed' ? 'completed' : (ws.status === 'failed' ? 'failed' : 'transferring');
                  this.emitChange(task);

                  if (ws.status === 'completed') {
                    clearInterval(poller);
                    task.result = ws.result;
                    resolve(ws.result);
                  } else if (ws.status === 'failed') {
                    clearInterval(poller);
                    reject(new Error(ws.error || 'Railway worker transfer failed'));
                  }
                }
              } catch (e) {
                // If temporary network poll issue, keep waiting
              }
            }, 1000);
          });
        }
      } catch (workerErr) {
        console.warn(`[Transfer Engine] ⚠️ Railway offload fallback to local high-speed stream: ${workerErr.message}`);
      }
    }

    let stream;
    let sizeBytes = 0;

    const insecureAgent = new https.Agent({ rejectUnauthorized: false });

    try {
      const head = await axios.head(targetUrl, {
        headers: customHeaders,
        timeout: 12000,
        httpsAgent: insecureAgent,
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
        headers: customHeaders,
        httpsAgent: insecureAgent,
        timeout: 0,
        signal: task.abortController.signal
      });

      stream = getRes.data;
    } catch (err) {
      if (task.type === 'movie' && (err.response?.status === 503 || err.message?.includes('503') || targetUrl.includes('sinhalasub'))) {
        throw new Error(`The selected server link is temporarily offline (${err.response?.status || 503}). Please choose the 'PixelDrain' or 'DLServer' option for this movie.`);
      }
      const { getYtdlp } = require('../../../lib/ytdlp-manager');
      const ytdlp = getYtdlp();
      stream = ytdlp.execStream([
        targetUrl,
        '--no-check-certificates',
        '--geo-bypass',
        '--no-playlist',
        '-f', 'bestvideo+bestaudio/best'
      ]);
      stream.on('error', (e) => {
        task.status = 'failed';
        task.error = e.message || 'Stream download error';
        this.emitChange(task);
      });
      if (!fileName.includes('.')) fileName += '.mp4';
    }

    if (!fileName.includes('.')) {
      fileName += mimeType.includes('audio') ? '.mp3' : '.mp4';
    }

    task.title = fileName;
    task.totalMB = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(1) : 'Live Stream';

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
