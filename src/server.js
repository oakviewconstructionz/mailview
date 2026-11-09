'use strict';

const env = require('./config/env');
const db = require('./config/db');
const createApp = require('./app');

/** Boots the HTTP server and (optionally) the in-process campaign worker. */
async function start() {
  try {
    await db.ping();
    console.log('✓ database connection ok');
  } catch (err) {
    console.error('✗ could not connect to the database:', err.message);
    console.error('  Check your DB_* / DATABASE_URL settings and that the schema has been applied (npm run migrate).');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`\n  ${env.appName} listening on http://localhost:${env.port}`);
    console.log(`  environment: ${env.nodeEnv}\n`);
  });

  if (env.campaigns.runWorkerInWeb) {
    const { startWorker } = require('./worker');
    startWorker().catch((err) => console.error('[worker] failed to start:', err.message));
  }

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
