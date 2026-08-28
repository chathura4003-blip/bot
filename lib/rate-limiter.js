"use strict";

class RateLimiter {
  constructor() {
    this.limits = new Map();
    this._cleanup = setInterval(() => this._sweep(), 120000);
    this._cleanup.unref();
  }

  /**
   * Check if action is allowed for jid.
   * @returns {{ allowed: boolean, resetIn: number }}
   */
  check(jid, action, maxPerMinute = 10) {
    if (!jid || !action) return { allowed: false, resetIn: 0 };

    const key = `${jid}:${action}`;
    const now = Date.now();
    const windowStart = now - 60000;

    if (!this.limits.has(key)) {
      this.limits.set(key, []);
    }

    const timestamps = this.limits.get(key).filter((t) => t > windowStart);
    this.limits.set(key, timestamps);

    if (timestamps.length >= maxPerMinute) {
      const resetIn = Math.ceil((timestamps[0] + 60000 - now) / 1000);
      return { allowed: false, resetIn };
    }

    timestamps.push(now);
    return { allowed: true, resetIn: 0 };
  }

  /**
   * Alias used by some commands: trackRateLimit(jid, action, max, windowMs)
   * Returns { ok: boolean, retryAfter: number (ms) }
   */
  trackRateLimit(jid, action, max = 10, windowMs = 60000) {
    const result = this.check(jid, action, max);
    return {
      ok: result.allowed,
      retryAfter: result.resetIn * 1000,
    };
  }

  _sweep() {
    const cutoff = Date.now() - 120000;
    for (const [key, ts] of this.limits.entries()) {
      if (!ts.length || ts[ts.length - 1] < cutoff) {
        this.limits.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanup);
    this.limits.clear();
  }
}

const instance = new RateLimiter();
// Export both the instance and the trackRateLimit function directly
module.exports = instance;
module.exports.trackRateLimit = instance.trackRateLimit.bind(instance);
