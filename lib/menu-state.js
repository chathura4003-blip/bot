'use strict';

/**
 * In-Memory Scoped Menu State Manager
 * - Replaces synchronous filesystem storage (blink_*.js) with high-speed in-memory state
 * - Scoped by (chatJid, senderJid, menuType) with automatic TTL cleanup
 * - Zero disk I/O, zero dynamic require risks, instantaneous numeric resolution (< 1ms)
 */

const { LRUCache } = require('lru-cache');

class MenuStateManager {
  constructor(options = {}) {
    const ttlMs = options.ttlMs || 10 * 60 * 1000; // 10 minutes
    const maxEntries = options.maxEntries || 500;

    this.searchStore = new LRUCache({ max: maxEntries, ttl: ttlMs });
    this.qualityStore = new LRUCache({ max: maxEntries, ttl: ttlMs });
  }

  _makeKey(chatJid, senderJid, menuType = 'default') {
    const chat = String(chatJid || '').toLowerCase().trim();
    const sender = String(senderJid || '').toLowerCase().trim();
    return `${chat}::${sender}::${menuType}`;
  }

  /**
   * Save search results for numeric selection (1-10)
   */
  setSearchResults(chatJid, senderJid, menuType, results, metadata = {}) {
    const key = this._makeKey(chatJid, senderJid, menuType);
    this.searchStore.set(key, {
      results: Array.isArray(results) ? results : [],
      metadata,
      createdAt: Date.now()
    });
  }

  /**
   * Get search results for numeric selection
   */
  getSearchResults(chatJid, senderJid, menuType) {
    const key = this._makeKey(chatJid, senderJid, menuType);
    return this.searchStore.get(key) || null;
  }

  /**
   * Save quality download links for numeric quality selection (1-4)
   */
  setQualityLinks(chatJid, senderJid, menuType, downloadLinks, movieMetadata = {}) {
    const key = this._makeKey(chatJid, senderJid, menuType);
    this.qualityStore.set(key, {
      downloadLinks: Array.isArray(downloadLinks) ? downloadLinks : [],
      movieMetadata,
      createdAt: Date.now()
    });
  }

  /**
   * Get quality download links
   */
  getQualityLinks(chatJid, senderJid, menuType) {
    const key = this._makeKey(chatJid, senderJid, menuType);
    return this.qualityStore.get(key) || null;
  }

  /**
   * Clear state for user
   */
  clear(chatJid, senderJid, menuType) {
    const key = this._makeKey(chatJid, senderJid, menuType);
    this.searchStore.delete(key);
    this.qualityStore.delete(key);
  }
}

const menuStateManager = new MenuStateManager();

module.exports = {
  menuStateManager,
  MenuStateManager
};
