"use strict";

/**
 * Button Mode — central UI sender.
 *
 * Final behavior (mirrors the wabase-button reference repo, which now works
 * out of the box because we run on `atexovi-baileys` — see package.json):
 *   on  — Advanced UI Engine.
 *         1-5 visible items: WhatsApp interactiveButtons quick_reply card.
 *         6+ visible items: WhatsApp interactiveButtons single_select list.
 *         If interactiveButtons throws: send advanced text fallback.
 *   off — Legacy text flow only.
 *
 * Numeric reply fallback is preserved via menuState.saveMenuState in every
 * branch so quoting any sent menu and replying with a number still works.
 */

const { logger } = require("../../logger");
const builder = require("./menu-builder");
const menuState = require("./menu-state");
const roleHelp = require("./role-menu");
const access = require("./access-control");

const VALID_MODES = ["on", "off"];
const DEFAULT_MODE = "on";
const QUICK_REPLY_LIMIT = 5;
const LIST_ROW_LIMIT = 10;

function cleanText(text = "", max = 40) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

function _normalizeMode(m) {
  if (m == null) return null;
  const v = String(m).toLowerCase().trim();
  if (!v) return null;
  if (["off", "false", "0", "no", "n", "text", "disable", "disabled", "legacy"].includes(v)) return "off";
  if (["on", "true", "1", "yes", "y", "auto", "button", "list", "enable", "enabled", "advanced"].includes(v)) return "on";
  return null;
}

function getButtonMode(context = {}) {
  const direct = _normalizeMode(context.buttonMode);
  if (direct) return direct;

  const sess = context.session && _normalizeMode(context.session.buttonMode);
  if (sess) return sess;

  try {
    const appState = require("../../state");
    if (typeof appState.getButtonMode === "function") {
      const v = _normalizeMode(appState.getButtonMode());
      if (v) return v;
    }
  } catch (_) {}

  try {
    const db = require("../db");
    if (db && typeof db.getSetting === "function") {
      const v = _normalizeMode(db.getSetting("buttonMode"));
      if (v) return v;
    }
  } catch (_) {}

  const env = _normalizeMode(process.env.BUTTON_MODE);
  if (env) return env;

  return DEFAULT_MODE;
}

function isButtonModeOn(context = {}) {
  return getButtonMode(context) === "on";
}

function setButtonMode(mode) {
  const norm = _normalizeMode(mode);
  if (!norm) return false;

  try {
    const appState = require("../../state");
    if (typeof appState.setButtonMode === "function") {
      appState.setButtonMode(norm);
      return true;
    }
  } catch (_) {}

  try {
    const db = require("../db");
    if (db && typeof db.setSetting === "function") {
      db.setSetting("buttonMode", norm);
      return true;
    }
  } catch (_) {}

  return false;
}

// ---------------------------------------------------------------------------
// Action ID extraction
// ---------------------------------------------------------------------------

function extractMenuActionId(msg) {
  if (!msg || !msg.message) return "";
  const m = msg.message;
  return (
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    extractNativeFlowId(m.interactiveResponseMessage) ||
    ""
  );
}

function extractNativeFlowId(interactive) {
  if (!interactive) return "";
  const nfm = interactive.nativeFlowResponseMessage;
  if (!nfm?.paramsJson) return "";

  try {
    const parsed = JSON.parse(nfm.paramsJson);
    if (!parsed || typeof parsed !== "object") return "";

    const id =
      parsed.id ||
      parsed.button_id ||
      parsed.buttonId ||
      parsed.selectedRowId ||
      parsed.selected_row_id ||
      parsed.rowId ||
      parsed.row_id ||
      parsed.single_select_reply?.selectedRowId ||
      parsed.singleSelectReply?.selectedRowId;

    return typeof id === "string" ? id : "";
  } catch (_) {
    return "";
  }
}

function extractQuotedStanzaId(msg) {
  if (!msg || !msg.message) return null;
  const m = msg.message;
  return (
    m.extendedTextMessage?.contextInfo?.stanzaId ||
    m.imageMessage?.contextInfo?.stanzaId ||
    m.videoMessage?.contextInfo?.stanzaId ||
    m.documentMessage?.contextInfo?.stanzaId ||
    m.buttonsResponseMessage?.contextInfo?.stanzaId ||
    m.listResponseMessage?.contextInfo?.stanzaId ||
    m.interactiveResponseMessage?.contextInfo?.stanzaId ||
    null
  );
}

// ---------------------------------------------------------------------------
// Senders: wabase-button-style interactiveButtons
// ---------------------------------------------------------------------------

async function sendTextMenu(sock, jid, text, options = {}) {
  return await sock.sendMessage(jid, { text }, options);
}

// Resolve `menu.image` into a Baileys media payload. Accepts URL strings,
// { url } / { stream } / Buffer shapes, or just a remote thumbnail URL.
function _resolveImagePayload(image) {
  if (!image) return null;
  if (typeof image === "string") return { url: image };
  if (Buffer.isBuffer(image)) return image;
  if (image.url || image.stream || image.path || image.buffer) return image;
  return null;
}

