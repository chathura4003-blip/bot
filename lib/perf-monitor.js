'use strict';

/**
 * Performance Monitor & Precision Request Instrumentation
 * Measures latency across message ingestion, routing, scraping, downloads, and WhatsApp dispatch.
 */

const { logger } = require('../logger');

class PerformanceMonitor {
  constructor() {
    this.activeTraces = new Map();
    this.metrics = {
      totalCommands: 0,
      latencies: [],
      errorCount: 0,
      stageDurations: {
        ingestion: [],
        routing: [],
        scraping: [],
        download: [],
        dispatch: []
      }
    };
    this.maxLatencySamples = 500;
  }

  /**
   * Start a performance trace for an incoming message / command
   */
  startTrace(msgId, jid, commandName = 'unknown') {
    const traceId = `${msgId || Date.now()}:${jid || 'unknown'}:${commandName}`;
    const trace = {
      traceId,
      msgId,
      jid,
      commandName,
      startTime: process.hrtime.bigint(),
      stages: new Map(),
      lastMark: process.hrtime.bigint()
    };
    this.activeTraces.set(traceId, trace);
    return traceId;
  }

  /**
   * Mark the completion of an internal stage (e.g. 'routing', 'scraping', 'download', 'dispatch')
   */
  mark(traceId, stageName) {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    const now = process.hrtime.bigint();
    const durationMs = Number(now - trace.lastMark) / 1e6;
    trace.stages.set(stageName, durationMs);
    trace.lastMark = now;

    if (this.metrics.stageDurations[stageName]) {
      this.metrics.stageDurations[stageName].push(durationMs);
      if (this.metrics.stageDurations[stageName].length > this.maxLatencySamples) {
        this.metrics.stageDurations[stageName].shift();
      }
    }
  }

  /**
   * End trace and log classified performance metrics
   */
  endTrace(traceId, success = true) {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return null;

    const now = process.hrtime.bigint();
    const totalMs = Number(now - trace.startTime) / 1e6;
    this.activeTraces.delete(traceId);

    this.metrics.totalCommands++;
    if (!success) this.metrics.errorCount++;

    this.metrics.latencies.push(totalMs);
    if (this.metrics.latencies.length > this.maxLatencySamples) {
      this.metrics.latencies.shift();
    }

    // Performance classification
    let classification = 'FAST';
    if (totalMs > 10000) classification = 'CRITICAL';
    else if (totalMs > 3000) classification = 'VERY_SLOW';
    else if (totalMs > 1500) classification = 'SLOW';
    else if (totalMs > 500) classification = 'NORMAL';

    const stageSummary = Array.from(trace.stages.entries())
      .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
      .join(' ');

    logger(`[PERF][${classification}] cmd=${trace.commandName} total=${totalMs.toFixed(1)}ms ${stageSummary}`);

    return {
      traceId,
      totalMs,
      classification,
      stages: Object.fromEntries(trace.stages)
    };
  }

  /**
   * Calculate percentile latency (p50, p95, p99)
   */
  getStats() {
    const sorted = [...this.metrics.latencies].sort((a, b) => a - b);
    const count = sorted.length;
    if (count === 0) {
      return { p50: 0, p95: 0, p99: 0, total: 0, errorCount: 0, activeTraces: this.activeTraces.size };
    }

    const p50 = sorted[Math.floor(count * 0.50)] || 0;
    const p95 = sorted[Math.floor(count * 0.95)] || 0;
    const p99 = sorted[Math.floor(count * 0.99)] || 0;

    return {
      p50: Number(p50.toFixed(1)),
      p95: Number(p95.toFixed(1)),
      p99: Number(p99.toFixed(1)),
      total: this.metrics.totalCommands,
      errorCount: this.metrics.errorCount,
      activeTraces: this.activeTraces.size
    };
  }
}

const perfMonitor = new PerformanceMonitor();

module.exports = {
  perfMonitor,
  PerformanceMonitor
};
