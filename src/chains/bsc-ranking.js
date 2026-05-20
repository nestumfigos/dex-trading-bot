'use strict';

// Extracted from src/index.js (Week 12 A.10).
// Ranks BSC momentum universe into core/exploration/borderline lanes.

function createBscRanking(deps) {
  const { config, logger, setBscDiscoveryLaneMetadata } = deps;

  async function rankBscMomentumUniverse(exchange, candidates = []) {
    const topEnabled = config.discovery?.bscTopUniverseEnabled !== false;
    if (!topEnabled || !Array.isArray(candidates) || candidates.length === 0) {
      setBscDiscoveryLaneMetadata([], null);
      return Array.isArray(candidates) ? candidates : [];
    }

    const topN = Math.max(10, Number(config.discovery?.bscTopUniverseSize || 200));
    const coreLimit = Math.max(1, Number(config.discovery?.bscCoreUniverseSize || Math.round(topN * 0.7) || topN));
    const explorationEnabled = config.discovery?.bscExplorationEnabled !== false;
    const explorationLimit = explorationEnabled
      ? Math.max(0, Number(config.discovery?.bscExplorationUniverseSize || Math.max(20, topN - coreLimit)))
      : 0;
    const borderlineEnabled = config.discovery?.bscBorderlineEnabled === true;
    const borderlineLimit = borderlineEnabled
      ? Math.max(0, Number(config.discovery?.bscBorderlineUniverseSize || 10))
      : 0;
    const coreMinLiquidityUsd = Math.max(0, Number(
      config.discovery?.bscCoreMinLiquidityUsd
      || config.discovery?.bscTopUniverseMinLiquidityUsd
      || 150000
    ));
    const coreMinVolume24hUsd = Math.max(0, Number(
      config.discovery?.bscCoreMinVolume24hUsd
      || config.discovery?.bscTopUniverseMinVolume24hUsd
      || 500000
    ));
    const explorationMinLiquidityUsd = Math.max(0, Number(config.discovery?.bscExplorationMinLiquidityUsd || 85000));
    const explorationMinVolume24hUsd = Math.max(0, Number(config.discovery?.bscExplorationMinVolume24hUsd || 150000));
    const borderlineMinLiquidityUsd = Math.max(0, Number(config.discovery?.bscBorderlineMinLiquidityUsd || 65000));
    const borderlineMinVolume24hUsd = Math.max(0, Number(config.discovery?.bscBorderlineMinVolume24hUsd || 125000));
    const maxAgeDays = Math.max(0, Number(config.discovery?.bscTopUniverseMaxAgeDays || 0));
    const requireLegitimacy = Boolean(config.discovery?.bscTopUniverseRequireLegitimacy);
    const batchSize = Math.max(5, Number(config.discovery?.bscTopUniverseRankBatchSize || 25));
    const maxRankDurationMs = Math.max(5000, Number(config.discovery?.bscTopUniverseMaxRankDurationMs || 90000));
    const startedAt = Date.now();

    const uniqueCandidates = [...new Set(candidates)].slice(0, 3000);
    const rankedCore = [];
    const rankedExploration = [];
    const rankedBorderline = [];
    const stats = {
      fetched: 0,
      missingTokenData: 0,
      filteredLiquidity: 0,
      filteredVolume: 0,
      filteredAge: 0,
      filteredLegitimacy: 0,
      qualifiedCore: 0,
      qualifiedExploration: 0,
      qualifiedBorderline: 0,
    };

    for (let i = 0; i < uniqueCandidates.length; i += batchSize) {
      if ((Date.now() - startedAt) > maxRankDurationMs) {
        logger.warn(
          `BSC rank timeout: stopping after ${Date.now() - startedAt}ms ` +
          `(${i}/${uniqueCandidates.length} candidates processed)`
        );
        break;
      }

      const batch = uniqueCandidates.slice(i, i + batchSize);
      const rows = await Promise.allSettled(batch.map(async (address) => {
        const token = await exchange.getTokenData(address);
        if (!token || !token.price) {
          stats.missingTokenData += 1;
          return null;
        }

        stats.fetched += 1;

        const liquidityUsd = Number(token.liquidityUsd || 0);
        const volume24h = Number(token.volume24h || token.volume24hUsd || 0);
        const listingAgeDays = Number(token.listingAgeDays || 0);
        const listingAgeHours = listingAgeDays * 24;
        token.tokenAgeBucket = listingAgeHours > 0 && listingAgeHours < 24
          ? 'new'
          : listingAgeHours < 168
          ? 'emerging'
          : 'established';
        const legitimacy = Boolean(token.coingeckoId || token.listedOnCoinGecko || token.listedOnCoinMarketCap);

        if (maxAgeDays > 0 && listingAgeDays > maxAgeDays) {
          stats.filteredAge += 1;
          return null;
        }
        if (requireLegitimacy && !legitimacy) {
          stats.filteredLegitimacy += 1;
          return null;
        }

        let lane = null;
        if (liquidityUsd >= coreMinLiquidityUsd && volume24h >= coreMinVolume24hUsd) {
          lane = 'core';
        } else if (
          explorationEnabled
          && liquidityUsd >= explorationMinLiquidityUsd
          && volume24h >= explorationMinVolume24hUsd
        ) {
          lane = 'exploration';
        } else if (
          borderlineEnabled
          && liquidityUsd >= borderlineMinLiquidityUsd
          && volume24h >= borderlineMinVolume24hUsd
        ) {
          lane = 'borderline';
        }

        if (!lane) {
          if (liquidityUsd < explorationMinLiquidityUsd) {
            stats.filteredLiquidity += 1;
          } else {
            stats.filteredVolume += 1;
          }
          return null;
        }

        if (lane === 'core') {
          stats.qualifiedCore += 1;
        } else if (lane === 'exploration') {
          stats.qualifiedExploration += 1;
        } else {
          stats.qualifiedBorderline += 1;
        }

        const liqScore = Math.log10(Math.max(1, liquidityUsd));
        const volScore = Math.log10(Math.max(1, volume24h));
        const ageScore = listingAgeDays > 0 ? Math.min(1.5, Math.log10(1 + listingAgeDays)) : 0;
        const legitimacyBonus = legitimacy ? 0.6 : 0;
        const laneBonus = lane === 'core' ? 0.25 : (lane === 'exploration' ? 0 : -0.1);
        const score = (liqScore * 0.55) + (volScore * 0.35) + (ageScore * 0.10) + legitimacyBonus + laneBonus;

        return {
          address: token.address || address,
          score,
          lane,
          liquidityUsd,
          volume24h,
        };
      }));

      rows.forEach((row) => {
        if (row.status !== 'fulfilled' || !row.value) return;
        if (row.value.lane === 'core') {
          rankedCore.push(row.value);
        } else if (row.value.lane === 'exploration') {
          rankedExploration.push(row.value);
        } else {
          rankedBorderline.push(row.value);
        }
      });
    }

    rankedCore.sort((a, b) => b.score - a.score);
    rankedExploration.sort((a, b) => b.score - a.score);
    rankedBorderline.sort((a, b) => b.score - a.score);

    const selected = [];
    const selectedCore = rankedCore.slice(0, Math.min(coreLimit, topN));
    selected.push(...selectedCore);

    const explorationSlots = Math.max(0, Math.min(explorationLimit, topN - selected.length));
    const selectedExploration = rankedExploration.slice(0, explorationSlots);
    selected.push(...selectedExploration);

    const borderlineSlots = Math.max(0, Math.min(borderlineLimit, topN - selected.length));
    const selectedBorderline = rankedBorderline.slice(0, borderlineSlots);
    selected.push(...selectedBorderline);

    if (selected.length < topN) {
      const leftovers = [
        ...rankedCore.slice(selectedCore.length),
        ...rankedExploration.slice(selectedExploration.length),
        ...rankedBorderline.slice(selectedBorderline.length),
      ].sort((a, b) => b.score - a.score);
      selected.push(...leftovers.slice(0, topN - selected.length));
    }

    const shortlisted = selected.slice(0, topN);
    setBscDiscoveryLaneMetadata(shortlisted, {
      baseCandidates: uniqueCandidates.length,
      shortlisted: shortlisted.length,
      coreQualified: rankedCore.length,
      explorationQualified: rankedExploration.length,
      borderlineQualified: rankedBorderline.length,
      coreSelected: shortlisted.filter((item) => item.lane === 'core').length,
      explorationSelected: shortlisted.filter((item) => item.lane === 'exploration').length,
      borderlineSelected: shortlisted.filter((item) => item.lane === 'borderline').length,
      coreMinLiquidityUsd,
      coreMinVolume24hUsd,
      explorationMinLiquidityUsd,
      explorationMinVolume24hUsd,
      borderlineMinLiquidityUsd,
      borderlineMinVolume24hUsd,
    });

    logger.info(
      `BSC ranked momentum universe: ${shortlisted.length}/${uniqueCandidates.length} ` +
      `(top=${topN}, core=${rankedCore.length}->${shortlisted.filter((item) => item.lane === 'core').length} ` +
      `@ $${Math.round(coreMinLiquidityUsd)}/$${Math.round(coreMinVolume24hUsd)}, ` +
      `explore=${rankedExploration.length}->${shortlisted.filter((item) => item.lane === 'exploration').length} ` +
      `@ $${Math.round(explorationMinLiquidityUsd)}/$${Math.round(explorationMinVolume24hUsd)}, ` +
      `borderline=${rankedBorderline.length}->${shortlisted.filter((item) => item.lane === 'borderline').length} ` +
      `@ $${Math.round(borderlineMinLiquidityUsd)}/$${Math.round(borderlineMinVolume24hUsd)}, ` +
      `fetched=${stats.fetched}, noData=${stats.missingTokenData}, lowLiq=${stats.filteredLiquidity}, ` +
      `lowVol=${stats.filteredVolume}, old=${stats.filteredAge}, illegitimate=${stats.filteredLegitimacy}, ` +
      `elapsedMs=${Date.now() - startedAt})`
    );

    return shortlisted.map((item) => item.address);
  }

  return { rankBscMomentumUniverse };
}

module.exports = { createBscRanking };
