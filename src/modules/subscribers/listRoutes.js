'use strict';

const express = require('express');

const db = require('../../config/db');
const h = require('../../lib/helpers');
const { requireAuth, requireCapability } = require('../../middleware/auth');

/**
 * Lists, segments and suppressions.
 *
 * Lists are the many-to-many grouping of subscribers; segments are saved,
 * named rule-sets stored as JSON; suppressions are the do-not-mail registry
 * shared across every campaign.
 */

const router = express.Router();

const PER_PAGE = 25;
const SUBSCRIBER_STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained', 'pending'];
const SUPPRESSION_REASONS = ['unsubscribe', 'bounce', 'complaint', 'manual'];

function str(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseRules(rules) {
  if (!rules) return {};
  if (typeof rules === 'string') {
    try { return JSON.parse(rules); } catch (_) { return {}; }
  }
  return rules;
}

function ruleSummary(rules, listNames) {
  const parts = [];
  if (rules.status) parts.push(`status: ${rules.status}`);
  if (rules.list_id) parts.push(`in list: ${listNames.get(Number(rules.list_id)) || `#${rules.list_id}`}`);
  if (rules.has_opened) parts.push('has opened a campaign');
  if (rules.has_clicked) parts.push('has clicked a link');
  return parts.length ? parts.join(' · ') : 'every subscriber';
}

/* ------------------------------------------------------------- overview */

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [lists, segments] = await Promise.all([
      db.query(
        `SELECT l.*,
                (SELECT COUNT(*) FROM list_subscribers ls WHERE ls.list_id = l.id) AS subscriber_count
           FROM lists l
          ORDER BY l.name ASC`
      ),
      db.query('SELECT * FROM segments ORDER BY created_at DESC'),
    ]);

    const listNames = new Map(lists.map((l) => [Number(l.id), l.name]));
    const segmentViews = segments.map((s) => {
      const rules = parseRules(s.rules);
      return { ...s, rules, summary: ruleSummary(rules, listNames) };
    });

    return res.render('subscribers/lists', {
      title: 'Lists & segments',
      active: 'lists',
      lists,
      segments: segmentViews,
      statuses: SUBSCRIBER_STATUSES,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const name = str(req.body.name).slice(0, 190);
  const description = str(req.body.description).slice(0, 2000) || null;
  if (!name) {
    req.flash('error', 'Give the list a name.');
    return res.redirect('/lists');
  }
  try {
    await db.query('INSERT INTO lists (name, description) VALUES (?, ?)', [name, description]);
    req.flash('success', `Created list “${name}”.`);
    return res.redirect('/lists');
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'A list with that name already exists.');
      return res.redirect('/lists');
    }
    return next(err);
  }
});

/* ----------------------------------------------------------- suppression */

router.get('/suppressions', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const totalRow = await db.one('SELECT COUNT(*) AS c FROM suppressions');
    const pg = h.paginate(totalRow ? totalRow.c : 0, page, PER_PAGE);

    const [rows, counts] = await Promise.all([
      db.query(
        `SELECT * FROM suppressions ORDER BY created_at DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`
      ),
      db.one(
        `SELECT SUM(reason = 'unsubscribe') AS unsubscribe,
                SUM(reason = 'bounce') AS bounce,
                SUM(reason = 'complaint') AS complaint,
                SUM(reason = 'manual') AS manual
           FROM suppressions`
      ),
    ]);

    return res.render('subscribers/suppressions', {
      title: 'Suppressions',
      active: 'lists',
      rows,
      pg,
      counts: counts || { unsubscribe: 0, bounce: 0, complaint: 0, manual: 0 },
      reasons: SUPPRESSION_REASONS,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/suppressions', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const email = str(req.body.email).toLowerCase();
  const reason = SUPPRESSION_REASONS.includes(req.body.reason) ? req.body.reason : 'manual';
  const detail = str(req.body.detail).slice(0, 255) || null;

  if (!h.isValidEmail(email)) {
    req.flash('error', 'Enter a valid email address to suppress.');
    return res.redirect('/lists/suppressions');
  }

  try {
    await db.query(
      `INSERT INTO suppressions (email, reason, detail) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), detail = VALUES(detail)`,
      [email, reason, detail]
    );
    await db.query("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ? AND status <> 'unsubscribed'", [email]);
    req.flash('success', `${email} is now suppressed.`);
    return res.redirect('/lists/suppressions');
  } catch (err) {
    return next(err);
  }
});

router.post('/suppressions/:id/delete', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();
  try {
    await db.query('DELETE FROM suppressions WHERE id = ?', [id]);
    req.flash('success', 'Suppression removed.');
    return res.redirect('/lists/suppressions');
  } catch (err) {
    return next(err);
  }
});

/* -------------------------------------------------------------- segments */

