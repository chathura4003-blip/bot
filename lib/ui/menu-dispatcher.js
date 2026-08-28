"use strict";

/**
 * Menu Dispatcher — central handler for every action ID emitted by the
 * bot-wide menu system.
 *
 * Action ID formats (kept stable so the spec's button taps, list selections
 * and numeric replies all route through the same code):
 *
 *   menu:home                 → render main menu
 *   menu:list                 → render main menu (alias)
 *   menu:back                 → go to previous menu (or home if no prev)
 *   menu:cat:<categoryId>     → render a category sub-menu
 *   menu:cmd:<commandName>    → execute a registered command
 *   menu:setting:<settingKey> → forward to settings handler (best-effort)
 *   menu:page:<pageNumber>    → re-render the current menu at <page>
 *
 *   result:select:<index>     → look up saved result, open quality menu
 *   result:page:<page>        → re-render the result list at <page>
 *
 *   quality:select:<type>     → trigger video/audio/document/link flow
 *
 *   download:video|audio|document|link:<id> → low-level download trigger
 *   search:page:<page>        → alias for result:page:<page>
 *
 * Backward compat:
 *   rolemenu:cat:<id>  / rolemenu:cmd:<name>  → forwarded to lib/role-menu
 *
 * The dispatcher returns true if the action was handled (so the upstream
 * handler can stop its normal command pipeline).
 */

const { logger }   = require("../../logger");
const buttonMode   = require("./button-mode");
const menuState    = require("./menu-state");
const registry     = require("./menu-registry");
const resultMenu   = require("./result-menu");
const access       = require("./access-control");

function _splitAction(actionId) {
  if (!actionId || typeof actionId !== "string") return null;
  const idx = actionId.indexOf(":");
  if (idx <= 0) return null;
  const prefix = actionId.slice(0, idx);
  const rest   = actionId.slice(idx + 1);
  // For nested IDs like result:select:7 we want kind = "select", rest = "7"
  const idx2 = rest.indexOf(":");
  if (idx2 < 0) return { prefix, kind: rest, value: "" };
  return { prefix, kind: rest.slice(0, idx2), value: rest.slice(idx2 + 1) };
}

function _legacyToNew(actionId) {
  if (!actionId || typeof actionId !== "string") return actionId;
  if (actionId.startsWith("rolemenu:cat:")) return "menu:cat:" + actionId.slice("rolemenu:cat:".length);
  if (actionId.startsWith("rolemenu:cmd:")) return "menu:cmd:" + actionId.slice("rolemenu:cmd:".length);
  if (actionId.startsWith("pick:")) {
    const idx = parseInt(actionId.slice("pick:".length));
    if (Number.isFinite(idx)) return `result:select:${idx}`;
  }
  return actionId;
}

/**
 * Dispatch an action ID. Returns true if the action was handled.
 *
 * Required: ctx.handler (the lib/handler module reference). Used for command
 *           dispatch so we don't duplicate the disabled-module / cooldown /
 *           role-validation logic the regular path already implements.
 */
async function dispatch(sock, msg, from, sender, actionId, context = {}, deps = {}) {
  if (!actionId) return false;
  const id = _legacyToNew(actionId);
  const parts = _splitAction(id);
  if (!parts) return false;

  const ctx = {
    ...context,
    sender,
    chatJid: from,
    ownerRefs: context.ownerRefs || (context.owner ? [context.owner] : []),
  };

  try {
    if (parts.prefix === "menu") {
      return await _dispatchMenu(sock, msg, from, sender, parts, ctx, deps);
    }
    if (parts.prefix === "result" || parts.prefix === "search") {
      return await _dispatchResult(sock, msg, from, sender, parts, ctx, deps);
    }
    if (parts.prefix === "quality") {
      return await _dispatchQuality(sock, msg, from, sender, parts, ctx, deps);
    }
    if (parts.prefix === "download") {
      return await _dispatchDownload(sock, msg, from, sender, parts, ctx, deps);
    }
  } catch (err) {
    logger(`[MenuDispatcher] ${id}: ${err.stack || err.message}`);
    try {
      await sock.sendMessage(from, { text: "❌ Failed to run that menu action." }, { quoted: msg });
    } catch (_) {}
    return true;
  }
  return false;
}

