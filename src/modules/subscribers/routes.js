'use strict';

const express = require('express');
const multer = require('multer');

const db = require('../../config/db');
const h = require('../../lib/helpers');
const { requireAuth, requireCapability } = require('../../middleware/auth');

/**
 * Subscribers (contacts) module.
 *
 * Everything lives in a few tables defined by db/schema.sql:
 *   subscribers, lists, list_subscribers, segments, suppressions
 * Keeping the SQL here straight keeps the audience model honest: a subscriber
 * is a unique email, lists organise them many-to-many, and the suppression
 * list is the single source of truth for "never email this address again".
 */

const router = express.Router();

const SUBSCRIBER_STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained', 'pending'];
const PER_PAGE = 25;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — plenty for a contact CSV
});

/* ------------------------------------------------------------------ utils */

function str(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toIntArray(value) {
  const arr = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return arr.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0);
}

function placeholders(rows, cols) {
  return new Array(rows).fill(`(${new Array(cols).fill('?').join(',')})`).join(',');
}

/** Shared WHERE builder for the list + export pages. */
function buildFilters(query) {
  const q = str(query.q);
  const status = SUBSCRIBER_STATUSES.includes(query.status) ? query.status : '';
  const listId = parseInt(query.list_id, 10) || 0;

  const where = [];
  const params = [];
  if (q) {
    where.push('(s.email LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR s.company LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status) {
    where.push('s.status = ?');
    params.push(status);
  }
  if (listId) {
    where.push('EXISTS (SELECT 1 FROM list_subscribers ls WHERE ls.subscriber_id = s.id AND ls.list_id = ?)');
    params.push(listId);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function filterQueryString(query) {
  const parts = [];
  if (str(query.q)) parts.push(`q=${encodeURIComponent(str(query.q))}`);
  if (SUBSCRIBER_STATUSES.includes(query.status)) parts.push(`status=${encodeURIComponent(query.status)}`);
  const listId = parseInt(query.list_id, 10) || 0;
  if (listId) parts.push(`list_id=${listId}`);
  return parts.join('&');
}

function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------ CSV/TSV parsing */

function detectDelimiter(text) {
  const firstLine = (text.split(/\r?\n/).find((line) => line.trim().length) || '');
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t']) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/** RFC-4180-ish parser: handles quotes, escaped quotes, CRLF, any delimiter. */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const HEADER_MATCHERS = {
  email: /^(e-?mail|e-?mail address|email_address|e_mail)$/,
  first_name: /^(first ?name|firstname|given name|first)$/,
  last_name: /^(last ?name|lastname|surname|family name|last)$/,
  company: /^(company|company name|organisation|organization|org|employer)$/,
  phone: /^(phone|phone number|mobile|tel|telephone|cell)$/,
};

function mapColumns(rows) {
  const first = rows[0].map((c) => String(c === undefined || c === null ? '' : c).trim().toLowerCase());
  const headerHasEmail = first.some((c) => HEADER_MATCHERS.email.test(c));
  const firstHasEmail = first.some((c) => h.isValidEmail(c));

  // Header row when it names an email column; otherwise data starts on row 1.
  const hasHeader = headerHasEmail || (!firstHasEmail && !HEADER_MATCHERS.email.test(first[0] || ''));
  const cols = { email: 0, first_name: -1, last_name: -1, company: -1, phone: -1 };

  if (hasHeader) {
    first.forEach((cell, i) => {
      Object.keys(HEADER_MATCHERS).forEach((key) => {
        if (cols[key] === -1 && HEADER_MATCHERS[key].test(cell)) cols[key] = i;
      });
    });
  }
  // "Require an email column (by header name, else assume first column)."
  if (cols.email < 0) cols.email = 0;

  return { hasHeader, dataStart: hasHeader ? 1 : 0, cols };
}

/* ============================================================ contacts list */

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = [25, 50, 100, 250, 500].includes(parseInt(req.query.per_page, 10))
      ? parseInt(req.query.per_page, 10)
      : PER_PAGE;
    const { whereSql, params } = buildFilters(req.query);

    const [counts, suppressed, lists, totalRow] = await Promise.all([
      db.one(`SELECT COUNT(*) AS total,
                     SUM(status = 'subscribed') AS subscribed,
                     SUM(status = 'unsubscribed') AS unsubscribed,
                     SUM(status = 'bounced') AS bounced,
                     SUM(status = 'pending') AS pending
                FROM subscribers`),
      db.one('SELECT COUNT(*) AS c FROM suppressions'),
      db.query('SELECT id, name FROM lists ORDER BY name ASC'),
      db.one(`SELECT COUNT(*) AS c FROM subscribers s ${whereSql}`, params),
    ]);

    const pg = h.paginate(totalRow ? totalRow.c : 0, page, perPage);

    const rows = await db.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM list_subscribers ls WHERE ls.subscriber_id = s.id) AS list_count
         FROM subscribers s
         ${whereSql}
         ORDER BY s.created_at DESC
         LIMIT ${pg.perPage} OFFSET ${pg.offset}`,
      params
    );

    res.render('subscribers/index', {
      title: 'Contacts',
      active: 'contacts',
      rows,
      pg,
      q: str(req.query.q),
      status: SUBSCRIBER_STATUSES.includes(req.query.status) ? req.query.status : '',
      listId: parseInt(req.query.list_id, 10) || 0,
      lists,
      counts: counts || { total: 0, subscribed: 0, unsubscribed: 0, bounced: 0, pending: 0 },
      suppressed: suppressed ? suppressed.c : 0,
      exportQuery: filterQueryString(req.query),
      statuses: SUBSCRIBER_STATUSES,
      perPage,
    });
  } catch (err) {
    return next(err);
  }
});

/* -------------------------------------------------------------- add new */

router.get('/new', requireAuth, async (req, res, next) => {
  try {
    const lists = await db.query('SELECT id, name FROM lists ORDER BY name ASC');
    res.render('subscribers/form', {
      title: 'Add subscriber',
      active: 'contacts',
      mode: 'create',
      sub: null,
      lists,
      selectedLists: [],
      statuses: SUBSCRIBER_STATUSES,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const email = str(req.body.email).toLowerCase();
  if (!h.isValidEmail(email)) {
    req.flash('error', 'Enter a valid email address.');
    return res.redirect('/contacts/new');
  }

  const first_name = str(req.body.first_name).slice(0, 120) || null;
  const last_name = str(req.body.last_name).slice(0, 120) || null;
  const company = str(req.body.company).slice(0, 190) || null;
  const phone = str(req.body.phone).slice(0, 60) || null;
  const status = SUBSCRIBER_STATUSES.includes(req.body.status) ? req.body.status : 'subscribed';
  const listIds = toIntArray(req.body.list_ids);

  try {
    const existing = await db.one('SELECT id FROM subscribers WHERE email = ? LIMIT 1', [email]);
    let id;

    if (existing) {
      id = existing.id;
      // Upsert-safe: fill in any blanks without clobbering existing data.
      await db.query(
        `UPDATE subscribers
            SET first_name = COALESCE(NULLIF(?, ''), first_name),
                last_name  = COALESCE(NULLIF(?, ''), last_name),
                company    = COALESCE(NULLIF(?, ''), company),
                phone      = COALESCE(NULLIF(?, ''), phone)
          WHERE id = ?`,
        [first_name || '', last_name || '', company || '', phone || '', id]
      );
      req.flash('success', `${email} already existed — details updated.`);
    } else {
      const result = await db.query(
        `INSERT INTO subscribers (email, first_name, last_name, company, phone, status, source)
         VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
        [email, first_name, last_name, company, phone, status]
      );
      id = result.insertId;
      req.flash('success', `Added ${email}.`);
    }

    for (const listId of listIds) {
      await db.query('INSERT IGNORE INTO list_subscribers (list_id, subscriber_id) VALUES (?, ?)', [listId, id]);
    }

    return res.redirect(`/contacts/${id}`);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- import */