router.post('/segments', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const name = str(req.body.name).slice(0, 190);
  const description = str(req.body.description).slice(0, 2000) || null;
  if (!name) {
    req.flash('error', 'Give the segment a name.');
    return res.redirect('/lists');
  }

  const rules = {};
  const listId = parseInt(req.body.list_id, 10) || 0;
  if (listId) rules.list_id = listId;
  if (SUBSCRIBER_STATUSES.includes(req.body.status)) rules.status = req.body.status;
  if (req.body.has_opened) rules.has_opened = true;
  if (req.body.has_clicked) rules.has_clicked = true;

  try {
    await db.query('INSERT INTO segments (name, description, rules) VALUES (?, ?, ?)', [
      name,
      description,
      JSON.stringify(rules),
    ]);
    req.flash('success', `Created segment “${name}”.`);
    return res.redirect('/lists');
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'A segment with that name already exists.');
      return res.redirect('/lists');
    }
    return next(err);
  }
});

router.post('/segments/:id/delete', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();
  try {
    await db.query('DELETE FROM segments WHERE id = ?', [id]);
    req.flash('success', 'Segment deleted.');
    return res.redirect('/lists');
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------ list detail */

router.get('/:id', requireAuth, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();

  try {
    const list = await db.one('SELECT * FROM lists WHERE id = ? LIMIT 1', [id]);
    if (!list) {
      req.flash('error', 'That list no longer exists.');
      return res.redirect('/lists');
    }

    const page = parseInt(req.query.page, 10) || 1;
    const totalRow = await db.one('SELECT COUNT(*) AS c FROM list_subscribers WHERE list_id = ?', [id]);
    const pg = h.paginate(totalRow ? totalRow.c : 0, page, PER_PAGE);

    const [members, candidates] = await Promise.all([
      db.query(
        `SELECT s.id, s.email, s.first_name, s.last_name, s.status, ls.added_at
           FROM list_subscribers ls
           JOIN subscribers s ON s.id = ls.subscriber_id
          WHERE ls.list_id = ?
          ORDER BY ls.added_at DESC
          LIMIT ${pg.perPage} OFFSET ${pg.offset}`,
        [id]
      ),
      db.query(
        `SELECT id, email, first_name, last_name
           FROM subscribers
          WHERE id NOT IN (SELECT subscriber_id FROM list_subscribers WHERE list_id = ?)
          ORDER BY email ASC
          LIMIT 500`,
        [id]
      ),
    ]);

    return res.render('subscribers/list-show', {
      title: list.name,
      active: 'lists',
      list,
      members,
      candidates,
      pg,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();

  const name = str(req.body.name).slice(0, 190);
  const description = str(req.body.description).slice(0, 2000) || null;
  if (!name) {
    req.flash('error', 'Give the list a name.');
    return res.redirect(`/lists/${id}`);
  }

  try {
    const clash = await db.one('SELECT id FROM lists WHERE name = ? AND id <> ? LIMIT 1', [name, id]);
    if (clash) {
      req.flash('error', 'Another list already uses that name.');
      return res.redirect(`/lists/${id}`);
    }
    await db.query('UPDATE lists SET name = ?, description = ? WHERE id = ?', [name, description, id]);
    req.flash('success', 'List updated.');
    return res.redirect(`/lists/${id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/delete', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();
  try {
    // FK cascade clears list_subscribers; subscribers themselves are untouched.
    await db.query('DELETE FROM lists WHERE id = ?', [id]);
    req.flash('success', 'List deleted.');
    return res.redirect('/lists');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/members', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();

  try {
    const list = await db.one('SELECT id, name FROM lists WHERE id = ? LIMIT 1', [id]);
    if (!list) {
      req.flash('error', 'That list no longer exists.');
      return res.redirect('/lists');
    }

    const ids = new Set();
    const singleId = parseInt(req.body.subscriber_id, 10) || 0;
    if (singleId) ids.add(singleId);

    const emails = h.splitAddresses(req.body.emails || '').map((e) => e.toLowerCase()).filter(Boolean);
    for (const email of emails) {
      if (!h.isValidEmail(email)) continue;
      let sub = await db.one('SELECT id FROM subscribers WHERE email = ? LIMIT 1', [email]);
      if (!sub) {
        const created = await db.query(
          "INSERT INTO subscribers (email, status, source) VALUES (?, 'subscribed', 'manual')",
          [email]
        );
        sub = { id: created.insertId };
      }
      ids.add(sub.id);
    }

    const list_ids = Array.from(ids);
    if (list_ids.length) {
      const params = [];
      list_ids.forEach((sid) => params.push(id, sid));
      await db.query(
        `INSERT IGNORE INTO list_subscribers (list_id, subscriber_id)
         VALUES ${new Array(list_ids.length).fill('(?, ?)').join(',')}`,
        params
      );
    }

    req.flash('success', `Added ${list_ids.length} contact(s) to ${list.name}.`);
    return res.redirect(`/lists/${id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/members/remove', requireAuth, requireCapability('edit'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const subscriberId = parseInt(req.body.subscriber_id, 10);
  if (!id || !subscriberId) return next();
  try {
    await db.query('DELETE FROM list_subscribers WHERE list_id = ? AND subscriber_id = ?', [id, subscriberId]);
    req.flash('success', 'Contact removed from the list.');
    return res.redirect(`/lists/${id}`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
