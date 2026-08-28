"use strict";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDue(item, now = Date.now()) {
  if (!item || item.sent || item.failed) return false;
  const scheduledAt = Date.parse(item.scheduledAt || "");
  return Number.isFinite(scheduledAt) && scheduledAt <= now;
}

function createSchedulerRuntime(deps = {}) {
  const {
    listScheduler,
    updateSchedulerItem,
    resolveTargets,
    getSocketForSession,
    emitSchedulerUpdate,
    logger,
    pollIntervalMs = 1500,
  } = deps;

  const processing = new Set();
  let timer = null;

  async function executeItem(item) {
    const id = item?.id;
    if (!id || processing.has(id)) return;
    processing.add(id);

    try {
      const session = getSocketForSession(item.sessionId);
      if (!session?.sock) {
        const failed = updateSchedulerItem(id, {
          failed: true,
          failedAt: new Date().toISOString(),
          lastError: `${session?.label || item.sessionId || "Selected bot"} is not connected`,
          attemptedTargets: 0,
          sentCount: 0,
          failedCount: 0,
        });
        if (failed) emitSchedulerUpdate(failed);
        return;
      }

      const targets = resolveTargets(item.targetType, item.targets);
      if (!targets.length) {
        const failed = updateSchedulerItem(id, {
          failed: true,
          failedAt: new Date().toISOString(),
          lastError: "No valid targets resolved for this scheduled job",
          attemptedTargets: 0,
          sentCount: 0,
          failedCount: 0,
        });
        if (failed) emitSchedulerUpdate(failed);
        return;
      }

      let sentCount = 0;
      let failedCount = 0;
      let lastError = null;

      for (const jid of targets) {
        try {
          await session.sock.sendMessage(jid, { text: item.message });
          sentCount += 1;
        } catch (error) {
          failedCount += 1;
          lastError = error?.message || String(error);
        }

        await delay(300);
      }

      const attemptedTargets = sentCount + failedCount;
      const completedAt = new Date().toISOString();
      const partialFailure = failedCount > 0;
      const completed = updateSchedulerItem(id, {
        sent: sentCount > 0,
        sentAt: sentCount > 0 ? completedAt : null,
        failed: partialFailure,
        failedAt: partialFailure ? completedAt : null,
        lastError,
        sentCount,
        failedCount,
        attemptedTargets,
      });

      if (completed) {
        emitSchedulerUpdate(completed);
      }

      logger(
        `[Scheduler] Job ${id} processed via ${session.sessionId}: sent=${sentCount}, failed=${failedCount}, targets=${attemptedTargets}`
      );
    } catch (error) {
      const failed = updateSchedulerItem(id, {
        failed: true,
        failedAt: new Date().toISOString(),
        lastError: error?.message || String(error),
      });
      if (failed) emitSchedulerUpdate(failed);
      logger(`[Scheduler] Job ${id} crashed: ${error?.message || error}`);
    } finally {
      processing.delete(id);
    }
  }

  async function sweep() {
    const jobs = listScheduler().filter((item) => isDue(item));
    for (const item of jobs) {
      await executeItem(item);
    }
  }

  return {
    start() {
      if (timer) return timer;
      timer = setInterval(() => {
        sweep().catch((error) => {
          logger(`[Scheduler] Sweep failed: ${error?.message || error}`);
        });
      }, pollIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
      return timer;
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    sweep,
  };
}

module.exports = {
  createSchedulerRuntime,
};
