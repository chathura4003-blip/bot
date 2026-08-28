'use strict';

/**
 * Ultra High-Speed Direct Cloud-to-WhatsApp MMS Uploader
 * 
 * Allows the Railway Cloud Datacenter Worker to encrypt media files on the cloud
 * and upload them DIRECTLY to WhatsApp MMS servers (mmg.whatsapp.net).
 * 
 * Result: 0 MB data downloaded or uploaded through the Local PC!
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const events = require('events');
const axios = require('axios').default || require('axios');
const { logger } = require('../logger');
const { workerMetrics } = require('./worker-metrics');

const MEDIA_PATH_MAP = {
  image: '/mms/image',
  video: '/mms/video',
  document: '/mms/document',
  audio: '/mms/audio',
  sticker: '/mms/image',
};

/**
 * Encrypt and upload a local file directly to WhatsApp MMS Servers from Railway Cloud
 * 
 * @param {Object} params
 * @param {string} params.filePath - Path to downloaded file on Cloud Worker
 * @param {string} params.mediaType - 'document' | 'video' | 'audio' | 'image'
 * @param {Object} params.mediaConn - WhatsApp mediaConn object containing auth token & hosts
 * @param {string} [params.taskId] - Optional worker metrics taskId for progress tracking
 * @returns {Promise<Object>} WhatsApp media metadata for WAMessage construction
 */
async function uploadDirectToWhatsAppMMS({
  filePath,
  mediaType = 'document',
  mediaConn,
  taskId
}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cloud MMS Upload: File not found at ${filePath}`);
  }

  const messagesMedia = require('@whiskeysockets/baileys/lib/Utils/messages-media');
  const { getMediaKeys } = messagesMedia;
  if (typeof getMediaKeys !== 'function') {
    throw new Error('Cloud MMS Upload: getMediaKeys helper missing from baileys');
  }

  const stat = fs.statSync(filePath);
  const fileLength = stat.size;
  const mediaKey = crypto.randomBytes(32);
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);

  const encPath = path.join(os.tmpdir(), `bwm-mms-${crypto.randomBytes(8).toString('hex')}.bin`);
  const encWriter = fs.createWriteStream(encPath, { highWaterMark: 1024 * 1024 });

  const aes = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  let hmac = crypto.createHmac('sha256', macKey).update(iv);
  let sha256Plain = crypto.createHash('sha256');
  let sha256Enc = crypto.createHash('sha256');

  logger(`[Cloud MMS] 🔒 Encrypting ${(fileLength / (1024 * 1024)).toFixed(1)} MB (${mediaType}) on Railway Datacenter...`);
  const encStartTime = Date.now();

  const srcStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of srcStream) {
    sha256Plain.update(chunk);
    const encChunk = aes.update(chunk);
    if (encChunk && encChunk.length) {
      sha256Enc.update(encChunk);
      hmac.update(encChunk);
      if (!encWriter.write(encChunk)) {
        await events.once(encWriter, 'drain');
      }
    }
  }

  const finalChunk = aes.final();
  if (finalChunk && finalChunk.length) {
    sha256Enc.update(finalChunk);
    hmac.update(finalChunk);
    if (!encWriter.write(finalChunk)) {
      await events.once(encWriter, 'drain');
    }
  }

  const mac = hmac.digest().slice(0, 10);
  sha256Enc.update(mac);
  const fileSha256 = sha256Plain.digest();
  const fileEncSha256 = sha256Enc.digest();

  if (!encWriter.write(mac)) {
    await events.once(encWriter, 'drain');
  }

  await new Promise((resolve, reject) => {
    encWriter.end((err) => (err ? reject(err) : resolve()));
  });

  const encElapsed = ((Date.now() - encStartTime) / 1000).toFixed(1);
  const encStat = fs.statSync(encPath);
  const encLength = encStat.size;
  logger(`[Cloud MMS] ✅ Encrypted in ${encElapsed}s. Starting 1 Gbps direct upload to WhatsApp MMS Servers...`);

  const fileEncSha256B64 = fileEncSha256
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const mediaPath = MEDIA_PATH_MAP[mediaType] || '/mms/document';
  const hosts = Array.isArray(mediaConn?.hosts) && mediaConn.hosts.length
    ? mediaConn.hosts
    : [{ hostname: 'mmg.whatsapp.net' }];
  const auth = encodeURIComponent(mediaConn?.auth || '');

  let lastError = null;
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    const hostname = host?.hostname;
    if (!hostname) continue;

    const url = `https://${hostname}${mediaPath}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
    logger(`[Cloud MMS] ⚡ Direct Cloud Upload ➔ ${hostname}${mediaPath}...`);

    let uploadedBytes = 0;
    const bodyStream = fs.createReadStream(encPath, { highWaterMark: 1024 * 1024 });
    bodyStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      workerMetrics.recordStreamActivity(chunk.length, '1 Gbps Cloud Pipe');
      if (taskId) {
        const pct = encLength > 0 ? Math.min(99, Math.round((uploadedBytes / encLength) * 100)) : 0;
        workerMetrics.updateTaskProgress(taskId, {
          percent: pct,
          speed: '1 Gbps Cloud MMS',
          sizeBytes: uploadedBytes
        });
      }
    });

    try {
      const resp = await axios.post(url, bodyStream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': encLength,
          'Origin': 'https://web.whatsapp.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        timeout: 900000, // 15 min for large movies
        responseType: 'json',
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        maxRedirects: 0
      });

      try { fs.unlinkSync(encPath); } catch (_) { }

      const data = resp && resp.data;
      if (data && (data.url || data.directPath || data.direct_path)) {
        const directPath = data.direct_path || data.directPath;
        const mediaUrl = data.url || `https://${hostname}${directPath}`;
        logger(`[Cloud MMS] 🚀 DIRECT UPLOAD SUCCESSFUL! directPath: ${directPath}`);

        return {
          directUpload: true,
          directPath,
          url: mediaUrl,
          handle: data.handle || null,
          mediaKey: mediaKey.toString('base64'),
          fileSha256: fileSha256.toString('base64'),
          fileEncSha256: fileEncSha256.toString('base64'),
          fileLength,
          encLength
        };
      }
    } catch (err) {
      lastError = err;
      logger(`[Cloud MMS] Host ${hostname} failed: ${err.message}`);
    }
  }

  try { fs.unlinkSync(encPath); } catch (_) { }
  throw (lastError || new Error('All WhatsApp MMS upload hosts failed.'));
}

module.exports = {
  uploadDirectToWhatsAppMMS
};
