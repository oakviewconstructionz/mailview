'use strict';

const crypto = require('crypto');
const env = require('../config/env');

/**
 * AES-256-GCM helpers used to encrypt integration secrets (API keys, mailbox
 * passwords) before they are written to the database. The master key comes
 * from APP_KEY and never leaves the server.
 */

const KEY_LEN = 32;

function masterKey() {
  const raw = env.appKey || '';
  if (!raw) {
    throw new Error('APP_KEY is not set. Add a 32+ character APP_KEY to your environment before storing secrets.');
  }
  // Derive a fixed 32-byte key from whatever length the operator supplied.
  return crypto.createHash('sha256').update(raw).digest();
}

/** Encrypts plaintext → "v1:base64(iv):base64(tag):base64(ciphertext)". */
function encrypt(plain) {
  if (plain === undefined || plain === null) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** Reverses encrypt(). Returns '' when given empty/invalid input. */
function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('v1:');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { encrypt, decrypt, isEncrypted, sha256, randomToken, KEY_LEN };
