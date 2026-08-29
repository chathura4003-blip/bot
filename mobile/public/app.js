'use strict';

// Client State
const state = {
  currentTab: 'movies',
  tasks: new Map(),
  downloads: new Map(),
  driveConnected: false,
  driveUser: null,
  selectedMovie: null
};

// Connect Socket.io for Real-time Updates
const socket = io();

socket.on('initTasks', (tasks) => {
  state.tasks.clear();
  tasks.forEach(t => state.tasks.set(t.id, t));
  renderTasks();
});

socket.on('taskUpdated', (task) => {
  state.tasks.set(task.id, task);
  renderTasks();
  if (task.status === 'completed') {
    showToast(`Transfer Completed: ${task.title}`, 'success');
  } else if (task.status === 'failed') {
    showToast(`Transfer Failed: ${task.error || task.title}`, 'error');
  }
});

socket.on('initDownloads', (downloads) => {
  state.downloads.clear();
  downloads.forEach(d => state.downloads.set(d.id, d));
  renderDownloads();
});

socket.on('downloadUpdated', (item) => {
  state.downloads.set(item.id, item);
  renderDownloads();
  if (item.status === 'completed') {
    showToast(`Download Completed: ${item.title}`, 'success');
  } else if (item.status === 'failed') {
    showToast(`Download Failed: ${item.error || item.title}`, 'error');
  }
});

socket.on('downloadDeleted', (id) => {
  state.downloads.delete(id);
  renderDownloads();
});

// DOM Elements
const views = {
  movies: document.getElementById('view-movies'),
  media: document.getElementById('view-media'),
  adult: document.getElementById('view-adult'),
  downloads: document.getElementById('view-downloads'),
  tasks: document.getElementById('view-tasks'),
  drive: document.getElementById('view-drive')
};

const navItems = document.querySelectorAll('.nav-item');
const navTaskBadge = document.getElementById('navTaskBadge');
const navDownloadsBadge = document.getElementById('navDownloadsBadge');
const driveStatusBadge = document.getElementById('driveStatusBadge');

// ================= Tab Navigation ================= //
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const tabName = item.dataset.tab;
    switchTab(tabName);
  });
});

function switchTab(tabName) {
  state.currentTab = tabName;
  navItems.forEach(nav => nav.classList.toggle('active', nav.dataset.tab === tabName));
  Object.keys(views).forEach(key => {
    if (views[key]) {
      views[key].classList.toggle('active', key === tabName);
    }
  });

  if (tabName !== 'adult') {
    if (adultHtmlVideoPlayer) adultHtmlVideoPlayer.pause();
  }

  if (tabName === 'adult') {
    if (adultGrid && adultGrid.children.length === 0) {
      searchAdult('popular', currentAdultSource);
    }
  }

  if (tabName === 'drive') {
    loadDriveAccountProfile();
    loadDriveFiles();
  }
}

// ================= Direct Device Downloader Helper ================= //
async function triggerDirectDownload(url, filename) {
  showToast('Adding to Direct Download Manager...', 'info');
  try {
    const res = await fetch('/api/downloads/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title: filename })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Download started in Download Manager!', 'success');
      switchTab('downloads');
    } else {
      window.location.href = `/api/download?url=${encodeURIComponent(url)}&title=${encodeURIComponent(filename || 'video_download')}`;
    }
  } catch (err) {
    window.location.href = `/api/download?url=${encodeURIComponent(url)}&title=${encodeURIComponent(filename || 'video_download')}`;
  }
}

// ================= Status & Settings ================= //
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.driveConnected = Boolean(data.gdrive?.connected);
    state.driveUser = data.gdrive;

    if (state.driveConnected) {
      driveStatusBadge.className = 'status-badge connected';
      const email = data.gdrive.accountEmail || 'Account Linked';
      driveStatusBadge.innerHTML = `<span class="status-dot"></span><span>Drive Ready (${email.split('@')[0]})</span>`;
    } else {
      driveStatusBadge.className = 'status-badge disconnected';
      driveStatusBadge.innerHTML = `<span class="status-dot"></span><span>Drive Disconnected</span>`;
    }
  } catch (err) {
    driveStatusBadge.className = 'status-badge disconnected';
    driveStatusBadge.innerHTML = `<span class="status-dot"></span><span>Server Offline</span>`;
  }
}

// ================= 1. Movie Hub Logic ================= //
const movieSearchInput = document.getElementById('movieSearchInput');
const btnSearchMovie = document.getElementById('btnSearchMovie');
const movieLoading = document.getElementById('movieLoading');
const movieGrid = document.getElementById('movieGrid');
const movieModal = document.getElementById('movieModal');

btnSearchMovie.addEventListener('click', () => searchMovies(movieSearchInput.value));
movieSearchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') searchMovies(movieSearchInput.value);
});

document.querySelectorAll('#view-movies .tag-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#view-movies .tag-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    movieSearchInput.value = pill.dataset.q;
    searchMovies(pill.dataset.q);
  });
});

async function searchMovies(query) {
  if (!query || !query.trim()) return;
  movieLoading.classList.remove('hidden');
  movieGrid.innerHTML = '';

  try {
    const res = await fetch('/api/movies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.trim() })
    });
    const data = await res.json();
    movieLoading.classList.add('hidden');

    if (!data.results || data.results.length === 0) {
      movieGrid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-film"></i><p>No movies found for "${query}". Try another title.</p></div>`;
      return;
    }

    data.results.forEach(movie => {
      const card = document.createElement('div');
      card.className = 'movie-card';
      const isSinhalasub = movie.source === 'Sinhalasub';

      card.innerHTML = `
        <div class="poster-wrapper">
          <img src="${movie.poster || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=300'}" alt="${movie.title}" loading="lazy">
          <span class="source-badge" style="color: ${isSinhalasub ? 'var(--accent-cyan)' : '#a29bfe'}; border-color: ${isSinhalasub ? 'rgba(0,242,254,0.3)' : 'rgba(162,155,254,0.4)'};">${movie.source}</span>
          ${movie.rating ? `<span class="rating-badge">★ ${movie.rating}</span>` : ''}
        </div>
        <div class="movie-info">
          <div class="movie-card-title">${movie.title}</div>
          <div class="movie-card-meta">
            <span>${movie.year || 'HD'}</span>
            <span style="color: var(--accent-cyan); font-weight: 700;">Download / Drive ➔</span>
          </div>
        </div>
      `;
      card.addEventListener('click', () => openMovieModal(movie));
      movieGrid.appendChild(card);
    });
  } catch (err) {
    movieLoading.classList.add('hidden');
    showToast('Failed to search movies: ' + err.message, 'error');
  }
}

