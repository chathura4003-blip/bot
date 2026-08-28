"use strict";

const { ensureRuntimeHome } = require('../runtime-home');
ensureRuntimeHome();
const puppeteer = require("puppeteer");
const { getBrowserLaunchOptions } = require("../browser-helper");
const themeMgr = require("../theme-manager");
const { sendReact, presenceUpdate, truncate, extractQuotedContext } = require("../utils");
const msgMgr = require("../message-manager");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const ui = require("../ui");
const translate = require("translate-google-api");
const { DOWNLOAD_DIR, CLOUD_WORKER_URL } = require("../../config");
const { progressBar, formatSize } = require("../premium");
const { offloadMediaToWorker } = require("../cloud-worker");
const { browserPool } = require("../browser-pool");
const { menuStateManager } = require("../menu-state");
const { isMegaUrl, downloadMegaFile } = require("../mega-downloader");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch (_) { }
}

let browserCloseTimer = null;
let globalBrowser = null;

async function getBrowser() {
  return browserPool.getBrowser();
}

function startAutoCloseTimer() {
  if (browserCloseTimer) clearTimeout(browserCloseTimer);
  browserCloseTimer = setTimeout(async () => {
    try {
      if (globalBrowser && globalBrowser.isConnected()) {
        await globalBrowser.close().catch(() => { });
      }
      globalBrowser = null;
      console.log("[Movie] Browser auto-closed due to inactivity.");
      if (typeof global.gc === 'function') {
        try { global.gc(); } catch (_) { }
      }
    } catch (e) { }
  }, 15000);
}

function forceCloseBrowser() {
  if (browserCloseTimer) clearTimeout(browserCloseTimer);
  browserCloseTimer = null;
  // Force-close puppeteer before doing anything memory-intensive (movie
  // downloads) so the browser's RAM is freed immediately and can be
  // reclaimed by the GC.
  if (globalBrowser) {
    try {
      if (globalBrowser.isConnected()) globalBrowser.close().catch(() => { });
    } catch (_) { }
    globalBrowser = null;
    console.log("[Movie] Browser closed early to reclaim RAM.");
  }
}

// ---------------------------------------------------------------------------
// File-size safety ceiling (Max 1.7 GB for WhatsApp Direct Upload)
// ---------------------------------------------------------------------------
const WHATSAPP_DOC_LIMIT_MB = 1740; // 1.7 GB

function getEffectiveMaxUploadBytes() {
  const hardLimit = WHATSAPP_DOC_LIMIT_MB * 1024 * 1024;
  const envOverride = parseInt(process.env.BAISCOPE_MAX_UPLOAD_MB || "", 10);
  if (Number.isFinite(envOverride) && envOverride > 0) {
    return envOverride * 1024 * 1024;
  }
  return hardLimit;
}

function tryGc() {
  if (typeof global.gc === "function") {
    try { global.gc(); } catch (_) { }
  }
}

async function getBrowser() {
  try {
    if (browserCloseTimer) clearTimeout(browserCloseTimer);

    if (globalBrowser && globalBrowser.isConnected()) {
      return globalBrowser;
    }
    const launchOptions = getBrowserLaunchOptions();
    globalBrowser = await puppeteer.launch(launchOptions);
    return globalBrowser;
  } catch (e) {
    console.log("[Movie] Browser Launch Error:", e.message);
    return null;
  }
}

function normalizeQuality(text) {
  if (!text) return "720p HD";
  text = text.toUpperCase();
  if (text.includes("720") || text.includes("HD")) return "720p HD";
  if (text.includes("480") || text.includes("SD")) return "480p SD";
  if (text.includes("360")) return "360p Low";
  return text;
}

function getDownloadHeaders(url, defaultReferer = '') {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_) { }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
  };

  // Prevent 403 Forbidden on CDNs & file hosts
  if (host.includes('pixeldrain.com')) {
    headers['Referer'] = 'https://pixeldrain.com/';
  } else if (host.includes('google') || host.includes('googleusercontent') || host.includes('workers.dev')) {
    // Omit referer to bypass anti-hotlinking
  } else if (host.includes('usersdrive.com')) {
    headers['Referer'] = 'https://usersdrive.com/';
  } else if (host.includes('mediafire.com')) {
    headers['Referer'] = 'https://www.mediafire.com/';
  } else if (defaultReferer) {
    headers['Referer'] = defaultReferer;
  }

  return headers;
}

function getDirectPixeldrainUrl(url) {
  if (!url) return null;
  const fileMatch = url.match(/pixeldrain\.com\/(?:u|d)\/([a-zA-Z0-9_-]+)/i);
  if (fileMatch) return `https://pixeldrain.com/api/file/${fileMatch[1]}?download`;
  return url;
}

async function resolvePixeldrainListUrl(listUrl) {
  try {
    const m = listUrl.match(/pixeldrain\.com\/l\/([a-zA-Z0-9_-]+)/i);
    if (!m) return null;
    const res = await axios({
      method: "GET",
      url: `https://pixeldrain.com/api/list/${m[1]}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://pixeldrain.com/'
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (!res || res.status !== 200 || !res.data || !Array.isArray(res.data.files)) return null;
    const videoFiles = res.data.files.filter((f) => {
      const name = String(f.name || "").toLowerCase();
      const mime = String(f.mime_type || "").toLowerCase();
      return mime.startsWith("video/") || /\.(mp4|mkv|m4v|webm|avi)$/i.test(name);
    });
    const candidates = videoFiles.length ? videoFiles : res.data.files;
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.size || 0) - (a.size || 0));
    const picked = candidates[0];
    if (!picked || !picked.id) return null;
    return `https://pixeldrain.com/api/file/${picked.id}?download`;
  } catch (e) {
    console.log("[Baiscope] Pixeldrain list resolve failed:", e.message);
    return null;
  }
}

const VIDEO_EXT_RE = /\.(mp4|mkv|m4v|webm|avi)(\?|$)/i;
const MIN_VIDEO_BYTES = 1 * 1024 * 1024; // 1 MB; anything smaller is almost certainly an error page.

function looksLikeVideoContentType(ct) {
  if (!ct) return false;
  const t = String(ct).toLowerCase();
  return t.startsWith("video/") || t.includes("octet-stream") || t.includes("application/x-mpegurl");
}

async function probeDirectVideoUrl(url) {
  const headers = getDownloadHeaders(url, 'https://baiscopes.lk/');
  let finalUrl = url;
  let contentType = "";
  let contentLength = 0;

  try {
    const res = await axios({
      method: "HEAD",
      url,
      headers,
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    finalUrl = res.request?.res?.responseUrl || url;
    contentType = String(res.headers["content-type"] || "").toLowerCase();
    contentLength = parseInt(res.headers["content-length"] || "0", 10) || 0;
    if (res.status >= 200 && res.status < 300 && (contentType || contentLength)) {
      return { ok: true, contentLength, contentType, finalUrl };
    }
  } catch (_) { /* fall through to ranged GET probe */ }

  try {
    const res = await axios({
      method: "GET",
      url,
      headers: { ...headers, Range: "bytes=0-1" },
      timeout: 20000,
      maxRedirects: 5,
      responseType: "stream",
      validateStatus: () => true,
    });
    finalUrl = res.request?.res?.responseUrl || url;
    contentType = String(res.headers["content-type"] || "").toLowerCase();
    const cr = res.headers["content-range"] || "";
    const totalFromRange = cr.match(/\/(\d+)\s*$/);
    contentLength = totalFromRange
      ? parseInt(totalFromRange[1], 10)
      : parseInt(res.headers["content-length"] || "0", 10) || 0;
    try { res.data.destroy(); } catch (_) { }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, contentLength, contentType, finalUrl };
    }
  } catch (e) {
    console.log("[Baiscope] Probe failed:", e.message);
  }

  return { ok: false, contentLength: 0, contentType: "", finalUrl: url };
}

async function baiscopeSearch(query) {
  const cleanQ = (query || "").trim();
  let searchUrl = `https://baiscopes.lk/?s=${encodeURIComponent(cleanQ)}`;
  if (!cleanQ || cleanQ.toLowerCase() === "new" || cleanQ.toLowerCase() === "latest" || cleanQ.toLowerCase() === "all") {
    searchUrl = `https://baiscopes.lk/movies/`;
  }

  // Tier 1: Fast Direct HTTP Scraper (Cheerio + Axios - ~200ms)
  try {
    const res = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 10000,
    });

    if (res.status === 200 && res.data) {
      const $ = cheerio.load(res.data);
      const results = [];
      const seen = new Set();

      $('.result-item, article, .item, .search-page .item, .movies .item, .post').each((i, el) => {
        const a = $(el).find('.title a, h2 a, h3 a, .entry-title a, a[href*="/movies/"], a[rel="bookmark"]');
        const href = a.attr('href') || $(el).find('a').attr('href');
        let title = a.text().trim() || a.attr('title') || $(el).find('h2, h3, .title').text().trim();
        const imgEl = $(el).find('img');
        const thumbnail = imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || '';

        if (href && title && !seen.has(href)) {
          seen.add(href);
          title = title.replace(/^Movie\s*/i, '').trim();
          results.push({
            id: results.length + 1,
            title: title.replace(/\s+/g, ' '),
            url: href,
            language: "Sinhala Sub",
            quality: "HD",
            thumbnail,
          });
        }
      });

      if (results.length > 0) {
        return results.slice(0, 10);
      }
    }
  } catch (err) {
    console.log("[Baiscope] Fast search failed, falling back to browser:", err.message);
  }

  // Tier 2: Headless Browser Fallback (Puppeteer)
  const browser = await getBrowser();
  if (!browser) return [];
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort().catch(() => { });
      else req.continue().catch(() => { });
    });

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
    await page.waitForSelector("article, .items .item, .movies .movie, .result-item", { timeout: 8000 }).catch(() => { });

    const results = await page.evaluate(() => {
      let articles = Array.from(document.querySelectorAll("article, .items .item, .movies .item, .result-item"));
      const found = [];
      const seen = new Set();
      articles.forEach((article) => {
        const titleLink = article.querySelector(".title a, .data h3 a, h2 a, h3 a, a[href*='/movies/']");
        if (!titleLink || !titleLink.href || seen.has(titleLink.href)) return;
        seen.add(titleLink.href);
        let title = titleLink.textContent?.trim() || "";
        if (!title) return;
        title = title.replace(/^Movie\s*/i, '').trim();
        const img = article.querySelector("img[itemprop='image'], img");
        const thumbnail = img ? (img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.src || "") : "";
        found.push({ id: found.length + 1, title: title.replace(/\s+/g, ' '), url: titleLink.href, language: "Sinhala Sub", quality: "HD", thumbnail });
      });
      return found.slice(0, 10);
    });

    return results;
  } catch (e) {
    return [];
  } finally {
    startAutoCloseTimer();
    if (page) await page.close().catch(() => { });
  }
}

