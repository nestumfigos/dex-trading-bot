// Render news headlines
async function renderNewsFeed() {
  const target = document.getElementById('news-feed');
  if (!target) return;
  const ttlMs = 5 * 60 * 1000;
  if (appState.newsLoadedAt && (Date.now() - appState.newsLoadedAt) < ttlMs) {
    return;
  }
  try {
    const { news } = await fetchJson('/api/news');
    appState.newsLoadedAt = Date.now();
    if (!news.length) {
      target.innerHTML = '<div class="empty-state">No news headlines available.</div>';
      return;
    }
    target.innerHTML = news.map((item) => {
      const published = item.published_at ? new Date(item.published_at) : null;
      const timeLabel = published && Number.isFinite(published.getTime())
        ? `${published.toLocaleDateString()} ${published.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : 'Unknown time';

      return `<article class="news-item">
        <a class="news-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
        <div class="news-meta-row">
          <span class="news-source">${escapeHtml(item.source || 'Unknown source')}</span>
          <span class="news-meta">${escapeHtml(timeLabel)}</span>
        </div>
      </article>`;
    }).join('');
  } catch (err) {
    target.innerHTML = `<div class="empty-state">Error loading news: ${escapeHtml(err.message)}</div>`;
  }
}
// Render correlation heatmap
async function renderCorrelationHeatmap() {
  const target = document.getElementById('correlation-heatmap');
  if (!target) return;
  const ttlMs = 60 * 1000;
  if (appState.correlationLoadedAt && (Date.now() - appState.correlationLoadedAt) < ttlMs && appState.correlation) {
    return;
  }
  const requestVersion = ++correlationRenderVersion;
  try {
    const payload = await fetchJson('/api/correlation');
    if (requestVersion !== correlationRenderVersion) {
      return;
    }

    let tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
    let matrix = Array.isArray(payload.matrix) ? payload.matrix : [];
    let usingCached = false;

    if (tokens.length) {
      appState.correlation = { tokens, matrix };
      appState.correlationLoadedAt = Date.now();
    } else if (appState.correlation && Array.isArray(appState.correlation.tokens) && appState.correlation.tokens.length) {
      tokens = appState.correlation.tokens;
      matrix = appState.correlation.matrix;
      usingCached = true;
    }

    if (!tokens.length) {
      target.innerHTML = '<div class="empty-state">No correlation data yet — scanner is still collecting price history.</div>';
      return;
    }

    // Shorten labels to max 8 chars for readability
    const labels = tokens.map(t => {
      const short = String(t).replace(/0x/i, '').slice(0, 8);
      return escapeHtml(short);
    });

    function cellColor(pct) {
      if (pct >= 80)  return { bg: '#d97706', fg: '#fff' };
      if (pct >= 60)  return { bg: '#fbbf24', fg: '#1a0f00' };
      if (pct >= 30)  return { bg: '#fde68a', fg: '#1a0f00' };
      if (pct > -30)  return { bg: '#1e293b', fg: '#94a3b8' };
      if (pct > -60)  return { bg: '#0e7490', fg: '#fff' };
      return            { bg: '#0d9488', fg: '#fff' };
    }

    let html = '<div class="heatmap-scroll"><table class="heatmap-table"><thead><tr><th class="heatmap-corner"></th>';
    labels.forEach(l => { html += `<th class="heatmap-th">${l}</th>`; });
    html += '</tr></thead><tbody>';

    matrix.forEach((row, i) => {
      html += `<tr><th class="heatmap-row-label">${labels[i]}</th>`;
      row.forEach((val) => {
        const pct = Math.round(val * 100);
        const { bg, fg } = cellColor(pct);
        const title = `${pct > 0 ? '+' : ''}${pct}%`;
        html += `<td class="heatmap-cell" style="background:${bg};color:${fg};" title="${title}">${pct > 0 ? '+' : ''}${pct}</td>`;
      });
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    html += `<div class="heatmap-legend">
      <span class="legend-item"><span class="legend-swatch" style="background:#0d9488"></span>&lt;-60% inverse</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#1e293b;border:1px solid #334155"></span>neutral</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#fde68a"></span>30–60% corr.</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#d97706"></span>&gt;80% corr.</span>
    </div>`;
    if (usingCached) {
      html += '<div class="empty-state" style="margin-top:0.65rem;">Showing last known correlation snapshot while fresh history is loading.</div>';
    }
    target.innerHTML = html;
  } catch (err) {
    target.innerHTML = `<div class="empty-state">Error loading correlation: ${escapeHtml(err.message)}</div>`;
  }
}
const appState = {
  status: null,
  config: null,
  health: null,
  backtest: null,
  simulation: null,
  aiPreview: null,
  correlation: null,
  correlationLoadedAt: 0,
  newsLoadedAt: 0,
  renderCache: {},
};

let correlationRenderVersion = 0;
let renderTimer = null;
let pendingSupplementalRefresh = false;
let lastRenderAt = 0;
let lastStateSignature = '';

const $ = (selector) => document.querySelector(selector);

function formatMoney(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  const amount = Number(value);
  return `${amount >= 0 ? '+' : ''}${amount.toFixed(2)}%`;
}

function formatCompact(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  });
}

function formatAgo(iso) {
  if (!iso) {
    return 'never';
  }
  const delta = Math.max(0, Date.now() - new Date(iso).getTime());
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toneForSignal(signal) {
  const normalized = String(signal || '').toUpperCase();
  if (normalized === 'BUY') return 'tone-buy';
  if (normalized === 'SELL') return 'tone-sell';
  if (normalized === 'HOLD') return 'tone-hold';
  return 'tone-neutral';
}

function formatHealthReason(reason) {
  const normalized = String(reason || '').trim();
  const reasonMap = {
    ws_discovery_unavailable_polling_only: 'WebSocket discovery unavailable. Running polling-only mode.',
    ws_discovery_bootstrap_failed_polling_only: 'WebSocket discovery bootstrap failed. Running polling-only mode.',
    ws_discovery_event_stale: 'WebSocket discovery events are stale.',
    exchange_dependency_unhealthy: 'One or more exchange dependencies are unhealthy.',
    ai_brain_unhealthy: 'AI brain health check is failing.',
    loop_stalled_or_timer_missing: 'One or more scheduler loops are stalled.',
    strategy_exit_checks_degraded: 'Strategy exit checks are degraded.',
    balance_drift_halt: 'Trading halted due to balance drift guard.',
    safe_mode_active: 'Safe mode is active.',
    state_persistence_error: 'State persistence is failing.',
    signal_drought: 'Signal drought guard is active.',
    health_check_failed: 'Health check failed.',
  };

  if (reasonMap[normalized]) {
    return reasonMap[normalized];
  }

  if (!normalized) {
    return 'Health check failed.';
  }

  return `${normalized.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}.`;
}

function buildStateSignature(status) {
  if (!status || !status.portfolio || !status.market || !status.brain) {
    return 'empty';
  }

  const chainSummary = Array.isArray(status.market.chainSummary) ? status.market.chainSummary : [];
  const positions = Array.isArray(status.portfolio.positions) ? status.portfolio.positions : [];
  const trades = Array.isArray(status.portfolio.recentTrades) ? status.portfolio.recentTrades : [];
  const tracked = Array.isArray(status.market.trackedTokens) ? status.market.trackedTokens : [];
  const signals = Array.isArray(status.market.recentSignals) ? status.market.recentSignals : [];
  const pnlHistory = Array.isArray(status.portfolio.pnlHistory) ? status.portfolio.pnlHistory : [];

  const chainSig = chainSummary
    .map((c) => `${c.name}:${c.status}:${c.tokensScanned}:${c.openPositions}:${c.lastUpdate || ''}`)
    .join('|');
  const positionSig = positions
    .map((p) => `${p.address}:${p.currentPrice}:${p.unrealizedPnl}`)
    .join('|');
  const tradeSig = trades
    .slice(0, 20)
    .map((t) => `${t.timestamp}:${t.type}:${t.address}:${t.valueUsd}:${t.pnl}`)
    .join('|');
  const trackedSig = tracked
    .slice(0, 40)
    .map((t) => `${t.address}:${t.price}:${t.priceChange24h}:${t.finalSignal}`)
    .join('|');
  const signalSig = signals
    .slice(0, 80)
    .map((s) => `${s.timestamp}:${s.address || s.symbol}:${s.finalSignal}:${s.price}`)
    .join('|');
  const pnlLast = pnlHistory.length ? pnlHistory[pnlHistory.length - 1] : null;
  const pnlSig = `${pnlHistory.length}:${pnlLast ? `${pnlLast.equity || 0}:${pnlLast.cash || 0}` : 'none'}`;

  return [
    status.mode,
    status.uptimeSeconds,
    status.portfolio.equity,
    status.portfolio.exposureUsd,
    status.portfolio.totalPnl,
    status.portfolio.unrealizedPnl,
    status.portfolio.winRate,
    status.portfolio.openPositionCount,
    status.portfolio.closedTrades,
    status.brain.status,
    status.brain.callCount,
    status.brain.successRate,
    chainSig,
    positionSig,
    tradeSig,
    trackedSig,
    signalSig,
    pnlSig,
  ].join('::');
}

function downsampleSeries(points, maxPoints = 160) {
  if (!Array.isArray(points) || points.length <= maxPoints) {
    return Array.isArray(points) ? points : [];
  }

  const sampled = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round(i * step);
    sampled.push(points[index]);
  }
  return sampled;
}

function chartSvg(points, series, label) {
  if (!Array.isArray(points) || !points.length) {
    return '<div class="chart-empty">No chart data yet.</div>';
  }

  const width = 1500;
  const height = 280;
  const padding = 26;
  const values = downsampleSeries(points, 160).map((point) => Number(point[series] || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const path = values.map((value, index) => {
    const x = padding + ((width - padding * 2) * index) / Math.max(values.length - 1, 1);
    const y = height - padding - ((value - min) / range) * (height - padding * 2);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  const area = `${path} L${width - padding},${height - padding} L${padding},${height - padding} Z`;
  const latest = values[values.length - 1];

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-label="${escapeHtml(label)}">
      <defs>
        <linearGradient id="line-fill-${series}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="rgba(74, 211, 194, 0.35)"></stop>
          <stop offset="100%" stop-color="rgba(74, 211, 194, 0)"></stop>
        </linearGradient>
        <linearGradient id="line-stroke-${series}" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#4ad3c2"></stop>
          <stop offset="100%" stop-color="#ffb84d"></stop>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="rgba(255,255,255,0.02)"></rect>
      <path d="${area}" fill="url(#line-fill-${series})"></path>
      <path d="${path}" fill="none" stroke="url(#line-stroke-${series})" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
      <text x="${padding}" y="24" fill="#99a9bd" font-size="15">${escapeHtml(label)}</text>
      <text x="${width - padding}" y="24" text-anchor="end" fill="#f3f4f6" font-size="15">${escapeHtml(formatMoney(latest))}</text>
      <text x="${padding}" y="${height - 12}" fill="#99a9bd" font-size="13">Low ${escapeHtml(formatMoney(min))}</text>
      <text x="${width - padding}" y="${height - 12}" text-anchor="end" fill="#99a9bd" font-size="13">High ${escapeHtml(formatMoney(max))}</text>
    </svg>
  `;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

async function fetchHealthStatus() {
  const response = await fetch('/health');
  const payload = await response.json();
  return payload;
}

function setText(selector, value) {
  const node = $(selector);
  if (node && node.textContent !== String(value)) {
    node.textContent = value;
  }
}

function setHtmlIfChanged(selector, cacheKey, html) {
  const node = $(selector);
  if (!node) return;
  if (appState.renderCache[cacheKey] === html) {
    return;
  }
  appState.renderCache[cacheKey] = html;
  node.innerHTML = html;
}

function setValueIfChanged(selector, value) {
  const node = $(selector);
  if (node && node.value !== String(value ?? '')) {
    node.value = value;
  }
}

function renderHero(status) {
  const portfolio = status.portfolio;
  const brain = status.brain;
  const modeChip = $('#mode-chip');
  const brainChip = $('#brain-chip');

  modeChip.textContent = status.mode === 'paper' ? 'Paper Trading' : 'Live Trading';
  const modeClass = `chip ${status.mode === 'paper' ? 'tone-paper' : 'tone-live'}`;
  if (modeChip.className !== modeClass) {
    modeChip.className = modeClass;
  }

  brainChip.textContent = brain.enabled ? `AI ${brain.status}` : 'AI disabled';
  const brainClass = `chip ${brain.enabled ? 'tone-hold' : 'tone-neutral'}`;
  if (brainChip.className !== brainClass) {
    brainChip.className = brainClass;
  }

  setText('#uptime-chip', `Uptime ${Math.round(status.uptimeSeconds / 60)}m`);
  setText('#last-refresh', new Date(status.timestamp).toLocaleTimeString());

  setText('#metric-equity', formatMoney(portfolio.equity));
  setText('#metric-exposure', `Exposure ${formatMoney(portfolio.exposureUsd)}`);

  const pnlNode = $('#metric-pnl');
  const pnlText = `${portfolio.totalPnl >= 0 ? '+' : ''}${formatMoney(portfolio.totalPnl)}`;
  if (pnlNode.textContent !== pnlText) {
    pnlNode.textContent = pnlText;
  }
  const pnlClass = `metric-value ${portfolio.totalPnl >= 0 ? 'positive' : 'negative'}`;
  if (pnlNode.className !== pnlClass) {
    pnlNode.className = pnlClass;
  }

  setText('#metric-pnl-detail', `Realized ${formatMoney(portfolio.realizedPnl)} / Unrealized ${formatMoney(portfolio.unrealizedPnl)}`);
  setText('#metric-winrate', portfolio.winRate === null ? '-' : `${portfolio.winRate.toFixed(1)}%`);
  setText('#metric-trades', `${portfolio.closedTrades} closed trades`);
  setText('#metric-positions', String(portfolio.openPositionCount));
  setText('#metric-cash', `Cash ${formatMoney(portfolio.cashBalance)}`);
  setText('#metric-ai-calls', String(brain.callCount));
  setText('#metric-ai-success', brain.successRate === null ? 'Success rate -' : `Success rate ${brain.successRate.toFixed(1)}%`);

  const scanned = status.market.chainSummary.reduce((sum, chain) => sum + Number(chain.tokensScanned || 0), 0);
  setText('#metric-scans', formatCompact(scanned));
  setText('#metric-scanner-detail', `Tracked tokens ${status.market.trackedTokens.length}`);

  const healthNotices = $('#health-notices');
  const health = appState.health;
  if (!healthNotices) return;
  if (!health) {
    setHtmlIfChanged('#health-notices', 'healthNotices', '');
    return;
  }

  const degradedReasons = Array.isArray(health.degradedReasons) ? health.degradedReasons : [];
  const unhealthyReasons = Array.isArray(health.unhealthyReasons) ? health.unhealthyReasons : [];
  if (health.ok === null) {
    const errorMsg = health.error || 'health status unavailable';
    setHtmlIfChanged('#health-notices', 'healthNotices', `<div class="health-notice health-notice-neutral">Health: ${escapeHtml(errorMsg)}</div>`);
    return;
  }
  if (health.ok === false) {
    const reasons = unhealthyReasons.length
      ? unhealthyReasons
      : (degradedReasons.length ? degradedReasons : ['health_check_failed']);
    setHtmlIfChanged('#health-notices', 'healthNotices', reasons.map((reason) => (
      `<div class="health-notice health-notice-error">Critical: ${escapeHtml(formatHealthReason(reason))}</div>`
    )).join(''));
    return;
  }

  if (degradedReasons.length > 0) {
    setHtmlIfChanged('#health-notices', 'healthNotices', degradedReasons.map((reason) => (
      `<div class="health-notice health-notice-warning">Degraded: ${escapeHtml(formatHealthReason(reason))}</div>`
    )).join(''));
    return;
  }

  setHtmlIfChanged('#health-notices', 'healthNotices', '');
}

function renderChainStatus(status) {
  const html = status.market.chainSummary.map((chain) => `
    ${(() => {
      const momentum = chain.strategies?.momentum || {};
      const swing = chain.strategies?.swing || {};
      const momentumLabel = `Momentum: ${momentum.status || 'idle'} (${Number(momentum.tokensScanned || 0)})`;
      const swingLabel = `Swing: ${swing.status || 'idle'} (${Number(swing.tokensScanned || 0)})`;
      return `
    <article class="chain-card">
      <div class="chain-card-header">
        <strong>${escapeHtml(chain.name)}</strong>
        <span class="chip ${chain.status === 'scanning' ? 'tone-buy' : chain.status === 'error' ? 'tone-sell' : 'tone-neutral'}">${escapeHtml(chain.status)}</span>
      </div>
      <div class="chain-meta">
        <span>Tracked: ${chain.tracked}</span>
        <span>Buy signals: ${chain.buySignals}</span>
        <span>Open positions: ${chain.openPositions}</span>
        <span>Scanned this loop: ${chain.tokensScanned}</span>
      </div>
      <div class="chain-meta" style="margin-top:0.5rem;">
        <span>${escapeHtml(momentumLabel)}</span>
        <span>${escapeHtml(swingLabel)}</span>
      </div>
      <div class="signal-meta" style="margin-top:0.65rem;">
        ${escapeHtml(chain.currentToken || '-')}<br>
        Updated ${escapeHtml(formatAgo(chain.lastUpdate))}
      </div>
    </article>
      `;
    })()}
  `).join('');
  setHtmlIfChanged('#chain-status-grid', 'chainStatusGrid', html);
}

function renderPositions(status) {
  const positions = status.portfolio.positions;

  if (!positions.length) {
    setHtmlIfChanged('#positions-table', 'positionsTable', '<tr><td colspan="7" class="empty-row">No open positions.</td></tr>');
    return;
  }

  const html = positions.map((position) => `
    <tr>
      <td>
        <div class="token-stack">
          <strong>${escapeHtml(position.symbol)}</strong>
          <small>${escapeHtml(position.address)}</small>
        </div>
      </td>
      <td>${escapeHtml(position.chain)}</td>
      <td>${formatMoney(position.entryPrice)}</td>
      <td>${formatMoney(position.currentPrice)}</td>
      <td>${formatMoney(position.positionValueUsd)}</td>
      <td class="${position.unrealizedPnl >= 0 ? 'positive' : 'negative'}">
        ${position.unrealizedPnl >= 0 ? '+' : ''}${formatMoney(position.unrealizedPnl)}<br>
        <span class="mono">${formatPct(position.unrealizedPnlPct)}</span>
      </td>
      <td>
        <span class="chip ${toneForSignal(position.signalSource === 'AI' ? 'HOLD' : 'BUY')}">${escapeHtml(position.signalSource)}</span>
      </td>
    </tr>
  `).join('');
  setHtmlIfChanged('#positions-table', 'positionsTable', html);
}

function renderTrades(status) {
  const trades = status.portfolio.recentTrades;

  if (!trades.length) {
    setHtmlIfChanged('#trades-table', 'tradesTable', '<tr><td colspan="8" class="empty-row">No trades yet.</td></tr>');
    return;
  }

  const html = trades.map((trade) => `
    <tr>
      <td>${new Date(trade.timestamp).toLocaleTimeString()}</td>
      <td><span class="chip ${trade.type === 'BUY' ? 'tone-buy' : 'tone-sell'}">${escapeHtml(trade.type)}</span></td>
      <td>
        <div class="token-stack">
          <strong>${escapeHtml(trade.symbol)}</strong>
          <small>${escapeHtml(trade.address)}</small>
        </div>
      </td>
      <td>${escapeHtml(trade.chain)}</td>
      <td>${formatMoney(trade.valueUsd)}</td>
      <td class="${trade.pnl === null ? 'neutral' : trade.pnl >= 0 ? 'positive' : 'negative'}">
        ${trade.pnl === null ? '-' : `${trade.pnl >= 0 ? '+' : ''}${formatMoney(trade.pnl)}`}
      </td>
      <td>${escapeHtml(trade.reason || '-')}</td>
      <td>${escapeHtml(trade.signalSource || 'technical')}</td>
    </tr>
  `).join('');
  setHtmlIfChanged('#trades-table', 'tradesTable', html);
}

function renderTracked(status) {
  const tracked = status.market.trackedTokens;

  if (!tracked.length) {
    setHtmlIfChanged('#tracked-table', 'trackedTable', '<tr><td colspan="8" class="empty-row">Scanner is still warming up.</td></tr>');
    return;
  }

  const html = tracked.map((token) => `
    <tr>
      <td>
        <div class="token-stack">
          <strong>${escapeHtml(token.symbol)}</strong>
          <small>${escapeHtml(token.address)}</small>
        </div>
      </td>
      <td>${escapeHtml(token.chain)}</td>
      <td>${formatMoney(token.price)}</td>
      <td class="${token.priceChange24h >= 0 ? 'positive' : 'negative'}">${formatPct(token.priceChange24h)}</td>
      <td>${formatMoney(token.liquidityUsd)}</td>
      <td><span class="chip ${toneForSignal(token.finalSignal)}">${escapeHtml(token.finalSignal)}</span></td>
      <td>${token.indicators.rsi ? escapeHtml(String(token.indicators.rsi)) : '-'}</td>
      <td>${token.indicators.volumeSpike ? `${escapeHtml(String(token.indicators.volumeSpike))}x` : '-'}</td>
    </tr>
  `).join('');
  setHtmlIfChanged('#tracked-table', 'trackedTable', html);
}

function renderSignals(status) {
  const signals = status.market.recentSignals;

  if (!signals.length) {
    setHtmlIfChanged('#signals-feed', 'signalsFeed', '<div class="empty-state">No signals recorded yet.</div>');
    return;
  }

  const html = signals.map((signal) => `
    <article class="signal-item">
      <div class="signal-headline">
        <strong class="signal-token">${escapeHtml(signal.symbol || '-')}</strong>
        <span class="signal-chain">${escapeHtml(signal.chain || '-')}</span>
      </div>
      <div class="signal-stats">${formatMoney(signal.price)} | ${escapeHtml(signal.finalSignal || '-')}</div>
      <div class="signal-meta">
        <div class="signal-line">Tech ${escapeHtml(signal.technicalSignal || '-')} -> ${escapeHtml(signal.finalSignal || '-')}</div>
        <div class="signal-line">RSI ${signal.rsi || '-'} | Vol ${signal.volumeSpike || '-'}</div>
        <div class="signal-age">${escapeHtml(formatAgo(signal.timestamp))}</div>
      </div>
    </article>
  `).join('');
  setHtmlIfChanged('#signals-feed', 'signalsFeed', html);
}

function renderPortfolioChart(status) {
  const html = chartSvg(status.portfolio.pnlHistory, 'equity', 'Portfolio equity');
  setHtmlIfChanged('#portfolio-chart', 'portfolioChart', html);
}

function renderResultSummary(targetSelector, result, type) {
  const node = $(targetSelector);
  if (!result) {
    node.textContent = type === 'backtest'
      ? 'Backtest output will appear here once the bot has enough local history.'
      : 'Synthetic scenario results will appear here.';
    return;
  }

  node.innerHTML = `
    <strong>${type === 'backtest' ? escapeHtml(result.symbol || 'Backtest') : `${escapeHtml(result.scenario)} scenario`}</strong><br>
    Ending balance ${formatMoney(result.endingBalance)}<br>
    Return <span class="${result.totalReturn >= 0 ? 'positive' : 'negative'}">${formatPct(result.totalReturn)}</span><br>
    Trades ${result.tradeCount} | Win rate ${result.winRate === null ? '-' : `${result.winRate.toFixed(1)}%`} | Max drawdown ${formatPct(-Math.abs(result.maxDrawdownPct || 0))}
  `;
}

function renderBacktest() {
  renderResultSummary('#backtest-summary', appState.backtest, 'backtest');
  const html = appState.backtest
    ? chartSvg(appState.backtest.equityCurve, 'equity', 'Backtest equity')
    : '<div class="chart-empty">No backtest run yet.</div>';
  setHtmlIfChanged('#backtest-chart', 'backtestChart', html);
}

function renderSimulation() {
  renderResultSummary('#simulation-summary', appState.simulation, 'simulation');
  const html = appState.simulation
    ? chartSvg(appState.simulation.equityCurve, 'equity', 'Simulation equity')
    : '<div class="chart-empty">No simulation run yet.</div>';
  setHtmlIfChanged('#simulation-chart', 'simulationChart', html);
}

function renderAiPreview() {
  const preview = appState.aiPreview;

  if (!preview) {
    setText('#ai-preview', 'No preview requested yet.');
    return;
  }

  const html = `
    <strong>${escapeHtml(preview.token.symbol)} on ${escapeHtml(preview.token.chain)}</strong><br>
    Price ${formatMoney(preview.token.price)} | Liquidity ${formatMoney(preview.token.liquidityUsd)} | Volume ${formatMoney(preview.token.volume24h)}<br>
    Technical: ${escapeHtml(preview.technical.signal || 'UNKNOWN')}<br>
    ${preview.ai
      ? `AI: <span class="${preview.ai.signal === 'BUY' ? 'positive' : preview.ai.signal === 'SELL' ? 'negative' : 'neutral'}">${escapeHtml(preview.ai.signal)}</span> (${preview.ai.confidence || 0}% confidence)<br>${escapeHtml(preview.ai.reason || '')}`
      : 'AI: unavailable or disabled.'}
  `;
  setHtmlIfChanged('#ai-preview', 'aiPreview', html);
}

function populateTokenOptions(tokens) {
  const html = tokens.map((token) => (
    `<option value="${escapeHtml(token.address)}">${escapeHtml(token.symbol)} - ${escapeHtml(token.chain)}</option>`
  )).join('');
  setHtmlIfChanged('#token-options', 'tokenOptions', html);
}

function syncConfigForm(config) {
  if (!config) return;
  setValueIfChanged('#paperTrading', String(config.paperTrading));
  setValueIfChanged('#paperBalance', config.paperBalance);
  setValueIfChanged('#emaFast', config.strategy.emaFast);
  setValueIfChanged('#emaSlow', config.strategy.emaSlow);
  setValueIfChanged('#rsiPeriod', config.strategy.rsiPeriod);
  setValueIfChanged('#rsiBuyThreshold', config.strategy.rsiBuyThreshold);
  setValueIfChanged('#volumeSpikeMultiplier', config.strategy.volumeSpikeMultiplier);
  setValueIfChanged('#sellTiers', JSON.stringify(config.strategy.sellTiers, null, 2));
  setValueIfChanged('#scanIntervalSeconds', config.bot.scanIntervalSeconds);
  setValueIfChanged('#maxPositionSizePct', config.risk.maxPositionSizePct);
  setValueIfChanged('#stopLossPct', config.risk.stopLossPct);
  setValueIfChanged('#takeProfitPct', config.risk.takeProfitPct);
  setValueIfChanged('#minLiquidityUsd', config.risk.minLiquidityUsd);
  setValueIfChanged('#maxConcurrentPositions', config.risk.maxConcurrentPositions);
  setValueIfChanged('#dailyDrawdownLimitPct', config.risk.dailyDrawdownLimitPct);
  setValueIfChanged('#anthropicEnabled', String(config.anthropic.enabled));
  setValueIfChanged('#anthropicModel', config.anthropic.model);
  setValueIfChanged('#anthropicTemperature', config.anthropic.temperature);
}

function renderAll() {
  if (!appState.status) return;
  renderHero(appState.status);
  renderPortfolioChart(appState.status);
  renderChainStatus(appState.status);
  renderPositions(appState.status);
  renderTrades(appState.status);
  renderTracked(appState.status);
  renderSignals(appState.status);
  populateTokenOptions(appState.status.market.trackedTokens);
  renderBacktest();
  renderSimulation();
  renderAiPreview();
}

function scheduleRender({ refreshSupplemental = false } = {}) {
  pendingSupplementalRefresh = pendingSupplementalRefresh || refreshSupplemental;
  if (renderTimer) {
    return;
  }

  const elapsed = Date.now() - lastRenderAt;
  const delay = Math.max(0, 500 - elapsed);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    lastRenderAt = Date.now();
    renderAll();
    if (pendingSupplementalRefresh) {
      pendingSupplementalRefresh = false;
      loadSupplementalData(true);
    }
  }, delay);
}

function loadSupplementalData(force = false) {
  if (force) {
    appState.correlationLoadedAt = 0;
    appState.newsLoadedAt = 0;
  }

  renderCorrelationHeatmap().catch((error) => {
    const target = document.getElementById('correlation-heatmap');
    if (target) {
      target.innerHTML = `<div class="empty-state">Error loading correlation: ${escapeHtml(error.message)}</div>`;
    }
  });

  renderNewsFeed().catch((error) => {
    const target = document.getElementById('news-feed');
    if (target) {
      target.innerHTML = `<div class="empty-state">Error loading news: ${escapeHtml(error.message)}</div>`;
    }
  });
}

async function loadDashboard(options = {}) {
  const includeConfig = Boolean(options.includeConfig);
  const refreshSupplemental = Boolean(options.refreshSupplemental);
  const requests = [
    fetchJson('/api/status'),
    includeConfig ? fetchJson('/api/config') : Promise.resolve(appState.config),
    fetchHealthStatus(),
  ];
  const [statusResult, configResult, healthResult] = await Promise.allSettled(requests);
  appState.status = statusResult.status === 'fulfilled' ? statusResult.value : null;
  appState.config = configResult.status === 'fulfilled' ? configResult.value : null;
  appState.health = (healthResult.status === 'fulfilled' && healthResult.value && typeof healthResult.value === 'object')
    ? healthResult.value
    : { ok: null, degraded: false, degradedReasons: [], error: 'health fetch failed' };
  if (appState.status) syncConfigForm(appState.config);
  lastStateSignature = appState.status ? buildStateSignature(appState.status) : '';
  scheduleRender({ refreshSupplemental });
}

async function saveConfig(event) {
  event.preventDefault();
  const payload = {
    paperTrading: $('#paperTrading').value === 'true',
    paperBalance: Number($('#paperBalance').value),
    strategy: {
      emaFast: Number($('#emaFast').value),
      emaSlow: Number($('#emaSlow').value),
      rsiPeriod: Number($('#rsiPeriod').value),
      rsiBuyThreshold: Number($('#rsiBuyThreshold').value),
      volumeSpikeMultiplier: Number($('#volumeSpikeMultiplier').value),
      sellTiers: JSON.parse($('#sellTiers').value || '[]'),
    },
    risk: {
      maxPositionSizePct: Number($('#maxPositionSizePct').value),
      stopLossPct: Number($('#stopLossPct').value),
      takeProfitPct: Number($('#takeProfitPct').value),
      minLiquidityUsd: Number($('#minLiquidityUsd').value),
      maxConcurrentPositions: Number($('#maxConcurrentPositions').value),
      dailyDrawdownLimitPct: Number($('#dailyDrawdownLimitPct').value),
    },
    bot: {
      scanIntervalSeconds: Number($('#scanIntervalSeconds').value),
    },
    anthropic: {
      enabled: $('#anthropicEnabled').value === 'true',
      model: $('#anthropicModel').value.trim(),
      temperature: Number($('#anthropicTemperature').value),
    },
  };

  $('#config-status').textContent = 'Saving control profile...';

  try {
    await fetchJson('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('#config-status').textContent = 'Configuration saved. Scanner schedule updated.';
    await loadDashboard({ includeConfig: true, refreshSupplemental: true });
  } catch (error) {
    $('#config-status').textContent = error.message;
  }
}

async function requestAiPreview(event) {
  event.preventDefault();
  $('#ai-preview').textContent = 'Evaluating token through the Anthropic brain...';

  try {
    appState.aiPreview = await fetchJson('/api/brain/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: $('#ai-chain').value,
        tokenAddress: $('#ai-token').value.trim(),
      }),
    });
    renderAiPreview();
  } catch (error) {
    $('#ai-preview').textContent = error.message;
  }
}

