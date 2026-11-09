'use strict';

const express = require('express');

const db = require('../../config/db');
const helpers = require('../../lib/helpers');
const { logActivity } = require('../../lib/activity');
const { requireAuth, requireCapability } = require('../../middleware/auth');

const router = express.Router();

// Everything in this module requires a signed-in user.
router.use(requireAuth);

// Sample data used to personalise templates on the preview screen.
const SAMPLE_DATA = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  company: 'OakView Labs',
  unsubscribe_url: 'https://example.com/unsubscribe?u=sample',
};

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function notFound() {
  const err = new Error('That template no longer exists.');
  err.status = 404;
  return err;
}

/* ------------------------------------------------------------------- list */

router.get('/', async (req, res, next) => {
  try {
    const templates = await db.query(
      'SELECT id, name, subject, preheader, html, text, updated_at FROM templates ORDER BY updated_at DESC'
    );
    res.render('templates/index', { title: 'Templates', active: 'templates', templates });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ new / edit */

router.get('/new', (req, res) => {
  res.render('templates/form', { title: 'New template', active: 'templates', template: null, isNew: true });
});

router.get('/:id/edit', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next(notFound());
  try {
    const template = await db.one('SELECT * FROM templates WHERE id = ?', [id]);
    if (!template) return next(notFound());
    res.render('templates/form', { title: template.name, active: 'templates', template, isNew: false });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- create */

router.post('/', requireCapability('edit'), async (req, res, next) => {
  const name = String(req.body.name || '').trim();
  const subject = String(req.body.subject || '').trim();
  const preheader = String(req.body.preheader || '').trim();
  const html = String(req.body.html || '');
  const text = String(req.body.text || '');

  if (!name) {
    req.flash('error', 'A template name is required.');
    return res.redirect('/templates/new');
  }

  try {
    const result = await db.query(
      'INSERT INTO templates (name, subject, preheader, html, text, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [name, subject || null, preheader || null, html || null, text || null, req.user.id]
    );
    const id = result.insertId;
    await logActivity(req.user.id, 'template.create', { id }, req.ip);
    req.flash('success', `Template “${name}” created.`);
    return res.redirect(`/templates/${id}/edit`);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- update */

router.post('/:id', requireCapability('edit'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const name = String(req.body.name || '').trim();
  const subject = String(req.body.subject || '').trim();
  const preheader = String(req.body.preheader || '').trim();
  const html = String(req.body.html || '');
  const text = String(req.body.text || '');

  if (!id) {
    req.flash('error', 'That template no longer exists.');
    return res.redirect('/templates');
  }
  if (!name) {
    req.flash('error', 'A template name is required.');
    return res.redirect(`/templates/${id}/edit`);
  }

  try {
    const existing = await db.one('SELECT id FROM templates WHERE id = ?', [id]);
    if (!existing) {
      req.flash('error', 'That template no longer exists.');
      return res.redirect('/templates');
    }
    await db.query(
      'UPDATE templates SET name = ?, subject = ?, preheader = ?, html = ?, text = ? WHERE id = ?',
      [name, subject || null, preheader || null, html || null, text || null, id]
    );
    await logActivity(req.user.id, 'template.update', { id }, req.ip);
    req.flash('success', 'Template saved.');
    return res.redirect(`/templates/${id}/edit`);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- delete */

router.post('/:id/delete', requireCapability('edit'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    req.flash('error', 'That template no longer exists.');
    return res.redirect('/templates');
  }
  try {
    const existing = await db.one('SELECT id, name FROM templates WHERE id = ?', [id]);
    if (!existing) {
      req.flash('error', 'That template no longer exists.');
      return res.redirect('/templates');
    }
    // campaigns.template_id is ON DELETE SET NULL, so removal is always safe.
    await db.query('DELETE FROM templates WHERE id = ?', [id]);
    await logActivity(req.user.id, 'template.delete', { id }, req.ip);
    req.flash('success', `Template “${existing.name}” deleted.`);
    return res.redirect('/templates');
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------- duplicate */

router.post('/:id/duplicate', requireCapability('edit'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    req.flash('error', 'That template no longer exists.');
    return res.redirect('/templates');
  }
  try {
    const template = await db.one('SELECT * FROM templates WHERE id = ?', [id]);
    if (!template) {
      req.flash('error', 'That template no longer exists.');
      return res.redirect('/templates');
    }
    const name = `${template.name} (copy)`.slice(0, 190);
    const result = await db.query(
      'INSERT INTO templates (name, subject, preheader, html, text, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [name, template.subject, template.preheader, template.html, template.text, req.user.id]
    );
    const newId = result.insertId;
    await logActivity(req.user.id, 'template.duplicate', { id, new_id: newId }, req.ip);
    req.flash('success', 'Template duplicated.');
    return res.redirect(`/templates/${newId}/edit`);
  } catch (err) {
    return next(err);
  }
});

/* --------------------------------------------------------------- preview */

router.get('/:id/preview', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next(notFound());
  try {
    const template = await db.one('SELECT * FROM templates WHERE id = ?', [id]);
    if (!template) return next(notFound());
    res.render('templates/preview', {
      template,
      html: helpers.personalise(template.html || '', SAMPLE_DATA),
      subject: helpers.personalise(template.subject || '', SAMPLE_DATA),
      preheader: helpers.personalise(template.preheader || '', SAMPLE_DATA),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
