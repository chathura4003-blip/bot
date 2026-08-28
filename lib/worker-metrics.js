'use strict';

const fs = require('fs');
const os = require('os');
const { getBinPath, FFMPEG_PATH } = require('./ytdlp-manager');

/**
 * In-memory telemetry and speed tracker for Railway Cloud Worker
 */
class WorkerMetrics {
  constructor() {
    this.totalDownloadedBytes = 0;
    this.totalUploadedBytes = 0;
    this.totalCompletedTasks = 0;
    this.totalFailedTasks = 0;
    this.peakDownloadSpeed = '0 MB/s';
    this.peakDownloadSpeedMBps = 0;
    this.currentDownloadSpeed = '0.0 MB/s';
    this.currentUploadSpeed = '0.0 MB/s';
    this.activeTasks = new Map();
    this.history = [];
    this.serverStartTime = Date.now();
  }

  formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes === 0) return '0 MB';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  parseSpeedToMBps(speedStr) {
    if (!speedStr) return 0;
    const str = String(speedStr).trim().toLowerCase();
    const num = parseFloat(str) || 0;
    if (str.includes('gib/s') || str.includes('gb/s')) return num * 1024;
    if (str.includes('mib/s') || str.includes('mb/s')) return num;
    if (str.includes('kib/s') || str.includes('kb/s')) return num / 1024;
    if (str.includes('b/s')) return num / (1024 * 1024);
    return num;
  }

  startTask({ taskId, fileName, sourceUrl, targetJid, mode = 'video' }) {
    const task = {
      taskId,
      fileName,
      sourceUrl,
      targetJid,
      mode,
      percent: 0,
      speed: 'Connecting...',
      eta: '...',
      startTime: Date.now(),
      sizeBytes: 0,
      status: 'Downloading'
    };
    this.activeTasks.set(taskId, task);
    return task;
  }

  updateTaskProgress(taskId, { percent, speed, eta, sizeBytes }) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    if (percent !== undefined) task.percent = parseFloat(percent) || 0;
    if (speed !== undefined) {
      task.speed = speed;
      this.currentDownloadSpeed = speed;

      const speedMBps = this.parseSpeedToMBps(speed);
      if (speedMBps > this.peakDownloadSpeedMBps) {
        this.peakDownloadSpeedMBps = speedMBps;
        this.peakDownloadSpeed = speed;
      }
    }
    if (eta !== undefined) task.eta = eta;
    if (sizeBytes !== undefined) task.sizeBytes = sizeBytes;
  }

  finishTask(taskId, { success = true, finalSizeBytes = 0, elapsedSec = 0, avgSpeed = '', error = null }) {
    const task = this.activeTasks.get(taskId);
    const duration = elapsedSec ? `${elapsedSec}s` : task ? `${((Date.now() - task.startTime) / 1000).toFixed(1)}s` : '0s';
    const size = finalSizeBytes || (task ? task.sizeBytes : 0);

    if (success) {
      this.totalCompletedTasks++;
      this.totalDownloadedBytes += size;
      this.totalUploadedBytes += size; // Streamed to WhatsApp
    } else {
      this.totalFailedTasks++;
    }

    const historyItem = {
      id: taskId,
      fileName: task ? task.fileName : 'Media File',
      sourceUrl: task ? task.sourceUrl : '',
      targetJid: task ? task.targetJid : '',
      mode: task ? task.mode : 'media',
      size: this.formatBytes(size),
      sizeBytes: size,
      avgSpeed: avgSpeed || (task ? task.speed : '1 Gbps Line'),
      duration,
      timestamp: new Date().toLocaleTimeString(),
      success,
      error: error ? String(error) : null
    };

    this.history.unshift(historyItem);
    if (this.history.length > 30) this.history.pop();

    this.activeTasks.delete(taskId);
    if (this.activeTasks.size === 0) {
      this.currentDownloadSpeed = '0.0 MB/s';
    }
  }

  recordStreamActivity(bytesChunk = 0, speedStr = '') {
    if (bytesChunk > 0) this.totalUploadedBytes += bytesChunk;
    if (speedStr) this.currentUploadSpeed = speedStr;
  }

  getSnapshot() {
    const mem = process.memoryUsage();
    const usedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    const uptimeSec = Math.floor(process.uptime());

    const activeList = Array.from(this.activeTasks.values()).map(t => ({
      ...t,
      elapsed: `${((Date.now() - t.startTime) / 1000).toFixed(1)}s`
    }));

    return {
      status: 'online',
      service: 'CHATHU-MD Cloud 1 Gbps Worker',
      uptime: this.formatUptime(uptimeSec),
      uptimeSeconds: uptimeSec,
      memory: {
        usedMB,
        totalMB: totalMemMB,
        percent: Math.min(100, Math.round((usedMB / 512) * 100)) // Railway 512MB baseline
      },
      system: {
        platform: process.platform,
        nodeVersion: process.version,
        ytDlpAvailable: fs.existsSync(getBinPath()),
        ffmpegAvailable: Boolean(FFMPEG_PATH),
        datacenterLine: '1 Gbps Datacenter Line'
      },
      bandwidth: {
        totalDownloaded: this.formatBytes(this.totalDownloadedBytes),
        totalDownloadedBytes: this.totalDownloadedBytes,
        totalUploaded: this.formatBytes(this.totalUploadedBytes),
        totalUploadedBytes: this.totalUploadedBytes,
        currentDownloadSpeed: this.currentDownloadSpeed,
        currentUploadSpeed: this.currentUploadSpeed,
        peakSpeed: this.peakDownloadSpeed || '1 Gbps Datacenter',
        savedPcDataPercent: 100
      },
      tasks: {
        activeCount: this.activeTasks.size,
        activeList,
        totalCompleted: this.totalCompletedTasks,
        totalFailed: this.totalFailedTasks
      },
      history: this.history
    };
  }

  formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}

const workerMetrics = new WorkerMetrics();
module.exports = { workerMetrics };
