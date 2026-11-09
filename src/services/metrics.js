'use strict';

const db = require('../config/db');

/**
 * Aggregated metrics shared by the dashboard and the analytics module.
 * Rates are computed from stored counters; nothing is estimated.
 */

function rate(part, total) {
  const t = Number(total) || 0;
  if (!t) return 0;
  return Number(((Number(part) || 0) / t) * 100);
}

async function subscriberStats() {
  const row = await db.one(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'subscribed') AS subscribed,
      SUM(status = 'unsubscribed') AS unsubscribed,
      SUM(status = 'bounced') AS bounced
    FROM subscribers
  `);
  return {
    total: Number(row.total) || 0,
    subscribed: Number(row.subscribed) || 0,
    unsubscribed: Number(row.unsubscribed) || 0,
    bounced: Number(row.bounced) || 0,
  };
}

async function suppressionCount() {
  const row = await db.one('SELECT COUNT(*) AS c FROM suppressions');
  return Number(row.c) || 0;
}

async function campaignTotals() {
  const row = await db.one(`
    SELECT
      COUNT(*) AS campaigns,
      COALESCE(SUM(sent_count), 0)        AS sent,
      COALESCE(SUM(delivered_count), 0)   AS delivered,
      COALESCE(SUM(failed_count), 0)      AS failed,
      COALESCE(SUM(open_count), 0)        AS opens,
      COALESCE(SUM(click_count), 0)       AS clicks,
      COALESCE(SUM(bounce_count), 0)      AS bounces,
      COALESCE(SUM(unsubscribe_count), 0) AS unsubscribes
    FROM campaigns
    WHERE status IN ('sending','sent','paused','queued')
  `);
  const sent = Number(row.sent) || 0;
  const delivered = Number(row.delivered) || 0;
  const opens = Number(row.opens) || 0;
  const clicks = Number(row.clicks) || 0;
  const bounces = Number(row.bounces) || 0;
  return {
    campaigns: Number(row.campaigns) || 0,
    sent,
    delivered,
    failed: Number(row.failed) || 0,
    opens,
    clicks,
    bounces,
    unsubscribes: Number(row.unsubscribes) || 0,
    openRate: rate(opens, delivered || sent),
    clickRate: rate(clicks, delivered || sent),
    bounceRate: rate(bounces, sent),
  };
}

async function allCampaignCount() {
  const row = await db.one('SELECT COUNT(*) AS c FROM campaigns');
  return Number(row.c) || 0;
}

async function recentCampaigns(limit = 6) {
  return db.query(
    `SELECT id, name, subject, status, total_recipients, sent_count, delivered_count,
            open_count, click_count, bounce_count, scheduled_at, started_at, completed_at, created_at
       FROM campaigns
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC
      LIMIT ?`,
    [limit]
  );
}

async function recentActivity(limit = 10) {
  return db.query(
    `SELECT a.action, a.meta, a.created_at, u.name AS user_name
       FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT ?`,
    [limit]
  );
}

/** Daily send volume for the last `days` days (for the analytics chart). */
async function sendVolume(days = 14) {
  const rows = await db.query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS c
       FROM campaign_events
      WHERE type = 'send' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at) ORDER BY day ASC`,
    [days]
  );
  return rows.map((r) => ({ day: r.day, count: Number(r.c) }));
}

async function campaignsByStatus() {
  return db.query('SELECT status, COUNT(*) AS c FROM campaigns GROUP BY status');
}

async function topPerformingCampaigns(limit = 5) {
  return db.query(
    `SELECT id, name, sent_count, delivered_count, open_count, click_count
       FROM campaigns
      WHERE status IN ('sent','sending') AND sent_count > 0
      ORDER BY open_count DESC LIMIT ?`,
    [limit]
  );
}

module.exports = {
  subscriberStats,
  suppressionCount,
  campaignTotals,
  allCampaignCount,
  recentCampaigns,
  recentActivity,
  sendVolume,
  campaignsByStatus,
  topPerformingCampaigns,
  rate,
};