async function _dispatchMenu(sock, msg, from, sender, parts, ctx, deps) {
  // menu:home / menu:list → main menu
  if (parts.kind === "home" || parts.kind === "list") {
    const menu = registry.buildTopLevelMenu(ctx);
    await buttonMode.sendMenu(sock, from, menu, { quoted: msg }, ctx);
    return true;
  }

  // menu:back → previous menu (saved on each menu state) or home
  if (parts.kind === "back") {
    // Find the latest state for this user. If it has a previousMenu, render
    // that; otherwise fall back to home.
    const state = menuState.getLatestMenuStateForUser(from, sender);
    const prev  = state?.previousMenu;
    if (prev?.id === "main" || !prev) {
      const menu = registry.buildTopLevelMenu(ctx);
      await buttonMode.sendMenu(sock, from, menu, { quoted: msg }, ctx);
      return true;
    }
    // For other previous menus we currently only know "main" + "cat:<id>",
    // since that's what registry produces. Decode and re-render.
    if (typeof prev.id === "string" && prev.id.startsWith("cat:")) {
      const cat = registry.buildCategoryMenu(prev.id.slice(4), ctx);
      if (cat) {
        await buttonMode.sendMenu(sock, from, cat, { quoted: msg }, ctx);
        return true;
      }
    }
    const menu = registry.buildTopLevelMenu(ctx);
    await buttonMode.sendMenu(sock, from, menu, { quoted: msg }, ctx);
    return true;
  }

  if (parts.kind === "cat") {
    const cat = registry.buildCategoryMenu(parts.value, ctx);
    if (!cat) {
      await sock.sendMessage(from, { text: "⚠️ That category is not available." }, { quoted: msg });
      return true;
    }
    if (cat.accessDenied) {
      await sock.sendMessage(from, { text: "⚠️ This category is not available for your role." }, { quoted: msg });
      return true;
    }
    await buttonMode.sendMenu(sock, from, cat, { quoted: msg }, ctx);
    return true;
  }

  if (parts.kind === "cmd") {
    let cmdName = parts.value;
    let args = [];
    
    // Support nested arguments like menu:cmd:movie:getmovie:1
    if (cmdName.includes(":")) {
      const cmdParts = cmdName.split(":");
      cmdName = cmdParts[0];
      args = cmdParts.slice(1);
    }

    if (!cmdName) return false;
    const handler = deps.handler;
    if (handler && typeof handler.dispatchRoleMenuCommand === "function") {
      // Reuse the existing role-menu command path. 
      // Note: we pass cmdName and the handler will look it up.
      return await handler.dispatchRoleMenuCommand(sock, msg, from, sender, cmdName, { ...ctx, args }, ctx.ownerRefs);
    }
    // Fallback if the handler doesn't expose dispatchRoleMenuCommand: resolve
    // through `commands` map and run.
    if (handler && handler.commands && handler.commands.get) {
      const cmd = handler.commands.get(String(cmdName).toLowerCase());
      if (!cmd) {
        await sock.sendMessage(from, { text: `⚠️ Unknown command: *${cmdName}*` }, { quoted: msg });
        return true;
      }
      try {
        await cmd.execute(sock, msg, from, args, cmd.name, ctx);
      } catch (err) {
        logger(`[MenuDispatcher.cmd:${cmdName}] ${err.message}`);
      }
      return true;
    }
    return false;
  }

  if (parts.kind === "setting") {
    // Forward to settings handler — best-effort; if no handler is hooked,
    // fall back to opening the settings panel.
    const settingKey = parts.value;
    const handler = deps.handler;
    try {
      const settingsManager = require("../commands/settings-manager");
      if (handler && handler.commands && handler.commands.get) {
        const cmd = handler.commands.get("settings");
        if (cmd && typeof cmd.execute === "function") {
          await cmd.execute(sock, msg, from, [settingKey], "settings", ctx);
          return true;
        }
      }
      // Direct fallback: just open the settings panel.
      const inline = (Array.isArray(settingsManager) ? settingsManager : []).find((c) => c.name === "settings");
      if (inline) await inline.execute(sock, msg, from, [], "settings", ctx);
    } catch (err) {
      logger(`[MenuDispatcher.setting] ${err.message}`);
    }
    return true;
  }

  if (parts.kind === "page") {
    const state = _resolveStateForLevel(msg, from, sender, "results");
    if (!state) return false;
    const page = parseInt(parts.value) || 1;
    const query = state.payload?.query || "";
    const results = state.payload?.results || [];
    await resultMenu.sendResultMenu(sock, from, query, results, { page, send: { quoted: msg } }, ctx);
    return true;
  }

  return false;
}

