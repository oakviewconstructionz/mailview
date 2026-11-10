'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const flash = require('./middleware/flash');
const { loadUser } = require('./middleware/auth');
const { csrfProtection } = require('./middleware/csrf');
const locals = require('./middleware/locals');
const { notFound, errorHandler } = require('./middleware/errors');

/**
 * Builds the Express application. Kept in one place so the server bootstrap and
 * tests can share the same wiring.
 */
function createApp() {
  const app = express();

  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');
  app.set('trust proxy', 1); // Railway / reverse proxies

  // --- Security headers -----------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'"], // tiny inline bootstrap only
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'https:'],
          'font-src': ["'self'", 'data:'],
          'frame-src': ["'self'"],
          'frame-ancestors': ["'self'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    })
  );

  // --- Body parsing ---------------------------------------------------------
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  app.use(express.json({ limit: '25mb' }));

  // --- Static assets --------------------------------------------------------
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: env.isProd ? '7d' : 0 }));
  app.use(
    '/storage',
    express.static(path.join(__dirname, '..', 'storage'), {
      maxAge: '1d',
      setHeaders(res) { res.setHeader('Content-Disposition', 'attachment'); },
    })
  );

  // --- Sessions (stored in MySQL so logins survive restarts) ----------------
  const sessionStore = new MySQLStore({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    ...(env.db.url ? { uri: env.db.url } : {}),
    ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
    createDatabaseTable: true,
    schema: { tableName: 'sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } },
  });

  app.use(
    session({
      key: 'oakview.sid',
      secret: env.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.isProd,
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
      },
    })
  );

  // --- Global rate limit (defensive) ---------------------------------------
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/static') || req.path.startsWith('/storage'),
    })
  );

  app.use(flash());
  app.use(loadUser);
  app.use(csrfProtection);
  app.use(locals);

  // --- Health check ---------------------------------------------------------
  app.get('/healthz', (req, res) => res.json({ ok: true, name: env.appName, time: new Date().toISOString() }));

  // --- Routes ---------------------------------------------------------------
  app.use('/t', require('./modules/tracking/routes'));          // open/click/unsubscribe (public)
  app.use('/auth', require('./modules/auth/routes'));           // login/logout/reset
  app.use('/', require('./modules/dashboard/routes'));          // dashboard (auth-guarded inside)
  app.get('/compose', (req, res) => res.redirect('/inbox/compose'));
  app.post('/compose', (req, res, next) => {
    req.url = '/compose';
    return require('./modules/inbox/routes')(req, res, next);
  });
  app.use('/inbox', require('./modules/inbox/routes'));
  app.use('/contacts', require('./modules/subscribers/routes'));
  app.use('/lists', require('./modules/subscribers/listRoutes'));
  app.use('/templates', require('./modules/templates/routes'));
  app.use('/campaigns', require('./modules/campaigns/routes'));
  app.use('/analytics', require('./modules/analytics/routes'));
  app.use('/settings', require('./modules/settings/routes'));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
