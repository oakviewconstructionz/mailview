'use strict';

const env = require('../config/env');

/**
 * URL builders for the public tracking endpoints. Kept in lib (not the route
 * module) so services can use them without importing Express routers.
 */
module.exports = {
  buildUnsubscribeUrl: (token) => `${env.appUrl}/t/u/${token}`,
  buildPixelUrl: (token) => `${env.appUrl}/t/o/${token}.gif`,
  buildClickUrl: (linkToken, recipientToken) => `${env.appUrl}/t/c/${linkToken}?r=${encodeURIComponent(recipientToken)}`,
};
