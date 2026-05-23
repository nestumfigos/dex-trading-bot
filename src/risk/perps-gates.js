'use strict';
// SCAFFOLD — throws NotImplementedError if any export is called.
// When implemented: daily -2R/-2% cap, weekly -5R/-5% cap, per-trade R:R 1:3 min,
// manual cut on 3-5 sideways candles, liquidation buffer pre-check.
const { guard } = require('../_not-implemented');
module.exports = guard('risk/perps-gates.js');
