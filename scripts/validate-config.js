#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { validateConfig } = require('../lib/config-validation');

const result = validateConfig(process.env);
for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
if (result.mode.explicitMode === 'production' && !result.mode.isProductionLike) {
  console.error('Production configuration is not hardened. Set a unique ADMIN_PASS, a random JWT_SECRET of at least 32 characters, and a supported Node.js runtime.');
  process.exit(1);
}
console.log(`Configuration validation passed for ${result.mode.explicitMode} mode.`);
