'use strict';

/**
 * Centralized High-Performance Puppeteer Browser Pool
 * - Manages single shared Chromium instance across all commands (Baiscope, Sinhalasub, web scrapers)
 * - Controlled concurrency with MAX_BROWSER_PAGES (default 3)
 * - Aggressive resource aborting for non-essential assets (images, fonts, stylesheets, ads, analytics)
 * - Safe idle shutdown (60s) with auto-restart on demand
 */

const puppeteer = require('puppeteer');
const { getBrowserLaunchOptions } = require('./browser-helper');
const { logger } = require('../logger');

class BrowserPool {
  constructor(options = {}) {
    this.maxPages = options.maxPages || parseInt(process.env.MAX_BROWSER_PAGES, 10) || 3;
    this.idleTimeoutMs = options.idleTimeoutMs || 60000;
    this.browser = null;
    this.activePages = 0;
    this.idleTimer = null;
    this.launchPromise = null;
    this.pageQueue = [];
  }

  /**
   * Acquire or reuse global Chromium browser
   */
  async getBrowser() {
    this._clearIdleTimer();

    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      try {
        logger('[BrowserPool] Launching shared Chromium instance...');
        const launchOptions = getBrowserLaunchOptions();
        this.browser = await puppeteer.launch(launchOptions);
        this.browser.on('disconnected', () => {
          logger('[BrowserPool] Browser disconnected.');
          this.browser = null;
          this.activePages = 0;
        });
        return this.browser;
      } catch (err) {
        logger(`[BrowserPool] Failed to launch Chromium: ${err.message}`);
        this.browser = null;
        throw err;
      } finally {
        this.launchPromise = null;
      }
    })();

    return this.launchPromise;
  }

  /**
   * Execute an operation inside a controlled, isolated page with resource aborting and auto-cleanup
   */
  async withPage(fn, options = {}) {
    const timeoutMs = options.timeoutMs || 30000;
    const blockResources = options.blockResources !== false;

    // Enforce page concurrency limit
    if (this.activePages >= this.maxPages) {
      await new Promise((resolve) => this.pageQueue.push(resolve));
    }

    this.activePages++;
    const browser = await this.getBrowser();
    let page = null;

    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );

      if (blockResources) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
          const resourceType = req.resourceType();
          const url = req.url().toLowerCase();
          const isAd = /ads|analytics|doubleclick|popunder|1xbet|bet365|google-analytics|clarity/i.test(url);

          if (['image', 'font', 'media'].includes(resourceType) || isAd) {
            req.abort().catch(() => {});
          } else {
            req.continue().catch(() => {});
          }
        });
      }

      // Execute task with timeout deadline
      const result = await Promise.race([
        fn(page),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Browser operation timed out after ${timeoutMs}ms`)), timeoutMs)
        )
      ]);

      return result;
    } finally {
      if (page && !page.isClosed()) {
        try { await page.close().catch(() => {}); } catch (_) {}
      }
      this.activePages--;

      if (this.pageQueue.length > 0) {
        const next = this.pageQueue.shift();
        next();
      } else if (this.activePages === 0) {
        this._scheduleIdleClose();
      }
    }
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _scheduleIdleClose() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      if (this.activePages === 0 && this.browser && this.browser.isConnected()) {
        logger('[BrowserPool] Auto-closing idle browser to reclaim RAM...');
        try { await this.browser.close().catch(() => {}); } catch (_) {}
        this.browser = null;
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch (_) {}
        }
      }
    }, this.idleTimeoutMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  async close() {
    this._clearIdleTimer();
    if (this.browser && this.browser.isConnected()) {
      try { await this.browser.close().catch(() => {}); } catch (_) {}
    }
    this.browser = null;
    this.activePages = 0;
  }
}

const browserPool = new BrowserPool();

module.exports = {
  browserPool,
  BrowserPool
};
