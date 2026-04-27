const state = {
  status: null,
  health: null,
  paused: false,
  pendingStatus: null,
  pendingHealth: null,
  pauseUntil: 0,
  intervalMs: 12000,
  timer: null,
  visible: {
    positions: 12,
    tracked: Number.MAX_SAFE_INTEGER,
    signals: Number.MAX_SAFE_INTEGER,
    trades: 12,
  },
  cache: {
    kpi: '',
    chain: '',
    positions: '',
    tracked: '',
    signals: '',
    trades: '',
    correlation: '',
  },
  correlationLoaded: false,
  trackedFilters: {
    chain: '',
    signal: '',
    sortBy: '',
    sortAsc: true,
  },
};

function $(selector) {
  return document.querySelector(selector);
}

function formatMoney(value) {
  const num = Number(value || 0);
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function formatMoneyOrDash(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return formatMoney(num);
}

function formatPct(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '-';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function formatAge(iso) {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function formatDuration(secondsInput) {
  const s = Math.max(0, Math.floor(Number(secondsInput || 0)));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function normalizeSignal(value) {
  return String(value || '').trim().toUpperCase();
}

function signalTone(value) {
  const signal = normalizeSignal(value);
  if (!signal) return 'unknown';
  if (signal.includes('INSUFFICIENT')) return 'insufficient';
  if (signal.includes('STRONG') && signal.includes('BUY')) return 'strong-buy';
  if (signal.includes('STRONG') && signal.includes('SELL')) return 'strong-sell';
  if (signal.includes('BUY')) return 'buy';
  if (signal.includes('SELL')) return 'sell';
  if (signal.includes('HOLD')) return 'hold';
  if (signal.includes('WATCH') || signal.includes('WAIT') || signal.includes('NEUTRAL')) return 'watch';
  return 'unknown';
}

function signalToneClass(value) {
  return `signal-${signalTone(value)}`;
}

function renderSignalBadge(value) {
  const label = normalizeSignal(value) || '-';
  return `<span class="signal-badge ${signalToneClass(label)}">${label}</span>`;
}

function getNotBoughtReason(row = {}) {
  const technical = normalizeSignal(row.technicalSignal);
  const final = normalizeSignal(row.finalSignal);
  const aiReason = String(row.aiReason || '').trim();
  const executionFailure = String(row.notBoughtReason || row.lastBuyFailure || '').trim();
  if (executionFailure) return executionFailure;
  if (aiReason) return aiReason;
  if (final === 'BUY' && String(row.aiVerificationStatus || '').toLowerCase() === 'pending') {
    return 'technical BUY; AI verification pending';
  }
  if (!technical && !final) return '-';
  if (technical === 'BUY' && final !== 'BUY') return 'buy blocked by AI/risk gate';
  if (final.includes('INSUFFICIENT')) return 'insufficient market data';
  return '-';
}

function formatDiscoveryLane(value) {
  const lane = String(value || '').trim().toLowerCase();
  if (lane === 'core') return 'Core';
  if (lane === 'exploration') return 'Explore';
  return '';
}

function formatAiVerification(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'pending') return 'AI pending';
  if (status === 'ready') return 'AI cached';
  if (status === 'queued') return 'AI queued';
  return '';
}

function renderTrackedMeta(row = {}) {
  const parts = [];
  const lane = formatDiscoveryLane(row.discoveryLane);
  const aiState = formatAiVerification(row.aiVerificationStatus);
  if (row.strategy) parts.push(String(row.strategy));
  if (lane) parts.push(lane);
  if (aiState) parts.push(aiState);
  return parts.join(' | ');
}

function setText(id, value) {
  const node = $(id);
  if (!node) return;
  const next = String(value ?? '-');
  if (node.textContent !== next) node.textContent = next;
}

function renderCatalystBanner(status) {
  const target = $('#catalyst-banner');
  if (!target) return;

  const pairs = Array.isArray(status?.market?.catalystPairs)
    ? status.market.catalystPairs
    : [];
  const display = pairs.slice(0, 8);

  if (!display.length) {
    target.classList.remove('hidden');
    target.textContent = 'Catalyst cache: none';
    return;
  }

  target.classList.remove('hidden');
  target.textContent = `Catalyst cache: ${display.join(', ')}`;
}

async function fetchJson(url, timeoutMs = 7000, options = {}) {
  const allowNonOk = options?.allowNonOk === true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }

    if (!res.ok && !allowNonOk) {
      throw new Error((body && body.error) || `Request failed (${res.status})`);
    }

    if (!body || typeof body !== 'object') {
      body = {};
    }

    if (!res.ok) {
      body.__httpStatus = res.status;
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function isUserInteracting() {
  if (Date.now() < state.pauseUntil) return true;
  const sel = window.getSelection ? window.getSelection() : null;
  return Boolean(sel && !sel.isCollapsed && sel.rangeCount > 0);
}

function markInteraction(ms = 1800) {
  state.pauseUntil = Math.max(state.pauseUntil, Date.now() + ms);
}

function summarizeItems(items, builder, limit = 8) {
  if (!Array.isArray(items) || !items.length) return 'none';
  return items.slice(0, limit).map((item, index) => {
    try {
      return builder(item, index);
    } catch (_) {
      return `idx:${index}`;
    }
  }).join('~');
}

function buildSignature(status, health) {
  if (!status) return 'empty';
  const p = status.portfolio || {};
  const m = status.market || {};
  return [
    status.mode,
    p.equity,
    p.totalPnl,
    p.openPositionCount,
    Number(p.untrackedWalletPositionValueUsd || 0),
    summarizeItems(p.positions, (position) => `${position.address}:${position.currentPrice}:${position.unrealizedPnl}`),
    summarizeItems(p.untrackedWalletPositions, (position) => `${position.chainKey || position.chain}:${position.address}:${position.quantity}:${position.valueUsd}`),
    (m.trackedTokens || []).length,
    summarizeItems(m.recentSignals, (signal) => `${signal.timestamp}:${signal.symbol}:${signal.finalSignal}`),
    summarizeItems(p.recentTrades, (trade) => `${trade.txid || trade.timestamp}:${trade.type}:${trade.symbol}:${trade.valueUsd}`),
    health ? `${health.ok}:${health.degraded}:${(health.degradedReasons || []).join(',')}:${(health.unhealthyReasons || []).join(',')}` : 'health-none',
  ].join('|');
}

function applyPendingIfReady() {
  if (!state.pendingStatus) return;
  if (state.paused || isUserInteracting()) return;
  state.status = state.pendingStatus;
  state.health = state.pendingHealth;
  state.pendingStatus = null;
  state.pendingHealth = null;
  renderAll();
}

function renderKpis(status, health) {
  const p = status.portfolio || {};
  const chainBalances = p.chainBalancesUsd || {};
  const unmanagedBalances = p.untrackedWalletPositionValueUsdByChain || {};
  const mismatchCount = Number(status.diagnostics?.scanCounterMismatchCount || 0);
  const sig = `${status.mode}|${status.uptimeSeconds}|${p.cashBalance}|${chainBalances.solana}|${chainBalances.bsc}|${chainBalances.base}|${chainBalances.kucoin}|${p.exposureUsd}|${p.totalPnl}|${p.openPositionCount}|${(status.market?.trackedTokens || []).length}|${health?.degraded}|${mismatchCount}`;
  if (state.cache.kpi === sig) return;
  state.cache.kpi = sig;

  setText('#kpi-mode', status.mode || '-');
  setText('#kpi-uptime', formatDuration(status.uptimeSeconds));
  setText('#kpi-live', formatDuration(status.totalRuntimeSeconds || status.uptimeSeconds));
  setText('#kpi-total-balance', formatMoney(p.cashBalance));
  setText('#kpi-balance-solana', formatMoneyOrDash(chainBalances.solana));
  setText('#kpi-balance-bsc', formatMoneyOrDash(chainBalances.bsc));
  setText('#kpi-balance-base', formatMoneyOrDash(chainBalances.base));
  const kucoinCash = Number(chainBalances.kucoin);
  const kucoinUnmanaged = Number(unmanagedBalances.kucoin || 0);
  const kucoinText = Number.isFinite(kucoinCash)
    ? `${formatMoneyOrDash(chainBalances.kucoin)}${kucoinUnmanaged > 0 ? ` (+${formatMoney(kucoinUnmanaged)} unmanaged)` : ''}`
    : formatMoneyOrDash(chainBalances.kucoin);
  setText('#kpi-balance-kucoin', kucoinText);
  setText('#kpi-invested-value', formatMoney(p.exposureUsd));
  setText('#kpi-pnl', formatMoney(p.totalPnl));
  setText('#kpi-positions', p.openPositionCount || 0);
  setText('#kpi-tracked', (status.market?.trackedTokens || []).length);

  const degradedReasons = Array.isArray(health?.degradedReasons) ? health.degradedReasons : [];
  const unhealthyReasons = Array.isArray(health?.unhealthyReasons) ? health.unhealthyReasons : [];
  const hasUnhealthy = unhealthyReasons.length > 0;
  const hasDegraded = Boolean(health?.degraded);
  const topReason = degradedReasons[0] || unhealthyReasons[0] || '';
  const reasonMap = {
    ws_discovery_unavailable_polling_only: 'polling-only discovery mode',
  };
  const reasonText = topReason ? (reasonMap[topReason] || topReason.replace(/_/g, ' ')) : '';

  const healthLabel = !health
    ? ''
    : hasUnhealthy
      ? 'ERROR'
      : hasDegraded
        ? 'DEGRADED'
        : (health.ok ? 'OK' : 'ERROR');

  const line = health
    ? `Health ${healthLabel}${reasonText ? ` (${reasonText})` : ''} | Updated ${formatAge(status.timestamp)}`
    : `Updated ${formatAge(status.timestamp)}`;
  setText('#status-line', line);

  const mismatchBadge = $('#scan-counter-mismatch-badge');
  if (mismatchBadge) {
    if (mismatchCount > 0) {
      mismatchBadge.classList.remove('hidden', 'ok', 'warn', 'bad');
      mismatchBadge.classList.add(mismatchCount >= 3 ? 'bad' : 'warn');
      mismatchBadge.textContent = `Scan counter mismatches: ${mismatchCount}`;
    } else {
      mismatchBadge.classList.remove('warn', 'bad');
      mismatchBadge.classList.add('hidden');
      mismatchBadge.textContent = '';
    }
  }

  const pnlNode = $('#kpi-pnl');
  if (pnlNode) {
    pnlNode.classList.toggle('good', Number(p.totalPnl) >= 0);
    pnlNode.classList.toggle('bad', Number(p.totalPnl) < 0);
  }
}

function renderChain(status) {
  const chains = Array.isArray(status.market?.chainSummary) ? status.market.chainSummary : [];
  const chainOrder = { kucoin: 0, bsc: 1, solana: 2, base: 3 };
  const orderedChains = [...chains].sort((a, b) => {
    const ai = Object.prototype.hasOwnProperty.call(chainOrder, a.chainKey) ? chainOrder[a.chainKey] : 99;
    const bi = Object.prototype.hasOwnProperty.call(chainOrder, b.chainKey) ? chainOrder[b.chainKey] : 99;
    return ai - bi;
  });
  const sig = orderedChains.map((c) => {
    const momentum = c.strategies?.momentum || {};
    const swing = c.strategies?.swing || null;
    const laneSig = momentum?.laneSummary
      ? `${momentum.laneSummary.coreSelected || 0}:${momentum.laneSummary.explorationSelected || 0}:${momentum.laneSummary.coreQualified || 0}:${momentum.laneSummary.explorationQualified || 0}`
      : '-';
    return `${c.chainKey}:${c.status}:${c.tracked}:${c.seenTokens || 0}:${c.buySignals}:${c.tokensScanned}:${c.discoveredTokens || 0}:${c.evaluatedTokens || 0}:${laneSig}:${momentum.currentToken || '-'}:${momentum.currentPair || '-'}:${swing?.currentToken || '-'}:${swing?.currentPair || '-'}`;
  }).join('|');
  if (state.cache.chain === sig) return;
  state.cache.chain = sig;

  const target = $('#chain-grid');
  if (!target) return;
  const laneClass = (laneStatus) => (laneStatus === 'error' ? 'bad' : laneStatus === 'scanning' ? 'ok' : 'warn');
  target.innerHTML = orderedChains.map((c) => {
    const cls = c.status === 'error' ? 'bad' : c.status === 'scanning' ? 'ok' : 'warn';
    const momentum = c.strategies?.momentum || {};
    const swing = c.strategies?.swing || null;
    const momentumToken = momentum.currentToken || '-';
    const momentumPair = momentum.currentPair || '-';
    const swingToken = swing?.currentToken || '-';
    const swingPair = swing?.currentPair || '-';
    const discovered = Number(c.discoveredTokens || 0);
    const evaluated = Number(c.evaluatedTokens || 0);
    const tracked = Number(c.tracked || 0);
    const seen = Number(c.seenTokens || 0);
    const seenLabel = seen > tracked ? ` (${seen} seen)` : '';
    const laneSummary = momentum?.laneSummary || null;
    const laneSummaryText = laneSummary
      ? `Core ${Number(laneSummary.coreSelected || 0)}/${Number(laneSummary.coreQualified || 0)} | Explore ${Number(laneSummary.explorationSelected || 0)}/${Number(laneSummary.explorationQualified || 0)} | Borderline ${Number(laneSummary.borderlineSelected || 0)}/${Number(laneSummary.borderlineQualified || 0)}`
      : '';
    const swingBoxes = swing ? `
        <div class="lane-box">
          <div class="muted">Swing</div>
          <div><span class="badge ${laneClass(swing.status)}">${swing.status || 'idle'}</span> ${Number(swing.tokensScanned || 0)}</div>
        </div>
        <div class="lane-box">
          <div class="muted">Swing Now</div>
          <div class="lane-text">${swingToken} | ${swingPair}</div>
        </div>` : '';
    return `<article class="chain">
      <div class="title"><strong>${c.name}</strong><span class="badge ${cls}">${c.status}</span></div>
      <div class="muted">Discovered (universe): ${discovered} | Evaluated (cycle): ${evaluated} | Tracked: ${tracked}${seenLabel}</div>
      <div class="muted">Buy: ${c.buySignals}</div>
      <div class="chain-lanes">
        <div class="lane-box">
          <div class="muted">Momentum</div>
          <div><span class="badge ${laneClass(momentum.status)}">${momentum.status || 'idle'}</span> ${Number(momentum.tokensScanned || 0)}</div>
        </div>
        <div class="lane-box">
          <div class="muted">Momentum Now</div>
          <div class="lane-text">${momentumToken} | ${momentumPair}</div>
        </div>
        ${swingBoxes}
      </div>
      ${laneSummaryText ? `<div class="muted">BSC lanes: ${laneSummaryText}</div>` : ''}
      <div class="muted">Open: ${c.openPositions} | Scanned (cycle): ${c.tokensScanned}</div>
      <div class="muted">Updated: ${formatAge(c.lastUpdate)}</div>
    </article>`;
  }).join('');
}

function renderPositions(status) {
  const all = Array.isArray(status.portfolio?.positions) ? status.portfolio.positions : [];
  const unmanaged = Array.isArray(status.portfolio?.untrackedWalletPositions) ? status.portfolio.untrackedWalletPositions : [];
  const rows = all.slice(0, state.visible.positions);
  const sig = [
    rows.map((r) => `${r.address}:${r.currentPrice}:${r.unrealizedPnl}`).join('|'),
    unmanaged.map((r) => `${r.chainKey || r.chain}:${r.address}:${r.quantity}:${r.valueUsd}`).join('|'),
    state.visible.positions,
  ].join('|');
  if (state.cache.positions === sig) return;
  state.cache.positions = sig;

  setText('#positions-count', `${rows.length} / ${all.length}${unmanaged.length ? ` | ${unmanaged.length} unmanaged` : ''}`);
  const note = $('#positions-note');
  if (note) {
    if (unmanaged.length) {
      const sample = unmanaged.slice(0, 2).map((position) => {
        const symbol = position.symbol || position.address || 'Unknown';
        const chain = position.chain || position.chainKey || '-';
        return `${symbol} on ${chain} (${formatMoneyOrDash(position.valueUsd)})`;
      }).join(' | ');
      const extra = unmanaged.length > 2 ? ` +${unmanaged.length - 2} more` : '';
      note.textContent = `Wallet holdings detected outside bot state: ${sample}${extra}. These are in the exchange wallet, but they are not under bot management, so they do not appear as open positions or receive bot exits.`;
      note.classList.remove('hidden');
    } else {
      note.textContent = '';
      note.classList.add('hidden');
    }
  }
  const body = $('#positions-body');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No open positions</td></tr>';
  } else {
    body.innerHTML = rows.map((p) => `<tr>
      <td>${p.symbol}<div class="muted">${p.address}</div></td>
      <td>${p.chain}</td>
      <td>${formatMoney(p.entryPrice)}</td>
      <td>${formatMoney(p.currentPrice)}</td>
      <td>${formatMoney(p.positionValueUsd)}</td>
      <td class="${Number(p.unrealizedPnl) >= 0 ? 'good' : 'bad'}">${formatMoney(p.unrealizedPnl)} (${formatPct(p.unrealizedPnlPct)})</td>
    </tr>`).join('');
  }

  const btn = $('#positions-more');
  if (btn) btn.style.display = all.length > state.visible.positions ? 'inline-block' : 'none';
}

function renderTracked(status) {
  const all = Array.isArray(status.market?.trackedTokens) ? status.market.trackedTokens : [];
  
  // Apply filters
  let rows = all.filter(t => {
    const chainMatch = !state.trackedFilters.chain || t.chain === state.trackedFilters.chain;
    const signalMatch = !state.trackedFilters.signal || t.finalSignal === state.trackedFilters.signal;
    return chainMatch && signalMatch;
  });
  
  // Apply sorting
  if (state.trackedFilters.sortBy === 'chain') {
    rows.sort((a, b) => {
      const aVal = a.chain || '';
      const bVal = b.chain || '';
      return state.trackedFilters.sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
  } else if (state.trackedFilters.sortBy === 'signal') {
    const signalOrder = { 'STRONG_BUY': 0, 'BUY': 1, 'HOLD': 2, 'WATCH': 3, 'SELL': 4, 'STRONG_SELL': 5 };
    rows.sort((a, b) => {
      const aVal = signalOrder[a.finalSignal] ?? 999;
      const bVal = signalOrder[b.finalSignal] ?? 999;
      return state.trackedFilters.sortAsc ? aVal - bVal : bVal - aVal;
    });
  }
  
  const first = rows[0];
  const last = rows[rows.length - 1];
  const sig = `${rows.length}|${first?.address || ''}:${first?.finalSignal || ''}|${last?.address || ''}:${last?.finalSignal || ''}|${state.trackedFilters.chain}|${state.trackedFilters.signal}|${state.trackedFilters.sortBy}`;
  if (state.cache.tracked === sig) return;
  state.cache.tracked = sig;

  setText('#tracked-count', `${rows.length} / ${all.length}`);
  const body = $('#tracked-body');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">No tracked tokens</td></tr>';
  } else {
    body.innerHTML = rows.map((t) => `<tr>
      <td>${t.symbol}<div class="muted">${t.address}</div>${renderTrackedMeta(t) ? `<div class="muted">${renderTrackedMeta(t)}</div>` : ''}</td>
      <td>${t.chain}</td>
      <td>${formatMoney(t.price)}</td>
      <td class="${Number(t.priceChange24h) >= 0 ? 'good' : 'bad'}">${formatPct(t.priceChange24h)}</td>
      <td>${formatMoney(t.liquidityUsd)} <span style="color:#888;font-size:11px;">(used)</span></td>
      <td class="signal-cell">${renderSignalBadge(t.finalSignal)}</td>
      <td>${t.indicators?.rsi ?? '-'}</td>
      <td>${getNotBoughtReason(t)}</td>
    </tr>`).join('');
  }

  const btn = $('#tracked-more');
  if (btn) btn.style.display = 'none';
}

function renderSignals(status) {
  const all = Array.isArray(status.market?.recentSignals) ? status.market.recentSignals : [];
  const rows = all;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const sig = `${rows.length}|${first?.timestamp || ''}:${first?.address || first?.symbol || ''}:${first?.finalSignal || ''}|${last?.timestamp || ''}:${last?.address || last?.symbol || ''}:${last?.finalSignal || ''}`;
  if (state.cache.signals === sig) return;
  state.cache.signals = sig;

  setText('#signals-count', `${rows.length} / ${all.length}`);
  const list = $('#signals-list');
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="item muted">No signals yet</div>';
  } else {
    list.innerHTML = rows.map((s) => `<article class="item">
      <strong>${s.symbol || '-'}</strong> <span class="muted">${s.chain || '-'}</span>
      ${renderTrackedMeta(s) ? `<div class="muted">${renderTrackedMeta(s)}</div>` : ''}
      <div>${formatMoney(s.price)} | ${renderSignalBadge(s.technicalSignal)} -> ${renderSignalBadge(s.finalSignal)}</div>
      <div class="muted">Not bought reason: ${getNotBoughtReason(s)}</div>
      <div class="muted">RSI ${s.rsi ?? '-'} | Vol ${s.volumeSpike ?? '-'} | ${formatAge(s.timestamp)}</div>
    </article>`).join('');
  }

  const btn = $('#signals-more');
  if (btn) btn.style.display = 'none';
}

function renderTrades(status) {
  const all = Array.isArray(status.portfolio?.recentTrades) ? status.portfolio.recentTrades : [];
  const rows = all.slice(0, state.visible.trades);
  const sig = rows.map((t) => `${t.timestamp}:${t.type}:${t.address}:${t.valueUsd}`).join('|') + `|${state.visible.trades}`;
  if (state.cache.trades === sig) return;
  state.cache.trades = sig;

  setText('#trades-count', `${rows.length} / ${all.length}`);
  const body = $('#trades-body');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">No trades yet</td></tr>';
  } else {
    body.innerHTML = rows.map((t) => `<tr>
      <td>${new Date(t.timestamp).toLocaleTimeString()}</td>
      <td>${t.type}</td>
      <td>${t.symbol}<div class="muted">${t.address}</div></td>
      <td>${t.chain}</td>
      <td>${formatMoneyOrDash(t.valueUsd)}</td>
      <td class="${t.pnl === null ? '' : Number(t.pnl) >= 0 ? 'good' : 'bad'}">${t.pnl === null ? '-' : formatMoney(t.pnl)}</td>
      <td>${t.reason || '-'}</td>
    </tr>`).join('');
  }

  const btn = $('#trades-more');
  if (btn) btn.style.display = all.length > state.visible.trades ? 'inline-block' : 'none';
}

function correlationCellColor(pct) {
  if (pct >= 80) return { bg: '#d97706', fg: '#fff' };
  if (pct >= 60) return { bg: '#f3bf67', fg: '#101a2b' };
  if (pct >= 30) return { bg: '#f4d89a', fg: '#101a2b' };
  if (pct > -30) return { bg: '#213150', fg: '#e7edf7' };
  if (pct > -60) return { bg: '#3c79b8', fg: '#fff' };
  return { bg: '#2d9b8a', fg: '#fff' };
}

async function loadCorrelation(force = false) {
  if (state.paused && !force) return;
  if (state.correlationLoaded && !force) return;
  const wrap = $('#correlation-wrap');
  if (wrap) wrap.innerHTML = '<div class="muted" style="padding:10px;">Loading correlation...</div>';
  try {
    const data = await fetchJson('/api/correlation', 10000);
    renderCorrelation(data);
    state.correlationLoaded = true;
  } catch (err) {
    if (wrap) wrap.innerHTML = `<div class="muted" style="padding:10px;">Correlation error: ${err.message}</div>`;
  }
}

function renderCorrelation(payload) {
  const tokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
  const matrix = Array.isArray(payload?.matrix) ? payload.matrix : [];
  const sig = `${tokens.join('|')}|${matrix.length}`;
  if (state.cache.correlation === sig) return;
  state.cache.correlation = sig;

  const meta = $('#correlation-meta');
  if (meta) {
    const source = payload?.source ? `source: ${payload.source}` : 'source: memory';
    const limitLabel = payload?.limitApplied ? ` | limit ${payload.limitApplied}` : '';
    setText('#correlation-meta', `${tokens.length} tokens | ${source}${limitLabel}`);
  }

  const wrap = $('#correlation-wrap');
  if (!wrap) return;
  if (!tokens.length || !matrix.length) {
    wrap.innerHTML = '<div class="muted" style="padding:10px;">No correlation data yet.</div>';
    return;
  }

  const labels = tokens.map((t) => String(t).replace(/^0x/i, '').slice(0, 6));
  let html = '<table class="heatmap-table"><thead><tr><th class="heatmap-label"></th>';
  labels.forEach((l) => { html += `<th class="heatmap-label">${l}</th>`; });
  html += '</tr></thead><tbody>';

  matrix.forEach((row, i) => {
    html += `<tr><th class="heatmap-label">${labels[i] || '-'}</th>`;
    row.forEach((v) => {
      const pct = Math.round(Number(v || 0) * 100);
      const { bg, fg } = correlationCellColor(pct);
      html += `<td class="heatmap-cell" style="background:${bg};color:${fg};" title="${pct}%">${pct}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderAll() {
  if (!state.status) return;
  renderCatalystBanner(state.status);
  renderKpis(state.status, state.health);
  renderChain(state.status);
  renderPositions(state.status);
  renderTracked(state.status);
  renderSignals(state.status);
  renderTrades(state.status);
}

async function tick() {
  try {
    const [status, health] = await Promise.all([
      fetchJson('/api/status', 7000),
      fetchJson('/api/health-lite', 7000, { allowNonOk: true }),
    ]);

    const nextSig = buildSignature(status, health);
    const prevSig = state.status ? buildSignature(state.status, state.health) : '';
    if (nextSig === prevSig) return;

    state.pendingStatus = status;
    state.pendingHealth = health;
    applyPendingIfReady();
  } catch (err) {
    setText('#status-line', `Update error: ${err.message}`);
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(tick, state.intervalMs);
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const key = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      const panel = $(`#tab-${key}`);
      if (panel) panel.classList.add('active');
      if (key === 'correlation') {
        loadCorrelation(false);
      }
      markInteraction(1200);
    });
  });
}

function bindControls() {
  $('#refresh-button')?.addEventListener('click', () => {
    markInteraction(800);
    tick();
  });

  $('#pause-button')?.addEventListener('click', () => {
    state.paused = !state.paused;
    setText('#pause-button', state.paused ? 'Resume Live Updates' : 'Pause Live Updates');
    if (!state.paused) applyPendingIfReady();
  });

  $('#positions-more')?.addEventListener('click', () => {
    state.visible.positions += 12;
    state.cache.positions = '';
    renderPositions(state.status || { portfolio: { positions: [] } });
  });

  $('#tracked-more')?.addEventListener('click', () => {
    state.visible.tracked += 16;
    state.cache.tracked = '';
    renderTracked(state.status || { market: { trackedTokens: [] } });
  });

  // Filter controls
  $('#tracked-filter-chain')?.addEventListener('change', (e) => {
    state.trackedFilters.chain = e.target.value;
    state.cache.tracked = '';
    renderTracked(state.status || { market: { trackedTokens: [] } });
  });

  $('#tracked-filter-signal')?.addEventListener('change', (e) => {
    state.trackedFilters.signal = e.target.value;
    state.cache.tracked = '';
    renderTracked(state.status || { market: { trackedTokens: [] } });
  });

  // Sortable headers
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const sortBy = th.dataset.sort;
      if (state.trackedFilters.sortBy === sortBy) {
        state.trackedFilters.sortAsc = !state.trackedFilters.sortAsc;
      } else {
        state.trackedFilters.sortBy = sortBy;
        state.trackedFilters.sortAsc = true;
      }
      // Update visual indicators
      document.querySelectorAll('th.sortable').forEach((h) => {
        h.classList.remove('sorted-asc', 'sorted-desc');
      });
      if (state.trackedFilters.sortBy === sortBy) {
        th.classList.add(state.trackedFilters.sortAsc ? 'sorted-asc' : 'sorted-desc');
      }
      state.cache.tracked = '';
      renderTracked(state.status || { market: { trackedTokens: [] } });
    });
  });

  $('#signals-more')?.addEventListener('click', () => {
    state.visible.signals += 12;
    state.cache.signals = '';
    renderSignals(state.status || { market: { recentSignals: [] } });
  });

  $('#trades-more')?.addEventListener('click', () => {
    state.visible.trades += 12;
    state.cache.trades = '';
    renderTrades(state.status || { portfolio: { recentTrades: [] } });
  });

  $('#correlation-refresh')?.addEventListener('click', () => {
    state.cache.correlation = '';
    state.correlationLoaded = false;
    loadCorrelation(true);
  });

  document.addEventListener('mousedown', () => markInteraction(2000), { passive: true });
  document.addEventListener('mouseup', () => {
    markInteraction(700);
    setTimeout(applyPendingIfReady, 200);
  }, { passive: true });
  document.addEventListener('keydown', () => markInteraction(1200), { passive: true });
  document.addEventListener('selectionchange', () => {
    if (window.getSelection && !window.getSelection().isCollapsed) {
      markInteraction(2400);
    }
  });

  document.addEventListener('visibilitychange', () => {
    state.intervalMs = document.hidden ? 30000 : 12000;
    startPolling();
    if (!document.hidden) tick();
  });
}

async function start() {
  bindTabs();
  bindControls();
  await tick();
  startPolling();
}

start().catch((err) => {
  setText('#status-line', `Startup error: ${err.message}`);
});