// Build extra CTA-style buttons (URL link / copy code) from a menu's
// `extraButtons` array. Each entry is `{ type, text, url|code }`.
// Returns native-flow button shapes ready to be merged with quick_reply
// buttons or the single_select trigger. WhatsApp renders cta_url as a
// link button that doesn't generate a reply, so we don't have to plumb
// taps through extractNativeFlowId. Call CTA buttons are intentionally
// dropped so the menu never asks the user to dial the owner.
function _buildCtaButtons(menu) {
  const out = [];
  if (!Array.isArray(menu?.extraButtons)) return out;
  for (const b of menu.extraButtons) {
    if (!b || typeof b !== "object") continue;
    const type = String(b.type || "").toLowerCase();
    const text = cleanText(b.text || b.display_text || b.label || "", 20);
    if (!text) continue;
    if (type === "url" && (b.url || b.link)) {
      const url = String(b.url || b.link).slice(0, 200);
      out.push({
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: text,
          url,
          merchant_url: url,
        }),
      });
    } else if (type === "copy" && (b.copy_code || b.code)) {
      out.push({
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: text,
          copy_code: String(b.copy_code || b.code).slice(0, 200),
        }),
      });
    }
  }
  return out;
}

async function sendButtonMenu(sock, jid, menu, items, options = {}) {
  const ctaButtons = _buildCtaButtons(menu);
  // WhatsApp's interactive card caps at ~5 visible buttons total (CTA +
  // quick_reply combined). CTA buttons render at the top per the
  // wabase-button reference; quick_reply tiles fill the remaining slots.
  const quickReplySlots = Math.max(0, QUICK_REPLY_LIMIT - ctaButtons.length);
  const replyButtons = items.slice(0, quickReplySlots).map((item, index) => ({
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({
      display_text: cleanText(
        item.shortLabel || item.label || item.title || `Option ${index + 1}`,
        20,
      ),
      id: String(item.action || item.id || `menu:item:${index}`).slice(0, 80),
    }),
  }));

  const buttons = [...ctaButtons, ...replyButtons];
  if (!buttons.length) throw new Error("no buttons to send");

  const bodyText = menu.text || menu.body || "Choose an option from below";
  const titleStr = cleanText(menu.title || "CHATHU MD V4", 60);
  const footerStr = cleanText(menu.footer || "CHATHU MD", 60);
  const imagePayload = _resolveImagePayload(menu.image);

  // When the caller supplies an image (e.g. quality picker thumbnail), send
  // it as the interactiveMessage's media header. atexovi-baileys merges the
  // uploaded imageMessage into the interactiveMessage.header automatically
  // when we pass `image` + `caption` alongside `interactiveButtons`.
  if (imagePayload) {
    return await sock.sendMessage(jid, {
      image: imagePayload,
      caption: bodyText,
      title: titleStr,
      subtitle: cleanText(menu.subtitle || "", 60) || undefined,
      footer: footerStr,
      // Tells WhatsApp clients to render the merged imageMessage as the
      // interactiveMessage media header (so the user sees the thumbnail
      // above the body + buttons).
      media: true,
      interactiveButtons: buttons,
    }, options);
  }

  // No image → omit the `title` field so WhatsApp doesn't draw an extra
  // text-only banner above the body. Our menu body already includes its
  // own box header (e.g. `╭━━━〔 🤖 CHATHU MD V4 〕━━━╮`), so adding a
  // duplicate banner would double-print the title.
  return await sock.sendMessage(jid, {
    text: bodyText,
    footer: footerStr,
    interactiveButtons: buttons,
  }, options);
}

async function sendListMenu(sock, jid, menu, items, options = {}) {
  if (!items?.length) throw new Error("no list rows to send");

  const rows = items.slice(0, LIST_ROW_LIMIT).map((item, index) => ({
    title: cleanText(item.title || item.label || `Option ${index + 1}`, 35),
    description: cleanText(item.description || item.subtitle || "", 60),
    id: String(item.action || item.id || `menu:item:${index}`).slice(0, 80),
  }));

  const bodyText = menu.text || menu.body || "Choose an option from below";
  const footerStr = cleanText(menu.footer || "CHATHU MD", 60);
  const imagePayload = _resolveImagePayload(menu.image);

  // The single_select trigger is the "📋 Open Menu" button that opens the
  // bottom-sheet list. CTA-style extras (link / call / copy) render above
  // it in the order provided.
  const buttons = [
    ..._buildCtaButtons(menu),
    {
      name: "single_select",
      buttonParamsJson: JSON.stringify({
        title: cleanText(menu.buttonText || "📋 Open Menu", 20),
        sections: [
          {
            title: cleanText(menu.sectionTitle || "Options", 24),
            rows,
          },
        ],
      }),
    },
  ];

  if (imagePayload) {
    return await sock.sendMessage(jid, {
      image: imagePayload,
      caption: bodyText,
      title: cleanText(menu.title || "CHATHU MD V4", 60),
      subtitle: cleanText(menu.subtitle || "Choose an option", 60),
      footer: footerStr,
      media: true,
      interactiveButtons: buttons,
    }, options);
  }

  return await sock.sendMessage(jid, {
    text: bodyText,
    subtitle: menu.subtitle || "Choose an option",
    footer: footerStr,
    interactiveButtons: buttons,
  }, options);
}

