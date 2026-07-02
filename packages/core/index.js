'use strict';

module.exports = {
  ...require('./events/event-bus'),
  ...require('./strategy/strategy-contract'),
  ...require('./strategy/strategy-router'),
  ...require('./execution/execution-adapter'),
  ...require('./execution/order-lifecycle'),
  ...require('./execution/lifecycle-telemetry'),
  ...require('./execution/venue-health'),
  ...require('./risk/risk-contract'),
  ...require('./telemetry/telemetry-sink'),
  ...require('./telemetry/prometheus'),
  ...require('./state/state-store'),
  ...require('./portfolio/portfolio-risk'),
  ...require('./governance/mutation-proposal'),
  ...require('./governance/promotion-gates'),
  ...require('./config/profile-schema'),
  ...require('./config/config-provenance'),
};
