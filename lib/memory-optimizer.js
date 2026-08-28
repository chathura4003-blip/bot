'use strict';

/**
 * Memory Optimizer & Smart Garbage Collector
 *
 * Automatically manages Node.js V8 heap and RSS memory to keep RAM usage low (60-120MB).
 * Triggers lightweight GC sweeps during idle periods or when heap usage exceeds thresholds.
 */

let optimizerInterval = null;
const DEFAULT_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const HEAP_GC_THRESHOLD_BYTES = 120 * 1024 * 1024; // 120 MB

function forceGc(reason = 'manual') {
    if (typeof global.gc === 'function') {
        try {
            const before = process.memoryUsage();
            global.gc();
            const after = process.memoryUsage();
            const reclaimedMb = ((before.heapUsed - after.heapUsed) / (1024 * 1024)).toFixed(1);
            if (Number(reclaimedMb) > 10) {
                // Only log if meaningful memory was reclaimed
                try {
                    const { logger } = require('../logger');
                    logger(`[Memory] GC (${reason}) reclaimed ${reclaimedMb} MB (Heap: ${Math.round(after.heapUsed / 1024 / 1024)}MB / RSS: ${Math.round(after.rss / 1024 / 1024)}MB)`);
                } catch (_) {}
            }
            return { before, after, reclaimedMb };
        } catch (_) {}
    }
    return null;
}

function checkAndOptimize() {
    const mem = process.memoryUsage();
    if (mem.heapUsed > HEAP_GC_THRESHOLD_BYTES) {
        forceGc('threshold_exceeded');
    } else {
        // Idle maintenance GC
        forceGc('idle_sweep');
    }
}

function startMemoryOptimizer(intervalMs = DEFAULT_INTERVAL_MS) {
    if (optimizerInterval) return optimizerInterval;
    
    // Initial warmup GC after 15 seconds of bot startup
    const warmupTimer = setTimeout(() => {
        forceGc('startup_warmup');
    }, 15000);
    if (typeof warmupTimer.unref === 'function') warmupTimer.unref();

    optimizerInterval = setInterval(checkAndOptimize, intervalMs);
    if (typeof optimizerInterval.unref === 'function') optimizerInterval.unref();

    return optimizerInterval;
}

function stopMemoryOptimizer() {
    if (optimizerInterval) {
        clearInterval(optimizerInterval);
        optimizerInterval = null;
    }
}

function getMemoryStats() {
    const mem = process.memoryUsage();
    return {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        externalMb: Math.round(mem.external / 1024 / 1024),
    };
}

module.exports = {
    startMemoryOptimizer,
    stopMemoryOptimizer,
    forceGc,
    getMemoryStats,
};
