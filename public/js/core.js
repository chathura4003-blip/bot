'use strict';

const State = {
  page: 'dashboard',
  user: localStorage.getItem('token') ? { name: 'Chathu MD', role: 'Administrator' } : null,
  data: {
    sessions: [],
    users: [],
    groups: [],
    commands: [],
    scheduler: [],
    autoReply: [],
    stats: {},
    logs: []
  },
  activeQrSession: null,
  activeConfigSession: '__main__',
  lastFleetSync: null,
  activeCmdCategory: 'all'
};

// Single shared socket connection. Re-using a global instance avoids the
// duplicate event listeners (and double log/QR updates) that occurred when
// both this module and initSocketEvents() called io() independently.
const socket = (typeof io !== 'undefined') ? io({
  auth: { token: localStorage.getItem('token') },
}) : null;
State.socket = socket;

if (socket) {
  socket.on('connect', () => {
    console.log('Socket connected');
    const el = document.getElementById('botGlobalStatus');
    if (el) {
      el.textContent = 'Cloud Sync Active';
      el.className = 'badge green';
    }
  });

  socket.on('disconnect', () => {
    const el = document.getElementById('botGlobalStatus');
    if (el) {
      el.textContent = 'Offline';
      el.className = 'badge gray';
    }
  });

  socket.on('log', (entry) => {
    if (typeof appendLogLine === 'function') appendLogLine(entry);
  });
}

// Navigation with Cleanup Engine
async function navigate(page) {
  if (!State.user && page !== 'login') return;
  
  startProgress();
  const content = document.getElementById('mainContent');
  const title = document.getElementById('activePageTitle');
  
  try {
    const res = await fetch(`/tabs/${page}.html`);
    if (!res.ok) throw new Error('Page not found');
    
    const html = await res.text();
    const temp = document.createElement('div');
    temp.innerHTML = html;
    
    // 1. Cleanup Old Fragment Assets
    document.querySelectorAll('.fragment-script').forEach(s => s.remove());
    document.querySelectorAll('style[data-fragment]').forEach(s => s.remove());
    
    const scripts = temp.querySelectorAll('script');
    const styles = temp.querySelectorAll('style');
    const pageEl = temp.querySelector('.page');

    // 2. Inject New Styles
    styles.forEach(s => {
      const ns = document.createElement('style');
      ns.textContent = s.textContent;
      ns.setAttribute('data-fragment', page);
      document.head.appendChild(ns);
    });

    // 3. Update Content
    if (pageEl) {
      content.innerHTML = pageEl.innerHTML;
      
      // Update Titles (Mapping for better display)
      const titles = {
        'dashboard': 'System Dashboard',
        'users_db': 'User Database',
        'aiengine': 'AI Neural Engine',
        'autoreply': 'Auto-Reply Rules',
        'broadcast': 'Fleet Broadcast'
      };
      title.textContent = titles[page] || page.charAt(0).toUpperCase() + page.slice(1).replace('_', ' ');

      // 4. Inject & Execute New Scripts
      scripts.forEach(s => {
        const ns = document.createElement('script');
        ns.className = 'fragment-script';
        ns.textContent = s.textContent;
        document.body.appendChild(ns);
      });
      
      // 5. Update Nav Active State
      document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
      });
      
      // 6. Trigger Init
      const initFn = 'init' + page.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('') + 'Tab';
      if (typeof window[initFn] === 'function') {
        window[initFn]();
      } else {
        const initFnAlt = 'init' + page.charAt(0).toUpperCase() + page.slice(1) + 'Tab';
        if (typeof window[initFnAlt] === 'function') window[initFnAlt]();
      }
    }

    State.page = page;
    localStorage.setItem('lastPage', page);
    
    finishProgress();
  } catch (e) {
    finishProgress();
    content.innerHTML = `<div class="card"><div class="title" style="color:var(--danger)">Navigation Failed</div><p>${e.message}</p></div>`;
  }
}

