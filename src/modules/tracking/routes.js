'use strict';

const express = require('express');
const db = require('../../config/db');
const env = require('../../config/env');
const helpers = require('../../lib/helpers');

/**
 * Public tracking endpoints — no session required (recipients are anonymous).
 * Each carries the opaque per-recipient token generated when the campaign was
 * queued, so events are attributed to a real, individual send.
 */

const router = express.Router();

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

async function recipientByToken(token) {
  if (!token) return null;
  return db.one('SELECT * FROM campaign_recipients WHERE token = ? LIMIT 1', [token]);
}

async function recordEvent(campaignId, recipientId, type, meta = null) {
  try {
    await db.query(
      'INSERT INTO campaign_events (campaign_id, recipient_id, type, meta) VALUES (?, ?, ?, ?)',
      [campaignId, recipientId, type, meta ? JSON.stringify(meta) : null]
    );
  } catch (_) { /* tracking must never break the recipient's experience */ }
}

/* --------------------------------------------------------------- open pixel */

router.get('/o/:token', async (req, res) => {
  const token = String(req.params.token || '').replace(/\.gif$/, '');
  try {
    const r = await recipientByToken(token);
    if (r && !r.opened_at) {
      await db.query(
        "UPDATE campaign_recipients SET status = IF(status IN ('delivered','sent','queued'), 'opened', status), opened_at = NOW() WHERE id = ?",
        [r.id]
      );
      await db.query('UPDATE campaigns SET open_count = open_count + 1 WHERE id = ?', [r.campaign_id]);
      await recordEvent(r.campaign_id, r.id, 'open', { ua: req.headers['user-agent'] || null });
    }
  } catch (_) { /* ignore */ }

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  return res.end(PIXEL);
});

/* --------------------------------------------------------------- link click */

router.get('/c/:linkToken', async (req, res) => {
  let destination = '/';
  try {
    const link = await db.one('SELECT * FROM campaign_links WHERE token = ? LIMIT 1', [req.params.linkToken]);
    if (!link) return res.redirect('/');
    destination = link.url;

    const recipientToken = req.query.r;
    const r = await recipientByToken(recipientToken);
    if (r) {
      if (!r.clicked_at) {
        await db.query(
          'UPDATE campaign_recipients SET status = IF(status IN (\'delivered\',\'sent\',\'opened\',\'queued\'), \'clicked\', status), clicked_at = NOW() WHERE id = ?',
          [r.id]
        );
        await db.query('UPDATE campaigns SET click_count = click_count + 1 WHERE id = ?', [r.campaign_id]);
      }
      await recordEvent(r.campaign_id, r.id, 'click', { url: link.url });
    }
    await db.query('UPDATE campaign_links SET clicks = clicks + 1 WHERE id = ?', [link.id]);
  } catch (_) { /* ignore */ }
  return res.redirect(destination);
});

/* -------------------------------------------------------------- unsubscribe */

async function doUnsubscribe(token, via) {
  const r = await recipientByToken(token);
  if (!r) return { ok: false, email: null };

  await db.query(
    "UPDATE campaign_recipients SET status = 'unsubscribed' WHERE id = ?",
    [r.id]
  );
  await db.query('UPDATE campaigns SET unsubscribe_count = unsubscribe_count + 1 WHERE id = ?', [r.campaign_id]);
  await db.query(
    `INSERT INTO suppressions (email, reason, detail) VALUES (?, 'unsubscribe', ?)
     ON DUPLICATE KEY UPDATE reason = reason`,
    [r.email, `campaign #${r.campaign_id} (${via})`]
  );
  if (r.subscriber_id) {
    await db.query("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?", [r.subscriber_id]);
  } else {
    await db.query("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?", [r.email]);
  }
  await recordEvent(r.campaign_id, r.id, 'unsubscribe', { via });
  return { ok: true, email: r.email };
}

// Human-facing confirmation page.
router.get('/u/:token', async (req, res) => {
  const r = await recipientByToken(req.params.token);
  res.render('track/unsubscribe', {
    title: 'Unsubscribe',
    email: r ? r.email : null,
    token: req.params.token,
    done: req.query.done === '1',
  });
});

// One-click POST (used by the List-Unsubscribe=One-Click header).
router.post('/u/:token', async (req, res) => {
  const result = await doUnsubscribe(req.params.token, 'one-click');
  if (req.headers.accept && !req.headers.accept.includes('text/html')) {
    return res.status(result.ok ? 200 : 404).json({ ok: result.ok });
  }
  return res.redirect(`/t/u/${req.params.token}?done=1`);
});

// Explicit confirmation from the page form.
router.post('/u/:token/confirm', async (req, res) => {
  await doUnsubscribe(req.params.token, 'link');
  return res.redirect(`/t/u/${req.params.token}?done=1`);
});

/* Exposed for the send service to build tracking URLs. */
function buildUnsubscribeUrl(token) {
  return `${env.appUrl}/t/u/${token}`;
}
function buildPixelUrl(token) {
  return `${env.appUrl}/t/o/${token}.gif`;
}
function buildClickUrl(linkToken, recipientToken) {
  return `${env.appUrl}/t/c/${linkToken}?r=${encodeURIComponent(recipientToken)}`;
}

module.exports = router;
module.exports.buildUnsubscribeUrl = buildUnsubscribeUrl;
module.exports.buildPixelUrl = buildPixelUrl;
module.exports.buildClickUrl = buildClickUrl;
module.exports.doUnsubscribe = doUnsubscribe;
