'use strict';

const { STRATEGY_KNOWLEDGE_BASE } = require('./strategy-knowledge');

class StrategyBrain {
  constructor({ config, logger, portfolio }) {
    this.config = config;
    this.logger = logger;
    this.portfolio = portfolio;
  }

  ensureState() {
    if (!this.portfolio.learning || typeof this.portfolio.learning !== 'object') {
      this.portfolio.learning = {};
    }

    if (!this.portfolio.learning.strategyBrain || typeof this.portfolio.learning.strategyBrain !== 'object') {
      this.portfolio.learning.strategyBrain = {
        profiles: {},
        adjustments: {},
        mutations: [],
        knownArchetypes: Object.keys(STRATEGY_KNOWLEDGE_BASE),
      };
    }

    const brain = this.portfolio.learning.strategyBrain;
    if (!brain.profiles || typeof brain.profiles !== 'object') brain.profiles = {};
    if (!brain.adjustments || typeof brain.adjustments !== 'object') brain.adjustments = {};
    if (!Array.isArray(brain.mutations)) brain.mutations = [];
    if (!Array.isArray(brain.knownArchetypes)) brain.knownArchetypes = Object.keys(STRATEGY_KNOWLEDGE_BASE);

    return brain;
  }

  getBookArchetype(tokenData = {}, details = {}) {
    const rsi = Number(tokenData?.rsi);
    const move24h = Math.abs(Number(tokenData?.priceChange24h || 0));
    const rawSpike = Number(tokenData?.volumeSpike || tokenData?.volumeSpikePct || details?.volumeSpike || 0);
    const volumeSpike = Number.isFinite(rawSpike) ? rawSpike : 0;
    const buyRatioRecentPct = Number(tokenData?.buyRatioRecentPct || details?.buyRatioRecentPct || 0);

    const sb = this.config?.strategyBrain || {};
    if (move24h >= (sb.livermoreMoveThreshold ?? 20) && volumeSpike >= (sb.livermoreVolumeSpike ?? 2.2) && buyRatioRecentPct >= (sb.livermoreBuyRatioPct ?? 55)) return 'livermore_momentum';
    if (Number.isFinite(rsi) && rsi >= (sb.connorsRsiMin ?? 36) && rsi <= (sb.connorsRsiMax ?? 52) && move24h <= (sb.connorsMoveMax ?? 10)) return 'connors_short_term_reversion';
    if (move24h >= (sb.turtleMoveThreshold ?? 8) && volumeSpike >= (sb.turtleVolumeSpike ?? 1.7)) return 'turtle_breakout';
    if (buyRatioRecentPct >= (sb.tapeBuyRatioPct ?? 58) && volumeSpike >= (sb.tapeVolumeSpike ?? 1.4)) return 'tape_flow_follow_through';
    return 'canonical_momentum_baseline';
  }

  getProfileKey(chainKey, strategyName, archetype) {
    return `${String(chainKey || '').toLowerCase()}:${String(strategyName || 'momentum').toLowerCase()}:${String(archetype || 'canonical_momentum_baseline').toLowerCase()}`;
  }

  getAdjustmentKey(chainKey, strategyName) {
    return `${String(chainKey || '').toLowerCase()}:${String(strategyName || 'momentum').toLowerCase()}`;
  }