function startProgress() {
  const bar = document.getElementById('topProgress');
  if (bar) {
    bar.classList.add('active');
    bar.style.width = '30%';
    setTimeout(() => { if(bar.classList.contains('active')) bar.style.width = '70%'; }, 200);
  }
}

function finishProgress() {
  const bar = document.getElementById('topProgress');
  if (bar) {
    bar.style.width = '100%';
    setTimeout(() => {
      bar.classList.remove('active');
      bar.style.width = '0%';
    }, 300);
  }
}

  function updateShellStats(s) {
    if (!s) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('topUptime', fmtUptime(s.uptime));
    set('topMem', `${s.memUsed} MB`);
    
    const health = document.getElementById('sbHealth');
    const healthText = document.getElementById('sbHealthText');
    if (health && healthText) {
      const isOnline = s.status === 'Connected' || s.status === 'connected';
      health.classList.toggle('online', isOnline);
      health.classList.toggle('offline', !isOnline);
      healthText.textContent = isOnline ? 'Core Linked' : (s.status || 'Offline');
    }
    
    updateMainStatus(s.status, s.number);
  }

  // Real-time Event Listeners (re-uses the single shared socket created above)
  function initSocketEvents() {
    const socket = State.socket;
    if (!socket) return;

    socket.on('update', s => {
      updateShellStats(s);
      if (window.loadStats) window.loadStats();
    });

    socket.on('qr', qr => {
      if (State.activeQrSession === '__main__') {
        const img = document.getElementById('qrModalImg');
        if (img) img.innerHTML = `<img src="${qr}" alt="QR" style="max-width:100%"/>`;
      }
    });

    socket.on('session:paircode', data => {
      if (State.activeQrSession === data.id) {
        showPair(data.id, data.code);
      }
    });

    socket.on('log', entry => {
      if (window.appendLogLine) window.appendLogLine(entry);
    });
  }

