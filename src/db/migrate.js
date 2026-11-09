'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');

/**
 * Creates the database (if needed) and applies schema.sql.
 * Run with:  npm run migrate
 */

async function connect({ withDatabase }) {
  if (env.db.url) {
    // A connection string already points at a specific database.
    return mysql.createConnection({ uri: env.db.url, multipleStatements: true });
  }
  return mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: withDatabase ? env.db.database : undefined,
    ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
    multipleStatements: true,
  });
}

async function main() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  if (!env.db.url) {
    const root = await connect({ withDatabase: false });
    try {
      await root.query(
        `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      console.log(`✓ database "${env.db.database}" ready`);
    } catch (err) {
      // Managed providers (Railway, PlanetScale…) usually hand you a database
      // that already exists but withhold CREATE privileges. That is fine — we
      // only need the database to be reachable, which the next step proves.
      console.warn(`· skipped CREATE DATABASE (${err.code || err.message}); assuming "${env.db.database}" already exists`);
    } finally {
      await root.end();
    }
  }

  const conn = await connect({ withDatabase: true });
  try {
    await conn.query(sql);
    console.log('✓ schema applied');
  } finally {
    await conn.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✗ migration failed:', err.message);
    process.exit(1);
  });