  getAdaptiveParameters(chainKey, strategyName, strategyCfg = {}, tokenData = {}) {
    const brain = this.ensureState();
    const key = this.getAdjustmentKey(chainKey, strategyName);
    const adj = brain.adjustments[key] || {
      rsiBuyThresholdDelta: 0,
      rsiBuyMaxThresholdDelta: 0,
      volumeSpikeMultiplierDelta: 0,
      minPriceChange24hPctAllDelta: 0,
      maxPriceChange24hPctAllDelta: 0,
      updatedAt: null,
    };

    const adapted = {
      rsiBuyThreshold: Number(strategyCfg?.rsiBuyThreshold || 45) + Number(adj.rsiBuyThresholdDelta || 0),
      rsiBuyMaxThreshold: Number(strategyCfg?.rsiBuyMaxThreshold || 70) + Number(adj.rsiBuyMaxThresholdDelta || 0),
      volumeSpikeMultiplier: Number(strategyCfg?.volumeSpikeMultiplier || 2) + Number(adj.volumeSpikeMultiplierDelta || 0),
      minPriceChange24hPctAll: Number(strategyCfg?.minPriceChange24hPctAll || 0) + Number(adj.minPriceChange24hPctAllDelta || 0),
      maxPriceChange24hPctAll: Number(strategyCfg?.maxPriceChange24hPctAll || 0) + Number(adj.maxPriceChange24hPctAllDelta || 0),
    };

    const b = this.config.strategyBrain?.bounds || {};
    const rsiBuyMin                   = Number(b.rsiBuyMin                       ?? 20);
    const rsiBuyMax                   = Number(b.rsiBuyMax                       ?? 70);
    const rsiBuyMaxAbsoluteCeiling    = Number(b.rsiBuyMaxAbsoluteCeiling        ?? 90);
    const rsiBuyMaxMinSpread          = Number(b.rsiBuyMaxMinSpread              ?? 5);
    const volumeSpikeMin              = Number(b.volumeSpikeMin                  ?? 1.1);
    const volumeSpikeMax              = Number(b.volumeSpikeMax                  ?? 4);
    const minPriceChange24hPctAllMax  = Number(b.minPriceChange24hPctAllMax      ?? 25);
    const maxPriceChange24hPctAllFloor   = Number(b.maxPriceChange24hPctAllFloor   ?? 20);
    const maxPriceChange24hPctAllCeiling = Number(b.maxPriceChange24hPctAllCeiling ?? 160);
    adapted.rsiBuyThreshold = Math.max(rsiBuyMin, Math.min(rsiBuyMax, adapted.rsiBuyThreshold));
    adapted.rsiBuyMaxThreshold = Math.max(adapted.rsiBuyThreshold + rsiBuyMaxMinSpread, Math.min(rsiBuyMaxAbsoluteCeiling, adapted.rsiBuyMaxThreshold));
    adapted.volumeSpikeMultiplier = Math.max(volumeSpikeMin, Math.min(volumeSpikeMax, adapted.volumeSpikeMultiplier));
    adapted.minPriceChange24hPctAll = Math.max(0, Math.min(minPriceChange24hPctAllMax, adapted.minPriceChange24hPctAll));
    adapted.maxPriceChange24hPctAll = Math.max(maxPriceChange24hPctAllFloor, Math.min(maxPriceChange24hPctAllCeiling, adapted.maxPriceChange24hPctAll));

    const archetype = this.getBookArchetype(tokenData, {});
    const profileKey = this.getProfileKey(chainKey, strategyName, archetype);
    const archetypeKnowledge = STRATEGY_KNOWLEDGE_BASE[archetype] || STRATEGY_KNOWLEDGE_BASE.canonical_momentum_baseline;

    // Blend global adjustments when chain-specific history is thin (< minSamples * 2)
    const minSamples = Math.max(6, Number(this.config.risk?.brainMinSamples || 8));
    const chainProfile = brain.profiles[profileKey];
    const chainSamples = Number(chainProfile?.samples || 0);
    if (chainSamples > 0 && chainSamples < minSamples * 2) {
      const globalAdjKey = this.getAdjustmentKey('global', strategyName);
      const globalAdj = brain.adjustments[globalAdjKey];
      if (globalAdj) {
        const blendWeight = chainSamples > 0 ? Math.min(0.5, chainSamples / (minSamples * 2)) : 0;
        const globalWeight = 1 - blendWeight;
        adapted.volumeSpikeMultiplier += Number(globalAdj.volumeSpikeMultiplierDelta || 0) * globalWeight;
        adapted.minPriceChange24hPctAll += Number(globalAdj.minPriceChange24hPctAllDelta || 0) * globalWeight;
        adapted.rsiBuyThreshold += Number(globalAdj.rsiBuyThresholdDelta || 0) * globalWeight;
        adapted.volumeSpikeMultiplier = Math.max(1.1, Math.min(4, adapted.volumeSpikeMultiplier));
        adapted.minPriceChange24hPctAll = Math.max(0, Math.min(25, adapted.minPriceChange24hPctAll));
        adapted.rsiBuyThreshold = Math.max(20, Math.min(70, adapted.rsiBuyThreshold));
      }
    }

    return {
      ...adapted,
      archetype,
      archetypeFamily: archetypeKnowledge.family,
      profileKey,
      adjustmentKey: key,
      hasAdjustments: Object.values(adj).some((v) => typeof v === 'number' && Math.abs(v) > 0.0001),
    };
  }

