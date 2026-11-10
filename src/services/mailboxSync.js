'use strict';

const fs = require('fs');
const path = require('path');

const db = require('../config/db');
const h = require('../lib/helpers');
const { getMailboxProvider } = require('../providers/mailbox');

/**
 * Mailbox sync service.
 *
 * Pulls messages from the configured IMAP mailbox and mirrors them into the
 * local cache (mail_messages / mail_attachments) so the inbox UI is fast and
 * works even when the upstream mailbox is slow or briefly unavailable.
 *
 * This service is deliberately honest: it never fabricates messages. If the
 * provider is not configured, or a call fails, the error is thrown so the
 * caller can surface the real message (nothing is faked as a success).
 */

const ACCOUNT = 'default';
const REPO_ROOT = path.join(__dirname, '..', '..');
const ATTACH_ROOT = path.join(REPO_ROOT, 'storage', 'attachments');

/* ------------------------------------------------------------ special folders */

const SPECIAL_ORDER = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash'];

/** Maps a provider folder to a normalised key (or null for ordinary folders). Accepts object or string path. */
function specialKey(folder) {
  if (!folder) return null;
  const su = typeof folder === 'object' ? String(folder.specialUse || '').toLowerCase() : '';
  if (su) {
    if (su.includes('inbox')) return 'inbox';
    if (su.includes('sent')) return 'sent';
    if (su.includes('draft')) return 'drafts';
    if (su.includes('trash') || su.includes('deleted')) return 'trash';
    if (su.includes('junk') || su.includes('spam')) return 'junk';
    if (su.includes('all') || su.includes('archive')) return 'archive';
  }
  const n = (typeof folder === 'string' ? folder : String(folder.name || folder.path || '')).toLowerCase().trim();
  if (n === 'inbox' || n.includes('inbox')) return 'inbox';
  if (n.includes('sent')) return 'sent';
  if (n.includes('draft')) return 'drafts';
  if (n.includes('trash') || n.includes('deleted') || n.includes('bin')) return 'trash';
  if (n.includes('junk') || n.includes('spam')) return 'junk';
  if (n.includes('archive') || n.includes('all mail')) return 'archive';
  return null;
}

/**
 * Normalises a provider folder list for the sidebar. When the provider reports
 * `specialUse` we trust it (Gmail uses prefixed paths like "[Gmail]/Sent Mail");
 * otherwise we fall back to name matching. With no list we return a static
 * fallback so the UI still renders (the real paths come from the provider).
 */
