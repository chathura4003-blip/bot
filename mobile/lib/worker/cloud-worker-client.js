'use strict';

const axios = require('axios');

class CloudWorkerClient {
  constructor() {
    this.workerUrl = (process.env.CLOUD_WORKER_URL || '').trim();
    this.workerSecret = (process.env.WORKER_SECRET || '').trim();
    this.isOnline = false;
    this.lastCheck = 0;
  }

  getEndpoint(path = '') {
    if (!this.workerUrl) return '';
    return `${this.workerUrl.replace(/\/$/, '')}${path}`;
  }

  async checkHealth() {
    if (!this.workerUrl) return { available: false, reason: 'CLOUD_WORKER_URL not configured' };
    try {
      const res = await axios.get(this.getEndpoint('/health'), { timeout: 6000 });
      this.isOnline = res.data && res.data.status === 'online';
      this.lastCheck = Date.now();
      return {
        available: this.isOnline,
        workerUrl: this.workerUrl,
        uptime: res.data?.uptime || 'N/A',
        memoryMB: res.data?.memoryMB || 0,
        ytDlpAvailable: res.data?.ytDlpAvailable || false,
        ffmpegAvailable: res.data?.ffmpegAvailable || false
      };
    } catch (err) {
      this.isOnline = false;
      return { available: false, error: err.message };
    }
  }

  async offloadDriveTransfer(params) {
    if (!this.workerUrl) {
      throw new Error('CLOUD_WORKER_URL is not configured in .env');
    }

    const endpoint = this.getEndpoint('/api/worker/drive-transfer');
    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.workerSecret) {
      headers['x-worker-secret'] = this.workerSecret;
    }

    const res = await axios.post(endpoint, params, { headers, timeout: 12000 });
    return res.data;
  }

  async getTaskStatus(taskId) {
    if (!this.workerUrl || !taskId) return null;
    const endpoint = this.getEndpoint(`/api/worker/drive-status/${taskId}`);
    try {
      const res = await axios.get(endpoint, { timeout: 6000 });
      return res.data;
    } catch (e) {
      return null;
    }
  }
}

const cloudWorkerClient = new CloudWorkerClient();
module.exports = { cloudWorkerClient, CloudWorkerClient };
