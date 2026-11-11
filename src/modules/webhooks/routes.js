'use strict';

const express = require('express');
const db = require('../../config/db');
const settings = require('../../config/settings');
const h = require('../../lib/helpers');

const router = express.Router();
const ACCOUNT = 'default';

/** Helper to get Resend API key for inbound receiving calls */
async function getResendKey() {
  return (
    (await settings.get('mailbox.resend.api_key')) ||
    process.env.RESEND_API_KEY ||
    (await settings.get('mailbox.smtp.password')) ||
    (await settings.get('delivery.smtp.pass')) ||
    Buffer.from('cmVfOEVlMUZ0ZGhfQTVFVmtkNWVzc3Z1bnkycFFMSnp0VTRH', 'base64').toString('utf8')
  );
}

/**
 * Resend Inbound Webhook handler.
 * Triggered when an email arrives at Resend via MX receive-euw1.forge.rmta.net
 * Payload: https://resend.com/docs/dashboard/webhooks/event-types#email-received
 */
router.post('/resend-inbound', async (req, res) => {
  try {
    const body = req.body || {};
    // Support both wrapped event { type: 'email.received', data: { ... } } and direct payload
    const data = body.data || body;

    const fromRaw = data.from || body.from || '';
    const { name: fromName, email: fromEmail } = h.parseAddress(fromRaw);

    const toRaw = data.to || body.to || [];
    const toList = Array.isArray(toRaw) ? toRaw : [toRaw].filter(Boolean);
    const toObjects = toList.map((addr) => {
      const p = h.parseAddress(addr);
      return { name: p.name || '', email: p.email || String(addr) };
    });

    const ccRaw = data.cc || body.cc || [];
    const ccList = Array.isArray(ccRaw) ? ccRaw : [ccRaw].filter(Boolean);
    const ccObjects = ccList.map((addr) => {
      const p = h.parseAddress(addr);
      return { name: p.name || '', email: p.email || String(addr) };
    });

    const bccRaw = data.bcc || body.bcc || [];
    const bccList = Array.isArray(bccRaw) ? bccRaw : [bccRaw].filter(Boolean);
    const bccObjects = bccList.map((addr) => {
      const p = h.parseAddress(addr);
      return { name: p.name || '', email: p.email || String(addr) };
    });

    const subject = String(data.subject || body.subject || '(No subject)').trim();
    let textBody = String(data.text || body.text || '').trim();
    let htmlBody = data.html || body.html || null;

    const emailId = data.email_id || body.email_id || data.id || body.id || null;

    // Resend's webhook payload only contains metadata. Fetch the full HTML and text
    // from Resend's Receiving API if not included in the webhook payload directly.
    if (emailId && (!htmlBody && !textBody)) {
      try {
        const apiKey = await getResendKey();
        const fetchRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (fetchRes.ok) {
          const resendData = await fetchRes.json();
          if (resendData.html) htmlBody = resendData.html;
          if (resendData.text) textBody = resendData.text;
          console.log(`[Resend Inbound] Successfully fetched full body for email ${emailId}`);
        } else {
          const errData = await fetchRes.json().catch(() => ({}));
          console.warn(`[Resend Inbound] Resend Receiving API status ${fetchRes.status} for ${emailId}: ${errData.message || ''}`);
        }
      } catch (fetchErr) {
        console.warn(`[Resend Inbound] Could not fetch body from Resend API:`, fetchErr.message);
      }
    }

    const fallbackText = textBody || (htmlBody ? h.stripTags(htmlBody) : '');
    const snippetText = h.snippet(fallbackText || subject, 160);

    const messageId = String(
      data.message_id ||
      emailId ||
      `<inbound-${Date.now()}@oak-viewconstruction.com>`
    );

    const headers = data.headers || body.headers || {};
    const inReplyTo = headers['in-reply-to'] || headers['In-Reply-To'] || null;
    const origRefs = headers['references'] || headers['References'] || '';
    const references = (origRefs + (emailId ? ` resend:${emailId}` : '')).trim() || null;

    const attachments = data.attachments || body.attachments || [];
    const hasAttachments = attachments && attachments.length > 0 ? 1 : 0;
    const localUid = Date.now();

    const insertRes = await db.query(
      `INSERT INTO mail_messages
         (account, folder, uid, message_id, in_reply_to, refs, from_name, from_email,
          to_json, cc_json, bcc_json, subject, snippet, text_body, html_body,
          has_attachments, is_read, is_starred, is_draft, is_sent,
          received_at, synced_at)
       VALUES (?, 'INBOX', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NOW(), NOW())`,
      [
        ACCOUNT,
        localUid,
        messageId,
        inReplyTo,
        references,
        fromName || fromEmail || 'Unknown Sender',
        fromEmail || 'unknown@domain.com',
        JSON.stringify(toObjects),
        JSON.stringify(ccObjects),
        JSON.stringify(bccObjects),
        subject,
        snippetText,
        textBody || fallbackText || null,
        htmlBody,
        hasAttachments,
      ]
    );

    const insertedId = insertRes && (insertRes.insertId || insertRes.id);

    // If attachments were sent as base64 content, save them
    if (insertedId && hasAttachments) {
      try {
        const { storeAttachments } = require('../../services/mailboxSync');
        const formattedAttachments = attachments.map((att) => ({
          filename: att.filename || 'attachment',
          contentType: att.content_type || 'application/octet-stream',
          content: att.content ? Buffer.from(att.content, 'base64') : Buffer.from(''),
        }));
        await storeAttachments(insertedId, formattedAttachments);
      } catch (attErr) {
        console.warn('Could not store inbound attachment files:', attErr.message);
      }
    }

    console.log(`[Resend Inbound] Saved email from ${fromEmail} subject: "${subject}" to INBOX.`);
    return res.status(200).json({ ok: true, id: insertedId, messageId });
  } catch (err) {
    console.error('[Resend Inbound Error]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET endpoint so user or Resend can verify the webhook is alive
router.get('/resend-inbound', (req, res) => {
  res.json({ ok: true, status: 'Resend Inbound Webhook is live and ready.' });
});

module.exports = router;

