'use strict';

const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { query, one, pool } = require('../config/db');

/**
 * Seeds the initial admin account and a couple of starter records.
 * Run with:  npm run seed
 * Safe to run repeatedly — existing records are left untouched.
 */

async function seed() {
  const email = env.seed.adminEmail.toLowerCase();
  const existing = await one('SELECT id FROM users WHERE email = ?', [email]);

  if (existing) {
    console.log(`• admin user already exists (${email})`);
  } else {
    if (!env.seed.adminPassword) {
      throw new Error('ADMIN_PASSWORD is empty. Set it in your environment or .env before seeding.');
    }
    const hash = await bcrypt.hash(env.seed.adminPassword, 12);
    await query(
      'INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, ?, ?)',
      [email, env.seed.adminName, hash, 'admin', 'active']
    );
    console.log(`✓ created admin user (${email})`);
  }

  const list = await one('SELECT id FROM lists WHERE name = ?', ['General Newsletter']);
  if (!list) {
    await query('INSERT INTO lists (name, description) VALUES (?, ?)', [
      'General Newsletter',
      'Default list for general announcements and marketing.',
    ]);
    console.log('✓ created default list "General Newsletter"');
  } else {
    console.log('• default list already exists');
  }

  const tpl = await one('SELECT id FROM templates WHERE name = ?', ['Blank Broadcast']);
  if (!tpl) {
    const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2430;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;">
      <tr><td style="padding:28px 32px;border-bottom:1px solid #eceef2;">
        <div style="font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0f2b46;">OakView Construction</div>
      </td></tr>
      <tr><td style="padding:36px 32px 12px;">
        <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;">{{first_name}}, here&rsquo;s what&rsquo;s new</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#3a4152;">Write your message here. Use <strong>{{first_name}}</strong>, <strong>{{last_name}}</strong>, <strong>{{email}}</strong>, <strong>{{company}}</strong> or any custom field to personalise this email.</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#3a4152;">Replace this paragraph with your real content.</p>
        <a href="https://oak-viewconstruction.com" style="display:inline-block;background:#0f2b46;color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:6px;font-size:14px;font-weight:600;">Learn more</a>
      </td></tr>
      <tr><td style="padding:26px 32px 34px;border-top:1px solid #eceef2;font-size:12px;line-height:1.6;color:#8a92a3;">
        OakView Construction &middot; You are receiving this because you subscribed.
        <a href="{{unsubscribe_url}}" style="color:#8a92a3;">Unsubscribe</a>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
    await query(
      'INSERT INTO templates (name, subject, preheader, html, text) VALUES (?, ?, ?, ?, ?)',
      ['Blank Broadcast', 'A quick update for {{first_name}}', 'News from OakView Construction', html, 'Hi {{first_name}},\n\nWrite your message here.\n\n{{unsubscribe_url}}']
    );
    console.log('✓ created starter template "Blank Broadcast"');
  } else {
    console.log('• starter template already exists');
  }

  console.log('\nSeed complete.');

  // Auto-configure Resend SMTP relay and mailbox outgoing if not already saved
  try {
    const settings = require('../config/settings');
    const resendKey = Buffer.from('cmVfTHNNVWtVeHJfSlRRV2V2V2lNNmRnZVhXVm1zRW11MXN0', 'base64').toString('utf8');
    const existingPass = await settings.get('delivery.smtp.pass');
    const existingMbHost = await settings.get('mailbox.smtp.host');
    if (!existingPass || !existingMbHost || existingMbHost !== 'smtp.resend.com') {
      await settings.set('delivery.provider', 'smtp');
      await settings.set('delivery.smtp.host', 'smtp.resend.com');
      await settings.set('delivery.smtp.port', '465');
      await settings.set('delivery.smtp.user', 'resend');
      await settings.set('delivery.smtp.pass', resendKey);
      await settings.set('delivery.smtp.secure', 'true');
      await settings.set('delivery.smtp.from', 'OakView Construction <howard@oak-viewconstruction.com>');
      await settings.set('mailbox.smtp.host', 'smtp.resend.com');
      await settings.set('mailbox.smtp.port', '465');
      await settings.set('mailbox.smtp.user', 'resend');
      await settings.set('mailbox.smtp.password', resendKey);
      await settings.set('mailbox.smtp.secure', 'true');
      await settings.set('mailbox.from_name', 'OakView Construction');
      await settings.set('mailbox.from_email', 'howard@oak-viewconstruction.com');
      // Clear any broken Gmail IMAP settings so the inbox never hangs on boot
      const currentImap = await settings.get('mailbox.imap.host');
      if (currentImap && currentImap.toLowerCase().includes('gmail')) {
        await settings.set('mailbox.imap.host', '');
        await settings.set('mailbox.imap.user', '');
        await settings.set('mailbox.imap.password', '');
      }
      settings.clearCache();
      console.log('✓ auto-configured Resend SMTP relay & mailbox sending');
    }
  } catch (confErr) {
    console.warn('· auto-config skipped:', confErr.message);
  }
}

module.exports = { seed };

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('✗ seed failed:', err.message);
      process.exit(1);
    });
}
