'use strict';

const express = require('express');
const metrics = require('../../services/metrics');
const { requireAuth } = require('../../middleware/auth');
const { getDeliveryProvider, label } = require('../../providers/delivery');
const { getMailboxProvider } = require('../../providers/mailbox');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [subs, totals, campaignCount, recent, volume, statusRows, suppressed] = await Promise.all([
      metrics.subscriberStats(),
      metrics.campaignTotals(),
      metrics.allCampaignCount(),
      metrics.recentCampaigns(5),
      metrics.sendVolume(14),
      metrics.campaignsByStatus(),
      metrics.suppressionCount(),
    ]);

    const delivery = await getDeliveryProvider();
    const mailbox = await getMailboxProvider();
    const integrations = {
      delivery: { name: label(delivery.name), configured: await delivery.isConfigured() },
      mailbox: { name: mailbox.name, configured: await mailbox.isConfigured() },
    };

    res.render('dashboard/index', {
      title: 'Overview',
      active: 'overview',
      subs,
      totals,
      campaignCount,
      recent,
      volume,
      statusRows,
      suppressed,
      integrations,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
