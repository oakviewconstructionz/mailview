'use strict';

const env = require('../config/env');

/** 404 handler. */
function notFound(req, res) {
  if ((req.headers.accept || '').includes('application/json') || req.xhr) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.status(404).render('errors/404', { title: 'Page not found', active: '' });
}

/** Central error handler. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} →`, err.message);
    if (!env.isProd) console.error(err.stack);
  }

  const wantsJson = (req.headers.accept || '').includes('application/json') || req.xhr;
  if (wantsJson) {
    return res.status(status).json({ error: err.message || 'Something went wrong' });
  }

  if (status === 404) {
    return res.status(404).render('errors/404', { title: 'Page not found', active: '' });
  }

  return res.status(status).render('errors/500', {
    title: 'Something went wrong',
    active: '',
    message: err.message || 'An unexpected error occurred.',
  });
}

module.exports = { notFound, errorHandler };
