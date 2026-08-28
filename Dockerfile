FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Install build dependencies + Puppeteer system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-pip python3-venv tini \
    build-essential git curl \
    libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libxss1 libgtk-3-0 libfontconfig1 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages -U "yt-dlp[default]"

COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund

# Pre-install Puppeteer browser (Chrome)
RUN npx puppeteer browsers install chrome


FROM node:20-bookworm-slim
WORKDIR /app

# Re-install runtime libraries (essential for Chrome to run)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-pip python3-venv tini \
    libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libxss1 libgtk-3-0 libfontconfig1 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages -U "yt-dlp[default]"

# Environment variables for production and Puppeteer
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Copy dependencies and pre-installed browser
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /root/.cache/puppeteer /app/.cache/puppeteer
COPY . .

RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

EXPOSE 5000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--expose-gc", "--max-old-space-size=512", "--max-semi-space-size=64", "index.js"]
