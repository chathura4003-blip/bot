'use strict';

/**
 * Safe Priority Task Dispatcher & Concurrency Queue
 * - Prioritizes interactive commands (.ping, .menu, numeric replies) over heavy tasks (.movie, yt-dlp)
 * - Preserves strict serial ordering per chat while executing unrelated chats concurrently
 * - Bounded global concurrency prevents event loop exhaustion
 */

const { logger } = require('../logger');

const PRIORITY_HIGH = 0;   // ping, menu, help, numeric replies, owner commands
const PRIORITY_NORMAL = 1; // standard commands, user queries
const PRIORITY_HEAVY = 2;  // movies, baiscope, media downloads, AI generation

class TaskDispatcher {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || parseInt(process.env.MAX_COMMAND_CONCURRENCY, 10) || 8;
    this.activeWorkers = 0;
    this.queues = {
      [PRIORITY_HIGH]: [],
      [PRIORITY_NORMAL]: [],
      [PRIORITY_HEAVY]: []
    };
    // Track active execution per chat to preserve serial order within a single chat
    this.activePerChat = new Set();
  }

  /**
   * Determine priority level of a command
   */
  getPriority(commandName, text = '') {
    const name = String(commandName || '').toLowerCase().trim();
    const cleanText = String(text || '').trim();

    // High Priority: Numeric selections, ping, menu, alive, status, settings
    if (/^\d+$/.test(cleanText)) return PRIORITY_HIGH;
    if (['ping', 'menu', 'help', 'alive', 'status', 'restart', 'mode', 'prefix', 'owner'].includes(name)) {
      return PRIORITY_HIGH;
    }

    // Heavy Priority: Movies, video downloads, play, audio processing, AI
    if (['movie', 'baiscope', 'baiscop', 'sinhalasub', 'video', 'song', 'ytmp3', 'ytmp4', 'play', 'download', 'ai', 'gemini'].includes(name)) {
      return PRIORITY_HEAVY;
    }

    return PRIORITY_NORMAL;
  }

  /**
   * Enqueue a task for controlled concurrent execution
   */
  dispatch(chatJid, taskFn, priority = PRIORITY_NORMAL) {
    return new Promise((resolve, reject) => {
      const task = {
        chatJid: chatJid || 'global',
        taskFn,
        priority: [PRIORITY_HIGH, PRIORITY_NORMAL, PRIORITY_HEAVY].includes(priority) ? priority : PRIORITY_NORMAL,
        resolve,
        reject,
        enqueuedAt: Date.now()
      };

      this.queues[task.priority].push(task);
      this._pump();
    });
  }

  _pump() {
    if (this.activeWorkers >= this.maxConcurrent) return;

    // Check queues in priority order: HIGH -> NORMAL -> HEAVY
    const priorityLevels = [PRIORITY_HIGH, PRIORITY_NORMAL, PRIORITY_HEAVY];

    for (const prio of priorityLevels) {
      const queue = this.queues[prio];
      if (!queue.length) continue;

      // Find first task whose chat is not currently busy (per-chat serial ordering)
      let foundIndex = -1;
      for (let i = 0; i < queue.length; i++) {
        const candidate = queue[i];
        if (!this.activePerChat.has(candidate.chatJid)) {
          foundIndex = i;
          break;
        }
      }

      if (foundIndex !== -1) {
        const [task] = queue.splice(foundIndex, 1);
        this._executeTask(task);
        if (this.activeWorkers >= this.maxConcurrent) break;
      }
    }
  }

  async _executeTask(task) {
    this.activeWorkers++;
    this.activePerChat.add(task.chatJid);

    try {
      const result = await task.taskFn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    } finally {
      this.activeWorkers--;
      this.activePerChat.delete(task.chatJid);
      // Immediately schedule next available task
      setImmediate(() => this._pump());
    }
  }

  getStatus() {
    return {
      activeWorkers: this.activeWorkers,
      maxConcurrent: this.maxConcurrent,
      highQueue: this.queues[PRIORITY_HIGH].length,
      normalQueue: this.queues[PRIORITY_NORMAL].length,
      heavyQueue: this.queues[PRIORITY_HEAVY].length,
      activeChats: Array.from(this.activePerChat)
    };
  }
}

const taskDispatcher = new TaskDispatcher();

module.exports = {
  taskDispatcher,
  TaskDispatcher,
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  PRIORITY_HEAVY
};
