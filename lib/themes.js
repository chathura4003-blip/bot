"use strict";

/**
 * Finalized Theme System for CHATHU MD
 * 1. Sakura Blossom (User)
 * 2. Premium Minimalist (Premium)
 * 3. Master Control (Owner)
 * 4. Nexus Prime (Premium Owner)
 */

const themes = {
  // 1. Normal User Theme
  sakura: {
    name: "Sakura Blossom 🌸",
    emoji: "🌸",
    badges: {
      owner: "👑 ᴏᴡɴᴇʀ",
      premium: "⭐ ᴘʀᴇᴍɪᴜᴍ",
      user: "👤 ᴜsᴇʀ"
    },
    keywords: {
      video_ready: "ᴠɪᴅᴇᴏ ʀᴇᴀᴅʏ",
      music_player: "ᴍᴜsɪᴄ ᴘʟᴀʏᴇʀ",
      action: "ᴀᴄᴛɪᴏɴ"
    },
    styles: {
      header: "╔════════════════════════╗\n║    ✨ {title} ✨     ║\n╚════════════════════════╝\n",
      section: "╭━━━━━〔 {title} 〕━━━━━\n",
      item: "┃ {bullet} {content}\n",
      footer: "╰━━━━━━━━━━━━━━━━━━━━━━\n",
      box_start: "╭───〔 {title} 〕───\n",
      box_item: "│ {bullet} {content}\n",
      box_end: "╰──────────────────────\n",
      signature: "\n 🌸 ⋆｡°✩ 𝐂𝐇𝐀𝐓𝐇𝐔 𝐌𝐃 𝟐𝟎𝟐𝟔 ✩°｡⋆ 🌸",
      bullets: {
        default: "🌸",
        user: "👤",
        group: "👥",
        system: "⚙️",
        search: "🔍",
        creative: "🎨",
        success: "✅",
        error: "❌",
        warn: "⚠️",
        wait: "⏳"
      }
    }
  },

  // 2. Premium User Theme (Minimalist Black)
  premium_theme: {
    name: "Premium Minimalist 🌑",
    emoji: "🌑",
    badges: {
      owner: "● ᴘʀᴇᴍɪᴜᴍ ᴀᴅᴍɪɴ",
      premium: "● ᴇʟɪᴛᴇ ᴍᴇᴍʙᴇʀ",
      user: "○ ᴜsᴇʀ"
    },
    keywords: {
      video_ready: "𝐌𝐄𝐃𝐈𝐀 𝐑𝐄𝐀𝐃𝐘",
      music_player: "𝐀𝐔𝐃𝐈𝐎 𝐂𝐎𝐑𝐄",
      action: "𝐄𝐗𝐄𝐂𝐔𝐓𝐄"
    },
    styles: {
      header: "───〔 🌑 {title} 🌑 〕───\n",
      section: "\n● *{title}*\n",
      item: "  ○ {content}\n",
      footer: "───────────────────────\n",
      box_start: "┌───〔 {title} 〕\n",
      box_item: "│ ● {content}\n",
      box_end: "└───────────────────────\n",
      signature: "\n _⚡ ᴘʀᴇᴍɪᴜᴍ ᴇxᴘᴇʀɪᴇɴᴄᴇ · ᴄʜᴀᴛʜᴜ ᴍᴅ 𝟐𝟎𝟐𝟔_",
      bullets: {
        default: "●",
        user: "○",
        system: "⚙️",
        group: "👥",
        search: "🔍",
        creative: "🎨",
        success: "✅",
        warn: "⚠️",
        error: "❌",
        economy: "💰"
      }
    }
  },

  // 3. Bot Owner Theme
  owner: {
    name: "Master Control 👑",
    emoji: "👑",
    badges: {
      owner: "🥇 ᴀᴅᴍɪɴɪsᴛʀᴀᴛᴏʀ",
      premium: "🏅 ᴘʀɪᴠɪʟᴇɢᴇᴅ",
      user: "👤 sᴜʙᴊᴇᴄᴛ"
    },
    keywords: {
      video_ready: "𝐌𝐀𝐒𝐓𝐄𝐑 𝐕𝐈𝐃𝐄𝐎",
      music_player: "𝐌𝐀𝐒𝐓𝐄𝐑 𝐀𝐔𝐃𝐈𝐎",
      action: "𝐂𝐎𝐍𝐅𝐈𝐑𝐌"
    },
    styles: {
      header: "╭━━━〔 👑 𝐌𝐀𝐒𝐓𝐄𝐑 𝐂𝐎𝐍𝐓𝐑𝐎𝐋 👑 〕━━━╮\n┃       ✨ {title} ✨        ┃\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n",
      section: "⫸─────『 {title} 』─────⫷\n",
      item: "  {bullet} {content}\n",
      footer: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
      box_start: "┏╾╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼┓\n┃ ◈ {title}\n┣╾╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼┛\n",
      box_item: "┃ ➩ {content}\n",
      box_end: "┗╾╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼╼┛\n",
      signature: "\n 👑 ⋆｡°✩ 𝐂𝐇𝐀𝐓𝐇𝐔 𝐌𝐃 𝟐𝟎𝟐𝟔 ✩°｡⋆ 👑",
      bullets: {
        default: "⚡",
        user: "👤",
        group: "👥",
        system: "⚙️",
        success: "✅",
        warn: "⚠️",
        error: "❌",
        search: "🔍",
        economy: "💰",
        creative: "🎨"
      }
    }
  },

  // 4. Premium Owner Theme (Nexus Prime)
  premium_owner: {
    name: "Nexus Prime 💎",
    emoji: "💎",
    badges: {
      owner: "💠 ᴇʟɪᴛᴇ ᴀᴅᴍɪɴɪsᴛʀᴀᴛᴏʀ",
      premium: "💠 ᴘʀɪᴍᴇ ᴍᴇᴍʙᴇʀ",
      user: "◌ ᴘᴀʀᴛɪᴄʟᴇ"
    },
    keywords: {
      video_ready: "𝐒𝐘𝐒𝐓𝐄𝐌 𝐎𝐏𝐓𝐈𝐌𝐈𝐙𝐄𝐃",
      music_player: "𝐍𝐄𝐗𝐔𝐒 𝐀𝐔𝐃𝐈𝐎",
      action: "𝐈𝐍𝐈𝐓𝐈𝐀𝐓𝐄"
    },
    styles: {
      header: "◈ ──────『 💎 𝐍𝐄𝐗𝐔𝐒 𝐏𝐑𝐈𝐌𝐄 💎 』────── ◈\n┃       ✨ {title} ✨        ┃\n◈ ────────────────────────────────── ◈\n",
      section: "⌬ ──── [ {title} ] ──── ⌬\n",
      item: "  ⋄ {content}\n",
      footer: "◈ ────────────────────────────────── ◈\n",
      box_start: "┏━━━━━━━ ⌬ {title}\n",
      box_item: "┃ ⚡ {content}\n",
      box_end: "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n",
      signature: "\n 💎 ⋆｡°✩ 𝐂𝐇𝐀𝐓𝐇𝐔 𝐌𝐃 𝐍𝐄𝐗𝐔𝐒 𝟐𝟎𝟐𝟔 ✩°｡⋆ 💎",
      bullets: {
        default: "💠",
        user: "👤",
        group: "🌐",
        system: "⚙️",
        success: "✅",
        warn: "⚠️",
        error: "❌",
        search: "🔍",
        economy: "💎",
        creative: "🎨"
      }
    }
  }
};

module.exports = { themes };
