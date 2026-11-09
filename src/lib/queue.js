'use strict';

/** Small concurrency / throttling utilities used by the send queue. */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn` over items with at most `limit` in flight at once. */
async function mapLimit(items, limit, fn) {
  const results = [];
  let index = 0;
  const size = Math.max(1, limit);
  const workers = new Array(Math.min(size, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        results[current] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Spacing limiter — guarantees no more than `perMinute` operations start within
 * any rolling minute. Never allows exceeding the configured provider limit;
 * callers must not bypass it.
 */
class RateLimiter {
  constructor(perMinute) {
    this.perMinute = Math.max(1, perMinute || 1);
    this.intervalMs = Math.ceil(60000 / this.perMinute);
    this.nextAt = 0;
  }

  async acquire() {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.intervalMs;
    const wait = at - now;
    if (wait > 0) await sleep(wait);
  }
}

module.exports = { sleep, mapLimit, RateLimiter };
