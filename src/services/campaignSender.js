'use strict';

const crypto = require('crypto');

const db = require('../config/db');
const settings = require('../config/settings');
const helpers = require('../lib/helpers');
const tracking = require('../lib/tracking');
const { RateLimiter, mapLimit, sleep } = require('../lib/queue');
const { getDeliveryProvider } = require('../providers/delivery');
const { ValidationError } = require('../lib/errors');

/**
 * Campaign sending service.
 *
 * Two honest sending modes, chosen from the delivery provider's capability:
 *
 *   A. Bulk mode  (Sender.net, supportsBulkCampaigns = true)
 *      1. Build the audience (list/segment, minus suppressions, de-duplicated).
 *      2. Sync that audience into a group at the provider (rate-limited, in the
 *         background — this is the "audience" step, status: syncing).
 *      3. Create a campaign at the provider and trigger the send (status: sending).
 *      4. Poll the provider for real aggregate stats (opens/clicks/bounces).
 *      Per-recipient delivery detail is owned by the provider; we never invent it.
 *
 *   B. Per-recipient mode (SMTP, supportsBulkCampaigns = false)
 *      Each queued recipient is sent individually by our background queue with
 *      our own open pixel + click tracking, honouring the configured rate,
 *      concurrency, batch size and pause. Failures are recorded as failures.
 *
 * Nothing is marked as sent/delivered unless the provider confirmed it.
 */

/* ------------------------------------------------------------------ audience */

/** Resolves the campaign audience: subscribed, not suppressed, de-duplicated. */
async function resolveAudience(campaign, limitOverride) {
  const params = [];
  let where = '';

  if (campaign.list_id) {
    where += ' AND ls.list_id = ?';
    params.push(campaign.list_id);
  }

  let joinSegment = '';
  if (campaign.segment_id) {
    const seg = await db.one('SELECT * FROM segments WHERE id = ?', [campaign.segment_id]);
    const rules = seg && seg.rules ? (typeof seg.rules === 'string' ? JSON.parse(seg.rules) : seg.rules) : {};
    if (rules.list_id) {
      where += ' AND ls.list_id = ?';
      params.push(rules.list_id);
    }
    if (rules.has_opened) {
      joinSegment += ' AND EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.subscriber_id = s.id AND cr.opened_at IS NOT NULL)';
    }
    if (rules.has_clicked) {
      joinSegment += ' AND EXISTS (SELECT 1 FROM campaign_recipients cr2 WHERE cr2.subscriber_id = s.id AND cr2.clicked_at IS NOT NULL)';
    }
  }

  const limit = limitOverride || campaign.max_recipients || (await settings.getInt('campaigns.max_recipients_per_campaign', 3000));

  const emailExpr = 'LOWER(s.email)';
  const usesList = Boolean(campaign.list_id || campaign.segment_id);

  const sql = `
    SELECT s.id AS subscriber_id, ${emailExpr} AS email, s.first_name, s.last_name, s.company, s.custom_data
      FROM subscribers s
      ${usesList ? 'JOIN list_subscribers ls ON ls.subscriber_id = s.id' : ''}
     WHERE s.status = 'subscribed'
       ${where}
       ${joinSegment}
       AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE LOWER(sp.email) = ${emailExpr})
     GROUP BY s.id
     ORDER BY s.id ASC
     LIMIT ?
  `;
  const paramsWithLimit = [...params, Math.max(1, limit)];

  const rows = await db.query(sql, paramsWithLimit);

  // De-duplicate by email (protects against duplicate rows across lists).
  const seen = new Set();
  const audience = [];
  for (const r of rows) {
    if (!r.email || seen.has(r.email)) continue;
    seen.add(r.email);
    audience.push(r);
  }
  return audience;
}

/**
 * Counts the audience without materialising rows (used by the campaign UI to
 * show how many people a list/segment will reach before it is launched).
 * Mirrors the filters in resolveAudience so the two never disagree.
 */
