'use strict';

class EinvoiceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'EinvoiceError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

module.exports = { EinvoiceError };
