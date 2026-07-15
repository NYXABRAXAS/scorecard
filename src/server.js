'use strict';

const app = require('./app');
const env = require('./config/env');
const { pool } = require('./config/db');

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[scorecardapi] listening on port ${env.port} (${env.env}) — docs at /docs`);
});

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[scorecardapi] received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  // Force-exit if graceful shutdown hangs.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
