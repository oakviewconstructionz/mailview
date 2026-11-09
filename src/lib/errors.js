'use strict';

/** Thrown when an integration is used before it has been configured. */
class NotConfiguredError extends Error {
  constructor(message) {
    super(message || 'This integration is not configured yet.');
    this.name = 'NotConfiguredError';
    this.code = 'NOT_CONFIGURED';
    this.status = 400;
  }
}

/** Thrown when a provider call fails after configuration is present. */
class ProviderError extends Error {
  constructor(message, { provider, status, code, response } = {}) {
    super(message || 'The provider reported an error.');
    this.name = 'ProviderError';
    this.code = code || 'PROVIDER_ERROR';
    this.provider = provider;
    this.status = status || 502;
    this.response = response;
  }
}

/** Bad user input (validation). */
class ValidationError extends Error {
  constructor(message) {
    super(message || 'Invalid input.');
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
    this.status = 400;
  }
}

module.exports = { NotConfiguredError, ProviderError, ValidationError };