async function baiscopeResolveLink(browser, linkData, onWait = null) {
  const extraPages = [];
  let subPage = null;
  let targetListener = null;
  let safetyTimeout = null;

  try {
    subPage = await browser.newPage();
    await subPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, height: 1080) Chrome/124.0.0.0 Safari/537.36");

    safetyTimeout = setTimeout(async () => {
      try {
        if (subPage && !subPage.isClosed()) {
          await subPage.close().catch(() => { });
        }
      } catch (e) { }
    }, 25000);
    subPage.on('dialog', async dialog => {
      await dialog.dismiss().catch(() => { });
    });

    // Disable console logs for subPage as well
    // subPage.on('console', msg => console.log(`[SubBrowser] ${msg.text()}`));

    const selectors = [
      "a#link",
      "a.btn[href*='workers.dev']",
      "a[href*='workers.dev']",
      ".wait-done a[href*='pixeldrain']",
      ".wait-done a[href*='google']",
      ".wait-done a[href*='usersdrive']",
      "a.btn-primary[href*='pixeldrain']",
      "a.btn-success[href*='pixeldrain']",
      "a[href*='pixeldrain']",
      "a[href*='usersdrive']",
      "#direct-link",
      ".download-button",
      "#download-btn",
      "#confirm-download-button"
    ];

    const selectorStr = selectors.join(", ");

    // console.log("[Scraper] Navigating to protector page...");
    await subPage.goto(linkData.pageLink, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => { });

    let finalUrl = null;
    let directDetected = null;

    // 1. Fast condition polling for direct download button or zluFinalLink (polls every 150ms)
    const pollStart = Date.now();
    while (Date.now() - pollStart < 4000 && !directDetected) {
      const instantLink = await subPage.evaluate((sel) => {
        if (typeof window.zluFinalLink === "string" && window.zluFinalLink.startsWith("http")) {
          return window.zluFinalLink;
        }
        const html = document.documentElement.innerHTML;
        const match = html.match(/zluFinalLink\s*=\s*['"]([^'"]+)['"]/i);
        if (match && match[1]) return match[1];

        const target = document.querySelector(sel);
        return (target && target.href && !target.href.includes('#') && !target.href.includes('javascript')) ? target.href : null;
      }, selectorStr).catch(() => null);

      if (instantLink && (instantLink.includes('workers.dev') || instantLink.includes('pixeldrain') || instantLink.includes('google') || instantLink.includes('usersdrive') || instantLink.includes('mega.nz') || instantLink.includes('mega.co') || /\.(mp4|mkv|zip|rar)$/i.test(instantLink))) {
        if (onWait) await onWait("SUCCESS").catch(() => { });
        directDetected = instantLink;
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }

    if (!directDetected) {
      await subPage.setRequestInterception(true);
      subPage.on('request', (req) => {
        if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
        const url = req.url().toLowerCase();
        const isAd = /ads|analytics|doubleclick|popunder|1xbet|bet365/i.test(url);
        if (isAd) return req.abort().catch(() => { });

        const isVideoFile = (url.includes('.mp4') || url.includes('.mkv') || url.includes('workers.dev') || url.includes('mega.nz') || (url.includes('/api/file/') && !url.includes('/thumbnail') && !url.includes('/gallery'))) && !url.includes('cdn-cgi');
        if (isVideoFile && !directDetected) {
          directDetected = url;
        }
        req.continue().catch(() => { });
      });

      targetListener = async (target) => {
        const opener = await target.opener();
        if (!opener || opener.url() !== subPage.url()) return;
        const tUrl = target.url();
        const tType = target.type();

        if (tUrl && !directDetected) {
          const isDL = (tUrl.includes('pixeldrain.com') || tUrl.includes('drive.google') || tUrl.includes('workers.dev') || tUrl.includes('mega.nz') || tUrl.includes('drive.usercontent') || /\.(mp4|mkv|zip|rar|mp3)$/i.test(tUrl));
          if (isDL && !tUrl.includes('cdn-cgi')) {
            directDetected = tUrl;
          }
        }

        if (tType === 'page') {
          const newPage = await target.page().catch(() => null);
          if (newPage) {
            extraPages.push(newPage);
            newPage.on('response', response => {
              const rUrl = response.url();
              const contentType = response.headers()['content-type'] || '';
              const isDL = (contentType.includes('video/') || rUrl.includes('.mp4') || rUrl.includes('.mkv') ||
                rUrl.includes('pixeldrain.com') || rUrl.includes('drive.google') || rUrl.includes('workers.dev') || rUrl.includes('mega.nz') || rUrl.includes('drive.usercontent'));
              if (isDL && !rUrl.includes('cdn-cgi') && !directDetected) {
                directDetected = rUrl;
              }
            });
          }
        }
      };
      browser.on('targetcreated', targetListener);

      // Try button click
      await subPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("a#link, button, a.btn, .download-button, a[id*='btn'], #download-btn"));
        const target = btns.find(b => {
          const t = b.textContent.toLowerCase();
          return t.includes('download') || t.includes('generate') || t.includes('continue') || t.includes('get link') || t.includes('පිටුවට යන්න');
        });
        if (target) target.click();
      }).catch(() => { });

      const clickPollStart = Date.now();
      while (Date.now() - clickPollStart < 5000 && !directDetected) {
        const finalExtract = await subPage.evaluate((sel) => {
          const target = document.querySelector(sel);
          return (target && target.href && !target.href.includes('#') && !target.href.includes('javascript')) ? target.href : null;
        }, selectorStr).catch(() => null);

        if (finalExtract && (finalExtract.includes('workers.dev') || finalExtract.includes('pixeldrain') || finalExtract.includes('google') || finalExtract.includes('usersdrive') || finalExtract.includes('mega.nz') || finalExtract.includes('mega.co'))) {
          directDetected = finalExtract;
          break;
        }
        await new Promise(r => setTimeout(r, 150));
      }
    }

    finalUrl = directDetected || subPage.url();
    if (!finalUrl) finalUrl = subPage.url();

    // If still a baiscopes protector link, extract one last time
    if (finalUrl.includes('baiscopes.lk') || finalUrl.includes('protector')) {
      const extracted = await subPage.evaluate((sel) => {
        const el = document.querySelector(sel);
        return (el && el.href && !el.href.includes('#') && !el.href.includes('javascript')) ? el.href : null;
      }, selectorStr).catch(() => null);
      if (extracted) finalUrl = extracted;
    }

    if (finalUrl && (finalUrl.includes('baiscopes.lk') || finalUrl.includes('link-protector'))) {
      if (!finalUrl.includes('workers.dev')) {
        finalUrl = null;
      }
    }

    if (finalUrl && (finalUrl.includes('chrome-error') || finalUrl.includes('chromewebdata'))) {
      finalUrl = null;
    }

    if (finalUrl) {
      const lowUrl = finalUrl.toLowerCase();
      let resolvedSource = linkData.source;

      if (lowUrl.includes("pixeldrain")) {
        const pdMatch = finalUrl.match(/pixeldrain\.com\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/i);
        if (pdMatch && pdMatch[1]) {
          finalUrl = `https://pixeldrain.com/api/file/${pdMatch[1]}`;
        }
        resolvedSource = "Pixeldrain";
      }
      else if (lowUrl.includes("drive.google") || lowUrl.includes("drive.usercontent")) resolvedSource = "G-Drive";
      else if (lowUrl.includes("workers.dev")) resolvedSource = "Cloudflare";
      else if (lowUrl.includes("usersdrive")) resolvedSource = "UsersDrive";
      else if (lowUrl.includes("mega.nz") || lowUrl.includes("mega.co")) resolvedSource = "Mega";
      else if (lowUrl.includes("mediafire")) resolvedSource = "Mediafire";
      else if (lowUrl.includes("gdtot")) resolvedSource = "GDToT";
      else if (lowUrl.includes("hubcloud")) resolvedSource = "HubCloud";
      else if (resolvedSource === "Link") resolvedSource = "Direct";

      return { link: finalUrl, quality: normalizeQuality(linkData.quality), size: linkData.size, source: resolvedSource, priority: linkData.priority };
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    startAutoCloseTimer();
    if (safetyTimeout) clearTimeout(safetyTimeout);
    if (browser && targetListener) browser.off('targetcreated', targetListener);
    for (const p of extraPages) await p.close().catch(() => { });
    if (subPage) await subPage.close().catch(() => { });
  }
}

