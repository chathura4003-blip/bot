"use strict";

const db = require("../db");
const { sendReact, truncate, isOwner } = require("../utils");
const msgMgr = require("../message-manager");
const themeMgr = require("../theme-manager");

module.exports = [
  {
    name: "autoview",
    aliases: ["autostatus"],
    description: "Toggle automatic status viewing.",
    category: "automation",
    async execute(sock, msg, from, args, cmdName, context) {
      const sender = msg.key.participant || msg.key.remoteJid;
      const ownerRefs = context.owner ? [context.owner] : [];
      const tCtx = { sender, ownerRefs };
      
      const isSelf = msg.key.fromMe || isOwner(sender, ownerRefs);
      if (!isSelf) {
        return msgMgr.sendTemp(sock, from, "❌ Only bot owner can use this command.", 5000);
      }

      const action = args[0]?.toLowerCase();
      const sessionId = context.sessionId || '__main__';

      if (action === "on" || action === "off") {
          const value = action === "on";
          if (sessionId === '__main__') {
              require('../../state').setAutoStatus(value);
              require('../../lib/db').setSetting('auto_view_status', value);
              try {
                  const io = require('../../dashboard').io;
                  if (io) io.emit('session:update', require('../../dashboard').getMainSessionPayload());
              } catch {}
          } else {
              await require('../../session-manager').updateSessionSettings(sessionId, { autoStatus: value });
          }
          await msgMgr.send(sock, from, { text: `✅ *Auto-View Status ${value ? 'enabled' : 'disabled'}*.` });
      } else {
          let statusStr = "OFF";
          if (sessionId === '__main__') {
              statusStr = require('../../lib/runtime-settings').getAutoViewStatus() !== false ? "ON" : "OFF";
          } else {
              const sessionMgr = require('../../session-manager');
              const session = sessionMgr.get(sessionId);
              if (session) {
                  statusStr = session.autoStatus !== false ? "ON" : "OFF";
              }
          }
          
          let reply = themeMgr.format("header", { title: "ᴀᴜᴛᴏ-ᴠɪᴇᴡ sᴇᴛᴛɪɴɢ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: "sʏsᴛᴇᴍ ᴄᴏɴғɪɢ" }, tCtx);
          reply += themeMgr.format("item", { bullet: "system", content: `Status : ${statusStr}` }, tCtx);
          reply += themeMgr.format("item", { bullet: "default", content: "Usage  : .autoview [on|off]" }, tCtx);
          reply += themeMgr.format("footer", {}, tCtx);
          reply += themeMgr.getSignature(sender, ownerRefs);
          await msgMgr.send(sock, from, { text: reply });
      }
    },
  },
  {
    name: "autoreact",
    description: "Toggle automatic status reactions.",
    category: "automation",
    async execute(sock, msg, from, args, cmdName, context) {
      const sender = msg.key.participant || msg.key.remoteJid;
      const ownerRefs = context.owner ? [context.owner] : [];
      const tCtx = { sender, ownerRefs };
      
      const isSelf = msg.key.fromMe || isOwner(sender, ownerRefs);
      if (!isSelf) {
        return msgMgr.sendTemp(sock, from, "❌ Only bot owner can use this command.", 5000);
      }

      const action = args[0]?.toLowerCase();
      const sessionId = context.sessionId || '__main__';

      if (action === "on" || action === "off") {
          const value = action === "on";
          if (sessionId === '__main__') {
              require('../../state').setAutoReactStatus(value);
              require('../../lib/db').setSetting('auto_react_status', value);
              try {
                  const io = require('../../dashboard').io;
                  if (io) io.emit('session:update', require('../../dashboard').getMainSessionPayload());
              } catch {}
          } else {
              await require('../../session-manager').updateSessionSettings(sessionId, { autoReactStatus: value });
          }
          await msgMgr.send(sock, from, { text: `✅ *Auto-React Status ${value ? 'enabled' : 'disabled'}*.` });
      } else {
          let statusStr = "OFF";
          if (sessionId === '__main__') {
              statusStr = require('../../state').getAutoReactStatus() === true ? "ON" : "OFF";
          } else {
              const sessionMgr = require('../../session-manager');
              const session = sessionMgr.get(sessionId);
              if (session) {
                  statusStr = (session.autoReactStatus !== null && session.autoReactStatus !== undefined) 
                      ? (session.autoReactStatus ? "ON" : "OFF") 
                      : (require('../../state').getAutoReactStatus() === true ? "ON" : "OFF");
              }
          }
          
          let reply = themeMgr.format("header", { title: "ᴀᴜᴛᴏ-ʀᴇᴀᴄᴛ sᴇᴛᴛɪɴɢ" }, tCtx);
          reply += "\n";
          reply += themeMgr.format("section", { title: "sʏsᴛᴇᴍ ᴄᴏɴғɪɢ" }, tCtx);
          reply += themeMgr.format("item", { bullet: "system", content: `Status : ${statusStr}` }, tCtx);
          reply += themeMgr.format("item", { bullet: "default", content: "Usage  : .autoreact [on|off]" }, tCtx);
          reply += themeMgr.format("footer", {}, tCtx);
          reply += themeMgr.getSignature(sender, ownerRefs);
          await msgMgr.send(sock, from, { text: reply });
      }
    },
  }
];
