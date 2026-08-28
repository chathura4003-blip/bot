"use strict";

const { logger } = require("../logger");

class MessageManager {
  constructor() {
    this.pending = new Map();
  }

  async sendTemp(sock, jid, text, ms = 6000) {
    if (!sock || !jid || !text) return null;
    try {
      const sent = await sock.sendMessage(jid, { text });
      if (!sent?.key) return sent;

      logger(`[MsgMgr] SentTemp: ${jid}`);

      this._cancelPending(jid);

      const timer = setTimeout(async () => {
        this.pending.delete(jid);
        try {
          await sock.sendMessage(jid, { delete: sent.key });
        } catch {}
      }, ms);
      timer.unref();

      this.pending.set(jid, { key: sent.key, timer });
      return sent;
    } catch (err) {
      if (!jid?.endsWith("@lid")) {
        logger(`[MsgMgr] sendTemp error to ${jid}: ${err.message}`);
      }
      return null;
    }
  }

  async send(sock, jid, content) {
    if (!sock || !jid || !content) return null;
    try {
      if (content.text) content.text += "\u200B";
      if (content.caption) content.caption += "\u200B";
      
      const sent = await sock.sendMessage(jid, content);
      if (sent)
        logger(`[MsgMgr] Sent: ${jid} (${Object.keys(content).join(", ")})`);

      return sent;
    } catch (err) {
      if (!err.message?.includes("403") && !jid?.endsWith("@lid")) {
        logger(`[MsgMgr] Send error to ${jid}: ${err.message}`);
      }
      return null;
    }
  }

  async react(sock, jid, msgKey, emoji) {
    if (!sock || !jid || !msgKey || !emoji) return;
    try {
      await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } });
      logger(`[MsgMgr] React: ${jid} (${emoji})`);
    } catch {}
  }

  async delete(sock, jid, msgKey) {
    if (!sock || !jid || !msgKey) return false;
    try {
      await sock.sendMessage(jid, { delete: msgKey });
      return true;
    } catch {
      return false;
    }
  }

  _cancelPending(jid) {
    const rec = this.pending.get(jid);
    if (rec?.timer) clearTimeout(rec.timer);
    this.pending.delete(jid);
  }

  cleanup() {
    for (const { timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
    }
    this.pending.clear();
  }
}

module.exports = new MessageManager();
