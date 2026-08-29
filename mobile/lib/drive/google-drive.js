'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

/**
 * Google Drive Cloud Uploader Module
 * Resumable chunked upload protocol, zero-RAM overflow stream piping.
 * Full support for 1-Click Google OAuth2 Account Linking & Service Accounts.
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
    this.userProfile = null;
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
        if (parsed.userProfile) {
          this.userProfile = parsed.userProfile;
        }
      } else if (process.env.GDRIVE_SERVICE_ACCOUNT) {
        let sa = process.env.GDRIVE_SERVICE_ACCOUNT;
        if (sa.startsWith('{')) {
          this.setServiceAccount(JSON.parse(sa), false);
        } else if (fs.existsSync(sa)) {
          this.setServiceAccount(JSON.parse(fs.readFileSync(sa, 'utf8')), false);
        }
      } else if (process.env.GDRIVE_CLIENT_ID && process.env.GDRIVE_REFRESH_TOKEN) {
        this.setOAuth2({
          clientId: process.env.GDRIVE_CLIENT_ID,
          clientSecret: process.env.GDRIVE_CLIENT_SECRET || '',
          refreshToken: process.env.GDRIVE_REFRESH_TOKEN
        }, false);
      }
    } catch (err) {
      console.warn('[GDrive] Config load notice:', err.message);
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
      console.error('[GDrive] Config save error:', err.message);
    }
  }

  setServiceAccount(saJson, persist = true) {
    if (typeof saJson === 'string') {
      saJson = JSON.parse(saJson);
    }
    if (!saJson.client_email || !saJson.private_key) {
      throw new Error('Invalid Service Account: client_email and private_key are required.');
    }
    this.credentials = saJson;
    this.authType = 'service_account';
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.userProfile = { emailAddress: saJson.client_email, displayName: 'Service Account' };

    if (persist) {
      this.saveConfig({ serviceAccount: saJson, defaultFolderId: this.defaultFolderId, userProfile: this.userProfile });
    }
    this.ensureAppFolderExists('Cloud Media Downloads').catch(() => {});
    return { success: true, email: saJson.client_email };
  }

  setOAuth2({ clientId, clientSecret, refreshToken }, persist = true) {
    if (!refreshToken) {
      throw new Error('OAuth2 requires a Refresh Token.');
    }
    this.credentials = { clientId: clientId || '', clientSecret: clientSecret || '', refreshToken };
    this.authType = 'oauth2';
    this.accessToken = null;
    this.tokenExpiresAt = 0;

    if (persist) {
      this.saveConfig({ oauth2: this.credentials, defaultFolderId: this.defaultFolderId, userProfile: this.userProfile });
    }
    this.ensureAppFolderExists('Cloud Media Downloads').catch(() => {});
    return { success: true, type: 'oauth2' };
  }

  disconnect() {
    this.credentials = null;
    this.authType = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.userProfile = null;
    if (fs.existsSync(this.configPath)) {
      try { fs.unlinkSync(this.configPath); } catch (e) {}
    }
    return { success: true };
  }

  getAuthUrl(clientId, clientSecret, redirectUri, returnHost = '') {
    const scope = encodeURIComponent('https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile');
    const state = Buffer.from(JSON.stringify({ clientId, clientSecret: clientSecret || '', returnHost })).toString('base64');
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;
  }

  async exchangeOAuthCode({ code, clientId, clientSecret, redirectUri }) {
    const payload = {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    };
    if (clientSecret) {
      payload.client_secret = clientSecret;
    }

    const res = await axios.post('https://oauth2.googleapis.com/token', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const refreshToken = res.data.refresh_token;
    if (!refreshToken) {
      throw new Error('No refresh token received from Google. Please ensure you approved all permissions.');
    }

    this.setOAuth2({ clientId, clientSecret: clientSecret || '', refreshToken }, true);
    const about = await this.getAbout().catch(() => null);
    if (about?.user) {
      this.userProfile = about.user;
      this.saveConfig({ oauth2: this.credentials, defaultFolderId: this.defaultFolderId, userProfile: this.userProfile });
    }

    // Automatically create Cloud Media Downloads folder in user's Drive
    await this.ensureAppFolderExists('Cloud Media Downloads');

    return { success: true, user: this.userProfile };
  }

  /**
   * Automatically create or locate the dedicated App Folder in Google Drive
   */
  async ensureAppFolderExists(folderName = 'Cloud Media Downloads') {
    try {
      const token = await this.getAccessToken();
      const q = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`;
      
      const searchRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { 'Authorization': `Bearer ${token}` },
        params: { q, fields: 'files(id, name)' },
        timeout: 15000
      });

      if (searchRes.data.files && searchRes.data.files.length > 0) {
        const existingFolder = searchRes.data.files[0];
        this.setDefaultFolder(existingFolder.id);
        return existingFolder;
      }

      // Automatically create folder in user's Google Drive root
      const createRes = await axios.post('https://www.googleapis.com/drive/v3/files', {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root']
      }, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
      });

      const newFolder = createRes.data;
      if (newFolder && newFolder.id) {
        this.setDefaultFolder(newFolder.id);
        console.log(`[GDrive] Automatically created dedicated folder: "${folderName}" (ID: ${newFolder.id})`);
        return newFolder;
      }
    } catch (err) {
      console.warn('[GDrive] Auto-folder notice:', err.message);
    }
    return null;
  }

  async testConnection() {
    const token = await this.getAccessToken();
    const about = await this.getAbout();
    const folder = await this.ensureAppFolderExists('Cloud Media Downloads');
    return {
      success: true,
      authType: this.authType,
      user: about.user,
      storageQuota: about.storageQuota,
      folder: folder ? {
        id: folder.id,
        name: folder.name,
        webViewLink: `https://drive.google.com/drive/folders/${folder.id}`
      } : null
    };
  }

  setDefaultFolder(folderId) {
    this.defaultFolderId = folderId || 'root';
    if (this.authType === 'service_account') {
      this.saveConfig({ serviceAccount: this.credentials, defaultFolderId: this.defaultFolderId, userProfile: this.userProfile });
    } else if (this.authType === 'oauth2') {
      this.saveConfig({ oauth2: this.credentials, defaultFolderId: this.defaultFolderId, userProfile: this.userProfile });
    }
  }

  getStatus() {
    return {
      connected: Boolean(this.credentials),
      authType: this.authType,
      accountEmail: this.userProfile?.emailAddress || this.credentials?.client_email || (this.authType === 'oauth2' ? 'Google Account Connected' : null),
      displayName: this.userProfile?.displayName || 'Google Drive',
      photoLink: this.userProfile?.photoLink || null,
      defaultFolderId: this.defaultFolderId
    };
  }

  async getAbout() {
    const token = await this.getAccessToken();
    const res = await axios.get('https://www.googleapis.com/drive/v3/about', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: { fields: 'user,storageQuota' },
      timeout: 15000
    });

    if (res.data.user) {
      this.userProfile = res.data.user;
    }

    return {
      user: res.data.user,
      storageQuota: res.data.storageQuota ? {
        limit: res.data.storageQuota.limit ? (parseInt(res.data.storageQuota.limit, 10) / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : 'Unlimited',
        usage: res.data.storageQuota.usage ? (parseInt(res.data.storageQuota.usage, 10) / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : '0 GB',
        usagePercent: res.data.storageQuota.limit ? Math.round((parseInt(res.data.storageQuota.usage, 10) / parseInt(res.data.storageQuota.limit, 10)) * 100) : 0
      } : null
    };
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    if (!this.credentials) {
      throw new Error('Google Drive not configured. Please link your Google Account in Settings.');
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
      const payload = {
        refresh_token: this.credentials.refreshToken,
        grant_type: 'refresh_token'
      };
      if (this.credentials.clientId) payload.client_id = this.credentials.clientId;
      if (this.credentials.clientSecret) payload.client_secret = this.credentials.clientSecret;

      const res = await axios.post('https://oauth2.googleapis.com/token', payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      this.accessToken = res.data.access_token;
      this.tokenExpiresAt = Date.now() + (res.data.expires_in || 3600) * 1000;
      return this.accessToken;
    }

    throw new Error('Unsupported Google Drive authentication method.');
  }

  async uploadStream({ stream, fileName, mimeType = 'application/octet-stream', sizeBytes = 0, folderId, onProgress, abortSignal }) {
    const token = await this.getAccessToken();
    const targetFolder = folderId || this.defaultFolderId || 'root';

    const metadata = { name: fileName, mimeType };
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
      { headers: initHeaders, timeout: 20000, signal: abortSignal }
    );

    const uploadUrl = initRes.headers.location;
    if (!uploadUrl) {
      throw new Error('Failed to obtain Google Drive resumable upload URL.');
    }

    let uploadedBytes = 0;
    const startTime = Date.now();

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

    const uploadHeaders = { 'Content-Type': mimeType };
    if (sizeBytes > 0) {
      uploadHeaders['Content-Length'] = sizeBytes.toString();
    }

    const uploadRes = await axios.put(uploadUrl, stream, {
      headers: uploadHeaders,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
      signal: abortSignal
    });

    const fileData = uploadRes.data;

    try {
      await axios.post(
        `https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions?supportsAllDrives=true`,
        { role: 'reader', type: 'anyone' },
        {
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
    } catch (e) {}

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

  async listFiles({ folderId, pageSize = 40 } = {}) {
    const token = await this.getAccessToken();
    const targetFolder = folderId || this.defaultFolderId || 'root';

    const baseFields = 'files(id, name, mimeType, size, createdTime, webViewLink, webContentLink, thumbnailLink)';

    if (targetFolder && targetFolder !== 'all' && targetFolder !== 'root') {
      try {
        const res = await axios.get('https://www.googleapis.com/drive/v3/files', {
          headers: { 'Authorization': `Bearer ${token}` },
          params: {
            q: `trashed = false and mimeType != 'application/vnd.google-apps.folder' and '${targetFolder}' in parents`,
            pageSize,
            fields: baseFields,
            orderBy: 'createdTime desc',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
          },
          timeout: 15000
        });

        if (res.data.files && res.data.files.length > 0) {
          return res.data.files;
        }
      } catch (e) {}
    }

    // Fallback or all files: List latest files in user's Drive
    const res = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        q: `trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        pageSize,
        fields: baseFields,
        orderBy: 'createdTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      },
      timeout: 15000
    });

    return res.data.files || [];
  }

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

  async deleteFile(fileId) {
    const token = await this.getAccessToken();
    await axios.delete(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000
    });
    return { success: true, fileId };
  }
}

const googleDrive = new GoogleDriveManager();
module.exports = { googleDrive, GoogleDriveManager };
