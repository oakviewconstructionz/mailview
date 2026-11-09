'use strict';

/**
 * Mailbox provider factory.
 *
 * The mailbox (read/reply/forward/compose) is kept completely separate from the
 * delivery provider (marketing campaigns). Today only `imap` is implemented;
 * another provider (e.g. a vendor REST mailbox API) can be added by dropping a
 * module here and registering it — the rest of the app is unaffected.
 */

const settings = require('../../config/settings');
const imap = require('./imap');

const PROVIDERS = { imap };

async function activeName() {
  const name = (await settings.get('mailbox.provider')) || 'imap';
  return PROVIDERS[name] ? name : 'imap';
}

async function getMailboxProvider(nameOverride) {
  const name = nameOverride || (await activeName());
  return PROVIDERS[name] || imap;
}

module.exports = { getMailboxProvider, activeName, PROVIDERS };
