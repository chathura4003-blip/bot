"use strict";

/**
 * Menu Builder — renders box-drawing text menus matching the spec mockups.
 *
 * Used as the text fallback whenever WhatsApp buttons / list messages are
 * disabled, fail, or are explicitly turned off via `buttonMode = off|text`.
 *
 * Stays self-contained (does not import bailing-on-error theme code) so it
 * works even if optional theme files are missing.
 */

function pad2(n) { return String(n).padStart(2, "0"); }

function safeName(s) {
  if (!s) return "there";
  return String(s).split(/[\s|·•]/)[0].slice(0, 24) || "there";
}

function capitalize(s) {
  if (!s) return "";
  s = String(s);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const MENU_MARKER = "ADVANCED MENU";

/**
 * Build a generic box-style menu text. Kept intentionally compact so the
 * body just shows the welcome line, optional headerFields, the section,
 * and the items themselves. Navigation hints, "how to use" prose, the
 * inline footer line and the legacy text marker are all dropped — the
 * tappable buttons / list rows below the message already cover those, and
 * the new UI dispatcher resolves numeric replies via menu-state lookup
 * (no body-text marker needed). Legacy role-menu replies still work
 * because lib/role-menu.js builds its own body and pushes its own marker.
 *
 * @param {object} menu     { title, subtitle, headerFields[], sectionTitle, footer, navigation }
 * @param {array}  items    [{ index, label, title, action }]
 * @param {object} context  { sender, role, prefix, botName, pushName, workMode, buttonMode }
 */
function buildMenuText(menu, items, context = {}) {
  const lines = [];
  const title = String(menu?.title || "MENU").toUpperCase();
  lines.push(`╭━━━〔 ${title} 〕━━━╮`);
  lines.push("┃");

  if (menu?.welcome !== false && context.pushName) {
    lines.push(`┃ 👋 Welcome, ${safeName(context.pushName)}`);
  }
  if (menu?.subtitle) {
    lines.push(`┃ ${menu.subtitle}`);
  }

  // headerFields: [{label, value}]
  if (Array.isArray(menu?.headerFields)) {
    for (const f of menu.headerFields) {
      if (!f) continue;
      const label = f.label || "";
      const value = f.value === undefined ? "" : String(f.value);
      lines.push(`┃ ${label}${label ? " : " : ""}${value}`);
    }
  }

  if (context.role) {
    const tryRoleLabel = require("./role-menu").roleLabel;
    lines.push(`┃ ⭐ Rank: ${tryRoleLabel(context.role)}`);
  }

  lines.push("┃");

  const section = menu?.sectionTitle || "OPTIONS";
  lines.push(`┣━━〔 ${String(section).toUpperCase()} 〕`);

  if (!items?.length) {
    lines.push("┃ ⚠️ No options available for your role.");
  } else {
    for (const it of items) {
      const idx = it.index !== undefined ? it.index : "•";
      const numeric = typeof idx === "number" ? pad2(idx) : String(idx);
      const label = it.label || it.title || "Option";
      lines.push(`┃ ${numeric}. ${label}`);
    }
  }

  lines.push("╰━━━━━━━━━━━━━━━━━━━━━━╯");
  return lines.join("\n");
}

/**
 * Render a search/result list in the same box style (separate helper because
 * result lists usually have a query header + per-row description).
 */
function buildResultText(query, items, opts = {}) {
  const lines = [];
  const title = String(opts.title || "🔎 SEARCH RESULTS").toUpperCase();
  lines.push(`╭━━━〔 ${title} 〕━━━╮`);
  lines.push("┃");
  if (query) {
    lines.push(`┃ Query: ${String(query).slice(0, 60)}`);
  }
  if (opts.page && opts.totalPages) {
    lines.push(`┃ Page : ${opts.page}/${opts.totalPages}`);
  }
  lines.push("┃");
  lines.push("┣━━〔 RESULTS 〕");
  if (!items?.length) {
    lines.push("┃ ⚠️ No results.");
  } else {
    for (const it of items) {
      const idx = pad2(it.index || 0);
      const label = (it.title || it.label || "Result").slice(0, 60);
      lines.push(`┃ ${idx}. ${label}`);
      if (it.description) {
        lines.push(`┃     ┖ ${String(it.description).slice(0, 50)}`);
      }
    }
  }
  lines.push("╰━━━━━━━━━━━━━━━━━━━━━━╯");
  return lines.join("\n");
}

module.exports = {
  MENU_MARKER,
  buildMenuText,
  buildResultText,
  pad2,
  capitalize,
  safeName,
};
