'use strict';

/**
 * Settings service.
 *
 * Integration credentials can be supplied two ways:
 *   1. Environment variables (.env / host dashboard) — treated as defaults.
 *   2. The Settings → Integrations screen — persisted in the `settings` table.
 *
 * A value saved in the database always wins over the environment default, so an
 * operator can override without redeploying. Secret values are encrypted at
 * rest (AES-256-GCM, key from APP_KEY) and are never sent to the browser.
 */

const env = require('./env');
const db = require('./db');
const { encrypt, decrypt, isEncrypted } = require('../lib/crypto');

// Registry describing every configurable setting (drives the Settings UI).
// group: which integrations panel it appears in.
const REGISTRY = {
  'delivery.provider':            { env: 'DELIVERY_PROVIDER', secret: false, group: 'delivery', label: 'Delivery provider', type: 'select', options: ['sender', 'smtp'] },

  'delivery.sender.api_token':    { env: 'SENDER_API_TOKEN', secret: true, group: 'sender', label: 'Sender.net API token' },

  'delivery.smtp.host':           { env: 'SMTP_DELIVERY_HOST', secret: false, group: 'smtp_delivery', label: 'SMTP host' },
  'delivery.smtp.port':           { env: 'SMTP_DELIVERY_PORT', secret: false, group: 'smtp_delivery', label: 'SMTP port', type: 'number' },
  'delivery.smtp.user':           { env: 'SMTP_DELIVERY_USER', secret: false, group: 'smtp_delivery', label: 'SMTP username' },
  'delivery.smtp.pass':           { env: 'SMTP_DELIVERY_PASS', secret: true, group: 'smtp_delivery', label: 'SMTP password' },
  'delivery.smtp.secure':         { env: 'SMTP_DELIVERY_SECURE', secret: false, group: 'smtp_delivery', label: 'Use TLS', type: 'bool' },
  'delivery.smtp.from':           { env: 'SMTP_DELIVERY_FROM', secret: false, group: 'smtp_delivery', label: 'From (Name <email>)' },
  'delivery.smtp.rate':           { env: 'SMTP_DELIVERY_RATE', secret: false, group: 'smtp_delivery', label: 'Max per minute', type: 'number' },

  'mailbox.provider':             { env: 'MAILBOX_PROVIDER', secret: false, group: 'mailbox', label: 'Mailbox provider', type: 'select', options: ['imap'] },

  'mailbox.imap.host':            { env: 'IMAP_HOST', secret: false, group: 'imap', label: 'IMAP host' },
  'mailbox.imap.port':            { env: 'IMAP_PORT', secret: false, group: 'imap', label: 'IMAP port', type: 'number' },
  'mailbox.imap.secure':          { env: 'IMAP_SECURE', secret: false, group: 'imap', label: 'Use SSL/TLS', type: 'bool' },
  'mailbox.imap.user':            { env: 'IMAP_USER', secret: false, group: 'imap', label: 'IMAP username' },
  'mailbox.imap.password':        { env: 'IMAP_PASSWORD', secret: true, group: 'imap', label: 'IMAP password / app password' },

  'mailbox.smtp.host':            { env: 'SMTP_HOST', secret: false, group: 'mailbox_smtp', label: 'Outgoing SMTP host' },
  'mailbox.smtp.port':            { env: 'SMTP_PORT', secret: false, group: 'mailbox_smtp', label: 'Outgoing SMTP port', type: 'number' },
  'mailbox.smtp.secure':          { env: 'SMTP_SECURE', secret: false, group: 'mailbox_smtp', label: 'Use SSL/TLS', type: 'bool' },
  'mailbox.smtp.user':            { env: 'SMTP_USER', secret: false, group: 'mailbox_smtp', label: 'Outgoing SMTP username' },
  'mailbox.smtp.password':        { env: 'SMTP_PASSWORD', secret: true, group: 'mailbox_smtp', label: 'Outgoing SMTP password' },
  'mailbox.resend.api_key':       { env: 'RESEND_API_KEY', secret: true, group: 'mailbox_smtp', label: 'Resend API Key (Full access, for receiving email bodies)' },

  'mailbox.from_name':            { env: 'MAILBOX_FROM_NAME', secret: false, group: 'mailbox_identity', label: 'Sender name' },
  'mailbox.from_email':           { env: 'MAILBOX_FROM_EMAIL', secret: false, group: 'mailbox_identity', label: 'Sender email address' },

  'campaigns.rate_per_minute':    { env: 'CAMPAIGN_RATE_PER_MINUTE', secret: false, group: 'delivery', label: 'Send rate (per minute)', type: 'number' },
  'campaigns.concurrency':        { env: 'CAMPAIGN_CONCURRENCY', secret: false, group: 'delivery', label: 'Concurrent sends', type: 'number' },
  'campaigns.batch_size':         { env: 'CAMPAIGN_BATCH_SIZE', secret: false, group: 'delivery', label: 'Batch size (messages per batch)', type: 'number' },
  'campaigns.batch_interval_seconds': { env: 'CAMPAIGN_BATCH_INTERVAL', secret: false, group: 'delivery', label: 'Pause between batches (seconds)', type: 'number' },
  'campaigns.max_recipients_per_campaign': { env: 'CAMPAIGN_MAX_RECIPIENTS', secret: false, group: 'delivery', label: 'Max recipients per campaign', type: 'number' },
  'delivery.monthly_email_limit':  { env: 'DELIVERY_MONTHLY_LIMIT', secret: false, group: 'delivery', label: 'Provider monthly email limit (0 = unlimited)', type: 'number' },
};

