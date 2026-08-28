
    'use strict';

      // ====== PAGE / AUTH GATE ======
      const CURRENT_PAGE = (document.querySelector('meta[name="page"]') || {}).content || null;
      if (CURRENT_PAGE && !localStorage.getItem('chmd_token')) {
        location.href = '/login';
      }
  // ====== STATE ======
    const State = {
      token: localStorage.getItem('chmd_token') || null,
      user: localStorage.getItem('chmd_user') || null,
      socket: null,
      page: CURRENT_PAGE || 'dashboard',
      activeQrSession: null,
      autoReplyEditingId: null,
      schedulerEditingId: null,
      groupEditingJid: null,
      commandCategory: 'all',
      commandPending: new Set(),
      autoReplyPending: new Set(),
      filesError: null,
      lastFleetSync: null,
      data: {
        sessions: [],
        users: [],
        groups: [],
        commands: [],
        autoReply: [],
        scheduler: [],
        files: [],
        settings: {},
        logs: [],
        bcHistory: [],
      },
    };

    document.addEventListener('click', (e) => {
      const item = e.target?.closest?.('.nav-item[data-page]');
      if (!item) return;
      const page = item.dataset.page;
      if (!page) return;
      e.preventDefault();
      if (page === CURRENT_PAGE) {
        const sb = document.getElementById('sidebar');
        const bd = document.getElementById('backdrop');
        if (sb && bd) {
          sb.classList.remove('open');
          bd.classList.remove('open');
        }
        return;
      }
      location.href = '/' + page;
    }, true);

    function normalizeNavLinks() {
      document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
        const page = item.dataset.page;
        if (!page || item.tagName === 'A') {
          if (item.tagName === 'A' && page) item.setAttribute('href', '/' + page);
          return;
        }
        const link = document.createElement('a');
        for (const attr of Array.from(item.attributes)) {
          link.setAttribute(attr.name, attr.value);
        }
        link.setAttribute('href', '/' + page);
        link.innerHTML = item.innerHTML;
        item.replaceWith(link);
      });
    }

    // ====== HTTP ======
    let _inflight = 0;
    function _progressStart() {
      _inflight++;
      const bar = document.getElementById('topProgress');
      if (!bar) return;
      bar.classList.add('active');
      bar.style.width = '40%';
      setTimeout(() => { if (_inflight > 0) bar.style.width = '75%'; }, 250);
    }
    function _progressEnd() {
      _inflight = Math.max(0, _inflight - 1);
      if (_inflight > 0) return;
      const bar = document.getElementById('topProgress');
      if (!bar) return;
      bar.style.width = '100%';
      setTimeout(() => { if (_inflight === 0) { bar.classList.remove('active'); bar.style.width = '0%'; } }, 220);
    }

    async function api(path, opts = {}) {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (State.token) headers.Authorization = 'Bearer ' + State.token;
      const silent = opts.silent === true;
      if (!silent) _progressStart();
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs || 30000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(path, { ...opts, headers, signal: controller.signal });
        if (res.status === 401) { logout(); throw new Error('Session expired — please sign in again'); }
        const ct = res.headers.get('content-type') || '';
        const body = ct.includes('json') ? await res.json() : await res.text();
        if (!res.ok) {
          const msg = (body && body.error) || res.statusText || ('HTTP ' + res.status);
          const err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return body;
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('Request timed out — please try again');
        throw e;
      } finally {
        clearTimeout(timer);
        if (!silent) _progressEnd();
      }
    }

    // Wrap an async action with button loading + error toast.
    async function withButton(btn, fn) {
      const el = (typeof btn === 'string') ? document.getElementById(btn) : btn;
      const orig = el && el.getAttribute('data-loading');
      if (el) el.setAttribute('data-loading', '1');
      try { return await fn(); }
      catch (e) { toast(e.message || 'Something went wrong', 'error'); throw e; }
      finally { if (el) { if (orig) el.setAttribute('data-loading', orig); else el.removeAttribute('data-loading'); } }
    }

    // Pretty confirm dialog (Promise-based replacement for native confirm)
    function confirmDialog(message, { title = 'Are you sure?', okText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
      return new Promise((resolve) => {
        const overlay = byId('confirmOverlay');
        const okBtn = byId('confirmOkBtn');
        const cancelBtn = byId('confirmCancelBtn');
        const titleEl = byId('confirmTitle');
        const msgEl = byId('confirmMsg');
        if (!overlay || !okBtn || !cancelBtn || !titleEl || !msgEl) {
          resolve(window.confirm(message));
          return;
        }
        titleEl.textContent = title;
        msgEl.textContent = message;
        okBtn.textContent = okText;
        cancelBtn.textContent = cancelText;
        okBtn.classList.toggle('danger', !!danger);
        const cleanup = (val) => {
          overlay.classList.remove('show');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          overlay.removeEventListener('click', onBackdrop);
          document.removeEventListener('keydown', onKey);
          resolve(val);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onBackdrop = (e) => { if (e.target === overlay) cleanup(false); };
        const onKey = (e) => { if (e.key === 'Escape') cleanup(false); else if (e.key === 'Enter') cleanup(true); };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
        overlay.classList.add('show');
        setTimeout(() => okBtn.focus(), 60);
      });
    }

    // Global error surfacing — no more silent failures.
    window.addEventListener('unhandledrejection', (e) => {
      try {
        const msg = (e.reason && (e.reason.message || e.reason.toString())) || 'Unexpected error';
        if (msg && msg !== 'Unauthorized' && msg !== 'Session expired — please sign in again') {
          toast(msg, 'error');
        }
      } catch { }
    });
    window.addEventListener('error', (e) => {
      try { if (e && e.message) toast(e.message, 'error'); } catch { }
    });

    // ====== TOAST ======
    function toast(message, type = 'info') {
      const wrap = document.getElementById('toasts');
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      const icons = {
        success: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
        error: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4M12 16h.01',
        info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
      };
      el.innerHTML = `<i class="ic" style="-webkit-mask-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22currentColor%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22${encodeURIComponent(icons[type] || icons.info)}%22/></svg>')"></i><span>${escapeHtml(message)}</span>`;
      wrap.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 300); }, 3500);
    }

    function escapeHtml(s) { return String(s ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function fmtUptime(sec) {
      sec = parseInt(sec) || 0;
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    }
    function fmtTime(t) {
      if (!t) return '--';
      const d = new Date(t);
      if (isNaN(d.getTime())) return '--';
      return d.toLocaleString();
    }
    function toLocalDateTimeInput(value) {
      if (!value) return '';
      const date = new Date(value);
      if (isNaN(date)) return '';
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    function normalizeSessionId(value) {
      const raw = String(value || '').trim();
      if (!raw || raw === 'main' || raw === '__main__') return '__main__';
      return raw;
    }
    function uniqueSessions() {
      const list = [];
      const seen = new Set();
      (State.data.sessions || []).forEach((session) => {
        const id = normalizeSessionId(session.id);
        if (seen.has(id)) return;
        seen.add(id);
        list.push({
          id,
          label: id === '__main__' ? 'Main Bot' : (session.label || session.id),
          status: session.status || 'Unknown',
          connected: session.status === 'Connected',
        });
      });
      if (!seen.has('__main__')) {
        list.unshift({ id: '__main__', label: 'Main Bot', status: 'Disconnected', connected: false });
      }
      return list;
    }
    function parseRecipientList(value) {
      return String(value || '').split(/[\n,]/).map(v => v.trim()).filter(Boolean);
    }
    function byId(id) {
      return document.getElementById(id);
    }
    function setText(id, value) {
      const el = byId(id);
      if (!el) return false;
      el.textContent = value;
      return true;
    }
    function setWidth(id, value) {
      const el = byId(id);
      if (!el) return false;
      el.style.width = value;
      return true;
    }

    // ====== AUTH ======
    async function login(e) {
      e?.preventDefault?.();
      const userInput = byId('loginUser');
      const passInput = byId('loginPass');
      const err = byId('loginErr');
      const btn = byId('loginBtn');
      if (!userInput || !passInput || !btn) return;
      const u = userInput.value.trim();
      const p = passInput.value;
      if (err) err.textContent = '';
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in...';
      try {
        const r = await fetch('/bot-api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Login failed');
        State.token = data.token; State.user = data.username;
        localStorage.setItem('chmd_token', data.token);
        localStorage.setItem('chmd_user', data.username);
        location.href = '/dashboard';
      } catch (e) { if (err) err.textContent = e.message; }
      finally { btn.disabled = false; btn.textContent = 'Sign In'; }
    }

    function logout() {
        State.token = null; State.user = null;
        localStorage.removeItem('chmd_token'); localStorage.removeItem('chmd_user');
        if (State.socket) { try { State.socket.disconnect(); } catch { } State.socket = null; }
        location.href = '/login';
      }

    // ====== INIT / NAV ======
    function ensureAiEngineNav() {
        const nav = document.querySelector('.sb-nav');
        if (!nav || nav.querySelector('[data-page="aiengine"]')) return;
        const anchor = nav.querySelector('[data-page="broadcast"]');
        const item = document.createElement('a');
        item.className = 'nav-item';
        item.dataset.page = 'aiengine';
        item.href = '/aiengine';
        item.innerHTML = `<i class="ic" style="-webkit-mask-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22currentColor%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M12 2a5 5 0 0 1 5 5v1h1a4 4 0 0 1 0 8h-1v1a5 5 0 0 1-10 0v-1H6a4 4 0 0 1 0-8h1V7a5 5 0 0 1 5-5z%22/><path d=%22M9 9h.01M15 9h.01M10 14c1.2.8 2.8.8 4 0%22/></svg>')"></i><span>AI Engine</span>`;
        if (anchor) nav.insertBefore(item, anchor);
        else nav.appendChild(item);
        if (CURRENT_PAGE) {
          nav.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === CURRENT_PAGE));
        }
    }



    function activateCurrentPage() {
        if (!CURRENT_PAGE) return;
        document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
        const page = byId('page-' + CURRENT_PAGE);
        if (page) page.classList.add('active');
    }

    function enterApp() {
        const app = byId('app');
        if (app) app.style.display = 'block';
        ensureAiEngineNav();
        activateCurrentPage();
        const fu = document.getElementById('footUser'); if (fu) fu.textContent = State.user || 'admin';
        const fa = document.getElementById('footAvatar'); if (fa) fa.textContent = (State.user || 'A').charAt(0).toUpperCase();
        setupSocket();
        loadStats();
        setInterval(loadStats, 7000);
        const loaders = {
          dashboard: typeof loadLogs === 'function' ? loadLogs : null,
          sessions: typeof loadSessions === 'function' ? loadSessions : null,
          users: typeof loadSessions === 'function' ? loadSessions : null,
          groups: typeof loadGroups === 'function' ? loadGroups : null,
          commands: typeof loadCommands === 'function' ? loadCommands : null,
          aiengine: typeof loadAiEngine === 'function' ? loadAiEngine : null,
          autoreply: typeof loadAutoReply === 'function' ? loadAutoReply : null,
          scheduler: typeof loadScheduler === 'function' ? loadScheduler : null,
          users_db: typeof loadUsers === 'function' ? loadUsers : null,
          files: typeof loadFiles === 'function' ? loadFiles : null,
          settings: typeof loadSettings === 'function' ? loadSettings : null,
          logs: typeof loadLogs === 'function' ? loadLogs : null,
          broadcast: typeof loadBroadcastPage === 'function' ? loadBroadcastPage : null,
        };
        if (CURRENT_PAGE && loaders[CURRENT_PAGE]) loaders[CURRENT_PAGE]();
      }

    function navigate(page) {
        if (!page) return;
        if (page === CURRENT_PAGE) { toggleSidebar(false); return; }
        location.href = '/' + page;
      }

    function toggleSidebar(open) {
      const sb = document.getElementById('sidebar'), bd = document.getElementById('backdrop');
      if (open === undefined) open = !sb.classList.contains('open');
      sb.classList.toggle('open', open); bd.classList.toggle('open', open);
    }

    // ====== SOCKET ======
    function setupSocket() {
      if (State.socket) return;
      State.socket = io({
        transports: ['websocket', 'polling'],
        auth: { token: State.token ? `Bearer ${State.token}` : '' }
      });
      State.socket.on('connect_error', (error) => {
        const message = String(error?.message || 'Socket connection failed');
        if (/token|auth/i.test(message)) {
          toast('Session expired. Sign in again.', 'error');
          logout();
          return;
        }
        toast(message, 'error');
      });
      State.socket.on('update', (d) => {
        if (d.status) updateMainStatus(d.status, d.number);
        if (State.activeQrSession === '__main__' && d.pairCode) {
          showPair('__main__', d.pairCode);
        }
      });
      State.socket.on('log', (entry) => {
        State.data.logs.push(entry);
        if (State.data.logs.length > 500) State.data.logs.shift();
        appendLogLine(entry);
      });
      State.socket.on('qr', (qr) => {
        if (State.activeQrSession === '__main__') {
          const img = document.getElementById('qrModalImg');
          img.innerHTML = `<img src="${qr}" alt="QR"/>`;
        }
      });
      State.socket.on('session:qr', (d) => {
        if (State.activeQrSession === d.id) {
          const img = document.getElementById('qrModalImg');
          img.innerHTML = `<img src="${d.qr}" alt="QR"/>`;
        }
        if (State.page === 'sessions') loadSessions();
      });
      State.socket.on('session:paircode', (d) => {
        if (State.activeQrSession === d.id) {
          showPair(d.id, d.code);
        }
        toast('Pair code ready for ' + d.id, 'success');
      });
      State.socket.on('session:update', (d) => {
        if (d?.pairCodeError) toast(d.pairCodeError, 'error');
        const merged = upsertSession(d);
        if (State.activeConfigSession && normalizeSessionId(d?.id) === normalizeSessionId(State.activeConfigSession) && merged) syncBotSettingsModal(merged);
        if (State.page === 'users') renderUsersPage();
        if (State.page === 'sessions') renderSessions();
        syncSchedulerForm();
        syncBroadcastForm();
      });
      State.socket.on('session:removed', ({ id }) => {
        if (!id) return;
        removeSessionFromState(id);
        if (normalizeSessionId(State.activeConfigSession) === normalizeSessionId(id)) closeModal('botSettingsModal');
        if (State.activeQrSession === id) closeModal('qrModal');
        if (State.page === 'sessions') renderSessions();
        if (State.page === 'users') renderUsersPage();
        syncSchedulerForm();
        syncBroadcastForm();
      });
      State.socket.on('settings:update', (s) => {
        State.data.settings = { ...(State.data.settings || {}), ...(s || {}) };
        const active = State.data.sessions.find(x => x.id === State.activeConfigSession);
        if (active) syncBotSettingsModal(active);
        if (State.page === 'users') renderUsersPage();
        if (State.page === 'settings') loadSettings();
      });
      State.socket.on('scheduler:update', (item) => {
        if (!item?.id) return;
        upsertSchedulerItem(item);
        if (State.schedulerEditingId === item.id && (item.sent || item.failed)) {
          resetSchedulerForm();
        }
        if (State.page === 'scheduler') {
          renderScheduler();
          updateSchedulerPreview();
        }
      });
      State.socket.on('scheduler:removed', ({ id }) => {
        if (!id) return;
        removeSchedulerItemFromState(id);
        if (State.schedulerEditingId === id) {
          resetSchedulerForm();
        }
        if (State.page === 'scheduler') {
          renderScheduler();
          updateSchedulerPreview();
        }
      });
      State.socket.on('user:update', (user) => {
        if (!user?.jid) return;
        const updated = upsertManagedUser(user);
        const activeUserJid = document.getElementById('editUserJid')?.value;
        if (activeUserJid && updated && (updated.jid === activeUserJid || getManagedUserKey(updated) === activeUserJid)) {
          editUser(activeUserJid);
        }
        if (State.page === 'users_db') {
          renderUsersStats_v2();
          renderUsers();
        }
      });
      State.socket.on('user:removed', ({ jid }) => {
        if (!jid) return;
        removeManagedUser(jid);
        const activeUserJid = document.getElementById('editUserJid')?.value;
        if (activeUserJid && activeUserJid === jid) {
          closeModal('userEditModal');
        }
        if (State.page === 'users_db') {
          renderUsersStats_v2();
          renderUsers();
        }
      });
      State.socket.on('group:update', (group) => {
        if (!group?.jid) return;
        const updated = upsertGroupItem(group);
        if (State.groupEditingJid === group.jid && updated) {
          editGroup(group.jid);
        }
        if (State.page === 'groups') {
          renderGroupsStats();
          renderGroups();
        }
      });
      State.socket.on('group:removed', ({ jid }) => {
        if (!jid) return;
        removeGroupFromState(jid);
        if (State.groupEditingJid === jid) {
          resetGroupForm();
        }
        if (State.page === 'groups') {
          renderGroupsStats();
          renderGroups();
        }
      });
      State.socket.on('auto-reply:update', (rule) => {
        if (!rule?.id) return;
        const updated = upsertAutoReplyRule(rule);
        if (State.autoReplyEditingId === rule.id && updated) {
          editAutoReply(rule.id);
        }
        if (State.page === 'autoreply') {
          renderAutoReply();
        }
      });
      State.socket.on('auto-reply:removed', ({ id }) => {
        if (!id) return;
        removeAutoReplyRule(id);
        if (State.autoReplyEditingId === id) {
          resetAutoReplyForm();
        }
        if (State.page === 'autoreply') {
          renderAutoReply();
        }
      });
    }

    function updateMainStatus(status, number) {
      const val = byId('sbValue'), sub = byId('sbSub'), wrap = byId('sbStatus');
      if (!val || !sub || !wrap) return;
      val.textContent = status || 'Offline';
      sub.textContent = number || 'No active link';
      wrap.classList.remove('connected', 'connecting', 'offline');
      if (status === 'Connected') wrap.classList.add('connected');
      else if (status && status.includes('ing')) wrap.classList.add('connecting');
      else wrap.classList.add('offline');
    }

    // ====== STATS / DASHBOARD ======
    async function loadStats() {
      try {
        const s = await api('/bot-api/stats');
        setText('sStatus', s.status || '--');
        setText('sNumber', s.number || 'none');
        setText('sSessions', s.sessionCount ?? 0);
        setText('sUsers', s.userCount ?? 0);
        setText('sBroadcasts', s.broadcastCount ?? 0);
        setText('sCpu', (s.cpuLoad ?? 0) + '%');
        setWidth('sCpuBar', Math.min(100, parseFloat(s.cpuLoad) || 0) + '%');
        setText('sMem', `${s.memUsed} / ${s.memTotal} MB`);
        setWidth('sMemBar', (s.memPercent || 0) + '%');
        setText('sPlatform', s.platform || '--');
        setText('sNode', s.nodeVersion || '--');
        setText('sUptime', fmtUptime(s.uptime));
        setText('topUptime', fmtUptime(s.uptime));
        setText('topMem', (s.memPercent || 0) + '%');
        setText('sNetDown', s.net?.speedRx || '0 B/s');
        setText('sNetUp', s.net?.speedTx || '0 B/s');
        setText('sNetTotalDown', s.net?.totalRx || '0 B');
        setText('sNetTotalUp', s.net?.totalTx || '0 B');
        setText('sFiles', s.fileCount ?? 0);
        setText('sFilesSize', (s.fileSizeMB ?? 0) + ' MB');
        setText('navSessions', s.sessionCount ?? 0);
        updateMainStatus(s.status, s.number);
      } catch (e) { /* silent */ }
    }

    // ====== SESSIONS ======
    async function loadSessions() {
      try {
        const list = await api('/bot-api/sessions');
        State.data.sessions = list;
        State.lastFleetSync = new Date().toISOString();
        updateFleetLastSync();
        renderSessions();
        if (State.page === 'users') {
          renderUsersPage();
        }
        syncSchedulerForm();
        syncBroadcastForm();
      } catch (e) { toast(e.message, 'error'); }
    }

    function updateFleetLastSync() {
      const el = document.getElementById('fleetLastSync');
      if (!el) return;
      el.textContent = State.lastFleetSync ? `Last sync ${fmtTime(State.lastFleetSync)}` : 'Last sync --';
    }

    function renderSessions() {
      const grid = document.getElementById('sessionsGrid');
      if (!grid) return;
      if (!State.data.sessions || !State.data.sessions.length) {
        grid.innerHTML = '<div class="empty-state"><h4>No linked sessions yet</h4><p>Create a new QR or pair-code session to bring another device into the dashboard.</p></div>';
        return;
      }

      grid.innerHTML = State.data.sessions.map(s => {
        const isMain = s.id === '__main__';
        const connected = s.status === 'Connected';
        const paused = (s.status || '').toLowerCase().includes('paused') || s.qrPaused;
        const awaitingPair = s.status === 'Awaiting Pair Code' || !!s.pairCode;
        const label = s.name || (isMain ? 'Main Bot' : `Session ${s.id}`);

        let statusClass = 'gray';
        if (connected) statusClass = 'green';
        else if (paused || s.status === 'Connecting' || s.status === 'Restarting') statusClass = 'amber';
        else if (awaitingPair || s.status === 'Awaiting QR Scan') statusClass = 'blue';

        const badge = `<span class="badge ${statusClass}"><span class="dot"></span>${escapeHtml(s.status || 'Idle')}</span>`;
        const num = s.number ? escapeHtml(s.number) : '<span class="dim">Not linked</span>';

        return `<div class="session-card ${connected ? 'connected' : ''} ${awaitingPair ? 'awaiting-pair' : ''}">
      <div class="head">
        <div class="av" style="background: ${isMain ? 'var(--primary-glow)' : 'rgba(255,255,255,0.05)'}">
          <i class="ic" style="-webkit-mask-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22currentColor%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5%22/></svg>')"></i>
        </div>
        <div class="meta">
          <div class="name">${escapeHtml(label)} ${isMain ? '<span class="badge violet" style="font-size:10px;padding:1px 4px">PRIMARY</span>' : ''}</div>
          <div class="num">${num}</div>
        </div>
      </div>
      <div class="body">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          ${badge}
          ${s.startedAt ? '<span class="dim text-xs">' + fmtTime(s.startedAt) + '</span>' : ''}
        </div>
        ${s.id !== '__main__' ? `<div class="text-xs dim mb-1">ID: <code>${escapeHtml(s.id)}</code></div>` : ''}
        ${s.platform ? `<div class="dim text-xs">Platform: ${escapeHtml(s.platform)}</div>` : ''}
      </div>
      <div class="actions">
        ${!connected ? `
          <button class="btn btn-secondary btn-sm" onclick="openQrFor('${escapeHtml(s.id)}')">QR Code</button>
          <button class="btn btn-secondary btn-sm" onclick="requestPair('${escapeHtml(s.id)}')">Pair Code</button>
        ` : ''}
        ${connected ? `<button class="btn btn-danger btn-sm" onclick="disconnectSession('${escapeHtml(s.id)}')">Disconnect</button>` : ''}
        ${!isMain ? `<button class="btn btn-ghost btn-sm" onclick="removeSession('${escapeHtml(s.id)}')">Remove</button>` : ''}
        ${paused ? `<button class="btn btn-primary btn-sm" onclick="reconnectSession('${escapeHtml(s.id)}')">Retry</button>` : ''}
      </div>
    </div>`;
      }).join('');
    }

    function openAddSession() {
      document.getElementById('newSessId').value = '';
      document.getElementById('newSessPhone').value = '';
      switchAddMode('qr');
      document.getElementById('addSessionModal').classList.add('open');
    }
    function switchAddMode(mode) {
      document.querySelectorAll('#addSessionModal .tab').forEach((t, i) => t.classList.toggle('active', (i === 0) === (mode === 'qr')));
      document.getElementById('addModeQr').classList.toggle('active', mode === 'qr');
      document.getElementById('addModePair').classList.toggle('active', mode === 'pair');
      document.getElementById('addSessionModal').dataset.mode = mode;
    }
    async function confirmAddSession() {
      const id = document.getElementById('newSessId').value.trim();
      const mode = document.getElementById('addSessionModal').dataset.mode || 'qr';
      const phone = document.getElementById('newSessPhone').value.trim();
      if (!id) return toast('Session ID required', 'error');
      if (mode === 'pair' && !phone) return toast('Phone number required for Pair Code', 'error');

      const btn = document.getElementById('confirmAddBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Initializing...';

      try {
        const result = await api('/bot-api/sessions', {
          method: 'POST',
          body: JSON.stringify({ id, pairMode: mode === 'pair', phone })
        });

        closeModal('addSessionModal');
        toast(`Session "${id}" created successfully`, 'success');
        await loadSessions();

        State.activeQrSession = id;
        if (mode === 'qr') {
          setTimeout(() => openQrFor(id), 1000);
        } else {
          showPair(id, 'WAIT');
          document.getElementById('qrModalPairCode').textContent = 'Generating...';
        }
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create Session';
      }
    }

    async function reconnectSession(id) {
      try {
        if (id === '__main__') {
          await api('/bot-api/bot/reconnect', { method: 'POST' });
        } else {
          await api('/bot-api/sessions/' + encodeURIComponent(id) + '/reconnect', { method: 'POST' });
        }
        toast('Reconnecting...', 'success');
        setTimeout(loadSessions, 500);
      } catch (e) { toast(e.message, 'error'); }
    }

    async function openQrFor(id) {
      State.activeQrSession = id;
      document.getElementById('qrModalTitle').textContent = id === '__main__' ? 'Link Main Bot' : 'Link Device - ' + id;
      document.getElementById('qrModalSub').textContent = 'Open WhatsApp -> Linked Devices -> Link a device';
      document.getElementById('qrModalPair').style.display = 'none';
      const img = document.getElementById('qrModalImg');
      img.innerHTML = '<span class="spinner"></span>';
      document.getElementById('qrModal').classList.add('open');
      try {
        const r = await api('/bot-api/sessions/' + encodeURIComponent(id) + '/qr');
        img.innerHTML = `<img src="${r.qrCode}" alt="QR"/>`;
      } catch (e) {
        img.innerHTML = `<div class="empty"><span>${escapeHtml(e.message)}</span><button class="btn btn-ghost btn-sm" onclick="refreshActiveQr()">Try Again</button></div>`;
      }
    }
    async function refreshActiveQr() {
      if (State.activeQrSession) openQrFor(State.activeQrSession);
    }
    async function requestPair(id) {
      const session = (State.data.sessions || []).find((entry) => entry.id === id);
      if (session?.pairCode) {
        showPair(id, session.pairCode);
        return;
      }
      if (session?.status === 'Awaiting Pair Code') {
        showPair(id, 'WAIT');
        document.getElementById('qrModalPairCode').textContent = 'Generating...';
        toast('Pair code is still being prepared', 'success');
        return;
      }
      const phone = prompt('Enter phone number as 07XXXXXXXX or 947XXXXXXXX (no spaces or symbols):');
      if (!phone) return;
      showPair(id, 'WAIT');
      document.getElementById('qrModalPairCode').textContent = 'Generating...';
      try {
        const r = await api('/bot-api/sessions/' + encodeURIComponent(id) + '/paircode', { method: 'POST', body: JSON.stringify({ phone }) });
        if (r.code) showPair(id, r.code);
      } catch (e) { toast(e.message, 'error'); closeModal('qrModal'); }
    }
    function showPair(id, code) {
      State.activeQrSession = id;
      const session = (State.data.sessions || []).find((entry) => entry.id === id);
      const label = session?.isMain ? 'Main Bot' : (session?.label || id);
      document.getElementById('qrModalTitle').textContent = 'Pairing Code - ' + label;
      document.getElementById('qrModalSub').textContent = 'Enter this code in WhatsApp on your phone';
      document.getElementById('qrModalImg').innerHTML = '';
      document.getElementById('qrModalImg').style.display = 'none';
      document.getElementById('qrModalPair').style.display = 'block';
      document.getElementById('qrModalPairCode').textContent = (code || '').replace(/(.{4})/g, '$1 ').trim();
      document.getElementById('qrModal').classList.add('open');
      setTimeout(() => { document.getElementById('qrModalImg').style.display = ''; }, 0);
    }
    async function disconnectSession(id) {
      if (!await confirmDialog('Disconnect this session?', { okText: 'Disconnect', danger: true })) return false;
      try { await api('/bot-api/sessions/' + encodeURIComponent(id) + '/disconnect', { method: 'POST' }); toast('Disconnected', 'success'); loadSessions(); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    }
    async function removeSession(id) {
      if (!await confirmDialog('Remove this session permanently? This cannot be undone.', { title: 'Remove session', okText: 'Remove', danger: true })) return false;
      try { await api('/bot-api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Removed', 'success'); loadSessions(); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    }

    // ====== USERS ======
    function normalizeDigits(value) {
      return String(value || '').replace(/\D/g, '');
    }
    function normalizeUserJidInput(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (raw.includes('@')) return raw.toLowerCase();
      const digits = normalizeDigits(raw);
      return digits ? `${digits}@s.whatsapp.net` : '';
    }
    function normalizeGroupJidInput(value) {
      const raw = String(value || '').trim();
      if (!raw) return raw.toLowerCase();
      if (raw.includes('@')) return raw.toLowerCase();
      const digits = normalizeDigits(raw);
      return digits ? `${digits}@g.us` : '';
    }
    function renderUsersStats() {
      const users = State.data.users || [];
      const premium = users.filter((user) => user.premium).length;
      const disabled = users.filter((user) => user.banned).length;
      const standard = Math.max(users.length - premium, 0);
      const wrap = document.getElementById('usersStats');
      if (!wrap) return;
      wrap.innerHTML = `
    <div class="cmd-stat">
      <div class="k">Users</div>
      <div class="v">${users.length}</div>
      <div class="s">Saved user records that can be promoted, disabled, or edited.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Premium</div>
      <div class="v">${premium}</div>
      <div class="s">${standard} users are still on the normal tier.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Disabled</div>
      <div class="v">${disabled}</div>
      <div class="s">Disabled users are blocked through the same moderation route as bans.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Premium Access</div>
      <div class="v">${premium ? 'Unlimited' : 'Locked'}</div>
      <div class="s">${premium ? `${premium} premium users currently bypass wallet limits from the dashboard.` : 'Enable premium on a user to unlock unlimited access.'}</div>
    </div>`;
    }
    function getFleetViewState() {
      const q = (document.getElementById('usersSearch')?.value || '').trim().toLowerCase();
      const filter = document.getElementById('fleetFilter')?.value || 'all';
      const sort = document.getElementById('fleetSort')?.value || 'status';
      return { q, filter, sort };
    }
    function isSessionConnected(session) {
      return String(session?.status || '').toLowerCase() === 'connected';
    }
    function isSessionTransition(session) {
      if (isSessionConnected(session)) return false;
      const status = String(session?.status || '').toLowerCase();
      return /(await|pair|scan|connect|restart|reconnect|initial)/.test(status);
    }
    function getSessionAgeSeconds(session) {
      const startedAt = session?.startedAt || session?.connectedAt || null;
      if (!startedAt) return 0;
      const stamp = new Date(startedAt).getTime();
      if (!Number.isFinite(stamp)) return 0;
      return Math.max(Math.floor((Date.now() - stamp) / 1000), 0);
    }
    function sessionStatusRank(session) {
      if (isSessionConnected(session)) return 0;
      if (isSessionTransition(session)) return 1;
      return 2;
    }
    function matchesFleetFilter(session, filter) {
      if (filter === 'connected') return isSessionConnected(session);
      if (filter === 'transition') return isSessionTransition(session);
      if (filter === 'offline') return !isSessionConnected(session) && !isSessionTransition(session);
      if (filter === 'private') return String(session?.workMode || '').toLowerCase() === 'private';
      if (filter === 'main') return session?.id === '__main__';
      return true;
    }
    function renderFleetFilterChips(counters, activeFilter) {
      const chipWrap = document.getElementById('fleetFilterChips');
      if (!chipWrap) return;
      const chips = [
        { key: 'all', label: 'All' },
        { key: 'connected', label: 'Connected' },
        { key: 'transition', label: 'Transition' },
        { key: 'offline', label: 'Offline' },
        { key: 'private', label: 'Private' },
        { key: 'main', label: 'Main' },
      ];
      chipWrap.innerHTML = chips.map((chip) => `
        <div class="fleet-chip ${activeFilter === chip.key ? 'active' : ''}" onclick="setFleetFilter('${chip.key}')">
          ${chip.label} <span class="count">${counters[chip.key] || 0}</span>
        </div>
      `).join('');
    }
    function setFleetFilter(filter) {
      const select = document.getElementById('fleetFilter');
      if (select) select.value = filter;
      renderUsersPage();
    }
    function renderManagedUsers() {
      const tb = document.getElementById('usersTable');
      const statWrap = document.getElementById('fleetStats');
      if (!tb) return;

      const view = getFleetViewState();
      const allSessions = State.data.sessions || [];
      const counters = {
        all: allSessions.length,
        connected: allSessions.filter(isSessionConnected).length,
        transition: allSessions.filter(isSessionTransition).length,
        offline: allSessions.filter((s) => !isSessionConnected(s) && !isSessionTransition(s)).length,
        private: allSessions.filter((s) => String(s.workMode || '').toLowerCase() === 'private').length,
        main: allSessions.filter((s) => s.id === '__main__').length,
      };
      renderFleetFilterChips(counters, view.filter);

      const list = allSessions.filter((s) => {
        const haystack = [s.name, s.id, s.number, s.owner, s.workMode].filter(Boolean).join(' ').toLowerCase();
        const queryMatch = !view.q || haystack.includes(view.q);
        return queryMatch && matchesFleetFilter(s, view.filter);
      });

      if (view.sort === 'name') {
        list.sort((a, b) => String(a.name || a.id || '').localeCompare(String(b.name || b.id || '')));
      } else if (view.sort === 'age') {
        list.sort((a, b) => getSessionAgeSeconds(b) - getSessionAgeSeconds(a));
      } else {
        list.sort((a, b) => {
          const rank = sessionStatusRank(a) - sessionStatusRank(b);
          if (rank !== 0) return rank;
          return String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''));
        });
      }

      if (statWrap) {
        const totalCount = allSessions.length;
        const liveCoverage = totalCount ? Math.round((counters.connected / totalCount) * 100) : 0;
        const autoStatusCount = allSessions.filter((s) => s.autoStatus !== false).length;
        const privateCount = counters.private;
        const totalMsgs = allSessions.reduce((acc, s) => acc + (s.processedCount || 0), 0);
        const totalCmds = allSessions.reduce((acc, s) => acc + (s.commandsCount || 0), 0);
        statWrap.innerHTML = `
      <div class="stat-pro-card">
        <div class="lbl">Fleet Live</div>
        <div class="val good">${counters.connected} / ${totalCount}</div>
        <div class="text-xs dim">${liveCoverage}% currently connected</div>
      </div>
      <div class="stat-pro-card">
        <div class="lbl">Global Throughput</div>
        <div class="val info">${totalMsgs.toLocaleString()}</div>
        <div class="text-xs dim">Aggregate messages processed</div>
      </div>
      <div class="stat-pro-card">
        <div class="lbl">Command Volume</div>
        <div class="val violet">${totalCmds.toLocaleString()}</div>
        <div class="text-xs dim">Fleet-wide command executions</div>
      </div>
      <div class="stat-pro-card">
        <div class="lbl">Auto Status</div>
        <div class="val">${autoStatusCount}</div>
        <div class="text-xs dim">${totalCount ? Math.round((autoStatusCount / totalCount) * 100) : 0}% of fleet automation-ready</div>
      </div>
    `;
      }

      if (!list.length) {
        const msg = view.q
          ? 'No bots matched the current search and filters.'
          : view.filter !== 'all'
            ? 'No bots are currently in the selected fleet state.'
            : 'No bots detected in the fleet registry.';
        tb.innerHTML = `<tr><td colspan="5" class="empty-row">${msg}</td></tr>`;
        return;
      }

      tb.innerHTML = list.map((s) => {
        const isMain = s.id === '__main__';
        const connected = isSessionConnected(s);
        const transition = isSessionTransition(s);
        const label = s.name || (isMain ? 'Main Controller' : `Sub-Bot ${s.id}`);
        const pulseCls = connected ? 'online' : (transition ? 'warming' : 'offline');
        const statusColor = connected ? '#86efac' : (transition ? '#fcd34d' : 'var(--txt-2)');
        const uptimeSec = getSessionAgeSeconds(s);
        const workMode = String(s.workMode || 'public').toLowerCase();
        const disabledModules = Array.isArray(s.disabledModules) ? s.disabledModules.length : 0;
        const encodedId = encodeURIComponent(s.id);
        const safeId = escapeHtml(s.id);

        const rowActions = [
          `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); openBotSettings(decodeURIComponent('${encodedId}'))">Manage</button>`,
        ];
        if (connected) {
          rowActions.push(`<button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); disconnectSession(decodeURIComponent('${encodedId}'))">Disconnect</button>`);
        } else {
          rowActions.push(`<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openQrFor(decodeURIComponent('${encodedId}'))">QR</button>`);
          rowActions.push(`<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); requestPair(decodeURIComponent('${encodedId}'))">Pair</button>`);
          if (transition) {
            rowActions.push(`<button class="btn btn-warn btn-sm" onclick="event.stopPropagation(); reconnectSession(decodeURIComponent('${encodedId}'))">Retry</button>`);
          }
        }
        if (!isMain) {
          rowActions.push(`<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); removeSession(decodeURIComponent('${encodedId}'))">Remove</button>`);
        }

        return `<tr onclick="openBotSettings(decodeURIComponent('${encodedId}'))" style="cursor:pointer">
      <td data-label="Bot Identity" style="padding-left:20px">
        <div class="bot-id-cell">
          <div class="bot-id-main">
            <div class="pulse-dot ${pulseCls}"></div>
            <strong>${escapeHtml(label)}</strong>
            ${isMain ? '<span class="badge violet">PRIMARY</span>' : '<span class="badge gray">AUX</span>'}
          </div>
          <div class="bot-id-sub">
            <i class="ic" style="width:12px;height:12px;opacity:0.5;-webkit-mask-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22currentColor%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z%22/></svg>')"></i>
            <span class="mono">${escapeHtml(s.number || 'No link')}</span>
            ${!isMain ? `<span class="mono dim">ID ${safeId}</span>` : ''}
          </div>
        </div>
      </td>
      <td data-label="Connection">
        <div class="health-indicator">
          <span style="color:${statusColor}">${escapeHtml(s.status || 'Offline')}</span>
          <span class="dim">•</span>
          <span class="dim" style="font-size:11px">${uptimeSec > 0 ? fmtUptime(uptimeSec) : 'No uptime'}</span>
        </div>
      </td>
      <td data-label="Runtime">
        <div class="metrics-row">
          <div class="metric-pill">
            <div class="lbl">Msgs</div>
            <div class="val" style="color:var(--brand)">${s.processedCount || 0}</div>
          </div>
          <div class="metric-pill">
            <div class="lbl">Cmds</div>
            <div class="val" style="color:#10b981">${s.commandsCount || 0}</div>
          </div>
        </div>
      </td>
      <td data-label="Owner">
        <div style="display:flex; flex-direction:column; gap:4px">
          <div style="display:flex; align-items:center; gap:6px">
            <span class="badge ${workMode === 'private' ? 'violet' : workMode === 'self' ? 'amber' : 'blue'}" style="font-size:9px">${workMode.toUpperCase()}</span>
            ${disabledModules > 0 ? `<span class="badge red" style="font-size:9px">${disabledModules} OFF</span>` : ''}
          </div>
          <div class="text-xs dim mono" style="font-size:10px">${escapeHtml(s.owner || 'System Admin')}</div>
        </div>
      </td>
      <td data-label="Operations" style="text-align:right; padding-right:15px">
        <div class="actions" style="justify-content:flex-end">
          ${rowActions.join('')}
        </div>
      </td>
    </tr>`;
      }).join('');
    }

    async function updateBotSettings(id, settings) {
      try {
        await api(`/bot-api/sessions/${encodeURIComponent(id)}/settings`, {
          method: 'POST',
          body: JSON.stringify(settings)
        });
        toast('Settings updated', 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    function findSessionById(id) {
      const target = normalizeSessionId(id);
      return (State.data.sessions || []).find(x => normalizeSessionId(x.id) === target);
    }

    function upsertSession(session) {
      const id = normalizeSessionId(session?.id);
      if (!id) return null;
      const index = State.data.sessions.findIndex((s) => normalizeSessionId(s.id) === id);
      if (index >= 0) State.data.sessions[index] = { ...State.data.sessions[index], ...session, id };
      else State.data.sessions.push({ ...session, id });
      State.data.sessions.sort((a, b) => {
        if (normalizeSessionId(a.id) === '__main__') return -1;
        if (normalizeSessionId(b.id) === '__main__') return 1;
        return String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''));
      });
      return State.data.sessions.find((s) => s.id === session.id);
    }

    function removeSessionFromState(id) {
      const targetId = normalizeSessionId(id);
      State.data.sessions = (State.data.sessions || []).filter((session) => normalizeSessionId(session.id) !== targetId);
    }

    function upsertSchedulerItem(item) {
      if (!item?.id) return null;
      const index = State.data.scheduler.findIndex((entry) => entry.id === item.id);
      if (index >= 0) State.data.scheduler[index] = { ...State.data.scheduler[index], ...item };
      else State.data.scheduler.push(item);
      State.data.scheduler.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      return State.data.scheduler.find((entry) => entry.id === item.id);
    }

    function removeSchedulerItemFromState(id) {
      State.data.scheduler = (State.data.scheduler || []).filter((entry) => entry.id !== id);
    }

    function getManagedUserKey(user) {
      if (!user) return '';
      return user.realJid || user.jid || '';
    }

    function findManagedUserEntry(jid) {
      const target = String(jid || '').trim();
      return (State.data.users || []).find((entry) => entry.jid === target || entry.realJid === target) || null;
    }

    function upsertManagedUser(user) {
      if (!user?.jid) return null;
      const userKey = getManagedUserKey(user);
      const index = State.data.users.findIndex((entry) => entry.jid === user.jid || getManagedUserKey(entry) === userKey);
      if (index >= 0) State.data.users[index] = { ...State.data.users[index], ...user };
      else State.data.users.push(user);
      State.data.users.sort((a, b) => {
        const ownerDelta = Number(!!b.isOwner) - Number(!!a.isOwner);
        if (ownerDelta) return ownerDelta;
        const premiumDelta = Number(!!b.premium) - Number(!!a.premium);
        if (premiumDelta) return premiumDelta;
        return String(a.pushName || a.number || a.jid).localeCompare(String(b.pushName || b.number || b.jid));
      });
      return State.data.users.find((entry) => entry.jid === user.jid);
    }

    function removeManagedUser(jid) {
      const target = String(jid || '').trim();
      State.data.users = (State.data.users || []).filter((entry) => entry.jid !== target && getManagedUserKey(entry) !== target);
    }

    function upsertGroupItem(group) {
      if (!group?.jid) return null;
      const index = State.data.groups.findIndex((entry) => entry.jid === group.jid);
      if (index >= 0) State.data.groups[index] = { ...State.data.groups[index], ...group };
      else State.data.groups.push(group);
      State.data.groups.sort((a, b) => String(a.name || a.jid).localeCompare(String(b.name || b.jid)));
      return State.data.groups.find((entry) => entry.jid === group.jid);
    }

    function removeGroupFromState(jid) {
      State.data.groups = (State.data.groups || []).filter((entry) => entry.jid !== jid);
    }

    function removeAutoReplyRule(id) {
      State.data.autoReply = (State.data.autoReply || []).filter((entry) => entry.id !== id);
    }

    function setChecked(id, value) {
      const el = document.getElementById(id);
      if (el) el.checked = !!value;
    }

    function titleizeCategory(category) {
      return String(category || '')
        .split(/[_-]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }

    function getAdvancedModules() {
      // Legacy helper kept so other callers (commands page etc.) still compile.
      return BOT_MODULE_DEF.map((m) => ({ key: m.key, label: m.label, desc: m.desc }));
    }

    // ===== BOT SETTINGS MODAL — module-keyed orchestration =====
    // Module-key → command-category map. Module keys are the stable identifiers
    // shown in the Modules tab; categories are what `cmd.category` reports.
    const BOT_MODULE_DEF = [
      { key: 'ai', label: 'AI / Creative', desc: 'AI assistant + creative replies', icon: 'cpu', categories: ['ai', 'creative'] },
      { key: 'automation', label: 'Automation / Auto-Reply', desc: 'Auto-view, auto-react, reminders', icon: 'refresh', categories: ['automation'] },
      { key: 'downloaders', label: 'Downloaders', desc: 'Media download commands', icon: 'download', categories: ['download'] },
      { key: 'search', label: 'Search & Info', desc: 'Web, lookup, info commands', icon: 'search', categories: ['search'] },
      { key: 'group', label: 'Group Admin', desc: 'Group management + moderation', icon: 'users', categories: ['group'] },
      { key: 'user', label: 'User Tools', desc: 'Profile and identity commands', icon: 'user', categories: ['profile'] },
      { key: 'system', label: 'System Tools', desc: 'Menu, ping, settings, sticker maker', icon: 'monitor', categories: ['system', 'sticker', 'settings', 'settings-manager'] },
      { key: 'owner', label: 'Owner Panel', desc: 'Owner-only commands', icon: 'crown', categories: ['owner'] },
      { key: 'economy', label: 'Economy', desc: 'Wallet and economy commands', icon: 'gauge', categories: ['economy'] },
      { key: 'fun', label: 'Fun & Games', desc: 'Entertainment + game commands', icon: 'zap', categories: ['fun', 'games'] },
      { key: 'scheduler', label: 'Scheduler', desc: 'Scheduled message dispatch', icon: 'clock', categories: [] },
      { key: 'broadcast', label: 'Broadcast', desc: 'Mass message campaigns', icon: 'message-square', categories: [] },
      { key: 'files', label: 'Files', desc: 'File storage & retrieval', icon: 'download', categories: [] },
      { key: 'privacy', label: 'Privacy Tools', desc: 'Anti-delete + view-once recovery', icon: 'shield', categories: [] },
      { key: 'status', label: 'Status Tools', desc: 'Status auto-view / react', icon: 'eye', categories: ['status'] },
      { key: 'nsfw', label: 'NSFW / Adult Zone', desc: 'NSFW commands — enable at your own risk', icon: 'alert', categories: ['nsfw'], dangerous: true, defaultDisabled: true },
    ];

    const BOT_MODULE_KEYS = BOT_MODULE_DEF.map((m) => m.key);

    function getBotModuleDef() { return BOT_MODULE_DEF; }

    // Inline SVG icons. Match `data-icon` values used in users.html.
    const BOT_ICONS = {
      robot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="13" rx="2"/><path d="M9 10h.01M15 10h.01M9 15h6"/><path d="M12 2v4M5 19v2M19 19v2"/></svg>',
      fingerprint: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12C2 6 6 2 12 2s10 4 10 10v3"/><path d="M6 12a6 6 0 0 1 12 0v6"/><path d="M10 12a2 2 0 0 1 4 0v6"/><path d="M14 18v3"/></svg>',
      phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
      crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 17h20l-2-9-5 4-3-7-3 7-5-4z"/></svg>',
      terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z"/></svg>',
      power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.72 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
      eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
      'message-circle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
      'message-square': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
      cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
      layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
      users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
      zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><line x1="12" y1="20" x2="12.01" y2="20"/><path d="M2 9a15 15 0 0 1 20 0"/></svg>',
      monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
      clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
      alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="14" y1="14" x2="21" y2="14"/><line x1="14" y1="21" x2="21" y2="21"/><line x1="14" y1="17" x2="17" y2="17"/></svg>',
      key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15L19 4l3 3-3 3 2 2-2 2-2-2-1.5 1.5"/></svg>',
      refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      'x-circle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      'at-sign': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>',
      type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
      mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
      'check-circle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
      'phone-off': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2.03v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>',
      'user-minus': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
      'alert-triangle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      'alert-circle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    };

    function botIconSvg(name) {
      return BOT_ICONS[name] || '';
    }

    function paintBotIcons(root) {
      const scope = root || document;
      scope.querySelectorAll('.bot-icon[data-icon]').forEach((el) => {
        if (el.dataset.painted === '1') return;
        el.innerHTML = botIconSvg(el.dataset.icon);
        el.dataset.painted = '1';
      });
    }

    function switchBotTab(tab) {
      document.querySelectorAll('.bot-nav-item').forEach((t) => t.classList.remove('active'));
      document.getElementById(`botNavItem-${tab}`)?.classList.add('active');
      document.querySelectorAll('.bot-tab-section').forEach((c) => (c.style.display = 'none'));
      const target = document.getElementById(`botTab-${tab}`);
      if (target) target.style.display = 'block';
      State.activeBotTab = tab;
      if (tab === 'modules') renderBotModules();
      if (tab === 'health') renderBotHealth();
      if (tab === 'groups') renderBotGroups();
      paintBotIcons(target);
    }

    function setBotInputValue(id, value) {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = value == null ? '' : String(value);
    }

    function getBotInputValue(id) {
      const el = document.getElementById(id);
      if (!el) return undefined;
      if (el.type === 'checkbox') return !!el.checked;
      if (el.type === 'number') {
        const n = parseInt(el.value, 10);
        return Number.isFinite(n) ? n : null;
      }
      return el.value;
    }

    function getActiveBotSession() {
      const id = State.activeConfigSession;
      if (!id) return null;
      return findSessionById(id) || null;
    }

    function getEffective(s, key, fallback) {
      if (!s) return fallback;
      if (s[key] === null || s[key] === undefined) return fallback;
      return s[key];
    }

    function syncBotSettingsModal(s) {
      if (!s) return;
      paintBotIcons();
      const g = State.data.settings || {};
      const isMain = s.id === '__main__';
      const mode = (s.workMode || 'public').toLowerCase();
      const status = s.status || 'Offline';
      const connected = isSessionConnected(s);

      const badge = document.getElementById('botAccessBadge');
      if (badge) {
        badge.textContent = mode.toUpperCase();
        badge.className = `badge ${mode === 'private' ? 'violet' : mode === 'self' ? 'amber' : mode === 'group' ? 'green' : 'blue'}`;
      }
      setText('botSettingsSubtitle', `${s.name || (isMain ? 'Main Bot' : s.id)} · ${s.number || s.id || 'Unlinked'}`);

      const pill = document.getElementById('botStatusPill');
      const pillText = document.getElementById('botStatusPillText');
      if (pill && pillText) {
        pillText.textContent = status;
        pill.className = `bot-status-pill ${connected ? 'is-online' : (status.toLowerCase().includes('await') ? 'is-pending' : 'is-offline')}`;
      }

      // ── General
      setBotInputValue('botGenName', s.name || (isMain ? 'Chathu MD' : ''));
      setBotInputValue('botGenSessionId', s.id || '');
      setBotInputValue('botGenWhatsappNumber', s.number || 'Not linked');
      setBotInputValue('botGenOwner', s.owner || '');
      setBotInputValue('botGenPrefix', s.prefix || '.');
      setBotInputValue('botGenWorkMode', mode);
      setBotInputValue('botGenEnabled', s.botEnabled !== false);
      setBotInputValue('botGenAutoStatus', s.autoStatus !== false);
      setBotInputValue('botGenAlwaysOnline', !!s.alwaysOnline);
      setBotInputValue('botGenAutoBio', !!s.autoBio);
      setBotInputValue('botGenTheme', g.active_theme || 'auto');
      setBotInputValue('botGenMentionReply', s.mentionReply || g.mentionReply || '');

      // ── AI
      setBotInputValue('botAiAutoReply', getEffective(s, 'aiAutoReply', g.aiAutoReply === true));
      setBotInputValue('botAiAutoVoice', getEffective(s, 'aiAutoVoice', g.aiAutoVoice === true));
      setBotInputValue('botAiPersona', s.aiAutoPersona || g.aiAutoPersona || 'friendly');
      setBotInputValue('botAiLang', s.aiAutoLang || g.aiAutoLang || 'auto');
      const aiGroupModeRaw = (s.aiGroupMode || g.aiGroupMode || 'mention').toLowerCase();
      const aiGroupMode = aiGroupModeRaw === 'always' || aiGroupModeRaw === 'reply' ? 'everyone' : aiGroupModeRaw;
      setBotInputValue('botAiGroupMode', ['silent', 'mention', 'everyone'].includes(aiGroupMode) ? aiGroupMode : 'mention');
      setBotInputValue('botAiMaxWords', s.aiMaxWords || g.aiMaxWords || 60);
      setBotInputValue('botAiSystemInstruction', s.aiSystemInstruction || g.aiSystemInstruction || '');

      // ── Automation
      setBotInputValue('botAutoReply', getEffective(s, 'autoReply', true));
      setBotInputValue('botAutoTyping', getEffective(s, 'autoTyping', g.autoTyping !== false));
      setBotInputValue('botAutoRead', getEffective(s, 'autoRead', g.autoRead !== false));
      setBotInputValue('botAutoReact', getEffective(s, 'autoReactStatus', g.autoReactStatus === true));
      setBotInputValue('botAutoRecording', !!s.alwaysRecording);

      // ── Privacy / Anti-Delete
      const ad = (typeof s.antiDelete === 'object' && s.antiDelete) ? s.antiDelete : { enabled: !!s.antiDelete };
      setBotInputValue('botAntiDeleteEnabled', !!ad.enabled);
      setBotInputValue('botAntiViewOnce', !!s.antiViewOnce);
      setBotInputValue('botPrivacyIgnoreGroups', !!(ad?.ignoreGroups || s.privacyIgnoreGroups));
      setBotInputValue('botPrivacyAutoCleanup', !!(s.privacyAutoCleanup ?? ad?.autoCleanup));
      setBotInputValue('botPrivacyMaxStorage', s.privacyMaxStorageMb ?? ad?.maxStorageMb ?? 500);
      setBotInputValue('botAntiCall', !!s.antiCall);
      setBotInputValue('botNsfwFilter', s.nsfwEnabled !== false);
      setBotInputValue('botAntiGroupJoin', !!s.antiGroupJoin);
      const filters = ad?.filters || {};
      setBotInputValue('botAdFilterText', !!filters.text);
      setBotInputValue('botAdFilterImage', !!filters.image);
      setBotInputValue('botAdFilterVideo', !!filters.video);
      setBotInputValue('botAdFilterAudio', !!filters.audio);
      setBotInputValue('botAdFilterSticker', !!filters.sticker);
      setBotInputValue('botAdFilterDoc', !!filters.doc);
      const adTarget = ad?.target === 'owner' ? 'owner' : 'chat';
      const hiddenTargetInput = document.getElementById('botPrivacyAdTarget');
      if (hiddenTargetInput) hiddenTargetInput.value = adTarget;
      
      const chatCard = document.getElementById('botPrivacyTargetChat');
      const ownerCard = document.getElementById('botPrivacyTargetOwner');
      if (chatCard) chatCard.classList.toggle('active', adTarget === 'chat');
      if (ownerCard) ownerCard.classList.toggle('active', adTarget === 'owner');

      renderBotModules();
      renderBotHealth();
      // Lazy-render the rest only when their tab opens; switchBotTab handles it.

      // Attach auto-save listeners to all fields in the modal
      const modal = document.getElementById('botSettingsModal');
      if (modal && !modal.dataset.autosaveAttached) {
        modal.addEventListener('change', (e) => {
          if (e.target.closest('[data-bot-module]')) return; // handled by modules logic
          triggerBotSettingsAutoSave();
        });
        modal.addEventListener('input', (e) => {
          if (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type === 'text') || (e.target.tagName === 'INPUT' && e.target.type === 'number')) {
            triggerBotSettingsAutoSave();
          }
        });
        modal.dataset.autosaveAttached = '1';
      }
    }

    function renderBotModules() {
      const grid = document.getElementById('botModuleGrid');
      if (!grid) return;
      const s = getActiveBotSession();
      const disabled = (s && Array.isArray(s.disabledModules)) ? s.disabledModules : [];
      grid.innerHTML = BOT_MODULE_DEF.map((mod) => {
        const enabled = !disabled.includes(mod.key);
        const icon = botIconSvg(mod.icon || 'layers');
        const dangerCls = mod.dangerous ? ' module-danger' : '';
        return `
          <div class="control-card module-card${dangerCls}${enabled ? ' is-enabled' : ' is-disabled'}">
            <div class="module-card-body">
              <div class="module-icon">${icon}</div>
              <div>
                <div class="label">${escapeHtml(mod.label)}</div>
                <div class="desc">${escapeHtml(mod.desc)}${mod.dangerous ? ' <span class="module-warn">⚠ Dangerous</span>' : ''}</div>
              </div>
            </div>
            <span class="switch">
              <input type="checkbox" data-bot-module="${escapeHtml(mod.key)}" ${enabled ? 'checked' : ''} />
              <span class="slider"></span>
            </span>
          </div>`;
      }).join('');
    }

    function setAllBotModules(enabled) {
      document.querySelectorAll('#botModuleGrid input[data-bot-module]').forEach((el) => {
        el.checked = !!enabled;
        const card = el.closest('.module-card');
        if (card) {
          card.classList.toggle('is-enabled', !!enabled);
          card.classList.toggle('is-disabled', !enabled);
        }
      });
    }

    function collectBotModules() {
      const inputs = document.querySelectorAll('#botModuleGrid input[data-bot-module]');
      const disabled = [];
      inputs.forEach((el) => {
        if (!el.checked) disabled.push(el.dataset.botModule);
      });
      return disabled;
    }

    function collectAntiDeletePayload() {
      const enabled = !!getBotInputValue('botAntiDeleteEnabled');
      const target = getBotInputValue('botPrivacyAdTarget') || 'chat';
      return {
        enabled,
        target,
        ignoreGroups: !!getBotInputValue('botPrivacyIgnoreGroups'),
        autoCleanup: !!getBotInputValue('botPrivacyAutoCleanup'),
        maxStorageMb: getBotInputValue('botPrivacyMaxStorage') || 500,
        filters: {
          text: !!getBotInputValue('botAdFilterText'),
          image: !!getBotInputValue('botAdFilterImage'),
          video: !!getBotInputValue('botAdFilterVideo'),
          audio: !!getBotInputValue('botAdFilterAudio'),
          sticker: !!getBotInputValue('botAdFilterSticker'),
          doc: !!getBotInputValue('botAdFilterDoc'),
        },
      };
    }

    function collectBotSettings(scope) {
      const payload = {};
      if (scope === 'general' || scope === 'all') {
        payload.name = getBotInputValue('botGenName');
        payload.owner = getBotInputValue('botGenOwner');
        payload.prefix = getBotInputValue('botGenPrefix');
        payload.workMode = getBotInputValue('botGenWorkMode');
        payload.botEnabled = !!getBotInputValue('botGenEnabled');
        payload.activeTheme = getBotInputValue('botGenTheme');
      }
      if (scope === 'ai' || scope === 'all') {
        payload.aiAutoReply = !!getBotInputValue('botAiAutoReply');
        payload.aiAutoVoice = !!getBotInputValue('botAiAutoVoice');
        payload.aiAutoPersona = getBotInputValue('botAiPersona');
        payload.aiAutoLang = getBotInputValue('botAiLang');
        payload.aiGroupMode = getBotInputValue('botAiGroupMode');
        payload.aiMaxWords = getBotInputValue('botAiMaxWords') || 60;
        payload.aiSystemInstruction = getBotInputValue('botAiSystemInstruction');
      }
      if (scope === 'automation' || scope === 'all') {
        // Presence & Appearance
        payload.alwaysOnline = !!getBotInputValue('botGenAlwaysOnline');
        payload.autoStatus = !!getBotInputValue('botGenAutoStatus');
        payload.autoBio = !!getBotInputValue('botGenAutoBio');
        payload.autoTyping = !!getBotInputValue('botAutoTyping');
        payload.alwaysRecording = !!getBotInputValue('botAutoRecording');
        
        // Auto Response
        payload.autoReply = !!getBotInputValue('botAutoReply');
        payload.autoRead = !!getBotInputValue('botAutoRead');
        payload.autoReactStatus = !!getBotInputValue('botAutoReact');
        payload.mentionReply = getBotInputValue('botGenMentionReply');

        // Security Automation
        payload.antiCall = !!getBotInputValue('botAntiCall');
        payload.antiGroupJoin = !!getBotInputValue('botAntiGroupJoin');
        payload.nsfwEnabled = !!getBotInputValue('botNsfwFilter');
      }
      if (scope === 'modules' || scope === 'all') {
        payload.disabledModules = collectBotModules();
      }
      if (scope === 'privacy' || scope === 'all') {
        payload.antiDelete = collectAntiDeletePayload();
        payload.antiViewOnce = !!getBotInputValue('botAntiViewOnce');
        payload.privacyAutoCleanup = !!getBotInputValue('botPrivacyAutoCleanup');
        payload.privacyMaxStorageMb = getBotInputValue('botPrivacyMaxStorage') || 500;
      }
      if (scope === 'limits' || scope === 'all') {
        payload.limits = {
          cmdPerMin: 0,
          aiPerMin: 0,
          downloadCooldownSec: 0,
          maxConcurrentDownloads: 10,
          maxFileSizeMb: 2048,
          broadcastDelayMs: 0,
          schedulerDelayMs: 0,
        };
      }
      return payload;
    }

    let botSettingsAutoSaveTimer = null;
    function triggerBotSettingsAutoSave() {
      if (botSettingsAutoSaveTimer) clearTimeout(botSettingsAutoSaveTimer);
      botSettingsAutoSaveTimer = setTimeout(() => {
        saveBotSettings('all', true);
      }, 1000);
    }

    async function saveBotSettings(scope, quiet = false) {
      const id = State.activeConfigSession;
      if (!id) return quiet ? null : toast('Select a bot first', 'error');
      
      const statusEl = document.getElementById('botSettingsAutoSaveStatus');
      if (statusEl) {
        statusEl.innerHTML = '<span class="spinner" style="width:10px;height:10px;border-width:1px"></span><span>Saving...</span>';
        statusEl.style.color = 'var(--txt-3)';
      }

      const payload = collectBotSettings(scope);
      try {
        const res = await api(`/bot-api/sessions/${encodeURIComponent(id)}/settings`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        
        if (statusEl) {
          statusEl.innerHTML = '<i class="bot-icon" data-icon="check-circle" style="width:10px;height:10px"></i><span>All changes saved</span>';
          statusEl.style.color = 'var(--brand)';
          paintBotIcons(statusEl);
        }

        if (res?.session) {
          const updated = upsertSession(res.session);
          if (updated) syncBotSettingsModal(updated);
        }
        if (!quiet) toast(`Saved ${scope === 'all' ? 'settings' : scope}`, 'success');
      } catch (e) {
        const statusEl = document.getElementById('botSettingsAutoSaveStatus');
        if (statusEl) {
          statusEl.innerHTML = '<i class="bot-icon" data-icon="alert-circle" style="width:10px;height:10px"></i><span>Save failed</span>';
          statusEl.style.color = '#ef4444';
          paintBotIcons(statusEl);
        }
        if (!quiet) toast(e.message || 'Failed to save', 'error');
      }
    }

    window.setAdTarget = function(target) {
      const hiddenTargetInput = document.getElementById('botPrivacyAdTarget');
      if (hiddenTargetInput) hiddenTargetInput.value = target;
      
      const chatCard = document.getElementById('botPrivacyTargetChat');
      const ownerCard = document.getElementById('botPrivacyTargetOwner');
      if (chatCard) chatCard.classList.toggle('active', target === 'chat');
      if (ownerCard) ownerCard.classList.toggle('active', target === 'owner');
      saveBotSettings('privacy');
    }

    function fmtRelativeTime(ts) {
      if (!ts) return '--';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '--';
      const diffMs = Date.now() - d.getTime();
      if (diffMs < 0) return d.toLocaleTimeString();
      const sec = Math.floor(diffMs / 1000);
      if (sec < 60) return `${sec}s ago`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h ago`;
      return d.toLocaleString();
    }

    function renderBotHealth() {
      const s = getActiveBotSession();
      if (!s) return;
      setText('botHealthConn', s.status || 'Offline');
      setText('botHealthPhone', s.number || 'Not linked');
      setText('botHealthPlatform', s.platform || (s.id === '__main__' ? 'Main Process' : 'Sub Session'));
      setText('botHealthStartedAt', s.startedAt ? fmtRelativeTime(s.startedAt) : '--');
      setText('botHealthConnectedAt', s.connectedAt ? fmtRelativeTime(s.connectedAt) : (s.startedAt ? fmtRelativeTime(s.startedAt) : '--'));
      setText('botHealthLastError', s.lastError || s.lastErrorMessage || 'None');
      const qrAvail = !!s.qrAvailable;
      setText('botHealthQrStatus', qrAvail ? 'Available' : (s.qrPaused ? 'Paused' : 'Idle'));
      const pair = s.pairCode ? `${s.pairCode}` : (s.pairCodeExpiresAt ? 'Expired' : 'None');
      setText('botHealthPairStatus', pair);
      setText('botHealthProcessed', (s.processedCount || 0).toLocaleString());
      setText('botHealthCommands', (s.commandsCount || 0).toLocaleString());
      setText('botHealthReconnects', (s.reconnectAttempts ?? s.reconnectCount ?? 0).toLocaleString());
    }

    async function refreshBotHealth() {
      try { await loadSessions(); } catch { }
      const s = getActiveBotSession();
      if (s) syncBotSettingsModal(s);
      else renderBotHealth();
    }

    async function renderBotGroups() {
      const list = document.getElementById('botGroupsList');
      if (!list) return;
      const id = State.activeConfigSession;
      if (!id) {
        list.innerHTML = '<div class="empty-state">Select a bot first.</div>';
        return;
      }
      list.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
        const groups = await api(`/bot-api/sessions/${encodeURIComponent(id)}/groups`);
        if (!Array.isArray(groups) || !groups.length) {
          list.innerHTML = '<div class="empty-state">No groups handled by this bot yet.</div>';
          return;
        }
        list.innerHTML = groups.map((g) => {
          const name = escapeHtml(g.name || g.subject || g.jid || 'Unknown');
          const members = g.memberCount ?? g.size ?? '--';
          const features = [];
          if (g.welcome) features.push('Welcome');
          if (g.goodbye) features.push('Goodbye');
          if (g.antiLink) features.push('Anti-Link');
          if (g.aiMode) features.push(`AI: ${g.aiMode}`);
          const badges = features.map((f) => `<span class="badge blue">${escapeHtml(f)}</span>`).join('');
          return `
            <div class="group-row">
              <div class="group-row-main">
                <div class="group-name">${name}</div>
                <div class="group-meta">${escapeHtml(g.jid || '')} · ${members} members</div>
                <div class="group-badges">${badges}</div>
              </div>
              <div class="group-row-actions">
                <button class="btn btn-secondary btn-sm" onclick="setGroupBotPrimary('${escapeHtml(g.jid || '')}')">Set Primary</button>
              </div>
            </div>`;
        }).join('');
      } catch (e) {
        list.innerHTML = `<div class="empty-state">Failed to load groups: ${escapeHtml(e.message || String(e))}</div>`;
      }
    }

    async function setGroupBotPrimary(jid) {
      const id = State.activeConfigSession;
      if (!id || !jid) return;
      try {
        await api('/bot-api/groups/upsert', {
          method: 'POST',
          body: JSON.stringify({ jid, sessionId: id }),
        });
        toast('Primary bot updated', 'success');
        renderBotGroups();
      } catch (e) {
        toast(e.message || 'Failed', 'error');
      }
    }





    async function openBotSettings(id) {
      let s = findSessionById(id);
      if (!s) {
        try { await loadSessions(); s = findSessionById(id); } catch { }
      }
      if (!s) {
        toast('Session data is stale. Sync fleet and try again.', 'error');
        return;
      }
      State.activeConfigSession = s.id;
      if (!State.data.settings || !Object.keys(State.data.settings).length) {
        try { State.data.settings = await api('/bot-api/settings'); } catch { }
      }
      if (!Array.isArray(State.data.commands) || !State.data.commands.length) {
        try { State.data.commands = await api('/bot-api/commands'); } catch { State.data.commands = State.data.commands || []; }
      }
      if (!document.getElementById('botSettingsModal')) {
        toast('Bot settings panel is missing from this page.', 'error');
        return;
      }
      paintBotIcons();
      syncBotSettingsModal(s);
      switchBotTab('general');
      openModal('botSettingsModal');
    }

    async function runBotModalAction(action) {
      const id = State.activeConfigSession;
      if (!id) return toast('Select a bot first', 'error');
      try {
        if (action === 'reconnect') return await reconnectSession(id);
        if (action === 'restart') return await reconnectSession(id);
        if (action === 'qr') { closeModal('botSettingsModal'); return await openQrFor(id); }
        if (action === 'pair') { closeModal('botSettingsModal'); return await requestPair(id); }
        if (action === 'disconnect') {
          // Inner function already handles confirmation.
          const ok = await disconnectSession(id);
          if (ok) closeModal('botSettingsModal');
          return;
        }
        if (action === 'remove') {
          // Inner function already handles confirmation.
          const ok = await removeSession(id);
          if (ok) {
            closeModal('botSettingsModal');
            if (id === '__main__') toast('Main bot session removed. You can now relink.', 'success');
          }
          return;
        }
        if (action === 'logout') {
          if (!await confirmDialog('Log out of WhatsApp and delete saved credentials? You will need to scan QR / pair again.', { okText: 'Logout', danger: true })) return;
          await api(`/bot-api/sessions/${encodeURIComponent(id)}/disconnect`, { method: 'POST' });
          toast('Logged out and credentials deleted', 'success');
          await loadSessions();
          closeModal('botSettingsModal');
          return;
        }
        if (action === 'clearError' || action === 'clearQrPause' || action === 'clearPairCode' || action === 'clearCache' || action === 'syncGroups') {
          await api(`/bot-api/sessions/${encodeURIComponent(id)}/runtime`, {
            method: 'POST',
            body: JSON.stringify({ op: action }),
          });
          await loadSessions();
          const updated = getActiveBotSession();
          if (updated) syncBotSettingsModal(updated);
          toast('Done', 'success');
          return;
        }
        if (action === 'exportInfo') {
          const s = getActiveBotSession();
          if (!s) return;
          const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${s.id}-session-info.json`;
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(url);
          return;
        }
      } catch (e) {
        toast(e.message || 'Action failed', 'error');
      }
    }

    // ── Legacy helpers kept for backwards compat ──
    async function applyBotSetting(key, val) {
      const id = State.activeConfigSession;
      if (!id) return;
      const apiVal = key === 'aiGroupMode' && val === 'reply' ? 'always' : val;
      try {
        const res = await api(`/bot-api/sessions/${encodeURIComponent(id)}/settings`, {
          method: 'POST',
          body: JSON.stringify({ [key]: apiVal }),
        });
        if (res?.session) {
          const updated = upsertSession(res.session);
          if (updated) syncBotSettingsModal(updated);
        }
      } catch (e) { toast(e.message, 'error'); }
    }

    function applyAntiDeleteConfig() { /* no-op shim — replaced by saveBotSettings('privacy') */ }

    async function toggleAdvancedModule(moduleKey, enabled) {
      const id = State.activeConfigSession;
      const s = State.data.sessions.find((x) => x.id === id);
      if (!id || !s) return toast('Select a bot first', 'error');
      const previous = Array.isArray(s.disabledModules) ? [...s.disabledModules] : [];
      const next = enabled ? previous.filter((it) => it !== moduleKey) : [...new Set([...previous, moduleKey])];
      try {
        const res = await api(`/bot-api/sessions/${encodeURIComponent(id)}/settings`, {
          method: 'POST',
          body: JSON.stringify({ disabledModules: next }),
        });
        if (res?.session) {
          const updated = upsertSession(res.session);
          if (updated) syncBotSettingsModal(updated);
        }
      } catch (e) {
        s.disabledModules = previous;
        toast(e.message, 'error');
      }
    }

    async function applyGlobalBotSetting(key, val, inputEl) {
      const previousSettings = { ...(State.data.settings || {}) };
      State.data.settings = { ...previousSettings, [key]: val };
      if (inputEl) inputEl.disabled = true;
      try {
        const res = await api('/bot-api/settings', {
          method: 'POST',
          body: JSON.stringify({
            botName: State.data.settings.botName || State.data.settings.name || document.getElementById('setName')?.value || 'Chathu MD',
            prefix: State.data.settings.prefix || document.getElementById('setPrefix')?.value || '.',
            autoRead: State.data.settings.autoRead !== false,
            autoTyping: State.data.settings.autoTyping !== false,
            nsfwEnabled: State.data.settings.nsfwEnabled !== false,
            workMode: State.data.settings.workMode || document.getElementById('setWorkMode')?.value || 'public',
            autoViewStatus: State.data.settings.autoViewStatus !== false,
            autoReactStatus: State.data.settings.autoReactStatus === true,
          }),
        });
        State.data.settings = res.settings || State.data.settings;
        await loadSettings();
        const s = State.data.sessions.find((x) => x.id === State.activeConfigSession);
        if (s) syncBotSettingsModal(s);
      } catch (e) {
        State.data.settings = previousSettings;
        if (inputEl) inputEl.checked = !!previousSettings[key];
      } finally {
        if (inputEl) inputEl.disabled = false;
      }
    }
    // ===== END BOT SETTINGS =====

    function renderUsersPage() {
      renderManagedUsers();
    }
    async function quickEditUser(jid) {
      const user = State.data.users.find((entry) => entry.jid === jid);
      if (!user) return;
      const nextName = prompt('Display name:', user.pushName || user.number || '');
      if (nextName === null) return;
      let parsedBalance = parseInt(String(user.balance || 0), 10) || 0;
      if (!user.premium) {
        const nextBalance = prompt('Wallet balance:', String(user.balance || 0));
        if (nextBalance === null) return;
        parsedBalance = parseInt(nextBalance, 10) || 0;
      }
      const nextWins = prompt('Wins:', String(user.wins || 0));
      if (nextWins === null) return;
      const nextLosses = prompt('Losses:', String(user.losses || 0));
      if (nextLosses === null) return;
      try {
        const result = await api('/bot-api/users/upsert', {
          method: 'POST',
          body: JSON.stringify({
            jid: user.jid,
            number: user.number,
            pushName: nextName.trim(),
            balance: parsedBalance,
            wins: parseInt(nextWins, 10) || 0,
            losses: parseInt(nextLosses, 10) || 0,
            premium: !!user.premium,
            banned: !!user.banned,
          })
        });
        if (result?.user) upsertManagedUser(result.user);
        renderUsers();
        toast('User updated', 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    async function loadUsers() {
      try {
        State.data.users = await api('/bot-api/users');
        renderUsersStats_v2();
        renderUsers();
      }
      catch (e) { toast(e.message, 'error'); }
    }
    function renderUsersStats_v2() {
      // Stats removed as requested
    }
    function renderUsers() {
      const q = (document.getElementById('usersDbSearch')?.value || '').toLowerCase();
      const list = State.data.users.filter(u => {
        return !q
          || u.jid.toLowerCase().includes(q)
          || (u.pushName || '').toLowerCase().includes(q)
          || (u.number || '').includes(q);
      });

      // Update Mini Stats
      setText('statTotalUsers', list.length);
      setText('statOwnerUsers', list.filter(u => u.isOwner).length);
      setText('statActiveUsers', list.filter(u => u.lastSeen && (Date.now() - new Date(u.lastSeen).getTime() < 1000 * 60 * 60)).length);

      const tb = document.getElementById('usersDbTable');
      if (!tb) return;
      if (!list.length) {
        tb.innerHTML = '<tr><td colspan="5" class="empty-row">No matching user records found in database.</td></tr>';
        return;
      }
      tb.innerHTML = list.map(u => {
        const initials = (u.pushName || 'U').charAt(0).toUpperCase();
        const lastSeenDate = u.lastSeen ? new Date(u.lastSeen) : null;
        const isActive = lastSeenDate && (Date.now() - lastSeenDate.getTime() < 1000 * 60 * 10); // 10 mins

        const joinedDate = u.joinedAt ? new Date(u.joinedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';

        return `
        <tr style="border-bottom: 1px solid var(--line); transition: all 0.3s ease">
          <td style="padding: 16px 20px">
            <div class="user-id-cell">
              <div class="user-avatar ${u.isOwner ? 'owner' : ''}" style="width:44px; height:44px; font-size:1.1rem; border-radius:14px; background: ${u.isOwner ? 'var(--grad-accent)' : 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)'}">
                ${initials}
              </div>
              <div class="entity-meta">
                <div style="display:flex; align-items:center; gap:8px">
                  <strong style="font-size:1.05rem; letter-spacing:-0.01em; color: var(--txt)">${escapeHtml(u.pushName || 'User')}</strong>
                  ${u.isOwner ? '<i class="ic" style="width:14px; height:14px; color:var(--warn); -webkit-mask-image:url(\'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22currentColor%22><path d=%22M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z%22/></svg>\')"></i>' : ''}
                </div>
                <div class="user-activity" style="margin-top: 4px; opacity: 0.7">
                  <div class="activity-dot ${isActive ? 'active' : ''}"></div>
                  <span class="mono" style="font-size: 0.75rem">${escapeHtml(u.jid)}</span>
                </div>
              </div>
            </div>
          </td>
          <td style="padding: 16px 20px">
            <div style="display:flex; flex-direction:column; gap:4px">
              <span class="money-pill" style="padding: 6px 12px; border-radius: 10px; font-size: 0.9rem; background: ${(u.isOwner || u.premium) ? 'rgba(124, 58, 237, 0.12)' : 'rgba(0, 255, 136, 0.08)'}; border-color: ${(u.isOwner || u.premium) ? 'rgba(124, 58, 237, 0.25)' : 'rgba(0, 255, 136, 0.15)'}; color: ${(u.isOwner || u.premium) ? 'var(--accent-2)' : 'var(--brand)'}">
                <span style="opacity:0.5; font-size:0.65rem; margin-right:4px; font-weight:800">DRM</span>
                ${(u.isOwner || u.premium) ? 'UNLIMITED' : (u.balance || 0).toLocaleString()}
              </span>
              <div style="font-size: 0.65rem; color: var(--txt-3); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding-left: 4px">
                Joined ${joinedDate}
              </div>
            </div>
          </td>
          <td style="padding: 16px 20px">
            <div style="display:flex; flex-direction:column; gap:6px">
              <div class="stat-inline">
                ${u.isOwner ? '<span class="badge violet" style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.3); padding: 4px 10px; font-weight: 800; font-size: 0.65rem">SYS OWNER</span>' : ''}
                ${u.premium ? '<span class="badge blue" style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); padding: 4px 10px; font-weight: 800; font-size: 0.65rem">PREMIUM</span>' : ''}
                ${u.banned ? '<span class="badge red" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); padding: 4px 10px; font-weight: 800; font-size: 0.65rem">BANNED</span>' : '<span class="badge green" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); padding: 4px 10px; font-weight: 800; font-size: 0.65rem">ACTIVE</span>'}
              </div>
              <div style="font-size: 0.65rem; color: var(--txt-3); font-weight: 700; padding-left: 2px">
                ${u.lastSeen ? 'LAST ACTIVITY: ' + fmtTime(u.lastSeen).toUpperCase() : 'NO ACTIVITY RECORDED'}
              </div>
            </div>
          </td>
          <td style="padding: 16px 20px; text-align:right">
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:8px">
              <button class="btn btn-ghost btn-sm" style="width:36px; height:36px; padding:0; border-radius:10px" onclick="editUser(decodeURIComponent('${encodeURIComponent(u.realJid || u.jid)}'))" title="Manage User">
                <i class="ic" style="width:16px; height:16px; -webkit-mask-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22currentColor%22 stroke-width=%222.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M12 20h9%22/><path d=%22M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z%22/></svg>')"></i>
              </button>
              <button class="btn btn-danger btn-sm" style="width:36px; height:36px; padding:0; border-radius:10px" onclick="deleteUser(decodeURIComponent('${encodeURIComponent(u.realJid || u.jid)}'))" title="Wipe Record">
                <i class="ic" style="width:16px; height:16px; -webkit-mask-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22currentColor%22 stroke-width=%222.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2%22/><path d=%22M10 11v6%22/><path d=%22M14 11v6%22/></svg>')"></i>
              </button>
            </div>
          </td>
        </tr>`;
      }).join('');
    }
    function editUser(jid) {
      const u = findManagedUserEntry(jid);
      if (!u) return;
      document.getElementById('editUserJid').value = getManagedUserKey(u);
      document.getElementById('editUserIsOwner').checked = !!u.isOwner;
      document.getElementById('editUserPremium').checked = !!u.premium;
      document.getElementById('editUserBanned').checked = !!u.banned;
      document.getElementById('userEditTitle').textContent = `Edit User: ${u.pushName || u.number || 'User'}`;
      openModal('userEditModal');
    }
    async function saveUserEdit() {
      const jid = document.getElementById('editUserJid').value;
      const u = findManagedUserEntry(jid);
      if (!u) return closeModal('userEditModal');

      const payload = {
        jid,
        premium: document.getElementById('editUserPremium').checked,
        banned: document.getElementById('editUserBanned').checked
      };

      const nextIsOwner = document.getElementById('editUserIsOwner').checked;

      try {
        // 1. Update Core Data
        const result = await api('/bot-api/users/upsert', { method: 'POST', body: JSON.stringify(payload) });
        if (result?.user) upsertManagedUser(result.user);

        // 2. Update Owner Status if changed
        if (nextIsOwner !== !!u.isOwner) {
          const ownerResult = await api('/bot-api/users/' + encodeURIComponent(jid) + '/owner', {
            method: 'POST',
            body: JSON.stringify({ isOwner: nextIsOwner })
          });
          if (ownerResult?.user) upsertManagedUser(ownerResult.user);
        }

        renderUsers();
        toast('User updated successfully', 'success');
        closeModal('userEditModal');
      } catch (e) { toast(e.message, 'error'); }
    }
    async function addNewUser() {
      const num = document.getElementById('newUserNumber').value.trim();
      const role = document.getElementById('newUserRole').value;
      if (!num) return toast('Phone number is required', 'error');
      try {
        const jid = normalizeUserJidInput(num);
        const result = await api('/bot-api/users/upsert', {
          method: 'POST',
          body: JSON.stringify({ number: num, pushName: null, premium: role === 'premium' })
        });
        if (result?.user) upsertManagedUser(result.user);
        if (role === 'owner') {
          const ownerResult = await api('/bot-api/users/' + encodeURIComponent(jid) + '/owner', {
            method: 'POST',
            body: JSON.stringify({ isOwner: true })
          });
          if (ownerResult?.user) upsertManagedUser(ownerResult.user);
        }
        toast('User registered', 'success');
        document.getElementById('newUserNumber').value = '';
        document.getElementById('newUserRole').value = 'standard';
        renderUsers();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function deleteUser(jid) {
      if (!await confirmDialog('Wipe all data for this user? This cannot be undone.', { okText: 'Wipe Data', danger: true })) return;
      try {
        await api('/bot-api/users/' + encodeURIComponent(jid), { method: 'DELETE' });
        removeManagedUser(jid);
        if (document.getElementById('editUserJid')?.value === jid) closeModal('userEditModal');
        renderUsers();
        toast('User data wiped', 'success');
      } catch (e) { toast(e.message, 'error'); }
    }


    // ====== GROUPS ======
    function renderGroupsStats() {
      const all = State.data.groups || [];
      const antiLink = all.filter((group) => group.antiLink || group.antilink).length;
      const welcome = all.filter((group) => group.welcome || group.welcomeEnabled).length;
      const muted = all.filter((group) => group.isMuted).length;
      const wrap = document.getElementById('groupsStats');
      const desc = document.getElementById('groupsDesc');
      if (desc) {
        const protectedCount = all.filter((group) => group.antiLink || group.antiSpam).length;
        desc.textContent = `${all.length} groups, ${protectedCount} protected`;
      }
      if (!wrap) return;
      wrap.innerHTML = `
    <div class="cmd-stat">
      <div class="k">Groups</div>
      <div class="v">${all.length}</div>
      <div class="s">Saved group profiles with moderation and welcome settings.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Anti-Link</div>
      <div class="v">${antiLink}</div>
      <div class="s">Groups actively protecting against external link spam.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Welcome</div>
      <div class="v">${welcome}</div>
      <div class="s">Groups that currently send welcome flows for new members.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Muted</div>
      <div class="v">${muted}</div>
      <div class="s">Groups where bot responses are intentionally paused.</div>
    </div>`;
    }
    function resetGroupForm() {
      State.groupEditingJid = null;
      document.getElementById('groupsFormTitle').textContent = 'Add Group';
      document.getElementById('groupFormJid').value = '';
      document.getElementById('groupFormName').value = '';
      document.getElementById('groupFormSession').value = '__main__';
      document.getElementById('groupFormMembers').value = '0';
      document.getElementById('groupFormAntiLink').checked = false;
      document.getElementById('groupFormAntiSpam').checked = false;
      document.getElementById('groupFormWelcome').checked = false;
      document.getElementById('groupFormGoodbye').checked = false;
      document.getElementById('groupFormNsfw').checked = false;
      document.getElementById('groupFormMuted').checked = false;
    }
    function editGroup(jid) {
      const group = State.data.groups.find((entry) => entry.jid === jid);
      if (!group) return;
      State.groupEditingJid = group.jid;
      document.getElementById('groupsFormTitle').textContent = 'Update Group';
      document.getElementById('groupFormJid').value = group.jid || '';
      document.getElementById('groupFormName').value = group.name || '';
      document.getElementById('groupFormSession').value = normalizeSessionId(group.sessionId);
      document.getElementById('groupFormMembers').value = String(group.memberCount || 0);
      document.getElementById('groupFormAntiLink').checked = !!(group.antiLink || group.antilink);
      document.getElementById('groupFormAntiSpam').checked = !!group.antiSpam;
      document.getElementById('groupFormWelcome').checked = !!(group.welcome || group.welcomeEnabled);
      document.getElementById('groupFormGoodbye').checked = !!(group.goodbye || group.goodbyeEnabled);
      document.getElementById('groupFormNsfw').checked = !!group.nsfw;
      document.getElementById('groupFormMuted').checked = !!group.isMuted;
    }
    async function loadGroups() {
      try {
        State.data.groups = await api('/bot-api/groups');
        const protectedCount = State.data.groups.filter((group) => group.antiLink || group.antiSpam).length;
        setText('groupsDesc', `${State.data.groups.length} groups, ${protectedCount} protected`);
        renderGroupsStats();
        renderGroups();
      }
      catch (e) { toast(e.message, 'error'); }
    }
    async function saveGroup() {
      const jid = normalizeGroupJidInput(document.getElementById('groupFormJid').value);
      if (!jid) {
        toast('Enter a valid group JID first', 'error');
        return;
      }
      try {
        const result = await api('/bot-api/groups/upsert', {
          method: 'POST',
          body: JSON.stringify({
            jid,
            name: document.getElementById('groupFormName').value.trim(),
            sessionId: normalizeSessionId(document.getElementById('groupFormSession').value),
            memberCount: parseInt(document.getElementById('groupFormMembers').value, 10) || 0,
            antiLink: document.getElementById('groupFormAntiLink').checked,
            antiSpam: document.getElementById('groupFormAntiSpam').checked,
            welcome: document.getElementById('groupFormWelcome').checked,
            goodbye: document.getElementById('groupFormGoodbye').checked,
            nsfw: document.getElementById('groupFormNsfw').checked,
            isMuted: document.getElementById('groupFormMuted').checked,
          }),
        });
        if (result?.group) upsertGroupItem(result.group);
        toast(State.groupEditingJid ? 'Group updated' : 'Group added', 'success');
        resetGroupForm();
        renderGroupsStats();
        renderGroups();
      } catch (e) { toast(e.message, 'error'); }
    }
    function renderGroups() {
      const q = (document.getElementById('groupsSearch')?.value || '').toLowerCase();
      const list = State.data.groups.filter((group) => {
        const haystack = [group.name, group.jid, group.sessionId].filter(Boolean).join(' ').toLowerCase();
        return !q || haystack.includes(q);
      });
      const tb = document.getElementById('groupsTable');
      if (!tb) return;
      if (!list.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-row">No groups matched this filter yet. Add one manually or refresh after new group activity.</td></tr>'; return; }
      tb.innerHTML = list.map(g => `<tr>
    <td><div class="entity-meta"><strong>${escapeHtml(g.name || 'Unnamed')}</strong><span class="entity-id">${escapeHtml(g.jid || '')}</span></div></td>
    <td><span class="badge gray">${escapeHtml(normalizeSessionId(g.sessionId) === '__main__' ? 'Main Bot' : normalizeSessionId(g.sessionId))}</span></td>
    <td class="money">${g.memberCount || 0}</td>
    <td><div class="stat-inline">
      ${(g.antiLink || g.antilink) ? '<span class="badge blue">Anti-Link</span>' : ''}
      ${g.antiSpam ? '<span class="badge amber">Anti-Spam</span>' : ''}
      ${(g.welcome || g.welcomeEnabled) ? '<span class="badge green">Welcome</span>' : ''}
      ${(g.goodbye || g.goodbyeEnabled) ? '<span class="badge gray">Goodbye</span>' : ''}
      ${g.nsfw ? '<span class="badge violet">NSFW</span>' : ''}
    </div></td>
    <td><div class="stat-inline">
      ${groupSwitch(g.jid, 'isMuted', g.isMuted, 'Muted')}
      ${groupSwitch(g.jid, 'antiLink', g.antiLink || g.antilink, 'Anti-Link')}
      ${groupSwitch(g.jid, 'antiSpam', g.antiSpam, 'Anti-Spam')}
      ${groupSwitch(g.jid, 'welcome', g.welcome || g.welcomeEnabled, 'Welcome')}
    </div></td>
    <td><div class="entity-actions">
      <button class="btn btn-secondary btn-sm" onclick="editGroup(decodeURIComponent('${encodeURIComponent(g.jid)}'))">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="removeGroup(decodeURIComponent('${encodeURIComponent(g.jid)}'))">Remove</button>
    </div></td>
  </tr>`).join('');
    }
    function groupSwitch(jid, key, val, label) {
      const encodedJid = encodeURIComponent(jid);
      return `<label class="row" style="gap:8px"><span class="text-xs dim">${escapeHtml(label || key)}</span><span class="switch"><input type="checkbox" ${val ? 'checked' : ''} onchange="patchGroup(decodeURIComponent('${encodedJid}'), '${key}', this.checked)"><span class="slider"></span></span></label>`;
    }
    async function patchGroup(jid, key, val) {
      try {
        const body = {};
        body[key] = val;
        const updated = await api('/bot-api/groups/' + encodeURIComponent(jid), { method: 'PATCH', body: JSON.stringify(body) });
        if (updated?.group) upsertGroupItem(updated.group);
        else State.data.groups = State.data.groups.map((group) => group.jid === jid ? { ...group, [key]: val } : group);
        renderGroupsStats();
        renderGroups();
        toast('Saved', 'success');
      }
      catch (e) { toast(e.message, 'error'); loadGroups(); }
    }
    async function removeGroup(jid) { if (!await confirmDialog('Remove group from DB?', { okText: 'Remove', danger: true })) return; try { await api('/bot-api/groups/' + encodeURIComponent(jid), { method: 'DELETE' }); removeGroupFromState(jid); renderGroupsStats(); renderGroups(); toast('Removed', 'success'); } catch (e) { toast(e.message, 'error'); } }

    // ====== COMMANDS ======
    async function loadCommands() {
      try {
        State.data.commands = await api('/bot-api/commands');
        setText('cmdsDesc', `${State.data.commands.length} commands available`);
        renderCommandStats();
        renderCommandCategories();
        renderCommands();
      }
      catch (e) { toast(e.message, 'error'); }
    }
    function renderCommandStats() {
      const wrap = document.getElementById('cmdStats');
      if (!wrap) return;
      const all = State.data.commands || [];
      const enabled = all.filter(c => c.enabled !== false).length;
      const disabled = all.length - enabled;
      const categories = new Set(all.map(c => (c.category || 'General').trim()).filter(Boolean));
      const premium = all.filter(c => c.premiumOnly).length;
      wrap.innerHTML = `
    <div class="cmd-stat">
      <div class="k">Catalog</div>
      <div class="v">${all.length}</div>
      <div class="s">Every command currently registered inside the bot runtime.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Enabled</div>
      <div class="v">${enabled}</div>
      <div class="s">${disabled} command${disabled === 1 ? '' : 's'} are currently paused from here.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Categories</div>
      <div class="v">${categories.size}</div>
      <div class="s">Scope bulk actions by category instead of flipping the whole catalog.</div>
    </div>
    <div class="cmd-stat">
      <div class="k">Premium Gates</div>
      <div class="v">${premium}</div>
      <div class="s">Commands that require premium or owner-level access before they run.</div>
    </div>`;
    }
    function renderCommandCategories() {
      const wrap = document.getElementById('cmdCategoryChips');
      const label = document.getElementById('cmdScopeLabel');
      if (!wrap) {
        if (label) {
          label.textContent = '';
        }
        return;
      }
      const categories = Array.from(new Set((State.data.commands || []).map(c => (c.category || 'General').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      const allScopes = ['all'].concat(categories);
      wrap.innerHTML = allScopes.map((category) => {
        const active = State.commandCategory === category;
        const text = category === 'all' ? 'All Commands' : category;
        const count = category === 'all'
          ? State.data.commands.length
          : State.data.commands.filter(c => (c.category || 'General').trim() === category).length;
        return `<button class="cmd-chip ${active ? 'active' : ''}" type="button" onclick="setCommandCategory(decodeURIComponent('${encodeURIComponent(category)}'))">${escapeHtml(text)} <span class="dim">(${count})</span></button>`;
      }).join('');
      if (label) {
        label.textContent = State.commandCategory === 'all'
          ? 'All categories are currently in view. Bulk actions will affect the full command catalog.'
          : `${State.commandCategory} commands are currently in scope. Bulk actions will only affect this category.`;
      }
    }
    function setCommandCategory(category) {
      State.commandCategory = category || 'all';
      renderCommandCategories();
      renderCommands();
    }
    function renderCommandMeta(command) {
      const aliases = Array.isArray(command.aliases) ? command.aliases.filter(Boolean) : [];
      const cooldown = Number(command.cooldown || 0);
      const usageCount = Number(command.usageCount || 0);
      return `
    <div class="cmd-name">
      <strong>${escapeHtml(command.name || '--')}</strong>
      <div class="cmd-inline">
        ${aliases.length ? `<span class="pill info">Aliases ${escapeHtml(aliases.join(', '))}</span>` : '<span class="pill">No aliases</span>'}
        <span class="pill ${cooldown ? 'warn' : ''}">Cooldown ${cooldown ? `${cooldown}s` : 'None'}</span>
        <span class="pill violet">Used ${usageCount}</span>
      </div>
    </div>`;
    }
    function renderCommandAccess(command) {
      const tags = [];
      if (command.ownerOnly) tags.push('<span class="pill warn">Owner Only</span>');
      if (command.premiumOnly) tags.push('<span class="pill violet">Premium</span>');
      if (command.groupOnly) tags.push('<span class="pill info">Groups</span>');
      if (command.pmOnly) tags.push('<span class="pill good">Private Chat</span>');
      if (!tags.length) tags.push('<span class="pill">Open Access</span>');
      return `<div class="cmd-inline">${tags.join('')}</div>`;
    }
    function renderCommands() {
      const tb = document.getElementById('cmdsTable');
      if (!tb) return;
      const q = (document.getElementById('cmdsSearch')?.value || '').toLowerCase();
      const statusFilter = document.getElementById('cmdStatusFilter')?.value || 'all';
      const list = State.data.commands.filter((command) => {
        const name = (command.name || '').toLowerCase();
        const category = (command.category || 'General').toLowerCase();
        const description = (command.description || '').toLowerCase();
        const aliases = Array.isArray(command.aliases) ? command.aliases.join(' ').toLowerCase() : '';
        const matchesQuery = !q || name.includes(q) || category.includes(q) || description.includes(q) || aliases.includes(q);
        const matchesCategory = State.commandCategory === 'all' || (command.category || 'General').trim() === State.commandCategory;
        const isEnabled = command.enabled !== false;
        const matchesStatus = statusFilter === 'all' || (statusFilter === 'enabled' ? isEnabled : !isEnabled);
        return matchesQuery && matchesCategory && matchesStatus;
      });
      if (!list.length) {
        tb.innerHTML = '<tr><td colspan="5" class="empty-row">No commands matched the current search and scope filters. Clear the filters to see the full catalog again.</td></tr>';
        return;
      }
      tb.innerHTML = list.map(c => `<tr>
    <td>${renderCommandMeta(c)}</td>
    <td><span class="badge gray">${escapeHtml(c.category || 'General')}</span></td>
    <td>${renderCommandAccess(c)}</td>
    <td class="cmd-desc">${escapeHtml(c.description || 'No command description has been added yet.')}</td>
    <td style="text-align:right">${groupSwitch2('cmd', c.name, c.enabled !== false)}</td>
  </tr>`).join('');
    }
    function groupSwitch2(scope, name, val) {
      const pending = State.commandPending.has(name);
      const nextEnabled = !val;
      const encodedName = encodeURIComponent(name);
      return `<div class="cmd-toggle"><span class="state ${pending ? '' : (val ? 'live' : 'off')}">${pending ? 'Saving...' : (val ? 'Enabled' : 'Disabled')}</span><button class="btn ${val ? 'btn-danger' : 'btn-primary'} btn-sm" ${pending ? 'disabled' : ''} onclick="patchCommand(decodeURIComponent('${encodedName}'), ${nextEnabled})">${pending ? 'Working...' : (val ? 'Turn Off' : 'Turn On')}</button></div>`;
    }
    async function patchCommand(name, enabled) {
      try {
        State.commandPending.add(name);
        renderCommands();
        await api('/bot-api/commands/' + encodeURIComponent(name), { method: 'PATCH', body: JSON.stringify({ enabled }) });
        State.data.commands = State.data.commands.map((command) => command.name === name ? { ...command, enabled } : command);
        State.commandPending.delete(name);
        renderCommandStats();
        renderCommandCategories();
        renderCommands();
        toast(`${name} ${enabled ? 'enabled' : 'disabled'}`, 'success');
      }
      catch (e) {
        State.commandPending.delete(name);
        toast(e.message, 'error');
        loadCommands();
      }
    }
    async function toggleAllCommands(enabled) {
      try {
        const affectedNames = State.data.commands
          .filter((command) => State.commandCategory === 'all' || (command.category || 'General').trim() === State.commandCategory)
          .map((command) => command.name);
        affectedNames.forEach((name) => State.commandPending.add(name));
        renderCommands();
        const body = { enabled };
        if (State.commandCategory !== 'all') body.category = State.commandCategory;
        await api('/bot-api/commands/toggle-all', { method: 'POST', body: JSON.stringify(body) });
        State.data.commands = State.data.commands.map((command) => {
          if (State.commandCategory !== 'all' && (command.category || 'General').trim() !== State.commandCategory) return command;
          return { ...command, enabled };
        });
        affectedNames.forEach((name) => State.commandPending.delete(name));
        renderCommandStats();
        renderCommandCategories();
        renderCommands();
        const scope = State.commandCategory === 'all' ? 'all commands' : `${State.commandCategory} commands`;
        toast(`${enabled ? 'Enabled' : 'Disabled'} ${scope}`, 'success');
      }
      catch (e) {
        State.commandPending.clear();
        toast(e.message, 'error');
        loadCommands();
      }
    }

    // ====== AUTO-REPLY ======
    async function loadAutoReply() {
      try {
        State.data.autoReply = await api('/bot-api/auto-reply');
        if (State.autoReplyEditingId && !State.data.autoReply.some(rule => rule.id === State.autoReplyEditingId)) {
          resetAutoReplyForm();
        }
        renderAutoReply();
      }
      catch (e) { toast(e.message, 'error'); }
    }
    function renderAutoReply() {
      const tb = document.getElementById('arTable');
      const desc = document.getElementById('arDesc');
      if (desc) {
        const active = (State.data.autoReply || []).filter((rule) => rule.enabled !== false).length;
        desc.textContent = `${State.data.autoReply.length} rules tracked, ${active} active in runtime`;
      }
      if (!tb) return;
      if (!State.data.autoReply.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-row">No auto-reply rules yet. Create one on the left to start automated responses.</td></tr>'; return; }
      tb.innerHTML = State.data.autoReply.map(r => {
        const encodedId = encodeURIComponent(r.id);
        const pending = State.autoReplyPending.has(r.id);
        const enabled = r.enabled !== false;
        return `<tr>
    <td class="mono">${escapeHtml(r.trigger)}</td>
    <td><span class="badge gray">${escapeHtml(r.matchType || 'exact')}</span></td>
    <td>${renderAutoReplyScope(r)}</td>
    <td class="muted text-sm truncate" style="max-width:300px">${escapeHtml(r.response)}</td>
    <td><label class="switch" title="${pending ? 'Saving...' : (enabled ? 'Active' : 'Paused')}"><input type="checkbox" ${enabled ? 'checked' : ''} ${pending ? 'disabled' : ''} onchange="toggleAutoReply(decodeURIComponent('${encodedId}'), this.checked, this)"><span class="slider"></span></label></td>
    <td style="text-align:right"><div class="actions" style="justify-content:flex-end"><button class="btn btn-ghost btn-sm" onclick="editAutoReply(decodeURIComponent('${encodedId}'))">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteAutoReply(decodeURIComponent('${encodedId}'))">Delete</button></div></td>
  </tr>`;
      }).join('');
    }
    function renderAutoReplyScope(rule) {
      const parts = [];
      if (rule.caseSensitive) parts.push('<span class="badge blue">Case</span>');
      if (rule.groupsOnly) parts.push('<span class="badge violet">Groups</span>');
      else if (rule.pmOnly) parts.push('<span class="badge amber">Private</span>');
      if (!parts.length) parts.push('<span class="badge gray">Any chat</span>');
      return parts.join(' ');
    }
    function syncAutoReplyScopeToggles(changed) {
      const groupsOnly = document.getElementById('arGroupsOnly');
      const pmOnly = document.getElementById('arPmOnly');
      if (!groupsOnly || !pmOnly) return;
      if (changed === 'groups' && groupsOnly.checked) pmOnly.checked = false;
      if (changed === 'pm' && pmOnly.checked) groupsOnly.checked = false;
    }
    function resetAutoReplyForm() {
      State.autoReplyEditingId = null;
      document.getElementById('arTrig').value = '';
      document.getElementById('arResp').value = '';
      document.getElementById('arMatch').value = 'exact';
      document.getElementById('arCaseSensitive').checked = false;
      document.getElementById('arGroupsOnly').checked = false;
      document.getElementById('arPmOnly').checked = false;
      document.getElementById('arFormTitle').textContent = 'Add Rule';
      document.getElementById('arSaveBtn').textContent = '+ Add Rule';
      document.getElementById('arCancelBtn').style.display = 'none';
      document.getElementById('arEditState').style.display = 'none';
      syncAutoReplyScopeToggles();
    }
    function editAutoReply(id) {
      const rule = State.data.autoReply.find((entry) => entry.id === id);
      if (!rule) return toast('Rule not found', 'error');
      State.autoReplyEditingId = id;
      document.getElementById('arTrig').value = rule.trigger || '';
      document.getElementById('arResp').value = rule.response || '';
      document.getElementById('arMatch').value = rule.matchType || 'exact';
      document.getElementById('arCaseSensitive').checked = !!rule.caseSensitive;
      document.getElementById('arGroupsOnly').checked = !!rule.groupsOnly;
      document.getElementById('arPmOnly').checked = !!rule.pmOnly;
      document.getElementById('arFormTitle').textContent = 'Edit Rule';
      document.getElementById('arSaveBtn').textContent = 'Save Changes';
      document.getElementById('arCancelBtn').style.display = '';
      document.getElementById('arEditState').style.display = '';
      syncAutoReplyScopeToggles();
      document.getElementById('arTrig').focus();
    }
    function getAutoReplyFormPayload() {
      const trigger = document.getElementById('arTrig').value.trim();
      const response = document.getElementById('arResp').value.trim();
      const matchType = document.getElementById('arMatch').value;
      const caseSensitive = document.getElementById('arCaseSensitive').checked;
      const groupsOnly = document.getElementById('arGroupsOnly').checked;
      const pmOnly = document.getElementById('arPmOnly').checked;
      if (!trigger || !response) return toast('Both trigger and response required', 'error');
      if (groupsOnly && pmOnly) return toast('Choose either Groups Only or Private Chats Only, not both', 'error');
      if (matchType === 'regex') {
        try {
          new RegExp(trigger, caseSensitive ? '' : 'i');
        } catch (e) {
          return toast(`Invalid regex: ${e.message}`, 'error');
        }
      }
      return { trigger, response, matchType, caseSensitive, groupsOnly, pmOnly };
    }
    async function saveAutoReply() {
      const payload = getAutoReplyFormPayload();
      if (!payload) return;
      try {
        if (State.autoReplyEditingId) {
          const updated = await api('/bot-api/auto-reply/' + encodeURIComponent(State.autoReplyEditingId), { method: 'PATCH', body: JSON.stringify(payload) });
          upsertAutoReplyRule(updated);
          toast('Rule updated', 'success');
        } else {
          const created = await api('/bot-api/auto-reply', { method: 'POST', body: JSON.stringify(payload) });
          upsertAutoReplyRule(created);
          toast('Rule added', 'success');
        }
        resetAutoReplyForm();
        renderAutoReply();
      }
      catch (e) { toast(e.message, 'error'); }
    }
    async function addAutoReply() { return saveAutoReply(); }
    function upsertAutoReplyRule(rule) {
      if (!rule?.id) return null;
      const index = State.data.autoReply.findIndex((entry) => entry.id === rule.id);
      if (index >= 0) State.data.autoReply[index] = { ...State.data.autoReply[index], ...rule };
      else State.data.autoReply.push(rule);
      State.data.autoReply.sort((a, b) => {
        const enabledDelta = Number(b.enabled !== false) - Number(a.enabled !== false);
        if (enabledDelta) return enabledDelta;
        return String(a.trigger || '').localeCompare(String(b.trigger || ''));
      });
      return State.data.autoReply.find((entry) => entry.id === rule.id);
    }
    async function toggleAutoReply(id, enabled, inputEl) {
      const rule = State.data.autoReply.find((entry) => entry.id === id);
      const previous = rule ? rule.enabled !== false : !enabled;
      State.autoReplyPending.add(id);
      if (inputEl) inputEl.disabled = true;
      if (rule) rule.enabled = enabled;
      renderAutoReply();
      try {
        const updated = await api('/bot-api/auto-reply/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
        upsertAutoReplyRule(updated);
        toast(enabled ? 'Auto-reply enabled' : 'Auto-reply disabled', 'success');
      } catch (e) {
        if (rule) rule.enabled = previous;
        toast(e.message, 'error');
      } finally {
        State.autoReplyPending.delete(id);
        renderAutoReply();
      }
    }
    async function deleteAutoReply(id) { if (!await confirmDialog('Delete this rule?', { okText: 'Delete', danger: true })) return; try { await api('/bot-api/auto-reply/' + encodeURIComponent(id), { method: 'DELETE' }); removeAutoReplyRule(id); if (State.autoReplyEditingId === id) resetAutoReplyForm(); renderAutoReply(); toast('Deleted', 'success'); } catch (e) { toast(e.message, 'error'); } }

    // ====== SCHEDULER ======
    async function loadScheduler() {
      try {
        if (!State.data.users.length) await loadUsers();
        if (!State.data.groups.length) await loadGroups();
        State.data.scheduler = await api('/bot-api/scheduler');
        if (State.schedulerEditingId && !State.data.scheduler.some(item => item.id === State.schedulerEditingId)) {
          resetSchedulerForm();
        }
        syncSchedulerForm();
        renderScheduler();
        updateSchedulerPreview();
      }
      catch (e) { toast(e.message, 'error'); }
    }
    function renderScheduler() {
      const tb = document.getElementById('schTable');
      const desc = document.getElementById('schDesc');
      if (desc) {
        const pending = (State.data.scheduler || []).filter((item) => !item.sent && !item.failed).length;
        desc.textContent = `${State.data.scheduler.length} jobs tracked, ${pending} pending`;
      }
      if (!State.data.scheduler.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-row">No scheduled messages yet. Queue a timed message to see delivery status here.</td></tr>'; return; }
      tb.innerHTML = State.data.scheduler.map(s => `<tr>
    <td class="muted text-sm truncate" style="max-width:340px">${escapeHtml(s.message)}</td>
    <td><span class="badge gray">${escapeHtml(formatSchedulerSession(s.sessionId))}</span></td>
    <td class="text-xs dim">${escapeHtml(formatSchedulerTarget(s))}</td>
    <td class="mono text-sm">${fmtTime(s.scheduledAt)}</td>
    <td>${renderSchedulerStatus(s)}</td>
    <td style="text-align:right"><div class="actions" style="justify-content:flex-end">${renderSchedulerActions(s)}</div></td>
  </tr>`).join('');
    }
    function formatSchedulerSession(sessionId) {
      const normalized = normalizeSessionId(sessionId);
      if (normalized === '__main__') return 'Main Bot';
      return normalized;
    }
    function formatSchedulerTarget(item) {
      if (item.targetType === 'groups') return `All Groups (${State.data.groups.length})`;
      if (item.targetType === 'custom') {
        const targets = item.targets || [];
        const preview = targets.slice(0, 3).join(', ');
        const suffix = targets.length > 3 ? ', ...' : '';
        return `${targets.length} custom recipient(s)${preview ? `: ${preview}${suffix}` : ''}`;
      }
      return `All Users (${State.data.users.length})`;
    }
    function renderSchedulerStatus(item) {
      if (item.sent && item.failed) {
        return `<span class="badge amber"><span class="dot"></span>Partial (${item.sentCount || 0}/${item.attemptedTargets || 0})</span>`;
      }
      if (item.sent) return `<span class="badge green"><span class="dot"></span>Sent${item.sentCount ? ` (${item.sentCount})` : ''}</span>`;
      if (item.failed) return `<span class="badge red"><span class="dot"></span>${escapeHtml(item.lastError || 'Failed')}</span>`;
      return '<span class="badge amber"><span class="dot"></span>Pending</span>';
    }
    function renderSchedulerActions(item) {
      const buttons = [];
      if (!item.sent && !item.failed) buttons.push(`<button class="btn btn-ghost btn-sm" onclick="editScheduled('${item.id}')">Edit</button>`);
      if (item.failed) buttons.push(`<button class="btn btn-warn btn-sm" onclick="retryScheduled('${item.id}')">Retry</button>`);
      buttons.push(`<button class="btn btn-danger btn-sm" onclick="deleteScheduled('${item.id}')">Delete</button>`);
      return buttons.join('');
    }
    function getSchedulerTargetCount(targetType, rawTargets) {
      if (targetType === 'groups') return (State.data.groups || []).length;
      if (targetType === 'custom') return parseRecipientList(rawTargets).length;
      return (State.data.users || []).length;
    }
    function updateSchedulerPreview() {
      const targetType = document.getElementById('schTarget').value;
      const count = getSchedulerTargetCount(targetType, document.getElementById('schTargets').value);
      const sessionId = normalizeSessionId(document.getElementById('schSession').value);
      const session = uniqueSessions().find(entry => entry.id === sessionId);
      const targetLabel = targetType === 'groups' ? 'all groups' : targetType === 'custom' ? 'custom recipients' : 'all users';
      document.getElementById('schPreview').innerHTML = `<strong>Target preview</strong>${count} recipient(s) are in scope via ${escapeHtml(targetLabel)} using ${escapeHtml(session?.label || 'Main Bot')}. Double-check timing before this job goes live.`;
    }
    function syncSchedulerForm() {
      const select = document.getElementById('schSession');
      if (!select) return;
      const current = normalizeSessionId(select.value);
      const unique = uniqueSessions();
      select.innerHTML = unique.map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.label)}</option>`).join('');
      select.value = unique.some((session) => session.id === current) ? current : '__main__';
      toggleSchedulerTargets();
    }
    function toggleSchedulerTargets() {
      const targetType = document.getElementById('schTarget').value;
      document.getElementById('schTargetsWrap').style.display = targetType === 'custom' ? '' : 'none';
      updateSchedulerPreview();
    }
    function resetSchedulerForm() {
      State.schedulerEditingId = null;
      document.getElementById('schMsg').value = '';
      document.getElementById('schWhen').value = '';
      document.getElementById('schTarget').value = 'all';
      document.getElementById('schTargets').value = '';
      document.getElementById('schFormTitle').textContent = 'New Scheduled Message';
      document.getElementById('schSaveBtn').textContent = '+ Schedule';
      document.getElementById('schCancelBtn').style.display = 'none';
      document.getElementById('schEditState').style.display = 'none';
      syncSchedulerForm();
      updateSchedulerPreview();
    }
    function editScheduled(id) {
      const item = State.data.scheduler.find(entry => entry.id === id);
      if (!item) return toast('Scheduled item not found', 'error');
      if (item.sent || item.failed) return toast('Only pending jobs can be edited', 'error');
      State.schedulerEditingId = id;
      document.getElementById('schMsg').value = item.message || '';
      document.getElementById('schWhen').value = toLocalDateTimeInput(item.scheduledAt);
      document.getElementById('schSession').value = normalizeSessionId(item.sessionId);
      document.getElementById('schTarget').value = item.targetType || 'all';
      document.getElementById('schTargets').value = (item.targets || []).join('\n');
      document.getElementById('schFormTitle').textContent = 'Edit Scheduled Message';
      document.getElementById('schSaveBtn').textContent = 'Save Changes';
      document.getElementById('schCancelBtn').style.display = '';
      document.getElementById('schEditState').style.display = '';
      toggleSchedulerTargets();
      document.getElementById('schMsg').focus();
    }
    function getSchedulerPayload() {
      const message = document.getElementById('schMsg').value.trim();
      const when = document.getElementById('schWhen').value;
      const sessionId = normalizeSessionId(document.getElementById('schSession').value);
      const targetType = document.getElementById('schTarget').value;
      const rawTargets = document.getElementById('schTargets').value;
      const targets = parseRecipientList(rawTargets);
      if (!message || !when) return toast('Message and time required', 'error');
      if (targetType === 'custom' && !targets.length) return toast('Add at least one custom recipient', 'error');
      return { message, scheduledAt: new Date(when).toISOString(), targetType, targets, sessionId };
    }
    async function saveScheduled() {
      const payload = getSchedulerPayload();
      if (!payload) return;
      try {
        if (State.schedulerEditingId) {
          const updated = await api('/bot-api/scheduler/' + State.schedulerEditingId, { method: 'PATCH', body: JSON.stringify(payload) });
          if (updated?.id) upsertSchedulerItem(updated);
          toast('Schedule updated', 'success');
        } else {
          const created = await api('/bot-api/scheduler', { method: 'POST', body: JSON.stringify(payload) });
          if (created?.id) upsertSchedulerItem(created);
          toast('Scheduled', 'success');
        }
        resetSchedulerForm();
        renderScheduler();
      }
      catch (e) { toast(e.message, 'error'); }
    }
    async function addScheduled() { return saveScheduled(); }
    async function retryScheduled(id) {
      if (!await confirmDialog('Retry this failed job now?', { okText: 'Retry' })) return;
      try {
        const updated = await api('/bot-api/scheduler/' + id + '/retry', { method: 'POST', body: JSON.stringify({ scheduledAt: new Date().toISOString() }) });
        if (updated?.id) upsertSchedulerItem(updated);
        toast('Retry queued', 'success');
        renderScheduler();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function deleteScheduled(id) { if (!await confirmDialog('Delete this scheduled message?', { okText: 'Delete', danger: true })) return; try { await api('/bot-api/scheduler/' + id, { method: 'DELETE' }); removeSchedulerItemFromState(id); renderScheduler(); toast('Deleted', 'success'); if (State.schedulerEditingId === id) resetSchedulerForm(); } catch (e) { toast(e.message, 'error'); } }

    // ====== BROADCAST ======
    async function loadBroadcastPage() {
      if (!State.data.sessions.length) await loadSessions();
      if (!State.data.users.length) await loadUsers();
      syncBroadcastForm();
      loadBroadcastHistory();
    }
    function syncBroadcastForm() {
      const select = document.getElementById('bcSession');
      if (!select) return;
      const current = normalizeSessionId(select.value);
      const sessions = uniqueSessions();
      select.innerHTML = sessions.map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.label)}</option>`).join('');
      select.value = sessions.some((session) => session.id === current) ? current : '__main__';
      const active = sessions.find((session) => session.id === select.value) || sessions[0];
      document.getElementById('bcSessionSummary').textContent = active
        ? `${active.label} is currently ${active.status}.`
        : 'Choose which connected session should deliver this broadcast.';
      updateBroadcastPreview();
    }
    function updateBroadcastPreview() {
      const count = (State.data.users || []).length;
      const sessions = uniqueSessions();
      const sessionId = normalizeSessionId(document.getElementById('bcSession')?.value);
      const active = sessions.find((session) => session.id === sessionId);
      const preview = document.getElementById('bcPreview');
      if (!preview) return;
      preview.innerHTML = `<strong>Recipient preview</strong>${count} known user(s) are queued for this send${active ? ` from ${escapeHtml(active.label)}` : ''}. Review the copy before you push it live.`;
    }
    async function sendBroadcast() {
      const message = document.getElementById('bcMsg').value.trim();
      if (!message) return toast('Message required', 'error');
      const sessionId = normalizeSessionId(document.getElementById('bcSession').value);
      const recipientCount = (State.data.users || []).length;
      if (!await confirmDialog(`Send this broadcast to ${recipientCount} user(s)?`, { title: "Send broadcast", okText: "Send" })) return;
      const btn = document.getElementById('bcBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending...';
      try {
        const r = await api('/bot-api/broadcast', { method: 'POST', body: JSON.stringify({ message, sessionId }) });
        document.getElementById('bcResult').innerHTML = `<div class="card" style="padding:16px;border-color:rgba(34,197,94,.30);background:linear-gradient(180deg,rgba(34,197,94,.12),rgba(34,197,94,.04))"><b>Broadcast completed.</b> Sent ${r.sent}/${r.total}, failed ${r.failed}. Review the recent activity panel below for history.</div>`;
        document.getElementById('bcMsg').value = '';
        toast(`Broadcast sent: ${r.sent}/${r.total}`, 'success');
        loadBroadcastHistory();
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Send Broadcast'; }
    }
    async function loadBroadcastHistory() {
      try {
        const list = await api('/bot-api/broadcast/history');
        State.data.bcHistory = list;
        const wrap = document.getElementById('bcHistory');
        if (!list.length) { wrap.innerHTML = '<div class="empty-state"><h4>No broadcasts yet</h4><p>Your recent send history will appear here once the first campaign finishes.</p></div>'; return; }
        wrap.innerHTML = list.slice(0, 20).map(b => `<div style="padding:14px;border:1px solid var(--line-2);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02));box-shadow:var(--shadow-sm)">
      <div class="text-sm" style="margin-bottom:6px">${escapeHtml((b.message || '').slice(0, 120))}${(b.message || '').length > 120 ? '...' : ''}</div>
      <div class="text-xs dim row gap-3"><span>${fmtTime(b.sentAt || b.createdAt)}</span><span>-</span><span>${b.sent || 0} sent</span><span>-</span><span>${b.failed || 0} failed</span></div>
    </div>`).join('');
      } catch (e) { /* silent */ }
    }

    // ====== FILES ======
    async function loadFiles() {
      try {
        State.filesError = null;
        State.data.files = await api('/bot-api/files');
        document.getElementById('filesDesc').textContent = `${State.data.files.length} files cached`;
        renderFiles();
      }
      catch (e) {
        State.filesError = e.message;
        State.data.files = [];
        renderFiles();
        toast(e.message, 'error');
      }
    }
    function renderFiles() {
      const tb = document.getElementById('filesTable');
      const errorWrap = document.getElementById('filesError');
      if (errorWrap) {
        if (State.filesError) {
          errorWrap.style.display = '';
          errorWrap.innerHTML = `<div class="notice"><strong>Unable to load files</strong>${escapeHtml(State.filesError)}</div>`;
        } else {
          errorWrap.style.display = 'none';
          errorWrap.innerHTML = '';
        }
      }
      if (!State.data.files.length) { tb.innerHTML = `<tr><td colspan="4" class="empty-row">${State.filesError ? 'File list is temporarily unavailable. Try again after the bot finishes syncing storage.' : 'No downloaded files yet. Media and exports will appear here once they are cached.'}</td></tr>`; return; }
      tb.innerHTML = State.data.files.map(f => `<tr>
    <td class="mono text-sm truncate" style="max-width:340px">${escapeHtml(f.name)}</td>
    <td class="mono text-sm">${escapeHtml((f.sizeMB || '--') + (f.sizeMB ? ' MB' : ''))}</td>
    <td class="text-xs dim">${f.modified ? fmtTime(f.modified) : '--'}</td>
    <td style="text-align:right"><button class="btn btn-danger btn-sm" onclick="deleteFile('${escapeHtml(f.name)}')">Delete</button></td>
  </tr>`).join('');
    }
    async function deleteFile(name) { if (!await confirmDialog('Delete this file?', { okText: 'Delete', danger: true })) return; try { await api('/bot-api/files/' + encodeURIComponent(name), { method: 'DELETE' }); toast('Deleted', 'success'); loadFiles(); } catch (e) { toast(e.message, 'error'); } }

    // ====== AI ENGINE ======
    function setAiProviderStatus(id, active) {
      const card = byId('prov' + id);
      const status = byId('status' + id);
      const badge = byId('badge' + id);
      if (card) card.classList.toggle('active', !!active);
      if (status) status.textContent = active ? 'Service Active' : 'Key Missing / Inactive';
      if (badge) {
        badge.className = 'badge ' + (active ? 'green' : 'gray');
        badge.innerHTML = active ? '<span class="dot"></span>READY' : 'OFFLINE';
      }
    }

    async function loadAiEngine() {
      try {
        const list = await api('/bot-api/sessions');
        State.data.sessions = Array.isArray(list) ? list : [];
        const main = State.data.sessions.find(s => normalizeSessionId(s.id) === '__main__') || State.data.sessions[0];
        if (!main) {
          setText('aiEngineStatus', 'NO MAIN SESSION');
          setText('aiStatStatus', 'OFFLINE');
          return;
        }

        const arEl = byId('aiSetAutoReply');
        const perEl = byId('aiSetPersona');
        const langEl = byId('aiSetLang');
        const voiceEl = byId('aiSetVoice');
        const groupModeEl = byId('aiSetGroupMode');
        if (arEl) arEl.checked = !!main.aiAutoReply;
        if (perEl) {
          const persona = ['friendly', 'professional', 'funny', 'savage', 'romantic', 'robot'].includes(main.aiAutoPersona)
            ? main.aiAutoPersona
            : 'friendly';
          perEl.value = persona;
        }
        if (langEl) {
          const langMap = { sinhala: 'si', english: 'en', auto: 'mixed' };
          const lang = langMap[main.aiAutoLang] || main.aiAutoLang || 'mixed';
          langEl.value = ['mixed', 'si', 'en'].includes(lang) ? lang : 'mixed';
        }
        if (voiceEl) voiceEl.checked = !!main.aiAutoVoice;
        if (groupModeEl) {
          const groupMode = main.aiGroupMode === 'all' ? 'always' : main.aiGroupMode;
          groupModeEl.value = ['mention', 'always'].includes(groupMode) ? groupMode : 'mention';
        }

        const keyStatus = main.aiKeysStatus || {};
        setAiProviderStatus('Gemini', keyStatus.gemini);
        setAiProviderStatus('OpenRouter', keyStatus.openrouter);
        setAiProviderStatus('Groq', keyStatus.groq);

        api('/bot-api/bot/check-ai-keys', { silent: true })
          .then(live => {
            setAiProviderStatus('Gemini', live?.gemini);
            setAiProviderStatus('OpenRouter', live?.openrouter);
            setAiProviderStatus('Groq', live?.groq);
            setText('aiStatStatus', (live?.gemini || live?.openrouter || live?.groq) ? 'ONLINE' : 'OFFLINE');
          })
          .catch(() => {});

        setText('aiEngineStatus', main.aiAutoReply ? 'AI AUTO-REPLY ON' : 'AI AUTO-REPLY OFF');
        setText('aiStatStatus', (keyStatus.gemini || keyStatus.openrouter || keyStatus.groq) ? 'ONLINE' : 'OFFLINE');
        setText('aiStatTraffic', main.processedCount || 0);
        setText('aiStatTokens', 'STABLE');
        const uptime = getSessionAgeSeconds(main);
        setText('aiStatStability', uptime > 0 ? fmtUptime(uptime) : '99.9%');
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    async function saveAiSettings() {
      const arEl = byId('aiSetAutoReply');
      const perEl = byId('aiSetPersona');
      const langEl = byId('aiSetLang');
      const voiceEl = byId('aiSetVoice');
      const groupModeEl = byId('aiSetGroupMode');
      if (!arEl || !perEl || !langEl || !voiceEl || !groupModeEl) return;

      const main = (State.data.sessions || []).find(s => normalizeSessionId(s.id) === '__main__') || {};
      const payload = {
        aiAutoReply: arEl.checked,
        aiAutoPersona: perEl.value,
        aiAutoLang: langEl.value,
        aiAutoVoice: voiceEl.checked,
        aiGroupMode: groupModeEl.value,
        aiSystemInstruction: main.aiSystemInstruction || '',
        aiMaxWords: main.aiMaxWords || 30,
      };

      try {
        await api('/bot-api/sessions/__main__/settings', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        await api('/bot-api/settings', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast('AI Engine settings updated', 'success');
        await loadAiEngine();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    async function clearAiHistory() {
      const ok = await confirmDialog('Clear all AI conversation history? This resets the bot memory for all chats.', {
        title: 'Clear AI history',
        okText: 'Clear Memory',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('/bot-api/bot/ai-history', { method: 'DELETE' });
        toast('AI conversation memory cleared', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    async function saveApiKeys() {
      const geminiEl = byId('keyGemini');
      const openRouterEl = byId('keyOpenRouter');
      const groqEl = byId('keyGroq');
      if (!geminiEl || !openRouterEl || !groqEl) return;

      const payload = {
        gemini: geminiEl.value.trim(),
        openrouter: openRouterEl.value.trim(),
        groq: groqEl.value.trim(),
      };
      if (!payload.gemini && !payload.openrouter && !payload.groq) {
        toast('Enter at least one API key', 'error');
        return;
      }

      try {
        await api('/bot-api/bot/api-keys', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        geminiEl.value = '';
        openRouterEl.value = '';
        groqEl.value = '';
        toast('API keys updated', 'success');
        setTimeout(loadAiEngine, 500);
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    // ====== SETTINGS ======
    async function loadSettings() {
      try {
        const s = await api('/bot-api/settings');
        State.data.settings = s || {};
        const data = State.data.settings;
        document.getElementById('setName').value = data.botName || data.name || 'Chathu MD';
        document.getElementById('setPrefix').value = data.prefix || '.';
        document.getElementById('setOwner').value = data.ownerNumber || data.owner || '';
        document.getElementById('setPremium').value = data.premiumCode || '';
        document.getElementById('setAutoRead').checked = data.autoRead !== false;
        document.getElementById('setAutoType').checked = data.autoTyping !== false;
        document.getElementById('setNsfw').checked = data.nsfwEnabled !== false;
        document.getElementById('setWorkMode').value = data.workMode || 'public';
        document.getElementById('setAutoViewStatus').checked = data.autoViewStatus !== false;
        document.getElementById('setAutoReactStatus').checked = data.autoReactStatus === true;
        const fsm = document.getElementById('setFleetSoloMode');
        if (fsm) fsm.checked = data.fleetSoloMode !== false;
        // V4.2: bot-wide UI Mode (binary on/off; legacy values collapse).
        const bm = document.getElementById('setButtonMode');
        if (bm) {
          const raw = String(data.buttonMode || 'on').toLowerCase();
          bm.value = (['off','false','0','no','n','text','disable','disabled','legacy'].includes(raw)) ? 'off' : 'on';
        }
        const rm = document.getElementById('setRoleMenuMode');
        if (rm) rm.value = data.roleMenuMode || 'strict';
        renderSettingsWarnings(data);
      } catch (e) { /* silent on first load */ }
    }
    function renderSettingsWarnings(settings) {
      const wrap = document.getElementById('settingsWarnings');
      const summary = document.getElementById('settingsModeSummary');
      const warnings = settings?.warnings || [];
      if (summary) {
        summary.style.display = '';
        summary.innerHTML = `<div class="notice"><strong>Startup mode</strong>${escapeHtml((settings?.runMode || 'production').toUpperCase())} mode is active.${settings?.envSource ? ` Loaded from ${escapeHtml(settings.envSource)}.` : ''}${settings?.secureByDefault ? ' Production-safe validation is enabled.' : ' Development-safe warnings are being used.'}</div>`;
      }
      if (!warnings.length) {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
        return;
      }
      wrap.style.display = '';
      wrap.innerHTML = warnings.map((warning) => `<div class="notice"><strong>${escapeHtml((settings?.runMode || 'production').toUpperCase())} mode warning</strong>${escapeHtml(warning)}</div>`).join('');
    }
    async function saveSettings() {
      const body = {
        botName: document.getElementById('setName').value,
        prefix: document.getElementById('setPrefix').value,
        autoRead: document.getElementById('setAutoRead').checked,
        autoTyping: document.getElementById('setAutoType').checked,
        nsfwEnabled: document.getElementById('setNsfw').checked,
        workMode: document.getElementById('setWorkMode').value,
        autoViewStatus: document.getElementById('setAutoViewStatus').checked,
        autoReactStatus: document.getElementById('setAutoReactStatus').checked,
        fleetSoloMode: document.getElementById('setFleetSoloMode')?.checked ?? true,
        // V4.2: bot-wide UI Mode
        buttonMode:   document.getElementById('setButtonMode')?.value   || undefined,
        roleMenuMode: document.getElementById('setRoleMenuMode')?.value || undefined,
      };
      try {
        const res = await api('/bot-api/settings', { method: 'POST', body: JSON.stringify(body) });
        State.data.settings = res.settings || body;
        await loadSettings();
        toast('Settings saved', 'success');
      } catch (e) { toast(e.message, 'error'); }
    }
    async function restartBot() {
      if (!await confirmDialog('Restart the bot? Active sessions may briefly disconnect.', { title: 'Restart bot', okText: 'Restart', danger: true })) return;
      try { await api('/bot-api/restart', { method: 'POST' }); toast('Restart triggered', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }

    // ====== LOGS ======
    async function loadLogs() {
      try {
        const list = await api('/bot-api/logs?limit=200'); // newest-first from API
        State.data.logs = list.slice().reverse();
        renderLogs();
      } catch (e) { /* silent */ }
    }
    function renderLogs() {
      const stream = document.getElementById('logsStream');
      if (stream) {
        stream.innerHTML = State.data.logs.map(logLineHtml).join('');
        stream.scrollTop = stream.scrollHeight;
      }
      const dash = document.getElementById('dashLogs');
      if (dash) { dash.innerHTML = State.data.logs.slice(-30).map(logLineHtml).join(''); dash.scrollTop = dash.scrollHeight; }
    }
    function appendLogLine(entry) {
      const html = logLineHtml(entry);
      ['logsStream', 'dashLogs'].forEach(id => {
        const el = document.getElementById(id); if (!el) return;
        el.insertAdjacentHTML('beforeend', html);
        while (el.children.length > 500) el.firstChild.remove();
        el.scrollTop = el.scrollHeight;
      });
    }
    function logLineHtml(e) {
      const t = (e.time || '').split('T')[1]?.split('.')[0] || '';
      const msg = e.message || '';
      let cls = '';
      if (/error|crash|fail/i.test(msg)) cls = 'style="color:#fca5a5"';
      else if (/connected|ready|loaded/i.test(msg)) cls = 'style="color:#86efac"';
      else if (/qr|warn/i.test(msg)) cls = 'style="color:#fcd34d"';
      return `<div class="log-line"><span class="t">${escapeHtml(t)}</span><span class="m" ${cls}>${escapeHtml(msg)}</span></div>`;
    }
    async function clearLogs() {
      if (!await confirmDialog('Clear all logs?', { okText: 'Clear', danger: true })) return;
      try { await api('/bot-api/logs', { method: 'DELETE' }); State.data.logs = []; renderLogs(); toast('Logs cleared', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }

    // (Legacy Economy code removed - Unified with loadUsers/renderUsers)

    // ====== MODAL HELPERS ======
    function openModal(id) {
      const modal = document.getElementById(id);
      if (!modal) return toast(`Modal not found: ${id}`, 'error');
      modal.classList.add('open');
    }
    function closeModal(id) {
      const modal = document.getElementById(id);
      if (!modal) return;
      modal.classList.remove('open');
      if (id === 'qrModal') State.activeQrSession = null;
    }
    document.addEventListener('click', e => {
      const modal = e.target?.classList?.contains('modal-back') ? e.target : null;
      if (modal?.id) closeModal(modal.id);
    });
    document.addEventListener('click', e => {
      const slider = e.target?.closest?.('.switch .slider');
      if (!slider) return;
      if (slider.closest('label')) return;
      const input = slider.parentElement?.querySelector('input[type="checkbox"]');
      if (!input || input.disabled) return;
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // ====== BOOT ======
    document.getElementById('loginForm')?.addEventListener('submit', login);
    normalizeNavLinks();
    ensureAiEngineNav();
    document.getElementById('bcSession')?.addEventListener('change', updateBroadcastPreview);
    document.getElementById('schWhen')?.addEventListener('input', updateSchedulerPreview);
    document.getElementById('schTargets')?.addEventListener('input', updateSchedulerPreview);
    document.getElementById('arGroupsOnly')?.addEventListener('change', () => syncAutoReplyScopeToggles('groups'));
    document.getElementById('arPmOnly')?.addEventListener('change', () => syncAutoReplyScopeToggles('pm'));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-back.open').forEach(m => closeModal(m.id)); });

    if (typeof resetAutoReplyForm === 'function') try { resetAutoReplyForm(); } catch {}
      if (typeof resetSchedulerForm === 'function') try { resetSchedulerForm(); } catch {}
      if (CURRENT_PAGE && State.token) enterApp();
  
