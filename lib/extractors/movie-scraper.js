'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { logger } = require('../../logger');

/**
 * Universal Movie Search and Direct Link Resolver for Sinhala Subtitle & Movie Portals
 * Supports: Sinhalasub.lk, Baiscope.lk, Cinesubz, and direct streaming/DDL sources.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8'
};

class MovieScraper {
  /**
   * Search movies across multiple providers
   */
  async searchMovies(query) {
    const results = [];
    const searchTasks = [
      this.searchSinhalasub(query).catch(e => {
        logger.warn(`[MovieScraper] Sinhalasub search failed: ${e.message}`);
        return [];
      }),
      this.searchBaiscope(query).catch(e => {
        logger.warn(`[MovieScraper] Baiscope search failed: ${e.message}`);
        return [];
      })
    ];

    const settled = await Promise.allSettled(searchTasks);
    for (const res of settled) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        results.push(...res.value);
      }
    }

    // De-duplicate by title similarity
    const unique = [];
    const seen = new Set();
    for (const item of results) {
      const cleanKey = (item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanKey && !seen.has(cleanKey)) {
        seen.add(cleanKey);
        unique.push(item);
      }
    }

    return unique.slice(0, 30);
  }

  async searchSinhalasub(query) {
    const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}`;
    const res = await axios.get(searchUrl, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    const list = [];

    $('article, .result-item, .item-movies, .movies-list .item').each((_, el) => {
      const title = $(el).find('.title a, h2 a, h3 a').text().trim() || $(el).find('img').attr('alt');
      const link = $(el).find('.title a, h2 a, h3 a, a').first().attr('href');
      const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
      const year = $(el).find('.year, .metadata span, .rating').first().text().trim();
      const rating = $(el).find('.rating, .imdb, .vote').text().trim();

      if (title && link && link.includes('sinhalasub.lk')) {
        list.push({
          source: 'Sinhalasub',
          title: title.replace(/\s+/g, ' '),
          year: year || '',
          rating: rating || '',
          poster: poster.startsWith('//') ? 'https:' + poster : poster,
          link: link
        });
      }
    });

    return list;
  }

  async searchBaiscope(query) {
    const searchUrl = `https://www.baiscope.lk/?s=${encodeURIComponent(query)}`;
    const res = await axios.get(searchUrl, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    const list = [];

    $('.post, article, .entry').each((_, el) => {
      const title = $(el).find('.entry-title a, h2 a').text().trim();
      const link = $(el).find('.entry-title a, h2 a').attr('href');
      const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
      const desc = $(el).find('.entry-summary, p').first().text().trim().slice(0, 150);

      if (title && link) {
        list.push({
          source: 'Baiscope',
          title: title.replace(/\s+/g, ' '),
          year: '',
          rating: '',
          poster: poster.startsWith('//') ? 'https:' + poster : poster,
          link: link,
          description: desc
        });
      }
    });

    return list;
  }

  /**
   * Extract download links and quality options from movie detail page
   */
  async getMovieDetails(pageUrl) {
    const res = await axios.get(pageUrl, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(res.data);

    const title = $('h1.entry-title, .title h1, h1').first().text().trim();
    const poster = $('.poster img, .featured-image img, .entry-content img').first().attr('src') || '';
    const synopsis = $('.synopsis, .entry-content p, .overview').first().text().trim();

    const qualities = [];

    // Scan for direct or download table links
    $('a[href*="pixeldrain"], a[href*="drive.google"], a[href*="mega."], a[href*="usersdrive"], a[href*="sinhalasub"], a[href*="download"], a.btn, .download-link a, table tr').each((_, el) => {
      let href = $(el).attr('href') || $(el).find('a').attr('href');
      let text = $(el).text().trim() || $(el).parent().text().trim();

      if (href && !href.startsWith('#') && !href.includes('wp-admin') && !href.includes('facebook.com')) {
        let qualityMatch = text.match(/(480p|720p|1080p|2160p|4K|HD|SD|HQ)/i) || href.match(/(480p|720p|1080p|2160p|4K)/i);
        let sizeMatch = text.match(/([0-9.]+\s*(?:GB|MB))/i);
        let qualityStr = qualityMatch ? qualityMatch[1].toUpperCase() : 'HD';
        let sizeStr = sizeMatch ? sizeMatch[1] : '';

        // Provider detection
        let provider = 'Direct Link';
        if (href.includes('pixeldrain.com')) provider = 'PixelDrain';
        else if (href.includes('drive.google.com')) provider = 'Google Drive';
        else if (href.includes('usersdrive.com')) provider = 'UsersDrive';
        else if (href.includes('mega.nz') || href.includes('mega.co')) provider = 'Mega';
        else if (href.includes('sinhalasub.lk/links') || href.includes('goto')) provider = 'Sinhalasub Fast Link';

        if (href.startsWith('http')) {
          qualities.push({
            quality: qualityStr,
            size: sizeStr,
            provider,
            downloadUrl: href,
            title: text.replace(/\s+/g, ' ').slice(0, 60)
          });
        }
      }
    });

    return {
      title,
      poster: poster.startsWith('//') ? 'https:' + poster : poster,
      synopsis,
      qualities: qualities.length > 0 ? qualities : [
        { quality: 'HD', size: 'Direct', provider: 'Source Page', downloadUrl: pageUrl, title: 'Extract Links' }
      ]
    };
  }

  /**
   * Resolve an intermediate download URL (PixelDrain / UsersDrive / Redirector) into final streamable download URL
   */
  async resolveFinalDownloadUrl(targetUrl) {
    let url = targetUrl.trim();

    // 1. PixelDrain Direct API link
    const pdMatch = url.match(/pixeldrain\.com\/(?:u|l)\/([a-zA-Z0-9_-]+)/);
    if (pdMatch) {
      const fileId = pdMatch[1];
      return {
        streamUrl: `https://pixeldrain.com/api/file/${fileId}?download`,
        headers: { 'User-Agent': HEADERS['User-Agent'] }
      };
    }

    // 2. Direct UsersDrive or SinhalaSub redirector resolver
    if (url.includes('sinhalasub') || url.includes('links') || url.includes('goto') || url.includes('usersdrive')) {
      try {
        const pageRes = await axios.get(url, { headers: HEADERS, timeout: 12000 });
        const $ = cheerio.load(pageRes.data);
        
        // Check for pixeldrain or direct download button in redirector page
        const foundPd = $('a[href*="pixeldrain.com/u/"]').attr('href');
        if (foundPd) {
          return this.resolveFinalDownloadUrl(foundPd);
        }

        const directA = $('a.btn-download, a.direct-link, a#download, a[href*=".mp4"], a[href*=".mkv"]').first().attr('href');
        if (directA && directA.startsWith('http')) {
          return { streamUrl: directA, headers: HEADERS };
        }
      } catch (err) {
        logger.warn(`[MovieScraper] Redirect resolve error: ${err.message}`);
      }
    }

    return {
      streamUrl: url,
      headers: HEADERS
    };
  }
}

const movieScraper = new MovieScraper();
module.exports = { movieScraper, MovieScraper };
