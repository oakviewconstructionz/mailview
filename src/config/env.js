'use strict';

/**
 * Loads and normalises environment configuration.
 * Values from .env / process.env act as defaults and can be overridden at
 * runtime from the Settings → Integrations screen (see config/settings.js).
 */

require('dotenv').config();

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: int(process.env.PORT, 3000),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  appName: process.env.APP_NAME || 'OakView Mail',
  appKey: process.env.APP_KEY || '',
  sessionSecret: process.env.SESSION_SECRET || process.env.APP_KEY || 'insecure-dev-session-secret',

  // Bumped per deploy so browsers never serve a stale cached bundle. Railway
  // injects RAILWAY_GIT_COMMIT_SHA; the start-time fallback busts on restart.
  assetVersion:
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.SOURCE_VERSION ||
    String(Date.now()),

  db: {
    url: process.env.DATABASE_URL || process.env.MYSQL_URL || '',
    host: process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1',
    port: int(process.env.DB_PORT || process.env.MYSQLPORT, 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'oakview_mail',
    ssl: bool(process.env.DB_SSL, false),
  },

  seed: {
    adminEmail: process.env.ADMIN_EMAIL || 'admin@oak-viewconstruction.com',
    adminName: process.env.ADMIN_NAME || 'OakView Admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
  },

  delivery: {
    provider: (process.env.DELIVERY_PROVIDER || 'smtp').toLowerCase(),
    senderToken: process.env.SENDER_API_TOKEN || '',
    smtp: {
      host: process.env.SMTP_DELIVERY_HOST || '',
      port: int(process.env.SMTP_DELIVERY_PORT, 587),
      user: process.env.SMTP_DELIVERY_USER || '',
      pass: process.env.SMTP_DELIVERY_PASS || '',
      secure: bool(process.env.SMTP_DELIVERY_SECURE, false),
      from: process.env.SMTP_DELIVERY_FROM || '',
      rate: int(process.env.SMTP_DELIVERY_RATE, 60),
    },
  },

  mailbox: {
    provider: (process.env.MAILBOX_PROVIDER || 'imap').toLowerCase(),
    imap: {
      host: process.env.IMAP_HOST || '',
      port: int(process.env.IMAP_PORT, 993),
      secure: bool(process.env.IMAP_SECURE, true),
      user: process.env.IMAP_USER || '',
      password: process.env.IMAP_PASSWORD || '',
    },
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: int(process.env.SMTP_PORT, 465),
      secure: bool(process.env.SMTP_SECURE, true),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
    },
    fromName: process.env.MAILBOX_FROM_NAME || 'OakView Construction',
    fromEmail: process.env.MAILBOX_FROM_EMAIL || '',
    routingNote: process.env.CLOUDFLARE_ROUTING_NOTE || '',
  },

  campaigns: {
    ratePerMinute: int(process.env.CAMPAIGN_RATE_PER_MINUTE, 300),
    concurrency: int(process.env.CAMPAIGN_CONCURRENCY, 5),
    batchSize: int(process.env.CAMPAIGN_BATCH_SIZE, 50),
    batchIntervalSeconds: int(process.env.CAMPAIGN_BATCH_INTERVAL, 10),
    maxRecipientsPerCampaign: int(process.env.CAMPAIGN_MAX_RECIPIENTS, 3000),
    monthlyEmailLimit: int(process.env.DELIVERY_MONTHLY_LIMIT, 0),
    dailyEmailLimit: int(process.env.DELIVERY_DAILY_LIMIT, 0),
    runWorkerInWeb: bool(process.env.RUN_WORKER_IN_WEB, true),
  },
};

module.exports = env;
