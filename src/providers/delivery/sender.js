'use strict';

const axios = require('axios');
const BaseDeliveryProvider = require('./base');
const settings = require('../../config/settings');
const { ProviderError } = require('../../lib/errors');

/**
 * Sender.net delivery provider.
 *
 * Real API only — base https://api.sender.net/v2/ with Bearer authentication.
 * Documented endpoints used here:
 *   GET  /groups                     list groups (also used to verify the token)
 *   POST /groups                     create a group (a "list" in our terms)
 *   POST /subscribers                create a subscriber
 *   POST /campaigns                  create a campaign (content_type html|text)
 *   POST /campaigns/{id}/send        start sending a campaign
 *   GET  /campaigns/{id}             campaign record incl. opens/clicks/bounces
 *   POST /message/send               transactional single message (test sends)
 *
 * Nothing is reported as successful unless Sender.net confirms it.
 */

const BASE_URL = 'https://api.sender.net/v2';

// Captured from the most recent API response so the pre-flight check can report
// the provider's *actual* request-rate headroom (never guessed).
let lastRateLimit = null;

class SenderDeliveryProvider extends BaseDeliveryProvider {
  constructor() {
    super('sender');
    this.supportsBulkCampaigns = true;
  }

  async token() {
    return settings.get('delivery.sender.api_token');
  }

  async isConfigured() {
    return Boolean(await this.token());
  }

  client(token) {
    return axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      validateStatus: () => true,
    });
  }

  async request(method, path, data, { retries = 2 } = {}) {
    const token = await this.token();
    if (!token) throw this.notConfigured('Sender.net');

    const http = this.client(token);
    let res = await http.request({ method, url: path, data });

    // Record real rate-limit headers reported by Sender.net.
    if (res.headers) {
      const limit = res.headers['x-ratelimit-limit'];
      const remaining = res.headers['x-ratelimit-remaining'];
      const reset = res.headers['x-ratelimit-reset'];
      if (limit !== undefined || remaining !== undefined) {
        lastRateLimit = {
          limit: limit !== undefined ? parseInt(limit, 10) : null,
          remaining: remaining !== undefined ? parseInt(remaining, 10) : null,
          reset: reset || null,
          at: new Date().toISOString(),
        };
      }
    }

    if (res.status === 429 && retries > 0) {
      const retryAfter = parseInt(res.headers['retry-after'], 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 10000)));
      return this.request(method, path, data, { retries: retries - 1 });
    }

    if (res.status >= 200 && res.status < 300) {
      return res.data;
    }

    const message =
      (res.data && (res.data.message || res.data.error || (res.data.errors && JSON.stringify(res.data.errors)))) ||
      `Sender.net request failed (HTTP ${res.status})`;

    throw new ProviderError(message, {
      provider: 'sender',
      status: res.status === 401 || res.status === 403 ? 400 : 502,
      code: res.status === 401 || res.status === 403 ? 'SENDER_AUTH' : 'SENDER_API',
      response: res.data,
    });
  }

  /** Lightweight credential check. */
  async verify() {
    try {
      const data = await this.request('GET', '/groups?page=1&limit=1');
      const count = (data && data.meta && data.meta.total) || (Array.isArray(data && data.data) ? data.data.length : 0);
      return { ok: true, message: `Connected to Sender.net. ${count} group(s) visible.` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  mapSubscriber(sub) {
    const body = { email: sub.email };
    if (sub.first_name) body.firstname = sub.first_name;
    if (sub.last_name) body.lastname = sub.last_name;
    if (Array.isArray(sub.groups) && sub.groups.length) body.groups = sub.groups;
    if (sub.custom_data && typeof sub.custom_data === 'object') {
      // Sender.net custom fields use the "{$field}" convention.
      const fields = {};
      for (const [k, v] of Object.entries(sub.custom_data)) {
        fields[`{$${k}}`] = v;
      }
      body.fields = fields;
    }
    return body;
  }

  async upsertSubscriber(sub) {
    return this.request('POST', '/subscribers', this.mapSubscriber(sub));
  }

  async createGroup(name) {
    const data = await this.request('POST', '/groups', { title: name });
    const group = (data && data.data) || {};
    return { id: group.id, raw: data };
  }

  async listGroups() {
    const data = await this.request('GET', '/groups?page=1&limit=100');
    return (data && data.data) || [];
  }

  async createCampaign(opts) {
    const body = {
      title: opts.title,
      subject: opts.subject,
      from: opts.from,
      reply_to: opts.reply_to,
      content_type: opts.contentType || 'html',
      content: opts.content,
    };
    if (opts.preheader) body.preheader = opts.preheader;
    if (opts.groups && opts.groups.length) body.groups = opts.groups;
    if (opts.segments && opts.segments.length) body.segments = opts.segments;

    const data = await this.request('POST', '/campaigns', body);
    const campaign = (data && data.data) || {};
    return { id: campaign.id, raw: data };
  }

  async sendCampaign(id) {
    return this.request('POST', `/campaigns/${encodeURIComponent(id)}/send`);
  }

  async getCampaignStats(id) {
    const data = await this.request('GET', `/campaigns/${encodeURIComponent(id)}`);
    const c = (data && data.data) || {};
    return {
      status: c.status,
      sent: c.sent_count || 0,
      opens: c.opens || 0,
      clicks: c.clicks || 0,
      bounces: c.bounces_count || 0,
      recipient_count: c.recipient_count || null,
      raw: c,
    };
  }

  /**
   * Best-effort read of the account's real sending headroom.
   * Sender.net exposes per-minute request limits via response headers; there is
   * no public endpoint for monthly email quota, so plan limits are entered by an
   * admin in Settings and enforced by the pre-flight check.
   */
  async getQuota() {
    try {
      await this.request('GET', '/groups?page=1&limit=1');
    } catch (_) { /* fall through and report what we last saw */ }
    return {
      provider: 'sender',
      requestRateLimit: lastRateLimit,
      notes: [
        'Per-minute API request limits are read live from Sender.net response headers.',
        'Monthly email allowance comes from the plan limit configured in Settings.',
      ],
    };
  }

  /** Transactional single message (used for "send a test email"). */
  async sendMessage({ to, subject, html, text, from, replyTo }) {
    const body = {
      from: from,
      to: to,
      subject: subject,
    };
    if (html) body.html = html;
    if (text) body.text = text;
    if (replyTo) body.reply_to = replyTo;
    const data = await this.request('POST', '/message/send', body);
    return { providerMessageId: (data && (data.data && data.data.id || data.message_id)) || null, raw: data };
  }
}

module.exports = new SenderDeliveryProvider();
