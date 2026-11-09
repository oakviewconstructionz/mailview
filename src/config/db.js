'use strict';

const mysql = require('mysql2/promise');
const env = require('./env');

/**
 * Shared MySQL connection pool. Works with either discrete DB_* variables or a
 * single DATABASE_URL / MYSQL_URL connection string (as injected by Railway).
 */

let poolConfig;

if (env.db.url) {
  poolConfig = {
    uri: env.db.url,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
  };
} else {
  poolConfig = {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  };
}

const pool = mysql.createPool(poolConfig);

async function query(sql, params) {
  const [rows] = await pool.execute(sql, params || []);
  return rows;
}

/** Returns the first row or null. */
async function one(sql, params) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Runs `fn` inside a transaction, passing a dedicated connection. */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, one, transaction, ping };
