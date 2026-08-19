# Real OEIS response import design

## Goal

Accept the response shape returned by the live OEIS `UpdateInvoiceData` endpoint, retain bounded private response evidence, and allow an operator to attach one already-received response to one exact held job without resubmitting the invoice to OEIS.

## Boundaries

- The source Fynd document number and the OEIS-issued invoice number are distinct identities and are both retained.
- A response is accepted only when its signed UBL invoice, envelope totals, currency, payment method, line values, discounts, tax categories, delivery charge, UUID, and OEIS invoice number reconcile with the exact stored request bytes selected by the operator.
- The live response does not echo the source Fynd document number. Association therefore requires an explicit company, shipment, job, version, old request hash, and corrected request hash precondition.
- The corrected request may differ from the stored held request only in `INV_CUSTOMER_PAID_AMOUNT=0.00` and `INV_CUSTOMER_AMOUNT_DUE=INV_TOTAL_AMOUNT` on every row.
- Import is allowed only for `SUBMISSION_HELD`, with no lease, pending operation, artifact, or outbox. Duplicate UUID, OEIS invoice number, and OEIS transaction number are rejected.
- The import transaction atomically updates the corrected request/hash, stores the artifact and complete bounded response envelope privately, creates the Fynd transition outbox record, advances the job to `FYND_TRANSITION_PENDING`, and appends safe audit evidence.
- The normal UI and public APIs never return the stored response envelope, signed XML, QR code, or recipient data.

## Response evidence retention

- Successful HTTP responses retain the complete canonical JSON envelope, response byte count, SHA-256, HTTP status, attempt number, and received time. The artifact additionally retains signed XML and QR data.
- HTTP failure responses retain the bounded raw response bytes, hash, HTTP status, attempt number, and received time.
- Timeout/network failures retain metadata only because no response exists.
- Evidence expires after the existing 90-day audit retention period and is never logged.

## Recovery flow

1. Parse the operator-supplied response locally and validate it against the corrected stored request.
2. Atomically import it into Mongo under exact job/version/hash/state guards.
3. Claim the resulting outbox with the existing repository and run the existing Fynd transition workflow.
4. Verify the job and outbox complete and the artifact remains bound to both source and OEIS identities.