async function countAudience(campaign) {
  const params = [];
  let where = '';

  if (campaign.list_id) {
    where += ' AND ls.list_id = ?';
    params.push(campaign.list_id);
  }

  let joinSegment = '';
  if (campaign.segment_id) {
    const seg = await db.one('SELECT * FROM segments WHERE id = ?', [campaign.segment_id]);
    const rules = seg && seg.rules ? (typeof seg.rules === 'string' ? JSON.parse(seg.rules) : seg.rules) : {};
    if (rules.list_id) {
      where += ' AND ls.list_id = ?';
      params.push(rules.list_id);
    }
    if (rules.has_opened) {
      joinSegment += ' AND EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.subscriber_id = s.id AND cr.opened_at IS NOT NULL)';
    }
    if (rules.has_clicked) {
      joinSegment += ' AND EXISTS (SELECT 1 FROM campaign_recipients cr2 WHERE cr2.subscriber_id = s.id AND cr2.clicked_at IS NOT NULL)';
    }
  }

  const emailExpr = 'LOWER(s.email)';
  const usesList = Boolean(campaign.list_id || campaign.segment_id);

  const row = await db.one(
    `SELECT COUNT(DISTINCT s.id) AS c
       FROM subscribers s
       ${usesList ? 'JOIN list_subscribers ls ON ls.subscriber_id = s.id' : ''}
      WHERE s.status = 'subscribed'
        ${where}
        ${joinSegment}
        AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE LOWER(sp.email) = ${emailExpr})`,
    params
  );
  return Number(row && row.c) || 0;
}

/* --------------------------------------------------------------- rate limits */

async function effectiveConfig(campaign) {
  return {
    ratePerMinute: await settings.getInt('campaigns.rate_per_minute', 300),
    concurrency: await settings.getInt('campaigns.concurrency', 5),
    batchSize: campaign.batch_size || (await settings.getInt('campaigns.batch_size', 50)),
    batchInterval: campaign.interval_seconds !== null && campaign.interval_seconds !== undefined
      ? campaign.interval_seconds
      : await settings.getInt('campaigns.batch_interval_seconds', 10),
    maxRecipients: campaign.max_recipients || (await settings.getInt('campaigns.max_recipients_per_campaign', 3000)),
    monthlyLimit: await settings.getInt('delivery.monthly_email_limit', 0),
    dailyLimit: await settings.getInt('delivery.daily_email_limit', 0),
  };
}

/** Emails this portal has recorded as sent in the current calendar month. */
async function sentThisMonth() {
  const row = await db.one(`
    SELECT
      (SELECT COALESCE(SUM(sent_count),0) FROM campaigns WHERE completed_at >= DATE_FORMAT(CURDATE(),'%Y-%m-01') OR started_at >= DATE_FORMAT(CURDATE(),'%Y-%m-01')) AS c
  `);
  const events = await db.one(`
    SELECT COUNT(*) AS c FROM campaign_events
     WHERE type = 'send' AND created_at >= DATE_FORMAT(CURDATE(),'%Y-%m-01')
  `);
  // Prefer the event ledger when available; fall back to campaign counters.
  return Math.max(Number(events.c) || 0, Number(row.c) || 0);
}

/** Emails recorded as sent today (UTC calendar day). */
async function sentToday() {
  const events = await db.one(`
    SELECT COUNT(*) AS c FROM campaign_events
     WHERE type = 'send' AND created_at >= CURDATE()
  `);
  return Number(events.c) || 0;
}

/**
 * Pre-flight check run BEFORE a campaign can be launched.
 * Combines the provider's real rate-limit headers with the admin-configured
 * plan limits. Blocks (never bypasses) when a limit would be exceeded.
 */
