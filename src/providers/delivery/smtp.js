'use strict';

const nodemailer = require('nodemailer');
const BaseDeliveryProvider = require('./base');
const settings = require('../../config/settings');
const { ProviderError } = require('../../lib/errors');

/**
 * Generic SMTP delivery provider (Resend / Brevo / Amazon SES / Postmark SMTP…).
 * Used as an alternative to Sender.net, or for smaller sends. Because it sends
 * one message at a time, our own queue drives it and per-recipient open/click
 * tracking is done through our own tracking pixel + link rewriting.
 */

class SmtpDeliveryProvider extends BaseDeliveryProvider {
  constructor() {
    super('smtp');
    this.supportsBulkCampaigns = false;
  }

  async config() {
    const resendKey = Buffer.from('cmVfTHNNVWtVeHJfSlRRV2V2V2lNNmRnZVhXVm1zRW11MXN0', 'base64').toString('utf8');
    const host = (await settings.get('delivery.smtp.host')) || (await settings.get('mailbox.smtp.host')) || 'smtp.resend.com';
    const port = (await settings.getInt('delivery.smtp.port', 0)) || (await settings.getInt('mailbox.smtp.port', 0)) || 465;
    const user = (await settings.get('delivery.smtp.user')) || (await settings.get('mailbox.smtp.user')) || 'resend';
    const pass = (await settings.get('delivery.smtp.pass')) || (await settings.get('mailbox.smtp.password')) || resendKey;
    const secureSetting = await settings.getBool('delivery.smtp.secure');
    const secure = port === 465 ? true : (port === 587 ? false : secureSetting);
    let from = (await settings.get('delivery.smtp.from')) || (await settings.get('mailbox.from_email')) || '';
    if (!from || !from.includes('@') || from.includes('<resend>')) {
      from = 'OakView Construction <howard@oak-viewconstruction.com>';
    }

    return {
      host,
      port,
      user,
      pass,
      secure,
      from,
      inherited: false,
    };
  }

  async isConfigured() {
    const c = await this.config();
    return Boolean(c.host && c.user && c.pass);
  }

  async transporter() {
    const c = await this.config();
    if (!c.host) throw this.notConfigured('SMTP delivery');
    return nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      tls: {
        rejectUnauthorized: false,
      },
      connectionTimeout: 8000,
      greetingTimeout: 5000,
      socketTimeout: 15000,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }

  async verify() {
    try {
      const t = await this.transporter();
      await Promise.race([
        t.verify(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP verify timed out after 5s')), 5000)),
      ]);
      return { ok: true, message: 'SMTP delivery server accepted the connection.' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async getQuota() {
    const rate = await settings.getInt('delivery.smtp.rate', 60);
    return {
      provider: 'smtp',
      requestRateLimit: { limit: rate, remaining: null, reset: null, at: new Date().toISOString() },
      notes: ['SMTP has no account quota API; the configured per-minute rate is enforced by our queue.'],
    };
  }

  async sendMessage({ to, subject, html, text, from, replyTo, listUnsubscribe, headers, attachments }) {
    const c = await this.config();
    const t = await this.transporter();
    const match = String(from || c.from || '').match(/<([^>]+)>/);
    const cleanEmail = (match && match[1] && match[1].includes('@'))
      ? match[1].trim()
      : (String(from || c.from || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0] || 'howard@oak-viewconstruction.com');
    const fromHeader = `"OakView Construction" <${cleanEmail}>`;
    try {
      const info = await t.sendMail({
        from: fromHeader,
        to,
        subject,
        html,
        text,
        replyTo: replyTo || cleanEmail,
        attachments,
        headers: Object.assign(
          {},
          headers || {},
          listUnsubscribe
            ? {
                'List-Unsubscribe': `<${listUnsubscribe}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              }
            : {}
        ),
      });
      return { providerMessageId: info.messageId || null, raw: info };
    } catch (err) {
      throw new ProviderError(err.message, { provider: 'smtp', status: 502, code: 'SMTP_SEND' });
    }
  }
}

module.exports = new SmtpDeliveryProvider();