// Resolve the menu state the user was actually replying to.
//
// Button taps include `contextInfo.stanzaId` pointing at the original
// picker message; we look that up first so the user can drill into a
// picker that was sent earlier even if they ran another menu command in
// between (which would otherwise overwrite "latest"). When the stanzaId
// is missing or its state has been evicted we fall back to the
// latest-state-by-user index so plain numeric replies (which often drop
// the stanzaId on older WhatsApp clients) keep working.
function _resolveStateForLevel(msg, from, sender, expectedLevel) {
  const quotedId = buttonMode.extractQuotedStanzaId(msg);
  if (quotedId) {
    const byId = menuState.getMenuStateByMessageId(quotedId);
    if (byId && (!expectedLevel || byId.level === expectedLevel)) return byId;
  }
  const latest = menuState.getLatestMenuStateForUser(from, sender);
  if (latest && (!expectedLevel || latest.level === expectedLevel)) return latest;
  return null;
}

async function _dispatchResult(sock, msg, from, sender, parts, ctx, deps) {
  if (parts.kind === "page") {
    const state = _resolveStateForLevel(msg, from, sender, "results");
    if (!state) return false;
    const page = parseInt(parts.value) || 1;
    const query = state.payload?.query || "";
    const results = state.payload?.results || [];
    await resultMenu.sendResultMenu(sock, from, query, results, { page, send: { quoted: msg } }, ctx);
    return true;
  }
  if (parts.kind === "select") {
    const idx = parseInt(parts.value);
    const state = _resolveStateForLevel(msg, from, sender, "results");
    if (!state) {
      await sock.sendMessage(from, { text: "⚠️ Selection expired. Please search again." }, { quoted: msg });
      return true;
    }
    const result = (state.payload?.results || [])[idx];
    if (!result) {
      await sock.sendMessage(from, { text: "⚠️ Invalid selection. Please try again." }, { quoted: msg });
      return true;
    }
    // Pull richer metadata (filesize, thumbnail, audio quality) via the
    // existing download-manager helper so the quality menu is informative.
    let meta = result;
    try {
      const { getMetadata } = require("../download-manager");
      const m = await getMetadata(result.url);
      if (m) meta = { ...result, ...m };
    } catch (_) { /* keep raw result */ }
    await resultMenu.sendQualityMenu(sock, from, meta, { send: { quoted: msg } }, ctx);
    return true;
  }
  return false;
}

