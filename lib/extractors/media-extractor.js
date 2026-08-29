'use strict';

const axios = require('axios');
const path = require('path');
const { getYtDlp, hasYtDlp } = require('../ytdlp-manager');
const { logger } = require('../../logger');

/**
 * Universal Media Extractor (YouTube, TikTok, Facebook, Instagram, Twitter, Mega, Direct links)
 */

class MediaExtractor {
  /**
   * Extract video/media metadata and download formats
   */
  async extractInfo(mediaUrl) {
    const url = (mediaUrl || '').trim();
    if (!url) throw new Error('No URL provided');

    // 1. Direct file link check (.mp4, .mkv, .zip, .mp3, etc.)
    if (/\.(mp4|mkv|avi|webm|mov|flv|mp3|m4a|aac|wav|zip|rar|tar|iso|7z)(\?.*)?$/i.test(url)) {
      try {
        const headRes = await axios.head(url, { timeout: 10000 }).catch(() => null);
        const headers = headRes?.headers || {};
        const sizeBytes = parseInt(headers['content-length'] || '0', 10);
        const contentType = headers['content-type'] || 'application/octet-stream';
        
        let filename = path.basename(url.split('?')[0]);
        const cd = headers['content-disposition'];
        if (cd && cd.includes('filename=')) {
          const match = cd.match(/filename=["']?([^"';]+)["']?/i);
          if (match && match[1]) filename = match[1];
        }

        return {
          type: 'direct',
          title: filename,
          url: url,
          sizeBytes,
          contentType,
          thumbnail: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&q=80',
          formats: [
            { formatId: 'direct', quality: 'Original Quality', size: sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB' : 'Direct Stream', ext: path.extname(filename).slice(1) || 'mp4' }
          ]
        };
      } catch (err) {
        logger.warn(`[MediaExtractor] Direct head probe failed: ${err.message}`);
      }
    }

    // 2. Use yt-dlp for streaming sites (YouTube, FB, TikTok, IG, Adult sites, etc.)
    try {
      const ytdlp = await getYtDlp();
      const info = await ytdlp.getVideoInfo(url);
      
      const formats = [];
      const seenQualities = new Set();

      if (Array.isArray(info.formats)) {
        for (const f of info.formats) {
          if (f.vcodec !== 'none' || f.acodec !== 'none') {
            const height = f.height || (f.resolution ? parseInt(f.resolution) : 0);
            const qualityLabel = height ? `${height}p` : (f.format_note || 'Standard');
            
            if (!seenQualities.has(qualityLabel) && (height >= 360 || qualityLabel === 'Standard')) {
              seenQualities.add(qualityLabel);
              formats.push({
                formatId: f.format_id,
                quality: qualityLabel,
                ext: f.ext || 'mp4',
                filesize: f.filesize || f.filesize_approx || 0,
                hasVideo: f.vcodec !== 'none',
                hasAudio: f.acodec !== 'none'
              });
            }
          }
        }
      }

      // Add audio-only option
      formats.push({
        formatId: 'bestaudio',
        quality: 'Audio MP3',
        ext: 'mp3',
        hasVideo: false,
        hasAudio: true
      });

      return {
        type: 'stream',
        title: info.title || 'Media Video',
        duration: info.duration || 0,
        thumbnail: info.thumbnail || '',
        uploader: info.uploader || info.channel || '',
        url: url,
        formats: formats.length > 0 ? formats : [
          { formatId: 'best', quality: 'Best Available (Auto)', ext: 'mp4' }
        ]
      };
    } catch (err) {
      logger.warn(`[MediaExtractor] yt-dlp extraction fallback: ${err.message}`);
      
      // Fallback object
      return {
        type: 'direct',
        title: 'Direct Stream File',
        url: url,
        thumbnail: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&q=80',
        formats: [
          { formatId: 'best', quality: 'Auto Best', ext: 'mp4' }
        ]
      };
    }
  }
}

const mediaExtractor = new MediaExtractor();
module.exports = { mediaExtractor, MediaExtractor };
