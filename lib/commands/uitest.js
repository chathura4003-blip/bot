"use strict";

module.exports = {
  name: "uitest",
  aliases: [],
  category: "system",
  description: "Test WhatsApp interactive list support",

  async execute(sock, msg, from) {
    await sock.sendMessage(from, {
      text: "UI Test",
      footer: "CHATHU MD",
      title: "Choose Option",
      buttonText: "📋 Open Test",
      sections: [
        {
          title: "Test",
          rows: [
            { title: "AI Center", rowId: "menu:cat:ai", description: "Open AI menu" },
            { title: "Downloader", rowId: "menu:cat:downloader", description: "Open downloader" },
          ],
        },
      ],
    }, { quoted: msg });
  },
};