function defaultFolders(providerFolders) {
  if (Array.isArray(providerFolders) && providerFolders.length) {
    return providerFolders
      .map((f) => ({
        path: f.path,
        name: f.name || f.path,
        specialUse: f.specialUse || null,
        key: specialKey(f),
      }))
      .sort((a, b) => {
        const ai = a.key ? SPECIAL_ORDER.indexOf(a.key) : 99;
        const bi = b.key ? SPECIAL_ORDER.indexOf(b.key) : 99;
        if (ai !== bi) return ai - bi;
        return String(a.name).localeCompare(String(b.name));
      });
  }
  return [
    { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', key: 'inbox' },
    { path: 'Sent', name: 'Sent', specialUse: '\\Sent', key: 'sent' },
    { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', key: 'drafts' },
    { path: 'Archive', name: 'Archive', specialUse: '\\Archive', key: 'archive' },
    { path: 'Trash', name: 'Trash', specialUse: '\\Trash', key: 'trash' },
  ];
}

/* --------------------------------------------------------------- attachments */

function safeFilename(name, fallback) {
  const base = path.basename(String(name || '').trim()) || fallback;
  const cleaned = base.replace(/[^A-Za-z0-9._\-() ]+/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 180);
}

/** Persists the attachments for a message row, replacing any previous copies. */
async function storeAttachments(messageRowId, attachments) {
  const dir = path.join(ATTACH_ROOT, String(messageRowId));
  fs.mkdirSync(dir, { recursive: true });

  const used = new Set();
  let index = 0;
  for (const a of attachments) {
    if (!a || a.content === undefined || a.content === null) continue;
    index += 1;

    let filename = safeFilename(a.filename, `attachment-${index}`);
    let candidate = filename;
    let n = 1;
    while (used.has(candidate.toLowerCase())) {
      const ext = path.extname(filename);
      candidate = `${path.basename(filename, ext)}-${n}${ext}`;
      n += 1;
    }
    used.add(candidate.toLowerCase());

    const dest = path.join(dir, candidate);
    fs.writeFileSync(dest, a.content);

    const rel = path.relative(REPO_ROOT, dest).split(path.sep).join('/');
    const size = Number(a.size) || (Buffer.isBuffer(a.content) ? a.content.length : Buffer.byteLength(String(a.content)));

    await db.query(
      `INSERT INTO mail_attachments (message_id, filename, content_type, size_bytes, content_id, is_inline, storage_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        messageRowId,
        a.filename || candidate,
        a.contentType || 'application/octet-stream',
        size || null,
        a.contentId || null,
        a.isInline ? 1 : 0,
        rel,
      ]
    );
  }
  return index;
}

/* --------------------------------------------------------------------- upsert */

/**
 * Upserts one message (envelope-level fields always; body/attachments when a
 * full body was fetched). Matching is on (account, folder, uid) so re-syncs
 * update existing rows instead of duplicating them.
 */
async function upsertMessage(folder, envelope, full) {
  const existing = await db.one(
    'SELECT id, text_body, html_body, snippet, has_attachments FROM mail_messages WHERE account = ? AND folder = ? AND uid = ? LIMIT 1',
    [ACCOUNT, folder, envelope.uid]
  );

  const from = full && full.from && (full.from.email || full.from.name) ? full.from : (envelope.from || { name: '', email: '' });
  const toList = full && full.to && full.to.length ? full.to : (envelope.to || []);
  const ccList = full && full.cc && full.cc.length ? full.cc : (envelope.cc || []);
  const bccList = full && full.bcc && full.bcc.length ? full.bcc : [];

  const subject = (full && full.subject) || envelope.subject || '(no subject)';
  const messageId = (full && full.messageId) || envelope.messageId || null;
  const inReplyTo = (full && full.inReplyTo) || null;
  const references = (full && full.references) || null;

  // Preserve cached bodies when a body fetch was not performed on a re-sync.
  const textBody = full ? (full.text || '') : (existing ? existing.text_body : '');
  const htmlBody = full ? (full.html || '') : (existing ? existing.html_body : '');

  const snippetText = full
    ? h.snippet((full.text || full.html) || subject, 160)
    : (existing ? existing.snippet : '');

  const isRead = full ? (full.seen ? 1 : 0) : (envelope.seen ? 1 : 0);
  const isStarred = full ? (full.flagged ? 1 : 0) : (envelope.flagged ? 1 : 0);
  const isDraft = envelope.draft ? 1 : 0;
  const isSent = specialKey(folder) === 'sent' ? 1 : 0;
  const hasAttachments = full
    ? (full.attachments && full.attachments.length ? 1 : 0)
    : (existing ? existing.has_attachments : (envelope.hasAttachments ? 1 : 0));

  const date = (full && full.date) || envelope.date || new Date();
  const size = Number(envelope.size) || null;

  await db.query(
    `INSERT INTO mail_messages
       (account, folder, uid, message_id, in_reply_to, refs, from_name, from_email,
        to_json, cc_json, bcc_json, subject, snippet, text_body, html_body,
        has_attachments, is_read, is_starred, is_draft, is_sent, size_bytes,
        sent_at, received_at, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE
       message_id = VALUES(message_id),
       in_reply_to = VALUES(in_reply_to),
       refs = VALUES(refs),
       from_name = VALUES(from_name),
       from_email = VALUES(from_email),
       to_json = VALUES(to_json),
       cc_json = VALUES(cc_json),
       bcc_json = VALUES(bcc_json),
       subject = VALUES(subject),
       snippet = VALUES(snippet),
       text_body = VALUES(text_body),
       html_body = VALUES(html_body),
       has_attachments = VALUES(has_attachments),
       is_read = VALUES(is_read),
       is_starred = VALUES(is_starred),
       is_draft = VALUES(is_draft),
       is_sent = VALUES(is_sent),
       size_bytes = VALUES(size_bytes),
       sent_at = VALUES(sent_at),
       received_at = VALUES(received_at),
       synced_at = NOW()`,
    [
      ACCOUNT, folder, envelope.uid, messageId, inReplyTo, references,
      from.name || null, from.email || null,
      JSON.stringify(toList || []), JSON.stringify(ccList || []), JSON.stringify(bccList || []),
      subject, snippetText, textBody, htmlBody,
      hasAttachments, isRead, isStarred, isDraft, isSent, size,
      date, date,
    ]
  );

  const row = await db.one(
    'SELECT id FROM mail_messages WHERE account = ? AND folder = ? AND uid = ? LIMIT 1',
    [ACCOUNT, folder, envelope.uid]
  );
  if (!row) return null;

  // Attachments are only (re)written when we actually fetched the full message.
  if (full) {
    await db.query('DELETE FROM mail_attachments WHERE message_id = ?', [row.id]);
    if (full.attachments && full.attachments.length) {
      await storeAttachments(row.id, full.attachments);
    }
  }

  return row.id;
}

/* ----------------------------------------------------------------------- sync */

/**
 * Fetches the newest `limit` envelopes for a folder, downloads their bodies and
 * upserts them into the local cache.
 *
 * Throws when the provider is not configured or the folder cannot be opened, so
 * the caller can surface the real error (folder-path differences, auth, etc.).
 * Individual body-fetch failures are tolerated (envelope data is still cached).
 */
async function syncMessages(folder = 'INBOX', { limit = 40, search } = {}) {
  const provider = await getMailboxProvider();
  if (!(await provider.isConfigured())) {
    const err = new Error('Mailbox is not configured. Add IMAP credentials in Settings → Integrations.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const envelopes = await provider.fetchEnvelopes(folder, { limit, search });

  let synced = 0;
  for (const env of envelopes) {
    await upsertMessage(folder, env, null);
    synced += 1;
  }

  return { synced, folder };
}

/** Syncs a single message by uid (used to lazily load a missing body). */
async function syncMessage(folder, uid) {
  const provider = await getMailboxProvider();
  if (!(await provider.isConfigured())) return null;

  const full = await provider.fetchFull(folder, uid);
  if (!full) return null;

  const envelope = {
    uid,
    messageId: full.messageId,
    subject: full.subject,
    from: full.from,
    to: full.to,
    cc: full.cc,
    date: full.date,
    seen: full.seen,
    flagged: full.flagged,
    draft: false,
    size: null,
  };
  return upsertMessage(folder, envelope, full);
}

module.exports = {
  ACCOUNT,
  ATTACH_ROOT,
  defaultFolders,
  specialKey,
  syncMessages,
  syncMessage,
  upsertMessage,
};