async function requestBacktest(event) {
  event.preventDefault();
  $('#backtest-summary').textContent = 'Running backtest...';

  try {
    appState.backtest = await fetchJson('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenAddress: $('#backtest-token').value.trim(),
        startingBalance: Number($('#backtest-balance').value),
        tradePct: Number($('#backtest-trade-pct').value) / 100,
      }),
    });
    renderBacktest();
  } catch (error) {
    $('#backtest-summary').textContent = error.message;
    $('#backtest-chart').innerHTML = '<div class="chart-empty">Backtest unavailable.</div>';
  }
}

async function requestSimulation(event) {
  event.preventDefault();
  $('#simulation-summary').textContent = 'Running synthetic scenario...';

  try {
    appState.simulation = await fetchJson('/api/simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: $('#simulation-scenario').value,
        periods: Number($('#simulation-periods').value),
        startPrice: Number($('#simulation-price').value),
        startingBalance: Number($('#simulation-balance').value),
        tradePct: Number($('#simulation-trade-pct').value) / 100,
      }),
    });
    renderSimulation();
  } catch (error) {
    $('#simulation-summary').textContent = error.message;
    $('#simulation-chart').innerHTML = '<div class="chart-empty">Simulation unavailable.</div>';
  }
}

async function resetPaperPortfolio() {
  const configured = Number($('#paperBalance').value || 10000);
  const confirmed = window.confirm(`Reset the in-memory paper portfolio to ${formatMoney(configured)}?`);
  if (!confirmed) return;

  try {
    await fetchJson('/api/paper/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance: configured }),
    });
    await loadDashboard();
  } catch (error) {
    window.alert(error.message);
  }
}