router.get('/import', requireAuth, async (req, res, next) => {
  try {
    const lists = await db.query('SELECT id, name FROM lists ORDER BY name ASC');
    res.render('subscribers/import', {
      title: 'Import subscribers',
      active: 'contacts',
      lists,
      listId: parseInt(req.query.list_id, 10) || 0,
      result: null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/import', requireAuth, requireCapability('edit'), upload.single('file'), async (req, res, next) => {
  try {
    const lists = await db.query('SELECT id, name FROM lists ORDER BY name ASC');
    let listId = parseInt(req.body.list_id, 10) || 0;
    if (listId && !(await db.one('SELECT id FROM lists WHERE id = ? LIMIT 1', [listId]))) listId = 0;

    const renderPage = (result) => res.render('subscribers/import', {
      title: 'Import subscribers',
      active: 'contacts',
      lists,
      listId,
      result,
    });

    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      req.flash('error', 'Choose a CSV or TXT file to upload.');
      return res.redirect('/contacts/import');
    }

    const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const delimiter = detectDelimiter(text);
    const parsed = parseDelimited(text, delimiter);
    if (!parsed.length) {
      req.flash('error', 'That file appears to be empty.');
      return res.redirect('/contacts/import');
    }

    const mapping = mapColumns(parsed);
    const dataRows = parsed.slice(mapping.dataStart);
    const emailIdx = mapping.cols.email;

    // Dedupe against what we already know before touching the database.
    const existingRows = await db.query('SELECT email FROM subscribers');
    const existingEmails = new Set(existingRows.map((r) => String(r.email).toLowerCase()));
    const suppressionRows = await db.query('SELECT email FROM suppressions');
    const suppressedEmails = new Set(suppressionRows.map((r) => String(r.email).toLowerCase()));

    const seen = new Set();
    const toInsert = [];
    let duplicates = 0;
    let invalid = 0;
    let suppressed = 0;

    const pick = (row, idx) => (idx >= 0 && row[idx] !== undefined && row[idx] !== null ? str(row[idx]) : '');

    for (const row of dataRows) {
      const email = str(row[emailIdx]).toLowerCase();
      if (!h.isValidEmail(email)) { invalid += 1; continue; }
      if (seen.has(email)) { duplicates += 1; continue; }
      seen.add(email);
      if (suppressedEmails.has(email)) { suppressed += 1; continue; }
      if (existingEmails.has(email)) { duplicates += 1; continue; }

      toInsert.push({
        email,
        first_name: pick(row, mapping.cols.first_name).slice(0, 120) || null,
        last_name: pick(row, mapping.cols.last_name).slice(0, 120) || null,
        company: pick(row, mapping.cols.company).slice(0, 190) || null,
        phone: pick(row, mapping.cols.phone).slice(0, 60) || null,
      });
    }

    // Insert in multi-row batches, then attach the newcomers to the chosen list.
    const CHUNK = 500;
    let imported = 0;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const params = [];
      chunk.forEach((s) => params.push(s.email, s.first_name, s.last_name, s.company, s.phone, 'subscribed', 'import'));
      const result = await db.query(
        `INSERT IGNORE INTO subscribers (email, first_name, last_name, company, phone, status, source)
         VALUES ${placeholders(chunk.length, 7)}`,
        params
      );
      imported += result.affectedRows || 0;

      if (listId) {
        const emails = chunk.map((s) => s.email);
        const idRows = await db.query(
          `SELECT id FROM subscribers WHERE email IN (${emails.map(() => '?').join(',')})`,
          emails
        );
        if (idRows.length) {
          const lsParams = [];
          idRows.forEach((r) => lsParams.push(listId, r.id));
          await db.query(
            `INSERT IGNORE INTO list_subscribers (list_id, subscriber_id) VALUES ${placeholders(idRows.length, 2)}`,
            lsParams
          );
        }
      }
    }

    return renderPage({
      fileName: req.file.originalname || 'upload',
      delimiter: delimiter === '\t' ? 'tab' : delimiter,
      mapped: {
        email: mapping.cols.email + 1,
        first_name: mapping.cols.first_name >= 0 ? mapping.cols.first_name + 1 : null,
        last_name: mapping.cols.last_name >= 0 ? mapping.cols.last_name + 1 : null,
        company: mapping.cols.company >= 0 ? mapping.cols.company + 1 : null,
        phone: mapping.cols.phone >= 0 ? mapping.cols.phone + 1 : null,
      },
      hasHeader: mapping.hasHeader,
      totalRows: dataRows.length,
      imported,
      duplicates,
      invalid,
      suppressed,
      listId,
      listName: listId ? (lists.find((l) => l.id === listId) || {}).name : null,
    });
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- export */

router.get('/export', requireAuth, async (req, res, next) => {
  try {
    const { whereSql, params } = buildFilters(req.query);
    const rows = await db.query(
      `SELECT s.email, s.first_name, s.last_name, s.company, s.phone, s.status, s.source, s.created_at
         FROM subscribers s
         ${whereSql}
         ORDER BY s.created_at DESC`,
      params
    );

    const columns = ['email', 'first_name', 'last_name', 'company', 'phone', 'status', 'source', 'created_at'];
    const stamp = new Date().toISOString().slice(0, 10);

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contacts-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.write(`\uFEFF${columns.join(',')}\r\n`);
    for (const row of rows) {
      res.write(`${columns.map((c) => csvCell(row[c])).join(',')}\r\n`);
    }
    return res.end();
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------ bulk action */

router.post('/bulk', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const ids = toIntArray(req.body.ids);
  const action = str(req.body.action);
  const allMatching = req.body.all_matching === '1' || action === 'delete_all' || action === 'suppress_all';

  if (!ids.length && !allMatching) {
    req.flash('error', 'Select at least one contact first, or choose an "all matching" action.');
    return res.redirect('/contacts');
  }

  try {
    if (allMatching) {
      // Resolve all matching contacts across the entire database matching current view/filters
      const { whereSql, params } = buildFilters(req.body);
      const rows = await db.query(
        `SELECT s.id, s.email FROM subscribers s ${whereSql}`,
        params
      );

      if (!rows.length) {
        req.flash('info', 'No matching contacts found to process.');
        return res.redirect('/contacts');
      }

      const matchIds = rows.map((r) => r.id);
      const CHUNK = 500;

      if (action === 'delete' || action === 'delete_all') {
        for (let i = 0; i < matchIds.length; i += CHUNK) {
          const chunk = matchIds.slice(i, i + CHUNK);
          const inList = chunk.map(() => '?').join(',');
          await db.query(`DELETE FROM subscribers WHERE id IN (${inList})`, chunk);
        }
        req.flash('success', `Deleted all ${matchIds.length} contact(s).`);
      } else if (action === 'suppress' || action === 'suppress_all') {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const suppParams = [];
          chunk.forEach((r) => suppParams.push(r.email, 'manual', 'bulk action'));
          await db.query(
            `INSERT INTO suppressions (email, reason, detail) VALUES ${new Array(chunk.length).fill('(?, ?, ?)').join(',')}
             ON DUPLICATE KEY UPDATE reason = reason`,
            suppParams
          );
          const chunkIds = chunk.map((r) => r.id);
          const inList = chunkIds.map(() => '?').join(',');
          await db.query(`UPDATE subscribers SET status = 'unsubscribed' WHERE id IN (${inList})`, chunkIds);
        }
        req.flash('success', `Suppressed all ${rows.length} contact(s).`);
      } else {
        req.flash('error', 'Choose a valid bulk action.');
      }
    } else {
      // Process selected IDs from the current page
      const inList = ids.map(() => '?').join(',');
      if (action === 'delete') {
        await db.query(`DELETE FROM subscribers WHERE id IN (${inList})`, ids);
        req.flash('success', `Deleted ${ids.length} contact(s).`);
      } else if (action === 'suppress') {
        const rows = await db.query(`SELECT email FROM subscribers WHERE id IN (${inList})`, ids);
        if (rows.length) {
          const params = [];
          rows.forEach((r) => params.push(r.email, 'manual', 'bulk action'));
          await db.query(
            `INSERT INTO suppressions (email, reason, detail) VALUES ${new Array(rows.length).fill('(?, ?, ?)').join(',')}
             ON DUPLICATE KEY UPDATE reason = reason`,
            params
          );
        }
        await db.query(`UPDATE subscribers SET status = 'unsubscribed' WHERE id IN (${inList})`, ids);
        req.flash('success', `Suppressed ${ids.length} contact(s).`);
      } else {
        req.flash('error', 'Choose a bulk action.');
      }
    }
    return res.redirect('/contacts');
  } catch (err) {
    return next(err);
  }
});

/* --------------------------------------------------------- single record */

router.get('/:id', requireAuth, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();

  try {
    const sub = await db.one('SELECT * FROM subscribers WHERE id = ? LIMIT 1', [id]);
    if (!sub) {
      req.flash('error', 'That contact no longer exists.');
      return res.redirect('/contacts');
    }

    const [lists, activity, suppressed] = await Promise.all([
      db.query(
        `SELECT l.id, l.name, ls.added_at
           FROM list_subscribers ls
           JOIN lists l ON l.id = ls.list_id
          WHERE ls.subscriber_id = ?
          ORDER BY l.name ASC`,
        [id]
      ),
      db.query(
        `SELECT cr.status, cr.queued_at, cr.sent_at, cr.opened_at, cr.clicked_at,
                c.id AS campaign_id, c.name AS campaign_name, c.subject AS campaign_subject
           FROM campaign_recipients cr
           JOIN campaigns c ON c.id = cr.campaign_id
          WHERE cr.subscriber_id = ? OR cr.email = ?
          ORDER BY cr.queued_at DESC
          LIMIT 20`,
        [id, sub.email]
      ),
      db.one('SELECT id, reason, detail, created_at FROM suppressions WHERE email = ? LIMIT 1', [sub.email]),
    ]);

    return res.render('subscribers/show', {
      title: sub.email,
      active: 'contacts',
      sub,
      lists,
      activity,
      suppressed,
      statuses: SUBSCRIBER_STATUSES,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/edit', requireAuth, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();

  try {
    const sub = await db.one('SELECT * FROM subscribers WHERE id = ? LIMIT 1', [id]);
    if (!sub) {
      req.flash('error', 'That contact no longer exists.');
      return res.redirect('/contacts');
    }
    const [lists, membership] = await Promise.all([
      db.query('SELECT id, name FROM lists ORDER BY name ASC'),
      db.query('SELECT list_id FROM list_subscribers WHERE subscriber_id = ?', [id]),
    ]);

    return res.render('subscribers/form', {
      title: `Edit ${sub.email}`,
      active: 'contacts',
      mode: 'edit',
      sub,
      lists,
      selectedLists: membership.map((m) => m.list_id),
      statuses: SUBSCRIBER_STATUSES,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();

  const email = str(req.body.email).toLowerCase();
  if (!h.isValidEmail(email)) {
    req.flash('error', 'Enter a valid email address.');
    return res.redirect(`/contacts/${id}/edit`);
  }

  const first_name = str(req.body.first_name).slice(0, 120) || null;
  const last_name = str(req.body.last_name).slice(0, 120) || null;
  const company = str(req.body.company).slice(0, 190) || null;
  const phone = str(req.body.phone).slice(0, 60) || null;
  const status = SUBSCRIBER_STATUSES.includes(req.body.status) ? req.body.status : 'subscribed';
  const listIds = toIntArray(req.body.list_ids);

  try {
    const sub = await db.one('SELECT id FROM subscribers WHERE id = ? LIMIT 1', [id]);
    if (!sub) {
      req.flash('error', 'That contact no longer exists.');
      return res.redirect('/contacts');
    }

    const clash = await db.one('SELECT id FROM subscribers WHERE email = ? AND id <> ? LIMIT 1', [email, id]);
    if (clash) {
      req.flash('error', 'Another contact already uses that email address.');
      return res.redirect(`/contacts/${id}/edit`);
    }

    await db.query(
      `UPDATE subscribers
          SET email = ?, first_name = ?, last_name = ?, company = ?, phone = ?, status = ?
        WHERE id = ?`,
      [email, first_name, last_name, company, phone, status, id]
    );

    // Sync list membership: replace the set with the submitted set.
    await db.query('DELETE FROM list_subscribers WHERE subscriber_id = ?', [id]);
    for (const listId of listIds) {
      await db.query('INSERT IGNORE INTO list_subscribers (list_id, subscriber_id) VALUES (?, ?)', [listId, id]);
    }

    req.flash('success', 'Contact updated.');
    return res.redirect(`/contacts/${id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/delete', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();
  try {
    await db.query('DELETE FROM subscribers WHERE id = ?', [id]);
    req.flash('success', 'Contact deleted.');
    return res.redirect('/contacts');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/suppress', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();
  try {
    const sub = await db.one('SELECT email FROM subscribers WHERE id = ? LIMIT 1', [id]);
    if (!sub) {
      req.flash('error', 'That contact no longer exists.');
      return res.redirect('/contacts');
    }
    await db.query(
      `INSERT INTO suppressions (email, reason, detail) VALUES (?, 'manual', ?)
       ON DUPLICATE KEY UPDATE reason = reason`,
      [sub.email, 'added from contact record']
    );
    await db.query("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?", [id]);
    req.flash('success', `${sub.email} was added to the suppression list.`);
    return res.redirect(`/contacts/${id}`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