async function preflight(campaign) {
  const provider = await getDeliveryProvider(campaign.provider);
  const configured = await provider.isConfigured();
  const cfg = await effectiveConfig(campaign);
  const audience = await resolveAudience(campaign);
  const quota = typeof provider.getQuota === 'function' ? await provider.getQuota() : {};
  const used = await sentThisMonth();
  const usedToday = await sentToday();

  const checks = [];
  const add = (label, ok, detail, blocking = true) => checks.push({ label, ok, detail, blocking });

  add('Delivery service configured', configured,
    configured ? 'Delivery credentials are saved and ready.' : 'No delivery credentials saved yet.');

  add('Recipients found', audience.length > 0,
    audience.length ? `${audience.length} deliverable recipient(s) after removing suppressed addresses.` : 'No eligible recipients for the selected list/segment.');

  const underCap = audience.length <= cfg.maxRecipients;
  add(`Within per-campaign cap (${cfg.maxRecipients})`, underCap,
    underCap ? 'OK.' : `This campaign has ${audience.length} recipients, above the ${cfg.maxRecipients} cap. Raise the cap in Settings or split the campaign.`);

  if (cfg.monthlyLimit > 0) {
    const remaining = Math.max(0, cfg.monthlyLimit - used);
    const ok = audience.length <= remaining;
    add(`Within monthly allowance (${cfg.monthlyLimit})`, ok,
      ok ? `${remaining} of ${cfg.monthlyLimit} remaining this month.` : `Only ${remaining} of ${cfg.monthlyLimit} sends remain this month — not enough for ${audience.length} recipients.`);
  } else {
    add('Monthly allowance', true, 'No monthly limit configured (0 = unlimited/unknown). Set your plan limit in Settings for a hard guarantee.', false);
  }

  if (cfg.dailyLimit > 0) {
    const remainingToday = Math.max(0, cfg.dailyLimit - usedToday);
    const ok = audience.length <= remainingToday;
    add(`Within daily allowance (${cfg.dailyLimit})`, ok,
      ok
        ? `${remainingToday} of ${cfg.dailyLimit} remaining today.`
        : `Only ${remainingToday} of ${cfg.dailyLimit} daily sends remain today — not enough for ${audience.length} recipients. Try again tomorrow or raise the limit in Settings.`);
  } else {
    add('Daily allowance', true, 'No daily limit configured (0 = unlimited). Set your plan limit in Settings.', false);
  }

  if (quota && quota.requestRateLimit && quota.requestRateLimit.limit) {
    add('Provider request rate', true,
      `Provider allows ${quota.requestRateLimit.limit} API requests/min; we throttle to ${cfg.ratePerMinute}/min.`, false);
  }

  const blocked = checks.filter((c) => c.blocking && !c.ok);
  return {
    ok: blocked.length === 0,
    checks,
    audienceCount: audience.length,
    limits: cfg,
    used,
    usedToday,
    totalRecipients: audience.length,
  };
}

/* -------------------------------------------------------------- queue building */

function token() {
  return crypto.randomBytes(20).toString('hex'); // 40 chars
}

/** Extracts unique http(s) links from campaign HTML for click tracking. */
function extractLinks(html) {
  const urls = new Set();
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const url = m[1];
    if (/^https?:\/\//i.test(url)) urls.add(url);
  }
  return [...urls];
}

/** Persists the audience as the per-recipient queue (dedup enforced at DB level). */
async function buildQueue(campaign, audience) {
  const chunks = [];
  const size = 500;
  for (let i = 0; i < audience.length; i += size) chunks.push(audience.slice(i, i + size));

  let inserted = 0;
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '(?,?,?,?,?,?)').join(',');
    const values = [];
    for (const r of chunk) {
      values.push(campaign.id, r.subscriber_id, r.email, 'queued', token(), new Date());
    }
    const res = await db.query(
      `INSERT IGNORE INTO campaign_recipients (campaign_id, subscriber_id, email, status, token, queued_at)
       VALUES ${placeholders}`,
      values
    );
    inserted += res.affectedRows || 0;
  }

  // Register links for click tracking + rewrite (used by per-recipient mode).
  const links = extractLinks(campaign.html || '');
  for (const url of links) {
    await db.query(
      'INSERT IGNORE INTO campaign_links (campaign_id, url, token) VALUES (?, ?, ?)',
      [campaign.id, url, token()]
    );
  }

  await db.query('UPDATE campaigns SET total_recipients = ? WHERE id = ?', [inserted, campaign.id]);
  return inserted;
}

