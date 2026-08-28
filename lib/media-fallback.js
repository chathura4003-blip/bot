"use strict";

const fs = require("fs");
const path = require("path");

const LOCAL_BANNER_CANDIDATES = [
  path.join(__dirname, "..", "public", "assets", "banner.jpg"),
  path.join(__dirname, "..", "public", "assets", "banner.png"),
  path.join(__dirname, "..", "public", "banner.jpg"),
  path.join(__dirname, "..", "public", "banner.png"),
];

let cachedBannerBuffer = null;
let cachedBannerPath = undefined;

function getLocalBannerPath() {
  if (cachedBannerPath !== undefined) return cachedBannerPath;
  cachedBannerPath = LOCAL_BANNER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
  return cachedBannerPath;
}

function getLocalBannerBuffer() {
  if (cachedBannerBuffer !== null) return cachedBannerBuffer;
  const p = getLocalBannerPath();
  if (p) {
    try {
      cachedBannerBuffer = fs.readFileSync(p);
      return cachedBannerBuffer;
    } catch {}
  }
  return null;
}

async function sendBannerMessage(sock, from, options = {}) {
  const {
    caption = "",
    text = caption,
    mentions = [],
    contextInfo,
    quoted,
  } = options;

  const bannerBuf = getLocalBannerBuffer();
  if (bannerBuf) {
    try {
      return await sock.sendMessage(
        from,
        {
          image: bannerBuf,
          caption,
          mentions,
          ...(contextInfo ? { contextInfo } : {}),
        },
        quoted ? { quoted } : undefined
      );
    } catch {}
  }

  return sock.sendMessage(
    from,
    {
      text,
      mentions,
      ...(contextInfo ? { contextInfo } : {}),
    },
    quoted ? { quoted } : undefined
  );
}

module.exports = {
  getLocalBannerPath,
  sendBannerMessage,
};
