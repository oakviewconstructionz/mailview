'use strict';

/**
 * Delivery provider contract.
 *
 * A "delivery provider" is responsible for bulk/marketing sending (campaigns).
 * It is deliberately separate from the mailbox provider, so either can be
 * swapped without touching the rest of the application.
 *
 * Implementations must never report success unless the provider confirmed it.
 *
 * @typedef {Object} DeliveryProvider
 * @property {string} name
 * @property {boolean} supportsBulkCampaigns  true = provider runs the bulk send
 *                                            (create+send a campaign, we poll stats)
 *                                            false = we drive sending per recipient
 * @property {() => Promise<boolean>} isConfigured
 * @property {() => Promise<{ok:boolean,message:string}>} verify   credentials check
 * @property {(subscriber) => Promise<object>} upsertSubscriber    sync one contact
 * @property {(email) => Promise<void>} unsubscribeSubscriber
 * @property {(name) => Promise<{id:string}>} createGroup          create/find a list
 * @property {(opts) => Promise<{id:string}>} createCampaign       bulk: draft campaign
 * @property {(id) => Promise<void>} sendCampaign                  bulk: trigger send
 * @property {(id) => Promise<object>} getCampaignStats            bulk: performance
 * @property {(message) => Promise<{providerMessageId:string}>} sendMessage  per-recipient
 */

const { NotConfiguredError } = require('../../lib/errors');

class BaseDeliveryProvider {
  constructor(name) {
    this.name = name;
    this.supportsBulkCampaigns = false;
  }

  async isConfigured() { return false; }

  notConfigured(what) {
    return new NotConfiguredError(
      `${what || this.name} is not configured. Add its credentials in Settings → Integrations.`
    );
  }

  /* eslint-disable no-unused-vars */
  async verify() { throw new Error('verify() not implemented'); }
  async upsertSubscriber(subscriber) { return null; }
  async unsubscribeSubscriber(email) { return null; }
  async createGroup(name) { return null; }
  async createCampaign(opts) { throw new Error('createCampaign() not supported'); }
  async sendCampaign(id) { throw new Error('sendCampaign() not supported'); }
  async getCampaignStats(id) { return {}; }
  async getQuota() { return { provider: this.name, requestRateLimit: null, notes: [] }; }
  async sendMessage(message) { throw new Error('sendMessage() not supported'); }
  /* eslint-enable no-unused-vars */
}

module.exports = BaseDeliveryProvider;
