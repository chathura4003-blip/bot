'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

/**
 * Robust Google Drive Integration for Cloud Uploads
 * Supports:
 * 1. Service Account JSON credentials
 * 2. OAuth2 Client ID, Secret, and Refresh Token
 * 3. Resumable Chunked Uploads for large files (1GB - 50GB+)
 * 4. Automatic Public Link sharing & Direct Streaming links
 */

class GoogleDriveManager extends EventEmitter {
  constructor() {
    super();
    this.credentials = null;
    this.authType = null; // 'service_account' | 'oauth2'
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.configPath = path.join(__dirname, '../../data', 'gdrive_config.json');
    this.defaultFolderId = 'root';
    this.loadSavedConfig();
  }

  loadSavedConfig() {
    try {
      const dataDir = path.join(__dirname, '../../data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.serviceAccount) {
          this.setServiceAccount(parsed.serviceAccount, false);
        } else if (parsed.oauth2) {
          this.setOAuth2(parsed.oauth2, false);
        }
        if (parsed.defaultFolderId) {
          this.defaultFolderId = parsed.defaultFolderId;
        }
      } else if (process.env.GDRIVE_SERVICE_ACCOUNT) {
        let sa = process.env.GDRIVE_SERVICE_ACCOUNT;
        if (sa.startsWith('{')) {
          this.setServiceAccount(JSON.parse(sa), false);
        } else if (fs.existsSync(sa)) {
          this.setServiceAccount(JSON.parse(fs.readFileSync(sa, 'utf8')), false);
        }
      }
    } catch (err) {
      console.warn('[GDrive] Warning loading saved config:', err.message);
    }
  }

  saveConfig(payload) {
    try {
      const dataDir = path.join(__dirname, '../../data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('[GDrive] Error saving config:', err.message);
    }
  }

  setServiceAccount(saJson, persist = true) {
    if (typeof saJson === 'string') {
      saJson = JSON.parse(saJson);
    }
    if (!saJson.client_email || !saJson.private_key) {
      throw new Error('Invalid Service Account JSON: client_email and private_key are required.');
    }
    this.credentials = saJson;
    this.authType = 'service_account';
    this.accessToken = null;
    this.tokenExpiresAt = 0;

    if (persist) {
      this.saveConfig({ serviceAccount: saJson, defaultFolderId: this.defaultFolderId });
    }
    return { success: true, email: saJson.client_email };
  }

  setOAuth2({ clientId, clientSecret, refreshToken }, persist = true) {
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('OAuth2 requires clientId, clientSecret, and refreshToken.');
    }
    this.credentials = { clientId, clientSecret, refreshToken };
    this.authType = 'oauth2';
    this.accessToken = null;
    this.tokenExpiresAt = 0;

    if (persist) {
      this.saveConfig({ oauth2: this.credentials, defaultFolderId: this.defaultFolderId });
    }
    return { success: true, type: 'oauth2' };
  }

  setDefaultFolder(folderId) {
    this.defaultFolderId = folderId || 'root';
    if (this.authType === 'service_account') {
      this.saveConfig({ serviceAccount: this.credentials, defaultFolderId: this.defaultFolderId });
    } else if (this.authType === 'oauth2') {
      this.saveConfig({ oauth2: this.credentials, defaultFolderId: this.defaultFolderId });
    }
  }

  getStatus() {
    return {
      connected: Boolean(this.credentials),
      authType: this.authType,
      accountEmail: this.credentials?.client_email || (this.authType === 'oauth2' ? 'OAuth2 Account' : null),
      defaultFolderId: this.defaultFolderId
    };
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    if (!this.credentials) {
      throw new Error('Google Drive is not configured. Please add Service Account or OAuth credentials in Settings.');
    }

    if (this.authType === 'service_account') {
      const now = Math.floor(Date.now() / 1000);
      const tokenPayload = {
        iss: this.credentials.client_email,
        scope: 'https://www.googleapis.com/auth/drive',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      };

      const signedJwt = jwt.sign(tokenPayload, this.credentials.private_key, { algorithm: 'RS256' });

      const res = await axios.post('https://oauth2.googleapis.com/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      this.accessToken = res.data.access_token;
      this.tokenExpiresAt = Date.now() + (res.data.expires_in || 3600) * 1000;
      return this.accessToken;
    }

    if (this.authType === 'oauth2') {
      const res = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: 'refresh_token'
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      this.accessToken = res.data.access_token;
      this.tokenExpiresAt = Date.now() + (res.data.expires_in || 3600) * 1000;
      return this.accessToken;
    }

    throw new Error('Unknown Google Drive authentication method.');
  }

  /**
   * Resumable Chunked Upload Stream
   * Pipes an incoming stream directly to Google Drive without loading entire file in RAM.
   */
  async uploadStream({ stream, fileName, mimeType = 'application/octet-stream', sizeBytes = 0, folderId, onProgress, abortSignal }) {
    const token = await this.getAccessToken();
    const targetFolder = folderId || this.defaultFolderId || 'root';

    // 1. Initialize Resumable Upload Session
    const metadata = {
      name: fileName,
      mimeType: mimeType
    };
    if (targetFolder && targetFolder !== 'root') {
      metadata.parents = [targetFolder];
    }

    const initHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType
    };
    if (sizeBytes > 0) {
      initHeaders['X-Upload-Content-Length'] = sizeBytes.toString();
    }

    const initRes = await axios.post(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
      metadata,
      {
        headers: initHeaders,
        timeout: 20000,
        signal: abortSignal
      }
    );

    const uploadUrl = initRes.headers.location;
    if (!uploadUrl) {
      throw new Error('Failed to obtain Google Drive resumable upload session URL.');
    }

    // 2. Stream upload to the resumable URL
    let uploadedBytes = 0;
    let startTime = Date.now();

    stream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      if (onProgress) {
        const elapsedSec = (Date.now() - startTime) / 1000 || 1;
        const speedBps = uploadedBytes / elapsedSec;
        const percent = sizeBytes > 0 ? Math.min(100, (uploadedBytes / sizeBytes) * 100) : 0;
        const remainingBytes = sizeBytes > uploadedBytes ? sizeBytes - uploadedBytes : 0;
        const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;

        onProgress({
          uploadedBytes,
          totalBytes: sizeBytes,
          percent: Number(percent.toFixed(1)),
          speedMBps: (speedBps / (1024 * 1024)).toFixed(2),
          etaSec
        });
      }
    });

    const uploadHeaders = {
      'Content-Type': mimeType
    };
    if (sizeBytes > 0) {
      uploadHeaders['Content-Length'] = sizeBytes.toString();
    }

    const uploadRes = await axios.put(uploadUrl, stream, {
      headers: uploadHeaders,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0, // No timeout for large uploads
      signal: abortSignal
    });

    const fileData = uploadRes.data;

    // 3. Make file public / readable by link
    try {
      await axios.post(
        `https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions?supportsAllDrives=true`,
        { role: 'reader', type: 'anyone' },
        {
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
    } catch (permErr) {
      console.warn('[GDrive] Public permission setting notice:', permErr.message);
    }

    const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileData.id}`;
    const previewUrl = `https://drive.google.com/file/d/${fileData.id}/view?usp=sharing`;

    return {
      fileId: fileData.id,
      name: fileData.name || fileName,
      mimeType: fileData.mimeType,
      size: sizeBytes,
      webViewLink: previewUrl,
      webContentLink: directDownloadUrl,
      directDownloadUrl
    };
  }

  /**
   * List files in designated Drive folder
   */
  async listFiles({ folderId, pageSize = 40 } = {}) {
    const token = await this.getAccessToken();
    const targetFolder = folderId || this.defaultFolderId || 'root';

    let q = `trashed = false`;
    if (targetFolder && targetFolder !== 'all') {
      q += ` and '${targetFolder}' in parents`;
    }

    const res = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        q,
        pageSize,
        fields: 'files(id, name, mimeType, size, createdTime, webViewLink, webContentLink, thumbnailLink)',
        orderBy: 'createdTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      },
      timeout: 15000
    });

    return res.data.files || [];
  }

  /**
   * List available folders for folder picker
   */
  async listFolders(parentId = 'root') {
    const token = await this.getAccessToken();
    const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${parentId}' in parents`;

    const res = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        q,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      },
      timeout: 15000
    });

    return res.data.files || [];
  }

  /**
   * Create a new folder
   */
  async createFolder(name, parentId = 'root') {
    const token = await this.getAccessToken();
    const metadata = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    };

    const res = await axios.post('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', metadata, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    return res.data;
  }
}

const googleDrive = new GoogleDriveManager();
module.exports = { googleDrive, GoogleDriveManager };