async function openMovieModal(movie) {
  state.selectedMovie = movie;
  document.getElementById('modalMoviePoster').src = movie.poster || '';
  document.getElementById('modalMovieTitle').textContent = movie.title;
  document.getElementById('modalMovieSynopsis').textContent = 'Fetching direct cloud stream links...';
  const qList = document.getElementById('modalQualitiesList');
  qList.innerHTML = '<div class="spinner"></div>';
  movieModal.classList.remove('hidden');

  try {
    const res = await fetch('/api/movies/details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: movie.link })
    });
    const data = await res.json();
    const details = data.details || {};

    if (details.synopsis) {
      document.getElementById('modalMovieSynopsis').textContent = details.synopsis;
    } else {
      document.getElementById('modalMovieSynopsis').textContent = movie.title;
    }

    qList.innerHTML = '';
    if (details.qualities && details.qualities.length > 0) {
      details.qualities.forEach(q => {
        const item = document.createElement('div');
        item.className = 'quality-card-row';
        item.innerHTML = `
          <div class="quality-info-col">
            <div class="q-badge-title">${q.quality} <span class="q-provider-sub">(${q.provider})</span></div>
            <div class="q-size-text">${q.size || 'HD Quality'}</div>
          </div>
          <div class="quality-actions-col">
            <button class="btn-action btn-upload-drive" title="Upload to Google Drive">
              <i class="fa-solid fa-cloud-arrow-up"></i> Upload Drive
            </button>
            <button class="btn-secondary btn-direct-dl" title="Direct Download to device">
              <i class="fa-solid fa-download"></i> Download
            </button>
          </div>
        `;

        // 1. Upload to Drive
        item.querySelector('.btn-upload-drive').addEventListener('click', () => {
          startCloudTransfer({
            title: `${movie.title} [${q.quality}]`,
            url: q.downloadUrl,
            type: 'movie',
            quality: q.quality
          });
          movieModal.classList.add('hidden');
        });

        // 2. Direct Device Download
        item.querySelector('.btn-direct-dl').addEventListener('click', () => {
          triggerDirectDownload(q.downloadUrl, `${movie.title}_${q.quality}.mp4`);
        });

        qList.appendChild(item);
      });
    } else {
      qList.innerHTML = '<p style="color: var(--text-muted);">No direct qualities found. You can try another movie.</p>';
    }
  } catch (err) {
    qList.innerHTML = '<p style="color: var(--accent-red);">Failed to extract download options.</p>';
  }
}

document.getElementById('btnCloseMovieModal').addEventListener('click', () => {
  movieModal.classList.add('hidden');
});

// ================= 2. Direct Media Extractor ================= //
const mediaUrlInput = document.getElementById('mediaUrlInput');
const btnExtractMedia = document.getElementById('btnExtractMedia');
const mediaLoading = document.getElementById('mediaLoading');
const mediaResultCard = document.getElementById('mediaResultCard');

btnExtractMedia.addEventListener('click', async () => {
  const url = mediaUrlInput.value.trim();
  if (!url) return showToast('Please enter a media URL', 'info');

  mediaLoading.classList.remove('hidden');
  mediaResultCard.classList.add('hidden');

  try {
    const res = await fetch('/api/media/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    mediaLoading.classList.add('hidden');

    if (!data.info) throw new Error('No info returned');
    const info = data.info;

    document.getElementById('mediaThumb').src = info.thumbnail || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300';
    document.getElementById('mediaTitle').textContent = info.title || 'Media Video';
    document.getElementById('mediaDuration').textContent = info.duration ? `${Math.floor(info.duration / 60)} min` : (info.uploader || 'Direct Stream');

    const fmtGrid = document.getElementById('mediaFormatsGrid');
    fmtGrid.innerHTML = '';

    (info.formats || []).forEach(fmt => {
      const pill = document.createElement('div');
      pill.className = 'format-pill';
      pill.innerHTML = `
        <div>
          <div class="q-title">${fmt.quality}</div>
          <div class="q-size">${fmt.ext.toUpperCase()} ${fmt.size ? '• ' + fmt.size : ''}</div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="btn-action btn-upload" style="padding: 6px 10px; font-size: 0.75rem;">
            <i class="fa-solid fa-cloud-arrow-up"></i> Upload Drive
          </button>
          <button class="btn-secondary btn-direct" style="padding: 6px 10px; font-size: 0.75rem;">
            <i class="fa-solid fa-download"></i> Direct
          </button>
        </div>
      `;

      // Upload Drive
      pill.querySelector('.btn-upload').addEventListener('click', () => {
        startCloudTransfer({
          title: info.title + ` [${fmt.quality}]`,
          url: info.url,
          type: 'media',
          quality: fmt.quality
        });
      });

      // Direct Download
      pill.querySelector('.btn-direct').addEventListener('click', () => {
        triggerDirectDownload(info.url, `${info.title}.${fmt.ext || 'mp4'}`);
      });

      fmtGrid.appendChild(pill);
    });

    mediaResultCard.classList.remove('hidden');
  } catch (err) {
    mediaLoading.classList.add('hidden');
    showToast('Failed to extract media: ' + err.message, 'error');
  }
});

// ================= 3. 18+ Adult Hub (YouTube-Style Watch & Feed Experience) ================= //
const adultSearchInput = document.getElementById('adultSearchInput');
const btnSearchAdult = document.getElementById('btnSearchAdult');
const adultSourceSelect = document.getElementById('adultSourceSelect');
const adultGrid = document.getElementById('adultGrid');
const adultLoading = document.getElementById('adultLoading');

// Watch Mode Elements
const adultBrowseView = document.getElementById('adultBrowseView');
const adultWatchView = document.getElementById('adultWatchView');
const btnBackToAdultBrowse = document.getElementById('btnBackToAdultBrowse');
const adultWatchSourceBadge = document.getElementById('adultWatchSourceBadge');
const adultIframePlayer = document.getElementById('adultIframePlayer');
const adultHtmlVideoPlayer = document.getElementById('adultHtmlVideoPlayer');
const adultWatchTitle = document.getElementById('adultWatchTitle');
const adultWatchDuration = document.getElementById('adultWatchDuration');
const adultWatchRating = document.getElementById('adultWatchRating');
const btnAdultWatchDrive = document.getElementById('btnAdultWatchDrive');
const btnAdultWatchDownload = document.getElementById('btnAdultWatchDownload');
const btnAdultWatchCopy = document.getElementById('btnAdultWatchCopy');
const btnAdultWatchSource = document.getElementById('btnAdultWatchSource');
const adultRelatedFeed = document.getElementById('adultRelatedFeed');

let currentAdultSource = 'all';

if (adultSourceSelect) {
  adultSourceSelect.addEventListener('change', () => {
    currentAdultSource = adultSourceSelect.value;
    document.querySelectorAll('.source-pill').forEach(p => p.classList.toggle('active', p.dataset.src === currentAdultSource));
    searchAdult(adultSearchInput.value || 'popular', currentAdultSource);
  });
}

document.querySelectorAll('.source-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.source-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentAdultSource = pill.dataset.src;
    if (adultSourceSelect) adultSourceSelect.value = currentAdultSource;
    searchAdult(adultSearchInput.value || 'popular', currentAdultSource);
  });
});

btnSearchAdult.addEventListener('click', () => searchAdult(adultSearchInput.value, currentAdultSource));
adultSearchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') searchAdult(adultSearchInput.value, currentAdultSource);
});

