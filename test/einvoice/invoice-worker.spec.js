'use strict';

const { EinvoiceError } = require('../../src/einvoice/errors');
const { createInvoiceWorker } = require('../../src/einvoice/invoice-worker');

const START = new Date('2026-08-10T04:30:00.000Z');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function claimedJob(overrides = {}) {
  return { id: 1, attemptCount: 1, ...overrides };
}

function claimedOutbox(overrides = {}) {
  return { id: 2, attemptCount: 1, ...overrides };
}

function createSetup(overrides = {}) {
  const repository = {
    releaseExpiredLeases: jest.fn(async () => ({ jobs: 0, outbox: 0 })),
    claimNextJob: jest.fn(async () => null),
    claimNextOutbox: jest.fn(async () => null),
    ...overrides.repository,
  };
  const workflow = {
    processJob: jest.fn(async () => undefined),
    processOutbox: jest.fn(async () => undefined),
    ...overrides.workflow,
  };
  const timers = [];
  const cleared = [];
  let timerId = 0;
  const setTimeoutFn = jest.fn((callback, delay) => {
    const timer = { id: ++timerId, callback, delay };
    timers.push(timer);
    return timer.id;
  });
  const clearTimeoutFn = jest.fn(id => cleared.push(id));
  const logger = { error: jest.fn() };
  const deps = {
    repository,
    workflow,
    workerId: 'worker-a',
    pollMs: 1000,
    leaseMs: 30000,
    maxAttempts: 5,
    retryBaseMs: 2000,
    now: () => new Date(START),
    random: () => 0.5,
    setTimeoutFn,
    clearTimeoutFn,
    logger,
    ...overrides.deps,
  };
  return { repository, workflow, timers, cleared, logger, deps };
}