async function baiscopeGetDetails(movieUrl, sender) {
  // Tier 1: Fast Direct HTTP Scraper (Cheerio + Axios - ~300ms)
  try {
    const res = await axios.get(movieUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      timeout: 12000
    });

    if (res.status === 200 && res.data) {
      const $ = cheerio.load(res.data);
      const title = $('.entry-title, .title a, h1').first().text().trim();
      if (title) {
        const summaryEls = $("#dt_contenedor [itemprop='description'].wp-content p, #dt_contenedor [itemprop='description'] p, .plot p, .entry-content p");
        let summary = summaryEls.map((i, el) => $(el).text().trim()).get().filter(t => t.length > 50).join("\n\n");
        if (!summary) summary = $("#dt_contenedor [itemprop='description'], .plot, .entry-content p").first().text().trim() || "No summary available.";

        let language = "Sinhala Sub", duration = "N/A", imdb = "N/A";
        const container = $("#dt_contenedor, #single, .post-content");

        container.find("p, div, li, span, b, strong").each((i, el) => {
          const txt = $(el).text().trim();
          if (txt.includes("භාෂාව") || txt.includes("Language")) {
            const val = txt.split(":")[1]?.trim();
            if (val && val.length < 50) language = val;
          }
          if (txt.includes("කාලය") || txt.includes("ධාවන කාලය") || txt.includes("Runtime") || txt.includes("Duration")) {
            const val = txt.split(":")[1]?.trim();
            if (val && val.length < 50 && /\d/.test(val)) duration = val;
          }
          if (txt.includes("IMDb") || txt.includes("අගය") || txt.includes("Rating")) {
            const val = txt.split(":")[1]?.trim();
            if (val && /\d/.test(val)) imdb = val.match(/\d(\.\d)?/)?.[0] || val;
          }
        });

        const genres = $(".category a, .genres a, .genre a").map((i, el) => $(el).text().trim()).get().slice(0, 3);
        const posterImg = $("img[itemprop='image'], .single_post_featured_img img, img.wp-post-image, #dt_contenedor img article img").first();
        const posterMeta = $("meta[itemprop='image'], meta[property='og:image']").first();
        let thumbnail = posterImg.attr('data-src') || posterImg.attr('data-lazy-src') || posterImg.attr('src') || posterMeta.attr('content') || '';

        const links = [];
        const seen = new Set();
        const movieTitle = title || $('h1').text().trim();

        $('table').each((tIndex, table) => {
          let qualityCol = -1, sizeCol = -1, optCol = -1;
          $(table).find('tr th').each((hIndex, th) => {
            const hText = $(th).text().trim().toLowerCase();
            if (hText.includes('quality')) qualityCol = hIndex;
            else if (hText.includes('size')) sizeCol = hIndex;
            else if (hText.includes('option') || hText.includes('server') || hText.includes('link')) optCol = hIndex;
          });

          $(table).find('tr').each((rIndex, row) => {
            const a = $(row).find("a[href*='/links'], a[href*='goto'], a[href*='pixeldrain'], a[href*='drive.google'], a[href*='workers.dev']");
            const href = a.attr('href');
            if (!href || seen.has(href)) return;
            if (href.includes("t.me") || href.includes("telegram")) return;

            const cells = $(row).find("td");
            if (!cells.length) return;

            let extractedQuality = "";
            let extractedSize = "";
            let sourceName = a.text().trim() || "Direct Link";

            cells.each((cIndex, td) => {
              const text = $(td).text().trim();
              if (!text) return;

              if (cIndex === sizeCol) {
                extractedSize = text;
              } else if (cIndex === qualityCol) {
                extractedQuality = text;
              }

              if (!extractedSize && /\b\d+(\.\d+)?\s*(GB|MB)\b/i.test(text)) {
                extractedSize = text.match(/\b\d+(\.\d+)?\s*(GB|MB)\b/i)[0];
              }
              if (!extractedQuality && /\b(2160p|4k|1080p|720p|480p|360p|FHD|HD|SD)\b/i.test(text) && !text.includes('GB') && !text.includes('MB')) {
                extractedQuality = text;
              }
            });

            if (extractedSize.toUpperCase().includes('KB') || sourceName.toLowerCase().includes('subtitle')) {
              return;
            }

            seen.add(href);

            const fullRowText = $(row).text().replace(/\s+/g, ' ');
            let quality = "";
            const qMatch = (extractedQuality || fullRowText).toUpperCase();
            if (qMatch.includes("2160") || qMatch.includes("4K")) quality = "4K UHD";
            else if (qMatch.includes("1080") || qMatch.includes("FHD")) quality = "1080p FHD";
            else if (qMatch.includes("720") || qMatch.includes("HD")) quality = "720p HD";
            else if (qMatch.includes("480") || qMatch.includes("SD")) quality = "480p SD";
            else if (qMatch.includes("360")) quality = "360p Low";
            else if (extractedSize) {
              const sizeMatch = extractedSize.match(/(\d+(\.\d+)?)\s*(GB|MB)/i);
              if (sizeMatch) {
                const val = parseFloat(sizeMatch[1]);
                const mb = sizeMatch[3].toUpperCase() === 'GB' ? val * 1024 : val;
                if (mb >= 2500) quality = "1080p FHD";
                else if (mb >= 950) quality = "720p HD";
                else quality = "480p SD";
              }
            }
            if (!quality) quality = "720p HD";

            const size = extractedSize || "N/A";

            let source = "Direct Link";
            const hLower = href.toLowerCase();
            const sLower = sourceName.toLowerCase();
            if (hLower.includes("pixeldrain") || sLower.includes("pixeldrain")) source = "Pixeldrain";
            else if (hLower.includes("drive.google") || sLower.includes("g-drive")) source = "G-Drive";
            else if (hLower.includes("usersdrive") || sLower.includes("usersdrive")) source = "UsersDrive";
            else if (sLower.includes("filespayout")) source = "FilesPayout";
            else if (sLower.includes("akirabox")) source = "AkiraBox";
            else if (sLower.includes("dlserver-01")) source = "DLServer-01";
            else if (sLower.includes("dlserver-02")) source = "DLServer-02";

            let priority = 50;
            if (source === "Pixeldrain") priority = 1;
            else if (source.includes("DLServer")) priority = 2;
            else if (source === "AkiraBox") priority = 3;
            else if (source === "FilesPayout") priority = 4;
            else if (source === "Direct Link") priority = 5;

            if (quality.includes("1080")) priority += 0.1;
            else if (quality.includes("720")) priority += 0.2;
            else if (quality.includes("480")) priority += 0.3;

            links.push({ pageLink: href, quality, size, source, link: href, priority });
          });
        });

        if (links.length > 0) {
          links.sort((a, b) => a.priority - b.priority);
          const finalLinks = links.slice(0, 4);

          // Save to user-specific blink file for concurrency safety
          try {
            const linkDir = path.join(__dirname, "link");
            if (!fs.existsSync(linkDir)) fs.mkdirSync(linkDir, { recursive: true });
            const safeSender = sender ? sender.split('@')[0] : 'default';
            const blinkFile = path.join(linkDir, `blink_${safeSender}.js`);
            const fileContent = `module.exports = ${JSON.stringify({ metadata: { title, language, duration, imdb, genres, directors: [], stars: [], summary, thumbnail }, downloadLinks: finalLinks }, null, 2)};`;
            fs.writeFileSync(blinkFile, fileContent);
          } catch (_) { }

          return {
            metadata: { title, language, duration, imdb, genres, directors: [], stars: [], summary, thumbnail },
            downloadLinks: finalLinks
          };
        }
      }
    }
  } catch (err) {
    console.log("[Baiscope] Fast details failed, falling back to browser:", err.message);
  }

  // Tier 2: Headless Browser Fallback
  const browser = await getBrowser();
  if (!browser) return null;
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url().toLowerCase();
    const isAd = /ads|google-analytics|doubleclick|popunder|onclickads|bet365|1xbet/i.test(url);
    if (['image', 'stylesheet', 'font', 'media', 'other'].includes(type) || isAd) {
      req.abort().catch(() => { });
    } else {
      req.continue().catch(() => { });
    }
  });

  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    await page.goto(movieUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });

    await page.waitForSelector(".title a, h1, .post-title, table", { timeout: 10000 }).catch(() => { });
    await new Promise(r => setTimeout(r, 1000));

    const data = await page.evaluate(() => {
      const getText = el => el?.textContent.trim() || "";
      const title = getText(document.querySelector(".entry-title, .title a, h1"));

      const container = document.querySelector("#dt_contenedor, #single, .post-content");
      // Improved: Join multiple paragraphs for a complete summary
      const summaryEls = document.querySelectorAll("#dt_contenedor [itemprop='description'].wp-content p, #dt_contenedor [itemprop='description'] p, .plot p, .entry-content p");
      let summary = Array.from(summaryEls).map(p => p.textContent.trim()).filter(t => t.length > 50).join("\n\n");
      if (!summary) summary = getText(document.querySelector("#dt_contenedor [itemprop='description'], .plot, .entry-content p")) || "No summary available.";


      let language = "N/A", duration = "N/A", imdb = "N/A", directors = [], stars = [];

      // Scan specifically within the container for labels
      if (container) {
        // Find the summary element to exclude it from info scan
        const summaryEl = document.querySelector("#dt_contenedor [itemprop='description'].wp-content, #dt_contenedor [itemprop='description']");

        container.querySelectorAll("p, div, li, span, b, strong").forEach(el => {
          if (summaryEl && summaryEl.contains(el)) return; // Skip summary content

          const txt = el.textContent.trim();
          const parentTxt = el.parentElement?.textContent.trim() || "";

          if (txt.includes("භාෂාව") || txt.includes("Language")) {
            const val = txt.split(":")[1]?.trim() || el.nextSibling?.textContent?.trim() || parentTxt.split(":")[1]?.trim();
            if (val && val.length < 50) language = val;
          }
          if (txt.includes("කාලය") || txt.includes("ධාවන කාලය") || txt.includes("Runtime") || txt.includes("Duration")) {
            const val = txt.split(":")[1]?.trim() || el.nextSibling?.textContent?.trim() || parentTxt.split(":")[1]?.trim();
            // Ensure it's not a long paragraph and contains numbers (like '120 min')
            if (val && val.length < 50 && /\d/.test(val)) duration = val;
          }
          if (txt.includes("IMDb") || txt.includes("අගය") || txt.includes("Rating")) {
            const val = txt.split(":")[1]?.trim() || el.nextSibling?.textContent?.trim() || parentTxt.split(":")[1]?.trim();
            if (val && /\d/.test(val)) imdb = val.match(/\d(\.\d)?/)?.[0] || val;
          }
        });
      }

      // Cleanup
      language = language.replace(/:/g, "").trim();
      duration = duration.replace(/:/g, "").trim();
      if (language === "N/A" || !language) language = "Sinhala Sub";

      const genres = Array.from(document.querySelectorAll(".category a, .genres a, .genre a")).map(el => el.textContent.trim()).slice(0, 3);

      // Robust thumbnail extraction prioritizing itemprop="image"
      const posterImg = document.querySelector("img[itemprop='image'], .single_post_featured_img img, img.wp-post-image, #dt_contenedor img article img");
      const posterMeta = document.querySelector("meta[itemprop='image'], meta[property='og:image']");
      let thumbnail = posterImg ? (posterImg.getAttribute('data-src') || posterImg.getAttribute('data-lazy-src') || posterImg.src || "") : "";
      if ((!thumbnail || thumbnail.includes('Logo')) && posterMeta) {
        thumbnail = posterMeta.getAttribute('content') || thumbnail;
      }

      const links = [];
      const seen = new Set();

      document.querySelectorAll("table").forEach(table => {
        let qualityCol = -1, sizeCol = -1;
        table.querySelectorAll("tr th").forEach((th, hIndex) => {
          const hText = (th.textContent || "").trim().toLowerCase();
          if (hText.includes("quality")) qualityCol = hIndex;
          else if (hText.includes("size")) sizeCol = hIndex;
        });

        table.querySelectorAll("tr").forEach(row => {
          try {
            const a = row.querySelector("a[href*='/links'], a[href*='goto'], a[href*='pixeldrain'], a[href*='drive.google'], a[href*='workers.dev']");
            const href = a?.href || "";
            if (!href || seen.has(href)) return;
            if (href.includes("t.me") || href.includes("telegram")) return;

            const cells = Array.from(row.querySelectorAll("td"));
            if (!cells.length) return;

            let extractedQuality = "";
            let extractedSize = "";
            let sourceName = a.textContent?.trim() || "Direct Link";

            cells.forEach((td, cIndex) => {
              const text = td.textContent?.trim() || "";
              if (!text) return;
              if (cIndex === sizeCol) extractedSize = text;
              else if (cIndex === qualityCol) extractedQuality = text;

              if (!extractedSize && /\b\d+(\.\d+)?\s*(GB|MB)\b/i.test(text)) {
                extractedSize = text.match(/\b\d+(\.\d+)?\s*(GB|MB)\b/i)[0];
              }
              if (!extractedQuality && /\b(2160p|4k|1080p|720p|480p|360p|FHD|HD|SD)\b/i.test(text) && !text.includes("GB") && !text.includes("MB")) {
                extractedQuality = text;
              }
            });

            if (extractedSize.toUpperCase().includes("KB") || sourceName.toLowerCase().includes("subtitle")) return;

            seen.add(href);

            const fullRowText = row.innerText || "";
            let quality = "";
            const qMatch = (extractedQuality || fullRowText).toUpperCase();
            if (qMatch.includes("2160") || qMatch.includes("4K")) quality = "4K UHD";
            else if (qMatch.includes("1080") || qMatch.includes("FHD")) quality = "1080p FHD";
            else if (qMatch.includes("720") || qMatch.includes("HD")) quality = "720p HD";
            else if (qMatch.includes("480") || qMatch.includes("SD")) quality = "480p SD";
            else if (qMatch.includes("360")) quality = "360p Low";
            else if (extractedSize) {
              const sizeMatch = extractedSize.match(/(\d+(\.\d+)?)\s*(GB|MB)/i);
              if (sizeMatch) {
                const val = parseFloat(sizeMatch[1]);
                const mb = sizeMatch[3].toUpperCase() === "GB" ? val * 1024 : val;
                if (mb >= 2500) quality = "1080p FHD";
                else if (mb >= 950) quality = "720p HD";
                else quality = "480p SD";
              }
            }
            if (!quality) quality = "720p HD";

            const size = extractedSize || "N/A";
            let source = "Direct Link";
            const hLower = href.toLowerCase();
            const sLower = sourceName.toLowerCase();
            if (hLower.includes("pixeldrain") || sLower.includes("pixeldrain")) source = "Pixeldrain";
            else if (hLower.includes("drive.google") || sLower.includes("g-drive")) source = "G-Drive";
            else if (hLower.includes("usersdrive") || sLower.includes("usersdrive")) source = "UsersDrive";
            else if (sLower.includes("filespayout")) source = "FilesPayout";
            else if (sLower.includes("akirabox")) source = "AkiraBox";
            else if (sLower.includes("dlserver-01")) source = "DLServer-01";
            else if (sLower.includes("dlserver-02")) source = "DLServer-02";

            let priority = 50;
            if (source === "Pixeldrain") priority = 1;
            else if (source.includes("DLServer")) priority = 2;
            else if (source === "AkiraBox") priority = 3;
            else if (source === "FilesPayout") priority = 4;
            else if (source === "Direct Link") priority = 5;

            if (quality.includes("1080")) priority += 0.1;
            else if (quality.includes("720")) priority += 0.2;
            else if (quality.includes("480")) priority += 0.3;

            links.push({ pageLink: href, quality, size, source, link: href, priority });
          } catch (e) { }
        });
      });

      // Backup for other tables/links
      if (links.length === 0) {
        document.querySelectorAll("a[href]").forEach(a => {
          const href = a.href;
          if (!href || seen.has(href)) return;
          if (!/pixeldrain|drive|google|usersdrive|links|goto|mega|gdtot|hubcloud|direct|download/i.test(href)) return;
          seen.add(href);
          links.push({ pageLink: href, quality: "720p", size: "N/A", source: "Link", link: href, priority: 10 });
        });
      }
      return { metadata: { title, language, duration, imdb, genres, directors, stars, summary, thumbnail }, links };
    });

    if (!data || !data.links || data.links.length === 0) return null;

    // Filter and Sort Links
    let validLinks = data.links.filter(l => {
      const sizeText = (l.size || "").toUpperCase();
      let sizeMB = 0;
      if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
      else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);
      return isNaN(sizeMB) || sizeMB <= 4096; // 4GB limit
    });

    if (validLinks.length === 0) validLinks = data.links; // Fallback to all if none under limit

    validLinks.sort((a, b) => a.priority - b.priority);

    const finalLinks = validLinks.slice(0, 4);

    // Save to user-specific blink file for concurrency safety
    try {
      const linkDir = path.join(__dirname, "link");
      if (!fs.existsSync(linkDir)) fs.mkdirSync(linkDir, { recursive: true });
      const safeSender = sender ? sender.split('@')[0] : 'default';
      const blinkFile = path.join(linkDir, `blink_${safeSender}.js`);
      const fileContent = `module.exports = ${JSON.stringify({ metadata: data.metadata, downloadLinks: finalLinks }, null, 2)};`;
      fs.writeFileSync(blinkFile, fileContent);
    } catch (err) {
      console.log("[Storage Error] Could not write to user-specific blink file:", err.message);
    }

    return { metadata: data.metadata, downloadLinks: finalLinks };

  } catch (e) {
    return null;
  } finally {
    startAutoCloseTimer();
    if (page) await page.close().catch(() => { });
  }
}

