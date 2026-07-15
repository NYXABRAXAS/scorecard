'use strict';

const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  // A background/idle client failing is not fatal to the process, but must never
  // fail silently in a financial system.
  // eslint-disable-next-line no-console
  console.error('[db] unexpected error on idle client', err);
});

/** Run a single query with automatic parameterisation (always use $1, $2, ... — never string-concat SQL). */
function query(text, params) {
  return pool.query(text, params);
}

/** Run a callback inside a single transaction; rolls back automatically on any thrown error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