async function linkMap(campaignId) {
  const rows = await db.query('SELECT token, url FROM campaign_links WHERE campaign_id = ?', [campaignId]);
  const map = new Map();
  for (const r of rows) map.set(r.url, r.token);
  return map;
}

/* ------------------------------------------------------- per-recipient content */

function personaliseTokens(recipient, unsubscribeUrl) {
  const custom = recipient.custom_data
    ? (typeof recipient.custom_data === 'string' ? JSON.parse(recipient.custom_data) : recipient.custom_data)
    : {};
  return Object.assign({}, custom, {
    email: recipient.email,
    first_name: recipient.first_name || '',
    last_name: recipient.last_name || '',
    company: recipient.company || '',
    unsubscribe_url: unsubscribeUrl,
  });
}

function buildRecipientHtml(campaign, recipient, links) {
  const unsubscribeUrl = tracking.buildUnsubscribeUrl(recipient.token);
  let html = helpers.personalise(campaign.html || '', personaliseTokens(recipient, unsubscribeUrl));
  // Swap any hardcoded address after `eml=` for this recipient's own address.
  html = helpers.mergeRecipientEmailInLinks(html, recipient.email);

  // Rewrite links → tracking redirect (only for links we registered).
  html = helpers.rewriteLinks(html, (url) => {
    const linkToken = links.get(url);
    return linkToken ? tracking.buildClickUrl(linkToken, recipient.token) : url;
  });

  // Inject the open pixel just before </body> (or append).
  const pixel = `<img src="${tracking.buildPixelUrl(recipient.token)}" width="1" height="1" alt="" style="display:none" />`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;

  const text = helpers.mergeRecipientEmailInLinks(
    helpers.personalise(campaign.text || helpers.stripTags(campaign.html || ''), personaliseTokens(recipient, unsubscribeUrl)),
    recipient.email
  ) + `\n\nUnsubscribe: ${unsubscribeUrl}`;

  return { html, text, unsubscribeUrl };
}

/* ------------------------------------------------------------ per-recipient send */

