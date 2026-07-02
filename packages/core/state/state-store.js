'use strict';

function assertStateStore(store) {
  if (!store || typeof store !== 'object') throw new Error('state store must be an object');
  ['load', 'save', 'snapshot'].forEach((method) => {
    if (typeof store[method] !== 'function') throw new Error(`state store.${method} must be a function`);
  });
  if (store.restore != null && typeof store.restore !== 'function') {
    throw new Error('state store.restore must be a function when provided');
  }
  return store;
}

function normalizeStateSnapshot(raw = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('state snapshot must be an object');
  const revision = Number(raw.revision || 0);
  return {
    version: Number(raw.version || 1),
    botProfile: raw.botProfile || raw.bot_profile || null,
    revision: Number.isFinite(revision) ? revision : 0,
    capturedAt: raw.capturedAt || raw.ts || new Date().toISOString(),
    state: raw.state && typeof raw.state === 'object' ? { ...raw.state } : { ...raw },
    source: raw.source || 'unknown',
  };
}

function createMemoryStateStore({
  initialState = {},
  botProfile = null,
  now = () => new Date(),
} = {}) {
  let revision = 0;
  let state = { ...initialState };

  async function load() {
    return { ...state };
  }

  async function save(nextState = {}, metadata = {}) {
    revision += 1;
    state = { ...nextState };
    return normalizeStateSnapshot({
      version: 1,
      botProfile,
      revision,
      capturedAt: new Date(now()).toISOString(),
      source: metadata.source || 'memory',
      state,
    });
  }

  async function snapshot(metadata = {}) {
    return normalizeStateSnapshot({
      version: 1,
      botProfile,
      revision,
      capturedAt: new Date(now()).toISOString(),
      source: metadata.source || 'memory',
      state,
    });
  }

  async function restore(snapshotPayload = {}) {
    const normalized = normalizeStateSnapshot(snapshotPayload);
    revision = normalized.revision;
    state = { ...normalized.state };
    return { ...state };
  }

  return assertStateStore({ load, save, snapshot, restore });
}

module.exports = {
  assertStateStore,
  normalizeStateSnapshot,
  createMemoryStateStore,
};
