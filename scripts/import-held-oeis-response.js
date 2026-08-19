'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { EinvoiceError } = require('../src/einvoice/errors');
const { loadMongoConfig } = require('../src/einvoice/config');
const { openMongoConnection } = require('../src/mongo/mongo-connection');
const { parseOeisB2cResponse } = require('../src/einvoice/response-parser');
const { createMongoInvoiceRepository } = require('../src/einvoice/repositories/mongo-invoice-repository');

const CONFIRMATION = 'IMPORT_HELD_RESPONSE_WITHOUT_OEIS_RESUBMISSION';

function invalidInput() {
  throw new EinvoiceError('MANUAL_IMPORT_INPUT_INVALID', 'Manual response import input is invalid');
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) invalidInput();
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== 'string' || typeof value !== 'string' || flag in values) invalidInput();
    values[flag] = value;
  }
  const allowed = [
    '--response', '--company', '--shipment', '--job-id', '--expected-version',
    '--previous-request-hash', '--confirm',
  ];
  if (Object.keys(values).length !== allowed.length
      || Object.keys(values).some(flag => !allowed.includes(flag))
      || !path.isAbsolute(values['--response'] || '')
      || !/^[!-~]{1,512}$/.test(values['--company'] || '')
      || !/^[!-~]{1,512}$/.test(values['--shipment'] || '')
      || !/^[1-9][0-9]*$/.test(values['--job-id'] || '')
      || !/^(?:0|[1-9][0-9]*)$/.test(values['--expected-version'] || '')
      || !/^[a-f0-9]{64}$/.test(values['--previous-request-hash'] || '')
      || values['--confirm'] !== CONFIRMATION) invalidInput();
  const jobId = Number(values['--job-id']);
  const expectedVersion = Number(values['--expected-version']);
  if (!Number.isSafeInteger(jobId) || !Number.isSafeInteger(expectedVersion)) invalidInput();
  return {
    responsePath: values['--response'], companyId: values['--company'],
    shipmentId: values['--shipment'], jobId, expectedVersion,
    previousRequestHash: values['--previous-request-hash'],
  };
}

function correctedRequest(job) {
  let rows;
  try { rows = JSON.parse(job.oeisRequestJson); } catch { invalidInput(); }
  if (!Array.isArray(rows) || rows.length === 0) invalidInput();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)
        || row.TRAN_DOC_NO !== job.documentNumber || typeof row.INV_TOTAL_AMOUNT !== 'string') {
      invalidInput();
    }
    row.INV_CUSTOMER_PAID_AMOUNT = '0.00';
    row.INV_CUSTOMER_AMOUNT_DUE = row.INV_TOTAL_AMOUNT;
  }
  const requestJson = JSON.stringify(rows);
  return { requestJson, requestHash: createHash('sha256').update(requestJson).digest('hex') };
}

async function main(argv = process.argv.slice(2)) {
  const input = parseArguments(argv);
  require('dotenv').config();
  let connection;
  let repository;
  try {
    const raw = (await fs.readFile(input.responsePath, 'utf8')).trim().replace(/\/$/, '');
    const body = JSON.parse(raw);
    connection = await openMongoConnection({ config: loadMongoConfig(process.env) });
    repository = createMongoInvoiceRepository({
      db: connection.db, client: connection.client, now: () => new Date(),
    });
    await repository.initialize();
    const job = await repository.getJob(input.jobId);
    if (job === null || job.companyId !== input.companyId || job.shipmentId !== input.shipmentId
        || job.version !== input.expectedVersion || job.requestHash !== input.previousRequestHash) {
      invalidInput();
    }
    const corrected = correctedRequest(job);
    const parsed = parseOeisB2cResponse(body, {
      sourceDocumentNumber: job.documentNumber, requestJson: corrected.requestJson,
    });
    const result = await repository.importHeldOeisResponseAndEnqueue({
      companyId: input.companyId,
      shipmentId: input.shipmentId,
      jobId: input.jobId,
      expectedVersion: input.expectedVersion,
      previousRequestHash: input.previousRequestHash,
      correctedRequestJson: corrected.requestJson,
      correctedRequestHash: corrected.requestHash,
      artifact: parsed,
      responseEvidence: {
        attemptNumber: job.attemptCount,
        httpStatus: 200,
        responseJson: parsed.responseJson,
        responseByteCount: parsed.responseByteCount,
        responseSha256: parsed.responseSha256,
        oeisInvoiceNumber: parsed.oeisInvoiceNumber,
      },
    });
    process.stdout.write(`${JSON.stringify({
      success: true, jobId: result.job.id, state: result.job.state, outboxId: result.outbox.id,
    })}\n`);
  } catch (error) {
    const code = error instanceof EinvoiceError ? error.code : 'MANUAL_IMPORT_FAILED';
    process.stderr.write(`${JSON.stringify({ success: false, code })}\n`);
    process.exitCode = 1;
  } finally {
    if (repository) await repository.close().catch(() => undefined);
    if (connection) await connection.close().catch(() => undefined);
  }
}

module.exports = { main, parseArguments };

if (require.main === module) main();
