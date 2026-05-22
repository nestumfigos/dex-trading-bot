'use strict';

class BTCMacroFilter {
  constructor({ logger, config, exchanges }) {
    this.logger = logger;
    this.config = config;
    this.exchanges = exchanges;
    this.btcCache = {
      price: null,
      timestamp: null,
      priceChange1h: null,
      riskOffTriggered: false,
    };
    this.cacheTtlMs = 60 * 1000; // 1-minute cache
  }

  /**
   * Fetch BTC price and 1h change
   */
  async fetchBTCData() {
    const now = Date.now();

    // Return cached if fresh
    if (
      this.btcCache.price
      && this.btcCache.timestamp
      && now - this.btcCache.timestamp < this.cacheTtlMs
    ) {
      return this.btcCache;
    }

    try {
      // Try to get BTC price from available sources
      let btcData = null;

      // Try CoinGecko API first (free, no key needed)
      try {
        const res = await (await import('axios')).default.get(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=false&include_24hr_vol=false&include_24hr_change=true&include_last_updated_at=true',
          { timeout: 5000 }
        );

        if (res.data?.bitcoin?.usd) {
          btcData = {
            price: res.data.bitcoin.usd,
            priceChange24h: res.data.bitcoin?.usd_24h_change || 0,
          };
        }
      } catch (err) {
        this.logger?.debug(`CoinGecko API failed: ${err.message}`);
      }

      // Fallback to Binance API
      if (!btcData) {
        try {
          const res = await (await import('axios')).default.get(
            'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',
            { timeout: 5000 }
          );

          if (res.data?.lastPrice) {
            btcData = {
              price: Number(res.data.lastPrice),
              priceChange24h: Number(res.data.priceChangePercent || 0),
            };
          }
        } catch (err) {
          this.logger?.debug(`Binance API failed: ${err.message}`);
        }
      }

      if (btcData) {
        // Estimate 1h change from 24h (rough approximation)
        // More accurate would be to track historical data
        const hoursSince = 1;
        const estimatedChange1h = btcData.priceChange24h / 24;

        this.btcCache = {
          price: btcData.price,
          timestamp: now,
          priceChange1h: estimatedChange1h,
          priceChange24h: btcData.priceChange24h,
          riskOffTriggered: estimatedChange1h < -2, // Threshold from config
        };

        return this.btcCache;
      }

      return this.btcCache;
    } catch (err) {
      this.logger?.warn(`BTC macro filter error: ${err.message}`);
      return this.btcCache;
    }
  }

  /**
   * Check if BTC is in risk-off state (down >2% in last hour)
   */
  async isRiskOff() {
    const threshold = Number(this.config.risk?.btcRiskOffThresholdPct || 2);
    const btcData = await this.fetchBTCData();

    if (!btcData?.price) {
      return false; // Can't determine, assume not risk-off
    }

    const isRiskOff = (btcData.priceChange1h || 0) < -threshold;

    if (isRiskOff && !this.btcCache.riskOffTriggered) {
      this.logger?.warn(`[BTC-Macro] Risk-off triggered: BTC down ${btcData.priceChange1h.toFixed(2)}% in 1h`);
    }

    return isRiskOff;
  }

  /**
   * Get BTC health status
   */
  async getBTCStatus() {
    const btcData = await this.fetchBTCData();

    if (!btcData?.price) {
      return {
        available: false,
        price: null,
        priceChange1h: null,
        riskOff: false,
      };
    }

    return {
      available: true,
      price: btcData.price,
      priceChange1h: btcData.priceChange1h,
      priceChange24h: btcData.priceChange24h,
      riskOff: (btcData.priceChange1h || 0) < -Number(this.config.risk?.btcRiskOffThresholdPct || 2),
      lastUpdated: new Date(btcData.timestamp).toISOString(),
    };
  }

  /**
   * Check if altcoin BUY is allowed based on BTC macro state
   */
  async canEnterAltcoin(tokenData = {}) {
    if (this.config.risk?.btcRiskOffEnabled === false) {
      return true; // Filter disabled
    }

    const riskOff = await this.isRiskOff();

    if (riskOff) {
      return {
        allowed: false,
        reason: `BTC macro risk-off: altcoin BUYs blocked`,
        btcStatus: await this.getBTCStatus(),
      };
    }

    return {
      allowed: true,
      reason: 'BTC macro status healthy',
      btcStatus: await this.getBTCStatus(),
    };
  }

  /**
   * Clear cache (useful for testing or manual refresh)
   */
  clearCache() {
    this.btcCache = {
      price: null,
      timestamp: null,
      priceChange1h: null,
      riskOffTriggered: false,
    };
  }
}

module.exports = BTCMacroFilter;
