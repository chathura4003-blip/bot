"use strict";

// Memory-bounded media upload pipeline for atexovi-baileys.
//
// The shipped Baileys upload path (lib/Utils/messages-media.js) buffers the
// entire encrypted media payload in RAM twice:
//
//   1. `encryptedStream(...)` runs `for await (const data of stream)` to
//      completion before returning, pushing every encrypted chunk into a
//      `Readable({ read: () => {} })`. Nothing consumes the readable while
//      this runs, so the readable's internal buffer holds the whole file.
//
//   2. `getWAUploadToServer(...)` then drains that readable into a `chunks`
//      array and `Buffer.concat`s it into a single Buffer before POSTing.
//      Peak heap usage: ~2 × encrypted file size.
//
// Together these blow Railway's 512 MB free-tier heap on any movie above
// roughly 250 MB (and OOM-restarts the bot mid-upload).
//
// This module installs two surgical replacements that keep the public API
// identical:
//
//   * `patchBaileysEncryption()` swaps `messages-media.encryptedStream` for
//     a disk-backed version. Encrypted bytes are written to a temp file as
//     they're produced; the returned `encWriteStream` is just
//     `fs.createReadStream(tmpPath)`, which the rest of Baileys consumes
//     unchanged. Memory during encryption: ~64 KB (writeStream highWaterMark).
//
//   * `installStreamingUpload(sock)` replaces `sock.waUploadToServer` with a
//     reimplementation that POSTs the input stream directly to the upload
//     URL with a known `Content-Length` header. No `chunks[]`, no
//     `Buffer.concat`. Memory during upload: ~64 KB (axios highWaterMark).
//
// Combined, peak heap is bounded to a few MB regardless of file size, so a
// 1 GB movie can upload from a 512 MB host without crashing.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const stream = require("stream");
const events = require("events");
const axios = require("axios").default || require("axios");

let _patched = false;

function tmpEncPath() {
  return path.join(os.tmpdir(), `bwm-enc-${crypto.randomBytes(8).toString("hex")}.bin`);
}

function safeUnlink(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch (_) {}
}