// ---------------------------------------------------------------------------
// Central dispatch
// ---------------------------------------------------------------------------

async function sendMenu(sock, jid, menu, options = {}, context = {}) {
  if (!sock || !jid || !menu) return null;

  const role = roleHelp.getUserRole(context);

  const filtered = (Array.isArray(menu.items) ? menu.items : [])
    .filter((it) => access.canAccess(it, { ...context, chatJid: jid }).allowed);

  const items = filtered.map((it, i) => ({ ...it, index: i + 1 }));

  const nav = _resolveNavigation(menu, items.length);
  if (nav.items.length) items.push(...nav.items);

  const buttonMode = getButtonMode(context);
  const builtText = builder.buildMenuText(
    {
      ...menu,
      // Pass `null` (not `{}`) when there are no auto-nav rows so the
      // legacy text fallback doesn't render an empty NAVIGATION header.
      navigation: Object.keys(nav.indexes).length ? nav.indexes : null,
    },
    items,
    { ...context, role, buttonMode },
  );

  const renderedMenu = {
    ...menu,
    text: menu.text || menu.body || builtText,
    body: menu.body || builtText,
    footer: menu.footer || `${context.botName || "CHATHU MD"}`,
    title: menu.title || menu.titleShort || "CHATHU MD V4",
    buttonText: menu.buttonText || "📋 Open Menu",
    sectionTitle: menu.sectionTitle || "Options",
  };

  const fallbackText = renderedMenu.text || builtText || "Please choose an option.";
  let sent = null;

  if (buttonMode === "off") {
    sent = await sendTextMenu(sock, jid, fallbackText, options);
  } else {
    try {
      logger(`[UI] buttonMode: ${buttonMode}`);
      logger(`[UI] menu id: ${menu.id}`);
      logger(`[UI] visible items: ${items.length}`);
      logger(`[UI] attempting: ${items.length <= QUICK_REPLY_LIMIT ? "quick_reply_buttons" : "single_select_list"}`);

      if (items.length <= QUICK_REPLY_LIMIT) {
        const sendPromise = sendButtonMenu(sock, jid, renderedMenu, items, options);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Interactive buttons timeout")), 2000));
        sent = await Promise.race([sendPromise, timeoutPromise]);
      } else {
        const sendPromise = sendListMenu(sock, jid, renderedMenu, items, options);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Interactive list timeout")), 2000));
        sent = await Promise.race([sendPromise, timeoutPromise]);
      }
    } catch (err) {
      logger(`[UI] interactiveButtons send failed/timed-out: ${err?.message || err}`);
      logger("[UI] fallback: instant text menu");
      sent = await sendTextMenu(sock, jid, fallbackText, options);
    }
  }

  const messageId = sent?.key?.id || null;
  menuState.saveMenuState(messageId, {
    type: menu.type || "menu",
    menuId: menu.id,
    level: menu.level || "top",
    categoryId: menu.categoryId || null,
    chatJid: jid,
    userJid: context.sender || null,
    role,
    items,
    payload: menu.payload || {},
    page: menu.page || 1,
    totalPages: menu.totalPages || 1,
    previousMenu: menu.previousMenu || null,
  });

  return sent;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function _resolveNavigation(menu, lastDataIndex) {
  const out = { items: [], indexes: {} };
  if (!menu) return out;

  const want = menu.navigation;
  if (menu.type === "results") return out;

  let wantBack = false;
  let wantHome = true;
  let wantList = true;

  if (want === false) return out;

  if (want && typeof want === "object") {
    if (want.back === false) wantBack = false;
    else if (want.back) wantBack = true;
    if (want.home === false) wantHome = false;
    if (want.list === false) wantList = false;
  } else if (menu.previousMenu) {
    wantBack = true;
  }

  let cursor = lastDataIndex + 1;

  if (wantBack) {
    out.items.push({ index: cursor, label: "⬅️ Back", title: "Back", action: "menu:back" });
    out.indexes.back = cursor;
    cursor++;
  }

  if (wantHome) {
    out.items.push({ index: cursor, label: "🏠 Home", title: "Home", action: "menu:home" });
    out.indexes.home = cursor;
    cursor++;
  }

  if (wantList) {
    out.items.push({ index: cursor, label: "📋 Menu List", title: "Menu List", action: "menu:list" });
    out.indexes.list = cursor;
  }

  return out;
}

module.exports = {
  VALID_MODES,
  DEFAULT_MODE,
  QUICK_REPLY_LIMIT,
  LIST_ROW_LIMIT,
  cleanText,
  getButtonMode,
  setButtonMode,
  isButtonModeOn,
  sendMenu,
  sendButtonMenu,
  sendListMenu,
  sendTextMenu,
  extractMenuActionId,
  extractQuotedStanzaId,
  extractNativeFlowId,
};
