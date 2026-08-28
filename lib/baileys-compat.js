'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

function getBundledVersion() {
  try {
    const packageRoot = path.dirname(require.resolve('@whiskeysockets/baileys/package.json'));
    const versionFile = path.join(packageRoot, 'lib', 'Defaults', 'baileys-version.json');
    const parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    if (Array.isArray(parsed.version) && parsed.version.length === 3) return parsed.version;
  } catch { /* Use the explicit conservative fallback below. */ }
  return [2, 3000, 1015901307];
}

function isValidVersion(version) {
  return Array.isArray(version) && version.length === 3 && version.every((part) => Number.isInteger(part) && part > 0);
}

async function resolveBaileysVersion(logger = () => {}) {
  const bundled = getBundledVersion();
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('version request timed out')), 8000)),
    ]);
    if (isValidVersion(result?.version)) {
      logger(`Using WhatsApp Web version ${result.version.join('.')}.`);
      return result.version;
    }
    logger(`Baileys returned an invalid WhatsApp Web version; using bundled ${bundled.join('.')}.`);
  } catch (error) {
    logger(`Could not fetch the latest WhatsApp Web version (${error.message}); using bundled ${bundled.join('.')}.`);
  }
  return bundled;
}

module.exports = { resolveBaileysVersion, getBundledVersion, isValidVersion };
