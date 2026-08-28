'use strict';

const requiredModules = [
  '../lib/baileys-compat',
  '../lib/connection-recovery',
  '../lib/phone-normalizer',
  '../lib/handler',
  '../bot',
  '../session-manager',
];

for (const modulePath of requiredModules) {
  require(modulePath);
  console.log(`Loaded ${modulePath}`);
}

const baileys = require('@whiskeysockets/baileys');
if (typeof baileys.default !== 'function') throw new Error('Baileys socket factory is unavailable');
if (typeof baileys.useMultiFileAuthState !== 'function') throw new Error('Baileys auth-state helper is unavailable');
if (typeof baileys.fetchLatestBaileysVersion !== 'function') throw new Error('Baileys version helper is unavailable');
console.log('WhatsApp smoke test passed without opening a socket.');