function tryRequire(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

/**
 * Replace `@whiskeysockets/baileys/lib/Utils/messages-media`.encryptedStream
 * with a disk-backed implementation. Idempotent.
 */
function patchBaileysEncryption(logger) {
  if (_patched) return;
  const messagesMedia = tryRequire("@whiskeysockets/baileys/lib/Utils/messages-media");
  if (!messagesMedia || typeof messagesMedia.encryptedStream !== "function") {
    if (logger && logger.warn) logger.warn("[baileys-streaming-upload] messages-media.encryptedStream not found; skipping encryption patch");
    return;
  }
  const generics = tryRequire("@whiskeysockets/baileys/lib/Utils/generics");
  const boomMod = tryRequire("@hapi/boom");
  const Boom = boomMod && (boomMod.Boom || boomMod.default || boomMod);

  const { getStream, getMediaKeys } = messagesMedia;
  if (typeof getStream !== "function" || typeof getMediaKeys !== "function") {
    if (logger && logger.warn) logger.warn("[baileys-streaming-upload] required helpers missing; skipping encryption patch");
    return;
  }

  const generateMessageIDV2 = generics && generics.generateMessageIDV2
    ? generics.generateMessageIDV2
    : () => crypto.randomBytes(10).toString("hex").toUpperCase();

  async function diskBackedEncryptedStream(media, mediaType, opts = {}) {
    const { logger: log, saveOriginalFileIfRequired, opts: getStreamOpts } = opts || {};
    const got = await getStream(media, getStreamOpts);
    const srcStream = got.stream;
    const type = got.type;
    if (log && log.debug) log.debug("fetched media stream");

    const mediaKey = crypto.randomBytes(32);
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);

    let bodyPath;
    let originalWriter;
    let didSaveToTmpPath = false;
    if (type === "file") {
      bodyPath = media.url;
    } else if (saveOriginalFileIfRequired) {
      bodyPath = path.join(os.tmpdir(), mediaType + generateMessageIDV2());
      originalWriter = fs.createWriteStream(bodyPath);
      didSaveToTmpPath = true;
    }

    const encPath = tmpEncPath();
    const encWriter = fs.createWriteStream(encPath);

    let fileLength = 0;
    const aes = crypto.createCipheriv("aes-256-cbc", cipherKey, iv);
    let hmac = crypto.createHmac("sha256", macKey).update(iv);
    let sha256Plain = crypto.createHash("sha256");
    let sha256Enc = crypto.createHash("sha256");

    const writeEncChunk = async (buff) => {
      if (!buff || !buff.length) return;
      sha256Enc = sha256Enc.update(buff);
      hmac = hmac.update(buff);
      if (!encWriter.write(buff)) {
        await events.once(encWriter, "drain");
      }
    };

    try {
      for await (const data of srcStream) {
        if (
          type === "remote" &&
          getStreamOpts && getStreamOpts.maxContentLength &&
          fileLength + data.length > getStreamOpts.maxContentLength
        ) {
          const err = Boom
            ? new Boom(`content length exceeded when encrypting "${type}"`, { data: { media, type } })
            : new Error(`content length exceeded when encrypting "${type}"`);
          throw err;
        }
        fileLength += data.length;
        sha256Plain = sha256Plain.update(data);
        if (originalWriter) {
          if (!originalWriter.write(data)) {
            await events.once(originalWriter, "drain");
          }
        }
        await writeEncChunk(aes.update(data));
      }
      await writeEncChunk(aes.final());

      const mac = hmac.digest().slice(0, 10);
      sha256Enc = sha256Enc.update(mac);
      const fileSha256 = sha256Plain.digest();
      const fileEncSha256 = sha256Enc.digest();

      if (!encWriter.write(mac)) {
        await events.once(encWriter, "drain");
      }
      await new Promise((resolve, reject) => {
        encWriter.end((err) => (err ? reject(err) : resolve()));
      });
      if (originalWriter) {
        await new Promise((resolve, reject) => {
          originalWriter.end((err) => (err ? reject(err) : resolve()));
        });
      }
      try { srcStream.destroy(); } catch (_) {}

      const encStat = fs.statSync(encPath);
      const encSize = encStat.size;

      // Build the Readable Baileys consumes. We rig it to clean up the
      // backing temp file when the stream closes, so we never leak files.
      const encWriteStream = fs.createReadStream(encPath, { highWaterMark: 64 * 1024 });
      const cleanup = () => safeUnlink(encPath);
      encWriteStream.once("close", cleanup);
      encWriteStream.once("error", cleanup);

      // Attach metadata so the streaming upload override (below) can grab
      // it without re-stat'ing.
      encWriteStream._bwmEncPath = encPath;
      encWriteStream._bwmEncSize = encSize;

      if (log && log.debug) log.debug({ encPath, encSize }, "encrypted data successfully (disk-backed)");

      return {
        mediaKey,
        encWriteStream,
        bodyPath,
        mac,
        fileEncSha256,
        fileSha256,
        fileLength,
        didSaveToTmpPath,
      };
    } catch (err) {
      try { srcStream.destroy(); } catch (_) {}
      try { encWriter.destroy(); } catch (_) {}
      try { originalWriter && originalWriter.destroy(); } catch (_) {}
      try { aes.destroy(); } catch (_) {}
      try { hmac.destroy(); } catch (_) {}
      try { sha256Plain.destroy(); } catch (_) {}
      try { sha256Enc.destroy(); } catch (_) {}
      safeUnlink(encPath);
      if (didSaveToTmpPath && bodyPath) {
        try { await fs.promises.unlink(bodyPath); } catch (_) {}
      }
      throw err;
    }
  }

  messagesMedia.encryptedStream = diskBackedEncryptedStream;
  _patched = true;
  if (logger && logger.info) logger.info("[baileys-streaming-upload] disk-backed encryption installed");
  else console.log("[baileys-streaming-upload] disk-backed encryption installed");
}

/**
 * Replace `sock.waUploadToServer` with a streaming version that posts the
 * encrypted payload to WhatsApp media servers directly from the stream
 * (with a known Content-Length pulled from the disk-backed encryption
 * patch above) instead of `Buffer.concat`'ing all chunks first.
 */