  // Resolve the effective win rate for a profile — falls back to global cross-chain profile
  // when the chain-specific profile lacks enough samples to be reliable.
  _resolveEffectiveWinRate(brain, profileKey, globalProfileKey, minSamples) {
    const chain = brain.profiles[profileKey];
    const global = brain.profiles[globalProfileKey];
    const chainSamples = Number(chain?.samples || 0);
    const globalSamples = Number(global?.samples || 0);

    if (chainSamples >= minSamples) {
      const chainWr = Number(chain.recentWinRatePct || 50);
      if (globalSamples >= minSamples) {
        const globalWr = Number(global.recentWinRatePct || 50);
        return { winRate: chainWr * 0.7 + globalWr * 0.3, source: 'blended', chainSamples, globalSamples };
      }
      return { winRate: chainWr, source: 'chain', chainSamples, globalSamples };
    }

    if (globalSamples >= minSamples) {
      const globalWr = Number(global.recentWinRatePct || 50);
      return { winRate: globalWr * 0.85, source: 'global_fallback', chainSamples, globalSamples };
    }

    return { winRate: 50, source: 'insufficient', chainSamples, globalSamples };
  }

  shouldAllowEntry(chainKey, strategyName, archetype) {
    const brain = this.ensureState();
    const profileKey = this.getProfileKey(chainKey, strategyName, archetype);
    const globalProfileKey = this.getProfileKey('global', strategyName, archetype);

    const minSamples = Math.max(6, Number(this.config.risk?.brainMinSamples || 8));
    const blockWinRatePct = Math.max(0, Number(this.config.risk?.brainBlockWinRatePct || 22));
    const exploreBypassPct = Math.max(0, Number(this.config.risk?.brainExploreBypassPct || 7));

    const { winRate, source, chainSamples, globalSamples } = this._resolveEffectiveWinRate(
      brain, profileKey, globalProfileKey, minSamples
    );

    if (source === 'insufficient') return { allowed: true, profileKey };
    if (source === 'global_fallback') {
      return { allowed: true, profileKey, localEvidenceRequired: true };
    }
    if (winRate >= blockWinRatePct) return { allowed: true, profileKey };

    const roll = Math.random() * 100;
    if (roll < exploreBypassPct) {
      return { allowed: true, profileKey, exploreBypass: true };
    }

    return {
      allowed: false,
      profileKey,
      reason: `brain profile blocked (${profileKey}/${source}) winRate=${winRate.toFixed(1)}% chain=${chainSamples} global=${globalSamples}`,
    };
  }

  _updateProfile(brain, profileKey, win, finalTradePnl, window) {
    const profile = brain.profiles[profileKey] || {
      samples: 0, wins: 0, losses: 0, recentOutcomes: [],
      recentPnl: [], recentWinRatePct: 50, totalPnl: 0, updatedAt: null,
    };
    profile.samples += 1;
    if (win) profile.wins += 1;
    else profile.losses += 1;
    profile.totalPnl += Number(finalTradePnl || 0);
    profile.recentOutcomes = [...profile.recentOutcomes, win ? 1 : 0].slice(-window);
    profile.recentPnl = [...profile.recentPnl, Number(finalTradePnl || 0)].slice(-window);
    const recentWins = profile.recentOutcomes.reduce((s, v) => s + (v ? 1 : 0), 0);
    profile.recentWinRatePct = profile.recentOutcomes.length > 0
      ? (recentWins / profile.recentOutcomes.length) * 100
      : 50;
    profile.updatedAt = new Date().toISOString();
    brain.profiles[profileKey] = profile;
    return profile;
  }

