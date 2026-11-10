'use strict';

const env = require('../config/env');
const db = require('../config/db');
const helpers = require('../lib/helpers');
const { can } = require('./auth');

/**
 * Populates res.locals for every render: app identity, CSRF token, current
 * user, capabilities, flash messages and small navigation counters.
 */
async function locals(req, res, next) {
  res.locals.appName = env.appName;
  res.locals.appUrl = env.appUrl;
  res.locals.currentPath = req.path;
  res.locals.currentUser = req.user || null;
  res.locals.can = (capability) => can(req.user, capability);
  res.locals.assetVer = env.assetVersion; // cache-busting token for /static assets

  // Flash messages (set via res.flash(...) — see helpers/flash.js).
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;

  // Navigation counters — best effort, never block the request on failure.
  res.locals.nav = { unreadMail: 0, contactCount: 0 };
  if (req.user) {
    try {
      const unread = await db.one("SELECT COUNT(*) AS c FROM mail_messages WHERE is_read = 0 AND is_sent = 0 AND folder = 'INBOX'");
      res.locals.nav.unreadMail = unread ? unread.c : 0;
    } catch (_) { /* ignore */ }
  }

  // View helpers.
  res.locals.h = helpers;
  next();
}

module.exports = locals;