function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'state') {
        const nextStatus = data.payload;
        const nextSignature = buildStateSignature(nextStatus);
        if (nextSignature === lastStateSignature) {
          return;
        }
        lastStateSignature = nextSignature;
        appState.status = nextStatus;
        scheduleRender();
      }
    } catch (error) {
      console.warn('WebSocket payload error', error);
    }
  });

  socket.addEventListener('close', () => {
    window.setTimeout(connectSocket, 2500);
  });
}

function bindEvents() {
  $('#config-form').addEventListener('submit', saveConfig);
  $('#ai-form').addEventListener('submit', requestAiPreview);
  $('#backtest-form').addEventListener('submit', requestBacktest);
  $('#simulation-form').addEventListener('submit', requestSimulation);
  $('#refresh-button').addEventListener('click', () => loadDashboard({ includeConfig: true, refreshSupplemental: true }));
  $('#reset-paper-button').addEventListener('click', resetPaperPortfolio);
}

async function start() {
  bindEvents();
  await loadDashboard({ includeConfig: true, refreshSupplemental: true });
  connectSocket();
  window.setInterval(() => {
    loadDashboard({ includeConfig: false, refreshSupplemental: false }).catch((error) => {
      console.warn('Dashboard polling refresh failed', error);
    });
  }, 20000);
}

start().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<div class="panel" style="margin:1rem;">${escapeHtml(error.message)}</div>`);
});
