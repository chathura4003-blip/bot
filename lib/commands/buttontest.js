"use strict";

/**
 * .buttontest / .btest — quick smoke test for the wabase-button-style
 * `interactiveButtons` send. Sends a fixed three-button quick-reply card
 * directly via sock.sendMessage so we can verify Baileys actually renders
 * WhatsApp buttons under the message body.
 */

module.exports = {
  name: "buttontest",
  aliases: ["btest"],
  category: "system",
  description: "Send a sample interactiveButtons quick-reply card for testing.",

  async execute(sock, msg, from) {
    return await sock.sendMessage(from, {
      text: "🤖 Welcome to CHATHU MD\nChoose an option from below",
      title: "CHATHU MD V4",
      footer: "CHATHU MD",
      interactiveButtons: [
        {
          name: "quick_reply",
          buttonParamsJson: JSON.stringify({
            display_text: "🤖 AI Center",
            id: "menu:cat:ai",
          }),
        },
        {
          name: "quick_reply",
          buttonParamsJson: JSON.stringify({
            display_text: "🎬 Downloader",
            id: "menu:cat:downloader",
          }),
        },
        {
          name: "quick_reply",
          buttonParamsJson: JSON.stringify({
            display_text: "⚙️ Settings",
            id: "menu:cat:settings",
          }),
        },
      ],
    }, { quoted: msg });
  },
};
