"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { logger } = require("../logger");

/**
 * Upload file to Pixeldrain using stream
 * @param {Stream} fileStream - File stream to upload
 * @param {string} filename - Name of the file
 * @param {Function} onProgress - Progress callback (bytes)
 * @returns {Promise<{success: boolean, url: string, id: string, error?: string}>}
 */
async function uploadToPixeldrain(fileStream, filename, onProgress = null) {
  try {
    logger(`[Upload] Starting Pixeldrain upload: ${filename}`);

    const formData = new FormData();
    formData.append("file", fileStream, filename);

    const response = await axios.post(
      "https://pixeldrain.com/api/file",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        onUploadProgress: (progressEvent) => {
          if (onProgress) {
            const percentComplete = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            onProgress({
              loaded: progressEvent.loaded,
              total: progressEvent.total,
              percent: percentComplete,
            });
          }
        },
      }
    );

    if (response.data?.success) {
      const fileId = response.data.file_id;
      const url = `https://pixeldrain.com/u/${fileId}`;
      logger(`[Upload] Pixeldrain upload successful: ${url}`);
      return {
        success: true,
        url,
        id: fileId,
        source: "Pixeldrain",
      };
    }

    return {
      success: false,
      error: response.data?.message || "Upload failed",
    };
  } catch (error) {
    logger(`[Upload] Pixeldrain error: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Upload file as multipart form data using stream
 * @param {Stream} fileStream - File stream
 * @param {string} uploadUrl - Target upload URL
 * @param {string} filename - Filename
 * @param {string} fileFieldName - Form field name (default: 'file')
 * @param {Object} additionalFields - Extra form fields
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, response?: any, error?: string}>}
 */
async function uploadMultipart(
  fileStream,
  uploadUrl,
  filename,
  fileFieldName = "file",
  additionalFields = {},
  onProgress = null
) {
  try {
    logger(`[Upload] Starting multipart upload to: ${uploadUrl}`);

    const form = new FormData();
    form.append(fileFieldName, fileStream, filename);

    // Add additional form fields
    for (const [key, value] of Object.entries(additionalFields)) {
      form.append(key, value);
    }

    const response = await axios.post(uploadUrl, form, {
      headers: {
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      onUploadProgress: (progressEvent) => {
        if (onProgress) {
          const percentComplete = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          onProgress({
            loaded: progressEvent.loaded,
            total: progressEvent.total,
            percent: percentComplete,
          });
        }
      },
    });

    logger(`[Upload] Multipart upload successful`);
    return {
      success: true,
      response: response.data,
    };
  } catch (error) {
    logger(`[Upload] Multipart error: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Stream file from one location to upload endpoint
 * @param {string} filePath - Path to file
 * @param {string} uploadUrl - Upload endpoint
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, response?: any, error?: string}>}
 */
async function uploadFromFile(filePath, uploadUrl, onProgress = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        error: "File not found",
      };
    }

    const stats = fs.statSync(filePath);
    const filename = path.basename(filePath);
    const fileStream = fs.createReadStream(filePath);

    // Track progress manually
    let uploaded = 0;
    fileStream.on("data", (chunk) => {
      uploaded += chunk.length;
      if (onProgress) {
        onProgress({
          loaded: uploaded,
          total: stats.size,
          percent: Math.round((uploaded * 100) / stats.size),
        });
      }
    });

    return await uploadMultipart(fileStream, uploadUrl, filename);
  } catch (error) {
    logger(`[Upload] File stream error: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Pipe download stream directly to upload (memory efficient)
 * @param {Stream} downloadStream - Source stream
 * @param {string} uploadUrl - Target upload URL
 * @param {string} filename - Filename
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, response?: any, error?: string}>}
 */
async function pipeStream(downloadStream, uploadUrl, filename, onProgress = null) {
  return new Promise((resolve, reject) => {
    try {
      const form = new FormData();
      form.append("file", downloadStream, filename);

      axios
        .post(uploadUrl, form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          onUploadProgress: (progressEvent) => {
            if (onProgress) {
              onProgress({
                loaded: progressEvent.loaded,
                total: progressEvent.total,
                percent: Math.round((progressEvent.loaded * 100) / progressEvent.total),
              });
            }
          },
        })
        .then((response) => {
          resolve({
            success: true,
            response: response.data,
          });
        })
        .catch((error) => {
          resolve({
            success: false,
            error: error.message,
          });
        });
    } catch (error) {
      reject({
        success: false,
        error: error.message,
      });
    }
  });
}

module.exports = {
  uploadToPixeldrain,
  uploadMultipart,
  uploadFromFile,
  pipeStream,
};
