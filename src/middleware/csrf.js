'use strict';

const crypto = require('crypto');

/**
 * CSRF protection (synchroniser token pattern).
 *
 * A per-session token is embedded in every form (via res.locals.csrfToken) and
 * required on all state-changing requests. Tracking routes (opens, clicks,
 * one-click unsubscribe) are token-authenticated separately and are exempt.
 */

const EXEMPT_PREFIXES = ['/t/'];

function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  }
  res.locals.csrfToken = req.session.csrfToken;

  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const sent =
    (req.body && (req.body._csrf || req.body.csrf_token)) ||
    req.headers['x-csrf-token'] ||
    (req.query && (req.query._csrf || req.query.csrf_token));
  if (sent && timingSafeEqual(sent, req.session.csrfToken)) return next();

  const err = new Error('Invalid or missing CSRF token. Please reload the page and try again.');
  err.status = 403;
  return next(err);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { csrfProtection };
