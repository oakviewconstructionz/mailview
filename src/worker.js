'use strict';

const db = require('./config/db');
const env = require('./config/env');
const { processCampaign, syncBulkStats } = require('./services/campaignSender');
const { sleep } = require('./lib/queue');

/**
 * Background campaign worker.
 *
 * Runs either inside the web process (RUN_WORKER_IN_WEB=true, default on
 * Railway) or as a dedicated process (`npm run worker`). It:
 *   • promotes due scheduled campaigns into the queue,
 *   • drives queued campaigns (bulk sync + send, or per-recipient drain),
 *   • polls the provider for real stats on in-flight bulk campaigns.
 *
 * The worker never sends thousands of messages inside a single HTTP request —
 * everything happens here, in throttled batches.
 */

const TICK_MS = 5000;
const active = new Set(); // campaign ids currently being processed
let timer = null;
let running = false;

async function promoteScheduled() {
  const due = await db.query(
    "SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW() LIMIT 20"
  );
  for (const row of due) {
    await db.query("UPDATE campaigns SET status = 'queued' WHERE id = ?", [row.id]);
  }
  return due.length;
}

async function pickQueued() {
  return db.query(
    "SELECT * FROM campaigns WHERE status IN ('queued','syncing') OR (status = 'sending' AND provider_campaign_id IS NULL) ORDER BY COALESCE(started_at, created_at) ASC LIMIT 5"
  );
}

async function pollStats() {
  const rows = await db.query(
    "SELECT * FROM campaigns WHERE status = 'sending' AND provider_campaign_id IS NOT NULL LIMIT 10"
  );
  for (const c of rows) {
    try {
      await syncBulkStats(c);
    } catch (err) {
      console.error(`[worker] stats sync failed for campaign #${c.id}:`, err.message);
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await promoteScheduled();

    const queued = await pickQueued();
    for (const campaign of queued) {
      if (active.has(campaign.id)) continue; // already in flight
      active.add(campaign.id);
      // Fire and track; a long bulk sync must not block other work.
      processCampaign(campaign)
        .catch((err) => console.error(`[worker] campaign #${campaign.id} failed:`, err.message))
        .finally(() => active.delete(campaign.id));
    }

    await pollStats();
  } catch (err) {
    console.error('[worker] tick error:', err.message);
  } finally {
    running = false;
  }
}

async function startWorker() {
  if (timer) return;
  console.log('✓ campaign worker started' + (env.campaigns.runWorkerInWeb ? ' (in web process)' : ''));
  await db.ping().catch(() => {});
  // Small initial delay so migrations/first boot settle.
  await sleep(1500);
  await tick();
  timer = setInterval(tick, TICK_MS);
  return timer;
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startWorker, stopWorker, tick };

// Allow running as a standalone process: `npm run worker`
if (require.main === module) {
  startWorker()
    .then(() => console.log('  worker loop running — press Ctrl+C to stop'))
    .catch((err) => {
      console.error('✗ worker failed to start:', err.message);
      process.exit(1);
    });
  process.on('SIGTERM', () => { stopWorker(); process.exit(0); });
  process.on('SIGINT', () => { stopWorker(); process.exit(0); });
}
