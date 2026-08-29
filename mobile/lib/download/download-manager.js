'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const EventEmitter = require('events');
const { movieScraper } = require('../extractors/movie-scraper');

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.downloads = new Map();
    this.activeStreams = new Map();
    this.downloadDir = path.join(__dirname, '../../downloads');

    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  getAll() {
    return Array.from(this.downloads.values());
  }

  get(id) {
    return this.downloads.get(id);
  }

  async startDownload(rawUrl, customTitle = '') {
    const id = 'dl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    let cleanTitle = (customTitle || 'download_' + Date.now()).replace(/[/\\?%*:|"<>]/g, '_').trim();
    if (!path.extname(cleanTitle)) {
      cleanTitle += '.mp4';
    }

    const filePath = path.join(this.downloadDir, `${id}_${cleanTitle}`);

    const item = {
      id,
      title: cleanTitle,
      rawUrl,
      resolvedUrl: rawUrl,
      filePath,
      fileName: cleanTitle,
      status: 'resolving',
      downloadedBytes: 0,
      totalBytes: 0,
      downloadedMB: '0.0',
      totalMB: '0.0',
      percent: 0,
      speedMBps: '0.00',
      etaSec: 0,
      error: null,
      createdAt: new Date().toISOString()
    };

    this.downloads.set(id, item);
    this.emit('updated', item);

    this._executeDownload(item);
    return item;
  }

  async _executeDownload(item) {
    try {
      // 1. Resolve final URL if it's a redirector or filehost like filespayouts
      let resolved = await this.resolveUrl(item.rawUrl);
      item.resolvedUrl = resolved.streamUrl || item.rawUrl;
      item.status = 'downloading';
      this.emit('updated', item);

      // Check if resuming partial file
      let existingBytes = 0;
      if (fs.existsSync(item.filePath)) {
        const stat = fs.statSync(item.filePath);
        existingBytes = stat.size;
      }
      item.downloadedBytes = existingBytes;

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(resolved.headers || {})
      };

      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`;
      }

      const controller = new AbortController();
      this.activeStreams.set(item.id, { controller });

      const response = await axios({
        method: 'GET',
        url: item.resolvedUrl,
        responseType: 'stream',
        headers,
        signal: controller.signal,
        timeout: 30000
      });

      let total = parseInt(response.headers['content-length'] || 0, 10);
      if (response.status === 206) {
        total += existingBytes;
      }
      item.totalBytes = total || existingBytes;
      item.totalMB = (item.totalBytes / (1024 * 1024)).toFixed(1);

      const writeStream = fs.createWriteStream(item.filePath, { flags: existingBytes > 0 ? 'a' : 'w' });

      let lastBytes = existingBytes;
      let lastTime = Date.now();

      const progressInterval = setInterval(() => {
        if (item.status !== 'downloading') {
          clearInterval(progressInterval);
          return;
        }

        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed > 0.5) {
          const chunkBytes = item.downloadedBytes - lastBytes;
          const speed = (chunkBytes / (1024 * 1024)) / elapsed;
          item.speedMBps = speed.toFixed(2);

          if (item.totalBytes > 0) {
            item.percent = Math.min(100, Math.floor((item.downloadedBytes / item.totalBytes) * 100));
            const remainingBytes = item.totalBytes - item.downloadedBytes;
            item.etaSec = speed > 0 ? Math.ceil((remainingBytes / (1024 * 1024)) / speed) : 0;
          } else {
            item.percent = 50;
          }

          item.downloadedMB = (item.downloadedBytes / (1024 * 1024)).toFixed(1);
          lastBytes = item.downloadedBytes;
          lastTime = now;
          this.emit('updated', item);
        }
      }, 500);

      response.data.on('data', (chunk) => {
        item.downloadedBytes += chunk.length;
      });

      response.data.pipe(writeStream);

      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        response.data.on('error', reject);
      });

      clearInterval(progressInterval);
      this.activeStreams.delete(item.id);

      item.status = 'completed';
      item.percent = 100;
      item.speedMBps = '0.00';
      item.downloadedMB = (item.downloadedBytes / (1024 * 1024)).toFixed(1);
      item.totalMB = item.downloadedMB;
      this.emit('updated', item);
    } catch (err) {
      if (item.status === 'paused' || item.status === 'cancelled') {
        return;
      }
      item.status = 'failed';
      item.error = err.message || 'Download failed';
      item.speedMBps = '0.00';
      this.activeStreams.delete(item.id);
      this.emit('updated', item);
    }
  }

  async pauseDownload(id) {
    const item = this.downloads.get(id);
    if (!item) return false;

    item.status = 'paused';
    item.speedMBps = '0.00';

    const active = this.activeStreams.get(id);
    if (active && active.controller) {
      active.controller.abort();
      this.activeStreams.delete(id);
    }

    this.emit('updated', item);
    return true;
  }

  async resumeDownload(id) {
    const item = this.downloads.get(id);
    if (!item) return false;

    if (item.status === 'downloading') return true;

    item.status = 'downloading';
    item.error = null;
    this.emit('updated', item);

    this._executeDownload(item);
    return true;
  }

  async deleteDownload(id, deleteFile = true) {
    const item = this.downloads.get(id);
    if (!item) return false;

    item.status = 'cancelled';
    const active = this.activeStreams.get(id);
    if (active && active.controller) {
      active.controller.abort();
      this.activeStreams.delete(id);
    }

    if (deleteFile && fs.existsSync(item.filePath)) {
      try {
        fs.unlinkSync(item.filePath);
      } catch (e) {}
    }

    this.downloads.delete(id);
    this.emit('deleted', id);
    return true;
  }

  /**
   * Universal resolver for Filespayouts, PixelDrain, Sinhalasub, Baiscopes, etc.
   */
  async resolveUrl(url) {
    const cleanUrl = url.trim();

    // 1. Filespayouts Resolver
    if (cleanUrl.includes('filespayouts.com') || cleanUrl.includes('filespayout.com')) {
      try {
        const res = await axios.get(cleanUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://filespayouts.com/'
          },
          timeout: 12000
        });

        // Search for direct download link inside HTML or form
        const directMatch = res.data.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|zip|rar|tar|iso|avi)(\?[^\s"'<>]*)?/i);
        if (directMatch) {
          return { streamUrl: directMatch[0], headers: { 'Referer': 'https://filespayouts.com/' } };
        }

        const cheerio = require('cheerio');
        const $ = cheerio.load(res.data);
        const form = $('form[name="F1"], form').first();
        if (form.length > 0) {
          const action = form.attr('action') || cleanUrl;
          const formData = {};
          form.find('input').each((_, inp) => {
            const n = $(inp).attr('name');
            const v = $(inp).attr('value') || '';
            if (n) formData[n] = v;
          });

          const postRes = await axios.post(action, new URLSearchParams(formData).toString(), {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': cleanUrl
            },
            timeout: 12000
          });

          const postMatch = postRes.data.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|zip|rar|tar|iso|avi)(\?[^\s"'<>]*)?/i);
          if (postMatch) {
            return { streamUrl: postMatch[0], headers: { 'Referer': cleanUrl } };
          }
        }
      } catch (err) {}
    }

    // 2. Adult Video Extractor (Pornhub, XVideos, XNXX, Eporner, Redtube)
    if (cleanUrl.includes('pornhub.com') || cleanUrl.includes('xvideos.com') || cleanUrl.includes('xnxx.com') || cleanUrl.includes('eporner.com') || cleanUrl.includes('redtube.com')) {
      try {
        const { adultExtractor } = require('../extractors/adult-extractor');
        const resolved = await adultExtractor.resolveStream(cleanUrl);
        const finalUrl = resolved.downloadUrl || resolved.streamUrl;
        if (finalUrl && finalUrl !== cleanUrl) {
          return { streamUrl: finalUrl };
        }
      } catch (err) {}
    }

    // 3. Movie Scraper redirector / PixelDrain / Media
    return await movieScraper.resolveFinalDownloadUrl(cleanUrl);
  }
}

const downloadManager = new DownloadManager();
module.exports = { downloadManager, DownloadManager };
