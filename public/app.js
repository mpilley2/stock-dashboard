// ============================================================================
// MARKET PULSE - MES/MNQ Intraday Intelligence
// ============================================================================

const CONFIG = {
  API_BASE: '',
  FUTURES_SYMBOLS: new Set(['ES=F', 'NQ=F', 'MES=F', 'MNQ=F', 'YM=F', 'RTY=F'])
};

let state = {
  activeAlerts: [],
  triggeredAlerts: [],
  marketStatus: 'closed',
  ws: null,
  wsConnectAttempts: 0,
  wsMaxAttempts: 5
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function fmt(n) {
  if (n === null || n === undefined) return '-';
  const num = parseFloat(n);
  if (isNaN(num)) return '-';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getTimeAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  if (diffMins < 1) return 'now';
  if (diffMins < 60) return diffMins + 'm ago';
  if (diffHours < 24) return diffHours + 'h ago';
  return Math.floor(diffHours / 24) + 'd ago';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  const container = document.getElementById('toast-container');
  if (container) {
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch (e) {}
}

// ============================================================================
// STORAGE
// ============================================================================

function loadAlerts() {
  try { state.activeAlerts = JSON.parse(localStorage.getItem('alerts') || '[]'); } catch { state.activeAlerts = []; }
  try { state.triggeredAlerts = JSON.parse(localStorage.getItem('triggeredAlerts') || '[]'); } catch { state.triggeredAlerts = []; }
}

function saveAlerts() {
  localStorage.setItem('alerts', JSON.stringify(state.activeAlerts));
  localStorage.setItem('triggeredAlerts', JSON.stringify(state.triggeredAlerts));
}

// ============================================================================
// TAB SYSTEM
// ============================================================================

function initTabs() {
  const tabs = document.querySelectorAll('.main-tab');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(tab.getAttribute('data-tab'));
      if (target) target.classList.add('active');
    });
  });
}

// ============================================================================
// CLOCK & MARKET STATUS
// ============================================================================

function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  el.textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).format(now);
}

async function loadMarketStatus() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/market-status`);
    const data = await res.json();
    state.marketStatus = data.status || 'closed';
    const badge = document.getElementById('market-status-badge');
    if (badge) {
      badge.className = `badge ${state.marketStatus === 'open' ? 'badge-open' : 'badge-closed'}`;
      badge.textContent = state.marketStatus === 'open' ? 'MARKET OPEN' : 'MARKET CLOSED';
    }
  } catch (e) { console.error('Market status error:', e); }
}

// ============================================================================
// INDICES BAR
// ============================================================================

async function loadIndices() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/indices`);
    const indices = await res.json();
    const container = document.getElementById('indices-scroll');
    if (!container) return;

    container.innerHTML = '';
    indices.forEach(index => {
      const cp = parseFloat(index.changePercent) || 0;
      const color = cp >= 0 ? 'up' : 'down';
      const isFut = CONFIG.FUTURES_SYMBOLS.has(index.symbol);

      const el = document.createElement('div');
      el.className = `index-item ${isFut ? 'futures-item' : ''}`;
      el.innerHTML = `
        <span class="index-name">${escapeHtml(index.symbol)}${isFut ? ' <span class="futures-tag">FUT</span>' : ''}</span>
        <span class="index-price">${fmt(index.price)}</span>
        <span class="index-change ${color}">${cp >= 0 ? '+' : ''}${fmt(cp)}%</span>
      `;
      container.appendChild(el);
    });
  } catch (e) { console.error('Indices error:', e); }
}

// ============================================================================
// DAILY BRIEFING (HERO)
// ============================================================================

