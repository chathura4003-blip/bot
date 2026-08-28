'use strict';

function getWorkerDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CHATHU-MD Cloud Stream Dashboard | 1 Gbps Speed Monitor</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #070913;
      --bg-secondary: #0d1224;
      --card-bg: rgba(16, 23, 44, 0.75);
      --card-border: rgba(0, 242, 254, 0.15);
      --cyan: #00f2fe;
      --blue: #4facfe;
      --purple: #7928ca;
      --pink: #ff0080;
      --green: #00f5a0;
      --yellow: #f6d365;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --glow-cyan: 0 0 25px rgba(0, 242, 254, 0.35);
      --glow-blue: 0 0 25px rgba(79, 172, 254, 0.35);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Outfit', sans-serif;
    }

    body {
      background: var(--bg-primary);
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(0, 242, 254, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 85% 85%, rgba(121, 40, 202, 0.1) 0%, transparent 40%),
        radial-gradient(circle at 50% 50%, rgba(13, 18, 36, 0.5) 0%, transparent 80%);
      color: var(--text-main);
      min-height: 100vh;
      padding: 24px;
      overflow-x: hidden;
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      margin-bottom: 24px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .logo-glow {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--cyan), var(--purple));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: var(--glow-cyan);
    }

    .title-box h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.5px;
      background: linear-gradient(90deg, #ffffff, var(--cyan));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .title-box p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .header-status {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 30px;
      font-size: 13px;
      font-weight: 600;
      background: rgba(0, 245, 160, 0.1);
      border: 1px solid rgba(0, 245, 160, 0.3);
      color: var(--green);
    }

    .badge-pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 12px var(--green);
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.3); }
      100% { opacity: 1; transform: scale(1); }
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }

    .kpi-card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 22px;
      position: relative;
      overflow: hidden;
      transition: transform 0.25s ease, border-color 0.25s ease;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .kpi-card:hover {
      transform: translateY(-3px);
      border-color: rgba(0, 242, 254, 0.4);
    }

    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--cyan), var(--blue));
    }

    .kpi-card.purple::before { background: linear-gradient(90deg, var(--purple), var(--pink)); }
    .kpi-card.green::before { background: linear-gradient(90deg, var(--green), var(--cyan)); }
    .kpi-card.yellow::before { background: linear-gradient(90deg, var(--yellow), #ff7e5f); }

    .kpi-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .kpi-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
    }

    .kpi-icon {
      font-size: 20px;
      opacity: 0.9;
    }

    .kpi-value {
      font-size: 32px;
      font-weight: 800;
      font-family: 'JetBrains Mono', monospace;
      color: #ffffff;
      margin-bottom: 6px;
      letter-spacing: -0.5px;
    }

    .kpi-sub {
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .highlight-cyan { color: var(--cyan); font-weight: 600; }
    .highlight-green { color: var(--green); font-weight: 600; }

    /* Section Cards */
    .dashboard-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 24px;
    }

    @media (max-width: 900px) {
      .dashboard-row { grid-template-columns: 1fr; }
      header { flex-direction: column; gap: 14px; text-align: center; }
      .brand-section { flex-direction: column; }
    }

    .glass-panel {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .panel-header h2 {
      font-size: 17px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* Live Activity List */
    .active-task-box {
      background: rgba(0, 242, 254, 0.04);
      border: 1px solid rgba(0, 242, 254, 0.2);
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 12px;
      transition: all 0.2s ease;
    }

    .task-title-row {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
    }

    .task-name {
      max-width: 70%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .task-speed {
      font-family: 'JetBrains Mono', monospace;
      color: var(--cyan);
      font-weight: 700;
    }

    .progress-bar-bg {
      background: rgba(255, 255, 255, 0.08);
      height: 8px;
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--cyan), var(--blue));
      border-radius: 10px;
      transition: width 0.3s ease;
      box-shadow: 0 0 10px var(--cyan);
    }

    .task-meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
    }

    .empty-state {
      text-align: center;
      padding: 36px 12px;
      color: var(--text-muted);
      font-size: 14px;
    }

    .empty-state-icon {
      font-size: 32px;
      margin-bottom: 8px;
      opacity: 0.6;
    }

    /* System Stats Grid */
    .sys-specs {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
    }

    .spec-item {
      background: rgba(255, 255, 255, 0.03);
      padding: 12px 16px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .spec-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    .spec-val {
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
      font-family: 'JetBrains Mono', monospace;
    }

    /* Table */
    .history-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      margin-top: 8px;
    }

    .history-table th {
      text-align: left;
      padding: 12px;
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .history-table td {
      padding: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: var(--text-main);
    }

    .history-table tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .tag-success {
      background: rgba(0, 245, 160, 0.12);
      color: var(--green);
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
    }

    .mono { font-family: 'JetBrains Mono', monospace; }

    footer {
      text-align: center;
      margin-top: 32px;
      padding: 16px;
      color: var(--text-muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand-section">
        <div class="logo-glow">⚡</div>
        <div class="title-box">
          <h1>CHATHU-MD CLOUD SPEED MONITOR</h1>
          <p>High-Speed 1 Gbps Pure Stream Datacenter Engine</p>
        </div>
      </div>
      <div class="header-status">
        <div class="badge">
          <span class="badge-pulse"></span>
          <span>RAILWAY 1 Gbps DATACENTER</span>
        </div>
      </div>
    </header>

    <!-- KPI Grid -->
    <div class="kpi-grid">
      <!-- Live Download Speed -->
      <div class="kpi-card">
        <div class="kpi-header">
          <span class="kpi-title">LIVE DOWNLOAD SPEED</span>
          <span class="kpi-icon">⚡</span>
        </div>
        <div class="kpi-value" id="kpi-dl-speed">0.0 MB/s</div>
        <div class="kpi-sub">
          <span>Peak Record:</span>
          <span class="highlight-cyan" id="kpi-peak-speed">1 Gbps</span>
        </div>
      </div>

      <!-- Live Upload / Stream Speed -->
      <div class="kpi-card purple">
        <div class="kpi-header">
          <span class="kpi-title">WHATSAPP STREAM RATE</span>
          <span class="kpi-icon">📤</span>
        </div>
        <div class="kpi-value" id="kpi-ul-speed">1 Gbps Line</div>
        <div class="kpi-sub">Direct WhatsApp Datacenter Pipe</div>
      </div>

      <!-- Total Downloaded -->
      <div class="kpi-card green">
        <div class="kpi-header">
          <span class="kpi-title">TOTAL CLOUD TRANSFERRED</span>
          <span class="kpi-icon">💾</span>
        </div>
        <div class="kpi-value" id="kpi-total-dl">0 MB</div>
        <div class="kpi-sub">
          <span>Completed Tasks:</span>
          <span class="highlight-green" id="kpi-total-tasks">0</span>
        </div>
      </div>

      <!-- PC Data Saved -->
      <div class="kpi-card yellow">
        <div class="kpi-header">
          <span class="kpi-title">PC DATA CONSUMPTION</span>
          <span class="kpi-icon">🛡️</span>
        </div>
        <div class="kpi-value">0 MB</div>
        <div class="kpi-sub highlight-green">100% Data Offloaded to Cloud!</div>
      </div>
    </div>

    <!-- Active Tasks & System Health -->
    <div class="dashboard-row">
      <!-- Active Downloads -->
      <div class="glass-panel">
        <div class="panel-header">
          <h2><span>🚀</span> Active Download Tasks (<span id="active-count">0</span>)</h2>
        </div>
        <div id="active-tasks-container">
          <div class="empty-state">
            <div class="empty-state-icon">💤</div>
            <div>No active downloads at this moment</div>
            <small style="color:var(--cyan);margin-top:4px;display:block;">Worker is idle and ready on 1 Gbps line</small>
          </div>
        </div>
      </div>

      <!-- System & Health -->
      <div class="glass-panel">
        <div class="panel-header">
          <h2><span>🖥️</span> Server Health & System</h2>
        </div>
        <div class="sys-specs">
          <div class="spec-item">
            <div class="spec-label">Server Memory (RAM)</div>
            <div class="spec-val" id="sys-ram">0 MB / 512 MB</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">Worker Uptime</div>
            <div class="spec-val" id="sys-uptime">0s</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">FFmpeg Status</div>
            <div class="spec-val" id="sys-ffmpeg">✅ Active (/usr/bin/ffmpeg)</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">yt-dlp Engine</div>
            <div class="spec-val" id="sys-ytdlp">✅ 2025+ Ready</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">Video Codec</div>
            <div class="spec-val">H.264 (AVC) + FastStart</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">Node Runtime</div>
            <div class="spec-val" id="sys-node">v20.x (Linux)</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent History Table -->
    <div class="glass-panel">
      <div class="panel-header">
        <h2><span>📜</span> Recent Cloud Transfer History</h2>
      </div>
      <div style="overflow-x:auto;">
        <table class="history-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>File Name</th>
              <th>Size</th>
              <th>Avg Speed</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="history-table-body">
            <tr>
              <td colspan="6" class="empty-state" style="padding:24px;">No recent download history yet</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <footer>
      CHATHU-MD Cloud High-Speed Media Worker &bull; 1 Gbps Datacenter Line &bull; 0 MB PC Data Engine
    </footer>
  </div>

  <script>
    async function updateStats() {
      try {
        const res = await fetch('/api/worker/stats');
        if (!res.ok) return;
        const data = await res.json();

        // Update KPIs
        document.getElementById('kpi-dl-speed').textContent = data.bandwidth.currentDownloadSpeed || '0.0 MB/s';
        document.getElementById('kpi-peak-speed').textContent = data.bandwidth.peakSpeed || '1 Gbps';
        document.getElementById('kpi-ul-speed').textContent = data.bandwidth.currentUploadSpeed !== '0.0 MB/s' ? data.bandwidth.currentUploadSpeed : '1 Gbps Line';
        document.getElementById('kpi-total-dl').textContent = data.bandwidth.totalDownloaded || '0 MB';
        document.getElementById('kpi-total-tasks').textContent = data.tasks.totalCompleted || 0;

        // System
        document.getElementById('sys-ram').textContent = (data.memory.usedMB || 0) + ' MB / ' + (data.memory.totalMB || 512) + ' MB (' + (data.memory.percent || 0) + '%)';
        document.getElementById('sys-uptime').textContent = data.uptime || '0s';
        document.getElementById('sys-ffmpeg').textContent = data.system.ffmpegAvailable ? '✅ Active (H.264/AAC)' : '⚠️ Not found';
        document.getElementById('sys-ytdlp').textContent = data.system.ytDlpAvailable ? '✅ Active (1 Gbps)' : '⚠️ Initializing';
        document.getElementById('sys-node').textContent = data.system.nodeVersion + ' (' + data.system.platform + ')';

        // Active Tasks
        const activeCount = data.tasks.activeCount || 0;
        document.getElementById('active-count').textContent = activeCount;
        const activeContainer = document.getElementById('active-tasks-container');

        if (activeCount === 0) {
          activeContainer.innerHTML = \`
            <div class="empty-state">
              <div class="empty-state-icon">💤</div>
              <div>No active downloads at this moment</div>
              <small style="color:var(--cyan);margin-top:4px;display:block;">Worker is idle and ready on 1 Gbps line</small>
            </div>
          \`;
        } else {
          let html = '';
          data.tasks.activeList.forEach(t => {
            const p = Math.min(100, Math.max(0, t.percent || 0));
            html += \`
              <div class="active-task-box">
                <div class="task-title-row">
                  <span class="task-name" title="\${t.fileName}">\${t.fileName}</span>
                  <span class="task-speed">\${t.speed || 'Connecting...'}</span>
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill" style="width:\${p}%"></div>
                </div>
                <div class="task-meta-row">
                  <span>\${p}% Completed &bull; ETA: \${t.eta || '...'}</span>
                  <span>Elapsed: \${t.elapsed || '0s'}</span>
                </div>
              </div>
            \`;
          });
          activeContainer.innerHTML = html;
        }

        // History
        const historyBody = document.getElementById('history-table-body');
        if (data.history && data.history.length > 0) {
          let rows = '';
          data.history.forEach(item => {
            rows += \`
              <tr>
                <td class="mono" style="color:var(--text-muted);">\${item.timestamp}</td>
                <td style="font-weight:600;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${item.fileName}</td>
                <td class="mono">\${item.size}</td>
                <td class="mono" style="color:var(--cyan);">\${item.avgSpeed}</td>
                <td class="mono">\${item.duration}</td>
                <td><span class="tag-success">✅ \${item.success ? 'Success' : 'Failed'}</span></td>
              </tr>
            \`;
          });
          historyBody.innerHTML = rows;
        }
      } catch (_) {}
    }

    // Refresh every 1200ms
    updateStats();
    setInterval(updateStats, 1200);
  </script>
</body>
</html>`;
}

module.exports = { getWorkerDashboardHTML };
