'use strict';

/**
 * Delivery provider factory.
 *
 * The active provider is chosen by the `delivery.provider` setting
 * (env DELIVERY_PROVIDER or Settings → Integrations). Adding a new provider
 * means dropping a module in this folder and registering it below — no other
 * part of the app changes.
 */

const settings = require('../../config/settings');
const sender = require('./sender');
const smtp = require('./smtp');

const PROVIDERS = {
  sender,
  smtp,
};

const LABELS = {
  sender: 'Sender.net',
  smtp: 'SMTP relay',
};

async function activeName() {
  const name = (await settings.get('delivery.provider')) || 'sender';
  const selected = PROVIDERS[name] ? name : 'sender';
  // Keep the explicitly-selected provider when it is actually configured.
  if (await PROVIDERS[selected].isConfigured()) return selected;
  // Otherwise fall back to the other provider if that one is configured, so a
  // ready integration is used instead of an unconfigured default.
  const other = selected === 'smtp' ? 'sender' : 'smtp';
  if (await PROVIDERS[other].isConfigured()) return other;
  return selected;
}

async function getDeliveryProvider(nameOverride) {
  if (nameOverride && PROVIDERS[nameOverride]) {
    if (await PROVIDERS[nameOverride].isConfigured()) {
      return PROVIDERS[nameOverride];
    }
  }
  const name = await activeName();
  return PROVIDERS[name] || PROVIDERS.smtp || sender;
}

/** Human label used only inside admin settings (never the client UI). */
function label(name) {
  return LABELS[name] || name;
}

async function listProviders() {
  const out = [];
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    out.push({ key, label: LABELS[key] || key, configured: await provider.isConfigured() });
  }
  return out;
}

module.exports = { getDeliveryProvider, activeName, listProviders, label, PROVIDERS };