module.exports = {
  name: "baiscop",
  aliases: ["baiscopes", "baiscope",],
  category: "downloader",
  description: "Advanced baiscopes.lk Movie Downloader",
  async execute(sock, msg, from, args, cmdName, context) {
    if (!global.baiscopeSearchCache) global.baiscopeSearchCache = {};
    if (!global.baiscopeQualityCache) global.baiscopeQualityCache = {};

    try {
      const prefix = context.prefix || ".";
      const sender = context.sender || msg.key.participant || msg.key.remoteJid;
      let mode = "search";
      let selection = null;
      if (args && args.length >= 2) {
        if (args[0] === "getmovie") { mode = "getmovie"; selection = args[1]; }
        else if (args[0] === "dlmovie") { mode = "dlmovie"; selection = args[1]; }
      }
      const tCtx = { sender, ownerRefs: context.ownerRefs || (context.owner ? [context.owner] : []) };

      if (mode === "search" && !args?.join(" ").trim()) {
        let usage = "╔════════════════════════╗\n";
        usage += "║     🎬 𝐁𝐀𝐈𝐒𝐂𝐎𝐏𝐄𝐒 𝐒𝐄𝐀𝐑𝐂𝐇     ║\n";
        usage += "╚════════════════════════╝\n\n";
        usage += "╭━━━━━〔 ᴜsᴀɢᴇ 〕━━━━━\n";
        usage += "┃ 📝 Command : " + prefix + "baiscop <name>\n";
        usage += "╰━━━━━━━━━━━━━━━━━━━━━━\n";
        usage += themeMgr.getSignature(sender, tCtx.ownerRefs);
        return sock.sendMessage(from, { text: usage }, { quoted: msg });
      }

      if (mode === "search") {
        const query = args.join(" ").trim();
        // Clear previous caches for this sender to prevent numeric conflicts
        delete global.baiscopeSearchCache[sender];
        delete global.baiscopeQualityCache[sender];

        await sendReact(sock, from, msg, "🎬");
        msgMgr.sendTemp(sock, from, "🔍 *𝐒𝐄𝐀𝐑𝐂𝐇𝐈𝐍𝐆 𝐁𝐀𝐈𝐒𝐂𝐎𝐏𝐄𝐒...* 🎬📽️🍿", 3500);
        const results = await baiscopeSearch(query);
        if (!results.length) {
          await sendReact(sock, from, msg, "❌");
          return sock.sendMessage(from, { text: "❌ No movies found! Try a different name." }, { quoted: msg });
        }
        global.baiscopeSearchCache[sender] = { results, timestamp: Date.now() };
        const menuItems = results.map((m, i) => ({
          label: truncate(m.title, 35),
          title: truncate(m.title, 35),
          description: `${m.language} | ${m.quality}`,
          action: `menu:cmd:baiscop:getmovie:${i + 1}`
        }));
        let listMsg = "╔════════════════════════╗\n";
        listMsg += "║    ✨ 🎬 𝐒𝐄𝐀𝐑𝐂𝐇 𝐑𝐄𝐒𝐔𝐋𝐓𝐒 ✨     ║\n";
        listMsg += "╚════════════════════════╝\n";
        listMsg += "╭━━━━━〔 ᴀᴠᴀɪʟᴀʙʟᴇ ᴍᴏᴠɪᴇꜱ 〕━━━━━\n";
        results.forEach((m, i) => {
          listMsg += `┃ 🌸 ${i + 1}. ${m.title}\n`;
          listMsg += `   📝 Language: ${m.language}\n`;
        });
        listMsg += "╰━━━━━━━━━━━━━━━━━━━━━━\n\n";
        listMsg += "👉 *Reply with the number* to get details.\n";
        listMsg += themeMgr.getSignature(sender, tCtx.ownerRefs);
        const menuMsg = await ui.sendMenu(sock, from, { title: "BAISCOPES SEARCH", body: listMsg, items: menuItems, type: "results" }, { quoted: msg }, { ...context, sender });

        // Store the menu message ID to verify replies later
        global.baiscopeSearchCache[sender].menuId = menuMsg.key.id;

        await new Promise(r => setTimeout(r, 500));
        await sendReact(sock, from, msg, "✅");
        return;
      }

      if (mode === "getmovie") {
        const num = parseInt(selection);
        const cache = global.baiscopeSearchCache[sender];
        if (!cache || isNaN(num) || num < 1 || num > cache.results.length) return;
        const selected = cache.results[num - 1];
        delete global.baiscopeSearchCache[sender];
        delete global.baiscopeQualityCache[sender]; // Clear old quality cache before fetching new one

        await sendReact(sock, from, msg, "📥");
        const temp = await sock.sendMessage(from, { text: `🎬 *𝐏𝐑𝐄𝐏𝐀𝐑𝐈𝐍𝐆 𝐌𝐎𝐕𝐈𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒...* ⏳✨🍿` }, { quoted: msg });
        const details = await baiscopeGetDetails(selected.url, sender);
        if (!details || !details.metadata) {
          await sendReact(sock, from, msg, "❌");
          await sock.sendMessage(from, { delete: temp.key });
          return sock.sendMessage(from, { text: "❌ Failed to fetch movie details. Site may be slow." }, { quoted: msg });
        }
        const { metadata, downloadLinks } = details;
        global.baiscopeQualityCache[sender] = { movie: { metadata, downloadLinks }, timestamp: Date.now() };
        let replyMsg = "╔════════════════════════╗\n";
        replyMsg += `║   🎬 ${truncate(metadata.title, 20)}   ║\n`;
        replyMsg += "╚════════════════════════╝\n\n";
        replyMsg += "╭━━━━━〔 🎬 MOVIE INFO 〕━━━━━\n";
        replyMsg += `┃ 📝 Language : ${metadata.language}\n`;
        replyMsg += `┃ ⏱️ Time : ${metadata.duration}\n`;
        replyMsg += `┃ ⭐ IMDb Rating : ${metadata.imdb}\n`;
        replyMsg += "┃\n";
        replyMsg += "┃ 📝 SUMMARY (සිංහල)\n";
        replyMsg += `┃ ${truncate(metadata.summary, 500)}\n`;
        replyMsg += "╰━━━━━━━━━━━━━━━━━━━━━━\n\n";



        replyMsg += themeMgr.getSignature(sender, tCtx.ownerRefs);
        await sock.sendMessage(from, { delete: temp.key });
        if (metadata.thumbnail && metadata.thumbnail.startsWith('http')) {
          await sock.sendMessage(from, { image: { url: metadata.thumbnail }, caption: replyMsg }, { quoted: msg }).catch(async () => { await sock.sendMessage(from, { text: replyMsg }, { quoted: msg }); });
        } else { await sock.sendMessage(from, { text: replyMsg }, { quoted: msg }); }

        if (downloadLinks.length) {
          // STRICT INSTRUCTION: Build the menu directly from what was saved to the user's blink file
          let savedLinks = [];
          try {
            const safeSender = sender ? sender.split('@')[0] : 'default';
            const blinkFile = path.join(__dirname, "link", `blink_${safeSender}.js`);
            if (fs.existsSync(blinkFile)) {
              delete require.cache[require.resolve(blinkFile)];
              const savedData = require(blinkFile);
              savedLinks = savedData.downloadLinks || [];
            } else {
              savedLinks = downloadLinks;
            }
          } catch (err) {
            savedLinks = downloadLinks; // Fallback to raw links if file read fails
          }

          if (savedLinks.length === 0) {
            await sendReact(sock, from, msg, "⚠️");
            return sock.sendMessage(from, { text: "⚠️ *NO DOWNLOAD LINKS FOUND!*" }, { quoted: msg });
          }

          const menuItems = savedLinks.map((l, i) => ({
            label: `${l.quality} (${l.size})`,
            title: `${l.quality} (${l.size})`,
            description: `Download ${l.quality} - ${l.size}`,
            action: `menu:cmd:baiscop:dlmovie:${i + 1}`
          }));

          let dlMsg = "╔════════════════════════╗\n";
          dlMsg += "║   📥 DOWNLOAD OPTIONS   ║\n";
          dlMsg += "╚════════════════════════╝\n";
          dlMsg += "╭━━━━━〔 📥 QUALITY SELECT 〕━━━━━\n";
          savedLinks.forEach((l, i) => {
            dlMsg += `┃ 🌸 ${i + 1}. ${l.quality} (${l.size})\n`;
          });
          dlMsg += "╰━━━━━━━━━━━━━━━━━━━━━━\n\n";
          dlMsg += "👉 *Reply with the number* to download.\n";
          dlMsg += themeMgr.getSignature(sender, tCtx.ownerRefs);

          const qualityMenu = await ui.sendMenu(sock, from, { title: "DOWNLOAD QUALITY", body: dlMsg, items: menuItems, type: "quality" }, { quoted: msg }, { ...context, sender });

          global.baiscopeQualityCache[sender] = { menuId: qualityMenu.key.id, timestamp: Date.now() };

          await new Promise(r => setTimeout(r, 500));
          await sendReact(sock, from, msg, "✅");
        } else {
          await sendReact(sock, from, msg, "⚠️");
          await sock.sendMessage(from, { text: "❌ *𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐋𝐈𝐍𝐊𝐒 𝐍𝐎𝐓 𝐅𝐎𝐔𝐍𝐃!* ✨" }, { quoted: msg });
        }
        return;
      }

      if (mode === "dlmovie") {
        const num = parseInt(selection);

        // Read links from user-specific blink file
        let cache = null;
        try {
          const safeSender = sender ? sender.split('@')[0] : 'default';
          const blinkFile = path.join(__dirname, "link", `blink_${safeSender}.js`);
          if (fs.existsSync(blinkFile)) {
            delete require.cache[require.resolve(blinkFile)];
            cache = require(blinkFile);
          }
        } catch (err) {
          console.log("[Storage Error] Could not read user-specific blink file:", err.message);
        }

        if (!cache || !cache.downloadLinks || isNaN(num) || num < 1 || num > cache.downloadLinks.length) return;
        delete global.baiscopeQualityCache[sender];

        const selected = cache.downloadLinks[num - 1];
        const sizeText = (selected.size || "").toUpperCase();
        let sizeMB = 0;
        if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
        else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);

        if (sizeMB > 4096) {
          await sendReact(sock, from, msg, "⚠️");
          return sock.sendMessage(from, { text: `⚠️ *UPARIMA DARITHAVA 4GB!* 🚀✨\n\nමෙම වීඩියෝව WhatsApp සීමාව (4GB) ඉක්මවා ඇත.` }, { quoted: msg });
        }

        await sendReact(sock, from, msg, "⏳");

        const browser = await getBrowser();
        let statusMsg = null;
        const resolved = await baiscopeResolveLink(browser, selected, async (remaining) => {
          let waitText = "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n";
          waitText += `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n`;
          waitText += `┃ ලින්ක් එක ජෙනරේට් වන තුරු තත්පර ${remaining}ක් \n`;
          waitText += "┃ රැඳී සිටින්න. \n";
          waitText += "╰━━━━━━━━━━━━━━━━━━━━━━";

          if (!statusMsg) {
            statusMsg = await sock.sendMessage(from, { text: waitText }, { quoted: msg });
          } else {
            await sock.sendMessage(from, { text: waitText, edit: statusMsg.key }).catch(() => { });
          }
        });

        if (!resolved || !resolved.link) {
          await sendReact(sock, from, msg, "⚠️");
          const errorMsg = "⚠️ කණගාටුයි, එම ලින්ක් එක හරහා චිත්‍රපටය ලබා ගැනීමට නොහැකි විය. වෙනත් ලින්ක් එකක් උත්සාහ කරන්න.";
          if (statusMsg) await sock.sendMessage(from, { text: errorMsg, edit: statusMsg.key });
          else await sock.sendMessage(from, { text: errorMsg }, { quoted: msg });
          return;
        }

        const actualLink = resolved.link;
        let directUrl = getDirectPixeldrainUrl(actualLink);
        // Pixeldrain list URLs (/l/<id>) cannot be uploaded directly — fetch
        // the list and pick the largest video file inside it. This used to
        // fall through and produce a few-KB "file_not_found" JSON upload.
        if (actualLink && /pixeldrain\.com\/l\//i.test(actualLink)) {
          const fromList = await resolvePixeldrainListUrl(actualLink);
          if (fromList) directUrl = fromList;
        }
        if (!directUrl && (actualLink.includes('.mp4') || actualLink.includes('.mkv') || actualLink.includes('/api/file/'))) {
          directUrl = actualLink;
        }

        let downloadText = "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n";
        downloadText += `┃ 🎬 𝐌𝐨𝐯ｉ𝐞 : ${truncate(cache.metadata.title, 20)}\n`;
        downloadText += "┃ 📥 ඔබේ චිත්‍රපටය ඩවුන්ලෝඩ් වෙමින් \n";
        downloadText += "┃    පවතී. මදක් රැඳී සිටින්න... \n";
        downloadText += "╰━━━━━━━━━━━━━━━━━━━━━━";

        if (statusMsg) {
          await sock.sendMessage(from, { text: downloadText, edit: statusMsg.key });
        } else {
          statusMsg = await sock.sendMessage(from, { text: downloadText }, { quoted: msg });
        }

        // Clear user-specific blink file as requested now that we have the link
        try {
          const safeSender = sender ? sender.split('@')[0] : 'default';
          const blinkFile = path.join(__dirname, "link", `blink_${safeSender}.js`);
          if (fs.existsSync(blinkFile)) fs.writeFileSync(blinkFile, 'module.exports = {};');
        } catch (err) { }

        if (directUrl) {
          // ---- URL validation: probe the resolved URL before handing it
          // to Baileys. Without this, an HTML "redirect" / "ad" / "error"
          // page (or pixeldrain's `file_not_found` JSON) would happily
          // upload as a few-KB document with mimetype video/mp4 — this is
          // exactly the "podi auwala" the user reported.
          const probe = await probeDirectVideoUrl(directUrl);
          const finalProbedUrl = probe.finalUrl || directUrl;
          const looksLikeVideoByName = VIDEO_EXT_RE.test(finalProbedUrl)
            || finalProbedUrl.includes('/api/file/')
            || finalProbedUrl.includes('pixeldrain.com');
          const isVideo = probe.ok && (looksLikeVideoContentType(probe.contentType) || looksLikeVideoByName);
          const tooSmall = probe.ok && probe.contentLength > 0 && probe.contentLength < MIN_VIDEO_BYTES;

          if (!probe.ok || !isVideo || tooSmall) {
            const reason = !probe.ok
              ? "URL නොලැබේ / unreachable"
              : tooSmall
                ? `ගොනුව කුඩාය (${(probe.contentLength / 1024).toFixed(0)} KB)`
                : `වීඩියෝ අන්තර්ගතයක් නොවේ (${probe.contentType || 'unknown'})`;
            console.warn(`[Baiscope] Aborting upload — probe failed: ${reason}; url=${finalProbedUrl}`);
            const failText =
              "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
              `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
              "┃ ⚠️ *DOWNLOAD LINK INVALID!*\n" +
              `┃ ${reason}\n` +
              "┃ වෙනත් quality එකක් උත්සාහ කරන්න.\n" +
              "╰━━━━━━━━━━━━━━━━━━━━━━\n" +
              `🔗 *Manual Link:* ${actualLink}`;
            if (statusMsg) await sock.sendMessage(from, { text: failText, edit: statusMsg.key });
            else await sock.sendMessage(from, { text: failText }, { quoted: msg });
            await sendReact(sock, from, msg, "⚠️");
            return;
          }
          if (probe.finalUrl && probe.finalUrl !== directUrl) directUrl = probe.finalUrl;

          // ---- Memory pre-flight: refuse to start an upload that will OOM
          // the host. Baileys buffers the *entire* encrypted payload in RAM
          // (see node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js
          // → getWAUploadToServer), so on Railway's 512 MB free tier even a
          // 400 MB movie can crash the process. Cap from heap size, with a
          // BAISCOPE_MAX_UPLOAD_MB override.
          const probedBytes = probe.contentLength || 0;
          const maxUploadBytes = getEffectiveMaxUploadBytes();
          if (probedBytes > 0 && probedBytes > maxUploadBytes) {
            const sizeMB = (probedBytes / (1024 * 1024)).toFixed(2);
            const capMB = (maxUploadBytes / (1024 * 1024)).toFixed(0);
            console.log(`[Baiscope] File ${sizeMB} MB exceeds direct upload limit (${capMB} MB). Sending direct link.`);
            const limitText =
              "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
              `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
              "┃ 📦 *FILE EXCEEDS 1.7 GB LIMIT*\n" +
              `┃ 📦 ගොනු ප්‍රමාණය : ${sizeMB} MB\n` +
              "┃ ⚠️ WhatsApp උපරිම සීමාව (1.7 GB) ඉක්මවා ඇති බැවින්\n" +
              "┃    පහත Direct Download Link එකෙන් බාගත කරන්න:\n" +
              "╰━━━━━━━━━━━━━━━━━━━━━━\n\n" +
              `🔗 *Direct Download Link:*\n${directUrl || actualLink}`;
            if (statusMsg) await sock.sendMessage(from, { text: limitText, edit: statusMsg.key });
            else await sock.sendMessage(from, { text: limitText }, { quoted: msg });
            await sendReact(sock, from, msg, "🔗");
            return;
          }

          // Free Chrome/Puppeteer (200-400 MB resident) and trigger a GC
          // before we start the actual transfer, so Baileys' upload buffer
          // has room.
          await closeGlobalBrowser();
          tryGc();

          const fileName = `${cache.metadata.title.substring(0, 50)} - ${selected.quality}.mp4`.replace(/[^\w\s.-]/gi, '');
          const uid = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const tempFile = path.join(DOWNLOAD_DIR, `baiscope_${uid}.mp4`);
          let response = null;

          try {
            // High-Speed Cloud Data Worker Offloading (0 MB PC Data consumption)
            let workerTimer = null;
            if (CLOUD_WORKER_URL) {
              const workerTxt =
                "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
                `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
                `┃ 📊 Quality : ${selected.quality}\n` +
                "┃ ⚡ *CLOUD SERVER DOWNLOAD* 🚀\n" +
                "┃ 📥 Cloud Server එකට බාගත වෙමින් පවතී...\n" +
                "┃ 💾 (ඔබගේ පරිගණකයේ Data: 0 MB!)\n" +
                "╰━━━━━━━━━━━━━━━━━━━━━━";
              await sock.sendMessage(from, { text: workerTxt, edit: statusMsg.key }).catch(() => { });

              let workerSeconds = 0;
              const { progressBar } = require('../premium');
              workerTimer = setInterval(() => {
                workerSeconds += 3;
                try {
                  const p = Math.min(95, Math.floor(workerSeconds * 4));
                  const bar = progressBar(p, 100, 10);
                  const stage = workerSeconds < 12
                    ? "📥 Cloud Server එකට 1 Gbps Line එකෙන් බාගත වේ..."
                    : workerSeconds < 30
                      ? "⚙️ චිත්‍රපටය WhatsApp වෙත සූදානම් කරමින් පවතී..."
                      : "📤 WhatsApp වෙත Upload වෙමින් පවතී...";

                  const updateTxt =
                    "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
                    `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
                    `┃ 📊 Quality : ${selected.quality}\n` +
                    `┃ ⚡ *CLOUD SERVER DOWNLOAD* 🚀\n` +
                    `┃ 📊 *Progress:* ~${p}%\n` +
                    `┃ ${bar}\n` +
                    `┃ 🔄 *Status:* ${stage}\n` +
                    `┃ ⏱️ *Elapsed:* ${workerSeconds}s | ⚡ 1 Gbps Line\n` +
                    `┃ 💾 (ඔබගේ Data: 0 MB!)\n` +
                    "╰━━━━━━━━━━━━━━━━━━━━━━";
                  sock.sendMessage(from, { text: updateTxt, edit: statusMsg.key }).catch(() => {});
                } catch (_) {}
              }, 3000);

              const offloadRes = await offloadMediaToWorker({
                targetJid: from,
                downloadUrl: directUrl,
                fileName,
                caption: `🎬 *${cache.metadata.title}*\n📊 Quality: ${selected.quality}\n⚡ Delivered via High-Speed Cloud Data Worker!`,
                mimetype: 'video/mp4',
                document: true
              });

              if (workerTimer) clearInterval(workerTimer);

              if (offloadRes.offloaded) {
                await sendReact(sock, from, msg, "✅");
                await sock.sendMessage(from, { delete: statusMsg.key }).catch(() => { });
                return;
              }
              console.log('[Baiscope] Cloud worker offload fallback to local:', offloadRes.error || offloadRes.reason);
            }

            const startTxt =
              "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
              `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
              `┃ 📊 Quality : ${selected.quality}\n` +
              "┃ 📥 බාගත වීම ආරම්භ විය... 🚀\n" +
              "┃    මදක් රැඳී සිටින්න...\n" +
              "╰━━━━━━━━━━━━━━━━━━━━━━";
            await sock.sendMessage(from, { text: startTxt, edit: statusMsg.key }).catch(() => { });

            if (isMegaUrl(directUrl) || isMegaUrl(actualLink)) {
              const megaTargetUrl = isMegaUrl(directUrl) ? directUrl : actualLink;
              const megaTxt =
                "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
                `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
                `┃ 📊 Quality : ${selected.quality}\n` +
                "┃ ☁️ *MEGA.NZ DOWNLOAD DETECTED* 🚀\n" +
                "┃ 📥 Mega Server එකෙන් බාගත වෙමින් පවතී...\n" +
                "╰━━━━━━━━━━━━━━━━━━━━━━";
              await sock.sendMessage(from, { text: megaTxt, edit: statusMsg.key }).catch(() => { });

              let lastMegaProgress = 0;
              await downloadMegaFile(megaTargetUrl, tempFile, async (p) => {
                const now = Date.now();
                if (now - lastMegaProgress > 3500) {
                  lastMegaProgress = now;
                  const bar = progressBar(p.percent, 100, 10);
                  const updateText =
                    "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
                    `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
                    `┃ 📊 Quality : ${selected.quality}\n` +
                    `┃ 📥 *Downloading from Mega:* ${p.percent}%\n` +
                    `┃ ${bar}\n` +
                    `┃ ⚡ *Speed:* ${p.speed || 'High Speed'} (ETA: ${p.eta || 'Calculating...'})\n` +
                    "╰━━━━━━━━━━━━━━━━━━━━━━";
                  await sock.sendMessage(from, { text: updateText, edit: statusMsg.key }).catch(() => { });
                }
              });
            } else {
              response = await axios({
                method: 'GET',
                url: directUrl,
                responseType: 'stream',
                timeout: 3600000, // 1 Hour Safety Timeout
                headers: getDownloadHeaders(directUrl, 'https://baiscopes.lk/')
              });

              const totalBytes = parseInt(response.headers['content-length'] || "0", 10);

              if (totalBytes > maxUploadBytes) {
                try { response.data.destroy(); } catch (_) { }
                const sizeMB = (totalBytes / (1024 * 1024)).toFixed(2);
                const capMB = (maxUploadBytes / (1024 * 1024)).toFixed(0);
                console.log(`[Baiscope] File ${sizeMB} MB exceeds direct upload limit (${capMB} MB). Sending direct link.`);
                const limitText =
                  "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
                  `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
                  "┃ 📦 *FILE EXCEEDS 1.7 GB LIMIT*\n" +
                  `┃ 📦 ගොනු ප්‍රමාණය : ${sizeMB} MB\n` +
                  "┃ ⚠️ WhatsApp උපරිම සීමාව (1.7 GB) ඉක්මවා ඇති බැවින්\n" +
                  "┃    පහත Direct Download Link එකෙන් බාගත කරන්න:\n" +
                  "╰━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                  `🔗 *Direct Download Link:*\n${directUrl || actualLink}`;
                await sock.sendMessage(from, { text: limitText, edit: statusMsg.key }).catch(() => { });
                await sendReact(sock, from, msg, "🔗");
                return;
              }

              let downloadedBytes = 0;
              let lastUpdate = 0;
              const writer = fs.createWriteStream(tempFile);

              response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const now = Date.now();
                if (now - lastUpdate > 3500) {
                  lastUpdate = now;
                  const mbDownloaded = (downloadedBytes / (1024 * 1024)).toFixed(1);
                  let progressTxt = "";
                  if (totalBytes > 0) {
                    const p = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
                    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
                    const bar = progressBar(downloadedBytes, totalBytes, 10);
                    progressTxt = `\n┃ 📥 *Downloading:* ${p}%\n┃ ${bar}\n┃ 📦 *Size:* ${mbDownloaded} MB / ${totalMb} MB`;
                  } else {
                    progressTxt = `\n┃ 📥 *Downloading...*\n┃ 📦 *Downloaded:* ${mbDownloaded} MB`;
                  }
                  const updateText =
                    "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
                    `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
                    `┃ 📊 Quality : ${selected.quality}` +
                    progressTxt + "\n" +
                    "╰━━━━━━━━━━━━━━━━━━━━━━";
                  sock.sendMessage(from, { text: updateText, edit: statusMsg.key }).catch(() => { });
                }
              });

              await new Promise((resolve, reject) => {
                response.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.on('error', reject);
              });
            }

            if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < 10240) {
              throw new Error("Downloaded file is empty or corrupted.");
            }

            const finalSizeMB = (fs.statSync(tempFile).size / (1024 * 1024)).toFixed(1);
            const uploadText =
              "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
              `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.metadata.title, 20)}\n` +
              `┃ 📦 𝐒𝐢𝐳𝐞  : ${finalSizeMB} MB\n` +
              "┃ 📤 වට්ස්ඇප් වෙත උඩුගත වෙමින් පවතී...\n" +
              "┃    මදක් රැඳී සිටින්න... \n" +
              "╰━━━━━━━━━━━━━━━━━━━━━━";
            await sock.sendMessage(from, { text: uploadText, edit: statusMsg.key }).catch(() => { });

            // Upload via Baileys document from local file
            await sock.sendMessage(from, {
              document: { url: tempFile },
              fileName,
              mimetype: 'video/mp4',
              caption: `🎬 *${cache.metadata.title}*\n📊 Quality: ${selected.quality}\n💾 Size: ${finalSizeMB} MB\n📡 Source: ${selected.source}\n\n*CHATHU-MD V4*`
            }, { quoted: msg });

            await sock.sendMessage(from, { delete: statusMsg.key }).catch(() => { });
            await sendReact(sock, from, msg, "✅");
            console.log(`[Baiscope] Upload finished: ${cache.metadata.title}`);
          } catch (err) {
            console.error("[Baiscope] Download/Upload Error:", err && err.message ? err.message : err);
            if (response && response.data) {
              try { response.data.destroy(); } catch (_) { }
            }
            await sock.sendMessage(from, { text: `❌ *𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐅𝐀𝐈𝐋Ε𝐃!* ✨\n\nබෝට් එක හරහා එවීමට අපොහොසත් විය.\n${err && err.message && err.message.includes('small') ? "⚠️ සබැඳිය (Link) වීඩියෝවක් නොවන බැවින් බෝට් එක මඟින් එය ප්‍රතික්ෂේප කරන ලදී." : ""}\n🔗 *Manual Link:* ${actualLink}`, edit: statusMsg.key });
            await sendReact(sock, from, msg, "❌");
          } finally {
            if (tempFile && fs.existsSync(tempFile)) {
              try { fs.unlinkSync(tempFile); } catch (_) { }
            }
            if (global.baiscopeSearchCache) {
              try {
                const keys = Object.keys(global.baiscopeSearchCache);
                if (keys.length > 5) {
                  for (const k of keys.slice(0, keys.length - 5)) {
                    delete global.baiscopeSearchCache[k];
                  }
                }
              } catch (_) { }
            }
            tryGc();
          }
        } else {
          await sock.sendMessage(from, { text: `⚠️ *BOT DOWNLOAD NOT SUPPORTED!* 🚀✨\n\nමෙම ලින්ක් එක බෝට් එක හරහා එවිය නොහැක.\n🔗 *Manual Link:* ${actualLink}`, edit: statusMsg.key });
          await sendReact(sock, from, msg, "⚠️");
        }
      }
    } catch (err) {
      console.log("[Movie] Main Execution Error:", err.message);
    }
  },

  async onMessage({ sock, from, msg, text, sender, isOwner }) {
    if (!text) return;
    const num = parseInt(text.trim());
    if (isNaN(num)) return;

    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    const quoted = extractQuotedContext(msg);
    const quotedId = quoted.stanzaId;

    if (global.baiscopeQualityCache && global.baiscopeQualityCache[sender]) {
      const cache = global.baiscopeQualityCache[sender];
      const isQuoted = quotedId && (quotedId === cache.menuId || quoted.text?.includes("MOVIE INFO") || quoted.text?.includes("DOWNLOAD OPTIONS"));
      const isRecent = (now - cache.timestamp) < timeout;
      if ((isQuoted || (!quotedId && isRecent)) && num >= 1) {
        console.log(`[Movie Flow] Quality selection detected: ${num} for ${sender}`);
        await this.execute(sock, msg, from, ["dlmovie", num.toString()], "baiscop", { prefix: ".", sender });
        return true;
      }
    }

    if (global.baiscopeSearchCache && global.baiscopeSearchCache[sender]) {
      const cache = global.baiscopeSearchCache[sender];
      const isQuoted = quotedId && (quotedId === cache.menuId || quoted.text?.includes("SEARCH RESULTS") || quoted.text?.includes("AVAILABLE MOVIES"));
      const isRecent = (now - cache.timestamp) < timeout;
      if ((isQuoted || (!quotedId && isRecent)) && num >= 1 && num <= cache.results.length) {
        console.log(`[Movie Flow] Movie selection detected: ${num} for ${sender}`);
        await this.execute(sock, msg, from, ["getmovie", num.toString()], "baiscop", { prefix: ".", sender });
        return true;
      }
    }
  }
};