'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('../../config/db');
const env = require('../../config/env');
const { logActivity } = require('../../lib/activity');
const { sha256, randomToken } = require('../../lib/crypto');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { getMailboxProvider } = require('../../providers/mailbox');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    req.flash('error', 'Too many sign-in attempts. Please wait a few minutes and try again.');
    res.status(429).redirect('/auth/login');
  },
});

function safeNext(value) {
  const v = String(value || '');
  return v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

/* ---------------------------------------------------------------- sign in */

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', active: '', next: req.query.next || '' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);

  const fail = (msg) => {
    req.flash('error', msg);
    return res.status(400).render('auth/login', { title: 'Sign in', active: '', next: req.body.next || '', email });
  };

  if (!email || !password) return fail('Enter your email address and password.');

  try {
    const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    const user = rows[0];
    if (!user || user.status !== 'active') return fail('Those credentials did not match our records.');

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return fail('Those credentials did not match our records.');

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.save(async () => {
        await db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
        await logActivity(user.id, 'auth.login', null, req.ip);
        return res.redirect(nextUrl);
      });
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  const userId = req.session.userId;
  if (userId) logActivity(userId, 'auth.logout', null, req.ip);
  req.session.destroy(() => res.redirect('/auth/login'));
});

/* --------------------------------------------------------- password reset */

router.get('/forgot', (req, res) => {
  res.render('auth/forgot', { title: 'Reset password', active: '', sent: false });
});

router.post('/forgot', async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  // Always show the same response so we never reveal which emails exist.
  const generic = () => res.render('auth/forgot', { title: 'Reset password', active: '', sent: true });

  try {
    if (!email) return generic();
    const rows = await db.query('SELECT id, name, email FROM users WHERE email = ? AND status = ? LIMIT 1', [email, 'active']);
    const user = rows[0];
    if (!user) return generic();

    const token = randomToken(32);
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 60 MINUTE))`,
      [user.id, sha256(token)]
    );

    const link = `${env.appUrl}/auth/reset/${token}`;
    const mailbox = await getMailboxProvider();
    let deliverable = false;
    if (await mailbox.isConfigured()) {
      const html = `<p>Hello ${user.name},</p><p>A password reset was requested for your ${env.appName} account.</p>
        <p><a href="${link}">Set a new password</a></p><p>This link expires in 60 minutes. If you didn't request this, you can ignore this email.</p>`;
      await mailbox.send({ to: user.email, subject: `${env.appName} password reset`, html, text: `Reset your password: ${link}` });
      deliverable = true;
    }

    await logActivity(user.id, 'auth.reset_request', { deliverable }, req.ip);

    if (!deliverable) {
      req.flash('warn', 'The mail system is not configured, so the reset email could not be sent. Contact your administrator.');
    }
    return generic();
  } catch (err) {
    return next(err);
  }
});

router.get('/reset/:token', async (req, res, next) => {
  try {
    const rows = await db.query(
      'SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [sha256(req.params.token)]
    );
    if (!rows.length) {
      req.flash('error', 'That reset link is invalid or has expired. Please request a new one.');
      return res.redirect('/auth/forgot');
    }
    res.render('auth/reset', { title: 'Set a new password', active: '', token: req.params.token });
  } catch (err) {
    return next(err);
  }
});

router.post('/reset/:token', async (req, res, next) => {
  const token = req.params.token;
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');

  const render = (msg) => {
    req.flash('error', msg);
    return res.status(400).render('auth/reset', { title: 'Set a new password', active: '', token });
  };

  if (password.length < 10) return render('Choose a password with at least 10 characters.');
  if (password !== confirm) return render('The two passwords do not match.');

  try {
    const rows = await db.query(
      'SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [sha256(token)]
    );
    if (!rows.length) {
      req.flash('error', 'That reset link is invalid or has expired.');
      return res.redirect('/auth/forgot');
    }
    const reset = rows[0];
    const hash = await bcrypt.hash(password, 12);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, reset.user_id]);
    await db.query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [reset.id]);
    await logActivity(reset.user_id, 'auth.reset_complete', null, req.ip);
    req.flash('success', 'Your password has been updated. You can sign in now.');
    return res.redirect('/auth/login');
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------- user management */

router.get('/users', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const users = await db.query(
      'SELECT id, email, name, role, status, last_login_at, created_at FROM users ORDER BY created_at ASC'
    );
    res.render('auth/users', { title: 'Team & access', active: 'settings', users });
  } catch (err) {
    return next(err);
  }
});

router.post('/users', requireAuth, requireRole('admin'), async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const role = ['admin', 'manager', 'viewer'].includes(req.body.role) ? req.body.role : 'viewer';
  const password = String(req.body.password || '');

  try {
    if (!email || !name || password.length < 10) {
      req.flash('error', 'Provide a name, an email address and a password of at least 10 characters.');
      return res.redirect('/auth/users');
    }
    const exists = await db.one('SELECT id FROM users WHERE email = ?', [email]);
    if (exists) {
      req.flash('error', 'A user with that email already exists.');
      return res.redirect('/auth/users');
    }
    const hash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, ?, ?)', [
      email, name, hash, role, 'active',
    ]);
    await logActivity(req.user.id, 'auth.user_create', { email, role }, req.ip);
    req.flash('success', `Added ${name}.`);
    return res.redirect('/auth/users');
  } catch (err) {
    return next(err);
  }
});

router.post('/users/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const action = req.body.action;

  try {
    const target = await db.one('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) {
      req.flash('error', 'That user no longer exists.');
      return res.redirect('/auth/users');
    }

    if (action === 'role') {
      const role = ['admin', 'manager', 'viewer'].includes(req.body.role) ? req.body.role : target.role;
      await db.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
      await logActivity(req.user.id, 'auth.user_role', { id, role }, req.ip);
      req.flash('success', `Updated role for ${target.name}.`);
    } else if (action === 'status') {
      if (id === req.user.id) {
        req.flash('error', 'You cannot disable your own account.');
        return res.redirect('/auth/users');
      }
      const status = req.body.status === 'disabled' ? 'disabled' : 'active';
      await db.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
      await logActivity(req.user.id, 'auth.user_status', { id, status }, req.ip);
      req.flash('success', `Account ${status === 'disabled' ? 'disabled' : 're-enabled'}.`);
    } else if (action === 'password') {
      const password = String(req.body.password || '');
      if (password.length < 10) {
        req.flash('error', 'New password must be at least 10 characters.');
        return res.redirect('/auth/users');
      }
      const hash = await bcrypt.hash(password, 12);
      await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
      await logActivity(req.user.id, 'auth.user_password', { id }, req.ip);
      req.flash('success', `Password updated for ${target.name}.`);
    } else if (action === 'delete') {
      if (id === req.user.id) {
        req.flash('error', 'You cannot delete your own account.');
        return res.redirect('/auth/users');
      }
      await db.query('DELETE FROM users WHERE id = ?', [id]);
      await logActivity(req.user.id, 'auth.user_delete', { id }, req.ip);
      req.flash('success', 'User removed.');
    }
    return res.redirect('/auth/users');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
