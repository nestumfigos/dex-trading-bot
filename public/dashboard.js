// DEX TradeBot dashboard v2 — sidebar layout with paper/live toggle (2026-05-17 fix).
// Uses real endpoints: /api/status, /api/tracked-tokens, /api/ohlcv,
// /api/market-indicators, Week 6 observability.

const STATE = {
  bot: localStorage.getItem('dt.bot') || 'live',
  refreshMs: 5000,
  chartSymbol: localStorage.getItem('dt.chartSymbol') || 'BTCUSDT',
  chartInterval: localStorage.getItem('dt.chartInterval') || '5m',
  chart: null,
  candleSeries: null,
  volumeSeries: null,
};

const el = (id) => document.getElementById(id);
const esc = (v) => (v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const fmt = (n, d = 2) => Number.isFinite(Number(n)) ? Number(n).toFixed(d) : '—';
const fmtUSD = (n, d = 2) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(d)}` : '—';
const fmtPct = (n) => Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(2)}%` : '—';
const fmtTime = (iso) => { if (!iso) return '—'; try { return new Date(iso).toISOString().slice(11, 19); } catch { return '—'; } };
const fmtDateTime = (iso) => { if (!iso) return '—'; try { return new Date(iso).toISOString().slice(0, 19).replace('T', ' '); } catch { return '—'; } };
const fmtUptime = (sec) => {
  if (!Number.isFinite(Number(sec))) return '—';
  const s = Number(sec);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};