  recordClosedTrade(position = {}, finalTradePnl = 0) {
    if (this.config.risk?.brainEnabled === false) return;

    const brain = this.ensureState();
    const chainKey = String(position.chainKey || position.chain || '').toLowerCase();
    const strategyName = String(position.strategy || 'momentum').toLowerCase();
    const archetype = String(position.brainArchetype || 'canonical_momentum_baseline').toLowerCase();
    if (!chainKey) return;

    const win = Number(finalTradePnl || 0) > 0;
    const window = Math.max(10, Number(this.config.risk?.brainWindowTrades || 40));

    const profileKey = this.getProfileKey(chainKey, strategyName, archetype);
    const profile = this._updateProfile(brain, profileKey, win, finalTradePnl, window);

    const globalProfileKey = this.getProfileKey('global', strategyName, archetype);
    this._updateProfile(brain, globalProfileKey, win, finalTradePnl, window);

    this.logger.info(
      `[Brain] ${profileKey} samples=${profile.samples} winRate=${profile.recentWinRatePct.toFixed(1)}% | ` +
      `global ${globalProfileKey} samples=${brain.profiles[globalProfileKey].samples}`
    );

    this.mutateParametersIfReady(chainKey, strategyName, profileKey, profile);
    this.mutateParametersIfReady('global', strategyName, globalProfileKey, brain.profiles[globalProfileKey]);
  }

  mutateParametersIfReady(chainKey, strategyName, profileKey, profile) {
    const minSamples = Math.max(6, Number(this.config.risk?.brainMinSamples || 8));
    if (Number(profile.samples || 0) < minSamples) return;

    const brain = this.ensureState();
    const key = this.getAdjustmentKey(chainKey, strategyName);
    // Copy-on-write: never mutate brain.adjustments[key] in place.
    const prev = brain.adjustments[key] || null;
    const curr = {
      rsiBuyThresholdDelta: Number(prev?.rsiBuyThresholdDelta || 0),
      rsiBuyMaxThresholdDelta: Number(prev?.rsiBuyMaxThresholdDelta || 0),
      volumeSpikeMultiplierDelta: Number(prev?.volumeSpikeMultiplierDelta || 0),
      minPriceChange24hPctAllDelta: Number(prev?.minPriceChange24hPctAllDelta || 0),
      maxPriceChange24hPctAllDelta: Number(prev?.maxPriceChange24hPctAllDelta || 0),
      updatedAt: prev?.updatedAt || null,
      version: Number(prev?.version || 0) + 1,
    };

    const low = Math.max(0, Number(this.config.risk?.brainLowWinRatePct || 35));
    const high = Math.max(low, Number(this.config.risk?.brainHighWinRatePct || 60));
    const winRate = Number(profile.recentWinRatePct || 50);

    let changed = false;
    if (winRate < low) {
      curr.volumeSpikeMultiplierDelta = Math.min(1.2, Number(curr.volumeSpikeMultiplierDelta || 0) + 0.1);
      curr.minPriceChange24hPctAllDelta = Math.min(8, Number(curr.minPriceChange24hPctAllDelta || 0) + 0.5);
      curr.rsiBuyThresholdDelta = Math.max(-8, Number(curr.rsiBuyThresholdDelta || 0) - 0.5);
      changed = true;
    } else if (winRate >= high) {
      curr.volumeSpikeMultiplierDelta = Math.max(-0.4, Number(curr.volumeSpikeMultiplierDelta || 0) - 0.05);
      curr.minPriceChange24hPctAllDelta = Math.max(-2, Number(curr.minPriceChange24hPctAllDelta || 0) - 0.25);
      curr.rsiBuyThresholdDelta = Math.min(5, Number(curr.rsiBuyThresholdDelta || 0) + 0.25);
      changed = true;
    }

    if (!changed) return;

    curr.updatedAt = new Date().toISOString();
    brain.adjustments[key] = curr;
    brain.mutations.unshift({
      timestamp: new Date().toISOString(),
      key,
      sourceProfile: profileKey,
      recentWinRatePct: winRate,
      adjustment: { ...curr },
    });
    if (brain.mutations.length > 120) brain.mutations = brain.mutations.slice(0, 120);

    this.logger.warn(
      `Strategy brain mutation ${key} from ${profileKey}: winRate=${winRate.toFixed(1)}% ` +
      `adj={volSpikeDelta:${curr.volumeSpikeMultiplierDelta.toFixed(2)}, minMoveDelta:${curr.minPriceChange24hPctAllDelta.toFixed(2)}, rsiMinDelta:${curr.rsiBuyThresholdDelta.toFixed(2)}}`
    );
  }
}

module.exports = StrategyBrain;