async function loadDailyBriefing() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/daily-briefing`);
    if (!res.ok) throw new Error('Failed to fetch briefing');
    const data = await res.json();
    renderBriefing(data);
  } catch (e) {
    console.error('Briefing error:', e);
    const analysis = document.getElementById('briefing-analysis');
    if (analysis) analysis.innerHTML = '<p class="empty-msg">Unable to load market briefing. Retrying...</p>';
  }
}

function renderBriefing(data) {
  // Score circle
  const circle = document.getElementById('briefing-circle');
  const signalEl = document.getElementById('briefing-signal');
  const scoreEl = document.getElementById('briefing-score');
  const timeEl = document.getElementById('briefing-time');

  if (circle && signalEl && scoreEl) {
    const score = data.score || 50;
    let cls = 'neutral';
    if (score >= 75) cls = 'strong-bull';
    else if (score >= 60) cls = 'bull';
    else if (score >= 45) cls = 'neutral';
    else if (score >= 30) cls = 'bear';
    else cls = 'strong-bear';

    circle.className = `briefing-circle ${cls}`;
    signalEl.textContent = data.signal || 'Neutral';
    scoreEl.textContent = score;
  }

  if (timeEl && data.timestamp) {
    const t = new Date(data.timestamp);
    timeEl.textContent = t.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    }) + ' ET';
  }

  // Written analysis
  const analysisEl = document.getElementById('briefing-analysis');
  if (analysisEl && data.briefing) {
    analysisEl.innerHTML = `<p>${escapeHtml(data.briefing)}</p>`;
  }

  // Key metrics bar
  const metricsEl = document.getElementById('briefing-metrics');
  if (metricsEl && data.data) {
    const d = data.data;
    metricsEl.innerHTML = `
      <div class="metric-item">
        <span class="metric-label">VIX</span>
        <span class="metric-value">${fmt(d.vix?.price)}</span>
        <span class="metric-change ${(d.vix?.changePercent || 0) >= 0 ? 'up' : 'down'}">${(d.vix?.changePercent || 0) >= 0 ? '+' : ''}${fmt(d.vix?.changePercent)}%</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">SPY</span>
        <span class="metric-value">${fmt(d.spy?.price)}</span>
        <span class="metric-change ${(d.spy?.changePercent || 0) >= 0 ? 'up' : 'down'}">${(d.spy?.changePercent || 0) >= 0 ? '+' : ''}${fmt(d.spy?.changePercent)}%</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">QQQ</span>
        <span class="metric-value">${fmt(d.qqq?.price)}</span>
        <span class="metric-change ${(d.qqq?.changePercent || 0) >= 0 ? 'up' : 'down'}">${(d.qqq?.changePercent || 0) >= 0 ? '+' : ''}${fmt(d.qqq?.changePercent)}%</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Gold</span>
        <span class="metric-value">${fmt(d.gold?.price)}</span>
        <span class="metric-change ${(d.gold?.changePercent || 0) >= 0 ? 'up' : 'down'}">${(d.gold?.changePercent || 0) >= 0 ? '+' : ''}${fmt(d.gold?.changePercent)}%</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Oil</span>
        <span class="metric-value">${fmt(d.oil?.price)}</span>
        <span class="metric-change ${(d.oil?.changePercent || 0) >= 0 ? 'up' : 'down'}">${(d.oil?.changePercent || 0) >= 0 ? '+' : ''}${fmt(d.oil?.changePercent)}%</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">London</span>
        <span class="metric-change ${(d.global?.london?.changePercent || 0) >= 0 ? 'up' : 'down'}">${(d.global?.london?.changePercent || 0) >= 0 ? '+' : ''}${fmt(d.global?.london?.changePercent)}%</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Tokyo</span>
        <span class="metric-change ${(d.global?.tokyo?.changePercent || 0) >= 0 ? 'up' : 'down'}">${(d.global?.tokyo?.changePercent || 0) >= 0 ? '+' : ''}${fmt(d.global?.tokyo?.changePercent)}%</span>
      </div>
    `;
  }

  // Factor breakdown
  const factorsEl = document.getElementById('briefing-factors');
  if (factorsEl && data.factors) {
    let html = '<div class="factors-title">Factor Breakdown</div>';
    data.factors.forEach(f => {
      const isPositive = f.points > 0;
      const icon = isPositive ? '▲' : (f.points < 0 ? '▼' : '●');
      const cls = isPositive ? 'factor-bull' : (f.points < 0 ? 'factor-bear' : 'factor-neutral');
      html += `
        <div class="factor-item ${cls}">
          <div class="factor-header">
            <span class="factor-icon">${icon}</span>
            <span class="factor-name">${escapeHtml(f.factor)}</span>
            <span class="factor-points">${f.points > 0 ? '+' : ''}${f.points}</span>
          </div>
          <div class="factor-detail">${escapeHtml(f.detail || '')}</div>
        </div>
      `;
    });
    factorsEl.innerHTML = html;
  }
}

// ============================================================================
// SECTOR HEATMAP
// ============================================================================

async function loadSectorHeatmap() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/sectors`);
    const sectors = await res.json();
    const container = document.getElementById('sector-heatmap');
    if (!container) return;

    container.innerHTML = '';
    sectors.forEach(sector => {
      const cp = parseFloat(sector.changePercent) || 0;
      const cls = cp >= 0 ? 'positive' : 'negative';
      const box = document.createElement('div');
      box.className = `sector-box ${cls}`;
      box.innerHTML = `
        <span class="sector-name">${escapeHtml(sector.name)}</span>
        <span class="sector-change">${cp >= 0 ? '+' : ''}${fmt(cp)}%</span>
      `;
      container.appendChild(box);
    });
  } catch (e) { console.error('Sectors error:', e); }
}