describe('invoice worker runOnce', () => {
  test('releases expired leases, processes at most one job, then one outbox', async () => {
    const trace = [];
    const setup = createSetup({
      repository: {
        releaseExpiredLeases: jest.fn(async () => trace.push('release')),
        claimNextJob: jest.fn(async () => { trace.push('claim-job'); return claimedJob(); }),
        claimNextOutbox: jest.fn(async () => { trace.push('claim-outbox'); return claimedOutbox(); }),
      },
      workflow: {
        processJob: jest.fn(async () => trace.push('job')),
        processOutbox: jest.fn(async () => trace.push('outbox')),
      },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(trace).toEqual(['release', 'claim-job', 'job', 'claim-outbox', 'outbox']);
    expect(setup.repository.claimNextJob).toHaveBeenCalledTimes(1);
    expect(setup.repository.claimNextOutbox).toHaveBeenCalledTimes(1);
  });

  test('computes a fresh future lease timestamp for each claim', async () => {
    const times = [
      '2026-08-10T04:30:00.000Z',
      '2026-08-10T04:30:01.000Z',
      '2026-08-10T04:30:02.000Z',
    ];
    const setup = createSetup({
      repository: {
        claimNextJob: jest.fn(async () => null),
        claimNextOutbox: jest.fn(async () => null),
      },
      deps: { now: jest.fn(() => new Date(times.shift())) },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(setup.repository.releaseExpiredLeases).toHaveBeenCalledWith(
      new Date('2026-08-10T04:30:00.000Z'),
    );
    expect(setup.repository.claimNextJob).toHaveBeenCalledWith(
      'worker-a', '2026-08-10T04:30:31.000Z',
    );
    expect(setup.repository.claimNextOutbox).toHaveBeenCalledWith(
      'worker-a', '2026-08-10T04:30:32.000Z',
    );
  });

  test('continues to the outbox when the job is missing or processing fails', async () => {
    const rawError = new EinvoiceError('REPOSITORY_BUSY', 'shipment-77 private raw error');
    const setup = createSetup({
      repository: {
        claimNextJob: jest.fn(async () => claimedJob()),
        claimNextOutbox: jest.fn(async () => claimedOutbox()),
      },
      workflow: { processJob: jest.fn(async () => { throw rawError; }) },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(setup.workflow.processOutbox).toHaveBeenCalledTimes(1);
    expect(setup.logger.error).toHaveBeenCalledWith(
      'Invoice job processing failed', 'REPOSITORY_BUSY',
    );
    expect(JSON.stringify(setup.logger.error.mock.calls)).not.toContain('shipment-77');

    setup.repository.claimNextJob.mockResolvedValueOnce(null);
    setup.repository.claimNextOutbox.mockResolvedValueOnce(claimedOutbox({ id: 3 }));
    await createInvoiceWorker(setup.deps).runOnce();
    expect(setup.workflow.processOutbox).toHaveBeenCalledTimes(2);
  });

  test.each([
    [1, 0, 1000, false, false],
    [2, 0.5, 3000, false, false],
    [5, 0.5, null, true, false],
    [6, 0.999, null, true, true],
  ])('builds an exact bounded equal-jitter retry-delay plan for attempt %s', async (attempt, random, expectedDelay, exhausted, overLimit) => {
    let captured;
    const setup = createSetup({
      repository: { claimNextJob: jest.fn(async () => claimedJob({ attemptCount: attempt })) },
      workflow: { processJob: jest.fn(async (_record, plan) => { captured = plan; }) },
      deps: { random: jest.fn(() => random), now: () => new Date(START) },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(captured.exhausted).toBe(exhausted);
    expect(captured.overLimit).toBe(overLimit);
    expect(Reflect.ownKeys(captured)).toEqual(['exhausted', 'overLimit', 'retryDelayMs']);
    expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
    expect(setup.deps.random).not.toHaveBeenCalled();
    if (exhausted) {
      expect(setup.deps.random).not.toHaveBeenCalled();
    } else {
      expect(captured.retryDelayMs()).toBe(expectedDelay);
      expect(setup.deps.random).toHaveBeenCalledTimes(1);
    }
  });

  test('samples random exactly once to produce one retry delay', async () => {
    let captured;
    const setup = createSetup({
      repository: { claimNextJob: jest.fn(async () => claimedJob({ attemptCount: 2 })) },
      workflow: { processJob: jest.fn(async (_record, plan) => { captured = plan; }) },
      deps: { random: jest.fn(() => 0.25) },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(captured.retryDelayMs()).toBe(2500);
    expect(setup.deps.random).toHaveBeenCalledTimes(1);
  });

  test('logs repository unavailability using only its fixed safe code', async () => {
    const error = new EinvoiceError('REPOSITORY_UNAVAILABLE', 'private topology detail');
    const setup = createSetup({
      repository: { claimNextJob: jest.fn(async () => { throw error; }) },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(setup.logger.error).toHaveBeenCalledWith(
      'Invoice job processing failed', 'REPOSITORY_UNAVAILABLE',
    );
    expect(JSON.stringify(setup.logger.error.mock.calls)).not.toContain('topology');
  });

  test('does not overlap concurrent manual runs', async () => {
    const gate = deferred();
    const setup = createSetup({
      repository: { claimNextJob: jest.fn(async () => claimedJob()) },
      workflow: { processJob: jest.fn(() => gate.promise) },
    });
    const worker = createInvoiceWorker(setup.deps);

    const first = worker.runOnce();
    const second = worker.runOnce();
    await Promise.resolve();
    await Promise.resolve();

    expect(second).toBe(first);
    expect(setup.repository.releaseExpiredLeases).toHaveBeenCalledTimes(1);
    expect(setup.repository.claimNextJob).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
  });

  test('uses only a fixed fallback code when an unknown error reaches the logger', async () => {
    const setup = createSetup({
      repository: { claimNextJob: jest.fn(async () => { throw new Error('raw identifier shipment-9'); }) },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(setup.logger.error).toHaveBeenCalledWith(
      'Invoice job processing failed', 'INVOICE_WORKER_ERROR',
    );
    expect(JSON.stringify(setup.logger.error.mock.calls)).not.toContain('shipment-9');
  });

  test('does not trust an arbitrary uppercase EinvoiceError code for logging', async () => {
    const setup = createSetup({
      repository: {
        claimNextJob: jest.fn(async () => { throw new EinvoiceError('SECRET_INTERNAL', 'raw'); }),
      },
    });

    await createInvoiceWorker(setup.deps).runOnce();

    expect(setup.logger.error).toHaveBeenCalledWith(
      'Invoice job processing failed', 'INVOICE_WORKER_ERROR',
    );
  });
});

describe('invoice worker scheduling lifecycle', () => {
  test('start releases leases and recursively schedules only after a settled tick', async () => {
    const gate = deferred();
    const setup = createSetup({
      repository: { claimNextJob: jest.fn(async () => claimedJob()) },
      workflow: { processJob: jest.fn(() => gate.promise) },
    });
    const worker = createInvoiceWorker(setup.deps);

    await worker.start();
    expect(setup.repository.releaseExpiredLeases).toHaveBeenCalledTimes(1);
    expect(setup.timers.map(timer => timer.delay)).toEqual([0]);

    const tick = setup.timers[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.timers).toHaveLength(1);
    gate.resolve();
    await tick;
    expect(setup.timers.map(timer => timer.delay)).toEqual([0, 1000]);
  });

  test('coalesces concurrent start calls into one startup and one timer', async () => {
    const gate = deferred();
    const setup = createSetup({
      repository: { releaseExpiredLeases: jest.fn(() => gate.promise) },
    });
    const worker = createInvoiceWorker(setup.deps);

    const first = worker.start();
    const second = worker.start();
    gate.resolve();
    await Promise.all([first, second]);

    expect(setup.repository.releaseExpiredLeases).toHaveBeenCalledTimes(1);
    expect(setup.timers).toHaveLength(1);
  });

  test('stop cancels a pending timer and prevents rescheduling', async () => {
    const setup = createSetup();
    const worker = createInvoiceWorker(setup.deps);
    await worker.start();

    await worker.stop();

    expect(setup.cleared).toEqual([setup.timers[0].id]);
    expect(setup.timers).toHaveLength(1);
  });

  test('stop awaits an active tick and that tick cannot reschedule', async () => {
    const gate = deferred();
    const setup = createSetup({
      repository: { claimNextJob: jest.fn(async () => claimedJob()) },
      workflow: { processJob: jest.fn(() => gate.promise) },
    });
    const worker = createInvoiceWorker(setup.deps);
    await worker.start();
    const tick = setup.timers[0].callback();
    await Promise.resolve();
    await Promise.resolve();

    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await Promise.all([tick, stopping]);

    expect(stopped).toBe(true);
    expect(setup.timers).toHaveLength(1);
  });
});

describe('invoice worker configuration validation', () => {
  test.each([
    {},
    { workerId: '' },
    { pollMs: 0 },
    { leaseMs: 0 },
    { maxAttempts: 0 },
    { retryBaseMs: 0 },
    { random: null },
    { pollMs: 60001 },
    { leaseMs: 3600001 },
    { maxAttempts: 6 },
    { retryBaseMs: 3600001 },
  ])('rejects unsafe configuration %#', overrides => {
    const setup = createSetup({ deps: overrides });
    if (Object.keys(overrides).length === 0) {
      expect(() => createInvoiceWorker()).toThrow(expect.objectContaining({ code: 'WORKER_CONFIG_INVALID' }));
    } else {
      expect(() => createInvoiceWorker(setup.deps)).toThrow(expect.objectContaining({ code: 'WORKER_CONFIG_INVALID' }));
    }
  });

  test('converts a throwing dependency getter to a safe configuration error', () => {
    const setup = createSetup();
    Object.defineProperty(setup.deps, 'workerId', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('raw worker configuration secret'); },
    });

    expect(() => createInvoiceWorker(setup.deps))
      .toThrow(expect.objectContaining({ code: 'WORKER_CONFIG_INVALID' }));
  });
});
