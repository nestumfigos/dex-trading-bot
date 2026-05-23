'use strict';
/** Throw-on-call guard. Imported by every stub module so accidental wiring
 *  produces a loud failure rather than silent malformed perp orders. */
class NotImplementedError extends Error {
  constructor(modulePath) {
    super(`PERPS: ${modulePath} is not implemented — see dex-trading-bot/docs/runbooks/PERPS_BOOTSTRAP.md`);
    this.name = 'NotImplementedError';
    this.code = 'PERPS_NOT_IMPLEMENTED';
  }
}
function guard(modulePath) {
  return new Proxy({}, {
    get(_, key) {
      if (key === 'then' || key === 'inspect' || typeof key === 'symbol') return undefined;
      return () => { throw new NotImplementedError(`${modulePath}.${String(key)}()`); };
    },
  });
}
module.exports = { NotImplementedError, guard };