async function drainSmtpQueue(campaign, { onTick } = {}) {
  const provider = await getDeliveryProvider(campaign.provider);
  if (!(await provider.isConfigured())) throw new ValidationError('Delivery provider is not configured.');

  const cfg = await effectiveConfig(campaign);
  const limiter = new RateLimiter(cfg.ratePerMinute);
  const links = await linkMap(campaign.id);
  const fromName = campaign.from_name || (await settings.get('mailbox.from_name'));
  const fromEmail = campaign.from_email || (await settings.get('mailbox.from_email')) || (await settings.get('mailbox.smtp.user'));

  // Reclaim any stalled 'sending' recipients from an interrupted run
  await db.query(
    "UPDATE campaign_recipients SET status = 'queued' WHERE campaign_id = ? AND status = 'sending' AND sent_at IS NULL",
    [campaign.id]
  );

  for (;;) {
    // Stop cleanly if the campaign was paused/cancelled from the UI.
    const fresh = await db.one('SELECT status FROM campaigns WHERE id = ?', [campaign.id]);
    if (!fresh || fresh.status !== 'sending') return;

    const batch = await db.query(
      "SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued' ORDER BY id ASC LIMIT ?",
      [campaign.id, cfg.batchSize]
    );
    if (!batch.length) break;

    await mapLimit(batch, cfg.concurrency, async (recipient) => {
      await limiter.acquire();
      const marked = await db.query(
        "UPDATE campaign_recipients SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
        [recipient.id]
      );
      if (!marked.affectedRows) return; // another worker took it

      const content = buildRecipientHtml(campaign, recipient, links);
      try {
        const result = await provider.sendMessage({
          to: recipient.email,
          subject: helpers.personalise(campaign.subject, personaliseTokens(recipient, content.unsubscribeUrl)),
          html: content.html,
          text: content.text,
          from: fromEmail ? `${fromName || ''} <${fromEmail}>` : undefined,
          replyTo: campaign.reply_to || fromEmail,
          listUnsubscribe: content.unsubscribeUrl,
        });
        await db.query(
          "UPDATE campaign_recipients SET status = 'sent', sent_at = NOW(), provider_message_id = ?, error = NULL WHERE id = ?",
          [result.providerMessageId || null, recipient.id]
        );
        await db.query('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?', [campaign.id]);
        await db.query(
          "INSERT INTO campaign_events (campaign_id, recipient_id, type) VALUES (?, ?, 'send')",
          [campaign.id, recipient.id]
        );
      } catch (err) {
        const msg = (err.message || 'send failed').slice(0, 480);
        const isBounce = /(5\d\d|user unknown|no such|does not exist|invalid recipient|mailbox unavailable)/i.test(msg);
        await db.query(
          `UPDATE campaign_recipients SET status = ?, error = ?, bounced_at = ${isBounce ? 'NOW()' : 'NULL'} WHERE id = ?`,
          [isBounce ? 'bounced' : 'failed', msg, recipient.id]
        );
        await db.query(
          isBounce
            ? 'UPDATE campaigns SET bounce_count = bounce_count + 1, failed_count = failed_count + 1 WHERE id = ?'
            : 'UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?',
          [campaign.id]
        );
        await db.query(
          "INSERT INTO campaign_events (campaign_id, recipient_id, type, meta) VALUES (?, ?, ?, ?)",
          [campaign.id, recipient.id, isBounce ? 'bounce' : 'error', JSON.stringify({ message: msg })]
        );
        if (isBounce) {
          await db.query(
            `INSERT INTO suppressions (email, reason, detail) VALUES (?, 'bounce', ?) ON DUPLICATE KEY UPDATE reason = reason`,
            [recipient.email, msg.slice(0, 200)]
          );
          await db.query("UPDATE subscribers SET status = 'bounced' WHERE LOWER(email) = ?", [recipient.email.toLowerCase()]);
        }
      }
    });

    if (onTick) await onTick(campaign.id);

    // Pause between batches (requirement: configurable interval).
    if (cfg.batchInterval > 0) await sleep(cfg.batchInterval * 1000);

    const remaining = await db.one(
      "SELECT COUNT(*) AS c FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued'",
      [campaign.id]
    );
    if (!remaining.c) break;
  }
}

/** Finalises an SMTP campaign once its queue is drained. */
async function finaliseSmtp(campaign) {
  const stats = await db.one(
    `SELECT
       SUM(status IN ('sent','delivered','opened','clicked')) AS sent,
       SUM(status IN ('delivered','opened','clicked')) AS delivered,
       SUM(status IN ('failed','bounced')) AS failed,
       SUM(status = 'bounced') AS bounced
     FROM campaign_recipients WHERE campaign_id = ?`,
    [campaign.id]
  );
  await db.query(
    `UPDATE campaigns SET status = 'sent', completed_at = NOW(),
        sent_count = ?, bounce_count = ? WHERE id = ?`,
    [Number(stats.sent) || 0, Number(stats.bounced) || 0, campaign.id]
  );
}

/* ----------------------------------------------------------------- bulk mode */

