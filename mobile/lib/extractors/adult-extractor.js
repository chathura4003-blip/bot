'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

class AdultExtractor {
  /**
   * Search adult videos with selectable provider
   * @param {string} query - Search keyword
   * @param {number} page - Page number
   * @param {string} source - 'all' | 'pornhub' | 'xvideos' | 'xnxx' | 'eporner' | 'redtube'
   */
  async searchVideos(query = 'trending', page = 1, source = 'all') {
    const cleanQ = (query || 'popular').trim();
    const results = [];
    const tasks = [];

    if (source === 'all' || source === 'pornhub') {
      tasks.push(this.searchPornhub(cleanQ, page).catch(() => []));
    }
    if (source === 'all' || source === 'xvideos') {
      tasks.push(this.searchXvideos(cleanQ, page).catch(() => []));
    }
    if (source === 'all' || source === 'xnxx') {
      tasks.push(this.searchXnxx(cleanQ, page).catch(() => []));
    }
    if (source === 'all' || source === 'eporner') {
      tasks.push(this.searchEporner(cleanQ, page).catch(() => []));
    }
    if (source === 'all' || source === 'redtube') {
      tasks.push(this.searchRedtube(cleanQ, page).catch(() => []));
    }

    const settled = await Promise.allSettled(tasks);
    const providerArrays = settled
      .filter(s => s.status === 'fulfilled' && Array.isArray(s.value) && s.value.length > 0)
      .map(s => s.value);

    const maxLen = Math.max(...providerArrays.map(a => a.length), 0);
    const mixed = [];
    for (let i = 0; i < maxLen; i++) {
      for (const arr of providerArrays) {
        if (i < arr.length) {
          mixed.push(arr[i]);
        }
      }
    }

    // De-duplicate by title
    const unique = [];
    const seen = new Set();
    for (const v of mixed) {
      const k = (v.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (k && !seen.has(k)) {
        seen.add(k);
        unique.push(v);
      }
    }

    return unique.slice(0, 50);
  }

  async searchPornhub(query, page = 1) {
    const q = encodeURIComponent(query);
    const url = `https://www.pornhub.com/video/search?search=${q}&page=${page}`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    const list = [];

    $('.videoBlock, .pcVideoListItem, .phimage').each((_, el) => {
      const a = $(el).find('a.linkVideoThumb, a[href*="/view_video.php"]').first();
      const title = $(el).find('.title a, .linkVideoThumb, img').attr('title') || $(el).find('.title a').text().trim() || $(el).find('img').attr('alt');
      const href = a.attr('href');
      const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || $(el).find('img').attr('data-thumb_url');
      const dur = $(el).find('.duration, .varDuration').text().trim();

      if (title && href && href.includes('view_video.php')) {
        list.push({
          source: 'Pornhub',
          title: title.replace(/\s+/g, ' '),
          duration: dur || 'HD',
          thumbnail: thumb,
          rating: 'HD 1080p',
          url: href.startsWith('http') ? href : `https://www.pornhub.com${href}`
        });
      }
    });
    return list;
  }

  async searchXvideos(query, page = 1) {
    const q = encodeURIComponent(query);
    const xvUrl = `https://www.xvideos.com/?k=${q}&p=${page}`;
    const res = await axios.get(xvUrl, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(res.data);
    const list = [];

    $('.thumb-block').each((_, el) => {
      const a = $(el).find('.title a').first();
      const title = a.text().trim();
      const href = a.attr('href');
      const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
      let dur = $(el).find('.duration').first().text().trim();
      dur = dur.replace(/(\d+\s*min)\1/gi, '$1');

      if (title && href) {
        list.push({
          source: 'XVideos',
          title: title.replace(/\s+/g, ' '),
          duration: dur || 'HD',
          thumbnail: thumb,
          rating: 'HD',
          url: href.startsWith('http') ? href : `https://www.xvideos.com${href}`
        });
      }
    });
    return list;
  }

  async searchXnxx(query, page = 1) {
    const q = encodeURIComponent(query);
    const url = `https://www.xnxx.com/search/${q}/${page}`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(res.data);
    const list = [];

    $('.mozaique .thumb-block, .thumb-block, .thumb-inside').each((_, el) => {
      const a = $(el).find('a').first();
      const title = $(el).find('.thumb-under a, p.title a, a').text().trim() || $(el).find('img').attr('alt');
      const href = $(el).find('a[href*="/video-"]').attr('href') || a.attr('href');
      const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
      let dur = $(el).find('.duration, .metadata').text().trim();
      dur = dur.split('\n')[0].trim();

      if (title && href) {
        list.push({
          source: 'XNXX',
          title: title.replace(/\s+/g, ' '),
          duration: dur || 'HD',
          thumbnail: thumb,
          rating: 'HD',
          url: href.startsWith('http') ? href : `https://www.xnxx.com${href}`
        });
      }
    });
    return list;
  }

  async searchEporner(query, page = 1) {
    const q = encodeURIComponent(query);
    const apiUrl = `https://www.eporner.com/api/v2/video/search/?query=${q}&page=${page}&per_page=20&thumbsize=big&order=top-monthly`;
    const res = await axios.get(apiUrl, { timeout: 10000, headers: HEADERS });
    const list = [];

    if (res.data && Array.isArray(res.data.videos)) {
      for (const v of res.data.videos) {
        list.push({
          source: 'Eporner',
          id: v.id,
          title: v.title,
          duration: v.length_min ? `${v.length_min} min` : (v.length_sec ? `${Math.floor(v.length_sec / 60)} min` : 'HD'),
          thumbnail: v.default_thumb?.src || v.thumbs?.[0]?.src || '',
          views: v.views ? v.views.toLocaleString() : '',
          rating: v.rate ? `${v.rate}%` : 'HD 1080p',
          url: v.url
        });
      }
    }
    return list;
  }

  async searchRedtube(query, page = 1) {
    const q = encodeURIComponent(query);
    const apiUrl = `https://api.redtube.com/?data=redtube.Videos.searchVideos&output=json&search=${q}&page=${page}&thumbsize=big`;
    const res = await axios.get(apiUrl, { headers: HEADERS, timeout: 10000 });
    const list = [];

    if (res.data && Array.isArray(res.data.videos)) {
      for (const item of res.data.videos) {
        const v = item.video || item;
        list.push({
          source: 'RedTube',
          id: v.video_id,
          title: v.title,
          duration: v.duration || 'HD',
          thumbnail: v.default_thumb || v.thumb || '',
          views: v.views ? Number(v.views).toLocaleString() : '',
          rating: v.rating ? `${Math.round(parseFloat(v.rating))}%` : 'HD',
          url: v.url
        });
      }
    }
    return list;
  }

  async resolveStream(videoUrl) {
    if (!videoUrl) throw new Error('Video URL required');

    // 1. XVideos - Direct MP4 / HLS Regex (Ultra Fast)
    if (videoUrl.includes('xvideos.com')) {
      try {
        const vidMatch = videoUrl.match(/video(\d+)\//) || videoUrl.match(/video-([0-9a-zA-Z_]+)/) || videoUrl.match(/video\.([0-9a-zA-Z_]+)/);
        const vidId = vidMatch ? vidMatch[1] : '';
        const res = await axios.get(videoUrl, { headers: HEADERS, timeout: 10000 });
        const html = res.data;
        const mp4HighMatch = html.match(/html5player\.setVideoUrlHigh\('([^']+)'\)/);
        const mp4LowMatch = html.match(/html5player\.setVideoUrlLow\('([^']+)'\)/);
        const hlsMatch = html.match(/html5player\.setVideoHLS\('([^']+)'\)/);
        const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
        const title = titleMatch ? titleMatch[1].replace(' - XVIDEOS.COM', '').trim() : 'XVideos Stream';

        const streamUrl = mp4HighMatch ? mp4HighMatch[1] : (mp4LowMatch ? mp4LowMatch[1] : (hlsMatch ? hlsMatch[1] : null));
        const qualities = [];
        if (mp4HighMatch) qualities.push({ label: '1080p / 720p HD', url: mp4HighMatch[1], isDefault: true });
        if (mp4LowMatch) qualities.push({ label: '480p / 360p SD', url: mp4LowMatch[1] });
        if (hlsMatch) qualities.push({ label: 'Auto (Adaptive)', url: hlsMatch[1] });

        if (streamUrl) {
          return {
            type: 'mp4',
            streamUrl,
            downloadUrl: streamUrl,
            embedUrl: vidId ? `https://www.xvideos.com/embedframe/${vidId}` : videoUrl,
            title,
            qualities
          };
        }
      } catch (err) {}
    }

    // 2. XNXX - Direct MP4 / HLS Regex (Ultra Fast)
    if (videoUrl.includes('xnxx.com')) {
      try {
        const vidMatch = videoUrl.match(/video-([0-9a-zA-Z_]+)\//) || videoUrl.match(/video(\d+)\//);
        const vidId = vidMatch ? vidMatch[1] : '';
        const res = await axios.get(videoUrl, { headers: HEADERS, timeout: 10000 });
        const html = res.data;
        const mp4HighMatch = html.match(/html5player\.setVideoUrlHigh\('([^']+)'\)/);
        const mp4LowMatch = html.match(/html5player\.setVideoUrlLow\('([^']+)'\)/);
        const hlsMatch = html.match(/html5player\.setVideoHLS\('([^']+)'\)/);
        const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
        const title = titleMatch ? titleMatch[1].replace(' - XNXX.COM', '').trim() : 'XNXX Stream';

        const streamUrl = mp4HighMatch ? mp4HighMatch[1] : (mp4LowMatch ? mp4LowMatch[1] : (hlsMatch ? hlsMatch[1] : null));
        const qualities = [];
        if (mp4HighMatch) qualities.push({ label: '1080p / 720p HD', url: mp4HighMatch[1], isDefault: true });
        if (mp4LowMatch) qualities.push({ label: '480p / 360p SD', url: mp4LowMatch[1] });
        if (hlsMatch) qualities.push({ label: 'Auto (Adaptive)', url: hlsMatch[1] });

        if (streamUrl) {
          return {
            type: 'mp4',
            streamUrl,
            downloadUrl: streamUrl,
            embedUrl: vidId ? `https://www.xnxx.com/embedframe/${vidId}` : videoUrl,
            title,
            qualities
          };
        }
      } catch (err) {}
    }

    // 3. Eporner - Direct API Lookups
    if (videoUrl.includes('eporner.com')) {
      try {
        const vidMatch = videoUrl.match(/video-([a-zA-Z0-9]+)/) || videoUrl.match(/([a-zA-Z0-9]{8,15})/);
        const vidId = vidMatch ? vidMatch[1] : '';
        if (vidId) {
          const res = await axios.get(`https://www.eporner.com/api/v2/video/id/?id=${vidId}&thumbsize=big`, { headers: HEADERS, timeout: 10000 });
          if (res.data) {
            const embedUrl = res.data.embed || `https://www.eporner.com/embed/${vidId}/`;
            let streamUrl = null;
            const qualities = [];
            if (res.data.sources) {
              const keys = Object.keys(res.data.sources);
              for (const k of keys) {
                if (res.data.sources[k]?.src) {
                  qualities.push({
                    label: k.toUpperCase() + (k.includes('1080') ? ' (Full HD)' : (k.includes('720') ? ' (HD)' : '')),
                    url: res.data.sources[k].src,
                    isDefault: k === '1080p' || k === '720p'
                  });
                }
              }
              const best = res.data.sources['1080p'] || res.data.sources['720p'] || res.data.sources['480p'] || res.data.sources[keys[0]];
              if (best?.src) streamUrl = best.src;
            }
            return {
              type: streamUrl ? 'mp4' : 'embed',
              streamUrl: streamUrl || embedUrl,
              downloadUrl: streamUrl || embedUrl,
              embedUrl: embedUrl,
              title: res.data.title || 'Eporner Video',
              thumbnail: res.data.default_thumb?.src || '',
              qualities: qualities.length > 0 ? qualities : [{ label: '1080p Full HD', url: streamUrl || embedUrl, isDefault: true }]
            };
          }
        }
      } catch (err) {}
    }

    // 4. RedTube - Direct Embed & Stream
    if (videoUrl.includes('redtube.com')) {
      try {
        const idMatch = videoUrl.match(/(\d+)/);
        const vidId = idMatch ? idMatch[1] : '';
        const embedUrl = vidId ? `https://embed.redtube.com/?id=${vidId}` : videoUrl;
        return {
          type: 'embed',
          streamUrl: embedUrl,
          downloadUrl: videoUrl,
          embedUrl: embedUrl,
          title: 'RedTube Video',
          qualities: [{ label: '1080p Full HD', url: embedUrl, isDefault: true }]
        };
      } catch (e) {}
    }

    // 5. Pornhub - Official Responsive HD Embed Player & yt-dlp Backend Downloader
    if (videoUrl.includes('pornhub.com')) {
      const vkMatch = videoUrl.match(/viewkey=([a-zA-Z0-9]+)/);
      const vk = vkMatch ? vkMatch[1] : '';
      const embedUrl = vk ? `https://www.pornhub.com/embed/${vk}` : videoUrl;
      return {
        type: 'embed',
        streamUrl: embedUrl,
        downloadUrl: videoUrl,
        embedUrl: embedUrl,
        title: 'Pornhub Video',
        qualities: [
          { label: '1080p Full HD', url: videoUrl, isDefault: true },
          { label: '720p HD', url: videoUrl },
          { label: '480p SD', url: videoUrl }
        ]
      };
    }

    // 6. Universal via yt-dlp
    try {
      const { getYtdlp } = require('../../../lib/ytdlp-manager');
      const ytdlp = getYtdlp();
      const info = await ytdlp.getVideoInfo(videoUrl);

      if (info) {
        let bestFormat = null;
        const qualities = [];
        const seen = new Set();

        if (Array.isArray(info.formats)) {
          const valid = info.formats.filter(f => f.url && (f.vcodec !== 'none' || f.acodec !== 'none'));
          for (const f of valid.reverse()) {
            const height = f.height || (f.resolution ? parseInt(f.resolution) : 0);
            const label = height ? `${height}p` : (f.format_note || 'HD');
            if (!seen.has(label)) {
              seen.add(label);
              qualities.push({
                label: `${label}` + (height >= 1080 ? ' Full HD' : (height >= 720 ? ' HD' : '')),
                url: f.url,
                isDefault: qualities.length === 0
              });
            }
          }
          bestFormat = valid.find(f => f.ext === 'mp4' && f.acodec !== 'none') || valid[0];
        }

        const directUrl = bestFormat?.url || info.url;
        return {
          type: directUrl ? 'mp4' : 'embed',
          streamUrl: directUrl || videoUrl,
          downloadUrl: directUrl || videoUrl,
          embedUrl: videoUrl,
          title: info.title || '18+ Stream',
          thumbnail: info.thumbnail || '',
          qualities: qualities.length > 0 ? qualities : [{ label: 'Auto (1080p)', url: directUrl || videoUrl, isDefault: true }]
        };
      }
    } catch (e) {}

    return {
      type: 'direct',
      streamUrl: videoUrl,
      downloadUrl: videoUrl,
      embedUrl: videoUrl,
      title: '18+ Adult Video',
      qualities: [{ label: '1080p Full HD', url: videoUrl, isDefault: true }]
    };
  }

  async getVideoDetails(videoUrl) {
    return this.resolveStream(videoUrl);
  }
}

const adultExtractor = new AdultExtractor();
module.exports = { adultExtractor, AdultExtractor };