document.querySelectorAll('#view-adult .tag-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#view-adult .tag-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    adultSearchInput.value = pill.dataset.q;
    searchAdult(pill.dataset.q, currentAdultSource);
  });
});

if (btnBackToAdultBrowse) {
  btnBackToAdultBrowse.addEventListener('click', closeAdultWatchMode);
}

function closeAdultWatchMode() {
  if (adultHtmlVideoPlayer) {
    adultHtmlVideoPlayer.pause();
    adultHtmlVideoPlayer.src = '';
    adultHtmlVideoPlayer.classList.add('hidden');
  }
  if (adultIframePlayer) {
    adultIframePlayer.src = '';
    adultIframePlayer.classList.add('hidden');
  }
  if (adultWatchView) adultWatchView.classList.add('hidden');
  if (adultBrowseView) adultBrowseView.classList.remove('hidden');
}

async function searchAdult(query, source = 'all') {
  closeAdultWatchMode();
  adultLoading.classList.remove('hidden');
  adultGrid.innerHTML = '';

  try {
    const res = await fetch('/api/adult/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query || 'popular', source: source || 'all' })
    });
    const data = await res.json();
    adultLoading.classList.add('hidden');

    if (!data.results || data.results.length === 0) {
      adultGrid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-lock"></i><p>No adult streams found for "${query}". Try another term or switch website.</p></div>`;
      return;
    }

    data.results.forEach(v => {
      const card = document.createElement('div');
      card.className = 'yt-card';
      const srcName = v.source || '18+ Adult';
      let srcColor = '#ff4757';
      if (srcName === 'Pornhub') srcColor = '#ffa502';
      if (srcName === 'XNXX') srcColor = '#1e90ff';
      if (srcName === 'Eporner') srcColor = '#ff9f43';
      if (srcName === 'RedTube') srcColor = '#ee5253';
      if (srcName === 'XVideos') srcColor = '#ff6b81';

      card.innerHTML = `
        <div class="yt-thumb-wrapper">
          <img src="${v.thumbnail || ''}" alt="${v.title}" loading="lazy">
          <span class="yt-src-pill" style="color: ${srcColor};">${srcName}</span>
          <span class="yt-dur-pill">${v.duration || 'HD'}</span>
        </div>
        <div class="yt-card-body">
          <div class="yt-title-row">
            <div class="yt-channel-icon" style="color: ${srcColor};">
              <i class="fa-solid fa-circle-play"></i>
            </div>
            <div style="flex: 1; overflow: hidden;">
              <div class="yt-card-title">${v.title}</div>
              <div class="yt-card-sub">
                <span>${srcName}</span>
                <span>•</span>
                <span>${v.rating || '1080p Full HD'}</span>
              </div>
            </div>
          </div>
          <div class="yt-card-actions">
            <button class="btn-action btn-yt-drive" style="background: var(--grad-primary); color: #000;" title="Upload to Google Drive">
              <i class="fa-solid fa-cloud-arrow-up"></i> Upload Drive
            </button>
            <button class="btn-secondary btn-yt-dl" title="Direct Download MP4">
              <i class="fa-solid fa-download"></i> Download
            </button>
          </div>
        </div>
      `;

      // Tap card or thumb -> Open YouTube Watch Mode
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-yt-drive') || e.target.closest('.btn-yt-dl')) return;
        openAdultWatchMode(v);
      });

      // 1-Click Drive Upload
      card.querySelector('.btn-yt-drive').addEventListener('click', async (e) => {
        e.stopPropagation();
        showToast('Resolving stream for Google Drive...', 'info');
        try {
          const rRes = await fetch('/api/adult/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: v.url })
          });
          const rData = await rRes.json();
          const finalUrl = rData.resolved?.downloadUrl || rData.resolved?.streamUrl || v.url;

          startCloudTransfer({
            title: v.title,
            url: finalUrl,
            type: 'nsfw',
            quality: '1080p'
          });
        } catch (err) {
          startCloudTransfer({
            title: v.title,
            url: v.url,
            type: 'nsfw',
            quality: '1080p'
          });
        }
      });

      // 1-Click Direct Download
      card.querySelector('.btn-yt-dl').addEventListener('click', async (e) => {
        e.stopPropagation();
        showToast('Resolving high-speed download link...', 'info');
        try {
          const rRes = await fetch('/api/adult/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: v.url })
          });
          const rData = await rRes.json();
          const finalUrl = rData.resolved?.downloadUrl || rData.resolved?.streamUrl || v.url;
          triggerDirectDownload(finalUrl, `${v.title}.mp4`);
        } catch (err) {
          triggerDirectDownload(v.url, `${v.title}.mp4`);
        }
      });

      adultGrid.appendChild(card);
    });
  } catch (err) {
    adultLoading.classList.add('hidden');
    showToast('Failed to fetch adult content: ' + err.message, 'error');
  }
}