function installStreamingUpload(sock, baileysConfig, logger) {
  if (!sock || typeof sock.waUploadToServer !== "function") return;
  if (sock._bwmStreamingInstalled) return;
  if (typeof sock.refreshMediaConn !== "function") return;

  const Defaults = tryRequire("@whiskeysockets/baileys/lib/Defaults");
  const messagesMedia = tryRequire("@whiskeysockets/baileys/lib/Utils/messages-media");
  if (!Defaults || !messagesMedia) return;
  const { MEDIA_PATH_MAP, DEFAULT_ORIGIN } = Defaults;
  const { encodeBase64EncodedStringForUpload } = messagesMedia;

  const customUploadHosts = (baileysConfig && baileysConfig.customUploadHosts) || [];
  const fetchAgent = baileysConfig && baileysConfig.fetchAgent;
  const userOptions = (baileysConfig && baileysConfig.options) || {};
  const log = (logger && typeof logger.warn === "function") ? logger : console;

  const original = sock.waUploadToServer;
  const refreshMediaConn = sock.refreshMediaConn.bind(sock);

  sock.waUploadToServer = async function streamingWaUploadToServer(input, opts) {
    // Tiny payloads (link-preview thumbnails, etc.) come in as Buffers
    // and are happy with the original implementation.
    if (Buffer.isBuffer(input)) {
      return original(input, opts);
    }

    const mediaType = opts && opts.mediaType;
    const newsletter = opts && opts.newsletter;
    const timeoutMs = opts && opts.timeoutMs;
    let fileEncSha256B64 = opts && opts.fileEncSha256B64;

    // Resolve content size + on-disk path. The encryption patch attaches
    // both as `_bwmEncSize` / `_bwmEncPath` to the encWriteStream it
    // returns. If those are missing (someone bypassed the encryption
    // patch), spool the stream to disk here instead — still memory-safe.
    let contentLength = input && input._bwmEncSize;
    let diskPath = input && input._bwmEncPath;
    let spooled = false;
    if (!diskPath || !contentLength) {
      diskPath = tmpEncPath();
      const writer = fs.createWriteStream(diskPath);
      try {
        await stream.promises.pipeline(input, writer);
        contentLength = fs.statSync(diskPath).size;
        spooled = true;
      } catch (err) {
        safeUnlink(diskPath);
        throw err;
      }
    }

    let uploadInfo = await refreshMediaConn(false);
    const hosts = [...customUploadHosts, ...uploadInfo.hosts];

    fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);
    let media = MEDIA_PATH_MAP[mediaType];
    if (newsletter && media) {
      media = media.replace("/mms/", "/newsletter/newsletter-");
    }

    let urls;
    let lastError;
    try {
      for (let i = 0; i < hosts.length; i++) {
        const host = hosts[i];
        const hostname = host && host.hostname;
        if (!hostname) continue;
        const maxBytes = host.maxContentLengthBytes;
        if (maxBytes && contentLength > maxBytes) {
          if (i === hosts.length - 1) {
            lastError = new Error(`Body too large (${contentLength} B) for "${hostname}"`);
          }
          continue;
        }
        if (log && log.debug) log.debug(`uploading (streaming) to "${hostname}"`);
        const auth = encodeURIComponent(uploadInfo.auth);
        const url = `https://${hostname}${media}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
        const body = fs.createReadStream(diskPath, { highWaterMark: 64 * 1024 });
        try {
          const resp = await axios.post(url, body, {
            ...userOptions,
            headers: {
              ...(userOptions.headers || {}),
              "Content-Type": "application/octet-stream",
              "Content-Length": contentLength,
              "Origin": DEFAULT_ORIGIN,
            },
            httpsAgent: fetchAgent,
            timeout: timeoutMs,
            responseType: "json",
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            maxRedirects: 0,
          });
          const data = resp && resp.data;
          if (data && (data.url || data.directPath || data.direct_path)) {
            urls = {
              mediaUrl: data.url,
              directPath: data.direct_path || data.directPath,
              handle: data.handle,
            };
            break;
          }
          // refresh and retry
          uploadInfo = await refreshMediaConn(true);
          lastError = new Error(`upload failed, reason: ${JSON.stringify(data)}`);
        } catch (err) {
          try { body.destroy(); } catch (_) {}
          lastError = err;
          if (log && log.warn) {
            const trace = err && err.stack;
            log.warn({ trace, host: hostname }, `streaming upload failed on ${hostname}, retrying...`);
          }
        }
      }
    } finally {
      // The encryption patch attaches its own cleanup on the encWriteStream
      // close event — but if we spooled the input ourselves here, we own
      // the temp file's lifetime.
      if (spooled) safeUnlink(diskPath);
    }

    if (!urls) {
      throw lastError || new Error("Streaming media upload failed on all hosts");
    }
    return urls;
  };

  sock._bwmStreamingInstalled = true;
  if (log && log.info) log.info("[baileys-streaming-upload] streaming waUploadToServer installed");
  else console.log("[baileys-streaming-upload] streaming waUploadToServer installed");
}

module.exports = {
  patchBaileysEncryption,
  installStreamingUpload,
};