// ============================================================================
// ECONOMIC CALENDAR
// ============================================================================

async function loadEconomicCalendar() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/forex-news`);
    const events = await res.json();
    const tbody = document.getElementById('economic-calendar-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No upcoming events</td></tr>';
      return;
    }

    events.forEach(event => {
      const row = document.createElement('tr');
      row.dataset.event = (event.event || '').toLowerCase();
      row.dataset.impact = event.impact || '';

      const impactClass = event.impact === 'high' ? 'badge-high' : (event.impact === 'medium' ? 'badge-medium' : 'badge-low');
      row.innerHTML = `
        <td>${escapeHtml(event.date)}</td>
        <td><strong>${escapeHtml(event.event)}</strong></td>
        <td><span class="badge ${impactClass}">${escapeHtml(event.impact || 'N/A')}</span></td>
        <td>${event.previous !== null ? escapeHtml(String(event.previous)) : '-'}</td>
        <td>${event.forecast !== null ? escapeHtml(String(event.forecast)) : '-'}</td>
        <td>${event.actual !== null ? escapeHtml(String(event.actual)) : '-'}</td>
      `;
      tbody.appendChild(row);
    });

    // Filter buttons
    document.querySelectorAll('.econ-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.econ-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;

        tbody.querySelectorAll('tr').forEach(row => {
          if (filter === 'all') { row.style.display = ''; return; }
          if (filter === 'high') { row.style.display = row.dataset.impact === 'high' ? '' : 'none'; return; }
          const eventText = row.dataset.event;
          if (filter === 'fed') {
            row.style.display = (eventText.includes('fed') || eventText.includes('fomc') || eventText.includes('interest')) ? '' : 'none';
          } else if (filter === 'employment') {
            row.style.display = (eventText.includes('payroll') || eventText.includes('employment') || eventText.includes('unemployment') || eventText.includes('jobs')) ? '' : 'none';
          } else if (filter === 'inflation') {
            row.style.display = (eventText.includes('cpi') || eventText.includes('ppi') || eventText.includes('inflation') || eventText.includes('pce')) ? '' : 'none';
          }
        });
      });
    });
  } catch (e) { console.error('Calendar error:', e); }
}

// ============================================================================
// FED EVENTS
// ============================================================================

async function loadFedEvents() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/fed-events`);
    const events = await res.json();
    const container = document.getElementById('fed-events-container');
    if (!container) return;

    container.innerHTML = '';
    const now = new Date();

    events.forEach(event => {
      const eventDate = new Date(event.date);
      const isPast = eventDate < now;
      const dateStr = eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      let typeClass = 'badge-speech';
      if (event.type === 'rate_decision') typeClass = 'badge-rate-decision';
      else if (event.type === 'minutes') typeClass = 'badge-minutes';

      const item = document.createElement('div');
      item.className = `timeline-event ${isPast ? 'past-event' : ''}`;
      item.innerHTML = `
        <div class="timeline-date">${dateStr}</div>
        <div class="timeline-content">
          <div class="timeline-title">${escapeHtml(event.name)}</div>
          <span class="badge ${typeClass}">${escapeHtml(event.type?.replace('_', ' ') || '')}</span>
        </div>
      `;
      container.appendChild(item);
    });
  } catch (e) { console.error('Fed events error:', e); }
}

