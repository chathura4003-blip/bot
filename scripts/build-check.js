#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = [
  'index.js',
  'bot.js',
  'dashboard.js',
  'config.js',
  'session-manager.js',
  'public/login.html',
  'public/admin.html',
  'Dockerfile',
  'render.yaml',
];
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Build check failed; missing: ${missing.join(', ')}`);
  process.exit(1);
}
require('child_process').execFileSync(process.execPath, ['scripts/check-syntax.js'], { cwd: root, stdio: 'inherit' });
console.log('Build check passed.');