// ─── Base URL: switch port by selected bot ────────────────────────────────
function getBaseUrl() {
  const port = STATE.bot === 'live' ? '3002' : '3001';
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

async function api(path) {
  const t0 = performance.now();
  try {
    const res = await fetch(getBaseUrl() + path, { cache: 'no-store', mode: 'cors' });
    const ms = Math.round(performance.now() - t0);
    el('sb-latency').textContent = `${ms} ms`;
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ─── Renderers ─────────────────────────────────────────────────────────────

function renderTopbarAndBrand(status) {
  if (!status) return;
  const mode = (status.mode || STATE.bot).toUpperCase();
  el('sidebar-profile').textContent = mode;
  el('sidebar-uptime').textContent = `Uptime ${fmtUptime(status.uptimeSeconds)}`;
  el('sb-version').textContent = status.brain?.bot_version || status.version || 'v1';
  el('sb-status').textContent = status.health?.safeMode ? 'Safe Mode' : 'System Operational';
  // Settings card
  if (el('settings-mode')) el('settings-mode').textContent = mode;
  if (el('settings-uptime')) el('settings-uptime').textContent = fmtUptime(status.uptimeSeconds);
  if (el('settings-version')) el('settings-version').textContent = status.brain?.bot_version || 'v1';
  // Bot Status panel
  const p = status.portfolio || {};
  if (el('bot-mode')) el('bot-mode').textContent = mode;
  if (el('bot-strategy')) {
    const strategies = Object.keys(status.strategies || {}).join(' / ') || 'momentum';
    el('bot-strategy').textContent = strategies;
  }
  if (el('bot-positions')) el('bot-positions').textContent = String(p.openPositionCount || 0);
  if (el('bot-winrate')) el('bot-winrate').textContent = `${(p.winRate || 0).toFixed(1)}%`;
  if (el('bot-closed')) el('bot-closed').textContent = String(p.closedTrades || 0);
  if (el('bot-pf')) el('bot-pf').textContent = (p.profitFactor || 0).toFixed(2);
  if (el('bot-cons-losses')) el('bot-cons-losses').textContent = String(p.consecutiveLosses || 0);
  if (el('bot-slippage')) el('bot-slippage').textContent = `${(p.avgSlippageBps || 0).toFixed(1)} bps`;
}

function renderBalancesAndPnl(portfolio) {
  if (!portfolio) return;
  const equity = Number(portfolio.equity || 0);
  const cash = Number(portfolio.cashBalance || 0);
  const totalPnl = Number(portfolio.totalPnl || 0);
  const realizedPnl = Number(portfolio.realizedPnl || 0);
  const unrealizedPnl = Number(portfolio.unrealizedPnl || 0);
  const totalReturnPct = Number(portfolio.totalReturnPct || 0);

  el('kpi-total-balance').innerHTML = `${fmtUSD(equity)} <span class="card-suffix">USD</span>`;

  // Invested = exposureUsd (sum of position cost basis)
  const invested = Number(portfolio.exposureUsd || 0);
  if (el('kpi-invested')) {
    el('kpi-invested').textContent = fmtUSD(invested);
    const pct = equity > 0 ? (invested / equity) * 100 : 0;
    el('kpi-invested-pct').textContent = `${pct.toFixed(1)}% of equity`;
  }

  const breakdown = portfolio.chainBalancesUsd || {};
  const detailParts = Object.entries(breakdown)
    .filter(([, v]) => Number(v) > 0.01)
    .map(([k, v]) => `${k}: $${Number(v).toFixed(2)}`);
  el('kpi-balance-detail').textContent = detailParts.length > 0
    ? detailParts.join(' · ')
    : `Cash $${cash.toFixed(2)}`;

  // 24h PnL (best-effort from pnlHistory)
  const pnl24h = compute24hPnl(portfolio.pnlHistory) ?? unrealizedPnl;
  setPnl('kpi-pnl-24h', 'kpi-pnl-24h-pct', pnl24h, equity);
  setPnl('kpi-pnl-total', 'kpi-pnl-total-pct', totalPnl, equity);
  // Override total-pct with totalReturnPct if available
  if (Number.isFinite(totalReturnPct)) {
    el('kpi-pnl-total-pct').textContent = `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}%`;
  }
}

function compute24hPnl(pnlHistory) {
  if (!Array.isArray(pnlHistory) || pnlHistory.length === 0) return null;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = pnlHistory.filter((p) => new Date(p.timestamp || p.ts || 0).getTime() >= cutoff);
  if (recent.length < 2) return null;
  // Use totalPnl delta (cumulative bot PnL), not equity (which includes deposits).
  const first = Number(recent[0].totalPnl ?? recent[0].pnl ?? 0);
  const last = Number(recent[recent.length - 1].totalPnl ?? recent[recent.length - 1].pnl ?? 0);
  return last - first;
}

function setPnl(valueId, pctId, pnl, base) {
  const valEl = el(valueId);
  const pctEl = el(pctId);
  const card = valEl?.closest('.balance-card');
  if (!valEl || !pctEl || !card) return;
  card.classList.remove('pnl-positive', 'pnl-negative');
  if (!Number.isFinite(pnl)) { valEl.textContent = '—'; pctEl.textContent = '—'; return; }
  card.classList.add(pnl >= 0 ? 'pnl-positive' : 'pnl-negative');
  valEl.textContent = `${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}`;
  const pct = Number.isFinite(base) && base > 0 ? (pnl / base) * 100 : null;
  pctEl.textContent = pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function renderPositions(positions) {
  const arr = Array.isArray(positions) ? positions : [];
  el('orders-count').textContent = arr.length;
  el('positions-full-count').textContent = arr.length;

  const dashRows = arr.slice(0, 6).map((p) => {
    const pnl = Number(p.unrealizedPnl || 0);
    return `<tr>
      <td><strong>${esc(p.symbol)}</strong></td>
      <td class="side-buy">Long</td>
      <td>${fmtUSD(p.initialSizeUsd)}</td>
      <td>${fmt(p.entryPrice, 6)}</td>
      <td>${fmt(p.currentPrice, 6)}</td>
      <td class="${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}</td>
    </tr>`;
  }).join('');
  el('orders-body').innerHTML = dashRows || '<tr><td colspan="6" class="muted small">No open positions.</td></tr>';

  const fullRows = arr.map((p) => {
    const pnl = Number(p.unrealizedPnl || 0);
    const pnlPct = Number(p.unrealizedPnlPct || 0);
    const key = `${(p.chainKey || p.chain || '').toLowerCase()}:${String(p.address || p.symbol || '').toLowerCase()}`;
    return `<tr>
      <td><strong>${esc(p.symbol)}</strong></td>
      <td>${esc(p.chain)}</td>
      <td>${esc(p.strategy)}</td>
      <td>${fmtUSD(p.initialSizeUsd)}</td>
      <td>${fmt(p.entryPrice, 6)}</td>
      <td>${fmt(p.currentPrice, 6)}</td>
      <td class="${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}</td>
      <td class="${pnlPct >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(pnlPct)}</td>
      <td>${fmtDateTime(p.openedAt)}</td>
      <td><button class="btn-row-action" data-sell-key="${esc(key)}" data-symbol="${esc(p.symbol)}">Force Sell</button></td>
    </tr>`;
  }).join('');
  el('positions-full-body').innerHTML = fullRows || '<tr><td colspan="10" class="muted small">No open positions.</td></tr>';
  // Wire sell buttons (delegated would be cleaner; re-wired here per render)
  document.querySelectorAll('.btn-row-action[data-sell-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.sellKey;
      const sym = btn.dataset.symbol || key;
      // B4.dash.7: tightened confirmation. window.confirm is too easy to fat-finger;
      // also vulnerable to JS-injection bypass. Require operator to type the symbol
      // (case-insensitive) to confirm. Also surface the admin-token requirement.
      const typed = window.prompt(`Force-sell ${sym} at MARKET? This exits the position immediately and CANNOT be undone.\n\nType the symbol "${sym}" to confirm:`);
      if (typed == null) return; // cancel
      if (String(typed).trim().toUpperCase() !== String(sym).toUpperCase()) {
        alert(`Aborted: typed "${typed}" does not match "${sym}".`);
        return;
      }
      // B4.dash.7: ensure admin token attached. Server gates this route via
      // requireAdminToken (B1.1); without the header the request 401s.
      let token = getAdminToken();
      if (!token) token = promptAdminToken();
      if (!token) { alert('Admin token required for force-sell.'); return; }
      btn.disabled = true;
      btn.textContent = 'Selling...';
      try {
        const res = await fetch(getBaseUrl() + '/api/admin/sell-position', {
          method: 'POST', mode: 'cors',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ key }),
        });
        const j = await res.json().catch(() => null);
        if (res.ok && j?.ok) { btn.textContent = 'Sold ✓'; setTimeout(refreshAll, 1500); }
        else { btn.disabled = false; btn.textContent = 'Force Sell'; alert(`Sell failed: ${j?.error || res.status}`); }
      } catch (e) { btn.disabled = false; btn.textContent = 'Force Sell'; alert(`Sell error: ${e.message}`); }
    });
  });
}