function envFallback(key) {
  const spec = REGISTRY[key];
  if (!spec) return '';
  const raw = process.env[spec.env];
  return raw === undefined || raw === null ? '' : String(raw);
}

function envKeyFromRegistrySpec(spec) {
  return spec ? spec.env : '';
}

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15 * 1000;

async function loadAll() {
  const stored = {};
  try {
    const rows = await db.query('SELECT setting_key, setting_value, is_secret FROM settings');
    for (const row of rows) {
      stored[row.setting_key] = row.is_secret ? decrypt(row.setting_value) : (row.setting_value || '');
    }
  } catch (err) {
    // DB unreachable or starting up: fall back gracefully to environment defaults
  }

  const resolved = {};
  for (const key of Object.keys(REGISTRY)) {
    const dbVal = stored[key];
    resolved[key] = (dbVal !== undefined && dbVal !== '' && dbVal !== null) ? dbVal : envFallback(key);
  }
  return { stored, resolved };
}

async function ensureCache() {
  if (cache && (Date.now() - cacheAt) < CACHE_TTL_MS) return cache;
  cache = await loadAll();
  cacheAt = Date.now();
  return cache;
}

function clearCache() {
  cache = null;
  cacheAt = 0;
}

const settings = {
  REGISTRY,

  /** Effective raw string value (DB override → env default). */
  async get(key) {
    const c = await ensureCache();
    return c.resolved[key] !== undefined ? c.resolved[key] : '';
  },

  async getBool(key) {
    const v = await this.get(key);
    if (v === undefined || v === null || v === '') {
      const spec = REGISTRY[key];
      return spec && spec.type === 'bool' ? false : false;
    }
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  },

  async getInt(key, fallback = 0) {
    const v = parseInt(await this.get(key), 10);
    return Number.isFinite(v) ? v : fallback;
  },

  /** All effective values (used by provider factories). */
  async all() {
    const c = await ensureCache();
    return { ...c.resolved };
  },

  /** Persist a value. Empty string clears the override (reverts to env). */
  async set(key, value) {
    const spec = REGISTRY[key];
    if (!spec) throw new Error(`Unknown setting: ${key}`);
    const stringVal = value === undefined || value === null ? '' : String(value);

    if (stringVal === '') {
      await db.query('DELETE FROM settings WHERE setting_key = ?', [key]);
      clearCache();
      return;
    }

    const storedValue = spec.secret ? encrypt(stringVal) : stringVal;
    await db.query(
      `INSERT INTO settings (setting_key, setting_value, is_secret)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), is_secret = VALUES(is_secret)`,
      [key, storedValue, spec.secret ? 1 : 0]
    );
    clearCache();
  },

  /** Which keys currently have a real (non-empty) effective value. */
  async configuredMap() {
    const { resolved } = await ensureCache();
    const out = {};
    for (const key of Object.keys(REGISTRY)) {
      out[key] = Boolean(resolved[key]);
    }
    return out;
  },

  /** True when a value currently comes from the environment (read-only in UI). */
  async sourceMap() {
    const { stored } = await ensureCache();
    const out = {};
    for (const key of Object.keys(REGISTRY)) {
      out[key] = (stored[key] !== undefined && stored[key] !== '') ? 'database' : 'environment';
    }
    return out;
  },

  envKey: envKeyFromRegistrySpec,
  clearCache,
};

module.exports = settings;
