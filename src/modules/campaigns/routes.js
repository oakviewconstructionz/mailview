'use strict';

const express = require('express');

const db = require('../../config/db');
const settings = require('../../config/settings');
const helpers = require('../../lib/helpers');
const { logActivity } = require('../../lib/activity');
const { requireAuth, requireCapability } = require('../../middleware/auth');
const campaignSender = require('../../services/campaignSender');
const { getDeliveryProvider } = require('../../providers/delivery');

const router = express.Router();

// Everything in this module requires a signed-in user.
router.use(requireAuth);

// Sample data used to preview a campaign without sending anything.
const SAMPLE_DATA = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  company: 'OakView Labs',
  unsubscribe_url: 'https://example.com/unsubscribe?u=sample',
};

// Statuses that still allow editing the campaign content/audience.
const EDITABLE = ['draft', 'scheduled', 'paused', 'cancelled', 'failed'];
// Statuses where the campaign is done or in flight (no content edits).
const LOCKED = ['queued', 'syncing', 'sending', 'sent'];

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function intOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function idOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function str(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function notFound() {
  const err = new Error('That campaign no longer exists.');
  err.status = 404;
  return err;
}

async function loadCampaign(id) {
  return db.one('SELECT * FROM campaigns WHERE id = ?', [id]);
}

/* --------------------------------------------------------------- list ---- */

router.get('/', async (req, res, next) => {
  try {
    const status = str(req.query.status, 20);
    const where = status && LOCKED.concat(EDITABLE).includes(status) ? 'WHERE status = ?' : '';
    const params = where ? [status] : [];

    const campaigns = await db.query(
      `SELECT id, name, subject, status, total_recipients, sent_count, delivered_count, failed_count,
              open_count, click_count, bounce_count, unsubscribe_count,
              scheduled_at, started_at, completed_at, created_at
         FROM campaigns
         ${where}
        ORDER BY created_at DESC
        LIMIT 200`,
      params
    );

    const counts = await db.query('SELECT status, COUNT(*) AS c FROM campaigns GROUP BY status');
    const byStatus = {};
    let total = 0;
    for (const row of counts) {
      byStatus[row.status] = Number(row.c) || 0;
      total += Number(row.c) || 0;
    }

    res.render('campaigns/index', {
      title: 'Campaigns',
      active: 'campaigns',
      campaigns,
      byStatus,
      total,
      filter: status,
      maxRecipients: await settings.getInt('campaigns.max_recipients_per_campaign', 3000),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------- audience estimate */

router.get('/audience-estimate', async (req, res, next) => {
  try {
    const campaign = {
      list_id: idOrNull(req.query.list_id),
      segment_id: idOrNull(req.query.segment_id),
    };
    const count = await campaignSender.countAudience(campaign);
    const cap = await settings.getInt('campaigns.max_recipients_per_campaign', 3000);
    res.json({ count, cap, withinCap: count <= cap });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------- template content (form helper) */

router.get('/template/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Not found' });
  try {
    const t = await db.one('SELECT id, name, subject, preheader, html, text FROM templates WHERE id = ?', [id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json(t);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ new / edit -- */

async function formData(campaign) {
  const [lists, segments, templates, defaults] = await Promise.all([
    db.query(
      `SELECT l.id, l.name,
              (SELECT COUNT(*) FROM list_subscribers ls
                 JOIN subscribers s ON s.id = ls.subscriber_id
                WHERE ls.list_id = l.id AND s.status = 'subscribed') AS subscriber_count
         FROM lists l ORDER BY l.name ASC`
    ),
    db.query('SELECT id, name, description, rules FROM segments ORDER BY name ASC'),
    db.query('SELECT id, name, subject FROM templates ORDER BY updated_at DESC'),
    (async () => ({
      batchSize: await settings.getInt('campaigns.batch_size', 50),
      intervalSeconds: await settings.getInt('campaigns.batch_interval_seconds', 10),
      maxRecipients: await settings.getInt('campaigns.max_recipients_per_campaign', 3000),
      ratePerMinute: await settings.getInt('campaigns.rate_per_minute', 300),
      concurrency: await settings.getInt('campaigns.concurrency', 5),
    }))(),
  ]);
  return { campaign, lists, segments, templates, defaults };
}

router.get('/new', async (req, res, next) => {
  try {
    const data = await formData(null);
    res.render('campaigns/form', Object.assign({ title: 'New campaign', active: 'campaigns', isNew: true }, data));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next(notFound());
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) return next(notFound());
    if (LOCKED.includes(campaign.status)) {
      req.flash('error', 'This campaign is in flight and can no longer be edited.');
      return res.redirect(`/campaigns/${id}`);
    }
    const data = await formData(campaign);
    res.render('campaigns/form', Object.assign({ title: campaign.name, active: 'campaigns', isNew: false }, data));
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- create --- */

function readFields(body) {
  return {
    name: str(body.name, 190),
    subject: str(body.subject, 255),
    preheader: str(body.preheader, 255) || null,
    from_name: str(body.from_name, 190) || null,
    from_email: str(body.from_email, 190) || null,
    reply_to: str(body.reply_to, 190) || null,
    template_id: idOrNull(body.template_id),
    list_id: idOrNull(body.list_id),
    segment_id: idOrNull(body.segment_id),
    html: String(body.html || ''),
    text: String(body.text || ''),
    batch_size: intOrNull(body.batch_size),
    interval_seconds: intOrNull(body.interval_seconds),
    max_recipients: intOrNull(body.max_recipients),
  };
}

router.post('/', requireCapability('edit'), async (req, res, next) => {
  const f = readFields(req.body);
  if (!f.name || !f.subject) {
    req.flash('error', 'A campaign name and subject are required.');
    return res.redirect('/campaigns/new');
  }
  try {
    // If a template was chosen and no body was typed, snapshot the template.
    if (f.template_id && !f.html) {
      const t = await db.one('SELECT subject, preheader, html, text FROM templates WHERE id = ?', [f.template_id]);
      if (t) {
        f.html = t.html || '';
        f.text = t.text || '';
        if (!f.subject) f.subject = t.subject || '';
        if (!f.preheader) f.preheader = t.preheader || null;
      }
    }

    const provider = await getDeliveryProvider();
    const result = await db.query(
      `INSERT INTO campaigns
         (name, subject, preheader, from_name, from_email, reply_to, template_id, html, text,
          list_id, segment_id, provider, status, batch_size, interval_seconds, max_recipients, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)`,
      [
        f.name, f.subject, f.preheader, f.from_name, f.from_email, f.reply_to, f.template_id, f.html, f.text,
        f.list_id, f.segment_id, provider.name, f.batch_size, f.interval_seconds, f.max_recipients, req.user.id,
      ]
    );
    await logActivity(req.user.id, 'campaign.create', { id: result.insertId }, req.ip);
    req.flash('success', `Campaign “${f.name}” saved as a draft.`);
    res.redirect(`/campaigns/${result.insertId}`);
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- update --- */

router.post('/:id', requireCapability('edit'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    req.flash('error', 'That campaign no longer exists.');
    return res.redirect('/campaigns');
  }
  const f = readFields(req.body);
  if (!f.name || !f.subject) {
    req.flash('error', 'A campaign name and subject are required.');
    return res.redirect(`/campaigns/${id}/edit`);
  }
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) {
      req.flash('error', 'That campaign no longer exists.');
      return res.redirect('/campaigns');
    }
    if (LOCKED.includes(campaign.status)) {
      req.flash('error', 'This campaign is in flight and can no longer be edited.');
      return res.redirect(`/campaigns/${id}`);
    }
    await db.query(
      `UPDATE campaigns SET
         name = ?, subject = ?, preheader = ?, from_name = ?, from_email = ?, reply_to = ?,
         template_id = ?, html = ?, text = ?, list_id = ?, segment_id = ?,
         batch_size = ?, interval_seconds = ?, max_recipients = ?
       WHERE id = ?`,
      [
        f.name, f.subject, f.preheader, f.from_name, f.from_email, f.reply_to,
        f.template_id, f.html, f.text, f.list_id, f.segment_id,
        f.batch_size, f.interval_seconds, f.max_recipients, id,
      ]
    );
    await logActivity(req.user.id, 'campaign.update', { id }, req.ip);
    req.flash('success', 'Campaign saved.');
    res.redirect(`/campaigns/${id}`);
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- delete --- */

router.post('/:id/delete', requireCapability('edit'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    req.flash('error', 'That campaign no longer exists.');
    return res.redirect('/campaigns');
  }
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) {
      req.flash('error', 'That campaign no longer exists.');
      return res.redirect('/campaigns');
    }
    if (['queued', 'syncing', 'sending'].includes(campaign.status)) {
      req.flash('error', 'Stop the campaign before deleting it.');
      return res.redirect(`/campaigns/${id}`);
    }
    await db.query('DELETE FROM campaigns WHERE id = ?', [id]);
    await logActivity(req.user.id, 'campaign.delete', { id }, req.ip);
    req.flash('success', `Campaign “${campaign.name}” deleted.`);
    res.redirect('/campaigns');
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- preview --- */

router.get('/:id/preview', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next(notFound());
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) return next(notFound());
    res.render('campaigns/preview', {
      title: `${campaign.name} · Preview`,
      campaign,
      subject: helpers.personalise(campaign.subject || '', SAMPLE_DATA),
      preheader: helpers.personalise(campaign.preheader || '', SAMPLE_DATA),
      html: helpers.personalise(campaign.html || campaign.text || '', SAMPLE_DATA),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------- test send ---- */

router.post('/:id/test', requireCapability('send'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const to = str(req.body.to, 190);
  if (!id) {
    req.flash('error', 'That campaign no longer exists.');
    return res.redirect('/campaigns');
  }
  if (!helpers.isValidEmail(to)) {
    req.flash('error', 'Enter a valid email address for the test.');
    return res.redirect(`/campaigns/${id}`);
  }
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) {
      req.flash('error', 'That campaign no longer exists.');
      return res.redirect('/campaigns');
    }
    const provider = await getDeliveryProvider(campaign.provider);
    if (!(await provider.isConfigured())) {
      req.flash('error', 'The delivery service is not configured yet — add credentials in Settings.');
      return res.redirect(`/campaigns/${id}`);
    }
    const fromName = campaign.from_name || (await settings.get('mailbox.from_name')) || 'OakView Construction';
    const fromEmail = campaign.from_email || (await settings.get('mailbox.from_email')) || (await settings.get('delivery.smtp.from')) || (await settings.get('mailbox.smtp.user')) || 'hello@oak-viewconstruction.com';
    await provider.sendMessage({
      to,
      subject: `[Test] ${helpers.personalise(campaign.subject || '', SAMPLE_DATA)}`,
      html: helpers.personalise(campaign.html || '', SAMPLE_DATA),
      text: helpers.personalise(campaign.text || helpers.stripTags(campaign.html || ''), SAMPLE_DATA),
      from: `${fromName || ''} <${fromEmail}>`.trim(),
      fromName,
      fromEmail,
      replyTo: campaign.reply_to || fromEmail,
    });
    await logActivity(req.user.id, 'campaign.test', { id, to }, req.ip);
    req.flash('success', `Test email accepted by the delivery service for ${to}.`);
    res.redirect(`/campaigns/${id}`);
  } catch (err) {
    req.flash('error', `Test send failed: ${err.message}`);
    res.redirect(`/campaigns/${id}`);
  }
});

/* ------------------------------------------------------------- schedule --- */

router.post('/:id/schedule', requireCapability('send'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    req.flash('error', 'That campaign no longer exists.');
    return res.redirect('/campaigns');
  }
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) {
      req.flash('error', 'That campaign no longer exists.');
      return res.redirect('/campaigns');
    }
    if (!['draft', 'scheduled', 'paused', 'cancelled', 'failed'].includes(campaign.status)) {
      req.flash('error', 'This campaign can no longer be scheduled.');
      return res.redirect(`/campaigns/${id}`);
    }

    const raw = str(req.body.scheduled_at, 40);
    if (!raw) {
      await db.query("UPDATE campaigns SET scheduled_at = NULL, status = 'draft' WHERE id = ?", [id]);
      req.flash('info', 'Schedule cleared.');
      return res.redirect(`/campaigns/${id}`);
    }

    const when = new Date(raw);
    if (isNaN(when) || when.getTime() <= Date.now()) {
      req.flash('error', 'Pick a date and time in the future.');
      return res.redirect(`/campaigns/${id}`);
    }

    const check = await campaignSender.preflight(campaign);
    if (!check.ok) {
      req.flash('error', `Cannot schedule: ${check.checks.filter((c) => c.blocking && !c.ok).map((c) => c.label).join('; ')}`);
      return res.redirect(`/campaigns/${id}`);
    }

    await db.query(
      "UPDATE campaigns SET scheduled_at = ?, status = 'scheduled', total_recipients = ? WHERE id = ?",
      [when, check.audienceCount, id]
    );
    await logActivity(req.user.id, 'campaign.schedule', { id, at: when.toISOString() }, req.ip);
    req.flash('success', `Campaign scheduled for ${helpers.formatDateTime(when)}.`);
    res.redirect(`/campaigns/${id}`);
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- launch --- */

router.post('/:id/launch', requireCapability('send'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    req.flash('error', 'That campaign no longer exists.');
    return res.redirect('/campaigns');
  }
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) {
      req.flash('error', 'That campaign no longer exists.');
      return res.redirect('/campaigns');
    }
    if (['queued', 'syncing', 'sending', 'sent'].includes(campaign.status)) {
      req.flash('error', 'This campaign has already been launched.');
      return res.redirect(`/campaigns/${id}`);
    }
    const result = await campaignSender.startCampaign(id);
    await logActivity(req.user.id, 'campaign.launch', { id, queued: result.queued, mode: result.mode }, req.ip);
    req.flash(
      'success',
      `Campaign queued for ${helpers.formatNumber(result.queued)} recipient(s). Sending runs in the background — watch the progress below.`
    );
    res.redirect(`/campaigns/${id}`);
  } catch (err) {
    req.flash('error', err.message || 'The campaign could not be launched.');
    res.redirect(`/campaigns/${id}`);
  }
});

/* ------------------------------------------------------ pause / resume / cancel */

router.post('/:id/pause', requireCapability('send'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.redirect('/campaigns');
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) {
      req.flash('error', 'That campaign no longer exists.');
      return res.redirect('/campaigns');
    }
    if (!['queued', 'sending', 'syncing'].includes(campaign.status)) {
      req.flash('error', 'Only a running campaign can be paused.');
      return res.redirect(`/campaigns/${id}`);
    }
    const provider = await getDeliveryProvider(campaign.provider);
    if (provider.supportsBulkCampaigns) {
      req.flash('info', 'This send is executed by the delivery service and cannot be paused once it has started.');
      return res.redirect(`/campaigns/${id}`);
    }
    await db.query("UPDATE campaigns SET status = 'paused' WHERE id = ?", [id]);
    await logActivity(req.user.id, 'campaign.pause', { id }, req.ip);
    req.flash('info', 'Campaign paused. Queued recipients will not be sent until you resume.');
    res.redirect(`/campaigns/${id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resume', requireCapability('send'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.redirect('/campaigns');
  try {
    const campaign = await loadCampaign(id);
    if (!campaign || campaign.status !== 'paused') {
      req.flash('error', 'That campaign is not paused.');
      return res.redirect(campaign ? `/campaigns/${id}` : '/campaigns');
    }
    await db.query("UPDATE campaigns SET status = 'sending' WHERE id = ?", [id]);
    await logActivity(req.user.id, 'campaign.resume', { id }, req.ip);
    req.flash('success', 'Campaign resumed.');
    res.redirect(`/campaigns/${id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', requireCapability('send'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.redirect('/campaigns');
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) {
      req.flash('error', 'That campaign no longer exists.');
      return res.redirect('/campaigns');
    }
    if (['sent', 'cancelled'].includes(campaign.status)) {
      req.flash('error', 'This campaign is already finished.');
      return res.redirect(`/campaigns/${id}`);
    }
    const provider = await getDeliveryProvider(campaign.provider);
    if (['sending', 'queued', 'syncing'].includes(campaign.status)) {
      // Stop our own queue; a bulk provider send may still complete server-side.
      await db.query("UPDATE campaign_recipients SET status = 'failed', error = 'campaign cancelled' WHERE campaign_id = ? AND status IN ('queued','sending')", [id]);
    }
    await db.query("UPDATE campaigns SET status = 'cancelled', completed_at = NOW() WHERE id = ?", [id]);
    await logActivity(req.user.id, 'campaign.cancel', { id }, req.ip);
    req.flash(
      'info',
      provider.supportsBulkCampaigns
        ? 'Campaign marked cancelled. Note: a send already accepted by the delivery service may still finish on their side.'
        : 'Campaign cancelled.'
    );
    res.redirect(`/campaigns/${id}`);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- progress -- */

router.get('/:id/progress', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Not found' });
  try {
    const campaign = await db.one(
      `SELECT status, total_recipients, sent_count, delivered_count, failed_count, open_count, click_count,
              bounce_count, unsubscribe_count, last_error, scheduled_at, started_at, completed_at
         FROM campaigns WHERE id = ?`,
      [id]
    );
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    const rows = await db.query(
      'SELECT status, COUNT(*) AS c FROM campaign_recipients WHERE campaign_id = ? GROUP BY status',
      [id]
    );
    const recipients = {};
    for (const r of rows) recipients[r.status] = Number(r.c) || 0;

    res.json({ campaign, recipients });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------------------------------------------- show --- */

router.get('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next(notFound());
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) return next(notFound());

    const preLaunch = ['draft', 'scheduled', 'paused', 'failed'].includes(campaign.status);
    let preflight = null;
    if (preLaunch) {
      try {
        preflight = await campaignSender.preflight(campaign);
      } catch (err) {
        preflight = { ok: false, checks: [{ label: 'Pre-flight check', ok: false, detail: err.message, blocking: true }], audienceCount: 0, limits: null, used: 0 };
      }
    }

    const statusRows = await db.query(
      'SELECT status, COUNT(*) AS c FROM campaign_recipients WHERE campaign_id = ? GROUP BY status',
      [id]
    );
    const recipientStatus = {};
    for (const r of statusRows) recipientStatus[r.status] = Number(r.c) || 0;

    const events = await db.query(
      `SELECT e.type, e.url, e.meta, e.created_at, cr.email
         FROM campaign_events e
         LEFT JOIN campaign_recipients cr ON cr.id = e.recipient_id
        WHERE e.campaign_id = ?
        ORDER BY e.id DESC LIMIT 25`,
      [id]
    );

    const perPage = 50;
    const page = parseInt(req.query.page, 10) || 1;
    const totalRow = await db.one('SELECT COUNT(*) AS c FROM campaign_recipients WHERE campaign_id = ?', [id]);
    const total = Number(totalRow.c) || 0;
    const pg = helpers.paginate(total, page, perPage);
    const recipients = await db.query(
      `SELECT email, status, attempts, error, sent_at, opened_at, clicked_at, bounced_at
         FROM campaign_recipients WHERE campaign_id = ?
        ORDER BY id ASC LIMIT ? OFFSET ?`,
      [id, perPage, pg.offset]
    );

    const settingsSnapshot = {
      batchSize: campaign.batch_size || (await settings.getInt('campaigns.batch_size', 50)),
      intervalSeconds: campaign.interval_seconds !== null && campaign.interval_seconds !== undefined
        ? campaign.interval_seconds
        : await settings.getInt('campaigns.batch_interval_seconds', 10),
      maxRecipients: campaign.max_recipients || (await settings.getInt('campaigns.max_recipients_per_campaign', 3000)),
      ratePerMinute: await settings.getInt('campaigns.rate_per_minute', 300),
      concurrency: await settings.getInt('campaigns.concurrency', 5),
    };

    res.render('campaigns/show', {
      title: campaign.name,
      active: 'campaigns',
      campaign,
      preflight,
      preLaunch,
      recipientStatus,
      events,
      recipients,
      pagination: pg,
      settingsSnapshot,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
