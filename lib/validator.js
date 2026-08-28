"use strict";

function isValidUrl(str) {
  if (!str || typeof str !== "string") return false;
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidSearchQuery(q, maxLen = 100) {
  if (!q || typeof q !== "string") return false;
  const clean = q.trim();
  return clean.length > 0 && clean.length <= maxLen;
}

function isValidJID(jid) {
  if (!jid || typeof jid !== "string") return false;
  return /^[0-9]+-?[0-9]*@(g\.us|s\.whatsapp\.net)$/.test(jid);
}

function extractPhone(jid) {
  if (!jid) return "";
  return jid.split("@")[0].replace(/\D/g, "");
}

function parseArgs(args) {
  const result = { urls: [], keywords: [], flags: {} };
  if (!Array.isArray(args)) return result;
  const flagMap = {
    "hd": "hd",
    "--hd": "hd",
    "-hd": "hd",
    "sd": "sd",
    "--sd": "sd",
    "-sd": "sd",
    "low": "low",
    "--low": "low",
    "audio": "audio",
    "--audio": "audio",
    "-a": "audio",
    "mp3": "mp3",
    "--mp3": "mp3",
    "doc": "doc",
    "--doc": "doc",
    "document": "doc",
    "--document": "doc",
  };
  for (const arg of args) {
    if (!arg || typeof arg !== "string") continue;
    const clean = arg.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (isValidUrl(clean)) {
      result.urls.push(clean);
    } else if (flagMap[lower]) {
      result.flags[flagMap[lower]] = true;
    } else {
      result.keywords.push(clean);
    }
  }
  return result;
}

module.exports = {
  isValidUrl,
  isValidSearchQuery,
  isValidJID,
  extractPhone,
  parseArgs,
};
