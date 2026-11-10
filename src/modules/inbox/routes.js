'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const db = require('../../config/db');
const h = require('../../lib/helpers');
const { requireAuth, requireCapability } = require('../../middleware/auth');
const { getMailboxProvider } = require('../../providers/mailbox');
const { defaultFolders, syncMessages, syncMessage, ACCOUNT } = require('../../services/mailboxSync');

const router = express.Router();

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 8 } });

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
  let sql = `SELECT id, uid, folder, subject, from_name, from_email, snippet,
                    is_read, is_starred, has_attachments, received_at, sent_at, synced_at
               FROM mail_messages
              WHERE account = ? AND folder = ?`;
  const params = [ACCOUNT, folder];
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
    const configured = await provider.isConfigured();

    // Folder sidebar: prefer the real provider list, else a static fallback.
    let folders = defaultFolders();
    let error = null;
    if (configured) {
      try {
        folders = defaultFolders(await provider.listFolders());
      } catch (err) {
        error = `Could not list folders: ${err.message}`;
      }
    }

    let messages = await readCachedMessages(folder, q);

    // Empty cache for this folder → attempt a sync, then re-read.
    if (!messages.length && configured) {
      try {
        await syncMessages(folder, { limit: 40, search: q || undefined });
        messages = await readCachedMessages(folder, q);
      } catch (err) {
        error = `Sync failed: ${err.message}`;
      }
    }

    // Reading pane.
    let selected = null;
    let attachments = [];
    if (selectedId) {
      selected = await db.one('SELECT * FROM mail_messages WHERE id = ? AND account = ?', [selectedId, ACCOUNT]);
      if (selected) {
        const msgFolder = selected.folder || folder;
        if (!selected.text_body && !selected.html_body && configured) {
          try {
            await syncMessage(msgFolder, selected.uid);
            selected = await db.one('SELECT * FROM mail_messages WHERE id = ?', [selectedId]);
          } catch (err) {
            error = `Could not load message body: ${err.message}`;
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
  try {
    const result = await syncMessages(folder, { limit: 40, search: q || undefined });
    req.flash('success', `Synced ${result.synced} message${result.synced === 1 ? '' : 's'} from ${folder}.`);
  } catch (err) {
    req.flash('error', `Sync failed: ${err.message}`);
  }
  const params = new URLSearchParams({ folder });
  if (q) params.set('q', q);
  res.redirect(`/inbox?${params.toString()}`);
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
    res.render('inbox/compose', {
      title: 'Compose',
      active: 'inbox',
      draft,
      inReplyTo,
      references,
      error: null,
      configured: await provider.isConfigured(),
      templates: opts.templates,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/compose', requireAuth, requireCapability('send'), upload.array('attachments', 8), async (req, res, next) => {
  const to = String(req.body.to || '').trim();
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
    const opts = await composeOptions();

    const rerender = (errorMsg) =>
      res.status(400).render('inbox/compose', {
        title: 'Compose',
        active: 'inbox',
        draft: { to, cc, bcc, subject, body, html, templateId: String(req.body.templateId || '') },
        inReplyTo: inReplyTo || '',
        references: references || '',
        error: errorMsg,
        configured,
        templates: opts.templates,
      });

    const recipients = h.splitAddresses(to);
    const validTo = recipients.filter(h.isValidEmail);
    const invalid = recipients.filter((e) => !h.isValidEmail(e));
    if (!validTo.length) return rerender('Add at least one valid recipient.');
    if (invalid.length) return rerender(`These addresses look invalid: ${invalid.join(', ')}.`);
    if (!subject) return rerender('Add a subject.');
    if (!body.trim() && !html) return rerender('Add a message.');

    if (!configured) {
      return rerender('Mailbox is not configured, so nothing was sent. Add IMAP/SMTP credentials in Settings → Integrations.');
    }

    const ccList = h.splitAddresses(cc).filter(h.isValidEmail);
    const bccList = h.splitAddresses(bcc).filter(h.isValidEmail);
    const attachments = files.map((f) => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype,
    }));

    // Personalise tokens using the first recipient's contact record when known.
    const sender = typeof provider.smtpConfig === 'function' ? await provider.smtpConfig() : {};
    const unsubscribeUrl = `mailto:${sender.fromEmail || sender.user || validTo[0]}?subject=Unsubscribe`;
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
    const textFinal = h.mergeRecipientEmailInLinks(h.personalise(body, data), data.email);
    const htmlFinal = html ? h.mergeRecipientEmailInLinks(h.personalise(html, data), data.email) : undefined;

    let result;
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
      });
    } catch (err) {
      return rerender(`Send failed: ${err.message}`);
    }

    // Best-effort: keep a copy in the Sent folder and show it immediately. The
    // Sent folder is only re-synced when its cache is empty, so without caching
    // the appended copy here a freshly sent message stays invisible until a
    // manual Sync.
    try {
      const folders = defaultFolders(await provider.listFolders());
      const sent = folders.find((f) => f.key === 'sent');
      if (sent) {
        const from = typeof provider.smtpConfig === 'function' ? await provider.smtpConfig() : {};
        const raw = provider.buildRaw({
          to: validTo.join(', '),
          cc: ccList.length ? ccList.join(', ') : undefined,
          subject,
          text: textFinal,
          html: htmlFinal,
          fromName: from.fromName,
          fromEmail: from.fromEmail || from.user,
        });
        const appended = await provider.append(sent.path, raw, ['\\Seen']);
        const uid = appended && appended.uid ? appended.uid : null;
        if (uid) {
          try {
            await syncMessage(sent.path, uid);
          } catch (_) { /* the copy is on the server; it appears on the next sync */ }
        }
      }
    } catch (_) { /* non-fatal — the message was still sent */ }

    const sentMessage = `Message sent${result && result.messageId ? ` (${result.messageId})` : ''}.`;
    req.flash('success', sentMessage);
    if ((req.get('X-Requested-With') || '') === 'XMLHttpRequest') {
      return res.json({ ok: true, message: sentMessage, redirect: '/inbox' });
    }
    return res.redirect('/inbox');
  } catch (err) {
    return next(err);
  }
});

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
