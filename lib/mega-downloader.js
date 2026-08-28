'use strict';

/**
 * Mega.nz & Universal Provider Downloader
 * - Automatically detects Mega.nz (mega.nz, mega.co.nz, mega.io) URLs
 * - Uses bundled yt-dlp to decrypt and stream Mega video files directly to disk
 * - Provides live download progress feedback
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { logger } = require('../logger');
const { getBinPath, getCommonArgs, ensureYtdlp } = require('./ytdlp-manager');
const { DOWNLOAD_DIR } = require('../config');

function isMegaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /mega\.(?:nz|co\.nz|io)\/(?:file\/|folder\/|embed\/|#|#!)?[a-zA-Z0-9_\-#!=]+/i.test(url);
}

/**
 * Download Mega.nz file directly to disk using yt-dlp
 */
async function downloadMegaFile(url, outputPath, onProgress = null) {
  const ready = await ensureYtdlp();
  if (!ready) {
    throw new Error('yt-dlp binary is not ready for Mega downloads');
  }

  const binPath = getBinPath();
  const args = [
    url,
    ...getCommonArgs(),
    '--no-playlist',
    '--no-cache-dir',
    '--concurrent-fragments', '5',
    '--buffer-size', '64k',
    '--no-part',
    '--quiet',
    '--no-warnings',
    '--no-check-certificate',
    '--socket-timeout', '30',
    '--newline',
    '-o', outputPath,
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-R', '3'
  ];

  logger(`[Mega] Starting yt-dlp download for: ${url}`);
  const child = spawn(binPath, args, { windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });

  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  let lastUpdate = 0;
  rl.on('line', (line) => {
    const match = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\w./]+).*?ETA\s+([\d:]+)/);
    if (match && onProgress && Date.now() - lastUpdate > 3000) {
      lastUpdate = Date.now();
      const percent = parseFloat(match[1]);
      const speed = match[2];
      const eta = match[3];
      onProgress({ percent, speed, eta });
    }
  });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        logger(`[Mega] Download completed successfully: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
        return resolve(outputPath);
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      logger(`[Mega] Download failed with code ${code}: ${stderr}`);
      reject(new Error(`Mega download failed (code ${code}): ${stderr || 'Unknown error'}`));
    });

    child.on('error', (err) => {
      reject(err);
    });

    // 15-minute safety timeout
    setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('Mega download timed out after 15 minutes'));
    }, 900000);
  });
}

module.exports = {
  isMegaUrl,
  downloadMegaFile
};
