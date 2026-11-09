'use strict';

/** Small shared helpers used across modules and views. */

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function snippet(text, len = 160) {
  const s = stripTags(text);
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(date) {
  if (!date) return '';
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(d);
}

function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

function percent(part, total, digits = 1) {
  const t = Number(total);
  if (!t) return '0%';
  return `${((Number(part) / t) * 100).toFixed(digits)}%`;
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/** "Name <a@b.com>" or "a@b.com" → { name, email } */
function parseAddress(input) {
  if (!input) return { name: '', email: '' };
  const m = String(input).match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim(), email: m[2].trim() };
  return { name: '', email: String(input).trim() };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function splitAddresses(input) {
  return String(input || '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Personalises template HTML/text.
 * Replaces {{key}} tokens. Unknown tokens become empty strings.
 * Always provides {{unsubscribe_url}} and {{email}}.
 */
function personalise(content, data) {
  if (!content) return '';
  return String(content).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const k = key.trim().toLowerCase();
    if (data && data[k] !== undefined && data[k] !== null) return escapeHtml(data[k]);
    return '';
  });
}

/** Rewrites bare URLs in HTML to a tracking URL (used for click tracking). */
function rewriteLinks(html, rewriter) {
  return String(html || '').replace(/href\s*=\s*"([^"]+)"/gi, (match, url) => {
    if (/^(mailto:|tel:|#|\{\{)/i.test(url)) return match;
    return `href="${rewriter(url)}"`;
  });
}

function paginate(total, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page || 1), totalPages);
  return {
    total,
    page: current,
    perPage,
    totalPages,
    offset: (current - 1) * perPage,
    hasPrev: current > 1,
    hasNext: current < totalPages,
  };
}

module.exports = {
  escapeHtml,
  stripTags,
  snippet,
  formatDate,
  formatDateTime,
  timeAgo,
  formatNumber,
  percent,
  initials,
  parseAddress,
  isValidEmail,
  splitAddresses,
  personalise,
  rewriteLinks,
  paginate,
};
