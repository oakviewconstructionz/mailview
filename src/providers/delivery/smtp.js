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
    const host = await settings.get('delivery.smtp.host');
    if (host) {
      const port = await settings.getInt('delivery.smtp.port', 587);
      const secureSetting = await settings.getBool('delivery.smtp.secure');
      return {
        host,
        port,
        user: await settings.get('delivery.smtp.user'),
        pass: await settings.get('delivery.smtp.pass'),
        secure: port === 465 ? true : (port === 587 ? false : secureSetting),
        from: await settings.get('delivery.smtp.from'),
        inherited: false,
      };
    }
    // No dedicated relay configured — reuse the mailbox's outgoing SMTP (e.g.
    // Gmail) so campaigns can send through the same account as the Inbox.
    const imapHost = await settings.get('mailbox.imap.host');
    let mbHost = await settings.get('mailbox.smtp.host');
    if (!mbHost && imapHost) {
      if (imapHost.toLowerCase().includes('gmail')) mbHost = 'smtp.gmail.com';
      else if (imapHost.toLowerCase().startsWith('imap.')) mbHost = imapHost.replace(/^imap\./i, 'smtp.');
    }
    const mbPort = await settings.getInt('mailbox.smtp.port', 465);
    const mbUser = (await settings.get('mailbox.smtp.user')) || (await settings.get('mailbox.imap.user'));
    const mbPass = (await settings.get('mailbox.smtp.password')) || (await settings.get('mailbox.imap.password'));
    const mbSecure = await settings.getBool('mailbox.smtp.secure');
    return {
      host: mbHost,
      port: mbPort,
      user: mbUser,
      pass: mbPass,
      secure: mbPort === 465 ? true : (mbPort === 587 ? false : mbSecure),
      from: (await settings.get('mailbox.from_email')) || mbUser,
      inherited: true,
    };
  }

  async isConfigured() {
    const c = await this.config();
    return Boolean(c.host && (c.from || c.user));
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
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }

  async verify() {
    try {
      const t = await this.transporter();
      await t.verify();
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
    try {
      const info = await t.sendMail({
        from: from || c.from,
        to,
        subject,
        html,
        text,
        replyTo,
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
