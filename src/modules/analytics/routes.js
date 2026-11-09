'use strict';

const express = require('express');
const db = require('../../config/db');
const metrics = require('../../services/metrics');
const { requireAuth } = require('../../middleware/auth');

/**
 * Analytics module — a reporting dashboard over stored campaign counters.
 * Every figure comes from metrics.js or from a direct query against the
 * `campaigns` table. Nothing is estimated.
 */

const router = express.Router();

/** Accepts YYYY-MM-DD only; anything else becomes '' (ignored). */
function normalizeDate(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function fmtDay(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d) ? '' : d.toISOString();
}

function withRates(row) {
  const base = Number(row.delivered_count) || Number(row.sent_count) || 0;
  return {
    ...row,
    openRate: metrics.rate(row.open_count, base),
    clickRate: metrics.rate(row.click_count, base),
    bounceRate: metrics.rate(row.bounce_count, row.sent_count),
  };
}

/**
 * Campaign performance for an optional [from, to] window. The window is applied
 * to the campaign's most meaningful timestamp (completed → started → created).
 */
async function loadPerformance(from, to) {
  const where = [];
  const params = [];
  const stamp = 'COALESCE(completed_at, started_at, created_at)';
  if (from) {
    where.push(`${stamp} >= ?`);
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push(`${stamp} <= ?`);
    params.push(`${to} 23:59:59`);
  }

  const rows = await db.query(
    `SELECT id, name, subject, status, provider, total_recipients, sent_count, delivered_count,
            open_count, click_count, bounce_count, unsubscribe_count,
            started_at, completed_at, created_at
       FROM campaigns
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${stamp} DESC
      LIMIT 200`,
    params
  );
  return rows.map(withRates);
}

/* ------------------------------------------------------------- dashboard */

router.get('/', requireAuth, async (req, res, next) => {
  const from = normalizeDate(req.query.from);
  const to = normalizeDate(req.query.to);

  try {
    const [subs, totals, campaignCount, volumeRows, statusRows, topRows, recentRows, performance] = await Promise.all([
      metrics.subscriberStats(),
      metrics.campaignTotals(),
      metrics.allCampaignCount(),
      metrics.sendVolume(14),
      metrics.campaignsByStatus(),
      metrics.topPerformingCampaigns(5),
      metrics.recentCampaigns(10),
      loadPerformance(from, to),
    ]);

    const volume = volumeRows.map((v) => ({ day: fmtDay(v.day), count: v.count }));
    const volumeMax = volume.reduce((m, v) => Math.max(m, v.count), 0) || 1;

    const statusTotal = statusRows.reduce((s, r) => s + (Number(r.c) || 0), 0);
    const statuses = statusRows.map((r) => ({
      status: r.status,
      count: Number(r.c) || 0,
      pct: statusTotal ? ((Number(r.c) || 0) / statusTotal) * 100 : 0,
    }));

    res.render('analytics/index', {
      title: 'Analytics',
      active: 'analytics',
      subs,
      totals,
      campaignCount,
      volume,
      volumeMax,
      statuses,
      statusTotal,
      top: topRows.map(withRates),
      recent: recentRows.map(withRates),
      performance,
      from,
      to,
    });
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------- CSV export */

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/export', requireAuth, async (req, res, next) => {
  const from = normalizeDate(req.query.from);
  const to = normalizeDate(req.query.to);

  try {
    const rows = await loadPerformance(from, to);

    const columns = [
      'id', 'name', 'subject', 'status', 'provider',
      'total_recipients', 'sent_count', 'delivered_count',
      'open_count', 'click_count', 'bounce_count', 'unsubscribe_count',
      'open_rate_percent', 'click_rate_percent', 'bounce_rate_percent',
      'started_at', 'completed_at', 'created_at',
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-performance-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');

    res.write(columns.join(',') + '\r\n');
    for (const c of rows) {
      const line = [
        c.id, c.name, c.subject, c.status, c.provider,
        c.total_recipients, c.sent_count, c.delivered_count,
        c.open_count, c.click_count, c.bounce_count, c.unsubscribe_count,
        c.openRate.toFixed(2), c.clickRate.toFixed(2), c.bounceRate.toFixed(2),
        isoDate(c.started_at), isoDate(c.completed_at), isoDate(c.created_at),
      ].map(csvCell).join(',');
      res.write(line + '\r\n');
    }
    res.end();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