// API Wrapper
async function api(path, options = {}) {
  const token = localStorage.getItem('token');
  if (!token) return logout();
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) return logout();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Helpers
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setChecked(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function fmtTime(date) {
  if (!date) return '--:--';
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getSessionAgeSeconds(session) {
  if (!session?.startedAt) return 0;
  return Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000);
}

function uniqueSessions() {
  return (State.data.sessions || []).map(s => ({
    id: s.id,
    label: s.name || (s.id === '__main__' ? 'Main Bot' : `Session ${s.id}`)
  }));
}

function toLocalDateTimeInput(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizeSessionId(val) {
  if (!val || val === 'main' || val === '__main__') return '__main__';
  return val;
}

// Modal Management
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// Session Management (Orchestration)
async function loadSessions() {
  try {
    const list = await api('/bot-api/sessions');
    State.data.sessions = list;
    if (typeof window.renderSessions === 'function') window.renderSessions();
    if (typeof window.renderUsersPage === 'function') window.renderUsersPage();
  } catch (e) { toast(e.message, 'error'); }
}

async function openQrFor(id) {
  State.activeQrSession = id;
  const titleEl = document.getElementById('qrModalTitle');
  if (titleEl) titleEl.textContent = id === '__main__' ? 'Link Main Bot' : 'Link Device - ' + id;
  const subEl = document.getElementById('qrModalSub');
  if (subEl) subEl.textContent = 'Open WhatsApp -> Linked Devices -> Link a device';
  const pairEl = document.getElementById('qrModalPair');
  if (pairEl) pairEl.style.display = 'none';
  const img = document.getElementById('qrModalImg');
  if (img) {
    img.innerHTML = '<div class="spinner"></div>';
    img.style.display = '';
  }
  openModal('qrModal');
  try {
    const r = await api('/bot-api/sessions/' + encodeURIComponent(id) + '/qr');
    if (img) img.innerHTML = `<img src="${r.qrCode}" alt="QR" style="max-width:100%; max-height:100%"/>`;
  } catch (e) {
    if (img) img.innerHTML = `<div class="empty"><span>${escapeHtml(e.message)}</span></div>`;
  }
}

async function requestPair(id) {
  const session = (State.data.sessions || []).find(s => s.id === id);
  if (session?.pairCode) return showPair(id, session.pairCode);
  
  const phone = prompt('Enter phone number (e.g. 947XXXXXXXX):');
  if (!phone) return;
  
  showPair(id, 'WAIT');
  try {
    const r = await api('/bot-api/sessions/' + encodeURIComponent(id) + '/paircode', {
      method: 'POST',
      body: JSON.stringify({ phone })
    });
    if (r.code) showPair(id, r.code);
  } catch (e) { toast(e.message, 'error'); closeModal('qrModal'); }
}

function showPair(id, code) {
  State.activeQrSession = id;
  const titleEl = document.getElementById('qrModalTitle');
  if (titleEl) titleEl.textContent = 'Pairing Code - ' + id;
  const subEl = document.getElementById('qrModalSub');
  if (subEl) subEl.textContent = 'Enter this code in WhatsApp on your phone';
  const imgEl = document.getElementById('qrModalImg');
  if (imgEl) imgEl.style.display = 'none';
  const pairEl = document.getElementById('qrModalPair');
  if (pairEl) pairEl.style.display = 'block';
  const pcEl = document.getElementById('qrModalPairCode');
  if (pcEl) pcEl.textContent = code === 'WAIT' ? 'Generating...' : code.replace(/(.{4})/g, '$1 ').trim();
  openModal('qrModal');
}

async function confirmAddSession() {
  const id = document.getElementById('newSessId').value.trim();
  const mode = document.getElementById('addSessionModal').dataset.mode || 'qr';
  const phone = document.getElementById('newSessPhone').value.trim();
  if (!id) return toast('Session ID required', 'error');
  
  const btn = document.getElementById('confirmAddBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Creating...';
  
  try {
    await api('/bot-api/sessions', {
      method: 'POST',
      body: JSON.stringify({ id, pairMode: mode === 'pair', phone })
    });
    closeModal('addSessionModal');
    toast(`Session "${id}" created`, 'success');
    await loadSessions();
    if (mode === 'qr') setTimeout(() => openQrFor(id), 500);
    else showPair(id, 'WAIT');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Create Session'; }
}

function openAddSession() {
  document.getElementById('newSessId').value = '';
  document.getElementById('newSessPhone').value = '';
  switchAddMode('qr');
  openModal('addSessionModal');
}

function switchAddMode(mode) {
  document.getElementById('addSessionModal').dataset.mode = mode;
  document.getElementById('addModePair').style.display = mode === 'pair' ? 'block' : 'none';
  document.querySelectorAll('#addSessionModal .tab').forEach(t => {
      t.classList.toggle('active', t.textContent.toLowerCase().includes(mode));
  });
}

// Session Actions
async function disconnectSession(id) {
  if (!await confirmDialog('Disconnect this session?', { okText: 'Disconnect', danger: true })) return false;
  try {
    await api('/bot-api/sessions/' + encodeURIComponent(id) + '/disconnect', { method: 'POST' });
    toast('Disconnecting...', 'success');
    return true;
  }
  catch (e) { toast(e.message, 'error'); return false; }
}

async function reconnectSession(id) {
  try {
    const endpoint = id === '__main__' ? '/bot-api/bot/reconnect' : `/bot-api/sessions/${encodeURIComponent(id)}/reconnect`;
    await api(endpoint, { method: 'POST' });
    toast('Reconnecting...', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function removeSession(id) {
  if (!await confirmDialog('Remove this session permanently?', { danger: true })) return false;
  try {
    await api('/bot-api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('Session removed', 'success');
    window.removeSessionFromState(id);
    if (typeof window.renderSessions === 'function') window.renderSessions();
    if (typeof window.renderUsersPage === 'function') window.renderUsersPage();
    return true;
  }
  catch (e) { toast(e.message, 'error'); return false; }
}

// Global Actions
function logout() {
  localStorage.removeItem('token');
  window.location.href = '/login.html';
}

function toast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.borderLeft = `4px solid ${type === 'success' ? 'var(--brand)' : type === 'error' ? 'var(--danger)' : 'var(--info)'}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(20px)';
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

// Confirmation
let confirmResolver = null;
function confirmDialog(text, options = {}) {
  return new Promise(resolve => {
    confirmResolver = resolve;
    const titleEl = document.getElementById('confirmTitle');
    const textEl = document.getElementById('confirmText');
    const okBtn = document.getElementById('confirmOkBtn');
    if (titleEl) titleEl.textContent = options.title || 'Confirm Action';
    if (textEl) textEl.textContent = text;
    if (okBtn) {
      okBtn.textContent = options.okText || 'Confirm';
      okBtn.className = 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary');
    }
    openModal('confirmModal');
  });
}

function closeConfirm(result) {
  closeModal('confirmModal');
  if (confirmResolver) confirmResolver(result);
}

function updateMainStatus(status, number) {
  const el = document.getElementById('botGlobalStatus');
  if (!el) return;
  el.textContent = status || 'Offline';
  el.className = 'badge ' + (status === 'Connected' ? 'green' : (status === 'Disconnected' ? 'gray' : 'blue'));
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  if (!localStorage.getItem('token')) {
    if (!window.location.pathname.endsWith('login.html')) {
      window.location.href = '/login.html';
    }
    return;
  }
  
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigate(item.dataset.page));
  });
  
  const lastPage = localStorage.getItem('lastPage') || 'dashboard';
  navigate(lastPage);
  
  // Background Sync
  async function syncGlobalStats() {
    try {
      const s = await api('/bot-api/stats');
      State.data.stats = s;
      updateShellStats(s);
    } catch (e) {
      console.error('Telemetry sync failed:', e);
    }
  }

  setInterval(() => {
    syncGlobalStats();
    if (State.page === 'sessions' || State.page === 'users') loadSessions();
  }, 5000);

  // Layout & View Adjustments
  function fixLayout() {
    const main = document.querySelector('.main');
    if (main) main.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', fixLayout);
  fixLayout();

  syncGlobalStats(); // Initial sync
  initSocketEvents(); // Real-time events
});

// State mutators
window.upsertSession = (s) => {
  if (!State.data.sessions) State.data.sessions = [];
  const idx = State.data.sessions.findIndex(x => x.id === s.id);
  if (idx >= 0) State.data.sessions[idx] = { ...State.data.sessions[idx], ...s };
  else State.data.sessions.push(s);
  return State.data.sessions.find(x => x.id === s.id);
};

window.removeSessionFromState = (id) => {
  State.data.sessions = (State.data.sessions || []).filter(x => x.id !== id);
};

window.upsertSchedulerItem = (item) => {
  if (!State.data.scheduler) State.data.scheduler = [];
  const idx = State.data.scheduler.findIndex(x => x.id === item.id);
  if (idx >= 0) State.data.scheduler[idx] = { ...State.data.scheduler[idx], ...item };
  else State.data.scheduler.push(item);
};

window.removeSchedulerItemFromState = (id) => {
  State.data.scheduler = (State.data.scheduler || []).filter(x => x.id !== id);
};

window.toLocalDateTimeInput = (dateStr) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
};

window.parseRecipientList = (str) => {
  return (str || '').split(/[\n,]/).map(s => s.trim()).filter(s => s.length > 5);
};

window.normalizeSessionId = (id) => id || '__main__';

// Exports
window.openModal = openModal;
window.closeModal = closeModal;
window.loadSessions = loadSessions;
window.openQrFor = openQrFor;
window.requestPair = requestPair;
window.showPair = showPair;
window.openAddSession = openAddSession;
window.switchAddMode = switchAddMode;
window.confirmAddSession = confirmAddSession;
window.disconnectSession = disconnectSession;
window.reconnectSession = reconnectSession;
window.removeSession = removeSession;
window.updateMainStatus = updateMainStatus;
window.logout = logout;
window.toast = toast;
window.confirmDialog = confirmDialog;
window.closeConfirm = closeConfirm;
