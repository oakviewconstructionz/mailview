'use strict';

const db = require('../config/db');

/** Records an audit-trail entry. Never throws (logging must not break flows). */
async function logActivity(userId, action, meta = null, ip = null) {
  try {
    await db.query('INSERT INTO activity_log (user_id, action, meta, ip) VALUES (?, ?, ?, ?)', [
      userId || null,
      action,
      meta ? JSON.stringify(meta) : null,
      ip || null,
    ]);
  } catch (_) {
    /* swallow — activity logging is best-effort */
  }
}

module.exports = { logActivity };
