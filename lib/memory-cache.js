"use strict";

class MemoryCache {
  constructor(defaultTTL = 600000) {
    this.store = new Map();
    this.timers = new Map();
    this.defaultTTL = defaultTTL;

    this._cleanup = setInterval(() => this._sweep(), 120000);
    this._cleanup.unref();
  }

  set(key, value, ttlMs) {
    if (key == null) return;
    this._clearTimer(key);
    const ttl = ttlMs || this.defaultTTL;
    const timer = setTimeout(() => this.delete(key), ttl);
    timer.unref();
    this.store.set(key, value);
    this.timers.set(key, { timer, expiresAt: Date.now() + ttl });
  }

  get(key) {
    if (key == null) return undefined;
    const meta = this.timers.get(key);
    if (!meta || meta.expiresAt < Date.now()) {
      this.delete(key);
      return undefined;
    }
    return this.store.get(key);
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    if (key == null) return;
    this._clearTimer(key);
    this.store.delete(key);
  }

  clear() {
    for (const key of [...this.store.keys()]) this.delete(key);
  }

  size() {
    return this.store.size;
  }

  _clearTimer(key) {
    const meta = this.timers.get(key);
    if (meta?.timer) clearTimeout(meta.timer);
    this.timers.delete(key);
  }

  _sweep() {
    const now = Date.now();
    for (const [key, meta] of this.timers.entries()) {
      if (meta.expiresAt < now) this.delete(key);
    }
  }

  destroy() {
    clearInterval(this._cleanup);
    this.clear();
  }
}

module.exports = { MemoryCache };
