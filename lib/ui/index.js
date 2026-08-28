"use strict";

/**
 * Public entry point for the bot-wide Button Mode UI system.
 *
 * Usage:
 *   const ui = require("../ui");
 *
 *   await ui.sendMenu(sock, jid, menu, options, context);
 *   await ui.sendResultMenu(sock, jid, query, results, options, context);
 *   await ui.sendQualityMenu(sock, jid, payload, options, context);
 *
 *   ui.getButtonMode(context);   // → "on" | "off" (V4.2)
 *   ui.isButtonModeOn(context);  // shorthand: true ↔ advanced engine
 *   ui.setButtonMode("on");
 *
 *   await ui.dispatch(sock, msg, from, sender, actionId, context, { handler });
 *   ui.extractMenuActionId(msg);
 *   ui.extractQuotedStanzaId(msg);
 *   ui.resolveNumericReply({ chatJid, userJid, quotedMessageId, num });
 *
 * Action ID examples:
 *   menu:home / menu:list / menu:back
 *   menu:cat:<categoryId>
 *   menu:cmd:<commandName>
 *   menu:setting:<settingKey>
 *   menu:page:<n>
 *   result:select:<index>
 *   result:page:<n>
 *   quality:select:<hd|sd|audio|document|link>
 *   download:<video|audio|document|link>:<urlOrId>
 *   search:page:<n>           (alias for result:page)
 *   rolemenu:cat:<id>         (legacy alias → menu:cat:<id>)
 *   rolemenu:cmd:<name>       (legacy alias → menu:cmd:<name>)
 */

const buttonMode  = require("./button-mode");
const menuState   = require("./menu-state");
const dispatcher  = require("./menu-dispatcher");
const registry    = require("./menu-registry");
const builder     = require("./menu-builder");
const roleHelp    = require("./role-menu");
const access      = require("./access-control");
const resultMenu  = require("./result-menu");

module.exports = {
  // Senders
  sendMenu:        buttonMode.sendMenu,
  sendButtonMenu:  buttonMode.sendButtonMenu,
  sendListMenu:    buttonMode.sendListMenu,
  sendTextMenu:    buttonMode.sendTextMenu,
  sendResultMenu:  resultMenu.sendResultMenu,
  sendQualityMenu: resultMenu.sendQualityMenu,

  // Mode
  VALID_MODES:     buttonMode.VALID_MODES,
  DEFAULT_MODE:    buttonMode.DEFAULT_MODE,
  getButtonMode:   buttonMode.getButtonMode,
  setButtonMode:   buttonMode.setButtonMode,
  isButtonModeOn:  buttonMode.isButtonModeOn,

  // Action ID + state helpers
  extractMenuActionId:   buttonMode.extractMenuActionId,
  extractQuotedStanzaId: buttonMode.extractQuotedStanzaId,
  saveMenuState:         menuState.saveMenuState,
  getMenuStateByMessageId: menuState.getMenuStateByMessageId,
  getLatestMenuStateForUser: menuState.getLatestMenuStateForUser,
  resolveNumericReply:   menuState.resolveNumericReply,
  deleteMenuState:       menuState.deleteMenuState,

  // Dispatcher
  dispatch:        dispatcher.dispatch,

  // Registry / builder / roles / access (re-exported for advanced callers)
  buildTopLevelMenu: registry.buildTopLevelMenu,
  buildCategoryMenu: registry.buildCategoryMenu,
  buildMenuText:    builder.buildMenuText,
  buildResultText:  builder.buildResultText,
  MENU_MARKER:      builder.MENU_MARKER,
  getUserRole:      roleHelp.getUserRole,
  filterItemsByRole: roleHelp.filterItemsByRole,
  roleLabel:        roleHelp.roleLabel,
  canAccess:        access.canAccess,
};
