'use strict';

const express = require('express');
const env = require('../../config/env');
const settings = require('../../config/settings');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { getDeliveryProvider, activeName, label, listProviders } = require('../../providers/delivery');
const { getMailboxProvider } = require('../../providers/mailbox');

/**
 * Settings → Integrations.
 *
 * The page is driven entirely by settings.REGISTRY. Delivery (bulk campaigns)
 * and the mailbox (inbox / individual sending) are deliberately separate
 * integrations and are presented in two distinct panels.
 */

const router = express.Router();

// Which registry groups belong to each top-level panel.
const DELIVERY_GROUPS = ['delivery', 'sender', 'smtp_delivery'];
const MAILBOX_GROUPS = ['mailbox', 'imap', 'mailbox_smtp', 'mailbox_identity'];

const GROUP_TITLES = {
  delivery: 'Delivery provider',
  sender: 'Sender.net',
  smtp_delivery: 'SMTP delivery relay',
  mailbox: 'Mailbox provider',
  imap: 'Incoming mail (IMAP)',
  mailbox_smtp: 'Outgoing mail (SMTP)',
  mailbox_identity: 'Sender identity',
};

const GROUP_HINTS = {
  imap: 'Where incoming mail is read from.',
  mailbox_smtp: 'Where outgoing mail is sent from. This can be a different server from the IMAP above — e.g. read via your domain’s IMAP and send via Gmail SMTP (smtp.gmail.com, port 465, with a Google App Password).',
  mailbox_identity: 'Shown as the sender name and From address on messages you send.',
};

const TRUTHY = ['1', 'true', 'yes', 'on'];

function isTruthy(value) {
  return TRUTHY.includes(String(value || '').toLowerCase());
}

/**
 * Builds the render model straight from REGISTRY + the settings service.
 * Secret values are intentionally NOT copied into the model.
 */
async function buildPanels() {
  const [values, configured, sources] = await Promise.all([
    settings.all(),
    settings.configuredMap(),
    settings.sourceMap(),
  ]);

  const byGroup = {};
  for (const key of Object.keys(settings.REGISTRY)) {
    const spec = settings.REGISTRY[key];
    if (!byGroup[spec.group]) byGroup[spec.group] = [];
    const isConfigured = Boolean(configured[key]);
    const source = sources[key];
    byGroup[spec.group].push({
      key,
      label: spec.label,
      type: spec.type || 'text',
      secret: Boolean(spec.secret),
      options: spec.options || null,
      env: settings.envKey(spec),
      // Never expose a stored secret; non-secret effective values are shown.
      value: spec.secret ? '' : (values[key] || ''),
      checked: spec.type === 'bool' ? isTruthy(values[key]) : false,
      configured: isConfigured,
      source,
      // A value supplied by the environment and not overridden in the DB is read-only.
      disabled: source === 'environment' && isConfigured,
    });
  }

  const groups = (keys) => keys.map((g) => ({ key: g, title: GROUP_TITLES[g], hint: GROUP_HINTS[g] || '', fields: byGroup[g] || [] }));

  return [
    {
      key: 'delivery',
      heading: 'Campaign delivery (bulk sending)',
      note: 'Used by the campaign queue to send bulk marketing email. This is a separate integration from the mailbox below.',
      groups: groups(DELIVERY_GROUPS),
    },
    {
      key: 'mailbox',
      heading: 'Mailbox (inbox & individual sending)',
      note: 'Used by the Inbox to read, reply to and send individual mail. It is intentionally kept separate from campaign delivery.',
      groups: groups(MAILBOX_GROUPS),
    },
  ];
}

/* ------------------------------------------------------------ render page */

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [panels, deliveryProviders, deliveryActive] = await Promise.all([
      buildPanels(),
      listProviders(),
      activeName(),
    ]);

    const delivery = await getDeliveryProvider();
    const mailbox = await getMailboxProvider();

    res.render('settings/index', {
      title: 'Integrations',
      active: 'settings',
      panels,
      deliveryProviders,
      providerStatus: {
        delivery: { active: label(deliveryActive), configured: await delivery.isConfigured() },
        mailbox: { active: mailbox.name, configured: await mailbox.isConfigured() },
      },
      routingNote: env.mailbox.routingNote || process.env.CLOUDFLARE_ROUTING_NOTE || '',
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------ save values */

router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const [configured, sources] = await Promise.all([
      settings.configuredMap(),
      settings.sourceMap(),
    ]);

    for (const key of Object.keys(settings.REGISTRY)) {
      const spec = settings.REGISTRY[key];

      // Environment-managed values are read-only: never overwrite them here.
      const readOnly = sources[key] === 'environment' && Boolean(configured[key]);
      if (readOnly) continue;

      if (spec.type === 'bool') {
        // Checkbox absent means off; only editable bools reach this point.
        await settings.set(key, req.body[key] ? 'true' : 'false');
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(req.body, key)) continue;
      const value = String(req.body[key] == null ? '' : req.body[key]).trim();

      if (spec.secret) {
        if (value !== '') {
          await settings.set(key, value);
        } else if (req.body[`clear_${key}`]) {
          // Explicit opt-in required to erase a stored secret.
          await settings.set(key, '');
        }
        continue;
      }

      // Non-secret fields are only persisted when a value is actually supplied.
      if (value !== '') await settings.set(key, value);
    }

    settings.clearCache();
    req.flash('success', 'Integration settings saved.');
    return res.redirect('/settings');
  } catch (err) {
    return next(err);
  }
});

/* -------------------------------------------------------- connection test */

router.post('/test/:kind', requireAuth, requireRole('admin'), async (req, res, next) => {
  const kind = req.params.kind;
  try {
    let result;
    if (kind === 'delivery') {
      result = await getDeliveryProvider().verify();
    } else if (kind === 'mailbox') {
      result = await getMailboxProvider().verify();
    } else {
      req.flash('error', 'Unknown connection type.');
      return res.redirect('/settings');
    }

    // Only ever report success when the provider actually confirmed it.
    if (result && result.ok === true) {
      req.flash('success', result.message || 'Connection verified.');
    } else {
      req.flash('error', (result && result.message) || 'Connection failed.');
    }
    return res.redirect('/settings');
  } catch (err) {
    req.flash('error', err.message || 'Connection failed.');
    return res.redirect('/settings');
  }
});

module.exports = router;