function renderTrades(trades) {
  const arr = Array.isArray(trades) ? trades : [];
  el('trades-count').textContent = arr.length;
  el('trades-full-count').textContent = arr.length;

  const sorted = [...arr].sort((a, b) => {
    const ta = new Date(a.closedAt || a.timestamp || a.openedAt || 0).getTime();
    const tb = new Date(b.closedAt || b.timestamp || b.openedAt || 0).getTime();
    return tb - ta;
  });

  const dashRows = sorted.slice(0, 6).map((t) => {
    const pnl = Number(t.pnl || t.realizedPnl || 0);
    const side = (t.type || t.side || 'SELL').toUpperCase();
    const value = Number(t.valueUsd || t.filledValueUsd || 0);
    return `<tr>
      <td>${fmtTime(t.timestamp)}</td>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td class="${side === 'BUY' ? 'side-buy' : 'side-sell'}">${esc(side)}</td>
      <td>${fmtUSD(value)}</td>
      <td class="${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}</td>
    </tr>`;
  }).join('');
  el('trades-body').innerHTML = dashRows || '<tr><td colspan="5" class="muted small">No recent trades.</td></tr>';

  el('trades-full-body').innerHTML = sorted.slice(0, 100).map((t) => {
    const pnl = Number(t.pnl || t.realizedPnl || 0);
    const side = (t.type || t.side || 'SELL').toUpperCase();
    const value = Number(t.valueUsd || t.filledValueUsd || 0);
    return `<tr>
      <td>${fmtDateTime(t.timestamp)}</td>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td>${esc(t.chain)}</td>
      <td class="${side === 'BUY' ? 'side-buy' : 'side-sell'}">${esc(side)}</td>
      <td>${fmtUSD(value)}</td>
      <td class="${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}</td>
      <td class="muted small">${esc(t.reason || t.exitReason || '')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted small">No trades yet.</td></tr>';
}

function renderTracked(data) {
  const arr = Array.isArray(data?.tokens) ? data.tokens : (Array.isArray(data) ? data : []);
  el('watchlist-count').textContent = arr.length;

  // Pair selector table (top tracked by abs 24h change)
  const sorted = [...arr]
    .filter((t) => t && t.symbol)
    .sort((a, b) => Math.abs(Number(b.priceChange24h || 0)) - Math.abs(Number(a.priceChange24h || 0)))
    .slice(0, 15);
  el('pair-body').innerHTML = sorted.map((t) => {
    const chg = Number(t.priceChange24h || 0);
    return `<tr>
      <td><strong>${esc(t.symbol)}/USDT</strong></td>
      <td>${fmt(t.price, 6)}</td>
      <td class="${chg >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(chg)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" class="muted small">No tracked tokens.</td></tr>';

  // Full watchlist
  el('watchlist-body').innerHTML = arr.slice(0, 100).map((t) => {
    const chg = Number(t.priceChange24h || 0);
    const sig = t.finalSignal || t.technicalSignal || '—';
    const sigCls = sig === 'BUY' ? 'sig-buy' : sig === 'SELL' ? 'sig-sell' : 'sig-hold';
    return `<tr>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td>${esc(t.chain)}</td>
      <td>${fmt(t.price, 6)}</td>
      <td class="${chg >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(chg)}</td>
      <td class="${sigCls}">${esc(sig)}</td>
      <td class="muted small">${esc(t.aiReason || t.notBoughtReason || '')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted small">No tracked tokens.</td></tr>';

  // Topbar price banner (BTC if available, else first item)
  const btc = arr.find((t) => (t.symbol || '').toUpperCase() === 'BTC') || arr[0];
  if (btc) {
    const set = (id, val) => { const e = el(id); if (e) e.textContent = val; };
    set('topbar-symbol', `${btc.symbol}/USDT`);
    set('topbar-price', fmt(btc.price, 2));
    const chg = Number(btc.priceChange24h || 0);
    const chgEl = el('topbar-change');
    if (chgEl) { chgEl.textContent = fmtPct(chg); chgEl.className = chg >= 0 ? 'pnl-pos' : 'pnl-neg'; }
    if (btc.high24h) set('topbar-high', fmt(btc.high24h, 2));
    if (btc.low24h) set('topbar-low', fmt(btc.low24h, 2));
    if (btc.volume24h || btc.volumeUsd) set('topbar-vol', `${(Number(btc.volume24h || btc.volumeUsd) / 1e6).toFixed(2)}M USD`);
    set('bot-pair', `${btc.symbol}/USDT`);
  }
}

function renderSignals(signals) {
  const arr = Array.isArray(signals) ? signals : [];
  el('signals-full-count').textContent = arr.length;
  const sorted = [...arr].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  el('signals-full-body').innerHTML = sorted.slice(0, 50).map((s) => {
    const tech = s.technicalSignal || '—';
    const finalSig = s.finalSignal || s.signal || '—';
    const techCls = tech === 'BUY' ? 'sig-buy' : tech === 'SELL' ? 'sig-sell' : 'sig-hold';
    const finalCls = finalSig === 'BUY' ? 'sig-buy' : finalSig === 'SELL' ? 'sig-sell' : 'sig-hold';
    return `<tr>
      <td>${fmtDateTime(s.timestamp)}</td>
      <td><strong>${esc(s.symbol)}</strong></td>
      <td>${esc(s.chain)}</td>
      <td>${esc(s.strategy)}</td>
      <td class="${techCls}">${esc(tech)}</td>
      <td class="${finalCls}">${esc(finalSig)}</td>
      <td class="muted small">${esc(s.signalSource || s.source || '')}</td>
      <td>${fmt(s.rsi, 1)}</td>
      <td>${fmt(s.volumeSpike, 2)}</td>
      <td class="muted small" title="${esc(s.aiReason || s.notBoughtReason || '')}">${esc((s.aiReason || s.notBoughtReason || '').slice(0, 60))}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="muted small">No recent signals.</td></tr>';
}

function renderRiskAlerts(portfolio) {
  if (!portfolio) return;
  const risks = [];
  const consLosses = Number(portfolio.consecutiveLosses || 0);
  if (consLosses >= 3) {
    risks.push({ label: 'Consecutive Losses', detail: 'Position size capped', value: `${consLosses}` });
  }
  const totalPnl = Number(portfolio.totalPnl || 0);
  if (totalPnl < -10) {
    risks.push({ label: 'Cumulative PnL', detail: `Started $${Number(portfolio.startingBalance || 100).toFixed(0)}`, value: fmtUSD(totalPnl) });
  }
  const winRate = Number(portfolio.winRate || 0);
  if (Number(portfolio.closedTrades || 0) >= 20 && winRate < 30) {
    risks.push({ label: 'Low Win Rate', detail: `Over ${portfolio.closedTrades} trades`, value: `${winRate.toFixed(1)}%` });
  }
  el('risk-count').textContent = risks.length;
  el('alert-count').textContent = String(risks.length);
  el('risk-list').innerHTML = risks.length === 0
    ? '<div class="muted small">No active alerts.</div>'
    : risks.map((r) => `
        <div class="risk-item">
          <div><div class="risk-label">${esc(r.label)}</div><div class="risk-detail">${esc(r.detail)}</div></div>
          <span class="risk-value">${esc(r.value)}</span>
        </div>
      `).join('');
}

function fmtProfitFactor(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (n === Infinity) return '∞';
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

function renderBullFlagStats(stats) {
  const data = stats && typeof stats === 'object' ? stats : null;
  const setText = (id, value) => { if (el(id)) el(id).textContent = value; };
  if (!data) {
    setText('bf-enabled', 'offline');
    setText('bf-updated', 'stats unavailable');
    setText('bf-total', '—');
    setText('bf-closed', '—');
    setText('bf-winrate', '—');
    setText('bf-pnl', '—');
    setText('bf-pf', '—');
    if (el('bf-exit-body')) {
      el('bf-exit-body').innerHTML = '<tr><td colspan="2" class="muted small">Endpoint unavailable.</td></tr>';
    }
    return;
  }

  setText('bf-enabled', data.enabled ? 'enabled' : 'disabled');
  setText('bf-updated', `Updated ${fmtTime(data.timestamp)}`);
  setText('bf-total', String(Number(data.totalTrades || 0)));
  setText('bf-closed', String(Number(data.sells || 0)));
  setText('bf-winrate', `${fmt(data.winRatePct, 1)}%`);
  const pnl = Number(data.totalPnlUsd || 0);
  setText('bf-pnl', `${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}`);
  setText('bf-pf', fmtProfitFactor(data.profitFactor));

  const pnlEl = el('bf-pnl');
  if (pnlEl) {
    pnlEl.classList.remove('pnl-pos', 'pnl-neg');
    pnlEl.classList.add(pnl >= 0 ? 'pnl-pos' : 'pnl-neg');
  }

  const reasons = Object.entries(data.exitReasonBreakdown || {})
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0));
  if (el('bf-exit-body')) {
    el('bf-exit-body').innerHTML = reasons.length > 0
      ? reasons.map(([reason, count]) => `<tr><td>${esc(reason)}</td><td>${esc(count)}</td></tr>`).join('')
      : '<tr><td colspan="2" class="muted small">No bull-flag exits yet.</td></tr>';
  }
  // W16.4 — render cumulative PnL chart (SVG, no library)
  renderPnlSvg('bf-pnl-chart', data.pnlSeries || []);
}

// W16.4 — colored-bar sparkline for health-canary check trend.
// Renders one small bar per recent check; green=PASS, amber=WARN, red=FAIL.
function renderCanarySparkline(series) {
  if (!Array.isArray(series) || series.length === 0) return '<span class="muted small">—</span>';
  const bars = series.map((p) => {
    const s = String(p.s || '').toUpperCase();
    const color = s === 'PASS' ? '#39d98a' : s === 'WARN' ? '#f0b429' : s === 'FAIL' ? '#ff5d5d' : '#6b7785';
    return `<rect width="3" height="12" x="0" y="0" fill="${color}"/>`;
  }).join('');
  const w = series.length * 4;
  return `<svg viewBox="0 0 ${w} 12" width="${Math.min(w, 100)}" height="12" preserveAspectRatio="none" style="vertical-align:middle;">${series.map((p, i) => {
    const s = String(p.s || '').toUpperCase();
    const color = s === 'PASS' ? '#39d98a' : s === 'WARN' ? '#f0b429' : s === 'FAIL' ? '#ff5d5d' : '#6b7785';
    return `<rect width="3" height="12" x="${i * 4}" y="0" fill="${color}"><title>${s}</title></rect>`;
  }).join('')}</svg>`;
}

// W16.4 — minimal inline SVG line chart (no charting library).
// Renders cumPnl series into an existing <svg> with viewBox="0 0 600 120".
function renderPnlSvg(svgId, series) {
  const svg = el(svgId);
  if (!svg) return;
  const W = 600;
  const H = 120;
  const PAD = 6;
  if (!Array.isArray(series) || series.length === 0) {
    svg.innerHTML = `<text x="300" y="60" fill="#6b7785" font-size="11" text-anchor="middle">No closed trades yet.</text>`;
    return;
  }
  const ys = series.map((d) => Number(d.cumPnl || 0));
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const rangeY = (maxY - minY) || 1;
  const stepX = series.length > 1 ? (W - 2 * PAD) / (series.length - 1) : 0;
  const yFor = (v) => PAD + ((maxY - v) / rangeY) * (H - 2 * PAD);
  const zeroY = yFor(0);
  const points = series.map((d, i) => `${PAD + i * stepX},${yFor(Number(d.cumPnl || 0))}`).join(' ');
  const finalY = yFor(Number(series[series.length - 1].cumPnl || 0));
  const stroke = ys[ys.length - 1] >= 0 ? '#39d98a' : '#ff5d5d';
  const fillColor = ys[ys.length - 1] >= 0 ? 'rgba(57,217,138,0.12)' : 'rgba(255,93,93,0.12)';
  const areaPath = `M ${PAD},${zeroY} L ${points.split(' ').join(' L ')} L ${PAD + (series.length - 1) * stepX},${zeroY} Z`;
  svg.innerHTML = `
    <line x1="${PAD}" y1="${zeroY}" x2="${W - PAD}" y2="${zeroY}" stroke="#3a4250" stroke-dasharray="2 3" stroke-width="0.5"/>
    <path d="${areaPath}" fill="${fillColor}" stroke="none"/>
    <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5"/>
    <circle cx="${PAD + (series.length - 1) * stepX}" cy="${finalY}" r="2.5" fill="${stroke}"/>
    <text x="${W - PAD}" y="12" fill="#9aa3b2" font-size="10" text-anchor="end">${ys[ys.length - 1] >= 0 ? '+' : ''}${ys[ys.length - 1].toFixed(2)} USD · ${series.length} trades</text>
  `;
}

// ─── Chart (TradingView lightweight-charts) ───────────────────────────────

function chartMsg(text, color) {
  const container = el('chart-container');
  if (!container) return;
  container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:360px;color:${color || '#6b7785'};font-size:12px;padding:24px;text-align:center;">${esc(text)}</div>`;
}

function initChart() {
  const container = el('chart-container');
  if (!container) return;
  if (!window.LightweightCharts) {
    const blocked = window.__chartCdnFailed ? 'BOTH unpkg.com AND cdn.jsdelivr.net blocked' : 'CDN script not loaded yet';
    chartMsg(`Chart library unavailable — ${blocked}. Disable adblock for this page or whitelist unpkg.com/jsdelivr.net.`, '#f87171');
    console.error('[chart] LightweightCharts global missing. cdnFailed=', !!window.__chartCdnFailed);
    return;
  }
  if (STATE.chart) return;
  const CHART_H = 420;
  const rect = container.getBoundingClientRect();
  const w = Math.max(300, Math.floor(rect.width));
  STATE.chart = window.LightweightCharts.createChart(container, {
    layout: { background: { color: '#080a0e' }, textColor: '#6b7785' },
    grid: { vertLines: { color: '#131820' }, horzLines: { color: '#131820' } },
    rightPriceScale: { borderColor: '#1c232c' },
    timeScale: { borderColor: '#1c232c', timeVisible: true, secondsVisible: false },
    crosshair: { mode: 1 },
    width: w,
    height: CHART_H,
  });
  STATE.candleSeries = STATE.chart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444',
    borderUpColor: '#22c55e', borderDownColor: '#ef4444',
    wickUpColor: '#22c55e', wickDownColor: '#ef4444',
  });
  STATE.volumeSeries = STATE.chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    color: '#1c2330',
  });
  STATE.chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  // NO ResizeObserver. Resize on window resize only (debounced).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!STATE.chart) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nw = Math.max(300, Math.floor(container.getBoundingClientRect().width));
      STATE.chart.applyOptions({ width: nw, height: CHART_H });
    }, 200);
  });
}

