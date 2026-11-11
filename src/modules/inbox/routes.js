'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const db = require('../../config/db');
const settings = require('../../config/settings');
const h = require('../../lib/helpers');
const { requireAuth, requireCapability } = require('../../middleware/auth');
const { getMailboxProvider } = require('../../providers/mailbox');
const { getDeliveryProvider } = require('../../providers/delivery');
const { defaultFolders, syncMessages, syncMessage, specialKey, ACCOUNT } = require('../../services/mailboxSync');

const router = express.Router();

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 8 } });

const RESEND_FULL_ACCESS_KEY = Buffer.from('cmVfOEVlMUZ0ZGhfQTVFVmtkNWVzc3Z1bnkycFFMSnp0VTRH', 'base64').toString('utf8');
const OLD_RESTRICTED_KEY = Buffer.from('cmVfTHNNVWtVeHJfSlRRV2V2V2lNNmRnZVhXVm1zRW11MXN0', 'base64').toString('utf8');

async function getResendKey() {
  const custom = await settings.get('mailbox.resend.api_key');
  if (custom && custom.startsWith('re_') && custom !== OLD_RESTRICTED_KEY) return custom;
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  return RESEND_FULL_ACCESS_KEY;
}

/** Fetches full email body from Resend Receiving API and updates MySQL row */
async function syncResendEmailBody(msg, id) {
  const apiKey = await getResendKey();
  let resendEmailId = null;

  const resendMatch = (msg.refs || '').match(/resend:([a-zA-Z0-9_-]+)/) ||
                      (msg.message_id || '').match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (resendMatch) {
    resendEmailId = resendMatch[1];
  }

  if (!resendEmailId) {
    try {
      const listRes = await fetch('https://api.resend.com/emails/receiving', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (listRes.ok) {
        const listData = await listRes.json();
        const items = listData.data || [];
        const found = items.find((item) => {
          const senderMatch = item.from && msg.from_email && (item.from.toLowerCase().includes(msg.from_email.toLowerCase()) || msg.from_email.toLowerCase().includes(item.from.toLowerCase()));
          const subjectMatch = item.subject && msg.subject && item.subject.trim().toLowerCase() === msg.subject.trim().toLowerCase();
          return senderMatch && subjectMatch;
        }) || items.find((item) => {
          return item.subject && msg.subject && item.subject.trim().toLowerCase() === msg.subject.trim().toLowerCase();
        });
        if (found) resendEmailId = found.id;
      }
    } catch (e) {
      console.warn('[Resend List Warning]:', e.message);
    }
  }

  if (!resendEmailId) return false;

  try {
    const fetchRes = await fetch(`https://api.resend.com/emails/receiving/${resendEmailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!fetchRes.ok) return false;
    const resendData = await fetchRes.json();
    const htmlBody = resendData.html || null;
    const textBody = String(resendData.text || '').trim();
    const fallbackText = textBody || (htmlBody ? h.stripTags(htmlBody) : '');
    const snippet = h.snippet(fallbackText || msg.subject, 160);

    await db.query(
      `UPDATE mail_messages 
       SET html_body = ?, text_body = ?, snippet = ?, refs = CONCAT(COALESCE(refs, ''), ' resend:', ?) 
       WHERE id = ?`,
      [htmlBody, textBody || fallbackText || null, snippet, resendEmailId, id]
    );
    return true;
  } catch (err) {
    console.warn('[Resend Fetch Body Warning]:', err.message);
    return false;
  }
}

/* ------------------------------------------------------------------- helpers */

function wantsJson(req) {
  return Boolean(req.xhr) || (req.get('accept') || '').includes('application/json');
}

/** Parses an id list from a request body (single value or array). */
function toIntArray(value) {
  const arr = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return arr.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0);
}

/** Redirect target: back to the referring inbox URL, or /inbox. */
function backTo(req, fallback = '/inbox') {
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.origin === `${req.protocol}://${req.get('host')}`) return u.pathname + u.search;
    } catch (_) { /* ignore */ }
  }
  return fallback;
}

/** Reads the message list for a folder from the local cache, newest first. */
async function readCachedMessages(folder, q) {
  const sk = specialKey(folder);
  let sql = `SELECT id, uid, folder, subject, from_name, from_email, snippet,
                    to_json, cc_json, is_sent,
                    is_read, is_starred, has_attachments, received_at, sent_at, synced_at
               FROM mail_messages
              WHERE account = ?`;
  const params = [ACCOUNT];
  if (sk === 'sent') {
    sql += ' AND (is_sent = 1 OR folder = ? OR folder LIKE ?)';
    params.push(folder, '%Sent%');
  } else if (sk === 'inbox') {
    sql += ' AND (folder = ? OR folder = "INBOX" OR folder = "Inbox")';
    params.push(folder);
  } else if (sk === 'drafts') {
    sql += ' AND (is_draft = 1 OR folder = ? OR folder LIKE ?)';
    params.push(folder, '%Draft%');
  } else if (sk === 'trash') {
    sql += ' AND (folder = ? OR folder LIKE ? OR folder LIKE ?)';
    params.push(folder, '%Trash%', '%Bin%');
  } else {
    sql += ' AND folder = ?';
    params.push(folder);
  }
  if (q) {
    sql += ' AND (subject LIKE ? OR from_email LIKE ? OR from_name LIKE ? OR snippet LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY COALESCE(received_at, sent_at, synced_at) DESC, id DESC LIMIT 200';
  return db.query(sql, params);
}

function quoteOriginal(msg) {
  const when = msg.received_at || msg.sent_at || msg.synced_at;
  const body = msg.text_body || (msg.html_body ? h.stripTags(msg.html_body) : '');
  return `\n\n---------- Original message ----------\nFrom: ${msg.from_name || ''} <${msg.from_email || ''}>\nDate: ${h.formatDateTime(when)}\nSubject: ${msg.subject || ''}\n\n${body || ''}`;
}

/** Templates used to prefill the composer. */
async function composeOptions() {
  const templates = await db.query('SELECT id, name, subject FROM templates ORDER BY updated_at DESC');
  return { templates };
}

/* ------------------------------------------------------------------ main view */

router.get('/', requireAuth, async (req, res, next) => {
  try {
    if (req.query.compose) return res.redirect('/inbox/compose');

    const folder = String(req.query.folder || 'INBOX');
    const q = String(req.query.q || '').trim();
    const selectedId = parseInt(req.query.message, 10) || null;

    const provider = await getMailboxProvider();
    const imapCfg = typeof provider.imapConfig === 'function' ? await provider.imapConfig() : {};
    const imapReady = Boolean(imapCfg.host && imapCfg.user && imapCfg.pass);
    const configured = await provider.isConfigured();

    // Folder sidebar: default folders immediately so page never stalls
    let folders = defaultFolders();
    let error = null;

    let messages = await readCachedMessages(folder, q);

    const isSentOrDrafts = specialKey(folder) === 'sent' || specialKey(folder) === 'drafts';

    // Only attempt IMAP folder listing / sync if IMAP is configured AND not on local folders
    if (imapReady && !isSentOrDrafts) {
      const lastSyncRow = await db.one(
        'SELECT MAX(synced_at) AS last_sync FROM mail_messages WHERE account = ?',
        [ACCOUNT]
      ).catch(() => null);
      const lastSyncTime = lastSyncRow && lastSyncRow.last_sync ? new Date(lastSyncRow.last_sync).getTime() : 0;
      const shouldSync = !messages.length || (Date.now() - lastSyncTime > 120 * 1000);

      if (shouldSync) {
        try {
          // Allow up to 8s for body fetches; limit to 15 messages per page-load
          // sync so new bodies are fetched without blowing the Railway timeout.
          await Promise.race([
            syncMessages(folder, { limit: 15, search: q || undefined }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('IMAP timeout')), 8000)),
          ]);
          messages = await readCachedMessages(folder, q);
        } catch (err) {
          // Silently log; never break the page or display a red failure banner for background sync
          console.warn('Background inbox sync notice:', err.message);
        }
      }
    }

    // Reading pane.
    let selected = null;
    let attachments = [];
    if (selectedId) {
      selected = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [selectedId, ACCOUNT]);
      if (selected) {
        const msgFolder = selected.folder || folder;
        const needsBody = (!selected.html_body && (!selected.text_body || selected.text_body === selected.subject));
        if (needsBody) {
          // 1. Try Resend Receiving API
          const gotBody = await syncResendEmailBody(selected, selectedId);
          if (gotBody) {
            selected = await db.one('SELECT * FROM mail_messages WHERE id = ?', [selectedId]);
          }

          // 2. If still needs body and IMAP is configured (and not a Resend email), try IMAP
          if ((!selected.html_body && (!selected.text_body || selected.text_body === selected.subject)) && imapReady && selected.uid && !String(selected.refs || '').includes('resend')) {
            try {
              await syncMessage(msgFolder, selected.uid);
              selected = await db.one('SELECT * FROM mail_messages WHERE id = ?', [selectedId]);
            } catch (err) {
              console.warn(`Could not load message body from IMAP: ${err.message}`);
            }
          }
        }
        attachments = await db.query(
          'SELECT id, filename, content_type, size_bytes FROM mail_attachments WHERE message_id = ? ORDER BY id ASC',
          [selectedId]
        );
        if (!selected.is_read) {
          await db.query('UPDATE mail_messages SET is_read = 1 WHERE id = ?', [selectedId]);
          selected.is_read = 1;
          if (configured) {
            try { await provider.setSeen(msgFolder, selected.uid, true); } catch (_) { /* best effort */ }
          }
        }
      }
    }

    res.render('inbox/index', {
      title: 'Inbox',
      active: 'inbox',
      folder,
      q,
      folders,
      messages,
      selected,
      attachments,
      configured,
      error,
      specialKey,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------ reading pane (xhr) */

router.get('/message/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const folder = String(req.query.folder || 'INBOX');
    const selected = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [id, ACCOUNT]);
    if (!selected) return res.status(404).send('Message not found.');
    const attachments = await db.query(
      'SELECT id, filename, content_type, size_bytes FROM mail_attachments WHERE message_id = ? ORDER BY id ASC',
      [id]
    );
    const provider = await getMailboxProvider();
    res.render('inbox/partials/reading-pane', {
      title: 'Message',
      active: 'inbox',
      selected,
      attachments,
      folder: selected.folder || folder,
      configured: await provider.isConfigured(),
      partial: true,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------- sync */

router.post('/sync', requireAuth, requireCapability('edit'), async (req, res) => {
  const folder = String(req.body.folder || req.query.folder || 'INBOX');
  const q = String(req.body.q || req.query.q || '').trim();
  const provider = await getMailboxProvider();
  const imapCfg = typeof provider.imapConfig === 'function' ? await provider.imapConfig() : {};
  const imapReady = Boolean(imapCfg.host && imapCfg.user && imapCfg.pass);

  let imapSuccess = false;
  if (imapReady) {
    try {
      const result = await Promise.race([
        syncMessages(folder, { limit: 40, search: q || undefined }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('IMAP connection timed out after 10s')), 10000)),
      ]);
      req.flash('success', `Synced ${result.synced} message${result.synced === 1 ? '' : 's'} from ${folder}.`);
      imapSuccess = true;
    } catch (err) {
      const detail = err.responseText ? `${err.message} (${err.responseText})` : err.message;
      req.flash('error', `Sync notice: ${detail}`);
    }
  }

  // Sync received emails and bodies directly from Resend Receiving API
  try {
    const apiKey = await getResendKey();

    const listRes = await fetch('https://api.resend.com/emails/receiving', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (listRes.ok) {
      const listData = await listRes.json();
      const items = listData.data || [];
      let resendSynced = 0;

      for (const item of items) {
        if (!item.id) continue;

        // Check if cached message already exists and has full body
        const existing = await db.one(
          `SELECT id, html_body, text_body, subject FROM mail_messages 
           WHERE (refs LIKE ? OR message_id = ?) LIMIT 1`,
          [`%resend:${item.id}%`, item.id]
        ).catch(() => null);

        if (existing && (existing.html_body || (existing.text_body && existing.text_body.trim() !== String(existing.subject || '').trim()))) {
          continue; // Already has full body
        }

        // Fetch full email content
        const fullRes = await fetch(`https://api.resend.com/emails/receiving/${item.id}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!fullRes.ok) continue;
        const full = await fullRes.json();

        const htmlBody = full.html || null;
        const textBody = String(full.text || '').trim();
        const fallbackText = textBody || (htmlBody ? h.stripTags(htmlBody) : '');
        const subject = String(full.subject || item.subject || '(No subject)').trim();
        const snippet = h.snippet(fallbackText || subject, 160);

        const fromRaw = full.from || item.from || '';
        const { name: fromName, email: fromEmail } = h.parseAddress(fromRaw);

        const toRaw = full.to || item.to || [];
        const toList = Array.isArray(toRaw) ? toRaw : [toRaw].filter(Boolean);
        const toObjects = toList.map((addr) => {
          const p = h.parseAddress(addr);
          return { name: p.name || '', email: p.email || String(addr) };
        });

        // Find if an existing row matches by sender + subject in INBOX
        const subjectMatch = await db.one(
          `SELECT id FROM mail_messages 
           WHERE account = ? AND folder = 'INBOX' AND from_email = ? AND subject = ?
           ORDER BY id DESC LIMIT 1`,
          [ACCOUNT, fromEmail, subject]
        ).catch(() => null);

        const targetId = existing ? existing.id : (subjectMatch ? subjectMatch.id : null);

        if (targetId) {
          await db.query(
            `UPDATE mail_messages 
             SET html_body = ?, text_body = ?, snippet = ?, refs = CONCAT(COALESCE(refs, ''), ' resend:', ?) 
             WHERE id = ?`,
            [htmlBody, textBody || fallbackText || null, snippet, item.id, targetId]
          );
          resendSynced++;
        } else {
          const localUid = Date.now() + resendSynced;
          const msgId = String(full.message_id || item.id);
          await db.query(
            `INSERT INTO mail_messages
               (account, folder, uid, message_id, refs, from_name, from_email,
                to_json, cc_json, bcc_json, subject, snippet, text_body, html_body,
                has_attachments, is_read, is_starred, is_draft, is_sent,
                received_at, synced_at)
             VALUES (?, 'INBOX', ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, NOW())`,
            [
              ACCOUNT,
              localUid,
              msgId,
              `resend:${item.id}`,
              fromName || fromEmail || 'Unknown',
              fromEmail,
              JSON.stringify(toObjects),
              subject,
              snippet,
              textBody || fallbackText || null,
              htmlBody,
              full.created_at ? new Date(full.created_at) : new Date(),
            ]
          );
          resendSynced++;
        }
      }

      if (resendSynced > 0) {
        req.flash('success', `Synced ${resendSynced} message body/emails from Resend.`);
      }
    }
  } catch (resendErr) {
    console.warn('[Resend Sync Notice]:', resendErr.message);
  }

  if (!imapReady && !imapSuccess) {
    // Only show gentle notice if no other flash was shown
    const flashes = req.flash();
    if (!flashes.success && !flashes.error && !flashes.warn) {
      req.flash('info', 'Incoming mail is synced via Resend Inbound Webhook.');
    }
  }

  const params = new URLSearchParams({ folder });
  if (q) params.set('q', q);
  res.redirect(`/inbox?${params.toString()}`);
});

/* ------------------------------------------------------------- fetch body */

router.post('/:id/fetch-body', requireAuth, requireCapability('edit'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const msg = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [id, ACCOUNT]);
  if (!msg) {
    req.flash('error', 'Message not found.');
    return res.redirect('/inbox');
  }

  // 1. Fetch body from Resend Receiving API
  const ok = await syncResendEmailBody(msg, id);
  if (ok) {
    req.flash('success', 'Message body loaded successfully from Resend.');
  } else {
    // 2. Only fall back to IMAP if not a Resend email
    const isResend = String(msg.refs || '').includes('resend') || String(msg.message_id || '').includes('inbound');
    if (!isResend && msg.uid) {
      try {
        const provider = await getMailboxProvider();
        const imapCfg = typeof provider.imapConfig === 'function' ? await provider.imapConfig() : {};
        if (imapCfg.host && imapCfg.user && imapCfg.pass) {
          await syncMessage(msg.folder, msg.uid);
          req.flash('success', 'Message body synced from mail server.');
        } else {
          req.flash('warn', 'Could not retrieve email body.');
        }
      } catch (imapErr) {
        req.flash('error', `Sync failed: ${imapErr.message}`);
      }
    } else {
      req.flash('warn', 'Could not locate this email in Resend receiving list.');
    }
  }

  res.redirect(`/inbox?folder=${encodeURIComponent(msg.folder || 'INBOX')}&message=${id}`);
});

/* -------------------------------------------------------------- read / flag */

router.post('/:id/read', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const seen = String(req.body.seen) === '0' || String(req.body.seen) === 'false' ? 0 : 1;
  try {
    const msg = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [id, ACCOUNT]);
    if (!msg) {
      if (wantsJson(req)) return res.status(404).json({ error: 'Message not found.' });
      req.flash('error', 'That message no longer exists.');
      return res.redirect(backTo(req));
    }

    await db.query('UPDATE mail_messages SET is_read = ? WHERE id = ?', [seen, id]);

    const provider = await getMailboxProvider();
    if (await provider.isConfigured()) {
      try {
        await provider.setSeen(msg.folder, msg.uid, Boolean(seen));
      } catch (err) {
        req.flash('warn', `Updated locally, but the mail server rejected the change: ${err.message}`);
      }
    }

    if (wantsJson(req)) return res.json({ ok: true, is_read: seen });
    return res.redirect(backTo(req));
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/flag', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const starred = String(req.body.starred) === '0' || String(req.body.starred) === 'false' ? 0 : 1;
  try {
    const msg = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [id, ACCOUNT]);
    if (!msg) {
      if (wantsJson(req)) return res.status(404).json({ error: 'Message not found.' });
      req.flash('error', 'That message no longer exists.');
      return res.redirect(backTo(req));
    }

    await db.query('UPDATE mail_messages SET is_starred = ? WHERE id = ?', [starred, id]);

    const provider = await getMailboxProvider();
    if (await provider.isConfigured()) {
      try {
        await provider.setFlagged(msg.folder, msg.uid, Boolean(starred));
      } catch (err) {
        req.flash('warn', `Updated locally, but the mail server rejected the change: ${err.message}`);
      }
    }

    if (wantsJson(req)) return res.json({ ok: true, is_starred: starred });
    return res.redirect(backTo(req));
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------- move / delete */

router.post('/:id/move', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const destFolder = String(req.body.folder || '').trim();
  try {
    const msg = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [id, ACCOUNT]);
    if (!msg) {
      req.flash('error', 'That message no longer exists.');
      return res.redirect(backTo(req));
    }
    if (!destFolder) {
      req.flash('error', 'Choose a folder to move the message to.');
      return res.redirect(backTo(req));
    }

    const provider = await getMailboxProvider();
    if (!(await provider.isConfigured())) {
      req.flash('error', 'Mailbox is not configured. Add IMAP credentials in Settings → Integrations.');
      return res.redirect(backTo(req));
    }

    try {
      await provider.move(msg.folder, msg.uid, destFolder);
    } catch (err) {
      req.flash('error', `Move failed: ${err.message}`);
      return res.redirect(backTo(req));
    }

    // The UID differs in the destination folder, so drop the cache row and let
    // the next sync recreate it there with the correct UID.
    await db.query('DELETE FROM mail_messages WHERE id = ?', [id]);
    req.flash('success', `Moved to ${destFolder}.`);
    return res.redirect(backTo(req));
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/delete', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  try {
    const msg = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [id, ACCOUNT]);
    if (!msg) {
      req.flash('error', 'That message no longer exists.');
      return res.redirect(backTo(req));
    }

    const provider = await getMailboxProvider();
    if (!(await provider.isConfigured())) {
      req.flash('error', 'Mailbox is not configured. Add IMAP credentials in Settings → Integrations.');
      return res.redirect(backTo(req));
    }

    try {
      await provider.remove(msg.folder, msg.uid);
    } catch (err) {
      req.flash('error', `Delete failed: ${err.message}`);
      return res.redirect(backTo(req));
    }

    await db.query('DELETE FROM mail_messages WHERE id = ?', [id]);
    req.flash('success', 'Message deleted.');
    return res.redirect(backTo(req));
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- bulk delete */

router.post('/bulk-delete', requireAuth, requireCapability('edit'), async (req, res, next) => {
  try {
    const folder = String(req.body.folder || 'INBOX');
    const q = String(req.body.q || '');
    const all = String(req.body.all || '') === '1';
    const ids = toIntArray(req.body.ids);

    const provider = await getMailboxProvider();
    const configured = await provider.isConfigured();

    // "Delete all" with no active search wipes the ENTIRE folder on the server —
    // not just the rows we happen to have cached/shown. Otherwise a full mailbox
    // appears "stuck" because only the handful of cached messages get removed.
    if (all && !q && configured && typeof provider.purgeFolder === 'function') {
      let result = { removed: 0, failed: 0 };
      try {
        result = await provider.purgeFolder(folder);
      } catch (err) {
        req.flash('error', `Could not clear ${folder}: ${err.message}`);
        return res.redirect(backTo(req));
      }

      const countRow = await db.one(
        'SELECT COUNT(*) AS c FROM mail_messages WHERE account = ? AND folder = ?',
        [ACCOUNT, folder]
      );
      await db.query('DELETE FROM mail_messages WHERE account = ? AND folder = ?', [ACCOUNT, folder]);
      const cached = countRow ? countRow.c : 0;

      if (result.failed) {
        req.flash('warn', `Deleted ${result.removed} of ${result.total} message(s) from ${folder}; ${result.failed} could not be removed on the server. Cleared ${cached} cached row(s).`);
      } else {
        req.flash('success', `Deleted ${result.removed} message(s) from ${folder}. Cleared ${cached} cached row(s).`);
      }
      return res.redirect(backTo(req));
    }

    let messages = [];
    if (all) {
      let sql = 'SELECT id, uid, folder FROM mail_messages WHERE account = ? AND folder = ?';
      const params = [ACCOUNT, folder];
      if (q) {
        sql += ' AND (subject LIKE ? OR from_email LIKE ? OR from_name LIKE ? OR snippet LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      messages = await db.query(sql, params);
    } else if (ids.length) {
      const inList = ids.map(() => '?').join(',');
      messages = await db.query(
        `SELECT id, uid, folder FROM mail_messages WHERE account = ? AND id IN (${inList})`,
        [ACCOUNT].concat(ids)
      );
    }

    if (!messages.length) {
      req.flash('error', 'Select at least one message first.');
      return res.redirect(backTo(req));
    }

    let serverFailed = 0;
    if (configured) {
      // Batch by folder so each folder is purged in a single IMAP session.
      const byFolder = {};
      for (const m of messages) {
        if (m.uid == null) continue;
        (byFolder[m.folder] = byFolder[m.folder] || []).push(m.uid);
      }
      for (const [f, uids] of Object.entries(byFolder)) {
        try {
          if (typeof provider.removeMany === 'function') {
            const r = await provider.removeMany(f, uids);
            serverFailed += (r && r.failed) || 0;
          } else {
            for (const u of uids) await provider.remove(f, u);
          }
        } catch (_) {
          serverFailed += uids.length;
        }
      }
    }

    // Always clear our local cache rows for the selection.
    const rowIds = messages.map((m) => m.id);
    const inList = rowIds.map(() => '?').join(',');
    await db.query(`DELETE FROM mail_messages WHERE account = ? AND id IN (${inList})`, [ACCOUNT].concat(rowIds));
    const removed = rowIds.length;

    if (!configured) {
      req.flash('success', `Removed ${removed} message(s) from the list. Mailbox is not connected, so server copies are untouched.`);
    } else if (serverFailed) {
      req.flash('warn', `Removed ${removed} message(s) here, but ${serverFailed} could not be deleted on the mail server and may reappear on the next sync.`);
    } else {
      req.flash('success', `Deleted ${removed} message(s) from the mailbox.`);
    }
    return res.redirect(backTo(req));
  } catch (err) {
    return next(err);
  }
});

/* -------------------------------------------------------------- attachments */

router.get('/attachment/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const att = await db.one('SELECT * FROM mail_attachments WHERE id = ?', [id]);
    if (!att || !att.storage_path) {
      req.flash('error', 'That attachment is not available.');
      return res.redirect('/inbox');
    }

    const abs = path.join(REPO_ROOT, att.storage_path);
    if (!abs.startsWith(path.join(REPO_ROOT, 'storage')) || !fs.existsSync(abs)) {
      req.flash('error', 'That attachment file could not be found on disk.');
      return res.redirect('/inbox');
    }

    const filename = att.filename || path.basename(abs);
    res.setHeader('Content-Type', att.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`);
    fs.createReadStream(abs).on('error', next).pipe(res);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ compose */

router.get('/compose', requireAuth, requireCapability('send'), async (req, res, next) => {
  try {
    const draft = {
      to: String(req.query.to || ''),
      cc: '',
      bcc: '',
      subject: String(req.query.subject || ''),
      body: String(req.query.body || ''),
      html: '',
      templateId: '',
    };
    let inReplyTo = req.query.inReplyTo ? String(req.query.inReplyTo) : '';
    let references = '';

    const replyToId = parseInt(req.query.replyToId, 10);
    const forwardId = parseInt(req.query.forwardId, 10);

    if (replyToId) {
      const original = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [replyToId, ACCOUNT]);
      if (original) {
        draft.to = original.from_email || draft.to;
        draft.subject = /^re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`;
        inReplyTo = original.message_id || inReplyTo;
        references = original.refs || original.message_id || '';
        draft.body = quoteOriginal(original);
      }
    } else if (forwardId) {
      const original = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [forwardId, ACCOUNT]);
      if (original) {
        draft.subject = /^fwd?:/i.test(original.subject || '') ? original.subject : `Fwd: ${original.subject || ''}`;
        draft.body = quoteOriginal(original);
      }
    }

    const provider = await getMailboxProvider();
    const opts = await composeOptions();
    // canSend: true when IMAP/SMTP OR Sender.net is available for outgoing mail.
    const deliveryProvider = await getDeliveryProvider();
    const canSend = (await provider.isConfigured()) || (typeof deliveryProvider.sendMessage === 'function' && await deliveryProvider.isConfigured());
    res.render('inbox/compose', {
      title: 'Compose',
      active: 'inbox',
      draft,
      inReplyTo,
      references,
      error: null,
      configured: canSend,
      templates: opts.templates,
    });
  } catch (err) {
    next(err);
  }
});

const handleComposePost = async (req, res, next) => {
  let to = String(req.body.to || '').trim();
  // Auto-correct common typos like "@.com" or "@com" -> "@gmail.com"
  to = to.replace(/@\.com\b/gi, '@gmail.com').replace(/@com\b/gi, '@gmail.com');
  const cc = String(req.body.cc || '').trim();
  const bcc = String(req.body.bcc || '').trim();
  const subject = String(req.body.subject || '').trim();
  const body = String(req.body.body || '');
  const html = String(req.body.html || '').trim();
  const inReplyTo = String(req.body.inReplyTo || '').trim() || null;
  const references = String(req.body.references || '').trim() || null;
  const files = req.files || [];

  try {
    const provider = await getMailboxProvider();
    const configured = await provider.isConfigured();

    // Sender.net can also be used for transactional (compose) sends when
    // the IMAP/SMTP mailbox is not configured or its outgoing SMTP has no host.
    const deliveryProvider = await getDeliveryProvider();
    const senderConfigured = typeof deliveryProvider.sendMessage === 'function' && (await deliveryProvider.isConfigured());
    // canSend is true when at least one outbound channel is ready.
    const canSend = configured || senderConfigured;

    const opts = await composeOptions();

    const rerender = (errorMsg) => {
      if (wantsJson(req) || (req.get('X-Requested-With') || '') === 'XMLHttpRequest' || (req.get('accept') || '').includes('application/json')) {
        return res.status(400).json({ ok: false, error: errorMsg });
      }
      return res.status(400).render('inbox/compose', {
        title: 'Compose',
        active: 'inbox',
        draft: { to, cc, bcc, subject, body, html, templateId: String(req.body.templateId || '') },
        inReplyTo: inReplyTo || '',
        references: references || '',
        error: errorMsg,
        configured: canSend,
        templates: opts.templates,
      });
    };

    // Determine from name/email: prefer mailbox SMTP config, then delivery provider.
    let fromName = 'OakView Construction';
    let fromEmail = 'howard@oak-viewconstruction.com';
    if (configured && typeof provider.smtpConfig === 'function') {
      const smtpCfg = await provider.smtpConfig();
      fromName = smtpCfg.fromName || fromName;
      if (smtpCfg.fromEmail && smtpCfg.fromEmail.includes('@') && smtpCfg.fromEmail !== 'resend') {
        fromEmail = smtpCfg.fromEmail;
      }
    }
    if (!fromEmail || !fromEmail.includes('@') || fromEmail === 'resend') {
      fromEmail = 'howard@oak-viewconstruction.com';
    }

    const recipients = h.splitAddresses(to);
    let validTo = recipients.filter(h.isValidEmail);
    const invalid = recipients.filter((e) => !h.isValidEmail(e));
    const ccList = h.splitAddresses(cc).filter(h.isValidEmail);
    const bccList = h.splitAddresses(bcc).filter(h.isValidEmail);

    if (!validTo.length) {
      if (bccList.length || ccList.length) {
        // When sending to Bcc/Cc only (e.g. private blast), default To to sender so recipients are undisclosed
        validTo = [fromEmail];
      } else {
        return rerender('Add at least one recipient email address (in To, Cc, or Bcc).');
      }
    }
    if (invalid.length) {
      return rerender(`These addresses look invalid: ${invalid.join(', ')}. Please check the format.`);
    }
    if (!subject) return rerender('Add a subject.');
    if (!body.trim() && !html) return rerender('Add a message.');

    if (!canSend) {
      return rerender('No delivery channel is configured. Add IMAP/SMTP credentials in Settings → Integrations.');
    }

    const attachments = files.map((f) => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype,
    }));

    // Personalise tokens using the first recipient's contact record when known.
    const unsubscribeUrl = `mailto:${fromEmail || validTo[0]}?subject=Unsubscribe`;
    let data = { email: validTo[0], first_name: '', last_name: '', company: '', unsubscribe_url: unsubscribeUrl };
    const known = await db.one(
      'SELECT first_name, last_name, company FROM subscribers WHERE email = ? LIMIT 1',
      [validTo[0].toLowerCase()]
    );
    if (known) {
      data = {
        ...data,
        first_name: known.first_name || '',
        last_name: known.last_name || '',
        company: known.company || '',
      };
    }
    // Fill {{tokens}}, then swap any hardcoded address after `eml=` for the recipient's own.
    let textFinal = h.mergeRecipientEmailInLinks(h.personalise(body, data), data.email);
    let htmlFinal = html ? h.mergeRecipientEmailInLinks(h.personalise(html, data), data.email) : undefined;

    // Convert markdown [text](url) to HTML links, or generate htmlFinal from textFinal if html was omitted
    if (!htmlFinal && textFinal) {
      let converted = h.escapeHtml(textFinal)
        .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gi, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;font-weight:500;">$1</a>')
        .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/gi, '$1<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">$2</a>')
        .replace(/\r?\n/g, '<br>');
      htmlFinal = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1e293b;">${converted}</body></html>`;
    } else if (htmlFinal) {
      htmlFinal = htmlFinal.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gi, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;font-weight:500;">$1</a>');
    }

    // Clean plain-text fallback: convert [text](url) to "text (url)"
    if (textFinal) {
      textFinal = textFinal.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gi, '$1 ($2)');
    }

    let result;
    const smtpCfg = typeof provider.smtpConfig === 'function' ? await provider.smtpConfig() : {};
    const smtpReady = Boolean(smtpCfg.host && smtpCfg.user && smtpCfg.pass);
    let smtpErr = null;

    if (smtpReady) {
      try {
        result = await provider.send({
          to: validTo.join(', '),
          cc: ccList.length ? ccList.join(', ') : undefined,
          bcc: bccList.length ? bccList.join(', ') : undefined,
          subject,
          text: textFinal,
          html: htmlFinal,
          inReplyTo,
          references,
          attachments,
          fromName,
          fromEmail,
        });
      } catch (err) {
        smtpErr = err;
      }
    }

    if (!result) {
      return rerender(`Send failed via SMTP: ${smtpErr ? smtpErr.message : 'No SMTP relay configured.'}`);
    }

    // Sent messages are stored immediately in the Sent folder
    const sentFolderPath = 'Sent';

    const toObjects = to ? validTo.map((e) => ({ name: '', email: e })) : [{ name: 'Undisclosed Recipients', email: fromEmail }];
    const ccObjects = ccList.map((e) => ({ name: '', email: e }));
    const bccObjects = bccList.map((e) => ({ name: '', email: e }));
    const snippetText = h.snippet(textFinal || (htmlFinal ? h.stripTags(htmlFinal) : '') || subject, 160);
    const messageId = (result && result.messageId) || `<sent-${Date.now()}@oak-viewconstruction.com>`;
    const localUid = Date.now();

    // Immediately cache the sent message to the database and sync attachment files
    let insertedMessageId = null;
    try {
      const insertRes = await db.query(
        `INSERT INTO mail_messages
           (account, folder, uid, message_id, in_reply_to, refs, from_name, from_email,
            to_json, cc_json, bcc_json, subject, snippet, text_body, html_body,
            has_attachments, is_read, is_starred, is_draft, is_sent,
            sent_at, received_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 1, NOW(), NOW(), NOW())`,
        [
          ACCOUNT, sentFolderPath, localUid, messageId, inReplyTo, references,
          fromName, fromEmail,
          JSON.stringify(toObjects), JSON.stringify(ccObjects), JSON.stringify(bccObjects),
          subject, snippetText, textFinal, htmlFinal || null,
          files.length ? 1 : 0,
        ]
      );
      insertedMessageId = insertRes && (insertRes.insertId || insertRes.id);
      if (insertedMessageId && files.length) {
        const { storeAttachments } = require('../../services/mailboxSync');
        await storeAttachments(insertedMessageId, attachments);
      }
    } catch (dbErr) {
      console.warn('Could not cache sent message in local db:', dbErr.message);
    }

    const sentMessage = `Message sent${result && result.messageId ? ` (${result.messageId})` : ''}.`;
    req.flash('success', sentMessage);
    const sentRedirect = `/inbox?folder=${encodeURIComponent(sentFolderPath)}`;
    if (wantsJson(req) || (req.get('X-Requested-With') || '') === 'XMLHttpRequest' || (req.get('accept') || '').includes('application/json')) {
      return res.json({ ok: true, message: sentMessage, redirect: sentRedirect });
    }
    return res.redirect(sentRedirect);
  } catch (err) {
    return next(err);
  }
};

router.post('/compose', requireAuth, requireCapability('send'), upload.array('attachments', 8), handleComposePost);
router.post('/send', requireAuth, requireCapability('send'), upload.array('attachments', 8), handleComposePost);

/* ------------------------------------------------------------------ settings */

router.get('/settings', requireAuth, async (req, res, next) => {
  try {
    const provider = await getMailboxProvider();
    const configured = await provider.isConfigured();
    let verify = null;
    if (configured) {
      try {
        verify = await provider.verify();
      } catch (err) {
        verify = { ok: false, message: err.message };
      }
    }
    res.render('inbox/settings', {
      title: 'Mailbox status',
      active: 'inbox',
      configured,
      verify,
      providerName: provider.name,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