// ============================================================================
// NEWS
// ============================================================================

async function loadNews() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/news/market`);
    const articles = await res.json();
    const container = document.getElementById('news-tab-container');
    if (!container) return;

    container.innerHTML = '';
    if (!articles.length) {
      container.innerHTML = '<p class="empty-msg">No news available</p>';
      return;
    }

    articles.forEach(article => {
      const item = document.createElement('div');
      item.className = 'news-item';
      item.style.cursor = 'pointer';
      item.onclick = () => window.open(article.url, '_blank');

      const thumbHtml = article.thumbnail
        ? `<img class="news-thumb" src="${escapeHtml(article.thumbnail)}" alt="" onerror="this.style.display='none'">`
        : '';

      item.innerHTML = `
        ${thumbHtml}
        <div class="news-content">
          <div class="news-headline"><a href="${escapeHtml(article.url)}" target="_blank">${escapeHtml(article.headline)}</a></div>
          <div class="news-meta">${escapeHtml(article.source)} &middot; ${getTimeAgo(article.timestamp)}</div>
        </div>
      `;
      container.appendChild(item);
    });
  } catch (e) { console.error('News error:', e); }
}

// ============================================================================
// ALERTS
// ============================================================================

function initAlerts() {
  loadAlerts();
  renderAlerts();

  const createBtn = document.getElementById('create-alert-btn');
  const saveBtn = document.getElementById('save-alert-btn');
  const cancelBtn = document.getElementById('cancel-alert-btn');

  if (createBtn) createBtn.addEventListener('click', () => {
    const modal = document.getElementById('alert-modal');
    if (modal) modal.classList.add('show');
  });

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    const modal = document.getElementById('alert-modal');
    if (modal) modal.classList.remove('show');
  });

  if (saveBtn) saveBtn.addEventListener('click', () => {
    const symbol = document.getElementById('alert-symbol')?.value?.toUpperCase();
    const type = document.getElementById('alert-type')?.value;
    const value = parseFloat(document.getElementById('alert-value')?.value);

    if (!symbol || !type || isNaN(value)) {
      showToast('Please fill all fields', 'error');
      return;
    }

    state.activeAlerts.push({ id: Date.now(), symbol, type, value, createdAt: new Date().toISOString() });
    saveAlerts();
    renderAlerts();
    showToast(`Alert created for ${symbol}`, 'info');

    const modal = document.getElementById('alert-modal');
    if (modal) modal.classList.remove('show');
    ['alert-symbol', 'alert-value'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });
}

function renderAlerts() {
  const activeContainer = document.getElementById('active-alerts-container');
  const triggeredContainer = document.getElementById('triggered-alerts-container');

  if (activeContainer) {
    if (state.activeAlerts.length === 0) {
      activeContainer.innerHTML = '<p class="empty-msg">No active alerts</p>';
    } else {
      activeContainer.innerHTML = '';
      state.activeAlerts.forEach(alert => {
        const item = document.createElement('div');
        item.className = 'alert-item';
        const typeLabel = { price_above: 'Above', price_below: 'Below', pct_up: '% Up', pct_down: '% Down' }[alert.type] || alert.type;
        item.innerHTML = `
          <div class="alert-info">
            <div class="alert-condition">${escapeHtml(alert.symbol)} ${typeLabel} ${fmt(alert.value)}</div>
          </div>
          <button class="alert-delete" data-id="${alert.id}">X</button>
        `;
        item.querySelector('.alert-delete').addEventListener('click', () => {
          state.activeAlerts = state.activeAlerts.filter(a => a.id !== alert.id);
          saveAlerts();
          renderAlerts();
        });
        activeContainer.appendChild(item);
      });
    }
  }

  if (triggeredContainer) {
    if (state.triggeredAlerts.length === 0) {
      triggeredContainer.innerHTML = '<p class="empty-msg">No triggered alerts</p>';
    } else {
      triggeredContainer.innerHTML = '';
      state.triggeredAlerts.forEach(alert => {
        const item = document.createElement('div');
        item.className = 'alert-item triggered';
        item.innerHTML = `<div class="alert-info"><div class="alert-condition">${escapeHtml(alert.symbol)} triggered at ${fmt(alert.triggeredPrice)}</div></div>`;
        triggeredContainer.appendChild(item);
      });
    }
  }
}

// ============================================================================
// WEBSOCKET
// ============================================================================

function connectWebSocket() {
  if (state.ws) state.ws.close();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;

  try {
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      console.log('[WS] Connected');
      state.wsConnectAttempts = 0;
      // Subscribe to key futures
      ['SPY', 'QQQ', 'VIX'].forEach(sym => {
        state.ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
      });
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'trade' && msg.data) {
          checkAlerts(msg.data);
        }
      } catch {}
    };

    state.ws.onclose = () => {
      if (state.wsConnectAttempts < state.wsMaxAttempts) {
        state.wsConnectAttempts++;
        setTimeout(connectWebSocket, 5000);
      }
    };

    state.ws.onerror = () => {};
  } catch {}
}

function checkAlerts(trades) {
  if (!Array.isArray(trades)) return;

  trades.forEach(trade => {
    const price = trade.p;
    const symbol = trade.s;

    state.activeAlerts = state.activeAlerts.filter(alert => {
      let triggered = false;
      if (alert.symbol === symbol) {
        if (alert.type === 'price_above' && price >= alert.value) triggered = true;
        if (alert.type === 'price_below' && price <= alert.value) triggered = true;
      }

      if (triggered) {
        state.triggeredAlerts.unshift({ ...alert, triggeredPrice: price, triggeredAt: new Date().toISOString() });
        playAlertSound();
        showToast(`Alert: ${symbol} hit ${fmt(price)}!`, 'alert');
        if (Notification.permission === 'granted') {
          new Notification(`Market Pulse Alert`, { body: `${symbol} at ${fmt(price)}` });
        }
        return false;
      }
      return true;
    });

    if (state.triggeredAlerts.length > 0) {
      saveAlerts();
      renderAlerts();
    }
  });
}

// ============================================================================
// INIT
// ============================================================================

async function init() {
  console.log('Initializing Market Pulse...');

  initTabs();
  initAlerts();

  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  updateClock();
  setInterval(updateClock, 1000);

  // Load data
  await loadMarketStatus();
  await loadIndices();
  await loadDailyBriefing();
  await loadSectorHeatmap();
  await loadEconomicCalendar();
  await loadFedEvents();
  await loadNews();

  connectWebSocket();

  // Auto-refresh
  setInterval(loadMarketStatus, 60000);
  setInterval(loadIndices, 60000);
  setInterval(loadSectorHeatmap, 60000);
  setInterval(loadDailyBriefing, 120000); // Every 2 min
  setInterval(loadNews, 300000);
  setInterval(loadEconomicCalendar, 300000);
  setInterval(loadFedEvents, 300000);

  console.log('Market Pulse initialized');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