async function refreshChart() {
  if (!STATE.chart) initChart();
  if (!STATE.chart || !STATE.candleSeries) return;
  const r = await api(`/api/ohlcv?symbol=${STATE.chartSymbol}&interval=${STATE.chartInterval}&limit=200`);
  if (r === null) {
    chartMsg(`OHLCV endpoint unreachable on ${getBaseUrl() || 'same-origin'} (CORS / 5xx / non-JSON)`, '#f87171');
    return;
  }
  if (!r.ok) {
    chartMsg(`OHLCV API error: ${r.error || 'unknown'} (symbol=${STATE.chartSymbol})`, '#f87171');
    return;
  }
  if (!r.candles?.length) {
    chartMsg(`No candles for ${STATE.chartSymbol} ${STATE.chartInterval}`, '#fbbf24');
    return;
  }
  try {
    STATE.candleSeries.setData(r.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    STATE.volumeSeries.setData(r.candles.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? '#22c55e44' : '#ef444444',
    })));
    STATE.chart.timeScale().fitContent();
  } catch (e) {
    console.error('[chart] setData failed:', e);
    chartMsg(`Chart render error: ${e.message}`, '#f87171');
  }
}

// ─── Market Indicators ───────────────────────────────────────────────────

function fmtBigUsd(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(2)}`;
}

async function refreshMarketIndicators() {
  const r = await api('/api/market-indicators');
  if (r === null) {
    console.warn('[indicators] endpoint unreachable on', getBaseUrl() || 'same-origin');
    const banner = el('ind-fgi');
    if (banner) banner.textContent = '!';
    return;
  }
  const d = r?.data;
  if (!d) {
    console.warn('[indicators] no data in response', r);
    return;
  }
  // Normalize: each indicator MUST be an object (api guarantees shape, but defend anyway)
  d.fearGreed     = d.fearGreed     || { value: null };
  d.btcDominance  = d.btcDominance  || { value: null };
  d.altseason     = d.altseason     || { value: null };
  d.marketCap     = d.marketCap     || { value: null };
  d.totalVolume   = d.totalVolume   || { value: null };
  d.btcFunding    = d.btcFunding    || { value: null };
  d.btcOpenInterest = d.btcOpenInterest || { value: null };
  // Fear & Greed
  if (d.fearGreed.value != null) {
    el('ind-fgi').textContent = d.fearGreed.value;
    const sub = el('ind-fgi-label');
    sub.textContent = d.fearGreed.label || '—';
    const v = d.fearGreed.value;
    sub.style.color = v < 25 ? '#ef4444' : v < 50 ? '#fbbf24' : v < 75 ? '#84cc16' : '#22c55e';
  }
  // BTC Dominance
  if (d.btcDominance.value != null) {
    el('ind-btcdom').textContent = `${d.btcDominance.value.toFixed(2)}%`;
    el('ind-btcdom-chg').textContent = fmtPct(d.btcDominance.change24h);
    el('ind-btcdom-chg').style.color = (d.btcDominance.change24h || 0) >= 0 ? '#22c55e' : '#ef4444';
  }
  // Altcoin Season
  if (d.altseason.value != null) {
    el('ind-altseason').textContent = d.altseason.value;
    el('ind-altseason-label').textContent = d.altseason.label || '—';
  }
  // Market Cap
  if (d.marketCap.value != null) {
    el('ind-mcap').textContent = fmtBigUsd(d.marketCap.value);
    el('ind-mcap-chg').textContent = fmtPct(d.marketCap.change24h);
    el('ind-mcap-chg').style.color = (d.marketCap.change24h || 0) >= 0 ? '#22c55e' : '#ef4444';
  }
  // 24h Volume
  if (d.totalVolume.value != null) {
    el('ind-vol').textContent = fmtBigUsd(d.totalVolume.value);
    el('ind-vol-chg').textContent = '24h';
  }
  // Funding rate (annualized: rate × 3 × 365 × 100 for daily-ish)
  if (d.btcFunding.value != null) {
    const pct = d.btcFunding.value * 100;
    el('ind-funding').textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(4)}%`;
    el('ind-funding-chg').textContent = '8h funding';
    el('ind-funding').style.color = pct >= 0 ? '#22c55e' : '#ef4444';
  }
  // Open Interest (BTC contracts)
  if (d.btcOpenInterest.value != null) {
    el('ind-oi').textContent = `${(d.btcOpenInterest.value / 1000).toFixed(2)}K BTC`;
    el('ind-oi-chg').textContent = 'Binance Futures';
  }
}

