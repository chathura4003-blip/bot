'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8'
};

class MovieScraper {
  /**
   * Search movies across Sinhalasub and Baiscope portals concurrently
   */
  async searchMovies(query) {
    if (!query || !query.trim()) return [];
    const results = [];
    const cleanQ = query.trim();

    const searchTasks = [
      this.searchSinhalasub(cleanQ).catch(() => []),
      this.searchBaiscope(cleanQ).catch(() => [])
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

    return unique.slice(0, 40);
  }

  async searchSinhalasub(query) {
    const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}`;
    const res = await axios.get(searchUrl, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    const list = [];
    const seen = new Set();

    $('.display-item .item-box, .result-item, article, .item, .movies-list .item').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href');
      if (!href || seen.has(href)) return;
      seen.add(href);

      const title = a.attr('title')?.trim() || $(el).find('.title, h2, h3').text().trim() || a.text().trim();
      if (!title || title.length < 2) return;

      const img = $(el).find('img');
      const poster = img.attr('src') || img.attr('data-src') || '';
      const rating = $(el).find('.rating, .imdb, .vote').text().trim();
      const year = $(el).find('.year, .metadata span, .release-year').first().text().trim() || 'HD';

      list.push({
        source: 'Sinhalasub',
        title: title.replace(/\s+/g, ' '),
        year: year,
        rating: rating,
        poster: poster.startsWith('//') ? 'https:' + poster : poster,
        link: href
      });
    });

    return list;
  }

  async searchBaiscope(query) {
    const searchUrl = `https://baiscopes.lk/?s=${encodeURIComponent(query)}`;
    const res = await axios.get(searchUrl, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    const list = [];
    const seen = new Set();

    $('.result-item, article, .item, .movies .item, .post').each((_, el) => {
      const titleEl = $(el).find('.title a, h2 a, h3 a, .entry-title a, .details .title a').first();
      const title = titleEl.text().trim() || titleEl.attr('title') || $(el).find('img').attr('alt');
      const href = titleEl.attr('href') || $(el).find('a').attr('href');
      if (!href || seen.has(href) || !href.includes('baiscopes.lk/movies/')) return;
      seen.add(href);

      if (!title || title.length < 2 || title.toLowerCase() === 'movie') return;

      const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
      const rating = $(el).find('.rating, .imdb').text().trim();
      const year = $(el).find('.year, .release-year').text().trim() || 'HD';

      list.push({
        source: 'Baiscope',
        title: title.replace(/\s+/g, ' '),
        year: year,
        rating: rating,
        poster: poster.startsWith('//') ? 'https:' + poster : poster,
        link: href
      });
    });

    return list;
  }

  /**
   * Extract details, synopsis, and download quality options (Sinhalasub & Baiscopes)
   */
  async getMovieDetails(pageUrl) {
    const isBaiscope = pageUrl.includes('baiscopes.lk');
    const headers = { ...HEADERS, 'Referer': isBaiscope ? 'https://baiscopes.lk/' : 'https://sinhalasub.lk/' };
    
    const res = await axios.get(pageUrl, { headers, timeout: 15000 });
    const $ = cheerio.load(res.data);

    const title = $('h1, .entry-title, .details-title h3').first().text().trim();
    const poster = $('.splash-bg img, .poster img, .entry-content img, .featured-image img').first().attr('src') || '';
    const synopsis = $('.info-details .data-story, .plot, .description, .entry-content p').first().text().trim() || title;

    const qualities = [];
    const seenLinks = new Set();

    // Scan table rows for quality options
    $('table tr').each((_, row) => {
      const linkEl = $(row).find('a[href*="/links/"], a[href*="pixeldrain"], a[href*="drive.google"], a[href*="usersdrive"], .link-opt a').first();
      const dlUrl = linkEl.attr('href');
      if (!dlUrl || dlUrl === '#' || dlUrl.startsWith('javascript') || seenLinks.has(dlUrl)) return;

      // Filter out Telegram, Whatsapp, and blog spam links
      if (dlUrl.includes('t.me') || dlUrl.includes('telegram') || dlUrl.includes('whatsapp') || dlUrl.includes('join-as-a-blog')) return;

      let provider = linkEl.text().trim() || $(row).find('.link-opt').text().trim() || (isBaiscope ? 'Baiscope Server' : 'Fast Server');
      if (/telegram|telagram|channel|whatsapp/i.test(provider)) return;

      seenLinks.add(dlUrl);

      let rawQual = $(row).find('.quality, td:nth-child(2)').text().trim() || 'HD 720p';
      let qualMatch = rawQual.match(/(480p|720p|1080p|2160p|4K|FHD|HD|SD)/i);
      let qual = qualMatch ? qualMatch[0].toUpperCase() : 'HD';

      let size = $(row).find('td:nth-child(3), td:last-child, .size').text().trim() || '';
      let sizeMatch = size.match(/\d+(\.\d+)?\s*(GB|MB)/i);
      let sizeStr = sizeMatch ? sizeMatch[0] : size;

      qualities.push({
        quality: qual,
        size: sizeStr,
        provider: provider.replace(/\s+/g, ' ').slice(0, 30),
        downloadUrl: dlUrl
      });
    });

    // Fallback: search for direct download anchor buttons outside tables
    if (qualities.length === 0) {
      $('a[href*="pixeldrain"], a[href*="/links/"], a.download-btn, a.btn-download').each((_, a) => {
        const h = $(a).attr('href');
        const text = $(a).text().trim();
        if (h && !seenLinks.has(h) && h.startsWith('http')) {
          if (h.includes('t.me') || h.includes('telegram') || /telegram|telagram/i.test(text)) return;
          seenLinks.add(h);
          qualities.push({
            quality: 'HD Direct',
            size: 'Cloud Stream',
            provider: isBaiscope ? 'Baiscope Link' : 'Direct Link',
            downloadUrl: h
          });
        }
      });
    }

    // Sort qualities: Prioritize PixelDrain and DLServer at the top!
    qualities.sort((a, b) => {
      const aScore = /pixeldrain/i.test(a.provider) ? 3 : (/dlserver/i.test(a.provider) ? 2 : (/filespayout/i.test(a.provider) ? 1 : 0));
      const bScore = /pixeldrain/i.test(b.provider) ? 3 : (/dlserver/i.test(b.provider) ? 2 : (/filespayout/i.test(b.provider) ? 1 : 0));
      return bScore - aScore;
    });

    return {
      title,
      poster: poster.startsWith('//') ? 'https:' + poster : poster,
      synopsis,
      qualities: qualities.length > 0 ? qualities : [
        { quality: 'HD', size: 'Direct', provider: 'Source Page', downloadUrl: pageUrl }
      ]
    };
  }

  /**
   * Resolve final direct binary download URL with 0 redirects
   */
  async resolveFinalDownloadUrl(targetUrl) {
    let url = (targetUrl || '').trim();

    // 1. PixelDrain Direct API Link
    const pdMatch = url.match(/pixeldrain\.com\/(?:u|l|api\/file)\/([a-zA-Z0-9_-]+)/);
    if (pdMatch) {
      const fileId = pdMatch[1];
      return {
        streamUrl: `https://pixeldrain.com/api/file/${fileId}?download`,
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': `https://pixeldrain.com/u/${fileId}`
        }
      };
    }

    // 2. Direct Video File (.mp4 / .mkv)
    if (/\.(mp4|mkv|webm|avi)(\?.*)?$/i.test(url)) {
      return { streamUrl: url, headers: HEADERS };
    }

    // 3. Redirector resolution (Sinhalasub & Baiscopes)
    if (url.includes('sinhalasub') || url.includes('baiscopes') || url.includes('/links/') || url.includes('goto')) {
      try {
        const isBaiscope = url.includes('baiscopes');
        const referer = isBaiscope ? 'https://baiscopes.lk/' : 'https://sinhalasub.lk/';

        const linkPage = await axios.get(url, {
          headers: { ...HEADERS, 'Referer': referer },
          timeout: 12000
        });

        // 3a. Search for PixelDrain inside HTML or JS script
        const pdInPage = linkPage.data.match(/pixeldrain\.com\/(?:u|l|api\/file)\/([a-zA-Z0-9_-]+)/);
        if (pdInPage) {
          const fileId = pdInPage[1];
          return {
            streamUrl: `https://pixeldrain.com/api/file/${fileId}?download`,
            headers: {
              'User-Agent': HEADERS['User-Agent'],
              'Referer': `https://pixeldrain.com/u/${fileId}`
            }
          };
        }

        // 3b. Search for zluFinalLink (DLServer direct MP4 link)
        const zluMatch = linkPage.data.match(/var\s+zluFinalLink\s*=\s*['"]([^'"]+)['"]/);
        if (zluMatch && zluMatch[1] && zluMatch[1].startsWith('http')) {
          const directCandidate = zluMatch[1];
          if (directCandidate.includes('pixeldrain')) {
            return this.resolveFinalDownloadUrl(directCandidate);
          }
          return {
            streamUrl: directCandidate,
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': referer }
          };
        }

        // 3c. Search for direct mp4/mkv in HTML
        const directFileMatch = linkPage.data.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv)/i);
        if (directFileMatch) {
          return {
            streamUrl: directFileMatch[0],
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': referer }
          };
        }

        const $ = cheerio.load(linkPage.data);
        const directA = $('a[href*="pixeldrain"], a.btn-download, a.direct-link, a#download, a[href*=".mp4"], a[href*=".mkv"], a[href*="usersdrive"]').first().attr('href');
        if (directA && directA.startsWith('http')) {
          if (directA.includes('pixeldrain')) {
            return this.resolveFinalDownloadUrl(directA);
          }
          return { streamUrl: directA, headers: HEADERS };
        }
      } catch (err) {}
    }

    return { streamUrl: url, headers: HEADERS };
  }
}

const movieScraper = new MovieScraper();
module.exports = { movieScraper, MovieScraper };
