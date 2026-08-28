"use strict";

// .btnshow — demonstrates the mixed-button card layout (image header +
// CTA URL + quick_reply pills) used by the new advanced UI mode.
//
// Pulls live values from env so the example matches whatever the user has
// configured for their main menu:
//
//   MENU_BANNER_URL   — banner image shown above the body
//   MENU_WEBSITE_URL  — "🔗 Visit Us" CTA URL button (browser link)
//
// Quick-reply tiles below mirror the wabase-button reference card so you
// can confirm WhatsApp is rendering the expected card. The IDs use the
// regular `menu:cat:*` action namespace so taps drill into existing
// categories instead of dead-ending.

module.exports = {
  name: "btnshow",
  aliases: ["uidemo", "ctabuttons"],
  category: "system",
  description: "Demo card showing the advanced UI mode (banner + CTA URL + quick-reply buttons).",

  async execute(sock, msg, from) {
    const cfg = (() => {
      try { return require("../../config"); } catch (_) { return {}; }
    })();

    const botName = String(cfg.BOT_NAME || "CHATHU MD");
    const banner = process.env.MENU_BANNER_URL && String(process.env.MENU_BANNER_URL).trim();
    const website = process.env.MENU_WEBSITE_URL && String(process.env.MENU_WEBSITE_URL).trim();

    const interactiveButtons = [];

    if (website) {
      interactiveButtons.push({
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: "🔗 Visit Us",
          url: website,
          merchant_url: website,
        }),
      });
    }

    interactiveButtons.push(
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: "🤖 AI Center", id: "menu:cat:ai" }),
      },
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: "🎬 Downloader", id: "menu:cat:downloader" }),
      },
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: "⚙️ Settings", id: "menu:cat:settings" }),
      },
    );

    // Cap to 5 buttons total — that's what WhatsApp actually renders for
    // an interactive card. CTA buttons sit at the top so they always make
    // it onto the card, then quick-reply tiles fill the remaining slots.
    const buttons = interactiveButtons.slice(0, 5);
    const caption = `Welcome to ${botName}\nChoose an option from below`;

    const payload = {
      caption,
      title: botName,
      footer: botName,
      media: !!banner,
      interactiveButtons: buttons,
    };

    if (banner) {
      payload.image = { url: banner };
    } else {
      // No banner configured: degrade gracefully to a plain text card.
      delete payload.caption;
      payload.text = caption;
      delete payload.media;
    }

    return await sock.sendMessage(from, payload, { quoted: msg });
  },
};
