"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const { logger } = require("../logger");
const { getYtdlp, getCommonArgs } = require("./ytdlp-manager");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

async function searchYouTubeYtdlp(query, max = 10) {
  try {
    const raw = await getYtdlp().execPromise([
      `ytsearch${max}:${query}`,
      ...getCommonArgs(),
      "--dump-json",
      "--no-playlist",
      "--quiet",
      "--no-warnings",
    ]);
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const v = JSON.parse(line);
          const mins = Math.floor((v.duration || 0) / 60);
          const secs = String((v.duration || 0) % 60).padStart(2, "0");
          return {
            title: v.title || "Unknown",
            url: v.webpage_url || v.original_url || "",
            duration: v.duration_string || `${mins}:${secs}`,
            thumbnail: v.thumbnail || "",
            source: "YouTube",
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    logger(`[Search] YouTube: ${err.message}`);
    return [];
  }
}

async function searchYouTube(query, max = 10) {
  try {
    const { data } = await axios.get(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 10000,
      },
    );

    const match = data.match(/ytInitialData[^{]+(\{.*?\});/);
    if (!match) throw new Error("ytInitialData not found");

    const ytData = JSON.parse(match[1]);
    const contents =
      ytData.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents;
    if (!contents) return [];

    const videoResults = [];
    for (const section of contents) {
      const items = section.itemSectionRenderer?.contents || [];
      for (const item of items) {
        if (item.videoRenderer) {
          const vid = item.videoRenderer;
          videoResults.push({
            title: vid.title?.runs?.[0]?.text || "Unknown",
            author: vid.ownerText?.runs?.[0]?.text || "Unknown",
            url: `https://www.youtube.com/watch?v=${vid.videoId}`,
            duration: vid.lengthText?.simpleText || "?",
            thumbnail: vid.thumbnail?.thumbnails?.[0]?.url?.split("?")[0] || "",
            source: "YouTube",
          });
          if (videoResults.length >= max) return videoResults;
        }
      }
    }
    if (videoResults.length === 0) throw new Error("No videos parsed");
    return videoResults;
  } catch (err) {
    logger(
      `[Search] Main Scraper failed (${err.message}). Falling back to yt-dlp...`,
    );
    return searchYouTubeYtdlp(query, max);
  }
}

const ADULT_SITES = [
  {
    name: "Pornhub",
    url: (q) =>
      `https://www.pornhub.com/video/search?search=${encodeURIComponent(q)}`,
    sel: ".pcVideoListItem",
    title: ".title a",
    href: ".title a",
    dur: ".duration",
    base: "https://www.pornhub.com",
  },
  {
    name: "XVideos",
    url: (q) => `https://www.xvideos.com/?k=${encodeURIComponent(q)}`,
    sel: ".thumb-block",
    title: ".title a",
    href: ".title a",
    dur: ".duration",
    base: "https://www.xvideos.com",
  },
  {
    name: "XNXX",
    url: (q) => `https://www.xnxx.com/search/${encodeURIComponent(q)}`,
    sel: ".thumb-block",
    title: ".title a",
    href: ".title a",
    dur: ".duration",
    base: "https://www.xnxx.com",
  },
  {
    name: "xHamster",
    url: (q) => `https://xhamster.com/search/${encodeURIComponent(q)}`,
    sel: ".video-thumb",
    title: ".video-thumb__image-container",
    href: ".video-thumb__image-container",
    dur: ".thumb-image-container__duration",
    base: "https://xhamster.com",
  },
  {
    name: "YouPorn",
    url: (q) => `https://www.youporn.com/search?query=${encodeURIComponent(q)}`,
    sel: ".video-list-item",
    title: ".video-title a",
    href: ".video-title a",
    dur: ".duration",
    base: "https://www.youporn.com",
  },
  {
    name: "SpankBang",
    url: (q) => `https://spankbang.com/s/${encodeURIComponent(q)}/`,
    sel: ".video-item",
    title: ".n a",
    href: ".n a",
    dur: ".l",
    base: "https://spankbang.com",
  },
  {
    name: "RedTube",
    url: (q) => `https://www.redtube.com/?search=${encodeURIComponent(q)}`,
    sel: ".video_link_container",
    title: ".video_title_text",
    href: "a",
    dur: ".duration_label",
    base: "https://www.redtube.com",
  },
];

async function _scrapeAdult(site, query, max = 10) {
  try {
    const { data } = await axios.get(site.url(query), {
      timeout: 12000,
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    const $ = cheerio.load(data);
    const results = [];
    $(site.sel)
      .slice(0, max)
      .each((_, el) => {
        const titleEl = $(el).find(site.title);
        const hrefEl = $(el).find(site.href);
        const title = titleEl.attr("title") || titleEl.text().trim();
        const href = hrefEl.attr("href");
        if (title && href) {
          const url = href.startsWith("http") ? href : `${site.base}${href}`;
          const duration = $(el).find(site.dur).first().text().trim() || "?";
          const thumbnail =
            $(el).find("img").attr("data-src") ||
            $(el).find("img").attr("src") ||
            "";
          results.push({
            title: title.trim(),
            url,
            duration,
            thumbnail,
            source: site.name,
          });
        }
      });
    return results;
  } catch (err) {
    if (!err.message.includes("403") && !err.message.includes("timeout")) {
      logger(`[Search] ${site.name}: ${err.message}`);
    }
    return [];
  }
}

async function searchAdultSite(siteName, query, max = 10) {
  const site = ADULT_SITES.find(
    (s) => s.name.toLowerCase() === siteName.toLowerCase(),
  );
  if (!site) return [];
  return _scrapeAdult(site, query, max);
}

async function searchAllAdult(query, max = 10) {
  const settled = await Promise.allSettled(
    ADULT_SITES.map((s) => _scrapeAdult(s, query, 3)),
  );
  return settled.flatMap((r) => r.value || []).slice(0, max);
}

module.exports = { searchYouTube, searchAdultSite, searchAllAdult };
