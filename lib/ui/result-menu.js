"use strict";

/**
 * Result / Quality menus — central WhatsApp List Message + text fallback for
 * any "choose one" UI in the bot:
 *
 *   • sendResultMenu()   — search/video/song result list
 *   • sendQualityMenu()  — quality/action select after a result is picked
 *
 * Both delegate to ui/button-mode.sendMenu() so they automatically respect
 * the active button mode (on / off / auto / button / list / text) and
 * always save menu state by sent message ID for numeric reply.
 */

const buttonMode = require("./button-mode");
const builder    = require("./menu-builder");

const RESULT_PAGE_SIZE = Number(process.env.RESULT_PAGE_SIZE || 5);

function _truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function _formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1)    return `${mb.toFixed(1)} MB`;
  const kb = n / 1024;
  return `${kb.toFixed(0)} KB`;
}

/**
 * Build the compact info card body shown above the HD / SD / Song / Back
 * buttons. Includes title, channel/author when known, duration, and file
 * size — so the user can glance at what they're about to download before
 * picking a quality.
 */
function _buildQualityBody(payload) {
  if (!payload || typeof payload !== "object") return "🎚 *SELECT ACTION*";

  const title    = _truncate(payload.title || payload.label || "Selected media", 70);
  const channel  = _truncate(payload.channel || payload.author || payload.uploader || "", 40);
  const duration = String(payload.duration || payload.length || "").trim();
  const size     = _formatBytes(payload.filesize || payload.filesizeApprox || payload.size);

  const lines = [];
  lines.push(`🎬 *${title}*`);
  if (channel)  lines.push(`👤 ${channel}`);
  if (duration) lines.push(`⏱ Duration : ${duration}`);
  if (size)     lines.push(`💾 Size    : ${size}`);
  lines.push("");
  lines.push("Choose a quality below.");
  return lines.join("\n");
}

/**
 * Send a search-result list to the user. Returns the sent reference and the
 * full saved item list (so callers can inspect / log).
 *
 *   results: array of search-result objects (must have at least .title)
 */
async function sendResultMenu(sock, jid, query, results, options = {}, context = {}) {
  const page  = Math.max(1, parseInt(options.page) || 1);
  const total = Math.max(1, Math.ceil((results?.length || 0) / RESULT_PAGE_SIZE));
  const start = (page - 1) * RESULT_PAGE_SIZE;
  const slice = (results || []).slice(start, start + RESULT_PAGE_SIZE);

  const items = slice.map((r, i) => ({
    index:  i + 1,
    label:  _truncate(r.title || r.label || `Result ${i + 1}`, 60),
    title:  _truncate(r.title || r.label || `Result ${i + 1}`, 60),
    description: [r.duration, r.channel || r.author]
      .filter(Boolean).map(String).map((s) => s.slice(0, 30)).join(" • "),
    action: `result:select:${start + i}`,
    payload: r,
  }));

  // Pagination rows are appended *inside* the result list (not via the
  // button-mode auto-nav), to match the spec's "11. Previous / 12. Next /
  // 13. Home" layout exactly.
  const navIdx = {};
  let cursor = items.length + 1;
  if (page > 1) {
    items.push({ index: cursor, label: "⬅️ Previous", title: "Previous Page", description: `Page ${page - 1}`, action: `result:page:${page - 1}` });
    navIdx.previous = cursor; cursor++;
  }
  if (page < total) {
    items.push({ index: cursor, label: "➡️ Next", title: "Next Page", description: `Page ${page + 1}`, action: `result:page:${page + 1}` });
    navIdx.next = cursor; cursor++;
  }
  items.push({ index: cursor, label: "🏠 Home", title: "Home", action: "menu:home" });
  navIdx.home = cursor;

  // Build the boxed text body up-front (so it overrides the generic menu
  // builder and matches the spec's "RESULTS" header exactly).
  const text = builder.buildResultText(query, items.filter(it => !String(it.action).startsWith("menu:") && !String(it.action).startsWith("result:page:")), {
    title: options.title || "🔎 SEARCH RESULTS",
    page, totalPages: total,
    navigation: navIdx,
  });

  const menu = {
    id:           options.id || "search-results",
    type:         "results",
    level:        "results",
    title:        options.title || "🔎 SEARCH RESULTS",
    titleShort:   "Results",
    sectionTitle: options.sectionTitle || "Search Results",
    buttonText:   options.buttonText || "📋 Choose Result",
    items,
    payload:      { query, results, page, totalPages: total, ...(options.payload || {}) },
    previousMenu: options.previousMenu || null,
    page,
    totalPages:   total,
    text,
    body:         text,
    footer:       options.footer || `${context.botName || "CHATHU MD"} • Results`,
    navigation:   false, // we already added our own nav rows
  };

  return await buttonMode.sendMenu(sock, jid, menu, options.send || {}, context);
}

/**
 * Send a quality / action menu for a chosen result. The default options
 * are: HD, SD, Song (audio), and a Back button — short labels so WhatsApp
 * lays them out as quick-reply pills (4 buttons => fits the
 * QUICK_REPLY_LIMIT, so button-mode renders real WhatsApp quick-reply
 * buttons instead of falling back to a single_select list).
 *
 * Callers (e.g. `.play`) can pass a custom `options.items` list when they
 * need a different action set (audio / voice note / document / video, etc.).
 *
 *   payload: the original result/meta object so the dispatcher can use its
 *            `.url` (and any sibling fields) when the user picks an option.
 */
async function sendQualityMenu(sock, jid, payload, options = {}, context = {}) {
  const items = options.items || [
    { label: "🎬 HD",    shortLabel: "🎬 HD",    title: "HD Video",   action: "quality:select:hd",    payload },
    { label: "📺 SD",    shortLabel: "📺 SD",    title: "SD Video",   action: "quality:select:sd",    payload },
    { label: "🎵 Song",  shortLabel: "🎵 Song",  title: "Audio",      action: "quality:select:audio", payload },
    { label: "⬅️ Back", shortLabel: "⬅️ Back", title: "Back",       action: "menu:back" },
  ];

  // Re-index 1-based to match the saved-state contract.
  const indexed = items.map((it, i) => ({ ...it, index: i + 1, payload: it.payload || payload }));

  // Compact info-rich body so the picker shows title / channel / duration /
  // size above the buttons. Built once and passed as `text`/`body` so the
  // generic menu builder doesn't wrap it in the boxed category layout.
  const body  = options.body || _buildQualityBody(payload);
  const thumb = payload?.thumbnail || payload?.thumb || payload?.image || null;

  const menu = {
    id:           options.id || "quality-select",
    type:         "quality",
    level:        "quality",
    title:        options.title || "🎚 SELECT ACTION",
    sectionTitle: "Options",
    buttonText:   "📋 Choose Action",
    items:        indexed,
    payload:      { result: payload, ...(options.payload || {}) },
    previousMenu: options.previousMenu || null,
    footer:       options.footer || `${context.botName || "CHATHU MD"} • Quality`,
    text:         body,
    body,
    image:        thumb || undefined,
    // Skip auto-Back/Home/List — Back is already part of `items` above, so
    // including the auto-nav would push the count past QUICK_REPLY_LIMIT and
    // demote the picker into a single_select list. We want quick-reply pills.
    navigation:   false,
  };

  return await buttonMode.sendMenu(sock, jid, menu, options.send || {}, context);
}

module.exports = {
  RESULT_PAGE_SIZE,
  sendResultMenu,
  sendQualityMenu,
};