async function _dispatchQuality(sock, msg, from, sender, parts, ctx, deps) {
  if (parts.kind !== "select") return false;
  const which = String(parts.value || "").toLowerCase();
  // Quality picker is short-lived and gets clobbered the moment the user
  // runs anything else (`.menu`, another `.video`, etc.). Resolve via the
  // tapped picker's stanzaId first so HD/SD/Song/Back keep working as
  // long as the picker is still in cache (5 minute TTL), even if the
  // user did another action in between.
  const state = _resolveStateForLevel(msg, from, sender, "quality");
  const result = state?.payload?.result || state?.payload || null;
  if (!state || !result) {
    logger(`[MenuDispatcher.quality:${which}] no quality state for ${sender} in ${from} (selection expired)`);
    await sock.sendMessage(from, { text: "⚠️ Selection expired. Please search again." }, { quoted: msg });
    return true;
  }
  const url = result.url || result.video?.url;
  if (!url) {
    await sock.sendMessage(from, { text: "⚠️ Could not resolve a URL for the selected item." }, { quoted: msg });
    return true;
  }

  if (which === "link") {
    await sock.sendMessage(from, { text: `🔗 ${url}` }, { quoted: msg });
    return true;
  }

  let downloadAndSend, sendReact;
  try {
    ({ downloadAndSend } = require("../download-manager"));
    ({ sendReact } = require("../utils"));
  } catch (e) {
    logger(`[MenuDispatcher.quality] download-manager unavailable: ${e.message}`);
    await sock.sendMessage(from, { text: "❌ Download module unavailable." }, { quoted: msg });
    return true;
  }

  try {
    if (sendReact) sendReact(sock, from, msg, "⏳").catch(() => {});
    if (which === "hd")        await downloadAndSend(sock, from, url, "Media", "hd", false, false, false);
    else if (which === "sd")   await downloadAndSend(sock, from, url, "Media", "sd", false, false, false);
    else if (which === "audio")await downloadAndSend(sock, from, url, "Media", "sd", true,  false, false);
    // Voice Note → audio + isPTT=true (push-to-talk Opus voice note).
    else if (which === "voicenote" || which === "ptt") await downloadAndSend(sock, from, url, "Media", "sd", true, true, false);
    else if (which === "document") await downloadAndSend(sock, from, url, "Media", "sd", false, false, true);
    else { await sock.sendMessage(from, { text: `⚠️ Unknown quality option: ${which}` }, { quoted: msg }); return true; }
    if (sendReact) sendReact(sock, from, msg, "✅").catch(() => {});
  } catch (err) {
    logger(`[MenuDispatcher.quality:${which}] ${err.message}`);
    if (sendReact) sendReact(sock, from, msg, "❌").catch(() => {});
    try { await sock.sendMessage(from, { text: `❌ Download failed: ${err.message}` }, { quoted: msg }); } catch (_) {}
  }
  return true;
}

async function _dispatchDownload(sock, msg, from, sender, parts, ctx, deps) {
  // download:<type>:<id-or-url>
  // Currently we expect <id-or-url> to be a URL (for compatibility with
  // saved result payloads) — but we also accept a numeric id that maps to
  // the latest results state.
  let type = parts.kind;
  let target = parts.value;
  if (!type || !target) return false;

  let url = target;
  if (/^\d+$/.test(target)) {
    const idx = parseInt(target);
    const state = menuState.getLatestMenuStateForUser(from, sender);
    const r = (state?.payload?.results || [])[idx];
    if (!r) {
      await sock.sendMessage(from, { text: "⚠️ Invalid download id. Please search again." }, { quoted: msg });
      return true;
    }
    url = r.url;
  }

  let downloadAndSend, sendReact;
  try {
    ({ downloadAndSend } = require("../download-manager"));
    ({ sendReact } = require("../utils"));
  } catch (e) {
    logger(`[MenuDispatcher.download] download-manager unavailable: ${e.message}`);
    return false;
  }
  if (sendReact) sendReact(sock, from, msg, "⏳").catch(() => {});
  try {
    if (type === "video")        await downloadAndSend(sock, from, url, "Media", "sd", false, false, false);
    else if (type === "audio")   await downloadAndSend(sock, from, url, "Media", "sd", true,  false, false);
    else if (type === "document")await downloadAndSend(sock, from, url, "Media", "sd", false, false, true);
    else if (type === "link")    await sock.sendMessage(from, { text: `🔗 ${url}` }, { quoted: msg });
    else { await sock.sendMessage(from, { text: `⚠️ Unknown download type: ${type}` }, { quoted: msg }); return true; }
    if (sendReact) sendReact(sock, from, msg, "✅").catch(() => {});
  } catch (err) {
    logger(`[MenuDispatcher.download:${type}] ${err.message}`);
    if (sendReact) sendReact(sock, from, msg, "❌").catch(() => {});
  }
  return true;
}

module.exports = {
  dispatch,
};