// Open YouTube Watch Page inside 18+ Tab
async function openAdultWatchMode(video) {
  if (!video) return;

  // Switch view to watch mode
  if (adultBrowseView) adultBrowseView.classList.add('hidden');
  if (adultWatchView) adultWatchView.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Update UI texts
  adultWatchTitle.textContent = video.title || 'Playing 18+ Video';
  adultWatchSourceBadge.textContent = video.source || '18+ Stream';
  adultWatchDuration.innerHTML = `<i class="fa-solid fa-clock"></i> ${video.duration || 'HD'}`;
  adultWatchRating.innerHTML = `<i class="fa-solid fa-star" style="color: #f1c40f;"></i> ${video.rating || '1080p Full HD'}`;
  btnAdultWatchSource.href = video.url || '#';

  showToast('Buffering high-speed stream...', 'info');

  // Resolve Stream
  let resolved = {};
  try {
    const rRes = await fetch('/api/adult/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: video.url })
    });
    const rData = await rRes.json();
    resolved = rData.resolved || {};
  } catch (e) {}

  let activeStreamUrl = resolved.streamUrl || video.url;
  let activeDlUrl = resolved.downloadUrl || activeStreamUrl;
  let activeQualityLabel = '1080p Full HD';
  const finalEmbedUrl = resolved.embedUrl || video.url;

  // Setup Download Action with chosen quality
  btnAdultWatchDownload.onclick = () => {
    triggerDirectDownload(activeDlUrl, `${video.title}_${activeQualityLabel}.mp4`);
  };

  // Setup Drive Action with chosen quality
  btnAdultWatchDrive.onclick = () => {
    startCloudTransfer({
      title: `${video.title} [${activeQualityLabel}]`,
      url: activeDlUrl,
      type: 'nsfw',
      quality: activeQualityLabel
    });
  };

  // Setup Copy Link
  btnAdultWatchCopy.onclick = () => {
    navigator.clipboard.writeText(activeDlUrl);
    showToast(`Direct stream link (${activeQualityLabel}) copied!`, 'success');
  };

  // YouTube-Style Quality / Resolution Picker
  const adultQualityPills = document.getElementById('adultQualityPills');
  if (adultQualityPills) {
    adultQualityPills.innerHTML = '';
    const qualities = resolved.qualities && resolved.qualities.length > 0
      ? resolved.qualities
      : [
          { label: '1080p Full HD', url: activeStreamUrl, isDefault: true },
          { label: '720p HD', url: activeStreamUrl },
          { label: '480p SD', url: activeStreamUrl },
          { label: 'Auto (Adaptive)', url: activeStreamUrl }
        ];

    qualities.forEach((q, idx) => {
      const pill = document.createElement('button');
      pill.className = `quality-pill ${q.isDefault || idx === 0 ? 'active' : ''}`;
      pill.innerHTML = `<i class="fa-solid fa-sliders"></i> ${q.label}`;

      pill.addEventListener('click', () => {
        adultQualityPills.querySelectorAll('.quality-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');

        activeStreamUrl = q.url;
        activeDlUrl = q.url;
        activeQualityLabel = q.label;
        adultWatchRating.innerHTML = `<i class="fa-solid fa-star" style="color: #f1c40f;"></i> ${q.label}`;
        showToast(`Resolution switched to ${q.label}`, 'info');

        // Save current timestamp to resume seamlessly
        const currentTime = adultHtmlVideoPlayer.currentTime || 0;
        const isPaused = adultHtmlVideoPlayer.paused;

        if (window._adultHls && q.label.toLowerCase().includes('auto')) {
          window._adultHls.currentLevel = -1;
        } else if (window._adultHls && window._adultHls.levels && window._adultHls.levels.length > 0) {
          const matchIdx = window._adultHls.levels.findIndex(lvl => q.label.includes(`${lvl.height}p`));
          if (matchIdx !== -1) {
            window._adultHls.currentLevel = matchIdx;
          } else {
            switchStreamSource(q.url, currentTime, isPaused);
          }
        } else {
          switchStreamSource(q.url, currentTime, isPaused);
        }
      });

      adultQualityPills.appendChild(pill);
    });
  }

  function switchStreamSource(url, time, isPaused) {
    if (url.includes('.m3u8') && window.Hls && Hls.isSupported()) {
      if (window._adultHls) {
        window._adultHls.destroy();
        window._adultHls = null;
      }
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(adultHtmlVideoPlayer);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        adultHtmlVideoPlayer.currentTime = time;
        if (!isPaused) adultHtmlVideoPlayer.play().catch(() => {});
      });
      window._adultHls = hls;
    } else {
      adultHtmlVideoPlayer.src = url;
      adultHtmlVideoPlayer.load();
      adultHtmlVideoPlayer.currentTime = time;
      if (!isPaused) adultHtmlVideoPlayer.play().catch(fallbackToEmbed);
    }
  }

  // Play Video: Prioritize 100% clean, native HTML5 Video Player with HLS.js support & auto-fallback
  const fallbackToEmbed = () => {
    if (finalEmbedUrl) {
      adultHtmlVideoPlayer.pause();
      adultHtmlVideoPlayer.classList.add('hidden');
      if (window._adultHls) {
        window._adultHls.destroy();
        window._adultHls = null;
      }
      adultIframePlayer.src = finalEmbedUrl;
      adultIframePlayer.classList.remove('hidden');
    }
  };

  if (resolved.type === 'mp4' || (activeStreamUrl && !activeStreamUrl.includes('pornhub.com') && (activeStreamUrl.includes('.mp4') || activeStreamUrl.includes('.m3u8') || activeStreamUrl.includes('cdn')))) {
    adultIframePlayer.src = '';
    adultIframePlayer.classList.add('hidden');
    adultHtmlVideoPlayer.classList.remove('hidden');

    switchStreamSource(activeStreamUrl, 0, false);
  } else if (finalEmbedUrl) {
    fallbackToEmbed();
  }

  // Load YouTube-style Related Videos underneath
  loadAdultRelatedVideos(video.title, video.source);
}

// Fetch and render Related Videos under the YouTube Player
async function loadAdultRelatedVideos(query, source) {
  if (!adultRelatedFeed) return;

  adultRelatedFeed.innerHTML = `
    <div style="color: var(--text-muted); font-size: 0.78rem; padding: 12px; display: flex; align-items: center; gap: 8px;">
      <div class="spinner" style="width: 18px; height: 18px; border-width: 2px; margin: 0;"></div> Loading related videos...
    </div>
  `;

  try {
    let cleanQ = (query || 'popular').replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
    if (!cleanQ || cleanQ.length < 3) cleanQ = 'popular';

    let res = await fetch('/api/adult/related', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: cleanQ, source: source || 'all' })
    });
    let data = await res.json();
    let items = data.results || [];

    if (items.length === 0) {
      res = await fetch('/api/adult/related', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'popular', source: 'all' })
      });
      data = await res.json();
      items = data.results || [];
    }

    if (items.length === 0) {
      adultRelatedFeed.innerHTML = `<div style="color: var(--text-muted); font-size: 0.78rem; padding: 8px;">No related videos found.</div>`;
      return;
    }

    adultRelatedFeed.innerHTML = '';
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'yt-related-item';
      el.innerHTML = `
        <div class="yt-related-thumb">
          <img src="${item.thumbnail || ''}" alt="${item.title}" loading="lazy">
          <span class="yt-related-dur">${item.duration || 'HD'}</span>
        </div>
        <div class="yt-related-info">
          <div class="yt-related-title">${item.title}</div>
          <div class="yt-related-meta">
            <span style="color: var(--accent-magenta); font-weight: 700;">${item.source || '18+'}</span>
            <span>•</span>
            <span>${item.rating || '1080p'}</span>
          </div>
        </div>
      `;

      el.addEventListener('click', () => {
        openAdultWatchMode(item);
      });

      adultRelatedFeed.appendChild(el);
    });
  } catch (e) {
    adultRelatedFeed.innerHTML = `<div style="color: var(--text-muted); font-size: 0.78rem;">Failed to load related feed.</div>`;
  }
}

// ================= 4. Direct Download Manager (Pro Level) ================= //
const directDownloadInput = document.getElementById('directDownloadInput');
const btnStartDirectDownload = document.getElementById('btnStartDirectDownload');
const downloadsList = document.getElementById('downloadsList');

if (btnStartDirectDownload) {
  btnStartDirectDownload.addEventListener('click', async () => {
    const url = directDownloadInput.value.trim();
    if (!url) return showToast('Please enter a URL (FilesPayouts, Direct MP4, etc.)', 'info');

    try {
      showToast('Starting direct download...', 'info');
      const res = await fetch('/api/downloads/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (data.success && data.item) {
        state.downloads.set(data.item.id, data.item);
        renderDownloads();
        directDownloadInput.value = '';
        showToast('Download added to manager!', 'success');
      }
    } catch (e) {
      showToast('Failed to start download: ' + e.message, 'error');
    }
  });
}

