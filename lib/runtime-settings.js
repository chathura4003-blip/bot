
"use strict";

const config = require("../config");
const db = require("./db");

function readSetting(key, fallback) {
  const value = db.getSetting(key);
  return value === undefined || value === null ? fallback : value;
}

function getPrefix() {
  const value = readSetting("prefix", config.PREFIX);
  return typeof value === "string" && value.trim() ? value.trim() : config.PREFIX;
}

function getBotName() {
  const value = readSetting("botName", config.BOT_NAME);
  return typeof value === "string" && value.trim() ? value.trim() : config.BOT_NAME;
}

function getAutoRead() {
  return Boolean(readSetting("autoRead", config.AUTO_READ));
}

function getAutoReadBot() {
  return Boolean(readSetting("autoReadBot", config.AUTO_READ_BOT));
}

function getAutoTyping() {
  return Boolean(readSetting("autoTyping", config.AUTO_TYPING));
}

function getNsfwEnabled() {
  return Boolean(readSetting("nsfwEnabled", config.NSFW_ENABLED));
}

function getWorkMode() {
  const value = readSetting("work_mode", config.WORK_MODE);
  const normalized = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : config.WORK_MODE;
  return ["public", "private", "self"].includes(normalized) ? normalized : config.WORK_MODE;
}

function getAutoViewStatus() {
  return readSetting("auto_view_status", true) !== false;
}

function getAutoReactStatus() {
  return readSetting("auto_react_status", false) === true;
}

module.exports = {
  getPrefix,
  getBotName,
  getAutoRead,
  getAutoReadBot,
  getAutoTyping,
  getNsfwEnabled,
  getWorkMode,
  getAutoViewStatus,
  getAutoReactStatus,
  readSetting,
};
