"use strict";

const { logger } = require("../logger");

async function safeExecute(fn, context = "Operation", fallback = null) {
  try {
    return await fn();
  } catch (err) {
    logger(`[${context}] ${err?.message || err}`);
    return fallback;
  }
}

async function retryWithBackoff(
  fn,
  {
    maxAttempts = 3,
    delayMs = 1000,
    backoffMultiplier = 2,
    context = "Retry",
    throwOnFail = true,
    fallback = null,
  } = {},
) {
  let delay = delayMs;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger(
        `[${context}] Attempt ${attempt}/${maxAttempts} failed: ${err?.message}`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * backoffMultiplier, 30000);
      }
    }
  }
  if (throwOnFail) throw lastErr;
  return fallback;
}

function handleAPIError(err, context = "API") {
  const msg = err?.message || String(err);
  const code = err?.response?.status || err?.code || 500;
  logger(`[${context}] Error (${code}): ${msg}`);

  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
    return { message: "⏱️ Request timed out. Please try again." };
  }
  if (code === 429) {
    return { message: "⏳ Too many requests. Please wait a moment." };
  }
  if (code === 403 || code === 401) {
    return { message: "🔒 Access denied — content may be private or removed." };
  }
  if (code === 404) {
    return { message: "❌ Content not found. Check the link." };
  }
  if (msg.includes("ECONNREFUSED") || msg.toLowerCase().includes("network")) {
    return { message: "🌐 Network error. Check your connection." };
  }
  return { message: "❌ An error occurred. Please try again." };
}

module.exports = { safeExecute, retryWithBackoff, handleAPIError };