// 2026-05-23: risk-rules helpers (Week 16.4 panel).
// B3.dash.8: admin token now expires after 30 min of inactivity. Previously
// persisted in localStorage indefinitely — any XSS or shared-browser access
// would grant full admin privileges with no time bound. We store token +
// last-used timestamp and treat anything older than DASH_ADMIN_TOKEN_TTL_MS
// as expired.
const DASH_ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;
function getAdminToken() {
  const stamp = Number(localStorage.getItem('dt.adminTokenLastUsedAt') || 0);
  if (stamp && (Date.now() - stamp) > DASH_ADMIN_TOKEN_TTL_MS) {
    // Expired — clear stored token and force re-prompt.
    localStorage.removeItem('dt.adminToken');
    localStorage.removeItem('dt.adminTokenLastUsedAt');
    return '';
  }
  const token = localStorage.getItem('dt.adminToken') || '';
  // Sliding refresh: touch the last-used timestamp on each successful read.
  if (token) localStorage.setItem('dt.adminTokenLastUsedAt', String(Date.now()));
  return token;
}
function promptAdminToken() {
  const cur = getAdminToken();
  const next = window.prompt('Admin token (DASHBOARD_ADMIN_TOKEN) — required to edit risk rules. Expires after 30 min idle:', cur);
  if (next != null) {
    localStorage.setItem('dt.adminToken', String(next));
    localStorage.setItem('dt.adminTokenLastUsedAt', String(Date.now()));
  }
  return getAdminToken();
}
async function patchRiskRule(name, scope, body) {
  let token = getAdminToken();
  if (!token) token = promptAdminToken();
  if (!token) return { ok: false, error: 'no admin token' };
  try {
    const res = await fetch(getBaseUrl() + `/api/risk-rules/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ scope, ...body }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` };
    return json || { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ─── Week 6 observability ──────────────────────────────────────────────────
async function refreshObservability() {
  if (el('view-observability').classList.contains('hidden')) return;
  const [canary, ai, rej, aiHealth, rules, sparks] = await Promise.all([
    api('/api/health-canary?limit=30'),
    api('/api/ai-decisions/cost?hours=24'),
    api('/api/rejections?hours=24&limit=50'),
    api('/api/ai-health'),
    api('/api/risk-rules'),
    api('/api/health-canary/sparklines?perCheck=20'),
  ]);
  // W16.4: endpoint now returns { series, stats, sigmaBadge } per check.
  // Backwards-compat: handle legacy array shape too.
  const rawSparks = (sparks && sparks.data) || {};
  const sparkByCheck = {};
  for (const [k, v] of Object.entries(rawSparks)) {
    if (Array.isArray(v)) sparkByCheck[k] = { series: v, sigmaBadge: false, stats: null };
    else sparkByCheck[k] = v || { series: [], sigmaBadge: false, stats: null };
  }
  if (aiHealth && aiHealth.providers) {
    const cir = aiHealth.circuit || {};
    const meta = cir.open
      ? `CIRCUIT OPEN — cooldown ${cir.secondsRemaining}s, failures ${cir.failures}`
      : `circuit closed (failures ${cir.failures || 0}) · anyProviderEnabled=${aiHealth.anyProviderEnabled}`;
    const metaEl = el('w6-aihealth-meta');
    if (metaEl) metaEl.textContent = meta;
    const rows = Object.entries(aiHealth.providers).map(([name, p]) => {
      const quota = p.quota ? `${p.quota.limit - p.quota.count}/${p.quota.limit}` : '—';
      const backoff = p.backoffSecondsRemaining ? `${p.backoffSecondsRemaining}s` : (p.backoffUntil ? 'yes' : '—');
      const statusClass = p.status === 'online' ? 'st-PASS' : (p.status === 'backoff' ? 'st-WARN' : 'st-FAIL');
      return `<tr>
        <td><strong>${esc(name)}</strong></td>
        <td>${p.enabled ? 'yes' : 'no'}</td>
        <td>${p.hasKey ? 'yes' : 'no'}</td>
        <td><span class="${statusClass}">${esc(p.status)}</span></td>
        <td>${esc(quota)}</td>
        <td>${esc(backoff)}</td>
        <td>${esc(p.model || '—')}</td>
      </tr>`;
    }).join('');
    el('w6-aihealth-body').innerHTML = rows;
  }
  if (canary?.data) {
    el('w6-kpi-canary').innerHTML = `<span class="st-${canary.data[0]?.overall_status || 'SKIPPED'}">${esc(canary.data[0]?.overall_status || '—')}</span>`;
    el('w6-canary-body').innerHTML = canary.data.slice(0, 30).map((r) => {
      const sp = sparkByCheck[r.check_name] || { series: [], sigmaBadge: false, stats: null };
      const badge = sp.sigmaBadge
        ? `<span title="value > mean + 3σ (μ=${sp.stats?.mean ?? '—'} σ=${sp.stats?.stdev ?? '—'} n=${sp.stats?.count ?? 0})" style="color:#f0b429; font-weight:600; margin-left:4px;">⚠3σ</span>`
        : '';
      return `
      <tr>
        <td>${esc(fmtDateTime(r.checked_at))}</td>
        <td>${esc(r.check_name)}</td>
        <td><span class="st-${r.status}">${esc(r.status)}</span>${badge}</td>
        <td>${renderCanarySparkline(sp.series)}</td>
        <td>${esc(r.value_observed || '—')}</td>
        <td>${esc(r.threshold || '—')}</td>
        <td>${esc((r.message || '') + (r.recovery_hint ? ' — ' + r.recovery_hint : ''))}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted small">No canary runs yet.</td></tr>';
  } else { el('w6-canary-body').innerHTML = '<tr><td colspan="7" class="muted small">SQL disabled or endpoint unavailable.</td></tr>'; }
  if (ai?.data) {
    const totalCost = ai.data.reduce((s, r) => s + Number(r.total_cost_usd || 0), 0);
    el('w6-kpi-cost').textContent = `$${totalCost.toFixed(4)}`;
    el('w6-aicost-body').innerHTML = ai.data.map((r) => `
      <tr>
        <td><strong>${esc(r.provider)}</strong></td>
        <td>${esc(r.call_count)}</td>
        <td>${esc(r.success_count)}/${esc(r.call_count)}</td>
        <td>$${fmt(r.total_cost_usd, 4)}</td>
        <td>${fmt(r.avg_latency_ms, 0)} ms</td>
        <td>${esc(r.buy_count)}/${esc(r.hold_count)}/${esc(r.sell_count)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted small">No AI calls.</td></tr>';
  } else { el('w6-aicost-body').innerHTML = '<tr><td colspan="6" class="muted small">SQL disabled.</td></tr>'; }
  if (rej?.data) {
    el('w6-kpi-rejections').textContent = String(rej.data.length);
    el('w6-rejections-body').innerHTML = rej.data.slice(0, 50).map((r) => `
      <tr>
        <td>${esc(fmtDateTime(r.rejected_at))}</td>
        <td>${esc(r.side)}</td>
        <td><strong>${esc(r.symbol)}</strong></td>
        <td>${esc(r.chain)}</td>
        <td>${esc(r.gate)}</td>
        <td><span class="sev-${r.severity}">${esc(r.severity)}</span></td>
        <td title="${esc(r.reason)}">${esc((r.reason || '').slice(0, 80))}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted small">No rejections.</td></tr>';
  } else { el('w6-rejections-body').innerHTML = '<tr><td colspan="7" class="muted small">SQL disabled.</td></tr>'; }
  // Week 16.4 — risk rules with inline severity + enabled toggles
  if (rules?.data) {
    const rows = rules.data;
    if (el('w6-rules-count')) el('w6-rules-count').textContent = String(rows.length);
    const sevOpts = (cur) => ['block', 'warn', 'log']
      .map((s) => `<option value="${s}" ${s === cur ? 'selected' : ''}>${s}</option>`).join('');
    el('w6-rules-body').innerHTML = rows.map((r) => `
      <tr data-rule="${esc(r.name)}" data-scope="${esc(r.scope)}">
        <td><strong>${esc(r.name)}</strong></td>
        <td>${esc(r.scope)}</td>
        <td><select class="rule-sev" data-name="${esc(r.name)}" data-scope="${esc(r.scope)}">${sevOpts(r.severity)}</select></td>
        <td><input type="checkbox" class="rule-en" data-name="${esc(r.name)}" data-scope="${esc(r.scope)}" ${r.enabled ? 'checked' : ''}></td>
        <td class="muted small">${esc((r.notes || '').slice(0, 80))}</td>
        <td class="muted small">${esc(fmtDateTime(r.updated_at))}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted small">No rules.</td></tr>';
    // Wire change handlers (idempotent — querySelectorAll returns fresh elements after innerHTML)
    document.querySelectorAll('#w6-rules-body .rule-sev').forEach((sel) => {
      sel.addEventListener('change', async (ev) => {
        const { name, scope } = ev.target.dataset;
        const result = await patchRiskRule(name, scope, { severity: ev.target.value });
        if (!result.ok) {
          window.alert(`PATCH failed: ${result.error}`);
          refreshObservability();
        }
      });
    });
    document.querySelectorAll('#w6-rules-body .rule-en').forEach((cb) => {
      cb.addEventListener('change', async (ev) => {
        const { name, scope } = ev.target.dataset;
        const result = await patchRiskRule(name, scope, { enabled: ev.target.checked });
        if (!result.ok) {
          window.alert(`PATCH failed: ${result.error}`);
          refreshObservability();
        }
      });
    });
  } else if (el('w6-rules-body')) {
    el('w6-rules-body').innerHTML = '<tr><td colspan="6" class="muted small">SQL disabled or endpoint unavailable.</td></tr>';
  }
}

// ─── Logs view ────────────────────────────────────────────────────────────

let LOGS_TIMER = null;
async function refreshLogs() {
  if (el('view-logs').classList.contains('hidden')) return;
  const lines = Number(el('logs-lines')?.value) || 200;
  const r = await api(`/api/logs/tail?lines=${lines}`);
  if (!r?.lines) {
    el('logs-pane').textContent = `Logs unavailable: ${r?.error || 'no data'}`;
    return;
  }
  el('logs-meta').textContent = `${r.file} · ${r.returned} lines · ${(r.totalBytes / 1024).toFixed(0)}KB total`;
  el('logs-pane').innerHTML = r.lines.map((line) => {
    const cls = /\s+ERROR\s+|\s+error\s+/.test(line) ? 'log-err'
      : /\s+WARN\s+|\s+warn\s+/.test(line) ? 'log-warn'
      : 'log-info';
    return `<span class="${cls}">${esc(line)}</span>`;
  }).join('\n');
  // Auto-scroll to bottom
  el('logs-pane').scrollTop = el('logs-pane').scrollHeight;
}

// ─── Symbol picker ────────────────────────────────────────────────────────

let SYMBOL_LIST = [];
function renderSymbolList(filter = '') {
  const f = filter.trim().toLowerCase();
  const filtered = SYMBOL_LIST.filter((t) => !f || (t.symbol || '').toLowerCase().includes(f)).slice(0, 50);
  el('symbol-list').innerHTML = filtered.map((t) => `
    <div class="row ${t.symbol === STATE.chartSymbol.replace('USDT', '') ? 'active' : ''}" data-symbol="${esc(t.symbol)}">
      <strong>${esc(t.symbol)}/USDT</strong>
      <span>${fmt(t.price, 4)}</span>
      <span class="${(t.priceChange24h || 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(t.priceChange24h)}</span>
    </div>
  `).join('') || '<div class="muted small">No matches.</div>';
  // Wire click
  document.querySelectorAll('#symbol-list .row').forEach((row) => {
    row.addEventListener('click', () => {
      const sym = row.dataset.symbol;
      STATE.chartSymbol = `${sym}USDT`;
      localStorage.setItem('dt.chartSymbol', STATE.chartSymbol);
      el('topbar-symbol').textContent = `${sym}/USDT`;
      el('bot-pair').textContent = `${sym}/USDT`;
      el('symbol-dropdown').classList.add('hidden');
      refreshChart();
    });
  });
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

async function refreshAll() {
  el('sb-sync').textContent = fmtTime(new Date().toISOString());

  const [status, tracked, bullFlagStats] = await Promise.all([
    api('/api/status'),
    api('/api/tracked-tokens'),
    api('/api/bull-flag-stats'),
  ]);

  // Update bot indicator (green=alive, yellow=paper, red=down)
  const switcher = el('bot-switcher');
  if (!status) {
    switcher.classList.add('bot-down');
    el('sb-status').textContent = `${STATE.bot.toUpperCase()} bot unreachable on port ${STATE.bot === 'live' ? '3002' : '3001'}`;
    return;
  }
  switcher.classList.remove('bot-down');
  switcher.classList.toggle('bot-paper', (status.mode || STATE.bot) === 'paper');

  renderTopbarAndBrand(status);
  const portfolio = status.portfolio || {};
  renderBalancesAndPnl(portfolio);
  renderPositions(portfolio.positions || []);
  renderTrades(portfolio.recentTrades || []);
  renderSignals(status.market?.recentSignals || []);
  renderRiskAlerts(portfolio);
  renderBullFlagStats(bullFlagStats);

  if (tracked) {
    renderTracked(tracked);
    SYMBOL_LIST = (tracked?.tokens || tracked || []).filter((t) => t.symbol);
    if (el('symbol-list')?.children?.length === 0 || !el('symbol-list')?.innerHTML) renderSymbolList();
  }
  refreshObservability();
  refreshChart();
  refreshMarketIndicators();
  refreshLogs();
}

function switchBot(newBot) {
  STATE.bot = newBot;
  localStorage.setItem('dt.bot', newBot);
  el('bot-select').value = newBot;
  refreshAll();
}

function switchView(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  el(`view-${view}`)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  if (view === 'observability') refreshObservability();
  if (view === 'logs') refreshLogs();
}

function startClock() {
  setInterval(() => { el('sb-time').textContent = new Date().toLocaleTimeString(); }, 1000);
}

function showDebug(msg) {
  const box = document.getElementById('debug-overlay');
  if (!box) return;
  box.style.display = 'block';
  box.textContent = msg;
}

document.addEventListener('DOMContentLoaded', () => {
  const v = window.__BUNDLE_VERSION || '?';
  const sbBundle = document.getElementById('sb-bundle');
  if (sbBundle) sbBundle.textContent = v;
  console.log('[boot] bundle', v, 'cdnFail1=', !!window.__cdn1Failed, 'cdnFailAll=', !!window.__chartCdnFailed, 'LW=', typeof window.LightweightCharts);
  if (window.__bootErrors && window.__bootErrors.length) {
    showDebug('Pre-init errors: ' + window.__bootErrors.join(' | '));
  }
  el('bot-select').value = STATE.bot;
  el('bot-select').addEventListener('change', (e) => switchBot(e.target.value));
  el('refresh-btn').addEventListener('click', refreshAll);
  document.querySelectorAll('.nav-item, [data-view]').forEach((n) => {
    if (n.dataset.view) {
      n.addEventListener('click', (e) => { e.preventDefault(); switchView(n.dataset.view); });
    }
  });

  // Symbol pill toggle
  const pill = el('symbol-pill-btn');
  const dropdown = el('symbol-dropdown');
  if (pill && dropdown) {
    pill.addEventListener('click', async (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
      if (!dropdown.classList.contains('hidden')) {
        // Force-hydrate symbol list if empty
        if (SYMBOL_LIST.length === 0) {
          const r = await api('/api/tracked-tokens');
          SYMBOL_LIST = (r?.tokens || []).filter((t) => t.symbol);
        }
        // Always include common majors as fallback so user can pick from chart-supported symbols
        const majors = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'MATIC', 'DOT', 'LINK', 'UNI'];
        const have = new Set(SYMBOL_LIST.map((t) => (t.symbol || '').toUpperCase()));
        for (const m of majors) {
          if (!have.has(m)) SYMBOL_LIST.push({ symbol: m, price: null, priceChange24h: null });
        }
        renderSymbolList(el('symbol-search')?.value || '');
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.symbol-picker')) dropdown.classList.add('hidden');
    });
    el('symbol-search')?.addEventListener('input', (e) => renderSymbolList(e.target.value));
  }

  // Logs controls
  el('logs-refresh')?.addEventListener('click', refreshLogs);
  el('logs-lines')?.addEventListener('change', refreshLogs);
  el('logs-autorefresh')?.addEventListener('change', (e) => {
    if (LOGS_TIMER) { clearInterval(LOGS_TIMER); LOGS_TIMER = null; }
    if (e.target.checked) LOGS_TIMER = setInterval(refreshLogs, 5000);
  });

  document.querySelectorAll('.pair-tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.pair-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
    });
  });
  document.querySelectorAll('.tf').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tf').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      STATE.chartInterval = t.dataset.tf || '5m';
      localStorage.setItem('dt.chartInterval', STATE.chartInterval);
      refreshChart();
    });
  });
  // Restore active TF button from saved state
  document.querySelectorAll('.tf').forEach((t) => {
    if (t.dataset.tf === STATE.chartInterval) {
      document.querySelectorAll('.tf').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
    }
  });
  startClock();
  const safeRefresh = async () => {
    try { await refreshAll(); }
    catch (e) {
      console.error('[refreshAll]', e);
      showDebug(`refreshAll error: ${e.message} @ ${e.stack?.split('\n')[1]?.trim() || '?'}`);
    }
  };
  safeRefresh();
  setInterval(safeRefresh, STATE.refreshMs);
});