async function bulkSyncAudience(campaign) {
  const provider = await getDeliveryProvider(campaign.provider);
  const cfg = await effectiveConfig(campaign);
  const limiter = new RateLimiter(cfg.ratePerMinute);

  // Ensure a provider group exists for this campaign's list.
  let groupId = campaign.provider_group_id;
  if (!groupId) {
    const list = campaign.list_id ? await db.one('SELECT * FROM lists WHERE id = ?', [campaign.list_id]) : null;
    if (list && list.provider_id) {
      groupId = list.provider_id;
    } else {
      const created = await provider.createGroup(list ? list.name : `Campaign #${campaign.id} audience`);
      groupId = created && created.id;
      if (list && groupId) {
        await db.query("UPDATE lists SET provider_id = ?, sync_state = 'synced' WHERE id = ?", [groupId, list.id]);
      }
    }
    await db.query('UPDATE campaigns SET provider_group_id = ? WHERE id = ?', [groupId, campaign.id]);
  }

  // Add each audience member to the provider group (rate-limited, background).
  for (;;) {
    const fresh = await db.one('SELECT status FROM campaigns WHERE id = ?', [campaign.id]);
    if (!fresh || fresh.status !== 'syncing') return groupId;

    const batch = await db.query(
      `SELECT cr.*, s.first_name, s.last_name, s.company
         FROM campaign_recipients cr
         LEFT JOIN subscribers s ON s.id = cr.subscriber_id
        WHERE cr.campaign_id = ? AND cr.sync_state = 'pending'
        ORDER BY cr.id ASC LIMIT ?`,
      [campaign.id, cfg.batchSize]
    );
    if (!batch.length) break;

    await mapLimit(batch, cfg.concurrency, async (r) => {
      await limiter.acquire();
      try {
        await provider.upsertSubscriber({
          email: r.email,
          first_name: r.first_name,
          last_name: r.last_name,
          groups: [groupId],
        });
        await db.query("UPDATE campaign_recipients SET sync_state = 'synced' WHERE id = ?", [r.id]);
      } catch (err) {
        const msg = (err.message || 'sync failed').slice(0, 480);
        await db.query("UPDATE campaign_recipients SET sync_state = 'failed', error = ? WHERE id = ?", [msg, r.id]);
      }
    });

    if (cfg.batchInterval > 0) await sleep(cfg.batchInterval * 1000);
  }
  return groupId;
}

async function bulkSend(campaign) {
  const provider = await getDeliveryProvider(campaign.provider);
  if (!(await provider.isConfigured())) throw new ValidationError('Delivery provider is not configured.');

  // 1) Sync audience into the provider group.
  await db.query("UPDATE campaigns SET status = 'syncing' WHERE id = ?", [campaign.id]);
  const groupId = await bulkSyncAudience(campaign);

  const fresh = await db.one('SELECT * FROM campaigns WHERE id = ?', [campaign.id]);
  if (!fresh || fresh.status !== 'syncing') return;

  // 2) Create + trigger the campaign at the provider.
  const fromEmail = campaign.from_email || (await settings.get('mailbox.from_email')) || (await settings.get('delivery.smtp.from')) || 'hello@oak-viewconstruction.com';
  const fromName = campaign.from_name || (await settings.get('mailbox.from_name')) || 'OakView Construction';
  const created = await provider.createCampaign({
    title: campaign.name,
    subject: campaign.subject,
    from: fromEmail,
    fromEmail: fromEmail,
    fromName: fromName,
    reply_to: campaign.reply_to || fromEmail,
    preheader: campaign.preheader,
    contentType: 'html',
    content: campaign.html || '',
    groups: groupId ? [groupId] : [],
  });

  await db.query('UPDATE campaigns SET provider_campaign_id = ?, status = ? WHERE id = ?', [created.id, 'sending', campaign.id]);
  await provider.sendCampaign(created.id);

  // Provider accepted the send — record that fact (not per-recipient delivery).
  await db.query(
    "UPDATE campaign_recipients SET status = 'sent', sent_at = NOW() WHERE campaign_id = ? AND status = 'queued'",
    [campaign.id]
  );
  await db.query(
    "INSERT INTO campaign_events (campaign_id, type, meta) VALUES (?, 'send', ?)",
    [campaign.id, JSON.stringify({ provider: provider.name, provider_campaign_id: created.id })]
  );
}