function renderDownloads() {
  if (!downloadsList) return;
  const items = Array.from(state.downloads.values()).reverse();

  const activeCount = items.filter(d => d.status === 'downloading' || d.status === 'resolving').length;
  if (navDownloadsBadge) {
    if (activeCount > 0) {
      navDownloadsBadge.textContent = activeCount;
      navDownloadsBadge.classList.remove('hidden');
    } else {
      navDownloadsBadge.classList.add('hidden');
    }
  }

  if (items.length === 0) {
    downloadsList.innerHTML = `
      <div class="empty-state" id="emptyDownloads">
        <i class="fa-solid fa-circle-down"></i>
        <h3>No Direct Downloads</h3>
        <p>Paste any URL (FilesPayouts, MP4, MKV, or Media) above or click [Download] on any card.</p>
      </div>
    `;
    return;
  }

  downloadsList.innerHTML = '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = `task-card ${item.status}`;

    let statusText = item.status.toUpperCase();
    if (item.status === 'downloading') statusText = `Downloading (${item.percent}%)`;
    if (item.status === 'paused') statusText = `Paused (${item.percent}%)`;

    card.innerHTML = `
      <div class="task-top">
        <div class="task-title"><i class="fa-solid fa-file-arrow-down" style="color: var(--accent-cyan); margin-right: 6px;"></i> ${item.title}</div>
        <span class="task-badge ${item.status}">${statusText}</span>
      </div>

      <div class="progress-track">
        <div class="progress-fill" style="width: ${item.percent || 0}%;"></div>
      </div>

      <div class="task-metrics">
        <span><i class="fa-solid fa-gauge-high"></i> Speed: ${item.speedMBps || '0.00'} MB/s</span>
        <span><i class="fa-solid fa-hard-drive"></i> ${item.downloadedMB || '0'} MB / ${item.totalMB || '0'} MB</span>
        <span><i class="fa-solid fa-hourglass-half"></i> ETA: ${item.etaSec || 0}s</span>
      </div>

      <div class="task-actions">
        ${item.status === 'downloading' ? `
          <button class="btn-task-action secondary btn-pause-dl" data-id="${item.id}" title="Pause Download">
            <i class="fa-solid fa-pause"></i> Pause
          </button>
        ` : ''}

        ${item.status === 'paused' || item.status === 'failed' ? `
          <button class="btn-task-action primary btn-resume-dl" data-id="${item.id}" title="Resume Download">
            <i class="fa-solid fa-play"></i> Start / Resume
          </button>
        ` : ''}

        ${item.status === 'completed' ? `
          <button class="btn-task-action stream btn-play-dl" data-id="${item.id}" data-title="${item.title}">
            <i class="fa-solid fa-circle-play"></i> Watch Online
          </button>
          <a href="/api/downloads/file/${item.id}" class="btn-task-action primary" download="${item.fileName}">
            <i class="fa-solid fa-download"></i> Save to Device
          </a>
          <button class="btn-task-action secondary btn-drive-upload" data-id="${item.id}" data-title="${item.title}">
            <i class="fa-brands fa-google-drive"></i> Send to Drive
          </button>
        ` : ''}

        <button class="btn-task-action secondary btn-delete-dl" data-id="${item.id}" style="color: var(--accent-red);" title="Delete File & Task">
          <i class="fa-solid fa-trash-can"></i> Delete
        </button>
      </div>
    `;

    // Pause handler
    const pauseBtn = card.querySelector('.btn-pause-dl');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', async () => {
        await fetch('/api/downloads/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pauseBtn.dataset.id })
        });
        showToast('Download paused', 'info');
      });
    }

    // Resume handler
    const resumeBtn = card.querySelector('.btn-resume-dl');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', async () => {
        await fetch('/api/downloads/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: resumeBtn.dataset.id })
        });
        showToast('Download resumed', 'info');
      });
    }

    // Play completed handler
    const playBtn = card.querySelector('.btn-play-dl');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        openPlayer({
          title: playBtn.dataset.title,
          streamUrl: `/api/downloads/file/${playBtn.dataset.id}`,
          isDirect: true
        });
      });
    }

    // Upload completed download to Google Drive
    const driveUploadBtn = card.querySelector('.btn-drive-upload');
    if (driveUploadBtn) {
      driveUploadBtn.addEventListener('click', () => {
        startCloudTransfer({
          title: driveUploadBtn.dataset.title,
          url: `http://localhost:5000/api/downloads/file/${driveUploadBtn.dataset.id}`,
          type: 'media',
          quality: 'Original'
        });
      });
    }

    // Delete handler
    const deleteBtn = card.querySelector('.btn-delete-dl');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        await fetch('/api/downloads/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: deleteBtn.dataset.id, deleteFile: true })
        });
        state.downloads.delete(deleteBtn.dataset.id);
        renderDownloads();
        showToast('Download deleted', 'info');
      });
    }

    downloadsList.appendChild(card);
  });
}

// ================= 5. Cloud Transfer Manager ================= //
async function startCloudTransfer({ title, url, type, quality }) {
  if (!state.driveConnected) {
    showToast('Please link your Google Drive Account first!', 'error');
    openSettingsModal();
    return;
  }

  showToast('Initiating Cloud-to-Drive Transfer...', 'info');
  switchTab('tasks');

  try {
    const res = await fetch('/api/transfer/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, url, type, quality })
    });
    const data = await res.json();
    if (data.success && data.task) {
      state.tasks.set(data.task.id, data.task);
      renderTasks();
    }
  } catch (err) {
    showToast('Failed to start transfer: ' + err.message, 'error');
  }
}

