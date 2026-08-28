'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function ensureRuntimeHome() {
  const configured = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    configured,
    path.join(process.env.DATA_DIR || os.tmpdir(), '.chathu-home'),
    path.join(os.tmpdir(), 'chathu-home'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      process.env.HOME = candidate;
      if (process.platform === 'win32') process.env.USERPROFILE = candidate;
      return candidate;
    } catch { /* Try the next safe candidate. */ }
  }

  throw new Error('No readable and writable runtime home directory is available. Set HOME to an existing writable directory.');
}

module.exports = { ensureRuntimeHome };