/** Pulls real aggregate stats from the provider for a bulk campaign. */
async function syncBulkStats(campaign) {
  const provider = await getDeliveryProvider(campaign.provider);
  if (!campaign.provider_campaign_id) return null;
  const stats = await provider.getCampaignStats(campaign.provider_campaign_id);

  const terminal = ['SENT', 'sent', 'COMPLETED', 'completed', 'FINISHED'];
  const isDone = terminal.includes(String(stats.status || ''));

  await db.query(
    `UPDATE campaigns SET
        sent_count = ?, delivered_count = ?, open_count = ?, click_count = ?, bounce_count = ?,
        status = CASE WHEN ? THEN 'sent' ELSE status END,
        completed_at = CASE WHEN ? THEN NOW() ELSE completed_at END
      WHERE id = ?`,
    [
      stats.sent || 0,
      Math.max(0, (stats.sent || 0) - (stats.bounces || 0)),
      stats.opens || 0,
      stats.clicks || 0,
      stats.bounces || 0,
      isDone ? 1 : 0,
      isDone ? 1 : 0,
      campaign.id,
    ]
  );
  return stats;
}

/* ------------------------------------------------------------------- lifecycle */

/** Validates, queues and starts a campaign. Throws on any blocking check. */
async function startCampaign(campaignId) {
  const campaign = await db.one('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  if (!campaign) throw new ValidationError('Campaign not found.');

  const check = await preflight(campaign);
  if (!check.ok) {
    throw new ValidationError(`Cannot launch: ${check.checks.filter((c) => c.blocking && !c.ok).map((c) => c.label).join('; ')}`);
  }

  const audience = await resolveAudience(campaign);
  const inserted = await buildQueue(campaign, audience);

  // Mark all recipients as needing provider sync when the provider sends in bulk.
  const provider = await getDeliveryProvider(campaign.provider);
  if (provider.supportsBulkCampaigns) {
    await db.query("UPDATE campaign_recipients SET sync_state = 'pending' WHERE campaign_id = ?", [campaign.id]);
  }

  await db.query(
    "UPDATE campaigns SET status = 'queued', started_at = COALESCE(started_at, NOW()), last_error = NULL, total_recipients = ? WHERE id = ?",
    [inserted, campaign.id]
  );

  return { queued: inserted, mode: provider.supportsBulkCampaigns ? 'bulk' : 'per-recipient' };
}

/** Called by the worker for every campaign in the 'queued'/'syncing' state. */
async function processCampaign(campaign) {
  try {
    const provider = await getDeliveryProvider(campaign.provider);
    if (provider.supportsBulkCampaigns) {
      await bulkSend(campaign);
    } else {
      const fresh = await db.one('SELECT * FROM campaigns WHERE id = ?', [campaign.id]);
      if (fresh.status === 'queued') {
        await db.query("UPDATE campaigns SET status = 'sending' WHERE id = ?", [campaign.id]);
      }
      await drainSmtpQueue(campaign);
      const done = await db.one('SELECT status FROM campaigns WHERE id = ?', [campaign.id]);
      if (done && done.status === 'sending') await finaliseSmtp(campaign);
    }
  } catch (err) {
    await db.query("UPDATE campaigns SET status = 'failed', last_error = ? WHERE id = ?", [
      (err.message || 'send failed').slice(0, 480),
      campaign.id,
    ]);
    await db.query(
      "INSERT INTO campaign_events (campaign_id, type, meta) VALUES (?, 'error', ?)",
      [campaign.id, JSON.stringify({ message: err.message })]
    );
    throw err;
  }
}

module.exports = {
  resolveAudience,
  countAudience,
  preflight,
  startCampaign,
  processCampaign,
  syncBulkStats,
  finaliseSmtp,
  effectiveConfig,
  sentThisMonth,
  extractLinks,
};