function renderTasks() {
  const taskList = document.getElementById('tasksList');
  const emptyTasks = document.getElementById('emptyTasks');
  const tasksArr = Array.from(state.tasks.values()).reverse();

  const activeCount = tasksArr.filter(t => t.status === 'transferring' || t.status === 'resolving' || t.status === 'queued').length;
  if (navTaskBadge) {
    if (activeCount > 0) {
      navTaskBadge.textContent = activeCount;
      navTaskBadge.classList.remove('hidden');
    } else {
      navTaskBadge.classList.add('hidden');
    }
  }

  if (tasksArr.length === 0) {
    taskList.innerHTML = `
      <div class="empty-state" id="emptyTasks">
        <i class="fa-solid fa-cloud-arrow-up"></i>
        <h3>No Active Cloud Transfers</h3>
        <p>Search movies or paste media links to initiate instant transfers.</p>
      </div>
    `;
    return;
  }

  taskList.innerHTML = '';
  tasksArr.forEach(task => {
    const card = document.createElement('div');
    card.className = `task-card ${task.status}`;

    let statusText = task.status.toUpperCase();
    if (task.status === 'transferring') statusText = `Cloud ➔ Drive (${task.percent}%)`;

    card.innerHTML = `
      <div class="task-top">
        <div class="task-title">${task.title}</div>
        <span class="task-badge ${task.status}">${statusText}</span>
      </div>

      <div class="progress-track">
        <div class="progress-fill" style="width: ${task.percent || 0}%;"></div>
      </div>

      <div class="task-metrics">
        <span><i class="fa-solid fa-gauge-high"></i> Speed: ${task.speedMBps || '0.00'} MB/s</span>
        <span><i class="fa-solid fa-hard-drive"></i> ${task.uploadedMB || '0'} MB / ${task.totalMB || '0'} MB</span>
        <span><i class="fa-solid fa-hourglass-half"></i> ETA: ${task.etaSec || 0}s</span>
      </div>

      ${task.driveResult ? `
        <div class="task-actions">
          <button class="btn-task-action stream btn-play-task" data-id="${task.driveResult.fileId}" data-title="${task.title}">
            <i class="fa-solid fa-circle-play"></i> Watch Online
          </button>
          <a href="${task.driveResult.directDownloadUrl}" class="btn-task-action primary" target="_blank" download>
            <i class="fa-solid fa-download"></i> Direct Download
          </a>
          <a href="${task.driveResult.webViewLink}" class="btn-task-action secondary" target="_blank">
            <i class="fa-brands fa-google-drive"></i> Open in Drive
          </a>
          <button class="btn-task-action secondary btn-copy-link" data-url="${task.driveResult.directDownloadUrl}">
            <i class="fa-solid fa-copy"></i> Copy Link
          </button>
        </div>
      ` : ''}

      ${task.status === 'transferring' ? `
        <div class="task-actions">
          <button class="btn-secondary btn-cancel-task" data-id="${task.id}" style="color: var(--accent-red);">
            <i class="fa-solid fa-ban"></i> Cancel Transfer
          </button>
        </div>
      ` : ''}
    `;

    // Watch online handler
    const playBtn = card.querySelector('.btn-play-task');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        openPlayer({
          title: playBtn.dataset.title,
          driveId: playBtn.dataset.id,
          isDrive: true
        });
      });
    }

    // Copy link handler
    const copyBtn = card.querySelector('.btn-copy-link');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(copyBtn.dataset.url);
        showToast('Google Drive download link copied!', 'success');
      });
    }

    // Cancel handler
    const cancelBtn = card.querySelector('.btn-cancel-task');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        await fetch('/api/transfer/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: cancelBtn.dataset.id })
        });
        showToast('Transfer cancelled.', 'info');
      });
    }

    taskList.appendChild(card);
  });
}

document.getElementById('btnClearTasks').addEventListener('click', async () => {
  await fetch('/api/transfer/clear', { method: 'POST' });
  state.tasks.clear();
  renderTasks();
});

// ================= 6. Google Drive Library, Account & Player (2026 Edition) ================= //
async function loadDriveAccountProfile() {
  const disconnectedView = document.getElementById('driveDisconnectedView');
  const connectedView = document.getElementById('driveConnectedView');
  const avatarEl = document.getElementById('driveAvatar');
  const nameEl = document.getElementById('driveUserName');
  const emailEl = document.getElementById('driveUserEmail');
  const storageTextEl = document.getElementById('driveStorageText');
  const storageFillEl = document.getElementById('driveStorageFill');

  try {
    const res = await fetch('/api/gdrive/about');
    const data = await res.json();
    if (data.success && data.user) {
      nameEl.textContent = data.user.displayName || 'Google Account';
      emailEl.textContent = data.user.emailAddress || 'chathura4003@gmail.com';
      if (data.user.photoLink) {
        avatarEl.innerHTML = `<img src="${data.user.photoLink}" alt="Avatar">`;
      } else {
        avatarEl.innerHTML = `<i class="fa-brands fa-google-drive"></i>`;
      }
      if (data.storageQuota) {
        storageTextEl.textContent = `${data.storageQuota.usage} of ${data.storageQuota.limit} used`;
        storageFillEl.style.width = `${data.storageQuota.usagePercent}%`;
      }
      state.driveConnected = true;
      if (disconnectedView) disconnectedView.classList.add('hidden');
      if (connectedView) connectedView.classList.remove('hidden');
      checkStatus();
    } else if (state.driveConnected) {
      nameEl.textContent = 'Google Account';
      emailEl.textContent = state.driveUser?.accountEmail || 'chathura4003@gmail.com';
      if (disconnectedView) disconnectedView.classList.add('hidden');
      if (connectedView) connectedView.classList.remove('hidden');
    } else {
      state.driveConnected = false;
      if (disconnectedView) disconnectedView.classList.remove('hidden');
      if (connectedView) connectedView.classList.add('hidden');
    }
  } catch (err) {
    if (state.driveConnected) {
      if (disconnectedView) disconnectedView.classList.add('hidden');
      if (connectedView) connectedView.classList.remove('hidden');
    } else {
      if (disconnectedView) disconnectedView.classList.remove('hidden');
      if (connectedView) connectedView.classList.add('hidden');
    }
  }
}

