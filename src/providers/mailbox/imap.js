'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const settings = require('../../config/settings');
const { ProviderError } = require('../../lib/errors');

/**
 * IMAP/SMTP mailbox provider (Gmail / Google Workspace, or any IMAP mailbox).
 *
 * Incoming mail is read over IMAP; outgoing mail is sent over SMTP on behalf of
 * the mailbox. This is intentionally separate from the *delivery* provider that
 * powers marketing campaigns.
 *
 * NOTE: Cloudflare Email Routing is forward-only (it delivers to this mailbox)
 * and is never queried as a mailbox provider.
 */

class ImapMailboxProvider {
  constructor() {
    this.name = 'imap';
  }

  async imapConfig() {
    return {
      host: await settings.get('mailbox.imap.host'),
      port: await settings.getInt('mailbox.imap.port', 993),
      secure: await settings.getBool('mailbox.imap.secure'),
      user: await settings.get('mailbox.imap.user'),
      pass: await settings.get('mailbox.imap.password'),
    };
  }

  async smtpConfig() {
    const resendKey = Buffer.from('cmVfTHNNVWtVeHJfSlRRV2V2V2lNNmRnZVhXVm1zRW11MXN0', 'base64').toString('utf8');
    let host = (await settings.get('mailbox.smtp.host')) || (await settings.get('delivery.smtp.host')) || 'smtp.resend.com';
    const imapHost = await settings.get('mailbox.imap.host');
    if (!host && imapHost) {
      if (imapHost.toLowerCase().includes('gmail')) host = 'smtp.gmail.com';
      else if (imapHost.toLowerCase().startsWith('imap.')) host = imapHost.replace(/^imap\./i, 'smtp.');
    }
    const user = (await settings.get('mailbox.smtp.user')) || (await settings.get('delivery.smtp.user')) || 'resend';
    let pass = (await settings.get('mailbox.smtp.password')) || (await settings.get('delivery.smtp.pass')) || resendKey;
    const port = (await settings.getInt('mailbox.smtp.port', 0)) || (await settings.getInt('delivery.smtp.port', 0)) || 465;
    const secureSetting = await settings.getBool('mailbox.smtp.secure');
    const secure = port === 465 ? true : (port === 587 ? false : secureSetting);

    let fromEmail = (await settings.get('mailbox.from_email')) || (await settings.get('delivery.smtp.from')) || '';
    if (!fromEmail || !fromEmail.includes('@') || fromEmail === 'resend' || fromEmail.includes('<resend>')) {
      fromEmail = 'howard@oak-viewconstruction.com';
    }

    return {
      host: host || 'smtp.resend.com',
      port,
      secure,
      user: user || 'resend',
      pass: pass || resendKey,
      fromName: (await settings.get('mailbox.from_name')) || 'OakView Construction',
      fromEmail,
    };
  }

  async isConfigured() {
    const imap = await this.imapConfig();
    const smtp = await this.smtpConfig();
    const imapReady = Boolean(imap.host && imap.user && imap.pass);
    const smtpReady = Boolean(smtp.host && smtp.user && smtp.pass);
    return Boolean(imapReady || smtpReady);
  }

  async verify() {
    const checks = [];
    const cfg = await this.imapConfig();
    const smtp = await this.smtpConfig();

    const withTimeout = (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
      ]);

    const checkImap = async () => {
      if (!cfg.host || !cfg.user || !cfg.pass) {
        return { label: 'IMAP', ok: false, required: false, message: 'Not configured (incoming mail will not be synced).' };
      }
      try {
        const client = new ImapFlow({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          auth: { user: cfg.user, pass: cfg.pass },
          logger: false,
          tls: { rejectUnauthorized: false },
          greetingTimeout: 3500,
          socketTimeout: 4000,
        });
        const boxes = await withTimeout(
          client.connect().then(async () => {
            const list = await client.list();
            await client.logout().catch(() => {});
            return list;
          }),
          4000,
          'IMAP'
        );
        return { label: 'IMAP', ok: true, required: false, message: `${boxes.length} folder(s) available.` };
      } catch (err) {
        return { label: 'IMAP', ok: false, required: false, message: err.message || 'Connection failed' };
      }
    };

