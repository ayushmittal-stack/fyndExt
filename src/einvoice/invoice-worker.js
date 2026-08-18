'use strict';

const { EinvoiceError } = require('./errors');

const LOG_SAFE_CODES = new Set([
  'REPOSITORY_BUSY',
  'REPOSITORY_UNAVAILABLE',
  'REPOSITORY_VERSION_CONFLICT',
  'REPOSITORY_TRANSACTION_UNKNOWN',
  'REPOSITORY_DATA_INVALID',
  'REPOSITORY_INPUT_INVALID',
  'REPOSITORY_CLAIM_INVALID',
  'WORKFLOW_INPUT_INVALID',
  'WORKFLOW_REPOSITORY_DATA_INVALID',
  'WORKER_CLAIM_INVALID',
  'WORKER_CLOCK_INVALID',
  'WORKER_RANDOM_INVALID',
  'WORKER_RETRY_INVALID',
]);

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isBoundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function safeCode(error) {
  return error instanceof EinvoiceError && LOG_SAFE_CODES.has(error.code)
    ? error.code
    : 'INVOICE_WORKER_ERROR';
}

function createInvoiceWorker(deps = {}) {
  let repository;
  let workflow;
  let workerId;
  let pollMs;
  let leaseMs;
  let maxAttempts;
  let retryBaseMs;
  let now;
  let random;
  let setTimeoutFn;
  let clearTimeoutFn;
  let logger;
  let valid = false;
  try {
    if (!isObject(deps)) throw new Error('invalid worker configuration');
    ({
      repository,
      workflow,
      workerId,
      pollMs,
      leaseMs,
      maxAttempts,
      retryBaseMs,
      now = () => new Date(),
      random = Math.random,
      setTimeoutFn = setTimeout,
      clearTimeoutFn = clearTimeout,
      logger,
    } = deps);
    valid = isObject(repository)
      && typeof repository.releaseExpiredLeases === 'function'
      && typeof repository.claimNextJob === 'function'
      && typeof repository.claimNextOutbox === 'function'
      && isObject(workflow)
      && typeof workflow.processJob === 'function'
      && typeof workflow.processOutbox === 'function'
      && typeof workerId === 'string' && workerId.trim() !== ''
      && isBoundedInteger(pollMs, 100, 60000)
      && isBoundedInteger(leaseMs, 1000, 3600000)
      && isPositiveInteger(maxAttempts) && maxAttempts <= 5
      && isBoundedInteger(retryBaseMs, 100, 3600000)
      && typeof now === 'function' && typeof random === 'function'
      && typeof setTimeoutFn === 'function' && typeof clearTimeoutFn === 'function'
      && isObject(logger) && typeof logger.error === 'function';
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WORKER_CONFIG_INVALID', 'Invoice worker configuration is invalid');
  }

  let running = false;
  let timer = null;
  let activeRun = null;
  let startPromise = null;

  function readNow() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      fail('WORKER_CLOCK_INVALID', 'Invoice worker clock is invalid');
    }
    return value;
  }

  function leaseUntil() {
    const current = readNow();
    return new Date(current.getTime() + leaseMs).toISOString();
  }

  function retryPlan(attemptCount) {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
      fail('WORKER_CLAIM_INVALID', 'Invoice worker claim is invalid');
    }
    return Object.freeze({
      exhausted: attemptCount >= maxAttempts,
      overLimit: attemptCount > maxAttempts,
      retryDelayMs() {
        const sample = random();
        if (typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
          fail('WORKER_RANDOM_INVALID', 'Invoice worker random source is invalid');
        }
        const exponent = Math.min(attemptCount - 1, maxAttempts - 1);
        const cap = retryBaseMs * (2 ** exponent);
        if (!Number.isSafeInteger(cap)) {
          fail('WORKER_RETRY_INVALID', 'Invoice worker retry delay is invalid');
        }
        const delay = Math.floor((cap / 2) + (sample * cap / 2));
        return delay;
      },
    });
  }

  function logFailure(message, error) {
    logger.error(message, safeCode(error));
  }

  async function executeRun() {
    try {
      await repository.releaseExpiredLeases(readNow());
    } catch (error) {
      logFailure('Invoice worker lease release failed', error);
      return;
    }

    try {
      const claimedJob = await repository.claimNextJob(workerId, leaseUntil());
      if (claimedJob !== null && claimedJob !== undefined) {
        await workflow.processJob(claimedJob, retryPlan(claimedJob.attemptCount));
      }
    } catch (error) {
      logFailure('Invoice job processing failed', error);
    }

    try {
      const claimedOutbox = await repository.claimNextOutbox(workerId, leaseUntil());
      if (claimedOutbox !== null && claimedOutbox !== undefined) {
        await workflow.processOutbox(claimedOutbox, retryPlan(claimedOutbox.attemptCount));
      }
    } catch (error) {
      logFailure('Invoice outbox processing failed', error);
    }
  }

  function runOnce() {
    if (activeRun) return activeRun;
    const run = executeRun();
    activeRun = run;
    run.then(
      () => { if (activeRun === run) activeRun = null; },
      () => { if (activeRun === run) activeRun = null; },
    );
    return run;
  }

  function schedule(delay) {
    timer = setTimeoutFn(async () => {
      timer = null;
      await runOnce();
      if (running) schedule(pollMs);
    }, delay);
  }

  function start() {
    if (startPromise) return startPromise;
    if (running) return Promise.resolve();
    running = true;
    const startup = (async () => {
      try {
        await repository.releaseExpiredLeases(readNow());
        if (running) schedule(0);
      } catch (error) {
        running = false;
        throw error;
      }
    })();
    startPromise = startup;
    startup.then(
      () => { if (startPromise === startup) startPromise = null; },
      () => { if (startPromise === startup) startPromise = null; },
    );
    return startup;
  }

  async function stop() {
    running = false;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (startPromise) await startPromise;
    if (activeRun) await activeRun;
  }

  return Object.freeze({ start, runOnce, stop });
}

module.exports = { createInvoiceWorker };
