"use strict";

const { themes } = require("./themes");
const db = require("./db");

class ThemeManager {
  constructor() {
    this.defaultTheme = "sakura";
    this.autoTheme = "auto";
  }

  /**
   * Get the current active theme based on user role or global setting.
   * @param {string} sender - JID of the user
   * @param {Array} ownerRefs - Optional extra owner JIDs
   */
  getCurrentTheme(sender = null, ownerRefs = []) {
    const activeSetting = db.getSetting("active_theme") || this.autoTheme;

    // If not auto, use the global setting
    if (activeSetting !== this.autoTheme) {
      return themes[activeSetting] || themes[this.defaultTheme];
    }

    // Auto mode logic
    if (sender) {
      const { isOwner } = require("./utils");
      const user = db.get("users", sender);
      const isUserPremium = user && user.premium;
      const isUserOwner = isOwner(sender, ownerRefs);

      if (isUserOwner && isUserPremium) {
        return themes["premium_owner"] || themes["owner"] || themes[this.defaultTheme];
      }
      
      if (isUserOwner) {
        return themes["owner"] || themes[this.defaultTheme];
      }

      if (isUserPremium) {
        return themes["premium_theme"] || themes[this.defaultTheme];
      }
    }

    return themes[this.defaultTheme];
  }

  /**
   * Format a message using the current theme.
   * @param {string} type - The style type (header, section, item, etc.)
   * @param {Object} data - Placeholders to replace in the style template
   * @param {Object} context - Optional context { sender, ownerRefs }
   * @returns {string} Formatted string
   */
  format(type, data = {}, context = {}) {
    const theme = this.getCurrentTheme(context.sender, context.ownerRefs);
    let template = theme.styles[type] || "";

    if (data.bullet && theme.styles.bullets[data.bullet]) {
      data.bullet = theme.styles.bullets[data.bullet];
    } else if (data.bullet === undefined) {
      data.bullet = theme.styles.bullets.default;
    }

    Object.keys(data).forEach(key => {
      const regex = new RegExp(`{${key}}`, 'g');
      template = template.replace(regex, data[key]);
    });

    return template;
  }

  /**
   * Get all available theme names and emojis
   */
  getAvailableThemes() {
    const list = Object.keys(themes).map(key => ({
      id: key,
      name: themes[key].name,
      emoji: themes[key].emoji
    }));
    list.unshift({ id: "auto", name: "Automatic (Role-based) 🤖", emoji: "🤖" });
    return list;
  }

  /**
   * Set the active theme
   */
  setTheme(themeName) {
    if (themeName === this.autoTheme || themes[themeName]) {
      db.setSetting("active_theme", themeName);
      return true;
    }
    return false;
  }

  /**
   * Shorthand for signature
   */
  getSignature(sender = null, ownerRefs = []) {
    return this.getCurrentTheme(sender, ownerRefs).styles.signature;
  }
  
  /**
   * Shorthand for bullet
   */
  getBullet(name) {
    const theme = this.getCurrentTheme();
    return theme.styles.bullets[name] || theme.styles.bullets.default;
  }

  /**
   * Get a badge based on user role
   */
  getBadge(sender = null, ownerRefs = []) {
    const theme = this.getCurrentTheme(sender, ownerRefs);
    const { isOwner } = require("./utils");
    
    if (sender && isOwner(sender, ownerRefs)) return theme.badges?.owner || "👑 Owner";
    
    const user = db.get("users", sender);
    if (user && user.premium) return theme.badges?.premium || "⭐ Premium";
    
    return theme.badges?.user || "👤 User";
  }

  /**
   * Get an interaction keyword
   */
  getKeyword(key) {
    const theme = this.getCurrentTheme();
    return theme.keywords?.[key] || key.toUpperCase().replace("_", " ");
  }

  /**
   * Get all interaction keywords across all themes (for validation)
   */
  getAllKeywords(key) {
    if (!this._keywordsCache) this._keywordsCache = new Map();
    if (this._keywordsCache.has(key)) return this._keywordsCache.get(key);

    const result = new Set();
    Object.values(themes).forEach(t => {
      if (t.keywords?.[key]) result.add(t.keywords[key]);
    });
    // Add default uppercase as fallback
    result.add(key.toUpperCase().replace("_", " "));
    const arr = Array.from(result);
    this._keywordsCache.set(key, arr);
    return arr;
  }
}

module.exports = new ThemeManager();