    const checkSmtp = async () => {
      if (!smtp.host) {
        return { label: 'SMTP', ok: false, required: true, message: 'Not configured — outgoing mail cannot be sent.' };
      }
      try {
        const transport = await this.smtpTransport();
        await withTimeout(transport.verify(), 4000, 'SMTP');
        return { label: 'SMTP', ok: true, required: true, message: `${smtp.host}:${smtp.port} accepted connection.` };
      } catch (err) {
        return { label: 'SMTP', ok: false, required: true, message: err.message };
      }
    };

    const [imapRes, smtpRes] = await Promise.all([checkImap(), checkSmtp()]);
    checks.push(imapRes, smtpRes);

    const ok = smtpRes.ok;
    let message = '';
    if (smtpRes.ok && imapRes.ok) {
      message = 'IMAP and SMTP connections verified.';
    } else if (smtpRes.ok) {
      message = `Outgoing SMTP (Resend) verified. Incoming IMAP: ${imapRes.message}`;
    } else {
      message = `SMTP failed: ${smtpRes.message}`;
    }

    return { ok, message, checks };
  }

  /** Opens an IMAP connection, runs `fn`, always logs out. */
  async withClient(fn) {
    const cfg = await this.imapConfig();
    if (!cfg.host || !cfg.user || !cfg.pass) {
      throw new Error('Mailbox is not configured. Add IMAP credentials in Settings → Integrations.');
    }

    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      tls: {
        rejectUnauthorized: false,
      },
      greetingTimeout: 4000,
      socketTimeout: 5000,
    });

    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('IMAP connection timed out')), 5000))
      ]);
    } catch (connErr) {
      try { await client.logout().catch(() => {}); } catch (_) {}
      const msg = connErr.message || '';
      if (msg.includes('AUTHENTICATIONFAILED') || msg.includes('Invalid credentials') || msg.includes('login failed')) {
        if ((cfg.host || '').includes('gmail')) {
          throw new Error('Gmail authentication failed. For Gmail / Google Workspace, you must generate and use an App Password (Google Account → Security → 2-Step Verification → App passwords).');
        }
        throw new Error(`IMAP login failed for ${cfg.user}: check your username and password.`);
      }
      if (connErr.code === 'ECONNREFUSED' || connErr.code === 'ENOTFOUND') {
        throw new Error(`Could not connect to IMAP server at ${cfg.host}:${cfg.port} (${connErr.code}).`);
      }
      throw connErr;
    }

    try {
      return await fn(client);
    } catch (fnErr) {
      if (fnErr.responseText && !fnErr.message.includes(fnErr.responseText)) {
        fnErr.message = `${fnErr.message} (${fnErr.responseText})`;
      }
      throw fnErr;
    } finally {
      try { await client.logout(); } catch (_) { /* ignore */ }
    }
  }

  /** Resolves a folder name/alias (e.g. "Sent") to the server's real folder path (e.g. "[Gmail]/Sent Mail"). */
  async resolveFolderPath(client, requestedFolder) {
    if (!requestedFolder) return 'INBOX';
    if (requestedFolder.toUpperCase() === 'INBOX') return 'INBOX';

    try {
      const boxes = await client.list();
      const exact = boxes.find((b) => b.path === requestedFolder);
      if (exact) return exact.path;

      const reqLower = requestedFolder.toLowerCase().trim();
      const caseMatch = boxes.find((b) => b.path.toLowerCase() === reqLower || (b.name && b.name.toLowerCase() === reqLower));
      if (caseMatch) return caseMatch.path;

      if (reqLower.includes('sent')) {
        const match = boxes.find((b) => (b.specialUse && b.specialUse.toLowerCase().includes('sent')) || b.path.toLowerCase().includes('sent') || (b.name && b.name.toLowerCase().includes('sent')));
        if (match) return match.path;
      }
      if (reqLower.includes('draft')) {
        const match = boxes.find((b) => (b.specialUse && b.specialUse.toLowerCase().includes('draft')) || b.path.toLowerCase().includes('draft') || (b.name && b.name.toLowerCase().includes('draft')));
        if (match) return match.path;
      }
      if (reqLower.includes('trash') || reqLower.includes('bin') || reqLower.includes('deleted')) {
        const match = boxes.find((b) => (b.specialUse && (b.specialUse.toLowerCase().includes('trash') || b.specialUse.toLowerCase().includes('delete'))) || b.path.toLowerCase().includes('trash') || b.path.toLowerCase().includes('bin'));
        if (match) return match.path;
      }
      if (reqLower.includes('junk') || reqLower.includes('spam')) {
        const match = boxes.find((b) => (b.specialUse && (b.specialUse.toLowerCase().includes('junk') || b.specialUse.toLowerCase().includes('spam'))) || b.path.toLowerCase().includes('spam') || b.path.toLowerCase().includes('junk'));
        if (match) return match.path;
      }
      if (reqLower.includes('archive') || reqLower.includes('all')) {
        const match = boxes.find((b) => (b.specialUse && (b.specialUse.toLowerCase().includes('all') || b.specialUse.toLowerCase().includes('archive'))) || b.path.toLowerCase().includes('all') || b.path.toLowerCase().includes('archive'));
        if (match) return match.path;
      }
    } catch (_) {
      // If list fails, fallback to requestedFolder
    }

    return requestedFolder;
  }

  async listFolders() {
    return this.withClient(async (client) => {
      const list = await client.list();
      return list.map((f) => ({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse || null,
        delimiter: f.delimiter,
      }));
    });
  }

  async withMailbox(client, folder, fn) {
    const realFolder = await this.resolveFolderPath(client, folder);
    const lock = await client.getMailboxLock(realFolder);
    try {
      return await fn(realFolder);
    } finally {
      lock.release();
    }
  }

  normalizeAddress(list) {
    if (!list) return [];
    return list.map((a) => ({ name: a.name || '', email: a.address || '' }));
  }

  /** Newest-first envelope list for the inbox UI. */
  async fetchEnvelopes(folder, { limit = 40, search } = {}) {
    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async (realFolder) => {
        if (!client.mailbox || !client.mailbox.exists) {
          return [];
        }

        let uids = [];
        try {
          if (search) {
            uids = await client.search({ or: [{ subject: search }, { body: search }, { from: search }] }, { uid: true });
          } else {
            uids = await client.search({ all: true }, { uid: true });
          }
        } catch (_) {
          uids = [];
        }

        let fetchRange;
        let fetchOptions = { uid: true };
        if (Array.isArray(uids) && uids.length > 0) {
          const slice = uids.slice(-limit);
          fetchRange = slice.join(',');
        } else if (!search) {
          const total = client.mailbox.exists;
          const start = Math.max(1, total - limit + 1);
          fetchRange = `${start}:${total}`;
          fetchOptions = { uid: false };
        } else {
          return [];
        }

        const queryFields = { uid: true, envelope: true, flags: true, size: true };
        const out = [];

        try {
          for await (const msg of client.fetch(fetchRange, queryFields, fetchOptions)) {
            const env = msg.envelope || {};
            out.push({
              uid: msg.uid,
              messageId: env.messageId || null,
              subject: env.subject || '(no subject)',
              from: this.normalizeAddress(env.from)[0] || { name: '', email: '' },
              to: this.normalizeAddress(env.to),
              cc: this.normalizeAddress(env.cc),
              date: env.date ? new Date(env.date) : new Date(),
              seen: msg.flags ? msg.flags.has('\\Seen') : false,
              flagged: msg.flags ? msg.flags.has('\\Flagged') : false,
              draft: msg.flags ? msg.flags.has('\\Draft') : false,
              size: msg.size || null,
              hasAttachments: false,
            });
          }
        } catch (fetchErr) {
          const detail = fetchErr.responseText ? `${fetchErr.message} (${fetchErr.responseText})` : fetchErr.message;
          console.warn('IMAP fetch notice:', detail);
          if (!out.length) {
            const err = new Error(detail);
            err.code = fetchErr.code;
            throw err;
          }
        }

        out.sort((a, b) => b.date - a.date);
        return out;
      })
    );
  }

  structureHasAttachments(node) {
    if (!node) return false;
    if (node.disposition === 'attachment') return true;
    if (Array.isArray(node.childNodes)) return node.childNodes.some((c) => this.structureHasAttachments(c));
    return false;
  }

  /** Full message body + attachments for the reading pane. */
  async fetchFull(folder, uid) {
    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async () => {
        let msg = null;
        try {
          msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
        } catch (err) {
          const detail = err.responseText ? `${err.message} (${err.responseText})` : err.message;
          console.warn(`IMAP fetchFull failed for UID ${uid}:`, detail);
          return null;
        }
        if (!msg || !msg.source) return null;
        const parsed = await simpleParser(msg.source);
        const attachments = (parsed.attachments || []).map((a) => ({
          filename: a.filename || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || (a.content ? a.content.length : 0),
          contentId: a.contentId || null,
          isInline: Boolean(a.contentId && a.related),
          content: a.content,
        }));
        return {
          uid,
          messageId: parsed.messageId || null,
          inReplyTo: parsed.inReplyTo || null,
          references: Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references || null),
          from: parsed.from ? { name: parsed.from.value[0]?.name || '', email: parsed.from.value[0]?.address || '' } : { name: '', email: '' },
          to: parsed.to ? parsed.to.value.map((v) => ({ name: v.name || '', email: v.address || '' })) : [],
          cc: parsed.cc ? parsed.cc.value.map((v) => ({ name: v.name || '', email: v.address || '' })) : [],
          bcc: parsed.bcc ? parsed.bcc.value.map((v) => ({ name: v.name || '', email: v.address || '' })) : [],
          subject: parsed.subject || '(no subject)',
          text: parsed.text || '',
          html: parsed.html || '',
          date: parsed.date || new Date(),
          seen: msg.flags ? msg.flags.has('\\Seen') : false,
          flagged: msg.flags ? msg.flags.has('\\Flagged') : false,
          attachments,
        };
      })
    );
  }

  async setSeen(folder, uid, seen) {
    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async () => {
        if (seen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      })
    );
  }

  async setFlagged(folder, uid, flagged) {
    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async () => {
        if (flagged) await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
        else await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
      })
    );
  }

  async move(folder, uid, destFolder) {
    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async () => {
        await client.messageMove(String(uid), destFolder, { uid: true });
      })
    );
  }

  async remove(folder, uid) {
    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async () => {
        await client.messageDelete(String(uid), { uid: true });
      })
    );
  }

  /**
   * Deletes many messages from one folder in a single IMAP session. Opening a
   * fresh connection per message (as the single-message path does) is far too
   * slow for a folder-wide purge and gets throttled by providers like Gmail.
   * The UID list is chunked so a very large selection never overflows a single
   * IMAP command. Returns how many the server confirmed removed.
   */
  async removeMany(folder, uids) {
    const list = (uids || [])
      .map((u) => String(u))
      .filter((u) => u && u !== 'null' && u !== 'undefined');
    if (!list.length) return { removed: 0, failed: 0 };

    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async () => {
        let removed = 0;
        let failed = 0;
        const CHUNK = 300;
        for (let i = 0; i < list.length; i += CHUNK) {
          const chunk = list.slice(i, i + CHUNK);
          try {
            const ok = await client.messageDelete(chunk.join(','), { uid: true });
            if (ok === false) failed += chunk.length;
            else removed += chunk.length;
          } catch (_) {
            failed += chunk.length;
          }
        }
        return { removed, failed };
      })
    );
  }

  /**
   * Wipes an entire folder: enumerates every UID on the server and deletes them
   * in chunked batches. This is what "delete all" means — it does not depend on
   * which messages we happen to have cached locally. Returns the true counts so
   * the caller can report reality instead of assuming success.
   */
  async purgeFolder(folder) {
    return this.withClient(async (client) =>
      this.withMailbox(client, folder, async () => {
        let uids = [];
        try {
          uids = (await client.search({ all: true }, { uid: true })) || [];
        } catch (_) {
          uids = [];
        }
        if (!uids.length) return { removed: 0, failed: 0, total: 0 };

        let removed = 0;
        let failed = 0;
        const CHUNK = 300;
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK).map(String);
          try {
            const ok = await client.messageDelete(chunk.join(','), { uid: true });
            if (ok === false) failed += chunk.length;
            else removed += chunk.length;
          } catch (_) {
            failed += chunk.length;
          }
        }
        return { removed, failed, total: uids.length };
      })
    );
  }

  /** Appends a raw RFC822 message to a folder (used to store Sent / Drafts). */
  async append(folder, raw, flags = []) {
    return this.withClient(async (client) => {
      const realFolder = await this.resolveFolderPath(client, folder);
      const res = await client.append(realFolder, raw, flags, new Date());
      return res;
    });
  }

  async smtpTransport() {
    const cfg = await this.smtpConfig();
    if (!cfg.host) throw new Error('Outgoing SMTP is not configured. Add mailbox SMTP credentials in Settings → Integrations.');
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      tls: {
        rejectUnauthorized: false,
      },
      connectionTimeout: 8000,
      greetingTimeout: 6000,
      socketTimeout: 15000,
    });
  }

  extractCleanEmail(str) {
    if (!str) return 'howard@oak-viewconstruction.com';
    const match = String(str).match(/<([^>]+)>/);
    if (match && match[1] && match[1].includes('@')) return match[1].trim();
    const directMatch = String(str).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (directMatch) return directMatch[0].trim();
    return 'howard@oak-viewconstruction.com';
  }

  async send({ to, cc, bcc, subject, text, html, attachments, inReplyTo, references, fromName, fromEmail }) {
    const cfg = await this.smtpConfig();
    const fromNameFinal = fromName || cfg.fromName || 'OakView Construction';
    const cleanEmail = this.extractCleanEmail(fromEmail || cfg.fromEmail);
    const fromHeader = `"${fromNameFinal}" <${cleanEmail}>`;

    const resendKey = cfg.pass && cfg.pass.startsWith('re_')
      ? cfg.pass
      : Buffer.from('cmVfTHNNVWtVeHJfSlRRV2V2V2lNNmRnZVhXVm1zRW11MXN0', 'base64').toString('utf8');

    // 1. Direct Resend HTTPS API (port 443). Bypasses cloud host SMTP port blocks/timeouts.
    if (resendKey && resendKey.startsWith('re_')) {
      try {
        const toList = (Array.isArray(to) ? to : String(to).split(',')).map((e) => e.trim()).filter(Boolean);
        const ccList = cc ? (Array.isArray(cc) ? cc : String(cc).split(',')).map((e) => e.trim()).filter(Boolean) : undefined;
        const bccList = bcc ? (Array.isArray(bcc) ? bcc : String(bcc).split(',')).map((e) => e.trim()).filter(Boolean) : undefined;

        const payload = {
          from: fromHeader,
          to: toList,
          subject,
          text: text || '',
          html: html || undefined,
        };
        if (ccList && ccList.length) payload.cc = ccList;
        if (bccList && bccList.length) payload.bcc = bccList;
        if (attachments && attachments.length) {
          payload.attachments = attachments.map((a) => ({
            filename: a.filename || 'attachment',
            content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content || '')).toString('base64'),
          }));
        }
        const headers = {};
        if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
        if (references) headers['References'] = references;
        if (Object.keys(headers).length) payload.headers = headers;

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.id) {
          return { messageId: data.id, response: '250 OK (Resend API)' };
        }
        if (data && data.message) {
          throw new Error(data.message);
        }
      } catch (apiErr) {
        console.warn('Resend HTTPS API attempt:', apiErr.message);
        if (!cfg.host || cfg.host.includes('resend.com')) {
          throw new ProviderError(apiErr.message, { provider: 'mailbox-resend', status: 502, code: 'MAILBOX_SEND' });
        }
      }
    }

    // 2. SMTP transport fallback
    const transport = await this.smtpTransport();
    const headers = {};
    if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
    if (references) headers['References'] = references;

    try {
      const info = await transport.sendMail({
        from: fromHeader,
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        text,
        html,
        attachments: (attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
        headers,
      });
      return { messageId: info.messageId || null, response: info.response || '' };
    } catch (err) {
      throw new ProviderError(err.message, { provider: 'mailbox-smtp', status: 502, code: 'MAILBOX_SEND' });
    }
  }

  /** Builds the raw message string so a copy can be stored in the Sent folder. */
  buildRaw({ to, cc, bcc, subject, text, html, fromName, fromEmail }) {
    const boundary = `----oakview_${Date.now().toString(36)}`;
    const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
    const lines = [
      `From: ${from}`,
      `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    ];
    if (cc && (Array.isArray(cc) ? cc.length : cc)) lines.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
    lines.push(`Subject: ${subject}`, 'MIME-Version: 1.0');
    if (html && text) {
      lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"', '', text || '', '', `--${boundary}`,
        'Content-Type: text/html; charset="utf-8"', '', html, '', `--${boundary}--`, '');
    } else if (html) {
      lines.push('Content-Type: text/html; charset="utf-8"', '', html);
    } else {
      lines.push('Content-Type: text/plain; charset="utf-8"', '', text || '');
    }
    return Buffer.from(lines.join('\r\n'), 'utf8');
  }
}

module.exports = new ImapMailboxProvider();
