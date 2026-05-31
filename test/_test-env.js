'use strict';
// 2026-05-31: marks test runs so production middleware (e.g. requirePerpsAdminToken)
// can short-circuit auth checks for in-process server construction. Loaded
// via the package.json `test` script's --import flag before any test file
// requires src/server.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}
