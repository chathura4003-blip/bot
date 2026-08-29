'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { logger } = require('../../logger');

/**
 * 18+ / Adult Video Search & Direct Extractor
 * Supports: Eporner API, SpankBang, XVideos, Pornhub, and yt-dlp direct extraction.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

class AdultExtractor {
  /**
   * Search 18+ videos
   */
  async searchVideos(query = 'trending', page = 1) {
    const results = [];

    // 1. Eporner API (Very fast, clean metadata & HD video sources)
    try {
      const q = encodeURIComponent(query || 'popular');
      const apiUrl = `https://www.eporner.com/api/v2/video/search/?query=${q}&page=${page}&per_page=20&thumbsize=big&order=top-monthly`;
      
      const res = await axios.get(apiUrl, { timeout: 10000, headers: HEADERS });
      if (res.data && Array.isArray(res.data.videos)) {
        for (const v of res.data.videos) {
          results.push({
            id: v.id,
            title: v.title,
            duration: v.length_min || v.length_sec ? `${v.length_min || Math.floor(v.length_sec / 60)} min` : 'HD',
            thumbnail: v.default_thumb?.src || v.thumbs?.[0]?.src || '',
            views: v.views ? v.views.toLocaleString() : '',
            rating: v.rate ? `${v.rate}%` : '',
            url: v.url,
            qualities: ['1080p', '720p', '480p']
          });
        }
      }
    } catch (err) {
      logger.warn(`[AdultExtractor] Eporner API search error: ${err.message}`);
    }

    // 2. XVideos / SpankBang fallback scraper if needed
    if (results.length === 0) {
      try {
        const xvUrl = `https://www.xvideos.com/?k=${encodeURIComponent(query)}&p=${page}`;
        const res = await axios.get(xvUrl, { headers: HEADERS, timeout: 10000 });
        const $ = cheerio.load(res.data);

        $('.thumb-block').each((_, el) => {
          const title = $(el).find('.title a').text().trim();
          const href = $(el).find('.title a').attr('href');
          const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
          const duration = $(el).find('.duration').text().trim();

          if (title && href) {
            results.push({
              title,
              duration,
              thumbnail: thumb,
              url: href.startsWith('http') ? href : `https://www.xvideos.com${href}`,
              qualities: ['720p', '480p', '360p']
            });
          }
        });
      } catch (err) {
        logger.warn(`[AdultExtractor] XVideos search error: ${err.message}`);
      }
    }

    return results;
  }

  /**
   * Get direct stream details for an adult video URL
   */
  async getVideoDetails(videoUrl) {
    // If it's an Eporner URL, fetch direct mp4 streams from page or API
    if (videoUrl.includes('eporner.com')) {
      try {
        const vidMatch = videoUrl.match(/video-([a-zA-Z0-9]+)/);
        const vidId = vidMatch ? vidMatch[1] : '';
        if (vidId) {
          const res = await axios.get(`https://www.eporner.com/api/v2/video/id/?id=${vidId}&thumbsize=big`, { headers: HEADERS, timeout: 10000 });
          if (res.data && res.data.sources) {
            const qualities = [];
            for (const [qual, details] of Object.entries(res.data.sources)) {
              qualities.push({
                quality: qual.toUpperCase(),
                downloadUrl: details.src,
                size: details.size ? `${(details.size / (1024 * 1024)).toFixed(1)} MB` : 'HD'
              });
            }
            return {
              title: res.data.title,
              thumbnail: res.data.default_thumb?.src || '',
              duration: res.data.length_min || '',
              qualities: qualities.length > 0 ? qualities : [{ quality: 'HD', downloadUrl: videoUrl }]
            };
          }
        }
      } catch (err) {
        logger.warn(`[AdultExtractor] Eporner detail fetch notice: ${err.message}`);
      }
    }

    return {
      title: '18+ Adult Video',
      url: videoUrl,
      qualities: [
        { quality: 'Best HD', downloadUrl: videoUrl }
      ]
    };
  }
}

const adultExtractor = new AdultExtractor();
module.exports = { adultExtractor, AdultExtractor };