async function loadDriveFiles() {
  const driveGrid = document.getElementById('driveFilesGrid');
  const driveLoading = document.getElementById('driveLoading');

  if (!state.driveConnected) {
    driveGrid.innerHTML = `
      <div class="empty-state">
        <i class="fa-brands fa-google-drive"></i>
        <h3>Google Drive Not Connected</h3>
        <p>Click "Sign in with Google" above to link your account and access cloud files.</p>
      </div>
    `;
    return;
  }

  driveLoading.classList.remove('hidden');
  driveGrid.innerHTML = '';

  try {
    const res = await fetch('/api/gdrive/files');
    const data = await res.json();
    driveLoading.classList.add('hidden');

    if (data.error && (data.error.includes('403') || data.error.includes('disabled') || data.error.includes('Enable'))) {
      driveGrid.innerHTML = `
        <div class="empty-state" style="background: rgba(255, 165, 2, 0.08); border: 1px solid rgba(255, 165, 2, 0.3); border-radius: var(--radius-md); padding: 20px;">
          <i class="fa-solid fa-triangle-exclamation" style="color: #ffa502; font-size: 2.2rem; margin-bottom: 10px;"></i>
          <h3 style="color: #ffa502;">Google Drive API Needs 1-Click Activation</h3>
          <p style="font-size: 0.85rem; color: #cbd5e1; margin-bottom: 14px;">Your Google Account is linked, but the <strong>Google Drive API</strong> is not yet enabled in your Google Cloud Project.</p>
          <a href="https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=662010323544" target="_blank" class="btn-action" style="padding: 10px 20px; font-size: 0.88rem; text-decoration: none; display: inline-flex; align-items: center; gap: 8px;">
            <i class="fa-solid fa-bolt"></i> Enable Google Drive API (1-Click)
          </a>
        </div>
      `;
      return;
    }

    if (!data.files || data.files.length === 0) {
      driveGrid.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-folder-open"></i>
          <h3>No Files Found in Cloud Media Downloads</h3>
          <p>Files uploaded through movies or media will appear here automatically.</p>
        </div>
      `;
      return;
    }

    data.files.forEach(file => {
      const card = document.createElement('div');
      card.className = 'drive-file-card';
      const sizeMB = file.size ? (file.size / (1024 * 1024)).toFixed(1) + ' MB' : 'Drive File';
      const isVideo = file.mimeType?.includes('video') || /\.(mp4|mkv|avi|webm|mov)$/i.test(file.name);
      const directDl = `https://drive.google.com/uc?export=download&id=${file.id}`;

      card.innerHTML = `
        <div class="drive-file-header">
          <div class="drive-file-icon">
            <i class="fa-solid ${isVideo ? 'fa-file-video' : 'fa-file'}"></i>
          </div>
          <div style="flex: 1; overflow: hidden;">
            <div class="drive-file-title">${file.name}</div>
            <div class="drive-file-meta">${sizeMB} • ${new Date(file.createdTime).toLocaleDateString()}</div>
          </div>
        </div>

        <div class="drive-file-actions">
          ${isVideo ? `
            <button class="btn-action btn-play-drive" style="padding: 6px 12px; font-size: 0.78rem; background: var(--grad-accent); color: #fff;">
              <i class="fa-solid fa-play"></i> Watch Online
            </button>
          ` : ''}
          <a href="${directDl}" class="btn-action" style="padding: 6px 12px; font-size: 0.78rem;" download>
            <i class="fa-solid fa-download"></i> Download
          </a>
          <button class="btn-secondary btn-copy" data-url="${directDl}" style="padding: 6px 10px;" title="Copy Link">
            <i class="fa-solid fa-copy"></i>
          </button>
          <a href="${file.webViewLink}" class="btn-secondary" style="padding: 6px 10px;" target="_blank" title="Drive">
            <i class="fa-brands fa-google-drive"></i>
          </a>
          <button class="btn-secondary btn-delete-drive" data-id="${file.id}" style="padding: 6px 10px; color: var(--accent-red);" title="Delete from Drive">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;

      if (isVideo) {
        card.querySelector('.btn-play-drive').addEventListener('click', () => {
          openPlayer({
            title: file.name,
            driveId: file.id,
            isDrive: true
          });
        });
      }

      card.querySelector('.btn-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(directDl);
        showToast('Direct Download Link copied to clipboard!', 'success');
      });

      card.querySelector('.btn-delete-drive').addEventListener('click', async () => {
        if (confirm(`Are you sure you want to delete "${file.name}" from your Google Drive?`)) {
          showToast('Deleting file from Drive...', 'info');
          try {
            const delRes = await fetch('/api/gdrive/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileId: file.id })
            });
            const delData = await delRes.json();
            if (delData.success) {
              showToast(`"${file.name}" deleted from Google Drive!`, 'success');
              loadDriveAccountProfile();
              loadDriveFiles();
            } else {
              showToast(delData.error || 'Failed to delete file', 'error');
            }
          } catch (e) {
            showToast('Error deleting file: ' + e.message, 'error');
          }
        }
      });

      driveGrid.appendChild(card);
    });
  } catch (err) {
    driveLoading.classList.add('hidden');
    showToast('Failed to load files from Drive: ' + err.message, 'error');
  }
}

// Direct Sign In Trigger
async function triggerGoogleOAuthLogin() {
  const clientId = document.getElementById('oauthClientId')?.value.trim() || '';
  let clientSecret = document.getElementById('oauthClientSecret')?.value.trim() || '';
  if (clientSecret && !clientSecret.startsWith('GOCSPX-')) clientSecret = '';

  showToast('Connecting with Google...', 'info');

  try {
    const res = await fetch('/api/gdrive/oauth/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId || undefined, clientSecret: clientSecret || undefined })
    });
    const data = await res.json();

    if (data.authUrl) {
      window.location.href = data.authUrl;
    } else {
      showToast(data.error || 'Failed to initialize Google Login', 'error');
      openSettingsModal();
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

const btnGoogleSignInDirect = document.getElementById('btnGoogleSignInDirect');
if (btnGoogleSignInDirect) {
  btnGoogleSignInDirect.addEventListener('click', triggerGoogleOAuthLogin);
}

const btnGoogleSignInAction = document.getElementById('btnGoogleSignInAction');
if (btnGoogleSignInAction) {
  btnGoogleSignInAction.addEventListener('click', triggerGoogleOAuthLogin);
}

document.getElementById('btnRefreshDrive').addEventListener('click', () => {
  loadDriveAccountProfile();
  loadDriveFiles();
});

const btnSettingsDrive = document.getElementById('btnSettingsDrive');
if (btnSettingsDrive) {
  btnSettingsDrive.addEventListener('click', openSettingsModal);
}

const btnDisconnectDrive = document.getElementById('btnDisconnectDrive');
if (btnDisconnectDrive) {
  btnDisconnectDrive.addEventListener('click', async () => {
    if (confirm('Disconnect your Google Account from Google Drive?')) {
      await fetch('/api/gdrive/disconnect', { method: 'POST' });
      state.driveConnected = false;
      showToast('Google Account Disconnected', 'info');
      checkStatus();
      loadDriveAccountProfile();
      loadDriveFiles();
    }
  });
}

// ================= 7. Video Stream Player Logic ================= //
const playerModal = document.getElementById('playerModal');
const btnClosePlayer = document.getElementById('btnClosePlayer');
const htmlVideoPlayer = document.getElementById('htmlVideoPlayer');
const iframeVideoPlayer = document.getElementById('iframeVideoPlayer');
const playerTitle = document.getElementById('playerTitle');
const playerSourceInfo = document.getElementById('playerSourceInfo');
const playerDirectDownload = document.getElementById('playerDirectDownload');
const playerUploadDriveBtn = document.getElementById('playerUploadDriveBtn');
const playerRelatedGrid = document.getElementById('playerRelatedGrid');

async function openPlayer({ title, streamUrl, embedUrl, downloadUrl, driveId, isDrive, type, relatedQuery, relatedSource }) {
  playerTitle.textContent = title || 'Playing Media';
  playerModal.classList.remove('hidden');

  const dlUrl = downloadUrl || streamUrl || (driveId ? `https://drive.google.com/uc?export=download&id=${driveId}` : '#');
  playerDirectDownload.href = dlUrl;
  playerDirectDownload.setAttribute('download', `${(title || 'video').replace(/[/\\?%*:|"<>]/g, '_')}.mp4`);

  // Drive upload button
  if (playerUploadDriveBtn) {
    if (isDrive) {
      playerUploadDriveBtn.classList.add('hidden');
    } else {
      playerUploadDriveBtn.classList.remove('hidden');
      playerUploadDriveBtn.onclick = () => {
        startCloudTransfer({
          title: title || 'Video Media',
          url: dlUrl,
          type: 'media',
          quality: 'HD'
        });
      };
    }
  }

  // Streaming source setup
  if (isDrive && driveId) {
    htmlVideoPlayer.pause();
    htmlVideoPlayer.classList.add('hidden');
    htmlVideoPlayer.src = '';

    iframeVideoPlayer.src = `https://drive.google.com/file/d/${driveId}/preview`;
    iframeVideoPlayer.classList.remove('hidden');
    playerSourceInfo.textContent = 'Streaming directly from Google Drive CDN';
  } else if (type === 'embed' && (embedUrl || streamUrl)) {
    htmlVideoPlayer.pause();
    htmlVideoPlayer.classList.add('hidden');
    htmlVideoPlayer.src = '';

    iframeVideoPlayer.src = embedUrl || streamUrl;
    iframeVideoPlayer.classList.remove('hidden');
    playerSourceInfo.textContent = 'High-Speed Web Embed Player';
  } else if (streamUrl) {
    iframeVideoPlayer.src = '';
    iframeVideoPlayer.classList.add('hidden');

    htmlVideoPlayer.classList.remove('hidden');
    htmlVideoPlayer.src = streamUrl;
    htmlVideoPlayer.load();
    htmlVideoPlayer.play().catch(() => {
      if (embedUrl) {
        htmlVideoPlayer.classList.add('hidden');
        iframeVideoPlayer.src = embedUrl;
        iframeVideoPlayer.classList.remove('hidden');
      }
    });

    playerSourceInfo.textContent = 'Direct HTML5 High-Speed Stream';
  }

  // Load YouTube-style Related Videos
  if (playerRelatedGrid) {
    playerRelatedGrid.innerHTML = `
      <div style="color: var(--text-muted); font-size: 0.78rem; padding: 10px; display: flex; align-items: center; gap: 8px;">
        <div class="spinner" style="width: 18px; height: 18px; border-width: 2px; margin: 0;"></div> Loading related videos...
      </div>
    `;

    try {
      const relRes = await fetch('/api/adult/related', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: relatedQuery || 'trending', source: relatedSource || 'all' })
      });
      const relData = await relRes.json();
      const items = relData.results || [];

      if (items.length === 0) {
        playerRelatedGrid.innerHTML = `<div style="color: var(--text-muted); font-size: 0.78rem; padding: 8px;">No related videos found.</div>`;
        return;
      }

      playerRelatedGrid.innerHTML = '';
      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'related-video-card';
        card.innerHTML = `
          <div class="related-thumb-box">
            <img src="${item.thumbnail || ''}" alt="${item.title}" loading="lazy">
            <span class="related-dur-badge">${item.duration || 'HD'}</span>
          </div>
          <div class="related-meta">
            <div class="related-title">${item.title}</div>
            <div class="related-sub">
              <span style="color: var(--accent-magenta); font-weight: 600;">${item.source || '18+'}</span>
              <span>• ${item.rating || '1080p'}</span>
            </div>
          </div>
        `;

        card.addEventListener('click', async () => {
          showToast(`Switching to: ${item.title.substring(0, 25)}...`, 'info');
          try {
            const rRes = await fetch('/api/adult/resolve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: item.url })
            });
            const rData = await rRes.json();
            const resolved = rData.resolved || {};

            openPlayer({
              title: resolved.title || item.title,
              streamUrl: resolved.streamUrl,
              embedUrl: resolved.embedUrl,
              downloadUrl: resolved.downloadUrl || item.url,
              type: resolved.type || 'direct',
              relatedQuery: item.title.split(' ').slice(0, 3).join(' '),
              relatedSource: item.source
            });
          } catch (e) {
            openPlayer({
              title: item.title,
              streamUrl: item.url,
              downloadUrl: item.url,
              relatedQuery: 'popular'
            });
          }
        });

        playerRelatedGrid.appendChild(card);
      });
    } catch (e) {
      playerRelatedGrid.innerHTML = `<div style="color: var(--text-muted); font-size: 0.78rem;">Failed to load related videos.</div>`;
    }
  }
}

