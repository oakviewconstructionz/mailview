'use strict';

/**
 * Flash messages stored on the session, read back once by locals middleware.
 * Usage:  req.flash('success', 'Saved.')  /  req.flash('error', 'Nope.')
 */
function flash() {
  return (req, res, next) => {
    req.flash = (type, message) => {
      req.session.flash = { type, message };
    };
    next();
  };
}

module.exports = flash;
