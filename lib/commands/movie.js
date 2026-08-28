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
const { DOWNLOAD_DIR } = require("../../config");
const { progressBar, formatSize } = require("../premium");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch (_) {}
}

let globalBrowser = null;
let browserCloseTimer = null;

function startAutoCloseTimer() {
  if (browserCloseTimer) clearTimeout(browserCloseTimer);
  browserCloseTimer = setTimeout(async () => {
    try {
      if (globalBrowser && globalBrowser.isConnected()) {
        await globalBrowser.close().catch(() => { });
        globalBrowser = null;
        console.log("[Movie] Browser auto-closed due to inactivity.");
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch (_) { }
        }
      }
    } catch (e) { }
  }, 15000);
}

async function getBrowser() {
  try {
    if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
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
  } catch (_) {}

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
    console.log("[Movie] Pixeldrain list resolve failed:", e.message);
    return null;
  }
}

async function sinhalasubSearch(query) {
  const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}`;

  // Fast Cheerio Scraper Tier
  try {
    const res = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    });

    if (res.status === 200 && res.data) {
      const $ = cheerio.load(res.data);
      const results = [];
      const seen = new Set();

      $(".display-item .item-box, .result-item, article, .item").each((index, el) => {
        const a = $(el).find("a").first();
        const href = a.attr("href");
        if (!href || seen.has(href)) return;
        seen.add(href);

        const title = a.attr("title")?.trim() || $(el).find("h2, h3, .title").text().trim() || a.text().trim();
        if (!title) return;

        const lang = $(el).find(".item-desc-giha .language, .language").text().trim() || "English";
        const quality = $(el).find(".item-desc-giha .quality, .quality").text().trim() || "HD";
        const img = $(el).find("img");
        const thumbnail = img.attr("src") || img.attr("data-src") || "";

        results.push({
          id: results.length + 1,
          title: title.replace(/\s+/g, ' '),
          url: href,
          language: lang,
          quality: quality,
          thumbnail
        });
      });

      if (results.length > 0) return results.slice(0, 10);
    }
  } catch (err) {
    console.log("[Movie] Fast sinhalasub search failed, falling back to browser:", err.message);
  }

  // Browser Fallback Tier
  const browser = await getBrowser();
  if (!browser) return [];
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
    await page.waitForSelector(".display-item .item-box", { timeout: 10000 }).catch(() => { });

    const results = await page.evaluate(() => {
      let boxes = Array.from(document.querySelectorAll(".display-item .item-box"));
      const found = [];
      boxes.slice(0, 10).forEach((box, index) => {
        const a = box.querySelector("a");
        if (!a || !a.href) return;
        const title = a.title?.trim() || a.textContent?.trim() || "";
        const lang = box.querySelector(".item-desc-giha .language, .language")?.textContent?.trim() || "English";
        const quality = box.querySelector(".item-desc-giha .quality, .quality")?.textContent?.trim() || "HD";
        const thumbnail = box.querySelector("img")?.src || "";
        found.push({ id: index + 1, title: title.replace(/\s+/g, ' '), url: a.href, language: lang, quality: quality, thumbnail });
      });
      return found;
    });
    return results;
  } catch (e) {
    return [];
  } finally {
    if (page) await page.close().catch(() => { });
  }
}

async function sinhalasubResolveLink(browser, linkData, onWait = null) {
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
    }, 45000);

    await subPage.setRequestInterception(true);
    let directDetected = null;
    let finalUrl = null;

    subPage.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) return;
      const url = req.url().toLowerCase();
      const isAd = /ads|analytics|doubleclick|popunder|1xbet|bet365/i.test(url);
      if (isAd) return req.abort().catch(() => { });

      const isVideoFile = (url.includes('.mp4') || url.includes('.mkv') || url.includes('ddl.sinhalasub.net') || (url.includes('/api/file/') && !url.includes('/thumbnail') && !url.includes('/gallery'))) && !url.includes('cdn-cgi');
      if (isVideoFile && !directDetected) {
          console.log("[Movie Scraper] Direct link detected in network flow:", url);
          directDetected = url;
      }
      req.continue().catch(() => { });
    });

    targetListener = async (target) => {
      try {
        const opener = await target.opener();
        if (!opener || opener.url() !== subPage.url()) return;

        const tUrl = target.url();
        const tType = target.type();
        if (tUrl && !directDetected) {
           const isDL = (tUrl.includes('pixeldrain.com') || tUrl.includes('drive.google') || tUrl.includes('drive.usercontent') || /\.(mp4|mkv|zip|rar|mp3)$/i.test(tUrl));
           if (isDL && !tUrl.includes('cdn-cgi')) {
              console.log("[Movie Scraper] Link caught from new target/popup:", tUrl);
              directDetected = tUrl;
           }
        }
        if (tType === 'page') {
          const newPage = await target.page().catch(() => null);
          if (newPage) {
            extraPages.push(newPage);
            newPage.on('response', response => {
              const rUrl = response.url();
              const contentType = (response.headers()['content-type'] || '').toLowerCase();
              const isDL = (contentType.includes('video/') || rUrl.includes('pixeldrain.com') || rUrl.includes('drive.google') || rUrl.includes('drive.usercontent') || /\.(mp4|mkv|zip|rar|mp3)$/i.test(rUrl)) && !rUrl.includes('workers.dev');
              if (isDL && !rUrl.includes('cdn-cgi') && !directDetected) {
                console.log("[Movie Scraper] Link detected in response headers:", rUrl);
                directDetected = rUrl;
              }
            });
          }
        }
      } catch (e) { }
    };
    browser.on('targetcreated', targetListener);

    console.log("[Movie Scraper] Navigating to protector page:", linkData.pageLink);
    await subPage.goto(linkData.pageLink, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => { });

    // 1. Instant check for zluFinalLink (Zetaflix Link Unlocker) and direct download elements
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const instantLink = await subPage.evaluate(() => {
        if (typeof window.zluFinalLink === "string" && window.zluFinalLink.startsWith("http")) {
          return window.zluFinalLink;
        }
        const html = document.documentElement.innerHTML;
        const match = html.match(/zluFinalLink\s*=\s*['"]([^'"]+)['"]/i);
        if (match && match[1]) return match[1];

        const target = document.querySelector("a#link, a.btn[href*='workers.dev'], a[href*='pixeldrain'], a[href*='ddl.sinhalasub'], a[href*='drive.google'], .link-redirector .wrapper .wait-done a, .wait-done a");
        return target && target.href ? target.href : null;
      }).catch(() => null);

      if (instantLink && (instantLink.includes('pixeldrain') || instantLink.includes('ddl.sinhalasub') || instantLink.includes('drive.google') || instantLink.includes('workers.dev'))) {
        console.log("✅ [SUCCESS] FOUND DIRECT LINK INSTANTLY:", instantLink);
        if (onWait) await onWait("SUCCESS").catch(() => { });
        directDetected = instantLink;
        break;
      }
    }

    // 2. Interactive button fallback (handles multi-step verification if needed)
    if (!directDetected) {
      console.log("[Movie Scraper] No instant link. Trying button interactions...");
      await subPage.evaluate(() => {
        const btnSelectors = ['#zlu-btn-1', '#zlu-btn-2', '#zlu-btn-3', '#zlu-btn-final', '#verify_button', '#download_button', '.wait-done a', 'button.btn-success', 'a.btn-success'];
        for (const sel of btnSelectors) {
          const el = document.querySelector(sel);
          if (el && !el.disabled && !el.classList.contains("zlu-btn-disabled")) { el.click(); }
        }
      }).catch(() => { });

      for (let j = 0; j < 4; j++) {
        await new Promise(r => setTimeout(r, 2000));
        const finalExtract = await subPage.evaluate(() => {
          if (typeof window.zluFinalLink === "string" && window.zluFinalLink.startsWith("http")) return window.zluFinalLink;
          const match = document.documentElement.innerHTML.match(/zluFinalLink\s*=\s*['"]([^'"]+)['"]/i);
          if (match && match[1]) return match[1];
          const target = document.querySelector("a#link, a[href*='pixeldrain'], a[href*='ddl.sinhalasub'], a[href*='drive.google'], a.wait-done a");
          return target && target.href ? target.href : null;
        }).catch(() => null);

        if (finalExtract && (finalExtract.includes('pixeldrain') || finalExtract.includes('ddl.sinhalasub') || finalExtract.includes('drive.google') || finalExtract.includes('workers.dev'))) {
          console.log("✅ [SUCCESS] LINK FOUND AFTER BUTTON CLICK:", finalExtract);
          if (onWait) await onWait("SUCCESS").catch(() => { });
          directDetected = finalExtract;
          break;
        }
      }
    }

    finalUrl = directDetected || subPage.url();
    if (finalUrl && (finalUrl.startsWith('about:') || finalUrl.startsWith('chrome-'))) finalUrl = null;

    if (finalUrl && (finalUrl.includes('sinhalasub.lk') || finalUrl.includes('protector') || finalUrl.includes('link-protector'))) {
      if (!finalUrl.includes('workers.dev')) {
        const extracted = await subPage.evaluate(() => {
          if (typeof window.zluFinalLink === "string" && window.zluFinalLink.startsWith("http")) return window.zluFinalLink;
          const match = document.documentElement.innerHTML.match(/zluFinalLink\s*=\s*['"]([^'"]+)['"]/i);
          if (match && match[1]) return match[1];
          const target = document.querySelector(".link-redirector .wrapper .wait-done a, .wait-done a, a[href*='pixeldrain'], a[href*='ddl.sinhalasub']");
          return target ? target.href : null;
        });
        if (extracted) finalUrl = extracted;
      }
    }

    if (finalUrl && (finalUrl.includes('sinhalasub.lk') || finalUrl.includes('protector')) && !finalUrl.includes('workers.dev')) {
      finalUrl = null;
    }

    if (finalUrl) {
      const lowUrl = finalUrl.toLowerCase();
      let resolvedSource = linkData.source;
      if (lowUrl.includes("pixeldrain")) resolvedSource = "Pixeldrain";
      else if (lowUrl.includes("drive.google") || lowUrl.includes("drive.usercontent")) resolvedSource = "G-Drive";
      else if (lowUrl.includes("usersdrive")) resolvedSource = "UsersDrive";
      else if (lowUrl.includes("mega.nz")) resolvedSource = "Mega";

      console.log("[Movie Scraper] Successfully resolved direct link:", finalUrl);
      return { link: finalUrl, quality: normalizeQuality(linkData.quality), size: linkData.size, source: resolvedSource };
    }
    console.log("[Movie Scraper] Failed to resolve a direct link.");
    return null;
  } catch (e) {
    return null;
  } finally {
    if (safetyTimeout) clearTimeout(safetyTimeout);
    if (browser && targetListener) browser.off('targetcreated', targetListener);
    startAutoCloseTimer();
    for (const p of extraPages) await p.close().catch(() => { });
    if (subPage) await subPage.close().catch(() => { });
  }
}

async function sinhalasubGetDetails(movieUrl) {
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

  // page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    // console.log("[Scraper] Navigating to movie page...");
    await page.goto(movieUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => { });

    await page.waitForSelector(".content-links, .link-pixeldrain, #download", { timeout: 10000 }).catch(() => { });
    await new Promise(r => setTimeout(r, 1000));

    const data = await page.evaluate(() => {
      const getText = el => el?.textContent.trim() || "";
      const title = getText(document.querySelector(".info-details .details-title h3, h1, .post-title"));
      let language = "N/A", directors = [], stars = [];

      document.querySelectorAll(".info-col p, p, li").forEach(p => {
        const strong = p.querySelector("strong");
        if (!strong) return;
        const txt = strong.textContent.trim();
        if (txt.includes("Language:")) language = strong.nextSibling?.textContent?.trim() || "";
        if (txt.includes("Director:")) directors = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
        if (txt.includes("Stars:")) stars = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
      });

      const duration = getText(document.querySelector(".info-details .data-views[itemprop='duration'], .runtime")) || "N/A";
      const imdb = getText(document.querySelector(".info-details .data-imdb, .imdb-rating"))?.replace("IMDb:", "").trim() || "N/A";
      const genres = Array.from(document.querySelectorAll(".details-genre a, .category a")).map(el => el.textContent.trim()).slice(0, 3);
      const summary = getText(document.querySelector(".plot, .description, .entry-content p"));
      const thumbnail = document.querySelector(".splash-bg img, .poster img")?.src || "";

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
            const href = a?.href || a?.getAttribute("data-link") || "";
            if (!href || seen.has(href)) return;
            if (href.includes("t.me") || href.includes("telegram")) return;

            const cells = Array.from(row.querySelectorAll("td"));
            if (!cells.length) return;

            let extractedQuality = "";
            let extractedSize = "";
            let sourceName = a.textContent?.trim() || "Server";

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
            let source = "Server";
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

      return { metadata: { title, language, duration, imdb, genres, directors, stars, summary, thumbnail }, links };
    });

    // Save strictly to link/slink.js as requested
    try {
      const linkDir = path.join(process.cwd(), "link");
      if (!fs.existsSync(linkDir)) fs.mkdirSync(linkDir, { recursive: true });
      
      const slinkFile = path.join(linkDir, "slink.js");
      const fileContent = `module.exports = ${JSON.stringify(data, null, 2)};`;
      fs.writeFileSync(slinkFile, fileContent);
    } catch (err) {
      console.log("[Storage Error] Could not write to link/slink.js:", err.message);
    }

    return { metadata: data.metadata, downloadLinks: data.links };

    if (!data.links.length) return { metadata: data.metadata, downloadLinks: [] };

    const directLinks = [];
    let validLinks = data.links.filter(l => {
      const q = (l.quality || "").toLowerCase();
      const isPreferred = (q.includes("720") || q.includes("480")) && !q.includes("1080");
      const sizeText = l.size.toUpperCase();
      let sizeMB = 0;
      if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
      else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);
      return isPreferred && sizeMB <= 4096;
    });

    if (validLinks.length === 0) {
      validLinks = data.links.filter(l => {
        const sizeText = l.size.toUpperCase();
        let sizeMB = 0;
        if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
        else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);
        return sizeMB <= 4096;
      });
    }

    const limitedLinks = validLinks.slice(0, 6);
    for (const [idx, l] of limitedLinks.entries()) {
      // console.log(`[Scraper] Resolving link ${idx + 1}/${limitedLinks.length}: ${l.source} (${l.quality})`);
      const res = await sinhalasubResolveLink(browser, l);
      if (res) {
        directLinks.push(res);
        if (directLinks.length >= 6) break;
      }
    }

    try {
      if (data.metadata.summary) {
        const translated = await translate(data.metadata.summary, { to: "si" }).catch(() => null);
        if (translated && translated[0]) data.metadata.summary = translated[0];
      }
    } catch (e) {
      console.log("[Movie] Translation Error:", e.message);
    }

    return { metadata: data.metadata, downloadLinks: directLinks };
  } catch (e) {
    return null;
  } finally {
    if (page) await page.close().catch(() => { });
  }
}

module.exports = {
  name: "movie",
  aliases: ["sinhalasub", "films", "cinema"],
  category: "downloader",
  description: "Advanced Sinhalasub.lk Movie Downloader",
  async execute(sock, msg, from, args, cmdName, context) {
    if (!global.sinhalasubSearchCache) global.sinhalasubSearchCache = {};
    if (!global.sinhalasubQualityCache) global.sinhalasubQualityCache = {};

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
        usage += "║    🎬 𝐒𝐈𝐍𝐇𝐀𝐋𝐀𝐒𝐔𝐁 𝐒𝐄𝐀𝐑𝐂𝐇    ║\n";
        usage += "╚════════════════════════╝\n\n";
        usage += "╭━━━━━〔 ᴜsᴀɢᴇ 〕━━━━━\n";
        usage += "┃ 📝 Command : " + prefix + "movie <name>\n";
        usage += "╰━━━━━━━━━━━━━━━━━━━━━━\n";
        usage += themeMgr.getSignature(sender, tCtx.ownerRefs);
        return sock.sendMessage(from, { text: usage }, { quoted: msg });
      }

      if (mode === "search") {
        const query = args.join(" ").trim();
        // Clear previous caches for this sender to prevent numeric conflicts
        delete global.sinhalasubSearchCache[sender];
        delete global.sinhalasubQualityCache[sender];

        await sendReact(sock, from, msg, "🎬");
        msgMgr.sendTemp(sock, from, "🔍 *𝐒𝐄𝐀𝐑𝐂𝐇𝐈𝐍𝐆 𝐒𝐈𝐍𝐇𝐀𝐋𝐀𝐒𝐔𝐁...* 🎬📽️🍿", 3500);
        const results = await sinhalasubSearch(query);
        if (!results.length) {
          await sendReact(sock, from, msg, "❌");
          return sock.sendMessage(from, { text: "❌ No movies found! Try a different name." }, { quoted: msg });
        }
        global.sinhalasubSearchCache[sender] = { results, timestamp: Date.now() };
        const menuItems = results.map((m, i) => ({
          label: truncate(m.title, 35),
          title: truncate(m.title, 35),
          description: `${m.language} | ${m.quality}`,
          action: `menu:cmd:movie:getmovie:${i + 1}`
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
        const menuMsg = await ui.sendMenu(sock, from, { title: "SINHALASUB SEARCH", body: listMsg, items: menuItems, type: "results" }, { quoted: msg }, { ...context, sender });

        // Store the menu message ID to verify replies later
        global.sinhalasubSearchCache[sender].menuId = menuMsg.key.id;

        await new Promise(r => setTimeout(r, 500));
        await sendReact(sock, from, msg, "✅");
        return;
      }

      if (mode === "getmovie") {
        const num = parseInt(selection);
        const cache = global.sinhalasubSearchCache[sender];
        if (!cache || isNaN(num) || num < 1 || num > cache.results.length) return;
        const selected = cache.results[num - 1];
        delete global.sinhalasubSearchCache[sender];
        delete global.sinhalasubQualityCache[sender];

        await sendReact(sock, from, msg, "📥");
        const temp = await sock.sendMessage(from, { text: `🎬 *𝐏𝐑𝐄𝐏𝐀𝐑𝐈𝐍𝐆 𝐌𝐎𝐕𝐈𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒...* ⏳✨🍿` }, { quoted: msg });
        const details = await sinhalasubGetDetails(selected.url);
        if (!details || !details.metadata) {
          await sendReact(sock, from, msg, "❌");
          await sock.sendMessage(from, { delete: temp.key });
          return sock.sendMessage(from, { text: "❌ Failed to fetch movie details. Site may be slow." }, { quoted: msg });
        }
        const { metadata, downloadLinks } = details;
        global.sinhalasubQualityCache[sender] = { movie: { metadata, downloadLinks }, timestamp: Date.now() };

        let replyMsg = "╔════════════════════════╗\n";
        replyMsg += `║   🎬 ${truncate(metadata.title, 20)}   ║\n`;
        replyMsg += "╚════════════════════════╝\n\n";
        replyMsg += "╭━━━━━〔 🎬 MOVIE INFO 〕━━━━━\n";
        replyMsg += `┃ 📝 Language : ${metadata.language}\n`;
        replyMsg += `┃ ⏱️ Duration : ${metadata.duration}\n`;
        replyMsg += `┃ ⭐ IMDb Rating : ${metadata.imdb}\n`;
        replyMsg += `┃ 🎭 Genres : ${metadata.genres.join(", ")}\n`;
        replyMsg += `┃ 🎥 Director : ${metadata.directors.join(", ")}\n`;
        replyMsg += `┃ 🌟 Stars : ${metadata.stars.join(", ")}\n`;
        replyMsg += "╰━━━━━━━━━━━━━━━━━━━━━━\n\n";
        replyMsg += "╭━━━━━〔 📝 SUMMARY (සිංහල) 〕━━━━━\n";
        replyMsg += `┃ ${truncate(metadata.summary, 500)}\n`;
        replyMsg += "╰━━━━━━━━━━━━━━━━━━━━━━\n";
        replyMsg += themeMgr.getSignature(sender, tCtx.ownerRefs);

        await sock.sendMessage(from, { delete: temp.key });
        if (metadata.thumbnail && metadata.thumbnail.startsWith('http')) {
          await sock.sendMessage(from, { image: { url: metadata.thumbnail }, caption: replyMsg }, { quoted: msg }).catch(async () => { await sock.sendMessage(from, { text: replyMsg }, { quoted: msg }); });
        } else { await sock.sendMessage(from, { text: replyMsg }, { quoted: msg }); }

        if (downloadLinks.length) {
          const menuItems = downloadLinks.map((l, i) => ({
            label: `${l.quality} - ${l.size} (${l.source})`,
            title: `${l.quality} - ${l.size}`,
            description: l.source,
            action: `menu:cmd:movie:dlmovie:${i + 1}`
          }));

          let dlMsg = "╭━━━━━〔 ᴀᴠᴀɪʟᴀʙʟᴇ ǫᴜᴀʟɪᴛɪᴇs 〕━━━━━\n";
          downloadLinks.forEach((l, i) => {
            dlMsg += `┃ 🌸 ${i + 1}. ${l.quality} (${l.size}) - ${l.source}\n`;
          });
          dlMsg += "╰━━━━━━━━━━━━━━━━━━━━━━\n\n";
          dlMsg += "👉 *Reply with the number* to download.\n";
          dlMsg += themeMgr.getSignature(sender, tCtx.ownerRefs);

          const qualityMenu = await ui.sendMenu(sock, from, { title: "DOWNLOAD QUALITY", body: dlMsg, items: menuItems, type: "quality" }, { quoted: msg }, { ...context, sender });

          global.sinhalasubQualityCache[sender].menuId = qualityMenu.key.id;

          await new Promise(r => setTimeout(r, 500));
          await sendReact(sock, from, msg, "✅");
        } else {
          await sendReact(sock, from, msg, "⚠️");
          await sock.sendMessage(from, { text: "❌ *𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐋𝐈𝐍𝐊𝐒 𝐍𝐎𝐓 𝐅𝐎𝐔𝐍𝐃!* ✨\n\nමෙම චිත්‍රපටය සඳහා සෘජු Pixeldrain ලින්ක් සොයාගත නොහැකි විය." }, { quoted: msg });
        }
        return;
      }

      if (mode === "dlmovie") {
        const num = parseInt(selection);
        const cache = global.sinhalasubQualityCache[sender];
        if (!cache || isNaN(num) || num < 1 || num > cache.movie.downloadLinks.length) return;
        
        // Delete slink.js when an option is selected
        const slinkFile = path.join(process.cwd(), "link", "slink.js");
        if (fs.existsSync(slinkFile)) {
           try { fs.unlinkSync(slinkFile); } catch (e) { }
        }

        const selected = cache.movie.downloadLinks[num - 1];
        delete global.sinhalasubQualityCache[sender];
        const sizeText = selected.size.toUpperCase();
        let sizeMB = 0;
        if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
        else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);

        if (sizeMB > 4096) {
          await sendReact(sock, from, msg, "⚠️");
          return sock.sendMessage(from, { text: `⚠️ *UPARIMA DARITHAVA 4GB!* 🚀✨\n\nමෙම වීඩියෝව WhatsApp සීමාව (4GB) ඉක්මවා ඇත.` }, { quoted: msg });
        }

        const actualLink = selected.pageLink || selected.link;
        await sendReact(sock, from, msg, "⏳");

        let downloadText = "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n";
        downloadText += `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.movie.metadata.title, 20)}\n`;
        downloadText += "┃ ⏳ *𝐑𝐄𝐒𝐎𝐋𝐕𝐈𝐍𝐆 𝐋𝐈𝐍𝐊...* \n";
        downloadText += "┃    මදක් රැඳී සිටින්න... \n";
        downloadText += "╰━━━━━━━━━━━━━━━━━━━━━━";

        const statusMsg = await sock.sendMessage(from, { text: downloadText }, { quoted: msg });

        const browser = await getBrowser();
        const onWait = async (remaining) => {
          let waitTxt = "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n";
          waitTxt += `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.movie.metadata.title, 20)}\n`;
          if (remaining === "SUCCESS") {
            waitTxt += `┃ ✅ *𝐒𝐔𝐂𝐂𝐄𝐒𝐒:* 𝐃𝐢𝐫𝐞𝐜𝐭 𝐋𝐢𝐧𝐤 𝐅𝐨𝐮𝐧𝐝!\n`;
            waitTxt += "┃    ඩවුන්ලෝඩ් වීම ආරම්භ විය... 🚀\n";
          } else {
            waitTxt += `┃ ⏳ *𝐏𝐋𝐄𝐀𝐒𝐄 𝐖𝐀𝐈𝐓 ${remaining}𝐬...* \n`;
            waitTxt += "┃    ලින්ක් එක සකස් වෙමින් පවතී... \n";
          }
          waitTxt += "╰━━━━━━━━━━━━━━━━━━━━━━";
          await sock.sendMessage(from, { text: waitTxt, edit: statusMsg.key }).catch(() => { });
        };

        const direct = await sinhalasubResolveLink(browser, selected, onWait);
        if (!direct || !direct.link) throw new Error("Could not resolve a direct download link.");

        let directUrl = direct.link;
        if (direct.link.includes('pixeldrain.com/l/')) {
           const listDirect = await resolvePixeldrainListUrl(direct.link);
           if (listDirect) directUrl = listDirect;
        } else if (direct.link.includes('pixeldrain.com/')) {
           directUrl = getDirectPixeldrainUrl(direct.link);
        }
        
        if (directUrl) {
          const fileName = `${cache.movie.metadata.title.substring(0, 50)} - ${selected.quality}.mp4`.replace(/[^\w\s.-]/gi, '');
          const WHATSAPP_DOC_LIMIT_MB = 1740; // 1.7 GB
          const WHATSAPP_DOC_LIMIT_BYTES = WHATSAPP_DOC_LIMIT_MB * 1024 * 1024;
          const uid = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const tempFile = path.join(DOWNLOAD_DIR, `movie_${uid}.mp4`);
          let response = null;

          try {
            const startTxt =
              "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
              `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.movie.metadata.title, 20)}\n` +
              `┃ 📊 Quality : ${selected.quality}\n` +
              "┃ 📥 බාගත වීම ආරම්භ විය... 🚀\n" +
              "┃    මදක් රැඳී සිටින්න...\n" +
              "╰━━━━━━━━━━━━━━━━━━━━━━";
            await sock.sendMessage(from, { text: startTxt, edit: statusMsg.key }).catch(() => {});

            response = await axios({
              method: 'GET',
              url: directUrl,
              responseType: 'stream',
              timeout: 3600000,
              headers: getDownloadHeaders(directUrl, 'https://sinhalasub.lk/')
            });

            const totalBytes = parseInt(response.headers['content-length'] || "0", 10);

            // Enforce 1.7 GB limit before downloading large file
            if (totalBytes > WHATSAPP_DOC_LIMIT_BYTES) {
              try { response.data.destroy(); } catch (_) { }
              const sizeMB = (totalBytes / (1024 * 1024)).toFixed(2);
              console.log(`[Movie] File ${sizeMB} MB exceeds direct upload limit (1.7 GB). Sending direct link.`);
              const limitText =
                "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
                `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.movie.metadata.title, 20)}\n` +
                "┃ 📦 *FILE EXCEEDS 1.7 GB LIMIT*\n" +
                `┃ 📦 ගොනු ප්‍රමාණය : ${sizeMB} MB\n` +
                "┃ ⚠️ WhatsApp උපරිම සීමාව (1.7 GB) ඉක්මවා ඇති බැවින්\n" +
                "┃    පහත Direct Download Link එකෙන් බාගත කරන්න:\n" +
                "╰━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                `🔗 *Direct Download Link:*\n${directUrl || actualLink}`;
              await sock.sendMessage(from, { text: limitText, edit: statusMsg.key }).catch(() => {});
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
                  `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.movie.metadata.title, 20)}\n` +
                  `┃ 📊 Quality : ${selected.quality}` +
                  progressTxt + "\n" +
                  "╰━━━━━━━━━━━━━━━━━━━━━━";
                sock.sendMessage(from, { text: updateText, edit: statusMsg.key }).catch(() => {});
              }
            });

            await new Promise((resolve, reject) => {
              response.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
              response.data.on('error', reject);
            });

            if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < 10240) {
              throw new Error("Downloaded file is empty or corrupted.");
            }

            const finalSizeMB = (fs.statSync(tempFile).size / (1024 * 1024)).toFixed(1);
            const uploadText =
              "╭━━━━━〔 ᴄʜᴀᴛʜᴜ-ᴍᴅ ᴠ4 〕━━━━━\n" +
              `┃ 🎬 𝐌𝐨𝐯𝐢𝐞 : ${truncate(cache.movie.metadata.title, 20)}\n` +
              `┃ 📦 𝐒𝐢𝐳𝐞  : ${finalSizeMB} MB\n` +
              "┃ 📤 වට්ස්ඇප් වෙත උඩුගත වෙමින් පවතී...\n" +
              "┃    මදක් රැඳී සිටින්න... \n" +
              "╰━━━━━━━━━━━━━━━━━━━━━━";
            await sock.sendMessage(from, { text: uploadText, edit: statusMsg.key }).catch(() => {});

            // Upload via Baileys document using local file path
            await sock.sendMessage(from, {
              document: { url: tempFile },
              fileName,
              mimetype: 'video/mp4',
              caption: `🎬 *${cache.movie.metadata.title}*\n📊 Quality: ${selected.quality}\n💾 Size: ${finalSizeMB} MB\n📡 Source: ${selected.source}\n\n*CHATHU-MD V4*`
            }, { quoted: msg });

            await sock.sendMessage(from, { delete: statusMsg.key }).catch(() => {});
            await sendReact(sock, from, msg, "✅");
            console.log(`[Movie] Upload finished: ${cache.movie.metadata.title}`);
          } catch (err) {
            console.error("[Movie] Download/Upload Error:", err && err.message ? err.message : err);
            if (response && response.data) {
              try { response.data.destroy(); } catch (_) { }
            }
            await sock.sendMessage(from, { text: `❌ *𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐅𝐀𝐈𝐋𝐄𝐃!* ✨\n\nබෝට් එක හරහා එවීමට අපොහොසත් විය.\n${err && err.message && err.message.includes('small') ? "⚠️ සබැඳිය (Link) වීඩියෝවක් නොවන බැවින් බෝට් එක මඟින් එය ප්‍රතික්ෂේප කරන ලදී." : ""}\n🔗 *Manual Link:* ${actualLink}`, edit: statusMsg.key });
            await sendReact(sock, from, msg, "❌");
          } finally {
            if (tempFile && fs.existsSync(tempFile)) {
              try { fs.unlinkSync(tempFile); } catch (_) {}
            }
            // Auto-delete slink.js after use
            const slinkFile = path.join(process.cwd(), "link", "slink.js");
            if (fs.existsSync(slinkFile)) {
               try { fs.unlinkSync(slinkFile); } catch (e) { }
            }
            if (global.gc) global.gc();
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

    if (global.sinhalasubQualityCache && global.sinhalasubQualityCache[sender]) {
      const cache = global.sinhalasubQualityCache[sender];
      const isQuoted = quotedId && (quotedId === cache.menuId || quoted.text?.includes("MOVIE INFO") || quoted.text?.includes("DOWNLOAD OPTIONS"));
      const isRecent = (now - cache.timestamp) < timeout;
      if ((isQuoted || (!quotedId && isRecent)) && num >= 1 && num <= cache.movie.downloadLinks.length) {
        console.log(`[Movie Flow] Quality selection detected: ${num} for ${sender}`);
        await this.execute(sock, msg, from, ["dlmovie", num.toString()], "movie", { prefix: ".", sender });
        return true;
      }
    }

    if (global.sinhalasubSearchCache && global.sinhalasubSearchCache[sender]) {
      const cache = global.sinhalasubSearchCache[sender];
      const isQuoted = quotedId && (quotedId === cache.menuId || quoted.text?.includes("SEARCH RESULTS") || quoted.text?.includes("AVAILABLE MOVIES"));
      const isRecent = (now - cache.timestamp) < timeout;
      if ((isQuoted || (!quotedId && isRecent)) && num >= 1 && num <= cache.results.length) {
        console.log(`[Movie Flow] Movie selection detected: ${num} for ${sender}`);
        await this.execute(sock, msg, from, ["getmovie", num.toString()], "movie", { prefix: ".", sender });
        return true;
      }
    }
  }
};