function closePlayer() {
  htmlVideoPlayer.pause();
  htmlVideoPlayer.src = '';
  iframeVideoPlayer.src = '';
  playerModal.classList.add('hidden');
}

btnClosePlayer.addEventListener('click', closePlayer);
playerModal.addEventListener('click', (e) => {
  if (e.target === playerModal) closePlayer();
});

// ================= 8. Settings Modal Controller ================= //
const settingsModal = document.getElementById('settingsModal');
const btnSettings = document.getElementById('btnSettings');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnSaveCustomCreds = document.getElementById('btnSaveCustomCreds');
const saDropzone = document.getElementById('saDropzone');
const saFileInput = document.getElementById('saFileInput');
const saJsonInput = document.getElementById('saJsonInput');

btnSettings.addEventListener('click', openSettingsModal);
btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));

function openSettingsModal() {
  settingsModal.classList.remove('hidden');
}

// Dropzone file picker handler
if (saDropzone && saFileInput) {
  saDropzone.addEventListener('click', () => saFileInput.click());

  saDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    saDropzone.classList.add('dragover');
  });

  saDropzone.addEventListener('dragleave', () => saDropzone.classList.remove('dragover'));

  saDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    saDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleSaFile(e.dataTransfer.files[0]);
    }
  });

  saFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleSaFile(e.target.files[0]);
    }
  });
}

function handleSaFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (!json.client_email || !json.private_key) {
        showToast('Invalid Service Account JSON key', 'error');
        return;
      }
      saJsonInput.value = JSON.stringify(json, null, 2);
      showToast(`Loaded key for: ${json.client_email}`, 'success');
    } catch (err) {
      showToast('Failed to parse JSON file: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

// Save Custom Credentials Action
if (btnSaveCustomCreds) {
  btnSaveCustomCreds.addEventListener('click', async () => {
    const folderId = document.getElementById('driveFolderIdInput').value.trim();
    const saText = saJsonInput.value.trim();
    const clientId = document.getElementById('oauthClientId').value.trim();
    const clientSecret = document.getElementById('oauthClientSecret').value.trim();

    const payload = { defaultFolderId: folderId };

    const customRefreshToken = document.getElementById('customRefreshToken')?.value.trim();

    if (customRefreshToken) {
      payload.authType = 'oauth2';
      payload.oauth2 = {
        clientId: clientId || '',
        clientSecret: clientSecret || '',
        refreshToken: customRefreshToken
      };
    } else if (saText) {
      try {
        payload.authType = 'service_account';
        payload.serviceAccount = JSON.parse(saText);
      } catch (e) {
        return showToast('Invalid JSON format in Service Account field', 'error');
      }
    } else if (clientId) {
      payload.authType = 'oauth2';
      payload.oauth2 = { clientId, clientSecret };
    }

    try {
      const res = await fetch('/api/gdrive/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Custom Google Credentials Saved!', 'success');
        settingsModal.classList.add('hidden');
        checkStatus();
        loadDriveAccountProfile();
        loadDriveFiles();
      } else {
        showToast(data.error || 'Failed to save credentials', 'error');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

// Toast Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'fa-circle-info';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-circle-exclamation';

  toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// Check OAuth callback query parameter
if (window.location.search.includes('gdrive_linked=true')) {
  showToast('🎉 Google Account Linked to Google Drive Successfully!', 'success');
  window.history.replaceState({}, document.title, window.location.pathname);
  switchTab('drive');
}

// Initial Boot
checkStatus();
searchMovies('2024');
