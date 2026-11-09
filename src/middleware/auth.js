'use strict';

const db = require('../config/db');

/**
 * Access control. The current user is loaded once per request by loadUser(),
 * then route guards (requireAuth / requireRole) enforce access.
 */

const ROLES = ['admin', 'manager', 'viewer'];

// What each role is allowed to do (coarse-grained).
const ROLE_CAPABILITIES = {
  admin: ['view', 'edit', 'send', 'manage_users', 'manage_settings'],
  manager: ['view', 'edit', 'send'],
  viewer: ['view'],
};

async function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    try {
      const rows = await db.query(
        'SELECT id, email, name, role, status, last_login_at FROM users WHERE id = ? LIMIT 1',
        [req.session.userId]
      );
      if (rows.length && rows[0].status === 'active') {
        req.user = rows[0];
      } else {
        delete req.session.userId;
      }
    } catch (err) {
      return next(err);
    }
  }
  res.locals.currentUser = req.user;
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const target = req.originalUrl && req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  return res.redirect(`/auth/login${target}`);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/auth/login');
    if (roles.includes(req.user.role)) return next();
    return res.status(403).render('errors/403', { title: 'Not allowed', active: '' });
  };
}

function can(user, capability) {
  if (!user) return false;
  const caps = ROLE_CAPABILITIES[user.role] || [];
  return caps.includes(capability);
}

/** Guard for actions that require the "send" capability (campaigns, inbox send). */
function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/auth/login');
    if (can(req.user, capability)) return next();
    return res.status(403).render('errors/403', { title: 'Not allowed', active: '' });
  };
}

module.exports = { loadUser, requireAuth, requireRole, requireCapability, can, ROLES, ROLE_CAPABILITIES };
