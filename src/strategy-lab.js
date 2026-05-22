'use strict';

const fs = require('fs').promises;
const path = require('path');

class StrategyLab {
  constructor({ logger, projectRoot, dataDir = 'data' }) {
    this.logger = logger || console;
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.rootDir = path.join(projectRoot, dataDir, 'strategy-lab');
    this.proposalsDir = path.join(this.rootDir, 'proposals');
    this.resultsDir = path.join(this.rootDir, 'results');
  }

  async ensureDirs() {
    await fs.mkdir(this.proposalsDir, { recursive: true });
    await fs.mkdir(this.resultsDir, { recursive: true });
  }

  async createProposal({ summary, hypothesis, parameters, baselineMetrics, source = 'self_evolution' }) {
    await this.ensureDirs();
    const id = `strategy-${Date.now()}`;
    const payload = {
      id,
      createdAt: new Date().toISOString(),
      source,
      status: 'proposed',
      summary: String(summary || ''),
      hypothesis: String(hypothesis || ''),
      parameters: parameters || {},
      baselineMetrics: baselineMetrics || {},
    };
    const filePath = path.join(this.proposalsDir, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { id, filePath, payload };
  }

  async recordValidationResult(proposalId, result) {
    await this.ensureDirs();
    const filePath = path.join(this.resultsDir, `${proposalId}.json`);
    const payload = {
      proposalId,
      recordedAt: new Date().toISOString(),
      ...result,
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
  }
}

module.exports = StrategyLab;
